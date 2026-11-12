#!/usr/bin/env python3
"""Self-contained 5-duty Remote Driver (`example_echo`) for `AC-2` zero-core-diff proof.

Implements ONLY the 5 pure data-returning driver duties:
1. `launch_spec(context, verified_probe)`
2. `decode(channel, raw_frame, native_state)`
3. `encode(command, native_state)`
4. `probe(context, previous_step_result)`
5. `usage_policy()`

Contains zero SSH, socket, cgroup, WAL, or database code — all execution, admission,
observation gating, and `RemoteReceiptV4` billing run untouched through the shared core.
"""
from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path
import re
import uuid
from typing import Any, Dict, List, Optional

from core.canonical import remote_canonical_sha256, strict_json
from core.contract import IDENT_RE, TOOL_ALIAS_RE, need

DRIVER_ID = "example_echo"
DRIVER_VERSION = "1.0.0"
ENGINE_ID = "example-echo"
SEMANTICS_ID = "example-echo-per-turn-v1"

PROBE_SCRIPT = (
    "import json, sys\n"
    "req = json.loads(sys.stdin.readline())\n"
    "assert req.get('op') == 'hello'\n"
    "out = {\n"
    "  'version': '1.0.0',\n"
    "  'account': {'email': 'echo-driver@example.com', 'plan': 'pro'},\n"
    "  'models': [{\n"
    "    'id': 'example-echo-v1',\n"
    "    'displayName': 'Example Echo v1',\n"
    "    'efforts': ['low', 'medium', 'high'],\n"
    "    'adaptiveThinking': True,\n"
    "  }],\n"
    "}\n"
    "sys.stdout.write(json.dumps(out, separators=(',', ':')) + '\\n')\n"
    "sys.stdout.flush()\n"
)

