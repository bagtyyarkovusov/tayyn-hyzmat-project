# Release 1.21 operational reset

This procedure is separate from the frozen [1.20 reset](production-reset-1.20.md). Use `scripts/production/reset-release-1.21.py` with the reviewed `deploy/production/rollout-1.21-reset-policy.json`. The old tool still refuses driver activity audits and the 1.21 schema. Neither command runs on startup. This document records implementation and synthetic evidence, not production execution.

The owner authorized retaining exactly one existing ADMIN user and its paired admin profile, with the existing password hash, credential version and every other field unchanged. Retain exactly the nine canonical region IDs/names with their complete existing saved rows and polygon geometries. The repository export identifies regions; it is never used to overwrite saved geometry. Missing/extra/renamed regions, missing polygons, extra or unpaired admins require investigation before reset. The command never creates identities or regions.

Preserve `_prisma_migrations`, settings, geocoder quota/budget rows and the order-number sequence value/called state/definition. Preserve infrastructure, configuration, secrets, TLS, monitoring and backups outside the database. Delete all operational rows, including admin financial/chat/session rows and `driver_activity_audits`, which has no FK cascade. The explicit 17-table delete list is:

- `driver_activity_audits`
- `notification_deliveries`, `notification_installations`, `native_shift_leases`
- `driver_devices`, `driver_locations`, `driver_address_state`
- `messages`, `notifications`, `order_resolution_audits`
- `order_assignments`, `transactions`, `orders`
- `vehicles`, `drivers`, `balances`, `refresh_tokens`

Delete non-admin users afterward. Zero checks cover every operational table. No seed, wildcard deletion, sequence restart, schema removal, volume deletion or `--initialize` belongs in this procedure.

## Required stages and exact pins

Every inspection, snapshot and execution requires one selector. The policy pins:

| Stage | Catalog SHA-256 | Migration history |
| --- | --- | --- |
| `installed-pre-migration` | `c843370ce174a42b97bd9cded55a0eab94b1e927cd554ba75fbf0ec37d6957c3` | 28 successful migrations, ending `20261018200000_driver_activity_audits` |
| `final-1.21` (normal) | `05cb51e58a4e75e498ec204f323f42403bde4a303936f07c2353fe53474607c0` | the same 28 plus `20261019090000_dispatcher_cancellation_outcomes` |

The final migration is `backend/prisma/migrations/20261019090000_dispatcher_cancellation_outcomes/migration.sql` from backend commit `d314749c7135f5369ecccde88b3b39f072bcb30a`, SHA-256 `4972e792bb96f74b539441acc65886f95702afb6b7d21c844c738b38611ae674`. Its read-only preflight `backend/prisma/preflight/dispatcher-cancellation-121.sql` has SHA-256 `75e18ab1c6523594debab83b1005f47ee307bd5c52f57329a59e7620d74f904c`. The installed catalog is identical at `edbc57a` and `a13f868`.

Both digests were derived, not written by hand: Prisma 5.22.0 `migrate deploy` applied every checked-in migration at each source commit to an owned tmpfs `postgres:17-bookworm` (17.11) database, and the tool's `CATALOG_SQL` output was hashed canonically. The digests changed from earlier drafts because the catalog now also pins collations, extensions, index validity and user types. The tool refuses a policy with a missing pin, or where the final history is not exactly the installed history plus the pinned final migration.

The catalog format includes relations, columns, foreign keys, defaults, every CHECK/PK/UNIQUE constraint, unique and ordinary indexes and their validity, collations, enums/types, routines, triggers, rules, schemas, extensions and row policies. The final catalog differs from the installed one only by the four nullable columns `orders.cancellation_outcome`, `orders.cancelled_by`, `orders.cancellation_refund_amount` and `transactions.assignment_id`. It also adds `transactions_assignment_id_fkey`, the unique index `transactions_assignment_id_type_key` and the checks `orders_cancellation_outcome_check` and `order_assignments_no_new_holds_check`. Historical 1.20 catalog SQL and hashes remain unchanged. Unknown catalogs and wrong stages fail before writes. Unfinished, failed, rolled-back, missing, extra or differently checksummed migration records also fail. Do not change a policy hash to make a live database pass. A live mismatch, including a different PostgreSQL image, is a stop condition for review.

