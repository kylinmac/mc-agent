import type { ReviewContextLines } from "@pi-desktop/shared";
import { useTranslation } from "react-i18next";
import { ContextMenu, useContextMenu } from "../ContextMenu";
import { Select, TooltipButton, cx } from "../ui";
import { IconChat, IconCheck, IconMore } from "../icons";

export function ReviewHistoryToolbar({
  history,
  onHistory,
  count,
  additions,
  deletions,
  context,
  onContext,
  wrap,
  onWrap,
  reviewedCount,
  showAnnotateHint = false,
}: {
  history: boolean; onHistory: (history: boolean) => void;
  count: number; additions: number; deletions: number;
  context: ReviewContextLines; onContext: (context: ReviewContextLines) => void;
  wrap: boolean; onWrap: () => void;
  reviewedCount?: number;
  showAnnotateHint?: boolean;
}) {
  const { t } = useTranslation();
  const settingsMenu = useContextMenu();
  const allReviewed = reviewedCount !== undefined && count > 0 && reviewedCount >= count;
  return <>
    <div className="review-toolbar review-round-toolbar">
      <Select className="review-select review-round-scope" aria-label={t("panel.review.reviewScope")} value={history ? "history" : "last"}
        onChange={event => { settingsMenu.closeContextMenu(); onHistory(event.target.value === "history"); }}>
        <option value="last">{t("panel.review.previousRound")}</option>
        <option value="history">{t("panel.review.historyMode")}</option>
      </Select>
      <span className="review-summary">{t("chat.toolChipFiles", { count })}</span>
      {reviewedCount !== undefined && count > 0 ? (
        <span
          className={cx("mc-review-progress-pill", allReviewed && "is-complete")}
          data-review-progress={`${reviewedCount}/${count}`}
        >
          {allReviewed ? <IconCheck size={11} aria-hidden="true" /> : null}
          {t("mcProject.reviewProgress", { reviewed: reviewedCount, total: count })}
        </span>
      ) : null}
      {showAnnotateHint && count > 0 ? (
        <span className="mc-review-toolbar-hint">
          <IconChat size={11} aria-hidden="true" />
          <span>{t("mcProject.diffAnnotateToolbarHint")}</span>
        </span>
      ) : null}
      <span className="diff-counts review-toolbar-counts" aria-label={t("chat.reviewChangeCounts", { additions, deletions })}>
        <span className="diff-count-add">+{additions}</span><span className="diff-count-del">−{deletions}</span>
      </span>
      <TooltipButton className="icon-btn review-settings-button" tooltip={t("panel.review.reviewSettings")} aria-haspopup="menu" aria-expanded={!!settingsMenu.contextMenu} onClick={event => {
        settingsMenu.openContextMenu(event, { label: t("panel.review.reviewSettings"), anchor: "bottom-end", items: [
          { id: "review-wrap", label: t("panel.review.wordWrap"), checked: wrap, onSelect: onWrap },
          { id: "review-context", label: t("panel.review.contextDisplay"), submenu: ([1, 3, 5] as const).map(lines => ({
            id: `review-context-${lines}`, label: t("panel.review.contextLineOption", { count: lines }), checked: context === lines, onSelect: () => onContext(lines),
          })) },
        ] });
      }}><IconMore size={16} /></TooltipButton>
    </div>
    <ContextMenu state={settingsMenu.contextMenu} onClose={settingsMenu.closeContextMenu} />
  </>;
}
