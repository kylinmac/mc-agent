import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { resolveElectronBinary } from "./e2e/boot.mjs";
const root = resolve(import.meta.dirname, "..");
const dir = await mkdtemp(join(tmpdir(), "mc-panel-e2e-"));
try {
  await build({ entryPoints: [join(root, "scripts/e2e/work-panel-agent.ts")], outfile: join(dir, "main.cjs"), bundle: true, platform: "node", format: "cjs", external: ["electron"] });
  await build({ entryPoints: [join(root, "scripts/e2e/work-panel-terminal.ts")], outfile: join(dir, "terminal.js"), bundle: true, platform: "browser" });
  await writeFile(join(dir, "test.html"), '<textarea aria-label="Draft editor"></textarea><button onclick="window.saved=document.querySelector(\'textarea\').value">Save</button><div id="terminal"></div><script src="terminal.js"></script>');
  await copyFile(join(root, "scripts/e2e/work-panel-file-manager-preload.cjs"), join(dir, "preload.cjs"));
  const env = { ...process.env, MC_PANEL_TEST_DIR: dir, MC_PANEL_REPO: root }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(resolveElectronBinary(root).electronBinary, [join(dir, "main.cjs")], { env, stdio: "inherit", windowsHide: true });
  const timer = setTimeout(() => child.kill(), 45000);
  try {
    const code = await new Promise((res, rej) => { child.on("error", rej); child.on("exit", res); });
    if (code !== 0) throw new Error(`Work panel E2E failed: ${code}`);
  } finally { clearTimeout(timer); }
} finally {
  // mkdtemp returns a checked child of the explicitly named temporary directory.
  if (!dir.startsWith(join(tmpdir(), "mc-panel-e2e-"))) throw new Error("Unexpected fixture path");
  await rm(dir, { recursive: true, force: true });
}
