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
      command: "npx",
      enabled: true,
      timeoutSeconds: 45,
    };

    const edited = draftFromRecord(record);
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
