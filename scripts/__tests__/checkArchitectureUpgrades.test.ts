// OCV5-905: Living Architecture Map upgrades — frontend F0/F2/10×F4 real split,
// Tarjan SCC file-level cycle ban (R2-file-cycle), intramodule subdomain boundaries
// (R2-intramodule-boundary), and monotonic auxiliary baselines.
// Run: npx tsx --test scripts/__tests__/checkArchitectureUpgrades.test.ts
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  FILE_CYCLES_BASELINE_REL,
  ModuleMap,
  SUBDOMAIN_BASELINE_REL,
  check,
  compareFileCyclesBaseline,
  fileCycleKey,
  findFileCycles,
  productionFiles,
  tally,
  tallyFileCycles,
} from '../check-architecture.ts'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../check-architecture.ts',
)

const runCli = (root: string, ...args: string[]) =>
  spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, '--root', root, ...args], {
    encoding: 'utf8',
  })

function mkGitRepo(
  t: { after(fn: () => void): void },
  files: Record<string, string>,
  modules: unknown,
): string {
  const root = mkdtempSync(path.join(tmpdir(), 'arch-upgrades-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const put = (rel: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    writeFileSync(path.join(root, rel), text)
  }
  put('packages/app/package.json', '{"name":"@x/app"}')
  for (const [k, v] of Object.entries(files)) put(k, v)
  put('arch/modules.json', JSON.stringify(modules, null, 2))
  return root
}

function initGit(root: string): (...args: string[]) => string {
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@openclaude.local')
  git('config', 'user.name', 'arch-map-test')
  git('add', '-A')
  git('commit', '-qm', 'base')
  return git
}

describe('Real repo frontend F0/F2/10×F4 split & backend subdomains', () => {
  const modulesRaw = JSON.parse(readFileSync(path.join(REPO_ROOT, 'arch/modules.json'), 'utf8'))
  const map = new ModuleMap(modulesRaw)

  test('web-views is replaced by F0 primitives + F2 state + exactly 10 parallel F4 business domains (DAG-free)', () => {
    assert.equal('web-views' in modulesRaw.modules, false, 'monolithic web-views must be removed')
    assert.equal(map.get('web-primitives').layer, 'F0')
    assert.equal(map.get('web-lib').layer, 'F1')
    assert.equal(map.get('web-state').layer, 'F2')
    assert.equal(map.get('web-hooks').layer, 'F3')
    assert.equal(map.get('web-app').layer, 'F5')

    const expectedF4 = [
      'web-domain-admin',
      'web-domain-chat',
      'web-domain-iui',
      'web-domain-manage',
      'web-domain-settings',
      'web-domain-sidebar',
      'web-domain-sites',
      'web-domain-studio',
      'web-domain-swarm',
      'web-domain-workbench',
    ]
    const actualF4 = Object.entries(modulesRaw.modules)
      .filter(([, def]) => (def as { layer: string }).layer === 'F4')
      .map(([id]) => id)
      .sort()
    assert.deepEqual(actualF4, expectedF4)
    for (const id of expectedF4) {
      assert.deepEqual(
        map.get(id).allow ?? [],
        [],
        `${id} must remain a strict parallel domain with zero same-layer allow edges`,
      )
    }
  })

  test('every packages/web-react/src production file maps to exactly one module with zero gaps and zero overlaps', () => {
    const webFiles = productionFiles(REPO_ROOT).filter((f) =>
      f.startsWith('packages/web-react/src/'),
    )
    assert.ok(webFiles.length > 500, `expected >500 web-react prod files, got ${webFiles.length}`)
    const counts = new Map<string, number>()
    for (const f of webFiles) {
      const mod = map.moduleOf(f)
      assert.ok(mod, `unmapped frontend file: ${f}`)
      assert.deepEqual(map.ambiguous(f), [], `ambiguous frontend file: ${f}`)
      counts.set(mod, (counts.get(mod) ?? 0) + 1)
    }
    const mustBePopulated = [
      'web-primitives',
      'web-lib',
      'web-state',
      'web-hooks',
      'web-app',
      'web-domain-chat',
      'web-domain-sidebar',
      'web-domain-workbench',
      'web-domain-swarm',
      'web-domain-sites',
      'web-domain-settings',
      'web-domain-manage',
      'web-domain-admin',
      'web-domain-iui',
      'web-domain-studio',
    ]
    for (const mod of mustBePopulated) {
      assert.ok((counts.get(mod) ?? 0) >= 1, `frontend module ${mod} matched 0 production files`)
    }
    assert.equal(map.moduleOf('packages/web-react/src/components/ui/Button.tsx'), 'web-primitives')
    assert.equal(map.moduleOf('packages/web-react/src/lib/utils.ts'), 'web-primitives')
    assert.equal(map.moduleOf('packages/web-react/src/lib/chat/reducer.ts'), 'web-state')
    assert.equal(map.moduleOf('packages/web-react/src/lib/chat/socket.ts'), 'web-state')
    assert.equal(
      map.moduleOf('packages/commercial/src/observability/archTelemetry.ts'),
      'commercial-logging',
    )
  })

  test('backend god modules declare non-ambiguous subdomains covering all their files', () => {
    const prod = productionFiles(REPO_ROOT)
    for (const modId of [
      'interface-ws',
      'platform-pg',
      'gateway-core',
      'gateway-runtime',
      'interface-http',
    ]) {
      assert.ok(map.get(modId).subdomains, `${modId} should define subdomains`)
      const modFiles = prod.filter((f) => map.moduleOf(f) === modId)
      assert.ok(modFiles.length > 0, `${modId} should match production files`)
      for (const f of modFiles) {
        assert.ok(map.subdomainOf(modId, f), `${f} in ${modId} has no subdomain match`)
        assert.deepEqual(map.ambiguousSubdomain(modId, f), [], `${f} in ${modId} is ambiguous`)
      }
    }
  })
})

describe('File-level circular dependency detection (R2-file-cycle)', () => {
  test('findFileCycles finds deterministic canonical SCCs regardless of node order and ignores DAGs', () => {
    const dag = new Map<string, Set<string>>([
      ['a.ts', new Set(['b.ts'])],
      ['b.ts', new Set(['c.ts'])],
      ['c.ts', new Set()],
    ])
    assert.deepEqual(findFileCycles(dag), [])

    const g1 = new Map<string, Set<string>>([
      ['c.ts', new Set(['a.ts'])],
      ['a.ts', new Set(['b.ts'])],
      ['b.ts', new Set(['c.ts'])],
      ['d.ts', new Set(['a.ts'])],
    ])
    const g2 = new Map<string, Set<string>>([
      ['a.ts', new Set(['b.ts'])],
      ['b.ts', new Set(['c.ts'])],
      ['c.ts', new Set(['a.ts'])],
      ['d.ts', new Set(['a.ts'])],
    ])
    const c1 = findFileCycles(g1)
    const c2 = findFileCycles(g2)
    assert.equal(c1.length, 1)
    assert.deepEqual(c1, c2)
    assert.deepEqual(c1[0]!.files, ['a.ts', 'b.ts', 'c.ts'])
    assert.equal(c1[0]!.size, 3)
    assert.equal(c1[0]!.key, fileCycleKey(['c.ts', 'a.ts', 'b.ts']).key)
  })

  test('compareFileCyclesBaseline allows deleting or shrinking an SCC, but blocks adding files or new SCCs', () => {
    const abc = fileCycleKey(['a.ts', 'b.ts', 'c.ts'])
    const ab = fileCycleKey(['a.ts', 'b.ts'])
    const abcd = fileCycleKey(['a.ts', 'b.ts', 'c.ts', 'd.ts'])
    const xy = fileCycleKey(['x.ts', 'y.ts'])

    assert.deepEqual(compareFileCyclesBaseline({ [abc.key]: 3 }, {}).grown, [])
    assert.deepEqual(compareFileCyclesBaseline({ [abc.key]: 3 }, { [ab.key]: 2 }).grown, [])
    assert.equal(compareFileCyclesBaseline({ [abc.key]: 3 }, { [abcd.key]: 4 }).grown.length, 1)
    assert.equal(
      compareFileCyclesBaseline({ [abc.key]: 3 }, { [abc.key]: 3, [xy.key]: 2 }).grown.length,
      1,
    )
  })

  test('CLI blocks new file cycles, passes when existing cycle is deleted, and blocks baseline growth with --base', (t) => {
    const mods = {
      schema: 1,
      modules: { app: { layer: 'L3', match: ['packages/app/src/**'], scope: ['master'] } },
    }
    const root = mkGitRepo(
      t,
      {
        'packages/app/src/a.ts': "import { b } from './b.js';\nexport const a = () => b;\n",
        'packages/app/src/b.ts': "import { a } from './a.js';\nexport const b = () => a;\n",
        'packages/app/src/t1.ts':
          "import type { T2 } from './t2.js';\nexport type T1 = { x?: T2 };\n",
        'packages/app/src/t2.ts':
          "import type { T1 } from './t1.js';\nexport type T2 = { y?: T1 };\n",
      },
      mods,
    )
    // Type-only cycle (t1/t2) is NOT a runtime cycle; only a/b is detected
    const initial = check(root, new ModuleMap(mods as never))
    assert.equal(initial.fileCycles.length, 1)
    assert.deepEqual(initial.fileCycles[0]!.files, [
      'packages/app/src/a.ts',
      'packages/app/src/b.ts',
    ])

    // Without file-cycles-baseline.json, existing cycle fails --enforce
    assert.equal(runCli(root, '--write-baseline').status, 0)
    const noBase = runCli(root, '--enforce')
    assert.equal(noBase.status, 1)
    assert.match(noBase.stdout, /NEW\/GROWN R2-file-cycle\|/)
    assert.match(noBase.stdout, /\[GATE-ERROR\] R2-file-cycle/)

    // Freeze baseline and commit base
    assert.equal(runCli(root, '--write-file-cycles-baseline').status, 0)
    assert.equal(runCli(root, '--enforce').status, 0)
    const git = initGit(root)

    // Introduce a NEW cycle c.ts <-> d.ts -> must block!
    writeFileSync(
      path.join(root, 'packages/app/src/c.ts'),
      "import { d } from './d.js';\nexport const c = () => d;\n",
    )
    writeFileSync(
      path.join(root, 'packages/app/src/d.ts'),
      "import { c } from './c.js';\nexport const d = () => c;\n",
    )
    const added = runCli(root, '--enforce')
    assert.equal(added.status, 1)
    assert.match(added.stdout, /NEW\/GROWN R2-file-cycle\|/)

    // Attempting to mask the new cycle by bumping file-cycles-baseline.json fails --base!
    assert.equal(runCli(root, '--write-file-cycles-baseline').status, 0)
    git('add', '-A')
    git('commit', '-qm', 'try-mask-cycle')
    const masked = runCli(root, '--enforce', '--base', 'main~1')
    assert.equal(masked.status, 1)
    assert.match(masked.stdout, /BASELINE-GROWN R2-file-cycle\|/)

    // Remove the new cycle AND break the original a<->b cycle + shrink baseline -> passes!
    rmSync(path.join(root, 'packages/app/src/c.ts'))
    rmSync(path.join(root, 'packages/app/src/d.ts'))
    writeFileSync(path.join(root, 'packages/app/src/b.ts'), 'export const b = 1;\n')
    assert.equal(runCli(root, '--write-file-cycles-baseline').status, 0)
    git('add', '-A')
    git('commit', '-qm', 'break-cycles')
    const cleaned = runCli(root, '--enforce', '--base', 'main~2')
    assert.equal(cleaned.status, 0, `expected exit 0 after deleting cycle, got: ${cleaned.stdout}`)
    assert.deepEqual(
      JSON.parse(readFileSync(path.join(root, FILE_CYCLES_BASELINE_REL), 'utf8')).entries,
      {},
    )
  })
})

describe('Intramodule subdomain boundaries (R2-intramodule-boundary) & refined F4 baseline', () => {
  test('ModuleMap rejects invalid subdomain configs (unknown target, self-allow, same-rank cycle)', () => {
    assert.throws(
      () =>
        new ModuleMap({
          schema: 1,
          modules: {
            m: {
              layer: 'L3',
              match: ['p/**'],
              subdomains: { a: { rank: 0, match: ['p/a/**'], allow: ['missing'] } },
            },
          },
        } as never),
      /unknown subdomain/,
    )
    assert.throws(
      () =>
        new ModuleMap({
          schema: 1,
          modules: {
            m: {
              layer: 'L3',
              match: ['p/**'],
              subdomains: {
                a: { rank: 1, match: ['p/a/**'], allow: ['b'] },
                b: { rank: 1, match: ['p/b/**'], allow: ['a'] },
              },
            },
          },
        } as never),
      /cycle/,
    )
    assert.throws(
      () =>
        new ModuleMap({
          schema: 1,
          modules: {
            m: {
              layer: 'L3',
              match: ['p/**'],
              subdomains: { a: { rank: -1, match: ['p/a/**'] } },
            },
          },
        } as never),
      /non-negative integer/,
    )
  })

  test('intramodule upward, unlisted same-rank, and explicit deny are blocked while downward/allowed/type-only pass', (t) => {
    const mods = {
      schema: 1,
      modules: {
        ws: {
          layer: 'L5',
          match: ['packages/app/src/ws/**'],
          scope: ['master'],
          subdomains: {
            types: { rank: 0, match: ['packages/app/src/ws/types/**'] },
            link: { rank: 1, match: ['packages/app/src/ws/link/**'] },
            tunnel: { rank: 1, allow: ['link'], match: ['packages/app/src/ws/tunnel/**'] },
            bridge: {
              rank: 2,
              deny: ['tunnel'],
              match: ['packages/app/src/ws/bridge/**'],
            },
          },
        },
      },
    }
    const root = mkGitRepo(
      t,
      {
        'packages/app/src/ws/types/t.ts':
          "import type { B } from '../bridge/b.js';\nexport type T = { b?: B };\nexport const T0 = 1;\n",
        'packages/app/src/ws/link/l.ts':
          "import { T0 } from '../types/t.js';\nexport const L = T0;\n",
        'packages/app/src/ws/tunnel/u.ts':
          "import { L } from '../link/l.js';\nexport const U = L;\n",
        'packages/app/src/ws/bridge/b.ts':
          "import { L } from '../link/l.js';\nexport type B = number;\nexport const B0 = L;\n",
      },
      mods,
    )
    // All legal edges: downward, allowed same-rank (tunnel->link), and type-only upward (types->bridge)
    const clean = check(root, new ModuleMap(mods as never))
    assert.deepEqual(clean.subdomainViolations, [])
    assert.equal(runCli(root, '--write-all-baselines').status, 0)
    assert.equal(runCli(root, '--enforce').status, 0)
    const git = initGit(root)

    // Add 3 forbidden intramodule edges:
    // 1. types (rank 0) -> link (rank 1) [upward]
    // 2. link (rank 1) -> tunnel (rank 1) [unlisted same-rank]
    // 3. bridge (rank 2) -> tunnel (rank 1) [explicit deny]
    writeFileSync(
      path.join(root, 'packages/app/src/ws/types/badUp.ts'),
      "import { L } from '../link/l.js';\nexport const x = L;\n",
    )
    writeFileSync(
      path.join(root, 'packages/app/src/ws/link/badPeer.ts'),
      "import { U } from '../tunnel/u.js';\nexport const y = U;\n",
    )
    writeFileSync(
      path.join(root, 'packages/app/src/ws/bridge/badDeny.ts'),
      "import { U } from '../tunnel/u.js';\nexport const z = U;\n",
    )

    const badRes = check(root, new ModuleMap(mods as never))
    assert.deepEqual(Object.keys(tally(badRes.subdomainViolations)), [
      'R2-intramodule-boundary|packages/app/src/ws/bridge/badDeny.ts|ws:bridge->tunnel',
      'R2-intramodule-boundary|packages/app/src/ws/link/badPeer.ts|ws:link->tunnel',
      'R2-intramodule-boundary|packages/app/src/ws/types/badUp.ts|ws:types->link',
    ])

    const enf = runCli(root, '--enforce')
    assert.equal(enf.status, 1)
    assert.match(enf.stdout, /NEW\/GROWN R2-intramodule-boundary\|/)
    assert.match(enf.stdout, /\[GATE-ERROR\] R2-intramodule-boundary/)

    // Attempting to bump arch/subdomain-violations-baseline.json fails --base!
    assert.equal(runCli(root, '--write-subdomain-baseline').status, 0)
    git('add', '-A')
    git('commit', '-qm', 'try-mask-subdomain')
    const masked = runCli(root, '--enforce', '--base', 'main~1')
    assert.equal(masked.status, 1)
    assert.match(masked.stdout, /BASELINE-GROWN R2-intramodule-boundary\|/)
    assert.ok(
      Object.keys(JSON.parse(readFileSync(path.join(root, SUBDOMAIN_BASELINE_REL), 'utf8')).entries)
        .length === 3,
    )
  })

  test('refined F4 modules route cross-domain boundary violations to subdomain baseline while keeping R3 in main baseline', (t) => {
    const mods = {
      schema: 1,
      modules: {
        'dom-a': {
          layer: 'F4',
          boundaryBaseline: 'subdomain',
          match: ['packages/app/src/a/**'],
          scope: ['browser'],
        },
        'dom-b': {
          layer: 'F4',
          boundaryBaseline: 'subdomain',
          match: ['packages/app/src/b/**'],
          scope: ['browser'],
        },
      },
    }
    const root = mkGitRepo(
      t,
      {
        'packages/app/src/a/view.ts':
          "import { B } from '../b/view.js';\nexport const A = () => fetch('/x') && B;\n",
        'packages/app/src/b/view.ts': 'export const B = 1;\n',
      },
      mods,
    )
    const res = check(root, new ModuleMap(mods as never))
    assert.deepEqual(Object.keys(tally(res.violations)), ['R3-net|packages/app/src/a/view.ts|-'])
    assert.deepEqual(Object.keys(tally(res.subdomainViolations)), [
      'R2-same-layer|packages/app/src/a/view.ts|dom-b',
    ])
    assert.deepEqual(tallyFileCycles(res.fileCycles), {})
  })
})
