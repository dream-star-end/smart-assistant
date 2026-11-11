#!/usr/bin/env python3
"""Bounded JSON-line stdio worker hosting 5-duty Remote Drivers for TypeScript master/relay.

Runs under `/usr/bin/python3 -I -B`. Never executes shell commands, network calls, or tools.
"""
from __future__ import annotations

import base64
from pathlib import Path
import sys
from typing import Any, Dict, Optional

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from core.canonical import strict_json  # noqa: E402
from core.contract import (  # noqa: E402
    MAX_LINE_BYTES,
    compute_core_digest,
    compute_probe_fingerprint,
    load_driver,
    need,
    validate_decode_batch,
    validate_encode_batch,
    validate_launch_spec,
    validate_model_snapshot,
    validate_usage_policy,
)


_DRIVER_CACHE: Dict[ Any, Any ] = {}
_CORE_DIGEST_CACHE: Optional[str] = None


def _pinned_driver(driver_id: str, registry_path: Optional[str]):
    key = (driver_id, str(Path(registry_path).resolve()) if registry_path else "")
    cached = _DRIVER_CACHE.get(key)
    if cached is None:
        cached = load_driver(driver_id, registry_path=registry_path)
        _DRIVER_CACHE[key] = cached
    return cached


def _pinned_core_digest() -> str:
    global _CORE_DIGEST_CACHE
    if _CORE_DIGEST_CACHE is None:
        _CORE_DIGEST_CACHE = compute_core_digest()
    return _CORE_DIGEST_CACHE


def handle_request(req: Dict[str, Any], default_registry: Optional[str] = None) -> Dict[str, Any]:
    method = req.get("method")
    params = req.get("params")
    need(isinstance(method, str) and isinstance(params, dict), "REMOTE_WORKER_BAD_REQUEST")
    registry_path = params.get("registryPath") or default_registry
    driver_id = params.get("driverId")
    need(isinstance(driver_id, str), "REMOTE_WORKER_MISSING_DRIVER")
    mod, meta, driver_digest = _pinned_driver(driver_id, registry_path=registry_path)
    core_digest = _pinned_core_digest()

    if method == "info":
        policy = validate_usage_policy(mod.usage_policy())
        return {
            "driverId": meta["driverId"],
            "engineId": meta["engineId"],
            "authorityEngine": meta["authorityEngine"],
            "driverVersion": meta["driverVersion"],
            "driverDigest": driver_digest,
            "coreDigest": core_digest,
            "usagePolicy": policy,
            "meta": meta,
        }

    if method == "usagePolicy":
        return validate_usage_policy(mod.usage_policy())

    if method == "decode":
        channel = params.get("channel")
        frame_seq = params.get("frameSeq", 1)
        need(isinstance(channel, str) and type(frame_seq) is int and frame_seq >= 1, "REMOTE_WORKER_BAD_DECODE")
        if "rawFrameB64" in params and params["rawFrameB64"] is not None:
            raw_bytes = base64.b64decode(params["rawFrameB64"], validate=True)
        elif isinstance(params.get("rawFrame"), str):
            raw_bytes = params["rawFrame"].encode("utf-8", errors="strict")
        else:
            raise ValueError("REMOTE_WORKER_MISSING_FRAME")
        need(len(raw_bytes) <= MAX_LINE_BYTES, "REMOTE_WORKER_FRAME_TOO_LARGE")
        native_state = params.get("nativeState") or {}
        need(type(native_state) is dict, "REMOTE_WORKER_BAD_STATE")
        envelope = params.get("envelope")
        if envelope is not None:
            need(isinstance(envelope, dict), "REMOTE_WORKER_BAD_ENVELOPE")
            envelope = {
                **envelope,
                "driverId": meta["driverId"],
                "driverVersion": meta["driverVersion"],
            }
        raw_batch = mod.decode(channel, raw_bytes, dict(native_state))
        return validate_decode_batch(
            raw_batch,
            channel=channel,
            raw_frame_bytes=raw_bytes,
            frame_seq=frame_seq,
            envelope=envelope,
            event_seq_start=int(params.get("eventSeqStart", 1)),
        )

    if method == "encode":
        command = params.get("command")
        native_state = params.get("nativeState") or {}
        need(isinstance(command, dict) and type(native_state) is dict, "REMOTE_WORKER_BAD_ENCODE")
        raw_batch = mod.encode(command, dict(native_state))
        return validate_encode_batch(raw_batch, command)

    if method == "launchSpec":
        context = params.get("context")
        verified_probe = params.get("verifiedProbe")
        need(isinstance(context, dict) and isinstance(context.get("root"), str), "REMOTE_WORKER_BAD_LAUNCH_CONTEXT")
        raw_spec = mod.launch_spec(context, verified_probe)
        return validate_launch_spec(raw_spec, Path(context["root"]))

    if method == "probe":
        context = params.get("context") or {}
        prev = params.get("previousStepResult")
        need(isinstance(context, dict), "REMOTE_WORKER_BAD_PROBE")
        res = mod.probe(context, prev)
        need(isinstance(res, dict) and res.get("kind") in ("step", "snapshot"), "REMOTE_PROBE_RESULT_INVALID")
        if res["kind"] == "step":
            step = res.get("step")
            need(
                isinstance(step, dict)
                and isinstance(step.get("argv"), list)
                and len(step["argv"]) >= 1
                and all(isinstance(a, str) for a in step["argv"]),
                "REMOTE_PROBE_STEP_INVALID",
            )
            out_step: Dict[str, Any] = {"kind": "step", "step": step}
            if "nextProbeState" in res:
                out_step["nextProbeState"] = res["nextProbeState"]
            return out_step
        snap = validate_model_snapshot(res)
        policy_sha = str(res.get("policySha256") or snap.get("rawResponseSha256"))
        fp = compute_probe_fingerprint(
            snap,
            driver_digest=driver_digest,
            core_digest=core_digest,
            policy_sha256=policy_sha,
        )
        return {
            "kind": "snapshot",
            "snapshot": snap,
            "driverDigest": driver_digest,
            "coreDigest": core_digest,
            "probeFingerprint": fp,
        }

    raise ValueError("REMOTE_WORKER_UNKNOWN_METHOD")


