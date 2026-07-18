import { createHash, randomBytes } from 'node:crypto'
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  PROMPT_QUEUE_MAX_TOTAL_CONTENT_BYTES,
  type PromptQueueAttachmentRef,
  type PromptQueueMutationFrame,
  type PromptQueueMutationOperation,
  type PromptQueueMutationOutcome,
  type PromptQueueSnapshot,
} from '@openclaude/protocol'
import type { Pool, PoolClient } from 'pg'
import { appendPromptQueueUserMessageInTransaction } from '../db/pgSessionsBackend.js'

const MAX_QUEUE_ITEMS = 50
const CLAIM_TTL_SECONDS = 30
const PG_BIGINT_MAX = 9_223_372_036_854_775_807n
const ITEM_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
const MEDIA_URL_RE = /^\/api\/media\/[0-9a-f]{64}\.[A-Za-z0-9]{1,32}$/
const MEDIA_KINDS = new Set(['image', 'audio', 'video', 'file'])

export interface PromptQueueOwner {
  userId: bigint
  sessionKey: string
  clientSessionId: string
  agentId: string
  peer: { id: string; kind: 'dm' }
}

export interface PromptQueueMutationResult {
  snapshot: PromptQueueSnapshot
  /** Server-only native/fork delivery dedupe token; never browser-authored. */
  deliveryToken?: string
}

export interface PromptQueueDetail {
  owner: PromptQueueSnapshot['owner']
  /** Queue version read atomically with the detail projection. */
  snapshotVersion: string
  itemId: string
  clientMessageId: string
  state: string
  content: Record<string, unknown>
  contentHash: string
  contentBytes: string
  attachments: Array<{
    ordinal: number
    kind: string
    url: string
    mimeType?: string
    filename?: string
    hidden?: boolean
    contentSha256?: string
    sizeBytes?: string
  }>
  requestedExecution: Record<string, unknown>
  deliveryIntent?: {
    mode?: string
    expectedTurnId?: string
    idempotencyKey?: string
  }
  /** Server-only recovery fields. They are never projected into browser snapshots. */
  deliveryToken?: string
  engineReceipt?: Record<string, unknown>
  blockedReasonCode?: string
  createdAt: number
  updatedAt: number
}

export type PromptQueueClaimRequest =
  | { action: 'acquire'; expectedVersion: string }
  | {
      action: 'release'
      epoch: string
      claimToken: string
      disposition: 'retryable' | 'user_action_required'
      reasonCode?: string
    }
  | {
      action: 'activate'
      epoch: string
      claimToken: string
      turnId: string
      /** Actual durable reservation made by SessionManager; never guessed by the coordinator. */
      turnIndex: number
      traceId?: string
      steerDelivery: 'native' | 'fork-native' | 'turn-boundary'
    }
  | {
      action: 'complete'
      turnId: string
      turnIndex: number
    }
  | {
      action: 'interrupt_ack'
      turnId: string
    }

export interface PromptQueueClaimResult {
  snapshot: PromptQueueSnapshot
  claim?: {
    itemId: string
    epoch: string
    claimToken: string
    leaseUntil: number
    renewed: boolean
  }
  outcome:
    | 'acquired'
    | 'renewed'
    | 'released'
    | 'activated'
    | 'completed'
    | 'interrupt_acknowledged'
    | 'empty'
    | 'rejected'
  code?: string
}

export class PromptQueueStoreError extends Error {
  constructor(
    readonly code:
      | 'INVALID_OWNER'
      | 'INVALID_REQUEST'
      | 'IDEMPOTENCY_CONFLICT'
      | 'ITEM_NOT_FOUND'
      | 'QUEUE_LIMIT'
      | 'CONTENT_LIMIT'
      | 'CLAIM_CAS_MISMATCH'
      | 'EPOCH_EXHAUSTED'
      | 'VERSION_EXHAUSTED',
    message: string,
  ) {
    super(message)
    this.name = 'PromptQueueStoreError'
  }
}

interface HeadRow {
  owner_user_id: string
  session_key: string
  client_session_id: string
  agent_id: string
  version: string
  active_turn_id: string | null
  active_item_id: string | null
  active_trace_id: string | null
  active_started_at: Date | null
  steer_delivery: 'native' | 'fork-native' | 'turn-boundary' | null
  coordinator_epoch: string
  lease_owner: string | null
  lease_until: Date | null
  current_claim_token: string | null
}

interface ItemRow {
  item_id: string
  client_message_id: string
  position: number | null
  state: 'queued' | 'dispatch_claimed' | 'active' | 'steer_pending' | 'delivery_unknown' | 'blocked'
  display_text: string
  content_json: Record<string, unknown>
  content_sha256: string
  content_bytes: string
  requested_execution: Record<string, unknown>
  delivery_mode: string | null
  expected_turn_id: string | null
  delivery_idempotency_key: string | null
  delivery_token: string | null
  engine_receipt: Record<string, unknown> | null
  blocked_reason_code: string | null
  created_at: Date
  updated_at: Date
}

interface MutationRow {
  idempotency_key: string
  operation: PromptQueueMutationOperation
  request_sha256: string
  outcome: Exclude<PromptQueueMutationOutcome, 'duplicate'>
  applied_version: string | null
  result_code: string | null
  delivery_token: string | null
}

interface MutationProjection {
  idempotencyKey: string
  operation: PromptQueueMutationOperation
  outcome: PromptQueueMutationOutcome
  appliedVersion?: string
  code?: string
}

interface PreparedContent {
  content: Record<string, unknown>
  canonical: string
  hash: string
  bytes: bigint
  displayText: string
  attachments: PromptQueueAttachmentRef[]
}

type Db = Pick<PoolClient, 'query'>

export class PgPromptQueueStore {
  constructor(private readonly pool: Pool) {}

  async getSnapshot(owner: PromptQueueOwner): Promise<PromptQueueSnapshot> {
    assertOwner(owner)
    return this.withReadTransaction((client) => readSnapshot(client, owner))
  }

