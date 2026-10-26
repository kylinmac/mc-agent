import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionThinkingLevel, UiMessage } from "@pi-desktop/shared";
import { imageGenerationBindings, isImageGenerationModel, stripCanvasData } from "@pi-desktop/shared";
import { TooltipButton } from "../../components/ui";
import { IconArrowUp, IconExternal, IconPlus, IconStop, IconX } from "../../components/icons";
import { Markdown } from "../../components/Markdown";
import { PermissionCard } from "../../components/PermissionCard";
import { api } from "../../lib/api";
import { useHeldSession } from "../../lib/use-held-session";
import { untitledTaskTitle } from "../../lib/session-title-utils";
import { useTranscriptView } from "../../hooks/use-transcript-view";
import { useAppStore } from "../../stores/app-store";
import { ToolRow } from "../chat/transcript/ToolRow";
import { AssistantErrorMessage, ThinkingRow } from "../chat/transcript/shared";
import { TranscriptDisclosureProvider } from "../chat/transcript/disclosure";
import { composerModelDisplayName } from "../../lib/composer-models";
import { inheritedSessionModelBinding } from "../../lib/session-model";
import { ComposerModelPicker } from "../chat/composer/ComposerModelPicker";
import { useComposerModelMenu } from "../chat/composer/hooks/useComposerModelMenu";
import { isThinkingLevel, thinkingLevelForProvider, thinkingProviderForModel } from "../chat/composer/model";

/*
  mc-agent creative studio: a compact conversation inside the studio, in the
  project's folder. The agent can draw with code or call the image model; the
  session's system prompt tells it where images belong, and what it makes
  lands in the library. The conversation streams live while the main chat
  shows something else (it is pinned like a split-view column).
*/

const CHAT_KEY = "mc.creative.chat.";

function readChat(groupId: string): string | null {
  try {
    return localStorage.getItem(CHAT_KEY + groupId);
  } catch {
    return null;
  }
}

function storeChat(groupId: string, sessionId: string | null) {
  try {
    if (sessionId) localStorage.setItem(CHAT_KEY + groupId, sessionId);
    else localStorage.removeItem(CHAT_KEY + groupId);
  } catch {
    // Remembering the conversation is a convenience only.
  }
}

type ModelChoice = { providerId?: string; modelId?: string; thinkingLevel?: SessionThinkingLevel };

const MODEL_KEY = "mc.creative.chatModel.";

/** The model picked before the conversation exists, per project. */
function readModel(groupId: string): ModelChoice | null {
  try {
    const raw = localStorage.getItem(MODEL_KEY + groupId);
    return raw ? (JSON.parse(raw) as ModelChoice) : null;
  } catch {
    return null;
  }
}

function storeModel(groupId: string, choice: ModelChoice) {
  try {
    localStorage.setItem(MODEL_KEY + groupId, JSON.stringify(choice));
  } catch {
    // Remembering the model is a convenience only.
  }
}

function visible(message: UiMessage): boolean {
  if (message.role === "system") return false;
  return !(message as UiMessage & { parentToolCallId?: string }).parentToolCallId;
}

const handledRequests = new Set<number>();

/**
 * What the canvas adds to the chat (docs/mc-agent/creative-canvas.md): chips
 * for what goes with the next message, the fenced text they become, a hook
 * that runs once the conversation exists (to send threads to it), and a
 * request to send right away.
 */
export type StudioChatExtra = {
  chips: Array<{ key: string; label: string; onRemove: () => void }>;
  text: () => string;
  beforeSend?: (sessionId: string) => Promise<void>;
  afterSend?: () => void;
  request?: { id: number; text: string } | null;
};

