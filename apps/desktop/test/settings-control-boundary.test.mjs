import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const desktop = fileURLToPath(new URL("../", import.meta.url));

function controlIssues(path, source) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const name = path.replaceAll("\\", "/");
  const settings = /(?:^|\/)(?:components|features)\/settings\//.test(name);
  const sharedSelect = new Set();
  const issues = [];
  for (const stmt of file.statements) {
    if (!ts.isImportDeclaration(stmt) || !/(?:^|\/)ui(?:\.[cm]?[jt]sx?)?$/.test(stmt.moduleSpecifier.text)) continue;
    const bindings = stmt.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) sharedSelect.add(bindings.name.text + ".Select");
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if ((element.propertyName ?? element.name).text === "Select") sharedSelect.add(element.name.text);
      }
    }
  }

  // Read static JSX attribute values and class names in cx(), branches and templates.
  function literals(node) {
    if (!node) return [];
    if (ts.isStringLiteralLike(node)) return [node.text];
    if (ts.isJsxExpression(node) || ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) return literals(node.expression);
    if (ts.isConditionalExpression(node)) return [...literals(node.whenTrue), ...literals(node.whenFalse)];
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return literals(node.right);
    if (ts.isCallExpression(node) && ["cx", "clsx", "classNames"].includes(node.expression.getText(file))) {
      return node.arguments.flatMap(literals);
    }
    if (ts.isObjectLiteralExpression(node)) return node.properties.flatMap((prop) => prop.name ? [prop.name.text] : []);
    if (ts.isTemplateExpression(node)) {
      const text = node.head.text + node.templateSpans.map((span) => "DYNAMIC" + span.literal.text).join("");
      return [text, ...node.templateSpans.flatMap((span) => literals(span.expression))];
    }
    return [];
  }

  function visit(node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(file);
      const attrs = new Map();
      for (const attr of node.attributes.properties) {
        if (ts.isJsxAttribute(attr)) attrs.set(attr.name.getText(file), literals(attr.initializer));
        if (ts.isJsxSpreadAttribute(attr) && ts.isObjectLiteralExpression(attr.expression)) {
          for (const prop of attr.expression.properties) {
            if (ts.isPropertyAssignment(prop)) attrs.set(prop.name.text, literals(prop.initializer));
          }
        }
      }
      const classes = (attrs.get("className") ?? []).join(" ").split(/\s+/);
      const flag = (primitive) => {
        if (name === "src/components/ui.tsx") {
          const owner = ts.findAncestor(node, ts.isFunctionDeclaration)?.name?.text;
          if (owner === primitive || (owner === "CheckboxGroup" && primitive === "SegmentedControl")) return;
        }
        const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
        issues.push(path + ":" + line + " use " + primitive);
      };
      if (tag === "select" || (settings && sharedSelect.has(tag))) flag(settings ? "SettingsMenuSelect" : "Select");
      if (tag === "button" && attrs.get("role")?.includes("switch")) flag("SettingsToggle");
      if (tag === "input" && attrs.get("type")?.includes("checkbox")) flag("Checkbox");
      if (tag === "div" && classes.includes("settings-segment")) flag("SegmentedControl");
      if (tag === "button" && classes.some((name) => name.startsWith("btn-"))) flag("Button");
      if (tag === "span" && classes.some((name) => name.startsWith("badge-"))) flag("Badge");
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return issues;
}

test("settings dropdowns and switches use their shared controls", () => {
  assert.deepEqual(controlIssues("src/components/settings/example.tsx", [
    "// <select> in a comment is fine",
    "const controls = <><select /><button role={'switch'} /><SettingsToggle /><SettingsMenuSelect /></>;",
  ].join("\n")), ["src/components/settings/example.tsx:2 use SettingsMenuSelect", "src/components/settings/example.tsx:2 use SettingsToggle"]);
  const files = globSync("src/**/*.{tsx,jsx}", { cwd: desktop }).map((path) => path.replaceAll("\\", "/"));
  assert(files.some((path) => path.replaceAll("\\", "/") === "src/components/settings/SettingsMenuSelect.tsx"));
  assert.deepEqual(files.flatMap((path) => controlIssues(path, readFileSync(join(desktop, path), "utf8"))), []);
});

test("renderer controls recognize class tokens, JSX expressions and Settings Select imports", () => {
  const source = [
    'import { Select as NativeSelect } from "../../components/ui";',
    'import * as UI from "../../components/ui";',
    'const view = <>',
    '<NativeSelect /><UI.Select /><div className={cx("settings-segment", active && "shown")} />',
    '<input type={"checkbox"} /><button className={cx("btn", active ? "btn-primary" : "btn-ghost")} />',
    '<span className="badge-warning" /><button role={`switch`} />',
    '<span className="sidebar-badge-dot" /><button className="station-btn-primary-label" />',
    '<Checkbox label="x" /><UI.Button /><Badge /><SettingsMenuSelect /></>;',
  ].join("\n");
  const rendererIssues = controlIssues("src/features/chat/Panel.tsx", source);
  assert.deepEqual(rendererIssues.map((issue) => issue.split(" use ")[1]), [
    "SegmentedControl", "Checkbox", "Button", "Badge", "SettingsToggle",
  ]);
  assert.deepEqual(controlIssues("src/features/settings/Panel.tsx", source).map((issue) => issue.split(" use ")[1]),
    ["SettingsMenuSelect", "SettingsMenuSelect", "SegmentedControl", "Checkbox", "Button", "Badge", "SettingsToggle"]);
  assert.deepEqual(controlIssues("src/components/ui.tsx",
    'function Checkbox() { return <input type="checkbox" /> }\nfunction Other() { return <input type="checkbox" /> }'),
    ["src/components/ui.tsx:2 use Checkbox"]);
});
