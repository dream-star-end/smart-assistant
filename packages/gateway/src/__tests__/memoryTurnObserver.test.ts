import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

const TEST_HOME = mkdtempSync(join(tmpdir(), 'oc-mem-turn-obs-'))
process.env.OPENCLAUDE_HOME = TEST_HOME

const {
  beginMemoryTurnTracking,
  captureMemorySnapshot,
  isCurrentEvidenceTool,
  recordSnapshotDiff,
} = await import('../memoryTurnObserver.js')
const { MemoryDir, closeSessionsDb, getSessionsDb } = await import('@openclaude/storage')

describe('memory freshness evidence classifier', () => {
  test('accepts authoritative live checks', () => {
    assert.equal(
      isCurrentEvidenceTool({
        toolName: 'Bash',
        inputPreview: JSON.stringify({ command: 'curl -fsS http://127.0.0.1:18790/healthz' }),
      }),
      true,
    )
    assert.equal(
      isCurrentEvidenceTool({
        toolName: 'Read',
        inputPreview: JSON.stringify({ file_path: '/opt/openclaude/MANIFEST.json' }),
      }),
      true,
    )
    assert.equal(isCurrentEvidenceTool({ toolName: 'WebSearch', inputPreview: '{}' }), true)
  })

  test('does not mistake memory lookup for current evidence', () => {
    assert.equal(
      isCurrentEvidenceTool({
        toolName: 'Bash',
        inputPreview: JSON.stringify({ command: 'oc-memory core-search "当前版本"' }),
      }),
      false,
    )
    assert.equal(
      isCurrentEvidenceTool({
        toolName: 'Read',
        inputPreview: JSON.stringify({
          file_path: '/home/agent/.openclaude/agents/main/memory/release.md',
        }),
      }),
      false,
    )
  })
})

describe('turn_snapshot shared memory dir attribution', () => {
  after(async () => {
    await closeSessionsDb()
  })

  test('captureMemorySnapshot records realpath of a shared symlink onto main', async () => {
    const mainDir = join(TEST_HOME, 'agents', 'main', 'memory')
    const auditorDir = join(TEST_HOME, 'agents', 'auditor', 'memory')
    mkdirSync(mainDir, { recursive: true })
    mkdirSync(join(TEST_HOME, 'agents', 'auditor'), { recursive: true })
    symlinkSync(mainDir, auditorDir)
    writeFileSync(join(mainDir, 'shared.md'), 'from-main')

    const snap = await captureMemorySnapshot('auditor')
    const expectedReal = await realpath(mainDir)
    assert.equal(snap.dirRealPath, expectedReal)
    assert.equal(new MemoryDir('auditor').dirPath(), auditorDir)
    assert.notEqual(snap.dirRealPath, auditorDir)
    assert.equal(snap.core.has('shared.md'), true)
  })

  test('recordSnapshotDiff marks shared-symlink writes as attribution-ambiguous', async () => {
    const mainDir = join(TEST_HOME, 'agents', 'main', 'memory')
    const auditorDir = join(TEST_HOME, 'agents', 'auditor', 'memory')
    mkdirSync(mainDir, { recursive: true })
    mkdirSync(join(TEST_HOME, 'agents', 'auditor'), { recursive: true })
    try {
      symlinkSync(mainDir, auditorDir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    writeFileSync(join(mainDir, 'alpha.md'), 'before')

    const sessionKey = 'agent:auditor:webchat:dm:shared-symlink-attr'
    await beginMemoryTurnTracking({
      sessionKey,
      turnIndex: 1,
      agentId: 'auditor',
      userText: 'hello',
    })
    writeFileSync(join(mainDir, 'beta.md'), 'after')
    await recordSnapshotDiff({ sessionKey, turnIndex: 1, agentId: 'auditor' })

    const db = await getSessionsDb()
    const rows = db
      .prepare(
        `SELECT operation, outcome, metadata_json FROM memory_usage_events
          WHERE session_key=? AND operation IN ('core_write','core_update','core_delete')`,
      )
      .all(sessionKey) as Array<{ operation: string; outcome: string; metadata_json: string }>
    assert.ok(rows.length >= 1, 'expected at least one snapshot write event')
    for (const row of rows) {
      assert.equal(row.outcome, 'success')
      const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>
      assert.equal(metadata.source, 'turn_snapshot')
      assert.equal(metadata.shared, true)
      assert.equal(metadata.attribution, 'ambiguous')
    }
  })

  test('recordSnapshotDiff keeps literal attribution when memory dir is not a symlink', async () => {
    const soloDir = join(TEST_HOME, 'agents', 'solo', 'memory')
    mkdirSync(soloDir, { recursive: true })
    writeFileSync(join(soloDir, 'alpha.md'), 'before')

    const sessionKey = 'agent:solo:webchat:dm:private-memory-dir'
    await beginMemoryTurnTracking({
      sessionKey,
      turnIndex: 1,
      agentId: 'solo',
      userText: 'hello',
    })
    writeFileSync(join(soloDir, 'beta.md'), 'after')
    await recordSnapshotDiff({ sessionKey, turnIndex: 1, agentId: 'solo' })

    const db = await getSessionsDb()
    const rows = db
      .prepare(
        `SELECT operation, outcome, metadata_json FROM memory_usage_events
          WHERE session_key=? AND operation IN ('core_write','core_update','core_delete')`,
      )
      .all(sessionKey) as Array<{ operation: string; outcome: string; metadata_json: string }>
    assert.ok(rows.length >= 1, 'expected at least one snapshot write event')
    for (const row of rows) {
      assert.equal(row.outcome, 'success')
      const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>
      assert.deepEqual(metadata, { source: 'turn_snapshot' })
    }
  })
})
