import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { cx, portalOverlay } from "../../components/ui";
import { IconFolder, IconX } from "../../components/icons";
import type { CategoryNode } from "./creative-model";

/** "Move to…" from the context menu: one click on a category moves the images. */
export function MoveDialog({
  count,
  categories,
  current,
  onClose,
  onMove,
}: {
  count: number;
  /** Flattened tree, parents before children. */
  categories: readonly CategoryNode[];
  /** The images' shared category, if they share one ("" for uncategorized). */
  current: string | null;
  onClose: () => void;
  onMove: (category: string) => void;
}) {
  const { t } = useTranslation();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const row = (path: string, name: string, depth: number) => (
    <button
      key={path || "\u0000"}
      type="button"
      className={cx("settings-nav-item mc-creative-move-row", current === path && "active")}
      style={{ paddingLeft: 10 + depth * 14 }}
      disabled={current === path}
      onClick={() => onMove(path)}
    >
      <span className="settings-nav-icon">
        <IconFolder size={14} />
      </span>
      <span className="settings-nav-label">{name}</span>
    </button>
  );

  return portalOverlay(
    <div className="mc-creative-detail-layer" role="dialog" aria-modal="true" aria-label={t("mcProject.creativeMoveTo")}>
      <button type="button" className="mc-creative-detail-scrim" aria-label={t("mcProject.creativeClose")} onClick={onClose} />
      <div className="mc-creative-dialog mc-creative-move">
        <div className="mc-creative-detail-head">
          <h2>{t("mcProject.creativeMoveCount", { count })}</h2>
          <button type="button" className="mc-creative-icon-button" aria-label={t("mcProject.creativeClose")} onClick={onClose}>
            <IconX size={15} />
          </button>
        </div>
        <div className="mc-creative-move-list">
          {row("", t("mcProject.creativeUncategorized"), 0)}
          {categories.map((node) => row(node.path, node.name, node.path.split("/").length - 1))}
        </div>
      </div>
    </div>,
  );
}
