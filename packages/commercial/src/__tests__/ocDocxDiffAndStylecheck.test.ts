/**
 * 实测出版级 Word 标黄 Diff (`oc-docx diff`) 与去 AI 味风格门禁 (`oc-stylecheck`)。
 * 使用真实 `.docx` 文件(含原生 OMML `<m:oMath>` 公式与表格)验证:
 *   1. `oc-docx diff` 输出干净版 + 标黄修订版(`w:highlight w:val="yellow"`), 未改段落不标黄, OMML 完整保留且零 `¿` 乱码;
 *   2. 含 `¿` 乱码的 OMML `.docx` 会被 `oc-docx diff` 自动拦截(`omml_check.passed=false`, exit 1);
 *   3. `oc-stylecheck` 覆盖 `.docx`/`.md`/`.txt`: 破折号频次告警、中英文高频 AI 套话精确行号定位、`--style-file STYLE.md` 自定义禁用词叠加与 `--strict` 门禁。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";

const REPO_ROOT = resolve(".");
const OC_DOCX = join(REPO_ROOT, "packages/commercial/agent-sandbox/platform-runtime/bin/oc-docx.py");
const OC_STYLECHECK = join(REPO_ROOT, "packages/commercial/agent-sandbox/platform-runtime/bin/oc-stylecheck.py");

function runPy(script: string, args: string[]) {
  return spawnSync("python3", [script, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

function buildRealDocx(outPath: string, opts: {
  paragraphs: string[];
  tableRows?: string[][];
  ommlText?: string;
}): void {
  const py = `
import sys, json
from docx import Document
from docx.oxml import parse_xml

spec = json.loads(sys.argv[1])
out_path = sys.argv[2]
doc = Document()
for text in spec["paragraphs"]:
    doc.add_paragraph(text)
if spec.get("ommlText"):
    p = doc.add_paragraph("Equation: ")
    omml = parse_xml(
        '<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">'
        '<m:r><m:t>' + spec["ommlText"] + '</m:t></m:r>'
        '</m:oMath>'
    )
    p._p.append(omml)
if spec.get("tableRows"):
    rows = spec["tableRows"]
    tbl = doc.add_table(rows=len(rows), cols=len(rows[0]))
    for r_i, row in enumerate(rows):
        for c_i, val in enumerate(row):
            tbl.rows[r_i].cells[c_i].text = val
doc.save(out_path)
`;
  const res = spawnSync("python3", ["-c", py, JSON.stringify(opts), outPath], { encoding: "utf8" });
  assert.equal(res.status, 0, `buildRealDocx failed: ${res.stderr}`);
}

function inspectDocxXml(docxPath: string): {
  documentXml: string;
  highlightedTexts: string[];
  unhighlightedTexts: string[];
  ommlCount: number;
} {
  const py = `
import sys, json, zipfile, xml.etree.ElementTree as ET
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
M = "{http://schemas.openxmlformats.org/officeDocument/2006/math}"
with zipfile.ZipFile(sys.argv[1], "r") as z:
    xml_bytes = z.read("word/document.xml")
root = ET.fromstring(xml_bytes)
hl, plain = [], []
for r in root.iter(f"{W}r"):
    txt = "".join(t.text or "" for t in r.findall(f"{W}t"))
    if not txt:
        continue
    rpr = r.find(f"{W}rPr")
    is_yellow = False
    if rpr is not None:
        h = rpr.find(f"{W}highlight")
        if h is not None and (h.get(f"{W}val") or "").lower() == "yellow":
            is_yellow = True
    (hl if is_yellow else plain).append(txt)
print(json.dumps({
    "documentXml": xml_bytes.decode("utf-8"),
    "highlightedTexts": hl,
    "unhighlightedTexts": plain,
    "ommlCount": len(root.findall(f".//{M}oMath")),
}, ensure_ascii=False))
`;
  const res = spawnSync("python3", ["-c", py, docxPath], { encoding: "utf8" });
  assert.equal(res.status, 0, `inspectDocxXml failed: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

describe("oc-docx diff (OCV5-865)", () => {
  test("produces clean + yellow-highlighted revised DOCX with word-level diff, table diff, and OMML zero-garbled check", () => {
    const work = mkdtempSync(join(tmpdir(), "oc-docx-diff-"));
    try {
      const basePath = join(work, "base.docx");
      const revisedPath = join(work, "revised.docx");
      const cleanPath = join(work, "clean.docx");
      const hlPath = join(work, "highlighted.docx");
      const reportPath = join(work, "diff-report.json");

      buildRealDocx(basePath, {
        paragraphs: [
          "Introduction to Neural Retrieval.",
          "Our baseline model achieves 81.2% recall on the dataset.",
          "This paragraph remains completely unchanged.",
        ],
        ommlText: "E = mc^2",
        tableRows: [
          ["Model", "F1"],
          ["Baseline", "0.78"],
        ],
      });

      buildRealDocx(revisedPath, {
        paragraphs: [
          "Introduction to Neural Retrieval.",
          "Our upgraded model achieves 92.6% recall on the dataset.",
          "This paragraph remains completely unchanged.",
          "Added ablation section confirms robustness across seeds.",
        ],
        ommlText: "E = mc^2",
        tableRows: [
          ["Model", "F1"],
          ["Baseline", "0.89"],
        ],
      });

      const res = runPy(OC_DOCX, [
        "diff",
        "--base",
        basePath,
        "--revised",
        revisedPath,
        "--out-clean",
        cleanPath,
        "--out-highlighted",
        hlPath,
        "--json",
        reportPath,
      ]);
      assert.equal(res.status, 0, `oc-docx diff failed: ${res.stderr}\n${res.stdout}`);
      assert.ok(existsSync(cleanPath));
      assert.ok(existsSync(hlPath));
      assert.ok(existsSync(reportPath));

      const report = JSON.parse(res.stdout);
      assert.equal(report.passed, true);
      assert.equal(report.omml_check.passed, true);
      assert.equal(report.omml_check.clean_omml_count, 1);
      assert.equal(report.omml_check.highlighted_omml_count, 1);
      assert.equal(report.omml_check.clean_garbled_count, 0);
      assert.equal(report.omml_check.highlighted_garbled_count, 0);
      assert.equal(report.summary.modified_paragraphs, 1);
      assert.equal(report.summary.added_paragraphs, 1);
      assert.equal(report.summary.changed_tables, 1);
      assert.ok(report.summary.highlighted_runs >= 3);

      const cleanXml = inspectDocxXml(cleanPath);
      assert.equal(cleanXml.highlightedTexts.length, 0, "clean output must have no yellow highlights");
      assert.equal(cleanXml.ommlCount, 1);

      const hlXml = inspectDocxXml(hlPath);
      assert.equal(hlXml.ommlCount, 1, "highlighted output must preserve OMML formulas");
      const joinedHl = hlXml.highlightedTexts.join(" ");
      assert.ok(joinedHl.includes("upgraded"), `expected 'upgraded' highlighted, got: ${joinedHl}`);
      assert.ok(joinedHl.includes("92.6"), `expected '92.6' highlighted, got: ${joinedHl}`);
      assert.ok(joinedHl.includes("Added ablation section"), `expected added paragraph highlighted, got: ${joinedHl}`);
      assert.ok(joinedHl.includes("89"), `expected modified table value highlighted, got: ${joinedHl}`);
      assert.ok(
        !joinedHl.includes("This paragraph remains completely unchanged."),
        "unchanged paragraph must NOT be highlighted",
      );
      assert.ok(
        hlXml.unhighlightedTexts.some((t) => t.includes("This paragraph remains completely unchanged.")),
        "unchanged paragraph stays unhighlighted",
      );
      assert.equal(JSON.parse(readFileSync(reportPath, "utf8")).passed, true);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("fails omml_check when revised DOCX contains garbled ¿ inside OMML", () => {
    const work = mkdtempSync(join(tmpdir(), "oc-docx-diff-garbled-"));
    try {
      const basePath = join(work, "base.docx");
      const revisedPath = join(work, "revised-bad.docx");
      const cleanPath = join(work, "clean.docx");
      const hlPath = join(work, "hl.docx");

      buildRealDocx(basePath, { paragraphs: ["Formula check"], ommlText: "x + y = z" });
      buildRealDocx(revisedPath, { paragraphs: ["Formula check updated"], ommlText: "x ¿ y = z" });

      const res = runPy(OC_DOCX, [
        "diff",
        "--base",
        basePath,
        "--revised",
        revisedPath,
        "--out-clean",
        cleanPath,
        "--out-highlighted",
        hlPath,
      ]);
      assert.equal(res.status, 1, "garbled ¿ OMML must fail with exit code 1");
      const report = JSON.parse(res.stdout);
      assert.equal(report.passed, false);
      assert.equal(report.omml_check.passed, false);
      assert.ok(report.omml_check.clean_garbled_count >= 1);
      assert.ok(report.omml_check.highlighted_garbled_count >= 1);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("preserves <w:tab/>, <w:br/>, embedded nodes and detects/highlights standalone OMML revisions (OCV5-865 #9)", () => {
    const work = mkdtempSync(join(tmpdir(), "oc-docx-diff-struct-omml-"));
    try {
      const basePath = join(work, "base-struct.docx");
      const revisedPath = join(work, "rev-struct.docx");
      const cleanPath = join(work, "clean-struct.docx");
      const hlPath = join(work, "hl-struct.docx");

      const makeDocScript = `
import sys
from docx import Document
from docx.oxml import OxmlElement, parse_xml
from docx.oxml.ns import qn

out_path, label, formula = sys.argv[1], sys.argv[2], sys.argv[3]
doc = Document()

# Paragraph 1: single <w:r> containing text + <w:tab/> + label + <w:br/> + "Next line" + embedded <w:sym/>
p1 = doc.add_paragraph()
r = OxmlElement("w:r")
t1 = OxmlElement("w:t"); t1.text = "Result:"
tab = OxmlElement("w:tab")
t2 = OxmlElement("w:t"); t2.text = label
br = OxmlElement("w:br")
t3 = OxmlElement("w:t"); t3.text = "Next line"
sym = OxmlElement("w:sym"); sym.set(qn("w:font"), "Symbol"); sym.set(qn("w:char"), "F0B1")
for el in (t1, tab, t2, br, t3, sym):
    r.append(el)
p1._p.append(r)

# Paragraph 2: standalone native OMML equation ONLY (no w:r text)
p2 = doc.add_paragraph()
omml = parse_xml(
    '<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">'
    f'<m:r><m:t>{formula}</m:t></m:r>'
    '</m:oMath>'
)
p2._p.append(omml)

doc.save(out_path)
`;
      for (const [p, lbl, eq] of [
        [basePath, "A", "x=1"],
        [revisedPath, "B", "x=2"],
      ]) {
        const built = spawnSync("python3", ["-c", makeDocScript, p, lbl, eq], { encoding: "utf8" });
        assert.equal(built.status, 0, built.stderr);
      }

      const res = runPy(OC_DOCX, [
        "diff",
        "--base",
        basePath,
        "--revised",
        revisedPath,
        "--out-clean",
        cleanPath,
        "--out-highlighted",
        hlPath,
      ]);
      assert.equal(res.status, 0, `diff failed: ${res.stdout}\n${res.stderr}`);
      const report = JSON.parse(res.stdout);
      assert.equal(report.passed, true);
      assert.equal(report.summary.modified_paragraphs, 2, "both text+tab+br paragraph and OMML-only paragraph must be detected as modified");
      assert.equal(report.summary.changed_omml_nodes, 1, "changed OMML x=1 -> x=2 must be counted");

      // Inspect highlighted document.xml directly
      const inspectScript = `
import json, sys, zipfile
import xml.etree.ElementTree as ET
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
M = "{http://schemas.openxmlformats.org/officeDocument/2006/math}"
with zipfile.ZipFile(sys.argv[1], "r") as z:
    root = ET.fromstring(z.read("word/document.xml"))
paras = root.findall(f".//{W}body/{W}p")
p1 = paras[0]
p1_stream = []
for r in p1.findall(f"{W}r"):
    for ch in r:
        if ch.tag == f"{W}t": p1_stream.append(ch.text or "")
        elif ch.tag == f"{W}tab": p1_stream.append("\\t")
        elif ch.tag == f"{W}br": p1_stream.append("\\n")
p1_syms = len(p1.findall(f".//{W}sym"))
p1_tabs = len(p1.findall(f".//{W}tab"))
p1_brs = len(p1.findall(f".//{W}br"))
p2 = paras[1]
p2_ommls = p2.findall(f".//{M}oMath")
p2_omml_text = "".join((t.text or "") for t in p2.findall(f".//{M}t"))
p2_omml_yellow = sum(1 for hl in p2.findall(f".//{M}oMath//{W}highlight") if hl.get(f"{W}val") == "yellow")
p2_ppr = p2.find(f"{W}pPr")
p2_shd = p2_ppr.find(f"{W}shd") if p2_ppr is not None else None
p2_left = p2_ppr.find(f"{W}pBdr/{W}left") if p2_ppr is not None else None
print(json.dumps({
    "p1_text": "".join(p1_stream),
    "p1_tabs": p1_tabs,
    "p1_brs": p1_brs,
    "p1_syms": p1_syms,
    "p2_omml_count": len(p2_ommls),
    "p2_omml_text": p2_omml_text,
    "p2_omml_yellow": p2_omml_yellow,
    "p2_shd_fill": p2_shd.get(f"{W}fill") if p2_shd is not None else None,
    "p2_shd_val": p2_shd.get(f"{W}val") if p2_shd is not None else None,
    "p2_left_color": p2_left.get(f"{W}color") if p2_left is not None else None,
    "p2_left_sz": p2_left.get(f"{W}sz") if p2_left is not None else None,
    "p2_left_space": p2_left.get(f"{W}space") if p2_left is not None else None,
}))
`;
      const inspected = spawnSync("python3", ["-c", inspectScript, hlPath], { encoding: "utf8" });
      assert.equal(inspected.status, 0, inspected.stderr);
      const xml = JSON.parse(inspected.stdout);
      assert.equal(xml.p1_text, "Result:\tB\nNext line", "highlighted output must preserve exact tab & line break structure");
      assert.equal(xml.p1_tabs, 1);
      assert.equal(xml.p1_brs, 1);
      assert.equal(xml.p1_syms, 1, "embedded <w:sym/> node must be preserved");
      assert.equal(xml.p2_omml_count, 1, "equation must remain editable native <m:oMath>");
      assert.equal(xml.p2_omml_text, "x=2");
      assert.ok(xml.p2_omml_yellow >= 1, "revised OMML must carry yellow highlight");
      assert.equal(xml.p2_shd_fill, "FFF9C4", "revised OMML paragraph must have soft yellow shading for LibreOffice + Word");
      assert.equal(xml.p2_shd_val, "clear");
      assert.equal(xml.p2_left_color, "F59E0B", "revised OMML paragraph must have amber left revision bar");
      assert.equal(xml.p2_left_sz, "18");
      assert.equal(xml.p2_left_space, "6");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("real LibreOffice render check in oc-docx diff catches StarMath ¿/□ and passes once fixed (OCV5-874 #1)", (t) => {
    const tools = spawnSync("which", ["soffice", "lowriter", "pdftotext", "pandoc"], { encoding: "utf8" });
    if (tools.status !== 0) {
      t.skip("soffice/pdftotext/pandoc not available");
      return;
    }
    const work = mkdtempSync(join(tmpdir(), "oc-docx-diff-render-gate-"));
    try {
      const baseMd = join(work, "base.md");
      const badRevMd = join(work, "bad-rev.md");
      const goodRevMd = join(work, "good-rev.md");
      const baseDocx = join(work, "base.docx");
      const badRevDocx = join(work, "bad-rev.docx");
      const goodRevDocx = join(work, "good-rev.docx");

      writeFileSync(baseMd, "# Experiment\n\nBaseline phase $\\left|\\Delta\\phi\\right| < \\pi$ at 20°.\n", "utf8");
      writeFileSync(badRevMd, "# Experiment\n\nUpdated phase $|\\Delta\\phi| < \\pi$ at 30 $^\\circ$.\n", "utf8");
      writeFileSync(goodRevMd, "# Experiment\n\nUpdated phase $\\left|\\Delta\\phi\\right| < \\pi$ at 30°.\n", "utf8");

      for (const [src, dst] of [
        [baseMd, baseDocx],
        [badRevMd, badRevDocx],
        [goodRevMd, goodRevDocx],
      ]) {
        const c = runPy(OC_DOCX, ["convert", src, "--no-reference-doc", "-o", dst]);
        assert.equal(c.status, 0, c.stderr);
      }

      const badDiff = runPy(OC_DOCX, [
        "diff",
        "--base",
        baseDocx,
        "--revised",
        badRevDocx,
        "--out-clean",
        join(work, "bad-clean.docx"),
        "--out-highlighted",
        join(work, "bad-hl.docx"),
      ]);
      assert.equal(badDiff.status, 1, `expected render-garbled diff to FAIL:\n${badDiff.stdout}\n${badDiff.stderr}`);
      const badReport = JSON.parse(badDiff.stdout);
      assert.equal(badReport.passed, false);
      assert.equal(badReport.omml_check.passed, false);
      assert.equal(badReport.omml_check.render_check_executed, true);
      assert.ok(badReport.omml_check.render_garbled_count >= 2);
      assert.ok(
        badReport.omml_check.render_garbled_hits.some(
          (h: any) => (h.char === "¿" || h.char === "□" || h.char === "❑") && h.page === 1 && h.context.length > 0,
        ),
        `expected StarMath garbled glyph hit (¿/□/❑) on page 1: ${JSON.stringify(badReport.omml_check.render_garbled_hits)}`,
      );

      const goodDiff = runPy(OC_DOCX, [
        "diff",
        "--base",
        baseDocx,
        "--revised",
        goodRevDocx,
        "--out-clean",
        join(work, "good-clean.docx"),
        "--out-highlighted",
        join(work, "good-hl.docx"),
      ]);
      assert.equal(goodDiff.status, 0, `expected fixed diff to PASS:\n${goodDiff.stdout}\n${goodDiff.stderr}`);
      const goodReport = JSON.parse(goodDiff.stdout);
      assert.equal(goodReport.passed, true);
      assert.equal(goodReport.omml_check.passed, true);
      assert.equal(goodReport.omml_check.render_check_executed, true);
      assert.equal(goodReport.omml_check.render_garbled_count, 0);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("avoids Chinese word splitting, collapses heavily rewritten clauses without zebra stripes, and aligns inserted paragraphs before equations (OCV5-875)", () => {
    const work = mkdtempSync(join(tmpdir(), "oc-docx-diff-zh-polish-"));
    try {
      const basePath = join(work, "zh-base.docx");
      const revPath = join(work, "zh-rev.docx");
      const cleanPath = join(work, "zh-clean.docx");
      const hlPath = join(work, "zh-hl.docx");

      const makeZhDoc = `
import sys
from docx import Document
from docx.oxml import parse_xml

out_path, mode = sys.argv[1], sys.argv[2]
doc = Document()
if mode == "base":
    doc.add_paragraph("未建模的大气差分路径延迟将直接转化为载波相位残差。本文构建全链路模型，在标准工况下，求得结果。")
    doc.add_paragraph("电离层属于色散介质，在微波频段其一阶斜路径延迟幅值与工作频率的平方成反比：")
    p_eq = doc.add_paragraph()
    p_eq._p.append(parse_xml(
        '<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">'
        '<m:r><m:t>y = 2x</m:t></m:r></m:oMath>'
    ))
    doc.add_paragraph("式中，x 为路径残差。后文给出具体结果。")
else:
    doc.add_paragraph("未建模的大气差分路径延迟将直接转化为载波相位误差。本文建立全链路模型，在标准工况下，算得结果。")
    doc.add_paragraph("电离层为色散介质，采用国际单位制常数（斜路径总电子含量单位为电子每平米，载波频率单位为赫兹），其一阶群延迟滞后量与载波相位等效路径超前量大小相等、符号相反：")
    doc.add_paragraph("新增的过渡说明段落位于公式之前。")
    p_eq = doc.add_paragraph()
    p_eq._p.append(parse_xml(
        '<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">'
        '<m:r><m:t>y = 4x</m:t></m:r></m:oMath>'
    ))
    doc.add_paragraph("式中，x 为路径残差。后文补充误差预算分析。")
doc.save(out_path)
`;
      for (const [p, mode] of [
        [basePath, "base"],
        [revPath, "rev"],
      ]) {
        const built = spawnSync("python3", ["-c", makeZhDoc, p, mode], { encoding: "utf8" });
        assert.equal(built.status, 0, built.stderr);
      }

      const res = runPy(OC_DOCX, [
        "diff",
        "--base",
        basePath,
        "--revised",
        revPath,
        "--out-clean",
        cleanPath,
        "--out-highlighted",
        hlPath,
        "--no-render-check",
      ]);
      assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
      const report = JSON.parse(res.stdout);
      assert.equal(report.passed, true);
      assert.equal(report.summary.added_paragraphs, 1, "inserted lead-in paragraph must be detected as added");
      assert.equal(report.summary.changed_omml_nodes, 1, "equation y=2x -> y=4x must stay aligned and diffed");

      // Inspect per-paragraph highlighted segments
      const inspectPy = `
import json, sys, zipfile, xml.etree.ElementTree as ET
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
with zipfile.ZipFile(sys.argv[1], "r") as z:
    root = ET.fromstring(z.read("word/document.xml"))
out = []
for p in root.findall(f".//{W}body/{W}p"):
    hl_segs, plain_segs = [], []
    for r in p.findall(f"{W}r"):
        t = "".join(x.text or "" for x in r.findall(f"{W}t"))
        if not t: continue
        rpr = r.find(f"{W}rPr")
        is_hl = rpr is not None and rpr.find(f"{W}highlight") is not None
        (hl_segs if is_hl else plain_segs).append(t)
    out.append({"hl": hl_segs, "plain": plain_segs})
print(json.dumps(out, ensure_ascii=False))
`;
      const insp = spawnSync("python3", ["-c", inspectPy, hlPath], { encoding: "utf8" });
      assert.equal(insp.status, 0, insp.stderr);
      const paras = JSON.parse(insp.stdout) as Array<{ hl: string[]; plain: string[] }>;

      // P0: no split Chinese words ("误差", "建立", "算得" must each be highlighted intact)
      assert.ok(paras[0]!.hl.includes("误差"), `expected whole word '误差' highlighted, got: ${JSON.stringify(paras[0])}`);
      assert.ok(paras[0]!.hl.includes("建立"), `expected whole word '建立' highlighted, got: ${JSON.stringify(paras[0])}`);
      assert.ok(paras[0]!.hl.includes("算得"), `expected whole word '算得' highlighted, got: ${JSON.stringify(paras[0])}`);
      assert.ok(paras[0]!.plain.some((s) => s.includes("未建模的大气差分路径延迟")), "unchanged text in P0 must remain unhighlighted");

      // P1: heavily rewritten clauses collapse into <= 3 clean yellow blocks (no 10+ zebra fragments, no split 载波频率/相反)
      assert.ok(paras[1]!.hl.length <= 3, `expected <= 3 clean blocks in rewritten P1, got ${paras[1]!.hl.length}: ${JSON.stringify(paras[1]!.hl)}`);
      assert.ok(paras[1]!.hl.some((s) => s.includes("载波频率")), `expected intact '载波频率' in P1, got: ${JSON.stringify(paras[1]!.hl)}`);
      assert.ok(paras[1]!.hl.some((s) => s.includes("相反")), `expected intact '相反' in P1, got: ${JSON.stringify(paras[1]!.hl)}`);

      // P2: newly added lead-in paragraph highlighted completely
      assert.deepEqual(paras[2]!.plain, []);
      assert.ok(paras[2]!.hl.join("").includes("新增的过渡说明段落"));

      // P4: aligned with base P3 ("式中，x 为路径残差。" stays unhighlighted!)
      assert.ok(paras[4]!.plain.some((s) => s.includes("式中，x 为路径残差。")), `expected aligned unchanged prefix in P4, got: ${JSON.stringify(paras[4])}`);
      assert.ok(paras[4]!.hl.some((s) => s.includes("补充误差预算分析")), `expected changed tail highlighted in P4, got: ${JSON.stringify(paras[4])}`);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("handles clause-splitting comma insert/delete accurately and stays fast on 20 long modified paragraphs (OCV5-875 R1 audit fix)", () => {
    const work = mkdtempSync(join(tmpdir(), "oc-docx-diff-comma-perf-"));
    try {
      // 1. Inserting ONLY one Chinese comma must highlight ONLY that exact comma (between 数据 and 并归档)
      const insBase = join(work, "ins-base.docx");
      const insRev = join(work, "ins-rev.docx");
      const insClean = join(work, "ins-clean.docx");
      const insHl = join(work, "ins-hl.docx");
      buildRealDocx(insBase, { paragraphs: ["实验人员记录全部原始数据并归档，等待复核。"] });
      buildRealDocx(insRev, { paragraphs: ["实验人员记录全部原始数据，并归档，等待复核。"] });
      const insRes = runPy(OC_DOCX, [
        "diff", "--base", insBase, "--revised", insRev,
        "--out-clean", insClean, "--out-highlighted", insHl, "--no-render-check",
      ]);
      assert.equal(insRes.status, 0, `${insRes.stdout}\n${insRes.stderr}`);
      const insRunsPy = `
import json, sys, zipfile, xml.etree.ElementTree as ET
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
with zipfile.ZipFile(sys.argv[1], "r") as z:
    root = ET.fromstring(z.read("word/document.xml"))
p = root.findall(f".//{W}body/{W}p")[0]
segs = []
for r in p.findall(f"{W}r"):
    t = "".join(x.text or "" for x in r.findall(f"{W}t"))
    if not t: continue
    rpr = r.find(f"{W}rPr")
    hl = rpr is not None and rpr.find(f"{W}highlight") is not None
    segs.append([hl, t])
print(json.dumps(segs, ensure_ascii=False))
`;
      const insSegs = JSON.parse(spawnSync("python3", ["-c", insRunsPy, insHl], { encoding: "utf8" }).stdout);
      assert.deepEqual(insSegs, [
        [false, "实验人员记录全部原始数据"],
        [true, "，"],
        [false, "并归档，等待复核。"],
      ]);

      // 2. Deleting ONLY one Chinese comma must produce ZERO yellow highlights
      const delClean = join(work, "del-clean.docx");
      const delHl = join(work, "del-hl.docx");
      const delRes = runPy(OC_DOCX, [
        "diff", "--base", insRev, "--revised", insBase,
        "--out-clean", delClean, "--out-highlighted", delHl, "--no-render-check",
      ]);
      assert.equal(delRes.status, 0, `${delRes.stdout}\n${delRes.stderr}`);
      const delSegs = JSON.parse(spawnSync("python3", ["-c", insRunsPy, delHl], { encoding: "utf8" }).stdout);
      assert.deepEqual(delSegs, [[false, "实验人员记录全部原始数据并归档，等待复核。"]]);

      // 2b. Greek / non-ASCII Unicode letters (α) must NOT cause highlight offset drift (OCV5-875 R2 audit fix)
      const alphaBase1 = join(work, "alpha1-base.docx");
      const alphaRev1 = join(work, "alpha1-rev.docx");
      const alphaHl1 = join(work, "alpha1-hl.docx");
      buildRealDocx(alphaBase1, { paragraphs: ["实验人员记录α组数据并归档，等待复核。"] });
      buildRealDocx(alphaRev1, { paragraphs: ["实验人员记录α组数据，并归档，等待复核。"] });
      const alphaRes1 = runPy(OC_DOCX, [
        "diff", "--base", alphaBase1, "--revised", alphaRev1,
        "--out-clean", join(work, "alpha1-clean.docx"), "--out-highlighted", alphaHl1, "--no-render-check",
      ]);
      assert.equal(alphaRes1.status, 0, `${alphaRes1.stdout}\n${alphaRes1.stderr}`);
      const alphaSegs1 = JSON.parse(spawnSync("python3", ["-c", insRunsPy, alphaHl1], { encoding: "utf8" }).stdout);
      assert.deepEqual(alphaSegs1, [
        [false, "实验人员记录α组数据"],
        [true, "，"],
        [false, "并归档，等待复核。"],
      ]);

      const alphaBase2 = join(work, "alpha2-base.docx");
      const alphaRev2 = join(work, "alpha2-rev.docx");
      const alphaHl2 = join(work, "alpha2-hl.docx");
      buildRealDocx(alphaBase2, { paragraphs: ["α组采集数据，测量电压12伏。"] });
      buildRealDocx(alphaRev2, { paragraphs: ["α组记录数据，测量电压15伏。"] });
      const alphaRes2 = runPy(OC_DOCX, [
        "diff", "--base", alphaBase2, "--revised", alphaRev2,
        "--out-clean", join(work, "alpha2-clean.docx"), "--out-highlighted", alphaHl2, "--no-render-check",
      ]);
      assert.equal(alphaRes2.status, 0, `${alphaRes2.stdout}\n${alphaRes2.stderr}`);
      const alphaSegs2 = JSON.parse(spawnSync("python3", ["-c", insRunsPy, alphaHl2], { encoding: "utf8" }).stdout);
      assert.deepEqual(alphaSegs2, [
        [false, "α组"],
        [true, "记录"],
        [false, "数据，测量电压"],
        [true, "15"],
        [false, "伏。"],
      ]);

      // 3. Performance bound: 20 long (~860-char) paragraphs each changing first word stays fast (<5s)
      const tail = " ".concat("experimental measurement calibration baseline atmospheric delay evaluation ".repeat(12)).trim();
      const perfBase = join(work, "perf-base.docx");
      const perfRev = join(work, "perf-rev.docx");
      buildRealDocx(perfBase, { paragraphs: Array.from({ length: 20 }, (_, i) => `Oldword${i} ${tail}`) });
      buildRealDocx(perfRev, { paragraphs: Array.from({ length: 20 }, (_, i) => `Newword${i} ${tail}`) });
      const t0 = Date.now();
      const perfRes = runPy(OC_DOCX, [
        "diff", "--base", perfBase, "--revised", perfRev,
        "--out-clean", join(work, "perf-clean.docx"),
        "--out-highlighted", join(work, "perf-hl.docx"),
        "--no-render-check",
      ]);
      const elapsedMs = Date.now() - t0;
      assert.equal(perfRes.status, 0, `${perfRes.stdout}\n${perfRes.stderr}`);
      assert.ok(elapsedMs < 5_000, `expected 20-paragraph diff to finish <5s, took ${elapsedMs}ms`);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe("oc-stylecheck (OCV5-865)", () => {
  test("detects dash overuse, ZH/EN AI clichés with line numbers, and --style-file custom terms on .docx and .md", () => {
    const work = mkdtempSync(join(tmpdir(), "oc-stylecheck-"));
    try {
      const styleFile = join(work, "STYLE.md");
      writeFileSync(
        styleFile,
        [
          "# 团队写作风格规范",
          "",
          "## 禁用词清单",
          "- `革命性突破`",
          "- 颠覆性范式",
          "禁用词: 降维打击, 闭环赋能",
        ].join("\n"),
        "utf8",
      );

      // 1. Real .docx with dashes, ZH/EN clichés, and custom banned terms
      const dirtyDocx = join(work, "dirty.docx");
      buildRealDocx(dirtyDocx, {
        paragraphs: [
          "本研究提出了一种稀疏注意力机制——它在长文本上表现稳健——并在三个数据集上进行了验证。",
          "值得注意的是，该方法实现了革命性突破，同时展现出降维打击的效果。",
          "In this section, we delve into the evolving landscape of retrieval systems.",
          "综上所述，本文实验充分验证了方案有效性——这为后续工作打下基础。",
        ],
      });

      const docxRes = runPy(OC_STYLECHECK, [dirtyDocx, "--style-file", styleFile, "--strict"]);
      assert.equal(docxRes.status, 1, "strict mode must return exit 1 when issues exist");
      const docxReport = JSON.parse(docxRes.stdout);
      assert.equal(docxReport.format, "docx");
      assert.equal(docxReport.passed, false);
      assert.equal(docxReport.dash_stats.warning, true);
      assert.ok(docxReport.dash_stats.count >= 3);

      const phrases = docxReport.cliche_hits.map((h: any) => h.phrase);
      assert.ok(phrases.includes("值得注意的是"));
      assert.ok(phrases.includes("综上所述"));
      assert.ok(phrases.includes("delve into"));
      assert.ok(phrases.includes("evolving landscape"));
      assert.ok(phrases.includes("革命性突破"));
      assert.ok(phrases.includes("降维打击"));

      const customHit = docxReport.cliche_hits.find((h: any) => h.phrase === "革命性突破");
      assert.equal(customHit.source, "custom");
      assert.equal(customHit.line, 2);

      // 2. Clean markdown passes strict mode with score 100
      const cleanMd = join(work, "clean.md");
      writeFileSync(
        cleanMd,
        [
          "# 稀疏注意力消融实验",
          "",
          "我们在 WikiText-103 与 LongBench 上对比了三种窗口大小（256、512、1024）。",
          "表 1 显示窗口为 512 时困惑度下降 1.8，推理延迟降低 24%。",
        ].join("\n"),
        "utf8",
      );
      const cleanRes = runPy(OC_STYLECHECK, [cleanMd, "--style-file", styleFile, "--strict"]);
      assert.equal(cleanRes.status, 0, cleanRes.stderr);
      const cleanReport = JSON.parse(cleanRes.stdout);
      assert.equal(cleanReport.passed, true);
      assert.equal(cleanReport.score, 100);
      assert.equal(cleanReport.cliche_hits.length, 0);
      assert.equal(cleanReport.dash_stats.warning, false);

      // 3. Plain .txt check
      const dirtyTxt = join(work, "draft.txt");
      writeFileSync(dirtyTxt, "First line clean.\nSecond line uses 颠覆性范式 and it is worth noting.\n", "utf8");
      const txtRes = runPy(OC_STYLECHECK, [dirtyTxt, "--style-file", styleFile]);
      assert.equal(txtRes.status, 0);
      const txtReport = JSON.parse(txtRes.stdout);
      assert.equal(txtReport.passed, false);
      assert.ok(txtReport.cliche_hits.some((h: any) => h.phrase === "颠覆性范式" && h.line === 2));
      assert.ok(txtReport.cliche_hits.some((h: any) => h.phrase === "it is worth noting" && h.line === 2));
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("catches Chinese engineering/research AI clichés and reports legitimate technical terms in advisory_hits without strict fail (OCV5-878)", () => {
    const work = mkdtempSync(join(tmpdir(), "oc-stylecheck-ocv5-878-"));
    try {
      // 1. Hard engineering/research AI clichés must fail --strict
      const aiCoinageMd = join(work, "ai-coinage.md");
      writeFileSync(
        aiCoinageMd,
        [
          "# 系统方案总结",
          "本架构实现了逻辑闭合与全链路闭环，完成工程兑现与价值兑现。",
          "方法通过多维协同与范式跃迁打通底层逻辑，提供了有力支撑。",
        ].join("\n"),
        "utf8",
      );
      const coinageRes = runPy(OC_STYLECHECK, [aiCoinageMd, "--strict"]);
      assert.equal(coinageRes.status, 1, "engineering AI clichés must fail strict mode");
      const coinageReport = JSON.parse(coinageRes.stdout);
      assert.equal(coinageReport.passed, false);
      const hardPhrases = coinageReport.cliche_hits.map((h: any) => h.phrase);
      for (const expected of ["逻辑闭合", "全链路闭环", "工程兑现", "价值兑现", "多维协同", "范式跃迁", "底层逻辑", "提供了有力支撑"]) {
        assert.ok(hardPhrases.includes(expected), `expected hard cliché hit '${expected}', got: ${JSON.stringify(hardPhrases)}`);
      }
      // 已被同行硬套话覆盖的 闭合/闭环/兑现 不重复刷入 advisory_hits
      assert.deepEqual(coinageReport.advisory_hits, []);

      // 2. Legitimate control-theory / math phrasing only triggers advisory_hits and passes --strict
      const techMd = join(work, "control-theory.md");
      writeFileSync(
        techMd,
        [
          "# 控制系统稳定性分析",
          "依据奈奎斯特稳定性判据，闭合回路在相位裕度大于 45 度时保持稳定。",
          "与基线相比，改进后的滤波器使输出信噪比显著提升 3.2 dB。",
        ].join("\n"),
        "utf8",
      );
      const techRes = runPy(OC_STYLECHECK, [techMd, "--strict"]);
      assert.equal(techRes.status, 0, `legitimate technical terms must pass strict mode: ${techRes.stdout}\n${techRes.stderr}`);
      const techReport = JSON.parse(techRes.stdout);
      assert.equal(techReport.passed, true);
      assert.equal(techReport.score, 100);
      assert.deepEqual(techReport.cliche_hits, []);
      const advPhrases = techReport.advisory_hits.map((h: any) => h.phrase);
      assert.ok(advPhrases.includes("判据"), `expected '判据' in advisory_hits, got: ${JSON.stringify(techReport.advisory_hits)}`);
      assert.ok(advPhrases.includes("闭合"), `expected '闭合' in advisory_hits, got: ${JSON.stringify(techReport.advisory_hits)}`);
      assert.ok(advPhrases.includes("显著提升"), `expected '显著提升' in advisory_hits, got: ${JSON.stringify(techReport.advisory_hits)}`);
      assert.ok(techReport.advisory_hits.every((h: any) => h.source === "advisory"));
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
