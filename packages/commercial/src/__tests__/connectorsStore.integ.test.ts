/**
 * connectors 集成(真 PG;§11 commercial unit 项):
 *   - store CRUD + 加密 roundtrip + AAD 错配拒绝
 *   - CHECK 三值逻辑回归(active 行空 secret 被拒)
 *   - 并发 rebind(23505 → 既有行更新,revision/generation/aad_seed 递进)
 *   - secret_generation stale writer rowCount=0(fencing)
 *   - 解绑销毁断言(tombstone + partial unique 允许重绑)
 *   - OAuth pending:并发双 start 只剩一行旧 state 必败;单事务 consume
 *     (并发双 callback 仅一成功);cookie 因子失配不消费
 *   - ledger 状态机全路径:approve 过期拒执行 / IN_PROGRESS / revision 失配 /
 *     stale sweeper→unknown / 终态参数销毁 / 非终态限额
 *   - connectorSweeper 四职责
 *
 * 无 PG → skip(REQUIRE_TEST_DB=1 时硬失败);照仓内 integ 惯例。
 * 本测试 before/after 都会把 public schema 清空重建(_test 库名硬防护)。
 */

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, test } from 'node:test'
import { ConnectorError } from '../connectors/errors.js'
import {
  NON_TERMINAL_LIMIT,
  approveConfirmation,
  beginExecute,
  decryptLedgerParams,
  denyConfirmation,
  finalizeExecute,
  getLedgerRow,
  proposeWrite,
} from '../connectors/ledger.js'
import { consumeOauthPending, startOauthPending } from '../connectors/oauthPending.js'
import {
  type NotionSecret,
  canonicalAccountIdentity,
  computeAccountKey,
  decryptConnectionSecret,
  getActiveConnection,
  getConnectionAnyStatus,
  listConnections,
  markConnectionError,
  renameConnection,
  revokeConnection,
  updateConnectionSecret,
  upsertConnection,
} from '../connectors/store.js'
import { startConnectorSweeper } from '../connectors/sweeper.js'
import { AeadError } from '../crypto/aead.js'
import { KMS_KEY_BYTES } from '../crypto/keys.js'
import { closePool, createPool, getPool, resetPool, setPoolOverride } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { query } from '../db/queries.js'

// KMS key 必须在任何 encrypt/decrypt 前就位(loadKmsKey 每次现读 env)
process.env.OPENCLAUDE_KMS_KEY = randomBytes(KMS_KEY_BYTES).toString('base64')

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'

let pgAvailable = false

async function probe(): Promise<boolean> {
  const p = createPool({ connectionString: TEST_DB_URL, max: 2, connectionTimeoutMillis: 1500 })
  try {
    await p.query('SELECT 1')
    await p.end()
    return true
  } catch {
    try {
      await p.end()
    } catch {
      /* */
    }
    return false
  }
}

/** 清空 public schema 全部表(库名必须 _test 结尾,防指错库)。 */
async function dropAllTables(): Promise<void> {
  const db = await query<{ db: string }>('SELECT current_database() AS db')
  const name = db.rows[0]?.db ?? ''
  if (!/_test$/.test(name)) {
    throw new Error(`refusing to drop tables on non-test database: ${name}`)
  }
  await query(`
    DO $$ DECLARE r RECORD;
    BEGIN
      FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
        EXECUTE 'DROP TABLE IF EXISTS public.' || quote_ident(r.tablename) || ' CASCADE';
      END LOOP;
    END $$;
  `)
}

before(async () => {
  pgAvailable = await probe()
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) throw new Error('Postgres test fixture required')
    return
  }
  await resetPool()
  setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 10 }))
  // 共享 fixture 里 public schema 可能被其它清理删掉 → 幂等补建
  await query('CREATE SCHEMA IF NOT EXISTS public')
  await dropAllTables()
  await runMigrations() // 全量迁移含 0129 —— 顺带验证迁移可干净 apply
})

after(async () => {
  if (pgAvailable) {
    try {
      await dropAllTables() // 还原为进场时的空库
    } catch {
      /* */
    }
    await closePool()
  }
})

function skipIfNoDb(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable) {
    t.skip('pg not available')
    return true
  }
  return false
}

