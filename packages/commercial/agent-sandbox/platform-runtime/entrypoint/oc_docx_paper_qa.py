"""Scientific paper DOCX extraction (lossless OMML->LaTeX), static QA checks, and metrics binding.

Pure Python standard library only (zero third-party dependencies) so it works in
both lightweight CI probes and the full OpenClaude runtime container.
"""
from __future__ import annotations

import json
import math
import os
import re
import secrets
import unicodedata
import xml.etree.ElementTree as ET
import zipfile
from collections import Counter
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
M_NS = "http://schemas.openxmlformats.org/officeDocument/2006/math"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
W = f"{{{W_NS}}}"
M = f"{{{M_NS}}}"
R = f"{{{R_NS}}}"

MAX_ZIP_MEMBER_BYTES = 32 * 1024 * 1024
MAX_ZIP_TOTAL_BYTES = 64 * 1024 * 1024
_ZIP_READ_CHUNK = 65536


class DocxResourceLimitError(ValueError):
    """Raised when an untrusted DOCX exceeds bounded ZIP decompression limits."""


def _read_zip_member_bounded(
    archive: zipfile.ZipFile,
    member: str,
    *,
    max_member_bytes: int = MAX_ZIP_MEMBER_BYTES,
    budget: list[int] | None = None,
) -> bytes:
    """Stream-read a ZIP member with strict per-member and cumulative byte limits."""
    rem = budget if budget is not None else [MAX_ZIP_TOTAL_BYTES]
    info = archive.getinfo(member)
    if info.file_size > max_member_bytes:
        raise DocxResourceLimitError(
            f"DOCX member {member!r} declared size {info.file_size} exceeds limit {max_member_bytes}"
        )
    if info.file_size > rem[0]:
        raise DocxResourceLimitError(
            f"DOCX cumulative XML budget exceeded before reading {member!r}"
        )
    chunks: list[bytes] = []
    read_bytes = 0
    with archive.open(info, "r") as stream:
        while True:
            chunk = stream.read(_ZIP_READ_CHUNK)
            if not chunk:
                break
            read_bytes += len(chunk)
            rem[0] -= len(chunk)
            if read_bytes > max_member_bytes:
                raise DocxResourceLimitError(
                    f"DOCX member {member!r} decompressed size exceeds limit {max_member_bytes}"
                )
            if rem[0] < 0:
                raise DocxResourceLimitError(
                    f"DOCX cumulative decompressed size exceeds limit {MAX_ZIP_TOTAL_BYTES}"
                )
            chunks.append(chunk)
    return b"".join(chunks)


def verify_docx_zip_limits(
    path: str | Path,
    *,
    max_member_bytes: int = MAX_ZIP_MEMBER_BYTES,
    max_total_bytes: int = MAX_ZIP_TOTAL_BYTES,
) -> None:
    """Stream-verify every ZIP member's decompressed size against per-member and total caps without buffering."""
    source = Path(path).expanduser().resolve()
    total_read = 0
    with zipfile.ZipFile(source, "r") as archive:
        for info in archive.infolist():
            if info.file_size > max_member_bytes:
                raise DocxResourceLimitError(
                    f"DOCX member {info.filename!r} declared size {info.file_size} exceeds limit {max_member_bytes}"
                )
            member_read = 0
            with archive.open(info, "r") as stream:
                while True:
                    chunk = stream.read(_ZIP_READ_CHUNK)
                    if not chunk:
                        break
                    n = len(chunk)
                    member_read += n
                    total_read += n
                    if member_read > max_member_bytes:
                        raise DocxResourceLimitError(
                            f"DOCX member {info.filename!r} decompressed size exceeds limit {max_member_bytes}"
                        )
                    if total_read > max_total_bytes:
                        raise DocxResourceLimitError(
                            f"DOCX cumulative decompressed size exceeds limit {max_total_bytes}"
                        )


def docx_has_omml(
    path: str | Path,
    *,
    max_member_bytes: int = MAX_ZIP_MEMBER_BYTES,
    max_total_bytes: int = MAX_ZIP_TOTAL_BYTES,
) -> bool:
    """Bounded check whether a DOCX contains any native OMML (<m:oMath>) nodes after full-package zip-limit verification."""
    verify_docx_zip_limits(
        path, max_member_bytes=max_member_bytes, max_total_bytes=max_total_bytes
    )
    source = Path(path).expanduser().resolve()
    budget = [max_total_bytes]
    with zipfile.ZipFile(source, "r") as archive:
        names = set(archive.namelist())
        for member in ("word/document.xml", "word/footnotes.xml", "word/endnotes.xml"):
            if member not in names:
                continue
            raw = _read_zip_member_bounded(
                archive, member, max_member_bytes=max_member_bytes, budget=budget
            )
            if b"oMath" not in raw:
                continue
            try:
                root = ET.fromstring(raw)
            except ET.ParseError:
                continue
            if root.find(f".//{M}oMath") is not None:
                return True
    return False


# ---------------------------------------------------------------------------
# A. OMML -> LaTeX lossless converter
# ---------------------------------------------------------------------------

_UNICODE_TO_LATEX: dict[str, str] = {
    # Greek lowercase
    "α": r"\alpha", "β": r"\beta", "γ": r"\gamma", "δ": r"\delta",
    "ε": r"\varepsilon", "ϵ": r"\epsilon", "ζ": r"\zeta", "η": r"\eta",
    "θ": r"\theta", "ϑ": r"\vartheta", "ι": r"\iota", "κ": r"\kappa",
    "ϰ": r"\varkappa", "λ": r"\lambda", "μ": r"\mu", "ν": r"\nu",
    "ξ": r"\xi", "π": r"\pi", "ϖ": r"\varpi", "ρ": r"\rho",
    "ϱ": r"\varrho", "σ": r"\sigma", "ς": r"\varsigma", "τ": r"\tau",
    "υ": r"\upsilon", "φ": r"\varphi", "ϕ": r"\phi", "χ": r"\chi",
    "ψ": r"\psi", "ω": r"\omega",
    # Greek uppercase
    "Γ": r"\Gamma", "Δ": r"\Delta", "Θ": r"\Theta", "Λ": r"\Lambda",
    "Ξ": r"\Xi", "Π": r"\Pi", "Σ": r"\Sigma", "Υ": r"\Upsilon",
    "Φ": r"\Phi", "Ψ": r"\Psi", "Ω": r"\Omega",
    # Operators, relations, arrows, sets, conjugates, literal %
    "%": r"\%", "−": "-", "–": "-", "±": r"\pm", "∓": r"\mp",
    "×": r"\times", "÷": r"\div", "·": r"\cdot", "⋅": r"\cdot",
    "∗": "*", "⋆": r"\star", "∘": r"\circ", "∙": r"\bullet",
    "†": r"\dagger", "‡": r"\ddagger", "′": "'", "″": "''", "‴": "'''", "°": r"^\circ",
    "≤": r"\le", "≥": r"\ge", "≠": r"\ne", "≈": r"\approx",
    "≡": r"\equiv", "∼": r"\sim", "≃": r"\simeq", "≅": r"\cong",
    "∝": r"\propto", "≪": r"\ll", "≫": r"\gg", "≜": r"\triangleq", "≔": ":=",
    "∞": r"\infty", "∂": r"\partial", "∇": r"\nabla",
    "∑": r"\sum", "∏": r"\prod", "∐": r"\coprod",
    "∫": r"\int", "∬": r"\iint", "∭": r"\iiint", "∮": r"\oint",
    "⋃": r"\bigcup", "⋂": r"\bigcap",
    "∈": r"\in", "∉": r"\notin", "∋": r"\ni",
    "⊂": r"\subset", "⊆": r"\subseteq", "⊃": r"\supset", "⊇": r"\supseteq",
    "∪": r"\cup", "∩": r"\cap", "∅": r"\emptyset",
    "∀": r"\forall", "∃": r"\exists", "¬": r"\neg", "∧": r"\wedge", "∨": r"\vee",
    "→": r"\to", "←": r"\leftarrow", "↔": r"\leftrightarrow",
    "⇒": r"\Rightarrow", "⇐": r"\Leftarrow", "⇔": r"\Leftrightarrow",
    "↦": r"\mapsto", "↑": r"\uparrow", "↓": r"\downarrow",
    "⟨": r"\langle", "⟩": r"\rangle", "⌈": r"\lceil", "⌉": r"\rceil",
    "⌊": r"\lfloor", "⌋": r"\rfloor", "‖": r"\|", "⊥": r"\perp", "⊤": r"\top",
    "⊗": r"\otimes", "⊕": r"\oplus", "⊙": r"\odot",
    "…": r"\ldots", "⋯": r"\cdots", "⋮": r"\vdots", "⋱": r"\ddots",
    "ℏ": r"\hbar", "ℓ": r"\ell", "ℜ": r"\Re", "ℑ": r"\Im", "ℵ": r"\aleph",
    "ℝ": r"\mathbb{R}", "ℂ": r"\mathbb{C}", "ℕ": r"\mathbb{N}",
    "ℤ": r"\mathbb{Z}", "ℚ": r"\mathbb{Q}", "𝔼": r"\mathbb{E}", "ℙ": r"\mathbb{P}",
}

_NARY_MAP: dict[str, str] = {
    "∑": r"\sum", "∏": r"\prod", "∐": r"\coprod",
    "∫": r"\int", "∬": r"\iint", "∭": r"\iiint", "∮": r"\oint",
    "⋃": r"\bigcup", "⋂": r"\bigcap", "⋁": r"\bigvee", "⋀": r"\bigwedge",
    "⨁": r"\bigoplus", "⨂": r"\bigotimes", "⨀": r"\bigodot",
}

