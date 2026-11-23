"""Paragraph-, table-, and OMML-level DOCX diff with dual-viewer yellow highlight & garbled check."""
from __future__ import annotations

import copy
import difflib
import re
import shutil
import zipfile
from pathlib import Path
from typing import Any, Callable

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
M_NS = "http://schemas.openxmlformats.org/officeDocument/2006/math"

_DIFF_TOKEN_RE = re.compile(
    r"\d+(?:\.\d+)+|[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*|[\u4e00-\u9fff\u3400-\u4dbf]|\s+|[^\w\s]|.",
    re.DOTALL,
)
_CLAUSE_OPEN_BRACKETS = set("（([【{「『“‘")
_CLAUSE_CLOSE_BRACKETS = set("）)]】}」』”’")
_CLAUSE_ZH_DELIMS = set("。！？；，：")
_CLAUSE_ASCII_DELIMS = set(";!?")
_CLAUSE_TRAILING_QUOTES = set("”’」』\"'")
_ABBREV_BEFORE_DOT = {"fig", "eq", "al", "no", "dr", "vs", "mr", "ms", "prof", "inc", "etc", "ref", "tab", "sec"}

_PPR_AFTER_PBDR = {
    "shd",
    "tabs",
    "suppressAutoHyphens",
    "kinsoku",
    "wordWrap",
    "overflowPunct",
    "topLinePunct",
    "autoSpaceDE",
    "autoSpaceDN",
    "bidi",
    "adjustRightInd",
    "snapToGrid",
    "spacing",
    "ind",
    "contextualSpacing",
    "mirrorIndents",
    "suppressOverlap",
    "jc",
    "textDirection",
    "textAlignment",
    "textboxTightWrap",
    "outlineLvl",
    "divId",
    "cnfStyle",
    "rPr",
    "sectPr",
    "pPrChange",
}
_PPR_AFTER_SHD = _PPR_AFTER_PBDR - {"shd"}


def _tokenize_diff(text: str) -> list[str]:
    return [m.group(0) for m in _DIFF_TOKEN_RE.finditer(text)]


def _tokenize_diff_with_offsets(text: str) -> tuple[list[str], list[tuple[int, int]]]:
    tokens: list[str] = []
    offsets: list[tuple[int, int]] = []
    for m in _DIFF_TOKEN_RE.finditer(text):
        tokens.append(m.group(0))
        offsets.append((m.start(), m.end()))
    return tokens, offsets


def _is_cjk_char(ch: str) -> bool:
    return len(ch) == 1 and ("\u4e00" <= ch <= "\u9fff" or "\u3400" <= ch <= "\u4dbf")


def _is_punct_or_space(text: str) -> bool:
    return all((not _is_cjk_char(ch)) and (not ch.isalnum()) for ch in text)


def _split_clauses(text: str) -> list[tuple[int, int, str]]:
    """Split text into clause slices on top-level punctuation without breaking brackets or decimals."""
    if not text:
        return []
    n = len(text)
    clauses: list[tuple[int, int, str]] = []
    start = 0
    depth = 0
    i = 0
    while i < n:
        ch = text[i]
        if ch in _CLAUSE_OPEN_BRACKETS:
            depth += 1
            i += 1
            continue
        if ch in _CLAUSE_CLOSE_BRACKETS:
            if depth > 0:
                depth -= 1
            i += 1
            continue
        is_delim = False
        if depth == 0:
            if ch in _CLAUSE_ZH_DELIMS or ch in _CLAUSE_ASCII_DELIMS:
                is_delim = True
            elif ch == ".":
                prev_ch = text[i - 1] if i > 0 else ""
                next_ch = text[i + 1] if i + 1 < n else ""
                if (next_ch == "" or next_ch.isspace()) and not prev_ch.isdigit():
                    m_word = re.search(r"([A-Za-z]+)$", text[start:i])
                    if not (m_word and m_word.group(1).lower() in _ABBREV_BEFORE_DOT):
                        is_delim = True
        if is_delim:
            end = i + 1
            while end < n and text[end] in _CLAUSE_TRAILING_QUOTES:
                end += 1
            while end < n and text[end] == " ":
                end += 1
            clauses.append((start, end, text[start:end]))
            start = end
            i = end
            continue
        i += 1
    if start < n:
        clauses.append((start, n, text[start:n]))
    return clauses


def _shingle_set(text: str, max_chars: int = 512) -> set[str]:
    sample = text[:max_chars]
    if len(sample) < 2:
        return {sample} if sample else set()
    return {sample[i : i + 2] for i in range(len(sample) - 1)}


