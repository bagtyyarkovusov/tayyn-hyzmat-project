#!/usr/bin/env python3
"""Guarded release 1.21 operational reset. Inspection is read-only; no startup hook."""
import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys

POLICY = Path(__file__).resolve().parents[2] / 'deploy/production/rollout-1.21-reset-policy.json'
PROJECT = 'tayyn-production'
VOLUME = 'tayyn-production_postgres-data'
CURRENT = Path('/opt/tayyn/current')
# Outside backup_dir, so neither backup nor relay retention can prune the pre-reset original.
PROTECTED_DIR = Path('/var/lib/tayyn/pre-reset-1.21')


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def file_digest(path):
    result = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def private_read(path, expected_hash):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_mode & 0o077:
        raise ValueError('Evidence must be a regular owner-only file')
    if not re.fullmatch('[0-9a-f]{64}', expected_hash or '') or file_digest(path) != expected_hash:
        raise ValueError('Evidence checksum mismatch')
    return json.loads(path.read_text())


def private_write(path, value):
    # O_EXCL + O_NOFOLLOW refuses overwrite/symlink, including other operators' evidence.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(canonical(value) + b'\n')
        stream.flush()
        os.fsync(stream.fileno())


def run(command, *, input=None, timeout=60):
    # Resolved env, Docker inspect and psql failures may contain secrets. Never echo them.
    return subprocess.run(command, input=input, text=True, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, check=True, timeout=timeout).stdout


def quote(value):
    return "'" + value.replace("'", "''") + "'"


CATALOG_SQL = """SELECT jsonb_build_object(
 'relations', COALESCE((SELECT jsonb_agg(jsonb_build_array(n.nspname,c.relname,c.relkind,c.relrowsecurity,c.relforcerowsecurity) ORDER BY n.nspname,c.relname)
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast|^pg_temp'
 AND c.relkind IN ('r','p','f','m','v','S')), '[]'::jsonb),
 'columns', COALESCE((SELECT jsonb_agg(jsonb_build_array(c.relname,a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attidentity,a.attgenerated) ORDER BY c.relname,a.attnum)
 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relkind IN ('r','p','f','m','v','S') AND a.attnum>0 AND NOT a.attisdropped), '[]'::jsonb),
 'foreign_keys', COALESCE((SELECT jsonb_agg(jsonb_build_array(n.nspname,c.relname,k.conname,pg_get_constraintdef(k.oid),k.convalidated) ORDER BY n.nspname,c.relname,k.conname)
 FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE k.contype='f' AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast|^pg_temp'), '[]'::jsonb),
 'triggers', COALESCE((SELECT jsonb_agg(pg_get_triggerdef(t.oid) ORDER BY pg_get_triggerdef(t.oid)) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
 JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND n.nspname='public'), '[]'::jsonb),
 'rules', COALESCE((SELECT jsonb_agg(r.rulename ORDER BY r.rulename) FROM pg_rewrite r JOIN pg_class c ON c.oid=r.ev_class
 JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'), '[]'::jsonb)
)"""


