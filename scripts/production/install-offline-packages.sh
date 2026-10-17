#!/usr/bin/env bash
# Installs only locally supplied packages. It never contacts apt repositories.
set -euo pipefail
if [[ $# -gt 1 || ( $# -eq 1 && ${1:-} != --monitor ) ]]; then echo "Usage: $0 [--monitor]" >&2; exit 1; fi
if [[ $EUID -ne 0 ]]; then echo 'Run as root on the target Ubuntu host.' >&2; exit 1; fi
source /etc/os-release
if [[ ${ID:-} != ubuntu || ${VERSION_ID:-} != 24.04 || $(dpkg --print-architecture) != amd64 ]]; then
  echo 'Requires Ubuntu 24.04 amd64.' >&2; exit 1
fi
bundle=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$bundle"
sha256sum --check --quiet SHA256SUMS
shopt -s nullglob
if [[ ${1:-} == --monitor ]]; then
  packages=("$bundle"/packages-monitor/*.deb)
else
  packages=("$bundle"/packages/*.deb)
fi
if ((${#packages[@]} == 0)); then echo 'Bundle has no offline packages.' >&2; exit 1; fi
for package in "${packages[@]}"; do
  arch=$(dpkg-deb --field "$package" Architecture)
  if [[ $arch != amd64 && $arch != all ]]; then echo 'Invalid package architecture.' >&2; exit 1; fi
done
# Resolve ordering from local files only. Repository sources and downloads are
# disabled; a missing dependency aborts instead of contacting the internet.
DEBIAN_FRONTEND=noninteractive apt-get --yes --no-download \
  -o Dir::Etc::sourcelist=/dev/null -o Dir::Etc::sourceparts=- \
  install "${packages[@]}"
if [[ ${1:-} != --monitor ]]; then
  systemctl enable --now docker
  docker compose version
fi
age --version
python3 --version
curl --version >/dev/null
openssl version >/dev/null
ssh -V
printf '%s\n' 'Offline packages installed. Verify SSH remains reachable in a second session before changing any firewall.'