def _pair_similar_items(
    base_items: list[str],
    rev_items: list[str],
    *,
    min_ratio: float = 0.22,
    incompatible_fn: Callable[[int, int], bool] | None = None,
) -> list[tuple[int, int]]:
    """Monotonic similarity-maximizing pairing between base_items and rev_items with bounded work."""
    m = len(base_items)
    n = len(rev_items)
    if m == 0 or n == 0:
        return []
    if m == 1 and n == 1:
        if incompatible_fn is not None and incompatible_fn(0, 0):
            return []
        return [(0, 0)]
    total_chars = sum(min(len(s), 512) for s in base_items) + sum(min(len(s), 512) for s in rev_items)
    avg_chars = total_chars / max(m + n, 1)
    if m * n > 400 or (m * n * avg_chars) > 250_000:
        pair_count = min(m, n)
        return [
            (k, k)
            for k in range(pair_count)
            if incompatible_fn is None or not incompatible_fn(k, k)
        ]

    base_shingles = [_shingle_set(s) for s in base_items]
    rev_shingles = [_shingle_set(s) for s in rev_items]
    scores = [[0.0] * n for _ in range(m)]
    for i in range(m):
        sa = base_shingles[i]
        la = len(sa)
        for j in range(n):
            if incompatible_fn is not None and incompatible_fn(i, j):
                continue
            sb = rev_shingles[j]
            lb = len(sb)
            if la == 0 and lb == 0:
                sim = 1.0
            elif la == 0 or lb == 0:
                sim = 0.0
            else:
                denom = la + lb
                if (2 * min(la, lb)) / denom < min_ratio:
                    sim = 0.0
                else:
                    sim = (2 * len(sa & sb)) / denom
            if sim >= min_ratio:
                scores[i][j] = sim

    dp = [[0.0] * (n + 1) for _ in range(m + 1)]
    choice = [[0] * (n + 1) for _ in range(m + 1)]  # 1=skip base, 2=skip rev, 3=pair
    for i in range(m - 1, -1, -1):
        for j in range(n - 1, -1, -1):
            best = dp[i + 1][j]
            act = 1
            if dp[i][j + 1] > best:
                best = dp[i][j + 1]
                act = 2
            if scores[i][j] > 0.0:
                cand = scores[i][j] + dp[i + 1][j + 1]
                if cand > best + 1e-9:
                    best = cand
                    act = 3
            dp[i][j] = best
            choice[i][j] = act

    pairs: list[tuple[int, int]] = []
    i = 0
    j = 0
    while i < m and j < n:
        act = choice[i][j]
        if act == 3:
            pairs.append((i, j))
            i += 1
            j += 1
        elif act == 2:
            j += 1
        else:
            i += 1
    return pairs