ECHO_AGENT_SOURCE = """#!/usr/bin/env python3
import json, pathlib, subprocess, sys, threading, time

args = sys.argv[1:]
def arg_val(flag, default=""):
    return args[args.index(flag) + 1] if flag in args else default

model = arg_val("--model", "example-echo-v1")
session_id = arg_val("--session-id", "00000000-0000-4000-8000-000000000001")
native_tools_csv = arg_val("--native-tools", "")
native_tools = [x for x in native_tools_csv.split(",") if x]
tool_names_csv = arg_val("--tool-names", "Write")
tool_names = [x for x in tool_names_csv.split(",") if x] or ["Write"]
write_alias = arg_val("--write-alias", tool_names[0])
mcp_cfg = json.loads(pathlib.Path(arg_val("--mcp-config")).read_text(encoding="utf-8"))
oc_srv = mcp_cfg["mcpServers"]["ocbridge"]

def call_mcp(requests):
    proc = subprocess.Popen(
        [oc_srv["command"], *oc_srv["args"]],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    payload = "".join(json.dumps(r, separators=(",", ":")) + "\\n" for r in requests)
    try:
        out, _ = proc.communicate(payload, timeout=15)
    except Exception:
        proc.kill()
        return []
    return [json.loads(line) for line in out.splitlines() if line.strip()]

advertised_tools = [f"ocbridge:{t}" for t in tool_names]
sys.stdout.write(json.dumps({
    "ev": "ready",
    "sessionId": session_id,
    "model": model,
    "tools": advertised_tools,
}, separators=(",", ":")) + "\\n")
sys.stdout.flush()

turn_seq = 0
for raw in sys.stdin:
    if not raw.strip():
        continue
    msg = json.loads(raw)
    op = msg.get("op")
    if op == "interrupt":
        sys.stdout.write(json.dumps({
            "ev": "interrupt_ack",
            "commandId": msg.get("commandId", ""),
        }, separators=(",", ":")) + "\\n")
        sys.stdout.write(json.dumps({
            "ev": "done",
            "sessionId": session_id,
            "turnId": f"echo_int_{turn_seq + 1}",
            "status": "interrupted",
            "usage": {"input_tokens": 10, "output_tokens": 5, "cache_read_tokens": 0},
        }, separators=(",", ":")) + "\\n")
        sys.stdout.flush()
        continue
    if op != "turn":
        continue

    turn_seq += 1
    text = str(msg.get("prompt") or "")
    call_id = f"echo_call_{turn_seq:04d}"
    turn_id = f"echo_turn_{turn_seq:04d}"

    if text.startswith("NATIVE_DANGER_INDUCE:"):
        danger_target = text.split(":", 1)[1]
        if danger_target.startswith("/tmp/oc-drvtest-") and "Bash" in native_tools:
            pathlib.Path(danger_target).write_text("native-escaped", encoding="utf-8")
        sys.stdout.write(json.dumps({
            "ev": "tool_observed",
            "sessionId": session_id,
            "callId": call_id,
            "server": "native",
            "name": "Bash",
            "arguments": {"command": "touch " + danger_target},
        }, separators=(",", ":")) + "\\n")
        sys.stdout.flush()
        continue

    if text.startswith("UNOBSERVED_FORGED:"):
        parts = text.split(":")
        fpath, tok = parts[1], parts[2]
        call_mcp([{
            "jsonrpc": "2.0",
            "id": 900 + turn_seq,
            "method": "tools/call",
            "params": {
                "name": write_alias,
                "arguments": {"file_path": fpath, "content": tok},
                "_meta": {"echo/callId": "echo_forged_unobserved"},
            },
        }])
        continue

    if text.startswith("ARGS_HASH_MISMATCH:"):
        _, fpath, tok = text.split(":", 2)
        sys.stdout.write(json.dumps({
            "ev": "tool_observed",
            "sessionId": session_id,
            "callId": call_id,
            "server": "ocbridge",
            "name": write_alias,
            "arguments": {"file_path": fpath, "content": "BENIGN_OBSERVED"},
        }, separators=(",", ":")) + "\\n")
        sys.stdout.flush()
        call_mcp([{
            "jsonrpc": "2.0",
            "id": 910 + turn_seq,
            "method": "tools/call",
            "params": {
                "name": write_alias,
                "arguments": {"file_path": fpath, "content": tok},
                "_meta": {"echo/callId": call_id},
            },
        }])
        continue

    if text.startswith("PARTIAL_DELTA_ONLY:"):
        _, fpath, tok = text.split(":", 2)
        sys.stdout.write(json.dumps({
            "ev": "partial_args",
            "sessionId": session_id,
            "partialJson": "{\\"file_path\\":",
        }, separators=(",", ":")) + "\\n")
        sys.stdout.flush()
        call_mcp([{
            "jsonrpc": "2.0",
            "id": 920 + turn_seq,
            "method": "tools/call",
            "params": {
                "name": write_alias,
                "arguments": {"file_path": fpath, "content": tok},
                "_meta": {"echo/callId": call_id},
            },
        }])
        continue

    if text.startswith("MCP_BEFORE_OBSERVATION:"):
        _, fpath, tok = text.split(":", 2)
        call_mcp([{
            "jsonrpc": "2.0",
            "id": 925 + turn_seq,
            "method": "tools/call",
            "params": {
                "name": write_alias,
                "arguments": {"file_path": fpath, "content": tok},
                "_meta": {"echo/callId": call_id},
            },
        }])
        continue

    if text.startswith("BARRIER_WAIT:"):
        _, arrive_f, release_f, fpath, tok = text.split(":", 4)
        pathlib.Path(arrive_f).write_text("arrived", encoding="utf-8")
        deadline = time.monotonic() + 15.0
        while time.monotonic() < deadline and not pathlib.Path(release_f).exists():
            time.sleep(0.02)
        text = f"SENTINEL_WRITE:{fpath}:{tok}"

    if text.startswith("SENTINEL_WRITE:"):
        parts = text.split(":")
        fpath, tok = parts[1], parts[2]
        dup = len(parts) > 3 and parts[3] == "DUP_CONCURRENT"
        tool_args = {"file_path": fpath, "content": tok}
        sys.stdout.write(json.dumps({
            "ev": "tool_observed",
            "sessionId": session_id,
            "callId": call_id,
            "server": "ocbridge",
            "name": write_alias,
            "arguments": tool_args,
        }, separators=(",", ":")) + "\\n")
        sys.stdout.flush()
        mcp_req = {
            "jsonrpc": "2.0",
            "id": 100 + turn_seq,
            "method": "tools/call",
            "params": {
                "name": write_alias,
                "arguments": tool_args,
                "_meta": {"echo/callId": call_id},
            },
        }
        if dup:
            raw_line = json.dumps(mcp_req, separators=(",", ":")) + "\\n"
            t1 = threading.Thread(target=lambda: subprocess.Popen([oc_srv["command"], *oc_srv["args"]], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True).communicate(raw_line, timeout=15))
            t2 = threading.Thread(target=lambda: subprocess.Popen([oc_srv["command"], *oc_srv["args"]], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True).communicate(raw_line, timeout=15))
            t1.start(); t2.start()
            t1.join(); t2.join()
        else:
            call_mcp([mcp_req])

    sys.stdout.write(json.dumps({
        "ev": "delta",
        "sessionId": session_id,
        "text": f"echo-ok-{turn_seq}",
    }, separators=(",", ":")) + "\\n")
    done_frame = {
        "ev": "done",
        "sessionId": session_id,
        "turnId": turn_id,
        "status": "success",
        "usage": {
            "input_tokens": 1000000 * turn_seq,
            "output_tokens": 200000 * turn_seq,
            "cache_read_tokens": 100000,
        },
    }
    sys.stdout.write(json.dumps(done_frame, separators=(",", ":")) + "\\n")
    sys.stdout.flush()
"""


