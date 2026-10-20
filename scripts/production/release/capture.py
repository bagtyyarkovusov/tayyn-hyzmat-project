#!/usr/bin/env python3
"""Take a quiesced, independently copied encrypted backup for a named stage.

capture        CAUSES DOWNTIME with --stop-writers. Steps (each durable and resumable):
               1. app host `capture-<stage>` (holds /run/lock/tayyn-deploy.lock): with --stop-writers,
                  record whether the backup timer was enabled, stop it, wait for a running backup
                  (restarting the timer if that wait fails), then stop proxy/web/api. Refuse unless
                  the only project container is db, no other database session is connected, and the
                  backup service and timer are inactive. Run the encrypted backup and copy it to
                  /var/lib/tayyn/protected-<label>/ (outside retention).
               2. monitor host `relay-<stage>`: run the relay, check the same size/SHA-256, copy it
                  to the monitor's protected dir.
               3. operator workstation: copy the archive to .local/release-<label>/capture-<stage>/
                  and check SHA-256. Writes capture.json there.
restore-timer  Start the backup timer again if it was enabled before the first --stop-writers.
               Run after the release (apply-release.py) has started the services.

This takes no preservation snapshot and runs no reset. A release-specific script takes its own
snapshot while writers remain stopped; the database cannot change between the two.
"""
import argparse
import inspect
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import remote_step  # noqa: E402

COMPOSE = '''
compose = ["docker", "compose", "--project-name", "tayyn-production", "--env-file", "/etc/tayyn/app.env",
           "--env-file", "/opt/tayyn/current/release.env", "-f", "/opt/tayyn/current/deploy/production/compose.production.yaml"]
'''

SESSIONS_SQL = ("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() "
                "AND pid<>pg_backend_pid() AND backend_type='client backend'")


def quiesce_problems(probe, compose, project="tayyn-production"):
    """Return reasons the app is not quiesced; ported from reset-release-1.21.py Database.quiesced().

    `probe(argv)` returns stdout and never raises, so a failed check reads as empty output and fails closed.
    """
    problems = []
    database = probe(compose + ["ps", "--quiet", "--no-trunc", "db"]).split()
    containers = probe(["docker", "ps", "--quiet", "--no-trunc", "--filter",
                        f"label=com.docker.compose.project={project}"]).split()
    if len(database) != 1 or containers != database:
        # Also catches one-off `compose run` containers such as migrate.
        problems.append(f"only the db container may run in {project} (found {len(containers)})")
    if probe(["systemctl", "is-active", "tayyn-backup.service"]).strip() not in ("inactive", "failed"):
        problems.append("tayyn-backup.service is running or its state is unknown")
    if probe(["systemctl", "is-active", "tayyn-backup.timer"]).strip() == "active":
        problems.append("tayyn-backup.timer is active; use --stop-writers")
    if len(database) == 1:
        sessions = probe(["docker", "exec", database[0], "psql", "-X", "-qAt", "-U", "tayyn", "-d", "tayyn",
                          "-c", SESSIONS_SQL]).strip()
        if sessions != "0":
            problems.append("other database client sessions are connected")
    return problems


def stop_app_writers(run, probe, compose, timer_record, sleep=None, attempts=90):
    """Stop the backup timer, wait for a running backup, then stop proxy/web/api.

    If the running backup does not finish, restart the timer when it was enabled before, then abort
    with writers still running.
    """
    import time
    sleep = sleep or time.sleep
    if not timer_record.exists():
        timer_record.write_text(probe(["systemctl", "is-enabled", "tayyn-backup.timer"]).strip() + "\n")
    run(["systemctl", "stop", "tayyn-backup.timer"])
    for _ in range(attempts):
        if probe(["systemctl", "is-active", "tayyn-backup.service"]).strip() in ("inactive", "failed"):
            break
        sleep(2)
    else:
        enabled = timer_record.read_text().strip() == "enabled"
        if enabled:
            run(["systemctl", "start", "tayyn-backup.timer"])
        raise SystemExit("A running backup did not finish; writers were not stopped; backup timer "
                         + ("restarted" if enabled else "left stopped (it was not enabled before)"))
    run(compose + ["stop", "proxy", "web", "api"])


