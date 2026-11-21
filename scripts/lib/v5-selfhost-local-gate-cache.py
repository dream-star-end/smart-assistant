#!/usr/bin/env python3
"""Host-local input-digest gate receipt cache for V5 selfhost release trains.

Receipts are strictly evidence of a previous local rc=0 run on byte-identical
immutable Git object inputs + toolchain versions. Any validation/IO/git error
exits non-zero so the shell caller falls back to running the real gate locally.

OCV5-823: Narrowed from coarse whole-scripts/ + monolithic-backend hashing to
per-gate exact file/subtree closures with fail-closed conservative fallbacks
(symlinks, submodules, unknown top-level entries, workspace dependency drift,
and unresolvable dynamic imports promote conservatively).
"""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
import tempfile

SCHEMA = "oc.v5.selfhost.local-gate-receipt/1"
PLAN_SCHEMA = "oc.v5.selfhost.local-gate-plan/1"
MANIFEST_SCHEMA = "oc.v5.selfhost.release-gates/1"
CLOSURE_VERSION = "closure-v2"
PROD_DEFAULT_PREFIX = "/var/lib/openclaude-v5-selfhost"
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
DIGEST_RE = re.compile(r"^[0-9a-f]{64}$")
GATE_ID_RE = re.compile(r"^[a-z][a-z0-9-]+$")
RECEIPT_FILE_RE = re.compile(r"^[a-z][a-z0-9-]+--[0-9a-f]{64}\.json$")
MAX_RECEIPT_BYTES = 65536
MAX_RECEIPTS = 512

# Every build-stage C gate in deploy/v5/selfhost-release-gates.json mapped to its
# precise, sound package/input scope (each gate additionally hashes its own exact
# scripts/deploy/extra file closure rather than the entire scripts/ directory).
GATE_SCOPES = {
    # Pure policy/watch script gates (no whole packages/commercial or packages/gateway)
    "host-log-policy": "policy_host_log",
    "model-policy-recovery": "policy_model",
    "watch-gate": "watch",
    # Pure storage + protocol
    "system-approval-fencing": "storage",
    # Gateway + non-commercial workspace packages + commercial/agent-sandbox prompts
    "upload-retention-http": "gateway",
    "session-workspace-boundary": "gateway",
    "cron-submit-boundary": "gateway",
    # Gateway + CCB source + Bun toolchain
    "codex-late-stop-closure": "gateway_ccb",
    # Gateway + static source-contract reads of two web-react regular files
    "ccb-mcp-availability": "gateway_ccb_web",
    # Gateway + narrowed commercial leaf module (fail-closed transitive closure)
    "codex-chatgpt-ws": "gateway_codex_ws",
    "terminal-unproven": "gateway_liveness",
    # Full backend packages (excludes web-react) + per-gate exact scripts/deploy closure
    "box-success-recovery": "backend",
    "box-continuation": "backend",
    "box-incident-proofs": "backend",
    "box-longtask": "backend",
    "prompt-privacy-lifecycle": "backend",
    "cursor-sand-inference": "backend",
    "delegate-billing-requestid": "backend",
    "callback-payload-hash": "backend",
    "system-executor-fencing": "backend",
    "master-incident-proofs": "backend",
    # All workspace packages including web-react + per-gate exact scripts/deploy closure
    "session-unavailable-rootfix": "backend_web",
    "platform-tool-proofs": "backend_web",
    # Full repo tree (architecture graph scans entire repository)
    "architecture": "full",
}

TOP_DOC_EXCLUDES = frozenset({"docs", "evals", "e2e"})
# Top-level entries that never affect narrowed gate execution (full scope still hashes root_tree).
TOP_NON_RUNTIME_EXCLUDES = frozenset({
    "docs",
    "evals",
    "e2e",
    "apps",
    "ops",
    "infra",
    "arch",
    ".github",
    ".claude",
    ".codex",
    ".gitignore",
    ".gitattributes",
    "AGENTS.md",
    "CLAUDE.md",
    "PLAN.md",
    "README.md",
    "biome.json",
    "changelog.json",
    "static-key-providers.snapshot.json",
})
# Top-level entries hashed per-gate (not wholesale in shared root_config_items).
TOP_PER_GATE_SCOPED = frozenset({
    "packages",
    "scripts",
    "deploy",
    "claude-code-best",
    "bun.lock",
    "bunfig.toml",
})
# Shared root toolchain/config files hashed for every narrowed gate.
ROOT_TOOLCHAIN_FILES = (
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "tsconfig.base.json",
    "deploy/v5/selfhost-release-gates.json",
)

