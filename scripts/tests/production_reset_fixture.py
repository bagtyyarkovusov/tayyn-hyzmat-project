"""Only synthetic data in a uniquely owned tmpfs PostgreSQL17 container."""
import hashlib
from pathlib import Path
import secrets
import subprocess
import time

ROOT = Path(__file__).resolve().parents[2]
PRISMA_TABLE = '''CREATE TABLE public._prisma_migrations (
 id varchar(36) NOT NULL PRIMARY KEY, checksum varchar(64) NOT NULL,
 finished_at timestamptz, migration_name varchar(255) NOT NULL, logs text,
 rolled_back_at timestamptz, started_at timestamptz NOT NULL DEFAULT now(),
 applied_steps_count integer NOT NULL DEFAULT 0);'''


def command(args, input=None):
    return subprocess.run(args, input=input, text=True, capture_output=True, check=True, timeout=120).stdout


class Cluster:
    def __init__(self):
        self.project = 'tayyn-reset-rehearsal-' + secrets.token_hex(6)
        self.container = self.project + '-db'
        # --mount (not --tmpfs) is reported in Mounts, which the reset tool requires. RAM only, no logs:
        # the rehearsal adds no volume, image or log data to a nearly full host disk.
        command(['docker', 'run', '--detach', '--pull', 'never', '--name', self.container,
                 '--label', 'com.docker.compose.project=' + self.project,
                 '--label', 'com.docker.compose.service=db', '--network', 'none', '--memory', '384m',
                 '--log-driver', 'none',
                 '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data,tmpfs-size=201326592',
                 '-e', 'POSTGRES_USER=tayyn', '-e', 'POSTGRES_PASSWORD=' + secrets.token_hex(24),
                 'postgres:17-bookworm'])
        try:
            for _ in range(120):
                # The entrypoint restarts the server once after init; wait for a real query.
                ready = subprocess.run(['docker', 'exec', self.container, 'psql', '-X', '-qAt', '-U', 'tayyn', '-d', 'tayyn',
                                        '-h', '127.0.0.1', '-c', 'SELECT 1'], capture_output=True)
                if ready.returncode == 0:
                    break
                time.sleep(0.25)
            else:
                raise RuntimeError('Disposable PostgreSQL did not become ready')
        except BaseException:
            self.close()
            raise

    def sql(self, sql, database='tayyn'):
        return command(['docker', 'exec', '-i', self.container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'tayyn', '-d', database], sql)

    def template(self, name, *, rollout=True):
        """Migrated synthetic database to clone; never targeted by the reset itself."""
        self.database(name, rollout=rollout)
        self.sql(FIXTURE + (ROLLOUT_FIXTURE if rollout else ''), name)

    def clone(self, template, name):
        self.sql('CREATE DATABASE ' + name + ' TEMPLATE ' + template)

    def database(self, name, *, rollout=True):
        self.sql('CREATE DATABASE ' + name)
        self.sql(PRISMA_TABLE, name)
        for index, path in enumerate(sorted((ROOT / 'backend/prisma/migrations').glob('*/migration.sql'))):
            if not rollout and path.parent.name.startswith('2026101819'):
                continue
            sql = path.read_text()
            self.sql(sql + "\nINSERT INTO _prisma_migrations(id,checksum,migration_name,finished_at,applied_steps_count) VALUES ('" + str(index) + "','" + hashlib.sha256(sql.encode()).hexdigest() + "','" + path.parent.name + "',now(),1);", name)

    def close(self):
        command(['docker', 'rm', '-f', self.container])