let userSeq = 0
async function mkUser(): Promise<number> {
  userSeq += 1
  const r = await query<{ id: string }>(
    `INSERT INTO users(email, password_hash, email_verified)
     VALUES ($1, 'x', TRUE) RETURNING id::text AS id`,
    [`conn-u${userSeq}-${Date.now()}@t.local`],
  )
  return Number(r.rows[0]!.id)
}

function notionPayload(token: string, botId: string): NotionSecret {
  return {
    schema_version: 1,
    account_identity: canonicalAccountIdentity('notion', { botId }),
    account_identity_version: 1,
    token,
  }
}

async function mkConnection(userId: number, botId = `bot-${Math.random().toString(36).slice(2)}`) {
  const identity = canonicalAccountIdentity('notion', { botId })
  const accountKey = computeAccountKey(identity)
  const { connection, rebound } = await upsertConnection({
    userId,
    provider: 'notion',
    displayName: '测试 Notion',
    accountKey,
    payload: notionPayload('secret_token_canary_v1', botId),
    meta: { account_hint: 'WS' },
  })
  return { connection, rebound, accountKey, botId }
}

// ─── store ───────────────────────────────────────────────────────────────

describe('connections store', () => {
  test('绑定 → 加密 roundtrip + 行形状', async (t) => {
    if (skipIfNoDb(t)) return
    const uid = await mkUser()
    const { connection, rebound } = await mkConnection(uid)
    assert.equal(rebound, false)
    assert.equal(connection.provider, 'notion')
    assert.equal(connection.revision, 1)
    assert.equal(connection.secret_generation, '1')
    assert.equal(connection.status, 'active')
    const secret = decryptConnectionSecret<NotionSecret>(connection)
    assert.equal(secret.token, 'secret_token_canary_v1')
    assert.equal(secret.schema_version, 1)
    // 密文非明文(canary 不在 secret_enc 里)
    assert.equal(connection.secret_enc!.includes(Buffer.from('secret_token_canary_v1')), false)
  })

  test('AAD 错配拒绝(换 aad_seed → 解密必炸)—— 防跨代密文移植', async (t) => {
    if (skipIfNoDb(t)) return
    const uid = await mkUser()
    const { connection } = await mkConnection(uid)
    await query('UPDATE connections SET aad_seed = gen_random_uuid() WHERE id = $1', [
      connection.id,
    ])
    const tampered = await getActiveConnection(connection.id, uid)
    assert.ok(tampered)
    assert.throws(() => decryptConnectionSecret(tampered), AeadError)
  })

  test('CHECK 三值逻辑:active 行清 secret 被 constraint 拒绝', async (t) => {
    if (skipIfNoDb(t)) return
    const uid = await mkUser()
    const { connection } = await mkConnection(uid)
    await assert.rejects(
      query('UPDATE connections SET secret_enc = NULL WHERE id = $1', [connection.id]),
      (e: unknown) => (e as { code?: string }).code === '23514', // check_violation
    )
    // 只清 nonce 同样被拒
    await assert.rejects(
      query('UPDATE connections SET secret_nonce = NULL WHERE id = $1', [connection.id]),
      (e: unknown) => (e as { code?: string }).code === '23514',
    )
  })

  test('rebind:同 account_key 二次绑定 → 既有行更新(revision+1/generation+1/换 aad_seed)', async (t) => {
    if (skipIfNoDb(t)) return
    const uid = await mkUser()
    const first = await mkConnection(uid, 'bot-rebind')
    const identity = canonicalAccountIdentity('notion', { botId: 'bot-rebind' })
    const { connection: second, rebound } = await upsertConnection({
      userId: uid,
      provider: 'notion',
      displayName: '',
      accountKey: computeAccountKey(identity),
      payload: notionPayload('secret_token_canary_v2', 'bot-rebind'),
      meta: { account_hint: 'WS2' },
    })
    assert.equal(rebound, true)
    assert.equal(second.id, first.connection.id) // 同一行
    assert.equal(second.revision, 2)
    assert.equal(second.secret_generation, '2')
    assert.notEqual(second.aad_seed, first.connection.aad_seed)
    assert.equal(second.display_name, '测试 Notion') // 空 displayName 不覆盖
    assert.equal(decryptConnectionSecret<NotionSecret>(second).token, 'secret_token_canary_v2')
  })

  test('generation fencing:stale writer rowCount=0 丢弃', async (t) => {
    if (skipIfNoDb(t)) return
    const uid = await mkUser()
    const { connection, botId } = await mkConnection(uid)
    // 正常刷新(generation 1 → 2)
    const ok = await updateConnectionSecret({
      id: connection.id,
      userId: uid,
      provider: 'notion',
      expectedRevision: 1,
      expectedGeneration: '1',
      payload: notionPayload('tok-gen2', botId),
    })
    assert.equal(ok, true)
    // stale writer 仍拿 generation=1 → 必须 false
    const stale = await updateConnectionSecret({
      id: connection.id,
      userId: uid,
      provider: 'notion',
      expectedRevision: 1,
      expectedGeneration: '1',
      payload: notionPayload('tok-stale-must-not-win', botId),
    })
    assert.equal(stale, false)
    const cur = await getActiveConnection(connection.id, uid)
    assert.equal(decryptConnectionSecret<NotionSecret>(cur!).token, 'tok-gen2')
    assert.equal(cur!.secret_generation, '2')
    assert.equal(cur!.revision, 1) // 日常刷新不动 revision
  })

  test('markConnectionError:generation 条件 + fail-closed(getActiveConnection 拒 error 行)', async (t) => {
    if (skipIfNoDb(t)) return
    const uid = await mkUser()
    const { connection } = await mkConnection(uid)
    const staleMark = await markConnectionError({
      id: connection.id,
      userId: uid,
      expectedGeneration: '99',
      errorCode: 'RELINK_REQUIRED',
    })
    assert.equal(staleMark, false)
    const mark = await markConnectionError({
      id: connection.id,
      userId: uid,
      expectedGeneration: '1',
      errorCode: 'RELINK_REQUIRED',
    })
    assert.equal(mark, true)
    assert.equal(await getActiveConnection(connection.id, uid), null) // fail-closed
    const any = await getConnectionAnyStatus(connection.id, uid)
    assert.equal(any!.status, 'error')
    assert.equal(any!.last_error_code, 'RELINK_REQUIRED')
  })

  test('解绑销毁断言:tombstone 留行 + secret 置 NULL + partial unique 允许重绑', async (t) => {
    if (skipIfNoDb(t)) return
    const uid = await mkUser()
    const { connection, botId } = await mkConnection(uid, 'bot-revoke')
    const revoked = await revokeConnection(connection.id, uid)
    assert.ok(revoked)
    assert.equal(revoked.secret_enc, null)
    assert.equal(revoked.secret_nonce, null)
    assert.ok(revoked.revoked_at)
    assert.equal(await getActiveConnection(connection.id, uid), null)
    assert.equal(await getConnectionAnyStatus(connection.id, uid), null)
    // 再撤销幂等失败(已撤)
    assert.equal(await revokeConnection(connection.id, uid), null)
    // 同账号可重新绑定(partial unique 只约束未撤销行)→ 新行
    const again = await mkConnection(uid, botId)
    assert.equal(again.rebound, false)
    assert.notEqual(again.connection.id, connection.id)
  })

  test('list / rename / 跨用户隔离', async (t) => {
    if (skipIfNoDb(t)) return
    const uid = await mkUser()
    const other = await mkUser()
    const { connection } = await mkConnection(uid)
    assert.equal((await listConnections(uid)).length, 1)
    assert.equal((await listConnections(other)).length, 0)
    // 他人不可见/不可操作
    assert.equal(await getActiveConnection(connection.id, other), null)
    assert.equal(await renameConnection(connection.id, other, 'hack'), false)
    assert.equal(await renameConnection(connection.id, uid, '我的工作区'), true)
    assert.equal((await getActiveConnection(connection.id, uid))!.display_name, '我的工作区')
  })
})

