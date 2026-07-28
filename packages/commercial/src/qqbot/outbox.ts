import type { Pool, PoolClient } from 'pg'

import {
  QqOutboundMediaTooLargeError,
  type QqOutboundMediaPart,
  type ResolveQqOutboundMediaPartFn,
  type ResolvedQqOutboundMedia,
} from './outboundMedia.js'

const QQ_TEXT_CHUNK_CHARS = 1800
const STALE_LOCK_MS = 5 * 60 * 1000
const POLL_MS = 2_000

export type QqOutboxOutcome = 'queued' | 'pending' | 'already_sent' | 'cancelled' | 'no_binding'

export function splitQqText(text: string, limit = QQ_TEXT_CHUNK_CHARS): string[] {
  if (text.length === 0) return []
  const points = Array.from(text)
  const chunks: string[] = []
  for (let offset = 0; offset < points.length; offset += limit) {
    chunks.push(points.slice(offset, offset + limit).join(''))
  }
  return chunks
}

export async function enqueueQqDelivery(
  pool: Pool,
  args: {
    deliveryId: string
    userId: bigint | string
    text: string
    kind: 'reply' | 'proactive'
    sessionId?: string
    now?: number
  },
): Promise<{ outcome: QqOutboxOutcome; outboxId?: number }> {
  const now = args.now ?? Date.now()
  const chunks = splitQqText(args.text)
  if (chunks.length === 0) return { outcome: 'cancelled' }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const binding = await client.query<{
      bot_openid: string
      binding_version: string
    }>(
      `SELECT bot_openid, binding_version
         FROM qq_bot_bindings
        WHERE user_id = $1
        FOR SHARE`,
      [String(args.userId)],
    )
    const active = binding.rows[0]
    if (!active) {
      await client.query('COMMIT')
      return { outcome: 'no_binding' }
    }
    await client.query(
      `INSERT INTO qq_outbox
         (delivery_id, user_id, binding_version, target_openid, session_id,
          kind, payload, next_attempt_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $8, $8)
       ON CONFLICT (user_id, delivery_id) DO NOTHING`,
      [
        args.deliveryId,
        String(args.userId),
        active.binding_version,
        active.bot_openid,
        args.sessionId ?? null,
        args.kind,
        JSON.stringify({ chunks }),
        now,
      ],
    )
    const row = await client.query<{ id: string; status: string }>(
      'SELECT id, status FROM qq_outbox WHERE user_id = $1 AND delivery_id = $2',
      [String(args.userId), args.deliveryId],
    )
    await client.query('COMMIT')
    const found = row.rows[0]!
    return {
      outcome:
        found.status === 'sent'
          ? 'already_sent'
          : found.status === 'cancelled'
            ? 'cancelled'
            : found.status === 'queued'
              ? 'queued'
              : 'pending',
      outboxId: Number(found.id),
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

export interface QqOutboxWorker {
  stop(): Promise<void>
  kick(): void
}

export function startQqOutboxWorker(args: {
  pool: Pool
  sendText: (openid: string, text: string) => Promise<void>
  sendMedia?: (openid: string, media: ResolvedQqOutboundMedia) => Promise<void>
  resolveMediaPart?: ResolveQqOutboundMediaPartFn
  onError?: (message: string, meta?: Record<string, unknown>) => void
  now?: () => number
  pollMs?: number
}): QqOutboxWorker {
  const now = args.now ?? Date.now
  const pollMs = args.pollMs ?? POLL_MS
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight: Promise<void> | null = null

  const schedule = (delay = pollMs) => {
    if (stopped || timer) return
    timer = setTimeout(() => {
      timer = null
      kick()
    }, delay)
    timer.unref?.()
  }

  const kick = () => {
    if (stopped || inFlight) return
    inFlight = drainAvailable(args, now, () => !stopped)
      .catch((err) => {
        args.onError?.('qq outbox drain failed', {
          errMessage: err instanceof Error ? err.message : String(err),
        })
      })
      .finally(() => {
        inFlight = null
        schedule()
      })
  }

  void releaseStaleQqOutbox(args.pool, now()).then(kick, (err) => {
    args.onError?.('qq outbox stale-release failed', {
      errMessage: err instanceof Error ? err.message : String(err),
    })
    schedule()
  })

  return {
    kick,
    async stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
      if (inFlight) await inFlight
    },
  }
}

async function drainAvailable(
  args: {
    pool: Pool
    sendText: (openid: string, text: string) => Promise<void>
    sendMedia?: (openid: string, media: ResolvedQqOutboundMedia) => Promise<void>
    resolveMediaPart?: ResolveQqOutboundMediaPartFn
    onError?: (message: string, meta?: Record<string, unknown>) => void
  },
  now: () => number,
  shouldContinue: () => boolean,
): Promise<void> {
  while (shouldContinue() && (await drainOneQqOutbox(args, now))) {
    // One chunk per transaction keeps unbind fencing exact while still
    // allowing arbitrarily long answers to drain without truncation.
  }
}

export async function drainOneQqOutbox(
  args: {
    pool: Pool
    sendText: (openid: string, text: string) => Promise<void>
    sendMedia?: (openid: string, media: ResolvedQqOutboundMedia) => Promise<void>
    resolveMediaPart?: ResolveQqOutboundMediaPartFn
    onError?: (message: string, meta?: Record<string, unknown>) => void
  },
  now: () => number,
): Promise<boolean> {
  const { pool } = args
  const client = await pool.connect()
  let began = false
  try {
    const current = now()
    await client.query('BEGIN')
    began = true
    // One leader owns this worker.  Read the candidate first, then lock the
    // binding before the outbox row; unbind uses the same binding→outbox order.
    const candidate = await client.query<{ id: string; user_id: string }>(
      `SELECT id, user_id
         FROM qq_outbox
        WHERE status = 'queued' AND next_attempt_at <= $1
        ORDER BY created_at, id
        LIMIT 1`,
      [current],
    )
    const picked = candidate.rows[0]
    if (!picked) {
      await client.query('COMMIT')
      return false
    }
    const binding = await client.query<{
      bot_openid: string
      binding_version: string
    }>(
      `SELECT bot_openid, binding_version
         FROM qq_bot_bindings
        WHERE user_id = $1
        FOR SHARE`,
      [picked.user_id],
    )
    const row = await client.query<{
      id: string
      binding_version: string
      target_openid: string
      payload: unknown
      next_chunk: number
      attempts: number
    }>(
      `SELECT id, binding_version, target_openid, payload, next_chunk, attempts
         FROM qq_outbox
        WHERE id = $1 AND status = 'queued' AND next_attempt_at <= $2
        FOR UPDATE`,
      [picked.id, current],
    )
    const delivery = row.rows[0]
    if (!delivery) {
      await client.query('COMMIT')
      return true
    }
    const active = binding.rows[0]
    if (
      !active ||
      active.binding_version !== delivery.binding_version ||
      active.bot_openid !== delivery.target_openid
    ) {
      await cancelRow(client, delivery.id, current)
      await client.query('COMMIT')
      return true
    }
    const item = parseNextItem(delivery.payload, delivery.next_chunk)
    if (!item) {
      await cancelRow(client, delivery.id, current)
      await client.query('COMMIT')
      return true
    }
    await client.query(
      `UPDATE qq_outbox
          SET status = 'sending', locked_at = $2, updated_at = $2
        WHERE id = $1`,
      [delivery.id, current],
    )
    try {
      // The binding FOR SHARE lock stays held through the network call.
      // DELETE/rebind cannot return while a send using the old binding is live.
      if (item.kind === 'text') {
        await args.sendText(delivery.target_openid, item.text)
      } else if (item.kind === 'media') {
        if (!args.resolveMediaPart || !args.sendMedia) {
          throw new Error('QQ outbound media delivery is unavailable')
        }
        try {
          const media = await args.resolveMediaPart({
            bindingUserId: picked.user_id,
            part: item.media,
          })
          await args.sendMedia(delivery.target_openid, media)
        } catch (err) {
          if (!(err instanceof QqOutboundMediaTooLargeError)) throw err
          // The row is terminal only after the explicit size-limit notice
          // itself reaches QQ; a notice failure remains durably retryable.
          await args.sendText(delivery.target_openid, err.userMessage)
        }
      }
    } catch (err) {
      const attempts = delivery.attempts + 1
      const delay = Math.min(5 * 60 * 1000, 1_000 * 2 ** Math.min(attempts, 8))
      await client.query(
        `UPDATE qq_outbox
            SET status = 'queued',
                attempts = $2,
                last_error = $3,
                next_attempt_at = $4,
                locked_at = NULL,
                updated_at = $5
          WHERE id = $1`,
        [
          delivery.id,
          attempts,
          (err instanceof Error ? err.message : String(err)).slice(0, 1000),
          current + delay,
          current,
        ],
      )
      await client.query('COMMIT')
      args.onError?.('qq outbox send failed; retained for retry', {
        outboxId: delivery.id,
        attempts,
      })
      return false
    }
    const nextChunk = delivery.next_chunk + 1
    if (item.terminal) {
      await client.query(
        `UPDATE qq_outbox
            SET status = 'sent',
                next_chunk = $2,
                sent_at = $3,
                locked_at = NULL,
                last_error = NULL,
                updated_at = $3
          WHERE id = $1`,
        [delivery.id, nextChunk, current],
      )
    } else {
      await client.query(
        `UPDATE qq_outbox
            SET status = 'queued',
                next_chunk = $2,
                next_attempt_at = $3,
                locked_at = NULL,
                last_error = NULL,
                updated_at = $3
          WHERE id = $1`,
        [delivery.id, nextChunk, current],
      )
    }
    await client.query('COMMIT')
    return true
  } catch (err) {
    if (began) await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

function parseChunks(payload: unknown): string[] | null {
  if (!payload || typeof payload !== 'object') return null
  const chunks = (payload as { chunks?: unknown }).chunks
  if (!Array.isArray(chunks) || chunks.length === 0) return null
  return chunks.every((chunk) => typeof chunk === 'string' && chunk.length > 0) ? chunks : null
}

type QqOutboxItem =
  | { kind: 'text'; text: string; terminal: boolean }
  | { kind: 'media'; media: QqOutboundMediaPart; terminal: true }
  | { kind: 'media_root'; terminal: true }

function parseNextItem(payload: unknown, nextChunk: number): QqOutboxItem | null {
  if (!payload || typeof payload !== 'object') return null
  if ((payload as { mediaRoot?: unknown }).mediaRoot === true) {
    return nextChunk === 0 ? { kind: 'media_root', terminal: true } : null
  }
  const media = parseMediaPart((payload as { media?: unknown }).media)
  if (media) {
    return nextChunk === 0 ? { kind: 'media', media, terminal: true } : null
  }
  const chunks = parseChunks(payload)
  if (!chunks || nextChunk >= chunks.length) return null
  return {
    kind: 'text',
    text: chunks[nextChunk]!,
    terminal: nextChunk + 1 >= chunks.length,
  }
}

function parseMediaPart(input: unknown): QqOutboundMediaPart | null {
  if (!input || typeof input !== 'object') return null
  const part = input as {
    type?: unknown
    containerPath?: unknown
    filename?: unknown
    mimeType?: unknown
  }
  if (
    !['image', 'video', 'voice', 'file'].includes(String(part.type)) ||
    typeof part.containerPath !== 'string' ||
    !/^\/home\/agent\/\.openclaude\/(?:uploads|generated)\/[^/]+$/.test(part.containerPath) ||
    typeof part.filename !== 'string' ||
    part.filename.length === 0 ||
    part.filename !== part.containerPath.split('/').at(-1) ||
    (part.mimeType !== undefined && typeof part.mimeType !== 'string')
  ) {
    return null
  }
  return {
    type: part.type as QqOutboundMediaPart['type'],
    containerPath: part.containerPath,
    filename: part.filename,
    ...(part.mimeType ? { mimeType: part.mimeType } : {}),
  }
}

async function cancelRow(client: PoolClient, id: string, now: number): Promise<void> {
  await client.query(
    `UPDATE qq_outbox
        SET status = 'cancelled',
            cancelled_at = $2,
            locked_at = NULL,
            updated_at = $2
      WHERE id = $1 AND status IN ('queued','sending')`,
    [id, now],
  )
}

async function releaseStaleQqOutbox(pool: Pool, now: number): Promise<void> {
  await pool.query(
    `UPDATE qq_outbox
        SET status = 'queued',
            next_attempt_at = LEAST(next_attempt_at, $1),
            locked_at = NULL,
            updated_at = $1
      WHERE status = 'sending' AND locked_at < $2`,
    [now, now - STALE_LOCK_MS],
  )
}
