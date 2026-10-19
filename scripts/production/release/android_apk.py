#!/usr/bin/env python3
"""Build and statically verify the signed production Android APK on the operator Mac.

stage-signing-inputs  In a worktree, link the ignored signing inputs from the canonical checkout:
                      every file in android/keystore/ and android/app/src/release/google-services.json
                      become symlinks; android/app/src/debug/google-services.json is copied (0600).
                      Every target must be git-ignored. Re-running is safe; differing files are refused.
build                 From a clean HEAD equal to --approved-sha: run `pnpm android:assembleRelease`
                      with production URLs and the maps client key from a private file, restore the
                      tracked android/capacitor.settings.gradle that `cap sync` rewrites, then verify
                      package/version (from android/app/build.gradle), signing certificate, not
                      debuggable, embedded production URLs and maps key, fresh dist-driver asset graph,
                      no test/server credential markers, no secret files and no signing passwords.
                      Writes the APK, SHA256SUMS and build-provenance.json to a new private directory.

An Android-only release is tagged `android-<versionName>`; a `v*` tag would publish server images.
"""
import argparse
import datetime
import filecmp
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
GRADLE = "android/app/build.gradle"
GENERATED = "android/capacitor.settings.gradle"
BUILT_APK = "android/app/build/outputs/apk/release/TayynHyzmat-release.apk"
# Public fingerprint of the production signing certificate (docs/android.md); not a secret.
PRODUCTION_CERT_SHA256 = "a675842c5d0c2bfb62b08c02aff99687b66c8580180591a4ebf8169716d240b6"
LINKED = ("android/app/src/release/google-services.json",)
COPIED = ("android/app/src/debug/google-services.json",)
FORBIDDEN_MARKERS = (b"api.example.invalid", b"apk-api-apk-test", b"apk-web-apk-test", b"web-dev-74bc",
                     b"web-development-d17b", b"-----BEGIN PRIVATE KEY-----", b"firebase-adminsdk",
                     b'"type":"service_account"', b'"type": "service_account"', b"postgresql://", b"DATABASE_URL=",
                     b"JWT_SECRET=")
SECRET_FILE = re.compile(r"(?:^|/)(?:\.env(?:\.|$)|keystore\.properties|[^/]+\.(?:jks|keystore|pem|key))")
LOCAL_API = re.compile(rb"https?://(?:127\.0\.0\.1|localhost)(?::[0-9]+)?/(?:api|auth|districts)")


def parse_gradle_version(text):
    """Return (applicationId, versionName, versionCode) from the defaultConfig of build.gradle."""
    values = {}
    for key, pattern in (("applicationId", r'^\s*applicationId\s+"([^"]+)"'),
                         ("versionName", r'^\s*versionName\s+"([^"]+)"'), ("versionCode", r"^\s*versionCode\s+([0-9]+)")):
        found = re.findall(pattern, text, re.M)
        if len(found) != 1:
            raise ValueError(f"Expected exactly one {key} in {GRADLE}, found {len(found)}")
        values[key] = found[0]
    return values["applicationId"], values["versionName"], int(values["versionCode"])


def git_ignored(worktree, relative):
    return subprocess.run(["git", "-C", str(worktree), "check-ignore", "-q", relative]).returncode == 0


def stage_signing_inputs(canonical, worktree, *, is_ignored=git_ignored):
    """Create ignored signing-input links/copies in `worktree`; return {relative path: action}."""
    canonical, worktree = Path(canonical).resolve(), Path(worktree).resolve()
    if canonical == worktree:
        raise ValueError("Worktree is the canonical checkout")
    keystore = canonical / "android/keystore"
    linked = sorted(p.relative_to(canonical).as_posix() for p in keystore.iterdir()
                    if p.is_file() and not p.is_symlink()) if keystore.is_dir() else []
    if not any(name.endswith("keystore.properties") for name in linked):
        raise ValueError("Canonical android/keystore/keystore.properties is missing")
    plan = [(name, "link") for name in linked + [n for n in LINKED if (canonical / n).is_file()]]
    plan += [(name, "copy") for name in COPIED if (canonical / name).is_file()]
    for name, _ in plan:
        if not is_ignored(worktree, name):
            raise ValueError(f"{name} is not git-ignored in the worktree; refusing to place a secret there")
    actions = {}
    for name, kind in plan:
        source, target = canonical / name, worktree / name
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if target.is_symlink() or target.exists():
            same = (target.is_symlink() and target.resolve() == source.resolve()) if kind == "link" else (
                not target.is_symlink() and target.is_file() and filecmp.cmp(source, target, shallow=False))
            if not same:
                raise ValueError(f"{name} already exists with different content; inspect it")
            actions[name] = "unchanged"
            continue
        if kind == "link":
            target.symlink_to(source)
        else:
            shutil.copyfile(source, target)
            target.chmod(0o600)
        actions[name] = kind
    return actions


