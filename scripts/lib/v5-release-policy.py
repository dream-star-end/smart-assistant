#!/usr/bin/env python3
"""Durable, data-only release intent. Runtime operations stay in the publisher."""
import argparse
import copy
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile

POLICY = "user-impact-only"
TUPLE_KEYS = {"OC_RUNTIME_IMAGE", "OC_RUNTIME_IMAGE_ID", "OC_RUNTIME_RELEASE", "OC_PLATFORM_BUNDLE"}
DECISIONS = {"PREPARATION_ABORT", "KEEP_FAILED", "HOLD_UNKNOWN", "COMPENSATE_USER_IMPAIRMENT", "CRASH_STOP"}
PHASES = {"prepared", "exposure-armed", "observing", "held", "repairing", "resolved"}
ROOT_KEYS = {"schema", "policy", "edition", "operationId", "candidateSha", "owner", "before", "target", "history", "createdAt", "updatedAt", "revision", "phase", "mayHaveServed", "observations", "failure", "resolution"}

class PolicyError(Exception):
    pass

def require(ok, message):
    if not ok:
        raise PolicyError(message)

def text(value, label, empty=False):
    require(isinstance(value, str) and (empty or bool(value)), label + " must be text")
    require(len(value) <= 4096 and not any(ord(c) < 32 for c in value), label + " contains invalid characters")
    return value

def ident(value, label):
    require(isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", value), label + " is invalid")

def digest(value, label):
    require(isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value), label + " must be a SHA256")

def absolute(value, label, empty=False):
    text(value, label, empty)
    if value or not empty:
        require(value.startswith("/") and ".." not in Path(value).parts, label + " must be an absolute non-parent path")

def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()

def validate_stack(stack, label):
    require(isinstance(stack, dict), label + " must be an object")
    allowed = {"masterRelease", "currentTarget", "tuple", "sourceCommit", "sourceDigest", "slot", "port", "egressRelease", "egressSlot", "authority"}
    require(set(stack) <= allowed, label + " has unsupported fields")
    absolute(stack.get("masterRelease"), label + ".masterRelease")
    text(stack.get("currentTarget"), label + ".currentTarget", True)
    values = stack.get("tuple")
    require(isinstance(values, dict) and set(values) == TUPLE_KEYS, label + " must contain exactly the four runtime keys")
    for key, value in values.items():
        if value is not None:
            text(value, label + ".tuple." + key, True)
    if "sourceCommit" in stack:
        require(re.fullmatch(r"[0-9a-f]{40}", stack["sourceCommit"] or ""), label + " sourceCommit is invalid")
    if "sourceDigest" in stack:
        digest(stack["sourceDigest"], label + ".sourceDigest")
    for key in ["slot", "egressSlot"]:
        if key in stack:
            require(stack[key] in ["", "A", "B"], label + "." + key + " is invalid")
    if "port" in stack:
        require(type(stack["port"]) is int and 0 < stack["port"] < 65536, label + ".port is invalid")
    if "egressRelease" in stack:
        absolute(stack["egressRelease"], label + ".egressRelease", True)
    if "authority" in stack:
        authority = stack["authority"]
        require(isinstance(authority, dict) and set(authority) <= {"phase", "lockVersion", "activeSlot", "activeRelease", "previousRelease", "candidateSlot", "candidateRelease"}, label + " authority is invalid")
        for key, value in authority.items():
            if key == "lockVersion":
                require(type(value) is int and value >= 0, label + " lockVersion is invalid")
            elif value is not None:
                text(value, label + ".authority." + key, True)

def stack_digest(stack):
    return hashlib.sha256(json.dumps(stack, sort_keys=True, separators=(",", ":")).encode()).hexdigest()

