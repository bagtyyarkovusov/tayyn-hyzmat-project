"""Exercise the bundle export CLI with external Docker/package tools substituted."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
BUILDER = ROOT / "scripts/production/build-offline-bundle.py"


class BundleExportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.work = Path(self.temporary.name)
        binary = self.work / "bin"
        binary.mkdir()
        docker = binary / "docker"
        docker.write_text(f'''#!{sys.executable}
import json,os,sys
from pathlib import Path
args=sys.argv[1:]
if args[:2]==['image','inspect']:
 print(json.dumps([{{'Id':'sha256:'+'a'*64,'Os':'linux','Architecture':os.environ.get('FAKE_ARCH','amd64'),'Config':{{'Env':['PG_MAJOR=17']}}}}]))
elif args[0]=='save': Path(args[args.index('-o')+1]).write_bytes(b'synthetic docker archive')
elif args[0]!='tag': sys.exit(2)
''')
        docker.chmod(0o755)
        package_tool = binary / "dpkg-deb"
        package_tool.write_text(f"#!{sys.executable}\nprint('amd64')\n")
        package_tool.chmod(0o755)
        packages = self.work / "packages"
        packages.mkdir()
        (packages / "age_1.0_amd64.deb").write_bytes(b"synthetic package")
        self.environment = {**os.environ, "PATH": str(binary) + os.pathsep + os.environ["PATH"]}
        self.output = self.work / "release"
        self.command = [sys.executable, str(BUILDER), "--release", "test-release", "--api", "api:test",
                        "--web", "web:test", "--db", "db:test", "--proxy", "proxy:test",
                        "--deb-dir", str(packages), "--monitor-deb-dir", str(packages), "--output-dir", str(self.output)]

    def run_builder(self, **environment):
        return subprocess.run(self.command, env={**self.environment, **environment}, text=True, capture_output=True)

    def test_export_records_image_identity_and_checksums_without_runtime_credentials(self):
        result = self.run_builder()
        self.assertEqual(result.returncode, 0, result.stderr)
        manifest = json.loads((self.output / "manifest.json").read_text())
        self.assertEqual(manifest["images"]["api"]["id"], "sha256:" + "a" * 64)
        self.assertEqual(manifest["images"]["api"]["ref"], "tayyn-offline/api:test-release")
        self.assertFalse(manifest["packageDependencyClosureVerified"])
        self.assertTrue((self.output / "images.tar").is_file())
        self.assertFalse((self.output / ".env").exists())
        self.assertFalse((self.output / ".local").exists())
        monitor = self.output.with_name(self.output.name + "-monitor")
        self.assertTrue((monitor / "packages-monitor/age_1.0_amd64.deb").is_file())
        self.assertFalse((monitor / "images.tar").exists())
        self.assertFalse((monitor / "packages").exists())
        self.assertEqual(json.loads((monitor / "manifest.json").read_text())["role"], "monitor")
        self.assertTrue((self.output / "deploy/monitoring/monitor-secrets.example.json").is_file())
        for row in (self.output / "SHA256SUMS").read_text().splitlines():
            expected, relative = row.split("  ", 1)
            self.assertEqual(hashlib.sha256((self.output / relative).read_bytes()).hexdigest(), expected)

    def test_wrong_platform_fails_before_creating_an_export(self):
        result = self.run_builder(FAKE_ARCH="arm64")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must be linux/amd64", result.stderr)
        self.assertFalse(self.output.exists())

    def test_existing_release_is_never_overwritten(self):
        self.output.mkdir()
        sentinel = self.output / "keep"
        sentinel.write_text("existing release")
        result = self.run_builder()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(sentinel.read_text(), "existing release")


if __name__ == "__main__":
    unittest.main()
