# hoist

Push a Dockerfile to one Linux server. Hoist builds a numbered release, checks its
health, then serves it over HTTPS with Caddy. A failed release leaves the current
one serving. MIT licensed; one Bun executable, Docker, Git and pinned Caddy.

## Requirements

One Docker daemon hosts exactly one hoist instance; a second instance on the
same daemon deletes the other's containers.

Use a fresh Ubuntu 24.04 or Debian 12 server (x64 or arm64), with ports 22, 80 and
443 open. Point `*.example.com` and `*.hello.example.com` at its IP; previews need
the second wildcard. Hoist assumes this server's Docker daemon belongs to hoist.

## Install

Download and inspect the versioned installer, then run as root:

```sh
curl -fLO https://github.com/ContractorKeith/hoist/releases/download/v0.1.0/install.sh
sudo sh install.sh --key ~/.ssh/id_ed25519.pub
```

The installer prompts for the base domain, ACME email and dashboard password on a
TTY. For automation set `HOIST_DOMAIN`, `HOIST_ACME_EMAIL`, and
`HOIST_OWNER_PASSWORD` in the root process environment. It installs Docker from
its official repository when missing and verifies SHA-256 for hoist and Caddy.
It creates `/etc/hoist/hoist.env` (0600, owned by hoist), the `hoist` system user
in the Docker group, `/var/lib/hoist` (0700), and `hoist.service`.

With `--key` (or `HOIST_OWNER_KEY`), the installer adds the forced-command key
idempotently to `/var/lib/hoist/.ssh/authorized_keys`, owned by hoist with modes
0700 for `.ssh` and 0600 for the file. Without a key, it prints a template to add
manually. The key can push and run public CLI verbs; forwarding, PTY, fetching
and cloning are disabled. SSH must already be available.

A non-interactive install without a password succeeds and reports the missing
password through doctor. Set it by piping one password line into
`ssh hoist@server hoist dashboard:set-password`, then run doctor again.

## First push

The dependency-free Node 20+ client lives in `cli/`. Install it from this checkout
with `npm install -g ./cli` (npm publication is separate):

```sh
export HOIST_HOST=server
hoist apps:create hello
# In your app repository, with a Dockerfile at its root:
git remote add hoist hoist@server:hello.git
git push hoist main
```

Open `https://hello.example.com`. Without the client, use
`ssh hoist@server hoist apps:create hello`. `--host <host>` overrides `HOIST_HOST`;
SSH port and identity options come from `~/.ssh/config`.

A single exposed TCP port is used automatically; with none, set config `PORT`
(default 8080). Several exposed TCP ports require `PORT`. Health requires HTTP
2xx at `/`; use `apps:create --health-path /ready` for another path. Push one
branch update at a time. Closing your terminal does not cancel a server-side push.

## Config and rollback

```sh
hoist config:set hello DATABASE_URL='postgres://example' PORT=8080
hoist config:list hello              # masked; --reveal explicitly shows values
hoist restart hello                  # current config takes effect
hoist releases hello --json
hoist rollback hello v1              # copies v1's image AND config into a new release
hoist apps:set hello retention=10
```

SSH command arguments are limited to about 8 KiB and cannot contain control
characters. For multi-line or long secrets (up to 64 KiB), pass the value on stdin.
A single trailing newline (LF or CRLF) is stripped:

```sh
hoist config:set hello PEM --stdin < private-key.pem
```

Config takes effect on the next push or restart. Back up `/var/lib/hoist/secret.key`
with `hoist.db`; losing this key loses all encrypted config. Retention keeps five
releases per branch by default and always protects the live release.

## Logs and previews

```sh
hoist logs hello -f
hoist logs hello --release v2         # saved build/cutover log, even for failed pushes
git push hoist feature-x             # https://feature-x.hello.example.com
hoist previews:list hello --json
```

Tear down the preview either by deleting the remote branch:

```sh
git push hoist :feature-x
```

Or by removing the preview through the CLI:

```sh
hoist previews:destroy hello feature-x
```

Previews expire after seven idle days (`HOIST_PREVIEW_TTL_DAYS=1..365` in the
server environment). Change the primary branch with `apps:set hello branch=master`.

## Dashboard

Open `https://hoist.example.com` and sign in with the owner password. It shows
apps, releases, previews, config key names and live logs. Restart and rollback
ask for confirmation; create apps and change config through the CLI.

Change the password by piping one line into
`ssh hoist@server hoist dashboard:set-password`. Password changes revoke sessions.
The dashboard binds loopback port 8700; Caddy provides HTTPS.

## Upgrade and uninstall

Re-run the installer with `HOIST_VERSION=v0.1.0` (or another published tag). It
replaces the binary and service, preserves the existing environment and app data,
and runs doctor, which rewrites both generated Git hooks to the current executable.
Upgrades keep the existing password; `HOIST_OWNER_PASSWORD` initializes only a
new install. Use `dashboard:set-password` to change it later.

Run `hoist doctor --json` to inspect dependencies, service health and orphan
resources. Doctor migrates the database, generates `secret.key` when nothing is
encrypted yet, and rewrites stale hooks. Everything else is read-only; orphan
containers, images and routes are reported for manual cleanup.
For a container without systemd, `HOIST_DOCTOR_NO_SERVICE=1` downgrades unavailable
service/admin checks to warnings; other failures still exit 1.

To uninstall, destroy each app with `hoist apps:destroy <name> --force`, then as
root stop and disable `hoist.service`, remove `/etc/systemd/system/hoist.service`
and `/usr/local/bin/hoist`, and run `systemctl daemon-reload`. Back up the database
and key before removing `/etc/hoist`, `/var/lib/hoist`, and the hoist user. Docker
and its other resources remain installed.

