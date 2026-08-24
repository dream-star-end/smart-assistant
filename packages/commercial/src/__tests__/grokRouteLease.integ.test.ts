/**
 * grok_route_contexts 租约语义(真 SQL 行为):
 *   - kind='delegate' 短租约 vs kind='bridge' 7 天孤儿 TTL(创建与 resolve 滑动)
 *   - delegate 租约期满后自动让出账号并发容量(网关崩溃自愈路径)
 *   - per-container delegate 并发限额(GrokDelegateLeaseLimitError)
 *   - expireSettledGrokRouteLeases:非 active 容器回收 / journal 已结算回收 /
 *     在途 dispatch 保护 / 无 journal 的存活 delegate 行不误杀
 *
 * 每个用例造独立的 user+container+account:per-container 限额与账号级并发
 * 计数都是跨用例可见的共享状态,不隔离会互相串扰。
 *
 * Run: REQUIRE_TEST_DB=1 npx tsx --test packages/commercial/src/__tests__/grokRouteLease.integ.test.ts
 */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { describe, test } from 'node:test'

import {
  GROK_DELEGATE_ROUTE_TTL_MS,
  GrokDelegateLeaseLimitError,
  createGrokRouteContextForModel,
  expireGrokRouteContextByLease,
  expireSettledGrokRouteLeases,
  listActiveGrokRouteLeases,
  resolveGrokRouteContext,
} from '../account-pool/groups.js'
import { generatePersona } from '../account-pool/persona.js'
import { query, tx } from '../db/queries.js'
import { useDedicatedTestDatabase } from './helpers/db.js'

const db = useDedicatedTestDatabase('grok_route_lease_test')

const MODEL = 'grok-build'
const DAY_MS = 24 * 60 * 60 * 1000

let grokGroupId: bigint | null = null

async function groupId(): Promise<bigint> {
  if (grokGroupId !== null) return grokGroupId
  const group = await query<{ id: string }>(
    `SELECT id::text AS id FROM account_groups WHERE kind='official_oauth' AND provider='grok'`,
  )
  assert.equal(group.rows.length, 1, '0207 must have seeded the grok official_oauth group')
  grokGroupId = BigInt(group.rows[0]!.id)
  return grokGroupId
}

let egressProxyId: string | null = null

/** 非 cursor 账号必须绑 egress proxy(0225 check);测试造一个占位行。 */
async function proxyId(): Promise<string> {
  if (egressProxyId !== null) return egressProxyId
  const res = await query<{ id: string }>(
    `INSERT INTO egress_proxies(label, url_enc, url_nonce, status)
     VALUES ('grok-lease-proxy', '\\x00'::bytea, '\\x00'::bytea, 'active')
     RETURNING id::text AS id`,
  )
  egressProxyId = res.rows[0]!.id
  return egressProxyId
}

/** 独立 user+container(state='active'):per-container 限额按容器计,跨用例必须隔离。 */
async function makeActor(label: string): Promise<{ userId: bigint; containerId: number }> {
  const user = await query<{ id: string }>(
    `INSERT INTO users(email,password_hash,role)
     VALUES ($1,'x','admin') RETURNING id::text AS id`,
    [`${label}@grok-lease.test.invalid`],
  )
  const userId = BigInt(user.rows[0]!.id)
  const container = await query<{ id: string }>(
    `INSERT INTO agent_containers(user_id, docker_name, workspace_volume, home_volume, image, state, secret_hash)
     VALUES ($1,$2,$3,$4,'img','active',$5) RETURNING id::text AS id`,
    [String(userId), `oc-${label}`, `wv-${label}`, `hv-${label}`, createHash('sha256').update(label).digest()],
  )
  return { userId, containerId: Number(container.rows[0]!.id) }
}

/** 独立账号:账号级并发计数互不串扰。 */
async function makeAccount(label: string): Promise<bigint> {
  const res = await query<{ id: string }>(
    `INSERT INTO claude_accounts(
       label, plan, oauth_token_enc, oauth_nonce, provider, status, runtime_channel, group_id, persona, egress_proxy_id
     ) VALUES ($1,'pro',$2,$3,'grok','active','v3',$4,$5::jsonb,$6)
     RETURNING id::text AS id`,
    [
      label,
      Buffer.from('tok'),
      Buffer.from('nonce'),
      String(await groupId()),
      JSON.stringify(generatePersona()),
      await proxyId(),
    ],
  )
  return BigInt(res.rows[0]!.id)
}

