#!/usr/bin/env python3
"""Unit & integration tests for OCV5-890 Wave 1A Python Core/Drivers v5 upgrades."""
from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
import uuid
from typing import Any, Dict, List

AGENT_REMOTE_DIR = Path(__file__).resolve().parents[1]
if str(AGENT_REMOTE_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_REMOTE_DIR))

from core.canonical import (  # noqa: E402
    filter_args_by_schema,
    remote_canonical_bytes,
    remote_canonical_sha256,
    remote_schema_filtered_sha256,
    strict_json,
)
from core.contract import (  # noqa: E402
    file_sha256,
    load_driver,
    validate_decode_batch,
    validate_encode_batch,
    validate_launch_spec,
)
from core.controller import (  # noqa: E402
    export_session_capsule_files,
    import_session_capsule_files,
)
from core.mcp_socket import run_socket_bridge  # noqa: E402

SAMPLE_TOOLS = {
    "tools": [
        {
            "name": "Write",
            "description": "Write file",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "file_path": {"type": "string"},
                    "content": {"type": "string"},
                },
                "required": ["file_path", "content"],
            },
        },
        {
            "name": "t0",
            "description": "Echo token",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "token": {"type": "string"},
                },
                "required": ["token"],
            },
        },
    ]
}


class CanonicalSchemaFilterTests(unittest.TestCase):
    def test_filter_args_strips_private_ui_fields_and_detects_1byte_tamper(self) -> None:
        schema = SAMPLE_TOOLS["tools"][0]["inputSchema"]
        raw_args = {
            "file_path": "/workspace/app.py",
            "content": "print('hello')",
            "toolSummary": "Writing app.py",
            "_cliInternal": {"trace": 123},
        }
        clean_args = {
            "file_path": "/workspace/app.py",
            "content": "print('hello')",
        }

        filtered = filter_args_by_schema(raw_args, schema)
        self.assertEqual(filtered, clean_args)
        self.assertNotIn("toolSummary", filtered)
        self.assertNotIn("_cliInternal", filtered)

        h_raw = remote_schema_filtered_sha256(raw_args, schema)
        h_clean = remote_schema_filtered_sha256(clean_args, schema)
        self.assertEqual(h_raw, h_clean)
        self.assertEqual(h_raw, remote_canonical_sha256(clean_args))

        # 1-byte tamper on declared param MUST change hash.
        tampered = dict(raw_args, content="print('hellp')")
        self.assertNotEqual(remote_schema_filtered_sha256(tampered, schema), h_clean)

    def test_filter_args_without_properties_is_passthrough(self) -> None:
        args = {"a": 1, "toolSummary": "keep-when-no-schema"}
        self.assertEqual(filter_args_by_schema(args, None), args)
        self.assertEqual(filter_args_by_schema(args, {"type": "object"}), args)
        self.assertEqual(filter_args_by_schema(args, {"type": "object", "properties": {}}), args)
        self.assertEqual(remote_schema_filtered_sha256(args, None), remote_canonical_sha256(args))
        with self.assertRaisesRegex(ValueError, "REMOTE_CANONICAL_JSON_INVALID"):
            filter_args_by_schema(["not", "a", "dict"], None)  # type: ignore[arg-type]


