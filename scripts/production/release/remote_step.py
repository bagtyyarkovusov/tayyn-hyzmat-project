#!/usr/bin/env python3
"""Run one named Python step on a production host over SSH, with a durable result.

The step code is sent on stdin to a small root bootstrap. The bootstrap stores the
code, a start record, stdout/stderr, the exit status and the step's own JSON result
under /root/tayyn-<label>-private on that host. The step itself runs detached in its
own session with files (not the SSH pipe) as stdio, so a dropped SSH session does not
stop it or lose its result. Python never writes bytecode (-B, -I), the umask is 077,
and nothing is imported from a release directory.

A step that was started is never re-run automatically. Running the same step code again
returns the earlier success without executing it. `status` and `wait` only read the
durable files. Retrying a failed or interrupted step (or a succeeded step whose code
changed) needs --allow-rerun, which archives the previous attempt's files first.
Read-only steps are marked idempotent by their helper and simply repeat.

Examples (operator workstation):
  remote_step.py --label 1.22 run --host tayyn-production --step uptime --code 'write_result({"ok": True})'
  remote_step.py --label 1.22 status --host tayyn-production --step migrate
  remote_step.py --label 1.22 wait --host tayyn-production --step migrate --timeout 1800
"""
import argparse
import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

NAME = re.compile(r"[0-9A-Za-z][0-9A-Za-z._-]{0,127}")
SSH_FAILED = 255

# Shared by the remote step prelude and local callers, so both use one atomic writer.
HELPERS = '''
def write_json_atomic(path, value):
    """Write JSON with mode 0600 via fsync + rename, so readers never see a partial file."""
    import json as _json, os as _os, tempfile as _tempfile
    path = _os.fspath(path)
    directory = _os.path.dirname(path) or "."
    descriptor, temporary = _tempfile.mkstemp(prefix="." + _os.path.basename(path) + ".", dir=directory)
    try:
        with _os.fdopen(descriptor, "w") as stream:
            _os.fchmod(stream.fileno(), 0o600)
            stream.write(_json.dumps(value, indent=2, sort_keys=True) + "\\n")
            stream.flush()
            _os.fsync(stream.fileno())
        _os.replace(temporary, path)
    except BaseException:
        if _os.path.exists(temporary):
            _os.unlink(temporary)
        raise
    directory_descriptor = _os.open(directory, _os.O_RDONLY)
    try:
        _os.fsync(directory_descriptor)
    finally:
        _os.close(directory_descriptor)
'''
_namespace = {}
exec(HELPERS, _namespace)  # noqa: S102 - trusted constant defined above
write_json_atomic = _namespace["write_json_atomic"]

# Prepended to every step. Steps report by calling write_result(dict) exactly once.
PRELUDE = '''import os, sys
sys.dont_write_bytecode = True
os.umask(0o077)
from pathlib import Path
STEP_RESULT = Path(os.environ["TAYYN_STEP_RESULT"])
PRIVATE_DIR = STEP_RESULT.parent
''' + HELPERS + '''
def write_result(value):
    write_json_atomic(STEP_RESULT, value)
# ---- step code ----
'''

