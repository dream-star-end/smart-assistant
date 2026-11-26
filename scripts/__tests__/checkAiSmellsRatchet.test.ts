import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  compareAgainstBaseline,
  compareBaselineMonotonic,
  isAiSmellsProductionFile,
  scanSourceForAiSmells,
} from '../check-ai-smells-ratchet.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const localTsx = path.join(root, 'node_modules/.bin/tsx')
const tsx = existsSync(localTsx) ? localTsx : 'tsx'

describe('AI smells AST scanner (pure)', () => {
  test('production file filter includes packages/*/src TS/TSX and excludes tests, .d.ts, generated, agent-sandbox templates', () => {
    assert.equal(isAiSmellsProductionFile('packages/commercial/src/ws/userChatBridge.ts'), true)
    assert.equal(isAiSmellsProductionFile('packages/web-react/src/App.tsx'), true)
    assert.equal(isAiSmellsProductionFile('packages/channels/wechat/src/worker.ts'), true)
    assert.equal(isAiSmellsProductionFile('packages/commercial/src/agent-sandbox/supervisor.ts'), true)

    assert.equal(isAiSmellsProductionFile('packages/commercial/src/foo.test.ts'), false)
    assert.equal(isAiSmellsProductionFile('packages/commercial/src/__tests__/foo.ts'), false)
    assert.equal(isAiSmellsProductionFile('packages/protocol/src/types.d.ts'), false)
    assert.equal(isAiSmellsProductionFile('packages/protocol/src/generated/client.ts'), false)
    assert.equal(
      isAiSmellsProductionFile('packages/commercial/agent-sandbox/platform-runtime/entrypoint/seed.ts'),
      false,
    )
    assert.equal(isAiSmellsProductionFile('packages/web-react/browser-tests/harness.tsx'), false)
    assert.equal(isAiSmellsProductionFile('claude-code-best/src/main.tsx'), false)
    assert.equal(isAiSmellsProductionFile('scripts/check-ai-smells-ratchet.ts'), false)
  })

  test('detects empty catch blocks (empty or comment-only) and ignores handled catches & string literals', () => {
    const code = `
export function demo() {
  try { work() } catch {}
  try { work() } catch (e) { /* silently ignore */ }
  try { work() } catch (e) { console.error(e) }
  const fake = "try { a() } catch {} // empty catch in string"
  return fake
}
`
    const { counts, hits } = scanSourceForAiSmells('packages/kernel/src/demo.ts', code)
    assert.equal(counts.emptyCatch, 2)
    assert.equal(hits.filter((h) => h.category === 'emptyCatch').length, 2)
  })

  test('detects `as any`, `<any>`, and `as unknown as T` without double-counting or string false positives', () => {
    const code = `
export function casts(x: unknown) {
  const a = x as any
  const b = x as unknown as number
  const c = (x as unknown) as string
  const d = x as unknown as any
  const e = <any>x
  const safe = x as string
  const str = "const z = x as any; const w = x as unknown as Foo"
  // comment: x as any and x as unknown as Bar
  return [a, b, c, d, e, safe, str]
}
`
    const { counts } = scanSourceForAiSmells('packages/kernel/src/casts.ts', code)
    // a (as any), b (as unknown as), c ((as unknown) as), d (as unknown as any counted once), e (<any>) = 5
    assert.equal(counts.typeEscape, 5)
  })

  test('detects sync fs/child_process calls and ignores async calls, imports, and strings', () => {
    const code = `
import fs, { readFileSync, readFile } from 'node:fs'
import { execSync, spawnSync } from 'node:child_process'

export async function run(p: string) {
  const a = readFileSync(p, 'utf8')
  const b = fs.writeFileSync(p, a)
  const c = fs.existsSync(p)
  const d = execSync('echo hi')
  const e = spawnSync('ls')
  const ok = await readFile(p, 'utf8')
  const fake = "readFileSync('/etc/hosts'); execSync('id')"
  return { a, b, c, d, e, ok, fake }
}
`
    const { counts } = scanSourceForAiSmells('packages/kernel/src/io.ts', code)
    assert.equal(counts.syncIo, 5)
  })

  test('detects eslint-disable and biome-ignore ONLY in real comments, never in string/template literals', () => {
    const code = `
// eslint-disable-next-line no-console
export const a = 1
/* biome-ignore lint/suspicious/noExplicitAny: legacy */
export const b = 2
/* eslint-disable */
export const c = "eslint-disable-next-line and biome-ignore inside string"
export const d = \`biome-ignore inside template \${a}\`
`
    const { counts } = scanSourceForAiSmells('packages/kernel/src/sup.ts', code)
    assert.equal(counts.lintSuppress, 3)
  })

  test('compareAgainstBaseline & compareBaselineMonotonic catch both per-file and total regressions', () => {
    const base = {
      schemaVersion: 1 as const,
      generatedAt: '2026-11-26',
      categories: ['emptyCatch', 'typeEscape', 'syncIo', 'lintSuppress'] as const,
      totals: { emptyCatch: 1, typeEscape: 1, syncIo: 0, lintSuppress: 0, all: 2 },
      files: {
        'packages/kernel/src/a.ts': { emptyCatch: 1, typeEscape: 1, syncIo: 0, lintSuppress: 0 },
      },
    }
    // Shrinking a.ts passes
    assert.deepEqual(
      compareAgainstBaseline(
        { 'packages/kernel/src/a.ts': { emptyCatch: 0, typeEscape: 1, syncIo: 0, lintSuppress: 0 } },
        base,
      ),
      [],
    )
    // Moving 1 emptyCatch from a.ts to new file b.ts (total unchanged!) MUST still fail!
    const moved = compareAgainstBaseline(
      {
        'packages/kernel/src/a.ts': { emptyCatch: 0, typeEscape: 1, syncIo: 0, lintSuppress: 0 },
        'packages/kernel/src/b.ts': { emptyCatch: 1, typeEscape: 0, syncIo: 0, lintSuppress: 0 },
      },
      base,
    )
    assert.equal(moved.length, 1)
    assert.equal(moved[0]?.kind, 'new-file-smell')
    assert.equal(moved[0]?.file, 'packages/kernel/src/b.ts')

    // Raising baseline fails monotonic check
    const raised = compareBaselineMonotonic(base, {
      ...base,
      totals: { emptyCatch: 2, typeEscape: 1, syncIo: 0, lintSuppress: 0, all: 3 },
      files: {
        'packages/kernel/src/a.ts': { emptyCatch: 2, typeEscape: 1, syncIo: 0, lintSuppress: 0 },
      },
    })
    assert.ok(raised.length >= 1)
    assert.equal(raised[0]?.kind, 'baseline-raised')
  })
})

