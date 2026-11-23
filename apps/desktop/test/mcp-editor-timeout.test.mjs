import assert from "node:assert/strict";
import test from "node:test";
import { createDesktopSsrServer } from "./helpers/ssr-server.mjs";

test("editing an MCP server can set or clear its timeout override", async () => {
  const server = await createDesktopSsrServer({ esbuild: { jsx: "automatic" } });
  try {
    const { draftFromRecord, draftToInput, mcpDraftError } = await server.ssrLoadModule(
      "/src/components/extensions/McpEditorSheet.tsx",
    );
    const record = {
      id: "slow-server",
      label: "Slow server",
      transport: "stdio",
      commandLabel: "npx",
      hasArgs: true, envKeys: ["LOCAL_KEY"], headerKeys: [],
      enabled: true,
      timeoutSeconds: 45,
    };

    const edited = draftFromRecord(record);
    assert.equal(draftToInput(edited).command, undefined);
    assert.equal(draftToInput(edited).args, undefined);
    assert.deepEqual(draftToInput(edited).env, {});
    assert.deepEqual(draftToInput(edited).keepEnvKeys, ["LOCAL_KEY"]);
    edited.env = [{ key: "LOCAL_KEY", value: "replacement-fixture" }];
    edited.args = "";
    assert.deepEqual(draftToInput(edited).env, { LOCAL_KEY: "replacement-fixture" });
    assert.deepEqual(draftToInput(edited).keepEnvKeys, []);
    assert.deepEqual(draftToInput(edited).args, []);
    assert.equal(edited.timeoutSeconds, "45");
    edited.timeoutSeconds = "";
    assert.equal(mcpDraftError(edited), null);
    assert.equal(draftToInput(edited).timeoutSeconds, null);

    edited.timeoutSeconds = "90";
    assert.equal(draftToInput(edited).timeoutSeconds, 90);
    edited.timeoutSeconds = "601";
    assert.equal(mcpDraftError(edited), "extensions.mcp.errorTimeoutRange");
  } finally {
    await server.close();
  }
});
