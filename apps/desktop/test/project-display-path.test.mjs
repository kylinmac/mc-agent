import assert from "node:assert/strict";
import test from "node:test";
import { projectDisplayPath } from "../src/features/project-workbench/display-path.ts";

test("a project row shows its first workspace, not its resource folder", () => {
  assert.equal(
    projectDisplayPath({
      path: "/docs/mc-agent/projects/App",
      roots: [{ path: "/docs/mc-agent/projects/App", kind: "resources" }, { path: "/code/web" }, { path: "/code/server" }],
    }),
    "/code/web",
  );
  assert.equal(projectDisplayPath({ path: "/code/web", roots: [{ path: "/code/web" }] }), "/code/web");
  assert.equal(
    projectDisplayPath({ path: "/docs/x", roots: [{ path: "/docs/x", kind: "resources" }] }),
    "/docs/x",
  );
});
