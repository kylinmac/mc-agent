import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { SystemPromptsPage } from "../../src/features/settings/SystemPromptsPage";
import { api } from "../../src/lib/api";
import "../../src/styles/mc-system-prompts.css";

export async function checkBuiltinPrompt() {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 40));
  const check = (ok, label) => { if (!ok) throw new Error("Builtin prompt: " + label); };
  const originals = { get: api.getSystemPromptConfig, set: api.setSystemPromptConfig, builtin: api.builtinSystemPrompt, groups: api.listProjectGroups };
  const config = { templates: [], modelRules: [], projectRules: [], appendPrompts: [], globalTemplateId: null };
  let reads = 0; const writes = [];
  const content = { prompt: { sections: [{ key: "persona", text: "Original built-in identity" }, { key: "runtime", text: "Original runtime rules" }] } };
  api.getSystemPromptConfig = async () => ({ config });
  api.listProjectGroups = async () => ({ groups: [] });
  api.setSystemPromptConfig = async (value) => { writes.push(structuredClone(value)); return { config: value }; };
  api.builtinSystemPrompt = async () => { reads++; return content; };
  const card = () => container.querySelector(".mc-builtin-prompt");
  const action = (key) => [...container.querySelectorAll("button")].find((node) => node.textContent.trim() === i18n.t(key));
  const toggle = () => card().querySelector("button[aria-expanded]");
  try {
    flushSync(() => root.render(<SystemPromptsPage />)); await settle();
    check(card(), "visible with zero user templates");
    check(reads === 0, "lazy loading");
    check(action("mcProject.promptSave").disabled, "initial config clean");
    toggle().click(); await settle();
    check(card().querySelectorAll("pre").length === 2, "formatted source sections");
    check(card().textContent.includes(content.prompt.sections[0].text), "source text rendered");
    check(!card().querySelector("input,textarea,select,[contenteditable=true]"), "no editor");
    check(card().querySelectorAll("button").length === 1, "only collapse, no edit or delete");
    check(action("mcProject.promptSave").disabled && writes.length === 0, "view does not dirty or write config");
    toggle().click(); await settle(); check(!card().querySelector("pre"), "collapsed");
    api.builtinSystemPrompt = async () => { throw new Error("fixture read failure"); };
    toggle().click(); await settle(); check(card().querySelector('[role="alert"]'), "visible read error");
    api.builtinSystemPrompt = async () => content;
    action("mcProject.promptBuiltinRetry").click(); await settle();
    check(card().querySelector("pre"), "retry loads content");
    toggle().click(); await settle();
    let resolveLate;
    api.builtinSystemPrompt = () => new Promise((resolve) => { resolveLate = resolve; });
    toggle().click(); await settle(); toggle().click(); await settle();
    resolveLate({ prompt: { sections: [{ key: "persona", text: "late result" }] } }); await settle();
    check(!card().textContent.includes("late result"), "closed request cannot repopulate view");
    action("mcProject.promptAddTemplate").click(); await settle();
    action("mcProject.promptSave").click(); await settle();
    check(writes.length === 1 && writes[0].templates.length === 1, "only user-created template is saved");
    check(!JSON.stringify(writes[0]).includes("Original built-in"), "built-in text never enters template configuration");
  } finally {
    root.unmount(); container.remove();
    api.getSystemPromptConfig = originals.get; api.setSystemPromptConfig = originals.set;
    api.builtinSystemPrompt = originals.builtin; api.listProjectGroups = originals.groups;
  }
}