_ACCENT_MAP: dict[str, str] = {
    "\u0302": r"\hat", "^": r"\hat", "ˆ": r"\hat",
    "\u0304": r"\bar", "\u0305": r"\overline", "¯": r"\bar", "‾": r"\overline", "-": r"\bar",
    "\u0303": r"\tilde", "~": r"\tilde", "˜": r"\tilde",
    "\u20d7": r"\vec", "→": r"\vec", "\u2192": r"\vec",
    "\u0307": r"\dot", "˙": r"\dot", ".": r"\dot",
    "\u0308": r"\ddot", "¨": r"\ddot", "\u20db": r"\dddot",
    "\u0301": r"\acute", "´": r"\acute", "\u0300": r"\grave", "`": r"\grave",
    "\u0306": r"\breve", "˘": r"\breve", "\u030c": r"\check", "ˇ": r"\check",
}

_KNOWN_FUNCS: set[str] = {
    "sin", "cos", "tan", "cot", "sec", "csc",
    "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh", "coth",
    "exp", "log", "ln", "lg", "lim", "limsup", "liminf",
    "max", "min", "sup", "inf", "arg", "deg", "det", "dim",
    "gcd", "hom", "ker", "Pr", "Re", "Im", "mod",
}

_DELIM_MAP: dict[str, str] = {
    "": ".", "(": "(", ")": ")", "[": "[", "]": "]",
    "{": r"\{", "}": r"\}", "|": "|", "‖": r"\|", "||": r"\|",
    "⟨": r"\langle", "⟩": r"\rangle", "〈": r"\langle", "〉": r"\rangle",
    "⌈": r"\lceil", "⌉": r"\rceil", "⌊": r"\lfloor", "⌋": r"\rfloor",
}

_PR_LOCAL_SUFFIX = "Pr"


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def _m_val(el: ET.Element | None, default: str = "") -> str:
    if el is None:
        return default
    val = el.get(f"{M}val")
    return default if val is None else val


def _join_tex(parts: list[str]) -> str:
    """Concatenate TeX fragments, inserting a single space when a control word meets an ASCII letter."""
    out: list[str] = []
    for part in parts:
        if not part:
            continue
        if out:
            prev = out[-1]
            if re.search(r"\\[A-Za-z]+$", prev) and re.match(r"^[A-Za-z]", part):
                out.append(" ")
        out.append(part)
    return "".join(out)


def _convert_math_char(ch: str) -> str:
    if ch in _UNICODE_TO_LATEX:
        return _UNICODE_TO_LATEX[ch]
    cp = ord(ch)
    if 0x1D400 <= cp <= 0x1D7FF:
        norm = unicodedata.normalize("NFKC", ch)
        mapped = _UNICODE_TO_LATEX.get(norm, norm)
        if 0x1D538 <= cp <= 0x1D56B:
            return rf"\mathbb{{{mapped}}}"
        if 0x1D49C <= cp <= 0x1D4CF:
            return rf"\mathcal{{{mapped}}}"
        if 0x1D504 <= cp <= 0x1D537:
            return rf"\mathfrak{{{mapped}}}"
        return mapped
    return ch


def _convert_math_text(text: str, *, latex: bool) -> str:
    if not text:
        return ""
    if not latex:
        out: list[str] = []
        for ch in text:
            if ch == "∗":
                out.append("*")
            elif 0x1D400 <= ord(ch) <= 0x1D7FF:
                out.append(unicodedata.normalize("NFKC", ch))
            else:
                out.append(ch)
        return "".join(out)
    return _join_tex([_convert_math_char(ch) for ch in text])


def _wrap_script(expr: str) -> str:
    s = expr.strip()
    return f"{{{s}}}" if s else ""


def _convert_omml_children(el: ET.Element, *, latex: bool) -> str:
    parts: list[str] = []
    for child in el:
        if _local_name(child.tag).endswith(_PR_LOCAL_SUFFIX):
            continue
        parts.append(_convert_omml_node(child, latex=latex))
    return _join_tex(parts) if latex else "".join(parts)


def _convert_omml_run(el: ET.Element, *, latex: bool) -> str:
    raw = "".join(t.text or "" for t in el.findall(f"{M}t"))
    if not raw:
        raw = "".join(t.text or "" for t in el.findall(f"{W}t"))
    if not raw:
        return ""
    if not latex:
        return _convert_math_text(raw, latex=False)

    rpr = el.find(f"{M}rPr")
    is_nor = rpr is not None and rpr.find(f"{M}nor") is not None
    sty = _m_val(rpr.find(f"{M}sty") if rpr is not None else None)
    scr = _m_val(rpr.find(f"{M}scr") if rpr is not None else None)

    converted = _convert_math_text(raw, latex=True)
    if is_nor:
        escaped = (
            raw.replace("\\", r"\textbackslash ")
            .replace("{", r"\{")
            .replace("}", r"\}")
            .replace("%", r"\%")
        )
        return rf"\text{{{escaped}}}"
    if scr == "double-struck":
        return rf"\mathbb{{{converted}}}"
    if scr == "script":
        return rf"\mathcal{{{converted}}}"
    if scr == "fraktur":
        return rf"\mathfrak{{{converted}}}"
    if sty == "b" or scr == "bold":
        return rf"\mathbf{{{converted}}}"
    if sty == "p" and re.fullmatch(r"[A-Za-z]{2,}", raw.strip()):
        token = raw.strip()
        return f"\\{token}" if token in _KNOWN_FUNCS else rf"\mathrm{{{token}}}"
    return converted


