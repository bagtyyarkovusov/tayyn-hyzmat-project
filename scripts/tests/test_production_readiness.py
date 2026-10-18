"""Readiness CLI reports against synthetic OS, Docker and network boundaries."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).parents[1] / "production-readiness.py"

# All substitutions are OS/network boundaries in the child process, never
# readiness classes or helpers. Python provider probes inherit the same fixture.
BOUNDARIES = r'''
import json, os, platform, socket, ssl, smtplib, urllib.request
from pathlib import Path
from types import SimpleNamespace
settings = json.loads(Path(os.environ["READINESS_FIXTURE"]).read_text())
platform.system = lambda: "Linux"
platform.machine = lambda: settings.get("arch", "x86_64")
platform.freedesktop_os_release = lambda: {"ID": "ubuntu", "VERSION_ID": "24.04"}
def connection(address, **kwargs):
    if address[0] in settings.get("failed_hosts", []):
        raise OSError("synthetic-private-network-error")
    return SimpleNamespace(close=lambda: None)
socket.create_connection = connection
class Context:
    check_hostname = True
    verify_mode = ssl.CERT_REQUIRED
    def wrap_socket(self, sock, **kwargs):
        return sock
ssl.create_default_context = Context
class SMTP:
    def __init__(self, host, port, **kwargs):
        connection((host, port))
        if port == 465:
            self.verify(kwargs["context"])
    def verify(self, context):
        if not context.check_hostname or context.verify_mode != ssl.CERT_REQUIRED:
            raise ValueError("TLS verification required")
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def ehlo(self): return (250, b"OK")
    def starttls(self, context):
        self.verify(context)
        if settings.get("starttls_failure"):
            raise ssl.SSLError("synthetic-private-network-error")
    def login(self, *args): raise AssertionError("readiness must not authenticate")
    def send_message(self, *args): raise AssertionError("readiness must not send mail")
smtplib.SMTP = SMTP
smtplib.SMTP_SSL = SMTP
class Response:
    status = settings.get("http_status", 200)
    headers = {"Content-Type": settings.get("mime", "text/html")}
    def read(self, limit): return json.dumps({"status": settings.get("health", "ok")}).encode()
class Opener:
    def __init__(self, handlers): self.handlers = handlers
    def open(self, url, **kwargs):
        if settings.get("redirect"):
            for handler in self.handlers:
                handler.redirect_request(None, None, 302, "Found", {}, settings["redirect"])
        return Response()
urllib.request.build_opener = lambda *handlers: Opener(handlers)
'''

DOCKER = r'''
import json, os, sys
from pathlib import Path
s = json.loads(Path(os.environ["READINESS_FIXTURE"]).read_text())
a = sys.argv[1:]
if "config" in a:
    env = {name: "synthetic-private-value" for name in ["YANDEX_GEOCODER_API_KEY", "YANDEX_GEOCODER_DAILY_LIMIT", "YANDEX_GEOCODER_QUOTA_TIMEZONE", "FIREBASE_SERVICE_ACCOUNT_JSON"] if name != s.get("missing_wiring")}
    print(json.dumps({"services": {"api": {"environment": env}}}))
elif "ps" in a:
    print(json.dumps([{"Service": n, "State": "running", "Health": "healthy", "ID": "a" * 64} for n in ["db", "api", "web", "proxy"] if n != s.get("missing_service")]))
elif "inspect" in a:
    print('0 "unless-stopped" {"Type":"local","Config":{}}')
elif "exec" in a:
    if s.get("database_failure"):
        print("synthetic-private-value")
        sys.exit(1)
    print("1")
else:
    print("27.0")
'''


class ReadinessTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / "sitecustomize.py").write_text(BOUNDARIES)
        docker = self.root / "docker"
        docker.write_text("#!" + sys.executable + "\n" + DOCKER)
        docker.chmod(0o700)
        self.config = self.root / "app.env"
        self.config.write_text("\n".join(name + "=synthetic-private-value" for name in [
            "POSTGRES_PASSWORD", "JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET", "CORS_ORIGIN",
            "SEED_ADMIN_PHONE", "SEED_ADMIN_PASSWORD", "DOMAIN"]))
        self.config.chmod(0o600)

    def cli(self, *arguments, settings=None, optimized=False):
        fixture = self.root / "fixture.json"
        fixture.write_text(json.dumps(settings or {}))
        env = {**os.environ, "PYTHONPATH": str(self.root), "PATH": str(self.root),
               "READINESS_FIXTURE": str(fixture)}
        command = [sys.executable, *(["-O"] if optimized else []), str(SCRIPT), "--json", *arguments]
        result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=15)
        return result, json.loads(result.stdout) if result.stdout else None

    def local(self, settings=None):
        return self.cli("--config-file", str(self.config), "--disk-path", str(self.root), settings=settings)

    def outcome(self, report, name):
        return next(row for row in report["results"] if row["name"] == name)

    def test_smtp_offline_does_not_require_resend_or_registry_access(self):
        result, report = self.cli("--remote-only", "--network", "--offline", "--email-transport", "smtp",
                                  settings={"failed_hosts": ["api.resend.com", "ghcr.io"]})
        outcomes = {row["name"]: row["status"] for row in report["results"]}
        self.assertEqual(result.returncode, 2)
        self.assertEqual(outcomes["network.smtp.gmail.com"], "PASS")
        self.assertNotIn("network.api.resend.com", outcomes)
        self.assertNotIn("network.ghcr.io", outcomes)
        self.assertFalse(report["production_ready"])

    def test_default_requires_resend_and_registry_access(self):
        result, report = self.cli("--remote-only", "--network",
                                  settings={"failed_hosts": ["api.resend.com", "ghcr.io"]})
        self.assertEqual(result.returncode, 1)
        for name in ["network.api.resend.com", "network.ghcr.io"]:
            self.assertEqual(self.outcome(report, name)["status"], "FAIL")

    def test_smtp_failure_is_required_and_private(self):
        result, report = self.cli("--remote-only", "--network", "--email-transport", "smtp",
                                  "--smtp-host", "mail.example.test", settings={"failed_hosts": ["mail.example.test"]})
        self.assertEqual(result.returncode, 1)
        self.assertTrue(self.outcome(report, "network.mail.example.test")["required"])
        self.assertNotIn("synthetic-private-network-error", result.stdout)

    def test_failed_starttls_cannot_report_smtp_success(self):
        result, report = self.cli("--remote-only", "--network", "--email-transport", "smtp",
                                  "--smtp-port", "587", settings={"starttls_failure": True})
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.outcome(report, "network.smtp.gmail.com")["status"], "FAIL")

    def test_compose_wiring_is_reported_without_secret_values(self):
        result, report = self.local()
        self.assertEqual(self.outcome(report, "config.wiring")["status"], "PASS")
        self.assertNotIn("synthetic-private-value", result.stdout)

    def test_missing_push_wiring_warns_despite_runtime_credentials(self):
        _, report = self.local({"missing_wiring": "FIREBASE_SERVICE_ACCOUNT_JSON"})
        row = self.outcome(report, "config.wiring")
        self.assertEqual(row["status"], "WARN")
        self.assertIn("FIREBASE_SERVICE_ACCOUNT_JSON", row["detail"])

    def test_config_is_never_executed_or_printed(self):
        marker = self.root / "must-not-exist"
        with self.config.open("a") as config:
            config.write("\nEVIL=$(touch " + str(marker) + ")\n")
        result, report = self.local()
        self.assertFalse(marker.exists())
        self.assertEqual(self.outcome(report, "config.required_names")["status"], "PASS")
        self.assertNotIn("synthetic-private-value", result.stdout)

    def test_bootstrap_credentials_and_domain_are_required(self):
        for name in ["SEED_ADMIN_PHONE", "SEED_ADMIN_PASSWORD", "DOMAIN"]:
            with self.subTest(name=name):
                original = self.config.read_text()
                self.config.write_text("\n".join(line for line in original.splitlines() if not line.startswith(name + "=")))
                result, report = self.local()
                row = self.outcome(report, "config.required_names")
                self.assertEqual(result.returncode, 1)
                self.assertEqual(row["status"], "FAIL")
                self.assertIn(name, row["detail"])
                self.config.write_text(original)

    def test_non_amd64_fails_host_gate(self):
        for arch in ["aarch64", "arm64"]:
            with self.subTest(arch=arch):
                result, report = self.local({"arch": arch})
                self.assertEqual(result.returncode, 1)
                self.assertEqual(self.outcome(report, "host.arch")["status"], "FAIL")

    def test_world_readable_credentials_fail(self):
        self.config.chmod(0o644)
        result, report = self.local()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.outcome(report, "config.permissions")["status"], "FAIL")

    def test_missing_docker_is_reported_without_exception(self):
        (self.root / "docker").unlink()
        result, report = self.local()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.outcome(report, "docker.command")["status"], "FAIL")

    def test_missing_https_proxy_fails_despite_other_healthy_services(self):
        result, report = self.local({"missing_service": "proxy"})
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.outcome(report, "compose.proxy")["status"], "FAIL")
        self.assertEqual(self.outcome(report, "compose.api")["status"], "PASS")

    def test_unavailable_database_fails_despite_healthy_api(self):
        result, report = self.local({"database_failure": True})
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.outcome(report, "compose.api")["status"], "PASS")
        self.assertEqual(self.outcome(report, "database.query")["status"], "FAIL")
        self.assertNotIn("synthetic-private-value", result.stdout)

    def test_remote_success_never_claims_host_readiness(self):
        result, report = self.cli("--remote-only", "--network", "--api-url", "https://api.example.test", "--web-url", "https://web.example.test")
        self.assertEqual(result.returncode, 2)
        self.assertEqual(report["verdict"], "INCOMPLETE")
        self.assertFalse(report["production_ready"])
        self.assertIn("this machine", report["scope"])

    def test_endpoint_redirects_never_establish_readiness(self):
        for destination in ["http://unsafe.test/", "https://other.test/"]:
            with self.subTest(destination=destination):
                result, report = self.cli("--remote-only", "--network", "--web-url", "https://web.example.test", settings={"redirect": destination})
                self.assertEqual(result.returncode, 1)
                self.assertEqual(self.outcome(report, "endpoint.web")["status"], "FAIL")

    def test_optimized_python_rejects_bad_endpoint_responses(self):
        for settings in [{"http_status": 503}, {"mime": "application/json"}]:
            with self.subTest(settings=settings):
                result, report = self.cli("--remote-only", "--network", "--web-url", "https://web.example.test", settings=settings, optimized=True)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(self.outcome(report, "endpoint.web")["status"], "FAIL")

    def test_api_requires_ok_health_body(self):
        result, report = self.cli("--remote-only", "--network", "--api-url", "https://api.example.test", settings={"health": "unavailable"})
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.outcome(report, "endpoint.api")["status"], "FAIL")

    def test_url_rejects_credentials_or_insecure_scheme(self):
        for value in ["http://example.test", "https://user:password@example.test", "https://example.test/?key=hidden", "https://[", "https://example.test:invalid", "https://example.test/ bad"]:
            with self.subTest(value=value):
                result, _ = self.cli("--remote-only", "--api-url", value)
                self.assertEqual(result.returncode, 2)
                self.assertNotIn("Traceback", result.stderr)


if __name__ == "__main__":
    unittest.main()