# Pin defaults, CHECK/UNIQUE/PK constraints, indexes and enums as well as the
# historical relation/column/FK checks. A same-column schema drift must refuse.
CATALOG_SQL += """ || jsonb_build_object(
 'schemas', (SELECT jsonb_agg(nspname ORDER BY nspname) FROM pg_namespace
   WHERE nspname NOT IN ('pg_catalog','information_schema') AND nspname !~ '^pg_toast|^pg_temp'),
 'defaults', COALESCE((SELECT jsonb_agg(jsonb_build_array(c.relname,a.attname,pg_get_expr(d.adbin,d.adrelid)) ORDER BY c.relname,a.attnum)
   FROM pg_attrdef d JOIN pg_class c ON c.oid=d.adrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=d.adnum WHERE n.nspname='public'), '[]'::jsonb),
 'constraints', COALESCE((SELECT jsonb_agg(jsonb_build_array(c.relname,k.conname,k.contype,pg_get_constraintdef(k.oid),k.convalidated) ORDER BY c.relname,k.conname)
   FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'), '[]'::jsonb),
 'indexes', COALESCE((SELECT jsonb_agg(jsonb_build_array(indexname,indexdef) ORDER BY indexname) FROM pg_indexes WHERE schemaname='public'), '[]'::jsonb),
 'index_state', COALESCE((SELECT jsonb_agg(jsonb_build_array(c.relname,i.indisvalid,i.indisready) ORDER BY c.relname)
   FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'), '[]'::jsonb),
 'collations', COALESCE((SELECT jsonb_agg(jsonb_build_array(c.relname,a.attname,a.attcollation::regcollation::text) ORDER BY c.relname,a.attnum)
   FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped AND a.attcollation<>0), '[]'::jsonb),
 'enums', COALESCE((SELECT jsonb_agg(jsonb_build_array(n.nspname,t.typname,e.enumlabel) ORDER BY n.nspname,t.typname,e.enumsortorder)
   FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace JOIN pg_enum e ON e.enumtypid=t.oid
   WHERE n.nspname NOT IN ('pg_catalog','information_schema')), '[]'::jsonb),
 'routines', COALESCE((SELECT jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,p.prokind,CASE WHEN p.prokind IN ('f','p','w') THEN pg_get_functiondef(p.oid) ELSE p.prosrc END) ORDER BY p.oid::regprocedure::text)
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'), '[]'::jsonb),
 'user_types', COALESCE((SELECT jsonb_agg(jsonb_build_array(t.typname,t.typtype) ORDER BY t.typname) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
   LEFT JOIN pg_class c ON c.oid=t.typrelid WHERE n.nspname='public' AND (t.typtype IN ('d','r','m','e') OR c.relkind='c')), '[]'::jsonb),
 'extensions', (SELECT jsonb_agg(jsonb_build_array(extname,extversion) ORDER BY extname) FROM pg_extension),
 'policies', COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY schemaname,tablename,policyname) FROM pg_policies p WHERE schemaname='public'), '[]'::jsonb)
)"""


def assert_sql(expression, message):
    return f"DO $reset$ BEGIN IF ({expression}) IS DISTINCT FROM TRUE THEN RAISE EXCEPTION {quote(message)}; END IF; END $reset$;\n"


def catalog_assert(catalog):
    return assert_sql(f"({CATALOG_SQL}) = {quote(json.dumps(catalog))}::jsonb", 'Reset catalog changed')


def retained_sql(policy):
    expressions = []
    for name, where in policy['preserve'].items():
        expressions += [quote(name), f"(SELECT COALESCE(jsonb_agg(to_jsonb(t)::text ORDER BY to_jsonb(t)::text),'[]'::jsonb) FROM public.\"{name}\" t {where})"]
    return 'SELECT jsonb_build_object(' + ','.join(expressions) + ')'


def sequences_sql():
    # The only allowed sequence is explicit in both reviewed catalog versions.
    # Value and definition only: log_cnt moves with WAL activity, not with order numbering.
    return ("SELECT jsonb_build_object('order_number_seq',(SELECT jsonb_build_object('last_value',s.last_value,'is_called',s.is_called,"
            "'definition',(SELECT to_jsonb(q)-'last_value' FROM pg_sequences q WHERE q.schemaname='public' AND q.sequencename='order_number_seq'))"
            " FROM public.order_number_seq s))")


def counts_sql(tables):
    return 'SELECT jsonb_build_object(' + ','.join(
        f"{quote(t)},(SELECT count(*) FROM public.\"{t}\")" for t in tables) + ')'


