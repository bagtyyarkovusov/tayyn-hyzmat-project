#!/usr/bin/env python3
"""Download and verify a signed offline-production artifact on the operator workstation.

download             Resumable HTTP-range download with per-range retries. Completed ranges
                     are kept under <output>.ranges/ and reused after an interruption. The
                     signed artifact URL is read from an owner-only file, never argv.
verify               Extract the artifact zip, run verify-release-signature.sh, check archive
                     member safety and manifest identity, and (by default) extract the app
                     bundle locally and run apply-release.py's verify_bundle in a separate
                     `python3 -B -I` process. Writes verified-artifact.json.
vps-download-command Print (never run) an SSH command that lets the VPS fetch the same zip
                     directly. The VPS copy is accepted only when stage.py finds the app
                     archive hash signed and verified here.

Get the short-lived URL with, e.g.:
  gh api repos/OWNER/REPO/actions/artifacts/ARTIFACT_ID/zip -i | sed -n 's/^location: //Ip' > url.private
"""
import argparse
import concurrent.futures
import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath

sys.path.insert(0, str(Path(__file__).resolve().parent))
from remote_step import private_directory, sha256_file, write_json_atomic  # noqa: E402

ROOT = Path(__file__).resolve().parents[3]
CHUNK = 4 * 1024 * 1024
ARTIFACT_MEMBERS = {"app-bundle.tar.gz", "monitor-bundle.tar.gz", "bundle-archives.sha256",
                    "bundle-archives.sha256.sigstore.json"}
RELEASE = re.compile(r"vps-[1-9][0-9]{0,5}-[0-9a-f]{40}")


class RangeError(Exception):
    """One range response was incomplete or did not match the requested bytes."""


def http_range_fetch(url, start, end, timeout=75):
    """Fetch bytes start..end inclusive; return (content_range_header, body)."""
    request = urllib.request.Request(url, headers={"Range": f"bytes={start}-{end}"})
    with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 - operator-supplied https URL
        if response.status != 206:
            raise RangeError(f"Expected HTTP 206, got {response.status}")
        return response.headers.get("Content-Range", ""), response.read()


def probe_size(url, fetch=http_range_fetch):
    header, _ = fetch(url, 0, 0)
    match = re.fullmatch(r"bytes 0-0/([0-9]+)", header.strip())
    if not match:
        raise RangeError("Server did not report the total size; pass --size")
    return int(match.group(1))


def download_ranged(url, output, size, *, sha256=None, chunk=CHUNK, retries=5, workers=4, fetch=http_range_fetch,
                    sleep=time.sleep, progress=None):
    """Download `size` bytes to new file `output` using verified ranges; resume from kept ranges.

    A range is accepted only when its Content-Range header and length match. The assembled file must
    match `size` and, when given, `sha256`; otherwise nothing is written at `output`.
    """
    sha256 = normalise_sha256(sha256)
    output = Path(output)
    if output.exists():
        raise FileExistsError(f"Refusing existing {output}")
    parts = private_directory(output.with_name(output.name + ".ranges"))
    count = (size + chunk - 1) // chunk

    def get(index):
        start = index * chunk
        end = min(size, start + chunk) - 1
        target = parts / f"{index:05d}.part"
        if target.exists() and target.stat().st_size == end - start + 1:
            return index
        last = None
        for attempt in range(retries):
            try:
                header, body = fetch(url, start, end)
                if header.strip().lower() != f"bytes {start}-{end}/{size}" or len(body) != end - start + 1:
                    raise RangeError(f"Range {index} mismatch")
                temporary = target.with_suffix(".tmp")
                temporary.write_bytes(body)
                temporary.replace(target)
                return index
            except (OSError, RangeError, urllib.error.URLError) as error:
                last = error
                sleep(min(30, 2 ** attempt))
        raise RangeError(f"Range {index} failed after {retries} attempts: {type(last).__name__}")

    # Attempt every range before failing, so a later resume has as much as possible kept.
    failures = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(get, index) for index in range(count)]
        for done, future in enumerate(concurrent.futures.as_completed(futures), 1):
            try:
                future.result()
            except RangeError as error:
                failures.append(str(error))
            if progress and (done % 16 == 0 or done == count):
                progress(f"Checked ranges {done}/{count}, failed {len(failures)}")
    if failures:
        raise RangeError(f"{len(failures)} of {count} ranges failed; re-run the same command to resume")
    partial = output.with_name(output.name + ".partial")
    with partial.open("wb") as stream:
        os.fchmod(stream.fileno(), 0o600)
        for index in range(count):
            with (parts / f"{index:05d}.part").open("rb") as source:
                shutil.copyfileobj(source, stream)
    if partial.stat().st_size != size:
        partial.unlink()
        raise ValueError("Assembled size differs")
    if sha256 and sha256_file(partial) != sha256:
        partial.unlink()
        raise ValueError("Assembled SHA-256 differs; kept ranges may be corrupt - delete them and retry")
    partial.rename(output)
    shutil.rmtree(parts)
    return output


