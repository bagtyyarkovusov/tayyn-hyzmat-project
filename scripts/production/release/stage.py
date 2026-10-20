#!/usr/bin/env python3
"""Stage a locally verified bundle on the app host, then apply it.

stage  NO DOWNTIME. Requires verified-artifact.json from `artifact.py verify`. Steps:
  1. Upload app-bundle.tar.gz to /opt/tayyn/incoming/<release>/ (hash-checked; an identical
     earlier upload is accepted), or use --remote-artifact-zip after a VPS-side download.
  2. Remote step `stage-<release>`: check the archive against the signed hash, safely extract to
     /opt/tayyn/releases/<release> (via a staging dir and rename), check the manifest, then run
     apply-release.py's verify_bundle by executing its source in a no-bytecode interpreter. It never
     imports from the release dir, so no __pycache__ appears there ("Bundle file list changed").
     It checks Docker disk space, loads images.tar, checks each loaded image identity, optionally
     checks pinned files inside the API image, then re-runs verify_bundle.
     The services keep running throughout. Re-running reuses the durable result.
apply  CAUSES DOWNTIME. Remote step `apply-<release>` runs the bundle's own apply-release.py
       (`python3 -B`, no timeout, output kept in the host step dir). It does not take the deploy
       lock itself; apply-release.py does. It stops writers, takes the encrypted
       backup, migrates, starts and health-checks the release, then switches /opt/tayyn/current.
       Never retried automatically: after a failure follow docs/offline-production-bundle.md
       "Recover a failed update".
"""
import argparse
import inspect
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import artifact  # noqa: E402
import remote_step  # noqa: E402

INCOMING = "/opt/tayyn/incoming"

STAGE_CODE = '''
import hashlib, json, shutil, subprocess, tarfile, zipfile
from pathlib import Path, PurePosixPath
hold_deploy_lock()  # no apply or prune may run while images load
releases = Path("/opt/tayyn/releases")
rel = releases / RELEASE
incoming = Path(INCOMING)
archive = incoming / "app-bundle.tar.gz"
def sha(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1048576), b""):
            h.update(chunk)
    return h.hexdigest()
def run(command, timeout=600):
    return subprocess.run(command, check=True, capture_output=True, text=True, timeout=timeout).stdout
if REMOTE_ZIP and not archive.exists():
    incoming.mkdir(mode=0o700, parents=True, exist_ok=True)
    with zipfile.ZipFile(REMOTE_ZIP) as bundle:
        if set(bundle.namelist()) != ARTIFACT_MEMBERS:
            raise SystemExit("Remote artifact zip has unexpected members")
        with bundle.open("app-bundle.tar.gz") as source, archive.open("xb") as output:
            shutil.copyfileobj(source, output)
if sha(archive) != APP_SHA256:
    raise SystemExit("App archive differs from the locally verified signed checksum")
if rel.exists():
    raise SystemExit("Release directory already exists; inspect it instead of overwriting")
staging = releases / (".staging-" + RELEASE)
if staging.exists():
    raise SystemExit("Earlier interrupted extraction found at " + str(staging) + "; remove it after inspection")
staging.mkdir(mode=0o700, parents=True)
with tarfile.open(archive, "r:gz") as bundle:
    extract_members(bundle, safe_members(bundle, RELEASE), staging)
(staging / RELEASE).rename(rel)
staging.rmdir()
manifest = json.loads((rel / "manifest.json").read_text())
check_manifest(manifest, source_commit=SOURCE_COMMIT, version=VERSION)
updater = rel / "scripts/production/apply-release.py"
apply = {"__name__": "apply_release_check"}
exec(compile(updater.read_text(), str(updater), "exec"), apply)
apply["verify_bundle"](rel)
docker_root = Path(run(["docker", "info", "--format", "{{.DockerRootDir}}"]).strip())
needed = max(6 * 1024 ** 3, (rel / "images.tar").stat().st_size * 2)
if shutil.disk_usage(docker_root).free < needed:
    raise SystemExit("Insufficient Docker disk space for load and update")
loaded = subprocess.run(["docker", "load", "-i", str(rel / "images.tar")], capture_output=True, text=True,
                        check=True, timeout=1800)
(PRIVATE_DIR / ("image-load-" + RELEASE + ".log")).write_text(loaded.stdout + loaded.stderr)
ids = {}
for role, image in manifest["images"].items():
    data = json.loads(run(["docker", "image", "inspect", image["ref"]]))[0]
    if data["Architecture"] != "amd64" or data["Os"] != "linux":
        raise SystemExit("Loaded image platform differs for " + role)
    if data["Id"] != image["id"]:
        # containerd exposes manifest IDs; compare exact config bytes as apply-release.py does.
        expected = apply["image_config_digest"](rel / "images.tar", image["ref"])
        if "sha256:" + expected != image["id"]:
            raise SystemExit("Archive config digest differs from the manifest image id for " + role)
        saved = PRIVATE_DIR / (role + "-loaded-check.tar")
        run(["docker", "image", "save", "-o", str(saved), image["ref"]], timeout=1800)
        try:
            if apply["image_config_digest"](saved, image["ref"]) != expected:
                raise SystemExit("Loaded image config differs for " + role)
        finally:
            saved.unlink()
    ids[role] = data["Id"]
pins = {}
for path, want in PINS.items():
    content = subprocess.run(["docker", "run", "--rm", "--network", "none", "--entrypoint", "cat",
                              manifest["images"]["api"]["ref"], path], check=True, capture_output=True,
                             timeout=120).stdout
    if hashlib.sha256(content).hexdigest() != want:
        raise SystemExit("Pinned API image file differs: " + path)
    pins[path] = want
if any(p.name == "__pycache__" for p in rel.rglob("*")):
    raise SystemExit("Bytecode cache appeared inside the release directory")
apply["verify_bundle"](rel)
write_result({"release": str(rel), "source_commit": manifest["sourceCommit"], "version": manifest.get("version"),
              "loaded_image_ids": ids, "pinned_api_files": pins, "bundle_verified": True})
'''


