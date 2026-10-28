import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import { api, type ImportCandidate, type ImportSource } from "../../lib/api";
import { useBlockingOverlay } from "../../lib/blocking-overlay";
import { saveSidebarPreferences, projectWorkspaceFromPath } from "../../lib/sidebar-preferences";
import { normalizeProjectPath } from "../../lib/sidebar-session-groups";
import { useAppStore } from "../../stores/app-store";
import {
  preferencesFromState,
  promoteProjectPath,
  upsertWorkspace,
  withProjectDisplayName,
} from "../../stores/helpers/store-helpers";
import { Button, Checkbox, OverlayBackdrop, TooltipButton } from "../../components/ui";
import { IconChevronDown, IconChevronRight, IconClose } from "../../components/icons";
import {
  IMPORT_SOURCES,
  SOURCE_LABELS,
  candidateKey,
  filterCandidates,
  groupByProject,
  importedSessionId,
  selectionState,
  selectionSummary,
  toggleItems,
} from "./import-model";

/*
  mc-agent (MC-ADR-0009): import projects and their conversations from other
  agents. The scan lists what Claude Code, Codex and an installed PI-Desktop
  hold, grouped by project folder; pick whole projects, single conversations,
  or everything. Imported conversations can be continued here, and the
  sources are only read.
*/

export const useProjectImportDialog = create<{ open: boolean }>(() => ({ open: false }));

export function openProjectImportDialog(): void {
  useProjectImportDialog.setState({ open: true });
}

function closeDialog(): void {
  useProjectImportDialog.setState({ open: false });
}

/** Imported projects join the sidebar's open projects, without switching to them. */
function showImportedProjects(paths: readonly string[]): void {
  if (!paths.length) return;
  useAppStore.setState((state) => {
    let openProjectPaths = state.openProjectPaths;
    let openProjects = state.openProjects;
    for (const path of paths) {
      if (openProjectPaths.some((open) => normalizeProjectPath(open) === normalizeProjectPath(path))) continue;
      openProjectPaths = promoteProjectPath(openProjectPaths, path);
      openProjects = upsertWorkspace(openProjects, withProjectDisplayName(projectWorkspaceFromPath(path), state.projectMeta));
    }
    return { openProjectPaths, openProjects };
  });
  saveSidebarPreferences(preferencesFromState(useAppStore.getState()));
}

function formatDate(iso: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale || undefined, { dateStyle: "medium" }).format(date);
}

export function ProjectImportDialog() {
  const open = useProjectImportDialog((state) => state.open);
  return open ? <ProjectImportDialogContent /> : null;
}

