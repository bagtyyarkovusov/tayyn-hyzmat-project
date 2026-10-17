#!/usr/bin/env python3
"""Export already-built amd64 images and reviewed deployment files, without secrets."""
import argparse
import hashlib
import json
import re
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FILES = [
    "deploy/production/compose.production.yaml", "deploy/production/Caddyfile",
    "deploy/production/compose.automatic-tls.yaml", "deploy/production/Caddyfile.automatic",
    "deploy/production/production.env.example", "scripts/production/apply-release.py",
    "scripts/production/install-offline-packages.sh", "scripts/production/build-offline-bundle.py",
    "scripts/production/prepare-offline-packages.sh",
    "scripts/production/setup-wizard.sh", "scripts/production/operations.py",
    "scripts/production-readiness.py", "docs/offline-production-bundle.md",
    "docs/production-handoff.md", "docs/production-operations.md",
    "docs/production-update-runbook.md",
    "docs/research/production-dns-certificate-renewal.md",
]


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release", required=True, help="Unique lowercase release identifier")
    for role in ("api", "web", "db", "proxy"):
        parser.add_argument(f"--{role}", required=True, help="Already loaded linux/amd64 image reference")
    parser.add_argument("--deb-dir", type=Path, required=True, help="Reviewed Ubuntu24.04 amd64/all .deb files")
    parser.add_argument("--monitor-deb-dir", type=Path, required=True, help="Non-Docker package set for StandardS monitoring host")
    parser.add_argument("--monitor-output-dir", type=Path, help="Separate small monitor bundle; defaults to OUTPUT_DIR-monitor")
    parser.add_argument("--output-dir", type=Path, required=True, help="New directory, must not exist")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,79}", args.release):
        parser.error("Invalid release identifier")
    monitor_output = args.monitor_output_dir or args.output_dir.with_name(args.output_dir.name + "-monitor")
    if args.output_dir.exists() or monitor_output.exists() or args.output_dir.resolve() == monitor_output.resolve():
        parser.error("Output directory already exists or overlaps; releases are never overwritten")
    if monitor_output.resolve().is_relative_to(args.output_dir.resolve()) or args.output_dir.resolve().is_relative_to(monitor_output.resolve()):
        parser.error("App and monitoring bundles must use separate directories")
    packages = sorted(args.deb_dir.glob("*.deb"))
    monitor_packages = sorted(args.monitor_deb_dir.glob("*.deb"))
    if not monitor_packages:
        parser.error("No monitoring .deb packages supplied")
    if not packages:
        parser.error("No .deb packages supplied")
    for path in packages + monitor_packages:
        if not re.fullmatch(r"[A-Za-z0-9._+~%:-]+\.deb", path.name):
            parser.error("Invalid package filename")
        arch = run("dpkg-deb", "--field", str(path), "Architecture")
        if arch not in ("amd64", "all"):
            parser.error(f"Wrong package architecture: {path.name}")
    images = {}
    for role in ("api", "web", "db", "proxy"):
        data = json.loads(run("docker", "image", "inspect", getattr(args, role)))[0]
        if data["Os"] != "linux" or data["Architecture"] != "amd64":
            parser.error(f"{role} must be linux/amd64; pull/build with --platform linux/amd64 first")
        if role == "db" and "PG_MAJOR=17" not in data.get("Config", {}).get("Env", []):
            parser.error("Only PostgreSQL17 is supported; major upgrades require a separate plan")
        images[role] = {"id": data["Id"], "ref": f"tayyn-offline/{role}:{args.release}", "platform": "linux/amd64"}
        existing = subprocess.run(["docker", "image", "inspect", images[role]["ref"]], text=True, capture_output=True)
        if existing.returncode == 0 and json.loads(existing.stdout)[0]["Id"] != data["Id"]:
            parser.error(f"Release image reference already has different content: {role}")
    # All required inputs are checked before creating the immutable output directory.
    for relative in FILES:
        if not (ROOT / relative).is_file():
            parser.error(f"Required bundle file missing: {relative}")
    args.output_dir.mkdir(parents=True, mode=0o700)
    for relative in FILES:
        target = args.output_dir / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / relative, target)
    monitoring = ROOT / "deploy/monitoring"
    if monitoring.exists():
        for source in monitoring.iterdir():
            if source.is_file() and (source.suffix in (".service", ".timer") or source.name in {"app-operations.example.json", "monitor-operations.example.json", "monitor-secrets.example.json", "monitor-secrets.smtp.example.json", "authorized_keys.example", "tayyn-backup.sudoers.example"}):
                target = args.output_dir / "deploy/monitoring" / source.name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)
    package_target = args.output_dir / "packages"
    package_target.mkdir()
    for source in packages:
        shutil.copy2(source, package_target / source.name)
    metadata = args.deb_dir / "PACKAGES.tsv"
    if metadata.is_file():
        shutil.copy2(metadata, package_target / "PACKAGES.tsv")
    monitor_target = args.output_dir / "packages-monitor"
    monitor_target.mkdir()
    for source in monitor_packages:
        shutil.copy2(source, monitor_target / source.name)
    metadata = args.monitor_deb_dir / "PACKAGES.tsv"
    if metadata.is_file():
        shutil.copy2(metadata, monitor_target / "PACKAGES.tsv")
    for image in images.values():
        subprocess.run(["docker", "tag", image["id"], image["ref"]], check=True)
    subprocess.run(["docker", "save", "-o", str(args.output_dir / "images.tar"), *[v["ref"] for v in images.values()]], check=True)
    (args.output_dir / "release.env").write_text("".join(f"{role.upper()}_IMAGE={value['ref']}\n" for role, value in images.items()))
    manifest = {
        "schema": 1, "role": "app", "release": args.release, "createdAt": datetime.now(timezone.utc).isoformat(),
        "target": "ubuntu24.04-amd64", "sourceCommit": run("git", "-C", str(ROOT), "rev-parse", "HEAD"),
        "sourceDirty": bool(run("git", "-C", str(ROOT), "status", "--porcelain")),
        "images": images, "packages": [p.name for p in packages], "monitorPackages": [p.name for p in monitor_packages],
        "packageDependencyClosureVerified": False,
        "notice": "Verify package dependency closure and boot on a disposable clean Ubuntu24.04 amd64 machine before production.",
    }
    (args.output_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    files = sorted(path for path in args.output_dir.rglob("*") if path.is_file())
    (args.output_dir / "SHA256SUMS").write_text("".join(f"{digest(path)}  {path.relative_to(args.output_dir).as_posix()}\n" for path in files))
    # StandardS has only10GB. Export a separate small artifact so its installer
    # can verify every file without transferring app images or Docker packages.
    monitor_output.mkdir(parents=True, mode=0o700)
    monitor_files = ["scripts/production/install-offline-packages.sh", "scripts/production/operations.py",
                     "scripts/production/setup-wizard.sh", "scripts/production-readiness.py",
                     "docs/production-handoff.md", "docs/production-operations.md", "docs/production-update-runbook.md", "docs/offline-production-bundle.md"]
    for relative in monitor_files:
        target = monitor_output / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(args.output_dir / relative, target)
    shutil.copytree(args.output_dir / "deploy/monitoring", monitor_output / "deploy/monitoring")
    shutil.copytree(monitor_target, monitor_output / "packages-monitor")
    monitor_manifest = {key: value for key, value in manifest.items() if key not in {"images", "packages", "monitorPackages"}}
    monitor_manifest.update({"role": "monitor", "packages": [p.name for p in monitor_packages]})
    (monitor_output / "manifest.json").write_text(json.dumps(monitor_manifest, indent=2) + "\n")
    monitor_files = sorted(path for path in monitor_output.rglob("*") if path.is_file())
    (monitor_output / "SHA256SUMS").write_text("".join(f"{digest(path)}  {path.relative_to(monitor_output).as_posix()}\n" for path in monitor_files))
    print(f"App bundle: {args.output_dir}. Monitor bundle: {monitor_output}. No production credentials copied. Clean Ubuntu rehearsal remains required.")


if __name__ == "__main__":
    main()
