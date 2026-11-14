#!/usr/bin/env python3
"""Fast stdlib contracts for the actual validation-profile API and CLI."""

import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest

HELPER = Path(__file__).resolve().parents[1] / "lib" / "v5-validation-profile.py"
SPEC = importlib.util.spec_from_file_location("v5_validation_profile", HELPER)
PROFILE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROFILE)
SHA = "31dedfb0bc4243dbcb32b1d1dfdd9fbcdad3b5fd"
QUEUE = "rq-20261103T004500Z-aabbccddeeff"
OWNER = "original-deployment-id"
REF = "parent:user-approved-commercial-grok-skip"


def make(operation=OWNER):
    return PROFILE.make_profile("skip-grok", REF, QUEUE, SHA, operation)


class ValidationProfileTests(unittest.TestCase):
    def cli(self, *args, data=None, env=None):
        return subprocess.run(
            [sys.executable, "-B", str(HELPER), *args],
            input=data, text=True, capture_output=True, timeout=5, env=env,
        )

    def rejected(self, value, **expected):
        with self.assertRaises(ValueError):
            PROFILE.validate_profile(value, **expected)

    def test_normal_and_legacy_remain_none(self):
        self.assertIsNone(PROFILE.make_profile("normal", None, None, None))
        self.assertIsNone(PROFILE.make_profile("normal", REF, QUEUE, SHA, OWNER))
        self.assertIsNone(PROFILE.validate_profile(None, SHA, QUEUE, OWNER))
        for args, data in [(("normalize",), None), (("validate",), "null")]:
            result = self.cli(*args, data=data)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, "null\n")

    def test_fixed_scope_and_exact_pins(self):
        value = make()
        self.assertEqual(value, {
            "schemaVersion": 1, "profile": "skip-grok",
            "authorizationRef": REF, "queueId": QUEUE, "sourceSha": SHA,
            "operationId": OWNER, "matrixModels": ["deepseek-v4-flash"],
            "journeyModel": "deepseek-v4-flash",
            "skipped": ["grok-build:matrix", "grok-build:journey"],
        })
        self.assertEqual(PROFILE.validate_profile(value, SHA, QUEUE, OWNER), value)
        self.assertNotIn("operationId", make(None))

    def test_unknown_profile_is_closed(self):
        for name in ("", "skip-all", "skip-grok ", "NORMAL", None, False):
            with self.subTest(name=name), self.assertRaises(ValueError):
                PROFILE.make_profile(name, REF, QUEUE, SHA)

    def test_required_bindings_and_sha_shape(self):
        for index, invalids in [
            (0, [None, "", "  ", False, 1]),
            (1, [None, "", "  ", False, 1]),
            (2, [None, "", SHA[:12], SHA.upper(), "g" * 40, False]),
        ]:
            for invalid in invalids:
                values = [REF, QUEUE, SHA]
                values[index] = invalid
                with self.subTest(index=index, invalid=invalid), self.assertRaises(ValueError):
                    PROFILE.make_profile("skip-grok", *values)

    def test_missing_and_unknown_fields_fail(self):
        for key in make():
            bad = make()
            del bad[key]
            if key == "operationId":
                self.rejected(bad, operation_id=OWNER)
            else:
                self.rejected(bad)
        for key in ("unknown", "hash", "digest", "modelOverride"):
            bad = make()
            bad[key] = "extra"
            self.rejected(bad)

    def test_schema_types_and_normal_object_are_not_legacy(self):
        for value in ([], "skip-grok", 1, False, {"profile": "normal"}):
            self.rejected(value)
        for version in (True, "1", 1.0, 0, 2, None):
            bad = make()
            bad["schemaVersion"] = version
            self.rejected(bad)
        bad = make()
        bad["profile"] = "normal"
        self.rejected(bad)

    def test_cannot_change_models_or_exclusions(self):
        for field, values in {
            "matrixModels": [[], ["grok-build"], ["deepseek-v4-flash", "grok-build"],
                             "deepseek-v4-flash", ("deepseek-v4-flash",)],
            "journeyModel": ["grok-build", "another-model", None, []],
            "skipped": [[], ["grok-build:matrix"],
                        ["grok-build:journey", "grok-build:matrix"],
                        ["grok-build:matrix", "grok-build:journey", "other"]],
        }.items():
            for value in values:
                bad = make()
                bad[field] = value
                with self.subTest(field=field, value=value):
                    self.rejected(bad)

    def test_expected_pin_mismatch_and_empty_expected_reject(self):
        for expected in (
            {"source_sha": "a" * 40}, {"queue_id": "different-queue"},
            {"operation_id": "new-lease-id"}, {"source_sha": ""},
            {"queue_id": ""}, {"operation_id": ""}, {"operation_id": False},
        ):
            with self.subTest(expected=expected):
                self.rejected(make(), **expected)

    def test_recovery_uses_original_owner_not_new_lease(self):
        value = make()
        self.assertEqual(PROFILE.validate_profile(
            value, source_sha=SHA, queue_id=QUEUE, operation_id=OWNER,
        ), value)
        self.rejected(value, operation_id="recovery-new-mutation-lease")
        self.rejected(make(None), operation_id=OWNER)

    def test_present_operation_must_be_nonempty(self):
        self.assertEqual(make("a" * 128)["operationId"], "a" * 128)
        self.assertEqual(make("op:original_1.2-3")["operationId"], "op:original_1.2-3")
        for value in ("", " ", None, False, 123, "with space", "tab\tid",
                      "line\nid", "id\x00", "a" * 129):
            bad = make()
            bad["operationId"] = value
            self.rejected(bad)
            if value is not None:
                with self.assertRaises(ValueError):
                    make(value)

    def test_validation_returns_copy_without_mutating_input(self):
        value = make()
        before = copy.deepcopy(value)
        result = PROFILE.validate_profile(value)
        self.assertEqual(value, before)
        self.assertIsNot(result, value)
        result["matrixModels"].append("changed")
        result["skipped"].clear()
        self.assertEqual(value, before)

    def test_cli_canonical_unicode_roundtrip(self):
        ref = "父授权:商业Grok跳过"
        expected = PROFILE.make_profile("skip-grok", ref, QUEUE, SHA, OWNER)
        canonical = json.dumps(expected, sort_keys=True, separators=(",", ":")) + "\n"
        result = self.cli(
            "normalize", "--profile", "skip-grok", "--authorization-ref", ref,
            "--queue-id", QUEUE, "--source-sha", SHA, "--operation-id", OWNER,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, canonical)
        checked = self.cli(
            "validate", "--source-sha", SHA, "--queue-id", QUEUE,
            "--operation-id", OWNER, data=json.dumps(expected, indent=2),
        )
        self.assertEqual(checked.returncode, 0, checked.stderr)
        self.assertEqual(checked.stdout, canonical)

    def test_cli_rejects_invalid_json_duplicate_keys_and_nonfinite(self):
        for payload in ("", "{", "null null", '{"profile":"skip-grok","profile":"normal"}',
                        '{"number":NaN}', '{"number":Infinity}', "false", "[]"):
            result = self.cli("validate", data=payload)
            with self.subTest(payload=payload):
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, "")
                self.assertNotIn("Traceback", result.stderr)

    def test_cli_rejects_missing_pins_unknown_flags_and_new_owner(self):
        for args in (
            ("normalize", "--profile", "skip-grok"),
            ("normalize", "--profile", "unknown"),
            ("normalize", "--prof", "skip-grok"),
            ("validate", "--operation-id", "new-owner"),
        ):
            result = self.cli(*args, data=json.dumps(make()))
            with self.subTest(args=args):
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, "")

    def test_cli_rejects_whitespace_operation_even_without_expected_pin(self):
        value = make()
        value["operationId"] = "with space"
        result = self.cli("validate", data=json.dumps(value))
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "")

    def test_normal_is_not_changed_by_environment_profile(self):
        result = self.cli("normalize", env={
            "V5_VALIDATION_PROFILE": "skip-grok",
            "V5_TURN_MODELS": "another-model",
        })
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "null\n")


if __name__ == "__main__":
    unittest.main()
