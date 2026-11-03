#!/usr/bin/env python3
"""Pure, closed validation-scope schema for an explicitly authorized batch."""

import argparse
import json
import re
import sys

MODEL = "deepseek-v4-flash"
SKIPPED = ("grok-build:matrix", "grok-build:journey")
_REQUIRED = frozenset({
    "schemaVersion", "profile", "authorizationRef", "queueId", "sourceSha",
    "matrixModels", "journeyModel", "skipped",
})


def _text(value, field):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(field + " must be a nonempty string")
    return value


def _sha(value, field):
    if not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{40}", value) is None:
        raise ValueError(field + " must be a full lowercase commit SHA")
    return value


def _operation(value, field):
    if not isinstance(value, str) or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", value) is None:
        raise ValueError(field + " must be a bounded identifier token")
    return value


def _skip_profile(authorization_ref, queue_id, source_sha, operation_id):
    result = {
        "schemaVersion": 1,
        "profile": "skip-grok",
        "authorizationRef": _text(authorization_ref, "authorizationRef"),
        "queueId": _text(queue_id, "queueId"),
        "sourceSha": _sha(source_sha, "sourceSha"),
        "matrixModels": [MODEL],
        "journeyModel": MODEL,
        "skipped": list(SKIPPED),
    }
    if operation_id is not None:
        result["operationId"] = _operation(operation_id, "operationId")
    return result


def make_profile(profile, authorization_ref, queue_id, source_sha, operation_id=None):
    """Return no scope for normal, or the fixed subset scope; perform no I/O."""
    if profile == "normal":
        return None
    if profile != "skip-grok":
        raise ValueError("unknown validation profile")
    return _skip_profile(authorization_ref, queue_id, source_sha, operation_id)


def validate_profile(value, source_sha=None, queue_id=None, operation_id=None):
    """Validate schema and any supplied expected pins, returning a fresh value.

    None is the legacy normal record. Callers own authorization, durable receipt
    ownership and lease verification; this pure function does not infer them.
    """
    if value is None:
        return None
    if type(value) is not dict:
        raise ValueError("validation scope must be an object or null")
    if set(value) not in (_REQUIRED, _REQUIRED | {"operationId"}):
        raise ValueError("validation scope has missing or unexpected fields")
    if type(value["schemaVersion"]) is not int or value["schemaVersion"] != 1:
        raise ValueError("unsupported validation scope schemaVersion")
    if value["profile"] != "skip-grok":
        raise ValueError("unknown validation profile")
    if type(value["matrixModels"]) is not list or value["matrixModels"] != [MODEL]:
        raise ValueError("matrixModels must be the fixed subset")
    if value["journeyModel"] != MODEL:
        raise ValueError("journeyModel must be the fixed subset model")
    if type(value["skipped"]) is not list or value["skipped"] != list(SKIPPED):
        raise ValueError("skipped must be the exact matrix and journey exclusions")
    if "operationId" in value:
        _operation(value["operationId"], "operationId")
    result = _skip_profile(
        value["authorizationRef"], value["queueId"], value["sourceSha"],
        value.get("operationId"),
    )
    if source_sha is not None and result["sourceSha"] != _sha(source_sha, "expected sourceSha"):
        raise ValueError("sourceSha does not match expected source")
    if queue_id is not None and result["queueId"] != _text(queue_id, "expected queueId"):
        raise ValueError("queueId does not match expected queue")
    if operation_id is not None:
        expected = _operation(operation_id, "expected operationId")
        if result.get("operationId") != expected:
            raise ValueError("operationId does not match expected operation")
    return result


def _unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate JSON field")
        value[key] = item
    return value


def _invalid_constant(_value):
    raise ValueError("nonfinite JSON value")


def main(argv=None):
    parser = argparse.ArgumentParser(allow_abbrev=False)
    commands = parser.add_subparsers(dest="command", required=True)
    normalize = commands.add_parser("normalize", allow_abbrev=False)
    normalize.add_argument("--profile", default="normal")
    normalize.add_argument("--authorization-ref")
    normalize.add_argument("--queue-id")
    normalize.add_argument("--source-sha")
    normalize.add_argument("--operation-id")
    validate = commands.add_parser("validate", allow_abbrev=False)
    validate.add_argument("--source-sha")
    validate.add_argument("--queue-id")
    validate.add_argument("--operation-id")
    args = parser.parse_args(argv)
    try:
        if args.command == "normalize":
            value = make_profile(
                args.profile, args.authorization_ref, args.queue_id,
                args.source_sha, args.operation_id,
            )
        else:
            value = json.load(
                sys.stdin, object_pairs_hook=_unique_object,
                parse_constant=_invalid_constant,
            )
            value = validate_profile(
                value, args.source_sha, args.queue_id, args.operation_id,
            )
        sys.stdout.write(json.dumps(
            value, sort_keys=True, separators=(",", ":"), ensure_ascii=True,
            allow_nan=False,
        ) + "\n")
        return 0
    except ValueError as error:
        sys.stderr.write("v5-validation-profile: " + str(error) + "\n")
        return 2


if __name__ == "__main__":
    sys.exit(main())
