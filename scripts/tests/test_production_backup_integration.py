"""Opt-in real age/pg_dump/restore drill, with an owned tmpfs Docker PostgreSQL only.

PATH=/path/to/age/bin:$PATH TAYYN_PRODUCTION_BACKUP_DRILL=1 python3 -m unittest discover -s scripts/tests -p test_production_backup_integration.py -v
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

SCRIPT = Path(__file__).parents[1] / "production" / "operations.py"
ENABLED = os.environ.get("TAYYN_PRODUCTION_BACKUP_DRILL") == "1"


@unittest.skipUnless(ENABLED, "Opt-in owned Docker/age restore drill")
class BackupIntegrationTests(unittest.TestCase):
    def test_real_authenticated_encrypted_dump_and_restore(self):
        for tool in ("docker", "age", "age-keygen"):
            self.assertIsNotNone(shutil.which(tool), f"Install prerequisite {tool}")
        endpoint = os.environ.get("DOCKER_HOST", "")
        if endpoint:
            self.assertTrue(endpoint.startswith("unix:///"), "Refusing remote Docker daemon")
        if os.environ.get("DOCKER_CONTEXT") or not endpoint:
            context = os.environ.get("DOCKER_CONTEXT") or subprocess.check_output(["docker", "context", "show"], timeout=10).decode().strip()
            endpoint = subprocess.check_output(["docker", "context", "inspect", context, "--format", "{{.Endpoints.docker.Host}}"], timeout=10).decode().strip()
            self.assertTrue(endpoint.startswith("unix:///"), "Refusing nonlocal Docker context")
        project = "tayyn-backup-drill-" + uuid.uuid4().hex[:12]
        def command(arguments, **kwargs):
            return subprocess.run(arguments, check=True, capture_output=True, timeout=180, **kwargs)
        with tempfile.TemporaryDirectory(prefix="tayyn-backup-drill-") as directory:
            root = Path(directory)
            root.joinpath("compose.yaml").write_text("services:\n  db:\n    image: postgres:17-bookworm\n    network_mode: none\n    environment:\n      POSTGRES_USER: tayyn\n      POSTGRES_DB: tayyn\n      POSTGRES_PASSWORD: " + uuid.uuid4().hex + "\n    tmpfs:\n      - /var/lib/postgresql/data\n")
            root.joinpath("app.env").write_text("")
            compose = ["docker", "compose", "--project-name", project, "--project-directory", directory, "-f", str(root / "compose.yaml")]
            def sql(database, statement):
                return command(compose + ["exec", "-T", "db", "psql", "-U", "tayyn", "-d", database, "-Atc", statement]).stdout
            try:
                command(compose + ["up", "-d", "--pull", "never"])
                for attempt in range(60):
                    ready = subprocess.run(compose + ["exec", "-T", "db", "sh", "-c", '[ "$(cat /proc/1/comm)" = "postgres" ] && pg_isready -U tayyn -d tayyn'], capture_output=True, timeout=5)
                    if ready.returncode == 0:
                        break
                    time.sleep(.25)
                else:
                    self.fail("Owned PostgreSQL did not become ready")
                sql("tayyn", "CREATE TABLE synthetic_ledger(id integer PRIMARY KEY, amount numeric NOT NULL); INSERT INTO synthetic_ledger VALUES (1,15.5),(2,-3.25);")
                identity = root / "owner.agekey"
                command(["age-keygen", "-o", str(identity)])
                recipient = command(["age-keygen", "-y", str(identity)]).stdout.decode().strip()
                config = {"compose_dir": directory, "compose_env": str(root / "app.env"), "project": project,
                          "backup_dir": str(root / "backups"), "state_dir": str(root / "state"),
                          "age_recipient": recipient, "isolated_restore": True}
                config_path = root / "operations.json"
                config_path.write_text(json.dumps(config))
                config_path.chmod(0o600)
                cli = [sys.executable, str(SCRIPT), "--config", str(config_path)]
                command(cli + ["backup"])
                archive = next((root / "backups").glob("*.dump.age"))
                self.assertTrue(archive.read_bytes().startswith(b"age-encryption.org/v1"))
                command(cli + ["restore", "--archive", str(archive), "--identity", str(identity), "--database", "tayyn_restore_verified"])
                fingerprint = "SELECT id,amount FROM synthetic_ledger ORDER BY id"
                self.assertEqual(sql("tayyn", fingerprint), sql("tayyn_restore_verified", fingerprint))
                tampered = root / "tampered.dump.age"
                payload = bytearray(archive.read_bytes())
                payload[-5] ^= 1
                tampered.write_bytes(payload)
                failed = subprocess.run(cli + ["restore", "--archive", str(tampered), "--identity", str(identity), "--database", "tayyn_restore_tampered"], capture_output=True, timeout=30)
                self.assertEqual(failed.returncode, 2)
                self.assertEqual(sql("tayyn", "SELECT count(*) FROM pg_database WHERE datname='tayyn_restore_tampered'").strip(), b"0")
                self.assertEqual(sql("tayyn", fingerprint), b"1|15.5\n2|-3.25\n")
            finally:
                command(compose + ["down", "-v", "--remove-orphans"])


if __name__ == "__main__":
    unittest.main()
