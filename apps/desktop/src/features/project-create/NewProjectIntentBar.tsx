import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui";
import { IconClose, IconNewProject } from "../../components/icons";
import { looksLikeNewProject, NEW_PROJECT_PREFIX, useNewProjectIntent } from "./new-project-intent";

/**
 * mc-agent (MC-ADR-0023): above the home composer. When the draft carries the
 * new-project skill alias it says what sending will do; otherwise it appears
 * when the draft reads like a request for a project and offers to send it so.
 */
export function NewProjectIntentBar({
  draft,
  onCreate,
  onLeave,
}: {
  draft: string;
  /** Send the draft as a project request. */
  onCreate: () => void;
  /** Drop the alias and go back to an ordinary message. */
  onLeave: () => void;
}) {
  const { t } = useTranslation();
  const dismissedFor = useNewProjectIntent((state) => state.dismissedFor);
  const dismiss = useNewProjectIntent((state) => state.dismiss);

  if (draft.startsWith(NEW_PROJECT_PREFIX)) {
    return (
      <div className="mc-np-intent is-armed" role="status">
        <IconNewProject size={15} aria-hidden />
        <span className="mc-np-intent-copy">
          <span className="mc-np-intent-title">{t("mcProject.npArmedTitle")}</span>
          <span className="mc-np-intent-hint">{t("mcProject.npArmedHint")}</span>
        </span>
        <button
          type="button"
          className="mc-np-close"
          aria-label={t("mcProject.npArmedCancel")}
          title={t("mcProject.npArmedCancel")}
          onClick={onLeave}
        >
          <IconClose size={14} />
        </button>
      </div>
    );
  }
  if (!looksLikeNewProject(draft) || dismissedFor === draft.trim()) return null;
  return (
    <div className="mc-np-intent" role="status">
      <span className="mc-np-intent-copy">
        <span className="mc-np-intent-title">{t("mcProject.npIntentTitle")}</span>
        <span className="mc-np-intent-hint">{t("mcProject.npIntentHint")}</span>
      </span>
      <div className="mc-np-actions">
        <Button size="sm" variant="ghost" onClick={() => dismiss(draft)}>
          {t("mcProject.npJustChat")}
        </Button>
        <Button size="sm" variant="primary" onClick={onCreate}>
          {t("mcProject.npCreateAsProject")}
        </Button>
      </div>
    </div>
  );
}
