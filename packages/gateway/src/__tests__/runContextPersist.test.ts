/**
 * Run: npx tsx --test packages/gateway/src/__tests__/runContextPersist.test.ts
 */
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const home = mkdtempSync(join(tmpdir(), 'oc-persist-rc-'))
process.env.OPENCLAUDE_HOME = home
process.env.OC_PROJECT_CONTEXT = '1'

const { persistRunContextSnapshot, createRunContextDescriptor } = await import('../runContextPersist.js')
const { getTaskboardDb } = await import('../taskboard/db/index.js')
const { createProject } = await import('../taskboard/db/projects.js')
const { createTicket } = await import('../taskboard/db/tickets.js')
const { insertRun, getRun } = await import('../taskboard/db/runs.js')
const { TASKBOARD_SCHEMA_VERSION } = await import('../taskboard/db/schema.js')

describe('persistRunContextSnapshot', () => {
  it('flag off is a no-op', async () => {
    const r = await persistRunContextSnapshot({
      descriptor: createRunContextDescriptor({
        runId: 'x',
        boardProjectId: '11111111-1111-4111-8111-111111111111',
        channel: 'webchat',
        agentId: 'main',
        sessionKey: 'sk',
        persistSnapshot: true,
      }),
      applied: [],
      cwd: home,
    })
    // env was set to 1 at import; simulate off by persistSnapshot false
    const off = await persistRunContextSnapshot({
      descriptor: createRunContextDescriptor({
        runId: 'x',
        channel: 'webchat',
        agentId: 'main',
        sessionKey: 'sk',
        persistSnapshot: false,
      }),
      applied: [],
      cwd: home,
    })
    assert.equal(off.wrote, false)
    void r
  })

  it('writes snapshot and backfills taskboard columns; old runs stay nullable', async () => {
    const db = getTaskboardDb()
    assert.equal(TASKBOARD_SCHEMA_VERSION, 7)
    const project = createProject(db, { key: 'SNAP', name: 'snap' })
    const ticket = createTicket(db, {
      projectId: project.id,
      type: 'chore',
      title: 't',
      reporter: 'user:default',
    })
    const run = insertRun(db, {
      ticketId: ticket.id,
      stageId: ticket.stageId ?? 'none',
      trigger: 'patrol',
      agentId: 'stage-implement',
    })
    assert.equal(run.contextSnapshotId, null)
    const result = await persistRunContextSnapshot({
      descriptor: createRunContextDescriptor({
        runId: run.id,
        boardProjectId: project.id,
        channel: 'taskboard',
        agentId: 'stage-implement',
        sessionKey: 'sk',
        ticket: { id: ticket.id, identifier: ticket.identifier, version: ticket.version },
        persistSnapshot: true,
      }),
      applied: [
        { name: 'USER', bytes: 4, sha256: 'aa' },
        { name: 'ENV', bytes: 2, sha256: 'bb' },
      ],
      cwd: home,
      cwdSource: 'project_workspace',
      frozen: {
        contextVersion: 7,
        assetsRevision: 3,
        projectMdSha256: 'md',
        skillManifestSha256: 'sk',
        officialMemoryManifestSha256: 'mem',
      },
    })
    assert.equal(result.wrote, true)
    const updated = getRun(db, run.id)
    assert.ok(updated?.contextSha256)
    assert.ok(updated?.contextSnapshotId)
    assert.equal(updated?.contextVersion, 7)
  })

  it('does not re-read meta/ledger after freeze; later promote stays off the snapshot', async () => {
    const { writeProjectInstructions } = await import('@openclaude/storage')
    const { readProjectRunContextFile } = await import('../runContextPersist.js')
    const db = getTaskboardDb()
    const project = createProject(db, { key: 'RACE', name: 'race' })
    const first = await writeProjectInstructions(project.id, 'old-ins', 0)
    assert.equal(first.ok, true)
    const ticket = createTicket(db, {
      projectId: project.id,
      type: 'chore',
      title: 't',
      reporter: 'user:default',
    })
    const run = insertRun(db, {
      ticketId: ticket.id,
      stageId: ticket.stageId ?? 'none',
      trigger: 'patrol',
      agentId: 'stage-implement',
    })
    const frozen = {
      contextVersion: first.ok ? first.snapshot.version : 1,
      assetsRevision: 1,
      projectMdSha256: first.ok ? first.snapshot.meta.instructionsSha256 ?? 'old' : 'old',
      skillManifestSha256: 'sk-old',
      officialMemoryManifestSha256: 'mem-old',
    }
    await writeProjectInstructions(project.id, 'new-ins', frozen.contextVersion)
    const result = await persistRunContextSnapshot({
      descriptor: createRunContextDescriptor({
        runId: run.id,
        boardProjectId: project.id,
        channel: 'taskboard',
        agentId: 'stage-implement',
        sessionKey: 'sk',
        persistSnapshot: true,
      }),
      applied: [{ name: 'PROJECT', bytes: 8, sha256: 'proj' }],
      cwd: home,
      frozen,
    })
    assert.equal(result.wrote, true)
    assert.equal(result.contextVersion, frozen.contextVersion)
    const snap = await readProjectRunContextFile(project.id, run.id)
    assert.equal(snap?.contextVersion, frozen.contextVersion)
    assert.equal(snap?.hashes.projectMdSha256, frozen.projectMdSha256)
  })

  it('writer fail-soft returns wrote=false instead of throwing', async () => {
    const r = await persistRunContextSnapshot({
      descriptor: createRunContextDescriptor({
        runId: 'bad',
        boardProjectId: 'not-a-uuid',
        channel: 'webchat',
        agentId: 'main',
        sessionKey: 'sk',
        persistSnapshot: true,
      }),
      applied: [],
      cwd: '/nope',
    })
    assert.equal(r.wrote, false)
  })
})

describe('five engines hook persistRunContextSnapshot', () => {
  const files = [
    'packages/gateway/src/subprocessRunner.ts',
    'packages/gateway/src/codexLaunchOverrides.ts',
    'packages/gateway/src/engine/cursorAdapter.ts',
    'packages/gateway/src/engine/grokAdapter.ts',
    'packages/gateway/src/engine/zcodeAdapter.ts',
  ]
  for (const file of files) {
    it(file, () => {
      const src = readFileSync(join(process.cwd(), file), 'utf8')
      assert.match(src, /persistRunContextSnapshot/)
    })
  }
})
