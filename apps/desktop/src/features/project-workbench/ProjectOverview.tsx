import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectTask, ResourceItem, ResourceListing } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { attentionItems } from "./resource-view";

/*
  R2 project overview: the goal, resource counts and the resources that need
  attention. Counts come from the catalog listing, never from model output.
  Task counts join here when the task loop (R6–R9) lands.
*/
export function ProjectOverview({
  groupId,
  listing,
  tasks,
  onOpenResource,
  onError,
}: {
  groupId: string;
  listing: ResourceListing | null;
  tasks: readonly ProjectTask[];
  onOpenResource: (item: ResourceItem) => void;
  onError: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [goal, setGoal] = useState("");
  const [savedGoal, setSavedGoal] = useState("");

  useEffect(() => {
    let canceled = false;
    void api
      .getProjectGoal(groupId)
      .then(({ goal: loaded }) => {
        if (canceled) return;
        setGoal(loaded);
        setSavedGoal(loaded);
      })
      .catch(() => {
        // An unreadable goal shows an empty field; saving reports errors.
      });
    return () => {
      canceled = true;
    };
  }, [groupId]);

  const saveGoal = async () => {
    if (goal.trim() === savedGoal.trim()) return;
    try {
      const { goal: stored } = await api.setProjectGoal(groupId, goal);
      setGoal(stored);
      setSavedGoal(stored);
    } catch (error) {
      onError(t("mcProject.goalError", { message: error instanceof Error ? error.message : String(error) }));
      setGoal(savedGoal);
    }
  };

  const summary = listing?.summary;
  const attention = listing ? attentionItems(listing.items) : [];

  return (
    <div className="mc-workbench-overview">
      <label className="mc-workbench-label" htmlFor={`mc-goal-${groupId}`}>
        {t("mcProject.goalLabel")}
      </label>
      <input
        id={`mc-goal-${groupId}`}
        className="mc-workbench-description"
        placeholder={t("mcProject.goalPlaceholder")}
        value={goal}
        onChange={(event) => setGoal(event.target.value)}
        onBlur={() => void saveGoal()}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
      {summary ? (
        <div className="mc-workbench-row mc-workbench-summary" aria-live="polite">
          <span>{t("mcProject.summaryTotal", { count: summary.total })}</span>
          <span>{t("mcProject.summaryConfirmed", { count: summary.confirmed })}</span>
          {summary.changed > 0 ? (
            <span className="is-warning">{t("mcProject.summaryChanged", { count: summary.changed })}</span>
          ) : null}
          <span>{t("mcProject.summaryDraft", { count: summary.draft })}</span>
          {summary.missing > 0 ? (
            <span className="is-warning">{t("mcProject.summaryMissing", { count: summary.missing })}</span>
          ) : null}
        </div>
      ) : null}
      {tasks.length > 0 ? (
        <div className="mc-workbench-row mc-workbench-summary">
          {t("mcProject.summaryTasks", {
            todo: tasks.filter((task) => task.status === "todo").length,
            inProgress: tasks.filter((task) => task.status === "inProgress").length,
            awaitingReview: tasks.filter((task) => task.status === "awaitingReview").length,
            blocked: tasks.filter((task) => task.status === "blocked").length,
          })}
        </div>
      ) : null}
      {attention.length > 0 ? (
        <div className="mc-workbench-attention">
          <span className="mc-workbench-label">{t("mcProject.needsAttention")}</span>
          {attention.map((item) => (
            <button
              key={item.key}
              type="button"
              className="mc-workbench-link"
              onClick={() => onOpenResource(item)}
              disabled={item.status === "missing"}
            >
              {item.title} ·{" "}
              {item.status === "changed" ? t("mcProject.statusChanged") : t("mcProject.statusMissing")}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