class Database:
    def __init__(self, args):
        self.args = args
        self.container = args.container
        self.database = 'tayyn' if args.target == 'production' else args.database
        self.identity = self.verify_target()

    def verify_target(self):
        args = self.args
        if args.target == 'production':
            if args.project != PROJECT or args.database != 'tayyn' or args.compose_dir != CURRENT / 'deploy/production':
                raise ValueError('Production requires the exact project, database and current Compose directory')
            if os.geteuid() != 0:
                raise ValueError('Production inspection/execution runs as root on the production host')
            release = CURRENT.resolve(strict=True)
            if release.parent != Path('/opt/tayyn/releases'):
                raise ValueError('Unexpected current release path')
            command = ['docker', 'compose', '--project-name', PROJECT, '--project-directory', str(args.compose_dir),
                       '--env-file', '/etc/tayyn/app.env', '--env-file', str(CURRENT / 'release.env'),
                       '-f', str(args.compose_dir / 'compose.production.yaml'), 'ps', '-q', 'db']
            db = run(command).strip()
            if not db or '\n' in db:
                raise ValueError('Cannot identify one current production database')
            if self.container and self.container != db:
                raise ValueError('Production database override rejected')
            self.container = db
        else:
            if not re.fullmatch('tayyn-reset-rehearsal-[a-z0-9-]+', args.project):
                raise ValueError('Isolated project must be owned by this reset rehearsal')
            if not re.fullmatch('tayyn_(?:reset|restore)_[a-z0-9_]+', args.database) or not self.container:
                raise ValueError('Isolated database/container required')
            release = None
        data = json.loads(run(['docker', 'inspect', self.container]))[0]
        labels = data['Config'].get('Labels') or {}
        if labels.get('com.docker.compose.project') != args.project or not data['State']['Running']:
            raise ValueError('Database container project/running state mismatch')
        if args.target == 'production':
            if labels.get('com.docker.compose.service') != 'db' or Path(labels.get('com.docker.compose.project.working_dir', '')).resolve() != (release / 'deploy/production'):
                raise ValueError('Production Compose working directory/service mismatch')
            mounts = [m for m in data['Mounts'] if m['Destination'] == '/var/lib/postgresql/data']
            if len(mounts) != 1 or mounts[0].get('Name') != VOLUME or mounts[0]['Type'] != 'volume':
                raise ValueError('Production database volume mismatch')
            volume = json.loads(run(['docker', 'volume', 'inspect', VOLUME]))[0]
            if (volume.get('Labels') or {}).get('com.docker.compose.project') != PROJECT:
                raise ValueError('Production volume project mismatch')
        else:
            mounts = [m for m in data['Mounts'] if m['Destination'] == '/var/lib/postgresql/data']
            if len(mounts) != 1 or mounts[0]['Type'] != 'tmpfs':
                raise ValueError('Rehearsal database must use its own tmpfs, never a shared volume')
        return {'project': args.project, 'database': self.database, 'container': data['Id'],
                'database_image': data['Image'], 'volume': VOLUME if release else 'tmpfs',
                'current_release': str(release) if release else None}

    def quiesced(self):
        self.verify_target()
        running = run(['docker', 'ps', '--quiet', '--no-trunc', '--filter', f'label=com.docker.compose.project={self.args.project}']).split()
        if running != [self.identity['container']]:
            raise ValueError('Stop every project writer; only db may be running')
        if self.args.target == 'production':
            # Hourly backup is a database client; the timer may stay enabled but must not be mid-run.
            state = subprocess.run(['systemctl', 'is-active', 'tayyn-backup.service'], stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, text=True, timeout=15).stdout.strip()
            if state not in ('inactive', 'failed'):
                raise ValueError('Scheduled backup is running; wait for it before reset')
        if self.sql("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'").strip() != '0':
            raise ValueError('Other database clients remain connected')

    def sql(self, sql):
        return run(['docker', 'exec', '-i', self.container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
                    '-U', 'tayyn', '-d', self.database], input="SET timezone='UTC'; SET client_min_messages=warning; SET standard_conforming_strings=on;\n" + sql, timeout=180)

    def snapshot(self, policy):
        variant = next(v for v in policy['schemas'] if v['name'] == self.args.stage)
        catalog = json.loads(self.sql('BEGIN READ ONLY; ' + CATALOG_SQL + '; COMMIT;'))
        check_policy_tables(policy, catalog)
        if digest(catalog) != variant['catalog_sha256']:
            raise ValueError('Unknown catalog or wrong stage; review policy before reset')
        tables = sorted(policy['preserve'].keys() | set(variant['delete']))
        sql = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n' + catalog_assert(catalog)
        sql += retained_sql(policy) + ';\n' + sequences_sql() + ';\n' + counts_sql(tables) + '; COMMIT;'
        retained, sequences, counts = [json.loads(line) for line in self.sql(sql).splitlines()]
        snapshot = {'format': 2, 'policy': policy['id'], 'schema': variant['name'], 'catalog': catalog, 'final_migration_sha256': policy['final_migration_sha256'],
                    'retained': retained, 'sequences': sequences, 'counts': counts}
        verify_preserved(policy, variant, snapshot)
        return snapshot


