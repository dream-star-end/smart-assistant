import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { runStewardGate } from '../check-cross-family-audit.js'
import {
  ARCH_STEWARD_RECEIPT_SCHEMA_VERSION,
  type ArchStewardReceipt,
  type DiffSummary,
  type StructuralRiskTriggerCode,
  analyzeChangedFunctionsInSource,
  computeDirectCyclomaticComplexity,
  detect12LineClones,
  evaluateStructuralRisk,
  signArchStewardReceipt,
  verifyArchStewardReceipt,
} from '../lib/archStewardContract.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const AUDIT_SCRIPT = path.join(ROOT, 'scripts/check-cross-family-audit.ts')
const REVIEW_SH = path.join(ROOT, 'scripts/arch-steward-review.sh')

const SHA_BASE = '1111111111111111111111111111111111111111'
const SHA_HEAD = '2222222222222222222222222222222222222222'
const SHA_OLD = '3333333333333333333333333333333333333333'

function runAuditCli(args: string[], env?: Record<string, string>) {
  const tsxCli = path.join(ROOT, 'node_modules/tsx/dist/cli.mjs')
  const spawnArgs = existsSync(tsxCli)
    ? [tsxCli, AUDIT_SCRIPT, ...args]
    : ['--import', 'tsx', AUDIT_SCRIPT, ...args]
  return spawnSync(process.execPath, spawnArgs, {
    encoding: 'utf8',
    env: env ? { ...process.env, ...env } : process.env,
  })
}

function makeUnsignedReceipt(
  overrides: Partial<Omit<ArchStewardReceipt, 'receiptDigest'>> = {},
): Omit<ArchStewardReceipt, 'receiptDigest'> {
  return {
    schemaVersion: ARCH_STEWARD_RECEIPT_SCHEMA_VERSION,
    headSha: SHA_HEAD,
    baseSha: SHA_BASE,
    authorModel: 'gpt-6.2-sol',
    authorFamily: 'openai-gpt',
    stewardModel: 'antigravity-gemini-4-carbon',
    stewardFamily: 'google-gemini',
    verdict: 'approve',
    triggers: ['APPEND_MAGNET_GROWTH'],
    dimensions: {
      godClassAppend: { status: 'pass', notes: 'Extracted helper instead of appending to god file.' },
      wheelReinvention: { status: 'pass', notes: 'Reused @openclaude/kernel utilities.' },
      boundaryIntegrity: { status: 'pass', notes: 'Respects arch/modules.json DAG.' },
      complexityDrift: { status: 'pass', notes: 'All functions <= 100 lines and CC_direct <= 20.' },
    },
    blockers: [],
    usageEvidence: {
      jobId: 'steward-job-001',
      sessionKey: 'arch-steward:google-gemini:222222222222',
      timestamp: '2026-11-26T13:15:00Z',
      provider: 'agy',
    },
    ...overrides,
  }
}

function initTempGitRepo(): {
  dir: string
  git: (args: string[]) => string
  write: (rel: string, content: string) => void
  commit: (msg: string) => string
} {
  const dir = mkdtempSync(path.join(tmpdir(), 'arch-steward-gate-'))
  const git = (args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test Author',
        GIT_AUTHOR_EMAIL: 'author@example.com',
        GIT_COMMITTER_NAME: 'Test Author',
        GIT_COMMITTER_EMAIL: 'author@example.com',
      },
    }).trim()

  git(['init', '-b', 'feat/v5-selfhost'])
  const write = (rel: string, content: string) => {
    const abs = path.join(dir, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, content, 'utf8')
  }
  const commit = (msg: string) => {
    git(['add', '-A'])
    git(['commit', '-m', msg])
    return git(['rev-parse', 'HEAD'])
  }

  // Seed minimal arch configs in temp repo
  write(
    'arch/append-magnets.json',
    JSON.stringify(
      {
        schemaVersion: 1,
        magnets: [
          { path: 'packages/commercial/src/ws/userChatBridge.ts', rank: 1 },
          { path: 'packages/web-react/src/App.tsx', rank: 2 },
        ],
      },
      null,
      2,
    ),
  )
  write(
    'arch/modules.json',
    JSON.stringify(
      {
        schema: 1,
        modules: {
          'web-views': { layer: 'F4', match: ['packages/web-react/src/components/**'] },
          'web-hooks': { layer: 'F3', match: ['packages/web-react/src/hooks/**'] },
          'interface-ws': { layer: 'L5', match: ['packages/commercial/src/ws/**'] },
          'gateway-turn': { layer: 'L4', match: ['packages/gateway/src/**'] },
        },
      },
      null,
      2,
    ),
  )
  write(
    'arch/gate-couplings.json',
    JSON.stringify(
      {
        schema: 1,
        byGate: {
          'scripts/check-sample-gate.ts': ['packages/web-react/src/components/Widget.tsx'],
        },
      },
      null,
      2,
    ),
  )
  write(
    'packages/web-react/src/components/Widget.tsx',
    'export function Widget() {\n  return "ok"\n}\n',
  )
  write(
    'packages/commercial/src/ws/userChatBridge.ts',
    `${Array.from({ length: 40 }, (_, i) => `export const line${i} = ${i}`).join('\n')}\n`,
  )
  write('scripts/check-sample-gate.ts', 'export const target = "packages/web-react/src/components/Widget.tsx"\n')
  commit('chore(v5): seed baseline repo')

  return { dir, git, write, commit }
}

