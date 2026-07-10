/**
 * 长会话热尾巴 + 归档(spill/archive)存储层单测。锁死设计合同 §1:
 *   - spill 边界:阈值内不动 / 超阈值搬到 target / 尾巴最少 64 条 / chunk 切分正确 /
 *     _seq 冻结 / 水位与计数正确;
 *   - 幂等:同批重放 archivedDelta=0、chunk PK 冲突 INSERT OR IGNORE、append 已归档 id
 *     → already_exists;
 *   - PUT 防复活:incoming 含已归档 id 被过滤,行不回涨;
 *   - cost-patch 命中归档 → noop;未命中 → pending 不变;
 *   - readArchivedMessages 分页:跨 chunk、beforeSeq 游标、hasMore、升序;
 *   - 增量协议兼容:spill 后 ?since=<老游标> 返回的 tail 不空、isPartial 语义不变。
 *
 * 全部用真 SQLite(临时文件),行为断言。
 *
 * Run: npx tsx --test packages/storage/src/__tests__/sessionsArchiveSpill.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, it } from 'node:test'

const testHome = await mkdtemp(join(tmpdir(), 'oc-archive-spill-'))
process.env.OPENCLAUDE_HOME = testHome

const {
  _spillOverflowCore,
  appendCostCredits,
  appendServerAuthoredMessage,
  ARCHIVE_CHUNK_MAX_BYTES,
  ARCHIVE_CHUNK_MAX_MSGS,
  getClientSession,
  getClientSessionPartial,
  getSessionsDb,
  readArchivedMessages,
  SESSION_TAIL_MIN_MSGS,
  SESSION_TAIL_TARGET_BYTES,
  upsertClientSession,
} = await import('../sessionsDb.js')

type Msg = {
  id: string
  role: string
  text: string
  ts: number
  _seq?: number
  _source?: string
  [k: string]: unknown
}

const USER = 'u-archive'

/**
 * 造一条序列化字节 ≈ approxBytes 的消息。默认 role='user':user 是 turn 边界,
 * 永不被 mergePreservingServerAuthored 的 assistant/thinking/tool 幻影去重命中,
 * 让批量消息在"追加一条 server assistant"时不会被整组吞掉(spill 测试要保留它们)。
 */
function makeMsg(id: string, ts: number, seq: number | undefined, approxBytes: number, source: 'server' | 'client' = 'server'): Msg {
  const base: Msg = { id, role: 'user', text: '', ts }
  if (seq !== undefined) base._seq = seq
  if (source === 'server') base._source = 'server'
  const overhead = Buffer.byteLength(JSON.stringify({ ...base, text: '' }), 'utf8')
  const pad = Math.max(0, approxBytes - overhead)
  base.text = 'x'.repeat(pad)
  return base
}

/** 造 count 条、每条 ≈ approxBytes、_seq = 1..count 的服务端消息。 */
function makeMsgs(count: number, approxBytes: number, prefix = 'm'): Msg[] {
  const out: Msg[] = []
  for (let i = 0; i < count; i++) out.push(makeMsg(`${prefix}-${i}`, 1000 + i, i + 1, approxBytes))
  return out
}

async function clearTables(): Promise<void> {
  const db = await getSessionsDb()
  db.exec(`
    DELETE FROM client_sessions;
    DELETE FROM client_session_archive_chunks;
    DELETE FROM client_session_archived_ids;
    DELETE FROM server_authored_request_map;
    DELETE FROM pending_usage_patches;
  `)
}

async function chunkRows(sessId: string): Promise<Array<{ first_seq: number; last_seq: number; message_count: number; messages: string }>> {
  const db = await getSessionsDb()
  return db.prepare(
    'SELECT first_seq, last_seq, message_count, messages FROM client_session_archive_chunks WHERE session_id = ? ORDER BY first_seq ASC',
  ).all(sessId) as Array<{ first_seq: number; last_seq: number; message_count: number; messages: string }>
}

