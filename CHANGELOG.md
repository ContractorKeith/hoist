# Changelog

## 0.1.0

- Install on one Ubuntu 24.04 or Debian 12 server, with verified Linux x64 and arm64
  binaries, pinned Caddy, Docker and a systemd service.
- Push a Dockerfile over SSH to build a numbered release and cut traffic over after an
  HTTP health check. Failed builds and health checks leave the current release serving.
- Save encrypted config, restart with current config, or roll back with an older
  release's config snapshot. Retain five releases by default.
- Read live container logs and saved build logs, including failed pushes.
- Push preview branches to their own hostnames; delete them through Git or the CLI,
  or let idle previews expire after seven days.
- Use the password-protected dashboard to inspect apps and logs, restart and roll back.
- Control the server through the dependency-free Node client or plain SSH.
- Diagnose dependencies, settings and orphan resources with doctor. Repair generated
  Git hooks automatically after executable upgrades.