  async getDetail(owner: PromptQueueOwner, itemId: string): Promise<PromptQueueDetail> {
    assertOwner(owner)
    assertBoundedId('itemId', itemId, 128, ITEM_ID_RE)
    return this.withReadTransaction(async (client) => {
      const head = await client.query<HeadRow>(
        `SELECT owner_user_id::text,session_key,client_session_id,agent_id,version::text,
                active_turn_id,active_item_id,active_trace_id,active_started_at,steer_delivery,
                coordinator_epoch::text,lease_owner,lease_until,current_claim_token
           FROM prompt_queue_heads WHERE owner_user_id=$1 AND session_key=$2`,
        [owner.userId, owner.sessionKey],
      )
      assertHeadOwner(head.rows[0], owner)
      const row = await client.query<ItemRow>(
        `SELECT item_id,client_message_id,position,state,display_text,content_json,
                content_sha256,content_bytes::text,requested_execution,blocked_reason_code,
                delivery_mode,expected_turn_id,delivery_idempotency_key,delivery_token,engine_receipt,
                created_at,updated_at
           FROM prompt_queue_items
          WHERE owner_user_id=$1 AND session_key=$2 AND item_id=$3`,
        [owner.userId, owner.sessionKey, itemId],
      )
      if (!row.rows[0]) throw new PromptQueueStoreError('ITEM_NOT_FOUND', 'queue item not found')
      const item = row.rows[0]
      const attachmentRows = await client.query<{
        ordinal: number
        kind: string
        url: string
        mime_type: string | null
        filename: string | null
        hidden: boolean
        content_sha256: string | null
        size_bytes: string | null
      }>(
        `SELECT ordinal,kind,url,mime_type,filename,hidden,content_sha256,size_bytes::text
           FROM prompt_queue_item_attachments
          WHERE owner_user_id=$1 AND session_key=$2 AND item_id=$3 ORDER BY ordinal`,
        [owner.userId, owner.sessionKey, itemId],
      )
      return {
        owner: ownerProjection(owner),
        snapshotVersion: head.rows[0]!.version,
        itemId: item.item_id,
        clientMessageId: item.client_message_id,
        state: item.state,
        content: item.content_json,
        contentHash: item.content_sha256,
        contentBytes: item.content_bytes,
        attachments: attachmentRows.rows.map((attachment) => ({
          ordinal: attachment.ordinal,
          kind: attachment.kind,
          url: attachment.url,
          ...(attachment.mime_type ? { mimeType: attachment.mime_type } : {}),
          ...(attachment.filename ? { filename: attachment.filename } : {}),
          ...(attachment.hidden ? { hidden: true } : {}),
          ...(attachment.content_sha256 ? { contentSha256: attachment.content_sha256 } : {}),
          ...(attachment.size_bytes ? { sizeBytes: attachment.size_bytes } : {}),
        })),
        requestedExecution: item.requested_execution,
        ...(item.delivery_mode || item.expected_turn_id || item.delivery_idempotency_key
          ? {
              deliveryIntent: {
                ...(item.delivery_mode ? { mode: item.delivery_mode } : {}),
                ...(item.expected_turn_id ? { expectedTurnId: item.expected_turn_id } : {}),
                ...(item.delivery_idempotency_key
                  ? { idempotencyKey: item.delivery_idempotency_key }
                  : {}),
              },
            }
          : {}),
        ...(item.delivery_token ? { deliveryToken: item.delivery_token } : {}),
        ...(item.engine_receipt ? { engineReceipt: item.engine_receipt } : {}),
        ...(item.blocked_reason_code ? { blockedReasonCode: item.blocked_reason_code } : {}),
        createdAt: item.created_at.getTime(),
        updatedAt: item.updated_at.getTime(),
      }
    })
  }

