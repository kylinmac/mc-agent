import { useChatSessionCapability } from "../hooks/use-chat-session-capability";
import { memo, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ReviewChange,
  ReviewChangeStatus,
  UiMessage,
  ReviewContextLines,
  ReviewContextResult,
} from "@pi-desktop/shared";
import { api } from "../lib/api";
import { sessionAllows } from "../lib/remote-session-safety";
import { numberedReviewHunks, reviewFilePathLabel, reviewLineNumber } from "../lib/review-history";
import { reviewChangeFromMessage } from "../lib/workspace-review";
import { useSlotSessionId } from "../plugins/renderer-slots/use-slots";
import { useAppStore } from "../stores/app-store";
import { useCopy } from "./Markdown";
import { cx } from "./ui";
import { IconCheck, IconChevronRight, IconCopy, IconSnapshot } from "./icons";
import {
  annotationLineKey,
  resolveAnnotationRootIdentity,
  useSessionDiffAnnotations,
  type DiffAnnotation,
} from "../features/review-annotations/review-annotations";
import { DiffLineAnnotationSlot } from "../features/review-annotations/ReviewAnnotationWidgets";

/* Git-status letters carry the status without relying on color alone; the
   localized word stays in the row's accessible name. */
const STATUS_MARKS: Record<ReviewChangeStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
};

export function reviewDiffText(change: Pick<ReviewChange, "hunks">): string {
  return change.hunks
    .map((hunk) =>
      [
        hunk.header,
        ...hunk.lines.map((line) =>
          `${line.type === "add" ? "+" : line.type === "del" ? "-" : " "}${line.text}`,
        ),
      ].join("\n"),
    )
    .join("\n");
}

