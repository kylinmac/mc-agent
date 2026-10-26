import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  joinProjectPath,
  isValidProjectFolderName,
  type ProjectLocationCheck,
  type ProjectProposal,
  type ProjectProposalDecision,
  type ResourceTemplateSummary,
  type SystemPromptTemplate,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { Button } from "../../components/ui";
import { IconCheck, IconClose, IconFolder } from "../../components/icons";
import { createProjectFromPlan } from "./create-from-proposal";
import type { ConfirmedPlan } from "./plan";
import { beginCreation, endCreation, setCreationProgress, useProjectProposals } from "./proposal-store";

/*
  mc-agent (MC-ADR-0023): the card a `CreateProject` call waits on. Three
  steps — where it goes, which template, the plan — and only Create writes
  anything. Anything the user would rather say in words (change the draft,
  rethink the plan) goes back to the agent as the tool's answer.
*/

type Step = "location" | "template" | "confirm" | "creating";
type Choice =
  | { kind: "template"; name: string }
  | { kind: "draft" }
  | { kind: "request-draft" }
  | { kind: "none" };

function initialChoice(proposal: ProjectProposal): Choice {
  if (proposal.draft) return { kind: "draft" };
  if (proposal.templates[0]) return { kind: "template", name: proposal.templates[0] };
  return { kind: "request-draft" };
}

