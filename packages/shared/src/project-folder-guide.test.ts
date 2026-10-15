import { describe, expect, it } from "vitest";
import { projectFolderGuide } from "./project-folder-guide.js";

const roots = [
  { path: "/docs/App", kind: "resources" as const },
  { path: "/code/web" },
  { path: "/code/server" },
];
const notes = [
  { path: "/code/web", heading: "web", description: "前端，React + Vite" },
  { path: "/code/server/", heading: "server", description: "后端 Rust API\n提供 /login" },
];

describe("project folder guide", () => {
  it("is empty for a single-folder project", () => {
    expect(projectFolderGuide({ roots: [{ path: "/code/web" }], startPath: "/code/web" })).toBe("");
  });

  it("starts from the resource folder and describes every workspace", () => {
    expect(projectFolderGuide({ roots, startPath: "/docs/App", notes })).toBe(
      [
        "Project folders:",
        "- Start folder. Resource folder (project documents): /docs/App",
        '- Workspace "web": /code/web — 前端，React + Vite',
        '- Workspace "server": /code/server — 后端 Rust API 提供 /login',
        "Use an absolute path when reading or editing a folder other than the start folder.",
        "A workspace may have its own AGENTS.md; read it before changing files there.",
      ].join("\n"),
    );
  });

  it("names a workspace start folder and keeps the resource folder in the list", () => {
    const guide = projectFolderGuide({ roots, startPath: "/code/server/", notes });
    const lines = guide.split("\n");
    expect(lines[1]).toBe('- Start folder. Workspace "server": /code/server — 后端 Rust API 提供 /login');
    expect(lines[2]).toBe("- Resource folder (project documents): /docs/App");
    expect(lines[3]).toBe('- Workspace "web": /code/web — 前端，React + Vite');
  });

  it("works without descriptions or a resource folder, as upstream groups do", () => {
    const guide = projectFolderGuide({
      roots: [{ path: "/code/web" }, { path: "/code/server" }],
      startPath: "/code/web",
    });
    expect(guide).toContain('- Start folder. Workspace "web": /code/web\n');
    expect(guide).toContain('- Workspace "server": /code/server\n');
    expect(guide).not.toContain("Primary root");
  });

  it("still lists every folder when the start path is not one of them", () => {
    const guide = projectFolderGuide({ roots, startPath: "/elsewhere", notes });
    expect(guide.split("\n").slice(1, 5)).toEqual([
      "- Start folder: /elsewhere",
      "- Resource folder (project documents): /docs/App",
      '- Workspace "web": /code/web — 前端，React + Vite',
      '- Workspace "server": /code/server — 后端 Rust API 提供 /login',
    ]);
  });

  it("labels reference folders so they are not mistaken for code", () => {
    const guide = projectFolderGuide({
      roots: [...roots, { path: "/materials/brand", kind: "reference" }],
      startPath: "/docs/App",
      notes: [{ path: "/materials/brand", heading: "brand", description: "客户提供的品牌素材" }],
    });
    expect(guide).toContain('- Reference folder "brand": /materials/brand — 客户提供的品牌素材');
  });

  it("shortens long descriptions", () => {
    const guide = projectFolderGuide({
      roots,
      startPath: "/docs/App",
      notes: [{ path: "/code/web", description: "x".repeat(500) }],
    });
    const web = guide.split("\n").find((line) => line.includes("/code/web")) ?? "";
    expect(web.endsWith("…")).toBe(true);
    expect(web.length).toBeLessThan(340);
  });
});
