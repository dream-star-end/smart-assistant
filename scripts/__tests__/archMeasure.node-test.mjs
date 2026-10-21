// OCV5-540: the measurement helpers behind scripts/arch-measure/* (import scan, resolution, SCC)
// and the train-summary reader. Run: node --test scripts/__tests__/archMeasure.node-test.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { isProdTs, resolveRelative, scanImports, scc, stripComments } from '../arch-measure/lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

test('scanImports: value vs type, re-exports, side effects, dynamic, require', () => {
  const src = [
    'import a from "./a.js";',
    'import type { B } from "./b.js";',
    'import { c, type D } from "./c.js";',
    'export { e } from "./e.js";',
    'export type { F } from "./f.js";',
    'export * from "./g.js";',
    'import "./side.js";',
    'const h = await import("./h.js");',
    'const i = require("./i.js");',
    "// import x from './commented.js';",
    "/* import y from './block.js'; */",
    'export function notAReExport() { return 1; }',
    'const s = "from \'./not-an-import.js\'";',
  ].join('\n')
  const got = scanImports(src)
    .map((r) => `${r.kind}:${r.spec}`)
    .sort()
  assert.deepEqual(got, [
    'type:./b.js',
    'type:./f.js',
    'value:./a.js',
    'value:./c.js',
    'value:./e.js',
    'value:./g.js',
    'value:./h.js',
    'value:./i.js',
    'value:./side.js',
  ])
})

test('scanImports: import("x") in type position is a type reference, not a runtime edge (Codex r1)', () => {
  const src = [
    'let a: import("./t1.js").Foo;',
    'type B = typeof import("./t2.js");',
    'const c = await import("./v1.js");',
    'import("./v2.js").then((m) => m.run());',
    'const d = (await import("./v3.js")).default;',
  ].join('\n')
  const got = scanImports(src)
    .map((r) => `${r.kind}:${r.spec}`)
    .sort()
  assert.deepEqual(got, [
    'type:./t1.js',
    'type:./t2.js',
    'value:./v1.js',
    'value:./v2.js',
    'value:./v3.js',
  ])
})

test('scanImports stays linear on a large file without imports', () => {
  const big = 'export function f() { return 1; }\n'.repeat(20000)
  const t0 = Date.now()
  assert.equal(scanImports(big).length, 0)
  assert.ok(Date.now() - t0 < 2000, 'no catastrophic backtracking')
})

test('stripComments keeps offsets and strings', () => {
  const s = 'a // x\nb /* y\nz */ c "// not a comment"'
  const o = stripComments(s)
  assert.equal(o.length, s.length)
  assert.ok(o.includes('"// not a comment"'))
  assert.ok(!o.includes('x') && !o.includes('y'))
})

test("isProdTs follows the plan's non-test rule", () => {
  assert.equal(isProdTs('packages/x/src/a.ts'), true)
  assert.equal(isProdTs('packages/x/src/a.tsx'), true)
  assert.equal(isProdTs('packages/x/src/a.test.ts'), false)
  assert.equal(isProdTs('packages/x/src/__tests__/a.ts'), false)
  assert.equal(isProdTs('packages/x/src/a.js'), false)
})

test('resolveRelative maps .js to .ts and directories to index', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'arch-measure-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(path.join(root, 'p/d'), { recursive: true })
  writeFileSync(path.join(root, 'p/a.ts'), '')
  writeFileSync(path.join(root, 'p/d/index.ts'), '')
  assert.equal(resolveRelative(root, 'p/x.ts', './a.js'), 'p/a.ts')
  assert.equal(resolveRelative(root, 'p/x.ts', './d'), 'p/d/index.ts')
  assert.equal(resolveRelative(root, 'p/x.ts', './missing.js'), null)
  assert.equal(resolveRelative(root, 'p/x.ts', '@scope/pkg'), null)
})

test('scc finds cycles and leaves acyclic nodes alone', () => {
  const g = new Map([
    ['a', new Set(['b'])],
    ['b', new Set(['c'])],
    ['c', new Set(['a', 'd'])],
    ['d', new Set()],
    ['e', new Set(['e'])],
  ])
  const comps = scc(g)
    .map((c) => c.join(','))
    .sort()
  assert.deepEqual(comps, ['a,b,c', 'd', 'e'])
})

