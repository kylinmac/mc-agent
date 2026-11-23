import { Type } from "@earendil-works/pi-ai";
import { DEFAULT_COMMAND_TIMEOUT_MS } from "@pi-desktop/shared";
import type { CommandShellOption } from "@pi-desktop/shared";
import { isRecord } from "./agent-messages.js";


export const MIN_COMMAND_TIMEOUT_SECONDS = 1;
/** Host safety bound so every spawn still has a finite deadline (D329). */
export const MAX_COMMAND_TIMEOUT_SECONDS = 21_600;
/**
 * Schema ceiling for `Bash.timeout`, not an honoured duration. It has to admit
 * millisecond values models send, then the runtime reads those as seconds and
 * clamps to {@link MAX_COMMAND_TIMEOUT_SECONDS} (D273 / D329).
 */
export const MAX_ACCEPTED_COMMAND_TIMEOUT = 100_000_000;
/**
 * Argument names models reach for instead of ours, mapped to the canonical
 * name. Every strong model has `file_path`/`query` burned in from pretraining
 * and sends them regardless of what the schema says, so the schema accepts both
 * spellings and {@link normalizeToolParams} folds the alias away before the
 * host sees the call (D273). Weaker models — issue #454 pinned longcat 2.0 —
 * reach for `filepath` / `filename` / `filePath` / `file` instead; folding
 * those the same way rescues the turn before the model gives up on the tool
 * and silently falls back to Bash.
 */
const PATH_ARG_ALIASES = {
  file_path: "path",
  filepath: "path",
  filePath: "path",
  filename: "path",
  fileName: "path",
  file: "path",
} as const;
const TOOL_PARAM_ALIASES: Record<string, Record<string, string>> = {
  Read: { ...PATH_ARG_ALIASES },
  Write: { ...PATH_ARG_ALIASES },
  Edit: { ...PATH_ARG_ALIASES },
  BrowserPreview: { ...PATH_ARG_ALIASES },
  Glob: { query: "pattern" },
  Grep: { query: "pattern" },
  // mc-agent background commands (MC-ADR-0006). Bash's optional
  // `run_in_background` spelling is read by host-core, since aliases here are
  // required parameters.
  BashOutput: { bash_id: "backgroundId", shell_id: "backgroundId" },
  KillBash: { bash_id: "backgroundId", shell_id: "backgroundId" },
};

export function shellScratchVariable(shell: CommandShellOption): string {
  switch (shell.dialect) {
    case "powershell":
      return "$env:PI_SCRATCH_DIR";
    case "cmd":
      return "%PI_SCRATCH_DIR%";
    case "posix":
      return "$PI_SCRATCH_DIR";
  }
}

function shellSyntaxGuidance(shell: CommandShellOption): string {
  switch (shell.dialect) {
    case "powershell":
      return "Use native Windows PowerShell syntax and Windows paths such as `C:\\work\\file.txt` or `.\\file.txt`.";
    case "cmd":
      return "Use native cmd.exe syntax and Windows paths such as `C:\\work\\file.txt` or `.\\file.txt`.";
    case "posix":
      return "Use native POSIX shell syntax and forward-slash paths such as `/work/file.txt` or `./file.txt`.";
  }
}

export function formatScratchDirForShell(
  shell: CommandShellOption,
  scratchDir?: string,
): string | undefined {
  if (!scratchDir) return undefined;
  if (shell.dialect === "posix") {
    // POSIX shells (including Git Bash on Windows) require forward slashes.
    return scratchDir.replaceAll("\\", "/");
  }
  return scratchDir;
}

export function commandShellGuidance(
  shell: CommandShellOption,
  scratchDir?: string,
): string {
  const scratchVariable = shellScratchVariable(shell);
  const formattedScratch = formatScratchDirForShell(shell, scratchDir);
  const scratch = formattedScratch
    ? `The session scratch directory is \`${formattedScratch}\`; use ${scratchVariable} for it and keep temporary files there.`
    : `When PI_SCRATCH_DIR is available, use ${scratchVariable} for the session scratch directory and keep temporary files there.`;
  return [
    `Shell commands run through ${shell.label} (${shell.id}). The protocol tool remains named Bash for compatibility, even when the active shell is PowerShell or cmd.`,
    shellSyntaxGuidance(shell),
    scratch,
  ].join(" ");
}

export function commandShellToolDescription(
  shell: CommandShellOption,
  scratchDir?: string,
): string {
  const formattedScratch = formatScratchDirForShell(shell, scratchDir);
  return [
    `Run a non-interactive command through ${shell.label} in the workspace root.`,
    "The protocol tool remains named Bash for compatibility; write commands for the active shell dialect.",
    shellSyntaxGuidance(shell),
    `The session scratch directory variable is ${shellScratchVariable(shell)}.`,
    `An optional timeout from 1 to ${MAX_COMMAND_TIMEOUT_SECONDS} seconds may be supplied; without it, the command defaults to a 60-second timeout.`,
    `Set runInBackground: true for long-lived processes the user needs after the turn ends (dev servers, watchers, builds). A background call returns a backgroundTaskId immediately, survives turn aborts and timeouts, and its output is visible in the composer's running-tasks bar; do not set it for commands whose output the current turn depends on. When a background command exits on its own you get an automatic notice with its exit code and last output, even after your turn has ended, so never sleep or poll in a loop waiting for one to finish.`,
    ...(formattedScratch ? [`The session scratch directory is ${formattedScratch}.`] : []),
  ].join(" ");
}