REGULAR_MODES = frozenset({"100644", "100755"})
ALLOWED_TREE_OR_REG_MODES = frozenset({"040000", "100644", "100755"})
BUN_REQUIRED_GATES = frozenset({"codex-late-stop-closure"})
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

# Explicit per-gate seed files/subtrees in addition to the manifest script and
# static transitive closure expansion.
GATE_EXTRA_INPUTS: dict[str, tuple[str, ...]] = {
    "host-log-policy": (
        "deploy/v5-selfhost/host-log-policy.json",
        "deploy/v5-selfhost/logrotate.d",
        "deploy/v5-selfhost/model-availability.json",
        "packages/commercial/src/billing/modelAvailability.ts",
        "scripts/v5-selfhost-host-log-policy.py",
        "scripts/lib/v5-selfhost-host-log-policy.sh",
        "scripts/lib/v5-selfhost-model-policy.sh",
        "scripts/lib/selfhost-model-policy.mjs",
        "scripts/v5-selfhost-master-release-lib.sh",
    ),
    "model-policy-recovery": (
        "deploy/v5-selfhost/model-availability.json",
        "packages/commercial/src/billing/modelAvailability.ts",
        "scripts/lib/selfhost-model-policy.mjs",
        "scripts/lib/v5-selfhost-model-policy.sh",
        "scripts/lib/user-contract.mjs",
        "scripts/v5-user-contract-smoke.mjs",
    ),
    "watch-gate": (
        "deploy/v5-selfhost",
        "deploy/v5/release-metadata.json",
        "packages/commercial/src/db/migrations",
        "packages/cli/src/index.ts",
        "packages/commercial/src/egress/main.ts",
        "scripts/lib",
        "scripts/v5-selfhost-watch.sh",
        "scripts/v5-selfhost-watch-alert.sh",
        "scripts/v5-selfhost-autorecover.sh",
        "scripts/v5-selfhost-rollback.sh",
        "scripts/v5-selfhost-env-drift.sh",
        "scripts/v5-selfhost-env.sh",
        "scripts/v5-selfhost-diagnostics.sh",
        "scripts/v5-selfhost-cutover-survivor.sh",
        "scripts/v5-selfhost-release-policy.sh",
        "scripts/v5-selfhost-restore-worktree-units.sh",
        "scripts/v5-selfhost-master-release-lib.sh",
        "scripts/v5-runtime-release-lib.sh",
        "scripts/deploy-v5-selfhost.sh",
        "scripts/v5-lease-lib.sh",
        "scripts/v5-lease-worker.sh",
        "scripts/v5-migration-compat.py",
        "scripts/v5-migration-ddl.sh",
        "scripts/v5-alert-fanout.sql",
    ),
    "box-success-recovery": (
        "scripts/lib/gateTestDb.mjs",
        "scripts/lib/gateLoadScale.ts",
        "scripts/ocv5-289",
    ),
    "box-incident-proofs": (
        "scripts/lib/gateTestDb.mjs",
        "scripts/lib/gateLoadScale.ts",
        "scripts/cursor-sand-box-relay",
    ),
    "box-longtask": (
        "scripts/lib/gateTestDb.mjs",
        "scripts/lib/gateLoadScale.ts",
        "scripts/check-v5-box-success-recovery.ts",
        "scripts/ocv5-289",
    ),
    "master-incident-proofs": (
        "scripts/lib/gateTestDb.mjs",
    ),
    "cursor-sand-inference": (
        "scripts/cursor-sand-box-relay",
        "scripts/deploy-v5.sh",
        "scripts/v5-selfhost-master-release-lib.sh",
    ),
    "ccb-mcp-availability": (
        "scripts/lib/advisorNoWriteProof.ts",
        "scripts/lib/webSearchCliProof.ts",
        "scripts/test-mutex.sh",
        "scripts/deploy-v5.sh",
        "scripts/v5-selfhost-master-release-lib.sh",
    ),
    "delegate-billing-requestid": (
        "scripts/deploy-v5.sh",
        "scripts/v5-selfhost-master-release-lib.sh",
    ),
    "callback-payload-hash": (
        "scripts/test-mutex.sh",
    ),
    "codex-late-stop-closure": (
        "scripts/ocv5-289/box_keeper.py",
        "scripts/v5-runtime-release-lib.sh",
        "scripts/lib/ccb-shared-inputs.mjs",
        "claude-code-best",
        "bun.lock",
        "bunfig.toml",
    ),
    "codex-chatgpt-ws": (
        "packages/commercial/src/http/codexUpstreamHeaders.ts",
    ),
    "terminal-unproven": (
        "packages/commercial/src/http/proxy/boxRunLiveness.ts",
    ),
    "session-unavailable-rootfix": (
        "scripts/lib/preparationLaneCoverage.ts",
        "scripts/lib/proofTsxCache.ts",
        "scripts/lib/turnDispatchReceiptCoverage.ts",
        "scripts/ops/requeue-failed-tape-jobs.ts",
        "scripts/__tests__/preparationLaneCoverage.test.ts",
        "scripts/__tests__/requeueFailedTapeJobs.test.ts",
        "scripts/__tests__/turnDispatchReceiptCoverage.test.ts",
    ),
}

