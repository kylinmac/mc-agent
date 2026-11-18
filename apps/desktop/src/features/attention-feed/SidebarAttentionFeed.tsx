import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, cx } from "../../components/ui";
import { useAppStore } from "../../stores/app-store";
import { useProjectFolderIndex } from "../project-sidebar/useProjectFolderIndex";
import {
  DEFAULT_ATTENTION_LIMIT,
  buildAttentionItems,
  visibleAttentionSlice,
  type AttentionKind,
} from "./attention-model";
import { acknowledgeAllAttentionUnread, useAttentionStore } from "./attention-store";

export function SidebarAttentionFeed() {
  const { t } = useTranslation();
  const page = useAppStore((s) => s.page);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const isRunning = useAppStore((s) => s.isRunning);
  const runningSessions = useAppStore((s) => s.runningSessions);
  const pendingPermissions = useAppStore((s) => s.pendingPermissions);
  const pendingAsks = useAppStore((s) => s.pendingAsks);
  const pendingPlans = useAppStore((s) => s.pendingPlans);
  const planCheckpoints = useAppStore((s) => s.planCheckpoints);
  const planningStates = useAppStore((s) => s.planningStates);
  const sessions = useAppStore((s) => s.sessions);
  const openProjectPaths = useAppStore((s) => s.openProjectPaths);
  const projectMeta = useAppStore((s) => s.projectMeta);
  const selectSession = useAppStore((s) => s.selectSession);
  const showToast = useAppStore((s) => s.showToast);
  const unreadCompleted = useAttentionStore((s) => s.unreadCompleted);
  const [expanded, setExpanded] = useState(false);
  const { index: projectFolderIndex } = useProjectFolderIndex(
    `${openProjectPaths.join("\n")}|${sessions.length}`,
  );

  const allItems = useMemo(
    () =>
      buildAttentionItems({
        sessions,
        runningSessions,
        activeSessionId,
        isRunning,
        pendingPermissions,
        pendingAsks,
        pendingPlans,
        planCheckpoints,
        planningStates,
        unreadCompleted,
        projectMeta,
        projectFolderIndex,
        untitledLabel: t("chat.untitledTask"),
      }),
    [
      sessions,
      runningSessions,
      activeSessionId,
      isRunning,
      pendingPermissions,
      pendingAsks,
      pendingPlans,
      planCheckpoints,
      planningStates,
      unreadCompleted,
      projectMeta,
      projectFolderIndex,
      t,
    ],
  );

  useEffect(() => {
    if (allItems.length <= DEFAULT_ATTENTION_LIMIT && expanded) {
      setExpanded(false);
    }
  }, [allItems.length, expanded]);

  if (allItems.length === 0) return null;

  const { visibleItems, totalCount, hiddenCount } = visibleAttentionSlice(
    allItems,
    expanded,
    DEFAULT_ATTENTION_LIMIT,
  );
  const hasUnread = allItems.some((item) => item.kind === "completed");
  const openAttentionSession = async (sessionId: string) => {
    try {
      const current = useAppStore.getState();
      if (current.activeSessionId === sessionId && !current.selectingSessionId) {
        if (current.page !== "chat") current.setPage("chat");
        return;
      }
      await selectSession(sessionId);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    }
  };
  const statusLabel = (kind: AttentionKind) =>
    kind === "needs_action"
      ? t("mcProject.attentionNeedsAction")
      : kind === "running"
        ? t("mcProject.attentionRunning")
        : t("mcProject.attentionCompleted");

  return (
    <section
      className="mc-attention-feed"
      aria-label={t("mcProject.attentionFeedTitle")}
      data-sidebar-section="attention"
    >
      <div className="mc-attention-head">
        <span className="mc-attention-title">
          {t("mcProject.attentionFeedTitle")}
          <span className="mc-attention-count">{totalCount}</span>
        </span>
        {hasUnread ? (
          <Button
            size="sm"
            variant="ghost"
            className="mc-attention-clear"
            onClick={acknowledgeAllAttentionUnread}
          >
            {t("mcProject.attentionClearUnread")}
          </Button>
        ) : null}
      </div>
      <div className={cx("mc-attention-list", expanded && "is-expanded")}>
        {visibleItems.map((item) => {
          const isCurrent = page === "chat" && activeSessionId === item.sessionId;
          return (
            <button
              key={item.sessionId}
              type="button"
              className={cx("mc-attention-row", `is-${item.kind}`, isCurrent && "is-current")}
              data-attention-session={item.sessionId}
              data-attention-kind={item.kind}
              onClick={() => void openAttentionSession(item.sessionId)}
            >
              <span className={cx("mc-attention-dot", `is-${item.kind}`)} aria-hidden />
              <span className="mc-attention-main">
                <span className="mc-attention-item-title">{item.title}</span>
                {item.projectLabel ? (
                  <span className="mc-attention-project">{item.projectLabel}</span>
                ) : null}
              </span>
              <span className={cx("mc-attention-badge", `is-${item.kind}`)}>
                {statusLabel(item.kind)}
              </span>
            </button>
          );
        })}
      </div>
      {totalCount > DEFAULT_ATTENTION_LIMIT ? (
        <Button
          size="sm"
          variant="ghost"
          className="mc-attention-more"
          data-attention-toggle-more
          aria-expanded={expanded}
          onClick={() => setExpanded((prev) => !prev)}
        >
          {expanded
            ? t("mcProject.attentionShowLess")
            : t("mcProject.attentionShowMore", { count: hiddenCount })}
        </Button>
      ) : null}
    </section>
  );
}