def scan_web_assets(web, *, api_url, socket_url, maps_key):
    """Return problems found in packaged web assets ({name: bytes} under assets/public/)."""
    problems = []
    text = b"\n".join(v for n, v in web.items() if n.endswith((".js", ".html", ".json", ".css")))
    for needed, label in ((api_url.encode(), "production API URL"), (socket_url.encode(), "production socket URL"),
                          (maps_key.encode(), "maps client key")):
        if needed not in text:
            problems.append(f"Missing {label}")
    if any(marker in text for marker in FORBIDDEN_MARKERS):
        problems.append("Forbidden embedded test/server credential marker")
    if any(LOCAL_API.search(v) for n, v in web.items() if n.endswith((".js", ".html", ".json"))):
        problems.append("Localhost API target")
    return problems


def scan_names(names):
    return [f"Secret-looking file in APK: {n}" for n in names if SECRET_FILE.search(n)]


def stale_assets(web, dist):
    """Compare every built dist-driver file with its packaged copy."""
    dist = Path(dist)
    expected = {p.relative_to(dist).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                for p in dist.rglob("*") if p.is_file()}
    problems = [f"Stale or missing web asset {n}" for n, h in expected.items()
                if hashlib.sha256(web.get("assets/public/" + n, b"")).hexdigest() != h]
    if len([n for n in expected if n.endswith(".js")]) < 5:
        problems.append("Incomplete frontend assets")
    return problems


def read_properties(path):
    values = {}
    for line in Path(path).read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip()
    return values


def command(arguments, **kwargs):
    return subprocess.run(arguments, check=True, capture_output=True, text=True, **kwargs).stdout


def private_file(path):
    path = Path(path)
    if not path.is_file() or path.stat().st_mode & 0o077:
        raise ValueError(f"{path} must be an owner-only file (mode 0600)")
    return path.read_text().strip()


