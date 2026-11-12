#!/usr/bin/env python3
"""5-duty Remote Driver for OpenAI Codex (`codex` -> `app-server --strict-config --listen stdio://`).

Strictly implements ONLY:
1. `launch_spec(context, verified_probe)`
2. `decode(channel, raw_frame, native_state)`
3. `encode(command, native_state)`
4. `probe(context, previous_step_result)`
5. `usage_policy()`

Enforces the 5-field catalog policy (`POLICY`), feature disable flags (`CODEX_DISABLE`),
and config-source pollution rejection (`config.toml`, `AGENTS.md`, `/etc/codex/*`).
"""
from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path
import re
from typing import Any, Dict, List, Optional

from core.canonical import remote_canonical_sha256, strict_json
from core.contract import IDENT_RE, TOOL_ALIAS_RE, need

DRIVER_ID = "codex"
DRIVER_VERSION = "1.0.0"
ENGINE_ID = "codex"
SEMANTICS_ID = "codex-0.167-total-v1"

CODEX_DISABLE = (
    "shell_tool",
    "unified_exec",
    "view_image",
    "image_generation",
    "multi_agent",
    "multi_agent_v2",
    "apps",
    "plugins",
    "browser_use",
    "computer_use",
    "in_app_browser",
    "sleep_tool",
    "skill_search",
    "tool_suggest",
    "goals",
    "hooks",
    "skill_mcp_dependency_install",
)

POLICY = {
    "tool_mode": "direct",
    "multi_agent_version": "disabled",
    "experimental_supported_tools": [],
    "apply_patch_tool_type": None,
    "supports_search_tool": False,
}

ALLOWED_NATIVE_ITEMS = frozenset(
    {"agentMessage", "reasoning", "userMessage", "contextCompaction", "mcpToolCall"}
)

DISALLOWED_NOTIFICATION_PREFIXES = (
    "item/commandExecution/",
    "command/exec/",
    "process/",
    "hook/",
    "item/fileChange/",
    "item/permissions/",
    "item/tool/requestUserInput",
    "execCommandApproval",
    "applyPatchApproval",
    "mcpServer/elicitation/",
)

BENIGN_DIAGNOSTIC_NOTIFICATIONS = frozenset(
    {
        "thread/started",
        "thread/status/changed",
        "thread/readState/changed",
        "thread/settings/updated",
        "thread/environment/connected",
        "thread/environment/disconnected",
        "thread/section/changed",
        "thread/queue/changed",
        "thread/prediction/updated",
        "thread/attachment/updated",
        "thread/project/updated",
        "thread/deleted",
        "thread/reverted",
        "thread/closed",
        "thread/archived",
        "thread/unarchived",
        "thread/name/updated",
        "thread/goal/updated",
        "thread/goal/cleared",
        "thread/compacted",
        "account/gatewayOAuth/changed",
        "account/rateLimits/updated",
        "account/updated",
        "account/login/completed",
        "app/list/updated",
        "autoApprovalReview/strictReviewRequired",
        "item/autoApprovalReview/started",
        "item/autoApprovalReview/completed",
        "item/reasoning/summaryPartAdded",
        "item/mcpToolCall/progress",
        "item/plan/delta",
        "turn/plan/updated",
        "turn/diff/updated",
        "turn/moderationMetadata",
        "mcpServer/event/stream/notification",
        "mcpServer/startupStatus/updated",
        "mcpServer/oauthLogin/completed",
        "remoteControl/status/changed",
        "serverRequest/resolved",
        "model/rerouted",
        "model/safetyBuffering/updated",
        "model/verification",
        "modelProvider/authRecoveryStarted",
        "modelProvider/authRecoveryCompleted",
        "externalAgentConfig/import/progress",
        "externalAgentConfig/import/completed",
        "fuzzyFileSearch/sessionUpdated",
        "fuzzyFileSearch/sessionCompleted",
        "fs/changed",
        "project/changed",
        "guardianWarning",
        "warning",
        "error",
        "configWarning",
        "deprecationNotice",
        "skills/changed",
        "windows/worldWritableWarning",
        "windowsSandbox/setupCompleted",
    }
)


def _mask_email(email: Optional[str]) -> Optional[str]:
    if not email or not isinstance(email, str):
        return None
    if "@" not in email:
        return email[:2] + "***"
    local, domain = email.split("@", 1)
    prefix = local[:2] if len(local) >= 2 else local[:1]
    return f"{prefix}***@{domain}"


