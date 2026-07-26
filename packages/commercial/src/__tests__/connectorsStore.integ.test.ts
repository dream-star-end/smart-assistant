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
import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { after, before, describe, test } from 'node:test'
import { startAuditRetentionSweeper } from '../admin/auditRetention.js'
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
  type ConnectorRedis,
  ensureFreshFeishuConnection,
  feishuTokenExpired,
} from '../connectors/providers/feishu.js'
import { githubSearchIssues } from '../connectors/providers/github.js'
import { makeConnectorsRpcHandler } from '../connectors/rpc.js'
import {
  type FeishuSecret,
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
import { saveGithubLink } from '../github/tokenStore.js'
import { AeadError } from '../crypto/aead.js'
import { KMS_KEY_BYTES } from '../crypto/keys.js'
import { closePool, createPool, getPool, resetPool, setPoolOverride } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { query } from '../db/queries.js'
import { resetTestSchemaForTest } from './helpers/db.js'

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
  await resetTestSchemaForTest()
}

before(async () => {
  pgAvailable = await probe()
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) throw new Error('Postgres test fixture required')
    return
  }
  await resetPool()
  setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 10 }))
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

  // 现有用例的 ledger 行都是 notion/create_page;beginExecute 需带 expected provider/action(P0#2)。
  const beginExec = (
    id: string,
    uid: number,
    connId: string,
    action = 'create_page',
    provider = 'notion',
  ) =>
    beginExecute({
      id,
      userId: uid,
      connectionId: connId,
      expectedProvider: provider,
      expectedAction: action,
    })

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

  test('account preapproval is durably attributed and starts approved without a second mutation', async (t) => {
    if (skipIfNoDb(t)) return
    const uid = await mkUser()
    const { connection } = await mkConnection(uid)
    const proposal = await proposeWrite({
      userId: uid,
      connectionId: connection.id,
      connectionRevision: connection.revision,
      provider: 'notion',
      action: 'create_page',
      params: { parentPageId: 'a'.repeat(32), title: '预授权', content: '正文' },
      summary: '账号预授权写入',
      approval: { source: 'account_preapproval', policyVersion: 1 },
    })
    const row = await getLedgerRow(proposal.id, uid)
    assert.ok(row)
    assert.equal(row.status, 'approved')
    assert.equal(row.approval_source, 'account_preapproval')
    assert.equal(row.approval_policy_version, 1)
    assert.ok(row.approved_at)
    const begun = await beginExec(proposal.id, uid, connection.id)
    assert.equal(begun.kind, 'ok')
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
      beginExec(p.id, uid, connection.id),
      (e: unknown) => e instanceof ConnectorError && e.code === 'CONFIRMATION_NOT_APPROVED',
    )
    await approveConfirmation(p.id, uid)

    const begun = await beginExec(p.id, uid, connection.id)
    assert.equal(begun.kind, 'ok')
    if (begun.kind !== 'ok') return
    assert.equal((begun.params as { title?: string }).title, '周报') // 账本参数,非模型重传
    assert.equal(begun.row.status, 'executing')

    // 同 id 并发/重复 → in_progress
    const dup = await beginExec(p.id, uid, connection.id)
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
    const replay = await beginExec(p.id, uid, connection.id)
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
      beginExec(p.id, uid, connection.id),
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
      beginExec(p.id, uid, connection.id),
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
      beginExec(p.id, uid, conn2.id),
      (e: unknown) => e instanceof ConnectorError && e.code === 'BAD_REQUEST',
    )
    await assert.rejects(
      beginExec(p.id, other, connection.id),
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

  test('P1#6:非终态限额并发原子 —— 15 并发 propose 恰 10 成功(advisory lock 消 TOCTOU)', async (t) => {
    if (skipIfNoDb(t)) return
    const uid = await mkUser()
    const { connection } = await mkConnection(uid)
    const results = await Promise.allSettled(
      Array.from({ length: 15 }, () => mkProposal(uid, connection.id, connection.revision)),
    )
    const ok = results.filter((r) => r.status === 'fulfilled').length
    const quota = results.filter(
      (r) =>
        r.status === 'rejected' &&
        r.reason instanceof ConnectorError &&
        r.reason.code === 'QUOTA_EXCEEDED',
    ).length
    assert.equal(ok, NON_TERMINAL_LIMIT, `应恰 ${NON_TERMINAL_LIMIT} 个成功,实际 ${ok}`)
    assert.equal(quota, 15 - NON_TERMINAL_LIMIT)
    const cnt = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM connector_write_ledger
        WHERE user_id = $1 AND status IN ('pending','approved','executing')`,
      [uid],
    )
    assert.equal(cnt.rows[0]!.n, String(NON_TERMINAL_LIMIT))
  })
})

// ─── sweeper 三职责(活跃态转换;P1#11:retention 已迁 auditRetention) ─────────

describe('connectorSweeper', () => {
  test('stale executing 按 dispatch fence 收敛 / 过期→expired / oauth DELETE', async (t) => {
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
    const begun = await beginExecute({
      id: pExec.id,
      userId: uid,
      connectionId: connection.id,
      expectedProvider: 'notion',
      expectedAction: 'create_page',
    })
    assert.equal(begun.kind, 'ok')
    await query(
      `UPDATE connector_write_ledger SET started_at = now() - interval '10 minutes' WHERE id = $1::uuid`,
      [pExec.id],
    )

    const mkPluginExecuting = async (title: string, age: string) => {
      const proposal = await proposeWrite({
        userId: uid,
        connectionId: connection.id,
        connectionRevision: connection.revision,
        provider: 'notion',
        action: 'create_page',
        params: { parentPageId: 'e'.repeat(32), title, content: '' },
        summary: title,
        dispatchFenceRequired: true,
      })
      await approveConfirmation(proposal.id, uid)
      assert.equal(
        (
          await beginExecute({
            id: proposal.id,
            userId: uid,
            connectionId: connection.id,
            expectedProvider: 'notion',
            expectedAction: 'create_page',
          })
        ).kind,
        'ok',
      )
      await query(
        `UPDATE connector_write_ledger SET started_at = now() - $2::interval
          WHERE id = $1::uuid`,
        [proposal.id, age],
      )
      return proposal
    }

    // ①b Plugin 的合法长任务不能沿用 legacy 5min 阈值；只有超过当前签名合同
    // 的完整最长管线后，pre-arm crash 才能确定收敛为 failed。
    const pPluginSixMinutes = await mkPluginExecuting('plugin-six-minutes', '6 minutes')
    const pPluginBoundary = await mkPluginExecuting('plugin-twenty-nine-minutes', '29 minutes')
    const pPluginPreArm = await mkPluginExecuting('plugin-pre-arm-crash', '31 minutes')

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

    // ④ 一条 >90 天终态行:connectorSweeper **不再删**(P1#11 已迁 auditRetention),
    //    此处用来断言 sweeper 不碰它。
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
    } finally {
      sweeper.stop()
    }

    const exec = (await getLedgerRow(pExec.id, uid))!
    assert.equal(exec.dispatch_fence_required, false)
    assert.equal(exec.status, 'unknown') // 绝不回 approved
    assert.equal(exec.error_code, 'STALE_EXECUTING')
    assert.equal(exec.params_enc, null)
    const preArm = (await getLedgerRow(pPluginPreArm.id, uid))!
    assert.equal(preArm.dispatch_fence_required, true)
    assert.equal(preArm.dispatch_armed_at, null)
    assert.equal(preArm.status, 'failed')
    assert.equal(preArm.error_code, 'PRE_DISPATCH_STALE')
    assert.equal(preArm.params_enc, null)
    assert.equal(preArm.params_nonce, null)
    const preArmReplay = await beginExecute({
      id: pPluginPreArm.id,
      userId: uid,
      connectionId: connection.id,
      expectedProvider: 'notion',
      expectedAction: 'create_page',
    })
    assert.equal(preArmReplay.kind, 'replay')
    if (preArmReplay.kind === 'replay') assert.equal(preArmReplay.status, 'failed')
    for (const proposal of [pPluginSixMinutes, pPluginBoundary]) {
      const active = (await getLedgerRow(proposal.id, uid))!
      assert.equal(active.dispatch_fence_required, true)
      assert.equal(active.status, 'executing')
      assert.notEqual(active.params_enc, null)
    }
    const expd = (await getLedgerRow(pExpired.id, uid))!
    assert.equal(expd.status, 'expired')
    assert.equal(expd.params_enc, null)
    // P1#11:sweeper 不做 retention → 90 天终态行仍在(交给 auditRetention 删)
    assert.ok((await getLedgerRow(pOld.id, uid)) !== null, 'connectorSweeper 不应删终态 retention 行')
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
      })
    } finally {
      sweeper2.stop()
    }
    for (const proposal of [pPluginSixMinutes, pPluginBoundary]) {
      assert.equal(
        await finalizeExecute({ id: proposal.id, status: 'failed', errorCode: 'TEST_CLEANUP' }),
        true,
      )
    }
  })
})

// ═══ P0#2 / P1#3 / P1#4 / P1#5 / P1#7 / P1#9 / P1#11:审计整改批 ═══════════════

function feishuPayload(
  unionId: string,
  accessToken = 'feishu-access-1',
  refreshToken = 'feishu-refresh-1',
): FeishuSecret {
  return {
    schema_version: 1,
    account_identity: canonicalAccountIdentity('feishu', { unionId }),
    account_identity_version: 1,
    clientId: 'cli-x',
    clientSecret: 'sec-x',
    accessToken, // schema minLength 8
    refreshToken,
  }
}

async function mkFeishuConnection(uid: number, unionId: string, tokenExpiresAt: number) {
  const accountKey = computeAccountKey(canonicalAccountIdentity('feishu', { unionId }))
  const { connection } = await upsertConnection({
    userId: uid,
    provider: 'feishu',
    displayName: '飞书',
    accountKey,
    payload: feishuPayload(unionId),
    meta: { account_hint: unionId, tokenExpiresAt },
  })
  return connection
}

/** 内存 Redis(忠实实现连接器用到的 4 类 Lua 脚本;lock/counter 两个命名空间)。 */
function makeFakeRedis() {
  const locks = new Map<string, string>()
  const counters = new Map<string, number>()
  const redis: ConnectorRedis & { locks: Map<string, string>; counters: Map<string, number> } = {
    locks,
    counters,
    async eval(script: string, _n: number, ...args: Array<string | number>) {
      const key = String(args[0])
      if (script.includes('INCR')) {
        // WINDOW_SCRIPT: GET-then-INCR;ARGV[1]=cap
        const cap = Number(args[1])
        const cur = counters.get(key) ?? 0
        if (cur >= cap) return -1
        counters.set(key, cur + 1)
        return cur + 1
      }
      if (script.includes('EXISTS')) return locks.has(key) ? 1 : 0
      if (script.includes("'SET'") && script.includes("'NX'")) {
        if (locks.has(key)) return 0
        locks.set(key, String(args[1]))
        return 1
      }
      if (script.includes('PEXPIRE')) return locks.get(key) === String(args[1]) ? 1 : 0
      if (script.includes("'DEL'")) {
        if (locks.get(key) === String(args[1])) {
          locks.delete(key)
          return 1
        }
        return 0
      }
      return 0
    },
  }
  return redis
}

// ── 容器 RPC 测试装配 ──
const CONTAINER_SECRET_HEX = 'b'.repeat(64)
const RPC_CTX = { hostUuid: 'h', boundIp: '1.2.3.4' }
function okIdentityRepo(userId: number) {
  return {
    async findActiveByHostAndBoundIp() {
      return {
        id: 1,
        user_id: userId,
        bound_ip: '1.2.3.4',
        host_uuid: 'h',
        secret_hash: createHash('sha256')
          .update(Buffer.from(CONTAINER_SECRET_HEX, 'hex'))
          .digest(),
      }
    },
  }
}

interface RpcState {
  statusCode: number
  body: string
}
function fakeRes(): { res: ServerResponse; state: RpcState } {
  const state: RpcState = { statusCode: 200, body: '' }
  const res = {
    get statusCode() {
      return state.statusCode
    },
    set statusCode(v: number) {
      state.statusCode = v
    },
    headersSent: false,
    setHeader() {},
    end(chunk?: string) {
      if (chunk) state.body += chunk
    },
  } as unknown as ServerResponse
  return { res, state }
}
function fakeReq(body: unknown): IncomingMessage {
  const em = new EventEmitter() as EventEmitter & Record<string, unknown>
  em.method = 'POST'
  em.url = '/v3/connectors/call'
  em.headers = { authorization: `Bearer oc-v3.1.${CONTAINER_SECRET_HEX}` }
  ;(em as unknown as { [Symbol.asyncIterator]: unknown })[Symbol.asyncIterator] =
    async function* () {
      yield Buffer.from(JSON.stringify(body), 'utf8')
    }
  return em as unknown as IncomingMessage
}
function utcDayKey(uid: number, now: number): string {
  const d = new Date(now)
  const day = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`
  return `connectors:send:${uid}:${day}`
}
/** 飞书 200 成功响应工厂(create_calendar_event / send_message)。 */
function feishuOkFetch(): (u: string, i: Record<string, unknown>) => Promise<Response> {
  return async (u: string) => {
    let body: unknown = { code: 0, data: {} }
    if (u.includes('/events')) body = { code: 0, data: { event: { event_id: 'ev1', summary: '会' } } }
    else if (u.includes('/messages')) body = { code: 0, data: { message_id: 'm1' } }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
}
async function callRpc(handler: ReturnType<typeof makeConnectorsRpcHandler>, body: unknown) {
  const { res, state } = fakeRes()
  await handler(fakeReq(body), res, RPC_CTX)
  return { status: state.statusCode, env: JSON.parse(state.body) as Record<string, unknown> }
}

describe('P1#7 并发 rebind(FOR UPDATE + 双代数 CAS)', () => {
  test('三并发 rebind 串行递进 revision/generation 不丢更新', async (t) => {
    if (skipIfNoDb(t)) return
    const uid = await mkUser()
    const base = await mkConnection(uid, 'bot-cc-rebind') // revision 1 / generation 1
    const key = computeAccountKey(canonicalAccountIdentity('notion', { botId: 'bot-cc-rebind' }))
    const rebind = (tok: string) =>
      upsertConnection({
        userId: uid,
        provider: 'notion',
        accountKey: key,
        payload: notionPayload(tok, 'bot-cc-rebind'),
        meta: {},
      })
    const toks = ['ntok-aaaa', 'ntok-bbbb', 'ntok-cccc'] // schema minLength 8
    const results = await Promise.all(toks.map((t) => rebind(t)))
    for (const r of results) assert.equal(r.rebound, true)
    const revs = results.map((r) => r.connection.revision).sort((a, b) => a - b)
    assert.deepEqual(revs, [2, 3, 4], '三次 rebind 应得连续 revision(FOR UPDATE 串行)')
    const gens = results.map((r) => Number(r.connection.secret_generation)).sort((a, b) => a - b)
    assert.deepEqual(gens, [2, 3, 4])
    // 每个返回行内部一致(revision==generation:base 1/1 各 +1)
    for (const r of results) {
      assert.equal(Number(r.connection.secret_generation), r.connection.revision)
    }
    const cur = (await getActiveConnection(base.connection.id, uid))!
    assert.equal(cur.revision, 4)
    assert.equal(cur.secret_generation, '4')
    assert.ok(toks.includes(decryptConnectionSecret<NotionSecret>(cur).token))
  })
})

describe('P0#2 执行按账本行 provider/action 绑定(越权面)', () => {
  test('同一 feishu connection 换写 action(create_calendar_event→send_message)必被拒', async (t) => {
    if (skipIfNoDb(t)) return
    const uid = await mkUser()
    const conn = await mkFeishuConnection(uid, 'union-swap', Date.now() + 3_600_000)
    const p = await proposeWrite({
      userId: uid,
      connectionId: conn.id,
      connectionRevision: conn.revision,
      provider: 'feishu',
      action: 'create_calendar_event',
      params: {
        calendarId: 'cal-1',
        summary: '会',
        startTime: '2026-07-12T10:00:00Z',
        endTime: '2026-07-12T11:00:00Z',
      },
      summary: '建日程',
    })
    await approveConfirmation(p.id, uid)
    // 换 action 执行 → 拒(且不终态化账本行)
    await assert.rejects(
      beginExecute({
        id: p.id,
        userId: uid,
        connectionId: conn.id,
        expectedProvider: 'feishu',
        expectedAction: 'send_message',
      }),
      (e: unknown) => e instanceof ConnectorError && e.code === 'BAD_REQUEST',
    )
    assert.equal((await getLedgerRow(p.id, uid))!.status, 'approved') // 仍可正确执行
    // 正确 action → ok
    const begun = await beginExecute({
      id: p.id,
      userId: uid,
      connectionId: conn.id,
      expectedProvider: 'feishu',
      expectedAction: 'create_calendar_event',
    })
    assert.equal(begun.kind, 'ok')
  })

  test('RPC 端到端:confirmId 执行忽略 body.action —— 执行账本已批准的 action(不被换成 send_message)', async (t) => {
    if (skipIfNoDb(t)) return
    // Codex R2 P0#2:执行权威源=账本行。模型即便重传 body.action='send_message',也只会
    // 执行账本里已被用户批准的 create_calendar_event(打到 /events,绝不打 /messages)。
    const uid = await mkUser()
    const conn = await mkFeishuConnection(uid, 'union-rpc-swap', Date.now() + 3_600_000)
    const redis = makeFakeRedis()
    const hitUrls: string[] = []
    const recordingFetch = (u: string, i: Record<string, unknown>) => {
      hitUrls.push(u)
      return feishuOkFetch()(u, i)
    }
    const handler = makeConnectorsRpcHandler({
      identityRepo: okIdentityRepo(uid),
      pool: getPool(),
      redis,
      fetchImpl: recordingFetch,
      log: () => {},
    })
    const prop = await callRpc(handler, {
      connectionId: conn.id,
      action: 'create_calendar_event',
      params: {
        calendarId: 'cal-1',
        summary: '会',
        startTime: '2026-07-12T10:00:00Z',
        endTime: '2026-07-12T11:00:00Z',
      },
    })
    assert.equal(prop.env.kind, 'confirmation_required')
    const id = prop.env.id as string
    await approveConfirmation(id, uid)
    // 模型试图用同一 confirmId 换成 send_message 执行 → body.action 被忽略,执行账本 action
    const swapped = await callRpc(handler, {
      connectionId: conn.id,
      action: 'send_message',
      confirmId: id,
    })
    assert.equal(swapped.env.kind, 'result')
    assert.equal((await getLedgerRow(id, uid))!.status, 'succeeded')
    // 关键安全断言:实际打的是日历端点(/events),从未打消息端点(/messages)
    assert.ok(
      hitUrls.some((u) => u.includes('/events')),
      '应执行账本批准的建日程 action',
    )
    assert.ok(
      !hitUrls.some((u) => u.includes('/messages')),
      'body.action=send_message 必须被忽略,绝不打消息端点',
    )
    // 同 confirmId 再执行(正确 action)→ replay(不重复执行)
    const replay = await callRpc(handler, {
      connectionId: conn.id,
      action: 'create_calendar_event',
      confirmId: id,
    })
    assert.equal(replay.env.kind, 'replay')
  })

  test('confirmId 执行**不带 action**也成立(Codex R3:action 漏传不阻断 replay/执行)', async (t) => {
    if (skipIfNoDb(t)) return
    const uid = await mkUser()
    const conn = await mkFeishuConnection(uid, 'union-noaction', Date.now() + 3_600_000)
    const redis = makeFakeRedis()
    const handler = makeConnectorsRpcHandler({
      identityRepo: okIdentityRepo(uid),
      pool: getPool(),
      redis,
      fetchImpl: feishuOkFetch(),
      log: () => {},
    })
    const prop = await callRpc(handler, {
      connectionId: conn.id,
      action: 'create_calendar_event',
      params: {
        calendarId: 'cal-1',
        summary: '会',
        startTime: '2026-07-12T10:00:00Z',
        endTime: '2026-07-12T11:00:00Z',
      },
    })
    const id = prop.env.id as string
    await approveConfirmation(id, uid)
    // 执行只带 confirmId,不带 action → 账本权威,正常执行
    const exec = await callRpc(handler, { connectionId: conn.id, confirmId: id })
    assert.equal(exec.env.kind, 'result')
    assert.equal((await getLedgerRow(id, uid))!.status, 'succeeded')
    // 再次不带 action → replay(不因缺 action 报 BAD_REQUEST)
    const replay = await callRpc(handler, { connectionId: conn.id, confirmId: id })
    assert.equal(replay.env.kind, 'replay')
  })
})

describe('P1#5 send 日上限扣在 execute 而非 propose', () => {
  test('propose send_message 不扣 send 桶;execute 才扣', async (t) => {
    if (skipIfNoDb(t)) return
    const uid = await mkUser()
    const conn = await mkFeishuConnection(uid, 'union-send-a', Date.now() + 3_600_000)
    const now = Date.UTC(2026, 6, 12, 3, 0, 0)
    const redis = makeFakeRedis()
    const handler = makeConnectorsRpcHandler({
      identityRepo: okIdentityRepo(uid),
      pool: getPool(),
      redis,
      fetchImpl: feishuOkFetch(),
      now: () => now,
      log: () => {},
    })
    const prop = await callRpc(handler, {
      connectionId: conn.id,
      action: 'send_message',
      params: { receiveId: 'ou_x', receiveIdType: 'open_id', text: 'hi' },
    })
    assert.equal(prop.env.kind, 'confirmation_required')
    // propose 后 send 桶仍空(P1#5:不再在 propose 扣 send)
    assert.equal(redis.counters.get(utcDayKey(uid, now)) ?? 0, 0)
    const id = prop.env.id as string
    await approveConfirmation(id, uid)
    const exec = await callRpc(handler, {
      connectionId: conn.id,
      action: 'send_message',
      confirmId: id,
    })
    assert.equal(exec.env.kind, 'result')
    // execute 才扣 send 桶:0 → 1
    assert.equal(redis.counters.get(utcDayKey(uid, now)), 1)
  })

  test('send 日上限已满 → execute 前拒(SEND_DAILY_CAP)+ 账本 failed(未 dispatch)', async (t) => {
    if (skipIfNoDb(t)) return
    const uid = await mkUser()
    const conn = await mkFeishuConnection(uid, 'union-send-b', Date.now() + 3_600_000)
    const now = Date.UTC(2026, 6, 12, 3, 0, 0)
    const redis = makeFakeRedis()
    redis.counters.set(utcDayKey(uid, now), 50) // SEND_DAILY_CAP 已满
    let dispatched = 0
    const handler = makeConnectorsRpcHandler({
      identityRepo: okIdentityRepo(uid),
      pool: getPool(),
      redis,
      fetchImpl: async (u: string) => {
        dispatched += 1
        return feishuOkFetch()(u, {})
      },
      now: () => now,
      log: () => {},
    })
    const prop = await callRpc(handler, {
      connectionId: conn.id,
      action: 'send_message',
      params: { receiveId: 'ou_x', receiveIdType: 'open_id', text: 'hi' },
    })
    assert.equal(prop.env.kind, 'confirmation_required') // propose 不受 send 上限影响
    const id = prop.env.id as string
    await approveConfirmation(id, uid)
    const exec = await callRpc(handler, {
      connectionId: conn.id,
      action: 'send_message',
      confirmId: id,
    })
    assert.equal(exec.env.kind, 'error')
    assert.equal(exec.env.code, 'SEND_DAILY_CAP')
    assert.equal(dispatched, 0, 'send 上限拒绝必须在 dispatch 之前')
    const row = (await getLedgerRow(id, uid))!
    assert.equal(row.status, 'failed')
    assert.equal(row.error_code, 'SEND_DAILY_CAP')
  })
})

describe('P1#4 写请求送达不确定 → unknown(服务端已收包后断连)', () => {
  async function drive(fetchImpl: (u: string, i: Record<string, unknown>) => Promise<Response>) {
    const uid = await mkUser()
    const conn = await mkFeishuConnection(uid, `union-p14-${randomBytes(4).toString('hex')}`, Date.now() + 3_600_000)
    const redis = makeFakeRedis()
    const handler = makeConnectorsRpcHandler({
      identityRepo: okIdentityRepo(uid),
      pool: getPool(),
      redis,
      fetchImpl,
      log: () => {},
    })
    const prop = await callRpc(handler, {
      connectionId: conn.id,
      action: 'create_calendar_event',
      params: {
        calendarId: 'cal-1',
        summary: '会',
        startTime: '2026-07-12T10:00:00Z',
        endTime: '2026-07-12T11:00:00Z',
      },
    })
    const id = prop.env.id as string
    await approveConfirmation(id, uid)
    const exec = await callRpc(handler, {
      connectionId: conn.id,
      action: 'create_calendar_event',
      confirmId: id,
    })
    return { uid, id, exec }
  }

  test('post-dispatch ECONNRESET → 账本 unknown(不盲重试)', async (t) => {
    if (skipIfNoDb(t)) return
    const { uid, id, exec } = await drive(async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })
    })
    assert.equal(exec.env.kind, 'error')
    assert.equal(exec.env.code, 'UPSTREAM_ERROR')
    assert.equal((await getLedgerRow(id, uid))!.status, 'unknown')
  })

  test('明确 404 → 账本 failed(服务端拒绝=未写入)', async (t) => {
    if (skipIfNoDb(t)) return
    const { uid, id, exec } = await drive(async () => new Response('', { status: 404 }))
    assert.equal(exec.env.kind, 'error')
    assert.equal(exec.env.code, 'UPSTREAM_NOT_FOUND')
    assert.equal((await getLedgerRow(id, uid))!.status, 'failed')
  })
})