def _convert_omml_node(el: ET.Element, *, latex: bool) -> str:
    lname = _local_name(el.tag)
    if lname.endswith(_PR_LOCAL_SUFFIX):
        return ""

    if lname == "r":
        return _convert_omml_run(el, latex=latex)

    if lname in {"oMath", "e", "num", "den", "sub", "sup", "deg", "lim", "fName", "box", "phant"}:
        return _convert_omml_children(el, latex=latex)

    if lname == "oMathPara":
        inner = [_convert_omml_node(c, latex=latex) for c in el if _local_name(c.tag) == "oMath"]
        return r" \\ ".join(x for x in inner if x) if latex else " ; ".join(x for x in inner if x)

    if lname == "f":
        fpr = el.find(f"{M}fPr")
        ftype = _m_val(fpr.find(f"{M}type") if fpr is not None else None, "bar")
        num = _convert_omml_children(el.find(f"{M}num"), latex=latex) if el.find(f"{M}num") is not None else ""
        den = _convert_omml_children(el.find(f"{M}den"), latex=latex) if el.find(f"{M}den") is not None else ""
        if not latex:
            return f"({num})/({den})"
        if ftype == "noBar":
            return rf"\binom{{{num}}}{{{den}}}"
        if ftype == "lin":
            return f"({num})/({den})"
        return rf"\frac{{{num}}}{{{den}}}"

    if lname == "sSup":
        base = _convert_omml_children(el.find(f"{M}e"), latex=latex) if el.find(f"{M}e") is not None else ""
        sup = _convert_omml_children(el.find(f"{M}sup"), latex=latex) if el.find(f"{M}sup") is not None else ""
        if not latex:
            return f"{base}^{sup}" if sup else base
        if not sup:
            return base
        b = f"{{{base}}}" if ("^" in base and not base.endswith("}")) else base
        return f"{b}^{_wrap_script(sup)}"

    if lname == "sSub":
        base = _convert_omml_children(el.find(f"{M}e"), latex=latex) if el.find(f"{M}e") is not None else ""
        sub = _convert_omml_children(el.find(f"{M}sub"), latex=latex) if el.find(f"{M}sub") is not None else ""
        if not latex:
            return f"{base}_{sub}" if sub else base
        if not sub:
            return base
        b = f"{{{base}}}" if ("_" in base and not base.endswith("}")) else base
        return f"{b}_{_wrap_script(sub)}"

    if lname == "sSubSup":
        base = _convert_omml_children(el.find(f"{M}e"), latex=latex) if el.find(f"{M}e") is not None else ""
        sub = _convert_omml_children(el.find(f"{M}sub"), latex=latex) if el.find(f"{M}sub") is not None else ""
        sup = _convert_omml_children(el.find(f"{M}sup"), latex=latex) if el.find(f"{M}sup") is not None else ""
        if not latex:
            return f"{base}_{sub}^{sup}"
        out = base
        if sub:
            out += f"_{_wrap_script(sub)}"
        if sup:
            out += f"^{_wrap_script(sup)}"
        return out

    if lname == "sPre":
        base = _convert_omml_children(el.find(f"{M}e"), latex=latex) if el.find(f"{M}e") is not None else ""
        sub = _convert_omml_children(el.find(f"{M}sub"), latex=latex) if el.find(f"{M}sub") is not None else ""
        sup = _convert_omml_children(el.find(f"{M}sup"), latex=latex) if el.find(f"{M}sup") is not None else ""
        if not latex:
            return f"_{sub}^{sup}{base}"
        prefix = "{}"
        if sub:
            prefix += f"_{_wrap_script(sub)}"
        if sup:
            prefix += f"^{_wrap_script(sup)}"
        return _join_tex([prefix, base])

    if lname == "rad":
        rad_pr = el.find(f"{M}radPr")
        deg_hide = _m_val(rad_pr.find(f"{M}degHide") if rad_pr is not None else None) in {"1", "true", "on"}
        deg_el = el.find(f"{M}deg")
        deg = "" if deg_hide or deg_el is None else _convert_omml_children(deg_el, latex=latex).strip()
        body = _convert_omml_children(el.find(f"{M}e"), latex=latex) if el.find(f"{M}e") is not None else ""
        if not latex:
            return f"sqrt[{deg}]({body})" if deg else f"sqrt({body})"
        return rf"\sqrt[{deg}]{{{body}}}" if deg else rf"\sqrt{{{body}}}"

    if lname == "nary":
        npr = el.find(f"{M}naryPr")
        op_char = _m_val(npr.find(f"{M}chr") if npr is not None else None, "∫")
        op = _NARY_MAP.get(op_char, _convert_math_text(op_char, latex=True)) if latex else op_char
        sub = _convert_omml_children(el.find(f"{M}sub"), latex=latex).strip() if el.find(f"{M}sub") is not None else ""
        sup = _convert_omml_children(el.find(f"{M}sup"), latex=latex).strip() if el.find(f"{M}sup") is not None else ""
        body = _convert_omml_children(el.find(f"{M}e"), latex=latex) if el.find(f"{M}e") is not None else ""
        if not latex:
            lim = "".join(([f"_{sub}"] if sub else []) + ([f"^{sup}"] if sup else []))
            return f"{op}{lim} {body}".strip()
        head = op
        if sub:
            head += f"_{_wrap_script(sub)}"
        if sup:
            head += f"^{_wrap_script(sup)}"
        return f"{head} {body}".strip() if body else head

    if lname == "d":
        dpr = el.find(f"{M}dPr")
        beg_el = dpr.find(f"{M}begChr") if dpr is not None else None
        end_el = dpr.find(f"{M}endChr") if dpr is not None else None
        sep_el = dpr.find(f"{M}sepChr") if dpr is not None else None
        beg_raw = "(" if beg_el is None else _m_val(beg_el, "")
        end_raw = ")" if end_el is None else _m_val(end_el, "")
        sep_raw = "|" if sep_el is None else _m_val(sep_el, "|")
        elems = [c for c in el if _local_name(c.tag) == "e"]

        if latex and len(elems) == 1:
            e_children = [c for c in elems[0] if not _local_name(c.tag).endswith(_PR_LOCAL_SUFFIX)]
            if len(e_children) == 1 and _local_name(e_children[0].tag) == "m":
                mat_body = _convert_matrix_rows(e_children[0], latex=True)
                env_map = {
                    ("(", ")"): "pmatrix", ("[", "]"): "bmatrix",
                    ("{", "}"): "Bmatrix", ("|", "|"): "vmatrix", ("‖", "‖"): "Vmatrix",
                }
                if (beg_raw, end_raw) in env_map:
                    env = env_map[(beg_raw, end_raw)]
                    return rf"\begin{{{env}}}{mat_body}\end{{{env}}}"
                if beg_raw == "{" and end_raw == "":
                    return rf"\begin{{cases}}{mat_body}\end{{cases}}"

        sep = _DELIM_MAP.get(sep_raw, sep_raw) if latex else sep_raw
        inner_items = [_convert_omml_children(e, latex=latex) for e in elems]
        inner = f" {sep} ".join(inner_items) if len(inner_items) > 1 else (inner_items[0] if inner_items else "")
        if not latex:
            return f"{beg_raw}{inner}{end_raw}"
        beg = _DELIM_MAP.get(beg_raw, _convert_math_text(beg_raw, latex=True))
        end = _DELIM_MAP.get(end_raw, _convert_math_text(end_raw, latex=True))
        if beg == "." and end == ".":
            return inner
        use_sized = (
            beg in {"|", r"\|", r"\langle", r"\lceil", r"\lfloor", r"\{", "."}
            or end in {"|", r"\|", r"\rangle", r"\rceil", r"\rfloor", r"\}", "."}
            or any(tok in inner for tok in (r"\frac", r"\sum", r"\int", r"\begin{"))
        )
        if use_sized:
            return _join_tex([rf"\left{beg}", inner, rf"\right{end}"])
        return _join_tex([beg, inner, end])

    if lname == "m":
        mat_body = _convert_matrix_rows(el, latex=latex)
        return rf"\begin{{matrix}}{mat_body}\end{{matrix}}" if latex else f"[{mat_body}]"

    if lname == "acc":
        apr = el.find(f"{M}accPr")
        acc_chr = _m_val(apr.find(f"{M}chr") if apr is not None else None, "\u0302")
        body = _convert_omml_children(el.find(f"{M}e"), latex=latex) if el.find(f"{M}e") is not None else ""
        if acc_chr in {"*", "∗"}:
            return f"{{{body}}}^{{*}}" if latex else f"{body}*"
        if acc_chr == "†":
            return rf"{{{body}}}^{{\dagger}}" if latex else f"{body}†"
        if not latex:
            return f"{body}{acc_chr}"
        cmd = _ACCENT_MAP.get(acc_chr, r"\hat")
        if cmd == r"\bar" and len(body.strip()) > 1 and not body.strip().startswith("\\"):
            cmd = r"\overline"
        return f"{cmd}{{{body}}}"

    if lname == "bar":
        bpr = el.find(f"{M}barPr")
        pos = _m_val(bpr.find(f"{M}pos") if bpr is not None else None, "top")
        body = _convert_omml_children(el.find(f"{M}e"), latex=latex) if el.find(f"{M}e") is not None else ""
        if not latex:
            return f"overline({body})" if pos != "bot" else f"underline({body})"
        return rf"\underline{{{body}}}" if pos == "bot" else rf"\overline{{{body}}}"

    if lname == "func":
        fname = _convert_omml_children(el.find(f"{M}fName"), latex=latex).strip() if el.find(f"{M}fName") is not None else ""
        arg = _convert_omml_children(el.find(f"{M}e"), latex=latex) if el.find(f"{M}e") is not None else ""
        if not latex:
            return f"{fname}({arg})" if arg else fname
        if fname in _KNOWN_FUNCS:
            head = f"\\{fname}"
        elif fname.startswith("\\"):
            head = fname
        elif re.fullmatch(r"[A-Za-z]+", fname):
            head = rf"\operatorname{{{fname}}}"
        else:
            head = fname
        return _join_tex([head, arg])

    if lname == "eqArr":
        rows = [_convert_omml_children(e, latex=latex) for e in el if _local_name(e.tag) == "e"]
        return (r"\begin{aligned}" + r" \\ ".join(rows) + r"\end{aligned}") if latex else " ; ".join(rows)

    if lname in {"limLow", "limUpp"}:
        base = _convert_omml_children(el.find(f"{M}e"), latex=latex).strip() if el.find(f"{M}e") is not None else ""
        lim = _convert_omml_children(el.find(f"{M}lim"), latex=latex).strip() if el.find(f"{M}lim") is not None else ""
        if not latex:
            return f"{base}_{{{lim}}}" if lname == "limLow" else f"{base}^{{{lim}}}"
        if lname == "limLow":
            if base in _KNOWN_FUNCS:
                return rf"\{base}_{{{lim}}}"
            if base.startswith("\\") or base in {r"\lim", r"\min", r"\max", r"\sup", r"\inf"}:
                return f"{base}_{{{lim}}}"
            return rf"\underset{{{lim}}}{{{base}}}"
        return rf"\overset{{{lim}}}{{{base}}}"

    if lname == "groupChr":
        gpr = el.find(f"{M}groupChrPr")
        chr_val = _m_val(gpr.find(f"{M}chr") if gpr is not None else None, "⏟")
        pos = _m_val(gpr.find(f"{M}pos") if gpr is not None else None, "bot")
        body = _convert_omml_children(el.find(f"{M}e"), latex=latex) if el.find(f"{M}e") is not None else ""
        if not latex:
            return body
        if chr_val == "→":
            return rf"\overrightarrow{{{body}}}"
        if chr_val == "←":
            return rf"\overleftarrow{{{body}}}"
        if chr_val == "⏞" or pos == "top":
            return rf"\overbrace{{{body}}}"
        return rf"\underbrace{{{body}}}"

    if lname == "borderBox":
        body = _convert_omml_children(el.find(f"{M}e"), latex=latex) if el.find(f"{M}e") is not None else ""
        return rf"\boxed{{{body}}}" if latex else f"[{body}]"

    return _convert_omml_children(el, latex=latex)


def _convert_matrix_rows(mat_el: ET.Element, *, latex: bool) -> str:
    rows: list[str] = []
    for mr in mat_el:
        if _local_name(mr.tag) != "mr":
            continue
        cells = [_convert_omml_children(e, latex=latex).strip() for e in mr if _local_name(e.tag) == "e"]
        rows.append(" & ".join(cells) if latex else ", ".join(cells))
    return r" \\ ".join(rows) if latex else "; ".join(rows)


def omml_to_latex(el: ET.Element, *, latex: bool = True) -> str:
    """Convert an <m:oMath> or <m:oMathPara> XML element to LaTeX (or readable text)."""
    return _convert_omml_node(el, latex=latex).strip()


# ---------------------------------------------------------------------------
# A2. High-fidelity DOCX extractor
# ---------------------------------------------------------------------------

def _load_heading_style_map(archive: zipfile.ZipFile, budget: list[int]) -> dict[str, int]:
    mapping: dict[str, int] = {}
    if "word/styles.xml" not in archive.namelist():
        return mapping
    try:
        root = ET.fromstring(_read_zip_member_bounded(archive, "word/styles.xml", budget=budget))
    except ET.ParseError:
        return mapping
    for style in root.findall(f"{W}style"):
        sid = style.get(f"{W}styleId")
        if not sid:
            continue
        name_el = style.find(f"{W}name")
        name_val = (name_el.get(f"{W}val") or "") if name_el is not None else ""
        m_head = re.match(r"^(?:heading|标题)\s*([1-6])$", name_val.strip(), re.I)
        if m_head:
            mapping[sid] = int(m_head.group(1))
            continue
        ppr = style.find(f"{W}pPr")
        if ppr is not None:
            ol = ppr.find(f"{W}outlineLvl")
            if ol is not None:
                raw = ol.get(f"{W}val")
                if raw is not None and raw.isdigit():
                    lvl = int(raw) + 1
                    if 1 <= lvl <= 6:
                        mapping[sid] = lvl
    return mapping


def _load_hyperlink_rels(archive: zipfile.ZipFile, rels_member: str, budget: list[int]) -> dict[str, str]:
    rels: dict[str, str] = {}
    if rels_member not in archive.namelist():
        return rels
    try:
        root = ET.fromstring(_read_zip_member_bounded(archive, rels_member, budget=budget))
    except ET.ParseError:
        return rels
    for rel in root.findall(f"{{{REL_NS}}}Relationship"):
        rid = rel.get("Id") or ""
        rtype = rel.get("Type") or ""
        target = rel.get("Target") or ""
        if rid and target and rtype.endswith("/hyperlink"):
            rels[rid] = target
    return rels


