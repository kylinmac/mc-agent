import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [dialog, picker, slice, workbench, ipc] = await Promise.all([
  read("../src/components/ProjectCreateDialog.tsx"),
  read("../src/features/project-workbench/ProjectKindPicker.tsx"),
  read("../src/stores/slices/project-slice.ts"),
  read("../src/features/project-workbench/ProjectWorkbench.tsx"),
  read("../electron/main/ipc/project-resources-ipc.ts"),
]);

test("the create dialog offers chat, simple and managed, defaulting to simple", () => {
  assert.match(dialog, /useState<ProjectKind>\("simple"\)/);
  assert.match(dialog, /<ProjectKindPicker/);
  for (const kind of ["chat", "simple", "managed"]) {
    assert.match(picker, new RegExp(`value: "${kind}"`));
  }
  // Chat leaves the dialog for a session outside any project.
  assert.match(dialog, /newSession\(\{ projectPath: null \}\)/);
  // Only a managed project passes a template; remote projects cannot.
  assert.match(dialog, /template: kind === "managed" \? template : undefined/);
  assert.match(picker, /option\.value === "managed" && remote/);
});

test("only a managed project gets a resource folder at creation", () => {
  assert.match(slice, /const withResources = template\s*\? await api/);
});

test("simple projects are never backfilled; conversion and detach are explicit", () => {
  assert.doesNotMatch(workbench, /api\.ensureProjectResources\(project\.groupId\)/);
  assert.match(workbench, /<ConvertToManaged/);
  assert.match(workbench, /api\.detachProjectResources\(project\.groupId\)/);
  assert.match(workbench, /window\.confirm\(t\("mcProject\.detachConfirm"\)\)/);
  assert.match(ipc, /host\.call\("project\.resources\.home\.detach", \{ groupId \}\)/);
});
