import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
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
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runCheckA0Monotonic, runCheckA0MonotonicAsync } from '../check-a0-monotonic.js'
import { computeA0ReceiptDigest, computeA0ReceiptHmac } from '../lib/a0ApprovalReceipt.js'
import type { FetchLike } from '../lib/githubTrustedApproval.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const localTsx = path.join(root, 'node_modules/.bin/tsx')
const tsx = existsSync(localTsx) ? localTsx : 'tsx'
// Always run the trusted referee from the repo root (never execute the candidate's own tampered copy!)
const refereeScript = path.join(root, 'scripts/check-a0-monotonic.ts')

describe('check-a0-monotonic.ts (A0/A1 separation + approval receipts)', () => {
  let repo: string
  let approvalDir: string

  const write = (rel: string, content: string) => {
    const abs = path.join(repo, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }

  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
    assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`)
    return r.stdout.trim()
  }

  const commit = (msg = 'change') => {
    git('add', '-A')
    git('commit', '-qm', msg)
    return git('rev-parse', 'HEAD')
  }

  const checkInProcess = (opts: { base?: string; staged?: boolean } = {}) =>
    runCheckA0Monotonic({
      root: repo,
      base: opts.staged ? undefined : (opts.base ?? 'base'),
      staged: opts.staged,
      approvalDir,
      requireRootOwner: false,
    })

  const cli = (
    args: string[],
    extraEnv: Record<string, string> = {},
    opts: { skipOwner?: boolean } = {},
  ) => {
    const ownerArgs = opts.skipOwner === false ? [] : ['--unsafe-test-skip-owner']
    const r = spawnSync(tsx, [refereeScript, '--root', repo, ...ownerArgs, ...args], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, OC_A0_APPROVAL_DIR: approvalDir, ...extraEnv },
    })
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, out: `${r.stdout}${r.stderr}` }
  }

  const cliAsync = (
    args: string[],
    extraEnv: Record<string, string> = {},
    opts: { skipOwner?: boolean } = {},
  ) =>
    new Promise<{ status: number | null; stdout: string; stderr: string; out: string }>((resolve, reject) => {
      const ownerArgs = opts.skipOwner === false ? [] : ['--unsafe-test-skip-owner']
      const child = spawn(tsx, [refereeScript, '--root', repo, ...ownerArgs, ...args], {
        cwd: repo,
        env: { ...process.env, OC_A0_APPROVAL_DIR: approvalDir, ...extraEnv },
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
      child.on('close', (status) => resolve({ status, stdout, stderr, out: `${stdout}${stderr}` }))
    })

  const writeSignedReceipt = (
    sha: string,
    overrides: Partial<{
      sha: string
      reason: string
      issuedAt: string
      expiresAt: string
      sha256: string
      hmacSha256: string
      hmacKey: string
      allowedPaths: string[]
    }> = {},
    fileName?: string,
  ) => {
    const issuedAt = overrides.issuedAt ?? new Date(Date.now() - 60_000).toISOString()
    const expiresAt = overrides.expiresAt ?? new Date(Date.now() + 3_600_000).toISOString()
    const reason = overrides.reason ?? 'OCV5-904 approved A0 guardrail update'
    const receiptSha = overrides.sha ?? sha
    const fields = {
      sha: receiptSha,
      issuedAt,
      expiresAt,
      reason,
      allowedPaths: overrides.allowedPaths,
    }
    const digest = overrides.sha256 ?? computeA0ReceiptDigest(fields)
    const hmacSha256 =
      overrides.hmacSha256 ??
      (overrides.hmacKey ? computeA0ReceiptHmac(fields, overrides.hmacKey) : undefined)
    const receipt = {
      schemaVersion: 1,
      sha: receiptSha,
      reason,
      approvedBy: 'root',
      issuedAt,
      expiresAt,
      sha256: digest,
      ...(hmacSha256 ? { hmacSha256 } : {}),
      ...(overrides.allowedPaths ? { allowedPaths: overrides.allowedPaths } : {}),
    }
    const targetPath = path.join(approvalDir, fileName ?? `${sha}.json`)
    writeFileSync(targetPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o644 })
    return targetPath
  }

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'a0-monotonic-repo-'))
    approvalDir = mkdtempSync(path.join(tmpdir(), 'a0-monotonic-approvals-'))

    for (const rel of [
      'scripts/check-a0-monotonic.ts',
      'scripts/lib/a0MonotonicRules.ts',
      'scripts/lib/a0ApprovalReceipt.ts',
      'scripts/lib/runtimeImagePin.ts',
      'arch/a0-protected-paths.json',
      'deploy/v5/runtime-image-pin.json',
      '.github/CODEOWNERS',
    ]) {
      const dst = path.join(repo, rel)
      mkdirSync(path.dirname(dst), { recursive: true })
      copyFileSync(path.join(root, rel), dst)
    }

    write('scripts/check-existing-gate.ts', 'export const ok = true\n')
    write(
      'arch/modules.json',
      JSON.stringify(
        {
          schema: 1,
          modules: {
            'web-views': { layer: 'F4', match: ['packages/web-react/src/components/**'], scope: ['browser'] },
            billing: {
              layer: 'L3',
              match: ['packages/commercial/src/billing/**'],
              scope: ['master'],
              allow: ['identity'],
            },
            identity: { layer: 'L3', match: ['packages/commercial/src/auth/**'], scope: ['master'] },
          },
        },
        null,
        2,
      ),
    )
    write(
      '.github/file-size-baseline.json',
      JSON.stringify(
        {
          limit: 3000,
          slack: 0,
          files: { 'src/monolith.ts': 3500 },
          yellowZoneLimit: 2000,
          yellowZoneSlack: 0,
          yellowZoneFiles: {},
          orangeZoneLimit: 800,
          orangeZoneSlack: 0,
          orangeZoneFiles: { 'src/mid.ts': 1000 },
        },
        null,
        2,
      ),
    )
    write(
      '.github/file-size-ratchet-exceptions.json',
      JSON.stringify(
        [
          {
            path: 'src/monolith.ts',
            maxLines: 3600,
            ticket: 'OCV5-100',
            reason: 'split in progress for monolith',
            expires: '2026-12-10',
          },
        ],
        null,
        2,
      ),
    )
    write(
      'arch/ai-smells-baseline.json',
      JSON.stringify(
        {
          schemaVersion: 1,
          generatedAt: '2026-11-26',
          categories: ['emptyCatch', 'typeEscape', 'syncIo', 'lintSuppress'],
          totals: { emptyCatch: 2, typeEscape: 3, syncIo: 0, lintSuppress: 1, all: 6 },
          files: {
            'packages/commercial/src/a.ts': { emptyCatch: 2, typeEscape: 3, syncIo: 0, lintSuppress: 1 },
          },
        },
        null,
        2,
      ),
    )
    write(
      'arch/violations-baseline.json',
      JSON.stringify({ schema: 1, entries: { 'R2-same-layer|a.ts|b': 3 } }, null, 2),
    )
    write(
      'packages/web-react/budgets.json',
      JSON.stringify({ firstScreenGzipBytes: 480000, cssTotalRawBytes: 380000 }, null, 2),
    )
    write(
      '.github/context-eval-baseline.json',
      JSON.stringify(
        {
          schemaVersion: 1,
          thresholds: { maxTotalBytes: 44000, maxTotalGrowthRatio: 0.05, maxSlotGrowthRatio: 0.15, minSlotGrowthBytes: 256 },
          subEvals: { coreMemory: { minPrecisionAt3: 1, maxAvgHitsRatio: 0.4 } },
          waivers: [],
        },
        null,
        2,
      ),
    )
    write(
      'deploy/v5/feature-flags-registry.json',
      JSON.stringify(
        {
          schema: 1,
          flags: [{ name: 'OC_TEMP', permanent: false, expireAt: '2026-12-20' }],
        },
        null,
        2,
      ),
    )
    write('packages/commercial/src/billing/ledger.ts', 'export const ledgerVersion = 1\n')
    write('packages/commercial/src/appFeature.ts', 'export const x = 1\n')

    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
    commit('initial')
    git('tag', 'base')
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
    rmSync(approvalDir, { recursive: true, force: true })
  })

  // === A1 Positive Cases (Auto-Pass) ===

  test('A1 auto-pass: adding a brand-new check-*.ts gate passes', () => {
    write('scripts/check-brand-new-invariant.ts', 'export const check = () => 0\n')
    commit('feat: add new gate')
    const res = checkInProcess()
    assert.equal(res.ok, true)
    assert.equal(res.a1Passes[0]?.rule, 'A1-NEW-GATE-ADDED')
  })

  test('A1 auto-pass: updating deploy/v5/runtime-image-pin.json with valid pinned tag passes', () => {
    write(
      'deploy/v5/runtime-image-pin.json',
      JSON.stringify(
        {
          schemaVersion: 1,
          channel: 'v5-selfhost',
          runtimeImage: 'openclaude/openclaude-runtime:v5-cli-next-slim',
          ticket: 'OCV5-910',
          updatedAt: '2026-11-27',
          cliVersions: { claudeCode: '2.1.333', codex: '0.173.0' },
        },
        null,
        2,
      ),
    )
    commit('chore: bump runtime pin')
    const res = checkInProcess()
    assert.equal(res.ok, true)
    assert.equal(res.a1Passes[0]?.rule, 'A1-RUNTIME-PIN-UPDATE')
  })

  test('A1 auto-pass: splitting arch/modules.json without adding allow edges or authorities passes', () => {
    write(
      'arch/modules.json',
      JSON.stringify(
        {
          schema: 1,
          modules: {
            'web-primitives': { layer: 'F0', match: ['packages/web-react/src/components/ui/**'], scope: ['browser'] },
            'web-chat': { layer: 'F4', match: ['packages/web-react/src/components/chat/**'], scope: ['browser'] },
            'web-settings': { layer: 'F4', match: ['packages/web-react/src/components/settings/**'], scope: ['browser'] },
            billing: { layer: 'L3', match: ['packages/commercial/src/billing/**'], scope: ['master'], allow: [] },
            identity: { layer: 'L3', match: ['packages/commercial/src/auth/**'], scope: ['master'] },
          },
        },
        null,
        2,
      ),
    )
    commit('refactor: split web-views into F0/F4 domains')
    const res = checkInProcess()
    assert.equal(res.ok, true)
    assert.equal(res.a1Passes[0]?.rule, 'A1-MODULES-SPLIT-OR-TIGHTENED')
  })

  test('A1 auto-pass: shrinking baselines, tightening budgets/thresholds, and removing exceptions passes', () => {
    write(
      '.github/file-size-baseline.json',
      JSON.stringify(
        {
          limit: 3000,
          slack: 0,
          files: { 'src/monolith.ts': 3200 },
          yellowZoneLimit: 2000,
          yellowZoneSlack: 0,
          yellowZoneFiles: {},
          orangeZoneLimit: 800,
          orangeZoneSlack: 0,
          orangeZoneFiles: { 'src/mid.ts': 900 },
        },
        null,
        2,
      ),
    )
    write('.github/file-size-ratchet-exceptions.json', '[]\n')
    write(
      'arch/ai-smells-baseline.json',
      JSON.stringify(
        {
          schemaVersion: 1,
          generatedAt: '2026-11-26',
          categories: ['emptyCatch', 'typeEscape', 'syncIo', 'lintSuppress'],
          totals: { emptyCatch: 1, typeEscape: 2, syncIo: 0, lintSuppress: 0, all: 3 },
          files: {
            'packages/commercial/src/a.ts': { emptyCatch: 1, typeEscape: 2, syncIo: 0, lintSuppress: 0 },
          },
        },
        null,
        2,
      ),
    )
    write(
      'arch/violations-baseline.json',
      JSON.stringify({ schema: 1, entries: { 'R2-same-layer|a.ts|b': 1 } }, null, 2),
    )
    write(
      'packages/web-react/budgets.json',
      JSON.stringify({ firstScreenGzipBytes: 450000, cssTotalRawBytes: 350000 }, null, 2),
    )
    write(
      '.github/context-eval-baseline.json',
      JSON.stringify(
        {
          schemaVersion: 1,
          thresholds: { maxTotalBytes: 40000, maxTotalGrowthRatio: 0.04, maxSlotGrowthRatio: 0.12, minSlotGrowthBytes: 128 },
          subEvals: { coreMemory: { minPrecisionAt3: 1, maxAvgHitsRatio: 0.35 } },
          waivers: [],
        },
        null,
        2,
      ),
    )
    commit('refactor: shrink debt across all baselines')
    const res = checkInProcess()
    assert.equal(res.ok, true)
    assert.equal(res.a0Blocks.length, 0)
    assert.ok(res.a1Passes.length >= 6)
  })

  // === A0 Negative Cases & ux_or_billing_only Auto-Approval ===

  test('A1 auto-pass (ux_or_billing_only): modifying/deleting non-meta gate scripts, internal baselines, modules.json, exceptions, and flag TTL auto-passes without A0 block', () => {
    // Deleting or modifying non-meta gate script -> A1-AUTO-NON-UX-BILLING
    rmSync(path.join(repo, 'scripts/check-existing-gate.ts'))
    commit('chore: delete internal gate')
    const rDel = checkInProcess()
    assert.equal(rDel.ok, true)
    assert.equal(rDel.a0Blocks.length, 0)
    assert.equal(rDel.a1Passes[0]?.rule, 'A1-AUTO-NON-UX-BILLING')

    git('reset', '--hard', 'base')
    write('scripts/check-existing-gate.ts', 'export const ok = false\n')
    write(
      'arch/modules.json',
      JSON.stringify(
        {
          schema: 1,
          modules: {
            'web-views': { layer: 'F4', match: ['packages/web-react/src/components/**'], scope: ['browser'] },
            billing: {
              layer: 'L3',
              match: ['packages/commercial/src/billing/**'],
              scope: ['master'],
              allow: ['identity', 'web-views'],
            },
            identity: {
              layer: 'L3',
              match: ['packages/commercial/src/auth/**'],
              scope: ['master'],
              authorities: ['billing-sql'],
            },
          },
        },
        null,
        2,
      ),
    )
    write(
      '.github/file-size-baseline.json',
      JSON.stringify({
        limit: 3000,
        slack: 50,
        files: { 'src/monolith.ts': 3800 },
        yellowZoneLimit: 2000,
        yellowZoneSlack: 0,
        yellowZoneFiles: {},
        orangeZoneLimit: 800,
        orangeZoneSlack: 0,
        orangeZoneFiles: { 'src/mid.ts': 1000 },
      }),
    )
    write(
      '.github/file-size-ratchet-exceptions.json',
      JSON.stringify([
        { path: 'src/monolith.ts', maxLines: 3900, ticket: 'OCV5-100', reason: 'renew', expires: '2026-12-25' },
        { path: 'src/newGiant.ts', maxLines: 950, ticket: 'OCV5-999', reason: 'add', expires: '2026-12-25' },
      ]),
    )
    write(
      'arch/ai-smells-baseline.json',
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: '2026-11-26',
        categories: ['emptyCatch', 'typeEscape', 'syncIo', 'lintSuppress'],
        totals: { emptyCatch: 3, typeEscape: 3, syncIo: 0, lintSuppress: 1, all: 7 },
        files: { 'packages/commercial/src/a.ts': { emptyCatch: 3, typeEscape: 3, syncIo: 0, lintSuppress: 1 } },
      }),
    )
    write('arch/violations-baseline.json', JSON.stringify({ schema: 1, entries: { 'R2-same-layer|a.ts|b': 9 } }))
    write(
      'deploy/v5/feature-flags-registry.json',
      JSON.stringify({ schema: 1, flags: [{ name: 'OC_TEMP', permanent: true, expireAt: '2027-01-15' }] }),
    )
    write('.github/workflows/v5-integ-nightly.yml', 'name: updated\n')
    write('scripts/check-docs-links.ts', 'console.log("ok")\n')
    write('scripts/deploy-v5-selfhost.sh', '#!/usr/bin/env bash\necho ok\n')
    write('biome.json', '{}\n')
    write('changelog.json', '[]\n')
    commit('chore: internal engineering baselines, nightly workflow, deploy script, and internal gates')
    const res = checkInProcess()
    assert.equal(res.ok, true, `non-UX/billing internal surfaces MUST auto-pass: ${JSON.stringify(res.a0Blocks)}`)
    assert.equal(res.a0Blocks.length, 0)
    assert.ok(res.a1Passes.some((p) => p.rule === 'A1-AUTO-NON-UX-BILLING'))
  })

  test('A0 hard-block (steward boundaryIntegrity): neutering UX guard executors, cross-family steward verifier, enforcement workflows, or authzModels.ts MUST hard-block A0', () => {
    // 1. Weakening/neutering UX guard executors, Steward verification chain, or CI enforcement workflows -> A0 block
    const guardedExecutors = [
      { path: 'scripts/check-ui-hard-gates.ts', expectedCat: 'ux-regression-guards', content: 'process.exit(0)\n' },
      { path: 'scripts/check-monotonic-baselines.ts', expectedCat: 'ux-regression-guards', content: 'process.exit(0)\n' },
      { path: 'scripts/check-incident-ledger-superset.ts', expectedCat: 'ux-regression-guards', content: 'process.exit(0)\n' },
      { path: 'scripts/check-context-static.ts', expectedCat: 'ux-regression-guards', content: 'process.exit(0)\n' },
      { path: 'scripts/check-cross-family-audit.ts', expectedCat: 'a0-meta-referee', content: 'process.exit(0)\n' },
      { path: 'scripts/lib/archStewardReceipt.ts', expectedCat: 'a0-meta-referee', content: 'export const verifyArchStewardReceipt = () => ({ ok: true })\n' },
      { path: '.github/workflows/v5-selfhost-gates.yml', expectedCat: 'a0-meta-referee', content: 'name: bypassed\n' },
      { path: '.github/workflows/v5-selfhost-release-gates.yml', expectedCat: 'a0-meta-referee', content: 'name: bypassed\n' },
      { path: '.github/workflows/v5-selfhost-web-react.yml', expectedCat: 'a0-meta-referee', content: 'name: bypassed\n' },
    ]
    for (const item of guardedExecutors) {
      git('reset', '--hard', 'base')
      write(item.path, item.content)
      commit(`bad: neuter ${item.path}`)
      const r = checkInProcess()
      assert.equal(r.ok, false, `neutering ${item.path} MUST hard-block A0`)
      assert.ok(
        r.a0Blocks.some((b) => b.path === item.path && b.category === item.expectedCat),
        `expected ${item.path} under ${item.expectedCat}, got ${JSON.stringify(r.a0Blocks)}`,
      )
    }

    // 2. Bypassing model authorization in authzModels.ts (canUseModel -> return true) or editing modelPublicProjection.ts MUST hard-block A0 (billing_change)
    git('reset', '--hard', 'base')
    write('packages/commercial/src/billing/authzModels.ts', 'export async function canUseModel(): Promise<boolean> { return false }\n')
    write('packages/commercial/src/billing/modelPublicProjection.ts', 'export function projectPublicModels(): string[] { return [] }\n')
    const seededAuthzBase = commit('chore: seed authzModels & modelPublicProjection')

    write('packages/commercial/src/billing/authzModels.ts', 'export async function canUseModel(): Promise<boolean> { return true }\n')
    const bypassSha = commit('bad: bypass canUseModel plan/grant check')
    const rBypass = runCheckA0Monotonic({ root: repo, base: seededAuthzBase, head: bypassSha, approvalDir, requireRootOwner: false })
    assert.equal(rBypass.ok, false, 'runtime bypass in authzModels.ts MUST hard-block A0')
    assert.equal(rBypass.a0Blocks[0]?.category, 'billing-accounting-core')
    assert.equal(rBypass.a0Blocks[0]?.riskCategory, 'billing_change')

    git('reset', '--hard', seededAuthzBase)
    write('packages/commercial/src/billing/modelPublicProjection.ts', 'export function projectPublicModels(): string[] { return ["free"] }\n')
    const projSha = commit('bad: alter modelPublicProjection pricing/auth semantics')
    const rProj = runCheckA0Monotonic({ root: repo, base: seededAuthzBase, head: projSha, approvalDir, requireRootOwner: false })
    assert.equal(rProj.ok, false, 'runtime edit in modelPublicProjection.ts MUST hard-block A0')
    assert.equal(rProj.a0Blocks[0]?.riskCategory, 'billing_change')

    // 3. Pure comment/type edit in authzModels.ts and read-only report helper usageReport.ts still auto-pass A1
    git('reset', '--hard', seededAuthzBase)
    write('packages/commercial/src/billing/authzModels.ts', '// doc comment\nexport type CanUseNote = string\nexport async function canUseModel(): Promise<boolean> { return false }\n')
    write('packages/commercial/src/billing/usageReport.ts', 'export const REPORT_TITLE = "usage"\n')
    const cleanSha = commit('refactor: zero-runtime authz comment + read-only usage report')
    const rClean = runCheckA0Monotonic({ root: repo, base: seededAuthzBase, head: cleanSha, approvalDir, requireRootOwner: false })
    assert.equal(rClean.ok, true, `expected auto-pass, got ${JSON.stringify(rClean.a0Blocks)}`)
    assert.ok(rClean.a1Passes.some((p) => p.path === 'packages/commercial/src/billing/authzModels.ts' && p.rule === 'A1-BILLING-NO-RUNTIME-DIFF'))
    assert.ok(rClean.a1Passes.some((p) => p.path === 'packages/commercial/src/billing/usageReport.ts' && p.rule === 'A1-BILLING-NONCORE-HELPER'))
  })

  test('A0 hard-block (ux_degradation): raising UX budgets, context-eval, UI static/layout baselines, or adding design-tokens exemptions fails with riskCategory=ux_degradation', () => {
    write('packages/web-react/budgets.json', JSON.stringify({ firstScreenGzipBytes: 500000, cssTotalRawBytes: 380000 }))
    write(
      '.github/context-eval-baseline.json',
      JSON.stringify({
        schemaVersion: 1,
        thresholds: { maxTotalBytes: 99000, maxTotalGrowthRatio: 0.05 },
        subEvals: { coreMemory: { minPrecisionAt3: 0.7 } },
        waivers: [],
      }),
    )
    write('packages/web-react/ui-static-baseline.json', JSON.stringify({ counts: { cardOverflow: 1 } }))
    write('packages/web-react/design-tokens-exempt.json', JSON.stringify({ exempt: ['src/Foo.tsx'] }))
    commit('bad: loosen UX baselines')
    const res = checkInProcess()
    assert.equal(res.ok, false)
    const rules = res.a0Blocks.map((b) => b.rule)
    assert.ok(rules.includes('A0-BUDGET-RAISED'))
    assert.ok(rules.includes('A0-THRESHOLD-LOOSENED'))
    assert.ok(res.a0Blocks.every((b) => b.riskCategory === 'ux_degradation'))
  })

  test('A0 hard-block (billing_change & ux_degradation): policy has ux_or_billing_only with exactly 3 categories (billing-accounting-core, ux-regression-guards, a0-meta-referee)', () => {
    const policy = JSON.parse(readFileSync(path.join(root, 'arch/a0-protected-paths.json'), 'utf8')) as {
      approvalPolicy?: string
      a0Categories: Array<{ id: string; riskCategory?: string; paths?: string[] }>
    }
    assert.equal(policy.approvalPolicy, 'ux_or_billing_only')
    assert.deepEqual(
      policy.a0Categories.map((c) => c.id),
      ['billing-accounting-core', 'ux-regression-guards', 'a0-meta-referee'],
    )

    // payment/** -> billing_change A0 block
    write('packages/commercial/src/payment/orders.ts', 'export const orderV = 2\n')
    commit('feat: edit payment orders')
    const rPay = checkInProcess()
    assert.equal(rPay.ok, false)
    assert.equal(rPay.a0Blocks[0]?.category, 'billing-accounting-core')
    assert.equal(rPay.a0Blocks[0]?.riskCategory, 'billing_change')

    // ux-regression-guards -> ux_degradation A0 block
    git('reset', '--hard', 'base')
    write('e2e/session-display/incident-ledger-baseline.json', '{"incidents":[]}\n')
    commit('feat: edit incident ledger')
    const rUx = checkInProcess()
    assert.equal(rUx.ok, false)
    assert.equal(rUx.a0Blocks[0]?.category, 'ux-regression-guards')
    assert.equal(rUx.a0Blocks[0]?.riskCategory, 'ux_degradation')
  })

  test('A0 hard-block: self-tampering check-a0-monotonic.ts or arch/a0-protected-paths.json fails', () => {
    // Attacker tries to empty a0Categories in arch/a0-protected-paths.json AND neuter check-a0-monotonic.ts
    write(
      'arch/a0-protected-paths.json',
      JSON.stringify({ schemaVersion: 1, a0Categories: [], a1MonotonicSurfaces: {} }),
    )
    write('scripts/check-a0-monotonic.ts', 'process.exit(0)\n')
    commit('bad: tamper A0 referee and policy')
    const res = checkInProcess()
    assert.equal(res.ok, false)
    const paths = res.a0Blocks.map((b) => b.path)
    assert.ok(paths.includes('arch/a0-protected-paths.json'))
    assert.ok(paths.includes('scripts/check-a0-monotonic.ts'))
  })

  test('A0 hard-block: invalid runtime-image-pin (:latest) fails', () => {
    write(
      'deploy/v5/runtime-image-pin.json',
      JSON.stringify({
        schemaVersion: 1,
        channel: 'v5-selfhost',
        runtimeImage: 'openclaude/openclaude-runtime:latest',
        cliVersions: { codex: '0.172.0' },
      }),
    )
    commit('bad: :latest pin')
    const res = checkInProcess()
    assert.equal(res.ok, false)
    assert.equal(res.a0Blocks[0]?.rule, 'A0-PIN-SCHEMA-INVALID')
  })

  // === A0 Approval Receipt Verification Tests ===

  test('valid signed A0 approval receipt authorizes exact headSha; tampered/expired/replayed/symlink/writable receipts fail', () => {
    write('packages/commercial/src/billing/ledger.ts', 'export const ledgerVersion = 2\n')
    const headSha = commit('feat: authorized billing core change')

    // 1. Without receipt -> blocked
    assert.equal(checkInProcess().ok, false)

    // 2. Valid receipt -> APPROVED
    const receiptPath = writeSignedReceipt(headSha)
    const rOk = checkInProcess()
    assert.equal(rOk.ok, true)
    assert.equal(rOk.approval?.valid, true)

    // 3. Tampered receipt (reason altered without recomputing sha256) -> rejected
    writeSignedReceipt(headSha, {
      reason: 'tampered reason after signing',
      sha256: computeA0ReceiptDigest({
        sha: headSha,
        issuedAt: new Date(Date.now() - 60_000).toISOString(),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        reason: 'original reason',
      }),
    })
    const rTamper = checkInProcess()
    assert.equal(rTamper.ok, false)
    assert.match(rTamper.approval && !rTamper.approval.valid ? rTamper.approval.reason : '', /digest verification failed/)

    // 4. Expired receipt -> rejected
    writeSignedReceipt(headSha, {
      issuedAt: '2026-01-01T00:00:00Z',
      expiresAt: '2026-01-02T00:00:00Z',
    })
    const rExpired = checkInProcess()
    assert.equal(rExpired.ok, false)
    assert.match(rExpired.approval && !rExpired.approval.valid ? rExpired.approval.reason : '', /expired/)

    // 5. World-writable receipt -> rejected
    writeSignedReceipt(headSha)
    chmodSync(receiptPath, 0o666)
    const rWritable = checkInProcess()
    assert.equal(rWritable.ok, false)
    assert.match(rWritable.approval && !rWritable.approval.valid ? rWritable.approval.reason : '', /writable/)
    rmSync(receiptPath)

    // 6. Symlink receipt -> rejected
    const outside = path.join(approvalDir, 'real.json')
    writeSignedReceipt(headSha, {}, 'real.json')
    symlinkSync(outside, receiptPath)
    const rSymlink = checkInProcess()
    assert.equal(rSymlink.ok, false)
    assert.match(rSymlink.approval && !rSymlink.approval.valid ? rSymlink.approval.reason : '', /symlink|regular file/)
    rmSync(receiptPath)
    rmSync(outside)

    // 7. Scoped allowedPaths: mismatch fails, exact match passes
    writeSignedReceipt(headSha, { allowedPaths: ['changelog.json'] })
    assert.equal(checkInProcess().ok, false)
    writeSignedReceipt(headSha, { allowedPaths: ['packages/commercial/src/billing/ledger.ts'] })
    assert.equal(checkInProcess().ok, true)

    // 8. Replay protection: subsequent commit cannot reuse previous commit's receipt
    write('packages/commercial/src/billing/ledger.ts', 'export const ledgerVersion = 3\n')
    commit('unapproved follow-up commit')
    assert.equal(checkInProcess().ok, false)
  })

  test('CLI end-to-end: --base, --staged, --json, and OC_A0_APPROVAL_DIR receipt exit codes', () => {
    // Staged A1 edit -> exit 0
    write('scripts/check-staged-new.ts', 'export const v = 1\n')
    git('add', 'scripts/check-staged-new.ts')
    assert.equal(cli(['--staged']).status, 0)

    // Staged A0 edit does NOT inherit HEAD receipt -> exit 1
    const headSha = git('rev-parse', 'HEAD')
    writeSignedReceipt(headSha)
    write('.github/CODEOWNERS', '* @nobody\n')
    git('add', '.github/CODEOWNERS')
    const rStagedBlock = cli(['--staged', '--json'])
    assert.equal(rStagedBlock.status, 1, rStagedBlock.out)
    assert.equal(JSON.parse(rStagedBlock.stdout).mode, 'staged')

    // Commit the A0 edit -> blocked without receipt for new SHA, approved with receipt for new SHA
    const newSha = commit('a0 codeowners change')
    assert.equal(cli(['--base', 'base']).status, 1)
    writeSignedReceipt(newSha)
    const rApproved = cli(['--base', 'base', '--json'])
    assert.equal(rApproved.status, 0, rApproved.out)
    assert.equal(JSON.parse(rApproved.stdout).approval.valid, true)
  })

  test('initial policy rollout requires out-of-commit approval AND enforces non-weakening bootstrap self-check (B2)', () => {
    // Create a clean base commit WITHOUT arch/a0-protected-paths.json
    const bootRepo = mkdtempSync(path.join(tmpdir(), 'a0-bootstrap-repo-'))
    try {
      const bWrite = (rel: string, content: string) => {
        const abs = path.join(bootRepo, rel)
        mkdirSync(path.dirname(abs), { recursive: true })
        writeFileSync(abs, content)
      }
      const bGit = (...args: string[]) => {
        const r = spawnSync('git', ['-C', bootRepo, ...args], { encoding: 'utf8' })
        assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`)
        return r.stdout.trim()
      }
      bWrite('scripts/check-existing.ts', 'export const x = 1\n')
      bWrite('.github/CODEOWNERS', '* @dream-star-end\n')
      bGit('init', '-q', '-b', 'main')
      bGit('config', 'user.email', 't@t')
      bGit('config', 'user.name', 't')
      bGit('add', '-A')
      bGit('commit', '-qm', 'pre-a0-base')
      bGit('tag', 'pre-a0')

      // 1. Initial rollout WITHOUT approval MUST FAIL CLOSED (no unapproved bootstrap escape hatch!)
      for (const rel of ['arch/a0-protected-paths.json', 'scripts/check-a0-monotonic.ts', '.github/CODEOWNERS']) {
        const dst = path.join(bootRepo, rel)
        mkdirSync(path.dirname(dst), { recursive: true })
        copyFileSync(path.join(root, rel), dst)
      }
      bWrite('scripts/check-existing.ts', 'export const x = 2\n')
      bGit('add', '-A')
      bGit('commit', '-qm', 'bootstrap a0')
      const bootSha = bGit('rev-parse', 'HEAD')
      const rBootNoApproval = runCheckA0Monotonic({
        root: bootRepo,
        base: 'pre-a0',
        approvalDir,
        requireRootOwner: false,
      })
      assert.equal(rBootNoApproval.ok, false)
      assert.equal(rBootNoApproval.bootstrap, true)

      // 2. Initial rollout WITH valid approval for exact bootSha -> PASS!
      writeSignedReceipt(bootSha)
      const rBootApproved = runCheckA0Monotonic({
        root: bootRepo,
        base: 'pre-a0',
        approvalDir,
        requireRootOwner: false,
      })
      assert.equal(rBootApproved.ok, true)
      assert.equal(rBootApproved.bootstrap, true)
      assert.equal(rBootApproved.approval?.valid, true)
      bGit('tag', 'post-a0')

      // 3. Subsequent commit touching A0 path (now that base has policy) -> 100% HARD-BLOCKED!
      bWrite('.github/CODEOWNERS', '* @nobody\n')
      bGit('add', '-A')
      bGit('commit', '-qm', 'post-bootstrap tamper')
      const rAfter = runCheckA0Monotonic({ root: bootRepo, base: 'post-a0', approvalDir, requireRootOwner: false })
      assert.equal(rAfter.ok, false)
      assert.notEqual(rAfter.bootstrap, true)

      // 4. Disallowed weakening during bootstrap (raising UX budget) -> FAILS CLOSED even with receipt!
      bGit('reset', '--hard', 'pre-a0')
      bWrite('packages/web-react/budgets.json', JSON.stringify({ firstScreenGzipBytes: 480000 }))
      bGit('add', '-A')
      bGit('commit', '-qm', 'seed budgets before bootstrap')
      bGit('tag', 'pre-a0-budget')
      mkdirSync(path.join(bootRepo, 'arch'), { recursive: true })
      copyFileSync(path.join(root, 'arch/a0-protected-paths.json'), path.join(bootRepo, 'arch/a0-protected-paths.json'))
      bWrite('packages/web-react/budgets.json', JSON.stringify({ firstScreenGzipBytes: 999999 }))
      bGit('add', '-A')
      bGit('commit', '-qm', 'bootstrap raise UX budget')
      const weakSha = bGit('rev-parse', 'HEAD')
      writeSignedReceipt(weakSha)
      const rWeak = runCheckA0Monotonic({ root: bootRepo, base: 'pre-a0-budget', approvalDir, requireRootOwner: false })
      assert.equal(rWeak.ok, false)
      assert.ok((rWeak.bootstrapErrors ?? []).some((e) => e.includes('A0-BUDGET-RAISED')))
    } finally {
      rmSync(bootRepo, { recursive: true, force: true })
    }
  })

  test('A0 rename regression: renaming runtime-image-pin.json or UX budgets is A0; renaming internal arch/modules.json auto-passes as A1', () => {
    // Rename A1 declarative runtime pin -> MUST trigger A0-PIN-DELETED on oldPath!
    git('mv', 'deploy/v5/runtime-image-pin.json', 'deploy/v5/runtime-image-pin-moved.json')
    commit('bad: rename runtime image pin')
    const rPinRename = checkInProcess()
    assert.equal(rPinRename.ok, false)
    assert.ok(
      rPinRename.a0Blocks.some((b) => b.rule === 'A0-PIN-DELETED' && b.path === 'deploy/v5/runtime-image-pin.json' && b.riskCategory === 'ux_degradation'),
      `expected A0-PIN-DELETED for renamed pin, got ${JSON.stringify(rPinRename.a0Blocks)}`,
    )

    // Rename UX budgets.json -> MUST trigger A0-BASELINE-DELETED (ux_degradation)!
    git('reset', '--hard', 'base')
    git('mv', 'packages/web-react/budgets.json', 'packages/web-react/budgets-renamed.json')
    commit('bad: rename UX budgets.json')
    const rBudgetRename = checkInProcess()
    assert.equal(rBudgetRename.ok, false)
    assert.ok(rBudgetRename.a0Blocks.some((b) => b.rule === 'A0-BASELINE-DELETED' && b.riskCategory === 'ux_degradation'))

    // Rename internal arch/modules.json -> auto-passes as A1 under ux_or_billing_only!
    git('reset', '--hard', 'base')
    git('mv', 'arch/modules.json', 'arch/modules-renamed.json')
    commit('chore: rename internal modules.json')
    const rModRename = checkInProcess()
    assert.equal(rModRename.ok, true)
    assert.equal(rModRename.a0Blocks.length, 0)
  })

  test('ux_or_billing_only: non-meta deploy scripts auto-pass while full meta-referee chain (BLOCKER 3), contextEval threshold direction (BLOCKER 4), and billing/payment test/allowlist/zero-runtime-TS alignment (BLOCKER 6) are enforced', () => {
    // 1. Non-meta deploy/train scripts auto-pass without manual A0 approval
    for (const rel of [
      'scripts/deploy-v5-selfhost.sh',
      'scripts/lib/v5-selfhost-prepare.sh',
      'scripts/v5-lease-worker.sh',
      'scripts/lib/v5-lease-train-debounce.sh',
      'scripts/lib/v5-selfhost-release-policy.sh',
    ]) {
      git('reset', '--hard', 'base')
      write(rel, '#!/usr/bin/env bash\necho updated\n')
      commit(`chore: update ${rel}`)
      const res = checkInProcess()
      assert.equal(res.ok, true, `expected auto-pass for non-meta deploy script ${rel}: ${JSON.stringify(res.a0Blocks)}`)
      assert.equal(res.a0Blocks.length, 0)
    }

    // 2. BLOCKER 3: Full meta-referee & forward-guard chain MUST hard-block A0 on solo edits
    for (const rel of [
      'scripts/lib/a0MonotonicRules.ts',
      'scripts/harness-gate/oc-governor.sh',
      'scripts/harness-gate/sync-referee.sh',
      'scripts/lib/v5-selfhost-governance-gates.sh',
      'scripts/lib/v5-selfhost-train-guards.sh',
    ]) {
      git('reset', '--hard', 'base')
      write(rel, '// tampered referee\n')
      commit(`bad: tamper meta-referee ${rel}`)
      const res = checkInProcess()
      assert.equal(res.ok, false, `BLOCKER 3: modifying ${rel} MUST hard-block A0`)
      assert.ok(res.a0Blocks.some((b) => b.path === rel && b.category === 'a0-meta-referee'))
    }

    // 3. BLOCKER 4: contextEval thresholds.minSlotGrowthBytes bidirectional check (256->128 A1 pass, 256->512 A0 block; subEvals.coreMemory.minPrecisionAt3 1->0.9 A0 block)
    git('reset', '--hard', 'base')
    write(
      '.github/context-eval-baseline.json',
      JSON.stringify({
        schemaVersion: 1,
        thresholds: { maxTotalBytes: 44000, maxTotalGrowthRatio: 0.05, maxSlotGrowthRatio: 0.15, minSlotGrowthBytes: 128 },
        subEvals: { coreMemory: { minPrecisionAt3: 1, maxAvgHitsRatio: 0.4 } },
        waivers: [],
      }),
    )
    commit('refactor: tighten minSlotGrowthBytes 256 -> 128')
    const rTighten = checkInProcess()
    assert.equal(rTighten.ok, true, `256->128 MUST tighten and auto-pass A1: ${JSON.stringify(rTighten.a0Blocks)}`)

    git('reset', '--hard', 'base')
    write(
      '.github/context-eval-baseline.json',
      JSON.stringify({
        schemaVersion: 1,
        thresholds: { maxTotalBytes: 44000, maxTotalGrowthRatio: 0.05, maxSlotGrowthRatio: 0.15, minSlotGrowthBytes: 512 },
        subEvals: { coreMemory: { minPrecisionAt3: 1, maxAvgHitsRatio: 0.4 } },
        waivers: [],
      }),
    )
    commit('bad: loosen minSlotGrowthBytes 256 -> 512')
    const rLoosen = checkInProcess()
    assert.equal(rLoosen.ok, false, '256->512 MUST be blocked as A0-THRESHOLD-LOOSENED')
    assert.ok(
      rLoosen.a0Blocks.some((b) => b.rule === 'A0-THRESHOLD-LOOSENED' && b.riskCategory === 'ux_degradation' && b.detail.includes('minSlotGrowthBytes')),
      `expected minSlotGrowthBytes loosened block, got ${JSON.stringify(rLoosen.a0Blocks)}`,
    )

    git('reset', '--hard', 'base')
    write(
      '.github/context-eval-baseline.json',
      JSON.stringify({
        schemaVersion: 1,
        thresholds: { maxTotalBytes: 44000, maxTotalGrowthRatio: 0.05, maxSlotGrowthRatio: 0.15, minSlotGrowthBytes: 256 },
        subEvals: { coreMemory: { minPrecisionAt3: 0.9, maxAvgHitsRatio: 0.4 } },
        waivers: [],
      }),
    )
    commit('bad: loosen minPrecisionAt3 1 -> 0.9')
    const rPrec = checkInProcess()
    assert.equal(rPrec.ok, false, 'minPrecisionAt3 1->0.9 MUST be blocked as A0-THRESHOLD-LOOSENED')
    assert.ok(rPrec.a0Blocks.some((b) => b.rule === 'A0-THRESHOLD-LOOSENED' && b.riskCategory === 'ux_degradation'))

    // 4. BLOCKER 6 + R2 #1/#6: CI check-a0-monotonic aligns with oc-governor on billing/payment pure tests, allowlisted pure helpers, and zero-runtime-diff TS edits (M/A/D)
    git('reset', '--hard', 'base')
    write('packages/commercial/src/billing/ledger.ts', '// pure comment\nexport type LedgerHint = { v: number }\nexport const ledgerVersion = 1\n')
    write('packages/commercial/src/billing/pureTypesNew.ts', 'export interface BillingHintOnly { readonly ok: boolean }\n')
    write('packages/commercial/src/payment/orders.test.ts', 'export const testOk = true\n')
    write('packages/commercial/src/billing/usageReport.ts', 'export const reportFormat = 2\n')
    commit('chore: billing pure comment/type, pure-type new file, payment test, and allowlisted pure helper')
    const rBillingExempt = checkInProcess()
    assert.equal(rBillingExempt.ok, true, `expected A1 auto-pass for aligned billing exemptions: ${JSON.stringify(rBillingExempt.a0Blocks)}`)
    assert.ok(rBillingExempt.a1Passes.some((p) => p.rule === 'A1-BILLING-NO-RUNTIME-DIFF' && p.path === 'packages/commercial/src/billing/ledger.ts'))
    assert.ok(rBillingExempt.a1Passes.some((p) => p.rule === 'A1-BILLING-NO-RUNTIME-DIFF' && p.path === 'packages/commercial/src/billing/pureTypesNew.ts'))
    assert.ok(rBillingExempt.a1Passes.some((p) => p.rule === 'A1-BILLING-TEST-ONLY' && p.path === 'packages/commercial/src/payment/orders.test.ts'))
    assert.ok(rBillingExempt.a1Passes.some((p) => p.rule === 'A1-BILLING-NONCORE-HELPER' && p.path === 'packages/commercial/src/billing/usageReport.ts'))

    for (const prodBillingPath of [
      'packages/commercial/src/billing/ledger.ts',
      'packages/commercial/src/billing/remoteDriverTurnBilling.ts',
      'packages/commercial/src/billing/remoteDriverReceiptV5.ts',
      'packages/commercial/src/billing/codexServiceTierPricing.ts',
      'packages/protocol/src/serviceTiers.ts',
      'packages/commercial/src/payment/stripe.ts',
    ]) {
      git('reset', '--hard', 'base')
      write(prodBillingPath, 'export const runtimeBehaviorChanged = 999\n')
      commit(`feat: runtime billing change in ${prodBillingPath}`)
      const rProd = checkInProcess()
      assert.equal(rProd.ok, false, `runtime edit in ${prodBillingPath} MUST A0-block`)
      assert.ok(
        rProd.a0Blocks.some((b) => b.path === prodBillingPath && b.category === 'billing-accounting-core' && b.riskCategory === 'billing_change'),
        `expected billing_change A0 block for ${prodBillingPath}, got ${JSON.stringify(rProd.a0Blocks)}`,
      )
    }
  })

  test('B3 HMAC enforcement & allowedPaths tamper protection & default root-owner enforcement', () => {
    write('packages/commercial/src/billing/ledger.ts', 'export const ledgerVersion = 99\n')
    const headSha = commit('feat: billing core change for hmac test')

    // 1. Tampering allowedPaths after signing MUST fail digest verification
    const issuedAt = new Date(Date.now() - 60_000).toISOString()
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString()
    const reason = 'Authorized single-file A0 update'
    const digestForOtherPath = computeA0ReceiptDigest({
      sha: headSha,
      issuedAt,
      expiresAt,
      reason,
      allowedPaths: ['changelog.json'],
    })
    writeSignedReceipt(headSha, {
      issuedAt,
      expiresAt,
      reason,
      allowedPaths: ['packages/commercial/src/billing/ledger.ts'],
      sha256: digestForOtherPath,
    })
    const rPathTamper = checkInProcess()
    assert.equal(rPathTamper.ok, false)
    assert.match(rPathTamper.approval && !rPathTamper.approval.valid ? rPathTamper.approval.reason : '', /digest verification failed/)

    // 2. Active 0600 .hmac-key enforces hmacSha256 and rejects plain sha256 downgrade
    const hmacDir = mkdtempSync(path.join(tmpdir(), 'a0-hmac-root-'))
    try {
      const approvalsSub = path.join(hmacDir, 'a0-approvals')
      mkdirSync(approvalsSub, { recursive: true })
      const keyFile = path.join(hmacDir, '.hmac-key')
      const secretKey = 'super-secret-host-a0-hmac-key-0123456789'
      writeFileSync(keyFile, `${secretKey}\n`, { mode: 0o600 })
      chmodSync(keyFile, 0o600)

      // Plain sha256 only -> REJECTED!
      const plainDoc = {
        schemaVersion: 1,
        sha: headSha,
        reason,
        approvedBy: 'root',
        issuedAt,
        expiresAt,
        sha256: computeA0ReceiptDigest({ sha: headSha, issuedAt, expiresAt, reason }),
      }
      writeFileSync(path.join(approvalsSub, `${headSha}.json`), JSON.stringify(plainDoc, null, 2))
      const rDowngrade = runCheckA0Monotonic({
        root: repo,
        base: 'base',
        approvalDir: approvalsSub,
        requireRootOwner: false,
      })
      assert.equal(rDowngrade.ok, false)
      assert.match(rDowngrade.approval && !rDowngrade.approval.valid ? rDowngrade.approval.reason : '', /downgrade rejected/)

      // Valid HMAC receipt -> PASS!
      const hmacDoc = {
        ...plainDoc,
        hmacSha256: computeA0ReceiptHmac({ sha: headSha, issuedAt, expiresAt, reason }, secretKey),
      }
      writeFileSync(path.join(approvalsSub, `${headSha}.json`), JSON.stringify(hmacDoc, null, 2))
      const rHmacOk = runCheckA0Monotonic({
        root: repo,
        base: 'base',
        approvalDir: approvalsSub,
        requireRootOwner: false,
      })
      assert.equal(rHmacOk.ok, true)

      // Insecure 0644 .hmac-key -> REJECTED!
      chmodSync(keyFile, 0o644)
      const rBadKeyPerm = runCheckA0Monotonic({
        root: repo,
        base: 'base',
        approvalDir: approvalsSub,
        requireRootOwner: false,
      })
      assert.equal(rBadKeyPerm.ok, false)
      assert.match(rBadKeyPerm.approval && !rBadKeyPerm.approval.valid ? rBadKeyPerm.approval.reason : '', /0600\/0400/)

      // Overriding --approval-dir WITHOUT --unsafe-test-skip-owner still enforces uid===0 when non-root
      chmodSync(keyFile, 0o600)
      if (typeof process.getuid === 'function' && process.getuid() !== 0) {
        const rNoSkipOwner = cli(['--base', 'base', '--approval-dir', approvalsSub], {}, { skipOwner: false })
        assert.equal(rNoSkipOwner.status, 1)
        assert.match(rNoSkipOwner.out, /owned by root/)
      }
    } finally {
      rmSync(hmacDir, { recursive: true, force: true })
    }
  })

  test('B2 out-of-commit GitHub A0 approval: Commit Status oc-v5/a0-approval & PR CODEOWNER APPROVED review (positive + negative + CLI HTTP server)', async () => {
    write('packages/commercial/src/billing/ledger.ts', 'export const ledgerVersion = 77\n')
    const headSha = commit('feat: A0 change authorized out-of-commit via GitHub')
    const shortSha = headSha.slice(0, 12)
    const futureExp = new Date(Date.now() + 3_600_000).toISOString()
    const pastExp = '2026-01-01T00:00:00Z'

    const makeMockFetch = (routes: Record<string, unknown>): FetchLike => async (url) => {
      const pathOnly = new URL(url).pathname
      const data = routes[pathOnly]
      if (data === undefined) {
        return { ok: false, status: 404, json: async () => ({ message: 'not found' }) }
      }
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => data }
    }

    // 1. Valid Commit Status oc-v5/a0-approval by dream-star-end -> PASS
    const rStatusOk = await runCheckA0MonotonicAsync({
      root: repo,
      base: 'base',
      head: headSha,
      approvalDir,
      requireRootOwner: false,
      github: {
        repo: 'dream-star-end/openclaude',
        token: 'ghs_test_token',
        fetchImpl: makeMockFetch({
          [`/repos/dream-star-end/openclaude/commits/${headSha}/statuses`]: [
            {
              id: 20,
              context: 'oc-v5/a0-approval',
              state: 'success',
              description: `sha=${shortSha} exp=${futureExp} paths=* | Approved billing ledger migration`,
              creator: { login: 'dream-star-end' },
              created_at: '2026-11-26T12:00:00Z',
            },
          ],
          [`/repos/dream-star-end/openclaude/commits/${headSha}/pulls`]: [],
        }),
      },
    })
    assert.equal(rStatusOk.ok, true)
    assert.equal(rStatusOk.approval?.valid, true)
    assert.equal(rStatusOk.approval?.valid ? rStatusOk.approval.source : '', 'github-status')

    // 1b. B2: Missing explicit paths= scope token MUST FAIL-CLOSED (never treated as unrestricted!)
    const rMissingPaths = await runCheckA0MonotonicAsync({
      root: repo,
      base: 'base',
      head: headSha,
      approvalDir,
      requireRootOwner: false,
      github: {
        repo: 'dream-star-end/openclaude',
        token: 'ghs_test_token',
        fetchImpl: makeMockFetch({
          [`/repos/dream-star-end/openclaude/commits/${headSha}/statuses`]: [
            {
              id: 201,
              context: 'oc-v5/a0-approval',
              state: 'success',
              description: `sha=${shortSha} exp=${futureExp} | Omitted paths scope must be rejected`,
              creator: { login: 'dream-star-end' },
              created_at: '2026-11-26T12:00:00Z',
            },
          ],
          [`/repos/dream-star-end/openclaude/commits/${headSha}/pulls`]: [],
        }),
      },
    })
    assert.equal(rMissingPaths.ok, false, 'oc-v5/a0-approval missing explicit paths= MUST fail closed')

    // 1c. B2: Narrow paths= scope not covering A0 diff MUST FAIL-CLOSED
    const rNarrowPaths = await runCheckA0MonotonicAsync({
      root: repo,
      base: 'base',
      head: headSha,
      approvalDir,
      requireRootOwner: false,
      github: {
        repo: 'dream-star-end/openclaude',
        token: 'ghs_test_token',
        fetchImpl: makeMockFetch({
          [`/repos/dream-star-end/openclaude/commits/${headSha}/statuses`]: [
            {
              id: 202,
              context: 'oc-v5/a0-approval',
              state: 'success',
              description: `sha=${shortSha} exp=${futureExp} paths=changelog.json | Narrow scope approval`,
              creator: { login: 'dream-star-end' },
              created_at: '2026-11-26T12:00:00Z',
            },
          ],
          [`/repos/dream-star-end/openclaude/commits/${headSha}/pulls`]: [],
        }),
      },
    })
    assert.equal(rNarrowPaths.ok, false, 'narrow paths= scope not covering changed A0 file MUST fail closed')

    // 2. Untrusted publisher -> REJECT
    const rUntrusted = await runCheckA0MonotonicAsync({
      root: repo,
      base: 'base',
      head: headSha,
      approvalDir,
      requireRootOwner: false,
      github: {
        repo: 'dream-star-end/openclaude',
        token: 'ghs_test_token',
        fetchImpl: makeMockFetch({
          [`/repos/dream-star-end/openclaude/commits/${headSha}/statuses`]: [
            {
              id: 21,
              context: 'oc-v5/a0-approval',
              state: 'success',
              description: `sha=${shortSha} exp=${futureExp} | Forged by random user`,
              creator: { login: 'random-attacker' },
              created_at: '2026-11-26T12:00:00Z',
            },
          ],
          [`/repos/dream-star-end/openclaude/commits/${headSha}/pulls`]: [],
        }),
      },
    })
    assert.equal(rUntrusted.ok, false)

    // 3. Expired status or latest failure superseding earlier success -> REJECT
    const rExpiredStatus = await runCheckA0MonotonicAsync({
      root: repo,
      base: 'base',
      head: headSha,
      approvalDir,
      requireRootOwner: false,
      github: {
        repo: 'dream-star-end/openclaude',
        token: 'ghs_test_token',
        fetchImpl: makeMockFetch({
          [`/repos/dream-star-end/openclaude/commits/${headSha}/statuses`]: [
            {
              id: 22,
              context: 'oc-v5/a0-approval',
              state: 'success',
              description: `sha=${shortSha} exp=${pastExp} | Expired A0 approval`,
              creator: { login: 'dream-star-end' },
              created_at: '2026-01-01T00:00:00Z',
            },
          ],
          [`/repos/dream-star-end/openclaude/commits/${headSha}/pulls`]: [],
        }),
      },
    })
    assert.equal(rExpiredStatus.ok, false)

    const rRevokedStatus = await runCheckA0MonotonicAsync({
      root: repo,
      base: 'base',
      head: headSha,
      approvalDir,
      requireRootOwner: false,
      github: {
        repo: 'dream-star-end/openclaude',
        token: 'ghs_test_token',
        prNumber: 1450,
        fetchImpl: makeMockFetch({
          [`/repos/dream-star-end/openclaude/commits/${headSha}/statuses`]: [
            {
              id: 30,
              context: 'oc-v5/a0-approval',
              state: 'failure',
              description: `revoked sha=${shortSha} paths=* | Revoked approval`,
              creator: { login: 'dream-star-end' },
              created_at: '2026-11-26T13:00:00Z',
            },
            {
              id: 29,
              context: 'oc-v5/a0-approval',
              state: 'success',
              description: `sha=${shortSha} exp=${futureExp} paths=* | Earlier approval`,
              creator: { login: 'dream-star-end' },
              created_at: '2026-11-26T12:00:00Z',
            },
          ],
          // Even with a PR CODEOWNER APPROVED review, explicit revocation status MUST take precedence!
          '/repos/dream-star-end/openclaude/pulls/1450/reviews': [
            {
              id: 99,
              state: 'APPROVED',
              commit_id: headSha,
              submitted_at: '2026-11-26T12:30:00Z',
              user: { login: 'dream-star-end' },
            },
          ],
        }),
      },
    })
    assert.equal(rRevokedStatus.ok, false, 'revoked oc-v5/a0-approval status MUST override both success status and PR review')

    // 4. PR CODEOWNER APPROVED review bound to exact headSha -> PASS; stale commit_id or CHANGES_REQUESTED -> REJECT
    const rPrOk = await runCheckA0MonotonicAsync({
      root: repo,
      base: 'base',
      head: headSha,
      approvalDir,
      requireRootOwner: false,
      github: {
        repo: 'dream-star-end/openclaude',
        token: 'ghs_test_token',
        prNumber: 1450,
        fetchImpl: makeMockFetch({
          [`/repos/dream-star-end/openclaude/commits/${headSha}/statuses`]: [],
          '/repos/dream-star-end/openclaude/pulls/1450/reviews': [
            {
              id: 1,
              state: 'APPROVED',
              commit_id: headSha,
              submitted_at: '2026-11-26T12:30:00Z',
              user: { login: 'dream-star-end' },
            },
            {
              id: 2,
              state: 'COMMENTED',
              commit_id: headSha,
              submitted_at: '2026-11-26T12:31:00Z',
              user: { login: 'dream-star-end' },
            },
          ],
        }),
      },
    })
    assert.equal(rPrOk.ok, true)
    assert.equal(rPrOk.approval?.valid ? rPrOk.approval.source : '', 'github-pr-review')

    const rPrStale = await runCheckA0MonotonicAsync({
      root: repo,
      base: 'base',
      head: headSha,
      approvalDir,
      requireRootOwner: false,
      github: {
        repo: 'dream-star-end/openclaude',
        token: 'ghs_test_token',
        prNumber: 1450,
        fetchImpl: makeMockFetch({
          [`/repos/dream-star-end/openclaude/commits/${headSha}/statuses`]: [],
          '/repos/dream-star-end/openclaude/pulls/1450/reviews': [
            {
              id: 1,
              state: 'APPROVED',
              commit_id: '0'.repeat(40),
              submitted_at: '2026-11-26T12:30:00Z',
              user: { login: 'dream-star-end' },
            },
          ],
        }),
      },
    })
    assert.equal(rPrStale.ok, false)

    // 5. Real CLI subprocess against local mock GitHub HTTP API (clean hosted runner with no host files!)
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Connection', 'close')
      if (req.url?.startsWith(`/repos/dream-star-end/openclaude/commits/${headSha}/statuses`)) {
        res.end(
          JSON.stringify([
            {
              id: 100,
              context: 'oc-v5/a0-approval',
              state: 'success',
              description: `sha=${shortSha} exp=${futureExp} paths=* | Approved via hosted runner status`,
              creator: { login: 'dream-star-end' },
              created_at: '2026-11-26T12:00:00Z',
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
      const rCliGh = await cliAsync(
        [
          '--base',
          'base',
          '--head',
          headSha,
          '--github-repo',
          'dream-star-end/openclaude',
          '--github-api-url',
          `http://127.0.0.1:${addr.port}`,
          '--json',
        ],
        { GITHUB_TOKEN: 'ghs_mock_token' },
      )
      assert.equal(rCliGh.status, 0, rCliGh.out)
      const parsed = JSON.parse(rCliGh.stdout)
      assert.equal(parsed.ok, true)
      assert.equal(parsed.approval.source, 'github-status')
    } finally {
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
