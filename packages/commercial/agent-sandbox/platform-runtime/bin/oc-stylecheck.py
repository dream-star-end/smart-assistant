#!/usr/bin/env python3
"""OpenClaude anti-AI-style gate (`oc-stylecheck`).

Scans `.docx`, `.md`, and `.txt` manuscripts for:
  1. Em-dash / double-dash overuse (`——`, `—`, `--`) with per-1k-chars warning.
  2. High-frequency Chinese & English AI clichés with exact line numbers & snippets.
  3. Custom forbidden/banned phrases loaded via `--style-file <STYLE.md>`.

Zero external dependencies (stdlib only) so it runs reliably in every container
and CI probe environment.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from typing import Any


# 本 CLI 无 sibling 引用，SELF_ROOT 仅立“工具单文件独立、禁相对 sibling 裸调用”不变量（测试固化）。
SELF_ROOT = Path(__file__).resolve().parent.parent

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"

BUILTIN_ZH_CLICHES: tuple[str, ...] = (
    "值得注意的是",
    "综上所述",
    "总而言之",
    "不言而喻",
    "显而易见",
    "众所周知",
    "毋庸置疑",
    "毫无疑问",
    "不可否认",
    "归根结底",
    "换言之",
    "不仅如此",
    "赋能",
    "抓手",
    "生态闭环",
    "深度融合",
    "在当今",
    "具有重要意义",
    "提供了新的思路",
    "奠定了坚实基础",
    "注入了新的活力",
    "展现出巨大的潜力",
)

BUILTIN_EN_CLICHES: tuple[str, ...] = (
    "delve into",
    "delves into",
    "delving into",
    "it is worth noting",
    "it is important to note",
    "in conclusion",
    "in summary",
    "testament to",
    "tapestry of",
    "evolving landscape",
    "landscape of",
    "pivotal role",
    "crucial role",
    "paramount importance",
    "underscores the importance",
    "shed light on",
    "pave the way",
    "game-changer",
    "seamlessly",
    "multifaceted",
    "comprehensive overview",
    "realm of",
)

_DASH_RE = re.compile(r"——|—|--")
_MD_RULE_OR_TABLE_SEP_RE = re.compile(r"^\s*(?:[-*_]{3,}|\|[\s:|\-]+\|)\s*$")
_STYLE_BULLET_RE = re.compile(r"^\s*(?:[-*+]|\d+\.)\s+(.+)$")
_STYLE_KV_RE = re.compile(r"^\s*(?:禁用词|禁止|避免|forbidden|banned|avoid)\s*[:：]\s*(.+)$", re.I)


def extract_lines(input_path: Path) -> tuple[str, list[str]]:
    suffix = input_path.suffix.lower()
    if suffix == ".docx":
        w = f"{{{W_NS}}}"
        lines: list[str] = []
        with zipfile.ZipFile(input_path, "r") as archive:
            root = ET.fromstring(archive.read("word/document.xml"))
        body = root.find(f"{w}body")
        target = body if body is not None else root
        for para in target.iter(f"{w}p"):
            text = "".join(node.text or "" for node in para.iter(f"{w}t")).strip()
            if text:
                lines.append(text)
        return "docx", lines
    if suffix in {".md", ".markdown", ".txt", ""}:
        raw = input_path.read_text(encoding="utf-8", errors="replace")
        return suffix.lstrip(".") or "txt", raw.splitlines()
    raise ValueError(f"不支持的文件格式：{suffix}（仅支持 .docx/.md/.txt）")


def load_custom_terms(style_file: Path) -> list[str]:
    text = style_file.read_text(encoding="utf-8", errors="replace")
    terms: list[str] = []
    seen: set[str] = set()
    in_ban_section = False

    def add_term(raw: str) -> None:
        cleaned = raw.strip().strip("`\"'“”「」『』（）()")
        cleaned = re.sub(r"\s*[:：—-].*$", "", cleaned).strip() if "：" in cleaned or " — " in cleaned else cleaned
        if len(cleaned) < 2:
            return
        key = cleaned.lower()
        if key not in seen:
            seen.add(key)
            terms.append(cleaned)

    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("#"):
            heading = stripped.lstrip("#").strip().lower()
            in_ban_section = any(
                kw in heading for kw in ("禁用", "禁止", "避免", "套话", "黑名单", "forbidden", "banned", "avoid", "ban")
            )
            continue
        kv = _STYLE_KV_RE.match(stripped)
        if kv:
            for item in re.split(r"[,，、;；|]", kv.group(1)):
                add_term(item)
            continue
        bullet = _STYLE_BULLET_RE.match(stripped)
        if bullet:
            content = bullet.group(1).strip()
            backticks = re.findall(r"`([^`]+)`", content)
            quoted = re.findall(r"[“\"「]([^”\"」]+)[”\"」]", content)
            if backticks or quoted:
                for token in backticks + quoted:
                    add_term(token)
            elif in_ban_section:
                for item in re.split(r"[,，、;；]", content):
                    add_term(item)
            else:
                add_term(content)
            continue
        if in_ban_section and not stripped.startswith(">"):
            for item in re.split(r"[,，、;；]", stripped):
                add_term(item)
    return terms


def _find_phrase_hits(
    lines: list[str],
    phrases: list[tuple[str, str, str]],
) -> list[dict[str, Any]]:
    hits: list[dict[str, Any]] = []
    compiled: list[tuple[str, str, str, re.Pattern[str]]] = []
    for phrase, lang, source in phrases:
        if re.search(r"[A-Za-z]", phrase) and not re.search(r"[\u4e00-\u9fff]", phrase):
            pat = re.compile(rf"(?<![A-Za-z]){re.escape(phrase)}(?![A-Za-z])", re.I)
        else:
            pat = re.compile(re.escape(phrase), re.I)
        compiled.append((phrase, lang, source, pat))

    for line_no, line in enumerate(lines, start=1):
        if not line.strip():
            continue
        for phrase, lang, source, pat in compiled:
            if pat.search(line):
                hits.append(
                    {
                        "line": line_no,
                        "phrase": phrase,
                        "lang": lang,
                        "source": source,
                        "snippet": line.strip()[:160],
                    }
                )
    return hits


def run_stylecheck(
    input_path: str | Path,
    *,
    style_file: str | Path | None = None,
    max_dash_per_1k: float = 3.0,
) -> dict[str, Any]:
    target = Path(input_path).expanduser().resolve()
    if not target.is_file():
        raise FileNotFoundError(f"输入文件不存在：{target}")
    fmt, lines = extract_lines(target)
    total_chars = sum(len(re.sub(r"\s+", "", line)) for line in lines)

    dash_hits: list[dict[str, Any]] = []
    dash_count = 0
    in_code_fence = False
    for line_no, line in enumerate(lines, start=1):
        stripped = line.strip()
        if fmt != "docx" and stripped.startswith("```"):
            in_code_fence = not in_code_fence
            continue
        if in_code_fence or _MD_RULE_OR_TABLE_SEP_RE.match(line):
            continue
        found = _DASH_RE.findall(line)
        if found:
            dash_count += len(found)
            dash_hits.append({"line": line_no, "count": len(found), "snippet": stripped[:160]})

    denom_k = max(total_chars / 1000.0, 0.2)
    dash_per_1k = round(dash_count / denom_k, 2)
    dash_warning = dash_count >= 2 and dash_per_1k > max_dash_per_1k

    phrase_specs: list[tuple[str, str, str]] = [
        *((p, "zh", "builtin") for p in BUILTIN_ZH_CLICHES),
        *((p, "en", "builtin") for p in BUILTIN_EN_CLICHES),
    ]
    custom_terms: list[str] = []
    if style_file is not None:
        sf = Path(style_file).expanduser().resolve()
        if not sf.is_file():
            raise FileNotFoundError(f"风格规范文件不存在：{sf}")
        custom_terms = load_custom_terms(sf)
        for term in custom_terms:
            lang = "zh" if re.search(r"[\u4e00-\u9fff]", term) else "en"
            phrase_specs.append((term, lang, "custom"))

    cliche_hits = _find_phrase_hits(lines, phrase_specs)
    warnings: list[str] = []
    if dash_warning:
        warnings.append(
            f"破折号频次偏高：{dash_count} 次（{dash_per_1k}/千字，阈值 {max_dash_per_1k}/千字），建议改用句号/逗号或直接表述。"
        )
    if cliche_hits:
        warnings.append(f"命中 {len(cliche_hits)} 处高频 AI 套话或自定义禁用词，请按行号逐条改写。")

    penalty = len(cliche_hits) * 8 + (15 if dash_warning else 0)
    score = max(0, 100 - penalty)
    passed = not dash_warning and len(cliche_hits) == 0

    return {
        "file": str(target),
        "format": fmt,
        "total_lines": len(lines),
        "total_chars": total_chars,
        "dash_stats": {
            "count": dash_count,
            "per_1k_chars": dash_per_1k,
            "threshold_per_1k": max_dash_per_1k,
            "warning": dash_warning,
            "hits": dash_hits,
        },
        "cliche_hits": cliche_hits,
        "custom_terms_loaded": custom_terms,
        "score": score,
        "warnings": warnings,
        "passed": passed,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="oc-stylecheck",
        description="去 AI 味风格门禁：扫描 .docx/.md/.txt 中的破折号频次、中英文 AI 套话与自定义禁用词",
    )
    parser.add_argument("input", help="待检查文件（.docx / .md / .txt）")
    parser.add_argument("--style-file", help="叠加自定义禁用词的 STYLE.md 文件")
    parser.add_argument("--max-dash-per-1k", type=float, default=3.0, help="每千字破折号告警阈值，默认 3.0")
    parser.add_argument("--json", help="保存 JSON 检查报告路径")
    parser.add_argument("--strict", action="store_true", help="存在告警或命中套话时返回非零退出码 1")
    return parser


def main(argv: list[str] | None = None) -> int:
    actual = list(sys.argv[1:] if argv is None else argv)
    if actual and actual[0] == "check":
        actual = actual[1:]
    parser = build_parser()
    if not actual:
        parser.print_help(sys.stderr)
        return 2
    args = parser.parse_args(actual)
    try:
        report = run_stylecheck(
            args.input,
            style_file=args.style_file,
            max_dash_per_1k=args.max_dash_per_1k,
        )
        if args.json:
            out_path = Path(args.json).expanduser().resolve()
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
            report["report_file"] = str(out_path)
        print(json.dumps(report, ensure_ascii=False, indent=2))
        if args.strict and not report["passed"]:
            return 1
        return 0
    except (FileNotFoundError, ValueError, zipfile.BadZipFile, ET.ParseError) as exc:
        print(f"oc-stylecheck: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
