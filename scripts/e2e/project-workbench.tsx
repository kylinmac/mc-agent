import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { I18nextProvider } from "react-i18next";
import type { i18n } from "i18next";
import { api } from "../../apps/desktop/src/lib/api";
import { ProjectWorkbench } from "../../apps/desktop/src/features/project-workbench/ProjectWorkbench";
import type { ProjectIndexItem } from "../../apps/desktop/src/lib/project-archive";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const settle = async () => {
  await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame);
};

/** Real form controls with delayed reads/writes; no host or model is started. */
export async function projectWorkbenchProbe(i18n: i18n) {
  const original = { ...api, creativeCall: api.creative.call, tasksList: api.projectTasks.list };
  const goalLoad = deferred<Awaited<ReturnType<typeof api.getProjectGoal>>>();
  let goalSave = deferred<Awaited<ReturnType<typeof api.setProjectGoal>>>();
  let noteSave = deferred<Awaited<ReturnType<typeof api.setWorkspaceNote>>>();
  let noteLoads = 0;
  const serverNotes = [{ path: "/fixture/code", heading: "Code", description: "Saved description" }];
  const errors: string[] = [];
  api.getProjectGoal = () => goalLoad.promise;
  api.setProjectGoal = () => goalSave.promise;
  api.listWorkspaceNotes = async () => {
    noteLoads++;
    return { notes: [...serverNotes] };
  };
  api.setWorkspaceNote = () => noteSave.promise;
  api.listProjectResources = async () => ({
    items: [], categories: [], truncated: false,
    summary: { total: 0, confirmed: 0, changed: 0, draft: 0, missing: 0, deprecated: 0 },
  });
  api.projectTasks.list = async () => ({ tasks: [] });
  api.projectTemplateStatus = async () => ({ status: null });
  api.listResourceTemplates = async () => ({ templates: [] });
  api.creative.call = (async () => ({ purposes: {} })) as typeof api.creative.call;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const project: ProjectIndexItem = {
    groupId: "workbench", name: "Workbench", path: "/fixture/resources", openedAt: 0,
    legacy: false,
    roots: [
      { path: "/fixture/resources", kind: "resources" },
      { path: "/fixture/code", kind: "workspace" },
    ],
  };
  const mount = (value = project) => flushSync(() => root.render(
    <I18nextProvider i18n={i18n}>
      <ProjectWorkbench project={value} onProjectChanged={() => {}} onStartSession={() => {}}
        onError={(message) => errors.push(message)} />
    </I18nextProvider>,
  ));
  const input = (selector: string) => {
    const element = host.querySelector<HTMLInputElement>(selector);
    if (!element) throw new Error(`Missing workbench input ${selector}`);
    return element;
  };
  const type = (element: HTMLInputElement, value: string) => {
    if (element.disabled) return false;
    element.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    flushSync(() => element.dispatchEvent(new Event("input", { bubbles: true })));
    return true;
  };
  const blur = (element: HTMLInputElement) => flushSync(() =>
    element.dispatchEvent(new FocusEvent("focusout", { bubbles: true })),
  );
  try {
    mount();
    await settle();
    const goal = input("#mc-goal-workbench");
    const typedBeforeLoad = type(goal, "Draft typed while loading");
    goalLoad.resolve({ goal: "Loaded goal" });
    await settle();
    const loadDoesNotLoseDraft = !typedBeforeLoad || goal.value === "Draft typed while loading";

    type(goal, "First saved goal");
    blur(goal);
    const typedDuringSave = type(goal, "Next goal draft");
    goalSave.resolve({ goal: "First saved goal" });
    await settle();
    const saveDoesNotLoseDraft = !typedDuringSave || goal.value === "Next goal draft";

    goalSave = deferred();
    type(goal, "Retry this goal");
    blur(goal);
    goalSave.reject(new Error("Goal write failed"));
    await settle();
    const goalFailureKeepsDraft = goal.value === "Retry this goal" && !goal.disabled;

    const note = input(".mc-workbench-workspaces input");
    type(note, "Unsaved description");
    // A session refresh rebuilds roots without changing this project's folders.
    mount({ ...project, roots: project.roots.map((item) => ({ ...item })) });
    await settle();
    const refreshKeepsNote = note.value === "Unsaved description" && noteLoads === 1;

    type(note, "First saved note");
    blur(note);
    const editedNoteDuringSave = type(note, "Next note draft");
    noteSave.resolve({ note: { path: "/fixture/code", heading: "Code", description: "First saved note" } });
    await settle();
    const noteSaveDoesNotLoseDraft = !editedNoteDuringSave || note.value === "Next note draft";

    noteSave = deferred();
    type(note, "Retry this note");
    blur(note);
    noteSave.reject(new Error("Note write failed"));
    await settle();
    const noteFailureKeepsDraft = note.value === "Retry this note" && !note.disabled;
    serverNotes.push({ path: "/fixture/added", heading: "Added", description: "Existing added folder note" });
    mount({ ...project, roots: [...project.roots, { path: "/fixture/added", kind: "workspace" }] });
    await settle();
    const addedFolderLoadsNote = [...host.querySelectorAll<HTMLInputElement>(".mc-workbench-workspaces input")]
      .some((element) => element.value === "Existing added folder note");
    const results = { loadDoesNotLoseDraft, saveDoesNotLoseDraft, goalFailureKeepsDraft,
      refreshKeepsNote, noteSaveDoesNotLoseDraft, noteFailureKeepsDraft, addedFolderLoadsNote, errorsReported: errors.length === 2 };
    return { ok: Object.values(results).every(Boolean), ...results };
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    api.getProjectGoal = original.getProjectGoal;
    api.setProjectGoal = original.setProjectGoal;
    api.listWorkspaceNotes = original.listWorkspaceNotes;
    api.setWorkspaceNote = original.setWorkspaceNote;
    api.listProjectResources = original.listProjectResources;
    api.projectTemplateStatus = original.projectTemplateStatus;
    api.listResourceTemplates = original.listResourceTemplates;
    api.creative.call = original.creativeCall;
    api.projectTasks.list = original.tasksList;
  }
}