  async mutate(
    owner: PromptQueueOwner,
    frame: PromptQueueMutationFrame,
  ): Promise<PromptQueueMutationResult> {
    assertOwner(owner)
    assertFrameOwner(frame, owner)
    const operation = operationOf(frame)
    const requestHash = sha256(stableStringify({ operation, frame }))
    const idempotencyKey = frame.idempotencyKey
    assertBoundedId('idempotencyKey', idempotencyKey, 128)

    return this.withTransaction(async (client) => {
      let head = await lockHead(client, owner)
      const replay = await readMutation(client, owner, idempotencyKey)
      if (replay) {
        if (replay.request_sha256 !== requestHash) {
          throw new PromptQueueStoreError(
            'IDEMPOTENCY_CONFLICT',
            'idempotency key was already used for a different request',
          )
        }
        const mutation: MutationProjection = {
          idempotencyKey,
          operation: replay.operation,
          outcome: 'duplicate',
          ...(replay.applied_version ? { appliedVersion: replay.applied_version } : {}),
          ...(replay.result_code ? { code: replay.result_code } : {}),
        }
        return {
          snapshot: await readSnapshot(client, owner, mutation),
          ...(replay.delivery_token ? { deliveryToken: replay.delivery_token } : {}),
        }
      }

      let outcome: Exclude<PromptQueueMutationOutcome, 'duplicate'> = 'applied'
      let code: string | undefined
      let deliveryToken: string | undefined
      let changed = false
      const expectedVersion = 'expectedVersion' in frame ? frame.expectedVersion : undefined

      if (expectedVersion !== undefined && expectedVersion !== head.version) {
        outcome = 'version_conflict'
        code = 'VERSION_CONFLICT'
      } else {
        switch (operation) {
          case 'enqueue': {
            if (frame.type !== 'inbound.prompt_queue.enqueue')
              throw new Error('operation/type mismatch')
            const prepared = prepareContent(frame.content as Record<string, unknown>)
            assertBoundedId('itemId', frame.itemId, 128, ITEM_ID_RE)
            assertBoundedId('clientMessageId', frame.clientMessageId, 128, ITEM_ID_RE)
            if (frame.itemId !== frame.clientMessageId) {
              outcome = 'rejected'
              code = 'ITEM_MESSAGE_ID_MISMATCH'
              break
            }
            const existing = await client.query(
              `SELECT 1 FROM prompt_queue_items
                WHERE owner_user_id=$1 AND session_key=$2 AND item_id=$3`,
              [owner.userId, owner.sessionKey, frame.itemId],
            )
            if (existing.rowCount) {
              outcome = 'rejected'
              code = 'ITEM_ALREADY_EXISTS'
              break
            }
            const totals = await client.query<{
              count: string
              bytes: string
              max_position: number | null
            }>(
              `SELECT COUNT(*)::text AS count,COALESCE(SUM(content_bytes),0)::text AS bytes,
                      MAX(position) AS max_position
                 FROM prompt_queue_items WHERE owner_user_id=$1 AND session_key=$2`,
              [owner.userId, owner.sessionKey],
            )
            const total = totals.rows[0]!
            if (Number(total.count) >= MAX_QUEUE_ITEMS) {
              throw new PromptQueueStoreError(
                'QUEUE_LIMIT',
                `queue is limited to ${MAX_QUEUE_ITEMS} items`,
              )
            }
            if (
              BigInt(total.bytes) + prepared.bytes >
              BigInt(PROMPT_QUEUE_MAX_TOTAL_CONTENT_BYTES)
            ) {
              throw new PromptQueueStoreError('CONTENT_LIMIT', 'queue content budget exceeded')
            }
            const requestedExecution = {
              ...frame.requestedExecution,
              agentId: frame.agentId,
            }
            validateRequestedExecution(requestedExecution)
            await client.query(
              `INSERT INTO prompt_queue_items
                 (owner_user_id,session_key,item_id,client_message_id,position,state,display_text,
                  content_json,content_sha256,content_bytes,requested_execution)
               VALUES ($1,$2,$3,$4,$5,'queued',$6,$7::jsonb,$8,$9,$10::jsonb)`,
              [
                owner.userId,
                owner.sessionKey,
                frame.itemId,
                frame.clientMessageId,
                (total.max_position ?? 0) + 1,
                prepared.displayText,
                prepared.canonical,
                prepared.hash,
                prepared.bytes.toString(),
                JSON.stringify(requestedExecution),
              ],
            )
            await replaceAttachments(client, owner, frame.itemId, prepared.attachments)
            changed = true
            break
          }
          case 'edit': {
            if (frame.type !== 'inbound.prompt_queue.edit')
              throw new Error('operation/type mismatch')
            const item = await lockItem(client, owner, frame.itemId)
            if (!item) {
              outcome = 'rejected'
              code = 'ITEM_NOT_FOUND'
              break
            }
            if (item.state !== 'queued' && item.state !== 'blocked') {
              outcome = 'rejected'
              code = 'ITEM_ALREADY_DELIVERING'
              break
            }
            const prepared = prepareContent(frame.content as Record<string, unknown>)
            const totals = await client.query<{ bytes: string }>(
              `SELECT COALESCE(SUM(content_bytes),0)::text AS bytes FROM prompt_queue_items
                WHERE owner_user_id=$1 AND session_key=$2 AND item_id<>$3`,
              [owner.userId, owner.sessionKey, frame.itemId],
            )
            if (
              BigInt(totals.rows[0]!.bytes) + prepared.bytes >
              BigInt(PROMPT_QUEUE_MAX_TOTAL_CONTENT_BYTES)
            ) {
              throw new PromptQueueStoreError('CONTENT_LIMIT', 'queue content budget exceeded')
            }
            await client.query(
              `UPDATE prompt_queue_items
                  SET content_json=$4::jsonb,content_sha256=$5,content_bytes=$6,display_text=$7,
                      state='queued',blocked_reason_code=NULL,blocked_at=NULL,updated_at=NOW()
                WHERE owner_user_id=$1 AND session_key=$2 AND item_id=$3`,
              [
                owner.userId,
                owner.sessionKey,
                frame.itemId,
                prepared.canonical,
                prepared.hash,
                prepared.bytes.toString(),
                prepared.displayText,
              ],
            )
            await replaceAttachments(client, owner, frame.itemId, prepared.attachments)
            changed = true
            break
          }
          case 'delete': {
            if (frame.type !== 'inbound.prompt_queue.delete')
              throw new Error('operation/type mismatch')
            const item = await lockItem(client, owner, frame.itemId)
            if (!item) {
              outcome = 'rejected'
              code = 'ITEM_NOT_FOUND'
              break
            }
            if (item.state !== 'queued' && item.state !== 'blocked') {
              outcome = 'rejected'
              code = 'ITEM_ALREADY_DELIVERING'
              break
            }
            const oldPosition = item.position!
            await client.query(
              `DELETE FROM prompt_queue_items
                WHERE owner_user_id=$1 AND session_key=$2 AND item_id=$3`,
              [owner.userId, owner.sessionKey, frame.itemId],
            )
            await client.query(
              `UPDATE prompt_queue_items SET position=position-1,updated_at=NOW()
                WHERE owner_user_id=$1 AND session_key=$2 AND position>$3`,
              [owner.userId, owner.sessionKey, oldPosition],
            )
            changed = true
            break
          }
          case 'reorder': {
            if (frame.type !== 'inbound.prompt_queue.reorder')
              throw new Error('operation/type mismatch')
            const waiting = await client.query<{ item_id: string }>(
              `SELECT item_id FROM prompt_queue_items
                WHERE owner_user_id=$1 AND session_key=$2 AND state IN ('queued','blocked')
                ORDER BY position FOR UPDATE`,
              [owner.userId, owner.sessionKey],
            )
            const current = waiting.rows.map((row) => row.item_id)
            if (!sameSet(current, frame.orderedItemIds)) {
              outcome = 'rejected'
              code = 'REORDER_SET_MISMATCH'
              break
            }
            for (const [index, itemId] of frame.orderedItemIds.entries()) {
              await client.query(
                `UPDATE prompt_queue_items SET position=$4,updated_at=NOW()
                  WHERE owner_user_id=$1 AND session_key=$2 AND item_id=$3`,
                [owner.userId, owner.sessionKey, itemId, index + 1],
              )
            }
            changed = true
            break
          }
          case 'interject': {
            if (frame.type !== 'inbound.prompt_queue.interject')
              throw new Error('operation/type mismatch')
            const item = await lockItem(client, owner, frame.itemId)
            if (!item) {
              outcome = 'rejected'
              code = 'ITEM_NOT_FOUND'
              break
            }
            if (item.state !== 'queued') {
              outcome = 'rejected'
              code = item.state === 'blocked' ? 'ITEM_BLOCKED' : 'ITEM_ALREADY_DELIVERING'
              break
            }
            const turnMatches = head.active_turn_id === frame.expectedTurnId
            const delivery = head.steer_delivery
            if (!turnMatches) {
              await moveToHead(client, owner, frame.itemId, item.position!)
              outcome = 'turn_changed'
              code = 'TURN_CHANGED'
            } else if (
              frame.mode === 'insert_current' &&
              (delivery === 'native' || delivery === 'fork-native')
            ) {
              deliveryToken = randomToken()
              await client.query(
                `UPDATE prompt_queue_items
                    SET position=NULL,state='steer_pending',delivery_mode=$4,expected_turn_id=$5,
                        delivery_idempotency_key=$6,delivery_token=$7,updated_at=NOW()
                  WHERE owner_user_id=$1 AND session_key=$2 AND item_id=$3`,
                [
                  owner.userId,
                  owner.sessionKey,
                  frame.itemId,
                  frame.mode,
                  frame.expectedTurnId,
                  frame.idempotencyKey,
                  deliveryToken,
                ],
              )
              await closePositionGap(client, owner, item.position!)
              outcome = 'delivery_pending'
            } else {
              await moveToHead(client, owner, frame.itemId, item.position!)
              await client.query(
                `UPDATE prompt_queue_items
                    SET delivery_mode=$4,expected_turn_id=$5,delivery_idempotency_key=$6,updated_at=NOW()
                  WHERE owner_user_id=$1 AND session_key=$2 AND item_id=$3`,
                [
                  owner.userId,
                  owner.sessionKey,
                  frame.itemId,
                  frame.mode,
                  frame.expectedTurnId,
                  frame.idempotencyKey,
                ],
              )
              outcome = 'delivery_pending'
            }
            changed = true
            break
          }
        }
      }

      let appliedVersion: string | undefined
      if (changed) {
        head = await bumpVersion(client, owner, head)
        appliedVersion = head.version
      }
      await insertMutation(client, owner, {
        idempotencyKey,
        operation,
        requestHash,
        itemId: itemIdOf(frame),
        outcome,
        appliedVersion,
        code,
        deliveryToken,
      })
      const mutation: MutationProjection = {
        idempotencyKey,
        operation,
        outcome,
        ...(appliedVersion ? { appliedVersion } : {}),
        ...(code ? { code } : {}),
      }
      return {
        snapshot: await readSnapshot(client, owner, mutation),
        ...(deliveryToken ? { deliveryToken } : {}),
      }
    })
  }

