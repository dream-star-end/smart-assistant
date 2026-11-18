#!/usr/bin/env python3
"""Unit & subprocess tests for the 5-duty Antigravity remote driver (`drivers/antigravity.py`)."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import uuid

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from core.canonical import remote_canonical_sha256
from core.contract import (
    file_sha256,
    load_driver,
    load_registry,
    validate_decode_batch,
    validate_encode_batch,
    validate_launch_spec,
)

SAMPLE_TOOLS = {
    "tools": [
        {
            "name": "Write",
            "description": "Write sentinel file in container",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "file_path": {"type": "string"},
                    "content": {"type": "string"},
                },
                "required": ["file_path", "content"],
            },
        }
    ]
}


def make_fake_agy(dir_path: Path) -> Path:
    cli = dir_path / "fake-agy"
    cli.write_text(
        r"""#!/usr/bin/env python3
import json, signal, sys, time, uuid

args = sys.argv[1:]
if "--version" in args:
    print("antigravity 1.5.5")
    sys.exit(0)
if "models" in args:
    print("gemini-4-carbon  Gemini 4 Carbon\ngemini-4-hydrogen  Gemini 4 Hydrogen\ngemini-pro-orchestrator  Orchestrator Carbon\nclaude-opus-5-5  Claude Opus 5.5\n")
    sys.exit(0)
if "--effort" in args:
    sys.stderr.write("forbidden --effort flag passed\n")
    sys.exit(2)

conv_id = str(uuid.uuid4())
step_seq = 0
if "--conversation" in args:
    conv_id = args[args.index("--conversation") + 1]
selected_model = args[args.index("--model") + 1] if "--model" in args and args.index("--model") + 1 < len(args) else "gemini-4-carbon-medium"

def on_sigint(signum, frame):
    sys.stdout.write(json.dumps({
        "event": "result",
        "result": {"conversation_id": conv_id, "status": "ERROR", "error": "interrupted"},
    }) + "\n")
    sys.stdout.flush()
    sys.exit(1)

signal.signal(signal.SIGINT, on_sigint)
sys.stdout.write(json.dumps({"event": "init", "conversation_id": conv_id, "init": {"model": selected_model, "tools": []}}) + "\n")
sys.stdout.flush()

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    if "--conversation" in args:
        sys.stdout.write(json.dumps({
            "event": "step_update",
            "step_update": {
                "conversation_id": conv_id,
                "step_index": 1,
                "step_type": "agent_response",
                "state": "DONE",
                "text_delta": "stale-history-replay",
                "usage": {"input_tokens": 999, "output_tokens": 999, "thinking_tokens": 0, "cache_read_tokens": 0},
            },
        }) + "\n")
        step_seq = 10
    step_seq += 1
    sys.stdout.write(json.dumps({
        "event": "step_update",
        "step_update": {"conversation_id": conv_id, "step_index": step_seq, "step_type": "user_input", "state": "DONE"},
    }) + "\n")
    sys.stdout.flush()
    content = str((msg.get("message") or {}).get("content") or "")
    if "SLEEP_INTERRUPT" in content:
        time.sleep(10)
        continue
    step_seq += 1
    sys.stdout.write(json.dumps({
        "event": "step_update",
        "step_update": {
            "conversation_id": conv_id,
            "step_index": step_seq,
            "step_type": "agent_response",
            "state": "ACTIVE",
            "text_delta": f"model={selected_model}:",
        },
    }) + "\n")
    sys.stdout.write(json.dumps({
        "event": "step_update",
        "step_update": {
            "conversation_id": conv_id,
            "step_index": step_seq,
            "step_type": "agent_response",
            "state": "DONE",
            "text_delta": "hello world",
            "usage": {"input_tokens": 120, "output_tokens": 30, "thinking_tokens": 5, "cache_read_tokens": 40},
        },
    }) + "\n")
    sys.stdout.write(json.dumps({
        "event": "result",
        "result": {"conversation_id": conv_id, "status": "SUCCESS"},
    }) + "\n")
    sys.stdout.flush()
