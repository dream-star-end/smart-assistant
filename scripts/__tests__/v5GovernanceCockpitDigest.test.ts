import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import {
  buildGovernanceCockpitDigest,
  parseCockpitArgs,
  renderCockpitMarkdown,
  runCockpitCli,
} from '../v5-governance-cockpit-digest.js'

function initGitFixture(dir: string, commits: Array<{ dateIso: string; subject: string; file: string; content: string }>): void {
  execFileSync('git', ['init', '-b', 'feat/v5-selfhost', dir], { stdio: 'ignore' })
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test Bot'], { stdio: 'ignore' })
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'bot@example.com'], { stdio: 'ignore' })
  for (const c of commits) {
    const abs = path.join(dir, c.file)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, c.content, 'utf8')
    execFileSync('git', ['-C', dir, 'add', '.'], { stdio: 'ignore' })
    execFileSync('git', ['-C', dir, 'commit', '-m', c.subject], {
      stdio: 'ignore',
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: c.dateIso,
        GIT_COMMITTER_DATE: c.dateIso,
      },
    })
  }
}

function initLeaseDbFixture(
  dbPath: string,
  trains: Array<{ id: string; status: string; reason: string; createdAt: string; durSec?: number }>,
): void {
  execFileSync(
    'sqlite3',
    [
      dbPath,
      `CREATE TABLE train (
         seq INTEGER PRIMARY KEY AUTOINCREMENT,
         id TEXT NOT NULL UNIQUE,
         resource TEXT NOT NULL,
         target_sha TEXT NOT NULL,
         status TEXT NOT NULL,
         owner TEXT NOT NULL,
         reason TEXT,
         created_at TEXT NOT NULL,
         started_at TEXT,
         finished_at TEXT,
         updated_at TEXT NOT NULL
       );`,
    ],
    { stdio: 'ignore' },
  )
  for (const t of trains) {
    const startMs = Date.parse(t.createdAt)
    const endIso = new Date(startMs + (t.durSec ?? 60) * 1000).toISOString()
    const esc = (s: string) => s.replace(/'/g, "''")
    execFileSync(
      'sqlite3',
      [
        dbPath,
        `INSERT INTO train (id, resource, target_sha, status, owner, reason, created_at, started_at, finished_at, updated_at)
         VALUES ('${esc(t.id)}', 'deploy:selfhost', '120d63ea1c1278a5969a706f576c33e761f887f7', '${esc(t.status)}', 'worker', '${esc(t.reason)}', '${esc(t.createdAt)}', '${esc(t.createdAt)}', '${esc(endIso)}', '${esc(endIso)}');`,
      ],
      { stdio: 'ignore' },
    )
  }
}

describe('v5-governance-cockpit-digest', () => {
  test('gracefully renders N/A across all 4 gauges in pure --offline mode with missing sources', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'cockpit-empty-'))
    try {
      const outJson = path.join(tmp, 'digest.json')
      const outMd = path.join(tmp, 'digest.md')
      const rc = await runCockpitCli([
        '--offline',
        '--date',
        '2026-11-26',
        '--out-json',
        outJson,
        '--out-md',
        outMd,
      ])
      assert.equal(rc, 0)
      const parsed = JSON.parse(readFileSync(outJson, 'utf8'))
      assert.equal(parsed.overallStatus, 'N/A')
      assert.equal(parsed.gauges.structureAndRework.rework14d.ratio, 'N/A')
      assert.equal(parsed.gauges.deliveryAndExperience.trainPassRate7d.rate, 'N/A')
      assert.equal(parsed.gauges.computeAndWaste.weeklyConsumption.totalCredits, 'N/A')
      assert.equal(parsed.gauges.metaGuardrailIntegrity.a0Audit7d.interceptedAttempts, 'N/A')

      const md = readFileSync(outMd, 'utf8')
      assert.ok(md.includes('仪表 1 · 结构与返工晴雨表'))
      assert.ok(md.includes('仪表 2 · 交付与体验稳定度'))
      assert.ok(md.includes('仪表 3 · 算力与浪费护栏'))
      assert.ok(md.includes('仪表 4 · 元护栏完整性审计'))
      assert.ok(md.includes('N/A'))
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('computes GREEN across all 4 gauges when all authoritative fixtures are healthy', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'cockpit-green-'))
    try {
      const repoDir = path.join(tmp, 'repo')
      const leaseDb = path.join(tmp, 'lease.db')
      const resultsDir = path.join(tmp, 'results')
      const govRoot = path.join(tmp, 'gov')
      const stewardDir = path.join(tmp, 'steward')
      const costJson = path.join(tmp, 'cost.json')

      mkdirSync(resultsDir, { recursive: true })
      mkdirSync(path.join(govRoot, 'control/a0-approvals'), { recursive: true })
      mkdirSync(stewardDir, { recursive: true })

      // 1 bug commit out of 5 total = 20% (<35% GREEN), zero expired TTLs, shrinking violations
      initGitFixture(repoDir, [
        {
          dateIso: '2026-11-10T10:00:00Z',
          subject: 'feat(v5): seed baseline',
          file: 'arch/violations-baseline.json',
          content: JSON.stringify({ schema: 1, entries: { 'R2-same-layer|a.ts|b': 10 } }),
        },
        {
          dateIso: '2026-11-11T10:00:00Z',
          subject: 'feat(v5): seed filesize',
          file: '.github/file-size-baseline.json',
          content: JSON.stringify({ limit: 3000, slack: 0, files: { 'packages/a/src/big.ts': 100 } }),
        },
        {
          dateIso: '2026-11-12T10:00:00Z',
          subject: 'feat(v5): seed exceptions',
          file: '.github/file-size-ratchet-exceptions.json',
          content: JSON.stringify([
            {
              path: 'packages/a/src/big.ts',
              maxLines: 120,
              ticket: 'OCV5-900',
              reason: 'active exception within window',
              expires: '2026-12-20',
            },
          ]),
        },
        {
          dateIso: '2026-11-21T10:00:00Z',
          subject: 'feat(v5): shrink arch violations',
          file: 'arch/violations-baseline.json',
          content: JSON.stringify({ schema: 1, entries: { 'R2-same-layer|a.ts|b': 8 } }),
        },
        {
          dateIso: '2026-11-22T10:00:00Z',
          subject: 'bug(v5): minor edge fix',
          file: 'packages/a/src/small.ts',
          content: 'export const x = 1\n',
        },
        {
          dateIso: '2026-11-23T10:00:00Z',
          subject: 'refactor(v5): clean up helper',
          file: 'packages/a/src/helper.ts',
          content: 'export const y = 2\n',
        },
        {
          dateIso: '2026-11-24T10:00:00Z',
          subject: 'feat(v5): add telemetry',
          file: 'packages/a/src/tel.ts',
          content: 'export const z = 3\n',
        },
        {
          dateIso: '2026-11-25T10:00:00Z',
          subject: 'chore(v5): tidy docs',
          file: 'README.md',
          content: '# ok\n',
        },
      ])

      // 9/10 committed trains = 90% (>=80% GREEN), 0 rollbacks
      const trains = Array.from({ length: 10 }, (_, idx) => ({
        id: `tr-20261125T0${idx}0000Z-00000000000${idx}`,
        status: idx === 0 ? 'failed' : 'committed',
        reason: idx === 0 ? 'transient build err' : 'cutover committed',
        createdAt: `2026-11-25T0${idx}:00:00Z`,
        durSec: 120,
      }))
      initLeaseDbFixture(leaseDb, trains)

      // 6/6 PASS retention result
      writeFileSync(
        path.join(resultsDir, '20261126T010000Z.json'),
        JSON.stringify({ ok: true, stamp: '20261126T010000Z', pass: 6, fail: 0 }),
      )

      // Valid governor state + valid A0 approval signature
      writeFileSync(
        path.join(govRoot, 'control/mode.json'),
        JSON.stringify({ mode: 'autonomous' }),
      )
      writeFileSync(
        path.join(govRoot, 'control/audit.jsonl'),
        `${JSON.stringify({ ts: '2026-11-25T01:00:00Z', action: 'mode_set', outcome: 'ok' })}\n`,
      )
      const sha = 'a'.repeat(40)
      const issuedAt = '2026-11-25T00:00:00Z'
      const expiresAt = '2026-11-26T12:00:00Z'
      const reason = 'approved calibration'
      const sha256 = createHash('sha256')
        .update(`a0-approval-v1\nsha=${sha}\nissuedAt=${issuedAt}\nexpiresAt=${expiresAt}\nreason=${reason}\n`, 'utf8')
        .digest('hex')
      writeFileSync(
        path.join(govRoot, `control/a0-approvals/${sha}.json`),
        JSON.stringify({ schemaVersion: 1, sha, approvedBy: 'root', issuedAt, expiresAt, reason, sha256 }),
      )

      // Valid cross-family Steward receipt
      writeFileSync(
        path.join(stewardDir, `${sha}.json`),
        JSON.stringify({
          headSha: sha,
          authorFamily: 'openai-gpt',
          stewardFamily: 'google-gemini',
          verdict: 'approve',
          timestamp: '2026-11-25T05:00:00Z',
        }),
      )

      // Smooth daily compute series (no >2x spike)
      writeFileSync(
        costJson,
        JSON.stringify({
          weeklyTotalUsd: 142.5,
          weeklyTotalCredits: 142_500,
          retryWasteRatio: 0.04,
          dailySeries: [
            { date: '2026-11-20', value: 20 },
            { date: '2026-11-21', value: 21 },
            { date: '2026-11-22', value: 19 },
            { date: '2026-11-23', value: 22 },
            { date: '2026-11-24', value: 20 },
          ],
        }),
      )

      const opts = parseCockpitArgs([
        '--offline',
        '--date',
        '2026-11-26',
        '--repo-root',
        repoDir,
        '--lease-db',
        leaseDb,
        '--harness-results-dir',
        resultsDir,
        '--governor-root',
        govRoot,
        '--steward-receipt-dir',
        stewardDir,
        '--cost-report-json',
        costJson,
      ])
      const digest = await buildGovernanceCockpitDigest(opts)

      assert.equal(digest.gauges.structureAndRework.status, 'GREEN')
      assert.equal(digest.gauges.structureAndRework.archViolations.r2NetDelta7d, -2)
      assert.equal(digest.gauges.deliveryAndExperience.status, 'GREEN')
      assert.equal(digest.gauges.deliveryAndExperience.trainPassRate7d.rate, 0.9)
      assert.equal(digest.gauges.computeAndWaste.status, 'GREEN')
      assert.equal(digest.gauges.metaGuardrailIntegrity.status, 'GREEN')
      assert.equal(digest.overallStatus, 'GREEN')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('flags RED/AMBER accurately on >40% rework, >=2 rollbacks, daily spike, and tampered A0 receipt', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'cockpit-red-'))
    try {
      const repoDir = path.join(tmp, 'repo')
      const leaseDb = path.join(tmp, 'lease.db')
      const resultsDir = path.join(tmp, 'results')
      const govRoot = path.join(tmp, 'gov')
      const costJson = path.join(tmp, 'cost.json')

      mkdirSync(resultsDir, { recursive: true })
      mkdirSync(path.join(govRoot, 'control/a0-approvals'), { recursive: true })

      // 3 fix/bug out of 5 commits = 60% (>40% RED) + 1 expired TTL
      initGitFixture(repoDir, [
        {
          dateIso: '2026-11-20T10:00:00Z',
          subject: 'fix(v5): bug 1',
          file: 'packages/a/src/f1.ts',
          content: 'export const a = 1\n',
        },
        {
          dateIso: '2026-11-21T10:00:00Z',
          subject: 'bug(v5): bug 2',
          file: 'packages/a/src/f2.ts',
          content: 'export const b = 2\n',
        },
        {
          dateIso: '2026-11-22T10:00:00Z',
          subject: 'fix(v5): bug 3',
          file: '.github/file-size-ratchet-exceptions.json',
          content: JSON.stringify([{ path: 'x.ts', expires: '2026-11-01' }]),
        },
        {
          dateIso: '2026-11-23T10:00:00Z',
          subject: 'feat(v5): feature 1',
          file: 'packages/a/src/f3.ts',
          content: 'export const c = 3\n',
        },
        {
          dateIso: '2026-11-24T10:00:00Z',
          subject: 'feat(v5): feature 2',
          file: 'packages/a/src/f4.ts',
          content: 'export const d = 4\n',
        },
      ])

      // 1/4 committed = 25% (<50% RED) + 2 rollbacks
      initLeaseDbFixture(leaseDb, [
        { id: 'tr-1', status: 'committed', reason: 'ok', createdAt: '2026-11-24T01:00:00Z' },
        { id: 'tr-2', status: 'failed', reason: 'auto rollback retention fail', createdAt: '2026-11-24T02:00:00Z' },
        { id: 'tr-3', status: 'failed', reason: 'rollback cutover fail', createdAt: '2026-11-25T01:00:00Z' },
        { id: 'tr-4', status: 'failed', reason: 'gate fail', createdAt: '2026-11-25T02:00:00Z' },
      ])

      // 5/6 retention FAIL
      writeFileSync(
        path.join(resultsDir, '20261126T020000Z.json'),
        JSON.stringify({ ok: false, stamp: '20261126T020000Z', pass: 5, fail: 1 }),
      )

      // Tampered A0 approval + intercepted blast radius attempt
      writeFileSync(
        path.join(govRoot, 'control/a0-approvals/bad.json'),
        JSON.stringify({ sha: 'bad', payloadSha256: '0'.repeat(64) }),
      )
      writeFileSync(
        path.join(govRoot, 'control/audit.jsonl'),
        `${JSON.stringify({ ts: '2026-11-25T04:00:00Z', action: 'check_blast_radius', outcome: 'blocked', branch: 'feat/v5-aurora-rewrite' })}\n`,
      )

      // 5x daily spike
      writeFileSync(
        costJson,
        JSON.stringify({
          weeklyTotalUsd: 500,
          dailySeries: [
            { date: '2026-11-21', value: 20 },
            { date: '2026-11-22', value: 20 },
            { date: '2026-11-25', value: 120 },
          ],
        }),
      )

      const opts = parseCockpitArgs([
        '--offline',
        '--date',
        '2026-11-26',
        '--repo-root',
        repoDir,
        '--lease-db',
        leaseDb,
        '--harness-results-dir',
        resultsDir,
        '--governor-root',
        govRoot,
        '--cost-report-json',
        costJson,
      ])
      const digest = await buildGovernanceCockpitDigest(opts)

      assert.equal(digest.gauges.structureAndRework.status, 'RED')
      assert.equal(digest.gauges.structureAndRework.rework14d.ratio, 0.6)
      assert.equal(digest.gauges.structureAndRework.expiredDebtTtlCount, 1)
      assert.equal(digest.gauges.deliveryAndExperience.status, 'RED')
      assert.equal(digest.gauges.deliveryAndExperience.weeklyRollbacks, 2)
      assert.equal(digest.gauges.computeAndWaste.status, 'RED')
      assert.equal(digest.gauges.computeAndWaste.dailySpike.spikeDetected, true)
      assert.equal(digest.gauges.metaGuardrailIntegrity.status, 'RED')
      assert.equal(digest.gauges.metaGuardrailIntegrity.a0Audit7d.tamperedApprovals, 1)
      assert.equal(digest.gauges.metaGuardrailIntegrity.a0Audit7d.interceptedAttempts, 1)
      assert.equal(digest.overallStatus, 'RED')

      const md = renderCockpitMarkdown(digest)
      assert.ok(md.includes('🔴 RED'))
      assert.ok(md.includes('异常与行动提示'))
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
