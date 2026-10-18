# One-time rollout 1.20 reset

This operator-only command implements the [approved reset contract](plans/driver-rollout-1.20.md#authorized-production-reset-and-rollout-guardrails). It is never run by startup, migration, seed, updater or timer. Future upgrades preserve application data. The source, policy and release images must pass independent review before production execution.

## Preservation and deletion

`deploy/production/rollout-1.20-reset-policy.json` pins both the installed pre-1.20 catalog and the rollout catalog. Inspection rejects unknown or missing tables, other application schemas, views, changed columns/FKs, custom triggers/rules and changed row-security flags. A schema change requires reviewing the actual FK graph, updating the policy and rerunning the drill. Never merely replace the digest to bypass a failure.

Preserve every ADMIN `users` row, every `admins` row, every entire `districts` row, `_prisma_migrations`, `settings` and `geocoder_budget`. The private snapshot includes every column and row, including credentials and exact saved boundaries. SQL assertions compare exact JSON values before and after deletion. Order-number sequence value, called state and definition remain unchanged. Historical order numbers cannot be reused.

Delete all operational rows, including admin financial/chat/notification/session rows. The policy lists notification deliveries/installations, native leases, devices, locations/address state, messages, notifications, resolution audits, rollout assignments, transactions, orders, vehicles, drivers, balances and refresh tokens in FK order, then non-admin users. Clear `drivers.current_vehicle_id` before deleting vehicles. No broad cascade, seed, schema/volume deletion or sequence restart is used.

The command locks all reviewed tables in one transaction, rejects other database clients, compares the saved pre-reset catalog/counts/records/sequence, checks admin relationships, deletes, and asserts exact preservation and empty operational tables before COMMIT. A failed assertion closes the connection and rolls back. It also performs a post-commit read. An error beginning `RESET COMMITTED` means deletion committed but post-check failed; keep writers stopped and investigate rather than retrying blindly.

## Inspection and private evidence

Run the reviewed script from the verified new release directory on the main host, while targeting the CURRENT release's Compose configuration. Do not install the new API first or migrate independently. The command requires root, exact project `tayyn-production`, database `tayyn`, current Compose directory `/opt/tayyn/current/deploy/production`, its release directory, Compose db labels and named volume `tayyn-production_postgres-data`. It rejects a shared Railway/test target. Inspection is read-only and prints only table counts and digests.

```sh
sudo python3 /opt/tayyn/releases/RELEASE/scripts/production/reset-rollout.py \
  --target production --project tayyn-production \
  --compose-dir /opt/tayyn/current/deploy/production
```

A preservation snapshot is sensitive. Keep it in owner-only storage and never attach it to an issue, PR or release. `--write-preservation-snapshot PATH` creates a new 0600 file and refuses overwrite or symlinks. Its stdout `snapshot_sha256` hashes canonical snapshot CONTENT. The execution flag `--snapshot-sha256` instead pins the exact FILE bytes, obtained with `sha256sum PATH`. These hashes differ because the file ends in a newline.

## Maintenance sequence

1. Verify final clean source, immutable API/web images, migrations, policy catalog, signed APK provenance, bundle checksums, disk and management recovery access. Record the current release/image IDs and dry-run counts/digests privately. Retain the previous release.
2. Stop `proxy web api` with CURRENT production Compose env/files and project. Leave db running. This stops native leases, sockets and API background delivery workers. Never use `down -v`. The command requires db to be the only running project container and rejects other DB clients or an in-progress backup service.
3. Take a new full encrypted backup with the established app-host backup command. Pin that PRE-RESET ciphertext separately from the updater's later post-reset/pre-migration backup. Keep 0700 `/var/lib/tayyn/pre-reset-1.20` and a 0600 copy there, outside automatic backup retention. Record ciphertext filename, size, SHA-256 and UTC creation time.
4. Run the existing monitor relay service as its established `tayyn-monitor` account. Compare the exact ciphertext size/SHA-256 against app inventory. Copy it to a protected directory outside relay retention on monitor, and to ignored owner-only workstation storage. The private age identity must remain only on the workstation.
5. Save a fresh private preservation snapshot while writers remain stopped. Restore the pinned archive on the owner's workstation into a NEW disposable PostgreSQL 17 project/database. The restore recipe in [production operations](production-operations.md#restore-drill-and-disaster-recovery) accepts isolated projects only. Use `tayyn-reset-rehearsal-SUFFIX` and `tayyn_restore_SUFFIX` for the owner-local restore/reset rehearsal, matching the restore helper's database guard. The reset tool also accepts `tayyn_reset_SUFFIX` for synthetic drills. Compare full preserved values, catalog, sequence and counts with the production snapshot, excluding only environment identity. Rehearse successful reset and rollback against this disposable copy, retaining evidence. The synthetic CI drill alone does not satisfy this live-backup restore gate.
6. Prepare the private manifest below ONLY from those verified results. Copy it to the main host as a regular 0600 file and pin its file SHA-256. It is an operator attestation; the command cannot remotely prove workstation restoration or relay retention. Do not mark a field true before completing its check.
7. Execute once with the protected snapshot, file hashes and manifest. The manifest must be less than two hours old. The original ciphertext is rehashed locally and must have an age header. Any guard failure stops before deletion; transaction assertion failures roll back. Keep evidence and writers stopped on unexpected results.
8. Recheck stdout counts/digests and preserved values privately, then run the standard updater WITHOUT `--initialize`. Its backup is now POST-RESET, so preserve the original PRE-RESET copy. After migrations begin, use compatible images or a reviewed forward fix. Never automatically restore old data over new activity.
9. Verify release commit/image IDs, HTTPS/API health, admin login, authenticated Socket.IO, exact saved boundary/admin digests, empty operational views and backup/relay/monitor timers. Do not create synthetic production accounts/orders. Record evidence in the production handoff and retain the protected original for the agreed recovery period.

The current Compose invocation is:

```sh
sudo docker compose --project-name tayyn-production \
  --env-file /etc/tayyn/app.env --env-file /opt/tayyn/current/release.env \
  -f /opt/tayyn/current/deploy/production/compose.production.yaml stop proxy web api
```

After completing the required backup/restore evidence:

```sh
sudo python3 /opt/tayyn/releases/RELEASE/scripts/production/reset-rollout.py \
  --target production --project tayyn-production \
  --compose-dir /opt/tayyn/current/deploy/production \
  --execute-reset --preservation-snapshot /PRIVATE/preservation.json \
  --snapshot-sha256 SNAPSHOT_FILE_SHA256 \
  --backup-manifest /PRIVATE/backup-manifest.json \
  --backup-manifest-sha256 MANIFEST_FILE_SHA256
```

## Backup manifest format

The snapshot's `snapshot_sha256` stdout value goes in `snapshot_sha256` below. Obtain `target` via a private inspection of the exact Docker container ID/image ID and resolved current release, with project/database/volume as shown. The manifest ties backup evidence to that target and snapshot. Do not paste resolved environment or Docker inspect output into public records.

```json
{
  "format": 1,
  "purpose": "rollout-1.20-pre-reset",
  "quiesced": true,
  "target": {
    "project": "tayyn-production",
    "database": "tayyn",
    "container": "FULL_DATABASE_CONTAINER_ID",
    "database_image": "sha256:DATABASE_IMAGE_ID",
    "volume": "tayyn-production_postgres-data",
    "current_release": "/opt/tayyn/releases/CURRENT_RELEASE"
  },
  "snapshot_sha256": "CANONICAL_SNAPSHOT_CONTENT_SHA256",
  "created_at": "UTC_ISO8601_WITH_TIMEZONE",
  "protected_from_retention": true,
  "archive": {
    "path": "/var/lib/tayyn/pre-reset-1.20/tayyn-YYYYMMDDTHHMMSSZ-01234567.dump.age",
    "sha256": "CIPHERTEXT_SHA256",
    "size": 123456
  },
  "relay": {
    "host": "tayyn-monitor",
    "sha256": "CIPHERTEXT_SHA256",
    "size": 123456,
    "protected_from_retention": true
  },
  "owner_copy": {
    "host": "owner-workstation",
    "sha256": "CIPHERTEXT_SHA256",
    "size": 123456,
    "protected_from_retention": true
  },
  "restore": {
    "host": "owner-workstation",
    "archive_sha256": "CIPHERTEXT_SHA256",
    "snapshot_sha256": "CANONICAL_SNAPSHOT_CONTENT_SHA256",
    "success": true,
    "rollback_rehearsed": true,
    "project": "tayyn-reset-rehearsal-UNIQUE_SUFFIX",
    "database": "tayyn_restore_UNIQUE_SUFFIX"
  }
}
```

Use lowercase alphanumeric/hyphen suffixes for the project and lowercase alphanumeric/underscore suffixes for the database. Record real protected-copy paths and restore logs privately alongside this manifest.

## Isolated verification

```sh
TAYYN_PRODUCTION_RESET_DRILL=1 python3 -m unittest discover \
  -s scripts/tests -p test_production_reset.py -v
```

This uses the existing `postgres:17-bookworm` image, a unique container with no published network, tmpfs data and no Docker logs. It applies actual migrations into synthetic templates for both reviewed schemas, drops each owned database promptly and removes only its owned container. It never reads production/shared DB URLs. CI runs it alongside the encrypted backup/restore/tamper drill. Coverage includes both schema digests, exact multi-admin credentials and non-default saved boundaries, quota/settings/migrations, sequence continuation, unknown schema changes, stale snapshots, connected clients, manifest guards and rollback after deletes. Production backup/relay/restoration and physical-phone behavior remain separate acceptance checks.
