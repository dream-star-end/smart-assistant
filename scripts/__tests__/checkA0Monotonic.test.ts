import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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
          thresholds: { maxTotalBytes: 44000, maxTotalGrowthRatio: 0.05 },
          subEvals: { coreMemory: { minPrecisionAt3: 0.9 } },
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
          thresholds: { maxTotalBytes: 40000, maxTotalGrowthRatio: 0.04 },
          subEvals: { coreMemory: { minPrecisionAt3: 0.95 } },
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

  // === A0 Negative Cases (Hard Block) ===

  test('A0 hard-block: deleting or modifying an existing gate script fails', () => {
    rmSync(path.join(repo, 'scripts/check-existing-gate.ts'))
    commit('bad: delete gate')
    const rDel = checkInProcess()
    assert.equal(rDel.ok, false)
    assert.equal(rDel.a0Blocks[0]?.rule, 'A0-GATE-DELETED')

    git('reset', '--hard', 'base')
    write('scripts/check-existing-gate.ts', 'export const ok = false\n')
    commit('bad: weaken gate')
    const rMod = checkInProcess()
    assert.equal(rMod.ok, false)
    assert.equal(rMod.a0Blocks[0]?.rule, 'A0-GATE-MODIFIED')
  })

  test('A0 hard-block: adding allow edge or authority in arch/modules.json fails', () => {
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
    commit('bad: add allow edge + authority')
    const res = checkInProcess()
    assert.equal(res.ok, false)
    const rules = res.a0Blocks.map((b) => b.rule)
    assert.ok(rules.includes('A0-MODULES-ALLOW-ADDED'))
    assert.ok(rules.includes('A0-MODULES-AUTHORITY-ADDED'))
  })

  test('A0 hard-block: adding or renewing file-size-ratchet-exceptions.json fails', () => {
    write(
      '.github/file-size-ratchet-exceptions.json',
      JSON.stringify(
        [
          {
            path: 'src/monolith.ts',
            maxLines: 3600,
            ticket: 'OCV5-100',
            reason: 'renewing exception',
            expires: '2026-12-25',
          },
        ],
        null,
        2,
      ),
    )
    commit('bad: renew exception')
    const rRenew = checkInProcess()
    assert.equal(rRenew.ok, false)
    assert.equal(rRenew.a0Blocks[0]?.rule, 'A0-EXCEPTION-RENEWED')

    git('reset', '--hard', 'base')
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
          {
            path: 'src/newGiant.ts',
            maxLines: 950,
            ticket: 'OCV5-999',
            reason: 'trying to add exception',
            expires: '2026-12-10',
          },
        ],
        null,
        2,
      ),
    )
    commit('bad: add exception')
    const rAdd = checkInProcess()
    assert.equal(rAdd.ok, false)
    assert.equal(rAdd.a0Blocks[0]?.rule, 'A0-EXCEPTION-ADDED')
  })

  test('A0 hard-block: raising budgets, slack, ai-smells baseline, or flag TTL fails', () => {
    write('packages/web-react/budgets.json', JSON.stringify({ firstScreenGzipBytes: 500000, cssTotalRawBytes: 380000 }))
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
    write(
      'deploy/v5/feature-flags-registry.json',
      JSON.stringify({ schema: 1, flags: [{ name: 'OC_TEMP', permanent: false, expireAt: '2027-01-15' }] }),
    )
    write(
      '.github/file-size-baseline.json',
      JSON.stringify({
        limit: 3000,
        slack: 50,
        files: { 'src/monolith.ts': 3500 },
        yellowZoneLimit: 2000,
        yellowZoneSlack: 0,
        yellowZoneFiles: {},
        orangeZoneLimit: 800,
        orangeZoneSlack: 0,
        orangeZoneFiles: { 'src/mid.ts': 1000 },
      }),
    )
    commit('bad: loosen everything')
    const res = checkInProcess()
    assert.equal(res.ok, false)
    const rules = res.a0Blocks.map((b) => b.rule)
    assert.ok(rules.includes('A0-BUDGET-RAISED'))
    assert.ok(rules.includes('A0-BASELINE-RAISED'))
    assert.ok(rules.includes('A0-FLAG-TTL-EXTENDED'))
    assert.ok(rules.includes('A0-FILESIZE-SLACK-NONZERO'))
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

      // 4. Disallowed weakening during bootstrap (deleting existing gate) -> FAILS CLOSED even with receipt!
      bGit('reset', '--hard', 'pre-a0')
      mkdirSync(path.join(bootRepo, 'arch'), { recursive: true })
      copyFileSync(path.join(root, 'arch/a0-protected-paths.json'), path.join(bootRepo, 'arch/a0-protected-paths.json'))
      rmSync(path.join(bootRepo, 'scripts/check-existing.ts'))
      bGit('add', '-A')
      bGit('commit', '-qm', 'bootstrap delete gate')
      const weakSha = bGit('rev-parse', 'HEAD')
      writeSignedReceipt(weakSha)
      const rWeak = runCheckA0Monotonic({ root: bootRepo, base: 'pre-a0', approvalDir, requireRootOwner: false })
      assert.equal(rWeak.ok, false)
      assert.ok((rWeak.bootstrapErrors ?? []).some((e) => e.includes('A0-GATE-DELETED')))
    } finally {
      rmSync(bootRepo, { recursive: true, force: true })
    }
  })

  test('A0 rename regression: renaming deploy/v5/runtime-image-pin.json or baselines is hard-blocked as A0', () => {
    // Rename A1 declarative runtime pin -> MUST trigger A0-PIN-DELETED on oldPath!
    git('mv', 'deploy/v5/runtime-image-pin.json', 'deploy/v5/runtime-image-pin-moved.json')
    commit('bad: rename runtime image pin')
    const rPinRename = checkInProcess()
    assert.equal(rPinRename.ok, false)
    assert.ok(
      rPinRename.a0Blocks.some((b) => b.rule === 'A0-PIN-DELETED' && b.path === 'deploy/v5/runtime-image-pin.json'),
      `expected A0-PIN-DELETED for renamed pin, got ${JSON.stringify(rPinRename.a0Blocks)}`,
    )

    // Rename arch/modules.json -> MUST trigger A0-MODULES-DELETED!
    git('reset', '--hard', 'base')
    git('mv', 'arch/modules.json', 'arch/modules-renamed.json')
    commit('bad: rename modules.json')
    const rModRename = checkInProcess()
    assert.equal(rModRename.ok, false)
    assert.ok(rModRename.a0Blocks.some((b) => b.rule === 'A0-MODULES-DELETED'))
  })

  test('B7 A0 protection list covers lease worker, debounce, train guards, governance gates, and release policy', () => {
    for (const rel of [
      'scripts/v5-lease-worker.sh',
      'scripts/lib/v5-lease-train-debounce.sh',
      'scripts/lib/v5-selfhost-train-guards.sh',
      'scripts/lib/v5-selfhost-governance-gates.sh',
      'scripts/lib/v5-selfhost-release-policy.sh',
    ]) {
      git('reset', '--hard', 'base')
      write(rel, '#!/usr/bin/env bash\necho tampered\n')
      commit(`bad: modify ${rel}`)
      const res = checkInProcess()
      assert.equal(res.ok, false, `expected A0 block for ${rel}`)
      assert.ok(
        res.a0Blocks.some((b) => b.path === rel && b.category === 'host-control-plane-and-deploy'),
        `expected host-control-plane-and-deploy block for ${rel}, got ${JSON.stringify(res.a0Blocks)}`,
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
              description: `sha=${shortSha} exp=${futureExp} | Approved billing ledger migration`,
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
        fetchImpl: makeMockFetch({
          [`/repos/dream-star-end/openclaude/commits/${headSha}/statuses`]: [
            {
              id: 30,
              context: 'oc-v5/a0-approval',
              state: 'failure',
              description: `sha=${shortSha} | Revoked approval`,
              creator: { login: 'dream-star-end' },
              created_at: '2026-11-26T13:00:00Z',
            },
            {
              id: 29,
              context: 'oc-v5/a0-approval',
              state: 'success',
              description: `sha=${shortSha} exp=${futureExp} | Earlier approval`,
              creator: { login: 'dream-star-end' },
              created_at: '2026-11-26T12:00:00Z',
            },
          ],
          [`/repos/dream-star-end/openclaude/commits/${headSha}/pulls`]: [],
        }),
      },
    })
    assert.equal(rRevokedStatus.ok, false)

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
              description: `sha=${shortSha} exp=${futureExp} | Approved via hosted runner status`,
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
