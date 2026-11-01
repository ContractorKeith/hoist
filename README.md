# hoist

A lightweight self-hosted PaaS for one Linux server. One Bun executable, Docker runtime,
and a pinned Caddy binary. MIT. See [the plan](docs/PLAN.md) for the v1 scope.

M0 is complete. M1 builds Dockerfile images on push and records numbered releases. Releases
move from `building` to `built` on success; M2 adds cutover. No app container is started and no HTTPS URL is
served yet.

## Push an app (M1)

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

The push streams Docker's build records and saves the same bytes to
`$HOIST_DIR/releases/hello/main/v1/build.log`. The release records the full SHA and image
`hoist/hello:main-v1-<first-12-SHA-characters>`, with an empty config snapshot. A failed push records
a `failed` release and keeps its log. Branches have separate release numbers; slug collisions
are refused. Branch deletes do nothing until M5.

`apps:create` accepts `--domain hello.example.com` and `--health-path /ready`. Without
`--domain`, `HOIST_DOMAIN` must be set. Hoist is push-only: cloning and fetching are refused.

To remove the app, images, bare repo, release logs and database rows:

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
