import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ALCHEMY_BODY_MAX,
  ALCHEMY_DESCRIPTION_MAX,
  ALCHEMY_NAME_MAX,
  type AlchemyProposal,
  type AlchemyProposalDecision,
  type AlchemySkillScope,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { Button } from "../../components/ui";
import { IconCheck, IconClose } from "../../components/icons";
import { saveAlchemyArtifact } from "./save-from-proposal";
import { setAlchemySaving, useAlchemyProposals } from "./alchemy-store";

/*
 * mc-agent (R41): confirmation card for `ProposeAlchemyArtifact`.
 * Nothing is written until the user clicks Save.
 */

export function AlchemyProposalCard({ proposal }: { proposal: AlchemyProposal }) {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const saving = useAlchemyProposals((state) => Boolean(state.saving[proposal.requestId]));

  const [name, setName] = useState(proposal.name);
  const [description, setDescription] = useState(proposal.description);
  const [body, setBody] = useState(proposal.body);
  const [scope, setScope] = useState<AlchemySkillScope>(proposal.scope);
  const [errorText, setErrorText] = useState("");

  const isSkill = proposal.kind === "skill";
  const canUseProjectScope = Boolean(proposal.projectPath);
  const valid = name.trim().length > 0 && body.trim().length > 0 && (!isSkill || description.trim().length > 0);

  const resolve = async (decision: AlchemyProposalDecision) => {
    await api.mcAlchemy.resolve(proposal.requestId, decision);
  };

  const handleSave = async () => {
    if (!valid || saving) return;
    setErrorText("");
    setAlchemySaving(proposal.requestId, true);
    try {
      const decision = await saveAlchemyArtifact(
        {
          kind: proposal.kind,
          name,
          description,
          body,
          scope: canUseProjectScope ? scope : "global",
          projectPath: proposal.projectPath,
        },
        {
          createUserSkill: api.createUserSkill,
          getSystemPromptConfig: api.getSystemPromptConfig,
          setSystemPromptConfig: api.setSystemPromptConfig,
        },
      );
      if (decision.outcome === "failed") {
        setErrorText(decision.message);
        return;
      }
      await resolve(decision);
      showToast(t("mcProject.alchemySavedToast", { name: name.trim() }));
    } finally {
      setAlchemySaving(proposal.requestId, false);
    }
  };

  return (
    <section
      className="mc-alchemy-card"
      aria-label={isSkill ? t("mcProject.alchemyTitleSkill") : t("mcProject.alchemyTitlePromptTemplate")}
    >
      <header className="mc-alchemy-head">
        <div className="mc-alchemy-head-main">
          <span className="mc-alchemy-badge">
            {isSkill ? t("mcProject.alchemyKindSkill") : t("mcProject.alchemyKindPromptTemplate")}
          </span>
          <span className="mc-alchemy-title">
            {isSkill ? t("mcProject.alchemyTitleSkill") : t("mcProject.alchemyTitlePromptTemplate")}
          </span>
        </div>
        <button
          type="button"
          className="mc-alchemy-close"
          disabled={saving}
          aria-label={t("mcProject.alchemyCancel")}
          onClick={() => void resolve({ outcome: "canceled" })}
        >
          <IconClose size={14} />
        </button>
      </header>

      {proposal.note ? <p className="mc-alchemy-note">{proposal.note}</p> : null}

      <div className="mc-alchemy-fields">
        <label className="mc-alchemy-field">
          <span className="mc-alchemy-label">{t("mcProject.alchemyNameLabel")}</span>
          <input
            type="text"
            className="mc-alchemy-input"
            value={name}
            maxLength={ALCHEMY_NAME_MAX}
            disabled={saving}
            onChange={(event) => setName(event.target.value)}
          />
        </label>

        {isSkill ? (
          <label className="mc-alchemy-field">
            <span className="mc-alchemy-label">{t("mcProject.alchemyDescriptionLabel")}</span>
            <input
              type="text"
              className="mc-alchemy-input"
              value={description}
              maxLength={ALCHEMY_DESCRIPTION_MAX}
              disabled={saving}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
        ) : null}

        {isSkill ? (
          <div className="mc-alchemy-field">
            <span className="mc-alchemy-label">{t("mcProject.alchemyScopeLabel")}</span>
            <div className="mc-alchemy-scope-row" role="radiogroup" aria-label={t("mcProject.alchemyScopeLabel")}>
              <label className={`mc-alchemy-radio${!canUseProjectScope ? " is-disabled" : ""}`}>
                <input
                  type="radio"
                  name={`alchemy-scope-${proposal.requestId}`}
                  checked={scope === "project" && canUseProjectScope}
                  disabled={saving || !canUseProjectScope}
                  onChange={() => setScope("project")}
                />
                <span>{t("mcProject.alchemyScopeProject")}</span>
              </label>
              <label className="mc-alchemy-radio">
                <input
                  type="radio"
                  name={`alchemy-scope-${proposal.requestId}`}
                  checked={scope === "global" || !canUseProjectScope}
                  disabled={saving}
                  onChange={() => setScope("global")}
                />
                <span>{t("mcProject.alchemyScopeGlobal")}</span>
              </label>
            </div>
          </div>
        ) : null}

        <label className="mc-alchemy-field">
          <span className="mc-alchemy-label">{t("mcProject.alchemyBodyLabel")}</span>
          <textarea
            className="mc-alchemy-textarea"
            rows={7}
            value={body}
            maxLength={ALCHEMY_BODY_MAX}
            disabled={saving}
            onChange={(event) => setBody(event.target.value)}
          />
        </label>

        {proposal.refs.length > 0 ? (
          <div className="mc-alchemy-refs">
            <span className="mc-alchemy-label">{t("mcProject.alchemyRefsLabel")}</span>
            <div className="mc-alchemy-ref-list">
              {proposal.refs.map((ref) => (
                <code key={ref} className="mc-alchemy-ref-chip">
                  {ref}
                </code>
              ))}
            </div>
          </div>
        ) : null}

        {proposal.suggestedTrigger ? (
          <p className="mc-alchemy-trigger">
            {t("mcProject.alchemyTriggerHint", { trigger: proposal.suggestedTrigger })}
          </p>
        ) : null}

        {errorText ? (
          <p className="mc-alchemy-error" role="alert">
            {errorText}
          </p>
        ) : null}
      </div>

      <footer className="mc-alchemy-foot">
        <div className="mc-alchemy-foot-left">
          <Button
            variant="ghost"
            size="sm"
            disabled={saving}
            onClick={() => void resolve({ outcome: "revise" })}
          >
            {t("mcProject.alchemyRevise")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={saving}
            onClick={() => void resolve({ outcome: "canceled" })}
          >
            {t("mcProject.alchemyCancel")}
          </Button>
        </div>
        <Button variant="primary" size="sm" disabled={!valid || saving} onClick={() => void handleSave()}>
          <IconCheck size={14} />
          <span>{saving ? t("mcProject.alchemySaving") : t("mcProject.alchemySave")}</span>
        </Button>
      </footer>
    </section>
  );
}
