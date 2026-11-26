import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  BASELINE_REL_PATH,
  analyzeSourceComplexity,
  isProductionTsFile,
  main as runComplexityMain,
} from '../check-complexity-ratchet.ts'

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../check-complexity-ratchet.ts',
)

function makeFixtureRepo(
  t: { after(fn: () => void): void },
  files: Record<string, string>,
): { dir: string; put: (rel: string, content: string) => void; git: (...args: string[]) => string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'oc-complexity-'))
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
    const status = runComplexityMain(args)
    return { status, stdout: out.join('\n'), stderr: err.join('\n') }
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

describe('check-complexity-ratchet AST & file filtering', () => {
  test('filters production TS/TSX files and excludes tests, .d.ts, generated, and agent-sandbox templates', () => {
    assert.equal(isProductionTsFile('packages/gateway/src/server.ts'), true)
    assert.equal(isProductionTsFile('packages/web-react/src/App.tsx'), true)
    assert.equal(isProductionTsFile('packages/commercial/src/agent-sandbox/supervisor.ts'), true)

    assert.equal(isProductionTsFile('packages/gateway/src/server.test.ts'), false)
    assert.equal(isProductionTsFile('packages/gateway/src/__tests__/helper.ts'), false)
    assert.equal(isProductionTsFile('packages/protocol/src/types.d.ts'), false)
    assert.equal(isProductionTsFile('packages/gateway/src/engine/generated/schema.ts'), false)
    assert.equal(
      isProductionTsFile('packages/commercial/agent-sandbox/platform-runtime/entrypoint/entrypoint.ts'),
      false,
    )
  })

  test('computes lines, direct CC (excluding nested callbacks), and control-flow nesting (flat else-if)', () => {
    const src = `
export function dispatchRoute(kind: string, items: number[]): number {
  if (kind === 'a') {
    return 1
  } else if (kind === 'b') {
    return 2
  } else if (kind === 'c') {
    return items.map((x) => {
      if (x > 10 && x < 20) {
        return x ? 1 : 0
      }
      return 0
    }).length
  }
  return 0
}

export const deeplyNestedArrow = (matrix: number[][]): number => {
  let sum = 0
  for (const row of matrix) {
    if (row.length > 0) {
      for (const cell of row) {
        if (cell > 0) {
          while (sum < 10) {
            if (cell % 2 === 0) {
              sum += cell
            }
            break
          }
        }
      }
    }
  }
  return sum
}
`
    const metrics = analyzeSourceComplexity('packages/demo/src/sample.ts', src)
    const dispatch = metrics.find((m) => m.fnName === 'dispatchRoute')
    assert.ok(dispatch)
    // Base 1 + 3 `if` branches = 4; inner `.map` callback branches must NOT inflate ccDirect!
    assert.equal(dispatch.ccDirect, 4)
    // Flat `if / else if / else if` stays at nesting depth 1!
    assert.equal(dispatch.maxNesting, 1)

    const deep = metrics.find((m) => m.fnName === 'deeplyNestedArrow')
    assert.ok(deep)
    assert.equal(deep.maxNesting, 6)
  })
})

