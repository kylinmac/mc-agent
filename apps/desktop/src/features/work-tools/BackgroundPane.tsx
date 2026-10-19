import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { BackgroundShell } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { formatElapsed, sessionSubagents } from "../session-info/session-subagents";
import { refreshBackgroundShells, useBackgroundFocus, useBackgroundShells } from "./background-shells";

/*
  mc-agent background tasks pane (MC-ADR-0006), after Claude Code's: the
  session's background commands with status, elapsed time and their latest
  output, each viewable in full and stoppable, followed by the subagents that
  are still running. Finished commands stay listed until host-core drops them.
*/

const VIEW_POLL_MS = 1500;

function statusLabel(shell: BackgroundShell, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (shell.status === "running") return t("mcProject.backgroundRunning");
  if (shell.status === "killed") return t("mcProject.backgroundKilled");
  if (shell.status === "failed") return t("mcProject.backgroundFailed");
  return t("mcProject.backgroundExited", { code: shell.exitCode ?? "?" });
}

function ShellOutput({ sessionId, shell }: { sessionId: string; shell: BackgroundShell }) {
  const [output, setOutput] = useState<string | null>(null);
  const preRef = useRef<HTMLPreElement | null>(null);
  const running = shell.status === "running";
  useEffect(() => {
    let canceled = false;
    const load = () =>
      api.backgroundShellsView(sessionId, shell.id).then(
        (view) => {
          if (!canceled) setOutput(view.output);
        },
        () => undefined,
      );
    void load();
    if (!running) return () => {
      canceled = true;
    };
    const timer = setInterval(() => void load(), VIEW_POLL_MS);
    return () => {
      canceled = true;
      clearInterval(timer);
    };
  }, [sessionId, shell.id, running]);
  // Follow the end of the output, as a terminal does.
  useEffect(() => {
    const pre = preRef.current;
    if (pre) pre.scrollTop = pre.scrollHeight;
  }, [output]);
  return (
    <pre ref={preRef} className="mc-bg-output">
      {output ?? shell.tail ?? ""}
    </pre>
  );
}

export function BackgroundPane() {
  const { t } = useTranslation();
  const sessionId = useAppStore((s) => s.activeSessionId);
  const messages = useAppStore((s) => s.messages);
  const isRunning = useAppStore((s) => s.isRunning);
  const openSubagentTab = useAppStore((s) => s.openSubagentTab);
  const shells = useBackgroundShells(sessionId);
  const [expanded, setExpanded] = useState<string | null>(null);
  // Opened from the session info panel: show that command's output.
  const focus = useBackgroundFocus();
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!focus) return;
    setExpanded(focus.id);
    requestAnimationFrame(() =>
      listRef.current
        ?.querySelector(`[data-shell-id="${CSS.escape(focus.id)}"]`)
        ?.scrollIntoView({ block: "nearest" }),
    );
  }, [focus]);
  const [stopping, setStopping] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(() => Date.now());
  const subagents = useMemo(
    () =>
      sessionSubagents(messages, { turnLive: isRunning }).filter(
        (item) => item.status === "running" || item.status === "creating",
      ),
    [messages, isRunning],
  );
  const anyRunning = shells.some((shell) => shell.status === "running") || subagents.length > 0;
  useEffect(() => {
    if (!anyRunning) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [anyRunning]);

  if (!sessionId) return null;

  const stop = async (id: string) => {
    setStopping((current) => new Set(current).add(id));
    try {
      await api.backgroundShellsKill(sessionId, id);
    } finally {
      setStopping((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
      void refreshBackgroundShells();
    }
  };

  if (shells.length === 0 && subagents.length === 0) {
    return <div className="mc-bg-empty">{t("mcProject.backgroundEmpty")}</div>;
  }

  return (
    <div className="mc-bg" ref={listRef}>
      {shells.length > 0 ? (
        <section className="mc-bg-section">
          <div className="mc-bg-heading">{t("mcProject.backgroundCommands")}</div>
          <ul className="mc-bg-list">
            {shells.map((shell) => {
              const end = shell.endedAt ?? now;
              const open = expanded === shell.id;
              return (
                <li key={shell.id} className="mc-bg-item" data-status={shell.status} data-shell-id={shell.id}>
                  <div className="mc-bg-row">
                    <span className="mc-bg-dot" aria-hidden />
                    <button
                      type="button"
                      className="mc-bg-command"
                      title={`${shell.command}\n${shell.cwd}`}
                      aria-expanded={open}
                      onClick={() => setExpanded(open ? null : shell.id)}
                    >
                      {shell.command}
                    </button>
                    <span className="mc-bg-meta">
                      {statusLabel(shell, t)} · {formatElapsed(end - shell.startedAt)}
                    </span>
                    {shell.status === "running" ? (
                      <button
                        type="button"
                        className="mc-bg-stop"
                        disabled={stopping.has(shell.id)}
                        onClick={() => void stop(shell.id)}
                      >
                        {t("mcProject.backgroundStop")}
                      </button>
                    ) : null}
                  </div>
                  {open ? (
                    <ShellOutput sessionId={sessionId} shell={shell} />
                  ) : shell.tail ? (
                    <button type="button" className="mc-bg-tail" onClick={() => setExpanded(shell.id)}>
                      {shell.tail.trimEnd().split("\n").slice(-3).join("\n")}
                    </button>
                  ) : null}
                  {shell.error ? <div className="mc-bg-error">{shell.error}</div> : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {subagents.length > 0 ? (
        <section className="mc-bg-section">
          <div className="mc-bg-heading">{t("mcProject.backgroundSubagents")}</div>
          <ul className="mc-bg-list">
            {subagents.map((item) => (
              <li key={item.delegationId} className="mc-bg-item" data-status="running">
                <div className="mc-bg-row">
                  <span className="mc-bg-dot" aria-hidden />
                  <button
                    type="button"
                    className="mc-bg-command"
                    onClick={() => openSubagentTab(item.delegationId, item.agentName || undefined)}
                  >
                    {item.agentName || t("panel.tabs.subagent")}
                  </button>
                  <span className="mc-bg-meta">
                    {item.status === "creating" ? t("chat.subagentCreating") : t("chat.subagentStatus.running")}
                    {item.startedAt !== undefined ? ` · ${formatElapsed(now - item.startedAt)}` : ""}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
