import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { CanvasThread } from "@pi-desktop/shared";
import { cx } from "../../components/ui";
import { IconX } from "../../components/icons";
import type { Point } from "./canvas-model";

// Comment popovers and the comment list of the prototype canvas.

const POPOVER_W = 340;
const POPOVER_H = 240;

/** Where a popover goes for a point: beside it, kept inside the stage. */
function popoverPlace(at: Point, bounds: { w: number; h: number }, dx = 12, dy = 12) {
  const left = Math.max(8, Math.min(at.x + dx, bounds.w - POPOVER_W - 8));
  const top = at.y + dy + POPOVER_H > bounds.h ? Math.max(8, at.y - POPOVER_H) : at.y + dy;
  return { left, top };
}

export function CommentComposer({
  at,
  bounds,
  label,
  onCancel,
  onSubmit,
}: {
  at: Point;
  bounds: { w: number; h: number };
  label?: string | null;
  onCancel: () => void;
  /** `sendToAgent` hands the thread to the conversation; `queue` waits for the next message. */
  onSubmit: (text: string, sendToAgent: boolean, queue: boolean) => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  // "@Agent" in the text is a way of saying "send it"; it is not kept.
  const body = text.replace(/(^|\s)@agent\b/gi, " ").trim();
  const submit = (sendToAgent: boolean, queue = false) => {
    if (body) onSubmit(body, sendToAgent, queue);
  };
  return (
    <div className="mc-canvas-popover" style={popoverPlace(at, bounds)} onPointerDown={(event) => event.stopPropagation()}>
      {label ? <div className="mc-canvas-popover-label">{t("mcProject.canvasCommentOn", { label })}</div> : null}
      <textarea
        autoFocus
        rows={3}
        value={text}
        placeholder={t("mcProject.canvasCommentPlaceholder")}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit(true);
          }
          if (event.key === "Escape") onCancel();
        }}
      />
      <div className="mc-canvas-popover-actions">
        <button type="button" onClick={onCancel}>
          {t("mcProject.canvasCancel")}
        </button>
        <span className="mc-canvas-tab-spacer" />
        <button type="button" disabled={!body} onClick={() => submit(false)}>
          {t("mcProject.canvasCommentSubmit")}
        </button>
        <button type="button" disabled={!body} onClick={() => submit(true, true)}>
          {t("mcProject.canvasQueueToAgent")}
        </button>
        <button type="button" className="is-primary" disabled={!body} title="⌘↩" onClick={() => submit(true)}>
          {t("mcProject.canvasSendToAgent")}
        </button>
      </div>
    </div>
  );
}

