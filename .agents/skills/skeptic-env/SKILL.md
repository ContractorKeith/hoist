---
name: skeptic-env
description: "How a skeptical reviewer builds, runs, seeds and attacks hoist. Read by the skeptic-review skill; not a workflow on its own."
---

# skeptic-env — hoist

A single Bun executable that runs one Linux server as a PaaS: Docker runtime, pinned Caddy
supervised by hoist, `git push` over SSH into immutable numbered releases, rollback, config
snapshots, preview branches, a small dashboard. "Done" for v1 is every v1 row in
`docs/PLAN.md` §4 passing the acceptance in §10 on a fresh Ubuntu server and in CI.

## Stack and commands

```bash
export TMPDIR=$PWD/.tmp; mkdir -p .tmp
bun install --frozen-lockfile
bun run typecheck                     # tsc --noEmit
bun run lint                          # biome check .   (exactly as CI)
bun test                              # unit; no Docker
echo "flock /home/contractorkeith/.t3/worktrees/hoist/hoist-e2e.lock bun run test:e2e" | newgrp docker
# Full e2e takes about 15 minutes. The lock is mandatory.
bun run build && ./dist/hoist version # bun build --compile -> dist/hoist
```

Docker: this box's login session is not in the `docker` group even though the user is.
Anything that touches the socket runs under `newgrp docker` on stdin, as above. `sg` and
passwordless sudo are not available. Running `HOIST_E2E=1 bun test test/e2e` without
`newgrp` must FAIL (EACCES), never skip; that is a deliberate gate.

Scratch data: the e2e harness makes its own temp dir under `$TMPDIR` and removes it. Caddy is
cached at `~/.cache/hoist/caddy/<version>/caddy` (sha256-verified; safe to delete to force a
re-download). One Docker daemon hosts exactly one hoist instance. A second `serve`, a lab beside
the e2e suite, or the installer container shares the daemon and will delete the other
instance's containers. Unique app names and ports do not isolate them. Stop all other
instances before taking the mandatory e2e lock; never run a lab beside the suite.
`HOIST_DIR` (default `/var/lib/hoist`) is the data dir: `hoist.db`, `repos/<app>.git`,
`releases/<app>/<slug>/vN/build.log`, `tmp/` checkouts. Always point it at a scratch dir.
`HOIST_DOMAIN` is the default base domain. The SSH e2e runs a throwaway `/usr/sbin/sshd` as
the current user on a random high port with its own host key and `authorized_keys`.

## Platforms

| Platform | Ships | Review on | Notes |
|---|---|---|---|
| Linux | yes | Omarchy | Caddy pin is Linux amd64/arm64 only; Caddy arm64 is checksum-pinned; hoist's arm64 executable runs with QEMU in release CI |
| macOS | no | read for it | dev only: unit tests must pass; e2e must refuse to run, not skip silently |
| Windows | no | | |

## What to attack

- **Adapter boundary** (`src/adapters/validation.ts`, `docker.ts`, `caddy.ts`): every
  validator with unicode, empty, oversized, control chars, `..` in the middle of a segment,
  symlinked paths, IPv6 literals, uppercase hosts, labels with `=`; Docker Engine API error
  bodies; a Caddy ETag mismatch mid-PATCH; a build context that is a file, a FIFO, huge.
- **Streams and processes**: the build log stream never consumed; `containerLogs(follow)`
  without a signal; the tar child when Docker closes early; Caddy killed mid-e2e; two e2e
  invocations contending for the mandatory daemon lock.
- **Store** (`src/store`): two processes opening the same data dir; `user_version` above
  the binary's; a read-only data dir; the immutability trigger versus legitimate status and
  container_id updates; FK cascade on app delete.
- **Test honesty**: which acceptance claim has no test; a test that still passes with its
  guard removed; CI green while running nothing (the e2e skip path); a check that passes
  for an environmental reason.
- **Push path** (`src/git/dispatch.ts`, `hook.ts`, `repository.ts`, `src/core/build.ts`):
  `SSH_ORIGINAL_COMMAND` with quoting tricks, `..`, absolute paths, NUL, `git-upload-pack`,
  internal verbs (`git-hook`, `ssh-dispatch`) sent over SSH; ref lines malformed or oversized;
  branch names that slugify to the same thing; a push of two branches where one fails; a
  Dockerfile that fails mid-build; the pusher disconnecting (kill the ssh client); a bare repo
  with a replaced hook; a tag-only push; the same SHA pushed twice; `apps:destroy` while a
  build runs; `apps:create` twice concurrently; HOIST_DIR as a symlink or read-only.
- **Docs as typed**: every command in `AGENTS.md` and the README walkthrough from a fresh
  shell in the worktree, against a throwaway sshd.

- **Serve and cutover (M2–M5)**: kill Caddy around the upstream swap and old-container
  stop; restart the supervisor; verify routes against live rows, app leases, orphan
  cleanup, encrypted snapshots, rollback/restart, retention, preview deletion and TTL.
- **Doctor (M7)**: run before and after a push and after destroy; inspect tagged orphan
  images versus untagged parent layers, hook repair, corrupt/newer/read-only SQLite,
  invalid domain/TLS/port settings and missing services.
- **Dashboard (M6)**: password rotation and session races, CSRF, confirmation, throttling,
  body limits, forwarded IPs, hostile log output, live streams and shutdown during actions.
- **Installer and release (M7)**: fresh install and upgrade in Ubuntu, uppercase domains,
  existing config/key preservation, digest pins versus overridden release tags, prereleases,
  tag/package version mismatch and prerequisites unavailable.

## Traps

- Containers publish to a loopback host port on purpose; Caddy runs on the host, not in
  Docker, so there is no shared Docker network. `upstreamAddress` only accepting loopback is
  intended.
- `Tty: true` on containers is intended (plain log bytes, not multiplex frames); CRLF and
  merged stderr are known and owned by M4.
- Real adapters have no unit tests by design (PLAN §9); e2e covers them. Core logic is on fakes.
- `nextReleaseNumber` is a read; `reserveRelease` wraps it and the insert in one transaction.
- Push image tags are `hoist/<app>:<slug>-v<n>-<sha12>`; restart and rollback rows share earlier image tags.
- Successful pushes finish `live`; restart and rollback create new numbered releases through the same cutover.
- The pre-receive hook hard-codes the executable path; M7 `doctor` rewrites it.
- `.claude/skills` is a symlink to `.agents/skills`; `CLAUDE.md` is one line (`@AGENTS.md`).

## Earlier rounds

- 2026-11-02 — main at a487753 (M2–M7): issues #25–#37; `worklog/reports/hoist-review-2026-11-02.md`.

- 2026-11-01 — PR #9 (M0) at 01536c5: `worklog/reports/hoist-review-2026-11-01.md`; #10–#13.