def build(arguments):
    os.umask(0o077)
    os.chdir(ROOT)
    if command(["git", "rev-parse", "HEAD"]).strip() != arguments.approved_sha:
        raise ValueError("HEAD differs from --approved-sha")
    if command(["git", "status", "--porcelain"]).strip():
        raise ValueError("Source must be clean before the build")
    package, version_name, version_code = parse_gradle_version((ROOT / GRADLE).read_text())
    for flag, actual in (("expect_version_name", version_name), ("expect_version_code", version_code)):
        wanted = getattr(arguments, flag)
        if wanted is not None and str(wanted) != str(actual):
            raise ValueError(f"build.gradle {flag[7:]} is {actual}, expected {wanted}")
    if not (ROOT / "android/keystore/keystore.properties").exists():
        raise ValueError("Signing inputs missing; run stage-signing-inputs first")
    output = arguments.output_dir or ROOT / f".local/release-{version_name}/artifacts-{arguments.approved_sha}"
    output.mkdir(mode=0o700, parents=True)
    api_url, socket_url = arguments.origin.rstrip("/") + "/api", arguments.origin.rstrip("/")
    maps_key = private_file(arguments.maps_key_file)
    env = {k: v for k, v in os.environ.items() if not k.startswith(("VITE_", "VUE_APP_"))}
    env.update(JAVA_HOME=arguments.java_home, ANDROID_HOME=arguments.android_home,
               ANDROID_SDK_ROOT=arguments.android_home, VITE_API_URL=api_url, VITE_SOCKET_URL=socket_url,
               VITE_YANDEX_MAPS_API_KEY=maps_key)
    env["PATH"] = f"{arguments.java_home}/bin:{arguments.android_home}/platform-tools:{env['PATH']}"
    for local in ROOT.glob(".env*"):
        if local.name != ".env.example" and re.search(r"^(?:VITE_|VUE_APP_)", local.read_text(), re.M):
            raise ValueError(f"Unreviewed local frontend environment file {local.name}")
    try:
        with (output / "build.log").open("w") as log:
            subprocess.run(["pnpm", "android:assembleRelease"], env=env, stdout=log, stderr=subprocess.STDOUT,
                           check=True)
        if command(["git", "rev-parse", "HEAD"]).strip() != arguments.approved_sha:
            raise ValueError("Source moved during build")
        changes = command(["git", "diff", "--name-only"]).splitlines()
        if any(change != GENERATED for change in changes):
            raise ValueError("Unexpected tracked build changes: " + ", ".join(changes))
        (output / "generated-source.diff").write_text(command(["git", "diff"]))
    finally:
        # cap sync rewrites this tracked file; restore it whether or not the build passed.
        if GENERATED in command(["git", "diff", "--name-only"]).splitlines():
            subprocess.run(["git", "checkout", "--", GENERATED], check=True)
    apk = ROOT / BUILT_APK
    tools = Path(arguments.android_home) / "build-tools" / arguments.build_tools
    badging = command([str(tools / "aapt"), "dump", "badging", str(apk)])
    problems = []
    if f"package: name='{package}' versionCode='{version_code}' versionName='{version_name}'" not in badging:
        problems.append("Package/version badging differs from build.gradle")
    if "application-debuggable" in badging:
        problems.append("APK is debuggable")
    (output / "apk-badging.txt").write_text(badging)
    signature = command([str(tools / "apksigner"), "verify", "--verbose", "--print-certs", str(apk)], env=env)
    if f"certificate SHA-256 digest: {arguments.cert_sha256}" not in signature:
        problems.append("Signing certificate differs")
    (output / "apk-signature.txt").write_text(signature)
    with zipfile.ZipFile(apk) as archive:
        names = archive.namelist()
        for required in ("assets/public/index.html", "assets/public/notification.mp3"):
            if required not in names:
                problems.append(f"Missing {required}")
        sound = (ROOT / "android/app/src/main/res/raw/offer_music_20s.mp3").read_bytes()
        if f"{package}:raw/offer_music_20s" not in command([str(tools / "aapt"), "dump", "resources", str(apk)]) or \
                not any(n.startswith("res/") and archive.read(n) == sound for n in names):
            problems.append("Missing exact native offer alert resource")
        web = {n: archive.read(n) for n in names if n.startswith("assets/public/")}
        problems += scan_web_assets(web, api_url=api_url, socket_url=socket_url, maps_key=maps_key)
        problems += scan_names(names)
        problems += stale_assets(web, ROOT / "dist-driver")
        secrets = [v for k, v in read_properties(ROOT / "android/keystore/keystore.properties").items()
                   if k in ("storePassword", "keyPassword") and v]
        if any(secret.encode() in archive.read(n) for n in names for secret in secrets):
            problems.append("Signing credential in APK")
    if problems:
        raise ValueError("APK verification failed: " + "; ".join(problems))
    final = output / f"TayynHyzmat-production-{version_name}-code{version_code}.apk"
    shutil.copy2(apk, final)
    final.chmod(0o600)
    digest = hashlib.sha256(final.read_bytes()).hexdigest()
    (output / "SHA256SUMS").write_text(f"{digest}  {final.name}\n")
    provenance = {"sourceCommit": arguments.approved_sha, "builtAtUtc": datetime.datetime.now(datetime.timezone.utc)
                  .isoformat(), "package": package, "versionName": version_name, "versionCode": version_code,
                  "certificateSha256": arguments.cert_sha256, "apkSha256": digest, "apk": final.name,
                  "apiUrl": api_url, "socketUrl": socket_url, "androidBuildTools": arguments.build_tools,
                  "generatedTrackedChangesRestored": True, "staticChecksPassed": True,
                  "suggestedTag": f"android-{version_name}"}
    (output / "build-provenance.json").write_text(json.dumps(provenance, indent=2) + "\n")
    print(json.dumps({"artifact": str(final), "sha256": digest, "source": arguments.approved_sha,
                      "tag": f"android-{version_name}"}, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    stage = commands.add_parser("stage-signing-inputs", help="Link ignored signing inputs into a worktree")
    stage.add_argument("--canonical", type=Path, required=True, help="Checkout holding the real signing inputs")
    stage.add_argument("--worktree", type=Path, default=ROOT)
    make = commands.add_parser("build", help="Build and verify the signed release APK")
    make.add_argument("--approved-sha", required=True)
    make.add_argument("--maps-key-file", type=Path, required=True, help="Owner-only file with the maps client key")
    make.add_argument("--output-dir", type=Path, help="New directory (default .local/release-<version>/artifacts-<sha>)")
    make.add_argument("--origin", default="https://taxi.tayynhyzmat.com")
    make.add_argument("--cert-sha256", default=PRODUCTION_CERT_SHA256)
    make.add_argument("--expect-version-name")
    make.add_argument("--expect-version-code", type=int)
    make.add_argument("--build-tools", default="35.0.0")
    make.add_argument("--java-home", default=os.environ.get("JAVA_HOME", "/opt/homebrew/opt/openjdk@17"))
    make.add_argument("--android-home", default=os.environ.get("ANDROID_HOME",
                                                               str(Path.home() / "Library/Android/sdk")))
    arguments = parser.parse_args()
    if arguments.command == "stage-signing-inputs":
        print(json.dumps(stage_signing_inputs(arguments.canonical, arguments.worktree), indent=2))
    else:
        build(arguments)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError, zipfile.BadZipFile) as error:
        print(f"Failed: {type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