def normalise_sha256(value):
    """Accept a bare or GitHub-style `sha256:` digest; return 64 lowercase hex characters."""
    if value is None:
        return None
    digest = value.strip().lower().removeprefix("sha256:")
    if not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise ValueError("--sha256 must be 64 hex characters, optionally prefixed with sha256:")
    return digest


def read_private_text(path):
    path = Path(path)
    if not path.is_file() or path.stat().st_mode & 0o077:
        raise ValueError(f"{path} must be an owner-only file (mode 0600)")
    return path.read_text().strip()


def safe_members(archive, root):
    """Return tar members after checking each is a plain file/dir under `root`, unique and relative."""
    members, seen = archive.getmembers(), set()
    for member in members:
        path = PurePosixPath(member.name)
        name = str(path)
        if path.is_absolute() or ".." in path.parts or not path.parts or path.parts[0] != root:
            raise ValueError(f"Unsafe archive path: {member.name}")
        if not (member.isdir() or member.isfile()):
            raise ValueError(f"Archive member is not a regular file or directory: {member.name}")
        if name in seen:
            raise ValueError(f"Duplicate archive member: {member.name}")
        seen.add(name)
    return members


def extract_members(archive, members, destination):
    for member in members:
        target = Path(destination).joinpath(*PurePosixPath(member.name).parts)
        if member.isdir():
            target.mkdir(mode=0o700, parents=True, exist_ok=True)
        else:
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            with archive.extractfile(member) as source, target.open("xb") as output:
                shutil.copyfileobj(source, output)


def check_manifest(manifest, *, source_commit, version):
    problems = []
    if manifest.get("sourceCommit") != source_commit:
        problems.append("sourceCommit differs")
    if manifest.get("sourceDirty") is not False:
        problems.append("source was dirty")
    if version and manifest.get("version") != version:
        problems.append("version differs")
    if manifest.get("schema") != 1 or manifest.get("target") != "ubuntu24.04-amd64":
        problems.append("schema/target unsupported")
    if problems:
        raise ValueError("Manifest rejected: " + ", ".join(problems))


def signed_checksums(directory):
    entries = {}
    for line in (Path(directory) / "bundle-archives.sha256").read_text().splitlines():
        digest, name = line.split("  ", 1)
        entries[name] = digest
    return entries


def verify(arguments):
    release = arguments.release
    if not RELEASE.fullmatch(release) or not release.endswith(arguments.source_commit):
        raise ValueError("--release must be vps-N-<full source commit>")
    directory = private_directory(arguments.artifact_dir)
    with zipfile.ZipFile(arguments.zip) as archive:
        if set(archive.namelist()) != ARTIFACT_MEMBERS:
            raise ValueError("Artifact zip has unexpected members")
        for name in sorted(ARTIFACT_MEMBERS):
            target = directory / name
            if target.exists():
                # Resume: accept an identical earlier extraction only.
                with archive.open(name) as source:
                    digest = hashlib.sha256()
                    for data in iter(lambda: source.read(1024 * 1024), b""):
                        digest.update(data)
                if target.is_symlink() or digest.hexdigest() != sha256_file(target):
                    raise ValueError(f"Existing {name} differs from the zip")
                continue
            with archive.open(name) as source, target.open("xb") as output:
                shutil.copyfileobj(source, output)
    with (directory / "signature-verification.log").open("a") as log:
        subprocess.run(["bash", str(arguments.verifier), str(directory)], stdout=log, stderr=subprocess.STDOUT,
                       check=True, timeout=300)
    manifest = None
    for name, root in (("app-bundle.tar.gz", release), ("monitor-bundle.tar.gz", release + "-monitor")):
        with tarfile.open(directory / name, "r:gz") as archive:
            members = safe_members(archive, root)
            if name == "app-bundle.tar.gz":
                manifest = json.load(archive.extractfile(f"{root}/manifest.json"))
                check_manifest(manifest, source_commit=arguments.source_commit, version=arguments.version)
                if not arguments.skip_local_bundle_check:
                    if (directory / root).exists():
                        raise ValueError(f"Refusing existing extracted {directory / root}; remove it to re-check")
                    extract_members(archive, members, directory)
    if not arguments.skip_local_bundle_check:
        # A fresh isolated interpreter without bytecode writes, never importing from the bundle.
        check = ("import json,sys;ns={'__name__':'apply_release_check'};"
                 "exec(compile(open(sys.argv[1]).read(),sys.argv[1],'exec'),ns);"
                 "from pathlib import Path;print(json.dumps(ns['verify_bundle'](Path(sys.argv[2]).resolve())))")
        subprocess.run([sys.executable, "-B", "-I", "-c", check, str(ROOT / "scripts/production/apply-release.py"),
                        str(directory / release)], check=True, capture_output=True, text=True, timeout=1800)
    record = {"release": release, "source_commit": arguments.source_commit, "version": manifest.get("version"),
              "signature": "verified", "archives": signed_checksums(directory), "images": manifest["images"],
              "local_bundle_verified": not arguments.skip_local_bundle_check}
    write_json_atomic(directory / "verified-artifact.json", record)
    print(json.dumps(record, indent=2))


