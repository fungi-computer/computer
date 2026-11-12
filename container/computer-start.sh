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
  useradd --no-log-init --uid "$uid" --user-group --no-create-home --home-dir /workspace --shell /bin/bash fungi
fi
export COMPUTER_RUNTIME_UID="$uid"
pids_max=$(node --input-type=module -e 'import { computerResourceBounds } from "/opt/fungi/resource-bounds.mjs"; process.stdout.write(String(computerResourceBounds.pidsMax))')
mkdir -p /workspace
chown "$uid:$uid" /workspace
ulimit -Su "$pids_max"
ulimit -Hu "$pids_max"
export HOME=/workspace
# The image's npm and pnpm prefixes are root-owned. Global installs go into
# user-owned folders in the persistent home; npm and pnpm create them on first
# use as this UID. Every Computer process (computerd exec, terminal) inherits
# this environment. terminal-assets/global-tools.sh (sourced from
# /etc/profile.d) restores the PATH entries for login shells, because Debian's
# /etc/profile resets PATH.
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PNPM_HOME="$HOME/.local/share/pnpm"
export PATH="$NPM_CONFIG_PREFIX/bin:$PNPM_HOME/bin:$PATH"
exec node /opt/fungi/computer-init.mjs
