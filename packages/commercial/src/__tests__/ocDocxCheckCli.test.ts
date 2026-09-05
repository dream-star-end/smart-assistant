import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

type RunResult = { code: number | null; stdout: string; stderr: string }

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const CLI = join(REPO_ROOT, 'packages/commercial/agent-sandbox/platform-runtime/bin/oc-docx.py')
const CHECK_SH = join(
  REPO_ROOT,
  'packages/commercial/agent-sandbox/platform-runtime/bin/oc-docxcheck.sh',
)

function run(args: string[], env: NodeJS.ProcessEnv = {}): Promise<RunResult> {
  return new Promise((done, reject) => {
    const child = spawn(process.env.PYTHON ?? '/usr/bin/python3', [CLI, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += String(chunk)))
    child.stderr.on('data', (chunk) => (stderr += String(chunk)))
    child.once('error', reject)
    child.once('close', (code) => done({ code, stdout, stderr }))
  })
}

function executable(path: string, body: string): void {
  writeFileSync(path, body)
  chmodSync(path, 0o755)
}

function fakeRenderBin(root: string): string {
  const bin = join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  executable(
    join(bin, 'soffice'),
    [
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
      'printf "%s" "%PDF-1.7\\nHello E=mc^2\\n" > "$out/${base}.pdf"',
      '',
    ].join('\n'),
  )
  executable(
    join(bin, 'libreoffice'),
    readFileSync(join(bin, 'soffice'), 'utf8'),
  )
  executable(
    join(bin, 'pdftoppm'),
    [
      '#!/bin/bash',
      'set -e',
      'out="${@: -1}"',
      '/usr/bin/python3 -c \'from PIL import Image; import sys; Image.new("RGB",(800,1000),"#224466").save(sys.argv[1]+"-1.png")\' "$out"',
      '',
    ].join('\n'),
  )
  executable(
    join(bin, 'pdftotext'),
    '#!/bin/bash\nout="${@: -1}"\nprintf "Hello E=mc^2\\n" > "$out"\n',
  )
  return `${bin}:${process.env.PATH ?? '/usr/bin'}`
}

function pyWrite(script: string, dest: string): void {
  execFileSync(process.env.PYTHON ?? '/usr/bin/python3', ['-c', script, dest], { cwd: REPO_ROOT })
}

function writePlainDocx(path: string): void {
  pyWrite(
    [
      'import sys',
      'from docx import Document',
      'd = Document()',
      'd.add_paragraph("hello world")',
      'd.save(sys.argv[1])',
    ].join('\n'),
    path,
  )
}

function writeOmmlDocx(path: string): void {
  pyWrite(
    [
      'import sys, zipfile',
      'from io import BytesIO',
      'from docx import Document',
      'd = Document()',
      'd.add_paragraph("energy")',
      'buf = BytesIO()',
      'd.save(buf)',
      'src = zipfile.ZipFile(BytesIO(buf.getvalue()))',
      'xml = src.read("word/document.xml").decode("utf-8")',
      'omml = (',
      '  "<m:oMathPara xmlns:m=\\"http://schemas.openxmlformats.org/officeDocument/2006/math\\">"',
      '  "<m:oMath><m:r><m:t>E=mc^2</m:t></m:r></m:oMath></m:oMathPara>"',
      ')',
      'xml = xml.replace("</w:body>", omml + "</w:body>")',
      'if "officeDocument/2006/math" not in xml:',
      '  xml = xml.replace("<w:document", "<w:document xmlns:m=\\"http://schemas.openxmlformats.org/officeDocument/2006/math\\"", 1)',
      'out = zipfile.ZipFile(sys.argv[1], "w")',
      'for info in src.infolist():',
      '  data = xml.encode("utf-8") if info.filename == "word/document.xml" else src.read(info.filename)',
      '  out.writestr(info, data)',
      'out.close()',
    ].join('\n'),
    path,
  )
}

