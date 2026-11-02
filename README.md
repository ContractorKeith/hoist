# hoist

A lightweight self-hosted PaaS for one Linux server. One Bun executable, Docker runtime,
and a pinned Caddy binary. MIT. See [the plan](docs/PLAN.md) for the v1 scope.

M2 adds health-checked cutover, HTTPS routes, a Caddy supervisor and boot reconcile.

## Run the server

Run the compiled executable as the dedicated `hoist` account with Docker socket access:

```bash
HOIST_DIR=/var/lib/hoist HOIST_ACME_EMAIL=you@example.com hoist serve
```

Keep this process running before pushing. Caddy stores certificates in `$HOIST_DIR/caddy`.
Allow TCP ports 80 and 443 and point the app's domain at this server. The account needs
permission to bind those ports (the M7 installer will configure this). `HOIST_TLS=acme`
is the default and uses Let's Encrypt; set `HOIST_TLS=internal` for an internal CA on
an air-gapped server or in tests. Clients must trust its root certificate at
`$HOIST_DIR/caddy/pki/authorities/local/root.crt`.

Tests and unprivileged local runs can set `HOIST_HTTP_PORT`, `HOIST_HTTPS_PORT` and
`HOIST_CADDY_ADMIN_PORT` to distinct high ports. The admin listener is loopback-only
(default `127.0.0.1:2019`). Set the same admin port in the SSH forced command so hooks
can reach `serve`. HTTPS URLs printed by the hook use the public default port; append
`:<HOIST_HTTPS_PORT>` when testing on a high port.

Run exactly one `hoist serve` per `HOIST_DIR`; a second supervisor fails immediately
with the current owner's PID. SQLite leases heartbeat every 10 seconds and expire after
60 seconds without a heartbeat, or immediately when the owner PID is dead. After a
SIGKILL/crash, the next supervisor reaps the recorded Caddy child only if its pinned
binary and config path belong to this data directory, then starts one replacement.

On startup, hoist fails interrupted `building` releases and removes their images,
restores missing or stopped live containers, rebuilds routes and removes unreferenced
app containers. It restarts Caddy with backoff if Caddy exits. Five consecutive exits in under 10 seconds
each stop `serve` with a non-zero exit, the exit code and the last 50 stderr lines.
A failed app recovery is logged while healthy apps keep serving. SIGTERM stops both
processes; app containers stay running for the next `serve`.

## Push an app

The server needs Linux, Docker, Git, tar and OpenSSH, plus the compiled hoist executable
(`bun install --frozen-lockfile && bun run build`). Use a dedicated server account with Docker
socket access and a writable data directory. M7 will provide the installer.

Set `HOIST_DIR` (default `/var/lib/hoist`) and `HOIST_DOMAIN` (for example `example.com`) in
the server's SSH forced command. Add your public key to that account's `authorized_keys`
with this prefix, substituting absolute paths and your domain:

```text
command="HOIST_DIR=/absolute/private/hoist-data HOIST_DOMAIN=example.com /absolute/path/to/hoist ssh-dispatch",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 YOUR_PUBLIC_KEY
```

The generated pre-receive hook hard-codes the executable path at `apps:create` time. Keep
that path stable; M7 `doctor` will rewrite hooks when the executable moves.

From your computer, create the app through SSH:

```bash
ssh hoist@server hoist apps:create hello
ssh hoist@server hoist apps:list --json
```

In a Git repository with a **Dockerfile at the root**, commit your app and push:

```bash
git remote add hoist hoist@server:hello.git
git push hoist main
ssh hoist@server hoist apps:info hello --json
```

The push ends with `Live: https://hello.example.com`; opening that URL returns your app.
Per-app leases in the SQLite `locks` table serialize reserve, build and cutover with
that app's reconcile. A second holder polls every 200 ms for up to 10 minutes; shutdown
cancels a waiting lease immediately. Other apps can proceed independently. Reconcile
writes each app's route under its lease and never replays a full route snapshot. Caddy
loads a full config only at spawn; a Caddy restart during a push can fail that push's
route write, which fails the release and removes its candidate. Containers must match
both app and release labels. Candidates left by a killed hook are removed and their
`built` release is failed as "interrupted before cutover".
Closing the terminal mid-push does not cancel the deploy; the release still lands server-side.

