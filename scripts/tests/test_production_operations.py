"""Behavior tests for production scripts; no shared environments or actual mail."""
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch, MagicMock

SCRIPT = Path(__file__).parents[1] / "production" / "operations.py"
SPEC = importlib.util.spec_from_file_location("operations", SCRIPT)
ops = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ops)


class NotificationTests(unittest.TestCase):
    def test_critical_schedule_and_recovery(self):
        state = {"installation_id": "test"}
        for instant, expected in [(1000, True), (1299, False), (1300, True), (1899, False), (1900, True), (3699, False), (3700, True)]:
            notice = ops.notification(state, ["database"], [], instant, "2026-10-17", True)
            self.assertEqual(notice is not None, expected)
            if notice:
                state["incident"]["sent"] += 1
                state["incident"]["last_sent"] = instant
        recovery = ops.notification(state, [], [], 3800, "2026-10-17", True)
        self.assertEqual(recovery[3], "recovery")

    def test_normal_never_sent_with_warning_or_before_checks(self):
        state = {"installation_id": "test"}
        self.assertIsNone(ops.notification(state, [], ["disk >=70%"], 1, "2026-10-17", False))
        warning = ops.notification(state, [], ["disk >=70%"], 1, "2026-10-17", True)
        self.assertIn("attention", warning[0])
        self.assertNotIn("normal", warning[0])
        initial = ops.notification(state, [], [], 1, "2026-10-17", False)
        self.assertEqual(initial[3], "initial")
        state.update(initial_sent=True, daily_day="2026-10-17")
        self.assertIsNone(ops.notification(state, [], [], 2, "2026-10-17", True))
        self.assertEqual(ops.notification(state, [], [], 3, "2026-10-18", True)[3], "daily")


