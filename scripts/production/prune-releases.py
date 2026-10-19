#!/usr/bin/env python3
"""Plan, then optionally apply, release retention on the app VPS. Dry-run by default.

Never removes the current release, the newest releases before it, newer releases,
image tags referenced by any container, or anything outside the configured roots.
Volumes, databases and image IDs are never touched; images are removed by tag.
"""
import argparse
import fcntl
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

RELEASE = re.compile(r"vps-([1-9][0-9]{0,5})-[0-9a-f]{40}")
TRANSFER = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")
ROLES = ("api", "web", "db", "proxy")


def docker_lines(docker, *arguments):
    output = subprocess.run([*docker, *arguments], check=True, text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, timeout=60).stdout
    return {line.strip() for line in output.splitlines() if line.strip()}


def inside(path, parent):
    return not path.is_symlink() and path.is_dir() and path.resolve().parent == parent.resolve()


def plan(root, keep, docker, incoming_age_hours, now):
    releases, incoming, current_link = root / "releases", root / "incoming", root / "current"
    if not current_link.is_symlink():
        raise ValueError("current must be a symlink to a release")
    current = current_link.resolve()
    if current.parent != releases.resolve() or not RELEASE.fullmatch(current.name) or not current.is_dir():
        raise ValueError("current does not point to a valid release directory")
    current_number = int(RELEASE.fullmatch(current.name).group(1))
    candidates, ignored = [], []
    for entry in sorted(releases.iterdir()) if releases.is_dir() else []:
        match = RELEASE.fullmatch(entry.name)
        if not match or not inside(entry, releases):
            ignored.append(entry.name)
        elif entry.name != current.name:
            candidates.append((int(match.group(1)), entry.name))
    numbers = [number for number, _ in candidates]
    if len(numbers) != len(set(numbers)) or current_number in numbers:
        raise ValueError("Duplicate release numbers; resolve manually")
    older = sorted((c for c in candidates if c[0] < current_number), reverse=True)
    kept = [current.name] + [name for _, name in older[:keep - 1]]
    kept += [name for number, name in candidates if number > current_number]
    tags = docker_lines(docker, "image", "ls", "--format", "{{.Repository}}:{{.Tag}}")
    used = docker_lines(docker, "ps", "--all", "--format", "{{.Image}}")
    remove, refused = [], []
    for _, name in older[keep - 1:]:
        release_tags = [f"tayyn-offline/{role}:{name}" for role in ROLES]
        if used & set(release_tags):
            refused.append({"release": name, "reason": "image tag used by a container"})
        else:
            remove.append({"release": name, "path": str(releases / name),
                           "image_tags": [tag for tag in release_tags if tag in tags]})
    stale = []
    for entry in sorted(incoming.iterdir()) if incoming.is_dir() else []:
        if not TRANSFER.fullmatch(entry.name) or not inside(entry, incoming):
            ignored.append("incoming/" + entry.name)
        elif now - entry.lstat().st_mtime >= incoming_age_hours * 3600:
            stale.append(str(incoming / entry.name))
    return {"current": current.name, "keep": kept, "remove": remove, "refused": refused,
            "stale_incoming": stale, "ignored": ignored}


def apply(result, root, docker):
    for item in result["remove"]:
        for tag in item["image_tags"]:
            # Untag only; Docker itself still refuses an image a container uses.
            subprocess.run([*docker, "image", "rm", tag], check=True, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=300)
        path = Path(item["path"])
        if not inside(path, root / "releases") or (root / "current").resolve() == path.resolve():
            raise ValueError("Release path changed during prune")
        shutil.rmtree(path)
    for value in result["stale_incoming"]:
        path = Path(value)
        if not inside(path, root / "incoming"):
            raise ValueError("Transfer path changed during prune")
        shutil.rmtree(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--keep", type=int, default=2, help="Current plus newest previous releases to retain (minimum 2)")
    parser.add_argument("--apply", action="store_true", help="Remove the planned items; otherwise print the plan only")
    parser.add_argument("--root", type=Path, default=Path("/opt/tayyn"))
    parser.add_argument("--incoming-age-hours", type=float, default=24)
    parser.add_argument("--docker", default="docker", help="Docker command, e.g. 'sudo docker'")
    parser.add_argument("--lock", type=Path, default=Path("/run/lock/tayyn-deploy.lock"))
    args = parser.parse_args()
    if args.keep < 2:
        parser.error("--keep must be at least 2")
    if not args.root.is_absolute() or args.root.is_symlink() or args.incoming_age_hours < 1:
        parser.error("--root must be an absolute non-symlink path; --incoming-age-hours at least 1")
    docker = args.docker.split()
    # Shares the updater lock so pruning never races an apply.
    with open(args.lock, "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        result = plan(args.root, args.keep, docker, args.incoming_age_hours, time.time())
        if args.apply:
            apply(result, args.root, docker)
    print(json.dumps({"applied": args.apply, **result}, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, ValueError, OSError) as error:
        print(f"Prune failed: {type(error).__name__}: {error}. Nothing further was removed.", file=sys.stderr)
        sys.exit(1)
