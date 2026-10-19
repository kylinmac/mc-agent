import { randomUUID } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
import type { IPty } from "node-pty";

/**
 * mc-agent work-panel terminal (MC-ADR-0005), restored from upstream's
 * removed D099 manager and keyed by work-panel tab instead of workspace path,
 * so a project can have several shells.
 *
 * Each tab owns one login shell in Electron Main. A shell survives tab
 * switches and panel close; a bounded replay buffer restores its scrollback
 * when the renderer reattaches. Closing the tab, or quitting the app, kills
 * it. This shell is the user's own and is separate from the agent's bounded,
 * permission-aware Bash tool.
 */

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The user's login shell: $SHELL, else zsh, else bash, else sh. */
export function resolveShell(env: NodeJS.ProcessEnv = process.env): { shell: string; args: string[] } {
  const override = env.PI_DESKTOP_BASH;
  if (override && isExecutable(override)) return { shell: override, args: ["-l"] };
  if (process.platform === "win32") return { shell: env.COMSPEC || "cmd.exe", args: [] };
  const candidates = [env.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"].filter(
    (candidate): candidate is string => Boolean(candidate),
  );
  return { shell: candidates.find(isExecutable) ?? "/bin/sh", args: ["-l"] };
}

const REPLAY_LIMIT_CHARS = 128 * 1024;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MAX_TERMINALS = 16;

type PtySession = {
  termId: string;
  tabId: string;
  cwd: string;
  pty: IPty;
  replay: string;
};

export type TerminalEvents = {
  onData: (termId: string, data: string) => void;
  onExit: (termId: string, exitCode: number | null) => void;
};

type SpawnPty = (shell: string, args: string[], options: {
  name: string;
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
}) => IPty;

export class TerminalManager {
  private readonly sessions = new Map<string, PtySession>();
  private readonly byTab = new Map<string, string>();
  private readonly events: TerminalEvents;
  private readonly loadSpawn: () => Promise<SpawnPty>;

  constructor(
    events: TerminalEvents,
    // Injected for tests; the real module is a native addon loaded lazily so
    // a missing or incompatible binary cannot break app start.
    loadSpawn: () => Promise<SpawnPty> = async () => (await import("node-pty")).spawn,
  ) {
    this.events = events;
    this.loadSpawn = loadSpawn;
  }

  /** Start the tab's shell in `cwd`, or reattach to the one already running. */
  async create(input: { tabId: string; cwd: string; cols?: number; rows?: number }): Promise<{
    termId: string;
    replay: string;
  }> {
    const existingId = this.byTab.get(input.tabId);
    const existing = existingId ? this.sessions.get(existingId) : undefined;
    if (existing) return { termId: existing.termId, replay: existing.replay };
    if (this.sessions.size >= MAX_TERMINALS) throw new Error("too many open terminals");

    const spawn = await this.loadSpawn();
    const { shell, args } = resolveShell();
    const termId = randomUUID();
    const pty = spawn(shell, args, {
      name: "xterm-256color",
      cwd: input.cwd,
      cols: clamp(input.cols ?? DEFAULT_COLS, 2, 500),
      rows: clamp(input.rows ?? DEFAULT_ROWS, 2, 300),
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" } as Record<string, string>,
    });
    const session: PtySession = { termId, tabId: input.tabId, cwd: input.cwd, pty, replay: "" };
    this.sessions.set(termId, session);
    this.byTab.set(input.tabId, termId);

    pty.onData((data) => {
      session.replay = (session.replay + data).slice(-REPLAY_LIMIT_CHARS);
      this.events.onData(termId, data);
    });
    pty.onExit(({ exitCode }) => {
      this.forget(session);
      this.events.onExit(termId, exitCode ?? null);
    });
    return { termId, replay: "" };
  }

  write(termId: string, data: string): void {
    this.sessions.get(termId)?.pty.write(data);
  }

  resize(termId: string, cols: number, rows: number): void {
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
    try {
      this.sessions.get(termId)?.pty.resize(clamp(cols, 2, 500), clamp(rows, 2, 300));
    } catch {
      // Resizing a shell that just exited throws; nothing to do.
    }
  }

  /** Kill the shell of a closed tab. */
  disposeTab(tabId: string): void {
    const termId = this.byTab.get(tabId);
    const session = termId ? this.sessions.get(termId) : undefined;
    if (!session) return;
    this.forget(session);
    try {
      session.pty.kill();
    } catch {
      // Already gone.
    }
  }

  disposeAll(): void {
    for (const session of [...this.sessions.values()]) this.disposeTab(session.tabId);
  }

  get size(): number {
    return this.sessions.size;
  }

  private forget(session: PtySession): void {
    this.sessions.delete(session.termId);
    if (this.byTab.get(session.tabId) === session.termId) this.byTab.delete(session.tabId);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}
