#!/usr/bin/env python3
"""Comprehensive unit & integration test suite for Slice 2 (`scripts/agent-remote/core` & `drivers`).

Tests real subprocesses, real AF_UNIX sockets, durable fsync WAL files, and both green + red
fault-injection controls for `cc` and `codex`.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from typing import Any, Dict, List

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from core import guard, resources  # noqa: E402
from core.canonical import (  # noqa: E402
    GENESIS_RAW_EVIDENCE_DIGEST,
    GOLDEN_VECTORS,
    advance_raw_evidence_digest,
    compute_raw_evidence_digest,
    remote_canonical_json,
    remote_canonical_sha256,
    strict_json,
)
from core.contract import (  # noqa: E402
    compute_core_digest,
    file_sha256,
    load_driver,
    validate_decode_batch,
    validate_encode_batch,
    validate_launch_spec,
    validate_security_payload,
)
from core.mcp_socket import run_socket_bridge  # noqa: E402


SAMPLE_TOOLS = {
    "tools": [
        {
            "name": "t0",
            "description": "Write sentinel in container",
            "inputSchema": {
                "type": "object",
                "properties": {"token": {"type": "string"}},
                "required": ["token"],
            },
        }
    ]
}


def write_executable(path: Path, code: str) -> Path:
    path.write_text(code, encoding="utf-8")
    path.chmod(0o755)
    return path


def make_cc_cli_fixture(dir_path: Path) -> Path:
    return write_executable(
        dir_path / "fake-claude",
        r"""#!/usr/bin/env python3
import json, os, pathlib, subprocess, sys

args = sys.argv[1:]
if "-p" in args:
    # Probe mode: read control_request initialize and reply with live models + account metadata.
    for raw in sys.stdin:
        msg = json.loads(raw)
        if msg.get("type") == "control_request" and msg.get("request", {}).get("subtype") == "initialize":
            out = {
                "type": "control_response",
                "response": {
                    "subtype": "success",
                    "request_id": msg["request_id"],
                    "response": {
                        "claude_code_version": "2.1.316",
                        "account": {"email": "alice@example.com", "subscriptionType": "max"},
                        "models": [
                            {
                                "value": "claude-sonnet-4-6",
                                "displayName": "Sonnet 4.6",
                                "supportedEffortLevels": ["low", "medium", "high"],
                                "supportsAdaptiveThinking": True,
                            }
                        ],
                    },
                },
            }
            sys.stdout.write(json.dumps(out, separators=(",", ":")) + "\n")
            sys.stdout.flush()
            sys.exit(0)
    sys.exit(1)

def arg_val(flag, default=""):
    return args[args.index(flag) + 1] if flag in args else default

model = arg_val("--model", "claude-sonnet-4-6")
session_id = arg_val("--session-id") or arg_val("--resume")
tools_flag = arg_val("--tools", "")
mcp_cfg_path = arg_val("--mcp-config")
mcp_cfg = json.loads(pathlib.Path(mcp_cfg_path).read_text())
oc_srv = mcp_cfg["mcpServers"]["ocbridge"]

exposed_tools = ["mcp__ocbridge__t0"]
if tools_flag:
    exposed_tools.extend([t for t in tools_flag.split(",") if t])

sys.stdout.write(json.dumps({
    "type": "system",
    "subtype": "init",
    "session_id": session_id,
    "model": model,
    "tools": exposed_tools,
}, separators=(",", ":")) + "\n")
sys.stdout.flush()

for raw in sys.stdin:
    if not raw.strip():
        continue
    msg = json.loads(raw)
    if msg.get("type") == "user":
        text = msg["message"]["content"][0]["text"]
        call_id = "toolu_01TestCallCc"
        tool_args = {"token": text}
        # 1. Emit native observation on stdout FIRST.
        sys.stdout.write(json.dumps({
            "type": "assistant",
            "session_id": session_id,
            "message": {
                "model": model,
                "role": "assistant",
                "content": [{"type": "tool_use", "id": call_id, "name": "mcp__ocbridge__t0", "input": tool_args}],
            },
        }, separators=(",", ":")) + "\n")
        sys.stdout.flush()

        # 2. Invoke fixed MCP stdio server for `ocbridge`.
        mcp_proc = subprocess.Popen(
            [oc_srv["command"], *oc_srv["args"]],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        mcp_req = {
            "jsonrpc": "2.0",
            "id": 11,
            "method": "tools/call",
            "params": {
                "name": "t0",
                "arguments": tool_args,
                "_meta": {"claudecode/toolUseId": call_id},
            },
        }
        mcp_out, _ = mcp_proc.communicate(json.dumps(mcp_req) + "\n", timeout=10)
        mcp_reply = json.loads(mcp_out.splitlines()[0])
        tool_text = mcp_reply.get("result", {}).get("content", [{}])[0].get("text", "ERR")

        sys.stdout.write(json.dumps({
            "type": "stream_event",
            "session_id": session_id,
            "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": f"cc:{tool_text}"}},
        }, separators=(",", ":")) + "\n")
        sys.stdout.write(json.dumps({
            "type": "result",
            "subtype": "success",
            "is_error": False,
            "session_id": session_id,
            "uuid": "res-cc-0001",
            "usage": {
                "input_tokens": 120,
                "output_tokens": 45,
                "cache_read_input_tokens": 30,
                "cache_creation_input_tokens": 10,
            },
        }, separators=(",", ":")) + "\n")
        sys.stdout.flush()
""",
    )


def make_codex_cli_fixture(dir_path: Path) -> Path:
    return write_executable(
        dir_path / "fake-codex",
        r"""#!/usr/bin/env python3
import json, pathlib, re, subprocess, sys

args = sys.argv[1:]
mcp_cmd = "/usr/bin/python3"
mcp_args = []
for i, a in enumerate(args):
    if a == "-c" and i + 1 < len(args):
        val = args[i + 1]
        if val.startswith("mcp_servers.ocbridge.args="):
            mcp_args = json.loads(val.split("=", 1)[1])

thread_id = "thr_codex_0001"
turn_seq = 0

