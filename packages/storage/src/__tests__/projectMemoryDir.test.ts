/**
 * Project memory files are carriers; injection requires matching ledger hash.
 * Candidate creation auto-promotes, so most cases here assert the one-step path.
 * Run: npx tsx --test packages/storage/src/__tests__/projectMemoryDir.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import Database from 'better-sqlite3'

const testHome = await mkdtemp(join(tmpdir(), 'oc-pmem-'))
process.env.OPENCLAUDE_HOME = testHome

const { ProjectMemoryDir, sha256Hex } = await import('../projectMemoryDir.js')
const {
  AUTO_PROMOTE_ACTOR,
  ProjectMemoryLedger,
  ensureProjectMemoryLedger,
  officialManifestSha256,
} = await import('../projectMemoryLedger.js')

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function memoryBody(name: string, extra = '项目约定用表格。'): string {
  return `---\nname: ${name}\ndescription: 项目约定\ntype: project\n---\n${extra}\n`
}

describe('ProjectMemoryDir tamper gate', () => {
  it('skips official files whose hash does not match the ledger', async () => {
    const dir = new ProjectMemoryDir(ID)
    const content = memoryBody('约定')
    const written = await dir.writeCandidate('notes.md', content)
    assert.equal(written.ok, true)
    if (!written.ok) return
    const copied = await dir.copyCandidateToOfficial('notes.md', 'notes.md', written.sha256)
    assert.equal(copied.ok, true)
    const ok = await dir.renderOfficialIndex(
      [{ slug: 'notes.md', contentSha256: written.sha256, name: '约定', description: '项目约定' }],
      8000,
      80,
    )
    assert.ok(ok)
    assert.match(ok ?? '', /notes\.md/)

    await mkdir(dir.officialDir(), { recursive: true })
    await writeFile(dir.officialFile('notes.md'), memoryBody('约定', 'agent tampered this file'), 'utf8')
    const after = await dir.renderOfficialIndex(
      [{ slug: 'notes.md', contentSha256: written.sha256, name: '约定', description: '项目约定' }],
      8000,
      80,
    )
    assert.equal(after, null)
  })

  it('does not inject a file that only exists on disk with no ledger row', async () => {
    const dir = new ProjectMemoryDir(ID)
    await mkdir(dir.officialDir(), { recursive: true })
    await writeFile(dir.officialFile('ghost.md'), memoryBody('ghost'), 'utf8')
    const rendered = await dir.renderOfficialIndex([], 8000, 80)
    assert.equal(rendered, null)
  })
})

describe('candidate hash filenames (B5)', () => {
  it('v1→v2→v3 rewrite keeps every prior candidate readable', async () => {
    const db = new Database(':memory:')
    ensureProjectMemoryLedger(db)
    const ledger = new ProjectMemoryLedger(db)
    const pid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const v1 = await ledger.createCandidate({
      projectId: pid,
      slug: 'notes.md',
      content: memoryBody('约定', 'v1'),
      actor: 'agent:a',
    })
    assert.equal(v1.ok, true)
    if (!v1.ok) return
    const v2 = await ledger.createCandidate({
      projectId: pid,
      slug: 'notes.md',
      content: memoryBody('约定', 'v2'),
      actor: 'agent:b',
    })
    assert.equal(v2.ok, true)
    if (!v2.ok) return
    const v3 = await ledger.createCandidate({
      projectId: pid,
      slug: 'notes.md',
      content: memoryBody('约定', 'v3'),
      actor: 'agent:c',
    })
    assert.equal(v3.ok, true)
    if (!v3.ok) return
    assert.notEqual(v1.candidate.file, v2.candidate.file)
    assert.notEqual(v2.candidate.file, v3.candidate.file)
    const dir = new ProjectMemoryDir(pid)
    const r1 = await dir.readCandidate(v1.candidate.file, v1.candidate.contentSha256)
    const r2 = await dir.readCandidate(v2.candidate.file, v2.candidate.contentSha256)
    const r3 = await dir.readCandidate(v3.candidate.file, v3.candidate.contentSha256)
    assert.ok(r1 && r2 && r3)
    // Auto-promotion makes v3 the live content, so re-proposing v2 is a rewrite
    // back to those bytes (last writer wins), not a deduplicated replay.
    assert.equal(ledger.getOfficial(pid, 'notes.md')?.contentSha256, v3.candidate.contentSha256)
    const again = await ledger.createCandidate({
      projectId: pid,
      slug: 'notes.md',
      content: memoryBody('约定', 'v2'),
      actor: 'agent:b',
    })
    assert.equal(again.ok, true)
    if (again.ok) {
      assert.equal(again.autoPromoted, true)
      assert.equal(again.official?.contentSha256, v2.candidate.contentSha256)
    }
  })

  it('replaying one idempotency key writes a single candidate', async () => {
    const db = new Database(':memory:')
    ensureProjectMemoryLedger(db)
    const ledger = new ProjectMemoryLedger(db)
    const pid = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    const input = {
      projectId: pid,
      slug: 'notes.md',
      content: memoryBody('约定', 'once'),
      actor: 'agent:a',
      idempotencyKey: 'autodream:attempt-1:notes.md',
    }
    const first = await ledger.createCandidate(input)
    const replay = await ledger.createCandidate(input)
    assert.equal(first.ok && replay.ok, true)
    if (!first.ok || !replay.ok) return
    assert.equal(replay.candidate.id, first.candidate.id)
    assert.equal(ledger.listCandidates(pid).length, 1)
    assert.equal(replay.official?.contentSha256, first.official?.contentSha256)
  })
})

describe('ProjectMemoryLedger', () => {
  it('creating a candidate promotes it in one step and audits both events', async () => {
    const db = new Database(':memory:')
    ensureProjectMemoryLedger(db)
    const ledger = new ProjectMemoryLedger(db)
    const created = await ledger.createCandidate({
      projectId: ID,
      slug: 'auto.md',
      content: memoryBody('自动', 'no human hop'),
      actor: 'agent:stage-implement',
      sourceAgent: 'stage-implement',
      sourceSession: 'sess-auto',
    })
    assert.equal(created.ok, true)
    if (!created.ok) return
    assert.equal(created.autoPromoted, true)
    assert.equal(created.candidate.status, 'promoted')

    // No promote() call anywhere above: the memory is already injectable.
    const official = ledger.listOfficial(ID)
    assert.deepEqual(
      official.map((r) => r.slug),
      ['auto.md'],
    )
    assert.equal(official[0]?.contentSha256, created.candidate.contentSha256)
    assert.equal(official[0]?.version, 1)

    const events = db
      .prepare(
        `SELECT action, actor FROM tb_project_memory_event WHERE project_id = ? AND slug = ?`,
      )
      .all(ID, 'auto.md') as Array<{ action: string; actor: string }>
    assert.deepEqual(
      events.map((e) => e.action).sort(),
      ['create_candidate', 'promote'],
    )
    assert.equal(events.find((e) => e.action === 'create_candidate')?.actor, 'agent:stage-implement')
    assert.equal(events.find((e) => e.action === 'promote')?.actor, AUTO_PROMOTE_ACTOR)
  })

  it('same-slug rewrite wins and leaves a conflict trail; promote stays idempotent', async () => {
    const db = new Database(':memory:')
    ensureProjectMemoryLedger(db)
    const ledger = new ProjectMemoryLedger(db)
    const a = await ledger.createCandidate({
      projectId: ID,
      slug: 'notes.md',
      content: memoryBody('约定', 'v1'),
      actor: 'agent:stage-implement',
      sourceAgent: 'stage-implement',
      sourceSession: 'sess-1',
    })
    assert.equal(a.ok, true)
    if (!a.ok) return
    assert.equal(a.official?.version, 1)

    // The old two-stage clients keep working: promote on a live candidate is a no-op.
    for (const expectedVersion of [a.candidate.version, 0]) {
      const again = await ledger.promote({
        projectId: ID,
        candidateId: a.candidate.id,
        expectedVersion,
        actor: 'user:default',
      })
      assert.equal(again.ok, true, JSON.stringify(again))
      if (again.ok) {
        assert.equal(again.idempotent, true)
        assert.equal(again.official.contentSha256, a.candidate.contentSha256)
      }
    }

    const b = await ledger.createCandidate({
      projectId: ID,
      slug: 'notes.md',
      content: memoryBody('约定', 'v2 different'),
      actor: 'agent:stage-design',
      sourceAgent: 'stage-design',
    })
    assert.equal(b.ok, true)
    if (!b.ok) return
    assert.equal(b.candidate.status, 'promoted')
    assert.notEqual(b.candidate.contentSha256, a.candidate.contentSha256)
    // Last writer wins, version chain continues, and the collision is still audited.
    const live = ledger.getOfficial(ID, 'notes.md')
    assert.equal(live?.contentSha256, b.candidate.contentSha256)
    assert.equal(live?.version, 2)
    const conflicts = db
      .prepare(
        `SELECT COUNT(*) AS n FROM tb_project_memory_event
         WHERE project_id = ? AND slug = ? AND action = 'conflict'`,
      )
      .get(ID, 'notes.md') as { n: number }
    assert.equal(conflicts.n, 1)

    const idem = await ledger.createCandidate({
      projectId: ID,
      slug: 'notes.md',
      content: memoryBody('约定', 'v2 different'),
      actor: 'agent:stage-design',
      idempotencyKey: 'auto:1:notes.md',
    })
    assert.equal(idem.ok, true)
    if (idem.ok) {
      assert.equal(idem.alreadyOfficial, true)
      assert.equal(ledger.getOfficial(ID, 'notes.md')?.version, 2)
    }
  })

  it('does not resurrect content the user deprecated', async () => {
    const db = new Database(':memory:')
    ensureProjectMemoryLedger(db)
    const ledger = new ProjectMemoryLedger(db)
    const pid = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const body = memoryBody('撤销过的', 'stale fact')
    const first = await ledger.createCandidate({
      projectId: pid,
      slug: 'revoked.md',
      content: body,
      actor: 'agent:main',
    })
    assert.equal(first.ok, true)
    if (!first.ok || !first.official) return
    const dropped = ledger.deprecate({
      projectId: pid,
      slug: 'revoked.md',
      expectedVersion: first.official.version,
      actor: 'user:default',
    })
    assert.equal(dropped.ok, true)

    const retry = await ledger.createCandidate({
      projectId: pid,
      slug: 'revoked.md',
      content: body,
      actor: 'agent:main',
    })
    assert.equal(retry.ok, true)
    if (!retry.ok) return
    assert.equal(retry.autoPromoted, false)
    assert.equal(retry.candidate.status, 'pending')
    assert.equal(ledger.getOfficial(pid, 'revoked.md')?.deprecated, true)
    assert.equal(ledger.listOfficial(pid).length, 0)

    // Genuinely new content for the same slug is still allowed to take over.
    const revised = await ledger.createCandidate({
      projectId: pid,
      slug: 'revoked.md',
      content: memoryBody('撤销过的', 'fresh fact'),
      actor: 'agent:main',
    })
    assert.equal(revised.ok, true)
    if (revised.ok) assert.equal(revised.autoPromoted, true)
    assert.equal(ledger.listOfficial(pid).length, 1)
  })

  it('expired and deprecated official rows are not injectable', async () => {
    const db = new Database(':memory:')
    ensureProjectMemoryLedger(db)
    const ledger = new ProjectMemoryLedger(db)
    const dir = new ProjectMemoryDir(ID)
    const created = await ledger.createCandidate({
      projectId: ID,
      slug: 'old.md',
      content: '---\nname: old\ndescription: gone\ntype: project\nexpires: 2000-01-01\n---\n历史事实\n',
      actor: 'agent:main',
    })
    assert.equal(created.ok, true)
    if (!created.ok) return
    const promoted = await ledger.promote({
      projectId: ID,
      candidateId: created.candidate.id,
      expectedVersion: created.candidate.version,
      actor: 'user:default',
    })
    assert.equal(promoted.ok, true)
    if (!promoted.ok) return
    const expired = await dir.renderOfficialIndex(
      ledger.listOfficial(ID).map((r) => ({
        slug: r.slug,
        contentSha256: r.contentSha256,
        expires: r.expires,
        deprecated: r.deprecated,
      })),
      8000,
      80,
      { today: '2026-08-24' },
    )
    assert.equal(expired, null)

    const live = await ledger.createCandidate({
      projectId: ID,
      slug: 'live.md',
      content: memoryBody('live'),
      actor: 'agent:main',
    })
    assert.equal(live.ok, true)
    if (!live.ok) return
    const liveP = await ledger.promote({
      projectId: ID,
      candidateId: live.candidate.id,
      expectedVersion: live.candidate.version,
      actor: 'user:default',
    })
    assert.equal(liveP.ok, true)
    if (!liveP.ok) return
    const dep = ledger.deprecate({
      projectId: ID,
      slug: 'live.md',
      expectedVersion: liveP.official.version,
      actor: 'user:default',
    })
    assert.equal(dep.ok, true)
    const after = await dir.renderOfficialIndex(
      ledger.listOfficial(ID, { includeDeprecated: true }).map((r) => ({
        slug: r.slug,
        contentSha256: r.contentSha256,
        expires: r.expires,
        deprecated: r.deprecated,
      })),
    )
    assert.equal(after, null)
    assert.ok(officialManifestSha256(ledger.listOfficial(ID)).length === 64)
    assert.equal(sha256Hex('x').length, 64)
  })
})