async function createLease(args: {
  containerId: number
  userId: bigint
  accountId: bigint
  slotId: string
  kind?: 'bridge' | 'delegate'
  ttlMs?: number
  maxConcurrent?: number
  maxDelegatePerContainer?: number
}) {
  const gid = await groupId()
  return tx((client) =>
    createGrokRouteContextForModel({
      containerId: args.containerId,
      userId: args.userId,
      modelId: MODEL,
      accountId: args.accountId,
      slotId: args.slotId,
      groupId: gid,
      runner: client,
      maxConcurrent: args.maxConcurrent ?? 10,
      ...(args.kind !== undefined ? { kind: args.kind } : {}),
      ...(args.ttlMs !== undefined ? { ttlMs: args.ttlMs } : {}),
      ...(args.maxDelegatePerContainer !== undefined
        ? { maxDelegatePerContainer: args.maxDelegatePerContainer }
        : {}),
    }),
  )
}

async function rowBySlot(slotId: string): Promise<{ kind: string; status: string; expires_in_ms: number } | null> {
  const res = await query<{ kind: string; status: string; expires_in_ms: string }>(
    `SELECT kind, status,
            ROUND(EXTRACT(EPOCH FROM (expires_at - NOW())) * 1000)::text AS expires_in_ms
       FROM grok_route_contexts WHERE slot_id = $1`,
    [slotId],
  )
  const row = res.rows[0]
  return row ? { kind: row.kind, status: row.status, expires_in_ms: Number(row.expires_in_ms) } : null
}