def usage_policy() -> Dict[str, Any]:
    return {
        "semanticsId": SEMANTICS_ID,
        "mode": "per_turn",
        "inputField": "input_tokens",
        "outputField": "output_tokens",
        "cacheReadField": "cache_read_tokens",
        "inputIncludesCacheRead": False,
        "outputIncludesReasoning": True,
        "allowCacheWrite": False,
    }


def _policy_hash(native_tools_flag: str) -> str:
    return remote_canonical_sha256(
        {
            "driverId": DRIVER_ID,
            "driverVersion": DRIVER_VERSION,
            "nativeTools": native_tools_flag,
            "ocbridgeOnly": native_tools_flag == "",
        }
    )


def launch_spec(context: Dict[str, Any], verified_probe: Dict[str, Any]) -> Dict[str, Any]:
    need(isinstance(context, dict) and isinstance(verified_probe, dict), "ECHO_LAUNCH_CONTEXT_INVALID")
    root = Path(context["root"]).resolve()
    need(str(root).startswith("/tmp/oc-drvtest-"), "ECHO_SANDBOX_ONLY")
    model = context.get("model")
    probed_models = {
        m["upstreamModelId"]: m
        for m in (verified_probe.get("models") or [])
        if isinstance(m, dict) and isinstance(m.get("upstreamModelId"), str)
    }
    need(isinstance(model, str) and model in probed_models, "ECHO_MODEL_NOT_OBSERVED")

    mcp_client_path = str(Path(context["mcpClientPath"]).resolve())
    tools_obj = context.get("tools")
    need(
        isinstance(tools_obj, dict)
        and isinstance(tools_obj.get("tools"), list)
        and 1 <= len(tools_obj["tools"]) <= 128,
        "ECHO_TOOLS_CATALOG_INVALID",
    )

    tool_names = [str(t["name"]) for t in tools_obj["tools"] if isinstance(t, dict) and isinstance(t.get("name"), str)]
    need(len(tool_names) >= 1, "ECHO_TOOLS_CATALOG_INVALID")
    write_alias = tool_names[0]
    for t in tools_obj["tools"]:
        if isinstance(t, dict) and t.get("name") == "Write":
            write_alias = "Write"
            break
        props = ((t.get("inputSchema") if isinstance(t, dict) else None) or {}).get("properties") or {}
        if isinstance(props, dict) and ("file_path" in props and "content" in props):
            write_alias = str(t["name"])
            break

    extra_native_tools: List[str] = []
    if str(root).startswith("/tmp/oc-drvtest-") and isinstance(context.get("testFaultAllowNativeTools"), list):
        extra_native_tools = [str(x) for x in context["testFaultAllowNativeTools"]]
    native_tools_flag = ",".join(extra_native_tools)

    existing_session = context.get("nativeSessionId")
    if isinstance(existing_session, str) and existing_session and existing_session != "new":
        need(IDENT_RE.fullmatch(existing_session), "ECHO_SESSION_ID_INVALID")
        session_id = existing_session
    else:
        op_id = str(context.get("operationId") or uuid.uuid4())
        session_id = str(uuid.uuid5(uuid.NAMESPACE_OID, f"example-echo:{op_id}"))

    mcp_config = {
        "mcpServers": {
            "ocbridge": {
                "type": "stdio",
                "command": "/usr/bin/python3",
                "args": ["-I", "-B", mcp_client_path, str(root)],
            }
        }
    }
    files: Dict[str, Dict[str, Any]] = {
        "mcp.json": {"content": json.dumps(mcp_config, separators=(",", ":")), "mode": 0o400},
        "echo_agent.py": {"content": ECHO_AGENT_SOURCE, "mode": 0o400},
    }

    return {
        "argv": [
            "/usr/bin/python3",
            "-I",
            "-B",
            str(root / "echo_agent.py"),
            "--model",
            model,
            "--session-id",
            session_id,
            "--mcp-config",
            str(root / "mcp.json"),
            "--tool-names",
            ",".join(tool_names),
            "--write-alias",
            write_alias,
            "--native-tools",
            native_tools_flag,
        ],
        "environment": {
            "HOME": str(root / "home"),
            "PATH": "/usr/bin:/bin",
            "LANG": "C.UTF-8",
            "TMPDIR": str(root / "tmp"),
        },
        "cwd": str(root / "cwd"),
        "policySha256": _policy_hash(native_tools_flag),
        "files": files,
        "dirs": ["run"],
        "artifactDigests": {"/usr/bin/python3": str(verified_probe["cliSha256"])},
    }


