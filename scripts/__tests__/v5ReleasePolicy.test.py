#!/usr/bin/env python3
"""Exercise real durable intents and policy decisions without production I/O."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

HELPER = Path(__file__).resolve().parents[1] / "lib/v5-release-policy.py"
spec = importlib.util.spec_from_file_location("v5_release_policy", HELPER)
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)

class ReleasePolicyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="ocv5-521-policy-")
        self.root = Path(self.tmp.name)
        self.path = self.root / "unresolved.json"
        old = {"masterRelease": "/releases/old", "currentTarget": "bundles/old", "tuple": {
            "OC_RUNTIME_IMAGE": None, "OC_RUNTIME_IMAGE_ID": "", "OC_RUNTIME_RELEASE": "/runtime/old", "OC_PLATFORM_BUNDLE": ""},
            "sourceCommit": "1" * 40, "port": 18790}
        target = copy.deepcopy(old)
        target.update(masterRelease="/releases/new", currentTarget="bundles/new", sourceCommit="2" * 40)
        target["tuple"]["OC_RUNTIME_RELEASE"] = "/runtime/new"
        self.request = {"edition": "selfhost", "operationId": "op-521", "candidateSha": "2" * 40,
                        "owner": {"deploymentId": "train-521", "nonce": "nonce-521"}, "before": old, "target": target,
                        "history": {"path": str(self.root / "history.jsonl"), "predecessorSha256": hashlib.sha256(b"").hexdigest(), "transitionKind": "joint"}}

    def tearDown(self):
        self.tmp.cleanup()

    def prepare(self):
        return policy.prepare(self.path, self.request)

    def exposed(self):
        self.prepare()
        return policy.checkpoint(self.path, "op-521", {"phase": "exposure-armed", "mayHaveServed": True})

    def facts(self, **extra):
        return {"ownerHeld": True, "identity": "exact", "service": "usable", "authority": "applied", **extra}

    def verified(self, authority="unobserved"):
        return {"identity": "exact", "service": "usable", "authority": authority,
                "allRequiredPassed": True, "lineageCoherent": True, "verifiedDirection": "target",
                "verifiedStackSha256": policy.stack_digest(self.request["target"])}

    def test_preserves_unset_empty_and_captured_predecessor(self):
        value = self.prepare()
        self.assertIsNone(value["before"]["tuple"]["OC_RUNTIME_IMAGE"])
        self.assertEqual(value["before"]["tuple"]["OC_RUNTIME_IMAGE_ID"], "")
        self.assertEqual(policy.load(self.path, "op-521"), value)
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)

    def test_active_intent_is_not_replaced_by_another_operation(self):
        self.prepare()
        before = self.path.read_bytes()
        other = copy.deepcopy(self.request)
        other["operationId"] = "other"
        with self.assertRaises(policy.PolicyError):
            policy.prepare(self.path, other)
        self.assertEqual(self.path.read_bytes(), before)
        with self.assertRaises(policy.PolicyError):
            policy.checkpoint(self.path, "other", {"mayHaveServed": True})
        self.assertEqual(self.path.read_bytes(), before)

    def test_rejects_full_env_and_executable_payload_before_creation(self):
        for key in ["env", "callback", "commitRevert"]:
            bad = copy.deepcopy(self.request)
            bad[key] = "not a runtime identity"
            with self.assertRaises(policy.PolicyError):
                policy.prepare(self.path, bad)
            self.assertFalse(self.path.exists())
        self.request["target"]["tuple"]["AUTH_TOKEN"] = "fixture-value"
        with self.assertRaises(policy.PolicyError):
            self.prepare()
        self.assertFalse(self.path.exists())

    def test_rejects_target_sha_mismatch_and_unsafe_owner(self):
        self.request["target"]["sourceCommit"] = "3" * 40
        with self.assertRaises(policy.PolicyError):
            self.prepare()
        self.assertFalse(self.path.exists())
        self.request["target"]["sourceCommit"] = "2" * 40
        self.request["owner"]["nonce"] = "../foreign"
        with self.assertRaises(policy.PolicyError):
            self.prepare()

    def test_symlink_and_publicly_readable_context_are_not_trusted(self):
        self.path.symlink_to(self.root / "absent")
        with self.assertRaises(policy.PolicyError):
            self.prepare()
        self.path.unlink()
        self.prepare()
        os.chmod(self.path, 0o644)
        with self.assertRaises(policy.PolicyError):
            policy.load(self.path, "op-521")

    def test_prepare_directory_fsync_error_is_reported(self):
        with mock.patch.object(policy, "sync_directory", side_effect=OSError("injected directory sync failure")):
            with self.assertRaises(OSError):
                self.prepare()
        if self.path.exists():
            self.assertFalse(policy.load(self.path, "op-521")["mayHaveServed"])

    def test_exposure_cannot_be_forgotten_or_predecessor_changed(self):
        self.exposed()
        for patch in [{"mayHaveServed": False}, {"before": {}}, {"target": {}}, {"phase": "resolved"}]:
            with self.assertRaises(policy.PolicyError):
                policy.checkpoint(self.path, "op-521", patch)
        self.assertTrue(policy.load(self.path, "op-521")["mayHaveServed"])

    def test_failed_replace_keeps_prearmed_record(self):
        self.exposed()
        before = self.path.read_bytes()
        with mock.patch.object(policy.os, "replace", side_effect=OSError("injected rename failure")):
            with self.assertRaises(OSError):
                policy.checkpoint(self.path, "op-521", {"phase": "held"})
        self.assertEqual(self.path.read_bytes(), before)
        self.assertTrue(policy.load(self.path, "op-521")["mayHaveServed"])

    def test_checkpoint_lost_sync_ack_keeps_complete_conservative_intent(self):
        self.exposed()
        with mock.patch.object(policy, "sync_directory", side_effect=OSError("injected acknowledgement loss")):
            with self.assertRaises(OSError):
                policy.checkpoint(self.path, "op-521", {"phase": "held"})
        after = policy.load(self.path, "op-521")
        self.assertTrue(after["mayHaveServed"])
        self.assertEqual(after["before"], self.request["before"])
        self.assertEqual(after["target"], self.request["target"])

    def test_healthy_metadata_or_external_gate_failure_keeps_candidate(self):
        context = self.exposed()
        for authority in ["original", "applied", "unobserved"]:
            self.assertEqual(policy.decide(context, self.facts(authority=authority)), "KEEP_FAILED")

    def test_unknown_source_authority_or_probe_never_authorizes_compensation(self):
        context = self.exposed()
        for facts in [self.facts(identity="alien"), self.facts(identity="unknown"), self.facts(authority="unknown"),
                      self.facts(service="unknown"), self.facts(service="unavailable")]:
            self.assertEqual(policy.decide(context, facts), "HOLD_UNKNOWN")

    def test_fencing_takes_precedence_over_all_other_facts(self):
        context = self.prepare()
        self.assertEqual(policy.decide(context, self.facts(ownerHeld=False)), "CRASH_STOP")
        context = policy.checkpoint(self.path, "op-521", {"mayHaveServed": True, "phase": "exposure-armed"})
        self.assertEqual(policy.decide(context, self.facts(ownerHeld=False)), "CRASH_STOP")

    def test_preexposure_failure_only_aborts_preparation(self):
        self.assertEqual(policy.decide(self.prepare(), self.facts()), "PREPARATION_ABORT")

    def test_candidate_bound_failed_local_service_can_use_guarded_compensation(self):
        context = self.exposed()
        proof = {"kind": "local-service-unavailable", "candidateSha": "2" * 40,
                 "masterRelease": "/releases/new", "unitState": "failed", "loopbackError": "ECONNREFUSED", "port": 18790}
        self.assertEqual(policy.decide(context, self.facts(service="unavailable", impact=proof)), "COMPENSATE_USER_IMPAIRMENT")
        for service in ["usable", "unknown"]:
            self.assertNotEqual(policy.decide(context, self.facts(service=service, impact=proof)), "COMPENSATE_USER_IMPAIRMENT")
        for key, value in [("candidateSha", "1" * 40), ("masterRelease", "/releases/old"), ("port", 18789),
                           ("unitState", "unknown"), ("loopbackError", "ETIMEDOUT")]:
            wrong = {**proof, key: value}
            self.assertEqual(policy.decide(context, self.facts(service="unavailable", impact=wrong)), "HOLD_UNKNOWN")
        self.assertEqual(policy.decide(context, self.facts(identity="alien", service="unavailable", impact=proof)), "HOLD_UNKNOWN")

    def test_operator_impact_requires_candidate_binding_and_evidence_digest(self):
        context = self.exposed()
        proof = {"kind": "operator-confirmed", "candidateSha": "2" * 40, "masterRelease": "/releases/new", "evidenceSha256": "a" * 64}
        self.assertEqual(policy.decide(context, self.facts(impact=proof)), "COMPENSATE_USER_IMPAIRMENT")
        self.assertEqual(policy.decide(context, self.facts(impact={**proof, "evidenceSha256": "red log"})), "KEEP_FAILED")

    def test_failed_gate_or_incoherent_lineage_cannot_resolve_hold(self):
        self.exposed()
        for change in [{"allRequiredPassed": False}, {"lineageCoherent": False}, {"authority": "unknown"}, {"identity": "unknown"}]:
            policy.checkpoint(self.path, "op-521", {"observations": {**self.verified(), **change}})
            with self.assertRaises(policy.PolicyError):
                policy.resolve(self.path, "op-521", "forward")
            self.assertTrue(self.path.exists())

    def test_forward_resolution_is_archived_and_idempotent(self):
        self.exposed()
        policy.checkpoint(self.path, "op-521", {"observations": self.verified()})
        first = policy.resolve(self.path, "op-521", "forward")
        self.assertFalse(self.path.exists())
        self.assertEqual(policy.resolve(self.path, "op-521", "forward"), first)
        with self.assertRaises(policy.PolicyError):
            policy.resolve(self.path, "op-521", "compensated")

    def test_resolve_retries_directory_sync_after_unlink_ack_loss(self):
        self.exposed()
        policy.checkpoint(self.path, "op-521", {"observations": self.verified()})
        real_sync = policy.sync_directory
        count = 0
        def fail_second(path):
            nonlocal count
            count += 1
            if count == 2:
                raise OSError("unlink directory sync failed")
            return real_sync(path)
        with mock.patch.object(policy, "sync_directory", side_effect=fail_second):
            with self.assertRaises(OSError):
                policy.resolve(self.path, "op-521", "forward")
        self.assertFalse(self.path.exists())
        with mock.patch.object(policy, "sync_directory", side_effect=OSError("retry still unavailable")):
            with self.assertRaises(OSError):
                policy.resolve(self.path, "op-521", "forward")
        policy.resolve(self.path, "op-521", "forward")

    def test_resolve_requires_fresh_selected_direction_and_exact_stack_digest(self):
        self.exposed()
        for changed in [{"verifiedDirection": "before"}, {"verifiedStackSha256": "0" * 64}]:
            policy.checkpoint(self.path, "op-521", {"observations": {**self.verified(), **changed}})
            with self.assertRaises(policy.PolicyError):
                policy.resolve(self.path, "op-521", "forward")
        policy.checkpoint(self.path, "op-521", {"observations": self.verified()})
        with self.assertRaises(policy.PolicyError):
            policy.resolve(self.path, "op-521", "compensated")
        verified = {**self.verified(), "verifiedDirection": "before", "verifiedStackSha256": policy.stack_digest(self.request["before"])}
        policy.checkpoint(self.path, "op-521", {"observations": verified})
        self.assertEqual(policy.resolve(self.path, "op-521", "compensated")["resolution"], "compensated")

    def test_possible_exposure_cannot_be_resolved_as_preparation(self):
        self.exposed()
        with self.assertRaises(policy.PolicyError):
            policy.resolve(self.path, "op-521", "preparation-abort")
        self.assertTrue(self.path.exists())

    def test_resolved_phase_requires_matching_terminal_resolution(self):
        value = self.prepare()
        value["phase"] = "resolved"
        with self.assertRaises(policy.PolicyError):
            policy.validate(value)

    def test_archive_path_does_not_accept_parent_traversal(self):
        self.prepare()
        with self.assertRaises(policy.PolicyError):
            policy.resolve(self.path, "../foreign", "preparation-abort")

    def test_cli_summary_does_not_emit_runtime_tuple(self):
        self.request["target"]["tuple"]["OC_RUNTIME_IMAGE"] = "private-fixture-not-for-output"
        self.prepare()
        completed = subprocess.run([sys.executable, str(HELPER), "inspect", "--context", str(self.path), "--operation", "op-521"], capture_output=True, text=True)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(json.loads(completed.stdout)["operationId"], "op-521")
        self.assertNotIn("private-fixture", completed.stdout)
        self.assertNotIn("OC_RUNTIME_IMAGE", completed.stdout)

if __name__ == "__main__":
    unittest.main(verbosity=2)
