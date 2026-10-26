import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectLocationPreference } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { Button } from "../../components/ui";
import { IconPlus, IconTrash } from "../../components/icons";
import { SettingsCard } from "../settings/primitives";

/**
 * mc-agent (MC-ADR-0023): the folders new projects go in. Each says what
 * goes there, so the agent can put a video project and a code project in
 * different places; the first is the default. With none, the agent suggests
 * the folder most existing projects live in.
 */
export function DefaultProjectLocation() {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const [locations, setLocations] = useState<ProjectLocationPreference[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const apply = (next: ProjectLocationPreference[]) => {
    setLocations(next);
    setNotes(Object.fromEntries(next.map((location) => [location.path, location.note])));
  };

  useEffect(() => {
    let canceled = false;
    void api.mcProjectCreate.locations().then(
      (result) => !canceled && apply(result.locations),
      () => undefined,
    );
    return () => {
      canceled = true;
    };
  }, []);

  const save = async (next: ProjectLocationPreference[]) => {
    setBusy(true);
    try {
      apply((await api.mcProjectCreate.setLocations(next)).locations);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    try {
      const { path } = await api.mcProjectCreate.pickParent(locations[0]?.path);
      if (!path || locations.some((location) => location.path === path)) return;
      await save([...locations, { path, note: "" }]);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    }
  };

  const saveNote = (path: string) => {
    const note = (notes[path] ?? "").trim();
    if (locations.find((location) => location.path === path)?.note === note) return;
    void save(locations.map((location) => (location.path === path ? { ...location, note } : location)));
  };

  return (
    <SettingsCard
      title={t("mcProject.npDefaultLocationCard")}
      description={t("mcProject.npDefaultLocationHelp")}
      action={
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void add()}>
          <IconPlus size={14} aria-hidden />
          {t("mcProject.npDefaultLocationAdd")}
        </Button>
      }
    >
      {locations.length === 0 ? (
        <div className="settings-row">
          <div className="settings-row-copy mc-np-muted">{t("mcProject.npDefaultLocationAuto")}</div>
        </div>
      ) : (
        locations.map((location, index) => (
          <div key={location.path} className="settings-row mc-np-location">
            <div className="settings-row-copy mc-np-location-copy">
              <div className="settings-row-title mc-np-default-path">
                {location.path}
                {index === 0 ? <span className="mc-np-badge">{t("mcProject.npDefaultLocationDefault")}</span> : null}
              </div>
              <input
                className="mc-np-location-note"
                value={notes[location.path] ?? ""}
                maxLength={200}
                placeholder={t("mcProject.npDefaultLocationNote")}
                aria-label={t("mcProject.npDefaultLocationNote")}
                disabled={busy}
                onChange={(event) => setNotes((current) => ({ ...current, [location.path]: event.target.value }))}
                onBlur={() => saveNote(location.path)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
            </div>
            <div className="settings-row-control">
              {index > 0 ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void save([location, ...locations.filter((item) => item.path !== location.path)])}
                >
                  {t("mcProject.npDefaultLocationMakeDefault")}
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                aria-label={t("mcProject.npDefaultLocationRemove")}
                title={t("mcProject.npDefaultLocationRemove")}
                onClick={() => void save(locations.filter((item) => item.path !== location.path))}
              >
                <IconTrash size={14} />
              </Button>
            </div>
          </div>
        ))
      )}
    </SettingsCard>
  );
}
