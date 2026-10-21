import type { AssistantImages, ProviderImages } from "@earendil-works/pi-ai";
import { imageResolution, imageResolutionsFor, type ImageResolution } from "@pi-desktop/shared";
import {
  boundedBytes, downloadGeneratedImage, generatedImageType, imageError, MAX_IMAGE_BYTES,
  type ImageDownloadOptions,
} from "./download.js";

/** Private wire API, not a provider identity or a second model catalog. */
export const OPENAI_IMAGES_API = "pi-desktop-openai-images";

export function imageGenerationUrl(baseUrl: string, edit = false): string {
  const url = new URL(baseUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw imageError("IMAGE_INVALID_ENDPOINT");
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = `${path || "/v1"}/images/${edit ? "edits" : "generations"}`;
  return url.href;
}

/**
 * The Codex image routes sit under the vendor's Codex prefix, beside its chat
 * routes: a provider stored as `https://chatgpt.com/backend-api` serves images
 * at `.../backend-api/codex/images/...`. Already-prefixed base URLs are kept.
 */
export function codexImagesBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return /\/codex$/i.test(trimmed) ? trimmed : `${trimmed}/codex`;
}

/**
 * How the images endpoint encodes its request.
 *
 * `multipart` is the OpenAI Images API: a form for edits, JSON for generation.
 * `codex-json` is the Codex backend: JSON for both, input images as data URLs.
 * `xai-json` is xAI Imagine: JSON for both (it rejects multipart edits), one
 * input image as `image`, several as `images`, each `{ url }` with a data URL.
 */
export type ImageRequestTransport = "multipart" | "codex-json" | "xai-json";

/** xAI accepts at most this many source images in one edit. */
export const XAI_MAX_INPUT_IMAGES = 5;

/**
 * mc-agent: the requested shape, provider-neutral. Each transport translates
 * it into what its endpoint takes; absent means the endpoint's own default.
 */
export const IMAGE_ASPECT_RATIOS = ["1:1", "3:2", "2:3", "16:9", "9:16"] as const;
export type ImageAspectRatio = (typeof IMAGE_ASPECT_RATIOS)[number];

export function imageAspectRatio(value: unknown): ImageAspectRatio | undefined {
  return IMAGE_ASPECT_RATIOS.find((ratio) => ratio === value);
}

/** GPT Image 2 takes any size (multiples of 16, ≤ 3840x2160); these are its sizes per shape and resolution. */
const FLEXIBLE_SIZES: Record<ImageResolution, Record<ImageAspectRatio, string>> = {
  "1k": { "1:1": "1024x1024", "3:2": "1536x1024", "2:3": "1024x1536", "16:9": "1536x864", "9:16": "864x1536" },
  "2k": { "1:1": "2048x2048", "3:2": "2048x1360", "2:3": "1360x2048", "16:9": "2048x1152", "9:16": "1152x2048" },
  "4k": { "1:1": "2880x2880", "3:2": "3520x2336", "2:3": "2336x3520", "16:9": "3840x2160", "9:16": "2160x3840" },
};

/**
 * OpenAI-style `size` for a shape and resolution. GPT Image 2 (and the Codex
 * models built on it) takes exact sizes; older GPT Image has square,
 * landscape and portrait; DALL·E 3 its own three; DALL·E 2 is square only.
 * A higher resolution without a shape is square. Other models on
 * OpenAI-compatible endpoints get the GPT Image sizes.
 */
export function openAIImageSize(
  modelId: string,
  ratio: ImageAspectRatio | undefined,
  resolution: ImageResolution | undefined,
): string | undefined {
  const high = resolution && resolution !== "1k" && imageResolutionsFor(undefined, modelId).includes(resolution);
  if (!ratio && !high) return undefined;
  if (/^gpt-image-2(?![0-9])/i.test(modelId)) return FLEXIBLE_SIZES[high ? resolution : "1k"][ratio ?? "1:1"];
  const shape = !ratio || ratio === "1:1" ? "square" : ratio === "3:2" || ratio === "16:9" ? "landscape" : "portrait";
  if (/^dall-e-2$/i.test(modelId)) return shape === "square" ? "1024x1024" : undefined;
  if (/^dall-e-3$/i.test(modelId)) {
    return shape === "square" ? "1024x1024" : shape === "landscape" ? "1792x1024" : "1024x1792";
  }
  return shape === "square" ? "1024x1024" : shape === "landscape" ? "1536x1024" : "1024x1536";
}

export function safeImageError(error: unknown): string {
  return error && typeof error === "object" && "errorCode" in error &&
    typeof error.errorCode === "string" && /^IMAGE_[A-Z0-9_]+$/.test(error.errorCode)
    ? error.errorCode : "IMAGE_REQUEST_FAILED";
}