def has_polygon_geometry(boundary):
    # Match admin districtBoundarySchema: Yandex [lat, lng] rings, not GeoJSON.
    # Inspect only; retained row text and every saved coordinate stay untouched.
    return isinstance(boundary, list) and bool(boundary) and all(
        isinstance(ring, list) and len(ring) >= 3 and all(
            isinstance(point, list) and len(point) == 2 and all(
                type(coordinate) in (int, float) and -limit <= coordinate <= limit and math.isfinite(coordinate)
                for coordinate, limit in zip(point, (90, 180))
            ) for point in ring
        ) for ring in boundary
    )


def verify_preserved(policy, variant, snapshot):
    retained = {name: [json.loads(row) for row in rows] for name, rows in snapshot['retained'].items()}
    users, admins, regions = (retained[t] for t in ('users', 'admins', 'districts'))
    if len(users) != 1 or len(admins) != 1 or admins[0]['user_id'] != users[0]['id']:
        raise ValueError('Exactly one existing ADMIN identity/profile is required')
    if not users[0]['password_hash'] or users[0]['role'] != 'ADMIN':
        raise ValueError('Existing admin credential is required; reset never seeds')
    if sorted([r['id'], r['name']] for r in regions) != policy['canonical_regions']:
        raise ValueError('Exactly nine canonical region identities are required')
    # Existing saved geometry wins over bootstrap defaults, including later owner edits.
    if any(not has_polygon_geometry(r.get('boundary')) for r in regions):
        raise ValueError('Every saved region must already have polygon geometry')
    migrations = retained['_prisma_migrations']
    actual = sorted([m['migration_name'], m['checksum']] for m in migrations)
    if actual != variant['migrations'] or any(m['finished_at'] is None or m['rolled_back_at'] is not None
                                            or m['applied_steps_count'] != 1 for m in migrations):
        raise ValueError('Migration history is incomplete, failed, or differs from pinned stage')


def check_policy_tables(policy, catalog):
    # Table names only; the catalog digest below also pins columns, FKs, triggers and rules.
    tables = {r[1] for r in catalog['relations'] if r[0] == 'public' and r[2] in ('r', 'p')}
    others = sorted(r[0] + '.' + r[1] for r in catalog['relations'] if r[0] != 'public' or r[2] not in ('r', 'p', 'S'))
    for variant in policy['schemas']:
        if tables == set(policy['preserve']) | set(variant['delete']):
            break
    else:
        known = set(policy['preserve']).union(*(v['delete'] for v in policy['schemas']))
        raise ValueError('Unknown or missing tables, review policy before reset: unknown=' + ','.join(sorted(tables - known))
                         + ' missing=' + ','.join(sorted(known - tables)))
    if others:
        raise ValueError('Unexpected non-public or non-table relations: ' + ','.join(others))


