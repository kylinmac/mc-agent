import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Textarea } from "../../components/ui";
import { useAppStore } from "../../stores/app-store";
import { usePanePrefs } from "../work-tools/pane-layout";
import {
  isSessionAwaitingPlanApproval,
  sendBatchAnnotationsToSession,
  useReviewAnnotations,
  useSessionDiffAnnotations,
  type DiffAnnotation,
} from "./review-annotations";

export function ReviewBatchBar({ sessionId }: { sessionId?: string | null }) {
  const { t } = useTranslation();
  const items = useSessionDiffAnnotations(sessionId);
  const clear = useReviewAnnotations((s) => s.clear);
  const sending = useReviewAnnotations((s) =>
    Boolean(sessionId && s.sendingBySession[sessionId]),
  );
  const showToast = useAppStore((s) => s.showToast);
  const busy = useAppStore((s) =>
    sessionId
      ? s.runningSessions[sessionId] === true || (s.activeSessionId === sessionId && s.isRunning)
      : false,
  );
  const approvalPending = useAppStore((s) =>
    isSessionAwaitingPlanApproval(s, sessionId),
  );

  if (!sessionId || items.length === 0) return null;

  const sendAll = async () => {
    if (sending) return;
    const result = await sendBatchAnnotationsToSession(
      sessionId,
      t("mcProject.diffAnnotatePromptIntro"),
    );
    if (result.sent) {
      showToast(t("mcProject.diffAnnotateSentToast", { count: result.count }), {
        variant: "success",
      });
    } else if (result.blockedReason === "plan_pending") {
      showToast(t("mcProject.diffAnnotateAwaitPlan"), {
        variant: "info",
      });
    }
  };

  return (
    <div className="mc-review-batch-bar" role="region" aria-label={t("mcProject.diffAnnotateBatchCount", { count: items.length })}>
      <div className="mc-review-batch-meta">
        <span className="mc-review-batch-count">
          {t("mcProject.diffAnnotateBatchCount", { count: items.length })}
        </span>
        {approvalPending ? (
          <span className="mc-review-batch-hint" role="status">
            {t("mcProject.diffAnnotateAwaitPlan")}
          </span>
        ) : null}
      </div>
      <div className="mc-review-batch-actions">
        <Button
          size="sm"
          variant="ghost"
          disabled={sending}
          onClick={() => clear(sessionId)}
        >
          {t("mcProject.diffAnnotateClearAll")}
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={sending || approvalPending}
          title={approvalPending ? t("mcProject.diffAnnotateAwaitPlan") : undefined}
          onClick={() => void sendAll()}
        >
          {busy ? t("mcProject.diffAnnotateQueueBatch") : t("mcProject.diffAnnotateSendBatch")}
        </Button>
      </div>
    </div>
  );
}

/**
 * Conversation-level batch bar mounted above the composer in single-pane chat
 * and each split column, so inline Diff annotations created inside the chat
 * transcript can always be sent or cleared even when the WorkPanel is closed,
 * parked on Terminal/Files/Browser, or owned by another split column. Hidden
 * when the active session's expanded Review pane is already displaying one.
 */
export function ChatReviewBatchDock({ sessionId }: { sessionId?: string | null }) {
  const items = useSessionDiffAnnotations(sessionId);
  const prefs = usePanePrefs();
  const reviewPaneVisibleForSession = useAppStore((s) =>
    Boolean(
      sessionId &&
        s.activeSessionId === sessionId &&
        s.workPanelOpen &&
        s.workPanelTabs.some((tab) => tab.kind === "review") &&
        !prefs.collapsed.includes("review"),
    ),
  );
  if (!sessionId || items.length === 0 || reviewPaneVisibleForSession) return null;
  return (
    <div className="mc-chat-review-batch-dock" data-review-batch-session={sessionId}>
      <ReviewBatchBar sessionId={sessionId} />
    </div>
  );
}