def _policy_args(skip_disable_features: Optional[List[str]] = None) -> List[str]:
    skipped = set(skip_disable_features or [])
    args = ["app-server", "--strict-config", "--listen", "stdio://"]
    for feature in CODEX_DISABLE:
        if feature not in skipped:
            args += ["--disable", feature]
    args += ["--enable", "skip_host_skill_discovery"]
    for val in ('approval_policy="never"', 'sandbox_mode="read-only"', 'web_search="disabled"'):
        args += ["-c", val]
    return args


def _check_config_sources(codex_home: Path, cwd: Path, system_root: Path = Path("/etc/codex")) -> None:
    candidates = [
        codex_home / "config.toml",
        codex_home / "AGENTS.md",
        codex_home / "AGENTS.override.md",
        system_root / "config.toml",
        system_root / "managed_config.toml",
        system_root / "requirements.toml",
    ]
    for parent in (cwd, *cwd.parents):
        candidates += [parent / ".codex/config.toml", parent / "AGENTS.md", parent / "AGENTS.override.md"]
    if any(p.exists() or p.is_symlink() for p in candidates):
        raise ValueError("CODEX_CONFIG_POLLUTION_REJECTED")


def usage_policy() -> Dict[str, Any]:
    return {
        "semanticsId": SEMANTICS_ID,
        "mode": "cumulative",
        "inputField": "inputTokens",
        "outputField": "outputTokens",
        "cacheReadField": "cachedInputTokens",
        "cacheWriteField": "cacheWriteInputTokens",
        "reasoningField": "reasoningOutputTokens",
        "inputIncludesCacheRead": True,
        "outputIncludesReasoning": True,
        "allowCacheWrite": False,
    }


def launch_spec(context: Dict[str, Any], verified_probe: Dict[str, Any]) -> Dict[str, Any]:
    need(isinstance(context, dict) and isinstance(verified_probe, dict), "CODEX_LAUNCH_CONTEXT_INVALID")
    root = Path(context["root"]).resolve()
    codex_home = Path(context["codexHome"]).resolve()
    need((codex_home / "auth.json").is_file() and not (codex_home / "auth.json").is_symlink(), "CODEX_AUTH_MISSING")

    system_root = Path(context.get("systemCodexRoot") or "/etc/codex")
    _check_config_sources(codex_home, root / "cwd", system_root=system_root)

    model = context.get("model")
    probed_models = {
        m["upstreamModelId"]: m
        for m in (verified_probe.get("models") or [])
        if isinstance(m, dict) and isinstance(m.get("upstreamModelId"), str)
    }
    need(isinstance(model, str) and model in probed_models, "CODEX_MODEL_NOT_OBSERVED")

    cli_path = str(Path(context["cliPath"]).resolve())
    native_path = str(Path(context.get("nativePath") or cli_path).resolve())
    mcp_client_path = str(Path(context["mcpClientPath"]).resolve())

    # Build pinned models.json overriding the 5 policy fields on every probed model entry.
    base_catalog = context.get("modelCatalog")
    raw_by_slug: Dict[str, Dict[str, Any]] = {}
    if isinstance(base_catalog, dict) and isinstance(base_catalog.get("models"), list):
        for entry in base_catalog["models"]:
            if isinstance(entry, dict) and isinstance(entry.get("slug"), str):
                raw_by_slug[entry["slug"]] = dict(entry)
    if not raw_by_slug:
        cache_path = codex_home / "models_cache.json"
        if cache_path.is_file() and not cache_path.is_symlink():
            cached_doc = strict_json(cache_path.read_bytes())
            if isinstance(cached_doc, dict) and isinstance(cached_doc.get("models"), list):
                for entry in cached_doc["models"]:
                    if isinstance(entry, dict) and isinstance(entry.get("slug"), str):
                        raw_by_slug[entry["slug"]] = dict(entry)

    # Test-only Group 2 red control strictly confined to `/tmp/oc-drvtest-`.
    skip_disable: List[str] = []
    catalog_policy = dict(POLICY)
    if str(root).startswith("/tmp/oc-drvtest-") and isinstance(context.get("testFaultEnableFeatures"), list):
        skip_disable = [str(x) for x in context["testFaultEnableFeatures"]]
        if "shell_tool" in skip_disable:
            catalog_policy["experimental_supported_tools"] = ["shell"]

    pinned_models = []
    for mid in sorted(probed_models.keys()):
        base_entry = raw_by_slug.get(mid, {"slug": mid, "display_name": probed_models[mid]["displayName"]})
        pinned_models.append({**base_entry, "slug": mid, **catalog_policy})

    p_args = _policy_args(skip_disable_features=skip_disable)
    argv = [
        cli_path,
        *p_args,
        "-c",
        "thread_unload_delay_secs=0",
        "-c",
        "model_catalog_json=" + json.dumps(str(root / "models.json")),
        "-c",
        'mcp_servers.ocbridge.command="/usr/bin/python3"',
        "-c",
        "mcp_servers.ocbridge.args=" + json.dumps(["-I", "-B", mcp_client_path, str(root)]),
        "-c",
        "mcp_servers.ocbridge.required=true",
        "-c",
        'mcp_servers.ocbridge.default_tools_approval_mode="approve"',
    ]
    env = {
        "HOME": str(root / "home"),
        "CODEX_HOME": str(codex_home),
        "PATH": "/usr/bin:/bin",
        "LANG": "C.UTF-8",
        "TMPDIR": str(root / "tmp"),
        "XDG_CONFIG_HOME": str(root / "home/config"),
        "XDG_DATA_HOME": str(root / "home/data"),
        "XDG_CACHE_HOME": str(root / "home/cache"),
    }
    policy_sha256 = remote_canonical_sha256(
        {
            "driverId": DRIVER_ID,
            "driverVersion": DRIVER_VERSION,
            "catalogOverrides": catalog_policy,
            "policyArgs": p_args,
        }
    )
    artifact_digests: Dict[str, str] = {cli_path: str(verified_probe["cliSha256"])}
    if verified_probe.get("nativeSha256"):
        artifact_digests[native_path] = str(verified_probe["nativeSha256"])

    return {
        "argv": argv,
        "environment": env,
        "cwd": str(root / "cwd"),
        "policySha256": policy_sha256,
        "files": {
            "models.json": {
                "content": json.dumps({"models": pinned_models}, separators=(",", ":")),
                "mode": 0o400,
            }
        },
        "dirs": ["home/config", "home/data", "home/cache"],
        "artifactDigests": artifact_digests,
    }


