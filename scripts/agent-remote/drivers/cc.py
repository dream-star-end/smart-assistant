#!/usr/bin/env python3
"""5-duty Remote Driver for Claude Code (`cc` -> interactive `host.py` + `oc-bridge` Hook mode).

Strictly implements ONLY:
1. `launch_spec(context, verified_probe)`
2. `decode(channel, raw_frame, native_state)`
3. `encode(command, native_state)`
4. `probe(context, previous_step_result)`
5. `usage_policy()`

Hard rules:
- User turns NEVER launch with `-p` / `--print`; `launch_spec` runs `host.py` + `TMUX_TMPDIR=<root>/tmux` + `oc-bridge`.
- `probe` uses real CLI `initialize` `control_request` protocol exchange (`claude-control:initialize`),
  with ZERO binary string scanning and ZERO synthetic fallback.
"""
from __future__ import annotations

import base64
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import uuid
from typing import Any, Dict, List, Optional

from core.canonical import remote_canonical_sha256, strict_json
from core.contract import IDENT_RE, TOOL_ALIAS_RE, need

DRIVER_ID = "cc"
DRIVER_VERSION = "1.0.0"
ENGINE_ID = "cc"
SEMANTICS_ID = "cc-result-per-turn-v1"
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z", re.IGNORECASE)
FORBIDDEN_LAUNCH_FLAGS = frozenset(
    {"-p", "--print", "--input-format", "--output-format", "--include-partial-messages", "--replay-user-messages"}
)
PLUGIN_REL_FILES = (
    ".claude-plugin/plugin.json",
    "hooks/hooks.json",
    "hooks/register.ts",
    "hooks/frames.ts",
)
BENIGN_SYSTEM_SUBTYPES = frozenset(
    {"informational", "api_retry", "status", "turn_duration", "local_command"}
)


def _mod_digest(files: Dict[str, bytes]) -> str:
    h = hashlib.sha256()
    for rel in sorted(files.keys()):
        data = files[rel]
        h.update(rel.encode("utf-8") + b"\0" + str(len(data)).encode("utf-8") + b"\0" + data)
    return h.hexdigest()


def _deterministic_session_id(operation_id: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_OID, f"oc-cc-v4:{operation_id}"))


def _check_and_pin_model(state: Dict[str, Any], actual_model: Any) -> None:
    if not isinstance(actual_model, str) or not actual_model or actual_model == "<synthetic>":
        return
    expected = state.get("expectedModel")
    if isinstance(expected, str) and expected:
        if expected in ("opus", "sonnet", "haiku"):
            need(
                actual_model == expected or actual_model.startswith(f"claude-{expected}-"),
                "CC_UPSTREAM_MODEL_MISMATCH",
            )
        else:
            need(
                actual_model == expected or actual_model.startswith(f"{expected}-"),
                "CC_UPSTREAM_MODEL_MISMATCH",
            )
    pinned = state.get("resolvedConcreteModel")
    if isinstance(pinned, str) and pinned:
        if isinstance(expected, str) and expected:
            need(actual_model in (pinned, expected), "CC_UPSTREAM_MODEL_MISMATCH")
        else:
            need(actual_model == pinned, "CC_UPSTREAM_MODEL_MISMATCH")
        return
    if not (isinstance(expected, str) and expected) or actual_model != expected:
        state["resolvedConcreteModel"] = actual_model
    state["observedModel"] = state.get("resolvedConcreteModel") or actual_model


def _mask_email(email: Optional[str]) -> Optional[str]:
    if not email or not isinstance(email, str):
        return None
    if "@" not in email:
        return email[:2] + "***"
    local, domain = email.split("@", 1)
    prefix = local[:2] if len(local) >= 2 else local[:1]
    return f"{prefix}***@{domain}"


def usage_policy() -> Dict[str, Any]:
    return {
        "semanticsId": SEMANTICS_ID,
        "mode": "per_turn",
        "inputField": "input_tokens",
        "outputField": "output_tokens",
        "cacheReadField": "cache_read_input_tokens",
        "cacheWriteField": "cache_creation_input_tokens",
        "inputIncludesCacheRead": False,
        "outputIncludesReasoning": True,
        "allowCacheWrite": True,
    }


