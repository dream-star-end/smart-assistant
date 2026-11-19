#!/usr/bin/env python3
"""Host-local input-digest gate receipt cache for V5 commercial deploy-v5.sh.

Receipts are strictly evidence of a previous local rc=0 run on byte-identical
immutable Git object inputs + toolchain/runtime versions. Any validation, IO,
symlink, permission, or git error exits non-zero so the shell caller falls back
to executing the real gate (fail-closed to run).
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

SCHEMA = "oc.v5.commercial.local-gate-receipt/1"
PLAN_SCHEMA = "oc.v5.commercial.local-gate-plan/1"
PROD_DEFAULT_PREFIX = "/var/lib/openclaude-v5-commercial"
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
DIGEST_RE = re.compile(r"^[0-9a-f]{64}$")
GATE_ID_RE = re.compile(r"^[a-z][a-z0-9-]+$")
RECEIPT_FILE_RE = re.compile(r"^[a-z][a-z0-9-]+--[0-9a-f]{64}\.json$")
MAX_RECEIPT_BYTES = 65536
MAX_RECEIPTS = 512

# Every build_release proof gate in scripts/deploy-v5.sh mapped to a conservative,
# transitive-closed input scope.
GATE_SCOPES: dict[str, str] = {
    # Pure storage + protocol
    "system-approval-fencing": "storage",
    # Gateway + non-commercial workspace packages + commercial/agent-sandbox prompts
    "upload-retention-http": "gateway",
    "cron-submit-boundary": "gateway",
    "codex-late-stop-closure": "gateway",
    # Full backend + scripts/ops/deploy (excludes web-react, e2e, docs, evals)
    "queued-consumer": "backend",
    "master-incident-proofs": "backend",
    "prompt-privacy-lifecycle": "backend",
    "system-executor-fencing": "backend",
    "lossless-anchor-contract": "backend",
    "visible-orphan-liveness": "backend",
    "cursor-sand-inference": "backend",
    "delegate-billing-requestid": "backend",
    "callback-payload-hash": "backend",
    "box-success-recovery": "backend",
    "box-continuation": "backend",
    "box-incident-proofs": "backend",
    "box-terminal-unproven": "backend",
    "grok-cli-compatibility": "backend",
    "box-longtask": "backend",
    "codex-chatgpt-ws": "backend",
    # Backend + static source-contract reads of two web-react regular files
    "ccb-mcp-availability": "backend_ccb",
    # Full repo tree (imports web-react runtime/build contracts or full-repo seed)
    "ocv5-376-platform-tool-proofs": "full",
    "session-unavailable-rootfix": "full",
    "taskboard-commercial-gate": "full",
    "advisor-1m-dup-picker": "full",
}

REMOTE_STAGING_GATES = frozenset({
    "lossless-anchor-contract",
    "visible-orphan-liveness",
    "cursor-sand-inference",
    "ccb-mcp-availability",
    "delegate-billing-requestid",
    "callback-payload-hash",
    "cron-submit-boundary",
    "session-unavailable-rootfix",
    "taskboard-commercial-gate",
    "codex-chatgpt-ws",
    "advisor-1m-dup-picker",
})

GATE_BUN_KEY = {
    "master-incident-proofs": "master",
    "codex-late-stop-closure": "codex",
}
TOP_DOC_EXCLUDES = frozenset({"docs", "evals", "e2e"})
REGULAR_MODES = frozenset({"100644", "100755"})
ALLOWED_TREE_OR_REG_MODES = frozenset({"040000", "100644", "100755"})
CCB_WEB_EXTRA_PATHS = (
    "packages/web-react/src/lib/chat/extraTool.ts",
    "packages/web-react/src/components/tool/format.ts",
)
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
    if not path.is_absolute() or ".." in path.parts or "." in path.parts:
        raise ValueError("non-canonical cache directory path")
    euid = os.geteuid()
    if euid == 0:
        # Walk and verify every ancestor; create up to two missing tail dirs (e.g. root + gate-receipts).
        parents = list(reversed(path.parents))
        for item in parents[:-1]:
            check_node(item, True, 0)
        parent = path.parent
        if not parent.exists() and create:
            parent.mkdir(mode=0o755, exist_ok=True)
        check_node(parent, True, 0)
        if not path.exists():
            if not create:
                raise FileNotFoundError(f"cache directory missing: {path}")
            path.mkdir(mode=0o755, exist_ok=True)
        check_node(path, True, 0)
        return path
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


def parse_ls_tree_z(raw: bytes) -> tuple[dict[str, tuple[str, str, str]], bool]:
    entries: dict[str, tuple[str, str, str]] = {}
    all_utf8_ok = True
    for rec in raw.split(b"\0"):
        if not rec:
            continue
        meta_b, path_b = rec.split(b"\t", 1)
        mode, obj_type, oid = meta_b.decode("ascii").split(" ")
        if not SHA_RE.fullmatch(oid):
            raise ValueError("invalid tree oid")
        try:
            name = path_b.decode("utf-8")
        except UnicodeDecodeError:
            all_utf8_ok = False
            continue
        entries[name] = (mode, obj_type, oid)
    return entries, all_utf8_ok


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


def compute_scope_digests(
    repo: str,
    sha: str,
    node_ver: str,
    remote_node_ver: str,
    npm_ver: str,
    py_ver: str,
    runtime_img: str,
    runtime_img_id: str,
    master_bun_id: str,
    codex_bun_id: str,
) -> dict[str, str]:
    if not SHA_RE.fullmatch(sha):
        raise ValueError("invalid commit sha")
    if git_run(repo, "cat-file", "-t", sha).decode("utf-8").strip() != "commit":
        raise ValueError("target sha is not a commit")
    root_tree = git_run(repo, "rev-parse", "--verify", f"{sha}^{{tree}}").decode("utf-8").strip()
    if not SHA_RE.fullmatch(root_tree):
        raise ValueError("invalid root tree sha")

    all_entries, all_utf8_ok = parse_ls_tree_z(git_run(repo, "ls-tree", "-r", "-t", "-z", sha))
    top_entries = {path: val for path, val in all_entries.items() if "/" not in path}
    if "packages" not in top_entries or top_entries["packages"][:2] != ("040000", "tree"):
        raise ValueError("missing top-level packages tree")
    pkg_entries = {
        path.removeprefix("packages/"): val
        for path, val in all_entries.items()
        if path.startswith("packages/") and "/" not in path.removeprefix("packages/")
    }

    # Any git symlink (120000) or submodule (160000) outside excluded doc trees or
    # packages/web-react/* could cross a narrowed scope boundary; fail closed to full_items.
    has_backend_nonregular = not all_utf8_ok
    if not has_backend_nonregular:
        for path, (mode, _otype, _oid) in all_entries.items():
            top_seg = path.split("/", 1)[0]
            if top_seg in TOP_DOC_EXCLUDES or path.startswith("packages/web-react/"):
                continue
            if mode not in ALLOWED_TREE_OR_REG_MODES:
                has_backend_nonregular = True
                break

    root_pkg_entry = top_entries.get("package.json")
    if root_pkg_entry is None or root_pkg_entry[1] != "blob":
        raise ValueError("missing root package.json blob")
    if root_pkg_entry[0] in REGULAR_MODES:
        root_pkg = json.loads(git_run(repo, "cat-file", "blob", root_pkg_entry[2]).decode("utf-8"))
    else:
        has_backend_nonregular = True
        root_pkg = {}
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

    blob_oids: list[str] = []
    pkg_blob_oid: dict[str, str] = {}
    for rel, key in pkg_rel_to_key.items():
        entry = all_entries.get(rel)
        if entry is None:
            continue
        emode, eotype, eoid = entry
        if emode in REGULAR_MODES and eotype == "blob":
            pkg_blob_oid[key] = eoid
            if eoid not in blob_oids:
                blob_oids.append(eoid)
        else:
            has_backend_nonregular = True

    blobs = read_blobs_batch(repo, blob_oids)
    pkg_deps = {name: workspace_deps(blobs[oid]) for name, oid in pkg_blob_oid.items()}

    backend_scope_ok = (
        not has_backend_nonregular
        and not has_glob_ws
        and all("@openclaude/web-react" not in deps for deps in pkg_deps.values())
    )
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
    for name, (mode, otype, oid) in sorted(top_entries.items()):
        if name == "packages" or name in TOP_DOC_EXCLUDES:
            continue
        base_items.append(f"top:{name}={mode}:{otype}:{oid}")

    # Every workspace manifest (including packages/web-react/package.json) is read by
    # `npm ci` inside box_cand and workspace resolution across all gates. Bind them all
    # into base_items; if any workspace manifest or its ancestor is non-regular, fail
    # closed to full_items so narrowed scopes never false-hit on workspace manifest edits.
    all_ws_manifests_ok = True
    ws_manifest_paths = sorted(
        {
            *(f"{w.strip('/')}/package.json" for w in ws_list if isinstance(w, str) and w.strip("/") and "*" not in w),
            "packages/web-react/package.json",
        }
    )
    for mf_path in ws_manifest_paths:
        parts_p = mf_path.split("/")
        for idx in range(1, len(parts_p)):
            anc = "/".join(parts_p[:idx])
            if anc in all_entries and all_entries[anc][:2] != ("040000", "tree"):
                all_ws_manifests_ok = False
                break
        if not all_ws_manifests_ok:
            break
        ent = all_entries.get(mf_path)
        if ent is None:
            base_items.append(f"ws_manifest:{mf_path}=missing")
        elif ent[0] in REGULAR_MODES and ent[1] == "blob":
            base_items.append(f"ws_manifest:{mf_path}={ent[0]}:{ent[1]}:{ent[2]}")
        else:
            all_ws_manifests_ok = False
            break

    if not all_ws_manifests_ok:
        backend_scope_ok = False
        storage_scope_ok = False
        gateway_scope_ok = False

    def format_entry(rel_path: str) -> str:
        ent = all_entries.get(rel_path)
        if ent is None:
            return "missing"
        return f"{ent[0]}:{ent[1]}:{ent[2]}"

    if backend_scope_ok:
        backend_items = list(base_items)
        for name, (mode, otype, oid) in sorted(pkg_entries.items()):
            if name == "web-react":
                continue
            backend_items.append(f"pkg:{name}={mode}:{otype}:{oid}")
        ccb_extras_ok = True
        ccb_extra_tokens: list[str] = []
        for extra_path in CCB_WEB_EXTRA_PATHS:
            parts_p = extra_path.split("/")
            for idx in range(1, len(parts_p)):
                anc = "/".join(parts_p[:idx])
                if anc in all_entries and all_entries[anc][:2] != ("040000", "tree"):
                    ccb_extras_ok = False
                    break
            if not ccb_extras_ok:
                break
            if extra_path not in all_entries:
                ccb_extra_tokens.append(f"extra:{extra_path}=missing")
            else:
                emode, eotype, eoid = all_entries[extra_path]
                if emode not in REGULAR_MODES or eotype != "blob":
                    ccb_extras_ok = False
                    break
                ccb_extra_tokens.append(f"extra:{extra_path}={emode}:{eotype}:{eoid}")
        backend_ccb_items = [*backend_items, *ccb_extra_tokens] if ccb_extras_ok else full_items
    else:
        backend_items = full_items
        backend_ccb_items = full_items

    if gateway_scope_ok:
        gateway_items = list(base_items)
        for name, (mode, otype, oid) in sorted(pkg_entries.items()):
            if name in ("web-react", "commercial", "cli"):
                continue
            gateway_items.append(f"pkg:{name}={mode}:{otype}:{oid}")
        gateway_items.append(f"extra:packages/commercial/agent-sandbox={format_entry('packages/commercial/agent-sandbox')}")
        gateway_items.append(f"extra:packages/commercial/package.json={format_entry('packages/commercial/package.json')}")
    else:
        gateway_items = backend_items

    if storage_scope_ok:
        storage_items = list(base_items)
        for name in ("protocol", "storage"):
            if name not in pkg_entries:
                raise ValueError(f"missing required package {name}")
            mode, otype, oid = pkg_entries[name]
            storage_items.append(f"pkg:{name}={mode}:{otype}:{oid}")
    else:
        storage_items = backend_items

    scope_lists = {
        "storage": storage_items,
        "gateway": gateway_items,
        "backend": backend_items,
        "backend_ccb": backend_ccb_items,
        "full": full_items,
    }

    bun_ids = {
        "master": master_bun_id.strip(),
        "codex": codex_bun_id.strip(),
    }
    clean_remote_node = remote_node_ver.strip()
    gate_digests: dict[str, str] = {}
    for gate_id, scope_name in sorted(GATE_SCOPES.items()):
        bun_role = GATE_BUN_KEY.get(gate_id)
        bun_token = f"bun:{bun_role}={bun_ids[bun_role]}" if bun_role else "bun=not-used"
        remote_token = (
            f"remote_node={clean_remote_node}" if gate_id in REMOTE_STAGING_GATES else "remote_node=not-used"
        )
        h = hashlib.sha256()
        for token in (
            SCHEMA,
            f"gate={gate_id}",
            f"scope={scope_name}",
            f"node={node_ver.strip()}",
            remote_token,
            f"npm={npm_ver.strip()}",
            f"python={py_ver.strip()}",
            f"runtime_image={runtime_img.strip()}",
            f"runtime_image_id={runtime_img_id.strip()}",
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
    kept = sum(1 for _mtime, name, _path in entries if name in protected)
    for _mtime, name, path in entries:
        if name in protected:
            continue
        if kept < MAX_RECEIPTS:
            kept += 1
            continue
        try:
            path.unlink()
        except OSError:
            pass


def cmd_plan(args: list[str]) -> int:
    if len(args) != 13:
        raise ValueError(
            "usage: plan <cache_dir> <repo_root> <sha> <plan_file> <node_ver> <remote_node_ver> "
            "<npm_ver> <py_ver> <runtime_img> <runtime_img_id> <master_bun_id> <codex_bun_id> <force>"
        )
    (
        cache_raw, repo_root, sha, plan_raw, node_ver, remote_node_ver,
        npm_ver, py_ver, runtime_img, runtime_img_id, master_bun_id, codex_bun_id, force,
    ) = args
    cache_dir = ensure_trusted_cache_dir(cache_raw, create=True)
    plan_path = Path(plan_raw)
    if not plan_path.is_absolute() or ".." in plan_path.parts or plan_path.parent.is_symlink():
        raise ValueError("untrusted plan output path")
    digests = compute_scope_digests(
        repo_root, sha, node_ver, remote_node_ver, npm_ver, py_ver,
        runtime_img, runtime_img_id, master_bun_id, codex_bun_id,
    )
    bun_present = {
        "master": bool(master_bun_id.strip()),
        "codex": bool(codex_bun_id.strip()),
    }
    has_npm = bool(npm_ver.strip())
    has_remote_node = bool(remote_node_ver.strip())
    gates_plan: dict[str, object] = {}
    hits = 0
    for gate_id, digest in sorted(digests.items()):
        bun_role = GATE_BUN_KEY.get(gate_id)
        cacheable = (
            has_npm
            and (bun_role is None or bun_present[bun_role])
            and (has_remote_node or gate_id not in REMOTE_STAGING_GATES)
        )
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
    if len(args) != 3:
        raise ValueError("usage: has <plan_file> <sha> <gate_id>")
    plan_raw, sha, gate_id = args
    cache_dir, entry, _protected = load_plan_gate(plan_raw, sha, gate_id)
    if not entry.get("cacheable", True) or not entry.get("hit"):
        return 1
    # Re-verify receipt on disk at point of use so tampered/deleted files never pass.
    rec = read_verified_receipt(cache_dir, gate_id, str(entry["inputDigest"]))
    if rec is None:
        return 1
    print(f"{rec['sourceSha'][:12]}:{str(entry['inputDigest'])[:12]}")
    return 0


def cmd_record(args: list[str]) -> int:
    if len(args) != 3:
        raise ValueError("usage: record <plan_file> <sha> <gate_id>")
    plan_raw, sha, gate_id = args
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
        sys.stderr.write(f"[commercial-gate-cache] {exc}\n")
        sys.exit(1)