def validate(context):
    require(isinstance(context, dict) and set(context) <= ROOT_KEYS, "unsupported intent fields")
    require(context.get("schema") == 1 and context.get("policy") == POLICY, "unsupported release policy schema")
    require(context.get("edition") in ["selfhost", "commercial"], "invalid edition")
    ident(context.get("operationId"), "operationId")
    require(isinstance(context.get("candidateSha"), str) and re.fullmatch(r"[0-9a-f]{40}", context["candidateSha"]), "invalid candidate SHA")
    owner = context.get("owner")
    require(isinstance(owner, dict) and set(owner) == {"deploymentId", "nonce"}, "invalid owner identity")
    for key, value in owner.items():
        ident(value, "owner." + key)
    validate_stack(context.get("before"), "before")
    validate_stack(context.get("target"), "target")
    require(context["target"].get("sourceCommit", context["candidateSha"]) == context["candidateSha"], "target SHA differs from request")
    history = context.get("history")
    require(isinstance(history, dict) and set(history) == {"path", "predecessorSha256", "transitionKind"}, "invalid history descriptor")
    absolute(history["path"], "history.path")
    digest(history["predecessorSha256"], "history predecessor")
    require(history["transitionKind"] in ["joint", "master-only", "tuple-only"], "invalid transition kind")
    require(context.get("phase") in PHASES and type(context.get("mayHaveServed")) is bool, "invalid intent progress")
    if context["phase"] in {"exposure-armed", "observing", "held", "repairing"}:
        require(context["mayHaveServed"], "exposed phase must preserve serving possibility")
    require(type(context.get("revision")) is int and context["revision"] >= 0, "invalid intent revision")
    for key in ["createdAt", "updatedAt"]:
        text(context.get(key), key)
    require(isinstance(context.get("observations"), dict), "invalid observations")
    allowed = {"identity", "service", "authority", "allRequiredPassed", "lineageCoherent", "verifiedDirection", "verifiedStackSha256"}
    observations = context["observations"]
    require(set(observations) <= allowed, "unsupported observations")
    if "identity" in observations:
        require(observations["identity"] in ["exact", "alien", "unknown"], "invalid observed identity")
    if "service" in observations:
        require(observations["service"] in ["usable", "unavailable", "unknown"], "invalid service observation")
    if "authority" in observations:
        require(observations["authority"] in ["applied", "original", "reverted", "unknown", "unobserved"], "invalid authority observation")
    for key in ["allRequiredPassed", "lineageCoherent"]:
        if key in observations:
            require(type(observations[key]) is bool, "invalid " + key)
    if "verifiedDirection" in observations:
        require(observations["verifiedDirection"] in ["target", "before"], "invalid verification direction")
    if "verifiedStackSha256" in observations:
        digest(observations["verifiedStackSha256"], "verified stack")
    failure = context.get("failure")
    require(failure is None or (isinstance(failure, dict) and set(failure) == {"stage", "decision"}), "invalid failure descriptor")
    if failure:
        ident(failure["stage"], "failure stage")
        require(failure["decision"] in DECISIONS, "invalid failure decision")
    resolution = context.get("resolution")
    require(resolution is None or resolution in ["forward", "compensated", "preparation-abort"], "invalid resolution")
    require((context["phase"] == "resolved") == (resolution is not None), "resolution and phase disagree")
    return context

def check_parent(path):
    parent = path.parent
    require(parent.is_dir() and not parent.is_symlink(), "intent directory must be a real directory")
    info = parent.stat()
    require(info.st_uid == os.geteuid() and not info.st_mode & 0o022, "intent directory has unsafe ownership or permissions")

def load(path, operation):
    path = Path(path)
    check_parent(path)
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and not info.st_mode & 0o077, "unsafe intent file")
    require(info.st_size <= 65536, "intent file is too large")
    context = validate(json.loads(path.read_text()))
    require(context["operationId"] == operation, "intent belongs to another operation")
    return context

def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)