def _promote_clause_ranges(clause_text: str, ranges: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """Rule C: Promote fragmented high-density rewrites inside a single clause to one clean block."""
    if len(ranges) <= 1:
        return ranges
    span_start = ranges[0][0]
    span_end = ranges[-1][1]
    active_text = clause_text[span_start:span_end]
    if "\t" in active_text or "\n" in active_text:
        return ranges
    active_nonspace = sum(1 for ch in active_text if not ch.isspace())
    hl_nonspace = sum(
        sum(1 for ch in clause_text[a:b] if not ch.isspace())
        for a, b in ranges
    )
    ratio = (hl_nonspace / active_nonspace) if active_nonspace > 0 else 0.0
    has_cjk = any(_is_cjk_char(ch) for ch in active_text)
    if ratio >= 0.55 or (has_cjk and len(ranges) >= 3 and ratio >= 0.40):
        prefix = clause_text[:span_start]
        if (
            has_cjk
            and prefix
            and "\t" not in prefix
            and "\n" not in prefix
            and sum(1 for ch in prefix if not ch.isspace()) <= 2
            and any(_is_cjk_char(ch) for ch in prefix)
        ):
            span_start = 0
        return [(span_start, span_end)]
    return ranges


def _token_diff_ranges(base_span: str, rev_span: str) -> list[tuple[int, int]]:
    """Token-level diff with Rule A (short-island bridge) and Rule B (CJK 2-char word completion)."""
    if not rev_span or base_span == rev_span:
        return []
    if not base_span:
        return [(0, len(rev_span))]

    base_tokens = _tokenize_diff(base_span)
    rev_tokens, offsets = _tokenize_diff_with_offsets(rev_span)
    matcher = difflib.SequenceMatcher(None, base_tokens, rev_tokens, autojunk=False)
    opcodes = matcher.get_opcodes()

    changed_rev = [False] * len(rev_tokens)
    for tag, _i1, _i2, j1, j2 in opcodes:
        if tag in {"replace", "insert"}:
            for j in range(j1, j2):
                changed_rev[j] = True

    # Rule A: Bridge tiny sandwiched equal islands (whitespace/punct or <=2 CJK chars)
    # between two edits (including delete+equal+insert like 构建 -> 建立 or 反比 -> 相反).
    for idx, (tag, _i1, _i2, j1, j2) in enumerate(opcodes):
        if tag != "equal" or j1 >= j2:
            continue
        if idx == 0 or idx == len(opcodes) - 1:
            continue
        prev_tag = opcodes[idx - 1][0]
        next_tag = opcodes[idx + 1][0]
        if prev_tag == "equal" or next_tag == "equal":
            continue
        if prev_tag == "delete" and next_tag == "delete":
            continue
        eq_text = "".join(rev_tokens[j1:j2])
        if "\t" in eq_text or "\n" in eq_text:
            continue
        eq_stripped = eq_text.strip()
        is_tiny_sep = (
            prev_tag in {"replace", "insert"}
            and next_tag in {"replace", "insert"}
            and len(eq_text) <= 3
            and (not eq_stripped or _is_punct_or_space(eq_text))
        )
        is_short_cjk_island = (
            any(_is_cjk_char(ch) for ch in eq_text)
            and len(eq_stripped) <= 2
            and len(eq_text) <= 4
        )
        if is_tiny_sep or is_short_cjk_island:
            for j in range(j1, j2):
                changed_rev[j] = True

    # Rule B: Avoid splitting 2-char Chinese words on 1-char CJK replacements
    # (e.g. 残差 -> [误差], 求得结果 -> [算得]结果, 定位 -> [定向], 延迟 -> [延时]).
    for tag, i1, i2, j1, j2 in opcodes:
        if tag != "replace" or j2 - j1 != 1 or i2 <= i1:
            continue
        if not _is_cjk_char(rev_tokens[j1]):
            continue
        if not all(_is_cjk_char(tok) for tok in base_tokens[i1:i2]):
            continue
        at_cjk_start = j1 == 0 or not _is_cjk_char(rev_tokens[j1 - 1])
        at_cjk_end = j2 == len(rev_tokens) or not _is_cjk_char(rev_tokens[j2])
        if j2 < len(rev_tokens) and not changed_rev[j2] and _is_cjk_char(rev_tokens[j2]):
            right_is_lone = (
                j2 + 1 == len(rev_tokens)
                or changed_rev[j2 + 1]
                or not _is_cjk_char(rev_tokens[j2 + 1])
            )
            if right_is_lone or at_cjk_start:
                changed_rev[j2] = True
                continue
        if j1 > 0 and not changed_rev[j1 - 1] and _is_cjk_char(rev_tokens[j1 - 1]):
            left_is_lone = (
                j1 - 1 == 0
                or changed_rev[j1 - 2]
                or not _is_cjk_char(rev_tokens[j1 - 2])
            )
            if left_is_lone or at_cjk_end:
                changed_rev[j1 - 1] = True

    ranges: list[tuple[int, int]] = []
    for idx, is_changed in enumerate(changed_rev):
        if not is_changed:
            continue
        start, end = offsets[idx]
        if ranges and start <= ranges[-1][1]:
            ranges[-1] = (ranges[-1][0], max(ranges[-1][1], end))
        else:
            ranges.append((start, end))
    return ranges


def _changed_ranges_in_clause(base_clause: str, rev_clause: str) -> list[tuple[int, int]]:
    return _promote_clause_ranges(rev_clause, _token_diff_ranges(base_clause, rev_clause))


def _changed_char_ranges(base_text: str, revised_text: str) -> list[tuple[int, int]]:
    if not revised_text:
        return []
    if not base_text:
        return [(0, len(revised_text))]
    if base_text == revised_text:
        return []

    base_clauses = _split_clauses(base_text)
    rev_clauses = _split_clauses(revised_text)
    if len(base_clauses) <= 1 and len(rev_clauses) <= 1:
        return _changed_ranges_in_clause(base_text, revised_text)

    base_clause_texts = [c[2] for c in base_clauses]
    rev_clause_texts = [c[2] for c in rev_clauses]
    matcher = difflib.SequenceMatcher(None, base_clause_texts, rev_clause_texts, autojunk=False)
    raw_ranges: list[tuple[int, int]] = []

    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            continue
        elif tag == "insert":
            for rj in range(j1, j2):
                c_start, c_end, _ = rev_clauses[rj]
                if c_start < c_end:
                    raw_ranges.append((c_start, c_end))
        elif tag == "replace":
            # Diff the contiguous joined span so clause split/merge (e.g. inserting or
            # deleting a single comma) never drops the real edit or falsely highlights
            # unchanged text, then apply Rule C per revised clause.
            joined_base = "".join(base_clause_texts[i1:i2])
            block_rev_start = rev_clauses[j1][0]
            joined_rev = "".join(rev_clause_texts[j1:j2])
            span_ranges = _token_diff_ranges(joined_base, joined_rev)
            if not span_ranges:
                continue
            for rj in range(j1, j2):
                c_start, c_end, c_text = rev_clauses[rj]
                rel_start = c_start - block_rev_start
                rel_end = c_end - block_rev_start
                cl_ranges: list[tuple[int, int]] = []
                for a, b in span_ranges:
                    if b <= rel_start or a >= rel_end:
                        continue
                    cl_ranges.append((max(a, rel_start) - rel_start, min(b, rel_end) - rel_start))
                for a, b in _promote_clause_ranges(c_text, cl_ranges):
                    raw_ranges.append((c_start + a, c_start + b))

    if not raw_ranges:
        return []
    raw_ranges.sort()
    merged: list[tuple[int, int]] = [raw_ranges[0]]
    for start, end in raw_ranges[1:]:
        prev_start, prev_end = merged[-1]
        gap = revised_text[prev_end:start]
        if start <= prev_end or (
            len(gap) <= 2 and "\t" not in gap and "\n" not in gap and _is_punct_or_space(gap)
        ):
            merged[-1] = (prev_start, max(prev_end, end))
        else:
            merged.append((start, end))
    return merged


def _set_run_yellow_highlight(run_el: Any, OxmlElement: Any, qn: Any) -> None:
    r_pr = run_el.find(qn("w:rPr"))
    if r_pr is None:
        r_pr = OxmlElement("w:rPr")
        run_el.insert(0, r_pr)
    hl = r_pr.find(qn("w:highlight"))
    if hl is None:
        hl = OxmlElement("w:highlight")
        r_pr.append(hl)
    hl.set(qn("w:val"), "yellow")


def _make_run_with_children(source_run: Any, children: list[Any], highlight: bool, OxmlElement: Any, qn: Any) -> Any:
    new_run = OxmlElement("w:r")
    src_rpr = source_run.find(qn("w:rPr"))
    if src_rpr is not None:
        new_run.append(copy.deepcopy(src_rpr))
    if highlight:
        _set_run_yellow_highlight(new_run, OxmlElement, qn)
    for child in children:
        new_run.append(child)
    return new_run


def _make_wt_node(text: str, OxmlElement: Any, qn: Any) -> Any:
    t_node = OxmlElement("w:t")
    if text[:1].isspace() or text[-1:].isspace() or "  " in text:
        t_node.set(qn("xml:space"), "preserve")
    t_node.text = text
    return t_node


def _iter_direct_editable_runs(paragraph: Any, qn: Any) -> list[Any]:
    runs: list[Any] = []
    for child in list(paragraph._p):
        if child.tag != qn("w:r"):
            continue
        if child.find(qn("w:fldChar")) is not None or child.find(qn("w:instrText")) is not None:
            continue
        runs.append(child)
    return runs


def _run_visible_text(run_el: Any, qn: Any) -> str:
    parts: list[str] = []
    w_rpr = qn("w:rPr")
    w_t = qn("w:t")
    w_tab = qn("w:tab")
    w_br = qn("w:br")
    w_cr = qn("w:cr")
    for child in list(run_el):
        if child.tag == w_rpr:
            continue
        if child.tag == w_t:
            parts.append(child.text or "")
        elif child.tag == w_tab:
            parts.append("\t")
        elif child.tag in {w_br, w_cr}:
            parts.append("\n")
    return "".join(parts)


def _paragraph_visible_text(paragraph: Any, qn: Any) -> str:
    return "".join(_run_visible_text(run_el, qn) for run_el in _iter_direct_editable_runs(paragraph, qn))


def _omml_nodes(paragraph: Any) -> list[Any]:
    return list(paragraph._p.findall(f".//{{{M_NS}}}oMath"))


def _omml_plain_text(omath_el: Any) -> str:
    m_t = f"{{{M_NS}}}t"
    return "".join((node.text or "") for node in omath_el.iter() if node.tag == m_t)


def _omml_canonical_signature(omath_el: Any, qn: Any) -> str:
    from lxml import etree

    clone = copy.deepcopy(omath_el)
    w_hl = qn("w:highlight")
    for hl in list(clone.findall(f".//{w_hl}")):
        parent = hl.getparent()
        if parent is not None:
            parent.remove(hl)
    return etree.tostring(clone, encoding="unicode")


def _paragraph_compare_key(paragraph: Any, qn: Any) -> str:
    text = _paragraph_visible_text(paragraph, qn)
    ommls = _omml_nodes(paragraph)
    if not ommls:
        return text
    sigs = "\u241f".join(_omml_canonical_signature(n, qn) for n in ommls)
    return f"{text}\u241e{sigs}"


def _paragraph_display_text(paragraph: Any, qn: Any) -> str:
    text = _paragraph_visible_text(paragraph, qn)
    omml_texts = [t for t in (_omml_plain_text(n) for n in _omml_nodes(paragraph)) if t]
    if not omml_texts:
        return text
    joined_math = " ; ".join(omml_texts)
    return f"{text} [OMML: {joined_math}]".strip() if text else f"[OMML: {joined_math}]"


def _highlight_omml_node(omath_el: Any, OxmlElement: Any, qn: Any) -> int:
    m_r = f"{{{M_NS}}}r"
    m_rpr = f"{{{M_NS}}}rPr"
    w_rpr = qn("w:rPr")
    w_hl = qn("w:highlight")
    w_val = qn("w:val")
    highlighted = 0
    for math_run in omath_el.findall(f".//{m_r}"):
        r_pr = math_run.find(w_rpr)
        if r_pr is None:
            r_pr = OxmlElement("w:rPr")
            insert_pos = 1 if (len(math_run) > 0 and math_run[0].tag == m_rpr) else 0
            math_run.insert(insert_pos, r_pr)
        hl = r_pr.find(w_hl)
        if hl is None:
            hl = OxmlElement("w:highlight")
            r_pr.append(hl)
        hl.set(w_val, "yellow")
        highlighted += 1
    return highlighted


def _insert_ppr_in_order(p_pr: Any, element: Any, after_local_names: set[str], qn: Any) -> None:
    after_tags = {qn(f"w:{name}") for name in after_local_names}
    for idx, child in enumerate(list(p_pr)):
        if child.tag in after_tags:
            p_pr.insert(idx, element)
            return
    p_pr.append(element)


_PBDR_AFTER_LEFT = {"bottom", "right", "between", "bar"}


def _mark_omml_paragraph_revision(paragraph: Any, OxmlElement: Any, qn: Any) -> None:
    """Apply soft yellow shading + amber left revision bar so OMML changes show in both Word and LibreOffice."""
    p_pr = paragraph._p.get_or_add_pPr()
    p_bdr = p_pr.find(qn("w:pBdr"))
    if p_bdr is None:
        p_bdr = OxmlElement("w:pBdr")
        _insert_ppr_in_order(p_pr, p_bdr, _PPR_AFTER_PBDR, qn)
    left = p_bdr.find(qn("w:left"))
    if left is None:
        left = OxmlElement("w:left")
        _insert_ppr_in_order(p_bdr, left, _PBDR_AFTER_LEFT, qn)
    left.set(qn("w:val"), "single")
    left.set(qn("w:sz"), "18")
    left.set(qn("w:space"), "6")
    left.set(qn("w:color"), "F59E0B")

    shd = p_pr.find(qn("w:shd"))
    if shd is None:
        shd = OxmlElement("w:shd")
        _insert_ppr_in_order(p_pr, shd, _PPR_AFTER_SHD, qn)
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), "FFF9C4")


