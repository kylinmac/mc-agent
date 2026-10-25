import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MacPermissionEntry, MacPermissionItem, MacPermissionReport, MacPermissionState } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { Button } from "../../components/ui";
import { SettingsCard } from "./primitives";

/*
  mc-agent (X-PERM-02): the macOS permissions each feature needs, checked
  where they are used, with the step that grants each one. Checking never
  prompts; a prompt or a settings page only follows a click. The page checks
  again when the window comes back to the front, at most every few seconds,
  and stops listening when it closes.
*/

const RECHECK_MS = 2_000;

const PURPOSE_KEYS: Record<MacPermissionItem, string> = {
  accessibility: "mcProject.permAccessibilityPurpose",
  screenRecording: "mcProject.permScreenRecordingPurpose",
  microphone: "mcProject.permMicrophonePurpose",
};

const NAME_KEYS: Record<MacPermissionItem, string> = {
  accessibility: "mcProject.permAccessibility",
  screenRecording: "mcProject.permScreenRecording",
  microphone: "mcProject.permMicrophone",
};

/** What a click can do in this state. */
function actionsFor(state: MacPermissionState): { request: boolean; settings: boolean; recheck: boolean } {
  switch (state) {
    case "notGranted":
      return { request: true, settings: true, recheck: false };
    case "notDetermined":
      return { request: true, settings: false, recheck: false };
    case "denied":
      return { request: false, settings: true, recheck: false };
    case "helperError":
    case "unknown":
      return { request: false, settings: false, recheck: true };
    default:
      return { request: false, settings: false, recheck: false };
  }
}

export function SystemPermissionsPage() {
  const { t } = useTranslation();
  const [report, setReport] = useState<MacPermissionReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<MacPermissionItem | "check" | null>(null);
  // Items the user asked for in this visit that still read as not granted.
  const [asked, setAsked] = useState<MacPermissionItem[]>([]);
  const lastCheck = useRef(0);

  const check = useCallback(async () => {
    lastCheck.current = Date.now();
    try {
      setReport(await api.macPermissions.check());
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, []);

  useEffect(() => {
    void check();
    const again = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastCheck.current < RECHECK_MS) return;
      void check();
    };
    window.addEventListener("focus", again);
    document.addEventListener("visibilitychange", again);
    return () => {
      window.removeEventListener("focus", again);
      document.removeEventListener("visibilitychange", again);
    };
  }, [check]);

  const act = async (item: MacPermissionItem, action: () => Promise<unknown>) => {
    setBusy(item);
    try {
      const next = await action();
      if (next && typeof next === "object" && "items" in next) setReport(next as MacPermissionReport);
      setAsked((current) => (current.includes(item) ? current : [...current, item]));
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(null);
    }
  };

  const row = (entry: MacPermissionEntry) => {
    const actions = actionsFor(entry.state);
    const stillMissing = asked.includes(entry.item) && entry.state === "notGranted";
    return (
      <div key={entry.item} className="mc-perm-row">
        <div className="mc-perm-text">
          <div className="mc-perm-name">
            {t(NAME_KEYS[entry.item])}
            <span className={`mc-perm-state is-${entry.state}`}>{t(`mcProject.permState_${entry.state}`)}</span>
          </div>
          <div className="mc-perm-purpose">{t(PURPOSE_KEYS[entry.item])}</div>
          {entry.detail ? <div className="mc-perm-detail">{entry.detail}</div> : null}
          {entry.state !== "granted" && entry.state !== "unsupported" ? (
            <div className="mc-perm-detail">{t("mcProject.permManualPath", {
                path: t(`mcProject.permSettingsPath_${entry.item}`, { defaultValue: entry.settingsPath }),
              })}</div>
          ) : null}
          {stillMissing ? <div className="mc-perm-detail">{t("mcProject.permRestartHint")}</div> : null}
        </div>
        <div className="mc-perm-actions">
          {actions.request ? (
            <Button
              size="sm"
              disabled={busy !== null}
              onClick={() => void act(entry.item, () => api.macPermissions.request(entry.item))}
            >
              {t("mcProject.permGrant")}
            </Button>
          ) : null}
          {actions.settings ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => void act(entry.item, () => api.macPermissions.openSettings(entry.item))}
            >
              {t("mcProject.permOpenSettings")}
            </Button>
          ) : null}
          {actions.recheck ? (
            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void check()}>
              {t("mcProject.permRecheck")}
            </Button>
          ) : null}
        </div>
      </div>
    );
  };

  const app = report?.app;
  return (
    <div className="settings-stack">
      <SettingsCard
        title={t("mcProject.permTitle")}
        description={t("mcProject.permDesc")}
        action={
          <Button
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            onClick={() => {
              setBusy("check");
              void check().finally(() => setBusy(null));
            }}
          >
            {t("mcProject.permRecheck")}
          </Button>
        }
      >
        <div className="mc-perm-list">
          {report ? report.items.map(row) : <div className="mc-perm-detail">{t("mcProject.permChecking")}</div>}
          {error ? <div className="mc-perm-detail mc-perm-error">{error}</div> : null}
        </div>
      </SettingsCard>

      {app ? (
        <SettingsCard title={t("mcProject.permIdentityTitle")}>
          <div className="mc-perm-list">
            <div className="mc-perm-row">
              <div className="mc-perm-text">
                <div className="mc-perm-purpose">
                  {t("mcProject.permIdentity", { name: app.name, path: app.bundlePath ?? "?" })}
                </div>
                {app.signature === "adhoc" ? (
                  <div className="mc-perm-detail">{t("mcProject.permAdhocNote")}</div>
                ) : null}
                <div className="mc-perm-detail">{t("mcProject.permApprovalNote")}</div>
                <details className="mc-perm-diagnostics">
                  <summary>{t("mcProject.permDiagnostics")}</summary>
                  <dl>
                    <dt>Bundle ID</dt>
                    <dd>{app.bundleId ?? "—"}</dd>
                    <dt>{t("mcProject.permVersion")}</dt>
                    <dd>{app.version}</dd>
                    <dt>{t("mcProject.permSignature")}</dt>
                    <dd>{app.signature}</dd>
                    <dt>{t("mcProject.permHelper")}</dt>
                    <dd>{app.helperPath ? `${app.helperPath} (pid ${app.helperPid})` : t("mcProject.permHelperNotRunning")}</dd>
                  </dl>
                </details>
              </div>
            </div>
          </div>
        </SettingsCard>
      ) : null}
    </div>
  );
}
