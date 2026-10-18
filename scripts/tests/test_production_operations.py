"""Public operations CLI tests with local files and substituted OS/provider boundaries.

No production module is imported. The child bootstrap replaces only stdlib clock,
disk, HTTPS/certificate and SMTP boundaries; synthetic executables replace SSH,
Docker and age. Real encryption/database restore is covered by the opt-in drill.
"""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).parents[1] / "production" / "operations.py"
START = int(dt.datetime(2026, 10, 17, 4, tzinfo=dt.timezone.utc).timestamp())

# Execute the unmodified CLI in its own process. Each fake is an external
# boundary, and rejects unexpected destinations instead of opening a network.
BOOTSTRAP = r'''
import collections, datetime, json, os, runpy, shutil, smtplib, socket, ssl, sys, time, urllib.request
from pathlib import Path
root = Path(os.environ["OPERATIONS_FIXTURE"])
control = json.loads((root / "control.json").read_text())
time.time = lambda: control["now"]
class Clock(datetime.datetime):
    @classmethod
    def now(cls, tz=None): return cls.fromtimestamp(control["now"], tz)
datetime.datetime = Clock
shutil.disk_usage = lambda path: collections.namedtuple("usage", "total used free")(100, 50, 50)
def record(value):
    with (root / "smtp.jsonl").open("a") as stream:
        stream.write(json.dumps(value) + "\n")
def verified(context):
    if not context.check_hostname or context.verify_mode != ssl.CERT_REQUIRED:
        raise ValueError("Unverified TLS context")
class Connection:
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def getpeercert(self): return {"notAfter": "Jan 15 00:00:00 2027 GMT"}
def connect(address, **kwargs):
    if address != ("synthetic.test", 443): raise OSError("Unexpected destination")
    return Connection()
socket.create_connection = connect
def wrap(context, raw, server_hostname):
    verified(context)
    if server_hostname != "synthetic.test": raise OSError("Unexpected TLS host")
    return Connection()
ssl.SSLContext.wrap_socket = wrap
class Response(Connection):
    status = 200
    def __init__(self, url):
        self.url = url
        self.headers = {"Content-Type": "application/json" if url.endswith("/health") else "text/html"}
    def read(self, limit):
        if "/socket.io/" in self.url: return b'0{"sid":"synthetic","upgrades":["websocket"]}'
        if self.url.endswith("/health"):
            return b'{"error":"unavailable"}' if control.get("bad_health") else b'{"status":"ok"}'
        return b"<html>synthetic dashboard</html>"
class Opener:
    def open(self, url, **kwargs):
        if not isinstance(url, str) or not url.startswith("https://synthetic.test/"):
            raise OSError("Unexpected HTTP destination")
        return Response(url)
urllib.request.build_opener = lambda *args: Opener()
class SMTP(Connection):
    def __init__(self, host, port, timeout, context=None):
        if host != "smtp.synthetic.test": raise OSError("Unexpected SMTP host")
        self.secure = context is not None
        if context is not None: verified(context)
        record({"stage": "connect", "port": port, "verified_tls": self.secure})
    def ehlo(self): return 250, b"OK"
    def starttls(self, context):
        verified(context)
        record({"stage": "starttls", "verified_tls": True})
        if control.get("smtp_failure") == "starttls":
            raise ssl.SSLError("synthetic-private-provider-response")
        self.secure = True
    def login(self, username, password):
        if not self.secure: raise ValueError("Credentials before TLS")
        record({"stage": "authenticated"})
    def send_message(self, message, **kwargs):
        if not self.secure: raise ValueError("Message before TLS")
        record({"stage": "message", "to": message["To"], "subject": message["Subject"],
                "id": message["Message-ID"], "body": message.get_content()})
        if control.get("smtp_failure") == "reject": return {"operator@synthetic.test": (550, b"synthetic-private-provider-response")}
        if control.get("smtp_failure") == "disconnect": raise OSError("synthetic-private-provider-response")
        return {}
smtplib.SMTP_SSL = SMTP
smtplib.SMTP = SMTP
script = sys.argv.pop(1)
runpy.run_path(script, run_name="__main__")
'''

