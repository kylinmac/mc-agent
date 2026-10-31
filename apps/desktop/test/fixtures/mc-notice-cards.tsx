import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useAppStore } from "../../src/stores/app-store";
import { NoticeCard } from "../../src/features/chat/transcript/NoticeCard";
import { noticeCardData } from "../../src/features/chat/transcript/notice-card-model";
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
function check(ok, text) { if (!ok) throw new Error(text); }
export async function checkNoticeCards() {
  const node = document.createElement("div"); document.body.append(node);
  const root = createRoot(node);
  const message = { id: "notice-test", role: "user", content: JSON.stringify({ messageId: "host-message", result: "## 检查完成\n\n**没有加密**\n\n- 第一项\n- 第二项", status: "completed" }),
    sessionMessage: { kind: "completion", sourceTitle: "来源任务", sourceSessionId: "a", targetSessionId: "b", messageId: "host-message" } };
  try {
    flushSync(() => root.render(<NoticeCard message={message} data={noticeCardData(message)} />));
    check(!node.querySelector(".mc-notice-body"), "notice must start collapsed");
    check(node.textContent.includes("没有加密"), "collapsed result preview");
    node.querySelector(".mc-notice-toggle").click(); await settle();
    check(node.querySelector("h2")?.textContent === "检查完成", "Markdown heading rendered");
    check(node.querySelectorAll("li").length === 2, "Markdown list rendered");
    check(node.querySelector(".mc-notice-raw pre").textContent === message.content, "raw envelope retained");
    check(node.querySelector(".session-message-source").title === "a", "source id in tooltip");
    node.querySelector(".mc-notice-toggle").click(); await settle();
    check(!node.querySelector(".mc-notice-body"), "notice collapses again");
    node.querySelector(".session-message-source").click(); await settle();
    check(useAppStore.getState().activeSessionId === "a", "source opens its conversation");
    for (const kind of ["task", "message"]) {
      const next = { ...message, id: kind, content: "**任务详情**", sessionMessage: { ...message.sessionMessage, kind } };
      flushSync(() => root.render(<NoticeCard key={kind} message={next} data={noticeCardData(next)} />));
      check(node.querySelector("[data-notice-kind]").dataset.noticeKind === kind, "distinct collaboration kind");
    }
    const background = { ...message, id: "background", sessionMessage: undefined, content: "original notice" };
    flushSync(() => root.render(<NoticeCard key="background" message={background} data={{ kind: "background", body: "", commands: [{ id: "cmd", command: "echo test", outcome: "exited with code 1", failed: true, output: "<script>literal</script>" }] }} />));
    node.querySelector(".mc-notice-toggle").click(); await settle();
    check(node.querySelector(".mc-notice-command").textContent.includes("失败"), "failed command status");
    check(!node.querySelector("script"), "command output stays plain text");
  } finally { root.unmount(); node.remove(); }
}
