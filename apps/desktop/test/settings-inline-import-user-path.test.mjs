import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const here = dirname(fileURLToPath(import.meta.url));
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const serverLabel = "工作区 · Workspace MCP / " + "long-project-name-".repeat(8) + "review";

const fixtureSource = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { FONT_SCALE_PRESETS, IPC } from "@pi-desktop/shared";
import { SettingsPage } from "../../apps/desktop/src/features/settings/SettingsPage";
import { ToastHost } from "../../apps/desktop/src/components/Toast";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

const projectPath = "/tmp/pi-settings-inline-import-project";
const candidate = {
  selectionId: "fixture-choice", source: "claude-code", sourcePath: projectPath + "/.mcp.json",
  id: "fixture-project-server", label: ${JSON.stringify(serverLabel)},
  displayMeta: "Local fixture server", transport: "stdio",
};
const importedServer = {
  id: candidate.id, label: candidate.label, level: "project", projectPath,
  transport: "stdio", commandLabel: "node", hasArgs: true, envKeys: ["DOCS_KEY"], headerKeys: [], enabled: false,
  createdAt: "2026-10-04T00:00:00.000Z", updatedAt: "2026-10-04T00:00:00.000Z",
};
const otherCandidate = { ...candidate, selectionId: "other-choice", id: "other", label: "Local docs" };
const project = {
  id: 1,
  path: projectPath,
  name: "Inline Import Project",
  pinned: true,
  createdAt: 0,
  lastOpenedAt: 0,
};
const calls = [];
let imported = false;
const builtinSkill = {
  id: "pi-desktop/imagegen",
  name: "imagegen",
  description: "Generate and edit images.",
  enabled: true,
};
let builtinSkillSetCall;

// Toast audio is optional feedback; this hidden fixture checks the visible
// toast only and does not emit a sound during the automated UI run.
Object.defineProperty(window, "AudioContext", { configurable: true, value: undefined });
window.piDesktop = {
  platform: "darwin",
  on() { return () => {}; },
  async invoke(channel, ...args) {
    const input = args[0];
    calls.push({ channel, input });
    let data;
    switch (channel) {
      case IPC.invoke.pluginScenicThemesDestinations:
        data = [];
        break;
      case IPC.invoke.projectList:
        data = { projects: [project] };
        break;
      case IPC.invoke.skillList:
        data = { skills: [] };
        break;
      case IPC.invoke.skillBuiltinList:
        data = { builtins: [builtinSkill] };
        break;
      case IPC.invoke.skillBuiltinSetEnabled:
        builtinSkillSetCall = { channel, input };
        builtinSkill.enabled = input.enabled;
        data = { id: input.id, enabled: input.enabled };
        break;
      case IPC.invoke.mcpList:
        data = {
          servers: imported && input?.level === "project" ? [importedServer] : [],
          statuses: [],
        };
        break;
      case IPC.invoke.mcpImportScan:
        data = { candidates: imported ? [otherCandidate] : [candidate, otherCandidate], sources: [] };
        break;
      case IPC.invoke.mcpImportRun:
        imported = true;
        data = {
          imported: [{ item: input.items[0] }],
          skipped: [],
          failed: [],
        };
        break;
      case IPC.invoke.mcpUpsert:
        data = { server: importedServer };
        break;
      default:
        throw new Error("Unexpected fixture IPC: " + channel);
    }
    return { ok: true, data };
  },
};

await i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } },
  interpolation: { escapeValue: false },
});
const theme = new URLSearchParams(location.search).get("theme");
const fontScale = innerWidth === 800 ? FONT_SCALE_PRESETS.xl : FONT_SCALE_PRESETS.default;
useAppStore.setState({
  settings: { defaultMode: "agent", theme, fontScale, language: "en", developerMode: false },
  settingsTab: "skills",
  page: "settings",
  workspace: { path: projectPath, name: project.name },
});
document.documentElement.dataset.theme = theme;
document.documentElement.style.setProperty("--font-scale", String(fontScale));
const root = createRoot(document.getElementById("root"));
flushSync(() => root.render(React.createElement(React.Fragment, null,
  React.createElement(SettingsPage),
  React.createElement(ToastHost),
)));

const frame = () => new Promise(requestAnimationFrame);
async function settle() {
  await frame();
  await frame();
}
function requireNode(node, message) {
  if (!node) throw new Error(message);
  return node;
}
function buttons() {
  return [...document.querySelectorAll("button")];
}
function buttonByLabel(label) {
  return buttons().find((button) => button.textContent.trim() === label);
}
async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    await settle();
    const value = predicate();
    if (value) return value;
  }
  throw new Error(message);
}

