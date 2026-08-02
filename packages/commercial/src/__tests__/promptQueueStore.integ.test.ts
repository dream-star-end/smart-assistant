import { after, before, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { WebSocket, WebSocketServer } from 'ws'
import type {
  InboundPromptQueueEnqueue,
  PromptQueueMutationFrame,
  PromptQueueSnapshot,
} from '@openclaude/protocol'
import type { OpenClaudeConfig } from '@openclaude/storage'
import {
  CcbAdapter,
  CodexAdapter,
  HttpPromptQueueClient,
  PromptQueueCoordinator,
  SessionManager,
  type AgentSession,
  type EngineAdapter,
  type EngineCreateOpts,
  type PromptQueueDispatchRequest,
  type PromptQueueSessionContext,
  type SubprocessRunner,
} from '@openclaude/gateway'

import { hashSecret, type ContainerIdentityRepo } from '../auth/containerIdentity.js'
import { signAccess } from '../auth/jwt.js'
import { makePromptQueueHandler } from '../http/internalPromptQueue.js'
import {
  PgPromptQueueStore,
  PromptQueueStoreError,
  type PromptQueueOwner,
} from '../promptQueue/pgPromptQueueStore.js'
import {
  BRIDGE_WS_PATH,
  createUserChatBridge,
  type UserChatBridgeDeps,
} from '../ws/userChatBridge.js'
import {
  setV3MasterSinkSingleton,
  type V3MasterSink,
  type V3MasterSinkPayload,
} from '../../../gateway/src/v3MasterSink.js'

const TEST_DB_URL = process.env.TEST_DATABASE_URL
  ?? 'postgres://octest:octest@127.0.0.1:5432/openclaude_commercial_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'
const SCHEMA = 'oc_prompt_queue_p1_test'
const here = path.dirname(fileURLToPath(import.meta.url))
const MIGRATION = path.resolve(here, '../db/migrations/0166_prompt_queue.sql')

const owner1: PromptQueueOwner = {
  userId: 1n,
  sessionKey: 'agent:main:webchat:dm:peer-one',
  clientSessionId: 'peer-one',
  agentId: 'main',
  peer: { id: 'peer-one', kind: 'dm' },
}
const owner2: PromptQueueOwner = {
  userId: 2n,
  sessionKey: 'agent:main:webchat:dm:peer-two',
  clientSessionId: 'peer-two',
  agentId: 'main',
  peer: { id: 'peer-two', kind: 'dm' },
}

let admin: Pool | undefined
let pool: Pool | undefined
let store: PgPromptQueueStore | undefined
let pgAvailable = false
let migrationSql = ''

before(async () => {
  migrationSql = await readFile(MIGRATION, 'utf8')
  admin = new Pool({ connectionString: TEST_DB_URL, max: 2, connectionTimeoutMillis: 1500 })
  try {
    await admin.query('SELECT 1')
    pgAvailable = true
  } catch {
    await admin.end().catch(() => {})
    admin = undefined
    if (REQUIRE_TEST_DB) throw new Error('prompt queue integ requires the octest PostgreSQL fixture')
    return
  }
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
  await admin.query(`CREATE SCHEMA ${SCHEMA}`)
  pool = new Pool({
    connectionString: TEST_DB_URL,
    max: 12,
    options: `-c search_path=${SCHEMA}`,
  })
  await pool.query('CREATE TABLE users (id BIGINT PRIMARY KEY, credits BIGINT NOT NULL DEFAULT 0)')
  // Minimal production-named accounting surfaces let the P2 matrix prove that
  // queue writes do not reserve, journal, debit, or emit usage before dequeue.
  await pool.query(`CREATE TABLE credit_ledger (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id),
    delta BIGINT NOT NULL,
    balance_after BIGINT NOT NULL
  )`)
  await pool.query(`CREATE TABLE usage_records (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id),
    request_id TEXT NOT NULL,
    cost_credits BIGINT NOT NULL
  )`)
  await pool.query(`CREATE TABLE request_finalize_journal (
    request_id TEXT PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id),
    state TEXT NOT NULL,
    precheck_credits BIGINT NOT NULL
  )`)
  await pool.query(`CREATE TABLE client_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    messages TEXT NOT NULL DEFAULT '[]',
    next_seq BIGINT NOT NULL DEFAULT 1,
    deleted_at BIGINT,
    archived_through_seq BIGINT NOT NULL DEFAULT 0,
    archived_count BIGINT NOT NULL DEFAULT 0,
    message_count BIGINT NOT NULL DEFAULT 0,
    last_at BIGINT NOT NULL DEFAULT 0,
    updated_at BIGINT NOT NULL DEFAULT 0,
    history_revision BIGINT NOT NULL DEFAULT 0,
    workspace_mode TEXT NOT NULL DEFAULT 'legacy'
  )`)
  await pool.query(`CREATE TABLE client_session_archived_ids (
    session_id TEXT NOT NULL,
    msg_id TEXT NOT NULL,
    PRIMARY KEY (session_id,msg_id)
  )`)
  await pool.query(`CREATE TABLE server_authored_turn_anchor_map (
    user_id TEXT NOT NULL,
    turn_key TEXT NOT NULL,
    session_id TEXT NOT NULL,
    tape_id TEXT NOT NULL,
    billing_anchor_id TEXT NOT NULL,
    written_at BIGINT NOT NULL,
    PRIMARY KEY (user_id,turn_key)
  )`)
  await pool.query(migrationSql)
  // Exact SQL replay proves the compatibility DDL is idempotent independently
  // of schema_migrations skipping already-applied files.
  await pool.query(migrationSql)
  store = new PgPromptQueueStore(pool)
})

after(async () => {
  await pool?.end().catch(() => {})
  if (admin) {
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {})
    await admin.end().catch(() => {})
  }
})

beforeEach(async () => {
  if (!pgAvailable || !pool) return
  await pool.query(
    'TRUNCATE prompt_queue_item_attachments,prompt_queue_mutations,prompt_queue_items,prompt_queue_heads,request_finalize_journal,usage_records,credit_ledger,server_authored_turn_anchor_map,client_session_archived_ids,client_sessions,users CASCADE',
  )
  await pool.query('INSERT INTO users(id,credits) VALUES (1,5000),(2,5000)')
  await pool.query(
    `INSERT INTO client_sessions(id,user_id,messages)
     VALUES ($1,'c:1','[]'),($2,'c:2','[]')`,
    [owner1.clientSessionId, owner2.clientSessionId],
  )
})

function maybe(t: { skip(reason: string): void }): boolean {
  if (pgAvailable) return true
  t.skip('octest PostgreSQL not running')
  return false
}

function enqueue(
  owner: PromptQueueOwner,
  itemId: string,
  key: string,
  text = itemId,
): InboundPromptQueueEnqueue {
  return {
    type: 'inbound.prompt_queue.enqueue',
    peer: owner.peer,
    channel: 'webchat',
    agentId: owner.agentId,
    itemId,
    clientMessageId: itemId,
    idempotencyKey: key,
    content: { text },
    requestedExecution: {},
  }
}

