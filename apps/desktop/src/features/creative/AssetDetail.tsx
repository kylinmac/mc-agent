import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, portalOverlay } from "../../components/ui";
import { IconFolder, IconTrash, IconX } from "../../components/icons";
import { api } from "../../lib/api";
import type { CreativeAsset, CreativeJob, CreativeLinks } from "./creative-types";
import { ORIGIN_LABEL_KEYS, ROLE_LABEL_KEYS } from "./creative-model";
import { useAssetImage } from "./use-creative";

function LinkedThumb({ groupId, assetId, label, onOpen }: { groupId: string; assetId: string; label: string; onOpen: () => void }) {
  const url = useAssetImage(groupId, assetId, 160);
  return (
    <button type="button" className="mc-creative-linked" onClick={onOpen} title={label}>
      {url ? <img src={url} alt={label} draggable={false} /> : null}
      <span>{label}</span>
    </button>
  );
}

/**
 * One asset: the full image, how it was made (the generation snapshot, or the
 * script for a code drawing), what it used and what used it, and its actions.
 */
export function AssetDetail({
  groupId,
  assetId,
  onClose,
  onOpenAsset,
  onUseAsReference,
  onRegenerate,
  onAddToCompare,
  onChanged,
}: {
  groupId: string;
  assetId: string;
  onClose: () => void;
  onOpenAsset: (assetId: string) => void;
  onUseAsReference: (asset: CreativeAsset) => void;
  onRegenerate: (job: CreativeJob) => void;
  onAddToCompare: (asset: CreativeAsset) => void;
  onChanged: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [detail, setDetail] = useState<{ asset: CreativeAsset; job: CreativeJob | null; links: CreativeLinks } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const url = useAssetImage(groupId, detail?.asset.fileExists ? assetId : null, 0);

  const load = () =>
    api.creative
      .call("creative.assets.get", { groupId, assetId })
      .then(setDetail, (failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)));

  useEffect(() => {
    setDetail(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId, assetId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const act = async (method: "creative.assets.remove" | "creative.assets.restore" | "creative.assets.deleteFile") => {
    await api.creative.call(method, { groupId, assetId });
    await load();
    onChanged();
  };

  const asset = detail?.asset;
  const job = detail?.job;
  const snapshot = job?.snapshot;
  const params = snapshot?.params && Object.keys(snapshot.params).length ? snapshot.params : null;

  return portalOverlay(
    <div className="mc-creative-detail-layer" role="dialog" aria-modal="true" aria-label={t("mcProject.creativeAsset")}>
      <button type="button" className="mc-creative-detail-scrim" aria-label={t("mcProject.creativeClose")} onClick={onClose} />
      <div className="mc-creative-detail">
        <div className="mc-creative-detail-image">
          {url ? <img src={url} alt={asset?.title ?? ""} draggable={false} /> : null}
          {asset && !asset.fileExists ? <span className="mc-creative-muted">{t("mcProject.creativeFileMissing")}</span> : null}
        </div>
        <aside className="mc-creative-detail-side">
          <div className="mc-creative-detail-head">
            <span className="mc-creative-badge">
              {asset ? t(ORIGIN_LABEL_KEYS[asset.origin]) : ""}
              {asset ? ` · ${asset.category ? asset.category.split("/").join(" / ") : t("mcProject.creativeUncategorized")}` : ""}
            </span>
            <button type="button" className="mc-creative-icon-button" aria-label={t("mcProject.creativeClose")} onClick={onClose}>
              <IconX size={15} />
            </button>
          </div>
          {error ? <p className="mc-creative-error">{error}</p> : null}
          {asset ? (
            <>
              <dl className="mc-creative-facts">
                {snapshot?.prompt && job?.entry !== "code" ? (
                  <>
                    <dt>{t("mcProject.creativePrompt")}</dt>
                    <dd className="mc-creative-prompt">{snapshot.prompt}</dd>
                  </>
                ) : null}
                {job?.modelId ? (
                  <>
                    <dt>{t("mcProject.creativeModel")}</dt>
                    <dd>{job.modelId}</dd>
                  </>
                ) : null}
                {params ? (
                  <>
                    <dt>{t("mcProject.creativeParams")}</dt>
                    <dd>
                      {Object.entries(params)
                        .map(([key, value]) =>
                          key === "count"
                            ? t("mcProject.creativeParamCount", { count: Number(value) })
                            : key === "aspectRatio"
                              ? `${t("mcProject.creativeAspect")} ${String(value)}`
                              : key === "resolution"
                                ? `${t("mcProject.creativeResolution")} ${String(value).toUpperCase()}`
                              : `${key}: ${String(value)}`,
                        )
                        .join(" · ")}
                    </dd>
                  </>
                ) : null}
                {job?.entry === "code" ? (
                  <>
                    <dt>{t("mcProject.creativeCommand")}</dt>
                    <dd className="mc-creative-mono">{snapshot?.command || "—"}</dd>
                    {snapshot?.script ? (
                      <>
                        <dt>{t("mcProject.creativeScript")}</dt>
                        <dd className="mc-creative-mono">{snapshot.script.kept}</dd>
                      </>
                    ) : null}
                  </>
                ) : null}
                <dt>{t("mcProject.creativeFile")}</dt>
                <dd className="mc-creative-mono">{asset.path}</dd>
                {asset.width && asset.height ? (
                  <>
                    <dt>{t("mcProject.creativeSize")}</dt>
                    <dd>
                      {asset.width} × {asset.height}
                    </dd>
                  </>
                ) : null}
                <dt>{t("mcProject.creativeCreated")}</dt>
                <dd>{new Date(asset.createdAt).toLocaleString(i18n.language)}</dd>
              </dl>

              {detail.links.uses.length ? (
                <section className="mc-creative-detail-section">
                  <h3>{t("mcProject.creativeUses")}</h3>
                  <div className="mc-creative-linked-row">
                    {detail.links.uses.map((link) => (
                      <LinkedThumb
                        key={`${link.assetId}:${link.role}`}
                        groupId={groupId}
                        assetId={link.assetId}
                        label={`${link.position + 1} · ${t(ROLE_LABEL_KEYS[link.role] ?? ROLE_LABEL_KEYS.reference)}`}
                        onOpen={() => onOpenAsset(link.assetId)}
                      />
                    ))}
                  </div>
                </section>
              ) : null}
              {detail.links.usedBy.length ? (
                <section className="mc-creative-detail-section">
                  <h3>{t("mcProject.creativeUsedBy")}</h3>
                  <div className="mc-creative-linked-row">
                    {detail.links.usedBy.map((link) => (
                      <LinkedThumb
                        key={`${link.assetId}:${link.role}`}
                        groupId={groupId}
                        assetId={link.assetId}
                        label={t(ROLE_LABEL_KEYS[link.role] ?? ROLE_LABEL_KEYS.reference)}
                        onOpen={() => onOpenAsset(link.assetId)}
                      />
                    ))}
                  </div>
                </section>
              ) : null}

              <div className="mc-creative-detail-actions">
                <Button size="sm" variant="secondary" disabled={!asset.fileExists} onClick={() => onUseAsReference(asset)}>
                  {t("mcProject.creativeUseAsReference")}
                </Button>
                {job && job.entry !== "code" ? (
                  <Button size="sm" variant="secondary" onClick={() => onRegenerate(job)}>
                    {t("mcProject.creativeRegenerate")}
                  </Button>
                ) : null}
                <Button size="sm" variant="secondary" disabled={!asset.fileExists} onClick={() => onAddToCompare(asset)}>
                  {t("mcProject.creativeAddToCompare")}
                </Button>
                <Button size="sm" variant="secondary" disabled={!asset.fileExists} onClick={() => void api.creative.reveal(groupId, assetId)}>
                  <IconFolder size={13} />
                  {t("mcProject.creativeReveal")}
                </Button>
              </div>
              {job && job.entry !== "code" ? <p className="mc-creative-muted">{t("mcProject.creativeRegenerateHint")}</p> : null}
              <div className="mc-creative-detail-actions mc-creative-detail-danger">
                {asset.removedAt ? (
                  <Button size="sm" variant="secondary" onClick={() => void act("creative.assets.restore")}>
                    {/* The file is gone after "delete file": only the record comes back. */}
                    {t(asset.fileExists ? "mcProject.creativeRestore" : "mcProject.creativeRestoreRecordOnly")}
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => void act("creative.assets.remove").then(onClose)}>
                    {t("mcProject.creativeRemove")}
                  </Button>
                )}
                {asset.fileExists ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="mc-creative-danger"
                    onClick={() => {
                      if (!window.confirm(t("mcProject.creativeDeleteConfirm"))) return;
                      void act("creative.assets.deleteFile").then(onClose);
                    }}
                  >
                    <IconTrash size={13} />
                    {t("mcProject.creativeDeleteFile")}
                  </Button>
                ) : null}
              </div>
            </>
          ) : null}
        </aside>
      </div>
    </div>,
  );
}
