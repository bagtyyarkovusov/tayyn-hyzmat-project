"""Release operator helpers: resumable downloads, durable remote steps and APK input staging.

No SSH, VPS, Railway or shared database is contacted. The remote step bootstrap runs
locally as the current user against a temporary private directory; HTTP uses a loopback
server; signing inputs are fake files in temporary checkouts.
"""
import fcntl
import hashlib
import http.server
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts/production/release"))
import android_apk  # noqa: E402
import artifact  # noqa: E402
import capture  # noqa: E402
import premaintenance  # noqa: E402
import remote_step  # noqa: E402
import stage  # noqa: E402

DATA = bytes(range(256)) * 41 + b"tail"  # 10500 bytes: ten full 1 KiB ranges and a short last range
CHUNK = 1024
NO_SLEEP = lambda seconds: None  # noqa: E731


def serve(data, range_header=None):
    def fetch(url, start, end):
        return range_header or f"bytes {start}-{end}/{len(data)}", data[start:end + 1]
    return fetch


class TemporaryTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.work = Path(temporary.name)


class RangedDownloadTests(TemporaryTest):
    def test_interrupted_download_resumes_from_kept_ranges(self):
        output = self.work / "artifact.zip"

        def failing_range_five(url, start, end):
            if start == 5 * CHUNK:
                raise OSError("connection reset")
            return serve(DATA)(url, start, end)
        with self.assertRaises(artifact.RangeError):
            artifact.download_ranged("https://x", output, len(DATA), chunk=CHUNK, workers=2, fetch=failing_range_five,
                                     sleep=NO_SLEEP)
        self.assertFalse(output.exists())

        def only_range_five(url, start, end):
            if start != 5 * CHUNK:
                raise AssertionError("A kept range was downloaded again")
            return serve(DATA)(url, start, end)
        artifact.download_ranged("https://x", output, len(DATA), chunk=CHUNK, fetch=only_range_five, sleep=NO_SLEEP)
        self.assertEqual(output.read_bytes(), DATA)
        self.assertFalse((self.work / "artifact.zip.ranges").exists())

    def test_transient_range_failures_are_retried(self):
        failed = set()

        def flaky(url, start, end):
            if start not in failed:
                failed.add(start)
                raise OSError("timeout")
            return serve(DATA)(url, start, end)
        output = artifact.download_ranged("https://x", self.work / "a.zip", len(DATA), chunk=CHUNK, fetch=flaky,
                                          sleep=NO_SLEEP)
        self.assertEqual(output.read_bytes(), DATA)

    def test_response_for_a_different_range_is_rejected(self):
        with self.assertRaises(artifact.RangeError):
            artifact.download_ranged("https://x", self.work / "a.zip", len(DATA), chunk=CHUNK, retries=2,
                                     fetch=serve(DATA, "bytes 0-1023/10500"), sleep=NO_SLEEP)

    def test_checksum_mismatch_leaves_no_artifact(self):
        output = self.work / "a.zip"
        with self.assertRaisesRegex(ValueError, "SHA-256"):
            artifact.download_ranged("https://x", output, len(DATA), chunk=CHUNK, sha256="0" * 64, fetch=serve(DATA),
                                     sleep=NO_SLEEP)
        self.assertFalse(output.exists())
        self.assertFalse((self.work / "a.zip.partial").exists())

    def test_downloads_over_http_ranges_from_a_server_that_fails_once(self):
        state = {"failed": False}

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                if not state["failed"]:
                    state["failed"] = True
                    self.send_error(503)
                    return
                start, end = map(int, self.headers["Range"].removeprefix("bytes=").split("-"))
                body = DATA[start:end + 1]
                self.send_response(206)
                self.send_header("Content-Range", f"bytes {start}-{end}/{len(DATA)}")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *arguments):
                pass
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        url = f"http://127.0.0.1:{server.server_port}/artifact.zip"
        state["failed"] = True
        self.assertEqual(artifact.probe_size(url), len(DATA))
        state["failed"] = False
        output = artifact.download_ranged(url, self.work / "a.zip", len(DATA), chunk=4096, workers=1, sleep=NO_SLEEP)
        self.assertEqual(output.read_bytes(), DATA)


