"""Public CLI contract; all writes stay in a uniquely owned tmpfs PostgreSQL17.

TAYYN_PRODUCTION_RESET_DRILL=1 python3 -m unittest discover -s scripts/tests -p test_production_reset_121.py -v
"""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'scripts/production/reset-release-1.21.py'
POLICY = json.loads((ROOT / 'deploy/production/rollout-1.21-reset-policy.json').read_text())
ENABLED = os.environ.get('TAYYN_PRODUCTION_RESET_DRILL') == '1'
MIGRATION_NAME = '20261019090000_dispatcher_cancellation_outcomes'
MIGRATION_FIXTURE = ROOT / 'scripts/tests/fixtures/release121-cancellation-migration.sql'


def sha(value):
    return hashlib.sha256(value).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def private_file(path, value):
    path.write_bytes(canonical(value) + b'\n')
    path.chmod(0o600)
    return sha(path.read_bytes())


def cli(*args, env=None):
    return subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True, timeout=300, env=env)


class StageCliTests(unittest.TestCase):
    def test_stage_is_required_before_any_connection(self):
        result = cli('--target', 'isolated', '--project', 'x')
        self.assertEqual(result.returncode, 2)
        self.assertIn('--stage', result.stderr)

    def test_production_execution_needs_backup_before_connection(self):
        result = cli('--stage', 'final-1.21', '--target', 'production', '--project', 'tayyn-production',
                     '--execute-reset', '--preservation-snapshot', '/nonexistent')
        self.assertEqual(result.returncode, 2)
        self.assertIn('pinned verified backup', result.stderr)

    def test_premigration_execution_needs_owner_evidence_before_connection(self):
        result = cli('--stage', 'installed-pre-migration', '--target', 'isolated', '--project', 'x',
                     '--execute-reset', '--preservation-snapshot', '/nonexistent')
        self.assertEqual(result.returncode, 2)
        self.assertIn('owner-restored ambiguity evidence', result.stderr)

    def test_shared_target_is_refused(self):
        result = cli('--stage', 'final-1.21', '--target', 'isolated', '--project', 'tayyn-zone-test',
                     '--container', 'unused', '--database', 'tayyn_reset_wrong')
        self.assertEqual(result.returncode, 2)
        self.assertIn('Isolated project', result.stderr)

    def test_policy_pins_checked_in_history_and_reviewed_final_migration(self):
        self.assertEqual(POLICY['final_backend_commit'], 'd314749c7135f5369ecccde88b3b39f072bcb30a')
        self.assertEqual(POLICY['final_migration_sha256'], '4972e792bb96f74b539441acc65886f95702afb6b7d21c844c738b38611ae674')
        self.assertEqual(sha(MIGRATION_FIXTURE.read_bytes()), POLICY['final_migration_sha256'])
        installed, final = POLICY['schemas']
        checked_in = [[p.parent.name, sha(p.read_bytes())]
                      for p in sorted((ROOT / 'backend/prisma/migrations').glob('*/migration.sql'))
                      if p.parent.name < MIGRATION_NAME]
        self.assertEqual(installed['migrations'], checked_in)
        self.assertEqual(len(installed['migrations']), 28)
        self.assertEqual(final['migrations'], checked_in + [[MIGRATION_NAME, POLICY['final_migration_sha256']]])

    def test_unpinned_or_inconsistent_policy_is_refused_before_connection(self):
        def pending_final(p):
            p['schemas'][1]['catalog_sha256'] = 'PENDING'

        def pending_migration(p):
            p['final_migration_sha256'] = 'PENDING'

        def final_history_missing_migration(p):
            p['schemas'][1]['migrations'].pop()

        def installed_history_claims_final(p):
            p['schemas'][0]['migrations'] = p['schemas'][1]['migrations']

        def stages_share_catalog(p):
            p['schemas'][1]['catalog_sha256'] = p['schemas'][0]['catalog_sha256']

        for change, message in [(pending_final, 'not fully pinned'), (pending_migration, 'not fully pinned'),
                                (final_history_missing_migration, 'inconsistent'),
                                (installed_history_claims_final, 'inconsistent'), (stages_share_catalog, 'inconsistent')]:
            with self.subTest(change=change.__name__), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / 'scripts/production').mkdir(parents=True)
                (root / 'deploy/production').mkdir(parents=True)
                shutil.copy(SCRIPT, root / 'scripts/production' / SCRIPT.name)
                policy = json.loads(json.dumps(POLICY))
                change(policy)
                (root / 'deploy/production/rollout-1.21-reset-policy.json').write_text(json.dumps(policy))
                result = subprocess.run([sys.executable, str(root / 'scripts/production' / SCRIPT.name), '--stage', 'final-1.21',
                                         '--target', 'isolated', '--project', 'tayyn-reset-rehearsal-policy',
                                         '--database', 'tayyn_reset_policy', '--container', 'tayyn-reset-rehearsal-absent'],
                                        capture_output=True, text=True, timeout=60)
                self.assertEqual(result.returncode, 2)
                self.assertIn(message, result.stderr)


