#!/usr/bin/env python3
"""Bounded production backups and independent monitoring. Python standard library only."""
import argparse
import contextlib
import datetime as dt
from email.message import EmailMessage
from email.utils import formatdate, parseaddr
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import smtplib
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo

ARCHIVE = re.compile(r"^tayyn-\d{8}T\d{6}Z-[0-9a-f]{8}\.dump\.age$")


def private_json(path):
    path = Path(path)
    if path.stat().st_mode & 0o077:
        raise ValueError("Configuration/secrets must have mode 0600")
    return json.loads(path.read_text())


def write_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as out:
        temporary = Path(out.name)
        json.dump(data, out)
        out.flush()
        os.fsync(out.fileno())
    temporary.replace(path)


def run(command, timeout=30, **kwargs):
    # No shell interpolation or subprocess stderr in reports; it can contain secrets.
    return subprocess.run(command, check=True, timeout=timeout,
                          stderr=subprocess.DEVNULL, **kwargs)


def compose(config, *arguments):
    command = ["docker", "compose", "--project-name", config.get("project", "tayyn-production"),
               "--project-directory", config["compose_dir"]]
    for filename in config.get("compose_env_files", [config.get("compose_env", "/etc/tayyn/app.env")]):
        command += ["--env-file", filename]
    for filename in config.get("compose_files", ["compose.yaml"]):
        path = Path(filename)
        command += ["-f", str(path if path.is_absolute() else Path(config["compose_dir"]) / path)]
    return command + list(arguments)


@contextlib.contextmanager
def locked(config, name):
    directory = Path(config.get("state_dir", "/var/lib/tayyn/operations"))
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (directory / (name + ".lock")).open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def archives(directory):
    return sorted((p for p in Path(directory).glob("*.dump.age") if ARCHIVE.fullmatch(p.name) and not p.is_symlink()),
                  key=lambda p: p.name, reverse=True)


def retention(directory, now=None):
    """Keep newest 24 hourly copies plus newest copy on each of the last 14 UTC days."""
    now = time.time() if now is None else now
    files = archives(directory)
    keep = set(files[:24])
    days = set()
    for path in files:
        day = dt.datetime.strptime(path.name[6:14], "%Y%m%d").date()
        age = (dt.datetime.fromtimestamp(now, dt.timezone.utc).date() - day).days
        if 0 <= age < 14 and day not in days:
            keep.add(path)
            days.add(day)
    for path in files:
        if path not in keep:
            path.unlink()


