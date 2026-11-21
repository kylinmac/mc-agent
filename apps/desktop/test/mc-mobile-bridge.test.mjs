import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { IPC, parseMobilePairUri } from "@pi-desktop/shared";
import { MobileBridge } from "../electron/main/mobile-bridge/bridge.ts";

const GATEWAY_BIN = resolve(
  import.meta.dirname,
  "../../../target/debug/mc-mobile-gateway" + (process.platform === "win32" ? ".exe" : ""),
);

function createMockEnv(dataDir) {
  const renderedEvents = [];
  const invoked = [];
  const hostCalls = [];
  const activeTurns = new Map([["s1", "turn-1"]]);

  const canvases = new Map();
  const whiteboards = new Map();

  const host = {
    async call(method, params) {
      hostCalls.push({ method, params });
      switch (method) {
        case "project.groups.list":
          return {
            groups: [
              { id: "grp-1", name: "Demo", roots: [{ path: "/tmp/demo" }] },
            ],
          };
        case "workspace.get":
          return { workspace: { path: "/tmp/demo", name: "Demo" } };
        case "session.get":
          return { session: { id: params?.id ?? "s1", projectPath: "/tmp/demo" } };
        case "canvas.list":
          return { canvases: [...canvases.values()] };
        case "canvas.create": {
          const canvas = {
            id: `wb-${canvases.size + 1}`,
            title: params.title,
            kind: params.kind ?? "whiteboard",
            version: 1,
          };
          canvases.set(canvas.id, canvas);
          whiteboards.set(canvas.id, { scene: { elements: [] }, files: {}, hasPreview: false });
          return { canvas };
        }
        case "canvas.get":
          return { canvas: canvases.get(params.canvasId) };
        case "canvas.whiteboard.get": {
          const wb = whiteboards.get(params.canvasId);
          return { canvas: canvases.get(params.canvasId), ...wb };
        }
        case "canvas.whiteboard.save": {
          const current = canvases.get(params.canvasId);
          const next = { ...current, version: current.version + 1 };
          canvases.set(params.canvasId, next);
          whiteboards.set(params.canvasId, {
            scene: params.scene,
            files: params.files ?? {},
            hasPreview: whiteboards.get(params.canvasId)?.hasPreview ?? false,
          });
          return { canvas: next };
        }
        case "canvas.whiteboard.savePreview": {
          const wb = whiteboards.get(params.canvasId);
          if (wb) wb.hasPreview = true;
          return { ok: true };
        }
        default:
          return {};
      }
    },
  };

  const invoke = async (channel, args) => {
    invoked.push({ channel, args });
    switch (channel) {
      case IPC.invoke.sessionList:
        return {
          sessions: [
            { id: "s1", title: "Alpha", projectPath: "/tmp/demo" },
            { id: "s2", title: "Beta", projectPath: "/tmp/other" },
          ],
        };
      case IPC.invoke.sessionCreate:
        return { session: { id: "s-new", title: args[0]?.title ?? "New" } };
      case IPC.invoke.sessionGet:
        return { session: { id: args[0]?.id, title: "Alpha", messages: [] } };
      case IPC.invoke.pendingInteractive:
        return {
          permissions: args[0]?.sessionId === "s1" ? [{ requestId: "perm-1", toolName: "bash" }] : [],
          asks: args[0]?.sessionId === "s1" ? [{ requestId: "ask-1", questions: [{ question: "Proceed?" }] }] : [],
        };
      case IPC.invoke.plansPending:
        return { plans: [{ proposalId: "plan-1", sessionId: "s1", title: "Refactor" }] };
      case IPC.invoke.agentPrompt:
      case IPC.invoke.agentSteer:
      case IPC.invoke.agentQueuePush:
      case IPC.invoke.agentStop:
      case IPC.invoke.toolResolvePermission:
      case IPC.invoke.askToolResolve:
      case IPC.invoke.plansResolve:
        return { ok: true };
      default:
        throw new Error(`Unexpected channel: ${channel}`);
    }
  };

  const collectDiff = async () => ({
    repo: true,
    clean: false,
    files: [
      {
        path: "src/app.ts",
        status: "modified",
        additions: 3,
        deletions: 1,
        binary: false,
        hunks: [],
      },
    ],
  });

  const bridge = new MobileBridge({
    dataDir,
    appVersion: "1.0.89-test",
    hostname: "TestMac",
    binaryPath: GATEWAY_BIN,
    noMdns: true,
    getHost: () => host,
    invoke,
    activeTurns,
    sendToRenderer: (channel, payload) => renderedEvents.push({ channel, payload }),
    collectDiff,
  });

  return { bridge, renderedEvents, invoked, hostCalls };
}

