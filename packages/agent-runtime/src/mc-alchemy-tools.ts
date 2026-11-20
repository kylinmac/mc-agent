import { Type } from "@earendil-works/pi-ai";
import {
  ALCHEMY_BODY_MAX,
  ALCHEMY_DESCRIPTION_MAX,
  ALCHEMY_NAME_MAX,
  ALCHEMY_NOTE_MAX,
  ALCHEMY_REFS_MAX,
  ALCHEMY_TRIGGER_MAX,
  ALCHEMY_URI_MAX,
  PROPOSE_ALCHEMY_TOOL_NAME,
  RESOLVE_REF_TOOL_NAME,
} from "@pi-desktop/shared";

/**
 * mc-agent (R41): Alchemy — resolve internal `mc://` references and propose
 * reusable user Skills or System Prompt Templates on a user-confirmation card.
 * Electron main serves both tools locally; nothing is written before the user
 * confirms on the card.
 */

export { PROPOSE_ALCHEMY_TOOL_NAME, RESOLVE_REF_TOOL_NAME };

export const resolveRefDescription = [
  "Resolve an internal mc-agent reference URI (`mc://...`) to its latest content (read-only).",
  "Supported URIs: `mc://resource/<relativePath>` (project resource folder file), `mc://workspace/<relativePath>` (session workspace file), `mc://prompt/<templateId>` (system prompt template), `mc://skill/<skillId>` (user skill), `mc://session/<sessionId>` (same-project conversation history), and `mc://memory` (project memory).",
  "Use this before distilling materials in Alchemy, and inside saved Skills/Templates whenever a living rule or file should be read fresh at run time.",
].join(" ");

export const resolveRefParameters = {
  uri: Type.String({
    minLength: 5,
    maxLength: ALCHEMY_URI_MAX,
    description:
      "An internal mc:// URI such as mc://resource/rules/review.md, mc://workspace/AGENTS.md, mc://prompt/<id>, mc://skill/<id>, mc://session/<id>, or mc://memory.",
  }),
};

export const proposeAlchemyDescription = [
  "Propose saving a distilled reusable Skill (`skill`) or System Prompt Template (`prompt-template`) to the user.",
  "The desktop displays a confirmation card where the user reviews or edits the name, scope, description, and body before clicking Save; nothing is written to disk before confirmation.",
  "Embed stable procedures/formats directly in `body`, and embed living rules/documents as `mc://` references (listed in `refs` as well) with an instruction to call `ResolveRef` at execution time.",
  "Outcomes: `saved` (done; give the user the saved reference and one-line trigger), `revise` (the user wants edits; update and propose again), `canceled` (stop cleanly), `failed` (report the error).",
].join(" ");

export const proposeAlchemyParameters = {
  kind: Type.Union([Type.Literal("skill"), Type.Literal("prompt-template")], {
    description: "Whether to create a reusable Skill (`skill`) or a System Prompt Template (`prompt-template`).",
  }),
  name: Type.String({
    minLength: 1,
    maxLength: ALCHEMY_NAME_MAX,
    description: "Clear task-oriented name in the user's language (e.g. 月度资料核查, PR 架构评审模板).",
  }),
  description: Type.String({
    maxLength: ALCHEMY_DESCRIPTION_MAX,
    description:
      "Required for skills: concise description of when to trigger and what it does. Optional short note for prompt-template.",
  }),
  body: Type.String({
    minLength: 1,
    maxLength: ALCHEMY_BODY_MAX,
    description:
      "Full Markdown body of the skill (without YAML frontmatter, host adds frontmatter automatically) or full text of the system prompt template.",
  }),
  scope: Type.Optional(
    Type.Union([Type.Literal("project"), Type.Literal("global")], {
      description: "For `skill` only: `project` (current project `.agents/skills`) or `global` (all projects). Defaults to `project` when in a project.",
    }),
  ),
  refs: Type.Optional(
    Type.Array(Type.String({ minLength: 5, maxLength: ALCHEMY_URI_MAX }), {
      maxItems: ALCHEMY_REFS_MAX,
      description: "Validated `mc://` dynamic references embedded in `body` so the card can highlight them.",
    }),
  ),
  note: Type.Optional(
    Type.String({
      maxLength: ALCHEMY_NOTE_MAX,
      description: "One short sentence explaining what was distilled and any assumptions made.",
    }),
  ),
  suggestedTrigger: Type.Optional(
    Type.String({
      maxLength: ALCHEMY_TRIGGER_MAX,
      description: "One-liner showing the user how to reuse this artifact next time.",
    }),
  ),
};
