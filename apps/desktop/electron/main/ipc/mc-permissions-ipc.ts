import { spawnSync } from "node:child_process";
import { app, shell, systemPreferences } from "electron";
import { IPC } from "@pi-desktop/shared";
import type { IpcRegistrar } from "./types";
import { MacPermissions, macPermissionItemOf } from "../mc-macos-permissions";
import { bundleOf, plistValue } from "../mc-self-update";

/** The Computer Use plugin's `permissions` tool, as plugin-runtime registers it. */
const HELPER_PLUGIN_ID = "mc.computer-use";
const HELPER_TOOL_SUFFIX = "_computer_permissions";

type PluginTools = {
  getTools: () => Array<{ pluginId: string; fullName: string; execute: (args: unknown) => Promise<unknown> }>;
};

/** The running app's signature kind, read once: it does not change while running. */
let signature: "adhoc" | "developer" | "unsigned" | "unknown" | undefined;
function signatureOf(bundle: string | null): "adhoc" | "developer" | "unsigned" | "unknown" {
  if (signature) return signature;
  if (!bundle || process.platform !== "darwin") return (signature = "unknown");
  const result = spawnSync("/usr/bin/codesign", ["-dv", bundle], { encoding: "utf8" });
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  signature = /Signature=adhoc/.test(text)
    ? "adhoc"
    : /Authority=Developer ID Application/.test(text)
      ? "developer"
      : /not signed/.test(text)
        ? "unsigned"
        : "unknown";
  return signature;
}

/**
 * mc-agent macOS permissions page (X-PERM-02). Check never prompts; request
 * and open-settings run only on the user's click, for one fixed item.
 */
export function registerMcPermissionsIpc({
  registrar,
  plugins,
}: {
  registrar: IpcRegistrar;
  plugins: PluginTools;
}): void {
  const permissions = new MacPermissions({
    platform: process.platform,
    helperTool: () =>
      plugins
        .getTools()
        .find((tool) => tool.pluginId === HELPER_PLUGIN_ID && tool.fullName.endsWith(HELPER_TOOL_SUFFIX)) ?? null,
    microphoneStatus: () =>
      process.platform === "darwin" ? systemPreferences.getMediaAccessStatus("microphone") : "granted",
    askMicrophone: () => systemPreferences.askForMediaAccess("microphone"),
    openUrl: (url) => shell.openExternal(url),
    identity: () => {
      const bundle = bundleOf(process.execPath);
      const mac = bundle && process.platform === "darwin";
      return {
        // The name System Settings lists: the bundle's, not Electron's app name.
        name: (mac && (plistValue(bundle, "CFBundleDisplayName") ?? plistValue(bundle, "CFBundleName"))) || app.getName(),
        version: app.getVersion(),
        bundlePath: bundle,
        bundleId: mac ? plistValue(bundle, "CFBundleIdentifier") : null,
        signature: signatureOf(bundle),
      };
    },
  });
  registrar.handle(IPC.invoke.macPermissionsCheck, async () => permissions.check());
  registrar.handle(IPC.invoke.macPermissionsRequest, async (input: { item?: unknown } = {}) =>
    permissions.request(macPermissionItemOf(input?.item)),
  );
  registrar.handle(IPC.invoke.macPermissionsOpenSettings, async (input: { item?: unknown } = {}) => {
    await permissions.openSettings(macPermissionItemOf(input?.item));
    return { ok: true };
  });
}
