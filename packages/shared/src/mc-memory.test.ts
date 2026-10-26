import { describe, expect, it } from "vitest";
import {
  PROJECT_MEMORY_INLINE_BUDGET,
  composeMemoryPrompt,
  memoryForReview,
  resolveMemorySuggestion,
} from "./mc-memory.js";
import type { ProjectMemoryEntry } from "./types/filesystem.js";

const note = (id: string, extra: Partial<ProjectMemoryEntry> = {}): ProjectMemoryEntry => ({
  id,
  title: `Title ${id}`,
  content: `Content of ${id}`,
  ...extra,
});

describe("memory prompt", () => {
  it("inlines small memories, leaves suggestions out, and adds the user's notes", () => {
    const prompt = composeMemoryPrompt({
      projectEntries: [note("a", { kind: "feedback" }), note("b", { pending: { reason: "x" } })],
      userEntries: [note("u1", { kind: "user" })],
    })!;
    expect(prompt).toContain("## This project");
    expect(prompt).toContain("### Title a (feedback)\n\nContent of a");
    expect(prompt).not.toContain("Content of b");
    expect(prompt).toContain("## About the user (all projects)");
    expect(prompt).not.toContain("Recall");
  });

  it("indexes a memory past its budget and points at Recall", () => {
    const big = Array.from({ length: 20 }, (_, i) =>
      note(`n${i}`, { hook: `hook ${i}`, content: "x".repeat(PROJECT_MEMORY_INLINE_BUDGET / 10) }),
    );
    const prompt = composeMemoryPrompt({ projectEntries: big })!;
    expect(prompt).toContain("- [n3] Title n3 — hook 3");
    expect(prompt).not.toContain("x".repeat(100));
    expect(prompt).toContain("`Recall`");
  });

  it("keeps a legacy single block and returns nothing when there is nothing", () => {
    expect(composeMemoryPrompt({ legacyContent: "Old notes" })).toContain("Old notes");
    expect(composeMemoryPrompt({ projectEntries: [], userEntries: [] })).toBeUndefined();
  });

  it("marks which notes a review may change", () => {
    const listing = memoryForReview([
      { scope: "project", entries: [note("agent-1"), note("mine")], editable: (entry) => entry.id.startsWith("agent-") },
    ]);
    expect(listing).toContain("[agent-1] (project, editable)");
    expect(listing).toContain("[mine] (project, user's own)");
  });
});

describe("answering a suggestion", () => {
  const base = [note("agent-1", { title: "Tests", content: "old" }), note("u")];
  it("keeps an addition as a note", () => {
    const next = resolveMemorySuggestion([...base, note("s", { pending: {} })], "s", true, 5);
    expect(next.at(-1)).toEqual({ ...note("s"), updatedAt: 5 });
  });
  it("rewrites the note an update names, keeping its id", () => {
    const next = resolveMemorySuggestion(
      [...base, note("s", { title: "Tests", content: "new", kind: "feedback", pending: { replaces: "agent-1" } })],
      "s",
      true,
      7,
    );
    expect(next).toHaveLength(2);
    expect(next[0]).toMatchObject({ id: "agent-1", content: "new", kind: "feedback", updatedAt: 7 });
  });
  it("removes a note when a removal is kept, and only drops the suggestion when declined", () => {
    const removal = [...base, note("s", { pending: { replaces: "agent-1", remove: true } })];
    expect(resolveMemorySuggestion(removal, "s", true).map((entry) => entry.id)).toEqual(["u"]);
    expect(resolveMemorySuggestion(removal, "s", false).map((entry) => entry.id)).toEqual(["agent-1", "u"]);
  });
});
