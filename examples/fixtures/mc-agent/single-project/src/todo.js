import { readFileSync, writeFileSync, existsSync } from "node:fs";

const file = new URL("../todos.json", import.meta.url);

export function load() {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
}

export function save(items) {
  writeFileSync(file, JSON.stringify(items, null, 2));
}
