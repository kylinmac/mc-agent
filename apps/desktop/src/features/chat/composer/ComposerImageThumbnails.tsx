import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, TooltipButton } from "../../../components/ui";
import { IconClose } from "../../../components/icons";
import type { ComposerImagePreviewController, ComposerImageSource } from "./hooks/useComposerImagePreview";
import type { ComposerFileReference } from "./model";
import "../../../styles/composer-image-thumbnails.css";

/** Visible previews share the authorized image reads and modal with inline chips. */
export function ComposerImageThumbnails({ controller, onRemove, disabled = false }: {
  controller: ComposerImagePreviewController;
  onRemove?: (id: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  if (!controller.images.length) return null;
  return <div className="composer-image-thumbnails" role="group" aria-label={t("chat.imagePreview.title")}>
    {controller.images.map((reference) => <ImageThumbnail
      key={reference.id}
      reference={reference}
      source={controller.sources?.get(reference.id)}
      open={() => controller.open(reference)}
      retry={controller.retry}
      remove={onRemove ? () => onRemove(reference.id) : undefined}
      disabled={disabled}
    />)}
  </div>;
}

function ImageThumbnail({ reference, source, open, retry, remove, disabled }: {
  reference: ComposerFileReference;
  source?: ComposerImageSource;
  open: () => void;
  retry: () => void;
  remove?: () => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const failed = source?.status === "error" || (source?.src != null && failedSource === source.src);
  return <div className="composer-image-thumbnail">
    <Button
      type="button"
      variant="ghost"
      className="composer-image-thumbnail-open"
      aria-label={`${t("chat.imagePreview.title")}: ${reference.name}`}
      title={reference.name}
      onClick={failed ? () => { setFailedSource(null); retry(); } : open}
    >
      {failed ? <span role="status">{t("chat.imagePreview.error")} · {t("chat.imagePreview.retry")}</span>
        : source?.status === "ready" ? <img src={source.src} alt={reference.name} draggable={false} onError={() => setFailedSource(source.src)} />
          : <span role="status">{t("common.loading")}</span>}
    </Button>
    <span className="composer-image-thumbnail-name" title={reference.name}>{reference.name}</span>
    {remove ? <TooltipButton
      type="button"
      className="composer-image-thumbnail-remove"
      tooltip={t("chat.removeFileReference", { name: reference.name })}
      disabled={disabled}
      onClick={remove}
    ><IconClose size={12} /></TooltipButton> : null}
  </div>;
}
