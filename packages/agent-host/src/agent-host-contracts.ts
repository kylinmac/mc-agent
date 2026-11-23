import type {
  AgentPromptAttachment,
  RacpCursor,
  RacpLimits,
  RacpPolicy,
  RacpRequestContext,
  RacpRole,
  RacpSession,
  RacpSessionSnapshot,
  RacpTurn,
  RacpTurnAdmission,
  VoiceOrigin,
} from "@pi-desktop/shared";
import { type ApprovalPort } from "./approvals.js";
import {
  type Clock,
  type IdSource,
  type QueueStore,
  type RuntimePort,
  type SessionPort,
} from "./ports.js";

export type AgentHostOptions = {
  runtime: RuntimePort;
  sessions: SessionPort;
  approvals: ApprovalPort;
  queueStore?: QueueStore;
  clock?: Clock;
  ids?: IdSource;
  limits?: Partial<RacpLimits>;
  policy?: Partial<RacpPolicy>;
  /** Lifetime for approvals raised while no remote subscriber is attached. */
  localApprovalLifetimeMs?: number;
  /** Whether Host policy lets remote approvers grant `allow-session`. */
  allowRemoteSessionGrants?: boolean;
  /** Bound on the transcript page in a snapshot. */
  snapshotItems?: number;
  /** Called after any change to a session's queue, with the new entries. */
  onQueueChange?: (sessionId: string, entries: QueueEntryView[]) => void;
};

/** A queued turn together with the prompt it will send. */
export type QueueEntryView = {
  turn: RacpTurn;
  content: string;
  sessionMessageId?: string;
  userMessageId?: string;
  voiceOrigin?: VoiceOrigin;
  attachments?: AgentPromptAttachment[];
  /** Set only for promoted entries; entries are already in delivery order. */
  priority?: number;
};

export type StartTurnParams = {
  sessionId: string;
  idempotencyKey?: string;
  /** Main-private identity captured when authorizing a Live work scope. */
  expectedWorkspaceIdentity?: string | null;
  admission?: RacpTurnAdmission;
  input: {
    text: string;
    attachments?: AgentPromptAttachment[];
    sessionMessageId?: string;
    /** Client-chosen id for the durable user row (D288). */
    userMessageId?: string;
    voiceOrigin?: VoiceOrigin;
  };
  context: RacpRequestContext;
};

export type StartTurnResult = { accepted: true; turn: RacpTurn; cursor: RacpCursor };

export type AgentWorkSnapshot = {
  sessionId: string;
  mode: "agent" | "plan" | "goal";
  state: "idle" | "running" | "waiting-permission" | "waiting-input" | "finalizing";
  activeTurnId?: string;
  activeTurnStatus?: RacpTurn["status"];
  queue: Array<{ queueEntryId: string; position: number }>;
  revision: number;
};

export type AttachParams = {
  sessionId: string;
  role?: RacpRole;
  after?: RacpCursor;
  includeSnapshot?: boolean;
};

export type AttachResult = {
  session: RacpSession;
  role: RacpRole;
  replayComplete: boolean;
  resyncReason?: "epoch" | "evicted" | "ahead";
  snapshot?: RacpSessionSnapshot;
};
