import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppSettings } from "@pi-desktop/shared";
import { Input, SettingsToggle } from "../../components/ui";
import { SettingsCard, SettingsRow } from "./primitives";

export function AskToolSettings({ settings, saveSettings }: {
  settings: AppSettings;
  saveSettings: (settings: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const seconds = settings.askToolTimeoutSeconds ?? 30;
  const [draft, setDraft] = useState(String(seconds));
  useEffect(() => setDraft(String(seconds)), [seconds]);
  const value = Number(draft);
  const valid = draft.trim() !== "" && Number.isInteger(value) && value >= 10 && value <= 300;
  return (
    <SettingsCard title={t("settings.askToolTitle")}>
      <SettingsRow title={t("settings.askToolAutoContinue")} description={t("settings.askToolAutoContinueDesc")}>
        <SettingsToggle
          checked={settings.askToolAutoContinue === true}
          label={t("settings.askToolAutoContinue")}
          onChange={() => void saveSettings({ askToolAutoContinue: settings.askToolAutoContinue !== true })}
        />
      </SettingsRow>
      <SettingsRow title={t("settings.askToolTimeout")} description={t("settings.askToolTimeoutDesc")}>
        <Input
          type="number" min={10} max={300} step={1}
          aria-label={t("settings.askToolTimeout")}
          aria-invalid={!valid}
          value={draft}
          disabled={settings.askToolAutoContinue !== true}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            if (valid) void saveSettings({ askToolTimeoutSeconds: value });
            else setDraft(String(seconds));
          }}
          onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
        />
      </SettingsRow>
    </SettingsCard>
  );
}
