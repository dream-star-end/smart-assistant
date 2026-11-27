import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  computeA0ReceiptDigest,
  computeA0ReceiptHmac,
  verifyA0ApprovalFile,
} from '../lib/a0ApprovalReceipt.js'
import { signArchStewardReceipt } from '../lib/archStewardReceipt.js'
import { ARCH_STEWARD_RECEIPT_SCHEMA_VERSION } from '../lib/archStewardTypes.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const HARNESS_SCRIPTS = path.join(REPO_ROOT, 'scripts/harness-gate')
const GOVERNOR_SH = path.join(HARNESS_SCRIPTS, 'oc-governor.sh')
const SYNC_REFEREE_SH = path.join(HARNESS_SCRIPTS, 'sync-referee.sh')
const INSTALL_SH = path.join(HARNESS_SCRIPTS, 'install-host-control-plane.sh')

function runBash(
  script: string,
  args: string[],
  envOverrides: Record<string, string> = {},
): { status: number; stdout: string; stderr: string } {
  const res = spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      OC_INSTALL_SKIP_CHOWN: '1',
      ...envOverrides,
    },
  })
  return {
    status: res.status ?? 1,
    stdout: (res.stdout ?? '').trim(),
    stderr: (res.stderr ?? '').trim(),
  }
}

