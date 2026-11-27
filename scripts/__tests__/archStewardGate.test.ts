import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  resolveStewardHmacKeyState,
  runStewardGate,
  runStewardGateAsync,
} from '../check-cross-family-audit.js'
import {
  ARCH_STEWARD_DRY_RUN_SCHEMA_VERSION,
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
import type { FetchLike } from '../lib/githubTrustedApproval.js'

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

function runAuditCliAsync(
  args: string[],
  env?: Record<string, string>,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const tsxCli = path.join(ROOT, 'node_modules/tsx/dist/cli.mjs')
  const spawnArgs = existsSync(tsxCli)
    ? [tsxCli, AUDIT_SCRIPT, ...args]
    : ['--import', 'tsx', AUDIT_SCRIPT, ...args]
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, spawnArgs, {
      env: env ? { ...process.env, ...env } : process.env,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => {
      stdout += String(d)
    })
    child.stderr.on('data', (d) => {
      stderr += String(d)
    })
    child.on('error', reject)
    child.on('close', (status) => resolve({ status, stdout, stderr }))
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
    // Place receipts OUTSIDE repo.dir so they represent out-of-commit host receipts!
    const receiptDir = mkdtempSync(path.join(tmpdir(), 'steward-host-receipts-'))
    t.after(() => rmSync(receiptDir, { recursive: true, force: true }))
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
      requireRootOwner: false,
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
        '--unsafe-test-skip-owner',
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

    // 5. Valid cross-family approve receipt via external --receipt-dir -> exit 0 (verified via real CLI too)
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
      '--unsafe-test-skip-owner',
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

    // 5b. Trust boundary checks: unsigned in-repo .github/steward-receipts/ file, symlink, and world-writable file MUST ALL FAIL!
    const inRepoDir = path.join(repo.dir, '.github/steward-receipts')
    mkdirSync(inRepoDir, { recursive: true })
    writeFileSync(path.join(inRepoDir, `${highRiskSha}.json`), JSON.stringify(validReceipt, null, 2))
    const gInRepo = runStewardGate({
      root: repo.dir,
      mode: 'enforce-commit',
      baseRef: lowRiskSha,
      headRef: highRiskSha,
      requireRootOwner: false,
    })
    assert.equal(gInRepo.exitCode, 1, 'unsigned in-repo .github/steward-receipts/ MUST NOT be trusted in production')

    const gInRepoExplicit = runStewardGate({
      root: repo.dir,
      mode: 'enforce-commit',
      baseRef: lowRiskSha,
      headRef: highRiskSha,
      explicitReceiptPath: path.join(inRepoDir, `${highRiskSha}.json`),
      requireRootOwner: false,
    })
    assert.equal(gInRepoExplicit.exitCode, 1)
    assert.match(gInRepoExplicit.receiptLookup?.error ?? '', /STEWARD-UNTRUSTED-RECEIPT-SOURCE/)

    const symPath = path.join(receiptDir, 'symlink-receipt.json')
    symlinkSync(path.join(receiptDir, `${highRiskSha}.json`), symPath)
    const gSymlink = runStewardGate({
      root: repo.dir,
      mode: 'enforce-commit',
      baseRef: lowRiskSha,
      headRef: highRiskSha,
      explicitReceiptPath: symPath,
      requireRootOwner: false,
    })
    assert.equal(gSymlink.exitCode, 1)
    assert.match(gSymlink.receiptLookup?.error ?? '', /no symlinks/)

    chmodSync(path.join(receiptDir, `${highRiskSha}.json`), 0o666)
    const gWritable = runStewardGate({
      root: repo.dir,
      mode: 'enforce-commit',
      baseRef: lowRiskSha,
      headRef: highRiskSha,
      receiptDirs: [receiptDir],
      requireRootOwner: false,
    })
    assert.equal(gWritable.exitCode, 1)
    assert.match(gWritable.receiptLookup?.error ?? '', /writable/)
    chmodSync(path.join(receiptDir, `${highRiskSha}.json`), 0o644)

    // 6. Commit trailer `Steward-Receipt:` pointing to EXTERNAL receipt path under enforce-pr
    const trailerReceiptPath = path.join(receiptDir, 'external-trailer-receipt.json')
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
      requireRootOwner: false,
    })
    assert.equal(gTrailer.ok, true)
    assert.equal(gTrailer.exitCode, 0)
  })

  test('B3: arch-steward-review.sh --dry-run is HARD REJECTED by --enforce-commit (exit 1); real --channel command APPROVE passes & VETO blocks', (t) => {
    const repo = initTempGitRepo()
    const extDir = mkdtempSync(path.join(tmpdir(), 'steward-review-ext-'))
    t.after(() => {
      rmSync(repo.dir, { recursive: true, force: true })
      rmSync(extDir, { recursive: true, force: true })
    })
    const baseSha = repo.git(['rev-parse', 'HEAD'])

    repo.write('packages/gateway/src/stewardDemo.ts', 'export function demo() { return 42 }\n')
    const headSha = repo.commit('feat(v5): touch gateway core for dry-run & real channel tests')

    // 1. Reject same-family before running review
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

    // 2. Refuse combining --dry-run with --publish-github-status
    const rDryPublish = spawnSync(
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
        '--dry-run',
        '--publish-github-status',
      ],
      { encoding: 'utf8' },
    )
    assert.equal(rDryPublish.status, 2)

    // 3. Print prompt covers all 4 Architecture Steward dimensions
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

    // 4. --dry-run writes non-production schema (dryRun=true, never approve) and is HARD-REJECTED (exit 1)!
    const dryOut = path.join(extDir, `dry-${headSha}.json`)
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
        dryOut,
        '--dry-run',
      ],
      { encoding: 'utf8' },
    )
    assert.equal(rDry.status, 0, `dry-run preview failed: stderr=${rDry.stderr}`)
    assert.ok(existsSync(dryOut), 'dry-run must write preview artifact')
    const dryDoc = JSON.parse(readFileSync(dryOut, 'utf8'))
    assert.equal(dryDoc.schemaVersion, ARCH_STEWARD_DRY_RUN_SCHEMA_VERSION)
    assert.equal(dryDoc.dryRun, true)
    assert.notEqual(dryDoc.verdict, 'approve')

    const rDryEnforce = runAuditCli([
      '--enforce-commit',
      '--unsafe-test-skip-owner',
      '--root',
      repo.dir,
      '--base',
      baseSha,
      '--head',
      headSha,
      '--receipt',
      dryOut,
    ])
    assert.equal(rDryEnforce.status, 1, `dry-run receipt MUST be hard-rejected (exit 1), got stdout=${rDryEnforce.stdout}`)
    assert.match(rDryEnforce.stderr, /STEWARD-DRY-RUN-REJECTED/)

    // 4b. Placeholder jobId / example / mock in a forged production-schema receipt MUST ALSO BE REJECTED!
    for (const badJobId of ['dry-run-1234', 'example-job-01', 'mock-audit-9']) {
      const forged = signArchStewardReceipt(
        makeUnsignedReceipt({
          headSha,
          baseSha,
          triggers: ['CLONE_OR_T2_CORE_PATH'],
          usageEvidence: {
            jobId: badJobId,
            sessionKey: 'arch-steward:google-gemini:real',
            timestamp: '2026-11-26T14:00:00Z',
            provider: 'agy',
          },
        }),
      )
      const vRes = verifyArchStewardReceipt(forged, {
        headSha,
        baseSha,
        requiredTriggers: ['CLONE_OR_T2_CORE_PATH'],
      })
      assert.equal(vRes.ok, false, `placeholder jobId ${badJobId} must be rejected`)
      assert.ok(vRes.violations.some((v) => v.code === 'STEWARD-PLACEHOLDER-EVIDENCE'))
    }

    // 5. Real execution control (APPROVE): --channel command returning valid cross-family approve -> exit 0!
    const approveOut = path.join(extDir, `${headSha}.json`)
    const fakeGhBin = path.join(extDir, 'bin')
    const ghLog = path.join(extDir, 'gh-calls.log')
    mkdirSync(fakeGhBin, { recursive: true })
    writeFileSync(
      path.join(fakeGhBin, 'gh'),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${ghLog}"\n`,
      { mode: 0o755 },
    )
    const approvePayload = JSON.stringify({
      verdict: 'approve',
      dimensions: {
        godClassAppend: { status: 'pass', notes: 'New isolated module; no append to magnet.' },
        wheelReinvention: { status: 'pass', notes: 'No duplicate utility introduced.' },
        boundaryIntegrity: { status: 'pass', notes: 'Respects gateway boundaries.' },
        complexityDrift: { status: 'pass', notes: 'Trivial 1-line helper.' },
      },
      blockers: [],
    })
    const rRealApprove = spawnSync(
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
        '--channel',
        'command',
        '--out',
        approveOut,
        '--publish-github-status',
        '--github-repo',
        'dream-star-end/openclaude',
        '--unsafe-test-skip-owner',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fakeGhBin}:${process.env.PATH ?? ''}`,
          OC_STEWARD_REVIEW_CMD: `cat >/dev/null; printf '%s' '${approvePayload}'`,
        },
      },
    )
    assert.equal(rRealApprove.status, 0, `real APPROVE failed: stdout=${rRealApprove.stdout} stderr=${rRealApprove.stderr}`)
    const realDoc = JSON.parse(readFileSync(approveOut, 'utf8'))
    assert.equal(realDoc.schemaVersion, ARCH_STEWARD_RECEIPT_SCHEMA_VERSION)
    assert.equal(realDoc.dryRun, undefined)
    assert.equal(realDoc.verdict, 'approve')
    assert.ok(existsSync(ghLog), 'real APPROVE with --publish-github-status must invoke gh api')
    const ghCall = readFileSync(ghLog, 'utf8')
    assert.match(ghCall, /context=oc-v5\/arch-steward/)
    assert.match(ghCall, /verdict=approve/)
    assert.match(ghCall, /author=openai-gpt/)
    assert.match(ghCall, /steward=google-gemini/)

    // 6. Real execution control (VETO): --channel command returning veto -> exit 1 & NEVER publishes status!
    rmSync(ghLog, { force: true })
    const vetoOut = path.join(extDir, `veto-${headSha}.json`)
    const vetoPayload = JSON.stringify({
      verdict: 'veto',
      dimensions: {
        godClassAppend: { status: 'pass', notes: 'ok' },
        wheelReinvention: { status: 'pass', notes: 'ok' },
        boundaryIntegrity: { status: 'veto', notes: 'Breaks gateway boundary invariant' },
        complexityDrift: { status: 'pass', notes: 'ok' },
      },
      blockers: [
        {
          dimension: 'boundaryIntegrity',
          severity: 'P1',
          location: 'packages/gateway/src/stewardDemo.ts:1',
          reason: 'Direct boundary bypass',
          remediation: 'Route through protocol contract',
        },
      ],
    })
    const rRealVeto = spawnSync(
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
        '--channel',
        'command',
        '--out',
        vetoOut,
        '--publish-github-status',
        '--github-repo',
        'dream-star-end/openclaude',
        '--unsafe-test-skip-owner',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fakeGhBin}:${process.env.PATH ?? ''}`,
          OC_STEWARD_REVIEW_CMD: `cat >/dev/null; printf '%s' '${vetoPayload}'`,
        },
      },
    )
    assert.equal(rRealVeto.status, 1, 'real VETO MUST exit 1')
    assert.match(rRealVeto.stderr, /STEWARD-HARD-VETO/)
    assert.equal(existsSync(ghLog), true, 'real VETO with --publish-github-status MUST publish failure/veto status to supersede any prior approve')
    const vetoGhLog = readFileSync(ghLog, 'utf8')
    assert.match(vetoGhLog, /state=failure/)
    assert.match(vetoGhLog, /context=oc-v5\/arch-steward/)
    assert.match(vetoGhLog, /verdict=veto/)

    // 7. B3: verifyArchStewardReceipt distinguishes hmacVerified vs rootFileIntegrity & fails closed when requireHmac=true without key
    const plainReceipt = signArchStewardReceipt(
      makeUnsignedReceipt({
        headSha,
        baseSha,
        triggers: ['CLONE_OR_T2_CORE_PATH'],
      }),
    )
    const plainRes = verifyArchStewardReceipt(plainReceipt, {
      headSha,
      baseSha,
      requiredTriggers: ['CLONE_OR_T2_CORE_PATH'],
      rootFileIntegrity: true,
    })
    assert.equal(plainRes.ok, true)
    assert.equal(plainRes.hmacVerified, false, 'plain sha256 receipt must report hmacVerified=false')
    assert.equal(plainRes.rootFileIntegrity, true)
    assert.equal(plainRes.integrityMode, 'root-file-sha256')

    const requireHmacNoKey = verifyArchStewardReceipt(plainReceipt, {
      headSha,
      baseSha,
      requiredTriggers: ['CLONE_OR_T2_CORE_PATH'],
      requireHmac: true,
      rootFileIntegrity: true,
    })
    assert.equal(requireHmacNoKey.ok, false, 'requireHmac=true without key MUST fail closed')
    assert.ok(requireHmacNoKey.violations.some((v) => v.code === 'STEWARD-RECEIPT-DIGEST-MISMATCH'))
  })

  test('B2: out-of-commit GitHub Commit Status oc-v5/arch-steward passes on valid cross-family status and rejects same-family/dry-run/veto/untrusted', async (t) => {
    const repo = initTempGitRepo()
    t.after(() => rmSync(repo.dir, { recursive: true, force: true }))
    const baseSha = repo.git(['rev-parse', 'HEAD'])
    repo.write('packages/gateway/src/githubStatusTest.ts', 'export const ok = true\n')
    const headSha = repo.commit('feat(v5): core gateway change verified via GitHub status')
    const shortSha = headSha.slice(0, 12)

    const makeMockFetch = (statuses: unknown[]): FetchLike => async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => statuses,
    })

    // 1. Valid trusted cross-family status -> PASS
    const gOk = await runStewardGateAsync({
      root: repo.dir,
      mode: 'enforce-pr',
      baseRef: baseSha,
      headRef: headSha,
      github: {
        repo: 'dream-star-end/openclaude',
        token: 'ghs_mock_token',
        fetchImpl: makeMockFetch([
          {
            id: 50,
            context: 'oc-v5/arch-steward',
            state: 'success',
            description: `verdict=approve sha=${shortSha} author=openai-gpt steward=google-gemini digest=hmac-sha256:0123456789abcdef`,
            creator: { login: 'dream-star-end' },
            created_at: '2026-11-26T15:00:00Z',
          },
        ]),
      },
    })
    assert.equal(gOk.ok, true)
    assert.equal(gOk.exitCode, 0)
    assert.equal(gOk.receiptLookup?.channel, 'github-status')

    // 2. Same-family status -> REJECT
    const gSame = await runStewardGateAsync({
      root: repo.dir,
      mode: 'enforce-commit',
      baseRef: baseSha,
      headRef: headSha,
      github: {
        repo: 'dream-star-end/openclaude',
        token: 'ghs_mock_token',
        fetchImpl: makeMockFetch([
          {
            id: 51,
            context: 'oc-v5/arch-steward',
            state: 'success',
            description: `verdict=approve sha=${shortSha} author=openai-gpt steward=openai-gpt digest=hmac-sha256:0123456789abcdef`,
            creator: { login: 'dream-star-end' },
            created_at: '2026-11-26T15:00:00Z',
          },
        ]),
      },
    })
    assert.equal(gSame.ok, false)
    assert.equal(gSame.exitCode, 1)

    // 3. Dry-run marker or untrusted creator or wrong SHA -> REJECT
    for (const badStatus of [
      {
        id: 52,
        context: 'oc-v5/arch-steward',
        state: 'success',
        description: `verdict=approve sha=${shortSha} author=openai-gpt steward=google-gemini digest=sha256:0123456789abcdef dry-run`,
        creator: { login: 'dream-star-end' },
      },
      {
        id: 53,
        context: 'oc-v5/arch-steward',
        state: 'success',
        description: `verdict=approve sha=${shortSha} author=openai-gpt steward=google-gemini digest=sha256:0123456789abcdef`,
        creator: { login: 'untrusted-bot' },
      },
      {
        id: 54,
        context: 'oc-v5/arch-steward',
        state: 'success',
        description: 'verdict=approve sha=aaaaaaaaaaaa author=openai-gpt steward=google-gemini digest=sha256:0123456789abcdef',
        creator: { login: 'dream-star-end' },
      },
    ]) {
      const gBad = await runStewardGateAsync({
        root: repo.dir,
        mode: 'enforce-commit',
        baseRef: baseSha,
        headRef: headSha,
        github: {
          repo: 'dream-star-end/openclaude',
          token: 'ghs_mock_token',
          fetchImpl: makeMockFetch([badStatus]),
        },
      })
      assert.equal(gBad.ok, false)
      assert.equal(gBad.exitCode, 1)
    }

    // 3b. B3: GitHub VETO / failure status takes precedence over ANY approve status on the same SHA — AND overrides local approve cross-channel!
    const localReceiptDir = path.join(repo.dir, '.local-receipts-veto-test')
    mkdirSync(localReceiptDir, { recursive: true })
    const localApprove = signArchStewardReceipt(
      makeUnsignedReceipt({
        headSha,
        baseSha,
        triggers: ['CLONE_OR_T2_CORE_PATH'],
      }),
    )
    writeFileSync(path.join(localReceiptDir, `${headSha}.json`), JSON.stringify(localApprove, null, 2))

    const gVetoSupersedes = await runStewardGateAsync({
      root: repo.dir,
      mode: 'enforce-commit',
      baseRef: baseSha,
      headRef: headSha,
      receiptDirs: [localReceiptDir],
      requireRootOwner: false,
      allowUntrustedRepoReceipt: true,
      github: {
        repo: 'dream-star-end/openclaude',
        token: 'ghs_mock_token',
        fetchImpl: makeMockFetch([
          {
            id: 60,
            context: 'oc-v5/arch-steward',
            state: 'success',
            description: `verdict=approve sha=${shortSha} author=openai-gpt steward=google-gemini digest=hmac-sha256:0123456789abcdef`,
            creator: { login: 'dream-star-end' },
            created_at: '2026-11-26T15:05:00Z',
          },
          {
            id: 59,
            context: 'oc-v5/arch-steward',
            state: 'failure',
            description: `verdict=veto sha=${shortSha} author=openai-gpt steward=google-gemini digest=hmac-sha256:deadbeef01234567`,
            creator: { login: 'dream-star-end' },
            created_at: '2026-11-26T15:02:00Z',
          },
        ]),
      },
    })
    assert.equal(gVetoSupersedes.ok, false, 'GitHub failure/veto MUST supersede both approve status and local approve receipt')
    assert.equal(gVetoSupersedes.exitCode, 1)
    assert.equal(gVetoSupersedes.githubStatus?.verdict, 'veto')

    // 4. Real CLI subprocess against local HTTP mock GitHub API (hosted runner without host receipt dir)
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Connection', 'close')
      if (req.url?.startsWith(`/repos/dream-star-end/openclaude/commits/${headSha}/statuses`)) {
        res.end(
          JSON.stringify([
            {
              id: 88,
              context: 'oc-v5/arch-steward',
              state: 'success',
              description: `verdict=approve sha=${shortSha} author=anthropic-claude steward=openai-gpt digest=hmac-sha256:fedcba9876543210`,
              creator: { login: 'dream-star-end' },
              created_at: '2026-11-26T15:10:00Z',
            },
          ]),
        )
        return
      }
      res.end('[]')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const addr = server.address() as { port: number }
      const rCli = await runAuditCliAsync(
        [
          '--enforce-commit',
          '--root',
          repo.dir,
          '--base',
          baseSha,
          '--head',
          headSha,
          '--github-repo',
          'dream-star-end/openclaude',
          '--github-api-url',
          `http://127.0.0.1:${addr.port}`,
        ],
        { GITHUB_TOKEN: 'ghs_test_token' },
      )
      assert.equal(rCli.status, 0, `expected exit 0 via GitHub status, stderr=${rCli.stderr}`)
      assert.match(rCli.stdout, /approved via GitHub status/)
    } finally {
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
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

describe('Host .hmac-key single-source resolution & arch-steward-review.sh parity (B1 & B2)', () => {
  test('B2: distinguishes absent vs present-unreadable vs broken-symlink/loose-mode and blocks plain sha256 downgrade', (t) => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'steward-hmac-default-'))
    t.after(() => rmSync(tmp, { recursive: true, force: true }))
    const ctrlDir = path.join(tmp, 'control')
    mkdirSync(ctrlDir, { recursive: true })
    const keyPath = path.join(ctrlDir, '.hmac-key')
    const env = { OC_GOVERNOR_ROOT: tmp }

    // 1. Truly absent -> requireHmac: false
    assert.deepEqual(
      resolveStewardHmacKeyState({
        hmacKeyEnv: 'OC_STEWARD_HMAC_KEY',
        requireRootOwner: false,
        allowHostDefault: true,
        env,
        isRoot: true,
      }),
      { requireHmac: false },
    )

    // 2. Broken symlink -> MUST throw fail-closed even for non-root!
    symlinkSync(path.join(tmp, 'does-not-exist'), keyPath)
    assert.throws(
      () =>
        resolveStewardHmacKeyState({
          hmacKeyEnv: 'OC_STEWARD_HMAC_KEY',
          requireRootOwner: false,
          allowHostDefault: true,
          env,
          isRoot: false,
        }),
      /no symlinks/,
    )
    rmSync(keyPath, { force: true })

    // 3. Valid 0600 key -> loaded & requireHmac: true; inert when allowHostDefault=false or dir overridden
    writeFileSync(keyPath, 'host-steward-secret-key-0123456789\n')
    chmodSync(keyPath, 0o600)
    assert.deepEqual(
      resolveStewardHmacKeyState({
        hmacKeyEnv: 'OC_STEWARD_HMAC_KEY',
        requireRootOwner: false,
        allowHostDefault: true,
        env,
        isRoot: true,
      }),
      { hmacKey: 'host-steward-secret-key-0123456789', requireHmac: true, source: 'host-default' },
    )
    assert.deepEqual(
      resolveStewardHmacKeyState({
        hmacKeyEnv: 'OC_STEWARD_HMAC_KEY',
        requireRootOwner: false,
        allowHostDefault: false,
        env,
        isRoot: true,
      }),
      { requireHmac: false },
    )
    assert.deepEqual(
      resolveStewardHmacKeyState({
        hmacKeyEnv: 'OC_STEWARD_HMAC_KEY',
        requireRootOwner: false,
        allowHostDefault: true,
        receiptDirs: ['/tmp/dir'],
        env,
        isRoot: true,
      }),
      { requireHmac: false },
    )

    // 4. Non-root EACCES on valid 0600 key -> requireHmac: true (NO plain sha256 downgrade!)
    const nonRootEaccesState = resolveStewardHmacKeyState({
      hmacKeyEnv: 'OC_STEWARD_HMAC_KEY',
      requireRootOwner: true,
      allowHostDefault: true,
      env,
      isRoot: false,
      loadKeyFile: () => ({
        present: true,
        ok: false,
        reason: `failed to read HMAC key file ${keyPath}: EACCES: permission denied`,
      }),
    })
    assert.deepEqual(nonRootEaccesState, {
      hmacKey: undefined,
      requireHmac: true,
      source: 'host-default',
    })
    const plainReceipt = signArchStewardReceipt(
      makeUnsignedReceipt({
        headSha: 'a'.repeat(40),
        baseSha: 'b'.repeat(40),
        triggers: ['CLONE_OR_T2_CORE_PATH'],
      }),
    )
    const verDown = verifyArchStewardReceipt(plainReceipt, {
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      requiredTriggers: ['CLONE_OR_T2_CORE_PATH'],
      hmacKey: nonRootEaccesState.hmacKey,
      requireHmac: nonRootEaccesState.requireHmac,
      rootFileIntegrity: true,
    })
    assert.equal(verDown.ok, false, 'non-root EACCES on host .hmac-key MUST reject local plain sha256 receipt')
    assert.ok(verDown.violations.some((v) => v.code === 'STEWARD-RECEIPT-DIGEST-MISMATCH'))

    // 5. Loose permissions (0644) -> throws fail-closed
    chmodSync(keyPath, 0o644)
    assert.throws(
      () =>
        resolveStewardHmacKeyState({
          hmacKeyEnv: 'OC_STEWARD_HMAC_KEY',
          requireRootOwner: false,
          allowHostDefault: true,
          env,
          isRoot: true,
        }),
      /mode 0600\/0400/,
    )

    // 6. B2 exclusive override: an empty --receipt-dir / OC_STEWARD_RECEIPT_DIR MUST NOT fall back to host default dir!
    chmodSync(keyPath, 0o600)
    const hostReceiptDir = path.join(tmp, 'steward-receipts')
    const emptyOverrideDir = path.join(tmp, 'empty-override-receipts')
    mkdirSync(hostReceiptDir, { recursive: true })
    mkdirSync(emptyOverrideDir, { recursive: true })
    const repo = initTempGitRepo()
    t.after(() => rmSync(repo.dir, { recursive: true, force: true }))
    const baseSha = repo.git(['rev-parse', 'HEAD'])
    repo.write('packages/gateway/src/b2FallbackGuard.ts', 'export const b2 = 1\n')
    const hostReceiptFile = path.join(hostReceiptDir, 'placeholder.json')
    const headSha = repo.commit(
      `feat(v5): touch gateway core for B2 exclusive override guard\n\nSteward-Receipt: ${hostReceiptFile}`,
    )
    const plainHostReceipt = signArchStewardReceipt(
      makeUnsignedReceipt({
        headSha,
        baseSha,
        triggers: ['CLONE_OR_T2_CORE_PATH'],
      }),
    )
    writeFileSync(path.join(hostReceiptDir, `${headSha}.json`), JSON.stringify(plainHostReceipt, null, 2))
    writeFileSync(hostReceiptFile, JSON.stringify(plainHostReceipt, null, 2))

    // Without override: host .hmac-key rejects plain sha256 receipt with exact STEWARD-RECEIPT-DIGEST-MISMATCH
    const cleanB2Env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([k]) => k !== 'OC_STEWARD_HMAC_KEY' && k !== 'OC_STEWARD_RECEIPT_DIR',
      ),
    )
    const rHostPlain = spawnSync(
      'npx',
      [
        '--no-install',
        'tsx',
        AUDIT_SCRIPT,
        '--enforce-commit',
        '--root',
        repo.dir,
        '--base',
        baseSha,
        '--head',
        headSha,
        '--unsafe-test-skip-owner',
      ],
      { cwd: ROOT, env: { ...cleanB2Env, OC_GOVERNOR_ROOT: tmp }, encoding: 'utf8' },
    )
    assert.equal(rHostPlain.status, 1, 'host default dir with .hmac-key MUST reject plain sha256 receipt')
    assert.match(`${rHostPlain.stdout}\n${rHostPlain.stderr}`, /STEWARD-RECEIPT-DIGEST-MISMATCH/)

    // Direct --receipt pointing into host governor root MUST ALSO enforce host .hmac-key (zero plain-sha256 downgrade!)
    const rDirectHost = spawnSync(
      'npx',
      [
        '--no-install',
        'tsx',
        AUDIT_SCRIPT,
        '--enforce-commit',
        '--root',
        repo.dir,
        '--base',
        baseSha,
        '--head',
        headSha,
        '--receipt',
        hostReceiptFile,
        '--unsafe-test-skip-owner',
      ],
      { cwd: ROOT, env: { ...cleanB2Env, OC_GOVERNOR_ROOT: tmp }, encoding: 'utf8' },
    )
    assert.equal(rDirectHost.status, 1, '--receipt inside host governor root MUST enforce host .hmac-key')
    assert.match(`${rDirectHost.stdout}\n${rDirectHost.stderr}`, /STEWARD-RECEIPT-DIGEST-MISMATCH/)

    // Parent-directory symlink alias pointing into host governor root MUST ALSO resolve via realpath & enforce host .hmac-key!
    const aliasDir = path.join(tmpdir(), `steward-gov-alias-${process.pid}-${Date.now()}`)
    symlinkSync(hostReceiptDir, aliasDir)
    t.after(() => rmSync(aliasDir, { force: true }))
    const rAliasHost = spawnSync(
      'npx',
      [
        '--no-install',
        'tsx',
        AUDIT_SCRIPT,
        '--enforce-commit',
        '--root',
        repo.dir,
        '--base',
        baseSha,
        '--head',
        headSha,
        '--receipt-dir',
        aliasDir,
        '--unsafe-test-skip-owner',
      ],
      { cwd: ROOT, env: { ...cleanB2Env, OC_GOVERNOR_ROOT: tmp }, encoding: 'utf8' },
    )
    assert.equal(rAliasHost.status, 1, 'parent-directory symlink alias into host governor root MUST enforce host .hmac-key')
    assert.match(`${rAliasHost.stdout}\n${rAliasHost.stderr}`, /STEWARD-RECEIPT-DIGEST-MISMATCH/)

    // With empty --receipt-dir override AND Steward-Receipt trailer pointing to host file:
    // MUST stop local lookup immediately (no fallback to host dir OR commit trailer!)
    const rEmptyDir = spawnSync(
      'npx',
      [
        '--no-install',
        'tsx',
        AUDIT_SCRIPT,
        '--enforce-commit',
        '--root',
        repo.dir,
        '--base',
        baseSha,
        '--head',
        headSha,
        '--receipt-dir',
        emptyOverrideDir,
        '--unsafe-test-skip-owner',
      ],
      { cwd: ROOT, env: { ...cleanB2Env, OC_GOVERNOR_ROOT: tmp }, encoding: 'utf8' },
    )
    assert.equal(rEmptyDir.status, 1, 'empty --receipt-dir override MUST NOT fall back to host dir or commit trailer')
    assert.match(`${rEmptyDir.stdout}\n${rEmptyDir.stderr}`, /STEWARD-RECEIPT-MISSING/)

    // With empty OC_STEWARD_RECEIPT_DIR override AND commit trailer: also MUST NOT fall back!
    const rEmptyEnvDir = spawnSync(
      'npx',
      [
        '--no-install',
        'tsx',
        AUDIT_SCRIPT,
        '--enforce-commit',
        '--root',
        repo.dir,
        '--base',
        baseSha,
        '--head',
        headSha,
        '--unsafe-test-skip-owner',
      ],
      {
        cwd: ROOT,
        env: { ...cleanB2Env, OC_GOVERNOR_ROOT: tmp, OC_STEWARD_RECEIPT_DIR: emptyOverrideDir },
        encoding: 'utf8',
      },
    )
    assert.equal(rEmptyEnvDir.status, 1, 'empty OC_STEWARD_RECEIPT_DIR MUST NOT fall back to host dir or commit trailer')
    assert.match(`${rEmptyEnvDir.stdout}\n${rEmptyEnvDir.stderr}`, /STEWARD-RECEIPT-MISSING/)
  })

  test('B1: arch-steward-review.sh with file-only .hmac-key (no OC_STEWARD_HMAC_KEY env) produces hmac-sha256 receipt accepted by release train', (t) => {
    const repo = initTempGitRepo()
    const govRoot = mkdtempSync(path.join(tmpdir(), 'steward-b1-gov-'))
    t.after(() => {
      rmSync(repo.dir, { recursive: true, force: true })
      rmSync(govRoot, { recursive: true, force: true })
    })
    const ctrlDir = path.join(govRoot, 'control')
    mkdirSync(ctrlDir, { recursive: true })
    const keyPath = path.join(ctrlDir, '.hmac-key')
    writeFileSync(keyPath, 'b1-file-only-host-hmac-secret-9876543210\n')
    chmodSync(keyPath, 0o600)

    const baseSha = repo.git(['rev-parse', 'HEAD'])
    repo.write('packages/gateway/src/b1HmacParity.ts', 'export const b1 = 1\n')
    const headSha = repo.commit('feat(v5): touch gateway core for B1 file-only HMAC parity test')

    const approvePayload = JSON.stringify({
      verdict: 'approve',
      dimensions: {
        godClassAppend: { status: 'pass', notes: 'No append magnet touched.' },
        wheelReinvention: { status: 'pass', notes: 'No clones.' },
        boundaryIntegrity: { status: 'pass', notes: 'Clean boundary.' },
        complexityDrift: { status: 'pass', notes: 'Trivial module.' },
      },
      blockers: [],
    })
    const fakeCmd = `node -e 'process.stdout.write(process.argv[1])' '${approvePayload}'`
    const baseEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        ([k]) => k !== 'OC_STEWARD_HMAC_KEY' && k !== 'OC_STEWARD_RECEIPT_DIR',
      ),
    )
    const cleanEnv: NodeJS.ProcessEnv = {
      ...baseEnv,
      OC_GOVERNOR_ROOT: govRoot,
      OC_STEWARD_REVIEW_CMD: fakeCmd,
    }

    const rWrap = spawnSync(
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
        'gemini-4-neon',
        '--steward-model',
        'gpt-6.2-astra',
        '--channel',
        'command',
        '--unsafe-test-skip-owner',
      ],
      { env: cleanEnv, encoding: 'utf8' },
    )
    assert.equal(rWrap.status, 0, `wrapper failed: stdout=${rWrap.stdout}\nstderr=${rWrap.stderr}`)

    const producedPath = path.join(govRoot, 'steward-receipts', `${headSha}.json`)
    assert.ok(existsSync(producedPath), `expected receipt at ${producedPath}`)
    const producedDoc = JSON.parse(readFileSync(producedPath, 'utf8'))
    assert.match(
      String(producedDoc.receiptDigest ?? ''),
      /^hmac-sha256:[0-9a-f]{64}$/,
      'wrapper targeting host governor root with .hmac-key MUST sign with hmac-sha256',
    )

    // Verify exact release-train invocation (--hmac-key-file) AND default host auto-discovery both ACCEPT it
    const rTrainExplicit = spawnSync(
      'npx',
      [
        '--no-install',
        'tsx',
        AUDIT_SCRIPT,
        '--enforce-commit',
        '--root',
        repo.dir,
        '--base',
        baseSha,
        '--head',
        headSha,
        '--hmac-key-file',
        keyPath,
        '--unsafe-test-skip-owner',
      ],
      { cwd: ROOT, env: cleanEnv, encoding: 'utf8' },
    )
    assert.equal(
      rTrainExplicit.status,
      0,
      `train explicit --hmac-key-file rejected wrapper receipt: ${rTrainExplicit.stdout}\n${rTrainExplicit.stderr}`,
    )

    const rTrainAuto = spawnSync(
      'npx',
      [
        '--no-install',
        'tsx',
        AUDIT_SCRIPT,
        '--enforce-commit',
        '--root',
        repo.dir,
        '--base',
        baseSha,
        '--head',
        headSha,
        '--unsafe-test-skip-owner',
      ],
      { cwd: ROOT, env: cleanEnv, encoding: 'utf8' },
    )
    assert.equal(
      rTrainAuto.status,
      0,
      `default host auto-discovery rejected wrapper receipt: ${rTrainAuto.stdout}\n${rTrainAuto.stderr}`,
    )

    // Parity 2: OC_STEWARD_RECEIPT_DIR as parent-dir symlink alias into host governor root -> BOTH sign & verify use hmac-sha256
    const hostAlias = path.join(tmpdir(), `steward-b1-alias-${process.pid}-${Date.now()}`)
    symlinkSync(path.join(govRoot, 'steward-receipts'), hostAlias)
    t.after(() => rmSync(hostAlias, { force: true }))
    rmSync(producedPath, { force: true })
    const rAliasWrap = spawnSync(
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
        'gemini-4-neon',
        '--steward-model',
        'gpt-6.2-astra',
        '--channel',
        'command',
        '--unsafe-test-skip-owner',
      ],
      { env: { ...cleanEnv, OC_STEWARD_RECEIPT_DIR: hostAlias }, encoding: 'utf8' },
    )
    assert.equal(rAliasWrap.status, 0, `alias wrapper failed: ${rAliasWrap.stdout}\n${rAliasWrap.stderr}`)
    const aliasDoc = JSON.parse(readFileSync(producedPath, 'utf8'))
    assert.match(String(aliasDoc.receiptDigest ?? ''), /^hmac-sha256:[0-9a-f]{64}$/)
    const rAliasVerify = spawnSync(
      'npx',
      [
        '--no-install',
        'tsx',
        AUDIT_SCRIPT,
        '--enforce-commit',
        '--root',
        repo.dir,
        '--base',
        baseSha,
        '--head',
        headSha,
        '--unsafe-test-skip-owner',
      ],
      { cwd: ROOT, env: { ...cleanEnv, OC_STEWARD_RECEIPT_DIR: hostAlias }, encoding: 'utf8' },
    )
    assert.equal(rAliasVerify.status, 0, `alias verify failed: ${rAliasVerify.stdout}\n${rAliasVerify.stderr}`)

    // Parity 3: OC_STEWARD_RECEIPT_DIR outside host governor root -> wrapper & verifier agree on sha256 (no host key leak)
    const extReceiptDir = mkdtempSync(path.join(tmpdir(), 'steward-b1-ext-'))
    t.after(() => rmSync(extReceiptDir, { recursive: true, force: true }))
    const rExtWrap = spawnSync(
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
        'gemini-4-neon',
        '--steward-model',
        'gpt-6.2-astra',
        '--channel',
        'command',
        '--unsafe-test-skip-owner',
      ],
      { env: { ...cleanEnv, OC_STEWARD_RECEIPT_DIR: extReceiptDir }, encoding: 'utf8' },
    )
    assert.equal(rExtWrap.status, 0, `external wrapper failed: ${rExtWrap.stdout}\n${rExtWrap.stderr}`)
    const extDoc = JSON.parse(readFileSync(path.join(extReceiptDir, `${headSha}.json`), 'utf8'))
    assert.match(String(extDoc.receiptDigest ?? ''), /^sha256:[0-9a-f]{64}$/)
    const rExtVerify = spawnSync(
      'npx',
      [
        '--no-install',
        'tsx',
        AUDIT_SCRIPT,
        '--enforce-commit',
        '--root',
        repo.dir,
        '--base',
        baseSha,
        '--head',
        headSha,
        '--unsafe-test-skip-owner',
      ],
      { cwd: ROOT, env: { ...cleanEnv, OC_STEWARD_RECEIPT_DIR: extReceiptDir }, encoding: 'utf8' },
    )
    assert.equal(rExtVerify.status, 0, `external verify failed: ${rExtVerify.stdout}\n${rExtVerify.stderr}`)
  })
})