test("MobileBridge defaults to disabled and rejects non-allowlisted methods", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mc-mobile-bridge-"));
  try {
    const { bridge } = createMockEnv(dir);
    const status = await bridge.getStatus();
    assert.equal(status.enabled, false);
    assert.equal(status.state, "stopped");

    for (const forbidden of ["settings.set", "secrets.get", "project.delete", "db.query"]) {
      await assert.rejects(
        () => bridge.dispatchRpc("c1", forbidden, {}),
        (err) => err?.rpcCode === "FORBIDDEN",
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("MobileBridge serves allowlisted RPCs, cursor replay, images, diffs, and whiteboard sync", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mc-mobile-bridge-"));
  try {
    const { bridge, renderedEvents, invoked } = createMockEnv(dir);

    const info = await bridge.dispatchRpc("c1", "host.info", {});
    assert.equal(info.hostname, "TestMac");
    assert.equal(info.appVersion, "1.0.89-test");

    const attention = await bridge.dispatchRpc("c1", "attention.list", {});
    const kinds = new Set(attention.items.map((item) => item.kind));
    assert.ok(kinds.has("permission"));
    assert.ok(kinds.has("ask"));
    assert.ok(kinds.has("plan"));
    assert.ok(kinds.has("running"));

    // Session event buffering and cursor replay
    bridge.observeEvent(IPC.event.agentMessage, {
      sessionId: "s1",
      event: { type: "text_delta", delta: "hello" },
    });
    bridge.observeEvent(IPC.event.agentMessage, {
      sessionId: "s1",
      event: { type: "text_delta", delta: " world" },
    });
    const sub = await bridge.dispatchRpc("c1", "session.subscribe", {
      sessionId: "s1",
      afterCursor: 1,
    });
    assert.equal(sub.replayedCount, 1);
    assert.equal(sub.cursor, 2);

    // Send message with PNG image attachment
    const png1x1 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    await bridge.dispatchRpc("c1", "turn.send", {
      sessionId: "s1",
      content: "Check this sketch",
      images: [{ name: "sketch.png", mimeType: "image/png", dataBase64: png1x1 }],
    });
    const promptCall = invoked.find((c) => c.channel === IPC.invoke.agentPrompt);
    assert.ok(promptCall);
    assert.equal(promptCall.args[0].attachments.length, 1);
    assert.ok(existsSync(promptCall.args[0].attachments[0].path));

    // Diff summary and single file
    const summary = await bridge.dispatchRpc("c1", "diff.summary", { sessionId: "s1" });
    assert.equal(summary.files.length, 1);
    assert.equal(summary.files[0].path, "src/app.ts");
    const fileDiff = await bridge.dispatchRpc("c1", "diff.file", {
      sessionId: "s1",
      path: "src/app.ts",
    });
    assert.equal(fileDiff.file.additions, 3);

    // Whiteboard create -> save -> live canvasChanged broadcast -> get
    const created = await bridge.dispatchRpc("c1", "canvas.createWhiteboard", {
      sessionId: "s1",
      title: "S Pen Architecture",
    });
    assert.equal(created.groupId, "grp-1");
    assert.equal(created.canvas.kind, "whiteboard");

    const saved = await bridge.dispatchRpc("c1", "canvas.saveWhiteboard", {
      sessionId: "s1",
      canvasId: created.canvas.id,
      scene: { elements: [{ id: "el-1", type: "freedraw" }] },
      previewBase64: png1x1,
      baseVersion: 1,
    });
    assert.equal(saved.canvas.version, 2);
    assert.ok(
      renderedEvents.some(
        (e) => e.channel === IPC.event.canvasChanged && e.payload.canvasId === created.canvas.id,
      ),
    );

    const loaded = await bridge.dispatchRpc("c1", "canvas.get", {
      sessionId: "s1",
      canvasId: created.canvas.id,
    });
    assert.equal(loaded.scene.elements.length, 1);
    assert.equal(loaded.hasPreview, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "MobileBridge spawns real mc-mobile-gateway sidecar, generates QR pair URI, and stops cleanly",
  { skip: !existsSync(GATEWAY_BIN) },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "mc-mobile-real-"));
    const { bridge } = createMockEnv(dir);
    try {
      const started = await bridge.setEnabled(true);
      assert.equal(started.enabled, true);
      assert.equal(started.state, "running");
      assert.ok(started.nodeId && started.nodeId.length >= 32);

      const offer = await bridge.createPair(300);
      assert.ok(offer.qrSvg.includes("<svg"));
      const parsed = parseMobilePairUri(offer.pairUri);
      assert.equal(parsed.ok, true);
      if (parsed.ok) {
        assert.equal(parsed.value.nodeId, started.nodeId);
        assert.equal(parsed.value.secret, offer.secret);
      }

      const stopped = await bridge.setEnabled(false);
      assert.equal(stopped.enabled, false);
      assert.equal(stopped.state, "stopped");
    } finally {
      await bridge.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