  async claim(
    owner: PromptQueueOwner,
    containerId: number,
    request: PromptQueueClaimRequest,
  ): Promise<PromptQueueClaimResult> {
    assertOwner(owner)
    if (!Number.isSafeInteger(containerId) || containerId <= 0) {
      throw new PromptQueueStoreError('INVALID_REQUEST', 'invalid verified container id')
    }
    const leaseOwner = `container:${containerId}`
    return this.withTransaction(async (client) => {
      let head = await lockHead(client, owner)

      if (request.action === 'acquire') {
        if (request.expectedVersion !== head.version) {
          return {
            snapshot: await readSnapshot(client, owner),
            outcome: 'rejected',
            code: 'VERSION_CONFLICT',
          }
        }
        if (head.active_turn_id) {
          return {
            snapshot: await readSnapshot(client, owner),
            outcome: 'rejected',
            code: 'ACTIVE_TURN',
          }
        }
        const current = await client.query<{
          item_id: string
          claim_token: string
          claim_until: Date
        }>(
          `SELECT item_id,claim_token,claim_until FROM prompt_queue_items
            WHERE owner_user_id=$1 AND session_key=$2 AND state='dispatch_claimed' FOR UPDATE`,
          [owner.userId, owner.sessionKey],
        )
        const claimed = current.rows[0]
        if (claimed) {
          const lease = await client.query<{ live: boolean }>(
            `SELECT ($1::timestamptz > NOW()) AS live`,
            [head.lease_until],
          )
          const live = lease.rows[0]?.live === true
          if (
            head.lease_owner === leaseOwner &&
            live &&
            head.current_claim_token === claimed.claim_token
          ) {
            const renewed = await client.query<{ lease_until: Date }>(
              `UPDATE prompt_queue_heads
                  SET lease_until=NOW()+make_interval(secs=>$3),updated_at=NOW()
                WHERE owner_user_id=$1 AND session_key=$2 RETURNING lease_until`,
              [owner.userId, owner.sessionKey, CLAIM_TTL_SECONDS],
            )
            await client.query(
              `UPDATE prompt_queue_items SET claim_until=$4,updated_at=NOW()
                WHERE owner_user_id=$1 AND session_key=$2 AND item_id=$3`,
              [owner.userId, owner.sessionKey, claimed.item_id, renewed.rows[0]!.lease_until],
            )
            return {
              snapshot: await readSnapshot(client, owner),
              outcome: 'renewed',
              claim: {
                itemId: claimed.item_id,
                epoch: head.coordinator_epoch,
                claimToken: claimed.claim_token,
                leaseUntil: renewed.rows[0]!.lease_until.getTime(),
                renewed: true,
              },
            }
          }
          if (live) {
            return {
              snapshot: await readSnapshot(client, owner),
              outcome: 'rejected',
              code: 'CLAIM_HELD',
            }
          }
          const epoch = nextEpoch(head.coordinator_epoch)
          const token = randomToken()
          const renewed = await client.query<{ lease_until: Date }>(
            `UPDATE prompt_queue_heads
                SET coordinator_epoch=$3,lease_owner=$4,current_claim_token=$5,
                    lease_until=NOW()+make_interval(secs=>$6),updated_at=NOW()
              WHERE owner_user_id=$1 AND session_key=$2 RETURNING lease_until`,
            [owner.userId, owner.sessionKey, epoch, leaseOwner, token, CLAIM_TTL_SECONDS],
          )
          await client.query(
            `UPDATE prompt_queue_items SET claim_token=$4,claim_until=$5,updated_at=NOW()
              WHERE owner_user_id=$1 AND session_key=$2 AND item_id=$3`,
            [owner.userId, owner.sessionKey, claimed.item_id, token, renewed.rows[0]!.lease_until],
          )
          head = await bumpVersion(client, owner, { ...head, coordinator_epoch: epoch })
          return {
            snapshot: await readSnapshot(client, owner),
            outcome: 'acquired',
            claim: {
              itemId: claimed.item_id,
              epoch,
              claimToken: token,
              leaseUntil: renewed.rows[0]!.lease_until.getTime(),
              renewed: false,
            },
          }
        }

        const next = await client.query<{ item_id: string; position: number }>(
          `SELECT item_id,position FROM prompt_queue_items
            WHERE owner_user_id=$1 AND session_key=$2 AND state='queued' AND position=1 FOR UPDATE`,
          [owner.userId, owner.sessionKey],
        )
        const item = next.rows[0]
        if (!item) return { snapshot: await readSnapshot(client, owner), outcome: 'empty' }

        const epoch =
          head.lease_owner === leaseOwner
            ? head.coordinator_epoch
            : nextEpoch(head.coordinator_epoch)
        const token = randomToken()
        const lease = await client.query<{ lease_until: Date }>(
          `UPDATE prompt_queue_heads
              SET coordinator_epoch=$3,lease_owner=$4,current_claim_token=$5,
                  lease_until=NOW()+make_interval(secs=>$6),updated_at=NOW()
            WHERE owner_user_id=$1 AND session_key=$2 RETURNING lease_until`,
          [owner.userId, owner.sessionKey, epoch, leaseOwner, token, CLAIM_TTL_SECONDS],
        )
        await client.query(
          `UPDATE prompt_queue_items
              SET position=NULL,state='dispatch_claimed',claim_token=$4,claim_until=$5,
                  blocked_reason_code=NULL,blocked_at=NULL,updated_at=NOW()
            WHERE owner_user_id=$1 AND session_key=$2 AND item_id=$3`,
          [owner.userId, owner.sessionKey, item.item_id, token, lease.rows[0]!.lease_until],
        )
        await closePositionGap(client, owner, 1)
        head = await bumpVersion(client, owner, { ...head, coordinator_epoch: epoch })
        return {
          snapshot: await readSnapshot(client, owner),
          outcome: 'acquired',
          claim: {
            itemId: item.item_id,
            epoch,
            claimToken: token,
            leaseUntil: lease.rows[0]!.lease_until.getTime(),
            renewed: false,
          },
        }
      }

      if (request.action === 'complete' || request.action === 'interrupt_ack') {
        if (head.active_turn_id !== request.turnId || !head.active_item_id) {
          return {
            snapshot: await readSnapshot(client, owner),
            outcome: 'rejected',
            code: 'TURN_CHANGED',
          }
        }
        if (request.action === 'interrupt_ack') {
          await client.query(
            `UPDATE prompt_queue_items
                SET engine_receipt=COALESCE(engine_receipt,'{}'::jsonb)
                    || jsonb_build_object('interruptAcknowledgedAt',($4::bigint)),updated_at=NOW()
              WHERE owner_user_id=$1 AND session_key=$2 AND item_id=$3 AND state='active'`,
            [owner.userId, owner.sessionKey, head.active_item_id, Date.now().toString()],
          )
          head = await bumpVersion(client, owner, head)
          return {
            snapshot: await readSnapshot(client, owner),
            outcome: 'interrupt_acknowledged',
          }
        }

        const active = await client.query<{ turn_index: string | null }>(
          `SELECT engine_receipt->>'turnIndex' AS turn_index
             FROM prompt_queue_items
            WHERE owner_user_id=$1 AND session_key=$2 AND item_id=$3 AND state='active' FOR UPDATE`,
          [owner.userId, owner.sessionKey, head.active_item_id],
        )
        if (active.rows[0]?.turn_index !== String(request.turnIndex)) {
          return {
            snapshot: await readSnapshot(client, owner),
            outcome: 'rejected',
            code: 'ENGINE_RECEIPT_MISMATCH',
          }
        }
        const anchor = await client.query(
          `SELECT 1 FROM server_authored_turn_anchor_map
            WHERE user_id=$1 AND turn_key=$2 AND session_id=$3`,
          [`c:${owner.userId.toString()}`, request.turnId, owner.clientSessionId],
        )
        if (!anchor.rowCount) {
          return {
            snapshot: await readSnapshot(client, owner),
            outcome: 'rejected',
            code: 'TAPE_NOT_ACKED',
          }
        }
        await client.query(
          `DELETE FROM prompt_queue_items
            WHERE owner_user_id=$1 AND session_key=$2 AND item_id=$3 AND state='active'`,
          [owner.userId, owner.sessionKey, head.active_item_id],
        )
        await client.query(
          `UPDATE prompt_queue_heads
              SET active_turn_id=NULL,active_item_id=NULL,active_trace_id=NULL,
                  active_started_at=NULL,steer_delivery=NULL,updated_at=NOW()
            WHERE owner_user_id=$1 AND session_key=$2`,
          [owner.userId, owner.sessionKey],
        )
        head = await bumpVersion(client, owner, {
          ...head,
          active_turn_id: null,
          active_item_id: null,
          active_trace_id: null,
          active_started_at: null,
          steer_delivery: null,
        })
        return { snapshot: await readSnapshot(client, owner), outcome: 'completed' }
      }

      assertClaimCas(head, leaseOwner, request.epoch, request.claimToken)
      const item = await client.query<{
        item_id: string
        client_message_id: string
        content_json: Record<string, unknown>
        created_at: Date
      }>(
        `SELECT item_id,client_message_id,content_json,created_at FROM prompt_queue_items
          WHERE owner_user_id=$1 AND session_key=$2 AND state='dispatch_claimed'
            AND claim_token=$3 AND claim_until>NOW() FOR UPDATE`,
        [owner.userId, owner.sessionKey, request.claimToken],
      )
      const claimed = item.rows[0]
      if (!claimed)
        throw new PromptQueueStoreError('CLAIM_CAS_MISMATCH', 'claim is absent or expired')

      if (request.action === 'release') {
        await client.query(
          `UPDATE prompt_queue_items
              SET state=$4::varchar,position=1,claim_token=NULL,claim_until=NULL,
                  blocked_reason_code=$5::varchar,
                  blocked_at=CASE WHEN $4::varchar='blocked' THEN NOW() ELSE NULL END,updated_at=NOW()
            WHERE owner_user_id=$1 AND session_key=$2 AND item_id=$3`,
          [
            owner.userId,
            owner.sessionKey,
            claimed.item_id,
            request.disposition === 'retryable' ? 'queued' : 'blocked',
            request.disposition === 'retryable' ? null : normalizedReason(request.reasonCode),
          ],
        )
        await client.query(
          `UPDATE prompt_queue_items SET position=position+1,updated_at=NOW()
            WHERE owner_user_id=$1 AND session_key=$2 AND item_id<>$3 AND position IS NOT NULL`,
          [owner.userId, owner.sessionKey, claimed.item_id],
        )
        await clearHeadClaim(client, owner)
        head = await bumpVersion(client, owner, head)
        return { snapshot: await readSnapshot(client, owner), outcome: 'released' }
      }

      const content = claimed.content_json
      const rawMedia = Array.isArray(content.media) ? content.media : []
      const persistedMedia = rawMedia.filter((entry) => !isRecord(entry) || entry.hidden !== true)
      const materialized = await appendPromptQueueUserMessageInTransaction(
        client,
        owner.clientSessionId,
        `c:${owner.userId.toString()}`,
        {
          id: claimed.client_message_id,
          role: 'user',
          text: typeof content.text === 'string' ? content.text : '',
          ts: claimed.created_at.getTime(),
          ...(persistedMedia.length > 0 ? { _media: persistedMedia } : {}),
        },
      )
      if (!materialized.applied) {
        // This is an infrastructure/transaction failure, not a caller contract
        // error. Let the HTTP boundary return 500 so the coordinator retries the
        // same CAS claim; the surrounding transaction rolls every mutation back.
        throw new Error(`queue user row materialization failed: ${materialized.reason}`)
      }

      await client.query(
        `UPDATE prompt_queue_items
            SET state='active',claim_token=NULL,claim_until=NULL,
                blocked_reason_code=NULL,blocked_at=NULL,
                engine_receipt=jsonb_build_object('turnIndex',$4::integer),updated_at=NOW()
          WHERE owner_user_id=$1 AND session_key=$2 AND item_id=$3`,
        [owner.userId, owner.sessionKey, claimed.item_id, request.turnIndex],
      )
      await client.query(
        `UPDATE prompt_queue_heads
            SET active_turn_id=$3,active_item_id=$4,active_trace_id=$5,
                active_started_at=NOW(),steer_delivery=$6,current_claim_token=NULL,
                lease_until=NULL,updated_at=NOW()
          WHERE owner_user_id=$1 AND session_key=$2`,
        [
          owner.userId,
          owner.sessionKey,
          request.turnId,
          claimed.item_id,
          request.traceId ?? null,
          request.steerDelivery,
        ],
      )
      head = await bumpVersion(client, owner, {
        ...head,
        active_turn_id: request.turnId,
        active_item_id: claimed.item_id,
        active_trace_id: request.traceId ?? null,
        steer_delivery: request.steerDelivery,
      })
      return { snapshot: await readSnapshot(client, owner), outcome: 'activated' }
    })
  }

