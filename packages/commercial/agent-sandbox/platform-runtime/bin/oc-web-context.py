#!/usr/bin/env python3
"""OpenClaude web-context extraction helper.

JSON stdin → JSON stdout. Remote network fetching is intentionally owned by the
TypeScript MCP server; normal operations here parse local temp/user files only.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

# 单次调用版本自钉(设计 §1.2 R2-M5):resolve() 穿透 current symlink → rev-pinned bundle 根。
# 本 CLI 无 sibling 引用,SELF_ROOT 仅立"工具单文件独立、禁相对 sibling 裸调用"不变量(测试固化)。
SELF_ROOT = Path(__file__).resolve().parent.parent

ROOT = Path(os.environ.get("OPENCLAUDE_WEB_CONTEXT_ROOT", "/opt/openclaude-webctx"))
TRAF_PY = ROOT / "trafenv" / "bin" / "python"
MARK_PY = ROOT / "markenv" / "bin" / "python"
CRAWL_PY = ROOT / "crawlenv" / "bin" / "python"
DEFAULT_MAX_CHARS = 80_000
HARD_MAX_CHARS = 500_000


def bounded_int(v: Any, fallback: int, minimum: int, maximum: int) -> int:
    try:
        n = int(v)
    except Exception:
        return fallback
    if n < minimum:
        return fallback
    return min(n, maximum)


def run_py(py: Path, code: str, payload: dict[str, Any], timeout: int = 90) -> dict[str, Any]:
    if not py.exists():
        return {"ok": False, "error": f"python env missing: {py}"}
    env = {
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "HOME": os.environ.get("HOME", "/home/agent"),
        "LANG": os.environ.get("LANG", "C.UTF-8"),
        "LC_ALL": os.environ.get("LC_ALL", "C.UTF-8"),
        "TMPDIR": os.environ.get("TMPDIR", "/tmp"),
    }
    proc = subprocess.run(
        [str(py), "-c", code],
        input=json.dumps(payload),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout,
        env=env,
        check=False,
    )
    if proc.returncode != 0:
        return {"ok": False, "error": proc.stderr.strip()[:4000] or f"python exited {proc.returncode}"}
    try:
        return json.loads(proc.stdout)
    except Exception as exc:
        return {"ok": False, "error": f"invalid helper JSON: {exc}", "stdout": proc.stdout[:1000]}


def truncate(text: str, max_chars: int) -> tuple[str, bool]:
    if len(text) <= max_chars:
        return text, False
    return text[:max_chars], True


TRAF_CODE = r'''
import json, sys
payload=json.loads(sys.stdin.read())
path=payload["file_path"]
kind=payload.get("kind")
max_chars=int(payload.get("max_chars") or 80000)
if kind == "text":
    text=open(path,"rb").read().decode("utf-8", "replace")
else:
    import trafilatura
    html=open(path,"rb").read().decode("utf-8", "replace")
    text=trafilatura.extract(
        html,
        url=payload.get("source_url"),
        output_format="markdown",
        include_comments=False,
        include_tables=True,
        include_links=True,
        favor_recall=True,
    ) or ""
truncated=len(text)>max_chars
print(json.dumps({"ok": bool(text.strip()), "extractor":"trafilatura", "markdown": text[:max_chars], "chars": len(text), "truncated": truncated}, ensure_ascii=False))
'''

MARK_CODE = r'''
import json, sys
payload=json.loads(sys.stdin.read())
from markitdown import MarkItDown
md=MarkItDown()
result=md.convert(payload["file_path"])
text=result.text_content or ""
max_chars=int(payload.get("max_chars") or 80000)
truncated=len(text)>max_chars
print(json.dumps({"ok": bool(text.strip()), "extractor":"markitdown", "markdown": text[:max_chars], "chars": len(text), "truncated": truncated}, ensure_ascii=False))
'''

CRAWL_CODE = r'''
import json, sys
payload=json.loads(sys.stdin.read())
print(json.dumps({"ok": False, "extractor": "crawl4ai", "error": "browser extraction unavailable: remote rendering is not exposed until it can reuse the TypeScript SSRF guard"}))
'''

CRAWL_HTML_CODE = r'''
import json, sys
payload=json.loads(sys.stdin.read())
from crawl4ai import DefaultMarkdownGenerator
path=payload["file_path"]
html=open(path,"rb").read().decode("utf-8", "replace")
result=DefaultMarkdownGenerator().generate_markdown(html, base_url=payload.get("source_url") or "")
text=result.fit_markdown or result.raw_markdown or str(result)
max_chars=int(payload.get("max_chars") or 80000)
truncated=len(text)>max_chars
print(json.dumps({"ok": bool(text.strip()), "extractor":"crawl4ai", "markdown": text[:max_chars], "chars": len(text), "truncated": truncated}, ensure_ascii=False))
'''


def summarize_result(out: dict[str, Any]) -> dict[str, Any]:
    return {
        "ok": out.get("ok") is not False and bool(str(out.get("markdown") or "").strip()),
        "chars": out.get("chars") if isinstance(out.get("chars"), int) else len(str(out.get("markdown") or "")),
        "error": out.get("error"),
    }


def extract_html_file(payload: dict[str, Any]) -> dict[str, Any]:
    traf = run_py(TRAF_PY, TRAF_CODE, payload, timeout=90)
    crawl = run_py(CRAWL_PY, CRAWL_HTML_CODE, payload, timeout=90)
    traf_summary = summarize_result(traf)
    crawl_summary = summarize_result(crawl)

    chosen = traf if traf_summary["ok"] else crawl
    primary = "trafilatura" if traf_summary["ok"] else "crawl4ai"
    if traf_summary["ok"] and crawl_summary["ok"]:
        # Trafilatura is usually cleaner, but Crawl4AI's markdown generator is
        # a useful fallback for table/link-heavy pages where extraction became
        # too small to be useful.
        if int(traf_summary["chars"]) < 120 and int(crawl_summary["chars"]) >= int(traf_summary["chars"]) * 2:
            chosen = crawl
            primary = "crawl4ai"

    out = dict(chosen)
    out["extractor"] = "hybrid_trafilatura_crawl4ai"
    out["primary_extractor"] = primary
    out["extractor_results"] = {
        "trafilatura": traf_summary,
        "crawl4ai": crawl_summary,
    }
    return out


def health() -> dict[str, Any]:
    checks: dict[str, Any] = {}
    for name, py, pkg in [
        ("trafilatura", TRAF_PY, "trafilatura"),
        ("markitdown", MARK_PY, "markitdown"),
        ("crawl4ai", CRAWL_PY, "crawl4ai"),
    ]:
        code = f"import importlib.metadata as m, json; print(json.dumps({{'version': m.version('{pkg}')}}))"
        checks[name] = run_py(py, code, {}, timeout=10)
    return {"ok": all(v.get("ok", True) is not False for v in checks.values()), "checks": checks}


def main() -> None:
    payload = json.loads(sys.stdin.read() or "{}")
    op = payload.get("op")
    max_chars = bounded_int(payload.get("max_chars"), DEFAULT_MAX_CHARS, 1_000, HARD_MAX_CHARS)
    payload["max_chars"] = max_chars
    if op == "health_check":
        out = health()
    elif op == "extract_file":
        kind = str(payload.get("kind") or "").lower()
        suffix = Path(str(payload.get("file_path", ""))).suffix.lower().lstrip(".")
        if kind in {"html", "htm"} or suffix in {"html", "htm"}:
            out = extract_html_file(payload)
        else:
            out = run_py(TRAF_PY, TRAF_CODE, payload, timeout=90)
    elif op == "parse_document_file":
        # Text/HTML can still be routed here by direct parse_file; prefer trafilatura/raw text.
        kind = str(payload.get("kind") or "").lower()
        suffix = Path(str(payload.get("file_path", ""))).suffix.lower().lstrip(".")
        if kind in {"html", "htm"} or suffix in {"html", "htm"}:
            out = extract_html_file(payload)
        elif kind in {"text", "txt", "md", "markdown", "json", "csv", "xml"} or suffix in {"txt", "md", "markdown", "json", "csv", "xml"}:
            payload["kind"] = "text" if suffix not in {"html", "htm"} else "html"
            out = run_py(TRAF_PY, TRAF_CODE, payload, timeout=90)
        else:
            out = run_py(MARK_PY, MARK_CODE, payload, timeout=120)
    elif op == "browser_extract_url":
        out = run_py(CRAWL_PY, CRAWL_CODE, payload, timeout=120)
    else:
        out = {"ok": False, "error": f"unknown op: {op}"}
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except subprocess.TimeoutExpired:
        print(json.dumps({"ok": False, "error": "parser timed out"}, ensure_ascii=False))
        raise SystemExit(1)
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        raise SystemExit(1)