export function StudioChat({
  groupId,
  projectPath,
  context = "",
  contextCount = 0,
  contextLabel,
  extra,
}: {
  groupId: string;
  projectPath: string | null;
  /** Sent ahead of each message, e.g. the images being compared. */
  context?: string;
  contextCount?: number;
  /** Shown instead of the comparison wording, e.g. for the canvas. */
  contextLabel?: string;
  extra?: StudioChatExtra;
}) {
  const { t } = useTranslation();
  const settings = useAppStore((state) => state.settings);
  const sessions = useAppStore((state) => state.sessions);
  const sendPrompt = useAppStore((state) => state.sendPrompt);
  const enqueuePrompt = useAppStore((state) => state.enqueuePrompt);
  const abortSession = useAppStore((state) => state.abortSession);
  const selectSession = useAppStore((state) => state.selectSession);
  const setPage = useAppStore((state) => state.setPage);
  const providers = useAppStore((state) => state.providers);
  const providerModels = useAppStore((state) => state.providerModels);
  const recentModels = useAppStore((state) => state.recentModels);
  const showToast = useAppStore((state) => state.showToast);
  const [draftModel, setDraftModel] = useState<ModelChoice | null>(() => readModel(groupId));
  const [sessionId, setSessionId] = useState<string | null>(() => readChat(groupId));
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setSessionId(readChat(groupId));
    setDraftModel(readModel(groupId));
  }, [groupId]);
  // A remembered conversation that was deleted starts over. The sidebar's
  // list can be incomplete while loading, so the host is asked.
  const listed = sessions.some((session) => session.id === sessionId);
  useEffect(() => {
    if (!sessionId || listed) return;
    let live = true;
    void api
      .getSession(sessionId, { messageLimit: 1 })
      .then(({ session }) => {
        if (live && !session) {
          setSessionId(null);
          storeChat(groupId, null);
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [sessionId, listed, groupId]);
  useHeldSession(sessionId);
  const { messages } = useTranscriptView(sessionId ?? "");
  const running = useAppStore((state) => (sessionId ? Boolean(state.runningSessions[sessionId]) : false));
  const queue = useAppStore((state) => (sessionId ? state.pendingPermissions[sessionId] : undefined));
  const permission = queue?.[0];
  const rows = messages.filter(visible);

  // The model: the conversation's own once it exists, else the one picked
  // here, else what a new chat would use.
  const session = sessions.find((entry) => entry.id === sessionId);
  const selected = inheritedSessionModelBinding({
    draft: session ?? draftModel,
    settings,
    providers,
    recentModels,
  });
  const provider = providers.find((entry) => entry.id === selected.providerId);
  const modelId = selected.modelId;
  const thinkingProvider = thinkingProviderForModel(provider, modelId, provider ? providerModels[provider.id] : undefined);
  const storedLevel = session?.thinkingLevel ?? draftModel?.thinkingLevel;
  const thinkingLevel = thinkingLevelForProvider(thinkingProvider, isThinkingLevel(storedLevel) ? storedLevel : "off");
  const imageCandidates = useMemo(
    () => imageGenerationBindings(settings?.imageGenerationModels, settings?.imageGeneration),
    [settings?.imageGenerationModels, settings?.imageGeneration],
  );
  // Image models answer in the 直出 tab; a chat needs a model that talks
  // (and calls the image model itself when asked to draw).
  const modelReady =
    !!provider &&
    provider.enabled &&
    !!modelId &&
    !isImageGenerationModel(imageCandidates, provider.id, modelId) &&
    (provider.hasSecret || provider.authKind === "none");
  const modelMenu = useComposerModelMenu({
    mode: "agent",
    activeSessionId: sessionId,
    provider,
    modelId,
    thinkingProvider,
    thinkingLevel,
    controlsBlocked: running,
    configureActiveSession: async (configuration) => {
      const choice: ModelChoice = {
        providerId: configuration.providerId ?? provider?.id,
        modelId: configuration.modelId ?? modelId,
        thinkingLevel: configuration.thinkingLevel,
      };
      if (!sessionId) {
        setDraftModel(choice);
        storeModel(groupId, choice);
        return;
      }
      try {
        await api.configureSession(sessionId, {
          mode: session?.mode ?? "agent",
          providerId: choice.providerId,
          modelId: choice.modelId,
          thinkingLevel: choice.thinkingLevel,
        });
        storeModel(groupId, choice);
        await useAppStore.getState().refreshSessions();
      } catch (failure) {
        showToast(failure instanceof Error ? failure.message : String(failure), { variant: "error" });
      }
    },
  });

  useEffect(() => {
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [rows.length, rows[rows.length - 1]?.content, permission?.requestId]);

  const ensureSession = async (): Promise<string> => {
    if (sessionId) return sessionId;
    const { session } = await api.createSession({
      title: untitledTaskTitle(),
      mode: "agent",
      ...(projectPath ? { projectPath } : {}),
      ...(provider && modelId ? { providerId: provider.id, modelId } : {}),
      thinkingLevel,
    });
    await useAppStore.getState().refreshSessions();
    setSessionId(session.id);
    storeChat(groupId, session.id);
    return session.id;
  };

  const send = async (requested?: string) => {
    const content = (requested ?? text).trim();
    if (!content || busy || !modelReady) return;
    setBusy(true);
    setError(null);
    try {
      const id = await ensureSession();
      await extra?.beforeSend?.(id);
      const full = [context, extra?.text() ?? "", content].filter(Boolean).join("\n\n");
      // A running conversation takes it as its next turn.
      const accepted =
        sessionId && running ? await enqueuePrompt(full, undefined, id) : await sendPrompt(full, undefined, id);
      if (accepted) {
        if (requested === undefined) setText("");
        extra?.afterSend?.();
      } else setError(t("mcProject.creativeChatNotSent"));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  const sendRef = useRef(send);
  sendRef.current = send;
  const requestId = extra?.request?.id;
  useEffect(() => {
    const request = extra?.request;
    // A request is sent once, even if the chat mounts again while it is set.
    if (!request || handledRequests.has(request.id)) return;
    handledRequests.add(request.id);
    void sendRef.current(request.text);
    // Only a new request id sends.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestId]);

  return (
    <div className="mc-creative-chat">
      <div className="mc-creative-chat-bar">
        <span className="mc-creative-muted">{t("mcProject.creativeChatHint")}</span>
        {sessionId ? (
          <>
            <button
              type="button"
              className="mc-creative-icon-button"
              title={t("mcProject.creativeChatOpenFull")}
              aria-label={t("mcProject.creativeChatOpenFull")}
              onClick={() => {
                void selectSession(sessionId).then(() => setPage("chat"));
              }}
            >
              <IconExternal size={13} />
            </button>
            <button
              type="button"
              className="mc-creative-icon-button"
              title={t("mcProject.creativeChatNew")}
              aria-label={t("mcProject.creativeChatNew")}
              onClick={() => {
                setSessionId(null);
                storeChat(groupId, null);
              }}
            >
              <IconPlus size={13} />
            </button>
          </>
        ) : null}
      </div>
      <div className="mc-creative-chat-log" ref={scroller}>
        <TranscriptDisclosureProvider key={sessionId ?? "new"}>
          {rows.length ? (
            rows.map((message) =>
              message.role === "user" ? (
                <div key={message.id} className="message-row user mc-creative-chat-user">
                  <div className="message-col">
                    <div className="message-bubble">
                      <UserText content={message.content} />
                    </div>
                  </div>
                </div>
              ) : message.role === "tool" ? (
                <Fragment key={message.id}>
                  <ToolRow message={message} />
                </Fragment>
              ) : (
                <div key={message.id} className="mc-creative-chat-assistant">
                  {message.thinking ? (
                    <ThinkingRow message={message} streaming={running && message.status === "streaming"} />
                  ) : null}
                  {message.content ? (
                    <div className="prose-chat selectable">
                      <Markdown source={message.content} />
                    </div>
                  ) : null}
                  {message.error ? <AssistantErrorMessage message={message} /> : null}
                </div>
              ),
            )
          ) : (
            <p className="mc-creative-muted mc-creative-chat-empty">{t("mcProject.creativeChatEmpty")}</p>
          )}
        </TranscriptDisclosureProvider>
        {permission ? (
          <PermissionCard key={permission.requestId} permission={permission} queued={(queue?.length ?? 1) - 1} />
        ) : null}
      </div>
      {error ? <p className="mc-creative-error">{error}</p> : null}
      {context ? (
        <p className="mc-creative-chat-context">
          {contextLabel ?? t("mcProject.creativeChatWithCompare", { count: contextCount })}
        </p>
      ) : null}
      {extra?.chips.length ? (
        <div className="mc-creative-chat-chips">
          {extra.chips.map((chip) => (
            <span key={chip.key} className="mc-creative-chat-chip">
              <span>{chip.label}</span>
              <button type="button" aria-label={t("mcProject.canvasRemoveAttachment")} onClick={chip.onRemove}>
                <IconX size={11} />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <div className="composer-shell mc-creative-chat-composer">
        <textarea
          className="mc-creative-chat-textarea"
          value={text}
          rows={3}
          placeholder={t("mcProject.creativeChatPlaceholder")}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <div className="composer-toolbar">
          <div className="composer-left" />
          <div className="composer-right">
            <ComposerModelPicker
              t={t}
              controller={modelMenu}
              modelLabel={modelId ? composerModelDisplayName(provider, modelId) : t("chat.model")}
              thinkingLabel={thinkingLevel}
              thinkingLevel={thinkingLevel}
              selectedProviderId={provider?.id}
              selectedModelId={modelId}
              controlsBlocked={running}
              onCloseOtherMenus={() => {}}
            />
            {running && sessionId ? (
              <TooltipButton
                type="button"
                className="stop-btn"
                tooltip={t("chat.stopGenerating")}
                ariaLabel={t("chat.stopGenerating")}
                onClick={() => void abortSession(sessionId)}
              >
                <IconStop size={14} />
              </TooltipButton>
            ) : (
              <TooltipButton
                type="button"
                className="send-btn"
                tooltip={modelReady ? t("chat.send") : t("mcProject.creativeChatPickModel")}
                ariaLabel={t("chat.send")}
                disabled={!text.trim() || busy || !modelReady}
                onClick={() => void send()}
              >
                <IconArrowUp size={15} />
              </TooltipButton>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** A user message without the fenced canvas data it carried. */
function UserText({ content }: { content: string }) {
  const { t } = useTranslation();
  const { text, blocks } = stripCanvasData(content);
  return (
    <div className="message-user-text selectable">
      {text}
      {blocks ? <span className="mc-creative-chat-carried">{t("mcProject.canvasCarried")}</span> : null}
    </div>
  );
}