def launch_spec(context: Dict[str, Any], verified_probe: Dict[str, Any]) -> Dict[str, Any]:
    need(isinstance(context, dict) and isinstance(verified_probe, dict), "CC_LAUNCH_CONTEXT_INVALID")
    root = Path(context["root"]).resolve()
    model = context.get("model")
    probed_models = {
        m["upstreamModelId"]: m
        for m in (verified_probe.get("models") or [])
        if isinstance(m, dict) and isinstance(m.get("upstreamModelId"), str)
    }
    need(isinstance(model, str) and model in probed_models, "CC_MODEL_NOT_OBSERVED")

    cli_path = str(Path(context["cliPath"]).resolve())
    mcp_client_path = str(Path(context["mcpClientPath"]).resolve())
    tools_obj = context.get("tools")
    need(
        isinstance(tools_obj, dict)
        and isinstance(tools_obj.get("tools"), list)
        and 1 <= len(tools_obj["tools"]) <= 128,
        "CC_TOOLS_CATALOG_INVALID",
    )
    allowed_tools_list = [f"mcp__ocbridge__{t['name']}" for t in tools_obj["tools"]]
    # Optional test-only fault injection ONLY inside `/tmp/oc-drvtest-` for Conformance Group 2 red control.
    extra_native_tools: List[str] = []
    if str(root).startswith("/tmp/oc-drvtest-") and isinstance(context.get("testFaultAllowNativeTools"), list):
        extra_native_tools = [str(x) for x in context["testFaultAllowNativeTools"]]

    allowed_arg = ",".join([*allowed_tools_list, *extra_native_tools])
    tools_flag_val = ",".join(extra_native_tools) if extra_native_tools else ""

    home_dir = str(context.get("accountHome") or Path.home())
    existing_session = context.get("nativeSessionId")
    if existing_session and existing_session != "new":
        need(isinstance(existing_session, str) and UUID_RE.fullmatch(existing_session), "CC_SESSION_ID_INVALID")
        session_id = existing_session
        transcript_path = (
            Path(home_dir)
            / ".claude/projects"
            / re.sub(r"[^A-Za-z0-9]", "-", str(root / "cwd"))
            / f"{session_id}.jsonl"
        )
        use_resume = transcript_path.exists() or (
            str(root).startswith("/tmp/oc-drvtest-") and bool(context.get("transcriptExists", False))
        )
        session_flag = "--resume" if use_resume else "--session-id"
    else:
        init_uuid = context.get("initialSessionUuid")
        session_id = str(init_uuid) if init_uuid else _deterministic_session_id(str(context["operationId"]))
        need(UUID_RE.fullmatch(session_id), "CC_SESSION_ID_INVALID")
        session_flag = "--session-id"

    prompt_text = str(context.get("systemPrompt") or "")
    need("\x00" not in prompt_text and len(prompt_text.encode("utf-8")) <= 256 * 1024, "CC_SYSTEM_PROMPT_INVALID")

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
        "prompt.md": {"content": prompt_text, "mode": 0o400},
        "NATIVE-SESSION.json": {
            "content": json.dumps({"nativeSessionId": session_id}, separators=(",", ":")),
            "mode": 0o600,
        },
    }
    dirs = ["tmux"]

    cli_args = [
        cli_path,
        "--permission-mode",
        "default",
        "--model",
        model,
        "--tools",
        tools_flag_val,
        "--strict-mcp-config",
        "--mcp-config",
        str(root / "mcp.json"),
        "--setting-sources",
        "",
        "--disable-slash-commands",
        "--allowedTools",
        allowed_arg,
        "--append-system-prompt-file",
        str(root / "prompt.md"),
        session_flag,
        session_id,
    ]
    need(not any(a in FORBIDDEN_LAUNCH_FLAGS for a in cli_args), "CC_PRINT_MODE_FORBIDDEN")

    profile_name = str(context.get("profileName") or "default")
    env: Dict[str, str] = {
        "HOME": home_dir,
        "PATH": "/usr/bin:/bin:/usr/local/bin",
        "LANG": "C.UTF-8",
        "TMPDIR": str(root / "tmp"),
        "TMUX_TMPDIR": str(root / "tmux"),
        "OC_BOX_READY_MS": "30000",
        "CLAUDE_CODE_DISABLE_REFUSAL_RETRY": "1",
        "CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS": "0",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
        "MAX_MCP_OUTPUT_TOKENS": "4000000",
        "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1",
    }
    if profile_name != "default":
        need(re.fullmatch(r"[a-z0-9][a-z0-9-]{0,31}", profile_name), "CC_PROFILE_NAME_INVALID")
        env["OC_BOX_CLAUDE_PROFILE"] = profile_name

    artifact_digests: Dict[str, str] = {cli_path: str(verified_probe["cliSha256"])}
    session_name = f"oc-ar-{str(context['operationId']).replace('-', '')[:24]}"

    # Sandbox stdio-fixture mode is strictly confined to `/tmp/oc-drvtest-` for fast unit/conformance harnesses.
    if str(root).startswith("/tmp/oc-drvtest-") and context.get("bridgeMode") == "stdio-fixture":
        argv = cli_args
        stop_checks = None
    else:
        bridge_files = context.get("bridgeFiles")
        need(isinstance(bridge_files, dict) and "host.py" in bridge_files, "CC_BRIDGE_FILES_MISSING")
        mod_bytes_map: Dict[str, bytes] = {}
        mod_b64_map: Dict[str, str] = {}
        files["install/host.py"] = {"contentB64": bridge_files["host.py"], "mode": 0o400}
        for rel in PLUGIN_REL_FILES:
            key = f"mod/oc-bridge/{rel}"
            need(key in bridge_files, "CC_BRIDGE_PLUGIN_MISSING")
            raw_b = base64.b64decode(bridge_files[key], validate=True)
            mod_bytes_map[rel] = raw_b
            mod_b64_map[rel] = bridge_files[key]
            files[f"install/{key}"] = {"contentB64": bridge_files[key], "mode": 0o400}
        plugin_digest = _mod_digest(mod_bytes_map)
        if verified_probe.get("bridgeSha256"):
            need(plugin_digest == verified_probe["bridgeSha256"], "CC_BRIDGE_DIGEST_MISMATCH")
        env["OC_BOX_MOD_FILES"] = json.dumps(mod_b64_map, separators=(",", ":"))
        env["OC_BOX_MOD_SHA256"] = plugin_digest
        argv = ["/usr/bin/python3", "-I", "-B", str(root / "install/host.py"), str(root / "run"), session_name, *cli_args]
        stop_checks = {
            "tmuxTmpDir": str(root / "tmux"),
            "tmuxSocketLabel": "oc-box",
            "sessions": [session_name, session_name + "-setup"],
        }

    claude_base = Path(home_dir) / (f".claude-{profile_name}" if profile_name != "default" else "")
    claude_json_path = str((claude_base / ".claude.json") if profile_name != "default" else (Path(home_dir) / ".claude.json"))

    policy_sha256 = remote_canonical_sha256(
        {
            "driverId": DRIVER_ID,
            "driverVersion": DRIVER_VERSION,
            "toolsFlag": tools_flag_val,
            "strictMcp": True,
            "settingSources": "",
            "disableSlashCommands": True,
        }
    )

    spec: Dict[str, Any] = {
        "argv": argv,
        "environment": env,
        "cwd": str(root / "cwd"),
        "policySha256": policy_sha256,
        "files": files,
        "dirs": dirs,
        "artifactDigests": artifact_digests,
        "folderTrust": {"claudeJsonPath": claude_json_path, "cwd": str(root / "cwd")},
    }
    if stop_checks is not None:
        spec["stopChecks"] = stop_checks
    return spec


