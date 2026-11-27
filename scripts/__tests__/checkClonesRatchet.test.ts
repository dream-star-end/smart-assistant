import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  BASELINE_REL_PATH,
  detectCrossFileClones,
  main as runClonesMain,
  normalizeTsLogicalLines,
} from '../check-clones-ratchet.ts'

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../check-clones-ratchet.ts',
)

const SHARED_14_LINE_BLOCK = `export function calculateInvoiceSummary(rows: Array<{ amount: number; count: number }>) {
  let gross = 0
  let rebate = 0
  for (const row of rows) {
    const lineTotal = row.amount * row.count
    gross += lineTotal
    if (lineTotal > 500) {
      rebate += lineTotal * 0.05
    }
  }
  const net = gross - rebate
  const vat = net * 0.13
  const grandTotal = net + vat
  return { gross, rebate, net, vat, grandTotal }
}
`

const UNIQUE_FILE_CONTENT = `export function formatGreeting(userName: string, active: boolean): string {
  const cleaned = userName.trim()
  if (!cleaned) return 'guest'
  return active ? \`online:\${cleaned}\` : \`offline:\${cleaned}\`
}
`

function makeCloneRepo(
  t: { after(fn: () => void): void },
  files: Record<string, string>,
): { dir: string; put: (rel: string, content: string) => void; git: (...args: string[]) => string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'oc-clones-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const put = (rel: string, content: string) => {
    const abs = path.join(dir, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  for (const [rel, content] of Object.entries(files)) put(rel, content)
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@openclaude.local')
  git('config', 'user.name', 'Test')
  git('add', '-A')
  git('commit', '-qm', 'initial')
  return { dir, put, git }
}

function runInProc(args: string[]): { status: number; stdout: string; stderr: string } {
  const out: string[] = []
  const err: string[] = []
  const origLog = console.log
  const origErr = console.error
  console.log = (...a: unknown[]) => out.push(a.map(String).join(' '))
  console.error = (...a: unknown[]) => err.push(a.map(String).join(' '))
  try {
    return { status: runClonesMain(args), stdout: out.join('\n'), stderr: err.join('\n') }
  } finally {
    console.log = origLog
    console.error = origErr
  }
}

function runCliSubprocess(args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, ...args], {
    encoding: 'utf8',
  })
}

describe('check-clones-ratchet pure token/window engine', () => {
  test('strips comments/imports and normalizes literals so tweaked constants still match as a 12-line clone', () => {
    const fileA = `import { join } from 'node:path'\n// leading comment\n${SHARED_14_LINE_BLOCK}`
    const fileB = SHARED_14_LINE_BLOCK.replace('500', '9999').replace('0.13', '0.21')

    const linesA = normalizeTsLogicalLines('packages/a/src/one.ts', fileA)
    const linesB = normalizeTsLogicalLines('packages/b/src/two.ts', fileB)
    assert.equal(linesA.length, linesB.length)
    assert.ok(linesA.length >= 12)

    const scan = detectCrossFileClones([
      { file: 'packages/a/src/one.ts', text: fileA },
      { file: 'packages/b/src/two.ts', text: fileB },
    ])
    assert.ok(scan.totalClusters > 0)
  })

  test('ignores same-file internal repetition when no second file shares the window', () => {
    const repeatedInOneFile = `${SHARED_14_LINE_BLOCK}\n${SHARED_14_LINE_BLOCK.replace('calculateInvoiceSummary', 'calculateInvoiceSummary2')}`
    const scan = detectCrossFileClones([
      { file: 'packages/a/src/only.ts', text: repeatedInOneFile },
      { file: 'packages/b/src/other.ts', text: UNIQUE_FILE_CONTENT },
    ])
    assert.equal(scan.totalClusters, 0)
  })
})

describe('check-clones-ratchet CLI: positive, new-clone block, and delete-clone pass', () => {
  test('passes on baselined clone, blocks newly introduced cross-file clone (full & --changed-only), and passes when clone is deleted', (t) => {
    const { dir, put, git } = makeCloneRepo(t, {
      'packages/alpha/src/billingA.ts': SHARED_14_LINE_BLOCK,
      'packages/beta/src/billingB.ts': SHARED_14_LINE_BLOCK,
      'packages/gamma/src/clean.ts': UNIQUE_FILE_CONTENT,
    })

    // 1. Freeze existing clone into arch/clones-baseline.json (real CLI subprocess smoke test)
    const wb = runCliSubprocess(['--root', dir, '--write-baseline'])
    assert.equal(wb.status, 0, wb.stderr)
    git('add', '-A')
    git('commit', '-qm', 'chore: freeze clones baseline')
    git('tag', 'base-clones')

    // 2. Positive case: existing frozen clone + unique file -> exit 0
    const passFull = runInProc(['--root', dir, '--enforce', '--base', 'base-clones'])
    assert.equal(passFull.status, 0, passFull.stderr)

    const passIncr = runInProc([
      '--root',
      dir,
      '--enforce',
      '--changed-only',
      '--base',
      'base-clones',
    ])
    assert.equal(passIncr.status, 0, passIncr.stderr)

    // 3. Introduce a brand-new 12-line clone across gamma/newDup1.ts and gamma/newDup2.ts -> BLOCKED!
    const newDupBlock = `export function reconcileLedgerEntries(entries: Array<{ debit: number; credit: number }>) {
  let sumDebit = 0
  let sumCredit = 0
  for (const item of entries) {
    if (item.debit > 0) {
      sumDebit += item.debit
    }
    if (item.credit > 0) {
      sumCredit += item.credit
    }
  }
  const delta = sumDebit - sumCredit
  const balanced = delta === 0
  return { sumDebit, sumCredit, delta, balanced }
}
`
    put('packages/gamma/src/newDup1.ts', newDupBlock)
    put('packages/delta/src/newDup2.ts', newDupBlock)

    const redFull = runInProc(['--root', dir, '--enforce'])
    assert.equal(redFull.status, 1)
    assert.match(redFull.stderr, /new-clone-cluster/)

    const redIncr = runInProc([
      '--root',
      dir,
      '--enforce',
      '--changed-only',
      '--base',
      'base-clones',
    ])
    assert.equal(redIncr.status, 1)
    assert.match(redIncr.stderr, /new-clone-cluster/)

    // Remove the newly introduced clone files
    unlinkSync(path.join(dir, 'packages/gamma/src/newDup1.ts'))
    unlinkSync(path.join(dir, 'packages/delta/src/newDup2.ts'))

    // 4. Delete the legacy clone from billingB.ts -> PASSES cleanly ("删除克隆放行")!
    put('packages/beta/src/billingB.ts', UNIQUE_FILE_CONTENT)
    const passAfterDelete = runInProc(['--root', dir, '--enforce', '--base', 'base-clones'])
    assert.equal(passAfterDelete.status, 0, passAfterDelete.stderr)

    // Locking in the deletion with --update-baseline also passes monotonic --base check!
    const upd = runInProc(['--root', dir, '--update-baseline'])
    assert.equal(upd.status, 0, upd.stderr)
    const passAfterUpdate = runInProc(['--root', dir, '--enforce', '--base', 'base-clones'])
    assert.equal(passAfterUpdate.status, 0, passAfterUpdate.stderr)
  })
})
