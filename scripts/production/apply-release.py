#!/usr/bin/env python3
"""Apply a verified offline bundle. Never restores a production database automatically."""
import argparse
import fcntl
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

PROJECT = "tayyn-production"


def run(command, *, capture=False, timeout=600):
    return subprocess.run(command, check=True, text=True, stdout=subprocess.PIPE if capture else None,
                          stderr=subprocess.PIPE if capture else None, timeout=timeout).stdout


def verify_bundle(bundle):
    expected = {}
    for line in (bundle / "SHA256SUMS").read_text().splitlines():
        checksum, relative = line.split("  ", 1)
        path = (bundle / relative).resolve()
        if not path.is_relative_to(bundle) or not re.fullmatch(r"[0-9a-f]{64}", checksum):
            raise ValueError("Invalid checksum manifest")
        if relative in expected:
            raise ValueError("Duplicate checksum entry")
        expected[relative] = checksum
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest() != checksum:
            raise ValueError(f"Checksum mismatch: {relative}")
    actual = {p.relative_to(bundle).as_posix() for p in bundle.rglob("*") if p.is_file() and p != bundle / "SHA256SUMS"}
    if actual != set(expected):
        raise ValueError("Bundle file list changed")
    required = {"manifest.json", "release.env", "images.tar", "deploy/production/compose.production.yaml", "deploy/production/Caddyfile"}
    if not required <= expected.keys():
        raise ValueError("Required release files missing")
    manifest = json.loads((bundle / "manifest.json").read_text())
    if manifest.get("schema") != 1 or manifest.get("target") != "ubuntu24.04-amd64":
        raise ValueError("Unsupported bundle target/schema")
    for role in ("api", "web", "db", "proxy"):
        image = manifest["images"][role]
        if image["platform"] != "linux/amd64" or not re.fullmatch(r"sha256:[0-9a-f]{64}", image["id"]):
            raise ValueError("Invalid image manifest")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--operations-config", type=Path)
    parser.add_argument("--initialize", action="store_true", help="Bootstrap only an empty production database")
    parser.add_argument("--current-link", type=Path, default=Path("/opt/tayyn/current"))
    args = parser.parse_args()
    if os.geteuid() != 0 or run(["dpkg", "--print-architecture"], capture=True).strip() != "amd64":
        parser.error("Run as root on Ubuntu24.04 amd64")
    os_release = Path("/etc/os-release").read_text()
    if 'ID=ubuntu\n' not in os_release or 'VERSION_ID="24.04"' not in os_release:
        parser.error("Requires Ubuntu24.04")
    if not args.current_link.is_absolute():
        parser.error("--current-link must be absolute")
    # Prevent two installers from racing over the same production volume.
    lock = open("/run/lock/tayyn-deploy.lock", "w")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    apply_release(args)