# Contract-inspected orchestrator scripts: hash their blobs, but do not transitively
# expand all 24 gate scripts listed inside them.
NON_EXPANDED_SCRIPT_LEAVES = frozenset({
    "scripts/v5-selfhost-master-release-lib.sh",
    "scripts/deploy-v5.sh",
    "scripts/deploy-v5-selfhost.sh",
    "scripts/v5-selfhost.sh",
})

JS_TS_EXTS = (".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs")
JS_STATIC_REL_RE = re.compile(
    r"""(?:\bfrom\s+|\bimport\s+(?:type\s+)?|\bimport\s*\(\s*|\brequire\s*\(\s*)(['"])(\.\.?/[^'"\n]+)\1"""
)
JS_DYNAMIC_IMPORT_RE = re.compile(r"""\b(?:import|require)\s*\(\s*(?!['"])""")
REPO_SCRIPT_DEPLOY_REF_RE = re.compile(r"""\b((?:scripts|deploy)/[A-Za-z0-9_./-]+)""")
SIBLING_V5_SCRIPT_RE = re.compile(r"""\b(v5-[a-z0-9_.-]+\.(?:sh|py|mjs|ts|json))\b""")
USER_CONTRACT_PATTERN_RE = re.compile(r"""v5-user-contract-(?:\*|\{[^}]+\})\.mjs""")


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


def _normalize_posix(rel: str) -> str | None:
    parts: list[str] = []
    for seg in PurePosixPath(rel).parts:
        if seg in ("", "."):
            continue
        if seg == "..":
            if not parts:
                return None
            parts.pop()
        else:
            parts.append(seg)
    return "/".join(parts) if parts else None


def _resolve_js_rel(
    source_path: str, spec: str, all_entries: dict[str, tuple[str, str, str]]
) -> str | None:
    parent = str(PurePosixPath(source_path).parent)
    joined = _normalize_posix(f"{parent}/{spec}" if parent != "." else spec)
    if not joined:
        return None
    candidates: list[str] = [joined]
    if joined.endswith(".js"):
        stem = joined[:-3]
        candidates.extend([f"{stem}.ts", f"{stem}.tsx", f"{stem}.mts", f"{stem}.mjs"])
    elif joined.endswith(".mjs"):
        stem = joined[:-4]
        candidates.extend([f"{stem}.mts", f"{stem}.ts"])
    elif joined.endswith(".cjs"):
        stem = joined[:-4]
        candidates.extend([f"{stem}.cts", f"{stem}.ts"])
    else:
        for ext in JS_TS_EXTS:
            candidates.append(f"{joined}{ext}")
        for ext in JS_TS_EXTS:
            candidates.append(f"{joined}/index{ext}")
    for cand in candidates:
        ent = all_entries.get(cand)
        if ent is not None and ent[1] == "blob":
            return cand
    return None


def _ancestors_safe(rel_path: str, all_entries: dict[str, tuple[str, str, str]]) -> bool:
    parts = rel_path.split("/")
    for idx in range(1, len(parts)):
        anc = "/".join(parts[:idx])
        if anc in all_entries and all_entries[anc][:2] != ("040000", "tree"):
            return False
    return True


