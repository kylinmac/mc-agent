import {
  Fragment,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { SessionPane } from "../../components/SessionPane";
import { SessionInfo } from "../session-info/SessionInfo";
import { IconClose } from "../../components/icons";
import { useAppStore } from "../../stores/app-store";
import { isKnownWorkPanelTab } from "../../lib/work-panel-tabs";
import { resizeColumns, setSplitWeights, useSplitView } from "../../lib/mc-split-view";
import { groupPanes } from "../work-tools/work-panes-model";
import { usePanePrefs } from "../work-tools/pane-layout";
import { PANE_ICONS } from "../work-tools/WorkPanes";
import { PLACEHOLDER_KEYS } from "../chat/composer/model";
import { closeSplitColumn, focusSplitColumn, openSplitColumnTool, useColumnTranscript } from "./split-actions";

/*
  mc-agent split view (MC-ADR-0007): the conversations on screen side by side.
  The focused column is the active session: it holds the composer and, when
  its work panel is open, the work panel docked under the conversation. The
  other columns stream live and show which tools their session has open;
  pressing anywhere in one focuses it.
*/

const WorkPanelBottomDock = lazy(() =>
  import("../../components/workpanel/WorkPanel").then((module) => ({
    default: module.WorkPanelBottomDock,
  })),
);

const DOCK_KEY = "mc.splitDock";
const DOCK_DEFAULT = 0.45;
const DOCK_MIN = 0.2;
const DOCK_MAX = 0.8;

function readDockShare(): number {
  try {
    const value = Number(localStorage.getItem(DOCK_KEY));
    return value >= DOCK_MIN && value <= DOCK_MAX ? value : DOCK_DEFAULT;
  } catch {
    return DOCK_DEFAULT;
  }
}

function isDefaultTitle(title?: string | null) {
  const trimmed = (title || "").trim().toLowerCase();
  return !trimmed || ["new task", "new chat", "新建任务", "新对话"].includes(trimmed);
}

/*
  Follows one pointer drag until it ends. Listening on the window (not the
  handle) means a release anywhere, a cancel, or the window losing focus
  always ends it, so the resize cursor can never be left behind.
*/
function trackDrag(onMove: (event: PointerEvent) => void, onEnd: () => void): void {
  const finish = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", finish);
    window.removeEventListener("blur", finish);
    onEnd();
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", finish);
  window.addEventListener("pointercancel", finish);
  window.addEventListener("blur", finish);
}

/*
  The composer as each conversation last showed it. There is one live
  composer (it follows the active session), so an unfocused column shows a
  frozen copy of its own: same box, toolbar, model and mode, so moving focus
  changes nothing on screen. Taken when the live composer leaves a column.
*/
const composerSnapshots = new Map<string, HTMLElement>();
const SNAPSHOT_KEY = "mc.splitComposer";

// Kept across launches, so a restored split shows each column's own composer.
try {
  const stored = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) ?? "{}") as Record<string, string>;
  for (const [sessionId, html] of Object.entries(stored)) {
    if (typeof html !== "string") continue;
    const host = document.createElement("div");
    host.innerHTML = html;
    const dock = host.firstElementChild;
    if (dock instanceof HTMLElement) composerSnapshots.set(sessionId, dock);
  }
} catch {
  // no stored snapshots
}

function saveSnapshots(): void {
  try {
    const keep = new Set(useSplitView.getState().columns);
    const stored: Record<string, string> = {};
    for (const [sessionId, dock] of composerSnapshots) {
      // The copy's text is in its value; carry it in the markup to store it.
      const copy = dock.cloneNode(true) as HTMLElement;
      copy.querySelectorAll("textarea").forEach((area) => {
        area.textContent = "";
      });
      if (keep.has(sessionId)) stored[sessionId] = copy.outerHTML;
    }
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(stored));
  } catch {
    // best-effort persistence
  }
}

function snapshotComposer(sessionId: string, slot: HTMLElement | null): void {
  const dock = slot?.querySelector<HTMLElement>(".composer-dock");
  if (!dock) return;
  const copy = dock.cloneNode(true) as HTMLElement;
  // A textarea's text lives in its value, which cloning does not carry.
  const source = dock.querySelectorAll("textarea");
  copy.querySelectorAll("textarea").forEach((area, index) => {
    area.value = source[index]?.value ?? "";
  });
  composerSnapshots.set(sessionId, copy);
  if (composerSnapshots.size > 12) composerSnapshots.delete(composerSnapshots.keys().next().value as string);
  saveSnapshots();
}

