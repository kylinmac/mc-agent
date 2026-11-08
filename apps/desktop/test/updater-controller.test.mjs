import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { dirname, join } from "node:path";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
register(pathToFileURL(join(here, "helpers/updater-module-stubs.mjs")));

const { AppUpdaterController } = await import("../electron/main/updater.ts");

class FakeUpdater extends EventEmitter {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  allowPrerelease = false;
  logger = null;
  nextVersion = "0.16.1";
  downloadStarts = [];
  cancellations = [];

  async checkForUpdates() {
    this.emit("checking-for-update");
    const info = {
      version: this.nextVersion,
      files: [],
      path: "",
      sha512: "",
      releaseDate: "2026-10-03T00:00:00.000Z",
    };
    this.emit("update-available", info);
    const cancellationToken = {
      cancel: () => {
        this.cancellations.push(info.version);
        this.emit("update-cancelled", info);
      },
    };
    const downloadPromise = this.autoDownload
      ? (this.downloadStarts.push(info.version), Promise.resolve([]))
      : null;
    return { updateInfo: info, cancellationToken, downloadPromise };
  }

  async downloadUpdate() {
    return [];
  }

  installs = [];

  quitAndInstall(...args) {
    this.installs.push(args);
  }
}

function createController({ updater, settings = {}, persist = async () => {}, platform = "darwin", distribution }) {
  const logger = { app: () => {} };
  const sent = [];
  const controller = new AppUpdaterController({
    logger,
    send: (channel, payload) => sent.push({ channel, payload }),
    currentVersion: "0.16.0",
    platform,
    distribution,
    isPackaged: true,
    autoUpdater: updater,
    readUpdateSettings: async () => settings,
    persistDismissedVersion: persist,
  });
  return { controller, sent };
}

test("auto-check runs after startup and every hour, survives failure, and stops on disposal", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { controller } = createController({ updater: new FakeUpdater(), platform: "win32", distribution: "installed" });
  let checks = 0;
  controller.check = async () => {
    checks++;
    if (checks === 2) throw new Error("temporary network failure");
    return controller.getState();
  };
  try {
    controller.startAutoCheck();
    controller.startAutoCheck();
    await new Promise(setImmediate);
    t.mock.timers.tick(14_999);
    assert.equal(checks, 0);
    t.mock.timers.tick(1);
    assert.equal(checks, 1);
    t.mock.timers.tick(60 * 60_000 - 15_001);
    assert.equal(checks, 1);
    t.mock.timers.tick(1);
    assert.equal(checks, 2);
    await new Promise(setImmediate);
    t.mock.timers.tick(60 * 60_000);
    assert.equal(checks, 3);
    controller.dispose();
    t.mock.timers.tick(60 * 60_000);
    assert.equal(checks, 3);
  } finally {
    controller.dispose();
  }
});

for (const platform of ["win32", "darwin"]) {
  test(`${platform}: download, progress, restart uses the correct installer mode`, async () => {
    const updater = new FakeUpdater();
    const { controller } = createController({ updater, platform, distribution: "installed" });
    try {
      assert.throws(() => controller.install(), /no downloaded update/);
      await controller.check();
      assert.deepEqual(updater.downloadStarts, ["0.16.1"]);
      updater.emit("download-progress", { percent: 47 });
      assert.equal(controller.getState().progressPercent, 47);
      updater.emit("update-downloaded", { version: "0.16.1" });
      assert.equal(controller.getState().status, "downloaded");
      controller.install();
      assert.equal(controller.isInstallingUpdate(), true);
      assert.deepEqual(updater.installs, [[platform === "win32", true]]);
    } finally {
      controller.dispose();
    }
  });
}

for (const failure of ["event", "throw"]) {
  test(`failed installer (${failure}) restores normal quit handling`, async () => {
    const updater = new FakeUpdater();
    const { controller } = createController({ updater, platform: "win32", distribution: "installed" });
    try {
      await controller.check();
      updater.emit("update-downloaded", { version: "0.16.1" });
      updater.quitAndInstall = () => {
        if (failure === "throw") throw new Error("Installer unavailable");
        updater.emit("error", new Error("Installer unavailable"));
      };
      if (failure === "throw") assert.throws(() => controller.install(), /Installer unavailable/);
      else controller.install();
      assert.equal(controller.isInstallingUpdate(), false);
      assert.equal(controller.getState().status, "error");
      assert.equal(updater.autoInstallOnAppQuit, false);
    } finally {
      controller.dispose();
    }
  });
}

for (const distribution of ["zip", "portable"]) {
  test(`Windows ${distribution} keeps manual updates by default`, async () => {
    const updater = new FakeUpdater();
    const { controller } = createController({ updater, platform: "win32", distribution });
    try {
      await controller.check();
      assert.equal(controller.getState().mode, "manual");
      assert.deepEqual(updater.downloadStarts, []);
      assert.throws(() => controller.install(), /no downloaded update/);
      assert.deepEqual(updater.installs, []);
    } finally {
      controller.dispose();
    }
  });
}

test("dismissing an in-app update cancels its download and disables install on quit", async () => {
  const updater = new FakeUpdater();
  const persisted = [];
  const { controller } = createController({
    updater,
    persist: async (version) => persisted.push(version),
  });

  await controller.check();
  assert.deepEqual(updater.downloadStarts, ["0.16.1"]);
  assert.equal(controller.getState().status, "downloading");

  await controller.dismiss();

  assert.deepEqual(updater.cancellations, ["0.16.1"]);
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(controller.getState().status, "available");
  assert.equal(controller.getState().dismissed, true);
  assert.deepEqual(persisted, ["0.16.1"]);
  controller.dispose();
});

