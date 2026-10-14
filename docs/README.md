# Documentation

Start with [mc-agent planning](mc-agent/README.md) for this fork's scope, current architecture and proposed changes.

The site and the remaining technical documents are inherited from PI-Desktop. Their downloads, support links, release status and maintainer workflows describe upstream, not mc-agent. Use AGENTS.md at the repository root for this fork's workflow. Treat inherited version numbers as historical; current code, types and tests establish implemented behavior.

`docs/` is a VitePress project. The published site starts at [`index.md`](index.md);
the inherited English technical specifications remain organized under
`spec/` and `adr/`.

## Local commands

```bash
pnpm docs:dev
pnpm docs:build
pnpm docs:preview
pnpm docs:check
```

## Layout notes

- `mc-agent/` contains this fork's plans and implementation maps.
- `spec/` and `adr/` document inherited contracts and decisions; `zh-CN/` mirrors
  `spec/` and `guide/` path for path and is checked by `pnpm docs:check`.
- `image/` holds pictures embedded by the repository READMEs. `public/` holds
  assets served by the site itself (brand mark, screenshots).
- `project/` keeps historical planning records; current status lives in the
  changelog and GitHub Issues.

## Entry points

- [English documentation site](index.md)
- [中文入口](zh-CN/index.md)
- [Quick guide](guide/index.md)
- [Specification index](spec/README.md)
- [ADR index](adr/README.md)
- [Plugin development](plugin-development.md)
- [Visual verification](project/2026-08-13-docs-redesign-verification.md)

The Chinese entry point mirrors the English reading paths and includes a
path-for-path companion for every specification. Each translated page links to
the canonical English source and preserves code, protocol fields, and
identifiers. The generated sidebar keeps both locale trees complete as the
specification set grows.

`check:locales` also checks the standalone plugin development guide's Chinese
mirror and canonical source notice. Its theme section must preserve the English
JSON/CSS examples and table structure. Other standalone guide sections are not
covered by that theme-contract comparison.
