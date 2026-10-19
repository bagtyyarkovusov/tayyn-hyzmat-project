# Release operator runbook

These helpers run on the operator Mac. They reach the hosts only through the pinned SSH profile. They are not part of the offline bundle. They wrap the existing [`apply-release.py`](../apply-release.py) and [`verify-release-signature.sh`](../verify-release-signature.sh) and do not replace them. Read [production handoff](../../../docs/production-handoff.md), [offline bundle](../../../docs/offline-production-bundle.md) and [release lessons](../../../docs/release-lessons.md) first.

The helpers were extracted from the 1.21 deploy. Their pure logic has unit tests (`scripts/tests/test_release_operator_helpers.py`), but they have not yet run against production. Treat the first production use as supervised. Read each generated step file (`.local/release-<label>/logs/*.remote.py`) before it runs a downtime step.

## Conventions

| Item                | Value                                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| Label               | Short release label, e.g. `1.22`. Passed as `--label` to every helper                                    |
| Bundle release      | `vps-N-<full commit>` (see [release records](../../../docs/releases/production/README.md))               |
| Host step directory | `/root/tayyn-<label>-private/` on each host, 0700: step code, start record, stdout/stderr, exit, result  |
| Local evidence      | `.local/release-<label>/` (ignored, 0700). Step logs go in `logs/`, captures in `capture-<stage>/`       |
| Protected backups   | `/var/lib/tayyn/protected-<label>/` on main and monitor, outside retention                               |
| SSH                 | `export TAYYN_SSH_CONFIG=<canonical checkout>/.local/vps-bootstrap/ssh-config`                           |
| SSH fallback        | `export TAYYN_SSH_NC_INTERFACE=en0` when `BindInterface` times out (adds `ProxyCommand=nc -b en0 %h %p`) |
| Private inputs      | Signed artifact URL, maps client key, keystore: owner-only files, read from a path only, never in argv   |

Run helpers from the repository root, e.g. `python3 scripts/production/release/stage.py --label 1.22 stage ...`. Each `--help` lists every option. Evidence paths are relative to the working directory. From a worktree, pass `--log-dir <canonical checkout>/.local/release-<label>/logs` so that the evidence stays in the owner checkout.

## Durable steps and resuming

Every remote action is a named step ([`remote_step.py`](remote_step.py)). The host runs it detached from SSH, without bytecode, with umask 077. It writes the result atomically to `/root/tayyn-<label>-private/<step>.json`.

- **SSH dropped or the Mac timed out:** do not re-run. Reconnect, then run `remote_step.py --label L wait --host H --step S` (or `status`). It reads the durable files and waits while the step is still running.
- **Same command again:** a step that succeeded with identical code returns its saved result without running. This is how you resume a multi-step helper such as `capture.py`.
- **Failed or interrupted step:** it is refused until you inspect `stderr_tail` and the host files. `--allow-rerun` archives that attempt as `*.attempt-<time>` and runs again. Use it only when the step is safe to repeat.
- Read-only steps (`premaintenance`, `restore-backup-timer`) always run again.

## 1. Normal server update

| #   | Command                                                                                                                                                                                             | Checks                                                                                                                                                           | Downtime | Stop if                                      | Resume                                                                            |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------- | --------------------------------------------------------------------------------- |
| 0   | Merge reviewed PR, tag `vX.Y.Z`, dispatch `container-images.yml -f offline_bundle=true` from the tag                                                                                                | Required CI green. Record any owner waiver in the release record                                                                                                 | No       | CI red without a recorded waiver             | n/a                                                                               |
| 1   | `gh run download RUN --name offline-production-SHA --dir .local/releases/RUN`, or `artifact.py download --url-file URL.private --output .local/releases/RUN/artifact.zip --size BYTES [--sha256 D]` | Range length and `Content-Range` per 4 MiB range, final size and SHA-256                                                                                         | No       | Repeated range failures                      | Re-run the same command; kept ranges are reused                                   |
| 2   | `artifact.py verify --zip ... --artifact-dir .local/releases/RUN --release vps-N-SHA --source-commit SHA --version vX.Y.Z`                                                                          | Zip members, Sigstore signature and archive hashes, tar path safety, manifest commit/clean/version/target, local `verify_bundle`                                 | No       | Any failure. Never bypass the signature      | Re-run; an identical earlier extraction is accepted                               |
| 3   | `stage.py --label L stage --artifact-dir .local/releases/RUN [--pin-image-file /app/prisma/migrations/X/migration.sql=SHA]`                                                                         | Upload hash, signed hash on host, safe extraction, manifest, `verify_bundle` without imports, disk, `docker load`, loaded image identity, pins, no `__pycache__` | No       | Any failure                                  | Re-run (reuses result); a refused partial extraction needs inspection             |
| 4   | `premaintenance.py --label L --release vps-N-SHA --domain taxi.tayynhyzmat.com [--expect-current vps-M-...] [--expect-api-env KEY=VALUE]`                                                           | Compose config, images equal manifest, DOMAIN/TLS_MODE, expected non-secret settings, secret shape, certificate host/expiry/key, backup config, disk             | No       | `passed: false`                              | Re-run freely                                                                     |
| 5   | `stage.py --label L apply --release vps-N-SHA`                                                                                                                                                      | `apply-release.py`: stop writers, encrypted backup, migrate, start, DB and HTTPS checks, switch `/opt/tayyn/current`                                             | **Yes**  | Non-zero: services may be stopped            | `remote_step.py ... wait --step apply-vps-N-SHA`. Never re-run blindly; see below |
| 6   | Private domain acceptance script, monitor/relay checks, `prune-releases.py --keep 2`, then the release record                                                                                       | Authenticated login, WebSocket, data counts, monitor healthy, post-release backup on main and monitor                                                            | No       | Any acceptance failure: treat as an incident | Re-run read-only checks                                                           |

