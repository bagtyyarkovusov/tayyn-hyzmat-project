"""Exercise the release CLI with disposable files and synthetic OS/tool boundaries.

No Docker daemon, database, network, elevated privileges or production configuration
is used. The host facade exists only in child interpreters; release code is not
imported or patched. Executable fixtures model the effects of external tools.
"""
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/production/apply-release.py"
CONFIG = b'{"architecture":"amd64","os":"linux","config":{"Env":["EXPECTED=1"]}}'

# The public CLI requires a privileged Ubuntu host. Redirect only these host
# interfaces, plus TLS and time, inside the isolated child process.
HOST = r'''
import builtins, json, os, pathlib, shutil, socket, ssl, subprocess, time
from collections import namedtuple
root = pathlib.Path(os.environ["RELEASE_TEST_ROOT"])
def options():
    return json.loads((root / "options.json").read_text())
os.geteuid = lambda: 0
read_text = pathlib.Path.read_text
def host_text(path, *args, **kwargs):
    if str(path) == "/etc/os-release":
        return 'ID=ubuntu\nVERSION_ID="24.04"\n'
    return read_text(path, *args, **kwargs)
pathlib.Path.read_text = host_text
original_open = builtins.open
def host_open(path, *args, **kwargs):
    if str(path) == "/run/lock/tayyn-deploy.lock":
        path = root / "deploy.lock"
    return original_open(path, *args, **kwargs)
builtins.open = host_open
shutil.disk_usage = lambda path: namedtuple("usage", "total used free")(200 * 1024**3, 10 * 1024**3, 190 * 1024**3)
class Connection:
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def getpeercert(self):
        days = options().get("certificate_days", 90)
        return {"notAfter": time.strftime("%b %d %H:%M:%S %Y GMT", time.gmtime(time.time() + days * 86400))}
class Context:
    def wrap_socket(self, *args, **kwargs):
        if options().get("untrusted_certificate"):
            raise ssl.SSLError("synthetic untrusted certificate")
        return Connection()
socket.create_connection = lambda *args, **kwargs: Connection()
ssl.create_default_context = lambda: Context()
monotonic = time.monotonic
elapsed = 0
def advance(seconds):
    global elapsed
    elapsed += seconds
time.sleep = advance
time.monotonic = lambda: monotonic() + elapsed
'''

