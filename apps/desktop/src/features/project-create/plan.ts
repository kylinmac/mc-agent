import type { ProjectCreateStep, ProjectDraftTemplate } from "@pi-desktop/shared";

/** mc-agent (MC-ADR-0023): what the user confirmed on the proposal card. */
export type ConfirmedPlan = {
  name: string;
  path: string;
  /** An existing resource template. */
  template?: string;
  /** A drafted template; `saveDraft` puts it in the library first. */
  draft?: ProjectDraftTemplate;
  saveDraft?: boolean;
  promptTemplateId?: string;
};

export type StepState = "pending" | "running" | "done" | "failed";

export function planSteps(plan: ConfirmedPlan): ProjectCreateStep[] {
  return [
    "folder",
    "project",
    ...(plan.template || plan.draft ? (["resources"] as const) : []),
    ...(plan.promptTemplateId || plan.draft?.systemPrompt ? (["prompt"] as const) : []),
  ];
}

/** A free name for a template saved from a draft: `video`, `video-2`, … */
export function freeTemplateName(wanted: string, taken: readonly string[]): string {
  const names = new Set(taken.map((name) => name.toLowerCase()));
  if (!names.has(wanted.toLowerCase())) return wanted;
  for (let attempt = 2; attempt < 1000; attempt += 1) {
    const candidate = `${wanted}-${attempt}`;
    if (!names.has(candidate.toLowerCase())) return candidate;
  }
  return `${wanted}-${Date.now()}`;
}
