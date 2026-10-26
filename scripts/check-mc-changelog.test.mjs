import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { FLAT_HIGHLIGHTS_UNTIL, REQUIRED_FROM, validateCatalog, validateEntries } from "./check-mc-changelog.mjs";

const script = fileURLToPath(new URL("./check-mc-changelog.mjs", import.meta.url));

test("accepts an empty catalog and silent releases", () => {
  assert.deepEqual(validateCatalog({ zh: [], en: [] }), []);
  assert.deepEqual(
    validateCatalog({ zh: [{ version: "1.0.30", date: "2026-10-27" }], en: [] }, { require: "1.0.30" }),
    [],
  );
});

test("accepts categorized lines and the flat highlights of already-tagged versions", () => {
  assert.deepEqual(
    validateEntries("zh-CN", [
      { version: "1.0.23", features: ["语音输入：按住快捷键说话。"], improvements: [], fixes: ["启动时不再白屏。"] },
      { version: FLAT_HIGHLIGHTS_UNTIL, highlights: ["旧版本的扁平条目，更紧凑清晰。"] },
    ]),
    [],
  );
});

test("rejects flat highlights on new versions, unknown keys, category prefixes and filler", () => {
  const text = validateEntries("zh-CN", [
    { version: "1.0.26", highlights: ["a"] },
    { version: "1.0.25", features: ["新功能：a"], tweaks: ["b"] },
    { version: "1.0.24", improvements: ["进一步优化使用体验。"], fixes: "c" },
    { version: "1.0.23", fixes: ["Improved the overall experience."] },
  ]).join("\n");
  assert.match(text, /instead of highlights/);
  assert.match(text, /unknown key tweaks/);
  assert.match(text, /category prefix/);
  assert.match(text, /filler \(进一步\)/);
  assert.match(text, /fixes: must be an array/);
  assert.match(text, /filler \(Improved the overall experience\)/);
});

test("rejects bad versions, order, dates and lines", () => {
  const failures = validateEntries("zh-CN", [
    { version: "v1.0.31" },
    { version: "1.0.30", fixes: ["a"] },
    { version: "1.0.30", fixes: ["b"] },
    { version: "1.0.32", date: "2026-13-01", features: ["• c", " d", ""] },
    { version: "0.21.0" },
  ]);
  const text = failures.join("\n");
  assert.match(text, /must be x\.y\.z/);
  assert.match(text, /duplicate version 1\.0\.30/);
  assert.match(text, /newest first/);
  assert.match(text, /YYYY-MM-DD/);
  assert.match(text, /bullet prefix/);
  assert.match(text, /non-empty trimmed/);
  assert.match(text, /upstream 0\.x/);
});

test("en mirrors zh-CN versions and per-category counts", () => {
  const failures = validateCatalog({
    zh: [{ version: "1.0.30", features: ["一"], fixes: ["二"] }],
    en: [
      { version: "1.0.31" },
      { version: "1.0.30", features: ["one", "two"] },
    ],
  });
  assert.equal(failures.length, 3);
});

test("release gate requires an entry only from REQUIRED_FROM on", () => {
  assert.deepEqual(validateCatalog({ zh: [], en: [] }, { require: "1.0.19" }), []);
  assert.match(validateCatalog({ zh: [], en: [] }, { require: REQUIRED_FROM }).join(), /no entry for/);
  assert.match(
    validateCatalog({ zh: [{ version: "1.0.21" }], en: [] }, { require: "1.0.20" }).join(),
    /newer than the release/,
  );
});

test("CLI checks another checkout and skips old tags without the catalog", () => {
  const root = mkdtempSync(path.join(tmpdir(), "mc-changelog-"));
  try {
    const run = (...args) => execFileSync(process.execPath, [script, "--root", root, ...args], { encoding: "utf8" });
    assert.match(run("--require", "1.0.19"), /skipped/);
    assert.throws(() => run("--require", REQUIRED_FROM));
    const src = path.join(root, "packages/shared/src");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      path.join(src, "mc-changelog-zh-CN.ts"),
      `import type { McReleaseNotes } from "./mc-changelog-types.js";\nexport const mcZhCNEntries: McReleaseNotes[] = [{ version: "${REQUIRED_FROM}", features: ["新功能"] }];\n`,
    );
    assert.match(run("--require", REQUIRED_FROM), /has an entry/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
