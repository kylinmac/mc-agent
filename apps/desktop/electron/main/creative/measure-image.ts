import { nativeImage } from "electron";
import type { FileFacts } from "./creative-generation";

/** Size and type of an image file, for the creative asset index. */
export function measureImage(path: string): FileFacts {
  const image = nativeImage.createFromPath(path);
  if (image.isEmpty()) return {};
  const { width, height } = image.getSize();
  const extension = path.split(".").pop()?.toLowerCase();
  const mime =
    extension === "png" ? "image/png"
    : extension === "jpg" || extension === "jpeg" ? "image/jpeg"
    : extension === "webp" ? "image/webp"
    : extension === "gif" ? "image/gif"
    : undefined;
  return { width, height, ...(mime ? { mime } : {}) };
}

const MAX_FULL_BYTES = 40 * 1024 * 1024;

/**
 * A data URL for one asset: scaled to `size` px on the long side (a JPEG
 * preview for grids), or the original image when `size` is 0.
 */
export function imageDataUrl(path: string, size: number): string | null {
  const image = nativeImage.createFromPath(path);
  if (image.isEmpty()) return null;
  if (size <= 0) {
    const png = image.toPNG();
    if (png.length > MAX_FULL_BYTES) return null;
    return image.toDataURL();
  }
  const { width, height } = image.getSize();
  const scale = Math.min(1, size / Math.max(width, height, 1));
  const resized = scale < 1
    ? image.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: "good" })
    : image;
  return `data:image/jpeg;base64,${resized.toJPEG(85).toString("base64")}`;
}
