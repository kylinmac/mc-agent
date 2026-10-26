import { Type } from "@earendil-works/pi-ai";
import { AGENT_MEMORY_CONTENT_MAX, AGENT_MEMORY_TITLE_MAX } from "@pi-desktop/shared";

/**
 * mc-agent (MC-ADR-0019): the agent keeps durable notes in the project's
 * memory. Electron main writes them (a host-local tool); they show up in the
 * project memory panel where the user can edit or delete them.
 */
export const REMEMBER_TOOL_NAME = "Remember";

export const rememberDescription = [
  "Save a durable note to this project's memory, which is loaded into every later conversation in the project; the user sees and can edit or delete it in the project memory panel.",
  "Save what a later conversation could not learn from the files or history: a preference or correction the user gave about how to work (with the reason), a decision or constraint of the project, an external resource to use.",
  "Do not save code structure, file contents, things already in the repository's docs or instructions, temporary task state, or anything secret (passwords, keys, tokens, personal data).",
  "Write one fact per note, with a short title. Saving again with the same title replaces your earlier note; empty content removes it. Prefer updating an existing note over adding a near-duplicate. Only notes you saved can be changed this way.",
].join(" ");

export const rememberParameters = {
  title: Type.String({ minLength: 1, maxLength: AGENT_MEMORY_TITLE_MAX, description: "Short title; the same title replaces your earlier note." }),
  content: Type.String({ maxLength: AGENT_MEMORY_CONTENT_MAX, description: "The note. For a preference or correction, add the reason. Empty removes your note with this title." }),
};
