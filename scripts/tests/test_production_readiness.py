"""Behavior checks for the stdlib diagnostic; no Docker or network required."""

import argparse
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("readiness", Path(__file__).parents[1] / "production-readiness.py")
readiness = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(readiness)


def args(**overrides):
    values = dict(config_file=None, project_name="test", compose_file=None,
                  db_user="tayyn", db_name="tayyn", network=False,
                  api_url=None, web_url=None, remote_only=False, disk_path="/")
    values.update(overrides)
    return argparse.Namespace(**values)


class ReadinessTests(unittest.TestCase):
    def test_credentials_and_shell_content_are_never_printed_or_executed(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / "must-not-exist"
            secret = "private-value-123"
            config = Path(directory) / "config.env"
            config.write_text("\n".join(f"{name}={secret}" for name in readiness.REQUIRED_CONFIG)
                              + f"\nEVIL=$(touch {marker})\n")
            config.chmod(0o600)
            check = readiness.Checks(args(config_file=str(config)))
            check.config()
            self.assertFalse(marker.exists())
            self.assertNotIn(secret, json.dumps(check.results))
            self.assertEqual(next(r for r in check.results if r["name"] == "config.required_names")["status"], "PASS")

    def test_world_readable_credentials_fail(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "config.env"
            config.write_text("POSTGRES_PASSWORD=hidden")
            config.chmod(0o644)
            check = readiness.Checks(args(config_file=str(config)))
            check.config()
            self.assertEqual(check.results[0]["status"], "FAIL")

    def test_missing_docker_is_reported_without_exception(self):
        check = readiness.Checks(args())
        with patch.object(readiness.shutil, "which", return_value=None):
            check.docker()
        self.assertEqual(check.results[0]["status"], "FAIL")

    def test_command_timeout_is_bounded_and_output_is_private(self):
        code, output = readiness.run([sys.executable, "-c", "import time; time.sleep(10)"], timeout=0.05)
        self.assertEqual((code, output), (-1, ""))

    def test_unavailable_database_fails_despite_healthy_api_container(self):
        containers = [{"Service": name, "State": "running", "Health": "healthy", "ID": "a" * 64}
                      for name in readiness.SERVICES]
        def fake_run(command, timeout=6):
            if "ps" in command:
                return 0, json.dumps(containers)
            if "inspect" in command:
                return 0, '0 "unless-stopped" {"Type":"local","Config":{}}'
            if "exec" in command:
                return 1, "secret database error"
            return 0, "27.0"
        check = readiness.Checks(args())
        with patch.object(readiness.shutil, "which", return_value="docker"), patch.object(readiness, "run", side_effect=fake_run):
            check.docker()
        outcomes = {row["name"]: row["status"] for row in check.results}
        self.assertEqual(outcomes["compose.api"], "PASS")
        self.assertEqual(outcomes["database.query"], "FAIL")
        self.assertNotIn("secret database error", json.dumps(check.results))

    def test_remote_success_does_not_claim_host_readiness(self):
        check = readiness.Checks(args(remote_only=True, network=True, api_url="https://api.example.test", web_url="https://web.example.test"))
        with patch.object(readiness, "run", return_value=(0, "")):
            report, code = check.execute()
        self.assertEqual(code, 2)
        self.assertEqual(report["summary_exit"], 2)
        self.assertFalse(report["production_ready"])
        self.assertEqual(report["verdict"], "INCOMPLETE")
        self.assertIn("this machine", report["scope"])

    def endpoint_probes(self):
        check = readiness.Checks(args(network=True, web_url="https://web.example.test"))
        probes = []
        def collect(command, timeout=6):
            if "urllib.request" in command[2]:
                probes.append(command[2])
            return 0, ""
        with patch.object(readiness, "run", side_effect=collect):
            check.network()
        return probes

    def test_endpoint_probe_refuses_https_downgrade_and_cross_origin_redirects(self):
        probes = self.endpoint_probes()
        namespace = {}
        # Stop before any HTTP, retaining the actual redirect handler from the child code.
        with patch("urllib.request.build_opener", side_effect=RuntimeError("stop")):
            with self.assertRaises(RuntimeError):
                exec(probes[0], namespace)
        for destination in ("http://unsafe.test/", "https://other.test/"):
            with self.assertRaises(ValueError):
                namespace["NoRedirect"]().redirect_request(None, None, 302, "Found", {}, destination)

    def test_optimized_python_still_rejects_bad_endpoint(self):
        from unittest.mock import MagicMock
        code = self.endpoint_probes()[0]
        for status, content_type in ((503, "text/html"), (200, "application/json")):
            response = MagicMock(status=status, headers={"Content-Type": content_type})
            opener = MagicMock()
            opener.open.return_value = response
            with patch("urllib.request.build_opener", return_value=opener):
                with self.assertRaises(ValueError):
                    exec(compile(code, "probe", "exec", optimize=2), {})

    def test_url_rejects_credentials_or_insecure_scheme(self):
        for value in ("http://example.test", "https://user:password@example.test", "https://example.test/?key=hidden",
                      "https://[", "https://example.test:invalid", "https://example.test/ bad"):
            with self.assertRaises(argparse.ArgumentTypeError):
                readiness.valid_url(value)


if __name__ == "__main__":
    unittest.main()