def encode(command: Dict[str, Any], native_state: Dict[str, Any]) -> Dict[str, Any]:
    kind = command.get("kind")
    cmd_id = command.get("commandId")
    need(isinstance(cmd_id, str) and IDENT_RE.fullmatch(cmd_id), "ECHO_COMMAND_ID_INVALID")
    state = dict(native_state)
    lines: List[str] = []
    immediate: List[Dict[str, Any]] = []

    if kind == "initialize":
        if state.get("initialized") is True and isinstance(state.get("sessionId"), str):
            immediate.append(
                {
                    "commandId": cmd_id,
                    "commandKind": "initialize",
                    "ok": True,
                    "nativeSessionId": state["sessionId"],
                    "upstreamModel": state.get("observedModel") or command.get("model"),
                }
            )
        else:
            state["pendingInitCommandId"] = cmd_id
            state["expectedModel"] = command.get("model") or state.get("expectedModel")

    elif kind == "resume":
        target = command.get("nativeSessionId")
        need(isinstance(target, str) and (target == "new" or IDENT_RE.fullmatch(target)), "ECHO_RESUME_ID_INVALID")
        if state.get("sessionId"):
            need(target in ("new", state["sessionId"]), "ECHO_SESSION_MISMATCH")
            immediate.append(
                {
                    "commandId": cmd_id,
                    "commandKind": "resume",
                    "ok": True,
                    "nativeSessionId": state["sessionId"],
                    "upstreamModel": state.get("observedModel") or command.get("model"),
                }
            )
        else:
            if target != "new":
                state["expectedSessionId"] = target
            state["pendingResumeCommandId"] = cmd_id

    elif kind == "newTurn":
        prompt = command.get("prompt")
        need(isinstance(prompt, str) and len(prompt.strip()) > 0, "ECHO_EMPTY_PROMPT")
        if state.get("activeTurn"):
            raise ValueError("ECHO_TURN_ALREADY_ACTIVE")
        state["activeTurn"] = True
        lines.append(json.dumps({"op": "turn", "prompt": prompt}, ensure_ascii=False, separators=(",", ":")))
        immediate.append(
            {
                "commandId": cmd_id,
                "commandKind": "newTurn",
                "ok": True,
                "nativeSessionId": state.get("sessionId"),
            }
        )

    elif kind == "interrupt":
        state["pendingInterruptCommandId"] = cmd_id
        lines.append(json.dumps({"op": "interrupt", "commandId": cmd_id}, separators=(",", ":")))

    elif kind == "readState":
        immediate.append(
            {
                "commandId": cmd_id,
                "commandKind": "readState",
                "ok": True,
                "nativeSessionId": state.get("sessionId"),
            }
        )
    else:
        raise ValueError("ECHO_UNKNOWN_COMMAND")

    return {"lines": lines, "nextNativeState": state, "immediateControlReplies": immediate}