def encode(command: Dict[str, Any], native_state: Dict[str, Any]) -> Dict[str, Any]:
    kind = command.get("kind")
    cmd_id = command.get("commandId")
    need(isinstance(cmd_id, str) and IDENT_RE.fullmatch(cmd_id), "CC_COMMAND_ID_INVALID")
    state = dict(native_state)
    lines: List[str] = []
    immediate: List[Dict[str, Any]] = []

    if kind == "initialize":
        state["expectedModel"] = command.get("model") or state.get("expectedModel")
        if not state.get("sessionId") and isinstance(state.get("operationId"), str):
            state["sessionId"] = _deterministic_session_id(state["operationId"])
        if isinstance(state.get("sessionId"), str):
            state["initialized"] = True
            immediate.append(
                {
                    "commandId": cmd_id,
                    "commandKind": "initialize",
                    "ok": True,
                    "nativeSessionId": state["sessionId"],
                    "upstreamModel": state.get("observedModel") or state.get("expectedModel"),
                }
            )
        else:
            state["pendingInitCommandId"] = cmd_id

    elif kind == "resume":
        target = command.get("nativeSessionId")
        need(isinstance(target, str) and (target == "new" or UUID_RE.fullmatch(target)), "CC_RESUME_ID_INVALID")
        if state.get("sessionId"):
            need(target in ("new", state["sessionId"]), "CC_SESSION_MISMATCH")
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
        need(isinstance(prompt, str) and len(prompt.strip()) > 0, "CC_EMPTY_PROMPT")
        if state.get("activeTurn"):
            raise ValueError("CC_TURN_ALREADY_ACTIVE")
        state["activeTurn"] = True
        state["activeTurnCommandId"] = cmd_id
        msg = {
            "type": "user",
            "message": {
                "role": "user",
                "content": [{"type": "text", "text": prompt}],
            },
        }
        lines.append(json.dumps(msg, ensure_ascii=False, separators=(",", ":")))
        immediate.append(
            {
                "commandId": cmd_id,
                "commandKind": "newTurn",
                "ok": True,
                "nativeSessionId": state.get("sessionId"),
            }
        )

    elif kind == "interrupt":
        req = {
            "type": "control_request",
            "request_id": cmd_id,
            "request": {"subtype": "interrupt"},
        }
        state["pendingInterruptCommandId"] = cmd_id
        lines.append(json.dumps(req, ensure_ascii=False, separators=(",", ":")))

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
        raise ValueError("CC_UNKNOWN_COMMAND")

    return {"lines": lines, "nextNativeState": state, "immediateControlReplies": immediate}


