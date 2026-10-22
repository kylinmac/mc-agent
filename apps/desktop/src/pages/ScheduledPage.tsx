import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ScheduledTask, ScheduledTaskRun } from "@pi-desktop/shared";
import { useAppStore } from "../stores/app-store";
import { Button, Panel, cx } from "../components/ui";
import {
  IconBookOpen,
  IconChevronLeft,
  IconCircleAlert,
  IconClock,
  IconDiff,
  IconDot,
  IconFileText,
  IconListChecks,
  IconPlus,
  IconSearch,
  IconShield,
  IconSparkles,
} from "../components/icons";
import { IntoSidebarSlot } from "../features/sidebar-slot/SidebarSlot";
import { ScheduledEditor, type ScheduledDraft } from "../features/scheduled/ScheduledEditor";
import { ScheduledTaskDetail } from "../features/scheduled/ScheduledTaskDetail";
import { useScheduledWorkspace } from "../features/scheduled/use-scheduled-workspace";
import { peekScheduledReturn, rememberScheduledReturn } from "../features/scheduled/scheduled-return";
import { formatScheduleClock } from "../features/scheduled/scheduled-format";
import { cadenceHasClock, cadenceLabel } from "../features/scheduled/scheduled-labels";
import {
  SCHEDULED_TEMPLATES,
  templateWhen,
  type ScheduledTemplate,
  type ScheduledTemplateIcon,
} from "../features/scheduled/scheduled-templates";
import "../features/scheduled/scheduled-workspace.css";

/**
 * Scheduled workspace: a task column and the selected task's page. Each task
 * reports its own last outcome and next occurrence, its runs are readable in
 * place, and the conversation stays one explicit action away — the automation's
 * transcripts live here rather than in the sidebar's project groups.
 *
 * mc-agent: the task column lives in the app sidebar (like settings and
 * extensions), and the page opens on an overview with templates; a template
 * only fills the task form.
 */

const TEMPLATE_ICONS: Record<ScheduledTemplateIcon, typeof IconClock> = {
  digest: IconDiff,
  tests: IconListChecks,
  deps: IconShield,
  review: IconBookOpen,
  todo: IconSparkles,
  docs: IconFileText,
};

type EditorState =
  | { kind: "edit"; task: ScheduledTask }
  | { kind: "new"; template?: ScheduledTemplate };

function TaskStatus({ task, latest }: { task: ScheduledTask; latest: ScheduledTaskRun | null }) {
  if (latest?.status === "running") {
    return (
      <span className="mc-sched-status is-running" aria-hidden>
        <IconDot size={10} />
      </span>
    );
  }
  if (latest?.status === "error") {
    return (
      <span className="mc-sched-status is-error" aria-hidden>
        <IconCircleAlert size={12} />
      </span>
    );
  }
  return task.enabled ? null : <span className="mc-sched-status is-paused" aria-hidden />;
}

