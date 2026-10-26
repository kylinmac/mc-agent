import { join } from "node:path";
import { app, clipboard, dialog, nativeImage, shell, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from "electron";
import { err, ErrorCodes, IPC, ok, type LifecycleDialogChoice, type Result } from "@pi-desktop/shared";
import type { AgentHostBridge } from "../agent-host-bridge";
import type { AgentSidecar } from "../agent-sidecar";
import type { HostProcess } from "../host-process";
import { ROUTE_LOCAL, type BackendRouter } from "../remote/backend-router";
import { registerAgentExtensionIpc } from "../agent-extensions-ipc";
import { readNpmPath, writeNpmPath } from "../npm-preferences";
import { registerAgentIpc } from "./agent-ipc";
import { registerAppIpc } from "./app-ipc";
import { registerDiagnosticsIpc } from "./diagnostics-ipc";
import { registerMarketIpc } from "./market-ipc";
import { registerMcpIpc } from "./mcp-ipc";
import type { McpOAuthManager } from "../mcp-oauth";
import { searchMcpMarket } from "../mcp-registry-catalog";
import { registerNotificationIpc } from "./notification-ipc";
import { registerPluginIpc } from "./plugin-ipc";
import { registerPluginUiIpc } from "./plugin-ui-ipc";
import { registerJevIpc } from "./jev-ipc";
import { refreshProjectGroups } from "../workspace-roots";
import { registerProjectResourcesIpc } from "./project-resources-ipc";
import { registerSessionInsightIpc } from "./mc-session-insight-ipc";
import { registerMcQuotaIpc } from "./mc-quota-ipc";
import { registerMcUsageIpc } from "./mc-usage-ipc";
import { registerMcPermissionsIpc } from "./mc-permissions-ipc";
import { registerMcPromptsIpc } from "./mc-prompts-ipc";
import { registerMcTerminalIpc } from "./mc-terminal-ipc";
import { loadUserHooks, saveUserHooks } from "../mc-user-hooks-store";
import { registerMcReleaseNotesIpc } from "./mc-release-notes-ipc";
import { registerMcBackgroundIpc, registerMcBackgroundWake } from "./mc-background-ipc";
import { registerMcCreativeIpc } from "./mc-creative-ipc";
import { registerMcProjectCreateIpc } from "./mc-project-create-ipc";
import { imageDataUrl, measureImage } from "../creative/measure-image";
import { TerminalManager } from "../mc-terminal";
import { registerProviderIpc } from "./provider-ipc";
import { registerScheduledIpc } from "./scheduled-ipc";
import { registerSessionIpc } from "./session-ipc";
import { registerSettingsIpc } from "./settings-ipc";
import { registerStorageIpc } from "../storage/ipc";
import { registerConfigSyncIpc } from "./config-sync-ipc";
import { registerBackgroundTasksIpc } from "./background-tasks-ipc";
import { registerSkillsIpc } from "./skills-ipc";
import { registerAgentImportIpc } from "./agent-import-ipc";
import { registerRemoteHostIpc } from "./remote-host-ipc";
import { fetchSkillMarketDocument, searchSkillMarket } from "../skill-market-catalog";
import { registerWindowIpc } from "./window-ipc";
import { registerWorktreeIpc } from "./worktree-ipc";
import { createComposerTemplateLoader, registerWorkspaceIpc } from "./workspace-ipc";
import { registerComposerIpc } from "./composer-ipc";
import { registerSpeechIpc } from "./speech-ipc";
import { registerVoiceIpc } from "./voice-ipc";
import { registerDictationIpc } from "./dictation-ipc";
import { registerLiveVoiceIpc } from "./live-voice-ipc";
import type { LiveCallService } from "../live-voice/call-service";
import type { ComposerSuggestionAnswer } from "../services/composer-suggestion";
import type { LiveVoiceWidget } from "../live-voice/widget-window";
import type { IpcRegistrar } from "./types";
import type { createTraySessions } from "../tray-sessions";
import type { createTaskbarUnreadBadge } from "../taskbar-unread-badge";

export type RegisterIpcDependencies = {
  isQuitting: () => boolean;
  ipcMain: IpcMain;
  getMainWindow: () => BrowserWindow | null;
  getHost: () => HostProcess | null;
  traySessions: ReturnType<typeof createTraySessions>;
  taskbarUnreadBadge: ReturnType<typeof createTaskbarUnreadBadge>;
  getSidecar: () => AgentSidecar | null;
  getAgentHostBridge: () => AgentHostBridge | null;
  /**
   * Resolves the remote backend router once it exists. Renderer IPC calls whose
   * session is owned by a paired remote host are forwarded through it; every
   * other call — including all internal invokes — runs the local handler
   * unchanged. Null until the router is wired (and in tests).
   */
  getBackendRouter?: () => BackendRouter | null;
  getNotificationViewingSessionId: () => string | null;
  setNotificationViewingSessionId: (sessionId: string | null) => void;
  /** The session on screen, as the shell reported it (plugin `session:activated`). */
  setActivePluginSession: (
    next: { sessionId: string; projectPath: string | null } | null,
  ) => void;
  /** The shell's answer to a composer suggestion it was offered (ADR 0333). */
  settleComposerSuggestion: (answer: ComposerSuggestionAnswer) => boolean;
  activeUserSubagentDocuments: (...args: any[]) => Promise<any>;
  disabledBuiltinSubagents: () => Promise<string[]>;
  disabledBuiltinSkills: () => Promise<string[]>;
  /** Host activation plus the inline-visualization switch, for runtime consumers. */
  runtimeDisabledBuiltinSkills: () => Promise<string[]>;
  completionNoticeTurns: Set<string>;
  liveCallService?: LiveCallService;
  liveVoiceWidget?: LiveVoiceWidget;
  microphoneLeases?: import("../live-voice/microphone-lease").MicrophoneLeaseRegistry;
  restartForStorage: () => void;
  mcpOAuth?: McpOAuthManager;
  markLifecycleDialogRendererReady: (window: BrowserWindow) => boolean;
  respondLifecycleDialog: (senderWindowId: number, requestId: unknown, choice: LifecycleDialogChoice) => boolean;
  [name: string]: any;
};

function wrap<T>(fn: () => Promise<T>): Promise<Result<T>> {
  return fn()
    .then((data) => ok(data))
    .catch((e: any) =>
      err(
        e?.data?.errorCode || e?.errorCode || ErrorCodes.INTERNAL,
        e instanceof Error ? e.message : String(e),
        { retriable: e?.data?.retriable === true, details: e?.data },
      ),
    );
}

export function registerIpcHandlers(dependencies: RegisterIpcDependencies) {
  const {
    ipcMain,
    getMainWindow,
    getHost,
    getSidecar,
    getAgentHostBridge,
    getBackendRouter,
    getNotificationViewingSessionId,
    setNotificationViewingSessionId,
    setActivePluginSession,
    settleComposerSuggestion,
    getPluginLauncherWindow,
    togglePluginLauncher,
    safeOpenExternal,
    updater,
    dataDir,
    activeTurns,
    completionNoticeTurns,
    isTurnDispatchable,
    sessionProjects,
    persistenceOutbox,
    logger,
    plugins,
    speech,
    sessionCapabilityContext,
    enrichSession,
    acquireSessionOperation,
    beginTranscriptRewrite,
    forgetTranscriptRewriteHistory,
    recordTurnStart,
    stripWinLongPrefix,
    normalizeSettings,
    validateSettingsWrite,
    testNetworkProxy,
    applyNetworkProxyFromAppSettings,
    currentNetworkProxy,
    applyApplicationMenuSettings,
    applyDeveloperMode,
    applyPreventScreenSleep,
    applyKeepAwakeWhileRunning,
    resolveEffectiveCommandShell,
    modelsDevCatalog,
    vendorOAuth,
    enrichProvider,
    listRuntimeProviders,
    enrichProviderList,
    bindingForModel,
    agentExtensions,
    activeUserSkills,
    activeUserSubagentDocuments,
    disabledBuiltinSubagents,
    disabledBuiltinSkills,
    runtimeDisabledBuiltinSkills,
    pluginActiveInProject,
    getWorkPanelReservationWidth,
    setWorkPanelReservationWidth,
    setWorkPanelReservation,
    getWorkPanelChatWidthSetter,
    applyCloseBehavior,
    getCloseBehavior,
    isMacosWindowTranslucent,
    markMenuRendererReady,
    markLifecycleDialogRendererReady,
    respondLifecycleDialog,
    traySessions,
    taskbarUnreadBadge,
    executeNativeMenuAction,
    scheduledRunsBySession,
    isDevelopmentBuild,
    browserHost,
    clipboardHistory,
    recordPastedClipboardFiles,
    currentWorkspacePath,
    setCurrentWorkspacePath,
    withGitBranch,
    activeTurnUsages,
    approvedExecutionIdsBySession,
    claimedExecutionSessions,
    resolveAgentRuntimeLaunch,
    finishTurn,
    lockAbortReason,
    finishApprovedExecution,
    dispatchApprovedPlan,
    dispatchExecutionForProposal,
    emitAgentEvent,
    userMcp,
    mcpOAuth,
    refreshUserMcp,
    describeError,
    pluginViews,
    pluginScopes,
    rememberPluginScopes,
    pluginPanels,
    getUpdaterLocale,
    getPluginPanelTheme,
    isDeveloperMode,
    sendToRenderer,
    voiceService,
    liveCallService,
    liveVoiceWidget,
  } = dependencies;


  const ipcHandlers = new Map<string, (...args: any[]) => Promise<any>>();
  const handle = (channel: string, fn: (...args: any[]) => Promise<any>) => {
    const handler = async (...args: any[]) => {
      const result = await fn(...args);
      traySessions.observeInvoke(channel);
      taskbarUnreadBadge.observeInvoke(channel);
      return result;
    };
    ipcHandlers.set(channel, handler);
    // The interception seam for remote-host routing: a renderer call whose
    // session is owned by a paired remote host is served over RACP-WS; every
    // other call (and every internal invoke, which never reaches this wrapper)
    // runs the existing local handler byte-for-byte unchanged.
    ipcMain.handle(channel, async (_event, ...args) =>
      wrap(async () => {
        const router = getBackendRouter?.();
        if (router) {
          const outcome = await router.route(channel, args);
          if (outcome !== ROUTE_LOCAL) return outcome.value;
        }
        return handler(...args);
      }),
    );
  };
  const handleWithEvent = (
    channel: string,
    fn: (event: IpcMainInvokeEvent, ...args: any[]) => Promise<any>,
  ) => {
    ipcMain.handle(channel, async (event, ...args) =>
      wrap(() => fn(event, ...args)),
    );
  };
  const assertMainWindowSender = (event: IpcMainInvokeEvent): void => {
    if (event.sender.id !== getMainWindow()?.webContents.id) {
      throw Object.assign(new Error("renderer is not the main window"), {
        errorCode: "PERMISSION_DENIED",
      });
    }
  };

  const optionalWorkspaceRoot = async (): Promise<string | null> => {
    const currentHost = getHost();
    if (!currentHost) return null;
    try {
      const result = (await currentHost.call("workspace.get")) as {
        workspace: { path?: string } | null;
      };
      return result.workspace?.path ?? null;
    } catch {
      return null;
    }
  };

  const registrar: IpcRegistrar = {
    ipcMain,
    handle,
    handleWithEvent,
    assertMainWindowSender,
  };

  registerAppIpc({
    registrar,
    getHost,
    getPluginLauncherWindow,
    togglePluginLauncher,
    safeOpenExternal,
    updater,
  });
  registerStorageIpc({ registrar, getMainWindow, restart: dependencies.restartForStorage });
  registerNotificationIpc({
    registrar,
    getHost,
    getMainWindow,
    getViewingSessionId: getNotificationViewingSessionId,
    setViewingSessionId: setNotificationViewingSessionId,
    sendToRenderer,
  });
  registerSessionIpc({
    registrar,
    getHost,
    getSidecar,
    dataDir,
    activeTurns,
    sessionProjects,
    persistenceOutbox,
    logger,
    plugins,
    sessionCapabilityContext,
    enrichSession,
    acquireSessionOperation,
    beginTranscriptRewrite,
    forgetTranscriptRewriteHistory,
    stripWinLongPrefix,
  });
  registerSettingsIpc({
    registrar,
    getHost,
    getSidecar,
    dataDir,
    normalizeSettings,
    validateSettingsWrite,
    testNetworkProxy,
    applyNetworkProxyFromAppSettings,
    currentNetworkProxy,
    applyApplicationMenuSettings,
    applyDeveloperMode,
    applyPreventScreenSleep,
    applyKeepAwakeWhileRunning,
    applyUpdatePreference: (preference) => updater.setPreference(preference),
    resolveEffectiveCommandShell,
    liveCallService,
  });
  registerConfigSyncIpc({
    registrar,
    getHost,
    sendToRenderer,
  });
  registerBackgroundTasksIpc({
    registrar,
    getHost,
  });
  registerProviderIpc({
    registrar,
    getHost,
    modelsDevCatalog,
    vendorOAuth,
    logger,
    enrichProvider,
    listRuntimeProviders,
    enrichProviderList,
    bindingForModel,
    onProviderInvalidated: (providerId) => liveCallService?.invalidateProvider(providerId),
  });
  registerJevIpc({ registrar, logger });
  // mc-agent: remaining subscription quota beside the composer.
  registerMcQuotaIpc({ registrar, getHost, vendorOAuth });
  registerSessionInsightIpc({
    registrar,
    getSidecar,
    // mc-agent session info: the context breakdown of a session nothing was
    // sent to since the app started. Only idle local sessions; the launch is
    // the same one a manual compaction uses.
    prepareRuntime: async (sessionId) => {
      const host = getHost();
      const sidecar = getSidecar();
      if (!host || !sidecar || activeTurns.has(sessionId)) return null;
      if (sessionId.startsWith("remote:") || sessionId.startsWith("native-pi:")) return null;
      const settings = await host.call<any>("settings.get");
      const detail = await host.call<{ session?: any }>("session.get", { id: sessionId });
      if (!detail.session || detail.session.remote) return null;
      const launch = await resolveAgentRuntimeLaunch(sessionId, detail.session, settings);
      sidecar.setProjectInstructionRoot(sessionId, launch.workspaceRoot ?? launch.projectPath);
      return sidecar.call("agent.prepare", launch.sidecarParams) as Promise<{ breakdown: unknown }>;
    },
    suggestionsEnabled: async () => {
      const host = getHost();
      if (!host) return false;
      const settings = await host.call<{ promptSuggestions?: unknown }>("settings.get");
      return settings?.promptSuggestions === true;
    },
  });
  registerMcUsageIpc({ registrar, getHost });
  registerMcPermissionsIpc({ registrar, plugins });
  registerMcPromptsIpc({ registrar, getHost });
  registerProjectResourcesIpc({
    registrar,
    getHost,
    refreshProjectGroups,
    openPath: (path) => shell.openPath(path),
    openExternal: (url) => shell.openExternal(url),
    pickFile: async (defaultPath) => {
      const window = getMainWindow();
      const options = { properties: ["openFile" as const], ...(defaultPath ? { defaultPath } : {}) };
      const result = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
  });
  registerMcTerminalIpc({
    registrar,
    getHost,
    onQuit: (dispose) => app.on("will-quit", dispose),
    manager: new TerminalManager({
      onData: (termId, data) => sendToRenderer(IPC.event.terminalData, { termId, data }),
      onExit: (termId, exitCode) => sendToRenderer(IPC.event.terminalExit, { termId, exitCode }),
    }),
  });
  registerMcBackgroundIpc({ registrar, getHost });
  registerMcReleaseNotesIpc({ registrar, dataDir });
  // mc-agent project creation from the conversation (MC-ADR-0023).
  registerMcProjectCreateIpc({
    registrar,
    getHost,
    dataDir,
    refreshProjectGroups,
    sendToRenderer,
    pickFolder: async (defaultPath) => {
      const window = getMainWindow();
      const options = {
        properties: ["openDirectory" as const, "createDirectory" as const],
        ...(defaultPath ? { defaultPath } : {}),
      };
      const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
  });
  // mc-agent user hooks (MC-ADR-0021).
  registrar.handle(IPC.invoke.mcHooksGet, async () => ({ hooks: await loadUserHooks(dataDir) }));
  registrar.handle(IPC.invoke.mcHooksSet, async (hooks: unknown) => ({ hooks: await saveUserHooks(dataDir, hooks) }));
  registerMcBackgroundWake({
    getHost,
    activeTurn: (sessionId) => activeTurns.get(sessionId),
    invoke: async (channel, args) => {
      const handler = ipcHandlers.get(channel);
      if (!handler) throw new Error("agent handler unavailable");
      return handler(...args);
    },
    log: (message, error) => logger.app("tool", "warn", message, error === undefined ? undefined : { data: String(error) }),
  });
  registerMcCreativeIpc({
    registrar,
    getHost,
    sendToRenderer,
    measure: measureImage,
    imageDataUrl,
    pickImages: async () => {
      const window = getMainWindow();
      const options = {
        properties: ["openFile" as const, "multiSelections" as const],
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
      };
      const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
      return result.canceled ? [] : result.filePaths;
    },
    revealPath: (path) => shell.showItemInFolder(path),
    copyImage: (path) => {
      const image = nativeImage.createFromPath(path);
      if (image.isEmpty()) return false;
      clipboard.writeImage(image);
      return true;
    },
  });
  registerWorktreeIpc({
    registrar,
    getHost,
    logger,
    openPath: (path) => shell.openPath(path),
    stripWinLongPrefix,
  });
  const loadComposerTemplatesCached = createComposerTemplateLoader(logger);
  const composerCommandService = registerComposerIpc({
    registrar,
    userMcp,
    refreshUserMcp,
    plugins,
    agentExtensions,
    optionalWorkspaceRoot,
    activeUserSkills,
    disabledBuiltinSkills: runtimeDisabledBuiltinSkills,
    pluginActiveInProject,
    loadComposerTemplatesCached,
  });
  registerWindowIpc({
    setTraySessionPreferences: traySessions.setPreferences,
    registrar,
    getMainWindow,
    getWorkPanelReservationWidth,
    setWorkPanelReservationWidth,
    setWorkPanelReservation,
    getWorkPanelChatWidthSetter,
    applyCloseBehavior,
    getCloseBehavior,
    isMacosWindowTranslucent,
    markMenuRendererReady,
    markLifecycleDialogRendererReady,
    respondLifecycleDialog,
    executeNativeMenuAction,
  });
  registerScheduledIpc({
    registrar,
    getHost,
    scheduledRunsBySession,
    isQuitting: dependencies.isQuitting,
    invoke: async (channel, args) => {
      const handler = ipcHandlers.get(channel);
      if (!handler) throw new Error("scheduled prompt handler unavailable");
      return handler(...args);
    },
  });
  registerWorkspaceIpc({
    registrar,
    getMainWindow,
    getHost,
    getSidecar,
    dataDir,
    isDevelopmentBuild,
    plugins,
    browserHost,
    clipboardHistory,
    recordPastedClipboardFiles,
    currentWorkspacePath,
    setCurrentWorkspacePath,
    withGitBranch,
    stripWinLongPrefix,
  });

  registerAgentExtensionIpc({
    handle,
    bridge: agentExtensions,
    window: getMainWindow,
    dialogs: dialog,
    getLocale: getUpdaterLocale,
    getNpmPath: () => readNpmPath(dataDir),
    setNpmPath: (path) => writeNpmPath(dataDir, path),
    importRoot: join(dataDir, "plugins", "imported"),
    loadDevPlugin: async (path) => {
      const currentHost = getHost();
      if (!currentHost) throw new Error("host unavailable");
      const loaded = await currentHost.call<{ plugin: any }>("plugins.loadDev", { path });
      await plugins.loadFromPath(path, loaded.plugin?.permissions ?? [], { development: true });
      if (loaded.plugin?.id) plugins.watchDevPlugin(loaded.plugin.id);
      sendToRenderer(IPC.event.pluginChanged, { reason: "importExtension", pluginId: loaded.plugin?.id });
      return loaded;
    },
    runCommand: async (input) => {
      const currentSidecar = getSidecar();
      if (!currentSidecar) throw new Error("agent sidecar unavailable");
      return currentSidecar.call<{ handled: boolean }>("extensions.command.run", input);
    },
  });
  registerAgentIpc({
    registrar,
    getHost,
    getSidecar,
    getAgentHostBridge,
    cancelSessionTools: (sessionId: string, reason?: string) => {
      plugins.cancelSessionTools(sessionId, reason);
      userMcp.cancelSessionCalls(sessionId);
    },
    logger,
    agentExtensions,
    persistenceOutbox,
    dataDir,
    activeTurns,
    completionNoticeTurns,
    recordTurnStart,
    isTurnDispatchable,
    activeTurnUsages,
    approvedExecutionIdsBySession,
    claimedExecutionSessions,
    resolveAgentRuntimeLaunch,
    acquireSessionOperation,
    finishTurn,
    lockAbortReason,
    finishApprovedExecution,
    dispatchApprovedPlan,
    dispatchExecutionForProposal,
    emitAgentEvent,
    setNotificationViewingSessionId,
    optionalWorkspaceRoot,
    composerCommandService,
    loadComposerTemplatesCached,
  });

  registerPluginIpc({
    registrar,
    getHost,
    plugins,
    agentExtensions,
    browserHost,
    pluginViews,
    pluginScopes,
    rememberPluginScopes,
    sendToRenderer,
    logger,
  });


  registerMcpIpc({
    registrar,
    getHost,
    userMcp,
    oauth: mcpOAuth,
    currentWorkspacePath,
    refreshUserMcp,
    describeError,
    sendToRenderer,
    searchMcpMarket,
  });


  registerSkillsIpc({
    registrar,
    getHost,
    searchSkillMarket,
    fetchSkillMarketDocument,
    optionalWorkspaceRoot,
    activeUserSubagentDocuments,
    disabledBuiltinSubagents,
    disabledBuiltinSkills,
    stripWinLongPrefix,
    sendToRenderer,
    logger,
  });


  registerAgentImportIpc({
    registrar,
    getHost,
    sendToRenderer,
    refreshUserMcp,
    currentWorkspacePath,
  });

  registerPluginUiIpc({
    registrar,
    plugins,
    browserHost,
    pluginViews,
    pluginPanels,
    pluginActiveInProject,
    currentWorkspacePath,
    getUpdaterLocale,
    getPluginPanelTheme,
    setActivePluginSession,
    settleComposerSuggestion,
  });
  registerSpeechIpc({ registrar, speech });

  if (voiceService) {
    registerVoiceIpc({ registrar, voiceService });
  }
  if (dependencies.microphoneLeases) registerDictationIpc({ registrar, getHost, getMainWindow, vendorOAuth, microphoneLeases: dependencies.microphoneLeases });
  if (liveCallService && liveVoiceWidget) {
    registerLiveVoiceIpc({ registrar, service: liveCallService, getMainWindow, widget: liveVoiceWidget });
  }

  registerRemoteHostIpc({ registrar });

  registerMarketIpc({
    registrar,
    getHost,
    plugins,
    agentExtensions,
    optionalWorkspaceRoot,
    pluginActiveInProject,
    sendToRenderer,
  });


  registerDiagnosticsIpc({
    registrar,
    dataDir,
    stripWinLongPrefix,
    isDeveloperMode,
    getMainWindow,
  });


  return async (channel: string, args: readonly unknown[] = []) => {
    const handler = ipcHandlers.get(channel);
    if (!handler) {
      throw Object.assign(new Error(`IPC channel is not available to external agents: ${channel}`), {
        errorCode: ErrorCodes.NOT_FOUND,
      });
    }
    return handler(...args);
  };
}
