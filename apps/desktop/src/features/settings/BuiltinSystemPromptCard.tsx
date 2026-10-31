import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { BuiltinSystemPrompt } from "@pi-desktop/shared";
import { Badge, Button } from "../../components/ui";
import { api } from "../../lib/api";

export function BuiltinSystemPromptCard() {
  const { t } = useTranslation();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [prompt, setPrompt] = useState<BuiltinSystemPrompt | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let canceled = false;
    setPrompt(null);
    setError(null);
    void api.builtinSystemPrompt().then(
      ({ prompt: loaded }) => { if (!canceled) setPrompt(loaded); },
      (failure: unknown) => { if (!canceled) setError(failure instanceof Error ? failure.message : String(failure)); },
    );
    return () => { canceled = true; };
  }, [open, attempt]);

  return <div className="settings-row mc-prompts-template mc-builtin-prompt">
    <div className="mc-prompts-template-row">
      <div className="settings-row-copy">
        <div className="settings-row-title">{t("mcProject.promptBuiltinTitle")} <Badge>{t("mcProject.promptBuiltinReadonly")}</Badge></div>
        <div className="settings-row-detail">{t("mcProject.promptBuiltinSummary")}</div>
      </div>
      <Button variant="ghost" size="sm" aria-expanded={open} aria-controls={id} onClick={() => setOpen((value) => !value)}>
        {t(open ? "mcProject.promptBuiltinCollapse" : "mcProject.promptBuiltinView")}
      </Button>
    </div>
    {open ? <div id={id} className="mc-prompts-editor">
      <p className="mc-prompts-intro">{t("mcProject.promptBuiltinScope")}</p>
      {error ? <div role="alert">
        <p>{t("mcProject.promptBuiltinError")} {error}</p>
        <Button variant="secondary" size="sm" onClick={() => setAttempt((value) => value + 1)}>{t("mcProject.promptBuiltinRetry")}</Button>
      </div> : !prompt ? <p role="status">{t("common.loading")}</p> : <div className="mc-builtin-prompt-sections">
        {prompt.sections.map((section) => <section key={section.key} aria-labelledby={`${id}-${section.key}`}>
          <h3 id={`${id}-${section.key}`}>{t(`mcProject.promptBuiltinSection.${section.key}`)}</h3>
          <pre tabIndex={0}>{section.text}</pre>
        </section>)}
      </div>}
    </div> : null}
  </div>;
}
