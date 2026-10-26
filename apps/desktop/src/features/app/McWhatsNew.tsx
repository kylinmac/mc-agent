import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { mcReleaseNotesSince, type McChangelogEntry } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { Button, OverlayBackdrop, portalOverlay } from "../../components/ui";

/*
  mc-agent (MC-ADR-0017): after an update, show once what changed since the
  version this installation last showed. The notes are bundled with the app,
  so nothing is fetched. A version with nothing user-visible is recorded
  without a dialog; a fresh install records its version and shows nothing.
*/
export function McWhatsNew() {
  const { i18n } = useTranslation();
  const [notes, setNotes] = useState<{ version: string; entries: McChangelogEntry[] } | null>(null);

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
  return (
    <WhatsNewDialog
      version={notes.version}
      entries={notes.entries}
      onClose={() => {
        void api.mcReleaseNotesSeen(notes.version).catch(() => undefined);
        setNotes(null);
      }}
    />
  );
}

function WhatsNewDialog({ version, entries, onClose }: {
  version: string;
  entries: McChangelogEntry[];
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const doneRef = useRef<HTMLButtonElement | null>(null);
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(i18n.resolvedLanguage ?? i18n.language, { month: "long", day: "numeric", timeZone: "UTC" }),
    [i18n.resolvedLanguage, i18n.language],
  );
  const single = entries.length === 1;
  const date = single && entries[0].date ? dateFormatter.format(new Date(`${entries[0].date}T00:00:00Z`)) : null;

  useEffect(() => {
    doneRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return portalOverlay(
    <OverlayBackdrop
      className="overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="dialog mc-whats-new" role="dialog" aria-modal="true" aria-labelledby="mc-whats-new-title">
        <header className="mc-whats-new-header">
          <h2 id="mc-whats-new-title">{t("mcProject.whatsNewTitle")}</h2>
          <p>
            {t("mcProject.whatsNewVersion", { version })}
            {date ? ` · ${date}` : ""}
          </p>
        </header>
        <div className="mc-whats-new-body selectable">
          {entries.map((entry) => (
            <section key={entry.version} className="mc-whats-new-version">
              {single ? null : <h3>{entry.version}</h3>}
              {entry.sections.map((section) => (
                <div key={section.kind} className="mc-whats-new-group">
                  <h4>{t(`mcProject.changeKind_${section.kind}`)}</h4>
                  <ul>
                    {section.items.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          ))}
        </div>
        <footer className="mc-whats-new-footer">
          <span>{t("mcProject.whatsNewWhere")}</span>
          <Button ref={doneRef} variant="primary" onClick={onClose}>
            {t("mcProject.whatsNewDone")}
          </Button>
        </footer>
      </div>
    </OverlayBackdrop>,
  );
}