def backup(config):
    directory = Path(config["backup_dir"])
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    recipient = config["age_recipient"]
    if not re.fullmatch(r"age1[0-9a-z]{50,100}", recipient):
        raise ValueError("A valid age public recipient is required")
    with locked(config, "backup"):
        filename = "tayyn-" + dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + os.urandom(4).hex() + ".dump.age"
        temporary = directory / (filename + ".partial")
        # Plaintext is streamed directly to age, never written to disk.
        try:
            with temporary.open("xb") as output:
                with subprocess.Popen(compose(config, "exec", "-T", "db", "pg_dump", "-U", "tayyn", "-d", "tayyn", "-Fc"),
                                      stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as source:
                    try:
                        run(["age", "--encrypt", "--recipient", recipient], stdin=source.stdout, stdout=output, timeout=300)
                        source.stdout.close()
                        if source.wait(timeout=15) != 0:
                            raise RuntimeError("Database dump failed")
                    except BaseException:
                        source.kill()
                        source.wait()
                        raise
                output.flush()
                os.fsync(output.fileno())
            if temporary.stat().st_size < 100:
                raise RuntimeError("Backup is empty")
            temporary.replace(directory / filename)
            retention(directory)
            print(json.dumps({"backup": filename, "encrypted": True}))
        finally:
            temporary.unlink(missing_ok=True)


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def latest_backup_time(directory):
    files = archives(directory)
    return dt.datetime.strptime(files[0].name[6:22], "%Y%m%dT%H%M%SZ").replace(tzinfo=dt.timezone.utc).timestamp() if files else None


def metadata(directory):
    result = []
    for path in archives(directory):
        created = dt.datetime.strptime(path.name[6:22], "%Y%m%dT%H%M%SZ").replace(tzinfo=dt.timezone.utc).timestamp()
        result.append({"name": path.name, "sha256": sha256(path), "size": path.stat().st_size, "created": created})
    return result


def tls_probe(host):
    with socket.create_connection((host, 443), timeout=5) as raw:
        with ssl.create_default_context().wrap_socket(raw, server_hostname=host):
            return True


def facts(config):
    checks = {}
    def check(name, action):
        try:
            checks[name] = bool(action())
        except (OSError, ValueError, subprocess.SubprocessError):
            checks[name] = False
    check("database", lambda: run(compose(config, "exec", "-T", "db", "psql", "-U", "tayyn", "-d", "tayyn", "-Atc", "SELECT 1"),
                                  stdout=subprocess.PIPE, timeout=15).stdout.strip() == b"1")
    restarts = {}
    def containers():
        services = config.get("expected_services", ["db", "api", "web", "proxy"])
        ids = run(compose(config, "ps", "-q", *services), stdout=subprocess.PIPE).stdout.decode().split()
        if len(ids) != len(services):
            return False
        inspected = json.loads(run(["docker", "inspect", *ids], stdout=subprocess.PIPE).stdout)
        good = True
        for item in inspected:
            name = item.get("Config", {}).get("Labels", {}).get("com.docker.compose.service", "unknown")
            restarts[name] = {"count": item["RestartCount"], "id": item["Id"]}
            state = item["State"]
            good = good and state["Running"] and state.get("Health", {}).get("Status", "healthy") == "healthy"
        return good
    check("containers", containers)
    for host in config.get("outbound_hosts", ["geocode-maps.yandex.ru", "oauth2.googleapis.com", "fcm.googleapis.com"]):
        check("tls:" + host, lambda host=host: tls_probe(host))
    disk = shutil.disk_usage(config.get("disk_path", "/"))
    disk_percent = round(100 * disk.used / disk.total, 1)
    checks["disk"] = disk_percent < 85
    newest = latest_backup_time(config["backup_dir"])
    age = max(0, time.time() - newest) if newest else None
    checks["backup_fresh"] = age is not None and age < 7200 and newest <= time.time() + 120
    return {"checks": checks, "disk_percent": disk_percent, "backup_age_seconds": age,
            "restarts": restarts, "generated_at": time.time()}


def ssh(config, command, **kwargs):
    target = config["app_ssh_target"]
    if not re.fullmatch(r"[a-z_][a-z0-9_-]*@[a-zA-Z0-9.-]+", target):
        raise ValueError("Invalid SSH destination")
    return run(["ssh", "-T", "-i", config["ssh_key"], "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
                "-o", "StrictHostKeyChecking=yes", "-o", "UserKnownHostsFile=" + config["ssh_known_hosts"],
                "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=2",
                target, command], **kwargs)


def relay(config):
    directory = Path(config["backup_dir"])
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    with locked(config, "relay"):
        remote = json.loads(ssh(config, "list", stdout=subprocess.PIPE, timeout=30).stdout)
        if not isinstance(remote, list) or not remote or len(remote) > 1000:
            raise ValueError("Invalid backup inventory")
        for item in remote:
            name = item["name"]
            if not ARCHIVE.fullmatch(name) or not re.fullmatch(r"[a-f0-9]{64}", item["sha256"]):
                raise ValueError("Invalid backup inventory item")
            destination = directory / name
            if destination.exists() and not destination.is_symlink():
                digest = sha256(destination)
                if digest == item["sha256"]:
                    continue
            temporary = directory / (name + ".partial")
            try:
                with temporary.open("wb") as output:
                    ssh(config, "fetch " + name, stdout=output, timeout=300)
                if temporary.stat().st_size != item["size"] or sha256(temporary) != item["sha256"]:
                    raise ValueError("Backup integrity mismatch")
                temporary.replace(destination)
            finally:
                temporary.unlink(missing_ok=True)
        retention(directory)
        write_json(Path(config["state_dir"]) / "relay.json", {"success_at": time.time()})
        print(json.dumps({"relay": "verified", "copies": len(archives(directory))}))


def serve(config):
    # This is the *only* permitted forced SSH command. Never evaluate the supplied string.
    request = os.environ.get("SSH_ORIGINAL_COMMAND", "")
    if request == "facts":
        print(json.dumps(facts(config)))
    elif request == "list":
        print(json.dumps(metadata(config["backup_dir"])))
    elif request.startswith("fetch ") and ARCHIVE.fullmatch(request[6:]):
        path = Path(config["backup_dir"]) / request[6:]
        if path.is_symlink():
            raise ValueError("Invalid backup")
        with path.open("rb") as source:
            shutil.copyfileobj(source, sys.stdout.buffer)
    else:
        raise ValueError("Restricted backup command")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError("Redirect refused")


def endpoint(url, content):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("A credential-free HTTPS public URL is required")
    with urllib.request.build_opener(NoRedirect()).open(url, timeout=10) as response:
        valid = response.status == 200 and content in response.headers.get("Content-Type", "").lower()
        if valid and content == "application/json":
            valid = json.loads(response.read(65536)).get("status") == "ok"
        return valid


def certificate_days(url, now):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname:
        raise ValueError("Invalid HTTPS endpoint")
    with socket.create_connection((parsed.hostname, parsed.port or 443), timeout=5) as raw:
        with ssl.create_default_context().wrap_socket(raw, server_hostname=parsed.hostname) as secure:
            return (ssl.cert_time_to_seconds(secure.getpeercert()["notAfter"]) - now) / 86400


def socketio_probe(public):
    url = public.rstrip("/") + "/socket.io/?EIO=4&transport=polling"
    with urllib.request.build_opener(NoRedirect()).open(url, timeout=10) as response:
        packet = response.read(65536).decode()
        if response.status != 200 or not packet.startswith("0"):
            return False
        handshake = json.loads(packet[1:])
        return bool(handshake.get("sid")) and "websocket" in handshake.get("upgrades", [])


def send_email(config, subject, body, event):
    secrets = private_json(config["secrets_file"])
    transport = secrets.get("email_transport", "resend")
    if transport == "smtp":
        port = int(secrets.get("smtp_port", 465))
        if port not in (465, 587):
            raise ValueError("SMTP requires verified TLS on port 465 or STARTTLS on port 587")
        sender = secrets["smtp_from"]
        recipient = secrets.get("alert_email", "bagtyyarkowusow.dev@gmail.com")
        sender_address = parseaddr(sender)[1]
        recipient_address = parseaddr(recipient)[1]
        if "@" not in sender_address or "@" not in recipient_address:
            raise ValueError("Invalid alert sender or recipient")
        message = EmailMessage()
        message["From"] = sender
        message["To"] = recipient
        message["Subject"] = "Tayyn Hyzmat: " + subject
        message["Date"] = formatdate(localtime=False)
        message["Message-ID"] = "<tayyn-" + hashlib.sha256(event.encode()).hexdigest() + "@" + sender_address.rsplit("@", 1)[1] + ">"
        message.set_content(body)
        context = ssl.create_default_context()
        if port == 465:
            client = smtplib.SMTP_SSL(secrets["smtp_host"], port, timeout=15, context=context)
        else:
            client = smtplib.SMTP(secrets["smtp_host"], port, timeout=15)
        with client as smtp:
            if port == 587:
                smtp.ehlo()
                smtp.starttls(context=context)
                smtp.ehlo()
            smtp.login(secrets["smtp_username"], secrets["smtp_password"])
            if smtp.send_message(message, from_addr=sender_address, to_addrs=[recipient_address]):
                raise RuntimeError("Email recipient rejected")
        return
    if transport != "resend":
        raise ValueError("Unsupported email transport")
    payload = json.dumps({"from": secrets["resend_from"],
                          "to": [secrets.get("alert_email", "bagtyyarkowusow.dev@gmail.com")],
                          "subject": "Tayyn Hyzmat: " + subject, "text": body}).encode()
    request = urllib.request.Request("https://api.resend.com/emails", data=payload,
        headers={"Authorization": "Bearer " + secrets["resend_api_key"], "Content-Type": "application/json",
                 "Idempotency-Key": hashlib.sha256(event.encode()).hexdigest()}, method="POST")
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=15) as response:
        if response.status not in (200, 201):
            raise RuntimeError("Email rejected")
        # Bound response size, and require provider acceptance before advancing persistent state.
        if not json.loads(response.read(65536)).get("id"):
            raise RuntimeError("Email acceptance missing")