def apply_release(args):
    """Apply one release after the CLI has checked the host and acquired its lock."""
    bundle = args.bundle.resolve()
    env = args.env_file.resolve()
    if env.is_relative_to(bundle) or env.stat().st_mode & 0o077:
        raise ValueError("Runtime env must be outside the bundle, with mode 0600")
    if args.current_link.resolve() == bundle:
        raise ValueError("This release is already current; use a new release directory")
    manifest = verify_bundle(bundle)
    compose = ["docker", "compose", "--project-name", PROJECT, "--env-file", str(env),
               "--env-file", str(bundle / "release.env"), "-f", str(bundle / "deploy/production/compose.production.yaml")]
    # Capture rather than print resolved configuration: it contains secrets.
    config = json.loads(run(compose + ["config", "--format", "json"], capture=True))
    api_env = config["services"]["api"]["environment"]
    domain = config["services"]["proxy"]["environment"]["DOMAIN"]
    if not re.fullmatch(r"(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}", domain):
        raise ValueError("DOMAIN must be a lowercase hostname without scheme or path")
    password = config["services"]["db"]["environment"]["POSTGRES_PASSWORD"]
    if not re.fullmatch(r"[0-9a-f]{32,128}", password):
        raise ValueError("POSTGRES_PASSWORD must be 32–128 lowercase hex characters for safe URL encoding")
    for key in ("JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET"):
        if len(api_env[key]) < 32 or "replace" in api_env[key].lower():
            raise ValueError(f"{key} needs a unique generated secret of at least 32 characters")
    if api_env["JWT_ACCESS_SECRET"] == api_env["JWT_REFRESH_SECRET"]:
        raise ValueError("JWT secrets must differ")
    if not re.fullmatch(r"\+993[0-9]{8}", api_env["SEED_ADMIN_PHONE"]):
        raise ValueError("Admin phone must be canonical +993 plus 8 digits")
    if len(api_env["SEED_ADMIN_PASSWORD"]) < 6 or len(api_env["SEED_ADMIN_PASSWORD"].encode()) > 72 or api_env["SEED_ADMIN_PASSWORD"] == "ChangeMe123!" or "replace" in api_env["SEED_ADMIN_PASSWORD"].lower():
        raise ValueError("Set a unique admin password, at least 6 characters and at most 72 UTF8 bytes")
    for role in ("api", "web", "db", "proxy"):
        if config["services"][role]["image"] != manifest["images"][role]["ref"]:
            raise ValueError("release.env disagrees with image manifest")
    mounts = config["services"]["proxy"]["volumes"]
    cert = next(m["source"] for m in mounts if m["target"].endswith("fullchain.pem"))
    key = next(m["source"] for m in mounts if m["target"].endswith("privkey.pem"))
    run(["openssl", "x509", "-in", cert, "-noout", "-checkend", "604800"], capture=True)
    run(["openssl", "x509", "-in", cert, "-noout", "-checkhost", domain], capture=True)
    cert_public = run(["openssl", "x509", "-in", cert, "-pubkey", "-noout"], capture=True)
    key_public = run(["openssl", "pkey", "-in", key, "-pubout"], capture=True)
    if cert_public != key_public:
        raise ValueError("TLS certificate and private key differ")
    if not args.initialize:
        if not args.operations_config:
            raise ValueError("Updates require --operations-config for encrypted backup")
        operation_config = json.loads(args.operations_config.read_text())
        if operation_config.get("role") != "app" or operation_config.get("project", PROJECT) != PROJECT:
            raise ValueError("Backup configuration must target this production app project")
        if Path(operation_config["compose_dir"]).resolve() != args.current_link.resolve():
            raise ValueError("Backup configuration must target the current release")
    required_space = max(6 * 1024 ** 3, (bundle / "images.tar").stat().st_size * 2)
    docker_root = Path(run(["docker", "info", "--format", "{{.DockerRootDir}}"], capture=True).strip())
    if shutil.disk_usage(docker_root).free < required_space:
        raise ValueError("Insufficient Docker disk space; need at least 6 GiB and twice the image archive size free")
    # Loading/validating files does not mutate the database and is completed
    # before stopping writers, so transfer/platform failures do not cause downtime.
    run(["docker", "load", "-i", str(bundle / "images.tar")], timeout=1800)
    for image in manifest["images"].values():
        loaded = json.loads(run(["docker", "image", "inspect", image["ref"]], capture=True))[0]
        if loaded["Id"] != image["id"] or loaded["Architecture"] != "amd64" or loaded["Os"] != "linux":
            raise ValueError("Loaded image identity/platform differs from manifest")
    if not args.initialize:
        # Stop writers first: the backup contains the last committed pre-update state.
        run(compose + ["stop", "proxy", "web", "api"])
        run(["python3", str(bundle / "scripts/production/operations.py"), "--config", str(args.operations_config), "backup"])
    run(compose + ["up", "-d", "--pull", "never", "--wait", "--wait-timeout", "120", "db"])
    if args.initialize:
        count = run(compose + ["exec", "-T", "db", "psql", "-U", "tayyn", "-d", "tayyn", "-Atc",
                             "SELECT count(*) FROM pg_tables WHERE schemaname='public'"], capture=True).strip()
        if count != "0":
            raise ValueError("Initialization refused: database already contains tables")
    run(compose + ["run", "--rm", "--no-deps", "--pull", "never", "migrate"])
    if args.initialize:
        run(compose + ["run", "--rm", "--no-deps", "--pull", "never", "api", "node", "prisma/seed.js"])
    run(compose + ["up", "-d", "--pull", "never", "--wait", "--wait-timeout", "120", "api", "web", "proxy"])
    run(compose + ["exec", "-T", "db", "psql", "-U", "tayyn", "-d", "tayyn", "-Atc", "SELECT 1"], capture=True)
    run(["curl", "--fail", "--silent", "--show-error", "--max-time", "15", f"https://{domain}/health"], capture=True)
    args.current_link.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.current_link.with_name(args.current_link.name + ".next")
    if temporary.is_symlink():
        temporary.unlink()
    temporary.symlink_to(bundle, target_is_directory=True)
    temporary.replace(args.current_link)
    print("Release started and current link updated. Run readiness, restore drill and real-phone acceptance gates before declaring production ready.")


if __name__ == "__main__":
    try:
        main()
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, ValueError, OSError, KeyError) as error:
        # Avoid printing command/config output, which can include credentials.
        print(f"Release failed: {type(error).__name__}. Services may remain stopped after maintenance begins; see docs/offline-production-bundle.md recovery steps. No automatic database restore was attempted.", file=sys.stderr)
        sys.exit(1)