def _diff_paragraph_omml(base_paragraph: Any | None, rev_paragraph: Any, OxmlElement: Any, qn: Any) -> tuple[int, int]:
    rev_nodes = _omml_nodes(rev_paragraph)
    if not rev_nodes:
        return (0, 0)
    base_sigs = (
        [_omml_canonical_signature(n, qn) for n in _omml_nodes(base_paragraph)] if base_paragraph is not None else []
    )
    rev_sigs = [_omml_canonical_signature(n, qn) for n in rev_nodes]
    matcher = difflib.SequenceMatcher(None, base_sigs, rev_sigs, autojunk=False)
    changed_nodes = 0
    hl_runs = 0
    for tag, _i1, _i2, j1, j2 in matcher.get_opcodes():
        if tag in {"replace", "insert"}:
            for j in range(j1, j2):
                changed_nodes += 1
                hl_runs += _highlight_omml_node(rev_nodes[j], OxmlElement, qn)
    if changed_nodes > 0:
        _mark_omml_paragraph_revision(rev_paragraph, OxmlElement, qn)
    return (changed_nodes, hl_runs)


def _highlight_paragraph_ranges(paragraph: Any, ranges: list[tuple[int, int]], OxmlElement: Any, qn: Any) -> int:
    if not ranges:
        return 0
    runs = _iter_direct_editable_runs(paragraph, qn)
    if not runs:
        return 0
    w_rpr = qn("w:rPr")
    w_t = qn("w:t")
    w_tab = qn("w:tab")
    w_br = qn("w:br")
    w_cr = qn("w:cr")
    highlighted_count = 0
    cursor = 0
    for run_el in runs:
        run_text = _run_visible_text(run_el, qn)
        run_start = cursor
        run_end = cursor + len(run_text)
        cursor = run_end
        if not run_text:
            continue
        has_overlap = any(r_end > run_start and r_start < run_end for r_start, r_end in ranges)
        if not has_overlap:
            continue

        emitted: list[tuple[bool, Any]] = []
        child_cursor = run_start
        for child in list(run_el):
            if child.tag == w_rpr:
                continue
            if child.tag == w_t:
                t_text = child.text or ""
                t_start = child_cursor
                t_end = t_start + len(t_text)
                child_cursor = t_end
                if not t_text:
                    emitted.append((False, copy.deepcopy(child)))
                    continue
                overlaps: list[tuple[int, int]] = []
                for r_start, r_end in ranges:
                    if r_end <= t_start or r_start >= t_end:
                        continue
                    overlaps.append((max(t_start, r_start) - t_start, min(t_end, r_end) - t_start))
                if not overlaps:
                    emitted.append((False, copy.deepcopy(child)))
                    continue
                local_pos = 0
                for ov_start, ov_end in overlaps:
                    if ov_start > local_pos:
                        emitted.append((False, _make_wt_node(t_text[local_pos:ov_start], OxmlElement, qn)))
                    emitted.append((True, _make_wt_node(t_text[ov_start:ov_end], OxmlElement, qn)))
                    local_pos = ov_end
                if local_pos < len(t_text):
                    emitted.append((False, _make_wt_node(t_text[local_pos:], OxmlElement, qn)))
            elif child.tag in {w_tab, w_br, w_cr}:
                child_cursor += 1
                emitted.append((False, copy.deepcopy(child)))
            else:
                emitted.append((False, copy.deepcopy(child)))

        if not emitted:
            continue

        grouped: list[tuple[bool, list[Any]]] = []
        for is_hl, node in emitted:
            if grouped and grouped[-1][0] == is_hl:
                grouped[-1][1].append(node)
            else:
                grouped.append((is_hl, [node]))

        parent = run_el.getparent()
        insert_idx = list(parent).index(run_el)
        parent.remove(run_el)
        for offset, (is_hl, nodes) in enumerate(grouped):
            new_el = _make_run_with_children(run_el, nodes, highlight=is_hl, OxmlElement=OxmlElement, qn=qn)
            parent.insert(insert_idx + offset, new_el)
            if is_hl:
                highlighted_count += 1
    return highlighted_count