window.selectMcpCandidate = async () => {
  await waitFor(
    () => [...document.querySelectorAll(".agent-capability-row .agent-capability-name")]
      .find((node) => node.textContent.trim() === "imagegen"),
    "Bundled imagegen skill did not appear in Settings",
  );
  const builtinRow = requireNode(
    [...document.querySelectorAll(".agent-capability-row")]
      .find((row) => row.querySelector(".agent-capability-name")?.textContent.trim() === "imagegen"),
    "Bundled skill row is missing",
  );
  const builtinToggle = requireNode(
    builtinRow.querySelector('[role="switch"]'),
    "Bundled skill toggle is missing",
  );
  if (builtinToggle.getAttribute("aria-checked") !== "true") {
    throw new Error("Bundled skill must be enabled by default");
  }
  flushSync(() => builtinToggle.click());
  await waitFor(
    () => builtinSkillSetCall && builtinToggle.getAttribute("aria-checked") === "false",
    "Turning off the bundled skill did not update the setting",
  );
  if (!builtinRow.classList.contains("is-off")) {
    throw new Error("Disabled bundled skill row did not show its off state");
  }
  const builtinToggleState = {
    persisted: builtinSkillSetCall,
    visibleOff: builtinRow.classList.contains("is-off"),
  };
  requireNode(document.querySelector(".toast-dismiss"), "Missing skill status").click();

  await waitFor(() => buttonByLabel("MCP"), "MCP destination did not render");
  flushSync(() => requireNode(buttonByLabel("MCP"), "MCP navigation is missing").click());
  await waitFor(
    () => document.querySelector(".agent-capability-segment"),
    "MCP settings page did not open",
  );

  const projectFilter = requireNode(
    [...document.querySelectorAll('.agent-capability-segment button[role="radio"]')]
      .find((button) => button.textContent.trim().startsWith("Project")),
    "Project scope filter is missing",
  );
  const filters = [...projectFilter.parentElement.querySelectorAll('[role="radio"]')];
  const selected = requireNode(filters.find((option) => option.getAttribute("aria-checked") === "true"), "Missing active filter");
  if (selected.tabIndex !== 0 || filters.filter((option) => option.tabIndex === 0).length !== 1) {
    throw new Error("A scope filter must have exactly one Tab stop");
  }
  selected.focus();
  for (const [key, expected] of [["End", projectFilter], ["ArrowRight", filters[0]], ["ArrowLeft", projectFilter]]) {
    document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    await settle();
    if (document.activeElement !== expected || expected.getAttribute("aria-checked") !== "true") {
      throw new Error("Scope filter did not move focus and selection on " + key);
    }
  }
  await settle();
  if (projectFilter.getAttribute("aria-checked") !== "true") {
    throw new Error("Project scope filter did not become active");
  }

  const toggle = requireNode(
    buttonByLabel("Scan other tools"),
    "Inline MCP scan action is missing",
  );
  if (toggle.disabled) throw new Error("Project scan action is disabled for the current project");
  flushSync(() => toggle.click());
  await settle();
  const panel = requireNode(
    document.getElementById("agent-mcp-import-panel"),
    "Inline MCP workbench is missing",
  );
  if (panel.hidden || toggle.getAttribute("aria-expanded") !== "true") {
    throw new Error("Inline MCP workbench did not expand");
  }
  const scanDescription = requireNode(
    panel.querySelector(".import-idle-description"),
    "Expanded MCP workbench does not show its scan description",
  );
  if (!scanDescription.textContent.trim()) {
    throw new Error("Expanded MCP scan description is empty");
  }
  if (panel.querySelector(".import-idle .ui-help-icon")) {
    throw new Error("Expanded MCP workbench still hides its description behind a help icon");
  }
  const scanCountBeforeExplicitClick = calls.filter(
    (call) => call.channel === IPC.invoke.mcpImportScan,
  ).length;

  flushSync(() => requireNode(buttonByLabel("Scan"), "Scan button is missing").click());
  await waitFor(
    () => document.querySelector(".import-row input[type=checkbox]"),
    "Explicit MCP scan did not render its candidate",
  );
  const candidateRow = requireNode(
    [...document.querySelectorAll(".import-row")]
      .find((row) => row.textContent.includes(candidate.label)),
    "Scanned MCP candidate is not visible",
  );
  const candidateCheckbox = requireNode(
    candidateRow.querySelector('input[type="checkbox"]'),
    "Scanned MCP candidate checkbox is missing",
  );
  flushSync(() => candidateCheckbox.click());
  await settle();

  const importButton = requireNode(
    buttons().find((button) => button.textContent.trim() === "Import selected (1)"),
    "Import selected action did not enable after selecting the candidate",
  );
  const mark = getComputedStyle(candidateCheckbox, "::after");
  const mixed = requireNode(panel.querySelector(".import-select-all input:indeterminate"), "Missing mixed selection");
  const ink = getComputedStyle(importButton).color;
  if (mark.borderRightStyle !== "solid" || mark.borderRightColor !== ink ||
      getComputedStyle(mixed, "::after").backgroundColor !== ink ||
      mark.borderRightColor === getComputedStyle(candidateCheckbox).backgroundColor) {
    throw new Error("Selected and mixed checkboxes must paint contrasting marks in " + theme);
  }
  const box = candidateCheckbox.getBoundingClientRect();
  const title = candidateRow.querySelector(".import-row-title");
  if (title.title !== candidate.label) throw new Error("Long candidate name must be available in full");
  const name = title.getBoundingClientRect();
  const action = importButton.getBoundingClientRect();
  if (name.width <= 0 || box.right > name.left + 1 || name.right > innerWidth + 1 ||
      action.width <= 0 || action.left < 0 || action.right > innerWidth + 1) {
    throw new Error("Long candidate obscures the selection or import action at width " + innerWidth);
  }
  await waitFor(() => !document.querySelector(".toast"), "Dismissed skill status remained visible");
  return { builtinToggleState, scanCountBeforeExplicitClick };
};

