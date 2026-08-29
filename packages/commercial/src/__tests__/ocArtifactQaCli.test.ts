import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

type RunResult = { code: number | null; stdout: string; stderr: string }

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const CLI = join(
  REPO_ROOT,
  'packages/commercial/agent-sandbox/platform-runtime/bin/oc-artifact-qa.py',
)
const HAS_PILLOW = (() => {
  try {
    execFileSync(process.env.PYTHON ?? '/usr/bin/python3', ['-c', 'from PIL import Image'], {
      stdio: 'ignore',
    })
    return true
  } catch {
    return false
  }
})()

function run(args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
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

function fakePdfEnvironment(root: string): { bin: string; site: string } {
  const bin = join(root, 'bin')
  const site = join(root, 'python-site')
  mkdirSync(bin)
  mkdirSync(join(site, 'pypdf'), { recursive: true })
  writeFileSync(
    join(site, 'pypdf', '__init__.py'),
    'import os\nclass PdfReader:\n    def __init__(self,path): self.pages=[object()] * int(os.environ.get("OC_FAKE_PAGE_COUNT", "1")); self.metadata={"Title":"QA"}\n',
  )
  executable(
    join(bin, 'pdftotext'),
    '#!/bin/bash\nout="${@: -1}"\nprintf "季度工作汇报 中文正文\\n" > "$out"\n',
  )
  executable(
    join(bin, 'pdffonts'),
    '#!/bin/bash\nprintf "name type encoding emb sub uni object ID\\n----------------------------------------------\\nNotoSansCJK CID TrueType Identity-H yes yes yes 1 0\\n"\n',
  )
  executable(
    join(bin, 'pdftoppm'),
    [
      '#!/bin/bash',
      'set -e',
      'out="${@: -1}"',
      'for i in $(/usr/bin/seq 1 "${OC_FAKE_PAGE_COUNT:-1}"); do',
      "  /usr/bin/python3 -c 'import sys; i=int(sys.argv[1]); open(sys.argv[2],\"wb\").write(b\"P6\\n480 360\\n255\\n\" + bytes((i,0,0)) * (480*360))' \"$i\" \"${out}-${i}.png\"",
      'done',
      '',
    ].join('\n'),
  )
  return { bin, site }
}

function pngSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(path)
  assert.equal(bytes.subarray(1, 4).toString('ascii'), 'PNG')
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

describe('oc-artifact-qa', () => {
  test('validates real input bytes and persists render evidence without modifying the PDF', async () => {
    const work = mkdtempSync(join(tmpdir(), 'oc-artifact-qa-pdf-'))
    try {
      const { bin, site } = fakePdfEnvironment(work)
      const input = join(work, 'notice.pdf')
      const expect = join(work, 'expect.json')
      const output = join(work, 'qa')
      writeFileSync(input, '%PDF-1.7\nimmutable')
      writeFileSync(
        expect,
        JSON.stringify({ kind: 'pdf', pageCount: 1, requiredText: ['中文正文'] }),
      )
      const before = createHash('sha256').update(readFileSync(input)).digest('hex')
      const result = await run(
        ['inspect', '--input', input, '--out-dir', output, '--expect', expect],
        { PATH: bin, PYTHONPATH: site },
      )
      assert.equal(result.code, 0, result.stderr || result.stdout)
      const report = JSON.parse(readFileSync(join(output, 'report.json'), 'utf8'))
      assert.equal(report.passed, true)
      assert.equal(report.input.sha256, before)
      assert.equal(report.facts.pageCount, 1)
      assert.equal(report.renderedPages.length, 1)
      assert.equal(report.contactSheets.length, HAS_PILLOW ? 1 : 0)
      assert.equal(
        report.warnings.some((warning: any) => warning.code === 'contact-sheet-failed'),
        !HAS_PILLOW,
      )
      assert.equal(createHash('sha256').update(readFileSync(input)).digest('hex'), before)
      assert.deepEqual(JSON.parse(result.stdout), report)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  test('fails closed when required rendered text is missing but still writes the report', async () => {
    const work = mkdtempSync(join(tmpdir(), 'oc-artifact-qa-fail-'))
    try {
      const { bin, site } = fakePdfEnvironment(work)
      const input = join(work, 'notice.pdf')
      const expect = join(work, 'expect.json')
      const output = join(work, 'qa')
      writeFileSync(input, '%PDF-1.7\nimmutable')
      writeFileSync(expect, JSON.stringify({ kind: 'pdf', requiredText: ['不存在的关键文本'] }))
      const result = await run(
        ['inspect', '--input', input, '--out-dir', output, '--expect', expect],
        { PATH: bin, PYTHONPATH: site },
      )
      assert.equal(result.code, 1)
      const report = JSON.parse(readFileSync(join(output, 'report.json'), 'utf8'))
      assert.equal(report.passed, false)
      assert.ok(report.failures.some((failure: any) => failure.code === 'required-text-source'))
      assert.ok(report.failures.some((failure: any) => failure.code === 'required-text-rendered'))
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  test('creates ordered Pillow contact sheets in bounded groups of sixteen pages', async () => {
    const work = mkdtempSync(join(tmpdir(), 'oc-artifact-qa-contacts-'))
    try {
      const { bin, site } = fakePdfEnvironment(work)
      const input = join(work, 'long-report.pdf')
      const output = join(work, 'qa')
      writeFileSync(input, '%PDF-1.7\nimmutable')
      const result = await run(['inspect', '--input', input, '--out-dir', output], {
        PATH: bin,
        PYTHONPATH: site,
        OC_FAKE_PAGE_COUNT: '17',
      })
      assert.equal(result.code, 0, result.stderr || result.stdout)
      const report = JSON.parse(readFileSync(join(output, 'report.json'), 'utf8'))
      assert.equal(report.facts.pageCount, 17)
      assert.equal(report.renderedPages.length, 17)
      assert.match(report.renderedPages[16], /page-17\.png$/)
      assert.equal(report.contactSheets.length, HAS_PILLOW ? 2 : 0)
      const contactFailed = report.warnings.some(
        (warning: any) => warning.code === 'contact-sheet-failed',
      )
      assert.equal(contactFailed, !HAS_PILLOW)
      if (!HAS_PILLOW) return
      const first = report.contactSheets[0]
      const second = report.contactSheets[1]
      assert.deepEqual(pngSize(first), { width: 1944, height: 1464 })
      assert.deepEqual(pngSize(second), { width: 480, height: 360 })
      const sampled = execFileSync(
        process.env.PYTHON ?? '/usr/bin/python3',
        [
          '-c',
          'from PIL import Image; import sys; im=Image.open(sys.argv[1]); print(",".join(str(im.getpixel(p)[0]) for p in [(10,10),(498,10),(10,378),(1474,1114)]))',
          first,
        ],
        { encoding: 'utf8' },
      ).trim()
      assert.equal(sampled, '1,2,5,16')
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  test('uses an isolated LibreOffice profile and kills a timed-out conversion', async () => {
    const work = mkdtempSync(join(tmpdir(), 'oc-artifact-qa-timeout-'))
    try {
      const { bin, site } = fakePdfEnvironment(work)
      mkdirSync(join(site, 'pptx'), { recursive: true })
      writeFileSync(
        join(site, 'pptx', '__init__.py'),
        [
          'class Shape:',
          '    text="季度工作汇报"; left=0; top=0; width=100; height=100',
          'class Slide:',
          '    shapes=[Shape()]',
          'class Presentation:',
          '    def __init__(self,path): self.slides=[Slide()]; self.slide_width=1000; self.slide_height=1000',
          '',
        ].join('\n'),
      )
      const log = join(work, 'soffice.log')
      executable(
        join(bin, 'soffice'),
        '#!/bin/bash\nprintf "%s\\n" "$*" > "$OC_SOFFICE_LOG"\n/bin/sleep 30\n',
      )
      const input = join(work, 'deck.pptx')
      const output = join(work, 'qa')
      writeFileSync(input, 'not-a-zip')
      const started = Date.now()
      const result = await run(
        [
          'inspect',
          '--input',
          input,
          '--out-dir',
          output,
          '--timeout-seconds',
          '1',
        ],
        { PATH: bin, PYTHONPATH: site, OC_SOFFICE_LOG: log },
      )
      assert.equal(result.code, 1)
      assert.ok(Date.now() - started < 10_000)
      assert.match(readFileSync(log, 'utf8'), /-env:UserInstallation=file:\/\//)
      const report = JSON.parse(readFileSync(join(output, 'report.json'), 'utf8'))
      assert.ok(report.failures.some((failure: any) => failure.code === 'libreoffice-convert'))
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  test('accepts required PPTX text rendered from a GraphicFrame without shape.text', async () => {
    const work = mkdtempSync(join(tmpdir(), 'oc-artifact-qa-pptx-table-'))
    try {
      const { bin, site } = fakePdfEnvironment(work)
      mkdirSync(join(site, 'pptx'), { recursive: true })
      writeFileSync(
        join(site, 'pptx', '__init__.py'),
        [
          'class GraphicFrame:',
          '    left=0; top=0; width=100; height=100; has_table=True',
          'class Slide:',
          '    shapes=[GraphicFrame()]',
          'class Presentation:',
          '    def __init__(self,path): self.slides=[Slide()]; self.slide_width=1000; self.slide_height=1000',
          '',
        ].join('\n'),
      )
      executable(
        join(bin, 'soffice'),
        [
          '#!/bin/bash',
          'set -e',
          'out=""',
          'while [ "$#" -gt 0 ]; do',
          '  if [ "$1" = "--outdir" ]; then out="$2"; shift 2; else shift; fi',
          'done',
          '/bin/mkdir -p "$out"',
          'printf "%s" "%PDF-1.7" > "$out/document.pdf"',
          '',
        ].join('\n'),
      )
      const input = join(work, 'deck.pptx')
      execFileSync('/usr/bin/python3', [
        '-c',
        'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],"w"); z.writestr("[Content_Types].xml","<Types/>"); z.close()',
        input,
      ])
      const expect = join(work, 'expect.json')
      const output = join(work, 'qa')
      writeFileSync(
        expect,
        JSON.stringify({ kind: 'pptx', slideCount: 1, requiredText: ['季度工作汇报'] }),
      )
      const result = await run(
        ['inspect', '--input', input, '--out-dir', output, '--expect', expect],
        { PATH: bin, PYTHONPATH: site },
      )
      assert.equal(result.code, 0, result.stderr || result.stdout)
      const report = JSON.parse(readFileSync(join(output, 'report.json'), 'utf8'))
      assert.equal(report.passed, true)
      assert.equal(
        report.failures.some((failure: any) => failure.code === 'required-text-source'),
        false,
      )
      assert.equal(report.renderedPages.length, 1)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })
})
