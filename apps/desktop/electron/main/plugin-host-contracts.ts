import { type PluginFetchTransport } from "./plugin-net-fetch";
import {
  type ClipboardHistoryEntry,
  type PluginActiveSession,
  type PluginCompleteInput,
  type PluginCompleteResult,
  type PluginFsMode,
  type PluginLlmContext,
  type PluginModelInfo,
  type PluginNativeNotificationInput,
  type PluginNativeNotificationResult,
  type PluginNotificationPermission,
  type PluginProviderOAuthEvent,
  type PluginProviderOAuthPrompt,
} from "@pi-desktop/plugin-sdk";
import { type PluginServiceStatus, type PluginWorkspaceInfo } from "@pi-desktop/shared";
import { type McpServerClientOptions } from "./plugin-mcp";
import type { PluginAppearance } from "../shared/plugin-panel-chrome";
import type { McpControlController } from "./mcp-control";
import { type PluginWebSocketRegistry } from "./plugin-websocket";
import { type PluginShortcutRegistry } from "./plugin-shortcut-registry";
import { type LegacyPromptEnhancementSettings } from "./plugin-prompt-enhancement-migration";
import type { ComposerSuggestionOffer, ComposerSuggestionOutcome } from "./services/composer-suggestion";


export type RegisteredCommand = {
  id: string;
  title: string;
  category?: string;
  keywords?: string[];
  pluginId: string;
  run: () => Promise<void>;
};

export type RegisteredPluginTool = {
  fullName: string;
  pluginId: string;
  name: string;
  description: string;
  risk?: string;
  schema?: unknown;
  /**
   * Action names that may run in Plan or Goal mode. Omitted or empty
   * means the tool is hidden from the model in those modes (ADR 0211).
   */
  planSafeActions?: readonly string[];
  execute: (
    args: unknown,
    ctx?: {
      sessionId?: string;
      /**
       * Runtime turn identity for this tool call. Matches the `turnId` the host
       * reports through `session:turnEnded`, so a plugin can scope resources
       * (overlays, caches, helper sessions) to one host turn.
       */
      turnId?: string;
      signal?: AbortSignal;
      mode?: "agent" | "plan" | "goal";
      modelKey?: string;
      thinkingLevel?: string;
    },
  ) => Promise<unknown>;
};

/**
 * A skill document a plugin taught the agent (spec 07 §3). Only the metadata
 * travels into the system prompt; the body is loaded on demand by the model.
 */
/**
 * One ExtensionAPI module a plugin contributes (spec 07-plugins/16). The
 * module runs inside the agent sidecar; this record only says where it is
 * and which plugin owns it.
 */
export type RegisteredAgentExtension = {
  /** Realpath of the module; stable identity for the sidecar and diagnostics. */
  id: string;
  pluginId: string;
  pluginName: string;
  /** Absolute module path inside the plugin directory. */
  entry: string;
  root: string;
};

export type RegisteredPluginSkill = {
  /** `<pluginId>/<skillId>` — what the model passes to the Skill tool. */
  id: string;
  pluginId: string;
  skillId: string;
  name: string;
  description: string;
  /** Absolute path to the skill document inside the plugin directory. */
  path: string;
  bytes: number;
};

/**
 * A theme a plugin contributed (spec 07 §3). The CSS is read and sanitized once
 * at load time; the renderer injects the stored text verbatim.
 */
export type RegisteredPluginTheme = {
  /** `plugin:<pluginId>:<themeId>` — the value stored in `AppSettings.theme`. */
  id: string;
  pluginId: string;
  themeId: string;
  label: string;
  /** Palette the overrides layer on; drives `data-theme` in the renderer. */
  base: "light" | "dark";
  css: string;
  /** Host-generated declarations from manifest-validated variable values. */
  variablesCss?: string;
  /**
   * Native window background while this theme is selected, per resolved
   * palette. Absent unless the plugin declared it and holds
   * `ui.window.appearance` (ADR 0248).
   */
  windowBackground?: { light?: string; dark?: string };
  windowCornerRadius?: number;
};

export type PluginPanelRequest = {
  pluginId: string;
  title: string;
  width: number;
  height: number;
  htmlPath: string;
  locale?: string;
  theme?: "light" | "dark";
  /**
   * `"panel"` (default) keeps the 46px host drag band and its capsule.
   * `"widget"` is the transparent floating placement: no band, no capsule, a
   * whole-window drag map, and a host context menu instead of the capsule.
   */
  shape?: "panel" | "widget";
  /** Floating widget placement only: keep the surface above other windows. */
  alwaysOnTop?: boolean;
  /** Overrides the per-shape default: panels are resizable, widgets are not. */
  resizable?: boolean;
  /** The plugin's egress allowlist; the panel session is confined to it. */
  netDomains?: readonly string[];
  /** The install-time `net.anyHost` grant lifts the panel's allowlist too. */
  netAnyHost?: boolean;
  /** Allows the isolated panel to request microphone audio, never camera access. */
  allowMicrophone?: boolean;
  /** Development panels show the host drag-band reminder in their chrome. */
  development?: boolean;
};

