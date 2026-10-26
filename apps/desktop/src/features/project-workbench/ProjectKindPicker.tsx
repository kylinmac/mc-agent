import { useTranslation } from "react-i18next";
import { TemplatePicker } from "./TemplatePicker";
import { startConversationalProject } from "../project-create/start-conversational-project";

export type ProjectKind = "simple" | "managed";

/*
  What the create dialog makes (MC-ADR-0003 decision 12): a plain chat
  outside any project, a simple project (upstream's folders-only project), or
  a managed project with a resource folder from a template. A project is
  managed exactly when it has a resource folder, so no kind is stored; a
  simple project can be turned into a managed one later.
*/
export function ProjectKindPicker({
  kind,
  onKindChange,
  template,
  onTemplateChange,
  onStartChat,
  remote,
  disabled,
}: {
  kind: ProjectKind;
  onKindChange: (kind: ProjectKind) => void;
  template: string;
  onTemplateChange: (template: string) => void;
  /** Leaves the dialog and starts a chat outside any project. */
  onStartChat: () => void;
  /** Remote projects cannot have a resource folder. */
  remote: boolean;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  // "conversation" leaves the dialog for a chat that creates the project
  // (MC-ADR-0023); like "chat", it is an exit rather than a kind.
  const options: Array<{ value: ProjectKind | "chat" | "conversation"; label: string; hint: string }> = [
    { value: "chat", label: t("mcProject.kindChat"), hint: t("mcProject.kindChatHint") },
    { value: "conversation", label: t("mcProject.npKindConversation"), hint: t("mcProject.npKindConversationHint") },
    { value: "simple", label: t("mcProject.kindSimple"), hint: t("mcProject.kindSimpleHint") },
    { value: "managed", label: t("mcProject.kindManaged"), hint: t("mcProject.kindManagedHint") },
  ];
  return (
    <section className="project-create-dialog-section mc-kind-picker" aria-labelledby="mc-kind-heading">
      <div className="project-create-dialog-section-head">
        <h3 id="mc-kind-heading" className="project-create-dialog-section-title">
          {t("mcProject.kindLabel")}
        </h3>
      </div>
      <div className="mc-kind-options" role="group" aria-labelledby="mc-kind-heading">
        {options.map((option) => {
          const unavailable = (option.value === "managed" && remote) || (option.value === "conversation" && remote);
          const exits = option.value === "chat" || option.value === "conversation";
          const active = option.value === kind;
          return (
            <button
              key={option.value}
              type="button"
              className={`mc-kind-option${active ? " is-active" : ""}`}
              data-project-kind={option.value}
              aria-pressed={exits ? undefined : active}
              disabled={disabled || unavailable}
              title={unavailable ? t("mcProject.kindManagedRemote") : undefined}
              onClick={() => {
                if (option.value === "chat") onStartChat();
                else if (option.value === "conversation") void startConversationalProject();
                else onKindChange(option.value);
              }}
            >
              <span className="mc-kind-option-label">{option.label}</span>
              <span className="mc-kind-option-hint">{option.hint}</span>
            </button>
          );
        })}
      </div>
      <p className="mc-workbench-muted">{t("mcProject.kindPurposeNote")}</p>
      {kind === "managed" && !remote ? (
        <TemplatePicker value={template} onChange={onTemplateChange} disabled={disabled} />
      ) : null}
    </section>
  );
}
