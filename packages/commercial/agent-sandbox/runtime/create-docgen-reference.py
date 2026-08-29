#!/usr/bin/env python3
"""Generate OpenClaude's default Pandoc/Quarto DOCX reference document.

The script intentionally uses only Python stdlib. It starts from Pandoc's
upstream default reference.docx and applies conservative OOXML style patches so
agents have a good-looking baseline without committing a binary DOCX artifact.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path


def replace_or_insert_style_child(block: str, child_tag: str, child_xml: str) -> str:
    pattern = re.compile(rf"\s*<w:{child_tag}>.*?</w:{child_tag}>", re.S)
    if pattern.search(block):
        return pattern.sub("\n    " + child_xml, block, count=1)
    return block.replace("\n  </w:style>", "\n    " + child_xml + "\n  </w:style>")


def patch_style(styles: str, style_id: str, *, ppr: str | None = None, rpr: str | None = None) -> str:
    pattern = re.compile(
        rf'(<w:style\b[^>]*\bw:styleId="{re.escape(style_id)}"[^>]*>.*?</w:style>)',
        re.S,
    )

    def repl(match: re.Match[str]) -> str:
        block = match.group(1)
        if ppr is not None:
            block = replace_or_insert_style_child(block, "pPr", ppr)
        if rpr is not None:
            block = replace_or_insert_style_child(block, "rPr", rpr)
        return block

    patched, count = pattern.subn(repl, styles, count=1)
    if count != 1:
        raise RuntimeError(f"style not found in Pandoc reference.docx: {style_id}")
    return patched


def patch_styles_xml(styles: str) -> str:
    # Explicit fonts work better for mixed Chinese/English reports on Windows Word;
    # Cambria Math keeps OMML equations editable and visually consistent.
    styles = re.sub(
        r'<w:rFonts\b[^>]*/>',
        '<w:rFonts w:ascii="Aptos" w:hAnsi="Aptos" w:eastAsia="Microsoft YaHei" w:cs="Times New Roman" />',
        styles,
        count=1,
    )
    styles = re.sub(r'<w:spacing w:after="200"\s*/>', '<w:spacing w:after="120" w:line="324" w:lineRule="auto" />', styles, count=1)

    body_ppr = '<w:pPr><w:spacing w:before="80" w:after="120" w:line="324" w:lineRule="auto" /></w:pPr>'
    body_rpr = '<w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos" w:eastAsia="Microsoft YaHei" w:cs="Times New Roman" /><w:sz w:val="21" /><w:szCs w:val="21" /></w:rPr>'
    styles = patch_style(styles, "Normal", ppr=body_ppr, rpr=body_rpr)
    styles = patch_style(styles, "BodyText", ppr=body_ppr, rpr=body_rpr)

    styles = patch_style(
        styles,
        "Title",
        ppr='<w:pPr><w:jc w:val="center" /><w:spacing w:before="240" w:after="240" /></w:pPr>',
        rpr='<w:rPr><w:rFonts w:ascii="Aptos Display" w:hAnsi="Aptos Display" w:eastAsia="Microsoft YaHei" /><w:b /><w:color w:val="1F4E79" /><w:sz w:val="52" /><w:szCs w:val="52" /></w:rPr>',
    )
    styles = patch_style(
        styles,
        "Subtitle",
        ppr='<w:pPr><w:jc w:val="center" /><w:spacing w:after="240" /></w:pPr>',
        rpr='<w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos" w:eastAsia="Microsoft YaHei" /><w:color w:val="666666" /><w:sz w:val="26" /><w:szCs w:val="26" /></w:rPr>',
    )
    heading_specs = {
        "Heading1": ("1F4E79", "36", "360", "160"),
        "Heading2": ("2F5597", "28", "280", "120"),
        "Heading3": ("3B6EA8", "24", "220", "100"),
    }
    for sid, (color, size, before, after) in heading_specs.items():
        styles = patch_style(
            styles,
            sid,
            ppr=f'<w:pPr><w:keepNext /><w:spacing w:before="{before}" w:after="{after}" /></w:pPr>',
            rpr=f'<w:rPr><w:rFonts w:ascii="Aptos Display" w:hAnsi="Aptos Display" w:eastAsia="Microsoft YaHei" /><w:b /><w:color w:val="{color}" /><w:sz w:val="{size}" /><w:szCs w:val="{size}" /></w:rPr>',
        )

    caption_rpr = '<w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos" w:eastAsia="Microsoft YaHei" /><w:i /><w:color w:val="666666" /><w:sz w:val="20" /><w:szCs w:val="20" /></w:rPr>'
    for sid in ("Caption", "TableCaption", "ImageCaption"):
        styles = patch_style(
            styles,
            sid,
            ppr='<w:pPr><w:jc w:val="center" /><w:spacing w:before="80" w:after="120" /></w:pPr>',
            rpr=caption_rpr,
        )
    styles = patch_style(
        styles,
        "BlockText",
        ppr='<w:pPr><w:ind w:left="700" w:right="400" /><w:spacing w:before="80" w:after="140" /><w:pBdr><w:left w:val="single" w:sz="10" w:space="8" w:color="1F4E79" /></w:pBdr></w:pPr>',
        rpr='<w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos" w:eastAsia="Microsoft YaHei" /><w:i /><w:color w:val="666666" /><w:sz w:val="21" /><w:szCs w:val="21" /></w:rPr>',
    )
    styles = patch_style(
        styles,
        "VerbatimChar",
        rpr='<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Microsoft YaHei" /><w:sz w:val="19" /><w:szCs w:val="19" /></w:rPr>',
    )
    return styles


def patch_settings_xml(settings: str) -> str:
    # Prefer modern compatibility mode and request TOC/page-field refresh on open.
    settings = re.sub(r'<w:zoom\b[^>]*/>', '<w:zoom w:percent="100" />', settings, count=1)
    if "<w:updateFields" not in settings:
        settings = settings.replace("</w:settings>", '<w:updateFields w:val="true" /></w:settings>')
    return settings


def patch_document_xml(document: str) -> str:
    """Set the empty Pandoc reference section to A4 and readable margins."""
    section = (
        '<w:sectPr>'
        '<w:pgSz w:w="11906" w:h="16838" />'
        '<w:pgMar w:top="1247" w:right="1247" w:bottom="1134" w:left="1361" '
        'w:header="567" w:footer="567" w:gutter="0" />'
        '</w:sectPr>'
    )
    patched, count = re.subn(
        r'<w:sectPr\b[^>]*(?:/>|>.*?</w:sectPr>)',
        section,
        document,
        count=1,
        flags=re.S,
    )
    if count != 1:
        raise RuntimeError("section properties not found in Pandoc reference.docx")
    return patched


def main() -> int:
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "/usr/local/share/openclaude-docgen/reference.docx")
    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="oc-docgen-reference-") as td:
        work = Path(td)
        default_docx = work / "pandoc-reference.docx"
        with default_docx.open("wb") as f:
            subprocess.run(["pandoc", "--print-default-data-file", "reference.docx"], check=True, stdout=f)
        src = work / "src"
        src.mkdir()
        with zipfile.ZipFile(default_docx) as zf:
            zf.extractall(src)

        styles_path = src / "word" / "styles.xml"
        styles_path.write_text(patch_styles_xml(styles_path.read_text(encoding="utf-8")), encoding="utf-8")

        settings_path = src / "word" / "settings.xml"
        if settings_path.exists():
            settings_path.write_text(patch_settings_xml(settings_path.read_text(encoding="utf-8")), encoding="utf-8")

        document_path = src / "word" / "document.xml"
        document_path.write_text(patch_document_xml(document_path.read_text(encoding="utf-8")), encoding="utf-8")

        tmp_out = out.with_suffix(out.suffix + ".tmp")
        if tmp_out.exists():
            tmp_out.unlink()
        with zipfile.ZipFile(tmp_out, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for path in sorted(src.rglob("*")):
                if path.is_file():
                    zf.write(path, path.relative_to(src).as_posix())
        os.replace(tmp_out, out)
    print(out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
