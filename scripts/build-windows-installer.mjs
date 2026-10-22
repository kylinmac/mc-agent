import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(repo, "apps/desktop");
const require = createRequire(join(desktop, "package.json"));
const builderRequire = createRequire(require.resolve("app-builder-lib"));
const { UUID } = builderRequire("builder-util-runtime");

export async function buildWindowsInstaller({ payload, output, version, appId, executable, directory, testFixture = false }) {
  if (process.platform !== "win32") throw new Error("Build the Windows setup on Windows");
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error("Invalid setup version");
  for (const value of [executable, directory]) {
    if (!/^[\w.-]+$/.test(value) || value === "." || value === "..") throw new Error("Invalid install identity");
  }
  const stage = await mkdtemp(join(tmpdir(), "mc-setup-build-"));
  try {
    const guid = UUID.v5(appId, UUID.parse("50e065bc-3134-11e6-9bab-38c9862bdaf3"));
    await writeFile(join(stage, "metadata.json"), JSON.stringify({
      version, executable, directory,
      registryKey: `Software\\${guid}`,
      sha512: createHash("sha512").update(await readFile(payload)).digest("base64"),
    }));
    const framework = join(process.env.WINDIR ?? "C:/Windows", "Microsoft.NET/Framework64/v4.0.30319");
    const source = join(repo, "apps/windows-installer");
    const references = ["System.dll", "System.Core.dll", "System.Xaml.dll", "System.Web.Extensions.dll", "System.Windows.Forms.dll"];
    const args = ["/nologo", "/target:winexe", "/platform:x64", "/optimize+", `/out:${output}`,
      ...(testFixture ? ["/define:INSTALLER_TEST"] : []),
      `/win32icon:${join(desktop, "build/icon.ico")}`, `/win32manifest:${join(source, "app.manifest")}`,
      ...references.map(file => `/reference:${join(framework, file)}`),
      ...["PresentationCore.dll", "PresentationFramework.dll", "WindowsBase.dll"].map(file => `/reference:${join(framework, "WPF", file)}`),
      `/resource:${payload},payload.exe`, `/resource:${join(stage, "metadata.json")},metadata.json`,
      `/resource:${join(source, "Window.xaml")},Window.xaml`, `/resource:${join(desktop, "build/icon.png")},icon.png`,
      ...["en", "zh-CN"].map(locale => `/resource:${join(repo, "packages/i18n/windows-installer", locale + ".json")},${locale}.json`),
      join(source, "Program.cs")];
    await new Promise((ok, fail) => {
      const process = spawn(join(framework, "csc.exe"), args, { stdio: "inherit", windowsHide: true });
      process.once("error", fail);
      process.once("exit", code => code === 0 ? ok() : fail(new Error(`Setup compilation failed: ${code}`)));
    });
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const release = resolve(process.argv[2] ?? join(desktop, "release"));
  const updaterRequire = createRequire(require.resolve("electron-updater"));
  const feed = updaterRequire("js-yaml").load(await readFile(join(release, "latest.yml"), "utf8"));
  const expected = `mc-agent-Update-${feed.version}.exe`;
  if (feed.path !== expected || !feed.files?.some(file => file.url === expected)) throw new Error("Windows feed must reference the NSIS update payload");
  const payload = join(release, expected);
  const digest = createHash("sha512").update(await readFile(payload)).digest("base64");
  if (feed.sha512 !== digest || feed.files.find(file => file.url === expected).sha512 !== digest) throw new Error("Update checksum mismatch");
  const pkg = JSON.parse(await readFile(join(desktop, "package.json"), "utf8"));
  await buildWindowsInstaller({ payload, output: join(release, `mc-agent-Setup-${feed.version}.exe`),
    version: feed.version, appId: pkg.build.appId, executable: "mc-agent.exe", directory: "mc-agent" });
}
