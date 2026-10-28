import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectMemoryEntry } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { normalizeProjectPath } from "../../lib/sidebar-preferences";
import { useAppStore } from "../../stores/app-store";
import { Button } from "../../components/ui";

/*
  mc-agent (MC-ADR-0024): the pieces the memory panels share — a note's kind
  and source, the suggestions waiting for the user, and Tidy up.
*/

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Kind, hook and where the note came from, under a note. */
export function MemoryNoteMeta({ entry }: { entry: ProjectMemoryEntry }) {
  const { t } = useTranslation();
  const parts = [
    entry.kind ? t(`mcProject.memoryKind_${entry.kind}`) : "",
    entry.hook ?? "",
    entry.source ? t("mcProject.memoryFrom", { title: entry.source.title || t("mcProject.memoryAConversation"), date: formatDate(entry.source.at) }) : "",
  ].filter(Boolean);
  if (!parts.length) return null;
  return <div className="mc-memory-meta">{parts.join(" · ")}</div>;
}

/** Suggestions from a review, each kept or declined by the user. */
export function MemorySuggestions({
  entries,
  disabled,
  onResolve,
}: {
  entries: readonly ProjectMemoryEntry[];
  disabled?: boolean;
  onResolve: (id: string, keep: boolean) => void;
}) {
  const { t } = useTranslation();
  const pending = entries.filter((entry) => entry.pending);
  if (!pending.length) return null;
  const titleOf = (id: string | undefined) => entries.find((entry) => entry.id === id)?.title ?? "";
  return (
    <section className="mc-memory-suggestions" aria-label={t("mcProject.memorySuggestionsTitle")}>
      <div className="mc-memory-suggestions-head">
        {t("mcProject.memorySuggestionsTitle")}
        <span className="mc-memory-meta">{t("mcProject.memorySuggestionsHint")}</span>
      </div>
      {pending.map((entry) => {
        const action = entry.pending?.remove ? "remove" : entry.pending?.replaces ? "update" : "add";
        return (
          <article key={entry.id} className="mc-memory-suggestion">
            <div className="mc-memory-suggestion-copy">
              <span className="mc-memory-suggestion-action" data-action={action}>
                {t(`mcProject.memorySuggest_${action}`, { title: titleOf(entry.pending?.replaces) })}
              </span>
              <span className="mc-memory-suggestion-title">{entry.title}</span>
              {action !== "remove" ? <span className="mc-memory-suggestion-content">{entry.content}</span> : null}
              {entry.pending?.reason ? <span className="mc-memory-meta">{entry.pending.reason}</span> : null}
              <MemoryNoteMeta entry={{ ...entry, hook: undefined }} />
            </div>
            <div className="mc-memory-suggestion-actions">
              <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onResolve(entry.id, false)}>
                {t("mcProject.memoryDecline")}
              </Button>
              <Button size="sm" variant="primary" disabled={disabled} onClick={() => onResolve(entry.id, true)}>
                {action === "remove" ? t("mcProject.memoryAcceptRemove") : t("mcProject.memoryAccept")}
              </Button>
            </div>
          </article>
        );
      })}
    </section>
  );
}

/**
 * Tidy up: a consolidating review on the project's most recent conversation
 * that ran since the app started, looked up across the project's folders.
 */
export function MemoryTidyButton({
  path,
  groupId,
  disabled,
  onDone,
}: {
  path: string;
  groupId?: string;
  disabled?: boolean;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const [busy, setBusy] = useState(false);
  const tidy = async () => {
    const roots = groupId
      ? ((await api.listProjectGroups().catch(() => ({ groups: [] }))).groups.find((group) => group.id === groupId)?.roots.map(
          (root) => root.path,
        ) ?? [])
      : [];
    const keys = new Set([path, ...roots].map((item) => normalizeProjectPath(item)).filter(Boolean));
    const sessions = useAppStore
      .getState()
      .sessions.filter((session) => keys.has(normalizeProjectPath(session.projectPath)) && !session.id.startsWith("remote:"))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 5);
    setBusy(true);
    try {
      for (const session of sessions) {
        const { result } = await api.mcMemory.consolidate(session.id);
        if (!result) continue;
        showToast(
          result.added ? t("mcProject.memoryTidied", { count: result.added }) : t("mcProject.memoryTidyNothing"),
          { variant: "info" },
        );
        onDone();
        return;
      }
      showToast(t("mcProject.memoryTidyNeedsChat"), { variant: "info" });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      disabled={disabled || busy}
      title={t("mcProject.memoryTidyHint")}
      onClick={() => void tidy()}
    >
      {busy ? t("mcProject.memoryTidying") : t("mcProject.memoryTidy")}
    </Button>
  );
}
