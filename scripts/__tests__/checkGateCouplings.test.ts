// OCV5-544: scripts/check-gate-couplings.ts — a PR that moves or deletes a path a gate names must
// change that gate too. Run: npx tsx --test scripts/__tests__/checkGateCouplings.test.ts
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { couplingsOf, isGate, pathsNamedBy, treeOf, uncovered } from '../check-gate-couplings.ts'

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../check-gate-couplings.ts',
)

describe('couplings', () => {
  const tree = treeOf([
    'packages/a/src/x.ts',
    'packages/a/src/sub/y.ts',
    'scripts/check-a.ts',
    'scripts/__tests__/fixtures/f.ts',
    'arch/gate-couplings.json',
    'docs/V5_CI.md',
    'docs/other.md',
  ])
  test('gate files are scripts, workflows, manifests and tsconfigs; not the snapshot or fixtures', () => {
    assert.equal(isGate('scripts/check-a.ts'), true)
    assert.equal(isGate('.github/workflows/v5-selfhost-gates.yml'), true)
    assert.equal(isGate('deploy/v5/selfheal-deploy-surfaces.json'), true)
    assert.equal(isGate('packages/gateway/tsconfig.json'), true)
    assert.equal(isGate('docs/V5_CI.md'), true)
    assert.equal(isGate('docs/other.md'), false)
    assert.equal(isGate('arch/gate-couplings.json'), false)
    assert.equal(isGate('scripts/__tests__/fixtures/f.ts'), false)
    assert.equal(isGate('scripts/__tests__/checkGateCouplings.test.ts'), false)
    assert.equal(isGate('packages/a/src/x.ts'), false)
  })
  test('named paths: tracked files and dirs only, cut at globs and interpolation, self excluded', () => {
    const text = [
      "const F = 'packages/a/src/x.ts'",
      'const D = `packages/a/src/${name}.ts`',
      "glob('packages/a/src/sub/**/*.ts')",
      "'packages/a/src/gone.ts', 'scripts/check-a.ts', see packages/a/src/x.ts.",
    ].join('\n')
    assert.deepEqual(pathsNamedBy('scripts/check-a.ts', text, tree), [
      'packages/a/src',
      'packages/a/src/sub',
      'packages/a/src/x.ts',
    ])
  })
  test('quoted ./ ../ strings resolve against the gate directory (tsconfig paths, imports)', () => {
    const t = treeOf([
      'packages/protocol/src/index.ts',
      'packages/gateway/tsconfig.json',
      'scripts/lib/x.mjs',
    ])
    assert.deepEqual(
      pathsNamedBy(
        'packages/gateway/tsconfig.json',
        '{"paths":{"@p":["../protocol/src/index.ts"]},"x":"../../../etc"}',
        t,
      ),
      ['packages/protocol/src/index.ts'],
    )
    assert.deepEqual(pathsNamedBy('scripts/check.ts', "import x from './lib/x.mjs'", t), [
      'scripts/lib/x.mjs',
    ])
  })
  test('couplingsOf drops gates that name nothing', () => {
    const c = couplingsOf(tree, (g) => (g === 'scripts/check-a.ts' ? "'packages/a/src/x.ts'" : ''))
    assert.deepEqual(c, { 'scripts/check-a.ts': ['packages/a/src/x.ts'] })
  })
})