def notification(state, failures, warnings, now, local_day, daily_due):
    """Decide one email; persistence happens only after successful provider acceptance."""
    if failures:
        incident = state.setdefault("incident", {"started": now, "sent": 0, "last_sent": 0})
        elapsed = max(0, now - incident["started"])
        sent = incident["sent"]
        due = sent == 0 or (sent == 1 and elapsed >= 300) or (sent == 2 and elapsed >= 900) or (sent >= 3 and now - incident["last_sent"] >= 1800)
        if due:
            return ("CRITICAL: production checks failing", "Failed checks: " + ", ".join(failures),
                    f"incident-{incident['started']}-{sent}", "incident")
        return None
    if state.get("incident"):
        return ("Recovered", "All critical production checks are passing. Warnings: " + (", ".join(warnings) or "none"),
                f"recovery-{state['incident']['started']}", "recovery")
    if warnings:
        if daily_due and state.get("daily_day") != local_day:
            return ("Daily health report: attention needed", "Warnings: " + ", ".join(warnings),
                    "daily-warning-" + local_day + "-" + state["installation_id"], "daily")
        return None
    if not state.get("initial_sent"):
        return ("Initial production checks passed", "Application, database, disk, backup relay and outbound checks passed. Restore drills and real phone delivery remain separate release checks.", "initial-" + state["installation_id"], "initial")
    if daily_due and state.get("daily_day") != local_day:
        return ("Daily health report: normal", "All monitored checks passed. Hourly encrypted backup is fresh on the independent monitoring VPS.", "daily-" + local_day + "-" + state["installation_id"], "daily")
    return None


