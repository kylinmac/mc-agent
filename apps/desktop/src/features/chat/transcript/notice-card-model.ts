import type { UiMessage } from "@pi-desktop/shared";

const BACKGROUND_START = "[Automatic notice, not a message from the user] Background command(s) you started have ended:\n";
const BACKGROUND_END = "\nRead the full output with BashOutput if you need it, then carry on with the task. If nothing is left to do, reply briefly.";
export type NoticeCommand = { command: string; outcome: string; failed: boolean; output: string; id: string };
export type NoticeCardData = {
  kind: "task" | "message" | "completion" | "background";
  body: string;
  error?: string;
  status?: string;
  commands?: NoticeCommand[];
};
const statuses = new Set(["queued", "running", "completed", "failed", "cancelled", "interrupted"]);

/** Presentation only: never use text classification to grant provenance or permissions. */
export function noticeCardData(message: Pick<UiMessage, "role" | "content" | "sessionMessage">): NoticeCardData | null {
  const content = message.content || "";
  if (message.sessionMessage) {
    const kind = message.sessionMessage.kind;
    if (kind !== "completion") return { kind, body: content };
    try {
      const value: unknown = JSON.parse(content);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const record = value as Record<string, unknown>;
        // Only unwrap the host's completion envelope, not arbitrary JSON prose.
        if (typeof record.messageId === "string" && (typeof record.result === "string" || typeof record.error === "string")) {
          return { kind, body: typeof record.result === "string" ? record.result : "",
            error: typeof record.error === "string" ? record.error : undefined,
            status: typeof record.status === "string" && statuses.has(record.status) ? record.status : undefined };
        }
      }
    } catch { /* Plain-text reports and older formats remain readable in full. */ }
    return { kind, body: content };
  }
  if (message.role !== "user" || !content.startsWith(BACKGROUND_START) || !content.endsWith(BACKGROUND_END)) return null;
  const body = content.slice(BACKGROUND_START.length, -BACKGROUND_END.length);
  const pattern = /^- `([\s\S]*?)` (failed(?: \(exit code -?\d+\))?|exited with code (?:-?\d+|unknown)) \(backgroundId ([^\n)]+)\)\.(?:\nLast output:\n```\n([\s\S]*?)\n```|\nNo output\.)(?=\n- `|$)/gm;
  const matches = [...body.matchAll(pattern)];
  if (!matches.length || matches.map((m) => m[0]).join("\n") !== body) return null;
  return { kind: "background", body: "", commands: matches.map((m) => ({ command: m[1], outcome: m[2], id: m[3], output: m[4] ?? "",
    failed: m[2].startsWith("failed") || /^exited with code -?[1-9]/.test(m[2]) })) };
}

export function noticePreview(data: NoticeCardData): string {
  const text = data.error || data.body;
  return text.replace(/[#*`>|]/g, "").replace(/\s+/g, " ").trim().slice(0, 180);
}