  private async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await fn(client)
      await client.query('COMMIT')
      return result
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch {
        /* preserve original error */
      }
      throw err
    } finally {
      client.release()
    }
  }

  private async withReadTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const result = await fn(client)
      await client.query('COMMIT')
      return result
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch {
        /* preserve original error */
      }
      throw err
    } finally {
      client.release()
    }
  }
}

async function lockHead(client: Db, owner: PromptQueueOwner): Promise<HeadRow> {
  await client.query(
    `INSERT INTO prompt_queue_heads
       (owner_user_id,session_key,client_session_id,agent_id)
     VALUES ($1,$2,$3,$4) ON CONFLICT (owner_user_id,session_key) DO NOTHING`,
    [owner.userId, owner.sessionKey, owner.clientSessionId, owner.agentId],
  )
  const result = await client.query<HeadRow>(
    `SELECT owner_user_id::text,session_key,client_session_id,agent_id,version::text,
            active_turn_id,active_item_id,active_trace_id,active_started_at,steer_delivery,
            coordinator_epoch::text,lease_owner,lease_until,current_claim_token
       FROM prompt_queue_heads WHERE owner_user_id=$1 AND session_key=$2 FOR UPDATE`,
    [owner.userId, owner.sessionKey],
  )
  const head = result.rows[0]
  assertHeadOwner(head, owner)
  return head!
}

