# hoist

A lightweight self-hosted PaaS for one Linux server: a single Bun executable that supervises a
pinned Caddy binary and the local Docker daemon. `git push` over SSH builds a Dockerfile into an
immutable, numbered release and cuts traffic over with a health check; rollbacks, config
snapshots, preview branches and a small password-protected dashboard sit on the same release
table. MIT. A smaller, owned alternative to Coolify, Dokploy and Levelrail, in the spirit of
Dokku. "Done" for v1 is every row marked v1 in `docs/PLAN.md` §4 passing the acceptance checks
in §10 on a fresh Ubuntu server and in GitHub Actions.

## Status

M0 in progress — harness, schema, adapter seams and CI. Draft PR: [#9](https://github.com/ContractorKeith/hoist/pull/9).

## Commands

```bash
bun install
bun run typecheck          # tsc --noEmit
bun run lint               # biome check .
bun run test               # bun test (unit; no Docker)
bun run test:e2e           # HOIST_E2E=1 bun test test/e2e (real Docker + Caddy)
bun run build              # bun build --compile src/cli/index.ts --outfile dist/hoist
```
Bare `bun test` skips the e2e scenario; `bun run test:e2e` enables it with `HOIST_E2E=1` and fails if Linux or Docker is unavailable.

## Pointers

- `docs/PLAN.md` — problem, feature matrix, architecture, data model, CLI contract,
  milestones, testing, acceptance.
- `CONTEXT.md` — glossary. Use its words in code, issues and PRs.
- `docs/adr/` — SSH is the only control plane; Bun single-file executable.
- Session logs: `~/Projects/worklog/projects/hoist.md` (not in this repo).

## Conventions & Gotchas

- On Omarchy, a shell missing the Docker group must run socket commands via `newgrp docker` on stdin; CI needs no wrapper.
- `src/core` depends only on the `DockerClient`, `CaddyAdmin` and `Store` interfaces and is
  tested on fakes. Adapters are thin and covered by e2e only.
- Everything from a pushed repo is untrusted: slugify branch names, validate health paths,
  clamp sizes before Docker, Caddy or the filesystem see them.
- One process. Caddy is a supervised child; the preview sweeper is a timer. No queue.
- Release rows are immutable. Rollback inserts; it never updates `image` or `config_json`.
- Dashboard is read-mostly: rollback and restart are its only actions. Everything else is CLI.
- Tooling is Bun, `tsc --noEmit`, Biome. No ESLint, Prettier, Vitest, or ORM.
- One milestone = one issue = one branch = one PR = one T3 thread in its own worktree. M0 lands
  alone; M3–M5 may run in parallel after M2; M6 after them; M7 last.
- A PR needs a completed green CI check and then a `skeptic-review` round before leaving draft.
  Skeptic findings become labelled issues.
- Commits: `<type>: <description>`, author @ContractorKeith only.

## Tracking

- GitHub issues are the tickets, one per milestone, label `milestone`.
- Basecamp project "github" (card table) has one card per milestone titled `hoist Mn: ...`
  linking the issue and the PLAN section. Move the card to In progress when the branch opens
  and to Done when the PR merges. Do not create per-issue cards.

## Out of Scope

- Multi-node, agents, gRPC, template marketplace, MCP server. Never.
- Buildpacks or framework presets, webhooks, one-click databases, API tokens, multiple users.
  After v1, if real demand shows.