class RemoteStepTests(TemporaryTest):
    def bootstrap(self, step, mode, code="", flags="-"):
        private = self.work / "private"
        result = subprocess.run([sys.executable, "-B", "-I", "-c", remote_step.BOOTSTRAP, str(private), step, mode,
                                 flags], input=remote_step.PRELUDE + code if code else "", text=True,
                                capture_output=True, timeout=60)
        return result.returncode, json.loads(result.stdout)

    def test_completed_step_result_is_reused_without_running_again(self):
        marker = self.work / "runs.txt"
        code = f"open({str(marker)!r}, 'a').write('run\\n')\nwrite_result({{'migrated': 29}})\n"
        self.assertEqual(self.bootstrap("migrate", "run", code)[1]["result"], {"migrated": 29})
        exit_code, state = self.bootstrap("migrate", "run", code)
        self.assertEqual((exit_code, state["state"], state.get("reused")), (0, "succeeded", True))
        self.assertEqual(marker.read_text(), "run\n")
        self.assertEqual(self.bootstrap("migrate", "status")[1]["result"], {"migrated": 29})

    def test_failed_step_is_refused_until_rerun_is_allowed(self):
        code = "import sys\nprint('boom', file=sys.stderr)\nsys.exit(2)\n"
        exit_code, state = self.bootstrap("reset", "run", code)
        self.assertEqual((exit_code, state["state"], state["exit"]), (1, "failed", 2))
        self.assertIn("boom", state["stderr_tail"])
        exit_code, state = self.bootstrap("reset", "run", code)
        self.assertEqual(exit_code, 3)
        self.assertIn("refused", state)
        exit_code, state = self.bootstrap("reset", "run", "write_result({'ok': True})\n", "rerun")
        self.assertEqual((exit_code, state["result"]), (0, {"ok": True}))
        self.assertTrue(list((self.work / "private").glob("reset.exit.attempt-*")))

    def test_succeeded_step_with_changed_code_is_refused(self):
        self.bootstrap("capture", "run", "write_result({'n': 1})\n")
        exit_code, state = self.bootstrap("capture", "run", "write_result({'n': 2})\n")
        self.assertEqual((exit_code, state["result"]), (3, {"n": 1}))

    def hold_step_lock(self, step):
        private = self.work / "private"
        private.mkdir(mode=0o700, exist_ok=True)
        handle = open(private / f"{step}.lock", "a")
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.addCleanup(handle.close)
        return handle

    def test_step_is_running_exactly_while_its_lock_is_held(self):
        handle = self.hold_step_lock("migrate")
        self.assertEqual(self.bootstrap("migrate", "status")[1]["state"], "running")
        marker = self.work / "ran.txt"
        code = f"open({str(marker)!r}, 'w').write('ran')\nwrite_result({{}})\n"
        for flags in ("-", "rerun", "repeat"):
            exit_code, state = self.bootstrap("migrate", "run", code, flags)
            self.assertEqual((exit_code, state["state"]), (3, "running"), flags)
        self.assertFalse(marker.exists())
        handle.close()
        self.assertEqual(self.bootstrap("migrate", "status")[1]["state"], "not-started")

    def test_detached_step_holds_its_lock_until_it_exits(self):
        go = self.work / "go"
        code = (f"import time\nfrom pathlib import Path\nwhile not Path({str(go)!r}).exists():\n"
                "    time.sleep(0.05)\nwrite_result({'done': True})\n")
        first = subprocess.Popen([sys.executable, "-B", "-I", "-c", remote_step.BOOTSTRAP, str(self.work / "private"),
                                  "reset", "run", "-"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        self.addCleanup(first.wait)
        self.addCleanup(first.stdout.close)
        self.addCleanup(go.touch)
        first.stdin.write(remote_step.PRELUDE + code)
        first.stdin.close()
        deadline = time.monotonic() + 20
        while not (self.work / "private/reset.started.json").exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertEqual(self.bootstrap("reset", "status")[1]["state"], "running")
        exit_code, state = self.bootstrap("reset", "run", code, "rerun")
        self.assertEqual((exit_code, state["state"]), (3, "running"))
        go.touch()
        self.assertEqual(json.loads(first.stdout.read())["result"], {"done": True})
        self.assertEqual(self.bootstrap("reset", "status")[1]["state"], "succeeded")

    def test_step_files_are_written_without_leftover_temporaries(self):
        self.bootstrap("stage", "run", "write_result({'ok': True})\n")
        names = sorted(p.name for p in (self.work / "private").iterdir())
        self.assertEqual(names, ["stage.exit", "stage.json", "stage.lock", "stage.py", "stage.started.json",
                                 "stage.stderr", "stage.stdout"])

    def test_unstarted_step_reports_not_started(self):
        self.assertEqual(self.bootstrap("stage", "status")[1]["state"], "not-started")

    def test_step_imports_create_no_bytecode_cache(self):
        release = self.work / "release"
        release.mkdir()
        (release / "apply-release.py").write_text("def verify_bundle():\n    return 'verified'\n")
        code = ("import importlib.util, sys\n"
                f"spec = importlib.util.spec_from_file_location('applyrelease', {str(release / 'apply-release.py')!r})\n"
                "module = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(module)\n"
                "write_result({'verify': module.verify_bundle(), 'no_bytecode': sys.flags.dont_write_bytecode})\n")
        self.assertEqual(self.bootstrap("verify", "run", code)[1]["result"], {"verify": "verified", "no_bytecode": 1})
        self.assertEqual(sorted(p.name for p in release.iterdir()), ["apply-release.py"])

    def test_atomic_json_write_replaces_whole_file_with_owner_only_mode(self):
        path = self.work / "step.json"
        remote_step.write_json_atomic(path, {"state": "first"})
        remote_step.write_json_atomic(path, {"state": "second"})
        self.assertEqual(json.loads(path.read_text()), {"state": "second"})
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual([p.name for p in self.work.iterdir()], ["step.json"])

    def test_remote_command_disables_bytecode_and_restricts_umask(self):
        context = remote_step.Context("1.22", Path("/private/ssh-config"), self.work / "logs", nc_interface="en0")
        command = remote_step.step_command(context, "tayyn-production", "stage-vps-2", "run")
        self.assertIn("ProxyCommand=nc -b en0 %h %p", command)
        self.assertEqual(command[-3:-1], ["tayyn-production", "--"])
        remote = command[-1]
        self.assertTrue(remote.startswith("umask 077 && sudo env PYTHONDONTWRITEBYTECODE=1 python3 -B -I -c "))
        self.assertTrue(remote.endswith(" /root/tayyn-1.22-private stage-vps-2 run -"))

    def test_unsafe_step_names_are_rejected(self):
        context = remote_step.Context("1.22", Path("/c"), self.work)
        for name in ("../root", "a b", ""):
            with self.assertRaises(ValueError):
                remote_step.step_command(context, "tayyn-production", name, "run")


class GeneratedStepCodeTests(unittest.TestCase):
    def assertCompiles(self, code):
        compile(remote_step.PRELUDE + code, "step", "exec")

    def test_helpers_generate_valid_step_code(self):
        sha = "a" * 40
        self.assertCompiles(stage.stage_code(release=f"vps-2-{sha}", app_sha256="b" * 64, source_commit=sha,
                                             version="v1.22.0", pins={"/app/x.sql": "c" * 64}))
        self.assertCompiles(premaintenance.check_code(release=f"vps-2-{sha}", domain="taxi.tayynhyzmat.com",
                                                      tls_mode="external", expect_api_env={}))
        self.assertCompiles(capture.capture_code(stage="final-1.22", stop_writers=True, protected_dir="/var/x"))
        self.assertCompiles(capture.relay_code(expected={"name": "n", "sha256": "d" * 64, "size": 1},
                                               protected_dir="/var/x"))
        self.assertCompiles(capture.RESTORE_TIMER_CODE)
        self.assertCompiles(stage.apply_code(f"vps-2-{sha}"))

    def test_secret_settings_cannot_be_compared_in_step_logs(self):
        self.assertEqual(premaintenance.parse_expected(["YANDEX_GEOCODER_REFERER=https://taxi.tayynhyzmat.com/"]),
                         {"YANDEX_GEOCODER_REFERER": "https://taxi.tayynhyzmat.com/"})
        for setting in ("JWT_ACCESS_SECRET=x", "SEED_ADMIN_PASSWORD=x", "YANDEX_GEOCODER_API_KEY=x"):
            with self.assertRaises(ValueError):
                premaintenance.parse_expected([setting])

    def test_image_file_pins_require_absolute_path_and_sha256(self):
        self.assertEqual(stage.parse_pins(["/app/m.sql=" + "e" * 64]), {"/app/m.sql": "e" * 64})
        with self.assertRaises(ValueError):
            stage.parse_pins(["app/m.sql=" + "e" * 64])


class FakeHost:
    """Answers the quiesce probes like a host; each test changes one fact."""
    COMPOSE = ["docker", "compose", "--project-name", "tayyn-production"]

    def __init__(self, containers=("db1",), sessions="0", backup_service="inactive", timer="inactive",
                 timer_enabled="enabled"):
        self.containers, self.sessions, self.backup_service = list(containers), sessions, backup_service
        self.timer, self.timer_enabled, self.stopped_services = timer, timer_enabled, False

    def probe(self, argv):
        if argv[:len(self.COMPOSE)] == self.COMPOSE and argv[-4:] == ["ps", "--quiet", "--no-trunc", "db"]:
            return "db1\n"
        if argv[:2] == ["docker", "ps"]:
            return "\n".join(self.containers) + "\n"
        if argv[:2] == ["docker", "exec"]:
            return self.sessions + "\n"
        answers = {("systemctl", "is-active", "tayyn-backup.service"): self.backup_service,
                   ("systemctl", "is-active", "tayyn-backup.timer"): self.timer,
                   ("systemctl", "is-enabled", "tayyn-backup.timer"): self.timer_enabled}
        return answers[tuple(argv)] + "\n"

    def run(self, argv):
        if argv == ["systemctl", "stop", "tayyn-backup.timer"]:
            self.timer = "inactive"
        elif argv == ["systemctl", "start", "tayyn-backup.timer"]:
            self.timer = "active"
        elif argv == self.COMPOSE + ["stop", "proxy", "web", "api"]:
            self.stopped_services = True
        else:
            raise AssertionError(argv)
        return ""


class QuiesceTests(TemporaryTest):
    def problems(self, host):
        return capture.quiesce_problems(host.probe, FakeHost.COMPOSE)

    def stop(self, host):
        capture.stop_app_writers(host.run, host.probe, FakeHost.COMPOSE, self.work / "timer.txt", sleep=NO_SLEEP,
                             attempts=3)

    def test_only_db_with_no_other_sessions_and_idle_backup_is_quiesced(self):
        self.assertEqual(self.problems(FakeHost()), [])

    def test_extra_project_container_such_as_one_off_migrate_is_rejected(self):
        self.assertEqual(self.problems(FakeHost(containers=("db1", "migrate1"))),
                         ["only the db container may run in tayyn-production (found 2)"])

    def test_other_database_session_is_rejected(self):
        self.assertEqual(self.problems(FakeHost(sessions="1")), ["other database client sessions are connected"])

    def test_active_backup_service_is_rejected_without_stop_writers(self):
        self.assertEqual(self.problems(FakeHost(backup_service="active")),
                         ["tayyn-backup.service is running or its state is unknown"])

    def test_unreadable_host_state_fails_closed(self):
        self.assertEqual(len(capture.quiesce_problems(lambda argv: "", FakeHost.COMPOSE)), 2)

    def test_stop_writers_stops_timer_then_services_and_records_timer_state(self):
        host = FakeHost(timer="active")
        self.stop(host)
        self.assertEqual((host.timer, host.stopped_services), ("inactive", True))
        self.assertEqual((self.work / "timer.txt").read_text(), "enabled\n")
        self.assertEqual(self.problems(host), [])

    def test_stop_writers_restarts_an_enabled_timer_when_backup_does_not_finish(self):
        host = FakeHost(timer="active", backup_service="active")
        with self.assertRaisesRegex(SystemExit, "timer restarted"):
            self.stop(host)
        self.assertEqual((host.timer, host.stopped_services), ("active", False))

    def test_stop_writers_leaves_a_disabled_timer_stopped_on_failure(self):
        host = FakeHost(timer="active", timer_enabled="disabled", backup_service="active")
        with self.assertRaisesRegex(SystemExit, "left stopped"):
            self.stop(host)
        self.assertEqual((host.timer, host.stopped_services), ("inactive", False))


class ArtifactSafetyTests(TemporaryTest):
    def test_github_style_digest_is_accepted_and_bad_digest_rejected_before_download(self):
        self.assertEqual(artifact.normalise_sha256("sha256:" + "A" * 64), "a" * 64)

        def never(url, start, end):
            raise AssertionError("Downloaded despite an invalid digest")
        for bad in ("sha256:abc", "md5:" + "a" * 64):
            with self.assertRaises(ValueError):
                artifact.download_ranged("https://x", self.work / "a.zip", 10, sha256=bad, fetch=never)

    def test_github_style_digest_verifies_the_download(self):
        output = artifact.download_ranged("https://x", self.work / "a.zip", len(DATA), chunk=CHUNK, fetch=serve(DATA),
                                          sha256="sha256:" + hashlib.sha256(DATA).hexdigest(), sleep=NO_SLEEP)
        self.assertEqual(output.read_bytes(), DATA)

    def archive(self, *members):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
            for name, kind in members:
                info = tarfile.TarInfo(name)
                info.type = kind
                if kind == tarfile.SYMTYPE:
                    info.linkname = "/etc/passwd"
                archive.addfile(info, io.BytesIO(b"") if kind == tarfile.REGTYPE else None)
        buffer.seek(0)
        return tarfile.open(fileobj=buffer, mode="r:gz")

    def test_bundle_members_must_be_plain_files_under_the_release_root(self):
        root = "vps-2-" + "a" * 40
        self.assertEqual(len(artifact.safe_members(self.archive((root, tarfile.DIRTYPE),
                                                                (root + "/manifest.json", tarfile.REGTYPE)), root)), 2)
        for bad in ((root + "/../escape", tarfile.REGTYPE), ("other/file", tarfile.REGTYPE),
                    (root + "/link", tarfile.SYMTYPE)):
            with self.assertRaises(ValueError):
                artifact.safe_members(self.archive(bad), root)

    def test_manifest_from_dirty_or_other_source_is_rejected(self):
        manifest = {"sourceCommit": "a" * 40, "sourceDirty": False, "version": "v1.22.0", "schema": 1,
                    "target": "ubuntu24.04-amd64"}
        artifact.check_manifest(manifest, source_commit="a" * 40, version="v1.22.0")
        for change in ({"sourceDirty": True}, {"sourceCommit": "b" * 40}, {"version": "v1.21.0"}):
            with self.assertRaises(ValueError):
                artifact.check_manifest({**manifest, **change}, source_commit="a" * 40, version="v1.22.0")

    def test_vps_download_command_keeps_the_signed_url_out_of_argv(self):
        url_file = self.work / "url.private"
        url_file.write_text("https://blob.example/artifact.zip?sig=SECRET\n")
        url_file.chmod(0o600)
        config, command = artifact.vps_download_command(
            ssh_config="/c", host="tayyn-production", url_file=url_file,
            destination="/opt/tayyn/incoming/vps-2-x/artifact.zip", size=123)
        self.assertEqual(config, 'url = "https://blob.example/artifact.zip?sig=SECRET"\n')
        self.assertNotIn("SECRET", command)
        self.assertIn("--config -", command)
        self.assertIn("--continue-at -", command)

    def test_signed_url_file_must_be_owner_only(self):
        url_file = self.work / "url.private"
        url_file.write_text("https://blob.example/a.zip")
        url_file.chmod(0o644)
        with self.assertRaises(ValueError):
            artifact.read_private_text(url_file)


GRADLE = '''android {
    defaultConfig {
        applicationId "tayyn.hyzmat.production"
        // Increment packaged app versions before distributing updates.
        versionCode 23
        versionName "1.21.1"
    }
    buildTypes {
        debug {
            versionNameSuffix "-test"
        }
    }
}
'''


class AndroidHelperTests(TemporaryTest):
    def test_version_is_read_from_build_gradle(self):
        self.assertEqual(android_apk.parse_gradle_version(GRADLE), ("tayyn.hyzmat.production", "1.21.1", 23))
        with self.assertRaises(ValueError):
            android_apk.parse_gradle_version(GRADLE + "        versionCode 99\n")

    def test_identity_must_match_pinned_package_and_approved_version(self):
        parsed = android_apk.parse_gradle_version(GRADLE)
        approved = {"package": android_apk.PRODUCTION_PACKAGE, "version_name": "1.21.1", "version_code": 23}
        android_apk.check_identity(parsed, **approved)
        for change in ({"package": "io.openride.driver"}, {"version_name": "1.21"}, {"version_code": 22}):
            with self.assertRaises(ValueError):
                android_apk.check_identity(parsed, **{**approved, **change})

    def test_missing_signing_password_fails_instead_of_skipping_the_scan(self):
        self.assertEqual(android_apk.signing_passwords({"storePassword": "s", "keyPassword": "k"}), ["s", "k"])
        for properties in ({"storePassword": "s"}, {"storePassword": "s", "keyPassword": ""}, {}):
            with self.assertRaises(ValueError):
                android_apk.signing_passwords(properties)

    def test_build_requires_approved_version_arguments(self):
        result = subprocess.run([sys.executable, "-B", str(ROOT / "scripts/production/release/android_apk.py"),
                                 "build", "--approved-sha", "a" * 40, "--maps-key-file", "/nonexistent"],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn("--expect-version-name", result.stderr)

    def test_repository_build_gradle_has_one_parseable_version(self):
        package, _, code = android_apk.parse_gradle_version((ROOT / "android/app/build.gradle").read_text())
        self.assertEqual(package, "tayyn.hyzmat.production")
        self.assertGreater(code, 0)

    def make_canonical(self):
        canonical = self.work / "canonical"
        for name, content in (("android/keystore/keystore.properties", "storePassword=s\n"),
                              ("android/keystore/tayyn-hyzmat-production.jks", "jks"),
                              ("android/app/src/release/google-services.json", "{\"release\": 1}"),
                              ("android/app/src/debug/google-services.json", "{\"debug\": 1}")):
            (canonical / name).parent.mkdir(parents=True, exist_ok=True)
            (canonical / name).write_text(content)
        return canonical

    def test_signing_inputs_become_links_and_a_debug_copy(self):
        canonical, worktree = self.make_canonical(), self.work / "worktree"
        worktree.mkdir()
        actions = android_apk.stage_signing_inputs(canonical, worktree, is_ignored=lambda w, n: True)
        self.assertEqual(actions, {"android/keystore/keystore.properties": "link",
                                   "android/keystore/tayyn-hyzmat-production.jks": "link",
                                   "android/app/src/release/google-services.json": "link",
                                   "android/app/src/debug/google-services.json": "copy"})
        jks = worktree / "android/keystore/tayyn-hyzmat-production.jks"
        self.assertEqual((jks.is_symlink(), jks.resolve()), (True, (canonical / "android/keystore/"
                                                                                 "tayyn-hyzmat-production.jks").resolve()))
        debug = worktree / "android/app/src/debug/google-services.json"
        self.assertEqual((debug.is_symlink(), debug.read_text(), debug.stat().st_mode & 0o777),
                         (False, "{\"debug\": 1}", 0o600))
        again = android_apk.stage_signing_inputs(canonical, worktree, is_ignored=lambda w, n: True)
        self.assertEqual(set(again.values()), {"unchanged"})

    def test_signing_inputs_are_refused_when_not_ignored_or_conflicting(self):
        canonical, worktree = self.make_canonical(), self.work / "worktree"
        worktree.mkdir()
        with self.assertRaisesRegex(ValueError, "not git-ignored"):
            android_apk.stage_signing_inputs(canonical, worktree,
                                             is_ignored=lambda w, n: not n.endswith("google-services.json"))
        self.assertFalse((worktree / "android").exists())
        (worktree / "android/keystore").mkdir(parents=True)
        (worktree / "android/keystore/keystore.properties").write_text("other")
        with self.assertRaisesRegex(ValueError, "different content"):
            android_apk.stage_signing_inputs(canonical, worktree, is_ignored=lambda w, n: True)

    def test_real_worktree_ignores_signing_input_paths(self):
        for name in ("android/keystore/keystore.properties", "android/app/src/release/google-services.json",
                     "android/app/src/debug/google-services.json"):
            self.assertTrue(android_apk.git_ignored(ROOT, name), name)

    def test_web_asset_scan_requires_production_targets_and_rejects_credentials(self):
        good = {"assets/public/index.js": b"https://taxi.tayynhyzmat.com/api https://taxi.tayynhyzmat.com MAPKEY"}
        targets = {"api_url": "https://taxi.tayynhyzmat.com/api", "socket_url": "https://taxi.tayynhyzmat.com",
                   "maps_key": "MAPKEY"}
        self.assertEqual(android_apk.scan_web_assets(good, **targets), [])
        leaked = {"assets/public/a.js": good["assets/public/index.js"] + b' "type":"service_account"'}
        self.assertEqual(android_apk.scan_web_assets(leaked, **targets),
                         ["Forbidden embedded test/server credential marker"])
        local = {"assets/public/a.js": b"http://localhost:4185/api"}
        self.assertIn("Localhost API target", android_apk.scan_web_assets(local, **targets))
        self.assertEqual(android_apk.scan_names(["assets/public/a.js", "assets/.env.production", "res/k.jks"]),
                         ["Secret-looking file in APK: assets/.env.production", "Secret-looking file in APK: res/k.jks"])


if __name__ == "__main__":
    unittest.main()
