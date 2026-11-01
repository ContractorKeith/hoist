# hoist

A lightweight self-hosted PaaS for one Linux server: a single Bun executable that supervises a
pinned Caddy binary and the local Docker daemon. `git push` over SSH builds a Dockerfile into an
immutable, numbered release and cuts traffic over with a health check; rollbacks, config
snapshots, preview branches and a small password-protected dashboard sit on the same release
table. MIT. A smaller, owned alternative to Coolify, Dokploy and Levelrail, in the spirit of
Dokku. "Done" for v1 is every row marked v1 in `docs/PLAN.md` §4 passing the acceptance checks
in §10 on a fresh Ubuntu server and in GitHub Actions.

## Status

M0 done — 2026-11-01 (#9): toolchain, schema, adapter seams, e2e harness, CI. M1 done —
2026-11-01 (#14): HOIST_DIR layout, apps verbs, SSH forced-command dispatch, pre-receive hook
building `hoist/<app>:<slug>-v<n>-<sha12>` into a `built` release, migration 2, user-mode sshd
e2e. M2 (cutover, Caddy routes, TLS, boot reconcile) in progress.

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

- Closing the terminal mid-push does not cancel the deploy; the release still lands server-side.
- `HOIST_DIR` (default `/var/lib/hoist`) holds the private database, bare repos, temporary checkouts and release logs; `HOIST_DOMAIN` supplies the default base domain until M7.
- Docker containers use `Tty: true`: logs are plain bytes with CRLF line endings and stderr merged into stdout; M4 strips `\r`.
- The generated pre-receive hook hard-codes the executable path at `apps:create` time; M7 `doctor` will rewrite hooks.
- Bare repos install a tiny executable `pre-receive` hook that execs `hoist git-hook pre-receive <app>`; pushed values never reach a shell.
- On Omarchy, a shell missing the Docker group must run socket commands via `newgrp docker` on stdin; CI needs no wrapper.
- `src/core` depends only on the `DockerClient`, `CaddyAdmin` and `Store` interfaces and is
  tested on fakes. Adapters are thin and covered by e2e only.
- Everything from a pushed repo is untrusted: slugify branch names, validate health paths,
  clamp sizes before Docker, Caddy or the filesystem see them.
- One process. Caddy is a supervised child; the preview sweeper is a timer. No queue.
- A release's `image` and `config_json` are immutable (trigger); `status` and `container_id`
  change during cutover. Delete is governed by retention (M3).
- Dashboard is read-mostly: rollback and restart are its only actions. Everything else is CLI.
- Tooling is Bun, `tsc --noEmit`, Biome. No ESLint, Prettier, Vitest, or ORM.
- One milestone = one issue = one branch = one PR = one T3 thread in its own worktree. M0 lands
  alone; M3–M5 may run in parallel after M2; M6 after them; M7 last.
- A PR needs a completed green CI check and then a `skeptic-review` round before leaving draft.
  Skeptic findings become labelled issues.
- Commits: `<type>: <description>`, author @ContractorKeith only.

## Tracking
- GitHub issues are the tickets, one per milestone, label `milestone`; `skeptic` for review findings.
- Basecamp project "github" (card table) has ONE card titled `hoist` with one step per
  milestone (`project-board` skill). Complete the step when the milestone PR merges; update
  "Next:" in the body. No per-milestone cards.
- Per PR: author's done-when → orchestrator full-diff read and rerun → `pr-attack` by a fresh
  thread → fixes → one PR comment → `gh pr ready` → merge commit. `skeptic-review` is the
  release gate before a tag, not a per-PR step.

## Out of Scope

- Multi-node, agents, gRPC, template marketplace, MCP server. Never.
- Buildpacks or framework presets, webhooks, one-click databases, API tokens, multiple users.
  After v1, if real demand shows.
