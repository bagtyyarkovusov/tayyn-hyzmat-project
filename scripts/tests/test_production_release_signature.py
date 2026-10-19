"""Exercise offline release verification with cosign substituted.

The stub accepts a Sigstore bundle only when it records the signed blob's digest, the
same binding real cosign enforces. CI also checks real cosign rejects a tampered blob.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
VERIFIER = ROOT / "scripts/production/verify-release-signature.sh"


class ReleaseSignatureTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        work = Path(self.temporary.name)
        self.cosign = work / "cosign"
        self.cosign.write_text(f'''#!{sys.executable}
import hashlib,json,sys
from pathlib import Path
args=sys.argv[1:]
assert args[:2]==['verify-blob','--offline'], args
assert args[args.index('--certificate-oidc-issuer')+1]=='https://token.actions.githubusercontent.com'
assert 'offline-production-bundle' in args[args.index('--certificate-identity-regexp')+1]
signed=json.loads(Path(args[args.index('--bundle')+1]).read_text())['digest']
sys.exit(0 if hashlib.sha256(Path(args[-1]).read_bytes()).hexdigest()==signed else 1)
''')
        self.cosign.chmod(0o755)
        self.artifact = work / "artifact"
        self.artifact.mkdir()
        lines = []
        for name in ("app-bundle.tar.gz", "monitor-bundle.tar.gz"):
            (self.artifact / name).write_bytes(name.encode())
            lines.append(f"{hashlib.sha256(name.encode()).hexdigest()}  {name}\n")
        self.sums = self.artifact / "bundle-archives.sha256"
        self.sums.write_text("".join(lines))
        digest = hashlib.sha256(self.sums.read_bytes()).hexdigest()
        (self.artifact / "bundle-archives.sha256.sigstore.json").write_text(json.dumps({"digest": digest}))

    def verify(self):
        return subprocess.run(["bash", str(VERIFIER), str(self.artifact)], env={**os.environ, "COSIGN": str(self.cosign)}, capture_output=True, text=True)

    def test_signed_artifact_verifies(self):
        result = self.verify()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("verified", result.stdout)

    def test_tampered_archive_fails(self):
        (self.artifact / "app-bundle.tar.gz").write_bytes(b"replaced")
        self.assertNotEqual(self.verify().returncode, 0)

    def test_replaced_archive_and_checksums_fail_signature(self):
        (self.artifact / "app-bundle.tar.gz").write_bytes(b"replaced")
        self.sums.write_text(f"{hashlib.sha256(b'replaced').hexdigest()}  app-bundle.tar.gz\n"
                             + self.sums.read_text().splitlines(True)[1])
        result = self.verify()
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("verified", result.stdout)

    def test_missing_signature_fails(self):
        (self.artifact / "bundle-archives.sha256.sigstore.json").unlink()
        result = self.verify()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unsigned", result.stderr)

    def test_extra_checksum_entry_fails(self):
        with self.sums.open("a") as handle:
            handle.write(f"{'0' * 64}  other.tar.gz\n")
        digest = hashlib.sha256(self.sums.read_bytes()).hexdigest()
        (self.artifact / "bundle-archives.sha256.sigstore.json").write_text(json.dumps({"digest": digest}))
        result = self.verify()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Unexpected", result.stderr)


if __name__ == "__main__":
    unittest.main()