async function archivedIdCount(sessId: string): Promise<number> {
  const db = await getSessionsDb()
  const r = db.prepare('SELECT COUNT(*) AS n FROM client_session_archived_ids WHERE session_id = ?').get(sessId) as { n: number }
  return r.n
}

async function rowMessages(sessId: string): Promise<Msg[]> {
  const db = await getSessionsDb()
  const row = db.prepare('SELECT messages FROM client_sessions WHERE id = ? AND user_id = ?').get(sessId, USER) as { messages: string } | undefined
  return row ? (JSON.parse(row.messages) as Msg[]) : []
}

beforeEach(async () => {
  await clearTables()
})

// ── _spillOverflowCore 直测 ──────────────────────────────────────────────────

describe('_spillOverflowCore — 边界', () => {
  it('阈值内不动:tail 原样返回(同引用),不写归档', async () => {
    const db = await getSessionsDb()
    const msgs = makeMsgs(10, 1024) // ~10KB « 2.5MB
    const r = _spillOverflowCore(db, 'sess-under', USER, msgs, { currentArchivedThroughSeq: 0 })
    assert.equal(r.tail, msgs, 'tail 是同一引用(零副作用快路径)')
    assert.equal(r.archivedDelta, 0)
    assert.equal(r.archivedThroughSeq, 0)
    assert.equal((await chunkRows('sess-under')).length, 0)
  })

  it('超阈值:搬到 target 附近、尾巴 ≥ 64、spilled+tail=原集、水位=max(spilled._seq)', async () => {
    const db = await getSessionsDb()
    const N = 300
    const msgs = makeMsgs(N, 11 * 1024) // ~3.3MB 触发
    const r = _spillOverflowCore(db, 'sess-B', USER, msgs, { currentArchivedThroughSeq: 0 })
    const spilledCount = N - r.tail.length
    assert.ok(r.tail.length >= SESSION_TAIL_MIN_MSGS, `尾巴 ≥ ${SESSION_TAIL_MIN_MSGS}`)
    assert.ok(spilledCount > 0, '确实搬走了一些')
    // 尾巴序列化字节 ≤ target + 一条消息的宽容(软目标)
    const tailBytes = Buffer.byteLength(JSON.stringify(r.tail), 'utf8')
    assert.ok(tailBytes <= SESSION_TAIL_TARGET_BYTES + 12 * 1024, `尾巴字节 ${tailBytes} ≈ ≤ target`)
    assert.equal(r.archivedDelta, spilledCount, 'archivedDelta = 本次搬走条数')
    // 搬走的是最老的一段:_seq 1..spilledCount,水位 = spilledCount
    assert.equal(r.archivedThroughSeq, spilledCount, '水位 = max(spilled._seq)')
    // 归档表条数一致
    const chunks = await chunkRows('sess-B')
    const sumChunk = chunks.reduce((a, c) => a + c.message_count, 0)
    assert.equal(sumChunk, spilledCount, 'chunk 总条数 = 搬走条数')
    assert.equal(await archivedIdCount('sess-B'), spilledCount, 'id 集条数 = 搬走条数')
    // 尾巴是最新的一段:第一条 _seq = spilledCount+1(冻结未变)
    assert.equal((r.tail[0] as Msg)._seq, spilledCount + 1, '尾巴首条 _seq 冻结')
  })

  it('尾巴下限优先:溢出集中在最新 64 条时,尾巴恰为 64(即便仍 > target)', async () => {
    const db = await getSessionsDb()
    const N = 70
    const msgs = makeMsgs(N, 50 * 1024) // ~3.5MB;maxSpill = 70-64 = 6
    const r = _spillOverflowCore(db, 'sess-C', USER, msgs, { currentArchivedThroughSeq: 0 })
    assert.equal(r.tail.length, SESSION_TAIL_MIN_MSGS, '尾巴被下限钳到 64')
    assert.equal(r.archivedDelta, N - SESSION_TAIL_MIN_MSGS, '只搬 6 条')
  })

  it('_seq 冻结:归档消息 _seq 与原值一致,尾巴 _seq 不变不重排', async () => {
    const db = await getSessionsDb()
    const N = 300
    const msgs = makeMsgs(N, 11 * 1024)
    const r = _spillOverflowCore(db, 'sess-seq', USER, msgs, { currentArchivedThroughSeq: 0 })
    // 展开所有 chunk,校验每条归档消息 _seq === 原 msgs 里同 id 的 _seq
    const byId = new Map(msgs.map((m) => [m.id, m._seq]))
    for (const c of await chunkRows('sess-seq')) {
      for (const m of JSON.parse(c.messages) as Msg[]) {
        assert.equal(m._seq, byId.get(m.id), `归档 ${m.id} 的 _seq 冻结`)
      }
    }
    // 尾巴 _seq 严格递增、且等于原值
    for (const m of r.tail as Msg[]) assert.equal(m._seq, byId.get(m.id), `尾巴 ${m.id} 的 _seq 不变`)
  })
})

