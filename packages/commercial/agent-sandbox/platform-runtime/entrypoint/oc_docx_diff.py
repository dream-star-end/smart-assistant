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

_DIFF_TOKEN_RE = re.compile(r"\d+(?:\.\d+)+|[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*|[\u4e00-\u9fff]|\s+|[^\w\s]")

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
    return _DIFF_TOKEN_RE.findall(text)


def _changed_char_ranges(base_text: str, revised_text: str) -> list[tuple[int, int]]:
    if not revised_text:
        return []
    if not base_text:
        return [(0, len(revised_text))]
    base_tokens = _tokenize_diff(base_text)
    rev_tokens = _tokenize_diff(revised_text)
    matcher = difflib.SequenceMatcher(None, base_tokens, rev_tokens, autojunk=False)
    offsets: list[tuple[int, int]] = []
    pos = 0
    for tok in rev_tokens:
        end = pos + len(tok)
        offsets.append((pos, end))
        pos = end
    ranges: list[tuple[int, int]] = []
    for tag, _i1, _i2, j1, j2 in matcher.get_opcodes():
        if tag in {"replace", "insert"} and j1 < j2:
            start = offsets[j1][0]
            end = offsets[j2 - 1][1]
            if ranges and start <= ranges[-1][1]:
                ranges[-1] = (ranges[-1][0], max(ranges[-1][1], end))
            else:
                ranges.append((start, end))
    return ranges


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
            pair_count = min(i2 - i1, j2 - j1)
            for k in range(pair_count):
                base_p = base_doc.paragraphs[i1 + k]
                rev_p = rev_doc.paragraphs[j1 + k]
                bt = base_texts[i1 + k]
                rt = rev_texts[j1 + k]
                modified += 1
                ranges = _changed_char_ranges(bt, rt) if bt != rt else []
                highlighted_runs += _highlight_paragraph_ranges(rev_p, ranges, OxmlElement, qn)
                omml_changed, omml_hl = _diff_paragraph_omml(base_p, rev_p, OxmlElement, qn)
                changed_omml_nodes += omml_changed
                highlighted_runs += omml_hl
                changes.append(
                    {
                        "index": j1 + k,
                        "kind": "modified",
                        "base_text": _paragraph_display_text(base_p, qn),
                        "revised_text": _paragraph_display_text(rev_p, qn),
                        "omml_changed": omml_changed > 0,
                    }
                )
            for rj in range(j1 + pair_count, j2):
                added += 1
                rt = rev_texts[rj]
                highlighted_runs += _highlight_paragraph_ranges(
                    rev_doc.paragraphs[rj], [(0, len(rt))] if rt else [], OxmlElement, qn
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
            for bi in range(i1 + pair_count, i2):
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
