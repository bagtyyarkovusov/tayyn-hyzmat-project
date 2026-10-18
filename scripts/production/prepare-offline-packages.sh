#!/usr/bin/env bash
# Run ONLY inside a disposable, connected Ubuntu24.04 amd64 builder.
set -euo pipefail
if [[ ${1:-} != --disposable-builder || $# -lt 2 || $# -gt 3 || ( $# -eq 3 && ${3:-} != --monitor ) ]]; then
  echo 'Usage: prepare-offline-packages.sh --disposable-builder /output/packages [--monitor]' >&2; exit 1
fi
if [[ $EUID -ne 0 ]]; then echo 'Run as root in a disposable builder.' >&2; exit 1; fi
source /etc/os-release
if [[ ${ID:-} != ubuntu || ${VERSION_ID:-} != 24.04 || $(dpkg --print-architecture) != amd64 ]]; then
  echo 'Requires Ubuntu24.04 amd64.' >&2; exit 1
fi
output=$(realpath -m "$2")
if [[ -e $output ]]; then echo 'Output must be a new directory.' >&2; exit 1; fi
apt-get update
apt-get install --yes --no-install-recommends ca-certificates curl gnupg
docker_packages=()
if [[ ${3:-} != --monitor ]]; then
install -d -m 0755 /etc/apt/keyrings
curl --fail --silent --show-error --location https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
printf '%s\n' 'deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable' > /etc/apt/sources.list.d/docker.list
apt-get update
docker_packages=(docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin certbot)
fi
mkdir -p "$output/partial"
# Empty dpkg status downloads the complete dependency pool, including packages
# already on the builder. The installer resolves only missing requirements
# against the target status; it must never explicitly install this entire pool
# or upgrade provider SSH/init packages to the builder's newer versions.
apt-get -o Dir::State::status=/dev/null -o Dir::Cache::archives="$output" \
  --download-only --yes --no-install-recommends install \
  "${docker_packages[@]}" \
  age python3 openssh-client ca-certificates curl openssl tzdata sudo
rmdir "$output/partial"
rm -f "$output/lock"
for package in "$output"/*.deb; do
  dpkg-deb --show --showformat='${Package}\t${Version}\t${Architecture}\n' "$package"
done > "$output/PACKAGES.tsv"
printf '%s\n' 'Download complete. This is not installation certification. Test these packages with network disabled on a clean Ubuntu24.04 amd64 VM.'