describe('_spillOverflowCore — chunk 切分', () => {
  function assertChunkInvariants(chunks: Array<{ message_count: number; messages: string }>, spilledCount: number): void {
    let sum = 0
    for (const c of chunks) {
      sum += c.message_count
      assert.ok(c.message_count <= ARCHIVE_CHUNK_MAX_MSGS, `chunk 条数 ${c.message_count} ≤ ${ARCHIVE_CHUNK_MAX_MSGS}`)
      const bytes = Buffer.byteLength(c.messages, 'utf8')
      // 字节上限:除非单条消息本身就 >768KB(独立成 chunk)
      assert.ok(
        bytes <= ARCHIVE_CHUNK_MAX_BYTES || c.message_count === 1,
        `chunk 字节 ${bytes} ≤ ${ARCHIVE_CHUNK_MAX_BYTES}(或单条超限独立成 chunk)`,
      )
    }
    assert.equal(sum, spilledCount, 'chunk 总条数 = 搬走条数')
  }

  it('小消息:按 200 条计数上限切', async () => {
    const db = await getSessionsDb()
    const N = 1500
    const msgs = makeMsgs(N, 2 * 1024) // 200 条 = ~400KB < 768KB,计数上限先到
    const r = _spillOverflowCore(db, 'sess-count', USER, msgs, { currentArchivedThroughSeq: 0 })
    const spilledCount = N - r.tail.length
    const chunks = await chunkRows('sess-count')
    assert.ok(chunks.length >= 2, '多 chunk')
    assertChunkInvariants(chunks, spilledCount)
    // 至少有一个满 200 的 chunk(证明计数上限确实生效)
    assert.ok(chunks.some((c) => c.message_count === ARCHIVE_CHUNK_MAX_MSGS), '存在满 200 的 chunk')
  })

  it('大消息:按 768KB 字节上限切(不足 200 条即封 chunk)', async () => {
    const db = await getSessionsDb()
    const N = 260
    const msgs = makeMsgs(N, 30 * 1024) // ~7.8MB;30KB → ~25 条即达 768KB
    const r = _spillOverflowCore(db, 'sess-bytes', USER, msgs, { currentArchivedThroughSeq: 0 })
    const spilledCount = N - r.tail.length
    const chunks = await chunkRows('sess-bytes')
    assert.ok(chunks.length >= 2, '多 chunk')
    assertChunkInvariants(chunks, spilledCount)
    assert.ok(chunks.every((c) => c.message_count < ARCHIVE_CHUNK_MAX_MSGS), '字节上限先到,无满 200 chunk')
  })
})

