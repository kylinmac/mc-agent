import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { canRequestFastMode, fastModeEnabled, fastModeKey } from "@pi-desktop/shared";
import { TooltipButton } from "../../../components/ui";
import { IconLightning } from "../../../components/icons";
import { useAppStore } from "../../../stores/app-store";
import { api } from "../../../lib/api";
import "../../../styles/mc-fast-mode.css";

let saveQueue: Promise<void> = Promise.resolve();
export function ComposerFastMode({ providerId, modelId, disabled = false }: { providerId?: string; modelId?: string; disabled?: boolean }) {
  const { t } = useTranslation();
  const provider = useAppStore((s) => s.providers.find((p) => p.id === providerId));
  const preferences = useAppStore((s) => s.settings?.fastModeBindings);
  const ready = useAppStore((s) => Boolean(s.settings));
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const binding = provider && modelId ? { ...provider, modelId } : null;
  const supported = binding && canRequestFastMode(binding);
  const enabled = binding ? fastModeEnabled(preferences, binding) : false;
  const label = t(enabled ? "chat.fastModeOn" : "chat.fastModeOff");
  const toggle = async () => {
    if (!binding || !supported || pending.current || disabled) return;
    pending.current = true; setSaving(true);
    const key = fastModeKey(binding.id, binding.modelId);
    const save = saveQueue.then(async () => {
      const settings = useAppStore.getState().settings;
      if (!settings) throw new Error(t("chat.fastModeUnavailable"));
      const fastModeBindings = { ...settings.fastModeBindings, [key]: !enabled };
      await api.setSettings({ fastModeBindings });
      useAppStore.setState((s) => ({ settings: s.settings ? { ...s.settings, fastModeBindings } : s.settings }));
    });
    saveQueue = save.catch(() => {});
    try { await save; }
    catch (error) { useAppStore.getState().showToast(error instanceof Error ? error.message : String(error), { variant: "error" }); }
    finally { pending.current = false; setSaving(false); }
  };
  return <TooltipButton className={`icon-btn icon-btn-square mc-fast-mode${enabled ? " is-active" : ""}`}
    ariaLabel={label} aria-pressed={enabled} aria-busy={saving}
    tooltip={supported ? `${label} · ${t("chat.fastModeHelp")}` : t("chat.fastModeUnavailable")}
    disabled={disabled || !supported || !ready || saving} onClick={() => void toggle()}>
    <IconLightning size={14} aria-hidden="true" />
  </TooltipButton>;
}
