"""Release prune CLI tests with disposable directories and a synthetic Docker executable.

No Docker daemon, privileges or production paths are used; the unmodified CLI runs
in a child process against a temporary root.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

SCRIPT = Path(__file__).parents[1] / "production" / "prune-releases.py"

DOCKER = r'''
import json, sys
from pathlib import Path
state_path = Path(__file__).with_name("docker.json")
state = json.loads(state_path.read_text())
args = sys.argv[1:]
if args[:2] == ["image", "ls"]:
    print("\n".join(state["tags"]))
elif args[:2] == ["ps", "--all"]:
    print("\n".join(state["containers"]))
elif args[:2] == ["image", "rm"]:
    if args[2] in state["containers"] or args[2] not in state["tags"]:
        sys.exit(1)
    state["tags"].remove(args[2])
    state_path.write_text(json.dumps(state))
else:
    sys.exit(2)
'''


def release(number):
    return f"vps-{number}-" + format(number, "x").rjust(40, "a")


def tags(*numbers):
    return [f"tayyn-offline/{role}:{release(n)}" for n in numbers for role in ("api", "web", "db", "proxy")]


class PruneReleases(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.root = self.base / "opt"
        for number in (1, 2, 3, 4):
            (self.root / "releases" / release(number) / "scripts").mkdir(parents=True)
        (self.root / "current").symlink_to(self.root / "releases" / release(4))
        (self.root / "incoming" / "run-old").mkdir(parents=True)
        (self.root / "incoming" / "run-new").mkdir()
        old = time.time() - 3 * 86400
        os.utime(self.root / "incoming" / "run-old", (old, old))
        (self.base / "docker.py").write_text(DOCKER)
        self.docker({"tags": tags(1, 2, 3, 4), "containers": tags(4)})

    def docker(self, state=None):
        path = self.base / "docker.json"
        if state is not None:
            path.write_text(json.dumps(state))
        return json.loads(path.read_text())

    def prune(self, *arguments):
        result = subprocess.run([sys.executable, str(SCRIPT), "--root", str(self.root), "--lock", str(self.base / "lock"),
                                 "--docker", f"{sys.executable} {self.base / 'docker.py'}", *arguments],
                                capture_output=True, text=True, timeout=60)
        return result.returncode, json.loads(result.stdout) if result.returncode == 0 else result.stderr

    def releases(self):
        return sorted(p.name for p in (self.root / "releases").iterdir())

    def test_dry_run_prints_plan_and_changes_nothing(self):
        code, plan = self.prune()
        self.assertEqual(code, 0)
        self.assertFalse(plan["applied"])
        self.assertEqual(plan["keep"], [release(4), release(3)])
        self.assertEqual([item["release"] for item in plan["remove"]], [release(2), release(1)])
        self.assertEqual(plan["remove"][0]["image_tags"], tags(2))
        self.assertEqual(plan["stale_incoming"], [str(self.root / "incoming" / "run-old")])
        self.assertEqual(self.releases(), [release(n) for n in (1, 2, 3, 4)])
        self.assertEqual(self.docker()["tags"], tags(1, 2, 3, 4))
        self.assertTrue((self.root / "incoming" / "run-old").exists())

    def test_apply_removes_old_releases_their_tags_and_stale_transfers(self):
        code, plan = self.prune("--apply")
        self.assertEqual(code, 0)
        self.assertTrue(plan["applied"])
        self.assertEqual(self.releases(), [release(3), release(4)])
        self.assertEqual(self.docker()["tags"], tags(3, 4))
        self.assertEqual(sorted(p.name for p in (self.root / "incoming").iterdir()), ["run-new"])

    def test_apply_refuses_release_whose_tag_any_container_uses(self):
        self.docker({"tags": tags(1, 2, 3, 4), "containers": tags(4) + [f"tayyn-offline/db:{release(1)}"]})
        code, plan = self.prune("--apply")
        self.assertEqual(code, 0)
        self.assertEqual(plan["refused"], [{"release": release(1), "reason": "image tag used by a container"}])
        self.assertEqual(self.releases(), [release(1), release(3), release(4)])
        self.assertEqual(self.docker()["tags"], tags(1, 3, 4))

    def test_current_and_newer_releases_are_kept_when_current_is_rolled_back(self):
        (self.root / "current").unlink()
        (self.root / "current").symlink_to(self.root / "releases" / release(2))
        code, plan = self.prune("--apply")
        self.assertEqual(code, 0)
        self.assertEqual(self.releases(), [release(1), release(2), release(3), release(4)])
        self.assertEqual(plan["remove"], [])

    def test_keep_below_two_is_rejected(self):
        code, error = self.prune("--keep", "1", "--apply")
        self.assertEqual(code, 2)
        self.assertIn("--keep must be at least 2", error)
        self.assertEqual(len(self.releases()), 4)

    def test_symlinks_and_unexpected_names_are_never_removed(self):
        outside = self.base / "outside"
        outside.mkdir()
        (self.root / "releases" / release(1)).rename(self.base / "moved")
        (self.root / "releases" / release(1)).symlink_to(outside)
        (self.root / "releases" / "manual-backup").mkdir()
        (self.root / "incoming" / "linked").symlink_to(outside)
        os.utime(self.root / "incoming" / "linked", (0, 0), follow_symlinks=False)
        code, plan = self.prune("--apply")
        self.assertEqual(code, 0)
        self.assertIn(release(1), plan["ignored"])
        self.assertIn("manual-backup", plan["ignored"])
        self.assertIn("incoming/linked", plan["ignored"])
        self.assertTrue(outside.is_dir())
        self.assertEqual(self.releases(), sorted(["manual-backup", release(1), release(3), release(4)]))

    def test_current_outside_releases_root_is_refused(self):
        (self.root / "current").unlink()
        (self.root / "current").symlink_to(self.base)
        code, error = self.prune("--apply")
        self.assertEqual(code, 1)
        self.assertIn("current does not point to a valid release", error)
        self.assertEqual(len(self.releases()), 4)


if __name__ == "__main__":
    unittest.main()
