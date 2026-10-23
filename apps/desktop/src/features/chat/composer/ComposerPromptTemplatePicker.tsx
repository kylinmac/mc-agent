import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SystemPromptConfig } from "@pi-desktop/shared";
import { AnchoredMenu } from "../../../components/settings/AnchoredMenu";
import { TooltipButton } from "../../../components/ui";
import { IconCheck, IconChevronDown } from "../../../components/icons";
import { api } from "../../../lib/api";
import { isRemoteSession } from "../../../lib/remote-session-safety";
import { useAppStore } from "../../../stores/app-store";

/**
 * mc-agent (MC-ADR-0010): picks the system prompt template for a new, still
 * empty conversation. The choice is stored with the conversation and wins over
 * the project, model and global rules; "Follow the defaults" clears it. Once
 * the first message is sent the picker goes away: the prompt viewer in the
 * session info shows which template applied.
 */
export function ComposerPromptTemplatePicker({
  sessionId,
  controlsBlocked,
  onCloseOtherMenus,
}: {
  sessionId: string;
  controlsBlocked: boolean;
  onCloseOtherMenus: () => void;
}) {
  const { t } = useTranslation();
  const session = useAppStore((state) => state.sessions.find((candidate) => candidate.id === sessionId));
  const liveMessages = useAppStore((state) => state.messages.length);
  const setPage = useAppStore((state) => state.setPage);
  const setSettingsTab = useAppStore((state) => state.setSettingsTab);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [config, setConfig] = useState<SystemPromptConfig | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);

  useEffect(() => {
    let canceled = false;
    setChosen(null);
    api.getSessionPromptTemplate(sessionId).then(
      (result) => {
        if (!canceled) setChosen(result.templateId ?? null);
      },
      () => undefined,
    );
    return () => {
      canceled = true;
    };
  }, [sessionId]);

  // Templates are edited in Settings; read them on mount (for the chip's name)
  // and again each time the menu opens.
  useEffect(() => {
    let canceled = false;
    api.getSystemPromptConfig().then(
      (result) => {
        if (!canceled) setConfig(result.config);
      },
      () => undefined,
    );
    return () => {
      canceled = true;
    };
  }, [open, sessionId]);

  const empty = Boolean(session) && session!.messageCount === 0 && liveMessages === 0;
  if (!empty || isRemoteSession(session)) return null;

  const templates = config?.templates ?? [];
  const chosenName = chosen
    ? (templates.find((template) => template.id === chosen)?.name ?? "")
    : "";
  const select = async (templateId: string | null) => {
    setOpen(false);
    setBusy(true);
    try {
      const result = await api.setSessionPromptTemplate(sessionId, templateId);
      setChosen(result.templateId ?? null);
    } catch {
      // The menu is reread on the next open; keep the previous choice shown.
    } finally {
      setBusy(false);
    }
  };
  const manage = () => {
    setOpen(false);
    setSettingsTab("systemPrompts");
    setPage("settings");
  };
  const label = t("mcProject.sessionPromptLabel");

  return (
    <AnchoredMenu
      className="composer-permission composer-prompt-template"
      open={open}
      onClose={() => setOpen(false)}
      menuClassName="composer-permission-menu composer-prompt-template-menu"
      label={label}
      role="menu"
      align="start"
      side="top"
      trigger={(ref) => (
        <TooltipButton
          ref={ref}
          type="button"
          className={`icon-btn mode-chip ${open ? "active" : ""}`}
          tooltip={t("mcProject.sessionPromptTooltip")}
          ariaLabel={label}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={controlsBlocked || busy}
          onClick={() => {
            onCloseOtherMenus();
            setOpen((value) => !value);
          }}
        >
          <span className="text-sm composer-prompt-template-label">{chosenName || label}</span>
          <IconChevronDown size={12} />
        </TooltipButton>
      )}
    >
      <button
        type="button"
        role="menuitemradio"
        aria-checked={!chosen}
        className={`composer-plus-item ${!chosen ? "active" : ""}`}
        onClick={() => void select(null)}
      >
        <span className="flex-1 text-left">{t("mcProject.projectPromptDefault")}</span>
        {!chosen ? <IconCheck size={13} /> : null}
      </button>
      {templates.map((template) => (
        <button
          key={template.id}
          type="button"
          role="menuitemradio"
          aria-checked={chosen === template.id}
          className={`composer-plus-item ${chosen === template.id ? "active" : ""}`}
          onClick={() => void select(template.id)}
        >
          <span className="flex-1 text-left">{template.name || t("mcProject.promptUntitled")}</span>
          {chosen === template.id ? <IconCheck size={13} /> : null}
        </button>
      ))}
      <button type="button" role="menuitem" className="composer-plus-item" onClick={manage}>
        <span className="flex-1 text-left">{t("mcProject.projectPromptManage")}</span>
      </button>
    </AnchoredMenu>
  );
}
