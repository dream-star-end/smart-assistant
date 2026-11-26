import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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
      const ghLine = readFileSync(ghLog, 'utf8')
      assert.match(ghLine, /context=oc-v5\/a0-approval/)
      assert.match(ghLine, new RegExp(`sha=${sha.slice(0, 12)}`))

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
      mkdirSync(path.join(fakeRel, 'arch'), { recursive: true })
      mkdirSync(path.join(fakeRel, '.github'), { recursive: true })
      writeFileSync(path.join(fakeRel, 'scripts/check-architecture.ts'), '// gate v1\n')
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

  test('B1/B4 sync-referee.sh --stage-audited verifies A0 approval bound to exact targetSha and writes TRANSITION_APPROVAL.json + MANIFEST.json', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'oc-sync-transition-'))
    try {
      const govRoot = path.join(tmp, 'harness-gate')
      const candidateSrc = path.join(tmp, 'audited-candidate')
      const liveRel = path.join(tmp, 'live-rel')
      const liveLink = path.join(tmp, 'openclaude-v5-selfhost-live')
      const targetSha = '9'.repeat(40)
      const wrongSha = '8'.repeat(40)

      mkdirSync(path.join(candidateSrc, 'scripts/lib'), { recursive: true })
      mkdirSync(path.join(candidateSrc, 'packages/commercial/scripts'), { recursive: true })
      mkdirSync(path.join(candidateSrc, 'packages/protocol/src'), { recursive: true })
      mkdirSync(path.join(candidateSrc, '.github/scripts'), { recursive: true })
      writeFileSync(path.join(candidateSrc, 'scripts/check-a0-monotonic.ts'), '// audited gate\n')
      writeFileSync(path.join(candidateSrc, 'packages/commercial/scripts/lint-demo.ts'), '// lint\n')
      writeFileSync(path.join(candidateSrc, 'packages/protocol/src/httpContracts.ts'), '// contracts\n')
      writeFileSync(path.join(candidateSrc, '.github/scripts/integ-shard-budget.ts'), '// budget\n')

      // Verified live release with node_modules to be linked into transition referee
      mkdirSync(path.join(liveRel, 'node_modules/tsx'), { recursive: true })
      writeFileSync(path.join(liveRel, 'node_modules/tsx/index.js'), '// live tsx\n')
      writeFileSync(
        path.join(liveRel, '.complete'),
        JSON.stringify({ schemaVersion: 2, sourceCommit: '1'.repeat(40) }),
      )
      symlinkSync(liveRel, liveLink)

      // Issue valid A0 approval for targetSha
      const env = { OC_GOVERNOR_ROOT: govRoot, OC_GOVERNOR_NOW_ISO: '2026-11-26T12:00:00Z' }
      const approve = runBash(
        GOVERNOR_SH,
        ['approve-a0', '--sha', targetSha, '--reason', 'B1 audited schema transition rollout'],
        env,
      )
      assert.equal(approve.status, 0, approve.stderr)
      const approvalFile = path.join(govRoot, `control/a0-approvals/${targetSha}.json`)

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

      // 3. Valid --stage-audited succeeds and writes read-only referee + TRANSITION_APPROVAL.json + MANIFEST.json + .github/scripts + node_modules
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
      const transition = JSON.parse(readFileSync(path.join(refereeDir, 'TRANSITION_APPROVAL.json'), 'utf8'))
      assert.equal(transition.mode, 'transition-audited')
      assert.equal(transition.targetSha, targetSha)
      assert.equal(transition.approval.sha, targetSha)

      const manifest = JSON.parse(readFileSync(path.join(refereeDir, 'MANIFEST.json'), 'utf8'))
      assert.equal(manifest.mode, 'transition-audited')
      assert.equal(manifest.targetSha, targetSha)
      assert.ok(manifest.files['TRANSITION_APPROVAL.json'])
      assert.ok(manifest.files['.github/scripts/integ-shard-budget.ts'])
      assert.ok(manifest.files['packages/protocol/src/httpContracts.ts'])
      assert.ok(existsSync(path.join(refereeDir, 'node_modules/tsx/index.js')))
    } finally {
      spawnSync('chmod', ['-R', 'u+w', tmp])
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