/**
 * A canonical argument that an alias can stand in for. It has to be optional in
 * the schema — the alias satisfies it — so {@link requireAliasedParams} enforces
 * "exactly one spelling" after {@link normalizeToolParams} has run.
 */
export function pathParam(description: string) {
  return Type.Optional(Type.String({ description }));
}

/** The alias spelling of `canonical`, accepted but never advertised as first choice. */
export function aliasParam(canonical: string) {
  return Type.Optional(
    Type.String({ description: `Alias for \`${canonical}\`.` }),
  );
}

/**
 * Fails a call that named neither the canonical argument nor its alias. Without
 * this the now-optional canonical argument would reach the host as `undefined`
 * and surface as a confusing host-side error instead of a schema one.
 */
export function requireAliasedParams(toolName: string, params: unknown): void {
  const aliases = TOOL_PARAM_ALIASES[toolName];
  if (!aliases || !isRecord(params)) return;
  for (const canonical of new Set(Object.values(aliases))) {
    if (params[canonical] !== undefined) continue;
    // A weaker model that keeps hitting this error gives up on the tool and
    // silently switches to Bash (issue #454). Naming the accepted spellings and
    // showing a minimal example lets the next call self-correct instead of the
    // whole turn falling back to shell.
    const acceptedAliases = Object.keys(aliases).filter(
      (alias) => aliases[alias] === canonical,
    );
    const aliasHint =
      acceptedAliases.length > 0
        ? ` (the alias${acceptedAliases.length > 1 ? "es" : ""} ${acceptedAliases
            .map((name) => `\`${name}\``)
            .join(", ")} ${acceptedAliases.length > 1 ? "are" : "is"} also accepted)`
        : "";
    throw Object.assign(
      new Error(
        `Invalid arguments for ${toolName}: \`${canonical}\` is required${aliasHint}. Example: {"${canonical}": "..."}.`,
      ),
      { errorCode: "INVALID_ARGUMENT" },
    );
  }
}

/**
 * Folds aliased argument names onto the canonical ones and reads a Bash
 * `timeout` that arrived in milliseconds as seconds (D273). Both rewrites are
 * silent: the call succeeds as the model intended rather than costing a turn on
 * a validation error the model cannot see. Returns `params` unchanged when
 * there is nothing to rewrite so the common path allocates nothing.
 */
export function normalizeToolParams(toolName: string, params: unknown): unknown {
  if (!isRecord(params)) return params;
  const aliases = TOOL_PARAM_ALIASES[toolName];
  // A value above the honoured seconds ceiling is the millisecond habit (D273 /
  // D329). In-range values, including 600 and 1800, are seconds the agent chose.
  const timeoutIsMs =
    toolName === "Bash" &&
    typeof params.timeout === "number" &&
    Number.isFinite(params.timeout) &&
    params.timeout > MAX_COMMAND_TIMEOUT_SECONDS;
  const aliased = aliases
    ? Object.keys(aliases).filter((alias) => params[alias] !== undefined)
    : [];
  if (aliased.length === 0 && !timeoutIsMs) return params;
  const next = { ...params };
  for (const alias of aliased) {
    const canonical = aliases![alias];
    // The canonical spelling wins if a call carries both; either way the alias
    // is dropped so the host and the transcript never see it.
    if (next[canonical] === undefined) next[canonical] = next[alias];
    delete next[alias];
  }
  if (timeoutIsMs) {
    // Above the honoured seconds ceiling is milliseconds (D273 / D329).
    next.timeout = Math.min(
      MAX_COMMAND_TIMEOUT_SECONDS,
      Math.max(
        MIN_COMMAND_TIMEOUT_SECONDS,
        Math.round((params.timeout as number) / 1000),
      ),
    );
  }
  return next;
}

export function commandTimeoutMs(params: unknown): number {
  const timeout = isRecord(params) ? params.timeout : undefined;
  if (timeout === undefined) return DEFAULT_COMMAND_TIMEOUT_MS;
  if (
    typeof timeout !== "number" ||
    !Number.isFinite(timeout) ||
    timeout < MIN_COMMAND_TIMEOUT_SECONDS
  ) {
    throw Object.assign(
      new Error(
        `Invalid timeout: must be a finite number of seconds between ${MIN_COMMAND_TIMEOUT_SECONDS} and ${MAX_COMMAND_TIMEOUT_SECONDS}`,
      ),
      { errorCode: "INVALID_ARGUMENT" },
    );
  }
  if (timeout > MAX_COMMAND_TIMEOUT_SECONDS) {
    throw Object.assign(
      new Error(
        `Invalid timeout: maximum is ${MAX_COMMAND_TIMEOUT_SECONDS} seconds`,
      ),
      { errorCode: "INVALID_ARGUMENT" },
    );
  }
  const timeoutMs = Math.ceil(timeout * 1000);
  return timeoutMs;
}
