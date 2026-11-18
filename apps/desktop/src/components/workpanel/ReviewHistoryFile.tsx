import { useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReviewContextLines } from "@pi-desktop/shared";
import { reviewFilePathLabel, type ReviewFileGroup } from "../../lib/review-history";
import { ReviewChangeDetails } from "../ReviewChangeCard";
import { Button, TooltipButton, cx } from "../ui";
import { ContextMenu, useContextMenu } from "../ContextMenu";
import { useReviewFileOpen } from "../../hooks/use-review-file-open";
import { IconChat, IconCheck, IconChevronRight, IconMore } from "../icons";
import { ReviewFileIcon } from "../ReviewFileIcon";
import { ReviewFileActions } from "./ReviewFileActions";
import {
  isReviewFileViewed,
  reviewFileSignature,
  useReviewAnnotations,
  useSessionDiffAnnotations,
} from "../../features/review-annotations/review-annotations";

export function ReviewHistoryFile({ file, sessionId, context, focusSeq, focusSnapshots, expandFocus, disabled, onChanged }: {
  file: ReviewFileGroup; sessionId: string; context: ReviewContextLines;
  focusSeq?: number; focusSnapshots?: readonly string[]; expandFocus?: boolean;
  disabled: boolean; onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const menu = useContextMenu();
  const { canOpenInternal, canOpenFile, openFile, outside } = useReviewFileOpen(file, sessionId);
  const signature = useMemo(() => reviewFileSignature(file.entries), [file.entries]);
  const viewed = useReviewAnnotations((s) =>
    isReviewFileViewed(s.reviewedBySession[sessionId], file.id, signature),
  );
  const sessionNotes = useSessionDiffAnnotations(sessionId);
  const fileNoteCount = useMemo(() => {
    if (sessionNotes.length === 0) return 0;
    const snapshots = new Set(file.entries.map((entry) => entry.change.snapshotId));
    let total = 0;
    for (const item of sessionNotes) {
      if (snapshots.has(item.snapshotId)) total += 1;
    }
    return total;
  }, [sessionNotes, file.entries]);
  const pathLabel = reviewFilePathLabel(file.path);

  useEffect(() => {
    if (focusSeq && expandFocus && file.entries.some(entry => focusSnapshots?.includes(entry.change.snapshotId))) setOpen(true);
  }, [focusSeq, expandFocus, file, focusSnapshots]);
  return <section className={cx("review-history-file", open && "open", viewed && "is-viewed")} data-review-snapshots={file.entries.map(entry => entry.change.snapshotId).join(" ")}>
    <div className="review-history-file-heading">
    <Button variant="ghost" className="review-history-file-header" aria-expanded={open} aria-controls={detailsId} disabled={disabled} title={/^(?:[a-z]:[\\/]|[\\/])/i.test(file.path) || !file.root ? file.path : `${file.root}/${file.path}`} onClick={() => setOpen(value => !value)}>
      <ReviewFileIcon path={file.path} /><span className="review-file-label">
        <span className="review-change-card-path" data-outside-path={pathLabel !== file.path || undefined}>{pathLabel}</span>
        <span className="review-file-disclosure"><IconChevronRight size={11} /></span>
      </span>
      {fileNoteCount > 0 ? (
        <span className="mc-review-file-notes-badge" aria-hidden="true">
          <IconChat size={11} aria-hidden="true" />
          {fileNoteCount}
        </span>
      ) : null}
      <span className="diff-counts"><span className="diff-count-add">+{file.additions}</span><span className="diff-count-del">−{file.deletions}</span></span>
    </Button>
    <button
      type="button"
      className={cx("mc-review-viewed-btn", viewed && "is-viewed")}
      disabled={disabled}
      aria-pressed={viewed}
      aria-label={`${t("mcProject.reviewFileViewed")} · ${pathLabel}`}
      data-review-viewed={file.id}
      onClick={() => {
        const nextViewed = useReviewAnnotations
          .getState()
          .toggleFileReviewed(sessionId, file.id, signature);
        if (nextViewed) setOpen(false);
      }}
    >
      <IconCheck size={11} aria-hidden="true" />
      <span>{t("mcProject.reviewFileViewed")}</span>
    </button>
    <TooltipButton className="icon-btn review-file-menu-button" tooltip={t("panel.review.fileActions")} disabled={disabled} aria-haspopup="menu" aria-expanded={!!menu.contextMenu} onClick={event => menu.openContextMenu(event, { label: t("panel.review.fileActions"), anchor: "bottom-end", density: "compact", items: [
      ...(!outside ? [{ id: "review-open-internal", label: t("panel.review.openInternal"), disabled: !canOpenInternal, onSelect: () => void openFile("internal") }] : []),
      { id: "review-open-external", label: t("panel.review.openExternal"), disabled: !canOpenFile, onSelect: () => void openFile("external") },
      { id: "review-open-folder", label: t("panel.review.openFolder"), disabled: !canOpenFile, onSelect: () => void openFile("folder") },
    ] })}><IconMore size={14} /></TooltipButton>
    </div>
    <ContextMenu state={menu.contextMenu} onClose={menu.closeContextMenu} />
    {open && <div className="review-history-file-body" id={detailsId}>
      {file.entries.map(entry => <div className="review-history-record" key={entry.change.snapshotId} data-snapshot-id={entry.change.snapshotId}>
        <ReviewChangeDetails message={entry.message} compact numbered actions={false} sessionId={sessionId} root={file.root} contextLines={context} />
      </div>)}
      <ReviewFileActions file={file} sessionId={sessionId} context={context} disabled={disabled} onChanged={onChanged} />
    </div>}
  </section>;
}