describe('_spillOverflowCore — 幂等', () => {
  it('同批重放:第二次 archivedDelta=0、chunk 不新增、水位不变', async () => {
    const db = await getSessionsDb()
    const msgs = makeMsgs(300, 11 * 1024)
    const r1 = _spillOverflowCore(db, 'sess-idem', USER, msgs, { currentArchivedThroughSeq: 0 })
    const chunks1 = (await chunkRows('sess-idem')).length
    const r2 = _spillOverflowCore(db, 'sess-idem', USER, msgs, { currentArchivedThroughSeq: r1.archivedThroughSeq })
    assert.equal(r2.archivedDelta, 0, '重放不重复计')
    assert.equal(r2.archivedThroughSeq, r1.archivedThroughSeq, '水位不变')
    assert.equal((await chunkRows('sess-idem')).length, chunks1, 'chunk 数不变(PK 冲突 IGNORE)')
    assert.equal(await archivedIdCount('sess-idem'), 300 - r1.tail.length, 'id 集不重复膨胀')
  })
})

// ── 写路径接入(公有 API) ────────────────────────────────────────────────────

describe('upsertClientSession — spill 接入', () => {
  it('大会话 PUT:行只留热尾巴,归档计数/水位落列,partial 总数含归档', async () => {
    const N = 300
    const session = {
      id: 'web-spill', userId: USER, agentId: 'main', title: 't', pinned: false,
      createdAt: 1, lastAt: 2, messages: makeMsgs(N, 11 * 1024), updatedAt: 1000,
    }
    const res = await upsertClientSession(session, 0)
    assert.equal(res, 'applied')

    const row = await rowMessages('web-spill')
    assert.ok(row.length < N && row.length >= SESSION_TAIL_MIN_MSGS, '行只留热尾巴')
    const rowBytes = Buffer.byteLength(JSON.stringify(row), 'utf8')
    assert.ok(rowBytes <= SESSION_TAIL_TARGET_BYTES + 12 * 1024, '行字节有界')

    const full = await getClientSession('web-spill', USER)
    assert.ok(full)
    assert.ok((full.archivedCount ?? 0) > 0, 'archivedCount > 0')
    assert.equal(full.archivedCount, N - row.length, 'archivedCount = 搬走条数')
    assert.ok((full.archivedThroughSeq ?? 0) > 0, 'archivedThroughSeq > 0')

    const partial = await getClientSessionPartial('web-spill', USER, 0)
    assert.ok(partial)
    assert.equal(partial.totalMessageCount, N, '总数 = 热尾巴 + 归档')
    assert.equal(partial.messages.length, row.length, 'since=0 返回热尾巴全量')
  })
})

describe('PUT 防复活', () => {
  it('incoming 含已归档 id 被过滤,行不回涨', async () => {
    // 先建一个小会话,拿到它的消息 id
    const first = {
      id: 'web-revive', userId: USER, agentId: 'main', title: 't', pinned: false,
      createdAt: 1, lastAt: 2, messages: makeMsgs(5, 1024, 'r'), updatedAt: 1000,
    }
    await upsertClientSession(first, 0)
    // 手动把其中两条标记为已归档(模拟它们已被 spill 搬走)
    const db = await getSessionsDb()
    db.prepare('INSERT OR IGNORE INTO client_session_archived_ids (session_id, msg_id) VALUES (?, ?)').run('web-revive', 'r-0')
    db.prepare('INSERT OR IGNORE INTO client_session_archived_ids (session_id, msg_id) VALUES (?, ?)').run('web-revive', 'r-1')

    // 客户端全量 PUT 带回完整历史(含已归档的 r-0/r-1)
    const second = {
      id: 'web-revive', userId: USER, agentId: 'main', title: 't', pinned: false,
      createdAt: 1, lastAt: 3, messages: makeMsgs(5, 1024, 'r'), updatedAt: 2000,
    }
    const res = await upsertClientSession(second, 1000)
    assert.equal(res, 'applied')

    const ids = (await rowMessages('web-revive')).map((m) => m.id)
    assert.ok(!ids.includes('r-0'), 'r-0 已归档,不被复活进行')
    assert.ok(!ids.includes('r-1'), 'r-1 已归档,不被复活进行')
    assert.ok(ids.includes('r-2') && ids.includes('r-4'), '未归档的行照常保留')
  })
})