def verify_backup(manifest, snapshot, identity, now=None):
    now = now or datetime.now(timezone.utc)
    if manifest.get('format') != 1 or manifest.get('purpose') != 'rollout-1.21-pre-reset' or manifest.get('quiesced') is not True or manifest.get('stage') != snapshot['schema'] or manifest.get('migration_sha256') != snapshot['final_migration_sha256']:
        raise ValueError('A fresh quiesced pre-reset backup is mandatory')
    if manifest.get('target') != identity or manifest.get('snapshot_sha256') != digest(snapshot):
        raise ValueError('Backup target/preservation snapshot mismatch')
    created = datetime.fromisoformat(manifest['created_at'])
    if created.tzinfo is None or not 0 <= (now - created).total_seconds() <= 7200:
        raise ValueError('Backup evidence must be less than two hours old, not future dated')
    archive = manifest['archive']
    path = Path(archive['path'])
    if identity['volume'] != 'tmpfs' and path.parent != PROTECTED_DIR:
        raise ValueError('Original backup must be in the protected pre-reset directory')
    if not re.fullmatch(r'tayyn-\d{8}T\d{6}Z-[0-9a-f]{8}\.dump\.age', path.name):
        raise ValueError('Invalid encrypted archive filename')
    if path.is_symlink() or not path.is_file() or path.stat().st_mode & 0o077 or archive['size'] < 100 or path.stat().st_size != archive['size'] or file_digest(path) != archive['sha256']:
        raise ValueError('Protected original ciphertext size/checksum mismatch')
    with path.open('rb') as source:
        if source.read(22) != b'age-encryption.org/v1\n':
            raise ValueError('Backup is not an age ciphertext')
    for key, host in [('relay', 'tayyn-monitor'), ('owner_copy', 'owner-workstation')]:
        copy = manifest[key]
        if copy.get('host') != host or copy.get('sha256') != archive['sha256'] or copy.get('size') != archive['size'] or copy.get('protected_from_retention') is not True:
            raise ValueError('Independent protected ciphertext copies not verified')
    if manifest.get('protected_from_retention') is not True:
        raise ValueError('Original backup must be protected from updater/timer retention')
    restore = manifest['restore']
    if (restore.get('host') != 'owner-workstation' or restore.get('archive_sha256') != archive['sha256']
            or restore.get('snapshot_sha256') != digest(snapshot) or restore.get('success') is not True
            or restore.get('rollback_rehearsed') is not True
            or not re.fullmatch('tayyn-reset-rehearsal-[a-z0-9-]+', restore.get('project', ''))
            or not re.fullmatch('tayyn_(?:reset|restore)_[a-z0-9_]+', restore.get('database', ''))):
        raise ValueError('Owner-local disposable restore, preservation comparison and rollback rehearsal required')


def verify_ambiguity(evidence, snapshot, policy, manifest):
    # Operator attestation from an exact owner-restored copy, never a migration
    # error on production or a Prisma failed-migration bypass.
    if (evidence.get('format') != 1 or evidence.get('purpose') != 'release-1.21-owner-restored-legacy-ambiguity'
            or evidence.get('host') != 'owner-workstation'
            or evidence.get('snapshot_sha256') != digest(snapshot)
            or evidence.get('migration_sha256') != policy['final_migration_sha256']
            or evidence.get('catalog_sha256') != digest(snapshot['catalog'])
            or evidence.get('historical_ambiguity_proven') is not True
            or evidence.get('production_migration_attempted') is not False
            or evidence.get('migration_after_reset_succeeded') is not True
            or evidence.get('rollback_rehearsed') is not True
            or not re.fullmatch('tayyn-reset-rehearsal-[a-z0-9-]+', evidence.get('project', ''))
            or not re.fullmatch('tayyn_restore_[a-z0-9_]+', evidence.get('database', ''))
            or not re.fullmatch('[0-9a-f]{64}', evidence.get('archive_sha256', ''))
            or (manifest is not None and evidence.get('archive_sha256') != manifest['archive']['sha256'])):
        raise ValueError('Exact owner-restored historical ambiguity and successful reset/migration rehearsal required')