describe('Host 4-Gate Control Plane (oc-governor + sync-referee + installer)', () => {
  test('installs idempotently with 0755 dirs, 0644 state files, and preserves active mode across reinstalls', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'oc-gov-install-'))
    try {
      const govRoot = path.join(tmp, 'harness-gate')
      const r1 = runBash(INSTALL_SH, ['--root', govRoot], {
        OC_GOVERNOR_NOW_ISO: '2026-11-26T10:00:00Z',
      })
      assert.equal(r1.status, 0, r1.stderr)

      const ctrlMode = statSync(path.join(govRoot, 'control')).mode & 0o777
      const modeFilePerm = statSync(path.join(govRoot, 'control/mode.json')).mode & 0o777
      const binPerm = statSync(path.join(govRoot, 'bin/oc-governor')).mode & 0o777
      assert.equal(ctrlMode, 0o755)
      assert.equal(modeFilePerm, 0o644)
      assert.equal(binPerm, 0o755)

      const initialMode = JSON.parse(readFileSync(path.join(govRoot, 'control/mode.json'), 'utf8'))
      assert.equal(initialMode.mode, 'autonomous')

      // Switch to emergency_stop, then re-run installer -> must NOT overwrite emergency_stop!
      const stopRes = runBash(
        path.join(govRoot, 'bin/oc-governor'),
        ['mode', 'emergency_stop', '--reason', 'incident containment drill'],
        { OC_GOVERNOR_ROOT: govRoot, OC_GOVERNOR_NOW_ISO: '2026-11-26T10:05:00Z' },
      )
      assert.equal(stopRes.status, 0, stopRes.stderr)

      const r2 = runBash(INSTALL_SH, ['--root', govRoot])
      assert.equal(r2.status, 0, r2.stderr)
      const preservedMode = JSON.parse(readFileSync(path.join(govRoot, 'control/mode.json'), 'utf8'))
      assert.equal(preservedMode.mode, 'emergency_stop')
      assert.equal(preservedMode.autoMergeFrozen, true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('Gate 1 (mode) & Gate 2 (approve-a0 / verify-a0 / revoke-a0): enforces reason, SHA-256 seal, risk card, tamper & expiry', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'oc-gov-a0-'))
    try {
      const env = { OC_GOVERNOR_ROOT: tmp, OC_GOVERNOR_NOW_ISO: '2026-11-26T12:00:00Z' }

      // Missing reason rejected
      const badMode = runBash(GOVERNOR_SH, ['mode', 'debt_first'], env)
      assert.notEqual(badMode.status, 0)

      const okMode = runBash(
        GOVERNOR_SH,
        ['mode', 'debt_first', '--reason', 'W48 rework above threshold'],
        env,
      )
      assert.equal(okMode.status, 0, okMode.stderr)
      assert.equal(JSON.parse(okMode.stdout).mode, 'debt_first')

      const sha = '120d63ea1c1278a5969a706f576c33e761f887f7'
      const approve = runBash(
        GOVERNOR_SH,
        ['approve-a0', '--sha', sha, '--reason', 'One-time baseline split migration', '--ttl-hours', '12'],
        env,
      )
      assert.equal(approve.status, 0, approve.stderr)
      const doc = JSON.parse(approve.stdout)
      assert.equal(doc.sha, sha)
      assert.equal(doc.expiresAt, '2026-11-27T00:00:00Z')
      assert.match(doc.riskCard, /^\[A0-RISK-CARD\] SHA 120d63ea1c12/)

      // Verify exact canonical hash matches a0-ratchet contract (including allowedPaths=*)
      const expectedCanonical = `a0-approval-v1\nsha=${sha}\nissuedAt=2026-11-26T12:00:00Z\nexpiresAt=2026-11-27T00:00:00Z\nreason=One-time baseline split migration\nallowedPaths=*\n`
      assert.equal(
        doc.sha256,
        createHash('sha256').update(expectedCanonical, 'utf8').digest('hex'),
      )

      // One-sentence risk card file written
      const cardTxt = readFileSync(path.join(tmp, `control/a0-approvals/${sha}.card.txt`), 'utf8').trim()
      assert.equal(cardTxt.split('\n').length, 1)

      // Valid before expiry (using test-only --unsafe-test-skip-owner in non-root tmpdir)
      const verifyOk = runBash(GOVERNOR_SH, ['verify-a0', '--sha', sha, '--unsafe-test-skip-owner'], {
        OC_GOVERNOR_ROOT: tmp,
        OC_GOVERNOR_NOW_ISO: '2026-11-26T23:59:59Z',
      })
      assert.equal(verifyOk.status, 0, verifyOk.stderr)

      // Expired at/after 12h TTL
      const verifyExp = runBash(GOVERNOR_SH, ['verify-a0', '--sha', sha, '--unsafe-test-skip-owner'], {
        OC_GOVERNOR_ROOT: tmp,
        OC_GOVERNOR_NOW_ISO: '2026-11-27T00:00:00Z',
      })
      assert.equal(verifyExp.status, 1)

      // Tamper reason without updating sha256 -> blocked as signature_tampered
      const tampered = { ...doc, reason: 'Tampered reason text' }
      writeFileSync(path.join(tmp, `control/a0-approvals/${sha}.json`), JSON.stringify(tampered))
      const verifyTamper = runBash(
        GOVERNOR_SH,
        ['verify-a0', '--sha', sha, '--unsafe-test-skip-owner'],
        env,
      )
      assert.equal(verifyTamper.status, 1)
      assert.match(verifyTamper.stderr, /signature_tampered/)

      // Revoke removes seal
      const revoke = runBash(GOVERNOR_SH, ['revoke-a0', '--sha', sha], env)
      assert.equal(revoke.status, 0)
      assert.equal(existsSync(path.join(tmp, `control/a0-approvals/${sha}.json`)), false)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('B3 cross-end byte-level parity: oc-governor.sh verify-a0 and a0ApprovalReceipt.ts give 100% identical verdicts across positive & negative matrix + --publish-github-status', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'oc-gov-a0-parity-'))
    try {
      const sha = 'abcdef0123456789abcdef0123456789abcdef01'
      const nowIso = '2026-11-26T15:00:00Z'
      const nowMs = Date.parse(nowIso)
      const issuedAt = '2026-11-26T12:00:00Z'
      const expiresAt = '2026-11-27T12:00:00Z'
      const ctrlDir = path.join(tmp, 'control')
      const approvalsDir = path.join(ctrlDir, 'a0-approvals')
      mkdirSync(approvalsDir, { recursive: true })

      // 1. approve-a0 with padded reason + unsorted allowedPaths + --publish-github-status
      const fakeBin = path.join(tmp, 'fake-bin')
      const ghLog = path.join(tmp, 'gh-a0.log')
      mkdirSync(fakeBin, { recursive: true })
      writeFileSync(
        path.join(fakeBin, 'gh'),
        `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${ghLog}"\n`,
        { mode: 0o755 },
      )
      // 1a. B2: Long allowedPaths that cannot fit in GitHub 140-char description with --publish-github-status MUST FAIL-CLOSED!
      const overflowRes = runBash(
        GOVERNOR_SH,
        [
          'approve-a0',
          '--sha',
          sha,
          '--reason',
          '   Trimmed valid A0 governance reason   ',
          '--allowed-path',
          'scripts/check-a0-monotonic.ts',
          '--allowed-path',
          'arch/a0-protected-paths.json',
          '--publish-github-status',
          '--github-repo',
          'dream-star-end/openclaude',
        ],
        {
          OC_GOVERNOR_ROOT: tmp,
          OC_GOVERNOR_NOW_ISO: issuedAt,
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        },
      )
      assert.equal(
        overflowRes.status,
        1,
        'overflowing allowedPaths with --publish-github-status MUST fail closed (never drop scope!)',
      )
      assert.match(overflowRes.stderr, /cannot publish oc-v5\/a0-approval.*refusing to silently drop allowedPaths/)
      assert.equal(existsSync(ghLog), false, 'failed overflow publish must NOT call gh api')

      // 1b. Compact allowedPaths + --publish-github-status succeeds & explicitly includes paths=
      const ghShortSha = 'f'.repeat(40)
      const ghApprove = runBash(
        GOVERNOR_SH,
        [
          'approve-a0',
          '--sha',
          ghShortSha,
          '--reason',
          'Compact scope publish ok',
          '--allowed-path',
          'arch/a0-protected-paths.json',
          '--publish-github-status',
          '--github-repo',
          'dream-star-end/openclaude',
        ],
        {
          OC_GOVERNOR_ROOT: tmp,
          OC_GOVERNOR_NOW_ISO: issuedAt,
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        },
      )
      assert.equal(ghApprove.status, 0, ghApprove.stderr)
      const ghLine = readFileSync(ghLog, 'utf8')
      assert.match(ghLine, /context=oc-v5\/a0-approval/)
      assert.match(ghLine, /state=success/)
      assert.match(ghLine, /paths=arch\/a0-protected-paths\.json/)
      assert.match(ghLine, new RegExp(`sha=${ghShortSha.slice(0, 12)}`))

      // 1c. B2: revoke-a0 automatically publishes state=failure revocation status on GitHub for published SHA!
      writeFileSync(ghLog, '')
      const revokeRes = runBash(
        GOVERNOR_SH,
        ['revoke-a0', '--sha', ghShortSha, '--reason', 'Compromised candidate SHA'],
        {
          OC_GOVERNOR_ROOT: tmp,
          OC_GOVERNOR_NOW_ISO: nowIso,
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        },
      )
      assert.equal(revokeRes.status, 0, revokeRes.stderr)
      assert.equal(JSON.parse(revokeRes.stdout).publishedGithubRevocation, true)
      const revokeGhLine = readFileSync(ghLog, 'utf8')
      assert.match(revokeGhLine, /state=failure/)
      assert.match(revokeGhLine, /context=oc-v5\/a0-approval/)
      assert.match(revokeGhLine, /revoked/)

      // 1d. B7 Unicode UTF-8 byte-order parity (U+E000 vs U+20000: UTF-8 puts U+E000 before U+20000 on BOTH ends!)
      const uniSha = 'd'.repeat(40)
      const uniApprove = runBash(
        GOVERNOR_SH,
        [
          'approve-a0',
          '--sha',
          uniSha,
          '--reason',
          'Unicode UTF-8 byte-order parity check',
          '--allowed-path',
          'dir/\u{20000}.ts',
          '--allowed-path',
          'dir/\uE000.ts',
        ],
        { OC_GOVERNOR_ROOT: tmp, OC_GOVERNOR_NOW_ISO: issuedAt },
      )
      assert.equal(uniApprove.status, 0, uniApprove.stderr)
      const uniDoc = JSON.parse(uniApprove.stdout)
      assert.deepEqual(uniDoc.allowedPaths, ['dir/\uE000.ts', 'dir/\u{20000}.ts'])
      assert.equal(
        uniDoc.sha256,
        computeA0ReceiptDigest({
          sha: uniSha,
          issuedAt,
          expiresAt,
          reason: uniDoc.reason,
          allowedPaths: ['dir/\u{20000}.ts', 'dir/\uE000.ts'],
        }),
      )

      // 1e. Host-only approval with multi-path allowedPaths for parity matrix
      const approveRes = runBash(
        GOVERNOR_SH,
        [
          'approve-a0',
          '--sha',
          sha,
          '--reason',
          '   Trimmed valid A0 governance reason   ',
          '--allowed-path',
          'scripts/check-a0-monotonic.ts',
          '--allowed-path',
          'arch/a0-protected-paths.json',
        ],
        {
          OC_GOVERNOR_ROOT: tmp,
          OC_GOVERNOR_NOW_ISO: issuedAt,
        },
      )
      assert.equal(approveRes.status, 0, approveRes.stderr)
      const issuedDoc = JSON.parse(approveRes.stdout)
      assert.equal(issuedDoc.reason, 'Trimmed valid A0 governance reason')
      assert.deepEqual(issuedDoc.allowedPaths, [
        'arch/a0-protected-paths.json',
        'scripts/check-a0-monotonic.ts',
      ])
      assert.equal(
        issuedDoc.sha256,
        computeA0ReceiptDigest({
          sha,
          issuedAt,
          expiresAt,
          reason: issuedDoc.reason,
          allowedPaths: issuedDoc.allowedPaths,
        }),
      )

      // 2. Parity matrix helper: asserts oc-governor verify-a0 and verifyA0ApprovalFile agree 100%!
      const assertParity = (
        label: string,
        receiptPath: string,
        opts: {
          wantValid: boolean
          paths?: string[]
          hmacKeyFile?: string
          now?: string
        },
      ) => {
        const checkNow = opts.now ?? nowIso
        const tsRes = verifyA0ApprovalFile({
          receiptPath,
          targetSha: sha,
          a0Paths: opts.paths ?? [],
          requireRootOwner: false,
          hmacKeyFile: opts.hmacKeyFile,
          nowMs: Date.parse(checkNow),
        })
        const shArgs = ['verify-a0', '--sha', sha, '--file', receiptPath, '--unsafe-test-skip-owner']
        if (opts.hmacKeyFile) shArgs.push('--hmac-key-file', opts.hmacKeyFile)
        for (const p of opts.paths ?? []) shArgs.push('--path', p)
        const shRes = runBash(GOVERNOR_SH, shArgs, {
          OC_GOVERNOR_ROOT: tmp,
          OC_GOVERNOR_NOW_ISO: checkNow,
        })
        assert.equal(tsRes.valid, opts.wantValid, `[TS] ${label}: got ${JSON.stringify(tsRes)}`)
        assert.equal(shRes.status === 0, opts.wantValid, `[SH] ${label}: stdout=${shRes.stdout} stderr=${shRes.stderr}`)
        assert.equal(tsRes.valid, shRes.status === 0, `[PARITY MISMATCH] ${label}`)
      }

      const writeCase = (name: string, obj: unknown, mode = 0o644) => {
        const p = path.join(approvalsDir, `${name}.json`)
        writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`, { mode })
        chmodSync(p, mode)
        return p
      }

      // Case A: issuer-produced receipt with matching path -> BOTH PASS
      assertParity('valid issuer receipt + covered path', path.join(approvalsDir, `${sha}.json`), {
        wantValid: true,
        paths: ['arch/a0-protected-paths.json'],
      })
      // Case B: issuer-produced receipt with uncovered path -> BOTH REJECT
      assertParity('valid issuer receipt + uncovered path', path.join(approvalsDir, `${sha}.json`), {
        wantValid: false,
        paths: ['packages/commercial/src/billing/ledger.ts'],
      })
      // Case C: reason with spaces trimming to >= 8 chars -> BOTH PASS
      const paddedReason = '   valid trimmed reason   '
      assertParity(
        'padded reason >= 8 after trim',
        writeCase('padded-ok', {
          schemaVersion: 1,
          sha,
          reason: paddedReason,
          issuedAt,
          expiresAt,
          sha256: computeA0ReceiptDigest({ sha, issuedAt, expiresAt, reason: paddedReason }),
        }),
        { wantValid: true },
      )
      // Case D: reason with spaces trimming to < 8 chars -> BOTH REJECT (exact bug from R1!)
      const shortPadded = '   abc   '
      assertParity(
        'short padded reason < 8 after trim',
        writeCase('padded-short', {
          schemaVersion: 1,
          sha,
          reason: shortPadded,
          issuedAt,
          expiresAt,
          sha256: computeA0ReceiptDigest({ sha, issuedAt, expiresAt, reason: shortPadded }),
        }),
        { wantValid: false },
      )
      // Case E: tampered allowedPaths -> BOTH REJECT
      assertParity(
        'tampered allowedPaths',
        writeCase('tampered-paths', {
          ...issuedDoc,
          allowedPaths: ['arch/a0-protected-paths.json', 'changelog.json'],
        }),
        { wantValid: false },
      )
      // Case F: expired timestamp -> BOTH REJECT
      assertParity('expired receipt', path.join(approvalsDir, `${sha}.json`), {
        wantValid: false,
        now: '2026-11-28T00:00:00Z',
      })
      // Case G: expiresAt <= issuedAt -> BOTH REJECT
      assertParity(
        'expiresAt <= issuedAt',
        writeCase('bad-expiry-order', {
          schemaVersion: 1,
          sha,
          reason: 'valid reason text here',
          issuedAt: '2026-11-26T12:00:00Z',
          expiresAt: '2026-11-26T12:00:00Z',
          sha256: computeA0ReceiptDigest({
            sha,
            issuedAt: '2026-11-26T12:00:00Z',
            expiresAt: '2026-11-26T12:00:00Z',
            reason: 'valid reason text here',
          }),
        }),
        { wantValid: false },
      )
      // Case H: group/world writable (0666) -> BOTH REJECT
      assertParity(
        'world writable 0666',
        writeCase(
          'writable',
          {
            schemaVersion: 1,
            sha,
            reason: 'valid reason text here',
            issuedAt,
            expiresAt,
            sha256: computeA0ReceiptDigest({ sha, issuedAt, expiresAt, reason: 'valid reason text here' }),
          },
          0o666,
        ),
        { wantValid: false },
      )
      // Case I: symlink receipt -> BOTH REJECT
      const symPath = path.join(approvalsDir, 'sym-receipt.json')
      symlinkSync(path.join(approvalsDir, `${sha}.json`), symPath)
      assertParity('symlink receipt', symPath, { wantValid: false })
      // Case J: schemaVersion = true (Python bool==int pitfall!) -> BOTH REJECT
      assertParity(
        'schemaVersion boolean true',
        writeCase('bool-schema', {
          schemaVersion: true,
          sha,
          reason: 'valid reason text here',
          issuedAt,
          expiresAt,
          sha256: computeA0ReceiptDigest({ sha, issuedAt, expiresAt, reason: 'valid reason text here' }),
        }),
        { wantValid: false },
      )
      // Case K & L: active 0600 .hmac-key -> valid HMAC passes, plain sha256 downgrade fails, 0644 key fails!
      const hmacKeyFile = path.join(ctrlDir, '.hmac-key')
      const secret = 'parity-test-hmac-secret-9876543210'
      writeFileSync(hmacKeyFile, `${secret}\n`, { mode: 0o600 })
      chmodSync(hmacKeyFile, 0o600)

      const hmacApprove = runBash(
        GOVERNOR_SH,
        [
          'approve-a0',
          '--sha',
          sha,
          '--reason',
          'HMAC sealed approval test',
          '--unsafe-test-skip-owner',
        ],
        { OC_GOVERNOR_ROOT: tmp, OC_GOVERNOR_NOW_ISO: issuedAt },
      )
      assert.equal(hmacApprove.status, 0, hmacApprove.stderr)
      const hmacDoc = JSON.parse(hmacApprove.stdout)
      assert.equal(
        hmacDoc.hmacSha256,
        computeA0ReceiptHmac({ sha, issuedAt, expiresAt, reason: 'HMAC sealed approval test' }, secret),
      )
      assertParity('valid HMAC receipt', path.join(approvalsDir, `${sha}.json`), {
        wantValid: true,
        hmacKeyFile,
      })
      assertParity(
        'plain sha256 downgrade when HMAC key active',
        writeCase('plain-downgrade', {
          schemaVersion: 1,
          sha,
          reason: 'HMAC sealed approval test',
          issuedAt,
          expiresAt,
          sha256: computeA0ReceiptDigest({ sha, issuedAt, expiresAt, reason: 'HMAC sealed approval test' }),
        }),
        { wantValid: false, hmacKeyFile },
      )
      chmodSync(hmacKeyFile, 0o644)
      assertParity('insecure 0644 HMAC key file', path.join(approvalsDir, `${sha}.json`), {
        wantValid: false,
        hmacKeyFile,
      })
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('Gate 3 (check-blast-radius): hard-rejects commercial feat/v5-aurora-rewrite, destructive DDL & billing core unless vouchered', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'oc-gov-blast-'))
    try {
      const env = { OC_GOVERNOR_ROOT: tmp, OC_GOVERNOR_NOW_ISO: '2026-11-26T12:00:00Z' }
      const repoSim = path.join(tmp, 'repo')
      const migFile = 'packages/commercial/src/db/migrations/0999_drop.sql'
      mkdirSync(path.join(repoSim, path.dirname(migFile)), { recursive: true })
      writeFileSync(path.join(repoSim, migFile), 'ALTER TABLE users DROP COLUMN legacy_flag;\n')

      // 1. Safe file on feat/v5-selfhost passes
      const safe = runBash(
        GOVERNOR_SH,
        ['check-blast-radius', '--branch', 'feat/v5-selfhost', '--files', 'packages/gateway/src/router.ts'],
        env,
      )
      assert.equal(safe.status, 0, safe.stderr)

      // 2. Commercial branch feat/v5-aurora-rewrite is unconditionally blocked!
      const aurora = runBash(
        GOVERNOR_SH,
        ['check-blast-radius', '--branch', 'feat/v5-aurora-rewrite', '--files', 'README.md'],
        env,
      )
      assert.equal(aurora.status, 1)
      assert.match(aurora.stderr, /COMMERCIAL_BRANCH_HARD_LOCK/)

      // 3. Destructive DDL migration without voucher blocked
      const ddlBlock = runBash(
        GOVERNOR_SH,
        [
          'check-blast-radius',
          '--branch',
          'feat/v5-selfhost',
          '--repo-root',
          repoSim,
          '--files',
          migFile,
        ],
        env,
      )
      assert.equal(ddlBlock.status, 1)
      assert.match(ddlBlock.stderr, /DESTRUCTIVE_DDL_LOCKED/)

      // 4. Billing core without voucher blocked
      const billingFile = 'packages/commercial/src/billing/ledger.ts'
      const billBlock = runBash(
        GOVERNOR_SH,
        ['check-blast-radius', '--branch', 'feat/v5-selfhost', '--files', billingFile],
        env,
      )
      assert.equal(billBlock.status, 1)
      assert.match(billBlock.stderr, /BILLING_CORE_LOCKED/)

      // 5. Mint dedicated voucher for ddl+billing -> allowed on feat/v5-selfhost, STILL blocked on feat/v5-aurora-rewrite!
      const voucherRes = runBash(
        GOVERNOR_SH,
        [
          'issue-blast-voucher',
          '--scope',
          'ddl+billing',
          '--files',
          migFile,
          billingFile,
          '--reason',
          'Reviewed schema cleanup & ledger alignment',
        ],
        env,
      )
      assert.equal(voucherRes.status, 0, voucherRes.stderr)
      const voucherDoc = JSON.parse(voucherRes.stdout)

      const withVoucher = runBash(
        GOVERNOR_SH,
        [
          'check-blast-radius',
          '--branch',
          'feat/v5-selfhost',
          '--repo-root',
          repoSim,
          '--files',
          migFile,
          billingFile,
          '--voucher',
          voucherDoc.id,
        ],
        env,
      )
      assert.equal(withVoucher.status, 0, withVoucher.stderr)

      const auroraEvenWithVoucher = runBash(
        GOVERNOR_SH,
        [
          'check-blast-radius',
          '--branch',
          'origin/feat/v5-aurora-rewrite',
          '--files',
          billingFile,
          '--voucher',
          voucherDoc.id,
        ],
        env,
      )
      assert.equal(auroraEvenWithVoucher.status, 1)
      assert.match(auroraEvenWithVoucher.stderr, /COMMERCIAL_BRANCH_HARD_LOCK/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('Gate 4 (dual circuit breaker, exact 5-line root-cause card, cost breaker, unlock, and status)', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'oc-gov-breaker-'))
    try {
      // Old rollback 10 days ago does not count in 7-day rolling window
      runBash(GOVERNOR_SH, ['record-rollback', '--train', 'tr-old', '--reason', 'old rollback'], {
        OC_GOVERNOR_ROOT: tmp,
        OC_GOVERNOR_NOW_ISO: '2026-11-10T00:00:00Z',
      })

      // 1st rollback in 7d -> count=1, breaker NOT tripped
      const rb1 = runBash(
        GOVERNOR_SH,
        ['record-rollback', '--train', 'tr-101', '--reason', 'smoke timeout'],
        { OC_GOVERNOR_ROOT: tmp, OC_GOVERNOR_NOW_ISO: '2026-11-25T10:00:00Z' },
      )
      assert.equal(rb1.status, 0, rb1.stderr)
      assert.equal(JSON.parse(rb1.stdout).breakerTripped, false)

      // 2nd rollback in 7d -> auto-trips to debt_first + writes exact 5-line breaker-card.md!
      const rb2 = runBash(
        GOVERNOR_SH,
        ['record-rollback', '--train', 'tr-102', '--reason', 'retention case 02 failed'],
        { OC_GOVERNOR_ROOT: tmp, OC_GOVERNOR_NOW_ISO: '2026-11-26T11:00:00Z' },
      )
      assert.equal(rb2.status, 0, rb2.stderr)
      const rb2Doc = JSON.parse(rb2.stdout)
      assert.equal(rb2Doc.rollbackCount7d, 2)
      assert.equal(rb2Doc.breakerTripped, true)

      const modeDoc = JSON.parse(readFileSync(path.join(tmp, 'control/mode.json'), 'utf8'))
      assert.equal(modeDoc.mode, 'debt_first')
      assert.equal(modeDoc.autoMergeFrozen, true)

      const cardLines = readFileSync(path.join(tmp, 'control/breaker-card.md'), 'utf8')
        .trimEnd()
        .split('\n')
      assert.equal(cardLines.length, 5, `breaker-card.md must have exactly 5 lines:\n${cardLines.join('\n')}`)
      assert.match(cardLines[1]!, /tr-102/)
      assert.match(cardLines[4]!, /unlock-breaker/)

      // Status reports all 4 gates accurately
      const st = runBash(GOVERNOR_SH, ['status'], {
        OC_GOVERNOR_ROOT: tmp,
        OC_GOVERNOR_NOW_ISO: '2026-11-26T12:00:00Z',
      })
      assert.equal(st.status, 0, st.stderr)
      const stDoc = JSON.parse(st.stdout)
      assert.equal(stDoc.gate1_mode.mode, 'debt_first')
      assert.equal(stDoc.gate4_circuit_breaker.tripped, true)
      assert.equal(stDoc.gate4_circuit_breaker.rollbackCount7d, 2)
      assert.equal(stDoc.gate4_circuit_breaker.breakerCardPresent, true)

      // Unlock restores autonomous and clears breaker card
      const unlock = runBash(
        GOVERNOR_SH,
        ['unlock-breaker', '--reason', 'Root cause fixed in OCV5-906 and retention 6/6 green'],
        { OC_GOVERNOR_ROOT: tmp, OC_GOVERNOR_NOW_ISO: '2026-11-26T13:00:00Z' },
      )
      assert.equal(unlock.status, 0, unlock.stderr)
      assert.equal(existsSync(path.join(tmp, 'control/breaker-card.md')), false)
      assert.equal(
        JSON.parse(readFileSync(path.join(tmp, 'control/mode.json'), 'utf8')).mode,
        'autonomous',
      )

      // Cost breaker check: under limit -> exit 0; over limit -> exit 1 + trips + 5-line card
      const costOk = runBash(
        GOVERNOR_SH,
        ['check-cost-breaker', '--daily-usd', '120.5', '--limit-usd', '300'],
        { OC_GOVERNOR_ROOT: tmp, OC_GOVERNOR_NOW_ISO: '2026-11-26T14:00:00Z' },
      )
      assert.equal(costOk.status, 0, costOk.stderr)

      const costTrip = runBash(
        GOVERNOR_SH,
        ['check-cost-breaker', '--daily-usd', '340.25', '--limit-usd', '300'],
        { OC_GOVERNOR_ROOT: tmp, OC_GOVERNOR_NOW_ISO: '2026-11-26T15:00:00Z' },
      )
      assert.equal(costTrip.status, 1)
      const costCardLines = readFileSync(path.join(tmp, 'control/breaker-card.md'), 'utf8')
        .trimEnd()
        .split('\n')
      assert.equal(costCardLines.length, 5)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('sync-referee.sh atomically syncs verified $MASTER_LIVE_LINK into read-only referee/ with MANIFEST.json', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'oc-sync-referee-'))
    try {
      const fakeRel = path.join(tmp, 'releases/rel-120d63ea1')
      const liveLink = path.join(tmp, 'openclaude-v5-selfhost-live')
      const govRoot = path.join(tmp, 'harness-gate')

      mkdirSync(path.join(fakeRel, 'scripts/lib'), { recursive: true })
      mkdirSync(path.join(fakeRel, 'scripts/arch-measure'), { recursive: true })
      mkdirSync(path.join(fakeRel, 'arch'), { recursive: true })
      mkdirSync(path.join(fakeRel, '.github'), { recursive: true })
      writeFileSync(path.join(fakeRel, 'scripts/check-architecture.ts'), '// gate v1\n')
      writeFileSync(path.join(fakeRel, 'scripts/arch-measure/lib.mjs'), 'export function scc() { return [] }\n')
      writeFileSync(path.join(fakeRel, 'scripts/check-v5-fix-trailers.sh'), '#!/usr/bin/env bash\necho ok\n')
      chmodSync(path.join(fakeRel, 'scripts/check-v5-fix-trailers.sh'), 0o755)
      writeFileSync(path.join(fakeRel, 'arch/modules.json'), '{"schema":1,"modules":{}}\n')
      writeFileSync(path.join(fakeRel, '.github/CODEOWNERS'), '* @owner\n')
      symlinkSync(fakeRel, liveLink)

      // Fails closed if .complete is missing
      const noComplete = runBash(SYNC_REFEREE_SH, ['--live-link', liveLink], {
        OC_GOVERNOR_ROOT: govRoot,
      })
      assert.equal(noComplete.status, 1)

      // Succeeds once verified .complete is present
      const sha1 = '120d63ea1c1278a5969a706f576c33e761f887f7'
      writeFileSync(
        path.join(fakeRel, '.complete'),
        JSON.stringify({ schemaVersion: 2, sourceCommit: sha1 }),
      )

      const sync1 = runBash(SYNC_REFEREE_SH, ['--live-link', liveLink], {
        OC_GOVERNOR_ROOT: govRoot,
      })
      assert.equal(sync1.status, 0, sync1.stderr)

      const manifestPath = path.join(govRoot, 'referee/MANIFEST.json')
      const manifest1 = JSON.parse(readFileSync(manifestPath, 'utf8'))
      assert.equal(manifest1.sourceCommit, sha1)
      assert.equal(
        manifest1.files['scripts/check-architecture.ts'],
        createHash('sha256').update('// gate v1\n', 'utf8').digest('hex'),
      )
      assert.equal(
        manifest1.files['scripts/arch-measure/lib.mjs'],
        createHash('sha256').update('export function scc() { return [] }\n', 'utf8').digest('hex'),
      )

      // Verify synced files are read-only (no write bits)
      const modeTs = statSync(path.join(govRoot, 'referee/scripts/check-architecture.ts')).mode & 0o222
      assert.equal(modeTs, 0)

      // Second sync to a newer release cleanly replaces the read-only referee directory!
      const fakeRel2 = path.join(tmp, 'releases/rel-222222222')
      mkdirSync(path.join(fakeRel2, 'scripts'), { recursive: true })
      const sha2 = '2'.repeat(40)
      writeFileSync(path.join(fakeRel2, 'scripts/check-architecture.ts'), '// gate v2\n')
      writeFileSync(
        path.join(fakeRel2, '.complete'),
        JSON.stringify({ schemaVersion: 2, sourceCommit: sha2 }),
      )
      execFileSync('ln', ['-sfn', fakeRel2, liveLink])

      const sync2 = runBash(SYNC_REFEREE_SH, ['--live-link', liveLink], {
        OC_GOVERNOR_ROOT: govRoot,
      })
      assert.equal(sync2.status, 0, sync2.stderr)
      const manifest2 = JSON.parse(readFileSync(manifestPath, 'utf8'))
      assert.equal(manifest2.sourceCommit, sha2)
      assert.equal(
        manifest2.files['scripts/check-architecture.ts'],
        createHash('sha256').update('// gate v2\n', 'utf8').digest('hex'),
      )
    } finally {
      // Ensure read-only referee dirs can be removed cleanly in test cleanup
      spawnSync('chmod', ['-R', 'u+w', tmp])
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('B1/B4 sync-referee.sh --stage-audited exports strictly from git archive targetSha, rejects dirty worktree/narrow scope, and writes TRANSITION_APPROVAL.json + MANIFEST.json', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'oc-sync-transition-'))
    try {
      const govRoot = path.join(tmp, 'harness-gate')
      const candidateSrc = path.join(tmp, 'audited-candidate')
      const liveRel = path.join(tmp, 'live-rel')
      const liveLink = path.join(tmp, 'openclaude-v5-selfhost-live')

      // Build a REAL Git repo so --stage-audited exports strictly via `git archive $targetSha`
      mkdirSync(path.join(candidateSrc, 'scripts/lib'), { recursive: true })
      mkdirSync(path.join(candidateSrc, 'scripts/arch-measure'), { recursive: true })
      mkdirSync(path.join(candidateSrc, 'packages/commercial/scripts'), { recursive: true })
      mkdirSync(path.join(candidateSrc, 'packages/protocol/src'), { recursive: true })
      mkdirSync(path.join(candidateSrc, '.github/scripts'), { recursive: true })
      writeFileSync(path.join(candidateSrc, 'scripts/check-a0-monotonic.ts'), '// audited gate v1\n')
      writeFileSync(path.join(candidateSrc, 'scripts/arch-measure/lib.mjs'), 'export function scc() { return [] }\n')
      writeFileSync(path.join(candidateSrc, 'packages/commercial/scripts/lint-demo.ts'), '// lint\n')
      writeFileSync(path.join(candidateSrc, 'packages/protocol/src/httpContracts.ts'), '// contracts\n')
      writeFileSync(path.join(candidateSrc, '.github/scripts/integ-shard-budget.ts'), '// budget\n')

      const gitEnv = {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 'test',
        GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'test',
        GIT_COMMITTER_EMAIL: 'test@example.invalid',
      }
      const git = (...args: string[]) =>
        execFileSync('git', ['-C', candidateSrc, ...args], { env: gitEnv, encoding: 'utf8' }).trim()
      git('init', '-q')
      git('add', '.')
      git('commit', '-qm', 'feat(v5): audited transition referee commit A')
      const targetSha = git('rev-parse', 'HEAD')

      // Commit B on top + DIRTY uncommitted tamper in worktree — --stage-audited for commit A MUST ignore BOTH!
      writeFileSync(path.join(candidateSrc, 'scripts/check-a0-monotonic.ts'), '// COMMIT B DIFFERENT CODE\n')
      git('commit', '-qam', 'feat(v5): unrelated commit B')
      const wrongSha = git('rev-parse', 'HEAD')
      writeFileSync(path.join(candidateSrc, 'scripts/check-a0-monotonic.ts'), '// DIRTY WORKTREE TAMPERED GATE!\n')

      // Verified live release with node_modules to be linked into transition referee
      mkdirSync(path.join(liveRel, 'node_modules/tsx'), { recursive: true })
      writeFileSync(path.join(liveRel, 'node_modules/tsx/index.js'), '// live tsx\n')
      writeFileSync(
        path.join(liveRel, '.complete'),
        JSON.stringify({ schemaVersion: 2, sourceCommit: '1'.repeat(40) }),
      )
      symlinkSync(liveRel, liveLink)

      // Issue narrow-scope A0 approval (changelog.json only) -> MUST be rejected for staging full referee!
      const env = { OC_GOVERNOR_ROOT: govRoot, OC_GOVERNOR_NOW_ISO: '2026-11-26T12:00:00Z' }
      const narrowApprove = runBash(
        GOVERNOR_SH,
        [
          'approve-a0',
          '--sha',
          targetSha,
          '--reason',
          'Narrow approval only for changelog',
          '--allowed-path',
          'changelog.json',
        ],
        env,
      )
      assert.equal(narrowApprove.status, 0, narrowApprove.stderr)
      const approvalFile = path.join(govRoot, `control/a0-approvals/${targetSha}.json`)
      const rNarrow = runBash(
        SYNC_REFEREE_SH,
        [
          '--stage-audited',
          candidateSrc,
          '--target-sha',
          targetSha,
          '--approval-file',
          approvalFile,
          '--live-link',
          liveLink,
        ],
        env,
      )
      assert.equal(rNarrow.status, 1, 'narrow allowedPaths approval MUST NOT authorize staging full transition referee')
      assert.match(rNarrow.stderr, /narrow allowedPaths approval/)

      // Issue unrestricted A0 approval for targetSha
      const approve = runBash(
        GOVERNOR_SH,
        ['approve-a0', '--sha', targetSha, '--reason', 'B1 audited schema transition rollout'],
        env,
      )
      assert.equal(approve.status, 0, approve.stderr)

      // 1. Mismatched --target-sha MUST fail closed
      const rWrongSha = runBash(
        SYNC_REFEREE_SH,
        [
          '--stage-audited',
          candidateSrc,
          '--target-sha',
          wrongSha,
          '--approval-file',
          approvalFile,
          '--live-link',
          liveLink,
        ],
        env,
      )
      assert.equal(rWrongSha.status, 1)

      // 2. Expired approval MUST fail closed
      const rExpired = runBash(
        SYNC_REFEREE_SH,
        [
          '--stage-audited',
          candidateSrc,
          '--target-sha',
          targetSha,
          '--approval-file',
          approvalFile,
          '--live-link',
          liveLink,
        ],
        { OC_GOVERNOR_ROOT: govRoot, OC_GOVERNOR_NOW_ISO: '2026-12-01T00:00:00Z' },
      )
      assert.equal(rExpired.status, 1)

      // 3. Valid --stage-audited exports strictly from git archive targetSha (ignoring commit B & dirty worktree!)
      const rOk = runBash(
        SYNC_REFEREE_SH,
        [
          '--stage-audited',
          candidateSrc,
          '--target-sha',
          targetSha,
          '--approval-file',
          approvalFile,
          '--live-link',
          liveLink,
        ],
        env,
      )
      assert.equal(rOk.status, 0, rOk.stderr)
      const refereeDir = path.join(govRoot, 'referee')
      // Verify bytes match EXACT committed object A, NOT commit B or dirty worktree!
      assert.equal(
        readFileSync(path.join(refereeDir, 'scripts/check-a0-monotonic.ts'), 'utf8'),
        '// audited gate v1\n',
        'staged transition referee MUST contain exact git object bytes of targetSha, NEVER dirty worktree or HEAD!',
      )
      const transition = JSON.parse(readFileSync(path.join(refereeDir, 'TRANSITION_APPROVAL.json'), 'utf8'))
      assert.equal(transition.mode, 'transition-audited')
      assert.equal(transition.exportMethod, 'git-archive')
      assert.equal(transition.targetSha, targetSha)
      assert.match(transition.treeSha, /^[0-9a-f]{40}$/)
      assert.equal(transition.approval.sha, targetSha)

      const manifest = JSON.parse(readFileSync(path.join(refereeDir, 'MANIFEST.json'), 'utf8'))
      assert.equal(manifest.mode, 'transition-audited')
      assert.equal(manifest.exportMethod, 'git-archive')
      assert.equal(manifest.targetSha, targetSha)
      assert.equal(manifest.treeSha, transition.treeSha)
      assert.ok(manifest.files['TRANSITION_APPROVAL.json'])
      assert.ok(manifest.files['scripts/arch-measure/lib.mjs'])
      assert.ok(manifest.files['.github/scripts/integ-shard-budget.ts'])
      assert.ok(manifest.files['packages/protocol/src/httpContracts.ts'])
      assert.ok(existsSync(path.join(refereeDir, 'node_modules/tsx/index.js')))
    } finally {
      spawnSync('chmod', ['-R', 'u+w', tmp])
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('OCV5-914 Gate 3 semantic noise reduction (B1/B2/B3/B6): mutual-exclusive classification, mandatory HMAC authoritative steward, AST pure-type/comment whitelist, expanded core, NUL paths, bound vouchers', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'oc-gov-semantic-'))
    try {
      const govRoot = path.join(tmp, 'harness-gate')
      const ctrlDir = path.join(govRoot, 'control')
      const stewardDir = path.join(govRoot, 'steward-receipts')
      const repoDir = path.join(tmp, 'repo')
      mkdirSync(ctrlDir, { recursive: true })
      mkdirSync(stewardDir, { recursive: true })
      mkdirSync(path.join(repoDir, 'packages/commercial/src/billing/__tests__'), { recursive: true })
      mkdirSync(path.join(repoDir, 'packages/commercial/src/payment'), { recursive: true })

      const hmacSecret = 'ocv5-914-steward-hmac-secret-key-0123456789'
      const hmacPath = path.join(ctrlDir, '.hmac-key')
      writeFileSync(hmacPath, `${hmacSecret}\n`, { mode: 0o600 })
      chmodSync(hmacPath, 0o600)

      const gitEnv = {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 'test',
        GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'test',
        GIT_COMMITTER_EMAIL: 'test@example.invalid',
      }
      const git = (...args: string[]) =>
        execFileSync('git', ['-C', repoDir, ...args], { env: gitEnv, encoding: 'utf8' }).trim()
      git('init', '-q', '-b', 'feat/v5-selfhost')
      writeFileSync(
        path.join(repoDir, 'packages/commercial/src/billing/modelPublicProjection.ts'),
        'export function formatPublicProjection(x: number): string {\n  return String(x)\n}\n',
      )
      writeFileSync(
        path.join(repoDir, 'packages/commercial/src/billing/remoteDriverReceiptV5.ts'),
        'export const JOURNAL_WRITER = 1\n',
      )
      writeFileSync(
        path.join(repoDir, 'packages/commercial/src/billing/remoteDriverTurnBilling.ts'),
        'export const WAIVE_ZERO_OUTPUT = true\n',
      )
      writeFileSync(
        path.join(repoDir, 'packages/commercial/src/billing/codexServiceTierPricing.ts'),
        'export const TIER_MULTIPLIER = 1.5\n',
      )
      mkdirSync(path.join(repoDir, 'packages/protocol/src'), { recursive: true })
      writeFileSync(
        path.join(repoDir, 'packages/protocol/src/serviceTiers.ts'),
        'export const FAST_MULTIPLIER = 2\n',
      )
      writeFileSync(path.join(repoDir, 'packages/commercial/src/billing/ledger.ts'), 'export const LEDGER = 1\n')
      writeFileSync(path.join(repoDir, 'packages/commercial/src/billing/antigravitySettle.ts'), 'export const SETTLE = 1\n')
      writeFileSync(path.join(repoDir, 'packages/commercial/src/billing/modelSwitchCostPolicy.ts'), 'export const COST = 1\n')
      writeFileSync(path.join(repoDir, 'packages/commercial/src/payment/orders.ts'), 'export const ORDER = 1\n')
      git('add', '.')
      git('commit', '-qm', 'chore(v5): base')
      const baseSha = git('rev-parse', 'HEAD')

      const writeSignedSteward = (
        headSha: string,
        opts: {
          verdict?: 'approve' | 'veto'
          hmacKey?: string
          baseSha?: string
          dryRun?: boolean
          sameFamily?: boolean
          spoofedFamily?: boolean
        } = {},
      ) => {
        const unsigned = {
          schemaVersion: ARCH_STEWARD_RECEIPT_SCHEMA_VERSION,
          headSha,
          baseSha: opts.baseSha ?? baseSha,
          authorModel: 'claude-opus-4-6',
          authorFamily: (opts.spoofedFamily ? 'openai-gpt' : 'anthropic-claude') as 'anthropic-claude' | 'openai-gpt',
          stewardModel: opts.sameFamily ? 'claude-sonnet-4-6' : 'gpt-5.4',
          stewardFamily: (opts.sameFamily ? 'anthropic-claude' : 'openai-gpt') as 'anthropic-claude' | 'openai-gpt',
          verdict: opts.verdict ?? 'approve',
          triggers: ['CLONE_OR_T2_CORE_PATH' as const],
          dimensions: {
            godClassAppend: { status: 'pass' as const, notes: 'clean' },
            wheelReinvention: { status: 'pass' as const, notes: 'clean' },
            boundaryIntegrity: { status: 'pass' as const, notes: 'clean' },
            complexityDrift: { status: 'pass' as const, notes: 'clean' },
          },
          blockers: [],
          usageEvidence: {
            jobId: 'job-914-real',
            timestamp: '2026-11-27T01:00:00Z',
          },
        }
        const signed = signArchStewardReceipt(unsigned, opts.hmacKey)
        const doc: Record<string, unknown> = { ...signed }
        if (opts.dryRun) doc.dryRun = true
        const p = path.join(stewardDir, `${headSha}.json`)
        writeFileSync(p, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o644 })
        chmodSync(p, 0o644)
        return p
      }

      const env = {
        OC_GOVERNOR_ROOT: govRoot,
        OC_GOVERNOR_NOW_ISO: '2026-11-27T02:00:00Z',
        OC_GOVERNOR_STEWARD_VERIFIER: path.join(REPO_ROOT, 'scripts/lib/archStewardReceipt.ts'),
      }

      // 0. Commercial branch -> classification=absolute_reject
      const auroraRes = runBash(
        GOVERNOR_SH,
        ['check-blast-radius', '--branch', 'feat/v5-aurora-rewrite', '--files', 'README.md'],
        env,
      )
      assert.equal(auroraRes.status, 1)
      const auroraDoc = JSON.parse(auroraRes.stderr)
      assert.equal(auroraDoc.code, 'COMMERCIAL_BRANCH_HARD_LOCK')
      assert.equal(auroraDoc.classification, 'absolute_reject')

      // 1. Default-protect ALL billing/payment code: pure *.test.*/*.spec.* auto_pass; ONLY explicitly allowlisted pure helpers (e.g. remoteDriverReceiptV5.ts, usageReport.ts) auto_pass!
      const pureTests = runBash(
        GOVERNOR_SH,
        [
          'check-blast-radius',
          '--branch',
          'feat/v5-selfhost',
          '--files',
          'packages/commercial/src/billing/__tests__/ledger.test.ts',
          'packages/commercial/src/billing/boxBillingRecovery.test.ts',
          'packages/commercial/src/payment/orders.spec.ts',
        ],
        env,
      )
      assert.equal(pureTests.status, 0, pureTests.stderr)
      assert.equal(JSON.parse(pureTests.stdout).classification, 'auto_pass')

      const nonCoreHelpers = runBash(
        GOVERNOR_SH,
        [
          'check-blast-radius',
          '--branch',
          'feat/v5-selfhost',
          '--files',
          'packages/commercial/src/billing/modelPublicProjection.ts',
          'packages/commercial/src/billing/usageReport.ts',
        ],
        env,
      )
      assert.equal(nonCoreHelpers.status, 0, nonCoreHelpers.stderr)
      const ncDoc = JSON.parse(nonCoreHelpers.stdout)
      assert.equal(ncDoc.ok, true)
      assert.equal(ncDoc.classification, 'auto_pass')
      assert.equal(ncDoc.autoApprovedNonCoreBilling, true)
      assert.deepEqual(ncDoc.nonCoreBillingFiles, [
        'packages/commercial/src/billing/modelPublicProjection.ts',
        'packages/commercial/src/billing/usageReport.ts',
      ])
      const ncAudits = readFileSync(path.join(ctrlDir, 'audit.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
      assert.ok(ncAudits.some((ev) => ev.action === 'check_blast_radius' && ev.outcome === 'ok_auto_noncore_billing'))

      // 2. Allowlisted pure display helper with runtime edit -> direct auto_pass;
      //    real billing decision & pricing source files (remoteDriverTurnBilling.ts, remoteDriverReceiptV5.ts, codexServiceTierPricing.ts, serviceTiers.ts) -> BILLING_CORE_LOCKED!
      writeFileSync(
        path.join(repoDir, 'packages/commercial/src/billing/modelPublicProjection.ts'),
        'export const PROJECTION_HEADER = "x-openclaude"\nexport function formatPublicProjection(x: number): string {\n  return String(x)\n}\n',
      )
      git('commit', '-qam', 'fix(v5): runtime edit in allowlisted pure display helper')
      const runtimeNonCoreSha = git('rev-parse', 'HEAD')
      const okRuntimeNonCore = runBash(
        GOVERNOR_SH,
        [
          'check-blast-radius',
          '--branch',
          'feat/v5-selfhost',
          '--repo-root',
          repoDir,
          '--sha',
          runtimeNonCoreSha,
          '--base-ref',
          baseSha,
          '--files',
          'packages/commercial/src/billing/modelPublicProjection.ts',
        ],
        env,
      )
      assert.equal(okRuntimeNonCore.status, 0, okRuntimeNonCore.stderr)
      const okNcDoc = JSON.parse(okRuntimeNonCore.stdout)
      assert.equal(okNcDoc.classification, 'auto_pass')
      assert.equal(okNcDoc.autoApprovedNonCoreBilling, true)

      // 2b. BLOCKER 1 + R2 #1: pricing sources & journal writers MUST be blocked (even if candidate tampers its own arch/a0-protected-paths.json)!
      git('checkout', '-q', baseSha)
      writeFileSync(
        path.join(repoDir, 'packages/commercial/src/billing/remoteDriverTurnBilling.ts'),
        'export const WAIVE_ZERO_OUTPUT = false\n',
      )
      writeFileSync(
        path.join(repoDir, 'packages/commercial/src/billing/remoteDriverReceiptV5.ts'),
        'export const JOURNAL_WRITER = 2\n',
      )
      writeFileSync(
        path.join(repoDir, 'packages/commercial/src/billing/codexServiceTierPricing.ts'),
        'export const TIER_MULTIPLIER = 2.0\n',
      )
      writeFileSync(
        path.join(repoDir, 'packages/protocol/src/serviceTiers.ts'),
        'export const FAST_MULTIPLIER = 3\n',
      )
      mkdirSync(path.join(repoDir, 'arch'), { recursive: true })
      writeFileSync(
        path.join(repoDir, 'arch/a0-protected-paths.json'),
        JSON.stringify({
          schemaVersion: 1,
          billingNonCoreAllowlist: [
            'packages/commercial/src/billing/remoteDriverTurnBilling.ts',
            'packages/commercial/src/billing/remoteDriverReceiptV5.ts',
            'packages/commercial/src/billing/codexServiceTierPricing.ts',
          ],
        }),
      )
      git('add', '.')
      git('commit', '-qam', 'feat(v5): change waiver, journal writer & tier multiplier source with candidate policy tamper')
      const b1RuntimeSha = git('rev-parse', 'HEAD')
      for (const b1File of [
        'packages/commercial/src/billing/remoteDriverTurnBilling.ts',
        'packages/commercial/src/billing/remoteDriverReceiptV5.ts',
        'packages/commercial/src/billing/codexServiceTierPricing.ts',
        'packages/protocol/src/serviceTiers.ts',
      ]) {
        const res = runBash(
          GOVERNOR_SH,
          [
            'check-blast-radius',
            '--branch',
            'feat/v5-selfhost',
            '--repo-root',
            repoDir,
            '--sha',
            b1RuntimeSha,
            '--base-ref',
            baseSha,
            '--files',
            b1File,
          ],
          env,
        )
        assert.equal(res.status, 1, `BLOCKER 1: ${b1File} runtime edit MUST be blocked as BILLING_CORE_LOCKED`)
        const errDoc = JSON.parse(res.stderr)
        assert.equal(errDoc.classification, 'human_review_required')
        assert.equal(errDoc.code, 'BILLING_CORE_LOCKED')
        assert.equal(errDoc.riskCategory, 'billing_change')
        assert.deepEqual(errDoc.coreBillingFiles, [b1File])
      }

      // 3. Core billing/payment TS files with PURE comments / type declarations (zero runtime JS diff) -> auto_pass (semanticNoRuntimeBillingChange: true)!
      git('checkout', '-q', baseSha)
      writeFileSync(
        path.join(repoDir, 'packages/commercial/src/billing/modelSwitchCostPolicy.ts'),
        '// Pure doc comment\nexport type CostHint = { id: string }\nexport const COST = 1\n',
      )
      writeFileSync(path.join(repoDir, 'packages/commercial/src/billing/ledger.ts'), '// comment\nexport type LedgerMeta = { v: number }\nexport const LEDGER = 1\n')
      writeFileSync(path.join(repoDir, 'packages/commercial/src/billing/antigravitySettle.ts'), '// comment\nexport const SETTLE = 1\n')
      writeFileSync(path.join(repoDir, 'packages/commercial/src/payment/orders.ts'), '// comment\nexport const ORDER = 1\n')
      git('commit', '-qam', 'docs(v5): pure comments and types in core billing/payment')
      const coreTypeOnlySha = git('rev-parse', 'HEAD')
      for (const coreFile of [
        'packages/commercial/src/billing/modelSwitchCostPolicy.ts',
        'packages/commercial/src/billing/ledger.ts',
        'packages/commercial/src/billing/antigravitySettle.ts',
        'packages/commercial/src/payment/orders.ts',
      ]) {
        const res = runBash(
          GOVERNOR_SH,
          [
            'check-blast-radius',
            '--branch',
            'feat/v5-selfhost',
            '--repo-root',
            repoDir,
            '--sha',
            coreTypeOnlySha,
            '--base-ref',
            baseSha,
            '--files',
            coreFile,
          ],
          env,
        )
        assert.equal(res.status, 0, `${coreFile} pure comment/type edit should auto_pass: ${res.stderr}`)
        const okDoc = JSON.parse(res.stdout)
        assert.equal(okDoc.classification, 'auto_pass')
        assert.equal(okDoc.semanticNoRuntimeBillingChange, true)
      }

      // 4. Core billing/payment files with REAL runtime code changes -> human_review_required (code=BILLING_CORE_LOCKED, riskCategory=billing_change) even with HMAC steward!
      git('checkout', '-q', baseSha)
      writeFileSync(path.join(repoDir, 'packages/commercial/src/billing/modelSwitchCostPolicy.ts'), 'export const COST = 2\n')
      writeFileSync(path.join(repoDir, 'packages/commercial/src/billing/ledger.ts'), 'export const LEDGER = 2\n')
      writeFileSync(path.join(repoDir, 'packages/commercial/src/billing/antigravitySettle.ts'), 'export const SETTLE = 2\n')
      writeFileSync(path.join(repoDir, 'packages/commercial/src/payment/orders.ts'), 'export const ORDER = 2\n')
      git('commit', '-qam', 'feat(v5): adjust core billing pricing & payment runtime logic')
      const coreSha = git('rev-parse', 'HEAD')
      writeSignedSteward(coreSha, { hmacKey: hmacSecret })
      for (const coreFile of [
        'packages/commercial/src/billing/modelSwitchCostPolicy.ts',
        'packages/commercial/src/billing/ledger.ts',
        'packages/commercial/src/billing/antigravitySettle.ts',
        'packages/commercial/src/payment/orders.ts',
      ]) {
        const res = runBash(
          GOVERNOR_SH,
          [
            'check-blast-radius',
            '--branch',
            'feat/v5-selfhost',
            '--repo-root',
            repoDir,
            '--sha',
            coreSha,
            '--base-ref',
            baseSha,
            '--files',
            coreFile,
          ],
          env,
        )
        assert.equal(res.status, 1, `${coreFile} runtime edit MUST be human_review_required`)
        const errDoc = JSON.parse(res.stderr)
        assert.equal(errDoc.classification, 'human_review_required')
        assert.equal(errDoc.code, 'BILLING_CORE_LOCKED')
        assert.equal(errDoc.riskCategory, 'billing_change')
        assert.deepEqual(errDoc.coreBillingFiles, [coreFile])
      }

      // 5. Empty file list with --sha when commit actually has changes -> fail-closed!
      const emptyFilesRes = runBash(
        GOVERNOR_SH,
        ['check-blast-radius', '--branch', 'feat/v5-selfhost', '--repo-root', repoDir, '--sha', coreSha, '--base-ref', baseSha],
        env,
      )
      assert.equal(emptyFilesRes.status, 1)
      assert.equal(JSON.parse(emptyFilesRes.stderr).code, 'EMPTY_FILE_LIST_MISMATCH')

      // 6. B6: Bound blast voucher enforces exact SHA & branch, and rejects commercial branch on issue!
      const auroraVoucher = runBash(
        GOVERNOR_SH,
        [
          'issue-blast-voucher',
          '--scope',
          'billing',
          '--branch',
          'feat/v5-aurora-rewrite',
          '--files',
          'packages/commercial/src/billing/ledger.ts',
          '--reason',
          'must be blocked on commercial branch',
        ],
        env,
      )
      assert.notEqual(auroraVoucher.status, 0)
      assert.match(auroraVoucher.stderr, /COMMERCIAL_BRANCH_HARD_LOCK/)

      const boundVoucherRes = runBash(
        GOVERNOR_SH,
        [
          'issue-blast-voucher',
          '--scope',
          'billing',
          '--sha',
          coreSha,
          '--branch',
          'feat/v5-selfhost',
          '--approval-id',
          'gov-billing-boundtest001',
          '--files',
          'packages/commercial/src/billing/ledger.ts',
          '--reason',
          'Bound to exact coreSha on selfhost',
        ],
        env,
      )
      assert.equal(boundVoucherRes.status, 0, boundVoucherRes.stderr)
      const boundVoucher = JSON.parse(boundVoucherRes.stdout)
      assert.equal(boundVoucher.sha, coreSha)
      assert.equal(boundVoucher.branch, 'feat/v5-selfhost')

      // Matching SHA + branch -> PASS
      const boundOk = runBash(
        GOVERNOR_SH,
        [
          'check-blast-radius',
          '--branch',
          'feat/v5-selfhost',
          '--repo-root',
          repoDir,
          '--sha',
          coreSha,
          '--base-ref',
          baseSha,
          '--voucher',
          boundVoucher.id,
          '--files',
          'packages/commercial/src/billing/ledger.ts',
        ],
        env,
      )
      assert.equal(boundOk.status, 0, boundOk.stderr)

      // Different SHA -> VOUCHER_SHA_MISMATCH!
      const wrongShaVoucher = runBash(
        GOVERNOR_SH,
        [
          'check-blast-radius',
          '--branch',
          'feat/v5-selfhost',
          '--repo-root',
          repoDir,
          '--sha',
          runtimeNonCoreSha,
          '--base-ref',
          baseSha,
          '--voucher',
          boundVoucher.id,
          '--files',
          'packages/commercial/src/billing/ledger.ts',
        ],
        env,
      )
      assert.equal(wrongShaVoucher.status, 1)
      assert.equal(JSON.parse(wrongShaVoucher.stderr).code, 'VOUCHER_SHA_MISMATCH')

      // Different branch -> VOUCHER_BRANCH_MISMATCH!
      const wrongBranchVoucher = runBash(
        GOVERNOR_SH,
        [
          'check-blast-radius',
          '--branch',
          'feat/other-branch',
          '--repo-root',
          repoDir,
          '--sha',
          coreSha,
          '--base-ref',
          baseSha,
          '--voucher',
          boundVoucher.id,
          '--files',
          'packages/commercial/src/billing/ledger.ts',
        ],
        env,
      )
      assert.equal(wrongBranchVoucher.status, 1)
      assert.equal(JSON.parse(wrongBranchVoucher.stderr).code, 'VOUCHER_BRANCH_MISMATCH')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('OCV5-914 Gate 3b atomic single-writer (B4/B5/B6/NB6): create-only idempotency, 2-process concurrent decide flock, A0 allowed-path binding, resume updates, rollback/reconcile, tripped breaker mode guard', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'oc-gov-pending-'))
    try {
      const govRoot = path.join(tmp, 'harness-gate')
      const ctrlDir = path.join(govRoot, 'control')
      const stewardDir = path.join(govRoot, 'steward-receipts')
      mkdirSync(ctrlDir, { recursive: true })
      mkdirSync(stewardDir, { recursive: true })

      const hmacSecret = 'pending-approval-hmac-secret-914'
      const hmacPath = path.join(ctrlDir, '.hmac-key')
      writeFileSync(hmacPath, `${hmacSecret}\n`, { mode: 0o600 })
      chmodSync(hmacPath, 0o600)

      const sha = 'a'.repeat(40)
      const baseSha = 'b'.repeat(40)
      const signedSteward = signArchStewardReceipt(
        {
          schemaVersion: ARCH_STEWARD_RECEIPT_SCHEMA_VERSION,
          headSha: sha,
          baseSha,
          authorModel: 'claude-opus-4-6',
          authorFamily: 'anthropic-claude',
          stewardModel: 'gpt-5.4',
          stewardFamily: 'openai-gpt',
          verdict: 'approve',
          triggers: ['CLONE_OR_T2_CORE_PATH'],
          dimensions: {
            godClassAppend: { status: 'pass', notes: 'ok' },
            wheelReinvention: { status: 'pass', notes: 'ok' },
            boundaryIntegrity: { status: 'pass', notes: 'ok' },
            complexityDrift: { status: 'pass', notes: 'ok' },
          },
          blockers: [],
          usageEvidence: { jobId: 'job-steward-914', timestamp: '2026-11-27T01:30:00Z' },
        },
        hmacSecret,
      )
      writeFileSync(path.join(stewardDir, `${sha}.json`), `${JSON.stringify(signedSteward, null, 2)}\n`, { mode: 0o644 })

      const env = {
        OC_GOVERNOR_ROOT: govRoot,
        OC_GOVERNOR_NOW_ISO: '2026-11-27T02:00:00Z',
        OC_GOVERNOR_STEWARD_VERIFIER: path.join(REPO_ROOT, 'scripts/lib/archStewardReceipt.ts'),
        OC_GOVERNOR_UNSAFE_TEST_SKIP_OWNER: '1',
      }

      // 1. Path traversal / invalid ID, commercial branch, and absolute_reject MUST be rejected
      for (const badId of ['../escape', 'gov-../x', 'bad-id-1234', 'gov-ab', 'gov-UPPERCASE']) {
        const bad = runBash(
          GOVERNOR_SH,
          ['record-pending-approval', '--id', badId, '--kind', 'blast_voucher', '--code', 'BILLING_CORE_LOCKED', '--branch', 'feat/v5-selfhost'],
          env,
        )
        assert.notEqual(bad.status, 0, `invalid id ${badId} MUST fail`)
      }
      const auroraRec = runBash(
        GOVERNOR_SH,
        [
          'record-pending-approval',
          '--id',
          'gov-billing-aurora000001',
          '--kind',
          'blast_voucher',
          '--code',
          'BILLING_CORE_LOCKED',
          '--branch',
          'feat/v5-aurora-rewrite',
          '--files',
          'packages/commercial/src/billing/ledger.ts',
        ],
        env,
      )
      assert.notEqual(auroraRec.status, 0)
      assert.match(auroraRec.stderr, /COMMERCIAL_BRANCH_HARD_LOCK/)

      const absRec = runBash(
        GOVERNOR_SH,
        [
          'record-pending-approval',
          '--id',
          'gov-billing-absrej000001',
          '--kind',
          'blast_voucher',
          '--code',
          'COMMERCIAL_BRANCH_HARD_LOCK',
          '--classification',
          'absolute_reject',
          '--branch',
          'feat/v5-selfhost',
        ],
        env,
      )
      assert.notEqual(absRec.status, 0)
      assert.match(absRec.stderr, /ABSOLUTE_REJECT_FORBIDDEN/)

      // 2. Create-only idempotency on pending approval: second call at later timestamp MUST NOT overwrite title or refresh TTL!
      // B2: Pass explicit --base-ref when running outside a git repo so authoritative steward verification binds exact baseSha.
      const rec1 = runBash(
        GOVERNOR_SH,
        [
          'record-pending-approval',
          '--id',
          'gov-billing-aaaaaaaaaaaa',
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
          '--train',
          'tr-914-01',
          '--ticket',
          'OCV5-914',
          '--total-files',
          '5',
          '--files',
          'packages/commercial/src/billing/ledger.ts',
        ],
        env,
      )
      assert.equal(rec1.status, 0, rec1.stderr)
      const doc1 = JSON.parse(rec1.stdout)
      assert.equal(doc1.version, 1)
      assert.equal(doc1.classification, 'human_review_required')
      assert.equal(doc1.riskCategory, 'billing_change')
      assert.equal(doc1.title, '计费规则变更，需要你确认')
      assert.equal(typeof doc1.whatChanged, 'string')
      assert.ok(doc1.whatChanged.length > 0)
      assert.match(doc1.whyNeedYou, /计费方式/)
      assert.doesNotMatch(doc1.whyNeedYou, /HMAC|AST|签发绑定凭证/)
      assert.equal(doc1.recommendation.action, 'approve')
      assert.equal(doc1.recommendation.label, '建议批准')
      assert.equal(doc1.stewardVerdict.verdict, 'approve')
      assert.equal(doc1.stewardVerdict.hmacVerified, true)

      const rec1Again = runBash(
        GOVERNOR_SH,
        [
          'record-pending-approval',
          '--id',
          'gov-billing-aaaaaaaaaaaa',
          '--kind',
          'blast_voucher',
          '--code',
          'BILLING_CORE_LOCKED',
          '--branch',
          'feat/v5-selfhost',
          '--title',
          'SHOULD NOT OVERWRITE',
          '--ttl-hours',
          '48',
        ],
        { ...env, OC_GOVERNOR_NOW_ISO: '2026-11-27T05:00:00Z' },
      )
      assert.equal(rec1Again.status, 0, rec1Again.stderr)
      const doc1Again = JSON.parse(rec1Again.stdout)
      assert.equal(doc1Again.expiresAt, doc1.expiresAt, 'create-only record MUST NOT refresh TTL')
      assert.equal(doc1Again.title, doc1.title, 'create-only record MUST NOT overwrite existing pending record')
      assert.equal(doc1Again.sha256, doc1.sha256)

      // 3. Optimistic lock mismatch rejected cleanly
      const badVer = runBash(
        GOVERNOR_SH,
        [
          'decide-pending-approval',
          '--id',
          'gov-billing-aaaaaaaaaaaa',
          '--decision',
          'approve',
          '--actor',
          'admin-uid3',
          '--expected-version',
          '99',
        ],
        env,
      )
      assert.notEqual(badVer.status, 0)
      assert.match(badVer.stderr, /CONFLICT_VERSION_MISMATCH/)

      // 4. Real 2-process concurrent decide-pending-approval under per-ID flock -> EXACTLY 1 wins, 1 conflicts, ONLY 1 voucher!
      const spawnAsync = (args: string[]) =>
        new Promise<{ status: number; stdout: string; stderr: string }>((resolve, reject) => {
          const child = spawn('bash', [GOVERNOR_SH, ...args], {
            env: { ...process.env, ...env },
            stdio: ['ignore', 'pipe', 'pipe'],
          })
          let stdout = ''
          let stderr = ''
          child.stdout.setEncoding('utf8')
          child.stderr.setEncoding('utf8')
          child.stdout.on('data', (d) => { stdout += d })
          child.stderr.on('data', (d) => { stderr += d })
          child.on('error', reject)
          child.on('close', (code) => resolve({ status: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() }))
        })

      const [c1, c2] = await Promise.all([
        spawnAsync([
          'decide-pending-approval',
          '--id',
          'gov-billing-aaaaaaaaaaaa',
          '--decision',
          'approve',
          '--actor',
          'admin-proc-1',
          '--expected-version',
          '1',
          '--expected-sha256',
          doc1.sha256,
          '--note',
          'Concurrent race A',
        ]),
        spawnAsync([
          'decide-pending-approval',
          '--id',
          'gov-billing-aaaaaaaaaaaa',
          '--decision',
          'approve',
          '--actor',
          'admin-proc-2',
          '--expected-version',
          '1',
          '--expected-sha256',
          doc1.sha256,
          '--note',
          'Concurrent race B',
        ]),
      ])
      const winners = [c1, c2].filter((r) => r.status === 0)
      const losers = [c1, c2].filter((r) => r.status !== 0)
      assert.equal(winners.length, 1, `expected exactly 1 concurrent winner: c1=${c1.status}/${c1.stderr} c2=${c2.status}/${c2.stderr}`)
      assert.equal(losers.length, 1)
      assert.match(losers[0]!.stderr, /ALREADY_RESOLVED|CONFLICT_VERSION_MISMATCH|CONFLICT_SHA256_MISMATCH/)
      const winDoc = JSON.parse(winners[0]!.stdout)
      assert.equal(winDoc.status, 'approved')
      assert.equal(winDoc.version, 2)
      assert.equal(winDoc.decision.resumeStatus, 'not_started')
      assert.match(winDoc.decision.issuedArtifactId, /^bv-[0-9a-f]{16}$/)
      const voucherFiles = readdirSync(path.join(ctrlDir, 'blast-vouchers')).filter((f) => f.endsWith('.json'))
      assert.equal(voucherFiles.length, 1, 'concurrent race MUST mint exactly ONE voucher artifact')
      const mintedVoucher = JSON.parse(readFileSync(path.join(ctrlDir, 'blast-vouchers', voucherFiles[0]!), 'utf8'))
      assert.equal(mintedVoucher.sha, sha)
      assert.equal(mintedVoucher.branch, 'feat/v5-selfhost')
      assert.equal(mintedVoucher.approvalId, 'gov-billing-aaaaaaaaaaaa')

      // 5. update-approval-resume updates approved record & increments version
      const resBusy = runBash(
        GOVERNOR_SH,
        [
          'update-approval-resume',
          '--id',
          'gov-billing-aaaaaaaaaaaa',
          '--status',
          'not_started_busy',
          '--detail',
          'deploy lock held by active train',
        ],
        env,
      )
      assert.equal(resBusy.status, 0, resBusy.stderr)
      const busyDoc = JSON.parse(resBusy.stdout)
      assert.equal(busyDoc.version, 3)
      assert.equal(busyDoc.decision.resumeStatus, 'not_started_busy')

      const resStarted = runBash(
        GOVERNOR_SH,
        [
          'update-approval-resume',
          '--id',
          'gov-billing-aaaaaaaaaaaa',
          '--status',
          'started',
          '--unit',
          'oc-v5-gov-resume-01',
          '--detail',
          'systemd unit started',
        ],
        env,
      )
      assert.equal(resStarted.status, 0, resStarted.stderr)
      assert.equal(JSON.parse(resStarted.stdout).version, 4)
      assert.equal(JSON.parse(resStarted.stdout).decision.resumeUnit, 'oc-v5-gov-resume-01')

      // 6. A0 approval: enforces per-file --allowed-path binding, and rejects empty files without --allow-whole-commit!
      const a0Sha = 'e'.repeat(40)
      const recA0Scoped = runBash(
        GOVERNOR_SH,
        [
          'record-pending-approval',
          '--id',
          'gov-a0-scoped000001',
          '--kind',
          'a0_approval',
          '--code',
          'A0_RELAXATION_REQUIRED',
          '--branch',
          'feat/v5-selfhost',
          '--sha',
          a0Sha,
          '--files',
          'arch/a0-protected-paths.json',
        ],
        env,
      )
      assert.equal(recA0Scoped.status, 0, recA0Scoped.stderr)
      const decA0Scoped = runBash(
        GOVERNOR_SH,
        [
          'decide-pending-approval',
          '--id',
          'gov-a0-scoped000001',
          '--decision',
          'approve',
          '--actor',
          'admin-uid3',
          '--note',
          'Approve single A0 manifest edit',
        ],
        env,
      )
      assert.equal(decA0Scoped.status, 0, decA0Scoped.stderr)
      const a0Doc = JSON.parse(readFileSync(path.join(ctrlDir, `a0-approvals/${a0Sha}.json`), 'utf8'))
      assert.deepEqual(a0Doc.allowedPaths, ['arch/a0-protected-paths.json'], 'A0 approval MUST bind exact allowedPaths, never silent wildcard *')

      const a0WholeSha = 'f'.repeat(40)
      const recA0Empty = runBash(
        GOVERNOR_SH,
        [
          'record-pending-approval',
          '--id',
          'gov-a0-whole0000001',
          '--kind',
          'a0_approval',
          '--code',
          'A0_RELAXATION_REQUIRED',
          '--branch',
          'feat/v5-selfhost',
          '--sha',
          a0WholeSha,
        ],
        env,
      )
      assert.equal(recA0Empty.status, 0, recA0Empty.stderr)
      const decA0EmptyDenied = runBash(
        GOVERNOR_SH,
        ['decide-pending-approval', '--id', 'gov-a0-whole0000001', '--decision', 'approve', '--actor', 'admin-uid3'],
        env,
      )
      assert.notEqual(decA0EmptyDenied.status, 0)
      assert.match(decA0EmptyDenied.stderr, /A0_WHOLE_COMMIT_CONFIRM_REQUIRED/)

      // 7. Pre-mint failure rolls back to pending with lastError; post-mint failure records reconcile_required!
      const recFail = runBash(
        GOVERNOR_SH,
        [
          'record-pending-approval',
          '--id',
          'gov-billing-failtest001',
          '--kind',
          'blast_voucher',
          '--code',
          'BILLING_CORE_LOCKED',
          '--branch',
          'feat/v5-selfhost',
          '--sha',
          'c'.repeat(40),
          '--files',
          'packages/commercial/src/billing/ledger.ts',
        ],
        env,
      )
      assert.equal(recFail.status, 0, recFail.stderr)

      const preFail = runBash(
        GOVERNOR_SH,
        ['decide-pending-approval', '--id', 'gov-billing-failtest001', '--decision', 'approve', '--actor', 'admin-uid3'],
        { ...env, OC_GOVERNOR_TEST_FAIL_BEFORE_MINT: '1' },
      )
      assert.notEqual(preFail.status, 0)
      assert.match(preFail.stderr, /ARTIFACT_MINT_FAILED/)
      const rolledBack = JSON.parse(readFileSync(path.join(ctrlDir, 'pending-approvals/gov-billing-failtest001.json'), 'utf8'))
      assert.equal(rolledBack.status, 'pending')
      assert.match(rolledBack.lastError, /simulated pre-mint failure/)

      const postFail = runBash(
        GOVERNOR_SH,
        ['decide-pending-approval', '--id', 'gov-billing-failtest001', '--decision', 'approve', '--actor', 'admin-uid3'],
        { ...env, OC_GOVERNOR_TEST_FAIL_AFTER_MINT: '1' },
      )
      assert.notEqual(postFail.status, 0)
      assert.match(postFail.stderr, /RECONCILE_REQUIRED/)
      const reconciled = JSON.parse(readFileSync(path.join(ctrlDir, 'pending-approvals/gov-billing-failtest001.json'), 'utf8'))
      assert.equal(reconciled.status, 'reconcile_required')
      assert.match(reconciled.decision.issuedArtifactId, /^bv-[0-9a-f]{16}$/)

      // 8. NB6-host: tripped circuit breaker rejects 'mode autonomous' with BREAKER_TRIPPED_USE_UNLOCK,
      // and breaker_unlock approval requires >= 8 char note!
      const trip = runBash(GOVERNOR_SH, ['trip-breaker', '--train', 'tr-nb6', '--reason', 'retention regression'], env)
      assert.equal(trip.status, 0, trip.stderr)
      const badAuto = runBash(GOVERNOR_SH, ['mode', 'autonomous', '--reason', 'try bypass breaker'], env)
      assert.notEqual(badAuto.status, 0)
      assert.match(badAuto.stderr, /BREAKER_TRIPPED_USE_UNLOCK/)

      const recUnlock = runBash(
        GOVERNOR_SH,
        [
          'record-pending-approval',
          '--id',
          'gov-breaker-unlock0001',
          '--kind',
          'breaker_unlock',
          '--code',
          'CIRCUIT_BREAKER_TRIPPED',
          '--branch',
          'feat/v5-selfhost',
        ],
        env,
      )
      assert.equal(recUnlock.status, 0, recUnlock.stderr)
      const shortNoteUnlock = runBash(
        GOVERNOR_SH,
        ['decide-pending-approval', '--id', 'gov-breaker-unlock0001', '--decision', 'approve', '--actor', 'admin-uid3', '--note', 'short'],
        env,
      )
      assert.notEqual(shortNoteUnlock.status, 0)
      assert.match(shortNoteUnlock.stderr, /REASON_TOO_SHORT/)

      const okUnlock = runBash(
        GOVERNOR_SH,
        [
          'decide-pending-approval',
          '--id',
          'gov-breaker-unlock0001',
          '--decision',
          'approve',
          '--actor',
          'admin-uid3',
          '--note',
          'Root cause fixed and retention 6/6 verified green',
        ],
        env,
      )
      assert.equal(okUnlock.status, 0, okUnlock.stderr)
      assert.equal(JSON.parse(readFileSync(path.join(ctrlDir, 'breaker.json'), 'utf8')).tripped, false)
      assert.equal(JSON.parse(readFileSync(path.join(ctrlDir, 'mode.json'), 'utf8')).mode, 'autonomous')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('OCV5-914 R2 hardening (B2/B3/B4/B6/B7/N1/N2): unified baseSha, safe SQL whitelist & lossless paths, approving crash self-heal, explicit voucher check on clean files, atomic resume claim, expired reopen, web A0 GitHub status', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'oc-gov-r2-'))
    try {
      const govRoot = path.join(tmp, 'harness-gate')
      const ctrlDir = path.join(govRoot, 'control')
      const stewardDir = path.join(govRoot, 'steward-receipts')
      const pendingDir = path.join(ctrlDir, 'pending-approvals')
      const vouchersDir = path.join(ctrlDir, 'blast-vouchers')
      const approvalsDir = path.join(ctrlDir, 'a0-approvals')
      const repoDir = path.join(tmp, 'repo')
      mkdirSync(stewardDir, { recursive: true })
      mkdirSync(ctrlDir, { recursive: true })
      mkdirSync(path.join(repoDir, 'packages/commercial/src/billing'), { recursive: true })
      mkdirSync(path.join(repoDir, 'packages/commercial/src/db/migrations'), { recursive: true })

      const hmacSecret = 'ocv5-914-r2-hmac-secret-0123456789'
      const hmacPath = path.join(ctrlDir, '.hmac-key')
      writeFileSync(hmacPath, `${hmacSecret}\n`, { mode: 0o600 })
      chmodSync(hmacPath, 0o600)

      const gitEnv = {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 'test',
        GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'test',
        GIT_COMMITTER_EMAIL: 'test@example.invalid',
      }
      const git = (...args: string[]) =>
        execFileSync('git', ['-C', repoDir, ...args], { env: gitEnv, encoding: 'utf8' }).trim()
      git('init', '-q', '-b', 'feat/v5-selfhost')
      writeFileSync(path.join(repoDir, 'packages/commercial/src/billing/ledger.ts'), 'export function tag(x: number): string { return String(x) }\n')
      writeFileSync(path.join(repoDir, 'packages/commercial/src/billing/modelPublicProjection.ts'), 'export const P = 1\n')
      writeFileSync(path.join(repoDir, 'README.md'), 'root\n')
      git('add', '.')
      git('commit', '-qm', 'chore(v5): root commit')
      const rootSha = git('rev-parse', 'HEAD')

      writeFileSync(
        path.join(repoDir, 'packages/commercial/src/billing/ledger.ts'),
        '// R2 pure comment\nexport type R2Meta = { ok: boolean }\nexport function tag(x: number | bigint): string { return String(x) }\n',
      )
      git('commit', '-qam', 'refactor(v5): pure comment and type update')
      const childSha = git('rev-parse', 'HEAD')

      const writeSteward = (headSha: string, baseSha: string) => {
        const signed = signArchStewardReceipt(
          {
            schemaVersion: ARCH_STEWARD_RECEIPT_SCHEMA_VERSION,
            headSha,
            baseSha,
            authorModel: 'claude-opus-4-6',
            authorFamily: 'anthropic-claude',
            stewardModel: 'gpt-5.4',
            stewardFamily: 'openai-gpt',
            verdict: 'approve',
            triggers: ['CLONE_OR_T2_CORE_PATH'],
            dimensions: {
              godClassAppend: { status: 'pass', notes: 'ok' },
              wheelReinvention: { status: 'pass', notes: 'ok' },
              boundaryIntegrity: { status: 'pass', notes: 'ok' },
              complexityDrift: { status: 'pass', notes: 'ok' },
            },
            blockers: [],
            usageEvidence: { jobId: 'job-r2', timestamp: '2026-11-27T01:00:00Z' },
          },
          hmacSecret,
        )
        writeFileSync(path.join(stewardDir, `${headSha}.json`), `${JSON.stringify(signed, null, 2)}\n`, { mode: 0o644 })
      }
      writeSteward(childSha, rootSha)
      writeSteward(rootSha, '0'.repeat(40))

      const env = {
        OC_GOVERNOR_ROOT: govRoot,
        OC_GOVERNOR_NOW_ISO: '2026-11-27T02:00:00Z',
        OC_GOVERNOR_STEWARD_VERIFIER: path.join(REPO_ROOT, 'scripts/lib/archStewardReceipt.ts'),
        OC_GOVERNOR_UNSAFE_TEST_SKIP_OWNER: '1',
      }

      // ── B2: Unified exact baseSha binding ──
      // 1a. Omitting --base-ref on childSha automatically resolves childSha^ (= rootSha) for core billing AST pure-type check -> auto_pass!
      const b2AutoOk = runBash(
        GOVERNOR_SH,
        ['check-blast-radius', '--branch', 'feat/v5-selfhost', '--repo-root', repoDir, '--sha', childSha, '--files', 'packages/commercial/src/billing/ledger.ts'],
        env,
      )
      assert.equal(b2AutoOk.status, 0, b2AutoOk.stderr)
      assert.equal(JSON.parse(b2AutoOk.stdout).semanticNoRuntimeBillingChange, true)

      // 1b. Omitting --base-ref on rootSha (no parent commit) -> fail-closed AND record-pending-approval marks stewardVerdict invalid!
      const b2RootFail = runBash(
        GOVERNOR_SH,
        ['check-blast-radius', '--branch', 'feat/v5-selfhost', '--repo-root', repoDir, '--sha', rootSha, '--files', 'packages/commercial/src/billing/ledger.ts'],
        env,
      )
      assert.equal(b2RootFail.status, 1)
      assert.match(JSON.parse(b2RootFail.stderr).semanticReason, /无法确定精确比较基线/)

      const b2RecRoot = runBash(
        GOVERNOR_SH,
        [
          'record-pending-approval',
          '--id',
          'gov-billing-b2root000001',
          '--kind',
          'blast_voucher',
          '--code',
          'BILLING_CORE_LOCKED',
          '--risk-category',
          'billing_change',
          '--branch',
          'feat/v5-selfhost',
          '--repo-root',
          repoDir,
          '--sha',
          rootSha,
          '--files',
          'packages/commercial/src/billing/ledger.ts',
        ],
        env,
      )
      assert.equal(b2RecRoot.status, 0, b2RecRoot.stderr)
      const b2RecDoc = JSON.parse(b2RecRoot.stdout)
      assert.equal(b2RecDoc.stewardVerdict.verdict, 'invalid')
      assert.match(b2RecDoc.stewardVerdict.summary, /无法确定比较基线/)
      assert.equal(b2RecDoc.riskCategory, 'billing_change')
      assert.equal(b2RecDoc.recommendation.action, 'caution')

      // ── B3: Conservative SQL DDL whitelist (including safe idempotent DO $$ blocks) + lossless paths + control-char rejection ──
      const safeSql = [
        '-- leading comment with DROP TABLE decoy',
        'BEGIN;',
        "SET LOCAL lock_timeout = '3s';",
        '/* block comment with TRUNCATE decoy */',
        'CREATE TABLE IF NOT EXISTS audit_events (id bigserial PRIMARY KEY, note text NOT NULL);',
        'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_events_id ON audit_events (id);',
        "ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS tag text DEFAULT 'DROP TABLE literal';",
        'ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS "meta--safe" text DEFAULT E\'safe\\\'--val\';',
        'ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT \'active\';',
        'DO $$',
        'DECLARE v_ok boolean := true;',
        'BEGIN',
        "  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_audit_tag') THEN",
        '    ALTER TABLE audit_events ADD CONSTRAINT uq_audit_tag UNIQUE (tag);',
        '  END IF;',
        "  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'audit_events' AND column_name = 'extra_tag') THEN",
        "    ALTER TABLE audit_events ADD COLUMN extra_tag text DEFAULT '';",
        '  END IF;',
        'END $$;',
        'DO $mig$ BEGIN CREATE INDEX IF NOT EXISTS idx_audit_tag ON audit_events (tag); END $mig$;',
        "COMMENT ON TABLE audit_events IS 'safe additive table';",
        'COMMIT;',
      ].join('\n')
      const safeSqlRes = runBash(
        GOVERNOR_SH,
        ['check-blast-radius', '--branch', 'feat/v5-selfhost', '--sql', safeSql],
        env,
      )
      assert.equal(safeSqlRes.status, 0, `safe additive + idempotent DO SQL should auto_pass: ${safeSqlRes.stderr}`)
      assert.equal(JSON.parse(safeSqlRes.stdout).classification, 'auto_pass')

      for (const unsafeSql of [
        'DROP TABLE users;',
        'TRUNCATE TABLE credit_ledger;',
        'DELETE FROM org_wallets WHERE id = 1;',
        'ALTER TABLE users ADD COLUMN x int, ALTER y TYPE bigint;',
        'ALTER TABLE users ADD COLUMN req_col text NOT NULL;',
        'ALTER TABLE users ADD COLUMN "x--" integer, DROP COLUMN email;',
        'ALTER TABLE users ADD COLUMN "a""--" integer, DROP COLUMN email;',
        'ALTER TABLE users ADD COLUMN "a/*b" integer, DROP COLUMN email;',
        "ALTER TABLE users ADD COLUMN x text DEFAULT E'\\'' , DROP COLUMN email;",
        'ALTER TABLE users ADD COLUMN "unclosed_ident integer;',
        'DO $$ BEGIN PERFORM 1; END $$;',
        'DO $$ BEGIN DROP TABLE users; END $$;',
        'DO $$ BEGIN ALTER TABLE users ADD COLUMN no_def text NOT NULL; END $$;',
        'DO $$ BEGIN ALTER TABLE users ALTER COLUMN email TYPE text; END $$;',
        'DO $$ BEGIN IF (SELECT 1 FROM (DELETE FROM users RETURNING 1) t) THEN CREATE INDEX IF NOT EXISTS i ON users (id); END IF; END $$;',
        'DO $$ BEGIN IF my_custom_predicate() THEN ALTER TABLE audit_events ADD COLUMN x text; END IF; END $$;',
        "DO $$ BEGIN IF EXISTS (SELECT 1 FROM users WHERE email = 'a@b.com') THEN ALTER TABLE audit_events ADD COLUMN x text; END IF; END $$;",
        'DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_class WHERE my_custom_fn() = 1) THEN CREATE INDEX IF NOT EXISTS i ON audit_events (id); END IF; END $$;',
        "DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'audit_events' LIMIT 1) THEN CREATE INDEX IF NOT EXISTS i ON audit_events (id); END IF; END $$;",
        'DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_class) OR my_custom_predicate() THEN CREATE INDEX IF NOT EXISTS i ON audit_events (id); END IF; END $$;',
        'DO $$ DECLARE v int := my_custom_fn(); BEGIN CREATE INDEX IF NOT EXISTS i ON audit_events (id); END $$;',
        "UPDATE users SET role = 'admin';",
        'ALTER TABLE users RENAME TO users_old;',
      ]) {
        const res = runBash(
          GOVERNOR_SH,
          ['check-blast-radius', '--branch', 'feat/v5-selfhost', '--sql', unsafeSql],
          env,
        )
        assert.equal(res.status, 1, `unsafe/unrecognized SQL MUST fail closed: ${unsafeSql}`)
        const err = JSON.parse(res.stderr)
        assert.equal(err.code, 'DESTRUCTIVE_DDL_LOCKED')
        assert.equal(err.riskCategory, 'ux_degradation')
      }

      // Verify explicit --voucher still validates SHA even on auto-approved non-core billing files (B6)
      const ncVoucher = runBash(
        GOVERNOR_SH,
        [
          'issue-blast-voucher',
          '--scope',
          'billing',
          '--sha',
          childSha,
          '--branch',
          'feat/v5-selfhost',
          '--files',
          'packages/commercial/src/billing/modelPublicProjection.ts',
          '--reason',
          'Bound voucher for childSha noncore check',
        ],
        env,
      )
      assert.equal(ncVoucher.status, 0, ncVoucher.stderr)
      const ncWrongSha = runBash(
        GOVERNOR_SH,
        [
          'check-blast-radius',
          '--branch',
          'feat/v5-selfhost',
          '--repo-root',
          repoDir,
          '--sha',
          rootSha,
          '--voucher',
          JSON.parse(ncVoucher.stdout).id,
          '--files',
          'packages/commercial/src/billing/modelPublicProjection.ts',
        ],
        env,
      )
      assert.equal(ncWrongSha.status, 1, 'explicit --voucher with mismatched SHA MUST still fail on non-core billing')
      assert.equal(JSON.parse(ncWrongSha.stderr).code, 'VOUCHER_SHA_MISMATCH')

      // Lossless path with comma & space via --files-json + control-char rejection
      const specialPath = 'packages/commercial/src/billing/a,b file.ts'
      const ctrlReject = runBash(
        GOVERNOR_SH,
        ['check-blast-radius', '--branch', 'feat/v5-selfhost', '--files-json', JSON.stringify(['packages/commercial/src/billing/bad\nfile.ts'])],
        env,
      )
      assert.notEqual(ctrlReject.status, 0, 'control characters in file paths MUST be rejected')
      const specialRec = runBash(
        GOVERNOR_SH,
        [
          'record-pending-approval',
          '--id',
          'gov-billing-special00001',
          '--kind',
          'blast_voucher',
          '--code',
          'BILLING_CORE_LOCKED',
          '--branch',
          'feat/v5-selfhost',
          '--sha',
          childSha,
          '--files-json',
          JSON.stringify([specialPath]),
        ],
        env,
      )
      assert.equal(specialRec.status, 0, specialRec.stderr)
      assert.deepEqual(JSON.parse(specialRec.stdout).files, [specialPath])

      // ── B6: Explicit --voucher MUST validate sha/branch even when changed files are clean! ──
      const vCleanRes = runBash(
        GOVERNOR_SH,
        [
          'issue-blast-voucher',
          '--scope',
          'billing',
          '--sha',
          childSha,
          '--branch',
          'feat/v5-selfhost',
          '--files-json',
          JSON.stringify([specialPath]),
          '--reason',
          'Bound voucher for childSha only',
        ],
        env,
      )
      assert.equal(vCleanRes.status, 0, vCleanRes.stderr)
      const vClean = JSON.parse(vCleanRes.stdout)
      const cleanWrongSha = runBash(
        GOVERNOR_SH,
        [
          'check-blast-radius',
          '--branch',
          'feat/v5-selfhost',
          '--repo-root',
          repoDir,
          '--sha',
          rootSha,
          '--voucher',
          vClean.id,
          '--files',
          'README.md',
        ],
        env,
      )
      assert.equal(cleanWrongSha.status, 1, 'explicit --voucher with mismatched SHA MUST fail even on clean files')
      assert.equal(JSON.parse(cleanWrongSha.stderr).code, 'VOUCHER_SHA_MISMATCH')

      // ── B4: Crash self-healing for stale status="approving" ──
      const computePendingSig = (doc: Record<string, unknown>) => {
        const sortRec = (v: unknown): unknown => {
          if (Array.isArray(v)) return v.map(sortRec)
          if (v && typeof v === 'object') {
            const out: Record<string, unknown> = {}
            for (const k of Object.keys(v as Record<string, unknown>).sort()) {
              out[k] = sortRec((v as Record<string, unknown>)[k])
            }
            return out
          }
          return v
        }
        const { sha256: _ignoredSha256, ...clone } = doc
        void _ignoredSha256
        return createHash('sha256').update(`pending-approval-v1\n${JSON.stringify(sortRec(clone))}`, 'utf8').digest('hex')
      }

      // Case 4a: Voucher WAS minted before crash -> reconcile / decide advances to approved reusing pendingArtifactId (NO duplicate voucher!)
      const crashIdPresent = 'gov-billing-crashpres001'
      const recCrash1 = runBash(
        GOVERNOR_SH,
        [
          'record-pending-approval',
          '--id',
          crashIdPresent,
          '--kind',
          'blast_voucher',
          '--code',
          'BILLING_CORE_LOCKED',
          '--branch',
          'feat/v5-selfhost',
          '--sha',
          childSha,
          '--files-json',
          JSON.stringify([specialPath]),
        ],
        env,
      )
      assert.equal(recCrash1.status, 0, recCrash1.stderr)
      const crashDoc1 = JSON.parse(recCrash1.stdout)
      const expectedPid = `bv-${createHash('sha256').update(`${crashIdPresent}:1:${childSha}`, 'utf8').digest('hex').slice(0, 16)}`
      // Pre-mint the deterministic voucher and put approval file into stale "approving"
      const preMint = runBash(
        GOVERNOR_SH,
        [
          'issue-blast-voucher',
          '--id',
          expectedPid,
          '--scope',
          'billing',
          '--sha',
          childSha,
          '--branch',
          'feat/v5-selfhost',
          '--approval-id',
          crashIdPresent,
          '--files-json',
          JSON.stringify([specialPath]),
          '--reason',
          'Simulated pre-crash minted voucher',
        ],
        env,
      )
      assert.equal(preMint.status, 0, preMint.stderr)
      const stale1: Record<string, unknown> = {
        ...crashDoc1,
        status: 'approving',
        pendingArtifactId: expectedPid,
        decision: { action: 'approve', decidedBy: 'admin-crash', decidedAt: '2026-11-27T02:00:00Z' },
      }
      stale1.sha256 = computePendingSig(stale1)
      writeFileSync(path.join(pendingDir, `${crashIdPresent}.json`), `${JSON.stringify(stale1, null, 2)}\n`)
      const vouchersBefore = readdirSync(vouchersDir).filter((f) => f.endsWith('.json')).length
      const healDecide = runBash(
        GOVERNOR_SH,
        ['decide-pending-approval', '--id', crashIdPresent, '--decision', 'approve', '--actor', 'admin-retry'],
        env,
      )
      assert.equal(healDecide.status, 0, healDecide.stderr)
      const healedDoc1 = JSON.parse(healDecide.stdout)
      assert.equal(healedDoc1.status, 'approved')
      assert.equal(healedDoc1.decision.issuedArtifactId, expectedPid)
      assert.equal(readdirSync(vouchersDir).filter((f) => f.endsWith('.json')).length, vouchersBefore, 'must NOT mint duplicate voucher')

      // Case 4b: Voucher NOT minted before crash -> reconcile rolls back to pending
      const crashIdAbsent = 'gov-billing-crashabs0001'
      const recCrash2 = runBash(
        GOVERNOR_SH,
        [
          'record-pending-approval',
          '--id',
          crashIdAbsent,
          '--kind',
          'blast_voucher',
          '--code',
          'BILLING_CORE_LOCKED',
          '--branch',
          'feat/v5-selfhost',
          '--sha',
          childSha,
          '--files-json',
          JSON.stringify([specialPath]),
        ],
        env,
      )
      assert.equal(recCrash2.status, 0, recCrash2.stderr)
      const crashDoc2 = JSON.parse(recCrash2.stdout)
      const stale2: Record<string, unknown> = {
        ...crashDoc2,
        status: 'approving',
        pendingArtifactId: 'bv-0000000000000000',
        decision: { action: 'approve', decidedBy: 'admin-crash', decidedAt: '2026-11-27T02:00:00Z' },
      }
      stale2.sha256 = computePendingSig(stale2)
      writeFileSync(path.join(pendingDir, `${crashIdAbsent}.json`), `${JSON.stringify(stale2, null, 2)}\n`)
      const recHeal2 = runBash(GOVERNOR_SH, ['reconcile-pending-approval', '--id', crashIdAbsent], env)
      assert.equal(recHeal2.status, 0, recHeal2.stderr)
      assert.equal(JSON.parse(recHeal2.stdout).status, 'pending')

      // Case 4c: a0_approval with publishGithubStatus=true and local .json present without .gh.json -> reconcile_required
      const a0CrashSha = '9'.repeat(40)
      const crashIdA0 = 'gov-a0-crashgh000001'
      const recCrashA0 = runBash(
        GOVERNOR_SH,
        [
          'record-pending-approval',
          '--id',
          crashIdA0,
          '--kind',
          'a0_approval',
          '--code',
          'A0_RELAXATION_REQUIRED',
          '--branch',
          'feat/v5-selfhost',
          '--sha',
          a0CrashSha,
          '--files',
          'arch/a0-protected-paths.json',
        ],
        env,
      )
      assert.equal(recCrashA0.status, 0, recCrashA0.stderr)
      mkdirSync(approvalsDir, { recursive: true })
      writeFileSync(path.join(approvalsDir, `${a0CrashSha}.json`), JSON.stringify({ sha: a0CrashSha }))
      const staleA0: Record<string, unknown> = {
        ...JSON.parse(recCrashA0.stdout),
        status: 'approving',
        pendingArtifactId: `a0-${a0CrashSha}`,
        publishGithubStatus: true,
        decision: { action: 'approve', decidedBy: 'admin-crash', decidedAt: '2026-11-27T02:00:00Z' },
      }
      staleA0.sha256 = computePendingSig(staleA0)
      writeFileSync(path.join(pendingDir, `${crashIdA0}.json`), `${JSON.stringify(staleA0, null, 2)}\n`)
      const recHealA0 = runBash(GOVERNOR_SH, ['reconcile-pending-approval', '--id', crashIdA0], env)
      assert.equal(recHealA0.status, 0, recHealA0.stderr)
      assert.equal(JSON.parse(recHealA0.stdout).status, 'reconcile_required')

      // ── B7: Atomic resume claim via --claim-from ──
      const claim1 = runBash(
        GOVERNOR_SH,
        [
          'update-approval-resume',
          '--id',
          crashIdPresent,
          '--claim-from',
          'not_started,not_started_busy,failed',
          '--status',
          'starting',
          '--detail',
          'claimed by backend',
        ],
        env,
      )
      assert.equal(claim1.status, 0, claim1.stderr)
      assert.equal(JSON.parse(claim1.stdout).decision.resumeStatus, 'starting')
      const claim2 = runBash(
        GOVERNOR_SH,
        [
          'update-approval-resume',
          '--id',
          crashIdPresent,
          '--claim-from',
          'not_started,not_started_busy,failed',
          '--status',
          'starting',
        ],
        env,
      )
      assert.notEqual(claim2.status, 0, 'second concurrent/duplicate resume claim MUST fail with RESUME_ALREADY_CLAIMED')
      assert.match(claim2.stderr, /RESUME_ALREADY_CLAIMED/)

      // B7b: Host hard-fence forbids unfenced overwrite of active/terminal resumeStatus (starting/started/running/completed)
      const unfencedOverwrite = runBash(
        GOVERNOR_SH,
        [
          'update-approval-resume',
          '--id',
          crashIdPresent,
          '--status',
          'not_started_busy',
          '--detail',
          'stale unfenced busy write must be rejected',
        ],
        env,
      )
      assert.notEqual(unfencedOverwrite.status, 0, 'unfenced overwrite of active starting claim MUST fail')
      assert.match(unfencedOverwrite.stderr, /RESUME_FENCE_REQUIRED/)

      // ── N1: Reopen expired pending approval (archives old round & opens version+1, round+1) ──
      const expId = 'gov-billing-reopen000001'
      const recExp1 = runBash(
        GOVERNOR_SH,
        [
          'record-pending-approval',
          '--id',
          expId,
          '--kind',
          'blast_voucher',
          '--code',
          'BILLING_CORE_LOCKED',
          '--branch',
          'feat/v5-selfhost',
          '--sha',
          childSha,
          '--ttl-hours',
          '1',
          '--files-json',
          JSON.stringify([specialPath]),
        ],
        env,
      )
      assert.equal(recExp1.status, 0, recExp1.stderr)
      const expDoc1 = JSON.parse(recExp1.stdout)
      assert.equal(expDoc1.round, 1)
      const recExp2 = runBash(
        GOVERNOR_SH,
        [
          'record-pending-approval',
          '--id',
          expId,
          '--kind',
          'blast_voucher',
          '--code',
          'BILLING_CORE_LOCKED',
          '--branch',
          'feat/v5-selfhost',
          '--sha',
          childSha,
          '--ttl-hours',
          '24',
          '--files-json',
          JSON.stringify([specialPath]),
        ],
        { ...env, OC_GOVERNOR_NOW_ISO: '2026-11-27T05:00:00Z' },
      )
      assert.equal(recExp2.status, 0, recExp2.stderr)
      const expDoc2 = JSON.parse(recExp2.stdout)
      assert.equal(expDoc2.status, 'pending')
      assert.equal(expDoc2.version, 2)
      assert.equal(expDoc2.round, 2)
      assert.equal(expDoc2.previousExpiredAt, expDoc1.expiresAt)
      const archivedFiles = readdirSync(pendingDir).filter((f) => f.startsWith(`${expId}.expired-`))
      assert.equal(archivedFiles.length, 1, 'expired round MUST be archived on disk')

      // ── N2: Web A0 --publish-github-status success & failure rollback ──
      const fakeBin = path.join(tmp, 'fake-bin')
      const ghLog = path.join(tmp, 'gh-n2.log')
      const ghFailFlag = path.join(tmp, 'gh-fail')
      mkdirSync(fakeBin, { recursive: true })
      writeFileSync(
        path.join(fakeBin, 'gh'),
        `#!/usr/bin/env bash\nif [[ -f "${ghFailFlag}" ]]; then echo "gh simulated outage" >&2; exit 1; fi\nprintf '%s\\n' "$*" >> "${ghLog}"\n`,
        { mode: 0o755 },
      )
      const a0GhSha = '8'.repeat(40)
      const a0GhId = 'gov-a0-pubgh0000001'
      const recA0Gh = runBash(
        GOVERNOR_SH,
        [
          'record-pending-approval',
          '--id',
          a0GhId,
          '--kind',
          'a0_approval',
          '--code',
          'A0_RELAXATION_REQUIRED',
          '--branch',
          'feat/v5-selfhost',
          '--sha',
          a0GhSha,
          '--files',
          'arch/a0-protected-paths.json',
        ],
        env,
      )
      assert.equal(recA0Gh.status, 0, recA0Gh.stderr)

      // When gh fails -> rolls back cleanly to pending with NO orphaned local .json/.gh.json!
      writeFileSync(ghFailFlag, '1')
      const a0GhFail = runBash(
        GOVERNOR_SH,
        [
          'decide-pending-approval',
          '--id',
          a0GhId,
          '--decision',
          'approve',
          '--actor',
          'admin-uid3',
          '--note',
          'Publish A0 to GitHub',
          '--publish-github-status',
          '--github-repo',
          'dream-star-end/openclaude',
        ],
        { ...env, PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
      )
      assert.notEqual(a0GhFail.status, 0)
      assert.equal(existsSync(path.join(approvalsDir, `${a0GhSha}.json`)), false)
      assert.equal(JSON.parse(readFileSync(path.join(pendingDir, `${a0GhId}.json`), 'utf8')).status, 'pending')

      // When gh succeeds -> publishes oc-v5/a0-approval, writes .gh.json, commits approved!
      rmSync(ghFailFlag)
      const a0GhOk = runBash(
        GOVERNOR_SH,
        [
          'decide-pending-approval',
          '--id',
          a0GhId,
          '--decision',
          'approve',
          '--actor',
          'admin-uid3',
          '--note',
          'Publish A0 to GitHub ok',
          '--publish-github-status',
          '--github-repo',
          'dream-star-end/openclaude',
        ],
        { ...env, PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
      )
      assert.equal(a0GhOk.status, 0, a0GhOk.stderr)
      const a0GhOkDoc = JSON.parse(a0GhOk.stdout)
      assert.equal(a0GhOkDoc.status, 'approved')
      assert.equal(a0GhOkDoc.decision.issuedArtifactId, `a0-${a0GhSha}`)
      assert.equal(JSON.parse(readFileSync(path.join(approvalsDir, `${a0GhSha}.gh.json`), 'utf8')).publishedGithubStatus, true)
      assert.match(readFileSync(ghLog, 'utf8'), /context=oc-v5\/a0-approval/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
