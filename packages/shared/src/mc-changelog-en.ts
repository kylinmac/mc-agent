import type { McReleaseNotes } from "./mc-changelog-types.js";

/**
 * English mirror of mc-changelog-zh-CN.ts (zh-CN is the source of truth).
 * Optional per version: a missing version falls back to the zh-CN entry.
 * When present, each category must have the same number of lines as zh-CN.
 * Plain release-note English: one line per change, what the user gets.
 * Type-only imports only (the release check runs this file with Node directly).
 */
export const mcEnEntries: McReleaseNotes[] = [
  {
    version: "1.0.23",
    date: "2026-10-26",
    highlights: [
      "With a Grok subscription signed in through your xAI account, the composer now shows the week's remaining quota (for example \"Week 94%\"); hover for the reset time.",
    ],
  },
  {
    version: "1.0.22",
    date: "2026-10-26",
    fixes: ["A window closed while maximized now reopens maximized, and restores to its previous size."],
  },
  {
    version: "1.0.21",
    date: "2026-10-26",
    features: ["See what changed on the first launch after an update. All versions are in Settings → About → Release notes."],
    fixes: ["The window reopens at its last size and position instead of shrinking to the right half when closed with the work panel open."],
  },
  {
    version: "1.0.20",
    date: "2026-10-26",
    features: [
      "Voice input: hold ⌘⇧Space (Ctrl+Shift+Space on Windows) to talk; your words are typed into the composer, not sent. Change or turn it off in Settings → Shortcuts.",
      "With a subscription account (ChatGPT/Codex, Claude, GitHub Copilot, Kimi, GLM, MiniMax), the composer shows your remaining quota. Hover for reset times.",
      "Project memory: the agent remembers your preferences, corrections and project rules for later conversations. Entries marked “AI” in the memory panel can be edited or deleted.",
      "Hooks (Settings → Agent → Hooks): run commands before or after tool calls or before the agent finishes, e.g. a format check after edits or tests before finishing.",
      "Subagents can start with the current conversation's context.",
    ],
    improvements: [
      "When a background command finishes, the agent picks up the result on its own.",
      "In Full auto mode, force-pushes, pushes to the main branch, merging PRs, releases, publishing packages, deleting files outside the project and sudo still ask first.",
    ],
    fixes: ["Remaining “PI-Desktop” labels now say “mc-agent”."],
  },
];
