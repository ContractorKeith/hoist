#!/bin/sh
# Hoist v0.1.0: Ubuntu 24.04 and Debian 12. Re-run to upgrade; data stays in place.
set -eu
umask 077
HOIST_VERSION=${HOIST_VERSION:-v0.1.0}
# BEGIN HOIST PINS (filled by the release workflow)
HOIST_X64_SHA256=
HOIST_ARM64_SHA256=
# END HOIST PINS
# BEGIN CADDY PINS (bun run pins --write)
CADDY_VERSION=2.11.7
CADDY_X64_ARCHIVE=727b91701a392de6ebc5027509f548bf39979e5216340d0faed8fa5e69c84f8b
CADDY_X64_BINARY=678ade3bfc088749c81a681adc603333ee0bb023b6a6cfe3c0f58bef8ff854e9
CADDY_ARM64_ARCHIVE=d8fc6d179a5d283028a472a5618564f6ad8a86fed513e64f032b3b0b7cc45e42
CADDY_ARM64_BINARY=0019d864a2cdee41c3675cb2a26185833c5d9540a48f5a6729142c0413461b60
# END CADDY PINS
say() { printf '%s\n' "$*"; }
fail() { say "$*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || fail 'Run install.sh as root.'
if [ -n "${HOIST_LOCAL_BINARY:-}" ] && [ "${HOIST_E2E:-}" != 1 ]; then
  fail 'HOIST_LOCAL_BINARY requires HOIST_E2E=1.'
fi
# shellcheck disable=SC1091
. /etc/os-release
case "$ID:$VERSION_ID" in ubuntu:24.04|debian:12) ;; *) fail 'Use Ubuntu 24.04 or Debian 12.' ;; esac
case "$(uname -m)" in x86_64) arch=x64; caddy_arch=amd64; archive_sha=$CADDY_X64_ARCHIVE; binary_sha=$CADDY_X64_BINARY; hoist_sha=$HOIST_X64_SHA256 ;; aarch64|arm64) arch=arm64; caddy_arch=arm64; archive_sha=$CADDY_ARM64_ARCHIVE; binary_sha=$CADDY_ARM64_BINARY; hoist_sha=$HOIST_ARM64_SHA256 ;; *) fail 'Unsupported architecture.' ;; esac
case "$HOIST_VERSION" in v[0-9]* ) ;; *) fail 'HOIST_VERSION must be a v-prefixed release tag.' ;; esac
case "$HOIST_VERSION" in *[!a-zA-Z0-9.-]*) fail 'Invalid release tag.' ;; esac
owner_key=${HOIST_OWNER_KEY:-}
if [ "$#" -gt 0 ]; then
  [ "$#" = 2 ] && [ "$1" = --key ] || fail 'Usage: install.sh [--key <public-key-file>]'
  owner_key=$(cat "$2")
fi
if [ "$#" -gt 0 ] || [ -n "$owner_key" ]; then
  case "$owner_key" in ssh-ed25519\ *|ssh-rsa\ *|ecdsa-sha2-*\ *) ;; *) fail 'Provide one public SSH key.' ;; esac
  [ "$(printf '%s\n' "$owner_key" | wc -l)" -eq 1 ] || fail 'Provide one public SSH key line.'
fi
new_install=0
if [ ! -f /etc/hoist/hoist.env ]; then
  new_install=1
  if [ -t 0 ]; then
    if [ -z "${HOIST_DOMAIN:-}" ]; then printf 'Base domain: '; read -r HOIST_DOMAIN; fi
    if [ -z "${HOIST_ACME_EMAIL:-}" ]; then printf 'ACME email: '; read -r HOIST_ACME_EMAIL; fi
  fi
  [ -n "${HOIST_DOMAIN:-}" ] || fail 'Set HOIST_DOMAIN for a non-interactive install.'
  [ -n "${HOIST_ACME_EMAIL:-}" ] || fail 'Set HOIST_ACME_EMAIL for a non-interactive install.'
  # DNS validation below accepts ASCII only.
  # shellcheck disable=SC2018,SC2019
  normalized_domain=$(printf '%s' "$HOIST_DOMAIN" | tr 'A-Z' 'a-z')
  if [ "$normalized_domain" != "$HOIST_DOMAIN" ]; then say "Lowercased HOIST_DOMAIN to $normalized_domain."; fi
  HOIST_DOMAIN=$normalized_domain
  case "$HOIST_DOMAIN" in ''|*[!a-zA-Z0-9.-]*|.*|-*) fail 'Use a DNS base domain.' ;; esac
  case "$HOIST_ACME_EMAIL" in *[!a-zA-Z0-9.@_+-]*|'') fail 'Use a valid ACME email.' ;; *@*.*) ;; *) fail 'Use a valid ACME email.' ;; esac
