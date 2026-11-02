#!/usr/bin/env python3
"""Actual saga and selfhost restart boundaries; isolated effects only.

The carrier fixture is the fault seam. The saga, wrapper ordering, generic
rollback, outer compensation and real restart function are production code.
No service, database, network or production configuration is accessed.
"""
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


def function(path, name):
    source = (ROOT / path).read_text()
    match = re.search(r'^' + name + r'\(\) \{.*?^\}(?=\n(?:\n|$))', source, re.M | re.S)
    if not match:
        raise AssertionError('production function missing: ' + name)
    return match[0]


class ActivationWiring(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='cc5-wiring-')
        self.addCleanup(self.temp.cleanup)
        self.t = Path(self.temp.name)
        self.events = self.t / 'events'
        self.script = '\n'.join([
            'set -Eeuo pipefail', f'T={str(self.t)!r}',
            f'source {str(ROOT / "scripts/lib/v5-selfhost-cc5-activation.sh")!r}',
            function('scripts/v5-runtime-release-lib.sh', 'oc_hotcfg_activate_saga'),
            function('scripts/deploy-v5-selfhost.sh', 'egress_slot_flip_then_master_restart'),
            function('scripts/deploy-v5-selfhost.sh', 'cutover_rollback_inplace'),
            function('scripts/deploy-v5-selfhost.sh', 'cutover_tier2_restore'),
            function('scripts/deploy-v5-selfhost.sh', 'cmd_deploy'),
            function('scripts/deploy-v5-selfhost.sh', 'cutover_arm_survivor'),
            function('scripts/lib/v5-selfhost-release-policy.sh', 'release_policy_original_finalizer'),
        ]) + r'''
V5_UNIT=fixture-master; DRY=0; LEASE_TRAIN_ID=fixture-train
CUTOVER_BACKUP="$T/backup"; mkdir "$CUTOVER_BACKUP"
printf before >"$T/flags"
event() { printf '%s\n' "$*" >>"$T/events"; }
release_policy_enabled() { [[ "${POLICY:-0}" == 1 ]]; }
release_policy_flip_live() { event policy-flip; }
release_policy_restore_live_before() { event policy-restore; }
cc5_activation_apply() { cc5_activation_py apply; }
cc5_activation_py() {
  case "$1" in
    apply|rollback) event "$1"; [[ "${MISSING_REQUEST:-0}" == 1 ]] || printf after >"$T/flags" ;;
    revert) event revert; [[ "${FAIL_REVERT:-0}" == 0 ]] || return 79; printf before >"$T/flags" ;;
    check-restart)
      event "guard:$5"
      [[ "${MISSING_REQUEST:-0}" == 1 || "$(cat "$T/flags")" == "$5" ]] || return 79 ;;
    guard) event recovery-guard; [[ "$(cat "$T/flags")" == before ]] || return 75 ;;
    finalize) event finalize; [[ "${FAIL_FINALIZE:-0}" == 0 && -e "$T/history-committed" ]] || return 79 ;;
    *) return 98 ;;
  esac
}
egress_slot_flip() { event egress-effect; }
systemctl() { event master-effect; }
cutover_clog() { event "$*"; }
write_cutover_grace() { event grace; }
canonicalize_prev_release() { echo previous; }
atomic_flip_live_symlink() { event pointer-effect; }
cutover_smoke_healthz_only() { event old-smoke; }
cutover_backup_units_are_live_wd() { event unit-check; return 0; }
oc_hotcfg_assert_tuple_viable() { :; }
oc_hotcfg_assert_master_runtime_batch_pair() { :; }
oc_hotcfg_canary_boot() { :; }
oc_hotcfg_history_last_committed() { printf existing; }
oc_hotcfg_env_snapshot_tuple() { printf 'OC_RUNTIME_RELEASE=old\n'; }
oc_hotcfg_env_get() { printf old; }
oc_hotcfg_env_write_tuple() { event tuple-new; }
oc_hotcfg_env_restore_tuple() { event tuple-old; }
oc_hotcfg_flip_current() { event bundle-new; }
oc_hotcfg_probe_master_lossless_capability() { return 1; }
oc_hotcfg_history_append() {
  event history-append
  [[ "${FAIL_HISTORY:-0}" == 0 ]] || return 1
  touch "$T/history-committed"
}
oc_hotcfg_rotate_env_baks() { :; }
oc_hotcfg__log() { :; }
oc_hotcfg__die() { event saga-hold; return 1; }
forward_smoke() {
  event "smoke:${HOTCFG_SAGA_ROLLING_BACK:-0}"
  [[ "${HOTCFG_SAGA_ROLLING_BACK:-0}" == 1 || "${FAIL_SMOKE:-0}" == 0 ]]
}
fixture_policy() {
  [[ "$1" != failure || "${KEEP_FAILED:-0}" == 0 ]] || return 78
}
run_saga() {
  oc_hotcfg_activate_saga "$T/env" "$T/platform" '' "$T/history" image image-id '' '' \
    egress_slot_flip_then_master_restart forward_smoke \
    'cc5_activation_extra_apply candidate previous' 'cc5_activation_extra_revert previous' \
    candidate previous '' '' '' joint "${POLICY_ADAPTER:-}"
}
'''

    def run_shell(self, body):
        result = subprocess.run(['bash', '-c', self.script + '\n' + body],
                                env={'PATH': os.environ['PATH']}, text=True,
                                capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return self.events.read_text().splitlines() if self.events.exists() else []

    def test_default_off_and_success_use_existing_commit_then_finalize(self):
        events = self.run_shell('MISSING_REQUEST=1; run_saga; cc5_activation_finalize')
        self.assertEqual(events.count('master-effect'), 1)
        self.assertLess(events.index('history-append'), events.index('finalize'))

    def test_smoke_failure_restores_keys_before_old_restart(self):
        events = self.run_shell('FAIL_SMOKE=1; run_saga && exit 91 || :')
        self.assertEqual(events.count('master-effect'), 2)
        self.assertLess(events.index('tuple-old'), events.index('revert'))
        self.assertLess(events.index('revert'), events.index('guard:before'))
        self.assertLess(events.index('guard:before'), len(events) - 1)

    def test_failed_restore_blocks_generic_restart_and_outer_tier2(self):
        events = self.run_shell('''
FAIL_SMOKE=1; FAIL_REVERT=1
run_saga && exit 91 || :
cutover_rollback_inplace candidate "$T/backup" && exit 92 || :
cutover_tier2_restore "$T/backup" && exit 93 || :
''')
        # The real generic saga still invoked restart_cmd after revert failed;
        # the real selfhost function rejected it before either service effect.
        self.assertIn('guard:before', events)
        self.assertEqual(events.count('master-effect'), 1)
        self.assertEqual(events.count('egress-effect'), 1)
        self.assertNotIn('pointer-effect', events)
        self.assertNotIn('unit-check', events)

    def test_history_failure_also_restores_before_old_restart(self):
        events = self.run_shell('FAIL_HISTORY=1; run_saga && exit 91 || :')
        self.assertLess(events.index('history-append'), events.index('revert'))
        self.assertEqual(events.count('master-effect'), 2)

    def test_original_policy_hooks_survive_both_directions(self):
        events = self.run_shell('POLICY=1; FAIL_SMOKE=1; run_saga && exit 91 || :')
        self.assertLess(events.index('policy-flip'), events.index('apply'))
        self.assertLess(events.index('revert'), events.index('policy-restore'))
        self.assertLess(events.index('policy-restore'), events.index('guard:before'))

    def test_keep_failed_does_not_force_config_revert(self):
        events = self.run_shell('POLICY=1; POLICY_ADAPTER=fixture_policy; KEEP_FAILED=1; FAIL_SMOKE=1; run_saga && exit 91 || :')
        self.assertNotIn('revert', events)
        self.assertEqual(events.count('master-effect'), 1)

    def test_outer_compensation_proves_before_state_before_pointer_or_restart(self):
        (self.t / '.prev-release').write_text('previous\n')
        events = self.run_shell('''
MASTER_RELEASES_ROOT="$T"
printf after >"$T/flags"
egress_then_master_restart_cmd() { printf egress_slot_flip_then_master_restart; }
cutover_rollback_inplace candidate "$T/backup"
''')
        self.assertLess(events.index('revert'), events.index('pointer-effect'))
        self.assertLess(events.index('guard:before'), events.index('master-effect'))


    def test_policy_resume_finalizes_before_reporting_success(self):
        events = self.run_shell('''
RELEASE_POLICY_RESUME=1
touch "$T/history-committed"
release_policy_recover_forward() { event policy-recovered; }
log() { event "$*"; }
cmd_deploy
''')
        self.assertLess(events.index('policy-recovered'), events.index('finalize'))
        self.assertLess(events.index('finalize'), next(i for i, x in enumerate(events) if x.startswith('✓ same-operation')))

    def test_policy_resume_unknown_receipt_never_reports_success(self):
        events = self.run_shell('''
RELEASE_POLICY_RESUME=1; FAIL_FINALIZE=1
touch "$T/history-committed"
release_policy_recover_forward() { event policy-recovered; }
log() { event "$*"; }
cmd_deploy && exit 91 || [[ "$?" == 79 ]]
''')
        self.assertIn('finalize', events)
        self.assertFalse(any(x.startswith('✓ same-operation') for x in events))

    def test_arm_preserves_existing_installed_live_restore_implementation(self):
        events = self.run_shell('''
SCRIPT_DIR="$T/source"; BREAKGLASS_ROOT="$T/breakglass"
mkdir -p "$SCRIPT_DIR/lib" "$BREAKGLASS_ROOT"
touch "$SCRIPT_DIR/v5-selfhost-cutover-survivor.sh" "$SCRIPT_DIR/lib/v5-selfhost-cc5-activation.py"
printf 'existing-live-backup-restore\n' >"$BREAKGLASS_ROOT/restore-worktree-units.sh"
release_policy_guard_owner() { return 0; }
cutover_survivor_script() { printf '%s' "$BREAKGLASS_ROOT/cutover-survivor.sh"; }
install() {
  event "install:${*: -1}"
  printf '#!/bin/sh\nexit 0\n' >"${*: -1}"
  chmod 700 "${*: -1}"
}
cutover_arm_survivor "$T/backup"
[[ "$(cat "$BREAKGLASS_ROOT/restore-worktree-units.sh")" == existing-live-backup-restore ]]
''')
        self.assertTrue(any(x.endswith('/cc5-activation.py') for x in events))
        self.assertFalse(any(x.endswith('/restore-worktree-units.sh') for x in events))


    def test_policy_finalizer_closes_carrier_before_watch_replacement(self):
        events = self.run_shell('''
touch "$T/history-committed"
release_policy_require_owner() { return 0; }
cutover_persist_phase() { event phase-committed; }
cutover_disarm_survivor() { event disarm; }
persist_selfhost_model_authority_cutover() { :; }
sync_boot_scripts_from() { :; }
sync_watch_from() { event watch-replaced; }
watch_install_state() { echo same; }
release_policy_original_finalizer candidate
''')
        self.assertLess(events.index('finalize'), events.index('watch-replaced'))

    def test_policy_finalizer_unknown_carrier_retains_guarded_watch(self):
        events = self.run_shell('''
touch "$T/history-committed"; FAIL_FINALIZE=1
release_policy_require_owner() { return 0; }
cutover_persist_phase() { :; }
cutover_disarm_survivor() { :; }
persist_selfhost_model_authority_cutover() { :; }
sync_boot_scripts_from() { :; }
sync_watch_from() { event watch-replaced; }
watch_install_state() { echo same; }
release_policy_original_finalizer candidate && exit 91 || [[ "$?" == 79 ]]
''')
        self.assertIn('finalize', events)
        self.assertNotIn('watch-replaced', events)


class InstalledRecoveryGuards(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='cc5-installed-guard-')
        self.addCleanup(self.temp.cleanup)
        self.t = Path(self.temp.name)
        self.index = self.t / 'private/index.json'
        self.index.parent.mkdir()
        self.index.write_text('{}')
        self.helper = self.t / 'private/helper.py'
        self.result = self.t / 'helper-result'
        self.result.write_text('75')
        self.helper.write_text('from pathlib import Path\nraise SystemExit(int(Path(' + repr(str(self.result)) + ').read_text()))\n')

    def mapped(self, source):
        return source.replace('/opt/openclaude/cc5-t1555u/activation-index.json', str(self.index)).replace(
            '/opt/openclaude/v5-selfhost-breakglass/cc5-activation.py', str(self.helper))

    def test_survivor_pending_receipt_cannot_claim_committed_marker_success(self):
        marker = self.t / 'committed'
        marker.write_text('committed_at=fixture\n')
        body = self.mapped(function('scripts/v5-selfhost-cutover-survivor.sh', 'cc5_activation_recovery_safe'))
        body += '\n' + function('scripts/v5-selfhost-cutover-survivor.sh', 'maybe_restore')
        body += '\nlog() { :; }; release_policy_context_absent() { return 0; }\n'
        body += f'SURVIVOR_COMMITTED={str(marker)!r}\nmaybe_restore\n'
        result = subprocess.run(['bash', '-c', body], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 75, result.stderr)
        self.result.write_text('0')
        result = subprocess.run(['bash', '-c', body], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_watch_direct_mutation_also_holds_on_pending_carrier(self):
        body = self.mapped(function('scripts/v5-selfhost-watch.sh', 'cc5_activation_recovery_safe'))
        body += '\n' + function('scripts/v5-selfhost-watch.sh', 'watch_policy_mutation')
        body += '\nrelease_policy_context_absent() { return 0; }; is_true_dry() { return 0; }\n'
        effects = self.t / 'watch-effects'
        body += f'fixture_restore() {{ echo effect >>{str(effects)!r}; }}\nwatch_policy_mutation fixture_restore\n'
        result = subprocess.run(['bash', '-c', body], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 75, result.stderr)
        self.assertFalse(effects.exists())
        self.result.write_text('0')
        result = subprocess.run(['bash', '-c', body], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(effects.read_text(), 'effect\n')

    def test_installed_restore_holds_before_any_unit_write_then_allows_closed_receipt(self):
        backup = self.t / 'backup'
        installed = self.t / 'systemd'
        backup.mkdir()
        installed.mkdir()
        units = ['openclaude-v5-selfhost.service', 'openclaude-v5-selfhost-egress.service']
        for unit in units:
            (backup / unit).write_text('[Service]\nWorkingDirectory=/opt/openclaude/openclaude-v5-selfhost\nExecStart=/bin/true\n')
            (installed / unit).write_text('original-unit\n')
        script = self.t / 'restore.sh'
        script.write_text(self.mapped((ROOT / 'scripts/v5-selfhost-restore-worktree-units.sh').read_text()))
        command = ['bash', str(script), '--backup-dir', str(backup), '--systemd-dir', str(installed),
                   '--no-reload', '--no-restart', '--no-healthz']
        result = subprocess.run(command, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 75, result.stdout + result.stderr)
        for unit in units:
            self.assertEqual((installed / unit).read_text(), 'original-unit\n')
        self.result.write_text('0')
        result = subprocess.run(command, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for unit in units:
            self.assertEqual((installed / unit).read_bytes(), (backup / unit).read_bytes())


if __name__ == '__main__':
    unittest.main()