describe('uncovered', () => {
  const c = { 'scripts/g.ts': ['packages/a/src/x.ts', 'packages/a/src/dir'] }
  const OLD = "'packages/a/src/x.ts'; glob('packages/a/src/dir/*.ts')"
  const head = (files: string[], gateText: string | null = OLD, gateAt = 'scripts/g.ts') => ({
    tree: treeOf(gateText === null ? files : [...files, gateAt]),
    gatePath: (g: string) => (gateText === null ? null : g === 'scripts/g.ts' ? gateAt : g),
    text: () => gateText ?? '',
  })
  const mv = (from: string, to: string) => ({ status: 'renamed' as const, from, to })
  const coupled = (hits: { gate: string; coupled: string }[]) =>
    hits.map((h) => `${h.gate}|${h.coupled}`)

  test('a moved coupled file the gate still names is uncovered', () => {
    const hits = uncovered(
      c,
      [mv('packages/a/src/x.ts', 'packages/a/src/x2.ts')],
      head(['packages/a/src/x2.ts', 'packages/a/src/dir/k.ts']),
    )
    assert.deepEqual(coupled(hits), ['scripts/g.ts|packages/a/src/x.ts'])
  })
  test('editing the gate elsewhere does not cover it; renaming the gate does not hide it', () => {
    const edited = `${OLD}\n// unrelated edit`
    assert.equal(
      uncovered(
        c,
        [mv('packages/a/src/x.ts', 'y.ts')],
        head(['y.ts', 'packages/a/src/dir/k.ts'], edited),
      ).length,
      1,
    )
    assert.deepEqual(
      coupled(uncovered(c, [], head(['packages/a/src/dir/k.ts'], OLD, 'scripts/g2.ts'))),
      ['scripts/g2.ts|packages/a/src/x.ts'],
    )
  })
  test('the gate that now names the new path, or was deleted, covers it', () => {
    const now = "'packages/a/src/x2.ts'; glob('packages/a/src/dir/*.ts')"
    assert.deepEqual(
      uncovered(c, [], head(['packages/a/src/x2.ts', 'packages/a/src/dir/k.ts'], now)),
      [],
    )
    assert.deepEqual(uncovered(c, [], head(['packages/a/src/dir/k.ts'], null)), [])
  })
  test('a coupled directory: moves inside are fine; it fires once no tracked file is left', () => {
    const files = ['packages/a/src/x.ts']
    assert.deepEqual(uncovered(c, [], head([...files, 'packages/a/src/dir/k2.ts'])), [])
    const hits = uncovered(
      c,
      [mv('packages/a/src/dir/k.ts', 'packages/b/k.ts')],
      head([...files, 'packages/b/k.ts']),
    )
    assert.deepEqual(coupled(hits), ['scripts/g.ts|packages/a/src/dir'])
    assert.equal(hits[0]!.change.from, 'packages/a/src/dir/k.ts')
  })
  test('a thin re-export left at the old path keeps the coupling satisfied', () => {
    assert.deepEqual(
      uncovered(
        c,
        [],
        head(['packages/a/src/x.ts', 'packages/a/src/x2.ts', 'packages/a/src/dir/k.ts']),
      ),
      [],
    )
  })
})