# Runs as root on the host: python3 -B -c BOOTSTRAP <private-dir> <step> <mode> <flags> [timeout]
BOOTSTRAP = r'''
import hashlib, json, os, signal, subprocess, sys, time
from pathlib import Path
os.umask(0o077)
sys.dont_write_bytecode = True
signal.signal(signal.SIGHUP, signal.SIG_IGN)
private, step, mode, flags = Path(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4].split(",")
private.mkdir(mode=0o700, parents=True, exist_ok=True)
info = private.lstat()
if private.is_symlink() or info.st_uid != os.geteuid() or info.st_mode & 0o077:
    sys.exit("Private step directory must be an owner-only directory, not a symlink")
files = {k: private / (step + suffix) for k, suffix in (("code", ".py"), ("started", ".started.json"),
         ("pid", ".pid"), ("stdout", ".stdout"), ("stderr", ".stderr"), ("exit", ".exit"), ("result", ".json"))}
def tail(path):
    try:
        return path.read_text(errors="replace")[-2000:]
    except FileNotFoundError:
        return ""
def state():
    out = {"step": step, "private_dir": str(private)}
    if files["exit"].exists():
        code = int(files["exit"].read_text().strip())
        result = json.loads(files["result"].read_text()) if files["result"].exists() else None
        out.update(state="succeeded" if code == 0 and result is not None else "failed", exit=code, result=result)
    elif files["started"].exists():
        alive = False
        try:
            os.kill(int(files["pid"].read_text().strip()), 0)
            alive = True
        except FileNotFoundError:
            # The pid file follows the start record within milliseconds.
            alive = time.time() - files["started"].stat().st_mtime < 60
        except (ValueError, ProcessLookupError):
            pass
        except PermissionError:
            alive = True
        out.update(state="running" if alive else "interrupted")
    else:
        out.update(state="not-started")
    if files["started"].exists():
        out["started"] = json.loads(files["started"].read_text())
    if out["state"] != "not-started":
        out.update(stdout_tail=tail(files["stdout"]), stderr_tail=tail(files["stderr"]))
    return out
def finish(value, code=0):
    print(json.dumps(value))
    sys.exit(code)
if mode == "status":
    finish(state())
if mode == "wait":
    deadline = time.monotonic() + float(sys.argv[5])
    while state()["state"] == "running" and time.monotonic() < deadline:
        time.sleep(5)
    finish(state())
if mode != "run":
    sys.exit("Unknown mode")
code = sys.stdin.read()
current = state()
if current["state"] == "running":
    finish(dict(current, refused="Step is still running; use wait"), 3)
same_code = current.get("started", {}).get("code_sha256") == hashlib.sha256(code.encode()).hexdigest()
if current["state"] == "succeeded" and "repeat" not in flags:
    if same_code:
        finish(dict(current, reused=True))
    if "rerun" not in flags:
        finish(dict(current, refused="Step succeeded earlier with different code; inspect before --allow-rerun"), 3)
if current["state"] != "not-started":
    if not {"rerun", "repeat"} & set(flags):
        finish(dict(current, refused="Step already started; inspect it, then use --allow-rerun only if safe"), 3)
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    for path in files.values():
        if path.exists():
            path.rename(path.with_name(path.name + ".attempt-" + stamp))
files["code"].write_text(code)
files["started"].write_text(json.dumps({"started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                                        "code_sha256": hashlib.sha256(code.encode()).hexdigest(), "flags": flags}))
environment = dict(os.environ, TAYYN_STEP_RESULT=str(files["result"]), PYTHONDONTWRITEBYTECODE="1")
script = 'trap "" HUP; "$0" -B -I "$1" >"$2" 2>"$3"; status=$?; printf "%s\n" "$status" >"$4.tmp" && mv "$4.tmp" "$4"'
child = subprocess.Popen(["/bin/sh", "-c", script, sys.executable, str(files["code"]), str(files["stdout"]),
                          str(files["stderr"]), str(files["exit"])], stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True, env=environment)
files["pid"].write_text(str(child.pid) + "\n")
child.wait()
final = state()
finish(final, 0 if final["state"] == "succeeded" else 1)
'''

# Writes stdin to <dest> only if its SHA-256 matches; an identical existing file is accepted.
UPLOAD = r'''
import hashlib, os, sys
from pathlib import Path
os.umask(0o077)
destination, expected = Path(sys.argv[1]), sys.argv[2]
def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1048576), b""):
            h.update(chunk)
    return h.hexdigest()
if destination.exists():
    sys.exit(0 if destination.is_file() and not destination.is_symlink() and digest(destination) == expected else 4)
destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
partial = destination.with_name(destination.name + ".partial")
h = hashlib.sha256()
with partial.open("wb") as output:
    for chunk in iter(lambda: sys.stdin.buffer.read(1048576), b""):
        h.update(chunk)
        output.write(chunk)
    output.flush()
    os.fsync(output.fileno())
if h.hexdigest() != expected:
    partial.unlink()
    sys.exit(5)
partial.rename(destination)
'''


def check_name(value, what):
    if not NAME.fullmatch(value or ""):
        raise ValueError(f"Invalid {what}: use letters, digits, dot, underscore or dash")
    return value


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def private_directory(path):
    """Create or check an owner-only local directory for logs and evidence."""
    path = Path(path)
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.is_symlink() or path.stat().st_mode & 0o077:
        raise ValueError(f"{path} must be an owner-only directory (mode 0700)")
    return path