def encode(command: Dict[str, Any], native_state: Dict[str, Any]) -> Dict[str, Any]:
    kind = command.get("kind")
    cmd_id = command.get("commandId")
    need(isinstance(cmd_id, str) and IDENT_RE.fullmatch(cmd_id), "CODEX_COMMAND_ID_INVALID")

    state = dict(native_state)
    rpc_seq = int(state.get("rpcSeq", 0))
    pending_rpc = dict(state.get("pendingRpc") or {})
    lines: List[str] = []
    immediate: List[Dict[str, Any]] = []

    def _next_rpc(method: str, params: Dict[str, Any], command_kind: str) -> None:
        nonlocal rpc_seq
        rpc_seq += 1
        pending_rpc[str(rpc_seq)] = {"commandId": cmd_id, "commandKind": command_kind, "method": method}
        lines.append(
            json.dumps(
                {"jsonrpc": "2.0", "id": rpc_seq, "method": method, "params": params},
                ensure_ascii=False,
                separators=(",", ":"),
            )
        )

    if kind == "initialize":
        need(not state.get("initialized"), "CODEX_ALREADY_INITIALIZED")
        state["expectedModel"] = command.get("model") or state.get("expectedModel")
        _next_rpc(
            "initialize",
            {
                "clientInfo": {"name": "openclaude_remote_v4", "version": DRIVER_VERSION},
                "capabilities": {"experimentalApi": True},
            },
            "initialize",
        )

    elif kind == "resume":
        need(state.get("initialized") is True, "CODEX_NOT_INITIALIZED")
        if not state.get("initializedNotified"):
            lines.append(json.dumps({"jsonrpc": "2.0", "method": "initialized", "params": {}}, separators=(",", ":")))
            state["initializedNotified"] = True

        target = command.get("nativeSessionId")
        model = command.get("model") or state.get("expectedModel")
        need(isinstance(model, str) and len(model) > 0, "CODEX_MODEL_REQUIRED")
        instructions = command.get("instructions")
        base_params: Dict[str, Any] = {
            "model": model,
            "approvalPolicy": "never",
            "sandbox": "read-only",
        }
        if isinstance(instructions, str):
            base_params["baseInstructions"] = instructions

        if target is None or target == "new":
            _next_rpc("thread/start", base_params, "resume")
        else:
            need(isinstance(target, str) and IDENT_RE.fullmatch(target), "CODEX_THREAD_ID_INVALID")
            if (
                state.get("threadLoaded") is True
                and state.get("sessionId")
                and state["sessionId"] == target
                and state.get("loadedInstructions") == instructions
            ):
                immediate.append(
                    {
                        "commandId": cmd_id,
                        "commandKind": "resume",
                        "ok": True,
                        "nativeSessionId": target,
                        "upstreamModel": model,
                    }
                )
            else:
                state["expectedSessionId"] = target
                _next_rpc("thread/resume", {**base_params, "threadId": target}, "resume")
        state["loadedInstructions"] = instructions

    elif kind == "newTurn":
        need(state.get("initialized") is True and isinstance(state.get("sessionId"), str), "CODEX_THREAD_NOT_BOUND")
        need(not state.get("activeTurnId"), "CODEX_TURN_ALREADY_ACTIVE")
        prompt = command.get("prompt")
        model = command.get("model") or state.get("expectedModel")
        need(isinstance(prompt, str) and len(prompt.strip()) > 0 and isinstance(model, str), "CODEX_PROMPT_INVALID")
        params: Dict[str, Any] = {
            "threadId": state["sessionId"],
            "model": model,
            "approvalPolicy": "never",
            "sandboxPolicy": {"type": "readOnly", "networkAccess": False},
            "input": [{"type": "text", "text": prompt}],
        }
        if isinstance(command.get("effort"), str) and command["effort"]:
            params["effort"] = command["effort"]
        _next_rpc("turn/start", params, "newTurn")

    elif kind == "interrupt":
        need(isinstance(state.get("sessionId"), str) and isinstance(state.get("activeTurnId"), str), "CODEX_NO_ACTIVE_TURN")
        _next_rpc(
            "turn/interrupt",
            {"threadId": state["sessionId"], "turnId": state["activeTurnId"]},
            "interrupt",
        )

    elif kind == "readState":
        need(isinstance(state.get("sessionId"), str), "CODEX_THREAD_NOT_BOUND")
        _next_rpc("thread/read", {"threadId": state["sessionId"], "includeTurns": False}, "readState")

    else:
        raise ValueError("CODEX_UNKNOWN_COMMAND")

    state["rpcSeq"] = rpc_seq
    state["pendingRpc"] = pending_rpc
    return {"lines": lines, "nextNativeState": state, "immediateControlReplies": immediate}


