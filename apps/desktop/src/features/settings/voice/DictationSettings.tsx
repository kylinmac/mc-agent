import { useEffect, useState } from "react";
import type { ComponentProps } from "react";
import { DICTATION_DEFAULT_MODELS, dictationProviderMatches, type DictationAdapter, type DictationSettings as Settings, type ProviderPublic } from "@pi-desktop/shared";
import { Input, SettingsToggle } from "../../../components/ui";
import { SettingsMenuSelect } from "../../../components/settings/SettingsMenuSelect";
import { SettingsCard, SettingsRow } from "../primitives";
import { api } from "../../../lib/api";
import { useAppStore } from "../../../stores/app-store";
import type { LiveVoiceSettings } from "./LiveVoiceSettings";
import { dictationHoldKeys } from "../../voice/dictation/dictation-hold";

export function DictationSettings({ t, settings, saveSettings }: ComponentProps<typeof LiveVoiceSettings>) {
  const value = settings.dictation ?? { enabled: false, adapter: "codex", providerId: "", modelId: "" };
  const [providers, setProviders] = useState<ProviderPublic[]>([]);
  const [saving, setSaving] = useState(false);
  const [model, setModel] = useState(value.modelId);
  const showToast = useAppStore((state) => state.showToast);
  useEffect(() => { setModel(value.modelId); }, [value.modelId]);
  useEffect(() => {
    let alive = true;
    void api.listProviders().then((result) => { if (alive) setProviders(result.providers); })
      .catch(() => { if (alive) showToast(t("dictation.providersFailed"), { variant: "error" }); });
    return () => { alive = false; };
  }, []);
  const choices = providers.filter((provider) => dictationProviderMatches(value.adapter, provider) && provider.hasSecret);
  const save = async (patch: Partial<Settings>) => {
    setSaving(true);
    try { await saveSettings({ dictation: { ...value, ...patch } }); }
    catch { showToast(t("dictation.saveFailed"), { variant: "error" }); }
    finally { setSaving(false); }
  };
  return <SettingsCard title={t("dictation.title")} description={t("dictation.description")}>
    <SettingsRow title={t("dictation.enabled")}>
      <SettingsToggle label={t("dictation.enabled")} checked={value.enabled} disabled={saving || (!value.enabled && !choices.some((p) => p.id === value.providerId))} onChange={() => { void save({ enabled: !value.enabled }); }} />
    </SettingsRow>
    {!value.enabled && !choices.some((p) => p.id === value.providerId) ? <p className="live-voice-hint">{t("dictation.chooseAccountHint")}</p> : null}
    <SettingsRow title={t("dictation.adapter")}>
      <SettingsMenuSelect label={t("dictation.adapter")} value={value.adapter} disabled={saving}
        options={(["codex", "openai", "gemini", "xai"] as const).map((id) => ({ id, label: t(`dictation.adapters.${id}`) }))}
        onChange={(id) => {
          const adapter = id as DictationAdapter;
          const provider = providers.find((p) => p.hasSecret && dictationProviderMatches(adapter, p));
          void save({ adapter, enabled: false, providerId: provider?.id ?? "", modelId: DICTATION_DEFAULT_MODELS[adapter] });
        }} />
    </SettingsRow>
    <SettingsRow title={t("dictation.provider")}>
      <SettingsMenuSelect label={t("dictation.provider")} value={value.providerId} disabled={saving}
        options={[{ id: "", label: t("dictation.chooseProvider") }, ...choices.map((p) => ({ id: p.id, label: p.name }))]}
        onChange={(providerId) => { void save({ providerId, enabled: providerId ? value.enabled : false }); }} />
    </SettingsRow>
    {value.adapter !== "codex" ? <SettingsRow title={t("dictation.model")}>
      <Input aria-label={t("dictation.model")} value={model} disabled={saving} maxLength={160}
        onChange={(event) => setModel(event.currentTarget.value)} onBlur={() => { if (model.trim()) void save({ modelId: model.trim() }); else setModel(value.modelId); }} />
    </SettingsRow> : <p className="live-voice-hint">{t("dictation.codexHint")}</p>}
    <p className="live-voice-hint">{t("dictation.hint")}</p>
    {/* mc-agent: hold-to-talk, set under Settings → Shortcuts. */}
    {dictationHoldKeys(settings.keybindings) ? <p className="live-voice-hint">{t("mcProject.dictationHoldSettingsHint", { keys: dictationHoldKeys(settings.keybindings) })}</p> : null}
  </SettingsCard>;
}
