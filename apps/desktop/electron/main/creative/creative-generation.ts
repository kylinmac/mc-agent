import { realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { generateImageBatch } from "@pi-desktop/agent-runtime";
import type {
  CreativeJob,
  CreativeReferenceUse,
  GeneratedImageResult,
  ImageGenerationInput,
} from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";
import type { LocalToolHandler } from "../agent-sidecar";
import { imageInputLoader } from "../services/image-inputs";
import {
  isImageFailure,
  resolveImageBinding,
  type CreativeToolRoute,
  type ImageServiceOptions,
} from "../services/image-generation-service";

/*
  mc-agent creative studio (docs/mc-agent/creative-studio.md): the single
  generation path. The studio's form and the agent's image tool (in a creative
  project) both come here, so every request is a recorded job, results are
  written into the project's `generations/<date>/`, saved before they are
  registered, and registered as assets with the references they used.
*/

export type CreativeReference = CreativeReferenceUse;

export type CreativeGenerateInput = {
  groupId: string;
  entry: "chat" | "form";
  sessionId?: string;
  prompt: string;
  count: number;
  references: CreativeReference[];
  /** Parameters actually sent (only the ones the model supports). */
  params?: Record<string, unknown>;
  /** A model chosen in the studio; the global image model otherwise. */
  model?: { providerId: string; modelId: string };
  /** Category folder for the results (`角色/角色A`); uncategorized when empty. */
  category?: string;
};

/**
 * Image APIs take a plain list of images, so each reference's role is spelled
 * out in the prompt, in the order the images are sent.
 */
export function promptWithRoles(prompt: string, references: readonly CreativeReference[]): string {
  if (!references.length || references.every((reference) => reference.role === "reference")) {
    return references.length > 1
      ? `${references.map((_, index) => `Image ${index + 1}: a reference; use its content.`).join("\n")}\n\n${prompt}`
      : prompt;
  }
  const lines = references.map((reference, index) => {
    const n = index + 1;
    switch (reference.role) {
      case "edit":
        return `Image ${n}: the image to edit. Change it as described below and keep everything else as it is.`;
      case "style":
        return `Image ${n}: a style reference. Match its visual style (rendering, colours, line work) only, not its content.`;
      default:
        return `Image ${n}: a reference. Use its content (subject, character, objects, composition).`;
    }
  });
  return `${lines.join("\n")}\n\n${prompt}`;
}

export type { CreativeJob };

export type FileFacts = { mime?: string; width?: number; height?: number };

type Host = Pick<HostProcess, "call">;

type GroupRecord = { id: string; roots: Array<{ path: string; kind?: string }> };

export type CreativeGeneratorOptions = ImageServiceOptions & {
  /** Image facts (Electron's nativeImage in the app; injected for tests). */
  measure?: (path: string) => FileFacts;
  /** Every change of a job, for the studio's queue. */
  onJob?: (job: CreativeJob) => void;
};

class CreativeError extends Error {
  readonly errorCode: string;

  constructor(errorCode: string, message: string) {
    super(message);
    this.errorCode = errorCode;
  }
}

let startupCleanup: Promise<void> | null = null;

/**
 * Once per app run, before the first job: jobs a previous run left unfinished
 * are marked interrupted (nothing can still be generating them).
 */
export function ensureStartupCleanup(host: Host): Promise<void> {
  startupCleanup ??= host
    .call("creative.jobs.interruptUnfinished")
    .then(() => undefined)
    .catch(() => {
      startupCleanup = null;
    });
  return startupCleanup;
}

/** Where the project keeps its files (its workspace's `creative/`, or the resource folder). */
async function storageBase(host: Host, groupId: string): Promise<string> {
  const { storage } = await host.call<{ storage: { base: string } }>("creative.storage", { groupId });
  return storage.base;
}

export function createCreativeGenerator(options: CreativeGeneratorOptions) {
  const running = new Map<string, AbortController>();

  const notify = async (host: Host, groupId: string, jobId: string) => {
    if (!options.onJob) return;
    try {
      const { job } = await host.call<{ job: CreativeJob }>("creative.jobs.get", { groupId, jobId });
      options.onJob(job);
    } catch {
      // The queue refreshes on its own; a missed push is not an error.
    }
  };

  /**
   * Record the job, then run it. Resolves once the job exists (the form shows
   * it in the queue at once); `done` settles when every result reported.
   */
  async function start(input: CreativeGenerateInput, outerSignal?: AbortSignal) {
    const resolved = await resolveImageBinding(options, input.model);
    if (isImageFailure(resolved)) {
      throw new CreativeError(resolved.errorCode, resolved.content.message);
    }
    const { host, binding, imageBinding, downloadOptions } = resolved;
    await ensureStartupCleanup(host);
    const root = await storageBase(host, input.groupId);
    const referencePaths: string[] = [];
    for (const reference of input.references) {
      const { asset } = await host.call<{ asset: { path: string; fileExists: boolean } }>("creative.assets.get", {
        groupId: input.groupId,
        assetId: reference.assetId,
      });
      if (!asset.fileExists) throw new CreativeError("IMAGE_INPUT_MISSING", "A reference image is missing on disk.");
      referencePaths.push(asset.path);
    }
    const { job, outputDir } = await host.call<{ job: CreativeJob; outputDir: string }>("creative.jobs.create", {
      groupId: input.groupId,
      job: {
        entry: input.entry,
        sessionId: input.sessionId ?? null,
        providerId: binding.providerId,
        modelId: binding.modelId,
        count: input.count,
        snapshot: {
          category: input.category ?? "",
          prompt: input.prompt,
          sentPrompt: promptWithRoles(input.prompt, input.references),
          params: input.params ?? {},
          references: input.references,
          providerId: binding.providerId,
          modelId: binding.modelId,
        },
      },
    });
    const controller = new AbortController();
    running.set(job.id, controller);
    const signal = outerSignal ? AbortSignal.any([outerSignal, controller.signal]) : controller.signal;
    const groupId = input.groupId;
    const jobId = job.id;
    await host.call("creative.jobs.setStatus", { groupId, jobId, status: "running" });
    void notify(host, groupId, jobId);

    const done = (async (): Promise<{ job: CreativeJob; results: GeneratedImageResult[] }> => {
      let results: GeneratedImageResult[] = [];
      try {
        results = await generateImageBatch({
          input: {
            items: [
              {
                prompt: promptWithRoles(input.prompt, input.references),
                count: input.count,
                ...(referencePaths.length ? { images: referencePaths } : {}),
              },
            ],
          },
          binding: imageBinding,
          signal,
          ...(typeof input.params?.aspectRatio === "string" ? { aspectRatio: input.params.aspectRatio } : {}),
          ...(typeof input.params?.resolution === "string" ? { resolution: input.params.resolution } : {}),
          fetchImpl: options.fetchImpl,
          downloadOptions,
          loadImages: imageInputLoader({ dataDir: options.dataDir, scratchPath: outputDir, projectPath: root }),
          save: async (image, index) => {
            const target = join(outputDir, `${jobId.slice(0, 8)}-${index + 1}.${image.extension}`);
            await writeFile(target, image.bytes, { flag: "wx" });
            // Saved first, then registered; a failed registration is
            // completed later from this record, never by generating again.
            try {
              await host.call("creative.jobs.recordResult", {
                groupId,
                jobId,
                index,
                path: target,
                facts: options.measure?.(target) ?? { mime: image.mimeType },
              });
            } catch {
              // `creative.jobs.reconcile` registers it on the next visit.
            }
            void notify(host, groupId, jobId);
            return target;
          },
        });
        for (const result of results) {
          if (result.status === "succeeded") continue;
          await host.call("creative.jobs.recordResult", {
            groupId,
            jobId,
            index: result.index,
            error: result.errorCode ?? "IMAGE_REQUEST_FAILED",
          }).catch(() => undefined);
        }
      } finally {
        running.delete(jobId);
        if (signal.aborted) {
          await host.call("creative.jobs.setStatus", { groupId, jobId, status: "cancelled" }).catch(() => undefined);
        }
      }
      const { job: settled } = await host.call<{ job: CreativeJob }>("creative.jobs.get", { groupId, jobId });
      options.onJob?.(settled);
      return { job: settled, results };
    })();
    return { job, done };
  }

  function cancel(jobId: string): boolean {
    const controller = running.get(jobId);
    controller?.abort();
    return !!controller;
  }

  /**
   * The agent's image tool in a creative project: each item becomes one job,
   * its input images are copied into the project as references, and the tool
   * answers in its usual shape. Other sessions keep the scratch flow.
   */
  const toolRoute: CreativeToolRoute = async (sessionId, args, signal) => {
    const host = options.getHost();
    if (!host) return undefined;
    const found = await sessionCreativeGroup(host, sessionId);
    if (!found) return undefined;
    const { group, projectPath } = found;

    const results: GeneratedImageResult[] = [];
    let offset = 0;
    let providerId: string | undefined;
    let modelId: string | undefined;
    for (const item of (args as ImageGenerationInput).items) {
      const references: CreativeReference[] = [];
      for (const ref of item.images ?? []) {
        const path = /^attachments[\\/][a-f0-9]{64}$/.test(ref)
          ? resolve(options.dataDir, ref)
          : isAbsolute(ref)
            ? ref
            : resolve(projectPath, ref);
        const { asset } = await host.call<{ asset: { id: string } }>("creative.assets.importReference", {
          groupId: group.id,
          path,
          facts: options.measure?.(path) ?? {},
        });
        references.push({ assetId: asset.id, role: "reference" });
      }
      try {
        const { job, done } = await start(
          { groupId: group.id, entry: "chat", sessionId, prompt: item.prompt, count: item.count ?? 1, references },
          signal,
        );
        providerId = job.providerId ?? providerId;
        modelId = job.modelId ?? modelId;
        const outcome = await done;
        for (const result of outcome.results) results.push({ ...result, index: result.index + offset });
      } catch (error) {
        const code = error instanceof CreativeError ? error.errorCode : "IMAGE_REQUEST_FAILED";
        for (let index = 0; index < (item.count ?? 1); index++) {
          results.push({ index: offset + index, status: "failed", errorCode: code });
        }
      }
      offset += item.count ?? 1;
    }
    const ok = results.some((result) => result.status === "succeeded");
    const handled: Awaited<ReturnType<LocalToolHandler>> = {
      ok,
      isError: !ok,
      content: {
        kind: "generated-images",
        providerId,
        modelId,
        results,
        operations: [],
      },
    };
    return handled;
  };

  /** The creative project a session belongs to, or null. */
  const sessionCreativeGroup = async (host: Host, sessionId: string) => {
    const { session } = await host.call<{ session?: { projectPath?: string } }>("session.get", { id: sessionId });
    const projectPath = session?.projectPath;
    if (!projectPath) return null;
    const [{ groups }, { purposes }] = await Promise.all([
      host.call<{ groups: GroupRecord[] }>("project.groups.list"),
      host.call<{ purposes: Record<string, string> }>("creative.purposes"),
    ]);
    const group = groups.find(
      (candidate) =>
        purposes[candidate.id] === "creative" &&
        candidate.roots.some((root) => resolve(root.path) === resolve(projectPath)),
    );
    return group ? { group, projectPath } : null;
  };

  /**
   * `SaveCreativeAsset`: an image the agent drew with code joins the project's
   * library, the script kept as its snapshot. The files must be inside the
   * project's folders or the session scratch directory.
   */
  const saveAssetTool: LocalToolHandler = async ({ sessionId, args }) => {
    const fail = (errorCode: string, message: string) => ({
      ok: false,
      isError: true,
      errorCode,
      content: { kind: "creative-asset-error", errorCode, message },
    });
    const host = options.getHost();
    if (!host) return fail("HOST_UNAVAILABLE", "Host unavailable.");
    const input = (args ?? {}) as { imagePath?: unknown; scriptPath?: unknown; command?: unknown; category?: unknown };
    if (typeof input.imagePath !== "string" || !input.imagePath.trim())
      return fail("INVALID_ARGUMENT", "imagePath is required.");
    const found = await sessionCreativeGroup(host, sessionId);
    if (!found)
      return fail("NOT_CREATIVE_PROJECT", "This conversation is not in a creative project; the image stays where it is.");
    const { path: scratch } = await host.call<{ path: string }>("session.getScratchPath", { sessionId });
    const roots = [...found.group.roots.map((root) => root.path), scratch].filter(Boolean);
    const locate = async (raw: string) => {
      const candidate = isAbsolute(raw) ? raw : resolve(found.projectPath, raw);
      const real = await realpath(candidate).catch(() => null);
      if (!real) return null;
      for (const root of roots) {
        const realRoot = await realpath(root).catch(() => null);
        if (!realRoot) continue;
        const rel = relative(realRoot, real);
        if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return real;
      }
      return null;
    };
    const image = await locate(input.imagePath.trim());
    if (!image) return fail("INVALID_ARGUMENT", "The image must be a file in the project or the session scratch directory.");
    const script = typeof input.scriptPath === "string" && input.scriptPath.trim() ? await locate(input.scriptPath.trim()) : null;
    if (typeof input.scriptPath === "string" && input.scriptPath.trim() && !script)
      return fail("INVALID_ARGUMENT", "The script must be a file in the project or the session scratch directory.");
    try {
      const { job } = await host.call<{ job: CreativeJob }>("creative.code.register", {
        groupId: found.group.id,
        imagePath: image,
        scriptPath: script,
        command: typeof input.command === "string" ? input.command : "",
        category: typeof input.category === "string" ? input.category : "",
        sessionId,
        facts: options.measure?.(image) ?? {},
      });
      options.onJob?.(job);
      const saved = job.results[0];
      return {
        ok: true,
        isError: false,
        content: { kind: "creative-asset", assetId: saved?.assetId, path: saved?.path },
      };
    } catch (error) {
      return fail("CREATIVE_SAVE_FAILED", error instanceof Error ? error.message : String(error));
    }
  };

  return { start, cancel, toolRoute, saveAssetTool };
}

export type CreativeGenerator = ReturnType<typeof createCreativeGenerator>;

let shared: CreativeGenerator | null = null;
const jobListeners = new Set<(job: CreativeJob) => void>();

/** The sidecar builds the generator; the studio's IPC uses the same one. */
export function setCreativeGenerator(generator: CreativeGenerator): void {
  shared = generator;
}

export function creativeGenerator(): CreativeGenerator | null {
  return shared;
}

export function emitCreativeJob(job: CreativeJob): void {
  for (const listener of jobListeners) listener(job);
}

export function onCreativeJob(listener: (job: CreativeJob) => void): () => void {
  jobListeners.add(listener);
  return () => jobListeners.delete(listener);
}

/**
 * mc-agent: what a conversation in a creative project is told about its
 * images: where results belong and which tools file them. Null for any other
 * project.
 */
export async function creativeSessionHint(host: Host, projectPath: string | null | undefined): Promise<string | null> {
  if (!projectPath) return null;
  const [{ groups }, { purposes }] = await Promise.all([
    host.call<{ groups: GroupRecord[] }>("project.groups.list"),
    host.call<{ purposes: Record<string, string> }>("creative.purposes"),
  ]);
  const group = groups.find(
    (candidate) =>
      purposes[candidate.id] === "creative" &&
      candidate.roots.some((root) => resolve(root.path) === resolve(projectPath)),
  );
  if (!group) return null;
  const [{ storage }, { categories }] = await Promise.all([
    host.call<{ storage: { base: string; uncategorized: string; scripts: string } }>("creative.storage", {
      groupId: group.id,
    }),
    host.call<{ categories: Array<{ path: string }> }>("creative.categories.list", { groupId: group.id }),
  ]);
  const known = categories.map((category) => category.path);
  return [
    "This conversation belongs to a creative project; the user works on images here.",
    `Images live in ${storage.base}, one folder per category (e.g. ${storage.base}/角色/角色A); uncategorized ones in ${storage.uncategorized}; scripts in ${storage.scripts}.`,
    known.length
      ? `Existing categories: ${known.join(", ")}. Use the one that fits; otherwise uncategorized.`
      : "No categories exist yet; results go to uncategorized unless the user names one.",
    "To create an image with an image model, call GenerateImages; its results are saved and filed automatically (uncategorized).",
    `To draw with code (pixel art, icons, charts, diagrams), write the script under ${storage.scripts}, have it write the image into the category folder (or ${storage.uncategorized}), run it, then call SaveCreativeAsset with the image path, the script path, the exact command and the category. Never leave images in the project root.`,
    "Choose whichever fits the request; for precise pixel-level or programmatic results, code drawing is usually better.",
  ].join("\n");
}