class McpSocketSchemaObservationTests(unittest.TestCase):
    def _post_unix(self, sock_path: Path, body: Dict[str, Any]) -> tuple[int, bytes]:
        import http.client
        import socket

        payload = remote_canonical_bytes(body)
        conn = http.client.HTTPConnection("localhost", timeout=5)
        conn.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        conn.sock.settimeout(5)
        try:
            conn.sock.connect(str(sock_path))
            conn.request(
                "POST",
                "/roundtrip",
                body=payload,
                headers={"Content-Type": "application/json", "Connection": "close"},
            )
            resp = conn.getresponse()
            return resp.status, resp.read()
        finally:
            conn.close()

    def _run_case(self, obs_doc: Dict[str, Any], wire_args: Dict[str, Any], wire_args_hash: str) -> int:
        with tempfile.TemporaryDirectory(dir="/tmp", prefix="oc-drvtest-v5sock-") as tmp:
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
                "operationId": "op-v5-1",
                "runId": "run-v5-1",
                "generation": "1",
                "profileId": "c240b4a0-4d0b-49e8-b5d4-77252377ad88",
                "authEpoch": "epoch-v5-1",
                "nativeSessionId": "thr_v5_1",
                "catalogSha256": hashlib.sha256(tools_bytes).hexdigest(),
                "requireNodeObservation": True,
            }
            (root / "client.json").write_text(json.dumps(cfg), encoding="utf-8")
            (root / "client.json").chmod(0o400)
            (root / "observations").mkdir(mode=0o700)
            (root / "tool-attempts").mkdir(mode=0o700)

            call_id = obs_doc["callId"]
            call_key = hashlib.sha256(call_id.encode("utf-8")).hexdigest()
            obs_path = root / "observations" / f"{call_key}.json"
            obs_path.write_text(json.dumps(obs_doc), encoding="utf-8")
            obs_path.chmod(0o600)

            r_in, w_in = os.pipe()
            r_out, w_out = os.pipe()
            src = os.fdopen(r_in, "rb", buffering=0)
            snk = os.fdopen(w_out, "wb", buffering=0)
            master_out = os.fdopen(r_out, "rb", buffering=0)
            master_in = os.fdopen(w_in, "wb", buffering=0)

            t = threading.Thread(target=lambda: run_socket_bridge(root, src, snk), daemon=True)
            t.start()
            try:
                ready = strict_json(master_out.readline())
                self.assertEqual(ready["kind"], "socket-ready")

                def responder() -> None:
                    raw = master_out.readline()
                    if not raw:
                        return
                    frame = strict_json(raw)
                    if frame.get("kind") != "tool-request":
                        return
                    req_body = strict_json(base64.b64decode(frame["body"]))
                    wire_reply = {
                        **{k: req_body[k] for k in req_body if k != "arguments"},
                        "ok": True,
                        "result": {"content": [{"type": "text", "text": "ok"}], "isError": False},
                    }
                    resp_frame = {
                        "version": 4,
                        "driverId": "codex",
                        "engineId": "codex",
                        "kind": "tool-response",
                        "seq": frame["seq"],
                        "status": 200,
                        "body": base64.b64encode(remote_canonical_bytes(wire_reply)).decode("ascii"),
                    }
                    master_in.write((json.dumps(resp_frame) + "\n").encode("utf-8"))
                    master_in.flush()

                rt = threading.Thread(target=responder, daemon=True)
                rt.start()

                body = {
                    "version": 4,
                    "driverId": "codex",
                    "engineId": "codex",
                    "operationId": "op-v5-1",
                    "runId": "run-v5-1",
                    "generation": "1",
                    "profileId": "c240b4a0-4d0b-49e8-b5d4-77252377ad88",
                    "authEpoch": "epoch-v5-1",
                    "nativeSessionId": "thr_v5_1",
                    "nativeTurnId": "turn_v5_1",
                    "callId": call_id,
                    "rpcId": 1,
                    "server": "ocbridge",
                    "name": "t0",
                    "arguments": wire_args,
                    "argsHash": wire_args_hash,
                }
                status, _ = self._post_unix(root / "tool.sock", body)
                rt.join(timeout=2)
                return status
            finally:
                (root / "STOPPING.json").write_text("{}", encoding="utf-8")
                try:
                    master_in.close()
                except OSError:
                    pass
                t.join(timeout=3)
                for handle in (master_out, src, snk):
                    try:
                        handle.close()
                    except OSError:
                        pass

    def test_v4_compat_and_v5_schema_hash_verification(self) -> None:
        schema = SAMPLE_TOOLS["tools"][1]["inputSchema"]
        args = {"token": "abc"}
        args_hash = remote_canonical_sha256(args)
        schema_hash = remote_schema_filtered_sha256(args, schema)
        base_obs = {
            "operationId": "op-v5-1",
            "runId": "run-v5-1",
            "generation": "1",
            "nativeSessionId": "thr_v5_1",
            "nativeTurnId": "turn_v5_1",
            "callId": "call_v5_ok",
            "name": "t0",
            "argsHash": args_hash,
        }

        # 1) Legacy v4 observation without argsSchemaSha256 still succeeds.
        self.assertEqual(self._run_case(base_obs, args, args_hash), 200)

        # 2) v5 observation with matching argsSchemaSha256 succeeds.
        obs_v5 = {**base_obs, "callId": "call_v5_schema_ok", "argsSchemaSha256": schema_hash}
        self.assertEqual(self._run_case(obs_v5, args, args_hash), 200)

        # 2b) Cross-channel alignment (Warning #3): CLI observation includes display-only UI fields
        #     (`toolSummary`) so obs.argsHash != body.argsHash, while obs.argsSchemaSha256 matches
        #     the clean schema-declared MCP execution args -> MUST succeed (200).
        cli_obs_args = {"token": "abc", "toolSummary": "Display-only CLI badge"}
        obs_with_ui = {
            **base_obs,
            "callId": "call_v5_schema_ui_ok",
            "argsHash": remote_canonical_sha256(cli_obs_args),
            "argsSchemaSha256": remote_schema_filtered_sha256(cli_obs_args, schema),
        }
        self.assertNotEqual(obs_with_ui["argsHash"], args_hash)
        self.assertEqual(self._run_case(obs_with_ui, args, args_hash), 200)

        # 3) Mismatched argsSchemaSha256 (1-byte tamper in declared arg) MUST be rejected (403).
        bad_schema_hash = remote_schema_filtered_sha256({"token": "abd"}, schema)
        obs_bad = {**base_obs, "callId": "call_v5_schema_bad", "argsSchemaSha256": bad_schema_hash}
        self.assertEqual(self._run_case(obs_bad, args, args_hash), 403)
        tampered_exec = {"token": "abd"}
        self.assertEqual(
            self._run_case(obs_with_ui, tampered_exec, remote_canonical_sha256(tampered_exec)),
            403,
        )

        # 4) Undeclared tampered argument MUST be rejected even if argsSchemaSha256 matches!
        smuggled_args = {"token": "abc", "undeclared_evil": True}
        self.assertEqual(
            self._run_case(obs_v5, smuggled_args, remote_canonical_sha256(smuggled_args)),
            403,
        )
        self.assertEqual(
            self._run_case(obs_with_ui, smuggled_args, remote_canonical_sha256(smuggled_args)),
            403,
        )
        # Even if client lies about body.argsHash to match obs.argsHash, independent recompute rejects it!
        self.assertEqual(self._run_case(obs_v5, smuggled_args, args_hash), 403)