""",
        encoding="utf-8",
    )
    cli.chmod(0o755)
    return cli


class AntigravityDriverTests(unittest.TestCase):
    def test_01_registry_and_usage_policy(self) -> None:
        reg = load_registry()
        self.assertIn("antigravity", reg)
        entry = reg["antigravity"]
        self.assertEqual(entry["driverId"], "antigravity")
        self.assertEqual(entry["engineId"], "antigravity")
        self.assertEqual(entry["authorityEngine"], "antigravity")
        self.assertEqual(entry["profileMaxLanes"], 5)

        mod, meta, _ = load_driver("antigravity")
        self.assertEqual(meta["driverId"], "antigravity")
        pol = mod.usage_policy()
        self.assertEqual(pol["mode"], "per_turn")
        self.assertFalse(pol["inputIncludesCacheRead"])
        self.assertTrue(pol["outputIncludesReasoning"])
        self.assertFalse(pol["allowCacheWrite"])

    def test_02_probe_launch_system_prompt_and_policy_invariance(self) -> None:
        mod, _, _ = load_driver("antigravity")
        with tempfile.TemporaryDirectory(prefix="oc-drvtest-agy-") as td:
            td_path = Path(td)
            cli = make_fake_agy(td_path)
            acct_home = td_path / "acct"
            tok_dir = acct_home / ".gemini" / "antigravity-cli"
            tok_dir.mkdir(parents=True)
            tok_dir.joinpath("antigravity-oauth-token").write_text(
                json.dumps({"access_token": "ya29.secret-never-leak", "email": "alice@example.com", "tier": "g1-ultra-tier"}),
                encoding="utf-8",
            )
            step_res = mod.probe({"cliPath": str(cli), "accountHome": str(acct_home)}, None)
            self.assertEqual(step_res["kind"], "step")
            step = step_res["step"]
            proc = subprocess.run(step["argv"], capture_output=True, text=True, env=step["environment"], timeout=10, check=True)
            snap_res = mod.probe(
                {"cliPath": str(cli), "accountHome": str(acct_home)},
                {
                    "returncode": proc.returncode,
                    "stdoutLines": proc.stdout.splitlines(),
                    "stdoutSha256": remote_canonical_sha256(proc.stdout),
                    "artifactHashes": {"cli": file_sha256(cli)},
                },
            )
            self.assertEqual(snap_res["kind"], "snapshot")
            snap = snap_res["snapshot"]
            self.assertEqual(snap["accountHint"], "al***@example.com")
            self.assertEqual(snap["planType"], "ultra")
            self.assertNotIn("ya29.secret-never-leak", json.dumps(snap))
            mids = {m["upstreamModelId"] for m in snap["models"]}
            self.assertIn("gemini-4-carbon-medium", mids)
            self.assertIn("gemini-4-hydrogen-high", mids)

            spec_a = validate_launch_spec(
                mod.launch_spec(
                    {
                        "root": str(td_path / "r1"),
                        "model": "gemini-4-carbon-medium",
                        "cliPath": str(cli),
                        "accountHome": str(acct_home),
                        "systemPrompt": "PERSONA_ALPHA <tool-naming>ContainerWrite</tool-naming>",
                        "mcpClientPath": str(SCRIPT_DIR / "core" / "mcp_client.py"),
                        "tools": SAMPLE_TOOLS,
                    },
                    snap,
                ),
                td_path / "r1",
            )
            spec_b = validate_launch_spec(
                mod.launch_spec(
                    {
                        "root": str(td_path / "r2"),
                        "model": "gemini-4-hydrogen-high",
                        "cliPath": "/different/path/agy",
                        "qemuPath": "/different/path/qemu",
                        "accountHome": "/different/home",
                        "systemPrompt": "PERSONA_BETA",
                        "mcpClientPath": str(SCRIPT_DIR / "core" / "mcp_client.py"),
                        "tools": SAMPLE_TOOLS,
                    },
                    snap,
                ),
                td_path / "r2",
            )
            self.assertEqual(spec_a["policySha256"], snap_res["policySha256"])
            self.assertEqual(spec_a["policySha256"], spec_b["policySha256"])
            self.assertIn("excludeDefaultComponents: true", spec_a["files"]["home/.gemini/antigravity-cli/agents/ocremote.md"]["content"])
            self.assertIn("PERSONA_ALPHA", spec_a["files"]["home/.gemini/antigravity-cli/agents/ocremote.md"]["content"])
            self.assertIn("PERSONA_BETA", spec_b["files"]["home/.gemini/antigravity-cli/agents/ocremote.md"]["content"])
            self.assertNotEqual(
                spec_a["files"]["home/.gemini/antigravity-cli/agents/ocremote.md"]["content"],
                spec_b["files"]["home/.gemini/antigravity-cli/agents/ocremote.md"]["content"],
            )

            spec_red = mod.launch_spec(
                {
                    "root": str(td_path / "r3"),
                    "model": "gemini-4-carbon-medium",
                    "cliPath": str(cli),
                    "mcpClientPath": str(SCRIPT_DIR / "core" / "mcp_client.py"),
                    "tools": SAMPLE_TOOLS,
                    "testFaultAllowNativeTools": ["run_command"],
                },
                snap,
            )
            self.assertNotIn("excludeDefaultComponents: true", spec_red["files"]["home/.gemini/antigravity-cli/agents/ocremote.md"]["content"])
            self.assertNotEqual(spec_red["policySha256"], spec_a["policySha256"])

    def test_03_decode_real_recorded_cli_fixtures_and_recycle_safety(self) -> None:
        mod, _, _ = load_driver("antigravity")
        fixtures_dir = REPO_ROOT / "packages" / "gateway" / "src" / "__tests__" / "fixtures" / "antigravity"

        # 1. Replay recorded real stream-text.ndjson
        raw_lines = [ln for ln in (fixtures_dir / "stream-text.ndjson").read_text(encoding="utf-8").splitlines() if ln.strip()]
        st: dict = {}
        init_cmd = {"kind": "initialize", "commandId": "turn-rec-init", "model": "gemini-3.8-flash-low"}
        st = validate_encode_batch(mod.encode(init_cmd, st), init_cmd)["nextNativeState"]
        seq = 0
        texts: list[str] = []
        turn_cmd = {"kind": "newTurn", "commandId": "turn-rec-001", "prompt": "hi", "effort": "low", "instructions": "PLAT_A"}
        enc_t = validate_encode_batch(mod.encode(turn_cmd, st), turn_cmd)
        st = enc_t["nextNativeState"]
        self.assertIn("PLAT_A", enc_t["lines"][0])
        self.assertIn('"effort":"low"', enc_t["lines"][0])
        for ln in raw_lines:
            seq += 1
            raw = json.dumps({"ev": "cli", "turnSeq": 1, "raw": json.loads(ln)}).encode()
            out = validate_decode_batch(mod.decode("native", raw, st), channel="native", raw_frame_bytes=raw, frame_seq=seq)
            st = out["nextNativeState"]
            for ev in out["securityEvents"]:
                if ev["kind"] == "textDelta":
                    texts.append(ev["delta"])
        self.assertEqual("".join(texts), "Alpha Beta Gamma.\n")
        terminals = [ev for ev in out["securityEvents"] if ev["kind"] == "turnTerminal"]
        self.assertEqual(terminals[0]["terminalId"], "turn-rec-001")
        self.assertEqual(terminals[0]["status"], "success")
        usages = [ev for ev in out["securityEvents"] if ev["kind"] == "usage"]
        self.assertEqual(usages[0]["rawCounters"], {"input_tokens": 100, "output_tokens": 14, "cache_read_tokens": 0})

        # Simulate recycle-app (relay clears nativeState keeping only sessionId) and verify Turn 2 terminalId is unique + updated instructions/effort take effect
        recycled_state = {"sessionId": st["sessionId"], "expectedModel": "gemini-3.8-flash-low"}
        turn2_cmd = {"kind": "newTurn", "commandId": "turn-rec-002", "prompt": "hi again", "effort": "high", "instructions": "PLAT_B"}
        enc_t2 = validate_encode_batch(mod.encode(turn2_cmd, recycled_state), turn2_cmd)
        recycled_state = enc_t2["nextNativeState"]
        self.assertIn("PLAT_B", enc_t2["lines"][0])
        self.assertIn('"effort":"high"', enc_t2["lines"][0])
        self.assertNotEqual(enc_t["lines"][0], enc_t2["lines"][0])
        for ln in raw_lines[1:]:
            seq += 1
            raw = json.dumps({"ev": "cli", "turnSeq": 1, "raw": json.loads(ln)}).encode()
            out2 = validate_decode_batch(mod.decode("native", raw, recycled_state), channel="native", raw_frame_bytes=raw, frame_seq=seq)
            recycled_state = out2["nextNativeState"]
        self.assertEqual([ev for ev in out2["securityEvents"] if ev["kind"] == "turnTerminal"][0]["terminalId"], "turn-rec-002")

        # 2. Replay real tool-success.ndjson and confirm native run_command is flagged as disallowedItem
        tool_lines = [ln for ln in (fixtures_dir / "tool-success.ndjson").read_text(encoding="utf-8").splitlines() if ln.strip()]
        st_tool: dict = {}
        init_t = {"kind": "initialize", "commandId": "turn-tool-init"}
        st_tool = mod.encode(init_t, st_tool)["nextNativeState"]
        st_tool = mod.encode({"kind": "newTurn", "commandId": "turn-tool-1", "prompt": "run"}, st_tool)["nextNativeState"]
        disallowed = []
        for ln in tool_lines:
            seq += 1
            raw = json.dumps({"ev": "cli", "turnSeq": 1, "raw": json.loads(ln)}).encode()
            d = validate_decode_batch(mod.decode("native", raw, st_tool), channel="native", raw_frame_bytes=raw, frame_seq=seq)
            st_tool = d["nextNativeState"]
            disallowed.extend(ev for ev in d["securityEvents"] if ev["kind"] == "disallowedItem")
        self.assertTrue(any(ev["itemType"] == "run_command" for ev in disallowed))

        # 3. Replay real upstream-error.ndjson (error_message step has no nested error text -> error terminal)
        err_lines = [ln for ln in (fixtures_dir / "upstream-error.ndjson").read_text(encoding="utf-8").splitlines() if ln.strip()]
        st_err: dict = {}
        st_err = mod.encode({"kind": "initialize", "commandId": "turn-err-init"}, st_err)["nextNativeState"]
        st_err = mod.encode({"kind": "newTurn", "commandId": "turn-err-1", "prompt": "fail"}, st_err)["nextNativeState"]
        for ln in err_lines:
            seq += 1
            raw = json.dumps({"ev": "cli", "turnSeq": 1, "raw": json.loads(ln)}).encode()
            d_err = validate_decode_batch(mod.decode("native", raw, st_err), channel="native", raw_frame_bytes=raw, frame_seq=seq)
            st_err = d_err["nextNativeState"]
        self.assertEqual([ev for ev in d_err["securityEvents"] if ev["kind"] == "turnTerminal"][0]["status"], "error")

    def test_04_encode_decode_mcp_replay_and_errors(self) -> None:
        mod, _, _ = load_driver("antigravity")
        conv_id = str(uuid.uuid4())
        state: dict = {}
        seq = 0

        def dec(channel: str, payload: dict, st: dict) -> dict:
            nonlocal seq
            seq += 1
            raw = json.dumps(payload).encode()
            return validate_decode_batch(mod.decode(channel, raw, st), channel=channel, raw_frame_bytes=raw, frame_seq=seq)

        cmd_init = {"kind": "initialize", "commandId": "cmd_init_1", "model": "gemini-4-carbon-medium", "instructions": "SYS_1"}
        enc_init = validate_encode_batch(mod.encode(cmd_init, state), cmd_init)
        state = enc_init["nextNativeState"]
        dec_init = dec("native", {"ev": "cli", "turnSeq": 0, "raw": {"event": "init", "conversation_id": conv_id, "init": {"model": "gemini-4-carbon-low"}}}, state)
        state = dec_init["nextNativeState"]
        self.assertEqual(dec_init["controlReplies"][0]["nativeSessionId"], conv_id)
        with self.assertRaisesRegex(ValueError, "AGY_MODEL_MISMATCH"):
            mod.decode(
                "native",
                json.dumps({"ev": "cli", "turnSeq": 0, "raw": {"event": "init", "conversation_id": str(uuid.uuid4()), "init": {"model": "gemini-3.8-flash-low"}}}).encode(),
                validate_encode_batch(mod.encode({"kind": "initialize", "commandId": "cmd_init_bad", "model": "gemini-4-carbon-medium"}, {}), {"kind": "initialize", "commandId": "cmd_init_bad", "model": "gemini-4-carbon-medium"})["nextNativeState"],
            )

        cmd_turn1 = {"kind": "newTurn", "commandId": "cmd_turn_1", "prompt": "do work", "instructions": "SYS_1"}
        enc_turn = validate_encode_batch(mod.encode(cmd_turn1, state), cmd_turn1)
        state = enc_turn["nextNativeState"]
        self.assertIn("SYS_1", enc_turn["lines"][0])

        # Verify 200 KiB platform instructions keep native_state well below 64 KiB contract limit
        large_inst = "X" * (200 * 1024)
        st_big: dict = {}
        init_big = {"kind": "initialize", "commandId": "cmd_big_init", "model": "gemini-4-carbon-medium", "instructions": large_inst}
        res_init_big = validate_encode_batch(mod.encode(init_big, st_big), init_big)
        st_big = res_init_big["nextNativeState"]
        self.assertLess(len(json.dumps(st_big)), 4096)
        turn_big = {"kind": "newTurn", "commandId": "cmd_big_turn", "prompt": "work", "instructions": large_inst}
        res_turn_big = validate_encode_batch(mod.encode(turn_big, st_big), turn_big)
        st_big = res_turn_big["nextNativeState"]
        self.assertLess(len(json.dumps(st_big)), 4096)
        self.assertIn(large_inst[:64], res_turn_big["lines"][0])

        # Replayed old history before baseline must be ignored cleanly
        dec_replay = dec(
            "native",
            {
                "ev": "cli",
                "turnSeq": 1,
                "resumed": True,
                "baselineStepIndex": 4,
                "raw": {
                    "event": "step_update",
                    "step_update": {
                        "conversation_id": conv_id,
                        "step_index": 2,
                        "step_type": "agent_response",
                        "state": "DONE",
                        "text_delta": "old-reply",
                        "usage": {"input_tokens": 500, "output_tokens": 50, "thinking_tokens": 0, "cache_read_tokens": 0},
                    },
                },
            },
            state,
        )
        state = dec_replay["nextNativeState"]
        self.assertEqual(dec_replay["securityEvents"], [])

        tool_args = {"file_path": "/tmp/a.txt", "content": "ok"}
        dec_obs = dec(
            "native",
            {
                "ev": "cli",
                "turnSeq": 1,
                "raw": {
                    "event": "step_update",
                    "step_update": {
                        "conversation_id": conv_id,
                        "step_index": 7,
                        "step_type": "tool",
                        "state": "ACTIVE",
                        "tool_info": {"name": "mcp_ocbridge_Write", "parameters": tool_args},
                    },
                },
            },
            state,
        )
        state = dec_obs["nextNativeState"]
        obs_ev = [e for e in dec_obs["securityEvents"] if e["kind"] == "toolCallObserved"][0]

        dec_mcp = dec(
            "fixed_mcp",
            {
                "jsonrpc": "2.0",
                "id": 99,
                "method": "tools/call",
                "params": {
                    "name": "Write",
                    "arguments": tool_args,
                    "_meta": {"antigravity.google/conversation_id": conv_id, "progressToken": f"{uuid.uuid4()}:7"},
                },
            },
            state,
        )
        self.assertEqual(dec_mcp["pendingToolRequest"]["callId"], obs_ev["callId"])
        self.assertEqual(dec_mcp["pendingToolRequest"]["argsHash"], obs_ev["argsHash"])

        dec_resp = dec(
            "native",
            {
                "ev": "cli",
                "turnSeq": 1,
                "raw": {
                    "event": "step_update",
                    "step_update": {
                        "conversation_id": conv_id,
                        "step_index": 9,
                        "step_type": "agent_response",
                        "state": "DONE",
                        "text_delta": "all done",
                        "usage": {"input_tokens": 100, "output_tokens": 25, "thinking_tokens": 5, "cache_read_tokens": 10},
                    },
                },
            },
            state,
        )
        state = dec_resp["nextNativeState"]
        dec_done = dec(
            "native",
            {"ev": "cli", "turnSeq": 1, "raw": {"event": "result", "result": {"conversation_id": conv_id, "status": "SUCCESS"}}},
            state,
        )
        state = dec_done["nextNativeState"]
        term_ev = [e for e in dec_done["securityEvents"] if e["kind"] == "turnTerminal"][0]
        self.assertEqual(term_ev["terminalId"], "cmd_turn_1")

        cmd_turn2 = {"kind": "newTurn", "commandId": "cmd_turn_2", "prompt": "no usage"}
        enc_turn2 = validate_encode_batch(mod.encode(cmd_turn2, state), cmd_turn2)
        with self.assertRaisesRegex(ValueError, "AGY_USAGE_MISSING"):
            mod.decode(
                "native",
                json.dumps({"ev": "cli", "turnSeq": 2, "raw": {"event": "result", "result": {"conversation_id": conv_id, "status": "SUCCESS"}}}).encode(),
                enc_turn2["nextNativeState"],
            )

    def test_05_agy_host_subprocess_effort_switch_and_interrupt(self) -> None:
        mod, _, _ = load_driver("antigravity")
        with tempfile.TemporaryDirectory(prefix="oc-drvtest-host-") as td:
            root = Path(td) / "lane"
            root.mkdir()
            (root / "cwd").mkdir()
            cli = make_fake_agy(Path(td))
            snap = {
                "schemaVersion": 4,
                "engineId": "antigravity",
                "driverId": "antigravity",
                "driverVersion": "1.0.0",
                "source": "test",
                "freshness": "cli-observed",
                "authPresent": True,
                "accountObserved": True,
                "cliVersion": "1.5.5",
                "cliSha256": file_sha256(cli),
                "models": [
                    {"upstreamModelId": "gemini-4-carbon-low", "supportedEfforts": ["low", "medium", "high"], "defaultEffort": "low", "supportsAdaptiveThinking": True, "supportsVision": False},
                    {"upstreamModelId": "gemini-4-carbon-medium", "supportedEfforts": ["low", "medium", "high"], "defaultEffort": "medium", "supportsAdaptiveThinking": True, "supportsVision": False},
                    {"upstreamModelId": "gemini-4-carbon-high", "supportedEfforts": ["low", "medium", "high"], "defaultEffort": "high", "supportsAdaptiveThinking": True, "supportsVision": False},
                ],
                "rawResponseSha256": "b" * 64,
                "observedAt": "2026-11-18T00:00:00Z",
            }
            spec = mod.launch_spec(
                {
                    "root": str(root),
                    "model": "gemini-4-carbon-medium",
                    "cliPath": str(cli),
                    "systemPrompt": "PLAT_SUBPROC",
                    "mcpClientPath": str(SCRIPT_DIR / "core" / "mcp_client.py"),
                    "tools": SAMPLE_TOOLS,
                },
                snap,
            )
            for rel, meta in spec["files"].items():
                p = root / rel
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(meta["content"], encoding="utf-8")
                os.chmod(p, meta["mode"])
            for d in spec["dirs"]:
                (root / d).mkdir(parents=True, exist_ok=True)

            proc = subprocess.Popen(spec["argv"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, cwd=spec["cwd"], env=spec["environment"])
            try:
                state: dict = {}
                e1 = mod.encode({"kind": "initialize", "commandId": "cmd_i1", "model": "gemini-4-carbon-medium", "instructions": "PLAT_SUBPROC"}, state)
                state = e1["nextNativeState"]
                for ln in e1["lines"]:
                    proc.stdin.write(ln + "\n")
                proc.stdin.flush()
                init_out = proc.stdout.readline()
                state = mod.decode("native", init_out.encode(), state)["nextNativeState"]
                self.assertTrue(state["initialized"])

                e2 = mod.encode({"kind": "newTurn", "commandId": "cmd_t1", "prompt": "hi", "effort": "high"}, state)
                state = e2["nextNativeState"]
                for ln in e2["lines"]:
                    proc.stdin.write(ln + "\n")
                proc.stdin.flush()
                deltas: list[str] = []
                while state.get("activeTurn"):
                    ln = proc.stdout.readline()
                    self.assertTrue(ln)
                    res = mod.decode("native", ln.encode(), state)
                    state = res["nextNativeState"]
                    for ev in res["securityEvents"]:
                        if ev["kind"] == "textDelta":
                            deltas.append(ev["delta"])
                self.assertEqual("".join(deltas), "model=gemini-4-carbon-high:hello world")

                e3 = mod.encode({"kind": "newTurn", "commandId": "cmd_t2", "prompt": "SLEEP_INTERRUPT", "effort": "low"}, state)
                state = e3["nextNativeState"]
                for ln in e3["lines"]:
                    proc.stdin.write(ln + "\n")
                proc.stdin.flush()
                e_int = mod.encode({"kind": "interrupt", "commandId": "cmd_int_1"}, state)
                state = e_int["nextNativeState"]
                for ln in e_int["lines"]:
                    proc.stdin.write(ln + "\n")
                proc.stdin.flush()
                got_int_reply = False
                while state.get("activeTurn") or not got_int_reply:
                    ln = proc.stdout.readline()
                    self.assertTrue(ln)
                    res = mod.decode("native", ln.encode(), state)
                    state = res["nextNativeState"]
                    for cr in res["controlReplies"]:
                        if cr.get("commandKind") == "interrupt":
                            got_int_reply = True
                self.assertTrue(got_int_reply)
            finally:
                for stream in (proc.stdin, proc.stdout, proc.stderr):
                    try:
                        if stream:
                            stream.close()
                    except Exception:
                        pass
                proc.wait(timeout=5)

    def test_06_pretool_hydration_exit_plan_mode_and_vision(self) -> None:
        mod, _, _ = load_driver("antigravity")

        # 1) supportsVision reflects real model capability (True except gpt-oss).
        probed = mod._normalize_probed_models(
            [
                {"id": "gemini-4-carbon"},
                {"id": "claude-opus-5-5"},
                {"id": "gpt-oss-120b"},
            ]
        )
        by_id = {m["upstreamModelId"]: m for m in probed}
        self.assertTrue(by_id["gemini-4-carbon-medium"]["supportsVision"])
        self.assertTrue(by_id["claude-opus-5-5-high"]["supportsVision"])
        self.assertFalse(by_id["gpt-oss-120b"]["supportsVision"])

        # 2) decode("native") allows exit_plan_mode without disallowedItem, and still blocks native run_command.
        cid = str(uuid.uuid4())
        st: dict = {}
        st = mod.encode({"kind": "initialize", "commandId": "cmd_i_plan"}, st)["nextNativeState"]
        st = mod.encode({"kind": "newTurn", "commandId": "cmd_t_plan", "prompt": "plan"}, st)["nextNativeState"]
        plan_step = json.dumps(
            {
                "ev": "cli",
                "turnSeq": 1,
                "raw": {
                    "event": "step_update",
                    "step_update": {
                        "conversation_id": cid,
                        "step_index": 2,
                        "step_type": "tool",
                        "state": "DONE",
                        "tool_info": {"name": "exit_plan_mode", "parameters": {"plan": "ok"}},
                    },
                },
            }
        ).encode()
        res_plan = mod.decode("native", plan_step, st)
        self.assertEqual([e for e in res_plan["securityEvents"] if e["kind"] == "disallowedItem"], [])

        # 3) End-to-end >512-char truncation hydration via deny_native.py PreToolUse hook + agy_host.py.
        long_cmd = "python3 -c '" + ("a" * 900) + "'"
        full_args = {"file_path": "/tmp/long.txt", "content": long_cmd}
        with tempfile.TemporaryDirectory(prefix="oc-drvtest-hydrate-") as td:
            root = Path(td) / "lane"
            root.mkdir()
            (root / "cwd").mkdir()
            fake_cli = Path(td) / "fake-agy-truncate"
            fake_cli.write_text(
                r"""#!/usr/bin/env python3