describe('P1#3 飞书刷新:锁内重查当前 generation + 续租 + 双代数 CAS', () => {
  test('过期 → 锁内刷新 + generation 递进 + 写回新 token', async (t) => {
    if (skipIfNoDb(t)) return
    const uid = await mkUser()
    const conn = await mkFeishuConnection(uid, 'union-refresh', Date.now() - 1_000) // 已过期
    const redis = makeFakeRedis()
    let refreshCalls = 0
    const fetchImpl = async () => {
      refreshCalls += 1
      return new Response(
        JSON.stringify({
          code: 0,
          access_token: 'new-access-token', // schema minLength 8
          refresh_token: 'new-refresh-token',
          expires_in: 7200,
          scope: '',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    const fresh = await ensureFreshFeishuConnection(conn, getPool(), redis, { fetchImpl })
    assert.equal(refreshCalls, 1)
    assert.equal(fresh.secret.accessToken, 'new-access-token')
    assert.equal(fresh.secret.refreshToken, 'new-refresh-token')
    assert.equal(fresh.row.secret_generation, '2') // 1 → 2(fencing CAS 写回)
    assert.ok((fresh.row.meta.tokenExpiresAt as number) > Date.now())
    assert.equal(redis.locks.size, 0, '刷新后释放锁')
  })

  test('等锁期间别人已刷新 → 直接用新 generation,不再打 token 端点', async (t) => {
    if (skipIfNoDb(t)) return
    const uid = await mkUser()
    const conn = await mkFeishuConnection(uid, 'union-wait', Date.now() - 1_000)
    // 模拟另一请求持锁在刷
    const redis = makeFakeRedis()
    redis.locks.set(`connectors:refresh:${conn.id}`, 'someone-else')
    // 别人刷完:DB generation 1→2 且 meta 未过期
    await updateConnectionSecret({
      id: conn.id,
      userId: uid,
      provider: 'feishu',
      expectedRevision: conn.revision,
      expectedGeneration: conn.secret_generation,
      payload: feishuPayload('union-wait', 'other-refreshed-at'),
      meta: { account_hint: 'union-wait', tokenExpiresAt: Date.now() + 3_600_000 },
    })
    let calls = 0
    const fetchImpl = async () => {
      calls += 1
      return new Response('{}', { status: 200 })
    }
    const fresh = await ensureFreshFeishuConnection(conn, getPool(), redis, { fetchImpl })
    assert.equal(calls, 0, '不得再打 token 端点(别人已刷)')
    assert.equal(fresh.secret.accessToken, 'other-refreshed-at')
    assert.equal(feishuTokenExpired(fresh.row.meta), false)
  })
})

describe('P1#11 连接器账本 retention 迁 auditRetention(只删终态)', () => {
  test('auditRetention 删 >90 天终态行;活跃态老行保留', async (t) => {
    if (skipIfNoDb(t)) return
    const uid = await mkUser()
    const { connection } = await mkConnection(uid)
    const mkP = (title: string) =>
      proposeWrite({
        userId: uid,
        connectionId: connection.id,
        connectionRevision: connection.revision,
        provider: 'notion',
        action: 'create_page',
        params: { parentPageId: 'e'.repeat(32), title, content: '' },
        summary: title,
      })
    // 终态老行(denied,>90d)
    const term = await mkP('term-old')
    await denyConfirmation(term.id, uid)
    await query(
      `UPDATE connector_write_ledger SET created_at = now() - interval '91 days' WHERE id = $1::uuid`,
      [term.id],
    )
    // 活跃态老行(pending,>90d)——谓词保证不删
    const active = await mkP('active-old')
    await query(
      `UPDATE connector_write_ledger SET created_at = now() - interval '91 days' WHERE id = $1::uuid`,
      [active.id],
    )
    const sweeper = startAuditRetentionSweeper({ intervalMs: 3_600_000, onError: () => {} })
    try {
      const res = await sweeper.runNow()
      assert.ok((res['connector_write_ledger'] ?? 0) >= 1, 'connector_write_ledger 终态行应被删')
    } finally {
      sweeper.stop()
    }
    assert.equal(await getLedgerRow(term.id, uid), null, '终态老行删除')
    assert.ok((await getLedgerRow(active.id, uid)) !== null, '活跃态老行(pending)必须保留')
  })
})

describe('P1#9 github 401:本地撤销失败不谎报 RELINK', () => {
  const profile = { githubUserId: 4242, login: 'octocat', avatarUrl: null, scopes: 'repo' }

  test('本地 revoke 成功 → RELINK_REQUIRED + link 撤销', async (t) => {
    if (skipIfNoDb(t)) return
    const uid = await mkUser()
    await saveGithubLink({ pool: getPool(), userId: uid, profile, accessToken: 'ghtok' })
    await assert.rejects(
      githubSearchIssues(getPool(), uid, { query: 'test' }, { fetchImpl: async () => new Response('', { status: 401 }) }),
      (e: unknown) => e instanceof ConnectorError && e.code === 'RELINK_REQUIRED',
    )
    const r = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM github_links WHERE user_id = $1 AND revoked_at IS NULL`,
      [uid],
    )
    assert.equal(r.rows[0]!.n, '0', 'link 应已撤销')
  })

  test('本地 revoke 失败 → 稳定可重试码 UPSTREAM_ERROR(不谎报 RELINK,link 仍 active)', async (t) => {
    if (skipIfNoDb(t)) return
    const uid = await mkUser()
    await saveGithubLink({ pool: getPool(), userId: uid, profile, accessToken: 'ghtok2' })
    const real = getPool()
    // 读走真 pool(getGithubLinkWithToken 用 .query),revoke 走 .connect() → 抛错
    const brokenPool = new Proxy(real, {
      get(target, prop, recv) {
        if (prop === 'connect') {
          return async () => ({
            async query(sql: string) {
              if (/UPDATE github_links/i.test(sql)) throw new Error('simulated revoke failure')
              return { rowCount: 0, rows: [] }
            },
            release() {},
          })
        }
        const v = Reflect.get(target, prop, recv)
        return typeof v === 'function' ? v.bind(target) : v
      },
    }) as typeof real
    await assert.rejects(
      githubSearchIssues(brokenPool, uid, { query: 'test' }, { fetchImpl: async () => new Response('', { status: 401 }) }),
      (e: unknown) => e instanceof ConnectorError && e.code === 'UPSTREAM_ERROR',
    )
    const r = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM github_links WHERE user_id = $1 AND revoked_at IS NULL`,
      [uid],
    )
    assert.equal(r.rows[0]!.n, '1', 'revoke 失败 → link 仍 active(可重试)')
  })
})