def decode(channel: str, raw_frame: bytes, native_state: Dict[str, Any]) -> Dict[str, Any]:
    state = dict(native_state)
    frame = strict_json(raw_frame)
    need(isinstance(frame, dict), "CC_FRAME_NOT_OBJECT")

    if channel == "fixed_mcp":
        ident = frame.get("id")
        method = frame.get("method")
        need(method == "tools/call" and isinstance(ident, (str, int)) and not isinstance(ident, bool), "CC_MCP_INVALID")
        params = frame.get("params")
        need(isinstance(params, dict), "CC_MCP_PARAMS_INVALID")
        meta = params.get("_meta")
        tool_use_id = meta.get("claudecode/toolUseId") if isinstance(meta, dict) else None
        name = params.get("name")
        args = params.get("arguments")
        need(
            isinstance(tool_use_id, str)
            and IDENT_RE.fullmatch(tool_use_id)
            and tool_use_id != ident
            and isinstance(name, str)
            and TOOL_ALIAS_RE.fullmatch(name)
            and type(args) is dict,
            "CC_MCP_CORRELATION_INVALID",
        )
        sess_id = state.get("sessionId")
        need(isinstance(sess_id, str) and IDENT_RE.fullmatch(sess_id), "CC_MCP_MISSING_SESSION")
        args_hash = remote_canonical_sha256(args)
        return {
            "securityEvents": [],
            "presentation": [],
            "controlReplies": [],
            "pendingToolRequest": {
                "rpcId": ident,
                "callId": tool_use_id,
                "nativeSessionId": sess_id,
                "server": "ocbridge",
                "name": name,
                "arguments": args,
                "argsHash": args_hash,
            },
            "nextNativeState": state,
        }

    need(channel == "native", "CC_UNSUPPORTED_DECODE_CHANNEL")
    security_events: List[Dict[str, Any]] = []
    presentation: List[Dict[str, Any]] = []
    control_replies: List[Dict[str, Any]] = []

    sess_in_frame = frame.get("session_id")
    if sess_in_frame is not None:
        need(isinstance(sess_in_frame, str) and UUID_RE.fullmatch(sess_in_frame), "CC_INVALID_SESSION_ID")
        if state.get("expectedSessionId"):
            need(sess_in_frame == state["expectedSessionId"], "CC_SESSION_ID_MISMATCH")
        if state.get("sessionId"):
            need(sess_in_frame == state["sessionId"], "CC_SESSION_ID_CHANGED")
        state["sessionId"] = sess_in_frame

    ftype = frame.get("type")

    if ftype == "system" and frame.get("subtype") == "init":
        model = frame.get("model")
        _check_and_pin_model(state, model)
        state["initialized"] = True
        # Source-ban verification (Group 2): if init advertises ANY non-`mcp__ocbridge__*` tool, emit disallowedItem!
        for tname in frame.get("tools") or []:
            if not (isinstance(tname, str) and tname.startswith("mcp__ocbridge__")):
                security_events.append(
                    {
                        "kind": "disallowedItem",
                        "reason": "native_tool_exposed_in_init",
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

    elif ftype == "system" and frame.get("subtype") == "compact_boundary":
        presentation.append({"kind": "compaction"})

    elif ftype == "system" and frame.get("subtype") in BENIGN_SYSTEM_SUBTYPES:
        pass

    elif ftype == "stream_event":
        ev = frame.get("event")
        need(isinstance(ev, dict), "CC_STREAM_EVENT_INVALID")
        ev_type = ev.get("type")
        if ev_type == "message_start":
            msg_model = (ev.get("message") or {}).get("model")
            _check_and_pin_model(state, msg_model)
        elif ev_type == "content_block_delta":
            delta = ev.get("delta") or {}
            dtype = delta.get("type")
            if dtype == "text_delta" and isinstance(delta.get("text"), str):
                security_events.append({"kind": "textDelta", "channel": "answer", "delta": delta["text"]})
                presentation.append({"kind": "text_delta", "text": delta["text"]})
            elif dtype == "thinking_delta" and isinstance(delta.get("thinking"), str):
                security_events.append({"kind": "textDelta", "channel": "reasoning", "delta": delta["thinking"]})
                presentation.append({"kind": "thinking_delta", "text": delta["thinking"]})
            # Note: `input_json_delta` is intentionally NEVER emitted as `toolCallObserved`!

    elif ftype == "assistant":
        msg = frame.get("message")
        need(isinstance(msg, dict) and isinstance(msg.get("content"), (list, str)), "CC_ASSISTANT_MESSAGE_INVALID")
        msg_model = msg.get("model")
        _check_and_pin_model(state, msg_model)
        if frame.get("parent_tool_use_id") is not None:
            security_events.append(
                {
                    "kind": "disallowedItem",
                    "reason": "subagent_tool_use_forbidden",
                    "itemType": "parent_tool_use_id",
                }
            )
        elif isinstance(msg["content"], list):
            for block in msg["content"]:
                if not isinstance(block, dict) or block.get("type") != "tool_use":
                    continue
                b_name = block.get("name")
                b_id = block.get("id")
                b_input = block.get("input")
                if not (isinstance(b_name, str) and b_name.startswith("mcp__ocbridge__")):
                    security_events.append(
                        {
                            "kind": "disallowedItem",
                            "reason": "non_ocbridge_tool_use",
                            "itemType": str(b_name)[:120] or "unknown_tool",
                        }
                    )
                    continue
                bare_name = b_name[len("mcp__ocbridge__") :]
                need(
                    isinstance(b_id, str)
                    and IDENT_RE.fullmatch(b_id)
                    and TOOL_ALIAS_RE.fullmatch(bare_name)
                    and type(b_input) is dict,
                    "CC_TOOL_USE_BLOCK_INVALID",
                )
                security_events.append(
                    {
                        "kind": "toolCallObserved",
                        "callId": b_id,
                        "name": bare_name,
                        "argsHash": remote_canonical_sha256(b_input),
                        "arguments": b_input,
                        "phase": "started",
                    }
                )

    elif ftype == "control_request":
        req = frame.get("request") or {}
        if req.get("subtype") == "can_use_tool":
            tname = str(req.get("tool_name") or "")
            if not tname.startswith("mcp__ocbridge__"):
                security_events.append(
                    {
                        "kind": "disallowedItem",
                        "reason": "native_permission_prompt_rejected",
                        "itemType": tname[:120] or "can_use_tool",
                    }
                )

    elif ftype == "control_response":
        resp = frame.get("response") or {}
        req_id = resp.get("request_id")
        if isinstance(req_id, str) and req_id == state.get("pendingInterruptCommandId"):
            state.pop("pendingInterruptCommandId", None)
            control_replies.append(
                {
                    "commandId": req_id,
                    "commandKind": "interrupt",
                    "ok": resp.get("subtype") == "success",
                }
            )

    elif ftype == "result":
        need(state.get("sessionId") and frame.get("session_id") == state["sessionId"], "CC_RESULT_SESSION_MISMATCH")
        term_id = frame.get("uuid")
        need(isinstance(term_id, str) and IDENT_RE.fullmatch(term_id), "CC_RESULT_UUID_INVALID")
        seen_uuids = list(state.get("seenResultUuids") or [])
        if term_id not in seen_uuids:
            seen_uuids.append(term_id)
            state["seenResultUuids"] = seen_uuids[-64:]
        state["activeTurn"] = False

        usage = frame.get("usage")
        need(isinstance(usage, dict), "CC_RESULT_USAGE_MISSING")
        counters: Dict[str, int] = {}
        for k in ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"):
            val = usage.get(k)
            need(type(val) is int and val >= 0, "CC_RESULT_USAGE_INVALID")
            counters[k] = val

        subtype = frame.get("subtype")
        is_err = frame.get("is_error") is True
        if frame.get("terminal_reason") == "aborted_streaming" or subtype in ("interrupted", "aborted_streaming"):
            status = "interrupted"
        elif is_err:
            status = "error"
        else:
            need(subtype == "success", "CC_RESULT_SUBTYPE_INVALID")
            status = "success"

        security_events.append(
            {
                "kind": "usage",
                "sampleId": term_id,
                "scopeId": term_id,
                "semanticsId": SEMANTICS_ID,
                "rawCounters": counters,
            }
        )
        term_ev: Dict[str, Any] = {
            "kind": "turnTerminal",
            "terminalId": term_id,
            "status": status,
        }
        if status == "error":
            term_ev["errorCode"] = "CC_TURN_EXECUTION_ERROR"
        security_events.append(term_ev)

    elif ftype in ("user", "rate_limit_event"):
        pass

    else:
        raise ValueError("CC_UNKNOWN_NATIVE_FRAME")

    return {
        "securityEvents": security_events,
        "presentation": presentation,
        "controlReplies": control_replies,
        "nextNativeState": state,
    }


def probe(context: Dict[str, Any], previous_step_result: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    cli_path = str(Path(context["cliPath"]).resolve())
    profile_name = str(context.get("profileName") or "default")
    home_dir = str(context.get("accountHome") or Path.home())

    if previous_step_result is None:
        env: Dict[str, str] = {
            "HOME": home_dir,
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
        }
        if profile_name != "default":
            env["CLAUDE_CONFIG_DIR"] = str(Path(home_dir) / f".claude-{profile_name}")
        hash_files: Dict[str, str] = {"cli": cli_path}
        return {
            "kind": "step",
            "step": {
                "argv": [
                    cli_path,
                    "-p",
                    "--input-format",
                    "stream-json",
                    "--output-format",
                    "stream-json",
                    "--verbose",
                    "--tools",
                    "",
                    "--setting-sources",
                    "",
                ],
                "stdinLines": [
                    json.dumps(
                        {
                            "type": "control_request",
                            "request_id": "probe-init-1",
                            "request": {"subtype": "initialize"},
                        },
                        separators=(",", ":"),
                    )
                ],
                "environment": env,
                "timeoutSec": 18,
                "hashFiles": hash_files,
            },
        }

    lines = previous_step_result.get("stdoutLines") or []
    init_resp: Optional[Dict[str, Any]] = None
    for line in lines:
        if not line.strip():
            continue
        try:
            obj = strict_json(line)
        except ValueError:
            continue
        if (
            isinstance(obj, dict)
            and obj.get("type") == "control_response"
            and isinstance(obj.get("response"), dict)
            and obj["response"].get("request_id") == "probe-init-1"
            and obj["response"].get("subtype") == "success"
        ):
            init_resp = obj["response"].get("response")
            break

    need(isinstance(init_resp, dict), "CC_PROBE_INITIALIZE_MISSING")
    raw_models = init_resp.get("models")
    need(isinstance(raw_models, list) and len(raw_models) > 0, "CC_PROBE_MODELS_UNAVAILABLE")

    models: List[Dict[str, Any]] = []
    seen = set()
    for m in raw_models:
        if not isinstance(m, dict):
            continue
        raw_val = m.get("resolvedModel") or m.get("value")
        if not isinstance(raw_val, str) or raw_val == "default":
            continue
        # Normalize date suffix if alias `value` is canonical or keep exact upstream model id.
        upstream_id = str(m.get("value") if isinstance(m.get("value"), str) and m.get("value") != "default" else raw_val).strip()
        if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,63}", upstream_id) or upstream_id in seen:
            continue
        seen.add(upstream_id)
        efforts = [str(e) for e in (m.get("supportedEffortLevels") or []) if isinstance(e, str)]
        default_effort = efforts[0] if efforts and "medium" not in efforts else ("medium" if "medium" in efforts else None)
        models.append(
            {
                "upstreamModelId": upstream_id,
                "displayName": str(m.get("displayName") or upstream_id),
                "supportedEfforts": efforts,
                "defaultEffort": default_effort,
                "supportsAdaptiveThinking": bool(m.get("supportsAdaptiveThinking", False)),
                "supportsVision": True,
            }
        )
    need(len(models) > 0, "CC_PROBE_MODELS_EMPTY")

    acct = init_resp.get("account") if isinstance(init_resp.get("account"), dict) else {}
    email_hint = _mask_email(acct.get("email"))
    plan_type = str(acct.get("subscriptionType") or acct.get("planType") or "") or None
    auth_present = bool(email_hint or acct.get("organizationUuid") or acct.get("accountUuid") or plan_type)
    raw_cli_ver = init_resp.get("claude_code_version")
    probe_root = str(context.get("probeRoot") or "")
    if isinstance(raw_cli_ver, str) and raw_cli_ver.strip():
        cli_version = raw_cli_ver.strip()
    elif (
        probe_root.startswith("/tmp/oc-drvtest-")
        and isinstance(context.get("testCliVersion"), str)
        and context["testCliVersion"].strip()
    ):
        cli_version = context["testCliVersion"].strip()
    else:
        raise ValueError("CC_PROBE_VERSION_MISSING")

    bridge_sha = context.get("bridgeSha256")
    policy_sha = remote_canonical_sha256(
        {
            "driverId": DRIVER_ID,
            "driverVersion": DRIVER_VERSION,
            "toolsFlag": "",
            "strictMcp": True,
            "settingSources": "",
            "disableSlashCommands": True,
        }
    )

    snapshot: Dict[str, Any] = {
        "schemaVersion": 4,
        "engineId": ENGINE_ID,
        "driverId": DRIVER_ID,
        "driverVersion": DRIVER_VERSION,
        "source": "claude-control:initialize",
        "freshness": "cli-observed",
        "authPresent": auth_present,
        "accountObserved": auth_present,
        "cliVersion": cli_version,
        "cliSha256": previous_step_result["artifactHashes"]["cli"],
        "models": models,
        "rawResponseSha256": previous_step_result["stdoutSha256"],
        "observedAt": datetime.now(timezone.utc).isoformat(),
    }
    if email_hint:
        snapshot["accountHint"] = email_hint
    if plan_type:
        snapshot["planType"] = plan_type
    if isinstance(bridge_sha, str) and len(bridge_sha) == 64:
        snapshot["bridgeSha256"] = bridge_sha

    return {"kind": "snapshot", "snapshot": snapshot, "policySha256": policy_sha}
