#!/usr/bin/env python3
"""Read-only runtime checks for a staged release, run just before downtime. No downtime.

On the app host this resolves the new release's Compose configuration with the persistent
/etc/tayyn/app.env, then checks: service images equal the manifest, DOMAIN and TLS_MODE,
explicitly expected non-secret API settings, secret shape (length/difference only; values are
never printed), external TLS certificate hostname/expiry/key match, backup configuration
targeting /opt/tayyn/current, and Docker disk space. It reports pass/fail facts only.

Example:
  premaintenance.py --label 1.22 --release vps-2-<sha> --domain taxi.tayynhyzmat.com \\
    --expect-api-env YANDEX_GEOCODER_REFERER=https://taxi.tayynhyzmat.com/
"""
import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import artifact  # noqa: E402
import remote_step  # noqa: E402

SECRET_HINT = re.compile(r"SECRET|PASSWORD|TOKEN|KEY|CREDENTIAL|JSON|DATABASE_URL|SMTP", re.I)

CHECK_CODE = '''
import json, re, shutil, subprocess
from pathlib import Path
rel = Path("/opt/tayyn/releases") / RELEASE
def run(command):
    return subprocess.run(command, check=True, capture_output=True, text=True, timeout=120).stdout
compose = ["docker", "compose", "--project-name", "tayyn-production", "--env-file", ENV_FILE,
           "--env-file", str(rel / "release.env"), "-f", str(rel / "deploy/production/compose.production.yaml")]
config = json.loads(run(compose + ["config", "--format", "json"]))
manifest = json.loads((rel / "manifest.json").read_text())
failures, facts = [], {}
for role in ("api", "web", "db", "proxy"):
    if config["services"][role]["image"] != manifest["images"][role]["ref"]:
        failures.append("image for " + role + " differs from manifest")
proxy = config["services"]["proxy"]["environment"]
api = config["services"]["api"]["environment"]
if proxy.get("DOMAIN") != DOMAIN:
    failures.append("DOMAIN differs")
if proxy.get("TLS_MODE", "external") != TLS_MODE:
    failures.append("TLS_MODE differs")
for key, value in EXPECT_API_ENV.items():
    if api.get(key) != value:
        failures.append("API setting differs: " + key)
for key in ("JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET"):
    if len(api.get(key, "")) < 32 or "replace" in api.get(key, "").lower():
        failures.append(key + " is too short or a placeholder")
if api.get("JWT_ACCESS_SECRET") == api.get("JWT_REFRESH_SECRET"):
    failures.append("JWT secrets are identical")
if not re.fullmatch(r"[0-9a-f]{32,128}", config["services"]["db"]["environment"].get("POSTGRES_PASSWORD", "")):
    failures.append("POSTGRES_PASSWORD is not 32-128 lowercase hex")
if TLS_MODE == "external":
    mounts = config["services"]["proxy"]["volumes"]
    cert = next(m["source"] for m in mounts if m["target"].endswith("fullchain.pem"))
    key = next(m["source"] for m in mounts if m["target"].endswith("privkey.pem"))
    for name, command in (("certificate expires within the margin", ["-checkend", str(CERT_MARGIN_DAYS * 86400)]),
                          ("certificate does not cover DOMAIN", ["-checkhost", DOMAIN])):
        if subprocess.run(["openssl", "x509", "-in", cert, "-noout", *command], capture_output=True).returncode:
            failures.append(name)
    facts["certificate_not_after"] = run(["openssl", "x509", "-in", cert, "-noout", "-enddate"]).strip()
    if run(["openssl", "x509", "-in", cert, "-pubkey", "-noout"]) != run(["openssl", "pkey", "-in", key, "-pubout"]):
        failures.append("certificate and private key differ")
operations = json.loads(Path(OPERATIONS_CONFIG).read_text())
if operations.get("compose_dir") != "/opt/tayyn/current":
    failures.append("backup configuration does not target /opt/tayyn/current")
current = Path("/opt/tayyn/current").resolve()
facts["current_release"] = current.name
if current == rel:
    failures.append("release is already current")
if EXPECT_CURRENT and current.name != EXPECT_CURRENT:
    failures.append("current release differs from --expect-current")
docker_root = Path(run(["docker", "info", "--format", "{{.DockerRootDir}}"]).strip())
facts["docker_free_gib"] = round(shutil.disk_usage(docker_root).free / 1024 ** 3, 1)
facts["backup_timer"] = subprocess.run(["systemctl", "is-active", "tayyn-backup.timer"], capture_output=True,
                                       text=True).stdout.strip()
write_result({"release": RELEASE, "passed": not failures, "failures": failures, "facts": facts})
if failures:
    raise SystemExit("Pre-maintenance checks failed: " + "; ".join(failures))
'''


def parse_expected(values):
    expected = {}
    for value in values:
        key, separator, setting = value.partition("=")
        if not separator or not re.fullmatch(r"[A-Z][A-Z0-9_]*", key):
            raise ValueError("--expect-api-env must be KEY=VALUE")
        if SECRET_HINT.search(key):
            raise ValueError(f"Refusing to compare a secret-looking setting ({key}); values would enter step logs")
        expected[key] = setting
    return expected


def check_code(*, release, domain, tls_mode, expect_api_env, expect_current="", cert_margin_days=7,
               env_file="/etc/tayyn/app.env", operations_config="/etc/tayyn/operations.json"):
    if not artifact.RELEASE.fullmatch(release):
        raise ValueError("--release must be vps-N-<full commit>")
    if tls_mode not in ("external", "automatic"):
        raise ValueError("--tls-mode must be external or automatic")
    constants = {"RELEASE": release, "DOMAIN": domain, "TLS_MODE": tls_mode, "EXPECT_API_ENV": expect_api_env,
                 "EXPECT_CURRENT": expect_current, "CERT_MARGIN_DAYS": int(cert_margin_days), "ENV_FILE": env_file,
                 "OPERATIONS_CONFIG": operations_config}
    return "".join(f"{name} = {value!r}\n" for name, value in constants.items()) + CHECK_CODE


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    remote_step.add_context_arguments(parser)
    parser.add_argument("--host", default="tayyn-production")
    parser.add_argument("--release", required=True)
    parser.add_argument("--domain", required=True)
    parser.add_argument("--tls-mode", default="external")
    parser.add_argument("--expect-api-env", action="append", default=[], help="Non-secret KEY=VALUE; repeatable")
    parser.add_argument("--expect-current", default="", help="Release name /opt/tayyn/current must point to")
    parser.add_argument("--cert-margin-days", type=int, default=7)
    arguments = parser.parse_args()
    context = remote_step.context_from(arguments)
    code = check_code(release=arguments.release, domain=arguments.domain, tls_mode=arguments.tls_mode,
                      expect_api_env=parse_expected(arguments.expect_api_env), expect_current=arguments.expect_current,
                      cert_margin_days=arguments.cert_margin_days)
    # Read-only, so a re-run simply repeats the checks.
    result = remote_step.run_step(context, arguments.host, f"premaintenance-{arguments.release}", code,
                                  idempotent=True, timeout=300)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, ConnectionError, OSError) as error:
        print(f"Failed: {error}", file=sys.stderr)
        sys.exit(1)