FIXTURE = '''
INSERT INTO users(id,role,phone,password_hash,full_name,credential_version,status,updated_at) VALUES
 ('admin-one','ADMIN','+99360000101','synthetic-hash-A','Dispatcher one',7,'ACTIVE','2026-10-01'),
 ('admin-two','ADMIN','+99360000102','synthetic-hash-B','Blocked admin',11,'BLOCKED','2026-10-02'),
 ('driver-user','DRIVER','+99360000103','synthetic-driver-hash','Synthetic driver',3,'ACTIVE','2026-10-03'),
 ('client-user','CLIENT','+99360000104','synthetic-client-hash','Synthetic client',2,'ACTIVE','2026-10-04');
INSERT INTO admins(id,user_id,permission_level) VALUES ('admin-a','admin-one','SUPER'),('admin-b','admin-two','FINANCE');
INSERT INTO districts(id,name,center_lat,center_lng,boundary,is_active,base_fare,per_km_rate,per_min_rate,radius_km) VALUES
 ('district-a','Synthetic exact polygon',37.1234567,58.7654321,'[[58.7654321,37.1234567],[58.7654999,37.1234999],[58.7654321,37.1234567]]',true,13.27,4.15,0.81,2.37),
 ('district-b','Inactive custom region',38.7654321,59.1234567,'[[0,0],[1,0],[0,0]]',false,9.99,2.31,0.77,1.23);
INSERT INTO settings(key,value,updated_at,updated_by) VALUES ('provider-safety','{"limit":999,"enabled":true}','2026-10-02','admin-b');
INSERT INTO geocoder_budget(provider,period,attempts,failures,blocked_until) VALUES ('yandex','2026-10-18',999,17,'2030-01-01T03:04:05Z');
INSERT INTO drivers(id,user_id,district_id,status,updated_at) VALUES ('driver-a','driver-user','district-a','APPROVED','2026-10-03');
INSERT INTO vehicles(id,driver_id,make,model,plate_number) VALUES ('vehicle-a','driver-a','Synthetic','Test','TEST-001');
UPDATE drivers SET current_vehicle_id='vehicle-a' WHERE id='driver-a';
INSERT INTO orders(id,client_id,driver_id,district_id,pickup_lat,pickup_lng,status,price_estimated) VALUES ('order-a','client-user','driver-a','district-a',37,58,'ACCEPTED',40);
INSERT INTO balances(id,user_id,amount,updated_at) VALUES ('balance-admin','admin-one',15.75,'2026-10-04'),('balance-driver','driver-user',100,'2026-10-05');
INSERT INTO transactions(id,balance_id,order_id,type,amount,balance_after,created_by) VALUES
 ('admin-money','balance-admin','order-a','ADJUSTMENT',15.75,15.75,'admin-one'),('driver-money','balance-driver','order-a','TOPUP',100,100,'admin-two');
INSERT INTO messages(id,order_id,sender_id,receiver_id,body,is_broadcast) VALUES
 ('chat-a','order-a','admin-one','driver-user','Synthetic admin chat',false),
 ('chat-b',null,'admin-two',null,'Synthetic broadcast',true),
 ('chat-c',null,'admin-one','admin-two','Admin-only chat',false);
INSERT INTO notifications(id,user_id,title) VALUES ('notification-admin','admin-one','Admin notification'),('notification-driver','driver-user','Driver notification');
INSERT INTO refresh_tokens(id,user_id,token_hash,expires_at) VALUES ('refresh-admin','admin-one','synthetic-admin-token','2030-01-01'),('refresh-driver','driver-user','synthetic-driver-token','2030-01-01');
INSERT INTO driver_devices(id,driver_id,device_id) VALUES ('device-a','driver-a','synthetic-device');
INSERT INTO driver_locations(id,driver_id,lat,lng) VALUES ('location-a','driver-a',37,58);
INSERT INTO driver_address_state(driver_id,attempted_at,source_lat,source_lng) VALUES ('driver-a','2026-10-01',37,58);
INSERT INTO native_shift_leases(driver_id,token_hash,device_id,started_at,expires_at) VALUES ('driver-a','synthetic-lease','synthetic-device','2026-10-01','2030-01-01');
INSERT INTO notification_installations(id,driver_id,device_id,credential_version,device_version,updated_at) VALUES ('install-a','driver-a','synthetic-device',3,1,'2026-10-01');
INSERT INTO notification_deliveries(id,installation_id,event_id,channel,resource_id,expires_at,not_before) VALUES ('delivery-a','install-a','order:order-a:attempt-a','order','order-a','2030-01-01','2026-10-01');
INSERT INTO order_resolution_audits(id,order_id,actor_id,action,reason) VALUES ('audit-a','order-a','admin-one','reoffer','Synthetic audit');
SELECT setval('order_number_seq',73,true);
'''
ROLLOUT_FIXTURE = '''INSERT INTO order_assignments(id,order_id,driver_id,offer_attempt_id,quoted_amount,funding_state) VALUES ('hold-a','order-a','driver-a','attempt-a',40,'HELD');'''
