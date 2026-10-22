/*
  mc-agent: which system prompt template a conversation uses (MC-ADR-0010).

  Templates and their rules live in host-core (`mcPrompts.get`). Exactly one
  template applies, whole, to a conversation: the project's, else the model's,
  else the global default. "Project" rules match folders, not project ids: a
  rule for the conversation's start folder wins, then a rule for any other
  folder of its project, each in the order the rules are listed. Without one, the pi-compatible SYSTEM.md /
  APPEND_SYSTEM.md files and then the built-in prompt apply as before. A
  template replaces only the persona and adds rules after the base prompt;
  the runtime's operational rules, the project's AGENTS.md and its memory
  always stay.
*/

export type PromptTemplate = { id: string; name: string; persona: string; append: string };

export type PromptConfig = {
  templates: PromptTemplate[];
  globalTemplateId?: string | null;
  modelRules: Array<{ pattern: string; templateId: string }>;
  projectRules: Array<{ path: string; templateId: string }>;
};

export type PromptMatch =
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
  },
): ResolvedPromptTemplate | null {
  if (!config) return null;
  const byId = new Map(config.templates.map((template) => [template.id, template]));
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

/** The template each conversation's latest launch used, for the prompt viewer. */
const lastMatches = new Map<string, { templateName: string; match: PromptMatch } | null>();

export function rememberPromptMatch(sessionId: string, resolved: ResolvedPromptTemplate | null): void {
  lastMatches.set(sessionId, resolved ? { templateName: resolved.template.name, match: resolved.match } : null);
  if (lastMatches.size > 500) lastMatches.delete(lastMatches.keys().next().value as string);
}

export function promptMatchFor(sessionId: string): { templateName: string; match: PromptMatch } | null {
  return lastMatches.get(sessionId) ?? null;
}