describe('0166_prompt_queue migration', () => {
  test('0166 is the production-ledger-calibrated first unapplied migration', () => {
    assert.equal(path.basename(MIGRATION), '0166_prompt_queue.sql')
    assert.match(migrationSql.split('\n')[0] ?? '', /^-- 0166_prompt_queue/)
  })

  test('exact replay leaves all tables, constraints, indexes and intended FKs', async (t) => {
    if (!maybe(t) || !pool) return
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema=current_schema() AND table_name LIKE 'prompt_queue_%' ORDER BY table_name`,
    )
    assert.deepEqual(tables.rows.map((row) => row.table_name), [
      'prompt_queue_heads',
      'prompt_queue_item_attachments',
      'prompt_queue_items',
      'prompt_queue_mutations',
    ])
    const constraints = await pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE connamespace=(SELECT oid FROM pg_namespace WHERE nspname=current_schema())`,
    )
    const names = new Set(constraints.rows.map((row) => row.conname))
    for (const expected of [
      'prompt_queue_items_position_uniq',
      'prompt_queue_items_blocked_chk',
      'prompt_queue_items_claim_chk',
      'prompt_queue_mutations_head_fk',
      'prompt_queue_attachments_item_fk',
    ]) assert.ok(names.has(expected), `missing constraint ${expected}`)

    const mutationItemFk = await pool.query(
      `SELECT 1 FROM pg_constraint
        WHERE conrelid='prompt_queue_mutations'::regclass AND contype='f'
          AND pg_get_constraintdef(oid) LIKE '%item_id%'`,
    )
    assert.equal(mutationItemFk.rowCount, 0, 'mutation.item_id must remain audit text, not an item FK')

    await pool.query(
      `INSERT INTO prompt_queue_heads(owner_user_id,session_key,client_session_id,agent_id)
       VALUES (1,$1,$2,$3)`,
      [owner1.sessionKey, owner1.clientSessionId, owner1.agentId],
    )
    await assert.rejects(
      pool.query(
        `UPDATE prompt_queue_heads SET active_item_id='orphan'
          WHERE owner_user_id=1 AND session_key=$1`,
        [owner1.sessionKey],
      ),
      /prompt_queue_heads_active_chk/,
    )
    await assert.rejects(
      pool.query(
        `UPDATE prompt_queue_heads
            SET active_turn_id=$2,active_item_id='orphan',active_started_at=NOW(),
                steer_delivery='turn-boundary'
          WHERE owner_user_id=1 AND session_key=$1`,
        [owner1.sessionKey, 'f'.repeat(64)],
      ),
      /prompt queue head active item is missing or not active/,
    )
    await assert.rejects(
      pool.query(
        `UPDATE prompt_queue_heads SET lease_until=NOW()+INTERVAL '30 seconds'
          WHERE owner_user_id=1 AND session_key=$1`,
        [owner1.sessionKey],
      ),
      /prompt_queue_heads_lease_chk/,
    )
    await store!.mutate(owner1, enqueue(owner1, 'not-active', 'not-active-key'))
    await assert.rejects(
      pool.query(
        `UPDATE prompt_queue_items SET state='active',position=NULL
          WHERE owner_user_id=1 AND session_key=$1 AND item_id='not-active'`,
        [owner1.sessionKey],
      ),
      /prompt queue active item exists while head is idle/,
    )
  })
})

describe('PgPromptQueueStore owner/CAS/idempotency', () => {
  test('restart reload and two owners remain durable and isolated', async (t) => {
    if (!maybe(t) || !pool || !store) return
    await store.mutate(owner1, enqueue(owner1, 'item-a', 'owner1-a', 'alpha'))
    await store.mutate(owner2, enqueue(owner2, 'item-b', 'owner2-b', 'beta'))

    const restarted = new PgPromptQueueStore(pool)
    const [one, two] = await Promise.all([restarted.getSnapshot(owner1), restarted.getSnapshot(owner2)])
    assert.deepEqual(one.items.map((item) => item.id), ['item-a'])
    assert.deepEqual(two.items.map((item) => item.id), ['item-b'])
    assert.equal(one.owner.userId, '1')
    assert.equal(two.owner.userId, '2')
    const detail = await restarted.getDetail(owner1, 'item-a')
    assert.equal(detail.snapshotVersion, one.version)
    assert.equal(detail.contentHash, one.items[0]?.contentHash)
  })

  test('dual-tab CAS permits one winner; replay is duplicate and hash collision is loud', async (t) => {
    if (!maybe(t) || !store || !pool) return
    const first = await store.mutate(owner1, enqueue(owner1, 'item-a', 'enqueue-a', 'v1'))
    assert.equal(first.snapshot.version, '1')
    const editA: PromptQueueMutationFrame = {
      type: 'inbound.prompt_queue.edit', peer: owner1.peer, agentId: 'main', itemId: 'item-a',
      expectedVersion: '1', idempotencyKey: 'tab-a', content: { text: 'tab A' },
    }
    const editB: PromptQueueMutationFrame = {
      ...editA, idempotencyKey: 'tab-b', content: { text: 'tab B' },
    }
    const results = await Promise.all([store.mutate(owner1, editA), store.mutate(owner1, editB)])
    assert.deepEqual(results.map((r) => r.snapshot.mutation?.outcome).sort(), ['applied', 'version_conflict'])
    assert.ok(results.every((r) => r.snapshot.version === '2'))

    const winner = results.find((r) => r.snapshot.mutation?.outcome === 'applied')!
    const winnerFrame = winner.snapshot.mutation?.idempotencyKey === 'tab-a' ? editA : editB
    const replay = await store.mutate(owner1, winnerFrame)
    assert.equal(replay.snapshot.version, '2')
    assert.equal(replay.snapshot.mutation?.outcome, 'duplicate')
    assert.equal(replay.snapshot.mutation?.appliedVersion, '2')

    await assert.rejects(
      store.mutate(owner1, { ...winnerFrame, content: { text: 'different payload' } }),
      (err: unknown) => err instanceof PromptQueueStoreError && err.code === 'IDEMPOTENCY_CONFLICT',
    )
    const ledger = await pool.query<{ outcome: string; applied_version: string | null }>(
      `SELECT outcome,applied_version::text FROM prompt_queue_mutations
        WHERE owner_user_id=1 ORDER BY idempotency_key`,
    )
    assert.equal(ledger.rowCount, 3)
    assert.ok(ledger.rows.some((row) => row.outcome === 'version_conflict' && row.applied_version === null))
  })

  test('delete cascades attachments but preserves the enqueue mutation ledger', async (t) => {
    if (!maybe(t) || !store || !pool) return
    const mediaUrl = `/api/media/${'a'.repeat(64)}.png`
    await store.mutate(owner1, {
      ...enqueue(owner1, 'item-media', 'enqueue-media'),
      type: 'inbound.prompt_queue.enqueue',
      content: { text: 'media', media: [{ kind: 'image', url: mediaUrl }] },
    })
    await store.mutate(owner1, {
      type: 'inbound.prompt_queue.delete', peer: owner1.peer, agentId: 'main', itemId: 'item-media',
      expectedVersion: '1', idempotencyKey: 'delete-media',
    })
    assert.equal((await pool.query('SELECT 1 FROM prompt_queue_item_attachments')).rowCount, 0)
    const mutations = await pool.query<{ idempotency_key: string }>(
      'SELECT idempotency_key FROM prompt_queue_mutations ORDER BY idempotency_key',
    )
    assert.deepEqual(mutations.rows.map((row) => row.idempotency_key), ['delete-media', 'enqueue-media'])
  })

  test('reorder requires the complete waiting set and keeps positions contiguous', async (t) => {
    if (!maybe(t) || !store) return
    for (const [i, id] of ['a', 'b', 'c'].entries()) {
      await store.mutate(owner1, enqueue(owner1, id, `enqueue-${id}`, id))
      assert.equal((await store.getSnapshot(owner1)).version, String(i + 1))
    }
    const rejected = await store.mutate(owner1, {
      type: 'inbound.prompt_queue.reorder', peer: owner1.peer, agentId: 'main',
      orderedItemIds: ['c', 'a'], expectedVersion: '3', idempotencyKey: 'bad-reorder',
    })
    assert.equal(rejected.snapshot.mutation?.outcome, 'rejected')
    assert.equal(rejected.snapshot.version, '3')
    const applied = await store.mutate(owner1, {
      type: 'inbound.prompt_queue.reorder', peer: owner1.peer, agentId: 'main',
      orderedItemIds: ['c', 'a', 'b'], expectedVersion: '3', idempotencyKey: 'good-reorder',
    })
    assert.equal(applied.snapshot.version, '4')
    assert.deepEqual(applied.snapshot.items.map((item) => [item.id, item.position]), [
      ['c', 1], ['a', 2], ['b', 3],
    ])
  })
})

