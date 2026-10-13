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
const { MemoryDir, closeSessionsDb, getSessionsDb, recordMemoryUsageEvent } = await import(
  '@openclaude/storage'
)

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
      assert.equal(metadata.writer, undefined)
    }
    const used = db
      .prepare(
        `SELECT memory_used FROM memory_turn_context WHERE session_key=? AND turn_index=1`,
      )
      .get(sessionKey) as { memory_used: number }
    assert.equal(used.memory_used, 0)
  })

  test('recordSnapshotDiff marks a private memory dir as attribution unknown and does not use memory', async () => {
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
      assert.equal(metadata.source, 'turn_snapshot')
      assert.equal(metadata.attribution, 'unknown')
      assert.equal(metadata.writer, undefined)
      assert.equal(metadata.shared, undefined)
    }
    const reasons = db
      .prepare(
        `SELECT policy_reason FROM memory_usage_events
          WHERE session_key=? AND operation IN ('core_write','core_update','core_delete','profile_write')`,
      )
      .all(sessionKey) as Array<{ policy_reason: string | null }>
    assert.ok(reasons.length >= 1)
    for (const row of reasons) assert.equal(row.policy_reason, 'snapshot_unattributed')
    const used = db
      .prepare(
        `SELECT memory_used FROM memory_turn_context WHERE session_key=? AND turn_index=1`,
      )
      .get(sessionKey) as { memory_used: number }
    assert.equal(used.memory_used, 0)
  })
})

describe('non-empty core is not an injection receipt', () => {
  test('beginTracking does not emit index_injected or mark the turn used; real read and search still do', async () => {
    const agentId = 'visible-core'
    const dir = join(TEST_HOME, 'agents', agentId, 'memory')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'notes.md'), 'slug-body-not-telemetry')

    const sessionKey = 'agent:visible-core:webchat:dm:nonempty-core'
    await beginMemoryTurnTracking({
      sessionKey,
      turnIndex: 7,
      agentId,
      userText: '当前服务是不是已经上线了',
    })

    const db = await getSessionsDb()
    const injected = db
      .prepare(
        `SELECT event_id, metadata_json FROM memory_usage_events
          WHERE session_key=? AND operation='index_injected'`,
      )
      .all(sessionKey) as Array<{ event_id: string; metadata_json: string }>
    assert.equal(injected.length, 0)
    const afterBegin = db
      .prepare(
        `SELECT memory_used FROM memory_turn_context WHERE session_key=? AND turn_index=7`,
      )
      .get(sessionKey) as { memory_used: number }
    assert.equal(afterBegin.memory_used, 0)

    await recordMemoryUsageEvent({
      eventId: 'visible-core-search',
      agentId,
      sessionKey,
      turnIndex: 7,
      operation: 'core_search',
      memoryType: 'core',
      outcome: 'hit',
      resultCount: 1,
    })
    await recordMemoryUsageEvent({
      eventId: 'visible-core-read',
      agentId,
      sessionKey,
      turnIndex: 7,
      operation: 'core_read',
      memoryType: 'core',
      outcome: 'success',
      metadata: { source: 'native_read_tool' },
    })

    const real = db
      .prepare(
        `SELECT operation, metadata_json FROM memory_usage_events
          WHERE session_key=? AND operation IN ('core_search','core_read')
          ORDER BY operation`,
      )
      .all(sessionKey) as Array<{ operation: string; metadata_json: string }>
    assert.deepEqual(
      real.map((row) => row.operation),
      ['core_read', 'core_search'],
    )
    assert.equal(JSON.stringify(real).includes('slug-body-not-telemetry'), false)
    const afterReal = db
      .prepare(
        `SELECT memory_used FROM memory_turn_context WHERE session_key=? AND turn_index=7`,
      )
      .get(sessionKey) as { memory_used: number }
    assert.equal(afterReal.memory_used, 1)
    const stillNoIndex = db
      .prepare(
        `SELECT COUNT(*) AS value FROM memory_usage_events
          WHERE session_key=? AND operation='index_injected'`,
      )
      .get(sessionKey) as { value: number }
    assert.equal(stillNoIndex.value, 0)
  })
})