describe('appendServerAuthoredMessage — 归档幂等 + spill', () => {
  it('append 已归档 id → already_exists', async () => {
    const session = {
      id: 'web-app', userId: USER, agentId: 'main', title: 't', pinned: false,
      createdAt: 1, lastAt: 2, messages: makeMsgs(3, 1024, 'a'), updatedAt: 1000,
    }
    await upsertClientSession(session, 0)
    const db = await getSessionsDb()
    db.prepare('INSERT OR IGNORE INTO client_session_archived_ids (session_id, msg_id) VALUES (?, ?)').run('web-app', 'srv-archived')

    const r = await appendServerAuthoredMessage('web-app', USER, { id: 'srv-archived', role: 'assistant', text: 'z' })
    assert.equal(r.applied, false)
    assert.equal(r.reason, 'already_exists')
  })

  it('append 令行越过软阈值 → 触发 spill', async () => {
    // 先 PUT 一个接近软阈值(~2.4MB)的会话
    const session = {
      id: 'web-app-spill', userId: USER, agentId: 'main', title: 't', pinned: false,
      createdAt: 1, lastAt: 2, messages: makeMsgs(220, 11 * 1024, 'p'), updatedAt: 1000,
    }
    await upsertClientSession(session, 0)
    const before = await getClientSession('web-app-spill', USER)
    // 追加一条大 server 消息把行顶过 2.5MB
    const r = await appendServerAuthoredMessage('web-app-spill', USER, {
      id: 'srv-tip', role: 'assistant', text: 'y'.repeat(300 * 1024), ts: 999999,
    })
    assert.equal(r.applied, true)
    const after = await getClientSession('web-app-spill', USER)
    assert.ok(after)
    assert.ok((after.archivedCount ?? 0) > (before?.archivedCount ?? 0), 'append 触发了 spill')
    // 追加的最新消息仍在热尾巴里(未被搬走)
    const ids = (await rowMessages('web-app-spill')).map((m) => m.id)
    assert.ok(ids.includes('srv-tip'), '最新 append 留在热尾巴')
  })
})

describe('appendCostCredits — 命中归档 → noop', () => {
  it('目标 msg 已归档(不在热尾巴)→ noop,不 re-pending', async () => {
    // 会话热尾巴里没有 srv-cost,但 request_map 指向它、且它已归档
    const session = {
      id: 'web-cost', userId: USER, agentId: 'main', title: 't', pinned: false,
      createdAt: 1, lastAt: 2, messages: makeMsgs(3, 1024, 'c'), updatedAt: 1000,
    }
    await upsertClientSession(session, 0)
    const db = await getSessionsDb()
    db.prepare('INSERT INTO server_authored_request_map (request_id, user_id, session_id, msg_id) VALUES (?, ?, ?, ?)')
      .run('req-archived', USER, 'web-cost', 'srv-cost')
    db.prepare('INSERT OR IGNORE INTO client_session_archived_ids (session_id, msg_id) VALUES (?, ?)').run('web-cost', 'srv-cost')

    const r = await appendCostCredits('req-archived', USER, '12345')
    assert.equal(r.applied, 'noop', '命中归档 → noop')
    const pending = db.prepare('SELECT COUNT(*) AS n FROM pending_usage_patches WHERE request_id = ?').get('req-archived') as { n: number }
    assert.equal(pending.n, 0, '不 re-pending')
  })

  it('目标 msg 未归档也不在尾巴(被删) → fall through 到 pending', async () => {
    const session = {
      id: 'web-cost2', userId: USER, agentId: 'main', title: 't', pinned: false,
      createdAt: 1, lastAt: 2, messages: makeMsgs(3, 1024, 'd'), updatedAt: 1000,
    }
    await upsertClientSession(session, 0)
    const db = await getSessionsDb()
    db.prepare('INSERT INTO server_authored_request_map (request_id, user_id, session_id, msg_id) VALUES (?, ?, ?, ?)')
      .run('req-missing', USER, 'web-cost2', 'srv-missing')

    const r = await appendCostCredits('req-missing', USER, '999')
    assert.equal(r.applied, 'pending', '未归档 → 维持 pending 语义')
    const pending = db.prepare('SELECT cost_credits FROM pending_usage_patches WHERE request_id = ?').get('req-missing') as { cost_credits: string } | undefined
    assert.equal(pending?.cost_credits, '999')
  })
})

