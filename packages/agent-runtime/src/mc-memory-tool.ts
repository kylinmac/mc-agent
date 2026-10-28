import { Type } from "@earendil-works/pi-ai";
import { AGENT_MEMORY_CONTENT_MAX, AGENT_MEMORY_TITLE_MAX, MEMORY_HOOK_MAX, RECALL_TOOL_NAME } from "@pi-desktop/shared";

export { RECALL_TOOL_NAME };

/**
 * mc-agent (MC-ADR-0019): the agent keeps durable notes in the project's
 * memory. Electron main writes them (a host-local tool); they show up in the
 * project memory panel where the user can edit or delete them.
 */
export const REMEMBER_TOOL_NAME = "Remember";

export const rememberDescription = [
  "Save a durable note to this project's memory, which is loaded into every later conversation in the project, or with scope \"user\" to the memory about the user that every conversation loads; the user sees and can edit or delete either.",
  "Give it a kind: feedback (how to work: a correction or a confirmed approach, with the reason and when it applies), user (who the user is, their preferences — usually scope user), project (a decision, constraint or goal the code and docs do not record; write dates as absolute dates), reference (where to find something outside). Add a one-line hook saying what the note is about; it is what later conversations see in the memory index.",
  "Save what a later conversation could not learn from the files or history: a preference or correction the user gave about how to work (with the reason), a decision or constraint of the project, an external resource to use.",
  "Do not save code structure, file contents, things already in the repository's docs or instructions, temporary task state, or anything secret (passwords, keys, tokens, personal data).",
  "Write one fact per note, with a short title. Saving again with the same title replaces your earlier note; empty content removes it. Prefer updating an existing note over adding a near-duplicate. Only notes you saved can be changed this way.",
].join(" ");

export const rememberParameters = {
  kind: Type.Optional(Type.Union([Type.Literal("feedback"), Type.Literal("user"), Type.Literal("project"), Type.Literal("reference")])),
  hook: Type.Optional(Type.String({ maxLength: MEMORY_HOOK_MAX, description: "One line: what the note is about, shown in the memory index." })),
  scope: Type.Optional(Type.Union([Type.Literal("project"), Type.Literal("user")], { description: "project (default) or user, the memory every project shares." })),
  title: Type.String({ minLength: 1, maxLength: AGENT_MEMORY_TITLE_MAX, description: "Short title; the same title replaces your earlier note." }),
  content: Type.String({ maxLength: AGENT_MEMORY_CONTENT_MAX, description: "The note. For a preference or correction, add the reason. Empty removes your note with this title." }),
};

/** mc-agent (MC-ADR-0024): read a memory note in full by the id in the memory index. */
export const recallDescription =
  "Read a memory note in full. When the memory in your system prompt is an index (lines like `- [id] (kind) title — summary`), pass the id of a note that looks relevant before relying on it.";

export const recallParameters = {
  id: Type.String({ minLength: 1, maxLength: 200, description: "The note id from the memory index." }),
};
