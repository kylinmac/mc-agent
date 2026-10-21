import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, cx, portalOverlay } from "../../components/ui";
import { IconCheck, IconX } from "../../components/icons";
import type { CreativeAsset, CreativeCategory } from "./creative-types";
import { categoryTree, flattenCategories, viewAssets, type StudioView } from "./creative-model";
import { useAssetImage } from "./use-creative";

function PickTile({ asset, order, onToggle }: { asset: CreativeAsset; order: number; onToggle: () => void }) {
  const url = useAssetImage(asset.groupId, asset.fileExists ? asset.id : null, 320);
  return (
    <button type="button" className={cx("mc-creative-pick", order > 0 && "is-selected")} onClick={onToggle} title={asset.title}>
      {url ? <img src={url} alt={asset.title} draggable={false} /> : null}
      <span className="mc-creative-pick-mark">{order > 0 ? order : <IconCheck size={11} />}</span>
    </button>
  );
}

/**
 * Pick images from the library (any category, generated or imported) as
 * references. Already chosen ones are not offered again.
 */
export function AssetPicker({
  assets,
  categories,
  exclude,
  onClose,
  onPick,
}: {
  assets: readonly CreativeAsset[];
  categories: readonly CreativeCategory[];
  exclude: readonly string[];
  onClose: () => void;
  onPick: (ids: string[]) => void;
}) {
  const { t } = useTranslation();
  const [view, setView] = useState<StudioView>({ kind: "all" });
  const [picked, setPicked] = useState<string[]>([]);
  const options = useMemo(() => flattenCategories(categoryTree(categories)), [categories]);
  const shown = useMemo(
    () => viewAssets(assets, view).filter((asset) => asset.fileExists && !exclude.includes(asset.id)),
    [assets, view, exclude],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const viewKey = view.kind === "category" ? `c:${view.path}` : view.kind;

  return portalOverlay(
    <div className="mc-creative-detail-layer" role="dialog" aria-modal="true" aria-label={t("mcProject.creativeAddReference")}>
      <button type="button" className="mc-creative-detail-scrim" aria-label={t("mcProject.creativeClose")} onClick={onClose} />
      <div className="mc-creative-dialog mc-creative-picker">
        <div className="mc-creative-detail-head">
          <h2>{t("mcProject.creativeAddReference")}</h2>
          <button type="button" className="mc-creative-icon-button" aria-label={t("mcProject.creativeClose")} onClick={onClose}>
            <IconX size={15} />
          </button>
        </div>
        <select
          className="mc-creative-select"
          value={viewKey}
          aria-label={t("mcProject.creativeCategories")}
          onChange={(event) => {
            const value = event.target.value;
            setView(
              value === "all"
                ? { kind: "all" }
                : value === "uncategorized"
                  ? { kind: "uncategorized" }
                  : { kind: "category", path: value.slice(2) },
            );
          }}
        >
          <option value="all">{t("mcProject.creativeViewAll")}</option>
          <option value="uncategorized">{t("mcProject.creativeUncategorized")}</option>
          {options.map((node) => (
            <option key={node.path} value={`c:${node.path}`}>
              {"　".repeat(node.path.split("/").length - 1)}
              {node.name}
            </option>
          ))}
        </select>
        <div className="mc-creative-pick-grid">
          {shown.length ? (
            shown.map((asset) => (
              <PickTile
                key={asset.id}
                asset={asset}
                order={picked.indexOf(asset.id) + 1}
                onToggle={() =>
                  setPicked((current) =>
                    current.includes(asset.id) ? current.filter((id) => id !== asset.id) : [...current, asset.id],
                  )
                }
              />
            ))
          ) : (
            <p className="mc-creative-muted">{t("mcProject.creativeNothingHere")}</p>
          )}
        </div>
        <div className="mc-creative-dialog-actions">
          <Button variant="ghost" onClick={onClose}>
            {t("mcProject.creativeCancel")}
          </Button>
          <Button variant="primary" disabled={!picked.length} onClick={() => onPick(picked)}>
            {t("mcProject.creativeAddReferences", { count: picked.length })}
          </Button>
        </div>
      </div>
    </div>,
  );
}
