import {
  imageGenerationDescription,
  imageGenerationParameters,
  saveCreativeAssetDescription,
  saveCreativeAssetParameters,
} from "./image-generation/tool.js";
import { REMEMBER_TOOL_NAME, rememberDescription, rememberParameters } from "./mc-memory-tool.js";
import { panelToolDescriptions, panelToolParameters } from "./mc-work-panel-tools.js";
import { canvasToolDescriptions, canvasToolParameters } from "./mc-canvas-tools.js";
import {
  CREATE_PROJECT_TOOL_NAME,
  PROJECT_TEMPLATES_TOOL_NAME,
  createProjectDescription,
  createProjectParameters,
  projectTemplatesDescription,
  projectTemplatesParameters,
} from "./mc-project-tools.js";
import {
  PROPOSE_ALCHEMY_TOOL_NAME,
  RESOLVE_REF_TOOL_NAME,
  proposeAlchemyDescription,
  proposeAlchemyParameters,
  resolveRefDescription,
  resolveRefParameters,
} from "./mc-alchemy-tools.js";
import { todoWriteDescription, todoWriteParameters } from "./todo-tool.js";
import { scheduledToolDescriptions } from "./scheduled-tools.js";
import { Type } from "@earendil-works/pi-ai";
import type { CommandShellOption, Mode } from "@pi-desktop/shared";
import { MAX_ASK_TOOL_QUESTION_CHARS } from "@pi-desktop/shared";
import {
  MIN_COMMAND_TIMEOUT_SECONDS,
  MAX_COMMAND_TIMEOUT_SECONDS,
  MAX_ACCEPTED_COMMAND_TIMEOUT,
  commandShellToolDescription,
  pathParam,
  aliasParam,
} from "./command-shell-policy.js";

export const ASK_TOOL_NAME = "asktool";