def execute(db, policy, snapshot):
    variant = next(v for v in policy['schemas'] if v['name'] == snapshot['schema'])
    tables = sorted(snapshot['counts'])
    sql = "BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='120s';\n"
    sql += 'LOCK TABLE ' + ','.join('public."' + t + '"' for t in tables) + ' IN ACCESS EXCLUSIVE MODE;\n'
    sql += assert_sql("NOT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend')", 'Other database clients remain')
    sql += catalog_assert(snapshot['catalog'])
    for query, expected in [(retained_sql(policy), snapshot['retained']), (sequences_sql(), snapshot['sequences']), (counts_sql(tables), snapshot['counts'])]:
        sql += assert_sql(f'({query}) = {quote(json.dumps(expected))}::jsonb', 'Pre-reset snapshot changed')
    # Check both directions. Never remove a malformed admin relationship implicitly.
    sql += assert_sql("NOT EXISTS (SELECT 1 FROM public.admins a JOIN public.users u ON u.id=a.user_id WHERE u.role<>'ADMIN') AND NOT EXISTS (SELECT 1 FROM public.users u LEFT JOIN public.admins a ON a.user_id=u.id WHERE u.role='ADMIN' AND a.id IS NULL)", 'Admin relationship mismatch')
    sql += assert_sql("(SELECT count(*) FROM public.users WHERE role='ADMIN')=1 AND (SELECT count(*) FROM public.admins)=1 AND (SELECT count(*) FROM public.districts)=9", 'Admin/region cardinality changed')
    for table in variant['delete']:
        if table == 'vehicles':
            sql += 'UPDATE public.drivers SET current_vehicle_id=NULL WHERE current_vehicle_id IS NOT NULL;\n'
        sql += f'DELETE FROM public."{table}";\n'
    sql += "DELETE FROM public.users WHERE role<>'ADMIN';\n"
    for query, expected in [(retained_sql(policy), snapshot['retained']), (sequences_sql(), snapshot['sequences'])]:
        sql += assert_sql(f'({query}) = {quote(json.dumps(expected))}::jsonb', 'Preservation assertion failed')
    # Every catalog table outside the preserve policy must be empty, not only the listed deletes:
    # an omitted table with ON DELETE SET NULL would otherwise survive with orphaned rows.
    for table in sorted(set(tables) - set(policy['preserve'])):
        sql += assert_sql(f'NOT EXISTS (SELECT 1 FROM public."{table}")', 'Operational rows remain')
    sql += assert_sql("NOT EXISTS (SELECT 1 FROM public.users WHERE role<>'ADMIN')", 'Non-admin identities remain')
    sql += catalog_assert(snapshot['catalog']) + 'COMMIT;'
    db.sql(sql)  # ON_ERROR_STOP exits, closing this connection rolls back any failed transaction.


def report(snapshot):
    # stdout contains only counts and digests, including after a real reset.
    regions = [json.loads(row) for row in snapshot['retained']['districts']]
    return {'stage': snapshot['schema'], 'counts': snapshot['counts'],
            'region_sha256': {r['id']: digest(r) for r in regions},
            'geometry_sha256': {r['id']: digest(r['boundary']) for r in regions}, 'preservation_sha256': {t: digest(rows) for t, rows in snapshot['retained'].items()},
            'sequence_sha256': digest(snapshot['sequences']), 'catalog_sha256': digest(snapshot['catalog']),
            'snapshot_sha256': digest(snapshot)}