The reset takes an exclusive deployment lock and verifies the exact current production Compose labels, project, database and named volume. It requires that only the DB container is running, no backup service is running and no other database clients are connected. It locks all reviewed tables in one transaction and rechecks the catalog, counts, full preserved records and sequence before deletion. It asserts complete preservation and empty operational tables before COMMIT. A database error rolls back every deletion. A failure prefixed `RESET COMMITTED` is a post-commit failure: keep writers stopped and investigate. Never assume a retry will repair it.

## Hard rules

- Never run `docker compose down -v`, `docker volume rm`, `docker volume prune`, `DROP DATABASE`/`DROP SCHEMA`, `TRUNCATE ... CASCADE`, `prisma migrate reset`, seed, or `apply-release.py --initialize` against production.
- Never bypass a failed Prisma migration. Do not use `prisma migrate resolve`, edit `_prisma_migrations`, edit migration bytes, or reset to hide failed history. Do not restart the old API on an uncertain schema. Keep writers stopped and obtain a reviewed recovery decision.
- Never delete unknown data to make a guard pass. Never edit a manifest timestamp; take fresh evidence instead.
- Do not touch Railway, shared editor or APK-test stacks. Do not prune releases, images or backups during maintenance or the recovery window.
- Keep snapshots, manifests, Docker inspect output, env files and credential checks private (mode 0600 in a mode 0700 directory). Public notes contain counts and digests only.

## Normal maintenance sequence

Use this path because the final migration's preflight has no live held funding to convert. Placeholders in capitals come from verified private inventory. `RELEASE` is the new, verified final 1.21 release directory. `/opt/tayyn/current` still points at the installed release until step 9. Reset and updater each take `/run/lock/tayyn-deploy.lock` themselves, so do not nest them under a held `flock`. Run the commands in one root-owned `bash` session (the variables rely on bash word splitting).

```sh
REL=/opt/tayyn/releases/RELEASE
PRIV=/root/tayyn-121-private
sudo install -d -m 0700 "$PRIV"
CURRENT_COMPOSE="docker compose --project-name tayyn-production --env-file /etc/tayyn/app.env --env-file /opt/tayyn/current/release.env -f /opt/tayyn/current/deploy/production/compose.production.yaml"
RESET="python3 $REL/scripts/production/reset-release-1.21.py --target production --project tayyn-production --compose-dir /opt/tayyn/current/deploy/production"
```

### 1. Pre-maintenance gates (no downtime yet)

Verify the signed bundle, `SHA256SUMS`, manifest `sourceCommit`, `sourceDirty: false` and loaded image IDs as in the [update runbook](production-update-runbook.md). Then verify that the release carries the pinned tool, policy and migration:

```sh
sha256sum $REL/scripts/production/reset-release-1.21.py $REL/deploy/production/rollout-1.21-reset-policy.json
API_IMAGE=$(sudo grep '^API_IMAGE=' $REL/release.env | cut -d= -f2-)
sudo docker run --rm --network none --entrypoint sha256sum "$API_IMAGE" \
  /app/prisma/migrations/20261019090000_dispatcher_cancellation_outcomes/migration.sql \
  /app/prisma/preflight/dispatcher-cancellation-121.sql
```

Abort unless the first two values match the reviewed PR commit and the image prints `4972e792…74b539441acc65886f95702afb6b7d21c844c738b38611ae674` and `75e18ab1…c52f57329a59e7620d74f904c`. Also confirm management access, free disk space, TLS and a retained, compatible installed release. Announce the freeze.

### 2. Stop writers, keep the database running

```sh
sudo systemctl is-enabled tayyn-backup.timer        # record the state privately
sudo systemctl stop tayyn-backup.timer
sudo systemctl is-active tayyn-backup.service       # wait until inactive/failed
sudo $CURRENT_COMPOSE stop proxy web api
sudo docker ps --filter label=com.docker.compose.project=tayyn-production --format '{{.Names}}'   # only the db
```

Do not use the new Compose file for `up`, `down` or `stop`. Its DB container labels identify the installed target.

### 3. Pre-migration inspection and counts (read-only)