describe('PgPromptQueueStore claim fencing and blocked state', () => {
  test('renew, live-owner rejection, expired takeover, stale CAS, blocked release and active projection', async (t) => {
    if (!maybe(t) || !store || !pool) return
    await store.mutate(owner1, enqueue(owner1, 'a', 'enqueue-a'))
    await store.mutate(owner1, enqueue(owner1, 'b', 'enqueue-b'))
    const acquired = await store.claim(owner1, 10, { action: 'acquire', expectedVersion: '2' })
    assert.equal(acquired.outcome, 'acquired')
    assert.equal(acquired.snapshot.version, '3')
    assert.equal(acquired.claim?.epoch, '1')
    assert.deepEqual(acquired.snapshot.items.map((item) => [item.id, item.position]), [['b', 1]])

    const renewed = await store.claim(owner1, 10, { action: 'acquire', expectedVersion: '3' })
    assert.equal(renewed.outcome, 'renewed')
    assert.equal(renewed.snapshot.version, '3')
    assert.equal(renewed.claim?.claimToken, acquired.claim?.claimToken)

    const liveOther = await store.claim(owner1, 11, { action: 'acquire', expectedVersion: '3' })
    assert.equal(liveOther.outcome, 'rejected')
    assert.equal(liveOther.code, 'CLAIM_HELD')
    assert.equal(liveOther.snapshot.version, '3')
    const beforeExpiry = await pool.query<{ coordinator_epoch: string; current_claim_token: string }>(
      `SELECT coordinator_epoch::text,current_claim_token FROM prompt_queue_heads
        WHERE owner_user_id=1 AND session_key=$1`, [owner1.sessionKey],
    )
    assert.equal(beforeExpiry.rows[0]?.coordinator_epoch, '1')
    assert.equal(beforeExpiry.rows[0]?.current_claim_token, acquired.claim?.claimToken)

    await pool.query(
      `UPDATE prompt_queue_heads SET lease_until=NOW()-INTERVAL '1 second'
        WHERE owner_user_id=1 AND session_key=$1`, [owner1.sessionKey],
    )
    await pool.query(
      `UPDATE prompt_queue_items SET claim_until=NOW()-INTERVAL '1 second'
        WHERE owner_user_id=1 AND session_key=$1 AND state='dispatch_claimed'`, [owner1.sessionKey],
    )
    const takeover = await store.claim(owner1, 11, { action: 'acquire', expectedVersion: '3' })
    assert.equal(takeover.outcome, 'acquired')
    assert.equal(takeover.snapshot.version, '4')
    assert.equal(takeover.claim?.epoch, '2')
    assert.notEqual(takeover.claim?.claimToken, acquired.claim?.claimToken)

    await assert.rejects(
      store.claim(owner1, 10, {
        action: 'release', epoch: takeover.claim!.epoch, claimToken: takeover.claim!.claimToken,
        disposition: 'retryable',
      }),
      (err: unknown) => err instanceof PromptQueueStoreError && err.code === 'CLAIM_CAS_MISMATCH',
    )
    await assert.rejects(
      store.claim(owner1, 10, {
        action: 'release', epoch: acquired.claim!.epoch, claimToken: acquired.claim!.claimToken,
        disposition: 'retryable',
      }),
      (err: unknown) => err instanceof PromptQueueStoreError && err.code === 'CLAIM_CAS_MISMATCH',
    )
    const retryable = await store.claim(owner1, 11, {
      action: 'release', epoch: takeover.claim!.epoch, claimToken: takeover.claim!.claimToken,
      disposition: 'retryable',
    })
    assert.equal(retryable.snapshot.version, '5')
    assert.equal(retryable.snapshot.items[0]?.state, 'queued')
    const retryRow = await pool.query<{ blocked_reason_code: string | null; blocked_at: Date | null }>(
      `SELECT blocked_reason_code,blocked_at FROM prompt_queue_items
        WHERE owner_user_id=1 AND session_key=$1 AND item_id='a'`, [owner1.sessionKey],
    )
    assert.deepEqual(retryRow.rows[0], { blocked_reason_code: null, blocked_at: null })

    const retryClaim = await store.claim(owner1, 11, { action: 'acquire', expectedVersion: '5' })
    const blocked = await store.claim(owner1, 11, {
      action: 'release', epoch: retryClaim.claim!.epoch, claimToken: retryClaim.claim!.claimToken,
      disposition: 'user_action_required', reasonCode: 'MEDIA_MISSING',
    })
    assert.equal(blocked.snapshot.version, '7')
    assert.deepEqual(blocked.snapshot.items.map((item) => [item.id, item.position, item.state]), [
      ['a', 1, 'blocked'], ['b', 2, 'queued'],
    ])
    const blockedRow = await pool.query<{ blocked_reason_code: string; blocked_at: Date }>(
      `SELECT blocked_reason_code,blocked_at FROM prompt_queue_items
        WHERE owner_user_id=1 AND session_key=$1 AND item_id='a'`, [owner1.sessionKey],
    )
    assert.equal(blockedRow.rows[0]?.blocked_reason_code, 'MEDIA_MISSING')
    assert.ok(blockedRow.rows[0]?.blocked_at instanceof Date)

    const edited = await store.mutate(owner1, {
      type: 'inbound.prompt_queue.edit', peer: owner1.peer, agentId: 'main', itemId: 'a',
      expectedVersion: '7', idempotencyKey: 'unblock-a', content: { text: 'fixed' },
    })
    assert.equal(edited.snapshot.items[0]?.state, 'queued')
    const cleared = await pool.query<{ blocked_reason_code: string | null; blocked_at: Date | null }>(
      `SELECT blocked_reason_code,blocked_at FROM prompt_queue_items
        WHERE owner_user_id=1 AND session_key=$1 AND item_id='a'`, [owner1.sessionKey],
    )
    assert.deepEqual(cleared.rows[0], { blocked_reason_code: null, blocked_at: null })

    const next = await store.claim(owner1, 11, { action: 'acquire', expectedVersion: '8' })
    const beforeActivation = await pool.query<{ messages: string }>(
      'SELECT messages FROM client_sessions WHERE id=$1 AND user_id=$2',
      [owner1.clientSessionId, 'c:1'],
    )
    assert.deepEqual(JSON.parse(beforeActivation.rows[0]!.messages), [])
    const turnId = 'f'.repeat(64)
    const active = await store.claim(owner1, 11, {
      action: 'activate', epoch: next.claim!.epoch, claimToken: next.claim!.claimToken,
      turnId, turnIndex: 7, traceId: 'trace_prompt_queue_01', steerDelivery: 'turn-boundary',
    })
    assert.equal(active.snapshot.version, '10')
    assert.equal(active.snapshot.activeTurn?.id, turnId)
    assert.deepEqual(active.snapshot.items.map((item) => item.id), ['b'])
    const afterActivation = await pool.query<{ messages: string }>(
      'SELECT messages FROM client_sessions WHERE id=$1 AND user_id=$2',
      [owner1.clientSessionId, 'c:1'],
    )
    const materialized = JSON.parse(afterActivation.rows[0]!.messages) as Array<Record<string, unknown>>
    assert.equal(materialized.length, 1)
    assert.equal(materialized[0]?.id, 'a')
    assert.equal(materialized[0]?.role, 'user')
    assert.equal(materialized[0]?.text, 'fixed')
    const noRerun = await store.claim(owner1, 11, { action: 'acquire', expectedVersion: '10' })
    assert.equal(noRerun.outcome, 'rejected')
    assert.equal(noRerun.code, 'ACTIVE_TURN')
    assert.equal(noRerun.snapshot.version, '10')
    const tooEarly = await store.claim(owner1, 11, {
      action: 'complete', turnId, turnIndex: 7,
    })
    assert.equal(tooEarly.outcome, 'rejected')
    assert.equal(tooEarly.code, 'TAPE_NOT_ACKED')
    assert.equal(tooEarly.snapshot.version, '10')
    await pool.query(
      `INSERT INTO server_authored_turn_anchor_map
         (user_id,turn_key,session_id,tape_id,billing_anchor_id,written_at)
       VALUES ('c:1',$1,$2,'tape-1','anchor-1',$3)`,
      [turnId, owner1.clientSessionId, Date.now()],
    )
    const completed = await store.claim(owner1, 11, {
      action: 'complete', turnId, turnIndex: 7,
    })
    assert.equal(completed.outcome, 'completed')
    assert.equal(completed.snapshot.version, '11')
    assert.equal(completed.snapshot.activeTurn, null)
    assert.deepEqual(completed.snapshot.items.map((item) => item.id), ['b'])
  })

  test('matching native interject enters delivery lane; replay keeps token; turn mismatch moves to head', async (t) => {
    if (!maybe(t) || !store) return
    await store.mutate(owner1, enqueue(owner1, 'active-source', 'enqueue-active'))
    await store.mutate(owner1, enqueue(owner1, 'steer-me', 'enqueue-steer'))
    const claim = await store.claim(owner1, 21, { action: 'acquire', expectedVersion: '2' })
    const turnId = 'c'.repeat(64)
    await store.claim(owner1, 21, {
      action: 'activate', epoch: claim.claim!.epoch, claimToken: claim.claim!.claimToken,
      turnId, turnIndex: 8, steerDelivery: 'native',
    })
    const interject: PromptQueueMutationFrame = {
      type: 'inbound.prompt_queue.interject', peer: owner1.peer, agentId: 'main', itemId: 'steer-me',
      mode: 'insert_current', expectedVersion: '4', expectedTurnId: turnId,
      idempotencyKey: 'interject-native',
    }
    const pending = await store.mutate(owner1, interject)
    assert.equal(pending.snapshot.version, '5')
    assert.equal(pending.snapshot.mutation?.outcome, 'delivery_pending')
    assert.equal(pending.snapshot.items[0]?.state, 'steer_pending')
    assert.equal(pending.snapshot.items[0]?.position, null)
    assert.match(pending.deliveryToken ?? '', /^[0-9a-f]{64}$/)
    const replay = await store.mutate(owner1, interject)
    assert.equal(replay.snapshot.mutation?.outcome, 'duplicate')
    assert.equal(replay.deliveryToken, pending.deliveryToken)

    await store.mutate(owner1, enqueue(owner1, 'boundary', 'enqueue-boundary'))
    const changed = await store.mutate(owner1, {
      type: 'inbound.prompt_queue.interject', peer: owner1.peer, agentId: 'main', itemId: 'boundary',
      mode: 'insert_current', expectedVersion: '6', expectedTurnId: 'd'.repeat(64),
      idempotencyKey: 'interject-turn-changed',
    })
    assert.equal(changed.snapshot.version, '7')
    assert.equal(changed.snapshot.mutation?.outcome, 'turn_changed')
    assert.deepEqual(changed.snapshot.items.map((item) => [item.id, item.position]), [
      ['boundary', 1], ['steer-me', null],
    ])
  })

  test('database enforces blocked reason/at in both directions', async (t) => {
    if (!maybe(t) || !store || !pool) return
    await store.mutate(owner1, enqueue(owner1, 'a', 'enqueue-a'))
    await assert.rejects(
      pool.query(
        `UPDATE prompt_queue_items SET state='blocked',blocked_reason_code=NULL,blocked_at=NULL
          WHERE owner_user_id=1 AND session_key=$1 AND item_id='a'`, [owner1.sessionKey],
      ),
      /prompt_queue_items_blocked_chk/,
    )
    await assert.rejects(
      pool.query(
        `UPDATE prompt_queue_items SET blocked_reason_code='BAD',blocked_at=NOW()
          WHERE owner_user_id=1 AND session_key=$1 AND item_id='a'`, [owner1.sessionKey],
      ),
      /prompt_queue_items_blocked_chk/,
    )
  })
})