describe('arch/append-magnets.json real repository manifest', () => {
  test('contains 20 real, existing high-churn production magnet files with required metadata', () => {
    const manifestPath = path.join(ROOT, 'arch/append-magnets.json')
    assert.ok(existsSync(manifestPath), 'arch/append-magnets.json must exist')
    const data = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      schemaVersion: number
      sourceCommit: string
      refreshPolicy: Record<string, unknown>
      magnets: Array<{
        rank: number
        path: string
        lines: number
        commits60d: number
        magnetScore: number
        module: string
        layer: string
      }>
    }
    assert.equal(data.schemaVersion, 1)
    assert.match(data.sourceCommit, /^[0-9a-f]{40}$/)
    assert.ok(data.refreshPolicy && typeof data.refreshPolicy.formula === 'string')
    assert.equal(data.magnets.length, 20)

    const paths = new Set(data.magnets.map((m) => m.path))
    assert.equal(paths.size, 20, 'magnet paths must be unique')

    for (const m of data.magnets) {
      assert.ok(existsSync(path.join(ROOT, m.path)), `magnet path must exist in repo: ${m.path}`)
      assert.ok(m.lines > 500, `expected >500 LOC for magnet ${m.path}, got ${m.lines}`)
      assert.ok(m.magnetScore > 0)
      assert.ok(m.module && m.layer)
    }

    // Verify all named core magnets from specification are covered
    for (const requiredSuffix of [
      'userChatBridge.ts',
      'pgSessionsBackend.ts',
      'lib/chat/socket.ts',
      'sessionsDb.ts',
      'sessionSubmit.ts',
      'antigravityAdapter.ts',
      'MessageRenderer.tsx',
      'chat/cards.tsx',
      'egress/main.ts',
      'ProcessDisclosure.tsx',
      'web-react/src/App.tsx',
      'commercial/src/index.ts',
      'gateway/src/server.ts',
      'sessionManager.ts',
      'inboundDispatch.ts',
      'promptSlots.ts',
      'http/proxy/index.ts',
      'delegateRuntime.ts',
      'boxDurableJournal.ts',
      'lib/chat/reducer.ts',
    ]) {
      assert.ok(
        [...paths].some((p) => p.endsWith(requiredSuffix)),
        `expected arch/append-magnets.json to include ${requiredSuffix}`,
      )
    }
  })
})

