import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { MC_USER_HOOK_EVENTS, isValidHookMatcher, type McUserHook, type McUserHookEvent } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { Button, Input, SettingsToggle, Textarea } from "../../components/ui";
import { IconPlus, IconTrash } from "../../components/icons";
import { SettingsMenuSelect } from "../../components/settings/SettingsMenuSelect";
import { SettingsCard } from "./primitives";

/*
  mc-agent (MC-ADR-0021): shell commands that run at fixed points of every
  turn. Saved to a file in the app's data directory; each conversation picks
  the list up at its next prompt.
*/

function newHook(): McUserHook {
  const id = globalThis.crypto?.randomUUID?.() ?? `hook-${Date.now().toString(36)}`;
  return { id, event: "PostToolUse", matcher: "Write|Edit", command: "" };
}

export function HooksPage() {
  const { t } = useTranslation();
  const [saved, setSaved] = useState<McUserHook[] | null>(null);
  const [draft, setDraft] = useState<McUserHook[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void api.mcHooksGet().then(
      ({ hooks }) => {
        if (!active) return;
        setSaved(hooks);
        setDraft(hooks);
      },
      (reason) => active && setError(String(reason)),
    );
    return () => {
      active = false;
    };
  }, []);

  const dirty = saved !== null && JSON.stringify(saved) !== JSON.stringify(draft);
  const invalid = draft.some((hook) => !hook.command.trim() || !isValidHookMatcher(hook.matcher ?? ""));
  const update = (id: string, patch: Partial<McUserHook>) =>
    setDraft((current) => current.map((hook) => (hook.id === id ? { ...hook, ...patch } : hook)));
  const eventOptions = MC_USER_HOOK_EVENTS.map((event) => ({ id: event, label: t(`mcProject.hookEvent_${event}`) }));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const { hooks } = await api.mcHooksSet(draft);
      setSaved(hooks);
      setDraft(hooks);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-stack mc-prompts">
      <p className="mc-prompts-intro">{t("mcProject.hooksIntro")}</p>
      <SettingsCard
        title={t("mcProject.hooksTitle")}
        description={t("mcProject.hooksDesc")}
        action={
          <Button variant="secondary" size="sm" onClick={() => setDraft((current) => [...current, newHook()])}>
            <IconPlus size={13} aria-hidden /> {t("mcProject.hooksAdd")}
          </Button>
        }
      >
        {draft.length === 0 ? (
          <div className="settings-row">
            <div className="settings-row-copy mc-prompts-muted">{t("mcProject.hooksEmpty")}</div>
          </div>
        ) : (
          draft.map((hook) => {
            const matcherInvalid = !isValidHookMatcher(hook.matcher ?? "");
            return (
              <div key={hook.id} className="settings-row mc-hooks-row">
                <div className="mc-hooks-head">
                  <SettingsMenuSelect
                    label={t("mcProject.hookEvent")}
                    className="mc-hooks-event"
                    triggerClassName="mc-hooks-event-trigger"
                    value={hook.event}
                    options={eventOptions}
                    onChange={(event) => update(hook.id, { event: event as McUserHookEvent })}
                  />
                  {hook.event === "Stop" ? null : (
                    <Input
                      className="mc-hooks-matcher"
                      value={hook.matcher ?? ""}
                      placeholder={t("mcProject.hookMatcherPlaceholder")}
                      aria-label={t("mcProject.hookMatcher")}
                      aria-invalid={matcherInvalid || undefined}
                      onChange={(event) => update(hook.id, { matcher: event.target.value })}
                    />
                  )}
                  <Input
                    className="mc-hooks-timeout"
                    type="number"
                    min={1}
                    max={600}
                    value={hook.timeoutSeconds ?? ""}
                    placeholder="60"
                    aria-label={t("mcProject.hookTimeout")}
                    title={t("mcProject.hookTimeout")}
                    onChange={(event) => {
                      const seconds = Number(event.target.value);
                      update(hook.id, { timeoutSeconds: event.target.value && Number.isFinite(seconds) ? seconds : undefined });
                    }}
                  />
                  <SettingsToggle
                    checked={hook.enabled !== false}
                    label={t("mcProject.hookEnabled")}
                    onChange={() => update(hook.id, { enabled: hook.enabled === false ? undefined : false })}
                  />
                  <button
                    type="button"
                    className="mc-prompts-icon"
                    aria-label={t("mcProject.hookRemove")}
                    title={t("mcProject.hookRemove")}
                    onClick={() => setDraft((current) => current.filter((item) => item.id !== hook.id))}
                  >
                    <IconTrash size={14} aria-hidden />
                  </button>
                </div>
                <Textarea
                  className="field-textarea mc-hooks-command"
                  value={hook.command}
                  placeholder={t(`mcProject.hookCommandPlaceholder_${hook.event}`)}
                  aria-label={t("mcProject.hookCommand")}
                  onChange={(event) => update(hook.id, { command: event.target.value })}
                />
                {matcherInvalid ? <p className="mc-hooks-error">{t("mcProject.hookMatcherInvalid")}</p> : null}
              </div>
            );
          })
        )}
      </SettingsCard>
      {error ? <p className="mc-hooks-error">{error}</p> : null}
      <div className="mc-prompts-actions">
        <Button variant="secondary" disabled={!dirty || saving} onClick={() => saved && setDraft(saved)}>
          {t("mcProject.promptDiscard")}
        </Button>
        <Button variant="primary" disabled={!dirty || saving || invalid} onClick={() => void save()}>
          {saving ? t("settings.saving") : t("mcProject.promptSave")}
        </Button>
      </div>
    </div>
  );
}
