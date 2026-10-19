"""Rollout 1.20 reset guards. The database drill is opt-in and uses only an owned tmpfs PostgreSQL:

TAYYN_PRODUCTION_RESET_DRILL=1 python3 -m unittest discover -s scripts/tests -p test_production_reset.py -v
"""
import argparse
import copy
from datetime import datetime, timedelta, timezone
import importlib.util
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'production/reset-rollout.py'
ENABLED = os.environ.get('TAYYN_PRODUCTION_RESET_DRILL') == '1'
SPEC = importlib.util.spec_from_file_location('reset_rollout', SCRIPT)
reset = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(reset)
POLICY = json.loads(reset.POLICY.read_text())
SECRETS = ['+9936000010', 'synthetic-hash', 'synthetic-driver', 'synthetic-admin-token', 'Synthetic exact polygon',
           '58.7654321', 'synthetic-lease', 'Synthetic admin chat', 'provider-safety']


def cli(*arguments):
    return subprocess.run([sys.executable, str(SCRIPT), *arguments], capture_output=True, text=True, timeout=300)


class ResetCliTests(unittest.TestCase):
    def test_missing_explicit_target_cannot_connect_or_reset(self):
        result = cli('--execute-reset')
        self.assertEqual(result.returncode, 2)
        self.assertIn('--target', result.stderr)

    def test_shared_or_ambiguous_targets_are_rejected(self):
        result = cli('--target', 'railway', '--project', 'tayyn-production')
        self.assertEqual(result.returncode, 2)
        self.assertNotIn('postgresql://', result.stdout + result.stderr)

    def test_production_execution_requires_backup_manifest_before_connecting(self):
        result = cli('--target', 'production', '--project', 'tayyn-production', '--execute-reset',
                     '--preservation-snapshot', '/nonexistent', '--snapshot-sha256', '0' * 64)
        self.assertEqual(result.returncode, 2)
        self.assertIn('requires a pinned verified backup manifest', result.stderr)

    def test_production_rejects_other_project_or_compose_directory(self):
        result = cli('--target', 'production', '--project', 'tayyn-zone-test', '--compose-dir', '/opt/tayyn/current/deploy/production')
        self.assertEqual(result.returncode, 2)
        self.assertIn('exact project', result.stderr)

    def test_isolated_rejects_non_rehearsal_names(self):
        for project, database in [('tayyn-production', 'tayyn_reset_x'), ('tayyn-reset-rehearsal-x', 'tayyn')]:
            result = cli('--target', 'isolated', '--project', project, '--database', database, '--container', 'x')
            self.assertEqual(result.returncode, 2)
            self.assertRegex(result.stderr, 'rehearsal|Isolated database')


class PolicyTests(unittest.TestCase):
    def test_policy_lists_each_table_once_and_keeps_preserved_tables(self):
        for variant in POLICY['schemas']:
            self.assertFalse(set(variant['delete']) & set(POLICY['preserve']))
            self.assertEqual(len(variant['delete']), len(set(variant['delete'])))
        self.assertEqual(POLICY['preserve']['users'], "WHERE role='ADMIN'")

    def test_policy_never_truncates_or_touches_sequences(self):
        text = SCRIPT.read_text().upper()
        self.assertNotIn('TRUNCATE', text)
        self.assertNotIn('SETVAL', text)
        self.assertNotIn('RESTART', text)
        self.assertNotIn('DROP ', text)

    def test_unknown_table_names_fail_closed(self):
        catalog = {'relations': [['public', t, 'r', False, False] for t in
                                 set(POLICY['preserve']) | set(POLICY['schemas'][1]['delete']) | {'driver_payouts'}]}
        with self.assertRaisesRegex(ValueError, 'unknown=driver_payouts'):
            reset.check_policy_tables(POLICY, catalog)

    def test_other_schemas_and_views_fail_closed(self):
        base = [['public', t, 'r', False, False] for t in set(POLICY['preserve']) | set(POLICY['schemas'][0]['delete'])]
        for extra in (['audit', 'events', 'r', False, False], ['public', 'driver_view', 'v', False, False]):
            with self.assertRaisesRegex(ValueError, 'Unexpected'):
                reset.check_policy_tables(POLICY, {'relations': base + [extra]})


class BackupManifestTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.archive = Path(self.directory.name) / 'tayyn-20261018T190000Z-0a1b2c3d.dump.age'
        self.archive.write_bytes(b'age-encryption.org/v1\n' + secrets.token_bytes(256))
        self.archive.chmod(0o600)
        self.snapshot = {'format': 1, 'counts': {'orders': 6}}
        self.identity = {'project': 'tayyn-reset-rehearsal-a', 'volume': 'tmpfs'}
        self.manifest = rehearsal_manifest(self.archive, self.snapshot, self.identity)

    def tearDown(self):
        self.directory.cleanup()

    def test_complete_manifest_is_accepted(self):
        reset.verify_backup(self.manifest, self.snapshot, self.identity)

    def test_each_missing_guard_is_rejected(self):
        changes = [
            ('quiesced', False), ('purpose', 'hourly'), ('snapshot_sha256', '0' * 64), ('protected_from_retention', False),
            ('created_at', (datetime.now(timezone.utc) - timedelta(hours=3)).isoformat()),
            ('created_at', (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()),
            ('relay', {'host': 'tayyn-monitor', 'sha256': '0' * 64, 'size': 278, 'protected_from_retention': True}),
            ('restore', dict(self.manifest['restore'], success=False)),
            ('restore', dict(self.manifest['restore'], rollback_rehearsed=False)),
            ('restore', dict(self.manifest['restore'], project='tayyn-production')),
            ('target', dict(self.identity, project='tayyn-production')),
        ]
        for key, value in changes:
            with self.subTest(key=key, value=value):
                with self.assertRaises(ValueError):
                    reset.verify_backup(dict(self.manifest, **{key: value}), self.snapshot, self.identity)

    def test_tampered_or_world_readable_ciphertext_is_rejected(self):
        self.archive.chmod(0o644)
        with self.assertRaises(ValueError):
            reset.verify_backup(self.manifest, self.snapshot, self.identity)
        self.archive.chmod(0o600)
        with self.archive.open('ab') as stream:
            stream.write(b'x')
        with self.assertRaises(ValueError):
            reset.verify_backup(self.manifest, self.snapshot, self.identity)

    def test_production_original_must_be_outside_retention(self):
        identity = dict(self.identity, volume=reset.VOLUME)
        manifest = dict(self.manifest, target=identity)
        with self.assertRaisesRegex(ValueError, 'protected pre-reset directory'):
            reset.verify_backup(manifest, self.snapshot, identity)


def rehearsal_manifest(archive, snapshot, identity):
    digest, size = reset.file_digest(archive), archive.stat().st_size
    copy_ = {'sha256': digest, 'size': size, 'protected_from_retention': True}
    return {'format': 1, 'purpose': 'rollout-1.20-pre-reset', 'quiesced': True, 'target': identity,
            'snapshot_sha256': reset.digest(snapshot), 'created_at': datetime.now(timezone.utc).isoformat(),
            'protected_from_retention': True, 'archive': {'path': str(archive), 'sha256': digest, 'size': size},
            'relay': dict(copy_, host='tayyn-monitor'), 'owner_copy': dict(copy_, host='owner-workstation'),
            'restore': {'host': 'owner-workstation', 'archive_sha256': digest, 'snapshot_sha256': reset.digest(snapshot),
                        'success': True, 'rollback_rehearsed': True,
                        'project': 'tayyn-reset-rehearsal-owner', 'database': 'tayyn_reset_owner'}}


@unittest.skipUnless(ENABLED, 'Opt-in owned tmpfs PostgreSQL reset drill')
class ResetDrillTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from production_reset_fixture import Cluster
        cls.cluster = Cluster()
        try:
            cls.cluster.template('tayyn_tpl_rollout', rollout=True)
            cls.cluster.template('tayyn_tpl_before', rollout=False)
        except BaseException:
            cls.cluster.close()
            raise

    @classmethod
    def tearDownClass(cls):
        cls.cluster.close()

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.addCleanup(self.directory.cleanup)

    def fresh(self, template='tayyn_tpl_rollout'):
        name = 'tayyn_reset_' + secrets.token_hex(4)
        self.cluster.clone(template, name)
        # tmpfs is RAM inside the container's memory limit; drop each copy promptly.
        self.addCleanup(self.cluster.sql, 'DROP DATABASE ' + name + ' WITH (FORCE)')
        return name

    def args(self, database):
        return ['--target', 'isolated', '--project', self.cluster.project, '--database', database,
                '--container', self.cluster.container]

    def database(self, database):
        return reset.Database(argparse.Namespace(target='isolated', project=self.cluster.project, database=database,
                                                 container=self.cluster.container, compose_dir=None))

    def snapshot(self, database):
        path = self.root / (database + '.json')
        result = cli(*self.args(database), '--write-preservation-snapshot', str(path))
        self.assertEqual(result.returncode, 0, result.stderr)
        return path, reset.file_digest(path), json.loads(result.stdout)

    def execute(self, database, path, digest, *extra):
        return cli(*self.args(database), '--execute-reset', '--preservation-snapshot', str(path),
                   '--snapshot-sha256', digest, *extra)

    def rows(self, database, sql):
        return self.cluster.sql(sql, database).strip()

    def full_state(self, database):
        tables = sorted(set(POLICY['preserve']) | set(POLICY['schemas'][1]['delete']))
        return self.rows(database, 'SELECT ' + ' || '.join(
            f"(SELECT md5(COALESCE(string_agg(to_jsonb(t)::text, '' ORDER BY to_jsonb(t)::text), '')) FROM \"{t}\" t)"
            for t in tables) + " || (SELECT last_value::text || is_called::text FROM order_number_seq)")

    def test_both_reviewed_catalogs_match_their_policy_digest(self):
        for template, name in [('tayyn_tpl_before', 'production-before-1.20'), ('tayyn_tpl_rollout', 'rollout-1.20')]:
            catalog = json.loads(self.cluster.sql('BEGIN READ ONLY; ' + reset.CATALOG_SQL + '; COMMIT;', template))
            expected = next(v['catalog_sha256'] for v in POLICY['schemas'] if v['name'] == name)
            self.assertEqual(reset.digest(catalog), expected, f'{name}: schema changed, review reset policy')

    def test_dry_run_reports_counts_and_digests_without_records(self):
        database = self.fresh()
        before = self.full_state(database)
        result = cli(*self.args(database))
        self.assertEqual(result.returncode, 0, result.stderr)
        for value in SECRETS:
            self.assertNotIn(value, result.stdout + result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(report['counts']['users'], 4)
        self.assertEqual(report['counts']['order_assignments'], 1)
        self.assertEqual(set(report['preservation_sha256']), set(POLICY['preserve']))
        self.assertEqual(self.full_state(database), before)

    def test_reset_preserves_admins_regions_state_and_removes_operations(self):
        for template in ('tayyn_tpl_before', 'tayyn_tpl_rollout'):
            with self.subTest(template=template):
                database = self.fresh(template)
                preserved = {t: self.rows(database, f"SELECT string_agg(to_jsonb(t)::text, '|' ORDER BY to_jsonb(t)::text) FROM \"{t}\" t {w}")
                             for t, w in POLICY['preserve'].items()}
                path, digest, dry = self.snapshot(database)
                result = self.execute(database, path, digest)
                self.assertEqual(result.returncode, 0, result.stderr)
                for value in SECRETS:
                    self.assertNotIn(value, result.stdout + result.stderr)
                after = json.loads(result.stdout)
                self.assertEqual(after['preservation_sha256'], dry['preservation_sha256'])
                self.assertEqual(after['sequence_sha256'], dry['sequence_sha256'])
                for table, rows in preserved.items():
                    self.assertEqual(self.rows(database, f"SELECT string_agg(to_jsonb(t)::text, '|' ORDER BY to_jsonb(t)::text) FROM \"{table}\" t {POLICY['preserve'][table]}"), rows, table)
                variant = next(v for v in POLICY['schemas'] if v['name'] == json.loads(path.read_text())['schema'])
                for table in variant['delete']:
                    self.assertEqual(after['counts'][table], 0, table)
                self.assertEqual(self.rows(database, "SELECT string_agg(id, ',' ORDER BY id) FROM users"), 'admin-one,admin-two')
                self.assertEqual(self.rows(database, "SELECT string_agg(password_hash || credential_version || status, ',' ORDER BY id) FROM users"),
                                 'synthetic-hash-A7ACTIVE,synthetic-hash-B11BLOCKED')
                # Human order numbers continue; the reset never reuses them.
                self.assertEqual(self.rows(database, "SELECT nextval('order_number_seq')"), '74')

    def test_reset_with_verified_manifest_succeeds(self):
        database = self.fresh()
        path, digest, _ = self.snapshot(database)
        archive = self.root / 'tayyn-20261018T190000Z-0a1b2c3d.dump.age'
        archive.write_bytes(b'age-encryption.org/v1\n' + secrets.token_bytes(256))
        archive.chmod(0o600)
        manifest = self.root / 'manifest.json'
        reset.private_write(manifest, rehearsal_manifest(archive, json.loads(path.read_text()), self.database(database).identity))
        result = self.execute(database, path, digest, '--backup-manifest', str(manifest),
                              '--backup-manifest-sha256', reset.file_digest(manifest))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.rows(database, 'SELECT count(*) FROM orders'), '0')

    def test_wrong_snapshot_or_manifest_hash_refuses_without_changes(self):
        database = self.fresh()
        path, digest, _ = self.snapshot(database)
        before = self.full_state(database)
        result = self.execute(database, path, '0' * 64)
        self.assertEqual(result.returncode, 2)
        self.assertIn('checksum mismatch', result.stderr)
        self.assertEqual(self.full_state(database), before)

    def test_change_after_snapshot_refuses_without_changes(self):
        for change in ("UPDATE districts SET boundary='[[0,0]]' WHERE id='district-a'",
                       "UPDATE users SET password_hash='changed' WHERE id='admin-one'",
                       "UPDATE geocoder_budget SET attempts=0",
                       "INSERT INTO orders(id,pickup_lat,pickup_lng) VALUES ('late-order',37,58)"):
            with self.subTest(change=change):
                database = self.fresh()
                path, digest, _ = self.snapshot(database)
                self.cluster.sql(change, database)
                before = self.full_state(database)
                result = self.execute(database, path, digest)
                self.assertEqual(result.returncode, 2)
                self.assertIn('differs from the protected pre-reset snapshot', result.stderr)
                self.assertEqual(self.full_state(database), before)

    def test_unknown_table_or_column_fails_closed(self):
        for change, message in (('CREATE TABLE driver_payouts(id text PRIMARY KEY)', 'unknown=driver_payouts'),
                                ('CREATE SCHEMA audit; CREATE TABLE audit.events(id int)', 'Unexpected'),
                                ('ALTER TABLE drivers ADD COLUMN payout_ref text', 'Unknown tables, columns'),
                                ('ALTER TABLE messages ADD CONSTRAINT m_district FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE', 'Unknown tables, columns')):
            with self.subTest(change=change):
                database = self.fresh()
                self.cluster.sql(change, database)
                before = self.full_state(database)
                self.assertIn(message, cli(*self.args(database)).stderr)
                self.assertEqual(self.full_state(database), before)

    def test_later_driver_activity_schema_is_refused_without_changes(self):
        database = self.fresh()
        path, digest, _ = self.snapshot(database)
        migration = SCRIPT.parents[2] / 'backend/prisma/migrations/20261018200000_driver_activity_audits/migration.sql'
        self.cluster.sql(migration.read_text(), database)
        self.cluster.sql("INSERT INTO driver_activity_audits(id,driver_id,actor_id,actor_name,driver_name,action) VALUES ('new-audit','driver-a','admin-one','Dispatcher one','Synthetic driver','APPROVED')", database)
        before = self.full_state(database)
        audit_before = self.rows(database, 'SELECT to_jsonb(t)::text FROM driver_activity_audits t')
        for result in (cli(*self.args(database)), self.execute(database, path, digest)):
            self.assertEqual(result.returncode, 2)
            self.assertIn('unknown=driver_activity_audits', result.stderr)
        self.assertEqual(self.full_state(database), before)
        self.assertEqual(self.rows(database, 'SELECT to_jsonb(t)::text FROM driver_activity_audits t'), audit_before)

    def test_unpaired_admin_identity_refuses_inside_transaction(self):
        database = self.fresh()
        self.cluster.sql("INSERT INTO users(id,role,phone,password_hash,full_name,updated_at) VALUES ('orphan','ADMIN','+99360000199','x','Orphan','2026-10-01')", database)
        path, digest, _ = self.snapshot(database)
        before = self.full_state(database)
        result = self.execute(database, path, digest)
        self.assertEqual(result.returncode, 2)
        self.assertIn('rolled back', result.stderr)
        self.assertEqual(self.full_state(database), before)

    def test_connected_client_refuses_reset(self):
        database = self.fresh()
        path, digest, _ = self.snapshot(database)
        subprocess.run(['docker', 'exec', '-d', self.cluster.container, 'psql', '-U', 'tayyn', '-d', database, '-c', 'SELECT pg_sleep(60)'], check=True)
        try:
            for _ in range(40):
                if self.rows(database, "SELECT count(*) FROM pg_stat_activity WHERE query LIKE 'SELECT pg_sleep%'") == '1':
                    break
            before = self.full_state(database)
            result = self.execute(database, path, digest)
            self.assertEqual(result.returncode, 2)
            self.assertIn('Other database clients remain connected', result.stderr)
            self.assertEqual(self.full_state(database), before)
        finally:
            self.cluster.sql("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query LIKE 'SELECT pg_sleep%'", database)

    def test_failure_after_deletes_rolls_back_every_statement(self):
        database = self.fresh()
        db = self.database(database)
        snapshot = db.snapshot(POLICY)
        broken = copy.deepcopy(POLICY)
        variant = next(v for v in broken['schemas'] if v['name'] == snapshot['schema'])
        # Every messages FK is ON DELETE SET NULL, so omitted chats would survive the later deletes.
        # The final emptiness assertion fails after earlier deletes already ran.
        variant['delete'].remove('messages')
        before = self.full_state(database)
        with self.assertRaises(subprocess.CalledProcessError):
            reset.execute(db, broken, snapshot)
        self.assertEqual(self.full_state(database), before)
        self.assertEqual(self.rows(database, 'SELECT count(*) FROM notification_deliveries'), '1')


if __name__ == '__main__':
    unittest.main()