export function ThreadPopover({
  at,
  bounds,
  thread,
  number,
  onClose,
  onReply,
  onStatus,
  onDelete,
  onSend,
  onError,
}: {
  at: Point;
  bounds: { w: number; h: number };
  thread: CanvasThread;
  number?: number;
  onClose: () => void;
  onReply: (text: string) => Promise<void>;
  onStatus: (status: "open" | "resolved") => Promise<void>;
  onDelete: () => Promise<void>;
  onSend: (queue: boolean) => void;
  onError: (failure: unknown) => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const reply = () => {
    const body = text.trim();
    if (!body) return;
    void onReply(body)
      .then(() => setText(""))
      .catch(onError);
  };
  return (
    <div className="mc-canvas-popover is-thread" style={popoverPlace(at, bounds, 16, -8)} onPointerDown={(event) => event.stopPropagation()}>
      <div className="mc-canvas-popover-head">
        <span className="mc-canvas-pin-badge">{number ?? "✓"}</span>
        <span className="mc-canvas-popover-label">
          {thread.anchor.label ? t("mcProject.canvasCommentOn", { label: thread.anchor.label }) : t(`mcProject.canvasAnchor_${thread.anchor.kind}`)}
        </span>
        <button type="button" className="mc-canvas-icon" aria-label={t("mcProject.canvasClose")} onClick={onClose}>
          <IconX size={12} />
        </button>
      </div>
      {thread.located.state === "moved" || thread.located.state === "boardMissing" ? (
        <p className="mc-canvas-moved">{t(`mcProject.canvasLocated_${thread.located.state}`)}</p>
      ) : null}
      <div className="mc-canvas-messages">
        {thread.messages.map((message) => (
          <div key={message.id} className={cx("mc-canvas-message", `is-${message.author}`)}>
            <span className="mc-canvas-message-author">
              {message.author === "agent" ? t("mcProject.canvasAuthorAgent") : t("mcProject.canvasAuthorUser")}
            </span>
            <span className="selectable">{message.text}</span>
          </div>
        ))}
      </div>
      <textarea
        rows={2}
        value={text}
        placeholder={t("mcProject.canvasReplyPlaceholder")}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            reply();
          }
        }}
      />
      <div className="mc-canvas-popover-actions">
        <button type="button" className="is-danger" onClick={() => void onDelete().catch(onError)}>
          {t("mcProject.canvasDelete")}
        </button>
        <button type="button" onClick={() => void onStatus(thread.status === "open" ? "resolved" : "open").catch(onError)}>
          {thread.status === "open" ? t("mcProject.canvasResolve") : t("mcProject.canvasReopen")}
        </button>
        <button type="button" className="is-primary" disabled={!text.trim()} onClick={reply}>
          {t("mcProject.canvasReply")}
        </button>
      </div>
      <div className="mc-canvas-popover-agent">
        {thread.agentSession ? <span className="mc-canvas-muted">{t("mcProject.canvasSentToAgent")}</span> : null}
        <span className="mc-canvas-tab-spacer" />
        <button type="button" onClick={() => onSend(true)}>
          {t("mcProject.canvasQueueToAgent")}
        </button>
        <button type="button" onClick={() => onSend(false)}>
          {thread.agentSession ? t("mcProject.canvasSendAgain") : t("mcProject.canvasSendToAgent")}
        </button>
      </div>
    </div>
  );
}

export function CommentsPanel({
  threads,
  filter,
  numberOf,
  onFilter,
  onClose,
  onOpen,
}: {
  threads: CanvasThread[];
  filter: "open" | "resolved";
  numberOf: Map<string, number>;
  onFilter: (filter: "open" | "resolved") => void;
  onClose: () => void;
  onOpen: (thread: CanvasThread) => void;
}) {
  const { t } = useTranslation();
  const shown = threads.filter((thread) => thread.status === filter);
  return (
    <aside className="mc-canvas-panel" onPointerDown={(event) => event.stopPropagation()}>
      <div className="mc-canvas-panel-head">
        {(["open", "resolved"] as const).map((value) => (
          <button key={value} type="button" className={cx(filter === value && "active")} onClick={() => onFilter(value)}>
            {t(`mcProject.canvasFilter_${value}`, { count: threads.filter((thread) => thread.status === value).length })}
          </button>
        ))}
        <button type="button" className="mc-canvas-icon" aria-label={t("mcProject.canvasClose")} onClick={onClose}>
          <IconX size={12} />
        </button>
      </div>
      {shown.length ? (
        shown.map((thread) => (
          <button key={thread.id} type="button" className="mc-canvas-panel-item" onClick={() => onOpen(thread)}>
            <span className="mc-canvas-pin-badge">{numberOf.get(thread.id) ?? "✓"}</span>
            <span className="mc-canvas-panel-text">
              <span>{thread.messages[0]?.text}</span>
              <span className="mc-canvas-muted">
                {thread.anchor.label ?? t(`mcProject.canvasAnchor_${thread.anchor.kind}`)}
                {thread.located.state === "moved" ? ` · ${t("mcProject.canvasMovedShort")}` : ""}
                {thread.agentSession ? ` · ${t("mcProject.canvasSentShort")}` : ""}
                {thread.messages.length > 1 ? ` · ${t("mcProject.canvasReplies", { count: thread.messages.length - 1 })}` : ""}
              </span>
            </span>
          </button>
        ))
      ) : (
        <p className="mc-canvas-muted mc-canvas-panel-empty">{t("mcProject.canvasNoComments")}</p>
      )}
    </aside>
  );
}