def parse_pins(values):
    pins = {}
    for value in values:
        path, separator, digest = value.rpartition("=")
        if not separator or not path.startswith("/") or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise ValueError("--pin-image-file must be /absolute/path=<sha256>")
        pins[path] = digest
    return pins


def stage_code(*, release, app_sha256, source_commit, version, pins, remote_zip=""):
    """Build the remote step code; helpers are copied from artifact.py so one tested implementation is used."""
    constants = (f"RELEASE = {release!r}\nINCOMING = {INCOMING + '/' + release!r}\nAPP_SHA256 = {app_sha256!r}\n"
                 f"SOURCE_COMMIT = {source_commit!r}\nVERSION = {version!r}\nPINS = {pins!r}\n"
                 f"REMOTE_ZIP = {remote_zip!r}\nARTIFACT_MEMBERS = {artifact.ARTIFACT_MEMBERS!r}\n")
    helpers = "\n".join(inspect.getsource(f) for f in (artifact.safe_members, artifact.extract_members,
                                                         artifact.check_manifest))
    return constants + "from pathlib import Path, PurePosixPath\nimport shutil\n" + helpers + STAGE_CODE


APPLY_CODE = '''
import json, subprocess
from pathlib import Path
rel = Path("/opt/tayyn/releases") / RELEASE
current = Path("/opt/tayyn/current")
if not (PRIVATE_DIR / ("stage-" + RELEASE + ".json")).exists():
    raise SystemExit("Release was not staged by stage.py on this host")
if current.resolve() == rel:
    raise SystemExit("Release is already current")
before = current.resolve().name
result = subprocess.run(["python3", "-B", str(rel / "scripts/production/apply-release.py"), "--bundle", str(rel),
                         "--env-file", "/etc/tayyn/app.env", "--operations-config", "/etc/tayyn/operations.json"],
                        capture_output=True, text=True)  # no timeout: killing it mid-backup/migrate is worse
(PRIVATE_DIR / ("apply-release-" + RELEASE + ".stdout")).write_text(result.stdout)
(PRIVATE_DIR / ("apply-release-" + RELEASE + ".stderr")).write_text(result.stderr)
if result.returncode:
    raise SystemExit("apply-release.py failed; services may be stopped. No automatic restore or retry.")
if current.resolve() != rel:
    raise SystemExit("Updater succeeded but current does not point to the release")
write_result({"applied": True, "release": RELEASE, "previous": before, "current": str(rel)})
'''