def decode(channel: str, raw_frame: bytes, native_state: Dict[str, Any]) -> Dict[str, Any]:
    state = dict(native_state)
    frame = strict_json(raw_frame)
    need(isinstance(frame, dict), "CODEX_FRAME_NOT_OBJECT")

    if channel == "fixed_mcp":
        ident = frame.get("id")
        method = frame.get("method")
        need(method == "tools/call" and isinstance(ident, (str, int)) and not isinstance(ident, bool), "CODEX_MCP_INVALID")
        params = frame.get("params")
        need(isinstance(params, dict), "CODEX_MCP_PARAMS_INVALID")
        meta = params.get("_meta")
        need(isinstance(meta, dict), "CODEX_MCP_META_MISSING")
        turn_meta = meta.get("x-codex-turn-metadata")
        need(isinstance(turn_meta, dict), "CODEX_MCP_TURN_META_MISSING")
        call_id = meta.get("callId")
        thread_id = meta.get("threadId")
        turn_id = turn_meta.get("turn_id")
        name = params.get("name")
        args = params.get("arguments")
        need(
            isinstance(call_id, str)
            and IDENT_RE.fullmatch(call_id)
            and isinstance(thread_id, str)
            and IDENT_RE.fullmatch(thread_id)
            and isinstance(turn_id, str)
            and IDENT_RE.fullmatch(turn_id)
            and isinstance(name, str)
            and TOOL_ALIAS_RE.fullmatch(name)
            and type(args) is dict,
            "CODEX_MCP_CORRELATION_INVALID",
        )
        if state.get("sessionId"):
            need(thread_id == state["sessionId"], "CODEX_MCP_THREAD_MISMATCH")
        args_hash = remote_canonical_sha256(args)
        return {
            "securityEvents": [],
            "presentation": [],
            "controlReplies": [],
            "pendingToolRequest": {
                "rpcId": ident,
                "callId": call_id,
                "nativeSessionId": thread_id,
                "nativeTurnId": turn_id,
                "server": "ocbridge",
                "name": name,
                "arguments": args,
                "argsHash": args_hash,
            },
            "nextNativeState": state,
        }

    need(channel == "native", "CODEX_UNSUPPORTED_DECODE_CHANNEL")
    security_events: List[Dict[str, Any]] = []
    presentation: List[Dict[str, Any]] = []
    control_replies: List[Dict[str, Any]] = []

    # Reject server-initiated JSON-RPC requests (`id` AND `method` both present).
    if "id" in frame and "method" in frame:
        security_events.append(
            {
                "kind": "disallowedItem",
                "reason": "server_request_rejected",
                "itemType": str(frame.get("method") or "unknown")[:120],
            }
        )
        return {
            "securityEvents": security_events,
            "presentation": presentation,
            "controlReplies": control_replies,
            "nextNativeState": state,
        }

    if "id" in frame:
        rpc_key = str(frame["id"])
        pending_rpc = dict(state.get("pendingRpc") or {})
        entry = pending_rpc.pop(rpc_key, None)
        state["pendingRpc"] = pending_rpc
        need(entry is not None, "CODEX_UNKNOWN_RPC_RESPONSE")
        ok = "error" not in frame
        method = entry["method"]
        reply: Dict[str, Any] = {
            "commandId": entry["commandId"],
            "commandKind": entry["commandKind"],
            "ok": ok,
        }
        if not ok:
            reply["errorCode"] = "CODEX_RPC_ERROR"
        else:
            res = frame.get("result") or {}
            if method == "initialize":
                state["initialized"] = True
            elif method in ("thread/start", "thread/resume"):
                tid = (res.get("thread") or {}).get("id")
                need(isinstance(tid, str) and IDENT_RE.fullmatch(tid), "CODEX_THREAD_ID_INVALID")
                if state.get("expectedSessionId"):
                    need(tid == state["expectedSessionId"], "CODEX_THREAD_MISMATCH")
                if state.get("sessionId"):
                    need(tid == state["sessionId"], "CODEX_THREAD_CHANGED")
                if state.get("expectedModel") and res.get("model"):
                    need(res["model"] == state["expectedModel"], "CODEX_UPSTREAM_MODEL_MISMATCH")
                state["sessionId"] = tid
                state["threadLoaded"] = True
                reply["nativeSessionId"] = tid
                if isinstance(res.get("model"), str):
                    state["observedModel"] = res["model"]
                    reply["upstreamModel"] = res["model"]
            elif method == "turn/start":
                tid = (res.get("turn") or {}).get("id")
                if isinstance(tid, str) and IDENT_RE.fullmatch(tid):
                    state["activeTurnId"] = tid
                    reply["nativeTurnId"] = tid
                if state.get("sessionId"):
                    reply["nativeSessionId"] = state["sessionId"]
        control_replies.append(reply)
        return {
            "securityEvents": security_events,
            "presentation": presentation,
            "controlReplies": control_replies,
            "nextNativeState": state,
        }

    method = frame.get("method")
    params = frame.get("params") or {}
    need(isinstance(method, str) and isinstance(params, dict), "CODEX_NOTIFICATION_INVALID")

    if method == "turn/started":
        need(params.get("threadId") == state.get("sessionId"), "CODEX_TURN_THREAD_MISMATCH")
        turn_id = (params.get("turn") or {}).get("id")
        need(isinstance(turn_id, str) and IDENT_RE.fullmatch(turn_id), "CODEX_TURN_ID_INVALID")
        if state.get("activeTurnId"):
            need(state["activeTurnId"] == turn_id, "CODEX_CONCURRENT_TURN_CONFLICT")
        state["activeTurnId"] = turn_id
        state["usageSeq"] = 0

    elif method == "item/agentMessage/delta":
        delta = params.get("delta")
        if isinstance(delta, str) and delta:
            security_events.append({"kind": "textDelta", "channel": "answer", "delta": delta})
            presentation.append({"kind": "text_delta", "text": delta})

    elif method in ("item/reasoning/textDelta", "item/reasoning/summaryTextDelta"):
        delta = params.get("delta")
        if isinstance(delta, str) and delta:
            security_events.append({"kind": "textDelta", "channel": "reasoning", "delta": delta})
            presentation.append({"kind": "thinking_delta", "text": delta})

    elif method in ("item/started", "item/completed"):
        need(params.get("threadId") == state.get("sessionId"), "CODEX_ITEM_THREAD_MISMATCH")
        need(state.get("activeTurnId") and params.get("turnId") == state["activeTurnId"], "CODEX_ITEM_TURN_MISMATCH")
        item = params.get("item") or {}
        itype = item.get("type")
        if itype not in ALLOWED_NATIVE_ITEMS:
            security_events.append(
                {
                    "kind": "disallowedItem",
                    "reason": "disallowed_native_item",
                    "itemType": str(itype or "unknown")[:120],
                }
            )
        elif itype == "contextCompaction" and method == "item/completed":
            presentation.append({"kind": "compaction"})
        elif itype == "mcpToolCall":
            if item.get("server") != "ocbridge":
                security_events.append(
                    {
                        "kind": "disallowedItem",
                        "reason": "non_ocbridge_mcp_server",
                        "itemType": f"mcpToolCall:{item.get('server')}",
                    }
                )
            else:
                call_id = item.get("id")
                tool_name = item.get("tool")
                raw_args = item.get("arguments")
                if raw_args is None:
                    raw_args = {}
                elif isinstance(raw_args, str):
                    raw_args = strict_json(raw_args)
                need(
                    isinstance(call_id, str)
                    and IDENT_RE.fullmatch(call_id)
                    and isinstance(tool_name, str)
                    and TOOL_ALIAS_RE.fullmatch(tool_name)
                    and type(raw_args) is dict,
                    "CODEX_MCP_ITEM_INVALID",
                )
                security_events.append(
                    {
                        "kind": "toolCallObserved",
                        "callId": call_id,
                        "name": tool_name,
                        "argsHash": remote_canonical_sha256(raw_args),
                        "arguments": raw_args,
                        "phase": "started" if method == "item/started" else "completed",
                    }
                )

    elif method == "thread/tokenUsage/updated":
        active_turn = state.get("activeTurnId")
        expected_sid = state.get("sessionId") if active_turn else (state.get("sessionId") or state.get("expectedSessionId"))
        need(isinstance(expected_sid, str) and params.get("threadId") == expected_sid, "CODEX_USAGE_THREAD_MISMATCH")
        total = (params.get("tokenUsage") or {}).get("total")
        need(isinstance(total, dict), "CODEX_USAGE_TOTAL_MISSING")
        total_tokens = total.get("totalTokens")
        counters = {
            "inputTokens": total.get("inputTokens"),
            "cachedInputTokens": total.get("cachedInputTokens"),
            "cacheWriteInputTokens": total.get("cacheWriteInputTokens", 0),
            "outputTokens": total.get("outputTokens"),
            "reasoningOutputTokens": total.get("reasoningOutputTokens"),
        }
        for k, v in counters.items():
            need(type(v) is int and v >= 0, "CODEX_USAGE_COUNTER_INVALID")
        need(
            type(total_tokens) is int and total_tokens == counters["inputTokens"] + counters["outputTokens"],
            "CODEX_TOTAL_TOKENS_MISMATCH",
        )
        useq = int(state.get("usageSeq", 0)) + 1
        state["usageSeq"] = useq
        if active_turn:
            need(params.get("turnId") == active_turn, "CODEX_USAGE_TURN_MISMATCH")
            scope_id = active_turn
            sample_id = f"{active_turn}-u{useq}"
        else:
            # Pre-turn cumulative baseline replay on resumed thread.
            scope_id = "resume_replay"
            sample_id = f"replay-u{useq}"
        security_events.append(
            {
                "kind": "usage",
                "sampleId": sample_id,
                "scopeId": scope_id,
                "semanticsId": SEMANTICS_ID,
                "rawCounters": counters,
            }
        )

    elif method == "turn/completed":
        need(params.get("threadId") == state.get("sessionId"), "CODEX_TERMINAL_THREAD_MISMATCH")
        turn_obj = params.get("turn") or {}
        turn_id = turn_obj.get("id")
        raw_status = turn_obj.get("status")
        seen_turn_ids = list(state.get("seenTurnIds") or [])
        need(
            isinstance(turn_id, str)
            and (turn_id == state.get("activeTurnId") or turn_id in seen_turn_ids)
            and raw_status in ("completed", "failed", "interrupted"),
            "CODEX_TERMINAL_INVALID",
        )
        if turn_id not in seen_turn_ids:
            seen_turn_ids.append(turn_id)
            state["seenTurnIds"] = seen_turn_ids[-64:]
        mapped = "success" if raw_status == "completed" else ("interrupted" if raw_status == "interrupted" else "error")
        term_ev: Dict[str, Any] = {
            "kind": "turnTerminal",
            "terminalId": turn_id,
            "status": mapped,
        }
        if mapped == "error":
            term_ev["errorCode"] = "CODEX_TURN_FAILED"
        security_events.append(term_ev)
        state["activeTurnId"] = None

    elif any(method == pfx or method.startswith(pfx) for pfx in DISALLOWED_NOTIFICATION_PREFIXES):
        security_events.append(
            {
                "kind": "disallowedItem",
                "reason": "disallowed_notification",
                "itemType": method[:120],
            }
        )

    elif method in BENIGN_DIAGNOSTIC_NOTIFICATIONS or method.startswith(
        ("remoteControl/", "mcpServer/startupStatus/", "codex/event/", "thread/realtime/")
    ):
        pass

    else:
        raise ValueError(f"CODEX_UNKNOWN_NOTIFICATION:{method}")

    return {
        "securityEvents": security_events,
        "presentation": presentation,
        "controlReplies": control_replies,
        "nextNativeState": state,
    }