/** Puts the caret in the live composer once the column holding it has focus. */
function focusLiveComposer(sessionId: string): void {
  const deadline = Date.now() + 1500;
  const attempt = () => {
    const input = document.querySelector<HTMLTextAreaElement>(
      `.mc-split-col[data-split-session="${CSS.escape(sessionId)}"] .mc-split-composer-slot .composer-input`,
    );
    // The composer may still be settling, so try until the caret stays.
    if (input) input.focus();
    if ((!input || document.activeElement !== input) && Date.now() < deadline) requestAnimationFrame(attempt);
  };
  requestAnimationFrame(attempt);
}

/** Holds the live composer in the focused column and snapshots it on the way out. */
function LiveComposerSlot({ sessionId, children }: { sessionId: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const slot = ref.current;
    return () => snapshotComposer(sessionId, slot);
  }, [sessionId]);
  return (
    <div ref={ref} className="mc-split-composer-slot">
      {children}
    </div>
  );
}

/**
 * An unfocused column's composer: its snapshot, or before it has one, a copy
 * of the live composer. Pressing it focuses the column and puts the caret in
 * the live composer.
 */
function FrozenComposer({
  sessionId,
  liveSessionId,
  fallback,
}: {
  sessionId: string;
  /** Without a snapshot the copy is of the live composer, so retake it when that moves. */
  liveSessionId: string;
  fallback: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [copied, setCopied] = useState(false);
  useLayoutEffect(() => {
    const slot = ref.current;
    if (!slot) return;
    let copy = composerSnapshots.get(sessionId)?.cloneNode(true) as HTMLElement | undefined;
    if (!copy) {
      const live = document.querySelector<HTMLElement>(".mc-split-composer-slot .composer-dock");
      copy = live?.cloneNode(true) as HTMLElement | undefined;
      if (copy) {
        // The live composer's text belongs to another conversation.
        copy.querySelectorAll("textarea").forEach((area) => {
          area.value = "";
        });
      }
    } else {
      const source = composerSnapshots.get(sessionId)?.querySelectorAll("textarea");
      copy.querySelectorAll("textarea").forEach((area, index) => {
        area.value = source?.[index]?.value ?? "";
      });
    }
    if (!copy) {
      setCopied(false);
      return;
    }
    copy.querySelectorAll("textarea, button, input, [tabindex]").forEach((element) => {
      element.setAttribute("tabindex", "-1");
      if (element instanceof HTMLTextAreaElement) element.readOnly = true;
    });
    const host = slot.querySelector<HTMLElement>(":scope > .mc-split-frozen-host");
    host?.replaceChildren(copy);
    setCopied(true);
  }, [sessionId, liveSessionId]);
  return (
    <div
      ref={ref}
      className="mc-split-frozen"
      aria-hidden
      onPointerDown={(event) => {
        // Nothing in the copy works; the press goes to the live composer.
        event.preventDefault();
        focusSplitColumn(sessionId);
        focusLiveComposer(sessionId);
      }}
    >
      <div className="mc-split-frozen-host" />
      {copied ? null : fallback}
    </div>
  );
}

type ComposerSlot = (variant: "docked" | "home") => ReactNode;

export function SplitColumns({ visible, renderComposer }: { visible: boolean; renderComposer: ComposerSlot }) {
  const { t } = useTranslation();
  const columns = useSplitView((state) => state.columns);
  const weights = useSplitView((state) => state.weights);
  const dropHint = useSplitView((state) => state.dropHint);
  const active = useAppStore((state) => state.activeSessionId) ?? "";
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [dockShare, setDockShare] = useState(readDockShare);
  const [resizing, setResizing] = useState(false);

  const startColumnResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, index: number) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const widths = [...(rootRef.current?.querySelectorAll<HTMLElement>(":scope > .mc-split-col") ?? [])].map(
        (element) => element.getBoundingClientRect().width,
      );
      const start = event.clientX;
      const startWeights = useSplitView.getState().weights;
      setResizing(true);
      trackDrag(
        (moveEvent) => setSplitWeights(resizeColumns(startWeights, widths, index, moveEvent.clientX - start)),
        () => setResizing(false),
      );
    },
    [],
  );

  const startDockResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const column = handle.closest<HTMLElement>(".mc-split-col");
    const body = column?.querySelector<HTMLElement>(".mc-split-col-body");
    if (!body) return;
    const rect = body.getBoundingClientRect();
    setResizing(true);
    let share = readDockShare();
    trackDrag(
      (moveEvent) => {
        share = Math.min(DOCK_MAX, Math.max(DOCK_MIN, (rect.bottom - moveEvent.clientY) / rect.height));
        setDockShare(share);
      },
      () => {
        setResizing(false);
        try {
          localStorage.setItem(DOCK_KEY, String(share));
        } catch {
          // best-effort persistence
        }
      },
    );
  }, []);

  return (
    <div
      ref={rootRef}
      className="mc-split"
      data-resizing={resizing ? "true" : undefined}
      aria-label={t("mcProject.splitLabel")}
    >
      {columns.map((id, index) => (
        <Fragment key={id || "<new>"}>
          {index > 0 ? (
            <div
              className="mc-split-divider"
              role="separator"
              aria-orientation="vertical"
              aria-label={t("mcProject.splitResize")}
              onPointerDown={(event) => startColumnResize(event, index - 1)}
            />
          ) : null}
          <SplitColumn
            id={id}
            focused={id === active}
            activeId={active}
            weight={weights[index] ?? 1}
            visible={visible}
            dockShare={dockShare}
            renderComposer={renderComposer}
            onDockResizeStart={startDockResize}
          />
        </Fragment>
      ))}
      {dropHint && columns.length < 3 ? (
        <div className="mc-split-drop-hint" aria-hidden>
          <span>{t("mcProject.splitOpenRight")}</span>
        </div>
      ) : null}
    </div>
  );
}

