#!/usr/bin/env python3
"""oc-site — publish and manage persistent static sites (*.congjianai.com)."""

from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
from urllib import error, parse, request

# Pin to the active finalized platform bundle root.
SELF_ROOT = Path(__file__).resolve().parent.parent

MASTER_ENV = "OPENCLAUDE_V3_MASTER_BASE_URL"
TOKEN_ENV = "OPENCLAUDE_V3_CONTAINER_TOKEN"
AUTH_FILES = (
    Path("/home/agent/.openclaude/container-auth.json"),
    Path.home() / ".openclaude" / "container-auth.json",
)

SITE_BUNDLE_MAGIC = b"OCSB1\n"
SITE_BUNDLE_MAGIC_V2 = b"OCSB2\n"
MAX_FILES = 500
MAX_SINGLE_FILE_BYTES = 10 * 1024 * 1024
MAX_TOTAL_BYTES = 25 * 1024 * 1024
SKIP_DIRS = {".git", "node_modules", "__pycache__"}
STATE_FILE_NAME = ".oc-site-state.json"
SKIP_FILES = {".DS_Store", STATE_FILE_NAME}


class SiteCliError(Exception):
    def __init__(self, code: str, message: str, retryable: bool = False):
        super().__init__(message)
        self.payload = {"ok": False, "code": code, "message": message, "retryable": retryable}


def auth() -> tuple[str, str]:
    base = os.environ.get(MASTER_ENV, "").strip().rstrip("/")
    token = os.environ.get(TOKEN_ENV, "").strip()
    if base and token:
        return base, token
    for path in AUTH_FILES:
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        base = str(value.get("masterBaseUrl", "")).strip().rstrip("/")
        token = str(value.get("containerToken", "")).strip()
        if base and token:
            return base, token
    raise SiteCliError("NOT_IN_CONTAINER", "oc-site only works inside an OpenClaude container")