class AntigravityV5UpgradeTests(unittest.TestCase):
    def _sample_snapshot(self, cli_sha: str = "a" * 64) -> Dict[str, Any]:
        return {
            "schemaVersion": 4,
            "engineId": "antigravity",
            "driverId": "antigravity",
            "driverVersion": "1.0.0",
            "source": "antigravity-cli:models",
            "freshness": "cli-observed",
            "authPresent": True,
            "accountObserved": True,
            "cliVersion": "1.5.5",
            "cliSha256": cli_sha,
            "models": [
                {
                    "upstreamModelId": "gemini-4-carbon-medium",
                    "displayName": "Gemini 4 Carbon Medium",
                    "supportedEfforts": ["low", "medium", "high"],
                    "defaultEffort": "medium",
                    "supportsAdaptiveThinking": True,
                    "supportsVision": True,
                }
            ],
            "rawResponseSha256": "b" * 64,
            "observedAt": "2026-11-25T00:00:00Z",
        }

    def test_sticky_home_key_isolation_and_sandbox_compat(self) -> None:
        mod, _, _ = load_driver("antigravity")
        snap = self._sample_snapshot()
        with tempfile.TemporaryDirectory(prefix="oc-v5-sticky-") as td:
            base = Path(td)
            acct_home = base / "acct"
            acct_home.mkdir(mode=0o700)
            root_g1 = base / "oc-remotedrv-op1-g1"
            root_g2 = base / "oc-remotedrv-op1-g2"
            sticky_key = "s-0123456789abcdef"

            spec_g1 = validate_launch_spec(
                mod.launch_spec(
                    {
                        "root": str(root_g1),
                        "model": "gemini-4-carbon-medium",
                        "cliPath": "/usr/local/bin/agy",
                        "accountHome": str(acct_home),
                        "stickyHomeKey": sticky_key,
                        "mcpClientPath": str(AGENT_REMOTE_DIR / "core" / "mcp_client.py"),
                        "tools": SAMPLE_TOOLS,
                    },
                    snap,
                ),
                root_g1,
            )
            spec_g2 = validate_launch_spec(
                mod.launch_spec(
                    {
                        "root": str(root_g2),
                        "model": "gemini-4-carbon-medium",
                        "cliPath": "/usr/local/bin/agy",
                        "accountHome": str(acct_home),
                        "manifest": {"stickyHomeKey": sticky_key},
                        "mcpClientPath": str(AGENT_REMOTE_DIR / "core" / "mcp_client.py"),
                        "tools": SAMPLE_TOOLS,
                    },
                    snap,
                ),
                root_g2,
            )
            expected_sticky = str((acct_home / "oc-sticky" / sticky_key).resolve())
            self.assertEqual(spec_g1["environment"]["HOME"], expected_sticky)
            self.assertEqual(spec_g2["environment"]["HOME"], expected_sticky)
            cfg_g1 = json.loads(spec_g1["files"]["host_config.json"]["content"])
            cfg_g2 = json.loads(spec_g2["files"]["host_config.json"]["content"])
            self.assertEqual(cfg_g1["stickyHomeDir"], expected_sticky)
            self.assertEqual(cfg_g2["stickyHomeDir"], expected_sticky)
            self.assertEqual(cfg_g1["toolSchemaKeys"]["Write"], ["content", "file_path"])
            self.assertEqual(cfg_g1["toolSchemaKeys"]["t0"], ["token"])

            # Invalid stickyHomeKey or missing key falls back to root/home.
            spec_bad_key = validate_launch_spec(
                mod.launch_spec(
                    {
                        "root": str(root_g1),
                        "model": "gemini-4-carbon-medium",
                        "cliPath": "/usr/local/bin/agy",
                        "accountHome": str(acct_home),
                        "stickyHomeKey": "../escape",
                        "mcpClientPath": str(AGENT_REMOTE_DIR / "core" / "mcp_client.py"),
                        "tools": SAMPLE_TOOLS,
                    },
                    snap,
                ),
                root_g1,
            )
            self.assertEqual(spec_bad_key["environment"]["HOME"], str(root_g1 / "home"))
            self.assertNotIn("stickyHomeDir", json.loads(spec_bad_key["files"]["host_config.json"]["content"]))

        # Sandbox `/tmp/oc-drvtest-` MUST keep root/home even when valid stickyHomeKey is passed.
        with tempfile.TemporaryDirectory(dir="/tmp", prefix="oc-drvtest-sticky-") as td:
            sb_root = Path(td) / "run-1"
            spec_sb = validate_launch_spec(
                mod.launch_spec(
                    {
                        "root": str(sb_root),
                        "model": "gemini-4-carbon-medium",
                        "cliPath": "/usr/local/bin/agy",
                        "accountHome": "/home/box",
                        "stickyHomeKey": "s-0123456789abcdef",
                        "mcpClientPath": str(AGENT_REMOTE_DIR / "core" / "mcp_client.py"),
                        "tools": SAMPLE_TOOLS,
                    },
                    snap,
                ),
                sb_root,
            )
            self.assertEqual(spec_sb["environment"]["HOME"], str(sb_root / "home"))
            self.assertNotIn("stickyHomeDir", json.loads(spec_sb["files"]["host_config.json"]["content"]))

    def test_sticky_home_host_atomic_sync_and_schema_filtered_hook_hydration(self) -> None:
        mod, _, _ = load_driver("antigravity")
        with tempfile.TemporaryDirectory(prefix="oc-v5-agyhost-") as td:
            base = Path(td)
            acct_home = base / "acct"
            (acct_home / ".gemini" / "antigravity-cli").mkdir(parents=True, mode=0o700)
            (acct_home / ".gemini" / "antigravity-cli" / "antigravity-oauth-token").write_text(
                json.dumps({"access_token": "tok-test"}), encoding="utf-8"
            )
            fake_cli = base / "fake-agy-v5"
            fake_cli.write_text(
                r"""#!/usr/bin/env python3
import json, os, pathlib, subprocess, sys, uuid
conv_id = str(uuid.uuid4())
home = pathlib.Path(os.environ["HOME"])
assert (home / ".gemini" / "config" / "mcp_config.json").is_file()
assert (home / ".gemini" / "config" / "hooks.json").is_file()
assert (home / ".gemini" / "antigravity-cli" / "agents" / "ocremote.md").is_file()
sys.stdout.write(json.dumps({"event": "init", "conversation_id": conv_id, "init": {"model": "gemini-4-carbon-medium", "tools": []}}) + "\n")
sys.stdout.flush()
for ln in sys.stdin:
    if not ln.strip():
        continue
    deny_py = pathlib.Path.cwd().parent / "deny_native.py"
    sys.stdout.write(json.dumps({"event": "step_update", "step_update": {"conversation_id": conv_id, "step_index": 1, "step_type": "user_input", "state": "DONE"}}) + "\n")
    # Hook runs BEFORE stream frame with CLI-private fields (`toolSummary`, `extraPrivateUi`) and NO ellipsis truncation!
    hook_in = json.dumps({
        "toolCall": {
            "id": "toolu_2",
            "name": "mcp_ocbridge_Write",
            "args": {
                "file_path": "/workspace/f.txt",
                "content": "exact-payload",
                "toolSummary": "Private CLI UI label",
                "extraPrivateUi": {"hidden": True},
            },
        },
        "stepIdx": 2,
        "conversationId": conv_id,
    })
    res = subprocess.run(["/usr/bin/python3", "-I", "-B", str(deny_py)], input=hook_in, text=True, capture_output=True, check=True)
    assert json.loads(res.stdout)["decision"] == "allow"
    # Even if stream frame leaks toolSummary, schema projection MUST strip it!
    sys.stdout.write(json.dumps({
        "event": "step_update",
        "step_update": {
            "conversation_id": conv_id,
            "step_index": 2,
            "step_type": "tool",
            "state": "ACTIVE",
            "tool_info": {
                "name": "mcp_ocbridge_Write",
                "parameters": {
                    "file_path": "/workspace/f.txt",
                    "content": "exact-payload",
                    "toolSummary": "Private CLI UI label",
                },
            },
        },
    }) + "\n")
    sys.stdout.write(json.dumps({
        "event": "step_update",
        "step_update": {
            "conversation_id": conv_id,
            "step_index": 3,
            "step_type": "agent_response",
            "state": "DONE",
            "text_delta": "ok",
            "usage": {"input_tokens": 50, "output_tokens": 10, "thinking_tokens": 0, "cache_read_tokens": 5},
        },
    }) + "\n")
    sys.stdout.write(json.dumps({"event": "result", "result": {"conversation_id": conv_id, "status": "SUCCESS"}}) + "\n")
    sys.stdout.flush()
""",
                encoding="utf-8",
            )
            fake_cli.chmod(0o755)

            root = base / "lane-g1"
            (root / "cwd").mkdir(parents=True)
            sticky_key = "s-fedcba9876543210"
            spec = validate_launch_spec(
                mod.launch_spec(
                    {
                        "root": str(root),
                        "model": "gemini-4-carbon-medium",
                        "cliPath": str(fake_cli),
                        "accountHome": str(acct_home),
                        "stickyHomeKey": sticky_key,
                        "systemPrompt": "STICKY_SYS_PROMPT",
                        "mcpClientPath": str(AGENT_REMOTE_DIR / "core" / "mcp_client.py"),
                        "tools": SAMPLE_TOOLS,
                    },
                    self._sample_snapshot(file_sha256(fake_cli)),
                ),
                root,
            )
            for rel, meta in spec["files"].items():
                p = root / rel
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(meta["content"], encoding="utf-8")
                os.chmod(p, meta["mode"])
            for d in spec["dirs"]:
                (root / d).mkdir(parents=True, exist_ok=True)

            proc = subprocess.Popen(
                spec["argv"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                cwd=spec["cwd"],
                env=spec["environment"],
            )
            try:
                st: Dict[str, Any] = {}
                e1 = mod.encode({"kind": "initialize", "commandId": "cmd_st_i1", "model": "gemini-4-carbon-medium"}, st)
                st = e1["nextNativeState"]
                for ln in e1["lines"]:
                    proc.stdin.write(ln + "\n")
                proc.stdin.flush()
                init_ln = proc.stdout.readline()
                st = validate_decode_batch(
                    mod.decode("native", init_ln.encode(), st),
                    channel="native",
                    raw_frame_bytes=init_ln.encode(),
                    frame_seq=1,
                )["nextNativeState"]

                e2 = mod.encode({"kind": "newTurn", "commandId": "cmd_st_t1", "prompt": "go"}, st)
                st = e2["nextNativeState"]
                for ln in e2["lines"]:
                    proc.stdin.write(ln + "\n")
                proc.stdin.flush()

                obs_events: List[Dict[str, Any]] = []
                usage_events: List[Dict[str, Any]] = []
                fseq = 1
                while st.get("activeTurn"):
                    ln = proc.stdout.readline()
                    self.assertTrue(ln)
                    fseq += 1
                    dec = validate_decode_batch(
                        mod.decode("native", ln.encode(), st),
                        channel="native",
                        raw_frame_bytes=ln.encode(),
                        frame_seq=fseq,
                    )
                    st = dec["nextNativeState"]
                    for ev in dec["securityEvents"]:
                        if ev["kind"] == "toolCallObserved":
                            obs_events.append(ev)
                        elif ev["kind"] == "usage":
                            usage_events.append(ev)

                self.assertEqual(len(obs_events), 1)
                expected_args = {"file_path": "/workspace/f.txt", "content": "exact-payload"}
                self.assertEqual(obs_events[0]["arguments"], expected_args)
                self.assertEqual(obs_events[0]["argsHash"], remote_canonical_sha256(expected_args))
                self.assertEqual(set(obs_events[0].keys()), {"kind", "callId", "name", "argsHash", "arguments", "phase"})

                # Both mid-turn step usage AND final result usage emitted.
                self.assertEqual(len(usage_events), 2)
                self.assertEqual(usage_events[0]["rawCounters"], {"input_tokens": 50, "output_tokens": 10, "cache_read_tokens": 5})
                self.assertEqual(usage_events[1]["rawCounters"], {"input_tokens": 50, "output_tokens": 10, "cache_read_tokens": 5})

                # Sticky home dir exists with 0o700 and synced isolation files.
                sticky_dir = acct_home / "oc-sticky" / sticky_key
                self.assertEqual(stat.S_IMODE(sticky_dir.lstat().st_mode), 0o700)
                self.assertIn("STICKY_SYS_PROMPT", (sticky_dir / ".gemini/antigravity-cli/agents/ocremote.md").read_text(encoding="utf-8"))
            finally:
                for s in (proc.stdin, proc.stdout, proc.stderr):
                    if s:
                        s.close()
                proc.wait(timeout=5)

    def test_step_type_23_compaction_clears_instructions_and_midturn_usage_dedupes(self) -> None:
        mod, _, _ = load_driver("antigravity")
        conv_id = str(uuid.uuid4())
        st: Dict[str, Any] = {}
        st = mod.encode({"kind": "initialize", "commandId": "cmd_c_init", "model": "gemini-4-carbon-medium"}, st)["nextNativeState"]
        st = mod.decode(
            "native",
            json.dumps({"ev": "cli", "turnSeq": 0, "raw": {"event": "init", "conversation_id": conv_id, "init": {"model": "gemini-4-carbon-medium"}}}).encode(),
            st,
        )["nextNativeState"]

        # Turn 1 injects instructions and caches loadedInstructionsHash.
        enc1 = mod.encode({"kind": "newTurn", "commandId": "cmd_c_t1", "prompt": "turn 1", "instructions": "SYS_KEEP"}, st)
        st = enc1["nextNativeState"]
        self.assertIn("SYS_KEEP", enc1["lines"][0])
        self.assertIn("loadedInstructionsHash", st)

        # Mid-turn step 2 emits usage; duplicate step 2 must NOT double count or re-emit.
        step2_raw = json.dumps(
            {
                "ev": "cli",
                "turnSeq": 1,
                "raw": {
                    "event": "step_update",
                    "step_update": {
                        "conversation_id": conv_id,
                        "step_index": 2,
                        "step_type": "agent_response",
                        "state": "DONE",
                        "text_delta": "part1",
                        "usage": {"input_tokens": 100, "output_tokens": 20, "thinking_tokens": 0, "cache_read_tokens": 10},
                    },
                },
            }
        ).encode()
        d_s2 = validate_decode_batch(mod.decode("native", step2_raw, st), channel="native", raw_frame_bytes=step2_raw, frame_seq=1)
        st = d_s2["nextNativeState"]
        self.assertEqual([e for e in d_s2["securityEvents"] if e["kind"] == "usage"][0]["rawCounters"], {"input_tokens": 100, "output_tokens": 20, "cache_read_tokens": 10})

        d_s2_dup = validate_decode_batch(mod.decode("native", step2_raw, st), channel="native", raw_frame_bytes=step2_raw, frame_seq=2)
        st = d_s2_dup["nextNativeState"]
        self.assertEqual([e for e in d_s2_dup["securityEvents"] if e["kind"] == "usage"], [])

        # step_type == 23 compaction event emits presentation and clears loadedInstructionsHash!
        compact_raw = json.dumps(
            {
                "ev": "cli",
                "turnSeq": 1,
                "raw": {
                    "event": "step_update",
                    "step_update": {
                        "conversation_id": conv_id,
                        "step_index": 3,
                        "step_type": 23,
                        "state": "DONE",
                    },
                },
            }
        ).encode()
        d_compact = validate_decode_batch(mod.decode("native", compact_raw, st), channel="native", raw_frame_bytes=compact_raw, frame_seq=3)
        st = d_compact["nextNativeState"]
        self.assertEqual(d_compact["presentation"], [{"kind": "compaction", "code": "step_type_23"}])
        self.assertNotIn("loadedInstructionsHash", st)

        # Finish turn 1.
        res_raw = json.dumps({"ev": "cli", "turnSeq": 1, "raw": {"event": "result", "result": {"conversation_id": conv_id, "status": "SUCCESS"}}}).encode()
        st = validate_decode_batch(mod.decode("native", res_raw, st), channel="native", raw_frame_bytes=res_raw, frame_seq=4)["nextNativeState"]

        # Turn 2 with the SAME instructions MUST re-inject <openclaude_platform_context> (self-healing!).
        enc2 = mod.encode({"kind": "newTurn", "commandId": "cmd_c_t2", "prompt": "turn 2", "instructions": "SYS_KEEP"}, st)
        self.assertIn("<openclaude_platform_context>", enc2["lines"][0])
        self.assertIn("SYS_KEEP", enc2["lines"][0])

    def test_new_turn_rejects_image_content_fail_closed(self) -> None:
        mod, _, _ = load_driver("antigravity")
        st = {"initialized": True, "sessionId": str(uuid.uuid4())}
        with self.assertRaisesRegex(ValueError, "AGY_VISION_CONTENT_UNSUPPORTED"):
            mod.encode(
                {
                    "kind": "newTurn",
                    "commandId": "cmd_agy_img_1",
                    "prompt": "describe",
                    "content": [
                        {"type": "text", "text": "describe"},
                        {"type": "image", "mimeType": "image/png", "data": "iVBORw0KGgo="},
                    ],
                },
                st,
            )
        with self.assertRaisesRegex(ValueError, "AGY_VISION_CONTENT_UNSUPPORTED"):
            mod.encode(
                {
                    "kind": "newTurn",
                    "commandId": "cmd_agy_img_2",
                    "prompt": "",
                    "content": [{"type": "image", "mimeType": "image/png", "data": "iVBORw0KGgo="}],
                },
                st,
            )


class CodexV5UpgradeTests(unittest.TestCase):
    def test_service_tier_multimodal_content_and_rollout_dir(self) -> None:
        mod, _, _ = load_driver("codex")
        base_state = {
            "initialized": True,
            "sessionId": "thr_v5_1",
            "expectedModel": "gpt-6-luna",
            "cliVersion": "0.170.0",
        }

        # 1) Explicit standard -> serviceTierForTurn="default" (never legacy "serviceTier").
        e_std = validate_encode_batch(
            mod.encode({"kind": "newTurn", "commandId": "cmd_cx_1", "prompt": "hi", "serviceTier": "standard"}, base_state),
            {"kind": "newTurn", "commandId": "cmd_cx_1"},
        )
        p_std = json.loads(e_std["lines"][0])["params"]
        self.assertNotIn("serviceTier", p_std)
        self.assertEqual(p_std["serviceTierForTurn"], "default")
        self.assertEqual(p_std["input"], [{"type": "text", "text": "hi"}])

        # 1b) Omitted serviceTier on explicit-standard model emits "default" on >=0.170.0,
        #     and omits serviceTierForTurn on legacy CLI (<0.170.0) or non-explicit models.
        e_omitted = validate_encode_batch(
            mod.encode({"kind": "newTurn", "commandId": "cmd_cx_omit", "prompt": "hi"}, base_state),
            {"kind": "newTurn", "commandId": "cmd_cx_omit"},
        )
        self.assertEqual(json.loads(e_omitted["lines"][0])["params"]["serviceTierForTurn"], "default")

        legacy_state = {**base_state, "cliVersion": "0.167.0"}
        e_legacy_omit = validate_encode_batch(
            mod.encode({"kind": "newTurn", "commandId": "cmd_cx_old_omit", "prompt": "hi"}, legacy_state),
            {"kind": "newTurn", "commandId": "cmd_cx_old_omit"},
        )
        self.assertNotIn("serviceTierForTurn", json.loads(e_legacy_omit["lines"][0])["params"])

        # 2) fast -> serviceTierForTurn="priority", ultrafast -> serviceTierForTurn="ultrafast".
        for tier, expected_wire in (("fast", "priority"), ("ultrafast", "ultrafast")):
            e_tier = validate_encode_batch(
                mod.encode({"kind": "newTurn", "commandId": f"cmd_cx_{tier}", "prompt": "hi", "serviceTier": tier}, base_state),
                {"kind": "newTurn", "commandId": f"cmd_cx_{tier}"},
            )
            p_tier = json.loads(e_tier["lines"][0])["params"]
            self.assertNotIn("serviceTier", p_tier)
            self.assertEqual(p_tier["serviceTierForTurn"], expected_wire)

        # 2b) CLI version gate: fast/ultrafast on <0.170.0 MUST fail closed.
        for tier in ("fast", "ultrafast"):
            with self.assertRaisesRegex(ValueError, "CODEX_SERVICE_TIER_UNSUPPORTED"):
                mod.encode(
                    {"kind": "newTurn", "commandId": f"cmd_cx_old_{tier}", "prompt": "hi", "serviceTier": tier},
                    legacy_state,
                )

        # 2c) decode("native") of initialize response captures cliVersion from userAgent.
        init_enc = mod.encode({"kind": "initialize", "commandId": "cmd_cx_init_v", "model": "gpt-6-luna"}, {})
        init_dec = mod.decode(
            "native",
            json.dumps({"jsonrpc": "2.0", "id": 1, "result": {"userAgent": "codex-cli/0.167.0"}}).encode(),
            init_enc["nextNativeState"],
        )
        self.assertEqual(init_dec["nextNativeState"]["cliVersion"], "0.167.0")

        with self.assertRaisesRegex(ValueError, "CODEX_SERVICE_TIER_INVALID"):
            mod.encode({"kind": "newTurn", "commandId": "cmd_cx_bad", "prompt": "hi", "serviceTier": "turbo"}, base_state)

        # 3) Multimodal content mapping: canonical gateway wire format + legacy source/localImage compat.
        gateway_mm = [
            {"type": "text", "text": "describe gateway image"},
            {"type": "image", "mimeType": "image/png", "data": "iVBORw0KGgo="},
            {"type": "image", "mimeType": "image/jpeg", "path": "/tmp/shot.jpg"},
        ]
        e_gw = validate_encode_batch(
            mod.encode({"kind": "newTurn", "commandId": "cmd_cx_gw_mm", "prompt": "describe gateway image", "content": gateway_mm, "serviceTier": "fast"}, base_state),
            {"kind": "newTurn", "commandId": "cmd_cx_gw_mm"},
        )
        p_gw = json.loads(e_gw["lines"][0])["params"]
        self.assertEqual(p_gw["serviceTierForTurn"], "priority")
        self.assertEqual(
            p_gw["input"],
            [
                {"type": "text", "text": "describe gateway image"},
                {"type": "image", "url": "data:image/png;base64,iVBORw0KGgo="},
                {"type": "localImage", "path": "/tmp/shot.jpg"},
            ],
        )

        # Legacy source + localImage form remains compatible.
        mm_content = [
            {"type": "text", "text": "describe image"},
            {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "iVBORw0KGgo="}},
            {"type": "localImage", "path": "/tmp/shot.png"},
        ]
        e_mm = validate_encode_batch(
            mod.encode({"kind": "newTurn", "commandId": "cmd_cx_mm", "prompt": "", "content": mm_content, "serviceTier": "fast"}, base_state),
            {"kind": "newTurn", "commandId": "cmd_cx_mm"},
        )
        p_mm = json.loads(e_mm["lines"][0])["params"]
        self.assertEqual(p_mm["serviceTierForTurn"], "priority")
        self.assertEqual(
            p_mm["input"],
            [
                {"type": "text", "text": "describe image"},
                {"type": "image", "url": "data:image/png;base64,iVBORw0KGgo="},
                {"type": "localImage", "path": "/tmp/shot.png"},
            ],
        )

        # Unresolved blobId without data/path MUST fail closed with CODEX_IMAGE_BLOB_UNRESOLVED.
        with self.assertRaisesRegex(ValueError, "CODEX_IMAGE_BLOB_UNRESOLVED"):
            mod.encode(
                {
                    "kind": "newTurn",
                    "commandId": "cmd_cx_blob_unres",
                    "prompt": "hi",
                    "content": [
                        {"type": "text", "text": "hi"},
                        {"type": "image", "mimeType": "image/png", "blobId": "blob_unres_1"},
                    ],
                },
                base_state,
            )

        # 4) launch_spec sessionRolloutDir isolation & traversal rejection.
        with tempfile.TemporaryDirectory(prefix="oc-v5-codex-") as td:
            base = Path(td)
            codex_home = base / "codex-home"
            codex_home.mkdir()
            (codex_home / "auth.json").write_text("{}", encoding="utf-8")
            root = base / "lane-1"
            (root / "cwd").mkdir(parents=True)
            cli = base / "fake-codex"
            cli.write_text("#!/bin/sh\n", encoding="utf-8")
            snap = {
                "cliSha256": file_sha256(cli),
                "models": [{"upstreamModelId": "gpt-6-luna", "displayName": "GPT-6 Luna"}],
            }

            spec_rel = validate_launch_spec(
                mod.launch_spec(
                    {
                        "root": str(root),
                        "codexHome": str(codex_home),
                        "systemCodexRoot": str(base / "no-etc"),
                        "model": "gpt-6-luna",
                        "cliPath": str(cli),
                        "mcpClientPath": str(AGENT_REMOTE_DIR / "core" / "mcp_client.py"),
                        "sessionRolloutDir": "rollouts/sess-01",
                    },
                    snap,
                ),
                root,
            )
            self.assertIn("rollouts/sess-01", spec_rel["dirs"])
            self.assertEqual(spec_rel["environment"]["CODEX_ROLLOUT_DIR"], str((root / "rollouts/sess-01").resolve()))
            self.assertEqual(spec_rel["environment"]["CODEX_HOME"], str(codex_home.resolve()))

            with self.assertRaisesRegex(ValueError, "CODEX_SESSION_ROLLOUT_DIR_INVALID"):
                mod.launch_spec(
                    {
                        "root": str(root),
                        "codexHome": str(codex_home),
                        "systemCodexRoot": str(base / "no-etc"),
                        "model": "gpt-6-luna",
                        "cliPath": str(cli),
                        "mcpClientPath": str(AGENT_REMOTE_DIR / "core" / "mcp_client.py"),
                        "sessionRolloutDir": "../../etc",
                    },
                    snap,
                )

            with self.assertRaisesRegex(ValueError, "CODEX_SESSION_ROLLOUT_DIR_INVALID"):
                mod.launch_spec(
                    {
                        "root": str(root),
                        "codexHome": str(codex_home),
                        "systemCodexRoot": str(base / "no-etc"),
                        "model": "gpt-6-luna",
                        "cliPath": str(cli),
                        "mcpClientPath": str(AGENT_REMOTE_DIR / "core" / "mcp_client.py"),
                        "sessionRolloutDir": "/etc/codex-evil",
                    },
                    snap,
                )

        # 5) probe preserves true supportsVision.
        with tempfile.TemporaryDirectory(prefix="oc-v5-cxprobe-") as td:
            base = Path(td)
            codex_home = base / "codex-home"
            codex_home.mkdir()
            (codex_home / "auth.json").write_text("{}", encoding="utf-8")
            cli = base / "fake-codex"
            cli.write_text("#!/bin/sh\n", encoding="utf-8")
            prev = {
                "returncode": 0,
                "stdoutLines": [
                    json.dumps({"id": 1, "result": {"userAgent": "codex-cli/0.167.0"}}),
                    json.dumps({"id": 2, "result": {"account": {"email": "u@example.com", "planType": "pro"}}}),
                    json.dumps(
                        {
                            "id": 3,
                            "result": {
                                "data": [
                                    {"id": "gpt-vision", "inputModalities": ["text", "image"], "supportedReasoningEfforts": [{"reasoningEffort": "medium"}], "defaultReasoningEffort": "medium"},
                                    {"id": "gpt-text-only", "inputModalities": ["text"], "supportedReasoningEfforts": [{"reasoningEffort": "medium"}], "defaultReasoningEffort": "medium"},
                                ],
                                "nextCursor": None,
                            },
                        }
                    ),
                ],
                "stdoutSha256": "c" * 64,
                "artifactHashes": {"cli": "a" * 64, "native": "a" * 64},
            }
            snap_out = mod.probe(
                {"cliPath": str(cli), "codexHome": str(codex_home), "systemCodexRoot": str(base / "no-etc"), "probeCwd": str(base)},
                prev,
            )["snapshot"]
            by_id = {m["upstreamModelId"]: m for m in snap_out["models"]}
            self.assertTrue(by_id["gpt-vision"]["supportsVision"])
            self.assertFalse(by_id["gpt-text-only"]["supportsVision"])


