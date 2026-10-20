// OCV5-543: scripts/check-architecture.ts — every rule has a red and a green case, the baseline only
// shrinks, and the checker fails closed. Run: npx tsx --test scripts/__tests__/checkArchitecture.test.ts
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ModuleMap, check, compare, factsOf, globToRegExp, tally } from '../check-architecture.ts'

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../check-architecture.ts',
)

const MODULES = {
  schema: 1,
  modules: {
    proto: { layer: 'L0', match: ['packages/proto/src/**'], scope: ['a', 'b'] },
    base: {
      layer: 'L2',
      match: ['packages/app/src/base/**'],
      scope: ['a', 'b'],
      authorities: ['env'],
    },
    dom1: { layer: 'L3', match: ['packages/app/src/dom1/**'], scope: ['a'], allow: ['dom2'] },
    dom2: { layer: 'L3', match: ['packages/app/src/dom2/**'], scope: ['a'] },
    shared: { layer: 'L3', match: ['packages/app/src/shared/**'], scope: ['a', 'b'] },
    api: {
      layer: 'L5',
      match: ['packages/app/src/api/**'],
      scope: ['a'],
      authorities: ['handler-auth'],
    },
    other: { layer: 'L3', match: ['packages/other/src/**'], scope: ['a'] },
  },
}