window.importSelectedMcp = async () => {
  flushSync(() => requireNode(buttonByLabel("Import selected (1)"), "Import action disappeared").click());
  await waitFor(
    () => [...document.querySelectorAll(".toast-message")]
      .find((node) => node.textContent.trim() === "Import done: 1 imported, 0 skipped, 0 failed"),
    "Successful import result was not shown",
  );
  await waitFor(
    () => [...document.querySelectorAll(".agent-capability-row .agent-capability-name")]
      .find((node) => node.textContent.trim() === candidate.label),
    "Imported MCP server did not appear in the selected project list",
  );

  const runCall = calls.find((call) => call.channel === IPC.invoke.mcpImportRun);
  const scanCalls = calls.filter((call) => call.channel === IPC.invoke.mcpImportScan);
  const visibleRow = [...document.querySelectorAll(".agent-capability-row")]
    .find((row) => row.querySelector(".agent-capability-name")?.textContent.trim() === candidate.label);
  return {
    scanCalls,
    runCall,
    visibleToast: [...document.querySelectorAll(".toast-message")]
      .map((node) => node.textContent.trim())
      .find((message) => message.startsWith("Import done:")),
    visibleImportedServer: Boolean(visibleRow),
    importedServerDisabled: visibleRow?.classList.contains("is-off") ?? false,
  };
};

window.editImportedMcp = async () => {
  const edit = requireNode(buttons().find((button) => button.getAttribute("aria-label") === "Edit " + candidate.label), "Missing imported server editor");
  flushSync(() => edit.click());
  const dialog = await waitFor(() => document.querySelector(".ext-sheet-body"), "MCP editor did not open");
  const valueInput = requireNode(dialog.querySelector(".kv-value"), "Missing saved credential field");
  if (valueInput.value !== "" || !valueInput.placeholder) throw new Error("Saved credential must be masked");
  flushSync(() => requireNode(buttonByLabel("Save"), "Missing save action").click());
  const call = await waitFor(() => calls.find((entry) => entry.channel === IPC.invoke.mcpUpsert), "Saving the masked form did not reach Main");
  if ("args" in call.input || "command" in call.input || Object.keys(call.input.env).length) {
    throw new Error("An unchanged launch field was sent as a replacement");
  }
  return call.input.keepEnvKeys;
};
`;

const urlAssets = {
  name: "local-url-assets",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /\?url$/ }, ({ path, resolveDir }) => ({
      path: join(resolveDir, path.slice(0, -4)),
      namespace: "local-url-asset",
    }));
    pluginBuild.onLoad({ filter: /.*/, namespace: "local-url-asset" }, async ({ path }) => ({
      contents: await readFile(path),
      loader: "file",
    }));
  },
};

test("Settings disables a bundled skill and imports an external MCP server into a project", {
  timeout: 60_000,
  skip:
    process.platform === "linux" && !process.env.DISPLAY
      ? "Isolated Electron UI test requires a display"
      : false,
}, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pi-settings-inline-mcp-import-"));
  try {
    await build({
      stdin: {
        contents: fixtureSource,
        resolveDir: join(root, "scripts", "e2e"),
        sourcefile: join(root, "scripts", "e2e", "settings-inline-mcp-import.jsx"),
        loader: "tsx",
      },
      outfile: join(temp, "renderer.js"),
      bundle: true,
      platform: "browser",
      format: "esm",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "true" },
      alias: {
        "@pi-desktop/i18n": join(root, "packages/i18n/src"),
        "@pi-desktop/shared": join(root, "packages/shared/src"),
        react: join(root, "apps/desktop/node_modules/react"),
        "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
        i18next: join(root, "apps/desktop/node_modules/i18next"),
        "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
      },
      nodePaths: [join(root, "apps/desktop/node_modules")],
      plugins: [urlAssets],
    });

    const renderer = join(root, "apps/desktop/out/renderer");
    const rendererHtml = await readFile(join(renderer, "index.html"), "utf8");
    const css = [...rendererHtml.matchAll(/href="([^" ]+\.css)"/g)]
      .map((match) => match[1]);
    assert(css.length, "Run pnpm --filter @pi-desktop/desktop build before this test");
    await cp(join(renderer, "assets"), join(temp, "assets"), { recursive: true });
    await writeFile(
      join(temp, "index.html"),
      `<!doctype html><html data-platform="${process.platform}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:">${css.map((path) => `<link rel="stylesheet" href="${path}">`).join("")}</head><body><div id="root"></div><script type="module" src="renderer.js"></script></body></html>`,
    );
    await writeFile(
      join(temp, "main.cjs"),
      `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.on("window-all-closed", () => {});
