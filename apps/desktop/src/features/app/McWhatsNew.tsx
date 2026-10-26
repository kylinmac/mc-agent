import { lazy, Suspense, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { mcReleaseNotesSince, type ChangelogEntry } from "@pi-desktop/shared";
import { api } from "../../lib/api";

const ReleaseNotesDialog = lazy(() =>
  import("../../components/ReleaseNotesDialog").then((module) => ({ default: module.ReleaseNotesDialog })),
);

/*
  mc-agent (MC-ADR-0017): after an update, show once what changed since the
  version this installation last showed. The notes are bundled with the app,
  so nothing is fetched. A version with nothing user-visible is recorded
  without a dialog; a fresh install records its version and shows nothing.
*/
export function McWhatsNew() {
  const { t, i18n } = useTranslation();
  const [notes, setNotes] = useState<{ version: string; entries: ChangelogEntry[] } | null>(null);

  useEffect(() => {
    let active = true;
    void api.mcReleaseNotesState().then(({ version, lastSeen, existingInstall }) => {
      if (!active || !version || version === lastSeen) return;
      const entries = mcReleaseNotesSince(lastSeen, version, {
        locale: i18n.resolvedLanguage ?? i18n.language,
        existingInstall,
      });
      if (entries.length) setNotes({ version, entries });
      else void api.mcReleaseNotesSeen(version).catch(() => undefined);
    }, () => undefined);
    return () => {
      active = false;
    };
    // Once per launch; a language change later does not reopen it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!notes) return null;
  const close = () => {
    void api.mcReleaseNotesSeen(notes.version).catch(() => undefined);
    setNotes(null);
  };
  return (
    <Suspense fallback={null}>
      <ReleaseNotesDialog
        currentVersion={notes.version}
        entries={notes.entries}
        title={t("mcProject.whatsNewTitle", { version: notes.version })}
        onClose={close}
      />
    </Suspense>
  );
}
