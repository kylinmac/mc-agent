# mc-agent sample projects

Minimal fixtures for the mc-agent project-management scenarios
(`docs/mc-agent/validation-plan.md`, S1–S3). They are not git repositories;
tests that need git (worktrees, branches) copy a fixture to a temporary
directory and run `git init` there.

| Fixture | Shape | Used for |
| --- | --- | --- |
| `split-project/` | Two equal workspaces, `web/` and `server/`, each with its own `AGENTS.md` | R1 equal workspaces, start directory, Worker dispatch, per-workspace `AGENTS.md` |
| `single-project/` | One workspace with scattered docs | Single-workspace baseline, R5 template migration |