// ─── oauth pending ───────────────────────────────────────────────────────

describe('connector_oauth_pending', () => {
  const draft = (tag: string) => ({
    clientId: `cli-${tag}`,
    clientSecret: `sec-${tag}`,
    pkceVerifier: 'v'.repeat(43),
  })

  test('双 start 原子替换:只剩一行,旧 state 必败,新 state 成功', async (t) => {
    if (skipIfNoDb(t)) return
    const uid = await mkUser()
    const first = await startOauthPending({ userId: uid, provider: 'feishu', draft: draft('a') })
    const second = await startOauthPending({ userId: uid, provider: 'feishu', draft: draft('b') })
    const rows = await query<{ n: string }>(
      'SELECT count(*)::text AS n FROM connector_oauth_pending WHERE user_id = $1',
      [uid],
    )
    assert.equal(rows.rows[0]!.n, '1')
    // 旧 state 必败(state_hash 已被覆盖)
    await assert.rejects(
      consumeOauthPending({ state: first.state, cookieNonce: first.cookieNonce }),
      (e: unknown) => e instanceof ConnectorError && e.code === 'OAUTH_STATE_MISMATCH',
    )
    // 新 state 成功且 draft 是第二次的
    const consumed = await consumeOauthPending({
      state: second.state,
      cookieNonce: second.cookieNonce,
    })
    assert.equal(consumed.userId, uid)
    assert.equal(consumed.draft.clientId, 'cli-b')
  })

  test('cookie 因子失配 → 不消费(正确 cookie 随后仍可成功)', async (t) => {
    if (skipIfNoDb(t)) return
    const uid = await mkUser()
    const started = await startOauthPending({ userId: uid, provider: 'feishu', draft: draft('c') })
    await assert.rejects(
      consumeOauthPending({ state: started.state, cookieNonce: 'wrong-nonce' }),
      (e: unknown) => e instanceof ConnectorError && e.code === 'OAUTH_STATE_MISMATCH',
    )
    // 未被消费:正确因子仍成功
    const consumed = await consumeOauthPending({
      state: started.state,
      cookieNonce: started.cookieNonce,
    })
    assert.equal(consumed.draft.clientId, 'cli-c')
  })

  test('单事务 consume:并发双 callback 仅一成功;draft 密文即时销毁', async (t) => {
    if (skipIfNoDb(t)) return
    const uid = await mkUser()
    const started = await startOauthPending({ userId: uid, provider: 'feishu', draft: draft('d') })
    const attempt = () =>
      consumeOauthPending({ state: started.state, cookieNonce: started.cookieNonce })
    const results = await Promise.allSettled([attempt(), attempt()])
    const okCount = results.filter((r) => r.status === 'fulfilled').length
    assert.equal(okCount, 1, `expected exactly one success, got ${okCount}`)
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    assert.ok(failed.reason instanceof ConnectorError)
    assert.equal((failed.reason as ConnectorError).code, 'OAUTH_STATE_MISMATCH')
    // 消费后 draft 密文销毁(cop_draft_shape 三值 CHECK 的 consumed 分支)
    const row = await query<{ draft_enc: Buffer | null; consumed_at: Date | null }>(
      'SELECT draft_enc, consumed_at FROM connector_oauth_pending WHERE user_id = $1',
      [uid],
    )
    assert.equal(row.rows[0]!.draft_enc, null)
    assert.ok(row.rows[0]!.consumed_at)
  })

  test('过期行拒绝消费', async (t) => {
    if (skipIfNoDb(t)) return
    const uid = await mkUser()
    const started = await startOauthPending({ userId: uid, provider: 'feishu', draft: draft('e') })
    await query(
      `UPDATE connector_oauth_pending SET expires_at = now() - interval '1 minute' WHERE user_id = $1`,
      [uid],
    )
    await assert.rejects(
      consumeOauthPending({ state: started.state, cookieNonce: started.cookieNonce }),
      (e: unknown) => e instanceof ConnectorError && e.code === 'OAUTH_STATE_MISMATCH',
    )
  })
})