describe('PgPromptQueueStore fixed-seed mutation properties', () => {
  test('random enqueue/edit/delete/reorder sequence preserves monotonic version and positions', async (t) => {
    if (!maybe(t) || !store || !pool) return
    let seed = 0x51f15e
    const random = (): number => {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0
      return seed / 0x1_0000_0000
    }
    const ids: string[] = []
    let keySeq = 0
    let previousVersion = 0n
    for (let step = 0; step < 30; step += 1) {
      const snapshot = await store.getSnapshot(owner1)
      const roll = random()
      if (ids.length < 2 || (roll < 0.4 && ids.length < 12)) {
        const id = `random-${step}`
        ids.push(id)
        await store.mutate(owner1, enqueue(owner1, id, `random-key-${keySeq++}`))
      } else if (roll < 0.68) {
        const index = Math.floor(random() * ids.length)
        await store.mutate(owner1, {
          type: 'inbound.prompt_queue.edit', peer: owner1.peer, agentId: 'main', itemId: ids[index]!,
          expectedVersion: snapshot.version, idempotencyKey: `random-key-${keySeq++}`,
          content: { text: `edit-${step}` },
        })
      } else if (roll < 0.82 && ids.length > 1) {
        const index = Math.floor(random() * ids.length)
        const [removed] = ids.splice(index, 1)
        await store.mutate(owner1, {
          type: 'inbound.prompt_queue.delete', peer: owner1.peer, agentId: 'main', itemId: removed!,
          expectedVersion: snapshot.version, idempotencyKey: `random-key-${keySeq++}`,
        })
      } else {
        ids.sort(() => random() - 0.5)
        await store.mutate(owner1, {
          type: 'inbound.prompt_queue.reorder', peer: owner1.peer, agentId: 'main',
          orderedItemIds: [...ids], expectedVersion: snapshot.version,
          idempotencyKey: `random-key-${keySeq++}`,
        })
      }
      const afterMutation: PromptQueueSnapshot = await store.getSnapshot(owner1)
      const version = BigInt(afterMutation.version)
      assert.ok(version > previousVersion, `version did not advance at step ${step}`)
      previousVersion = version
      assert.deepEqual(afterMutation.items.map((item) => item.position),
        afterMutation.items.map((_, index) => index + 1))
      assert.equal(new Set(afterMutation.items.map((item) => item.id)).size, afterMutation.items.length)
      const invariants = await pool.query<{ active: string; claimed: string }>(
        `SELECT COUNT(*) FILTER (WHERE state='active')::text AS active,
                COUNT(*) FILTER (WHERE state='dispatch_claimed')::text AS claimed
           FROM prompt_queue_items WHERE owner_user_id=1 AND session_key=$1`, [owner1.sessionKey],
      )
      assert.ok(Number(invariants.rows[0]?.active) <= 1)
      assert.ok(Number(invariants.rows[0]?.claimed) <= 1)
    }
  })
})

