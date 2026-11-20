---
name: programmatic-tools
description: Batch, loop, filter, or aggregate 3+ read-only tool calls in a single sandboxed JavaScript snippet (`RunScript`) so intermediate outputs stay out of the conversation context. Use when scanning many files, checking multiple project resources/history sessions, or aggregating large read-only results.
---

# Programmatic read-only tool batching (`RunScript`)

When a task needs **3 or more read-only tool calls, a loop, or filtering/aggregating large results** (for example: scanning 20+ files for a pattern, checking multiple `ProjectHistory` conversations, or cross-referencing `ProjectResources` and `ResolveRef`), prefer `RunScript` instead of emitting dozens of separate tool calls.

If `ToolSearch` is available and `RunScript` is not loaded yet, load it first with `ToolSearch`.

## Available inside `RunScript`

- `await callTool(name, args)` — invoke an allowlisted **read-only** tool (`Read`, `Glob`, `Grep`, `CanvasRead`, `WorkPanelList`, `WorkPanelRead`, `ContextHistory`, `ProjectHistory`, `ProjectTemplates`, `ResolveRef`, and read-only actions of `ProjectTasks` / `ProjectResources`).
- `await listTools()` — discover which read-only tools are available in the current session and their schemas.
- `console.log(...)` — emit the final concise summary. Only your console output returns to the conversation.

## Rules

1. **Do NOT wrap a single tool call in `RunScript`.** Call the tool directly when there is nothing to loop or aggregate.
2. **Filter and summarize in code.** Keep raw file contents in script memory and print only matched items, counts, or short excerpts.
3. **Mutating, shell, delegation, and interactive tools are blocked** inside `RunScript` (`Write`, `Edit`, `Bash`, `Task`, `AskUserQuestion`, `CreateProject`, `ProposeAlchemyArtifact`, etc.). Gather and filter your findings with `RunScript`, then perform any edits or interactive steps directly in the main loop.