// ─── ledger 状态机 ───────────────────────────────────────────────────────

describe('connector_write_ledger 状态机', () => {
  async function mkProposal(uid: number, connectionId: string, revision: number) {
    return proposeWrite({
      userId: uid,
      connectionId,
      connectionRevision: revision,
      provider: 'notion',
      action: 'create_page',
      params: { parentPageId: 'a'.repeat(32), title: '周报', content: '正文 canary_params_v1' },
      summary: '在 Notion 创建页面「周报」',
    })
  }

  test('propose → pending;params 加密 roundtrip + hash 复核', async (t) => {
    if (skipIfNoDb(t)) return
    const uid = await mkUser()
    const { connection } = await mkConnection(uid)
    const p = await mkProposal(uid, connection.id, connection.revision)
    const row = await getLedgerRow(p.id, uid)
    assert.ok(row)
    assert.equal(row.status, 'pending')
    assert.equal(row.canonicalization_version, 1)
    assert.ok(row.expires_at.getTime() > Date.now())
    const params = decryptLedgerParams(row)
    assert.equal((params as { title?: string }).title, '周报')
    // 密文不含明文 canary
    assert.equal(row.params_enc!.includes(Buffer.from('canary_params_v1')), false)
  })

  test('approve:CAS + expires_at 重设执行窗口;重复 approve 幂等', async (t) => {
    if (skipIfNoDb(t)) return
    const uid = await mkUser()
    const { connection } = await mkConnection(uid)
    const p = await mkProposal(uid, connection.id, connection.revision)
    const before = (await getLedgerRow(p.id, uid))!.expires_at.getTime()
    const r = await approveConfirmation(p.id, uid)
    assert.equal(r.status, 'approved')
    const row = (await getLedgerRow(p.id, uid))!
    assert.equal(row.status, 'approved')
    assert.ok(row.approved_at)
    assert.ok(row.expires_at.getTime() >= before - 1000) // 新执行窗口 ≈ now+10min
    assert.ok(row.expires_at.getTime() > Date.now() + 9 * 60_000)
    // 幂等重复
    assert.equal((await approveConfirmation(p.id, uid)).status, 'approved')
  })

  test('pending 过期 → approve 拒(CONFIRMATION_EXPIRED)', async (t) => {
    if (skipIfNoDb(t)) return
    const uid = await mkUser()
    const { connection } = await mkConnection(uid)
    const p = await mkProposal(uid, connection.id, connection.revision)
    await query(
      `UPDATE connector_write_ledger SET expires_at = now() - interval '1 second' WHERE id = $1::uuid`,
      [p.id],
    )
    await assert.rejects(
      approveConfirmation(p.id, uid),
      (e: unknown) => e instanceof ConnectorError && e.code === 'CONFIRMATION_EXPIRED',
    )
  })

  test('deny:pending→denied + 销毁 params;deny 后 approve 拒', async (t) => {
    if (skipIfNoDb(t)) return
    const uid = await mkUser()
    const { connection } = await mkConnection(uid)
    const p = await mkProposal(uid, connection.id, connection.revision)
    assert.equal((await denyConfirmation(p.id, uid)).status, 'denied')
    const row = (await getLedgerRow(p.id, uid))!
    assert.equal(row.status, 'denied')
    assert.equal(row.params_enc, null)
    await assert.rejects(
      approveConfirmation(p.id, uid),
      (e: unknown) => e instanceof ConnectorError && e.code === 'CONFIRMATION_ALREADY_FINALIZED',
    )
    // 重复 deny 幂等
    assert.equal((await denyConfirmation(p.id, uid)).status, 'denied')
  })

  test('执行全路径:not_approved → ok(executing)→ 并发 in_progress → 终态销毁 → replay', async (t) => {
    if (skipIfNoDb(t)) return
    const uid = await mkUser()
    const { connection } = await mkConnection(uid)
    const p = await mkProposal(uid, connection.id, connection.revision)

    // 未批准先执行 → 拒
    await assert.rejects(
      beginExecute({ id: p.id, userId: uid, connectionId: connection.id }),
      (e: unknown) => e instanceof ConnectorError && e.code === 'CONFIRMATION_NOT_APPROVED',
    )
    await approveConfirmation(p.id, uid)

    const begun = await beginExecute({ id: p.id, userId: uid, connectionId: connection.id })
    assert.equal(begun.kind, 'ok')
    if (begun.kind !== 'ok') return
    assert.equal((begun.params as { title?: string }).title, '周报') // 账本参数,非模型重传
    assert.equal(begun.row.status, 'executing')

    // 同 id 并发/重复 → in_progress
    const dup = await beginExecute({ id: p.id, userId: uid, connectionId: connection.id })
    assert.equal(dup.kind, 'in_progress')

    // 终态 CAS + 参数销毁
    assert.equal(
      await finalizeExecute({ id: p.id, status: 'succeeded', resultDigest: 'd'.repeat(64) }),
      true,
    )
    const done = (await getLedgerRow(p.id, uid))!
    assert.equal(done.status, 'succeeded')
    assert.equal(done.params_enc, null)
    assert.equal(done.params_nonce, null)
    assert.ok(done.finished_at)

    // 终态重放 → replay(不承诺原结果,只给 digest)
    const replay = await beginExecute({ id: p.id, userId: uid, connectionId: connection.id })
    assert.equal(replay.kind, 'replay')
    if (replay.kind === 'replay') {
      assert.equal(replay.status, 'succeeded')
      assert.equal(replay.resultDigest, 'd'.repeat(64))
    }
    // 二次 finalize 不生效(status 已非 executing)
    assert.equal(await finalizeExecute({ id: p.id, status: 'failed' }), false)
  })

  test('approve 过期后拒执行(执行窗口硬界)→ 就地 expired + 销毁', async (t) => {
    if (skipIfNoDb(t)) return
    const uid = await mkUser()
    const { connection } = await mkConnection(uid)
    const p = await mkProposal(uid, connection.id, connection.revision)
    await approveConfirmation(p.id, uid)
    await query(
      `UPDATE connector_write_ledger SET expires_at = now() - interval '1 second' WHERE id = $1::uuid`,
      [p.id],
    )
    await assert.rejects(
      beginExecute({ id: p.id, userId: uid, connectionId: connection.id }),
      (e: unknown) => e instanceof ConnectorError && e.code === 'CONFIRMATION_EXPIRED',
    )
    const row = (await getLedgerRow(p.id, uid))!
    assert.equal(row.status, 'expired')
    assert.equal(row.params_enc, null)
  })

  test('revision 失配(批准后换绑)→ 拒执行 + 终态 failed(换绑/失效一律拒)', async (t) => {
    if (skipIfNoDb(t)) return
    const uid = await mkUser()
    const { connection, botId } = await mkConnection(uid, 'bot-rev-mismatch')
    const p = await mkProposal(uid, connection.id, connection.revision)
    await approveConfirmation(p.id, uid)
    // 换绑:revision 1 → 2
    const identity = canonicalAccountIdentity('notion', { botId })
    await upsertConnection({
      userId: uid,
      provider: 'notion',
      accountKey: computeAccountKey(identity),
      payload: notionPayload('tok-rebound', botId),
      meta: {},
    })
    await assert.rejects(
      beginExecute({ id: p.id, userId: uid, connectionId: connection.id }),
      (e: unknown) => e instanceof ConnectorError && e.code === 'REVISION_MISMATCH',
    )
    const row = (await getLedgerRow(p.id, uid))!
    assert.equal(row.status, 'failed')
    assert.equal(row.error_code, 'REVISION_MISMATCH')
    assert.equal(row.params_enc, null)
  })

  test('connection 换错 confirmId → BAD_REQUEST;错 user → NOT_FOUND', async (t) => {
    if (skipIfNoDb(t)) return
    const uid = await mkUser()
    const other = await mkUser()
    const { connection } = await mkConnection(uid)
    const { connection: conn2 } = await mkConnection(uid, 'bot-second')
    const p = await mkProposal(uid, connection.id, connection.revision)
    await approveConfirmation(p.id, uid)
    await assert.rejects(
      beginExecute({ id: p.id, userId: uid, connectionId: conn2.id }),
      (e: unknown) => e instanceof ConnectorError && e.code === 'BAD_REQUEST',
    )
    await assert.rejects(
      beginExecute({ id: p.id, userId: other, connectionId: connection.id }),
      (e: unknown) => e instanceof ConnectorError && e.code === 'CONFIRMATION_NOT_FOUND',
    )
  })

  test('非终态限额 ≤10 → 第 11 个 propose 拒(QUOTA_EXCEEDED)', async (t) => {
    if (skipIfNoDb(t)) return
    const uid = await mkUser()
    const { connection } = await mkConnection(uid)
    for (let i = 0; i < NON_TERMINAL_LIMIT; i++) {
      await mkProposal(uid, connection.id, connection.revision)
    }
    await assert.rejects(
      mkProposal(uid, connection.id, connection.revision),
      (e: unknown) => e instanceof ConnectorError && e.code === 'QUOTA_EXCEEDED',
    )
  })
})