def load_policy():
    policy = json.loads(POLICY.read_text())
    stages = {v['name']: v for v in policy['schemas']}
    if (not re.fullmatch('[0-9a-f]{40}', policy['final_backend_commit'])
            or not re.fullmatch('[0-9a-f]{64}', policy['final_migration_sha256'])
            or not re.fullmatch('[0-9]{14}_[a-z0-9_]+', policy['final_migration_name'])
            or sorted(stages) != ['final-1.21', 'installed-pre-migration'] or len(policy['schemas']) != 2
            or any(not re.fullmatch('[0-9a-f]{64}', v['catalog_sha256']) or not v['migrations'] for v in policy['schemas'])):
        raise ValueError('Release policy is not fully pinned')
    installed, final = stages['installed-pre-migration'], stages['final-1.21']
    # The final stage is exactly the installed history plus the one reviewed migration, so the
    # installed stage can never accept a database that has started or recorded the final migration.
    if (final['migrations'] != installed['migrations'] + [[policy['final_migration_name'], policy['final_migration_sha256']]]
            or installed['catalog_sha256'] == final['catalog_sha256']):
        raise ValueError('Release policy stage histories are inconsistent')
    return policy


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage', choices=['installed-pre-migration', 'final-1.21'], required=True)
    parser.add_argument('--legacy-ambiguity-evidence', type=Path)
    parser.add_argument('--legacy-ambiguity-evidence-sha256')
    parser.add_argument('--target', choices=['production', 'isolated'], required=True)
    parser.add_argument('--project', required=True)
    parser.add_argument('--database', default='tayyn')
    parser.add_argument('--compose-dir', type=Path)
    parser.add_argument('--container', help='Required only for the owned isolated tmpfs rehearsal')
    parser.add_argument('--write-preservation-snapshot', type=Path)
    parser.add_argument('--execute-reset', action='store_true')
    parser.add_argument('--preservation-snapshot', type=Path)
    parser.add_argument('--snapshot-sha256')
    parser.add_argument('--backup-manifest', type=Path)
    parser.add_argument('--backup-manifest-sha256')
    args = parser.parse_args()
    committed = False
    try:
        if args.execute_reset and (not args.preservation_snapshot or args.write_preservation_snapshot):
            raise ValueError('Execution requires a pinned preservation snapshot, without snapshot overwrite')
        # A throwaway tmpfs copy has nothing to protect; production can never skip the backup guard.
        if args.execute_reset and args.target == 'production' and not args.backup_manifest:
            raise ValueError('Production execution requires a pinned verified backup manifest')
        if args.execute_reset and args.stage == 'installed-pre-migration' and not args.legacy_ambiguity_evidence:
            raise ValueError('Pre-migration execution requires pinned owner-restored ambiguity evidence')
        # Same lock as the stock updater. Inspection requires no host writes.
        lock = None
        if args.execute_reset:
            lock_path = Path('/run/lock/tayyn-deploy.lock') if args.target == 'production' else Path('/tmp') / (args.project + '.lock')
            lock = lock_path.open('a')
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        policy = load_policy()
        db = Database(args)
        snapshot = db.snapshot(policy)
        if args.execute_reset:
            db.quiesced()
            expected = private_read(args.preservation_snapshot, args.snapshot_sha256)
            if snapshot != expected:
                raise ValueError('Live database differs from the protected pre-reset snapshot')
            manifest = private_read(args.backup_manifest, args.backup_manifest_sha256) if args.backup_manifest else None
            if manifest is not None:
                verify_backup(manifest, snapshot, db.identity)
            if args.stage == 'installed-pre-migration':
                verify_ambiguity(private_read(args.legacy_ambiguity_evidence, args.legacy_ambiguity_evidence_sha256), snapshot, policy, manifest)
            db.quiesced()
            execute(db, policy, snapshot)
            committed = True
            after = db.snapshot(policy)
            if after['retained'] != snapshot['retained'] or after['sequences'] != snapshot['sequences'] or any(after['counts'][t] for t in next(v['delete'] for v in policy['schemas'] if v['name'] == snapshot['schema'])) or after['counts']['users'] != len(after['retained']['users']):
                raise ValueError('Post-commit preservation/count comparison failed; keep writers stopped')
            snapshot = after
        elif args.write_preservation_snapshot:
            private_write(args.write_preservation_snapshot, snapshot)
        print(json.dumps(report(snapshot), sort_keys=True))
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError, json.JSONDecodeError) as error:
        # Never print SQL, config, input records or subprocess error output.
        message = str(error) if isinstance(error, ValueError) and not isinstance(error, json.JSONDecodeError) else type(error).__name__
        prefix = 'RESET COMMITTED; keep writers stopped; post-check failed: ' if committed else 'Reset refused or transaction rolled back: '
        print(prefix + message, file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