def _paragraph_heading_level(p_el: ET.Element, style_map: dict[str, int]) -> int | None:
    ppr = p_el.find(f"{W}pPr")
    if ppr is None:
        return None
    pstyle = ppr.find(f"{W}pStyle")
    if pstyle is not None:
        sid = (pstyle.get(f"{W}val") or "").strip()
        if sid in style_map:
            return style_map[sid]
        m = re.match(r"^(?:Heading|标题)\s*([1-6])$", sid, re.I)
        if m:
            return int(m.group(1))
    ol = ppr.find(f"{W}outlineLvl")
    if ol is not None:
        raw = ol.get(f"{W}val")
        if raw is not None and raw.isdigit():
            lvl = int(raw) + 1
            if 1 <= lvl <= 6:
                return lvl
    return None


def _extract_paragraph_content(
    p_el: ET.Element,
    *,
    latex: bool,
    rels: dict[str, str] | None = None,
) -> tuple[str, int]:
    """Extract paragraph text, hyperlinks, and inline/display OMML formulas in exact XML order."""
    tokens: list[tuple[str, str]] = []
    formula_count = 0

    def _walk(node: ET.Element, target_tokens: list[tuple[str, str]]) -> None:
        nonlocal formula_count
        tag = node.tag
        if tag in {f"{W}pPr", f"{W}rPr", f"{W}del", f"{W}instrText", f"{W}fldChar", f"{W}proofErr"}:
            return
        if tag == f"{W}hyperlink":
            rid = node.get(f"{R}id") or ""
            url = (rels or {}).get(rid, "")
            inner_tokens: list[tuple[str, str]] = []
            for child in node:
                _walk(child, inner_tokens)
            inner_text = "".join(
                f"${v}$" if (k == "inline_math" and latex) else v for k, v in inner_tokens
            ).strip()
            if url and inner_text:
                target_tokens.append(("text", f"[{inner_text}]({url})"))
            elif inner_text:
                target_tokens.append(("text", inner_text))
            elif url:
                target_tokens.append(("text", url))
            return
        if tag == f"{M}oMathPara":
            expr = omml_to_latex(node, latex=latex)
            if expr:
                formula_count += max(1, len(node.findall(f"{M}oMath")))
                target_tokens.append(("display_math", expr))
            return
        if tag == f"{M}oMath":
            expr = omml_to_latex(node, latex=latex)
            if expr:
                formula_count += 1
                target_tokens.append(("inline_math", expr))
            return
        if tag == f"{W}t":
            if node.text:
                target_tokens.append(("text", node.text))
            return
        if tag == f"{W}tab":
            target_tokens.append(("text", "\t"))
            return
        if tag in {f"{W}br", f"{W}cr"}:
            target_tokens.append(("text", "\n"))
            return
        if tag == f"{W}footnoteReference":
            fid = node.get(f"{W}id")
            if fid and fid not in {"-1", "0"}:
                target_tokens.append(("text", f"[^{fid}]"))
            return
        if tag == f"{W}endnoteReference":
            eid = node.get(f"{W}id")
            if eid and eid not in {"-1", "0"}:
                target_tokens.append(("text", f"[^e{eid}]"))
            return
        for child in node:
            _walk(child, target_tokens)

    _walk(p_el, tokens)

    non_ws_text = "".join(v for k, v in tokens if k == "text").strip()
    math_tokens = [k for k, _ in tokens if k != "text"]
    is_standalone_math = (
        len(math_tokens) == 1
        and (
            not non_ws_text
            or bool(re.fullmatch(r"[（(]\s*\d+(?:[-.]\d+)*\s*[）)]", non_ws_text))
        )
    )

    parts: list[str] = []
    for kind, val in tokens:
        if kind == "text":
            parts.append(val)
        elif kind == "display_math" or (kind == "inline_math" and is_standalone_math):
            parts.append(f"$$\n{val}\n$$" if latex else val)
        else:
            parts.append(f"${val}$" if latex else val)

    return "".join(parts).strip(), formula_count


def _extract_table_markdown(
    tbl_el: ET.Element,
    *,
    latex: bool,
    rels: dict[str, str] | None = None,
) -> tuple[str, int]:
    rows: list[list[str]] = []
    formula_count = 0
    for tr in tbl_el.findall(f"{W}tr"):
        cells: list[str] = []
        for tc in tr.findall(f"{W}tc"):
            cell_parts: list[str] = []
            for p in tc.findall(f"{W}p"):
                txt, fcnt = _extract_paragraph_content(p, latex=latex, rels=rels)
                formula_count += fcnt
                if txt:
                    cell_parts.append(txt.replace("\n", " "))
            cells.append(" ".join(cell_parts).replace("|", r"\|").strip())
        if cells:
            rows.append(cells)
    if not rows:
        return "", formula_count
    col_count = max(len(r) for r in rows)
    norm_rows = [r + [""] * (col_count - len(r)) for r in rows]
    lines = [
        "| " + " | ".join(norm_rows[0]) + " |",
        "| " + " | ".join(["---"] * col_count) + " |",
    ]
    for r in norm_rows[1:]:
        lines.append("| " + " | ".join(r) + " |")
    return "\n".join(lines), formula_count


def _extract_notes(
    archive: zipfile.ZipFile,
    member: str,
    item_tag: str,
    prefix: str,
    *,
    latex: bool,
    budget: list[int],
    rels: dict[str, str] | None = None,
) -> list[tuple[str, str, int]]:
    if member not in archive.namelist():
        return []
    try:
        root = ET.fromstring(_read_zip_member_bounded(archive, member, budget=budget))
    except ET.ParseError:
        return []
    notes: list[tuple[str, str, int]] = []
    for note in root.findall(f"{W}{item_tag}"):
        nid = note.get(f"{W}id") or ""
        ntype = (note.get(f"{W}type") or "").lower()
        if nid in {"", "-1", "0"} or ntype in {"separator", "continuationseparator"}:
            continue
        paras: list[str] = []
        fcnt = 0
        for p in note.findall(f"{W}p"):
            txt, fc = _extract_paragraph_content(p, latex=latex, rels=rels)
            fcnt += fc
            if txt:
                paras.append(txt)
        body = " ".join(paras).strip()
        if body:
            notes.append((f"{prefix}{nid}", body, fcnt))
    return notes


def _iter_body_blocks(body: ET.Element) -> Iterator[ET.Element]:
    for child in body:
        if child.tag in {f"{W}p", f"{W}tbl"}:
            yield child
        elif child.tag == f"{W}sdt":
            content = child.find(f"{W}sdtContent")
            if content is not None:
                yield from _iter_body_blocks(content)


def _select_sections(sections: list[dict[str, Any]], query: str) -> list[dict[str, Any]]:
    q = str(query).strip()
    if not q:
        raise ValueError("section 参数不能为空")
    numbered_sections = [s for s in sections if s["index"] > 0]
    if not numbered_sections:
        raise ValueError(f"文档无章节标题，无法按 section={query!r} 切片")

    def _slice_from(pos: int) -> list[dict[str, Any]]:
        target = numbered_sections[pos]
        target_lvl = target["level"]
        out = [target]
        for nxt in numbered_sections[pos + 1 :]:
            if nxt["level"] <= target_lvl:
                break
            out.append(nxt)
        return out

    idx_match = re.fullmatch(r"#?(\d+)", q)
    if idx_match:
        idx = int(idx_match.group(1))
        for pos, sec in enumerate(numbered_sections):
            if sec["index"] == idx:
                return _slice_from(pos)
        raise ValueError(f"章节序号越界：{idx}（共 {len(numbered_sections)} 节）")

    q_low = q.casefold()
    for pos, sec in enumerate(numbered_sections):
        if sec["title"].strip().casefold() == q_low:
            return _slice_from(pos)

    for pos, sec in enumerate(numbered_sections):
        t = sec["title"].strip().casefold()
        if t.startswith(q_low + " ") or t.startswith(q_low + ".") or t.startswith(q_low + "、"):
            return _slice_from(pos)

    matched_indices: set[int] = set()
    chosen: list[dict[str, Any]] = []
    for pos, sec in enumerate(numbered_sections):
        if q_low in sec["title"].casefold():
            for item in _slice_from(pos):
                if item["index"] not in matched_indices:
                    matched_indices.add(item["index"])
                    chosen.append(item)
    if chosen:
        return chosen
    raise ValueError(f"未找到匹配章节：{query}")