class CcV5UpgradeTests(unittest.TestCase):
    def test_service_tier_and_multimodal_content_encoding(self) -> None:
        mod, _, _ = load_driver("cc")
        base_state = {"sessionId": "11111111-2222-4333-8444-555555555555"}

        # 1) Plain prompt without serviceTier/content remains 100% v4-compatible.
        e_v4 = validate_encode_batch(
            mod.encode({"kind": "newTurn", "commandId": "cmd_cc_v4", "prompt": "hello"}, base_state),
            {"kind": "newTurn", "commandId": "cmd_cc_v4"},
        )
        msg_v4 = json.loads(e_v4["lines"][0])
        self.assertNotIn("serviceTier", msg_v4)
        self.assertEqual(msg_v4["message"]["content"], [{"type": "text", "text": "hello"}])

        # 2) serviceTier=fast & ultrafast pass through; standard omitted.
        e_fast = validate_encode_batch(
            mod.encode({"kind": "newTurn", "commandId": "cmd_cc_fast", "prompt": "hello", "serviceTier": "fast"}, base_state),
            {"kind": "newTurn", "commandId": "cmd_cc_fast"},
        )
        self.assertEqual(json.loads(e_fast["lines"][0])["serviceTier"], "fast")

        e_std = validate_encode_batch(
            mod.encode({"kind": "newTurn", "commandId": "cmd_cc_std", "prompt": "hello", "serviceTier": "standard"}, base_state),
            {"kind": "newTurn", "commandId": "cmd_cc_std"},
        )
        self.assertNotIn("serviceTier", json.loads(e_std["lines"][0]))

        with self.assertRaisesRegex(ValueError, "CC_SERVICE_TIER_INVALID"):
            mod.encode({"kind": "newTurn", "commandId": "cmd_cc_badt", "prompt": "hello", "serviceTier": "invalid"}, base_state)

        # 3) Multimodal content blocks: canonical gateway wire format + legacy source/url compat.
        gw_blocks = [
            {"type": "text", "text": "check gateway screenshot"},
            {"type": "image", "mimeType": "image/png", "data": "iVBORw0KGgo="},
        ]
        e_gw = validate_encode_batch(
            mod.encode({"kind": "newTurn", "commandId": "cmd_cc_gw_mm", "prompt": "check gateway screenshot", "content": gw_blocks, "serviceTier": "fast"}, base_state),
            {"kind": "newTurn", "commandId": "cmd_cc_gw_mm"},
        )
        msg_gw = json.loads(e_gw["lines"][0])
        self.assertEqual(
            msg_gw["message"]["content"],
            [
                {"type": "text", "text": "check gateway screenshot"},
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "iVBORw0KGgo="}},
            ],
        )

        mm_blocks = [
            {"type": "text", "text": "check screenshot"},
            {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "iVBORw0KGgo="}},
            {"type": "image", "url": "data:image/jpeg;base64,/9j/4AAQ"},
        ]
        e_mm = validate_encode_batch(
            mod.encode({"kind": "newTurn", "commandId": "cmd_cc_mm", "prompt": "", "content": mm_blocks, "serviceTier": "ultrafast"}, base_state),
            {"kind": "newTurn", "commandId": "cmd_cc_mm"},
        )
        msg_mm = json.loads(e_mm["lines"][0])
        self.assertEqual(msg_mm["serviceTier"], "ultrafast")
        self.assertEqual(
            msg_mm["message"]["content"],
            [
                {"type": "text", "text": "check screenshot"},
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "iVBORw0KGgo="}},
                {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": "/9j/4AAQ"}},
            ],
        )

        # Unresolved blobId without data MUST fail closed with CC_IMAGE_BLOB_UNRESOLVED.
        with self.assertRaisesRegex(ValueError, "CC_IMAGE_BLOB_UNRESOLVED"):
            mod.encode(
                {
                    "kind": "newTurn",
                    "commandId": "cmd_cc_blob_unres",
                    "prompt": "hi",
                    "content": [
                        {"type": "text", "text": "hi"},
                        {"type": "image", "mimeType": "image/png", "blobId": "blob_unres_1"},
                    ],
                },
                base_state,
            )