function writeRasterMathDocx(path: string): void {
  pyWrite(
    [
      'import sys, zipfile',
      'from io import BytesIO',
      'from docx import Document',
      'd = Document()',
      'd.add_paragraph("formula as picture")',
      'buf = BytesIO()',
      'd.save(buf)',
      'src = zipfile.ZipFile(BytesIO(buf.getvalue()))',
      'png = (',
      '  b"\\x89PNG\\r\\n\\x1a\\n\\x00\\x00\\x00\\rIHDR\\x00\\x00\\x00\\x01\\x00\\x00\\x00\\x01"',
      '  b"\\x08\\x02\\x00\\x00\\x00\\x90wS\\xde\\x00\\x00\\x00\\x0cIDATx\\x9cc\\xf8\\x0f\\x00\\x00\\x01\\x01\\x00\\x05\\x18\\xd8N\\x00\\x00\\x00\\x00IEND\\xaeB`\\x82"',
      ')',
      'out = zipfile.ZipFile(sys.argv[1], "w")',
      'for info in src.infolist():',
      '  out.writestr(info, src.read(info.filename))',
      'out.writestr("word/media/image1.png", png)',
      'out.close()',
    ].join('\n'),
    path,
  )
}

function writeDanglingRefDocx(path: string): void {
  pyWrite(
    [
      'import sys, zipfile',
      'from io import BytesIO',
      'from docx import Document',
      'd = Document()',
      'd.add_paragraph("see figure")',
      'buf = BytesIO()',
      'd.save(buf)',
      'src = zipfile.ZipFile(BytesIO(buf.getvalue()))',
      'xml = src.read("word/document.xml").decode("utf-8")',
      'field = (',
      '  "<w:p><w:r><w:instrText xml:space=\\"preserve\\"> REF _RefMissing \\\\h </w:instrText></w:r></w:p>"',
      ')',
      'xml = xml.replace("</w:body>", field + "</w:body>")',
      'out = zipfile.ZipFile(sys.argv[1], "w")',
      'for info in src.infolist():',
      '  data = xml.encode("utf-8") if info.filename == "word/document.xml" else src.read(info.filename)',
      '  out.writestr(info, data)',
      'out.close()',
    ].join('\n'),
    path,
  )
}

function parseCheckStdout(stdout: string): { report: any; verdict: string } {
  const lines = stdout.trimEnd().split('\n')
  const verdict = lines[lines.length - 1] ?? ''
  const report = JSON.parse(lines.slice(0, -1).join('\n'))
  return { report, verdict }
}

function hasPythonDocx(): boolean {
  try {
    execFileSync(process.env.PYTHON ?? '/usr/bin/python3', ['-c', 'from docx import Document'], {
      stdio: 'ignore',
    })
    return true
  } catch {
    return false
  }
}

