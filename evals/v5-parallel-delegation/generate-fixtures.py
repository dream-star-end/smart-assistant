#!/usr/bin/env python3
"""Generate deterministic, synthetic V5 parallel-delegation evaluation fixtures."""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import time
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

from PIL import Image, ImageDraw, ImageFont


def font_path() -> str:
    preferred = [
        "Noto Sans CJK SC",
        "WenQuanYi Zen Hei",
        "DejaVu Sans",
    ]
    for family in preferred:
        result = subprocess.run(
            ["fc-match", "-f", "%{file}", family],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        if result and Path(result).is_file():
            return result
    raise RuntimeError("no usable font found through fc-match")


def make_pdf(path: Path) -> dict:
    font = ImageFont.truetype(font_path(), 34)
    small = ImageFont.truetype(font_path(), 24)
    pages = []
    gold_pages = []
    definitions = [
        ("PAGE-001-ALPHA", ["中文 English 混排", "合同编号 OC-2026-071"]),
        ("PAGE-002-BETA", ["金额 CNY 12,345.67", "日期 2026-07-28"]),
        ("PAGE-003-GAMMA", ["地址 江西省南昌市", "Status: APPROVED"]),
        ("PAGE-004-ROTATED", ["本页顺时针旋转九十度", "Rotation marker R90"]),
        ("PAGE-005-DELTA", ["Résumé naïve façade", "符号 A+B=C"]),
        ("", []),
        ("PAGE-007-TABLE", ["ROW-007-A|苹果|12", "ROW-007-B|香蕉|8"]),
        ("PAGE-008-TABLE", ["ROW-008-A|梨|15", "ROW-008-B|橙子|9"]),
        ("PAGE-009-TABLE", ["ROW-009-A|桃|6", "ROW-009-B|葡萄|11"]),
        ("PAGE-010-EPSILON", ["客服 400-800-2026", "邮箱 eval@example.test"]),
        ("PAGE-011-ZETA", ["章节 11/12", "校验码 Z-11-OK"]),
        ("PAGE-012-OMEGA", ["文档结束 END", "总页数 12"]),
    ]
    for index, (marker, lines) in enumerate(definitions, start=1):
        image = Image.new("RGB", (1000, 1400), "white")
        draw = ImageDraw.Draw(image)
        if marker:
            draw.text((80, 160), marker, fill="black", font=font)
            y = 260
            for line in lines:
                draw.text((80, y), line, fill="black", font=font)
                y += 80
        # Every page carries a small explicit page watermark. Page 6 is otherwise blank.
        draw.text((760, 1320), f"WATERMARK-{index:03d}", fill=(145, 145, 145), font=small)
        orientation = 90 if index == 4 else 0
        if orientation:
            # Keep every source pixel. expand=False cropped page 4's marker and
            # watermark, making the former gold impossible to satisfy.
            image = image.rotate(-90, expand=True, fillcolor="white")
        pages.append(image)
        gold_pages.append(
            {
                "page": index,
                "orientation": orientation,
                "blank": index == 6,
                "marker": marker,
                "watermark": f"WATERMARK-{index:03d}",
                "table_rows": lines if 7 <= index <= 9 else [],
            }
        )
    fixed_time = time.struct_time((2026, 7, 28, 0, 0, 0, 1, 209, 0))
    pages[0].save(
        path,
        "PDF",
        save_all=True,
        append_images=pages[1:],
        resolution=150.0,
        creationDate=fixed_time,
        modDate=fixed_time,
    )
    return {"pages": gold_pages}


def inline_cell(ref: str, value: str, style: int | None = None) -> str:
    style_attr = f' s="{style}"' if style is not None else ""
    return (
        f'<c r="{ref}" t="inlineStr"{style_attr}><is><t>'
        f"{escape(value)}</t></is></c>"
    )


def numeric_cell(
    ref: str,
    value: int | float,
    formula: str | None = None,
    style: int | None = None,
) -> str:
    style_attr = f' s="{style}"' if style is not None else ""
    formula_xml = f"<f>{escape(formula)}</f>" if formula else ""
    return f'<c r="{ref}"{style_attr}>{formula_xml}<v>{value}</v></c>'


def make_xlsx(path: Path) -> dict:
    content_types = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>"""
    root_rels = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"""
    workbook = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="摘要" sheetId="1" r:id="rId1"/>
    <sheet name="数据" sheetId="2" r:id="rId2"/>
  </sheets>
  <calcPr calcId="191029" fullCalcOnLoad="1"/>
</workbook>"""
    workbook_rels = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>"""
    styles = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2"><font><sz val="11"/><name val="Arial"/></font><font><b/><sz val="14"/><name val="Arial"/></font></fonts>
  <fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFD9EAF7"/><bgColor indexed="64"/></patternFill></fill></fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>"""
    sheet1 = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">{inline_cell("A1", "季度汇总", 1)}</row>
    <row r="2">{inline_cell("A2", "项目")}{numeric_cell("B2", 120)}{numeric_cell("C2", 135.6, "B2*1.13")}</row>
    <row r="3">{inline_cell("A3", "服务")}{numeric_cell("B3", 80)}{numeric_cell("C3", 90.4, "B3*1.13")}</row>
  </sheetData>
  <mergeCells count="1"><mergeCell ref="A1:C1"/></mergeCells>
</worksheet>"""
    sheet2 = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">{inline_cell("A1", "编号")}{inline_cell("B1", "名称")}{inline_cell("C1", "数量")}</row>
    <row r="2">{inline_cell("A2", "D-001")}{inline_cell("B2", "Alpha")}{numeric_cell("C2", 7)}</row>
    <row r="3">{inline_cell("A3", "D-002")}{inline_cell("B3", "Beta")}{numeric_cell("C3", 13)}</row>
    <row r="4">{inline_cell("A4", "TOTAL")}{inline_cell("B4", "")}{numeric_cell("C4", 20, "SUM(C2:C3)")}</row>
  </sheetData>
</worksheet>"""
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, content in {
            "[Content_Types].xml": content_types,
            "_rels/.rels": root_rels,
            "xl/workbook.xml": workbook,
            "xl/_rels/workbook.xml.rels": workbook_rels,
            "xl/styles.xml": styles,
            "xl/worksheets/sheet1.xml": sheet1,
            "xl/worksheets/sheet2.xml": sheet2,
        }.items():
            # ZipInfo otherwise embeds the current wall clock, so two fixture
            # generations have different input hashes despite identical data.
            info = zipfile.ZipInfo(name, date_time=(2026, 7, 28, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, content)
    return {
        "workbook": {
            "sheets": ["摘要", "数据"],
            "merges": {"摘要": ["A1:C1"], "数据": []},
            "cells": {
                "摘要": {
                    "A1": {"value": "季度汇总", "bold": True, "fill": "FFD9EAF7"},
                    "A2": {"value": "项目"},
                    "B2": {"value": 120},
                    "C2": {"value": 135.6, "formula": "B2*1.13"},
                    "A3": {"value": "服务"},
                    "B3": {"value": 80},
                    "C3": {"value": 90.4, "formula": "B3*1.13"},
                },
                "数据": {
                    "A1": {"value": "编号"},
                    "B1": {"value": "名称"},
                    "C1": {"value": "数量"},
                    "A2": {"value": "D-001"},
                    "B2": {"value": "Alpha"},
                    "C2": {"value": 7},
                    "A3": {"value": "D-002"},
                    "B3": {"value": "Beta"},
                    "C3": {"value": 13},
                    "A4": {"value": "TOTAL"},
                    "C4": {"value": 20, "formula": "SUM(C2:C3)"},
                },
            },
        }
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True, help="empty output directory")
    args = parser.parse_args()
    out = Path(args.out).resolve()
    if out.exists():
        if any(out.iterdir()):
            raise SystemExit(f"refusing to replace non-empty evaluation root: {out}")
    else:
        out.mkdir(parents=True)
    input_dir = out / "input"
    gold_dir = out / "gold"
    input_dir.mkdir(parents=True)
    gold_dir.mkdir(parents=True)

    gold = {}
    gold.update(make_pdf(input_dir / "document-batch.pdf"))
    gold.update(make_xlsx(input_dir / "document-batch.xlsx"))

    code_fixture = {
        "modules": [
            {
                "name": "parse_csv",
                "requirements": [
                    "return an array of rows, each row an array of strings",
                    "support LF and CRLF records",
                    "support quoted commas, escaped double quotes, and newlines inside quoted fields",
                    "preserve leading/trailing spaces and trailing empty fields",
                    "a final record separator must not create an extra empty row",
                ],
                "buggy_source": "(text) => text.split('\\n').map((line) => line.split(','))",
            },
            {
                "name": "apply_patch",
                "requirements": [
                    "apply add/remove/replace operations and return a deep-cloned result without mutating the input",
                    "decode JSON Pointer ~0 and ~1 escapes",
                    "support object keys, numeric array indexes, array append '-', and root path ''",
                    "operations are applied strictly in order",
                ],
                "buggy_source": "(document, operations) => Object.assign(document, ...operations.map((op) => ({[op.path]: op.value})))",
            },
            {
                "name": "dependency_batches",
                "requirements": [
                    "input is [{id,deps}] and output is deterministic topological batches",
                    "within each batch preserve the original task order",
                    "duplicate id returns {error:'DUPLICATE_ID:<id>'}",
                    "unknown dependency returns {error:'UNKNOWN_DEP:<id>'}",
                    "a cycle returns {error:'CYCLE'}",
                    "do not mutate the input",
                ],
                "buggy_source": "(tasks) => [tasks.map((task) => task.id)]",
            },
        ]
    }
    (input_dir / "code-batch.json").write_text(
        json.dumps(code_fixture, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    gold["code_hidden_tests"] = {
        "parse_csv": [
            {
                "args": ["name,note\r\nAlice,\"hello, world\"\r\nBob,\"line1\nline2\"\r\n"],
                "expected": [["name", "note"], ["Alice", "hello, world"], ["Bob", "line1\nline2"]],
            },
            {
                "args": ['a,"b""c",, d\n'],
                "expected": [["a", 'b"c', "", " d"]],
            },
            {"args": [""], "expected": []},
            {"args": ["x,y,"], "expected": [["x", "y", ""]]},
        ],
        "apply_patch": [
            {
                "args": [
                    {"a": [1, 2], "x/y": {"~key": "old"}},
                    [
                        {"op": "add", "path": "/a/-", "value": 3},
                        {"op": "replace", "path": "/x~1y/~0key", "value": "new"},
                        {"op": "remove", "path": "/a/0"},
                    ],
                ],
                "expected": {"a": [2, 3], "x/y": {"~key": "new"}},
            },
            {
                "args": [
                    {"a": 1},
                    [
                        {"op": "replace", "path": "", "value": [1, 2]},
                        {"op": "add", "path": "/1", "value": 9},
                    ],
                ],
                "expected": [1, 9, 2],
            },
            {
                "args": [
                    {"nested": {"keep": True}},
                    [{"op": "add", "path": "/nested/new", "value": {"x": 1}}],
                ],
                "expected": {"nested": {"keep": True, "new": {"x": 1}}},
            },
        ],
        "dependency_batches": [
            {
                "args": [[
                    {"id": "lint", "deps": []},
                    {"id": "build", "deps": ["lint"]},
                    {"id": "docs", "deps": []},
                    {"id": "test", "deps": ["build"]},
                    {"id": "pack", "deps": ["test", "docs"]},
                ]],
                "expected": [["lint", "docs"], ["build"], ["test"], ["pack"]],
            },
            {
                "args": [[{"id": "a", "deps": []}, {"id": "a", "deps": []}]],
                "expected": {"error": "DUPLICATE_ID:a"},
            },
            {
                "args": [[{"id": "a", "deps": ["missing"]}]],
                "expected": {"error": "UNKNOWN_DEP:missing"},
            },
            {
                "args": [[{"id": "a", "deps": ["b"]}, {"id": "b", "deps": ["a"]}]],
                "expected": {"error": "CYCLE"},
            },
            {"args": [[]], "expected": []},
        ],
    }
    gold["simple"] = {"answer": 703}
    dependent = {
        "start": 7,
        "operations": [
            {"op": "add", "value": 5},
            {"op": "multiply", "value": 3},
            {"op": "subtract", "value": 4},
            {"op": "mod", "value": 97},
            {"op": "square_mod", "value": 101},
            {"op": "add", "value": 17},
            {"op": "multiply", "value": 5},
            {"op": "subtract", "value": 9},
            {"op": "mod", "value": 89},
            {"op": "square_mod", "value": 103},
        ] * 3,
    }
    trace = [dependent["start"]]
    value = dependent["start"]
    for operation in dependent["operations"]:
        operand = operation["value"]
        if operation["op"] == "add":
            value += operand
        elif operation["op"] == "multiply":
            value *= operand
        elif operation["op"] == "subtract":
            value -= operand
        elif operation["op"] == "mod":
            value %= operand
        elif operation["op"] == "square_mod":
            value = value * value % operand
        trace.append(value)
    (input_dir / "dependent-chain.json").write_text(
        json.dumps(dependent, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    gold["dependent"] = {"trace": trace}
    (gold_dir / "gold.json").write_text(
        json.dumps(gold, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    scenarios = {
        "document_batch": {
            "attachments": ["document-batch.pdf", "document-batch.xlsx"],
            "absolute_wall_ms": 600000,
            "prompt": (
                "读取两个附件并完成一次严谨的文档批处理。PDF 共 12 页；逐页识别方向、是否除页码水印外为空、"
                "页面 marker、水印和跨第 7–9 页表格的所有行。再读取 Excel 的 sheet 顺序、合并区、指定非空"
                "单元格值/公式，以及标题 A1 的粗体和填充色。最终只输出一个 JSON 对象，不要 Markdown："
                '{"pages":[{"page":1,"orientation":0,"blank":false,"marker":"...",'
                '"watermark":"...","table_rows":[]}],"workbook":{"sheets":[],"merges":{},'
                '"cells":{"sheet":{"A1":{"value":"...","formula":"...","bold":true,"fill":"..."}}}}}。'
                "必须覆盖 1–12 页且按页号排序；先校正旋转页再识别。table_rows 的每一行固定写成"
                '"ROW-ID|名称|数量" 字符串；每个 sheet 都必须出现在 merges 中，没有合并区写 []；'
                "公式不带开头等号；填充色用无 # 的八位大写 ARGB。无关字段可以省略。"
            ),
        },
        "code_batch": {
            "attachments": ["code-batch.json"],
            "absolute_wall_ms": 300000,
            "prompt": (
                "分别实现附件里三个互不依赖、边界规格较多的 JavaScript 模块。逐项核对全部 requirements，"
                "不要共享可变状态。最终只按以下纯文本格式输出三个函数，不要 Markdown、解释或 JSON；"
                "函数名和顺序必须完全一致，每段内容必须是一个无外部依赖的 JavaScript 函数表达式：\n"
                "FUNCTION parse_csv\n(text) => ...\nEND FUNCTION\n"
                "FUNCTION apply_patch\n(document, operations) => ...\nEND FUNCTION\n"
                "FUNCTION dependency_batches\n(tasks) => ...\nEND FUNCTION\n"
                "评测器会在隔离子进程中执行多组未公开边界测试。"
            ),
        },
        "simple": {
            "attachments": [],
            "absolute_wall_ms": 60000,
            "prompt": '计算 37*19。最终只输出 JSON：{"answer":703}。',
        },
        "dependent": {
            "attachments": ["dependent-chain.json"],
            "absolute_wall_ms": 180000,
            "prompt": (
                "读取附件中的 30 步强依赖整数链，严格按数组顺序执行；每一步都必须使用上一步结果，"
                "square_mod 表示 value=(value*value)%operand。最终只输出 JSON："
                '{"trace":[初值,每一步结果...]}。必须包含初值和全部 30 个中间结果，不得分段独立计算。'
            ),
        },
    }
    (out / "scenarios.json").write_text(
        json.dumps(scenarios, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    manifest = {
        "schema_version": 1,
        "fixture_revs": {
            "generator_rev": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "scenarios_rev": hashlib.sha256((out / "scenarios.json").read_bytes()).hexdigest(),
            "gold_rev": hashlib.sha256((gold_dir / "gold.json").read_bytes()).hexdigest(),
        },
        "engines": {
            "ccb": {"model": "qwen3.7-max", "effort": None},
            "codex": {"model": "gpt-5.6-sol", "effort": None},
        },
        "scenarios": list(scenarios),
        "absolute_wall_ms": {
            name: config["absolute_wall_ms"] for name, config in scenarios.items()
        },
        "input_hashes": {
            name: hashlib.sha256(
                json.dumps(
                    {
                        "scenario": name,
                        "prompt": config["prompt"],
                        "attachments": [
                            [
                                attachment,
                                hashlib.sha256(
                                    (input_dir / attachment).read_bytes()
                                ).hexdigest(),
                            ]
                            for attachment in config["attachments"]
                        ],
                    },
                    ensure_ascii=False,
                    separators=(",", ":"),
                ).encode("utf-8")
            ).hexdigest()
            for name, config in scenarios.items()
        },
        "pairs": [
            {"pair_id": "01", "order": "A_FIRST"},
            {"pair_id": "02", "order": "B_FIRST"},
            {"pair_id": "03", "order": "A_FIRST"},
            {"pair_id": "04", "order": "B_FIRST"},
        ],
        "max_pair_gap_ms": 120000,
        "max_container_age_before_pair_ms": 300000,
        "arms": ["A", "B"],
    }
    (out / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(out)


if __name__ == "__main__":
    main()