def decode(channel: str, raw_frame: bytes, native_state: Dict[str, Any]) -> Dict[str, Any]:
    state = dict(native_state)
    frame = strict_json(raw_frame)
    need(isinstance(frame, dict), "ECHO_FRAME_NOT_OBJECT")

    if channel == "fixed_mcp":
        ident = frame.get("id")
        method = frame.get("method")
        need(method == "tools/call" and isinstance(ident, (str, int)) and not isinstance(ident, bool), "ECHO_MCP_INVALID")
        params = frame.get("params")
        need(isinstance(params, dict), "ECHO_MCP_PARAMS_INVALID")
        meta = params.get("_meta")
        call_id = meta.get("echo/callId") if isinstance(meta, dict) else None
        name = params.get("name")
        args = params.get("arguments")
        need(
            isinstance(call_id, str)
            and IDENT_RE.fullmatch(call_id)
            and call_id != ident
            and isinstance(name, str)
            and TOOL_ALIAS_RE.fullmatch(name)
            and type(args) is dict,
            "ECHO_MCP_CORRELATION_INVALID",
        )
        sess_id = state.get("sessionId")
        need(isinstance(sess_id, str) and IDENT_RE.fullmatch(sess_id), "ECHO_MCP_MISSING_SESSION")
        return {
            "securityEvents": [],
            "presentation": [],
            "controlReplies": [],
            "pendingToolRequest": {
                "rpcId": ident,
                "callId": call_id,
                "nativeSessionId": sess_id,
                "server": "ocbridge",
                "name": name,
                "arguments": args,
                "argsHash": remote_canonical_sha256(args),
            },
            "nextNativeState": state,
        }

    need(channel == "native", "ECHO_UNSUPPORTED_DECODE_CHANNEL")
    security_events: List[Dict[str, Any]] = []
    presentation: List[Dict[str, Any]] = []
    control_replies: List[Dict[str, Any]] = []

    sess = frame.get("sessionId")
    if sess is not None:
        need(isinstance(sess, str) and IDENT_RE.fullmatch(sess), "ECHO_INVALID_SESSION_ID")
        if state.get("expectedSessionId"):
            need(sess == state["expectedSessionId"], "ECHO_SESSION_ID_MISMATCH")
        if state.get("sessionId"):
            need(sess == state["sessionId"], "ECHO_SESSION_ID_CHANGED")
        state["sessionId"] = sess

    ev = frame.get("ev")
    if ev == "ready":
        model = frame.get("model")
        if state.get("expectedModel") and model:
            need(model == state["expectedModel"], "ECHO_MODEL_MISMATCH")
        if isinstance(model, str):
            state["observedModel"] = model
        state["initialized"] = True
        for tname in frame.get("tools") or []:
            if not (isinstance(tname, str) and tname.startswith("ocbridge:")):
                security_events.append(
                    {
                        "kind": "disallowedItem",
                        "reason": "native_tool_advertised",
                        "itemType": str(tname)[:120] or "unknown_tool",
                    }
                )
        if state.get("pendingInitCommandId") and state.get("sessionId"):
            control_replies.append(
                {
                    "commandId": state.pop("pendingInitCommandId"),
                    "commandKind": "initialize",
                    "ok": True,
                    "nativeSessionId": state["sessionId"],
                    "upstreamModel": state.get("observedModel"),
                }
            )
        if state.get("pendingResumeCommandId") and state.get("sessionId"):
            control_replies.append(
                {
                    "commandId": state.pop("pendingResumeCommandId"),
                    "commandKind": "resume",
                    "ok": True,
                    "nativeSessionId": state["sessionId"],
                    "upstreamModel": state.get("observedModel"),
                }
            )

    elif ev == "tool_observed":
        server = frame.get("server")
        name = frame.get("name")
        call_id = frame.get("callId")
        args = frame.get("arguments")
        if server != "ocbridge":
            security_events.append(
                {
                    "kind": "disallowedItem",
                    "reason": "non_ocbridge_tool_call",
                    "itemType": str(name)[:120] or "native_tool",
                }
            )
        else:
            need(
                isinstance(call_id, str)
                and IDENT_RE.fullmatch(call_id)
                and isinstance(name, str)
                and TOOL_ALIAS_RE.fullmatch(name)
                and type(args) is dict,
                "ECHO_TOOL_OBSERVED_INVALID",
            )
            security_events.append(
                {
                    "kind": "toolCallObserved",
                    "callId": call_id,
                    "name": name,
                    "argsHash": remote_canonical_sha256(args),
                    "arguments": args,
                    "phase": "started",
                }
            )

    elif ev == "partial_args":
        pass

    elif ev == "delta":
        txt = frame.get("text")
        if isinstance(txt, str) and txt:
            security_events.append({"kind": "textDelta", "channel": "answer", "delta": txt})
            presentation.append({"kind": "text_delta", "text": txt})

    elif ev == "interrupt_ack":
        cid = frame.get("commandId")
        if isinstance(cid, str) and cid == state.get("pendingInterruptCommandId"):
            state.pop("pendingInterruptCommandId", None)
            control_replies.append({"commandId": cid, "commandKind": "interrupt", "ok": True})

    elif ev == "done":
        need(state.get("sessionId") and frame.get("sessionId") == state["sessionId"], "ECHO_DONE_SESSION_MISMATCH")
        turn_id = frame.get("turnId")
        need(isinstance(turn_id, str) and IDENT_RE.fullmatch(turn_id), "ECHO_DONE_ID_INVALID")
        state["activeTurn"] = False
        usage = frame.get("usage")
        need(isinstance(usage, dict), "ECHO_USAGE_MISSING")
        counters: Dict[str, int] = {}
        for k in ("input_tokens", "output_tokens", "cache_read_tokens"):
            val = usage.get(k)
            need(type(val) is int and val >= 0, "ECHO_USAGE_INVALID")
            counters[k] = val
        status = frame.get("status")
        need(status in ("success", "error", "interrupted"), "ECHO_STATUS_INVALID")
        security_events.append(
            {
                "kind": "usage",
                "sampleId": turn_id,
                "scopeId": turn_id,
                "semanticsId": SEMANTICS_ID,
                "rawCounters": counters,
            }
        )
        term_ev: Dict[str, Any] = {"kind": "turnTerminal", "terminalId": turn_id, "status": status}
        if status == "error":
            term_ev["errorCode"] = "ECHO_TURN_ERROR"
        security_events.append(term_ev)

    else:
        raise ValueError("ECHO_UNKNOWN_FRAME")

    return {
        "securityEvents": security_events,
        "presentation": presentation,
        "controlReplies": control_replies,
        "nextNativeState": state,
    }


