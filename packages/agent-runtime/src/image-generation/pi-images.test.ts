import { expect, it, vi } from "vitest";
import { createModels, createProvider, type AssistantImages, type ImageModel } from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { createImageBinding, generateImageBatch, type ImageOperationMetadata } from "./index.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8=";
const input = { items: [{ prompt: "draw" }] };
const signal = () => new AbortController().signal;
const save = vi.fn(async (_image: unknown, index: number) => `/scratch/${index}.png`);
const endpoint = { baseUrl: "https://images.example/v1", modelId: "custom-image", apiKey: "fixture" };
const nativeResponse = () => Response.json({ id: "response-1", choices: [{ message: {
  content: "Two views", images: [{ image_url: { url: `data:image/png;base64,${png}` } }, { image_url: { url: `data:image/png;base64,${png}` } }],
} }], usage: { prompt_tokens: 10, completion_tokens: 20 } });

it("dispatches native OpenRouter through Pi once, preserving every image, text and usage", async () => {
  const known = openrouterProvider().getAllModels!().find((model): model is ImageModel<string> => model.type === "image");
  expect(known).toBeDefined();
  const binding = createImageBinding({ ...endpoint, vendorKey: "openrouter", modelId: known!.id });
  const generate = vi.spyOn(binding.models, "generateImages");
  const transport = vi.fn<typeof fetch>().mockResolvedValue(nativeResponse());
  const operations: ImageOperationMetadata[] = [];
  const result = await generateImageBatch({ binding, input, signal: signal(), save, fetchImpl: transport, onOperation: op => operations.push(op) });
  expect(generate).toHaveBeenCalledTimes(1);
  expect(generate.mock.calls[0][2]).toMatchObject({ maxRetries: 0 });
  expect(transport).toHaveBeenCalledTimes(1);
  expect(String(transport.mock.calls[0][0])).toContain("/chat/completions");
  expect(JSON.parse(String(transport.mock.calls[0][1]?.body))).toMatchObject({ model: known!.id, stream: false });
  expect(result.map(item => item.status)).toEqual(["succeeded", "succeeded"]);
  expect(operations).toHaveLength(1);
  expect(operations[0]).toMatchObject({ text: ["Two views"], responseId: "response-1", usage: { inputTokens: 10, outputTokens: 20 } });
});

it("never retries native billable failures or falls back to the OpenAI adapter", async () => {
  for (const status of [401, 429, 500]) {
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => new Response("secret", { status }));
    const results = await generateImageBatch({ endpoint: { ...endpoint, vendorKey: "openrouter" }, input, signal: signal(), save, fetchImpl: transport });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(results[0].errorCode).toBe(status === 401 ? "IMAGE_AUTH_FAILED" : `IMAGE_HTTP_${status}`);
    expect(JSON.stringify(results)).not.toContain("secret");
  }
});

it("keeps same-vendor accounts isolated through actual Models auth resolution", async () => {
  const auths: string[] = [];
  await Promise.all(["account-a", "account-b"].map(key => generateImageBatch({
    endpoint: { ...endpoint, providerId: key, vendorKey: "custom", apiKey: key }, input, signal: signal(), save,
    fetchImpl: async (_url, init) => { auths.push(new Headers(init?.headers).get("authorization")!); return Response.json({ data: [{ b64_json: png }] }); },
  })));
  expect(auths.sort()).toEqual(["Bearer account-a", "Bearer account-b"]);
});

it("requires real native image capability for OAuth and resolves supported auth via the shared seam", async () => {
  const resolveAuth = vi.fn(async () => ({ apiKey: "oauth-fixture" }));
  expect(() => createImageBinding({ ...endpoint, authKind: "oauth", resolveAuth })).toThrow("IMAGE_AUTH_UNSUPPORTED");
  const known = openrouterProvider().getAllModels!().find(model => model.type === "image")!;
  const binding = createImageBinding({ ...endpoint, vendorKey: "openrouter", modelId: known.id, nativeModel: known, authKind: "oauth", resolveAuth });
  const transport = vi.fn<typeof fetch>().mockResolvedValue(nativeResponse());
  await generateImageBatch({ binding, input, signal: signal(), save, fetchImpl: transport });
  expect(resolveAuth).toHaveBeenCalledTimes(1);
  expect(new Headers(transport.mock.calls[0][1]?.headers).get("authorization")).toBe("Bearer oauth-fixture");
});

it("retains multiple OpenAI outputs in stable operation order without extra requests", async () => {
  const transport = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ data: [{ b64_json: png }, { b64_json: png }] }));
  const results = await generateImageBatch({ endpoint, input: { items: [{ prompt: "a", count: 2 }] }, signal: signal(), save, fetchImpl: transport });
  expect(results.map(result => result.index)).toEqual([0, 1, 2, 3]);
  expect(transport).toHaveBeenCalledTimes(2);
});