## CLI reference

Generated from the public server verb table. Internal entry points are omitted.

<!-- BEGIN VERBS -->
```text
hoist apps:create <name> [--domain <fqdn>] [--health-path </path>] [--volume </path>]
hoist apps:list [--json]
hoist apps:info <name> [--json]
hoist apps:destroy <name> [--force] [--delete-volume]
hoist apps:set <name> retention=N|branch=<name>|volume=</path>
hoist apps:volume:rm <name> --force
hoist config:set <name> K=V [K=V...] | <name> KEY --stdin
hoist config:unset <name> K
hoist config:list <name> [--reveal] [--json]
hoist releases <name> [--branch <b>] [--json]
hoist rollback <name> [vN]
hoist restart <name>
hoist logs <name> [-f] [--release vN] [--branch <b>] [-n <lines>]
hoist previews:list <name> [--json]
hoist previews:destroy <name> <branch>
hoist dashboard:set-password
hoist doctor [--json]
hoist version
```
<!-- END VERBS -->

## Development

```sh
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun test
bun run test:e2e
bun run build
bun run pins --check
mkdir -p .tmp && bun run release:check
```

E2e requires Linux, Docker socket access and `/usr/sbin/sshd`. Installer tests run
only inside a disposable Ubuntu container; they never install onto the host.
Builds use Bun’s portable Linux runtime (x64 baseline or arm64), so they do not
inherit distribution-specific ICU libraries. A real public VM's ACME, reboot and
idle-server timing checks remain manual acceptance before tagging. Release CI cross-compiles both architectures on PRs;
`v*` tags publish binaries, checksums, installer and changelog notes.

## Persistent data

Create an app with `hoist apps:create facedown --volume /data`, or add storage to
an existing app with `hoist apps:set facedown volume=/data`. The setting takes
effect at the next production release. `apps:info` shows the volume name and path.
The path must be absolute and normalized, at most 255 characters, and cannot be
`/` or beneath `/proc`, `/sys` or `/dev`.

Hoist creates one Docker named volume, `hoist-<app>-data`, on first production use
and mounts it read-write. Data survives pushes, rollback, restart, retention
pruning, and `hoist serve` restarts. Rollback restores image and config; it does
not roll back volume contents. Preview releases never mount the production
volume and receive no persistent volume of their own.

During cutover, old and new containers both mount the volume while the health
check runs. Apps must tolerate this overlap and coordinate concurrent access;
facedown uses a SQLite single-writer lease.

To rename production without losing data:

```bash
hoist apps:set facedown branch=trunk
git branch -m main trunk
git push hoist trunk
```

With a volume configured, `branch=trunk` records `pending_main_branch` in
`apps:info`. The current production release keeps its bare-domain route and
mount, including across serve restarts, until a healthy push of `trunk` cuts
over and retires it. Failed pushes leave the old release serving. A live preview
cannot be promoted because its container has no volume: first run
`hoist previews:destroy facedown trunk`, then set `branch=trunk` and push again.

Use a dedicated data directory such as `/data`. Docker seeds a newly created
volume with files from the image's mount directory; reusing it then hides newer
image files at that path. `/app`, `/usr`, and `/etc` are traps for stale code or
system files. `apps:set volume=` does **not** migrate data written in an earlier
container's filesystem. Back it up and restore it into the volume before the next
release if needed. Mounts use current app config, so rolling back to an image
built before volumes were configured still mounts the current volume.

`hoist apps:volume:rm <app> --force` deletes the volume and clears its configured
path, allowing a different path to be set. It refuses during an app build or
while any container still references the volume. Stop/remove those containers
before removal. `hoist apps:destroy <app>` refuses while the app's volume exists;
add `--delete-volume` to delete the volume and all its data along with the app.
`--force` only skips the confirmation prompt and never deletes data by itself.

`hoist doctor` lists configured app volumes and flags missing volumes and orphan
`hoist-*-data` volumes. A missing configured volume will be recreated **empty** on
the next production release; restore its backup before deploying.

Back up a volume (replace `<app>` with the app name):

```bash
docker run --rm -v hoist-<app>-data:/data -v $PWD:/backup alpine tar czf /backup/<app>.tgz -C /data .
```

Quiesce writes first or use the app's database backup mechanism for a consistent
backup of active databases. Volume backups are separate from `HOIST_DIR` backups.

To restore after destroying and recreating an app, create the app but do not push
or start a release yet. `apps:info --json` includes its numeric `id`; a recreated
app may have a different ID. Confirm the named volume does not already exist
with `docker volume inspect hoist-facedown-data` before proceeding. Set both
ownership labels with the app name and new ID, then restore into that empty volume:

```bash
hoist apps:create facedown --volume /data
hoist apps:info facedown --json
restore_app=facedown
restore_id=42 # replace 42 with the numeric id just printed by apps:info
# Run from the directory containing facedown.tgz.
docker volume create --label "hoist.app=$restore_app" --label "hoist.app-id=$restore_id" "hoist-$restore_app-data"
docker run --rm -v "hoist-$restore_app-data:/data" -v "$PWD:/backup:ro" alpine:3.21 tar xzf "/backup/$restore_app.tgz" -C /data
```

Push only after extraction succeeds. Hoist will verify the new app's labels and
mount the restored volume. Restore only trusted backups while no app container
is using the volume; the Docker procedure deliberately stays outside hoist's CLI.
