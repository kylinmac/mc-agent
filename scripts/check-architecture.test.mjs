import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const checker = fileURLToPath(new URL("./check-architecture.mjs", import.meta.url));

test("local architecture check covers new files before commit and skips working-tree deletions", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "mc-arch-budget-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd });
  const write = (file, content) => {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), content);
  };
  const check = () => spawnSync(process.execPath, [checker, "--base", "main"], { cwd, encoding: "utf8" });

  git("init", "--quiet", "--initial-branch=main");
  const baseline = ["apps/desktop/electron/main/index.ts", "apps/desktop/src/stores/app-store.ts", "packages/old.ts"];
  for (const path of baseline) write(path, "export {};\n");
  git("add", "--", ...baseline);
  git("-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-qm", "baseline");
  const file = "packages/new.ts";
  write(file, "// line\n".repeat(801));
  const untracked = check();
  assert.equal(untracked.status, 1);
  assert.match(untracked.stderr, /packages\/new\.ts \(801 LOC\)/);
  git("add", "--", file);
  assert.match(check().stderr, /packages\/new\.ts \(801 LOC\)/);
  write(file, "export {};\n");
  rmSync(join(cwd, "packages/old.ts"));
  const fixed = check();
  assert.equal(fixed.status, 0, fixed.stderr);

  write("docs/architecture/allowlist.json", JSON.stringify({
    rust: { "crates/missing.rs": "no longer exists" },
    typescript: { [file]: "now within budget" },
  }));
  const obsolete = check();
  assert.equal(obsolete.status, 1);
  assert.match(obsolete.stderr, /obsolete size exemption: crates\/missing\.rs/);
  assert.match(obsolete.stderr, /obsolete size exemption: packages\/new\.ts/);
});