describe('grok route lease semantics', () => {
  test('delegate rows get the short lease, bridge rows keep the 7-day orphan TTL', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const { containerId, userId } = await makeActor('ttl')
    const accountId = await makeAccount('ttl-account')

    const delegate = await createLease({
      containerId, userId, accountId, slotId: 'ttl-delegate', kind: 'delegate',
    })
    assert.ok(delegate, 'delegate lease must be created')
    const delegateRow = (await rowBySlot('ttl-delegate'))!
    assert.equal(delegateRow.kind, 'delegate')
    assert.ok(
      delegateRow.expires_in_ms <= GROK_DELEGATE_ROUTE_TTL_MS + 5_000 &&
        delegateRow.expires_in_ms > GROK_DELEGATE_ROUTE_TTL_MS - 60_000,
      `delegate lease must be minute-scale, got ${delegateRow.expires_in_ms}ms`,
    )

    const bridge = await createLease({
      containerId, userId, accountId, slotId: 'ttl-bridge',
    })
    assert.ok(bridge, 'bridge lease must be created')
    const bridgeRow = (await rowBySlot('ttl-bridge'))!
    assert.equal(bridgeRow.kind, 'bridge')
    assert.ok(
      bridgeRow.expires_in_ms > 6 * DAY_MS,
      `bridge lease must keep the orphan-cleanup boundary, got ${bridgeRow.expires_in_ms}ms`,
    )
  })

  test('resolve slides a delegate lease by the short TTL only, never to 7 days', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const { containerId, userId } = await makeActor('slide')
    const accountId = await makeAccount('slide-account')

    const delegate = await createLease({
      containerId, userId, accountId, slotId: 'slide-delegate', kind: 'delegate', ttlMs: 1_000,
    })
    assert.ok(delegate)
    const resolved = await resolveGrokRouteContext({ token: delegate.token, containerId, userId })
    assert.ok(resolved, 'a live delegate lease must resolve')
    const slid = (await rowBySlot('slide-delegate'))!
    assert.ok(
      slid.expires_in_ms > 1_000 && slid.expires_in_ms <= GROK_DELEGATE_ROUTE_TTL_MS + 5_000,
      `delegate slide must extend to the heartbeat lease, got ${slid.expires_in_ms}ms`,
    )

    const bridge = await createLease({
      containerId, userId, accountId, slotId: 'slide-bridge', ttlMs: 1_000,
    })
    assert.ok(bridge)
    const resolvedBridge = await resolveGrokRouteContext({ token: bridge.token, containerId, userId })
    assert.ok(resolvedBridge)
    const slidBridge = (await rowBySlot('slide-bridge'))!
    assert.ok(
      slidBridge.expires_in_ms > 6 * DAY_MS,
      `bridge slide must keep the 7-day orphan boundary, got ${slidBridge.expires_in_ms}ms`,
    )
  })

  test('a lapsed delegate lease frees the account cap and fails resolve closed', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const { containerId, userId } = await makeActor('lapse')
    const accountId = await makeAccount('lapse-account')

    const leaked = await createLease({
      containerId, userId, accountId, slotId: 'lapse-leaked', kind: 'delegate', ttlMs: 5,
    })
    assert.ok(leaked)
    await new Promise((resolve) => setTimeout(resolve, 50))

    // 崩溃网关的租约期满后:restore 面看不见它…
    const active = await listActiveGrokRouteLeases()
    assert.equal(active.some((lease) => lease.slotId === 'lapse-leaked'), false)
    // …resolve fail-closed…
    assert.equal(await resolveGrokRouteContext({ token: leaked.token, containerId, userId }), null)
    // …且账号级并发容量已经让出(maxConcurrent=1 仍可铸新租约)。
    const next = await createLease({
      containerId, userId, accountId, slotId: 'lapse-next', kind: 'delegate', maxConcurrent: 1,
    })
    assert.ok(next, 'expired delegate lease must not occupy the account cap')
  })

  test('per-container delegate cap rejects the (max+1)th mint but never bridge or other containers', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const { containerId, userId } = await makeActor('cap')
    const other = await makeActor('cap-other')
    const accountId = await makeAccount('cap-account')

    for (const slot of ['cap-1', 'cap-2']) {
      const created = await createLease({
        containerId, userId, accountId, slotId: slot, kind: 'delegate', maxDelegatePerContainer: 2,
      })
      assert.ok(created, `lease ${slot} under the cap must be created`)
    }
    await assert.rejects(
      createLease({
        containerId, userId, accountId, slotId: 'cap-3', kind: 'delegate', maxDelegatePerContainer: 2,
      }),
      (err: unknown) => err instanceof GrokDelegateLeaseLimitError,
    )

    // bridge 行不受 delegate 限额约束。
    const bridge = await createLease({
      containerId, userId, accountId, slotId: 'cap-bridge',
    })
    assert.ok(bridge, 'bridge lease must bypass the delegate cap')

    // 其它容器不受本容器限额影响。
    const otherLease = await createLease({
      containerId: other.containerId, userId: other.userId, accountId,
      slotId: 'cap-other-slot', kind: 'delegate', maxDelegatePerContainer: 2,
    })
    assert.ok(otherLease, 'another container must have its own cap budget')

    // 释放一个后限额恢复。
    assert.equal(await expireGrokRouteContextByLease(accountId, 'cap-1'), true)
    const refill = await createLease({
      containerId, userId, accountId, slotId: 'cap-refill', kind: 'delegate', maxDelegatePerContainer: 2,
    })
    assert.ok(refill, 'releasing a delegate lease must free cap budget')
  })

  test('expireSettledGrokRouteLeases reaps non-active containers and settled journals, keeps live turns', async (t) => {
    if (db.skipIfUnavailable(t)) return
    const alive = await makeActor('reap-alive')
    const gone = await makeActor('reap-gone')
    const accountId = await makeAccount('reap-account')

    // ① 存活容器 + 无 journal(典型 delegate 在途)→ 保留。
    const live = await createLease({
      containerId: alive.containerId, userId: alive.userId, accountId, slotId: 'reap-live', kind: 'delegate',
    })
    assert.ok(live)

    // ② 非 active 容器 → 回收(NOT EXISTS(state='active') 分支)。
    const vanished = await createLease({
      containerId: gone.containerId, userId: gone.userId, accountId, slotId: 'reap-vanished',
    })
    assert.ok(vanished)
    await query(`UPDATE agent_containers SET state='vanished' WHERE id=$1`, [String(gone.containerId)])

    // ③ journal 已 committed 且无在途 dispatch → 回收。
    const settled = await createLease({
      containerId: alive.containerId, userId: alive.userId, accountId, slotId: 'reap-settled',
    })
    assert.ok(settled)
    await query(
      `INSERT INTO request_finalize_journal(request_id, user_id, state, ctx, precheck_credits)
       VALUES ('req-settled', $1, 'committed', $2::jsonb, 0)`,
      [String(alive.userId), JSON.stringify({ grokSlotId: 'reap-settled', grokAccountId: String(accountId) })],
    )

    // ④ journal committed 但 dispatch 仍在途(admitted)→ 保留。
    const inflight = await createLease({
      containerId: alive.containerId, userId: alive.userId, accountId, slotId: 'reap-inflight',
    })
    assert.ok(inflight)
    await query(
      `INSERT INTO request_finalize_journal(request_id, user_id, state, ctx, precheck_credits)
       VALUES ('req-inflight', $1, 'committed', $2::jsonb, 0)`,
      [String(alive.userId), JSON.stringify({ grokSlotId: 'reap-inflight', grokAccountId: String(accountId) })],
    )
    await query(
      `INSERT INTO turn_dispatches(
         dispatch_id, user_id, session_id, client_message_id, agent_id, model,
         request_hash, billing_request_id, status
       ) VALUES ($1, $2, 'sess-reap', 'cmid-reap', 'main', 'grok-build', 'hash', 'req-inflight', 'admitted')`,
      [randomUUID(), String(alive.userId)],
    )

    const reaped = await expireSettledGrokRouteLeases()
    assert.equal(reaped, 2, 'exactly the vanished-container and settled-journal rows must be reaped')
    assert.equal((await rowBySlot('reap-live'))!.status, 'active')
    assert.equal((await rowBySlot('reap-vanished'))!.status, 'expired')
    assert.equal((await rowBySlot('reap-settled'))!.status, 'expired')
    assert.equal((await rowBySlot('reap-inflight'))!.status, 'active')
  })
})