describe('evaluateStructuralRisk: all 6 deterministic trigger rules & low-risk fast pass', () => {
  const baseOpts = {
    appendMagnets: new Set([
      'packages/commercial/src/ws/userChatBridge.ts',
      'packages/web-react/src/App.tsx',
    ]),
    modulesDef: {
      schema: 1,
      modules: {
        'web-views': { layer: 'F4', match: ['packages/web-react/src/components/**'] },
        'web-hooks': { layer: 'F3', match: ['packages/web-react/src/hooks/**'] },
        'interface-ws': { layer: 'L5', match: ['packages/commercial/src/ws/**'] },
      },
    },
    gateCouplings: {
      schema: 1,
      byGate: {
        'scripts/check-docs-links.ts': ['docs/V5_SELFHOST_PLAYBOOK.md'],
        'scripts/check-ui-hard-gates.ts': ['packages/web-react/src/components/Button.tsx'],
      },
    },
  }

  test('FAST PASS: low-risk single-module non-magnet change triggers 0/6 rules', () => {
    const diff: DiffSummary = {
      files: [
        { path: 'packages/web-react/src/components/SmallChip.tsx', status: 'modified', added: 24, deleted: 6 },
        { path: 'packages/web-react/src/components/SmallChip.test.tsx', status: 'modified', added: 600, deleted: 0 },
        { path: 'docs/NOTES.md', status: 'added', added: 500, deleted: 0 },
      ],
      changedFunctions: [
        { file: 'packages/web-react/src/components/SmallChip.tsx', name: 'SmallChip', lines: 35, ccDirect: 4 },
      ],
    }
    const report = evaluateStructuralRisk(diff, baseOpts)
    assert.equal(report.requiresSteward, false)
    assert.deepEqual(report.triggers, [])
  })

  test('Rule 1 (APPEND_MAGNET_GROWTH): blocks appending/modifying magnet, exempts pure deletion & net-shrinking refactor', () => {
    const grow = evaluateStructuralRisk(
      {
        files: [
          { path: 'packages/commercial/src/ws/userChatBridge.ts', status: 'modified', added: 15, deleted: 5 },
        ],
      },
      baseOpts,
    )
    assert.equal(grow.requiresSteward, true)
    assert.deepEqual(grow.triggers, ['APPEND_MAGNET_GROWTH'])

    const netZeroEdit = evaluateStructuralRisk(
      {
        files: [
          { path: 'packages/commercial/src/ws/userChatBridge.ts', status: 'modified', added: 8, deleted: 8 },
        ],
      },
      baseOpts,
    )
    assert.ok(netZeroEdit.triggers.includes('APPEND_MAGNET_GROWTH'))

    // Net-shrinking refactor (deleted > added) is exempt from Rule 1
    const shrink = evaluateStructuralRisk(
      {
        files: [
          { path: 'packages/commercial/src/ws/userChatBridge.ts', status: 'modified', added: 10, deleted: 45 },
        ],
      },
      baseOpts,
    )
    assert.equal(shrink.requiresSteward, false)
    assert.deepEqual(shrink.triggers, [])

    // Pure deletion is exempt from Rule 1
    const deleted = evaluateStructuralRisk(
      {
        files: [
          { path: 'packages/commercial/src/ws/userChatBridge.ts', status: 'deleted', added: 0, deleted: 200 },
        ],
      },
      baseOpts,
    )
    assert.equal(deleted.requiresSteward, false)
  })

  test('Rule 2 (NET_PROD_LOC_OVER_400): exact boundary at 400 vs 401 net production lines', () => {
    const at400 = evaluateStructuralRisk(
      {
        files: [
          { path: 'packages/web-react/src/components/NewCard.tsx', status: 'added', added: 400, deleted: 0 },
        ],
      },
      baseOpts,
    )
    assert.equal(at400.requiresSteward, false)

    const at401 = evaluateStructuralRisk(
      {
        files: [
          { path: 'packages/web-react/src/components/NewCard.tsx', status: 'added', added: 421, deleted: 20 },
        ],
      },
      baseOpts,
    )
    assert.equal(at401.requiresSteward, true)
    assert.deepEqual(at401.triggers, ['NET_PROD_LOC_OVER_400'])
    assert.equal(at401.stats.netProdLines, 401)
  })

  test('Rule 3 (MULTI_MODULE_SPAN): triggers when touching >= 2 modules in arch/modules.json', () => {
    const twoModules = evaluateStructuralRisk(
      {
        files: [
          { path: 'packages/web-react/src/components/Header.tsx', status: 'modified', added: 5, deleted: 2 },
          { path: 'packages/web-react/src/hooks/useTheme.ts', status: 'modified', added: 4, deleted: 1 },
        ],
      },
      baseOpts,
    )
    assert.equal(twoModules.requiresSteward, true)
    assert.deepEqual(twoModules.triggers, ['MULTI_MODULE_SPAN'])
    assert.deepEqual(twoModules.stats.touchedModules, ['web-hooks', 'web-views'])
  })

  test('Rule 4 (FUNCTION_COMPLEXITY_THRESHOLD): triggers on >100 lines or CC_direct > 20 (including real TS AST analysis)', () => {
    const okFn = evaluateStructuralRisk(
      {
        files: [{ path: 'packages/web-react/src/components/Ok.tsx', status: 'modified', added: 10, deleted: 0 }],
        changedFunctions: [{ file: 'packages/web-react/src/components/Ok.tsx', name: 'Ok', lines: 100, ccDirect: 20 }],
      },
      baseOpts,
    )
    assert.equal(okFn.requiresSteward, false)

    const longFn = evaluateStructuralRisk(
      {
        files: [{ path: 'packages/web-react/src/components/Long.tsx', status: 'modified', added: 10, deleted: 0 }],
        changedFunctions: [{ file: 'packages/web-react/src/components/Long.tsx', name: 'Long', lines: 101, ccDirect: 3 }],
      },
      baseOpts,
    )
    assert.deepEqual(longFn.triggers, ['FUNCTION_COMPLEXITY_THRESHOLD'])

    // Real TS AST measurement: verify nested closures do NOT inflate outer CC_direct, while direct branches do
    const directBranches = Array.from({ length: 21 }, (_, i) => `  if (x === ${i}) sum += ${i};`).join('\n')
    const src = `
export function highCc(x: number): number {
  let sum = 0;
${directBranches}
  const helper = (y: number) => (y > 0 ? y : -y);
  return sum + helper(x);
}
export function outerWithNestedClosures(items: number[]): number {
  const mapped = items.map((n) => (n > 1 && n < 10 ? (n % 2 === 0 ? n : n + 1) : 0));
  return mapped.length > 0 ? mapped[0]! : 0;
}
`
    const metrics = analyzeChangedFunctionsInSource('packages/web-react/src/components/Calc.ts', src)
    const high = metrics.find((m) => m.name === 'highCc')
    const outer = metrics.find((m) => m.name === 'outerWithNestedClosures')
    assert.ok(high && high.ccDirect === 22, `expected highCc CC_direct=22, got ${high?.ccDirect}`)
    assert.ok(outer && outer.ccDirect === 2, `expected outer CC_direct=2 (excluding nested arrow), got ${outer?.ccDirect}`)

    const ccReport = evaluateStructuralRisk(
      {
        files: [{ path: 'packages/web-react/src/components/Calc.ts', status: 'added', added: 35, deleted: 0 }],
        changedFunctions: metrics,
      },
      baseOpts,
    )
    assert.deepEqual(ccReport.triggers, ['FUNCTION_COMPLEXITY_THRESHOLD'])
  })

  test('Rule 5 (GATE_COUPLING_TOUCHED): triggers on coupled gate edit, coupled path deletion, or new gate coupling', () => {
    const editGate = evaluateStructuralRisk(
      {
        files: [{ path: 'scripts/check-docs-links.ts', status: 'modified', added: 3, deleted: 1 }],
      },
      baseOpts,
    )
    assert.deepEqual(editGate.triggers, ['GATE_COUPLING_TOUCHED'])

    const deleteTarget = evaluateStructuralRisk(
      {
        files: [{ path: 'packages/web-react/src/components/Button.tsx', status: 'deleted', added: 0, deleted: 50 }],
      },
      baseOpts,
    )
    assert.deepEqual(deleteTarget.triggers, ['GATE_COUPLING_TOUCHED'])

    const newCoupling = evaluateStructuralRisk(
      {
        files: [{ path: 'scripts/new-gate.ts', status: 'added', added: 20, deleted: 0 }],
        newGateCouplings: [{ gate: 'scripts/new-gate.ts', path: 'packages/web-react/src/components/SmallChip.tsx' }],
      },
      baseOpts,
    )
    assert.deepEqual(newCoupling.triggers, ['GATE_COUPLING_TOUCHED'])
  })

  test('Rule 6 (CLONE_OR_T2_CORE_PATH): triggers on 12-line clone alert OR T2 core path (exempting test-only files)', () => {
    // 12-line clone detection on real TypeScript source
    const duplicatedBlock = Array.from(
      { length: 14 },
      (_, i) => `  const step${i} = computeValue(input, ${i}) + ${i * 3};`,
    ).join('\n')
    const fileMap = new Map<string, string>([
      ['packages/web-react/src/components/Alpha.ts', `export function a(input: number) {\n${duplicatedBlock}\n  return step13;\n}\n`],
      ['packages/web-react/src/components/Beta.ts', `export function b(input: number) {\n${duplicatedBlock}\n  return step13;\n}\n`],
    ])
    const clones = detect12LineClones(fileMap)
    assert.ok(clones.length >= 1, 'expected 12-line clone alert across Alpha.ts and Beta.ts')

    const cloneReport = evaluateStructuralRisk(
      {
        files: [{ path: 'packages/web-react/src/components/Alpha.ts', status: 'added', added: 20, deleted: 0 }],
        cloneAlerts: clones,
      },
      baseOpts,
    )
    assert.deepEqual(cloneReport.triggers, ['CLONE_OR_T2_CORE_PATH'])

    // T2 core paths trigger
    for (const t2Path of [
      'packages/gateway/src/foo.ts',
      'packages/protocol/src/bar.ts',
      'packages/storage/src/baz.ts',
      'packages/commercial/src/billing/ledger.ts',
      'packages/commercial/src/db/migrations/0356_add_col.sql',
      'deploy/v5/selfhost-release-gates.json',
    ]) {
      const r = evaluateStructuralRisk(
        { files: [{ path: t2Path, status: 'modified', added: 5, deleted: 0 }] },
        baseOpts,
      )
      assert.ok(r.triggers.includes('CLONE_OR_T2_CORE_PATH'), `expected T2 core trigger for ${t2Path}`)
    }

    // Test-only edit inside gateway does NOT trigger T2 core path
    const testOnly = evaluateStructuralRisk(
      { files: [{ path: 'packages/gateway/src/__tests__/foo.test.ts', status: 'modified', added: 20, deleted: 0 }] },
      baseOpts,
    )
    assert.equal(testOnly.requiresSteward, false)
  })
})