// ─── sweeper 四职责 ──────────────────────────────────────────────────────

describe('connectorSweeper', () => {
  test('stale executing→unknown(绝不回 approved)/ 过期→expired / oauth DELETE / retention', async (t) => {
    if (skipIfNoDb(t)) return
    const uid = await mkUser()
    const { connection } = await mkConnection(uid)

    // ① stale executing
    const pExec = await proposeWrite({
      userId: uid,
      connectionId: connection.id,
      connectionRevision: connection.revision,
      provider: 'notion',
      action: 'create_page',
      params: { parentPageId: 'b'.repeat(32), title: 'stale', content: '' },
      summary: 's1',
    })
    await approveConfirmation(pExec.id, uid)
    const begun = await beginExecute({ id: pExec.id, userId: uid, connectionId: connection.id })
    assert.equal(begun.kind, 'ok')
    await query(
      `UPDATE connector_write_ledger SET started_at = now() - interval '10 minutes' WHERE id = $1::uuid`,
      [pExec.id],
    )

    // ② 过期 pending
    const pExpired = await proposeWrite({
      userId: uid,
      connectionId: connection.id,
      connectionRevision: connection.revision,
      provider: 'notion',
      action: 'create_page',
      params: { parentPageId: 'c'.repeat(32), title: 'exp', content: '' },
      summary: 's2',
    })
    await query(
      `UPDATE connector_write_ledger SET expires_at = now() - interval '1 minute' WHERE id = $1::uuid`,
      [pExpired.id],
    )

    // ③ oauth 过期行(未消费,含密文)
    await startOauthPending({
      userId: uid,
      provider: 'feishu',
      draft: { clientId: 'c', clientSecret: 's', pkceVerifier: 'v'.repeat(43) },
    })
    await query(
      `UPDATE connector_oauth_pending SET expires_at = now() - interval '1 minute' WHERE user_id = $1`,
      [uid],
    )

    // ④ retention:>90 天的终态行
    const pOld = await proposeWrite({
      userId: uid,
      connectionId: connection.id,
      connectionRevision: connection.revision,
      provider: 'notion',
      action: 'create_page',
      params: { parentPageId: 'd'.repeat(32), title: 'old', content: '' },
      summary: 's3',
    })
    await denyConfirmation(pOld.id, uid)
    await query(
      `UPDATE connector_write_ledger SET created_at = now() - interval '91 days' WHERE id = $1::uuid`,
      [pOld.id],
    )

    const sweeper = startConnectorSweeper({
      pool: getPool(),
      intervalMs: 3_600_000,
      onError: (duty, err) => assert.fail(`sweeper duty ${duty} failed: ${String(err)}`),
    })
    try {
      const result = await sweeper.runNow()
      // 计数用 >=:同文件其它用例留下的过期 pending/oauth 行也会被合法清扫;
      // 逐行终态断言(下方按 id)才是精确校验。
      assert.ok(result.staleExecuting >= 1, `staleExecuting=${result.staleExecuting}`)
      assert.ok(result.expired >= 1, `expired=${result.expired}`)
      assert.ok(result.oauthDeleted >= 1, `oauthDeleted=${result.oauthDeleted}`)
      assert.ok(result.retentionDeleted >= 1, `retentionDeleted=${result.retentionDeleted}`)
    } finally {
      sweeper.stop()
    }

    const exec = (await getLedgerRow(pExec.id, uid))!
    assert.equal(exec.status, 'unknown') // 绝不回 approved
    assert.equal(exec.error_code, 'STALE_EXECUTING')
    assert.equal(exec.params_enc, null)
    const expd = (await getLedgerRow(pExpired.id, uid))!
    assert.equal(expd.status, 'expired')
    assert.equal(expd.params_enc, null)
    assert.equal(await getLedgerRow(pOld.id, uid), null) // retention 删除
    const oauthLeft = await query<{ n: string }>(
      'SELECT count(*)::text AS n FROM connector_oauth_pending WHERE user_id = $1',
      [uid],
    )
    assert.equal(oauthLeft.rows[0]!.n, '0') // 整行 DELETE 即销毁

    // 幂等:再跑一轮全 0
    const sweeper2 = startConnectorSweeper({ pool: getPool(), intervalMs: 3_600_000 })
    try {
      const again = await sweeper2.runNow()
      assert.deepEqual(again, {
        staleExecuting: 0,
        expired: 0,
        oauthDeleted: 0,
        retentionDeleted: 0,
      })
    } finally {
      sweeper2.stop()
    }
  })
})
