#!/usr/bin/env python3
"""Read-only deployment checks. Never installs, restarts, seeds or sources files."""

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import platform
import re
import shutil
import stat
import subprocess
import sys
from urllib.parse import urlsplit


REQUIRED_CONFIG = (
    "POSTGRES_PASSWORD", "JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET", "CORS_ORIGIN",
    "SEED_ADMIN_PHONE", "SEED_ADMIN_PASSWORD", "DOMAIN",
)
OPTIONAL_CONFIG = (
    "YANDEX_GEOCODER_API_KEY", "YANDEX_GEOCODER_DAILY_LIMIT",
    "YANDEX_GEOCODER_QUOTA_TIMEZONE", "FIREBASE_SERVICE_ACCOUNT_JSON",
)
PROVIDERS = (
    "ghcr.io", "geocode-maps.yandex.ru", "oauth2.googleapis.com", "fcm.googleapis.com",
    "api.resend.com",
)
SERVICES = ("db", "api", "web", "proxy")


def run(command, timeout=6):
    """Capture output privately; callers expose only explicitly selected facts."""
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
        return result.returncode, result.stdout
    except (OSError, subprocess.TimeoutExpired):
        return -1, ""


def config_names(contents):
    """Inspect dotenv names/presence, never execute expansion or expose values."""
    names = set()
    for line in contents.splitlines():
        match = re.match(r"^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$", line)
        if match and match.group(2) not in ("", "''", '""'):
            names.add(match.group(1))
    return names


def valid_url(value):
    try:
        parsed = urlsplit(value)
        parsed.port  # Reject invalid ports before starting probes.
        valid = (parsed.scheme == "https" and parsed.hostname and not parsed.username
                 and not parsed.password and not parsed.query and not parsed.fragment
                 and not any(character.isspace() for character in value))
    except ValueError:
        valid = False
    if not valid:
        raise argparse.ArgumentTypeError("Use an HTTPS URL without credentials, query or fragment")
    return value.rstrip("/")


def valid_hostname(value):
    if not re.fullmatch(r"(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?", value):
        raise argparse.ArgumentTypeError("Use a hostname without a scheme, credentials, port or path")
    return value


def compose_rows(raw):
    try:
        value = json.loads(raw)
        return value if isinstance(value, list) else [value]
    except json.JSONDecodeError:
        return [json.loads(line) for line in raw.splitlines() if line.strip()]


def report_verdict(results, remote_only):
    if any(row["status"] == "FAIL" for row in results):
        return "FAILED", 1
    if remote_only or any(row["status"] == "SKIP" and row["required"] for row in results):
        return "INCOMPLETE", 2
    return "CHECKS_PASSED", 0


