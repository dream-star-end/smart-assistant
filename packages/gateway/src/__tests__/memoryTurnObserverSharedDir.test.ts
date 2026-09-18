/**
 * MSC MEM-13:isSharedMemoryDir 的判据是「realpath 后是否仍在本 agent 目录树内」,
 * 不是 `realpath !== 词法路径`。用一个 **经 junction/symlink 进入的 HOME** 复现:HOME 本身
 * 是链接时每个 agent 的 memory/ realpath 都与词法路径不同,旧判据会把独占目录全部误判为共享。
 *
 * 目录链接用 'junction' 类型:Windows 上无需管理员权限;Linux/macOS 上等价于普通 symlink。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/memoryTurnObserverSharedDir.test.ts
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

const REAL_HOME = mkdtempSync(join(tmpdir(), 'oc-mem-shared-real-'))
const LINK_PARENT = mkdtempSync(join(tmpdir(), 'oc-mem-shared-link-'))
const LINKED_HOME = join(LINK_PARENT, 'home')
symlinkSync(REAL_HOME, LINKED_HOME, 'junction')
process.env.OPENCLAUDE_HOME = LINKED_HOME

const { isSharedMemoryDir, beginMemoryTurnTracking, recordSnapshotDiff } = await import(
  '../memoryTurnObserver.js'
)
const { MemoryDir, closeSessionsDb, getSessionsDb, paths } = await import('@openclaude/storage')

describe('MEM-13 shared memory dir detection', () => {
  after(async () => {
    await closeSessionsDb()
  })

  test('HOME 经链接进入时,独占的 memory/ 不被误判为共享', async () => {
    const soloDir = paths.agentMemoryDir('solo')
    mkdirSync(soloDir, { recursive: true })
    writeFileSync(join(soloDir, 'a.md'), 'x')
    // 前置:词法路径 ≠ realpath(旧判据在这里必然为 true)
    assert.notEqual(await import('node:fs/promises').then((m) => m.realpath(soloDir)), soloDir)
    assert.equal(await isSharedMemoryDir('solo'), false)
  })

  test('memory/ 是指向别的 agent 的链接 → 判为共享', async () => {
    const mainDir = paths.agentMemoryDir('main')
    mkdirSync(mainDir, { recursive: true })
    mkdirSync(paths.agentDir('auditor'), { recursive: true })
    symlinkSync(mainDir, paths.agentMemoryDir('auditor'), 'junction')
    assert.equal(new MemoryDir('auditor').dirPath(), paths.agentMemoryDir('auditor'))
    assert.equal(await isSharedMemoryDir('auditor'), true)
    assert.equal(await isSharedMemoryDir('main'), false)
  })

  test('memory/ 不存在 → 不算共享(realpath 失败按独占处理)', async () => {
    assert.equal(await isSharedMemoryDir('never-created'), false)
  })

  test('快照 diff 事件:独占目录不盖 attribution:ambiguous', async () => {
    const soloDir = paths.agentMemoryDir('solo2')
    mkdirSync(soloDir, { recursive: true })
    writeFileSync(join(soloDir, 'alpha.md'), 'before')
    const sessionKey = 'agent:solo2:webchat:dm:linked-home'
    await beginMemoryTurnTracking({ sessionKey, turnIndex: 1, agentId: 'solo2', userText: 'hi' })
    writeFileSync(join(soloDir, 'beta.md'), 'after')
    await recordSnapshotDiff({ sessionKey, turnIndex: 1, agentId: 'solo2' })
    const db = await getSessionsDb()
    const rows = db
      .prepare(
        `SELECT metadata_json FROM memory_usage_events
          WHERE session_key=? AND operation IN ('core_write','core_update','core_delete')`,
      )
      .all(sessionKey) as Array<{ metadata_json: string }>
    assert.ok(rows.length >= 1)
    for (const row of rows) {
      assert.deepEqual(JSON.parse(row.metadata_json), { source: 'turn_snapshot' })
    }
  })
})
