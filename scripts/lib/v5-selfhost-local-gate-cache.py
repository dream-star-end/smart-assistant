#!/usr/bin/env python3
"""Host-local input-digest gate receipt cache for V5 selfhost release trains.

Receipts are strictly evidence of a previous local rc=0 run on byte-identical
immutable Git object inputs + toolchain versions. Any validation/IO/git error
exits non-zero so the shell caller falls back to running the real gate locally.
"""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile

SCHEMA = "oc.v5.selfhost.local-gate-receipt/1"
PLAN_SCHEMA = "oc.v5.selfhost.local-gate-plan/1"
MANIFEST_SCHEMA = "oc.v5.selfhost.release-gates/1"
PROD_DEFAULT_PREFIX = "/var/lib/openclaude-v5-selfhost"
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
DIGEST_RE = re.compile(r"^[0-9a-f]{64}$")
GATE_ID_RE = re.compile(r"^[a-z][a-z0-9-]+$")
RECEIPT_FILE_RE = re.compile(r"^[a-z][a-z0-9-]+--[0-9a-f]{64}\.json$")
MAX_RECEIPT_BYTES = 65536
MAX_RECEIPTS = 512

# Every build-stage C gate in deploy/v5/selfhost-release-gates.json mapped to its
# conservative, transitive-closed input scope.
GATE_SCOPES = {
    # Pure storage + protocol
    "system-approval-fencing": "storage",
    # Gateway + non-commercial workspace packages + commercial/agent-sandbox prompts
    "upload-retention-http": "gateway",
    "session-workspace-boundary": "gateway",
    "cron-submit-boundary": "gateway",
    "codex-late-stop-closure": "gateway",
    # Full backend + scripts/ops/deploy (excludes web-react, e2e, docs, evals)
    "box-success-recovery": "backend",
    "box-continuation": "backend",
    "box-incident-proofs": "backend",
    "box-longtask": "backend",
    "codex-chatgpt-ws": "backend",
    "terminal-unproven": "backend",
    "prompt-privacy-lifecycle": "backend",
    "cursor-sand-inference": "backend",
    "delegate-billing-requestid": "backend",
    "callback-payload-hash": "backend",
    "system-executor-fencing": "backend",
    "host-log-policy": "backend",
    "model-policy-recovery": "backend",
    "watch-gate": "backend",
    # Touches web-react or e2e in addition to backend
    "ccb-mcp-availability": "full",
    "session-unavailable-rootfix": "full",
    "master-incident-proofs": "full",
    "platform-tool-proofs": "full",
    "architecture": "full",
}

TOP_DOC_EXCLUDES = frozenset({"docs", "evals", "e2e"})
BUN_REQUIRED_GATES = frozenset({"codex-late-stop-closure"})
GATEWAY_ALLOWED_WORKSPACE_DEPS = frozenset({
    "@openclaude/kernel",
    "@openclaude/plugin-sdk",
    "@openclaude/protocol",
    "@openclaude/storage",
    "@openclaude/mcp-memory",
    "@openclaude/channel-feishu",
    "@openclaude/channel-telegram",
    "@openclaude/channel-webchat",
    "@openclaude/channel-wechat",
})
STORAGE_ALLOWED_WORKSPACE_DEPS = frozenset({
    "@openclaude/protocol",
    "@openclaude/storage",
})


def check_node(path: Path, expect_dir: bool, uid: int) -> os.stat_result:
    st = path.lstat()
    if stat.S_ISLNK(st.st_mode):
        raise ValueError(f"symlink rejected: {path}")
    if st.st_uid != uid:
        raise ValueError(f"unexpected owner {st.st_uid} != {uid}: {path}")
    if st.st_mode & 0o022:
        raise ValueError(f"group/other writable rejected: {path}")
    if expect_dir:
        if not stat.S_ISDIR(st.st_mode):
            raise ValueError(f"expected directory: {path}")
    elif not stat.S_ISREG(st.st_mode):
        raise ValueError(f"expected regular file: {path}")
    return st