for raw in sys.stdin:
    if not raw.strip():
        continue
    msg = json.loads(raw)
    rid = msg.get("id")
    method = msg.get("method")
    params = msg.get("params") or {}

    if method == "initialize":
        sys.stdout.write(json.dumps({"id": rid, "result": {"userAgent": "codex-cli/0.167.0"}}, separators=(",", ":")) + "\n")
        sys.stdout.flush()
    elif method == "account/read":
        sys.stdout.write(json.dumps({
            "id": rid,
            "result": {"account": {"email": "bob@example.com", "planType": "pro"}},
        }, separators=(",", ":")) + "\n")
        sys.stdout.flush()
    elif method == "model/list":
        cursor = params.get("cursor")
        if cursor is None:
            res = {
                "data": [{
                    "id": "gpt-5.4",
                    "displayName": "GPT 5.4",
                    "supportedReasoningEfforts": [{"reasoningEffort": "medium"}, {"reasoningEffort": "high"}],
                    "defaultReasoningEffort": "medium",
                    "inputModalities": ["text", "image"],
                }],
                "nextCursor": "page-2",
            }
        else:
            res = {
                "data": [{
                    "id": "gpt-5.4-mini",
                    "displayName": "GPT 5.4 Mini",
                    "supportedReasoningEfforts": [{"reasoningEffort": "low"}, {"reasoningEffort": "medium"}],
                    "defaultReasoningEffort": "low",
                    "inputModalities": ["text"],
                }],
                "nextCursor": None,
            }
        sys.stdout.write(json.dumps({"id": rid, "result": res}, separators=(",", ":")) + "\n")
        sys.stdout.flush()
    elif method in ("thread/start", "thread/resume"):
        tid = params.get("threadId") or thread_id
        thread_id = tid
        sys.stdout.write(json.dumps({
            "id": rid,
            "result": {"thread": {"id": tid}, "model": params.get("model", "gpt-5.4")},
        }, separators=(",", ":")) + "\n")
        sys.stdout.flush()
    elif method == "turn/start":
        turn_seq += 1
        turn_id = f"turn_codex_{turn_seq}"
        prompt = params["input"][0]["text"]
        sys.stdout.write(json.dumps({"id": rid, "result": {"turn": {"id": turn_id}}}, separators=(",", ":")) + "\n")
        sys.stdout.write(json.dumps({"method": "turn/started", "params": {"threadId": thread_id, "turn": {"id": turn_id}}}, separators=(",", ":")) + "\n")

        call_id = f"call_codex_{turn_seq}"
        tool_args = {"token": prompt}
        sys.stdout.write(json.dumps({
            "method": "item/started",
            "params": {
                "threadId": thread_id,
                "turnId": turn_id,
                "item": {"type": "mcpToolCall", "id": call_id, "server": "ocbridge", "tool": "t0", "arguments": tool_args},
            },
        }, separators=(",", ":")) + "\n")
        sys.stdout.flush()

        mcp_proc = subprocess.Popen(
            [mcp_cmd, *mcp_args],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        mcp_req = {
            "jsonrpc": "2.0",
            "id": 21,
            "method": "tools/call",
            "params": {
                "name": "t0",
                "arguments": tool_args,
                "_meta": {
                    "callId": call_id,
                    "threadId": thread_id,
                    "x-codex-turn-metadata": {"turn_id": turn_id},
                },
            },
        }
        mcp_out, _ = mcp_proc.communicate(json.dumps(mcp_req) + "\n", timeout=10)
        mcp_reply = json.loads(mcp_out.splitlines()[0])
        tool_text = mcp_reply.get("result", {}).get("content", [{}])[0].get("text", "ERR")

        sys.stdout.write(json.dumps({
            "method": "item/completed",
            "params": {
                "threadId": thread_id,
                "turnId": turn_id,
                "item": {"type": "mcpToolCall", "id": call_id, "server": "ocbridge", "tool": "t0", "arguments": tool_args},
            },
        }, separators=(",", ":")) + "\n")
        sys.stdout.write(json.dumps({
            "method": "item/agentMessage/delta",
            "params": {"delta": f"codex:{tool_text}"},
        }, separators=(",", ":")) + "\n")
        sys.stdout.write(json.dumps({
            "method": "thread/tokenUsage/updated",
            "params": {
                "threadId": thread_id,
                "turnId": turn_id,
                "tokenUsage": {
                    "total": {
                        "totalTokens": 250,
                        "inputTokens": 200,
                        "cachedInputTokens": 50,
                        "outputTokens": 50,
                        "reasoningOutputTokens": 15,
                    }
                },
            },
        }, separators=(",", ":")) + "\n")
        sys.stdout.write(json.dumps({
            "method": "turn/completed",
            "params": {"threadId": thread_id, "turn": {"id": turn_id, "status": "completed"}},
        }, separators=(",", ":")) + "\n")
        sys.stdout.flush()
""",
    )


class RemoteDriverCoreTests(unittest.TestCase):
    def test_01_canonical_golden_vectors_and_raw_chain_parity(self) -> None:
        for vec in GOLDEN_VECTORS:
            self.assertEqual(remote_canonical_json(vec["value"]), vec["canonical"], vec["name"])
            self.assertEqual(remote_canonical_sha256(vec["value"]), vec["sha256"], vec["name"])

        samples = [
            {"channel": "native_stdout", "seq": 1, "rawBytes": b'{"type":"init"}\n'},
            {"channel": "fixed_mcp", "seq": 2, "rawBytes": b'{"id":1,"method":"tools/call"}'},
        ]
        digest = compute_raw_evidence_digest(samples)
        # Cross-verify live against `@openclaude/protocol` TypeScript implementation!
        repo_root = SCRIPT_DIR.parents[1]
        ts_out = subprocess.check_output(
            [
                str(repo_root / "node_modules/.bin/tsx"),
                "--input-type=module",
                "-e",
                "import { computeRawEvidenceDigest } from './packages/protocol/src/index.ts';"
                "console.log(computeRawEvidenceDigest(["
                "{ channel: 'native_stdout', seq: 1, rawBytes: '{\"type\":\"init\"}\\n' },"
                "{ channel: 'fixed_mcp', seq: 2, rawBytes: '{\"id\":1,\"method\":\"tools/call\"}' }"
                "]));",
            ],
            cwd=repo_root,
            text=True,
            timeout=15,
        ).strip()
        self.assertEqual(digest, ts_out)

        # Red controls: duplicate JSON keys, NaN, sequence gaps, unsafe integers.
        with self.assertRaisesRegex(ValueError, "REMOTE_STRICT_JSON_DUPLICATE_KEY"):
            strict_json(b'{"a":1,"a":2}')
        with self.assertRaisesRegex(ValueError, "REMOTE_STRICT_JSON_NONFINITE"):
            strict_json(b'{"a":NaN}')
        with self.assertRaisesRegex(ValueError, "REMOTE_CANONICAL_JSON_INVALID"):
            remote_canonical_json({"bad": 2**53})
        with self.assertRaisesRegex(ValueError, "REMOTE_RAW_EVIDENCE_SEQ_GAP"):
            compute_raw_evidence_digest([{"channel": "native_stdout", "seq": 2, "rawBytes": b"x"}])
        self.assertNotEqual(
            advance_raw_evidence_digest(GENESIS_RAW_EVIDENCE_DIGEST, "native_stdout", 1, b"abc"),
            advance_raw_evidence_digest(GENESIS_RAW_EVIDENCE_DIGEST, "native_stdin", 1, b"abc"),
        )

    def test_02_contract_fail_closed_boundaries(self) -> None:
        with self.assertRaisesRegex(ValueError, "REMOTE_DRIVER_NOT_REGISTERED"):
            load_driver("nonexistent_driver")

        with tempfile.TemporaryDirectory(prefix="oc-drvtest-spec-") as tmp:
            root = Path(tmp)
            # Red: shell in launchSpec argv[0] forbidden.
            with self.assertRaisesRegex(ValueError, "REMOTE_LAUNCH_SHELL_FORBIDDEN"):
                validate_launch_spec(
                    {
                        "argv": ["/bin/sh", "-c", "echo hi"],
                        "environment": {"HOME": "/tmp"},
                        "cwd": str(root / "cwd"),
                        "policySha256": "a" * 64,
                        "files": {},
                        "dirs": [],
                    },
                    root,
                )
            # Red: LD_PRELOAD forbidden.
            with self.assertRaisesRegex(ValueError, "REMOTE_LAUNCH_ENV_FORBIDDEN"):
                validate_launch_spec(
                    {
                        "argv": ["/usr/bin/python3", "-V"],
                        "environment": {"LD_PRELOAD": "/tmp/evil.so"},
                        "cwd": str(root / "cwd"),
                        "policySha256": "a" * 64,
                        "files": {},
                        "dirs": [],
                    },
                    root,
                )

        # Red: billing field in usage counters rejected.
        with self.assertRaisesRegex(ValueError, "REMOTE_DRIVER_FORBIDDEN_BILLING_FIELD"):
            validate_security_payload(
                {
                    "kind": "usage",
                    "sampleId": "s1",
                    "scopeId": "t1",
                    "semanticsId": "sem-1",
                    "rawCounters": {"inputTokens": 10, "usdCost": 1},
                },
                "native",
            )

        # Red: security event on fixed_mcp channel rejected.
        with self.assertRaisesRegex(ValueError, "REMOTE_DRIVER_NON_NATIVE_SECURITY_EVENT"):
            validate_decode_batch(
                {
                    "securityEvents": [{"kind": "textDelta", "channel": "answer", "delta": "hi"}],
                    "presentation": [],
                    "controlReplies": [],
                    "nextNativeState": {},
                },
                channel="fixed_mcp",
                raw_frame_bytes=b"{}\n",
                frame_seq=1,
            )

        # Red: resume attempting to trigger a user prompt rejected.
        with self.assertRaisesRegex(ValueError, "REMOTE_DRIVER_UNAUTHORIZED_TURN_TRIGGER"):
            validate_encode_batch(
                {
                    "lines": [json.dumps({"method": "turn/start", "params": {}})],
                    "nextNativeState": {},
                },
                {"kind": "resume", "commandId": "cmd-1"},
            )

    def test_03_driver_worker_stdio_and_forged_hash_override(self) -> None:
        worker = SCRIPT_DIR / "core" / "driver_worker.py"
        proc = subprocess.Popen(
            ["/usr/bin/python3", "-I", "-B", str(worker)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        assert proc.stdin is not None and proc.stdout is not None
        try:
            def rpc(req: Dict[str, Any]) -> Dict[str, Any]:
                proc.stdin.write((json.dumps(req) + "\n").encode("utf-8"))
                proc.stdin.flush()
                return strict_json(proc.stdout.readline())

            cc_info = rpc({"id": 1, "method": "info", "params": {"driverId": "cc"}})
            codex_info = rpc({"id": 2, "method": "info", "params": {"driverId": "codex"}})
            self.assertTrue(cc_info["ok"])
            self.assertTrue(codex_info["ok"])
            self.assertEqual(cc_info["result"]["usagePolicy"]["mode"], "per_turn")
            self.assertEqual(codex_info["result"]["usagePolicy"]["mode"], "cumulative")

            raw_frame = (
                json.dumps(
                    {
                        "type": "assistant",
                        "session_id": "11111111-2222-4333-8444-555555555555",
                        "message": {
                            "model": "claude-sonnet-4-6",
                            "role": "assistant",
                            "content": [
                                {"type": "tool_use", "id": "toolu_abc", "name": "mcp__ocbridge__t0", "input": {"b": 2, "a": 1}}
                            ],
                        },
                    }
                )
                + "\n"
            ).encode("utf-8")
            dec = rpc(
                {
                    "id": 3,
                    "method": "decode",
                    "params": {
                        "driverId": "cc",
                        "channel": "native",
                        "frameSeq": 5,
                        "rawFrameB64": base64.b64encode(raw_frame).decode("ascii"),
                        "nativeState": {"expectedModel": "claude-sonnet-4-6"},
                        "envelope": {
                            "operationId": "op-1",
                            "generation": "1",
                            "profileId": "ebc80fa6-0348-49a3-b1c1-8a08017114d6",
                            "authEpoch": "epoch-1",
                            "authorityTurnId": "turn-auth-1",
                        },
                    },
                }
            )
            self.assertTrue(dec["ok"])
            ev = dec["result"]["securityEvents"][0]
            self.assertEqual(ev["rawFrameRef"]["sha256"], hashlib.sha256(raw_frame).hexdigest())
            self.assertEqual(ev["payload"]["argsHash"], remote_canonical_sha256({"a": 1, "b": 2}))

            # Red control: malformed JSON frame returns ok=false without killing worker.
            bad = rpc(
                {
                    "id": 4,
                    "method": "decode",
                    "params": {"driverId": "cc", "channel": "native", "frameSeq": 1, "rawFrame": "{bad_json\n"},
                }
            )
            self.assertFalse(bad["ok"])
            still_alive = rpc({"id": 5, "method": "usagePolicy", "params": {"driverId": "codex"}})
            self.assertTrue(still_alive["ok"])
        finally:
            proc.stdin.close()
            proc.stdout.close()
            if proc.stderr is not None:
                proc.stderr.close()
            proc.wait(timeout=5)

    def test_04_resources_independent_pool_cap5_drift_and_memory_preserve_old(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp", prefix="oc-drvtest-res-") as tmp:
            res_root = Path(tmp) / "resources"
            fake_sys = Path(tmp) / "fake-systemd"
            old_env = os.environ.copy()
            os.environ["OC_REMOTE_RESOURCE_ROOT"] = str(res_root)
            os.environ["OC_REMOTE_TEST_FAKE_SYSTEMD_DIR"] = str(fake_sys)
            os.environ["OC_REMOTE_NODE_MEMORY_BUDGET"] = str(8192 * 1024 * 1024)
            os.environ["OC_REMOTE_CC_MEMORY_MAX"] = str(4096 * 1024 * 1024)
            os.environ["OC_REMOTE_CODEX_MEMORY_MAX"] = str(4096 * 1024 * 1024)
            os.environ["OC_REMOTE_TEST_MEM_AVAILABLE_BYTES"] = str(8192 * 1024 * 1024)
            try:
                prof_a = "ebc80fa6-0348-49a3-b1c1-8a08017114d6"
                prof_b = "c240b4a0-4d0b-49e8-b5d4-77252377ad88"

                # Admit 5 `cc` lanes on prof_a.
                for idx in range(5):
                    row = resources.admit(
                        f"/tmp/cc-lane-{idx}",
                        "cc",
                        prof_a,
                        {f"oc-cc-app-{idx}.scope": 64 * 1024 * 1024},
                    )
                    self.assertFalse(row["capDrift"])

                # 6th `cc` lane on prof_a MUST be rejected with REMOTE_NODE_PROFILE_CAPACITY_EXHAUSTED.
                with self.assertRaises(resources.ProfileCapacityExhausted) as ctx_cap:
                    resources.admit(
                        "/tmp/cc-lane-5",
                        "cc",
                        prof_a,
                        {"oc-cc-app-5.scope": 64 * 1024 * 1024},
                    )
                self.assertEqual(str(ctx_cap.exception), "REMOTE_NODE_PROFILE_CAPACITY_EXHAUSTED")

                # Independent engine (`codex` on prof_a) AND independent profile (`cc` on prof_b) MUST still succeed!
                codex_row = resources.admit(
                    "/tmp/codex-lane-0",
                    "codex",
                    prof_a,
                    {"oc-codex-app-0.scope": 64 * 1024 * 1024},
                    master_max_lanes=3,
                )
                self.assertTrue(codex_row["capDrift"])
                cc_other_prof = resources.admit(
                    "/tmp/cc-other-0",
                    "cc",
                    prof_b,
                    {"oc-cc-other-0.scope": 64 * 1024 * 1024},
                )
                self.assertEqual(cc_other_prof["profile"], prof_b)

                # Register active scope for codex-lane-0 so we verify active scopes CANNOT be prematurely released!
                cg_dir = Path(tmp) / "cg-codex-0"
                resources.register_fake_scope("oc-codex-app-0.scope", "oc-codex.slice", 64 * 1024 * 1024, os.getpid(), cg_dir)
                with self.assertRaises(RuntimeError):
                    resources.release("/tmp/codex-lane-0")

                # Memory exhaustion: drop MemAvailable to 64 MiB -> new lane rejected, existing codex-lane-0 stays active!
                os.environ["OC_REMOTE_TEST_MEM_AVAILABLE_BYTES"] = str(64 * 1024 * 1024)
                with self.assertRaises(resources.MemoryExhausted) as ctx_mem:
                    resources.admit(
                        "/tmp/codex-lane-1",
                        "codex",
                        prof_a,
                        {"oc-codex-app-1.scope": 64 * 1024 * 1024},
                    )
                self.assertEqual(str(ctx_mem.exception), "REMOTE_NODE_MEMORY_EXHAUSTED")
                self.assertEqual(resources.state("oc-codex-app-0.scope")["ActiveState"], "active")
            finally:
                os.environ.clear()
                os.environ.update(old_env)

    def test_05_mcp_socket_wal_disconnect_replay_and_unknown_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp", prefix="oc-drvtest-sock-") as tmp:
            root = Path(tmp)
            root.chmod(0o700)
            tools_bytes = json.dumps(SAMPLE_TOOLS, separators=(",", ":")).encode("utf-8")
            (root / "tools.json").write_bytes(tools_bytes)
            (root / "tools.json").chmod(0o400)
            cfg = {
                "version": 4,
                "driverId": "codex",
                "engineId": "codex",
                "operationId": "op-wal-1",
                "runId": "run-wal-1",
                "generation": "1",
                "profileId": "c240b4a0-4d0b-49e8-b5d4-77252377ad88",
                "authEpoch": "epoch-wal-1",
                "nativeSessionId": "thr_wal_1",
                "catalogSha256": hashlib.sha256(tools_bytes).hexdigest(),
                "requireNodeObservation": True,
            }
            (root / "client.json").write_text(json.dumps(cfg), encoding="utf-8")
            (root / "client.json").chmod(0o400)
            (root / "observations").mkdir(mode=0o700)
            (root / "tool-attempts").mkdir(mode=0o700)

            r_in, w_in = os.pipe()
            r_out, w_out = os.pipe()
            src = os.fdopen(r_in, "rb", buffering=0)
            snk = os.fdopen(w_out, "wb", buffering=0)
            master_out = os.fdopen(r_out, "rb", buffering=0)
            master_in = os.fdopen(w_in, "wb", buffering=0)

            dispatched_requests: List[Dict[str, Any]] = []

            bridge_rc: List[int] = []

            def bridge_thread() -> None:
                bridge_rc.append(run_socket_bridge(root, src, snk))

            t = threading.Thread(target=bridge_thread, daemon=True)
            t.start()
            try:
                ready = strict_json(master_out.readline())
                self.assertEqual(ready["kind"], "socket-ready")
                mcp_script = SCRIPT_DIR / "core" / "mcp_client.py"

                # Green roundtrip + persist `.result.json`: write matching observation first.
                args_hash = remote_canonical_sha256({"token": "hello"})
                call_id = "call_obs_ok"
                obs_path = root / "observations" / (hashlib.sha256(call_id.encode()).hexdigest() + ".json")
                obs_path.write_text(
                    json.dumps(
                        {
                            "operationId": "op-wal-1",
                            "runId": "run-wal-1",
                            "generation": "1",
                            "nativeSessionId": "thr_wal_1",
                            "nativeTurnId": "turn_1",
                            "callId": call_id,
                            "name": "t0",
                            "argsHash": args_hash,
                        }
                    ),
                    encoding="utf-8",
                )
                obs_path.chmod(0o600)

                def responder() -> None:
                    frame = strict_json(master_out.readline())
                    dispatched_requests.append(frame)
                    req_body = strict_json(base64.b64decode(frame["body"]))
                    wire_reply = {
                        **{k: req_body[k] for k in req_body if k != "arguments"},
                        "ok": True,
                        "result": {"content": [{"type": "text", "text": "sentinel-ok"}], "isError": False},
                    }
                    resp_frame = {
                        "version": 4,
                        "driverId": "codex",
                        "engineId": "codex",
                        "kind": "tool-response",
                        "seq": frame["seq"],
                        "status": 200,
                        "body": base64.b64encode(json.dumps(wire_reply).encode("utf-8")).decode("ascii"),
                    }
                    master_in.write((json.dumps(resp_frame) + "\n").encode("utf-8"))
                    master_in.flush()

                rt = threading.Thread(target=responder, daemon=True)
                rt.start()

                good_req = {
                    "jsonrpc": "2.0",
                    "id": 2,
                    "method": "tools/call",
                    "params": {
                        "name": "t0",
                        "arguments": {"token": "hello"},
                        "_meta": {
                            "callId": call_id,
                            "threadId": "thr_wal_1",
                            "x-codex-turn-metadata": {"turn_id": "turn_1"},
                        },
                    },
                }
                r_good = subprocess.run(
                    ["/usr/bin/python3", "-I", "-B", str(mcp_script), str(root)],
                    input=(json.dumps(good_req) + "\n").encode("utf-8"),
                    capture_output=True,
                    timeout=5,
                )
                rt.join(timeout=3)
                self.assertEqual(r_good.returncode, 0)
                self.assertIn("sentinel-ok", r_good.stdout.decode("utf-8"))
                self.assertEqual(len(dispatched_requests), 1)

                # Replay with `.result.json` already on disk: returns saved result with ZERO new SSH dispatch!
                replay_req = {**good_req, "id": 2}
                r_replay = subprocess.run(
                    ["/usr/bin/python3", "-I", "-B", str(mcp_script), str(root)],
                    input=(json.dumps(replay_req) + "\n").encode("utf-8"),
                    capture_output=True,
                    timeout=5,
                )
                self.assertEqual(r_replay.returncode, 0)
                self.assertIn("sentinel-ok", r_replay.stdout.decode("utf-8"))
                self.assertEqual(len(dispatched_requests), 1)

                # Unknown `.attempt.json` WITHOUT `.result.json`: MUST fail closed with ZERO new SSH dispatch!
                unk_call = "call_unknown_1"
                unk_key = hashlib.sha256(unk_call.encode()).hexdigest()
                unk_obs = root / "observations" / (unk_key + ".json")
                unk_obs.write_text(
                    json.dumps(
                        {
                            "operationId": "op-wal-1",
                            "runId": "run-wal-1",
                            "generation": "1",
                            "nativeSessionId": "thr_wal_1",
                            "nativeTurnId": "turn_1",
                            "callId": unk_call,
                            "name": "t0",
                            "argsHash": args_hash,
                        }
                    ),
                    encoding="utf-8",
                )
                unk_obs.chmod(0o600)
                unk_attempt = root / "tool-attempts" / (unk_key + ".attempt.json")
                unk_attempt.write_text("{}", encoding="utf-8")
                unk_attempt.chmod(0o600)

                unk_req = {
                    "jsonrpc": "2.0",
                    "id": 3,
                    "method": "tools/call",
                    "params": {
                        "name": "t0",
                        "arguments": {"token": "hello"},
                        "_meta": {
                            "callId": unk_call,
                            "threadId": "thr_wal_1",
                            "x-codex-turn-metadata": {"turn_id": "turn_1"},
                        },
                    },
                }
                r_unk = subprocess.run(
                    ["/usr/bin/python3", "-I", "-B", str(mcp_script), str(root)],
                    input=(json.dumps(unk_req) + "\n").encode("utf-8"),
                    capture_output=True,
                    timeout=5,
                )
                self.assertNotEqual(r_unk.returncode, 0)
                self.assertEqual(len(dispatched_requests), 1)
                t.join(timeout=3)
                self.assertEqual(bridge_rc, [1])
            finally:
                master_in.close()
                t.join(timeout=3)
                src.close()
                snk.close()
                master_out.close()

            # Second socket bridge: calling MCP tool WITHOUT native observation on disk must fail-close bridge!
            (root / "MCP-SOCKET.json").unlink(missing_ok=True)
            r2_in, w2_in = os.pipe()
            r2_out, w2_out = os.pipe()
            src2 = os.fdopen(r2_in, "rb", buffering=0)
            snk2 = os.fdopen(w2_out, "wb", buffering=0)
            master2_out = os.fdopen(r2_out, "rb", buffering=0)
            master2_in = os.fdopen(w2_in, "wb", buffering=0)
            bridge2_rc: List[int] = []
            t2 = threading.Thread(target=lambda: bridge2_rc.append(run_socket_bridge(root, src2, snk2)), daemon=True)
            t2.start()
            try:
                ready2 = strict_json(master2_out.readline())
                self.assertEqual(ready2["kind"], "socket-ready")
                unobserved_req = {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "tools/call",
                    "params": {
                        "name": "t0",
                        "arguments": {"token": "unobserved"},
                        "_meta": {
                            "callId": "call_unobs",
                            "threadId": "thr_wal_1",
                            "x-codex-turn-metadata": {"turn_id": "turn_1"},
                        },
                    },
                }
                r_unobs = subprocess.run(
                    ["/usr/bin/python3", "-I", "-B", str(mcp_script), str(root)],
                    input=(json.dumps(unobserved_req) + "\n").encode("utf-8"),
                    capture_output=True,
                    timeout=5,
                )
                self.assertNotEqual(r_unobs.returncode, 0)
                self.assertIn(b"error", r_unobs.stdout)
                t2.join(timeout=3)
                self.assertEqual(bridge2_rc, [1])
            finally:
                master2_in.close()
                t2.join(timeout=3)
                src2.close()
                snk2.close()
                master2_out.close()

    def test_06_ssh_guard_drain_role_enforcement(self) -> None:
        # Test guard command structure & drain role restriction against small root-owned files (`<= 262144` bytes).
        candidate = Path("/etc/os-release").resolve()
        alt = Path("/etc/passwd").resolve()
        if candidate.stat().st_uid == 0 and alt.stat().st_uid == 0:
            c_sha = file_sha256(candidate)
            alt_sha = file_sha256(alt)
            cfg = {
                "rootPrefix": "/home/box/oc-remotedrv-",
                "controllers": [
                    {"path": str(candidate), "sha256": c_sha},
                    {"path": str(alt), "sha256": alt_sha},
                ],
            }
            valid_launch = " ".join(
                guard.quote(x)
                for x in ["/usr/bin/python3", "-I", "-B", str(candidate), "launch", "/home/box/oc-remotedrv-1234567890abcdef"]
            )
            self.assertEqual(guard.verified_argv(valid_launch, cfg)[4], "launch")

            # Old pinned controller (`controllers[1]`) allowed for `stop`, FORBIDDEN for `launch`!
            old_stop = " ".join(
                guard.quote(x)
                for x in ["/usr/bin/python3", "-I", "-B", str(alt), "stop", "/home/box/oc-remotedrv-1234567890abcdef"]
            )
            self.assertEqual(guard.verified_argv(old_stop, cfg)[4], "stop")

            old_launch = " ".join(
                guard.quote(x)
                for x in ["/usr/bin/python3", "-I", "-B", str(alt), "launch", "/home/box/oc-remotedrv-1234567890abcdef"]
            )
            with self.assertRaisesRegex(ValueError, "REMOTE_SSH_COMMAND_REJECTED"):
                guard.verified_argv(old_launch, cfg)

    def _run_full_controller_lifecycle(self, driver_id: str) -> None:
        controller = SCRIPT_DIR / "core" / "controller.py"
        with tempfile.TemporaryDirectory(dir="/tmp", prefix=f"oc-drvtest-{driver_id}-") as sandbox:
            sdir = Path(sandbox)
            res_root = sdir / "resources"
            fake_sys = sdir / "fake-systemd"
            env = {
                **os.environ,
                "OC_REMOTE_RESOURCE_ROOT": str(res_root),
                "OC_REMOTE_TEST_FAKE_SYSTEMD_DIR": str(fake_sys),
                "OC_REMOTE_NODE_MEMORY_BUDGET": str(4096 * 1024 * 1024),
                "OC_REMOTE_TEST_MEM_AVAILABLE_BYTES": str(4096 * 1024 * 1024),
            }

            if driver_id == "cc":
                cli_path = make_cc_cli_fixture(sdir)
                model = "claude-sonnet-4-6"
                profile_id = "ebc80fa6-0348-49a3-b1c1-8a08017114d6"
                probe_ctx = {"cliPath": str(cli_path), "accountHome": str(sdir)}
                driver_ctx: Dict[str, Any] = {
                    "cliPath": str(cli_path),
                    "accountHome": str(sdir),
                    "bridgeMode": "stdio-fixture",
                    "initialSessionUuid": "11111111-2222-4333-8444-555555555555",
                    "systemPrompt": "Test system prompt",
                }
            else:
                cli_path = make_codex_cli_fixture(sdir)
                codex_home = sdir / "codex-home"
                codex_home.mkdir(mode=0o700)
                (codex_home / "auth.json").write_text('{"token":"redacted"}', encoding="utf-8")
                model = "gpt-5.4"
                profile_id = "c240b4a0-4d0b-49e8-b5d4-77252377ad88"
                probe_ctx = {
                    "cliPath": str(cli_path),
                    "nativePath": str(cli_path),
                    "codexHome": str(codex_home),
                    "systemCodexRoot": str(sdir / "empty-etc-codex"),
                }
                driver_ctx = {
                    "cliPath": str(cli_path),
                    "nativePath": str(cli_path),
                    "codexHome": str(codex_home),
                    "systemCodexRoot": str(sdir / "empty-etc-codex"),
                }

            # 1. Execute `probe` role (for codex, exercises 2-page cursor pagination!).
            probe_root = sdir / "run-probe-0001"
            p_probe = subprocess.run(
                ["/usr/bin/python3", "-I", "-B", str(controller), "probe", str(probe_root)],
                input=(json.dumps({"driverId": driver_id, "profileId": profile_id, "context": probe_ctx}) + "\n").encode("utf-8"),
                env=env,
                capture_output=True,
                timeout=15,
            )
            self.assertEqual(p_probe.returncode, 0, p_probe.stderr.decode("utf-8"))
            probe_out = strict_json(p_probe.stdout.splitlines()[0])
            self.assertEqual(probe_out["kind"], "probe-result")
            if driver_id == "codex":
                # Verify both paginated pages (`gpt-5.4` and `gpt-5.4-mini`) were collected!
                model_ids = [m["upstreamModelId"] for m in probe_out["snapshot"]["models"]]
                self.assertEqual(model_ids, ["gpt-5.4", "gpt-5.4-mini"])

            # 2. Execute `provision` role.
            lane_root = sdir / "run-lane-0001"
            manifest = {
                "version": 4,
                "root": str(lane_root),
                "driverId": driver_id,
                "engineId": driver_id,
                "operationId": f"op-{driver_id}-01",
                "runId": f"run-{driver_id}-01",
                "generation": "1",
                "profileId": profile_id,
                "authEpoch": "epoch-01",
                "model": model,
                "driverDigest": probe_out["driverDigest"],
                "coreDigest": probe_out["coreDigest"],
            }
            prov_packet = {
                "manifest": manifest,
                "tools": SAMPLE_TOOLS,
                "driverContext": driver_ctx,
                "verifiedProbe": probe_out["snapshot"],
            }
            p_prov = subprocess.run(
                ["/usr/bin/python3", "-I", "-B", str(controller), "provision", str(lane_root)],
                input=(json.dumps(prov_packet) + "\n").encode("utf-8"),
                env=env,
                capture_output=True,
                timeout=15,
            )
            self.assertEqual(p_prov.returncode, 0, p_prov.stderr.decode("utf-8"))

            # 3. Start `tool-socket` and `launch` concurrently, run full 3-step handshake + real container tool roundtrip!
            sock_proc = subprocess.Popen(
                ["/usr/bin/python3", "-I", "-B", str(controller), "tool-socket", str(lane_root)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=env,
            )
            assert sock_proc.stdout is not None and sock_proc.stdin is not None
            sock_ready = strict_json(sock_proc.stdout.readline())
            self.assertEqual(sock_ready["kind"], "socket-ready")

            def tool_host_responder() -> None:
                line = sock_proc.stdout.readline()
                if not line:
                    return
                frame = strict_json(line)
                req_body = strict_json(base64.b64decode(frame["body"]))
                reply_body = {
                    **{k: req_body[k] for k in req_body if k != "arguments"},
                    "ok": True,
                    "result": {
                        "content": [{"type": "text", "text": f"CONTAINER_EXEC:{req_body['arguments']['token']}"}],
                        "isError": False,
                    },
                }
                resp = {
                    "version": 4,
                    "driverId": driver_id,
                    "engineId": driver_id,
                    "kind": "tool-response",
                    "seq": frame["seq"],
                    "status": 200,
                    "body": base64.b64encode(json.dumps(reply_body).encode("utf-8")).decode("ascii"),
                }
                sock_proc.stdin.write((json.dumps(resp) + "\n").encode("utf-8"))
                sock_proc.stdin.flush()

            th = threading.Thread(target=tool_host_responder, daemon=True)
            th.start()

            app_proc = subprocess.Popen(
                ["/usr/bin/python3", "-I", "-B", str(controller), "launch", str(lane_root)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=env,
            )
            assert app_proc.stdout is not None and app_proc.stdin is not None
            app_ready = strict_json(app_proc.stdout.readline())
            self.assertEqual(app_ready["kind"], "ready")

            drv_mod, _, _ = load_driver(driver_id)
            m_state: Dict[str, Any] = {"expectedModel": model}

            def send_cmd(cmd: Dict[str, Any]) -> List[Dict[str, Any]]:
                nonlocal m_state
                enc = drv_mod.encode(cmd, m_state)
                m_state = enc["nextNativeState"]
                app_proc.stdin.write((json.dumps({"kind": "command", "command": cmd}) + "\n").encode("utf-8"))
                app_proc.stdin.flush()
                return enc["immediateControlReplies"]

            def read_until_reply_or_terminal(target_cmd_id: str | None = None, wait_terminal: bool = False) -> List[Dict[str, Any]]:
                nonlocal m_state
                collected_events: List[Dict[str, Any]] = []
                deadline = time.monotonic() + 10.0
                while time.monotonic() < deadline:
                    raw_out = app_proc.stdout.readline()
                    self.assertTrue(raw_out, "Unexpected EOF on launch stdout")
                    msg = strict_json(raw_out)
                    if msg["kind"] != "stdout":
                        continue
                    raw_native = base64.b64decode(msg["rawB64"])
                    self.assertEqual(hashlib.sha256(raw_native).hexdigest(), msg["frameSha256"])
                    dec = validate_decode_batch(
                        drv_mod.decode("native", raw_native, m_state),
                        channel="native",
                        raw_frame_bytes=raw_native,
                        frame_seq=msg["frameSeq"],
                    )
                    m_state = dec["nextNativeState"]
                    collected_events.extend(dec["securityEvents"])
                    if target_cmd_id and any(r["commandId"] == target_cmd_id and r["ok"] for r in dec["controlReplies"]):
                        return collected_events
                    if wait_terminal and any(e["kind"] == "turnTerminal" for e in collected_events):
                        return collected_events
                self.fail(f"Timed out waiting on {driver_id} stream")

            imm1 = send_cmd({"kind": "initialize", "commandId": "cmd-init", "model": model})
            if not imm1:
                read_until_reply_or_terminal(target_cmd_id="cmd-init")

            imm2 = send_cmd({"kind": "resume", "commandId": "cmd-resume", "nativeSessionId": "new", "model": model})
            if not imm2:
                read_until_reply_or_terminal(target_cmd_id="cmd-resume")

            send_cmd({"kind": "newTurn", "commandId": "cmd-turn-1", "prompt": "PING_SENTINEL", "model": model})
            turn_events = read_until_reply_or_terminal(wait_terminal=True)
            th.join(timeout=5)

            kinds = [e["kind"] for e in turn_events]
            self.assertIn("toolCallObserved", kinds)
            self.assertIn("textDelta", kinds)
            self.assertIn("usage", kinds)
            self.assertIn("turnTerminal", kinds)
            deltas = "".join(e["delta"] for e in turn_events if e["kind"] == "textDelta" and e["channel"] == "answer")
            self.assertIn("CONTAINER_EXEC:PING_SENTINEL", deltas)

            # 4. Close launch stdin and run `stop` -> verify strict stop proof & resource release!
            app_proc.stdin.close()
            app_proc.wait(timeout=10)
            app_proc.stdout.close()
            if app_proc.stderr is not None:
                app_proc.stderr.close()
            sock_proc.stdin.close()
            sock_proc.wait(timeout=10)
            sock_proc.stdout.close()
            if sock_proc.stderr is not None:
                sock_proc.stderr.close()

            p_stop = subprocess.run(
                ["/usr/bin/python3", "-I", "-B", str(controller), "stop", str(lane_root)],
                env=env,
                capture_output=True,
                timeout=10,
            )
            self.assertEqual(p_stop.returncode, 0, p_stop.stderr.decode("utf-8"))
            stop_proof = strict_json(p_stop.stdout.splitlines()[0])
            self.assertTrue(stop_proof["remoteStopped"])
            self.assertEqual(len(list(res_root.glob("*.json"))), 0)

    def test_07_controller_end_to_end_cc_and_codex(self) -> None:
        self._run_full_controller_lifecycle("cc")
        self._run_full_controller_lifecycle("codex")

    def test_08_red_control_cc_native_tool_exposed_fenced_immediately(self) -> None:
        controller = SCRIPT_DIR / "core" / "controller.py"
        with tempfile.TemporaryDirectory(dir="/tmp", prefix="oc-drvtest-ccred-") as sandbox:
            sdir = Path(sandbox)
            res_root = sdir / "resources"
            fake_sys = sdir / "fake-systemd"
            env = {
                **os.environ,
                "OC_REMOTE_RESOURCE_ROOT": str(res_root),
                "OC_REMOTE_TEST_FAKE_SYSTEMD_DIR": str(fake_sys),
                "OC_REMOTE_NODE_MEMORY_BUDGET": str(4096 * 1024 * 1024),
                "OC_REMOTE_TEST_MEM_AVAILABLE_BYTES": str(4096 * 1024 * 1024),
            }
            cli_path = make_cc_cli_fixture(sdir)
            probe_root = sdir / "run-probe-red"
            p_probe = subprocess.run(
                ["/usr/bin/python3", "-I", "-B", str(controller), "probe", str(probe_root)],
                input=(
                    json.dumps(
                        {
                            "driverId": "cc",
                            "profileId": "ebc80fa6-0348-49a3-b1c1-8a08017114d6",
                            "context": {"cliPath": str(cli_path), "accountHome": str(sdir)},
                        }
                    )
                    + "\n"
                ).encode("utf-8"),
                env=env,
                capture_output=True,
                timeout=10,
            )
            probe_out = strict_json(p_probe.stdout.splitlines()[0])
            lane_root = sdir / "run-lane-red"
            prov_packet = {
                "manifest": {
                    "version": 4,
                    "root": str(lane_root),
                    "driverId": "cc",
                    "engineId": "cc",
                    "operationId": "op-cc-red",
                    "runId": "run-cc-red",
                    "generation": "1",
                    "profileId": "ebc80fa6-0348-49a3-b1c1-8a08017114d6",
                    "authEpoch": "epoch-01",
                    "model": "claude-sonnet-4-6",
                    "driverDigest": probe_out["driverDigest"],
                    "coreDigest": probe_out["coreDigest"],
                },
                "tools": SAMPLE_TOOLS,
                "driverContext": {
                    "cliPath": str(cli_path),
                    "accountHome": str(sdir),
                    "bridgeMode": "stdio-fixture",
                    "testFaultAllowNativeTools": ["Bash"],
                },
                "verifiedProbe": probe_out["snapshot"],
            }
            subprocess.run(
                ["/usr/bin/python3", "-I", "-B", str(controller), "provision", str(lane_root)],
                input=(json.dumps(prov_packet) + "\n").encode("utf-8"),
                env=env,
                check=True,
                capture_output=True,
                timeout=10,
            )
            p_launch = subprocess.Popen(
                ["/usr/bin/python3", "-I", "-B", str(controller), "launch", str(lane_root)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=env,
            )
            assert p_launch.stdin is not None and p_launch.stdout is not None and p_launch.stderr is not None
            try:
                out_lines: List[bytes] = []
                deadline = time.monotonic() + 8.0
                while time.monotonic() < deadline:
                    line = p_launch.stdout.readline()
                    if not line:
                        break
                    out_lines.append(line)
                    if b"REMOTE_DISALLOWED_ITEM" in line:
                        break
                rc = p_launch.wait(timeout=8)
                joined = b"".join(out_lines)
                self.assertNotEqual(rc, 0)
                self.assertIn(b"REMOTE_DISALLOWED_ITEM", joined)
                self.assertTrue((lane_root / "STOPPING.json").exists())
            finally:
                p_launch.stdin.close()
                p_launch.stdout.close()
                p_launch.stderr.close()

    def test_09_remote_driver_survey_cli(self) -> None:
        survey_script = SCRIPT_DIR / "remote-driver-survey.py"
        with tempfile.TemporaryDirectory(dir="/tmp", prefix="oc-drvtest-survey-") as sandbox:
            sdir = Path(sandbox)
            cc_cli = make_cc_cli_fixture(sdir)
            codex_cli = make_codex_cli_fixture(sdir)
            codex_home = sdir / "codex-home"
            codex_home.mkdir(mode=0o700)
            (codex_home / "auth.json").write_text("{}", encoding="utf-8")

            r_cc = subprocess.run(
                [
                    "/usr/bin/python3",
                    "-I",
                    "-B",
                    str(survey_script),
                    "--driver",
                    "cc",
                    "--cli-path",
                    str(cc_cli),
                    "--account-home",
                    str(sdir),
                ],
                capture_output=True,
                timeout=15,
            )
            self.assertEqual(r_cc.returncode, 0, r_cc.stderr.decode("utf-8"))
            cc_rep = strict_json(r_cc.stdout)["drivers"]["cc"]
            self.assertEqual(cc_rep["workerIpc"]["status"], "PASS")
            self.assertEqual(cc_rep["mcpCorrelation"]["status"], "PASS")
            self.assertEqual(cc_rep["probe"]["status"], "PASS")

            # Also verify Codex single-page local survey with stub CLI without pagination cursor.
            codex_single = write_executable(
                sdir / "fake-codex-single",
                codex_cli.read_text(encoding="utf-8").replace('"nextCursor": "page-2"', '"nextCursor": None'),
            )
            r_cx = subprocess.run(
                [
                    "/usr/bin/python3",
                    "-I",
                    "-B",
                    str(survey_script),
                    "--driver",
                    "codex",
                    "--cli-path",
                    str(codex_single),
                    "--codex-home",
                    str(codex_home),
                    "--system-codex-root",
                    str(sdir / "no-etc"),
                ],
                capture_output=True,
                timeout=15,
            )
            self.assertEqual(r_cx.returncode, 0, r_cx.stderr.decode("utf-8"))
            cx_rep = strict_json(r_cx.stdout)["drivers"]["codex"]
            self.assertEqual(cx_rep["workerIpc"]["status"], "PASS")
            self.assertEqual(cx_rep["mcpCorrelation"]["status"], "PASS")
            self.assertEqual(cx_rep["probe"]["status"], "PASS")

    def test_10_audit_hardening_registry_digest_version_and_slice_cap(self) -> None:
        from core.contract import load_registry

        # 1. W1: registryPath override rejected when allow_sandbox_override=False OR outside /tmp/oc-drvtest-
        with tempfile.TemporaryDirectory(dir="/tmp", prefix="oc-drvtest-reg-") as sbox:
            sdir = Path(sbox)
            reg_copy = sdir / "registry.json"
            reg_copy.write_bytes((SCRIPT_DIR / "drivers" / "registry.json").read_bytes())
            os.chmod(reg_copy, 0o600)

            with self.assertRaisesRegex(ValueError, "REMOTE_REGISTRY_OVERRIDE_FORBIDDEN"):
                load_registry(reg_copy, allow_sandbox_override=False)
            loaded_ok = load_registry(reg_copy, allow_sandbox_override=True)
            self.assertIn("cc", loaded_ok)

            # S3: expected_digest verified BEFORE exec(compile(...))!
            bundle_dir = sdir / "bundle"
            (bundle_dir / "drivers").mkdir(parents=True, mode=0o700)
            marker_file = sdir / "must-not-exist"
            poisoned_py = bundle_dir / "drivers" / "poison.py"
            poisoned_py.write_text(
                f"from pathlib import Path\nPath({str(marker_file)!r}).write_text('pwn')\n",
                encoding="utf-8",
            )
            os.chmod(poisoned_py, 0o600)
            bad_reg = bundle_dir / "drivers" / "registry.json"
            reg_obj = json.loads((SCRIPT_DIR / "drivers" / "registry.json").read_text(encoding="utf-8"))
            reg_obj["drivers"]["poison"] = {
                **reg_obj["drivers"]["cc"],
                "driverId": "poison",
                "engineId": "poison",
                "module": "drivers/poison.py",
            }
            bad_reg.write_text(json.dumps(reg_obj), encoding="utf-8")
            os.chmod(bad_reg, 0o600)

            with self.assertRaisesRegex(ValueError, "REMOTE_DRIVER_OR_CORE_DIGEST_MISMATCH"):
                load_driver(
                    "poison",
                    registry_path=bad_reg,
                    base_dir=bundle_dir,
                    expected_digest="0" * 64,
                    allow_sandbox_override=True,
                )
            self.assertFalse(marker_file.exists(), "Poisoned driver module executed before digest check!")

            # W3: codex.probe rejects missing CLI version in userAgent without falling back to '0.167.0'
            codex_mod, _, _ = load_driver("codex")
            codex_home = sdir / "cx-home"
            codex_home.mkdir(mode=0o700)
            (codex_home / "auth.json").write_text("{}", encoding="utf-8")
            stub_cli = sdir / "stub-codex"
            stub_cli.write_bytes(b"stub")
            bad_stdout = [
                json.dumps({"id": 1, "result": {"userAgent": "codex-no-slash"}}),
                json.dumps({"id": 2, "result": {"account": {"email": "ab@example.com", "planType": "plus"}}}),
                json.dumps(
                    {
                        "id": 3,
                        "result": {
                            "data": [
                                {
                                    "id": "gpt-5.4",
                                    "displayName": "GPT 5.4",
                                    "supportedReasoningEfforts": [{"reasoningEffort": "medium"}],
                                    "defaultReasoningEffort": "medium",
                                    "inputModalities": ["text"],
                                }
                            ],
                            "nextCursor": None,
                        },
                    }
                ),
            ]
            with self.assertRaisesRegex(ValueError, "CODEX_PROBE_VERSION_MISSING"):
                codex_mod.probe(
                    {
                        "cliPath": str(stub_cli),
                        "nativePath": str(stub_cli),
                        "codexHome": str(codex_home),
                        "systemCodexRoot": str(sdir / "no-etc"),
                        "probeCwd": str(sdir),
                    },
                    {
                        "returncode": 0,
                        "stdoutLines": bad_stdout,
                        "stdoutSha256": "a" * 64,
                        "artifactHashes": {"cli": "b" * 64, "native": "c" * 64},
                    },
                )

            # Tighten-only master_max_memory_bytes rejects 2nd lane while preserving 1st lane
            res_root = sdir / "res-tight"
            fake_sys = sdir / "fake-sys-tight"
            old_env = dict(os.environ)
            try:
                os.environ["OC_REMOTE_RESOURCE_ROOT"] = str(res_root)
                os.environ["OC_REMOTE_TEST_FAKE_SYSTEMD_DIR"] = str(fake_sys)
                os.environ["OC_REMOTE_NODE_MEMORY_BUDGET"] = str(8192 * 1024 * 1024)
                os.environ["OC_REMOTE_TEST_MEM_AVAILABLE_BYTES"] = str(8192 * 1024 * 1024)
                c = resources.config("codex")
                lane1_scopes = {"oc-codex-l1-app.scope": c["app"], "oc-codex-l1-sock.scope": c["socket"]}
                resources.admit("lane-1", "codex", "default", lane1_scopes)
                tight_cap = c["app"] + c["socket"] + c["headroom"]
                lane2_scopes = {"oc-codex-l2-app.scope": c["app"], "oc-codex-l2-sock.scope": c["socket"]}
                with self.assertRaises(resources.MemoryExhausted) as ctx_mem:
                    resources.admit(
                        "lane-2",
                        "codex",
                        "default",
                        lane2_scopes,
                        master_max_memory_bytes=tight_cap,
                    )
                self.assertEqual(str(ctx_mem.exception), "REMOTE_NODE_MEMORY_EXHAUSTED")
                self.assertEqual(len(resources.records()), 1)
            finally:
                os.environ.clear()
                os.environ.update(old_env)


if __name__ == "__main__":
    unittest.main(verbosity=2)