class ControllerCapsuleTests(unittest.TestCase):
    def test_sqlite_wal_checkpoint_and_atomic_roundtrip(self) -> None:
        with tempfile.TemporaryDirectory(prefix="oc-v5-cap-") as td:
            src_dir = Path(td) / "src"
            dst_dir = Path(td) / "dst"
            (src_dir / "conversations").mkdir(parents=True, mode=0o700)
            (src_dir / "sessions").mkdir(parents=True, mode=0o700)

            db_path = src_dir / "conversations" / "conv-1.db"
            conn = sqlite3.connect(str(db_path))
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA wal_autocheckpoint=0")
            conn.execute("CREATE TABLE steps (idx INTEGER PRIMARY KEY, body TEXT)")
            conn.execute("INSERT INTO steps (idx, body) VALUES (1, 'step-one'), (2, 'step-two-in-wal')")
            conn.commit()
            conn.close()

            jsonl_path = src_dir / "sessions" / "sess-1.jsonl"
            jsonl_path.write_text('{"role":"user","text":"hello"}\n', encoding="utf-8")

            capsule = export_session_capsule_files(
                src_dir,
                ["conversations/conv-1.db", "sessions/sess-1.jsonl"],
                allowed_patterns=["conversations/*.db", "sessions/*.jsonl"],
            )
            self.assertEqual(capsule["version"], 1)
            by_path = {f["path"]: f for f in capsule["files"]}
            self.assertTrue(by_path["conversations/conv-1.db"]["walCheckpointed"])
            self.assertFalse(by_path["sessions/sess-1.jsonl"]["walCheckpointed"])

            # Import into clean destination and verify all WAL-written SQLite rows are readable!
            res = import_session_capsule_files(
                dst_dir,
                capsule,
                allowed_patterns=["conversations/*.db", "sessions/*.jsonl"],
            )
            self.assertEqual(res["importedPaths"], ["conversations/conv-1.db", "sessions/sess-1.jsonl"])
            self.assertEqual(res["manifestSha256"], capsule["manifestSha256"])

            imported_db = dst_dir / "conversations" / "conv-1.db"
            self.assertEqual(stat.S_IMODE(imported_db.lstat().st_mode), 0o600)
            ro_conn = sqlite3.connect(f"file:{imported_db}?mode=ro", uri=True)
            try:
                rows = ro_conn.execute("SELECT idx, body FROM steps ORDER BY idx").fetchall()
            finally:
                ro_conn.close()
            self.assertEqual(rows, [(1, "step-one"), (2, "step-two-in-wal")])
            self.assertEqual((dst_dir / "sessions" / "sess-1.jsonl").read_text(encoding="utf-8"), '{"role":"user","text":"hello"}\n')

    def test_capsule_security_red_controls(self) -> None:
        with tempfile.TemporaryDirectory(prefix="oc-v5-capred-") as td:
            src_dir = Path(td) / "src"
            dst_dir = Path(td) / "dst"
            outside = Path(td) / "secret.txt"
            outside.write_text("do-not-export", encoding="utf-8")
            src_dir.mkdir(mode=0o700)
            (src_dir / "ok.jsonl").write_text("{}\n", encoding="utf-8")
            (src_dir / "auth.json").write_text('{"token":"secret"}', encoding="utf-8")
            os.symlink(str(outside), str(src_dir / "link.jsonl"))

            # Path traversal rejected
            with self.assertRaisesRegex(ValueError, "REMOTE_CAPSULE_PATH_FORBIDDEN"):
                export_session_capsule_files(src_dir, ["../secret.txt"])
            # Absolute path rejected
            with self.assertRaisesRegex(ValueError, "REMOTE_CAPSULE_PATH_FORBIDDEN"):
                export_session_capsule_files(src_dir, [str(outside)])
            # Forbidden credential file rejected even if pattern matches
            with self.assertRaisesRegex(ValueError, "REMOTE_CAPSULE_PATH_FORBIDDEN"):
                export_session_capsule_files(src_dir, ["auth.json"], allowed_patterns=["*.json"])
            # Symlink rejected
            with self.assertRaisesRegex(ValueError, "REMOTE_CAPSULE_SYMLINK_FORBIDDEN"):
                export_session_capsule_files(src_dir, ["link.jsonl"], allowed_patterns=["*.jsonl"])
            # Non-whitelisted path rejected
            with self.assertRaisesRegex(ValueError, "REMOTE_CAPSULE_PATH_NOT_ALLOWED"):
                export_session_capsule_files(src_dir, ["ok.jsonl"], allowed_patterns=["conversations/*.db"])

            # Valid export, then tamper checksum / manifest -> import MUST reject without creating files.
            valid = export_session_capsule_files(src_dir, ["ok.jsonl"], allowed_patterns=["*.jsonl"])

            tampered_content = json.loads(json.dumps(valid))
            tampered_content["files"][0]["contentB64"] = base64.b64encode(b"XX\n").decode("ascii")
            with self.assertRaisesRegex(ValueError, "REMOTE_CAPSULE_CHECKSUM_MISMATCH"):
                import_session_capsule_files(dst_dir, tampered_content, allowed_patterns=["*.jsonl"])
            self.assertFalse((dst_dir / "ok.jsonl").exists())

            tampered_manifest = json.loads(json.dumps(valid))
            tampered_manifest["manifestSha256"] = "0" * 64
            with self.assertRaisesRegex(ValueError, "REMOTE_CAPSULE_MANIFEST_MISMATCH"):
                import_session_capsule_files(dst_dir, tampered_manifest, allowed_patterns=["*.jsonl"])
            self.assertFalse((dst_dir / "ok.jsonl").exists())

            # Path traversal in import payload rejected
            tampered_path = json.loads(json.dumps(valid))
            tampered_path["files"][0]["path"] = "../escape.jsonl"
            with self.assertRaisesRegex(ValueError, "REMOTE_CAPSULE_PATH_FORBIDDEN"):
                import_session_capsule_files(dst_dir, tampered_path)
            self.assertFalse((Path(td) / "escape.jsonl").exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