describe('check-complexity-ratchet CLI & monotonic baseline enforcement', () => {
  test('freezes legacy over-limit function, blocks new > (100, 20, 5) and any dimension growth on baselined function', (t) => {
    const legacyLines = Array.from({ length: 105 }, (_, i) => `  total += ${i}`).join('\n')
    const legacyFile = 'packages/demo/src/legacy.ts'
    const { dir, put, git } = makeFixtureRepo(t, {
      [legacyFile]: `export function legacyGiant(seed: number): number {\n  let total = seed\n  if (seed > 0) total += 1\n${legacyLines}\n  return total\n}\n`,
      'packages/demo/src/clean.ts': 'export function smallFn(x: number): number {\n  return x + 1\n}\n',
    })

    // 1. Write baseline (real CLI subprocess smoke test)
    const wb = runCliSubprocess(['--root', dir, '--write-baseline'])
    assert.equal(wb.status, 0, wb.stderr)
    const baselineJson = JSON.parse(readFileSync(path.join(dir, BASELINE_REL_PATH), 'utf8'))
    assert.equal(baselineJson.summary.exceedingFunctions, 1)
    const frozen = baselineJson.functions[`${legacyFile}::legacyGiant`]
    assert.ok(frozen.lines > 100)
    assert.equal(frozen.ccDirect, 2)
    assert.equal(frozen.maxNesting, 1)

    git('add', '-A')
    git('commit', '-qm', 'chore: add complexity baseline')
    git('tag', 'base-v1')

    // 2. Clean enforce passes (both full and incremental --files < 2s)
    const okFull = runInProc(['--root', dir, '--enforce', '--base', 'base-v1'])
    assert.equal(okFull.status, 0, okFull.stderr)

    const t0 = Date.now()
    const okFast = runInProc(['--root', dir, '--enforce', '--files', 'packages/demo/src/clean.ts'])
    const elapsedMs = Date.now() - t0
    assert.equal(okFast.status, 0, okFast.stderr)
    assert.ok(elapsedMs < 2000, `expected incremental --files < 2000ms, got ${elapsedMs}ms`)

    // 3. New function exceeding ccDirect > 20 -> BLOCKED
    const branchyBody = Array.from({ length: 21 }, (_, i) => `  if (x === ${i}) acc += ${i}`).join('\n')
    put(
      'packages/demo/src/clean.ts',
      `export function tooManyBranches(x: number): number {\n  let acc = 0\n${branchyBody}\n  return acc\n}\n`,
    )
    const redNew = runInProc(['--root', dir, '--enforce', '--files', 'packages/demo/src/clean.ts'])
    assert.equal(redNew.status, 1)
    assert.match(redNew.stderr, /new-over-limit/)
    assert.match(redNew.stderr, /ccDirect=22 > 20/)

    // Restore clean.ts, then grow `ccDirect` of baselined `legacyGiant` from 2 -> 3 while shrinking lines!
    put('packages/demo/src/clean.ts', 'export function smallFn(x: number): number {\n  return x + 1\n}\n')
    const slightlyShorterLines = Array.from({ length: 102 }, (_, i) => `  total += ${i}`).join('\n')
    put(
      legacyFile,
      `export function legacyGiant(seed: number): number {\n  let total = seed\n  if (seed > 0) total += 1\n  if (seed > 10) total += 2\n${slightlyShorterLines}\n  return total\n}\n`,
    )
    const redDimGrow = runInProc(['--root', dir, '--enforce'])
    assert.equal(redDimGrow.status, 1)
    assert.match(redDimGrow.stderr, /baseline-dimension-grown/)
    assert.match(redDimGrow.stderr, /ccDirect 2 -> 3/)

    // 4. Attempting to tamper with arch/complexity-baseline.json by raising ccDirect -> BLOCKED by --base
    const tampered = JSON.parse(readFileSync(path.join(dir, BASELINE_REL_PATH), 'utf8'))
    tampered.functions[`${legacyFile}::legacyGiant`].ccDirect = 5
    writeFileSync(path.join(dir, BASELINE_REL_PATH), `${JSON.stringify(tampered, null, 2)}\n`)
    const redTamper = runInProc(['--root', dir, '--enforce', '--base', 'base-v1'])
    assert.equal(redTamper.status, 1)
    assert.match(redTamper.stderr, /baseline-file-raised/)

    // 5. Refactoring legacyGiant below all limits + --update-baseline -> GREEN
    put(legacyFile, 'export function legacyGiant(seed: number): number {\n  return seed + 42\n}\n')
    git('checkout', 'base-v1', '--', BASELINE_REL_PATH)
    const upd = runInProc(['--root', dir, '--update-baseline'])
    assert.equal(upd.status, 0, upd.stderr)
    const shrunkOk = runInProc(['--root', dir, '--enforce', '--base', 'base-v1'])
    assert.equal(shrunkOk.status, 0, shrunkOk.stderr)
  })
})
