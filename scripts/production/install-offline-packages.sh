#!/usr/bin/env bash
# Installs only locally supplied packages. It never contacts apt repositories.
set -euo pipefail
export LC_ALL=C
usage() { echo "Usage: $0 [--monitor] [--simulate] [--bundle /verified/bundle]" >&2; exit 1; }
monitor=false
simulate=false
bundle=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
while (($#)); do
  case $1 in
    --monitor) monitor=true; shift ;;
    --simulate) simulate=true; shift ;;
    --bundle) [[ $# -ge 2 && -n $2 ]] || usage; bundle=$(realpath "$2"); shift 2 ;;
    *) usage ;;
  esac
done
if [[ $EUID -ne 0 ]]; then echo 'Run as root on the target Ubuntu host.' >&2; exit 1; fi
source /etc/os-release
if [[ ${ID:-} != ubuntu || ${VERSION_ID:-} != 24.04 || $(dpkg --print-architecture) != amd64 ]]; then
  echo 'Requires Ubuntu 24.04 amd64.' >&2; exit 1
fi
cd "$bundle"
sha256sum --check --quiet SHA256SUMS
shopt -s nullglob
if "$monitor"; then
  packages=("$bundle"/packages-monitor/*.deb)
else
  packages=("$bundle"/packages/*.deb)
fi
if ((${#packages[@]} == 0)); then echo 'Bundle has no offline packages.' >&2; exit 1; fi

# The closure is a pool of dependencies, not an upgrade list. Passing every .deb
# to apt would force upgrades of init and SSH even when the host already meets
# our requirements. Make a temporary local repository and request only missing
# tools. Existing packages are pinned to their installed versions: an OS upgrade
# requires a separate maintenance plan, never an implicit bootstrap side effect.
work=$(mktemp -d /tmp/tayyn-offline-apt.XXXXXXXX)
trap 'rm -rf -- "$work"' EXIT
mkdir -p "$work/repository/partial" "$work/lists/partial" "$work/sourceparts" "$work/preferencesparts" "$work/apt.conf.d"
# Exclude host APT hooks/proxies as well as its repository lists. A local-only
# update must not run a provider's network hook from /etc/apt/apt.conf.d.
printf 'Dir::Etc::parts "%s/apt.conf.d";\nDir::Etc::main "/dev/null";\n' "$work" > "$work/apt.conf"
export APT_CONFIG="$work/apt.conf"
for package in "${packages[@]}"; do
  arch=$(dpkg-deb --field "$package" Architecture)
  if [[ $arch != amd64 && $arch != all ]]; then echo 'Invalid package architecture.' >&2; exit 1; fi
  name=$(dpkg-deb --field "$package" Package)
  version=$(dpkg-deb --field "$package" Version)
  # APT's archive cache encodes the version epoch as %3a. Generate that filename
  # from package metadata, rather than relying on the supplied archive name.
  archive="${name}_${version//:/%3a}_${arch}.deb"
  if [[ -e $work/repository/$archive ]]; then echo 'Duplicate package version in bundle.' >&2; exit 1; fi
  ln -s "$package" "$work/repository/$archive"
  {
    dpkg-deb --field "$package"
    printf 'Filename: ./%s\nSize: %s\nSHA256: %s\n\n' "$archive" \
      "$(stat --format=%s "$package")" "$(sha256sum "$package" | cut -d ' ' -f 1)"
  } >> "$work/repository/Packages"
done
printf 'deb [trusted=yes] file:%s/repository ./\n' "$work" > "$work/sources.list"
dpkg-query --show --showformat='${binary:Package}\t${Version}\t${db:Status-Status}\n' > "$work/installed.tsv"
while IFS=$'\t' read -r name version status; do
  [[ $status == installed ]] || continue
  # The first matching specific pin wins. For installed packages, reject every
  # version except the current one, including newer versions in the local pool.
  printf 'Package: %s\nPin: version %s\nPin-Priority: 1001\n\nPackage: %s\nPin: version *\nPin-Priority: -1\n\n' \
    "$name" "$version" "$name" >> "$work/preferences"
done < "$work/installed.tsv"
: >> "$work/preferences"
requirements=(age python3 openssh-client ca-certificates curl openssl tzdata sudo)
if ! "$monitor"; then
  requirements+=(docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin certbot)
fi
missing=()
for name in "${requirements[@]}"; do
  status=$(dpkg-query --show --showformat='${db:Status-Status}' "$name" 2>/dev/null || true)
  if [[ $status != installed ]]; then missing+=("$name"); fi
done
if ((${#missing[@]})); then
  # All lists, sources, pins and archive-cache entries are private to this run.
  # file: is the only permitted transport. APT uses already verified .debs from
  # the local cache with downloads disabled, including for the simulated plan.
  apt_options=(
    -o "Dir::Etc::sourcelist=$work/sources.list" -o "Dir::Etc::sourceparts=$work/sourceparts"
    -o "Dir::Etc::preferences=$work/preferences" -o "Dir::Etc::preferencesparts=$work/preferencesparts"
    -o "Dir::State::lists=$work/lists" -o "Dir::Cache::archives=$work/repository"
    -o "Dir::Cache::pkgcache=$work/pkgcache.bin" -o "Dir::Cache::srcpkgcache=$work/srcpkgcache.bin"
    -o APT::Sandbox::User=root -o Acquire::Languages=none
    -o Acquire::AllowInsecureRepositories=false -o APT::Update::Error-Mode=any
  )
  apt-get "${apt_options[@]}" update
  apt-get "${apt_options[@]}" --simulate --no-download --no-remove --no-upgrade --no-install-recommends install "${missing[@]}" | tee "$work/plan"
  # Refuse any upgrade/configuration of existing packages even if a future APT
  # resolver changes its pin behavior. Removal is independently forbidden above.
  awk '
    NR == FNR {
      split($0, row, "\t")
      if (row[3] == "installed") { sub(/:.*/, "", row[1]); installed[row[1]] = 1 }
      next
    }
    $1 == "Inst" || $1 == "Conf" || $1 == "Remv" {
      name = $2; sub(/:.*/, "", name)
      if (name in installed) {
        print "Refusing to change installed package: " name > "/dev/stderr"; failed = 1
      }
    }
    END { exit failed }
  ' "$work/installed.tsv" "$work/plan"
  if ! "$simulate"; then
    DEBIAN_FRONTEND=noninteractive apt-get "${apt_options[@]}" --yes --no-download --no-remove --no-upgrade --no-install-recommends \
      -o Dpkg::Options::=--force-confold install "${missing[@]}"
  fi
else
  printf '%s\n' 'All required packages are already installed; no package changes needed.'
fi
if "$simulate"; then
  printf '%s\n' 'Offline package simulation passed. No packages or services changed.'
  exit 0
fi
if ! "$monitor"; then
  systemctl enable --now docker
  docker compose version
fi
age --version
python3 --version
curl --version >/dev/null
openssl version >/dev/null
ssh -V
printf '%s\n' 'Offline packages installed. Verify SSH remains reachable in a second session before changing any firewall.'