def ensure_trusted_cache_dir(raw_path: str, create: bool) -> Path:
    path = Path(raw_path)
    if not path.is_absolute() or ".." in path.parts:
        raise ValueError("non-canonical cache directory path")
    euid = os.geteuid()
    if euid == 0:
        parent = path.parent
        for item in reversed([parent, *parent.parents]):
            check_node(item, True, 0)
        if not path.exists():
            if not create:
                raise FileNotFoundError(f"cache directory missing: {path}")
            path.mkdir(mode=0o755, exist_ok=True)
        check_node(path, True, 0)
        return path
    # Unprivileged test mode: never touch production /var/lib roots; enforce strict
    # ownership and non-group/world-writability on the private cache directory itself.
    if str(path).startswith(PROD_DEFAULT_PREFIX):
        raise ValueError("unprivileged caller cannot use production cache root")
    if path.parent.is_symlink() or not path.parent.is_dir():
        raise ValueError("untrusted cache parent")
    if not path.exists():
        if not create:
            raise FileNotFoundError(f"cache directory missing: {path}")
        path.mkdir(mode=0o700, exist_ok=True)
    check_node(path, True, euid)
    return path


def trusted_receipt_file(cache_dir: Path, filename: str) -> Path:
    if not RECEIPT_FILE_RE.fullmatch(filename):
        raise ValueError(f"invalid receipt filename: {filename}")
    path = cache_dir / filename
    st = check_node(path, False, os.geteuid())
    if st.st_size <= 0 or st.st_size > MAX_RECEIPT_BYTES:
        raise ValueError(f"receipt size out of bounds: {st.st_size}")
    return path