// ── 读侧:归档分页 + 增量兼容 ─────────────────────────────────────────────────

describe('readArchivedMessages — 分页', () => {
  async function seedSpilled(sessId: string, N: number): Promise<{ archivedCount: number }> {
    const session = {
      id: sessId, userId: USER, agentId: 'main', title: 't', pinned: false,
      createdAt: 1, lastAt: 2, messages: makeMsgs(N, 11 * 1024, 'pg'), updatedAt: 1000,
    }
    await upsertClientSession(session, 0)
    const full = await getClientSession(sessId, USER)
    return { archivedCount: full?.archivedCount ?? 0 }
  }

  it('缺省 beforeSeq 拉最新归档页;游标后退跨 chunk 不重不漏、升序、hasMore 正确', async () => {
    const { archivedCount } = await seedSpilled('web-pg', 300)
    assert.ok(archivedCount > 100, '搬走足够多以便多页(跨 chunk)')

    const collected: number[] = []
    let before = 0
    let pages = 0
    for (;;) {
      const page = await readArchivedMessages('web-pg', USER, before, 50)
      if (page.messages.length === 0) break
      pages++
      // 升序
      for (let i = 1; i < page.messages.length; i++) {
        assert.ok((page.messages[i]._seq as number) > (page.messages[i - 1]._seq as number), '页内升序')
      }
      // oldestSeq = 本页首条
      assert.equal(page.oldestSeq, page.messages[0]._seq as number)
      for (const m of page.messages) collected.push(m._seq as number)
      if (!page.hasMore) break
      before = page.oldestSeq as number
      assert.ok(pages < 20, '不应无限翻页')
    }
    // 全量拼回:恰好覆盖 _seq 1..archivedCount,无重复无缺口
    collected.sort((a, b) => a - b)
    assert.equal(collected.length, archivedCount, '拼回条数 = 归档总数')
    assert.equal(new Set(collected).size, archivedCount, '无重复')
    assert.equal(collected[0], 1, '最老 _seq = 1')
    assert.equal(collected[collected.length - 1], archivedCount, '最新归档 _seq = archivedCount')
    // 连续无缺口
    for (let i = 0; i < collected.length; i++) assert.equal(collected[i], i + 1, '归档 _seq 连续')
  })

  it('分租:别的 user 拿不到归档', async () => {
    await seedSpilled('web-pg2', 200)
    const page = await readArchivedMessages('web-pg2', 'someone-else', 0, 50)
    assert.equal(page.messages.length, 0)
    assert.equal(page.hasMore, false)
  })
})

describe('增量协议兼容', () => {
  it('spill 后 ?since=<老游标> 返回的热尾巴非空、isPartial 语义不变', async () => {
    const session = {
      id: 'web-inc', userId: USER, agentId: 'main', title: 't', pinned: false,
      createdAt: 1, lastAt: 2, messages: makeMsgs(300, 11 * 1024, 'inc'), updatedAt: 1000,
    }
    await upsertClientSession(session, 0)
    const full = await getClientSession('web-inc', USER)
    const watermark = full?.archivedThroughSeq ?? 0

    // 老游标取水位处(< 热尾巴最小 _seq),since>0 且全员有 _seq → isPartial=true
    const partial = await getClientSessionPartial('web-inc', USER, watermark)
    assert.ok(partial)
    assert.equal(partial.isPartial, true, '增量语义不变(有 _seq + since>0)')
    assert.ok(partial.messages.length > 0, '返回的热尾巴非空')
    for (const m of partial.messages as Msg[]) {
      assert.ok((m._seq as number) > watermark, '增量只返回 _seq > since 的行')
    }
  })
})