def vps_download_command(*, ssh_config, host, url_file, destination, size, nc_interface=""):
    """Return (curl_config_text, shell_command). The URL travels on stdin, never in argv or the command."""
    url = read_private_text(url_file)
    if not url.startswith("https://") or any(c in url for c in "\"\n\\"):
        raise ValueError("Artifact URL must be one https URL")
    if not destination.startswith("/opt/tayyn/incoming/") or ".." in destination:
        raise ValueError("Destination must be under /opt/tayyn/incoming/")
    config = f'url = "{url}"\n'
    remote = (f"umask 077 && mkdir -p {shlex.quote(str(PurePosixPath(destination).parent))} && "
              f"curl --fail --silent --show-error --location --connect-timeout 15 --retry 5 --retry-all-errors "
              f"--continue-at - --output {shlex.quote(destination)} --config - && "
              f"test \"$(stat -c %s {shlex.quote(destination)})\" = {int(size)}")
    ssh = ["ssh", "-F", str(ssh_config)] + (["-o", f"ProxyCommand=nc -b {nc_interface} %h %p"] if nc_interface else [])
    command = shlex.join(ssh + [host, "--", "sudo sh -c " + shlex.quote(remote)])
    return config, command


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    download = commands.add_parser("download", help="Resumable verified range download")
    download.add_argument("--url-file", type=Path, required=True, help="Owner-only file holding the signed URL")
    download.add_argument("--output", type=Path, required=True, help="New zip path, e.g. .local/releases/RUN/artifact.zip")
    download.add_argument("--size", type=int, help="Expected bytes (GitHub artifact size_in_bytes); probed if omitted")
    download.add_argument("--sha256", help="Expected zip SHA-256, bare or `sha256:` (GitHub artifact digest)")
    download.add_argument("--workers", type=int, default=4)
    check = commands.add_parser("verify", help="Verify signature, archives and manifest")
    check.add_argument("--zip", type=Path, required=True)
    check.add_argument("--artifact-dir", type=Path, required=True)
    check.add_argument("--release", required=True, help="vps-N-<full commit>")
    check.add_argument("--source-commit", required=True)
    check.add_argument("--version", help="Expected manifest version, e.g. v1.22.0")
    check.add_argument("--verifier", type=Path, default=ROOT / "scripts/production/verify-release-signature.sh")
    check.add_argument("--skip-local-bundle-check", action="store_true",
                       help="Skip local extraction and verify_bundle (saves ~1 GB disk)")
    vps = commands.add_parser("vps-download-command", help="Print a VPS-side direct download command; runs nothing")
    vps.add_argument("--ssh-config", type=Path, default=os.environ.get("TAYYN_SSH_CONFIG"), required=False)
    vps.add_argument("--nc-interface", default=os.environ.get("TAYYN_SSH_NC_INTERFACE", ""))
    vps.add_argument("--host", default="tayyn-production")
    vps.add_argument("--url-file", type=Path, required=True)
    vps.add_argument("--destination", required=True, help="/opt/tayyn/incoming/<release>/artifact.zip")
    vps.add_argument("--size", type=int, required=True)
    vps.add_argument("--config-out", type=Path, required=True, help="New owner-only curl config file to write")
    arguments = parser.parse_args()
    if arguments.command == "download":
        expected = normalise_sha256(arguments.sha256)  # validated before any download
        url = read_private_text(arguments.url_file)
        size = arguments.size or probe_size(url)
        download_ranged(url, arguments.output, size, sha256=expected, workers=arguments.workers,
                        progress=lambda message: print(message, flush=True))
        print(json.dumps({"artifact": str(arguments.output), "size": size, "sha256": sha256_file(arguments.output)}))
    elif arguments.command == "verify":
        verify(arguments)
    else:
        if not arguments.ssh_config:
            parser.error("Pass --ssh-config or set TAYYN_SSH_CONFIG")
        config, command = vps_download_command(ssh_config=arguments.ssh_config, host=arguments.host,
                                               url_file=arguments.url_file, destination=arguments.destination,
                                               size=arguments.size, nc_interface=arguments.nc_interface)
        with arguments.config_out.open("x") as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(config)
        print("# Review, then run manually. The URL is read from the private curl config on stdin:")
        print(f"{command} < {shlex.quote(str(arguments.config_out))}")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RangeError, OSError, subprocess.CalledProcessError, tarfile.TarError, zipfile.BadZipFile,
            KeyError) as error:
        print(f"Failed: {type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