export function ReviewChangeDetails({ message, compact = false, contextLines = 3, sessionId, annotationSessionId, root, onChanged, numbered = false, actions = true, annotatable = true }: {
  message: UiMessage; compact?: boolean; contextLines?: ReviewContextLines;
  /** Passed ONLY by `ReviewHistoryPanel` to load expanded diff context from `host-core`. */
  sessionId?: string;
  /** Owning session for inline diff annotations when `sessionId` is omitted (e.g. `LegacyReviewTab`). */
  annotationSessionId?: string;
  root?: string; onChanged?: () => void; numbered?: boolean; actions?: boolean; annotatable?: boolean;
}) {
  const { t } = useTranslation();
  const change = reviewChangeFromMessage(message);
  const localToolsAllowed = useChatSessionCapability("canUseLocalTools");
  const slotSessionId = useSlotSessionId();
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  const rollback = useAppStore((state) => state.rollbackWorkspaceChange);
  const { copied, copy } = useCopy();
  const [rollingBack, setRollingBack] = useState(false);
  const [editingTarget, setEditingTarget] = useState<{
    lineKey: string;
    side: "old" | "new";
    startLine: number | null;
    endLine: number | null;
  } | null>(null);
  const rangeAnchorRef = useRef<{ side: "old" | "new"; line: number } | null>(null);
  const targetSessionId = annotationSessionId || sessionId || slotSessionId || activeSessionId;
  const targetCanAnnotate = useAppStore((state) => {
    const id = targetSessionId;
    if (!id || id.startsWith("remote:")) return false;
    const session = state.sessions.find((item) => item.id === id);
    return sessionAllows(session, "canUseLocalTools") && sessionAllows(session, "canPrompt");
  });
  const canAnnotateCard = Boolean(annotatable && targetSessionId && targetCanAnnotate);
  const sessionAnnotations = useSessionDiffAnnotations(canAnnotateCard ? targetSessionId : null);
  const annotationsByLineKey = useMemo(() => {
    if (!change || sessionAnnotations.length === 0) return null;
    const map = new Map<string, DiffAnnotation>();
    for (const item of sessionAnnotations) {
      if (item.snapshotId === change.snapshotId) {
        map.set(item.lineKey, item);
      }
    }
    return map.size > 0 ? map : null;
  }, [sessionAnnotations, change?.snapshotId]);

  const [expanded, setExpanded] = useState<{ key: string; result?: ReviewContextResult; error?: boolean } | null>(null);
  const contextKey = `${sessionId}:${change?.snapshotId}:${contextLines}`;
  useEffect(() => {
    if (!sessionId || !change) return;
    let active = true;
    api.workspaceReviewContext({ sessionId, snapshotId: change.snapshotId, context: contextLines })
      .then(result => { if (active) setExpanded({ key: contextKey, result }); })
      .catch(() => { if (active) setExpanded({ key: contextKey, error: true }); });
    return () => { active = false; };
  }, [sessionId, change?.snapshotId, contextLines, contextKey]);
  if (!change) return null;
  const contextResult = expanded?.key === contextKey ? expanded : null;
  const pending = !!sessionId && !contextResult;
  const unavailable = contextResult?.result?.unavailable;
  const displayChange = contextResult?.result && !unavailable
    ? { ...change, hunks: contextResult.result.hunks, truncated: false } : change;
  const hunks = numberedReviewHunks(displayChange.hunks);
  const diffText = reviewDiffText(displayChange);
  const resolvedRoot = root ?? change.root;
  const rootIdentity = resolveAnnotationRootIdentity(resolvedRoot, message.parentToolCallId);

  const runRollback = async () => {
    if (!localToolsAllowed || !change.reversible || change.state === "rolledBack" || rollingBack) return;
    setRollingBack(true);
    // A conflict or an unavailable snapshot is already reported through the
    // store's toast; this card owns the rollback action only.
    const result = await rollback(message.id, change.snapshotId);
    if (result?.status === "rolledBack" || result?.status === "alreadyRolledBack") onChanged?.();
    setRollingBack(false);
  };

  return (
    <div className="review-change-card-body-content">
      {pending && <div className="review-change-note" role="status">{t("panel.review.loadingHistory")}</div>}
      {contextResult?.error && <div className="review-change-note" role="alert">{t("panel.review.contextError")}</div>}
      {unavailable && (contextLines !== 3 || change.truncated) && <div className="review-change-note" role="status">{t(`panel.review.contextUnavailable.${unavailable}`)}</div>}
      {change.binary ? (
        <div className="review-change-note">{t("panel.review.binary")}</div>
      ) : displayChange.truncated ? (
        <div className="review-change-note">{t("panel.review.tooLarge")}</div>
      ) : displayChange.hunks.length > 0 ? (
        <div className="review-change-diff">
          {hunks.map((hunk, hunkIndex) => (
            <div className="diff-hunk" key={`${hunk.header}-${hunkIndex}`}>
              <div className="diff-line hunk">
                <span className="diff-line-text">{hunk.header}</span>
              </div>
              {hunk.lines.map((line, lineIndex) => {
                const side = line.type === "del" ? "old" : "new";
                const lineNum = reviewLineNumber(line);
                const lKey = annotationLineKey(change.snapshotId, side, lineNum, hunkIndex, lineIndex);
                const existingNote = annotationsByLineKey?.get(lKey);
                const isEditingLine = editingTarget?.lineKey === lKey;
                const signChar = line.type === "add" ? "+" : line.type === "del" ? "−" : " ";
                const rangeLo =
                  editingTarget &&
                  editingTarget.side === side &&
                  editingTarget.startLine !== null &&
                  editingTarget.endLine !== null
                    ? Math.min(editingTarget.startLine, editingTarget.endLine)
                    : null;
                const rangeHi =
                  editingTarget &&
                  editingTarget.side === side &&
                  editingTarget.startLine !== null &&
                  editingTarget.endLine !== null
                    ? Math.max(editingTarget.startLine, editingTarget.endLine)
                    : null;
                const inSelectedRange =
                  lineNum !== null &&
                  rangeLo !== null &&
                  rangeHi !== null &&
                  lineNum >= rangeLo &&
                  lineNum <= rangeHi;
                const displayLabel = numbered ? (lineNum ?? "") : signChar;
                const annotateLabel = t("mcProject.diffAnnotateAdd", {
                  line: lineNum ?? lineIndex + 1,
                });
                return (
                  <div className="mc-diff-line-wrap" key={lineIndex}>
                    <div
                      className={cx(
                        "diff-line",
                        line.type,
                        canAnnotateCard && "is-annotatable",
                        Boolean(existingNote) && "has-note",
                        inSelectedRange && "is-in-range",
                      )}
                    >
                      {canAnnotateCard ? (
                        <button
                          type="button"
                          className={cx(
                            numbered ? "review-line-number" : "diff-line-sign",
                            "mc-diff-annotate-btn",
                            Boolean(existingNote) && "has-note",
                            isEditingLine && "is-editing",
                          )}
                          data-side={side}
                          aria-label={annotateLabel}
                          aria-expanded={isEditingLine}
                          onClick={(event) => {
                            if (
                              event.shiftKey &&
                              rangeAnchorRef.current &&
                              rangeAnchorRef.current.side === side &&
                              lineNum !== null
                            ) {
                              const start = Math.min(rangeAnchorRef.current.line, lineNum);
                              setEditingTarget({
                                lineKey: lKey,
                                side,
                                startLine: start === lineNum ? null : start,
                                endLine: lineNum,
                              });
                              return;
                            }
                            if (lineNum !== null) {
                              rangeAnchorRef.current = { side, line: lineNum };
                            }
                            setEditingTarget((current) =>
                              current?.lineKey === lKey
                                ? null
                                : {
                                    lineKey: lKey,
                                    side,
                                    startLine: existingNote?.startLine ?? null,
                                    endLine: lineNum,
                                  },
                            );
                          }}
                        >
                          <span className="mc-diff-gutter-text" aria-hidden="true">
                            {displayLabel}
                          </span>
                        </button>
                      ) : numbered ? (
                        <span
                          className="review-line-number"
                          data-side={side}
                          aria-label={
                            lineNum === null
                              ? undefined
                              : t(
                                  side === "old"
                                    ? "panel.review.oldLine"
                                    : "panel.review.newLine",
                                  { line: lineNum },
                                )
                          }
                        >
                          {lineNum}
                        </span>
                      ) : (
                        <span className="diff-line-sign" aria-hidden="true">
                          {signChar}
                        </span>
                      )}
                      <span className="diff-line-text">{line.text}</span>
                    </div>
                    {canAnnotateCard && targetSessionId && (isEditingLine || Boolean(existingNote)) ? (
                      <DiffLineAnnotationSlot
                        sessionId={targetSessionId}
                        snapshotId={change.snapshotId}
                        path={change.path}
                        root={resolvedRoot}
                        rootIdentity={rootIdentity}
                        lineKey={lKey}
                        side={side}
                        startLineNumber={isEditingLine ? editingTarget?.startLine : existingNote?.startLine}
                        lineNumber={lineNum}
                        lineType={line.type}
                        code={line.text}
                        noteItem={existingNote}
                        editing={isEditingLine}
                        onStartEdit={() => {
                          if (lineNum !== null) {
                            rangeAnchorRef.current = { side, line: lineNum };
                          }
                          setEditingTarget({
                            lineKey: lKey,
                            side,
                            startLine: existingNote?.startLine ?? null,
                            endLine: lineNum,
                          });
                        }}
                        onCloseEdit={() => setEditingTarget(null)}
                      />
                    ) : null}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      ) : (
        <div className="review-change-note">{t("panel.review.noLineDetails")}</div>
      )}

      {actions && <div className={cx("review-change-card-actions", compact && "is-compact")}>
        {change.state === "rolledBack" ? (
          <span className="review-change-state is-rolled-back">
            <IconCheck size={13} />
            {t("panel.review.rolledBack")}
          </span>
        ) : change.reversible && localToolsAllowed ? (
          <button
            type="button"
            className="review-change-rollback"
            onClick={() => void runRollback()}
            disabled={rollingBack}
          >
            <IconSnapshot size={13} />
            {rollingBack
              ? t("panel.review.rollingBack")
              : t("panel.review.rollback")}
          </button>
        ) : (
          <span className="review-change-rollback-note">
            {t("panel.review.rollbackUnavailable")}
          </span>
        )}
        <button
          type="button"
          className={cx("review-change-copy", copied && "copied")}
          onClick={() => copy(diffText)}
          disabled={!diffText}
          title={t("chat.copy")}
        >
          {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
          {copied ? t("chat.copied") : t("chat.copy")}
        </button>
      </div>}
    </div>
  );
}

export const ReviewChangeCard = memo(function ReviewChangeCard({
  message,
  annotationSessionId,
  compact = false,
  asToolRow = false,
  annotatable = true,
  openRequest,
}: {
  message: UiMessage;
  /** Session owning annotations when rendered outside `SlotSessionProvider` (without triggering `workspaceReviewContext`). */
  annotationSessionId?: string;
  compact?: boolean;
  /** The card is the tool-level row: one file header and its diff body. */
  asToolRow?: boolean;
  /** Disable inline diff annotations on read-only surfaces such as subagent transcripts. */
  annotatable?: boolean;
  /** Each new value expands the diff once; the user can collapse it again. */
  openRequest?: number;
}) {
  const { t } = useTranslation();
  const change = reviewChangeFromMessage(message);
  const detailsId = useId();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (openRequest !== undefined) setOpen(true);
  }, [openRequest]);

  if (!change) return null;

  const statusLabel = t(`panel.review.status.${change.status}`);
  const baseLabel = t(open ? "chat.reviewChangeHide" : "chat.reviewChangeShow", {
    status: statusLabel,
    path: change.path,
    additions: change.additions,
    deletions: change.deletions,
  });
  // The collapsed row shows a rolled-back change struck through, so the state
  // has to reach the accessible name too.
  const accessibleLabel =
    change.state === "rolledBack"
      ? `${baseLabel} · ${t("panel.review.rolledBack")}`
      : baseLabel;

  return (
    <section
      className={cx(
        "review-change-card",
        compact && "is-compact",
        asToolRow && "is-tool-row",
        open && "open",
      )}
      data-state={change.state}
      data-status={change.status}
      data-message-id={asToolRow ? message.id : undefined}
      data-snapshot-id={change.snapshotId}
    >
      <button
        type="button"
        className="review-change-card-header"
        aria-expanded={open}
        aria-controls={detailsId}
        aria-label={accessibleLabel}
        title={accessibleLabel}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="review-change-card-caret" aria-hidden>
          <IconChevronRight size={11} />
        </span>
        <span
          className={cx("review-change-card-mark", `is-${change.status}`)}
          aria-hidden
        >
          {STATUS_MARKS[change.status]}
        </span>
        <span className="review-change-card-path" data-outside-path={reviewFilePathLabel(change.path) !== change.path || undefined} title={change.path}>
          {reviewFilePathLabel(change.path)}
        </span>
        <span
          className="review-change-card-counts diff-counts"
          aria-label={t("chat.reviewChangeCounts", change)}
        >
          {change.additions > 0 && (
            <span className="diff-count-add">+{change.additions}</span>
          )}
          {change.deletions > 0 && (
            <span className="diff-count-del">−{change.deletions}</span>
          )}
        </span>
      </button>
      {open ? (
        <div className="review-change-card-body" id={detailsId}>
          <ReviewChangeDetails
            message={message}
            annotationSessionId={annotationSessionId}
            compact={compact}
            annotatable={annotatable}
          />
        </div>
      ) : null}
    </section>
  );
});