CAPTURE_CODE = '''
import hashlib, json, shutil, subprocess
from pathlib import Path
hold_deploy_lock()
def run(command, timeout=600):
    return subprocess.run(command, check=True, capture_output=True, text=True, timeout=timeout).stdout
def probe(command):
    try:
        return subprocess.run(command, capture_output=True, text=True, timeout=180).stdout
    except (OSError, subprocess.SubprocessError):
        return ""
def sha(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1048576), b""):
            h.update(chunk)
    return h.hexdigest()
if EXPECT_CURRENT and Path("/opt/tayyn/current").resolve().name != EXPECT_CURRENT:
    raise SystemExit("/opt/tayyn/current differs from --expect-current; nothing was stopped")
timer_record = PRIVATE_DIR / "backup-timer-before.txt"
if STOP_WRITERS:
    stop_app_writers(run, probe, compose, timer_record)
problems = quiesce_problems(probe, compose)
if problems:
    raise SystemExit("Not quiesced: " + "; ".join(problems))
name = Path(json.loads(run(["python3", "-B", OPERATIONS_SCRIPT, "--config", OPERATIONS_CONFIG, "backup"],
                           timeout=1800))["backup"]).name
source = Path(json.loads(Path(OPERATIONS_CONFIG).read_text())["backup_dir"]) / name
if not source.is_file() or source.is_symlink():
    raise SystemExit("Backup file missing")
protected = Path(PROTECTED_DIR)
protected.mkdir(mode=0o700, parents=True, exist_ok=True)
target = protected / name
if target.exists():
    raise SystemExit("Protected copy already exists")
shutil.copyfile(source, target)
target.chmod(0o600)
digest = sha(target)
if digest != sha(source):
    raise SystemExit("Protected copy differs from backup")
write_result({"stage": STAGE, "archive": {"name": name, "path": str(target), "sha256": digest,
              "size": target.stat().st_size}, "writers_stopped": True,
              "backup_timer_before": timer_record.read_text().strip() if timer_record.exists() else None})
'''

RELAY_CODE = '''
import hashlib, json, shutil, subprocess
from pathlib import Path
def sha(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1048576), b""):
            h.update(chunk)
    return h.hexdigest()
subprocess.run(["systemctl", "start", "tayyn-backup-relay.service"], check=True, timeout=300)
source = Path(json.loads(Path(OPERATIONS_CONFIG).read_text())["backup_dir"]) / EXPECTED["name"]
if not source.is_file() or source.is_symlink():
    raise SystemExit("Relayed archive missing on monitor")
if source.stat().st_size != EXPECTED["size"] or sha(source) != EXPECTED["sha256"]:
    raise SystemExit("Relayed archive differs from the app host copy")
protected = Path(PROTECTED_DIR)
protected.mkdir(mode=0o700, parents=True, exist_ok=True)
target = protected / EXPECTED["name"]
if target.exists():
    raise SystemExit("Protected monitor copy already exists")
shutil.copyfile(source, target)
target.chmod(0o600)
if sha(target) != EXPECTED["sha256"]:
    raise SystemExit("Protected monitor copy differs")
write_result({"path": str(target), "sha256": EXPECTED["sha256"], "size": EXPECTED["size"]})
'''

RESTORE_TIMER_CODE = '''
import subprocess
record = PRIVATE_DIR / "backup-timer-before.txt"
before = record.read_text().strip() if record.exists() else None
if before == "enabled":
    subprocess.run(["systemctl", "start", "tayyn-backup.timer"], check=True, timeout=60)
active = subprocess.run(["systemctl", "is-active", "tayyn-backup.timer"], capture_output=True, text=True).stdout.strip()
write_result({"backup_timer_before": before, "backup_timer_now": active})
if before == "enabled" and active != "active":
    raise SystemExit("Backup timer did not start")
'''


def constants(**values):
    return "".join(f"{name} = {value!r}\n" for name, value in values.items())


