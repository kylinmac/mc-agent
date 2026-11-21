import type { Result } from "../errors.js";
import type { IPC } from "../protocol.js";

/** The main window's preload API. Optional capabilities can be absent in older bridges. */
export interface DesktopPreloadBridge {
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<Result<T>>;
  on(channel: string, listener: (...args: unknown[]) => void): () => void;
  onLiveVoicePort?: () => () => void;
  channels: typeof IPC;
  platform: NodeJS.Platform;
  locale?: string;
  getDroppedFilePath?: (file: File) => string | null;
}
