#!/usr/bin/env python3
"""Real private filesystem and logrotate proofs. Never targets host log files."""
import gzip
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[2]
HELPER = "scripts/v5-selfhost-host-log-policy.py"
FILES = (HELPER, "deploy/v5-selfhost/host-log-policy.json",
         "deploy/v5-selfhost/logrotate.d/openclaude-v5-selfhost",
         "deploy/v5-selfhost/logrotate.d/openclaude-v5-selfhost-egress-watch")
LOGS = ("openclaude-v5-selfhost.log", "openclaude-v5-selfhost-egress.log")
spec = importlib.util.spec_from_file_location("host_log_policy_under_test", REPO / HELPER)
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)


class HostLogPolicyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if os.geteuid() != 0 or not shutil.which("logrotate") or not shutil.which("gzip"):
            raise RuntimeError("root, logrotate and gzip are required; this proof cannot skip")

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="ocv5-606-policy-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root, self.bundle = self.base / "root", self.base / "bundle"
        for rel in ("var/log", "etc/logrotate.d"):
            (self.root / rel).mkdir(parents=True)
        for rel in FILES:
            target = self.bundle / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(REPO / rel, target)
        (self.bundle / ".complete").write_text('{"hostLogPolicyGeneration":1}\n')
        for name, mode in [(LOGS[0], 0o644), (LOGS[1], 0o644),
                           ("cloudflared-v5-selfhost.log", 0o644),
                           ("openclaude-v5-selfhost-watch.log", 0o640),
                           ("sibling.log", 0o644)]:
            p = self.log(name)
            p.write_text("before-" + name + "\n")
            p.chmod(mode)
        (self.root / "etc/logrotate.conf").write_text(
            "su root adm\nweekly\nrotate 4\ninclude /etc/logrotate.d\n")
        for rel in FILES[2:]:
            data = (self.bundle / rel).read_bytes().replace(
                b"/var/log/", (str(self.root / "var/log") + "/").encode())
            (self.root / "etc/logrotate.d" / Path(rel).name).write_bytes(data)
        (self.root / "etc/logrotate.d/sibling").write_text(
            str(self.log("sibling.log")) + " {\nmissingok\nnotifempty\nrotate 2\ncopytruncate\n}\n")

    def log(self, name):
        return self.root / "var/log" / name

    def call(self, mode, expected=0, bundle=None, program=None):
        result = subprocess.run(
            [sys.executable, str(program or REPO / HELPER), mode,
             "--bundle-root", str(bundle or self.bundle), "--fixture-only",
             "--fixture-root", str(self.root),
             "--evidence-dir", str(self.root / "evidence")],
            capture_output=True, text=True, timeout=40)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return json.loads(result.stdout)

    def generation(self, root, expected):
        result = subprocess.run(
            ["bash", "-c", 'source "$1"; host_log_policy_generation "$2"', "_",
             str(REPO / "scripts/lib/v5-selfhost-host-log-policy.sh"), str(root)],
            capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return result.stdout.strip()

    def test_private_fixture_cannot_select_production_root(self):
        r = subprocess.run([sys.executable, str(REPO / HELPER), "check",
                            "--bundle-root", str(self.bundle), "--fixture-only",
                            "--fixture-root", "/"], capture_output=True, text=True)
        self.assertEqual(r.returncode, 2)

    def test_permissions_preserve_inode_content_and_open_writer(self):
        for name in (LOGS[0] + ".1", LOGS[1] + ".2.gz"):
            self.log(name).write_bytes(b"archive fixture\n")
            self.log(name).chmod(0o644)
        other = {n: (self.log(n).read_bytes(), stat.S_IMODE(self.log(n).stat().st_mode))
                 for n in ("cloudflared-v5-selfhost.log", "openclaude-v5-selfhost-watch.log", "sibling.log")}
        path = self.log(LOGS[0])
        before = path.read_bytes()
        with path.open("ab", buffering=0) as writer:
            inode = os.fstat(writer.fileno()).st_ino
            self.call("install")
            self.assertEqual(path.stat().st_ino, inode)
            writer.write(b"still-open\n")
        self.assertEqual(path.read_bytes(), before + b"still-open\n")
        for n in (*LOGS, LOGS[0] + ".1", LOGS[1] + ".2.gz"):
            info = self.log(n).stat()
            self.assertEqual((info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)), (0, 0, 0o600))
        for n, old in other.items():
            self.assertEqual((self.log(n).read_bytes(), stat.S_IMODE(self.log(n).stat().st_mode)), old)

    def test_missing_current_is_created_private(self):
        for name in LOGS:
            self.log(name).unlink()
        self.call("install")
        for name in LOGS:
            self.assertEqual(self.log(name).read_bytes(), b"")
            self.assertEqual(stat.S_IMODE(self.log(name).stat().st_mode), 0o600)

    def test_symlink_rejected_before_any_chmod(self):
        target = self.root / "outside.log"
        target.write_text("untouched\n")
        target.chmod(0o644)
        self.log(LOGS[1]).unlink()
        self.log(LOGS[1]).symlink_to(target)
        self.call("install", expected=1)
        self.assertEqual(stat.S_IMODE(self.log(LOGS[0]).stat().st_mode), 0o644)
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o644)
        self.assertEqual(target.read_text(), "untouched\n")

    def test_fifo_rejected_without_blocking_or_partial_chmod(self):
        self.log(LOGS[1]).unlink()
        os.mkfifo(self.log(LOGS[1]), 0o644)
        self.call("install", expected=1)
        self.assertEqual(stat.S_IMODE(self.log(LOGS[0]).stat().st_mode), 0o644)

    def test_fixture_parent_symlink_cannot_escape_to_host(self):
        (self.root / "var").rename(self.root / "held-var")
        (self.root / "var").symlink_to("/var", target_is_directory=True)
        self.call("check", expected=1)

    def test_check_is_readonly_and_reports_missing_install_and_bad_modes(self):
        before = {n: self.log(n).stat() for n in LOGS}
        result = self.call("check", expected=1)
        self.assertEqual(result["status"], "FAIL")
        self.assertGreaterEqual(len(result["violations"]), 2)
        for n in LOGS:
            after = self.log(n).stat()
            self.assertEqual((before[n].st_ino, before[n].st_mode, before[n].st_mtime_ns),
                             (after.st_ino, after.st_mode, after.st_mtime_ns))

    def test_installed_and_log_permission_drift_are_rejected(self):
        self.call("install")
        self.assertEqual(self.call("check")["status"], "PASS")
        target = self.root / "etc/logrotate.d/openclaude-v5-selfhost"
        target.write_bytes(target.read_bytes() + b"# drift\n")
        self.call("check", expected=1)
        self.call("install")
        self.log(LOGS[0]).chmod(0o644)
        self.call("check", expected=1)

    def test_bundle_missing_component_and_unknown_manifest_fail(self):
        for rel in FILES:
            path = self.bundle / rel
            data = path.read_bytes()
            path.unlink()
            self.call("validate", expected=1)
            path.write_bytes(data)
        manifest = self.bundle / FILES[1]
        for value in (2, True, "1"):
            data = json.loads(manifest.read_text())
            data["generation"] = value
            manifest.write_text(json.dumps(data))
            self.call("validate", expected=1)

    def test_global_view_keeps_options_and_siblings_without_duplicate_old_snippets(self):
        result = self.call("install")
        view = Path(result["evidenceDir"]) / "view"
        text = (view / "logrotate.conf").read_text()
        self.assertIn("su root adm\nweekly\nrotate 4\n", text)
        self.assertEqual(text.count("include "), 1)
        self.assertNotIn("include /etc/logrotate.d", text)
        self.assertEqual({p.name for p in (view / "logrotate.d").iterdir()},
                         {"sibling", "openclaude-v5-selfhost", "openclaude-v5-selfhost-egress-watch"})

    def test_duplicate_sibling_rejected_before_install_or_permissions(self):
        (self.root / "etc/logrotate.d/duplicate").write_text(
            str(self.log(LOGS[0])) + " {\nmissingok\nrotate 2\n}\n")
        self.call("install", expected=1)
        self.assertEqual(stat.S_IMODE(self.log(LOGS[0]).stat().st_mode), 0o644)
        self.assertFalse((self.root / policy.INSTALLED[HELPER]).exists())

    def test_invalid_candidate_rejected_before_install_or_permissions(self):
        (self.bundle / FILES[2]).write_text("/var/log/openclaude-v5-selfhost.log {\nrotate wrong\n}\n")
        self.call("install", expected=1)
        self.assertEqual(stat.S_IMODE(self.log(LOGS[0]).stat().st_mode), 0o644)
        self.assertFalse((self.root / policy.INSTALLED[HELPER]).exists())

    def test_real_two_rotations_preserve_current_writer_and_private_archives(self):
        expected_options = ["daily", "maxsize 200M", "rotate 14", "compress",
                            "delaycompress", "missingok", "notifempty", "copytruncate"]
        for rel in FILES[2:]:
            options = [line.strip() for line in (self.bundle / rel).read_text().splitlines()
                       if line.strip() and not line.strip().startswith(("#", "/"))
                       and line.strip() not in ("{", "}")]
            self.assertCountEqual(options, (["su root adm"] if rel == FILES[3] else []) + expected_options)
        self.call("install")
        view = next((self.root / "evidence").glob("install-*/view/logrotate.conf"))
        master, egress = (self.log(name) for name in LOGS)
        with master.open("ab", buffering=0) as writer, egress.open("ab", buffering=0) as egress_writer:
            inodes = (os.fstat(writer.fileno()).st_ino, os.fstat(egress_writer.fileno()).st_ino)
            for turn in (1, 2):
                writer.write(("turn-" + str(turn) + "\n").encode())
                egress_writer.write(("egress-turn-" + str(turn) + "\n").encode())
                r = subprocess.run(["logrotate", "--force", "--state", str(self.root / "rotation.state"),
                                    str(view)], capture_output=True, text=True, timeout=10)
                self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
                self.assertEqual((master.stat().st_ino, egress.stat().st_ino), inodes)
            writer.write(b"writer-after-two-rotations\n")
            egress_writer.write(b"egress-writer-after-two-rotations\n")
        self.assertIn(b"writer-after-two-rotations", master.read_bytes())
        self.assertIn(b"egress-writer-after-two-rotations", egress.read_bytes())
        for name in LOGS:
            self.assertTrue(self.log(name + ".2.gz").is_file())
            with gzip.open(self.log(name + ".2.gz"), "rt") as archive:
                self.assertIn("before-", archive.read())
            for path in master.parent.glob(name + "*"):
                info = path.stat()
                self.assertEqual((info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)), (0, 0, 0o600))
        # The existing joint stanzas must continue rotating these two siblings.
        for name in ("cloudflared-v5-selfhost.log", "openclaude-v5-selfhost-watch.log"):
            self.assertTrue(self.log(name + ".2.gz").is_file())
            with gzip.open(self.log(name + ".2.gz"), "rt") as archive:
                self.assertIn("before-" + name, archive.read())
        self.call("check")

    def test_generation_rejects_partial_unknown_and_missing_new_bundle(self):
        self.assertEqual(self.generation(self.bundle, 0), "1")
        (self.bundle / ".complete").write_text('{"hostLogPolicyGeneration":2}\n')
        self.generation(self.bundle, 78)
        (self.bundle / ".complete").write_text('{"hostLogPolicyGeneration":true}\n')
        self.generation(self.bundle, 78)
        (self.bundle / ".complete").write_text('{}\n')
        self.generation(self.bundle, 78)
        legacy = self.base / "legacy"
        legacy.mkdir()
        (legacy / ".complete").write_text('{}\n')
        old_fragment = legacy / FILES[3]
        old_fragment.parent.mkdir(parents=True)
        old_fragment.write_bytes((REPO / FILES[3]).read_bytes())
        self.assertEqual(self.generation(legacy, 0), "legacy")
        partial = legacy / FILES[1]
        partial.write_bytes((REPO / FILES[1]).read_bytes())
        self.generation(legacy, 78)
        (self.bundle / ".complete").write_text('{"hostLogPolicyGeneration":1}\n')
        (self.bundle / FILES[2]).unlink()
        self.generation(self.bundle, 78)

    def test_new_marker_refuses_missing_policy_before_writing_complete(self):
        source = (REPO / "scripts/v5-selfhost-master-release-lib.sh").read_text()
        import re
        marker = re.search(r"^write_strong_release_marker_local\(\) \{[\s\S]*?^\}", source, re.M).group(0)
        (self.bundle / ".complete").unlink()
        (self.bundle / FILES[1]).unlink()
        script = 'source "$1";\n' + marker + '\nwrite_strong_release_marker_local "$2" ' + 'a'*40 + ' ' + 'a'*9 + ' 20261023-000000 2'
        result = subprocess.run(["bash", "-c", script, "_",
                                 str(REPO / "scripts/lib/v5-selfhost-host-log-policy.sh"),
                                 str(self.bundle)], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 78, result.stdout + result.stderr)
        self.assertFalse((self.bundle / ".complete").exists())

    def test_snapshot_captures_policy_before_original_bundle_changes(self):
        snap = self.base / "snapshot"
        snap.mkdir()
        result = subprocess.run(["bash", "-c", 'source "$1"; snapshot_host_log_policy "$2" "$3"',
                                 "_", str(REPO / "scripts/v5-selfhost-master-release-lib.sh"),
                                 str(self.bundle), str(snap)],
                                capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for rel in FILES:
            self.assertEqual((snap / rel).read_bytes(), (self.bundle / rel).read_bytes())
            (self.bundle / rel).write_text("changed after snapshot\n")
        self.call("install", bundle=snap, program=snap / HELPER)


if __name__ == "__main__":
    unittest.main(verbosity=2)
