/**
 * mc-agent (R41): Alchemy — distill a conversation and referenced materials
 * into a reusable user Skill or System Prompt Template, with `mc://` dynamic
 * references and an explicit user-confirmation card before writing to disk.
 */

export const RESOLVE_REF_TOOL_NAME = "ResolveRef";
export const PROPOSE_ALCHEMY_TOOL_NAME = "ProposeAlchemyArtifact";
export const ALCHEMY_SKILL_ID = "mc-agent/alchemy";

export const ALCHEMY_NAME_MAX = 80;
export const ALCHEMY_DESCRIPTION_MAX = 300;
export const ALCHEMY_BODY_MAX = 24_000;
export const ALCHEMY_NOTE_MAX = 300;
export const ALCHEMY_TRIGGER_MAX = 200;
export const ALCHEMY_REFS_MAX = 20;
export const ALCHEMY_URI_MAX = 512;
export const ALCHEMY_RESOLVE_MAX_CHARS = 32_000;

export type McRefScheme =
  | { kind: "resource"; relativePath: string }
  | { kind: "workspace"; relativePath: string }
  | { kind: "prompt"; templateId: string }
  | { kind: "skill"; skillId: string }
  | { kind: "session"; sessionId: string }
  | { kind: "memory" };

export type McRefParseResult =
  | { ok: true; ref: McRefScheme; normalized: string }
  | { ok: false; error: string };

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function isSafeRelativeRefPath(raw: string): boolean {
  if (!raw || raw.startsWith("/") || raw.includes("\\") || CONTROL_CHARS.test(raw)) {
    return false;
  }
  const segments = raw.split("/");
  return segments.every((seg) => seg.length > 0 && seg !== "." && seg !== "..");
}

function isSafeRefId(raw: string): boolean {
  return raw.length > 0 && raw.length <= 200 && !raw.includes("/") && !raw.includes("\\") && !CONTROL_CHARS.test(raw) && raw !== "." && raw !== "..";
}

/**
 * Parse and validate an internal `mc://` reference URI.
 *
 * Supported forms:
 * - `mc://resource/<relative/path>` — file inside the project's resource folder
 * - `mc://workspace/<relative/path>` — file inside the current session workspace
 * - `mc://prompt/<templateId>` — system prompt template
 * - `mc://skill/<skillId>` — user skill
 * - `mc://session/<sessionId>` — conversation in the same local project
 * - `mc://memory` — current project memory
 */
export function parseMcRefUri(rawUri: unknown): McRefParseResult {
  if (typeof rawUri !== "string") {
    return { ok: false, error: "uri must be a string" };
  }
  const trimmed = rawUri.trim();
  if (!trimmed || trimmed.length > ALCHEMY_URI_MAX || CONTROL_CHARS.test(trimmed)) {
    return { ok: false, error: "uri is empty, too long, or contains control characters" };
  }
  if (!trimmed.startsWith("mc://")) {
    return { ok: false, error: "uri must start with mc://" };
  }
  const rest = trimmed.slice("mc://".length);
  const slashIndex = rest.indexOf("/");
  const kind = slashIndex === -1 ? rest : rest.slice(0, slashIndex);
  const tail = slashIndex === -1 ? "" : rest.slice(slashIndex + 1);

  if (kind === "memory") {
    if (tail) return { ok: false, error: "mc://memory does not take a path segment" };
    return { ok: true, ref: { kind: "memory" }, normalized: "mc://memory" };
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(tail);
  } catch {
    return { ok: false, error: "uri contains invalid percent-encoding" };
  }

  if (kind === "resource" || kind === "workspace") {
    if (!isSafeRelativeRefPath(decoded)) {
      return { ok: false, error: `mc://${kind}/ path must be a safe relative path without '..'` };
    }
    return {
      ok: true,
      ref: { kind, relativePath: decoded },
      normalized: `mc://${kind}/${decoded}`,
    };
  }

  if (kind === "prompt") {
    if (!isSafeRefId(decoded)) return { ok: false, error: "mc://prompt/<id> requires a valid template id" };
    return { ok: true, ref: { kind: "prompt", templateId: decoded }, normalized: `mc://prompt/${decoded}` };
  }

  if (kind === "skill") {
    if (!isSafeRefId(decoded)) return { ok: false, error: "mc://skill/<id> requires a valid skill id" };
    return { ok: true, ref: { kind: "skill", skillId: decoded }, normalized: `mc://skill/${decoded}` };
  }

  if (kind === "session") {
    if (!isSafeRefId(decoded)) return { ok: false, error: "mc://session/<id> requires a valid session id" };
    return { ok: true, ref: { kind: "session", sessionId: decoded }, normalized: `mc://session/${decoded}` };
  }

  return {
    ok: false,
    error: `Unsupported mc:// reference kind "${kind}". Supported: resource, workspace, prompt, skill, session, memory.`,
  };
}

