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
import hashlib, json, os, pathlib, re, subprocess, sys

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
prompt_path = arg_val("--append-system-prompt-file")
prompt_text = pathlib.Path(prompt_path).read_text(encoding="utf-8") if prompt_path else ""
home_dir = pathlib.Path(os.environ.get("HOME", "/tmp"))
sanitized_cwd = re.sub(r"[^A-Za-z0-9]", "-", os.getcwd())
transcript_file = home_dir / ".claude/projects" / sanitized_cwd / f"{session_id}.jsonl"
if "--resume" in args:
    if not transcript_file.exists():
        sys.stderr.write("CC_FIXTURE_RESUME_TRANSCRIPT_MISSING\n")
        sys.exit(2)
elif "--session-id" in args:
    if transcript_file.exists():
        sys.stderr.write("CC_FIXTURE_SESSION_ID_ALREADY_EXISTS\n")
        sys.exit(2)
    transcript_file.parent.mkdir(parents=True, exist_ok=True)
    transcript_file.write_text(json.dumps({"sessionId": session_id}) + "\n", encoding="utf-8")

launches_log = pathlib.Path(__file__).resolve().parent / "cc-launches.jsonl"
with launches_log.open("a", encoding="utf-8") as lf:
    lf.write(json.dumps({"args": args, "sessionId": session_id, "prompt": prompt_text}) + "\n")

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
        call_id = "toolu_" + hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]
        res_id = "res-cc-" + hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]
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
            "uuid": res_id,
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
import hashlib, json, pathlib, re, subprocess, sys

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
        rpcs_log = pathlib.Path(__file__).resolve().parent / "codex-rpcs.jsonl"
        with rpcs_log.open("a", encoding="utf-8") as rf:
            rf.write(json.dumps({
                "method": method,
                "threadId": tid,
                "baseInstructions": params.get("baseInstructions"),
            }) + "\n")
        sys.stdout.write(json.dumps({
            "id": rid,
            "result": {"thread": {"id": tid}, "model": params.get("model", "gpt-5.4")},
        }, separators=(",", ":")) + "\n")
        sys.stdout.flush()
    elif method == "turn/start":
        turn_seq += 1
        prompt = params["input"][0]["text"]
        ph = hashlib.sha256(prompt.encode("utf-8")).hexdigest()[:12]
        turn_id = f"turn_codex_{ph}"
        sys.stdout.write(json.dumps({"id": rid, "result": {"turn": {"id": turn_id}}}, separators=(",", ":")) + "\n")
        sys.stdout.write(json.dumps({"method": "turn/started", "params": {"threadId": thread_id, "turn": {"id": turn_id}}}, separators=(",", ":")) + "\n")

        call_id = f"call_codex_{ph}"
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
            _, _, codex_digest = load_driver("codex")
            cfg = {
                "version": 4,
                "driverId": "codex",
                "engineId": "codex",
                "driverDigest": codex_digest,
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

            # Warm app recycle roles (`recycle-app`, `reprovision-app`) allowed on `controllers[0]`, FORBIDDEN on `controllers[1]`!
            for warm_role in ("recycle-app", "reprovision-app"):
                cur_cmd = " ".join(
                    guard.quote(x)
                    for x in ["/usr/bin/python3", "-I", "-B", str(candidate), warm_role, "/home/box/oc-remotedrv-1234567890abcdef"]
                )
                self.assertEqual(guard.verified_argv(cur_cmd, cfg)[4], warm_role)

                old_cmd = " ".join(
                    guard.quote(x)
                    for x in ["/usr/bin/python3", "-I", "-B", str(alt), warm_role, "/home/box/oc-remotedrv-1234567890abcdef"]
                )
                with self.assertRaisesRegex(ValueError, "REMOTE_SSH_COMMAND_REJECTED"):
                    guard.verified_argv(old_cmd, cfg)

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

                # C1/R7 fault-injection fence: test_fault_bypass_admit rejected outside /tmp/oc-drvtest-!
                with self.assertRaisesRegex(RuntimeError, "REMOTE_FAULT_INJECTION_SANDBOX_ONLY"):
                    resources.admit(
                        "/home/box/oc-remotedrv-prod",
                        "codex",
                        "default",
                        lane2_scopes,
                        master_max_memory_bytes=tight_cap,
                        allow_sandbox_override=False,
                        test_fault_bypass_admit=True,
                    )
                # W3 (Round 2): cc.probe rejects missing claude_code_version even if context.cliVersion is supplied
                cc_mod, _, _ = load_driver("cc")
                with self.assertRaisesRegex(ValueError, "CC_PROBE_VERSION_MISSING"):
                    cc_mod.probe(
                        {
                            "cliPath": str(stub_cli),
                            "accountHome": str(sdir),
                            "cliVersion": "9.9.9-forged",
                        },
                        {
                            "returncode": 0,
                            "stdoutLines": [
                                json.dumps(
                                    {
                                        "type": "control_response",
                                        "response": {
                                            "subtype": "success",
                                            "request_id": "probe-init-1",
                                            "response": {
                                                "account": {"email": "a@b.com", "subscriptionType": "max"},
                                                "models": [{"value": "haiku", "displayName": "Haiku"}],
                                            },
                                        },
                                    }
                                )
                            ],
                            "stdoutSha256": "d" * 64,
                            "artifactHashes": {"cli": "e" * 64},
                        },
                    )
                # Codex 0.167 turn/start effort notification (`thread/settings/updated`) + command/exec disallowed
                codex_mod, _, _ = load_driver("codex")
                cdx_state = {"initialized": True, "sessionId": "thr_01", "expectedModel": "gpt-6-luna"}
                for benign_method in (
                    "thread/settings/updated",
                    "model/safetyBuffering/updated",
                    "item/autoApprovalReview/started",
                ):
                    b_out = codex_mod.decode(
                        "native",
                        (json.dumps({"method": benign_method, "params": {"threadId": "thr_01"}}) + "\n").encode(),
                        dict(cdx_state),
                    )
                    self.assertEqual(b_out["securityEvents"], [])
                dis_out = codex_mod.decode(
                    "native",
                    b'{"method":"command/exec/outputDelta","params":{"delta":"ls"}}\n',
                    dict(cdx_state),
                )
                self.assertEqual(dis_out["securityEvents"][0]["kind"], "disallowedItem")
                with self.assertRaisesRegex(ValueError, "CODEX_UNKNOWN_NOTIFICATION:totally/unknown/v99"):
                    codex_mod.decode("native", b'{"method":"totally/unknown/v99","params":{}}\n', dict(cdx_state))

                # CC multi-turn model pinning (init alias + concrete snapshot) + fallback/drift rejection + benign system frames
                cc_sess = "11111111-2222-4333-8444-555555555555"
                cc_state: Dict[str, Any] = {"expectedModel": "claude-opus-5-5", "sessionId": cc_sess}
                cc_state = cc_mod.decode(
                    "native",
                    (json.dumps({"type": "system", "subtype": "init", "session_id": cc_sess, "model": "claude-opus-5-5", "tools": ["mcp__ocbridge__Write"]}) + "\n").encode(),
                    cc_state,
                )["nextNativeState"]
                self.assertEqual(cc_state.get("observedModel"), "claude-opus-5-5")
                self.assertIsNone(cc_state.get("resolvedConcreteModel"))
                cc_state = cc_mod.decode(
                    "native",
                    (json.dumps({"type": "stream_event", "session_id": cc_sess, "event": {"type": "message_start", "message": {"model": "claude-opus-5-5-20260701"}}}) + "\n").encode(),
                    cc_state,
                )["nextNativeState"]
                self.assertEqual(cc_state.get("resolvedConcreteModel"), "claude-opus-5-5-20260701")
                self.assertEqual(cc_state.get("observedModel"), "claude-opus-5-5-20260701")
                # Turn 2 init repeats alias `claude-opus-5-5`, then `message_start` repeats `claude-opus-5-5-20260701`
                cc_state = cc_mod.decode(
                    "native",
                    (json.dumps({"type": "system", "subtype": "init", "session_id": cc_sess, "model": "claude-opus-5-5", "tools": ["mcp__ocbridge__Write"]}) + "\n").encode(),
                    cc_state,
                )["nextNativeState"]
                self.assertEqual(cc_state.get("resolvedConcreteModel"), "claude-opus-5-5-20260701")
                self.assertEqual(cc_state.get("observedModel"), "claude-opus-5-5-20260701")
                cc_state = cc_mod.decode(
                    "native",
                    (json.dumps({"type": "assistant", "session_id": cc_sess, "message": {"model": "claude-opus-5-5-20260701", "content": "DONE"}}) + "\n").encode(),
                    cc_state,
                )["nextNativeState"]
                for sys_sub in ("informational", "api_retry", "status", "turn_duration", "local_command"):
                    sys_dec = cc_mod.decode(
                        "native",
                        (json.dumps({"type": "system", "subtype": sys_sub, "session_id": cc_sess}) + "\n").encode(),
                        dict(cc_state),
                    )
                    self.assertEqual(sys_dec["securityEvents"], [])
                with self.assertRaisesRegex(ValueError, "CC_UPSTREAM_MODEL_MISMATCH"):
                    cc_mod.decode(
                        "native",
                        (json.dumps({"type": "stream_event", "session_id": cc_sess, "event": {"type": "message_start", "message": {"model": "claude-sonnet-4-6"}}}) + "\n").encode(),
                        dict(cc_state),
                    )
                with self.assertRaisesRegex(ValueError, "CC_UPSTREAM_MODEL_MISMATCH"):
                    cc_mod.decode(
                        "native",
                        (json.dumps({"type": "stream_event", "session_id": cc_sess, "event": {"type": "message_start", "message": {"model": "claude-opus-5-5-20990101"}}}) + "\n").encode(),
                        dict(cc_state),
                    )
                with self.assertRaisesRegex(ValueError, "CC_UNKNOWN_NATIVE_FRAME"):
                    cc_mod.decode(
                        "native",
                        (json.dumps({"type": "system", "subtype": "rogue_subtype", "session_id": cc_sess}) + "\n").encode(),
                        dict(cc_state),
                    )
            finally:
                os.environ.clear()
                os.environ.update(old_env)

    def _run_warm_recycle_lifecycle(self, driver_id: str) -> None:
        controller = SCRIPT_DIR / "core" / "controller.py"
        with tempfile.TemporaryDirectory(dir="/tmp", prefix=f"oc-drvtest-rec-{driver_id}-") as sandbox:
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
                probe_ctx: Dict[str, Any] = {"cliPath": str(cli_path), "accountHome": str(sdir)}
                driver_ctx: Dict[str, Any] = {
                    "cliPath": str(cli_path),
                    "accountHome": str(sdir),
                    "bridgeMode": "stdio-fixture",
                    "initialSessionUuid": "11111111-2222-4333-8444-555555555555",
                    "systemPrompt": "PROMPT_ALPHA_SECRET",
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
                driver_ctx = dict(probe_ctx)

            p_probe = subprocess.run(
                ["/usr/bin/python3", "-I", "-B", str(controller), "probe", str(sdir / "run-probe-1")],
                input=(json.dumps({"driverId": driver_id, "profileId": profile_id, "context": probe_ctx}) + "\n").encode("utf-8"),
                env=env,
                capture_output=True,
                timeout=15,
            )
            self.assertEqual(p_probe.returncode, 0, p_probe.stderr.decode("utf-8"))
            probe_out = strict_json(p_probe.stdout.splitlines()[0])

            lane_root = sdir / "run-lane-rec-1"
            manifest = {
                "version": 4,
                "root": str(lane_root),
                "driverId": driver_id,
                "engineId": driver_id,
                "operationId": f"op-rec-{driver_id}-01",
                "runId": f"run-rec-{driver_id}-01",
                "generation": "1",
                "profileId": profile_id,
                "authEpoch": "epoch-01",
                "model": model,
                "driverDigest": probe_out["driverDigest"],
                "coreDigest": probe_out["coreDigest"],
            }
            p_prov = subprocess.run(
                ["/usr/bin/python3", "-I", "-B", str(controller), "provision", str(lane_root)],
                input=(
                    json.dumps(
                        {
                            "manifest": manifest,
                            "tools": SAMPLE_TOOLS,
                            "driverContext": driver_ctx,
                            "verifiedProbe": probe_out["snapshot"],
                        }
                    )
                    + "\n"
                ).encode("utf-8"),
                env=env,
                capture_output=True,
                timeout=15,
            )
            self.assertEqual(p_prov.returncode, 0, p_prov.stderr.decode("utf-8"))

            sock_proc = subprocess.Popen(
                ["/usr/bin/python3", "-I", "-B", str(controller), "tool-socket", str(lane_root)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=env,
            )
            assert sock_proc.stdout is not None and sock_proc.stdin is not None
            self.assertEqual(strict_json(sock_proc.stdout.readline())["kind"], "socket-ready")

            def tool_host_loop() -> None:
                for _ in range(2):
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

            th = threading.Thread(target=tool_host_loop, daemon=True)
            th.start()

            drv_mod, _, _ = load_driver(driver_id)

            def run_app_turn(
                native_sess_arg: str,
                instructions_arg: str,
                user_prompt: str,
            ) -> tuple[subprocess.Popen[bytes], str, List[Dict[str, Any]]]:
                app_p = subprocess.Popen(
                    ["/usr/bin/python3", "-I", "-B", str(controller), "launch", str(lane_root)],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    env=env,
                )
                assert app_p.stdout is not None and app_p.stdin is not None
                self.assertEqual(strict_json(app_p.stdout.readline())["kind"], "ready")
                m_state: Dict[str, Any] = {"expectedModel": model}
                if native_sess_arg != "new":
                    m_state["sessionId"] = native_sess_arg

                resolved_session = native_sess_arg

                def send_c(cmd: Dict[str, Any]) -> List[Dict[str, Any]]:
                    nonlocal m_state, resolved_session
                    enc = drv_mod.encode(cmd, m_state)
                    m_state = enc["nextNativeState"]
                    for rep in enc["immediateControlReplies"]:
                        if rep.get("nativeSessionId"):
                            resolved_session = rep["nativeSessionId"]
                    app_p.stdin.write((json.dumps({"kind": "command", "command": cmd}) + "\n").encode("utf-8"))
                    app_p.stdin.flush()
                    return enc["immediateControlReplies"]

                def read_stream(target_cmd: str | None = None, wait_term: bool = False) -> List[Dict[str, Any]]:
                    nonlocal m_state, resolved_session
                    evs: List[Dict[str, Any]] = []
                    dl = time.monotonic() + 10.0
                    while time.monotonic() < dl:
                        raw_o = app_p.stdout.readline()
                        self.assertTrue(raw_o, "Unexpected EOF on launch stdout")
                        msg = strict_json(raw_o)
                        if msg["kind"] != "stdout":
                            continue
                        raw_nat = base64.b64decode(msg["rawB64"])
                        dec = validate_decode_batch(
                            drv_mod.decode("native", raw_nat, m_state),
                            channel="native",
                            raw_frame_bytes=raw_nat,
                            frame_seq=msg["frameSeq"],
                        )
                        m_state = dec["nextNativeState"]
                        evs.extend(dec["securityEvents"])
                        for rep in dec["controlReplies"]:
                            if rep.get("nativeSessionId"):
                                resolved_session = rep["nativeSessionId"]
                        if target_cmd and any(r["commandId"] == target_cmd and r["ok"] for r in dec["controlReplies"]):
                            return evs
                        if wait_term and any(e["kind"] == "turnTerminal" for e in evs):
                            return evs
                    self.fail("Timed out waiting on app stream")

                imm_i = send_c({"kind": "initialize", "commandId": f"init-{user_prompt}", "model": model, "instructions": instructions_arg})
                if not imm_i:
                    read_stream(target_cmd=f"init-{user_prompt}")
                imm_r = send_c({
                    "kind": "resume",
                    "commandId": f"res-{user_prompt}",
                    "nativeSessionId": native_sess_arg,
                    "model": model,
                    "instructions": instructions_arg,
                })
                if not imm_r:
                    read_stream(target_cmd=f"res-{user_prompt}")
                if m_state.get("sessionId"):
                    resolved_session = m_state["sessionId"]
                send_c({"kind": "newTurn", "commandId": f"turn-{user_prompt}", "prompt": user_prompt, "model": model})
                turn_evs = read_stream(wait_term=True)
                return app_p, resolved_session, turn_evs

            # Turn 1 with `PROMPT_ALPHA_SECRET`
            app1, bound_sess, evs1 = run_app_turn("new", "PROMPT_ALPHA_SECRET", "TURN_ONE")
            self.assertIn("CONTAINER_EXEC:TURN_ONE", "".join(e["delta"] for e in evs1 if e["kind"] == "textDelta"))
            # Simulate host.py writing `run/host.pid` to prove `recycle-app` cleans `run/`!
            (lane_root / "run").mkdir(mode=0o700, exist_ok=True)
            (lane_root / "run" / "host.pid").write_text("12345\n", encoding="utf-8")

            # Execute `recycle-app` while `app1` and `sock_proc` are still open!
            p_rec = subprocess.run(
                ["/usr/bin/python3", "-I", "-B", str(controller), "recycle-app", str(lane_root)],
                env=env,
                capture_output=True,
                timeout=10,
            )
            self.assertEqual(p_rec.returncode, 0, p_rec.stderr.decode("utf-8"))
            rec_proof = strict_json(p_rec.stdout.splitlines()[0])
            self.assertEqual(rec_proof["kind"], "app-recycled")
            self.assertTrue(rec_proof["appStopped"])
            self.assertEqual(len(rec_proof["scopes"]), 1)
            self.assertEqual(rec_proof["scopes"][0]["populated"], 0)
            self.assertFalse((lane_root / "STOPPING.json").exists(), "recycle-app MUST NOT write STOPPING.json")
            self.assertFalse((lane_root / "run").exists(), "recycle-app MUST clean run/ directory")
            self.assertIsNone(sock_proc.poll(), "tool-socket MUST stay alive across recycle-app")
            self.assertEqual(len(list(res_root.glob("*.json"))), 1, "lane resource record MUST stay active")

            app1.stdin.close()
            app1.wait(timeout=5)
            app1.stdout.close()
            if app1.stderr is not None:
                app1.stderr.close()

            # Red control: `reprovision-app` with drifted tool catalog MUST fail closed (rc=126) without mutating LAUNCH.json!
            launch_before_bad = (lane_root / "LAUNCH.json").read_bytes()
            bad_tools = [*SAMPLE_TOOLS, {"name": "extra_drift", "description": "bad", "inputSchema": {"type": "object"}}]
            p_reprov_bad = subprocess.run(
                ["/usr/bin/python3", "-I", "-B", str(controller), "reprovision-app", str(lane_root)],
                input=(
                    json.dumps(
                        {
                            "manifest": manifest,
                            "tools": bad_tools,
                            "driverContext": {**driver_ctx, "systemPrompt": "PROMPT_REVOKED_CLEAN", "nativeSessionId": bound_sess},
                            "verifiedProbe": probe_out["snapshot"],
                        }
                    )
                    + "\n"
                ).encode("utf-8"),
                env=env,
                capture_output=True,
                timeout=10,
            )
            self.assertEqual(p_reprov_bad.returncode, 126)
            self.assertIn(b"REMOTE_NODE_REJECTED_OR_STOP_UNKNOWN", p_reprov_bad.stderr)
            self.assertEqual((lane_root / "LAUNCH.json").read_bytes(), launch_before_bad)

            # Green `reprovision-app` with consent revoked (`PROMPT_REVOKED_CLEAN`, NO `PROMPT_ALPHA_SECRET`)
            p_reprov = subprocess.run(
                ["/usr/bin/python3", "-I", "-B", str(controller), "reprovision-app", str(lane_root)],
                input=(
                    json.dumps(
                        {
                            "manifest": manifest,
                            "tools": SAMPLE_TOOLS,
                            "driverContext": {
                                **driver_ctx,
                                "systemPrompt": "PROMPT_REVOKED_CLEAN",
                                "nativeSessionId": bound_sess,
                                "transcriptExists": True,
                            },
                            "verifiedProbe": probe_out["snapshot"],
                        }
                    )
                    + "\n"
                ).encode("utf-8"),
                env=env,
                capture_output=True,
                timeout=10,
            )
            self.assertEqual(p_reprov.returncode, 0, p_reprov.stderr.decode("utf-8"))
            self.assertEqual(strict_json(p_reprov.stdout.splitlines()[0])["kind"], "reprovisioned")

            # Launch 2 / Turn 2 on the EXACT SAME `bound_sess` and SAME `sock_proc`!
            app2, bound_sess_2, evs2 = run_app_turn(bound_sess, "PROMPT_REVOKED_CLEAN", "TURN_TWO")
            self.assertEqual(bound_sess_2, bound_sess)
            self.assertIn("CONTAINER_EXEC:TURN_TWO", "".join(e["delta"] for e in evs2 if e["kind"] == "textDelta"))
            th.join(timeout=5)

            if driver_id == "cc":
                cc_launches = [
                    json.loads(line)
                    for line in (sdir / "cc-launches.jsonl").read_text(encoding="utf-8").splitlines()
                    if line.strip()
                ]
                self.assertEqual(len(cc_launches), 2)
                self.assertIn("--session-id", cc_launches[0]["args"])
                self.assertEqual(cc_launches[0]["prompt"], "PROMPT_ALPHA_SECRET")
                self.assertIn("--resume", cc_launches[1]["args"])
                self.assertEqual(cc_launches[1]["sessionId"], bound_sess)
                self.assertEqual(cc_launches[1]["prompt"], "PROMPT_REVOKED_CLEAN")
                self.assertNotIn("PROMPT_ALPHA_SECRET", cc_launches[1]["prompt"])
            else:
                codex_rpcs = [
                    json.loads(line)
                    for line in (sdir / "codex-rpcs.jsonl").read_text(encoding="utf-8").splitlines()
                    if line.strip()
                ]
                self.assertEqual(len(codex_rpcs), 2)
                self.assertEqual(codex_rpcs[0]["method"], "thread/start")
                self.assertEqual(codex_rpcs[0]["baseInstructions"], "PROMPT_ALPHA_SECRET")
                self.assertEqual(codex_rpcs[1]["method"], "thread/resume")
                self.assertEqual(codex_rpcs[1]["threadId"], bound_sess)
                self.assertEqual(codex_rpcs[1]["baseInstructions"], "PROMPT_REVOKED_CLEAN")
                self.assertNotIn("PROMPT_ALPHA_SECRET", codex_rpcs[1]["baseInstructions"])

            app2.stdin.close()
            app2.wait(timeout=10)
            app2.stdout.close()
            if app2.stderr is not None:
                app2.stderr.close()
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
            self.assertTrue(strict_json(p_stop.stdout.splitlines()[0])["remoteStopped"])
            self.assertEqual(len(list(res_root.glob("*.json"))), 0)

    def test_11_warm_app_recycle_and_reprovision_cc_and_codex(self) -> None:
        self._run_warm_recycle_lifecycle("cc")
        self._run_warm_recycle_lifecycle("codex")

    def test_12_cc_synthetic_api_error_and_duplicate_result_idempotency(self) -> None:
        import drivers.cc as cc_drv
        from core.contract import validate_decode_batch

        sess_id = "1e03c7fa-494b-575a-aee7-1bd63071ce59"
        env_meta = {
            "operationId": "op-780",
            "generation": "1",
            "profileId": "prof-cc",
            "authEpoch": "epoch-1",
            "authorityTurnId": "turn-780",
            "nativeSessionId": sess_id,
            "driverId": "cc",
            "driverVersion": "1.0.0",
        }
        state: Dict[str, Any] = {"sessionId": sess_id, "expectedModel": "claude-opus-5-5"}

        enc = cc_drv.encode(
            {"kind": "newTurn", "commandId": "cmd-1", "model": "claude-opus-5-5", "prompt": "hello"},
            state,
        )
        state = enc["nextNativeState"]

        # 1) Synthetic non-API-error assistant frame (no is_api_error_message / error) must NOT emit presentation error
        non_err_raw = json.dumps(
            {
                "type": "assistant",
                "session_id": sess_id,
                "message": {
                    "model": "<synthetic>",
                    "content": [{"type": "text", "text": "local command stdout"}],
                },
            }
        ).encode("utf-8")
        b0 = validate_decode_batch(
            cc_drv.decode("native", non_err_raw, state),
            channel="native",
            raw_frame_bytes=non_err_raw,
            frame_seq=1,
            envelope=env_meta,
        )
        self.assertEqual(b0["presentation"], [])
        state = b0["nextNativeState"]

        # 2) Verbatim cc5-att-us synthetic verification_required frame
        portal_msg = (
            "API Error: Your account can't receive replies from Claude right now. "
            "You can find the next step in the Anthropic Verification Portal: "
            "https://portal.anthropic.com/verify?org=6d4224c6-68b1-48ee-964d-0268130d4f10"
        )
        synth_raw = json.dumps(
            {
                "type": "assistant",
                "session_id": sess_id,
                "is_api_error_message": True,
                "message": {
                    "model": "<synthetic>",
                    "content": [{"type": "text", "text": portal_msg}],
                },
            }
        ).encode("utf-8")
        b1 = validate_decode_batch(
            cc_drv.decode("native", synth_raw, state),
            channel="native",
            raw_frame_bytes=synth_raw,
            frame_seq=2,
            envelope=env_meta,
        )
        self.assertEqual(
            b1["presentation"],
            [{"kind": "error", "code": "CC_ACCOUNT_VERIFICATION_REQUIRED", "text": portal_msg}],
        )
        state = b1["nextNativeState"]

        # 3) Result frame + duplicate replay with same uuid must emit identical CC_ACCOUNT_VERIFICATION_REQUIRED
        res_raw = json.dumps(
            {
                "type": "result",
                "subtype": "error_during_execution",
                "is_error": True,
                "result": "",
                "errors": ["turn ended on an API error"],
                "session_id": sess_id,
                "uuid": "ocb-1e03c7fa-mwk0k3pu-1786",
                "usage": {
                    "input_tokens": 0,
                    "output_tokens": 0,
                    "cache_read_input_tokens": 0,
                    "cache_creation_input_tokens": 0,
                },
            }
        ).encode("utf-8")
        b2 = validate_decode_batch(
            cc_drv.decode("native", res_raw, state),
            channel="native",
            raw_frame_bytes=res_raw,
            frame_seq=3,
            envelope=env_meta,
        )
        term1 = [e["payload"] for e in b2["securityEvents"] if e["payload"]["kind"] == "turnTerminal"][0]
        self.assertEqual(term1["errorCode"], "CC_ACCOUNT_VERIFICATION_REQUIRED")
        state = b2["nextNativeState"]
        self.assertNotIn("turnErrorCode", state)
        self.assertNotIn("turnErrorText", state)

        # Duplicate replay of exact same result uuid (immediate)
        b3 = validate_decode_batch(
            cc_drv.decode("native", res_raw, state),
            channel="native",
            raw_frame_bytes=res_raw,
            frame_seq=4,
            envelope=env_meta,
        )
        term2 = [e["payload"] for e in b3["securityEvents"] if e["payload"]["kind"] == "turnTerminal"][0]
        self.assertEqual(term2, term1)
        self.assertEqual(b3["presentation"], [])

        # 4) Execute 127 additional mixed turns (error + success + interrupted) with 128-char maximal IDENT_RE UUIDs
        #    so total unique UUIDs = 128 (Turn 1 is still inside the 128-entry window at index 0!).
        from core.canonical import remote_canonical_bytes
        from core.contract import MAX_NATIVE_STATE_BYTES

        seq_no = 4
        for idx in range(2, 129):
            enc_turn = cc_drv.encode(
                {"kind": "newTurn", "commandId": f"cmd-{idx}", "model": "claude-opus-4-6", "prompt": f"p-{idx}"},
                state,
            )
            state = enc_turn["nextNativeState"]
            prefix = f"t{idx:03d}-"
            max_uuid = prefix + ("x" * (128 - len(prefix)))
            self.assertEqual(len(max_uuid), 128)
            mode = idx % 3
            if mode == 0:
                # Synthetic API error turn (mix verification_required and auth)
                seq_no += 1
                err_txt = portal_msg if idx % 2 == 0 else "API Error: 401 authentication_failed — please run /login"
                s_raw = json.dumps(
                    {
                        "type": "assistant",
                        "session_id": sess_id,
                        "is_api_error_message": True,
                        "message": {"model": "<synthetic>", "content": [{"type": "text", "text": err_txt}]},
                    }
                ).encode("utf-8")
                bs = validate_decode_batch(
                    cc_drv.decode("native", s_raw, state),
                    channel="native",
                    raw_frame_bytes=s_raw,
                    frame_seq=seq_no,
                    envelope=env_meta,
                )
                state = bs["nextNativeState"]
                r_obj = {
                    "type": "result",
                    "subtype": "error_during_execution",
                    "is_error": True,
                    "result": "",
                    "errors": ["turn ended on an API error"],
                    "session_id": sess_id,
                    "uuid": max_uuid,
                    "usage": {
                        "input_tokens": idx,
                        "output_tokens": 0,
                        "cache_read_input_tokens": 0,
                        "cache_creation_input_tokens": 0,
                    },
                }
            elif mode == 1:
                r_obj = {
                    "type": "result",
                    "subtype": "success",
                    "is_error": False,
                    "result": "ok",
                    "session_id": sess_id,
                    "uuid": max_uuid,
                    "usage": {
                        "input_tokens": idx,
                        "output_tokens": 2,
                        "cache_read_input_tokens": 0,
                        "cache_creation_input_tokens": 0,
                    },
                }
            else:
                r_obj = {
                    "type": "result",
                    "subtype": "interrupted",
                    "is_error": False,
                    "terminal_reason": "aborted_streaming",
                    "session_id": sess_id,
                    "uuid": max_uuid,
                    "usage": {
                        "input_tokens": idx,
                        "output_tokens": 1,
                        "cache_read_input_tokens": 0,
                        "cache_creation_input_tokens": 0,
                    },
                }
            seq_no += 1
            r_raw = json.dumps(r_obj).encode("utf-8")
            br = validate_decode_batch(
                cc_drv.decode("native", r_raw, state),
                channel="native",
                raw_frame_bytes=r_raw,
                frame_seq=seq_no,
                envelope=env_meta,
            )
            state = br["nextNativeState"]

            # Replay Turn 1 verbatim across former 16-entry and 64-entry eviction boundaries (at 18, 65, and 128)
            if idx in (18, 65, 128):
                seq_no += 1
                b_rep = validate_decode_batch(
                    cc_drv.decode("native", res_raw, state),
                    channel="native",
                    raw_frame_bytes=res_raw,
                    frame_seq=seq_no,
                    envelope=env_meta,
                )
                rep_term = [e["payload"] for e in b_rep["securityEvents"] if e["payload"]["kind"] == "turnTerminal"][0]
                self.assertEqual(rep_term, term1, f"Turn 1 replay diverged at idx={idx}: {rep_term}")
                self.assertEqual(b_rep["presentation"], [])
                state = b_rep["nextNativeState"]

        self.assertEqual(len(state["seenResultUuids"]), 128)
        self.assertIn("ocb-1e03c7fa-mwk0k3pu-1786", state["seenResultUuids"])
        self.assertIn("ocb-1e03c7fa-mwk0k3pu-1786", state["resultErrorCodes"])

        # 5) Conflicting duplicate result with same uuid + same usage but altered error payload MUST emit CC_RESULT_CONFLICT
        seq_no += 1
        tampered_raw = json.dumps(
            {
                "type": "result",
                "subtype": "error_during_execution",
                "is_error": True,
                "result": "API Error: 429 rate_limit exceeded",
                "errors": ["turn ended on an API error"],
                "session_id": sess_id,
                "uuid": "ocb-1e03c7fa-mwk0k3pu-1786",
                "usage": {
                    "input_tokens": 0,
                    "output_tokens": 0,
                    "cache_read_input_tokens": 0,
                    "cache_creation_input_tokens": 0,
                },
            }
        ).encode("utf-8")
        b_conf = validate_decode_batch(
            cc_drv.decode("native", tampered_raw, state),
            channel="native",
            raw_frame_bytes=tampered_raw,
            frame_seq=seq_no,
            envelope=env_meta,
        )
        conf_term = [e["payload"] for e in b_conf["securityEvents"] if e["payload"]["kind"] == "turnTerminal"][0]
        self.assertEqual(conf_term["errorCode"], "CC_RESULT_CONFLICT")

        # 5b) 17th-element errors[] classification change and >2048-byte tail mutation MUST also emit CC_RESULT_CONFLICT
        enc_17 = cc_drv.encode(
            {"kind": "newTurn", "commandId": "cmd-err17", "model": "claude-opus-4-6", "prompt": "p-err17"},
            state,
        )
        state = enc_17["nextNativeState"]
        seq_no += 1
        long_prefix = "z" * 2400
        err17_first = json.dumps(
            {
                "type": "result",
                "subtype": "error_during_execution",
                "is_error": True,
                "result": "",
                "errors": (["x"] * 16) + ["rate_limit"],
                "session_id": sess_id,
                "uuid": "err17-uuid-check",
                "usage": {
                    "input_tokens": 11,
                    "output_tokens": 0,
                    "cache_read_input_tokens": 0,
                    "cache_creation_input_tokens": 0,
                },
            }
        ).encode("utf-8")
        b_e17_1 = validate_decode_batch(
            cc_drv.decode("native", err17_first, state),
            channel="native",
            raw_frame_bytes=err17_first,
            frame_seq=seq_no,
            envelope=env_meta,
        )
        t_e17_1 = [e["payload"] for e in b_e17_1["securityEvents"] if e["payload"]["kind"] == "turnTerminal"][0]
        self.assertEqual(t_e17_1["errorCode"], "CC_RATE_LIMITED")
        state = b_e17_1["nextNativeState"]

        seq_no += 1
        err17_tampered = json.dumps(
            {
                "type": "result",
                "subtype": "error_during_execution",
                "is_error": True,
                "result": "",
                "errors": (["x"] * 16) + ["authentication_failed"],
                "session_id": sess_id,
                "uuid": "err17-uuid-check",
                "usage": {
                    "input_tokens": 11,
                    "output_tokens": 0,
                    "cache_read_input_tokens": 0,
                    "cache_creation_input_tokens": 0,
                },
            }
        ).encode("utf-8")
        b_e17_2 = validate_decode_batch(
            cc_drv.decode("native", err17_tampered, state),
            channel="native",
            raw_frame_bytes=err17_tampered,
            frame_seq=seq_no,
            envelope=env_meta,
        )
        t_e17_2 = [e["payload"] for e in b_e17_2["securityEvents"] if e["payload"]["kind"] == "turnTerminal"][0]
        self.assertEqual(t_e17_2["errorCode"], "CC_RESULT_CONFLICT")

        # Long result differing past 2048-byte display truncation boundary
        enc_long = cc_drv.encode(
            {"kind": "newTurn", "commandId": "cmd-longtail", "model": "claude-opus-4-6", "prompt": "p-longtail"},
            state,
        )
        state = enc_long["nextNativeState"]
        seq_no += 1
        long_first = json.dumps(
            {
                "type": "result",
                "subtype": "error_during_execution",
                "is_error": True,
                "result": long_prefix + "-tail-A",
                "errors": [],
                "session_id": sess_id,
                "uuid": "longtail-uuid-check",
                "usage": {
                    "input_tokens": 12,
                    "output_tokens": 0,
                    "cache_read_input_tokens": 0,
                    "cache_creation_input_tokens": 0,
                },
            }
        ).encode("utf-8")
        b_lt_1 = validate_decode_batch(
            cc_drv.decode("native", long_first, state),
            channel="native",
            raw_frame_bytes=long_first,
            frame_seq=seq_no,
            envelope=env_meta,
        )
        state = b_lt_1["nextNativeState"]

        seq_no += 1
        long_tampered = json.dumps(
            {
                "type": "result",
                "subtype": "error_during_execution",
                "is_error": True,
                "result": long_prefix + "-tail-B",
                "errors": [],
                "session_id": sess_id,
                "uuid": "longtail-uuid-check",
                "usage": {
                    "input_tokens": 12,
                    "output_tokens": 0,
                    "cache_read_input_tokens": 0,
                    "cache_creation_input_tokens": 0,
                },
            }
        ).encode("utf-8")
        b_lt_2 = validate_decode_batch(
            cc_drv.decode("native", long_tampered, state),
            channel="native",
            raw_frame_bytes=long_tampered,
            frame_seq=seq_no,
            envelope=env_meta,
        )
        t_lt_2 = [e["payload"] for e in b_lt_2["securityEvents"] if e["payload"]["kind"] == "turnTerminal"][0]
        self.assertEqual(t_lt_2["errorCode"], "CC_RESULT_CONFLICT")

        # Note: err17-uuid-check and longtail-uuid-check shifted Turn 1 out of 128 window; re-seed Turn 1 check below on a fresh in-window UUID
        in_window_res_raw = long_first

        # 6) Late duplicate result arriving while a NEW turn is active must NOT clobber activeTurn or turnErrorCode
        enc_active = cc_drv.encode(
            {"kind": "newTurn", "commandId": "cmd-active-129", "model": "claude-opus-4-6", "prompt": "p-129"},
            state,
        )
        active_state = enc_active["nextNativeState"]
        seq_no += 1
        rl_synth = json.dumps(
            {
                "type": "assistant",
                "session_id": sess_id,
                "error": "rate_limit",
                "is_api_error_message": True,
                "message": {"model": "<synthetic>", "content": [{"type": "text", "text": "429 rate limited"}]},
            }
        ).encode("utf-8")
        b_rl = validate_decode_batch(
            cc_drv.decode("native", rl_synth, active_state),
            channel="native",
            raw_frame_bytes=rl_synth,
            frame_seq=seq_no,
            envelope=env_meta,
        )
        active_state = b_rl["nextNativeState"]
        self.assertEqual(active_state.get("activeTurn"), True)
        self.assertEqual(active_state.get("turnErrorCode"), "CC_RATE_LIMITED")

        seq_no += 1
        b_late_dup = validate_decode_batch(
            cc_drv.decode("native", in_window_res_raw, active_state),
            channel="native",
            raw_frame_bytes=in_window_res_raw,
            frame_seq=seq_no,
            envelope=env_meta,
        )
        active_state = b_late_dup["nextNativeState"]
        self.assertEqual(active_state.get("activeTurn"), True)
        self.assertEqual(active_state.get("turnErrorCode"), "CC_RATE_LIMITED")

        # 7) Worst-case canonical native_state byte measurement: all 128 slots = 128-char IDs + 32-hex sigs + actual CJK/emoji turnErrorText
        worst_state = dict(active_state)
        worst_state.pop("turnErrorCode", None)
        worst_state.pop("turnErrorText", None)
        worst_ids = [f"w{k:03d}-" + ("z" * 123) for k in range(128)]
        worst_state["seenResultUuids"] = worst_ids
        worst_state["resultErrorCodes"] = {
            wid: ["f" * 32, "CC_ACCOUNT_VERIFICATION_REQUIRED"] for wid in worst_ids
        }
        cjk_emoji_raw = ("鉴权验证失败🚨请前往控制台确认" * 120)
        seq_no += 1
        cjk_synth = json.dumps(
            {
                "type": "assistant",
                "session_id": sess_id,
                "is_api_error_message": True,
                "message": {"model": "<synthetic>", "content": [{"type": "text", "text": cjk_emoji_raw}]},
            }
        ).encode("utf-8")
        b_worst = validate_decode_batch(
            cc_drv.decode("native", cjk_synth, worst_state),
            channel="native",
            raw_frame_bytes=cjk_synth,
            frame_seq=seq_no,
            envelope=env_meta,
        )
        saved_err_txt = b_worst["nextNativeState"]["turnErrorText"]
        saved_err_utf8_len = len(saved_err_txt.encode("utf-8"))
        self.assertGreaterEqual(saved_err_utf8_len, 2040)
        self.assertLessEqual(saved_err_utf8_len, 2048)
        serialized_len = len(remote_canonical_bytes(b_worst["nextNativeState"]))
        self.assertLess(serialized_len, MAX_NATIVE_STATE_BYTES)

    def test_13_mcp_socket_4mib_mixed_unicode_rss_under_budget(self) -> None:
        from core.canonical import remote_canonical_bytes

        with tempfile.TemporaryDirectory(dir="/tmp", prefix="oc-drvtest-rss-") as tmp:
            root = Path(tmp)
            root.chmod(0o700)
            tools_bytes = json.dumps(SAMPLE_TOOLS, separators=(",", ":")).encode("utf-8")
            (root / "tools.json").write_bytes(tools_bytes)
            (root / "tools.json").chmod(0o400)
            _, _, codex_digest = load_driver("codex")
            cfg = {
                "version": 4,
                "driverId": "codex",
                "engineId": "codex",
                "driverDigest": codex_digest,
                "operationId": "op-rss-1",
                "runId": "run-rss-1",
                "generation": "1",
                "profileId": "c240b4a0-4d0b-49e8-b5d4-77252377ad88",
                "authEpoch": "epoch-rss-1",
                "nativeSessionId": "thr_rss_1",
                "catalogSha256": hashlib.sha256(tools_bytes).hexdigest(),
                "requireNodeObservation": False,
            }
            (root / "client.json").write_text(json.dumps(cfg), encoding="utf-8")
            (root / "client.json").chmod(0o400)
            (root / "observations").mkdir(mode=0o700)
            (root / "tool-attempts").mkdir(mode=0o700)

            socket_script = SCRIPT_DIR / "core" / "mcp_socket.py"
            proc = subprocess.Popen(
                ["/usr/bin/python3", "-I", "-B", str(socket_script), str(root)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            assert proc.stdin is not None and proc.stdout is not None
            try:
                ready = strict_json(proc.stdout.readline())
                self.assertEqual(ready["kind"], "socket-ready")

                mixed_text = ("a" * (4 * 1024 * 1024 - 256)) + "😀"
                small_args = {"token": "ok"}

                def post_roundtrip(call_id: str, args: dict, reply_result: dict) -> dict:
                    args_hash = remote_canonical_sha256(args)
                    wire_req = {
                        "version": 4,
                        "driverId": "codex",
                        "engineId": "codex",
                        "operationId": "op-rss-1",
                        "runId": "run-rss-1",
                        "generation": "1",
                        "profileId": "c240b4a0-4d0b-49e8-b5d4-77252377ad88",
                        "authEpoch": "epoch-rss-1",
                        "nativeSessionId": "thr_rss_1",
                        "callId": call_id,
                        "rpcId": 1,
                        "server": "ocbridge",
                        "name": "t0",
                        "arguments": args,
                        "argsHash": args_hash,
                    }
                    payload = remote_canonical_bytes(wire_req)
                    del wire_req

                    def master_side() -> None:
                        frame = strict_json(proc.stdout.readline())
                        req_body = strict_json(base64.b64decode(frame["body"]))
                        wire_reply = {
                            **{k: req_body[k] for k in req_body if k != "arguments"},
                            "ok": True,
                            "result": reply_result,
                        }
                        del req_body
                        resp_frame = {
                            "version": 4,
                            "driverId": "codex",
                            "engineId": "codex",
                            "kind": "tool-response",
                            "seq": frame["seq"],
                            "status": 200,
                            "body": base64.b64encode(remote_canonical_bytes(wire_reply)).decode("ascii"),
                        }
                        del wire_reply
                        proc.stdin.write((json.dumps(resp_frame) + "\n").encode("utf-8"))
                        proc.stdin.flush()

                    th = threading.Thread(target=master_side, daemon=True)
                    th.start()
                    import http.client as hc
                    import socket as sk
                    conn = hc.HTTPConnection("localhost", timeout=30)
                    conn.sock = sk.socket(sk.AF_UNIX, sk.SOCK_STREAM)
                    conn.sock.settimeout(30)
                    conn.sock.connect(str(root / "tool.sock"))
                    conn.request("POST", "/roundtrip", body=payload, headers={"Content-Type": "application/json", "Connection": "close"})
                    resp = conn.getresponse()
                    raw = resp.read()
                    conn.close()
                    th.join(timeout=5)
                    self.assertEqual(resp.status, 200)
                    return strict_json(raw)

                # 1) Small input -> near-4 MiB mixed ASCII + astral emoji result.
                r1 = post_roundtrip("call_rss_big_result", small_args, {"content": [{"type": "text", "text": mixed_text}], "isError": False})
                self.assertTrue(r1["ok"])
                self.assertEqual(len(r1["result"]["content"][0]["text"]), len(mixed_text))
                del r1

                # 2) >200 KiB input -> small result.
                big_args = {"content": "b" * (300 * 1024)}
                r2 = post_roundtrip("call_rss_big_input", big_args, {"content": [{"type": "text", "text": "ok"}], "isError": False})
                self.assertTrue(r2["ok"])
            finally:
                (root / "STOPPING.json").write_text("{}", encoding="utf-8")
                try:
                    proc.stdin.close()
                except Exception:
                    pass
                _, status, rusage = os.wait4(proc.pid, 0)
                try:
                    proc.stdout.close()
                    proc.stderr.close()
                except Exception:
                    pass
                self.assertEqual(os.waitstatus_to_exitcode(status), 0)
                self.assertLess(
                    rusage.ru_maxrss,
                    120 * 1024,
                    f"mcp_socket.py peak RSS {rusage.ru_maxrss} KiB exceeded 120 MiB budget",
                )


if __name__ == "__main__":
    unittest.main(verbosity=2)