import json, pathlib, subprocess, sys, uuid
args = sys.argv[1:]
if "--version" in args:
    print("antigravity 1.5.5")
    sys.exit(0)
conv_id = str(uuid.uuid4())
sys.stdout.write(json.dumps({"event": "init", "conversation_id": conv_id, "init": {"model": "gemini-4-carbon-medium", "tools": []}}) + "\n")
sys.stdout.flush()
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    full_cmd = "python3 -c '" + ("a" * 900) + "'"
    # Mirror real Antigravity CLI 1.5.x (observed live): the PreToolUse payload uses camelCase
    # `conversationId`/`stepIdx` and its args carry the CLI-injected `toolSummary`, which the CLI
    # strips before the MCP `tools/call` and never shows in stream-json parameters.
    deny_py = pathlib.Path.cwd().parent / "deny_native.py"
    sys.stdout.write(json.dumps({"event": "step_update", "step_update": {"conversation_id": conv_id, "step_index": 4, "step_type": "user_input", "state": "DONE"}}) + "\n")
    sys.stdout.write(json.dumps({
        "event": "step_update",
        "step_update": {
            "conversation_id": conv_id,
            "step_index": 5,
            "step_type": "tool",
            "state": "ACTIVE",
            "tool_info": {"name": "mcp_ocbridge_Write", "parameters": {"file_path": "/tmp/long.txt", "content": full_cmd[:512] + "\u2026"}},
        },
    }) + "\n")
    sys.stdout.flush()
    hook_in = json.dumps({
        "toolCall": {"id": "toolu_5", "name": "mcp_ocbridge_Write", "args": {"file_path": "/tmp/long.txt", "content": full_cmd, "toolSummary": "Write long file"}},
        "stepIdx": 5,
        "conversationId": conv_id,
        "hookEventName": "PreToolUse",
    })
    hook_res = subprocess.run(["/usr/bin/python3", "-I", "-B", str(deny_py)], input=hook_in, text=True, capture_output=True, check=True)
    assert json.loads(hook_res.stdout)["decision"] == "allow"
    plan_res = subprocess.run(["/usr/bin/python3", "-I", "-B", str(deny_py)], input=json.dumps({"toolCall": {"name": "exit_plan_mode", "args": {}}}), text=True, capture_output=True, check=True)
    assert json.loads(plan_res.stdout)["decision"] == "allow"
    sys.stdout.write(json.dumps({
        "event": "step_update",
        "step_update": {
            "conversation_id": conv_id,
            "step_index": 5,
            "step_type": "tool",
            "state": "DONE",
            "tool_info": {"name": "mcp_ocbridge_Write", "parameters": {"file_path": "/tmp/long.txt", "content": full_cmd[:512] + "\u2026"}},
        },
    }) + "\n")
    sys.stdout.flush()
    # Short-arg call whose hook lands BEFORE the stream frame is read: must still observe stream params.
    short_hook = json.dumps({
        "toolCall": {"id": "toolu_6", "name": "mcp_ocbridge_Bash", "args": {"command": "ls", "toolSummary": "List"}},
        "stepIdx": 6,
        "conversationId": conv_id,
        "hookEventName": "PreToolUse",
    })
    subprocess.run(["/usr/bin/python3", "-I", "-B", str(deny_py)], input=short_hook, text=True, capture_output=True, check=True)
    sys.stdout.write(json.dumps({
        "event": "step_update",
        "step_update": {
            "conversation_id": conv_id,
            "step_index": 6,
            "step_type": "tool",
            "state": "ACTIVE",
            "tool_info": {"name": "mcp_ocbridge_Bash", "parameters": {"command": "ls"}},
        },
    }) + "\n")
    sys.stdout.write(json.dumps({
        "event": "step_update",
        "step_update": {
            "conversation_id": conv_id,
            "step_index": 7,
            "step_type": "agent_response",
            "state": "DONE",
            "text_delta": "done",
            "usage": {"input_tokens": 10, "output_tokens": 5, "thinking_tokens": 0, "cache_read_tokens": 0},
        },
    }) + "\n")
    sys.stdout.write(json.dumps({"event": "result", "result": {"conversation_id": conv_id, "status": "SUCCESS"}}) + "\n")
    sys.stdout.flush()
