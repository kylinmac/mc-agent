import type { PluginFsPolicy, PluginManifest } from "@pi-desktop/plugin-sdk";
import type { PluginProcessHandle } from "./plugin-host-contracts";
import { apiError } from "./plugin-host-errors";

type PendingCall = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type LoadedPlugin = {
  manifest: PluginManifest;
  runtimeId: string;
  path: string;
  development: boolean;
  permissions: Set<string>;
  /** Effective file scope, after legacy permission names are folded in. */
  fsPolicy: PluginFsPolicy;
  /** Legacy fs permission names this plugin still declares, for the UI notice. */
  legacyFs: string[];
  /** Directory the user picked for this plugin's `userSelected` root, if any. */
  userRoot?: string;
  /** Timestamps of recent deletes, backing the rate brake. */
  deletes: number[];
  /** Memory-only grants created by a real panel drop gesture. */
  dropGrants: Map<string, { fullPath: string; requestPath: string }>;
  child?: PluginProcessHandle;
  pending: Map<string, PendingCall>;
  nextCallId: number;
  disposing: boolean;
};

export function sendToChild(
  loaded: LoadedPlugin,
  message: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const child = loaded.child;
  if (!child) {
    return Promise.reject(apiError("NOT_FOUND", `plugin host process gone: ${loaded.manifest.id}`));
  }
  if (signal?.aborted) return Promise.reject(signal.reason);
  const id = `h${loaded.nextCallId++}`;
  return new Promise((resolvePromise, rejectPromise) => {
    const cancelChild = (error: Error) => {
      const cancellation = typeof message.invocationId === "string"
        ? { invocationId: message.invocationId }
        : { callId: id };
      try {
        child.postMessage({ t: "cancel", ...cancellation, reason: error.message });
      } catch {
        // The process may already be gone; the host still revokes the call.
      }
    };
    const abort = () => {
      const error = signal?.reason instanceof Error
        ? signal.reason
        : apiError("PLUGIN_TOOL_ABORTED", "Plugin tool execution aborted");
      loaded.pending.get(id)?.reject(error);
      cancelChild(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      loaded.pending.delete(id);
      signal?.removeEventListener("abort", abort);
    };
    const timer = setTimeout(() => {
      const error = apiError("TIMEOUT", `plugin ${loaded.manifest.id} did not answer ${String(message.t)}`);
      loaded.pending.get(id)?.reject(error);
      cancelChild(error);
    }, timeoutMs);
    loaded.pending.set(id, {
      resolve: (value) => { cleanup(); resolvePromise(value); },
      reject: (error) => { cleanup(); rejectPromise(error); },
      timer,
    });
    signal?.addEventListener("abort", abort, { once: true });
    try {
      child.postMessage({ ...message, id });
    } catch (error) {
      loaded.pending.get(id)?.reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}


export function rejectPending(loaded: LoadedPlugin, error: Error): void {
  for (const entry of loaded.pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(error);
  }
  loaded.pending.clear();
}
