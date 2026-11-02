#!/usr/bin/env python3
"""Isolated installer behavior tests: never invoke systemctl or access host paths."""

import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "lib/v5-selfhost-host-memory-install.py"
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("host_memory_install", SCRIPT)
install = importlib.util.module_from_spec(spec)
spec.loader.exec_module(install)
WORKSPACE = Path(__file__).resolve().parents[2]

UNIT_TEXT = """[Unit]
Description=Selfhost host memory sampler
[Service]
Type=simple
User=root
ExecStart=/usr/bin/python3 -I -B /opt/openclaude/v5-selfhost-breakglass/host-memory/sampler.py
NoNewPrivileges=yes
[Install]
WantedBy=multi-user.target
"""
OLD_PROGRAM = b"print('previous sampler')\n"
OLD_UNIT = (UNIT_TEXT + "# previous template\n").encode()


class FakeSystemctl:
    def __init__(self, root):
        self.root = root
        self.active = "inactive"
        self.enabled = False
        self.job = ""
        self.calls = []
        self.fail_restart_once = False
        self.timeout_restart = False
        self.before_mutate = None
        self.effective_dropins = ""
        self.effective_fragment = None
        self.dependencies = {}

    def __call__(self, argv):
        self.calls.append(list(argv))
        action = argv[0]
        if action == "show":
            exists = (self.root / install.UNIT_FILE.relative_to("/")).exists()
            output = "\n".join([
                "LoadState=" + ("loaded" if exists else "not-found"),
                "ActiveState=" + self.active,
                "UnitFileState=" + ("enabled" if self.enabled else "disabled") if exists else "UnitFileState=",
                "Job=" + self.job,
                "FragmentPath=" + (self.effective_fragment if self.effective_fragment is not None
                                    else str(install.UNIT_FILE) if exists else ""),
                "DropInPaths=" + self.effective_dropins,
                *(key + "=" + self.dependencies.get(key, "") for key in install.DEPENDENCY_PROPERTIES),
            ])
            return subprocess.CompletedProcess(argv, 0, output, "")
        if self.before_mutate:
            self.before_mutate(argv)
        if action == "restart" and self.timeout_restart:
            self.job = "42/start"
            raise subprocess.TimeoutExpired(argv, 30)
        if action == "restart" and self.fail_restart_once:
            self.fail_restart_once = False
            self.active = "failed"
            return subprocess.CompletedProcess(argv, 1, "", "private output must not be printed")
        if action == "stop":
            self.active = "inactive"
        elif action == "disable":
            self.enabled = False
        elif action == "enable":
            self.enabled = True
        elif action in ("start", "restart"):
            self.active = "active"
        elif action != "daemon-reload":
            raise AssertionError("Unexpected mutation: " + action)
        return subprocess.CompletedProcess(argv, 0, "", "")

    def mutations(self):
        return [call for call in self.calls if call[0] != "show"]


class InstallerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix=".host-memory-install-fixture-", dir=WORKSPACE)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.runner = FakeSystemctl(self.root)
        self.installer = install.Installer(self.root, self.runner)
        self.release = self.installer.path(install.RELEASES) / "rel-fixture"
        self.release.mkdir(parents=True)
        self.program_source = self.release / install.SOURCE_PROGRAM
        self.unit_source = self.release / install.SOURCE_UNIT
        self.program_source.parent.mkdir(parents=True)
        self.unit_source.parent.mkdir(parents=True)
        self.program_source.write_text("print('sampler fixture')\n")
        self.unit_source.write_text(UNIT_TEXT)
        self.installer.path(install.LIVE).symlink_to(self.release)
        self.installer.path(install.UNIT_FILE.parent).mkdir(parents=True)
        self.installer.path(install.PROGRAM.parent.parent).mkdir(parents=True)
        self.program = self.installer.path(install.PROGRAM)
        self.unit = self.installer.path(install.UNIT_FILE)
        self.checks = 0
        self.operation = "tr-fixture-001"

    def apply(self, **kwargs):
        return self.installer.apply(operation_id=self.operation, **kwargs)

    def owner(self):
        self.checks += 1

    def existing(self, *, enabled=True, active=True):
        self.program.parent.mkdir(mode=0o700)
        self.program.write_bytes(OLD_PROGRAM)
        self.program.chmod(0o750)
        self.unit.write_bytes(OLD_UNIT)
        self.unit.chmod(0o640)
        self.runner.enabled = enabled
        self.runner.active = "active" if active else "inactive"

    def test_plan_and_default_cli_are_read_only(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            rc = install.main([], installer=self.installer)
        self.assertEqual(rc, 0)
        self.assertTrue(json.loads(output.getvalue())["dry_run"])
        self.assertFalse(self.program.exists())
        self.assertFalse(self.unit.exists())
        self.assertFalse(self.installer.path(install.STATE_ROOT).exists())
        self.assertEqual(self.runner.mutations(), [])

    def test_apply_requires_real_owner_callback_not_just_apply_flag(self):
        with self.assertRaises(install.OwnershipRequired):
            self.apply()
        with self.assertRaises(install.OwnershipRequired):
            self.apply(owner_check=lambda: False)
        with self.assertRaises(install.OwnershipRequired):
            install.main(["--apply"], installer=self.installer)
        self.assertEqual(self.runner.mutations(), [])
        self.assertFalse(self.installer.path(install.STATE_ROOT).exists())

    def test_only_current_selfhost_release_is_accepted(self):
        other = self.release.parent / "rel-other"
        other.mkdir()
        with self.assertRaises(install.InstallError):
            self.installer.plan(other)
        self.assertEqual(self.runner.calls, [])

    def test_source_symlink_and_invalid_python_are_refused_without_execution(self):
        self.program_source.unlink()
        outside = self.root / "outside.py"
        outside.write_text("raise SystemExit('must never run')\n")
        self.program_source.symlink_to(outside)
        with self.assertRaises(install.InstallError):
            self.installer.plan()
        self.program_source.unlink()
        self.program_source.write_text("not valid python !\n")
        with self.assertRaises(install.InstallError):
            self.installer.plan()
        self.assertEqual(self.runner.calls, [])

    def test_unexpected_unit_hook_is_refused(self):
        self.unit_source.write_text(UNIT_TEXT.replace("Type=simple", "Type=simple\nExecStartPre=/bin/true"))
        with self.assertRaises(install.InstallError):
            self.installer.plan()
        self.assertEqual(self.runner.calls, [])

    def test_enable_cannot_pull_in_other_units_or_aliases(self):
        for setting in ("Also=unrelated.service", "Alias=unrelated.service"):
            self.unit_source.write_text(UNIT_TEXT + setting + "\n")
            with self.assertRaises(install.InstallError):
                self.apply(owner_check=self.owner)
        self.unit_source.write_text(UNIT_TEXT.replace("[Service]", "Wants=unrelated.service\n[Service]"))
        with self.assertRaises(install.InstallError):
            self.apply(owner_check=self.owner)
        self.assertEqual(self.runner.calls, [])

    def test_target_symlink_does_not_modify_victim(self):
        self.program.parent.mkdir(mode=0o700)
        victim = self.root / "victim"
        victim.write_text("untouched")
        self.program.symlink_to(victim)
        with self.assertRaises(install.InstallError):
            self.apply(owner_check=self.owner)
        self.assertEqual(victim.read_text(), "untouched")
        self.assertEqual(self.runner.mutations(), [])

    def test_nonempty_dropin_refused(self):
        dropin = self.installer.path(Path(str(install.UNIT_FILE) + ".d"))
        dropin.mkdir()
        (dropin / "local.conf").write_text("[Service]\nMemoryMax=1G\n")
        with self.assertRaises(install.InstallError):
            self.apply(owner_check=self.owner)
        self.assertEqual(self.runner.mutations(), [])

    def test_snapshot_precedes_mutations_and_new_install_rollback_preserves_logs(self):
        log = self.root / "var/log/openclaude-v5-selfhost/host-memory/keep.jsonl"
        log.parent.mkdir(parents=True)
        log.write_text("keep evidence\n")
        observed = []
        def verify_snapshot(argv):
            snapshots = [p for p in self.installer.path(install.STATE_ROOT).iterdir() if p.is_dir()]
            self.assertEqual(len(snapshots), 1)
            manifest = json.loads((snapshots[0] / "manifest.json").read_text())
            self.assertEqual(manifest["status"], "prepared")
            self.assertFalse(manifest["previous_files"]["program"]["exists"])
            observed.append(argv[0])
        self.runner.before_mutate = verify_snapshot
        result = self.apply(owner_check=self.owner)
        self.runner.before_mutate = None
        snapshot = Path(result["snapshot"])
        self.assertEqual(stat.S_IMODE(snapshot.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((snapshot / "manifest.json").stat().st_mode), 0o600)
        self.assertEqual(self.program.read_bytes(), self.program_source.read_bytes())
        self.assertEqual(stat.S_IMODE(self.program.stat().st_mode), 0o755)
        self.assertEqual(stat.S_IMODE(self.unit.stat().st_mode), 0o644)
        self.assertEqual(observed, ["daemon-reload", "enable", "restart"])
        restored = self.installer.rollback(snapshot, owner_check=self.owner)
        self.assertTrue(restored["restored"])
        self.assertFalse(self.program.exists())
        self.assertFalse(self.unit.exists())
        self.assertFalse(self.runner.enabled)
        self.assertEqual(self.runner.active, "inactive")
        self.assertEqual(log.read_text(), "keep evidence\n")

    def test_existing_files_modes_and_active_enabled_state_are_restored(self):
        self.existing(enabled=False, active=True)
        result = self.apply(owner_check=self.owner)
        self.installer.rollback(Path(result["snapshot"]), owner_check=self.owner)
        self.assertEqual(self.program.read_bytes(), OLD_PROGRAM)
        self.assertEqual(self.unit.read_bytes(), OLD_UNIT)
        self.assertEqual(stat.S_IMODE(self.program.stat().st_mode), 0o750)
        self.assertEqual(stat.S_IMODE(self.unit.stat().st_mode), 0o640)
        self.assertFalse(self.runner.enabled)
        self.assertEqual(self.runner.active, "active")

    def test_synchronous_service_failure_checks_then_restores_old_state(self):
        self.existing()
        self.runner.fail_restart_once = True
        with self.assertRaisesRegex(install.InstallError, "previous files/state restored"):
            self.apply(owner_check=self.owner)
        self.assertEqual(self.program.read_bytes(), OLD_PROGRAM)
        self.assertEqual(self.unit.read_bytes(), OLD_UNIT)
        self.assertTrue(self.runner.enabled)
        self.assertEqual(self.runner.active, "active")
        actions = [call[0] for call in self.runner.calls]
        failed = actions.index("restart")
        self.assertEqual(actions[failed + 1], "show")
        self.assertEqual(actions.count("restart"), 1)
        self.assertIn("start", actions[failed + 1:])

    def test_timeout_with_pending_job_does_not_retry_or_compete(self):
        self.runner.timeout_restart = True
        with self.assertRaises(install.RecoveryRequired) as caught:
            self.apply(owner_check=self.owner)
        self.assertTrue(caught.exception.snapshot.is_dir())
        self.assertEqual([c[0] for c in self.runner.mutations()], ["daemon-reload", "enable", "restart"])
        restart = next(i for i,c in enumerate(self.runner.calls) if c[0] == "restart")
        self.assertTrue(all(c[0] == "show" for c in self.runner.calls[restart + 1:]))

    def test_snapshot_integrity_and_external_target_changes_block_rollback(self):
        self.existing()
        result = self.apply(owner_check=self.owner)
        snapshot = Path(result["snapshot"])
        self.program.write_text("other owner's edit\n")
        before = len(self.runner.mutations())
        with self.assertRaises(install.RecoveryRequired):
            self.installer.rollback(snapshot, owner_check=self.owner)
        self.assertEqual(self.program.read_text(), "other owner's edit\n")
        self.assertEqual(len(self.runner.mutations()), before)
        self.program.write_bytes(self.program_source.read_bytes())
        (snapshot / "program.previous").write_bytes(b"corrupt")
        with self.assertRaises(install.InstallError):
            self.installer.rollback(snapshot, owner_check=self.owner)
        self.assertEqual(len(self.runner.mutations()), before)

    def test_ownership_loss_stops_more_mutations(self):
        self.existing()
        allowed = [True]
        def owner():
            if not allowed[0]:
                raise install.OwnershipRequired("Owner lost")
        def lose_owner(argv):
            allowed[0] = False
        self.runner.before_mutate = lose_owner
        with self.assertRaises(install.OwnershipRequired):
            self.apply(owner_check=owner)
        self.assertEqual([c[0] for c in self.runner.mutations()], ["daemon-reload"])

    def test_state_changed_before_first_target_write_is_not_rolled_back(self):
        self.existing(enabled=False, active=False)
        original = self.runner.__call__
        reads = [0]
        def race(argv):
            if argv[0] == "show":
                reads[0] += 1
                if reads[0] == 2:
                    self.runner.active = "active"
            return original(argv)
        self.installer.runner = race
        with self.assertRaisesRegex(install.InstallError, "before target changes"):
            self.apply(owner_check=self.owner)
        self.assertEqual(self.runner.active, "active")
        self.assertFalse(self.runner.enabled)
        self.assertEqual(self.runner.mutations(), [])
        self.assertEqual(self.program.read_bytes(), OLD_PROGRAM)
        self.assertEqual(self.unit.read_bytes(), OLD_UNIT)

    def test_already_matching_active_enabled_install_has_no_writes(self):
        first = self.apply(owner_check=self.owner)
        before = list(self.installer.path(install.STATE_ROOT).iterdir())
        self.runner.calls.clear()
        result = self.apply(owner_check=self.owner)
        self.assertFalse(result["changed"])
        self.assertEqual(result["snapshot"], first["snapshot"])
        self.assertTrue(result["reused_snapshot"])
        self.assertEqual(list(self.installer.path(install.STATE_ROOT).iterdir()), before)
        self.assertEqual(self.runner.mutations(), [])

    def test_partial_reentry_cannot_replace_original_snapshot(self):
        self.existing()
        allowed = [True]
        def owner():
            if not allowed[0]:
                raise install.OwnershipRequired("Owner lost")
        self.runner.before_mutate = lambda argv: allowed.__setitem__(0, False)
        with self.assertRaises(install.OwnershipRequired):
            self.apply(owner_check=owner)
        _, receipt = self.installer._load_receipt(self.operation)
        snapshot = self.installer.path(install.STATE_ROOT) / receipt["snapshot"]
        self.assertEqual((snapshot / "program.previous").read_bytes(), OLD_PROGRAM)
        self.assertEqual((snapshot / "unit.previous").read_bytes(), OLD_UNIT)
        _, receipt = self.installer._load_receipt(self.operation)
        self.assertEqual(receipt["status"], "applying")
        self.assertEqual(receipt["snapshot"], snapshot.name)
        self.runner.before_mutate = None
        self.runner.calls.clear()
        with self.assertRaises(install.RecoveryRequired):
            self.apply(owner_check=self.owner)
        self.assertEqual(self.runner.mutations(), [])
        self.assertEqual([p for p in snapshot.parent.iterdir() if p.is_dir()], [snapshot])
        self.assertEqual((snapshot / "program.previous").read_bytes(), OLD_PROGRAM)

    def test_restored_operation_retry_reuses_first_snapshot(self):
        self.existing()
        self.runner.fail_restart_once = True
        with self.assertRaisesRegex(install.InstallError, "previous files/state restored"):
            self.apply(owner_check=self.owner)
        path, receipt = self.installer._load_receipt(self.operation)
        snapshot = path.parent / receipt["snapshot"]
        self.assertEqual(receipt["status"], "restored")
        self.assertEqual((snapshot / "program.previous").read_bytes(), OLD_PROGRAM)
        result = self.apply(owner_check=self.owner)
        self.assertTrue(result["reused_snapshot"])
        self.assertEqual(result["snapshot"], str(snapshot))
        self.assertEqual([p for p in path.parent.iterdir() if p.is_dir()], [snapshot])
        self.installer.rollback(snapshot, operation_id=self.operation, owner_check=self.owner)
        self.assertEqual(self.program.read_bytes(), OLD_PROGRAM)
        self.assertEqual(self.unit.read_bytes(), OLD_UNIT)
        self.runner.calls.clear()
        # Already-restored rollback is itself non-disruptive.
        self.installer.rollback(snapshot, operation_id=self.operation, owner_check=self.owner)
        self.assertEqual(self.runner.mutations(), [])

    def test_operation_source_drift_pending_job_and_foreign_state_refuse_reentry(self):
        result = self.apply(owner_check=self.owner)
        snapshot = Path(result["snapshot"])
        source = self.program_source.read_bytes()
        self.program_source.write_text("print('changed source')\n")
        self.runner.calls.clear()
        with self.assertRaisesRegex(install.InstallError, "Operation source changed"):
            self.apply(owner_check=self.owner)
        self.assertEqual(self.runner.mutations(), [])
        self.program_source.write_bytes(source)
        self.runner.job = "42/start"
        with self.assertRaisesRegex(install.InstallError, "pending job"):
            self.apply(owner_check=self.owner)
        self.runner.job = ""
        self.runner.enabled = False  # An external state change is not silently repaired.
        with self.assertRaises(install.RecoveryRequired):
            self.apply(owner_check=self.owner)
        self.assertFalse(self.runner.enabled)
        self.assertEqual(self.runner.mutations(), [])
        self.assertEqual([p for p in snapshot.parent.iterdir() if p.is_dir()], [snapshot])

    def test_owner_loss_during_snapshot_never_becomes_preparation_error(self):
        self.existing()
        allowed = [True]
        original = self.installer._write
        def owner():
            if not allowed[0]:
                raise install.OwnershipRequired("Owner lost")
        def lose_before_manifest(path, blob, mode, owner_check):
            if path.name == "manifest.json":
                allowed[0] = False
            return original(path, blob, mode, owner_check)
        self.installer._write = lose_before_manifest
        with self.assertRaises(install.OwnershipRequired):
            self.apply(owner_check=owner)
        self.assertEqual(self.program.read_bytes(), OLD_PROGRAM)
        self.assertEqual(self.unit.read_bytes(), OLD_UNIT)
        self.assertEqual(self.runner.mutations(), [])
        self.assertIsNone(self.installer._load_receipt(self.operation)[1])

    def test_owner_loss_after_prepared_receipt_does_not_rewrite_state(self):
        self.existing()
        allowed = [True]
        original = self.installer._receipt
        before_loss = {}
        def owner():
            if not allowed[0]:
                raise install.OwnershipRequired("Owner lost")
        def lose_after_prepared(path, receipt, owner_check, **kwargs):
            original(path, receipt, owner_check, **kwargs)
            if kwargs.get("new"):
                before_loss["receipt"] = path.read_bytes()
                snapshot = path.parent / receipt["snapshot"]
                before_loss["manifest"] = (snapshot / "manifest.json").read_bytes()
                allowed[0] = False
        self.installer._receipt = lose_after_prepared
        with self.assertRaises(install.OwnershipRequired):
            self.apply(owner_check=owner)
        path, receipt = self.installer._load_receipt(self.operation)
        self.assertEqual(path.read_bytes(), before_loss["receipt"])
        self.assertEqual((path.parent / receipt["snapshot"] / "manifest.json").read_bytes(), before_loss["manifest"])
        self.assertEqual(receipt["status"], "prepared")
        self.assertEqual(self.program.read_bytes(), OLD_PROGRAM)
        self.assertEqual(self.unit.read_bytes(), OLD_UNIT)
        self.assertEqual(self.runner.mutations(), [])

    def test_owner_loss_after_program_write_does_not_rollback_or_write_unit(self):
        self.existing()
        allowed = [True]
        original = self.installer._write
        saved = {}
        def owner():
            if not allowed[0]:
                raise install.OwnershipRequired("Owner lost")
        def lose_after_program(path, blob, mode, owner_check):
            original(path, blob, mode, owner_check)
            if path == self.program:
                allowed[0] = False
                rp, receipt = self.installer._load_receipt(self.operation)
                saved["receipt"] = rp.read_bytes()
                saved["manifest"] = (rp.parent / receipt["snapshot"] / "manifest.json").read_bytes()
        self.installer._write = lose_after_program
        with self.assertRaises(install.OwnershipRequired):
            self.apply(owner_check=owner)
        rp, receipt = self.installer._load_receipt(self.operation)
        self.assertEqual(rp.read_bytes(), saved["receipt"])
        self.assertEqual((rp.parent / receipt["snapshot"] / "manifest.json").read_bytes(), saved["manifest"])
        self.assertEqual(self.program.read_bytes(), self.program_source.read_bytes())
        self.assertEqual(self.unit.read_bytes(), OLD_UNIT)
        self.assertEqual(self.runner.mutations(), [])

    def test_owner_loss_after_failed_operation_state_query_propagates(self):
        self.existing()
        self.runner.fail_restart_once = True
        allowed = [True]
        original = self.runner.__call__
        def owner():
            if not allowed[0]:
                raise install.OwnershipRequired("Owner lost")
        def lose_after_query(argv):
            result = original(argv)
            if argv[0] == "show" and self.runner.active == "failed":
                allowed[0] = False
            return result
        self.installer.runner = lose_after_query
        with self.assertRaises(install.OwnershipRequired):
            self.apply(owner_check=owner)
        self.assertEqual([c[0] for c in self.runner.mutations()], ["daemon-reload", "enable", "restart"])
        self.assertEqual(self.program.read_bytes(), self.program_source.read_bytes())
        self.assertEqual(self.installer._load_receipt(self.operation)[1]["status"], "applying")

    def test_explicit_interrupted_rollback_requires_stable_owned_files(self):
        self.existing()
        original = self.installer._write
        allowed = [True]
        def owner():
            if not allowed[0]:
                raise install.OwnershipRequired("Owner lost")
        def interrupt(path, blob, mode, owner_check):
            original(path, blob, mode, owner_check)
            if path == self.program:
                allowed[0] = False
        self.installer._write = interrupt
        with self.assertRaises(install.OwnershipRequired):
            self.apply(owner_check=owner)
        self.installer._write = original
        rp, receipt = self.installer._load_receipt(self.operation)
        snapshot = rp.parent / receipt["snapshot"]
        self.runner.job = "42/start"
        with self.assertRaisesRegex(install.InstallError, "pending job"):
            self.installer.rollback(snapshot, owner_check=self.owner)
        self.runner.job = ""
        self.program.chmod(0o750)  # Right hash with foreign mode is not owned.
        with self.assertRaises(install.RecoveryRequired):
            self.installer.rollback(snapshot, owner_check=self.owner)
        self.program.chmod(0o755)
        restored = self.installer.rollback(snapshot, owner_check=self.owner)
        self.assertTrue(restored["restored"])
        self.assertEqual(self.program.read_bytes(), OLD_PROGRAM)
        self.assertEqual(self.unit.read_bytes(), OLD_UNIT)
        self.assertEqual(self.installer._load_receipt(self.operation)[1]["snapshot"], snapshot.name)
        self.assertEqual(self.installer._load_receipt(self.operation)[1]["status"], "restored")

    def test_interrupted_rollback_can_itself_be_resumed_with_fresh_owner(self):
        self.existing()
        applied = self.apply(owner_check=self.owner)
        snapshot = Path(applied["snapshot"])
        allowed = [True]
        original = self.installer._write
        def owner():
            if not allowed[0]:
                raise install.OwnershipRequired("Owner lost")
        def interrupt(path, blob, mode, owner_check):
            original(path, blob, mode, owner_check)
            if path == self.program:
                allowed[0] = False
        self.installer._write = interrupt
        with self.assertRaises(install.OwnershipRequired):
            self.installer.rollback(snapshot, owner_check=owner)
        self.assertEqual(self.installer._load_receipt(self.operation)[1]["status"], "restoring")
        self.assertEqual(self.program.read_bytes(), OLD_PROGRAM)
        self.assertEqual(self.unit.read_bytes(), self.unit_source.read_bytes())
        self.installer._write = original
        restored = self.installer.rollback(snapshot, owner_check=self.owner)
        self.assertTrue(restored["restored"])
        self.assertEqual(self.unit.read_bytes(), OLD_UNIT)
        self.assertEqual(self.runner.active, "active")
        self.assertTrue(self.runner.enabled)

    def test_final_file_drift_is_not_accepted_or_automatically_overwritten(self):
        for key in ("program", "unit"):
            with self.subTest(key=key):
                self.operation = "tr-drift-" + key
                # Each iteration is a separate operation; restore the previous
                # fixture's exact approved files before preparing another.
                if self.program.exists():
                    self.program.write_bytes(self.program_source.read_bytes())
                    self.program.chmod(0o755)
                    self.unit.write_bytes(self.unit_source.read_bytes())
                    self.unit.chmod(0o644)
                self.runner.active = "inactive"
                self.runner.enabled = False
                def change_target(argv):
                    if argv[0] == "restart":
                        (self.program if key == "program" else self.unit).chmod(0o700)
                self.runner.before_mutate = change_target
                before = len(self.runner.mutations())
                with self.assertRaises(install.RecoveryRequired):
                    self.apply(owner_check=self.owner)
                receipt = self.installer._load_receipt(self.operation)[1]
                self.assertEqual(receipt["status"], "applying")
                self.assertEqual([c[0] for c in self.runner.mutations()[before:]], ["daemon-reload", "enable", "restart"])
                self.assertEqual(stat.S_IMODE((self.program if key == "program" else self.unit).stat().st_mode), 0o700)

    def test_runtime_global_and_prefix_dropins_are_refused_before_mutation(self):
        for base, name in (("/run/systemd/system", install.UNIT),
                           ("/usr/lib/systemd/system", "service"),
                           ("/etc/systemd/system", "openclaude-v5-.service")):
            with self.subTest(base=base, name=name):
                dropin = self.installer.path(Path(base) / (name + ".d"))
                dropin.mkdir(parents=True)
                hook = dropin / "override.conf"
                hook.write_text("[Service]\nExecStartPre=/bin/false\n")
                with self.assertRaisesRegex(install.InstallError, "drop-ins"):
                    self.installer.plan()
                hook.unlink()
        self.assertEqual(self.runner.mutations(), [])

    def test_effective_configuration_reload_gate_prevents_activation(self):
        for kind, value in (("dropin", "/run/generated/override.conf"),
                            ("fragment", "/run/generated/foreign.service"),
                            ("dependency", "unrelated.service")):
            with self.subTest(kind=kind):
                self.operation = "tr-effective-" + kind
                self.runner.active = "inactive"
                self.runner.enabled = False
                self.runner.effective_dropins = ""
                self.runner.effective_fragment = None
                self.runner.dependencies = {}
                def foreign_configuration(argv):
                    if argv[0] == "daemon-reload":
                        if kind == "dropin":
                            self.runner.effective_dropins = value
                        elif kind == "fragment":
                            self.runner.effective_fragment = value
                        else:
                            self.runner.dependencies["Wants"] = value
                self.runner.before_mutate = foreign_configuration
                before = len(self.runner.mutations())
                with self.assertRaises(install.RecoveryRequired):
                    self.apply(owner_check=self.owner)
                self.assertEqual([c[0] for c in self.runner.mutations()[before:]], ["daemon-reload"])
                self.assertEqual(self.installer._load_receipt(self.operation)[1]["status"], "applying")

    def test_snapshot_for_operation_is_read_only_and_checks_original_identity(self):
        self.existing()
        applied = self.apply(owner_check=self.owner)
        snapshot = Path(applied["snapshot"])
        rp, receipt = self.installer._load_receipt(self.operation)
        original_receipt = rp.read_bytes()
        original_manifest = (snapshot / "manifest.json").read_bytes()
        self.runner.calls.clear()
        self.assertEqual(self.installer.snapshot_for_operation(self.operation), snapshot)
        self.assertEqual(self.runner.calls, [])
        self.assertEqual(rp.read_bytes(), original_receipt)
        self.assertEqual((snapshot / "manifest.json").read_bytes(), original_manifest)
        with self.assertRaisesRegex(install.InstallError, "receipt is absent"):
            self.installer.snapshot_for_operation("tr-nonexistent")
        with self.assertRaises(install.InstallError):
            self.installer.snapshot_for_operation("../caller-chosen-snapshot")
        manifest = json.loads(original_manifest)
        manifest["operation_id"] = "tr-foreign"
        (snapshot / "manifest.json").write_text(json.dumps(manifest))
        with self.assertRaisesRegex(install.InstallError, "disagree"):
            self.installer.snapshot_for_operation(self.operation)
        (snapshot / "manifest.json").write_bytes(original_manifest)
        (snapshot / "program.previous").write_bytes(b"corrupt backup")
        with self.assertRaisesRegex(install.InstallError, "integrity"):
            self.installer.snapshot_for_operation(self.operation)
        self.assertEqual(self.runner.calls, [])

    def test_final_source_or_hash_drift_does_not_publish_applied_receipt(self):
        self.existing()
        def change_after_restart(argv):
            if argv[0] == "restart":
                self.program.write_text("print('foreign writer')\n")
        self.runner.before_mutate = change_after_restart
        with self.assertRaises(install.RecoveryRequired):
            self.apply(owner_check=self.owner)
        rp, receipt = self.installer._load_receipt(self.operation)
        snapshot = rp.parent / receipt["snapshot"]
        self.assertEqual(receipt["status"], "applying")
        self.assertEqual(json.loads((snapshot / "manifest.json").read_text())["status"], "prepared")
        self.assertEqual(self.program.read_text(), "print('foreign writer')\n")
        self.assertEqual([c[0] for c in self.runner.mutations()], ["daemon-reload", "enable", "restart"])
        # A separate operation starts from owned files, but its source changes
        # between initial validation and the final success observation.
        self.program.write_bytes(self.program_source.read_bytes())
        self.program.chmod(0o755)
        self.operation = "tr-final-source-drift"
        self.runner.active = "inactive"
        self.runner.enabled = False
        self.runner.before_mutate = lambda argv: self.program_source.write_text("print('source drift')\n") if argv[0] == "restart" else None
        with self.assertRaises(install.RecoveryRequired):
            self.apply(owner_check=self.owner)
        self.assertEqual(self.installer._load_receipt(self.operation)[1]["status"], "applying")

    def test_new_operation_with_identical_install_does_not_restart_sampler(self):
        self.apply(owner_check=self.owner)
        self.operation = "tr-fixture-next-release"
        self.runner.calls.clear()
        second = self.apply(owner_check=self.owner)
        self.assertFalse(second["changed"])
        self.assertEqual(self.runner.mutations(), [])
        self.installer.rollback(Path(second["snapshot"]), owner_check=self.owner)
        self.assertEqual(self.runner.mutations(), [])


if __name__ == "__main__":
    unittest.main()
