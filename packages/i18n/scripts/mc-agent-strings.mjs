#!/usr/bin/env node
// Regenerates the mc-agent `mcProject` block in every locale catalog from
// mc-agent-strings.json, between the `// mc-agent:begin` / `// mc-agent:end`
// markers, so mc-agent copy stays out of the upstream sections of each file.
// en, zh-CN and zh-TW are translated; other locales fall back to English text.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, "../src/locales");
const strings = JSON.parse(readFileSync(join(here, "mc-agent-strings.json"), "utf8"));
const locales = ["en", "zh-CN", "zh-TW", "de", "es", "fr", "ko", "pt-BR", "tr"];
const BEGIN = "  // mc-agent:begin";
const END = "  // mc-agent:end";

function block(locale) {
  const lines = [BEGIN, "  mcProject: {"];
  for (const [key, values] of Object.entries(strings)) {
    const value = values[locale] ?? values.en;
    lines.push(`    ${key}: ${JSON.stringify(value)},`);
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
  writeFileSync(file, text);
}
console.log(`mc-agent strings written to ${locales.length} catalogs`);