def probe(context: Dict[str, Any], previous_step_result: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    cli_path = str(Path(context["cliPath"]).resolve())
    native_path = str(Path(context.get("nativePath") or cli_path).resolve())
    codex_home = Path(context["codexHome"]).resolve()
    system_root = Path(context.get("systemCodexRoot") or "/etc/codex")
    probe_cwd = Path(context.get("probeCwd") or "/tmp")
    _check_config_sources(codex_home, probe_cwd, system_root=system_root)

    # Multi-page cursor handling: step 1 fetches page 1 + account; subsequent steps fetch `nextCursor` pages until `None`.
    probe_state = context.get("_probeState") if isinstance(context.get("_probeState"), dict) else {}
    accumulated_pages: List[Dict[str, Any]] = list(probe_state.get("items") or [])
    prior_shas: List[str] = list(probe_state.get("pageShas") or [])
    saved_init: Optional[Dict[str, Any]] = probe_state.get("initRes")
    saved_acct: Optional[Dict[str, Any]] = probe_state.get("acctRes")

    def _build_step(cursor: Optional[str], next_state: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        list_params: Dict[str, Any] = {"limit": 100, "includeHidden": False}
        if cursor is not None:
            list_params["cursor"] = cursor
        stdin_lines = [
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "clientInfo": {"name": "openclaude_probe_v4", "version": DRIVER_VERSION},
                        "capabilities": {"experimentalApi": True},
                    },
                },
                separators=(",", ":"),
            ),
            json.dumps({"jsonrpc": "2.0", "method": "initialized", "params": {}}, separators=(",", ":")),
        ]
        if cursor is None:
            stdin_lines.append(
                json.dumps({"jsonrpc": "2.0", "id": 2, "method": "account/read", "params": {}}, separators=(",", ":"))
            )
        stdin_lines.append(
            json.dumps({"jsonrpc": "2.0", "id": 3, "method": "model/list", "params": list_params}, separators=(",", ":"))
        )
        probe_tmp_base = str(context.get("probeTmp") or context.get("probeCwd") or "/tmp")
        out: Dict[str, Any] = {
            "kind": "step",
            "step": {
                "argv": [cli_path, *_policy_args()],
                "stdinLines": stdin_lines,
                "interactiveJsonRpc": True,
                "environment": {
                    "CODEX_HOME": str(codex_home),
                    "XDG_CONFIG_HOME": f"{probe_tmp_base}/xdg-config",
                    "XDG_DATA_HOME": f"{probe_tmp_base}/xdg-data",
                    "XDG_CACHE_HOME": f"{probe_tmp_base}/xdg-cache",
                },
                "timeoutSec": 18,
                "hashFiles": {"cli": cli_path, "native": native_path},
            },
        }
        if next_state is not None:
            out["nextProbeState"] = next_state
        return out

    if previous_step_result is None:
        return _build_step(None)

    replies: Dict[Any, Dict[str, Any]] = {}
    for line in previous_step_result.get("stdoutLines") or []:
        if not line.strip():
            continue
        obj = strict_json(line)
        if isinstance(obj, dict) and "id" in obj:
            need("error" not in obj, "CODEX_PROBE_RPC_ERROR")
            replies[obj["id"]] = obj.get("result") or {}

    need(1 in replies and 3 in replies and (saved_acct is not None or 2 in replies), "CODEX_PROBE_INCOMPLETE_REPLIES")
    init_res = saved_init if isinstance(saved_init, dict) else replies[1]
    acct_res = (
        saved_acct
        if isinstance(saved_acct, dict)
        else (replies[2].get("account") if isinstance(replies[2].get("account"), dict) else {})
    )
    page_res = replies[3]
    raw_items = page_res.get("data") if isinstance(page_res.get("data"), list) else page_res.get("models")
    need(isinstance(raw_items, list) and len(raw_items) > 0, "CODEX_PROBE_MODELS_EMPTY")
    combined_items = [*accumulated_pages, *raw_items]
    combined_shas = [*prior_shas, str(previous_step_result["stdoutSha256"])]

    next_cursor = page_res.get("nextCursor")
    if next_cursor is not None:
        need(isinstance(next_cursor, str) and 0 < len(next_cursor) <= 256, "CODEX_PROBE_CURSOR_INVALID")
        return _build_step(
            next_cursor,
            next_state={
                "items": combined_items,
                "pageShas": combined_shas,
                "initRes": init_res,
                "acctRes": acct_res,
            },
        )

    raw_response_sha = (
        combined_shas[0]
        if len(combined_shas) == 1
        else remote_canonical_sha256({"pages": combined_shas})
    )

    models: List[Dict[str, Any]] = []
    seen = set()
    for item in combined_items:
        if not isinstance(item, dict) or item.get("hidden") is True:
            continue
        mid = item.get("model") or item.get("id")
        need(isinstance(mid, str) and re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,63}", mid) and mid not in seen, "CODEX_PROBE_MODEL_INVALID")
        seen.add(mid)
        raw_efforts = [
            str(e.get("reasoningEffort"))
            for e in (item.get("supportedReasoningEfforts") or [])
            if isinstance(e, dict) and isinstance(e.get("reasoningEffort"), str) and e.get("reasoningEffort") != "ultra"
        ]
        def_eff = item.get("defaultReasoningEffort")
        if def_eff == "ultra" or (def_eff is not None and def_eff not in raw_efforts):
            def_eff = raw_efforts[0] if raw_efforts else None
        modalities = item.get("inputModalities") or []
        models.append(
            {
                "upstreamModelId": mid,
                "displayName": str(item.get("displayName") or mid),
                "supportedEfforts": raw_efforts,
                "defaultEffort": def_eff,
                "supportsAdaptiveThinking": False,
                "supportsVision": isinstance(modalities, list) and "image" in modalities,
            }
        )
    need(len(models) > 0, "CODEX_PROBE_NO_VISIBLE_MODELS")

    user_agent = str(init_res.get("userAgent") or "")
    probe_root = str(context.get("probeRoot") or "")
    if "/" in user_agent and user_agent.split("/", 1)[1].strip():
        cli_version = user_agent.split("/", 1)[1].strip().split()[0]
    elif probe_root.startswith("/tmp/oc-drvtest-") and isinstance(context.get("testCliVersion"), str) and context["testCliVersion"].strip():
        cli_version = context["testCliVersion"].strip()
    else:
        raise ValueError("CODEX_PROBE_VERSION_MISSING")
    email_hint = _mask_email(acct_res.get("email"))
    plan_type = str(acct_res.get("planType") or "") or None
    auth_present = (codex_home / "auth.json").is_file() and bool(acct_res)

    policy_sha = remote_canonical_sha256(
        {
            "driverId": DRIVER_ID,
            "driverVersion": DRIVER_VERSION,
            "catalogOverrides": POLICY,
            "policyArgs": _policy_args(),
        }
    )

    snapshot: Dict[str, Any] = {
        "schemaVersion": 4,
        "engineId": ENGINE_ID,
        "driverId": DRIVER_ID,
        "driverVersion": DRIVER_VERSION,
        "source": "codex-app-server:model/list",
        "freshness": "cli-observed",
        "authPresent": auth_present,
        "accountObserved": bool(acct_res),
        "cliVersion": cli_version,
        "cliSha256": previous_step_result["artifactHashes"]["cli"],
        "nativeSha256": previous_step_result["artifactHashes"]["native"],
        "models": models,
        "rawResponseSha256": raw_response_sha,
        "observedAt": datetime.now(timezone.utc).isoformat(),
    }
    if email_hint:
        snapshot["accountHint"] = email_hint
    if plan_type:
        snapshot["planType"] = plan_type

    return {"kind": "snapshot", "snapshot": snapshot, "policySha256": policy_sha}
