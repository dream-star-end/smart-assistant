"""Offline real-child failure diagnostics; no paid API or shared account."""
import hashlib
import json
import os
from pathlib import Path
import resource
import secrets
import select
import shutil
import signal
import subprocess
import sys
import unittest

HERE = Path(__file__).parent
SUPERVISOR = Path(os.environ.get("OCV5_SUPERVISOR_UNDER_TEST", str(HERE / "box_supervisor.py")))
KEEPER = HERE / "box_keeper.py"
FIXTURE = HERE / "failure-diagnostic-v1.fixture.json"


class FailureDiagnosticTest(unittest.TestCase):
    def setUp(self):
        self.proofs = []
        raw = SUPERVISOR.read_bytes() + f"\n# diag-test-{secrets.token_hex(8)}\n".encode()
        self.staged = Path("/tmp") / f"ocv5-289-supervisor-{hashlib.sha256(raw).hexdigest()[:16]}.py"
        self.staged.write_bytes(raw)
        self.staged.chmod(0o600)

    def tearDown(self):
        self.staged.unlink(missing_ok=True)
        for proof in self.proofs:
            if proof.is_symlink():
                proof.unlink()
            else:
                shutil.rmtree(proof, ignore_errors=True)

    def identity(self, create=True):
        proof = Path("/tmp") / f"ocv5-289-proof-{secrets.token_hex(12)}"
        epoch = secrets.token_hex(16)
        self.proofs.append(proof)
        if create:
            proof.mkdir(mode=0o700)
        return proof, epoch

    def run_child(self, code, *, options=(), proof=None, epoch=None, keeper=False, env=None,
                  preexec_fn=None):
        base = [sys.executable, "-I"]
        if keeper:
            base += [str(KEEPER), str(self.staged)]
        else:
            base += [str(SUPERVISOR)]
        opts = ["--deadline", "3", "--kill-after", ".05", "--max-output", "262144"]
        for option, value in zip(options[::2], options[1::2]):
            if option in opts:
                opts[opts.index(option) + 1] = value
            else:
                opts += [option, value]
        base += opts
        child_env = {k: v for k, v in os.environ.items()
                     if not k.startswith(("OCV5_DIAGNOSTIC_", "OCV5_KEEPER_", "OCV5_SUPERVISOR_"))}
        child_env.update(env or {})
        if proof is not None:
            if keeper:
                base += ["--proof-dir", str(proof), "--lease-epoch", epoch]
            else:
                child_env.update(OCV5_DIAGNOSTIC_PROOF_DIR=str(proof), OCV5_DIAGNOSTIC_LEASE_EPOCH=epoch)
        return subprocess.run([*base, "--", sys.executable, "-I", "-c", code],
                              env=child_env, capture_output=True, timeout=8, preexec_fn=preexec_fn)

    def load(self, proof, epoch):
        path = proof / "failure.diag.json"
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        raw = path.read_bytes()
        self.assertLess(len(raw), 8192)
        value = json.loads(raw)
        fixture = json.loads(FIXTURE.read_text())
        self.assertEqual(set(value), set(fixture))
        self.assertEqual(value["flags"].keys(), fixture["flags"].keys())
        self.assertEqual(value["runNonce"], proof.name[-24:])
        self.assertEqual(value["leaseEpoch"], epoch)
        self.assertEqual((value["version"], value["producer"]), (1, "supervisor"))
        self.assertNotIn(".tmp", " ".join(x.name for x in proof.iterdir()))
        return value

    def test_auth_exit_one_schema_and_no_secret_retention(self):
        proof, epoch = self.identity()
        secret = "Bearer sk-private-token https://secret.invalid/path?token=secret user-private"
        stderr = "API Error: 401 " + secret + "\n"
        output = json.dumps({"type": "result", "is_error": True, "result": stderr}) + "\n"
        proc = self.run_child(f"import sys;sys.stdout.write({output!r});sys.stderr.write({stderr!r});sys.exit(1)",
                              proof=proof, epoch=epoch)
        self.assertEqual((proc.returncode, proc.stdout, proc.stderr), (1, output.encode(), b""))
        value = self.load(proof, epoch)
        expected = json.loads(FIXTURE.read_text())
        expected.update(runNonce=proof.name[-24:], leaseEpoch=epoch,
                        stdoutBytes=len(output.encode()), stderrBytes=len(stderr.encode()))
        self.assertEqual(value, expected)
        self.assertNotIn("secret", json.dumps(value))
        self.assertNotIn("Bearer", json.dumps(value))

    def test_success_writes_no_file_and_no_identity_reaches_cli(self):
        proof, epoch = self.identity()
        proc = self.run_child('import os;assert not any(k.startswith("OCV5_DIAGNOSTIC_") for k in os.environ);print("ok")',
                              proof=proof, epoch=epoch)
        self.assertEqual((proc.returncode, proc.stdout, proc.stderr), (0, b"ok\n", b""))
        self.assertEqual(list(proof.iterdir()), [])

    def test_absent_diagnostic_is_backward_compatible(self):
        proc = self.run_child('import sys;print("old");sys.stderr.write("API Error: 401 secret");sys.exit(7)')
        self.assertEqual((proc.returncode, proc.stdout, proc.stderr), (7, b"old\n", b""))

    def test_deadline_keeps_exit_124_and_signal(self):
        proof, epoch = self.identity()
        proc = self.run_child("import time;time.sleep(30)", options=("--deadline", ".4"),
                              proof=proof, epoch=epoch)
        self.assertEqual(proc.returncode, 124)
        value = self.load(proof, epoch)
        self.assertEqual((value["reason"], value["stage"]), ("deadline", "stream"))
        self.assertIn(value["cliSignal"], (signal.SIGTERM, signal.SIGKILL))

    def test_stdout_and_stderr_budgets_keep_exit_125(self):
        for stream, options, reason in [
            ("stdout", ("--max-output", "1000"), "output_limit"),
            ("stderr", ("--stderr-limit", "1000"), "stderr_limit"),
            ("stderr", ("--max-output", "1000"), "output_limit"),
        ]:
            with self.subTest(stream=stream, reason=reason):
                proof, epoch = self.identity()
                proc = self.run_child(f'import sys;sys.{stream}.write("x"*10000);sys.{stream}.flush()',
                                      options=options, proof=proof, epoch=epoch)
                self.assertEqual(proc.returncode, 125)
                value = self.load(proof, epoch)
                self.assertEqual((value["reason"], value["stage"]), (reason, "stream"))
                self.assertGreater(value[stream + "Bytes"], 1000)
                self.assertTrue(value["flags"][stream + "Truncated"])

    def test_bounded_lines_bad_json_and_latest_known_error(self):
        proof, epoch = self.identity()
        code = ('import sys;sys.stdout.write("{bad\\n" + "x"*9000 + "\\n");'
                'sys.stdout.flush();sys.stderr.write("e"*9000 + "\\nAPI Error: 429 secret\\n");sys.exit(1)')
        proc = self.run_child(code, proof=proof, epoch=epoch)
        self.assertEqual(proc.returncode, 1)
        value = self.load(proof, epoch)
        self.assertEqual(value["flags"], {"stderrTruncated": True, "stdoutTruncated": True, "parseFailed": True})
        self.assertEqual((value["httpStatus"], value["upstreamCode"]), (429, "rate_limit"))

    def test_json_error_classification_and_no_arbitrary_prose_matching(self):
        cases = [
            ({"type": "error", "error": {"type": "authentication_error", "status": 401, "message": "secret"}}, 401, "authentication"),
            ({"type": "error", "error": {"type": "permission_error", "status": 403}}, 403, "permission"),
            ({"type": "error", "error": {"type": "overloaded_error", "status": 503}}, 503, "overloaded"),
            ({"type": "result", "is_error": True, "result": "Error: ECONNRESET: private"}, None, "network"),
            ({"type": "result", "is_error": True, "errors": ["API Error: 429 secret"]}, 429, "rate_limit"),
            ({"type": "assistant", "message": "API Error: 401 secret"}, None, "unknown"),
            ({"type": "result", "is_error": True, "result": "user said API Error: 401"}, None, "unknown"),
        ]
        for payload, status, kind in cases:
            with self.subTest(kind=kind, payload=payload["type"]):
                proof, epoch = self.identity()
                proc = self.run_child(f"import sys;print({json.dumps(payload)!r});sys.exit(1)",
                                      proof=proof, epoch=epoch)
                self.assertEqual(proc.returncode, 1)
                value = self.load(proof, epoch)
                self.assertEqual((value["httpStatus"], value["upstreamCode"]), (status, kind))


    def test_synthetic_cli_errors_preserve_first_complete_observation(self):
        cases = [
            ({"error": "authentication_failed"}, None, "authentication"),
            ({"error": "rate_limit"}, None, "rate_limit"),
            ({"error": "invalid_request", "text": "API Error: 400 secret"}, 400, "invalid_request"),
            ({"error": "server_error", "text": "API Error: 500 secret"}, 500, "unknown"),
            ({"error": "unknown", "text": "API Error: 403 secret"}, 403, "permission"),
        ]
        for spec, status, category in cases:
            with self.subTest(spec=spec):
                proof, epoch = self.identity()
                first = {"type": "assistant", "error": spec["error"], "is_api_error_message": True,
                         "message": {"model": "<synthetic>", "content": [
                             {"type": "text", "text": spec.get("text", "Bearer sk-private-token")}]}}
                # A later error must not fill the first event's missing HTTP or
                # overwrite its category. Result events still update lastEvent.
                events = [first, {"type": "result", "is_error": True,
                                  "result": "API Error: 429 https://secret.invalid/token",
                                  "errors": ["turn ended on an API error"]}]
                raw = "".join(json.dumps(item) + "\n" for item in events)
                proc = self.run_child(f"import sys;sys.stdout.write({raw!r});sys.exit(1)",
                                      proof=proof, epoch=epoch)
                self.assertEqual((proc.returncode, proc.stdout), (1, raw.encode()))
                value = self.load(proof, epoch)
                self.assertEqual((value["httpStatus"], value["upstreamCode"]), (status, category))
                self.assertEqual(value["lastEvent"], "result")
                self.assertNotIn("secret", json.dumps(value))
                self.assertNotIn("Bearer", json.dumps(value))

    def test_captured_session_limit_retains_classification(self):
        proof, epoch = self.identity()
        fixture = HERE.parents[1] / "packages/commercial/src/http/proxy/__fixtures__/box-cli-upstream-refusal/real-session-limit.jsonl"
        raw = fixture.read_text()
        proc = self.run_child(f"import sys;sys.stdout.write({raw!r});sys.exit(1)",
                              proof=proof, epoch=epoch)
        self.assertEqual(proc.returncode, 1)
        value = self.load(proof, epoch)
        self.assertEqual((value["upstreamCode"], value["httpStatus"]), ("rate_limit", None))

    def test_normal_model_and_tool_error_prose_is_not_upstream_evidence(self):
        cases = [
            {"type": "assistant", "error": "rate_limit",
             "message": {"model": "claude-haiku", "content": [{"type": "text", "text": "API Error: 401 secret"}]}},
            {"type": "assistant", "message": {"model": "<synthetic>", "content": [{"type": "text", "text": "API Error: 401 secret"}]}},
            {"type": "assistant", "message": {"model": "claude-haiku"}, "error": {"status": 401, "type": "authentication_error"}},
            {"type": "user", "tool_use_result": {"error": "authentication_failed"}, "status": 401},
        ]
        for event in cases:
            proof, epoch = self.identity()
            proc = self.run_child(f"import sys;print({json.dumps(event)!r});sys.exit(1)",
                                  proof=proof, epoch=epoch)
            self.assertEqual(proc.returncode, 1)
            value = self.load(proof, epoch)
            self.assertEqual((value["httpStatus"], value["upstreamCode"]), (None, "unknown"))

    def test_synthetic_first_cause_survives_shutdown(self):
        proof, epoch = self.identity()
        event = {"type": "assistant", "error": "authentication_failed", "is_api_error_message": True,
                 "message": {"model": "<synthetic>", "content": [{"type": "text", "text": "API Error: 401 Bearer sk-secret"}]}}
        lines = json.dumps(event) + "\n" + json.dumps({"type": "result", "is_error": True, "errors": ["turn ended on an API error"]}) + "\n"
        code = f"import sys,time,signal;signal.signal(signal.SIGTERM,signal.SIG_IGN);sys.stdout.write({lines!r});sys.stdout.flush();time.sleep(30)"
        env = {**os.environ, "OCV5_DIAGNOSTIC_PROOF_DIR": str(proof), "OCV5_DIAGNOSTIC_LEASE_EPOCH": epoch}
        proc = subprocess.Popen([sys.executable, "-I", str(SUPERVISOR), "--deadline", "5",
                                 "--kill-after", ".05", "--max-output", "262144", "--",
                                 sys.executable, "-I", "-c", code], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            # Forwarding proves the supervisor has classified both records.
            received = b""
            while received.count(b"\n") < 2:
                self.assertTrue(select.select([proc.stdout], [], [], 4)[0], "no forwarded CLI events")
                received += os.read(proc.stdout.fileno(), 65536)
            proc.send_signal(signal.SIGTERM)
            out, err = proc.communicate(timeout=8)
            self.assertEqual((proc.returncode, received + out, err), (143, lines.encode(), b""))
            value = self.load(proof, epoch)
            self.assertEqual((value["upstreamCode"], value["httpStatus"]), ("authentication", 401))
            self.assertEqual((value["stage"], value["reason"], value["cliSignal"]), ("shutdown", "interrupted", 9))
            self.assertNotIn("sk-secret", json.dumps(value))
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.communicate(timeout=8)

    def test_child_signal_is_preserved_separately(self):
        proof, epoch = self.identity()
        proc = self.run_child("import os,signal;os.kill(os.getpid(), signal.SIGTERM)", proof=proof, epoch=epoch)
        # Existing supervisor translates sys.exit(-15) to POSIX status 241.
        self.assertEqual(proc.returncode, 241)
        value = self.load(proof, epoch)
        self.assertEqual((value["cliExitCode"], value["cliSignal"], value["reason"]), (-15, 15, "child_exit"))

    def test_unwritable_snapshot_preserves_child_failure_and_removes_temporary(self):
        proof, epoch = self.identity()
        def forbid_file_writes():
            resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
        proc = self.run_child("import sys;print('exit-one');sys.exit(1)", proof=proof, epoch=epoch,
                              preexec_fn=forbid_file_writes)
        self.assertEqual((proc.returncode, proc.stdout, proc.stderr), (1, b"exit-one\n", b""))
        self.assertEqual(list(proof.iterdir()), [])

    def test_preexisting_destination_not_replaced(self):
        proof, epoch = self.identity()
        marker = proof / "failure.diag.json"
        marker.write_text("old")
        proc = self.run_child("import sys;sys.exit(1)", proof=proof, epoch=epoch)
        self.assertEqual(proc.returncode, 1)
        self.assertEqual(marker.read_text(), "old")
        self.assertEqual([p.name for p in proof.iterdir()], ["failure.diag.json"])

    def test_unsafe_directory_and_invalid_epoch_fail_without_diagnostic(self):
        for kind in ("mode", "symlink", "epoch"):
            with self.subTest(kind=kind):
                proof, epoch = self.identity()
                if kind == "mode":
                    proof.chmod(0o755)
                elif kind == "symlink":
                    target, _ = self.identity()
                    proof.rmdir()
                    proof.symlink_to(target)
                else:
                    epoch = "untrusted-secret"
                proc = self.run_child("import sys;sys.exit(7)", proof=proof, epoch=epoch)
                self.assertEqual((proc.returncode, proc.stderr), (7, b""))
                self.assertFalse((proof / "failure.diag.json").exists())

    def test_keeper_actual_identity_and_terminal_proof_unchanged(self):
        proof, epoch = self.identity(create=False)
        injected, injected_epoch = self.identity()
        proc = self.run_child('import sys;sys.stderr.write("API Error: 401 secret\\n");sys.exit(1)',
                              proof=proof, epoch=epoch, keeper=True,
                              env={"OCV5_DIAGNOSTIC_PROOF_DIR": str(injected),
                                   "OCV5_DIAGNOSTIC_LEASE_EPOCH": injected_epoch})
        self.assertEqual((proc.returncode, proc.stdout, proc.stderr), (1, b"", b""))
        value = self.load(proof, epoch)
        self.assertEqual(value["upstreamCode"], "authentication")
        terminal = json.loads((proof / "terminal.json").read_text())
        self.assertEqual(set(terminal), {"runNonce", "leaseEpoch", "keeperPid", "cliPid", "reason",
                                        "revision", "workerExitCode"})
        self.assertEqual((terminal["revision"], terminal["reason"], terminal["workerExitCode"]), (2, "worker_failed", 1))
        self.assertEqual((terminal["runNonce"], terminal["leaseEpoch"]), (proof.name[-24:], epoch))
        self.assertFalse(Path(f'/proc/{terminal["cliPid"]}').exists())
        self.assertEqual(list(injected.iterdir()), [])

    def test_keeper_without_proof_removes_injected_identity(self):
        injected, epoch = self.identity()
        proc = self.run_child("import sys;sys.exit(1)", keeper=True,
                              env={"OCV5_DIAGNOSTIC_PROOF_DIR": str(injected),
                                   "OCV5_DIAGNOSTIC_LEASE_EPOCH": epoch})
        self.assertEqual(proc.returncode, 1)
        self.assertEqual(list(injected.iterdir()), [])


    def test_setup_failure_does_not_change_exit_or_run_child(self):
        proof, epoch = self.identity()
        proc = self.run_child('print("must-not-run")',
                              options=("--stdin-file", "/nonexistent", "--stdin-sha256", "0"*64),
                              proof=proof, epoch=epoch)
        self.assertEqual((proc.returncode, proc.stdout, proc.stderr), (126, b"", b""))
        value = self.load(proof, epoch)
        self.assertEqual((value["stage"], value["reason"], value["cliExitCode"]),
                         ("setup", "internal_error", None))

    def test_delivery_timeout_and_interrupt_preserve_status(self):
        for stop in (False, True):
            with self.subTest(stop=stop):
                proof, epoch = self.identity()
                env = {k: v for k, v in os.environ.items()
                       if not k.startswith(("OCV5_DIAGNOSTIC_", "OCV5_KEEPER_", "OCV5_SUPERVISOR_"))}
                env.update(OCV5_DIAGNOSTIC_PROOF_DIR=str(proof), OCV5_DIAGNOSTIC_LEASE_EPOCH=epoch)
                proc = subprocess.Popen([sys.executable, "-I", str(SUPERVISOR),
                    "--deadline", "2" if stop else ".6", "--kill-after", ".05",
                    "--", sys.executable, "-I", "-c",
                    'import sys,time;sys.stdout.write("x"*200000);sys.stdout.flush();time.sleep(30)'],
                    env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, pipesize=4096)
                try:
                    self.assertTrue(select.select([proc.stdout], [], [], 2)[0])
                    if stop:
                        proc.terminate()
                    proc.wait(timeout=4)
                    output, err = proc.communicate(timeout=1)
                    self.assertEqual(proc.returncode, 143 if stop else 124)
                    self.assertEqual(err, b"")
                    self.assertLess(len(output), 200000)
                    value = self.load(proof, epoch)
                    self.assertEqual(value["reason"], "interrupted" if stop else "delivery_timeout")
                    self.assertEqual(value["stage"], "publish")
                finally:
                    if proc.poll() is None:
                        proc.kill()
                    proc.communicate(timeout=3)

    def test_keeper_publishes_proof_even_when_diagnostic_publish_fails(self):
        proof, epoch = self.identity(create=False)
        code = f'import os,sys;os.mkdir({str(proof / "failure.diag.json")!r});sys.exit(1)'
        proc = self.run_child(code, proof=proof, epoch=epoch, keeper=True)
        self.assertEqual((proc.returncode, proc.stderr), (1, b""))
        terminal = json.loads((proof / "terminal.json").read_text())
        self.assertEqual((terminal["reason"], terminal["workerExitCode"]), ("worker_failed", 1))
        self.assertTrue((proof / "failure.diag.json").is_dir())
        self.assertFalse(any(x.name.endswith(".tmp") for x in proof.iterdir()))

    def test_staged_assets_fit_existing_wire_limit(self):
        self.assertLess(len(SUPERVISOR.read_bytes()), 32768)
        self.assertLess(len(KEEPER.read_bytes()), 32768)


if __name__ == "__main__":
    unittest.main()