""",
                encoding="utf-8",
            )
            fake_cli.chmod(0o755)
            snap = {
                "schemaVersion": 4,
                "engineId": "antigravity",
                "driverId": "antigravity",
                "driverVersion": "1.0.0",
                "source": "test",
                "freshness": "cli-observed",
                "authPresent": True,
                "accountObserved": True,
                "cliVersion": "1.5.5",
                "cliSha256": file_sha256(fake_cli),
                "models": [
                    {"upstreamModelId": "gemini-4-carbon-medium", "supportedEfforts": ["low", "medium", "high"], "defaultEffort": "medium", "supportsAdaptiveThinking": True, "supportsVision": True},
                ],
                "rawResponseSha256": "d" * 64,
                "observedAt": "2026-11-18T00:00:00Z",
            }
            spec = mod.launch_spec(
                {
                    "root": str(root),
                    "model": "gemini-4-carbon-medium",
                    "cliPath": str(fake_cli),
                    "systemPrompt": "PLAT_HYDRATE",
                    "mcpClientPath": str(SCRIPT_DIR / "core" / "mcp_client.py"),
                    "tools": SAMPLE_TOOLS,
                },
                snap,
            )
            self.assertIn("run/pretool", spec["dirs"])
            for rel, meta in spec["files"].items():
                p = root / rel
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(meta["content"], encoding="utf-8")
                os.chmod(p, meta["mode"])
            for d in spec["dirs"]:
                (root / d).mkdir(parents=True, exist_ok=True)

            proc = subprocess.Popen(spec["argv"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, cwd=spec["cwd"], env=spec["environment"])
            try:
                hst: dict = {}
                e1 = mod.encode({"kind": "initialize", "commandId": "cmd_h1", "model": "gemini-4-carbon-medium"}, hst)
                hst = e1["nextNativeState"]
                for ln in e1["lines"]:
                    proc.stdin.write(ln + "\n")
                proc.stdin.flush()
                hst = mod.decode("native", proc.stdout.readline().encode(), hst)["nextNativeState"]

                e2 = mod.encode({"kind": "newTurn", "commandId": "cmd_h2", "prompt": "go"}, hst)
                hst = e2["nextNativeState"]
                for ln in e2["lines"]:
                    proc.stdin.write(ln + "\n")
                proc.stdin.flush()
                obs_args = []
                presented_params = []
                while hst.get("activeTurn"):
                    ln = proc.stdout.readline()
                    self.assertTrue(ln)
                    frame = json.loads(ln)
                    su = (frame.get("raw") or {}).get("step_update") or {}
                    if su.get("step_type") == "tool":
                        presented_params.append((su.get("step_index"), su.get("state"), su["tool_info"]["parameters"]))
                    dec_res = mod.decode("native", ln.encode(), hst)
                    hst = dec_res["nextNativeState"]
                    for sev in dec_res["securityEvents"]:
                        if sev["kind"] == "toolCallObserved":
                            obs_args.append(sev)
                self.assertEqual(len(obs_args), 2)
                # Observed args must equal what ocbridge `tools/call` receives (no CLI-only `toolSummary`).
                self.assertEqual(obs_args[0]["arguments"], full_args)
                self.assertEqual(obs_args[0]["argsHash"], remote_canonical_sha256(full_args))
                self.assertEqual(obs_args[1]["arguments"], {"command": "ls"})
                self.assertEqual(obs_args[1]["argsHash"], remote_canonical_sha256({"command": "ls"}))
                # Every stream frame for the same step carries identical hydrated params.
                self.assertEqual(
                    [(i, s, p) for i, s, p in presented_params if i == 5],
                    [(5, "ACTIVE", full_args), (5, "DONE", full_args)],
                )
                self.assertTrue(all("toolSummary" not in p for _, _, p in presented_params))
            finally:
                for stream in (proc.stdin, proc.stdout, proc.stderr):
                    try:
                        if stream:
                            stream.close()
                    except Exception:
                        pass
                proc.wait(timeout=5)


if __name__ == "__main__":
    unittest.main(verbosity=2)
