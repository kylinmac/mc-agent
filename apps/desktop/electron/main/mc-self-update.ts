/**
 * mc-agent: in-app updates for the ad-hoc signed macOS build (MC-ADR-0012).
 *
 * Squirrel.Mac refuses an update whose signing identity differs from the
 * running app's, and an ad-hoc signature has no identity, so electron-updater
 * can find a new version but never install it. This does the install itself:
 * download the release zip named in `latest-mac.yml`, check its SHA-512,
 * unzip it, check the new app's signature, bundle id and version, and on
 * restart let a small script swap the bundle once this process has exited,
 * then reopen it.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { access, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const MC_RELEASE_DOWNLOAD_BASE = "https://github.com/kylinmac/mc-agent/releases/download";

export type ReleaseFile = { url: string; sha512: string; size?: number };

/** The release zip for `arch` from a `latest-mac.yml` body. */
export function releaseZip(yml: string, arch: string): ReleaseFile | null {
  const files: ReleaseFile[] = [];
  let current: Partial<ReleaseFile> | null = null;
  const flush = () => {
    if (current?.url && current.sha512) files.push(current as ReleaseFile);
  };
  for (const line of yml.split(/\r?\n/)) {
    const item = line.match(/^\s*-\s+url:\s*(.+?)\s*$/);
    if (item) {
      flush();
      current = { url: item[1]!.replace(/^['"]|['"]$/g, "") };
      continue;
    }
    if (!current || !/^\s{2,}\w/.test(line)) {
      if (current && /^\S/.test(line)) {
        flush();
        current = null;
      }
      continue;
    }
    const field = line.match(/^\s+(sha512|size):\s*(.+?)\s*$/);
    if (field?.[1] === "sha512") current.sha512 = field[2]!.replace(/^['"]|['"]$/g, "");
    if (field?.[1] === "size") current.size = Number(field[2]);
  }
  flush();
  const zips = files.filter((file) => file.url.endsWith(".zip"));
  return zips.find((file) => file.url.includes(`-${arch}-`)) ?? (arch === "x64" ? zips.find((file) => !/arm64/.test(file.url)) : undefined) ?? null;
}

/** The `.app` bundle that contains the running executable, if any. */
export function bundleOf(execPath: string): string | null {
  const index = execPath.indexOf(".app/Contents/MacOS/");
  return index > 0 ? execPath.slice(0, index + 4) : null;
}

export function plistValue(app: string, key: string): string | null {
  const result = spawnSync("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", join(app, "Contents", "Info.plist")], {
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

/** The shell script that swaps the bundle after the app has quit, then reopens it. */
export function installScript(): string {
  return [
    "#!/bin/sh",
    '# mc-agent update: wait for the app to exit, swap the bundle, reopen.',
    'PID="$1"; TARGET="$2"; STAGED="$3"',
    "i=0",
    'while kill -0 "$PID" 2>/dev/null; do',
    "  sleep 0.2; i=$((i+1))",
    '  [ "$i" -gt 600 ] && exit 1',
    "done",
    'BACKUP="$TARGET.mc-update-backup"',
    'rm -rf "$BACKUP"',
    'mv "$TARGET" "$BACKUP" || exit 1',
    'if /usr/bin/ditto "$STAGED" "$TARGET"; then',
    '  rm -rf "$BACKUP"',
    "else",
    '  rm -rf "$TARGET"; mv "$BACKUP" "$TARGET"',
    "fi",
    'rm -rf "$(dirname "$STAGED")"',
    '/usr/bin/open "$TARGET"',
    "",
  ].join("\n");
}

export type SelfUpdaterOptions = {
  /** The running app bundle (`…/mc-agent.app`). */
  bundle: string;
  /** Where downloads and the unpacked app are kept until the restart. */
  workDir: string;
  arch: string;
  fetch: typeof fetch;
  quit: () => void;
};

export class McSelfUpdater {
  private staged: { version: string; app: string } | null = null;
  private readonly options: SelfUpdaterOptions;

  constructor(options: SelfUpdaterOptions) {
    this.options = options;
  }

  /** Can this install replace itself (its folder is writable)? */
  static async usable(bundle: string | null): Promise<boolean> {
    if (!bundle) return false;
    try {
      await access(dirname(bundle), constants.W_OK);
      await access(bundle, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  stagedVersion(): string | null {
    return this.staged?.version ?? null;
  }

  /** Download, verify and unpack `version`; `onProgress` gets 0–100. */
  async download(version: string, onProgress: (percent: number) => void, signal?: AbortSignal): Promise<void> {
    const { fetch, arch, workDir } = this.options;
    const base = `${MC_RELEASE_DOWNLOAD_BASE}/v${encodeURIComponent(version)}`;
    const feed = await fetch(`${base}/latest-mac.yml`, { signal });
    if (!feed.ok) throw new Error(`release feed unavailable (${feed.status})`);
    const file = releaseZip(await feed.text(), arch);
    if (!file) throw new Error(`no ${arch} download in release ${version}`);

    const dir = join(workDir, `mc-agent-update-${version}`);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const zipPath = join(dir, "update.zip");
    const response = await fetch(`${base}/${encodeURIComponent(file.url)}`, { signal });
    if (!response.ok || !response.body) throw new Error(`download failed (${response.status})`);
    const total = file.size || Number(response.headers.get("content-length")) || 0;
    const hash = createHash("sha512");
    const out = createWriteStream(zipPath);
    let received = 0;
    let lastPercent = -1;
    try {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        received += value.byteLength;
        if (!out.write(value)) await new Promise<void>((ok) => out.once("drain", () => ok()));
        const percent = total ? Math.min(99, Math.floor((received / total) * 100)) : 0;
        if (percent !== lastPercent) {
          lastPercent = percent;
          onProgress(percent);
        }
      }
    } finally {
      await new Promise<void>((ok) => out.end(() => ok()));
    }
    if (hash.digest("base64") !== file.sha512) {
      await rm(dir, { recursive: true, force: true });
      throw new Error("the download does not match the release checksum");
    }

    const unpacked = join(dir, "app");
    const unzip = spawnSync("/usr/bin/ditto", ["-x", "-k", zipPath, unpacked], { encoding: "utf8" });
    if (unzip.status !== 0) throw new Error(`could not unpack the update: ${unzip.stderr.trim()}`);
    const name = (await readdir(unpacked)).find((entry) => entry.endsWith(".app"));
    if (!name) throw new Error("the update contains no app");
    const app = join(unpacked, name);
    const verify = spawnSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { encoding: "utf8" });
    if (verify.status !== 0) throw new Error(`the update's signature is invalid: ${verify.stderr.trim()}`);
    const id = plistValue(app, "CFBundleIdentifier");
    if (!id || id !== plistValue(this.options.bundle, "CFBundleIdentifier")) {
      throw new Error("the update is a different app");
    }
    const bundled = plistValue(app, "CFBundleShortVersionString");
    if (bundled !== version) throw new Error(`the update reports version ${bundled ?? "?"}, expected ${version}`);
    await rm(zipPath, { force: true });
    this.staged = { version, app };
    onProgress(100);
  }

  /** Hand the swap to a detached script and quit; it reopens the new app. */
  async install(): Promise<void> {
    const staged = this.staged;
    if (!staged) throw new Error("no downloaded update to install");
    const script = join(dirname(dirname(staged.app)), "install.sh");
    await writeFile(script, installScript(), { mode: 0o755 });
    const child = spawn("/bin/sh", [script, String(process.pid), resolve(this.options.bundle), staged.app], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    this.options.quit();
  }
}