@dataclass(frozen=True)
class Context:
    """Per-release operator settings shared by every helper."""
    label: str
    ssh_config: Path
    log_dir: Path
    nc_interface: str = ""

    @property
    def remote_private_dir(self):
        return f"/root/tayyn-{self.label}-private"

    def ssh_base(self, control=True):
        command = ["ssh", "-F", str(self.ssh_config), "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15",
                   "-o", "ServerAliveCountMax=4", "-o", "BatchMode=yes"]
        if self.nc_interface:
            command += ["-o", f"ProxyCommand=nc -b {self.nc_interface} %h %p"]
        if control:
            sockets = Path("/tmp") / f"tayyn-ssh-{os.getuid()}"
            sockets.mkdir(mode=0o700, exist_ok=True)
            if sockets.is_symlink() or sockets.stat().st_uid != os.getuid() or sockets.stat().st_mode & 0o077:
                raise ValueError(f"{sockets} must be an owner-only directory")
            command += ["-o", "ControlMaster=auto", "-o", "ControlPersist=600", "-o", f"ControlPath={sockets}/%C"]
        return command


def remote_python_command(context, host, *arguments, program=BOOTSTRAP):
    """SSH argv that runs `program` as root Python with bytecode writing disabled and umask 077."""
    check_name(host, "host")
    remote = ["sudo", "env", "PYTHONDONTWRITEBYTECODE=1", "python3", "-B", "-I", "-c", program, *map(str, arguments)]
    # ssh joins its arguments into one remote shell command, so quote every element.
    return context.ssh_base() + [host, "--", "umask 077 && " + shlex.join(remote)]


def step_command(context, host, step, mode, *, allow_rerun=False, repeat=False, wait_seconds=None):
    """`allow_rerun` retries a failed/interrupted step; `repeat` always re-runs an idempotent step."""
    flags = ",".join(name for name, on in (("rerun", allow_rerun), ("repeat", repeat)) if on) or "-"
    extra = [str(int(wait_seconds))] if mode == "wait" else []
    return remote_python_command(context, host, context.remote_private_dir, check_name(step, "step"), mode, flags, *extra)


def _log_path(context, host, step, suffix):
    return private_directory(context.log_dir) / f"{host}-{step}{suffix}"