def call(
    method: str,
    path: str,
    *,
    raw_body: bytes | None = None,
    json_body: dict | None = None,
    extra_headers: dict[str, str] | None = None,
    timeout: int = 60,
) -> dict:
    base, token = auth()
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
    }
    if extra_headers:
        headers.update(extra_headers)
    data = raw_body
    if json_body is not None:
        data = json.dumps(json_body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = request.Request(f"{base}/internal/v3/sites{path}", data=data, method=method, headers=headers)
    # Bypass proxy env vars when calling internal master/egress bridge.
    opener = request.build_opener(request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")[:4000]
        try:
            detail = json.loads(body).get("error", {})
        except ValueError:
            detail = {}
        code = detail.get("code") if isinstance(detail, dict) else None
        message = detail.get("message") if isinstance(detail, dict) else None
        retryable = bool(detail.get("retryable")) if isinstance(detail, dict) else exc.code >= 500
        raise SiteCliError(code or f"HTTP_{exc.code}", message or body or f"HTTP {exc.code}", retryable) from None
    except (error.URLError, TimeoutError, ConnectionError) as exc:
        reason = getattr(exc, "reason", exc)
        raise SiteCliError("MASTER_UNAVAILABLE", f"cannot reach platform: {reason}", True) from None


def call_raw(
    method: str,
    path: str,
    *,
    timeout: int = 90,
) -> tuple[bytes, dict[str, str]]:
    base, token = auth()
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/x-oc-site-bundle, application/json",
    }
    req = request.Request(f"{base}/internal/v3/sites{path}", method=method, headers=headers)
    opener = request.build_opener(request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=timeout) as resp:
            data = resp.read(MAX_TOTAL_BYTES + 4 * 1024 * 1024 + 1)
            if len(data) > MAX_TOTAL_BYTES + 4 * 1024 * 1024:
                raise SiteCliError("INVALID_BUNDLE", "downloaded site bundle exceeds size limit")
            resp_headers = {k.lower(): v for k, v in resp.headers.items()}
            return data, resp_headers
    except error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")[:4000]
        try:
            detail = json.loads(body).get("error", {})
        except ValueError:
            detail = {}
        code = detail.get("code") if isinstance(detail, dict) else None
        message = detail.get("message") if isinstance(detail, dict) else None
        retryable = bool(detail.get("retryable")) if isinstance(detail, dict) else exc.code >= 500
        raise SiteCliError(code or f"HTTP_{exc.code}", message or body or f"HTTP {exc.code}", retryable) from None
    except (error.URLError, TimeoutError, ConnectionError) as exc:
        reason = getattr(exc, "reason", exc)
        raise SiteCliError("MASTER_UNAVAILABLE", f"cannot reach platform: {reason}", True) from None


def unpack_bundle(gzipped: bytes) -> list[tuple[str, bytes]]:
    try:
        raw = gzip.decompress(gzipped)
    except OSError as exc:
        raise SiteCliError("INVALID_BUNDLE", f"failed to decompress site bundle: {exc}") from None
    magic_len = len(SITE_BUNDLE_MAGIC)
    if len(raw) < magic_len + 4:
        raise SiteCliError("INVALID_BUNDLE", "bundle header too short")
    magic = raw[:magic_len]
    if magic not in (SITE_BUNDLE_MAGIC, SITE_BUNDLE_MAGIC_V2):
        raise SiteCliError("INVALID_BUNDLE", "unrecognized site bundle magic")
    manifest_len = struct.unpack(">I", raw[magic_len : magic_len + 4])[0]
    if manifest_len <= 0 or manifest_len > 4 * 1024 * 1024 or magic_len + 4 + manifest_len > len(raw):
        raise SiteCliError("INVALID_BUNDLE", "invalid site bundle manifest length")
    try:
        manifest = json.loads(raw[magic_len + 4 : magic_len + 4 + manifest_len].decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise SiteCliError("INVALID_BUNDLE", f"invalid site bundle manifest JSON: {exc}") from None
    if not isinstance(manifest, list) or not manifest or len(manifest) > MAX_FILES:
        raise SiteCliError("INVALID_BUNDLE", "invalid site bundle manifest entries")

    cursor = magic_len + 4 + manifest_len
    total_bytes = 0
    files: list[tuple[str, bytes]] = []
    seen: set[str] = set()
    for entry in manifest:
        if not isinstance(entry, dict):
            raise SiteCliError("INVALID_BUNDLE", "invalid manifest entry")
        rel = entry.get("path")
        size = entry.get("size")
        sha = entry.get("sha256")
        if (
            not isinstance(rel, str)
            or not rel
            or rel.startswith("/")
            or rel.endswith("/")
            or "\\" in rel
            or not isinstance(size, int)
            or size < 0
            or size > MAX_SINGLE_FILE_BYTES
            or not isinstance(sha, str)
        ):
            raise SiteCliError("INVALID_BUNDLE", "invalid manifest entry fields")
        segs = rel.split("/")
        if any(s in ("", ".", "..") for s in segs) or rel in seen:
            raise SiteCliError("INVALID_BUNDLE", f"unsafe bundle path: {rel}")
        seen.add(rel)
        total_bytes += size
        if total_bytes > MAX_TOTAL_BYTES or cursor + size > len(raw):
            raise SiteCliError("INVALID_BUNDLE", "bundle truncated or exceeds size limit")
        content = raw[cursor : cursor + size]
        cursor += size
        if hashlib.sha256(content).hexdigest() != sha:
            raise SiteCliError("INVALID_BUNDLE", f"checksum mismatch for {rel}")
        files.append((rel, content))
    if cursor != len(raw):
        raise SiteCliError("INVALID_BUNDLE", "unexpected trailing bytes in site bundle")
    return files


def read_api_file(api_raw: str) -> tuple[bytes, Path]:
    api_path = Path(api_raw).expanduser()
    if not api_path.exists():
        raise SiteCliError("INVALID_INPUT", f"api handler path does not exist: {api_path}")
    if api_path.is_symlink():
        raise SiteCliError("INVALID_INPUT", f"api handler cannot be a symlink: {api_path}")
    if not api_path.is_file():
        raise SiteCliError("INVALID_INPUT", f"api handler must be a file: {api_path}")
    data = api_path.read_bytes()
    if len(data) > MAX_SINGLE_FILE_BYTES:
        raise SiteCliError("INVALID_BUNDLE", f"api handler exceeds 10 MiB: {api_path}")
    return data, api_path.resolve()


def collect_bundle(target_raw: str, api_raw: str | None = None) -> tuple[bytes, int, int]:
    target = Path(target_raw).expanduser()
    if not target.exists():
        raise SiteCliError("INVALID_INPUT", f"path does not exist: {target}")
    if target.is_symlink():
        raise SiteCliError("INVALID_INPUT", f"target path cannot be a symlink: {target}")

    items: list[tuple[str, bytes]] = []
    total_bytes = 0
    explicit_api_data: bytes | None = None
    explicit_api_real: Path | None = None
    if api_raw:
        explicit_api_data, explicit_api_real = read_api_file(api_raw)
    server_rel = "__oc_server/api.mjs"
    api_sources: list[tuple[str, bytes]] = []
    if explicit_api_data is not None:
        api_sources.append(("--api", explicit_api_data))

    if target.is_file():
        if explicit_api_real is not None and target.resolve() == explicit_api_real:
            raise SiteCliError("INVALID_INPUT", "api handler cannot also be the root index HTML file")
        if target.suffix.lower() not in (".html", ".htm"):
            raise SiteCliError("INVALID_INPUT", "single-file publish requires an .html/.htm file")
        data = target.read_bytes()
        if len(data) > MAX_SINGLE_FILE_BYTES:
            raise SiteCliError("INVALID_BUNDLE", f"file exceeds 10 MiB: {target}")
        items.append(("index.html", data))
        total_bytes = len(data)
    elif target.is_dir():
        root = target.resolve()
        for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
            kept_dirs = []
            for d in sorted(dirnames):
                full_d = Path(dirpath) / d
                if d in SKIP_DIRS:
                    continue
                if full_d.is_symlink():
                    print(f"[oc-site] skipped symlink directory: {full_d.relative_to(root)}", file=sys.stderr)
                    continue
                kept_dirs.append(d)
            dirnames[:] = kept_dirs

            for fn in sorted(filenames):
                full_f = Path(dirpath) / fn
                rel = full_f.relative_to(root).as_posix()
                rel_lower = rel.lower()
                if fn in SKIP_FILES:
                    continue
                if fn == ".env" or fn.startswith(".env."):
                    print(f"[oc-site] skipped secret env file: {rel}", file=sys.stderr)
                    continue
                if full_f.is_symlink():
                    print(f"[oc-site] skipped symlink file: {rel}", file=sys.stderr)
                    continue
                if not full_f.is_file():
                    continue
                if explicit_api_real is not None and full_f.resolve() == explicit_api_real:
                    continue
                if (rel_lower == "__oc_server" or rel_lower.startswith("__oc_server/")) and rel != server_rel:
                    raise SiteCliError("INVALID_BUNDLE", f"reserved server path is invalid: {rel}")
                if rel in (server_rel, "server/api.mjs", "api/index.mjs"):
                    data = full_f.read_bytes()
                    if len(data) > MAX_SINGLE_FILE_BYTES:
                        raise SiteCliError("INVALID_BUNDLE", f"api handler exceeds 10 MiB: {rel}")
                    api_sources.append((rel, data))
                    continue
                if rel_lower in (server_rel, "server/api.mjs", "api/index.mjs"):
                    raise SiteCliError(
                        "INVALID_BUNDLE",
                        f"reserved server handler path casing is ambiguous ({rel}); rename to exact {rel_lower} or a non-reserved static path",
                    )
                data = full_f.read_bytes()
                if len(data) > MAX_SINGLE_FILE_BYTES:
                    raise SiteCliError("INVALID_BUNDLE", f"file exceeds 10 MiB: {rel}")
                total_bytes += len(data)
                if total_bytes > MAX_TOTAL_BYTES:
                    raise SiteCliError("INVALID_BUNDLE", "total site size exceeds 25 MiB limit")
                items.append((rel, data))
                if len(items) > MAX_FILES:
                    raise SiteCliError("INVALID_BUNDLE", f"too many files (max {MAX_FILES})")
    else:
        raise SiteCliError("INVALID_INPUT", f"unsupported path type: {target}")

    if len(api_sources) > 1:
        labels = ", ".join(lbl for lbl, _ in api_sources)
        raise SiteCliError("INVALID_BUNDLE", f"conflicting server api handler sources: {labels}")

    server_data = api_sources[0][1] if api_sources else None
    if server_data is not None:
        total_bytes += len(server_data)
        if total_bytes > MAX_TOTAL_BYTES:
            raise SiteCliError("INVALID_BUNDLE", "total site size exceeds 25 MiB limit")
        items.append((server_rel, server_data))
        if len(items) > MAX_FILES:
            raise SiteCliError("INVALID_BUNDLE", f"too many files (max {MAX_FILES})")

    if not items:
        raise SiteCliError("INVALID_BUNDLE", "no publishable files found")
    if not any(rel == "index.html" for rel, _ in items):
        raise SiteCliError("INVALID_BUNDLE", "site root must contain index.html")

    items.sort(key=lambda pair: pair[0])
    manifest = [
        {"path": rel, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
        for rel, data in items
    ]
    manifest_bytes = json.dumps(manifest, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    raw = bytearray()
    raw.extend(SITE_BUNDLE_MAGIC_V2 if server_data is not None else SITE_BUNDLE_MAGIC)
    raw.extend(struct.pack(">I", len(manifest_bytes)))
    raw.extend(manifest_bytes)
    for _, data in items:
        raw.extend(data)
    return gzip.compress(bytes(raw), compresslevel=6), len(items), total_bytes


def read_site_state(target: Path) -> dict | None:
    if not target.is_dir():
        return None
    state_path = target / STATE_FILE_NAME
    if not state_path.is_file() or state_path.is_symlink():
        return None
    try:
        data = json.loads(state_path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def write_site_state(target_dir: Path, payload: dict) -> None:
    target_real = target_dir.resolve()
    state_path = target_real / STATE_FILE_NAME
    if state_path.is_symlink():
        raise SiteCliError("INVALID_INPUT", f"refusing to overwrite symlink state file: {state_path}")
    if state_path.exists() and not state_path.is_file():
        raise SiteCliError("INVALID_INPUT", f"state path is not a regular file: {state_path}")
    serialized = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    tmp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=str(target_real),
            prefix=".oc-site-state.",
            suffix=".tmp",
            delete=False,
        ) as fh:
            fh.write(serialized)
            tmp_path = Path(fh.name)
        os.replace(tmp_path, state_path)
    except OSError as exc:
        if tmp_path is not None:
            try:
                tmp_path.unlink(missing_ok=True)
            except OSError:
                pass
        raise SiteCliError("IO_ERROR", f"failed to write {STATE_FILE_NAME}: {exc}") from None


def cmd_publish(ns: argparse.Namespace) -> int:
    target_path = Path(ns.path).expanduser()
    gzipped, _, _ = collect_bundle(ns.path, ns.api)
    meta: dict = {}
    if ns.slug:
        meta["slug"] = ns.slug
    if ns.title:
        meta["title"] = ns.title
    if ns.visibility:
        meta["visibility"] = ns.visibility
    if ns.password is not None:
        meta["password"] = ns.password
    if ns.spa is not None:
        meta["spaMode"] = ns.spa
    existing_state = read_site_state(target_path)
    has_explicit_base = (
        ns.base_site_id is not None or ns.base_rev is not None or ns.base_sha is not None
    )
    if ns.force:
        meta["forceOverwrite"] = True
    if ns.base_site_id is not None:
        meta["expectedSiteId"] = ns.base_site_id
    if ns.base_rev is not None:
        meta["expectedBaseRevision"] = ns.base_rev
    if ns.base_sha is not None:
        meta["expectedBaseContentSha256"] = ns.base_sha
    if (
        not has_explicit_base
        and existing_state is not None
        and ns.slug
        and existing_state.get("slug") == ns.slug
    ):
        if isinstance(existing_state.get("siteId"), str) and existing_state["siteId"].strip():
            meta["expectedSiteId"] = existing_state["siteId"].strip()
        if not ns.force:
            if isinstance(existing_state.get("edgeRevision"), int) and existing_state["edgeRevision"] >= 1:
                meta["expectedBaseRevision"] = existing_state["edgeRevision"]
            if isinstance(existing_state.get("contentSha256"), str) and len(existing_state["contentSha256"]) == 64:
                meta["expectedBaseContentSha256"] = existing_state["contentSha256"]
    origin_session = (
        os.environ.get("OPENCLAUDE_SESSION_KEY") or os.environ.get("OC_SESSION_KEY") or ""
    ).strip()
    if origin_session:
        meta["originSessionId"] = origin_session[:200]
    meta_b64 = base64.urlsafe_b64encode(
        json.dumps(meta, ensure_ascii=False).encode("utf-8")
    ).decode("ascii").rstrip("=")
    res = call(
        "POST",
        "/publish",
        raw_body=gzipped,
        extra_headers={
            "Content-Type": "application/x-oc-site-bundle",
            "x-oc-site-meta": meta_b64,
        },
        timeout=90,
    )
    site_obj = res.get("site") if isinstance(res, dict) else None
    if isinstance(site_obj, dict) and target_path.is_dir():
        write_site_state(
            target_path.resolve(),
            {
                "siteId": site_obj.get("id"),
                "slug": site_obj.get("slug"),
                "edgeRevision": site_obj.get("edgeRevision"),
                "contentSha256": site_obj.get("contentSha256"),
            },
        )
    print(json.dumps({"ok": True, **res}, ensure_ascii=False))
    return 0


def cmd_list(_ns: argparse.Namespace) -> int:
    res = call("GET", "/list")
    print(json.dumps({"ok": True, **res}, ensure_ascii=False))
    return 0


def cmd_info(ns: argparse.Namespace) -> int:
    q = parse.urlencode({"slug": ns.slug})
    res = call("GET", f"/detail?{q}")
    print(json.dumps({"ok": True, **res}, ensure_ascii=False))
    return 0


def cmd_pull(ns: argparse.Namespace) -> int:
    dest = Path(ns.dir or f"./{ns.slug}").expanduser()
    if dest.exists():
        if dest.is_symlink() or not dest.is_dir():
            raise SiteCliError("INVALID_INPUT", f"target path is not a regular directory: {dest}")
        if any(dest.iterdir()) and not ns.force:
            raise SiteCliError(
                "INVALID_INPUT",
                f"target directory is not empty: {dest} (pass --force to overwrite)",
            )
    q = parse.urlencode({"slug": ns.slug})
    gzipped, resp_headers = call_raw("GET", f"/pull?{q}")
    files = unpack_bundle(gzipped)

    dest.mkdir(parents=True, exist_ok=True)
    dest_real = dest.resolve()
    has_api = False
    written = 0
    seen_outputs: set[str] = set()
    planned: list[tuple[Path, bytes]] = []
    for rel, content in files:
        rel_lower = rel.lower()
        if rel_lower in ("server/api.mjs", "api/index.mjs") or (
            rel_lower.startswith("__oc_server/") and rel != "__oc_server/api.mjs"
        ):
            raise SiteCliError("INVALID_BUNDLE", f"unexpected reserved server asset in bundle: {rel}")
        out_rel = "server/api.mjs" if rel == "__oc_server/api.mjs" else rel
        if out_rel in seen_outputs:
            raise SiteCliError("INVALID_BUNDLE", f"duplicate mapped path in bundle: {out_rel}")
        seen_outputs.add(out_rel)
        if rel == "__oc_server/api.mjs":
            has_api = True
        target = (dest_real / out_rel).resolve()
        if dest_real not in target.parents:
            raise SiteCliError("INVALID_BUNDLE", f"refusing to write outside target dir: {out_rel}")
        planned.append((target, content))

    for target, content in planned:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        written += 1

    meta: dict = {}
    meta_b64 = resp_headers.get("x-oc-site-meta", "")
    if meta_b64:
        try:
            pad = "=" * ((4 - len(meta_b64) % 4) % 4)
            meta = json.loads(base64.urlsafe_b64decode(meta_b64 + pad).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            meta = {}

    if meta.get("edgeRevision") or meta.get("contentSha256"):
        write_site_state(
            dest_real,
            {
                "siteId": meta.get("siteId"),
                "slug": meta.get("slug", ns.slug),
                "edgeRevision": meta.get("edgeRevision"),
                "contentSha256": meta.get("contentSha256"),
            },
        )

    print(
        json.dumps(
            {
                "ok": True,
                "slug": meta.get("slug", ns.slug),
                "dir": str(dest_real),
                "fileCount": written,
                "hasServerApi": has_api,
                "edgeRevision": meta.get("edgeRevision"),
                "contentSha256": meta.get("contentSha256"),
                "accessRole": meta.get("accessRole"),
            },
            ensure_ascii=False,
        )
    )
    return 0


def cmd_update(ns: argparse.Namespace) -> int:
    patch: dict = {}
    if ns.title is not None:
        patch["title"] = ns.title
    if ns.visibility is not None:
        patch["visibility"] = ns.visibility
    if ns.password is not None:
        patch["password"] = ns.password
    if ns.spa is not None:
        patch["spaMode"] = ns.spa
    if ns.clear_custom_domain:
        patch["customDomain"] = None
    elif ns.custom_domain is not None:
        patch["customDomain"] = ns.custom_domain
    if not patch:
        raise SiteCliError("INVALID_INPUT", "provide at least one field to update")
    q = parse.urlencode({"slug": ns.slug})
    res = call("PATCH", f"/item?{q}", json_body=patch)
    print(json.dumps({"ok": True, **res}, ensure_ascii=False))
    return 0


def cmd_rename(ns: argparse.Namespace) -> int:
    q = parse.urlencode({"slug": ns.slug})
    res = call("POST", f"/rename?{q}", json_body={"newSlug": ns.new_slug})
    print(json.dumps({"ok": True, **res}, ensure_ascii=False))
    return 0


def cmd_verify_domain(ns: argparse.Namespace) -> int:
    q = parse.urlencode({"slug": ns.slug})
    res = call("POST", f"/verify-domain?{q}", json_body={})
    print(json.dumps({"ok": True, **res}, ensure_ascii=False))
    return 0


def cmd_env_list(ns: argparse.Namespace) -> int:
    q = parse.urlencode({"slug": ns.slug})
    res = call("GET", f"/env/list?{q}")
    print(json.dumps({"ok": True, **res}, ensure_ascii=False))
    return 0


def cmd_env_set(ns: argparse.Namespace) -> int:
    q = parse.urlencode({"slug": ns.slug})
    res = call(
        "PUT",
        f"/env/set?{q}",
        json_body={"key": ns.key, "value": ns.value, "isSecret": bool(ns.secret)},
    )
    print(json.dumps({"ok": True, **res}, ensure_ascii=False))
    return 0


def cmd_env_unset(ns: argparse.Namespace) -> int:
    q = parse.urlencode({"slug": ns.slug, "key": ns.key})
    res = call("DELETE", f"/env/unset?{q}")
    print(json.dumps(res, ensure_ascii=False))
    return 0


def cmd_analytics(ns: argparse.Namespace) -> int:
    q = parse.urlencode({"slug": ns.slug, "days": str(ns.days)})
    res = call("GET", f"/analytics?{q}")
    print(json.dumps({"ok": True, **res}, ensure_ascii=False))
    return 0


def cmd_db_inspect(ns: argparse.Namespace) -> int:
    params: dict[str, str] = {"slug": ns.slug, "limit": str(ns.limit)}
    if ns.table:
        params["table"] = ns.table
    q = parse.urlencode(params)
    res = call("GET", f"/db/inspect?{q}")
    print(json.dumps({"ok": True, **res}, ensure_ascii=False))
    return 0


def cmd_db_sql(ns: argparse.Namespace) -> int:
    sql_params: list = []
    if ns.params_json is not None:
        try:
            loaded = json.loads(ns.params_json)
        except ValueError as exc:
            raise SiteCliError("INVALID_INPUT", f"--params-json is not valid JSON: {exc}") from None
        if not isinstance(loaded, list):
            raise SiteCliError("INVALID_INPUT", "--params-json must be a JSON array")
        sql_params = loaded
    elif ns.param:
        sql_params = list(ns.param)
    q = parse.urlencode({"slug": ns.slug})
    res = call("POST", f"/db/sql?{q}", json_body={"sql": ns.sql, "params": sql_params})
    print(json.dumps({"ok": True, **res}, ensure_ascii=False))
    return 0


def cmd_delete(ns: argparse.Namespace) -> int:
    q = parse.urlencode({"slug": ns.slug})
    res = call("DELETE", f"/item?{q}")
    print(json.dumps(res, ensure_ascii=False))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="oc-site",
        description="Publish and manage persistent fullstack websites under *.congjianai.com",
    )
    subparsers = parser.add_subparsers(dest="command")

    p_pub = subparsers.add_parser("publish", help="Publish a directory (e.g. dist/) or single HTML file")
    p_pub.add_argument("path", help="Directory containing index.html or a single .html file")
    p_pub.add_argument("--slug", help="Subdomain slug (<slug>.congjianai.com); omit to auto-generate")
    p_pub.add_argument("--title", help="Display title shown in Sites Workspace")
    p_pub.add_argument("--api", help="Optional ES/CJS .mjs file handling /api/* routes (packed securely as __oc_server/api.mjs)")
    p_pub.add_argument("--visibility", choices=("public", "password", "disabled"), help="Site visibility")
    p_pub.add_argument("--password", help="Access password when visibility=password (4-128 chars)")
    p_pub.add_argument("--base-site-id", dest="base_site_id", help="Optimistic concurrency expected siteId (update-only)")
    p_pub.add_argument("--base-rev", dest="base_rev", type=int, help="Optimistic concurrency expected base edgeRevision")
    p_pub.add_argument("--base-sha", dest="base_sha", help="Optimistic concurrency expected base contentSha256")
    p_pub.add_argument("--force", action="store_true", help="Owner-only: bypass base revision check and force overwrite remote site")
    spa_g = p_pub.add_mutually_exclusive_group()
    spa_g.add_argument("--spa", dest="spa", action="store_const", const=True, help="Enable SPA fallback to index.html")
    spa_g.add_argument("--no-spa", dest="spa", action="store_const", const=False, help="Disable SPA fallback")
    p_pub.set_defaults(spa=None)

    subparsers.add_parser("list", help="List your published sites")

    p_info = subparsers.add_parser("info", help="Show site metadata by slug")
    p_info.add_argument("slug", help="Site subdomain slug")

    p_pull = subparsers.add_parser("pull", help="Pull published site files (and server/api.mjs) into a local directory")
    p_pull.add_argument("slug", help="Site subdomain slug")
    p_pull.add_argument("dir", nargs="?", help="Destination directory (default: ./<slug>)")
    p_pull.add_argument("--force", action="store_true", help="Allow extracting into a non-empty directory")

    p_upd = subparsers.add_parser("update", help="Update site title, visibility, password, custom domain, or SPA mode")
    p_upd.add_argument("slug", help="Site subdomain slug")
    p_upd.add_argument("--title", help="New site title")
    p_upd.add_argument("--visibility", choices=("public", "password", "disabled"), help="Site visibility")
    p_upd.add_argument("--password", help="New access password (4-128 chars)")
    dom_g = p_upd.add_mutually_exclusive_group()
    dom_g.add_argument("--custom-domain", dest="custom_domain", help="Bind an external custom domain")
    dom_g.add_argument("--clear-custom-domain", dest="clear_custom_domain", action="store_true", help="Unbind custom domain")
    upd_spa = p_upd.add_mutually_exclusive_group()
    upd_spa.add_argument("--spa", dest="spa", action="store_const", const=True, help="Enable SPA fallback")
    upd_spa.add_argument("--no-spa", dest="spa", action="store_const", const=False, help="Disable SPA fallback")
    p_upd.set_defaults(spa=None)

    p_ren = subparsers.add_parser("rename", help="Rename site subdomain slug safely (preserves DB and env)")
    p_ren.add_argument("slug", help="Current site subdomain slug")
    p_ren.add_argument("new_slug", help="Target new subdomain slug")

    p_vdom = subparsers.add_parser("verify-domain", help="Verify DNS TXT ownership for the configured custom domain")
    p_vdom.add_argument("slug", help="Site subdomain slug")

    p_env_l = subparsers.add_parser("env-list", help="List site environment variables (secrets masked)")
    p_env_l.add_argument("slug", help="Site subdomain slug")

    p_env_s = subparsers.add_parser("env-set", help="Create or update a site environment variable")
    p_env_s.add_argument("slug", help="Site subdomain slug")
    p_env_s.add_argument("key", help="Environment variable name (e.g. DEEPSEEK_API_KEY)")
    p_env_s.add_argument("value", help="Environment variable value")
    p_env_s.add_argument("--secret", action="store_true", help="Store encrypted as a write-only secret")

    p_env_u = subparsers.add_parser("env-unset", help="Delete a site environment variable")
    p_env_u.add_argument("slug", help="Site subdomain slug")
    p_env_u.add_argument("key", help="Environment variable name")

    p_ana = subparsers.add_parser("analytics", help="Show site traffic analytics summary")
    p_ana.add_argument("slug", help="Site subdomain slug")
    p_ana.add_argument("--days", type=int, default=30, help="Lookback window in days (1-90)")

    p_db_i = subparsers.add_parser("db-inspect", help="Inspect built-in SQLite tables and rows")
    p_db_i.add_argument("slug", help="Site subdomain slug")
    p_db_i.add_argument("--table", help="Specific table name to inspect")
    p_db_i.add_argument("--limit", type=int, default=100, help="Max rows to return (1-200)")

    p_db_s = subparsers.add_parser("db-sql", help="Execute a SQL statement against the site built-in SQLite DB")
    p_db_s.add_argument("slug", help="Site subdomain slug")
    p_db_s.add_argument("sql", help="SQL statement (migrations/queries/seeds)")
    p_db_s.add_argument("--param", action="append", default=[], help="Positional string parameter (repeatable)")
    p_db_s.add_argument("--params-json", dest="params_json", help="JSON array of SQL parameters")

    p_del = subparsers.add_parser("delete", help="Delete a published site permanently")
    p_del.add_argument("slug", help="Site subdomain slug")

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    ns = parser.parse_args(argv)
    if not ns.command:
        parser.print_help()
        return 0
    try:
        if ns.command == "publish":
            return cmd_publish(ns)
        if ns.command == "list":
            return cmd_list(ns)
        if ns.command == "info":
            return cmd_info(ns)
        if ns.command == "pull":
            return cmd_pull(ns)
        if ns.command == "update":
            return cmd_update(ns)
        if ns.command == "rename":
            return cmd_rename(ns)
        if ns.command == "verify-domain":
            return cmd_verify_domain(ns)
        if ns.command == "env-list":
            return cmd_env_list(ns)
        if ns.command == "env-set":
            return cmd_env_set(ns)
        if ns.command == "env-unset":
            return cmd_env_unset(ns)
        if ns.command == "analytics":
            return cmd_analytics(ns)
        if ns.command == "db-inspect":
            return cmd_db_inspect(ns)
        if ns.command == "db-sql":
            return cmd_db_sql(ns)
        if ns.command == "delete":
            return cmd_delete(ns)
        parser.print_help()
        return 2
    except SiteCliError as exc:
        print(json.dumps(exc.payload, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