def extract_docx(
    path: str | Path,
    *,
    latex: bool = True,
    toc_only: bool = False,
    section: str | None = None,
    max_chars: int | None = None,
) -> dict[str, Any]:
    """Extract DOCX to structured Markdown with lossless OMML->LaTeX, hyperlinks, TOC, and section slicing."""
    source = Path(path).expanduser().resolve()
    if not source.is_file():
        raise FileNotFoundError(f"DOCX 不存在：{source}")

    budget = [MAX_ZIP_TOTAL_BYTES]
    with zipfile.ZipFile(source, "r") as archive:
        if "word/document.xml" not in archive.namelist():
            raise ValueError(f"无效 DOCX（缺少 word/document.xml）：{source}")
        doc_root = ET.fromstring(_read_zip_member_bounded(archive, "word/document.xml", budget=budget))
        style_map = _load_heading_style_map(archive, budget)
        doc_rels = _load_hyperlink_rels(archive, "word/_rels/document.xml.rels", budget)
        fn_rels = _load_hyperlink_rels(archive, "word/_rels/footnotes.xml.rels", budget)
        en_rels = _load_hyperlink_rels(archive, "word/_rels/endnotes.xml.rels", budget)
        footnotes = _extract_notes(archive, "word/footnotes.xml", "footnote", "", latex=latex, budget=budget, rels=fn_rels)
        endnotes = _extract_notes(archive, "word/endnotes.xml", "endnote", "e", latex=latex, budget=budget, rels=en_rels)

    body = doc_root.find(f"{W}body")
    if body is None:
        raise ValueError(f"无效 DOCX（缺少 w:body）：{source}")

    sections: list[dict[str, Any]] = []
    current_sec: dict[str, Any] | None = None
    sec_counter = 0
    para_counter = 0
    total_paragraphs = 0
    total_tables = 0
    total_formulas = 0

    def _ensure_frontmatter_section() -> dict[str, Any]:
        nonlocal current_sec
        if current_sec is None:
            current_sec = {
                "index": 0, "level": 0, "title": "", "anchor": "P001",
                "char_count": 0, "paragraph_count": 0, "formula_count": 0, "table_count": 0, "blocks": [],
            }
            sections.append(current_sec)
        return current_sec

    for block in _iter_body_blocks(body):
        if block.tag == f"{W}p":
            txt, fcnt = _extract_paragraph_content(block, latex=latex, rels=doc_rels)
            if not txt:
                continue
            para_counter += 1
            total_paragraphs += 1
            total_formulas += fcnt
            anchor = f"P{para_counter:03d}"
            lvl = _paragraph_heading_level(block, style_map)
            if lvl is not None:
                sec_counter += 1
                md_line = f"{'#' * lvl} {txt}"
                current_sec = {
                    "index": sec_counter, "level": lvl, "title": txt, "anchor": anchor,
                    "char_count": len(txt), "paragraph_count": 1, "formula_count": fcnt, "table_count": 0,
                    "blocks": [{"kind": "heading", "anchor": anchor, "level": lvl, "text": md_line}],
                }
                sections.append(current_sec)
            else:
                sec = _ensure_frontmatter_section()
                sec["char_count"] += len(txt)
                sec["paragraph_count"] += 1
                sec["formula_count"] += fcnt
                sec["blocks"].append({"kind": "paragraph", "anchor": anchor, "text": txt})
        elif block.tag == f"{W}tbl":
            tbl_md, fcnt = _extract_table_markdown(block, latex=latex, rels=doc_rels)
            if not tbl_md:
                continue
            total_tables += 1
            total_formulas += fcnt
            anchor = f"T{total_tables:03d}"
            sec = _ensure_frontmatter_section()
            sec["char_count"] += len(tbl_md)
            sec["table_count"] += 1
            sec["formula_count"] += fcnt
            sec["blocks"].append({"kind": "table", "anchor": anchor, "text": tbl_md})

    total_formulas += sum(fc for _, _, fc in footnotes) + sum(fc for _, _, fc in endnotes)

    toc_list = [
        {
            "index": s["index"], "level": s["level"], "title": s["title"], "anchor": s["anchor"],
            "char_count": s["char_count"], "paragraph_count": s["paragraph_count"],
            "formula_count": s["formula_count"], "table_count": s["table_count"],
        }
        for s in sections
        if s["index"] > 0
    ]

    if toc_only:
        lines = ["# Document TOC", ""]
        if not toc_list:
            lines.append("_(no headings found)_")
        else:
            for item in toc_list:
                indent = "  " * max(0, item["level"] - 1)
                lines.append(
                    f"{indent}{item['index']}. {'#' * item['level']} {item['title']} "
                    f"(anchor: {item['anchor']}, chars: {item['char_count']}, "
                    f"formulas: {item['formula_count']}, tables: {item['table_count']})"
                )
        markdown = "\n".join(lines) + "\n"
    else:
        selected = _select_sections(sections, section) if section is not None else sections
        md_blocks: list[str] = []
        for sec in selected:
            for blk in sec["blocks"]:
                md_blocks.append(f"<!-- {blk['anchor']} -->\n{blk['text']}")
        if section is None:
            all_notes = footnotes + endnotes
            if all_notes:
                md_blocks.append("\n".join(f"[^{nid}]: {body_txt}" for nid, body_txt, _ in all_notes))
        markdown = "\n\n".join(md_blocks) + ("\n" if md_blocks else "")

    full_chars = len(markdown)
    truncated = False
    if max_chars is not None and max_chars > 0 and len(markdown) > max_chars:
        markdown = markdown[:max_chars]
        truncated = True

    return {
        "file": str(source),
        "latex": latex,
        "toc_only": toc_only,
        "section": section,
        "toc": toc_list,
        "total_sections": len(toc_list),
        "total_paragraphs": total_paragraphs,
        "total_tables": total_tables,
        "total_formulas": total_formulas,
        "footnote_count": len(footnotes),
        "endnote_count": len(endnotes),
        "chars": full_chars,
        "truncated": truncated,
        "markdown": markdown,
    }


# ---------------------------------------------------------------------------
# B. Scientific Paper Static Pre-checks
# ---------------------------------------------------------------------------

_PLACEHOLDER_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("bracket-tag", re.compile(r"\[(?:需核查|待核查|待补|待补充|TODO)\]", re.I)),
    ("todo-colon", re.compile(r"(?<![A-Za-z0-9_])TODO\s*[:：]")),
    ("fixme", re.compile(r"\bFIXME\b")),
    ("mustache", re.compile(r"\{\{[^{}\n]{1,160}\}\}")),
    ("claim-tag", re.compile(r"\[\[\s*claim\s*:[^\]]*\]\]", re.I)),
]

_FIG_CAP_START_RE = re.compile(r"^(?:图|Fig\.?|Figure)\s*([A-Za-z]?\d+(?:[-.]\d+)*)(.*)$", re.I)
_TAB_CAP_START_RE = re.compile(r"^(?:表|Tab\.?|Table)\s*([A-Za-z]?\d+(?:[-.]\d+)*)(.*)$", re.I)
_CAP_BODY_VERB_ZH_RE = re.compile(
    r"^\s*(?:所示|显示|展示|给出|表明|说明|反映|绘制|描绘|可见|对比|比较|总结|列出|汇总|中|内|为|是|的|和|与|及|至|到|分别|进一步|详细|清晰)"
)
_CAP_BODY_VERB_EN_RE = re.compile(
    r"^\s+(?:shows|illustrates|presents|depicts|compares|summarizes|demonstrates|displays|plots|lists|reports|is|are|was|were|and|to|in|of)\b",
    re.I,
)
_REF_HEADING_RE = re.compile(
    r"^(?:第?\s*[0-9一二三四五六七八九十.]+\s*[章部分、.\s]*)?(?:参考文献|references|bibliography|works\s+cited)\s*$",
    re.I,
)
_CJK_END_PUNCT = set("。！？；：）》”")
_CJK_CHAR_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")

# Reject non-reference Chinese 2-char compounds containing 图/表/式 (e.g. 代表 10 个样本 / 列表 10 项)
# while preserving arbitrary valid lead verbs like 结合表 10 / 分析表 10 / 对比图 3.
_ZH_NON_REF_COMPOUNDS = {
    "代表", "列表", "图表", "表示", "表明", "表现", "表达", "表面", "表格", "表单",
    "发表", "手表", "仪表", "电表", "水表", "课表", "词表", "链表", "报表", "年表", "月表", "日表", "总表", "外表", "内表", "代表",
    "视图", "地图", "试图", "企图", "构图", "草图", "蓝图", "意图", "版图", "拼图",
    "截图", "配图", "插图", "原图", "示图", "中图", "为表",
    "模式", "格式", "形式", "方式", "样式", "款式", "中式", "西式", "欧式", "新式", "旧式", "正式", "制式",
}

_MATH_FUNC_STOPWORDS: set[str] = {
    "sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos", "arctan",
    "sinh", "cosh", "tanh", "exp", "log", "ln", "lg", "lim", "limsup", "liminf",
    "max", "min", "sup", "inf", "arg", "deg", "det", "dim", "gcd", "hom", "ker",
    "Pr", "Re", "Im", "mod", "tr", "diag", "rank", "var", "cov", "std", "err",
    "argmin", "argmax", "MSE", "RMSE", "MAE", "SNR", "BER", "SER", "RMS",
    "FFT", "DFT", "PSD", "PDF", "CDF", "dB", "Hz", "GHz", "MHz", "kHz", "km", "ms", "ns", "us",
}

_GREEK_CHARS = set("αβγδεϵζηθϑικϰλμνξπϖρϱσςτυφϕχψωΓΔΘΛΞΠΣΥΦΨΩ")


def _plain_paragraph_text(p_el: ET.Element) -> str:
    parts: list[str] = []
    for node in p_el.iter():
        if node.tag == f"{W}t" and node.text:
            parts.append(node.text)
        elif node.tag == f"{W}tab":
            parts.append("\t")
        elif node.tag in {f"{W}br", f"{W}cr"}:
            parts.append("\n")
    return "".join(parts)


def _is_caption_paragraph(text: str, regex: re.Pattern[str], style_name: str) -> str | None:
    stripped = text.strip()
    m = regex.match(stripped)
    if not m:
        return None
    cap_id, rest = m.group(1), m.group(2)
    if "caption" in style_name.lower() or "题注" in style_name:
        return cap_id
    if re.match(r"^\s*[:：.\-—]", rest):
        return cap_id
    if _CAP_BODY_VERB_ZH_RE.match(rest) or _CAP_BODY_VERB_EN_RE.match(rest):
        return None
    if len(stripped) <= 140 and (not rest or rest[0].isspace()):
        return cap_id
    return None


def _is_valid_zh_ref_left(txt: str, kw_pos: int) -> bool:
    """Reject Chinese cross-ref matches embedded inside non-reference compounds like '代表 10' or '列表 10'."""
    if kw_pos <= 0:
        return True
    prev = txt[kw_pos - 1]
    if not _CJK_CHAR_RE.match(prev):
        return True
    pair = txt[kw_pos - 1 : kw_pos + 1]
    return pair not in _ZH_NON_REF_COMPOUNDS