function SplitColumn({
  id,
  focused,
  weight,
  visible,
  dockShare,
  renderComposer,
  onDockResizeStart,
  activeId,
}: {
  id: string;
  activeId: string;
  focused: boolean;
  weight: number;
  visible: boolean;
  dockShare: number;
  renderComposer: ComposerSlot;
  onDockResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  const { t } = useTranslation();
  const title = useAppStore((state) => (id ? state.sessions.find((session) => session.id === id)?.title : undefined));
  const running = useAppStore((state) => (id ? state.runningSessions[id] === true : false));
  const dockOpen = useAppStore((state) => focused && state.workPanelOpen);
  // An unfocused column keeps its tool area where its work panel was open.
  const otherDock = useAppStore((state) => (!focused && id ? state.workPanelContexts[id] : undefined));
  const model = useAppStore((state) => (id ? state.sessions.find((session) => session.id === id)?.modelId : undefined));
  const otherTabs = otherDock?.open ? otherDock.tabs : undefined;
  const prefs = usePanePrefs();
  useColumnTranscript(id, focused);

  /*
    The transcript keeps room for the composer below it through
    --composer-dock-height, which the live composer publishes for the whole
    window. Each column measures its own composer (live or copy) and sets the
    variable on itself, so focusing another column moves nothing.
  */
  const chatRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const chat = chatRef.current;
    if (!chat || typeof ResizeObserver === "undefined") return;
    let observed: Element | null = null;
    let published = "";
    const publish = () => {
      if (!observed) return;
      const height = `${Math.round(observed.getBoundingClientRect().height)}px`;
      if (height === published) return;
      published = height;
      chat.style.setProperty("--composer-dock-height", height);
    };
    const resize = new ResizeObserver(publish);
    const bind = () => {
      const dock = chat.querySelector(":scope .composer-dock");
      if (dock !== observed) {
        if (observed) resize.unobserve(observed);
        observed = dock;
        if (dock) resize.observe(dock);
      }
      publish();
    };
    bind();
    const mutations = new MutationObserver(bind);
    mutations.observe(chat, { childList: true, subtree: true });
    return () => {
      mutations.disconnect();
      resize.disconnect();
    };
  }, []);
  const label = id ? (isDefaultTitle(title) ? t("chat.untitledTask") : (title as string)) : t("chat.emptyTitle");
  const panes = otherTabs ? groupPanes(otherTabs.filter(isKnownWorkPanelTab), prefs.order) : [];

  return (
    <section
      className="mc-split-col"
      data-focused={focused ? "true" : undefined}
      data-split-session={id}
      style={{ flexGrow: weight }}
      onPointerDownCapture={(event) => {
        // The close button and the column's info panel work without focusing it.
        if (focused || (event.target as Element).closest(".mc-split-col-close, .mc-session-info, .mc-split-frozen")) return;
        focusSplitColumn(id);
      }}
    >
      <header className="mc-split-col-head">
        <span className={`mc-session-tab-dot${running ? " running" : ""}`} aria-hidden />
        <span className="mc-split-col-title" title={label}>
          {label}
        </span>
        <button
          type="button"
          className="mc-split-col-close"
          aria-label={t("mcProject.splitClose", { title: label })}
          title={t("mcProject.splitClose", { title: label })}
          onClick={() => closeSplitColumn(id)}
        >
          <IconClose size={11} aria-hidden />
        </button>
      </header>
      <div className="mc-split-col-body">
        <div className="mc-split-chat" ref={chatRef}>
          {id ? <SessionInfo sessionId={id} scope="column" /> : null}
          {id ? (
            <div className="session-panes">
              <SessionPane sessionId={id} visible={visible} />
            </div>
          ) : (
            <div className="home-main-content mc-split-new">
              <div className="home-scroll">
                <div className="home-stack-inner">
                  <div className="empty-hero">
                    <h1>{t("chat.emptyTitle")}</h1>
                  </div>
                </div>
              </div>
            </div>
          )}
          {focused ? (
            id ? (
              <LiveComposerSlot sessionId={id}>{renderComposer("docked")}</LiveComposerSlot>
            ) : (
              <div className="home-composer-wrap">{renderComposer("home")}</div>
            )
          ) : (
            <FrozenComposer
              sessionId={id}
              liveSessionId={activeId}
              fallback={
                <div className="composer-dock composer-dock-docked">
                  <div className="composer-stack">
                    <div className="composer-shell mc-split-ghost">
                      <span className="mc-split-ghost-placeholder">{t(PLACEHOLDER_KEYS.docked[0])}</span>
                      {model ? <span className="mc-split-ghost-model">{model}</span> : null}
                    </div>
                  </div>
                </div>
              }
            />
          )}
        </div>
        {dockOpen ? (
          <>
            <div
              className="mc-split-dock-divider"
              role="separator"
              aria-orientation="horizontal"
              aria-label={t("mcProject.splitDockResize")}
              onPointerDown={onDockResizeStart}
            />
            <div className="mc-split-dock" style={{ flexBasis: `${dockShare * 100}%` }}>
              <Suspense fallback={null}>
                <WorkPanelBottomDock />
              </Suspense>
            </div>
          </>
        ) : otherDock?.open ? (
          <>
            <div className="mc-split-dock-divider" aria-hidden />
            <div className="mc-split-dock mc-split-dock-frozen" style={{ flexBasis: `${dockShare * 100}%` }}>
              <div className="mc-split-tools" role="group" aria-label={t("mcProject.splitTools")}>
                {panes.map((pane) => {
                  const Icon = PANE_ICONS[pane.id];
                  const paneTitle = t(`mcProject.pane${pane.id[0]?.toUpperCase()}${pane.id.slice(1)}`);
                  const tab = pane.tabs[pane.tabs.length - 1];
                  return (
                    <button
                      key={pane.id}
                      type="button"
                      className="mc-split-tool"
                      title={paneTitle}
                      onClick={() => tab && void openSplitColumnTool(id, tab)}
                    >
                      <Icon size={12} aria-hidden />
                      <span>{paneTitle}</span>
                      {pane.tabs.length > 1 ? <span className="mc-split-tool-count">{pane.tabs.length}</span> : null}
                    </button>
                  );
                })}
              </div>
              <div className="mc-split-dock-hint">{t("mcProject.splitResume")}</div>
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}
