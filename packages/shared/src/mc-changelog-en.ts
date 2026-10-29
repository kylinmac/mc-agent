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
    version: "1.0.29",
    date: "2026-10-28",
    fixes: [
      "After the Grok subscription's weekly quota resets, the quota chip in the composer no longer disappears; it shows \"Week 100%\".",
    ],
  },
  {
    version: "1.0.28",
    date: "2026-10-28",
    features: [
      "Settings → System prompts has new Append prompts: their text is added after the existing system prompt and never replaces a template or the default; turn each on or off and reorder them, and they apply to every conversation.",
    ],
  },
  {
    version: "1.0.27",
    date: "2026-10-28",
    features: [
      "The session work panel has a new Canvas: ask the Agent to draw prototypes, screens, or side-by-side options, and click through the boards directly.",
      "Select an element on a board or leave a comment for the Agent, and it knows exactly which button or text you mean; it replies in the comment when done.",
      "Restore a board the Agent changed to its previous version in one click; when a board breaks, click \"Ask the agent to fix\".",
      "Export a canvas as one HTML file that others can open in a browser, with boards still clickable.",
    ],
    improvements: [
      "The Codex tab of the import dialog explains that only sessions stored on this computer can be imported; cloud chats and ChatGPT projects from ChatGPT on the web or the desktop app's Chat / Work are not local. It also says when only the newest Codex sessions were scanned.",
    ],
    fixes: [
      "Importing from Codex no longer misses conversations started in the Codex desktop app or IDE extension: their messages carry editor context first and were skipped as injected text, so sessions without a title disappeared. The real request after \"My request for Codex\" is now used for the title and content.",
      "Importing from Codex also lists archived sessions (~/.codex/archived_sessions) and honors a Codex folder set with CODEX_HOME.",
    ],
  },
  {
    version: "1.0.26",
    date: "2026-10-27",
    improvements: [
      "In a project with several folders, the sidebar \"+\" asks whether the new task starts in the resource folder or a workspace, with the last choice selected.",
      "The project workbench's task list lets you pick the folder tasks run in; a folder picked in the workbench is also used by the \"New task\" button and the project menu.",
    ],
    fixes: [
      "In a question card, after choosing \"Enter another answer\", Enter submits (or moves to the next question) and Shift+Enter adds a line; confirming an input-method candidate no longer submits.",
      "With an MCP server connected, the session info panel no longer shows 0 MCP tools.",
    ],
  },
  {
    version: "1.0.25",
    date: "2026-10-27",
    features: [
      "Import conversations from Hermes Agent, including every Hermes profile, with text and tool history; a conversation Hermes continued after compressing its context imports as one.",
    ],
  },
  {
    version: "1.0.23",
    date: "2026-10-26",
    features: [
      "With a Grok subscription signed in through your xAI account, the composer shows the week's remaining quota (for example \"Week 94%\"); hover for the reset time.",
    ],
    improvements: [
      "Release notes are grouped into New / Improved / Fixed, in shorter plain sentences.",
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
