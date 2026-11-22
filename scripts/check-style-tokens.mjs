#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { findLiteralSurfaceColors } from "./style-surface-tokens.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "apps/desktop/src");
const CSS_SCALE = /[;{]\s*(font-size|font-weight|line-height|letter-spacing|border-radius)\s*:\s*([^;{}]+)/g;
const TSX_ARBITRARY = /\b(?:text|rounded|leading|tracking|font)-\[[^\]]+\]/g;
const ALLOWED_BARE = new Set(["0", "!important", "inherit", "initial", "unset", "normal", "none"]);

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return /\.(css|tsx?)$/.test(entry.name) ? [path] : [];
  });
}

function mask(text) {
  return text.replace(/[^\n]/g, " ");
}

// Only an unqualified root declaration supplies a default to every theme.
export function designTokens(css) {
  const names = new Set();
  const source = css.replace(/\/\*[\s\S]*?\*\//g, mask);
  for (const [, selector, body] of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selector.split(",").some((part) => part.trim() === ":root")) continue;
    for (const [, name] of body.matchAll(/(?:^|;)\s*(--ds-[\w-]+)\s*:/g)) names.add(name);
  }
  return names;
}

export function styleTokenIssues(source, extension, names) {
  const issues = [];
  const code = source.replace(/\/\*[\s\S]*?\*\//g, mask);
  const lineAt = (index) => code.slice(0, index).split("\n").length;
  for (const hit of code.matchAll(/\bvar\(\s*(--ds-[\w-]+)\s*[,)]/g)) {
    if (!names.has(hit[1])) issues.push({ line: lineAt(hit.index), message: "undefined design token " + hit[1] });
  }
  if (extension === ".tsx") {
    for (const hit of code.matchAll(TSX_ARBITRARY)) {
      issues.push({ line: lineAt(hit.index), message: "arbitrary utility " + hit[0] + " — use a token utility class" });
    }
  }
  if (extension === ".css") {
    for (const { line, property, value } of findLiteralSurfaceColors(code)) {
      issues.push({ line, message: "raw " + property + " value " + value + " — use a surface token" });
    }
    // Font-face ranges describe the file. Only element styles use the UI scales.
    const styles = code.replace(/@font-face\s*\{[^{}]*\}/g, mask);
    for (const hit of styles.matchAll(CSS_SCALE)) {
      let rest = hit[2];
      while (/var\([^()]*\)/.test(rest)) rest = rest.replace(/var\([^()]*\)/g, " ");
      if (rest.split(/\s+/).some((term) => term && !ALLOWED_BARE.has(term))) {
        issues.push({ line: lineAt(hit.index + hit[0].indexOf(hit[1])), message: "raw " + hit[1] + " value " + hit[2].trim() + " — use a scale token" });
      }
    }
  }
  return issues;
}

if (import.meta.main) {
  const tokens = designTokens(readFileSync(join(srcDir, "styles/tokens.css"), "utf8"));
  const violations = walk(srcDir).flatMap((file) =>
    styleTokenIssues(readFileSync(file, "utf8"), extname(file), tokens)
      .map(({ line, message }) => relative(root, file) + ":" + line + " " + message),
  );
  if (violations.length) {
    console.error(violations.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("style tokens OK");
  }
}
