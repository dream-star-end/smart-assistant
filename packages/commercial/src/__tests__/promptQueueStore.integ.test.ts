import { after, before, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import type {
  InboundPromptQueueEnqueue,
  PromptQueueMutationFrame,
  PromptQueueSnapshot,
} from '@openclaude/protocol'

import {
  PgPromptQueueStore,
  PromptQueueStoreError,
  type PromptQueueOwner,
} from '../promptQueue/pgPromptQueueStore.js'

const TEST_DB_URL = process.env.TEST_DATABASE_URL
  ?? 'postgres://octest:octest@127.0.0.1:5432/openclaude_commercial_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'
const SCHEMA = 'oc_prompt_queue_p1_test'
const here = path.dirname(fileURLToPath(import.meta.url))
const MIGRATION = path.resolve(here, '../db/migrations/0163_prompt_queue.sql')

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
  await pool.query('CREATE TABLE users (id BIGINT PRIMARY KEY)')
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
    'TRUNCATE prompt_queue_item_attachments,prompt_queue_mutations,prompt_queue_items,prompt_queue_heads,users CASCADE',
  )
  await pool.query('INSERT INTO users(id) VALUES (1),(2)')
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

describe('0163_prompt_queue migration', () => {
  test('0163 is the production-ledger-calibrated first unapplied migration', () => {
    assert.equal(path.basename(MIGRATION), '0163_prompt_queue.sql')
    assert.match(migrationSql.split('\n')[0] ?? '', /^-- 0163_prompt_queue/)
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
    const turnId = 'f'.repeat(64)
    const active = await store.claim(owner1, 11, {
      action: 'activate', epoch: next.claim!.epoch, claimToken: next.claim!.claimToken,
      turnId, traceId: 'trace_prompt_queue_01', steerDelivery: 'turn-boundary',
    })
    assert.equal(active.snapshot.version, '10')
    assert.equal(active.snapshot.activeTurn?.id, turnId)
    assert.deepEqual(active.snapshot.items.map((item) => item.id), ['b'])
    const noRerun = await store.claim(owner1, 11, { action: 'acquire', expectedVersion: '10' })
    assert.equal(noRerun.outcome, 'rejected')
    assert.equal(noRerun.code, 'ACTIVE_TURN')
    assert.equal(noRerun.snapshot.version, '10')
  })

  test('matching native interject enters delivery lane; replay keeps token; turn mismatch moves to head', async (t) => {
    if (!maybe(t) || !store) return
    await store.mutate(owner1, enqueue(owner1, 'active-source', 'enqueue-active'))
    await store.mutate(owner1, enqueue(owner1, 'steer-me', 'enqueue-steer'))
    const claim = await store.claim(owner1, 21, { action: 'acquire', expectedVersion: '2' })
    const turnId = 'c'.repeat(64)
    await store.claim(owner1, 21, {
      action: 'activate', epoch: claim.claim!.epoch, claimToken: claim.claim!.claimToken,
      turnId, steerDelivery: 'native',
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
