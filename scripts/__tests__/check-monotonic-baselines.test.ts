import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  BUDGETS_PATH,
  DESIGN_TOKENS_COUNTS_PATH,
  FEATURE_FLAGS_REGISTRY_PATH,
  LAYOUT_INVARIANTS_BASELINE_PATH,
  UI_STATIC_BASELINE_PATH,
  compareBudgets,
  compareCountRatchet,
  compareFeatureFlagsRegistry,
  compareLayoutInvariantsBaseline,
  validateLayoutInvariantsBaselineSchema,
} from '../check-monotonic-baselines.ts'

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../check-monotonic-baselines.ts',
)

function initGitRepo(t: { after(fn: () => void): void }, files: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'monotonic-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const put = (rel: string, data: unknown) => {
    const abs = path.join(dir, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`)
  }
  put('README.md', 'base\n')
  for (const [k, v] of Object.entries(files)) put(k, v)
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  git('add', '-A')
  git('commit', '-qm', 'base')
  git('tag', 'base')
  return dir
}

describe('check-monotonic-baselines pure comparators', () => {
  test('budgets.json: lowering or keeping budgets PASS; raising or deleting key FAIL', () => {
    const base = { firstScreenGzipBytes: 481280, cssTotalRawBytes: 388096 }
    assert.deepEqual(compareBudgets(base, { firstScreenGzipBytes: 470000, cssTotalRawBytes: 380000 }), [])
    assert.deepEqual(compareBudgets(base, { ...base, newCap: 1000 }), [])

    const raised = compareBudgets(base, { firstScreenGzipBytes: 481281, cssTotalRawBytes: 388096 })
    assert.equal(raised.length, 1)
    assert.equal(raised[0]!.rule, 'MONOTONIC-BUDGET-RAISED')

    const dropped = compareBudgets(base, { firstScreenGzipBytes: 481280 })
    assert.equal(dropped.length, 1)
    assert.equal(dropped[0]!.rule, 'MONOTONIC-BUDGET-REMOVED')
  })

  test('count ratchets (design-tokens-counts & ui-static-baseline): shrinking or removing entry PASS; raising or adding entry FAIL', () => {
    const base = {
      pxText: { 'components/chat': 29, 'components/ui': 4 },
      rawColor: { 'components/studio': 147 },
    }
    // Debt cleanup: lowered count & deleted entry
    assert.deepEqual(
      compareCountRatchet(
        base,
        { pxText: { 'components/chat': 20 }, rawColor: { 'components/studio': 100 } },
        DESIGN_TOKENS_COUNTS_PATH,
      ),
      [],
    )
    // Raised count -> RED
    const raised = compareCountRatchet(
      base,
      { pxText: { 'components/chat': 30, 'components/ui': 4 }, rawColor: { 'components/studio': 147 } },
      DESIGN_TOKENS_COUNTS_PATH,
    )
    assert.equal(raised.length, 1)
    assert.equal(raised[0]!.rule, 'MONOTONIC-COUNT-RAISED')

    // Newly added non-zero entry -> RED
    const added = compareCountRatchet(
      base,
      {
        pxText: { 'components/chat': 29, 'components/ui': 4, 'components/new': 1 },
        rawColor: { 'components/studio': 147 },
      },
      UI_STATIC_BASELINE_PATH,
    )
    assert.equal(added.length, 1)
    assert.equal(added[0]!.rule, 'MONOTONIC-COUNT-ADDED')
  })

  test('feature-flags-registry.json: tightening TTL or removing flag PASS; extending expireAt or flipping permanent->true FAIL', () => {
    const base = {
      schema: 1,
      flags: [
        { name: 'OC_P5_CHIPS', permanent: false, expireAt: '2026-12-22' },
        { name: 'OC_SITES_ENABLED', permanent: true, expireAt: null },
      ],
    }
    // Tightened expireAt + new flag + removed old flag -> PASS
    assert.deepEqual(
      compareFeatureFlagsRegistry(base, {
        schema: 1,
        flags: [
          { name: 'OC_P5_CHIPS', permanent: false, expireAt: '2026-12-10' },
          { name: 'OC_FLAG_NEW', permanent: false, expireAt: '2026-12-20' },
        ],
      }),
      [],
    )
    // Extended expireAt -> RED
    const extended = compareFeatureFlagsRegistry(base, {
      schema: 1,
      flags: [{ name: 'OC_P5_CHIPS', permanent: false, expireAt: '2027-01-15' }],
    })
    assert.equal(extended.length, 1)
    assert.equal(extended[0]!.rule, 'MONOTONIC-FLAG-TTL-EXTENDED')

    // Flipped permanent: false -> true -> RED
    const flipped = compareFeatureFlagsRegistry(base, {
      schema: 1,
      flags: [{ name: 'OC_P5_CHIPS', permanent: true, expireAt: null }],
    })
    assert.equal(flipped.length, 1)
    assert.equal(flipped[0]!.rule, 'MONOTONIC-FLAG-MADE-PERMANENT')
  })

  test('layout-invariants-baseline.json: lowering counts or deleting keys PASS; adding key, raising count, or invalid schema FAIL', () => {
    const base = {
      schemaVersion: 1,
      tier: 'core',
      keyFormat: 'scene|viewport|theme|ruleId',
      scenes: ['composer-idle', 'sidebar-overview'],
      viewports: ['mobile', 'desktop'],
      themes: ['light', 'dark'],
      counts: {
        'composer-idle|mobile|light|LAYOUT-TOUCH-TARGET-SMALL': 2,
        'sidebar-overview|mobile|dark|LAYOUT-TOUCH-TARGET-SMALL': 15,
      },
    }
    // Debt cleanup: lowered count & deleted key -> PASS
    assert.deepEqual(
      compareLayoutInvariantsBaseline(base, {
        ...base,
        counts: {
          'sidebar-overview|mobile|dark|LAYOUT-TOUCH-TARGET-SMALL': 10,
        },
      }),
      [],
    )
    // Raised count -> RED
    const raised = compareLayoutInvariantsBaseline(base, {
      ...base,
      counts: {
        ...base.counts,
        'composer-idle|mobile|light|LAYOUT-TOUCH-TARGET-SMALL': 3,
      },
    })
    assert.equal(raised.length, 1)
    assert.equal(raised[0]!.rule, 'MONOTONIC-COUNT-RAISED')

    // Newly added key (even count=0 or >0) -> RED
    const added = compareLayoutInvariantsBaseline(base, {
      ...base,
      counts: {
        ...base.counts,
        'tools-inspector|mobile|dark|LAYOUT-HORIZONTAL-OVERFLOW': 1,
      },
    })
    assert.equal(added.length, 1)
    assert.equal(added[0]!.rule, 'MONOTONIC-COUNT-ADDED')

    const addedZero = compareLayoutInvariantsBaseline(base, {
      ...base,
      counts: {
        ...base.counts,
        'tools-inspector|mobile|dark|LAYOUT-HORIZONTAL-OVERFLOW': 0,
      },
    })
    assert.equal(addedZero.length, 1)
    assert.equal(addedZero[0]!.rule, 'MONOTONIC-COUNT-ADDED')

    // Invalid schema (bad schemaVersion / malformed key) -> RED
    const badSchema = validateLayoutInvariantsBaselineSchema({
      schemaVersion: 2,
      counts: { 'bad-key-format': 1 },
    })
    assert.ok(badSchema.some((v) => v.rule === 'MONOTONIC-SCHEMA-INVALID' && v.key === 'schemaVersion'))
    assert.ok(badSchema.some((v) => v.rule === 'MONOTONIC-SCHEMA-INVALID' && v.key === 'bad-key-format'))
  })
})

describe('check-monotonic-baselines CLI', () => {
  test('GREEN: first introduction when base lacks baseline files validates JSON schema and passes', (t) => {
    const dir = initGitRepo(t, {})
    const put = (rel: string, data: unknown) => {
      const abs = path.join(dir, rel)
      mkdirSync(path.dirname(abs), { recursive: true })
      writeFileSync(abs, `${JSON.stringify(data, null, 2)}\n`)
    }
    put(BUDGETS_PATH, { firstScreenGzipBytes: 481280 })
    put(DESIGN_TOKENS_COUNTS_PATH, { pxText: { 'components/chat': 10 } })
    put(UI_STATIC_BASELINE_PATH, { 'UI-ZINDEX-LADDER': { 'components/a.tsx': 2 } })
    put(LAYOUT_INVARIANTS_BASELINE_PATH, {
      schemaVersion: 1,
      tier: 'core',
      counts: { 'composer-idle|mobile|light|LAYOUT-TOUCH-TARGET-SMALL': 2 },
    })
    put(FEATURE_FLAGS_REGISTRY_PATH, {
      schema: 1,
      flags: [{ name: 'OC_P5_CHIPS', permanent: false, expireAt: '2026-12-22' }],
    })
    const r = spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, '--root', dir, '--base', 'base'], {
      encoding: 'utf8',
    })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /budgets\.json=introduced/)
    assert.match(r.stdout, /layout-invariants-baseline\.json=introduced/)
    assert.match(r.stdout, /violations=0/)
  })

  test('RED: CLI catches invalid layout-invariants-baseline.json on initial introduction and regressions once committed', (t) => {
    // 1. Initial introduction with invalid schema -> RED
    const introDir = initGitRepo(t, {})
    const introAbs = path.join(introDir, LAYOUT_INVARIANTS_BASELINE_PATH)
    mkdirSync(path.dirname(introAbs), { recursive: true })
    writeFileSync(introAbs, JSON.stringify({ schemaVersion: 99, counts: {} }))
    const badIntro = spawnSync(
      process.execPath,
      ['--import', 'tsx', SCRIPT, '--root', introDir, '--base', 'base'],
      { encoding: 'utf8' },
    )
    assert.equal(badIntro.status, 1)
    assert.match(badIntro.stderr, /\[GATE-ERROR\] MONOTONIC-SCHEMA-INVALID/)

    // 2. Once committed at base: raising count or adding key -> RED; debt cleanup -> GREEN
    const dir = initGitRepo(t, {
      [LAYOUT_INVARIANTS_BASELINE_PATH]: {
        schemaVersion: 1,
        tier: 'core',
        counts: {
          'composer-idle|mobile|light|LAYOUT-TOUCH-TARGET-SMALL': 2,
          'sidebar-overview|mobile|dark|LAYOUT-TOUCH-TARGET-SMALL': 5,
        },
      },
    })
    writeFileSync(
      path.join(dir, LAYOUT_INVARIANTS_BASELINE_PATH),
      JSON.stringify({
        schemaVersion: 1,
        tier: 'core',
        counts: {
          'composer-idle|mobile|light|LAYOUT-TOUCH-TARGET-SMALL': 3,
          'sidebar-overview|mobile|dark|LAYOUT-TOUCH-TARGET-SMALL': 5,
          'tools-inspector|mobile|dark|LAYOUT-HORIZONTAL-OVERFLOW': 1,
        },
      }),
    )
    const red = spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, '--root', dir, '--base', 'base'], {
      encoding: 'utf8',
    })
    assert.equal(red.status, 1)
    assert.match(red.stderr, /\[GATE-ERROR\] MONOTONIC-COUNT-RAISED/)
    assert.match(red.stderr, /\[GATE-ERROR\] MONOTONIC-COUNT-ADDED/)

    writeFileSync(
      path.join(dir, LAYOUT_INVARIANTS_BASELINE_PATH),
      JSON.stringify({
        schemaVersion: 1,
        tier: 'core',
        counts: {
          'sidebar-overview|mobile|dark|LAYOUT-TOUCH-TARGET-SMALL': 4,
        },
      }),
    )
    const green = spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, '--root', dir, '--base', 'base'], {
      encoding: 'utf8',
    })
    assert.equal(green.status, 0, green.stderr)
    assert.match(green.stdout, /layout-invariants-baseline\.json=compared/)
    assert.match(green.stdout, /violations=0/)
  })

  test('RED: CLI catches raised budget, raised count, and extended flag TTL against committed base', (t) => {
    const dir = initGitRepo(t, {
      [BUDGETS_PATH]: { firstScreenGzipBytes: 481280 },
      [DESIGN_TOKENS_COUNTS_PATH]: { pxText: { 'components/chat': 10 } },
      [UI_STATIC_BASELINE_PATH]: { 'UI-ZINDEX-LADDER': { 'components/a.tsx': 2 } },
      [FEATURE_FLAGS_REGISTRY_PATH]: {
        schema: 1,
        flags: [{ name: 'OC_P5_CHIPS', permanent: false, expireAt: '2026-12-22' }],
      },
    })
    writeFileSync(path.join(dir, BUDGETS_PATH), JSON.stringify({ firstScreenGzipBytes: 500000 }))
    writeFileSync(
      path.join(dir, DESIGN_TOKENS_COUNTS_PATH),
      JSON.stringify({ pxText: { 'components/chat': 11 } }),
    )
    writeFileSync(
      path.join(dir, FEATURE_FLAGS_REGISTRY_PATH),
      JSON.stringify({
        schema: 1,
        flags: [{ name: 'OC_P5_CHIPS', permanent: false, expireAt: '2027-02-01' }],
      }),
    )
    const r = spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, '--root', dir, '--base', 'base'], {
      encoding: 'utf8',
    })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /\[GATE-ERROR\] MONOTONIC-BUDGET-RAISED/)
    assert.match(r.stderr, /\[GATE-ERROR\] MONOTONIC-COUNT-RAISED/)
    assert.match(r.stderr, /\[GATE-ERROR\] MONOTONIC-FLAG-TTL-EXTENDED/)
  })

  test('RED: deleting a flag still referenced in production source fails; deleting a 0-ref retired flag passes', (t) => {
    const dir = initGitRepo(t, {
      'packages/protocol/src/serverFeatures.ts':
        "export const SERVER_FEATURE_ENV = { chips: 'OC_P5_CHIPS' } as const\n",
      'packages/gateway/src/legacy.ts':
        'export const legacy = process.env.OC_LEGACY_ENV_KEY === "1"\n',
      'packages/gateway/src/__tests__/retired.test.ts':
        "export const mentionsOnlyInTest = 'OC_RETIRED_FLAG'\n",
      [FEATURE_FLAGS_REGISTRY_PATH]: {
        schema: 1,
        flags: [
          { name: 'OC_P5_CHIPS', permanent: false, expireAt: '2026-12-22' },
          { name: 'LEGACY_ALIAS', env: 'OC_LEGACY_ENV_KEY', permanent: false, expireAt: '2026-12-22' },
          { name: 'OC_RETIRED_FLAG', permanent: false, expireAt: '2026-12-22' },
        ],
      },
    })
    // 1. Deleting OC_P5_CHIPS (still in serverFeatures.ts) and LEGACY_ALIAS (env still in legacy.ts) -> RED
    writeFileSync(
      path.join(dir, FEATURE_FLAGS_REGISTRY_PATH),
      JSON.stringify({
        schema: 1,
        flags: [{ name: 'OC_RETIRED_FLAG', permanent: false, expireAt: '2026-12-22' }],
      }),
    )
    const red = spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, '--root', dir, '--base', 'base'], {
      encoding: 'utf8',
    })
    assert.equal(red.status, 1)
    assert.match(red.stderr, /\[GATE-ERROR\] MONOTONIC-FLAG-STILL-REFERENCED/)
    assert.match(red.stderr, /OC_P5_CHIPS/)
    assert.match(red.stderr, /OC_LEGACY_ENV_KEY/)

    // 2. Keeping live flags and deleting OC_RETIRED_FLAG (0 production refs; only mentioned in __tests__) -> GREEN
    writeFileSync(
      path.join(dir, FEATURE_FLAGS_REGISTRY_PATH),
      JSON.stringify({
        schema: 1,
        flags: [
          { name: 'OC_P5_CHIPS', permanent: false, expireAt: '2026-12-22' },
          { name: 'LEGACY_ALIAS', env: 'OC_LEGACY_ENV_KEY', permanent: false, expireAt: '2026-12-22' },
        ],
      }),
    )
    const green = spawnSync(
      process.execPath,
      ['--import', 'tsx', SCRIPT, '--root', dir, '--base', 'base'],
      { encoding: 'utf8' },
    )
    assert.equal(green.status, 0, green.stderr)
  })

  test('FAIL-CLOSED: invalid --base ref exits 2', (t) => {
    const dir = initGitRepo(t, {})
    const r = spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, '--root', dir, '--base', 'no-such-ref'], {
      encoding: 'utf8',
    })
    assert.equal(r.status, 2)
  })
})