function assertHeadOwner(head: HeadRow | undefined, owner: PromptQueueOwner): void {
  if (!head) throw new PromptQueueStoreError('INVALID_OWNER', 'queue owner does not exist')
  if (head.client_session_id !== owner.clientSessionId || head.agent_id !== owner.agentId) {
    throw new PromptQueueStoreError('INVALID_OWNER', 'queue owner metadata mismatch')
  }
}

async function bumpVersion(client: Db, owner: PromptQueueOwner, head: HeadRow): Promise<HeadRow> {
  const current = BigInt(head.version)
  if (current >= PG_BIGINT_MAX)
    throw new PromptQueueStoreError('VERSION_EXHAUSTED', 'queue version exhausted')
  const version = (current + 1n).toString()
  await client.query(
    `UPDATE prompt_queue_heads SET version=$3,updated_at=NOW()
      WHERE owner_user_id=$1 AND session_key=$2`,
    [owner.userId, owner.sessionKey, version],
  )
  return { ...head, version }
}

async function readMutation(
  client: Db,
  owner: PromptQueueOwner,
  key: string,
): Promise<MutationRow | undefined> {
  const result = await client.query<MutationRow>(
    `SELECT idempotency_key,operation,request_sha256,outcome,applied_version::text,
            result_code,delivery_token
       FROM prompt_queue_mutations
      WHERE owner_user_id=$1 AND session_key=$2 AND idempotency_key=$3`,
    [owner.userId, owner.sessionKey, key],
  )
  return result.rows[0]
}