SSH = r'''
import json, os, sys
from pathlib import Path
root = Path(os.environ["OPERATIONS_FIXTURE"])
control = json.loads((root / "control.json").read_text())
command = sys.argv[-1]
if command == "facts":
    print(json.dumps({"checks": {"database": not control.get("database_down"), "containers": True,
        "disk": True, "backup_fresh": True}, "generated_at": control["now"],
        "disk_percent": 75 if control.get("warning") else 50, "restarts": {}}))
elif command == "list": print((root / "inventory.json").read_text())
elif command.startswith("fetch "): sys.stdout.buffer.write((root / "remote.age").read_bytes())
else: sys.exit(9)
'''


class OperationsCliTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.backups = self.root / "backups"
        self.backups.mkdir()
        self.state = self.root / "state"
        self.state.mkdir()
        self.control = {"now": START}
        self.config = {"compose_dir": str(self.root), "compose_env": str(self.root / "app.env"),
                       "project": "isolated-synthetic", "backup_dir": str(self.backups),
                       "state_dir": str(self.state), "age_recipient": "age1" + "a" * 58,
                       "public_url": "https://synthetic.test", "app_ssh_target": "test@synthetic.test",
                       "ssh_key": "unused", "ssh_known_hosts": "unused",
                       "secrets_file": str(self.root / "secrets.json")}
        self.secrets = {"email_transport": "smtp", "smtp_host": "smtp.synthetic.test", "smtp_port": 465,
                        "smtp_username": "alerts@synthetic.test", "smtp_password": "synthetic-app-password",
                        "smtp_from": "Tayyn Hyzmat <alerts@synthetic.test>", "alert_email": "operator@synthetic.test"}
        (self.root / "app.env").write_text("")
        self.executable("ssh", SSH)
        self.executable("docker", 'import os,sys\nfrom pathlib import Path\nroot=Path(os.environ["OPERATIONS_FIXTURE"])\n(root/"database-touched").write_text("yes")\nprint("synthetic custom dump payload")\nsys.exit(int(os.environ.get("DUMP_FAILURE", "0")))\n')
        self.executable("age", 'import os,sys\nfrom pathlib import Path\n(Path(os.environ["OPERATIONS_FIXTURE"])/"identity-opened").write_text("yes")\nsys.stdout.buffer.write(b"age-encryption-header" + b"0"*100 + sys.stdin.buffer.read())\n')

    def executable(self, name, body):
        path = self.root / name
        path.write_text(f"#!{sys.executable}\n" + body)
        path.chmod(0o700)

    def private_file(self, name, value):
        path = self.root / name
        path.write_text(json.dumps(value))
        path.chmod(0o600)
        return path

    def cli(self, *arguments, **environment):
        self.private_file("control.json", self.control)
        config_path = self.private_file("operations.json", self.config)
        self.private_file("secrets.json", self.secrets)
        result = subprocess.run([sys.executable, "-c", BOOTSTRAP, str(SCRIPT), "--config", str(config_path), *arguments],
                                env={**os.environ, "PATH": str(self.root) + os.pathsep + os.environ["PATH"],
                                     "OPERATIONS_FIXTURE": str(self.root), **environment},
                                text=True, capture_output=True, timeout=10)
        for private in ("synthetic-app-password", "synthetic-private-provider-response"):
            self.assertNotIn(private, result.stdout + result.stderr)
        return result

    def monitor(self, instant=START, **control):
        self.control.update(now=instant, **control)
        stamp = dt.datetime.fromtimestamp(instant, dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        (self.backups / f"tayyn-{stamp}-12345678.dump.age").write_bytes(b"synthetic ciphertext")
        self.private_file("state/relay.json", {"success_at": instant})
        result = self.cli("monitor")
        return result, json.loads(result.stdout)

    def smtp_events(self):
        path = self.root / "smtp.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def messages(self):
        return [event for event in self.smtp_events() if event["stage"] == "message"]

    def test_critical_cadence_and_recovery_survive_separate_cli_runs(self):
        for offset, expected in [(0, "incident"), (299, "none"), (300, "incident"),
                                 (899, "none"), (900, "incident"), (2699, "none"), (2700, "incident")]:
            with self.subTest(offset=offset):
                result, report = self.monitor(START + offset, database_down=True)
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertEqual(report["email"], expected)
                self.assertIn("database", report["failures"])
        self.assertEqual([message["subject"] for message in self.messages()],
                         ["Tayyn Hyzmat: CRITICAL: production checks failing"] * 4)
        result, report = self.monitor(START + 2800, database_down=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(report["email"], "recovery")
        self.assertEqual(self.messages()[-1]["subject"], "Tayyn Hyzmat: Recovered")

    def test_initial_and_daily_reports_persist_without_duplicate_launch_mail(self):
        result, report = self.monitor()
        self.assertEqual((result.returncode, report["email"]), (0, "initial"))
        self.assertEqual(self.monitor(START + 60)[1]["email"], "none")
        self.assertEqual(self.monitor(START + 86400)[1]["email"], "daily")
        self.assertEqual([message["subject"] for message in self.messages()],
                         ["Tayyn Hyzmat: Initial production checks passed", "Tayyn Hyzmat: Daily health report: normal"])
        self.assertTrue(json.loads((self.state / "monitor.json").read_text())["initial_sent"])

    def test_warning_waits_for_daily_hour_and_suppresses_normal_email(self):
        result, report = self.monitor(START - 3600, warning=True)
        self.assertEqual((result.returncode, report["email"], report["healthy"]), (0, "none", False))
        self.assertEqual(self.messages(), [])
        result, report = self.monitor(warning=True)
        self.assertEqual((result.returncode, report["email"]), (0, "daily"))
        self.assertEqual(self.messages()[0]["subject"], "Tayyn Hyzmat: Daily health report: attention needed")
        self.assertIn("app disk >=70%", self.messages()[0]["body"])

    def test_smtp_acceptance_preserves_recipient_body_and_verified_tls(self):
        result, report = self.monitor()
        self.assertEqual((result.returncode, report["email"]), (0, "initial"))
        message = self.messages()[0]
        self.assertEqual(message["to"], "operator@synthetic.test")
        self.assertIn("Application, database, disk, backup relay and outbound checks passed", message["body"])
        self.assertIn({"stage": "connect", "port": 465, "verified_tls": True}, self.smtp_events())

    def test_failed_email_retries_same_identity_without_recording_success(self):
        for failure in ("reject", "disconnect"):
            with self.subTest(failure=failure):
                for offset in (0, 60):
                    result, report = self.monitor(START + offset, database_down=True, smtp_failure=failure)
                    self.assertEqual((result.returncode, report["email"]), (2, "failed; retry next timer"))
                self.assertEqual(self.messages()[-2]["id"], self.messages()[-1]["id"])
                self.assertEqual(json.loads((self.state / "monitor.json").read_text())["incident"]["sent"], 0)
        result, report = self.monitor(START + 120, database_down=True, smtp_failure=None)
        self.assertEqual((result.returncode, report["email"]), (1, "incident"))
        self.assertEqual(self.messages()[-1]["id"], self.messages()[0]["id"])

    def test_smtp_refuses_unencrypted_port(self):
        self.secrets["smtp_port"] = 25
        result, report = self.monitor()
        self.assertEqual((result.returncode, report["email"]), (2, "failed; retry next timer"))
        self.assertEqual(self.smtp_events(), [])
        self.assertNotIn("initial_sent", json.loads((self.state / "monitor.json").read_text()))

    def test_failed_starttls_never_sends_credentials_or_message(self):
        self.secrets["smtp_port"] = 587
        result, report = self.monitor(smtp_failure="starttls")
        self.assertEqual((result.returncode, report["email"]), (2, "failed; retry next timer"))
        self.assertEqual(self.smtp_events(), [{"stage": "connect", "port": 587, "verified_tls": False},
                                              {"stage": "starttls", "verified_tls": True}])

    def test_health_requires_ok_json_not_just_mime(self):
        result, report = self.monitor(bad_health=True)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("API HTTPS", report["failures"])
        self.assertIn("API HTTPS", self.messages()[0]["body"])

    def test_backup_streams_and_discards_failed_dump(self):
        result = self.cli("backup")
        self.assertEqual(result.returncode, 0, result.stderr)
        archive = self.backups / json.loads(result.stdout)["backup"]
        self.assertTrue(archive.read_bytes().endswith(b"synthetic custom dump payload\n"))
        archive.unlink()
        result = self.cli("backup", DUMP_FAILURE="4")
        self.assertEqual(result.returncode, 2)
        self.assertEqual(list(self.backups.iterdir()), [])
        self.assertFalse(list(self.root.glob("*.dump")))

    def test_forced_ssh_command_cannot_traverse_or_execute(self):
        marker = self.root / "must-not-exist"
        for command in ("fetch ../../etc/shadow", f"list; touch {marker}", "fetch tayyn-invalid.dump.age", "bash"):
            with self.subTest(command=command):
                result = self.cli("serve", SSH_ORIGINAL_COMMAND=command)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, "")
        self.assertFalse(marker.exists())

    def test_restore_refuses_production_before_opening_identity_or_database(self):
        self.config.update(project="tayyn-production", isolated_restore=True)
        result = self.cli("restore", "--archive", str(self.root / "missing.age"),
                          "--identity", str(self.root / "missing.key"), "--database", "tayyn_restore_test")
        self.assertEqual(result.returncode, 2)
        self.assertFalse((self.root / "database-touched").exists())
        self.assertFalse((self.root / "identity-opened").exists())

    def test_relay_rejects_corruption_without_replacing_good_copy(self):
        name = "tayyn-20261017T040000Z-12345678.dump.age"
        existing = self.backups / name
        existing.write_bytes(b"last good copy")
        payload = b"expected new copy"
        self.private_file("inventory.json", [{"name": name, "sha256": hashlib.sha256(payload).hexdigest(), "size": len(payload)}])
        (self.root / "remote.age").write_bytes(b"corrupted transfer")
        result = self.cli("relay")
        self.assertEqual(result.returncode, 2)
        self.assertEqual(existing.read_bytes(), b"last good copy")
        self.assertFalse(list(self.backups.glob("*.partial")))
        self.assertFalse((self.state / "relay.json").exists())

    def test_backup_retention_preserves_hourly_and_daily_recovery_points(self):
        end = dt.datetime.fromtimestamp(START, dt.timezone.utc)
        expected = set()
        for hour in range(24 * 17):
            instant = end - dt.timedelta(hours=hour)
            name = "tayyn-" + instant.strftime("%Y%m%dT%H%M%SZ") + "-12345678.dump.age"
            (self.backups / name).write_bytes(b"cipher")
            # The new archive takes one of 24 hourly positions.
            if hour < 23:
                expected.add(name)
        # With an October 17 04:00 UTC backup, the daily recovery points
        # outside that hourly window are October 4 through 15 at 23:00 UTC.
        expected.update(f"tayyn-202610{day:02d}T230000Z-12345678.dump.age" for day in range(4, 16))
        result = self.cli("backup")
        self.assertEqual(result.returncode, 0, result.stderr)
        new_name = json.loads(result.stdout)["backup"]
        self.assertEqual({path.name for path in self.backups.iterdir()}, expected | {new_name})


if __name__ == "__main__":
    unittest.main()