def _scan_omml_and_garbled(docx_path: Path) -> dict[str, Any]:
    import xml.etree.ElementTree as ET

    w = f"{{{W_NS}}}"
    m = f"{{{M_NS}}}"
    garbled_hits: list[dict[str, str]] = []
    omml_count = 0
    yellow_highlight_count = 0
    with zipfile.ZipFile(docx_path, "r") as archive:
        bad_member = archive.testzip()
        xml_names = [n for n in archive.namelist() if n.startswith("word/") and n.endswith(".xml")]
        for name in xml_names:
            try:
                root = ET.fromstring(archive.read(name))
            except ET.ParseError:
                continue
            if name == "word/document.xml":
                omml_count = len(root.findall(f".//{m}oMath"))
                for hl in root.findall(f".//{w}highlight"):
                    if (hl.get(f"{w}val") or "").lower() == "yellow":
                        yellow_highlight_count += 1
            for node in root.iter():
                if node.tag == f"{m}t" and node.text:
                    if "¿" in node.text or "\ufffd" in node.text:
                        garbled_hits.append(
                            {
                                "part": name,
                                "scope": "omml",
                                "snippet": node.text[:120],
                            }
                        )
                elif node.tag == f"{w}t" and node.text:
                    if "\ufffd" in node.text:
                        garbled_hits.append(
                            {
                                "part": name,
                                "scope": "text",
                                "snippet": node.text[:120],
                            }
                        )
    return {
        "zip_integrity_ok": bad_member is None,
        "bad_zip_member": bad_member,
        "omml_count": omml_count,
        "yellow_highlight_runs": yellow_highlight_count,
        "garbled_count": len(garbled_hits),
        "garbled_hits": garbled_hits,
    }