def atomic_write(path, data, create=False):
    path = Path(path)
    check_parent(path)
    require(not path.is_symlink(), "refusing intent symlink")
    if create:
        require(not path.exists(), "unresolved intent already exists")
    fd, temporary = tempfile.mkstemp(prefix="." + path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            os.fchmod(stream.fileno(), 0o600)
            json.dump(data, stream, sort_keys=True, separators=(",", ":"))
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        if create:
            # link is no-replace; a different active operation is never overwritten.
            os.link(temporary, path, follow_symlinks=False)
        else:
            os.replace(temporary, path)
        sync_directory(path.parent)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)

def prepare(path, request):
    require(set(request) == {"edition", "operationId", "candidateSha", "owner", "before", "target", "history"}, "invalid prepare request")
    context = copy.deepcopy(request)
    context.update(schema=1, policy=POLICY, createdAt=now(), updatedAt=now(), revision=0,
                   phase="prepared", mayHaveServed=False, observations={}, failure=None, resolution=None)
    validate(context)
    atomic_write(Path(path), context, create=True)
    require(load(path, context["operationId"]) == context, "intent readback differs")
    return context

def checkpoint(path, operation, patch):
    current = load(path, operation)
    require(current["phase"] != "resolved", "resolved intent cannot be updated")
    require(isinstance(patch, dict) and set(patch) <= {"phase", "mayHaveServed", "observations", "failure"}, "cannot change captured release intent")
    updated = copy.deepcopy(current)
    updated.update(patch)
    require(not current["mayHaveServed"] or updated["mayHaveServed"], "serving possibility cannot be forgotten")
    require(updated["phase"] != "resolved", "resolution requires verified resolve")
    updated["revision"] += 1
    updated["updatedAt"] = now()
    validate(updated)
    # A failed update leaves either the previous or the complete new intent.
    # Once exposure is armed both versions conservatively retain mayHaveServed.
    atomic_write(Path(path), updated)
    require(load(path, operation) == updated, "checkpoint readback differs")
    return updated

def confirmed_impact(context, proof):
    if not isinstance(proof, dict):
        return False
    if proof.get("candidateSha") != context["candidateSha"] or proof.get("masterRelease") != context["target"]["masterRelease"]:
        return False
    if proof.get("kind") == "local-service-unavailable":
        return (set(proof) == {"kind", "candidateSha", "masterRelease", "unitState", "loopbackError", "port"}
                and proof["unitState"] == "failed" and proof["loopbackError"] == "ECONNREFUSED"
                and type(proof["port"]) is int and proof["port"] == context["target"].get("port"))
    if proof.get("kind") == "operator-confirmed":
        return (set(proof) == {"kind", "candidateSha", "masterRelease", "evidenceSha256"}
                and isinstance(proof["evidenceSha256"], str)
                and re.fullmatch(r"[0-9a-f]{64}", proof["evidenceSha256"]) is not None)
    return False

def decide(context, facts):
    require(isinstance(facts, dict) and set(facts) <= {"ownerHeld", "identity", "service", "authority", "impact"}, "invalid failure facts")
    require(type(facts.get("ownerHeld")) is bool, "missing owner status")
    require(facts.get("identity") in ["exact", "alien", "unknown"], "missing candidate identity")
    require(facts.get("service") in ["usable", "unavailable", "unknown"], "missing service observation")
    require(facts.get("authority", "unobserved") in ["applied", "original", "reverted", "unknown", "unobserved"], "invalid authority observation")
    if not facts["ownerHeld"]:
        return "CRASH_STOP"
    if not context["mayHaveServed"]:
        return "PREPARATION_ABORT"
    if (facts["identity"] == "exact" and confirmed_impact(context, facts.get("impact"))
            and (facts["impact"]["kind"] != "local-service-unavailable" or facts["service"] == "unavailable")):
        return "COMPENSATE_USER_IMPAIRMENT"
    if facts["identity"] != "exact" or facts["service"] == "unknown" or facts.get("authority") == "unknown":
        return "HOLD_UNKNOWN"
    if facts["service"] == "unavailable":
        return "HOLD_UNKNOWN"
    return "KEEP_FAILED"