export type PluginPanelBridgeContext = {
  /** Absolute path recorded by the panel preload for a real drop gesture. */
  droppedPath?: string;
};

/** Transport to one plugin host process (ADR 0008). */
export type PluginProcessHandle = {
  postMessage: (message: unknown) => void;
  onMessage: (handler: (message: any) => void) => void;
  onExit: (handler: (code: number) => void) => void;
  onLog?: (handler: (level: string, message: string) => void) => void;
  kill: () => void;
};

export type PluginProcessSpawner = (options: {
  pluginId: string;
  entry: string;
  pluginPath: string;
}) => PluginProcessHandle | Promise<PluginProcessHandle>;

/** One file access the plugin asked for and the manifest does not cover. */
export type PluginFsConsentRequest = {
  pluginId: string;
  pluginName: string;
  mode: PluginFsMode;
  /** Root-relative path, as the user would recognize it. */
  path: string;
  /** Absolute path, for the dialog's detail line. */
  fullPath: string;
  /** Set when the plugin tripped the delete rate brake rather than the scope. */
  reason?: "scope" | "rate";
};

/**
 * `session` grants the containing directory for the rest of the run.
 * A delete is never offered anything more durable than that.
 */
export type PluginFsConsentAnswer = "once" | "session" | "deny";

/** One dangerous desktop operation a plugin asked the host to run. */
export type PluginDesktopConsentRequest = {
  pluginId: string;
  pluginName: string;
  /** Operation id from the shared controller catalog, e.g. `session/delete`. */
  operation: string;
  /** Catalog description of the operation, for the dialog. */
  description: string;
  /** Positional arguments as the plugin supplied them (secret-stripped later). */
  args: unknown[];
};

