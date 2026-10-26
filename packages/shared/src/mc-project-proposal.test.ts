import { describe, expect, it } from "vitest";
import {
  isValidProjectFolderName,
  joinProjectPath,
  normalizeProjectProposalArgs,
} from "./mc-project-proposal.js";

const HOME = "/Users/me";

describe("CreateProject arguments", () => {
  it("expands ~ and keeps the ranked templates in order", () => {
    const parsed = normalizeProjectProposalArgs(
      { name: " 记账小程序 ", parent: "~/code/", folder: "ledger-miniapp", templates: ["app", "software", "app"] },
      HOME,
    );
    expect(parsed).toEqual({
      ok: true,
      value: { name: "记账小程序", parent: "/Users/me/code", folder: "ledger-miniapp", templates: ["app", "software"] },
    });
  });

  it("accepts a drafted template and normalizes its folders", () => {
    const parsed = normalizeProjectProposalArgs(
      {
        name: "Explainer",
        parent: "/Users/me/Videos",
        folder: "explain",
        draft: {
          name: "video",
          description: "Knowledge videos",
          folders: [
            { path: "topics/", description: "Ideas" },
            { path: "assets/voice", description: "Takes" },
          ],
          systemPrompt: "Write for voice-over.",
        },
      },
      HOME,
    );
    expect(parsed.ok && parsed.value.draft?.folders.map((folder) => folder.path)).toEqual([
      "topics",
      "assets/voice",
    ]);
  });

  it("refuses what the card could not show or create", () => {
    const bad = [
      { parent: "/tmp", folder: "x" },
      { name: "x", parent: "relative/path", folder: "x" },
      { name: "x", parent: "/tmp", folder: "a/b" },
      { name: "x", parent: "/tmp", folder: ".." },
      { name: "x", parent: "/tmp", folder: "x", templates: ["a", "b", "c", "d"] },
      { name: "x", parent: "/tmp", folder: "x", draft: { name: "v", description: "", folders: [] } },
      { name: "x", parent: "/tmp", folder: "x", draft: { name: "v", description: "", folders: [{ path: "../up", description: "" }] } },
      { name: "x", parent: "/tmp", folder: "x", draft: { name: "v", description: "", folders: [{ path: "a", description: "two\nlines" }] } },
    ];
    for (const args of bad) expect(normalizeProjectProposalArgs(args, HOME).ok).toBe(false);
  });

  it("accepts Windows parents", () => {
    const parsed = normalizeProjectProposalArgs({ name: "x", parent: "C:\\code", folder: "app" }, "C:\\Users\\me");
    expect(parsed.ok && joinProjectPath(parsed.value.parent, parsed.value.folder)).toBe("C:\\code\\app");
  });
});

describe("project folder names", () => {
  it("allows one plain name", () => {
    expect(isValidProjectFolderName("ledger-miniapp")).toBe(true);
    expect(isValidProjectFolderName("记账")).toBe(true);
    for (const name of ["", ".", "..", "a/b", "a\\b", "a:b", " lead", "q?"]) {
      expect(isValidProjectFolderName(name)).toBe(false);
    }
  });
});