export type AlchemyArtifactKind = "skill" | "prompt-template";
export type AlchemySkillScope = "project" | "global";

export type AlchemyProposal = {
  requestId: string;
  sessionId: string;
  kind: AlchemyArtifactKind;
  name: string;
  description: string;
  body: string;
  /** Applicable when `kind === "skill"`. Defaults to "project" if the session has a project path, else "global". */
  scope: AlchemySkillScope;
  /** Session's project path when available (used by renderer to save project-scoped skills). */
  projectPath?: string;
  /** Validated `mc://` dynamic references embedded in the artifact. */
  refs: string[];
  /** One-line explanation shown on the card. */
  note?: string;
  /** Suggested one-liner showing the user how to reuse it next time. */
  suggestedTrigger?: string;
};

export type AlchemyProposalInput = Omit<AlchemyProposal, "requestId" | "sessionId" | "projectPath">;

export type AlchemyProposalDecision =
  | {
      outcome: "saved";
      kind: AlchemyArtifactKind;
      id: string;
      name: string;
      scope?: AlchemySkillScope;
      path?: string;
      ref: string;
    }
  | { outcome: "revise"; request?: string }
  | { outcome: "canceled" }
  | { outcome: "failed"; message: string };

export type NormalizeAlchemyResult =
  | { ok: true; value: AlchemyProposalInput }
  | { ok: false; error: string };

function trimmedText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeAlchemyProposalArgs(
  raw: unknown,
  options?: { hasProjectPath?: boolean },
): NormalizeAlchemyResult {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "arguments must be an object" };
  }
  const input = raw as Record<string, unknown>;
  const kind = input.kind;
  if (kind !== "skill" && kind !== "prompt-template") {
    return { ok: false, error: 'kind must be "skill" or "prompt-template"' };
  }
  const name = trimmedText(input.name);
  if (!name || name.length > ALCHEMY_NAME_MAX || CONTROL_CHARS.test(name)) {
    return { ok: false, error: `name is required and must be at most ${ALCHEMY_NAME_MAX} characters` };
  }
  const description = trimmedText(input.description);
  if (kind === "skill" && !description) {
    return { ok: false, error: "description is required for a skill so it can trigger accurately" };
  }
  if (description.length > ALCHEMY_DESCRIPTION_MAX || CONTROL_CHARS.test(description)) {
    return { ok: false, error: `description must be at most ${ALCHEMY_DESCRIPTION_MAX} characters` };
  }
  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (!body || body.length > ALCHEMY_BODY_MAX) {
    return { ok: false, error: `body is required and must be at most ${ALCHEMY_BODY_MAX} characters` };
  }

  let scope: AlchemySkillScope = options?.hasProjectPath ? "project" : "global";
  if (input.scope !== undefined) {
    if (input.scope !== "project" && input.scope !== "global") {
      return { ok: false, error: 'scope must be "project" or "global"' };
    }
    scope = input.scope;
  }
  if (kind === "skill" && scope === "project" && options?.hasProjectPath === false) {
    scope = "global";
  }

  const refs: string[] = [];
  if (input.refs !== undefined) {
    if (!Array.isArray(input.refs)) {
      return { ok: false, error: "refs must be an array of mc:// URIs" };
    }
    if (input.refs.length > ALCHEMY_REFS_MAX) {
      return { ok: false, error: `refs may contain at most ${ALCHEMY_REFS_MAX} entries` };
    }
    const seen = new Set<string>();
    for (const item of input.refs) {
      const parsed = parseMcRefUri(item);
      if (!parsed.ok) {
        return { ok: false, error: `invalid ref "${String(item)}": ${parsed.error}` };
      }
      if (!seen.has(parsed.normalized)) {
        seen.add(parsed.normalized);
        refs.push(parsed.normalized);
      }
    }
  }

  const note = trimmedText(input.note).replace(/\s+/g, " ");
  if (note.length > ALCHEMY_NOTE_MAX) {
    return { ok: false, error: `note must be at most ${ALCHEMY_NOTE_MAX} characters` };
  }
  const suggestedTrigger = trimmedText(input.suggestedTrigger).replace(/\s+/g, " ");
  if (suggestedTrigger.length > ALCHEMY_TRIGGER_MAX) {
    return { ok: false, error: `suggestedTrigger must be at most ${ALCHEMY_TRIGGER_MAX} characters` };
  }

  return {
    ok: true,
    value: {
      kind,
      name,
      description,
      body,
      scope,
      refs,
      ...(note ? { note } : {}),
      ...(suggestedTrigger ? { suggestedTrigger } : {}),
    },
  };
}