def main() -> int:
    default_registry: Optional[str] = None
    args = sys.argv[1:]
    if len(args) == 2 and args[0] == "--registry":
        default_registry = args[1]
    elif len(args) != 0:
        sys.stderr.write("REMOTE_WORKER_ARGS_INVALID\n")
        return 126

    while True:
        line = sys.stdin.buffer.readline(MAX_LINE_BYTES + 1)
        if not line:
            return 0
        if len(line) > MAX_LINE_BYTES or not line.endswith(b"\n"):
            sys.stdout.write('{"id":null,"ok":false,"error":{"code":"REMOTE_WORKER_FRAME_OVERFLOW"}}\n')
            sys.stdout.flush()
            return 1
        req_id: Any = None
        try:
            req = strict_json(line)
            need(isinstance(req, dict), "REMOTE_WORKER_BAD_REQUEST")
            req_id = req.get("id")
            need(isinstance(req_id, (str, int)) and not isinstance(req_id, bool), "REMOTE_WORKER_BAD_ID")
            result = handle_request(req, default_registry=default_registry)
            out = {"id": req_id, "ok": True, "result": result}
        except Exception as exc:  # noqa: BLE001
            code = str(exc) if str(exc).startswith("REMOTE_") or str(exc).endswith("_INVALID") or str(exc).endswith("_UNAVAILABLE") else "REMOTE_DRIVER_WORKER_ERROR"
            out = {"id": req_id, "ok": False, "error": {"code": code, "message": str(exc)[:256]}}
        import json

        sys.stdout.write(json.dumps(out, ensure_ascii=False, separators=(",", ":")) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    sys.exit(main())
