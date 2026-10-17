"""Check deployment safety through the apply interface, using fake external tools."""
import argparse
import hashlib
import io
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import tarfile
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
                    "deploy/production/compose.production.yaml": "synthetic compose", "deploy/production/Caddyfile": "synthetic proxy",
                    "deploy/production/compose.automatic-tls.yaml": "synthetic automatic override",
                    "deploy/production/Caddyfile.automatic": "synthetic automatic proxy"}
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
        self.tls_mode = "external"
        self.tls_email = "operator@example.com"
        self.curl_failures = 0
        self.saved_config = None

    def external_command(self, command, **kwargs):
        self.calls.append(command)
        output = ""
        if command[:2] == ["docker", "compose"] and command[-3:] == ["config", "--format", "json"]:
            services = {role: {"image": data["ref"]} for role, data in self.images.items()}
            services["api"]["environment"] = {"JWT_ACCESS_SECRET": "b" * 64, "JWT_REFRESH_SECRET": "c" * 64,
                                                 "SEED_ADMIN_PHONE": "+99365999999", "SEED_ADMIN_PASSWORD": "synthetic-password"}
            services["db"]["environment"] = {"POSTGRES_PASSWORD": "d" * 64}
            services["proxy"].update({"environment": {"DOMAIN": "dispatch.example.com", "TLS_MODE": self.tls_mode, "TLS_EMAIL": self.tls_email}, "volumes": [
                {"source": "/tmp/test-cert.pem", "target": "/etc/tayyn/tls/fullchain.pem"},
                {"source": "/tmp/test-key.pem", "target": "/etc/tayyn/tls/privkey.pem"}]})
            output = json.dumps({"services": services})
        elif command[:2] == ["docker", "info"]:
            output = str(self.root)
        elif command[:3] == ["docker", "image", "inspect"]:
            output = json.dumps([{"Id": "sha256:" + ("f" if self.image_mismatch else "a") * 64,
                                  "Architecture": "amd64", "Os": "linux"}])
        elif command[:2] == ["docker", "save"]:
            self.write_image_archive(Path(command[command.index("-o") + 1]), command[-1], self.saved_config)
        elif command[0] == "openssl" and ("-pubkey" in command or "-pubout" in command):
            output = "synthetic public key"
        elif command[0] == "curl" and self.curl_failures:
            self.curl_failures -= 1
            raise subprocess.CalledProcessError(1, command)
        elif "SELECT count(*) FROM pg_tables WHERE schemaname='public'" in command:
            output = "0"
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

    def write_image_archive(self, path, reference, config):
        manifest = json.dumps([{"Config": "config.json", "RepoTags": [reference], "Layers": []}]).encode()
        with tarfile.open(path, "w") as archive:
            for name, payload in (("manifest.json", manifest), ("config.json", config)):
                member = tarfile.TarInfo(name)
                member.size = len(payload)
                archive.addfile(member, io.BytesIO(payload))

    def use_portable_image_identity(self, loaded_config):
        self.image_mismatch = True
        self.saved_config = loaded_config
        self.write_image_archive(self.bundle / "images.tar", self.images["api"]["ref"], b'{"architecture":"amd64","os":"linux","config":{"Env":["EXPECTED=1"]}}')
        lines = (self.bundle / "SHA256SUMS").read_text().splitlines()
        digest = hashlib.sha256((self.bundle / "images.tar").read_bytes()).hexdigest()
        (self.bundle / "SHA256SUMS").write_text("\n".join(digest + "  images.tar" if line.endswith("  images.tar") else line for line in lines) + "\n")

    def test_containerd_image_identity_matches_exact_saved_config_before_maintenance(self):
        self.use_portable_image_identity(b'{"architecture":"amd64","os":"linux","config":{"Env":["EXPECTED=1"]}}')
        # Only the API uses the alternate image-store ID in this synthetic daemon.
        original = self.external_command
        def external(command, **kwargs):
            self.image_mismatch = command[-1] == self.images["api"]["ref"]
            return original(command, **kwargs)
        with patch.object(DEPLOY.subprocess, "run", side_effect=external), \
             patch.object(DEPLOY.shutil, "disk_usage", return_value=SimpleNamespace(free=100 * 1024 ** 3)):
            DEPLOY.apply_release(self.args)
        saved = next(index for index, command in enumerate(self.calls) if command[:2] == ["docker", "save"])
        stopped = next(index for index, command in enumerate(self.calls) if "stop" in command)
        self.assertLess(saved, stopped)
        self.assertEqual(self.current.resolve(), self.bundle.resolve())

    def test_containerd_platform_match_does_not_allow_different_config(self):
        self.use_portable_image_identity(b'{"architecture":"amd64","os":"linux","config":{"Env":["UNEXPECTED=1"]}}')
        with self.assertRaisesRegex(ValueError, "image identity/platform"):
            self.apply()
        self.assertFalse(any("stop" in command for command in self.calls))
        self.assert_no_migration_or_switch()

    def test_containerd_verification_rejects_duplicate_config_metadata_before_maintenance(self):
        config = b'{"architecture":"amd64","os":"linux"}'
        self.use_portable_image_identity(config)
        with tarfile.open(self.bundle / "images.tar", "a") as archive:
            duplicate = tarfile.TarInfo("config.json")
            duplicate.size = len(config)
            archive.addfile(duplicate, io.BytesIO(config))
        lines = (self.bundle / "SHA256SUMS").read_text().splitlines()
        digest = hashlib.sha256((self.bundle / "images.tar").read_bytes()).hexdigest()
        (self.bundle / "SHA256SUMS").write_text("\n".join(digest + "  images.tar" if line.endswith("  images.tar") else line for line in lines) + "\n")
        with self.assertRaisesRegex(ValueError, "image identity/platform"):
            self.apply()
        self.assertFalse(any("stop" in command for command in self.calls))
        self.assert_no_migration_or_switch()

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

    def test_automatic_tls_initialization_retries_https_without_repeating_seed_or_migrations(self):
        self.tls_mode = "automatic"
        self.args.initialize = True
        self.curl_failures = 2
        with patch.object(DEPLOY.time, "sleep"):
            self.apply()
        self.assertEqual(self.current.resolve(), self.bundle.resolve())
        self.assertFalse(any(command[0] == "openssl" for command in self.calls))
        self.assertEqual(sum(command[0] == "curl" for command in self.calls), 3)
        self.assertEqual(sum(command[-1] == "migrate" for command in self.calls), 1)
        self.assertEqual(sum(command[-1] == "prisma/seed.js" for command in self.calls), 1)
        startup = next(command for command in self.calls if command[-3:] == ["api", "web", "proxy"])
        self.assertIn(str(self.bundle.resolve() / "deploy/production/compose.automatic-tls.yaml"), startup)

    def test_automatic_tls_rejects_missing_email_before_loading_images_or_migrating(self):
        self.tls_mode = "automatic"
        self.tls_email = ""
        self.args.initialize = True
        with self.assertRaisesRegex(ValueError, "TLS_EMAIL"):
            self.apply()
        self.assertFalse(any(command[:2] == ["docker", "load"] for command in self.calls))
        self.assert_no_migration_or_switch()

    def test_automatic_tls_update_rejects_untrusted_serving_certificate_before_maintenance(self):
        self.tls_mode = "automatic"
        with patch.object(DEPLOY.socket, "create_connection", side_effect=DEPLOY.ssl.SSLError("synthetic untrusted certificate")):
            with self.assertRaises(DEPLOY.ssl.SSLError):
                self.apply()
        self.assertFalse(any(command[:2] == ["docker", "load"] for command in self.calls))
        self.assert_no_migration_or_switch()

    def test_automatic_tls_update_rejects_certificate_expiring_within_seven_days(self):
        from unittest.mock import MagicMock
        self.tls_mode = "automatic"
        secure = MagicMock()
        secure.getpeercert.return_value = {"notAfter": "Jan  6 00:00:00 1970 GMT"}
        context = MagicMock()
        context.wrap_socket.return_value.__enter__.return_value = secure
        with patch.object(DEPLOY.socket, "create_connection", return_value=MagicMock()), \
             patch.object(DEPLOY.ssl, "create_default_context", return_value=context), patch.object(DEPLOY.time, "time", return_value=0):
            with self.assertRaisesRegex(ValueError, "within seven days"):
                self.apply()
        self.assertFalse(any(command[:2] == ["docker", "load"] for command in self.calls))
        self.assert_no_migration_or_switch()

    def test_automatic_tls_https_timeout_keeps_previous_release_current_without_repeating_database_writes(self):
        self.tls_mode = "automatic"
        self.args.initialize = True
        self.curl_failures = 10
        with patch.object(DEPLOY.time, "monotonic", side_effect=[0, 181]), patch.object(DEPLOY.time, "sleep") as pause:
            with self.assertRaises(subprocess.CalledProcessError):
                self.apply()
        self.assertEqual(self.current.resolve(), self.previous.resolve())
        self.assertEqual(sum(command[-1] == "migrate" for command in self.calls), 1)
        self.assertEqual(sum(command[-1] == "prisma/seed.js" for command in self.calls), 1)
        pause.assert_not_called()

    def test_default_external_certificate_mode_retains_local_hostname_expiry_and_key_checks(self):
        self.apply()
        certificate_checks = [command for command in self.calls if command[:2] == ["openssl", "x509"]]
        self.assertTrue(any("-checkend" in command and "604800" in command for command in certificate_checks))
        self.assertTrue(any("-checkhost" in command and "dispatch.example.com" in command for command in certificate_checks))
        self.assertTrue(any(command[:2] == ["openssl", "pkey"] for command in self.calls))
        self.assertEqual(self.current.resolve(), self.bundle.resolve())


if __name__ == "__main__":
    unittest.main()
