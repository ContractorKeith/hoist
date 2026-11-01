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
bun install --frozen-lockfile
bun run typecheck                     # tsc --noEmit
bun run lint                          # biome check .   (exactly as CI)
bun test                              # unit; no Docker; e2e scenario shows as skipped
echo 'bun run test:e2e' | newgrp docker   # real Docker + pinned Caddy on random high ports
bun run build && ./dist/hoist version # bun build --compile -> dist/hoist
```

Docker: this box's login session is not in the `docker` group even though the user is.
Anything that touches the socket runs under `newgrp docker` on stdin, as above. `sg` and
passwordless sudo are not available. Running `HOIST_E2E=1 bun test test/e2e` without
`newgrp` must FAIL (EACCES), never skip; that is a deliberate gate.

Scratch data: the e2e harness makes its own temp dir under `$TMPDIR` and removes it. Caddy is
cached at `~/.cache/hoist/caddy/<version>/caddy` (sha256-verified; safe to delete to force a
re-download). Containers and images the tests make carry the label `hoist.test=<uuid>`.
Nothing in M0 writes anywhere else. Later milestones add a data dir; its env var will be
named here when it exists.

## Platforms

| Platform | Ships | Review on | Notes |
|---|---|---|---|
| Linux | yes | Omarchy | Caddy pin is Linux amd64/arm64 only; arm64 is checksum-pinned, never executed yet |
| macOS | no | read for it | dev only: unit tests must pass; e2e must refuse to run, not skip silently |
| Windows | no | | |

## What to attack

- **Adapter boundary** (`src/adapters/validation.ts`, `docker.ts`, `caddy.ts`): every
  validator with unicode, empty, oversized, control chars, `..` in the middle of a segment,
  symlinked paths, IPv6 literals, uppercase hosts, labels with `=`; Docker Engine API error
  bodies; a Caddy ETag mismatch mid-PATCH; a build context that is a file, a FIFO, huge.
- **Streams and processes**: the build log stream never consumed; `containerLogs(follow)`
  without a signal; the tar child when Docker closes early; Caddy killed mid-e2e; two e2e
  runs at once (port and label collisions).
- **Store** (`src/store`): two processes opening the same data dir; `user_version` above
  the binary's; a read-only data dir; the immutability trigger versus legitimate status and
  container_id updates; FK cascade on app delete.
- **Test honesty**: which acceptance claim has no test; a test that still passes with its
  guard removed; CI green while running nothing (the e2e skip path); a check that passes
  for an environmental reason.
- **Docs as typed**: every command in `AGENTS.md` from a fresh shell in the worktree.

## Traps

- Containers publish to a loopback host port on purpose; Caddy runs on the host, not in
  Docker, so there is no shared Docker network. `upstreamAddress` only accepting loopback is
  intended.
- `Tty: true` on containers is intended (plain log bytes, not multiplex frames); CRLF and
  merged stderr are known and owned by M4.
- Real adapters have no unit tests by design (PLAN §9); e2e covers them. Core logic is on fakes.
- `nextReleaseNumber` is a read, not a reservation; the transaction lands in M1.
- `.claude/skills` is a symlink to `.agents/skills`; `CLAUDE.md` is one line (`@AGENTS.md`).

## Earlier rounds

- none yet