def _extract_doc_style_names(source_docx: Path, budget: list[int]) -> dict[str, str]:
    names: dict[str, str] = {}
    try:
        with zipfile.ZipFile(source_docx, "r") as archive:
            if "word/styles.xml" not in archive.namelist():
                return names
            root = ET.fromstring(_read_zip_member_bounded(archive, "word/styles.xml", budget=budget))
            for st in root.findall(f"{W}style"):
                sid = st.get(f"{W}styleId")
                n_el = st.find(f"{W}name")
                if sid and n_el is not None:
                    names[sid] = n_el.get(f"{W}val") or sid
    except DocxResourceLimitError:
        raise
    except Exception:
        pass
    return names


def _check_placeholders(
    source_docx: Path,
    document_xml_root: ET.Element,
    budget: list[int],
) -> list[dict[str, Any]]:
    hits: list[dict[str, Any]] = []
    sources: list[tuple[str, ET.Element]] = [("word/document.xml", document_xml_root)]
    try:
        with zipfile.ZipFile(source_docx, "r") as archive:
            for extra in ("word/footnotes.xml", "word/endnotes.xml"):
                if extra in archive.namelist():
                    try:
                        raw = _read_zip_member_bounded(archive, extra, budget=budget)
                        sources.append((extra, ET.fromstring(raw)))
                    except ET.ParseError:
                        pass
    except DocxResourceLimitError:
        raise
    except Exception:
        pass

    for part_name, root in sources:
        for p_idx, p_el in enumerate(root.iter(f"{W}p"), start=1):
            text = _plain_paragraph_text(p_el)
            if not text.strip():
                continue
            for kind, pat in _PLACEHOLDER_PATTERNS:
                for m in pat.finditer(text):
                    ctx = re.sub(r"\s+", " ", text[max(0, m.start() - 25) : min(len(text), m.end() + 25)]).strip()
                    hits.append(
                        {
                            "code": "unresolved-placeholder",
                            "kind": kind,
                            "token": m.group(0),
                            "location": f"{part_name}#P{p_idx}",
                            "context": ctx,
                            "message": f"unresolved placeholder {m.group(0)!r} at {part_name}#P{p_idx}: {ctx}",
                        }
                    )
    return hits


def _expand_citation_group(group: str) -> list[str]:
    ids: list[str] = []
    for part in re.split(r"[,，;；]+", group.strip()):
        tok = part.strip()
        if not tok:
            continue
        m_range = re.fullmatch(r"(\d+)\s*[-–—~]\s*(\d+)", tok)
        if m_range:
            a, b = int(m_range.group(1)), int(m_range.group(2))
            if 1 <= a <= b <= 999 and (b - a) <= 50:
                ids.extend(str(x) for x in range(a, b + 1))
        elif re.fullmatch(r"\d+", tok):
            val = int(tok)
            if 1 <= val <= 999:
                ids.append(str(val))
    return ids


def _check_cross_refs(
    source_docx: Path,
    document_xml_root: ET.Element,
    budget: list[int],
) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
    style_names = _extract_doc_style_names(source_docx, budget)
    heading_map: dict[str, int] = {}
    try:
        with zipfile.ZipFile(source_docx, "r") as archive:
            heading_map = _load_heading_style_map(archive, budget)
    except DocxResourceLimitError:
        raise
    except Exception:
        pass

    fig_defined: list[str] = []
    tab_defined: list[str] = []
    eq_defined: list[str] = []
    ref_defined: list[str] = []
    body_texts: list[tuple[int, str]] = []
    in_references = False
    ref_heading_level = 1
    auto_ref_counter = 0

    body = document_xml_root.find(f"{W}body")
    if body is None:
        return {}, [], []

    p_counter = 0
    for block in _iter_body_blocks(body):
        if block.tag == f"{W}p":
            p_counter += 1
            text = _plain_paragraph_text(block).strip()
            ppr = block.find(f"{W}pPr")
            pstyle_el = ppr.find(f"{W}pStyle") if ppr is not None else None
            sid = (pstyle_el.get(f"{W}val") or "") if pstyle_el is not None else ""
            sname = style_names.get(sid, sid)
            hlvl = _paragraph_heading_level(block, heading_map)

            if hlvl is not None or _REF_HEADING_RE.match(text):
                if _REF_HEADING_RE.match(text):
                    in_references = True
                    ref_heading_level = hlvl or 1
                    continue
                if in_references and hlvl is not None and hlvl <= ref_heading_level:
                    in_references = False

            if in_references:
                if not text:
                    continue
                m_ref = re.match(r"^\[(\d+)\]", text)
                if m_ref:
                    ref_defined.append(m_ref.group(1))
                elif ppr is not None and ppr.find(f"{W}numPr") is not None:
                    auto_ref_counter += 1
                    ref_defined.append(str(auto_ref_counter))
                continue

            if block.find(f".//{M}oMath") is not None and text:
                m_eq = re.search(r"(?:式\s*)?[（(]\s*(\d+(?:[-.]\d+)*)\s*[）)]\s*$", text)
                if m_eq:
                    eq_num = m_eq.group(1)
                    if not (eq_num.isdigit() and 1900 <= int(eq_num) <= 2099):
                        eq_defined.append(eq_num)

            fig_cap = _is_caption_paragraph(text, _FIG_CAP_START_RE, sname)
            if fig_cap is not None:
                fig_defined.append(fig_cap)
                continue
            tab_cap = _is_caption_paragraph(text, _TAB_CAP_START_RE, sname)
            if tab_cap is not None:
                tab_defined.append(tab_cap)
                continue

            if text:
                body_texts.append((p_counter, text))

        elif block.tag == f"{W}tbl":
            for tr in block.findall(f"{W}tr"):
                tcs = tr.findall(f"{W}tc")
                if any(tc.find(f".//{M}oMath") is not None for tc in tcs):
                    tail_txt = _plain_paragraph_text(tcs[-1]).strip() if tcs else ""
                    m_eq = re.fullmatch(r"(?:式\s*)?[（(]\s*(\d+(?:[-.]\d+)*)\s*[）)]", tail_txt)
                    if m_eq and not (m_eq.group(1).isdigit() and 1900 <= int(m_eq.group(1)) <= 2099):
                        eq_defined.append(m_eq.group(1))
                for tc in tcs:
                    for p in tc.findall(f"{W}p"):
                        p_counter += 1
                        txt = _plain_paragraph_text(p).strip()
                        if txt:
                            body_texts.append((p_counter, txt))

    fig_refs: list[tuple[str, str]] = []
    tab_refs: list[tuple[str, str]] = []
    eq_refs: list[tuple[str, str]] = []
    cit_refs: list[tuple[str, str]] = []

    fig_ref_re = re.compile(r"(图|\b(?:Figs?\.?|Figures?))\s*([A-Za-z]?\d+(?:[-.]\d+)*)", re.I)
    tab_ref_re = re.compile(r"(表|\b(?:Tabs?\.?|Tables?))\s*([A-Za-z]?\d+(?:[-.]\d+)*)", re.I)
    eq_ref_re = re.compile(
        r"(?:(公式|方程|式)\s*[（(]\s*(\d+(?:[-.]\d+)*)\s*[）)]|\b(?:Eqs?\.?|Equations?)\s*[（(]?\s*(\d+(?:[-.]\d+)*)\s*[）)]?)",
        re.I,
    )
    cit_ref_re = re.compile(r"\[(\d+(?:\s*[-–—~]\s*\d+)?(?:\s*[,，;；]\s*\d+(?:\s*[-–—~]\s*\d+)?)*)\]")

    for p_idx, txt in body_texts:
        for m in fig_ref_re.finditer(txt):
            if m.group(1) == "图" and not _is_valid_zh_ref_left(txt, m.start(1)):
                continue
            fig_refs.append((m.group(2), f"P{p_idx}: {txt[max(0, m.start()-15):min(len(txt), m.end()+15)]}"))
        for m in tab_ref_re.finditer(txt):
            if m.group(1) == "表" and not _is_valid_zh_ref_left(txt, m.start(1)):
                continue
            tab_refs.append((m.group(2), f"P{p_idx}: {txt[max(0, m.start()-15):min(len(txt), m.end()+15)]}"))
        for m in eq_ref_re.finditer(txt):
            if m.group(1) == "式" and m.start(1) > 0 and txt[m.start(1) - 1 : m.start(1) + 1] in _ZH_NON_REF_COMPOUNDS:
                continue
            num = m.group(2) or m.group(3)
            if num and not (num.isdigit() and 1900 <= int(num) <= 2099):
                eq_refs.append((num, f"P{p_idx}: {txt[max(0, m.start()-15):min(len(txt), m.end()+15)]}"))
        for m in cit_ref_re.finditer(txt):
            for cid in _expand_citation_group(m.group(1)):
                cit_refs.append((cid, f"P{p_idx}: {txt[max(0, m.start()-15):min(len(txt), m.end()+15)]}"))

    failures: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []

    def _evaluate_category(
        name: str,
        defined: list[str],
        refs: list[tuple[str, str]],
        *,
        check_uncited: bool,
    ) -> dict[str, Any]:
        counts = Counter(defined)
        duplicates = sorted(k for k, v in counts.items() if v > 1)
        defined_set = set(defined)
        ref_ids = [r[0] for r in refs]
        ref_set = set(ref_ids)
        missing: list[str] = []

        for dup in duplicates:
            warnings.append(
                {
                    "code": "duplicate-caption-number",
                    "category": name,
                    "id": dup,
                    "message": f"duplicate {name} number: {dup} (appears {counts[dup]} times)",
                }
            )

        if defined_set:
            seen_missing: set[str] = set()
            for rid, ctx in refs:
                if rid not in defined_set and rid not in seen_missing:
                    seen_missing.add(rid)
                    missing.append(rid)
                    failures.append(
                        {
                            "code": "broken-cross-ref",
                            "category": name,
                            "id": rid,
                            "context": ctx,
                            "message": f"broken {name} cross-reference '{rid}' (defined: {sorted(defined_set)}) in {ctx}",
                        }
                    )

        # O(K log K) adjacent-difference bounded range gap detection (never allocates range(1, max))
        gaps: list[str] = []
        if defined and all(x.isdigit() for x in defined):
            ints = sorted({int(x) for x in defined})
            if ints and (ints[0] > 1 or len(ints) >= 2):
                prev = 0
                for val in ints:
                    if val > prev + 1:
                        lo, hi = prev + 1, val - 1
                        gaps.append(str(lo) if lo == hi else f"{lo}-{hi}")
                        if len(gaps) >= 20:
                            break
                    prev = val
                if gaps:
                    warnings.append(
                        {
                            "code": "caption-number-gap",
                            "category": name,
                            "missing_numbers": gaps,
                            "message": f"{name} numbering has gaps: missing {gaps}",
                        }
                    )

        uncited: list[str] = []
        if check_uncited and defined_set:
            uncited = [d for d in dict.fromkeys(defined) if d not in ref_set]
            for uid in uncited:
                warnings.append(
                    {
                        "code": "uncited-caption",
                        "category": name,
                        "id": uid,
                        "message": f"{name} '{uid}' is defined but never referenced in body text",
                    }
                )

        return {
            "defined": defined,
            "referenced": list(dict.fromkeys(ref_ids)),
            "missing": missing,
            "duplicates": duplicates,
            "gaps": gaps,
            "uncited": uncited,
        }

    summary = {
        "figures": _evaluate_category("figure", fig_defined, fig_refs, check_uncited=True),
        "tables": _evaluate_category("table", tab_defined, tab_refs, check_uncited=True),
        "equations": _evaluate_category("equation", eq_defined, eq_refs, check_uncited=False),
        "references": _evaluate_category("reference", ref_defined, cit_refs, check_uncited=False),
    }
    return summary, failures, warnings