it("honors returned error/aborted and rejects text-only successful responses without paid retries", async () => {
  const model: ImageModel<string> = { type: "image", id: "m", name: "m", api: "fixture", provider: "fixture", baseUrl: endpoint.baseUrl,
    input: ["text"], output: ["image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  for (const stopReason of ["error", "aborted", "stop"] as const) {
    const generate = vi.fn(async (): Promise<AssistantImages> => ({ api: "fixture", provider: "fixture", model: "m", output: [{ type: "text", text: "no image" }], stopReason, timestamp: 0, errorMessage: "private token" }));
    const models = createModels();
    models.setProvider(createProvider({ id: "fixture", models: [model], auth: { apiKey: { name: "none", resolve: async () => ({ auth: {} }) } }, images: { fixture: { generateImages: generate } } }));
    const results = await generateImageBatch({ binding: { models, model }, input, signal: signal(), save });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(results[0]).toMatchObject({ status: stopReason === "aborted" ? "cancelled" : "failed", errorCode: stopReason === "stop" ? "IMAGE_INVALID_RESPONSE" : stopReason === "aborted" ? "IMAGE_CANCELLED" : "IMAGE_REQUEST_FAILED" });
  }
});

it("cancels while resolving auth without sending a request", async () => {
  let finish!: () => void;
  const controller = new AbortController();
  const resolveAuth = vi.fn(async () => { await new Promise<void>(resolve => { finish = resolve; }); return { apiKey: "fixture" }; });
  const transport = vi.fn<typeof fetch>();
  const run = generateImageBatch({ endpoint: { ...endpoint, resolveAuth }, input, signal: controller.signal, save, fetchImpl: transport });
  await vi.waitFor(() => expect(resolveAuth).toHaveBeenCalledTimes(1));
  controller.abort(); finish();
  expect((await run)[0].status).toBe("cancelled");
  expect(transport).not.toHaveBeenCalled();
});

it("bounds native data URLs and does not claim zero pricing for custom image models", async () => {
  const operations: ImageOperationMetadata[] = [];
  await generateImageBatch({ endpoint: { ...endpoint, vendorKey: "openrouter" }, input, signal: signal(), save,
    fetchImpl: async () => nativeResponse(), onOperation: operation => operations.push(operation) });
  expect(operations[0].usage).toBeDefined();
  expect(operations[0].usage?.cost).toBeUndefined();
  const results = await generateImageBatch({ endpoint: { ...endpoint, vendorKey: "openrouter" }, input, signal: signal(), save,
    fetchImpl: async () => new Response("", { headers: { "content-length": "999999999" } }) });
  expect(results[0].errorCode).toBe("IMAGE_TOO_LARGE");
});

/** A signed-in ChatGPT (Codex) account: an OAuth token, no API key, no catalog entry. */
const codexAccount = {
  baseUrl: "https://chatgpt.example/backend-api",
  modelId: "gpt-image-2.5",
  vendorKey: "openai-codex",
  authKind: "oauth",
  resolveAuth: async () => ({ apiKey: "codex-account-token" }),
};

it("serves a signed-in Codex account's image model on the vendor's Codex routes", async () => {
  const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [{ b64_json: png }] }));
  const results = await generateImageBatch({ endpoint: codexAccount, input, signal: signal(), save, fetchImpl: transport });
  expect(results.map(result => result.status)).toEqual(["succeeded"]);
  const [url, init] = transport.mock.calls[0];
  expect(String(url)).toBe("https://chatgpt.example/backend-api/codex/images/generations");
  expect(new Headers(init?.headers).get("authorization")).toBe("Bearer codex-account-token");
  expect(JSON.parse(String(init?.body))).toEqual({ model: "gpt-image-2.5", prompt: "draw", size: "auto" });
});

it("edits a Codex account's image as inline data URLs instead of a multipart form", async () => {
  const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [{ b64_json: png }] }));
  const bytes = Buffer.from(png, "base64");
  const results = await generateImageBatch({
    endpoint: codexAccount,
    input: { items: [{ prompt: "draw", images: ["0.png"] }] },
    signal: signal(), save, fetchImpl: transport,
    loadImages: async () => [{ bytes, mimeType: "image/png", extension: "png" }],
  });
  expect(results.map(result => result.status)).toEqual(["succeeded"]);
  const [url, init] = transport.mock.calls[0];
  expect(String(url)).toBe("https://chatgpt.example/backend-api/codex/images/edits");
  expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
  const body = JSON.parse(String(init?.body));
  expect(Object.keys(body).sort()).toEqual(["images", "model", "prompt", "size"]);
  expect(body.images[0].image_url).toBe(`data:image/png;base64,${png}`);
});

