#!/usr/bin/env python3
"""Offline fixed-carrier faults. No production env/DB/network/service/model I/O."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest
from dataclasses import replace
from unittest.mock import patch

sys.dont_write_bytecode = True
ROOT = Path(__file__).absolute().parents[2]
spec = importlib.util.spec_from_file_location('cc5_activation', ROOT / 'scripts/lib/v5-selfhost-cc5-activation.py')
c = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = c
spec.loader.exec_module(c)
TRAIN = 'tr-20261102T120000Z-' + 'a' * 12
TRAIN2 = 'tr-20261102T120100Z-' + 'b' * 12
TRAIN3 = 'tr-20261102T120200Z-' + 'c' * 12


class CarrierTest(unittest.TestCase):
    def setUp(self):
        # sudo CI checkouts belong to runner; root-private fixtures must instead
        # live under the already-existing /root, never weaken secure ancestors.
        parent = Path('/root') if os.geteuid() == 0 and ROOT.stat().st_uid != 0 else ROOT
        self.tmp = tempfile.TemporaryDirectory(prefix='.cc5-activation-test-', dir=parent)
        self.root = Path(self.tmp.name)
        self.config = self.root / 'config'
        self.config.mkdir(mode=0o700)
        self.releases = self.root / 'releases'
        self.releases.mkdir(mode=0o700)
        self.backups = self.root / 'backups'
        self.backups.mkdir(mode=0o700)
        self.old = self.release('rel-old', 'a' * 40)
        self.new = self.release('rel-native', 'b' * 40)
        self.later = self.release('rel-later', 'c' * 40)
        self.backup = self.backups / 'pre-cutover-20261102-120000'
        self.backup.mkdir()
        self.backup2 = self.backups / 'pre-cutover-20261102-120100'
        self.backup2.mkdir()
        self.backup3 = self.backups / 'pre-cutover-20261102-120200'
        self.backup3.mkdir()
        # Keep the real verifier's bytes but give the fixture its own trusted
        # ownership. sudo CI must not trust runner-owned checkout ancestors.
        verifier = self.root / 'v5-runtime-release-lib.sh'
        self.write(verifier, (ROOT / 'scripts/v5-runtime-release-lib.sh').read_bytes())
        watch = self.root / 'installed-watch.sh'
        self.write(watch, (ROOT / 'scripts/v5-selfhost-watch.sh').read_bytes())
        self.p = c.Paths(env=self.config / 'instance.env', request=self.config / 'activation-request.json',
                         metadata=self.config / 'deployment.json', index=self.config / 'activation-index.json',
                         releases=self.releases, backups=self.backups, history=self.config / 'history',
                         live=self.root / 'live', lock=self.config / 'deploy.lock', watch=watch,
                         library=verifier, owner=os.geteuid())
        # Pure state/atomic-fault tests use an explicit internal reader seam.
        # A separate Linux-root case below exercises the real /proc fd255 scan.
        self.carrier = c.Carrier(self.p, guard=lambda: None, reader_probe=lambda *args: None)
        self.original = b'# unrelated\nTOKEN=not-a-real-secret\nOTHER="unchanged"'
        self.write(self.p.env, self.original)
        self.p.live.symlink_to(self.new)  # Legacy STEP7 has already flipped.
        self.metadata = {'version': 2, 'task': 'AGENT-REMOTE-T1555U', 'testUid': '99', 'user': 'cc5_test',
                         'taskRoot': '/home/cc5_test/oc-agentremote-t1555u-' + 'a' * 16,
                         'profile': {'operationId': '1' * 8 + '-1111-1111-1111-' + '1' * 12,
                                     'runId': '2' * 8 + '-2222-2222-2222-' + '2' * 12},
                         'scope': {'canonicalModel': c.MODEL, 'sessionKey': 'agent:assistant:webchat:dm:fixture1234'}}
        self.write(self.p.metadata, json.dumps(self.metadata).encode())
        self.request = {'schema': 1, 'enabled': True, 'testUid': '99', 'scope': self.metadata['scope'],
                        'deploymentSha256': c.digest(self.p.metadata.read_bytes())}
        self.write(self.p.request, json.dumps(self.request).encode())
        self.write(self.p.history, self.history_line(1, self.old, self.old))

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, path, data):
        path.write_bytes(data)
        path.chmod(0o600)

    def release(self, name, sha):
        path = self.releases / name
        path.mkdir()
        (path / '.complete').write_text(json.dumps({'sourceCommit': sha}))
        (path / 'scripts').mkdir()
        self.write(path / 'scripts/v5-selfhost-watch.sh', (ROOT / 'scripts/v5-selfhost-watch.sh').read_bytes())
        return path

    def history_line(self, seq, master, previous):
        row = {'schemaVer': 3, 'seq': seq, 'ts': '2026-11-02T12:00:00Z', 'image': 'fixture-image',
               'image_id': 'sha256:' + '1' * 64, 'release': '/fixture/runtime', 'bundle': '/fixture/bundle',
               'masterRelease': str(master), 'transitionKind': 'joint', 'previousMasterRelease': str(previous)}
        fields = ['schemaVer', 'seq', 'ts', 'image', 'image_id', 'release', 'bundle', 'masterRelease',
                  'transitionKind', 'previousMasterRelease']
        row['checksum'] = hashlib.sha256(b'\0'.join(str(row[k]).encode() for k in fields)).hexdigest()
        return (json.dumps(row) + '\n').encode()

    def apply(self):
        return self.carrier.start('apply', str(self.new), 'b' * 40, TRAIN, str(self.backup), os.getpid(), str(self.old))

    def receipt(self, backup=None):
        return self.carrier.receipt((backup or self.backup) / 'cc5-activation.json')

    def finish(self):
        with self.p.history.open('ab') as stream:
            stream.write(self.history_line(2, self.new, self.old))
        return self.carrier.finalize(str(self.backup), TRAIN, os.getpid())

    def rollback(self):
        return self.carrier.start('rollback', str(self.old), 'a' * 40, TRAIN2,
                                  str(self.backup2), os.getpid(), str(self.new))

    def test_missing_request_is_noop_without_env_metadata_or_owner_io(self):
        self.p.request.unlink()
        self.p.metadata.unlink()
        self.p.env.unlink()
        self.p.watch.unlink()
        self.carrier.guard_override = lambda: self.fail('default OFF checked publisher')
        self.assertEqual(self.apply(), 'noop')
        self.assertEqual(self.carrier.guard(), 'clear')
        self.assertFalse(self.p.index.exists())

    def test_disabled_request_is_noop_and_reads_no_metadata(self):
        self.write(self.p.request, b'{"schema":1,"enabled":false}')
        self.p.metadata.unlink()
        self.p.env.unlink()
        self.assertEqual(self.apply(), 'noop')

    def test_apply_preserves_unrelated_bytes_and_uses_explicit_predecessor(self):
        self.assertEqual(self.apply(), 'applied')
        raw = self.p.env.read_bytes()
        self.assertTrue(raw.endswith(self.original))
        self.assertEqual(self.receipt()['previousMaster'], str(self.old))
        self.assertEqual(c.key_state(raw)[c.UID]['value'], '99')
        self.assertEqual(self.apply(), 'already-applied')
        self.assertEqual(self.carrier.check_restart(str(self.backup), TRAIN, os.getpid(), 'after'), 'proven')
        with self.assertRaises(c.Refused):
            self.carrier.guard()

    def test_non_lf_separators_inside_unrelated_value_are_preserved_bytes(self):
        for separator in ['\v', '\x85', '\u2028', '\u2029']:
            with self.subTest(separator=hex(ord(separator))):
                if self.p.index.exists():
                    self.p.index.unlink()
                    (self.backup / 'cc5-activation.json').unlink()
                original = ('UNRELATED=prefix' + separator + c.UID + '=ordinary-value\nTAIL=unchanged').encode('utf-8')
                self.write(self.p.env, original)
                self.assertFalse(c.key_state(original)[c.UID]['present'])
                self.assertEqual(self.apply(), 'applied')
                self.assertTrue(self.p.env.read_bytes().endswith(original))
                self.assertEqual(c.key_state(self.p.env.read_bytes())[c.UID]['value'], '99')
                self.carrier.revert(str(self.backup), TRAIN, os.getpid())
                self.assertEqual(self.p.env.read_bytes(), original)

    def test_restore_exact_presence_empty_and_quoted_values(self):
        for prefix in [b'', (c.ENABLED + '=\n').encode(),
                       (c.ENABLED + '="0"\n' + c.UID + "='17'\n").encode()]:
            with self.subTest(prefix=prefix):
                if self.p.index.exists():
                    self.p.index.unlink()
                    (self.backup / 'cc5-activation.json').unlink()
                self.write(self.p.env, prefix + self.original)
                before = c.semantic(c.key_state(self.p.env.read_bytes()))
                self.apply()
                # Tuple/unrelated writes by the real saga must survive reversal.
                with self.p.env.open('ab') as stream:
                    stream.write(b'\nADDED_BY_TUPLE=preserve\n')
                self.assertEqual(self.carrier.revert(str(self.backup), TRAIN, os.getpid()), 'reverted')
                self.assertEqual(c.semantic(c.key_state(self.p.env.read_bytes())), before)
                self.assertIn(self.original, self.p.env.read_bytes())
                self.assertIn(b'ADDED_BY_TUPLE=preserve', self.p.env.read_bytes())
                self.assertEqual(self.carrier.revert(str(self.backup), TRAIN, os.getpid()), 'already-reverted')
                self.assertEqual(self.carrier.check_restart(str(self.backup), TRAIN, os.getpid(), 'before'), 'proven')
                self.assertEqual(self.carrier.guard(), 'clear')

    def test_owner_and_metadata_failure_do_not_write(self):
        original = self.p.env.read_bytes()
        def denied():
            raise c.Refused('fixture owner denied')
        self.carrier.guard_override = denied
        with self.assertRaises(c.Refused):
            self.apply()
        self.carrier.guard_override = lambda: None
        self.request['deploymentSha256'] = '0' * 64
        self.write(self.p.request, json.dumps(self.request).encode())
        with self.assertRaises(c.Refused):
            self.apply()
        self.assertEqual(self.p.env.read_bytes(), original)
        self.assertFalse(self.p.index.exists())

    def test_wrong_installed_watch_digest_blocks_before_receipt_or_env(self):
        self.write(self.p.watch, self.p.watch.read_bytes() + b'\n# stale installed digest\n')
        with self.assertRaises(c.Refused):
            self.apply()
        self.assertEqual(self.p.env.read_bytes(), self.original)
        self.assertFalse(self.p.index.exists())
        self.assertFalse((self.backup / 'cc5-activation.json').exists())

    def test_matching_watch_without_guard_blocks_before_receipt_or_env(self):
        trusted = self.new / 'scripts/v5-selfhost-watch.sh'
        old = trusted.read_bytes().replace(b'# CC5 activation mutation guard v1', b'# old watch without activation guard')
        self.write(trusted, old)
        self.write(self.p.watch, old)
        with self.assertRaises(c.Refused):
            self.apply()
        self.assertEqual(self.p.env.read_bytes(), self.original)
        self.assertFalse(self.p.index.exists())

    def test_rollback_checks_current_native_watch_not_old_target(self):
        self.apply()
        self.finish()
        self.write(self.old / 'scripts/v5-selfhost-watch.sh', b'# old rollback target without guard\n')
        self.assertEqual(self.rollback(), 'applied')

    @unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0,
                         'real installer /proc/stat and carrier reader checks require Linux root')
    def test_real_rollback_guard_installer_retains_native_watch_until_carrier_commit(self):
        # A is the older target without the CC5 marker. B is the current native
        # release. Actual watch/probe scripts and atomic copy functions execute;
        # only service/owner leaves are fixtures, with no service or network I/O.
        watch_dir = self.root / 'installed-watch'
        watch_dir.mkdir(mode=0o700)
        self.p = replace(self.p, watch=watch_dir / 'watch.sh')
        self.carrier = c.Carrier(self.p, guard=lambda: None)
        native_watch = (self.new / 'scripts/v5-selfhost-watch.sh').read_bytes()
        old_watch = native_watch.replace(b'# CC5 activation mutation guard v1', b'# old A without CC5 guard')
        self.write(self.old / 'scripts/v5-selfhost-watch.sh', old_watch)
        native_alert = (ROOT / 'scripts/v5-selfhost-watch-alert.sh').read_bytes()
        old_alert = native_alert + b'\n# old target A alert\n'
        self.write(self.new / 'scripts/v5-selfhost-watch-alert.sh', native_alert)
        self.write(self.old / 'scripts/v5-selfhost-watch-alert.sh', old_alert)
        self.write(self.p.watch, native_watch)
        self.write(watch_dir / 'alert.sh', native_alert)
        self.assertEqual(self.apply(), 'applied')
        self.assertEqual(self.finish(), 'committed')

        policy = ROOT / 'scripts/lib/v5-selfhost-release-policy.sh'
        deploy = ROOT / 'scripts/deploy-v5-selfhost.sh'
        def function(path, name):
            match = re.search(r'^' + name + r'\(\) \{.*?^\}(?=\n(?:\n|$))',
                              path.read_text(), re.M | re.S)
            self.assertIsNotNone(match, 'missing real production function: ' + name)
            return match[0]

        policy_bytes = (ROOT / 'scripts/lib/v5-release-policy.py').read_bytes()
        trusted_policy = self.root / 'trusted-policy.py'
        self.write(trusted_policy, policy_bytes)
        for release in (self.old, self.new):
            (release / 'scripts/lib').mkdir()
            self.write(release / 'scripts/lib/v5-release-policy.py', policy_bytes)
            for name in ('v5-lease-worker.sh', 'v5-lease-lib.sh'):
                self.write(release / 'scripts' / name, (ROOT / 'scripts' / name).read_bytes())
        candidate_policy = self.old / 'scripts/lib/v5-release-policy.py'
        variables = {'V5_WATCH_DIR': watch_dir, 'RELEASE_POLICY_HELPER': trusted_policy,
                     'RELEASE_POLICY_CONTEXT': self.config / 'absent-policy.json',
                     'MASTER_LIVE_LINK': self.p.live, 'A': self.old, 'B': self.new}
        script = self.root / 'real-installer.sh'
        script.write_text('\n'.join([
            'set -Eeuo pipefail', 'DRY=0; CUTOVER_ROLLBACK=1',
            *[name + '=' + shlex.quote(str(value)) for name, value in variables.items()],
            'WATCH_SYNC_FILES=("v5-selfhost-watch.sh:watch.sh" "v5-selfhost-watch-alert.sh:alert.sh")',
            'release_policy_enabled() { return 0; }',
            'release_policy_require_owner() { return 0; }',
            'release_policy_drain_reader() { return 0; }',
            'release_policy_assert_no_service_jobs() { return 0; }',
            'log() { :; }',
            *[function(deploy, name) for name in ('watch_install_state', 'install_watch_file', 'sync_watch_from')],
            *[function(policy, name) for name in ('release_policy_watch_readers', 'release_policy_drain_watch_readers',
                                                'release_policy_install_guards')],
            'case "$1" in install) release_policy_install_guards "$A" "$B" ;; '
            'inverse) release_policy_install_guards "$B" "$A" ;; *) sync_watch_from "$A" ;; esac',
        ]) + '\n')
        def run(action):
            return subprocess.run(['/bin/bash', str(script), action], capture_output=True, timeout=20,
                                  env={'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'})

        # Rollback changes only the watch source to B. Candidate helper
        # verification must still reject an incorrect helper in target A.
        self.write(candidate_policy, policy_bytes + b'\n# wrong A helper\n')
        rejected = run('install')
        self.assertEqual(rejected.returncode, 2, rejected.stderr)
        self.assertEqual(self.p.watch.read_bytes(), native_watch)
        self.write(candidate_policy, policy_bytes)
        installed = run('install')
        self.assertEqual(installed.returncode, 0, installed.stderr)
        self.assertEqual(self.p.watch.read_bytes(), native_watch)
        self.assertEqual((watch_dir / 'alert.sh').read_bytes(), native_alert)
        self.assertEqual(self.rollback(), 'applied')

        # Close the real carrier against real history/live proof before the
        # production atomic late-sync installs A (ordering also has wiring tests).
        with self.p.history.open('ab') as stream:
            stream.write(self.history_line(3, self.old, self.new))
        self.p.live.unlink()
        self.p.live.symlink_to(self.old)
        self.assertEqual(self.carrier.finalize(str(self.backup2), TRAIN2, os.getpid()), 'committed')
        late = run('late-sync')
        self.assertEqual(late.returncode, 0, late.stderr)
        self.assertEqual(self.p.watch.read_bytes(), old_watch)
        self.assertEqual((watch_dir / 'alert.sh').read_bytes(), old_alert)
        # Official inverse: A is now the native predecessor but has no guard.
        # The real installer must securely select candidate B, then the carrier
        # must apply and finalize a new inverse receipt without losing origin.
        inverse_install = run('inverse')
        self.assertEqual(inverse_install.returncode, 0, inverse_install.stderr)
        self.assertEqual(self.p.watch.read_bytes(), native_watch)
        self.assertEqual((watch_dir / 'alert.sh').read_bytes(), native_alert)
        self.assertEqual(self.carrier.start('rollback', str(self.new), 'b' * 40, TRAIN3,
                                           str(self.backup3), os.getpid(), str(self.old)), 'applied')
        with self.p.history.open('ab') as stream:
            stream.write(self.history_line(4, self.new, self.old))
        self.p.live.unlink()
        self.p.live.symlink_to(self.new)
        self.assertEqual(self.carrier.finalize(str(self.backup3), TRAIN3, os.getpid()), 'committed')
        self.assertEqual(c.key_state(self.p.env.read_bytes())[c.ENABLED]['value'], '1')
        self.assertEqual(c.key_state(self.p.env.read_bytes())[c.UID]['value'], '99')

    def test_already_configured_forward_does_not_add_watch_readiness_boundary(self):
        self.apply()
        self.finish()
        self.p.watch.unlink()
        self.assertEqual(self.carrier.start('apply', str(self.later), 'c' * 40, TRAIN2,
                                           str(self.backup2), os.getpid(), str(self.new)), 'already-configured')

    def test_duplicate_request_and_env_keys_reject(self):
        original = self.p.env.read_bytes()
        self.write(self.p.request, b'{"schema":1,"schema":1,"enabled":false}')
        with self.assertRaises(c.Refused):
            self.apply()
        self.write(self.p.request, json.dumps(self.request).encode())
        self.write(self.p.env, (c.UID + '=99\n' + c.UID + '=88\n').encode() + original)
        with self.assertRaises(c.Refused):
            self.apply()
        self.assertFalse(self.p.index.exists())

    def test_lost_env_replace_ack_is_unknown_not_replayed_and_can_restore(self):
        replace = c.os.replace
        def lost_ack(source, target):
            replace(source, target)
            if Path(target) == self.p.env:
                raise OSError('fixture lost acknowledgement')
        with patch.object(c.os, 'replace', side_effect=lost_ack):
            with self.assertRaises(c.Unknown):
                self.apply()
        self.assertEqual(self.receipt()['phase'], 'unknown')
        for action in [self.apply, self.carrier.guard,
                       lambda: self.carrier.check_restart(str(self.backup), TRAIN, os.getpid(), 'after')]:
            with self.assertRaises(c.Refused):
                action()
        self.assertEqual(self.carrier.revert(str(self.backup), TRAIN, os.getpid()), 'reverted')
        self.assertEqual(self.p.env.read_bytes(), self.original)

    def test_index_replace_ack_loss_holds_before_any_env_effect(self):
        replace = c.os.replace
        def lost_index(source, target):
            replace(source, target)
            if Path(target) == self.p.index:
                raise OSError('fixture lost index acknowledgement')
        with patch.object(c.os, 'replace', side_effect=lost_index):
            with self.assertRaises(c.Unknown):
                self.apply()
        self.assertEqual(self.p.env.read_bytes(), self.original)
        self.assertEqual(self.receipt()['phase'], 'prepared')
        with self.assertRaises(c.Refused):
            self.carrier.guard()
        self.carrier.revert(str(self.backup), TRAIN, os.getpid())
        self.assertEqual(self.carrier.guard(), 'clear')

    def test_after_replace_receipt_failure_cannot_authorize_restart(self):
        save = self.carrier.save
        def fail_applied(path, value, caller):
            if value.get('phase') == 'applied':
                raise OSError('fixture applied receipt failure')
            return save(path, value, caller)
        with patch.object(self.carrier, 'save', side_effect=fail_applied):
            with self.assertRaises(c.Unknown):
                self.apply()
        self.assertEqual(c.key_state(self.p.env.read_bytes())[c.ENABLED]['value'], '1')
        self.assertEqual(self.receipt()['phase'], 'unknown')
        with self.assertRaises(c.Refused):
            self.carrier.check_restart(str(self.backup), TRAIN, os.getpid(), 'after')
        self.carrier.revert(str(self.backup), TRAIN, os.getpid())
        self.assertEqual(self.p.env.read_bytes(), self.original)

    def test_failed_restore_prevents_old_restart_guard(self):
        self.apply()
        replace = c.os.replace
        def fail_env(source, target):
            if Path(target) == self.p.env:
                raise OSError('fixture restore failure')
            return replace(source, target)
        with patch.object(c.os, 'replace', side_effect=fail_env):
            with self.assertRaises(c.Unknown):
                self.carrier.revert(str(self.backup), TRAIN, os.getpid())
        self.assertEqual(self.receipt()['phase'], 'reverting')
        with self.assertRaises(c.Refused):
            self.carrier.check_restart(str(self.backup), TRAIN, os.getpid(), 'before')
        self.carrier.revert(str(self.backup), TRAIN, os.getpid())
        self.assertEqual(self.carrier.check_restart(str(self.backup), TRAIN, os.getpid(), 'before'), 'proven')

    def test_third_state_is_never_overwritten(self):
        self.apply()
        third = self.p.env.read_bytes().replace((c.UID + '=99').encode(), (c.UID + '=100').encode())
        self.write(self.p.env, third)
        with self.assertRaises(c.Refused):
            self.carrier.revert(str(self.backup), TRAIN, os.getpid())
        self.assertEqual(self.p.env.read_bytes(), third)

    def test_failed_activation_new_train_retries_without_deleting_index(self):
        self.apply()
        self.carrier.revert(str(self.backup), TRAIN, os.getpid())
        self.assertFalse(c.key_state(self.p.env.read_bytes())[c.ENABLED]['present'])
        self.assertEqual(self.carrier.start('apply', str(self.later), 'c' * 40, TRAIN2,
                                           str(self.backup2), os.getpid(), str(self.new)), 'applied')
        self.assertEqual(c.key_state(self.p.env.read_bytes())[c.ENABLED]['value'], '1')
        self.assertEqual(self.receipt(self.backup2)['previousReceipt'], str(self.backup / 'cc5-activation.json'))
        self.assertEqual(self.receipt()['phase'], 'reverted')

    def test_multiline_unrelated_env_assignment_is_ambiguous_and_unchanged(self):
        ambiguous = b'TOKEN="multiline\n' + (c.UID + '=99\n').encode() + b'closing"\n'
        self.write(self.p.env, ambiguous)
        with self.assertRaises(c.Refused):
            self.apply()
        self.assertEqual(self.p.env.read_bytes(), ambiguous)
        self.assertFalse(self.p.index.exists())

    def test_finalize_requires_real_checksum_candidate_and_preserves_origin(self):
        self.apply()
        valid = self.history_line(2, self.new, self.old)
        bad = json.loads(valid)
        bad['checksum'] = '0' * 64
        old_history = self.p.history.read_bytes()
        self.write(self.p.history, old_history + json.dumps(bad).encode() + b'\n')
        with self.assertRaises(c.Refused):
            self.carrier.finalize(str(self.backup), TRAIN, os.getpid())
        self.assertEqual(self.receipt()['phase'], 'applied')
        self.write(self.p.history, old_history + valid)
        self.assertEqual(self.carrier.finalize(str(self.backup), TRAIN, os.getpid()), 'committed')
        self.assertEqual(self.carrier.finalize(str(self.backup), TRAIN, os.getpid()), 'already-committed')
        self.assertEqual(self.carrier.guard(), 'clear')
        self.assertEqual(self.carrier.start('apply', str(self.later), 'c' * 40, TRAIN2,
                                           str(self.backup2), os.getpid(), str(self.new)), 'already-configured')
        self.assertFalse((self.backup2 / 'cc5-activation.json').exists())
        self.assertEqual(self.carrier.finalize(str(self.backup2), TRAIN2, os.getpid()), 'noop')
        self.assertEqual(self.carrier.discover()['train'], TRAIN)

    def test_receipt_does_not_false_hold_after_origin_release_gc(self):
        self.apply()
        self.finish()
        shutil.rmtree(self.old)
        shutil.rmtree(self.new)
        self.assertEqual(self.carrier.guard(), 'clear')
        self.assertEqual(self.carrier.discover()['train'], TRAIN)

    def test_finalize_same_train_resume_discovers_original_backup(self):
        self.apply()
        with self.p.history.open('ab') as stream:
            stream.write(self.history_line(2, self.new, self.old))
        self.assertEqual(self.carrier.finalize('', TRAIN, os.getpid()), 'committed')
        self.assertEqual(self.carrier.finalize('', TRAIN, os.getpid()), 'already-committed')
        self.assertEqual(self.receipt()['phase'], 'committed')
        self.assertEqual(self.carrier.guard(), 'clear')

    def test_finalize_empty_backup_never_closes_foreign_pending_receipt(self):
        self.apply()
        with self.p.history.open('ab') as stream:
            stream.write(self.history_line(2, self.new, self.old))
        before = (self.backup / 'cc5-activation.json').read_bytes()
        with self.assertRaises(c.Refused):
            self.carrier.finalize('', TRAIN2, os.getpid())
        self.assertEqual((self.backup / 'cc5-activation.json').read_bytes(), before)
        self.assertEqual(self.receipt()['phase'], 'applied')
        # Explicit backup keeps its existing strict operation match.
        with self.assertRaises(c.Refused):
            self.carrier.finalize(str(self.backup), TRAIN2, os.getpid())
        self.carrier.finalize('', TRAIN, os.getpid())
        self.assertEqual(self.carrier.finalize('', TRAIN2, os.getpid()), 'noop')

    def test_finalize_resume_still_requires_real_history_checksum(self):
        self.apply()
        row = json.loads(self.history_line(2, self.new, self.old))
        row['checksum'] = '0' * 64
        self.write(self.p.history, self.p.history.read_bytes() + json.dumps(row).encode() + b'\n')
        with self.assertRaises(c.Refused):
            self.carrier.finalize('', TRAIN, os.getpid())
        self.assertEqual(self.receipt()['phase'], 'applied')

    def test_official_boundary_rollback_has_its_own_failure_undo(self):
        self.apply()
        self.finish()
        self.assertEqual(self.rollback(), 'applied')
        self.assertFalse(c.key_state(self.p.env.read_bytes())[c.ENABLED]['present'])
        self.assertEqual(self.receipt(self.backup2)['kind'], 'rollback')
        self.assertEqual(self.receipt()['phase'], 'committed')
        self.assertEqual(self.carrier.check_restart(str(self.backup2), TRAIN2, os.getpid(), 'after'), 'proven')
        self.carrier.revert(str(self.backup2), TRAIN2, os.getpid())
        self.assertEqual(c.key_state(self.p.env.read_bytes())[c.ENABLED]['value'], '1')
        self.assertEqual(self.carrier.check_restart(str(self.backup2), TRAIN2, os.getpid(), 'before'), 'proven')
        # A fresh genuine rollback operation can retry the original boundary;
        # the failed inverse did not destroy the committed origin.
        self.assertEqual(self.carrier.start('rollback', str(self.old), 'a' * 40, TRAIN3,
                                           str(self.backup3), os.getpid(), str(self.new)), 'applied')

    def test_rollback_between_later_releases_keeps_enabled_configuration(self):
        self.apply()
        self.finish()
        with self.p.history.open('ab') as stream:
            stream.write(self.history_line(3, self.later, self.new))
        self.assertEqual(self.carrier.start('rollback', str(self.new), 'b' * 40, TRAIN2,
                                           str(self.backup2), os.getpid(), str(self.later)), 'noop')
        self.assertEqual(c.key_state(self.p.env.read_bytes())[c.ENABLED]['value'], '1')
        self.assertFalse((self.backup2 / 'cc5-activation.json').exists())

    def test_successful_inverse_can_finalize_and_be_rolled_forward(self):
        old_watch = (self.old / 'scripts/v5-selfhost-watch.sh').read_bytes().replace(
            c.WATCH_GUARD, b'# historical watch without activation guard')
        self.write(self.old / 'scripts/v5-selfhost-watch.sh', old_watch)
        self.apply()
        self.finish()
        self.rollback()
        with self.p.history.open('ab') as stream:
            stream.write(self.history_line(3, self.old, self.new))
        self.p.live.unlink()
        self.p.live.symlink_to(self.old)
        self.assertEqual(self.carrier.finalize(str(self.backup2), TRAIN2, os.getpid()), 'committed')
        self.assertEqual(self.carrier.start('rollback', str(self.new), 'b' * 40, TRAIN3,
                                           str(self.backup3), os.getpid(), str(self.old)), 'applied')
        self.assertEqual(c.key_state(self.p.env.read_bytes())[c.ENABLED]['value'], '1')

    def test_inverse_missing_previous_watch_is_unknown_not_candidate_fallback(self):
        self.apply()
        self.finish()
        self.rollback()
        with self.p.history.open('ab') as stream:
            stream.write(self.history_line(3, self.old, self.new))
        self.p.live.unlink()
        self.p.live.symlink_to(self.old)
        self.carrier.finalize(str(self.backup2), TRAIN2, os.getpid())
        (self.old / 'scripts/v5-selfhost-watch.sh').unlink()
        before = self.p.env.read_bytes()
        with self.assertRaises((c.Refused, OSError)):
            self.carrier.start('rollback', str(self.new), 'b' * 40, TRAIN3,
                               str(self.backup3), os.getpid(), str(self.old))
        self.assertEqual(self.p.env.read_bytes(), before)
        self.assertFalse((self.backup3 / 'cc5-activation.json').exists())

    def test_index_and_env_symlinks_fail_closed(self):
        self.p.index.symlink_to(self.p.request)
        with self.assertRaises(c.Refused):
            self.carrier.guard()
        self.p.index.unlink()
        self.p.env.unlink()
        self.p.env.symlink_to(self.p.metadata)
        with self.assertRaises(c.Refused):
            self.apply()

    @unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0,
                         'runner-owned verifier rejection requires Linux root ownership fixture')
    def test_runner_owned_verifier_rejects_then_root_owned_real_copy_finalizes(self):
        self.apply()
        with self.p.history.open('ab') as stream:
            stream.write(self.history_line(2, self.new, self.old))
        runner_verifier = self.root / 'runner-owned-verifier.sh'
        self.write(runner_verifier, self.p.library.read_bytes())
        os.chown(runner_verifier, 65534, -1)
        untrusted = c.Carrier(replace(self.p, library=runner_verifier), guard=lambda: None)
        with self.assertRaises(c.Refused):
            untrusted.finalize(str(self.backup), TRAIN, os.getpid())
        self.assertEqual(self.receipt()['phase'], 'applied')
        self.assertEqual(self.p.library.stat().st_uid, 0)
        self.assertEqual(self.p.library.read_bytes(), (ROOT / 'scripts/v5-runtime-release-lib.sh').read_bytes())
        self.assertEqual(self.carrier.finalize(str(self.backup), TRAIN, os.getpid()), 'committed')

    @unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0,
                         'real /proc retired-watch reader proof requires Linux root')
    def test_real_fd255_reader_of_replaced_watch_blocks_new_env_write(self):
        reader = subprocess.Popen(['/bin/bash', '-c', 'exec 255<"$1"; printf ready; read -r _',
                                   'fixture-reader', str(self.p.watch)], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        try:
            self.assertEqual(reader.stdout.read(5), b'ready')
            replacement = self.root / 'new-watch.sh'
            self.write(replacement, self.p.watch.read_bytes())
            os.replace(replacement, self.p.watch)
            self.carrier.reader_probe = c.watch_readers
            with self.assertRaises(c.Refused):
                self.apply()
            self.assertEqual(self.p.env.read_bytes(), self.original)
            self.assertFalse(self.p.index.exists())
            reader.stdin.write(b'quit\n')
            reader.stdin.flush()
            reader.wait(timeout=5)
            self.assertEqual(self.apply(), 'applied')
        finally:
            if reader.poll() is None:
                reader.terminate()
                reader.wait(timeout=5)
            reader.stdin.close()
            reader.stdout.close()

    @unittest.skipUnless(sys.platform == 'linux', 'real /proc fdinfo flock proof requires Linux')
    def test_real_inherited_exclusive_flock_and_holder_start_ticks(self):
        import fcntl
        self.write(self.p.lock, b'')
        holder = Path(str(self.p.lock) + '.holder')
        started = c.process_identity(os.getpid())[1]
        self.write(holder, f'pid={os.getpid()} starttime={started}\n'.encode())
        try:
            saved = os.dup(8)
        except OSError:
            saved = None
        fd = os.open(self.p.lock, os.O_RDWR)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            os.dup2(fd, 8, inheritable=True)
            c.lock_owned(os.getpid(), self.p.lock, self.p.owner)
            self.carrier.guard_override = lambda: c.lock_owned(os.getpid(), self.p.lock, self.p.owner)
            self.apply()
            self.write(holder, f'pid={os.getpid()} starttime=0\n'.encode())
            with self.assertRaises(c.Refused):
                self.carrier.revert(str(self.backup), TRAIN, os.getpid())
            self.write(holder, f'pid={os.getpid()} starttime={started}\n'.encode())
            fcntl.flock(fd, fcntl.LOCK_UN)
            with self.assertRaises(c.Refused):
                c.lock_owned(os.getpid(), self.p.lock, self.p.owner)
        finally:
            if saved is None:
                os.close(8)
            else:
                os.dup2(saved, 8)
                os.close(saved)
            if fd != 8:
                os.close(fd)


if __name__ == '__main__':
    unittest.main()