def _invoke(context, host, step, mode, code="", *, allow_rerun=False, repeat=False, wait_seconds=None, timeout=600):
    command = step_command(context, host, step, mode, allow_rerun=allow_rerun, repeat=repeat, wait_seconds=wait_seconds)
    resume = (f"The step may still be running on the host. Do not re-run it; reconnect and use: "
              f"remote_step.py --label {context.label} wait --host {host} --step {step}")
    try:
        result = subprocess.run(command, input=code, text=True, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired as error:
        raise ConnectionError(f"Local wait for {step!r} on {host} timed out. {resume}") from error
    _log_path(context, host, step, f".{mode}.ssh-stderr").write_text(result.stderr)
    if result.returncode == SSH_FAILED:
        raise ConnectionError(f"SSH to {host} failed during {mode} of step {step!r}. {resume}")
    if not result.stdout.strip():
        raise RuntimeError(f"Step bootstrap on {host} refused {step!r}: {result.stderr.strip()[-300:]}")
    state = json.loads(result.stdout.strip().splitlines()[-1])
    write_json_atomic(_log_path(context, host, step, ".state.json"), state)
    return state


def run_step(context, host, step, code, *, idempotent=False, allow_rerun=False, timeout=600):
    """Run step code once on host and return its result dict; reuse an earlier success.

    Raises RuntimeError when the step failed, was interrupted or was refused.
    Idempotent read-only steps may be re-run freely.
    """
    full = PRELUDE + code
    _log_path(context, host, step, ".remote.py").write_text(full)
    state = _invoke(context, host, step, "run", full, allow_rerun=allow_rerun, repeat=idempotent,
                    timeout=timeout)
    return _require_success(state, host)


def wait_step(context, host, step, wait_seconds=1800):
    return _invoke(context, host, step, "wait", wait_seconds=wait_seconds, timeout=wait_seconds + 120)


def step_status(context, host, step):
    return _invoke(context, host, step, "status", timeout=120)


def _require_success(state, host):
    if state["state"] == "succeeded":
        return state["result"]
    reason = state.get("refused") or f"state {state['state']}, exit {state.get('exit')}"
    raise RuntimeError(f"Step {state['step']} on {host}: {reason}. Protected logs: {state['private_dir']}")


def upload(context, host, local_path, remote_path, timeout=3600):
    """Copy a local file to an absolute host path (mode 0600) and verify its SHA-256 there."""
    if not remote_path.startswith("/") or ".." in Path(remote_path).parts:
        raise ValueError("Remote path must be absolute without ..")
    expected = sha256_file(local_path)
    with Path(local_path).open("rb") as stream:
        result = subprocess.run(remote_python_command(context, host, remote_path, expected, program=UPLOAD),
                                stdin=stream, capture_output=True, timeout=timeout)
    if result.returncode == SSH_FAILED:
        raise ConnectionError(f"SSH upload to {host} failed; re-run upload (an incomplete .partial is replaced)")
    if result.returncode:
        raise RuntimeError(f"Upload to {host}:{remote_path} refused (exit {result.returncode}): existing different "
                           "file or checksum mismatch")
    return expected


def copy_from(context, host, remote_path, local_path, expected_sha256=None, timeout=1800):
    """Copy a root-readable host file to a new owner-only local file, verifying SHA-256 when given."""
    local_path = Path(local_path)
    if local_path.exists():
        if expected_sha256 and sha256_file(local_path) == expected_sha256:
            return local_path
        raise ValueError(f"Refusing existing destination {local_path}")
    partial = local_path.with_name(local_path.name + ".partial")
    with partial.open("wb") as stream:
        os.fchmod(stream.fileno(), 0o600)
        result = subprocess.run(context.ssh_base() + [host, "--", shlex.join(["sudo", "cat", "--", remote_path])],
                                stdout=stream, stderr=subprocess.PIPE, timeout=timeout)
    if result.returncode:
        partial.unlink()
        raise RuntimeError(f"Copy from {host}:{remote_path} failed")
    if expected_sha256 and sha256_file(partial) != expected_sha256:
        partial.unlink()
        raise ValueError(f"Checksum mismatch copying {remote_path}")
    partial.rename(local_path)
    return local_path


def add_context_arguments(parser):
    parser.add_argument("--label", required=True, help="Release label, e.g. 1.22; host dir /root/tayyn-<label>-private")
    parser.add_argument("--ssh-config", type=Path, default=os.environ.get("TAYYN_SSH_CONFIG"),
                        help="Private SSH config with pinned host keys (default $TAYYN_SSH_CONFIG)")
    parser.add_argument("--nc-interface", default=os.environ.get("TAYYN_SSH_NC_INTERFACE", ""),
                        help="Route SSH through `nc -b IFACE` when BindInterface times out (e.g. en0)")
    parser.add_argument("--log-dir", type=Path, help="Local private log dir (default .local/release-<label>/logs)")


def context_from(arguments):
    label = check_name(arguments.label, "label")
    if not arguments.ssh_config:
        raise SystemExit("Pass --ssh-config or set TAYYN_SSH_CONFIG")
    log_dir = arguments.log_dir or Path(".local") / f"release-{label}" / "logs"
    return Context(label=label, ssh_config=Path(arguments.ssh_config), log_dir=log_dir,
                   nc_interface=arguments.nc_interface)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    add_context_arguments(parser)
    commands = parser.add_subparsers(dest="command", required=True)
    run = commands.add_parser("run", help="Run a step once (reuses an earlier success)")
    for sub in (run, commands.add_parser("status", help="Read the durable step state"),
                commands.add_parser("wait", help="Poll a running step until it ends")):
        sub.add_argument("--host", required=True)
        sub.add_argument("--step", required=True)
    source = run.add_mutually_exclusive_group(required=True)
    source.add_argument("--code", help="Inline step code")
    source.add_argument("--file", type=Path, help="Step code file (executed with the prelude, never imported)")
    run.add_argument("--allow-rerun", action="store_true", help="Archive a previous attempt and run again")
    run.add_argument("--timeout", type=int, default=1800)
    commands.choices["wait"].add_argument("--timeout", type=int, default=1800)
    arguments = parser.parse_args()
    context = context_from(arguments)
    if arguments.command == "run":
        code = arguments.code if arguments.code is not None else arguments.file.read_text()
        result = run_step(context, arguments.host, arguments.step, code, allow_rerun=arguments.allow_rerun,
                          timeout=arguments.timeout)
        print(json.dumps(result, indent=2))
    elif arguments.command == "status":
        print(json.dumps(step_status(context, arguments.host, arguments.step), indent=2))
    else:
        state = wait_step(context, arguments.host, arguments.step, arguments.timeout)
        print(json.dumps(state, indent=2))
        sys.exit(0 if state["state"] == "succeeded" else 1)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, ConnectionError, OSError, subprocess.TimeoutExpired) as error:
        print(f"Failed: {error}", file=sys.stderr)
        sys.exit(1)
