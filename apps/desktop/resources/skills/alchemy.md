---
name: alchemy
description: Distill a working conversation, referenced project files, rules, or memory into a reusable user Skill or System Prompt Template via a confirmation card (`ProposeAlchemyArtifact`), using `mc://` dynamic references (`ResolveRef`) for living documents. Use when the user asks to turn a workflow, set of rules, or conversation into a reusable skill or prompt template ("提炼成技能", "炼成模板", "固化这套流程").
---

# Alchemy — distill reusable Skills & Prompt Templates

Turn a proven workflow, conversation, and referenced materials into **one reusable asset** — either a **Skill** (a procedure triggered on demand) or a **System Prompt Template** (a reusable persona, review standard, or conversation rule set).

Use the desktop's `ResolveRef` and `ProposeAlchemyArtifact` tools. If `ToolSearch` is available and they are not loaded yet, load them first with `ToolSearch`. They exist only in local sessions on this computer; `ProposeAlchemyArtifact` requires Agent mode.

## Flow

1. **Resolve materials first.** Never guess the contents of referenced files, project memory, or past sessions. Read them with `ResolveRef` (or `Read` / `ProjectHistory` / `ProjectResources`).
   Supported `mc://` URIs:
   - `mc://resource/<relativePath>` — file in the project's resource folder
   - `mc://workspace/<relativePath>` — file in the current workspace
   - `mc://prompt/<templateId>` — existing system prompt template
   - `mc://skill/<skillId>` — existing user skill
   - `mc://session/<sessionId>` — conversation in the same project
   - `mc://memory` — current project memory
2. **Fill only critical gaps.** Ask at most one compact clarifying question if the target form or output requirement is genuinely ambiguous; otherwise pick sensible defaults and note your assumptions.
3. **Choose the right artifact form:**
   - **Skill (`kind: "skill"`)**: best for a repeatable task or workflow ("next time I say X, do Y"). Write a clear `description` so the model triggers it accurately. Do NOT include YAML frontmatter in `body` — the host adds frontmatter automatically.
   - **System Prompt Template (`kind: "prompt-template"`)**: best for a reusable role, review checklist, or tone/architecture standard applied to whole conversations.
4. **Separate stable steps from living rules:**
   - Embed **stable** steps, output formats, and checklists directly in `body`.
   - Embed **living** documents (e.g., an evolving rule file or checklist in the project resource folder) as `mc://` references listed in `refs`, with an explicit instruction inside `body` to call `ResolveRef` before acting so future edits automatically take effect.
5. **Propose on a card (`ProposeAlchemyArtifact`).** Include a short `note` and a concrete `suggestedTrigger` one-liner. Never write skill files directly with `Write` or `Bash` — the card is the user's review and confirmation step.
6. **Act on the outcome:**
   - `saved`: briefly report what was saved, its `mc://` reference, and the one-liner to reuse it next time.
   - `revise`: apply the user's feedback and call `ProposeAlchemyArtifact` again.
   - `canceled`: acknowledge cleanly without retrying.
   - `failed`: report the error message and suggest how to fix it.