def git_run(repo: str, *args: str, stdin_bytes: bytes | None = None) -> bytes:
    proc = subprocess.run(
        ["git", "-C", repo, *args],
        input=stdin_bytes,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=20,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed (rc={proc.returncode})")
    return proc.stdout


def parse_ls_tree(raw: bytes) -> dict[str, tuple[str, str]]:
    entries: dict[str, tuple[str, str]] = {}
    for line in raw.decode("utf-8").splitlines():
        if not line:
            continue
        meta, name = line.split("\t", 1)
        _mode, obj_type, oid = meta.split(" ")
        if not SHA_RE.fullmatch(oid):
            raise ValueError(f"invalid tree oid for {name}")
        entries[name] = (obj_type, oid)
    return entries


def read_blobs_batch(repo: str, oids: list[str]) -> dict[str, bytes]:
    if not oids:
        return {}
    raw = git_run(repo, "cat-file", "--batch", stdin_bytes=("\n".join(oids) + "\n").encode("utf-8"))
    out: dict[str, bytes] = {}
    pos = 0
    for expected_oid in oids:
        nl = raw.index(b"\n", pos)
        header = raw[pos:nl].decode("utf-8").split(" ")
        if len(header) < 3 or header[0] != expected_oid or header[1] != "blob":
            raise ValueError(f"unexpected batch blob header for {expected_oid}")
        size = int(header[2])
        body_start = nl + 1
        body_end = body_start + size
        out[expected_oid] = raw[body_start:body_end]
        pos = body_end + 1
    return out


def workspace_deps(pkg_json_bytes: bytes) -> set[str]:
    doc = json.loads(pkg_json_bytes.decode("utf-8"))
    deps: set[str] = set()
    for field in ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies"):
        sec = doc.get(field)
        if isinstance(sec, dict):
            for name in sec:
                if name.startswith("@openclaude/"):
                    deps.add(name)
    return deps


def validate_arch_report(raw: object) -> dict[str, object]:
    if not isinstance(raw, dict):
        raise ValueError("archReport must be an object")
    by_rule = raw.get("byRule")
    if not isinstance(by_rule, dict):
        raise ValueError("archReport.byRule must be an object")
    clean_by_rule: dict[str, int] = {}
    for k, v in by_rule.items():
        if not isinstance(k, str) or isinstance(v, bool) or not isinstance(v, int) or v < 0:
            raise ValueError("invalid archReport.byRule entry")
        clean_by_rule[k] = v
    for int_field in ("identities", "unmapped"):
        val = raw.get(int_field)
        if isinstance(val, bool) or not isinstance(val, int) or val < 0:
            raise ValueError(f"invalid archReport.{int_field}")
    seconds = raw.get("seconds")
    if isinstance(seconds, bool) or not isinstance(seconds, (int, float)) or seconds < 0:
        raise ValueError("invalid archReport.seconds")
    grown = raw.get("grown")
    stale = raw.get("stale")
    if not isinstance(grown, list) or not isinstance(stale, list):
        raise ValueError("invalid archReport grown/stale lists")
    return {
        "byRule": clean_by_rule,
        "identities": raw["identities"],
        "grown": [str(x) for x in grown],
        "stale": [str(x) for x in stale],
        "unmapped": raw["unmapped"],
        "seconds": float(seconds),
    }


def compute_scope_digests(
    repo: str, sha: str, node_ver: str, py_ver: str, runtime_img: str, bun_id: str
) -> dict[str, str]:
    if not SHA_RE.fullmatch(sha):
        raise ValueError("invalid commit sha")
    if git_run(repo, "cat-file", "-t", sha).decode("utf-8").strip() != "commit":
        raise ValueError("target sha is not a commit")
    root_tree = git_run(repo, "rev-parse", "--verify", f"{sha}^{{tree}}").decode("utf-8").strip()
    if not SHA_RE.fullmatch(root_tree):
        raise ValueError("invalid root tree sha")

    manifest_raw = git_run(repo, "cat-file", "blob", f"{sha}:deploy/v5/selfhost-release-gates.json")
    manifest = json.loads(manifest_raw.decode("utf-8"))
    if manifest.get("schema") != MANIFEST_SCHEMA:
        raise ValueError("unexpected release-gates manifest schema")
    manifest_ids = {
        g["id"] for g in manifest.get("gates", [])
        if isinstance(g, dict) and isinstance(g.get("id"), str) and not g.get("stage")
    }
    for gid in GATE_SCOPES:
        if gid not in manifest_ids:
            raise ValueError(f"cached gate {gid} missing from manifest")

    top_entries = parse_ls_tree(git_run(repo, "ls-tree", sha))
    if "packages" not in top_entries or top_entries["packages"][0] != "tree":
        raise ValueError("missing top-level packages tree")
    pkg_entries = parse_ls_tree(git_run(repo, "ls-tree", f"{sha}:packages"))

    root_pkg = json.loads(git_run(repo, "cat-file", "blob", f"{sha}:package.json").decode("utf-8"))
    raw_ws = root_pkg.get("workspaces") if isinstance(root_pkg, dict) else None
    ws_list = raw_ws if isinstance(raw_ws, list) else []
    has_glob_ws = any(isinstance(w, str) and "*" in w for w in ws_list)
    ws_dirs = [
        w.strip("/")
        for w in ws_list
        if isinstance(w, str) and w.strip("/") and w.strip("/") != "packages/web-react" and "*" not in w
    ]
    candidate_dirs = list(
        dict.fromkeys([
            *ws_dirs,
            *(f"packages/{name}" for name in sorted(pkg_entries) if name != "web-react"),
        ])
    )
    pkg_rel_to_key = {
        f"{d}/package.json": (d.removeprefix("packages/") if d.startswith("packages/") else d)
        for d in candidate_dirs
    }
    batch_rels = list(
        dict.fromkeys([
            "packages/commercial/agent-sandbox",
            "packages/commercial/package.json",
            *pkg_rel_to_key.keys(),
        ])
    )
    batch_specs = [f"{sha}:{rel}" for rel in batch_rels]
    batch_out = git_run(
        repo,
        "cat-file",
        "--batch-check",
        stdin_bytes=("\n".join(batch_specs) + "\n").encode("utf-8"),
    ).decode("utf-8").splitlines()
    if len(batch_out) != len(batch_specs):
        raise ValueError("unexpected git batch-check line count")

    resolved_extra: dict[str, str] = {}
    blob_oids: list[str] = []
    pkg_blob_oid: dict[str, str] = {}
    for rel, line in zip(batch_rels, batch_out):
        if line.endswith(" missing"):
            resolved_extra[rel] = "missing"
        else:
            parts = line.split(" ")
            if len(parts) < 2 or not SHA_RE.fullmatch(parts[0]):
                raise ValueError(f"invalid batch-check line for {rel}")
            resolved_extra[rel] = f"{parts[1]}:{parts[0]}"
            if parts[1] == "blob" and rel in pkg_rel_to_key:
                pkg_blob_oid[pkg_rel_to_key[rel]] = parts[0]
                if parts[0] not in blob_oids:
                    blob_oids.append(parts[0])

    blobs = read_blobs_batch(repo, blob_oids)
    pkg_deps = {name: workspace_deps(blobs[oid]) for name, oid in pkg_blob_oid.items()}

    # Soundness guard: transitively promote narrower scopes whenever any included
    # package declares a workspace dependency outside that scope's closed set.
    backend_scope_ok = not has_glob_ws and all("@openclaude/web-react" not in deps for deps in pkg_deps.values())
    storage_scope_ok = (
        backend_scope_ok
        and "protocol" in pkg_deps
        and "storage" in pkg_deps
        and (pkg_deps["protocol"] | pkg_deps["storage"]).issubset(STORAGE_ALLOWED_WORKSPACE_DEPS)
    )
    gateway_scope_ok = (
        storage_scope_ok
        and "gateway" in pkg_deps
        and all(
            deps.issubset(GATEWAY_ALLOWED_WORKSPACE_DEPS)
            for name, deps in pkg_deps.items()
            if name not in ("commercial", "cli")
        )
    )

    full_items = [f"root_tree={root_tree}"]
    base_items: list[str] = []
    for name, (otype, oid) in sorted(top_entries.items()):
        if name == "packages" or name in TOP_DOC_EXCLUDES:
            continue
        base_items.append(f"top:{name}={otype}:{oid}")

    if backend_scope_ok:
        backend_items = list(base_items)
        for name, (otype, oid) in sorted(pkg_entries.items()):
            if name == "web-react":
                continue
            backend_items.append(f"pkg:{name}={otype}:{oid}")
    else:
        backend_items = full_items

    if gateway_scope_ok:
        gateway_items = list(base_items)
        for name, (otype, oid) in sorted(pkg_entries.items()):
            if name in ("web-react", "commercial", "cli"):
                continue
            gateway_items.append(f"pkg:{name}={otype}:{oid}")
        gateway_items.append(f"extra:packages/commercial/agent-sandbox={resolved_extra['packages/commercial/agent-sandbox']}")
        gateway_items.append(f"extra:packages/commercial/package.json={resolved_extra['packages/commercial/package.json']}")
    else:
        gateway_items = backend_items

    if storage_scope_ok:
        storage_items = list(base_items)
        for name in ("protocol", "storage"):
            if name not in pkg_entries:
                raise ValueError(f"missing required package {name}")
            otype, oid = pkg_entries[name]
            storage_items.append(f"pkg:{name}={otype}:{oid}")
    else:
        storage_items = backend_items

    scope_lists = {
        "storage": storage_items,
        "gateway": gateway_items,
        "backend": backend_items,
        "full": full_items,
    }

    clean_bun = bun_id.strip()
    gate_digests: dict[str, str] = {}
    for gate_id, scope_name in sorted(GATE_SCOPES.items()):
        bun_token = f"bun={clean_bun}" if gate_id in BUN_REQUIRED_GATES else "bun=not-used"
        h = hashlib.sha256()
        for token in (
            SCHEMA,
            f"gate={gate_id}",
            f"scope={scope_name}",
            f"node={node_ver.strip()}",
            f"python={py_ver.strip()}",
            f"runtime_image={runtime_img.strip()}",
            bun_token,
            *scope_lists[scope_name],
        ):
            h.update(token.encode("utf-8") + b"\0")
        gate_digests[gate_id] = h.hexdigest()
    return gate_digests


def atomic_write_json(directory: Path, target_name: str, payload: object, mode: int) -> None:
    raw = (json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
    fd, tmp_name = tempfile.mkstemp(prefix=f".{target_name}.tmp-", dir=str(directory))
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp_path, mode)
        os.replace(tmp_path, directory / target_name)
    except BaseException:
        try:
            tmp_path.unlink()
        except OSError:
            pass
        raise


def read_verified_receipt(cache_dir: Path, gate_id: str, expected_digest: str) -> dict[str, object] | None:
    filename = f"{gate_id}--{expected_digest}.json"
    candidate = cache_dir / filename
    try:
        if not candidate.exists() and not candidate.is_symlink():
            return None
        path = trusted_receipt_file(cache_dir, filename)
        doc = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(doc, dict):
            return None
        if (
            doc.get("schema") != SCHEMA
            or doc.get("gateId") != gate_id
            or doc.get("inputDigest") != expected_digest
            or doc.get("conclusion") != "success"
            or not isinstance(doc.get("sourceSha"), str)
            or not SHA_RE.fullmatch(doc["sourceSha"])
        ):
            return None
        if gate_id == "architecture":
            doc["archReport"] = validate_arch_report(doc.get("archReport"))
        return doc
    except Exception:
        return None


def gc_receipts(cache_dir: Path, protected_names: set[str] | None = None) -> None:
    protected = protected_names or set()
    entries: list[tuple[int, str, Path]] = []
    euid = os.geteuid()
    for entry in cache_dir.iterdir():
        try:
            if not RECEIPT_FILE_RE.fullmatch(entry.name):
                continue
            st = check_node(entry, False, euid)
            entries.append((st.st_mtime_ns, entry.name, entry))
        except Exception:
            continue
    if len(entries) <= MAX_RECEIPTS:
        return
    entries.sort(key=lambda item: (item[0], item[1]), reverse=True)
    kept = 0
    for _mtime, name, path in entries:
        if name in protected or kept < MAX_RECEIPTS:
            if name not in protected:
                kept += 1
            continue
        try:
            path.unlink()
        except OSError:
            pass


def cmd_plan(args: list[str]) -> int:
    if len(args) != 9:
        raise ValueError(
            "usage: plan <cache_dir> <repo_root> <sha> <plan_file> <node_ver> <py_ver> <runtime_img> <bun_id> <force>"
        )
    cache_raw, repo_root, sha, plan_raw, node_ver, py_ver, runtime_img, bun_id, force = args
    cache_dir = ensure_trusted_cache_dir(cache_raw, create=True)
    plan_path = Path(plan_raw)
    if not plan_path.is_absolute() or ".." in plan_path.parts or plan_path.parent.is_symlink():
        raise ValueError("untrusted plan output path")
    digests = compute_scope_digests(repo_root, sha, node_ver, py_ver, runtime_img, bun_id)
    has_bun = bool(bun_id.strip())
    gates_plan: dict[str, object] = {}
    hits = 0
    for gate_id, digest in sorted(digests.items()):
        cacheable = has_bun or (gate_id not in BUN_REQUIRED_GATES)
        rec = None if (force == "1" or not cacheable) else read_verified_receipt(cache_dir, gate_id, digest)
        entry: dict[str, object] = {
            "scope": GATE_SCOPES[gate_id],
            "inputDigest": digest,
            "cacheable": cacheable,
            "hit": rec is not None,
        }
        if rec is not None:
            hits += 1
            entry["receiptSourceSha"] = rec["sourceSha"]
            if gate_id == "architecture":
                entry["archReport"] = rec["archReport"]
        gates_plan[gate_id] = entry
    plan_doc = {
        "schema": PLAN_SCHEMA,
        "sourceSha": sha,
        "cacheDir": str(cache_dir),
        "hits": hits,
        "total": len(digests),
        "gates": gates_plan,
    }
    atomic_write_json(plan_path.parent, plan_path.name, plan_doc, 0o600)
    print(f"{hits}/{len(digests)}")
    return 0


def load_plan_gate(plan_raw: str, sha: str, gate_id: str) -> tuple[Path, dict[str, object], set[str]]:
    if not SHA_RE.fullmatch(sha) or not GATE_ID_RE.fullmatch(gate_id):
        raise ValueError("invalid sha or gate id")
    plan_path = Path(plan_raw)
    if not plan_path.is_absolute() or ".." in plan_path.parts:
        raise ValueError("missing or untrusted plan file")
    st = check_node(plan_path, False, os.geteuid())
    if st.st_size <= 0 or st.st_size > MAX_RECEIPT_BYTES * 4:
        raise ValueError("plan file size out of bounds")
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    if not isinstance(plan, dict) or plan.get("schema") != PLAN_SCHEMA or plan.get("sourceSha") != sha:
        raise ValueError("plan sha/schema mismatch")
    gates = plan.get("gates")
    if not isinstance(gates, dict) or gate_id not in gates or not isinstance(gates[gate_id], dict):
        raise ValueError(f"gate {gate_id} not in plan")
    entry = gates[gate_id]
    digest = entry.get("inputDigest")
    if not isinstance(digest, str) or not DIGEST_RE.fullmatch(digest):
        raise ValueError("invalid inputDigest in plan")
    protected = {
        f"{gid}--{g['inputDigest']}.json"
        for gid, g in gates.items()
        if isinstance(g, dict) and isinstance(g.get("inputDigest"), str) and DIGEST_RE.fullmatch(g["inputDigest"])
    }
    cache_dir = ensure_trusted_cache_dir(str(plan.get("cacheDir", "")), create=False)
    return cache_dir, entry, protected


def cmd_has(args: list[str]) -> int:
    if len(args) not in (3, 4):
        raise ValueError("usage: has <plan_file> <sha> <gate_id> [arch_restore_path]")
    plan_raw, sha, gate_id = args[:3]
    arch_out = args[3] if len(args) == 4 else ""
    cache_dir, entry, _protected = load_plan_gate(plan_raw, sha, gate_id)
    if not entry.get("cacheable", True) or not entry.get("hit"):
        return 1
    # Re-verify receipt on disk at point of use so tampered/deleted files never pass.
    rec = read_verified_receipt(cache_dir, gate_id, str(entry["inputDigest"]))
    if rec is None:
        return 1
    if gate_id == "architecture":
        if not arch_out:
            return 1
        out_path = Path(arch_out)
        if not out_path.is_absolute() or ".." in out_path.parts or out_path.is_symlink() or out_path.parent.is_symlink():
            raise ValueError("untrusted architecture restore path")
        out_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        check_node(out_path.parent, True, os.geteuid())
        atomic_write_json(out_path.parent, out_path.name, rec["archReport"], 0o600)
    print(f"{rec['sourceSha'][:12]}:{str(entry['inputDigest'])[:12]}")
    return 0


def cmd_record(args: list[str]) -> int:
    if len(args) not in (3, 4):
        raise ValueError("usage: record <plan_file> <sha> <gate_id> [arch_report_path]")
    plan_raw, sha, gate_id = args[:3]
    arch_in = args[3] if len(args) == 4 else ""
    cache_dir, entry, protected = load_plan_gate(plan_raw, sha, gate_id)
    if not entry.get("cacheable", True):
        return 0
    digest = str(entry["inputDigest"])
    receipt: dict[str, object] = {
        "schema": SCHEMA,
        "gateId": gate_id,
        "scope": str(entry.get("scope", "")),
        "inputDigest": digest,
        "sourceSha": sha,
        "conclusion": "success",
        "verifiedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    if gate_id == "architecture":
        if not arch_in:
            raise ValueError("architecture receipt requires arch report path")
        in_path = Path(arch_in)
        if in_path.is_symlink() or not in_path.is_file() or in_path.stat().st_size > MAX_RECEIPT_BYTES:
            raise ValueError("invalid architecture report file")
        receipt["archReport"] = validate_arch_report(json.loads(in_path.read_text(encoding="utf-8")))
    filename = f"{gate_id}--{digest}.json"
    atomic_write_json(cache_dir, filename, receipt, 0o644)
    gc_receipts(cache_dir, protected)
    return 0


def main() -> int:
    if len(sys.argv) < 2:
        raise ValueError("missing subcommand")
    sub = sys.argv[1]
    rest = sys.argv[2:]
    if sub == "plan":
        return cmd_plan(rest)
    if sub == "has":
        return cmd_has(rest)
    if sub == "record":
        return cmd_record(rest)
    raise ValueError(f"unknown subcommand: {sub}")


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        sys.stderr.write(f"[local-gate-cache] {exc}\n")
        sys.exit(1)
