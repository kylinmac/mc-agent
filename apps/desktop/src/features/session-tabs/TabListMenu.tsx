import type { MouseEvent, RefObject } from "react";
import { useTranslation } from "react-i18next";
import { AnchoredMenu } from "../../components/settings/AnchoredMenu";
import { Button, TooltipButton } from "../../components/ui";
import { IconCheck, IconClose } from "../../components/icons";
import { useBlockingOverlay } from "../../lib/blocking-overlay";

export function TabListMenu({ open, anchorRef, label, keys, activeKey, titleOf, onClose, onSelect, onCloseTab, onContextMenu }: {
  open: boolean;
  anchorRef: RefObject<HTMLButtonElement | null>;
  label: string;
  keys: readonly string[];
  activeKey: string | null;
  titleOf: (key: string) => string;
  onClose: () => void;
  onSelect: (key: string) => void;
  onCloseTab: (key: string) => void;
  onContextMenu: (event: MouseEvent<HTMLElement>, key: string) => void;
}) {
  const { t } = useTranslation();
  useBlockingOverlay(open);
  return <AnchoredMenu
    open={open} onClose={onClose} anchorRef={anchorRef} trigger={() => null}
    label={label} role="dialog" menuClassName="settings-menu-select-menu mc-tab-list-menu no-drag"
    onMenuKeyDown={(event) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".mc-tab-menu-select")];
      const row = (event.target as HTMLElement).closest("[data-menu-tab]");
      const index = buttons.findIndex((button) => row?.contains(button));
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      event.preventDefault();
      buttons[next]?.focus();
    }}
  >
    <div className="mc-tab-menu-heading">{label}</div>
    {keys.map((key) => {
      const title = titleOf(key);
      return <div className="mc-tab-menu-row" data-menu-tab={key} key={key}
        onContextMenu={(event) => onContextMenu(event, key)}>
        <Button variant="ghost" className="mc-tab-menu-select" aria-current={key === activeKey ? "page" : undefined}
          title={title} onClick={() => { onSelect(key); onClose(); }}>
          <span className="mc-session-tab-title">{title}</span>
          {key === activeKey && <IconCheck size={13} aria-hidden />}
        </Button>
        <TooltipButton className="mc-tab-menu-close" tooltip={t("mcProject.sessionTabClose", { title })}
          onClick={(event) => {
            const row = event.currentTarget.closest("[data-menu-tab]");
            const next = row?.nextElementSibling ?? row?.previousElementSibling;
            next?.querySelector<HTMLButtonElement>(".mc-tab-menu-select")?.focus();
            onCloseTab(key);
          }}><IconClose size={13} aria-hidden /></TooltipButton>
      </div>;
    })}
  </AnchoredMenu>;
}