def monitor(config):
    with locked(config, "monitor"):
        now = time.time()
        state_path = Path(config["state_dir"]) / "monitor.json"
        state = json.loads(state_path.read_text()) if state_path.exists() else {"installation_id": os.urandom(12).hex()}
        failures, warnings = [], []
        remote = None
        try:
            remote = json.loads(ssh(config, "facts", stdout=subprocess.PIPE, timeout=60).stdout)
            if not {"database", "containers", "disk", "backup_fresh"}.issubset(remote["checks"]):
                raise ValueError("Incomplete app facts")
            if abs(now - remote["generated_at"]) > 120:
                failures.append("app clock/facts age")
            failures.extend(name for name, good in remote["checks"].items() if not good)
            if remote["disk_percent"] >= 70:
                warnings.append("app disk >=70%")
            previous = state.get("restarts", {})
            for name, value in remote["restarts"].items():
                old = previous.get(name)
                if old and old["id"] == value["id"] and value["count"] > old["count"]:
                    state["restart_warning_until"] = now + 3600
            state["restarts"] = remote["restarts"]
            if now < state.get("restart_warning_until", 0):
                failures.append("container restarted in last hour")
        except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
            failures.append("independent SSH app probe")
        public = config["public_url"].rstrip("/")
        for label, suffix, mime in [("dashboard HTTPS", "/", "text/html"), ("API HTTPS", "/health", "application/json")]:
            try:
                if not endpoint(public + suffix, mime):
                    failures.append(label)
            except (OSError, ValueError):
                failures.append(label)
        try:
            if not socketio_probe(public):
                failures.append("Socket.IO handshake")
        except (OSError, ValueError, KeyError):
            failures.append("Socket.IO handshake")
        try:
            days = certificate_days(public, now)
            if days < 7:
                failures.append("TLS certificate expires within seven days")
            elif days < 14:
                warnings.append("TLS certificate expires within fourteen days")
        except (OSError, ValueError, KeyError):
            failures.append("TLS certificate inspection")
        newest = latest_backup_time(config["backup_dir"])
        if not newest or not -120 <= now - newest < 7200:
            failures.append("off-server backup older than two hours")
        try:
            relay_state = json.loads((Path(config["state_dir"]) / "relay.json").read_text())
            if now - relay_state["success_at"] >= 7200:
                failures.append("backup relay stale")
        except (OSError, ValueError, KeyError):
            failures.append("backup relay never completed")
        disk = shutil.disk_usage(config.get("disk_path", "/"))
        percent = 100 * disk.used / disk.total
        if percent >= 85:
            failures.append("monitor disk >=85%")
        elif percent >= 70:
            warnings.append("monitor disk >=70%")
        local = dt.datetime.fromtimestamp(now, ZoneInfo("Asia/Ashgabat"))
        notice = notification(state, failures, warnings, now, local.date().isoformat(), local.hour >= config.get("daily_hour", 9))
        if notice:
            subject, body, event, kind = notice
            try:
                send_email(config, subject, body, event)
            except (OSError, ValueError, RuntimeError):
                write_json(state_path, state)
                print(json.dumps({"healthy": not failures, "email": "failed; retry next timer", "failures": failures, "warnings": warnings}))
                return 2
            if kind == "incident":
                state["incident"]["sent"] += 1
                state["incident"]["last_sent"] = now
            elif kind == "recovery":
                state.pop("incident", None)
            elif kind == "initial":
                state["initial_sent"] = True
                state["daily_day"] = local.date().isoformat()
            else:
                state["daily_day"] = local.date().isoformat()
        write_json(state_path, state)
        print(json.dumps({"healthy": not failures and not warnings, "failures": failures, "warnings": warnings,
                          "email": notice[3] if notice else "none"}))
        return 1 if failures else 0


