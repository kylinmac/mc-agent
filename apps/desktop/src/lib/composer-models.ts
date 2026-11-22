import { providerThinkingLevels } from "./session-thinking.ts";
import {
  bindingSupportsImages,
  effectiveContextWindow,
  isImageGenerationModel,
  type ImageGenerationBindings,
  modelMatchesFilter,
  modelWireIdsEqual,
  THINKING_LEVELS,
  type SessionThinkingLevel,
  type ModelBinding,
  type ModelInfo,
  type ProviderPublic,
} from "@pi-desktop/shared";

type ConfiguredProvider = Pick<ProviderPublic, "id" | "models" | "defaultModelId">;

/** UI identity is the complete wire id, not a catalog alias or a route suffix. */
export function sameComposerModelId(left: string, right: string): boolean {
  return modelWireIdsEqual(left, right);
}

function configuredModelIds(provider: ConfiguredProvider): string[] {
  const ids = (provider.models ?? [])
    .map((binding) => binding.id.trim())
    .filter(Boolean);
  if (ids.length > 0) return [...new Set(ids)];

  const legacyId = provider.defaultModelId?.trim();
  return legacyId ? [legacyId] : [];
}

/**
 * Build the Composer model list from the models explicitly enabled in
 * provider settings. Discovery only enriches an exact configured id; it does
 * not grant every discovered model access to the conversation picker or lend
 * another route's capabilities to this binding.
 */
export function composerModelsForProvider(
  provider: ConfiguredProvider,
  discovered: readonly ModelInfo[] | undefined,
  imageGeneration?: ImageGenerationBindings | null,
): ModelInfo[] {
  return configuredModelIds(provider).filter((modelId) =>
    !isImageGenerationModel(imageGeneration, provider.id, modelId),
  ).map((modelId) => {
    const metadata = (discovered ?? []).find((model) =>
      sameComposerModelId(model.modelId, modelId),
    );
    const binding = composerModelBinding(provider, modelId);
    const contextWindow = effectiveContextWindow(
      metadata?.contextWindow,
      binding?.contextWindow,
      binding?.contextWindowSource,
    );
    const contextLimit = contextWindow === undefined ? {} : { contextWindow };
    const displayName = modelId;
    return metadata
      ? { ...metadata, ...contextLimit, modelId, displayName, providerId: provider.id }
      : {
          modelId,
          displayName,
          providerId: provider.id,
          ...contextLimit,
          capabilities: ["text"],
          source: "user" as const,
        };
  });
}

/** The Composer uses the configured alias when set, otherwise the complete wire id. */
export function composerModelDisplayName(
  provider: ConfiguredProvider | undefined,
  modelId: string,
): string {
  const alias = provider ? composerModelBinding(provider, modelId)?.alias?.trim() : undefined;
  return alias || modelId;
}

/** Find only the binding for this complete wire id. */
export function composerModelBinding(
  provider: ConfiguredProvider,
  modelId: string,
): ModelBinding | undefined {
  return (provider.models ?? []).find((candidate) =>
    sameComposerModelId(candidate.id, modelId),
  );
}

/** Short capability markers shown on a composer model row. */
export type ComposerModelBadge = "reasoning" | "vision";

/**
 * Capability markers for one configured model. Vision follows the binding's
 * image-input override when set, the published capability otherwise.
 */
export function composerModelBadges(
  model: ModelInfo,
  provider?: ConfiguredProvider | null,
): ComposerModelBadge[] {
  const badges: ComposerModelBadge[] = [];
  if (modelMatchesFilter(model, "reasoning")) badges.push("reasoning");
  const binding = provider ? composerModelBinding(provider, model.modelId) : undefined;
  if (bindingSupportsImages(binding, model)) badges.push("vision");
  return badges;
}

/** Search the full id, configured alias, published name, family and provider. */
export function composerModelMatchesQuery(
  model: ModelInfo,
  providerName: string,
  query: string,
  alias?: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystacks = [
    model.modelId,
    alias ?? "",
    model.displayName ?? "",
    model.family ?? "",
    providerName,
  ];
  return haystacks.some((value) => value.toLowerCase().includes(needle));
}

/**
 * Preserve the current level when changing providers, but never carry a
 * reasoning level into a provider that cannot accept it.
 */
export function thinkingLevelForProvider(
  provider: ProviderPublic | null | undefined,
  current: SessionThinkingLevel,
): SessionThinkingLevel {
  const available = providerThinkingLevels(provider);
  if (!provider?.supportsReasoning) return "off";
  if (current === "omit") return "omit";
  if (available.includes(current)) return current;
  const requestedIndex = THINKING_LEVELS.indexOf(current);
  for (let index = requestedIndex; index < THINKING_LEVELS.length; index += 1) {
    const candidate = THINKING_LEVELS[index];
    if (available.includes(candidate)) return candidate;
  }
  for (let index = requestedIndex - 1; index >= 0; index -= 1) {
    const candidate = THINKING_LEVELS[index];
    if (available.includes(candidate)) return candidate;
  }
  return "off";
}

/**
 * Project the selected catalog model onto a provider for draft sessions.
 *
 * Persisted sessions receive these exact capabilities from Electron main.
 * Before the first message creates a session, the provider row only describes
 * its default model, so use the selected catalog record and exact model
 * binding when one is available.
 */
export function thinkingProviderForModel(
  provider: ProviderPublic | null | undefined,
  modelId: string | undefined,
  modelCatalog: readonly ModelInfo[] | undefined,
): ProviderPublic | null | undefined {
  if (!provider || !modelId) return provider;
  const model = modelCatalog?.find((candidate) => sameComposerModelId(candidate.modelId, modelId));

  const binding = provider.models.find((candidate) =>
    sameComposerModelId(candidate.id, modelId),
  );
  const configuredLevels = binding
    ? THINKING_LEVELS.filter((level) => binding.thinkingLevels.includes(level))
    : undefined;

  if (model?.catalogSource !== "models.dev") {
    // Discovery/user rows are not trusted capability matches.
    // A binding override still takes precedence when present.
    // An empty binding is the generic seed for an unknown model, not an
    // explicit disable; `off` is the persisted opt-out for that case.
    const unmatchedLevels = configuredLevels?.length ? configuredLevels : undefined;
    const supportsReasoning = unmatchedLevels
      ? unmatchedLevels.some((level) => level !== "off")
      : true;
    return {
      ...provider,
      supportsReasoning,
      supportedThinkingLevels:
        unmatchedLevels ?? [...THINKING_LEVELS],
    };
  }

  const supportsReasoning = configuredLevels
    ? configuredLevels.some((level) => level !== "off")
    : model.reasoning === true || model.capabilities.includes("reasoning");
  return {
    ...provider,
    supportsReasoning,
    supportedThinkingLevels:
      configuredLevels ?? model.supportedThinkingLevels ?? provider.supportedThinkingLevels,
  };
}
