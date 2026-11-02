#!/usr/bin/env python3
"""Owner-channel and original-finalizer fixtures; never load the real Installer."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

PROJECT = Path(__file__).resolve().parents[2]
LIB = PROJECT / "scripts/lib"
TRAIN = "tr-owner-fixture-001"


def function_body(path, name):
    lines = path.read_text().splitlines(keepends=True)
    start = next(i for i, line in enumerate(lines) if line.startswith(name + "() {"))
    end = next(i for i in range(start + 1, len(lines)) if lines[i].rstrip() == "}")
    return "".join(lines[start:end + 1])


FAKE_INSTALLER = r'''
import json
import os
from pathlib import Path

class InstallError(RuntimeError):
    pass

class OwnershipRequired(InstallError):
    pass

class RecoveryRequired(InstallError):
    def __init__(self, snapshot):
        self.snapshot = snapshot
        super().__init__("PRIVATE_RECOVERY_MESSAGE")

class Installer:
    def finalize(self, source_release, *, owner_check=None, operation_id=None, expected_source_sha=None):
        path = Path(source_release) / "deploy/v5-selfhost/host-memory-action.json"
        action = json.loads(path.read_text()) if path.exists() else {"action": "apply"}
        if action["action"] == "restore":
            owner_check()
            snapshot_operation = action["snapshotOperationId"]
            snapshot = self.snapshot_for_operation(snapshot_operation)
            result = self.rollback(snapshot, owner_check=owner_check, operation_id=snapshot_operation)
            result.update(action="restore", owner_operation_id=operation_id,
                          snapshot_operation_id=snapshot_operation, snapshot_sha256="a" * 64,
                          oom_sampling_accepted=False)
            return result
        result = self.apply(source_release, owner_check=owner_check, operation_id=operation_id)
        result.update(action="apply", owner_operation_id=operation_id)
        return result

    def apply(self, source_release=None, *, owner_check=None, operation_id=None):
        audit = Path(os.environ["FIXTURE_AUDIT"])
        data = {"source_release": str(source_release), "operation_id": operation_id,
                "callback": getattr(owner_check, "__name__", None), "authorized_checks": 0}
        audit.write_text(json.dumps(data))
        if data["callback"] != "owner_check":
            raise InstallError("PRIVATE_UNEXPECTED_CALLBACK")
        for _ in range(2):
            owner_check()
            data["authorized_checks"] += 1
            audit.write_text(json.dumps(data))
        mode = os.environ.get("FIXTURE_MODE", "success")
        if mode == "install-error":
            raise InstallError("PRIVATE_INSTALL_MESSAGE")
        if mode == "unexpected-error":
            raise ValueError("PRIVATE_UNEXPECTED_MESSAGE")
        if mode == "recovery-required":
            raise RecoveryRequired(Path(source_release) / "fixture-snapshot")
        return {"changed": True, "snapshot": None, "state": "verified",
                "private_unknown_field": "PRIVATE_RESULT_PAYLOAD"}

    def snapshot_for_operation(self, operation_id):
        audit = Path(os.environ["FIXTURE_AUDIT"])
        audit.write_text(json.dumps({"lookup_operation_id": operation_id}))
        if os.environ.get("FIXTURE_MODE") == "missing-receipt":
            raise InstallError("PRIVATE_MISSING_RECEIPT")
        return Path(os.environ["FIXTURE_ROOT"]) / "original-receipt-snapshot"

    def rollback(self, snapshot, *, owner_check=None, operation_id=None):
        audit = Path(os.environ["FIXTURE_AUDIT"])
        data = json.loads(audit.read_text())
        data.update(action="restore", snapshot=str(snapshot), operation_id=operation_id,
                    callback=getattr(owner_check, "__name__", None), authorized_checks=0)
        audit.write_text(json.dumps(data))
        if data["callback"] != "owner_check":
            raise InstallError("PRIVATE_UNEXPECTED_CALLBACK")
        for _ in range(2):
            owner_check()
            data["authorized_checks"] += 1
            audit.write_text(json.dumps(data))
        if os.environ.get("FIXTURE_MODE") == "restore-error":
            raise InstallError("PRIVATE_RESTORE_ERROR")
        return {"restored": os.environ.get("FIXTURE_MODE") != "restore-unverified",
                "changed": True, "snapshot": str(snapshot), "state": "original-state",
                "private_unknown_field": "PRIVATE_RESULT_PAYLOAD"}
'''


def supported_bash():
    candidate = os.environ.get("HOST_MEMORY_TEST_BASH") or shutil.which("bash")
    if not candidate:
        return None
    probe = subprocess.run([candidate, "--noprofile", "--norc", "-c", "printf '%s' \"${BASH_VERSINFO[0]}\""],
                           capture_output=True, text=True, timeout=5)
    return candidate if probe.returncode == 0 and probe.stdout.isdigit() and int(probe.stdout) >= 4 else None


BASH4 = supported_bash()


class OwnerFixture(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix=".host-memory-owner-test-", dir=PROJECT)
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def candidate(self, collector=True):
        candidate = self.root / "candidate"
        library = candidate / "scripts/lib"
        library.mkdir(parents=True)
        shutil.copyfile(LIB / "v5-selfhost-host-memory-owner.py", library / "v5-selfhost-host-memory-owner.py")
        (library / "v5-selfhost-host-memory-install.py").write_text(FAKE_INSTALLER)
        if collector:
            (candidate / "scripts/v5-selfhost-host-memory.py").write_text("# fixture collector; never executed\n")
        unit = candidate / "deploy/v5-selfhost/openclaude-v5-selfhost-host-memory.service"
        unit.parent.mkdir(parents=True)
        unit.write_text("# fixture unit; never installed\n")
        return candidate

    def environment(self, mode="success"):
        return {"HOME": str(self.root), "PATH": str(self.root / "fake-bin"),
                "PYTHONDONTWRITEBYTECODE": "1", "FIXTURE_AUDIT": str(self.root / "audit.json"),
                "FIXTURE_MODE": mode, "FIXTURE_ROOT": str(self.root)}

    def audit(self):
        return json.loads((self.root / "audit.json").read_text())


class StdioOwnerTests(OwnerFixture):
    def run_adapter(self, responses, mode="success", train=TRAIN, action=None,
                    expected_sha=None, descriptor=None):
        candidate = self.candidate()
        adapter = candidate / "scripts/lib/v5-selfhost-host-memory-owner.py"
        if descriptor is not None:
            (candidate / "deploy/v5-selfhost/host-memory-action.json").write_text(json.dumps(descriptor))
        argv = [sys.executable, str(adapter), str(candidate), train]
        if action is not None or expected_sha is not None:
            argv.append(action or "apply")
        if expected_sha is not None:
            argv.append(expected_sha)
        result = subprocess.run(argv,
                                input=responses, env=self.environment(mode), cwd=self.root,
                                capture_output=True, text=True, timeout=10)
        self.assertNotIn("PRIVATE_", result.stdout + result.stderr)
        return result, candidate

    def test_two_exact_authorizations_are_required_before_one_filtered_result(self):
        result, candidate = self.run_adapter("OWNER_OK\nOWNER_OK\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        lines = result.stdout.splitlines()
        self.assertEqual(lines[:2], ["OWNER_CHECK", "OWNER_CHECK"])
        self.assertEqual(len(lines), 3)
        self.assertTrue(lines[2].startswith("RESULT "))
        self.assertEqual(json.loads(lines[2][7:]), {"changed": True, "snapshot": None, "state": "verified",
                                                  "action": "apply", "owner_operation_id": TRAIN})
        audit = self.audit()
        self.assertEqual(audit, {"source_release": str(candidate), "operation_id": TRAIN,
                                 "callback": "owner_check", "authorized_checks": 2})

    def test_eof_no_or_unrecognized_response_fail_closed_without_result(self):
        for response in ("", "OWNER_NO\n", "OWNER_OK extra\n", "ERROR RuntimeError\n",
                         "OWNER_OK; arbitrary_callback\n"):
            with self.subTest(response=response):
                # Each subcase gets its own fake module/candidate and audit state.
                temporary = tempfile.TemporaryDirectory(prefix="case-", dir=self.root)
                previous = self.root
                try:
                    self.root = Path(temporary.name)
                    result, _ = self.run_adapter(response)
                    self.assertEqual(result.returncode, 86)
                    self.assertNotIn("RESULT ", result.stdout)
                    self.assertEqual(self.audit()["authorized_checks"], 0)
                finally:
                    self.root = previous
                    temporary.cleanup()

    def test_second_authorization_cannot_be_omitted_or_denied(self):
        result, _ = self.run_adapter("OWNER_OK\nOWNER_NO\n")
        self.assertEqual(result.returncode, 86)
        self.assertEqual(result.stdout.splitlines().count("OWNER_CHECK"), 2)
        self.assertNotIn("RESULT ", result.stdout)
        self.assertEqual(self.audit()["authorized_checks"], 1)

    def test_eof_after_first_authorization_does_not_return_result(self):
        result, _ = self.run_adapter("OWNER_OK\n")
        self.assertEqual(result.returncode, 86)
        self.assertNotIn("RESULT ", result.stdout)
        self.assertEqual(self.audit()["authorized_checks"], 1)

    def test_install_error_is_79_and_does_not_echo_message(self):
        result, _ = self.run_adapter("OWNER_OK\nOWNER_OK\n", "install-error")
        self.assertEqual(result.returncode, 79)
        self.assertIn("ERROR InstallError", result.stdout)
        self.assertNotIn("RESULT ", result.stdout)
        self.assertEqual(self.audit()["operation_id"], TRAIN)

    def test_unexpected_exception_has_no_message_or_result(self):
        result, _ = self.run_adapter("OWNER_OK\nOWNER_OK\n", "unexpected-error")
        self.assertEqual(result.returncode, 79)
        self.assertIn("ERROR ValueError", result.stdout)
        self.assertNotIn("RESULT ", result.stdout)

    def test_recovery_required_keeps_only_type_and_snapshot(self):
        result, candidate = self.run_adapter("OWNER_OK\nOWNER_OK\n", "recovery-required")
        self.assertEqual(result.returncode, 79)
        error = next(line[6:] for line in result.stdout.splitlines() if line.startswith("ERROR "))
        self.assertEqual(json.loads(error), {"type": "RecoveryRequired",
                                             "snapshot": str(candidate / "fixture-snapshot")})
        self.assertNotIn("RESULT ", result.stdout)

    def test_invalid_operation_id_never_loads_installer(self):
        result, _ = self.run_adapter("", train="not-a-train")
        self.assertEqual(result.returncode, 79)
        self.assertFalse((self.root / "audit.json").exists())

    def test_installer_legal_underscore_and_max_length_operation_ids_are_accepted(self):
        for train in ("tr-original_operation-001", "tr-a" + "_" * 124):
            with self.subTest(train=train):
                temporary = tempfile.TemporaryDirectory(prefix="case-", dir=self.root)
                previous = self.root
                try:
                    self.root = Path(temporary.name)
                    result, _ = self.run_adapter("OWNER_OK\nOWNER_OK\n", train=train)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(self.audit()["operation_id"], train)
                finally:
                    self.root = previous
                    temporary.cleanup()

    def test_restore_uses_only_original_operation_snapshot_and_real_callback(self):
        result, _ = self.run_adapter("OWNER_OK\nOWNER_OK\nOWNER_OK\n", action="restore")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines().count("OWNER_CHECK"), 3)
        audit = self.audit()
        self.assertEqual(audit["lookup_operation_id"], TRAIN)
        self.assertEqual(audit["operation_id"], TRAIN)
        self.assertEqual(audit["snapshot"], str(self.root / "original-receipt-snapshot"))
        self.assertEqual(audit["callback"], "owner_check")
        self.assertEqual(audit["authorized_checks"], 2)
        receipt = json.loads(next(line[7:] for line in result.stdout.splitlines() if line.startswith("RESULT ")))
        self.assertTrue(receipt["restored"])
        self.assertNotIn("private_unknown_field", receipt)

    def test_restore_requires_owner_before_receipt_lookup(self):
        result, _ = self.run_adapter("OWNER_NO\n", action="restore")
        self.assertEqual(result.returncode, 86)
        self.assertFalse((self.root / "audit.json").exists())

    def test_restore_missing_receipt_and_unverified_result_are_not_success(self):
        for mode, responses in (("missing-receipt", "OWNER_OK\n"),
                                ("restore-unverified", "OWNER_OK\n" * 3),
                                ("restore-error", "OWNER_OK\n" * 3)):
            with self.subTest(mode=mode):
                temporary = tempfile.TemporaryDirectory(prefix="case-", dir=self.root)
                previous = self.root
                try:
                    self.root = Path(temporary.name)
                    result, _ = self.run_adapter(responses, mode, action="restore")
                    self.assertEqual(result.returncode, 79)
                    self.assertNotIn("RESULT ", result.stdout)
                finally:
                    self.root = previous
                    temporary.cleanup()

    def test_unknown_action_or_snapshot_path_is_not_an_owner_mode(self):
        for action in ("/tmp/snapshot", "--rollback=/tmp/snapshot", "other"):
            with self.subTest(action=action):
                temporary = tempfile.TemporaryDirectory(prefix="case-", dir=self.root)
                previous = self.root
                try:
                    self.root = Path(temporary.name)
                    result, _ = self.run_adapter("", action=action)
                    self.assertEqual(result.returncode, 79)
                    self.assertFalse((self.root / "audit.json").exists())
                finally:
                    self.root = previous
                    temporary.cleanup()

    def test_normal_new_publish_restore_keeps_owner_and_snapshot_operations_distinct(self):
        previous = "tr-previous-accepted"
        result, _ = self.run_adapter("OWNER_OK\n" * 3, expected_sha="a" * 40,
                                     descriptor={"schema": 1, "action": "restore",
                                                 "snapshotOperationId": previous})
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads(next(line[7:] for line in result.stdout.splitlines() if line.startswith("RESULT ")))
        self.assertEqual(receipt["owner_operation_id"], TRAIN)
        self.assertEqual(receipt["snapshot_operation_id"], previous)
        self.assertEqual(receipt["snapshot_sha256"], "a" * 64)
        self.assertTrue(receipt["restored"])
        self.assertFalse(receipt["oom_sampling_accepted"])
        self.assertEqual(self.audit()["operation_id"], previous)


class CoprocessWrapperTests(OwnerFixture):
    def run_wrapper(self, mode="success", legacy=False, lose_owner=False, action="apply", descriptor=None):
        candidate = self.candidate()
        if descriptor is not None:
            (candidate / "deploy/v5-selfhost/host-memory-action.json").write_text(json.dumps(descriptor))
        binary = self.root / "fake-bin"
        binary.mkdir()
        (binary / "python3").symlink_to(sys.executable)
        env = self.environment(mode)
        env.update(CANDIDATE=str(candidate), REAL_LIBRARY=str(LIB / "v5-selfhost-host-memory.sh"),
                   LEGACY="1" if legacy else "0", LOSE_OWNER="1" if lose_owner else "0", ACTION=action)
        script = r'''
set -u
LEASE_TRAIN_ID=tr-owner-fixture-001
LEASE_TARGET_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
guard_calls=0
release_policy_enabled() { [[ "$LEGACY" == 0 ]]; }
release_policy_require_owner() {
  guard_calls=$((guard_calls + 1))
  [[ "$LOSE_OWNER" == 0 || "$guard_calls" -lt 2 ]]
}
cutover_clog() { printf '%s\n' "$*" >>"$FIXTURE_ROOT/wrapper.log"; }
source "$REAL_LIBRARY"
if [[ "$ACTION" == restore ]]; then
  if host_memory_sampler_restore "$CANDIDATE"; then rc=0; else rc=$?; fi
else
  if host_memory_sampler_finalize "$CANDIDATE"; then rc=0; else rc=$?; fi
fi
printf '%s\n' "$guard_calls" >"$FIXTURE_ROOT/guard-count"
exit "$rc"
'''
        return subprocess.run([BASH4, "--noprofile", "--norc", "-c", script], cwd=self.root,
                              env=env, capture_output=True, text=True, timeout=10)

    @unittest.skipUnless(BASH4, "coproc requires Bash >=4; Mac system Bash 3 fixture skipped")
    def test_actual_coproc_pipe_authorizes_twice_and_legacy_never_activates(self):
        result = self.run_wrapper()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.audit()["authorized_checks"], 2)
        self.assertEqual((self.root / "guard-count").read_text().strip(), "3")

    @unittest.skipUnless(BASH4, "coproc requires Bash >=4; Mac system Bash 3 fixture skipped")
    def test_legacy_lane_does_not_start_adapter(self):
        result = self.run_wrapper(legacy=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.root / "audit.json").exists())
        self.assertEqual((self.root / "guard-count").read_text().strip(), "0")

    @unittest.skipUnless(BASH4, "coproc requires Bash >=4; Mac system Bash 3 fixture skipped")
    def test_owner_loss_86_is_not_converted_to_install_error(self):
        result = self.run_wrapper(lose_owner=True)
        self.assertEqual(result.returncode, 86, result.stderr)
        self.assertEqual(self.audit()["authorized_checks"], 0)

    @unittest.skipUnless(BASH4, "coproc requires Bash >=4; Mac system Bash 3 fixture skipped")
    def test_install_error_remains_79(self):
        result = self.run_wrapper(mode="install-error")
        self.assertEqual(result.returncode, 79, result.stderr)
        self.assertEqual(self.audit()["authorized_checks"], 2)

    @unittest.skipUnless(BASH4, "coproc requires Bash >=4; Mac system Bash 3 fixture skipped")
    def test_real_coproc_restore_maps_receipt_and_checks_each_write(self):
        result = self.run_wrapper(action="restore")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.audit()["action"], "restore")
        self.assertEqual(self.audit()["lookup_operation_id"], TRAIN)
        self.assertEqual(self.audit()["authorized_checks"], 2)
        self.assertEqual((self.root / "guard-count").read_text().strip(), "4")

    @unittest.skipUnless(BASH4, "coproc requires Bash >=4; Mac system Bash 3 fixture skipped")
    def test_legacy_cannot_select_snapshot_restore(self):
        result = self.run_wrapper(action="restore", legacy=True)
        self.assertEqual(result.returncode, 79, result.stderr)
        self.assertFalse((self.root / "audit.json").exists())

    @unittest.skipUnless(BASH4, "coproc requires Bash >=4; Mac system Bash 3 fixture skipped")
    def test_restore_owner_loss_is_86_without_resolving_snapshot(self):
        result = self.run_wrapper(action="restore", lose_owner=True)
        self.assertEqual(result.returncode, 86, result.stderr)
        self.assertFalse((self.root / "audit.json").exists())

    @unittest.skipUnless(BASH4, "coproc requires Bash >=4; Mac system Bash 3 fixture skipped")
    def test_real_coproc_new_publish_descriptor_restore_uses_current_owner(self):
        previous = "tr-previous-accepted"
        result = self.run_wrapper(descriptor={"schema": 1, "action": "restore",
                                               "snapshotOperationId": previous})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.audit()["operation_id"], previous)
        self.assertEqual((self.root / "guard-count").read_text().strip(), "4")
        log = (self.root / "wrapper.log").read_text()
        self.assertIn('"owner_operation_id":"' + TRAIN + '"', log)
        self.assertIn('"snapshot_operation_id":"' + previous + '"', log)
        self.assertIn("not OOM sampling acceptance", log)


class OriginalFinalizerTests(OwnerFixture):
    def run_finalizer(self, *, collector=True, hook_rc=0, watch_rc=0, watch_same=True,
                      owner=True, cc5_rc=0, lose_owner_after_cc5=False,
                      forward=False, reenter=False):
        candidate = self.candidate(collector)
        (self.root / "cc5.state").write_text("applied\n")
        (self.root / "policy.hold").write_text("held\n")
        env = self.environment()
        env.update(CANDIDATE=str(candidate), HOOK_RC=str(hook_rc), WATCH_RC=str(watch_rc),
                   WATCH_SAME="1" if watch_same else "0", OWNER="1" if owner else "0",
                   CC5_RC=str(cc5_rc), LOSE_OWNER_AFTER_CC5="1" if lose_owner_after_cc5 else "0")
        stubs = r'''
set -u
LEASE_TRAIN_ID=tr-owner-fixture-001
RELEASE_POLICY_GATES_PASSED=1
V5_ENV=/fixture/env
event() { printf '%s\n' "$*" >>"$FIXTURE_ROOT/finalizer.events"; }
release_policy_require_owner() { event owner; [[ "$OWNER" == 1 ]]; }
cutover_persist_phase() { event "persist:$1"; }
cutover_disarm_survivor() { event disarm; }
persist_selfhost_model_authority_cutover() { event "authority:$1"; }
sync_boot_scripts_from() { event "boot:$1"; }
cc5_activation_finalize() {
  event cc5:finalize
  [[ "$CC5_RC" == 0 ]] || return "$CC5_RC"
  local state
  IFS= read -r state <"$FIXTURE_ROOT/cc5.state"
  if [[ "$state" == committed ]]; then
    event cc5:already-committed
  else
    printf 'committed\n' >"$FIXTURE_ROOT/cc5.state"
    event cc5:committed
  fi
  [[ "$LOSE_OWNER_AFTER_CC5" == 0 ]] || OWNER=0
  return 0
}
sync_watch_from() { event "watch:$1"; return "$WATCH_RC"; }
watch_install_state() { event state; [[ "$WATCH_SAME" == 1 ]] && printf 'same\n' || printf 'different\n'; }
host_memory_sampler_finalize() { event "hook:$1"; return "$HOOK_RC"; }
release_policy_probe_stack() { event "probe:$1"; printf 'fixture-digest\n'; }
release_policy_history_status() { printf 'applied\n'; }
oc_hotcfg_fsync_path() { :; }
dirname() { printf '/fixture\n'; }
release_policy_py() {
  case "$1:$2" in
    field:history.path) printf '/fixture/history\n' ;;
    verify-resolution:target) event verify-resolution ;;
    resolve:forward) event resolve:forward; printf 'resolved\n' >"$FIXTURE_ROOT/policy.hold" ;;
    *) event FORBIDDEN-POLICY-ACTION; return 99 ;;
  esac
}
lease_train_finish() { event "finish:$1:$LEASE_TRAIN_ID"; }
clear_stay_maintenance() { :; }
oc_hotcfg_rotate_env_baks() { :; }
cutover_clog() { event "log:$*"; }
'''
        script = stubs + "\n" + function_body(LIB / "v5-selfhost-release-policy.sh", "release_policy_original_finalizer")
        action = "release_policy_original_finalizer"
        if forward:
            script += "\n" + function_body(LIB / "v5-selfhost-release-policy.sh", "release_policy_finalize_forward")
            action = "release_policy_finalize_forward"
        script += '\nif ' + action + ' "$CANDIDATE"; then rc=0; else rc=$?; fi\n'
        if reenter:
            script += r'''
[[ "$rc" == 79 ]] || exit 95
event "retry:$LEASE_TRAIN_ID"
HOOK_RC=0
if release_policy_finalize_forward "$CANDIDATE"; then rc=0; else rc=$?; fi
'''
        script += 'exit "$rc"\n'
        result = subprocess.run(["/bin/bash", "--noprofile", "--norc", "-c", script],
                                cwd=self.root, env=env, capture_output=True, text=True, timeout=10)
        events = (self.root / "finalizer.events").read_text().splitlines()
        return result, events, candidate

    def test_real_finalizer_calls_hook_only_after_watch_is_verified(self):
        result, events, candidate = self.run_finalizer()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events[-2:], ["state", "hook:" + str(candidate)])
        self.assertEqual(sum(item.startswith("hook:") for item in events), 1)
        self.assertIn("persist:committed", events)
        self.assertIn("disarm", events)
        self.assertLess(events.index("cc5:committed"), events.index("watch:" + str(candidate)))

    def test_cc5_failure_holds_before_watch_sampler_or_resolution(self):
        result, events, _ = self.run_finalizer(cc5_rc=79, forward=True)
        self.assertEqual(result.returncode, 79, result.stderr)
        self.assertEqual(events[-1], "cc5:finalize")
        self.assertFalse(any(item.startswith(("watch:", "hook:", "finish:", "resolve:")) for item in events))
        self.assertEqual((self.root / "cc5.state").read_text().strip(), "applied")
        self.assertEqual((self.root / "policy.hold").read_text().strip(), "held")

    def test_sampler_failure_preserves_committed_cc5_and_application_hold(self):
        result, events, candidate = self.run_finalizer(hook_rc=79, forward=True)
        self.assertEqual(result.returncode, 79, result.stderr)
        self.assertEqual(events[-1], "hook:" + str(candidate))
        self.assertEqual((self.root / "cc5.state").read_text().strip(), "committed")
        self.assertEqual((self.root / "policy.hold").read_text().strip(), "held")
        self.assertFalse(any(item.startswith(("finish:", "resolve:")) for item in events))

    def test_sampler_owner_loss_86_never_reaches_terminal_or_resolution_writes(self):
        result, events, candidate = self.run_finalizer(hook_rc=86, forward=True)
        self.assertEqual(result.returncode, 86, result.stderr)
        self.assertEqual(events[-1], "hook:" + str(candidate))
        self.assertEqual((self.root / "policy.hold").read_text().strip(), "held")
        self.assertFalse(any(item.startswith(("finish:", "resolve:")) for item in events))

    def test_owner_loss_after_cc5_stops_before_watch_and_sampler(self):
        result, events, _ = self.run_finalizer(lose_owner_after_cc5=True, forward=True)
        self.assertEqual(result.returncode, 86, result.stderr)
        self.assertEqual(events[-2:], ["cc5:committed", "owner"])
        self.assertEqual((self.root / "policy.hold").read_text().strip(), "held")
        self.assertFalse(any(item.startswith(("watch:", "hook:", "finish:", "resolve:")) for item in events))

    def test_same_operation_reentry_closes_cc5_once_then_resolves_after_sampler(self):
        result, events, candidate = self.run_finalizer(hook_rc=79, forward=True, reenter=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events.count("cc5:committed"), 1)
        self.assertEqual(events.count("cc5:already-committed"), 1)
        self.assertEqual(events.count("hook:" + str(candidate)), 2)
        retry = events.index("retry:" + TRAIN)
        self.assertFalse(any(item.startswith(("finish:", "resolve:")) for item in events[:retry]))
        self.assertEqual(events.count("finish:committed:" + TRAIN), 1)
        self.assertEqual(events.count("resolve:forward"), 1)
        self.assertLess(events.index("cc5:already-committed"), len(events) - 1 - events[::-1].index("hook:" + str(candidate)))
        self.assertEqual((self.root / "policy.hold").read_text().strip(), "resolved")

    def test_hook_79_and_owner_86_propagate_unchanged(self):
        for code in (79, 86):
            with self.subTest(code=code):
                temporary = tempfile.TemporaryDirectory(prefix="case-", dir=self.root)
                previous = self.root
                try:
                    self.root = Path(temporary.name)
                    result, events, _ = self.run_finalizer(hook_rc=code)
                    self.assertEqual(result.returncode, code, result.stderr)
                    self.assertEqual(sum(item.startswith("hook:") for item in events), 1)
                finally:
                    self.root = previous
                    temporary.cleanup()

    def test_watch_failure_or_mismatch_prevents_sampler_hook(self):
        for options in ({"watch_rc": 1}, {"watch_same": False}):
            with self.subTest(options=options):
                temporary = tempfile.TemporaryDirectory(prefix="case-", dir=self.root)
                previous = self.root
                try:
                    self.root = Path(temporary.name)
                    result, events, _ = self.run_finalizer(**options)
                    self.assertEqual(result.returncode, 79, result.stderr)
                    self.assertFalse(any(item.startswith("hook:") for item in events))
                finally:
                    self.root = previous
                    temporary.cleanup()

    def test_old_candidate_without_collector_keeps_original_finalization(self):
        result, events, _ = self.run_finalizer(collector=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events[-1], "state")
        self.assertFalse(any(item.startswith("hook:") for item in events))

    def test_initial_owner_failure_never_reaches_committed_or_hook(self):
        result, events, _ = self.run_finalizer(owner=False)
        self.assertEqual(result.returncode, 86, result.stderr)
        self.assertEqual(events, ["owner"])


class ExplicitRestorePolicyTests(OwnerFixture):
    def run_restore(self, *, context=True, archived=False, claim_rc=0, hook_rc=0,
                    probe_rc=0, owner=True):
        candidate = self.candidate()
        env = self.environment()
        env.update(CANDIDATE=str(candidate), CONTEXT="1" if context else "0",
                   ARCHIVED="true" if archived else "false", CLAIM_RC=str(claim_rc),
                   HOOK_RC=str(hook_rc), PROBE_RC=str(probe_rc), OWNER="1" if owner else "0")
        stubs = r'''
set -u
LEASE_TRAIN_ID=tr-owner-fixture-001
RELEASE_POLICY_RESUME_INFO=fixture
event() { printf '%s\n' "$*" >>"$FIXTURE_ROOT/restore.events"; }
release_policy_context_present() { event context; [[ "$CONTEXT" == 1 ]]; }
release_policy_resume_claim() { event claim; return "$CLAIM_RC"; }
jq() {
  case "$2" in .archived) printf '%s\n' "$ARCHIVED" ;; .rel) printf '%s\n' "$CANDIDATE" ;; *) return 1 ;; esac
}
train_field() { event train-field; printf '/fixture/train.log\n'; }
survivor_state_phase() { event phase-read; printf 'committed\n'; }
release_policy_probe_stack() { event "probe:$1"; return "$PROBE_RC"; }
release_policy_require_owner() { event owner; [[ "$OWNER" == 1 ]]; }
host_memory_sampler_restore() { event "restore:$1"; return "$HOOK_RC"; }
lease_train_finish() { event "finish:$1:$2"; }
cutover_clog() { event "log:$*"; }
release_policy_py() { event FORBIDDEN-RESOLVE; return 99; }
release_policy_recover_forward() { event FORBIDDEN-FORWARD; return 99; }
cutover_persist_phase() { event FORBIDDEN-APP-WRITE; return 99; }
release_policy_original_finalizer() { event FORBIDDEN-FINALIZER; return 99; }
cc5_activation_finalize() { event FORBIDDEN-CC5-FINALIZE; return 99; }
'''
        script = stubs + "\n" + function_body(LIB / "v5-selfhost-release-policy.sh", "release_policy_recover_host_memory")
        script += '\nif release_policy_recover_host_memory; then rc=0; else rc=$?; fi\nexit "$rc"\n'
        result = subprocess.run(["/bin/bash", "--noprofile", "--norc", "-c", script],
                                env=env, cwd=self.root, capture_output=True, text=True, timeout=10)
        events = (self.root / "restore.events").read_text().splitlines()
        self.assertFalse(any("FORBIDDEN" in item for item in events))
        return result, events, candidate

    def test_actual_policy_restore_keeps_hold_and_never_accepts_application(self):
        result, events, candidate = self.run_restore()
        self.assertEqual(result.returncode, 79, result.stderr)
        self.assertEqual(events[0:2], ["context", "claim"])
        self.assertIn("restore:" + str(candidate), events)
        terminal = next(item for item in events if item.startswith("finish:"))
        self.assertTrue(terminal.startswith("finish:failed:"))
        self.assertIn("application not reaccepted", terminal)
        self.assertIn("hold retained", terminal)
        self.assertEqual(events.count("context"), 2)
        self.assertTrue(any("existing intent/phase unchanged" in item for item in events))

    def test_absent_barrier_or_archived_operation_cannot_restore(self):
        for options in ({"context": False}, {"archived": True}):
            with self.subTest(options=options):
                temporary = tempfile.TemporaryDirectory(prefix="case-", dir=self.root)
                previous = self.root
                try:
                    self.root = Path(temporary.name)
                    result, events, _ = self.run_restore(**options)
                    self.assertEqual(result.returncode, 79, result.stderr)
                    self.assertFalse(any(item.startswith(("restore:", "finish:")) for item in events))
                    if not options.get("context", True):
                        self.assertNotIn("claim", events)
                finally:
                    self.root = previous
                    temporary.cleanup()

    def test_claim_probe_hook_and_owner_fail_closed_without_terminal_acceptance(self):
        for options, code in (({"claim_rc": 86}, 86), ({"probe_rc": 79}, 79),
                              ({"hook_rc": 79}, 79), ({"hook_rc": 86}, 86),
                              ({"owner": False}, 86)):
            with self.subTest(options=options):
                temporary = tempfile.TemporaryDirectory(prefix="case-", dir=self.root)
                previous = self.root
                try:
                    self.root = Path(temporary.name)
                    result, events, _ = self.run_restore(**options)
                    self.assertEqual(result.returncode, code, result.stderr)
                    self.assertFalse(any(item.startswith("finish:") for item in events))
                finally:
                    self.root = previous
                    temporary.cleanup()


class RestoreCLISelectionTests(OwnerFixture):
    def parse_cli(self, *args):
        source = (PROJECT / "scripts/deploy-v5-selfhost.sh").read_text()
        start = source.index('for arg in "$@"; do\n')
        end = source.index('[[ "$FORCE_ENV"', start)
        prelude = r'''
set -u
MODE=""; DRY=0; FORCE_ENV=0; ALLOW_INFLIGHT=0; ALLOW_DIRTY=0
PLATFORM_FROM_HEAD=0; FORCE_NPM_CI=0; CUTOVER_RELEASE=""
RELEASE_POLICY_RESUME=0; RELEASE_POLICY_SAMPLER_RESTORE=0
LEASE_TRAIN_ID=""; LEASE_TARGET_SHA=""
usage() { :; }
die() { printf '%s\n' "$*" >&2; exit 2; }
'''
        script = prelude + source[start:end] + '\nprintf "%s|%s|%s\\n" "$MODE" "$RELEASE_POLICY_RESUME" "$RELEASE_POLICY_SAMPLER_RESTORE"\n'
        return subprocess.run(["/bin/bash", "--noprofile", "--norc", "-c", script, "cli-fixture", *args],
                              env=self.environment(), cwd=self.root, capture_output=True, text=True, timeout=10)

    def test_real_parser_selects_only_explicit_same_operation_restore(self):
        result = self.parse_cli("--deploy", "--resume-release-policy", "--restore-host-memory",
                                "--lease-train=" + TRAIN, "--target-sha=" + "a" * 40)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "deploy|1|1")
        ordinary = self.parse_cli("--deploy")
        self.assertEqual(ordinary.returncode, 0, ordinary.stderr)
        self.assertEqual(ordinary.stdout.strip(), "deploy|0|0")

    def test_real_parser_rejects_missing_resume_identity_dry_run_or_arbitrary_snapshot(self):
        identity = ("--lease-train=" + TRAIN, "--target-sha=" + "a" * 40)
        cases = (("--deploy", "--restore-host-memory"),
                 ("--deploy", "--resume-release-policy", "--restore-host-memory"),
                 ("--status", "--resume-release-policy", "--restore-host-memory", *identity),
                 ("--deploy", "--resume-release-policy", "--restore-host-memory", "--dry-run", *identity),
                 ("--deploy", "--resume-release-policy", "--restore-host-memory=/tmp/snapshot", *identity))
        for args in cases:
            with self.subTest(args=args):
                self.assertEqual(self.parse_cli(*args).returncode, 2)

    def test_real_deploy_dispatch_does_not_forward_after_restore(self):
        source = PROJECT / "scripts/deploy-v5-selfhost.sh"
        stubs = r'''
set -u
RELEASE_POLICY_RESUME=1
RELEASE_POLICY_SAMPLER_RESTORE=1
release_policy_recover_host_memory() { printf 'RESTORE\n'; return 79; }
release_policy_recover_forward() { printf 'FORBIDDEN-FORWARD\n'; return 0; }
cc5_activation_finalize() { printf 'FORBIDDEN-CC5-FINALIZE\n'; return 99; }
log() { printf 'FORBIDDEN-SUCCESS:%s\n' "$*"; }
'''
        script = stubs + function_body(source, "cmd_deploy") + "\ncmd_deploy\n"
        result = subprocess.run(["/bin/bash", "--noprofile", "--norc", "-c", script],
                                env=self.environment(), cwd=self.root, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 79, result.stderr)
        self.assertEqual(result.stdout.strip(), "RESTORE")

    def test_restore_acquires_original_lock_without_artifact_or_application_writes(self):
        stubs = r'''
set -u
MODE=deploy; DRY=0; PLATFORM_FROM_HEAD=0
RELEASE_POLICY_RESUME=1; RELEASE_POLICY_SAMPLER_RESTORE=1
acquire_selfhost_deploy_lock() { printf 'ORIGINAL-LOCK\n'; }
prewarm_quiesce() { printf 'FORBIDDEN-STOP-ARTIFACT\n'; }
selfhost_prepare_lock() { printf 'FORBIDDEN-APP-PREPARE\n'; }
'''
        script = stubs + function_body(PROJECT / "scripts/deploy-v5-selfhost.sh", "maybe_acquire_selfhost_deploy_lock")
        script += "\nmaybe_acquire_selfhost_deploy_lock\n"
        result = subprocess.run(["/bin/bash", "--noprofile", "--norc", "-c", script],
                                env=self.environment(), cwd=self.root, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "ORIGINAL-LOCK")

    def test_restore_exit_cleanup_does_not_resolve_or_restore_application(self):
        stubs = r'''
set -u
MODE=deploy
RELEASE_POLICY_SAMPLER_RESTORE=1
event() { printf '%s\n' "$*"; }
reap_master_build_jobs() { :; }
tsum_finish() { :; }
release_policy_enabled() { return 0; }
release_policy_require_owner() { return 0; }
release_policy_abort_unexposed() { event FORBIDDEN-RESOLVE; }
rollback_restore_prev_if_unchanged() { event FORBIDDEN-APP-ROLLBACK; }
master_gate_load_budget_stop() { :; }
cleanup_master_staging() { :; }
cleanup_cutover_unit_snap() { :; }
status79() { return 79; }
'''
        script = stubs + function_body(PROJECT / "scripts/deploy-v5-selfhost.sh", "cleanup_selfhost_deploy")
        script += "\nstatus79\ncleanup_selfhost_deploy\n"
        result = subprocess.run(["/bin/bash", "--noprofile", "--norc", "-c", script],
                                env=self.environment(), cwd=self.root, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("FORBIDDEN", result.stdout)


if __name__ == "__main__":
    unittest.main()