describe('CLI integration against a temp git repo', () => {
  let repo: string

  const write = (rel: string, content: string) => {
    const abs = path.join(repo, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }

  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    return r.stdout.trim()
  }

  const cli = (...args: string[]) => {
    const r = spawnSync(
      tsx,
      [path.join(root, 'scripts/check-ai-smells-ratchet.ts'), '--root', repo, ...args],
      { cwd: repo, encoding: 'utf8' },
    )
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, out: `${r.stdout}${r.stderr}` }
  }

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'ai-smells-ratchet-'))
    write(
      'packages/kernel/src/legacy.ts',
      `import { readFileSync } from 'node:fs'\nexport function f(x: unknown) {\n  try { return readFileSync(x as any, 'utf8') } catch {}\n}\n`,
    )
    write(
      'packages/kernel/src/clean.ts',
      `export function clean(v: string) {\n  const s = "as any readFileSync eslint-disable try {} catch {}"\n  return v + s\n}\n`,
    )
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
    git('add', '-A')
    git('commit', '-qm', 'init')
  })

  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  test('--write-baseline -> --enforce passes -> adding smell fails -> removing smell passes', () => {
    const w = cli('--write-baseline')
    assert.equal(w.status, 0, w.out)

    const baseline = JSON.parse(readFileSync(path.join(repo, 'arch/ai-smells-baseline.json'), 'utf8'))
    assert.deepEqual(baseline.totals, { emptyCatch: 1, typeEscape: 1, syncIo: 1, lintSuppress: 0, all: 3 })
    assert.equal(baseline.files['packages/kernel/src/clean.ts'], undefined)

    // Commit baseline and tag base
    git('add', '-A')
    git('commit', '-qm', 'add baseline')
    git('tag', 'base')

    // Exact match passes
    const ok = cli('--enforce', '--json')
    assert.equal(ok.status, 0, ok.out)
    assert.equal(JSON.parse(ok.stdout).ok, true)

    // Add a new file with 1 biome-ignore -> fails immediately
    write('packages/kernel/src/newSmelly.ts', '// biome-ignore lint/all: lazy\nexport const n = 1\n')
    const failNew = cli('--enforce', '--json')
    assert.equal(failNew.status, 1, failNew.out)
    assert.equal(JSON.parse(failNew.stdout).violations[0].kind, 'new-file-smell')
    rmSync(path.join(repo, 'packages/kernel/src/newSmelly.ts'))

    // Add +1 `as unknown as` to existing legacy.ts -> fails immediately
    write(
      'packages/kernel/src/legacy.ts',
      `import { readFileSync } from 'node:fs'\nexport function f(x: unknown) {\n  const y = x as unknown as string\n  try { return readFileSync(x as any, 'utf8') + y } catch {}\n}\n`,
    )
    const failGrow = cli('--enforce')
    assert.equal(failGrow.status, 1, failGrow.out)
    assert.match(failGrow.out, /typeEscape/)

    // Fix emptyCatch in legacy.ts -> passes!
    write(
      'packages/kernel/src/legacy.ts',
      `import { readFileSync } from 'node:fs'\nexport function f(x: unknown) {\n  try { return readFileSync(x as any, 'utf8') } catch (err) { throw err }\n}\n`,
    )
    assert.equal(cli('--enforce').status, 0)

    // Attempt to raise baseline in --base mode -> fails!
    const tampered = {
      ...baseline,
      totals: { ...baseline.totals, emptyCatch: 2, all: 4 },
      files: {
        'packages/kernel/src/legacy.ts': { emptyCatch: 2, typeEscape: 1, syncIo: 1, lintSuppress: 0 },
      },
    }
    write('arch/ai-smells-baseline.json', JSON.stringify(tampered, null, 2))
    const failBase = cli('--enforce', '--base', 'base')
    assert.equal(failBase.status, 1, failBase.out)
    assert.match(failBase.out, /baseline-raised/)
  })
})
