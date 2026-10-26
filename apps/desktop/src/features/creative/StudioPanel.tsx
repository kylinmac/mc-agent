import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { imageResolutionsFor, parseImageGenerationBinding, type ImageGenerationBinding, type ImageResolution } from "@pi-desktop/shared";
import {
  imageGenerationBindingAvailable,
  imageGenerationPickerCandidates,
} from "../../components/settings/image-generation-default";
import { Button, cx } from "../../components/ui";
import { IconPlus, IconX } from "../../components/icons";
import { useAppStore } from "../../stores/app-store";
import type { CreativeRole } from "./creative-types";
import { ROLE_HINT_KEYS, ROLE_LABEL_KEYS, type CategoryNode, type FormReference } from "./creative-model";
import { StudioChat, type StudioChatExtra } from "./StudioChat";
import { useAssetImage } from "./use-creative";

const ROLES: CreativeRole[] = ["reference", "edit", "style"];
const MODEL_KEY = "mc.creative.model.";

function modelKey(binding: ImageGenerationBinding): string {
  return `${binding.providerId}\u0000${binding.modelId}`;
}

function readModel(groupId: string): string | null {
  try {
    return localStorage.getItem(MODEL_KEY + groupId);
  } catch {
    return null;
  }
}

function storeModel(groupId: string, key: string) {
  try {
    localStorage.setItem(MODEL_KEY + groupId, key);
  } catch {
    // Remembering the choice is a convenience only.
  }
}
const COUNTS = [1, 2, 3, 4];
/** Shapes the studio offers; "" leaves it to the model. */
export const ASPECT_RATIOS = ["", "1:1", "3:2", "2:3", "16:9", "9:16"] as const;
const RESOLUTION_LABEL_KEYS = {
  "1k": "mcProject.creativeResolution1k",
  "2k": "mcProject.creativeResolution2k",
  "4k": "mcProject.creativeResolution4k",
} as const;
const RESOLUTION_HINT_KEYS = {
  "1k": "mcProject.creativeResolution1kHint",
  "2k": "mcProject.creativeResolution2kHint",
  "4k": "mcProject.creativeResolution4kHint",
} as const;
const RATIO_HINT_KEYS = {
  "": "mcProject.creativeAspectAutoHint",
  "1:1": "mcProject.creativeAspectSquare",
  "3:2": "mcProject.creativeAspectLandscape",
  "2:3": "mcProject.creativeAspectPortrait",
  "16:9": "mcProject.creativeAspectWide",
  "9:16": "mcProject.creativeAspectTall",
} as const;

/** A small outline of the shape, so the choice reads at a glance. */
function RatioGlyph({ ratio }: { ratio: string }) {
  if (!ratio) return null;
  const [w, h] = ratio.split(":").map(Number);
  const scale = 12 / Math.max(w, h);
  return <span className="mc-creative-ratio-glyph" style={{ width: Math.round(w * scale), height: Math.round(h * scale) }} aria-hidden />;
}

