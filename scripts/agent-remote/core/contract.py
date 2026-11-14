#!/usr/bin/env python3
"""Shared validation & registry contracts for 5-duty Remote Drivers.

Drivers only return data structures (`LaunchSpec`, `DecodeBatch`, `NativeInputBatch`,
`ProbeStep | ModelSnapshot`, `UsagePolicy`). Core validates every structure, attaches
authentic raw-frame digests, enforces state/payload size limits, and fails closed.
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import re
import stat
import types
from typing import Any, Dict, List, Optional, Tuple, Union

from .canonical import (
    SAFE_INTEGER,
    assert_well_formed_json_value,
    remote_canonical_bytes,
    remote_canonical_sha256,
    strict_json,
)

PROTOCOL_VERSION = 4
MAX_NATIVE_STATE_BYTES = 65536
MAX_ENCODE_LINES = 16
MAX_LINE_BYTES = 2 * 1024 * 1024

ENGINE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}\Z")
PROFILE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}\Z")
GENERATION_RE = re.compile(r"^[1-9][0-9]{0,15}\Z")
IDENT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\Z")
SHA256_RE = re.compile(r"^[a-f0-9]{64}\Z")
TOOL_ALIAS_RE = re.compile(r"^(?:t[0-9]{1,3}|[A-Za-z0-9_-]{1,48})\Z")
FORBIDDEN_BILLING_RE = re.compile(r"price|cost|credit|settled|usd", re.IGNORECASE)
ENV_KEY_RE = re.compile(r"^[A-Z][A-Z0-9_]{1,63}\Z")

AUTHORITY_ENGINES = frozenset({"ccb", "codex", "grok", "cursor", "zcode", "antigravity"})
COMMAND_KINDS = frozenset({"initialize", "newTurn", "interrupt", "resume", "readState"})
DECODE_CHANNELS = frozenset({"native", "fixed_mcp", "probe"})
ALLOWED_ROLES = frozenset(
    {
        "provision",
        "preflight",
        "launch",
        "tool-socket",
        "stop",
        "fence-stop",
        "prove-stopped",
        "probe",
        "recycle-app",
        "reprovision-app",
    }
)
REQUIRED_DRIVER_DUTIES = ("launch_spec", "decode", "encode", "probe", "usage_policy")


def need(condition: Any, code: str = "REMOTE_DRIVER_CONTRACT_INVALID") -> None:
    if not condition:
        raise ValueError(code)


def agent_remote_root() -> Path:
    return Path(__file__).resolve().parents[1]


def default_registry_path() -> Path:
    return agent_remote_root() / "drivers" / "registry.json"


def file_sha256(path: Path, max_bytes: int = 512 * 1024 * 1024) -> str:
    need(path.is_file() and not path.is_symlink(), "REMOTE_ARTIFACT_UNSAFE")
    h = hashlib.sha256()
    total = 0
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(256 * 1024)
            if not chunk:
                break
            total += len(chunk)
            need(total <= max_bytes, "REMOTE_ARTIFACT_TOO_LARGE")
            h.update(chunk)
    need(total > 0, "REMOTE_ARTIFACT_EMPTY")
    return h.hexdigest()


def compute_core_digest(core_dir: Optional[Path] = None) -> str:
    target = (core_dir or Path(__file__).resolve().parent).resolve()
    files = sorted(p for p in target.glob("*.py") if p.is_file() and not p.is_symlink())
    need(len(files) >= 3, "REMOTE_CORE_FILES_MISSING")
    listing = {p.name: file_sha256(p, max_bytes=4 * 1024 * 1024) for p in files}
    return remote_canonical_sha256({"version": PROTOCOL_VERSION, "coreFiles": listing})


def _read_regular_file(path: Path, max_bytes: int, *, require_owner_uid: Optional[int] = None) -> bytes:
    need(not path.is_symlink(), "REMOTE_ARTIFACT_UNSAFE")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        st = os.fstat(fd)
        need(
            stat.S_ISREG(st.st_mode)
            and st.st_nlink == 1
            and not (st.st_mode & 0o022)
            and 0 < st.st_size <= max_bytes
            and (require_owner_uid is None or st.st_uid == require_owner_uid),
            "REMOTE_ARTIFACT_UNSAFE",
        )
        data = os.read(fd, max_bytes + 1)
        need(len(data) == st.st_size, "REMOTE_ARTIFACT_CHANGED")
        return data
    finally:
        os.close(fd)


def load_registry(
    registry_path: Optional[Union[str, Path]] = None,
    *,
    allow_sandbox_override: bool = False,
) -> Dict[str, Dict[str, Any]]:
    default_path = default_registry_path().resolve()
    path = Path(registry_path).resolve() if registry_path else default_path
    if path != default_path:
        need(
            allow_sandbox_override and str(path).startswith("/tmp/oc-drvtest-"),
            "REMOTE_REGISTRY_OVERRIDE_FORBIDDEN",
        )
        raw_bytes = _read_regular_file(path, 262144, require_owner_uid=os.getuid())
    else:
        raw_bytes = _read_regular_file(path, 262144)
    raw = strict_json(raw_bytes)
    need(isinstance(raw, dict) and raw.get("version") == PROTOCOL_VERSION, "REMOTE_REGISTRY_INVALID")
    drivers = raw.get("drivers")
    need(isinstance(drivers, dict) and 1 <= len(drivers) <= 32, "REMOTE_REGISTRY_INVALID")
    validated: Dict[str, Dict[str, Any]] = {}
    for key, entry in drivers.items():
        need(isinstance(entry, dict), "REMOTE_REGISTRY_INVALID")
        driver_id = entry.get("driverId")
        engine_id = entry.get("engineId")
        auth_engine = entry.get("authorityEngine")
        module_rel = entry.get("module")
        need(
            key == driver_id
            and isinstance(driver_id, str)
            and ENGINE_ID_RE.fullmatch(driver_id)
            and isinstance(engine_id, str)
            and ENGINE_ID_RE.fullmatch(engine_id)
            and isinstance(auth_engine, str)
            and auth_engine in AUTHORITY_ENGINES
            and isinstance(entry.get("driverVersion"), str)
            and 0 < len(entry["driverVersion"]) <= 64
            and isinstance(module_rel, str)
            and re.fullmatch(r"drivers/[a-z0-9_]+\.py", module_rel)
            and isinstance(entry.get("runnerMode"), str)
            and isinstance(entry.get("slice"), str)
            and re.fullmatch(r"oc-[a-z0-9_-]+\.slice", entry["slice"])
            and isinstance(entry.get("roles"), list)
            and set(entry["roles"]) <= ALLOWED_ROLES,
            "REMOTE_REGISTRY_ENTRY_INVALID",
        )
        for num_field in (
            "sliceMemoryMiB",
            "sliceTasksMax",
            "appMemoryMiB",
            "socketMemoryMiB",
            "probeMemoryMiB",
            "headroomMiB",
            "profileMaxLanes",
        ):
            val = entry.get(num_field)
            need(type(val) is int and val > 0, "REMOTE_REGISTRY_RESOURCE_INVALID")
        validated[driver_id] = dict(entry)
    return validated


def load_driver(
    driver_id: str,
    registry_path: Optional[Union[str, Path]] = None,
    base_dir: Optional[Path] = None,
    *,
    expected_digest: Optional[str] = None,
    allow_sandbox_override: bool = False,
) -> Tuple[types.ModuleType, Dict[str, Any], str]:
    registry = load_registry(registry_path, allow_sandbox_override=allow_sandbox_override)
    need(driver_id in registry, "REMOTE_DRIVER_NOT_REGISTERED")
    meta = registry[driver_id]
    if base_dir is not None:
        root = Path(base_dir).resolve()
    elif (
        allow_sandbox_override
        and registry_path is not None
        and Path(registry_path).resolve() != default_registry_path().resolve()
        and Path(registry_path).resolve().parent.name == "drivers"
        and (Path(registry_path).resolve().parent.parent / meta["module"]).is_file()
    ):
        root = Path(registry_path).resolve().parent.parent.resolve()
    else:
        root = agent_remote_root().resolve()
    mod_path = (root / meta["module"]).resolve()
    need(mod_path.parent == (root / "drivers").resolve(), "REMOTE_DRIVER_PATH_ESCAPED")
    source_bytes = _read_regular_file(
        mod_path,
        1024 * 1024,
        require_owner_uid=os.getuid() if str(mod_path).startswith("/tmp/oc-drvtest-") else None,
    )
    digest = hashlib.sha256(source_bytes).hexdigest()
    if expected_digest is not None:
        need(digest == expected_digest, "REMOTE_DRIVER_OR_CORE_DIGEST_MISMATCH")
    mod = types.ModuleType(f"oc_remote_driver_{driver_id}")
    mod.__file__ = str(mod_path)
    exec(compile(source_bytes, str(mod_path), "exec"), mod.__dict__)
    for duty in REQUIRED_DRIVER_DUTIES:
        need(callable(getattr(mod, duty, None)), f"REMOTE_DRIVER_MISSING_DUTY_{duty.upper()}")
    return mod, meta, digest


def validate_usage_policy(raw: Any) -> Dict[str, Any]:
    need(isinstance(raw, dict), "REMOTE_USAGE_POLICY_INVALID")
    assert_well_formed_json_value(raw)
    allowed_keys = {
        "semanticsId",
        "mode",
        "inputField",
        "outputField",
        "cacheReadField",
        "cacheWriteField",
        "reasoningField",
        "inputIncludesCacheRead",
        "outputIncludesReasoning",
        "allowCacheWrite",
    }
    need(
        set(raw.keys()) <= allowed_keys
        and {"semanticsId", "mode", "inputField", "outputField", "inputIncludesCacheRead", "outputIncludesReasoning", "allowCacheWrite"}
        <= set(raw.keys()),
        "REMOTE_USAGE_POLICY_INVALID",
    )
    need(
        isinstance(raw["semanticsId"], str)
        and IDENT_RE.fullmatch(raw["semanticsId"])
        and raw["mode"] in ("per_turn", "cumulative")
        and isinstance(raw["inputField"], str)
        and 0 < len(raw["inputField"]) <= 64
        and isinstance(raw["outputField"], str)
        and 0 < len(raw["outputField"]) <= 64
        and type(raw["inputIncludesCacheRead"]) is bool
        and type(raw["outputIncludesReasoning"]) is bool
        and type(raw["allowCacheWrite"]) is bool,
        "REMOTE_USAGE_POLICY_INVALID",
    )
    for opt in ("cacheReadField", "cacheWriteField", "reasoningField"):
        if opt in raw and raw[opt] is not None:
            need(isinstance(raw[opt], str) and 0 < len(raw[opt]) <= 64, "REMOTE_USAGE_POLICY_INVALID")
    return dict(raw)


def validate_launch_spec(raw: Any, root: Path) -> Dict[str, Any]:
    need(isinstance(raw, dict), "REMOTE_LAUNCH_SPEC_INVALID")
    assert_well_formed_json_value(raw)
    required = {"argv", "environment", "cwd", "policySha256", "files", "dirs"}
    allowed = required | {"artifactDigests", "folderTrust", "stopChecks"}
    need(required <= set(raw.keys()) <= allowed, "REMOTE_LAUNCH_SPEC_INVALID")

    argv = raw["argv"]
    need(
        isinstance(argv, list)
        and 1 <= len(argv) <= 128
        and all(isinstance(arg, str) and "\x00" not in arg and len(arg) <= 4096 for arg in argv),
        "REMOTE_LAUNCH_ARGV_INVALID",
    )
    # Never allow shell invocation (`sh -c`, `bash -c`) in launchSpec.
    exe_name = Path(argv[0]).name
    need(
        Path(argv[0]).is_absolute() and exe_name not in {"sh", "bash", "dash", "zsh"},
        "REMOTE_LAUNCH_SHELL_FORBIDDEN",
    )

    env = raw["environment"]
    need(
        isinstance(env, dict)
        and 1 <= len(env) <= 64
        and all(
            isinstance(k, str)
            and ENV_KEY_RE.fullmatch(k)
            and isinstance(v, str)
            and "\x00" not in v
            and len(v) <= 512 * 1024
            for k, v in env.items()
        ),
        "REMOTE_LAUNCH_ENV_INVALID",
    )
    # Disallow dynamic loader injection variables.
    for forbidden_env in ("LD_PRELOAD", "LD_LIBRARY_PATH", "PYTHONPATH", "NODE_OPTIONS", "BASH_ENV"):
        need(forbidden_env not in env, "REMOTE_LAUNCH_ENV_FORBIDDEN")

    resolved_root = root.resolve()
    cwd = Path(raw["cwd"])
    need(cwd == resolved_root / "cwd", "REMOTE_LAUNCH_CWD_OUTSIDE_ROOT")
    need(isinstance(raw["policySha256"], str) and SHA256_RE.fullmatch(raw["policySha256"]), "REMOTE_LAUNCH_POLICY_INVALID")

    dirs = raw["dirs"]
    need(isinstance(dirs, list) and len(dirs) <= 32, "REMOTE_LAUNCH_DIRS_INVALID")
    for rel_dir in dirs:
        need(
            isinstance(rel_dir, str)
            and re.fullmatch(r"[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*", rel_dir)
            and ".." not in rel_dir.split("/"),
            "REMOTE_LAUNCH_DIRS_INVALID",
        )

    files = raw["files"]
    need(isinstance(files, dict) and len(files) <= 32, "REMOTE_LAUNCH_FILES_INVALID")
    for rel_path, spec in files.items():
        need(
            isinstance(rel_path, str)
            and re.fullmatch(r"[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*", rel_path)
            and ".." not in rel_path.split("/")
            and isinstance(spec, dict)
            and set(spec.keys()) <= {"content", "contentB64", "mode"}
            and ("content" in spec) ^ ("contentB64" in spec),
            "REMOTE_LAUNCH_FILES_INVALID",
        )

    if "folderTrust" in raw and raw["folderTrust"] is not None:
        ft = raw["folderTrust"]
        need(
            isinstance(ft, dict)
            and set(ft.keys()) == {"claudeJsonPath", "cwd"}
            and ft["cwd"] == str(resolved_root / "cwd"),
            "REMOTE_LAUNCH_FOLDER_TRUST_INVALID",
        )

    if "stopChecks" in raw and raw["stopChecks"] is not None:
        sc = raw["stopChecks"]
        need(
            isinstance(sc, dict)
            and set(sc.keys()) == {"tmuxTmpDir", "tmuxSocketLabel", "sessions"}
            and Path(sc["tmuxTmpDir"]) == resolved_root / "tmux"
            and isinstance(sc["tmuxSocketLabel"], str)
            and re.fullmatch(r"[A-Za-z0-9_-]{1,32}", sc["tmuxSocketLabel"])
            and isinstance(sc["sessions"], list)
            and 1 <= len(sc["sessions"]) <= 4
            and all(isinstance(s, str) and IDENT_RE.fullmatch(s) for s in sc["sessions"]),
            "REMOTE_LAUNCH_STOP_CHECKS_INVALID",
        )

    out = dict(raw)
    out["argvSha256"] = remote_canonical_sha256(argv)
    return out


def validate_security_payload(payload: Any, channel: str) -> Dict[str, Any]:
    need(channel == "native", "REMOTE_DRIVER_NON_NATIVE_SECURITY_EVENT")
    need(isinstance(payload, dict), "REMOTE_DRIVER_EVENT_INVALID")
    assert_well_formed_json_value(payload)
    kind = payload.get("kind")

    if kind == "toolCallObserved":
        need(
            set(payload.keys()) == {"kind", "callId", "name", "argsHash", "arguments", "phase"}
            and isinstance(payload["callId"], str)
            and IDENT_RE.fullmatch(payload["callId"])
            and isinstance(payload["name"], str)
            and TOOL_ALIAS_RE.fullmatch(payload["name"])
            and isinstance(payload["argsHash"], str)
            and SHA256_RE.fullmatch(payload["argsHash"])
            and payload["phase"] in ("started", "completed")
            and type(payload["arguments"]) is dict,
            "REMOTE_DRIVER_EVENT_INVALID",
        )
        expected_hash = remote_canonical_sha256(payload["arguments"])
        need(expected_hash == payload["argsHash"], "REMOTE_DRIVER_TOOL_ARGS_HASH_MISMATCH")
        return {
            "kind": "toolCallObserved",
            "callId": payload["callId"],
            "name": payload["name"],
            "argsHash": expected_hash,
            "arguments": payload["arguments"],
            "phase": payload["phase"],
        }

    if kind == "usage":
        need(
            set(payload.keys()) == {"kind", "sampleId", "scopeId", "semanticsId", "rawCounters"}
            and isinstance(payload["sampleId"], str)
            and IDENT_RE.fullmatch(payload["sampleId"])
            and isinstance(payload["scopeId"], str)
            and IDENT_RE.fullmatch(payload["scopeId"])
            and isinstance(payload["semanticsId"], str)
            and IDENT_RE.fullmatch(payload["semanticsId"])
            and type(payload["rawCounters"]) is dict
            and 1 <= len(payload["rawCounters"]) <= 16,
            "REMOTE_DRIVER_EVENT_INVALID",
        )
        counters: Dict[str, int] = {}
        for k, v in payload["rawCounters"].items():
            need(not FORBIDDEN_BILLING_RE.search(k), "REMOTE_DRIVER_FORBIDDEN_BILLING_FIELD")
            need(type(v) is int and 0 <= v <= SAFE_INTEGER, "REMOTE_DRIVER_EVENT_INVALID")
            counters[k] = v
        return {
            "kind": "usage",
            "sampleId": payload["sampleId"],
            "scopeId": payload["scopeId"],
            "semanticsId": payload["semanticsId"],
            "rawCounters": counters,
        }

    if kind == "turnTerminal":
        allowed = {"kind", "terminalId", "status"} if "errorCode" not in payload else {"kind", "terminalId", "status", "errorCode"}
        need(
            set(payload.keys()) == allowed
            and isinstance(payload["terminalId"], str)
            and IDENT_RE.fullmatch(payload["terminalId"])
            and payload["status"] in ("success", "error", "interrupted")
            and ("errorCode" not in payload or (isinstance(payload["errorCode"], str) and IDENT_RE.fullmatch(payload["errorCode"]))),
            "REMOTE_DRIVER_EVENT_INVALID",
        )
        out = {"kind": "turnTerminal", "terminalId": payload["terminalId"], "status": payload["status"]}
        if "errorCode" in payload:
            out["errorCode"] = payload["errorCode"]
        return out

    if kind == "textDelta":
        need(
            set(payload.keys()) == {"kind", "channel", "delta"}
            and payload["channel"] in ("answer", "reasoning")
            and isinstance(payload["delta"], str),
            "REMOTE_DRIVER_EVENT_INVALID",
        )
        return {"kind": "textDelta", "channel": payload["channel"], "delta": payload["delta"]}

    if kind == "disallowedItem":
        need(
            set(payload.keys()) == {"kind", "reason", "itemType"}
            and isinstance(payload["reason"], str)
            and 0 < len(payload["reason"]) <= 128
            and isinstance(payload["itemType"], str)
            and 0 < len(payload["itemType"]) <= 128,
            "REMOTE_DRIVER_EVENT_INVALID",
        )
        return {"kind": "disallowedItem", "reason": payload["reason"], "itemType": payload["itemType"]}

    raise ValueError("REMOTE_DRIVER_UNKNOWN_SECURITY_EVENT")


def validate_pending_tool_request(raw: Any) -> Dict[str, Any]:
    need(isinstance(raw, dict), "REMOTE_DRIVER_MCP_REQUEST_INVALID")
    assert_well_formed_json_value(raw)
    allowed = {"rpcId", "callId", "nativeSessionId", "server", "name", "arguments", "argsHash"}
    if "nativeTurnId" in raw and raw["nativeTurnId"] is not None:
        allowed = allowed | {"nativeTurnId"}
    cleaned = {k: v for k, v in raw.items() if v is not None}
    need(set(cleaned.keys()) == allowed, "REMOTE_DRIVER_MCP_REQUEST_INVALID")
    rpc_id = cleaned["rpcId"]
    need(
        ((isinstance(rpc_id, str) and 0 < len(rpc_id) <= 256) or (type(rpc_id) is int and abs(rpc_id) <= SAFE_INTEGER))
        and isinstance(cleaned["callId"], str)
        and IDENT_RE.fullmatch(cleaned["callId"])
        and isinstance(cleaned["nativeSessionId"], str)
        and IDENT_RE.fullmatch(cleaned["nativeSessionId"])
        and ("nativeTurnId" not in cleaned or (isinstance(cleaned["nativeTurnId"], str) and IDENT_RE.fullmatch(cleaned["nativeTurnId"])))
        and cleaned["server"] == "ocbridge"
        and isinstance(cleaned["name"], str)
        and TOOL_ALIAS_RE.fullmatch(cleaned["name"])
        and type(cleaned["arguments"]) is dict
        and isinstance(cleaned["argsHash"], str)
        and SHA256_RE.fullmatch(cleaned["argsHash"]),
        "REMOTE_DRIVER_MCP_REQUEST_INVALID",
    )
    expected_hash = remote_canonical_sha256(cleaned["arguments"])
    need(expected_hash == cleaned["argsHash"], "REMOTE_DRIVER_MCP_ARGS_HASH_MISMATCH")
    return dict(cleaned)


def validate_decode_batch(
    raw: Any,
    *,
    channel: str,
    raw_frame_bytes: bytes,
    frame_seq: int,
    envelope: Optional[Dict[str, Any]] = None,
    event_seq_start: int = 1,
) -> Dict[str, Any]:
    need(channel in DECODE_CHANNELS, "REMOTE_DRIVER_CHANNEL_INVALID")
    need(isinstance(raw, dict), "REMOTE_DRIVER_DECODE_BATCH_INVALID")
    allowed = {"securityEvents", "presentation", "controlReplies", "nextNativeState"}
    if "pendingToolRequest" in raw and raw["pendingToolRequest"] is not None:
        allowed = allowed | {"pendingToolRequest"}
    cleaned = {k: v for k, v in raw.items() if not (k == "pendingToolRequest" and v is None)}
    need(set(cleaned.keys()) == allowed, "REMOTE_DRIVER_DECODE_BATCH_INVALID")

    sec_raw = cleaned["securityEvents"]
    pres_raw = cleaned["presentation"]
    ctrl_raw = cleaned["controlReplies"]
    next_state = cleaned["nextNativeState"]

    need(
        isinstance(sec_raw, list)
        and isinstance(pres_raw, list)
        and isinstance(ctrl_raw, list)
        and type(next_state) is dict,
        "REMOTE_DRIVER_DECODE_BATCH_INVALID",
    )
    state_bytes = remote_canonical_bytes(next_state)
    need(len(state_bytes) <= MAX_NATIVE_STATE_BYTES, "REMOTE_DRIVER_STATE_OVERFLOW")
    for k in next_state.keys():
        need(not FORBIDDEN_BILLING_RE.search(k), "REMOTE_DRIVER_FORBIDDEN_BILLING_FIELD")

    if channel != "native":
        need(len(sec_raw) == 0, "REMOTE_DRIVER_NON_NATIVE_SECURITY_EVENT")

    frame_sha256 = hashlib.sha256(raw_frame_bytes).hexdigest()
    wrapped_events: List[Dict[str, Any]] = []
    seq = event_seq_start
    for item in sec_raw:
        # Driver returns bare payload dicts (or full event dicts whose payload we extract and re-wrap with core's authentic rawFrameRef).
        payload_in = item["payload"] if isinstance(item, dict) and "payload" in item else item
        validated_payload = validate_security_payload(payload_in, channel)
        if envelope is not None:
            native_session = next_state.get("sessionId") or envelope.get("nativeSessionId") or "unassigned"
            native_turn = next_state.get("activeTurnId") or envelope.get("nativeTurnId")
            ev: Dict[str, Any] = {
                "protocolVersion": PROTOCOL_VERSION,
                "operationId": envelope["operationId"],
                "generation": envelope["generation"],
                "profileId": envelope["profileId"],
                "authEpoch": envelope["authEpoch"],
                "authorityTurnId": envelope["authorityTurnId"],
                "nativeSessionId": native_session,
                "seq": seq,
                "rawFrameRef": {
                    "channel": "native",
                    "frameSeq": frame_seq,
                    "sha256": frame_sha256,
                },
                "driverId": envelope["driverId"],
                "driverVersion": envelope["driverVersion"],
                "payload": validated_payload,
            }
            if native_turn is not None:
                ev["nativeTurnId"] = native_turn
            wrapped_events.append(ev)
        else:
            wrapped_events.append(validated_payload)
        seq += 1

    validated_pres: List[Dict[str, Any]] = []
    for p in pres_raw:
        need(
            isinstance(p, dict)
            and p.get("kind") in ("text_delta", "thinking_delta", "status", "compaction", "error")
            and set(p.keys()) <= {"kind", "text", "code"},
            "REMOTE_DRIVER_PRESENTATION_INVALID",
        )
        assert_well_formed_json_value(p)
        validated_pres.append(dict(p))

    validated_ctrl: List[Dict[str, Any]] = []
    for c in ctrl_raw:
        need(
            isinstance(c, dict)
            and set(c.keys()) <= {"commandId", "commandKind", "ok", "nativeSessionId", "nativeTurnId", "upstreamModel", "errorCode"}
            and isinstance(c.get("commandId"), str)
            and IDENT_RE.fullmatch(c["commandId"])
            and c.get("commandKind") in COMMAND_KINDS
            and type(c.get("ok")) is bool,
            "REMOTE_DRIVER_CONTROL_REPLY_INVALID",
        )
        assert_well_formed_json_value(c)
        validated_ctrl.append(dict(c))

    out: Dict[str, Any] = {
        "securityEvents": wrapped_events,
        "presentation": validated_pres,
        "controlReplies": validated_ctrl,
        "nextNativeState": next_state,
    }
    if "pendingToolRequest" in cleaned:
        need(channel == "fixed_mcp", "REMOTE_DRIVER_UNEXPECTED_MCP_REQUEST")
        out["pendingToolRequest"] = validate_pending_tool_request(cleaned["pendingToolRequest"])
    return out


def validate_encode_batch(raw: Any, command: Dict[str, Any]) -> Dict[str, Any]:
    need(isinstance(command, dict) and command.get("kind") in COMMAND_KINDS, "REMOTE_DRIVER_COMMAND_INVALID")
    need(isinstance(raw, dict) and set(raw.keys()) <= {"lines", "nextNativeState", "immediateControlReplies"}, "REMOTE_DRIVER_ENCODE_INVALID")
    lines = raw.get("lines")
    next_state = raw.get("nextNativeState")
    need(
        isinstance(lines, list)
        and len(lines) <= MAX_ENCODE_LINES
        and all(isinstance(line, str) and "\n" not in line and len(line.encode("utf-8")) <= MAX_LINE_BYTES for line in lines)
        and type(next_state) is dict
        and len(remote_canonical_bytes(next_state)) <= MAX_NATIVE_STATE_BYTES,
        "REMOTE_DRIVER_ENCODE_INVALID",
    )
    # `readState` must never inject prompt/turn frames onto native stdin; `resume` must never send user prompts.
    if command["kind"] == "readState":
        need(len(lines) <= 1, "REMOTE_DRIVER_READSTATE_FORBIDDEN_INPUT")
    if command["kind"] in ("resume", "readState"):
        for line in lines:
            parsed = strict_json(line)
            need(
                parsed.get("type") != "user" and parsed.get("method") != "turn/start",
                "REMOTE_DRIVER_UNAUTHORIZED_TURN_TRIGGER",
            )
    immediate = raw.get("immediateControlReplies") or []
    need(isinstance(immediate, list), "REMOTE_DRIVER_ENCODE_INVALID")
    return {
        "lines": list(lines),
        "nextNativeState": next_state,
        "immediateControlReplies": list(immediate),
    }


def validate_model_snapshot(raw: Any) -> Dict[str, Any]:
    need(isinstance(raw, dict) and raw.get("kind") == "snapshot", "REMOTE_PROBE_SNAPSHOT_INVALID")
    snap = raw.get("snapshot")
    need(isinstance(snap, dict) and snap.get("schemaVersion") == PROTOCOL_VERSION, "REMOTE_PROBE_SNAPSHOT_INVALID")
    assert_well_formed_json_value(snap)
    need(
        snap.get("freshness") == "cli-observed"
        and isinstance(snap.get("source"), str)
        and ":" in snap["source"]
        and type(snap.get("authPresent")) is bool
        and type(snap.get("accountObserved")) is bool
        and isinstance(snap.get("cliVersion"), str)
        and len(snap["cliVersion"]) > 0
        and isinstance(snap.get("cliSha256"), str)
        and SHA256_RE.fullmatch(snap["cliSha256"])
        and isinstance(snap.get("rawResponseSha256"), str)
        and SHA256_RE.fullmatch(snap["rawResponseSha256"])
        and isinstance(snap.get("models"), list)
        and len(snap["models"]) > 0,
        "REMOTE_PROBE_SNAPSHOT_INVALID",
    )
    seen_ids = set()
    for m in snap["models"]:
        need(
            isinstance(m, dict)
            and isinstance(m.get("upstreamModelId"), str)
            and re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,63}", m["upstreamModelId"])
            and m["upstreamModelId"] not in seen_ids
            and isinstance(m.get("displayName"), str)
            and isinstance(m.get("supportedEfforts"), list)
            and all(isinstance(e, str) for e in m["supportedEfforts"])
            and (m.get("defaultEffort") is None or m.get("defaultEffort") in m["supportedEfforts"])
            and type(m.get("supportsAdaptiveThinking")) is bool
            and type(m.get("supportsVision")) is bool,
            "REMOTE_PROBE_MODEL_INVALID",
        )
        seen_ids.add(m["upstreamModelId"])
    return dict(snap)


def compute_probe_fingerprint(
    snapshot: Dict[str, Any],
    *,
    driver_digest: str,
    core_digest: str,
    policy_sha256: str,
) -> str:
    """Semantic fingerprint excluding volatile `observedAt` timestamps (`AC-3`)."""
    models_sem = [
        {
            "upstreamModelId": m["upstreamModelId"],
            "supportedEfforts": list(m["supportedEfforts"]),
            "defaultEffort": m["defaultEffort"],
            "supportsAdaptiveThinking": m["supportsAdaptiveThinking"],
            "supportsVision": m["supportsVision"],
        }
        for m in sorted(snapshot["models"], key=lambda x: x["upstreamModelId"])
    ]
    return remote_canonical_sha256(
        {
            "version": PROTOCOL_VERSION,
            "engineId": snapshot["engineId"],
            "driverId": snapshot["driverId"],
            "driverVersion": snapshot["driverVersion"],
            "driverDigest": driver_digest,
            "coreDigest": core_digest,
            "policySha256": policy_sha256,
            "cliVersion": snapshot["cliVersion"],
            "cliSha256": snapshot["cliSha256"],
            "nativeSha256": snapshot.get("nativeSha256"),
            "bridgeSha256": snapshot.get("bridgeSha256"),
            "models": models_sem,
        }
    )