function ProjectImportDialogContent() {
  const { t, i18n } = useTranslation();
  useBlockingOverlay();
  const sessions = useAppStore((state) => state.sessions);
  const [candidates, setCandidates] = useState<ImportCandidate[] | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState<Partial<Record<ImportSource, number>>>({});
  const [source, setSource] = useState<ImportSource | "all">("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let canceled = false;
    api.scanImportSessions().then(
      (result) => {
        if (canceled) return;
        setCandidates(result.sessions);
        setTruncated(result.truncated ?? {});
      },
      (error: unknown) => {
        if (!canceled) setScanError(error instanceof Error ? error.message : String(error));
      },
    );
    return () => {
      canceled = true;
    };
  }, []);

  const close = useCallback(() => {
    if (!busy) closeDialog();
  }, [busy]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  // Conversations already in this app are shown but cannot be picked again.
  const imported = useMemo(() => new Set(sessions.map((session) => session.id)), [sessions]);
  const offered = useMemo(
    () => (candidates ?? []).filter((candidate) => IMPORT_SOURCES.includes(candidate.source)),
    [candidates],
  );
  const counts = useMemo(() => {
    const bySource: Partial<Record<ImportSource, number>> = {};
    for (const candidate of offered) bySource[candidate.source] = (bySource[candidate.source] ?? 0) + 1;
    return bySource;
  }, [offered]);
  const visible = useMemo(() => filterCandidates(offered, { source, query }), [offered, source, query]);
  const groups = useMemo(() => groupByProject(visible), [visible]);
  const summary = selectionSummary(offered, selected);
  const allState = selectionState(visible, selected, imported);

  const toggleExpanded = (key: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const run = async () => {
    const chosen = offered.filter((candidate) => selected.has(candidateKey(candidate)));
    if (!chosen.length || busy) return;
    setBusy(true);
    try {
      const result = await api.runImportSessions(chosen);
      const store = useAppStore.getState();
      await store.refreshSessions();
      const ids = new Set(chosen.map(importedSessionId));
      const paths = useAppStore
        .getState()
        .sessions.filter((session) => ids.has(session.id) && session.projectPath)
        .map((session) => session.projectPath as string);
      showImportedProjects([...new Set(paths)]);
      store.showToast(t("mcProject.importDone", { ...result }), {
        variant: result.failed > 0 ? "warning" : "info",
      });
      closeDialog();
    } catch (error) {
      useAppStore.getState().showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setBusy(false);
    }
  };

  const body = (() => {
    if (scanError) return <div className="mc-import-state">{t("mcProject.importScanFailed", { message: scanError })}</div>;
    if (!candidates) return <div className="mc-import-state">{t("mcProject.importScanning")}</div>;
    if (!offered.length) return <div className="mc-import-state">{t("mcProject.importEmpty")}</div>;
    if (!groups.length) return <div className="mc-import-state">{t("mcProject.importNoMatch")}</div>;
    return (
      <ul className="mc-import-groups">
        {groups.map((group) => {
          const state = selectionState(group.items, selected, imported);
          const isOpen = expanded.has(group.key);
          const allImported = group.items.every((item) => imported.has(importedSessionId(item)));
          return (
            <li key={group.key || "<none>"} className="mc-import-group">
              <div className="mc-import-group-row">
                <button
                  type="button"
                  className="mc-import-expand"
                  aria-expanded={isOpen}
                  aria-label={group.name || t("mcProject.importNoProject")}
                  onClick={() => toggleExpanded(group.key)}
                >
                  {isOpen ? <IconChevronDown size={13} aria-hidden /> : <IconChevronRight size={13} aria-hidden />}
                </button>
                <Checkbox
                  className="mc-import-check"
                  label={
                    <span className="mc-import-group-name" title={group.name}>
                      {group.name || t("mcProject.importNoProject")}
                    </span>
                  }
                  checked={state === "all"}
                  indeterminate={state === "some"}
                  disabled={allImported}
                  onChange={() => setSelected((current) => toggleItems(group.items, current, imported))}
                />
                <span className="mc-import-path" title={group.path ?? ""}>
                  {/* Left-to-right marks keep the slashes in place under the rtl trim. */}
                  {group.path ? `\u200E${group.path}\u200E` : ""}
                </span>
                <span className="mc-import-sources">
                  {group.sources.map((item) => (
                    <span key={item} className="mc-import-source" data-source={item}>
                      {SOURCE_LABELS[item]}
                    </span>
                  ))}
                </span>
                <span className="mc-import-meta">{t("mcProject.importSessionCount", { count: group.items.length })}</span>
              </div>
              {isOpen ? (
                <ul className="mc-import-items">
                  {group.items.map((item) => {
                    const done = imported.has(importedSessionId(item));
                    return (
                      <li key={candidateKey(item)} className="mc-import-item" data-imported={done ? "true" : undefined}>
                        <Checkbox
                          className="mc-import-check"
                          label={<span className="mc-import-title" title={item.title}>{item.title}</span>}
                          checked={done || selected.has(candidateKey(item))}
                          disabled={done}
                          onChange={() => setSelected((current) => toggleItems([item], current, imported))}
                        />
                        <span className="mc-import-source" data-source={item.source}>
                          {SOURCE_LABELS[item.source]}
                        </span>
                        <span className="mc-import-meta">
                          {done
                            ? t("mcProject.importAlready")
                            : (item.source === "codex" || item.source === "claude-code") && imported.has(`import-${item.source}-${item.externalId}`)
                              ? t("mcProject.importCompleteCopy")
                            : [
                                item.messageCount !== null
                                  ? t("mcProject.importMessageCount", { count: item.messageCount })
                                  : "",
                                formatDate(item.updatedAt, i18n.language),
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
    );
  })();

  return (
    <OverlayBackdrop
      className="overlay mc-import-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        ref={dialogRef}
        className="dialog mc-import-dialog"
        role="dialog"
        aria-modal
        aria-labelledby="mc-import-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="mc-import-head">
          <h2 id="mc-import-title">{t("mcProject.importTitle")}</h2>
          <TooltipButton
            type="button"
            className="mc-import-close"
            tooltip={t("mcProject.importCancel")}
            ariaLabel={t("mcProject.importCancel")}
            disabled={busy}
            onClick={close}
          >
            <IconClose size={16} />
          </TooltipButton>
        </header>
        <div className="mc-import-toolbar">
          <div className="mc-import-filters" role="group" aria-label={t("mcProject.importSources")}>
            {(["all", ...IMPORT_SOURCES] as const).map((item) => (
              <button
                key={item}
                type="button"
                className="mc-import-filter"
                aria-pressed={source === item}
                onClick={() => setSource(item)}
              >
                {item === "all" ? t("mcProject.importAll") : SOURCE_LABELS[item]}
                <span className="mc-import-filter-count">
                  {item === "all" ? offered.length : (counts[item] ?? 0)}
                </span>
              </button>
            ))}
          </div>
          <input
            className="mc-import-search"
            type="search"
            value={query}
            placeholder={t("mcProject.importSearch")}
            aria-label={t("mcProject.importSearch")}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="mc-import-selectall">
          <Checkbox
            className="mc-import-check"
            label={t("mcProject.importSelectAll")}
            checked={allState === "all"}
            indeterminate={allState === "some"}
            disabled={!visible.length}
            onChange={() => setSelected((current) => toggleItems(visible, current, imported))}
          />
          <span className="mc-import-meta">{t("mcProject.importSelected", summary)}</span>
        </div>
        {source === "codex" || truncated.codex ? (
          <div className="mc-import-hint" role="note">
            {source === "codex" ? <p>{t("mcProject.importCodexScope")}</p> : null}
            {truncated.codex ? <p>{t("mcProject.importCodexTruncated", { count: truncated.codex })}</p> : null}
          </div>
        ) : null}
        <div className="mc-import-body">{body}</div>
        <footer className="mc-import-foot">
          <span className="mc-import-note">{t("mcProject.importNote")}</span>
          <Button type="button" variant="secondary" disabled={busy} onClick={close}>
            {t("mcProject.importCancel")}
          </Button>
          <Button type="button" variant="primary" disabled={busy || summary.sessions === 0} onClick={() => void run()}>
            {busy ? t("mcProject.importRunning") : t("mcProject.importRun", { count: summary.sessions })}
          </Button>
        </footer>
      </div>
    </OverlayBackdrop>
  );
}