fi
export DEBIAN_FRONTEND=noninteractive
missing=
for tool in git tar curl gpg; do command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"; done
if [ -n "$missing" ]; then
  apt-get update
  # shellcheck disable=SC2086
  apt-get install -y $missing ca-certificates
  say "Installed prerequisites:$missing."
fi
if ! command -v docker >/dev/null 2>&1; then
  install -d -m 0755 /etc/apt/keyrings
  curl -fL --retry 3 "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
  gpg --show-keys --with-colons /etc/apt/keyrings/docker.asc | grep -q '^fpr:::::::::9DC858229FC7DD38854AE2D88D81803C0EBFCD88:$' || fail 'Docker signing key fingerprint did not match.'
  chmod 0644 /etc/apt/keyrings/docker.asc
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' "$(dpkg --print-architecture)" "$ID" "$VERSION_CODENAME" > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io
  say 'Installed Docker from its official repository.'
fi
getent group docker >/dev/null || groupadd --system docker
if ! id hoist >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /var/lib/hoist --shell /bin/sh hoist
  say 'Created the hoist system user.'
fi
usermod -a -G docker hoist
# The container acceptance test mounts a socket whose numeric group may differ.
if [ -S /var/run/docker.sock ]; then
  socket_gid=$(stat -c %g /var/run/docker.sock)
  socket_group=$(getent group "$socket_gid" | cut -d: -f1) || true
  if [ -z "$socket_group" ]; then
    groupadd --system --gid "$socket_gid" hoist-docker-socket
    socket_group=hoist-docker-socket
  fi
  usermod -a -G "$socket_group" hoist
