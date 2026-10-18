"""Behavior checks for the stdlib diagnostic; no Docker or network required."""

import argparse
import contextlib
import io
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
                  api_url=None, web_url=None, remote_only=False, disk_path="/",
                  offline=False, email_transport="resend", smtp_host="smtp.gmail.com", smtp_port=465)
    values.update(overrides)
    return argparse.Namespace(**values)


class ReadinessTests(unittest.TestCase):
    def run_cli(self, arguments, probe):
        output = io.StringIO()
        with patch.object(sys, "argv", ["production-readiness.py", "--json", "--remote-only", "--network", *arguments]), \
             patch.object(readiness, "run", side_effect=probe), contextlib.redirect_stdout(output):
            code = readiness.main()
        return code, json.loads(output.getvalue())

    def test_smtp_offline_cli_does_not_require_resend_or_registry_access(self):
        def probe(command, timeout=6):
            return (1, "") if command[-1] in ("api.resend.com", "ghcr.io") else (0, "")
        code, report = self.run_cli(["--offline", "--email-transport", "smtp"], probe)
        outcomes = {row["name"]: row["status"] for row in report["results"]}
        self.assertEqual(code, 2)
        self.assertEqual(report["verdict"], "INCOMPLETE")
        self.assertEqual(outcomes["network.smtp.gmail.com"], "PASS")
        self.assertNotIn("network.api.resend.com", outcomes)
        self.assertNotIn("network.ghcr.io", outcomes)
        self.assertFalse(report["production_ready"])

    def test_default_cli_still_requires_resend_and_registry_access(self):
        def probe(command, timeout=6):
            return (1, "") if command[-1] in ("api.resend.com", "ghcr.io") else (0, "")
        code, report = self.run_cli([], probe)
        outcomes = {row["name"]: row["status"] for row in report["results"]}
        self.assertEqual(code, 1)
        self.assertEqual(outcomes["network.api.resend.com"], "FAIL")
        self.assertEqual(outcomes["network.ghcr.io"], "FAIL")

    def test_smtp_cli_failure_remains_required(self):
        def probe(command, timeout=6):
            return (1, "") if "mail.example.test" in command else (0, "")
        code, report = self.run_cli(["--offline", "--email-transport", "smtp", "--smtp-host", "mail.example.test", "--smtp-port", "587"], probe)
        self.assertEqual(code, 1)
        result = next(row for row in report["results"] if row["name"] == "network.mail.example.test")
        self.assertEqual(result["status"], "FAIL")
        self.assertTrue(result["required"])

    def test_selected_compose_address_push_wiring_is_reported_without_secret_values(self):
        secret = "synthetic-firebase-private-value"
        configuration = {"services": {"api": {"environment": {name: secret for name in readiness.OPTIONAL_CONFIG}}}}
        check = readiness.Checks(args())
        with patch.object(readiness, "run", return_value=(0, json.dumps(configuration))):
            check.compose_wiring(["docker", "compose", "-f", "selected.yaml"])
        self.assertEqual(check.results[0]["status"], "PASS")
        self.assertNotIn(secret, json.dumps(check.results))
        self.assertIn("delivery", check.results[0]["detail"])

    def test_missing_compose_push_wiring_warns_even_when_runtime_file_has_credentials(self):
        configuration = {"services": {"api": {"environment": {name: "synthetic" for name in readiness.OPTIONAL_CONFIG if name != "FIREBASE_SERVICE_ACCOUNT_JSON"}}}}
        check = readiness.Checks(args())
        with patch.object(readiness, "run", return_value=(0, json.dumps(configuration))):
            check.compose_wiring(["docker", "compose", "-f", "selected.yaml"])
        self.assertEqual(check.results[0]["status"], "WARN")
        self.assertIn("FIREBASE_SERVICE_ACCOUNT_JSON", check.results[0]["detail"])

    def test_smtp_probe_refuses_failed_starttls_without_sending_credentials_or_email(self):
        from unittest.mock import MagicMock
        import smtplib
        check = readiness.Checks(args(network=True, email_transport="smtp", smtp_port=587))
        probes = []
        def collect(command, timeout=6):
            if "import smtplib" in command[2]:
                probes.append(command)
            return 0, ""
        with patch.object(readiness, "run", side_effect=collect):
            check.network()
        client = MagicMock()
        client.__enter__.return_value = client
        client.ehlo.return_value = (250, b"OK")
        client.starttls.side_effect = smtplib.SMTPException("synthetic TLS failure")
        with patch("smtplib.SMTP", return_value=client), patch.object(sys, "argv", probes[0][2:]):
            with self.assertRaises(smtplib.SMTPException):
                exec(compile(probes[0][2], "smtp-probe", "exec", optimize=2), {})
        client.login.assert_not_called()
        client.sendmail.assert_not_called()
        client.send_message.assert_not_called()
        context = client.starttls.call_args.kwargs["context"]
        self.assertTrue(context.check_hostname)

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

    def test_bootstrap_credentials_are_required_names(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "config.env"
            config.write_text("POSTGRES_PASSWORD=hidden\nJWT_ACCESS_SECRET=hidden\nJWT_REFRESH_SECRET=hidden\nCORS_ORIGIN=https://example.test\n")
            config.chmod(0o600)
            check = readiness.Checks(args(config_file=str(config)))
            check.config()
            result = next(row for row in check.results if row["name"] == "config.required_names")
            self.assertEqual(result["status"], "FAIL")
            self.assertIn("SEED_ADMIN_PHONE", result["detail"])

    def test_non_amd64_host_fails_architecture_gate(self):
        check = readiness.Checks(args())
        with patch.object(readiness.platform, "system", return_value="Darwin"), \
             patch.object(readiness.platform, "machine", return_value="aarch64"), \
             patch.object(readiness.os, "cpu_count", return_value=4), \
             patch.object(readiness.shutil, "disk_usage", return_value=type("Usage", (), {"free": 25 * 1024**3})()):
            check.host()
        result = next(row for row in check.results if row["name"] == "host.arch")
        self.assertEqual(result["status"], "FAIL")

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