def _extract_symbol_table(document_xml_root: ET.Element) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    symbol_counts: Counter[str] = Counter()

    def _scan_omml_symbols(node: ET.Element) -> None:
        lname = _local_name(node.tag)
        if lname in {"fName", "rPr", "ctrlPr"} or lname.endswith(_PR_LOCAL_SUFFIX):
            return
        if lname == "r":
            rpr = node.find(f"{M}rPr")
            if rpr is not None and rpr.find(f"{M}nor") is not None:
                return
            txt = "".join(t.text or "" for t in node.findall(f"{M}t")).strip()
            if not txt:
                return
            norm_txt = "".join(
                unicodedata.normalize("NFKC", ch) if 0x1D400 <= ord(ch) <= 0x1D7FF else ch
                for ch in txt
            )
            if norm_txt in _MATH_FUNC_STOPWORDS:
                return
            for tok in re.findall(r"[A-Za-z]+|[\u0370-\u03ff]", norm_txt):
                if tok in _MATH_FUNC_STOPWORDS or tok.lower() in _MATH_FUNC_STOPWORDS:
                    continue
                if len(tok) == 1 and (tok.isalpha() or tok in _GREEK_CHARS):
                    symbol_counts[tok] += 1
            return
        for child in node:
            _scan_omml_symbols(child)

    for omath in document_xml_root.findall(f".//{M}oMath"):
        _scan_omml_symbols(omath)

    defined_symbols: dict[str, list[str]] = {}
    zh_def_re = re.compile(
        r"(?:其中|式中|这里|此处|令|设|定义|记)[，,\s]*\$?([A-Za-z\u0370-\u03ff])(?:_[A-Za-z0-9{}]+)?\$?\s*"
        r"(?:为|表示|代表|指|是|记为|定义为|称为)\s*([^，。；,;.\n]{2,40})"
    )
    zh_inline_def_re = re.compile(
        r"(?:^|[，。；,;\s])\$?([A-Za-z\u0370-\u03ff])(?:_[A-Za-z0-9{}]+)?\$?\s*"
        r"(?:表示|代表|定义为|称为)\s*([^，。；,;.\n]{2,40})"
    )
    en_def_re = re.compile(
        r"\b(?:where|here|let|denote)\s+\$?([A-Za-z\u0370-\u03ff])(?:_[A-Za-z0-9{}]+)?\$?\s+"
        r"(?:is|denotes|represents|stands\s+for|refers\s+to|means)\s+([^,.;\n]{2,50})",
        re.I,
    )
    en_inline_def_re = re.compile(
        r"(?:^|[,.;\s])\$?([A-Za-z\u0370-\u03ff])(?:_[A-Za-z0-9{}]+)?\$?\s+"
        r"(?:denotes|represents|stands\s+for|is\s+defined\s+as)\s+([^,.;\n]{2,50})",
        re.I,
    )

    for p_el in document_xml_root.iter(f"{W}p"):
        text, _ = _extract_paragraph_content(p_el, latex=False)
        if not text:
            continue
        for pat in (zh_def_re, zh_inline_def_re, en_def_re, en_inline_def_re):
            for m in pat.finditer(text):
                sym = m.group(1)
                if sym not in symbol_counts:
                    continue
                defn = re.sub(r"\s+", " ", m.group(2)).strip()
                if defn and defn not in defined_symbols.setdefault(sym, []):
                    defined_symbols[sym].append(defn)

    undefined_high_freq = sorted(
        sym for sym, cnt in symbol_counts.items() if cnt >= 3 and sym not in defined_symbols
    )
    possible_conflicts: list[dict[str, Any]] = []
    for sym, defs in sorted(defined_symbols.items()):
        distinct: list[str] = []
        for d in defs:
            d_norm = re.sub(r"\s+", "", d).casefold()
            if not any(
                d_norm in re.sub(r"\s+", "", x).casefold() or re.sub(r"\s+", "", x).casefold() in d_norm
                for x in distinct
            ):
                distinct.append(d)
        if len(distinct) >= 2:
            possible_conflicts.append({"symbol": sym, "definitions": distinct})

    warnings: list[dict[str, Any]] = []
    if undefined_high_freq:
        warnings.append(
            {
                "code": "undefined-high-freq-symbol",
                "symbols": undefined_high_freq,
                "message": f"high-frequency math symbols without detected definition: {', '.join(undefined_high_freq)}",
            }
        )
    for item in possible_conflicts:
        warnings.append(
            {
                "code": "symbol-definition-conflict",
                "symbol": item["symbol"],
                "definitions": item["definitions"],
                "message": f"symbol '{item['symbol']}' has multiple distinct definitions: {item['definitions']}",
            }
        )

    return {
        "total_symbols": len(symbol_counts),
        "symbols": dict(symbol_counts.most_common()),
        "defined_symbols": defined_symbols,
        "undefined_high_freq_symbols": undefined_high_freq,
        "possible_conflict_symbols": possible_conflicts,
    }, warnings


