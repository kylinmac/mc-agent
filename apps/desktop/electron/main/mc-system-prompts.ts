/*
  mc-agent: which system prompt template a conversation uses (MC-ADR-0010).

  Templates and their rules live in host-core (`mcPrompts.get`). Exactly one
  template applies, whole, to a conversation: the one chosen for that
  conversation when it was started (`mcPrompts.sessionGet`), else the
  project's, else the model's, else the global default. "Project" rules match folders, not project ids: a
  rule for the conversation's start folder wins, then a rule for any other
  folder of its project, each in the order the rules are listed. Without one, the pi-compatible SYSTEM.md /
  APPEND_SYSTEM.md files and then the built-in prompt apply as before. A
  template replaces only the persona and adds rules after the base prompt;
  the runtime's operational rules, the project's AGENTS.md and its memory
  always stay.

  Append prompts sit beside the templates: every enabled one is added, in
  list order, after what the template (or APPEND_SYSTEM.md) appends, whichever
  template applies or none. No rule picks them and they replace nothing.
*/

export type PromptTemplate = { id: string; name: string; persona: string; append: string };

export type AppendPrompt = { id: string; name: string; text: string; enabled: boolean };

export type PromptConfig = {
  templates: PromptTemplate[];
  globalTemplateId?: string | null;
  modelRules: Array<{ pattern: string; templateId: string }>;
  projectRules: Array<{ path: string; templateId: string }>;
  /** Absent in documents saved before append prompts existed. */
  appendPrompts?: AppendPrompt[];
};

export type PromptMatch =
  | { kind: "session" }
  | { kind: "project"; path: string }
  | { kind: "model"; pattern: string }
  | { kind: "global" };

export type ResolvedPromptTemplate = { template: PromptTemplate; match: PromptMatch };

function normalizePath(path: string): string {
  return path.trim().replace(/[\\/]+$/, "");
}

/** `*` matches any run of characters; case does not matter. */
export function modelMatches(pattern: string, modelId: string): boolean {
  const source = pattern
    .trim()
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`, "i").test(modelId.trim());
}

/** An exact model beats a pattern; among patterns, more literal text wins. */
function specificity(pattern: string): number {
  const literal = pattern.replace(/\*/g, "").length;
  return pattern.includes("*") ? literal : 10_000 + literal;
}

export function resolvePromptTemplate(
  config: PromptConfig | null | undefined,
  context: {
    /**
     * The conversation's start folder first, then the other folders of its
     * project.
     */
    projectPaths: readonly string[];
    modelId?: string | null;
    /** The template picked for this conversation; ignored once it is deleted. */
    sessionTemplateId?: string | null;
  },
): ResolvedPromptTemplate | null {
  if (!config) return null;
  const byId = new Map(config.templates.map((template) => [template.id, template]));
  const chosen = context.sessionTemplateId ? byId.get(context.sessionTemplateId) : undefined;
  if (chosen) return { template: chosen, match: { kind: "session" } };
  const [start = "", ...others] = context.projectPaths.map(normalizePath);
  const rest = new Set(others.filter(Boolean));
  const usable = config.projectRules.filter((rule) => byId.has(rule.templateId));
  const hit =
    (start ? usable.find((rule) => normalizePath(rule.path) === start) : undefined) ??
    usable.find((rule) => rest.has(normalizePath(rule.path)));
  if (hit) return { template: byId.get(hit.templateId)!, match: { kind: "project", path: hit.path } };
  const modelId = context.modelId?.trim();
  if (modelId) {
    const best = config.modelRules
      .filter((rule) => byId.has(rule.templateId) && modelMatches(rule.pattern, modelId))
      .sort((a, b) => specificity(b.pattern) - specificity(a.pattern))[0];
    if (best) return { template: byId.get(best.templateId)!, match: { kind: "model", pattern: best.pattern } };
  }
  const global = config.globalTemplateId ? byId.get(config.globalTemplateId) : undefined;
  return global ? { template: global, match: { kind: "global" } } : null;
}

/** The runtime's custom-prompt shape for a template; an empty part keeps the default. */
export function templatePrompt(template: PromptTemplate): { replace?: string; append?: string } {
  const persona = template.persona.trim();
  const append = template.append.trim();
  return { ...(persona ? { replace: persona } : {}), ...(append ? { append } : {}) };
}

/** The enabled append prompts with text, in the order they apply. */
export function enabledAppendPrompts(config: PromptConfig | null | undefined): AppendPrompt[] {
  return (config?.appendPrompts ?? []).filter((prompt) => prompt.enabled && prompt.text.trim());
}

/** Adds the append prompts after whatever `custom` already appends. */
export function withAppendPrompts(
  custom: { replace?: string; append?: string } | undefined,
  prompts: readonly AppendPrompt[],
): { replace?: string; append?: string } | undefined {
  if (prompts.length === 0) return custom;
  const append = [custom?.append, ...prompts.map((prompt) => prompt.text.trim())].filter(Boolean).join("\n\n");
  return { ...(custom ?? {}), append };
}

/** The template each conversation's latest launch used, for the prompt viewer. */
const lastMatches = new Map<string, { templateName: string; match: PromptMatch } | null>();

export function rememberPromptMatch(sessionId: string, resolved: ResolvedPromptTemplate | null): void {
  lastMatches.set(sessionId, resolved ? { templateName: resolved.template.name, match: resolved.match } : null);
  if (lastMatches.size > 500) lastMatches.delete(lastMatches.keys().next().value as string);
}

export function promptMatchFor(sessionId: string): { templateName: string; match: PromptMatch } | null {
  return lastMatches.get(sessionId) ?? null;
}

/**
 * The append prompts each conversation's latest launch added, and whether
 * APPEND_SYSTEM.md was appended too, for the prompt viewer.
 */
const lastAppends = new Map<string, { names: string[]; fileAppend: boolean }>();

export function rememberAppendPrompts(sessionId: string, names: string[], fileAppend: boolean): void {
  lastAppends.set(sessionId, { names, fileAppend });
  if (lastAppends.size > 500) lastAppends.delete(lastAppends.keys().next().value as string);
}

export function appendPromptsFor(sessionId: string): { names: string[]; fileAppend: boolean } | null {
  return lastAppends.get(sessionId) ?? null;
}
