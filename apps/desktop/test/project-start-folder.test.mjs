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
