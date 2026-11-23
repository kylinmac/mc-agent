import type { SystemPromptConfig } from "@pi-desktop/shared";

/*
  mc-agent: a project's system prompt template, chosen where the project is
  created or edited. It is the same folder rule the Settings page edits
  (MC-ADR-0010), kept on the project's primary folder; choosing "default"
  removes the project's rules so model rules and the global default apply.
*/

function normalize(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * The template the project's rules pick, as the runtime resolves them: a rule
 * on the primary folder first, then one on any other folder, in list order.
 * Empty when no rule matches or its template is gone.
 */
export function projectPromptTemplateId(
  config: SystemPromptConfig | null,
  paths: readonly string[],
): string {
  if (!config) return "";
  const known = new Set(config.templates.map((template) => template.id));
  const usable = config.projectRules.filter((rule) => known.has(rule.templateId));
  const [primary = "", ...others] = paths.map(normalize);
  const rest = new Set(others.filter(Boolean));
  const hit =
    (primary ? usable.find((rule) => normalize(rule.path) === primary) : undefined) ??
    usable.find((rule) => rest.has(normalize(rule.path)));
  return hit?.templateId ?? "";
}

/**
 * The configuration with the project's rules replaced: every rule on one of
 * `paths` is removed, and a chosen template is added on `primaryPath`.
 */
export function withProjectPromptTemplate(
  config: SystemPromptConfig,
  paths: readonly string[],
  primaryPath: string,
  templateId: string,
): SystemPromptConfig {
  const owned = new Set([...paths, primaryPath].map(normalize).filter(Boolean));
  const projectRules = config.projectRules.filter((rule) => !owned.has(normalize(rule.path)));
  if (templateId && config.templates.some((template) => template.id === templateId)) {
    projectRules.push({ path: primaryPath, templateId });
  }
  return { ...config, projectRules };
}