export function DiffLineAnnotationSlot({
  sessionId,
  snapshotId,
  path,
  root,
  rootIdentity,
  lineKey,
  side,
  startLineNumber,
  lineNumber,
  lineType,
  code,
  noteItem,
  editing,
  onStartEdit,
  onCloseEdit,
}: {
  sessionId: string;
  snapshotId: string;
  path: string;
  root?: string;
  rootIdentity?: string;
  lineKey: string;
  side: "old" | "new";
  startLineNumber?: number | null;
  lineNumber: number | null;
  lineType: "add" | "del" | "context";
  code: string;
  noteItem?: DiffAnnotation;
  editing: boolean;
  onStartEdit: () => void;
  onCloseEdit: () => void;
}) {
  const { t } = useTranslation();
  const upsert = useReviewAnnotations((s) => s.upsert);
  const remove = useReviewAnnotations((s) => s.remove);
  const [draft, setDraft] = useState(noteItem?.note ?? "");
  const wasEditingRef = useRef(false);
  const prevLineKeyRef = useRef(lineKey);
  const platform =
    (typeof window === "undefined" ? undefined : window.piDesktop?.platform) ?? "darwin";
  const saveShortcut = platform === "darwin" ? "⌘↩" : "Ctrl+Enter";

  useEffect(() => {
    const opened = editing && !wasEditingRef.current;
    const switchedLine = editing && prevLineKeyRef.current !== lineKey;
    wasEditingRef.current = editing;
    prevLineKeyRef.current = lineKey;
    if (opened || switchedLine) {
      setDraft(noteItem?.note ?? "");
    }
  }, [editing, lineKey, noteItem?.note]);

  if (!editing && !noteItem) return null;

  const commit = () => {
    const trimmed = draft.trim();
    if (!trimmed) {
      if (noteItem) remove(sessionId, noteItem.id);
      onCloseEdit();
      return;
    }
    const resolvedStart =
      startLineNumber !== undefined ? startLineNumber : (noteItem?.startLine ?? null);
    upsert({
      id: noteItem?.id,
      lineKey,
      sessionId,
      snapshotId,
      path,
      root,
      rootIdentity,
      side,
      startLine: resolvedStart,
      line: lineNumber,
      lineType,
      code,
      note: trimmed,
    });
    onCloseEdit();
  };

  const activeStart =
    startLineNumber !== undefined ? startLineNumber : (noteItem?.startLine ?? null);
  const rangeBadge =
    lineNumber !== null
      ? activeStart !== null && activeStart !== lineNumber
        ? `L${Math.min(activeStart, lineNumber)}–L${Math.max(activeStart, lineNumber)}`
        : `L${lineNumber}`
      : null;

  if (editing) {
    return (
      <div className="mc-diff-annotation-editor">
        {rangeBadge ? (
          <div className="mc-diff-annotation-editor-head">
            <span className="mc-diff-annotation-line-pill">
              {side === "old" ? `old ${rangeBadge}` : rangeBadge}
            </span>
          </div>
        ) : null}
        <Textarea
          autoFocus
          rows={2}
          className="mc-diff-annotation-input"
          value={draft}
          placeholder={t("mcProject.diffAnnotatePlaceholder", { shortcut: saveShortcut })}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              commit();
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onCloseEdit();
            }
          }}
        />
        <div className="mc-diff-annotation-editor-actions">
          <Button size="sm" variant="ghost" onClick={onCloseEdit}>
            {t("mcProject.diffAnnotateCancel")}
          </Button>
          <Button size="sm" variant="primary" disabled={!draft.trim()} onClick={commit}>
            {t("mcProject.diffAnnotateSave")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mc-diff-annotation-card">
      <div className="mc-diff-annotation-card-body">
        {rangeBadge && activeStart !== null && lineNumber !== null && activeStart !== lineNumber ? (
          <span className="mc-diff-annotation-line-pill">
            {side === "old" ? `old ${rangeBadge}` : rangeBadge}
          </span>
        ) : null}
        <span className="mc-diff-annotation-text">{noteItem?.note}</span>
      </div>
      <div className="mc-diff-annotation-card-actions">
        <Button size="sm" variant="ghost" onClick={onStartEdit}>
          {t("mcProject.diffAnnotateEdit")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            if (noteItem) remove(sessionId, noteItem.id);
          }}
        >
          {t("mcProject.diffAnnotateDelete")}
        </Button>
      </div>
    </div>
  );
}
