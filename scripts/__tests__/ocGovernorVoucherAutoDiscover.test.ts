import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const GOVERNOR_SH = path.join(REPO_ROOT, 'scripts/harness-gate/oc-governor.sh')

function runGov(
  args: string[],
  envOverrides: Record<string, string> = {},
): { status: number; stdout: string; stderr: string } {
  const res = spawnSync('bash', [GOVERNOR_SH, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ...envOverrides,
    },
  })
  return {
    status: res.status ?? 1,
    stdout: (res.stdout ?? '').trim(),
    stderr: (res.stderr ?? '').trim(),
  }
}

function readAuditEntries(govRoot: string): Array<Record<string, unknown>> {
  const raw = readFileSync(path.join(govRoot, 'control/audit.jsonl'), 'utf8')
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

function initGitRepo(dir: string): { baseSha: string; commitFile: (relPath: string, content: string, msg: string) => string } {
  const git = (args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
  mkdirSync(dir, { recursive: true })
  git(['init', '-b', 'feat/v5-selfhost'])
  git(['config', 'user.email', 'test@openclaude.local'])
  git(['config', 'user.name', 'Test User'])
  writeFileSync(path.join(dir, 'README.md'), 'init\n')
  git(['add', 'README.md'])
  git(['commit', '-m', 'chore: init'])
  const baseSha = git(['rev-parse', 'HEAD'])
  const commitFile = (relPath: string, content: string, msg: string): string => {
    const abs = path.join(dir, relPath)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, content)
    git(['add', relPath])
    git(['commit', '-m', msg])
    return git(['rev-parse', 'HEAD'])
  }
  return { baseSha, commitFile }
}

function buildCanonicalVoucher(params: {
  id: string
  scope: string
  files: string[]
  reason: string
  issuedAt: string
  expiresAt: string
  sha?: string
  branch?: string
  approvalId?: string
  hmacKey?: string
}): Record<string, unknown> {
  const files = [...params.files].sort()
  let canonical = `blast-voucher-v1\nid=${params.id}\nscope=${params.scope}\nissuedAt=${params.issuedAt}\nexpiresAt=${params.expiresAt}\nfiles=${files.join(',')}\nreason=${params.reason}\n`
  if (params.sha) canonical += `sha=${params.sha}\n`
  if (params.branch) canonical += `branch=${params.branch}\n`
  if (params.approvalId) canonical += `approvalId=${params.approvalId}\n`
  const doc: Record<string, unknown> = {
    schemaVersion: 1,
    id: params.id,
    scope: params.scope,
    files,
    reason: params.reason,
    issuedBy: 'tester',
    issuedAt: params.issuedAt,
    expiresAt: params.expiresAt,
    sha256: createHash('sha256').update(canonical, 'utf8').digest('hex'),
  }
  if (params.sha) doc.sha = params.sha
  if (params.branch) doc.branch = params.branch
  if (params.approvalId) doc.approvalId = params.approvalId
  if (params.hmacKey) {
    doc.hmacSha256 = createHmac('sha256', params.hmacKey).update(canonical, 'utf8').digest('hex')
  }
  return doc
}

describe('oc-governor blast voucher auto-discovery (OCV5-918 Fix #2)', () => {
  test('auto-discovers bound voucher minted via decide-pending-approval for billing core and logs audit', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'oc-gov-autodisc-approve-'))
    try {
      const govRoot = path.join(tmp, 'harness-gate')
      const repoDir = path.join(tmp, 'repo')
      const billingFile = 'packages/commercial/src/billing/ledger.ts'
      const { baseSha, commitFile } = initGitRepo(repoDir)
      const sha = commitFile(billingFile, 'export const ledgerVersion = 2\n', 'feat: update ledger')
      const env = { OC_GOVERNOR_ROOT: govRoot, OC_GOVERNOR_NOW_ISO: '2026-11-27T10:00:00Z' }

      // Before approval -> fail-closed BILLING_CORE_LOCKED
      const blocked = runGov(
        [
          'check-blast-radius',
          '--branch',
          'feat/v5-selfhost',
          '--repo-root',
          repoDir,
          '--sha',
          sha,
          '--base-ref',
          baseSha,
          '--files',
          billingFile,
        ],
        env,
      )
      assert.equal(blocked.status, 1)
      assert.equal(JSON.parse(blocked.stderr).code, 'BILLING_CORE_LOCKED')

      // Record pending approval & approve via decide-pending-approval (mints bound blast voucher)
      const rec = runGov(
        [
          'record-pending-approval',
          '--id',
          'gov-billing-autodisc-01',
          '--kind',
          'blast_voucher',
          '--code',
          'BILLING_CORE_LOCKED',
          '--branch',
          'feat/v5-selfhost',
          '--sha',
          sha,
          '--base-ref',
          baseSha,
          '--repo-root',
          repoDir,
          '--files',
          billingFile,
        ],
        env,
      )
      assert.equal(rec.status, 0, rec.stderr)

      const dec = runGov(
        [
          'decide-pending-approval',
          '--id',
          'gov-billing-autodisc-01',
          '--decision',
          'approve',
          '--actor',
          'boss',
          '--note',
          'verified ledger change safe',
        ],
        env,
      )
      assert.equal(dec.status, 0, dec.stderr)
      const mintedVoucherId = (JSON.parse(dec.stdout).decision as { issuedArtifactId: string }).issuedArtifactId
      assert.match(mintedVoucherId, /^bv-[a-z0-9_-]{4,64}$/)

      // Re-run check-blast-radius WITHOUT --voucher -> auto-discovered and passed!
      const passed = runGov(
        [
          'check-blast-radius',
          '--branch',
          'origin/feat/v5-selfhost',
          '--repo-root',
          repoDir,
          '--sha',
          sha,
          '--base-ref',
          baseSha,
          '--files',
          billingFile,
        ],
        { ...env, OC_GOVERNOR_NOW_ISO: '2026-11-27T11:30:00Z' },
      )
      assert.equal(passed.status, 0, passed.stderr)
      const out = JSON.parse(passed.stdout)
      assert.equal(out.ok, true)
      assert.equal(out.classification, 'human_review_required')
      assert.equal(out.voucherId, mintedVoucherId)
      assert.equal(out.voucherAutoDiscovered, true)
      assert.deepEqual(out.coreBillingFiles, [billingFile])

      // Verify audit.jsonl records voucherId + voucherAutoDiscovered: true
      const audits = readAuditEntries(govRoot).filter(
        (e) => e.action === 'check_blast_radius' && e.outcome === 'ok',
      )
      assert.equal(audits.length, 1)
      assert.equal(audits[0]!.voucherId, mintedVoucherId)
      assert.equal(audits[0]!.voucherAutoDiscovered, true)
      assert.equal(audits[0]!.sha, sha)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('auto-discovers bound voucher issued via issue-blast-voucher for destructive DDL', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'oc-gov-autodisc-ddl-'))
    try {
      const govRoot = path.join(tmp, 'harness-gate')
      const repoDir = path.join(tmp, 'repo')
      const migFile = 'packages/commercial/src/db/migrations/0999_drop_legacy.sql'
      const { baseSha, commitFile } = initGitRepo(repoDir)
      const sha = commitFile(
        migFile,
        'ALTER TABLE users DROP COLUMN legacy_flag;\n',
        'feat: drop legacy column',
      )
      const env = { OC_GOVERNOR_ROOT: govRoot, OC_GOVERNOR_NOW_ISO: '2026-11-27T10:00:00Z' }

      // Without voucher -> DESTRUCTIVE_DDL_LOCKED
      const blocked = runGov(
        [
          'check-blast-radius',
          '--branch',
          'feat/v5-selfhost',
          '--repo-root',
          repoDir,
          '--sha',
          sha,
          '--base-ref',
          baseSha,
          '--files',
          migFile,
        ],
        env,
      )
      assert.equal(blocked.status, 1)
      assert.equal(JSON.parse(blocked.stderr).code, 'DESTRUCTIVE_DDL_LOCKED')

      // Issue bound DDL voucher
      const issued = runGov(
        [
          'issue-blast-voucher',
          '--scope',
          'ddl',
          '--sha',
          sha,
          '--branch',
          'feat/v5-selfhost',
          '--files',
          migFile,
          '--reason',
          'Approved legacy column cleanup migration',
        ],
        env,
      )
      assert.equal(issued.status, 0, issued.stderr)
      const vid = (JSON.parse(issued.stdout) as { id: string }).id

      // Re-run without --voucher -> auto-discovered!
      const passed = runGov(
        [
          'check-blast-radius',
          '--branch',
          'feat/v5-selfhost',
          '--repo-root',
          repoDir,
          '--sha',
          sha,
          '--base-ref',
          baseSha,
          '--files',
          migFile,
        ],
        env,
      )
      assert.equal(passed.status, 0, passed.stderr)
      const out = JSON.parse(passed.stdout)
      assert.equal(out.ok, true)
      assert.equal(out.voucherId, vid)
      assert.equal(out.voucherAutoDiscovered, true)
      assert.deepEqual(out.ddlFiles, [migFile])

      const audits = readAuditEntries(govRoot).filter(
        (e) => e.action === 'check_blast_radius' && e.outcome === 'ok',
      )
      assert.equal(audits.at(-1)?.voucherId, vid)
      assert.equal(audits.at(-1)?.voucherAutoDiscovered, true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('fail-closed negative matrix: unbound sha/branch, mismatch, expiry, partial files, scope, tamper, symlink, 0664, inline-sql, commercial branch, hmac', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'oc-gov-autodisc-neg-'))
    try {
      const repoDir = path.join(tmp, 'repo')
      const billingA = 'packages/commercial/src/billing/ledger.ts'
      const billingB = 'packages/commercial/src/billing/pricing.ts'
      const migFile = 'packages/commercial/src/db/migrations/0888_drop.sql'
      const { baseSha, commitFile } = initGitRepo(repoDir)
      const shaA = commitFile(billingA, 'export const a = 1\n', 'feat: ledger')
      const shaB = commitFile(migFile, 'DROP TABLE legacy_tmp;\n', 'feat: drop tmp')
      const nowIso = '2026-11-27T10:00:00Z'

      const freshRoot = (name: string) => path.join(tmp, `gov-${name}`)

      // 1. Legacy voucher missing --sha: auto-discover MUST REJECT, explicit --voucher MUST PASS
      {
        const govRoot = freshRoot('no-sha')
        const env = { OC_GOVERNOR_ROOT: govRoot, OC_GOVERNOR_NOW_ISO: nowIso }
        const vRes = runGov(
          [
            'issue-blast-voucher',
            '--scope',
            'billing',
            '--branch',
            'feat/v5-selfhost',
            '--files',
            billingA,
            '--reason',
            'legacy voucher without sha',
          ],
          env,
        )
        assert.equal(vRes.status, 0, vRes.stderr)
        const vid = (JSON.parse(vRes.stdout) as { id: string }).id

        const autoRes = runGov(
          ['check-blast-radius', '--branch', 'feat/v5-selfhost', '--sha', shaA, '--files', billingA],
          env,
        )
        assert.equal(autoRes.status, 1)
        assert.equal(JSON.parse(autoRes.stderr).code, 'BILLING_CORE_LOCKED')

        const explicitRes = runGov(
          [
            'check-blast-radius',
            '--branch',
            'feat/v5-selfhost',
            '--sha',
            shaA,
            '--files',
            billingA,
            '--voucher',
            vid,
          ],
          env,
        )
        assert.equal(explicitRes.status, 0, explicitRes.stderr)
        assert.equal(JSON.parse(explicitRes.stdout).voucherId, vid)
      }

      // 2. Voucher missing --branch: auto-discover MUST REJECT
      {
        const govRoot = freshRoot('no-branch')
        const env = { OC_GOVERNOR_ROOT: govRoot, OC_GOVERNOR_NOW_ISO: nowIso }
        const vRes = runGov(
          [
            'issue-blast-voucher',
            '--scope',
            'billing',
            '--sha',
            shaA,
            '--files',
            billingA,
            '--reason',
            'voucher without branch',
          ],
          env,
        )
        assert.equal(vRes.status, 0, vRes.stderr)
        const autoRes = runGov(
          ['check-blast-radius', '--branch', 'feat/v5-selfhost', '--sha', shaA, '--files', billingA],
          env,
        )
        assert.equal(autoRes.status, 1)
        assert.equal(JSON.parse(autoRes.stderr).code, 'BILLING_CORE_LOCKED')
      }

      // 3. SHA mismatch, branch mismatch, expiry, partial file coverage
      {
        const govRoot = freshRoot('bound-mismatches')
        const env = { OC_GOVERNOR_ROOT: govRoot, OC_GOVERNOR_NOW_ISO: nowIso }
        const vRes = runGov(
          [
            'issue-blast-voucher',
            '--scope',
            'billing',
            '--sha',
            shaA,
            '--branch',
            'feat/v5-selfhost',
            '--ttl-hours',
            '2',
            '--files',
            billingA,
            '--reason',
            'bound to shaA and ledger only',
          ],
          env,
        )
        assert.equal(vRes.status, 0, vRes.stderr)

        // SHA mismatch
        const wrongSha = runGov(
          ['check-blast-radius', '--branch', 'feat/v5-selfhost', '--sha', shaB, '--files', billingA],
          env,
        )
        assert.equal(wrongSha.status, 1)
        assert.equal(JSON.parse(wrongSha.stderr).code, 'BILLING_CORE_LOCKED')

        // Branch mismatch
        const wrongBr = runGov(
          ['check-blast-radius', '--branch', 'feat/other-branch', '--sha', shaA, '--files', billingA],
          env,
        )
        assert.equal(wrongBr.status, 1)
        assert.equal(JSON.parse(wrongBr.stderr).code, 'BILLING_CORE_LOCKED')

        // Expired
        const expired = runGov(
          ['check-blast-radius', '--branch', 'feat/v5-selfhost', '--sha', shaA, '--files', billingA],
          { OC_GOVERNOR_ROOT: govRoot, OC_GOVERNOR_NOW_ISO: '2026-11-27T12:00:00Z' },
        )
        assert.equal(expired.status, 1)
        assert.equal(JSON.parse(expired.stderr).code, 'BILLING_CORE_LOCKED')

        // Partial file coverage (missing billingB)
        const partial = runGov(
          [
            'check-blast-radius',
            '--branch',
            'feat/v5-selfhost',
            '--sha',
            shaA,
            '--files',
            billingA,
            billingB,
          ],
          env,
        )
        assert.equal(partial.status, 1)
        assert.equal(JSON.parse(partial.stderr).code, 'BILLING_CORE_LOCKED')
      }

      // 4. Scope mismatch: billing-only voucher cannot cover DDL hit even if file listed
      {
        const govRoot = freshRoot('scope-mismatch')
        const env = { OC_GOVERNOR_ROOT: govRoot, OC_GOVERNOR_NOW_ISO: nowIso }
        const vRes = runGov(
          [
            'issue-blast-voucher',
            '--scope',
            'billing',
            '--sha',
            shaB,
            '--branch',
            'feat/v5-selfhost',
            '--files',
            billingA,
            migFile,
            '--reason',
            'billing only scope does not authorize ddl',
          ],
          env,
        )
        assert.equal(vRes.status, 0, vRes.stderr)
        const ddlRes = runGov(
          [
            'check-blast-radius',
            '--branch',
            'feat/v5-selfhost',
            '--repo-root',
            repoDir,
            '--sha',
            shaB,
            '--base-ref',
            baseSha,
            '--files',
            billingA,
            migFile,
          ],
          env,
        )
        assert.equal(ddlRes.status, 1)
        assert.equal(JSON.parse(ddlRes.stderr).code, 'DESTRUCTIVE_DDL_LOCKED')
      }

      // 5. Tampered content (sha256 mismatch) -> rejected
      {
        const govRoot = freshRoot('tampered')
        const env = { OC_GOVERNOR_ROOT: govRoot, OC_GOVERNOR_NOW_ISO: nowIso }
        const vRes = runGov(
          [
            'issue-blast-voucher',
            '--scope',
            'billing',
            '--sha',
            shaA,
            '--branch',
            'feat/v5-selfhost',
            '--files',
            billingA,
            '--reason',
            'original untampered reason',
          ],
          env,
        )
        const vDoc = JSON.parse(vRes.stdout) as Record<string, unknown>
        const vPath = path.join(govRoot, 'control/blast-vouchers', `${vDoc.id}.json`)
        writeFileSync(vPath, JSON.stringify({ ...vDoc, reason: 'tampered reason text' }, null, 2))
        chmodSync(vPath, 0o644)

        const autoRes = runGov(
          ['check-blast-radius', '--branch', 'feat/v5-selfhost', '--sha', shaA, '--files', billingA],
          env,
        )
        assert.equal(autoRes.status, 1)
        assert.equal(JSON.parse(autoRes.stderr).code, 'BILLING_CORE_LOCKED')
      }

      // 6. Symlink voucher -> rejected
      {
        const govRoot = freshRoot('symlink')
        const env = { OC_GOVERNOR_ROOT: govRoot, OC_GOVERNOR_NOW_ISO: nowIso }
        const vDir = path.join(govRoot, 'control/blast-vouchers')
        mkdirSync(vDir, { recursive: true })
        const outside = path.join(tmp, 'outside-voucher.json')
        const doc = buildCanonicalVoucher({
          id: 'bv-symlink001',
          scope: 'billing',
          files: [billingA],
          reason: 'symlink target voucher',
          issuedAt: nowIso,
          expiresAt: '2026-11-27T14:00:00Z',
          sha: shaA,
          branch: 'feat/v5-selfhost',
        })
        writeFileSync(outside, JSON.stringify(doc, null, 2))
        chmodSync(outside, 0o644)
        symlinkSync(outside, path.join(vDir, 'bv-symlink001.json'))

        const autoRes = runGov(
          ['check-blast-radius', '--branch', 'feat/v5-selfhost', '--sha', shaA, '--files', billingA],
          env,
        )
        assert.equal(autoRes.status, 1)
        assert.equal(JSON.parse(autoRes.stderr).code, 'BILLING_CORE_LOCKED')
      }

      // 7. Group-writable (0664) voucher -> rejected (both auto-discover and explicit)
      {
        const govRoot = freshRoot('writable-0664')
        const env = { OC_GOVERNOR_ROOT: govRoot, OC_GOVERNOR_NOW_ISO: nowIso }
        const vRes = runGov(
          [
            'issue-blast-voucher',
            '--scope',
            'billing',
            '--sha',
            shaA,
            '--branch',
            'feat/v5-selfhost',
            '--files',
            billingA,
            '--reason',
            'voucher with insecure 0664 mode',
          ],
          env,
        )
        const vid = (JSON.parse(vRes.stdout) as { id: string }).id
        const vPath = path.join(govRoot, 'control/blast-vouchers', `${vid}.json`)
        chmodSync(vPath, 0o664)

        const autoRes = runGov(
          ['check-blast-radius', '--branch', 'feat/v5-selfhost', '--sha', shaA, '--files', billingA],
          env,
        )
        assert.equal(autoRes.status, 1)
        assert.equal(JSON.parse(autoRes.stderr).code, 'BILLING_CORE_LOCKED')

        const expRes = runGov(
          [
            'check-blast-radius',
            '--branch',
            'feat/v5-selfhost',
            '--sha',
            shaA,
            '--files',
            billingA,
            '--voucher',
            vid,
          ],
          env,
        )
        assert.equal(expRes.status, 1)
        assert.equal(JSON.parse(expRes.stderr).code, 'INVALID_VOUCHER_PATH')
      }

      // 8. Inline --sql MUST reject auto-discovery even with valid bound ddl voucher
      {
        const govRoot = freshRoot('inline-sql')
        const env = { OC_GOVERNOR_ROOT: govRoot, OC_GOVERNOR_NOW_ISO: nowIso }
        const vRes = runGov(
          [
            'issue-blast-voucher',
            '--scope',
            'ddl',
            '--sha',
            shaB,
            '--branch',
            'feat/v5-selfhost',
            '--files',
            migFile,
            '--reason',
            'bound ddl voucher cannot auto-pass inline sql',
          ],
          env,
        )
        assert.equal(vRes.status, 0, vRes.stderr)
        const inlineRes = runGov(
          [
            'check-blast-radius',
            '--branch',
            'feat/v5-selfhost',
            '--sha',
            shaB,
            '--sql',
            'DROP TABLE users;',
          ],
          env,
        )
        assert.equal(inlineRes.status, 1)
        assert.equal(JSON.parse(inlineRes.stderr).code, 'DESTRUCTIVE_DDL_LOCKED')
      }

      // 9. Commercial branch feat/v5-aurora-rewrite MUST stay hard-locked even with forged valid-sha256 voucher
      {
        const govRoot = freshRoot('commercial')
        const env = { OC_GOVERNOR_ROOT: govRoot, OC_GOVERNOR_NOW_ISO: nowIso }
        const vDir = path.join(govRoot, 'control/blast-vouchers')
        mkdirSync(vDir, { recursive: true })
        const forged = buildCanonicalVoucher({
          id: 'bv-aurora001',
          scope: 'billing',
          files: [billingA],
          reason: 'forged voucher targeting aurora branch',
          issuedAt: nowIso,
          expiresAt: '2026-11-27T14:00:00Z',
          sha: shaA,
          branch: 'feat/v5-aurora-rewrite',
        })
        const vPath = path.join(vDir, 'bv-aurora001.json')
        writeFileSync(vPath, JSON.stringify(forged, null, 2))
        chmodSync(vPath, 0o644)

        const auroraRes = runGov(
          [
            'check-blast-radius',
            '--branch',
            'feat/v5-aurora-rewrite',
            '--sha',
            shaA,
            '--files',
            billingA,
          ],
          env,
        )
        assert.equal(auroraRes.status, 1)
        const errDoc = JSON.parse(auroraRes.stderr)
        assert.equal(errDoc.code, 'COMMERCIAL_BRANCH_HARD_LOCK')
        assert.equal(errDoc.classification, 'absolute_reject')
      }

      // 10. Forward-compatible hmacSha256: rejected without key or wrong key, accepted with matching 0600 key
      {
        const govRoot = freshRoot('hmac-compat')
        const env = { OC_GOVERNOR_ROOT: govRoot, OC_GOVERNOR_NOW_ISO: nowIso }
        const ctrlDir = path.join(govRoot, 'control')
        const vDir = path.join(ctrlDir, 'blast-vouchers')
        mkdirSync(vDir, { recursive: true })
        const secret = 'voucher-hmac-test-secret-918'
        const doc = buildCanonicalVoucher({
          id: 'bv-hmac0001',
          scope: 'billing',
          files: [billingA],
          reason: 'forward compatible hmac voucher',
          issuedAt: nowIso,
          expiresAt: '2026-11-27T14:00:00Z',
          sha: shaA,
          branch: 'feat/v5-selfhost',
          hmacKey: secret,
        })
        const vPath = path.join(vDir, 'bv-hmac0001.json')
        writeFileSync(vPath, JSON.stringify(doc, null, 2))
        chmodSync(vPath, 0o644)

        // No .hmac-key -> fail-closed!
        const noKey = runGov(
          ['check-blast-radius', '--branch', 'feat/v5-selfhost', '--sha', shaA, '--files', billingA],
          env,
        )
        assert.equal(noKey.status, 1)
        assert.equal(JSON.parse(noKey.stderr).code, 'BILLING_CORE_LOCKED')

        // Wrong .hmac-key -> fail-closed!
        const keyPath = path.join(ctrlDir, '.hmac-key')
        writeFileSync(keyPath, 'wrong-secret\n', { mode: 0o600 })
        chmodSync(keyPath, 0o600)
        const badKey = runGov(
          ['check-blast-radius', '--branch', 'feat/v5-selfhost', '--sha', shaA, '--files', billingA],
          env,
        )
        assert.equal(badKey.status, 1)
        assert.equal(JSON.parse(badKey.stderr).code, 'BILLING_CORE_LOCKED')

        // Matching 0600 .hmac-key -> auto-discovered!
        writeFileSync(keyPath, `${secret}\n`, { mode: 0o600 })
        chmodSync(keyPath, 0o600)
        const okKey = runGov(
          ['check-blast-radius', '--branch', 'feat/v5-selfhost', '--sha', shaA, '--files', billingA],
          env,
        )
        assert.equal(okKey.status, 0, okKey.stderr)
        assert.equal(JSON.parse(okKey.stdout).voucherId, 'bv-hmac0001')
        assert.equal(JSON.parse(okKey.stdout).voucherAutoDiscovered, true)
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('skips corrupted/expired vouchers safely and deterministically picks latest expiresAt among multiple valid bound vouchers', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'oc-gov-autodisc-multi-'))
    try {
      const govRoot = path.join(tmp, 'harness-gate')
      const vDir = path.join(govRoot, 'control/blast-vouchers')
      mkdirSync(vDir, { recursive: true })
      const billingFile = 'packages/commercial/src/billing/ledger.ts'
      const sha = 'a'.repeat(40)
      const nowIso = '2026-11-27T10:00:00Z'
      const env = { OC_GOVERNOR_ROOT: govRoot, OC_GOVERNOR_NOW_ISO: nowIso }

      // 1. Corrupted JSON file
      const corruptPath = path.join(vDir, 'bv-00corrupt.json')
      writeFileSync(corruptPath, '{ not valid json')
      chmodSync(corruptPath, 0o644)

      // 2. Malformed expiresAt JSON file (valid sha256, broken ISO date)
      const badIsoDoc = buildCanonicalVoucher({
        id: 'bv-01badiso',
        scope: 'billing',
        files: [billingFile],
        reason: 'malformed expiry date test',
        issuedAt: nowIso,
        expiresAt: 'not-a-timestamp',
        sha,
        branch: 'feat/v5-selfhost',
      })
      writeFileSync(path.join(vDir, 'bv-01badiso.json'), JSON.stringify(badIsoDoc, null, 2))
      chmodSync(path.join(vDir, 'bv-01badiso.json'), 0o644)

      // 3. Expired voucher
      const expRes = runGov(
        [
          'issue-blast-voucher',
          '--id',
          'bv-02expired',
          '--scope',
          'billing',
          '--sha',
          sha,
          '--branch',
          'feat/v5-selfhost',
          '--ttl-hours',
          '1',
          '--files',
          billingFile,
          '--reason',
          'already expired voucher',
        ],
        { OC_GOVERNOR_ROOT: govRoot, OC_GOVERNOR_NOW_ISO: '2026-11-27T08:00:00Z' },
      )
      assert.equal(expRes.status, 0, expRes.stderr)

      // 4. Earlier-expiring valid bound voucher with lexicographically LATER name (bv-zz-early, expires +2h)
      const earlyRes = runGov(
        [
          'issue-blast-voucher',
          '--id',
          'bv-zz-early',
          '--scope',
          'billing',
          '--sha',
          sha,
          '--branch',
          'feat/v5-selfhost',
          '--ttl-hours',
          '2',
          '--files',
          billingFile,
          '--reason',
          'valid voucher expiring earlier',
        ],
        env,
      )
      assert.equal(earlyRes.status, 0, earlyRes.stderr)

      // 5. Later-expiring valid bound voucher with lexicographically EARLIER name (bv-aa-late, expires +6h)
      const lateRes = runGov(
        [
          'issue-blast-voucher',
          '--id',
          'bv-aa-late',
          '--scope',
          'billing',
          '--sha',
          sha,
          '--branch',
          'feat/v5-selfhost',
          '--ttl-hours',
          '6',
          '--files',
          billingFile,
          '--reason',
          'valid voucher expiring later',
        ],
        env,
      )
      assert.equal(lateRes.status, 0, lateRes.stderr)

      const res = runGov(
        [
          'check-blast-radius',
          '--branch',
          'feat/v5-selfhost',
          '--sha',
          sha,
          '--files',
          billingFile,
        ],
        env,
      )
      assert.equal(res.status, 0, res.stderr)
      const out = JSON.parse(res.stdout)
      assert.equal(out.ok, true)
      assert.equal(out.voucherAutoDiscovered, true)
      assert.equal(out.voucherId, 'bv-aa-late', 'must deterministically pick voucher with latest expiresAt')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('fail-closed when blast-vouchers, parent control dir, or gov_root dir is a symlink (prevents /opt/openclaude redirect bypass)', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'oc-gov-autodisc-dirlink-'))
    try {
      const billingFile = 'packages/commercial/src/billing/ledger.ts'
      const sha = 'b'.repeat(40)
      const nowIso = '2026-11-27T10:00:00Z'

      // Prepare a real directory holding a valid bound voucher
      const realGovRoot = path.join(tmp, 'real-gov')
      const realCtrl = path.join(realGovRoot, 'control')
      const realVouchers = path.join(realCtrl, 'blast-vouchers')
      mkdirSync(realVouchers, { recursive: true })
      const vDoc = buildCanonicalVoucher({
        id: 'bv-dirlink01',
        scope: 'billing',
        files: [billingFile],
        reason: 'valid voucher inside real dir',
        issuedAt: nowIso,
        expiresAt: '2026-11-27T14:00:00Z',
        sha,
        branch: 'feat/v5-selfhost',
      })
      const realVoucherPath = path.join(realVouchers, 'bv-dirlink01.json')
      writeFileSync(realVoucherPath, JSON.stringify(vDoc, null, 2))
      chmodSync(realVoucherPath, 0o644)

      // Sanity: real (non-symlink) directory chain passes auto-discovery
      const realPass = runGov(
        ['check-blast-radius', '--branch', 'feat/v5-selfhost', '--sha', sha, '--files', billingFile],
        { OC_GOVERNOR_ROOT: realGovRoot, OC_GOVERNOR_NOW_ISO: nowIso },
      )
      assert.equal(realPass.status, 0, realPass.stderr)
      assert.equal(JSON.parse(realPass.stdout).voucherId, 'bv-dirlink01')

      // Case 1: blast-vouchers itself is a symlink
      const rootLinkVouchers = path.join(tmp, 'gov-link-vouchers')
      mkdirSync(path.join(rootLinkVouchers, 'control'), { recursive: true })
      symlinkSync(realVouchers, path.join(rootLinkVouchers, 'control/blast-vouchers'))

      // Case 2: parent control/ directory is a symlink
      const rootLinkCtrl = path.join(tmp, 'gov-link-ctrl')
      mkdirSync(rootLinkCtrl, { recursive: true })
      symlinkSync(realCtrl, path.join(rootLinkCtrl, 'control'))

      // Case 3: grandparent gov_root itself is a symlink
      const rootLinkGov = path.join(tmp, 'gov-link-root')
      symlinkSync(realGovRoot, rootLinkGov)

      for (const [label, symlinkedRoot] of [
        ['symlinked blast-vouchers dir', rootLinkVouchers],
        ['symlinked parent control dir', rootLinkCtrl],
        ['symlinked grandparent gov_root dir', rootLinkGov],
      ] as const) {
        const env = { OC_GOVERNOR_ROOT: symlinkedRoot, OC_GOVERNOR_NOW_ISO: nowIso }

        // Auto-discovery MUST fail closed
        const autoRes = runGov(
          ['check-blast-radius', '--branch', 'feat/v5-selfhost', '--sha', sha, '--files', billingFile],
          env,
        )
        assert.equal(autoRes.status, 1, `${label}: auto-discover must reject`)
        assert.equal(JSON.parse(autoRes.stderr).code, 'BILLING_CORE_LOCKED', label)

        // Explicit --voucher MUST also fail closed with INVALID_VOUCHER_PATH
        const expRes = runGov(
          [
            'check-blast-radius',
            '--branch',
            'feat/v5-selfhost',
            '--sha',
            sha,
            '--files',
            billingFile,
            '--voucher',
            'bv-dirlink01',
          ],
          env,
        )
        assert.equal(expRes.status, 1, `${label}: explicit --voucher must reject`)
        assert.equal(JSON.parse(expRes.stderr).code, 'INVALID_VOUCHER_PATH', label)
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