def capture_code(*, stage, stop_writers, protected_dir, expect_current="", operations_script="/opt/tayyn/operations.py",
                 operations_config="/etc/tayyn/operations.json"):
    helpers = "\n".join(inspect.getsource(f) for f in (quiesce_problems, stop_app_writers))
    return (constants(STAGE=stage, STOP_WRITERS=bool(stop_writers), PROTECTED_DIR=protected_dir,
                      EXPECT_CURRENT=expect_current, OPERATIONS_SCRIPT=operations_script,
                      OPERATIONS_CONFIG=operations_config, SESSIONS_SQL=SESSIONS_SQL) + COMPOSE + helpers + CAPTURE_CODE)


def relay_code(*, expected, protected_dir, operations_config="/etc/tayyn/operations.json"):
    return constants(EXPECTED=expected, PROTECTED_DIR=protected_dir, OPERATIONS_CONFIG=operations_config) + RELAY_CODE


def capture(context, *, stage, stop_writers, app_host, monitor_host, allow_rerun=False, expect_current=""):
    remote_step.check_name(stage, "stage")
    protected = f"/var/lib/tayyn/protected-{context.label}"
    record = remote_step.run_step(context, app_host, f"capture-{stage}",
                                  capture_code(stage=stage, stop_writers=stop_writers, protected_dir=protected,
                                               expect_current=expect_current),
                                  allow_rerun=allow_rerun, timeout=2400)
    print(f"Backup {record['archive']['name']} protected on {app_host}; writers remain stopped", flush=True)
    archive = record["archive"]
    record["relay"] = remote_step.run_step(context, monitor_host, f"relay-{stage}",
                                           relay_code(expected=archive, protected_dir=protected),
                                           allow_rerun=allow_rerun, timeout=600)
    destination = remote_step.private_directory(context.log_dir.parent / f"capture-{stage}")
    local = remote_step.copy_from(context, app_host, archive["path"], destination / archive["name"],
                                  expected_sha256=archive["sha256"])
    record["owner_copy"] = {"path": str(local), "sha256": remote_step.sha256_file(local), "size": local.stat().st_size}
    if record["owner_copy"]["sha256"] != archive["sha256"] or record["owner_copy"]["size"] != archive["size"]:
        raise ValueError("Owner copy differs")
    remote_step.write_json_atomic(destination / "capture.json", record)
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    remote_step.add_context_arguments(parser)
    parser.add_argument("--app-host", default="tayyn-production")
    parser.add_argument("--monitor-host", default="tayyn-monitor")
    commands = parser.add_subparsers(dest="command", required=True)
    take = commands.add_parser("capture", help="Quiesced backup with relay and owner copies")
    take.add_argument("--stage", required=True, help="Stage name, e.g. pre-migration or final-1.22")
    take.add_argument("--stop-writers", action="store_true", help="Stop backup timer and proxy/web/api (downtime)")
    take.add_argument("--expect-current", default="", help="Release name /opt/tayyn/current must point to")
    take.add_argument("--allow-rerun", action="store_true",
                      help="Archive an inspected failed/interrupted attempt and run that step again")
    commands.add_parser("restore-timer", help="Restart the backup timer if it was enabled before")
    arguments = parser.parse_args()
    context = remote_step.context_from(arguments)
    if arguments.command == "capture":
        record = capture(context, stage=arguments.stage, stop_writers=arguments.stop_writers,
                         app_host=arguments.app_host, monitor_host=arguments.monitor_host,
                         allow_rerun=arguments.allow_rerun, expect_current=arguments.expect_current)
        print(json.dumps({"stage": arguments.stage, "archive": record["archive"], "copies_verified": True}, indent=2))
    else:
        result = remote_step.run_step(context, arguments.app_host, "restore-backup-timer", RESTORE_TIMER_CODE,
                                      idempotent=True, timeout=120)
        print(json.dumps(result, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, ConnectionError, OSError, KeyError) as error:
        print(f"Failed: {error}", file=sys.stderr)
        sys.exit(1)
