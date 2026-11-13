#!/usr/bin/env python3
"""Cross-language canonical JSON and raw-frame hash chain.

Byte-for-byte compatible with `packages/protocol/src/remotePool/canonical.ts`,
`packages/gateway/src/cc5NativeTool.ts`, and `scripts/agent-remote/codex-fixed-mcp.py`.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any, Dict, Iterable, List, Sequence, Tuple, Union

SAFE_INTEGER = 2**53 - 1
GENESIS_RAW_EVIDENCE_DIGEST = "0" * 64
VALID_RAW_CHANNELS = frozenset({"native_stdout", "native_stdin", "fixed_mcp", "probe"})


def strict_json(raw: Union[str, bytes, bytearray]) -> Any:
    """Parse JSON rejecting duplicate object keys, NaN/Infinity constants, and invalid UTF-8."""
    if isinstance(raw, (bytes, bytearray)):
        try:
            text = bytes(raw).decode("utf-8", errors="strict")
        except UnicodeDecodeError as exc:
            raise ValueError("REMOTE_STRICT_JSON_UTF8_INVALID") from exc
    elif isinstance(raw, str):
        text = raw
    else:
        raise ValueError("REMOTE_STRICT_JSON_TYPE_INVALID")

    def _no_dupes(pairs: List[Tuple[str, Any]]) -> Dict[str, Any]:
        out: Dict[str, Any] = {}
        for key, val in pairs:
            if key in out:
                raise ValueError("REMOTE_STRICT_JSON_DUPLICATE_KEY")
            out[key] = val
        return out

    def _no_constants(_token: str) -> Any:
        raise ValueError("REMOTE_STRICT_JSON_NONFINITE")

    try:
        value = json.loads(text, object_pairs_hook=_no_dupes, parse_constant=_no_constants)
    except ValueError as exc:
        if str(exc).startswith("REMOTE_STRICT_JSON_"):
            raise
        raise ValueError("REMOTE_STRICT_JSON_SYNTAX_INVALID") from exc
    assert_well_formed_json_value(value)
    return value


def _check_string(text: str) -> None:
    try:
        text.encode("utf-8", errors="strict")
    except UnicodeEncodeError as exc:
        raise ValueError("REMOTE_CANONICAL_JSON_INVALID") from exc


def assert_well_formed_json_value(value: Any) -> None:
    if value is None or value is True or value is False:
        return
    if isinstance(value, str):
        _check_string(value)
        return
    if type(value) is int:
        if abs(value) > SAFE_INTEGER:
            raise ValueError("REMOTE_CANONICAL_JSON_INVALID")
        return
    if type(value) is float:
        if value != value or value in (float("inf"), float("-inf")):
            raise ValueError("REMOTE_CANONICAL_JSON_INVALID")
        if value.is_integer() and abs(value) > SAFE_INTEGER:
            raise ValueError("REMOTE_CANONICAL_JSON_INVALID")
        return
    if isinstance(value, list):
        for item in value:
            assert_well_formed_json_value(item)
        return
    if type(value) is dict:
        for key, item in value.items():
            if type(key) is not str:
                raise ValueError("REMOTE_CANONICAL_JSON_INVALID")
            _check_string(key)
            assert_well_formed_json_value(item)
        return
    raise ValueError("REMOTE_CANONICAL_JSON_INVALID")


def _js_number(value: Union[int, float]) -> str:
    """Format number per ECMAScript Number::toString."""
    if type(value) is int:
        if abs(value) > SAFE_INTEGER:
            raise ValueError("REMOTE_CANONICAL_JSON_INVALID")
        return str(value)
    if value != value or value in (float("inf"), float("-inf")):
        raise ValueError("REMOTE_CANONICAL_JSON_INVALID")
    if value.is_integer() and abs(value) > SAFE_INTEGER:
        raise ValueError("REMOTE_CANONICAL_JSON_INVALID")
    if value == 0:
        return "0"
    text = repr(value)
    sign = "-" if text.startswith("-") else ""
    mantissa, _, exponent = text.lstrip("-").partition("e")
    whole, _, fraction = mantissa.partition(".")
    raw = whole + fraction
    lead = len(raw) - len(raw.lstrip("0"))
    digits = raw.lstrip("0").rstrip("0")
    n = len(whole) - lead + int(exponent or 0)
    k = len(digits)
    if k <= n <= 21:
        body = digits + "0" * (n - k)
    elif 0 < n <= 21:
        body = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        body = "0." + "0" * -n + digits
    else:
        e = n - 1
        body = digits[0] + ("." + digits[1:] if k > 1 else "") + "e" + ("+" if e >= 0 else "-") + str(abs(e))
    return sign + body


def _serialize_canonical(value: Any) -> str:
    if value is None:
        return "null"
    if value is True or value is False:
        return "true" if value else "false"
    if type(value) in (int, float):
        return _js_number(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return "[" + ",".join(_serialize_canonical(item) for item in value) + "]"
    if type(value) is dict:
        # Python str ordering is Unicode code point order == UTF-8 byte order.
        return "{" + ",".join(
            json.dumps(key, ensure_ascii=False) + ":" + _serialize_canonical(value[key])
            for key in sorted(value.keys())
        ) + "}"
    raise ValueError("REMOTE_CANONICAL_JSON_INVALID")


def remote_canonical_json(value: Any) -> str:
    assert_well_formed_json_value(value)
    return _serialize_canonical(value)


def remote_canonical_bytes(value: Any) -> bytes:
    return remote_canonical_json(value).encode("utf-8", errors="strict")


def remote_canonical_sha256(value: Any) -> str:
    return hashlib.sha256(remote_canonical_bytes(value)).hexdigest()


def advance_raw_evidence_digest(
    previous_digest: str,
    channel: str,
    seq: int,
    raw_bytes: Union[bytes, bytearray, str],
) -> str:
    if (
        not isinstance(previous_digest, str)
        or len(previous_digest) != 64
        or any(ch not in "0123456789abcdef" for ch in previous_digest)
        or channel not in VALID_RAW_CHANNELS
        or type(seq) is not int
        or seq < 1
        or seq > SAFE_INTEGER
    ):
        raise ValueError("REMOTE_RAW_EVIDENCE_INVALID")
    payload = raw_bytes.encode("utf-8", errors="strict") if isinstance(raw_bytes, str) else bytes(raw_bytes)
    header = f"{previous_digest}:{channel}:{seq}:{len(payload)}:".encode("utf-8")
    h = hashlib.sha256()
    h.update(header)
    h.update(payload)
    return h.hexdigest()


def compute_raw_evidence_digest(samples: Sequence[Dict[str, Any]]) -> str:
    digest = GENESIS_RAW_EVIDENCE_DIGEST
    expected_seq = 1
    for sample in samples:
        if not isinstance(sample, dict) or sample.get("seq") != expected_seq:
            raise ValueError("REMOTE_RAW_EVIDENCE_SEQ_GAP")
        expected_seq += 1
        digest = advance_raw_evidence_digest(
            digest,
            sample.get("channel", ""),
            sample["seq"],
            sample.get("rawBytes", b""),
        )
    return digest


GOLDEN_VECTORS: Tuple[Dict[str, Any], ...] = (
    {
        "name": "key_order_utf8_bytes_and_integer_keys",
        "value": {"b": 1, "10": "ten", "2": "two", "a": True, "中文": "ok", "_z": None},
        "canonical": '{"10":"ten","2":"two","_z":null,"a":true,"b":1,"中文":"ok"}',
        "sha256": "8bb452fba4fbe2b5ab79820a427cebde51731b58701ade40a41fd2bd6c9ffb67",
    },
    {
        "name": "negative_zero_and_floats",
        "value": {"negZero": -0.0, "half": 0.5, "tiny": 1e-7, "big": 9007199254740991, "arr": [-0.0, 1.25, 1000]},
        "canonical": '{"arr":[0,1.25,1000],"big":9007199254740991,"half":0.5,"negZero":0,"tiny":1e-7}',
        "sha256": "ab803313fcc0328b115b8aceb0ba960bbe1b905273b0b5be12dd385ef2fc9786",
    },
    {
        "name": "unicode_emoji_non_bmp_utf8_order",
        "value": {"😀": "smile", "\ufffd": "replacement", "ascii": 'hello\n"world"'},
        "canonical": '{"ascii":"hello\\n\\"world\\"","\ufffd":"replacement","😀":"smile"}',
        "sha256": "f64169bfbae88169680f979e87b8e202669d85ba29b1482da9f92922b1486685",
    },
)
