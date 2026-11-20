#!/usr/bin/env bash
set -euo pipefail

# A distinct real UID makes RLIMIT_NPROC independent even when local Docker
# containers share one kernel. The hard limit survives into shells and their
# children; an unprivileged Computer cannot raise it again.
uid_file=/opt/fungi/.computer-uid
if [[ -f "$uid_file" ]]; then
  uid=$(<"$uid_file")
else
  uid=$((100000 + $(od -An -N4 -tu4 /dev/urandom) % 2000000000))
  printf '%s\n' "$uid" >"$uid_file"
fi
if ! getent passwd "$uid" >/dev/null; then
  groupadd --gid "$uid" fungi
  useradd --no-log-init --uid "$uid" --gid "$uid" --no-create-home --home-dir /workspace --shell /bin/bash fungi
fi
export COMPUTER_RUNTIME_UID="$uid"
pids_max=$(node --input-type=module -e 'import { computerResourceBounds } from "/opt/fungi/resource-bounds.mjs"; process.stdout.write(String(computerResourceBounds.pidsMax))')
mkdir -p /workspace
chown "$uid:$uid" /workspace
# Agent CLIs installed by fungi-tools live here, outside the synced home: their
# binaries exceed the durable home's per-file bound. Nothing here survives a wake.
install -d -m 0700 -o "$uid" -g "$uid" /var/cache/fungi-tools
# The declared services' s6 scan directory and logs: scratch, rebuilt by
# `fungi-services apply` on every wake, never synced into the home.
export COMPUTER_SERVICES_DIR=/var/cache/fungi-services
install -d -m 0700 -o "$uid" -g "$uid" "$COMPUTER_SERVICES_DIR"
ulimit -Su "$pids_max"
ulimit -Hu "$pids_max"
# vmd's guest config carries this VM's SSH host key, user CA and principals. The
# unprivileged `sshd -i` reads them from files only the runtime user can read; a
# Computer without them has no SSH, and terminal-server refuses /ssh.
ssh_source=/run/fungi-vm/ssh
ssh_directory=/run/fungi-ssh
rm -rf "$ssh_directory"
if [[ -d "$ssh_source" ]]; then
  install -d -m 0700 -o "$uid" -g "$uid" "$ssh_directory"
  for name in host_ed25519 user_ca.pub principals; do
    [[ -f "$ssh_source/$name" ]] || continue
    install -m 0600 -o "$uid" -g "$uid" "$ssh_source/$name" "$ssh_directory/$name"
  done
fi
export HOME=/workspace
# The image's npm and pnpm prefixes are root-owned. Global installs go into
# user-owned folders in the persistent home; npm and pnpm create them on first
# use as this UID. Every Computer process (computerd exec, terminal) inherits
# this environment. terminal-assets/global-tools.sh (sourced from
# /etc/profile.d) restores the PATH entries for login shells, because Debian's
# /etc/profile resets PATH.
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PNPM_HOME="$HOME/.local/share/pnpm"
export PATH="$HOME/.local/bin:$NPM_CONFIG_PREFIX/bin:$PNPM_HOME/bin:$PATH"
exec node /opt/fungi/computer-init.mjs
