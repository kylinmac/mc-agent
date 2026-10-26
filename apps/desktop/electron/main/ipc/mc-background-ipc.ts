import { ErrorCodes, IPC, type BackgroundShell } from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";
import type { IpcRegistrar } from "./types";

/**
 * mc-agent background commands (MC-ADR-0006): the desktop panel lists, views
 * and stops a session's background commands. host-core owns the processes in
 * its background-task registry (`backgroundTasks.*`, shared with the
 * composer's task dock); this maps that registry onto the panel's shape and
 * keeps every call inside the session that asked.
 */
export type McBackgroundIpcDependencies = {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
};

type TaskSummary = {
  id: string;
  sessionId: string;
  command: string;
  state: "running" | "exited" | "failed" | "stopped";
  elapsedMs: number;
  exitCode?: number;
};

type TaskOutput = { stdout?: string; stderr?: string; truncated?: boolean };

const MAX_ID_LENGTH = 256;
/** Output the list carries per finished command. */
const LIST_TAIL_BYTES = 4 * 1024;

function text(value: unknown, label: string): string {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result || result.length > MAX_ID_LENGTH) {
    throw Object.assign(new Error(`${label} required`), { errorCode: ErrorCodes.INVALID_ARGUMENT });
  }
  return result;
}

function combined(output: TaskOutput): string {
  const stdout = output.stdout ?? "";
  const stderr = output.stderr ?? "";
  return stderr ? `${stdout}${stdout && !stdout.endsWith("\n") ? "\n" : ""}${stderr}` : stdout;
}

export function registerMcBackgroundIpc({ registrar, getHost }: McBackgroundIpcDependencies): void {
  const host = () => {
    const current = getHost();
    if (!current) throw new Error("host unavailable");
    return current;
  };
  // The registry reports elapsed time only, so the end of a finished command
  // is fixed the first time it is seen finished, with its output tail.
  const finished = new Map<string, { endedAt: number; tail: string }>();

  const sessionTasks = async (sessionId: string): Promise<TaskSummary[]> => {
    const { tasks } = (await host().call("backgroundTasks.list", {})) as { tasks?: TaskSummary[] };
    return (tasks ?? []).filter((task) => task.sessionId === sessionId);
  };
  const ownTask = async (sessionId: string, id: string): Promise<TaskSummary> => {
    const task = (await sessionTasks(sessionId)).find((item) => item.id === id);
    if (!task) {
      throw Object.assign(new Error("no background command with that id in this session"), {
        errorCode: ErrorCodes.NOT_FOUND,
      });
    }
    return task;
  };
  const shellOf = (task: TaskSummary, now: number): BackgroundShell => {
    const end = finished.get(task.id);
    return {
      id: task.id,
      command: task.command,
      cwd: "",
      status: task.state === "stopped" ? "killed" : task.state,
      ...(task.exitCode !== undefined && task.exitCode !== null ? { exitCode: task.exitCode } : {}),
      error: null,
      // `elapsedMs` counts from the start even after the command ended.
      startedAt: now - task.elapsedMs,
      endedAt: end?.endedAt ?? null,
      ...(end ? { tail: end.tail } : {}),
    };
  };

  registrar.handle(IPC.invoke.backgroundShellsList, async (input: { sessionId?: unknown } = {}) => {
    const sessionId = text(input?.sessionId, "sessionId");
    const tasks = await sessionTasks(sessionId);
    const now = Date.now();
    for (const task of tasks) {
      if (task.state === "running" || finished.has(task.id)) continue;
      const output = (await host().call("backgroundTasks.output", { id: task.id }).catch(() => ({}))) as TaskOutput;
      finished.set(task.id, { endedAt: now, tail: combined(output).slice(-LIST_TAIL_BYTES) });
    }
    return { shells: tasks.map((task) => shellOf(task, now)) };
  });
  registrar.handle(IPC.invoke.backgroundShellsView, async (input: { sessionId?: unknown; id?: unknown } = {}) => {
    const task = await ownTask(text(input?.sessionId, "sessionId"), text(input?.id, "id"));
    const output = (await host().call("backgroundTasks.output", { id: task.id })) as TaskOutput;
    return { ...shellOf(task, Date.now()), output: combined(output), truncated: output.truncated === true };
  });
  registrar.handle(IPC.invoke.backgroundShellsKill, async (input: { sessionId?: unknown; id?: unknown } = {}) => {
    const task = await ownTask(text(input?.sessionId, "sessionId"), text(input?.id, "id"));
    await host().call("backgroundTasks.stop", { id: task.id });
    return shellOf(task, Date.now());
  });
}
