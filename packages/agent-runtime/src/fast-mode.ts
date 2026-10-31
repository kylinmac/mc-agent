import type { ProviderStreams, StreamOptions, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { canRequestFastMode, type FastModeBinding } from "@pi-desktop/shared";
export function withFastMode(api: ProviderStreams, binding: FastModeBinding & { fastMode?: boolean }): ProviderStreams {
  if (binding.fastMode !== true || !canRequestFastMode(binding)) return api;
  const optionsFor = <T extends StreamOptions | SimpleStreamOptions>(options: T | undefined): T => ({
    ...options,
    onPayload: async (payload, model) => {
      const original = await options?.onPayload?.(payload, model);
      const body = original === undefined ? payload : original;
      if (!body || typeof body !== "object" || Array.isArray(body)) return body;
      return { ...body, service_tier: "priority" };
    },
  } as T);
  return { ...api,
    stream: (model, context, options) => api.stream(model, context, optionsFor(options)),
    streamSimple: (model, context, options) => api.streamSimple(model, context, optionsFor(options)),
  };
}
