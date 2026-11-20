import type {
  AlchemyArtifactKind,
  AlchemyProposalDecision,
  AlchemySkillScope,
  SystemPromptConfig,
  UserSkillInput,
  UserSkillRecord,
} from "@pi-desktop/shared";

export type AlchemySaveDraft = {
  kind: AlchemyArtifactKind;
  name: string;
  description: string;
  body: string;
  scope: AlchemySkillScope;
  projectPath?: string;
};

export type AlchemySaveDeps = {
  createUserSkill: (skill: UserSkillInput) => Promise<{ skill: UserSkillRecord }>;
  getSystemPromptConfig: () => Promise<{ config: SystemPromptConfig }>;
  setSystemPromptConfig: (config: SystemPromptConfig) => Promise<{ config: SystemPromptConfig }>;
  newId?: () => string;
};

function defaultTemplateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `alchemy-${crypto.randomUUID()}`;
  }
  return `alchemy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Persist a confirmed Alchemy proposal through existing host-core write paths
 * (`skills.create` for user skills, `mcPrompts.get` + `mcPrompts.set` for
 * system prompt templates).
 */
export async function saveAlchemyArtifact(
  draft: AlchemySaveDraft,
  deps: AlchemySaveDeps,
): Promise<AlchemyProposalDecision> {
  const name = draft.name.trim();
  const description = draft.description.trim();
  const body = draft.body.trim();
  if (!name) return { outcome: "failed", message: "Name is required." };
  if (!body) return { outcome: "failed", message: "Content is required." };

  try {
    if (draft.kind === "skill") {
      if (!description) return { outcome: "failed", message: "Description is required for a skill." };
      const useProject = draft.scope === "project" && Boolean(draft.projectPath?.trim());
      const input: UserSkillInput = {
        name,
        description,
        body,
        level: useProject ? "project" : "global",
        ...(useProject ? { projectPath: draft.projectPath!.trim() } : {}),
        enabled: true,
      };
      const { skill } = await deps.createUserSkill(input);
      return {
        outcome: "saved",
        kind: "skill",
        id: skill.id,
        name: skill.name,
        scope: useProject ? "project" : "global",
        ...(skill.path ? { path: skill.path } : {}),
        ref: `mc://skill/${skill.id}`,
      };
    }

    const { config } = await deps.getSystemPromptConfig();
    const id = (deps.newId ?? defaultTemplateId)();
    const nextConfig: SystemPromptConfig = {
      ...config,
      templates: [
        ...(config.templates ?? []),
        {
          id,
          name,
          persona: "",
          append: description ? `<!-- ${description} -->\n\n${body}` : body,
        },
      ],
    };
    await deps.setSystemPromptConfig(nextConfig);
    return {
      outcome: "saved",
      kind: "prompt-template",
      id,
      name,
      ref: `mc://prompt/${id}`,
    };
  } catch (error) {
    return {
      outcome: "failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