it("keeps an already-prefixed Codex base URL and still requires the account token", async () => {
  const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [{ b64_json: png }] }));
  await generateImageBatch({
    endpoint: { ...codexAccount, baseUrl: "https://chatgpt.example/backend-api/codex/" },
    input, signal: signal(), save, fetchImpl: transport,
  });
  expect(String(transport.mock.calls[0][0])).toBe("https://chatgpt.example/backend-api/codex/images/generations");
  expect(() => createImageBinding({ ...codexAccount, resolveAuth: undefined }))
    .toThrow("IMAGE_AUTH_UNSUPPORTED");
});

/** mc-agent: a signed-in xAI (Grok/X subscription) account. */
const xaiAccount = {
  baseUrl: "https://api.x.example/v1",
  modelId: "grok-imagine-image-2.0",
  vendorKey: "xai",
  authKind: "oauth",
  resolveAuth: async () => ({ apiKey: "xai-account-token" }),
};

it("serves a signed-in xAI account's Imagine model as JSON with inline results", async () => {
  const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [{ b64_json: png }] }));
  const results = await generateImageBatch({ endpoint: xaiAccount, input, signal: signal(), save, fetchImpl: transport });
  expect(results.map(result => result.status)).toEqual(["succeeded"]);
  const [url, init] = transport.mock.calls[0];
  expect(String(url)).toBe("https://api.x.example/v1/images/generations");
  expect(new Headers(init?.headers).get("authorization")).toBe("Bearer xai-account-token");
  expect(JSON.parse(String(init?.body))).toEqual({
    model: "grok-imagine-image-2.0", prompt: "draw", n: 1, response_format: "b64_json",
  });
});

it("edits on xAI as JSON: one source as image, several as images", async () => {
  const bytes = Buffer.from(png, "base64");
  const edit = async (count: number) => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [{ b64_json: png }] }));
    const results = await generateImageBatch({
      endpoint: xaiAccount,
      input: { items: [{ prompt: "draw", images: Array.from({ length: count }, (_, index) => `${index}.png`) }] },
      signal: signal(), save, fetchImpl: transport,
      loadImages: async () => Array.from({ length: count }, () => ({ bytes, mimeType: "image/png", extension: "png" })),
    });
    expect(results.map(result => result.status)).toEqual(["succeeded"]);
    const [url, init] = transport.mock.calls[0];
    expect(String(url)).toBe("https://api.x.example/v1/images/edits");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    return JSON.parse(String(init?.body));
  };
  const single = await edit(1);
  expect(single.image).toEqual({ url: `data:image/png;base64,${png}`, type: "image_url" });
  expect(single.images).toBeUndefined();
  const several = await edit(3);
  expect(several.images).toHaveLength(3);
  expect(several.images[0]).toEqual({ url: `data:image/png;base64,${png}` });
  expect(several.image).toBeUndefined();
  expect(() => createImageBinding({ ...xaiAccount, resolveAuth: undefined })).toThrow("IMAGE_AUTH_UNSUPPORTED");
});

it("mc-agent: sends the requested shape in each endpoint's own terms", async () => {
  const body = async (
    target: typeof endpoint | typeof codexAccount | typeof xaiAccount,
    aspectRatio?: string,
    resolution?: string,
  ) => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [{ b64_json: png }] }));
    await generateImageBatch({ endpoint: target, input, signal: signal(), save, fetchImpl: transport, aspectRatio, resolution });
    return JSON.parse(String(transport.mock.calls[0][1]?.body));
  };
  expect((await body(xaiAccount, "16:9")).aspect_ratio).toBe("16:9");
  expect((await body(xaiAccount)).aspect_ratio).toBeUndefined();
  expect((await body(codexAccount, "2:3")).size).toBe("1024x1536");
  expect((await body(codexAccount)).size).toBe("auto");
  expect((await body(endpoint, "3:2")).size).toBe("1536x1024");
  expect((await body(endpoint)).size).toBeUndefined();
  // Anything else is not a shape and leaves the endpoint's default.
  expect((await body(xaiAccount, "7:5")).aspect_ratio).toBeUndefined();
  // Resolution: xAI takes 2k as a field; GPT Image 2 takes exact sizes;
  // models without it keep their standard sizes.
  expect((await body(xaiAccount, "16:9", "2k")).resolution).toBe("2k");
  expect((await body(xaiAccount, "16:9", "1k")).resolution).toBeUndefined();
  expect((await body(xaiAccount, "16:9", "4k")).resolution).toBeUndefined();
  expect((await body(codexAccount, "16:9", "4k")).size).toBe("3840x2160");
  expect((await body(codexAccount, undefined, "2k")).size).toBe("2048x2048");
  expect((await body(codexAccount, "16:9")).size).toBe("1536x864");
  expect((await body(endpoint, "16:9", "2k")).size).toBe("1536x1024");
});