function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(gb >= 100 ? 0 : 1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

/** Parents first, children indented under them; implied parents are shown. */
function FolderTree({ folders }: { folders: string[] }) {
  const all = new Set<string>();
  for (const folder of folders) {
    const parts = folder.split("/");
    for (let end = 1; end <= parts.length; end += 1) all.add(parts.slice(0, end).join("/"));
  }
  const sorted = [...all].sort((a, b) => a.localeCompare(b));
  return (
    <ul className="mc-np-tree">
      {sorted.map((path) => {
        const parts = path.split("/");
        return (
          <li key={path} style={{ paddingInlineStart: `${(parts.length - 1) * 14}px` }}>
            {parts[parts.length - 1]}/
          </li>
        );
      })}
    </ul>
  );
}

export function ProjectProposalCard({ proposal }: { proposal: ProjectProposal }) {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const activateProject = useAppStore((state) => state.activateProject);
  const [name, setName] = useState(proposal.name);
  const [parent, setParent] = useState(proposal.parent);
  const [folder, setFolder] = useState(proposal.folder);
  const progress = useProjectProposals((state) => state.creating[proposal.requestId]);
  const [step, setStep] = useState<Step>(() => (progress ? "creating" : "location"));
  // The check answers for one parent/folder pair; a stale one is not shown.
  const [checked, setChecked] = useState<{ key: string; result: ProjectLocationCheck } | null>(null);
  const [checkFailed, setCheckFailed] = useState("");
  const [choice, setChoice] = useState<Choice>(() => initialChoice(proposal));
  const [saveDraft, setSaveDraft] = useState(false);
  const [templates, setTemplates] = useState<ResourceTemplateSummary[]>([]);
  const [prompts, setPrompts] = useState<SystemPromptTemplate[]>([]);
  const [busy, setBusy] = useState(Boolean(progress));
  const [promptOpen, setPromptOpen] = useState(false);

  const folderValid = isValidProjectFolderName(folder);
  const path = joinProjectPath(parent, folder);
  const checkKey = `${parent}\n${folder}`;
  const check = checked?.key === checkKey ? checked.result : null;
  // One clear match goes straight into the plan; a draft is always reviewed.
  // The user can still open the template step from the plan.
  const [showTemplateStep, setShowTemplateStep] = useState(
    () => !(proposal.templates.length === 1 && !proposal.draft),
  );

  useEffect(() => {
    let canceled = false;
    void api.listResourceTemplates().then(
      ({ templates: listed }) => !canceled && setTemplates(listed.filter((item) => item.target !== "creative")),
      () => undefined,
    );
    void api.getSystemPromptConfig().then(
      ({ config }) => !canceled && setPrompts(config.templates),
      () => undefined,
    );
    return () => {
      canceled = true;
    };
  }, []);

  useEffect(() => {
    if (!folderValid) return;
    let canceled = false;
    setCheckFailed("");
    const timer = setTimeout(() => {
      void api.mcProjectCreate.checkLocation(parent, folder).then(
        ({ check: result }) => !canceled && setChecked({ key: `${parent}\n${folder}`, result }),
        (error: unknown) => !canceled && setCheckFailed(error instanceof Error ? error.message : String(error)),
      );
    }, 200);
    return () => {
      canceled = true;
      clearTimeout(timer);
    };
  }, [parent, folder, folderValid]);

  const locationOk = folderValid && check !== null && !check.blocked && !check.project && check.writable;

  const answer = async (decision: ProjectProposalDecision) => {
    setBusy(true);
    try {
      const { ok } = await api.mcProjectCreate.resolve(proposal.requestId, decision);
      // The turn was stopped meanwhile: the agent will not hear about it.
      if (!ok && decision.outcome === "created") {
        showToast(t("mcProject.npCreatedAfterStop", { name: decision.name }), { variant: "info" });
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
      setBusy(false);
    }
  };

  const plan: ConfirmedPlan = {
    name: name.trim() || proposal.name,
    path: check?.path ?? path,
    ...(choice.kind === "template" ? { template: choice.name } : {}),
    ...(choice.kind === "draft" && proposal.draft ? { draft: proposal.draft, saveDraft } : {}),
    ...(proposal.promptTemplateId ? { promptTemplateId: proposal.promptTemplateId } : {}),
  };

  const create = async () => {
    setBusy(true);
    setStep("creating");
    beginCreation(proposal.requestId, plan);
    const decision = await createProjectFromPlan(plan, (key, state) =>
      setCreationProgress(proposal.requestId, key, state),
    );
    await answer(decision);
    endCreation(proposal.requestId);
  };

  const pickParent = async () => {
    try {
      const { path: picked } = await api.mcProjectCreate.pickParent(parent);
      if (picked) setParent(picked);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    }
  };

  const chosenTemplate = choice.kind === "template" ? templates.find((item) => item.name === choice.name) : undefined;
  const planFolders =
    choice.kind === "draft" && proposal.draft
      ? proposal.draft.folders.map((item) => item.path)
      : (chosenTemplate?.folders ?? chosenTemplate?.categories ?? []);
  const promptName = proposal.promptTemplateId
    ? (prompts.find((item) => item.id === proposal.promptTemplateId)?.name ?? proposal.promptTemplateId)
    : choice.kind === "draft" && proposal.draft?.systemPrompt
      ? t("mcProject.npPromptFromDraft")
      : t("mcProject.npPromptDefault");

  const rankedOptions = useMemo(
    () =>
      proposal.templates.map((templateName, index) => ({
        name: templateName,
        recommended: index === 0,
        summary: templates.find((item) => item.name === templateName),
      })),
    [proposal.templates, templates],
  );

  const stepNumber = step === "location" ? 1 : step === "template" ? 2 : 3;
  const stepTotal = showTemplateStep ? 3 : 2;

  const locationStatus = (() => {
    if (!folderValid) return { tone: "error", text: t("mcProject.npFolderInvalid") };
    if (checkFailed) return { tone: "error", text: checkFailed };
    if (!check) return { tone: "muted", text: t("mcProject.npChecking") };
    if (check.blocked) return { tone: "error", text: t("mcProject.npBlocked") };
    if (check.project) return { tone: "error", text: t("mcProject.npIsProject", { name: check.project }) };
    if (!check.writable) return { tone: "error", text: t("mcProject.npNotWritable") };
    const free = check.freeBytes ? ` · ${t("mcProject.npFree", { size: formatBytes(check.freeBytes) })}` : "";
    if (check.exists && check.entries > 0) {
      return { tone: "warning", text: t("mcProject.npExistsFull", { count: check.entries }) };
    }
    if (check.exists) return { tone: "ok", text: `${t("mcProject.npExistsEmpty")}${free}` };
    return { tone: "ok", text: `${t("mcProject.npWillCreate")}${free}` };
  })();

  const header = (
    <div className="mc-np-head">
      <div className="mc-np-head-main">
        <span className="mc-np-kicker">{t("mcProject.npKicker")}</span>
        <span className="mc-np-step">
          {step === "creating" ? t("mcProject.npCreating") : t("mcProject.npStep", { current: Math.min(stepNumber, stepTotal), total: stepTotal })}
        </span>
      </div>
      {step !== "creating" ? (
        <button
          type="button"
          className="mc-np-close"
          aria-label={t("mcProject.npDismiss")}
          title={t("mcProject.npDismiss")}
          disabled={busy}
          onClick={() => void answer({ outcome: "revise", name: plan.name, path, request: "The user closed the card." })}
        >
          <IconClose size={14} />
        </button>
      ) : null}
    </div>
  );

  if (step === "location") {
    return (
      <section className="mc-np-card" aria-label={t("mcProject.npKicker")}>
        {header}
        <h3 className="mc-np-title">{t("mcProject.npWhere")}</h3>
        {proposal.note ? <p className="mc-np-note">{proposal.note}</p> : null}
        <div className="mc-np-path">
          <IconFolder size={15} aria-hidden />
          <span className="mc-np-parent" title={parent}>{parent.replace(/[\\/]+$/, "")}/</span>
          <input
            className="mc-np-folder"
            value={folder}
            aria-label={t("mcProject.npFolderLabel")}
            spellCheck={false}
            disabled={busy}
            onChange={(event) => setFolder(event.target.value)}
          />
        </div>
        <div className="mc-np-foot">
          <span className={`mc-np-status is-${locationStatus.tone}`} role="status">
            {locationStatus.text}
          </span>
          <div className="mc-np-actions">
            {check?.project ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  void activateProject(check.path);
                  void answer({
                    outcome: "revise",
                    name: plan.name,
                    path: check.path,
                    request: `The folder is already the project "${check.project}"; the user opened it instead.`,
                  });
                }}
              >
                {t("mcProject.npOpenThatProject")}
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void pickParent()}>
              {t("mcProject.npChangeLocation")}
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={busy || !locationOk}
              onClick={() => setStep(showTemplateStep ? "template" : "confirm")}
            >
              {t("mcProject.npHere")}
            </Button>
          </div>
        </div>
      </section>
    );
  }

  if (step === "template" && choice.kind === "draft" && proposal.draft) {
    const draft = proposal.draft;
    return (
      <section className="mc-np-card" aria-label={t("mcProject.npKicker")}>
        {header}
        <div className="mc-np-title-row">
          <h3 className="mc-np-title">{t("mcProject.npDraftTitle", { name: draft.name })}</h3>
          <span className="mc-np-pill">{t("mcProject.npDraftUnsaved")}</span>
        </div>
        {draft.description ? <p className="mc-np-note">{draft.description}</p> : null}
        <div className="mc-np-draft">
          <div className="mc-np-panel">
            <span className="mc-np-label">{t("mcProject.npFolders")}</span>
            <FolderTree folders={draft.folders.map((item) => item.path)} />
          </div>
          <div className="mc-np-panel">
            <span className="mc-np-label">{t("mcProject.npFolderNotes")}</span>
            <dl className="mc-np-notes">
              {draft.folders
                .filter((item) => item.description)
                .map((item) => (
                  <div key={item.path}>
                    <dt>{item.path}</dt>
                    <dd>{item.description}</dd>
                  </div>
                ))}
            </dl>
          </div>
          <div className="mc-np-panel">
            <span className="mc-np-label">{t("mcProject.npSystemPrompt")}</span>
            {draft.systemPrompt ? (
              <>
                <p className={`mc-np-prompt${promptOpen ? " is-open" : ""}`}>{draft.systemPrompt}</p>
                {draft.systemPrompt.length > 120 || draft.systemPrompt.includes("\n") ? (
                  <button type="button" className="mc-np-link is-start" onClick={() => setPromptOpen((open) => !open)}>
                    {promptOpen ? t("mcProject.npCollapse") : t("mcProject.npExpand")}
                  </button>
                ) : null}
              </>
            ) : (
              <p className="mc-np-muted">{t("mcProject.npPromptDefault")}</p>
            )}
          </div>
        </div>
        <p className="mc-np-hint">{t("mcProject.npDraftHint")}</p>
        <div className="mc-np-foot">
          <div className="mc-np-actions is-start">
            <button type="button" className="mc-np-link" disabled={busy} onClick={() => setStep("location")}>
              {t("mcProject.npBack")}
            </button>
            <button type="button" className="mc-np-link" disabled={busy} onClick={() => setChoice({ kind: "none" })}>
              {t("mcProject.npNoTemplate")}
            </button>
          </div>
          <div className="mc-np-actions">
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setSaveDraft(true);
                setStep("confirm");
              }}
            >
              {t("mcProject.npSaveAndUse")}
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={busy}
              onClick={() => {
                setSaveDraft(false);
                setStep("confirm");
              }}
            >
              {t("mcProject.npUseOnce")}
            </Button>
          </div>
        </div>
      </section>
    );
  }

  if (step === "template") {
    const option = (key: string, selected: boolean, onSelect: () => void, label: string, hint?: string, badge?: string) => (
      <button
        key={key}
        type="button"
        role="radio"
        aria-checked={selected}
        className={`mc-np-option${selected ? " is-selected" : ""}${key === "__request-draft" ? " is-dashed" : ""}`}
        disabled={busy}
        onClick={onSelect}
      >
        <span className="mc-np-radio" aria-hidden />
        <span className="mc-np-option-copy">
          <span className="mc-np-option-label">
            {label}
            {badge ? <span className="mc-np-badge">{badge}</span> : null}
          </span>
          {hint ? <span className="mc-np-option-hint">{hint}</span> : null}
        </span>
      </button>
    );
    return (
      <section className="mc-np-card" aria-label={t("mcProject.npKicker")}>
        {header}
        <div className="mc-np-title-row">
          <h3 className="mc-np-title">{t("mcProject.npPickTemplate")}</h3>
          {rankedOptions.length > 1 ? <span className="mc-np-muted">{t("mcProject.npRanked")}</span> : null}
        </div>
        {proposal.note ? <p className="mc-np-note">{proposal.note}</p> : null}
        <div className="mc-np-options" role="radiogroup" aria-label={t("mcProject.npPickTemplate")}>
          {rankedOptions.map((item) =>
            option(
              item.name,
              choice.kind === "template" && choice.name === item.name,
              () => setChoice({ kind: "template", name: item.name }),
              item.name,
              item.summary?.description || item.summary?.categories.join(" / "),
              item.recommended && rankedOptions.length > 1 ? t("mcProject.npRecommended") : undefined,
            ),
          )}
          {proposal.draft
            ? option(
                "__draft",
                false,
                () => setChoice({ kind: "draft" }),
                t("mcProject.npDraftOption", { name: proposal.draft.name }),
                proposal.draft.description,
              )
            : null}
          {option(
            "__request-draft",
            choice.kind === "request-draft",
            () => setChoice({ kind: "request-draft" }),
            t("mcProject.npRequestDraft"),
            t("mcProject.npRequestDraftHint"),
          )}
          {option(
            "__none",
            choice.kind === "none",
            () => setChoice({ kind: "none" }),
            t("mcProject.npNoTemplate"),
            t("mcProject.npNoTemplateHint"),
          )}
        </div>
        <div className="mc-np-foot">
          <div className="mc-np-actions is-start">
            <button type="button" className="mc-np-link" disabled={busy} onClick={() => setStep("location")}>
              {t("mcProject.npBack")}
            </button>
          </div>
          <div className="mc-np-actions">
            {choice.kind === "request-draft" ? (
              <Button
                size="sm"
                variant="primary"
                disabled={busy}
                onClick={() => void answer({ outcome: "draft-requested", name: plan.name, path: plan.path })}
              >
                {t("mcProject.npAskDraft")}
              </Button>
            ) : (
              <Button size="sm" variant="primary" disabled={busy} onClick={() => setStep("confirm")}>
                {t("mcProject.npNext")}
              </Button>
            )}
          </div>
        </div>
      </section>
    );
  }

  if (step === "creating" && progress) {
    const shown = progress.plan;
    return (
      <section className="mc-np-card" aria-label={t("mcProject.npKicker")}>
        {header}
        <ol className="mc-np-progress">
          {progress.steps.map(({ step: key, state }) => (
            <li key={key} className={`is-${state}`}>
              <span className="mc-np-progress-mark" aria-hidden>
                {state === "done" ? <IconCheck size={13} /> : state === "failed" ? <IconClose size={13} /> : null}
              </span>
              {t(`mcProject.npProgress_${key}`, { path: shown.path, template: shown.template ?? shown.draft?.name ?? "" })}
            </li>
          ))}
        </ol>
      </section>
    );
  }

  const templateLabel =
    choice.kind === "template"
      ? choice.name
      : choice.kind === "draft" && proposal.draft
        ? t(saveDraft ? "mcProject.npDraftSaved" : "mcProject.npDraftOnce", { name: proposal.draft.name })
        : t("mcProject.npNoTemplate");
  return (
    <section className="mc-np-card" aria-label={t("mcProject.npKicker")}>
      {header}
      <h3 className="mc-np-title">{t("mcProject.npConfirmTitle")}</h3>
      <dl className="mc-np-plan">
        <dt>{t("mcProject.npName")}</dt>
        <dd>
          <input
            className="mc-np-name"
            value={name}
            maxLength={80}
            aria-label={t("mcProject.npName")}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
          />
        </dd>
        <dt>{t("mcProject.npLocation")}</dt>
        <dd>
          <button type="button" className="mc-np-plan-value is-mono" disabled={busy} onClick={() => setStep("location")}>
            {plan.path}
            <span className="mc-np-muted">
              {check?.exists ? t("mcProject.npExisting") : t("mcProject.npNew")}
            </span>
          </button>
        </dd>
        <dt>{t("mcProject.npTemplate")}</dt>
        <dd>
          <button
            type="button"
            className="mc-np-plan-value"
            disabled={busy}
            onClick={() => {
              setShowTemplateStep(true);
              setStep("template");
            }}
          >
            {templateLabel}
          </button>
        </dd>
        {planFolders.length ? (
          <>
            <dt>{t("mcProject.npResourceFolder")}</dt>
            <dd>
              <FolderTree folders={planFolders} />
            </dd>
          </>
        ) : null}
        <dt>{t("mcProject.npSystemPrompt")}</dt>
        <dd>{promptName}</dd>
      </dl>
      <div className="mc-np-foot">
        <span className="mc-np-muted">{t("mcProject.npNothingYet")}</span>
        <div className="mc-np-actions">
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void answer({ outcome: "revise", name: plan.name, path: plan.path })}
          >
            {t("mcProject.npRevise")}
          </Button>
          <Button size="sm" variant="primary" disabled={busy || !name.trim()} onClick={() => void create()}>
            {t("mcProject.npCreate")}
          </Button>
        </div>
      </div>
    </section>
  );
}