```sh
sudo $RESET --stage installed-pre-migration --write-preservation-snapshot $PRIV/installed-preservation.json
```

Require exit 0 and `catalog_sha256` `c843370c…d6957c3`. Save the printed counts/digests privately. Run the [count query](#count-verification) as well. Abort on any refusal.

### 4. Pre-migration backup and owner restore rehearsal

```sh
sudo python3 /opt/tayyn/operations.py --config /etc/tayyn/operations.json backup   # prints {"backup": "<file>"}
sudo install -d -m 0700 /var/lib/tayyn/pre-reset-1.21
sudo install -m 0600 /var/lib/tayyn/backups/BACKUP_FILE /var/lib/tayyn/pre-reset-1.21/
sudo sha256sum /var/lib/tayyn/pre-reset-1.21/BACKUP_FILE; sudo stat -c %s /var/lib/tayyn/pre-reset-1.21/BACKUP_FILE
```

The backup directory in `/etc/tayyn/operations.json` is authoritative; use the exact printed filename. On the monitor, run `sudo systemctl start tayyn-backup-relay.service` and confirm the same size and SHA-256. Copy that file to a protected location outside relay retention. Copy it to owner-only workstation storage and confirm the hash there. On the owner workstation only, restore into an owned tmpfs PostgreSQL 17 project. Use a `tayyn-reset-rehearsal-*` project and a `tayyn_restore_*` database with no published port:

```sh
python3 FINAL_SOURCE/scripts/production/operations.py --config /PRIVATE/restore-operations.json restore \
  --archive /PRIVATE/BACKUP_FILE --identity /PRIVATE/OWNER.agekey --database tayyn_restore_premigration_UNIQUE
```

On that restored copy, rehearse the final migration, final-stage inspection, reset and rollback. A synthetic test database does not satisfy this gate. The age identity never leaves the workstation.

### 5. Read-only migration preflight on production

```sh
sudo docker run --rm --network none --entrypoint cat "$API_IMAGE" /app/prisma/preflight/dispatcher-cancellation-121.sql \
  | sudo $CURRENT_COMPOSE exec -T db psql -X -v ON_ERROR_STOP=1 -U tayyn -d tayyn
```

It runs `BEGIN READ ONLY ... ROLLBACK`. Any `LEGACY_FUNDING_AMBIGUOUS` error means stop. Do not migrate; see the [exceptional path](#exceptional-pre-migration-reset).

### 6. Migration only, with writers stopped

```sh
sudo flock -n /run/lock/tayyn-deploy.lock \
  docker compose --project-name tayyn-production \
  --env-file /etc/tayyn/app.env --env-file $REL/release.env \
  -f $REL/deploy/production/compose.production.yaml \
  run --rm --no-deps --pull never migrate
```

This runs no seed, starts no API and does not switch `current`. A non-zero exit or any Prisma error is a stop condition. Keep writers stopped, do not reset, do not resolve the migration, and do not restart the old API. The migration's own transaction rolls back schema and ledger, but Prisma may still record a failed history row; escalate for review. On success:

```sh
sudo $RESET --stage final-1.21    # read-only
```

Require exit 0 and `catalog_sha256` `05cb51e5…474607c0`. This proves all 29 migrations finished with pinned checksums, together with one admin and nine regions. Compare `preservation_sha256` for `users`, `admins`, `districts`, `settings` and `geocoder_budget`, plus `sequence_sha256` and `geometry_sha256`, against step 3. Only `_prisma_migrations` may differ, by the one expected row.

### 7. Post-migration backup, snapshot and manifest

Repeat step 4's backup, protection, relay and owner copy for a NEW archive. Keep the pre-migration archive as well. Then save the final-stage snapshot that execution will bind:

```sh
sudo $RESET --stage final-1.21 --write-preservation-snapshot $PRIV/final-preservation.json
```

Restore this exact archive on the owner workstation and compare its final-stage snapshot. Rehearse reset and rollback there. Then write `$PRIV/final-backup-manifest.json` (mode 0600) using the [1.20 manifest structure](production-reset-1.20.md#backup-manifest-format) with these changes:

- `purpose` is `rollout-1.21-pre-reset`, and `stage` is `final-1.21`.
- `migration_sha256` is `4972e792bb96f74b539441acc65886f95702afb6b7d21c844c738b38611ae674`.
- `archive.path` is the post-migration ciphertext in `/var/lib/tayyn/pre-reset-1.21/`.
- `snapshot_sha256` is the `snapshot_sha256` printed by the snapshot command.
- `target.current_release` is the installed release that `/opt/tayyn/current` still resolves to.

The manifest must be at most two hours old when execution starts. Mark `success`/`rollback_rehearsed` true only after doing the check. Then compute both file hashes:

```sh
sudo sha256sum $PRIV/final-preservation.json $PRIV/final-backup-manifest.json
```

These file hashes include the trailing newline and differ from the canonical `snapshot_sha256`.

### 8. Execute the final-stage reset once

```sh
sudo $RESET --stage final-1.21 --execute-reset \
  --preservation-snapshot $PRIV/final-preservation.json --snapshot-sha256 SNAPSHOT_FILE_SHA256 \
  --backup-manifest $PRIV/final-backup-manifest.json --backup-manifest-sha256 MANIFEST_FILE_SHA256
```

Exit 0 prints post-commit counts and digests. `Reset refused or transaction rolled back:` means nothing was deleted; fix the cause with fresh evidence. `RESET COMMITTED; keep writers stopped; post-check failed:` means do not rerun; investigate the committed state.

### 9. Verify before any start or login, then start

```sh
sudo $RESET --stage final-1.21    # read-only
```

Require all 17 operational counts to be 0, `users`=1, `admins`=1, `districts`=9 and `_prisma_migrations`=29. `preservation_sha256`, `region_sha256`, `geometry_sha256`, `sequence_sha256` and `catalog_sha256` must equal the step 7 output. Run the [count query](#count-verification). Then start through the standard updater, never with `--initialize`:

```sh
sudo python3 $REL/scripts/production/apply-release.py --bundle $REL \
  --env-file /etc/tayyn/app.env --operations-config /etc/tayyn/operations.json
sudo systemctl start tayyn-backup.timer   # only if it was enabled in step 2
```

Its migration pass must be a no-op, and its backup is POST-RESET. It is not the recovery original. Validate release/image identity, HTTPS health, the existing admin login, Socket.IO and the nine regions. Login legitimately creates one refresh token and updates login timestamps. Record that separately and do not reset again. Retain both protected originals through the recovery window.

## Count verification

Run this privately with writers stopped, before and after reset:

```sh
sudo $CURRENT_COMPOSE exec -T db psql -X -U tayyn -d tayyn -v ON_ERROR_STOP=1 <<'SQL'
BEGIN READ ONLY;
SELECT count(*) AS users, count(*) FILTER (WHERE role='ADMIN') AS admin_users FROM users;
SELECT (SELECT count(*) FROM admins) AS admins, (SELECT count(*) FROM districts) AS districts;
SELECT count(*) AS unfinished_migrations FROM _prisma_migrations WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL;
SELECT 'driver_activity_audits', count(*) FROM driver_activity_audits UNION ALL SELECT 'notification_deliveries', count(*) FROM notification_deliveries
UNION ALL SELECT 'notification_installations', count(*) FROM notification_installations UNION ALL SELECT 'native_shift_leases', count(*) FROM native_shift_leases
UNION ALL SELECT 'driver_devices', count(*) FROM driver_devices UNION ALL SELECT 'driver_locations', count(*) FROM driver_locations
UNION ALL SELECT 'driver_address_state', count(*) FROM driver_address_state UNION ALL SELECT 'messages', count(*) FROM messages
UNION ALL SELECT 'notifications', count(*) FROM notifications UNION ALL SELECT 'order_resolution_audits', count(*) FROM order_resolution_audits
UNION ALL SELECT 'order_assignments', count(*) FROM order_assignments UNION ALL SELECT 'transactions', count(*) FROM transactions
UNION ALL SELECT 'orders', count(*) FROM orders UNION ALL SELECT 'vehicles', count(*) FROM vehicles UNION ALL SELECT 'drivers', count(*) FROM drivers
UNION ALL SELECT 'balances', count(*) FROM balances UNION ALL SELECT 'refresh_tokens', count(*) FROM refresh_tokens;
SELECT last_value, is_called FROM order_number_seq;
ROLLBACK;
SQL
```

Do not call `nextval` on production.

## Abort gates

- **Before downtime:** abort on a bundle, signature, image or pin mismatch, insufficient disk/TLS/access, or a non-matching migration/preflight hash.
- **After stopping writers, before migration:** abort if any guard or count check fails, if the backup, relay, owner copy, owner restore or rehearsal fails, or if the preflight raises. Restart the installed release with `sudo $CURRENT_COMPOSE up -d --pull never --no-deps api web proxy`, then restore the timer state.
- **During or after migration:** stop on any migration failure or a final-stage inspection mismatch. Keep writers stopped. The migration is not undone by a later reset failure. Restarting the old API after migration needs a specifically verified compatible image. The new CHECK rejects HELD, so the old hold-producing API is not compatible.
- **During reset:** a refusal or rollback leaves rows untouched; take fresh evidence before any retry. `RESET COMMITTED` means do not rerun.
- **Restoring a database** is a separate destructive recovery decision. Prove the chosen archive (pre-migration, post-migration/pre-reset or post-reset) in a new isolated database first. Never restore automatically over new activity.

## Exceptional pre-migration reset

Use only when the exact owner-restored PRE-MIGRATION archive demonstrates the final migration's `LEGACY_FUNDING_AMBIGUOUS` preflight, and a separately reviewed reset-first rehearsal succeeds. Do not first attempt the migration on production. If production migration has failed or Prisma records an unfinished/failed migration, stop and investigate. This tool refuses that history in both stages. Never weaken the migration preflight or blindly reset after a migration error.

Execution with `--stage installed-pre-migration` uses the backup from step 4, whose manifest has `stage: installed-pre-migration`. It also requires a private evidence file and its SHA-256:

```text
--legacy-ambiguity-evidence /PRIVATE/legacy-ambiguity.json
--legacy-ambiguity-evidence-sha256 EVIDENCE_FILE_SHA256
```

The evidence JSON requires `format: 1`, `purpose: "release-1.21-owner-restored-legacy-ambiguity"` and `host: "owner-workstation"`. It must carry the exact canonical `snapshot_sha256`, the installed `catalog_sha256`, the final `migration_sha256`, and an `archive_sha256` matching the verified backup manifest. It names the isolated restore `project` and `database`. It needs these verified booleans: `historical_ambiguity_proven: true`, `production_migration_attempted: false`, `migration_after_reset_succeeded: true`, `rollback_rehearsed: true`.

After the approved installed-stage reset, require zero operational rows and run step 6 (migration only) while writers remain stopped. Then inspect using `--stage final-1.21`. Compare full preserved rows across the migration, allowing only the expected additional successful `_prisma_migrations` row. Then continue with step 9. There is no automatic fallback or automatic migration in the reset command.

## Disposable verification

```sh
TAYYN_PRODUCTION_RESET_DRILL=1 python3 -m unittest discover \
  -s scripts/tests -p 'test_production_reset*.py' -v
```

The new suite calls the public CLI against actual migrated PostgreSQL 17 databases in owned tmpfs containers, without network access or shared database URLs. It verifies:

- both pinned stages and policy pins against the checked-in migration bytes;
- refusal of unpinned or inconsistent policies;
- read-only inspection;
- exact admin credential rows and edited saved geometry;
- all 17 zero counts including audits;
- sequence continuation and idempotency;
- rejection of unknown catalogs (including dropped CHECK/unique index and changed defaults/enums), wrong stages and wrong or failed migration history;
- rejection of 0 or 2 admins, broken linkage, and 8 or 10 regions or renamed regions;
- stale evidence and active clients;
- the reset-first-then-migrate path.

A Docker transport fault injects a real server error after deletion and before commit, proving complete rollback through the CLI. The frozen 1.20 tests still run independently and still reject the audit schema.

The immutable SQL under `scripts/tests/fixtures/release121-cancellation-migration.sql` is a byte-exact copy of the reviewed backend migration at `d314749`, used only for standalone reset testing. When the actual backend migration exists in an integrated checkout, tests require byte equality with this fixture and the policy checksum. The operational reset tool never executes it.
