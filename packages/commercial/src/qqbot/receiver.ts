import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Pool } from 'pg'
import { z } from 'zod'

import {
  type ContainerIdentity,
  ContainerIdentityError,
  type ContainerIdentityRepo,
  verifyContainerIdentity,
} from '../auth/containerIdentity.js'
import {
  HttpError,
  REQUEST_ID_HEADER,
  ensureRequestId,
  readJsonBody,
  sendError,
  sendJson,
  setSecurityHeaders,
} from '../http/util.js'
import { getPreferences } from '../user/preferences.js'
import type { WechatCodexBillingBody } from '../wechat/outboundReceiver.js'
import { expandTextWithQqMediaParts } from './outboundMedia.js'
import { enqueueQqDelivery } from './outbox.js'
import { clearRunningQqSession } from './sessionPointer.js'
import { getQqBinding } from './store.js'

export { QQ_OUTBOUND_PATH, QQ_PROACTIVE_PATH } from '@openclaude/protocol'

const ID_RE = /^[A-Za-z0-9._:-]{8,128}$/
const SESSION_RE = /^wsess-[0-9a-f]{16}$/

const QqOutboundSchema = z
  .object({
    sessionId: z.string().regex(SESSION_RE),
    channel: z.literal('qqbot'),
    outboundId: z.string().regex(ID_RE),
    peer: z
      .object({
        kind: z.literal('dm'),
        meta: z.object({ senderId: z.string().min(1).max(256) }).passthrough(),
      })
      .strict(),
    blocks: z.array(z.object({ kind: z.string() }).passthrough()).min(1),
    createdAt: z.number().int().positive().optional(),
    isFinal: z.boolean().optional(),
    traceId: z.string().regex(ID_RE).optional(),
  })
  .strict()

const BillingSchema = z
  .object({
    type: z.literal('outbound.codex_billing'),
    requestId: z.string().regex(/^[0-9a-f]{32}$/),
    status: z.union([z.literal('success'), z.literal('error')]),
    durationMs: z.number().finite().nonnegative(),
  })
  .passthrough()

const ProactiveSchema = z
  .object({
    text: z
      .string()
      .min(1)
      .max(256 * 1024),
    outboundId: z.string().regex(ID_RE),
    traceId: z.string().regex(ID_RE).optional(),
  })
  .strict()

type InternalCtx = { hostUuid: string; boundIp: string }
type InternalHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: InternalCtx,
) => Promise<void>

export function makeQqOutboundReceiver(args: {
  pool: Pool
  identityRepo: ContainerIdentityRepo
  handleCodexBilling?: (body: WechatCodexBillingBody, identity: ContainerIdentity) => Promise<void>
  onQueued?: () => void
}): InternalHandler {
  return async (req, res, ctx) => {
    const requestId = prepare(req, res)
    if (req.method !== 'POST') {
      sendError(res, 405, 'METHOD_NOT_ALLOWED', 'POST required', requestId)
      return
    }
    const identity = await authenticate(req, res, ctx, requestId, args.identityRepo)
    if (!identity) return
    let raw: unknown
    try {
      raw = await readJsonBody(req)
    } catch (err) {
      if (err instanceof HttpError) {
        sendError(res, err.status, err.code, err.message, requestId)
        return
      }
      throw err
    }
    const billing = BillingSchema.safeParse(raw)
    if (billing.success) {
      if (!args.handleCodexBilling) {
        sendError(res, 503, 'CODEX_BILLING_NOT_WIRED', 'billing handler unavailable', requestId)
        return
      }
      await args.handleCodexBilling(billing.data as unknown as WechatCodexBillingBody, identity)
      sendJson(res, 200, { ok: true }, { [REQUEST_ID_HEADER]: requestId })
      return
    }
    const parsed = QqOutboundSchema.safeParse(raw)
    if (!parsed.success) {
      sendError(res, 400, 'INVALID_BODY', 'body schema rejected', requestId)
      return
    }
    const body = parsed.data
    const binding = await getQqBinding(args.pool, String(identity.userId))
    if (!binding || binding.openid !== body.peer.meta.senderId) {
      sendError(res, 410, 'QQ_BINDING_GONE', 'QQ binding changed or was removed', requestId)
      return
    }
    const renderedText = body.blocks
      .filter(
        (block): block is typeof block & { text: string } =>
          block.kind === 'text' && typeof block.text === 'string',
      )
      .map((block) => block.text)
      .join('')
    const expanded = expandTextWithQqMediaParts(renderedText)
    if (!expanded.text && expanded.media.length === 0) {
      sendJson(
        res,
        200,
        { ok: true, outcome: 'empty_render' },
        {
          [REQUEST_ID_HEADER]: requestId,
        },
      )
      return
    }
    const queued = await enqueueQqDelivery(args.pool, {
      deliveryId: body.outboundId,
      userId: String(identity.userId),
      text: expanded.text,
      kind: 'reply',
      sessionId: body.sessionId,
      media: expanded.media,
      expectedBinding: {
        version: binding.bindingVersion,
        openid: body.peer.meta.senderId,
      },
    })
    if (queued.outcome === 'cancelled' || queued.outcome === 'no_binding') {
      sendError(res, 410, 'QQ_BINDING_GONE', 'QQ binding changed or was removed', requestId)
      return
    }
    if (body.isFinal && body.traceId) {
      await clearRunningQqSession(
        args.pool,
        String(identity.userId),
        body.sessionId as `wsess-${string}`,
        body.traceId,
      ).catch(() => {})
    }
    args.onQueued?.()
    sendJson(
      res,
      queued.outcome === 'queued' || queued.outcome === 'pending' ? 202 : 200,
      {
        ok: true,
        outcome: queued.outcome,
        ...(queued.outboxId ? { outboxId: queued.outboxId } : {}),
      },
      { [REQUEST_ID_HEADER]: requestId },
    )
  }
}

