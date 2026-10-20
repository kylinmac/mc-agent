import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { terminalTabIds } from "./tool-tabs";

/*
  mc-agent work-panel terminal (MC-ADR-0005), adapted from upstream's removed
  D099 tab. A shell must survive tab switches and panel close, so each tab's
  xterm instance and host element live in a module-level cache keyed by tab
  id; the shell itself lives in Electron Main. A tab that disappears from
  every session's work panel has its shell killed.
*/

type TermEntry = {
  termId: string | null;
  term: Terminal;
  fit: FitAddon;
  host: HTMLDivElement;
  creating: boolean;
  exited: boolean;
};

const termCache = new Map<string, TermEntry>();
const exitListeners = new Set<() => void>();

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function terminalTheme() {
  const dark = document.documentElement.dataset.theme !== "light";
  return {
    background: cssVar("--ds-bg-primary") || (dark ? "#181818" : "#ffffff"),
    foreground: cssVar("--ds-text-primary") || (dark ? "#e8e8e8" : "#1f1f1f"),
    cursor: cssVar("--ds-text-primary") || undefined,
    selectionBackground: dark ? "rgba(255, 255, 255, 0.22)" : "rgba(0, 0, 0, 0.18)",
  };
}

function ensureEntry(tabId: string): TermEntry {
  const cached = termCache.get(tabId);
  if (cached) return cached;
  const host = document.createElement("div");
  host.className = "mc-terminal-xterm";
  const term = new Terminal({
    fontFamily: 'ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, monospace',
    fontSize: 12,
    lineHeight: 1.25,
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 4000,
    theme: terminalTheme(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  const entry: TermEntry = { termId: null, term, fit, host, creating: false, exited: false };
  // Bound once; routes through the current termId so restarts never stack handlers.
  term.onData((data) => {
    if (entry.termId) void api.terminalWrite(entry.termId, data);
  });
  termCache.set(tabId, entry);
  return entry;
}

function disposeEntry(tabId: string): void {
  const entry = termCache.get(tabId);
  termCache.delete(tabId);
  entry?.term.dispose();
  void api.terminalDispose(tabId).catch(() => undefined);
}

// Shell output and exit go to whichever cached terminal owns the shell.
let routed = false;
function routeEvents(exitedText: () => string): void {
  if (routed) return;
  routed = true;
  api.onTerminalData(({ termId, data }) => {
    for (const entry of termCache.values()) if (entry.termId === termId) entry.term.write(data);
  });
  api.onTerminalExit(({ termId }) => {
    for (const entry of termCache.values()) {
      if (entry.termId !== termId) continue;
      entry.termId = null;
      entry.exited = true;
      entry.term.writeln(`\r\n\x1b[2m${exitedText()}\x1b[0m`);
    }
    for (const listener of exitListeners) listener();
  });
  // A terminal tab closed in any session's panel takes its shell with it.
  useAppStore.subscribe((state) => {
    const open = terminalTabIds([
      ...state.workPanelTabs,
      ...Object.values(state.workPanelContexts).flatMap((context) => context.tabs),
    ]);
    for (const tabId of [...termCache.keys()]) if (!open.has(tabId)) disposeEntry(tabId);
  });
}

export function TerminalTab({ tabId, cwd, active }: { tabId: string; cwd: string; active: boolean }) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  // A remounted tab (section collapsed and expanded) starts from the cached
  // shell's state, so an exited shell keeps its restart button.
  const [exited, setExited] = useState(() => Boolean(termCache.get(tabId)?.exited));
  const [attachTick, setAttachTick] = useState(0);
  routeEvents(() => t("mcProject.terminalExited"));

  useEffect(() => {
    const listener = () => setExited(Boolean(termCache.get(tabId)?.exited));
    exitListeners.add(listener);
    return () => {
      exitListeners.delete(listener);
    };
  }, [tabId]);

  const fitAndReport = useCallback((entry: TermEntry) => {
    if (!entry.host.isConnected || entry.host.offsetWidth < 40) return;
    try {
      entry.fit.fit();
    } catch {
      return;
    }
    if (entry.termId) void api.terminalResize(entry.termId, entry.term.cols, entry.term.rows);
  }, []);

  const startSession = useCallback(
    async (entry: TermEntry) => {
      if (entry.creating || entry.termId) return;
      entry.creating = true;
      try {
        const created = await api.terminalCreate({ tabId, cwd, cols: entry.term.cols, rows: entry.term.rows });
        entry.termId = created.termId;
        entry.exited = false;
        if (created.replay) entry.term.write(created.replay);
        setExited(false);
        fitAndReport(entry);
      } catch (error) {
        // The tab was closed while its shell was starting.
        if (termCache.get(tabId) !== entry) return;
        entry.term.writeln(
          `\r\n${t("mcProject.terminalStartFailed")}${error instanceof Error ? `: ${error.message}` : ""}`,
        );
      } finally {
        entry.creating = false;
      }
    },
    [cwd, fitAndReport, t, tabId],
  );

  // Attach the cached host element; detach only on unmount.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const entry = ensureEntry(tabId);
    container.appendChild(entry.host);
    setExited(entry.exited);
    if (!entry.exited) void startSession(entry);
    if (active) {
      fitAndReport(entry);
      entry.term.focus();
    }
    return () => {
      if (entry.host.parentElement === container) container.removeChild(entry.host);
    };
  }, [tabId, active, startSession, fitAndReport, attachTick]);

  // Refit when the panel or window resizes.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const entry = ensureEntry(tabId);
    const observer = new ResizeObserver(() => fitAndReport(entry));
    observer.observe(container);
    return () => observer.disconnect();
  }, [tabId, fitAndReport]);

  // Follow the app theme.
  useEffect(() => {
    const observer = new MutationObserver(() => {
      const theme = terminalTheme();
      for (const entry of termCache.values()) entry.term.options.theme = theme;
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  const restart = () => {
    const entry = termCache.get(tabId);
    if (!entry) return;
    entry.term.reset();
    entry.termId = null;
    entry.exited = false;
    setExited(false);
    void startSession(entry);
    setAttachTick((value) => value + 1);
  };

  return (
    <div className="mc-terminal">
      <div className="mc-terminal-bar">
        <span className="mc-terminal-cwd" title={cwd}>
          {`‎${cwd}‎`}
        </span>
        {exited ? (
          <button type="button" className="mc-session-info-button" onClick={restart}>
            {t("mcProject.terminalRestart")}
          </button>
        ) : null}
      </div>
      <div ref={containerRef} className="mc-terminal-host" />
    </div>
  );
}
