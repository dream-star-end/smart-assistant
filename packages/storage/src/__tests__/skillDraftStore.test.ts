/**
 * Tests for SkillDraftStore: the skill-training staging layer. Verifies draft
 * write/read round-trips, format compatibility with SkillStore, baseVersion
 * pinning, op semantics (create/update/delete), listing, discard, and that the
 * drafts root stays contained within HOME.
 *
 * Run:
 *   npx tsx --test packages/storage/src/__tests__/skillDraftStore.test.ts
 */
import * as assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { before, describe, it } from 'node:test'

// Point OPENCLAUDE_HOME at a throwaway dir BEFORE importing paths-aware modules.
const testHome = await mkdtemp(join(tmpdir(), 'oc-skilldraft-'))
process.env.OPENCLAUDE_HOME = testHome

const { SkillDraftStore } = await import('../skillDraftStore.js')
const { SkillStore, parseFrontmatter } = await import('../skillStore.js')
const { paths } = await import('../paths.js')

const RUN = 'run-abc123'

describe('SkillDraftStore', () => {
  let store: InstanceType<typeof SkillDraftStore>

  before(() => {
    store = new SkillDraftStore()
  })

  it('writes and reads back an update draft with format reusable by SkillStore', async () => {
    const res = await store.writeDraft({
      runId: RUN,
      op: 'update',
      meta: { name: 'deploy-flow', description: 'How to deploy', tags: ['ops'] },
      body: '# Deploy\n\nstep 1',
      rationale: 'observed repeated deploy mistakes',
      authoredBy: 'ai',
      baseVersion: '1.0.3',
    })
    assert.equal(res.ok, true)

    const got = await store.readDraft(RUN, 'deploy-flow')
    assert.ok(got)
    assert.equal(got?.meta.name, 'deploy-flow')
    assert.equal(got?.body.trim(), '# Deploy\n\nstep 1')
    assert.equal(got?.record.op, 'update')
    assert.equal(got?.record.baseVersion, '1.0.3')
    assert.equal(got?.record.authoredBy, 'ai')
    assert.equal(got?.record.rationale, 'observed repeated deploy mistakes')

    // The staged SKILL.md must parse exactly like an authoritative one.
    const parsed = parseFrontmatter(got?.rawContent ?? '')
    assert.equal(parsed.meta.name, 'deploy-flow')
    assert.equal(parsed.meta.description, 'How to deploy')
    assert.deepEqual(parsed.meta.tags, ['ops'])
  })

  it('re-write preserves createdAt + baseVersion, bumps updatedAt, can switch author', async () => {
    const first = await store.readDraft(RUN, 'deploy-flow')
    const createdAt = first?.record.createdAt
    await new Promise((r) => setTimeout(r, 5))
    const res = await store.writeDraft({
      runId: RUN,
      op: 'update',
      meta: { name: 'deploy-flow', description: 'How to deploy v2' },
      body: 'manual tweak',
      authoredBy: 'user',
    })
    assert.equal(res.ok, true)
    const got = await store.readDraft(RUN, 'deploy-flow')
    assert.equal(got?.record.createdAt, createdAt) // preserved
    assert.equal(got?.record.baseVersion, '1.0.3') // inherited (not passed this time)
    assert.equal(got?.record.authoredBy, 'user') // switched (manual edit)
    assert.notEqual(got?.record.updatedAt, first?.record.updatedAt)
    assert.equal(got?.body.trim(), 'manual tweak')
  })

  it('rejects invalid skill name and invalid runId', async () => {
    const bad = await store.writeDraft({
      runId: RUN,
      meta: { name: 'Bad Name', description: 'x' },
      body: 'y',
    })
    assert.equal(bad.ok, false)
    const badRun = await store.writeDraft({
      runId: 'bad run id!',
      meta: { name: 'ok-name', description: 'x' },
      body: 'y',
    })
    assert.equal(badRun.ok, false)
  })

  it('delete-op draft carries no SKILL.md but a readable record', async () => {
    const res = await store.writeDraft({
      runId: RUN,
      op: 'delete',
      meta: { name: 'stale-skill', description: '' },
      body: '',
      rationale: 'obsolete',
    })
    assert.equal(res.ok, true)
    assert.equal(existsSync(paths.skillDraftMd(RUN, 'stale-skill')), false)
    const got = await store.readDraft(RUN, 'stale-skill')
    assert.equal(got?.record.op, 'delete')
    assert.equal(got?.rawContent, '')
  })

  it('lists drafts in a run and discards one + whole run', async () => {
    const list = await store.listDrafts(RUN)
    const names = list.map((d) => d.name).sort()
    assert.deepEqual(names, ['deploy-flow', 'stale-skill'])

    const del = await store.deleteDraft(RUN, 'stale-skill')
    assert.equal(del.ok, true)
    assert.equal((await store.listDrafts(RUN)).length, 1)

    const delRun = await store.deleteRun(RUN)
    assert.equal(delRun.ok, true)
    assert.equal((await store.listDrafts(RUN)).length, 0)
    assert.equal(existsSync(paths.skillDraftRunDir(RUN)), false)
  })

  it('a promoted draft round-trips cleanly into an authoritative SkillStore', async () => {
    await store.writeDraft({
      runId: 'run-merge',
      op: 'create',
      meta: { name: 'new-skill', description: 'fresh', tags: ['x'] },
      body: 'authoritative body',
      baseVersion: null,
    })
    const draft = await store.readDraft('run-merge', 'new-skill')
    assert.ok(draft)
    // Merge = hand the draft's meta+body to the real store. No reformatting needed.
    const skillStore = new SkillStore('main', { sharedDir: paths.sharedSkillsDir })
    const saved = await skillStore.save(draft!.meta, draft!.body)
    assert.equal(saved.ok, true)
    const live = await skillStore.view('new-skill')
    assert.ok(live && typeof live !== 'string')
    if (live && typeof live !== 'string') {
      assert.equal(live.body.trim(), 'authoritative body')
      assert.equal(live.version, '1.0.0')
    }
    await store.deleteRun('run-merge')
  })
})
