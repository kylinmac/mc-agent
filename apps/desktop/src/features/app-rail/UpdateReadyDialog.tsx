import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, portalOverlay } from "../../components/ui";
import { IconRefresh } from "../../components/icons";
import { useUpdateState } from "../../hooks/use-update-state";
import { api } from "../../lib/api";

/*
  mc-agent: when an update finishes downloading, ask once whether to restart
  into it now. "Later" leaves the rail button (green) to restart any time.
*/
const asked = new Set<string>();

export function UpdateReadyDialog() {
  const { t } = useTranslation();
  const update = useUpdateState();
  const ready = update?.status === "downloaded" && update.availableVersion ? update.availableVersion : null;
  const [open, setOpen] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    if (!ready || asked.has(ready)) return;
    asked.add(ready);
    setOpen(ready);
  }, [ready]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open || ready !== open) return null;
  return portalOverlay(
    <div
      className="overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) setOpen(null);
      }}
    >
      <div className="dialog mc-update-ready" role="alertdialog" aria-modal="true" aria-labelledby="mc-update-ready-title">
        <div className="mc-update-ready-icon" aria-hidden>
          <IconRefresh size={18} />
        </div>
        <h2 id="mc-update-ready-title">{t("mcProject.updateReadyTitle", { version: open })}</h2>
        <p>{t("mcProject.updateReadyBody")}</p>
        <div className="mc-update-ready-actions">
          <Button variant="ghost" onClick={() => setOpen(null)}>
            {t("mcProject.updateLater")}
          </Button>
          <Button
            variant="primary"
            disabled={restarting}
            onClick={() => {
              setRestarting(true);
              void api.updatesInstall().catch(() => setRestarting(false));
            }}
          >
            {t("mcProject.updateRestartNow")}
          </Button>
        </div>
      </div>
    </div>,
  );
}
