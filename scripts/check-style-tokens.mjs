#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import ts from "typescript";
import { findLiteralSurfaceColors } from "./style-surface-tokens.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const renderer = "apps/desktop/src";
const SCALE = /^(?:font-size|font-weight|line-height|letter-spacing|border-radius)$/i;
const TOKEN = /\bvar\(\s*(--([\w]+)-[\w-]+)\s*[,)]/g;
const ARBITRARY = /\b(?:text|rounded|leading|tracking|font)-\[[^\]]+\]/g;
const CSS_STRINGS = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/gs;
const SPACING = /^(?:(?:row-|column-)?gap|(?:margin|padding)(?:-(?:top|right|bottom|left|(?:inline|block)(?:-(?:start|end))?))?)$/i;

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return /\.(css|[cm]?[jt]sx?)$/.test(entry.name) ? [path] : [];
  });
}

function mask(text) {
  return text.replace(/[^\n]/g, " ");
}

// Tailwind's @theme emits global variables. A conditional root cannot provide a default.
export function designTokens(css) {
  const names = new Set();
  function collect(container) {
    for (const node of container.nodes ?? []) {
      if (node.type === "atrule" && node.name === "layer") collect(node);
      const isTheme = node.type === "atrule" && node.name === "theme" && !node.params.includes("reference");
      if (!isTheme && !(node.type === "rule" && node.selectors.includes(":root"))) continue;
      for (const decl of node.nodes ?? []) {
        if (decl.type === "decl" && decl.prop.startsWith("--")) names.add(decl.prop);
      }
    }
  }
  collect(postcss.parse(css));
  return names;
}

export function styleTokenIssues(source, extension, names) {
  const issues = [];
  const families = new Set(["ds", "text", "radius", "leading", "tracking", "font", "motion",
    ...[...names].map((name) => name.slice(2).split("-", 1)[0])]);
  function references(value, lineAt) {
    for (const match of value.matchAll(TOKEN)) {
      if (families.has(match[2]) && !names.has(match[1])) issues.push({ line: lineAt(match.index), message: "undefined design token " + match[1] });
    }
  }
  function checkDeclaration(prop, value, line, position) {
    if (SCALE.test(prop)) {
      // Remove only the variable name and delimiters. A fallback still draws the element.
      const terms = value.replace(/\bvar\(\s*--[\w-]+\s*,?/g, " ").replace(/\)/g, " ").trim().split(/\s+/);
      if (terms.some((term) => term && !/^(?:0|inherit|initial|unset|normal|none)$/i.test(term))) {
        issues.push({ line: line, message: "raw " + prop + " value " + value + " — use a scale token" });
      }
    }
    if (!SPACING.test(prop)) return;
    let offset = 0;
    for (const part of postcss.list.space(value)) {
      const index = value.indexOf(part, offset);
      offset = index + part.length;
      const match = /^(\d+(?:\.\d+)?)px$/i.exec(part);
      if (!match) continue;
      const token = "--ds-space-" + Number(match[1]);
      if (names.has(token)) {
        issues.push({ kind: "spacing", line: position(index), message: "raw " + prop + " value " + part + " — use var(" + token + ")" });
      }
    }
  }
  if (extension !== ".css") {
    const file = ts.createSourceFile("component" + extension, source, ts.ScriptTarget.Latest, false);
    function visit(node) {
      if (ts.isJsxAttribute(node) && node.name.getText(file) === "style" &&
          node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression &&
          ts.isObjectLiteralExpression(node.initializer.expression)) {
        for (const entry of node.initializer.expression.properties) {
          if (!ts.isPropertyAssignment(entry) || !entry.name.text) continue;
          const prop = entry.name.text.replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase());
          const raw = entry.initializer;
          if (!ts.isStringLiteralLike(raw) && !ts.isNumericLiteral(raw)) continue;
          const value = ts.isNumericLiteral(raw) && SPACING.test(prop) ? raw.text + "px" : raw.text;
          const start = raw.getStart(file);
          const position = (index) => file.getLineAndCharacterOfPosition(start + index).line + 1;
          checkDeclaration(prop, value, position(0), position);
        }
      }
      if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
        const start = node.getStart(file);
        const lineAt = (index) => file.getLineAndCharacterOfPosition(start + index).line + 1;
        const literal = node.getText(file);
        references(literal, lineAt);
        if (extension.endsWith("x")) {
          for (const hit of literal.matchAll(ARBITRARY)) {
            issues.push({ line: lineAt(hit.index), message: "arbitrary utility " + hit[0] + " — use a token utility class" });
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
    return issues;
  }

  const css = source.replace(/\/\*[\s\S]*?\*\//g, mask);
  for (const { line, property, value } of findLiteralSurfaceColors(css)) {
    issues.push({ line, message: "raw " + property + " value " + value + " — use a surface token" });
  }
  postcss.parse(css).walkDecls((decl) => {
    const value = decl.value.replace(CSS_STRINGS, mask);
    const position = (index) => decl.source.start.line + (decl.raws.between + value.slice(0, index)).split("\n").length - 1;
    references(value, position);
    if (decl.parent.type === "atrule" && decl.parent.name === "font-face") return;
    checkDeclaration(decl.prop, value, decl.source.start.line, position);
  });
  return issues;
}

// Include branch commits, the index, and working-tree edits. Untracked styles and components are new in full.
export function changedStyleLines(cwd, base) {
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const mergeBase = git("merge-base", base, "HEAD").trim();
  const paths = ["css", "tsx", "jsx"].map((ext) => ":(glob)" + renderer + "/**/*." + ext);
  const ranges = new Map();
  for (const name of git("diff", "--name-only", "--no-renames", "--diff-filter=AM", "-z", mergeBase, "--", ...paths).split("\0").filter(Boolean)) {
    const patch = git("diff", "--no-ext-diff", "--no-color", "--no-renames", "-U0", mergeBase, "--", ":(literal)" + name);
    ranges.set(name, Array.from(patch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm),
      ([, first, count]) => [Number(first), Number(first) + Number(count ?? 1)]));
  }
  for (const name of git("ls-files", "--others", "--exclude-standard", "-z", "--", ...paths).split("\0").filter(Boolean)) {
    ranges.set(name, [[1, Infinity]]);
  }
  return (name, line) => ranges.get(name)?.some(([first, end]) => first <= line && line < end) ?? false;
}

if (import.meta.main) {
  const src = join(root, renderer);
  const tokens = designTokens(readFileSync(join(src, "styles/tokens.css"), "utf8"));
  const base = process.env.UI_STYLE_BASE || ["origin/main", "main", "HEAD"].find((ref) =>
    spawnSync("git", ["rev-parse", "--verify", "--quiet", ref + "^{commit}"], { cwd: root }).status === 0);
  const changed = changedStyleLines(root, base);
  const audit = process.argv.includes("--all-spacing");
  let existing = 0;
  const violations = [];
  for (const file of walk(src)) {
    const name = relative(root, file).split(sep).join("/");
    for (const issue of styleTokenIssues(readFileSync(file, "utf8"), extname(file), tokens)) {
      if (issue.kind === "spacing" && !changed(name, issue.line)) {
        existing++;
        if (!audit) continue;
      }
      violations.push(name + ":" + issue.line + " " + issue.message);
    }
  }
  console.log("Spacing base " + base + ": " + existing + " existing literals; --all-spacing lists their locations.");
  if (violations.length) {
    console.error(violations.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("style tokens OK");
  }
}
