#!/usr/bin/env node
// Regenerates the mc-agent `mcProject` block in every locale catalog from
// mc-agent-strings.json, between the `// mc-agent:begin` / `// mc-agent:end`
// markers, so mc-agent copy stays out of the upstream sections of each file.
// en, zh-CN and zh-TW are translated; other locales fall back to English text.
//
// The JSON is the only place to edit this copy. Editing a catalog's generated
// block by hand makes the two drift apart, and the next run then silently
// deletes whatever was added there. `--check` reports that drift without
// writing anything; the i18n tests run it.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, "../src/locales");
const strings = JSON.parse(readFileSync(join(here, "mc-agent-strings.json"), "utf8"));
const locales = ["en", "zh-CN", "zh-TW", "de", "es", "fr", "ko", "pt-BR", "tr"];
const check = process.argv.includes("--check");
const stale = [];
const BEGIN = "  // mc-agent:begin";
const END = "  // mc-agent:end";

// A string is one JSON literal; a group of strings is written one per line,
// the way the catalogs have always carried them.
function literal(value) {
  if (typeof value === "string") return JSON.stringify(value);
  const rows = Object.entries(value).map(([name, text]) => `      ${name}: ${JSON.stringify(text)},`);
  return `{\n${rows.join("\n")}\n    }`;
}

function block(locale) {
  const lines = [BEGIN, "  mcProject: {"];
  for (const [key, values] of Object.entries(strings)) {
    const value = values[locale] ?? values.en;
    lines.push(`    ${key}: ${literal(value)},`);
  }
  lines.push("  },", END);
  return lines.join("\n");
}

for (const locale of locales) {
  const file = join(localesDir, locale, "index.ts");
  let text = readFileSync(file, "utf8");
  const start = text.indexOf(BEGIN);
  if (start >= 0) {
    const end = text.indexOf(END, start) + END.length;
    text = text.slice(0, start) + block(locale) + text.slice(end);
  } else {
    const close = text.search(/\n\}( as const| satisfies EnglishCatalog);/);
    if (close < 0) throw new Error(`no catalog end in ${file}`);
    // The last property may lack a trailing comma (JSON-style catalogs).
    const head = text.slice(0, close).replace(/(\S)\s*$/, (match, last) => (last === "," ? match : `${last},`));
    text = `${head}\n${block(locale)}${text.slice(close)}`;
  }
  if (check) {
    if (text !== readFileSync(file, "utf8")) stale.push(locale);
  } else {
    writeFileSync(file, text);
  }
}
if (check) {
  if (stale.length > 0) {
    console.error(
      `mc-agent strings are out of date in: ${stale.join(", ")}. ` +
        "Edit packages/i18n/scripts/mc-agent-strings.json, then run node packages/i18n/scripts/mc-agent-strings.mjs.",
    );
    process.exitCode = 1;
  } else {
    console.log(`mc-agent strings match ${locales.length} catalogs`);
  }
} else {
  console.log(`mc-agent strings written to ${locales.length} catalogs`);
}
