import { ActionSlotSide } from "./ActionBarSlots";
import { slotMessage } from "../../../plugins/renderer-slots/slot-message";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import type { UiMessage } from "@pi-desktop/shared";
import { Button } from "../../../components/ui";
import { Markdown } from "../../../components/Markdown";
import { IconChevronDown, IconChevronRight } from "../../../components/icons";
import { SessionMessageOrigin } from "./SessionMessageOrigin";
import { CopyButton, MessageTimestamp, LinkifiedText } from "./shared";
import { useAutomaticDisclosure, disclosureKey } from "./disclosure";
import { noticePreview, type NoticeCardData } from "./notice-card-model";
import "../../../styles/mc-notice-card.css";

export function NoticeCard({ message, data }: { message: UiMessage; data: NoticeCardData }) {
  const { t } = useTranslation();
  const id = useId();
  const slotUser = message.role === "user" ? slotMessage("user", message) : undefined;
  const disclosure = useAutomaticDisclosure(false, undefined, disclosureKey("notice", message.id));
  const title = t(data.kind === "background" ? "sessionCollaboration.backgroundNotice"
    : data.kind === "completion" ? "sessionCollaboration.completionMessage"
    : data.kind === "task" ? "sessionCollaboration.taskMessage" : "sessionCollaboration.agentMessage");
  const preview = data.commands ? t("sessionCollaboration.commandCount", { count: data.commands.length }) : noticePreview(data);
  const statusKey = data.status ? ({ queued: "statusQueued", running: "statusRunning", completed: "statusCompleted", failed: "statusFailed", cancelled: "statusCancelled", interrupted: "statusInterrupted" } as Record<string, string>)[data.status] : undefined;
  return <article className="message-row session-message" data-message-id={message.id} data-minimap-id={message.id} aria-label={title}>
    <div className="message-col mc-notice-card" data-notice-kind={data.kind}>
      {message.sessionMessage ? <SessionMessageOrigin origin={message.sessionMessage} /> : null}
      <Button variant="ghost" className="mc-notice-toggle" ref={disclosure.titleRef} aria-expanded={disclosure.open} aria-controls={id} onClick={disclosure.toggle}>
        {disclosure.open ? <IconChevronDown size={16} /> : <IconChevronRight size={16} />}
        <span><strong>{title}{statusKey ? ` · ${t(`sessionCollaboration.${statusKey}`)}` : ""}</strong><span className="mc-notice-preview">{preview || t("sessionCollaboration.unavailable")}</span></span>
      </Button>
      {disclosure.open ? <div id={id} className="mc-notice-body selectable" ref={disclosure.bodyRef} {...disclosure.bodyEvents}>
        {data.error ? <div className="mc-notice-error"><strong>{t("sessionCollaboration.failure")}</strong><Markdown source={data.error} /></div> : null}
        {data.body ? <Markdown source={data.body} /> : null}
        {data.commands?.map((command, index) => <section className="mc-notice-command" key={`${command.id}:${index}`}>
          <strong>{t(command.failed ? "sessionCollaboration.statusFailed" : command.outcome.endsWith("unknown") ? "sessionCollaboration.unavailable" : "sessionCollaboration.statusCompleted")}</strong>
          <span className="mc-notice-meta">{command.outcome}</span>
          <pre>{command.command}</pre>
          {command.output ? <pre>{command.output}</pre> : null}
        </section>)}
        {message.attachments?.map((attachment, index) => <div key={index}><LinkifiedText text={attachment.ref} attachments={[attachment]} /></div>)}
        <details className="mc-notice-raw"><summary>{t("sessionCollaboration.rawNotice")}</summary><pre>{message.content}</pre></details>
      </div> : null}
      <div className="message-actions"><MessageTimestamp createdAt={message.createdAt} /><ActionSlotSide slot="userAction" side="left" message={slotUser} /><CopyButton text={message.content} label={t("chat.copy")} /><ActionSlotSide slot="userAction" side="right" message={slotUser} /></div>
    </div>
  </article>;
}