describe('oc-docx check', { skip: !hasPythonDocx() }, () => {
  test('OC_DOCXCHECK=off: check equals inspect (no VERDICT line, empty content is warning)', async () => {
    const work = mkdtempSync(join(tmpdir(), 'oc-docx-check-off-'))
    try {
      const input = join(work, 'plain.docx')
      writePlainDocx(input)
      const inspect = await run(['inspect', input], { OC_DOCXCHECK: 'off' })
      const check = await run(['check', input], { OC_DOCXCHECK: 'off' })
      assert.equal(inspect.code, 0, inspect.stderr)
      assert.equal(check.code, inspect.code)
      assert.equal(check.stdout, inspect.stdout)
      assert.equal(check.stdout.includes('\nPASS'), false)
      assert.equal(check.stdout.includes('\nFAIL'), false)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  test('no OMML + --expect-formulas FAIL omml-missing', async () => {
    const work = mkdtempSync(join(tmpdir(), 'oc-docx-check-omml-'))
    try {
      const input = join(work, 'plain.docx')
      writePlainDocx(input)
      const pathEnv = fakeRenderBin(work)
      const result = await run(['check', input, '--expect-formulas'], {
        OC_DOCXCHECK: 'on',
        PATH: pathEnv,
      })
      assert.equal(result.code, 1)
      const { report, verdict } = parseCheckStdout(result.stdout)
      assert.equal(verdict, 'FAIL')
      assert.ok(report.failures.some((item: { code: string }) => item.code === 'omml-missing'))
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  test('formula md convert then check PASS', async () => {
    const work = mkdtempSync(join(tmpdir(), 'oc-docx-check-convert-'))
    try {
      const md = join(work, 'formula.md')
      const docx = join(work, 'formula.docx')
      writeFileSync(md, '# Energy\n\nInline $E=mc^2$ keeps OMML.\n')
      const converted = await run(['convert', md, '--no-reference-doc', '-o', docx], {})
      assert.equal(converted.code, 0, converted.stderr)
      const pathEnv = fakeRenderBin(work)
      const result = await run(['check', docx, '--expect-formulas'], {
        OC_DOCXCHECK: 'on',
        PATH: pathEnv,
      })
      assert.equal(result.code, 0, result.stderr || result.stdout)
      const { report, verdict } = parseCheckStdout(result.stdout)
      assert.equal(verdict, 'PASS')
      assert.ok(report.omml_count > 0)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  test('formula rasterized as image FAIL omml-rasterized', async () => {
    const work = mkdtempSync(join(tmpdir(), 'oc-docx-check-raster-'))
    try {
      const input = join(work, 'raster.docx')
      writeRasterMathDocx(input)
      const pathEnv = fakeRenderBin(work)
      const result = await run(['check', input, '--expect-formulas'], {
        OC_DOCXCHECK: 'on',
        PATH: pathEnv,
      })
      assert.equal(result.code, 1)
      const { report } = parseCheckStdout(result.stdout)
      assert.ok(report.failures.some((item: { code: string }) => item.code === 'omml-rasterized'))
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  test('dangling REF FAIL xref-orphan', async () => {
    const work = mkdtempSync(join(tmpdir(), 'oc-docx-check-xref-'))
    try {
      const input = join(work, 'xref.docx')
      writeDanglingRefDocx(input)
      const pathEnv = fakeRenderBin(work)
      const result = await run(['check', input], { OC_DOCXCHECK: 'on', PATH: pathEnv })
      assert.equal(result.code, 1)
      const { report } = parseCheckStdout(result.stdout)
      assert.ok(report.failures.some((item: { code: string }) => item.code === 'xref-orphan'))
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  test('soffice readback failure is FAIL, not pretend PASS', async () => {
    const work = mkdtempSync(join(tmpdir(), 'oc-docx-check-soffice-'))
    try {
      const input = join(work, 'omml.docx')
      writeOmmlDocx(input)
      const bin = join(work, 'bin')
      mkdirSync(bin)
      executable(join(bin, 'soffice'), '#!/bin/bash\nexit 1\n')
      executable(join(bin, 'libreoffice'), '#!/bin/bash\nexit 1\n')
      executable(join(bin, 'pdftoppm'), '#!/bin/bash\nexit 1\n')
      const result = await run(['check', input, '--expect-formulas'], {
        OC_DOCXCHECK: 'on',
        PATH: `${bin}:/usr/bin`,
      })
      assert.equal(result.code, 1)
      const { report, verdict } = parseCheckStdout(result.stdout)
      assert.equal(verdict, 'FAIL')
      assert.equal(report.passed, false)
      assert.ok(report.failures.some((item: { code: string }) => item.code === 'libreoffice-render'))
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  test('oc-docxcheck thin shell forwards to check --help', async () => {
    const result = await new Promise<RunResult>((done, reject) => {
      const child = spawn('bash', [CHECK_SH, '--help'], {
        cwd: REPO_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => (stdout += String(chunk)))
      child.stderr.on('data', (chunk) => (stderr += String(chunk)))
      child.once('error', reject)
      child.once('close', (code) => done({ code, stdout, stderr }))
    })
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /--expect-formulas/)
  })
})