def _expand_gate_closure(
    repo: str,
    seed_paths: list[str],
    all_entries: dict[str, tuple[str, str, str]],
    blob_cache: dict[str, bytes],
    *,
    expand_commercial_imports: bool,
) -> tuple[list[str], bool, bool, bool]:
    """Expand a gate's seed paths into a sorted list of closure tokens.

    Returns (tokens, symlink_fail_closed, fallback_all_scripts, promote_to_backend).
    """
    visited_paths: set[str] = set()
    queue: list[str] = []
    expanded_files: set[str] = set()
    symlink_fail_closed = False
    fallback_all_scripts = False
    promote_to_backend = False

    def enqueue(rel: str) -> None:
        clean = rel.strip().rstrip("/")
        if not clean or clean in visited_paths:
            return
        visited_paths.add(clean)
        queue.append(clean)

    for seed in seed_paths:
        enqueue(seed)

    # Iterative BFS wave-reading blobs via git cat-file --batch.
    cursor = 0
    while cursor < len(queue):
        wave = queue[cursor:]
        cursor = len(queue)
        to_read: list[tuple[str, str]] = []
        for rel in wave:
            if not _ancestors_safe(rel, all_entries):
                symlink_fail_closed = True
                continue
            ent = all_entries.get(rel)
            if ent is None:
                continue
            mode, otype, oid = ent
            if mode not in ALLOWED_TREE_OR_REG_MODES:
                symlink_fail_closed = True
                continue
            if otype != "blob" or rel in expanded_files:
                continue
            if rel in NON_EXPANDED_SCRIPT_LEAVES:
                continue
            is_script_file = rel.startswith("scripts/") and rel.endswith(
                (*JS_TS_EXTS, ".sh", ".py")
            )
            is_comm_leaf = expand_commercial_imports and rel.startswith("packages/commercial/") and rel.endswith(
                JS_TS_EXTS
            )
            if is_script_file or is_comm_leaf:
                expanded_files.add(rel)
                to_read.append((rel, oid))

        missing_oids = [oid for _rel, oid in to_read if oid not in blob_cache]
        if missing_oids:
            blob_cache.update(read_blobs_batch(repo, list(dict.fromkeys(missing_oids))))

        for rel, oid in to_read:
            text = blob_cache[oid].decode("utf-8", errors="replace")
            if rel.endswith(JS_TS_EXTS):
                if rel.startswith("packages/commercial/") and JS_DYNAMIC_IMPORT_RE.search(text):
                    promote_to_backend = True
                for m in JS_STATIC_REL_RE.finditer(text):
                    spec = m.group(2)
                    resolved = _resolve_js_rel(rel, spec, all_entries)
                    if resolved is None:
                        if rel.startswith("packages/commercial/"):
                            promote_to_backend = True
                        elif rel.startswith("scripts/") and not spec.startswith("../packages/"):
                            fallback_all_scripts = True
                        continue
                    if resolved.startswith("scripts/") or resolved.startswith("deploy/"):
                        enqueue(resolved)
                    elif expand_commercial_imports and resolved.startswith("packages/commercial/"):
                        enqueue(resolved)
                if rel.startswith("scripts/"):
                    for ref_m in REPO_SCRIPT_DEPLOY_REF_RE.finditer(text):
                        cand = ref_m.group(1).rstrip(".,;:")
                        if cand in all_entries:
                            enqueue(cand)
            elif rel.startswith("scripts/") and (rel.endswith(".sh") or rel.endswith(".py")):
                for ref_m in REPO_SCRIPT_DEPLOY_REF_RE.finditer(text):
                    cand = ref_m.group(1).rstrip(".,;:")
                    if cand in all_entries:
                        enqueue(cand)
                for sib_m in SIBLING_V5_SCRIPT_RE.finditer(text):
                    sib = f"scripts/{sib_m.group(1)}"
                    if sib in all_entries:
                        enqueue(sib)
                if USER_CONTRACT_PATTERN_RE.search(text):
                    for path in sorted(all_entries):
                        if path.startswith("scripts/v5-user-contract-") and path.endswith(".mjs"):
                            enqueue(path)

    tokens: list[str] = []
    for rel in sorted(visited_paths):
        ent = all_entries.get(rel)
        if ent is None:
            tokens.append(f"closure:{rel}=missing")
        else:
            mode, otype, oid = ent
            if mode not in ALLOWED_TREE_OR_REG_MODES:
                symlink_fail_closed = True
            tokens.append(f"closure:{rel}={mode}:{otype}:{oid}")
    return tokens, symlink_fail_closed, fallback_all_scripts, promote_to_backend


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
    manifest_scripts: dict[str, str] = {}
    manifest_ids: set[str] = set()
    for g in manifest.get("gates", []):
        if isinstance(g, dict) and isinstance(g.get("id"), str) and not g.get("stage"):
            manifest_ids.add(g["id"])
            if isinstance(g.get("script"), str):
                manifest_scripts[g["id"]] = g["script"]
    for gid in GATE_SCOPES:
        if gid not in manifest_ids:
            raise ValueError(f"cached gate {gid} missing from manifest")

    all_entries, all_utf8_ok = parse_ls_tree_z(git_run(repo, "ls-tree", "-r", "-t", "-z", sha))
    top_entries = {
        path: val for path, val in all_entries.items() if "/" not in path
    }
    if "packages" not in top_entries or top_entries["packages"][:2] != ("040000", "tree"):
        raise ValueError("missing top-level packages tree")
    pkg_entries = {
        path.removeprefix("packages/"): val
        for path, val in all_entries.items()
        if path.startswith("packages/") and "/" not in path.removeprefix("packages/")
    }

    # Any git symlink (120000) or gitlink/submodule (160000) outside excluded doc trees or
    # packages/web-react/* could cross a narrowed scope boundary; fail closed to full_items!
    has_backend_nonregular = not all_utf8_ok
    if not has_backend_nonregular:
        for path, (mode, _otype, _oid) in all_entries.items():
            top_seg = path.split("/", 1)[0]
            if top_seg in TOP_DOC_EXCLUDES or path.startswith("packages/web-react/"):
                continue
            if mode not in ALLOWED_TREE_OR_REG_MODES:
                has_backend_nonregular = True
                break

    manifest_entry = all_entries.get("deploy/v5/selfhost-release-gates.json")
    if manifest_entry is None or manifest_entry[0] not in REGULAR_MODES or manifest_entry[1] != "blob":
        raise ValueError("missing regular release-gates manifest blob")

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

    # Soundness guard: transitively promote narrower scopes whenever any included
    # package declares a workspace dependency outside that scope's closed set, or
    # whenever any symlink/submodule exists in the narrowed tree.
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

    def format_entry(rel_path: str) -> str:
        ent = all_entries.get(rel_path)
        if ent is None:
            return "missing"
        return f"{ent[0]}:{ent[1]}:{ent[2]}"

    full_items = [f"root_tree={root_tree}"]

    # Shared minimal root config base: root toolchain files + conservative fallback for
    # any UNKNOWN top-level entry (not in TOP_NON_RUNTIME_EXCLUDES or TOP_PER_GATE_SCOPED).
    root_toolchain_top_names = {p for p in ROOT_TOOLCHAIN_FILES if "/" not in p}
    root_config_items: list[str] = [
        f"root_cfg:{p}={format_entry(p)}" for p in ROOT_TOOLCHAIN_FILES
    ]
    for name, (mode, otype, oid) in sorted(top_entries.items()):
        if (
            name in root_toolchain_top_names
            or name in TOP_NON_RUNTIME_EXCLUDES
            or name in TOP_PER_GATE_SCOPED
        ):
            continue
        root_config_items.append(f"top_unknown:{name}={mode}:{otype}:{oid}")

    if backend_scope_ok:
        backend_pkg_items: list[str] = list(root_config_items)
        for name, (mode, otype, oid) in sorted(pkg_entries.items()):
            if name == "web-react":
                continue
            backend_pkg_items.append(f"pkg:{name}={mode}:{otype}:{oid}")

        all_pkg_items: list[str] = list(root_config_items)
        for name, (mode, otype, oid) in sorted(pkg_entries.items()):
            all_pkg_items.append(f"pkg:{name}={mode}:{otype}:{oid}")
    else:
        backend_pkg_items = full_items
        all_pkg_items = full_items

    if gateway_scope_ok:
        gateway_pkg_items: list[str] = list(root_config_items)
        for name, (mode, otype, oid) in sorted(pkg_entries.items()):
            if name in ("web-react", "commercial", "cli"):
                continue
            gateway_pkg_items.append(f"pkg:{name}={mode}:{otype}:{oid}")
        gateway_pkg_items.append(
            f"extra:packages/commercial/agent-sandbox={format_entry('packages/commercial/agent-sandbox')}"
        )
        gateway_pkg_items.append(
            f"extra:packages/commercial/package.json={format_entry('packages/commercial/package.json')}"
        )
    else:
        gateway_pkg_items = backend_pkg_items

    if storage_scope_ok:
        storage_pkg_items: list[str] = list(root_config_items)
        for name in ("protocol", "storage"):
            if name not in pkg_entries:
                raise ValueError(f"missing required package {name}")
            mode, otype, oid = pkg_entries[name]
            storage_pkg_items.append(f"pkg:{name}={mode}:{otype}:{oid}")
    else:
        storage_pkg_items = backend_pkg_items

    # Validate CCB web-react extra paths (fail closed to full_items if symlink/ancestor symlink).
    ccb_extras_ok = backend_scope_ok
    ccb_extra_tokens: list[str] = []
    if ccb_extras_ok:
        for extra_path in CCB_WEB_EXTRA_PATHS:
            if not _ancestors_safe(extra_path, all_entries):
                ccb_extras_ok = False
                break
            if extra_path not in all_entries:
                ccb_extra_tokens.append(f"extra:{extra_path}=missing")
            else:
                emode, eotype, eoid = all_entries[extra_path]
                if emode not in REGULAR_MODES or eotype != "blob":
                    ccb_extras_ok = False
                    break
                ccb_extra_tokens.append(f"extra:{extra_path}={emode}:{eotype}:{eoid}")

    if gateway_scope_ok and ccb_extras_ok:
        gateway_ccb_web_items = [*gateway_pkg_items, *ccb_extra_tokens]
    else:
        gateway_ccb_web_items = full_items

    policy_base_items = list(root_config_items) if backend_scope_ok else full_items

    base_scope_lists = {
        "policy_host_log": policy_base_items,
        "policy_model": policy_base_items,
        "watch": policy_base_items,
        "storage": storage_pkg_items,
        "gateway": gateway_pkg_items,
        "gateway_ccb": gateway_pkg_items,
        "gateway_ccb_web": gateway_ccb_web_items,
        "gateway_codex_ws": gateway_pkg_items,
        "gateway_liveness": gateway_pkg_items,
        "backend": backend_pkg_items,
        "backend_web": all_pkg_items,
        "full": full_items,
    }

    commercial_leaf_scopes = frozenset({
        "policy_host_log",
        "policy_model",
        "gateway_codex_ws",
        "gateway_liveness",
    })

    blob_cache: dict[str, bytes] = dict(blobs)
    clean_bun = bun_id.strip()
    gate_digests: dict[str, str] = {}

    for gate_id, scope_name in sorted(GATE_SCOPES.items()):
        bun_token = f"bun={clean_bun}" if gate_id in BUN_REQUIRED_GATES else "bun=not-used"
        if scope_name == "full":
            tokens_for_gate = list(full_items)
        else:
            seeds: list[str] = []
            m_script = manifest_scripts.get(gate_id)
            if m_script:
                seeds.append(m_script)
            seeds.extend(GATE_EXTRA_INPUTS.get(gate_id, ()))
            closure_tokens, sym_fail, fallback_scripts, promote_backend = _expand_gate_closure(
                repo,
                seeds,
                all_entries,
                blob_cache,
                expand_commercial_imports=(scope_name in commercial_leaf_scopes),
            )
            if sym_fail or not backend_scope_ok:
                tokens_for_gate = list(full_items)
            elif scope_name == "gateway_ccb_web" and not ccb_extras_ok:
                tokens_for_gate = list(full_items)
            else:
                if promote_backend:
                    base_tokens = list(backend_pkg_items)
                else:
                    base_tokens = list(base_scope_lists[scope_name])
                if fallback_scripts:
                    base_tokens.append(f"fallback:scripts={format_entry('scripts')}")
                tokens_for_gate = [*base_tokens, *closure_tokens]

        h = hashlib.sha256()
        for token in (
            SCHEMA,
            CLOSURE_VERSION,
            f"gate={gate_id}",
            f"scope={scope_name}",
            f"node={node_ver.strip()}",
            f"python={py_ver.strip()}",
            f"runtime_image={runtime_img.strip()}",
            bun_token,
            *tokens_for_gate,
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