/** Only the generations/edits protocol missing from Pi; auth and dispatch belong to Models. */
export function openAIImagesAdapter(
  downloadOptions: ImageDownloadOptions = {},
  transport: ImageRequestTransport = "multipart",
): ProviderImages {
  return {
    async generateImages(model, context, options) {
      const result: AssistantImages = {
        api: model.api, provider: model.provider, model: model.id,
        output: [], stopReason: "stop", timestamp: Date.now(),
      };
      try {
        const signal = options?.signal ?? new AbortController().signal;
        signal.throwIfAborted();
        const headers = new Headers(model.headers);
        if (options?.apiKey) headers.set("Authorization", `Bearer ${options.apiKey}`);
        for (const [name, value] of Object.entries(options?.headers ?? {})) {
          if (value === null) headers.delete(name);
          else headers.set(name, value);
        }
        const prompt = context.input.filter(item => item.type === "text").map(item => item.text).join("\n");
        const images = context.input.filter(item => item.type === "image");
        const responseFormat = /^dall-e-[23]$/i.test(model.id) ? "b64_json" : undefined;
        const extra = options as Record<string, unknown> | undefined;
        const ratio = imageAspectRatio(extra?.aspectRatio);
        const resolution = imageResolution(extra?.resolution);
        const size = openAIImageSize(model.id, ratio, resolution);
        let body: BodyInit;
        if (transport === "codex-json") {
          // The shape the Codex client sends: one JSON body for generation and
          // editing alike, input images inline as data URLs, size at the
          // backend's own auto default.
          headers.set("Content-Type", "application/json");
          body = JSON.stringify({
            model: model.id,
            prompt,
            size: size ?? "auto",
            ...(images.length
              ? { images: images.map((image) => ({ image_url: inputImageDataUrl(image.data) })) }
              : {}),
          });
        } else if (transport === "xai-json") {
          if (images.length > XAI_MAX_INPUT_IMAGES) throw imageError("IMAGE_TOO_MANY_INPUTS");
          headers.set("Content-Type", "application/json");
          const sources = images.map((image) => ({ url: inputImageDataUrl(image.data) }));
          body = JSON.stringify({
            model: model.id,
            prompt,
            n: 1,
            ...(ratio ? { aspect_ratio: ratio } : {}),
            ...(resolution === "2k" ? { resolution } : {}),
            // Inline bytes: xAI's default URLs are temporary and off-host.
            response_format: "b64_json",
            ...(sources.length === 1
              ? { image: { ...sources[0], type: "image_url" } }
              : sources.length
                ? { images: sources }
                : {}),
          });
        } else if (images.length) {
          const form = new FormData();
          form.set("model", model.id);
          form.set("prompt", prompt);
          form.set("n", "1");
          if (size) form.set("size", size);
          if (responseFormat) form.set("response_format", responseFormat);
          images.forEach((image, index) => {
            const bytes = decodeImageBase64(image.data);
            const type = generatedImageType(bytes);
            form.append(images.length === 1 ? "image" : "image[]",
              new Blob([new Uint8Array(bytes)], { type: type.mimeType }), `input-${index}.${type.extension}`);
          });
          headers.delete("Content-Type");
          body = form;
        } else {
          headers.set("Content-Type", "application/json");
          body = JSON.stringify({ model: model.id, prompt, n: 1,
            ...(size ? { size } : {}),
            ...(responseFormat ? { response_format: responseFormat } : {}) });
        }
        const response = await (options?.fetch ?? fetch)(imageGenerationUrl(model.baseUrl, images.length > 0), {
          method: "POST", headers, redirect: "error", signal, body,
        });
        await options?.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers) }, model);
        if (!response.ok) {
          await response.body?.cancel();
          throw imageError(response.status === 401 || response.status === 403 ? "IMAGE_AUTH_FAILED" : `IMAGE_HTTP_${response.status}`);
        }
        // A response may contain several images. Bound the entire JSON as well as every image.
        const raw = await boundedBytes(response, Math.ceil(MAX_IMAGE_BYTES * 4 / 3) * 10 + 65536);
        let payload: unknown;
        try { payload = JSON.parse(Buffer.from(raw).toString("utf8")); }
        catch { throw imageError("IMAGE_INVALID_RESPONSE"); }
        const reported = (payload as { usage?: Record<string, unknown> })?.usage;
        if (reported) {
          const count = (key: string): number => typeof reported[key] === "number" && Number.isFinite(reported[key]) ? Math.max(0, Math.round(reported[key])) : 0;
          const input = count("input_tokens") || count("prompt_tokens");
          const output = count("output_tokens") || count("completion_tokens");
          if (input || output || count("total_tokens")) result.usage = {
            input, output, cacheRead: 0, cacheWrite: 0, totalTokens: count("total_tokens") || input + output,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          };
        }
        const data = (payload as { data?: unknown } | null)?.data;
        if (!Array.isArray(data) || !data.length || data.length > 10) throw imageError("IMAGE_INVALID_RESPONSE");
        for (const item of data) {
          if (!item || typeof item !== "object") throw imageError("IMAGE_INVALID_RESPONSE");
          if (typeof item.revised_prompt === "string") result.output.push({ type: "text", text: item.revised_prompt });
          let bytes: Uint8Array;
          if (typeof item.b64_json === "string") bytes = decodeImageBase64(item.b64_json);
          else if (typeof item.url === "string") bytes = await downloadGeneratedImage(item.url, signal, {
            ...downloadOptions, fetchImpl: downloadOptions.fetchImpl ?? options?.fetch,
          });
          else throw imageError("IMAGE_INVALID_RESPONSE");
          const type = generatedImageType(bytes);
          result.output.push({ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: type.mimeType });
        }
      } catch (error) {
        result.stopReason = options?.signal?.aborted ? "aborted" : "error";
        result.errorMessage = safeImageError(error);
      }
      return result;
    },
  };
}

export function decodeImageBase64(data: string): Uint8Array {
  if (data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw imageError("IMAGE_TOO_LARGE");
  if (!data.length || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data))
    throw imageError("IMAGE_INVALID_RESPONSE");
  return Buffer.from(data, "base64");
}

/** Inline data URL for one input image, the form the Codex edit route takes. */
function inputImageDataUrl(data: string): string {
  const bytes = decodeImageBase64(data);
  const type = generatedImageType(bytes);
  return `data:${type.mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
}
