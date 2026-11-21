#!/usr/bin/env python3
"""Small artifacts, real local git+flock, production prepare/flip functions.
No production DB, service, release directory, lock or network access.
"""
import ctypes
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import tempfile
import time
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
            'prewarm_quiesce() { ! flock -n "$SELFHOST_DEPLOY_LOCK" true || die quiesce-without-deploy-lock; [[ "${FAIL_QUIESCE:-0}" == 0 ]]; }',
            'master_web_dist_key() { echo web-inputs; }',
            'selfhost_release_preflight() { [[ "${LOW_SPACE:-0}" == 0 ]] || die low-build-space; }',
            'docker() { printf "sha256:%064d\\n" 1; }',
            'fixture_wait() {',
            '  local attempt; for ((attempt=0; attempt<500; attempt++)); do',
            '    [[ ! -e "$1" ]] || return 0; sleep .01',
            '  done; die "fixture event timeout: $1"',
            '}',
            # Isolate expensive builders, but exercise actual orchestration and receipt IO.
            'build_master_release() {',
            '  flock -n "$SELFHOST_DEPLOY_LOCK" true && echo deploy-free >>"$T/events" || echo deploy-busy >>"$T/events"',
            '  echo build >>"$T/events"; echo master >>"$T/gates"',
            '  if [[ -n "${BUILD_BLOCK:-}" ]]; then touch "$T/build-ready"; fixture_wait "$BUILD_BLOCK"; fi',
            '  [[ "${FAIL_BUILD:-0}" == 0 ]] || die master-gate-failed',
            '  BUILT_MASTER_RELEASE="$MASTER_RELEASES_ROOT/${FIXTURE_MASTER_NAME:-rel-test}"; mkdir -p "$BUILT_MASTER_RELEASE"',
            '  printf \'{"sourceCommit":"%s"}\\n\' "$1" >"$BUILT_MASTER_RELEASE/.complete"',
            '}',
            'build_runtime_release() {',
            '  echo runtime >>"$T/gates"; [[ "${FAIL_RUNTIME:-0}" == 0 ]] || die runtime-gate-failed',
            '  BUILT_RUNTIME_RELEASE="$OC_HOTCFG_RELEASES_ROOT/${FIXTURE_RUNTIME_NAME:-rel-0123456789ab}"; mkdir -p "$BUILT_RUNTIME_RELEASE"',
            '  printf \'{"sourceCommit":"%s","digest":"e3b0c44298fc"}\\n\' "$1" >"$BUILT_RUNTIME_RELEASE/MANIFEST.json"',
            '}',
            fn('start_runtime_release_bg'), fn('await_runtime_release_bg'),
            fn('collect_runtime_release_bg'), fn('reap_runtime_release_bg'),
            'TMPDIR="$T"; RUNTIME_BG_PID=""; RUNTIME_BG_LOG=""; RUNTIME_BG_RESULT=""; RUNTIME_BG_RC=""',
            'build_platform_bundle() {',
            '  echo platform >>"$T/gates"; [[ "${FAIL_PLATFORM:-0}" == 0 ]] || die platform-gate-failed',
            '  BUILT_BUNDLE_REV="${FIXTURE_BUNDLE_REV:-0123456789ab}"; mkdir -p "$OC_HOTCFG_PLATFORM_ROOT/bundles/$BUILT_BUNDLE_REV"',
            '  echo \'{"sourceCommit":"old-identical-content","digest":"e3b0c44298fc"}\' >"$OC_HOTCFG_PLATFORM_ROOT/bundles/$BUILT_BUNDLE_REV/MANIFEST.json"',
            '}',
            'tsum_note() { printf "%s=%s\\n" "$1" "$2" >>"$T/notes"; }',
        ])

    def run_cmd(self, *args):
        return subprocess.check_output(args, env=self.env, text=True, stderr=subprocess.PIPE,
                                       timeout=15).strip()

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

    def spawn(self, body):
        process = subprocess.Popen(['bash', '-c', self.script + '\n' + body], env=self.env,
                                   text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.addCleanup(self.reap_process, process)
        return process

    @staticmethod
    def reap_process(process):
        if process.poll() is None:
            process.kill()  # Only this fixture's Popen child, never a shared process.
        process.communicate(timeout=10)

    def finish(self, process, ok=True):
        stdout, stderr = process.communicate(timeout=15)
        if ok:
            self.assertEqual(process.returncode, 0, stdout + stderr)
        else:
            self.assertNotEqual(process.returncode, 0, stdout + stderr)
        return stdout + stderr

    def wait_event(self, name):
        path = self.t / name
        deadline = time.monotonic() + 8
        while not path.exists():
            self.assertLess(time.monotonic(), deadline, f'fixture event timeout: {name}')
            time.sleep(.01)

    def assert_artifact_lock(self, held=False):
        result = subprocess.run(['flock', '-n', str(self.t / 'run/prepare.lock'), 'true'],
                                env=self.env, capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 1 if held else 0, result.stderr)

    def build_count(self):
        events = self.t / 'events'
        return events.read_text().splitlines().count('build') if events.exists() else 0

    def release_fifo(self, name):
        fd = os.open(self.t / name, os.O_RDWR | os.O_NONBLOCK)
        try:
            os.write(fd, b'finish\n')
        finally:
            os.close(fd)

    def prepare(self):
        return self.bash('selfhost_prepare_candidate "$SHA"')

    @property
    def receipt(self):
        return self.t / 'prepared' / (self.sha + '.json')

    def advance(self):
        (self.repo / 'source').write_text('B')
        self.git('commit', '-qam', 'B')
        self.git('push', '-q', 'origin', 'HEAD')

    def advance_remote_only(self):
        writer = self.t / 'remote-writer'
        self.run_cmd('git', 'clone', '-q', '--branch', 'feat/v5-selfhost',
                     str(self.t / 'origin'), str(writer))
        for key, value in (('user.name', 'p4-test'), ('user.email', 'p4@example.invalid')):
            self.run_cmd('git', '-C', str(writer), 'config', key, value)
        (writer / 'source').write_text('remote-B')
        self.run_cmd('git', '-C', str(writer), 'commit', '-qam', 'remote-B')
        self.run_cmd('git', '-C', str(writer), 'push', '-q', 'origin', 'HEAD')
        return self.run_cmd('git', '-C', str(writer), 'rev-parse', 'HEAD')

    def prepare_unique(self, sha):
        return self.bash(f'''FIXTURE_MASTER_NAME=rel-s3-{sha}
FIXTURE_RUNTIME_NAME=rel-{sha[:12]}; FIXTURE_BUNDLE_REV={sha[:12]}
selfhost_prepare_candidate {sha}
''')

    def test_prepare_under_previous_flip_lock_then_flip_owns_lock(self):
        holder = self.spawn('''
exec 8>"$SELFHOST_DEPLOY_LOCK"
flock 8
touch "$T/deploy-held"
fixture_wait "$T/deploy-release"
''')
        self.wait_event('deploy-held')
        self.prepare()
        self.assertTrue(self.receipt.is_file())
        self.assertEqual((self.t / 'events').read_text().splitlines(), ['deploy-busy', 'build'])
        flip = self.spawn('''
flock() {
  if [[ "$*" == '-n 8' ]]; then
    if command flock "$@"; then return 0; fi
    touch "$T/flip-blocked"
    return 1
  fi
  command flock "$@"
}
selfhost_prepared_enter_flip "$SHA"
touch "$T/flip-owned"
flock -n "$SELFHOST_DEPLOY_LOCK" true && exit 99
[[ "$SELFHOST_SPLIT_PREPARED" == 1 && -e "$SELFHOST_PREPARED_ROOT/$SHA.json" ]]
selfhost_prepared_complete "$SHA" "$BUILT_MASTER_RELEASE"
[[ ! -e "$SELFHOST_PREPARED_ROOT/$SHA.json" ]]
''')
        self.wait_event('flip-blocked')
        self.assertFalse((self.t / 'flip-owned').exists())
        (self.t / 'deploy-release').touch()
        self.finish(holder)
        self.assertIn('已取得 selfhost', self.finish(flip))
        self.assertRegex((self.t / 'notes').read_text(), r'flip.verifySec=\d+\.\d{3}')

    def test_reuse_runs_no_build_and_serializes_two_prepares(self):
        first = self.spawn('BUILD_BLOCK="$T/build-continue"; selfhost_prepare_candidate "$SHA"')
        self.wait_event('build-ready')
        second = self.spawn('touch "$T/second-started"; selfhost_prepare_candidate "$SHA"')
        self.wait_event('second-started')
        self.assert_artifact_lock(held=True)
        self.assertFalse(self.receipt.exists())
        (self.t / 'build-continue').touch()
        self.finish(first)
        self.finish(second)
        self.assertEqual(self.build_count(), 1)
        self.assertEqual(json.loads(self.receipt.read_text())['sourceCommit'], self.sha)

    def test_stale_request_preserves_current_tip_receipt_bytes(self):
        self.prepare()
        self.advance()
        target = self.git('rev-parse', 'HEAD')
        self.bash(f'selfhost_prepare_candidate {target}')
        receipt = self.t / 'prepared' / (target + '.json')
        expected = receipt.read_bytes()
        builds = self.build_count()
        rejected = self.prepare_stale()
        self.assertIn('selfhost tip changed', rejected.stderr)
        self.assertEqual(receipt.read_bytes(), expected)
        self.assertEqual(self.build_count(), builds)
        self.assert_artifact_lock()

    def prepare_stale(self):
        return self.bash('selfhost_prepare_candidate "$SHA"', ok=False)

    def test_tip_advance_while_waiting_for_lock_preserves_new_receipt(self):
        holder = self.spawn('''
selfhost_prepare_lock
touch "$T/artifact-held"
fixture_wait "$T/new-tip-ready"
next=$(cat "$T/new-tip")
original=$(declare -f selfhost_prepare_unlock)
eval "${original/selfhost_prepare_unlock/actual_prepare_unlock}"
selfhost_prepare_unlock() {
  cp "$SELFHOST_PREPARED_ROOT/$next.json" "$T/expected-receipt"
  actual_prepare_unlock
}
selfhost_prepare_candidate "$next"
''')
        self.wait_event('artifact-held')
        waiter = self.spawn('''
flock() {
  if [[ "$1" == 9 ]]; then touch "$T/waiter-at-lock"; fi
  command flock "$@"
}
selfhost_prepare_candidate "$SHA"
''')
        self.wait_event('waiter-at-lock')
        self.assert_artifact_lock(held=True)
        self.advance()
        target = self.git('rev-parse', 'HEAD')
        (self.t / 'new-tip').write_text(target)
        (self.t / 'new-tip-ready').touch()
        self.finish(holder)
        self.assertIn('selfhost tip changed', self.finish(waiter, ok=False))
        self.assertEqual((self.t / 'prepared' / (target + '.json')).read_bytes(),
                         (self.t / 'expected-receipt').read_bytes())
        self.assertEqual(self.build_count(), 1)
        self.assert_artifact_lock()

    def test_failed_flip_keeps_candidate_and_success_does_not_consume_a_different_one(self):
        self.prepare()
        self.bash('selfhost_prepared_enter_flip "$SHA"; die idle-timeout', ok=False)
        self.assertTrue(self.receipt.exists())
        self.bash('selfhost_prepared_complete "$SHA" "$MASTER_RELEASES_ROOT/rel-different"')
        self.assertTrue(self.receipt.exists())
        self.prepare()
        self.assertEqual((self.t / 'events').read_text().splitlines().count('build'), 1)

    def test_completion_is_idempotent_and_preserves_other_sha_receipt(self):
        self.prepare()
        original = self.receipt.read_bytes()
        other_sha = 'f' * 40
        other = self.receipt.parent / (other_sha + '.json')
        other.write_bytes(original)
        self.bash('selfhost_prepared_complete "$SHA" "$MASTER_RELEASES_ROOT/rel-different"')
        self.assertEqual(self.receipt.read_bytes(), original)
        self.assertEqual(other.read_bytes(), original)
        self.bash('''
selfhost_prepared_complete "$SHA" "$MASTER_RELEASES_ROOT/rel-test"
selfhost_prepared_complete "$SHA" "$MASTER_RELEASES_ROOT/rel-test"
''')
        self.assertFalse(self.receipt.exists())
        self.assertEqual(other.read_bytes(), original)
        for root in ('master', 'runtime', 'platform/bundles'):
            self.assertTrue(any((self.t / root).iterdir()))
        self.assert_artifact_lock()

    def test_prepares_remote_tip_ahead_of_head_while_previous_flip_holds_lock(self):
        old = self.sha
        self.advance()
        self.sha = self.git('rev-parse', 'HEAD')
        self.git('reset', '-q', '--hard', old)
        holder = self.spawn('''
exec 8>"$SELFHOST_DEPLOY_LOCK"
flock 8
touch "$T/deploy-held"
fixture_wait "$T/deploy-release"
''')
        self.wait_event('deploy-held')
        self.bash(f'SHA={self.sha}; LEASE_TARGET_SHA="$SHA"\n' + '''
preflight_common() { :; }; assert_fix_trailers() { :; }
cmd_prepare
''')
        (self.t / 'deploy-release').touch()
        self.finish(holder)
        self.assertEqual(self.git('rev-parse', 'HEAD'), old)
        self.assertEqual(json.loads(self.receipt.read_text())['sourceCommit'], self.sha)

    def test_controller_change_requires_refresh_even_when_tip_object_exists(self):
        old = self.sha
        (self.repo / 'scripts').mkdir()
        (self.repo / 'scripts/deploy-v5-selfhost.sh').write_text('# new controller\n')
        self.git('add', '.')
        self.git('commit', '-qm', 'controller')
        self.git('push', '-q', 'origin', 'HEAD')
        target = self.git('rev-parse', 'HEAD')
        self.git('reset', '-q', '--hard', old)
        result = self.bash(f'selfhost_prepare_candidate {target}', ok=False)
        self.assertIn('changes the build controller', result.stderr)
        self.assertFalse((self.t / 'events').exists())

    def test_receipt_reuse_needs_no_second_build_space_admission(self):
        self.prepare()
        self.bash('LOW_SPACE=1; selfhost_prepare_candidate "$SHA"; selfhost_prepared_enter_flip "$SHA"')
        self.assertEqual((self.t / 'events').read_text().splitlines().count('build'), 1)
        self.bash('selfhost_prepare_lock; selfhost_prepared_state remove "$SHA"; selfhost_prepare_unlock')
        self.bash('LOW_SPACE=1; selfhost_prepare_candidate "$SHA"', ok=False)
        self.assertFalse(self.receipt.exists())

    def test_actual_l0_accepts_immutable_prepare_pin_ahead_of_head(self):
        self.advance()
        target = self.git('rev-parse', 'HEAD')
        self.git('reset', '-q', '--hard', self.sha)
        source = (ROOT / 'scripts/v5-selfhost-master-release-lib.sh').read_text()
        actual = re.search(r'^selfhost_release_preflight\(\) \{.*?^\}', source, re.M | re.S)[0]
        self.script += '\n' + actual
        self.bash('''
MASTER_LIVE_LINK="$T/live"; RPF_MIN_FREE_KB=1
mlog() { :; }; rpf_reset() { :; }; rpf_add() { echo "$1:$2" >>"$T/l0"; }
rpf_check_source_pin() { die unexpectedly-requires-head; }
rpf_check_workspace_links() { :; }; rpf_check_migrations() { :; }
rpf_check_proof_db() { :; }; rpf_check_disk() { :; }; master_gate_base_dsn() { :; }
rpf_report() { :; }; rpf_summary() { :; }
''' + f'selfhost_release_preflight {target} prepared')
        self.assertIn('ok:source-pin', (self.t / 'l0').read_text())

    def test_flip_refuses_unquiesced_prewarmer_before_live_mutation(self):
        self.prepare()
        self.bash('FAIL_QUIESCE=1; selfhost_prepared_enter_flip "$SHA"; touch "$T/live-write"', ok=False)
        self.assertFalse((self.t / 'live-write').exists())
        self.assertTrue(self.receipt.exists())

    def test_each_failed_gate_never_publishes_and_explicit_retry_rebuilds(self):
        for flag, reached in [('FAIL_BUILD', ['master']),
                              ('FAIL_RUNTIME', ['master', 'runtime']),
                              ('FAIL_PLATFORM', ['master', 'runtime', 'platform'])]:
            with self.subTest(gate=flag):
                before = self.build_count()
                (self.t / 'gates').write_text('')
                self.bash(flag + '=1; selfhost_prepare_candidate "$SHA"', ok=False)
                self.assertFalse(self.receipt.exists())
                self.assertEqual((self.t / 'gates').read_text().splitlines(), reached)
                self.assertEqual(self.build_count(), before + 1)
                self.assert_artifact_lock()
                self.prepare()
                self.assertTrue(self.receipt.is_file())
                self.assertEqual(self.build_count(), before + 2)
                expected = self.receipt.read_bytes()
                self.prepare()
                self.assertEqual(self.receipt.read_bytes(), expected)
                self.assertEqual(self.build_count(), before + 2)
                self.bash('selfhost_prepared_complete "$SHA" "$MASTER_RELEASES_ROOT/rel-test"')

    def test_changed_inputs_invalidate_without_implicit_retry(self):
        self.prepare()
        result = self.bash('FORCE_NPM_CI=1; selfhost_prepare_candidate "$SHA"', ok=False)
        self.assertIn('receipt invalidated, run prepare again', result.stderr)
        self.assertFalse(self.receipt.exists())
        self.assertEqual(self.build_count(), 1)
        self.assert_artifact_lock()
        self.bash('FORCE_NPM_CI=1; selfhost_prepare_candidate "$SHA"')
        self.assertTrue(self.receipt.is_file())
        self.assertEqual(self.build_count(), 2)
        expected = self.receipt.read_bytes()
        self.bash('FORCE_NPM_CI=1; selfhost_prepare_candidate "$SHA"')
        self.assertEqual(self.receipt.read_bytes(), expected)
        self.assertEqual(self.build_count(), 2)

    def test_publication_failure_has_no_receipt_and_releases_artifact_lock(self):
        self.bash('''
original=$(declare -f selfhost_prepared_receipt)
eval "${original/selfhost_prepared_receipt/actual_prepared_receipt}"
selfhost_prepared_receipt() {
  if [[ "$1" == write ]]; then echo write >>"$T/publication"; return 74; fi
  actual_prepared_receipt "$@"
}
selfhost_prepare_candidate "$SHA"
''', ok=False)
        self.assertEqual((self.t / 'publication').read_text(), 'write\n')
        self.assertEqual((self.t / 'gates').read_text().splitlines(), ['master', 'runtime', 'platform'])
        self.assertFalse(self.receipt.exists())
        self.assert_artifact_lock()
        self.prepare()
        self.assertTrue(self.receipt.is_file())
        self.assertEqual(self.build_count(), 2)

    def test_interrupted_prepare_releases_lock_without_publishing(self):
        os.mkfifo(self.t / 'master-continue')
        process = self.spawn('''
build_master_release() {
  touch "$T/master-ready"
  IFS= read -r token <"$T/master-continue"
}
selfhost_prepare_candidate "$SHA"
''')
        self.wait_event('master-ready')
        self.assert_artifact_lock(held=True)
        process.terminate()
        self.finish(process, ok=False)
        self.assertEqual(process.returncode, -signal.SIGTERM)
        self.assertFalse(self.receipt.exists())
        self.assert_artifact_lock()
        self.prepare()
        self.assertTrue(self.receipt.is_file())

    def test_failed_prepare_reaps_real_runtime_child_before_releasing_lock(self):
        os.mkfifo(self.t / 'runtime-continue')
        process = self.spawn('''
original=$(declare -f build_runtime_release)
eval "${original/build_runtime_release/fixture_runtime_build}"
build_runtime_release() {
  touch "$T/runtime-ready"
  IFS= read -r token <"$T/runtime-continue"
  fixture_runtime_build "$1"
}
build_master_release() {
  start_runtime_release_bg "$1"
  fixture_wait "$T/runtime-ready"
  touch "$T/master-failed"
  die master-gate-failed
}
trap reap_runtime_release_bg EXIT
selfhost_prepare_candidate "$SHA"
''')
        try:
            self.wait_event('master-failed')
            self.assertIsNone(process.poll())
            self.assert_artifact_lock(held=True)
            self.assertFalse(self.receipt.exists())
            self.bash('selfhost_prepared_gc touch "$T/gc"')
            self.assertFalse((self.t / 'gc').exists())
        finally:
            self.release_fifo('runtime-continue')
            output = self.finish(process, ok=False)
        self.assertEqual(process.returncode, 73)
        self.assertIn('等待后台 runtime release 构建收尾', output)
        self.assertEqual(list(self.t.glob('ocv5-runtime-release-bg.*')), [])
        self.assert_artifact_lock()
        self.assertFalse(self.receipt.exists())
        self.prepare()
        self.assertTrue(self.receipt.is_file())

    def test_runtime_child_retains_artifact_lock_after_prepare_is_killed(self):
        # Adopt/reap only this test's orphaned runtime child after killing its
        # saved Popen parent. No process groups, shared PIDs or production IO.
        libc = ctypes.CDLL(None, use_errno=True)
        previous = ctypes.c_int()
        self.assertEqual(libc.prctl(37, ctypes.byref(previous), 0, 0, 0), 0)
        self.assertEqual(libc.prctl(36, 1, 0, 0, 0), 0)
        child_pid = None
        child_reaped = False
        process = None
        os.mkfifo(self.t / 'runtime-continue')
        os.mkfifo(self.t / 'master-continue')
        try:
            process = self.spawn('''
original=$(declare -f build_runtime_release)
eval "${original/build_runtime_release/fixture_runtime_build}"
build_runtime_release() {
  touch "$T/runtime-ready"
  IFS= read -r token <"$T/runtime-continue"
  fixture_runtime_build "$1"
}
build_master_release() {
  start_runtime_release_bg "$1"
  echo "$RUNTIME_BG_PID" >"$T/runtime-pid"
  fixture_wait "$T/runtime-ready"
  touch "$T/master-ready"
  IFS= read -r token <"$T/master-continue"
}
trap reap_runtime_release_bg EXIT
selfhost_prepare_candidate "$SHA"
''')
            self.wait_event('master-ready')
            child_pid = int((self.t / 'runtime-pid').read_text())
            self.assertGreater(child_pid, 1)
            self.assertNotEqual(child_pid, process.pid)
            self.assert_artifact_lock(held=True)
            process.kill()
            self.finish(process, ok=False)
            self.assertEqual(process.returncode, -signal.SIGKILL)
            self.assertFalse(self.receipt.exists())
            self.assert_artifact_lock(held=True)
            deferred = self.bash('selfhost_prepared_gc touch "$T/gc"')
            self.assertIn('GC deferred: prepare is running', deferred.stdout)
            self.assertFalse((self.t / 'gc').exists())
            self.release_fifo('runtime-continue')
            deadline = time.monotonic() + 8
            while True:
                reaped, status = os.waitpid(child_pid, os.WNOHANG)
                if reaped:
                    child_pid = None
                    child_reaped = True
                    self.assertEqual(os.waitstatus_to_exitcode(status), 0)
                    break
                self.assertLess(time.monotonic(), deadline, 'runtime child did not finish')
                time.sleep(.01)
            self.assert_artifact_lock()
            self.assertFalse(self.receipt.exists())
            self.prepare()
            self.assertTrue(self.receipt.is_file())
        finally:
            pid_file = self.t / 'runtime-pid'
            if not child_reaped and child_pid is None and pid_file.exists():
                child_pid = int(pid_file.read_text())
            if process is not None:
                self.reap_process(process)
            if child_pid is not None:
                try:
                    os.kill(child_pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                os.waitpid(child_pid, 0)
            libc.prctl(36, previous.value, 0, 0, 0)

    def test_reject_inherited_lock_and_trailer_skip(self):
        for flag in ('OC_V5_SELFHOST_DEPLOY_LOCK_HELD', 'OC_V5_SKIP_TRAILER_GATE'):
            with self.subTest(flag=flag):
                self.bash(flag + '=1; selfhost_prepare_candidate "$SHA"', ok=False)
                self.assertFalse(self.receipt.exists())

    def test_descendant_tip_keeps_old_receipt_flippable_and_gc_protected(self):
        self.prepare()
        expected = self.receipt.read_bytes()
        self.advance()
        target = self.git('rev-parse', 'HEAD')
        self.bash('''
selfhost_prepared_enter_flip "$SHA"
[[ "$BUILT_MASTER_RELEASE" == "$MASTER_RELEASES_ROOT/rel-test" ]]
[[ "$SELFHOST_SPLIT_PREPARED" == 1 ]]
touch "$T/flip-ready"
''')
        self.assertTrue((self.t / 'flip-ready').exists())
        self.bash('selfhost_prepared_gc touch "$T/gc"')
        self.assertFalse((self.t / 'gc').exists())
        self.assertEqual(self.receipt.read_bytes(), expected)
        self.assertFalse((self.receipt.parent / (target + '.json')).exists())
        self.assertEqual(self.build_count(), 1)

    def test_tip_advances_during_paused_build_seals_only_old_complete_sha(self):
        process = self.spawn('''
BUILD_BLOCK="$T/build-continue"
selfhost_prepare_candidate "$SHA"
''')
        self.wait_event('build-ready')
        self.assertFalse(self.receipt.exists())
        self.advance()
        target = self.git('rev-parse', 'HEAD')
        (self.t / 'build-continue').touch()
        self.finish(process)
        self.assertEqual((self.t / 'gates').read_text().splitlines(), ['master', 'runtime', 'platform'])
        self.assertEqual(json.loads(self.receipt.read_text())['sourceCommit'], self.sha)
        self.assertFalse((self.receipt.parent / (target + '.json')).exists())
        self.bash('selfhost_prepared_enter_flip "$SHA"')
        self.assertEqual(self.build_count(), 1)

    def test_tip_advance_cannot_publish_any_failed_or_unrun_gate(self):
        for flag, reached in [('FAIL_BUILD', ['master']),
                              ('FAIL_RUNTIME', ['master', 'runtime']),
                              ('FAIL_PLATFORM', ['master', 'runtime', 'platform'])]:
            with self.subTest(gate=flag):
                self.git('reset', '-q', '--hard', self.sha)
                self.git('push', '-q', '--force', 'origin', 'HEAD')
                for name in ('build-ready', 'build-continue'):
                    (self.t / name).unlink(missing_ok=True)
                (self.t / 'gates').write_text('')
                process = self.spawn(flag + '=1; BUILD_BLOCK="$T/build-continue"; '
                                     'selfhost_prepare_candidate "$SHA"')
                self.wait_event('build-ready')
                self.advance()
                (self.t / 'build-continue').touch()
                self.finish(process, ok=False)
                self.assertEqual((self.t / 'gates').read_text().splitlines(), reached)
                self.assertFalse(self.receipt.exists())
                self.bash('selfhost_prepared_enter_flip "$SHA"; touch "$T/live-write"', ok=False)
                self.assertFalse((self.t / 'live-write').exists())
                self.assert_artifact_lock()

    def test_new_sha_receipt_and_partial_artifacts_cannot_replace_old_gates(self):
        self.advance()
        target = self.git('rev-parse', 'HEAD')
        self.prepare_unique(target)
        newer = self.receipt.parent / (target + '.json')
        expected = newer.read_bytes()
        self.bash('selfhost_prepared_enter_flip "$SHA"; touch "$T/live-write"', ok=False)
        self.receipt.write_bytes(expected)
        self.bash('selfhost_prepared_enter_flip "$SHA"; touch "$T/live-write"', ok=False)
        mixed = json.loads(expected)
        mixed.update(sourceCommit=self.sha, sourceTree=self.git('rev-parse', self.sha + '^{tree}'))
        self.receipt.write_text(json.dumps(mixed))
        self.bash('selfhost_prepared_enter_flip "$SHA"; touch "$T/live-write"', ok=False)
        self.assertFalse((self.t / 'live-write').exists())
        self.assertEqual(newer.read_bytes(), expected)
        self.assertEqual(self.build_count(), 1)

    def test_old_completion_preserves_next_candidate_and_next_success_clears_covered(self):
        self.prepare_unique(self.sha)
        self.advance()
        target = self.git('rev-parse', 'HEAD')
        self.prepare_unique(target)
        newer = self.receipt.parent / (target + '.json')
        expected = newer.read_bytes()
        self.bash('selfhost_prepared_gc touch "$T/gc"')
        self.assertTrue(self.receipt.exists())
        self.assertFalse((self.t / 'gc').exists())
        self.bash('''selfhost_prepared_enter_flip "$SHA"
[[ "$BUILT_MASTER_RELEASE" == "$MASTER_RELEASES_ROOT/rel-s3-$SHA" ]]
selfhost_prepared_complete "$SHA" "$BUILT_MASTER_RELEASE"
''')
        self.assertFalse(self.receipt.exists())
        self.assertEqual(newer.read_bytes(), expected)
        self.bash('selfhost_prepared_gc touch "$T/gc"')
        self.assertFalse((self.t / 'gc').exists())
        self.bash(f'selfhost_prepared_complete {target} "$MASTER_RELEASES_ROOT/rel-s3-{target}"')
        self.assertFalse(newer.exists())
        self.bash('selfhost_prepared_gc touch "$T/gc"')
        self.assertTrue((self.t / 'gc').exists())

    def test_successful_descendant_consumes_abandoned_ancestor_receipt(self):
        self.prepare_unique(self.sha)
        self.advance()
        target = self.git('rev-parse', 'HEAD')
        self.prepare_unique(target)
        self.assertTrue(self.receipt.exists())
        self.bash(f'selfhost_prepared_complete {target} "$MASTER_RELEASES_ROOT/rel-s3-{target}"')
        self.assertFalse(self.receipt.exists())
        self.assertEqual(list(self.receipt.parent.glob('*.json')), [])
        self.bash('selfhost_prepared_gc touch "$T/gc"')
        self.assertTrue((self.t / 'gc').exists())

    def test_shallow_cutoff_refuses_ancestor_but_reuses_and_consumes_exact_tip(self):
        self.prepare_unique(self.sha)
        self.advance()
        target = self.git('rev-parse', 'HEAD')
        self.prepare_unique(target)
        newer = self.receipt.parent / (target + '.json')
        expected = newer.read_bytes()
        shallow = self.repo / '.git/shallow'
        shallow.write_text(target + '\n')
        shallow_before = shallow.read_bytes()
        self.assertEqual(self.git('rev-parse', '--is-shallow-repository'), 'true')
        self.assertEqual(self.git('rev-list', target), target)
        self.git('cat-file', '-e', self.sha + '^{commit}')
        self.bash('selfhost_prepared_enter_flip "$SHA"; touch "$T/live-write"', ok=False)
        self.assertFalse((self.t / 'live-write').exists())
        result = self.bash('selfhost_prepared_gc touch "$T/gc"')
        self.assertIn('GC deferred: prepared artifacts await flip', result.stdout)
        self.assertFalse((self.t / 'gc').exists())
        self.assertFalse(self.receipt.exists())
        self.assertEqual(newer.read_bytes(), expected)
        self.prepare_unique(target)
        self.assertEqual(newer.read_bytes(), expected)
        self.assertEqual(self.build_count(), 2)
        self.bash(f'''selfhost_prepared_enter_flip {target}
[[ "$BUILT_MASTER_RELEASE" == "$MASTER_RELEASES_ROOT/rel-s3-{target}" ]]
touch "$T/exact-flip"
selfhost_prepared_complete {target} "$BUILT_MASTER_RELEASE"
''')
        self.assertTrue((self.t / 'exact-flip').exists())
        self.assertFalse(newer.exists())
        self.bash('selfhost_prepared_gc touch "$T/gc"')
        self.assertTrue((self.t / 'gc').exists())
        self.assertEqual(shallow.read_bytes(), shallow_before)

    def test_shallow_boundary_below_candidate_allows_first_build_flip_and_gc(self):
        boundary = None
        for source in ('B', 'C', 'D', 'E'):
            (self.repo / 'source').write_text(source)
            self.git('commit', '-qam', source)
            if source == 'B':
                boundary = self.git('rev-parse', 'HEAD')
        self.git('push', '-q', 'origin', 'HEAD')
        target = self.git('rev-parse', 'HEAD')
        shallow = self.repo / '.git/shallow'
        shallow.write_text(boundary + '\n')
        shallow_before = shallow.read_bytes()
        self.assertEqual(self.git('rev-parse', '--is-shallow-repository'), 'true')
        history = self.git('rev-list', target).splitlines()
        self.assertEqual(len(history), 4)
        self.assertEqual(history[-1], boundary)
        self.assertNotIn(self.sha, history)
        self.prepare_unique(target)
        candidate = self.receipt.parent / (target + '.json')
        expected = candidate.read_bytes()
        self.assertEqual(json.loads(expected)['sourceCommit'], target)
        self.assertEqual((self.t / 'gates').read_text().splitlines(),
                         ['master', 'runtime', 'platform'])
        self.prepare_unique(target)
        self.assertEqual(candidate.read_bytes(), expected)
        self.assertEqual(self.build_count(), 1)
        self.bash(f'''selfhost_prepared_enter_flip {target}
[[ "$BUILT_MASTER_RELEASE" == "$MASTER_RELEASES_ROOT/rel-s3-{target}" ]]
touch "$T/exact-flip"
selfhost_prepared_complete {target} "$BUILT_MASTER_RELEASE"
''')
        self.assertTrue((self.t / 'exact-flip').exists())
        self.assertFalse(candidate.exists())
        self.bash('selfhost_prepared_gc touch "$T/gc"')
        self.assertTrue((self.t / 'gc').exists())
        self.assertEqual(shallow.read_bytes(), shallow_before)

    def test_history_query_failure_falls_back_to_exact_tip_receipts(self):
        self.prepare_unique(self.sha)
        self.advance()
        target = self.git('rev-parse', 'HEAD')
        self.prepare_unique(target)
        newer = self.receipt.parent / (target + '.json')
        old_bytes, new_bytes = self.receipt.read_bytes(), newer.read_bytes()
        real_git = self.run_cmd('bash', '-c', 'command -v git')
        wrapper_dir = self.t / 'git-bin'
        wrapper_dir.mkdir()
        wrapper = wrapper_dir / 'git'
        wrapper.write_text('''#!/bin/bash
if [[ "$FAIL_PREPARED_HISTORY" == shallow && "$3" == rev-parse && "$4" == --is-shallow-repository ]] \\
    || [[ "$FAIL_PREPARED_HISTORY" == rev-list && "$3" == rev-list ]]; then
  printf '%s\\n' "$3" >>"$HISTORY_QUERY_FAILURE_LOG"
  exit 88
fi
''' + f'exec {real_git!r} "$@"\n')
        wrapper.chmod(0o755)
        self.env['PATH'] = str(wrapper_dir) + os.pathsep + self.env['PATH']
        failures = self.t / 'history-query-failures'
        self.env['HISTORY_QUERY_FAILURE_LOG'] = str(failures)
        for command in ('shallow', 'rev-list'):
            with self.subTest(command=command):
                self.env['FAIL_PREPARED_HISTORY'] = command
                failures.write_text('')
                self.receipt.write_bytes(old_bytes)
                newer.write_bytes(new_bytes)
                (self.t / 'gc').unlink(missing_ok=True)
                self.prepare_unique(target)
                self.assertFalse(self.receipt.exists())
                self.assertEqual(newer.read_bytes(), new_bytes)
                self.assertEqual(self.build_count(), 2)
                self.assertEqual(failures.read_text().splitlines(),
                                 ['rev-parse' if command == 'shallow' else 'rev-list'])
                self.bash('selfhost_prepared_enter_flip "$SHA"; touch "$T/live-write"', ok=False)
                self.assertFalse((self.t / 'live-write').exists())
                self.receipt.write_bytes(old_bytes)
                self.bash(f'selfhost_prepared_complete {target} "$MASTER_RELEASES_ROOT/rel-s3-{target}"')
                self.assertFalse(newer.exists())
                self.assertEqual(self.receipt.read_bytes(), old_bytes)
                self.bash('selfhost_prepared_gc touch "$T/gc"')
                self.assertFalse(self.receipt.exists())
                self.assertTrue((self.t / 'gc').exists())

    def test_missing_remote_tip_object_is_fetched_without_updating_refs(self):
        self.prepare()
        target = self.advance_remote_only()
        absent = subprocess.run(['git', '-C', str(self.repo), 'cat-file', '-e', target + '^{commit}'],
                                env=self.env, capture_output=True, timeout=5)
        self.assertNotEqual(absent.returncode, 0)
        refs = self.git('for-each-ref', '--format=%(refname) %(objectname)')
        fetch_head = self.repo / '.git/FETCH_HEAD'
        fetch_before = fetch_head.read_bytes() if fetch_head.exists() else None
        self.bash('selfhost_prepared_enter_flip "$SHA"')
        self.git('cat-file', '-e', target + '^{commit}')
        self.assertEqual(self.git('for-each-ref', '--format=%(refname) %(objectname)'), refs)
        self.assertEqual(fetch_head.read_bytes() if fetch_head.exists() else None, fetch_before)
        self.assertEqual(self.git('rev-parse', 'HEAD'), self.sha)

    def test_remote_lookup_or_missing_object_fetch_failure_refuses_flip(self):
        self.prepare()
        expected = self.receipt.read_bytes()
        self.advance_remote_only()
        for command in ('ls-remote', 'fetch'):
            with self.subTest(command=command):
                self.bash('''
git() {
  [[ " $* " != *" ''' + command + ''' "* ]] || return 88
  command git "$@"
}
selfhost_prepared_enter_flip "$SHA"
touch "$T/live-write"
''', ok=False)
                self.assertFalse((self.t / 'live-write').exists())
                self.assertEqual(self.receipt.read_bytes(), expected)
                self.assert_artifact_lock()

    def test_force_rewritten_remote_refuses_old_candidate_and_releases_gc_pin(self):
        self.prepare()
        self.git('checkout', '-q', '--orphan', 'rewritten')
        self.git('rm', '-q', '-rf', '.')
        (self.repo / 'source').write_text('unrelated')
        self.git('add', '.')
        self.git('commit', '-qm', 'rewritten')
        self.git('push', '-q', '--force', 'origin', 'HEAD:refs/heads/feat/v5-selfhost')
        self.bash('selfhost_prepared_enter_flip "$SHA"; touch "$T/live-write"', ok=False)
        self.assertFalse((self.t / 'live-write').exists())
        self.bash('selfhost_prepared_gc touch "$T/gc"')
        self.assertTrue((self.t / 'gc').exists())
        self.assertFalse(self.receipt.exists())

    def test_controller_change_after_prepare_still_refuses_ancestor_candidate(self):
        self.prepare()
        (self.repo / 'scripts').mkdir()
        (self.repo / 'scripts/deploy-v5-selfhost.sh').write_text('# changed controller\n')
        self.git('add', '.')
        self.git('commit', '-qm', 'changed controller')
        self.git('push', '-q', 'origin', 'HEAD')
        result = self.bash('selfhost_prepared_enter_flip "$SHA"; touch "$T/live-write"', ok=False)
        self.assertIn('changes the build controller', result.stderr)
        self.assertFalse((self.t / 'live-write').exists())
        self.assertTrue(self.receipt.exists())

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
        holder = self.spawn('''
selfhost_prepare_lock
touch "$T/artifact-held"
fixture_wait "$T/holder-exit"
selfhost_prepare_unlock
''')
        self.wait_event('artifact-held')
        self.bash('selfhost_prepared_gc touch "$T/gc"')
        self.assertFalse((self.t / 'gc').exists())
        (self.t / 'holder-exit').touch()
        self.finish(holder)
        os.chmod(self.t / 'prepared', 0o777)
        self.bash('selfhost_prepared_gc touch "$T/gc"')
        self.assertFalse((self.t / 'gc').exists())

    def test_gc_defers_dangling_prepared_root(self):
        self.prepare()
        saved = self.t / 'saved-prepared'
        self.receipt.parent.rename(saved)
        (self.t / 'prepared').symlink_to(self.t / 'absent-prepared', target_is_directory=True)
        original = (saved / (self.sha + '.json')).read_bytes()
        artifact = self.t / 'master/rel-test/.complete'
        artifact_before = artifact.read_bytes()
        result = self.bash('selfhost_prepared_gc rm -f "$MASTER_RELEASES_ROOT/rel-test/.complete"')
        self.assertIn('GC deferred: prepared state unreadable', result.stdout)
        self.assertEqual(artifact.read_bytes(), artifact_before)
        self.assertEqual((saved / (self.sha + '.json')).read_bytes(), original)
        self.assertTrue((self.t / 'prepared').is_symlink())
        self.assert_artifact_lock()

    def test_gc_defers_partial_and_untrusted_receipts(self):
        self.prepare()
        original = self.receipt.read_bytes()
        for data in (b'', b'{"sourceCommit":', b'{"master":null}'):
            with self.subTest(partial=data):
                self.receipt.write_bytes(data)
                self.bash('selfhost_prepared_enter_flip "$SHA"', ok=False)
                self.bash('selfhost_prepared_gc touch "$T/gc"')
                self.assertFalse((self.t / 'gc').exists())
                self.assertEqual(self.receipt.read_bytes(), data)
                self.assert_artifact_lock()
        self.receipt.write_bytes(original)
        os.chmod(self.receipt, 0o666)
        self.bash('selfhost_prepared_enter_flip "$SHA"', ok=False)
        self.bash('selfhost_prepared_gc touch "$T/gc"')
        self.assertFalse((self.t / 'gc').exists())
        self.assertEqual(self.receipt.read_bytes(), original)
        # A stale unreadable directory at a receipt path makes prune itself
        # fail; GC must also defer rather than discard evidence or artifacts.
        unreadable = self.receipt.parent / ('f' * 40 + '.json')
        unreadable.mkdir()
        result = self.bash('selfhost_prepared_gc touch "$T/gc"')
        self.assertIn('GC deferred: prepared state unreadable', result.stdout)
        self.assertFalse((self.t / 'gc').exists())
        self.assertTrue(unreadable.is_dir())

    def test_orphan_atomic_temp_is_pruned_only_without_active_publisher(self):
        self.prepare()
        self.bash('selfhost_prepared_complete "$SHA" "$MASTER_RELEASES_ROOT/rel-test"')
        partial = self.t / 'prepared/.receipt-interrupted'
        partial.write_bytes(b'{"sourceCommit":')
        holder = self.spawn('''
selfhost_prepare_lock
touch "$T/artifact-held"
fixture_wait "$T/publisher-exit"
selfhost_prepare_unlock
''')
        self.wait_event('artifact-held')
        self.bash('selfhost_prepared_gc touch "$T/gc"')
        self.assertFalse((self.t / 'gc').exists())
        self.assertEqual(partial.read_bytes(), b'{"sourceCommit":')
        (self.t / 'publisher-exit').touch()
        self.finish(holder)
        self.bash('selfhost_prepared_gc touch "$T/gc"')
        self.assertTrue((self.t / 'gc').exists())
        self.assertFalse(partial.exists())

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
        tampered = self.t / 'runtime/rel-0123456789ab/tampered'
        tampered.write_bytes(b'x')
        self.bash('selfhost_prepared_enter_flip "$SHA"', ok=False)
        self.assertRegex((self.t / 'notes').read_text(), r'flip.verifySec=\d+\.\d{3}')
        tampered.unlink()
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

    def test_real_deploy_keeps_pinned_source_when_tip_advances_during_build(self):
        (self.t / 'env').write_text('')
        (self.t / 'live').symlink_to(self.repo)
        self.script += '\n' + fn('cmd_deploy') + '\n' + fn('cutover_expected_source_commit')
        process = self.spawn('''
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
  [[ "$(source_commit)" != "$SHA" ]]
  [[ "$SELFHOST_SPLIT_PREPARED" == 1 ]]
  echo cutover >>"$T/events"
}
lease_train_finish() { echo "$1" >>"$T/events"; }
BUILD_BLOCK="$T/build-continue"
cmd_deploy
''')
        self.wait_event('build-ready')
        self.assertFalse(self.receipt.exists())
        self.advance()
        target = self.git('rev-parse', 'HEAD')
        (self.t / 'build-continue').touch()
        self.finish(process)
        self.assertEqual((self.t / 'events').read_text().splitlines(),
                         ['begin', 'deploy-free', 'build', 'bind', 'cutover', 'committed'])
        receipt = json.loads(self.receipt.read_text())
        for artifact, marker in (('master', '.complete'), ('runtime', 'MANIFEST.json')):
            doc = json.loads((Path(receipt[artifact]['path']) / marker).read_text())
            self.assertEqual(doc['sourceCommit'], self.sha)
        self.assertFalse((self.receipt.parent / (target + '.json')).exists())

    def test_busy_prepare_cannot_hold_flip_lock_for_build_duration(self):
        self.prepare()
        holder = self.spawn('''
selfhost_prepare_lock
touch "$T/artifact-held"
fixture_wait "$T/artifact-release"
''')
        self.wait_event('artifact-held')
        self.bash('''
(selfhost_prepared_enter_flip "$SHA") && exit 99
flock -n "$SELFHOST_DEPLOY_LOCK" true
''')
        (self.t / 'artifact-release').touch()
        self.finish(holder)

    def test_worker_settles_each_tip_only_after_its_own_committed_train(self):
        # Run the original S3 assertions against this checkout's actual worker.
        source = (ROOT / 'scripts/v5-lease-center-selftest.sh').read_text()
        markers = ('echo "═══ T1 ', 'echo "═══ S3 ', 'echo "═══ T2 ',
                   'echo "PASS=$PASS FAIL=$FAIL"')
        for marker in markers:
            self.assertEqual(source.count(marker), 1)
        first, s3, following, footer = (source.index(marker) for marker in markers)
        self.assertEqual([first, s3, following, footer], sorted([first, s3, following, footer]))
        setup, replacements = re.subn(r'^SCRIPT_DIR=.*$',
                                      f'SCRIPT_DIR={str(ROOT / "scripts")!r}',
                                      source[:first], flags=re.M)
        self.assertEqual(replacements, 1)
        script = self.t / 'lease-s3-focused.sh'
        script.write_text(setup + source[s3:following] + source[footer:])
        process = subprocess.Popen(['bash', str(script)], env=self.env, close_fds=True,
                                   start_new_session=True, text=True,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.addCleanup(self.reap_process, process)
        try:
            stdout, stderr = process.communicate(timeout=120)
        except subprocess.TimeoutExpired:
            process.terminate()  # Let the selftest's EXIT trap clean its private workers.
            try:
                stdout, stderr = process.communicate(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
                stdout, stderr = process.communicate(timeout=10)
            self.fail('lease S3 fixture timed out:\n' + stdout + stderr)
        self.assertEqual(process.returncode, 0, stdout + stderr)
        self.assertIn('PASS=11 FAIL=0', stdout)
        print(stdout, end='')


if __name__ == '__main__':
    unittest.main()