@unittest.skipUnless(ENABLED, 'Opt-in owned tmpfs PostgreSQL reset drill')
class StagedResetDrillTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from production_reset_fixture import Cluster, FIXTURE, ROLLOUT_FIXTURE
        cls.cluster = Cluster()
        try:
            # The old 1.20 fixture cutoff is deliberate and remains untouched.
            cls.cluster.database('tayyn_tpl_installed')
            fixture = FIXTURE.replace(" ('admin-two','ADMIN','+99360000102','synthetic-hash-B','Blocked admin',11,'BLOCKED','2026-10-02'),\n", '')
            fixture = fixture.replace(",('admin-b','admin-two','FINANCE')", '').replace('admin-two', 'admin-one').replace('admin-b', 'admin-a')
            cls.cluster.sql(fixture + ROLLOUT_FIXTURE, 'tayyn_tpl_installed')
            cls.cluster.sql("UPDATE orders SET offer_attempt_id='attempt-a'; UPDATE drivers SET district_id=NULL; UPDATE orders SET district_id=NULL; DELETE FROM districts;", 'tayyn_tpl_installed')
            regions = json.loads((ROOT / 'backend/prisma/data/default-regions.json').read_text())['regions']
            for region in regions:
                # Saved polygons are intentionally different from bootstrap, to prove no reseeding.
                row = dict(id=region['id'], name=region['name'], boundary=[[[37, 58], [37, 59], [38, 58]]])
                encoded = json.dumps(row, ensure_ascii=False).replace("'", "''")
                cls.cluster.sql("INSERT INTO districts(id,name,center_lat,center_lng,boundary) SELECT j->>'id',j->>'name',37,58,j->'boundary' FROM (SELECT '" + encoded + "'::jsonb j) t;", 'tayyn_tpl_installed')
            audit = ROOT / 'backend/prisma/migrations/20261018200000_driver_activity_audits/migration.sql'
            cls.apply(audit, 'tayyn_tpl_installed', 'audit')
            cls.cluster.sql("INSERT INTO driver_activity_audits(id,driver_id,actor_id,driver_name,action) VALUES ('explicit-audit','driver-a','admin-one','Synthetic driver','APPROVED');", 'tayyn_tpl_installed')
            cls.cluster.clone('tayyn_tpl_installed', 'tayyn_tpl_final')
            if sha(MIGRATION_FIXTURE.read_bytes()) != POLICY['final_migration_sha256']:
                raise AssertionError('Reviewed final migration fixture is not pinned')
            actual = ROOT / 'backend/prisma/migrations' / MIGRATION_NAME / 'migration.sql'
            if actual.exists() and actual.read_bytes() != MIGRATION_FIXTURE.read_bytes():
                raise AssertionError('Integrated backend migration differs from reviewed reset pin')
            cls.apply(MIGRATION_FIXTURE, 'tayyn_tpl_final', 'final', name=MIGRATION_NAME)
        except BaseException:
            cls.cluster.close()
            raise

    @classmethod
    def apply(cls, path, database, key, name=None):
        content = path.read_text()
        name = name or path.parent.name
        cls.cluster.sql(content, database)
        cls.cluster.sql("INSERT INTO _prisma_migrations(id,checksum,migration_name,finished_at,applied_steps_count) VALUES ('" + key + "','" + sha(content.encode()) + "','" + name + "',now(),1);", database)

    @classmethod
    def tearDownClass(cls):
        cls.cluster.close()

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.databases = []

    def tearDown(self):
        for database in self.databases:
            self.cluster.sql('DROP DATABASE ' + database + ' WITH (FORCE)')
        self.directory.cleanup()

    def fresh(self, stage='final-1.21'):
        database = 'tayyn_reset_' + secrets.token_hex(6)
        self.cluster.clone('tayyn_tpl_final' if stage == 'final-1.21' else 'tayyn_tpl_installed', database)
        self.databases.append(database)
        return database

    def args(self, database, stage='final-1.21'):
        return ['--target', 'isolated', '--project', self.cluster.project, '--database', database,
                '--container', self.cluster.container, '--stage', stage]

    def state(self, database):
        tables = ['users', 'admins', 'districts', '_prisma_migrations', 'settings', 'geocoder_budget',
                  'driver_activity_audits', 'notification_deliveries', 'notification_installations', 'native_shift_leases',
                  'driver_devices', 'driver_locations', 'driver_address_state', 'messages', 'notifications',
                  'order_resolution_audits', 'order_assignments', 'transactions', 'orders', 'vehicles', 'drivers',
                  'balances', 'refresh_tokens']
        return {t: self.cluster.sql('SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),\'[]\'::jsonb) FROM "' + t + '" t', database).strip() for t in tables} | {
            'sequence': self.cluster.sql('SELECT last_value,is_called FROM order_number_seq', database)}

    def snapshot(self, database, stage='final-1.21'):
        path = self.root / (database + '-' + secrets.token_hex(3) + '.json')
        result = cli(*self.args(database, stage), '--write-preservation-snapshot', str(path))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        return path, json.loads(result.stdout)

    def execute(self, database, path, stage='final-1.21', *extra, env=None):
        return cli(*self.args(database, stage), '--execute-reset', '--preservation-snapshot', str(path),
                   '--snapshot-sha256', sha(path.read_bytes()), *extra, env=env)

    def evidence(self, path):
        snapshot = json.loads(path.read_text())
        evidence = {'format': 1, 'purpose': 'release-1.21-owner-restored-legacy-ambiguity', 'host': 'owner-workstation',
                    'snapshot_sha256': sha(canonical(snapshot)), 'migration_sha256': POLICY['final_migration_sha256'],
                    'catalog_sha256': sha(canonical(snapshot['catalog'])), 'historical_ambiguity_proven': True,
                    'production_migration_attempted': False, 'migration_after_reset_succeeded': True, 'rollback_rehearsed': True,
                    'project': 'tayyn-reset-rehearsal-owner', 'database': 'tayyn_restore_owner', 'archive_sha256': 'a' * 64}
        target = self.root / ('ambiguity-' + secrets.token_hex(3) + '.json')
        checksum = private_file(target, evidence)
        return ['--legacy-ambiguity-evidence', str(target), '--legacy-ambiguity-evidence-sha256', checksum]

    def test_both_pinned_stages_report_without_writes_and_reset_idempotently(self):
        for stage in ('installed-pre-migration', 'final-1.21'):
            with self.subTest(stage=stage):
                database = self.fresh(stage)
                before = self.state(database)
                path, report = self.snapshot(database, stage)
                self.assertEqual(self.state(database), before)
                self.assertEqual(report['counts']['driver_activity_audits'], 1)
                self.assertEqual(len(report['geometry_sha256']), 9)
                variant = next(v for v in POLICY['schemas'] if v['name'] == stage)
                self.assertEqual(report['catalog_sha256'], variant['catalog_sha256'])
                for _ in range(2):
                    extra = self.evidence(path) if stage == 'installed-pre-migration' else []
                    result = self.execute(database, path, stage, *extra)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    after = json.loads(result.stdout)
                    self.assertEqual(after['preservation_sha256'], report['preservation_sha256'])
                    self.assertEqual(after['geometry_sha256'], report['geometry_sha256'])
                    self.assertEqual(after['region_sha256'], report['region_sha256'])
                    self.assertEqual(after['sequence_sha256'], report['sequence_sha256'])
                    self.assertEqual(after['counts']['users'], 1)
                    for table in variant['delete']:
                        self.assertEqual(after['counts'][table], 0, table)
                    for secret in ('synthetic-hash', 'Synthetic driver', '+99360000101', 'provider-safety', 'synthetic-lease'):
                        self.assertNotIn(secret, result.stdout + result.stderr)
                    path, _ = self.snapshot(database, stage)
                state = self.state(database)
                for table in ('admins', 'districts', '_prisma_migrations', 'settings', 'geocoder_budget', 'sequence'):
                    self.assertEqual(state[table], before[table], table)
                self.assertEqual(json.loads(state['users'])[0], json.loads(before['users'])[0])
                self.assertEqual(self.cluster.sql("SELECT nextval('order_number_seq')", database).strip(), '74')

    def test_nested_multiple_rings_preserve_complete_saved_rows(self):
        database = self.fresh()
        self.cluster.sql("UPDATE districts SET boundary='[[[-90,-180],[0.125,180],[90,0],[-90,-180]],[[1,2],[2,3],[3,4]]]'::jsonb", database)
        before = self.state(database)
        path, report = self.snapshot(database)
        self.assertEqual(self.state(database), before)
        result = self.execute(database, path)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['geometry_sha256'], report['geometry_sha256'])
        after = self.state(database)
        for table in ('admins', 'districts', '_prisma_migrations', 'settings', 'geocoder_budget', 'sequence'):
            self.assertEqual(after[table], before[table], table)
        self.assertEqual(json.loads(after['users']), [row for row in json.loads(before['users']) if row['role'] == 'ADMIN'])

    def test_missing_or_malformed_geometry_refuses_inspection_and_reset_without_writes(self):
        database = self.fresh()
        path, _ = self.snapshot(database)
        for boundary in (
            'null', '[]', '[[]]', '[[[1,2],[2,3]]]',
            '[[1,2],[2,3],[3,4]]',
            '{"type":"Polygon","coordinates":[[[1,2],[2,3],[3,4]]]}',
            '[[[1,2],[2,3],null]]', '[[[1,2],[2,3],[3]]]',
            '[[[1,2],[2,3],[3,4,5]]]', '[[[1,2],[2,3],[true,4]]]',
            '[[[1,2],[2,3],["3",4]]]', '[[[1,2],[2,3],[91,4]]]',
            '[[[1,2],[2,3],[3,-181]]]', '[[[1,2],[2,3],[1e400,4]]]',
            '[[[1,2],[2,3],[3,4]],[]]',
        ):
            with self.subTest(boundary=boundary):
                self.cluster.sql("UPDATE districts SET boundary='" + boundary + "'::jsonb WHERE id=(SELECT id FROM districts LIMIT 1)", database)
                before = self.state(database)
                for result in (cli(*self.args(database)), self.execute(database, path)):
                    self.assertEqual(result.returncode, 2, result.stderr)
                    self.assertIn('Every saved region must already have polygon geometry', result.stderr)
                self.assertEqual(self.state(database), before)

    def test_reviewed_premigration_fallback_migrates_to_empty_final_schema(self):
        database = self.fresh('installed-pre-migration')
        self.cluster.sql("INSERT INTO transactions(id,balance_id,order_id,type,amount,balance_after) VALUES ('ambiguous-payment','balance-driver','order-a','PAYMENT',-1,99)", database)
        before = self.state(database)
        # Model the owner's restored copy: the real migration fails its read-only
        # preflight and PostgreSQL rolls back, leaving the installed state intact.
        with self.assertRaises(subprocess.CalledProcessError):
            self.cluster.sql(MIGRATION_FIXTURE.read_text(), database)
        self.assertEqual(self.state(database), before)
        path, report = self.snapshot(database, 'installed-pre-migration')
        result = self.execute(database, path, 'installed-pre-migration', *self.evidence(path))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.apply(MIGRATION_FIXTURE, database, 'final', name=MIGRATION_NAME)
        _, after = self.snapshot(database, 'final-1.21')
        for table in ('users', 'admins', 'districts', 'settings', 'geocoder_budget'):
            self.assertEqual(after['preservation_sha256'][table], report['preservation_sha256'][table])
        self.assertEqual(after['geometry_sha256'], report['geometry_sha256'])
        self.assertEqual(after['sequence_sha256'], report['sequence_sha256'])
        final = next(v for v in POLICY['schemas'] if v['name'] == 'final-1.21')
        for table in final['delete']:
            self.assertEqual(after['counts'][table], 0, table)
        self.assertEqual(after['counts']['_prisma_migrations'], 29)

    def test_wrong_stage_refuses_without_changes(self):
        for stage, wrong in [('installed-pre-migration', 'final-1.21'), ('final-1.21', 'installed-pre-migration')]:
            database = self.fresh(stage)
            before = self.state(database)
            result = cli(*self.args(database, wrong))
            self.assertEqual(result.returncode, 2)
            self.assertIn('wrong stage', result.stderr)
            self.assertEqual(self.state(database), before)

    def test_unexpected_catalog_is_rejected_including_same_columns(self):
        for sql in ('CREATE TABLE unexpected(id int)', 'CREATE SCHEMA hidden',
                    'ALTER TABLE orders DROP CONSTRAINT orders_cancellation_outcome_check',
                    'DROP INDEX transactions_assignment_id_type_key',
                    "ALTER TYPE \"Role\" ADD VALUE 'EXTRA'",
                    'ALTER TABLE drivers ALTER COLUMN is_online SET DEFAULT true'):
            with self.subTest(sql=sql):
                database = self.fresh()
                self.cluster.sql(sql, database)
                before = self.state(database)
                result = cli(*self.args(database))
                self.assertEqual(result.returncode, 2)
                self.assertEqual(self.state(database), before)

    def test_wrong_admin_regions_or_migration_history_refuse(self):
        for sql in ("INSERT INTO users(id,role,phone,password_hash,full_name,updated_at) VALUES ('extra','ADMIN','+99360000199','hash','Extra',now()); INSERT INTO admins(id,user_id) VALUES ('extra','extra')",
                    'DELETE FROM admins', "DELETE FROM admins; UPDATE users SET role='DRIVER' WHERE role='ADMIN'",
                    "UPDATE districts SET name='Unexpected' WHERE id=(SELECT id FROM districts LIMIT 1)",
                    'DELETE FROM districts WHERE id=(SELECT id FROM districts LIMIT 1)',
                    "INSERT INTO districts(id,name,center_lat,center_lng,boundary) VALUES ('tenth-region','Tenth',37,58,'[[[37,58],[37,59],[38,58]]]')",
                    "UPDATE districts SET boundary='null'::jsonb WHERE id=(SELECT id FROM districts LIMIT 1)",
                    "UPDATE _prisma_migrations SET finished_at=NULL WHERE migration_name='" + MIGRATION_NAME + "'",
                    "UPDATE _prisma_migrations SET checksum=repeat('0',64) WHERE migration_name='" + MIGRATION_NAME + "'"):
            with self.subTest(sql=sql):
                database = self.fresh()
                self.cluster.sql(sql, database)
                before = self.state(database)
                self.assertEqual(cli(*self.args(database)).returncode, 2)
                self.assertEqual(self.state(database), before)

    def test_installed_stage_refuses_a_recorded_failed_final_migration(self):
        # A failed Prisma deploy leaves an unfinished history row outside the migration's own transaction.
        database = self.fresh('installed-pre-migration')
        self.cluster.sql("INSERT INTO _prisma_migrations(id,checksum,migration_name,logs,applied_steps_count) VALUES ('failed','"
                         + POLICY['final_migration_sha256'] + "','" + MIGRATION_NAME + "','LEGACY_FUNDING_AMBIGUOUS',0)", database)
        before = self.state(database)
        for stage in ('installed-pre-migration', 'final-1.21'):
            with self.subTest(stage=stage):
                self.assertEqual(cli(*self.args(database, stage)).returncode, 2)
                self.assertEqual(self.state(database), before)

    def test_snapshot_tamper_stale_credentials_and_geometry_refuse(self):
        for sql in ("UPDATE users SET password_hash='replacement' WHERE role='ADMIN'",
                    "UPDATE districts SET boundary='[[[1,2],[2,3],[3,4]]]'::jsonb WHERE id=(SELECT id FROM districts LIMIT 1)"):
            database = self.fresh()
            path, _ = self.snapshot(database)
            self.cluster.sql(sql, database)
            before = self.state(database)
            result = self.execute(database, path)
            self.assertEqual(result.returncode, 2)
            self.assertIn('differs from', result.stderr)
            self.assertEqual(self.state(database), before)
        database = self.fresh()
        path, _ = self.snapshot(database)
        result = self.execute(database, path, 'final-1.21', '--snapshot-sha256', '0' * 64)
        self.assertEqual(result.returncode, 2)
        self.assertIn('checksum mismatch', result.stderr)

    def test_invalid_premigration_evidence_refuses(self):
        database = self.fresh('installed-pre-migration')
        path, _ = self.snapshot(database, 'installed-pre-migration')
        extra = self.evidence(path)
        evidence = json.loads(Path(extra[1]).read_text())
        evidence['production_migration_attempted'] = True
        extra[3] = private_file(Path(extra[1]), evidence)
        before = self.state(database)
        result = self.execute(database, path, 'installed-pre-migration', *extra)
        self.assertEqual(result.returncode, 2)
        self.assertIn('owner-restored', result.stderr)
        self.assertEqual(self.state(database), before)

    def test_pinned_backup_manifest_requires_stage_migration_and_fresh_restore(self):
        database = self.fresh()
        path, _ = self.snapshot(database)
        snapshot = json.loads(path.read_text())
        inspect = json.loads(subprocess.run(['docker', 'inspect', self.cluster.container], capture_output=True,
                                            text=True, check=True).stdout)[0]
        identity = {'project': self.cluster.project, 'database': database, 'container': inspect['Id'],
                    'database_image': inspect['Image'], 'volume': 'tmpfs', 'current_release': None}
        archive = self.root / 'tayyn-20261019T090000Z-0a1b2c3d.dump.age'
        archive.write_bytes(b'age-encryption.org/v1\n' + secrets.token_bytes(256))
        archive.chmod(0o600)
        checksum = sha(archive.read_bytes())
        copy = {'sha256': checksum, 'size': archive.stat().st_size, 'protected_from_retention': True}
        manifest = {'format': 1, 'purpose': 'rollout-1.21-pre-reset', 'stage': 'final-1.21',
                    'migration_sha256': POLICY['final_migration_sha256'], 'quiesced': True, 'target': identity,
                    'snapshot_sha256': sha(canonical(snapshot)), 'created_at': datetime.now(timezone.utc).isoformat(),
                    'protected_from_retention': True, 'archive': dict(copy, path=str(archive)),
                    'relay': dict(copy, host='tayyn-monitor'), 'owner_copy': dict(copy, host='owner-workstation'),
                    'restore': {'host': 'owner-workstation', 'archive_sha256': checksum,
                                'snapshot_sha256': sha(canonical(snapshot)), 'success': True, 'rollback_rehearsed': True,
                                'project': 'tayyn-reset-rehearsal-owner', 'database': 'tayyn_restore_owner'}}
        manifest_path = self.root / 'manifest.json'
        before = self.state(database)
        for key, value in [('stage', 'installed-pre-migration'), ('migration_sha256', '0' * 64),
                           ('quiesced', False), ('created_at', '2020-01-01T00:00:00+00:00')]:
            bad = dict(manifest, **{key: value})
            checksum = private_file(manifest_path, bad)
            result = self.execute(database, path, 'final-1.21', '--backup-manifest', str(manifest_path),
                                  '--backup-manifest-sha256', checksum)
            self.assertEqual(result.returncode, 2)
            self.assertEqual(self.state(database), before)
        checksum = private_file(manifest_path, manifest)
        result = self.execute(database, path, 'final-1.21', '--backup-manifest', str(manifest_path),
                              '--backup-manifest-sha256', checksum)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_active_client_blocks_deletion(self):
        database = self.fresh()
        path, _ = self.snapshot(database)
        subprocess.run(['docker', 'exec', '-d', self.cluster.container, 'psql', '-U', 'tayyn', '-d', database,
                        '-c', 'SELECT pg_sleep(60)'], check=True)
        try:
            import time
            for _ in range(40):
                if self.cluster.sql("SELECT count(*) FROM pg_stat_activity WHERE datname='" + database + "' AND query='SELECT pg_sleep(60)'", database).strip() == '1':
                    break
                time.sleep(0.05)
            else:
                self.fail('Synthetic client did not connect')
            before = self.state(database)
            result = self.execute(database, path)
            self.assertEqual(result.returncode, 2)
            self.assertIn('Other database clients', result.stderr)
            self.assertEqual(self.state(database), before)
        finally:
            self.cluster.sql("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='" + database + "' AND query='SELECT pg_sleep(60)'", database)

    def test_server_failure_after_deletion_rolls_back_via_public_cli(self):
        database = self.fresh()
        path, _ = self.snapshot(database)
        before = self.state(database)
        # Fault only the external Docker/psql transport. The real server receives
        # a division-by-zero after all DELETE statements and before COMMIT.
        docker = shutil.which('docker')
        shim = self.root / 'docker'
        shim.write_text('#!' + sys.executable + '\nimport os,subprocess,sys\n'
                        'args=sys.argv[1:]\n'
                        'if args[:2]==["exec","-i"]:\n'
                        ' data=sys.stdin.read()\n'
                        ' if "DELETE FROM public." in data:\n'
                        '  data=data.rsplit("COMMIT;",1)[0]+"SELECT 1/0; COMMIT;"\n'
                        ' p=subprocess.run([' + repr(docker) + ']+args,input=data,text=True)\n'
                        ' sys.exit(p.returncode)\n'
                        'os.execv(' + repr(docker) + ',[' + repr(docker) + ']+args)\n')
        shim.chmod(0o700)
        result = self.execute(database, path, env=dict(os.environ, PATH=str(self.root) + os.pathsep + os.environ['PATH']))
        self.assertEqual(result.returncode, 2)
        self.assertIn('rolled back', result.stderr)
        self.assertEqual(self.state(database), before)


if __name__ == '__main__':
    unittest.main()
