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

const { persistRunContextSnapshot, createRunContextDescriptor, webchatRunId, readProjectRunContextFile, adoptRunContext } =
  await import('../runContextPersist.js')
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
    assert.equal(TASKBOARD_SCHEMA_VERSION, 10)
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

describe('webchat run ids', () => {
  it('a later turn moves the run id into the descriptor the engine already holds', () => {
    const base = {
      boardProjectId: '22222222-2222-4222-8222-222222222222',
      channel: 'webchat',
      agentId: 'main',
      sessionKey: 'agent:main:webchat:dm:wsess-0123456789abcdef',
      persistSnapshot: true,
    }
    const held = createRunContextDescriptor({ ...base, runId: 'webchat:wsess-0123456789abcdef:trace-a' })
    const engineView = held
    const next = createRunContextDescriptor({ ...base, runId: 'webchat:wsess-0123456789abcdef:trace-b' })
    const adopted = adoptRunContext(held, next)
    assert.equal(adopted, held)
    assert.equal(engineView.runId, 'webchat:wsess-0123456789abcdef:trace-b')
    // Another project: the new descriptor is taken as is, the old one untouched.
    const other = createRunContextDescriptor({ ...base, boardProjectId: '33333333-3333-4333-8333-333333333333', runId: 'x' })
    assert.equal(adoptRunContext(held, other), other)
    assert.equal(held.runId, 'webchat:wsess-0123456789abcdef:trace-b')
    assert.equal(adoptRunContext(undefined, next), next)
  })


  it('two turns of one chat keep two snapshots instead of overwriting one', async () => {
    const board = '22222222-2222-4222-8222-222222222222'
    const ids = [webchatRunId('wsess-0123456789abcdef', 'trace-a'), webchatRunId('wsess-0123456789abcdef', 'trace-b')]
    assert.notEqual(ids[0], ids[1])
    const written: string[] = []
    for (const [i, runId] of ids.entries()) {
      const r = await persistRunContextSnapshot({
        descriptor: createRunContextDescriptor({
          runId,
          boardProjectId: board,
          channel: 'webchat',
          agentId: 'main',
          sessionKey: 'agent:main:webchat:dm:wsess-0123456789abcdef',
          persistSnapshot: true,
        }),
        applied: [{ name: 'USER', bytes: 1, sha256: String(i) }],
        cwd: home,
      })
      assert.equal(r.wrote, true)
      written.push(r.snapshotId!)
    }
    assert.notEqual(written[0], written[1])
    for (const [i, id] of written.entries()) {
      const snap = await readProjectRunContextFile(board, id)
      assert.equal(snap?.runId, ids[i])
    }
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
