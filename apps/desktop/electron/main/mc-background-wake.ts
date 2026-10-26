/*
  mc-agent: tell the agent when a background command it started ends on its
  own (MC-ADR-0018). Without this the agent only learns of it by polling
  BashOutput, or not at all once its turn is over.

  host-core reports every registry change; this re-lists the tasks, picks the
  ones that went from running to exited or failed, and delivers one notice per
  session: into the running turn as steering when there is one (queued after
  it when it can no longer take any), otherwise as a new turn. A command the user or the agent stopped is not reported. The
  notice says it is automatic, so the model never reads it as the user asking
  for something.
*/

export type WakeTask = {
  id: string;
  sessionId: string;
  command: string;
  state: "running" | "exited" | "failed" | "stopped";
  exitCode?: number | null;
};

type TaskOutput = { stdout?: string; stderr?: string };

export type BackgroundWakeDeps = {
  listTasks: () => Promise<WakeTask[]>;
  output: (id: string) => Promise<TaskOutput>;
  /** The session's running turn, if any. */
  activeTurn: (sessionId: string) => string | undefined;
  steer: (sessionId: string, turnId: string, content: string) => Promise<{ accepted: boolean }>;
  prompt: (sessionId: string, content: string) => Promise<unknown>;
  /** The session's turn queue, for a session that is busy but cannot take steering. */
  queue: (sessionId: string, content: string) => Promise<unknown>;
  log: (message: string, error?: unknown) => void;
  now?: () => number;
  /** Lets the tests flush without waiting. */
  delayMs?: number;
};

/** Output carried in a notice, from the end. */
const TAIL_CHARS = 2_000;
const COMMAND_CHARS = 200;
/** Ends that land close together go out as one notice. */
const BATCH_DELAY_MS = 1_500;
/** A command that keeps failing at once must not keep starting turns. */
const MAX_WAKES_PER_WINDOW = 5;
const WAKE_WINDOW_MS = 10 * 60_000;

function clip(text: string, max: number, fromEnd = false): string {
  if (text.length <= max) return text;
  return fromEnd ? `…${text.slice(-max)}` : `${text.slice(0, max)}…`;
}

function combined(output: TaskOutput): string {
  const stdout = output.stdout ?? "";
  const stderr = output.stderr ?? "";
  return stderr ? `${stdout}${stdout && !stdout.endsWith("\n") ? "\n" : ""}${stderr}` : stdout;
}

/** The text the model reads, also shown in the transcript. */
export function backgroundNotice(ended: Array<{ task: WakeTask; tail: string }>): string {
  const blocks = ended.map(({ task, tail }) => {
    const outcome = task.state === "failed"
      ? `failed${typeof task.exitCode === "number" ? ` (exit code ${task.exitCode})` : ""}`
      : `exited with code ${typeof task.exitCode === "number" ? task.exitCode : "unknown"}`;
    const body = tail.trim() ? `\nLast output:\n\`\`\`\n${clip(tail.trimEnd(), TAIL_CHARS, true)}\n\`\`\`` : "\nNo output.";
    return `- \`${clip(task.command, COMMAND_CHARS)}\` ${outcome} (backgroundId ${task.id}).${body}`;
  });
  return [
    "[Automatic notice, not a message from the user] Background command(s) you started have ended:",
    ...blocks,
    "Read the full output with BashOutput if you need it, then carry on with the task. If nothing is left to do, reply briefly.",
  ].join("\n");
}

export function createBackgroundWake(deps: BackgroundWakeDeps) {
  const now = deps.now ?? Date.now;
  const known = new Map<string, WakeTask["state"]>();
  const pending = new Map<string, WakeTask[]>();
  const wakes = new Map<string, number[]>();
  let primed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let scanning: Promise<void> | undefined;
  let rescan = false;

  const allowed = (sessionId: string): boolean => {
    const recent = (wakes.get(sessionId) ?? []).filter((at) => now() - at < WAKE_WINDOW_MS);
    if (recent.length >= MAX_WAKES_PER_WINDOW) {
      wakes.set(sessionId, recent);
      return false;
    }
    wakes.set(sessionId, [...recent, now()]);
    return true;
  };

  const deliver = async (sessionId: string, tasks: WakeTask[]) => {
    if (!allowed(sessionId)) {
      deps.log(`background wake skipped for ${sessionId}: too many in a short time`);
      return;
    }
    const ended = await Promise.all(tasks.map(async (task) => ({
      task,
      tail: combined(await deps.output(task.id).catch(() => ({}))),
    })));
    const content = backgroundNotice(ended);
    const turnId = deps.activeTurn(sessionId);
    if (turnId) {
      const steered = await deps.steer(sessionId, turnId, content).catch(() => ({ accepted: false }));
      if (steered.accepted) return;
      await deps.queue(sessionId, content);
      return;
    }
    // A turn can start between the check and the prompt; then it waits its turn.
    await deps.prompt(sessionId, content).catch(() => deps.queue(sessionId, content));
  };

  const flush = async () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const batches = [...pending.entries()];
    pending.clear();
    for (const [sessionId, tasks] of batches) {
      await deliver(sessionId, tasks).catch((error) => deps.log("background wake delivery failed", error));
    }
  };

  const scan = async () => {
    const tasks = await deps.listTasks();
    const ids = new Set<string>();
    for (const task of tasks) {
      ids.add(task.id);
      const before = known.get(task.id);
      known.set(task.id, task.state);
      // The first listing only learns what exists: anything already over
      // ended before this process could have told anyone.
      if (!primed) continue;
      const endedOnItsOwn = task.state === "exited" || task.state === "failed";
      if (endedOnItsOwn && before !== task.state && (before === "running" || before === undefined)) {
        pending.set(task.sessionId, [...(pending.get(task.sessionId) ?? []), task]);
      }
    }
    for (const id of known.keys()) if (!ids.has(id)) known.delete(id);
    primed = true;
    if (pending.size && !timer) {
      timer = setTimeout(() => void flush(), deps.delayMs ?? BATCH_DELAY_MS);
      timer.unref?.();
    }
  };

  /** Call on every `backgroundTasks.changed`; overlapping calls fold into one rescan. */
  const changed = (): Promise<void> => {
    if (scanning) {
      rescan = true;
      return scanning;
    }
    scanning = (async () => {
      do {
        rescan = false;
        await scan().catch((error) => deps.log("background wake scan failed", error));
      } while (rescan);
    })().finally(() => {
      scanning = undefined;
    });
    return scanning;
  };

  return {
    changed,
    /** For tests: deliver what is waiting now. */
    flush,
    dispose() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      pending.clear();
    },
  };
}

const changeListeners = new Set<() => void>();

/** host-core's `backgroundTasks.changed`, for the wake (called from runtime/host.ts). */
export function emitBackgroundTasksChanged(): void {
  for (const listener of changeListeners) listener();
}

export function onBackgroundTasksChanged(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}
