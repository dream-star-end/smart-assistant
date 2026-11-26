import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
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
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runCheckA0Monotonic } from '../check-a0-monotonic.js'
import { computeA0ReceiptDigest } from '../lib/a0ApprovalReceipt.js'

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

  const cli = (args: string[], extraEnv: Record<string, string> = {}) => {
    const r = spawnSync(tsx, [refereeScript, '--root', repo, ...args], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, OC_A0_APPROVAL_DIR: approvalDir, ...extraEnv },
    })
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, out: `${r.stdout}${r.stderr}` }
  }

  const writeSignedReceipt = (
    sha: string,
    overrides: Partial<{
      sha: string
      reason: string
      issuedAt: string
      expiresAt: string
      sha256: string
      allowedPaths: string[]
    }> = {},
    fileName?: string,
  ) => {
    const issuedAt = overrides.issuedAt ?? new Date(Date.now() - 60_000).toISOString()
    const expiresAt = overrides.expiresAt ?? new Date(Date.now() + 3_600_000).toISOString()
    const reason = overrides.reason ?? 'OCV5-904 approved A0 guardrail update'
    const receiptSha = overrides.sha ?? sha
    const digest =
      overrides.sha256 ?? computeA0ReceiptDigest({ sha: receiptSha, issuedAt, expiresAt, reason })
    const receipt = {
      schemaVersion: 1,
      sha: receiptSha,
      reason,
      approvedBy: 'root',
      issuedAt,
      expiresAt,
      sha256: digest,
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

  test('initial [a0-bootstrap] rollout passes only when base lacks policy & diff is non-weakening; subsequent commits hard-block', () => {
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

      // 1. Valid initial introduction of A0 policy + referee + modified existing gate -> bootstrap PASS
      for (const rel of ['arch/a0-protected-paths.json', 'scripts/check-a0-monotonic.ts', '.github/CODEOWNERS']) {
        const dst = path.join(bootRepo, rel)
        mkdirSync(path.dirname(dst), { recursive: true })
        copyFileSync(path.join(root, rel), dst)
      }
      bWrite('scripts/check-existing.ts', 'export const x = 2\n')
      bGit('add', '-A')
      bGit('commit', '-qm', 'bootstrap a0')
      const rBoot = runCheckA0Monotonic({ root: bootRepo, base: 'pre-a0', approvalDir, requireRootOwner: false })
      assert.equal(rBoot.ok, true)
      assert.equal(rBoot.bootstrap, true)
      bGit('tag', 'post-a0')

      // 2. Subsequent commit touching A0 path (now that base has policy) -> 100% HARD-BLOCKED!
      bWrite('.github/CODEOWNERS', '* @nobody\n')
      bGit('add', '-A')
      bGit('commit', '-qm', 'post-bootstrap tamper')
      const rAfter = runCheckA0Monotonic({ root: bootRepo, base: 'post-a0', approvalDir, requireRootOwner: false })
      assert.equal(rAfter.ok, false)
      assert.notEqual(rAfter.bootstrap, true)

      // 3. Disallowed weakening during bootstrap (deleting existing gate) -> FAILS CLOSED!
      bGit('reset', '--hard', 'pre-a0')
      mkdirSync(path.join(bootRepo, 'arch'), { recursive: true })
      copyFileSync(path.join(root, 'arch/a0-protected-paths.json'), path.join(bootRepo, 'arch/a0-protected-paths.json'))
      rmSync(path.join(bootRepo, 'scripts/check-existing.ts'))
      bGit('add', '-A')
      bGit('commit', '-qm', 'bootstrap delete gate')
      const rWeak = runCheckA0Monotonic({ root: bootRepo, base: 'pre-a0', approvalDir, requireRootOwner: false })
      assert.equal(rWeak.ok, false)
      assert.ok((rWeak.bootstrapErrors ?? []).some((e) => e.includes('A0-GATE-DELETED')))
    } finally {
      rmSync(bootRepo, { recursive: true, force: true })
    }
  })
})