def _check_pdf_punctuation_loss(
    document_xml_root: ET.Element,
    rendered_text: str | None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if not rendered_text or not rendered_text.strip():
        return [], []
    compact_rendered = re.sub(r"\s+", "", rendered_text)
    if not compact_rendered:
        return [], []

    hits: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []
    body = document_xml_root.find(f"{W}body")
    if body is None:
        return [], []

    for p_idx, p_el in enumerate(body.findall(f"{W}p"), start=1):
        text = _plain_paragraph_text(p_el).strip()
        if not text or len(_CJK_CHAR_RE.findall(text)) < 12 or text[-1] not in _CJK_END_PUNCT:
            continue
        expected_punct = text[-1]
        core = re.sub(r"\s+", "", text[:-1])
        anchor = core[-8:] if len(core) >= 8 else core[-6:]
        if len(anchor) < 6 or len(_CJK_CHAR_RE.findall(anchor)) < 5:
            continue

        positions: list[int] = []
        start = 0
        while True:
            pos = compact_rendered.find(anchor, start)
            if pos == -1:
                break
            positions.append(pos)
            start = pos + 1
        if not positions:
            continue

        preserved = False
        rendered_after_sample = ""
        for pos in positions:
            after = compact_rendered[pos + len(anchor) : pos + len(anchor) + 2]
            if not rendered_after_sample:
                rendered_after_sample = after
            if after.startswith(expected_punct):
                preserved = True
                break
        if not preserved:
            hit = {
                "paragraph": p_idx,
                "anchor": anchor,
                "expected_punct": expected_punct,
                "rendered_after": rendered_after_sample,
                "paragraph_tail": text[-20:],
            }
            hits.append(hit)
            warnings.append(
                {
                    "code": "render-punctuation-loss",
                    **hit,
                    "message": (
                        f"P{p_idx} end-of-paragraph Chinese punctuation '{expected_punct}' "
                        f"missing in rendered PDF after '{anchor}' (saw '{rendered_after_sample}')"
                    ),
                }
            )
    return hits, warnings


def run_paper_static_checks(
    source_docx: str | Path,
    document_xml_root: ET.Element,
    rendered_text: str | None = None,
) -> dict[str, Any]:
    """Run scientific paper static QA checks (placeholders, cross-refs, symbols, PDF punctuation loss)."""
    source = Path(source_docx).expanduser().resolve()
    budget = [MAX_ZIP_TOTAL_BYTES]
    failures: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []

    placeholder_hits = _check_placeholders(source, document_xml_root, budget)
    failures.extend(placeholder_hits)

    cross_refs, xref_failures, xref_warnings = _check_cross_refs(source, document_xml_root, budget)
    failures.extend(xref_failures)
    warnings.extend(xref_warnings)

    symbol_table, sym_warnings = _extract_symbol_table(document_xml_root)
    warnings.extend(sym_warnings)

    punct_hits, punct_warnings = _check_pdf_punctuation_loss(document_xml_root, rendered_text)
    warnings.extend(punct_warnings)

    return {
        "passed": len(failures) == 0,
        "failures": failures,
        "warnings": warnings,
        "placeholders": placeholder_hits,
        "cross_refs": cross_refs,
        "symbol_table": symbol_table,
        "pdf_punctuation_loss": punct_hits,
    }


# ---------------------------------------------------------------------------
# C. Simulation Data Single-Source Metrics Binding
# ---------------------------------------------------------------------------

_METRIC_EXPR_RE = re.compile(r"\{\{metric:([^{}\n]*)\}\}")
_FENCE_RE = re.compile(r"^ {0,3}(`{3,}|~{3,})")
_KEY_SEG_RE = re.compile(r"^[A-Za-z0-9_-]+$")
_SAFE_FMT_RE = re.compile(r"^[+-]?0?(?:(\d{1,2}))?,?(?:\.(\d{1,2}))?[fFeEgG%d]$")


def _parse_frontmatter_metrics(md_text: str) -> str | None:
    lines = md_text.splitlines()
    if not lines or lines[0].strip() != "---":
        return None
    end_idx = None
    for idx in range(1, len(lines)):
        if lines[idx].strip() in {"---", "..."}:
            end_idx = idx
            break
    if end_idx is None:
        return None
    for line in lines[1:end_idx]:
        m = re.match(r"^\s*metrics\s*:\s*(.*)$", line)
        if not m:
            continue
        raw = m.group(1).strip()
        if raw and raw[0] in {"'", '"'}:
            q = raw[0]
            end_q = raw.find(q, 1)
            if end_q == -1:
                raise ValueError(f"frontmatter metrics 引号未闭合：{raw}")
            val = raw[1:end_q].strip()
        else:
            val = raw.split("#", 1)[0].strip()
        if not val:
            raise ValueError("frontmatter metrics 路径不能为空")
        return val
    return None


def resolve_metrics_path(
    source_path: str | Path,
    explicit_metrics: str | Path | None = None,
) -> Path | None:
    """Resolve metrics JSON path; frontmatter paths are strictly confined to source.parent."""
    source = Path(source_path).expanduser().resolve()
    if explicit_metrics is not None:
        raw = str(explicit_metrics).strip()
        if not raw:
            raise ValueError("--metrics 路径不能为空")
        candidate = Path(raw).expanduser()
        resolved = candidate.resolve() if candidate.is_absolute() else (Path.cwd() / candidate).resolve()
        if not resolved.is_file():
            raise ValueError(f"metrics 文件不存在：{resolved}")
        return resolved

    if not source.is_file():
        return None
    fm_value = _parse_frontmatter_metrics(source.read_text(encoding="utf-8"))
    if fm_value is None:
        return None

    source_dir = source.parent.resolve()
    candidate = Path(fm_value).expanduser()
    resolved = candidate.resolve() if candidate.is_absolute() else (source_dir / candidate).resolve()
    if not resolved.is_relative_to(source_dir):
        raise ValueError("frontmatter metrics path must stay within source directory")
    if not resolved.is_file():
        raise ValueError(f"metrics 文件不存在：{resolved}")
    return resolved


def load_metrics_data(metrics_path: str | Path) -> dict[str, Any]:
    path = Path(metrics_path).expanduser().resolve()
    if not path.is_file():
        raise ValueError(f"metrics 文件不存在：{path}")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"metrics JSON 解析失败（{path}）：{exc}") from exc
    if not isinstance(data, dict):
        raise ValueError(f"metrics JSON 顶层必须是对象：{path}")
    return data


def _lookup_metric_value(metrics_data: dict[str, Any], key_path: str) -> Any:
    if not key_path or key_path.startswith(".") or key_path.endswith(".") or ".." in key_path:
        raise ValueError(f"非法 metric 路径：{key_path!r}")
    cur: Any = metrics_data
    for seg in key_path.split("."):
        if not _KEY_SEG_RE.fullmatch(seg):
            raise ValueError(f"非法 metric 路径段 {seg!r}（路径：{key_path}）")
        if isinstance(cur, dict):
            if seg not in cur:
                raise ValueError(f"metric 缺失键：{key_path}")
            cur = cur[seg]
        elif isinstance(cur, list):
            if not seg.isdigit():
                raise ValueError(f"metric 列表索引非法：{seg!r}（路径：{key_path}）")
            idx = int(seg)
            if idx < 0 or idx >= len(cur):
                raise ValueError(f"metric 列表索引越界：{key_path} (index={idx}, len={len(cur)})")
            cur = cur[idx]
        else:
            raise ValueError(f"metric 路径越界（无法继续索引标量）：{key_path}")

    if cur is None:
        raise ValueError(f"metric 值为 null：{key_path}")
    if isinstance(cur, (dict, list)):
        raise ValueError(f"metric 值必须为标量，不能是对象或数组：{key_path}")
    if isinstance(cur, float) and (math.isnan(cur) or math.isinf(cur)):
        raise ValueError(f"metric 值为非法浮点（NaN/Inf）：{key_path}")
    if isinstance(cur, str) and cur.strip().lower() in {"nan", "inf", "-inf", "+inf", "infinity", "-infinity"}:
        raise ValueError(f"metric 值为非法数值字符串（NaN/Inf）：{key_path}")
    return cur


def _validate_format_spec(fmt_spec: str, key_path: str) -> None:
    m = _SAFE_FMT_RE.fullmatch(fmt_spec)
    if not m:
        raise ValueError(f"非法或不允许的 metric 格式 {fmt_spec!r}（{key_path}）")
    width_s, prec_s = m.group(1), m.group(2)
    if width_s is not None and int(width_s) > 32:
        raise ValueError(f"metric 格式宽度超限（>{32}）：{fmt_spec!r}（{key_path}）")
    if prec_s is not None and int(prec_s) > 12:
        raise ValueError(f"metric 格式精度超限（>{12}）：{fmt_spec!r}（{key_path}）")


def _format_metric_expr(expr: str, metrics_data: dict[str, Any]) -> str:
    parts = [p.strip() for p in expr.split("|")]
    if not parts or not parts[0]:
        raise ValueError(f"空 metric 表达式：{{{{metric:{expr}}}}}")
    key_path = parts[0]
    value: Any = _lookup_metric_value(metrics_data, key_path)
    fmt_spec: str | None = None

    for mod in parts[1:]:
        if not mod:
            raise ValueError(f"空 metric 修饰符：{{{{metric:{expr}}}}}")
        if mod.startswith("scale:"):
            factor_raw = mod[len("scale:") :].strip()
            try:
                factor = float(factor_raw)
            except ValueError as exc:
                raise ValueError(f"非法 scale 倍数 {factor_raw!r}（{key_path}）") from exc
            if not math.isfinite(factor):
                raise ValueError(f"scale 倍数不能为 NaN/Inf（{key_path}）")
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ValueError(f"不能对非数值 metric 执行 scale：{key_path} ({type(value).__name__})")
            scaled = float(value) * factor
            if not math.isfinite(scaled):
                raise ValueError(f"scale 计算结果溢出为 NaN/Inf：{key_path}")
            value = scaled
        elif mod.startswith("fmt:"):
            spec = mod[len("fmt:") :].strip()
            if not spec:
                raise ValueError(f"fmt 修饰符格式为空：{key_path}")
            fmt_spec = spec
        elif ":" in mod:
            raise ValueError(f"未知 metric 修饰符 {mod!r}（{key_path}）")
        else:
            fmt_spec = mod

    if fmt_spec is not None:
        if isinstance(value, bool):
            raise ValueError(f"不能对布尔 metric 应用格式 {fmt_spec!r}：{key_path}")
        _validate_format_spec(fmt_spec, key_path)
        try:
            rendered = format(value, fmt_spec)
        except (ValueError, TypeError) as exc:
            raise ValueError(f"非法 metric 格式 {fmt_spec!r}（{key_path}）：{exc}") from exc
    else:
        rendered = str(value)

    if rendered.strip().lower() in {"nan", "inf", "-inf", "+inf"}:
        raise ValueError(f"metric 格式化结果为 NaN/Inf：{key_path}")
    return rendered


def expand_metrics_text(md_text: str, metrics_data: dict[str, Any]) -> str:
    """Expand {{metric:...}} placeholders fail-closed, skipping fenced code blocks."""
    if not isinstance(metrics_data, dict):
        raise ValueError("metrics_data 必须是 JSON 对象")

    out_lines: list[str] = []
    in_fence = False
    fence_char = ""
    fence_len = 0

    for line in md_text.splitlines(keepends=True):
        stripped = line.rstrip("\r\n")
        m_fence = _FENCE_RE.match(stripped)
        if m_fence:
            marker = m_fence.group(1)
            if not in_fence:
                in_fence = True
                fence_char = marker[0]
                fence_len = len(marker)
            elif marker[0] == fence_char and len(marker) >= fence_len and stripped[m_fence.end() :].strip() == "":
                in_fence = False
                fence_char = ""
                fence_len = 0
            out_lines.append(line)
            continue

        if in_fence:
            out_lines.append(line)
            continue

        out_lines.append(_METRIC_EXPR_RE.sub(lambda m: _format_metric_expr(m.group(1), metrics_data), line))

    return "".join(out_lines)


@contextmanager
def prepare_metrics_source(
    source: Path,
    explicit_metrics: str | Path | None = None,
) -> Iterator[tuple[Path, Path | None]]:
    """Expand metrics into a hidden sibling temp file in source.parent to preserve relative includes/resources."""
    metrics_path = resolve_metrics_path(source, explicit_metrics)
    if metrics_path is None:
        yield source, None
        return
    metrics_data = load_metrics_data(metrics_path)
    expanded = expand_metrics_text(source.read_text(encoding="utf-8"), metrics_data)
    staged = source.parent / f".oc-docx-metrics-{os.getpid()}-{secrets.token_hex(4)}{source.suffix}"
    try:
        staged.write_text(expanded, encoding="utf-8")
        yield staged, metrics_path
    finally:
        staged.unlink(missing_ok=True)
