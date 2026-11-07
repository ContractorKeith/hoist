# hoist

The words hoist uses for the things on one server that runs your apps. One definition each.

## Language

**App**:
A named deploy target with a git remote, a base domain, current config, and a chain of
releases per branch.
_Avoid_: service, project, site

**Release**:
An immutable record of one image, one config snapshot and one git SHA, numbered per app and
branch (`v1`, `v2`, ...). A release is `building` while its image builds, `built` when ready for cutover, then `live`, `stopped` or `failed`. A rollback creates a new release; it never moves a pointer back.
_Avoid_: deployment, version, build

**Volume**:
An app-owned Docker named volume (`hoist-<app>-data`) mounted at its configured
container path in production releases. Its data outlives releases; previews do
not mount it. The mount uses current app config, including when rolling back to
an image built before the volume was configured. Rollback restores image and
config, never volume contents. Setting a volume does not migrate an earlier
container's files; Docker seeds a new volume from the image directory instead.
_Avoid_: bind mount, disk snapshot

**Config**:
The app's current environment variables. Snapshotted into every release so a rollback runs
with the config that was live then.
_Avoid_: env, secrets, settings

**Cutover**:
Start the new container, health-check it, swap the Caddy upstream, stop the old container. A
failed health check leaves the old release live and fails the push.
_Avoid_: deploy, switch, blue-green

**Preview**:
The release chain for a branch other than the app's configured main branch (default `main`),
served at `<branch-slug>.<app.domain>`. Removed by a branch-delete push,
`previews:destroy`, or after 7 idle days (configurable).
_Avoid_: staging, environment, branch deploy

**Control plane**:
Where apps and config are created and changed: the CLI verbs over SSH and `git push`. The
dashboard is not a control plane; it reads, and may roll back or restart.
_Avoid_: API

**Server**:
The one Linux machine hoist runs on. There is exactly one.
_Avoid_: node, host, agent

**Owner**:
The single person who installs and operates hoist. There are no other users.
_Avoid_: admin, user, account