function ReferenceRow({
  groupId,
  reference,
  position,
  onRole,
  onRemove,
}: {
  groupId: string;
  reference: FormReference;
  position: number;
  onRole: (role: CreativeRole) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const url = useAssetImage(groupId, reference.assetId, 160);
  return (
    <li className="mc-creative-ref">
      <span className="mc-creative-ref-index">{position}</span>
      <span className="mc-creative-ref-thumb">{url ? <img src={url} alt="" draggable={false} /> : null}</span>
      <select
        className="mc-creative-select"
        value={reference.role}
        aria-label={t("mcProject.creativeRole")}
        title={t(ROLE_HINT_KEYS[reference.role])}
        onChange={(event) => onRole(event.target.value as CreativeRole)}
      >
        {ROLES.map((role) => (
          <option key={role} value={role} title={t(ROLE_HINT_KEYS[role])}>
            {t(ROLE_LABEL_KEYS[role])}
          </option>
        ))}
      </select>
      <button type="button" className="mc-creative-icon-button" aria-label={t("mcProject.creativeRemoveReference")} onClick={onRemove}>
        <IconX size={13} />
      </button>
    </li>
  );
}

const TAB_KEY = "mc.creative.tab";

function readTab(): "direct" | "chat" {
  try {
    return localStorage.getItem(TAB_KEY) === "chat" ? "chat" : "direct";
  } catch {
    return "direct";
  }
}

/**
 * The studio's working panel: 直出 (generate straight from a prompt with the
 * chosen image model, into a category) or 对话 (a compact conversation in the
 * project that can draw with code or call the image model).
 */
export function StudioPanel({
  groupId,
  projectPath,
  prompt,
  onPrompt,
  references,
  onReferences,
  onAddReference,
  categories,
  category,
  onCategory,
  chatContext = "",
  chatContextCount = 0,
  chatContextLabel,
  chatExtra,
  aspectRatio,
  onAspectRatio,
  resolution,
  onResolution,
  onGenerate,
}: {
  groupId: string;
  projectPath: string | null;
  prompt: string;
  onPrompt: (value: string) => void;
  references: FormReference[];
  onReferences: (next: FormReference[]) => void;
  onAddReference: () => void;
  categories: CategoryNode[];
  /** Where results go; "" is uncategorized. */
  category: string;
  onCategory: (category: string) => void;
  /** Sent ahead of each chat message (the images being compared). */
  chatContext?: string;
  chatContextCount?: number;
  chatContextLabel?: string;
  /** What the canvas adds to the chat. */
  chatExtra?: StudioChatExtra;
  /** The shape asked for ("" for the model's default). */
  aspectRatio: string;
  onAspectRatio: (ratio: string) => void;
  /** `1k` / `2k` / `4k`; only what the chosen model takes is offered. */
  resolution: string;
  onResolution: (resolution: string) => void;
  onGenerate: (input: {
    prompt: string;
    count: number;
    aspectRatio: string;
    resolution: string;
    references: FormReference[];
    model: ImageGenerationBinding;
    category: string;
  }) => Promise<void>;
}) {
  const { t } = useTranslation();
  const settings = useAppStore((state) => state.settings);
  const providers = useAppStore((state) => state.providers);
  const setPage = useAppStore((state) => state.setPage);
  const [tab, setTab] = useState<"direct" | "chat">(readTab);
  // Something sent from the canvas needs the conversation on screen.
  const wantsChat = Boolean(chatExtra?.chips.length || chatExtra?.request);
  useEffect(() => {
    if (wantsChat) setTab("chat");
  }, [wantsChat, chatExtra?.request?.id]);
  const [count, setCount] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const globalBinding = parseImageGenerationBinding(settings?.imageGeneration);
  // Every image model the app can run, as Settings lists them; the studio picks
  // one per project, starting from the global choice.
  const candidates = useMemo(
    () =>
      imageGenerationPickerCandidates(settings?.imageGenerationModels, settings?.imageGeneration, providers).filter(
        (candidate) =>
          imageGenerationBindingAvailable(
            providers.find((provider) => provider.id === candidate.providerId),
            candidate.modelId,
          ),
      ),
    [settings?.imageGenerationModels, settings?.imageGeneration, providers],
  );
  const [chosenKey, setChosenKey] = useState<string | null>(() => readModel(groupId));
  useEffect(() => setChosenKey(readModel(groupId)), [groupId]);
  const binding =
    candidates.find((candidate) => modelKey(candidate) === chosenKey) ??
    candidates.find((candidate) => globalBinding && modelKey(candidate) === modelKey(globalBinding)) ??
    candidates[0] ??
    null;
  const resolutions = binding
    ? imageResolutionsFor(providers.find((provider) => provider.id === binding.providerId)?.vendorKey, binding.modelId)
    : [];
  // A resolution the chosen model does not take falls back to its standard.
  const effectiveResolution = resolutions.includes(resolution as ImageResolution) ? resolution : "1k";
  const singleProvider = new Set(candidates.map((candidate) => candidate.providerId)).size <= 1;
  const providerName = (id: string) => providers.find((provider) => provider.id === id)?.name ?? id;
  const flat = useMemo(() => {
    const walk = (nodes: CategoryNode[]): CategoryNode[] => nodes.flatMap((node) => [node, ...walk(node.children)]);
    return walk(categories);
  }, [categories]);

  const switchTab = (next: "direct" | "chat") => {
    setTab(next);
    try {
      localStorage.setItem(TAB_KEY, next);
    } catch {
      // Remembering the tab is a convenience only.
    }
  };

  const submit = () => {
    if (!prompt.trim() || busy || !binding) return;
    setBusy(true);
    setError(null);
    void onGenerate({ prompt: prompt.trim(), count, aspectRatio, resolution: effectiveResolution, references, model: binding, category })
      .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)))
      .finally(() => setBusy(false));
  };

  return (
    <aside className="mc-creative-panel">
      <div className="mc-creative-segment mc-creative-panel-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "direct"} className={cx(tab === "direct" && "is-on")} onClick={() => switchTab("direct")}>
          {t("mcProject.creativeTabDirect")}
        </button>
        <button type="button" role="tab" aria-selected={tab === "chat"} className={cx(tab === "chat" && "is-on")} onClick={() => switchTab("chat")}>
          {t("mcProject.creativeTabChat")}
        </button>
      </div>

      {tab === "direct" ? (
        <div className="mc-creative-form">
          <div className="mc-creative-model">
            <span className="mc-creative-muted">{t("mcProject.creativeImageModel")}</span>
            {binding ? (
              <select
                className="mc-creative-select mc-creative-model-select"
                value={modelKey(binding)}
                aria-label={t("mcProject.creativeImageModel")}
                title={providerName(binding.providerId)}
                onChange={(event) => {
                  setChosenKey(event.target.value);
                  storeModel(groupId, event.target.value);
                }}
              >
                {candidates.map((candidate) => (
                  <option key={modelKey(candidate)} value={modelKey(candidate)}>
                    {singleProvider ? candidate.modelId : `${providerName(candidate.providerId)} · ${candidate.modelId}`}
                  </option>
                ))}
              </select>
            ) : (
              <button type="button" className="mc-creative-link" onClick={() => setPage("settings")}>
                {t("mcProject.creativeSetModel")}
              </button>
            )}
          </div>
          <textarea
            className="mc-creative-textarea"
            value={prompt}
            placeholder={t("mcProject.creativePromptPlaceholder")}
            onChange={(event) => onPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit();
            }}
          />
          <div className="mc-creative-field-block">
            <span className="mc-creative-muted">{t("mcProject.creativeAspect")}</span>
            <div className="mc-creative-ratios" role="radiogroup" aria-label={t("mcProject.creativeAspect")}>
              {ASPECT_RATIOS.map((ratio) => (
                <button
                  key={ratio || "auto"}
                  type="button"
                  role="radio"
                  aria-checked={aspectRatio === ratio}
                  className={cx("mc-creative-ratio", aspectRatio === ratio && "is-on")}
                  title={t(RATIO_HINT_KEYS[ratio])}
                  onClick={() => onAspectRatio(ratio)}
                >
                  <RatioGlyph ratio={ratio} />
                  {ratio || t("mcProject.creativeAspectAuto")}
                </button>
              ))}
            </div>
          </div>
          {resolutions.length > 1 ? (
            <div className="mc-creative-field-block">
              <span className="mc-creative-muted">{t("mcProject.creativeResolution")}</span>
              <div className="mc-creative-ratios" role="radiogroup" aria-label={t("mcProject.creativeResolution")}>
                {resolutions.map((value) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={effectiveResolution === value}
                    className={cx("mc-creative-ratio", effectiveResolution === value && "is-on")}
                    title={t(RESOLUTION_HINT_KEYS[value])}
                    onClick={() => onResolution(value)}
                  >
                    {t(RESOLUTION_LABEL_KEYS[value])}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          <div className="mc-creative-field-row">
            <label className="mc-creative-field">
              <span>{t("mcProject.creativeCount")}</span>
              <select className="mc-creative-select" value={count} onChange={(event) => setCount(Number(event.target.value))}>
                {COUNTS.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label className="mc-creative-field mc-creative-grow">
              <span>{t("mcProject.creativeSaveTo")}</span>
              <select
                className="mc-creative-select mc-creative-grow"
                value={category}
                onChange={(event) => onCategory(event.target.value)}
              >
                <option value="">{t("mcProject.creativeUncategorized")}</option>
                {flat.map((node) => (
                  <option key={node.path} value={node.path}>
                    {"\u3000".repeat(node.path.split("/").length - 1)}
                    {node.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="mc-creative-field-block">
            <div className="mc-creative-field-head">
              <span className="mc-creative-muted">
                {references.length
                  ? t("mcProject.creativeReferencesCount", { count: references.length })
                  : t("mcProject.creativeReferencesEmpty")}
              </span>
              <button type="button" className="mc-creative-link" onClick={onAddReference}>
                <IconPlus size={12} />
                {t("mcProject.creativeAddReference")}
              </button>
            </div>
            {references.length ? (
              <ol className="mc-creative-refs">
                {references.map((reference, index) => (
                  <ReferenceRow
                    key={reference.assetId}
                    groupId={groupId}
                    reference={reference}
                    position={index + 1}
                    onRole={(role) =>
                      onReferences(references.map((entry) => (entry.assetId === reference.assetId ? { ...entry, role } : entry)))
                    }
                    onRemove={() => onReferences(references.filter((entry) => entry.assetId !== reference.assetId))}
                  />
                ))}
              </ol>
            ) : null}
          </div>
          {error ? <p className="mc-creative-error">{error}</p> : null}
          <Button variant="primary" disabled={!binding || !prompt.trim() || busy} onClick={submit}>
            {busy ? t("mcProject.creativeQueuing") : t("mcProject.creativeGenerate")}
          </Button>
          <p className="mc-creative-muted">{t("mcProject.creativeFormHint")}</p>
        </div>
      ) : (
        <StudioChat
          groupId={groupId}
          projectPath={projectPath}
          context={chatContext}
          contextCount={chatContextCount}
          contextLabel={chatContextLabel}
          extra={chatExtra}
        />
      )}
    </aside>
  );
}