def resolve(path, operation, resolution):
    ident(operation, "operationId")
    require(resolution in ["forward", "compensated", "preparation-abort"], "invalid resolution")
    path = Path(path)
    archive = path.with_name(path.name + ".resolved." + operation + ".json")
    if not path.exists() and not path.is_symlink():
        result = load(archive, operation)
        require(result["phase"] == "resolved" and result["resolution"] == resolution, "different archived resolution")
        sync_directory(path.parent)
        return result
    current = load(path, operation)
    if resolution == "preparation-abort":
        require(not current["mayHaveServed"], "cannot resolve possible exposure as preparation")
    else:
        observed = current["observations"]
        require(observed.get("identity") == "exact" and observed.get("service") == "usable"
                and observed.get("allRequiredPassed") is True and observed.get("lineageCoherent") is True
                and observed.get("authority") in {"applied", "original", "reverted", "unobserved"}, "release resolution is not verified")
        direction = "target" if resolution == "forward" else "before"
        require(observed.get("verifiedDirection") == direction
                and observed.get("verifiedStackSha256") == stack_digest(current[direction]), "verification does not bind the selected release stack")
        if current["edition"] == "commercial":
            allowed_authority = {"applied"} if resolution == "forward" else {"original", "reverted"}
            require(observed["authority"] in allowed_authority, "commercial state is not reconciled in the selected direction")
    result = copy.deepcopy(current)
    result.update(phase="resolved", resolution=resolution, updatedAt=now(), revision=current["revision"] + 1)
    validate(result)
    if archive.exists() or archive.is_symlink():
        previous = load(archive, operation)
        immutable = ["schema", "policy", "edition", "operationId", "candidateSha", "owner", "before", "target", "history", "createdAt"]
        require(previous["phase"] == "resolved" and previous["resolution"] == resolution
                and all(previous[key] == current[key] for key in immutable), "conflicting recovery archive")
        fd = os.open(archive, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        sync_directory(path.parent)
    else:
        atomic_write(archive, result, create=True)
    require(load(path, operation) == current, "active intent changed during resolution")
    path.unlink()
    sync_directory(path.parent)
    return result

def summary(context):
    return {key: context[key] for key in ["schema", "policy", "edition", "operationId", "candidateSha", "phase", "revision", "mayHaveServed", "resolution"]}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["prepare", "checkpoint", "inspect", "decide", "resolve"])
    parser.add_argument("--context", required=True)
    parser.add_argument("--operation", required=True)
    parser.add_argument("--input")
    parser.add_argument("--field")
    parser.add_argument("--resolution")
    args = parser.parse_args()
    ident(args.operation, "operationId")
    data = None
    if args.action in ["prepare", "checkpoint", "decide"]:
        require(args.input is not None, "input file required")
        data = json.loads(Path(args.input).read_text())
    if args.action == "prepare":
        require(data.get("operationId") == args.operation, "request operation differs")
        result = prepare(args.context, data)
    elif args.action == "checkpoint":
        result = checkpoint(args.context, args.operation, data)
    elif args.action == "resolve":
        result = resolve(args.context, args.operation, args.resolution)
    else:
        result = load(args.context, args.operation)
        if args.action == "decide":
            print(json.dumps({"operationId": args.operation, "decision": decide(result, data)}))
            return
    if args.field:
        require(args.action == "inspect", "field selection is inspect-only")
        value = result
        for part in args.field.split("."):
            require(isinstance(value, dict) and part in value, "unknown intent field")
            value = value[part]
        print(json.dumps(value, separators=(",", ":")) if isinstance(value, (dict, list, bool)) or value is None else value)
    else:
        print(json.dumps(summary(result), sort_keys=True))

if __name__ == "__main__":
    try:
        main()
    except (PolicyError, OSError, ValueError, KeyError, TypeError) as error:
        print("release-policy: " + str(error), file=sys.stderr)
        sys.exit(1)