async function insertMutation(
  client: Db,
  owner: PromptQueueOwner,
  args: {
    idempotencyKey: string
    operation: PromptQueueMutationOperation
    requestHash: string
    itemId?: string
    outcome: Exclude<PromptQueueMutationOutcome, 'duplicate'>
    appliedVersion?: string
    code?: string
    deliveryToken?: string
  },
): Promise<void> {
  await client.query(
    `INSERT INTO prompt_queue_mutations
       (owner_user_id,session_key,idempotency_key,operation,request_sha256,item_id,
        outcome,applied_version,result_code,delivery_token)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      owner.userId,
      owner.sessionKey,
      args.idempotencyKey,
      args.operation,
      args.requestHash,
      args.itemId ?? null,
      args.outcome,
      args.appliedVersion ?? null,
      args.code ?? null,
      args.deliveryToken ?? null,
    ],
  )
}

async function lockItem(
  client: Db,
  owner: PromptQueueOwner,
  itemId: string,
): Promise<ItemRow | undefined> {
  assertBoundedId('itemId', itemId, 128, ITEM_ID_RE)
  const result = await client.query<ItemRow>(
    `SELECT item_id,client_message_id,position,state,display_text,content_json,
            content_sha256,content_bytes::text,requested_execution,blocked_reason_code,
            delivery_mode,expected_turn_id,delivery_idempotency_key,delivery_token,engine_receipt,
            created_at,updated_at
       FROM prompt_queue_items
      WHERE owner_user_id=$1 AND session_key=$2 AND item_id=$3 FOR UPDATE`,
    [owner.userId, owner.sessionKey, itemId],
  )
  return result.rows[0]
}

async function readSnapshot(
  client: Db,
  owner: PromptQueueOwner,
  mutation?: MutationProjection,
): Promise<PromptQueueSnapshot> {
  const heads = await client.query<HeadRow>(
    `SELECT owner_user_id::text,session_key,client_session_id,agent_id,version::text,
            active_turn_id,active_item_id,active_trace_id,active_started_at,steer_delivery,
            coordinator_epoch::text,lease_owner,lease_until,current_claim_token
       FROM prompt_queue_heads WHERE owner_user_id=$1 AND session_key=$2`,
    [owner.userId, owner.sessionKey],
  )
  const head = heads.rows[0]
  if (!head) {
    return {
      type: 'outbound.prompt_queue.snapshot',
      owner: ownerProjection(owner),
      version: '0',
      activeTurn: null,
      items: [],
      ...(mutation ? { mutation } : {}),
      serverTs: Date.now(),
    }
  }
  assertHeadOwner(head, owner)
  const rows = await client.query<ItemRow>(
    `SELECT item_id,client_message_id,position,state,display_text,content_json,
            content_sha256,content_bytes::text,requested_execution,blocked_reason_code,
            delivery_mode,expected_turn_id,delivery_idempotency_key,delivery_token,engine_receipt,
            created_at,updated_at
       FROM prompt_queue_items
      WHERE owner_user_id=$1 AND session_key=$2
        AND state IN ('queued','steer_pending','delivery_unknown','blocked')
      ORDER BY position ASC NULLS LAST,created_at,item_id`,
    [owner.userId, owner.sessionKey],
  )
  const attachmentRows = await client.query<{
    item_id: string
    ordinal: number
    kind: string
    url: string
    mime_type: string | null
    filename: string | null
    hidden: boolean
  }>(
    `SELECT item_id,ordinal,kind,url,mime_type,filename,hidden
       FROM prompt_queue_item_attachments
      WHERE owner_user_id=$1 AND session_key=$2 ORDER BY item_id,ordinal`,
    [owner.userId, owner.sessionKey],
  )
  const byItem = new Map<string, PromptQueueAttachmentRef[]>()
  for (const row of attachmentRows.rows) {
    const ref: PromptQueueAttachmentRef = {
      ordinal: row.ordinal,
      kind: row.kind,
      url: row.url,
      ...(row.mime_type ? { mimeType: row.mime_type } : {}),
      ...(row.filename ? { filename: row.filename } : {}),
      ...(row.hidden ? { hidden: true } : {}),
    }
    const list = byItem.get(row.item_id) ?? []
    list.push(ref)
    byItem.set(row.item_id, list)
  }
  return {
    type: 'outbound.prompt_queue.snapshot',
    owner: ownerProjection(owner),
    version: head.version,
    activeTurn:
      head.active_turn_id && head.active_item_id && head.active_started_at && head.steer_delivery
        ? {
            id: head.active_turn_id,
            sourceItemId: head.active_item_id,
            ...(head.active_trace_id ? { traceId: head.active_trace_id } : {}),
            startedAt: head.active_started_at.getTime(),
            steerDelivery: head.steer_delivery,
          }
        : null,
    items: rows.rows.map((row) => ({
      id: row.item_id,
      clientMessageId: row.client_message_id,
      position: row.position,
      displayText: row.display_text,
      contentHash: row.content_sha256,
      contentBytes: row.content_bytes,
      attachmentRefs: byItem.get(row.item_id) ?? [],
      state: row.state as 'queued' | 'steer_pending' | 'delivery_unknown' | 'blocked',
      requestedExecution: row.requested_execution as {
        agentId: string
        model?: string
        effortLevel?: string | null
        teamMode?: boolean
      },
      createdAt: row.created_at.getTime(),
      updatedAt: row.updated_at.getTime(),
    })),
    ...(mutation ? { mutation } : {}),
    serverTs: Date.now(),
  }
}

function ownerProjection(owner: PromptQueueOwner): PromptQueueSnapshot['owner'] {
  return {
    userId: owner.userId.toString(),
    sessionKey: owner.sessionKey,
    clientSessionId: owner.clientSessionId,
    agentId: owner.agentId,
  }
}

function prepareContent(content: Record<string, unknown>): PreparedContent {
  if (!isRecord(content))
    throw new PromptQueueStoreError('INVALID_REQUEST', 'content must be an object')
  const media = content.media
  const attachments: PromptQueueAttachmentRef[] = []
  if (media !== undefined) {
    if (!Array.isArray(media) || media.length > MAX_ATTACHMENTS_PER_MESSAGE) {
      throw new PromptQueueStoreError('INVALID_REQUEST', 'invalid attachment count')
    }
    for (const [ordinal, raw] of media.entries()) {
      if (!isRecord(raw) || typeof raw.kind !== 'string' || !MEDIA_KINDS.has(raw.kind)) {
        throw new PromptQueueStoreError('INVALID_REQUEST', 'invalid attachment kind')
      }
      if (
        'base64' in raw ||
        'localSrc' in raw ||
        typeof raw.url !== 'string' ||
        !MEDIA_URL_RE.test(raw.url)
      ) {
        throw new PromptQueueStoreError(
          'INVALID_REQUEST',
          'attachments must use content-addressed URLs',
        )
      }
      assertOptionalString('mimeType', raw.mimeType, 128)
      assertOptionalString('filename', raw.filename, 512)
      attachments.push({
        ordinal,
        kind: raw.kind,
        url: raw.url,
        ...(typeof raw.mimeType === 'string' ? { mimeType: raw.mimeType } : {}),
        ...(typeof raw.filename === 'string' ? { filename: raw.filename } : {}),
        ...(raw.hidden === true ? { hidden: true } : {}),
      })
    }
  }
  const canonical = stableStringify(content)
  const bytes = BigInt(Buffer.byteLength(canonical, 'utf8'))
  if (bytes > BigInt(PROMPT_QUEUE_MAX_TOTAL_CONTENT_BYTES)) {
    throw new PromptQueueStoreError('CONTENT_LIMIT', 'item content budget exceeded')
  }
  const text = typeof content.text === 'string' ? content.text : ''
  return {
    content,
    canonical,
    hash: sha256(canonical),
    bytes,
    displayText: text.slice(0, 4096),
    attachments,
  }
}

async function replaceAttachments(
  client: Db,
  owner: PromptQueueOwner,
  itemId: string,
  attachments: PromptQueueAttachmentRef[],
): Promise<void> {
  await client.query(
    `DELETE FROM prompt_queue_item_attachments
      WHERE owner_user_id=$1 AND session_key=$2 AND item_id=$3`,
    [owner.userId, owner.sessionKey, itemId],
  )
  for (const ref of attachments) {
    await client.query(
      `INSERT INTO prompt_queue_item_attachments
         (owner_user_id,session_key,item_id,ordinal,kind,url,mime_type,filename,hidden,content_sha256)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        owner.userId,
        owner.sessionKey,
        itemId,
        ref.ordinal,
        ref.kind,
        ref.url,
        ref.mimeType ?? null,
        ref.filename ?? null,
        ref.hidden ?? false,
        /^\/api\/media\/([0-9a-f]{64})\./.exec(ref.url)?.[1] ?? null,
      ],
    )
  }
}