fi
install -d -m 0700 -o hoist -g hoist /var/lib/hoist
install -d -m 0755 /etc/hoist
stage=$(mktemp -d)
cleanup() { [ ! -d "$stage" ] || find "$stage" -depth -delete; }
trap 'cleanup' EXIT
trap 'cleanup; exit 130' HUP INT TERM
base=${HOIST_RELEASE_BASE:-https://github.com/ContractorKeith/hoist/releases/download/$HOIST_VERSION}
if [ -n "${HOIST_LOCAL_BINARY:-}" ]; then
  cp "$HOIST_LOCAL_BINARY" "$stage/hoist"
  say "Using local hoist binary: $HOIST_LOCAL_BINARY."
else
  curl -fL --retry 3 "$base/hoist-linux-$arch" -o "$stage/hoist-linux-$arch"
  if [ -n "$hoist_sha" ]; then
    printf '%s  %s\n' "$hoist_sha" "$stage/hoist-linux-$arch" | sha256sum -c -
    say "Downloaded and verified hoist $HOIST_VERSION ($arch) against the installer pin."
  else
    curl -fL --retry 3 "$base/checksums.txt" -o "$stage/checksums.txt"
    (cd "$stage"; awk -v name="hoist-linux-$arch" '$2 == name {print}' checksums.txt > selected.txt
      [ "$(wc -l < selected.txt)" -eq 1 ] || exit 1
      sha256sum -c selected.txt)
    say "Downloaded hoist $HOIST_VERSION ($arch); checked against the release checksums."
  fi
  mv "$stage/hoist-linux-$arch" "$stage/hoist"

fi
install -m 0755 "$stage/hoist" /usr/local/bin/hoist.next
mv /usr/local/bin/hoist.next /usr/local/bin/hoist
cache="/var/lib/hoist/.cache/hoist/caddy/$CADDY_VERSION"
install -d -o hoist -g hoist -m 0700 "$cache"
if ! printf '%s  %s\n' "$binary_sha" "$cache/caddy" | sha256sum -c - >/dev/null 2>&1; then
  curl -fL --retry 3 "https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION/caddy_${CADDY_VERSION}_linux_${caddy_arch}.tar.gz" -o "$stage/caddy.tar.gz"
  printf '%s  %s\n' "$archive_sha" "$stage/caddy.tar.gz" | sha256sum -c -
  tar -xzf "$stage/caddy.tar.gz" -C "$stage" caddy
  printf '%s  %s\n' "$binary_sha" "$stage/caddy" | sha256sum -c -
  install -o hoist -g hoist -m 0755 "$stage/caddy" "$cache/caddy.next"
  mv "$cache/caddy.next" "$cache/caddy"
  say "Installed verified Caddy $CADDY_VERSION."
else say "Kept verified Caddy $CADDY_VERSION."; fi
if [ ! -f /etc/hoist/hoist.env ]; then
  printf "HOIST_DIR=/var/lib/hoist\nHOIST_DOMAIN='%s'\nHOIST_ACME_EMAIL='%s'\nHOIST_TLS=acme\n" "$HOIST_DOMAIN" "$HOIST_ACME_EMAIL" > /etc/hoist/hoist.env
  say 'Created /etc/hoist/hoist.env.'
else say 'Kept existing /etc/hoist/hoist.env and app data.'; fi
chown hoist:hoist /etc/hoist/hoist.env
chmod 0600 /etc/hoist/hoist.env
cat > /etc/systemd/system/hoist.service <<'UNIT'
# BEGIN HOIST UNIT (bun run pins --write)
[Unit]
Description=Hoist app server
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
Type=simple
User=hoist
Group=hoist
SupplementaryGroups=docker
EnvironmentFile=/etc/hoist/hoist.env
Environment=HOME=/var/lib/hoist
ExecStart=/usr/local/bin/hoist serve
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
Restart=on-failure
RestartSec=2
TimeoutStopSec=45
UMask=0077
NoNewPrivileges=yes
ProtectSystem=full
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=/var/lib/hoist

[Install]
WantedBy=multi-user.target
# END HOIST UNIT
UNIT
say 'Installed /usr/local/bin/hoist and hoist.service; ensured hoist belongs to docker.'
# Load the same private environment for setup, hooks and SSH control commands.
run_hoist() { runuser -u hoist -- sh -c 'set -a; . /etc/hoist/hoist.env; set +a; exec /usr/local/bin/hoist "$@"' sh "$@"; }
if [ "$new_install" = 1 ] && [ -n "${HOIST_OWNER_PASSWORD:-}" ]; then
  printf '%s\n' "$HOIST_OWNER_PASSWORD" | run_hoist dashboard:set-password
elif [ -t 0 ] && [ "$new_install" = 1 ]; then
  say 'Set the dashboard owner password.'
  run_hoist dashboard:set-password
fi
if [ -d /run/systemd/system ]; then
  systemctl daemon-reload
  systemctl enable docker hoist
  systemctl start docker
  systemctl restart hoist
  say 'Enabled Docker and restarted hoist.service.'
  # serve writes its lease only after startup; allow it to become ready.
  attempt=0
  until run_hoist doctor; do
    attempt=$((attempt + 1)); [ "$attempt" -lt 15 ] || break
    sleep 1
  done
else say 'systemd is unavailable; start hoist serve separately.'; fi
if [ -n "$owner_key" ]; then
  key_line="command=\"set -a; . /etc/hoist/hoist.env; set +a; exec /usr/local/bin/hoist ssh-dispatch\",restrict $owner_key"
  install -d -m 0700 -o hoist -g hoist /var/lib/hoist/.ssh
  authorized=/var/lib/hoist/.ssh/authorized_keys
  touch "$authorized"
  if ! grep -Fqx -- "$key_line" "$authorized"; then printf '%s\n' "$key_line" >> "$authorized"; fi
  chown hoist:hoist "$authorized"
  chmod 0600 "$authorized"
  say 'Ensured the owner key is installed in /var/lib/hoist/.ssh/authorized_keys.'
else
  printf 'command="set -a; . /etc/hoist/hoist.env; set +a; exec /usr/local/bin/hoist ssh-dispatch",restrict ssh-ed25519 REPLACE_WITH_OWNER_PUBLIC_KEY\n'
fi
say 'Running hoist doctor.'
run_hoist doctor || say 'Fix the items above and rerun hoist doctor.'