class OperationsTests(unittest.TestCase):
    def fixture(self, directory):
        root = Path(directory)
        config = {"compose_dir": str(root), "compose_env": str(root / "app.env"),
                  "project": "isolated-synthetic", "backup_dir": str(root / "backups"),
                  "state_dir": str(root / "state"), "age_recipient": "age1" + "a" * 58}
        root.joinpath("app.env").write_text("")
        return config

    def test_public_backup_command_streams_and_discards_failed_dump(self):
        for failed in [False, True]:
            with self.subTest(failed=failed), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                config = self.fixture(directory)
                # Synthetic executables exercise the CLI pipe/error paths, not the shared database.
                root.joinpath("docker").write_text("#!/bin/sh\nprintf 'synthetic custom dump payload'\nexit " + ("4" if failed else "0") + "\n")
                root.joinpath("age").write_text("#!/bin/sh\nprintf 'age-encryption-header%0100d' 0\ncat\n")
                for name in ["docker", "age"]:
                    root.joinpath(name).chmod(0o700)
                path = root / "operations.json"
                path.write_text(json.dumps(config))
                path.chmod(0o600)
                env = {**os.environ, "PATH": str(root) + os.pathsep + os.environ["PATH"]}
                result = subprocess.run([sys.executable, str(SCRIPT), "--config", str(path), "backup"], env=env, capture_output=True, timeout=5)
                self.assertEqual(result.returncode, 2 if failed else 0)
                self.assertEqual(len(ops.archives(config["backup_dir"])), 0 if failed else 1)
                self.assertFalse(list(Path(config["backup_dir"]).glob("*.partial")))
                self.assertFalse(list(root.glob("*.dump")))

    def test_forced_ssh_command_cannot_traverse_or_execute(self):
        for command in ["fetch ../../etc/shadow", "list; touch /tmp/bad", "fetch tayyn-invalid.dump.age", "bash"]:
            with self.subTest(command=command), patch.dict(os.environ, {"SSH_ORIGINAL_COMMAND": command}):
                with self.assertRaises(ValueError):
                    ops.serve({"backup_dir": "/unused"})

    def test_restore_refuses_production_before_opening_identity_or_database(self):
        with patch.object(ops, "run") as runner:
            with self.assertRaises(ValueError):
                ops.restore({"project": "tayyn-production"}, MagicMock())
            runner.assert_not_called()

    def test_failed_email_does_not_record_success_and_retries_same_event(self):
        with tempfile.TemporaryDirectory() as directory:
            config = self.fixture(directory)
            config.update(public_url="https://synthetic.test", app_ssh_target="test@synthetic.test")
            Path(config["backup_dir"]).mkdir()
            archive = Path(config["backup_dir"]) / "tayyn-20261017T120000Z-12345678.dump.age"
            archive.write_bytes(b"synthetic ciphertext")
            remote = {"checks": {name: False for name in ["database", "containers", "disk", "backup_fresh"]},
                      "generated_at": 1792238400, "disk_percent": 50, "restarts": {}}
            sent = []
            def mail(*arguments):
                sent.append(arguments[-1])
                raise OSError("secret API response")
            with patch.object(ops, "ssh", return_value=MagicMock(stdout=json.dumps(remote).encode())), patch.object(ops, "endpoint", return_value=True), patch.object(ops, "socketio_probe", return_value=True), patch.object(ops, "certificate_days", return_value=90), patch.object(ops, "send_email", side_effect=mail), patch.object(ops.time, "time", return_value=1792238400), patch("sys.stdout", new_callable=io.StringIO) as output:
                self.assertEqual(ops.monitor(config), 2)
                self.assertEqual(ops.monitor(config), 2)
                self.assertNotIn("secret API response", output.getvalue())
            self.assertEqual(sent[0], sent[1])
            state = json.loads((Path(config["state_dir"]) / "monitor.json").read_text())
            self.assertEqual(state["incident"]["sent"], 0)

    def test_relay_rejects_corruption_without_replacing_good_copy(self):
        with tempfile.TemporaryDirectory() as directory:
            config = self.fixture(directory)
            config.update(app_ssh_target="test@synthetic.test", ssh_key="unused", ssh_known_hosts="unused")
            name = "tayyn-20261017T120000Z-12345678.dump.age"
            inventory = [{"name": name, "sha256": "a" * 64, "size": 8}]
            def remote(_config, command, **kwargs):
                if command == "list":
                    return MagicMock(stdout=json.dumps(inventory).encode())
                kwargs["stdout"].write(b"bad data")
                return MagicMock()
            with patch.object(ops, "ssh", side_effect=remote):
                with self.assertRaises(ValueError):
                    ops.relay(config)
            self.assertEqual(ops.archives(config["backup_dir"]), [])
            self.assertFalse(list(Path(config["backup_dir"]).glob("*.partial")))

    def test_public_health_requires_ok_json_not_just_mime(self):
        response = MagicMock(status=200, headers={"Content-Type": "application/json"})
        response.read.return_value = b'{"error":"unavailable"}'
        response.__enter__.return_value = response
        opener = MagicMock()
        opener.open.return_value = response
        with patch.object(ops.urllib.request, "build_opener", return_value=opener):
            self.assertFalse(ops.endpoint("https://synthetic.test/health", "application/json"))

    def test_retention_preserves_hourly_and_daily_recovery_points(self):
        with tempfile.TemporaryDirectory() as directory:
            import datetime as dt
            end = dt.datetime(2026, 10, 17, 12, tzinfo=dt.timezone.utc)
            for hour in range(24 * 17):
                instant = end - dt.timedelta(hours=hour)
                Path(directory, "tayyn-" + instant.strftime("%Y%m%dT%H%M%SZ") + "-12345678.dump.age").write_bytes(b"cipher")
            ops.retention(directory, end.timestamp())
            files = ops.archives(directory)
            self.assertLessEqual(len(files), 38)
            self.assertGreaterEqual(len(files), 36)
            self.assertEqual(len({p.name[6:14] for p in files}), 14)


if __name__ == "__main__":
    unittest.main()