const e2eConfig = {
  version: 1,
  gateway: { bind: '127.0.0.1', port: 0, accessToken: '' },
  auth: { mode: 'subscription', claudeCodePath: '' },
  sessions: { dbPath: '' },
} as unknown as OpenClaudeConfig

class E2eCcbKernel extends EventEmitter {
  submitted = false
  lastActivityAt = Date.now()
  sessionId: string | null = 'ccb-prompt-queue-e2e'
  get isRunning() { return true }
  async submit(): Promise<void> { this.submitted = true }
  finish(): void {
    this.emit('message', {
      type: 'result', total_cost_usd: 0, usage: { output_tokens: 1 },
      stop_reason: 'end_turn', is_error: false,
    })
  }
  async start(): Promise<void> {}
  async shutdown(): Promise<void> {}
  async waitForOutputDrain(): Promise<void> {}
  interrupt(): boolean { return false }
  clearSessionId(): void { this.sessionId = null }
  setModel(): void {}
  setEffortLevel(): void {}
  setTraceId(): void {}
  setGoalState(): boolean { return false }
  updateConfig(): void {}
  setToolsets(): void {}
  setExecutionTarget(): void {}
  sendPermissionResponse(): boolean { return false }
  getBoundRepoBinding(): null { return null }
  async updateTurnLease(): Promise<void> {}
}

class E2eCodexKernel extends EventEmitter {
  submitted = false
  queueTurn: boolean | undefined
  requestId: string | undefined
  lastActivityAt = Date.now()
  model: string | undefined = 'gpt-5.6-sol'
  get isRunning() { return true }
  async submit(_input: unknown, requestId?: string, _policy?: unknown, queueTurn?: boolean) {
    this.submitted = true
    this.requestId = requestId
    this.queueTurn = queueTurn
  }
  finish(): void {
    this.emit('message', {
      type: 'result', total_cost_usd: 0, usage: { output_tokens: 1 },
      stop_reason: 'end_turn', is_error: false, requestId: this.requestId,
    })
  }
  async start(): Promise<void> {}
  async shutdown(): Promise<void> {}
  async waitForOutputDrain(): Promise<void> {}
  interrupt(): boolean { return false }
  clearSessionId(): void {}
  setModel(value: string | undefined): void { this.model = value }
  setEffortLevel(): void {}
  setTraceId(): void {}
  async setGoalState(): Promise<void> {}
  updateConfig(): void {}
  setCodexRoute(): void {}
  setConversationMode(): void {}
  sendPermissionResponse(): boolean { return false }
  getBoundRepoBinding(): null { return null }
}

function e2eSession(runner: EngineAdapter, engine: 'ccb' | 'codex'): AgentSession {
  return {
    sessionKey: owner1.sessionKey,
    agentId: owner1.agentId,
    channel: 'webchat',
    peerId: owner1.clientSessionId,
    title: 'Prompt queue E2E',
    startedAt: Date.now(),
    runner,
    ccbSessionId: null,
    lock: Promise.resolve(),
    lastUsedAt: 0,
    totalCostUSD: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    turns: 0,
    _lastCcbCumulativeCost: 0,
    _activeClientTurnCount: 1,
    toolUseIdToName: new Map(),
    executionTarget: { kind: 'local' },
    providerTag: engine,
    userId: '1',
  } as unknown as AgentSession
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  // This matrix runs behind the repository-wide commercial test mutex and can
  // inherit short CPU/PG contention from the preceding full gate. Activation
  // crosses real HTTP + PG; keep the assertion deterministic under that load.
  const deadline = Date.now() + 10_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
}

function waitForWsSnapshot(ws: WebSocket): Promise<PromptQueueSnapshot> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('queue snapshot websocket timeout')), 2_000)
    const onMessage = (raw: WebSocket.RawData) => {
      try {
        const value = JSON.parse(raw.toString()) as PromptQueueSnapshot
        if (value.type !== 'outbound.prompt_queue.snapshot') return
        clearTimeout(timer)
        ws.off('message', onMessage)
        resolve(value)
      } catch {}
    }
    ws.on('message', onMessage)
  })
}