def diff_docx_impl(
    base_file: Path,
    revised_file: Path,
    clean_out: Path,
    hl_out: Path,
    *,
    Document: Any,
    OxmlElement: Any,
    qn: Any,
    render_pdf_garbled_scan: Callable[[Path], dict[str, Any]],
    render_error_cls: type[Exception],
    render_check: bool | None = None,
) -> dict[str, Any]:
    if revised_file != clean_out:
        shutil.copy2(revised_file, clean_out)

    base_doc = Document(base_file)
    rev_doc = Document(revised_file)

    base_keys = [_paragraph_compare_key(p, qn) for p in base_doc.paragraphs]
    rev_keys = [_paragraph_compare_key(p, qn) for p in rev_doc.paragraphs]
    base_texts = [_paragraph_visible_text(p, qn) for p in base_doc.paragraphs]
    rev_texts = [_paragraph_visible_text(p, qn) for p in rev_doc.paragraphs]

    matcher = difflib.SequenceMatcher(None, base_keys, rev_keys, autojunk=False)
    changes: list[dict[str, Any]] = []
    unchanged = 0
    added = 0
    modified = 0
    deleted = 0
    highlighted_runs = 0
    changed_omml_nodes = 0

    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            unchanged += j2 - j1
        elif tag == "delete":
            for bi in range(i1, i2):
                deleted += 1
                changes.append(
                    {
                        "index": bi,
                        "kind": "deleted",
                        "base_text": _paragraph_display_text(base_doc.paragraphs[bi], qn),
                        "revised_text": "",
                        "omml_changed": bool(_omml_nodes(base_doc.paragraphs[bi])),
                    }
                )
        elif tag == "insert":
            for rj in range(j1, j2):
                added += 1
                text = rev_texts[rj]
                highlighted_runs += _highlight_paragraph_ranges(
                    rev_doc.paragraphs[rj], [(0, len(text))] if text else [], OxmlElement, qn
                )
                omml_changed, omml_hl = _diff_paragraph_omml(None, rev_doc.paragraphs[rj], OxmlElement, qn)
                changed_omml_nodes += omml_changed
                highlighted_runs += omml_hl
                changes.append(
                    {
                        "index": rj,
                        "kind": "added",
                        "base_text": "",
                        "revised_text": _paragraph_display_text(rev_doc.paragraphs[rj], qn),
                        "omml_changed": omml_changed > 0,
                    }
                )
        elif tag == "replace":
            sub_base_indices = list(range(i1, i2))
            sub_rev_indices = list(range(j1, j2))
            sub_base_disp = [_paragraph_display_text(base_doc.paragraphs[bi], qn) for bi in sub_base_indices]
            sub_rev_disp = [_paragraph_display_text(rev_doc.paragraphs[rj], qn) for rj in sub_rev_indices]

            def _para_incompatible(rel_i: int, rel_j: int) -> bool:
                bi = sub_base_indices[rel_i]
                rj = sub_rev_indices[rel_j]
                b_pure_omml = (not base_texts[bi].strip()) and bool(_omml_nodes(base_doc.paragraphs[bi]))
                r_pure_omml = (not rev_texts[rj].strip()) and bool(_omml_nodes(rev_doc.paragraphs[rj]))
                b_pure_text = bool(base_texts[bi].strip()) and not bool(_omml_nodes(base_doc.paragraphs[bi]))
                r_pure_text = bool(rev_texts[rj].strip()) and not bool(_omml_nodes(rev_doc.paragraphs[rj]))
                return (b_pure_omml and r_pure_text) or (b_pure_text and r_pure_omml)

            pairs = _pair_similar_items(
                sub_base_disp,
                sub_rev_disp,
                min_ratio=0.22,
                incompatible_fn=_para_incompatible,
            )
            paired_base = {rel_i for rel_i, _ in pairs}
            paired_rev = {rel_j: rel_i for rel_i, rel_j in pairs}

            for rel_i, bi in enumerate(sub_base_indices):
                if rel_i not in paired_base:
                    deleted += 1
                    changes.append(
                        {
                            "index": bi,
                            "kind": "deleted",
                            "base_text": _paragraph_display_text(base_doc.paragraphs[bi], qn),
                            "revised_text": "",
                            "omml_changed": bool(_omml_nodes(base_doc.paragraphs[bi])),
                        }
                    )

            for rel_j, rj in enumerate(sub_rev_indices):
                rev_p = rev_doc.paragraphs[rj]
                rt = rev_texts[rj]
                if rel_j in paired_rev:
                    bi = sub_base_indices[paired_rev[rel_j]]
                    base_p = base_doc.paragraphs[bi]
                    bt = base_texts[bi]
                    modified += 1
                    ranges = _changed_char_ranges(bt, rt) if bt != rt else []
                    highlighted_runs += _highlight_paragraph_ranges(rev_p, ranges, OxmlElement, qn)
                    omml_changed, omml_hl = _diff_paragraph_omml(base_p, rev_p, OxmlElement, qn)
                    changed_omml_nodes += omml_changed
                    highlighted_runs += omml_hl
                    changes.append(
                        {
                            "index": rj,
                            "kind": "modified",
                            "base_text": _paragraph_display_text(base_p, qn),
                            "revised_text": _paragraph_display_text(rev_p, qn),
                            "omml_changed": omml_changed > 0,
                        }
                    )
                else:
                    added += 1
                    highlighted_runs += _highlight_paragraph_ranges(
                        rev_p, [(0, len(rt))] if rt else [], OxmlElement, qn
                    )
                    omml_changed, omml_hl = _diff_paragraph_omml(None, rev_p, OxmlElement, qn)
                    changed_omml_nodes += omml_changed
                    highlighted_runs += omml_hl
                    changes.append(
                        {
                            "index": rj,
                            "kind": "added",
                            "base_text": "",
                            "revised_text": _paragraph_display_text(rev_p, qn),
                            "omml_changed": omml_changed > 0,
                        }
                    )

    changed_tables = 0
    for t_idx, rev_table in enumerate(rev_doc.tables):
        base_table = base_doc.tables[t_idx] if t_idx < len(base_doc.tables) else None
        table_dirty = False
        for r_idx, rev_row in enumerate(rev_table.rows):
            base_row = base_table.rows[r_idx] if base_table is not None and r_idx < len(base_table.rows) else None
            for c_idx, rev_cell in enumerate(rev_row.cells):
                base_cell = base_row.cells[c_idx] if base_row is not None and c_idx < len(base_row.cells) else None
                base_cell_ps = list(base_cell.paragraphs) if base_cell is not None else []
                for p_idx, rev_p in enumerate(rev_cell.paragraphs):
                    base_p = base_cell_ps[p_idx] if p_idx < len(base_cell_ps) else None
                    bk = _paragraph_compare_key(base_p, qn) if base_p is not None else ""
                    rk = _paragraph_compare_key(rev_p, qn)
                    if bk != rk:
                        table_dirty = True
                        bt = _paragraph_visible_text(base_p, qn) if base_p is not None else ""
                        rt = _paragraph_visible_text(rev_p, qn)
                        if bt != rt:
                            ranges = _changed_char_ranges(bt, rt)
                            highlighted_runs += _highlight_paragraph_ranges(rev_p, ranges, OxmlElement, qn)
                        omml_changed, omml_hl = _diff_paragraph_omml(base_p, rev_p, OxmlElement, qn)
                        changed_omml_nodes += omml_changed
                        highlighted_runs += omml_hl
        if table_dirty:
            changed_tables += 1

    rev_doc.save(hl_out)

    clean_scan = _scan_omml_and_garbled(clean_out)
    hl_scan = _scan_omml_and_garbled(hl_out)

    has_render_tools = bool((shutil.which("libreoffice") or shutil.which("soffice")) and shutil.which("pdftotext"))
    should_render_check = render_check is True or (
        render_check is None and (clean_scan["omml_count"] > 0 or hl_scan["omml_count"] > 0) and has_render_tools
    )
    render_check_executed = False
    render_check_ok = True
    render_check_error: str | None = None
    render_garbled_hits: list[dict[str, Any]] = []
    if should_render_check:
        try:
            for variant, target_path in (("clean", clean_out), ("highlighted", hl_out)):
                scan_res = render_pdf_garbled_scan(target_path)
                for hit in scan_res["hits"]:
                    render_garbled_hits.append({"variant": variant, **hit})
            render_check_executed = True
        except render_error_cls as err:
            render_check_ok = False
            render_check_error = str(err)

    omml_passed = (
        clean_scan["garbled_count"] == 0
        and hl_scan["garbled_count"] == 0
        and render_check_ok
        and len(render_garbled_hits) == 0
    )
    zip_ok = clean_scan["zip_integrity_ok"] and hl_scan["zip_integrity_ok"]

    omml_check: dict[str, Any] = {
        "passed": omml_passed,
        "clean_omml_count": clean_scan["omml_count"],
        "highlighted_omml_count": hl_scan["omml_count"],
        "clean_garbled_count": clean_scan["garbled_count"],
        "highlighted_garbled_count": hl_scan["garbled_count"],
        "garbled_hits": clean_scan["garbled_hits"] + hl_scan["garbled_hits"],
        "render_check_executed": render_check_executed,
        "render_garbled_count": len(render_garbled_hits),
        "render_garbled_hits": render_garbled_hits,
    }
    if render_check_error is not None:
        omml_check["render_check_error"] = render_check_error

    return {
        "base": str(base_file),
        "revised": str(revised_file),
        "out_clean": str(clean_out),
        "out_highlighted": str(hl_out),
        "summary": {
            "base_paragraphs": len(base_texts),
            "revised_paragraphs": len(rev_texts),
            "unchanged_paragraphs": unchanged,
            "added_paragraphs": added,
            "modified_paragraphs": modified,
            "deleted_paragraphs": deleted,
            "highlighted_runs": hl_scan["yellow_highlight_runs"],
            "changed_tables": changed_tables,
            "changed_omml_nodes": changed_omml_nodes,
        },
        "changes": changes,
        "omml_check": omml_check,
        "zip_integrity_ok": zip_ok,
        "passed": zip_ok and omml_passed,
    }
