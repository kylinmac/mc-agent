import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { REQUIRED_FROM, validateCatalog, validateEntries } from "./check-mc-changelog.mjs";

const script = fileURLToPath(new URL("./check-mc-changelog.mjs", import.meta.url));

test("accepts an empty catalog and silent releases", () => {
  assert.deepEqual(validateCatalog({ zh: [], en: [] }), []);
  assert.deepEqual(
    validateCatalog({ zh: [{ version: "1.0.20", date: "2026-10-27", highlights: [] }], en: [] }, { require: "1.0.20" }),
    [],
  );
});

test("rejects bad versions, order, dates and highlights", () => {
  const failures = validateEntries("zh-CN", [
    { version: "v1.0.21", highlights: [] },
    { version: "1.0.20", highlights: ["a"] },
    { version: "1.0.20", highlights: ["b"] },
    { version: "1.0.22", date: "2026-13-01", highlights: ["• c", " d", ""] },
    { version: "0.21.0", highlights: [] },
    { version: "1.0.1" },
  ]);
  const text = failures.join("\n");
  assert.match(text, /must be x\.y\.z/);
  assert.match(text, /duplicate version 1\.0\.20/);
  assert.match(text, /newest first/);
  assert.match(text, /YYYY-MM-DD/);
  assert.match(text, /bullet prefix/);
  assert.match(text, /non-empty trimmed/);
  assert.match(text, /upstream 0\.x/);
  assert.match(text, /highlights must be an array/);
});

test("en mirrors zh-CN versions and highlight counts", () => {
  const failures = validateCatalog({
    zh: [{ version: "1.0.20", highlights: ["一", "二"] }],
    en: [
      { version: "1.0.21", highlights: [] },
      { version: "1.0.20", highlights: ["one"] },
    ],
  });
  assert.equal(failures.length, 2);
});

test("release gate requires an entry only from REQUIRED_FROM on", () => {
  assert.deepEqual(validateCatalog({ zh: [], en: [] }, { require: "1.0.19" }), []);
  assert.match(validateCatalog({ zh: [], en: [] }, { require: REQUIRED_FROM }).join(), /no entry for/);
  assert.match(
    validateCatalog({ zh: [{ version: "1.0.21", highlights: [] }], en: [] }, { require: "1.0.20" }).join(),
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
      `import type { ChangelogEntry } from "./changelog.js";\nexport const mcZhCNEntries: ChangelogEntry[] = [{ version: "${REQUIRED_FROM}", highlights: ["新功能"] }];\n`,
    );
    assert.match(run("--require", REQUIRED_FROM), /has an entry/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
