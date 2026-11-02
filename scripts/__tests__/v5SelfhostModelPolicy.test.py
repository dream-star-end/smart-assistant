#!/usr/bin/env python3
"""Behavior proofs for versioned model policy and verified legacy recovery.

The shell selector is production code. Only the existing root/Linux artifact and
release-owner boundaries are injected. The artifact probe checks an actual
fixture digest and expected SHA; it never returns green for a damaged fixture.
No production file, password, database, browser or model is accessed.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


REPO = Path(__file__).resolve().parents[2]
LIB = REPO / "scripts/lib/v5-selfhost-model-policy.sh"
BUNDLE = (
    "deploy/v5-selfhost/model-availability.json",
    "scripts/lib/selfhost-model-policy.mjs",
    "packages/commercial/src/billing/modelAvailability.ts",
)
SHA = "1" * 40
OTHER_SHA = "2" * 40
MODELS = "gpt-6-luna,deepseek-v4-flash"


def fixture_digest(root):
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*")):
        if path == root / ".complete":
            continue
        digest.update(str(path.relative_to(root)).encode() + b"\0")
        if path.is_symlink():
            digest.update(b"link:" + os.readlink(path).encode())
        elif path.is_file():
            digest.update(path.read_bytes())
    return digest.hexdigest()


class ModelPolicyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        for executable in ("bash", "node", "jq", "python3"):
            if not shutil.which(executable):
                raise RuntimeError(f"{executable} is required; this proof cannot skip")

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="oc-model-policy-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.rel = self.base / "rel-fixture"
        self.rel.mkdir()
        self.calls = self.base / "boundary-calls"
        self.loaded = self.base / "library-loaded"
        self.probe = self.base / "artifact-probe.py"
        self.probe.write_text(
            "import hashlib,json,os,pathlib,sys\n"
            "root=pathlib.Path(sys.argv[1]); expected=sys.argv[2]\n"
            "with open(sys.argv[3],'a') as log: log.write('static|'+str(root)+'|'+expected+'\\n')\n"
            "try:\n"
            " assert root.is_dir() and not root.is_symlink()\n"
            " marker=json.loads((root/'.complete').read_text())\n"
            " assert marker['sourceCommit']==expected\n"
            " h=hashlib.sha256()\n"
            " for p in sorted(root.rglob('*')):\n"
            "  if p==root/'.complete': continue\n"
            "  h.update(str(p.relative_to(root)).encode()+b'\\0')\n"
            "  if p.is_symlink(): h.update(b'link:'+os.readlink(p).encode())\n"
            "  elif p.is_file(): h.update(p.read_bytes())\n"
            " assert h.hexdigest()==marker['artifactSha256']\n"
            "except (AssertionError,OSError,ValueError,KeyError): sys.exit(78)\n"
        )

    def artifact(self, generation="legacy", grok=False):
        for entry in ("prewarm", "smoke"):
            path = self.rel / f"scripts/v5-user-contract-{entry}.mjs"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(
                "console.log(JSON.stringify({"
                f"entry:{json.dumps(entry)},"
                "models:(process.env.V5_CONTRACT_MODELS||'').split(',').filter(Boolean),"
                "policy:process.env.V5_SELFHOST_MODEL_POLICY_FILE||''}));\n"
            )
        if generation != "legacy":
            for name in BUNDLE:
                path = self.rel / name
                path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(REPO / name, path)
            (self.rel / BUNDLE[0]).write_text(json.dumps({"grokEnabled": grok}))
        self.seal(generation)

    def seal(self, generation="legacy", sha=SHA):
        marker = {"sourceCommit": sha, "artifactSha256": fixture_digest(self.rel)}
        if generation != "legacy":
            marker["modelAvailabilityPolicyGeneration"] = generation
        (self.rel / ".complete").write_text(json.dumps(marker))

    def run_shell(self, body, *, success=True, extra=None):
        self.loaded.unlink(missing_ok=True)
        env = dict(os.environ)
        env.update({
            "REPO": str(REPO), "LIB": str(LIB), "REL": str(self.rel),
            "TEST_CALLS": str(self.calls), "TEST_LOADED": str(self.loaded),
            "TEST_ARTIFACT_PROBE": str(self.probe), "SCRIPT_DIR": str(REPO / "scripts"),
            "TEST_OWNER_VALID": "1", "TEST_PROBE_VALID": "1",
            "TEST_BEFORE_TARGET": str(self.rel), "TEST_BEFORE_SHA": SHA,
            "ROLLBACK_MASTER": str(self.rel), "ROLLBACK_SHA": SHA,
            "CUTOVER_ROLLBACK": "0",
        })
        env.update(extra or {})
        program = r'''
set -euo pipefail
source "$LIB"
printf loaded > "$TEST_LOADED"
assert_master_release_static_gate() {
  python3 "$TEST_ARTIFACT_PROBE" "$1" "$2" "$TEST_CALLS"
}
release_policy_require_owner() {
  printf 'owner\n' >> "$TEST_CALLS"
  [[ "$TEST_OWNER_VALID" == 1 ]]
}
release_policy_probe_stack() {
  printf 'probe|%s\n' "$1" >> "$TEST_CALLS"
  [[ "$TEST_PROBE_VALID" == 1 && "$1" == before ]] || return 79
  printf 'fixture-verified-stack-digest\n'
}
release_policy_py() {
  printf 'field|%s\n' "$*" >> "$TEST_CALLS"
  case "$*" in
    'field before.masterRelease') printf '%s\n' "$TEST_BEFORE_TARGET" ;;
    'field before.sourceCommit') printf '%s\n' "$TEST_BEFORE_SHA" ;;
    *) return 99 ;;
  esac
}
''' + body
        result = subprocess.run(["bash", "-c", program], env=env,
                                capture_output=True, text=True, timeout=20)
        detail = result.stdout + result.stderr
        self.assertTrue(self.loaded.exists(), "production library did not load:\n" + detail)
        if success:
            self.assertEqual(result.returncode, 0, detail)
        else:
            self.assertNotEqual(result.returncode, 0, detail)
        return result

    def selection(self, context, *, success=True, extra=None, run_children=False):
        body = 'model_policy_select_contract_runner "$REL" ' + context + '\n'
        body += '''python3 - "$MODEL_POLICY_CONTRACT_DIR" "$MODEL_POLICY_CONTRACT_MODELS" "$MODEL_POLICY_FILE" <<'PY'
import json,sys
print(json.dumps(dict(zip(['directory','models','policy'],sys.argv[1:]))))
PY
'''
        if run_children:
            body += '''for entry in prewarm smoke; do
  V5_CONTRACT_MODELS="$MODEL_POLICY_CONTRACT_MODELS" \
  V5_SELFHOST_MODEL_POLICY_FILE="$MODEL_POLICY_FILE" \
    node "$MODEL_POLICY_CONTRACT_DIR/v5-user-contract-$entry.mjs"
done
'''
        result = self.run_shell(body, success=success, extra=extra)
        if not success:
            return result
        return [json.loads(line) for line in result.stdout.splitlines()]

    def boundary_calls(self):
        return self.calls.read_text().splitlines() if self.calls.exists() else []

    def test_new_true_and_false_bundles_validate_and_forward(self):
        for grok in (False, True):
            with self.subTest(grok=grok):
                self.artifact(1, grok)
                result = self.run_shell('model_policy_require_bundle "$REL"; model_policy_generation "$REL"; model_policy_require_forward_release "$REL"')
                self.assertEqual(result.stdout.strip(), "1")

    def test_unversioned_entirely_absent_bundle_is_legacy_but_not_forward(self):
        self.artifact()
        result = self.run_shell('model_policy_generation "$REL"')
        self.assertEqual(result.stdout.strip(), "legacy")
        self.run_shell('model_policy_require_forward_release "$REL"', success=False)

    def test_new_generation_missing_each_component_is_fatal(self):
        self.artifact(1)
        for name in BUNDLE:
            with self.subTest(component=name):
                path = self.rel / name
                data = path.read_bytes()
                path.unlink()
                self.run_shell('model_policy_generation "$REL"', success=False)
                self.selection("rollback", success=False, extra={"CUTOVER_ROLLBACK": "1"})
                path.write_bytes(data)

    def test_unknown_or_wrongly_typed_generation_is_fatal(self):
        self.artifact(1)
        for generation in (0, 2, True, "1", None, "legacy"):
            with self.subTest(generation=generation):
                self.seal(generation)
                self.run_shell('model_policy_generation "$REL"', success=False)

    def test_unversioned_partial_or_complete_new_bundle_cannot_be_legacy(self):
        self.artifact()
        for name in BUNDLE:
            path = self.rel / name
            path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(REPO / name, path)
            with self.subTest(component=name):
                self.run_shell('model_policy_generation "$REL"', success=False)
        self.selection("rollback", success=False, extra={"CUTOVER_ROLLBACK": "1"})

    def test_invalid_policy_shapes_and_syntax_remain_fatal(self):
        self.artifact(1)
        path = self.rel / BUNDLE[0]
        for policy in ("null", "[]", "{}", '{"grokEnabled":"false"}',
                       '{"grokEnabled":0}', '{"grokEnabled":null}', "{broken"):
            with self.subTest(policy=policy):
                path.write_text(policy)
                self.run_shell('model_policy_require_bundle "$REL"', success=False)
                self.selection("rollback", success=False, extra={"CUTOVER_ROLLBACK": "1"})

    def test_symlink_or_directory_bundle_component_is_fatal(self):
        self.artifact(1)
        for index, name in enumerate(BUNDLE):
            path = self.rel / name
            data = path.read_bytes()
            outside = self.base / f"outside-component-{index}"
            outside.write_bytes(data)
            path.unlink()
            path.symlink_to(outside)
            with self.subTest(component=name):
                self.run_shell('model_policy_require_bundle "$REL"', success=False)
            path.unlink()
            path.write_bytes(data)
        policy = self.rel / BUNDLE[0]
        policy.unlink()
        policy.mkdir()
        self.run_shell('model_policy_generation "$REL"', success=False)

    def test_missing_malformed_or_symlink_marker_is_fatal(self):
        self.artifact(1)
        marker = self.rel / ".complete"
        data = marker.read_bytes()
        marker.unlink()
        self.run_shell('model_policy_generation "$REL"', success=False)
        marker.write_text("{broken")
        self.run_shell('model_policy_generation "$REL"', success=False)
        marker.unlink()
        outside = self.base / "outside-marker"
        outside.write_bytes(data)
        marker.symlink_to(outside)
        self.run_shell('model_policy_generation "$REL"', success=False)

    def test_forward_legacy_is_rejected_even_with_rollback_fields(self):
        self.artifact()
        self.selection("forward", success=False)
        self.selection("forward", success=False, extra={"CUTOVER_ROLLBACK": "1"})

    def test_unknown_context_is_rejected(self):
        self.artifact(1)
        self.selection("skip", success=False)

    def test_new_forward_uses_canonical_runner_and_resets_inherited_outputs(self):
        self.artifact(1)
        selected = self.selection("forward", extra={
            "MODEL_POLICY_CONTRACT_DIR": "/untrusted", "MODEL_POLICY_CONTRACT_MODELS": "grok-build",
            "MODEL_POLICY_FILE": "/untrusted-policy",
        })[0]
        self.assertEqual(selected, {"directory": str(REPO / "scripts"), "models": "",
                                    "policy": str(self.rel / BUNDLE[0])})

    def test_legacy_rollback_selects_verified_children_and_explicit_models(self):
        self.artifact()
        rows = self.selection("rollback", extra={"CUTOVER_ROLLBACK": "1"}, run_children=True)
        self.assertEqual(rows[0], {"directory": str(self.rel / "scripts"),
                                   "models": MODELS, "policy": ""})
        self.assertEqual(rows[1:], [
            {"entry": "prewarm", "models": MODELS.split(","), "policy": ""},
            {"entry": "smoke", "models": MODELS.split(","), "policy": ""},
        ])
        self.assertIn(f"static|{self.rel}|{SHA}", self.boundary_calls())

    def test_legacy_rollback_requires_internal_flag_exact_target_and_sha(self):
        self.artifact()
        for extra in ({}, {"CUTOVER_ROLLBACK": "1", "ROLLBACK_MASTER": str(self.base / "other")},
                      {"CUTOVER_ROLLBACK": "1", "ROLLBACK_SHA": OTHER_SHA},
                      {"CUTOVER_ROLLBACK": "1", "ROLLBACK_SHA": ""}):
            with self.subTest(extra=extra):
                self.selection("rollback", success=False, extra=extra)

    def test_legacy_rollback_rejects_artifact_digest_damage(self):
        self.artifact()
        with (self.rel / "scripts/v5-user-contract-smoke.mjs").open("a") as stream:
            stream.write("// tampered after sealing\n")
        self.selection("rollback", success=False, extra={"CUTOVER_ROLLBACK": "1"})
        self.assertIn(f"static|{self.rel}|{SHA}", self.boundary_calls())

    def test_legacy_recovery_rejects_symlink_children_or_script_directory(self):
        self.artifact()
        for entry in ("prewarm", "smoke"):
            child = self.rel / f"scripts/v5-user-contract-{entry}.mjs"
            data = child.read_bytes()
            outside = self.base / f"outside-{entry}.mjs"
            outside.write_bytes(data)
            child.unlink()
            child.symlink_to(outside)
            self.seal()
            with self.subTest(entry=entry):
                self.selection("rollback", success=False, extra={"CUTOVER_ROLLBACK": "1"})
            child.unlink()
            child.write_bytes(data)
        scripts = self.rel / "scripts"
        outside_scripts = self.base / "outside-scripts"
        scripts.rename(outside_scripts)
        scripts.symlink_to(outside_scripts, target_is_directory=True)
        self.seal()
        self.selection("rollback", success=False, extra={"CUTOVER_ROLLBACK": "1"})

    def test_legacy_compensation_requires_owner_before_target_sha_and_running_tuple(self):
        self.artifact()
        for extra in ({"TEST_OWNER_VALID": "0"},
                      {"TEST_BEFORE_TARGET": str(self.base / "other")},
                      {"TEST_BEFORE_SHA": OTHER_SHA}, {"TEST_PROBE_VALID": "0"}):
            with self.subTest(extra=extra):
                self.selection("compensation", success=False, extra=extra)

    def test_legacy_compensation_selects_children_only_after_owner_and_stack_proof(self):
        self.artifact()
        rows = self.selection("compensation", run_children=True)
        self.assertEqual(rows[0]["directory"], str(self.rel / "scripts"))
        self.assertEqual([r["models"] for r in rows[1:]], [MODELS.split(","), MODELS.split(",")])
        calls = self.boundary_calls()
        self.assertIn("owner", calls)
        self.assertIn("probe|before", calls)
        self.assertIn(f"static|{self.rel}|{SHA}", calls)

    def test_compensation_rejects_digest_damage(self):
        self.artifact()
        (self.rel / "new-file-after-seal").write_text("damaged artifact")
        self.selection("compensation", success=False)
        self.assertIn(f"static|{self.rel}|{SHA}", self.boundary_calls())

    def test_generation_one_recovery_still_verifies_identity_and_uses_current_runner(self):
        self.artifact(1)
        for context, extra in (("rollback", {"CUTOVER_ROLLBACK": "1"}), ("compensation", {})):
            with self.subTest(context=context):
                selected = self.selection(context, extra=extra)[0]
                self.assertEqual(selected["directory"], str(REPO / "scripts"))
                self.assertEqual(selected["models"], "")
                self.assertEqual(selected["policy"], str(self.rel / BUNDLE[0]))
        self.assertGreaterEqual(self.boundary_calls().count(f"static|{self.rel}|{SHA}"), 2)

    def test_generation_one_cannot_bypass_recovery_identity_or_running_tuple(self):
        self.artifact(1)
        for context, extra in (
            ("rollback", {}),
            ("rollback", {"CUTOVER_ROLLBACK": "1", "ROLLBACK_MASTER": str(self.base / "other")}),
            ("rollback", {"CUTOVER_ROLLBACK": "1", "ROLLBACK_SHA": OTHER_SHA}),
            ("compensation", {"TEST_OWNER_VALID": "0"}),
            ("compensation", {"TEST_BEFORE_TARGET": str(self.base / "other")}),
            ("compensation", {"TEST_BEFORE_SHA": OTHER_SHA}),
            ("compensation", {"TEST_PROBE_VALID": "0"}),
        ):
            with self.subTest(context=context, extra=extra):
                self.selection(context, success=False, extra=extra)

    def test_generation_one_recovery_rejects_after_seal_digest_damage(self):
        self.artifact(1)
        with (self.rel / "scripts/v5-user-contract-smoke.mjs").open("a") as stream:
            stream.write("// generation-one damage after seal\n")
        self.selection("rollback", success=False, extra={"CUTOVER_ROLLBACK": "1"})
        self.selection("compensation", success=False)
        self.assertGreaterEqual(self.boundary_calls().count(f"static|{self.rel}|{SHA}"), 2)

    def test_direct_new_parser_keeps_missing_policy_fatal_before_password_or_browser(self):
        missing = self.rel / BUNDLE[0]
        result = subprocess.run([
            "node", "--input-type=module", "-e",
            "const {parseOptions}=await import(process.argv[1]);"
            "try {parseOptions({V5_SELFHOST_MODEL_POLICY_FILE:process.argv[2]});process.exit(9);}"
            "catch(error){if(error.code!=='ENOENT')throw error;"
            "console.log(JSON.stringify({stage:'parseOptions',errorCode:error.code}));}",
            (REPO / "scripts/lib/user-contract.mjs").as_uri(), str(missing),
        ], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(json.loads(result.stdout), {"stage": "parseOptions", "errorCode": "ENOENT"})


if __name__ == "__main__":
    unittest.main(verbosity=2)
