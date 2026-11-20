import { describe, expect, it } from "vitest";
import { workspaceArtifactGuide } from "./mc-workspace-guide.js";

describe("workspaceArtifactGuide", () => {
  it("returns empty string when no workspace path is provided", () => {
    expect(workspaceArtifactGuide({})).toBe("");
    expect(workspaceArtifactGuide({ workspacePath: "   " })).toBe("");
  });

  it("guides single-workspace sessions to stay inside the workspace and mention work-panel tabs", () => {
    const guide = workspaceArtifactGuide({ workspacePath: "/code/app" });
    expect(guide).toContain("/code/app");
    expect(guide).toContain("/tmp");
    expect(guide).toContain("Files, Changes");
    expect(guide).toContain("Canvas");
  });

  it("mentions distinct project resource folder when provided", () => {
    const guide = workspaceArtifactGuide({
      workspacePath: "/code/app",
      resourcePath: "/docs/app-resources",
    });
    expect(guide).toContain("/code/app");
    expect(guide).toContain("/docs/app-resources");
  });

  it("omits local-only canvas/terminal hints for remote sessions", () => {
    const guide = workspaceArtifactGuide({ workspacePath: "/srv/app", remote: true });
    expect(guide).toContain("/srv/app");
    expect(guide).not.toContain("Excalidraw");
  });
});
