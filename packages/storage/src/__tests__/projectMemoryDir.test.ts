/**
 * Project memory files are carriers; injection requires matching ledger hash.
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
const { ProjectMemoryLedger, ensureProjectMemoryLedger, officialManifestSha256 } =
  await import('../projectMemoryLedger.js')

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

describe('ProjectMemoryLedger', () => {
  it('candidates never overwrite official; conflict keeps both; promote is CAS', async () => {
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
    const promoted = await ledger.promote({
      projectId: ID,
      candidateId: a.candidate.id,
      expectedVersion: a.candidate.version,
      actor: 'user:default',
    })
    assert.equal(promoted.ok, true)
    if (!promoted.ok) return

    const stale = await ledger.promote({
      projectId: ID,
      candidateId: a.candidate.id,
      expectedVersion: 0,
      actor: 'user:default',
    })
    assert.equal(stale.ok, true, JSON.stringify(stale))
    if (stale.ok) assert.equal(stale.idempotent, true)

    const b = await ledger.createCandidate({
      projectId: ID,
      slug: 'notes.md',
      content: memoryBody('约定', 'v2 different'),
      actor: 'agent:stage-design',
      sourceAgent: 'stage-design',
    })
    assert.equal(b.ok, true)
    if (!b.ok) return
    assert.equal(b.candidate.status, 'conflict')
    assert.notEqual(b.candidate.contentSha256, promoted.official.contentSha256)
    const still = ledger.getOfficial(ID, 'notes.md')
    assert.ok(still)
    assert.equal(still?.contentSha256, promoted.official.contentSha256)

    const idem = await ledger.createCandidate({
      projectId: ID,
      slug: 'notes.md',
      content: memoryBody('约定', 'v1'),
      actor: 'agent:stage-implement',
      idempotencyKey: 'auto:1:notes.md',
    })
    assert.equal(idem.ok, true)
    if (idem.ok) assert.equal(idem.alreadyOfficial || idem.idempotent, true)
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