app.whenReady().then(async () => {
  try {
    for (const width of [800, 1100]) {
      for (const theme of ["light", "dark"]) {
        console.log("Testing settings import at " + width + "px in " + theme);
        // Xvfb needs a mapped window for Chromium to keep delivering animation frames.
        const win = new BrowserWindow({ show: process.platform === "linux", width, height: 760, useContentSize: true,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
        win.webContents.on("console-message", (event) => console.error(event.message));
        await win.loadFile(path.join(__dirname, "index.html"), { query: { theme } });
        const viewport = await win.webContents.executeJavaScript("innerWidth");
        if (viewport !== width) throw new Error("Expected width " + width + ", got " + viewport);
        const selection = await win.webContents.executeJavaScript("window.selectMcpCandidate()");
        if (process.env.PI_E2E_ARTIFACT_DIR) {
          const fs = require("node:fs/promises");
          await fs.mkdir(process.env.PI_E2E_ARTIFACT_DIR, { recursive: true });
          await fs.writeFile(path.join(process.env.PI_E2E_ARTIFACT_DIR, "settings-import-" + theme + "-" + width + ".png"),
            (await win.webContents.capturePage()).toPNG());
        }
        const imported = await win.webContents.executeJavaScript("window.importSelectedMcp()");
        const keptEnvKeys = await win.webContents.executeJavaScript("window.editImportedMcp()");
        console.log("SETTINGS_INLINE_MCP_IMPORT " + JSON.stringify({ ...selection, ...imported, keptEnvKeys }));
        win.destroy();
      }
    }
    app.exit(0);
  } catch (error) {
    console.error(error?.stack ?? error);
    app.exit(1);
  }
});
`,
    );

    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => { output += chunk; });
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 50_000);
    let code;
    try {
      code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
    } finally {
      clearTimeout(timer);
    }
    assert.equal(code, 0, output);
    const results = output.split(/\r?\n/)
      .filter((line) => line.startsWith("SETTINGS_INLINE_MCP_IMPORT "))
      .map((line) => JSON.parse(line.slice("SETTINGS_INLINE_MCP_IMPORT ".length)));
    assert.equal(results.length, 4, output);
    const [result] = results;
    assert.deepEqual(result.keptEnvKeys, ["DOCS_KEY"]);
    for (const variant of results.slice(1)) assert.deepEqual(variant, result);

    assert.deepEqual(result.builtinToggleState, {
      persisted: {
        channel: "pi-desktop/skill/builtin/setEnabled",
        input: { id: "pi-desktop/imagegen", enabled: false },
      },
      visibleOff: true,
    });
    assert.equal(result.scanCountBeforeExplicitClick, 0, "Expanding the inline panel must not scan");
    assert.equal(result.scanCalls.length, 2, "The explicit scan and post-import refresh should run");
    assert.deepEqual(result.scanCalls[0].input, {
      projectPath: "/tmp/pi-settings-inline-import-project",
    });
    assert.deepEqual(result.runCall.input, {
      level: "project",
      projectPath: "/tmp/pi-settings-inline-import-project",
      items: [{ selectionId: "fixture-choice" }],
    });
    assert.equal(result.visibleToast, "Import done: 1 imported, 0 skipped, 0 failed");
    assert.equal(result.visibleImportedServer, true);
    assert.equal(result.importedServerDisabled, true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
