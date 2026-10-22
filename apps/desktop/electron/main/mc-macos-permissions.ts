/**
 * mc-agent: the macOS system permissions the app's features need, checked
 * where they are used (docs/mc-agent/macos-permissions.md, X-PERM-02).
 *
 * - Accessibility and Screen Recording are checked by the Computer Use helper
 *   itself (`mc-computer`), through the plugin's running MCP server: macOS
 *   attributes them to the app that launched it, and the app's own process
 *   cannot stand in for the helper. A helper that is not running is reported
 *   as such; it is never started just to check.
 * - The microphone is checked by Electron, as voice calls use it.
 *
 * States stay as the system reports them: the helper only knows granted or
 * not (never "denied" vs "never asked"); the microphone keeps its five states.
 * The renderer chooses only an item from a fixed list; every settings page and
 * command is fixed here.
 */

import type {
  MacAppIdentity,
  MacPermissionEntry,
  MacPermissionItem,
  MacPermissionReport,
  MacPermissionState,
} from "@pi-desktop/shared";

export type { MacPermissionItem, MacPermissionReport };

export const MAC_PERMISSION_ITEMS: readonly MacPermissionItem[] = ["accessibility", "screenRecording", "microphone"];

export const SETTINGS_URLS: Record<MacPermissionItem, string> = {
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  screenRecording: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
};

export const SETTINGS_PATHS: Record<MacPermissionItem, string> = {
  accessibility: "System Settings → Privacy & Security → Accessibility",
  screenRecording: "System Settings → Privacy & Security → Screen & System Audio Recording",
  microphone: "System Settings → Privacy & Security → Microphone",
};

/** What the helper's `permissions` tool returns (crates/mc-computer). */
type HelperAnswer = {
  accessibility: boolean;
  screenRecording: boolean;
  items?: Array<{ item: "accessibility" | "screenRecording"; granted: boolean; settingsOpened?: boolean }>;
  checkedBy?: { pid: number; executable: string };
};

type HelperTool = { execute: (args: unknown) => Promise<unknown> };

export type MacPermissionsDeps = {
  platform: NodeJS.Platform;
  /** The Computer Use helper's `permissions` tool, when its server is up. */
  helperTool: () => HelperTool | null;
  microphoneStatus: () => string;
  askMicrophone: () => Promise<boolean>;
  openUrl: (url: string) => Promise<void>;
  identity: () => Omit<MacAppIdentity, "helperPid" | "helperPath">;
  now?: () => number;
  /** How long the helper may take to answer. */
  timeoutMs?: number;
};

function microphoneState(status: string): MacPermissionState {
  switch (status) {
    case "granted":
      return "granted";
    case "denied":
      return "denied";
    case "restricted":
      return "restricted";
    case "not-determined":
      return "notDetermined";
    default:
      return "unknown";
  }
}

/** The JSON the helper put in its first text block. */
export function parseHelperAnswer(result: unknown): HelperAnswer {
  const content = (result as { content?: Array<{ type?: string; text?: string }>; isError?: boolean } | null)?.content;
  const text = content?.find((block) => block?.type === "text")?.text;
  if ((result as { isError?: boolean } | null)?.isError) throw new Error(text || "the helper refused the request");
  if (typeof text !== "string") throw new Error("the helper gave no answer");
  const parsed = JSON.parse(text) as HelperAnswer;
  if (typeof parsed?.accessibility !== "boolean" || typeof parsed.screenRecording !== "boolean") {
    throw new Error("the helper's answer has an unexpected shape");
  }
  return parsed;
}

export class MacPermissions {
  private readonly deps: MacPermissionsDeps;

  constructor(deps: MacPermissionsDeps) {
    this.deps = deps;
  }

  private async askHelper(args: Record<string, unknown>): Promise<HelperAnswer | "off" | Error> {
    const tool = this.deps.helperTool();
    if (!tool) return "off";
    const timeout = this.deps.timeoutMs ?? 8_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const answer = await Promise.race([
        tool.execute(args),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("the helper did not answer in time")), timeout);
        }),
      ]);
      return parseHelperAnswer(answer);
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private report(helper: HelperAnswer | "off" | Error): MacPermissionReport {
    const now = (this.deps.now ?? Date.now)();
    const identity = this.deps.identity();
    const helperEntry = (item: "accessibility" | "screenRecording"): MacPermissionEntry => {
      const base = { item, checkedBy: "computer-use-helper" as const, checkedAt: now, settingsPath: SETTINGS_PATHS[item] };
      if (helper === "off") return { ...base, state: "helperOff" };
      if (helper instanceof Error) return { ...base, state: "helperError", detail: helper.message.slice(0, 300) };
      return { ...base, state: helper[item] ? "granted" : "notGranted" };
    };
    return {
      supported: this.deps.platform === "darwin",
      app: {
        ...identity,
        helperPid: helper !== "off" && !(helper instanceof Error) ? helper.checkedBy?.pid ?? null : null,
        helperPath: helper !== "off" && !(helper instanceof Error) ? helper.checkedBy?.executable ?? null : null,
      },
      items: [
        helperEntry("accessibility"),
        helperEntry("screenRecording"),
        {
          item: "microphone",
          state: microphoneState(this.deps.microphoneStatus()),
          checkedBy: "app",
          checkedAt: now,
          settingsPath: SETTINGS_PATHS.microphone,
        },
      ],
    };
  }

  private unsupported(): MacPermissionReport {
    const now = (this.deps.now ?? Date.now)();
    return {
      supported: false,
      app: { ...this.deps.identity(), helperPid: null, helperPath: null },
      items: MAC_PERMISSION_ITEMS.map((item) => ({
        item,
        state: "unsupported",
        checkedBy: item === "microphone" ? "app" : "computer-use-helper",
        checkedAt: now,
        settingsPath: SETTINGS_PATHS[item],
      })),
    };
  }

  /** Check every item; never prompts. */
  async check(): Promise<MacPermissionReport> {
    if (this.deps.platform !== "darwin") return this.unsupported();
    return this.report(await this.askHelper({}));
  }

  /**
   * The user asked to grant `item`: show the system prompt if it is missing,
   * and open its settings page where a prompt alone cannot grant it.
   */
  async request(item: MacPermissionItem): Promise<MacPermissionReport> {
    if (this.deps.platform !== "darwin") return this.unsupported();
    if (item === "microphone") {
      const status = this.deps.microphoneStatus();
      if (status === "not-determined") await this.deps.askMicrophone();
      else if (status !== "granted") await this.deps.openUrl(SETTINGS_URLS.microphone);
      return this.check();
    }
    // Accessibility is only ever turned on in System Settings; the prompt
    // points there. Screen Recording shows its own prompt the first time.
    const args =
      item === "accessibility"
        ? { request_item: item, open_settings: item }
        : { request_item: item };
    return this.report(await this.askHelper(args));
  }

  /** Open one item's settings page (a fixed URL). */
  async openSettings(item: MacPermissionItem): Promise<void> {
    await this.deps.openUrl(SETTINGS_URLS[item]);
  }
}

/** A permission item from the renderer, or an error. */
export function macPermissionItemOf(value: unknown): MacPermissionItem {
  if (typeof value === "string" && (MAC_PERMISSION_ITEMS as readonly string[]).includes(value)) {
    return value as MacPermissionItem;
  }
  throw Object.assign(new Error("unknown permission"), { errorCode: "INVALID_ARGUMENT" });
}
