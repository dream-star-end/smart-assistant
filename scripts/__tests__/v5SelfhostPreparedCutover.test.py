#!/usr/bin/env python3
"""Prepared receipt through the real cutover/saga/compensation state machine.

Compose the small Prepared harness; do not inherit and rerun its test cases.
Only function definitions are extracted: deployment entrypoints are never sourced.
Git, locks, digests, receipts, tuple/history and pointer writes are real and private.
Builds, npx, PG, host setup/units, survivor, service probes and GC are explicit
adapters below. No services, network, production paths or processes are touched.
"""
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import unittest


HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('prepared_harness', HERE / 'v5SelfhostPrepare.test.py')
PREPARED = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PREPARED)
ROOT = PREPARED.ROOT


def functions(path, names):
    source = (ROOT / path).read_text()
    # A tsx selfcheck contains a column-zero JS brace inside its quoted program;
    # shell function boundaries additionally have a blank line (or EOF).
    return '\n'.join(re.search(r'^' + name + r'\(\) \{.*?^\}(?=\n(?:\n|$))', source,
                               re.M | re.S)[0] for name in names.split())


class PreparedCutover(unittest.TestCase):
    def setUp(self):
        self.h = PREPARED.Prepared()
        self.addCleanup(self.h.doCleanups)
        self.h.setUp()
        self.t = self.h.t
        self.old = self.t / 'master/rel-old'
        self.new = self.t / 'master/rel-test'
        self.old_runtime = self.t / 'runtime/rel-old'
        self.old_bundle = self.t / 'platform/bundles/aaaaaaaaaaaa'
        for root, build in ((self.old, 'aaaaaaaa'), (self.new, 'bbbbbbbb')):
            for directory in ('node_modules/tsx', 'packages/web-react/dist',
                              'deploy/v5', 'deploy/v5-selfhost'):
                (root / directory).mkdir(parents=True)
            (root / 'packages/web-react/dist/index.html').write_text(
                f'<meta name="oc-build" content="{build}">')
            (root / 'VERSION.json').write_text(json.dumps({'commit': self.h.sha}))
            (root / 'deploy/v5/release-metadata.json').write_text(
                json.dumps({'requiredMigrations': ['0001_fixture']}))
            for unit in ('master.service', 'egress.service'):
                (root / 'deploy/v5-selfhost' / unit).write_text(f'{root.name}:{unit}\n')
        for directory in (self.old_runtime, self.old_bundle, self.t / 'installed',
                          self.t / 'tmp', self.t / 'breakglass'):
            directory.mkdir(parents=True, exist_ok=True)
        (self.t / 'live').symlink_to(self.old)
        (self.t / 'platform/current').symlink_to('bundles/aaaaaaaaaaaa')
        (self.t / 'master/.prev-release').write_text('previous-sentinel\n')
        self.old_tuple = {
            'OC_RUNTIME_IMAGE': 'old:image', 'OC_RUNTIME_IMAGE_ID': 'sha256:' + 'a' * 64,
            'OC_RUNTIME_RELEASE': str(self.old_runtime), 'OC_PLATFORM_BUNDLE': str(self.old_bundle),
        }
        (self.t / 'env').write_text(''.join(f'{k}={v}\n' for k, v in self.old_tuple.items()))
        for unit in ('master.service', 'egress.service'):
            (self.t / 'installed' / unit).write_text(f'rel-old:{unit}\n')

        # Emulates the survivor's persistence API only, without spawning a watcher.
        # Every phase/disarm operation proves the unconsumed receipt is still there.
        survivor = self.t / 'breakglass/survivor.sh'
        survivor.write_text('''#!/usr/bin/env bash
set -Eeuo pipefail
[[ -f "$T/prepared/$SHA.json" ]]
case "$1" in
  --set-phase)
    [[ "$2" != "${FAIL_PHASE:-}" ]] || exit 31
    printf '%s\\n' "$2" >"$SURVIVOR_STATE"
    printf 'phase:%s\\n' "$2" >>"$T/events" ;;
  --disarm)
    [[ "${FAIL_DISARM:-0}" == 0 ]] || exit 32
    printf 'committed\\n' >"$SURVIVOR_STATE"
    printf 'durable-disarm\\n' >>"$T/events" ;;
  --disarm-kept)
    [[ "$(cat "$SURVIVOR_STATE")" == kept-failed ]]
    printf 'disarm-kept\\n' >>"$T/events" ;;
  *) exit 99 ;;
esac
python3 - "$SURVIVOR_STATE" <<'PY'
import os, sys
with open(sys.argv[1], 'rb') as stream:
    os.fsync(stream.fileno())
PY
''')
        survivor.chmod(0o700)
        self.h.env.update({'TMPDIR': str(self.t / 'tmp')})
        deploy_functions = functions('scripts/deploy-v5-selfhost.sh', '''
            cutover_expected_source_commit cmd_cutover activate_tuple_joint
            cutover_clog cutover_fail cutover_survivor_script cutover_persist_phase
            cutover_persist_phase_or_compensate cutover_disarm_survivor
            cutover_rollback_inplace cutover_compensate selfhost_policy_get
            gate_fail_policy stay_window_sec gate_fail_drill_armed
            cutover_gate_against_release cutover_keep_failed write_stay_maintenance
            clear_stay_maintenance
        ''')
        # cmd_cutover creates the directory BEFORE E1, then redirects into it.
        # Map both occurrences (and dry-run paths), not just the log variable.
        deploy_functions = deploy_functions.replace('/opt/openclaude/tmp', '${T}/cutover-logs')
        runtime_functions = functions('scripts/v5-runtime-release-lib.sh', '''
            oc_hotcfg_activate_saga oc_hotcfg_env_get oc_hotcfg_env_write_tuple
            oc_hotcfg_env_snapshot_tuple oc_hotcfg_env_restore_tuple
            oc_hotcfg_flip_current oc_hotcfg_fsync_path oc_hotcfg_history_checksum
            oc_hotcfg__history_verify_line oc_hotcfg_history_last_committed
            oc_hotcfg_history_append oc_hotcfg_rotate_env_baks
        ''').replace('/var/log/openclaude-v5-selfhost-egress.log', '${T}/egress.log')
        master_functions = functions('scripts/v5-selfhost-master-release-lib.sh', '''
            release_artifact_digest release_dir_is_poisoned
            assert_master_release_static_gate assert_master_release_tsx_selfcheck
            read_required_migration_gap git_migration_name_diff gate_cutover_migrations
            cutover_wait_for_user_idle atomic_flip_live_symlink write_prev_release_file
            canonicalize_prev_release write_cutover_grace dist_oc_build
        ''')
        self.h.script = self.h.script.replace('build_master_release() {', 'fixture_build_master_release() {')
        self.h.script += '\n' + '\n'.join((deploy_functions, runtime_functions, master_functions))
        self.h.script += r'''
export T SHA
export SURVIVOR_STATE="$T/survivor.state"
CUTOVER_SURVIVOR_SCRIPT="$T/breakglass/survivor.sh"
MASTER_LIVE_LINK="$T/live"; BREAKGLASS_ROOT="$T/breakglass"
V5_ENV="$T/env"; OC_HOTCFG_ENV_FILE="$V5_ENV"; OC_HOTCFG_HISTORY="$T/history"
OC_HOTCFG_TUPLE_KEYS=(OC_RUNTIME_IMAGE OC_RUNTIME_IMAGE_ID OC_RUNTIME_RELEASE OC_PLATFORM_BUNDLE)
MASTER_RELEASE_COMPLETE_SCHEMA_VERSION=2
V5_UNIT=master.service; V5_EGRESS_UNIT=egress.service
V5_EGRESS_SLOT_SERVICE_TPL=egress@.service; V5_EGRESS_SLOT_SOCKET_TPL=egress@.socket
V5_EGRESS_BIND=127.0.0.1; V5_EGRESS_PORT=1
CUTOVER_GRACE_FILE="$T/grace"; CUTOVER_GRACE_SEC=90; CUTOVER_JOINT=1
CUTOVER_GATE_FAILED=""; CUTOVER_RECOVERY_REQUIRED=0
WEB_OVERLAY_ROOT="$T/overlay"; SELFHOST_POLICY_FILE="$T/policy"
V5_WATCH_MAINT="$T/watch-maint"; PG_DB=fixture
fixture_event() { printf '%s\n' "$*" >>"$T/events"; }
mlog() { echo "$*" >&2; }
oc_hotcfg__log() { echo "$*" >&2; }
oc_hotcfg__die() { echo "$*" >&2; return 1; }
tsum_mark() { fixture_event "$1"; }
release_policy_enabled() { return 1; }
release_policy_guard_owner() { ! flock -n "$SELFHOST_DEPLOY_LOCK" true; }
fixture_seal_master() {
  local rel="$1" digest
  digest="$(release_artifact_digest "$rel")"
  jq -cn --arg sha "$SHA" --arg digest "$digest" \
    '{schemaVersion:2,sourceCommit:$sha,builtAt:"20261028-000000",metadataSha256:$digest,artifactSha256:$digest}' \
    >"$rel/.complete"
}
build_master_release() { fixture_build_master_release "$@"; fixture_seal_master "$BUILT_MASTER_RELEASE"; }
host_log_policy_generation() { printf 'fixture\n'; }
npx() {
  fixture_event tsx
  if [[ "${FAIL_TSX:-0}" == 1 ]]; then printf 'invalid-tsx\n'; return 0; fi
  case "$*" in *tsx-ok*) printf 'tsx-ok\n';; *) printf 'transform-ok\n';; esac
}
# No database client can escape: migration uses sudo and idle uses its adapter.
psql() { die unexpected-direct-psql; }
sudo() {
  [[ "$1 $2 $3" == '-u postgres psql' ]] || die unexpected-sudo
  fixture_event migration-query
  [[ "${FAIL_MIGRATION_QUERY:-0}" == 0 ]] || return 1
  printf '0001_fixture\n'
}
psql_as_postgres() {
  fixture_event idle-query
  [[ "${FAIL_IDLE:-0}" == 0 ]] || return 1
  printf '0|0\n'
}
ensure_selfhost_env_keys() { fixture_event setup-env; }
seed_web_assets_pool_from_live() { fixture_event setup-assets; }
ensure_node_modules() { fixture_event setup-deps; }
install_aux_units() { fixture_event setup-aux; }
refresh_ccb_proxy_path() { fixture_event setup-proxy; }
ensure_model_authority() { fixture_event setup-model; }
assert_env_key_drift() { fixture_event setup-drift; }
wo_seed_pointer() { fixture_event overlay-seed; }
snapshot_cutover_units_from_release() {
  mkdir -p "$T/unit-snapshot"
  cp -a "$1/deploy/v5-selfhost/." "$T/unit-snapshot/"
  printf -v "$2" '%s' "$T/unit-snapshot"
  fixture_event unit-snapshot
}
backup_installed_units_for_cutover() {
  mkdir -p "$T/unit-backup"
  cp -a "$T/installed/." "$T/unit-backup/"
  printf -v "$1" '%s' "$T/unit-backup"
  fixture_event unit-backup
}
cutover_arm_survivor() {
  CUTOVER_SURVIVOR_ARMED=1
  printf 'armed\n' >"$SURVIVOR_STATE"
  fixture_event armed
}
install_host_log_policy_from_snapshot() { fixture_event host-log-policy; }
install_unit() { cp -a "$1" "$T/installed/"; fixture_event "install:${1##*/}"; }
install_egress_slot_units_from() { fixture_event slot-units; }
systemctl() { [[ "$*" == daemon-reload ]] || die unexpected-systemctl; fixture_event daemon-reload; }
egress_then_master_restart_cmd() { printf fixture_restart; }
fixture_restart() { fixture_event restart; }
cutover_smoke_against_release() {
  fixture_event forward-smoke
  [[ "${FAIL_SMOKE:-0}" == 0 ]] || { CUTOVER_LAST_FAIL=fixture-smoke; return 1; }
}
cutover_smoke_healthz_only() {
  fixture_event rollback-smoke
  [[ "${FAIL_ROLLBACK_SMOKE:-0}" == 0 ]]
}
cutover_tier2_restore() {
  fixture_event tier2-restore
  [[ "${FAIL_TIER2:-0}" == 0 ]] || return 1
  cp -a "$1/." "$T/installed/"
  cutover_smoke_healthz_only
}
oc_hotcfg_assert_tuple_viable() { fixture_event tuple-viable; }
oc_hotcfg_assert_master_runtime_batch_pair() { fixture_event batch-pair; }
oc_hotcfg_canary_boot() { fixture_event canary; }
oc_hotcfg_probe_master_lossless_capability() { return 1; }
lease_train_finish() { fixture_event "train:$1"; }
deploy_alert() { fixture_event "alert:$1"; }
persist_selfhost_model_authority_cutover() { fixture_event model-marker; }
sync_boot_scripts_from() { fixture_event sync-boot; }
sync_watch_from() { fixture_event sync-watch; }
# The wrapper leaves real receipt consumption and GC admission in place. Its
# command adapter proves what evidence exists when artifact deletion is allowed.
fixture_gc() {
  [[ "$(cat "$SURVIVOR_STATE")" == committed ]] || die gc-before-terminal
  if [[ -e "$SELFHOST_PREPARED_ROOT/$SHA.json" ]]; then die gc-before-consume; fi
  fixture_event gc
}
oc_hotcfg_gc() { fixture_gc; }
egress_slot_unit() { printf 'fixture-%s.%s\n' "$1" "$2"; }
wo_gc_buckets() { fixture_event gc-overlay; }
web_assets_pool_gc() { fixture_event gc-assets; }
# Never execute the real host GC script. The saga's eval hooks are functions;
# bash is needed only for the private survivor and this one GC command.
bash() {
  if [[ "$1" == "$SCRIPT_DIR/v5-release-gc.sh" ]]; then fixture_gc; return; fi
  [[ "$1" == "$CUTOVER_SURVIVOR_SCRIPT" ]] || die unexpected-bash-script
  command bash "$@"
}
curl() { die unexpected-network; }
ssh() { die unexpected-network; }
journalctl() { fixture_event journal; }
'''
        self.bash('fixture_seal_master "$T/master/rel-old"; selfhost_prepare_candidate "$SHA"')
        self.receipt_bytes = self.h.receipt.read_bytes()
        (self.t / 'events').write_text('')

    def bash(self, body, ok=True):
        # Real history fsync and checksum reads need more than the prepare-only
        # harness's 15s budget on a busy host. Keep a bounded private invocation.
        script = self.t / 'cutover-fixture.sh'
        script.write_text(self.h.script + '\n' + body)
        with subprocess.Popen(['bash', str(script)], env=self.h.env, text=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              start_new_session=True) as process:
            try:
                stdout, stderr = process.communicate(timeout=45)
            except subprocess.TimeoutExpired:
                # This session contains only this fixture's saved child PID and
                # its descendants. Reap it before temporary-directory cleanup.
                os.killpg(process.pid, signal.SIGKILL)
                stdout, stderr = process.communicate()
                self.fail(f'cutover timeout; last events={self.events()[-12:]}\n'
                          + stdout[-2000:] + stderr[-2000:])
            result = subprocess.CompletedProcess(process.args, process.returncode, stdout, stderr)
        if ok:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def cutover(self, settings='', ok=False, before=''):
        return self.bash(settings + '\n' + '''
selfhost_prepared_enter_flip "$SHA"
DEPLOY_BUILT_RELEASE="$BUILT_MASTER_RELEASE"; DEPLOY_BUILT_SOURCE_COMMIT="$SHA"
''' + before + '\ncmd_cutover', ok=ok)

    def events(self):
        path = self.t / 'events'
        return path.read_text().splitlines() if path.exists() else []

    def tuple(self):
        return dict(line.split('=', 1) for line in (self.t / 'env').read_text().splitlines())

    def assert_old_runtime(self):
        self.assertEqual((self.t / 'live').resolve(), self.old)
        self.assertEqual(self.tuple(), self.old_tuple)
        self.assertEqual(os.readlink(self.t / 'platform/current'), 'bundles/aaaaaaaaaaaa')
        self.assertEqual(self.h.receipt.read_bytes(), self.receipt_bytes)

    def assert_new_runtime(self):
        self.assertEqual((self.t / 'live').resolve(), self.new)
        self.assertEqual(self.tuple()['OC_RUNTIME_IMAGE'], 'test:image')
        self.assertEqual(self.tuple()['OC_RUNTIME_RELEASE'], str(self.t / 'runtime/rel-0123456789ab'))
        self.assertEqual(self.tuple()['OC_PLATFORM_BUNDLE'], str(self.t / 'platform/bundles/0123456789ab'))
        self.assertEqual(os.readlink(self.t / 'platform/current'), 'bundles/0123456789ab')

    def assert_no_install_or_gc(self):
        for unit in ('master.service', 'egress.service'):
            self.assertEqual((self.t / 'installed' / unit).read_text(), f'rel-old:{unit}\n')
        self.assertFalse(any(event.startswith(('install:', 'gc')) for event in self.events()))

    def test_e1_recomputes_digest_before_live_setup(self):
        (self.new / 'VERSION.json').write_text(json.dumps({'commit': self.h.sha, 'tampered': True}))
        result = self.cutover()
        self.assertIn('artifactSha256', result.stderr)
        self.assert_old_runtime()
        self.assert_no_install_or_gc()
        self.assertEqual((self.t / 'master/.prev-release').read_text(), 'previous-sentinel\n')
        self.assertFalse(any(event.startswith('setup-') for event in self.events()))

    def test_e1_tsx_refusal_before_live_setup(self):
        result = self.cutover('FAIL_TSX=1')
        self.assertIn('tsx 自检失败', result.stderr)
        self.assertIn('tsx', self.events())
        self.assert_old_runtime()
        self.assert_no_install_or_gc()
        self.assertEqual((self.t / 'master/.prev-release').read_text(), 'previous-sentinel\n')
        self.assertFalse(any(event.startswith('setup-') for event in self.events()))

    def test_e2_live_migration_query_refusal_preserves_live_and_prev(self):
        result = self.cutover('FAIL_MIGRATION_QUERY=1')
        self.assertIn('缺口比对失败', result.stderr)
        self.assertIn('setup-env', self.events())
        self.assertIn('unit-snapshot', self.events())
        self.assert_old_runtime()
        self.assert_no_install_or_gc()
        self.assertEqual((self.t / 'master/.prev-release').read_text(), 'previous-sentinel\n')
        self.assertFalse((self.t / 'unit-backup').exists())

    def test_idle_refusal_keeps_forensic_backup_but_never_arms_or_installs(self):
        result = self.cutover('FAIL_IDLE=1')
        self.assertIn('无法只读确认用户空闲', result.stdout)
        self.assert_old_runtime()
        self.assert_no_install_or_gc()
        self.assertEqual((self.t / 'master/.prev-release').read_text(), str(self.old) + '\n')
        self.assertEqual((self.t / 'unit-backup/master.service').read_text(), 'rel-old:master.service\n')
        self.assertFalse((self.t / 'survivor.state').exists())

    def test_failed_forward_smoke_restores_old_master_and_tuple_keeps_receipt(self):
        result = self.cutover('FAIL_SMOKE=1')
        self.assertIn('一级回滚后复合健康通过', result.stdout)
        self.assert_old_runtime()
        self.assertEqual((self.t / 'survivor.state').read_text(), 'committed\n')
        self.assertFalse((self.t / 'master/.manual-recovery-required').exists())
        self.assertIn('X.compensate', self.events())
        self.assertGreaterEqual(self.events().count('rollback-smoke'), 2)
        self.assertFalse(any(event.startswith('gc') for event in self.events()))
        history = [json.loads(line) for line in (self.t / 'history').read_text().splitlines()]
        self.assertEqual([row['transitionKind'] for row in history], ['prestate'])
        self.assertEqual(history[0]['masterRelease'], str(self.old))
        self.assertEqual((self.t / 'master/.prev-release').read_text(), str(self.old) + '\n')
        # A failed flip is retryable from the same sealed receipt, without a
        # rebuild; the retry must still traverse E1/E2 and the real saga again.
        self.bash('selfhost_prepare_candidate "$SHA"')
        self.assertNotIn('build', self.events())
        self.cutover(ok=True)
        self.assert_new_runtime()
        self.assertFalse(self.h.receipt.exists())
        self.assertEqual(self.events().count('E1'), 2)
        self.assertEqual(self.events().count('E2'), 2)

    def test_failed_compensation_persists_recovery_phase_and_retains_evidence(self):
        result = self.cutover('FAIL_SMOKE=1; FAIL_ROLLBACK_SMOKE=1; FAIL_TIER2=1')
        self.assertIn('两级补偿后仍失败', result.stdout)
        self.assert_old_runtime()
        self.assertIn('cutover-rollback-smoke-failed',
                      (self.t / 'master/.manual-recovery-required').read_text())
        self.assertEqual((self.t / 'survivor.state').read_text(), 'compensate-failed\n')
        self.assertEqual((self.t / 'master/.prev-release').read_text(), str(self.old) + '\n')
        self.assertTrue((self.t / 'unit-backup/master.service').exists())
        self.assertTrue(list((self.t / 'cutover-logs').glob('cutover-*.log')))
        self.assertLess(self.events().index('durable-disarm'), self.events().index('phase:compensate-failed'))
        self.assertFalse(any(event.startswith('gc') for event in self.events()))

    def test_stay_keeps_new_tuple_failed_train_and_receipt_without_gc(self):
        self.cutover('FAIL_SMOKE=1; OC_V5_SELFHOST_ON_GATE_FAIL=stay')
        self.assert_new_runtime()
        self.assertEqual(self.h.receipt.read_bytes(), self.receipt_bytes)
        self.assertEqual((self.t / 'master/.prev-release').read_text(), str(self.old) + '\n')
        self.assertEqual((self.t / 'survivor.state').read_text(), 'kept-failed\n')
        self.assertIn('source=deploy-gate-fail-stay', (self.t / 'watch-maint').read_text())
        self.assertIn('train:failed', self.events())
        self.assertIn('alert:deploy_gate_failed_kept', self.events())
        for unexpected in ('X.compensate', 'rollback-smoke', 'model-marker', 'sync-boot', 'sync-watch'):
            self.assertNotIn(unexpected, self.events())
        self.assertFalse(any(event.startswith('gc') for event in self.events()))

    def test_terminal_phase_failure_keeps_receipt_and_skips_gc(self):
        self.cutover('export FAIL_PHASE=committed')
        self.assert_new_runtime()
        self.assertEqual(self.h.receipt.read_bytes(), self.receipt_bytes)
        self.assertEqual((self.t / 'survivor.state').read_text(), 'smoked\n')
        self.assertNotIn('durable-disarm', self.events())
        self.assertFalse(any(event.startswith('gc') for event in self.events()))

    def test_disarm_failure_keeps_receipt_even_after_committed_phase(self):
        self.cutover('export FAIL_DISARM=1')
        self.assert_new_runtime()
        self.assertEqual(self.h.receipt.read_bytes(), self.receipt_bytes)
        self.assertEqual((self.t / 'survivor.state').read_text(), 'committed\n')
        self.assertFalse(any(event.startswith('gc') for event in self.events()))

    def test_success_consumes_exact_receipt_only_after_durable_terminal(self):
        self.cutover(ok=True)
        self.assert_new_runtime()
        self.assertFalse(self.h.receipt.exists())
        self.assertEqual((self.t / 'survivor.state').read_text(), 'committed\n')
        self.assertLess(self.events().index('phase:committed'), self.events().index('durable-disarm'))
        self.assertLess(self.events().index('durable-disarm'), self.events().index('gc'))
        self.assertEqual(self.events().count('gc'), 2)
        history = [json.loads(line) for line in (self.t / 'history').read_text().splitlines()]
        self.assertEqual([row['transitionKind'] for row in history], ['prestate', 'joint'])
        self.assertEqual(history[-1]['masterRelease'], str(self.new))
        self.assertEqual(history[-1]['previousMasterRelease'], str(self.old))

    def test_success_cannot_consume_receipt_for_a_different_master(self):
        # Simulates another prepared publication after entering flip. The consume
        # API must bind exact master path, and pending state must defer artifact GC.
        self.cutover(ok=True, before='''
python3 - "$SELFHOST_PREPARED_ROOT/$SHA.json" "$T/master/rel-other" <<'PY'
import json, sys
from pathlib import Path
path = Path(sys.argv[1])
doc = json.loads(path.read_text())
doc['master']['path'] = sys.argv[2]
path.write_text(json.dumps(doc))
PY
''')
        self.assert_new_runtime()
        self.assertEqual(json.loads(self.h.receipt.read_text())['master']['path'], str(self.t / 'master/rel-other'))
        self.assertNotIn('gc', self.events())


if __name__ == '__main__':
    unittest.main()