export type PluginHostServices = {
  getWorkspacePath: () => string | null;
  /**
   * The workspace plus the project group behind it, when the caller can supply
   * it. Additive: `workspace.get` falls back to `getWorkspacePath` alone.
   */
  getWorkspaceInfo?: (workspacePath?: string | null) => PluginWorkspaceInfo | null;
  /**
   * The project the tool session behind this call belongs to, when the host
   * tracks one. Additive: an fs call falls back to `getWorkspacePath` -- the
   * visible workspace -- for a panel call or an unknown session.
   */
  getWorkspacePathForSession?: (sessionId: string) => string | null;
  /** The set of `contributes.agentExtensions` modules changed (load/unload). */
  agentExtensionsChanged?: () => void;
  getLocale?: () => string;
  getAppVersion?: () => string;
  /**
   * mc-agent: the folder of plugins this build ships. Only a plugin loaded
   * from it may lower the risk of its own MCP tools (MC-ADR-0014).
   */
  builtinPluginsDir?: string | null;
  /** Legacy host-owned prompt enhancement settings, used only for one-time migration. */
  getLegacyPromptEnhancementSettings?: () =>
    | LegacyPromptEnhancementSettings
    | null
    | undefined
    | Promise<LegacyPromptEnhancementSettings | null | undefined>;
  /**
   * The appearance the host is currently showing (palette, language, active
   * plugin theme). Panels and plugin processes read it through `app.getAppearance`;
   * the host broadcasts `appearance:changed` to open panels, docked views, and
   * loaded plugin processes when it changes (ADR 0280). Workspace switches push
   * `workspace:changed` the same way.
   */
  getAppearance?: () => PluginAppearance;
  /**
   * Persist and apply `AppSettings.theme`. Used by `pi.app.setTheme` so a
   * plugin panel can switch the shell theme without opening Settings.
   */
  setThemePreference?: (theme: string) => Promise<void>;
  /**
   * Broadcast that this plugin's contributed themes changed (runtime upsert /
   * remove). Host should notify the renderer and refresh panel appearance.
   */
  onPluginThemesChanged?: (pluginId: string) => void;
  showToast: (message: string, level?: "info" | "warn" | "error") => void;
  notify: (input: { title: string; body?: string }) => void;
  getNotificationPermission: () => PluginNotificationPermission | Promise<PluginNotificationPermission>;
  requestNotificationPermission: () => Promise<PluginNotificationPermission>;
  showNativeNotification: (
    input: PluginNativeNotificationInput,
  ) => Promise<PluginNativeNotificationResult>;
  openExternal: (url: string) => Promise<void>;
  /** Host-rendered prompts for an active provider OAuth login. */
  providerOAuthPrompt?: (
    pluginId: string,
    loginId: string,
    input: PluginProviderOAuthPrompt,
  ) => Promise<string>;
  /** Host-rendered, non-secret progress for an active provider OAuth login. */
  providerOAuthNotify?: (
    pluginId: string,
    loginId: string,
    event: PluginProviderOAuthEvent,
  ) => Promise<void>;
  /** Open one already-authorized file with the OS-associated application. */
  openPath: (fullPath: string) => Promise<void>;
  /** Open one already-authorized HTML file in the bundled work-panel Browser. */
  openInBrowser?: (fullPath: string) => Promise<void>;
  /** Reveal one already-authorized file in the OS file manager. */
  revealPath?: (fullPath: string) => Promise<void>;
  readClipboard: () => Promise<string>;
  writeClipboard: (text: string) => Promise<void>;
  readClipboardHistory: () => Promise<ClipboardHistoryEntry[]>;
  openPanel: (request: PluginPanelRequest) => Promise<void>;
  closePanel: (pluginId: string) => Promise<void>;
  /** Single-hop transport; the runtime owns redirect and timeout policy. */
  fetch?: PluginFetchTransport;
  /** The reviewed desktop operation controller shared with MCP. */
  desktopControl?: McpControlController;
  /**
   * Blocking, native consent for a plugin-originated dangerous desktop
   * operation (session delete, permission-mode change, tool approval). The
   * controller's `confirm` flag is only the caller's acknowledgement; the
   * user decides here. Without this service every dangerous operation from a
   * plugin is refused, which is the safe default for a headless host.
   */
  confirmDesktopControl?: (request: PluginDesktopConsentRequest) => Promise<boolean>;
  audit?: (entry: Record<string, unknown>) => void;
  /**
   * Blocking, native consent for a file access the manifest did not declare.
   * Without it every out-of-scope access is refused, which is the safe default
   * for a headless host.
   */
  confirmFsAccess?: (request: PluginFsConsentRequest) => Promise<PluginFsConsentAnswer>;
  /**
   * Move a path to the OS trash. Deletion is the one file operation that is
   * recoverable if we route it here, so the host supplies the trash rather than
   * the runtime calling `rm` — no quarantine copy of the user's data anywhere.
   */
  trashItem?: (fullPath: string) => Promise<void>;
  /**
   * Native directory picker backing the `userSelected` root: unlimited reach,
   * zero standing power, because the user points at the directory themselves.
   */
  pickDirectory?: (request: {
    pluginId: string;
    pluginName: string;
  }) => Promise<string | null>;
  /**
   * Absolute paths refused under every root, scope and grant — the app's own
   * data directory above all, which holds provider keys and the session store.
   */
  protectedPaths?: () => readonly string[];
  /** Overrides the forked host-process entry; tests point this at the source file. */
  hostEntry?: string;
  /** Overrides how a plugin host process is created; defaults to Electron utilityProcess. */
  spawnProcess?: PluginProcessSpawner;
  /**
   * Real-time sockets. Like the shortcut registry this is host-owned, so the
   * egress allowlist, the bounds and the release path are all decided in the
   * runtime rather than by plugin code.
   */
  pluginSockets?: PluginWebSocketRegistry;
  /** Transport overrides for plugin-declared MCP servers; tests inject stubs. */
  mcp?: Pick<
    McpServerClientOptions,
    "spawnImpl" | "fetchImpl" | "connectTimeoutMs" | "callTimeoutMs" | "discoveryTimeoutMs"
  >;
  /**
   * System-wide accelerators for plugins. The registry owns the platform's
   * `globalShortcut`; the runtime only routes plugin calls into it, so plugin
   * code can never register or fire another plugin's shortcut.
   */
  pluginShortcuts?: PluginShortcutRegistry;
  /** Fired when a plugin host process dies on its own (crash, OOM, hard exit). */
  onPluginCrash?: (info: {
    pluginId: string;
    name: string;
    /** Unsigned process exit code, matching the human-readable crash detail. */
    exitCode: number;
    /** Hex form for Windows hard-fault codes, when applicable. */
    exitCodeHex?: string;
  }) => void;
  /** Fired when a resident service changes supervision state. */
  onServiceChange?: (status: PluginServiceStatus) => void;
  /** Fired after a development plugin was reloaded from disk, or failed to. */
  onPluginReloaded?: (info: {
    pluginId: string;
    name: string;
    ok: boolean;
    message?: string;
  }) => Promise<void> | void;
  /** Work-panel guest + CDP, gated by `browser.cdp` in the runtime. */
  browser?: {
    reveal: (sessionId?: string) => Promise<void>;
    navigate: (
      input: { url?: string; path?: string },
      sessionId?: string,
      tabId?: string,
    ) => Promise<unknown>;
    action: (action: "back" | "forward" | "reload" | "stop", sessionId?: string, tabId?: string) => void;
    setBounds: (pluginId: string, hole: unknown) => unknown;
    setVisible: (pluginId: string, visible: boolean) => void;
    getState: (sessionId?: string, tabId?: string) => unknown;
    openExternal: (sessionId?: string, tabId?: string) => void;
    snapshot: (sessionId?: string, tabId?: string) => Promise<unknown>;
    screenshot: (
      input?: { fullPage?: boolean },
      sessionId?: string,
      tabId?: string,
    ) => Promise<unknown>;
    click: (uid: string, sessionId?: string, tabId?: string) => Promise<void>;
    fill: (uid: string, text: string, sessionId?: string, tabId?: string) => Promise<void>;
    evaluate: (expression: string, sessionId?: string, tabId?: string) => Promise<unknown>;
    console: (limit?: number, sessionId?: string, tabId?: string) => unknown;
    cdp: (method: string, params?: unknown, sessionId?: string, tabId?: string) => Promise<unknown>;
  };
  onPluginUnload?: (pluginId: string) => void;
  listModels?: () => Promise<PluginModelInfo[]>;
  getSessionContext?: (sessionId: string, stripToolName?: string) => Promise<PluginLlmContext>;
  complete?: (input: PluginCompleteInput & {
    sessionId?: string;
    stripToolName?: string;
    signal?: AbortSignal;
  }) => Promise<PluginCompleteResult>;
  session?: {
    list: (pluginId: string, input: Record<string, unknown>) => Promise<unknown>;
    get: (pluginId: string, input: Record<string, unknown>) => Promise<unknown>;
    listMessages: (pluginId: string, input: Record<string, unknown>) => Promise<unknown>;
    getAutoTitleContext: (pluginId: string, input: Record<string, unknown>) => Promise<unknown>;
    setAutoTitle: (pluginId: string, input: Record<string, unknown>) => Promise<unknown>;
    import: (pluginId: string, input: Record<string, unknown>) => Promise<unknown>;
    importBatch: (pluginId: string, input: Record<string, unknown>) => Promise<unknown>;
    rename: (pluginId: string, input: Record<string, unknown>) => Promise<unknown>;
    delete: (pluginId: string, input: Record<string, unknown>) => Promise<unknown>;
  };
  /**
   * The session the user is looking at, as the shell shows it. Read from the
   * host's own selection and turn maps, so a plugin never infers it.
   */
  getActiveSession?: () => PluginActiveSession | null;
  /**
   * Whether a plugin's contributions still apply to the shell's current
   * project. The same scope check every view IPC applies, so a project-scoped
   * plugin cannot read or reveal a session it is inactive in.
   */
  isPluginActiveInProject?: (pluginId: string) => boolean;
  /**
   * Ask the shell to show one of this plugin's views in a session's work panel.
   * The runtime has already resolved the view, the scope and a stale session.
   */
  revealView?: (request: {
    pluginId: string;
    viewId: string;
    sessionId: string;
    location: string | null;
  }) => Promise<void>;
  /**
   * `pi.composer.suggest`: hand one line to the shell that owns the composer.
   * The runtime already checked the permission and shaped the text; the shell
   * says whether it went on screen, because only it knows the draft.
   */
  suggestComposer?: (offer: ComposerSuggestionOffer) => Promise<ComposerSuggestionOutcome>;
  /** `pi.composer.clearSuggestion`: drop this plugin's own line. */
  clearComposerSuggestion?: (pluginId: string, sessionId?: string) => void;
  project?: {
    create: (pluginId: string, input: Record<string, unknown>) => Promise<unknown>;
  };
  /** Read-only completed-turn facts served by host-core's usage domain. */
  usage?: {
    listTurns: (pluginId: string, input: Record<string, unknown>) => Promise<unknown>;
  };
};

export type PluginOAuthProvider = {
  pluginId: string;
  runtimeId: string;
  contributionId: string;
  providerId: string;
  name: string;
  loginLabel?: string;
  isSubscription: boolean;
};
