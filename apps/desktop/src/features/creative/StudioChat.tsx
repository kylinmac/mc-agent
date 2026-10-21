import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionThinkingLevel, UiMessage } from "@pi-desktop/shared";
import { imageGenerationBindings, isImageGenerationModel } from "@pi-desktop/shared";
import { TooltipButton } from "../../components/ui";
import { IconArrowUp, IconExternal, IconPlus, IconStop } from "../../components/icons";
import { Markdown } from "../../components/Markdown";
import { PermissionCard } from "../../components/PermissionCard";
import { api } from "../../lib/api";
import { pinSessionPane } from "../../lib/mc-split-view";
import { untitledTaskTitle } from "../../lib/session-title-utils";
import { useTranscriptView } from "../../hooks/use-transcript-view";
import { useAppStore } from "../../stores/app-store";
import { ToolRow } from "../chat/transcript/ToolRow";
import { AssistantErrorMessage, ThinkingRow } from "../chat/transcript/shared";
import { TranscriptDisclosureProvider } from "../chat/transcript/disclosure";
import { useColumnTranscript } from "../split-view/split-actions";
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

export function StudioChat({
  groupId,
  projectPath,
  context = "",
  contextCount = 0,
}: {
  groupId: string;
  projectPath: string | null;
  /** Sent ahead of each message, e.g. the images being compared. */
  context?: string;
  contextCount?: number;
}) {
  const { t } = useTranslation();
  const settings = useAppStore((state) => state.settings);
  const sessions = useAppStore((state) => state.sessions);
  const sendPrompt = useAppStore((state) => state.sendPrompt);
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
  useEffect(() => (sessionId ? pinSessionPane(sessionId) : undefined), [sessionId]);
  useColumnTranscript(sessionId ?? "", false);
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

  const send = async () => {
    const content = text.trim();
    if (!content || busy || !modelReady) return;
    setBusy(true);
    setError(null);
    try {
      const id = await ensureSession();
      const accepted = await sendPrompt(context ? `${context}\n\n${content}` : content, undefined, id);
      if (accepted) setText("");
      else setError(t("mcProject.creativeChatNotSent"));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

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
                      <div className="message-user-text selectable">{message.content}</div>
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
        <p className="mc-creative-chat-context">{t("mcProject.creativeChatWithCompare", { count: contextCount })}</p>
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