If step 5 fails, read the host `apply-release-<release>.stderr` in the step directory. Follow [Recover a failed update](../../../docs/offline-production-bundle.md#recover-a-failed-update). Before migrations, restart the current release. After migrations, use a reviewed forward fix. The helper never restores a database or retries.

## 2. Update with a one-time reset or migration

The release-specific logic lives in a per-release script, such as `scripts/production/reset-release-1.21.py` with its policy. That script and its owner rehearsal stay per release. Run steps 0 to 4 above, then:

| #   | Command                                                                                                              | Downtime   | Stop if                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------- |
| R1  | `capture.py --label L capture --stage installed-pre-migration --stop-writers`                                        | **Starts** | Writers not quiesced, backup or any copy checksum mismatch      |
| R2  | Release script: take the preservation snapshot while writers stay stopped, then copy it with `remote_step.copy_from` | Yes        | Snapshot guard fails                                            |
| R3  | Owner-local rehearsal of R1's archive in a disposable PostgreSQL (manual, per release; see lessons on tmpfs)         | Yes        | Rehearsal or forced rollback fails                              |
| R4  | Release script: migration-only step bound to the R3 result                                                           | Yes        | Non-zero: keep writers stopped. Never start the old image alone |
| R5  | `capture.py ... capture --stage final-<version>` (writers already stopped), then rehearse again                      | Yes        | As R1/R3                                                        |
| R6  | Release script: guarded reset/data step bound to the R5 copies and rehearsal                                         | Yes        | Non-zero: never retry automatically                             |
| R7  | `stage.py ... apply --release vps-N-SHA`, then `capture.py ... restore-timer`                                        | Ends       | As step 5                                                       |
| R8  | Step 6 acceptance plus the release script's read-only verification                                                   | No         | Any mismatch                                                    |

The downtime lasts from R1 to R7. Plan the owner rehearsals inside it. A dropped session resumes at the first step that has no saved success. Re-running `capture.py` with the same stage reuses each finished part.

### Writing a release script with these helpers

```python
import sys; sys.path.insert(0, "scripts/production/release")
import remote_step
context = remote_step.Context("1.22", Path(os.environ["TAYYN_SSH_CONFIG"]), Path(".local/release-1.22/logs"))
code = f"RELEASE = {release!r}\nPROOF = {proof!r}\n" + """
rel = Path("/opt/tayyn/releases") / RELEASE
source = rel / "scripts/production/reset-release-1.22.py"
reset = {"__name__": "reset"}
exec(compile(source.read_text(), str(source), "exec"), reset)   # never import from the release dir
...                                                                # guarded, single-purpose work
write_result({"migration_succeeded": True, ...})                   # durable; the only success signal
"""
result = remote_step.run_step(context, "tayyn-production", "migration-only", code, timeout=1800)
```

Rules:

- Keep one irreversible action per step, and give the step a stable name.
- Embed parameters as `repr()` literals. Never embed secrets.
- Bind each step to the earlier evidence it depends on, such as a capture hash or a rehearsal result.
- Write host-side logs to `PRIVATE_DIR`.
- Never mark an irreversible step idempotent.

## 3. Android-only APK release

| #   | Command                                                                                                                                      | Checks                                                                                                                                                                                                                                                       | Stop if                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| A1  | Bump `versionCode` and `versionName` in `android/app/build.gradle` on a feature branch. Merge after review                                   | Code increases. Package and signing key unchanged                                                                                                                                                                                                            | n/a                             |
| A2  | `android_apk.py stage-signing-inputs --canonical ~/Projects/tayyn-hyzmat-project` (in a worktree)                                            | Each target git-ignored. Keystore files and release `google-services.json` become symlinks. The debug `google-services.json` becomes a 0600 copy. Conflicting files refused                                                                                  | Any refusal                     |
| A3  | `android_apk.py build --approved-sha SHA --maps-key-file <private maps-client-key file> --expect-version-name X.Y.Z --expect-version-code N` | Clean HEAD equal to SHA. Restores `android/capacitor.settings.gradle`. Badging/version, certificate SHA-256, non-debuggable, production URLs and maps key, fresh `dist-driver` assets, alert sound, no credential markers, secret files or signing passwords | Any failure. Do not distribute  |
| A4  | Tag `android-X.Y.Z` (not `v*`: that publishes server images) and publish the APK with `SHA256SUMS` and `build-provenance.json`               | APK hash in the release notes                                                                                                                                                                                                                                | n/a                             |
| A5  | Install over the previous production APK on a real phone                                                                                     | In-place update, login, GPS, notifications                                                                                                                                                                                                                   | Install conflict or regressions |

There is no downtime. A failed build leaves a new output directory; remove it before retrying. The build always restores `android/capacitor.settings.gradle`.

## Deliberately manual

- **Owner rehearsal restore.** It needs the private backup identity, which stays on the owner Mac and never on a VPS, and a release-specific schema policy.
- **Release-specific reset or migration and its verification.** These are irreversible and differ per release.
- **Runtime configuration edits**, such as the 1.21 `YANDEX_GEOCODER_REFERER` change. Edit atomically with a 0600 backup in the step directory, inside a reviewed per-release step.
- **Fetching the signed artifact URL with `gh`, and VPS-side downloads.** `artifact.py vps-download-command` only prints the command.
- **Acceptance, monitor checks, GitHub release upload, GHCR verification and release records.**
- **Monitor bundle updates** (see the handoff).