describe('verifyArchStewardReceipt: cryptographic integrity, cross-family & non-overridable hard veto', () => {
  const requiredTriggers: StructuralRiskTriggerCode[] = ['APPEND_MAGNET_GROWTH']

  test('PASS: valid cross-family approve receipt passes both sha256 and hmac-sha256 modes', () => {
    const signedSha = signArchStewardReceipt(makeUnsignedReceipt())
    const r1 = verifyArchStewardReceipt(signedSha, {
      headSha: SHA_HEAD,
      baseSha: SHA_BASE,
      requiredTriggers,
    })
    assert.equal(r1.ok, true, `unexpected violations: ${JSON.stringify(r1.violations)}`)

    const signedHmac = signArchStewardReceipt(makeUnsignedReceipt(), 'super-secret-steward-key')
    assert.match(signedHmac.receiptDigest, /^hmac-sha256:[0-9a-f]{64}$/)
    const r2 = verifyArchStewardReceipt(signedHmac, {
      headSha: SHA_HEAD,
      baseSha: SHA_BASE,
      requiredTriggers,
      hmacKey: 'super-secret-steward-key',
    })
    assert.equal(r2.ok, true, `unexpected violations: ${JSON.stringify(r2.violations)}`)
  })

  test('RED: rejects same-family self-review and weak steward models', () => {
    const sameFamily = signArchStewardReceipt(
      makeUnsignedReceipt({
        authorModel: 'gpt-6.2-sol',
        authorFamily: 'openai-gpt',
        stewardModel: 'gpt-6.2-astra',
        stewardFamily: 'openai-gpt',
      }),
    )
    const rSame = verifyArchStewardReceipt(sameFamily, { headSha: SHA_HEAD, requiredTriggers })
    assert.equal(rSame.ok, false)
    assert.ok(rSame.violations.some((v) => v.code === 'CROSS-FAMILY-SAME-FAMILY-AUDIT'))

    const weakSteward = signArchStewardReceipt(
      makeUnsignedReceipt({
        stewardModel: 'gemini-2.5-flash-lite',
        stewardFamily: 'google-gemini',
      }),
    )
    const rWeak = verifyArchStewardReceipt(weakSteward, { headSha: SHA_HEAD, requiredTriggers })
    assert.equal(rWeak.ok, false)
    assert.ok(rWeak.violations.some((v) => v.code === 'CROSS-FAMILY-WEAK-AUDIT-MODEL'))

    // Lying about stewardFamily fails closed even if model slug is cross-family
    const lyingFamily = signArchStewardReceipt(
      makeUnsignedReceipt({
        stewardModel: 'antigravity-gemini-4-carbon',
        stewardFamily: 'anthropic-claude',
      }),
    )
    const rLie = verifyArchStewardReceipt(lyingFamily, { headSha: SHA_HEAD, requiredTriggers })
    assert.equal(rLie.ok, false)
    assert.ok(rLie.violations.some((v) => v.code === 'STEWARD-FAMILY-CLAIM-MISMATCH'))
  })

  test('RED: rejects old SHA reuse (stale commit receipt)', () => {
    const stale = signArchStewardReceipt(makeUnsignedReceipt({ headSha: SHA_OLD }))
    const res = verifyArchStewardReceipt(stale, { headSha: SHA_HEAD, requiredTriggers })
    assert.equal(res.ok, false)
    assert.ok(res.violations.some((v) => v.code === 'STEWARD-RECEIPT-SHA-MISMATCH'))
  })

  test('RED: HARD VETO cannot be bypassed by any override/leaderOverride/forceApprove fields', () => {
    const vetoWithOverrides = signArchStewardReceipt(
      makeUnsignedReceipt({
        verdict: 'veto',
        blockers: [
          {
            dimension: 'godClassAppend',
            severity: 'P0',
            location: 'packages/commercial/src/ws/userChatBridge.ts:412',
            reason: 'Appended 85 lines directly into Top-20 god file instead of extracting sub-module.',
          },
        ],
        override: { approvedBy: 'dev-lead', reason: 'urgent hotfix', force: true },
        leaderOverride: true,
        forceApprove: true,
      }),
    )
    const rVeto = verifyArchStewardReceipt(vetoWithOverrides, { headSha: SHA_HEAD, requiredTriggers })
    assert.equal(rVeto.ok, false)
    assert.ok(rVeto.violations.some((v) => v.code === 'STEWARD-HARD-VETO'))

    // Even if verdict='approve', non-empty blockers MUST hard-block
    const approveWithBlockers = signArchStewardReceipt(
      makeUnsignedReceipt({
        verdict: 'approve',
        blockers: [
          {
            dimension: 'boundaryIntegrity',
            severity: 'P1',
            location: 'packages/gateway/src/server.ts:99',
            reason: 'Crosses forbidden subdomain boundary',
          },
        ],
      }),
    )
    const rBlockers = verifyArchStewardReceipt(approveWithBlockers, { headSha: SHA_HEAD, requiredTriggers })
    assert.equal(rBlockers.ok, false)
    assert.ok(rBlockers.violations.some((v) => v.code === 'STEWARD-HARD-VETO'))

    // Even if verdict='approve' and blockers=[], a dimension marked 'veto' MUST hard-block
    const approveWithVetoDim = signArchStewardReceipt(
      makeUnsignedReceipt({
        verdict: 'approve',
        dimensions: {
          godClassAppend: { status: 'veto', notes: 'Appended into god class' },
          wheelReinvention: { status: 'pass', notes: 'ok' },
          boundaryIntegrity: { status: 'pass', notes: 'ok' },
          complexityDrift: { status: 'pass', notes: 'ok' },
        },
      }),
    )
    const rDimVeto = verifyArchStewardReceipt(approveWithVetoDim, { headSha: SHA_HEAD, requiredTriggers })
    assert.equal(rDimVeto.ok, false)
    assert.ok(rDimVeto.violations.some((v) => v.code === 'STEWARD-HARD-VETO'))
  })

  test('RED: rejects forged/tampered receiptDigest and sha256 downgrade when HMAC key is required', () => {
    const valid = signArchStewardReceipt(makeUnsignedReceipt())
    // Tamper verdict/notes after signing
    const tampered = {
      ...valid,
      dimensions: {
        ...valid.dimensions,
        godClassAppend: { status: 'pass' as const, notes: 'tampered notes after signing' },
      },
    }
    const rTamper = verifyArchStewardReceipt(tampered, { headSha: SHA_HEAD, requiredTriggers })
    assert.equal(rTamper.ok, false)
    assert.ok(rTamper.violations.some((v) => v.code === 'STEWARD-RECEIPT-DIGEST-MISMATCH'))

    // Forged arbitrary hex digest
    const forged = { ...valid, receiptDigest: `sha256:${'a'.repeat(64)}` }
    const rForged = verifyArchStewardReceipt(forged, { headSha: SHA_HEAD, requiredTriggers })
    assert.equal(rForged.ok, false)
    assert.ok(rForged.violations.some((v) => v.code === 'STEWARD-RECEIPT-DIGEST-MISMATCH'))

    // Plain sha256 rejected when HMAC key is enforced
    const rDowngrade = verifyArchStewardReceipt(valid, {
      headSha: SHA_HEAD,
      requiredTriggers,
      hmacKey: 'ci-enforced-hmac-key',
    })
    assert.equal(rDowngrade.ok, false)
    assert.ok(rDowngrade.violations.some((v) => v.code === 'STEWARD-RECEIPT-DIGEST-MISMATCH'))
  })

  test('RED: rejects receipt missing coverage for a triggered structural risk rule', () => {
    const partial = signArchStewardReceipt(makeUnsignedReceipt({ triggers: ['APPEND_MAGNET_GROWTH'] }))
    const res = verifyArchStewardReceipt(partial, {
      headSha: SHA_HEAD,
      requiredTriggers: ['APPEND_MAGNET_GROWTH', 'MULTI_MODULE_SPAN'],
    })
    assert.equal(res.ok, false)
    assert.ok(res.violations.some((v) => v.code === 'STEWARD-MISSING-TRIGGER-COVERAGE'))
  })
})

