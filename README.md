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

On startup, hoist fails interrupted `building` releases and removes their images,
restores missing or stopped live containers, rebuilds routes and removes unreferenced
app containers. It restarts Caddy with backoff if Caddy exits. SIGTERM stops both
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
Closing the terminal mid-push does not cancel the deploy; the release still lands server-side.

The push streams Docker's build records and saves the same bytes to
`$HOIST_DIR/releases/hello/main/v1/build.log`. The release records the full SHA and image
`hoist/hello:main-v1-<first-12-SHA-characters>`, with an empty config snapshot. The container uses its single exposed TCP port; with zero
or multiple exposed ports it uses config `PORT`, defaulting to `8080`. Docker assigns a
random host port published only on `127.0.0.1`. A failed health check leaves the previous
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

Local `apps:destroy` asks for the app name on a TTY. Without a TTY, `--force` is required.
The data directory and created files are private (directories and executable hooks `0700`,
ordinary files `0600`; executable checkout files retain owner execute permission).

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