def probe(context: Dict[str, Any], previous_step_result: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    need(isinstance(context, dict), "ECHO_PROBE_CONTEXT_INVALID")
    probe_root = str(Path(str(context.get("probeRoot") or context.get("root") or "")).resolve()) if (context.get("probeRoot") or context.get("root")) else ""
    need(probe_root.startswith("/tmp/oc-drvtest-"), "ECHO_SANDBOX_ONLY")
    if previous_step_result is None:
        return {
            "kind": "step",
            "step": {
                "argv": ["/usr/bin/python3", "-I", "-B", "-c", PROBE_SCRIPT],
                "stdinLines": [json.dumps({"op": "hello"}, separators=(",", ":"))],
                "environment": {"OC_EXAMPLE_ECHO_PROBE": "1"},
                "timeoutSec": 10,
                "hashFiles": {"cli": "/usr/bin/python3"},
            },
        }

    lines = previous_step_result.get("stdoutLines") or []
    parsed: Optional[Dict[str, Any]] = None
    for line in lines:
        if line.strip():
            obj = strict_json(line)
            if isinstance(obj, dict) and isinstance(obj.get("models"), list):
                parsed = obj
                break
    need(isinstance(parsed, dict), "ECHO_PROBE_OUTPUT_MISSING")

    models: List[Dict[str, Any]] = []
    for m in parsed["models"]:
        if not isinstance(m, dict):
            continue
        mid = str(m.get("id") or "").strip()
        if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,63}", mid):
            continue
        efforts = [str(e) for e in (m.get("efforts") or ["medium"])]
        models.append(
            {
                "upstreamModelId": mid,
                "displayName": str(m.get("displayName") or mid),
                "supportedEfforts": efforts,
                "defaultEffort": "medium" if "medium" in efforts else efforts[0],
                "supportsAdaptiveThinking": bool(m.get("adaptiveThinking", False)),
                "supportsVision": True,
            }
        )
    need(len(models) > 0, "ECHO_PROBE_MODELS_EMPTY")

    acct = parsed.get("account") if isinstance(parsed.get("account"), dict) else {}
    snapshot: Dict[str, Any] = {
        "schemaVersion": 4,
        "engineId": ENGINE_ID,
        "driverId": DRIVER_ID,
        "driverVersion": DRIVER_VERSION,
        "source": "example-echo:hello",
        "freshness": "cli-observed",
        "authPresent": bool(acct.get("email")),
        "accountObserved": bool(acct.get("email")),
        "accountHint": "ec***@example.com",
        "planType": str(acct.get("plan") or "pro"),
        "cliVersion": str(parsed.get("version") or "1.0.0"),
        "cliSha256": previous_step_result["artifactHashes"]["cli"],
        "models": models,
        "rawResponseSha256": previous_step_result["stdoutSha256"],
        "observedAt": datetime.now(timezone.utc).isoformat(),
    }
    return {"kind": "snapshot", "snapshot": snapshot, "policySha256": _policy_hash("")}
