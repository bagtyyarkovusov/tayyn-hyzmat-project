"""Check deployment safety through the apply interface, using fake external tools."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("release_apply", ROOT / "scripts/production/apply-release.py")
DEPLOY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DEPLOY)


class ReleaseApplyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.bundle = self.root / "next"
        self.bundle.mkdir()
        self.previous = self.root / "previous"
        self.previous.mkdir()
        self.current = self.root / "current"
        self.current.symlink_to(self.previous)
        self.env = self.root / "app.env"
        self.env.write_text("synthetic config")
        self.env.chmod(0o600)
        self.operations = self.root / "operations.json"
        self.operations.write_text(json.dumps({"role": "app", "project": "tayyn-production", "compose_dir": str(self.current)}))
        self.images = {role: {"id": "sha256:" + "a" * 64, "ref": f"tayyn-offline/{role}:test", "platform": "linux/amd64"}
                       for role in ("api", "web", "db", "proxy")}
        contents = {"images.tar": "synthetic images", "release.env": "synthetic refs",
                    "manifest.json": json.dumps({"schema": 1, "target": "ubuntu24.04-amd64", "images": self.images}),
                    "deploy/production/compose.production.yaml": "synthetic compose", "deploy/production/Caddyfile": "synthetic proxy"}
        for relative, content in contents.items():
            path = self.bundle / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
        (self.bundle / "SHA256SUMS").write_text("".join(f"{hashlib.sha256((self.bundle / relative).read_bytes()).hexdigest()}  {relative}\n" for relative in contents))
        self.args = argparse.Namespace(bundle=self.bundle, env_file=self.env, operations_config=self.operations,
                                       initialize=False, current_link=self.current)
        self.calls = []
        self.image_mismatch = False
        self.backup_failure = False

    def external_command(self, command, **kwargs):
        self.calls.append(command)
        output = ""
        if command[:2] == ["docker", "compose"] and command[-3:] == ["config", "--format", "json"]:
            services = {role: {"image": data["ref"]} for role, data in self.images.items()}
            services["api"]["environment"] = {"JWT_ACCESS_SECRET": "b" * 64, "JWT_REFRESH_SECRET": "c" * 64,
                                                 "SEED_ADMIN_PHONE": "+99365999999", "SEED_ADMIN_PASSWORD": "synthetic-password"}
            services["db"]["environment"] = {"POSTGRES_PASSWORD": "d" * 64}
            services["proxy"].update({"environment": {"DOMAIN": "dispatch.example.com"}, "volumes": [
                {"source": "/tmp/test-cert.pem", "target": "/etc/tayyn/tls/fullchain.pem"},
                {"source": "/tmp/test-key.pem", "target": "/etc/tayyn/tls/privkey.pem"}]})
            output = json.dumps({"services": services})
        elif command[:2] == ["docker", "info"]:
            output = str(self.root)
        elif command[:3] == ["docker", "image", "inspect"]:
            output = json.dumps([{"Id": "sha256:" + ("f" if self.image_mismatch else "a") * 64,
                                  "Architecture": "amd64", "Os": "linux"}])
        elif command[0] == "openssl" and ("-pubkey" in command or "-pubout" in command):
            output = "synthetic public key"
        elif command[0] == "python3" and command[-1] == "backup" and self.backup_failure:
            raise subprocess.CalledProcessError(1, command)
        return subprocess.CompletedProcess(command, 0, stdout=output, stderr="")

    def apply(self):
        with patch.object(DEPLOY.subprocess, "run", side_effect=self.external_command), \
             patch.object(DEPLOY.shutil, "disk_usage", return_value=SimpleNamespace(free=100 * 1024 ** 3)):
            DEPLOY.apply_release(self.args)

    def assert_no_migration_or_switch(self):
        self.assertFalse(any("migrate" in command for command in self.calls))
        self.assertEqual(self.current.resolve(), self.previous.resolve())

    def test_corrupted_bundle_is_rejected_before_any_docker_command(self):
        (self.bundle / "images.tar").write_text("corrupted transfer")
        with self.assertRaisesRegex(ValueError, "Checksum mismatch"):
            self.apply()
        self.assertEqual(self.calls, [])
        self.assert_no_migration_or_switch()

    def test_missing_backup_configuration_never_stops_current_services(self):
        self.args.operations_config = None
        with self.assertRaisesRegex(ValueError, "require --operations-config"):
            self.apply()
        self.assertFalse(any("stop" in command for command in self.calls))
        self.assertFalse(any(command[:2] == ["docker", "load"] for command in self.calls))
        self.assert_no_migration_or_switch()

    def test_failed_encrypted_backup_does_not_migrate_or_switch_release(self):
        self.backup_failure = True
        with self.assertRaises(subprocess.CalledProcessError):
            self.apply()
        self.assertTrue(any("stop" in command for command in self.calls))
        self.assertTrue(any(command[-1] == "backup" for command in self.calls))
        self.assert_no_migration_or_switch()

    def test_loaded_image_mismatch_is_rejected_before_maintenance(self):
        self.image_mismatch = True
        with self.assertRaisesRegex(ValueError, "image identity/platform"):
            self.apply()
        self.assertFalse(any("stop" in command for command in self.calls))
        self.assertFalse(any(command[-1] == "backup" for command in self.calls))
        self.assert_no_migration_or_switch()


if __name__ == "__main__":
    unittest.main()
