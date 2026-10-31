import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { ComposerFastMode } from "../../src/features/chat/composer/ComposerFastMode";
import { useAppStore } from "../../src/stores/app-store";
import { api } from "../../src/lib/api";
import { fastModeKey } from "@pi-desktop/shared";
import { ComposerToolbar } from "../../src/features/chat/composer/ComposerToolbar";
import { TOOLBAR_PROPS } from "../helpers/composer-toolbar.mjs";
import i18n from "i18next";

export async function checkFastMode() {
  window.piDesktop.on = () => () => {};
  window.piDesktop.invoke = async () => ({ ok: false, error: { code: "TEST_BRIDGE_UNAVAILABLE", message: "Fixture bridge unavailable" } });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const check = (ok, label) => { if (!ok) throw new Error("Fast: " + label); };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 40));
  let stored = {}; const errors = [];
  const original = api.setSettings;
  api.setSettings = async (patch) => { stored = JSON.parse(JSON.stringify({ ...stored, ...patch })); };
  useAppStore.setState({ settings: {}, providers: [
    { id: "fast-one", apiStyle: "responses" }, { id: "fast-two", apiStyle: "responses" },
  ], showToast: (message) => errors.push(message) });
  const render = (providerId = "fast-one", modelId = "gpt-6.1-sol", disabled = false) =>
    flushSync(() => root.render(<ComposerFastMode {...{ providerId, modelId, disabled }} />));
  const button = () => container.querySelector("button");
  try {
    render(); check(button().getAttribute("aria-pressed") === "false", "default off");
    check(button().getAttribute("aria-label").includes("Fast"), "accessible name");
    button().click(); await settle();
    check(stored.fastModeBindings[fastModeKey("fast-one", "gpt-6.1-sol")] === true, "settings persisted");
    check(button().getAttribute("aria-pressed") === "true", "enabled state");
    render("fast-two"); check(button().getAttribute("aria-pressed") === "false", "provider isolation");
    render("fast-one", "gpt-6-astra"); check(button().getAttribute("aria-pressed") === "false", "model isolation");
    render("fast-one", "deepseek-flash"); check(button().disabled, "unsupported model");
    render("fast-one", "gpt-6.1-sol", true); check(button().disabled, "running disabled");
    render();
    api.setSettings = async () => { throw new Error("fixture save failure"); };
    button().click(); await settle();
    check(button().getAttribute("aria-pressed") === "true", "failed save retains preference");
    check(errors.includes("fixture save failure"), "save error visible");
    api.setSettings = async (patch) => { stored = { ...stored, ...patch }; };
    button().click(); await settle();
    check(button().getAttribute("aria-pressed") === "false", "can disable after failure");
    // Simulate settings reloaded from host storage and remount the control.
    useAppStore.setState({ settings: JSON.parse(JSON.stringify(stored)) });
    flushSync(() => root.render(null)); render();
    check(button().getAttribute("aria-pressed") === "false", "restored preference");
    const toolbar = (extra = {}) => flushSync(() => root.render(<ComposerToolbar {...TOOLBAR_PROPS}
      t={i18n.t} providerId="fast-one" modelId="gpt-6.1-sol" modelLabel="gpt-6.1-sol" {...extra} />));
    toolbar();
    const lightning = container.querySelector(".mc-fast-mode");
    check(lightning?.nextElementSibling?.textContent.includes("gpt-6.1-sol"), "lightning immediately before model picker");
    toolbar({ runActive: true }); check(container.querySelector(".mc-fast-mode").disabled, "toolbar run guard");
    toolbar({ localToolsAllowed: false }); check(!container.querySelector(".mc-fast-mode"), "remote toolbar excludes local preference");
  } finally { api.setSettings = original; root.unmount(); container.remove(); }
}
