import assert from "node:assert/strict";
import test from "node:test";
import {
  chooseStartFolder,
  rememberedStartFolder,
  rememberStartFolder,
} from "../src/features/project-workbench/start-folder.ts";

const roots = [
  { path: "/docs/App", kind: "resources" },
  { path: "/code/web" },
  { path: "/code/server" },
];

function memoryStore() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

test("the remembered folder wins while it still belongs to the project", () => {
  assert.equal(chooseStartFolder(roots, "/docs/App", "/code/server/"), "/code/server");
  assert.equal(chooseStartFolder(roots, "/docs/App", "/code/gone"), "/docs/App");
  assert.equal(chooseStartFolder(roots, "/docs/App", null), "/docs/App");
});

test("the choice is remembered per project", () => {
  const store = memoryStore();
  rememberStartFolder("g1", "/code/web", store);
  rememberStartFolder("g2", "/other", store);
  assert.equal(rememberedStartFolder("g1", store), "/code/web");
  assert.equal(rememberedStartFolder("g3", store), null);
});

test("unavailable storage never throws", () => {
  const broken = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("full");
    },
  };
  assert.equal(rememberedStartFolder("g1", broken), null);
  assert.doesNotThrow(() => rememberStartFolder("g1", "/code/web", broken));
  assert.equal(rememberedStartFolder("g1", null), null);
});

test("a multi-folder sidebar project offers each folder, the remembered one selected (#41)", async () => {
  const { buildProjectFolderIndex } = await import("../src/features/project-sidebar/project-merge.ts");
  const { projectStartFolderChoices } = await import("../src/features/project-sidebar/start-folder-menu.ts");
  const normalize = (path) => path.replace(/\/+$/, "");
  const index = buildProjectFolderIndex(
    [
      {
        id: "g1",
        name: "App",
        roots: [
          { path: "/docs/App", kind: "resources" },
          { path: "/code/web", name: "web" },
          { path: "/code/server" },
        ],
      },
      { id: "g2", name: "Solo", roots: [{ path: "/code/solo" }] },
    ],
    normalize,
    "Resources",
  );
  const choices = projectStartFolderChoices(index, "/code/web", (groupId) =>
    groupId === "g1" ? "/code/server" : null,
  );
  assert.deepEqual(
    choices.map((choice) => [choice.path, choice.label, choice.selected]),
    [
      ["/docs/App", "Resources", false],
      ["/code/web", "web", false],
      ["/code/server", "server", true],
    ],
  );
  assert.equal(choices[0].groupId, "g1");
  // Nothing remembered: the project's first folder.
  assert.equal(projectStartFolderChoices(index, "/docs/App", () => null)[0].selected, true);
  // One folder, or an unknown folder: no menu.
  assert.deepEqual(projectStartFolderChoices(index, "/code/solo", () => null), []);
  assert.deepEqual(projectStartFolderChoices(index, "/elsewhere", () => null), []);
});

test("start-folder choices reach every new-task entry point (#41)", async () => {
  const { readFile } = await import("node:fs/promises");
  const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
  const sidebar = await read("../src/components/Sidebar.tsx");
  const workbench = await read("../src/features/project-workbench/ProjectWorkbench.tsx");
  const board = await read("../src/features/project-workbench/TaskBoard.tsx");
  const page = await read("../src/pages/ProjectsPage.tsx");
  // Sidebar "+": several folders open the start-folder menu, one starts at once.
  assert.match(sidebar, /projectStartFolderChoices\(projectFolderIndex, entry\.key, rememberedStartFolder\)\.length > 1/);
  assert.match(sidebar, /openProjectRowMenu\(entry\.key, event\.currentTarget, "startFolder"\)/);
  assert.match(sidebar, /rememberStartFolder\(choice\.groupId, choice\.path\);\s*void createProjectSession\(choice\.path\);/);
  // A pick in the workbench is remembered at once and offered on the task board.
  assert.match(workbench, /const pickStartFolder = \(path: string\) => \{\s*setStartFolder\(path\);\s*rememberStartFolder\(project\.groupId, path\);/);
  assert.match(workbench, /onStartFolderChange=\{pickStartFolder\}/);
  assert.match(board, /onChange=\{\(event\) => onStartFolderChange\(event\.target\.value\)\}/);
  // The projects page menu no longer starts in the first folder unconditionally.
  assert.doesNotMatch(page, /void startTask\(project\.path\);/);
});