test('trains.mjs --check-last: complete vs incomplete summaries', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'arch-trains-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const phases = [
    'A',
    'B',
    ...Array.from({ length: 10 }, (_, i) => `C.g${i}`),
    'D',
    'P.seal',
    'E1',
    'E2',
    'E3.units',
    'E4',
    'F.S1',
    'G',
  ].map((id) => ({ id, durationMs: 10 }))
  const put = (id, s) => {
    writeFileSync(path.join(dir, `${id}.log`), '')
    if (s) writeFileSync(path.join(dir, `${id}.summary.json`), JSON.stringify(s))
  }
  put('tr-20990101T000001Z-a', {
    schema: 'oc.v5.selfhost.train-summary/1',
    final: true,
    result: 'success',
    durationMs: 220,
    phases,
  })
  put('tr-20990101T000002Z-b', {
    schema: 'oc.v5.selfhost.train-summary/1',
    final: true,
    result: 'failed',
    failedPhase: 'C.g3',
    durationMs: 50,
    phases: phases.slice(0, 5),
  })
  const run = (...a) =>
    spawnSync(
      process.execPath,
      [path.join(here, '../arch-measure/trains.mjs'), '--dir', dir, ...a],
      { encoding: 'utf8' },
    )
  assert.equal(run('--check-last', '2').status, 0)
  put('tr-20990101T000003Z-c', null)
  const r = run('--check-last', '2')
  assert.equal(r.status, 1)
  assert.match(r.stdout, /1 of 2 incomplete/)
  put('tr-20990101T000004Z-d', {
    schema: 'oc.v5.selfhost.train-summary/1',
    final: true,
    result: 'success',
    durationMs: 1,
    phases: phases.filter((p) => p.id !== 'F.S1'),
  })
  assert.match(run('--check-last', '1').stdout, /missing F/)
  const j = JSON.parse(run('--json').stdout)
  assert.equal(j.success, 2)
  assert.deepEqual(j.failedPhases, { 'C.g3': 1 })
})

test('deps.mjs maps @openclaude/channel-* to packages/channels/* so a package cycle is seen (Codex r1)', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'arch-deps-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const put = (rel, text) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    writeFileSync(path.join(root, rel), text)
  }
  put(
    'packages/gateway/src/a.ts',
    'import { x } from "@openclaude/channel-wechat";\nexport const y = x;\n',
  )
  put(
    'packages/channels/wechat/src/b.ts',
    'import { y } from "@openclaude/gateway";\nexport const x = y;\n',
  )
  put('packages/commercial/src/index.ts', 'export {};\n')
  const r = spawnSync(
    process.execPath,
    [path.join(here, '../arch-measure/deps.mjs'), '--root', root, '--json'],
    { encoding: 'utf8' },
  )
  assert.equal(r.status, 0, r.stderr)
  const rows = Object.fromEntries(JSON.parse(r.stdout).rows.map((x) => [x.id, x.value]))
  assert.equal(rows['pkg.cycles'], 1)
  assert.equal(rows['pkg.cycleMembers'], 'channels/wechat+gateway')
})

test('als-overhead.mjs runs both modes in child processes and reports an overhead (OCV5-560)', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'als-overhead-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const out = path.join(dir, 'r.json')
  const r = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      path.join(here, '../arch-measure/als-overhead.mjs'),
      '--turns',
      '2',
      '--steps',
      '5',
      '--repeats',
      '2',
      '--json',
      out,
    ],
    { encoding: 'utf8' },
  )
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /\[als-overhead\] node v\d+.*overhead=-?\d/)
  const rep = JSON.parse(readFileSync(out, 'utf8'))
  assert.equal(rep.runs.off.length, 2)
  assert.equal(rep.runs.als.length, 2)
  assert.equal(typeof rep.overheadPct, 'number')
  assert.equal(rep.underOnePercent, rep.overheadPct < 1)
})
