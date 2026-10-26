import { CREATIVE_RENDERER_METHODS, ErrorCodes, IPC } from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";
import type { IpcRegistrar } from "./types";
import { mkdir } from "node:fs/promises";
import {
  creativeGenerator,
  ensureStartupCleanup,
  onCreativeJob,
  type CreativeReference,
  type FileFacts,
} from "../creative/creative-generation";
import { onCanvasChanged } from "../creative/canvas-tools";

/**
 * mc-agent creative studio IPC (docs/mc-agent/creative-studio.md). Records
 * live in host-core (`creative.*`); generation runs here through the same
 * generator the agent's image tool uses in creative projects.
 */
export type McCreativeIpcDependencies = {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  sendToRenderer: (channel: string, payload: unknown) => void;
  measure: (path: string) => FileFacts;
  /** Preview (`size` px) or full image (0) of a file, as a data URL. */
  imageDataUrl: (path: string, size: number) => string | null;
  pickImages: () => Promise<string[]>;
  revealPath: (path: string) => void;
  /** Put the image file on the clipboard; false when it cannot be read as an image. */
  copyImage: (path: string) => boolean;
};

/** The host methods the studio may call directly (typed in @pi-desktop/shared). */
const PASSTHROUGH: ReadonlySet<string> = new Set(CREATIVE_RENDERER_METHODS);

const MAX_PROMPT = 32_000;
const ROLES = new Set(["reference", "edit", "style"]);

function invalid(message: string): Error {
  return Object.assign(new Error(message), { errorCode: ErrorCodes.INVALID_ARGUMENT });
}

function text(value: unknown, label: string, max = 256): string {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result || result.length > max) throw invalid(`${label} required`);
  return result;
}

