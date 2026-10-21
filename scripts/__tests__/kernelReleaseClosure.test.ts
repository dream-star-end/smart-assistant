// OCV5-546 (phase 3 plan v3.6 P0c, appendix D.2): @openclaude/kernel's release closure. Every list
// that decides whether a workspace package is installed, type-checked, gated, deployed and
// precompiled for containers must name kernel, before any production code imports it.
// Run: npx tsx --test scripts/__tests__/kernelReleaseClosure.test.ts
import assert from 'node:assert/strict'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { COMPOSITE_PROJECTS, TYPECHECK_DEPENDENTS, selectGates } from '../select-gates.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8')
const json = (p: string) => JSON.parse(read(p))
const KERNEL = 'packages/kernel'

describe('kernel release closure', () => {
  test('workspace in package.json and package-lock.json (root list, link, package entry)', () => {
    const ws: string[] = json('package.json').workspaces
    assert.ok(ws.includes(KERNEL))
    const lock = json('package-lock.json')
    assert.deepEqual(lock.packages[''].workspaces, ws, 'lock workspaces = package.json workspaces')
    assert.deepEqual(lock.packages['node_modules/@openclaude/kernel'], {
      resolved: KERNEL,
      link: true,
    })
    assert.equal(lock.packages[KERNEL]?.name, '@openclaude/kernel')
  })

  test('exports: . and ./node, each with types, openclaude-precompiled dist and default source', () => {
    const pkg = json(`${KERNEL}/package.json`)
    assert.equal(pkg.name, '@openclaude/kernel')
    assert.equal(pkg.dependencies, undefined, 'L1 core: no dependencies')
    for (const [sub, file] of [
      ['.', 'index'],
      ['./node', 'node'],
    ]) {
      assert.deepEqual(pkg.exports[sub!], {
        types: `./src/${file}.ts`,
        'openclaude-precompiled': `./dist/${file}.js`,
        default: `./src/${file}.ts`,
      })
      assert.ok(existsSync(path.join(ROOT, KERNEL, `src/${file}.ts`)))
    }
  })

  test('container precompile picks it up: workspace, not skipped, has .ts sources', () => {
    // packages/cli/scripts/build-container-gateway.mjs compiles every workspace package with a
    // src/ dir except web, web-react, desktop; a src/ without .ts files emits no dist at all.
    const builder = read('packages/cli/scripts/build-container-gateway.mjs')
    assert.match(builder, /const SKIP = new Set\(\["web", "web-react", "desktop"\]\);/)
    assert.match(builder, /pkgJson\(repoRoot\)\.workspaces/)
    assert.ok(readdirSync(path.join(ROOT, KERNEL, 'src')).some((f) => f.endsWith('.ts')))
  })

  test('tsc --build graph: root references = COMPOSITE_PROJECTS, kernel included', () => {
    const refs = json('tsconfig.json').references.map((r: { path: string }) =>
      r.path.replace(/^\.\//, ''),
    )
    assert.deepEqual([...refs].sort(), [...COMPOSITE_PROJECTS].sort())
    assert.ok(refs.includes(KERNEL))
    // every workspace package that depends on kernel references it in its tsconfig and is rebuilt
    // when kernel changes (TYPECHECK_DEPENDENTS), together with its own dependents
    const ws: string[] = json('package.json').workspaces
    for (const dir of ws) {
      if (!existsSync(path.join(ROOT, dir, 'package.json'))) continue
      const deps = json(`${dir}/package.json`).dependencies ?? {}
      if (!('@openclaude/kernel' in deps)) continue
      const tsc = json(`${dir}/tsconfig.json`)
      assert.ok(
        tsc.references?.some((r: { path: string }) => r.path === '../kernel'),
        `${dir} tsconfig references kernel`,
      )
      const dependents: string[] = TYPECHECK_DEPENDENTS[KERNEL]
      assert.ok(dependents.includes(dir), `${dir} is a typecheck dependent of kernel`)
      for (const d of (TYPECHECK_DEPENDENTS as Record<string, string[]>)[dir] ?? [])
        assert.ok(
          dependents.includes(d),
          `${d} (dependent of ${dir}) is a typecheck dependent of kernel`,
        )
    }
    assert.equal(json(`${KERNEL}/tsconfig.json`).extends, '../../tsconfig.base.json')
  })

  test('select-gates: a kernel-only change selects typecheck of kernel, not nothing', () => {
    const sel = selectGates([`${KERNEL}/src/index.ts`])
    assert.ok(sel.selected.includes('typecheck'), JSON.stringify(sel.selected))
    assert.ok(
      sel.triggers.typecheck?.some((t) => t.ruleId === 'kernel'),
      JSON.stringify(sel.triggers),
    )
    assert.deepEqual(
      [...sel.typecheck.projects].sort(),
      [KERNEL, ...TYPECHECK_DEPENDENTS[KERNEL]].sort(),
    )
  })

  test('deploy surfaces: kernel drives the master process and the runtime source release', () => {
    const m = json('deploy/v5/selfheal-deploy-surfaces.json')
    const surfaces = m.rules
      .filter((r: { glob: string }) => r.glob === `${KERNEL}/**`)
      .map((r: { surface: string }) => r.surface)
      .sort()
    assert.deepEqual(surfaces, ['master', 'runtime-source'])
  })

  test('architecture map and incident-trailer surfaces include kernel', () => {
    const mods = json('arch/modules.json').modules
    assert.equal(mods.kernel?.layer, 'L1')
    assert.deepEqual(mods.kernel?.match, [`${KERNEL}/src/**`])
    assert.match(read('scripts/check-v5-fix-trailers.sh'), /^SURFACES=\(.* packages\/kernel\/\)$/m)
    assert.match(
      read('scripts/check-v5-incident-regressions.ts'),
      /const TRAILER_GATE_SURFACES = \[[^\]]*"packages\/kernel\/",\n\];/,
    )
    assert.ok(selectGates([`${KERNEL}/src/x.ts`]).selected.includes('check:v5:incidents'))
  })

  test('installed: node_modules link points at this checkout and both entries load', async () => {
    const link = path.join(ROOT, 'node_modules/@openclaude/kernel')
    assert.ok(
      existsSync(link) && lstatSync(link).isSymbolicLink(),
      'node_modules/@openclaude/kernel missing: run npm ci (package-lock.json changed)',
    )
    assert.equal(realpathSync(link), realpathSync(path.join(ROOT, KERNEL)))
    const core = await import('@openclaude/kernel')
    assert.equal(core.KERNEL_PACKAGE, '@openclaude/kernel')
    const node = await import('@openclaude/kernel/node')
    assert.equal(node.KERNEL_NODE_ENTRY, '@openclaude/kernel/node')
  })
})