def restore(config, arguments):
    if not config.get("isolated_restore") or config.get("project", "tayyn-production") == "tayyn-production":
        raise ValueError("Restore requires isolated_restore=true and a separate disposable compose project")
    if not re.fullmatch(r"tayyn_restore_[a-z0-9_]{1,40}", arguments.database):
        raise ValueError("Restore requires a NEW disposable tayyn_restore_* database")
    # Identity stays on the operator's secure restore host. Never provision it on either VPS.
    source = Path(arguments.archive)
    if not source.is_file() or source.is_symlink():
        raise ValueError("Invalid archive")
    with tempfile.TemporaryFile() as plaintext:
        run(["age", "--decrypt", "--identity", arguments.identity, str(source)], stdout=plaintext, timeout=300)
        plaintext.seek(0)
        run(compose(config, "exec", "-T", "db", "createdb", "-U", "tayyn", arguments.database), timeout=30)
        run(compose(config, "exec", "-T", "db", "pg_restore", "-U", "tayyn", "-d", arguments.database,
                    "--exit-on-error", "--no-owner", "--no-acl"), stdin=plaintext, timeout=300)
    print(json.dumps({"restored_database": arguments.database, "production_replaced": False}))


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("backup", "facts", "relay", "serve", "monitor"):
        sub.add_parser(name)
    restore_parser = sub.add_parser("restore")
    restore_parser.add_argument("--archive", required=True)
    restore_parser.add_argument("--identity", required=True)
    restore_parser.add_argument("--database", required=True)
    args = parser.parse_args()
    try:
        config = private_json(args.config)
        if args.command == "restore":
            restore(config, args)
        elif args.command == "facts":
            print(json.dumps(facts(config)))
        else:
            return {"backup": backup, "relay": relay, "serve": serve, "monitor": monitor}[args.command](config) or 0
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.SubprocessError):
        print(json.dumps({"error": "Operation failed; check private configuration, dependencies, connectivity and service journal. Secrets and subprocess output suppressed."}), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
