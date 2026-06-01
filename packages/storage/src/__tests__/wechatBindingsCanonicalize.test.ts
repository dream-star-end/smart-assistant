/**
 * Tests for wechatBindings rowToBinding lazy canonicalization.
 *
 * 历史:iLink `from_user_id` 形态 `<base64url>@im.wechat`,worker 早期版本
 * 把整个 wire id 当 key 存进 context_tokens JSON。修复后所有写入走 canonical
 * (base64url),但已存在的 DB 行还保留旧 key。
 *
 * 不变量:
 *   1. DB context_tokens JSON 形如 {"abc@im.wechat":"tok"} → 读出 binding.contextTokens
 *      === {"abc":"tok"} (key 在 row→binding 边界被 strip)
 *   2. 已是 canonical key 的行 passthrough,不重写不丢失
 *   3. 混合 key 行(部分老 + 部分新)双方都被规范化到 canonical
 *   4. whitelist 不被这个逻辑动到(whitelist 走另一条解析路径)
 *
 * Run: npx tsx --test packages/storage/src/__tests__/wechatBindingsCanonicalize.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { before, beforeEach, describe, it } from 'node:test'

const testHome = await mkdtemp(join(tmpdir(), 'oc-wechatbindings-'))
process.env.OPENCLAUDE_HOME = testHome

const { getSessionsDb } = await import('../sessionsDb.js')
const {
  WechatAccountAlreadyBoundError,
  getWechatBindingByUserId,
  upsertWechatBinding,
} = await import('../wechatBindings.js')

async function rawInsert(args: {
  userId: string
  contextTokensJson: string
  whitelistJson?: string
}): Promise<void> {
  const db = await getSessionsDb()
  const now = Date.now()
  db.prepare('DELETE FROM wechat_bindings WHERE user_id = ?').run(args.userId)
  db.prepare(
    `INSERT INTO wechat_bindings
       (user_id, account_id, login_user_id, bot_token, get_updates_buf, context_tokens, whitelist, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    args.userId,
    `acct-${args.userId}`,
    `login-${args.userId}`,
    `tok-${args.userId}`,
    '',
    args.contextTokensJson,
    args.whitelistJson ?? '[]',
    'active',
    now,
    now,
  )
}

describe('rowToBinding — lazy canonicalization of context_tokens keys', () => {
  before(async () => {
    // Force schema init
    await getSessionsDb()
  })

  it('old wire-form key `<id>@im.wechat` is stripped to canonical on read', async () => {
    await rawInsert({
      userId: 'u-old',
      contextTokensJson: JSON.stringify({
        'o9cq803RaiYffHD5475dcduJaDgg@im.wechat': 'ctx-token-old',
      }),
    })
    const b = await getWechatBindingByUserId('u-old')
    assert.ok(b)
    assert.deepEqual(b!.contextTokens, { o9cq803RaiYffHD5475dcduJaDgg: 'ctx-token-old' })
  })

  it('canonical key passthrough — does not break new writes', async () => {
    await rawInsert({
      userId: 'u-new',
      contextTokensJson: JSON.stringify({ 'abc-canonical': 'ctx-new' }),
    })
    const b = await getWechatBindingByUserId('u-new')
    assert.ok(b)
    assert.deepEqual(b!.contextTokens, { 'abc-canonical': 'ctx-new' })
  })

  it('mixed old+new keys both normalize to canonical', async () => {
    await rawInsert({
      userId: 'u-mixed',
      contextTokensJson: JSON.stringify({
        'aaa@im.wechat': 'tok-aaa',
        bbb: 'tok-bbb',
      }),
    })
    const b = await getWechatBindingByUserId('u-mixed')
    assert.ok(b)
    assert.deepEqual(b!.contextTokens, { aaa: 'tok-aaa', bbb: 'tok-bbb' })
  })

  it('does not touch @im.bot or unrelated suffixes (out of scope)', async () => {
    await rawInsert({
      userId: 'u-bot',
      contextTokensJson: JSON.stringify({ '77fb1ebc7237@im.bot': 'tok-bot' }),
    })
    const b = await getWechatBindingByUserId('u-bot')
    assert.ok(b)
    // @im.bot 不在剥后缀范围内,key 原样保留(实际 bot accountId 不会出现在 sender 字段,
    // 但 row 解析层不要假设,只严格按 @im.wechat 规则走)
    assert.deepEqual(b!.contextTokens, { '77fb1ebc7237@im.bot': 'tok-bot' })
  })

  it('whitelist parsing unaffected by canonicalization', async () => {
    await rawInsert({
      userId: 'u-wl',
      contextTokensJson: JSON.stringify({ 'sender@im.wechat': 'tok' }),
      whitelistJson: JSON.stringify(['sender@im.wechat', 'other']),
    })
    const b = await getWechatBindingByUserId('u-wl')
    assert.ok(b)
    // whitelist 不在本次修复范围,保留原状(broker 侧已自有 sender 匹配逻辑)
    assert.deepEqual(b!.whitelist, ['sender@im.wechat', 'other'])
  })

  it('malformed JSON falls back to {} without throwing', async () => {
    await rawInsert({
      userId: 'u-bad',
      contextTokensJson: '{not valid json',
    })
    const b = await getWechatBindingByUserId('u-bad')
    assert.ok(b)
    assert.deepEqual(b!.contextTokens, {})
  })
})

describe('upsertWechatBinding — binding identity safety', () => {
  it('same user rebinding to a different WeChat identity resets cursor, context, whitelist and lastEventAt', async () => {
    await upsertWechatBinding({
      userId: 'u-rebind',
      accountId: 'acct-old',
      loginUserId: 'login-old',
      botToken: 'tok-old',
      getUpdatesBuf: 'cursor-old',
      contextTokens: { sender: 'ctx-old' },
      whitelist: ['sender'],
      lastEventAt: 12345,
    })
    await upsertWechatBinding({
      userId: 'u-rebind',
      accountId: 'acct-new',
      loginUserId: 'login-new',
      botToken: 'tok-new',
      status: 'active',
    })
    const b = await getWechatBindingByUserId('u-rebind')
    assert.ok(b)
    assert.equal(b!.accountId, 'acct-new')
    assert.equal(b!.loginUserId, 'login-new')
    assert.equal(b!.botToken, 'tok-new')
    assert.equal(b!.getUpdatesBuf, '')
    assert.deepEqual(b!.contextTokens, {})
    assert.deepEqual(b!.whitelist, [])
    assert.equal(b!.lastEventAt, null)
  })

  it('same user refreshing the same identity preserves cursor, context and lastEventAt by default', async () => {
    await upsertWechatBinding({
      userId: 'u-refresh',
      accountId: 'acct-refresh',
      loginUserId: 'login-refresh',
      botToken: 'tok-refresh',
      getUpdatesBuf: 'cursor-1',
      contextTokens: { sender: 'ctx-1' },
      whitelist: ['sender'],
      lastEventAt: 22222,
    })
    await upsertWechatBinding({
      userId: 'u-refresh',
      accountId: 'acct-refresh',
      loginUserId: 'login-refresh-2',
      botToken: 'tok-refresh',
      status: 'active',
    })
    const b = await getWechatBindingByUserId('u-refresh')
    assert.ok(b)
    assert.equal(b!.loginUserId, 'login-refresh-2')
    assert.equal(b!.getUpdatesBuf, 'cursor-1')
    assert.deepEqual(b!.contextTokens, { sender: 'ctx-1' })
    assert.deepEqual(b!.whitelist, ['sender'])
    assert.equal(b!.lastEventAt, 22222)
  })

  it('rejects binding the same WeChat account to a different OC user', async () => {
    await upsertWechatBinding({
      userId: 'u-owner',
      accountId: 'acct-owned',
      loginUserId: 'login-owner',
      botToken: 'tok-owner',
    })
    await assert.rejects(
      upsertWechatBinding({
        userId: 'u-other',
        accountId: 'acct-owned',
        loginUserId: 'login-other',
        botToken: 'tok-other',
      }),
      WechatAccountAlreadyBoundError,
    )
  })
})
