# hoist — Build Plan

Status: planned, no code yet (2026-11-01). Written after a scope grill and a read of
[glincker/levelrail](https://github.com/glincker/levelrail) (Go, Apache-2.0, multi-node),
[Dokku](https://dokku.com/) (bash, MIT, single server) and the Coolify/Dokploy feature sets.
Glossary: `CONTEXT.md`. Decisions that are hard to reverse: `docs/adr/`.

## 1. Problem

Running a few web apps on one rented Linux box still means hand-writing systemd units, Caddy
blocks, deploy scripts and a rollback story, or adopting a platform (Coolify, Dokploy,
Levelrail) whose multi-node, template and integration surface is far bigger than one person
needs. Dokku has the right size but is bash and has no dashboard. The gap is a tool you install
with one command, push to with `git push`, and own outright.

## 2. Solution

`hoist` is one Bun executable on one server. It supervises a pinned Caddy binary and talks to the
local Docker daemon. You create an app, add a git remote, push a repo that has a Dockerfile, and
hoist builds the image, starts it, health-checks it, points Caddy at it over HTTPS, and stops the
previous container. Every push is an immutable, numbered release. Rollback is one command. Any
non-main branch becomes a preview at its own subdomain. A small password-protected dashboard
shows apps, releases, logs and config, and can roll back or restart. MIT.

v1 is done when every row marked **v1** in §4 passes the acceptance checks in §10 on a fresh
Ubuntu LTS server and in GitHub Actions.

## 3. User stories

1. As the owner, I run one `curl | sh` on a fresh server and get a working hoist with Caddy, git,
   a `hoist` system user, a systemd unit, and a prompt for the dashboard password and base domain.
2. As the owner, I run `hoist apps:create blog` and get a git remote and the URL
   `blog.<domain>` reserved before any code is pushed.
3. As the owner, I `git push hoist main` and watch the build and deploy log stream back in the
   push output. The push exits non-zero if the build or health check fails.
4. As the owner, I `hoist config:set blog DATABASE_URL=...` and the next deploy runs with it. A
   rollback runs with the config that was live at that release, not the current one.
5. As the owner, I `hoist rollback blog v3` and the previous image and config take traffic with no
   dropped requests. The release list shows v5 pointing at v3.
6. As the owner, I `hoist logs blog -f` and see the live container output, and
   `hoist logs blog --release v4` to read the build log of a failed push after the fact.
7. As the owner, I push `feature-x` and get `feature-x.blog.<domain>` with its own release chain.
   Deleting the branch on the remote tears it down. A preview nobody pushes to for 7 days is
   swept.
8. As the owner, I open `hoist.<domain>` on my phone, log in, see every app's current release
   and health, tail logs, and press Rollback or Restart.
9. As the owner, I `hoist apps:destroy blog` and the containers, images, Caddy routes, git repo and
   rows are gone, with a confirmation prompt.
10. As a maintainer, I run one command locally and get the same push-build-serve e2e test that
    gates every PR, against a real Docker daemon and a real Caddy on a high port.

## 4. Feature matrix

**v1** = in scope now. **Later** = after v1. **Drop** = deliberately never.

| # | Feature | Decision | Milestone | Notes |
|---|---|---|---|---|
| 1 | SQLite schema: apps, releases, config, previews, sessions | v1 | M0 | `bun:sqlite`, WAL, migrations in-binary |
| 2 | `DockerClient` and `CaddyAdmin` adapter interfaces with in-memory fakes | v1 | M0 | The only two seams that touch the outside |
| 3 | e2e harness: temp data dir, real Docker, real Caddy on high port, sample app repo | v1 | M0 | Runs locally and in GitHub Actions |
| 4 | CI: `tsc --noEmit`, Biome, `bun test`, e2e | v1 | M0 | Required check on every PR |
| 5 | `apps:create`, `apps:list`, `apps:destroy` | v1 | M1 | Explicit create only; destroy prompts |
| 6 | SSH forced command dispatching `git-receive-pack` and CLI verbs | v1 | M1 | One `authorized_keys` line per key, `command="hoist ssh-dispatch"` |
| 7 | `pre-receive` builds Dockerfile into `hoist/<app>:<slug>-v<number>-<sha12>` and streams the log to the pusher | v1 | M1 | Dockerfile only; build log saved per release |
| 8 | Release row written on successful build: number, image, sha, branch, config snapshot | v1 | M1 | Immutable; see CONTEXT.md |
| 9 | Cutover: start new container, health check, swap Caddy upstream, stop old | v1 | M2 | Default `GET /`, 2xx only (reject redirects to catch misconfigured paths), 30 s timeout, configurable path |
| 10 | Caddy supervised by hoist; routes written via admin API; Let's Encrypt on by default | v1 | M2 | Internal CA when `HOIST_TLS=internal` (tests) |
| 11 | `config:set`, `config:unset`, `config:list` with masked values | v1 | M3 | Encrypted at rest with a key in the data dir |
| 12 | `rollback <app> [vN]` creates a new release from an old image + config snapshot | v1 | M3 | Defaults to previous release |
| 13 | Image retention: keep last 5 releases per app, prune after deploy | v1 | M3 | `hoist apps:set blog retention=10` |
| 14 | `logs <app> [-f] [--release vN]` | v1 | M4 | Live from Docker; build and deploy log from disk |
| 15 | Per-release log files on disk, pruned with the release | v1 | M4 | |
| 16 | Previews: non-main branch push → `<branch>.<app>.<domain>` | v1 | M5 | Branch name slugified; inherits app config |
| 17 | Preview teardown on branch delete push and 7-day idle TTL sweeper | v1 | M5 | Sweeper runs hourly inside the main process |
| 18 | Dashboard: login, apps, releases, live logs, masked config, previews | v1 | M6 | Server-rendered HTML + htmx; SSE for log tail |
| 19 | Dashboard actions: rollback, restart | v1 | M6 | Nothing else; create and config stay on the CLI |
| 20 | Installer script, systemd unit, `hoist doctor`, `hoist version` | v1 | M7 | Pins Caddy and installs git |
| 21 | Client CLI: thin wrapper that runs `ssh hoist@<server> hoist <verb>` | v1 | M7 | Published as `@contractorkeith/hoist` |
| 22 | `v0.1.0` release: Linux amd64 and arm64 binaries, checksums | v1 | M7 | |
| 23 | Buildpack or Bun/Node preset when no Dockerfile | Later | | Add when demand is real |
| 24 | Webhook deploys from GitHub/GitLab | Later | | SSH push is the v1 control plane (ADR-0001) |
| 25 | Postgres / Redis one-click services | Later | | Compose sidecar per app is the likely shape |
| 26 | Multiple users, API tokens, HTTPS API | Later | | ADR-0001 |
| 27 | Multi-node, agents, gRPC | Drop | | Levelrail's job |
| 28 | Template marketplace, MCP server | Drop | | |

## 5. Architecture

```
src/cli/          verb parser and command handlers; runs server-side via ssh-dispatch
src/core/         app, release, config, preview, cutover logic; depends only on adapter interfaces
src/adapters/     docker.ts (Docker Engine API over unix socket), caddy.ts (admin API), fakes/
src/store/        bun:sqlite schema, migrations, repositories
src/git/          bare repo management, pre-receive hook, ssh-dispatch
src/web/          dashboard: routes, templates, htmx partials, SSE log tail, sessions
src/server.ts     process entry: migrations, Caddy supervisor, sweeper, web listener
test/e2e/         harness and scenarios (push, cutover, rollback, preview, dashboard)
test/fixtures/    sample Dockerfile app
install.sh        installer; systemd/hoist.service
docs/PLAN.md      this file
```

Rules that hold the shape:

- `src/core` imports nothing from `adapters`, `store` implementations, `git` or `web`. It receives
  a `DockerClient`, a `CaddyAdmin` and a `Store` and is tested entirely on fakes.
- `src/adapters` are thin. No business logic, no retries beyond what the API needs. They are
  covered only by e2e.
- One process. Caddy is a child process supervised by `server.ts`; the sweeper is a timer. No
  queue, no worker pool.
- Caddy runs on the host, so containers publish their app port to a loopback-only host port and
  Caddy dials `127.0.0.1:<port>`. Nothing is published on a non-loopback interface.
- Pre-receive cutover rechecks the expected old branch tip because Git commits refs only after the hook succeeds; this preserves non-zero push results on health failure.
- Every value from a pushed repo (branch name, Dockerfile output, health path) is untrusted.
  Slugify, clamp and validate before it reaches Docker, Caddy or a filename.

## 6. Data model

```
apps        id, name (unique), domain, health_path, retention, main_branch (nullable; default main), created_at
releases    id, app_id, branch, number, git_sha, image, config_json (encrypted), status
            (building|built|live|stopped|failed), container_id, created_at, pruned_at (nullable)
config      app_id, key, value (encrypted)       -- current config; snapshotted into releases
previews    app_id, branch, slug, last_push_at    -- current release is the newest live release
                                                   for (app_id, branch)
sessions    token_hash, expires_at
locks       name (primary key), owner_pid, heartbeat_at, acquired_at, child_pid (nullable)
```

`HOIST_DIR/secret.key` holds the generated 32-byte AES-256-GCM key with mode 0600.
Config values use `v1:<iv>:<ciphertext>` with base64 fields and a random 12-byte IV.
AES-GCM additional data binds each value to `${app_id}:${key}`, including snapshot entries.
Back up the key with the database. `pruned_at` records retention processing without changing
status; failed rows retain their log directories. Rollback checks image existence rather
than `pruned_at`, since retained releases may share an image tag.

`number` is per `(app_id, branch)`; image tags are `hoist/<app>:<branch-slug>-v<number>-<sha12>`, unique to each release. Main-branch releases are `v1, v2, ...`; a preview has its own
`v1, v2, ...`. Rollback inserts a new row copying `image` and `config_json` from the target.

## 7. CLI contract

Server-side verbs, Dokku style. Every verb takes `--json` where it prints data.

```
hoist apps:create <name> [--domain <fqdn>] [--health-path </path>]
hoist apps:list | apps:info <name> | apps:destroy <name> [--force] | apps:set <name> k=v
hoist config:set <name> K=V [K=V...] | config:unset <name> K | config:list <name> [--reveal]
hoist releases <name> [--branch <b>]
hoist rollback <name> [vN]
hoist restart <name>
hoist logs <name> [-f] [--release vN] [--branch <b>] [-n <lines>]
hoist previews:list <name> | previews:destroy <name> <branch>
hoist doctor | version
hoist ssh-dispatch            # internal: authorized_keys forced command
hoist serve                   # internal: systemd entry
```

Client CLI: `hoist` with `HOIST_HOST` or `--host` runs `ssh hoist@<host> hoist <args>`; nothing
else. Git remote: `hoist@<host>:<app>`.

## 8. Milestones

Each milestone is one GitHub issue, one branch, one PR, one T3 worker thread in its own
worktree. Each ends with the e2e suite asserting one more thing. M0 lands alone before any
fan-out; M1 and M2 are sequential; M3, M4 and M5 may run in parallel after M2; M6 after M3–M5;
M7 last.

| M | Delivers | e2e asserts |
|---|---|---|
| M0 | schema, adapter interfaces + fakes, harness, CI | harness boots real Docker and Caddy and tears down |
| M1 | apps:create, SSH dispatch, pre-receive build, release row | push builds an image and records release v1 |
| M2 | cutover, Caddy routes, TLS | `curl https://app.test:PORT` returns the app; second push swaps with zero failed requests |
| M3 | config, rollback, retention | rollback serves old image with old config; 6th push prunes v1 |
| M4 | logs live and per-release | failed build's log is readable after the push returns |
| M5 | previews, teardown, TTL | branch push serves at subdomain; branch delete removes it; clock jump sweeps |
| M6 | dashboard read + rollback/restart | login, see releases, press rollback, traffic moves |
| M7 | installer, client CLI, doctor, v0.1.0 | fresh container runs install.sh and passes doctor |

## 9. Testing

- **Unit** (`bun test`): everything in `src/core`, `src/store`, `src/cli` parsing and
  `src/web` templates, against the in-memory fakes and a temp SQLite file. No Docker needed.
- **e2e** (`bun test test/e2e`): one harness per run. Temp data dir, `HOIST_TLS=internal`, Caddy on
  a random high port, Docker socket from the environment, sample app from `test/fixtures`.
  Pushes go over a local `ssh` to a throwaway key and `authorized_keys`, so the forced-command
  path is the real one. Each scenario asserts over HTTP with `Host:` headers, no DNS.
- **CI**: GitHub Actions `ubuntu-latest` runs typecheck, Biome, unit, e2e. A PR needs a completed
  green check before it leaves draft, then a `skeptic-review` round in its own worktree. Skeptic
  findings become labelled issues.
- **Adapters** have no unit tests by design. If a bug lands in `docker.ts` or `caddy.ts`, the fix
  comes with an e2e scenario.

## 10. Acceptance (v1)

On a fresh Ubuntu 24.04 VM with a public IP and a wildcard DNS record:

1. `curl -fsSL .../install.sh | sh` finishes, `hoist doctor` is clean, `hoist.<domain>` serves the
   login page over a Let's Encrypt certificate.
2. `apps:create`, push, HTTPS response from `<app>.<domain>` within 2 minutes for the fixture app.
3. Second push: a `while true; do curl; done` loop during cutover logs zero non-200 responses.
4. `config:set`, push, `rollback`: the app reports the old config value.
5. Push a branch: preview serves. Delete the branch: preview is gone within 10 seconds.
6. Dashboard rollback moves traffic; `releases` shows the new row.
7. `apps:destroy` leaves no container, image, route, repo or row behind (`hoist doctor` confirms).
8. Reboot the server: every live release is back without intervention.

## 11. Open questions

- Health check for apps that do not serve `/` at all: `--health-path` covers it, but should a
  TCP-connect fallback exist? Default no until a real app needs it.
- Where the client CLI gets its `ssh` options (port, identity). Default: whatever `~/.ssh/config`
  says for the host. Revisit at M7.