export function makeQqProactiveReceiver(args: {
  pool: Pool
  identityRepo: ContainerIdentityRepo
  onQueued?: () => void
}): InternalHandler {
  return async (req, res, ctx) => {
    const requestId = prepare(req, res)
    if (req.method !== 'POST') {
      sendError(res, 405, 'METHOD_NOT_ALLOWED', 'POST required', requestId)
      return
    }
    const identity = await authenticate(req, res, ctx, requestId, args.identityRepo)
    if (!identity) return
    let raw: unknown
    try {
      raw = await readJsonBody(req)
    } catch (err) {
      if (err instanceof HttpError) {
        sendError(res, err.status, err.code, err.message, requestId)
        return
      }
      throw err
    }
    const parsed = ProactiveSchema.safeParse(raw)
    if (!parsed.success) {
      sendError(res, 400, 'INVALID_BODY', 'body schema rejected', requestId)
      return
    }
    const prefs = await getPreferences(String(identity.userId))
    if (prefs.prefs.qq_proactive_push === false) {
      sendJson(
        res,
        200,
        { ok: true, outcome: 'pref_off' },
        {
          [REQUEST_ID_HEADER]: requestId,
        },
      )
      return
    }
    const binding = await getQqBinding(args.pool, String(identity.userId))
    if (!binding) {
      sendJson(
        res,
        200,
        { ok: true, outcome: 'no_binding' },
        {
          [REQUEST_ID_HEADER]: requestId,
        },
      )
      return
    }
    const queued = await enqueueQqDelivery(args.pool, {
      deliveryId: parsed.data.outboundId,
      userId: String(identity.userId),
      text: parsed.data.text,
      kind: 'proactive',
    })
    if (queued.outcome === 'no_binding' || queued.outcome === 'cancelled') {
      sendJson(
        res,
        200,
        { ok: true, outcome: 'no_binding' },
        {
          [REQUEST_ID_HEADER]: requestId,
        },
      )
      return
    }
    args.onQueued?.()
    sendJson(
      res,
      200,
      {
        ok: true,
        outcome: queued.outcome,
        ...(queued.outboxId ? { outboxId: queued.outboxId } : {}),
      },
      { [REQUEST_ID_HEADER]: requestId },
    )
  }
}

function prepare(req: IncomingMessage, res: ServerResponse): string {
  setSecurityHeaders(res)
  const requestId = ensureRequestId(req)
  res.setHeader(REQUEST_ID_HEADER, requestId)
  return requestId
}

async function authenticate(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: InternalCtx,
  requestId: string,
  repo: ContainerIdentityRepo,
): Promise<ContainerIdentity | null> {
  try {
    return await verifyContainerIdentity(repo, ctx, req.headers.authorization)
  } catch (err) {
    if (err instanceof ContainerIdentityError) {
      sendError(res, 401, 'UNAUTHORIZED', 'container identity verification failed', requestId)
      return null
    }
    throw err
  }
}
