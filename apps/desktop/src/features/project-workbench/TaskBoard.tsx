import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectTask, ProjectTaskStatus, ResourceListing } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { Button } from "../../components/ui";
import { taskPrompt } from "./task-prompt";

const STATUS_KEYS: Record<ProjectTaskStatus, string> = {
  todo: "mcProject.taskTodo",
  inProgress: "mcProject.taskInProgress",
  awaitingReview: "mcProject.taskAwaitingReview",
  done: "mcProject.taskDone",
  blocked: "mcProject.taskBlocked",
  cancelled: "mcProject.taskCancelled",
};

/*
  R6–R9 task board. Starting a task checks its resources, creates a session in
  the chosen start folder, records the run, then sends the task as the first
  message. A finished run only reaches "awaiting review"; the user's verdict
  decides. host-core reconciles runs from session turns on every listing.
*/
export function TaskBoard({
  groupId,
  listing,
  startFolder,
  startFolderOptions = [],
  onStartFolderChange,
  onTasksChanged,
  onError,
}: {
  groupId: string;
  listing: ResourceListing | null;
  startFolder: string;
  /** The project's folders a task run can start in (#41). */
  startFolderOptions?: ReadonlyArray<{ path: string; label: string }>;
  onStartFolderChange?: (path: string) => void;
  onTasksChanged: (tasks: ProjectTask[]) => void;
  onError: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [tasks, setTasks] = useState<ProjectTask[]>([]);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ title: "", goal: "", acceptance: "", resources: [] as string[] });
  const [rejectFor, setRejectFor] = useState<string | null>(null);
  const [rejectNote, setRejectNote] = useState("");
  const [busy, setBusy] = useState(false);
  const changedRef = useRef(onTasksChanged);
  changedRef.current = onTasksChanged;

  const report = (error: unknown) =>
    onError(t("mcProject.taskError", { message: error instanceof Error ? error.message : String(error) }));

  const load = useCallback(async () => {
    try {
      const { tasks: loaded } = await api.projectTasks.list(groupId);
      setTasks(loaded);
      changedRef.current(loaded);
    } catch (error) {
      onError(String(error instanceof Error ? error.message : error));
    }
  }, [groupId, onError]);

  useEffect(() => {
    void load();
    // A running task settles when its session's turn ends; poll while one runs.
    const timer = window.setInterval(() => void load(), 5_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const act = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
      await load();
    }
  };

  const create = () =>
    act(async () => {
      await api.projectTasks.create(groupId, draft);
      setDraft({ title: "", goal: "", acceptance: "", resources: [] });
      setCreating(false);
    });

  const start = (task: ProjectTask) =>
    act(async () => {
      const check = await api.projectTasks.preflight(groupId, task.id);
      if (check.blocking.length > 0) {
        const names = check.resources
          .filter((resource) => check.blocking.includes(resource.key))
          .map((resource) => resource.title);
        throw new Error(t("mcProject.taskResourcesBlocked", { names: names.join("、") }));
      }
      const store = useAppStore.getState();
      await store.newSession({ projectPath: startFolder });
      const sessionId = useAppStore.getState().activeSessionId;
      if (!sessionId) throw new Error(t("mcProject.taskNoSession"));
      const started = await api.projectTasks.startRun(groupId, task.id, task.revision, sessionId, startFolder);
      const runId = started.task.runs.at(-1)?.id;
      try {
        // mc-agent (bugs.md B-011): the session is named after the task, not
        // after the first line of the (English) task prompt; later runs get
        // their number.
        const runs = started.task.runs.length;
        await useAppStore
          .getState()
          .renameSession(sessionId, runs > 1 ? t("mcProject.taskRunTitle", { title: task.title, n: runs }) : task.title)
          .catch(() => undefined);
        const lastRejection = [...task.reviews].reverse().find((review) => review.verdict === "rejected");
        const prompt = taskPrompt({
          title: task.title,
          goal: task.goal,
          acceptance: task.acceptance,
          resources: check.resources.map((resource) => {
            const item = listing?.items.find((candidate) => candidate.key === resource.key);
            return { title: resource.title, path: item?.path, url: item?.url, status: resource.status };
          }),
          previousRejection: task.status === "todo" ? lastRejection?.note : undefined,
        });
        store.setPage("chat");
        const accepted = await useAppStore.getState().sendPrompt(prompt, undefined, sessionId);
        if (!accepted) throw new Error(t("mcProject.taskNotSent"));
      } catch (error) {
        // The run is recorded but its first message never went out: settle
        // it now instead of leaving the task in progress.
        if (runId) {
          const reason = error instanceof Error ? error.message : String(error);
          await api.projectTasks.abandonRun(groupId, task.id, runId, reason).catch(() => undefined);
        }
        throw error;
      }
    });

  const openSession = async (sessionId: string) => {
    try {
      const store = useAppStore.getState();
      await store.selectSession(sessionId);
      store.setPage("chat");
    } catch (error) {
      report(error);
    }
  };

  const selectable = (listing?.items ?? []).filter((item) => item.status !== "deprecated");

  return (
    <div className="mc-workbench-tasks">
      <div className="mc-workbench-row">
        <span className="mc-workbench-label">{t("mcProject.tasksTitle")}</span>
        {startFolderOptions.length > 1 && onStartFolderChange ? (
          // mc-agent (#41): tasks start in this folder; pick it next to the
          // board instead of in the start-folder row at the bottom.
          <label className="mc-workbench-task-folder">
            <span className="mc-workbench-muted">{t("mcProject.taskStartFolderLabel")}</span>
            <select
              className="mc-workbench-select"
              value={startFolder}
              onChange={(event) => onStartFolderChange(event.target.value)}
            >
              {startFolderOptions.map((option) => (
                <option key={option.path} value={option.path} title={option.path}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <Button size="sm" variant="ghost" onClick={() => setCreating((value) => !value)}>
          {t("mcProject.taskNew")}
        </Button>
      </div>

      {creating ? (
        <div className="mc-workbench-task-form">
          <input
            className="mc-workbench-description"
            placeholder={t("mcProject.taskTitlePlaceholder")}
            aria-label={t("mcProject.taskTitlePlaceholder")}
            value={draft.title}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
          />
          <textarea
            className="mc-workbench-description mc-workbench-textarea"
            placeholder={t("mcProject.taskGoalPlaceholder")}
            aria-label={t("mcProject.taskGoalPlaceholder")}
            value={draft.goal}
            onChange={(event) => setDraft({ ...draft, goal: event.target.value })}
          />
          <textarea
            className="mc-workbench-description mc-workbench-textarea"
            placeholder={t("mcProject.taskAcceptancePlaceholder")}
            aria-label={t("mcProject.taskAcceptancePlaceholder")}
            value={draft.acceptance}
            onChange={(event) => setDraft({ ...draft, acceptance: event.target.value })}
          />
          {selectable.length > 0 ? (
            <fieldset className="mc-workbench-task-resources">
              <legend className="mc-workbench-label">{t("mcProject.taskResourcesLabel")}</legend>
              {selectable.map((item) => (
                <label key={item.key} className="mc-workbench-check">
                  <input
                    type="checkbox"
                    checked={draft.resources.includes(item.key)}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        resources: event.target.checked
                          ? [...draft.resources, item.key]
                          : draft.resources.filter((key) => key !== item.key),
                      })
                    }
                  />
                  {item.category ? `${item.category} / ` : ""}
                  {item.title}
                </label>
              ))}
            </fieldset>
          ) : null}
          <div className="mc-workbench-row">
            <Button
              size="sm"
              variant="primary"
              disabled={busy || !draft.title.trim() || !draft.acceptance.trim()}
              onClick={() => void create()}
            >
              {t("mcProject.taskCreate")}
            </Button>
            <span className="mc-workbench-muted">{t("mcProject.taskAcceptanceHint")}</span>
          </div>
        </div>
      ) : null}

      {tasks.length === 0 && !creating ? <p className="mc-workbench-muted">{t("mcProject.tasksEmpty")}</p> : null}
      <ul className="mc-workbench-resources">
        {tasks.map((task) => {
          const run = task.runs.at(-1);
          return (
            <li key={task.id} className="mc-workbench-task">
              <div className="mc-workbench-resource">
                <span className="mc-workbench-task-title" title={task.acceptance}>
                  {task.title}
                </span>
                <span className={`mc-workbench-status is-task-${task.status}`}>{t(STATUS_KEYS[task.status])}</span>
                {run?.note ? <span className="mc-workbench-muted">{run.note}</span> : null}
                {run?.resources.length ? (
                  // What this run was given: titles and content hashes as of its start,
                  // not copies of the files (X-CONCEPT-02).
                  <span
                    className="mc-workbench-muted"
                    title={run.resources
                      .map(
                        (resource) =>
                          `${resource.title} · ${resource.sha256 ? `sha256 ${resource.sha256.slice(0, 12)}…` : t("mcProject.taskRunHashMissing")}`,
                      )
                      .join("\n")}
                  >
                    {t("mcProject.taskRunBasis", { count: run.resources.length })}
                  </span>
                ) : null}
                <span className="mc-workbench-actions">
                  {task.status === "todo" || task.status === "blocked" ? (
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void start(task)}>
                      {t("mcProject.taskStart")}
                    </Button>
                  ) : null}
                  {run && task.status !== "todo" ? (
                    <Button size="sm" variant="ghost" onClick={() => void openSession(run.sessionId)}>
                      {t("mcProject.taskOpenSession")}
                    </Button>
                  ) : null}
                  {task.status === "awaitingReview" ? (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          void act(() => api.projectTasks.review(groupId, task.id, task.revision, "accepted", ""))
                        }
                      >
                        {t("mcProject.taskAccept")}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setRejectFor(task.id)}>
                        {t("mcProject.taskReject")}
                      </Button>
                    </>
                  ) : null}
                  {task.status === "todo" ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void act(() => api.projectTasks.cancel(groupId, task.id, task.revision))}
                    >
                      {t("mcProject.taskCancel")}
                    </Button>
                  ) : null}
                  {task.status === "cancelled" || task.status === "blocked" ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void act(() => api.projectTasks.reopen(groupId, task.id, task.revision))}
                    >
                      {t("mcProject.taskReopen")}
                    </Button>
                  ) : null}
                </span>
              </div>
              {rejectFor === task.id ? (
                <div className="mc-workbench-row">
                  <input
                    className="mc-workbench-description mc-workbench-link-input"
                    placeholder={t("mcProject.taskRejectPlaceholder")}
                    aria-label={t("mcProject.taskRejectPlaceholder")}
                    value={rejectNote}
                    onChange={(event) => setRejectNote(event.target.value)}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy || !rejectNote.trim()}
                    onClick={() =>
                      void act(async () => {
                        await api.projectTasks.review(groupId, task.id, task.revision, "rejected", rejectNote);
                        setRejectFor(null);
                        setRejectNote("");
                      })
                    }
                  >
                    {t("mcProject.taskRejectConfirm")}
                  </Button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
