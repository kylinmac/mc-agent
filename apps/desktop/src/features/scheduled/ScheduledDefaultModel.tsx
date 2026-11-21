import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import type { ScheduledModelSelection } from "./ScheduledExecutionSettings";
import { ScheduledModelPicker } from "./ScheduledModelPicker";

export function ScheduledDefaultModel() {
  const { t } = useTranslation();
  const settings = useAppStore((s) => s.settings);
  const [draft, setDraft] = useState<ScheduledModelSelection>();
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!draft || !settings || saving) return;
    setSaving(true);
    const scheduledDefaultModel = draft.providerId && draft.modelId ? draft : null;
    try {
      await api.setSettings({ scheduledDefaultModel });
      useAppStore.setState((s) => ({
        settings: s.settings ? { ...s.settings, scheduledDefaultModel } : s.settings,
      }));
      setDraft(undefined);
    } catch (error) {
      useAppStore.getState().showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="mc-sched-default-model" role="group" aria-label={t("mcProject.schedDefaultModel")}>
      <span>{t("mcProject.schedDefaultModel")}</span>
      <ScheduledModelPicker value={draft ?? settings?.scheduledDefaultModel ?? {}}
        disabled={saving || !settings} onChange={setDraft} />
      {draft && <Button disabled={saving} onClick={() => void save()}>
        {t(saving ? "common.saving" : "common.save")}
      </Button>}
    </div>
  );
}
