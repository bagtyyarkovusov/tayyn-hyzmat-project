"""Real APT resolution in a disposable Ubuntu 24.04 amd64 container.

Pull ubuntu:24.04 on a connected builder first, then run:
TAYYN_OFFLINE_APT_INTEGRATION=1 python3 -m unittest discover -s scripts/tests -p 'test_offline_packages_integration.py'
The container has networking disabled and no writable host mounts. This tests
package resolution and refusal of OS upgrades, not systemd boot or real VPS SSH.
"""
import os
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = r'''
set -euo pipefail
mkdir -p /tmp/bundle/scripts/production /tmp/bundle/packages-monitor /tmp/fixture
cp /installer.sh /tmp/bundle/scripts/production/install-offline-packages.sh
build() {
  local name=$1 version=$2 output=$3 depends=${4:-}
  local path=/tmp/fixture/$name-$version
  mkdir -p "$path/DEBIAN"
  printf 'Package: %s\nVersion: %s\nArchitecture: all\nMaintainer: Fixture <fixture@example.invalid>\nDescription: disposable dependency fixture\n' "$name" "$version" > "$path/DEBIAN/control"
  if [[ -n $depends ]]; then printf 'Depends: %s\n' "$depends" >> "$path/DEBIAN/control"; fi
  case $name in
    age|python3|curl|openssl|openssh-client)
      executable=$name
      [[ $name != openssh-client ]] || executable=ssh
      mkdir -p "$path/usr/bin"
      printf '#!/bin/sh\nexit 0\n' > "$path/usr/bin/$executable"
      chmod +x "$path/usr/bin/$executable"
      ;;
  esac
  dpkg-deb --build "$path" "$output" >/dev/null
}
build systemd 255.4-1ubuntu8.13 /tmp/systemd.deb
build systemd-sysv 255.4-1ubuntu8.13 /tmp/init.deb 'systemd (= 255.4-1ubuntu8.13)'
build openssh-client 1:9.6p1-3ubuntu13.16 /tmp/client.deb
build openssh-server 1:9.6p1-3ubuntu13.16 /tmp/server.deb 'openssh-client (= 1:9.6p1-3ubuntu13.16)'
dpkg --install /tmp/systemd.deb /tmp/init.deb /tmp/client.deb /tmp/server.deb >/dev/null
for name in age python3 ca-certificates curl openssl tzdata sudo; do
  status=$(dpkg-query --show --showformat='${db:Status-Status}' "$name" 2>/dev/null || true)
  if [[ $status != installed ]]; then build "$name" 1 "/tmp/bundle/packages-monitor/${name}_1_all.deb"; fi
done
build systemd 255.4-1ubuntu8.14 /tmp/bundle/packages-monitor/systemd_new_all.deb
build openssh-client 1:9.6p1-3ubuntu13.17 /tmp/bundle/packages-monitor/openssh-client_new_all.deb
cd /tmp/bundle
checksum() { find scripts packages-monitor -type f -exec sha256sum {} \; > SHA256SUMS; }
checksum
cp /var/lib/dpkg/status /tmp/original-status
bash scripts/production/install-offline-packages.sh --monitor --simulate --bundle /tmp/bundle > /tmp/result
cat /tmp/result
if grep -Eq '^(Inst|Conf|Remv) (systemd|openssh-)' /tmp/result; then echo 'FAIL: modified provider packages'; exit 1; fi
cmp /tmp/original-status /var/lib/dpkg/status
echo 'PASS: matching provider SSH/init remain unchanged'
for dependency in 'systemd (>= 255.4-1ubuntu8.14)' 'openssh-client (>= 1:9.6p1-3ubuntu13.17)'; do
  build age 1 /tmp/bundle/packages-monitor/age_1_all.deb "$dependency"
  checksum
  if bash scripts/production/install-offline-packages.sh --monitor --simulate --bundle /tmp/bundle >/tmp/failed-result 2>&1; then
    echo 'FAIL: incompatible dependency accepted'; exit 1
  fi
  cat /tmp/failed-result
  cmp /tmp/original-status /var/lib/dpkg/status
  echo "PASS: required OS upgrade rejected: $dependency"
done
build age 1 /tmp/bundle/packages-monitor/age_1_all.deb
checksum
bash scripts/production/install-offline-packages.sh --monitor --bundle /tmp/bundle
[[ $(dpkg-query --show --showformat='${Version}' age) == 1 ]]
[[ $(dpkg-query --show --showformat='${Version}' systemd) == 255.4-1ubuntu8.13 ]]
[[ $(dpkg-query --show --showformat='${Version}' openssh-client) == 1:9.6p1-3ubuntu13.16 ]]
[[ $(dpkg-query --show --showformat='${db:Status-Status}' openssh-server) == installed ]]
echo 'PASS: offline installation adds missing tools and preserves SSH/init'
'''


@unittest.skipUnless(os.environ.get("TAYYN_OFFLINE_APT_INTEGRATION") == "1",
                     "Requires pre-pulled disposable Ubuntu amd64 Docker image")
class OfflinePackageIntegrationTests(unittest.TestCase):
    def test_dependency_pool_preserves_provider_packages_and_rejects_required_upgrades(self):
        result = subprocess.run([
            "docker", "run", "--rm", "--pull", "never", "--platform", "linux/amd64",
            "--network", "none", "--volume",
            f"{ROOT / 'scripts/production/install-offline-packages.sh'}:/installer.sh:ro",
            "ubuntu:24.04", "bash", "-c", FIXTURE,
        ], text=True, capture_output=True, timeout=180)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("PASS: matching provider SSH/init remain unchanged", result.stdout)
        self.assertIn("PASS: required OS upgrade rejected: systemd", result.stdout)
        self.assertIn("PASS: required OS upgrade rejected: openssh-client", result.stdout)
        self.assertIn("PASS: offline installation adds missing tools and preserves SSH/init", result.stdout)


if __name__ == "__main__":
    unittest.main()
