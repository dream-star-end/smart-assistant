#!/usr/bin/env python3
"""Isolated fixed-key tests; never reads production env or credentials."""
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / 'scripts/lib/v5-selfhost-cc5-bootstrap.py'
SPEC = importlib.util.spec_from_file_location('cc5_bootstrap', HELPER)
BOOT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BOOT)
SHA = 'a' * 40


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        # Mac/non-root runs stay in the writable checkout. Hosted CI invokes
        # these tests with sudo but the checkout belongs to the runner, so a
        # root-owned fixture must instead live beneath an existing private
        # root directory. Do not relax the production ancestor ownership rule.
        fixture_parent = ROOT
        if os.geteuid() == 0 and ROOT.stat().st_uid != 0:
            fixture_parent = Path('/root')
            info = BOOT.secure_path(fixture_parent)
            self.assertTrue(fixture_parent.is_dir() and info.st_mode & 0o077 == 0,
                            'root fixture parent must already exist and be private')
        self.temp = tempfile.TemporaryDirectory(prefix='.cc5-bootstrap-test-', dir=fixture_parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = self.root / 'fixture.env'
        self.env.write_bytes(b'OTHER_KEY=synthetic-sentinel\n')
        self.env.chmod(0o600)
        self.owner = os.getuid()

    def write(self, data):
        self.env.write_bytes(data)
        self.env.chmod(0o600)

    def apply(self, guard=lambda: None):
        return BOOT.apply_file(self.env, guard, owner=self.owner)

    def test_single_append_preserves_all_other_bytes_and_is_idempotent(self):
        data = b'# synthetic only\nOTHER_KEY="two words"\nUNQUOTED=a\'b\n'
        self.write(data)
        self.assertEqual(self.apply(), 'enabled')
        expected = data + (BOOT.ADMIN + '=1\n').encode()
        self.assertEqual(self.env.read_bytes(), expected)
        inode = self.env.stat().st_ino
        self.assertEqual(self.apply(), 'already-enabled')
        self.assertEqual(self.env.read_bytes(), expected)
        self.assertEqual(self.env.stat().st_ino, inode)
        self.assertEqual(self.env.stat().st_mode & 0o777, 0o600)

    def test_missing_final_newline_gets_one_separator(self):
        self.write(b'OTHER_KEY=value')
        self.apply()
        self.assertEqual(self.env.read_bytes(), b'OTHER_KEY=value\n' + (BOOT.ADMIN + '=1\n').encode())

    def test_model_off_spellings(self):
        for value in ('', '0', 'false', '"0"', "'false'"):
            with self.subTest(value=value):
                self.write((BOOT.MODEL + '=' + value + '\n').encode())
                self.assertEqual(self.apply(), 'enabled')

    def test_conflicts_and_ambiguous_syntax_leave_file_unchanged(self):
        rows = [
            BOOT.MODEL + '=1\n', BOOT.MODEL + '=true\n',
            BOOT.UID + '=\n', BOOT.UID + '=314\n',
            BOOT.ADMIN + '=0\n', BOOT.ADMIN + '=\n',
            BOOT.ADMIN + '=1\n' + BOOT.ADMIN + '=1\n',
            BOOT.MODEL + '=0\n' + BOOT.MODEL + '=false\n',
            'OTHER_KEY="first\nsecond"\n',
            "OTHER_KEY='first' 'second'\n",
            'OTHER_KEY=value\\\n' + BOOT.UID + '=314\n',
            '# comment continues \\\n' + BOOT.UID + '=314\n',
            'OTHER_KEY=value\r\n', 'OTHER_KEY=one\x00two\n',
        ]
        for text in rows:
            with self.subTest(case=rows.index(text)):
                data = text.encode()
                self.write(data)
                with self.assertRaises(BOOT.Refused):
                    self.apply()
                self.assertEqual(self.env.read_bytes(), data)

    def test_unavailable_lock_refuses_before_any_file_read(self):
        def refuse():
            raise BOOT.Refused('test guard')
        self.env.unlink()
        with self.assertRaisesRegex(BOOT.Refused, 'test guard'):
            self.apply(refuse)

    def test_symlink_hardlink_permissions_and_owner_are_rejected(self):
        original = self.env.read_bytes()
        target = self.root / 'target.env'
        self.env.rename(target)
        self.env.symlink_to(target)
        with self.assertRaises(BOOT.Refused):
            self.apply()
        self.assertEqual(target.read_bytes(), original)
        self.env.unlink()
        os.link(target, self.env)
        with self.assertRaises(BOOT.Refused):
            self.apply()
        self.env.unlink()
        target.rename(self.env)
        self.env.chmod(0o640)
        with self.assertRaises(BOOT.Refused):
            self.apply()
        self.env.chmod(0o600)
        with self.assertRaises(BOOT.Refused):
            BOOT.apply_file(self.env, lambda: None, owner=self.owner + 1)
        self.assertEqual(self.env.read_bytes(), original)

    def test_changed_identity_before_replace_is_not_overwritten(self):
        count = 0
        def change():
            nonlocal count
            count += 1
            if count == 2:
                self.env.write_bytes(b'OTHER_KEY=concurrent-change\n')
        with self.assertRaises(BOOT.Refused):
            self.apply(change)
        self.assertEqual(self.env.read_bytes(), b'OTHER_KEY=concurrent-change\n')
        self.assertEqual(list(self.root.glob('.cc5-bootstrap-*')), [])

    def test_rename_ack_loss_is_reported_as_uncertain(self):
        real_replace = os.replace
        def lost_ack(source, destination):
            real_replace(source, destination)
            raise OSError('synthetic lost acknowledgement')
        with patch.object(BOOT.os, 'replace', side_effect=lost_ack):
            with self.assertRaises(BOOT.OutcomeUncertain):
                self.apply()
        self.assertIn((BOOT.ADMIN + '=1\n').encode(), self.env.read_bytes())

    def candidate(self, policy):
        (self.root / 'deploy/v5-selfhost').mkdir(parents=True)
        (self.root / '.complete').write_text(json.dumps({'sourceCommit': SHA}))
        (self.root / BOOT.POLICY).write_text(policy)

    def test_default_disabled_cli_reads_no_production_env(self):
        self.candidate('{"adminCreateEnabled":false}')
        # main's OFF path must not call the writer or any lock/identity guard.
        with patch.object(sys, 'argv', [str(HELPER), str(self.root), SHA, str(os.getpid())]), \
                patch.object(BOOT, 'apply_file', side_effect=AssertionError('writer called')), \
                patch.object(BOOT, 'lock_owned', side_effect=AssertionError('lock called')):
            BOOT.main()

    def test_policy_type_extra_key_duplicates_and_source_mismatch_refuse(self):
        self.candidate('{"adminCreateEnabled":false}')
        for policy in ('{"adminCreateEnabled":1}', '{"adminCreateEnabled":true,"other":false}',
                       '{"adminCreateEnabled":false,"adminCreateEnabled":true}', '[]'):
            with self.subTest(policy=policy):
                (self.root / BOOT.POLICY).write_text(policy)
                with self.assertRaises(BOOT.Refused):
                    BOOT.policy_enabled(self.root, SHA)
        (self.root / BOOT.POLICY).write_text('{"adminCreateEnabled":false}')
        with self.assertRaises(BOOT.Refused):
            BOOT.policy_enabled(self.root, 'b' * 40)

    def test_cli_errors_do_not_quote_policy_or_env_contents(self):
        self.candidate('{SYNTHETIC_SECRET_MUST_NOT_APPEAR}')
        result = subprocess.run([sys.executable, str(HELPER), str(self.root), SHA, str(os.getpid())],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertNotIn('SYNTHETIC_SECRET', result.stdout + result.stderr)
        self.assertNotIn('Traceback', result.stderr)

    @unittest.skipUnless(sys.platform.startswith('linux'), 'real /proc flock evidence requires Linux')
    def test_official_bash_flock_subprocess_then_python_inherited_descriptor(self):
        lock = self.root / 'official-deploy.lock'
        lock.touch(mode=0o600)
        script = r'''set -euo pipefail
exec 8<>"$1"
flock -n 8
ticks="$("$3" -c 'import pathlib,sys; s=(pathlib.Path("/proc")/sys.argv[1]/"stat").read_text(); print(s[s.rfind(")")+2:].split()[19])' "$$")"
printf 'pid=%s user=fixture tree=fixture starttime=%s\n' "$$" "$ticks" >"$1.holder"
chmod 600 "$1.holder"
"$3" - "$2" "$1" "$$" <<'CHECK'
import importlib.util,os,pathlib,sys
spec=importlib.util.spec_from_file_location('bootstrap',sys.argv[1])
helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
helper.lock_owned(int(sys.argv[3]),lock=pathlib.Path(sys.argv[2]),owner=os.getuid())
print('official-flock-fixture-owned')
CHECK
'''
        result = subprocess.run(['bash', '--noprofile', '--norc', '-c', script, 'fixture',
                                 str(lock), str(HELPER), sys.executable], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), 'official-flock-fixture-owned')

    @unittest.skipUnless(sys.platform.startswith('linux'), 'real /proc flock evidence requires Linux')
    def test_real_inherited_flock_and_bad_holder_or_inode(self):
        lock = self.root / 'deploy.lock'
        lock.touch(mode=0o600)
        holder = Path(str(lock) + '.holder')
        caller = os.getpid()
        ticks = BOOT.process_identity(caller)[1]
        holder.write_text(f'pid={caller} user=fixture tree=fixture starttime={ticks}\n')
        holder.chmod(0o600)
        prior = None
        try:
            prior = os.dup(8)
        except OSError:
            pass
        fd = os.open(lock, os.O_RDWR)
        os.dup2(fd, 8)
        if fd != 8:
            os.close(fd)
        try:
            with self.assertRaises(BOOT.Refused):
                BOOT.lock_owned(caller, lock=lock, owner=self.owner)
            fcntl.flock(8, fcntl.LOCK_EX | fcntl.LOCK_NB)
            BOOT.lock_owned(caller, lock=lock, owner=self.owner)
            holder.write_text(f'pid={caller} starttime={ticks + 1}\n')
            with self.assertRaises(BOOT.Refused):
                BOOT.lock_owned(caller, lock=lock, owner=self.owner)
            holder.write_text('pid=1 starttime=1\n')
            with self.assertRaises(BOOT.Refused):
                BOOT.lock_owned(caller, lock=lock, owner=self.owner)
            holder.write_text(f'pid={caller} starttime={ticks}\n')
            lock.rename(self.root / 'old.lock')
            lock.touch(mode=0o600)
            with self.assertRaises(BOOT.Refused):
                BOOT.lock_owned(caller, lock=lock, owner=self.owner)
        finally:
            os.close(8)
            if prior is not None:
                os.dup2(prior, 8)
                os.close(prior)


if __name__ == '__main__':
    unittest.main()
