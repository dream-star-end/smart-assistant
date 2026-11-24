/**
 * OCV5-878 Module 1 integration & unit tests:
 *  1. `oc-docx extract` (OMML -> LaTeX lossless conversion, tables, footnotes, TOC, section slicing, max-chars)
 *  2. `oc-docx check` scientific paper static pre-checks (placeholders, cross-refs, symbol table, PDF punct loss)
 *  3. `oc-docx convert --metrics` & frontmatter `metrics:` single-source data binding (happy + fail-closed)
 *  4. `oc-docx diff` structure conservation metrics & `--strict-structure`
 *  5. `oc-web-context.py` `.docx` OMML extraction (`extractor: "oc_docx_omml"`) & missing-file fallback
 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const OC_DOCX = join(REPO_ROOT, 'packages/commercial/agent-sandbox/platform-runtime/bin/oc-docx.py')
const OC_WEB_CTX = join(REPO_ROOT, 'packages/commercial/agent-sandbox/platform-runtime/bin/oc-web-context.py')
const PAPER_QA_DIR = join(REPO_ROOT, 'packages/commercial/agent-sandbox/platform-runtime/entrypoint')
const PYTHON = process.env.PYTHON ?? '/usr/bin/python3'

function runPy(script: string, args: string[], env: NodeJS.ProcessEnv = {}, input?: string) {
  return spawnSync(PYTHON, [script, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    input,
    encoding: 'utf8',
  })
}

function hasTool(name: string): boolean {
  return spawnSync('which', [name], { encoding: 'utf8' }).status === 0
}

function hasPythonDocx(): boolean {
  return spawnSync(PYTHON, ['-c', 'from docx import Document'], { encoding: 'utf8' }).status === 0
}

function executable(path: string, body: string): void {
  writeFileSync(path, body)
  chmodSync(path, 0o755)
}

function makeFakeRenderBin(root: string, renderedText: string): string {
  const bin = join(root, 'fake-bin')
  mkdirSync(bin, { recursive: true })
  const txtFile = join(root, 'fake-rendered.txt')
  writeFileSync(txtFile, renderedText, 'utf8')
  const sofficeBody = [
    '#!/bin/bash',
    'set -e',
    'out=""',
    'src=""',
    'while [ "$#" -gt 0 ]; do',
    '  if [ "$1" = "--outdir" ]; then out="$2"; shift 2; continue; fi',
    '  src="$1"; shift',
    'done',
    '/bin/mkdir -p "$out"',
    'base="$(basename "$src" .docx)"',
    'printf "%s\\n" "%PDF-1.7" > "$out/${base}.pdf"',
    '',
  ].join('\n')
  executable(join(bin, 'soffice'), sofficeBody)
  executable(join(bin, 'libreoffice'), sofficeBody)
  executable(
    join(bin, 'pdftoppm'),
    [
      '#!/bin/bash',
      'set -e',
      'out="${@: -1}"',
      `${PYTHON} -c 'from PIL import Image; import sys; Image.new("RGB",(800,1000),"#224466").save(sys.argv[1]+"-1.png")' "$out"`,
      '',
    ].join('\n'),
  )
  executable(
    join(bin, 'pdftotext'),
    `#!/bin/bash\nout="\${@: -1}"\ncp "${txtFile}" "$out"\n`,
  )
  return `${bin}:${process.env.PATH ?? '/usr/bin'}`
}

function parseCheckStdout(stdout: string): { report: any; verdict: string } {
  const lines = stdout.trimEnd().split('\n')
  const verdict = lines[lines.length - 1] ?? ''
  const report = JSON.parse(lines.slice(0, -1).join('\n'))
  return { report, verdict }
}

function buildCustomDocx(outPath: string, spec: Record<string, unknown>): void {
  const py = `
import json, sys, zipfile
from io import BytesIO
from docx import Document
from docx.oxml import parse_xml

spec = json.loads(sys.argv[1])
out_path = sys.argv[2]
doc = Document()
for item in spec.get("items", []):
    kind = item["kind"]
    if kind == "heading":
        doc.add_heading(item["text"], level=int(item.get("level", 1)))
    elif kind == "p":
        p = doc.add_paragraph(item.get("text", ""))
        for xml_frag in item.get("omml", []):
            p._p.append(parse_xml(xml_frag))
        if item.get("tail"):
            p.add_run(item["tail"])
        if item.get("footnote_id"):
            p._p.append(parse_xml(
                f'<w:r xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
                f'<w:footnoteReference w:id="{item["footnote_id"]}"/></w:r>'
            ))
    elif kind == "table":
        rows = item["rows"]
        tbl = doc.add_table(rows=len(rows), cols=len(rows[0]))
        for r_i, row in enumerate(rows):
            for c_i, cell in enumerate(row):
                tbl.rows[r_i].cells[c_i].text = cell
buf = BytesIO()
doc.save(buf)
footnotes = spec.get("footnotes")
if not footnotes:
    with open(out_path, "wb") as f:
        f.write(buf.getvalue())
else:
    fn_items = "".join(
        f'<w:footnote w:id="{fid}"><w:p><w:r><w:t>{ftxt}</w:t></w:r></w:p></w:footnote>'
        for fid, ftxt in footnotes.items()
    )
    fn_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        + fn_items
        + '</w:footnotes>'
    )
    src = zipfile.ZipFile(BytesIO(buf.getvalue()), "r")
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as dst:
        for info in src.infolist():
            dst.writestr(info, src.read(info.filename))
        dst.writestr("word/footnotes.xml", fn_xml.encode("utf-8"))
`
  const res = spawnSync(PYTHON, ['-c', py, JSON.stringify(spec), outPath], { encoding: 'utf8' })
  assert.equal(res.status, 0, `buildCustomDocx failed: ${res.stderr}`)
}

const pythonDocxAvailable = hasPythonDocx()
const pandocAvailable = hasTool('pandoc')

describe('oc-docx paper QA loop (OCV5-878 Module 1)', { skip: !pythonDocxAvailable }, () => {
  test('extract --help exposes --latex and --section; lossless OMML->LaTeX, tables, footnotes, TOC, section slicing, max-chars', () => {
    const help = runPy(OC_DOCX, ['extract', '--help'])
    assert.equal(help.status, 0, help.stderr)
    assert.match(help.stdout, /--latex/)
    assert.match(help.stdout, /--section/)

    const work = mkdtempSync(join(tmpdir(), 'oc-docx-extract-'))
    try {
      const M_NS = 'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"'
      const docxPath = join(work, 'paper.docx')
      buildCustomDocx(docxPath, {
        items: [
          { kind: 'heading', level: 1, text: '1. 引言' },
          {
            kind: 'p',
            text: '共轭信号 ',
            omml: [
              `<m:oMath ${M_NS}><m:sSup><m:e><m:r><m:t>z</m:t></m:r></m:e><m:sup><m:r><m:t>*</m:t></m:r></m:sup></m:sSup><m:r><m:t>+</m:t></m:r><m:sSup><m:e><m:r><m:t>H</m:t></m:r></m:e><m:sup><m:r><m:t>†</m:t></m:r></m:sup></m:sSup></m:oMath>`,
            ],
            tail: ' 满足守恒律。',
            footnote_id: '1',
          },
          { kind: 'heading', level: 2, text: '1.1 数学模型' },
          {
            kind: 'p',
            text: '',
            omml: [
              `<m:oMathPara ${M_NS}><m:oMath>` +
                `<m:acc><m:accPr><m:chr m:val="\u0302"/></m:accPr><m:e><m:r><m:t>y</m:t></m:r></m:e></m:acc>` +
                `<m:r><m:t>=</m:t></m:r>` +
                `<m:f><m:num><m:r><m:t>1</m:t></m:r></m:num><m:den><m:r><m:t>n</m:t></m:r></m:den></m:f>` +
                `<m:nary><m:naryPr><m:chr m:val="∑"/></m:naryPr>` +
                `<m:sub><m:r><m:t>i=1</m:t></m:r></m:sub><m:sup><m:r><m:t>n</m:t></m:r></m:sup>` +
                `<m:e><m:rad><m:deg><m:r><m:t>3</m:t></m:r></m:deg><m:e><m:sSub><m:e><m:r><m:t>x</m:t></m:r></m:e><m:sub><m:r><m:t>i</m:t></m:r></m:sub></m:sSub></m:e></m:rad></m:e></m:nary>` +
                `<m:r><m:t>+</m:t></m:r>` +
                `<m:bar><m:barPr><m:pos m:val="top"/></m:barPr><m:e><m:r><m:t>α</m:t></m:r></m:e></m:bar>` +
                `<m:r><m:t>+</m:t></m:r>` +
                `<m:func><m:fName><m:r><m:t>sin</m:t></m:r></m:fName><m:e><m:d><m:e><m:r><m:t>θ</m:t></m:r></m:e></m:d></m:e></m:func>` +
                `<m:r><m:t>+</m:t></m:r>` +
                `<m:d><m:dPr><m:begChr m:val="("/><m:endChr m:val=")"/></m:dPr><m:e><m:m>` +
                `<m:mr><m:e><m:r><m:t>a</m:t></m:r></m:e><m:e><m:r><m:t>b</m:t></m:r></m:e></m:mr>` +
                `<m:mr><m:e><m:r><m:t>c</m:t></m:r></m:e><m:e><m:r><m:t>d</m:t></m:r></m:e></m:mr>` +
                `</m:m></m:e></m:d>` +
                `<m:r><m:t>+</m:t></m:r>` +
                `<m:sPre><m:sub><m:r><m:t>p</m:t></m:r></m:sub><m:sup><m:r><m:t>q</m:t></m:r></m:sup><m:e><m:r><m:t>F</m:t></m:r></m:e></m:sPre>` +
                `<m:r><m:t>+</m:t></m:r>` +
                `<m:limLow><m:e><m:r><m:t>lim</m:t></m:r></m:e><m:lim><m:r><m:t>k→∞</m:t></m:r></m:lim></m:limLow>` +
                `<m:groupChr><m:groupChrPr><m:chr m:val="⏟"/><m:pos m:val="bot"/></m:groupChrPr><m:e><m:r><m:t>u+v</m:t></m:r></m:e></m:groupChr>` +
                `</m:oMath></m:oMathPara>`,
            ],
            tail: ' (1)',
          },
          { kind: 'heading', level: 1, text: '2. 实验结果' },
          {
            kind: 'table',
            rows: [
              ['方法', 'RMSE'],
              ['本文方法', '0.12'],
            ],
          },
        ],
        footnotes: { '1': '这是第一条脚注说明。' },
      })

      const fullRes = runPy(OC_DOCX, ['extract', docxPath, '--latex', '--json'])
      assert.equal(fullRes.status, 0, fullRes.stderr)
      const full = JSON.parse(fullRes.stdout)
      assert.equal(full.total_sections, 3)
      assert.equal(full.total_tables, 1)
      assert.ok(full.total_formulas >= 2)
      assert.equal(full.footnote_count, 1)
      const md: string = full.markdown
      assert.ok(md.includes('<!-- P001 -->'), 'must emit paragraph anchors')
      assert.ok(md.includes('# 1. 引言'))
      assert.ok(md.includes('## 1.1 数学模型'))
      assert.ok(md.includes('z^{*}') || md.includes('z^*'), `conjugate * lost: ${md}`)
      assert.ok(md.includes('\\dagger'), `conjugate † lost: ${md}`)
      assert.ok(md.includes('\\hat{y}'), `acc hat lost: ${md}`)
      assert.ok(md.includes('\\frac{1}{n}'), `frac lost: ${md}`)
      assert.ok(md.includes('\\sum_{i=1}^{n}'), `nary sum lost: ${md}`)
      assert.ok(md.includes('\\sqrt[3]{x_{i}}'), `rad/sSub lost: ${md}`)
      assert.ok(md.includes('\\overline{\\alpha}'), `bar/greek lost: ${md}`)
      assert.ok(md.includes('\\sin(\\theta)'), `func lost: ${md}`)
      assert.ok(md.includes('\\begin{pmatrix}a & b \\\\ c & d\\end{pmatrix}'), `matrix lost: ${md}`)
      assert.ok(md.includes('{}_{p}^{q}F'), `sPre lost: ${md}`)
      assert.ok(md.includes('\\lim_{k\\to \\infty}') || md.includes('\\lim_{k\\to\\infty}'), `limLow lost: ${md}`)
      assert.ok(md.includes('\\underbrace{u+v}'), `groupChr lost: ${md}`)
      assert.ok(md.includes('| 方法 | RMSE |'), `table lost: ${md}`)
      assert.ok(md.includes('[^1]: 这是第一条脚注说明。'), `footnote lost: ${md}`)

      // --no-latex readable mode still preserves conjugates
      const noLatex = runPy(OC_DOCX, ['extract', docxPath, '--no-latex'])
      assert.equal(noLatex.status, 0, noLatex.stderr)
      assert.ok(noLatex.stdout.includes('z^*') && noLatex.stdout.includes('H^†'))
      assert.equal(noLatex.stdout.includes('$$'), false)

      // --toc mode
      const tocRes = runPy(OC_DOCX, ['extract', docxPath, '--toc', '--json'])
      assert.equal(tocRes.status, 0, tocRes.stderr)
      const tocJson = JSON.parse(tocRes.stdout)
      assert.equal(tocJson.toc_only, true)
      assert.equal(tocJson.toc.length, 3)
      assert.equal(tocJson.toc[0].title, '1. 引言')
      assert.equal(tocJson.toc[2].table_count, 1)

      // --section slicing by keyword and index
      const secRes = runPy(OC_DOCX, ['extract', docxPath, '--section', '实验结果'])
      assert.equal(secRes.status, 0, secRes.stderr)
      assert.ok(secRes.stdout.includes('# 2. 实验结果'))
      assert.ok(secRes.stdout.includes('0.12'))
      assert.equal(secRes.stdout.includes('# 1. 引言'), false)

      const secIdxRes = runPy(OC_DOCX, ['extract', docxPath, '--section', '2'])
      assert.equal(secIdxRes.status, 0, secIdxRes.stderr)
      assert.ok(secIdxRes.stdout.includes('## 1.1 数学模型'))
      assert.equal(secIdxRes.stdout.includes('# 2. 实验结果'), false)

      const missingSec = runPy(OC_DOCX, ['extract', docxPath, '--section', '不存在的章节'])
      assert.notEqual(missingSec.status, 0)

      // --max-chars truncation
      const truncRes = runPy(OC_DOCX, ['extract', docxPath, '--max-chars', '60', '--json'])
      assert.equal(truncRes.status, 0, truncRes.stderr)
      const truncJson = JSON.parse(truncRes.stdout)
      assert.equal(truncJson.truncated, true)
      assert.equal(truncJson.markdown.length, 60)

      // Pandoc round-trip with real complex formulas
      if (pandocAvailable) {
        const srcMd = join(work, 'pandoc-roundtrip.md')
        const outDocx = join(work, 'pandoc-roundtrip.docx')
        writeFileSync(
          srcMd,
          '# Formula Test\n\nInline conjugate $z^* + \\tilde{\\alpha} + \\vec{v} + \\dot{x} + \\ddot{y}$ and display:\n\n$$\n\\int_{0}^{\\infty} \\frac{\\Delta\\phi}{1 + x^2} dx\n$$\n',
          'utf8',
        )
        const conv = runPy(OC_DOCX, ['convert', srcMd, '--no-reference-doc', '-o', outDocx])
        assert.equal(conv.status, 0, conv.stderr)
        const ext = runPy(OC_DOCX, ['extract', outDocx, '--latex'])
        assert.equal(ext.status, 0, ext.stderr)
        assert.ok(ext.stdout.includes('*'), `Pandoc conjugate * lost: ${ext.stdout}`)
        assert.ok(ext.stdout.includes('\\int') && ext.stdout.includes('\\frac'), `Pandoc int/frac lost: ${ext.stdout}`)
        assert.ok(ext.stdout.includes('\\Delta') && ext.stdout.includes('\\phi'), `Pandoc Greek lost: ${ext.stdout}`)
      }
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  test('check catches unresolved placeholders, broken cross-refs, symbol table warnings, and PDF punctuation loss without false positives', () => {
    const work = mkdtempSync(join(tmpdir(), 'oc-docx-paper-check-'))
    try {
      const M_NS = 'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"'

      // 1. Placeholders in body, table, and footnote -> FAIL; --no-paper-check -> PASS
      const dirtyDocx = join(work, 'placeholders.docx')
      buildCustomDocx(dirtyDocx, {
        items: [
          { kind: 'heading', level: 1, text: '1. 概述' },
          { kind: 'p', text: '此处结果 [需核查] 且存在 TODO: 补齐数据 与 {{metric:acc.val}}。', footnote_id: '1' },
          { kind: 'p', text: '另一处 [[claim:c99]] 需要 FIXME 处理。' },
          { kind: 'table', rows: [['指标', '值'], ['精度', '[待补充]']] },
        ],
        footnotes: { '1': '脚注里的 [待核查] 也要检出。' },
      })
      const fakePath = makeFakeRenderBin(work, 'Hello E=mc^2\n')
      const dirtyCheck = runPy(OC_DOCX, ['check', dirtyDocx], { OC_DOCXCHECK: 'on', PATH: fakePath })
      assert.equal(dirtyCheck.status, 1)
      const { report: dirtyRep, verdict: dirtyVerdict } = parseCheckStdout(dirtyCheck.stdout)
      assert.equal(dirtyVerdict, 'FAIL')
      const phFailures = dirtyRep.failures.filter((f: any) => f.code === 'unresolved-placeholder')
      assert.ok(phFailures.length >= 7, `expected >=7 placeholder failures, got ${phFailures.length}: ${JSON.stringify(phFailures)}`)

      const skipCheck = runPy(OC_DOCX, ['check', dirtyDocx, '--no-paper-check'], { OC_DOCXCHECK: 'on', PATH: fakePath })
      assert.equal(skipCheck.status, 0, skipCheck.stdout)

      // 2. Clean cross-refs + year (2024) + symbol table -> PASS with structured symbol_table
      const cleanPaper = join(work, 'clean-paper.docx')
      buildCustomDocx(cleanPaper, {
        items: [
          { kind: 'heading', level: 1, text: '1. 方法' },
          { kind: 'p', text: '如图 1 所示，表 1 汇总了 2024 年 (2024) 的对比结果，参见式(1)与文献 [1-2]。' },
          { kind: 'p', text: '图 1：整体架构示意图' },
          { kind: 'p', text: '表 1：主要实验指标' },
          { kind: 'table', rows: [['模型', '分数'], ['Ours', '95.2']] },
          {
            kind: 'p',
            text: '',
            omml: [`<m:oMath ${M_NS}><m:r><m:t>y=αx+β</m:t></m:r></m:oMath>`],
            tail: ' (1)',
          },
          {
            kind: 'p',
            text: '其中 ',
            omml: [`<m:oMath ${M_NS}><m:r><m:t>x</m:t></m:r></m:oMath>`],
            tail: ' 为输入向量，α 为缩放因子。',
          },
          {
            kind: 'p',
            text: '重复使用未定义符号：',
            omml: [
              `<m:oMath ${M_NS}><m:r><m:t>β+β+β</m:t></m:r></m:oMath>`,
            ],
          },
          { kind: 'p', text: '其中 y 表示预测输出。后文又记 y 表示残差方差。' },
          { kind: 'heading', level: 1, text: '参考文献' },
          { kind: 'p', text: '[1] Author A. Paper One, 2024.' },
          { kind: 'p', text: '[2] Author B. Paper Two, 2024.' },
        ],
      })
      const cleanCheck = runPy(OC_DOCX, ['check', cleanPaper], { OC_DOCXCHECK: 'on', PATH: fakePath })
      assert.equal(cleanCheck.status, 0, `${cleanCheck.stdout}\n${cleanCheck.stderr}`)
      const { report: cleanRep, verdict: cleanVerdict } = parseCheckStdout(cleanCheck.stdout)
      assert.equal(cleanVerdict, 'PASS')
      assert.ok(cleanRep.paper_qa.symbol_table.total_symbols >= 3)
      assert.ok(cleanRep.paper_qa.symbol_table.defined_symbols.x)
      assert.ok(cleanRep.paper_qa.symbol_table.undefined_high_freq_symbols.includes('β'))
      assert.ok(
        cleanRep.paper_qa.symbol_table.possible_conflict_symbols.some((c: any) => c.symbol === 'y'),
        `expected symbol conflict on y: ${JSON.stringify(cleanRep.paper_qa.symbol_table)}`,
      )
      assert.deepEqual(cleanRep.paper_qa.pdf_punctuation_loss, [], 'fake pdftotext without anchor must NOT false-positive')

      // 3. Broken cross-refs + duplicate caption + gap + uncited caption
      const brokenRefDocx = join(work, 'broken-refs.docx')
      buildCustomDocx(brokenRefDocx, {
        items: [
          { kind: 'heading', level: 1, text: '1. 分析' },
          { kind: 'p', text: '见图 7 与 Table 9，代入 Eq. (5) 并参考 [8]。' },
          { kind: 'p', text: '图 1：第一张图' },
          { kind: 'p', text: '图 1：重复编号图' },
          { kind: 'p', text: '图 3：跳号且未引用图' },
          { kind: 'p', text: 'Table 1: Baseline' },
          {
            kind: 'p',
            text: '',
            omml: [`<m:oMath ${M_NS}><m:r><m:t>E=mc^2</m:t></m:r></m:oMath>`],
            tail: ' (1)',
          },
          { kind: 'heading', level: 1, text: 'References' },
          { kind: 'p', text: '[1] Ref One.' },
        ],
      })
      const brokenCheck = runPy(OC_DOCX, ['check', brokenRefDocx], { OC_DOCXCHECK: 'on', PATH: fakePath })
      assert.equal(brokenCheck.status, 1)
      const { report: brokenRep } = parseCheckStdout(brokenCheck.stdout)
      const brokenCats = new Set(
        brokenRep.paper_qa.failures
          .filter((f: any) => f.code === 'broken-cross-ref')
          .map((f: any) => f.category),
      )
      assert.ok(brokenCats.has('figure') && brokenCats.has('table') && brokenCats.has('equation') && brokenCats.has('reference'))
      const warnCodes = new Set(brokenRep.paper_qa.warnings.map((w: any) => w.code))
      assert.ok(warnCodes.has('duplicate-caption-number'))
      assert.ok(warnCodes.has('caption-number-gap'))
      assert.ok(warnCodes.has('uncited-caption'))

      // 4. Rendered PDF end-of-paragraph Chinese punctuation loss detection
      const punctDocx = join(work, 'punct.docx')
      const longPara = '本研究通过全链路数值仿真系统评估了多频载波相位误差抑制效果。'
      buildCustomDocx(punctDocx, {
        items: [{ kind: 'p', text: longPara }],
      })
      // Missing trailing period in rendered PDF text
      const droppedPath = makeFakeRenderBin(join(work, 'drop'), longPara.slice(0, -1) + '\n下一段文本\n')
      const dropRes = runPy(OC_DOCX, ['check', punctDocx], { OC_DOCXCHECK: 'on', PATH: droppedPath })
      assert.equal(dropRes.status, 0, dropRes.stdout)
      const { report: dropRep } = parseCheckStdout(dropRes.stdout)
      assert.equal(dropRep.paper_qa.pdf_punctuation_loss.length, 1)
      assert.equal(dropRep.paper_qa.pdf_punctuation_loss[0].expected_punct, '。')
      assert.ok(dropRep.paper_qa.warnings.some((w: any) => w.code === 'render-punctuation-loss'))

      // Intact trailing period in rendered PDF text -> zero hits
      const intactPath = makeFakeRenderBin(join(work, 'intact'), longPara + '\n下一段文本\n')
      const intactRes = runPy(OC_DOCX, ['check', punctDocx], { OC_DOCXCHECK: 'on', PATH: intactPath })
      assert.equal(intactRes.status, 0, intactRes.stdout)
      const { report: intactRep } = parseCheckStdout(intactRes.stdout)
      assert.deepEqual(intactRep.paper_qa.pdf_punctuation_loss, [])
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  test('metrics single-source binding expands via --metrics and frontmatter, skips fenced code, and fails closed on errors', () => {
    const work = mkdtempSync(join(tmpdir(), 'oc-docx-metrics-'))
    try {
      const metricsPath = join(work, 'metrics.json')
      writeFileSync(
        metricsPath,
        JSON.stringify({
          exp: { acc: 0.9234, loss: 0.12345, ratio: 0.876, samples: 1200, name: 'v2' },
          bad_null: null,
          bad_nan: 'NaN',
          bad_inf: 'Inf',
          arr: [10, 20],
        }),
        'utf8',
      )

      // Direct Python unit checks for expand_metrics_text & fail-closed cases
      const pyTest = `
import sys, math
sys.path.insert(0, ${JSON.stringify(PAPER_QA_DIR)})
import oc_docx_paper_qa as qa

data = {
    "exp": {"acc": 0.9234, "loss": 0.12345, "ratio": 0.876, "label": "ok"},
    "arr": [10, 20],
    "bad_null": None,
    "bad_nan": float("nan"),
    "bad_inf": float("inf"),
}
src = """# Report
Name={{metric:exp.label}}, Loss={{metric:exp.loss|.2f}}, Acc={{metric:exp.acc|fmt:.2%}}, Pct={{metric:exp.ratio|scale:100|.1f}}%, First={{metric:arr.0}}.

\`\`\`markdown
Example syntax should NOT expand: {{metric:nonexistent.key}}
\`\`\`
"""
out = qa.expand_metrics_text(src, data)
assert "Name=ok" in out, out
assert "Loss=0.12" in out, out
assert "Acc=92.34%" in out, out
assert "Pct=87.6%" in out, out
assert "First=10." in out, out
assert "{{metric:nonexistent.key}}" in out, out

for bad in [
    "{{metric:missing.key}}",
    "{{metric:bad_null}}",
    "{{metric:bad_nan}}",
    "{{metric:bad_inf}}",
    "{{metric:arr.5}}",
    "{{metric:exp.loss|badmod:1}}",
    "{{metric:exp.loss|invalid_fmt_xyz}}",
]:
    try:
        qa.expand_metrics_text(bad, data)
    except ValueError:
        pass
    else:
        raise AssertionError(f"expected ValueError for {bad}")
print("METRICS_UNIT_OK")
`
      const pyRes = spawnSync(PYTHON, ['-c', pyTest], { encoding: 'utf8' })
      assert.equal(pyRes.status, 0, pyRes.stderr)
      assert.match(pyRes.stdout, /METRICS_UNIT_OK/)

      if (pandocAvailable) {
        // End-to-end convert with --metrics (source file untouched!)
        const mdPath = join(work, 'paper.md')
        const docxOut = join(work, 'paper.docx')
        const rawMd = [
          '# 实验结果',
          '',
          '模型 {{metric:exp.name}} 损失为 {{metric:exp.loss|.2f}}，准确率 {{metric:exp.acc|fmt:.2%}}，增益 {{metric:exp.ratio|scale:100|.1f}}%。',
          '',
          '```',
          '示例占位符不展开：{{metric:not_real.key}}',
          '```',
          '',
        ].join('\n')
        writeFileSync(mdPath, rawMd, 'utf8')
        const conv = runPy(OC_DOCX, ['convert', mdPath, '--no-reference-doc', '--metrics', metricsPath, '-o', docxOut])
        assert.equal(conv.status, 0, conv.stderr)
        // Source markdown must remain unmodified
        assert.equal(readFileSync(mdPath, 'utf8'), rawMd)
        const extracted = runPy(OC_DOCX, ['extract', docxOut])
        assert.equal(extracted.status, 0, extracted.stderr)
        assert.ok(extracted.stdout.includes('模型 v2 损失为 0.12，准确率 92.34%，增益 87.6%'))
        assert.ok(extracted.stdout.includes('{{metric:not_real.key}}'))

        // Frontmatter relative metrics path
        mkdirSync(join(work, 'sub'), { recursive: true })
        writeFileSync(join(work, 'sub', 'sim.json'), JSON.stringify({ snr: 18.56 }), 'utf8')
        const fmMd = join(work, 'fm.md')
        const fmDocx = join(work, 'fm.docx')
        writeFileSync(fmMd, '---\ntitle: Test\nmetrics: sub/sim.json\n---\n\nSNR = {{metric:snr|.1f}} dB.\n', 'utf8')
        const fmConv = runPy(OC_DOCX, ['convert', fmMd, '--no-reference-doc', '-o', fmDocx])
        assert.equal(fmConv.status, 0, fmConv.stderr)
        const fmExt = runPy(OC_DOCX, ['extract', fmDocx])
        assert.ok(fmExt.stdout.includes('SNR = 18.6 dB.'))

        // Fail-closed: missing key via CLI -> non-zero exit
        const badMd = join(work, 'bad.md')
        writeFileSync(badMd, 'Value = {{metric:exp.does_not_exist}}.\n', 'utf8')
        const badConv = runPy(OC_DOCX, ['convert', badMd, '--no-reference-doc', '--metrics', metricsPath, '-o', join(work, 'bad.docx')])
        assert.notEqual(badConv.status, 0)

        // Fail-closed: frontmatter path traversal -> non-zero exit
        const escMd = join(work, 'sub', 'escape.md')
        writeFileSync(escMd, '---\nmetrics: ../metrics.json\n---\n\nValue = {{metric:exp.loss}}.\n', 'utf8')
        const escConv = runPy(OC_DOCX, ['convert', escMd, '--no-reference-doc', '-o', join(work, 'sub', 'escape.docx')])
        assert.notEqual(escConv.status, 0)
      }
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  test('oc-docx diff reports structure_conservation warnings and enforces --strict-structure', () => {
    const work = mkdtempSync(join(tmpdir(), 'oc-docx-struct-diff-'))
    try {
      const M_NS = 'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"'
      const basePath = join(work, 'base.docx')
      const shrunkPath = join(work, 'shrunk.docx')
      const conservedPath = join(work, 'conserved.docx')

      buildCustomDocx(basePath, {
        items: [
          { kind: 'heading', level: 1, text: '1. 引言' },
          { kind: 'p', text: '图 1：系统框图' },
          { kind: 'p', text: '表 1：实验参数' },
          { kind: 'table', rows: [['A', 'B', 'C'], ['1', '2', '3']] },
          { kind: 'p', text: '', omml: [`<m:oMath ${M_NS}><m:r><m:t>x=1</m:t></m:r></m:oMath>`] },
          { kind: 'p', text: '', omml: [`<m:oMath ${M_NS}><m:r><m:t>y=2</m:t></m:r></m:oMath>`] },
          { kind: 'heading', level: 1, text: '参考文献' },
          { kind: 'p', text: '[1] Ref 1.' },
          { kind: 'p', text: '[2] Ref 2.' },
        ],
      })

      buildCustomDocx(shrunkPath, {
        items: [
          { kind: 'heading', level: 1, text: '1. 引言' },
          { kind: 'p', text: '表 1：实验参数' },
          { kind: 'table', rows: [['A', 'B'], ['1', '2']] },
          { kind: 'p', text: '', omml: [`<m:oMath ${M_NS}><m:r><m:t>x=1</m:t></m:r></m:oMath>`] },
          { kind: 'heading', level: 1, text: '参考文献' },
          { kind: 'p', text: '[1] Ref 1.' },
        ],
      })

      buildCustomDocx(conservedPath, {
        items: [
          { kind: 'heading', level: 1, text: '1. 引言（修订）' },
          { kind: 'p', text: '图 1：系统框图' },
          { kind: 'p', text: '表 1：实验参数' },
          { kind: 'table', rows: [['A', 'B', 'C'], ['1', '2', '4']] },
          { kind: 'p', text: '', omml: [`<m:oMath ${M_NS}><m:r><m:t>x=1</m:t></m:r></m:oMath>`] },
          { kind: 'p', text: '', omml: [`<m:oMath ${M_NS}><m:r><m:t>y=3</m:t></m:r></m:oMath>`] },
          { kind: 'heading', level: 1, text: '参考文献' },
          { kind: 'p', text: '[1] Ref 1.' },
          { kind: 'p', text: '[2] Ref 2.' },
        ],
      })

      // Default mode: shrunk structure produces warnings but does not break existing diff exit 0
      const defRes = runPy(OC_DOCX, [
        'diff', '--base', basePath, '--revised', shrunkPath,
        '--out-clean', join(work, 'c1.docx'), '--out-highlighted', join(work, 'h1.docx'),
        '--no-render-check',
      ])
      assert.equal(defRes.status, 0, defRes.stderr)
      const defRep = JSON.parse(defRes.stdout)
      assert.equal(defRep.passed, true)
      assert.equal(defRep.structure_conservation.passed, false)
      assert.equal(defRep.structure_conservation.deltas.omml_count, -1)
      assert.equal(defRep.structure_conservation.deltas.figure_captions, -1)
      assert.equal(defRep.structure_conservation.deltas.references, -1)
      assert.ok(defRep.structure_conservation.warnings.some((w: string) => w.includes('columns decreased')))

      // --strict-structure turns structural loss into passed=false exit 1
      const strictFail = runPy(OC_DOCX, [
        'diff', '--base', basePath, '--revised', shrunkPath,
        '--out-clean', join(work, 'c2.docx'), '--out-highlighted', join(work, 'h2.docx'),
        '--no-render-check', '--strict-structure',
      ])
      assert.equal(strictFail.status, 1)
      const strictFailRep = JSON.parse(strictFail.stdout)
      assert.equal(strictFailRep.passed, false)
      assert.equal(strictFailRep.structure_conservation.passed, false)

      // Conserved structure passes --strict-structure
      const strictPass = runPy(OC_DOCX, [
        'diff', '--base', basePath, '--revised', conservedPath,
        '--out-clean', join(work, 'c3.docx'), '--out-highlighted', join(work, 'h3.docx'),
        '--no-render-check', '--strict-structure',
      ])
      assert.equal(strictPass.status, 0, strictPass.stdout)
      const strictPassRep = JSON.parse(strictPass.stdout)
      assert.equal(strictPassRep.passed, true)
      assert.equal(strictPassRep.structure_conservation.passed, true)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  test('oc-web-context parses .docx via oc_docx_omml preserving OMML formulas and keeps missing.pdf fallback', () => {
    const work = mkdtempSync(join(tmpdir(), 'oc-web-ctx-docx-'))
    try {
      const M_NS = 'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"'
      const docxPath = join(work, 'formula.docx')
      buildCustomDocx(docxPath, {
        items: [
          { kind: 'heading', level: 1, text: 'Signal Model' },
          {
            kind: 'p',
            text: 'Conjugate power ',
            omml: [
              `<m:oMath ${M_NS}><m:f><m:num><m:sSup><m:e><m:r><m:t>z</m:t></m:r></m:e><m:sup><m:r><m:t>*</m:t></m:r></m:sup></m:sSup></m:num><m:den><m:r><m:t>N</m:t></m:r></m:den></m:f></m:oMath>`,
            ],
          },
        ],
      })

      const res = runPy(
        OC_WEB_CTX,
        [],
        { OPENCLAUDE_WEB_CONTEXT_ROOT: join(work, 'empty-webctx') },
        JSON.stringify({ op: 'parse_document_file', file_path: docxPath, kind: 'docx' }),
      )
      assert.equal(res.status, 0, res.stderr)
      const out = JSON.parse(res.stdout)
      assert.equal(out.ok, true)
      assert.equal(out.extractor, 'oc_docx_omml')
      assert.ok(out.markdown.includes('\\frac{z^{*}}{N}') || out.markdown.includes('\\frac{z^*}{N}'), out.markdown)
      assert.ok(out.formulas >= 1)

      // Existing missing.pdf probe falls back to MARK_PY and reports python env missing
      const missingRes = runPy(
        OC_WEB_CTX,
        [],
        { OPENCLAUDE_WEB_CONTEXT_ROOT: join(work, 'empty-webctx') },
        JSON.stringify({ op: 'parse_document_file', file_path: '/tmp/missing.pdf', kind: 'pdf' }),
      )
      assert.equal(missingRes.status, 0, missingRes.stderr)
      const missingOut = JSON.parse(missingRes.stdout)
      assert.equal(missingOut.ok, false)
      assert.match(missingOut.error, /python env missing/)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  test('auditor T2 regression: security bounds (#1 #2), Quarto include/EXDEV (#3), LaTeX & hyperlink fidelity (#7), ZH ref boundary (#8), helper-missing degradation (#9)', () => {
    const work = mkdtempSync(join(tmpdir(), 'oc-docx-t2-fixes-'))
    try {
      const M_NS = 'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"'

      // --- #1: Frontmatter absolute path & symlink outside source_dir MUST be rejected ---
      const outsideJson = join(work, 'outside.json')
      writeFileSync(outsideJson, JSON.stringify({ secret: 42 }), 'utf8')
      const paperDir = join(work, 'paper-dir')
      mkdirSync(paperDir, { recursive: true })
      const absFmMd = join(paperDir, 'abs-fm.md')
      writeFileSync(absFmMd, `---\nmetrics: ${outsideJson}\n---\n\nVal={{metric:secret}}\n`, 'utf8')
      const absRes = spawnSync(
        PYTHON,
        [
          '-c',
          `import sys; sys.path.insert(0, ${JSON.stringify(PAPER_QA_DIR)}); import oc_docx_paper_qa as qa; qa.resolve_metrics_path(${JSON.stringify(absFmMd)})`,
        ],
        { encoding: 'utf8' },
      )
      assert.notEqual(absRes.status, 0)
      assert.match(absRes.stderr, /frontmatter metrics path must stay within source directory/)

      const linkPath = join(paperDir, 'escape-link.json')
      symlinkSync(outsideJson, linkPath)
      const symFmMd = join(paperDir, 'sym-fm.md')
      writeFileSync(symFmMd, '---\nmetrics: escape-link.json\n---\n\nVal={{metric:secret}}\n', 'utf8')
      const symRes = spawnSync(
        PYTHON,
        [
          '-c',
          `import sys; sys.path.insert(0, ${JSON.stringify(PAPER_QA_DIR)}); import oc_docx_paper_qa as qa; qa.resolve_metrics_path(${JSON.stringify(symFmMd)})`,
        ],
        { encoding: 'utf8' },
      )
      assert.notEqual(symRes.status, 0)
      assert.match(symRes.stderr, /frontmatter metrics path must stay within source directory/)

      // Explicit CLI --metrics to outside path remains allowed
      const cliOk = spawnSync(
        PYTHON,
        [
          '-c',
          `import sys; sys.path.insert(0, ${JSON.stringify(PAPER_QA_DIR)}); import oc_docx_paper_qa as qa; p = qa.resolve_metrics_path(${JSON.stringify(absFmMd)}, ${JSON.stringify(outsideJson)}); assert str(p) == ${JSON.stringify(outsideJson)}`,
        ],
        { encoding: 'utf8' },
      )
      assert.equal(cliOk.status, 0, cliOk.stderr)

      // --- #2: Bounded ZIP bomb fail-closed (no MarkItDown fallback), O(K log K) gap, format width bomb ---
      const bombDocx = join(work, 'bomb.docx')
      const buildBomb = spawnSync(
        PYTHON,
        [
          '-c',
          [
            'import sys, zipfile',
            'big = "<w:document xmlns:w=\\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\\"><w:body><w:p><w:r><w:t>" + ("A" * (33 * 1024 * 1024)) + "</w:t></w:r></w:p></w:body></w:document>"',
            'with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as z:',
            '    z.writestr("word/document.xml", big.encode("utf-8"))',
          ].join('\n'),
          bombDocx,
        ],
        { encoding: 'utf8' },
      )
      assert.equal(buildBomb.status, 0, buildBomb.stderr)

      // Fake markenv that MUST NOT be called when bomb triggers DocxResourceLimitError
      const fakeWebRoot = join(work, 'webctx-root')
      mkdirSync(join(fakeWebRoot, 'markenv', 'bin'), { recursive: true })
      const markMarker = join(work, 'mark-called.txt')
      executable(
        join(fakeWebRoot, 'markenv', 'bin', 'python'),
        `#!/bin/bash\necho "CALLED" > "${markMarker}"\nprintf '{"ok":true,"extractor":"markitdown","markdown":"legacy","chars":6,"truncated":false}\\n'\n`,
      )
      const bombWeb = runPy(
        OC_WEB_CTX,
        [],
        { OPENCLAUDE_WEB_CONTEXT_ROOT: fakeWebRoot },
        JSON.stringify({ op: 'parse_document_file', file_path: bombDocx, kind: 'docx' }),
      )
      assert.equal(bombWeb.status, 0, bombWeb.stderr)
      const bombOut = JSON.parse(bombWeb.stdout)
      assert.equal(bombOut.ok, false, `zip bomb must fail-closed: ${bombWeb.stdout}`)
      assert.match(bombOut.error, /exceeds limit/)
      assert.equal(readdirSync(work).includes('mark-called.txt'), false, 'must NOT fall back to MarkItDown on DocxResourceLimitError')

      // Huge caption gap: 表 1 + 表 999999999 finishes instantaneously with bounded range
      const hugeGapDocx = join(work, 'huge-gap.docx')
      buildCustomDocx(hugeGapDocx, {
        items: [
          { kind: 'p', text: '表 1：起始表' },
          { kind: 'p', text: '表 999999999：末尾表' },
          { kind: 'p', text: '见表 1 与表 999999999。' },
        ],
      })
      const t0 = Date.now()
      const gapPy = spawnSync(
        PYTHON,
        [
          '-c',
          `import json, sys, zipfile, xml.etree.ElementTree as ET; sys.path.insert(0, ${JSON.stringify(PAPER_QA_DIR)}); import oc_docx_paper_qa as qa; root = ET.fromstring(zipfile.ZipFile(${JSON.stringify(hugeGapDocx)}).read("word/document.xml")); print(json.dumps(qa.run_paper_static_checks(${JSON.stringify(hugeGapDocx)}, root)))`,
        ],
        { encoding: 'utf8' },
      )
      assert.equal(gapPy.status, 0, gapPy.stderr)
      assert.ok(Date.now() - t0 < 5000, 'huge gap check must be O(K log K) instantaneous')
      const gapRep = JSON.parse(gapPy.stdout)
      assert.deepEqual(gapRep.cross_refs.tables.gaps, ['2-999999998'])

      // Format width/precision bomb rejected
      const fmtBombRes = spawnSync(
        PYTHON,
        [
          '-c',
          `import sys; sys.path.insert(0, ${JSON.stringify(PAPER_QA_DIR)}); import oc_docx_paper_qa as qa
for bad in ["{{metric:x|1000000000f}}", "{{metric:x|99f}}", "{{metric:x|.99f}}", "{{metric:x|1000s}}"]:
    try:
        qa.expand_metrics_text(bad, {"x": 1.23})
    except ValueError:
        pass
    else:
        raise AssertionError(f"expected ValueError for {bad}")
assert qa.expand_metrics_text("{{metric:x|8.2f}}", {"x": 1.23}) == "    1.23"
print("FMT_BOMB_OK")`,
        ],
        { encoding: 'utf8' },
      )
      assert.equal(fmtBombRes.status, 0, fmtBombRes.stderr)
      assert.match(fmtBombRes.stdout, /FMT_BOMB_OK/)

      // --- #3: Quarto relative {{< include >}} + separate output dir + EXDEV atomic_move fallback ---
      const exdevRes = spawnSync(
        PYTHON,
        [
          '-c',
          [
            'import errno, importlib.machinery, importlib.util, os, pathlib, sys',
            `loader = importlib.machinery.SourceFileLoader("oc_docx_mod", ${JSON.stringify(OC_DOCX)})`,
            'spec = importlib.util.spec_from_loader("oc_docx_mod", loader)',
            'mod = importlib.util.module_from_spec(spec); sys.modules["oc_docx_mod"] = mod; loader.exec_module(mod)',
            `src = pathlib.Path(${JSON.stringify(join(work, 'exdev-src.bin'))})`,
            `dst = pathlib.Path(${JSON.stringify(join(work, 'exdev-dst.bin'))})`,
            'src.write_bytes(b"quarto-payload")',
            'real_replace = os.replace',
            'def fake_replace(a, b):',
            '    if pathlib.Path(a) == src and pathlib.Path(b) == dst: raise OSError(errno.EXDEV, "Invalid cross-device link")',
            '    return real_replace(a, b)',
            'os.replace = fake_replace',
            'mod._atomic_move(src, dst)',
            'assert dst.read_bytes() == b"quarto-payload" and not src.exists()',
            'print("EXDEV_OK")',
          ].join('\n'),
        ],
        { encoding: 'utf8' },
      )
      assert.equal(exdevRes.status, 0, exdevRes.stderr)
      assert.match(exdevRes.stdout, /EXDEV_OK/)

      if (hasTool('quarto')) {
        const qmdDir = join(work, 'qmd-proj')
        const separateOutDir = join(work, 'separate-out')
        mkdirSync(qmdDir, { recursive: true })
        mkdirSync(separateOutDir, { recursive: true })
        const qMetrics = join(qmdDir, 'sim.json')
        writeFileSync(qMetrics, JSON.stringify({ gain_db: 14.25 }), 'utf8')
        writeFileSync(join(qmdDir, '_inc.qmd'), 'Included section confirms relative include resolution.\n', 'utf8')
        const mainQmd = join(qmdDir, 'main.qmd')
        writeFileSync(mainQmd, '---\ntitle: Quarto Metrics\n---\n\nMain gain {{metric:gain_db|.2f}} dB.\n\n{{< include _inc.qmd >}}\n', 'utf8')
        const out1 = join(qmdDir, 'main.docx')
        const q1 = runPy(OC_DOCX, ['convert', mainQmd, '--quarto', '--no-reference-doc', '--metrics', qMetrics, '-o', out1])
        assert.equal(q1.status, 0, `Quarto include+metrics failed: ${q1.stderr}\n${q1.stdout}`)
        const q1Ext = runPy(OC_DOCX, ['extract', out1])
        assert.ok(q1Ext.stdout.includes('Main gain 14.25 dB'), q1Ext.stdout)
        assert.ok(q1Ext.stdout.includes('Included section confirms relative include resolution.'), q1Ext.stdout)
        assert.equal(
          readdirSync(qmdDir).some((n) => n.startsWith('.oc-docx-metrics-')),
          false,
          'temp sibling metrics file must be cleaned up',
        )

        const out2 = join(separateOutDir, 'delivered.docx')
        const q2 = runPy(OC_DOCX, ['convert', mainQmd, '--quarto', '--no-reference-doc', '--metrics', qMetrics, '-o', out2])
        assert.equal(q2.status, 0, `Quarto cross-dir output failed: ${q2.stderr}\n${q2.stdout}`)
        const q2Ext = runPy(OC_DOCX, ['extract', out2])
        assert.ok(q2Ext.stdout.includes('Main gain 14.25 dB') && q2Ext.stdout.includes('Included section confirms relative include resolution.'), q2Ext.stdout)
      }

      // --- #7: Pandoc <x, y> & % round-trip + hyperlink fidelity + plain DOCX keeps MarkItDown ---
      if (pandocAvailable) {
        const innerMd = join(work, 'inner-pct.md')
        const innerDocx = join(work, 'inner-pct.docx')
        writeFileSync(
          innerMd,
          '# Fidelity\n\nInner product $\\langle x, y \\rangle$ and rate $50\\%$ with [OpenClaude](https://example.org/oc).\n',
          'utf8',
        )
        const convInner = runPy(OC_DOCX, ['convert', innerMd, '--no-reference-doc', '-o', innerDocx])
        assert.equal(convInner.status, 0, convInner.stderr)
        const extInner = runPy(OC_DOCX, ['extract', innerDocx, '--latex'])
        assert.equal(extInner.status, 0, extInner.stderr)
        assert.equal(extInner.stdout.includes('\\langlex'), false, `must not glue \\langle and x: ${extInner.stdout}`)
        assert.ok(extInner.stdout.includes('\\langle x'), `expected spaced \\langle x: ${extInner.stdout}`)
        assert.ok(extInner.stdout.includes('\\%'), `expected escaped \\%: ${extInner.stdout}`)
        assert.ok(extInner.stdout.includes('[OpenClaude](https://example.org/oc)'), `hyperlink lost: ${extInner.stdout}`)

        // Formula + link DOCX uses oc_docx_omml and preserves BOTH formula and URL
        const webFormulaLink = runPy(
          OC_WEB_CTX,
          [],
          { OPENCLAUDE_WEB_CONTEXT_ROOT: fakeWebRoot },
          JSON.stringify({ op: 'parse_document_file', file_path: innerDocx, kind: 'docx' }),
        )
        assert.equal(webFormulaLink.status, 0, webFormulaLink.stderr)
        const wfOut = JSON.parse(webFormulaLink.stdout)
        assert.equal(wfOut.extractor, 'oc_docx_omml')
        assert.ok(wfOut.markdown.includes('\\langle x'))
        assert.ok(wfOut.markdown.includes('[OpenClaude](https://example.org/oc)'))

        // No-formula DOCX with hyperlink routes to legacy MarkItDown path when markenv exists
        const plainLinkMd = join(work, 'plain-link.md')
        const plainLinkDocx = join(work, 'plain-link.docx')
        writeFileSync(plainLinkMd, '# Plain\n\nVisit [Example](https://example.org/plain) without formulas.\n', 'utf8')
        const convPlain = runPy(OC_DOCX, ['convert', plainLinkMd, '--no-reference-doc', '-o', plainLinkDocx])
        assert.equal(convPlain.status, 0, convPlain.stderr)
        const webPlain = runPy(
          OC_WEB_CTX,
          [],
          { OPENCLAUDE_WEB_CONTEXT_ROOT: fakeWebRoot },
          JSON.stringify({ op: 'parse_document_file', file_path: plainLinkDocx, kind: 'docx' }),
        )
        assert.equal(webPlain.status, 0, webPlain.stderr)
        const wpOut = JSON.parse(webPlain.stdout)
        assert.equal(wpOut.extractor, 'markitdown', `no-formula DOCX must preserve MarkItDown path: ${webPlain.stdout}`)
      }

      // --- #8: "每个点代表 10 个样本" NOT misclassified as 表 10; "见表 10 所示" IS caught ---
      const fakePath = makeFakeRenderBin(join(work, 'zh-ref'), 'ok\n')
      const posRefDocx = join(work, 'pos-zh-ref.docx')
      buildCustomDocx(posRefDocx, {
        items: [
          { kind: 'p', text: '表 1：汇总' },
          { kind: 'p', text: '见表 1，其中每个点代表 10 个样本，列表 12 项均经过校验，试图 5 次收敛。' },
        ],
      })
      const posCheck = runPy(OC_DOCX, ['check', posRefDocx], { OC_DOCXCHECK: 'on', PATH: fakePath })
      assert.equal(posCheck.status, 0, `false positive on 代表 10: ${posCheck.stdout}`)
      const { report: posRep } = parseCheckStdout(posCheck.stdout)
      assert.equal(posRep.failures.filter((f: any) => f.code === 'broken-cross-ref').length, 0)

      const negRefDocx = join(work, 'neg-zh-ref.docx')
      buildCustomDocx(negRefDocx, {
        items: [
          { kind: 'p', text: '表 1：汇总' },
          { kind: 'p', text: '见表 10 所示，结果显著提升。' },
        ],
      })
      const negCheck = runPy(OC_DOCX, ['check', negRefDocx], { OC_DOCXCHECK: 'on', PATH: fakePath })
      assert.equal(negCheck.status, 1)
      const { report: negRep } = parseCheckStdout(negCheck.stdout)
      assert.ok(negRep.paper_qa.failures.some((f: any) => f.code === 'broken-cross-ref' && f.category === 'table' && f.id === '10'))

      // Arbitrary valid lead verb ("结合表 10 可知") must also be caught as broken-cross-ref
      const combineRefDocx = join(work, 'combine-zh-ref.docx')
      buildCustomDocx(combineRefDocx, {
        items: [
          { kind: 'p', text: '表 1：汇总' },
          { kind: 'p', text: '结合表 10 可知，两组有差异。' },
        ],
      })
      const combineCheck = runPy(OC_DOCX, ['check', combineRefDocx], { OC_DOCXCHECK: 'on', PATH: fakePath })
      assert.equal(combineCheck.status, 1)
      const { report: combineRep } = parseCheckStdout(combineCheck.stdout)
      assert.ok(combineRep.paper_qa.failures.some((f: any) => f.code === 'broken-cross-ref' && f.category === 'table' && f.id === '10'))

      // --- #2b: Full-package zip decompression limit enforced before MarkItDown & before check_docx Document() ---
      const bombMemberDocx = join(work, 'plain-media-bomb.docx')
      const bombMemberRes = spawnSync(
        PYTHON,
        [
          '-c',
          [
            'import json, sys, zipfile',
            `sys.path.insert(0, ${JSON.stringify(PAPER_QA_DIR)})`,
            'import oc_docx_paper_qa as qa',
            `with zipfile.ZipFile(${JSON.stringify(bombMemberDocx)}, "w", compression=zipfile.ZIP_DEFLATED) as zf:`,
            '    zf.writestr("[Content_Types].xml", "<Types/>")',
            '    zf.writestr("word/document.xml", "<w:document xmlns:w=\\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\\"><w:body><w:p><w:r><w:t>plain</w:t></w:r></w:p></w:body></w:document>")',
            '    zf.writestr("word/media/huge.bin", b"A" * (33 * 1024 * 1024))',
            'try:',
            `    qa.docx_has_omml(${JSON.stringify(bombMemberDocx)})`,
            'except qa.DocxResourceLimitError:',
            '    print("HAS_OMML_BLOCKED_OK")',
            'else:',
            '    raise AssertionError("expected DocxResourceLimitError for oversized media member")',
          ].join('\n'),
        ],
        { encoding: 'utf8' },
      )
      assert.equal(bombMemberRes.status, 0, bombMemberRes.stderr)
      assert.match(bombMemberRes.stdout, /HAS_OMML_BLOCKED_OK/)
      const mediaBombWeb = runPy(
        OC_WEB_CTX,
        [],
        { OPENCLAUDE_WEB_CONTEXT_ROOT: fakeWebRoot },
        JSON.stringify({ op: 'parse_document_file', file_path: bombMemberDocx, kind: 'docx' }),
      )
      assert.equal(mediaBombWeb.status, 0, mediaBombWeb.stderr)
      const mediaBombWebJson = JSON.parse(mediaBombWeb.stdout)
      assert.equal(mediaBombWebJson.ok, false)
      assert.equal(mediaBombWebJson.extractor, 'oc_docx_omml')
      assert.match(mediaBombWebJson.error, /exceeds/)

      const bombCheck = runPy(OC_DOCX, ['check', bombMemberDocx], { OC_DOCXCHECK: 'on', PATH: fakePath })
      assert.equal(bombCheck.status, 1)
      const { report: bombCheckRep } = parseCheckStdout(bombCheck.stdout)
      assert.ok(bombCheckRep.failures.some((f: any) => f.code === 'package-resource-limit'))

      // --- #3b & #9b: Pandoc --metrics preserves relative images from outside cwd & long (>4KB) frontmatter metrics works ---
      if (pandocAvailable) {
        const pandocDir = join(work, 'pandoc-res-proj')
        mkdirSync(pandocDir, { recursive: true })
        const figPng = join(pandocDir, 'figure.png')
        const pngRes = spawnSync(
          PYTHON,
          ['-c', `from PIL import Image; Image.new("RGB",(40,30),"#336699").save(${JSON.stringify(figPng)})`],
          { encoding: 'utf8' },
        )
        assert.equal(pngRes.status, 0, pngRes.stderr)
        const pMetrics = join(pandocDir, 'm.json')
        writeFileSync(pMetrics, JSON.stringify({ n: 42 }), 'utf8')
        const longAbstract = '摘要内容'.repeat(600) // > 7000 bytes in UTF-8 before metrics:
        const pMd = join(pandocDir, 'paper.md')
        writeFileSync(
          pMd,
          `---\ntitle: Long Frontmatter\nabstract: "${longAbstract}"\nmetrics: m.json\n---\n\nValue {{metric:n}}.\n\n![Demo Figure](figure.png)\n`,
          'utf8',
        )
        const pOut = join(work, 'pandoc-out.docx')
        // Run from outside pandocDir (REPO_ROOT) without explicit --metrics to test BOTH >4KB frontmatter & --resource-path
        const pConv = runPy(OC_DOCX, ['convert', pMd, '--pandoc', '--no-reference-doc', '-o', pOut])
        assert.equal(pConv.status, 0, `Pandoc long-frontmatter + relative image failed: ${pConv.stderr}`)
        const pExt = runPy(OC_DOCX, ['extract', pOut])
        assert.ok(pExt.stdout.includes('Value 42.'), `long frontmatter metrics not expanded: ${pExt.stdout}`)
        const mediaCheck = spawnSync(
          PYTHON,
          ['-c', `import zipfile, sys; z=zipfile.ZipFile(sys.argv[1]); print([n for n in z.namelist() if n.startswith("word/media/")])`, pOut],
          { encoding: 'utf8' },
        )
        assert.match(mediaCheck.stdout, /word\/media\//, `relative figure.png was lost: ${mediaCheck.stdout}`)
      }

      // --- #9: Standalone oc-docx.py without oc_docx_paper_qa helper ---
      const isoDir = join(work, 'isolated')
      mkdirSync(join(isoDir, 'bin'), { recursive: true })
      mkdirSync(join(isoDir, 'site'), { recursive: true })
      const isoCli = join(isoDir, 'bin', 'oc-docx.py')
      copyFileSync(OC_DOCX, isoCli)
      // Block oc_docx_paper_qa import deterministically even if installed in /usr/local/lib/openclaude
      writeFileSync(
        join(isoDir, 'site', 'sitecustomize.py'),
        'import sys\nclass _Block:\n    def find_spec(self, name, *a, **kw):\n        if name == "oc_docx_paper_qa": raise ImportError("simulated missing helper")\n        return None\nsys.meta_path.insert(0, _Block())\n',
        'utf8',
      )
      const isoEnv: NodeJS.ProcessEnv = { PYTHONPATH: join(isoDir, 'site'), OC_DOCXCHECK: 'on', PATH: fakePath }
      if (pandocAvailable) {
        const isoMd = join(isoDir, 'plain.md')
        const isoDocx = join(isoDir, 'plain.docx')
        writeFileSync(isoMd, '# Standalone\n\nPlain body without metrics.\n', 'utf8')
        const isoConv = runPy(isoCli, ['convert', isoMd, '--no-reference-doc', '-o', isoDocx], isoEnv)
        assert.equal(isoConv.status, 0, `standalone convert must pass without helper: ${isoConv.stderr}`)

        const isoCheck = runPy(isoCli, ['check', isoDocx], isoEnv)
        assert.equal(isoCheck.status, 0, `standalone check must pass without helper: ${isoCheck.stdout}\n${isoCheck.stderr}`)
        const { report: isoRep } = parseCheckStdout(isoCheck.stdout)
        assert.ok(
          isoRep.warnings.some((w: string) => w.includes('paper static QA helper unavailable; skipped')),
          `expected helper-unavailable warning: ${JSON.stringify(isoRep.warnings)}`,
        )

        const isoExtract = runPy(isoCli, ['extract', isoDocx], isoEnv)
        assert.notEqual(isoExtract.status, 0)
        assert.match(isoExtract.stderr, /oc_docx_paper_qa/)

        const isoMetricsConv = runPy(isoCli, ['convert', isoMd, '--no-reference-doc', '--metrics', outsideJson, '-o', join(isoDir, 'm.docx')], isoEnv)
        assert.notEqual(isoMetricsConv.status, 0)
        assert.match(isoMetricsConv.stderr, /metrics/)
      }
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })
})
