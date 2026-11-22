import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const desktop = fileURLToPath(new URL("../", import.meta.url));

function controlIssues(path, source) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const issues = [];
  function visit(node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(file);
      const role = node.attributes.properties.find((attr) => ts.isJsxAttribute(attr) && attr.name.getText(file) === "role")?.initializer;
      const value = role && ts.isJsxExpression(role) ? role.expression : role;
      const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
      if (tag === "select") issues.push(path + ":" + line + " use SettingsMenuSelect");
      if (tag === "button" && value && ts.isStringLiteral(value) && value.text === "switch") {
        issues.push(path + ":" + line + " use SettingsToggle");
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return issues;
}

test("Settings uses shared dropdowns and switches", () => {
  assert.deepEqual(controlIssues("example.tsx", [
    "// <select> in a comment is fine",
    "const controls = <><select /><button role={'switch'} /><SettingsToggle /><SettingsMenuSelect /></>;",
  ].join("\n")), ["example.tsx:2 use SettingsMenuSelect", "example.tsx:2 use SettingsToggle"]);
  const files = globSync("src/{components,features}/settings/**/*.tsx", { cwd: desktop });
  assert(files.some((path) => path.replaceAll("\\", "/") === "src/components/settings/SettingsMenuSelect.tsx"));
  assert.deepEqual(files.flatMap((path) => controlIssues(path, readFileSync(join(desktop, path), "utf8"))), []);
});
