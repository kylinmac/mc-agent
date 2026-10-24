import { useContext, useEffect, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { DICTATION_MAX_SECONDS } from "@pi-desktop/shared";
import { TooltipButton } from "../../../components/ui";
import { IconMic, IconStop, IconX } from "../../../components/icons";
import { useAppStore } from "../../../stores/app-store";
import { DictationSession } from "./session";
import { dictationErrorKey } from "./errors";
import { PortalVisibilityContext } from "../../../lib/portal-visibility";

export function DictationButton({ t, scope, disabled, onText }: {
  t: TFunction; scope: string | null; disabled: boolean; onText: (text: string) => void;
}) {
  const settings = useAppStore((state) => state.settings);
  const showToast = useAppStore((state) => state.showToast);
  const setSettingsTab = useAppStore((state) => state.setSettingsTab);
  const session = useRef<DictationSession | null>(null);
  const visible = useContext(PortalVisibilityContext);
  const visibleRef = useRef(visible); visibleRef.current = visible;
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const onTextRef = useRef(onText); onTextRef.current = onText;
  const [phase, setPhase] = useState<"idle" | "starting" | "recording" | "transcribing">("idle");
  const [seconds, setSeconds] = useState(0);
  const stopRef = useRef<() => void>(() => undefined);
  const report = (error: unknown) => {
    const key = dictationErrorKey(error);
    showToast(t(`dictation.${key}`), { variant: "error" });
  };
  const cancel = async () => {
    const current = session.current; session.current = null;
    setPhase("idle");
    try { await current?.cancel(); } catch (error) { report(error); }
  };
  useEffect(() => {
    setPhase("idle");
    const cancelHidden = () => { if (document.hidden) void cancel(); };
    document.addEventListener("visibilitychange", cancelHidden);
    return () => {
      document.removeEventListener("visibilitychange", cancelHidden);
      const current = session.current; session.current = null;
      void current?.cancel().catch(() => showToast(t("dictation.releaseFailed"), { variant: "error" }));
    };
  }, [scope, visible, settings?.dictation]);
  useEffect(() => {
    if (phase !== "recording") return;
    const start = Date.now(); setSeconds(0);
    const timer = setInterval(() => {
      const next = Math.floor((Date.now() - start) / 1000); setSeconds(next);
      if (next >= DICTATION_MAX_SECONDS) stopRef.current();
    }, 250);
    return () => clearInterval(timer);
  }, [phase]);

  const stop = async () => {
    const current = session.current; const origin = scopeRef.current;
    if (!current || phase !== "recording") return;
    setPhase("transcribing");
    try {
      const text = await current.finish();
      if (session.current !== current || scopeRef.current !== origin || !visibleRef.current) return;
      if (text) onTextRef.current(text);
      else showToast(t("dictation.empty"));
    } catch (error) { if (session.current === current) report(error); }
    finally { if (session.current === current) { session.current = null; setPhase("idle"); } }
  };
  stopRef.current = () => { void stop(); };
  const start = async () => {
    if (session.current) return;
    if (!settings?.dictation?.enabled) { setSettingsTab("voice"); return; }
    const origin = scopeRef.current;
    const current = new DictationSession((error) => {
      if (session.current === current) { report(error); session.current = null; setPhase("idle"); }
    });
    session.current = current; setPhase("starting");
    try {
      await current.start(settings.voice?.deviceId);
      if (session.current !== current || scopeRef.current !== origin || !visibleRef.current) { await current.cancel(); return; }
      setPhase("recording");
    } catch (error) {
      if (session.current === current) { report(error); session.current = null; setPhase("idle"); }
      try { await current.cancel(); } catch { showToast(t("dictation.releaseFailed"), { variant: "error" }); }
    }
  };
  const active = phase !== "idle";
  const label = phase === "idle" ? t("dictation.start") : phase === "recording" ? t("dictation.stop") : t(`dictation.${phase}`);
  return <>
    <TooltipButton type="button" className="icon-btn icon-btn-square" tooltip={label} ariaLabel={label}
      disabled={(!active && disabled) || phase === "starting" || phase === "transcribing"}
      onClick={() => { void (phase === "recording" ? stop() : start()); }}>
      {phase === "recording" ? <IconStop size={15} /> : <IconMic size={15} />}
    </TooltipButton>
    {active ? <>
      <span role="status" aria-live="polite">{phase === "recording" ? `${seconds}s` : label}</span>
      <TooltipButton type="button" className="icon-btn icon-btn-square" tooltip={t("dictation.cancel")} ariaLabel={t("dictation.cancel")} onClick={() => { void cancel(); }}><IconX size={14} /></TooltipButton>
    </> : null}
  </>;
}
