import { racpError } from "./errors.js";

import type { StartTurnParams } from "./agent-host-contracts.js";


type IdempotencyEntry = {
  turnId: string;
  inputHash: string;
  sessionId: string;
  userMessageId?: string;
  voiceOrigin?: { callId: string; operationId: string };
};

const MAX_IDEMPOTENCY_ENTRIES = 2000;

/** Small stable hash so a reused idempotency key with other input is detected. */
export function hashInput(input: StartTurnParams["input"]): string {
  const encoded = JSON.stringify({
    text: input.text,
    attachments: input.attachments ?? [],
    ...(input.sessionMessageId ? { sessionMessageId: input.sessionMessageId } : {}),
  });
  let hash = 5381;
  for (let index = 0; index < encoded.length; index += 1) {
    hash = ((hash << 5) + hash + encoded.charCodeAt(index)) | 0;
  }
  return `${encoded.length}:${(hash >>> 0).toString(16)}`;
}
export class TurnIdempotency {
  private readonly entries = new Map<string, IdempotencyEntry>();

  lookup(subject: string, key: string, inputHash?: string): IdempotencyEntry | undefined {
    const entry = this.entries.get(`${subject}|${key}`);
    if (entry && inputHash !== undefined && entry.inputHash !== inputHash) {
      throw racpError("IDEMPOTENCY_CONFLICT", "the idempotency key was reused with different input");
    }
    return entry;
  }

  remember(subject: string, key: string, entry: IdempotencyEntry): void {
    this.entries.set(`${subject}|${key}`, entry);
    while (this.entries.size > MAX_IDEMPOTENCY_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