function repo(
  t: { after(fn: () => void): void },
  files: Record<string, string>,
  modules: unknown = MODULES,
): string {
  const root = mkdtempSync(path.join(tmpdir(), 'arch-check-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const put = (rel: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    writeFileSync(path.join(root, rel), text)
  }
  put('packages/proto/package.json', '{"name":"@x/proto"}')
  put('packages/app/package.json', '{"name":"@x/app"}')
  put('packages/other/package.json', '{"name":"@x/other"}')
  put('packages/proto/src/index.ts', 'export const P = 1;\n')
  put('packages/other/src/inner.ts', 'export const O = 1;\n')
  put('packages/app/src/base/b.ts', 'export const B = process.env.X;\n')
  put('packages/app/src/dom2/d.ts', 'export const D = 1;\n')
  for (const [k, v] of Object.entries(files)) put(k, v)
  put('arch/modules.json', JSON.stringify(modules))
  return root
}
const rules = (root: string) =>
  check(root, new ModuleMap(MODULES as never))
    .violations.map((v) => `${v.rule}|${v.file.split('/').pop()}|${v.target}`)
    .sort()

describe('check-architecture rules', () => {
  test('R1: an unmapped production file is a violation; tests and .d.ts are not production', (t) => {
    const root = repo(t, {
      'packages/app/src/stray.ts': 'export {};\n',
      'packages/app/src/dom1/x.test.ts': 'export {};\n',
      'packages/app/src/dom1/y.d.ts': 'export {};\n',
    })
    assert.deepEqual(rules(root), ['R1-unmapped|stray.ts|-'])
  })

  test('R2: downward and allowed same-layer edges are fine; upward, unlisted same-layer, scope widening are not', (t) => {
    const root = repo(t, {
      'packages/app/src/dom1/ok.ts':
        'import { B } from "../base/b.js";\nimport { D } from "../dom2/d.js";\nimport { P } from "@x/proto";\nexport const y = [B, D, P];\n',
      'packages/app/src/dom2/bad.ts':
        'import { x } from "../api/h.js";\nimport { z } from "../dom1/ok.js";\nexport const w = [x, z];\n',
      'packages/app/src/api/h.ts': 'export const x = 1;\n',
      'packages/app/src/shared/s.ts': 'import { D } from "../dom2/d.js";\nexport const s = D;\n',
    })
    assert.deepEqual(rules(root), [
      'R2-same-layer|bad.ts|dom1',
      'R2-same-layer|s.ts|dom2',
      'R2-scope|s.ts|dom2',
      'R2-upward|bad.ts|api',
    ])
  })

  test('R2: type-only imports are not edges', (t) => {
    const root = repo(t, {
      'packages/app/src/dom2/t.ts':
        'import type { x } from "../api/h.js";\nimport { type y } from "../api/h.js";\nexport type { z } from "../api/h.js";\nlet a: import("../api/h.js").X;\nexport {};\n',
      'packages/app/src/api/h.ts': 'export const x = 1; export const y = 1; export const z = 1;\n',
    })
    assert.deepEqual(rules(root), [])
  })

  test('R2: export * in a module index, cross-package relative reads, non-literal import(), node:* in an L0 contract, test code imported by production', (t) => {
    const root = repo(t, {
      'packages/app/src/dom2/index.ts': 'export * from "./d.js";\n',
      'packages/app/src/dom2/peek.ts':
        'import { O } from "../../../other/src/inner.js";\nexport const p = O;\n',
      'packages/app/src/dom2/dyn.ts': 'export async function f(n: string) { return import(n); }\n',
      'packages/app/src/dom2/usesTest.ts':
        "import { h } from './__tests__/helper.js';\nexport const u = h;\n",
      'packages/app/src/dom2/__tests__/helper.ts': 'export const h = 1;\n',
      'packages/proto/src/n.ts':
        'import { randomUUID } from "node:crypto";\nexport const u = randomUUID;\n',
    })
    assert.deepEqual(rules(root), [
      'R2-contract-node|n.ts|node:crypto',
      'R2-cross-package-internal|peek.ts|packages/other/src/inner.ts',
      'R2-dynamic-import|dyn.ts|-',
      'R2-export-star|index.ts|-',
      'R2-imports-test-code|usesTest.ts|packages/app/src/dom2/__tests__/helper.ts',
      'R2-same-layer|peek.ts|other',
    ])
  })

  test('R3: single authorities, and the module registered for one is exempt', (t) => {
    const root = repo(t, {
      'packages/app/src/dom2/env.ts':
        "const e = process.env;\nconst f = process['env'].Y;\nconst g = globalThis.process.env.Z;\nexport { e, f, g };\n",
      'packages/app/src/dom2/net.ts':
        'import { request } from "node:https";\nexport const r = () => fetch("https://x") && globalThis.fetch("y") && request;\n',
      'packages/app/src/dom2/cry.ts':
        'import { createHmac, timingSafeEqual } from "node:crypto";\nexport const c = () => createHmac("sha256", "k") && timingSafeEqual(Buffer.from(""), Buffer.from(""));\n',
      'packages/app/src/dom2/sql.ts':
        "export const q = `UPDATE users SET credits = credits - $1 WHERE id = $2`;\nexport const r = 'INSERT INTO credit_ledger (a) VALUES (1)';\nexport const ok = 'SELECT * FROM credit_ledger';\n",
      'packages/app/src/dom2/auth.ts':
        'declare const requireAuth: (r: unknown) => void;\nexport const h = (req: unknown) => requireAuth(req);\n',
      'packages/app/src/api/auth.ts':
        'declare const requireAuth: (r: unknown) => void;\nexport const h = (req: unknown) => requireAuth(req);\n',
      'packages/app/src/dom2/sp.ts':
        'declare const o: { provider: string; engineId: string };\nexport const a = o.provider === "box" || "grok" !== o.engineId;\nexport const ok = o.provider === o.engineId;\n',
    })
    assert.deepEqual(rules(root), [
      'R3-billing-sql|sql.ts|-',
      'R3-billing-sql|sql.ts|-',
      'R3-crypto|cry.ts|-',
      'R3-crypto|cry.ts|-',
      'R3-env|env.ts|-',
      'R3-env|env.ts|-',
      'R3-env|env.ts|-',
      'R3-handler-auth|auth.ts|-',
      'R3-net|net.ts|-',
      'R3-net|net.ts|-',
      'R3-net|net.ts|-',
      'R3-special-case|sp.ts|-',
      'R3-special-case|sp.ts|-',
    ])
  })
})

describe('baseline (rule 4)', () => {
  test('counts may not grow, new identities fail, removed ones are stale; renames carry entries', () => {
    const base = { 'R3-env|a.ts|-': 2, 'R2-upward|b.ts|api': 1, 'R3-net|old.ts|-': 1 }
    const { grown, stale } = compare(
      base,
      { 'R3-env|a.ts|-': 3, 'R2-upward|c.ts|api': 1, 'R3-net|new.ts|-': 1 },
      new Map([['old.ts', 'new.ts']]),
    )
    assert.deepEqual(
      grown.map((g) => g.key),
      ['R3-env|a.ts|-', 'R2-upward|c.ts|api'],
    )
    assert.deepEqual(
      stale.map((s) => s.key),
      ['R2-upward|b.ts|api'],
    )
    assert.deepEqual(compare(base, base), { grown: [], stale: [] })
  })

  test('trading an old violation for a new one in the same file is still red', () => {
    const { grown, stale } = compare({ 'R3-env|a.ts|-': 1 }, { 'R3-net|a.ts|-': 1 })
    assert.equal(grown.length, 1)
    assert.equal(stale.length, 1)
  })

  test('tally keys are rule|file|target with counts', () => {
    assert.deepEqual(
      tally([
        { rule: 'R', file: 'f', target: '-' },
        { rule: 'R', file: 'f', target: '-' },
      ]),
      { 'R|f|-': 2 },
    )
  })
})

describe('module map', () => {
  test('globs: * stays in one segment, ** spans segments', () => {
    assert.ok(globToRegExp('a/*.ts').test('a/b.ts'))
    assert.ok(!globToRegExp('a/*.ts').test('a/b/c.ts'))
    assert.ok(globToRegExp('a/**').test('a/b/c.ts'))
    assert.ok(globToRegExp('a/**/x.ts').test('a/x.ts'))
  })
  test('the most specific match wins; an equal tie between modules fails closed', () => {
    const m = new ModuleMap({
      schema: 1,
      modules: { all: { layer: 'L3', match: ['p/**'] }, one: { layer: 'L2', match: ['p/x/*.ts'] } },
    } as never)
    assert.equal(m.moduleOf('p/x/a.ts'), 'one')
    assert.equal(m.moduleOf('p/y.ts'), 'all')
    const tie = new ModuleMap({
      schema: 1,
      modules: { a: { layer: 'L3', match: ['p/*.ts'] }, b: { layer: 'L3', match: ['p/*.ts'] } },
    } as never)
    assert.deepEqual(tie.ambiguous('p/z.ts'), ['a', 'b'])
  })
  test('invalid definitions are rejected: unknown layer, unknown allow, same-layer allow cycle', () => {
    assert.throws(
      () => new ModuleMap({ schema: 1, modules: { a: { layer: 'L9', match: ['x'] } } } as never),
      /unknown layer/,
    )
    assert.throws(
      () =>
        new ModuleMap({
          schema: 1,
          modules: { a: { layer: 'L3', match: ['x'], allow: ['zz'] } },
        } as never),
      /unknown module/,
    )
    assert.throws(
      () =>
        new ModuleMap({
          schema: 1,
          modules: {
            a: { layer: 'L3', match: ['x'], allow: ['b'] },
            b: { layer: 'L3', match: ['y'], allow: ['a'] },
          },
        } as never),
      /cycle/,
    )
  })
  test('parse errors are reported, not treated as no violations', () => {
    assert.throws(() => factsOf('x.ts', 'export const = ;\n'))
  })
})

describe('CLI', () => {
  const run = (root: string, ...a: string[]) =>
    spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, '--root', root, ...a], {
      encoding: 'utf8',
    })
  test('fails closed without a baseline or with an invalid modules.json', (t) => {
    const root = repo(t, {})
    assert.equal(run(root).status, 2)
    writeFileSync(path.join(root, 'arch/modules.json'), '{')
    assert.equal(run(root, '--write-baseline').status, 2)
  })
  test('report mode exits 0 on new violations, enforce mode exits 1; rename is followed with --base', (t) => {
    const root = repo(t, { 'packages/app/src/dom2/e.ts': 'export const e = process.env.A;\n' })
    assert.equal(run(root, '--write-baseline').status, 0)
    assert.equal(run(root, '--enforce').status, 0)
    writeFileSync(
      path.join(root, 'packages/app/src/dom2/e2.ts'),
      'export const e2 = process.env.B;\n',
    )
    const rep = run(root)
    assert.equal(rep.status, 0)
    assert.match(rep.stdout, /NEW\/GROWN R3-env\|packages\/app\/src\/dom2\/e2\.ts\|- 0 → 1/)
    assert.equal(run(root, '--enforce').status, 1)
    rmSync(path.join(root, 'packages/app/src/dom2/e2.ts'))
    const git = (...a: string[]) => execFileSync('git', a, { cwd: root, encoding: 'utf8' })
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
    git('add', '-A')
    git('commit', '-qm', 'base')
    git('mv', 'packages/app/src/dom2/e.ts', 'packages/app/src/dom2/renamed.ts')
    git('commit', '-qm', 'mv')
    assert.equal(run(root, '--enforce').status, 1, 'without --base the moved entry is stale + new')
    assert.equal(
      run(root, '--enforce', '--base', 'main~1').status,
      0,
      'git rename carries the entry',
    )
  })
})
