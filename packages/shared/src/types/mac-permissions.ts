/*
  mc-agent: the macOS system permissions the app's features need, as Main
  reports them to the permissions page (docs/mc-agent/macos-permissions.md,
  X-PERM-02; apps/desktop/electron/main/mc-macos-permissions.ts).
*/

export type MacPermissionItem = "accessibility" | "screenRecording" | "microphone";

export type MacPermissionState =
  /** Allowed. */
  | "granted"
  /** Helper items: not allowed (the system does not say whether it was asked). */
  | "notGranted"
  /** Microphone: refused by the user. */
  | "denied"
  /** Microphone: blocked by a profile or parental controls. */
  | "restricted"
  /** Microphone: never asked. */
  | "notDetermined"
  /** The Computer Use plugin is off or its helper is not running. */
  | "helperOff"
  /** The helper did not answer (timeout, crash, unexpected reply). */
  | "helperError"
  | "unknown"
  | "unsupported";

export type MacPermissionEntry = {
  item: MacPermissionItem;
  state: MacPermissionState;
  /** Which process was asked. */
  checkedBy: "computer-use-helper" | "app";
  checkedAt: number;
  /** Where to turn it on by hand. */
  settingsPath: string;
  /** A short reason for helperError / unknown. */
  detail?: string;
};

export type MacAppIdentity = {
  name: string;
  version: string;
  /** The .app bundle the user should look for in System Settings. */
  bundlePath: string | null;
  bundleId: string | null;
  /** "adhoc" builds lose permissions on every update; "developer" keep them. */
  signature: "adhoc" | "developer" | "unsigned" | "unknown";
  helperPid: number | null;
  helperPath: string | null;
};

export type MacPermissionReport = {
  supported: boolean;
  app: MacAppIdentity;
  items: MacPermissionEntry[];
};