async function closePositionGap(
  client: Db,
  owner: PromptQueueOwner,
  oldPosition: number,
): Promise<void> {
  await client.query(
    `UPDATE prompt_queue_items SET position=position-1,updated_at=NOW()
      WHERE owner_user_id=$1 AND session_key=$2 AND position>$3`,
    [owner.userId, owner.sessionKey, oldPosition],
  )
}

async function moveToHead(
  client: Db,
  owner: PromptQueueOwner,
  itemId: string,
  oldPosition: number,
): Promise<void> {
  if (oldPosition === 1) return
  await client.query(
    `UPDATE prompt_queue_items SET position=position+1,updated_at=NOW()
      WHERE owner_user_id=$1 AND session_key=$2 AND position<$3`,
    [owner.userId, owner.sessionKey, oldPosition],
  )
  await client.query(
    `UPDATE prompt_queue_items SET position=1,updated_at=NOW()
      WHERE owner_user_id=$1 AND session_key=$2 AND item_id=$3`,
    [owner.userId, owner.sessionKey, itemId],
  )
}

async function clearHeadClaim(client: Db, owner: PromptQueueOwner): Promise<void> {
  await client.query(
    `UPDATE prompt_queue_heads SET current_claim_token=NULL,lease_until=NULL,updated_at=NOW()
      WHERE owner_user_id=$1 AND session_key=$2`,
    [owner.userId, owner.sessionKey],
  )
}

function assertClaimCas(head: HeadRow, leaseOwner: string, epoch: string, token: string): void {
  if (!/^(0|[1-9][0-9]*)$/.test(epoch) || !/^[0-9a-f]{64}$/.test(token)) {
    throw new PromptQueueStoreError('CLAIM_CAS_MISMATCH', 'malformed claim CAS')
  }
  if (
    head.lease_owner !== leaseOwner ||
    head.coordinator_epoch !== epoch ||
    head.current_claim_token !== token
  ) {
    throw new PromptQueueStoreError('CLAIM_CAS_MISMATCH', 'claim owner, epoch, or token mismatch')
  }
}

function nextEpoch(current: string): string {
  const value = BigInt(current)
  if (value >= PG_BIGINT_MAX)
    throw new PromptQueueStoreError('EPOCH_EXHAUSTED', 'coordinator epoch exhausted')
  return (value + 1n).toString()
}

function operationOf(frame: PromptQueueMutationFrame): PromptQueueMutationOperation {
  return frame.type.slice('inbound.prompt_queue.'.length) as PromptQueueMutationOperation
}

function itemIdOf(frame: PromptQueueMutationFrame): string | undefined {
  return 'itemId' in frame ? frame.itemId : undefined
}

function randomToken(): string {
  return randomBytes(32).toString('hex')
}

function normalizedReason(reason: string | undefined): string {
  const value = reason ?? 'USER_ACTION_REQUIRED'
  assertBoundedId('reasonCode', value, 128, /^[A-Za-z0-9_.:-]+$/)
  return value
}

function assertOwner(owner: PromptQueueOwner): void {
  if (owner.userId <= 0n || owner.peer.kind !== 'dm') {
    throw new PromptQueueStoreError('INVALID_OWNER', 'invalid queue owner')
  }
  assertBoundedId('sessionKey', owner.sessionKey, 512)
  assertBoundedId('clientSessionId', owner.clientSessionId, 128)
  assertBoundedId('agentId', owner.agentId, 64)
  assertBoundedId('peer.id', owner.peer.id, 256)
  const expected = `agent:${owner.agentId}:webchat:dm:${owner.peer.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`
  if (owner.sessionKey !== expected || owner.clientSessionId !== owner.peer.id) {
    throw new PromptQueueStoreError('INVALID_OWNER', 'non-canonical queue owner')
  }
}

function assertFrameOwner(frame: PromptQueueMutationFrame, owner: PromptQueueOwner): void {
  if (
    frame.agentId !== owner.agentId ||
    frame.peer.kind !== 'dm' ||
    frame.peer.id !== owner.peer.id ||
    (frame.type === 'inbound.prompt_queue.enqueue' && frame.channel !== 'webchat')
  ) {
    throw new PromptQueueStoreError('INVALID_OWNER', 'mutation owner metadata mismatch')
  }
}

function assertBoundedId(
  name: string,
  value: unknown,
  maxBytes: number,
  pattern?: RegExp,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > maxBytes ||
    (pattern && !pattern.test(value))
  ) {
    throw new PromptQueueStoreError('INVALID_REQUEST', `${name} is invalid`)
  }
}

function assertOptionalString(name: string, value: unknown, maxBytes: number): void {
  if (
    value !== undefined &&
    (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maxBytes)
  ) {
    throw new PromptQueueStoreError('INVALID_REQUEST', `${name} is invalid`)
  }
}

function validateRequestedExecution(value: Record<string, unknown>): void {
  if (value.agentId !== undefined) assertBoundedId('requestedExecution.agentId', value.agentId, 64)
  assertOptionalString('requestedExecution.model', value.model, 256)
  if (value.effortLevel !== null) {
    assertOptionalString('requestedExecution.effortLevel', value.effortLevel, 64)
  }
  if (value.teamMode !== undefined && typeof value.teamMode !== 'boolean') {
    throw new PromptQueueStoreError('INVALID_REQUEST', 'requestedExecution.teamMode is invalid')
  }
}

function stableStringify(value: unknown): string {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`
  }
  throw new PromptQueueStoreError('INVALID_REQUEST', 'content is not canonical JSON')
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function sameSet(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    new Set(left).size === left.length &&
    new Set(right).size === right.length &&
    left.every((item) => right.includes(item))
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
