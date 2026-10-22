// Real NSIS install/update smoke test with a disposable .NET payload, never
// mc-agent's installed app or data. Uses the production NSIS configuration.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildWindowsInstaller } from "./build-windows-installer.mjs";

if (process.platform !== "win32") throw new Error("Windows only");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(repo, "apps/desktop");
const pkg = JSON.parse(await readFile(join(desktop, "package.json"), "utf8"));
const root = await mkdtemp(join(tmpdir(), "mc-installer-test-"));
const name = "mc-agent-installer-test";
const installDir = join(root, "custom location 中文", name);
const payload = join(root, "payload");
const dataDir = join(root, "user-data");
await mkdir(payload);
await mkdir(join(payload, "resources"));
await mkdir(dataDir);
console.log(`Isolated installer evidence: ${root}`);

function run(exe, args, cwd = root) {
  return new Promise((ok, fail) => {
    const child = spawn(exe, args, { cwd, stdio: "inherit", windowsHide: true });
    child.once("error", fail);
    child.once("exit", code => code === 0 ? ok() : fail(new Error(`${exe}: ${code}`)));
  });
}
async function waitForVersion(version) {
  for (let i = 0; i < 150; i++) {
    try {
      if ((await readFile(join(installDir, "launched.txt"), "utf8")) === version) return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await new Promise(ok => setTimeout(ok, 200));
  }
  throw new Error(`Installer did not relaunch ${version} in the original directory`);
}
const config = {
  appId: `com.kylinmac.installer-test.${randomUUID()}`,
  productName: name,
  electronVersion: "43.4.1",
  npmRebuild: false,
  directories: { buildResources: join(desktop, "build"), output: join(root, "release") },
  win: { executableName: name, icon: join(desktop, "build/icon.ico"), target: ["nsis"] },
  nsis: {
    ...pkg.build.nsis,
    include: join(desktop, pkg.build.nsis.include),
    installerIcon: join(desktop, pkg.build.nsis.installerIcon),
    uninstallerIcon: join(desktop, pkg.build.nsis.uninstallerIcon),
    installerHeaderIcon: join(desktop, pkg.build.nsis.installerHeaderIcon),
    installerSidebar: join(desktop, pkg.build.nsis.installerSidebar),
    uninstallerSidebar: join(desktop, pkg.build.nsis.uninstallerSidebar),
    shortcutName: name,
    uninstallDisplayName: name,
    createDesktopShortcut: false,
    createStartMenuShortcut: false,
  },
};
await writeFile(join(root, "builder.json"), JSON.stringify(config));
const cli = join(desktop, "node_modules/electron-builder/cli.js");
const csc = join(process.env.WINDIR ?? "C:/Windows", "Microsoft.NET/Framework64/v4.0.30319/csc.exe");
for (const version of ["1.0.0", "1.0.1"]) {
  await writeFile(join(root, "package.json"), JSON.stringify({
    name, version, description: "Disposable NSIS verification", author: "mc-agent", main: "index.js",
  }));
  await writeFile(join(root, "Fixture.cs"), `using System; using System.IO;
class Fixture { static void Main() { File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "launched.txt"), "${version}"); } }`);
  await run(csc, ["/nologo", "/target:winexe", `/out:${join(payload, name + ".exe")}`, join(root, "Fixture.cs")]);
  await run(process.execPath, [cli, "--projectDir", root, "--config", join(root, "builder.json"),
    "--prepackaged", payload, "--win", "nsis", "--x64", "--publish", "never"], desktop);
  const setup = join(root, "release", `mc-agent-Update-${version}.exe`);
  await buildWindowsInstaller({ payload: setup, output: join(root, "release", `mc-agent-Setup-${version}.exe`),
    version, appId: config.appId, executable: name + ".exe", directory: name, testFixture: true });
  if (version === "1.0.0") {
    for (const locale of ["en", "zh-CN"]) {
      for (const state of ["initial", "installing", "ready", "error"]) {
        await run(join(root, "release", `mc-agent-Setup-${version}.exe`), ["--preview", `--lang=${locale}`, `--state=${state}`, `--test-render=${join(root, `${locale}-${state}.png`)}`]);
      }
    }
    await run(join(root, "release", `mc-agent-Setup-${version}.exe`), ["--preview", "--lang=zh-CN", "--test-scale=2", `--test-render=${join(root, "zh-CN-2x.png")}`]);
    await assert.rejects(run(join(root, "release", `mc-agent-Setup-${version}.exe`), ["--test-install=C:\\"]));
    await assert.rejects(run(join(root, "release", `mc-agent-Setup-${version}.exe`), [`--test-install=${installDir}`, "--test-bad-checksum"]));
  }
  // Match electron-updater's /S and --force-run. Only the first install
  // supplies /D; the update must retrieve the original path from NSIS.
  if (version === "1.0.0") {
    await run(join(root, "release", `mc-agent-Setup-${version}.exe`), [`--test-install=${installDir}`]);
  } else {
    await run(setup, ["--updated", "/S", "--force-run"]);
  }
  await waitForVersion(version);
  if (version === "1.0.0") await writeFile(join(dataDir, "user-data-sentinel.txt"), "preserve");
}
assert.equal(await readFile(join(dataDir, "user-data-sentinel.txt"), "utf8"), "preserve");
await run(join(root, "release", "mc-agent-Setup-1.0.1.exe"), ["--test-install=existing"]);
await waitForVersion("1.0.1");
const uninstaller = (await readdir(installDir)).find(name => /^Uninstall .*\.exe$/.test(name));
assert.ok(uninstaller);
await run(join(installDir, uninstaller), ["/S"]);
console.log("PASS: two real NSIS packages, silent update, custom directory reuse, forced relaunch, data preserved, uninstall invoked");
await buildWindowsInstaller({ payload: join(root, "release", "mc-agent-Update-1.0.1.exe"),
  output: join(root, "release", "mc-agent-Setup-production.exe"), version: "1.0.1",
  appId: config.appId, executable: name + ".exe", directory: name });
console.log("PASS: production Setup compiled without the test driver");
// Keep only this isolated test's evidence for inspection; do not recursively
// delete a path chosen by an installer or touch the real app's registry/data.
