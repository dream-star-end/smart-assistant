/**
 * Run: npx tsx --test packages/storage/src/__tests__/projectRunSnapshot.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const home = await mkdtemp(join(tmpdir(), 'oc-run-snap-'))
process.env.OPENCLAUDE_HOME = home

const {
  classifySlot,
  createRunContextDescriptor,
  emptyProjectRunSnapshot,
  pruneProjectRunSnapshots,
  readProjectRunContextFile,
  writeProjectRunContextFile,
  PROJECT_RUN_SNAPSHOT_KEEP,
} = await import('../projectRunSnapshot.js')

const ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff'

describe('RunContextDescriptor', () => {
  it('does not persist without a board uuid', () => {
    const d = createRunContextDescriptor({
      runId: 'webchat:x',
      channel: 'webchat',
      agentId: 'main',
      sessionKey: 'sk',
    })
    assert.equal(d.boardProjectId, null)
    assert.equal(d.persistSnapshot, false)
  })
})

describe('snapshot writer', () => {
  it('atomically writes and classifies volatile/redacted slots', async () => {
    const snap = emptyProjectRunSnapshot({
      runId: 'run-1',
      boardProjectId: ID,
      contextVersion: 3,
      createdAt: Date.now(),
      agentId: 'stage-implement',
      channel: 'taskboard',
      sessionKey: 'sk',
      workspace: {
        spec: { kind: 'isolated' },
        cwd: join(home, 'workspace', 'projects', ID),
        cwdRealpath: null,
        cwdSource: 'project_workspace',
        sessionRepoOverlay: false,
      },
      hashes: {
        slots: [
          { name: 'ENV', bytes: 10, sha256: 'aa', ...classifySlot('ENV') },
          { name: 'USER', bytes: 4, sha256: 'bb', ...classifySlot('USER') },
          { name: 'PROJECT_MEMORY', bytes: 8, sha256: 'cc', ...classifySlot('PROJECT_MEMORY') },
        ],
      },
      promotion: { officialCount: 0, officialManifestSha256: null },
    })
    const written = await writeProjectRunContextFile(snap)
    assert.equal(written.sha256.length, 64)
    const loaded = await readProjectRunContextFile(ID, 'run-1')
    assert.ok(loaded)
    assert.equal(loaded?.replay, 'audit_only_not_bit_identical')
    assert.equal(loaded?.hashes.slots.find((s) => s.name === 'ENV')?.volatile, true)
    assert.equal(loaded?.hashes.slots.find((s) => s.name === 'USER')?.redacted, true)
    assert.equal(loaded?.conflictPolicy, 'run_isolated')
  })

  it('prunes older than keep window fail-soft', async () => {
    const { paths } = await import('../paths.js')
    const root = paths.projectRunsDir(ID)
    await mkdir(root, { recursive: true })
    for (let i = 0; i < PROJECT_RUN_SNAPSHOT_KEEP + 5; i++) {
      const dir = join(root, `old-${i}`)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'context.json'), '{"schemaVersion":1}\n')
    }
    await pruneProjectRunSnapshots(ID)
    const { readdir } = await import('node:fs/promises')
    const left = await readdir(root)
    assert.ok(left.length <= PROJECT_RUN_SNAPSHOT_KEEP + 1)
  })
})