describe('Gate engine & CLI end-to-end: check-cross-family-audit.ts --enforce-commit / --check-only & arch-steward-review.sh', () => {
  test('low-risk commit passes without receipt; high-risk commit enforces exact-SHA cross-family approve receipt across dir, veto, trailer & CLI', (t) => {
    const repo = initTempGitRepo()
    t.after(() => rmSync(repo.dir, { recursive: true, force: true }))
    const baseSha = repo.git(['rev-parse', 'HEAD'])

    // 1. Low-risk single-module edit -> fast pass exit 0 without any receipt (in-process + real CLI)
    repo.write(
      'packages/web-react/src/components/Badge.tsx',
      'export function Badge({ label }: { label: string }) {\n  return label.trim()\n}\n',
    )
    const lowRiskSha = repo.commit('ui(v5): add tiny Badge component')
    const gLow = runStewardGate({
      root: repo.dir,
      mode: 'enforce-commit',
      baseRef: baseSha,
      headRef: lowRiskSha,
    })
    assert.equal(gLow.ok, true)
    assert.equal(gLow.exitCode, 0)
    assert.equal(gLow.risk.requiresSteward, false)

    const rLowCli = runAuditCli([
      '--enforce-commit',
      '--root',
      repo.dir,
      '--base',
      baseSha,
      '--head',
      lowRiskSha,
    ])
    assert.equal(rLowCli.status, 0, `expected exit 0 on low-risk edit, stderr=${rLowCli.stderr}`)
    assert.match(rLowCli.stdout, /LOW-RISK FAST PASS/)

    // 2. High-risk append into Top-20 magnet -> exit 1 when receipt missing; exit 0 under --check-only
    const prevBridge = readFileSync(
      path.join(repo.dir, 'packages/commercial/src/ws/userChatBridge.ts'),
      'utf8',
    )
    repo.write(
      'packages/commercial/src/ws/userChatBridge.ts',
      `${prevBridge}\nexport function appendedHandler(v: number) {\n  return v + 1\n}\n`,
    )
    const highRiskSha = repo.commit('feat(v5): append handler to userChatBridge')

    const gMissing = runStewardGate({
      root: repo.dir,
      mode: 'enforce-commit',
      baseRef: lowRiskSha,
      headRef: highRiskSha,
    })
    assert.equal(gMissing.ok, false)
    assert.equal(gMissing.exitCode, 1)
    assert.ok(gMissing.risk.triggers.includes('APPEND_MAGNET_GROWTH'))

    const gCheckOnly = runStewardGate({
      root: repo.dir,
      mode: 'check-only',
      baseRef: lowRiskSha,
      headRef: highRiskSha,
    })
    assert.equal(gCheckOnly.ok, false)
    assert.equal(gCheckOnly.exitCode, 0)

    // 3. Stale receipt (bound to lowRiskSha instead of highRiskSha) -> exit 1
    const receiptDir = path.join(repo.dir, 'custom-receipts')
    mkdirSync(receiptDir, { recursive: true })
    const staleReceipt = signArchStewardReceipt(
      makeUnsignedReceipt({
        headSha: lowRiskSha,
        baseSha: lowRiskSha,
        triggers: ['APPEND_MAGNET_GROWTH'],
      }),
    )
    writeFileSync(path.join(receiptDir, `${highRiskSha}.json`), JSON.stringify(staleReceipt, null, 2))
    const gStale = runStewardGate({
      root: repo.dir,
      mode: 'enforce-commit',
      baseRef: lowRiskSha,
      headRef: highRiskSha,
      receiptDirs: [receiptDir],
    })
    assert.equal(gStale.exitCode, 1)
    assert.ok(
      gStale.receiptVerification?.violations.some((v) => v.code === 'STEWARD-RECEIPT-SHA-MISMATCH'),
    )

    // 4. Veto receipt with override fields + STEWARD_OVERRIDE=1 -> exit 1 (verified via real CLI too)
    const vetoReceipt = signArchStewardReceipt(
      makeUnsignedReceipt({
        headSha: highRiskSha,
        baseSha: lowRiskSha,
        verdict: 'veto',
        triggers: ['APPEND_MAGNET_GROWTH'],
        blockers: [
          {
            dimension: 'godClassAppend',
            severity: 'P0',
            location: 'packages/commercial/src/ws/userChatBridge.ts:42',
            reason: 'Do not append into userChatBridge.ts',
          },
        ],
        override: { force: true, lead: 'bypass' },
      }),
    )
    writeFileSync(path.join(receiptDir, `${highRiskSha}.json`), JSON.stringify(vetoReceipt, null, 2))
    const rVetoCli = runAuditCli(
      [
        '--enforce-commit',
        '--root',
        repo.dir,
        '--base',
        lowRiskSha,
        '--head',
        highRiskSha,
        '--receipt-dir',
        receiptDir,
      ],
      { STEWARD_OVERRIDE: '1' },
    )
    assert.equal(rVetoCli.status, 1)
    assert.match(rVetoCli.stderr, /STEWARD-HARD-VETO/)

    // 5. Valid cross-family approve receipt via --receipt-dir -> exit 0 (verified via real CLI too)
    const validReceipt = signArchStewardReceipt(
      makeUnsignedReceipt({
        headSha: highRiskSha,
        baseSha: lowRiskSha,
        triggers: ['APPEND_MAGNET_GROWTH'],
      }),
    )
    writeFileSync(path.join(receiptDir, `${highRiskSha}.json`), JSON.stringify(validReceipt, null, 2))
    const rPassCli = runAuditCli([
      '--enforce-commit',
      '--root',
      repo.dir,
      '--base',
      lowRiskSha,
      '--head',
      highRiskSha,
      '--receipt-dir',
      receiptDir,
    ])
    assert.equal(rPassCli.status, 0, `expected exit 0 with valid receipt, stderr=${rPassCli.stderr}`)
    assert.match(rPassCli.stdout, /\[arch-steward\] ok \(enforce-commit\):/)

    // 6. Commit trailer `Steward-Receipt:` lookup under enforce-pr
    const trailerReceiptPath = path.join(repo.dir, 'external-trailer-receipt.json')
    repo.write('packages/gateway/src/newCore.ts', 'export const coreFlag = true\n')
    const trailerSha = repo.commit(
      `feat(v5): add gateway core flag\n\nSteward-Receipt: ${trailerReceiptPath}`,
    )
    const trailerReceipt = signArchStewardReceipt(
      makeUnsignedReceipt({
        headSha: trailerSha,
        baseSha: highRiskSha,
        triggers: ['CLONE_OR_T2_CORE_PATH'],
      }),
    )
    writeFileSync(trailerReceiptPath, JSON.stringify(trailerReceipt, null, 2))
    const gTrailer = runStewardGate({
      root: repo.dir,
      mode: 'enforce-pr',
      baseRef: highRiskSha,
      headRef: trailerSha,
    })
    assert.equal(gTrailer.ok, true)
    assert.equal(gTrailer.exitCode, 0)
  })

  test('scripts/arch-steward-review.sh --dry-run generates verifiable cross-family receipt and rejects same-family pair', (t) => {
    const repo = initTempGitRepo()
    t.after(() => rmSync(repo.dir, { recursive: true, force: true }))
    const baseSha = repo.git(['rev-parse', 'HEAD'])

    repo.write('packages/gateway/src/stewardDemo.ts', 'export function demo() { return 42 }\n')
    const headSha = repo.commit('feat(v5): touch gateway core for dry-run')

    // Reject same-family before running review
    const rSame = spawnSync(
      'bash',
      [
        REVIEW_SH,
        '--root',
        repo.dir,
        '--base',
        baseSha,
        '--head',
        headSha,
        '--author-model',
        'gpt-6.2-sol',
        '--steward-model',
        'gpt-6.2-astra',
        '--dry-run',
      ],
      { encoding: 'utf8' },
    )
    assert.equal(rSame.status, 1)
    assert.match(`${rSame.stdout}\n${rSame.stderr}`, /CROSS-FAMILY-SAME-FAMILY-AUDIT/)

    // Print prompt covers all 4 Architecture Steward dimensions
    const rPrompt = spawnSync(
      'bash',
      [
        REVIEW_SH,
        '--root',
        repo.dir,
        '--base',
        baseSha,
        '--head',
        headSha,
        '--author-model',
        'gpt-6.2-sol',
        '--print-prompt',
      ],
      { encoding: 'utf8' },
    )
    assert.equal(rPrompt.status, 0, `stderr=${rPrompt.stderr}`)
    assert.match(rPrompt.stdout, /godClassAppend/)
    assert.match(rPrompt.stdout, /wheelReinvention/)
    assert.match(rPrompt.stdout, /boundaryIntegrity/)
    assert.match(rPrompt.stdout, /complexityDrift/)
    assert.match(rPrompt.stdout, /CLONE_OR_T2_CORE_PATH/)

    // Dry-run produces a signed receipt that passes enforce-commit
    const outReceipt = path.join(repo.dir, '.github/steward-receipts', `${headSha}.json`)
    const rDry = spawnSync(
      'bash',
      [
        REVIEW_SH,
        '--root',
        repo.dir,
        '--base',
        baseSha,
        '--head',
        headSha,
        '--author-model',
        'gpt-6.2-sol',
        '--out',
        outReceipt,
        '--dry-run',
      ],
      { encoding: 'utf8' },
    )
    assert.equal(rDry.status, 0, `dry-run failed: stderr=${rDry.stderr}`)
    assert.ok(existsSync(outReceipt), 'dry-run must write signed receipt file')

    const gEnforce = runStewardGate({
      root: repo.dir,
      mode: 'enforce-commit',
      baseRef: baseSha,
      headRef: headSha,
    })
    assert.equal(
      gEnforce.exitCode,
      0,
      `dry-run receipt failed enforcement: ${JSON.stringify(gEnforce.receiptVerification)}`,
    )
  })
})

describe('computeDirectCyclomaticComplexity edge cases', () => {
  test('counts logical operators and switch cases accurately', () => {
    const metrics = analyzeChangedFunctionsInSource(
      'sample.ts',
      `
export function branchy(a: boolean, b: boolean, c: string | null) {
  const x = c ?? 'default'
  if (a && b || x === 'go') {
    switch (x) {
      case 'a': return 1
      case 'b': return 2
      default: return 3
    }
  }
  return 0
}
`,
    )
    assert.equal(metrics.length, 1)
    // 1 base + 1 (??) + 1 (if) + 1 (&&) + 1 (||) + 2 (case clauses) = 7
    assert.equal(metrics[0]!.ccDirect, 7)
    assert.equal(typeof computeDirectCyclomaticComplexity, 'function')
  })
})