class Checks:
    def __init__(self, args):
        self.args = args
        self.results = []

    def add(self, name, status, detail, required=True):
        self.results.append(dict(name=name, status=status, detail=detail, required=required))

    def host(self):
        if platform.system() != "Linux":
            self.add("host.os", "SKIP", "Target is Ubuntu Linux; this host cannot validate it")
        else:
            try:
                info = platform.freedesktop_os_release()
            except OSError:
                info = {}
            ubuntu = info.get("ID") == "ubuntu"
            self.add("host.os", "PASS" if ubuntu else "WARN",
                     "Ubuntu " + info.get("VERSION_ID", "unknown") if ubuntu else "Non-Ubuntu Linux; validate support separately")
            if not ubuntu or info.get("VERSION_ID") != "24.04":
                self.add("host.os_target", "SKIP", "Ubuntu 24.04 LTS is the reviewed deployment target")
        arch = platform.machine()
        self.add("host.arch", "PASS" if arch == "x86_64" else "FAIL", arch + "; Ubuntu amd64 requires x86_64")
        cpus = os.cpu_count() or 0
        self.add("host.cpu", "PASS" if cpus >= 4 else "WARN", f"{cpus} logical CPUs; pilot sizing starts at 4")
        try:
            ram = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 1024 ** 3
            self.add("host.memory", "PASS" if ram >= 3.5 else "WARN", f"{ram:.1f} GiB RAM; pilot target 4 GiB or more")
        except (OSError, ValueError):
            self.add("host.memory", "SKIP", "Cannot read physical memory")
        disk = shutil.disk_usage(self.args.disk_path)
        free = disk.free / 1024 ** 3
        self.add("host.disk", "PASS" if free >= 20 else "WARN", f"{free:.1f} GiB free on checked filesystem; target at least 20 GiB free")
        self.add("host.capacity", "WARN", "CPU/RAM checks are sizing hints, not a workload benchmark", False)

    def config(self):
        if not self.args.config_file:
            self.add("config.file", "SKIP", "Supply --config-file to inspect runtime configuration names/permissions")
            return
        path = Path(self.args.config_file)
        try:
            mode = path.stat().st_mode
            if not stat.S_ISREG(mode) or path.is_symlink():
                self.add("config.file", "FAIL", "Configuration must be a regular, non-symlink file")
                return
            restricted = not (stat.S_IMODE(mode) & 0o077)
            self.add("config.permissions", "PASS" if restricted else "FAIL",
                     "Owner-only permissions" if restricted else "Group/other access enabled; require chmod 600 or stricter")
            names = config_names(path.read_text())
        except (OSError, UnicodeError):
            self.add("config.file", "FAIL", "Cannot read runtime configuration file")
            return
        missing = [name for name in REQUIRED_CONFIG if name not in names]
        self.add("config.required_names", "FAIL" if missing else "PASS",
                 "Missing/empty names: " + ", ".join(missing) if missing else "Required variable names present; validity/strength not verified")
        absent = [name for name in OPTIONAL_CONFIG if name not in names]
        self.add("config.optional_names", "WARN" if absent else "PASS",
                 "Optional address/push configuration missing: " + ", ".join(absent) if absent else "Address/push configuration names present; delivery not verified", False)

    def compose_wiring(self, command):
        # Resolve privately: Compose's complete output contains runtime secrets.
        code, raw = run(command + ["config", "--format", "json"])
        try:
            if code != 0:
                raise ValueError("Compose configuration unavailable")
            environment = json.loads(raw)["services"]["api"].get("environment", {})
            if not isinstance(environment, dict):
                raise ValueError("Unrecognized Compose environment")
            missing = [name for name in OPTIONAL_CONFIG if name not in environment]
        except (ValueError, KeyError, TypeError, AttributeError):
            self.add("config.wiring", "WARN", "Could not inspect API environment wiring from the selected Compose configuration", False)
            return
        self.add("config.wiring", "WARN" if missing else "PASS",
                 "Selected Compose API environment omits address/push names: " + ", ".join(missing) if missing else
                 "Selected Compose API environment includes address/push variable names; values and delivery are not verified", False)

    def docker(self):
        if not shutil.which("docker"):
            self.add("docker.command", "FAIL", "Docker CLI is unavailable")
            return
        code, out = run(["docker", "version", "--format", "{{.Server.Version}}"])
        self.add("docker.daemon", "PASS" if code == 0 else "FAIL",
                 "Daemon reachable, version " + out.strip() if code == 0 else "Daemon unavailable or access denied")
        code, _ = run(["docker", "compose", "version", "--short"])
        self.add("docker.compose", "PASS" if code == 0 else "FAIL", "Compose plugin available" if code == 0 else "Compose plugin unavailable")
        if code != 0:
            return
        command = ["docker", "compose", "--project-name", self.args.project_name]
        if self.args.config_file:
            command += ["--env-file", self.args.config_file]
        for compose_file in self.args.compose_file or ["compose.yaml"]:
            command += ["-f", compose_file]
        self.compose_wiring(command)
        code, raw = run(command + ["ps", "--all", "--format", "json"])
        if code != 0:
            self.add("compose.status", "FAIL", "Cannot inspect Compose project; config, daemon or permissions may be missing")
            return
        try:
            rows = compose_rows(raw)
            by_service = {row.get("Service"): row for row in rows}
        except (ValueError, TypeError, AttributeError):
            self.add("compose.status", "FAIL", "Unrecognized Compose status format")
            return
        for service in SERVICES:
            row = by_service.get(service)
            if not row:
                self.add("compose." + service, "FAIL", "Required service is not deployed")
                continue
            healthy = row.get("State") == "running" and row.get("Health", "") in ("", "healthy")
            self.add("compose." + service, "PASS" if healthy else "FAIL",
                     "Running" + (" and healthy" if row.get("Health") == "healthy" else " without a healthcheck") if healthy else "Not running/healthy")
            container_id = row.get("ID", "")
            if not re.fullmatch(r"[a-f0-9]{12,64}", container_id):
                self.add("compose." + service + ".inspect", "SKIP", "No safe container ID available")
                continue
            template = '{{json .RestartCount}} {{json .HostConfig.RestartPolicy.Name}} {{json .HostConfig.LogConfig}}'
            code, details = run(["docker", "inspect", "--format", template, container_id])
            try:
                decoder = json.JSONDecoder()
                restarts, end = decoder.raw_decode(details)
                policy, end2 = decoder.raw_decode(details[end:].lstrip())
                remainder = details[end:].lstrip()[end2:].lstrip()
                logconfig = json.loads(remainder)
                rotated = logconfig.get("Type") == "local" or all(
                    name in logconfig.get("Config", {}) for name in ("max-size", "max-file"))
                self.add("compose." + service + ".restarts", "WARN" if restarts else "PASS", f"{int(restarts)} current container restart count; not complete crash history")
                self.add("compose." + service + ".restart_policy", "PASS" if policy in ("always", "unless-stopped") else "FAIL", "Automatic exit/reboot recovery configured" if policy in ("always", "unless-stopped") else "Automatic restart policy missing")
                self.add("compose." + service + ".logs", "PASS" if rotated else "WARN", "Bounded Docker logs configured" if rotated else "Bounded Docker log rotation not established")
            except (ValueError, TypeError, KeyError):
                self.add("compose." + service + ".inspect", "FAIL", "Could not inspect safe container metadata")
        code, out = run(command + ["exec", "-T", "db", "psql", "-U", self.args.db_user, "-d", self.args.db_name, "-tAc", "SELECT 1"], timeout=6)
        self.add("database.query", "PASS" if code == 0 and out.strip() == "1" else "FAIL", "Read-only local database query succeeded" if code == 0 and out.strip() == "1" else "Local database query failed")
        self.add("logs.contents", "SKIP", "Service logs deliberately not printed: they may contain private data", False)

    def network(self):
        if not self.args.network:
            self.add("network.providers", "SKIP", "Use --network for bounded DNS/TLS and optional HTTP probes")
            return
        # A child process bounds DNS as well as TLS; socket timeout alone cannot bound DNS.
        probe = "import socket,ssl,sys; s=socket.create_connection((sys.argv[1],443),timeout=4); t=ssl.create_default_context().wrap_socket(s,server_hostname=sys.argv[1]); t.close()"
        hosts = [host for host in PROVIDERS
                 if not (self.args.offline and host == "ghcr.io")
                 and not (self.args.email_transport == "smtp" and host == "api.resend.com")]
        for host in hosts:
            code, _ = run([sys.executable, "-c", probe, host], timeout=6)
            self.add("network." + host, "PASS" if code == 0 else "FAIL", "DNS and verified TLS succeeded" if code == 0 else "DNS/TLS failed or timed out")
        if self.args.email_transport == "smtp":
            smtp_probe = ("import smtplib,ssl,sys\n"
                          "host,port=sys.argv[1],int(sys.argv[2])\n"
                          "context=ssl.create_default_context()\n"
                          "client=smtplib.SMTP_SSL(host,port,timeout=4,context=context) if port==465 else smtplib.SMTP(host,port,timeout=4)\n"
                          "with client:\n"
                          " if client.ehlo()[0]!=250: raise ValueError('SMTP EHLO failed')\n"
                          " if port==587:\n"
                          "  client.starttls(context=context)\n"
                          "  if client.ehlo()[0]!=250: raise ValueError('SMTP TLS EHLO failed')\n")
            code, _ = run([sys.executable, "-c", smtp_probe, self.args.smtp_host, str(self.args.smtp_port)], timeout=8)
            self.add("network." + self.args.smtp_host, "PASS" if code == 0 else "FAIL",
                     "SMTP verified TLS and EHLO succeeded; authentication and email delivery not tested" if code == 0 else
                     "SMTP DNS/TLS/EHLO failed or timed out")
        self.add("network.scope", "WARN", "Probes originate on this executing machine, never on a supplied remote URL. TLS does not verify API authorization, FCM delivery, image pulls or driver-network reachability", False)
        for kind, base in (("api", self.args.api_url), ("web", self.args.web_url)):
            if not base:
                self.add("endpoint." + kind, "SKIP", "Supply --" + kind + "-url for HTTPS verification")
                continue
            url = base + "/health" if kind == "api" else base + "/"
            probe = (
                "import json,sys,urllib.request\n"
                "class NoRedirect(urllib.request.HTTPRedirectHandler):\n"
                " def redirect_request(self,req,fp,code,msg,headers,newurl):\n"
                "  raise ValueError('Redirects cannot establish endpoint readiness')\n"
                "r=urllib.request.build_opener(NoRedirect()).open(sys.argv[1],timeout=5)\n"
                "if r.status!=200: raise ValueError('Unexpected status')\n"
                + ("b=json.loads(r.read(65536))\nif b.get('status')!='ok': raise ValueError('Invalid health body')" if kind == "api" else "if 'text/html' not in r.headers.get('Content-Type',''): raise ValueError('Expected HTML')")
            )
            code, _ = run([sys.executable, "-c", probe, url], timeout=7)
            self.add("endpoint." + kind, "PASS" if code == 0 else "FAIL", "HTTPS response validated" if code == 0 else "HTTPS response failed, invalid or timed out")
        if self.args.api_url:
            self.add("endpoint.database_readiness", "SKIP", "Current /health checks liveness only; remote database readiness is not proven")

    def execute(self):
        if not self.args.remote_only:
            self.host()
            self.config()
            self.docker()
        else:
            self.add("scope.host", "SKIP", "Remote simulation cannot validate VPS resources, Docker, secrets, database or recovery")
        self.network()
        self.add("release.gates", "SKIP", "Production HTTPS configuration, independent offsite backup/restore, external alerts, workload benchmark and phone delivery require separate witnessed checks")
        verdict, exit_code = report_verdict(self.results, self.args.remote_only)
        return {"checked_at": datetime.now(timezone.utc).isoformat(),
                "scope": "remote endpoints from this machine" if self.args.remote_only else "local deployment host",
                "summary_exit": exit_code, "verdict": verdict,
                "production_ready": False, "results": self.results}, exit_code


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="Print JSON instead of the human report")
    parser.add_argument("--remote-only", action="store_true", help="Skip host checks for remote/Railway simulation; verdict remains incomplete")
    parser.add_argument("--network", action="store_true", help="Probe public DNS/TLS and supplied HTTPS URLs; never sends API keys or geocodes")
    parser.add_argument("--offline", action="store_true", help="Offline bundle deployment: do not require container-registry connectivity")
    parser.add_argument("--email-transport", choices=("resend", "smtp"), default="resend", help="Required email connectivity, default: resend")
    parser.add_argument("--smtp-host", type=valid_hostname, default="smtp.gmail.com", help="SMTP hostname for --email-transport smtp; no credentials are sent")
    parser.add_argument("--smtp-port", type=int, choices=(465, 587), default=465, help="SMTP verified TLS port, default: 465; 587 requires STARTTLS")
    parser.add_argument("--api-url", type=valid_url, help="Direct API origin, or HTTPS base including /api")
    parser.add_argument("--web-url", type=valid_url, help="Web HTTPS origin")
    parser.add_argument("--config-file", help="Read dotenv names and file permissions, never source it or display values")
    parser.add_argument("--compose-file", action="append", help="Compose file; repeat for overrides")
    parser.add_argument("--project-name", default="tayyn-hyzmat")
    parser.add_argument("--db-user", default="tayyn", help="Local Compose db service PostgreSQL user")
    parser.add_argument("--db-name", default="tayyn", help="Local Compose db service database name")
    parser.add_argument("--disk-path", default="/", help="Filesystem to check; use Docker data filesystem on VPS")
    args = parser.parse_args()
    try:
        report, code = Checks(args).execute()
    except OSError:
        report, code = {"checked_at": datetime.now(timezone.utc).isoformat(),
                        "scope": "remote endpoints from this machine" if args.remote_only else "local deployment host",
                        "summary_exit": 1, "verdict": "FAILED", "production_ready": False,
                        "results": [dict(name="script", status="FAIL", detail="Host inspection failed; verify readable paths and permissions", required=True)]}, 1
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        for row in report["results"]:
            print(f"{row['status']:4} {row['name']}: {row['detail']}")
        print("\nVerdict: " + report["verdict"] + ". This diagnostic does not certify production readiness.")
    return code


if __name__ == "__main__":
    sys.exit(main())