test("a restored dismissal blocks that release and a newer release resumes automatic delivery", async () => {
  const updater = new FakeUpdater();
  const persisted = [];
  let clearDismissal;
  const cleared = new Promise((resolve) => {
    clearDismissal = resolve;
  });
  const { controller } = createController({
    updater,
    settings: { updatePreference: "automatic", updateDismissedVersion: "0.16.1" },
    persist: async (version) => {
      persisted.push(version);
      if (version === null) clearDismissal();
    },
  });

  await controller.check();
  assert.deepEqual(updater.downloadStarts, []);
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(controller.getState().dismissed, true);

  updater.nextVersion = "0.16.2";
  await controller.check();
  await cleared;
  assert.deepEqual(updater.downloadStarts, ["0.16.2"]);
  assert.equal(updater.autoDownload, true);
  assert.equal(updater.autoInstallOnAppQuit, true);
  assert.equal(controller.getState().dismissed, false);
  assert.deepEqual(persisted, [null]);
  controller.dispose();
});

// mc-agent: a downloaded update must not stop later checks, or a restart
// installs an older release than the newest one.
test("restarting re-reads the feed and installs a release newer than the staged one", async () => {
  const updater = new FakeUpdater();
  const { controller } = createController({ updater, platform: "win32", distribution: "installed" });
  try {
    await controller.check();
    updater.emit("update-downloaded", { version: "0.16.1" });
    // 0.16.3 came out after 0.16.1 was downloaded, before the next hourly check.
    updater.nextVersion = "0.16.3";
    await controller.installLatest();
    assert.deepEqual(updater.installs, [], "the staged older release is not installed");
    assert.equal(controller.getState().status, "downloading");
    assert.equal(updater.downloadStarts.at(-1), "0.16.3");
    updater.emit("update-downloaded", { version: "0.16.3" });
    assert.deepEqual(updater.installs, [[true, true]], "the newer release installs once it is ready");
    assert.equal(controller.getState().availableVersion, "0.16.3");
  } finally {
    controller.dispose();
  }
});

test("restarting installs the staged release when the feed has nothing newer or fails", async () => {
  for (const failure of [false, true]) {
    const updater = new FakeUpdater();
    const { controller } = createController({ updater, platform: "win32", distribution: "installed" });
    try {
      await controller.check();
      updater.emit("update-downloaded", { version: "0.16.1" });
      if (failure) {
        updater.checkForUpdates = async () => {
          updater.emit("error", new Error("offline"));
          throw new Error("offline");
        };
      }
      await controller.installLatest();
      assert.deepEqual(updater.installs, [[true, true]]);
    } finally {
      controller.dispose();
    }
  }
});

test("a failed newer download does not install later on its own", async () => {
  const updater = new FakeUpdater();
  const { controller } = createController({ updater, platform: "win32", distribution: "installed" });
  try {
    await controller.check();
    updater.emit("update-downloaded", { version: "0.16.1" });
    updater.nextVersion = "0.16.3";
    await controller.installLatest();
    updater.emit("error", new Error("download failed"));
    assert.equal(controller.getState().status, "error");
    updater.emit("update-downloaded", { version: "0.16.3" });
    assert.deepEqual(updater.installs, []);
  } finally {
    controller.dispose();
  }
});

test("a newer release replaces an update that is waiting for a restart", async () => {
  const updater = new FakeUpdater();
  const { controller } = createController({ updater, platform: "win32", distribution: "installed" });
  try {
    await controller.check();
    updater.emit("update-downloaded", { version: "0.16.1" });
    assert.equal(controller.getState().status, "downloaded");

    // The same release again: still ready to install, nothing downloaded twice.
    await controller.check();
    assert.equal(controller.getState().status, "downloaded");
    assert.equal(controller.getState().availableVersion, "0.16.1");

    // A failed re-check leaves it installable.
    updater.emit("error", new Error("offline"));
    assert.equal(controller.getState().status, "downloaded");

    updater.nextVersion = "0.16.3";
    await controller.check();
    assert.equal(controller.getState().availableVersion, "0.16.3");
    assert.equal(controller.getState().status, "downloading");
    assert.equal(updater.downloadStarts.at(-1), "0.16.3");
    updater.emit("update-downloaded", { version: "0.16.3" });
    controller.install();
    assert.deepEqual(updater.installs, [[true, true]]);
  } finally {
    controller.dispose();
  }
});

for (const selfInstall of [false, true]) {
  test(`repeated restart requests launch one installer (selfInstall=${selfInstall})`, async () => {
    const updater = new FakeUpdater();
    const { controller } = createController({ updater, platform: "win32", distribution: "installed" });
    let installs = 0;
    try {
      await controller.check();
      updater.emit("update-downloaded", { version: "0.16.1" });
      if (selfInstall) controller.selfUpdate = { install: async () => { installs++; } };
      await Promise.all([controller.installLatest(), controller.installLatest()]);
      controller.install();
      assert.equal(selfInstall ? installs : updater.installs.length, 1);
    } finally {
      controller.dispose();
    }
  });
}

test("update requests send a browser user agent and errors reach the UI as one short line", async () => {
  const updater = new FakeUpdater();
  const { controller } = createController({ updater });
  assert.match(updater.requestHeaders["User-Agent"], /^Mozilla\/5\.0 /);
  updater.emit("error", new Error('Cannot parse releases feed: HttpError: 504 "method: GET" Headers: { "set-cookie": ["_gh_sess=secret"] }'));
  assert.equal(controller.getState().error, "GitHub did not answer the update request (HTTP 504); try again later");
  controller.dispose?.();
});