export function ScheduledPage() {
  const { t, i18n } = useTranslation();
  const showToast = useAppStore((s) => s.showToast);
  const selectSession = useAppStore((s) => s.selectSession);
  const setPage = useAppStore((s) => s.setPage);
  const currentWorkspacePath = useAppStore((s) => s.workspace?.path ?? "");
  const providers = useAppStore((s) => s.providers);
  const [editor, setEditor] = useState<EditorState | null>(null);
  // The overview is the landing view, except when a run's conversation hands
  // the reader back to the task it came from.
  const [overview, setOverview] = useState(() => !peekScheduledReturn());
  const [query, setQuery] = useState("");
  const workspace = useScheduledWorkspace((message) => showToast(message, { variant: "error" }));
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const { tasks, projects, selectedTask, selectedTaskId, runs, latestRuns, selectedRunId, busy, loaded, error } =
    workspace;

  // Remember where the reader came from: the conversation offers the way back,
  // and this page restores the same task and the same run.
  const openSession = async (sessionId: string, runId: string) => {
    if (selectedTask) {
      rememberScheduledReturn({
        taskId: selectedTask.id,
        taskTitle: selectedTask.title,
        runId,
        sessionId,
      });
    }
    await selectSession(sessionId);
    setPage("chat");
  };
  const save = async (draft: ScheduledDraft) => {
    const saved = await workspace.saveTask(editor?.kind === "edit" ? editor.task.id : null, draft);
    if (saved) {
      setEditor(null);
      setOverview(false);
    }
  };
  const remove = (task: ScheduledTask) => {
    if (!window.confirm(t("scheduled.deleteConfirm", { title: task.title }))) return;
    if (editor?.kind === "edit" && editor.task.id === task.id) setEditor(null);
    void workspace.deleteTask(task.id);
  };
  const openTask = (taskId: string) => {
    setEditor(null);
    setOverview(false);
    workspace.selectTask(taskId);
  };
  const startNew = (template?: ScheduledTemplate) => setEditor({ kind: "new", template });
  // Relative labels are recomputed on every render, and the poll re-renders at
  // least every ten seconds, so a row never reports a stale "in 2 minutes".
  const now = Date.now();

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return tasks;
    return tasks.filter(
      (task) => task.title.toLowerCase().includes(needle) || task.prompt.toLowerCase().includes(needle),
    );
  }, [tasks, query]);
  const showOverview = overview || tasks.length === 0;

  const sidebar = (
    <IntoSidebarSlot>
      <aside className="settings-nav sidebar-surface mc-sched-nav" aria-label={t("scheduled.title")}>
        <div className="settings-nav-top drag">
          <div className="settings-search-wrap no-drag">
            <IconSearch size={14} />
            <input
              className="settings-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("mcProject.schedSearch")}
              aria-label={t("mcProject.schedSearch")}
              spellCheck={false}
            />
          </div>
        </div>
        <div className="settings-nav-scroll no-drag">
          <div className="settings-nav-group">
            <button
              type="button"
              className={cx("settings-nav-item", showOverview && !editor && "active")}
              onClick={() => {
                setEditor(null);
                setOverview(true);
              }}
            >
              <span className="settings-nav-icon">
                <IconSparkles size={14} />
              </span>
              <span className="settings-nav-label">{t("mcProject.schedNavOverview")}</span>
            </button>
            <button
              type="button"
              className={cx("settings-nav-item", editor?.kind === "new" && "active")}
              disabled={busy}
              onClick={() => startNew()}
            >
              <span className="settings-nav-icon">
                <IconPlus size={14} />
              </span>
              <span className="settings-nav-label">{t("mcProject.schedNavNew")}</span>
            </button>
          </div>
          <div className="settings-nav-group">
            <div className="settings-nav-group-label">
              {t("mcProject.schedNavYours")} · {tasks.length}
            </div>
            {filtered.map((task) => {
              const latest = latestRuns.get(task.id) ?? null;
              const clock = cadenceHasClock(task.cadence) ? formatScheduleClock(task.schedule) : null;
              const cadence = cadenceLabel(t, task, i18n.language);
              const active =
                !showOverview && task.id === selectedTaskId && (!editor || editor.kind === "edit");
              return (
                <button
                  key={task.id}
                  type="button"
                  className={cx("settings-nav-item mc-sched-nav-task", active && "active", !task.enabled && "is-off")}
                  aria-current={active ? "true" : undefined}
                  onClick={() => openTask(task.id)}
                >
                  <span className="mc-sched-nav-copy">
                    <span className="mc-sched-nav-name">
                      {task.title}
                      <TaskStatus task={task} latest={latest} />
                    </span>
                    <span className="mc-sched-nav-meta">
                      {!task.enabled
                        ? t("scheduled.disabled")
                        : clock
                          ? `${cadence} · ${clock}`
                          : cadence}
                    </span>
                  </span>
                </button>
              );
            })}
            {tasks.length > 0 && filtered.length === 0 ? (
              <div className="mc-sched-nav-empty">{t("mcProject.schedNoMatches")}</div>
            ) : null}
          </div>
        </div>
        <div className="settings-nav-footer">
          <button type="button" className="settings-back no-drag" onClick={() => setPage("chat")}>
            <IconChevronLeft size={15} />
            <span>{t("settings.backToApp")}</span>
          </button>
        </div>
      </aside>
    </IntoSidebarSlot>
  );

  return (
    <div className="route-scroll">
      {sidebar}
      <div className="page-frame scheduled-frame mc-slot-page">
        {error && (
          <Panel className="scheduled-error">
            <p role="alert">{error}</p>
            <Button onClick={() => void workspace.refresh()}>{t("scheduled.retry")}</Button>
          </Panel>
        )}
        {!loaded && !error && <p role="status">{t("common.loading")}</p>}

        {editor && (
          <div className="scheduled-editor-slot">
            <ScheduledEditor
              key={editor.kind === "edit" ? editor.task.id : `new:${editor.template?.id ?? ""}`}
              task={editor.kind === "edit" ? editor.task : undefined}
              seed={
                editor.kind === "new" && editor.template
                  ? {
                      title: t(`mcProject.${editor.template.titleKey}`),
                      prompt: t(`mcProject.${editor.template.promptKey}`),
                      cadence: editor.template.cadence,
                      schedule: editor.template.schedule,
                    }
                  : undefined
              }
              projects={projects}
              currentWorkspacePath={currentWorkspacePath}
              busy={busy}
              save={save}
              cancel={() => setEditor(null)}
            />
          </div>
        )}

        {loaded && showOverview && !editor ? (
          <div className="mc-sched-overview">
            <div className="page-header">
              <div>
                <h1 className="page-title">{t("scheduled.title")}</h1>
                <p className="dest-row-meta">{t("scheduled.description")}</p>
              </div>
              <Button variant="primary" disabled={busy} onClick={() => startNew()}>
                <IconPlus size={14} />
                {t("scheduled.create")}
              </Button>
            </div>

            {tasks.length === 0 ? (
              <div className="mc-sched-empty">
                <span className="mc-sched-empty-icon" aria-hidden>
                  <IconClock size={28} />
                </span>
                <p>{t("mcProject.schedEmpty")}</p>
                <Button variant="secondary" disabled={busy} onClick={() => startNew()}>
                  {t("mcProject.schedSetUpManually")}
                </Button>
              </div>
            ) : null}

            <section className="mc-sched-templates">
              <div className="mc-sched-templates-head">
                <h2>{t("mcProject.schedTemplates")}</h2>
                <p>{t("mcProject.schedTemplatesHint")}</p>
              </div>
              <div className="mc-sched-template-grid">
                {SCHEDULED_TEMPLATES.map((template) => {
                  const Icon = TEMPLATE_ICONS[template.icon];
                  return (
                    <button
                      key={template.id}
                      type="button"
                      className="mc-sched-template"
                      disabled={busy}
                      onClick={() => startNew(template)}
                    >
                      <span className="mc-sched-template-icon" aria-hidden>
                        <Icon size={16} />
                      </span>
                      <span className="mc-sched-template-copy">
                        <span className="mc-sched-template-title">{t(`mcProject.${template.titleKey}`)}</span>
                        <span className="mc-sched-template-desc">{t(`mcProject.${template.descriptionKey}`)}</span>
                        <span className="mc-sched-template-when">
                          <IconClock size={12} />
                          {templateWhen(template, t, locale)}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          </div>
        ) : null}

        {/* The form owns the page while it is open: the task column and the
            selected task's page would only compete with the draft. */}
        {loaded && tasks.length > 0 && !editor ? (
          showOverview ? null : selectedTask ? (
            <ScheduledTaskDetail
              task={selectedTask}
              runs={runs}
              selectedRunId={selectedRunId}
              running={workspace.taskIsRunning(selectedTask.id)}
              busy={busy}
              now={now}
              locale={locale}
              onSelectRun={workspace.selectRun}
              onOpenSession={(sessionId, runId) => void openSession(sessionId, runId)}
              onRunNow={() => void workspace.runTaskNow(selectedTask.id)}
              onEdit={() => setEditor({ kind: "edit", task: selectedTask })}
              onToggleEnabled={() => void workspace.toggleTask(selectedTask.id, !selectedTask.enabled)}
              onDelete={() => remove(selectedTask)}
              providerName={providers.find((item) => item.id === selectedTask.providerId)?.name ?? null}
            />
          ) : (
            <Panel className="page-card page-empty">
              <p className="dest-row-meta">{t("scheduled.selectTask")}</p>
            </Panel>
          )
        ) : null}
      </div>
    </div>
  );
}