TOOL = r'''
import io, json, os, pathlib, sys, tarfile
root = pathlib.Path(os.environ["RELEASE_TEST_ROOT"])
options = json.loads((root / "options.json").read_text())
state_path = root / "state.json"
state = json.loads(state_path.read_text())
def save(): state_path.write_text(json.dumps(state))
def refuse(message):
    print(message, file=sys.stderr)
    sys.exit(1)
args = sys.argv[1:]
tool = pathlib.Path(sys.argv[0]).name
if tool == "dpkg":
    print("amd64")
elif tool == "openssl":
    if "-checkend" in args and options.get("certificate_days", 90) < 7:
        refuse("expired fixture certificate")
    if "-checkhost" in args and options.get("wrong_hostname"):
        refuse("fixture certificate hostname mismatch")
    if "-pubkey" in args or "-pubout" in args:
        print("other key" if "-pubout" in args and options.get("wrong_key") else "fixture public key")
elif tool == "curl":
    remaining = state.get("https_failures", 0)
    if remaining:
        state["https_failures"] = remaining - 1
        save()
        refuse("fixture HTTPS unavailable")
    print('{"status":"ok"}')
elif tool == "age":
    if options.get("encryption_failure"):
        refuse("fixture encryption failed")
    sys.stdout.buffer.write(b"age-encryption.org/v1\n" + b"x" * 120 + sys.stdin.buffer.read())
elif tool == "docker":
    if args[0] == "info":
        print(root)
    elif args[0] == "load":
        state["images_loaded"] = True
        save()
    elif args[:2] == ["image", "inspect"]:
        image = {"Id": "sha256:" + "a" * 64, "Architecture": "amd64", "Os": "linux"}
        if args[-1].endswith("/api:test"):
            image["Id"] = "sha256:" + ("f" if options.get("portable_identity") else "a") * 64
            image["Architecture"] = options.get("image_arch", "amd64")
        print(json.dumps([image]))
    elif args[0] == "save":
        config = options.get("loaded_config", '{}').encode()
        manifest = json.dumps([{"Config": "config.json", "RepoTags": [args[-1]], "Layers": []}]).encode()
        with tarfile.open(args[args.index("-o") + 1], "w") as archive:
            for name, payload in [("manifest.json", manifest), ("config.json", config)]:
                member = tarfile.TarInfo(name)
                member.size = len(payload)
                archive.addfile(member, io.BytesIO(payload))
    elif args[0] == "compose":
        if "config" in args:
            services = {role: {"image": "tayyn-offline/" + role + ":test"} for role in ["api", "web", "db", "proxy"]}
            services["api"]["environment"] = {"JWT_ACCESS_SECRET": "b" * 64, "JWT_REFRESH_SECRET": "c" * 64,
                "SEED_ADMIN_PHONE": "+99365999999", "SEED_ADMIN_PASSWORD": "synthetic-password"}
            services["db"]["environment"] = {"POSTGRES_PASSWORD": "d" * 64}
            services["proxy"].update(environment={"DOMAIN": "dispatch.example.com", "TLS_MODE": options.get("tls_mode", "external"),
                "TLS_EMAIL": options.get("tls_email", "operator@example.com")}, volumes=[
                {"source": str(root / "cert.pem"), "target": "/etc/tayyn/tls/fullchain.pem"},
                {"source": str(root / "key.pem"), "target": "/etc/tayyn/tls/privkey.pem"}])
            print(json.dumps({"services": services}))
        elif "stop" in args:
            state["writers_running"] = False
            save()
        elif "pg_dump" in args:
            if state["writers_running"] or options.get("dump_failure"):
                refuse("fixture database cannot be safely backed up")
            print(json.dumps({"schema": state["schema"], "ledger": state["ledger"]}))
        elif "migrate" in args:
            if not options.get("initialize") and not list((root / "backups").glob("*.dump.age")):
                refuse("fixture refuses migration without a completed encrypted backup")
            state["schema"] += 1
            save()
        elif "prisma/seed.js" in args:
            state["admins"].append("configured-admin")
            state["regions"].extend(["canonical-region-" + str(i) for i in range(1, 10)])
            save()
        elif "psql" in args:
            print("0" if "pg_tables" in args[-1] else "1")
        elif "up" in args:
            if "api" in args:
                state["writers_running"] = True
                state["automatic_proxy"] = any(path.endswith("compose.automatic-tls.yaml") for path in args)
                save()
        else:
            refuse("unsupported fixture Compose operation")
    else:
        refuse("unsupported fixture Docker operation")
else:
    refuse("unsupported fixture executable")
'''


class ReleaseApplyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.bundle = self.root / "next"
        self.bundle.mkdir()
        self.previous = self.root / "previous"
        self.previous.mkdir()
        self.current = self.root / "current"
        self.current.symlink_to(self.previous)
        self.env_file = self.root / "app.env"
        self.env_file.write_text("synthetic config")
        self.env_file.chmod(0o600)
        self.options = {}
        self.initial_state = {"writers_running": True, "images_loaded": False, "schema": 1,
                              "ledger": [{"order": 7, "amount": "15.50"}], "admins": [], "regions": []}
        (self.root / "state.json").write_text(json.dumps(self.initial_state))
        self.operations = self.root / "operations.json"
        self.operations.write_text(json.dumps({"role": "app", "project": "tayyn-production", "compose_dir": str(self.current),
            "backup_dir": str(self.root / "backups"), "state_dir": str(self.root / "operations"), "age_recipient": "age1" + "a" * 58}))
        self.operations.chmod(0o600)
        images = {role: {"id": "sha256:" + "a" * 64, "ref": f"tayyn-offline/{role}:test", "platform": "linux/amd64"}
                  for role in ("api", "web", "db", "proxy")}
        contents = {"release.env": "synthetic refs", "manifest.json": json.dumps({"schema": 1, "target": "ubuntu24.04-amd64", "images": images}),
                    "deploy/production/compose.production.yaml": "synthetic compose", "deploy/production/Caddyfile": "synthetic proxy",
                    "deploy/production/compose.automatic-tls.yaml": "synthetic automatic override", "deploy/production/Caddyfile.automatic": "synthetic automatic proxy"}
        for relative, content in contents.items():
            path = self.bundle / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
        target = self.bundle / "scripts/production/operations.py"
        target.parent.mkdir(parents=True)
        shutil.copy2(ROOT / "scripts/production/operations.py", target)
        self.write_image_archive()
        self.checksums()
        self.tools = self.root / "tools"
        self.tools.mkdir()
        for name in ("docker", "openssl", "curl", "dpkg", "age"):
            path = self.tools / name
            path.write_text("#!" + sys.executable + "\n" + TOOL)
            path.chmod(0o700)
        (self.tools / "python3").symlink_to(sys.executable)
        (self.tools / "sitecustomize.py").write_text(HOST)

    def write_image_archive(self, duplicate=False):
        manifest = json.dumps([{"Config": "config.json", "RepoTags": ["tayyn-offline/api:test"], "Layers": []}]).encode()
        with tarfile.open(self.bundle / "images.tar", "w") as archive:
            for name, payload in [("manifest.json", manifest), ("config.json", CONFIG)] + ([("config.json", CONFIG)] if duplicate else []):
                member = tarfile.TarInfo(name)
                member.size = len(payload)
                archive.addfile(member, io.BytesIO(payload))

    def checksums(self):
        files = sorted(path for path in self.bundle.rglob("*") if path.is_file() and path.name != "SHA256SUMS")
        (self.bundle / "SHA256SUMS").write_text("".join(
            f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.relative_to(self.bundle).as_posix()}\n" for path in files))

    def apply(self, initialize=False, backup_config=True):
        self.options["initialize"] = initialize
        (self.root / "options.json").write_text(json.dumps(self.options))
        args = [sys.executable, str(SCRIPT), "--bundle", str(self.bundle), "--env-file", str(self.env_file), "--current-link", str(self.current)]
        if initialize:
            args.append("--initialize")
        elif backup_config:
            args += ["--operations-config", str(self.operations)]
        result = subprocess.run(args, env={**os.environ, "PATH": str(self.tools) + os.pathsep + os.environ["PATH"],
            "PYTHONPATH": str(self.tools), "PYTHONDONTWRITEBYTECODE": "1", "RELEASE_TEST_ROOT": str(self.root)},
            capture_output=True, text=True, timeout=20)
        self.assertNotIn("synthetic-password", result.stdout + result.stderr)
        return result

    def state(self):
        return json.loads((self.root / "state.json").read_text())

    def assert_failed(self, result, before_maintenance=True):
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("Release failed:", result.stderr)
        self.assertIn("No automatic database restore was attempted", result.stderr)
        self.assertEqual(self.current.resolve(), self.previous)
        state = self.state()
        self.assertEqual(state["schema"], 1)
        self.assertEqual(state["ledger"], [{"order": 7, "amount": "15.50"}])
        if before_maintenance:
            self.assertTrue(state["writers_running"])

    def assert_started(self, result):
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Release started and current link updated", result.stdout)
        self.assertEqual(self.current.resolve(), self.bundle)
        self.assertEqual(self.state()["schema"], 2)
        self.assertTrue(self.state()["writers_running"])

    def test_update_preserves_ledger_and_creates_encrypted_pre_migration_backup(self):
        self.assert_started(self.apply())
        archives = list((self.root / "backups").glob("*.dump.age"))
        self.assertEqual(len(archives), 1)
        archive = archives[0].read_bytes()
        self.assertTrue(archive.startswith(b"age-encryption.org/v1\n"))
        self.assertIn(b'"schema": 1', archive)
        self.assertIn(b'"order": 7, "amount": "15.50"', archive)
        self.assertEqual(self.state()["ledger"], [{"order": 7, "amount": "15.50"}])

    def test_containerd_identity_accepts_matching_saved_image_config(self):
        self.options.update(portable_identity=True, loaded_config=CONFIG.decode())
        self.assert_started(self.apply())

    def test_containerd_identity_rejects_different_saved_image_config(self):
        self.options.update(portable_identity=True, loaded_config='{"architecture":"amd64","os":"linux","config":{"Env":["UNEXPECTED=1"]}}')
        self.assert_failed(self.apply())

    def test_containerd_identity_rejects_duplicate_archive_config(self):
        self.options.update(portable_identity=True, loaded_config=CONFIG.decode())
        self.write_image_archive(duplicate=True)
        self.checksums()
        self.assert_failed(self.apply())

    def test_corrupted_bundle_preserves_current_release_and_running_services(self):
        (self.bundle / "images.tar").write_text("corrupted transfer")
        self.assert_failed(self.apply())
        self.assertFalse(self.state()["images_loaded"])

    def test_missing_backup_configuration_preserves_running_services(self):
        self.assert_failed(self.apply(backup_config=False))
        self.assertFalse(self.state()["images_loaded"])

    def test_failed_backup_leaves_database_and_release_unchanged(self):
        for failure in ("dump_failure", "encryption_failure"):
            with self.subTest(failure=failure):
                self.options = {failure: True}
                self.assert_failed(self.apply(), before_maintenance=False)
                self.assertFalse(self.state()["writers_running"])
                self.assertEqual(list((self.root / "backups").glob("*.dump.age")), [])
                self.assertEqual(list((self.root / "backups").glob("*.partial")), [])

    def test_arm_image_is_rejected_before_maintenance(self):
        self.options["image_arch"] = "arm64"
        self.assert_failed(self.apply())

    def test_automatic_tls_waits_for_https_with_one_clean_bootstrap(self):
        self.options["tls_mode"] = "automatic"
        state = self.state()
        state["https_failures"] = 2
        (self.root / "state.json").write_text(json.dumps(state))
        self.assert_started(self.apply(initialize=True))
        self.assertEqual(self.state()["admins"], ["configured-admin"])
        self.assertEqual(self.state()["regions"], [f"canonical-region-{i}" for i in range(1, 10)])
        self.assertTrue(self.state()["automatic_proxy"])

    def test_automatic_tls_requires_contact_email_before_maintenance(self):
        self.options.update(tls_mode="automatic", tls_email="")
        self.assert_failed(self.apply(initialize=True))
        self.assertFalse(self.state()["images_loaded"])

    def test_automatic_tls_update_rejects_untrusted_certificate(self):
        self.options.update(tls_mode="automatic", untrusted_certificate=True)
        self.assert_failed(self.apply())
        self.assertFalse(self.state()["images_loaded"])

    def test_automatic_tls_update_rejects_expiring_certificate(self):
        self.options.update(tls_mode="automatic", certificate_days=3)
        self.assert_failed(self.apply())
        self.assertFalse(self.state()["images_loaded"])

    def test_https_timeout_keeps_previous_release_and_bootstrap_data(self):
        self.options["tls_mode"] = "automatic"
        state = self.state()
        state["https_failures"] = 1000
        (self.root / "state.json").write_text(json.dumps(state))
        result = self.apply(initialize=True)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("Release failed:", result.stderr)
        self.assertEqual(self.current.resolve(), self.previous)
        self.assertEqual(self.state()["schema"], 2)
        self.assertEqual(self.state()["admins"], ["configured-admin"])
        self.assertEqual(len(self.state()["regions"]), 9)

    def test_external_tls_rejects_expiry_hostname_and_key_mismatch(self):
        for failure in ({"certificate_days": 3}, {"wrong_hostname": True}, {"wrong_key": True}):
            with self.subTest(failure=failure):
                self.options = failure
                self.assert_failed(self.apply())
                self.assertFalse(self.state()["images_loaded"])


if __name__ == "__main__":
    unittest.main()