describe('CLI', () => {
  const setup = (t: { after(fn: () => void): void }) => {
    const root = mkdtempSync(path.join(tmpdir(), 'gate-couplings-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const put = (rel: string, text: string) => {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
      writeFileSync(path.join(root, rel), text)
    }
    const git = (...a: string[]) => execFileSync('git', a, { cwd: root, encoding: 'utf8' })
    put('packages/a/src/x.ts', 'export const x = 1\n')
    put('packages/a/src/y.ts', 'export const y = 1\n')
    put('scripts/check-x.ts', "const F = 'packages/a/src/x.ts'\n")
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
    return { root, put, git }
  }
  const run = (root: string, ...a: string[]) =>
    spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, '--root', root, ...a], {
      encoding: 'utf8',
    })

  test('--write then --check; a gate naming a new path makes the snapshot stale', (t) => {
    const { root, put, git } = setup(t)
    git('add', '-A')
    git('commit', '-qm', 'base')
    assert.equal(run(root, '--write').status, 0)
    const snap = JSON.parse(readFileSync(path.join(root, 'arch/gate-couplings.json'), 'utf8'))
    assert.deepEqual(snap.byGate, { 'scripts/check-x.ts': ['packages/a/src/x.ts'] })
    assert.equal(run(root, '--check').status, 0)
    put('scripts/check-x.ts', "const F = 'packages/a/src/x.ts'\nconst G = 'packages/a/src/y.ts'\n")
    const stale = run(root, '--check')
    assert.equal(stale.status, 0, 'report period')
    assert.match(stale.stdout, /STALE/)
    assert.equal(run(root, '--check', '--enforce').status, 1)
  })

  test('--write sees new, not yet committed gate files and ignores deleted ones', (t) => {
    const { root, put, git } = setup(t)
    git('add', '-A')
    git('commit', '-qm', 'base')
    put('scripts/check-new.ts', "const F = 'packages/a/src/y.ts'\n")
    rmSync(path.join(root, 'scripts/check-x.ts'))
    assert.equal(run(root, '--write').status, 0)
    const snap = JSON.parse(readFileSync(path.join(root, 'arch/gate-couplings.json'), 'utf8'))
    assert.deepEqual(snap.byGate, { 'scripts/check-new.ts': ['packages/a/src/y.ts'] })
  })

  test('--base: moving a coupled file without the gate is UNCOVERED; changing the gate covers it', (t) => {
    const { root, git } = setup(t)
    git('add', '-A')
    git('commit', '-qm', 'base')
    git('mv', 'packages/a/src/x.ts', 'packages/a/src/x-moved.ts')
    git('commit', '-qm', 'move')
    const r = run(root, '--base', 'main~1')
    assert.equal(r.status, 0, 'report period')
    assert.match(
      r.stdout,
      /UNCOVERED packages\/a\/src\/x\.ts \(renamed → packages\/a\/src\/x-moved\.ts\): scripts\/check-x\.ts still names it/,
    )
    assert.equal(run(root, '--base', 'main~1', '--enforce').status, 1)
    writeFileSync(path.join(root, 'scripts/check-x.ts'), "const F = 'packages/a/src/x-moved.ts'\n")
    git('commit', '-qam', 'gate follows')
    assert.equal(run(root, '--base', 'main~2', '--enforce').status, 0)
  })

  test('--base reads gates at the merge base, and an unrelated gate edit does not cover a move', (t) => {
    const { root, git } = setup(t)
    git('add', '-A')
    git('commit', '-qm', 'base')
    git('checkout', '-qb', 'pr')
    git('mv', 'packages/a/src/x.ts', 'packages/a/src/x-moved.ts')
    writeFileSync(
      path.join(root, 'scripts/check-x.ts'),
      "const F = 'packages/a/src/x.ts'\n// edited\n",
    )
    git('commit', '-qam', 'move + unrelated gate edit')
    git('checkout', '-q', 'main')
    writeFileSync(path.join(root, 'scripts/check-x.ts'), 'const F = 0\n')
    git('commit', '-qam', 'base moves on: the gate no longer names x.ts on main')
    git('checkout', '-q', 'pr')
    const r = run(root, '--base', 'main', '--enforce')
    assert.equal(r.status, 1, r.stdout)
    assert.match(r.stdout, /UNCOVERED packages\/a\/src\/x\.ts \(renamed/)
  })

  test('deleting a coupled file and leaving the gate is uncovered', (t) => {
    const { root, git } = setup(t)
    git('add', '-A')
    git('commit', '-qm', 'base')
    git('rm', '-q', 'packages/a/src/x.ts')
    git('commit', '-qm', 'delete only')
    assert.match(
      run(root, '--base', 'main~1').stdout,
      /UNCOVERED packages\/a\/src\/x\.ts \(deleted\)/,
    )
  })

  test('fails closed: bad ref, unknown argument, no mode, missing snapshot for --check', (t) => {
    const { root, git } = setup(t)
    git('add', '-A')
    git('commit', '-qm', 'base')
    assert.equal(run(root, '--base', 'no-such-ref').status, 2)
    assert.equal(run(root, '--bogus').status, 2)
    assert.equal(run(root).status, 2)
    assert.equal(run(root, '--check').status, 2)
  })
})
