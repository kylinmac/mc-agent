/*
  mc-agent: which image models a signed-in vendor account serves, read from
  the account itself instead of a list written into the app.

  xAI publishes them at `GET /v1/image-generation-models` (with the token the
  chat traffic uses); when that route does not answer, its general model list
  is filtered to the image models. Anything else returns null and the caller
  keeps its built-in fallback.
*/

const TIMEOUT_MS = 8_000;
const IMAGE_MODEL = /(?:^|[-_/])(?:imagine|image)(?:$|[-_/])/i;
const VIDEO_MODEL = /(?:^|[-_/])video(?:$|[-_/])/i;

function ids(payload: unknown, key: "models" | "data"): string[] {
  const list = payload && typeof payload === "object" ? (payload as Record<string, unknown>)[key] : undefined;
  if (!Array.isArray(list)) return [];
  return list
    .map((entry) => (entry && typeof entry === "object" ? (entry as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    .map((id) => id.trim());
}

async function getJson(url: string, token: string, fetchImpl: typeof fetch): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Image model ids an xAI account serves, or null when it cannot be read. */
export async function readXaiImageModels(
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string[] | null> {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  const root = /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
  const dedicated = await getJson(`${root}/image-generation-models`, token, fetchImpl);
  const listed = [...ids(dedicated, "models"), ...ids(dedicated, "data")];
  if (listed.length) return [...new Set(listed)];
  const all = await getJson(`${root}/models`, token, fetchImpl);
  const images = ids(all, "data").filter((id) => IMAGE_MODEL.test(id) && !VIDEO_MODEL.test(id));
  return images.length ? [...new Set(images)] : null;
}