export function builtinToolSchemas(mode: Mode, commandShell: CommandShellOption, scratchDir?: string) {
  // With a scratch dir provisioned, file tools accept absolute paths into
  // it as a second root (D114); keep the wording in sync with host-core.
  const scratchPathHint = scratchDir
    ? " `path` is workspace-relative, or an absolute path inside the session scratch directory."
    : "";
  const externalPathHint =
    " An explicit path outside the workspace and session scratch roots requires permission unless the effective mode is Auto.";
  const describe = (toolName: string): string => {
    if (toolName === "GenerateImages") return imageGenerationDescription;
    // mc-agent creative studio (docs/mc-agent/creative-studio.md).
    if (toolName === "SaveCreativeAsset") return saveCreativeAssetDescription;
    // mc-agent project memory notes (MC-ADR-0019).
    if (toolName === REMEMBER_TOOL_NAME) return rememberDescription;
    // mc-agent prototype canvas (docs/mc-agent/prototype-canvas.md).
    if (toolName in panelToolDescriptions) return panelToolDescriptions[toolName];
    if (toolName in canvasToolDescriptions) return canvasToolDescriptions[toolName as keyof typeof canvasToolDescriptions];
    // mc-agent project creation from the conversation (MC-ADR-0023).
    if (toolName === PROJECT_TEMPLATES_TOOL_NAME) return projectTemplatesDescription;
    if (toolName === CREATE_PROJECT_TOOL_NAME) return createProjectDescription;
    // mc-agent alchemy references and artifact proposals (R41).
    if (toolName === RESOLVE_REF_TOOL_NAME) return resolveRefDescription;
    if (toolName === PROPOSE_ALCHEMY_TOOL_NAME) return proposeAlchemyDescription;
    if (scheduledToolDescriptions[toolName]) return scheduledToolDescriptions[toolName];
    switch (toolName) {
      case "BrowserPreview":
        return "Open an HTML file in PI-Desktop's built-in browser panel. `path` may be relative to a project folder or this session's scratch directory, or an absolute path inside those roots. No project is required for scratch previews. The preview live-reloads on later edits to the file or its sibling assets, so call once per page.";
      case "Read":
        return (
          "Read a bounded window from an existing regular text file, never a directory. " +
          "The result always includes `totalLines` so you know the file\'s scale upfront. " +
          "`content` is line-numbered (`N:`) under a `[path#TAG]` header; `tag` is the whole-file 4-hex Edit anchor. " +
          "`truncated` is true only when this window was cut short, not merely because the file continues. " +
          "For files beyond the default window, use Grep to locate the target content first, then Read " +
          "the relevant range with `offset` and `limit`. Activate and use Glob " +
          "when a directory must be listed or the file name is uncertain." +
          `${scratchPathHint}${externalPathHint}`
        );
      case "Glob":
        return (
          "List files by glob pattern, newest first. Use `path` to scope the " +
          "directory and `limit` to bound results; patterns use `/` as a " +
          "portable separator." +
          `${scratchPathHint}${externalPathHint}`
        );
      case "Grep":
        return (
          "Search file contents with a Rust-compatible regex. `path` may name one file " +
          "or a directory tree. Use `path` and " +
          "`include` to narrow the scan, `headLimit` to bound results, and " +
          'outputMode: "filesWithMatches" or "count" when content is unnecessary; ' +
          "`path` accepts portable relative paths." +
          `${scratchPathHint}${externalPathHint}`
        );
      case "Write":
        return `Create or overwrite a file. Deliverables go into the workspace; temporary/intermediate files go into the scratch directory.${scratchPathHint}${externalPathHint}`;
      case "Edit":
        return `Replace, insert, or delete lines in an existing file. Names positions and supplies new content only — never old_string. Required: path, tag (4 hex from the latest Read/Grep/Write/Edit), ops. Ops: PUT N.=M: replace inclusive lines N–M; PUT <N: insert before N; PUT >N: insert after N; PUT >$: append; CUT N.=M delete; REM delete the file; MV DEST rename after other ops. Body rows are + plus the final line text. Every PUT with body rows must include the trailing colon, for example PUT 48.=48:; PUT 48.=48 followed by + rows is invalid. A colonless PUT is only for a register paste such as PUT <1 @name. No -old or context rows. Ranges name only the lines being changed. Re-ground on the tag returned by every successful write. After one failed Edit, classify the error: Read the live file for a stale tag or unseen lines (or retry unchanged on a complete EDIT_LINES_UNSEEN reveal), but correct syntax or range errors directly; do not guess. Do not edit the same path concurrently.${scratchPathHint}${externalPathHint}`;
      case "Bash":
        return `${commandShellToolDescription(commandShell, scratchDir)} Use Edit or Write instead of apply_patch, git apply, or patch; do not retry a failed shell patch command repeatedly.${mode === "agent" ? " Read a background command's new output with BashOutput and stop it with KillBash once it is no longer needed; both take the backgroundTaskId the call returned as backgroundId." : ""}`;
      case "BashOutput":
        return "Read the new output of a background command started with Bash runInBackground, since your last read, plus its status (running, exited, failed with exitCode, stopped). stdout is in output and stderr in stderr; when much was printed only the latest part is returned. You are notified automatically when a background command exits, so use this to check progress or read the full output, not to wait for the end.";
      case "KillBash":
        return "Stop a background command started with Bash runInBackground, including the processes it started. Stop servers and watchers you started once the task no longer needs them.";
      case "TodoWrite":
        return todoWriteDescription;
      case ASK_TOOL_NAME:
        return `Ask the user one or more questions. Keep each question to ${MAX_ASK_TOOL_QUESTION_CHARS} characters or fewer. Use Markdown in question text and option labels when formatting helps (for example, emphasis, inline code, or lists); the desktop card renders it safely. Plain strings and existing { label, description? } options are accepted; descriptions remain plain text and answers return the selected source label. The card always provides a custom user-input option. For a reversible, nonessential preference, set importance="optional" and recommendedOption to the exact label you recommend. If the user enabled automatic continuation, the runtime may use that recommendation after its deadline; this is an assumption, never a user answer or authorization. Keep important decisions, missing essential facts, destructive actions, access grants, and external commitments required (the default). Never use asktool to bypass tool permissions or plan/goal approval. A later user answer may revise the assumption; reconcile it with work already done.`;
      case "PluginScaffold":
        return "Create a PI-Desktop plugin from a template and load it for development. `directory` is workspace-relative and must be empty or new; `template` is one of panel-basic, agent-tool-basic, skill-pack, full-demo. Use this instead of hand-writing plugin files.";
      case "PluginCheck":
        return "Validate a PI-Desktop plugin directory against every rule the installer enforces (manifest, entry file, panel, skills, permissions, package limits). `directory` is workspace-relative. Run this before packaging.";
      case "PluginPack":
        return "Package a PI-Desktop plugin directory into an installable dist/<id>-<version>.piplug. `directory` is workspace-relative. Runs the same validation as PluginCheck first and refuses to package a plugin with errors. Never build a .piplug with shell tools — the installer only accepts uncompressed archives.";
      default:
        return `${toolName} tool via PI-Desktop host-core`;
    }
  };
  // One entry per tool: the shapes diverge enough that a chain of ternaries
  // stopped being readable.
  const parameters: Record<string, Parameters<typeof Type.Object>[0]> = {
    GenerateImages: imageGenerationParameters,
    SaveCreativeAsset: saveCreativeAssetParameters,
    [REMEMBER_TOOL_NAME]: rememberParameters,
    ...canvasToolParameters,
    ...panelToolParameters,
    [PROJECT_TEMPLATES_TOOL_NAME]: projectTemplatesParameters,
    [CREATE_PROJECT_TOOL_NAME]: createProjectParameters,
    [RESOLVE_REF_TOOL_NAME]: resolveRefParameters,
    [PROPOSE_ALCHEMY_TOOL_NAME]: proposeAlchemyParameters,
    TodoWrite: todoWriteParameters,
    Read: {
      path: pathParam(
        "Existing regular file only, never a directory; workspace-relative or explicitly approved.",
      ),
      file_path: aliasParam("path"),
      offset: Type.Optional(
        Type.Number({ minimum: 0, description: "0-based line offset; defaults to 0." }),
      ),
      limit: Type.Optional(
        Type.Number({ minimum: 1, description: "Maximum lines to return; defaults to 2000." }),
      ),
    },
    BrowserPreview: {
      path: pathParam("File to preview inside the session's project folders or scratch directory."),
      file_path: aliasParam("path"),
    },
    Glob: {
      pattern: pathParam("Glob pattern, for example **/*.ts."),
      query: aliasParam("pattern"),
      path: Type.Optional(
        Type.String({
          description:
            "Directory to search; defaults to the workspace root and accepts an absolute scratch path.",
        }),
      ),
      limit: Type.Optional(
        Type.Number({ minimum: 1, description: "Maximum entries; defaults to 100." }),
      ),
    },
    Grep: {
      pattern: pathParam("Rust-compatible regex matched per line."),
      query: aliasParam("pattern"),
      path: Type.Optional(
        Type.String({
          description:
            "File or directory to search; defaults to the workspace root and accepts an absolute scratch path.",
        }),
      ),
      include: Type.Optional(
        Type.String({ description: "Glob filter, for example **/*.{ts,tsx}." }),
      ),
      outputMode: Type.Optional(
        Type.Union([
          Type.Literal("content"),
          Type.Literal("filesWithMatches"),
          Type.Literal("count"),
        ]),
      ),
      headLimit: Type.Optional(
        Type.Number({ minimum: 1, description: "Maximum matches or files; defaults to 200." }),
      ),
      caseInsensitive: Type.Optional(Type.Boolean()),
    },
    Write: {
      path: pathParam("File to write; workspace-relative."),
      file_path: aliasParam("path"),
      content: Type.String(),
    },
    Edit: {
      path: pathParam("File to edit; workspace-relative."),
      file_path: aliasParam("path"),
      tag: Type.Optional(
        Type.String({
          description:
            "4 uppercase hex from the latest Read, Grep, Write, or Edit for this path. Required unless legacy old_string/new_string is used.",
        }),
      ),
      ops: Type.Optional(
        Type.String({
          description:
            "One or more operation headers with + body rows, newline separated. A PUT with body rows must end its header with `:` (for example, `PUT 48.=48:`); `PUT 48.=48` followed by + rows is invalid. A colonless PUT is only for a register paste such as `PUT <1 @name`. Required unless legacy old_string/new_string is used.",
        }),
      ),
      old_string: Type.Optional(
        Type.String({
          description:
            "Legacy text replacement: exact text to be replaced (must match exactly once in the target file).",
        }),
      ),
      new_string: Type.Optional(
        Type.String({
          description:
            "Legacy text replacement: new text to replace old_string with.",
        }),
      ),
    },
    BashOutput: {
      backgroundId: Type.String({ description: "The backgroundTaskId returned by Bash runInBackground." }),
    },
    KillBash: {
      backgroundId: Type.String({ description: "The backgroundTaskId returned by Bash runInBackground." }),
    },
    Bash: {
      command: Type.String(),
      timeout: Type.Optional(
        Type.Number({
          minimum: MIN_COMMAND_TIMEOUT_SECONDS,
          // Models routinely send milliseconds; a wider schema bound lets the
          // runtime read the intent instead of burning the turn (D273 / D329).
          maximum: MAX_ACCEPTED_COMMAND_TIMEOUT,
          description:
            `Optional command timeout in seconds from 1 to ${MAX_COMMAND_TIMEOUT_SECONDS}; defaults to 60 seconds.`,
        }),
      ),
      runInBackground: Type.Optional(
        Type.Boolean({
          description:
            "Start the command as a background task that outlives the turn (dev servers, watchers, builds). Returns backgroundTaskId immediately; ignored with timeout.",
        }),
      ),
    },
    PluginScaffold: {
      template: Type.String(),
      directory: Type.String(),
      id: Type.Optional(Type.String()),
      name: Type.Optional(Type.String()),
    },
    PluginCheck: { directory: Type.String() },
    PluginPack: { directory: Type.String() },
  };
  return { describe, parameters };
}
