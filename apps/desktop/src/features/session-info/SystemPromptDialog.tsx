import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { SessionSystemPrompt } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useBlockingOverlay } from "../../lib/blocking-overlay";
import { Button, OverlayBackdrop, TooltipButton } from "../../components/ui";
import { IconChevronDown, IconChevronRight, IconClose } from "../../components/icons";

/*
  mc-agent: the system prompt a session sends, read-only, by section: the
  base prompt (persona and runtime rules), active tool notes, plugin skills,
  and the project context (APPEND_SYSTEM.md, project instructions, memory).
*/

type Group = { key: string; title: string; text: string };

function groupSections(prompt: SessionSystemPrompt, t: (key: string) => string): Group[] {
  const groups: Group[] = [];
  const skills: string[] = [];
  for (const section of prompt.sections) {
    if (section.key === "skills" || section.key.startsWith("skill:")) {
      skills.push(section.text);
      continue;
    }
    const title =
      section.key === "runtime"
        ? t("mcProject.systemPromptRuntime")
        : section.key === "context"
          ? t("mcProject.systemPromptContext")
          : section.key === "tool_activation"
            ? t("mcProject.systemPromptTools")
            : section.key;
    groups.push({ key: section.key, title, text: section.text });
  }
  if (skills.length) {
    const at = groups.findIndex((group) => group.key === "context");
    const skillGroup = { key: "skills", title: t("mcProject.systemPromptSkills"), text: skills.join("\n\n") };
    if (at < 0) groups.push(skillGroup);
    else groups.splice(at, 0, skillGroup);
  }
  return groups;
}

export function SystemPromptDialog({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const { t } = useTranslation();
  useBlockingOverlay();
  const [prompt, setPrompt] = useState<SessionSystemPrompt | null | undefined>(undefined);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let canceled = false;
    api.sessionSystemPrompt(sessionId).then(
      ({ prompt: loaded }) => {
        if (!canceled) setPrompt(loaded);
      },
      () => {
        if (!canceled) setPrompt(null);
      },
    );
    return () => {
      canceled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const groups = useMemo(() => (prompt ? groupSections(prompt, t) : []), [prompt, t]);
  const full = groups.map((group) => group.text).join("\n\n");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(full);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be refused; nothing else to do.
    }
  };

  return createPortal(
    <OverlayBackdrop
      className="overlay mc-capability-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="dialog mc-capability-dialog mc-system-prompt-dialog"
        role="dialog"
        aria-modal
        aria-labelledby="mc-system-prompt-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="mc-capability-head">
          <div>
            <h2 id="mc-system-prompt-title">{t("mcProject.systemPromptTitle")}</h2>
            <p className="mc-capability-sub">
              {prompt
                ? [
                    t("mcProject.systemPromptSize", { chars: full.length.toLocaleString() }),
                    prompt.template
                      ? prompt.template.match.kind === "project"
                        ? t("mcProject.promptAppliedProject", { name: prompt.template.templateName })
                        : prompt.template.match.kind === "model"
                          ? t("mcProject.promptAppliedModel", {
                              name: prompt.template.templateName,
                              pattern: prompt.template.match.pattern,
                            })
                          : t("mcProject.promptAppliedGlobal", { name: prompt.template.templateName })
                      : "",
                    // With a template, persona and appended rules are the template's.
                    !prompt.template && prompt.customPersona ? t("mcProject.systemPromptCustomPersona") : "",
                    !prompt.template && prompt.customAppend ? t("mcProject.systemPromptCustomAppend") : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : ""}
            </p>
          </div>
          <TooltipButton
            type="button"
            className="mc-import-close"
            tooltip={t("mcProject.capabilityDone")}
            ariaLabel={t("mcProject.capabilityDone")}
            onClick={onClose}
          >
            <IconClose size={16} />
          </TooltipButton>
        </header>
        <div className="mc-capability-body">
          {prompt === undefined ? (
            <div className="mc-import-state">{t("mcProject.importScanning")}</div>
          ) : !prompt ? (
            <div className="mc-import-state">{t("mcProject.systemPromptUnavailable")}</div>
          ) : (
            groups.map((group) => {
              const isCollapsed = collapsed.has(group.key);
              return (
                <section key={group.key} className="mc-system-prompt-section">
                  <button
                    type="button"
                    className="mc-system-prompt-head"
                    aria-expanded={!isCollapsed}
                    onClick={() =>
                      setCollapsed((current) => {
                        const next = new Set(current);
                        if (next.has(group.key)) next.delete(group.key);
                        else next.add(group.key);
                        return next;
                      })
                    }
                  >
                    {isCollapsed ? <IconChevronRight size={12} aria-hidden /> : <IconChevronDown size={12} aria-hidden />}
                    <span>{group.title}</span>
                    <span className="mc-capability-detail">
                      {t("mcProject.systemPromptSize", { chars: group.text.length.toLocaleString() })}
                    </span>
                  </button>
                  {isCollapsed ? null : <pre className="mc-system-prompt-text">{group.text}</pre>}
                </section>
              );
            })
          )}
        </div>
        <footer className="mc-capability-foot">
          <Button type="button" variant="secondary" disabled={!prompt} onClick={() => void copy()}>
            {copied ? t("mcProject.systemPromptCopied") : t("mcProject.systemPromptCopy")}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("mcProject.capabilityDone")}
          </Button>
        </footer>
      </div>
    </OverlayBackdrop>,
    document.body,
  );
}
