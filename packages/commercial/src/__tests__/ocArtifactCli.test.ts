import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

type RunResult = { code: number | null; stdout: string; stderr: string }

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const BIN_DIR = join(REPO_ROOT, 'packages/commercial/agent-sandbox/platform-runtime/bin')
const TSX = join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs')

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {},
): Promise<RunResult> {
  return new Promise((done, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? REPO_ROOT,
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += String(chunk)))
    child.stderr.on('data', (chunk) => (stderr += String(chunk)))
    child.once('error', reject)
    child.once('close', (code) => done({ code, stdout, stderr }))
    child.stdin.end(options.input ?? '')
  })
}

function runTs(entry: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<RunResult> {
  return run(process.execPath, [TSX, join(REPO_ROOT, entry), ...args], { env })
}

function executable(path: string, body: string): void {
  writeFileSync(path, body)
  chmodSync(path, 0o755)
}

function realCommand(name: string): string {
  for (const prefix of ['/usr/bin', '/bin']) {
    const candidate = join(prefix, name)
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`required test host command missing: ${name}`)
}

function minimalBin(root: string, names: string[]): string {
  const bin = join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  for (const name of names) symlinkSync(realCommand(name), join(bin, name))
  return bin
}

function lines(stdout: string): string[] {
  return stdout
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

const XLSX_STUB = `
import json

class _Dimension:
    width = None

class _Dimensions(dict):
    def __missing__(self, key):
        value = _Dimension()
        self[key] = value
        return value

class _Cell:
    def __init__(self, row, column, value):
        self.row = row
        self.column = column
        self.value = value
        self.data_type = None
        self.border = None
        self.font = None
        self.fill = None
        self.alignment = None

class _Sheet:
    def __init__(self, title='Sheet'):
        self.title = title
        self.cells = {}
        self.column_dimensions = _Dimensions()
        self.freeze_panes = None
    def cell(self, row, column, value=None):
        cell = _Cell(row, column, value)
        self.cells[(row, column)] = cell
        return cell

class Workbook:
    def __init__(self):
        self.worksheets = [_Sheet()]
        self.active = self.worksheets[0]
    def remove(self, sheet):
        self.worksheets.remove(sheet)
        self.active = self.worksheets[0] if self.worksheets else None
    def create_sheet(self, title):
        sheet = _Sheet(title)
        self.worksheets.append(sheet)
        if self.active is None: self.active = sheet
        return sheet
    def save(self, path):
        payload = {'sheets': []}
        for sheet in self.worksheets:
            payload['sheets'].append({
                'title': sheet.title,
                'freeze': sheet.freeze_panes,
                'cells': [
                    {'row': cell.row, 'column': cell.column, 'value': cell.value, 'data_type': cell.data_type}
                    for _, cell in sorted(sheet.cells.items())
                ],
            })
        with open(path, 'w', encoding='utf-8') as handle:
            json.dump(payload, handle, ensure_ascii=False)
`

function makeOpenpyxlStub(root: string): string {
  const site = join(root, 'python-site')
  const pkg = join(site, 'openpyxl')
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(pkg, '__init__.py'), XLSX_STUB)
  writeFileSync(
    join(pkg, 'styles.py'),
    'class S:\n    def __init__(self,*args,**kwargs): pass\nAlignment=Border=Font=PatternFill=Side=S\n',
  )
  writeFileSync(
    join(pkg, 'utils.py'),
    "def get_column_letter(n):\n    out=''\n    while n:\n        n,r=divmod(n-1,26); out=chr(65+r)+out\n    return out\n",
  )
  return site
}

describe('self-contained office/document oc-* CLIs', () => {
  test('oc-diagram renders PDF, SVG and PNG through the selected Typst binary', async () => {
    const work = mkdtempSync(join(tmpdir(), 'oc-diagram-cli-'))
    try {
      const bin = minimalBin(work, ['readlink', 'dirname', 'head', 'sed'])
      const log = join(work, 'typst.log')
      executable(
        join(bin, 'ls'),
        '#!/bin/bash\ncase "$*" in *"/opt/quarto/bin/tools/"*) exit 0;; esac\nexec /bin/ls "$@"\n',
      )
      executable(
        join(bin, 'typst'),
        '#!/bin/bash\nprintf "%s\\n" "$*" >> "$OC_TEST_LOG"\nout="${!#}"\nprintf "rendered" > "$out"\n',
      )
      const input = join(work, 'figure.typ')
      const pdf = join(work, 'custom.pdf')
      writeFileSync(input, '#rect(width: 1cm, height: 1cm)')
      const result = await run(
        '/bin/bash',
        [join(BIN_DIR, 'oc-diagram.sh'), input, '-o', pdf, '--svg', '--png', '--ppi', '240'],
        { cwd: work, env: { PATH: bin, OC_TEST_LOG: log, TMPDIR: work } },
      )
      assert.equal(result.code, 0, result.stderr)
      const svg = join(work, 'figure.svg')
      const png = join(work, 'figure.png')
      for (const file of [pdf, svg, png]) assert.equal(readFileSync(file, 'utf8'), 'rendered')
      assert.deepEqual(lines(result.stdout), [svg, pdf, png])
      const invocations = lines(readFileSync(log, 'utf8'))
      assert.equal(invocations.length, 3)
      for (const invocation of invocations) assert.match(invocation, /--ppi 240/)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  test('oc-docx covers Pandoc Markdown and Quarto QMD engines', async () => {
    const work = mkdtempSync(join(tmpdir(), 'oc-docx-cli-'))
    try {
      const bin = minimalBin(work, [
        'bash',
        'readlink',
        'dirname',
        'cat',
        'basename',
        'mkdir',
        'pwd',
        'rm',
        'mv',
      ])
      const log = join(work, 'render.log')
      executable(
        join(bin, 'pandoc'),
        '#!/bin/bash\nprintf "pandoc %s\\n" "$*" >> "$OC_TEST_LOG"\nout=""; prev=""\nfor arg in "$@"; do [ "$prev" = "--output" ] && out="$arg"; prev="$arg"; done\nprintf docx > "$out"\n',
      )
      executable(
        join(bin, 'quarto'),
        '#!/bin/bash\nprintf "quarto %s\\n" "$*" >> "$OC_TEST_LOG"\nout=""; prev=""\nfor arg in "$@"; do [ "$prev" = "--output" ] && out="$arg"; prev="$arg"; done\nprintf docx > "$out"\n',
      )
      const md = join(work, 'draft.md')
      const qmd = join(work, 'slides.qmd')
      const mdOut = join(work, 'draft.docx')
      const qmdDir = join(work, 'out')
      const qmdOut = join(qmdDir, 'slides.docx')
      mkdirSync(qmdDir)
      writeFileSync(md, '# Draft')
      writeFileSync(qmd, '# Slides')

      let result = await run(
        'bash',
        [join(BIN_DIR, 'oc-docx.sh'), '--no-reference-doc', md, '-o', mdOut],
        { env: { PATH: bin, OC_TEST_LOG: log } },
      )
      assert.equal(result.code, 0, result.stderr)
      assert.equal(result.stdout.trim(), mdOut)
      assert.equal(readFileSync(mdOut, 'utf8'), 'docx')

      result = await run(
        'bash',
        [join(BIN_DIR, 'oc-docx.sh'), '--no-reference-doc', qmd, '-o', qmdOut],
        { env: { PATH: bin, OC_TEST_LOG: log } },
      )
      assert.equal(result.code, 0, result.stderr)
      assert.equal(result.stdout.trim(), qmdOut)
      assert.equal(readFileSync(qmdOut, 'utf8'), 'docx')

      const renderLog = readFileSync(log, 'utf8')
      assert.match(renderLog, /pandoc .*--toc --number-sections/)
      assert.match(renderLog, /quarto render slides\.qmd --to docx/)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  test('oc-pdf covers no-Quarto fallback, successful render and render fallback', async () => {
    const work = mkdtempSync(join(tmpdir(), 'oc-pdf-cli-'))
    try {
      const baseCommands = [
        'bash',
        'readlink',
        'dirname',
        'cat',
        'cp',
        'mkdir',
        'pwd',
        'basename',
        'mktemp',
        'rm',
        'sed',
        'mv',
      ]
      const noQuarto = minimalBin(join(work, 'fallback'), baseCommands)
      const input = join(work, 'report.md')
      writeFileSync(input, '# 中文报告')
      const fallbackPdf = join(work, 'fallback.pdf')
      let result = await run('bash', [join(BIN_DIR, 'oc-pdf.sh'), input, '-o', fallbackPdf], {
        env: { PATH: noQuarto, TMPDIR: work },
      })
      assert.equal(result.code, 0, result.stderr)
      assert.equal(result.stdout.trim(), join(work, 'fallback.qmd'))
      assert.match(result.stderr, /未检测到 quarto/)

      const successBin = minimalBin(join(work, 'success'), baseCommands)
      const log = join(work, 'quarto.log')
      executable(
        join(successBin, 'quarto'),
        '#!/bin/bash\nprintf "%s\\n" "$*" > "$OC_TEST_LOG"\nout=""; prev=""\nfor arg in "$@"; do [ "$prev" = "--output" ] && out="$arg"; prev="$arg"; done\nprintf pdf > "$out"\n',
      )
      const successPdf = join(work, 'success.pdf')
      result = await run(
        'bash',
        [join(BIN_DIR, 'oc-pdf.sh'), '--mainfont', 'Noto Sans CJK SC', input, '-o', successPdf],
        { env: { PATH: successBin, TMPDIR: work, OC_TEST_LOG: log } },
      )
      assert.equal(result.code, 0, result.stderr)
      assert.equal(result.stdout.trim(), successPdf)
      assert.equal(readFileSync(successPdf, 'utf8'), 'pdf')
      assert.match(readFileSync(log, 'utf8'), /mainfont:Noto Sans CJK SC/)

      const failureBin = minimalBin(join(work, 'failure'), baseCommands)
      executable(join(failureBin, 'quarto'), '#!/bin/bash\necho renderer-failed >&2\nexit 9\n')
      const failedPdf = join(work, 'failed.pdf')
      result = await run('bash', [join(BIN_DIR, 'oc-pdf.sh'), input, '-o', failedPdf], {
        env: { PATH: failureBin, TMPDIR: work },
      })
      assert.equal(result.code, 0, result.stderr)
      assert.equal(result.stdout.trim(), join(work, 'failed.qmd'))
      assert.match(result.stderr, /renderer-failed/)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  test('oc-xlsx covers CSV, JSON and multi-table Markdown with formula-safe strings', async () => {
    const work = mkdtempSync(join(tmpdir(), 'oc-xlsx-cli-'))
    const site = makeOpenpyxlStub(work)
    try {
      const csv = join(work, 'data.csv')
      const json = join(work, 'data.json')
      const md = join(work, 'tables.md')
      writeFileSync(csv, 'name,value\nnumber,42\nformula,=WEBSERVICE("https://bad")\n')
      writeFileSync(
        json,
        JSON.stringify([{ name: 'A', value: 2 }, 'skip', { name: 'B', extra: 3 }]),
      )
      writeFileSync(
        md,
        '# 重复/标题\n| A | B |\n|---|---|\n| 1 | x |\n\n# 重复/标题\n| C |\n|---|\n| y |\n',
      )
      for (const [subcommand, input] of [
        ['from-csv', csv],
        ['from-json', json],
        ['from-md', md],
      ]) {
        const output = join(work, `${subcommand}.xlsx`)
        const args = [join(BIN_DIR, 'oc-xlsx.py'), subcommand, input, '-o', output]
        if (subcommand !== 'from-md') args.push('--sheet', 'Bad/Name')
        const result = await run('python3', args, { env: { PYTHONPATH: site } })
        assert.equal(result.code, 0, result.stderr)
        const meta = JSON.parse(lines(result.stdout)[0])
        assert.equal(meta.output, output)
        assert.equal(lines(result.stdout).at(-1), output)
      }

      const csvBook = JSON.parse(readFileSync(join(work, 'from-csv.xlsx'), 'utf8'))
      assert.equal(csvBook.sheets[0].title, 'Bad Name')
      assert.equal(csvBook.sheets[0].freeze, 'A2')
      const formula = csvBook.sheets[0].cells.find((cell: any) =>
        String(cell.value).startsWith('=WEBSERVICE'),
      )
      assert.equal(formula.data_type, 's')
      const number = csvBook.sheets[0].cells.find((cell: any) => cell.value === 42)
      assert.ok(number)

      const jsonMeta = JSON.parse(
        lines(
          (
            await run(
              'python3',
              [join(BIN_DIR, 'oc-xlsx.py'), 'from-json', json, '-o', join(work, 'json-again.xlsx')],
              { env: { PYTHONPATH: site } },
            )
          ).stdout,
        )[0],
      )
      assert.equal(jsonMeta.skippedNonObject, 1)

      const mdBook = JSON.parse(readFileSync(join(work, 'from-md.xlsx'), 'utf8'))
      assert.deepEqual(
        mdBook.sheets.map((sheet: any) => sheet.title),
        ['重复 标题', '重复 标题_2'],
      )
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })
})

describe('deterministic gateway artifact CLI entries', () => {
  test('oc-rank elo reads a match file and emits the deterministic winner', async () => {
    const work = mkdtempSync(join(tmpdir(), 'oc-rank-cli-'))
    try {
      const matches = join(work, 'matches.json')
      writeFileSync(
        matches,
        JSON.stringify({
          items: ['A', 'B', 'C'],
          matches: [
            { a: 'A', b: 'B', winner: 'a' },
            { a: 'A', b: 'C', winner: 'a' },
            { a: 'B', b: 'C', winner: 'a' },
          ],
        }),
      )
      const result = await runTs('packages/gateway/src/ocRankCli.ts', ['elo', '--matches', matches])
      assert.equal(result.code, 0, result.stderr)
      const ranked = JSON.parse(result.stdout).ranked
      assert.deepEqual(
        ranked.map((row: any) => row.id),
        ['A', 'B', 'C'],
      )
      assert.equal(ranked[0].wins, 2)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  test('oc-report writes QMD plus the exact manifest sidecar without host renderers', async () => {
    const work = mkdtempSync(join(tmpdir(), 'oc-report-cli-'))
    try {
      const rendererless = minimalBin(work, ['sh'])
      const schemaFile = join(work, 'schema.json')
      const manifestFile = join(work, 'manifest.json')
      const output = join(work, 'report.pdf')
      const manifest = {
        sources: [],
        quotes: [],
        claims: [],
        coverage: { verifiedClaims: 0, totalClaims: 0 },
        gates: {
          quoteFirst: { passed: true, checked: 0, failed: 0 },
          claimBound: { passed: true, checked: 0, failed: 0 },
          identifier: { passed: true, checked: 0, failed: 0 },
          retraction: { passed: true, checked: 0, failed: 0 },
        },
      }
      writeFileSync(
        schemaFile,
        JSON.stringify({
          title: 'Report',
          abstract: 'Summary',
          sections: [{ id: 's1', heading: 'Intro', level: 2, bodyMd: 'Body', claimRefs: [] }],
          bibliography: [],
        }),
      )
      writeFileSync(manifestFile, JSON.stringify({ manifest }))
      const result = await runTs(
        'packages/gateway/src/ocReportCli.ts',
        ['--schema', schemaFile, '--manifest', manifestFile, '-o', output],
        { PATH: rendererless },
      )
      assert.equal(result.code, 0, result.stderr)
      const summary = JSON.parse(result.stdout.slice(0, result.stdout.lastIndexOf('\n/') + 1))
      assert.equal(summary.output, join(work, 'report.qmd'))
      assert.equal(summary.manifestPath, join(work, 'report.manifest.json'))
      assert.match(readFileSync(summary.qmd, 'utf8'), /## Intro/)
      assert.deepEqual(JSON.parse(readFileSync(summary.manifestPath, 'utf8')), manifest)
      assert.match(summary.warnings.join('\n'), /未检测到 quarto\/pandoc/)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  test('oc-slides and oc-poster turn valid JSON into QMD without host Quarto', async () => {
    const work = mkdtempSync(join(tmpdir(), 'oc-present-cli-'))
    try {
      const rendererless = minimalBin(work, ['sh'])
      const deck = join(work, 'deck.json')
      const poster = join(work, 'poster.json')
      writeFileSync(
        deck,
        JSON.stringify({
          title: 'Deck',
          slides: [{ heading: 'Background', bullets: ['One', 'Two'] }],
        }),
      )
      writeFileSync(
        poster,
        JSON.stringify({
          title: 'Poster',
          columns: 2,
          sections: [{ heading: 'Method', bodyMd: 'Details' }],
        }),
      )
      let result = await runTs(
        'packages/gateway/src/ocSlidesCli.ts',
        ['--deck', deck, '-o', join(work, 'deck.html')],
        { PATH: rendererless },
      )
      assert.equal(result.code, 0, result.stderr)
      const slideQmd = lines(result.stdout).at(-1)
      assert.ok(slideQmd)
      assert.match(readFileSync(slideQmd, 'utf8'), /## Background/)
      assert.match(result.stdout, /"slideCount": 1/)

      result = await runTs(
        'packages/gateway/src/ocPosterCli.ts',
        ['--spec', poster, '-o', join(work, 'poster.pdf')],
        { PATH: rendererless },
      )
      assert.equal(result.code, 0, result.stderr)
      const posterQmd = lines(result.stdout).at(-1)
      assert.ok(posterQmd)
      assert.match(readFileSync(posterQmd, 'utf8'), /## Method/)
      assert.match(result.stdout, /"sectionCount": 1/)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })
})
