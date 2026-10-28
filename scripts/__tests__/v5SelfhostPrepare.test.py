#!/usr/bin/env python3
"""Small artifacts, real local git+flock, production prepare/flip functions.
No production DB, service, release directory, lock or network access.
"""
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
DEPLOY = (ROOT / 'scripts/deploy-v5-selfhost.sh').read_text()
LIB = ROOT / 'scripts/lib/v5-selfhost-prepare.sh'


def fn(name):
    return re.search(r'^' + name + r'\(\) \{.*?^\}', DEPLOY, re.M | re.S)[0]


class Prepared(unittest.TestCase):
    def setUp(self):
        # Production receipts deliberately reject /tmp's world-writable ancestor.
        self.tmp = tempfile.TemporaryDirectory(prefix='p4-test-', dir='/root')
        self.addCleanup(self.tmp.cleanup)
        self.t = Path(self.tmp.name)
        self.repo = self.t / 'repo'
        self.env = {'PATH': os.environ['PATH'], 'HOME': str(self.t), 'LC_ALL': 'C.UTF-8',
                    'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null'}
        self.run_cmd('git', 'init', '-q', '-b', 'feat/v5-selfhost', str(self.repo))
        self.git('config', 'user.name', 'p4-test')
        self.git('config', 'user.email', 'p4@example.invalid')
        (self.repo / 'source').write_text('A')
        self.git('add', '.')
        self.git('commit', '-qm', 'A')
        self.sha = self.git('rev-parse', 'HEAD')
        self.run_cmd('git', 'init', '-q', '--bare', str(self.t / 'origin'))
        self.git('remote', 'add', 'origin', str(self.t / 'origin'))
        self.git('push', '-q', 'origin', 'HEAD')
        for d in ('master', 'runtime', 'platform/bundles', 'run'):
            (self.t / d).mkdir(parents=True, exist_ok=True)
        self.script = '\n'.join([
            'set -Eeuo pipefail', f'T={str(self.t)!r}', f'REPO_ROOT={str(self.repo)!r}',
            f'SCRIPT_DIR={str(ROOT / "scripts")!r}', f'SHA={self.sha}',
            'OC_V5_SELFHOST_PREPARED_ROOT="$T/prepared"; OC_V5_SELFHOST_PREPARE_LOCK="$T/run/prepare.lock"',
            f'source {str(LIB)!r}',
            'SELFHOST_DEPLOY_LOCK_DIR="$T/run"; SELFHOST_DEPLOY_LOCK="$T/run/deploy.lock"',
            'SELFHOST_DEPLOY_LOCK_WAIT=5; SELFHOST_DEPLOY_LOCK_POLL=1',
            'SELFHOST_DEPLOY_LOCK_HOLDER=""; SELFHOST_DEPLOY_LOCK_HOLDER_OWNED=0',
            'MASTER_RELEASES_ROOT="$T/master"; OC_HOTCFG_RELEASES_ROOT="$T/runtime"; OC_HOTCFG_PLATFORM_ROOT="$T/platform"',
            'RUNTIME_IMAGE=test:image; OC_BUN_BIN=true; DRY=0; PLATFORM_FROM_HEAD=1',
            'log() { echo "$*"; }; die() { echo "$*" >&2; exit 73; }',
            fn('source_commit'), fn('selfhost_lock_py'), fn('proc_starttime_of'),
            fn('acquire_selfhost_deploy_lock'), fn('selfhost_lock_holder_info'),
            'release_policy_mutation_barrier() { :; }; selfhost_backup_lock_holder() { return 1; }',
            'master_web_dist_key() { echo web-inputs; }',
            'docker() { printf "sha256:%064d\\n" 1; }',
            # Isolate expensive builders, but exercise actual orchestration and receipt IO.
            'build_master_release() {',
            '  flock -n "$SELFHOST_DEPLOY_LOCK" true && echo deploy-free >>"$T/events" || echo deploy-busy >>"$T/events"',
            '  echo build >>"$T/events"; [[ "${FAIL_BUILD:-0}" == 0 ]] || die gate-failed',
            '  sleep "${BUILD_SLEEP:-0}"',
            '  BUILT_MASTER_RELEASE="$MASTER_RELEASES_ROOT/rel-test"; mkdir -p "$BUILT_MASTER_RELEASE"',
            '  printf \'{"sourceCommit":"%s"}\\n\' "$1" >"$BUILT_MASTER_RELEASE/.complete"',
            '}',
            'collect_runtime_release_bg() {',
            '  BUILT_RUNTIME_RELEASE="$OC_HOTCFG_RELEASES_ROOT/rel-0123456789ab"; mkdir -p "$BUILT_RUNTIME_RELEASE"',
            '  printf \'{"sourceCommit":"%s"}\\n\' "$1" >"$BUILT_RUNTIME_RELEASE/MANIFEST.json"',
            '}',
            'build_platform_bundle() {',
            '  BUILT_BUNDLE_REV=0123456789ab; mkdir -p "$OC_HOTCFG_PLATFORM_ROOT/bundles/$BUILT_BUNDLE_REV"',
            '  echo \'{"sourceCommit":"old-identical-content"}\' >"$OC_HOTCFG_PLATFORM_ROOT/bundles/$BUILT_BUNDLE_REV/MANIFEST.json"',
            '}',
            'oc_hotcfg_verify_manifest_full() { [[ "${FAIL_DIGEST:-0}" == 0 ]]; }',
        ])

    def run_cmd(self, *args):
        return subprocess.check_output(args, env=self.env, text=True, stderr=subprocess.PIPE).strip()

    def git(self, *args):
        return self.run_cmd('git', '-C', str(self.repo), *args)

    def bash(self, body, ok=True):
        p = subprocess.run(['bash', '-c', self.script + '\n' + body], env=self.env,
                           text=True, capture_output=True, timeout=15)
        if ok:
            self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        else:
            self.assertNotEqual(p.returncode, 0, p.stdout + p.stderr)
        return p

    def prepare(self):
        return self.bash('selfhost_prepare_candidate "$SHA"')

    @property
    def receipt(self):
        return self.t / 'prepared' / (self.sha + '.json')

    def advance(self):
        (self.repo / 'source').write_text('B')
        self.git('commit', '-qam', 'B')
        self.git('push', '-q', 'origin', 'HEAD')

    def test_prepare_under_previous_flip_lock_then_flip_owns_lock(self):
        out = self.bash('''
(exec 8>"$SELFHOST_DEPLOY_LOCK"; flock 8; touch "$T/locked"; sleep 2) & holder=$!
while [[ ! -e "$T/locked" ]]; do sleep .01; done
selfhost_prepare_candidate "$SHA"
[[ -f "$SELFHOST_PREPARED_ROOT/$SHA.json" ]]
[[ "$(cat "$T/events")" == $'deploy-busy\\nbuild' ]]
selfhost_prepared_enter_flip "$SHA"
flock -n "$SELFHOST_DEPLOY_LOCK" true && exit 99
[[ "$SELFHOST_SPLIT_PREPARED" == 1 && -e "$SELFHOST_PREPARED_ROOT/$SHA.json" ]]
selfhost_prepared_complete "$SHA" "$BUILT_MASTER_RELEASE"
[[ ! -e "$SELFHOST_PREPARED_ROOT/$SHA.json" ]]
wait "$holder"
''')
        self.assertIn('已取得 selfhost', out.stdout)

    def test_reuse_runs_no_build_and_serializes_two_prepares(self):
        self.bash('''
(BUILD_SLEEP=1; selfhost_prepare_candidate "$SHA") & first=$!
while [[ ! -e "$T/events" ]]; do sleep .01; done
selfhost_prepare_candidate "$SHA"
wait "$first"
''')
        self.assertEqual((self.t / 'events').read_text().splitlines().count('build'), 1)
        self.assertEqual(json.loads(self.receipt.read_text())['sourceCommit'], self.sha)

    def test_failed_flip_keeps_candidate_and_success_does_not_consume_a_different_one(self):
        self.prepare()
        self.bash('selfhost_prepared_enter_flip "$SHA"; die idle-timeout', ok=False)
        self.assertTrue(self.receipt.exists())
        self.bash('selfhost_prepared_complete "$SHA" "$MASTER_RELEASES_ROOT/rel-different"')
        self.assertTrue(self.receipt.exists())
        self.prepare()
        self.assertEqual((self.t / 'events').read_text().splitlines().count('build'), 1)

    def test_failed_gate_never_publishes(self):
        self.bash('FAIL_BUILD=1; selfhost_prepare_candidate "$SHA"', ok=False)
        self.assertFalse(self.receipt.exists())

    def test_reject_inherited_lock_and_trailer_skip(self):
        for flag in ('OC_V5_SELFHOST_DEPLOY_LOCK_HELD', 'OC_V5_SKIP_TRAILER_GATE'):
            with self.subTest(flag=flag):
                self.bash(flag + '=1; selfhost_prepare_candidate "$SHA"', ok=False)
                self.assertFalse(self.receipt.exists())

    def test_changed_tip_cannot_flip_or_gc_pin_forever(self):
        self.prepare()
        self.advance()
        self.bash('selfhost_prepared_enter_flip "$SHA"; touch "$T/live-write"', ok=False)
        self.assertFalse((self.t / 'live-write').exists())
        self.bash('selfhost_prepared_gc touch "$T/gc"')
        self.assertTrue((self.t / 'gc').exists())
        self.assertFalse(self.receipt.exists())

    def test_tip_changes_during_build_no_receipt(self):
        self.bash('''
original=$(declare -f build_platform_bundle); eval "${original/build_platform_bundle/old_platform}"
build_platform_bundle() {
  old_platform "$1"
  echo B >"$REPO_ROOT/source"; git -C "$REPO_ROOT" commit -qam B
  git -C "$REPO_ROOT" push -q origin HEAD
}
selfhost_prepare_candidate "$SHA"
''', ok=False)
        self.assertFalse(self.receipt.exists())

    def test_local_head_changes_reject(self):
        self.prepare()
        (self.repo / 'source').write_text('local')
        self.git('commit', '-qam', 'local')
        self.bash('selfhost_prepared_enter_flip "$SHA"', ok=False)

    def test_gc_defers_ready_running_and_untrusted_state(self):
        self.prepare()
        self.bash('selfhost_prepared_gc touch "$T/gc"')
        self.assertFalse((self.t / 'gc').exists())
        self.bash('selfhost_prepare_lock; selfhost_prepared_state remove "$SHA"; selfhost_prepare_unlock')
        self.bash('''
(selfhost_prepare_lock; touch "$T/locked"; sleep 1) & holder=$!
while [[ ! -e "$T/locked" ]]; do sleep .01; done
selfhost_prepared_gc touch "$T/gc"
wait "$holder"
''')
        self.assertFalse((self.t / 'gc').exists())
        os.chmod(self.t / 'prepared', 0o777)
        self.bash('selfhost_prepared_gc touch "$T/gc"')
        self.assertFalse((self.t / 'gc').exists())

    def test_receipt_identity_marker_and_manifest_fail_closed(self):
        self.prepare()
        original = self.receipt.read_text()
        for field, value in [('sourceCommit', 'f' * 40), ('sourceTree', 'f' * 40),
                             ('imageId', 'sha256:' + 'f' * 64), ('options', 'changed')]:
            with self.subTest(field=field):
                doc = json.loads(original)
                doc[field] = value
                self.receipt.write_text(json.dumps(doc))
                self.bash('selfhost_prepared_enter_flip "$SHA"', ok=False)
        self.receipt.write_text(original)
        self.bash('FAIL_DIGEST=1; selfhost_prepared_enter_flip "$SHA"', ok=False)
        (self.t / 'master/rel-test/.complete').write_text('{}')
        self.bash('selfhost_prepared_enter_flip "$SHA"', ok=False)

    def test_missing_symlink_outside_root_receipts_reject(self):
        self.prepare()
        data = json.loads(self.receipt.read_text())
        data['master']['path'] = str(self.repo)
        self.receipt.write_text(json.dumps(data))
        self.bash('selfhost_prepared_enter_flip "$SHA"', ok=False)
        self.receipt.unlink()
        self.bash('selfhost_prepared_enter_flip "$SHA"', ok=False)
        self.receipt.symlink_to(self.repo / 'source')
        self.bash('selfhost_prepared_enter_flip "$SHA"', ok=False)

    def test_real_deploy_orchestration_builds_before_lock_and_defers_live_setup(self):
        (self.t / 'env').write_text('')
        (self.t / 'live').symlink_to(self.repo)
        self.script += '\n' + fn('cmd_deploy') + '\n' + fn('cutover_expected_source_commit')
        self.bash('''
ALLOW_DIRTY=0; RELEASE_POLICY_RESUME=0; LEASE_TRAIN_ACTIVE=0; LEASE_TARGET_SHA="$SHA"
V5_ENV="$T/env"; MASTER_LIVE_LINK="$T/live"
preflight_common() { :; }; explain_dirty_semantics() { :; }
lease_train_begin() { LEASE_TRAIN_ACTIVE=1; echo begin >>"$T/events"; }
selfhost_release_preflight() { [[ "$1" == "$SHA" ]]; }
assert_fix_trailers() { [[ "$1" == "$SHA" ]]; }
assert_p0_web_overlay_contained() { [[ "$1" == "$SHA" ]]; }
release_policy_bind_official_train_request() {
  ! flock -n "$SELFHOST_DEPLOY_LOCK" true
  echo bind >>"$T/events"
}
cutover_adopt_inflight_request() { :; }
ensure_selfhost_env_keys() { die premature-live-write; }
seed_web_assets_pool_from_live() { die premature-live-write; }
ensure_node_modules() { die premature-live-write; }
install_aux_units() { die premature-live-write; }
refresh_ccb_proxy_path() { die premature-live-write; }
ensure_model_authority() { die premature-live-write; }
assert_env_key_drift() { die premature-live-write; }
cmd_cutover() {
  ! flock -n "$SELFHOST_DEPLOY_LOCK" true
  [[ "$(cutover_expected_source_commit)" == "$SHA" ]]
  [[ "$SELFHOST_SPLIT_PREPARED" == 1 ]]
  echo cutover >>"$T/events"
}
lease_train_finish() { echo "$1" >>"$T/events"; }
cmd_deploy
''')
        self.assertEqual((self.t / 'events').read_text().splitlines(),
                         ['begin', 'deploy-free', 'build', 'bind', 'cutover', 'committed'])

    def test_busy_prepare_cannot_hold_flip_lock_for_build_duration(self):
        self.prepare()
        self.bash('''
(selfhost_prepare_lock; touch "$T/locked"; sleep 1) & holder=$!
while [[ ! -e "$T/locked" ]]; do sleep .01; done
(selfhost_prepared_enter_flip "$SHA") && exit 99
flock -n "$SELFHOST_DEPLOY_LOCK" true
wait "$holder"
''')


if __name__ == '__main__':
    unittest.main()