def apply_code(release):
    if not artifact.RELEASE.fullmatch(release):
        raise ValueError("--release must be vps-N-<full commit>")
    return f"RELEASE = {release!r}\n" + APPLY_CODE


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    remote_step.add_context_arguments(parser)
    parser.add_argument("--host", default="tayyn-production")
    commands = parser.add_subparsers(dest="command", required=True)
    staging = commands.add_parser("stage", help="Upload, extract, verify and load images (no downtime)")
    staging.add_argument("--artifact-dir", type=Path, required=True, help="Directory with verified-artifact.json")
    staging.add_argument("--remote-artifact-zip", default="",
                         help="Use a zip the VPS downloaded itself (see artifact.py vps-download-command)")
    staging.add_argument("--pin-image-file", action="append", default=[],
                         help="/path/in/api/image=<sha256>, e.g. a reviewed migration.sql; repeatable")
    applying = commands.add_parser("apply", help="Run apply-release.py for a staged release (downtime)")
    applying.add_argument("--release", required=True)
    for sub in (staging, applying):
        sub.add_argument("--allow-rerun", action="store_true",
                         help="Archive an inspected failed/interrupted attempt and run the step again")
        sub.add_argument("--timeout", type=int, default=7200,
                         help="Local wait in seconds; the host step keeps running after it (then use remote_step.py wait)")
    arguments = parser.parse_args()
    context = remote_step.context_from(arguments)
    if arguments.command == "apply":
        result = remote_step.run_step(context, arguments.host, f"apply-{arguments.release}",
                                      apply_code(arguments.release), allow_rerun=arguments.allow_rerun,
                                      timeout=arguments.timeout)
        print(json.dumps(result, indent=2))
        return
    verified = json.loads((arguments.artifact_dir / "verified-artifact.json").read_text())
    if verified.get("signature") != "verified":
        raise ValueError("Artifact is not verified")
    release = verified["release"]
    if not artifact.RELEASE.fullmatch(release):
        raise ValueError("Unexpected release name")
    if arguments.remote_artifact_zip and not arguments.remote_artifact_zip.startswith(f"{INCOMING}/{release}/"):
        raise ValueError(f"--remote-artifact-zip must be under {INCOMING}/{release}/")
    app_sha256 = verified["archives"]["app-bundle.tar.gz"]
    if not arguments.remote_artifact_zip:
        local = arguments.artifact_dir / "app-bundle.tar.gz"
        if remote_step.sha256_file(local) != app_sha256:
            raise ValueError("Local app archive differs from verified checksum")
        remote_step.upload(context, arguments.host, local, f"{INCOMING}/{release}/app-bundle.tar.gz")
        print(f"Uploaded and hash-verified app-bundle.tar.gz on {arguments.host}", flush=True)
    code = stage_code(release=release, app_sha256=app_sha256, source_commit=verified["source_commit"],
                      version=verified.get("version"), pins=parse_pins(arguments.pin_image_file),
                      remote_zip=arguments.remote_artifact_zip)
    result = remote_step.run_step(context, arguments.host, f"stage-{release}", code, allow_rerun=arguments.allow_rerun,
                                  timeout=arguments.timeout)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, ConnectionError, OSError, KeyError) as error:
        print(f"Failed: {error}", file=sys.stderr)
        sys.exit(1)
