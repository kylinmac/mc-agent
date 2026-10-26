import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  MEMORY_KINDS,
  USER_MEMORY_ID_PREFIX,
  resolveMemorySuggestion,
  type MemoryKind,
  type ProjectMemoryEntry,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { Button, Input, SettingsToggle, Textarea } from "../../components/ui";
import { SettingsMenuSelect } from "../../components/settings/SettingsMenuSelect";
import { IconPlus, IconTrash } from "../../components/icons";
import { MemoryNoteMeta, MemorySuggestions } from "../memory/MemoryParts";
import { SettingsCard, SettingsRow } from "./primitives";

/*
  mc-agent (MC-ADR-0024): Settings → Memory. The notes about the user that
  every conversation loads, the suggestions waiting for them, and the switch
  for reviewing a conversation once it goes idle.
*/
export function MemoryPage() {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const [entries, setEntries] = useState<ProjectMemoryEntry[] | null>(null);
  const [saved, setSaved] = useState<ProjectMemoryEntry[]>([]);
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let canceled = false;
    void api.mcMemory.get().then(
      (result) => {
        if (canceled) return;
        setEntries(result.user);
        setSaved(result.user);
        setReview(result.review);
      },
      (error: unknown) => showToast(error instanceof Error ? error.message : String(error), { variant: "error" }),
    );
    return () => {
      canceled = true;
    };
  }, [showToast]);

  const persist = async (patch: { user?: ProjectMemoryEntry[]; review?: boolean }) => {
    setBusy(true);
    try {
      const result = await api.mcMemory.set(patch);
      setEntries(result.user);
      setSaved(result.user);
      setReview(result.review);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setBusy(false);
    }
  };

  const update = (id: string, patch: Partial<ProjectMemoryEntry>) =>
    setEntries((current) => current?.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)) ?? current);

  const dirty = entries !== null && JSON.stringify(entries) !== JSON.stringify(saved);
  const notes = entries?.filter((entry) => !entry.pending) ?? [];

  return (
    <div className="settings-stack">
      <SettingsCard title={t("mcProject.memoryReviewCard")}>
        <SettingsRow title={t("mcProject.memoryReview")} description={t("mcProject.memoryReviewHelp")}>
          <SettingsToggle
            checked={review}
            label={t("mcProject.memoryReview")}
            busy={busy}
            disabled={entries === null}
            onChange={() => void persist({ review: !review })}
          />
        </SettingsRow>
      </SettingsCard>

      <SettingsCard
        title={t("mcProject.memoryUserCard")}
        description={t("mcProject.memoryUserHelp")}
        action={
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || entries === null}
            onClick={() =>
              setEntries((current) => [
                ...(current ?? []),
                { id: `${USER_MEMORY_ID_PREFIX}${crypto.randomUUID()}`, title: "", content: "", kind: "user" },
              ])
            }
          >
            <IconPlus size={14} aria-hidden />
            {t("project.memoryAdd")}
          </Button>
        }
      >
        {entries ? (
          <MemorySuggestions
            entries={entries}
            disabled={busy || dirty}
            onResolve={(id, keep) => void persist({ user: resolveMemorySuggestion(entries, id, keep) })}
          />
        ) : null}
        {notes.length === 0 ? (
          <div className="settings-row">
            <div className="settings-row-copy mc-np-muted">{t("mcProject.memoryUserEmpty")}</div>
          </div>
        ) : (
          notes.map((entry) => (
            <div key={entry.id} className="settings-row mc-memory-user-note">
              <div className="mc-memory-user-fields">
                <div className="mc-memory-user-head">
                  <Input
                    value={entry.title}
                    placeholder={t("project.memoryEntryTitle")}
                    aria-label={t("project.memoryEntryTitle")}
                    disabled={busy}
                    onChange={(event) => update(entry.id, { title: event.target.value })}
                  />
                  <SettingsMenuSelect
                    value={entry.kind ?? "user"}
                    label={t("mcProject.memoryKindLabel")}
                    triggerClassName="mc-memory-kind-select"
                    disabled={busy}
                    options={MEMORY_KINDS.map((kind) => ({ id: kind, label: t(`mcProject.memoryKind_${kind}`) }))}
                    onChange={(kind) => update(entry.id, { kind: kind as MemoryKind })}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    aria-label={t("project.memoryRemove")}
                    title={t("project.memoryRemove")}
                    onClick={() => setEntries((current) => current?.filter((item) => item.id !== entry.id) ?? current)}
                  >
                    <IconTrash size={14} />
                  </Button>
                </div>
                <Textarea
                  className="project-memory-entry-content"
                  value={entry.content}
                  placeholder={t("project.memoryEntryContent")}
                  aria-label={t("project.memoryEntryContent")}
                  disabled={busy}
                  onChange={(event) => update(entry.id, { content: event.target.value })}
                />
                <MemoryNoteMeta entry={{ ...entry, kind: undefined }} />
              </div>
            </div>
          ))
        )}
        {dirty ? (
          <div className="settings-row mc-memory-user-actions">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEntries(saved)}>
              {t("settings.cancel")}
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={busy}
              onClick={() => void persist({ user: (entries ?? []).filter((entry) => entry.pending || entry.content.trim()) })}
            >
              {t("project.memorySave")}
            </Button>
          </div>
        ) : null}
      </SettingsCard>
    </div>
  );
}