The push streams Docker's build records and saves the same bytes to
`$HOIST_DIR/releases/hello/main/v1/build.log`. The release records the full SHA and image
`hoist/hello:main-v1-<first-12-SHA-characters>`, with the current encrypted config snapshot. The container uses its single exposed TCP port (UDP exposures are ignored); with no
exposed TCP port it uses config `PORT`, defaulting to `8080`. Several exposed TCP ports
require `PORT` in config; otherwise the push fails with an actionable error. Docker assigns a
random host port published only on `127.0.0.1`. Health requires HTTP **2xx**; redirects
are not followed and 3xx fails the health check. A failed health check leaves the previous
release serving and fails the push. A failed push records
a `failed` release and keeps its log. Branches have separate release numbers; slug collisions
are refused. Non-main branches remain `built` until M5 adds preview hosts; branch deletes
do nothing until M5. Immediately before cutover, the pre-receive hook rechecks the stored
branch tip against the push’s expected old SHA: Git updates the ref only after the hook
succeeds, so checking against the new SHA here would reject every push.

`apps:create` accepts `--domain hello.example.com` and `--health-path /ready`. Without
`--domain`, `HOIST_DOMAIN` must be set. Hoist is push-only: cloning and fetching are refused.

To remove the app, containers, Caddy routes, images, bare repo, release logs and database rows:

```bash
ssh hoist@server hoist apps:destroy hello --force
```

Destroy also works while `serve` is down: it removes local resources and rows, warns
that Caddy is unreachable, and lets the next `serve` rebuild routes from the store.

Local `apps:destroy` asks for the app name on a TTY. Without a TTY, `--force` is required.
The data directory and created files are private (directories and executable hooks `0700`,
ordinary files `0600`; executable checkout files retain owner execute permission).

## Config, rollback and retention

```bash
ssh hoist@server hoist config:set hello DATABASE_URL='postgres://…' PORT=8080
ssh hoist@server hoist config:list hello              # masked values
ssh hoist@server hoist config:list hello --json --reveal
ssh hoist@server hoist config:unset hello PORT
ssh hoist@server hoist restart hello
ssh hoist@server hoist releases hello --json
ssh hoist@server hoist rollback hello v1
ssh hoist@server hoist rollback hello                 # previous stopped main release
ssh hoist@server hoist apps:set hello retention=10
```

Saving config takes effect on the next push or restart. Keys are uppercase identifiers;
values may contain `=` and may be empty, with a 64 KiB limit and no NUL. Config values and
release snapshots are encrypted with AES-256-GCM. The generated 32-byte
`$HOIST_DIR/secret.key` is private (0600). Back up `secret.key`; losing it loses every
config value. A missing key is generated only when no current or historical encrypted
config exists; otherwise restore it from backup. Non-regular key files are refused.
Only `--reveal` and container startup decrypt values.

Restart creates a new numbered main release from the live image and current config.
Rollback creates a new release copying the target image and its config snapshot. Both
use the push cutover path under the app lease and save progress in `build.log`.
Failed, building, unknown and already-live rollback targets are refused, as are targets
whose images are gone. A shared image can still be rolled back to after its old logs are pruned.

After successful cutover, retention keeps the newest five live/stopped/built releases
per app and branch by default (`retention=1..100`). The live release is always protected.
Prune is best effort after cutover: cleanup errors warn in the new release log and stderr
without rejecting the push, restart or rollback.
Older releases get `pruned_at`; their log directories and unreferenced image tags are
removed. Shared image tags used by retained rollbacks stay. Failed releases are marked pruned
after image cleanup is attempted, while their log directories stay for M4. Masked config
listings omit value lengths; `--reveal` includes values and byte lengths.

## Logs

```bash
ssh hoist@server hoist logs hello
ssh hoist@server hoist logs hello -n 1
ssh hoist@server hoist logs hello -f
ssh hoist@server hoist logs hello --release v2
ssh hoist@server hoist logs hello --branch feature-x
```

Runtime output comes from Docker, defaults to the last 100 lines, and accepts `-n`
from 1 to 10000. Bytes pass through with carriage returns removed. `-f` streams
until Ctrl-C or another release takes over; takeover prints the new release number
and exits successfully. The live release is checked every two seconds.

`--release vN` reads the complete build and cutover log at
`$HOIST_DIR/releases/<app>/<branch-slug>/vN/build.log`, including failed pushes.
It cannot be combined with `-f` or `-n`. The branch defaults to `main`.

## Development

```bash
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun test
bun run test:e2e
bun run build
./dist/hoist version
```

E2e needs Linux, Docker socket access and `/usr/sbin/sshd`. It runs a throwaway SSH server
as the current account, plus real Docker and Caddy, and verifies teardown. On Omarchy,
run `echo 'bun run test:e2e' | newgrp docker` if the shell lacks the Docker group. Bare
`bun test` skips e2e; explicitly enabling e2e fails when prerequisites are unavailable.