export function registerMcCreativeIpc({
  registrar,
  getHost,
  sendToRenderer,
  measure,
  imageDataUrl,
  pickImages,
  revealPath,
  copyImage,
}: McCreativeIpcDependencies): void {
  const host = () => {
    const current = getHost();
    if (!current) throw new Error("host unavailable");
    return current;
  };
  onCreativeJob((job) => sendToRenderer(IPC.event.creativeJob, { job }));
  // The agent changed a canvas or its comments: the open canvas reloads.
  onCanvasChanged((change) => sendToRenderer(IPC.event.creativeCanvas, change));

  registrar.handle(IPC.invoke.creativeCall, async (input: { method?: unknown; params?: unknown } = {}) => {
    const method = text(input?.method, "method", 64);
    if (!PASSTHROUGH.has(method)) throw invalid(`not allowed: ${method}`);
    const params = input?.params && typeof input.params === "object" ? input.params : {};
    // Before the first read of the queue, settle what a previous run left.
    if (method === "creative.jobs.list") await ensureStartupCleanup(host());
    return host().call(method, params);
  });

  registrar.handle(
    IPC.invoke.creativeGenerate,
    async (
      input: {
        groupId?: unknown;
        prompt?: unknown;
        count?: unknown;
        references?: unknown;
        params?: unknown;
        model?: { providerId?: unknown; modelId?: unknown } | null;
        category?: unknown;
      } = {},
    ) => {
      const generator = creativeGenerator();
      if (!generator) throw new Error("image generation is not ready");
      const count = Number(input?.count ?? 1);
      if (!Number.isInteger(count) || count < 1 || count > 10) throw invalid("count is 1 to 10");
      const references: CreativeReference[] = Array.isArray(input?.references)
        ? input.references.map((reference: { assetId?: unknown; role?: unknown }) => {
            const role = String(reference?.role ?? "reference");
            if (!ROLES.has(role)) throw invalid("unknown reference role");
            return { assetId: text(reference?.assetId, "asset id"), role: role as CreativeReference["role"] };
          })
        : [];
      const params =
        input?.params && typeof input.params === "object" && !Array.isArray(input.params)
          ? (input.params as Record<string, unknown>)
          : {};
      // The chosen model is checked like the global one: the account must
      // serve it, or the request is refused before anything is recorded.
      const model = input?.model
        ? { providerId: text(input.model.providerId, "provider id"), modelId: text(input.model.modelId, "model id", 200) }
        : undefined;
      const { job, done } = await generator.start({
        groupId: text(input?.groupId, "project id"),
        model,
        category: typeof input?.category === "string" ? input.category.slice(0, 400) : "",
        entry: "form",
        prompt: text(input?.prompt, "prompt", MAX_PROMPT),
        count,
        references,
        params,
      });
      // The form returns as soon as the job is queued; progress is pushed.
      void done.catch(() => undefined);
      return { job };
    },
  );

  registrar.handle(IPC.invoke.creativeCancel, async (input: { jobId?: unknown } = {}) => ({
    cancelled: creativeGenerator()?.cancel(text(input?.jobId, "job id")) ?? false,
  }));

  const importPaths = async (groupId: string, files: readonly string[], category = "") => {
    const assets = [];
    for (const path of files.slice(0, 50)) {
      const { asset } = await host().call<{ asset: unknown }>("creative.assets.importReference", {
        groupId,
        path,
        facts: measure(path),
        category,
      });
      assets.push(asset);
    }
    return { assets };
  };

  // Dropped files: each is copied into the project as a reference (never
  // read in place), so the renderer cannot point the studio elsewhere.
  registrar.handle(
    IPC.invoke.creativeImport,
    async ({ groupId, paths: dropped, category }: { groupId?: unknown; paths?: unknown; category?: unknown } = {}) => {
      const files = Array.isArray(dropped) ? dropped.map((path) => text(path, "path", 4096)) : [];
      return importPaths(text(groupId, "project id"), files, typeof category === "string" ? category : "");
    },
  );

  registrar.handle(IPC.invoke.creativePickAndImport, async (input: { groupId?: unknown; category?: unknown } = {}) => {
    const groupId = text(input?.groupId, "project id");
    const picked = await pickImages();
    return picked.length
      ? importPaths(groupId, picked, typeof input?.category === "string" ? input.category : "")
      : { assets: [] };
  });

  // Only assets of the project are served, by id: host-core resolves the path.
  registrar.handle(
    IPC.invoke.creativeImage,
    async (input: { groupId?: unknown; assetId?: unknown; size?: unknown } = {}) => {
      const { asset } = await host().call<{ asset: { path: string; fileExists: boolean } }>("creative.assets.get", {
        groupId: text(input?.groupId, "project id"),
        assetId: text(input?.assetId, "asset id"),
      });
      const size = Math.max(0, Math.min(2048, Math.round(Number(input?.size) || 0)));
      return { dataUrl: asset.fileExists ? imageDataUrl(asset.path, size) : null };
    },
  );

  registrar.handle(IPC.invoke.creativeReveal, async (input: { groupId?: unknown; assetId?: unknown } = {}) => {
    const groupId = text(input?.groupId, "project id");
    // Without an asset: the project's creative folder itself.
    if (input?.assetId === undefined || input?.assetId === null) {
      const { storage } = await host().call<{ storage: { base: string } }>("creative.storage", { groupId });
      await mkdir(storage.base, { recursive: true });
      revealPath(storage.base);
      return { ok: true };
    }
    const { asset } = await host().call<{ asset: { path: string } }>("creative.assets.get", {
      groupId,
      assetId: text(input?.assetId, "asset id"),
    });
    revealPath(asset.path);
    return { ok: true };
  });

  registrar.handle(IPC.invoke.creativeCopyImage, async (input: { groupId?: unknown; assetId?: unknown } = {}) => {
    const { asset } = await host().call<{ asset: { path: string } }>("creative.assets.get", {
      groupId: text(input?.groupId, "project id"),
      assetId: text(input?.assetId, "asset id"),
    });
    return { ok: copyImage(asset.path) };
  });
}
