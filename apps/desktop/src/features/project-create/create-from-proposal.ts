import type {
  ProjectCreateStep,
  ProjectDraftTemplate,
  ProjectGroupRecord,
  ProjectProposalDecision,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { normalizeProjectPath } from "../../lib/sidebar-preferences";
import { useAppStore } from "../../stores/app-store";
import { saveProjectPromptTemplate } from "../project-workbench/project-prompt-save";
import { withProjectPromptTemplate } from "../project-workbench/project-prompt";
import { freeTemplateName, type ConfirmedPlan, type StepState } from "./plan";

/*
  mc-agent (MC-ADR-0023): carry out a confirmed proposal with the same IPC the
  create dialog uses, without leaving the conversation. Each step reports its
  progress; a failure stops there, and a folder this run created is removed
  again while it is still empty.
*/

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function draftCategories(draft: ProjectDraftTemplate) {
  return draft.folders.map((folder) => ({ name: folder.path, description: folder.description }));
}

async function attachResources(group: ProjectGroupRecord, plan: ConfirmedPlan) {
  if (plan.template) {
    return { group: (await api.ensureProjectResources(group.id, plan.template)).group, template: plan.template };
  }
  const draft = plan.draft!;
  if (plan.saveDraft) {
    const { templates } = await api.listResourceTemplates();
    const name = freeTemplateName(draft.name, templates.map((template) => template.name));
    await api.saveResourceTemplate({
      name,
      description: draft.description,
      categories: draftCategories(draft),
      create: true,
    });
    return { group: (await api.ensureProjectResources(group.id, name)).group, template: name, saved: true };
  }
  const result = await api.mcProjectCreate.ensureDraft(group.id, {
    name: draft.name,
    description: draft.description,
    categories: draftCategories(draft),
  });
  return { group: result.group, template: draft.name };
}

/** A drafted system prompt becomes a template named after the project. */
async function applyPrompt(group: ProjectGroupRecord, plan: ConfirmedPlan): Promise<string | undefined> {
  const paths = group.roots.map((root) => root.path);
  const primary = group.primaryPath || paths[0];
  if (plan.promptTemplateId) {
    await saveProjectPromptTemplate(paths, primary, plan.promptTemplateId);
    return plan.promptTemplateId;
  }
  const rules = plan.draft?.systemPrompt?.trim();
  if (!rules) return undefined;
  const { config } = await api.getSystemPromptConfig();
  const id = crypto.randomUUID();
  const withTemplate = {
    ...config,
    templates: [...config.templates, { id, name: plan.name, persona: "", append: rules }],
  };
  await api.setSystemPromptConfig(withProjectPromptTemplate(withTemplate, paths, primary, id));
  return plan.name;
}

export async function createProjectFromPlan(
  plan: ConfirmedPlan,
  onStep: (step: ProjectCreateStep, state: StepState) => void,
): Promise<ProjectProposalDecision> {
  const base = { name: plan.name, path: plan.path };
  let step: ProjectCreateStep = "folder";
  let folderCreated = false;
  let group: ProjectGroupRecord | null = null;
  try {
    onStep("folder", "running");
    folderCreated = (await api.mcProjectCreate.makeFolder(plan.path)).created;
    onStep("folder", "done");

    step = "project";
    onStep("project", "running");
    const { groups } = await api.listProjectGroups();
    const key = normalizeProjectPath(plan.path);
    const owner = groups.find((candidate) =>
      candidate.roots.some((root) => normalizeProjectPath(root.path) === key),
    );
    if (owner) throw new Error(`${plan.path} already belongs to the project ${owner.name}`);
    group = (await api.createProjectGroup(plan.name, [plan.path])).group;
    onStep("project", "done");

    let template: string | undefined;
    let templateSaved = false;
    if (plan.template || plan.draft) {
      step = "resources";
      onStep("resources", "running");
      const attached = await attachResources(group, plan);
      group = attached.group;
      template = attached.template;
      templateSaved = Boolean(attached.saved);
      onStep("resources", "done");
    }

    let promptTemplate: string | undefined;
    if (plan.promptTemplateId || plan.draft?.systemPrompt) {
      step = "prompt";
      onStep("prompt", "running");
      promptTemplate = await applyPrompt(group, plan);
      onStep("prompt", "done");
    }

    const primaryPath = group.primaryPath || plan.path;
    const state = useAppStore.getState();
    state.showProjectInSidebar({ path: primaryPath, name: plan.name });
    state.renameProject(primaryPath, plan.name);
    const resourcePath = group.roots.find((root) => root.kind === "resources")?.path;
    return {
      outcome: "created",
      ...base,
      primaryPath,
      ...(resourcePath ? { resourcePath } : {}),
      ...(template ? { template } : {}),
      ...(templateSaved ? { templateSaved } : {}),
      ...(promptTemplate ? { promptTemplate } : {}),
      folderCreated,
    };
  } catch (error) {
    onStep(step, "failed");
    // Without a project the new folder is only clutter; once the project
    // exists it stays, and the agent reports what is missing.
    if (!group && folderCreated) await api.mcProjectCreate.removeFolder(plan.path).catch(() => undefined);
    if (group) {
      useAppStore.getState().showProjectInSidebar({ path: group.primaryPath || plan.path, name: plan.name });
    }
    return { outcome: "failed", ...base, step, message: message(error) };
  }
}