describe('P2 real PG/HTTP/coordinator/engine restart matrix', () => {
  for (const engine of ['ccb', 'codex'] as const) {
    test(`${engine} executes the full turn-boundary matrix through real boundaries`, async (t) => {
      if (!maybe(t) || !pool) return

      const secret = '9'.repeat(64)
      const identityRepo: ContainerIdentityRepo = {
        async findActiveByHostAndBoundIp() {
          return {
            id: 77,
            user_id: 1,
            bound_ip: '10.77.0.2',
            host_uuid: 'host-e2e',
            secret_hash: hashSecret(secret),
          }
        },
      }
      let masterStore = new PgPromptQueueStore(pool)
      let handler = makePromptQueueHandler({ identityRepo, store: masterStore })
      const api = createServer((req, res) => {
        void handler(req, res, { hostUuid: 'host-e2e', boundIp: '10.77.0.2' })
          .catch((err) => {
            res.statusCode = 500
            res.end(JSON.stringify({ error: { code: 'TEST_HANDLER', message: String(err) } }))
          })
      })
      await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve))
      const baseUrl = `http://127.0.0.1:${(api.address() as { port: number }).port}`
      const client = new HttpPromptQueueClient({
        baseUrl,
        bearer: `oc-v3.77.${secret}`,
        userId: '1',
      })
      const context: PromptQueueSessionContext = {
        userId: '1',
        owner: {
          sessionKey: owner1.sessionKey,
          clientSessionId: owner1.clientSessionId,
          agentId: owner1.agentId,
          peer: owner1.peer,
        },
      }

      const activeTurnId = (engine === 'ccb' ? '31' : '32').repeat(32)
      await client.mutate(context.owner, enqueue(owner1, 'active-seed', `${engine}-active`))
      const seedClaim = await client.claim(context.owner, { action: 'acquire', expectedVersion: '1' })
      await client.claim(context.owner, {
        action: 'activate',
        epoch: seedClaim.claim!.epoch,
        claimToken: seedClaim.claim!.claimToken,
        turnId: activeTurnId,
        turnIndex: 1,
        steerDelivery: 'turn-boundary',
      })
      const accountingBeforeQueue = await pool.query<{
        credits: string
        ledger_count: string
        usage_count: string
        journal_count: string
      }>(`SELECT credits::text AS credits,
              (SELECT COUNT(*)::text FROM credit_ledger WHERE user_id=1) AS ledger_count,
              (SELECT COUNT(*)::text FROM usage_records WHERE user_id=1) AS usage_count,
              (SELECT COUNT(*)::text FROM request_finalize_journal WHERE user_id=1) AS journal_count
            FROM users WHERE id=1`)

      let coordinator!: PromptQueueCoordinator
      const serverSockets = new Set<WebSocket>()
      const dispatches: PromptQueueDispatchRequest[] = []
      const interrupted: string[] = []
      const broadcastState: { latest?: PromptQueueSnapshot } = {}
      const coordinatorCallbacks = (
        recoverActive = false,
        dispatchTarget: PromptQueueDispatchRequest[] = dispatches,
      ) => ({
        broadcast: (_context: PromptQueueSessionContext, value: PromptQueueSnapshot) => {
          broadcastState.latest = value
          const encoded = JSON.stringify(value)
          for (const socket of serverSockets) if (socket.readyState === WebSocket.OPEN) socket.send(encoded)
        },
        direct: (_context: PromptQueueSessionContext, requester: object, value: PromptQueueSnapshot) => {
          ;(requester as WebSocket).send(JSON.stringify(value))
        },
        sendDispatch: (_context: PromptQueueSessionContext, frame: PromptQueueDispatchRequest) => {
          dispatchTarget.push(frame)
          return true
        },
        interruptExact: async () => false,
        ...(recoverActive
          ? {
              persistInterrupted: async ({ turnId }: { turnId: string }) => {
                interrupted.push(turnId)
                await pool!.query(
                  `INSERT INTO server_authored_turn_anchor_map
                     (user_id,turn_key,session_id,tape_id,billing_anchor_id,written_at)
                   VALUES ('c:1',$1,$2,$3,$4,$5)
                   ON CONFLICT (user_id,turn_key) DO NOTHING`,
                  [
                    turnId,
                    owner1.clientSessionId,
                    `tape-${engine}-restart`,
                    `anchor-${engine}-restart`,
                    Date.now(),
                  ],
                )
              },
            }
          : {}),
      })
      coordinator = new PromptQueueCoordinator(client, coordinatorCallbacks())

      const browserWss = new WebSocketServer({ port: 0 })
      await new Promise<void>((resolve) => browserWss.once('listening', resolve))
      browserWss.on('connection', (socket) => {
        serverSockets.add(socket)
        socket.on('message', (raw) => {
          let value: unknown
          try { value = JSON.parse(raw.toString()) } catch { return }
          if ((value as { type?: unknown }).type === 'inbound.hello') {
            void coordinator.hello(context, socket)
          }
        })
        socket.once('close', () => {
          serverSockets.delete(socket)
          void coordinator.disconnect(context, socket)
        })
      })
      const wsUrl = `ws://127.0.0.1:${(browserWss.address() as { port: number }).port}`
      const tab1 = new WebSocket(wsUrl)
      let tab2 = new WebSocket(wsUrl)
      await Promise.all([
        new Promise<void>((resolve) => tab1.once('open', resolve)),
        new Promise<void>((resolve) => tab2.once('open', resolve)),
      ])
      t.after(async () => {
        coordinator.shutdown()
        try { tab1.terminate() } catch {}
        try { tab2.terminate() } catch {}
        for (const socket of serverSockets) try { socket.terminate() } catch {}
        await new Promise<void>((resolve) => browserWss.close(() => resolve()))
        api.closeAllConnections()
        await new Promise<void>((resolve) => api.close(() => resolve()))
      })
      const tab1Hello = waitForWsSnapshot(tab1)
      const tab2Hello = waitForWsSnapshot(tab2)
      tab1.send(JSON.stringify({ type: 'inbound.hello' }))
      tab2.send(JSON.stringify({ type: 'inbound.hello' }))
      assert.equal((await tab1Hello).activeTurn?.id, activeTurnId)
      assert.equal((await tab2Hello).activeTurn?.id, activeTurnId)

      if (engine === 'ccb') {
        // One direct six-surface proof: browser mutations traverse the real
        // commercial bridge, a container WebSocket, this coordinator, internal
        // HTTP and PG. While all N durable rows exist, no account slot, Redis
        // reservation, journal, usage, ledger or wallet state may move.
        const seam = {
          slotAcquire: 0,
          slotRelease: 0,
          precheckReserve: 0,
          precheckRelease: 0,
          billingQuery: 0,
        }
        const proofContainerWss = new WebSocketServer({ port: 0 })
        await new Promise<void>((resolve) => proofContainerWss.once('listening', resolve))
        const proofContainerPort = (proofContainerWss.address() as { port: number }).port
        let proofApplied = 0
        let resolveProofApplied!: () => void
        const allProofApplied = new Promise<void>((resolve) => { resolveProofApplied = resolve })
        proofContainerWss.on('connection', (socket) => {
          socket.on('message', (raw) => {
            let mutation: unknown
            try { mutation = JSON.parse(raw.toString()) } catch { return }
            if (!(mutation as { type?: unknown }).type?.toString().startsWith('inbound.prompt_queue.')) {
              return
            }
            void coordinator.mutate(context, mutation as PromptQueueMutationFrame, socket)
              .then(() => {
                proofApplied += 1
                if (proofApplied === 3) resolveProofApplied()
              })
          })
        })
        const proofSecret = 's'.repeat(32)
        const proofBridge = createUserChatBridge({
          jwtSecret: proofSecret,
          promptQueueEnabled: true,
          heartbeatIntervalMs: 0,
          resolveContainerEndpoint: async () => ({
            host: '127.0.0.1',
            port: proofContainerPort,
            containerId: 77,
          }),
          codexBinding: {
            async acquire() {
              seam.slotAcquire += 1
              return { account_id: 1n, slotId: 'unexpected-queue-slot' }
            },
            release() { seam.slotRelease += 1 },
          },
          preCheckRedis: {
            async atomicReserve() {
              seam.precheckReserve += 1
              return { ok: true as const, locked: 0n, needed: 0n }
            },
            async releaseReservation() {
              seam.precheckRelease += 1
              return true
            },
          },
          pgPool: {
            async query(statement: unknown) {
              const sql = typeof statement === 'string'
                ? statement
                : String((statement as { text?: unknown })?.text ?? '')
              if (/request_finalize_journal|usage_records|credit_ledger|credits\s*=/.test(sql)) {
                seam.billingQuery += 1
              }
              return { rows: [], rowCount: 0 }
            },
          } as unknown as NonNullable<UserChatBridgeDeps['pgPool']>,
          pricing: { get: () => null } as unknown as NonNullable<UserChatBridgeDeps['pricing']>,
        })
        const proofGateway = createServer((_, res) => res.end())
        proofGateway.on('upgrade', (req, socket, head) => {
          if (!proofBridge.handleUpgrade(req, socket, head)) socket.destroy()
        })
        await new Promise<void>((resolve) => proofGateway.listen(0, '127.0.0.1', resolve))
        const proofToken = (await signAccess({ sub: '1', role: 'user' }, proofSecret)).token
        const proofBrowser = new WebSocket(
          `ws://127.0.0.1:${(proofGateway.address() as { port: number }).port}${BRIDGE_WS_PATH}`,
          ['bearer', proofToken],
        )
        await new Promise<void>((resolve) => proofBrowser.once('open', resolve))
        const seamBefore = { ...seam }
        const proofIds = ['durable-zero-0', 'durable-zero-1', 'durable-zero-2']
        try {
          for (const [index, itemId] of proofIds.entries()) {
            proofBrowser.send(JSON.stringify({
              ...enqueue(owner1, itemId, `durable-zero-key-${index}`, `queued ${index}`),
              requestedExecution: { model: 'gpt-5.6-sol' },
            }))
          }
          await allProofApplied
          assert.equal(
            (await pool.query(
              `SELECT COUNT(*)::int AS count FROM prompt_queue_items
                WHERE owner_user_id=1 AND session_key=$1 AND state='queued'`,
              [owner1.sessionKey],
            )).rows[0]?.count,
            3,
          )
          assert.deepEqual(seam, seamBefore, 'durable queue admission must not touch runtime accounting seams')
          const accountingAfterDurableN = await pool.query<{
            credits: string
            ledger_count: string
            usage_count: string
            journal_count: string
          }>(`SELECT credits::text AS credits,
                  (SELECT COUNT(*)::text FROM credit_ledger WHERE user_id=1) AS ledger_count,
                  (SELECT COUNT(*)::text FROM usage_records WHERE user_id=1) AS usage_count,
                  (SELECT COUNT(*)::text FROM request_finalize_journal WHERE user_id=1) AS journal_count
                FROM users WHERE id=1`)
          assert.deepEqual(accountingAfterDurableN.rows[0], accountingBeforeQueue.rows[0])

          let cleanupSnapshot = await client.snapshot(context.owner)
          for (const [index, itemId] of proofIds.entries()) {
            cleanupSnapshot = (await client.mutate(context.owner, {
              type: 'inbound.prompt_queue.delete',
              peer: owner1.peer,
              agentId: owner1.agentId,
              itemId,
              expectedVersion: cleanupSnapshot.version,
              idempotencyKey: `durable-zero-cleanup-${index}`,
            })).snapshot
          }
        } finally {
          try { proofBrowser.terminate() } catch {}
          await proofBridge.shutdown()
          for (const socket of proofContainerWss.clients) try { socket.terminate() } catch {}
          await new Promise<void>((resolve) => proofContainerWss.close(() => resolve()))
          proofGateway.closeAllConnections()
          await new Promise<void>((resolve) => proofGateway.close(() => resolve()))
        }
      }

      const requester = [...serverSockets][0]!
      const mutate = async (mutation: PromptQueueMutationFrame) => {
        broadcastState.latest = undefined
        await coordinator.mutate(context, mutation, requester)
        // The broadcast callback runs inside coordinator.mutate(), but TS does
        // not model side effects from callbacks across an await boundary.
        const latest = broadcastState.latest as PromptQueueSnapshot | undefined
        assert.ok(latest, `missing broadcast for ${mutation.type}`)
        return latest
      }
      let current = await mutate({
        ...enqueue(owner1, 'matrix-a', `${engine}-enqueue-a`, 'one'),
        requestedExecution: { model: engine === 'codex' ? 'gpt-5.6-sol' : 'glm-5.2' },
      })
      current = await mutate({
        type: 'inbound.prompt_queue.edit', peer: owner1.peer, agentId: 'main', itemId: 'matrix-a',
        expectedVersion: current.version, idempotencyKey: `${engine}-edit-a`,
        content: { text: 'edited' },
      })
      current = await mutate({
        ...enqueue(owner1, 'matrix-b', `${engine}-enqueue-b`, 'two'),
        requestedExecution: { model: engine === 'codex' ? 'gpt-5.6-sol' : 'glm-5.2' },
      })
      current = await mutate({
        type: 'inbound.prompt_queue.reorder', peer: owner1.peer, agentId: 'main',
        orderedItemIds: ['matrix-b', 'matrix-a'], expectedVersion: current.version,
        idempotencyKey: `${engine}-reorder`,
      })
      current = await mutate({
        type: 'inbound.prompt_queue.delete', peer: owner1.peer, agentId: 'main',
        itemId: 'matrix-a', expectedVersion: current.version,
        idempotencyKey: `${engine}-delete-a`,
      })
      current = await mutate({
        type: 'inbound.prompt_queue.interject', peer: owner1.peer, agentId: 'main',
        itemId: 'matrix-b', mode: 'insert_current', expectedVersion: current.version,
        expectedTurnId: activeTurnId, idempotencyKey: `${engine}-interject`,
      })
      assert.equal(current.mutation?.outcome, 'delivery_pending')
      assert.equal(current.items[0]?.state, 'queued')
      assert.equal(current.items[0]?.position, 1, 'turn-boundary interject stays losslessly at head')
      assert.equal(dispatches.length, 0)
      const accountingWhileQueued = await pool.query<{
        credits: string
        ledger_count: string
        usage_count: string
        journal_count: string
      }>(`SELECT credits::text AS credits,
              (SELECT COUNT(*)::text FROM credit_ledger WHERE user_id=1) AS ledger_count,
              (SELECT COUNT(*)::text FROM usage_records WHERE user_id=1) AS usage_count,
              (SELECT COUNT(*)::text FROM request_finalize_journal WHERE user_id=1) AS journal_count
            FROM users WHERE id=1`)
      assert.deepEqual(
        accountingWhileQueued.rows[0],
        accountingBeforeQueue.rows[0],
        'queued items must not change wallet, ledger, usage, or precheck journal state',
      )
      const rowsBeforeDispatch = await pool.query<{ messages: string }>(
        'SELECT messages FROM client_sessions WHERE id=$1 AND user_id=$2',
        [owner1.clientSessionId, 'c:1'],
      )
      assert.equal(JSON.parse(rowsBeforeDispatch.rows[0]!.messages).length, 1)

      // Master restart: rebuild the store/handler while the existing HTTP
      // client and coordinator continue against the same durable PG state.
      masterStore = new PgPromptQueueStore(pool)
      handler = makePromptQueueHandler({ identityRepo, store: masterStore })
      assert.equal((await client.snapshot(context.owner)).version, current.version)

      // Real browser tab restart: one authenticated transport remains while
      // the other disconnects and receives a fresh PG projection on reconnect.
      tab2.close()
      await new Promise<void>((resolve) => tab2.once('close', resolve))
      tab2 = new WebSocket(wsUrl)
      await new Promise<void>((resolve) => tab2.once('open', resolve))
      const restartedHello = waitForWsSnapshot(tab2)
      tab2.send(JSON.stringify({ type: 'inbound.hello' }))
      assert.equal((await restartedHello).version, current.version)

      // Container restart: discard all coordinator memory. The active seed is
      // persisted as one exact interrupted turn, completed by the PG anchor,
      // and is never dispatched again. The interjected item becomes the head.
      coordinator.shutdown()
      coordinator = new PromptQueueCoordinator(client, coordinatorCallbacks(true))
      await coordinator.hello(context, [...serverSockets][0]!)
      assert.deepEqual(interrupted, [activeTurnId])
      assert.equal(dispatches.length, 1)
      assert.equal(dispatches[0]?.item.itemId, 'matrix-b')

      const dispatch = dispatches[0]!
      const lifecycle = coordinator.acceptGrant(context, {
        grantId: dispatch.grantId,
        itemId: dispatch.item.itemId,
        contentHash: dispatch.item.contentHash,
        epoch: dispatch.claim.epoch,
        claimToken: dispatch.claim.claimToken,
      })
      assert.ok(lifecycle)

      const kernel = engine === 'ccb' ? new E2eCcbKernel() : new E2eCodexKernel()
      const opts = {
        sessionKey: owner1.sessionKey,
        agentId: owner1.agentId,
        agentBaseDir: process.cwd(),
        model: engine === 'codex' ? 'gpt-5.6-sol' : 'glm-5.2',
      } as EngineCreateOpts
      const adapter: EngineAdapter = engine === 'ccb'
        ? new CcbAdapter(opts, kernel as unknown as SubprocessRunner)
        : new CodexAdapter(opts, kernel as any)
      const session = e2eSession(adapter, engine)
      const manager = new SessionManager(e2eConfig)
      ;(manager as unknown as { _saveResumeMap: () => void })._saveResumeMap = () => {}
      const execution = manager.submit(
        session,
        'two',
        () => {},
        undefined,
        undefined,
        engine === 'codex' ? 'ab'.repeat(16) : undefined,
        undefined,
        undefined,
        { queueLifecycle: lifecycle! },
      )
      await waitUntil(() => kernel.submitted, `${engine} adapter did not submit`)
      if (kernel instanceof E2eCodexKernel) assert.equal(kernel.queueTurn, true)
      const active = await client.snapshot(context.owner)
      const activeDetail = await client.detail(context.owner, 'matrix-b')
      assert.equal(active.activeTurn?.sourceItemId, 'matrix-b')
      assert.ok(activeDetail.engineReceipt?.turnIndex !== undefined)
      kernel.finish()
      await execution
      // submit() is normally wrapped by dispatchInbound's client-turn
      // lifecycle. This direct engine matrix owns that matching decrement.
      manager.endClientTurn(session, 'completed')
      await pool.query(
        `INSERT INTO server_authored_turn_anchor_map
           (user_id,turn_key,session_id,tape_id,billing_anchor_id,written_at)
         VALUES ('c:1',$1,$2,$3,$4,$5)`,
        [active.activeTurn!.id, owner1.clientSessionId, `tape-${engine}-done`, `anchor-${engine}-done`, Date.now()],
      )
      await lifecycle!.onSettled()
      const completed = await client.snapshot(context.owner)
      assert.equal(completed.activeTurn, null)
      assert.deepEqual(completed.items, [])

      if (engine === 'codex') {
        // Exercise ImageEdit from a fresh container coordinator so this proof
        // does not inherit any in-memory scheduling state from the prior text
        // turn. Durable PG state and the execution session remain unchanged.
        coordinator.shutdown()
        const imageDispatches: PromptQueueDispatchRequest[] = []
        coordinator = new PromptQueueCoordinator(client, coordinatorCallbacks(false, imageDispatches))
        await coordinator.hello(context, requester)

        const sourceUrl = `/api/media/${'41'.repeat(32)}.png`
        const maskUrl = `/api/media/${'42'.repeat(32)}.png`
        const guideUrl = `/api/media/${'43'.repeat(32)}.png`
        await coordinator.mutate(context, {
          type: 'inbound.prompt_queue.enqueue',
          channel: 'webchat',
          peer: owner1.peer,
          agentId: owner1.agentId,
          itemId: 'queued-image-edit',
          clientMessageId: 'queued-image-edit',
          idempotencyKey: 'queued-image-edit-enqueue',
          content: {
            text: '把圈选区域改成晚霞',
            media: [
              { kind: 'image', url: sourceUrl },
              { kind: 'image', url: maskUrl, hidden: true },
              { kind: 'image', url: guideUrl, hidden: true },
            ],
            imageEdit: {
              clientJobId: '51'.repeat(16),
              sourceIndex: 0,
              maskIndex: 1,
              guideIndex: 2,
              width: 1024,
              height: 768,
            },
          },
          requestedExecution: { model: 'gpt-5.6-sol' },
        }, requester)
        await coordinator.reconcile(context)
        assert.equal(imageDispatches.length, 1)
        const imageDispatch = imageDispatches[0]!
        const imageLifecycle = coordinator.acceptGrant(context, {
          grantId: imageDispatch.grantId,
          itemId: imageDispatch.item.itemId,
          contentHash: imageDispatch.item.contentHash,
          epoch: imageDispatch.claim.epoch,
          claimToken: imageDispatch.claim.claimToken,
        })
        assert.ok(imageLifecycle)

        const externalGuard = await manager.beginExternalTurn(session, { queueTurn: true })
        const imageReservation = await manager.reservePromptQueueExternalTurn(
          session,
          imageLifecycle!,
          '52'.repeat(16),
        )
        const activeImage = await client.snapshot(context.owner)
        assert.equal(activeImage.activeTurn?.id, imageReservation.turnKey)
        assert.equal(activeImage.activeTurn?.sourceItemId, 'queued-image-edit')

        // The paid provider is the only external dependency represented by a
        // local function. Queue claim/activation, the execution mutex and the
        // exact lossless-turn anchor all use their production state machines.
        let paidRelayCalls = 0
        const runPaidImageRelay = async (): Promise<string> => {
          paidRelayCalls += 1
          return `/api/media/${'61'.repeat(32)}.png`
        }
        const generatedUrl = await runPaidImageRelay()
        const tapeSink = {
          persistOrQueue: async (payload: V3MasterSinkPayload) => {
            assert.equal(payload.turnKey, imageReservation.turnKey)
            assert.equal(payload.sessionId, owner1.clientSessionId)
            await pool!.query(
              `INSERT INTO server_authored_turn_anchor_map
                 (user_id,turn_key,session_id,tape_id,billing_anchor_id,written_at)
               VALUES ('c:1',$1,$2,$3,$4,$5)`,
              [
                payload.turnKey,
                payload.sessionId,
                'tape-codex-image-edit',
                'anchor-codex-image-edit',
                Date.now(),
              ],
            )
            return { ok: true } as const
          },
          attemptOnce: async () => { throw new Error('not used') },
        } as V3MasterSink
        setV3MasterSinkSingleton(tapeSink)
        try {
          await manager.recordExternalTurn(session, {
            userText: '把圈选区域改成晚霞',
            assistantText: `已完成图片编辑。\n\n![编辑结果](${generatedUrl})`,
            requestId: '62'.repeat(16),
            traceId: '52'.repeat(16),
            model: 'gpt-image-2',
          }, imageReservation)
        } finally {
          setV3MasterSinkSingleton(null)
        }
        externalGuard.finish('completed')
        await imageLifecycle!.onSettled()
        const imageCompleted = await client.snapshot(context.owner)
        assert.equal(paidRelayCalls, 1)
        assert.equal(imageCompleted.activeTurn, null)
        assert.deepEqual(imageCompleted.items, [])
        assert.equal(
          (await pool.query(
            `SELECT COUNT(*)::int AS count FROM server_authored_turn_anchor_map
              WHERE user_id='c:1' AND turn_key=$1`,
            [imageReservation.turnKey],
          )).rows[0]?.count,
          1,
          'queued ImageEdit must complete only after its exact external-turn tape anchor exists',
        )
      }

    })
  }
})
