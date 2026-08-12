/**
 * /v3/ocr/* — container-authenticated bridge to the private SCNet OCR worker.
 *
 * The worker is reachable only through a host-loopback SSH tunnel.  Container
 * identity is verified on every operation; the worker bearer and job id never
 * enter the container.  Job tickets are AES-GCM capabilities bound to userId,
 * so master restarts do not orphan long-running jobs.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Dispatcher } from 'undici'

import { directEgressDispatcher } from '../account-pool/egressDispatcher.js'
import {
  ContainerIdentityError,
  type ContainerIdentityRepo,
  verifyContainerIdentity,
} from '../auth/containerIdentity.js'
import { REQUEST_ID_HEADER, ensureRequestId, setSecurityHeaders } from '../http/util.js'

export const OCR_PREFIX = '/v3/ocr/'
export const OCR_PROTOCOL_MAJOR = 1

type HandlerCtx = { hostUuid: string; boundIp: string }
type TicketPayload = { v: 1; uid: number; job: string }
type TicketKey = { kid: string; key: Buffer }

export interface OcrProxyDeps {
  identityRepo: ContainerIdentityRepo
  fetchImpl?: typeof fetch
  workerBaseUrl?: string
  workerToken?: string
  expectedRelease?: string
  ticketKeys?: string
  ownerSecret?: string
}

export type OcrProxyHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HandlerCtx,
) => Promise<void>

type WorkerReady = {
  release: string
  protocol_major: number
  capabilities?: { modes?: string[] }
}

function sendJson(res: ServerResponse, status: number, body: unknown, requestId: string): void {
  if (res.headersSent) return
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    [REQUEST_ID_HEADER]: requestId,
  })
  res.end(JSON.stringify(body))
}

function sendErr(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  requestId: string,
  details?: unknown,
): void {
  sendJson(
    res,
    status,
    {
      error: { code, message, ...(details === undefined ? {} : { details }) },
      request_id: requestId,
    },
    requestId,
  )
}

async function readJson(req: IncomingMessage, maxBytes = 16 * 1024): Promise<any> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    total += chunk.length
    if (total > maxBytes) throw new Error('body_too_large')
    chunks.push(Buffer.from(chunk))
  }
  return total === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function parseTicketKeys(raw: string): TicketKey[] {
  const keys = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const split = entry.indexOf(':')
      if (split <= 0) throw new Error('invalid ticket key entry')
      const kid = entry.slice(0, split)
      const key = Buffer.from(entry.slice(split + 1), 'base64')
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(kid) || key.length !== 32) {
        throw new Error('invalid ticket key')
      }
      return { kid, key }
    })
  if (keys.length === 0) throw new Error('no ticket keys configured')
  return keys
}

function sealTicket(payload: TicketPayload, key: TicketKey): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key.key, iv)
  cipher.setAAD(Buffer.from(key.kid))
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()])
  return [
    key.kid,
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
  ].join('.')
}

function openTicket(ticket: unknown, uid: number, keys: TicketKey[]): TicketPayload {
  if (typeof ticket !== 'string' || ticket.length > 2048) throw new Error('invalid_ticket')
  const [kid, ivRaw, ciphertextRaw, tagRaw, extra] = ticket.split('.')
  if (!kid || !ivRaw || !ciphertextRaw || !tagRaw || extra !== undefined)
    throw new Error('invalid_ticket')
  const key = keys.find((candidate) => candidate.kid === kid)
  if (!key) throw new Error('invalid_ticket')
  try {
    const iv = Buffer.from(ivRaw, 'base64url')
    const ciphertext = Buffer.from(ciphertextRaw, 'base64url')
    const tag = Buffer.from(tagRaw, 'base64url')
    if (iv.length !== 12 || tag.length !== 16) throw new Error('invalid_ticket')
    const decipher = createDecipheriv('aes-256-gcm', key.key, iv)
    decipher.setAAD(Buffer.from(kid))
    decipher.setAuthTag(tag)
    const payload = JSON.parse(
      Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'),
    )
    if (payload?.v !== 1 || payload?.uid !== uid || typeof payload?.job !== 'string') {
      throw new Error('invalid_ticket')
    }
    return payload as TicketPayload
  } catch {
    throw new Error('invalid_ticket')
  }
}

function ownerKey(uid: number, key: Buffer): string {
  return createHmac('sha256', key).update(`ocr-owner:${uid}`).digest('base64url')
}

async function jsonOf(response: Response): Promise<any> {
  const text = await response.text()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('worker_bad_json')
  }
}

function cleanWorkerStatus(value: any): any {
  if (!value || typeof value !== 'object') return value
  const { job_id: _jobId, owner: _owner, ...safe } = value
  return safe
}

export function makeOcrProxyHandler(deps: OcrProxyDeps): OcrProxyHandler {
  const fetchImpl = deps.fetchImpl ?? fetch
  const base = (deps.workerBaseUrl ?? process.env.OC_OCR_WORKER_URL ?? '').replace(/\/$/, '')
  const workerToken = deps.workerToken ?? process.env.OC_OCR_WORKER_TOKEN ?? ''
  const expectedRelease = deps.expectedRelease ?? process.env.OC_OCR_WORKER_EXPECTED_RELEASE ?? ''
  const keyConfig = deps.ticketKeys ?? process.env.OC_OCR_TICKET_KEYS ?? ''
  const ownerSecretConfig = deps.ownerSecret ?? process.env.OC_OCR_OWNER_SECRET ?? ''
  let keys: TicketKey[] = []
  try {
    if (keyConfig) keys = parseTicketKeys(keyConfig)
  } catch {
    keys = []
  }
  const ownerSecret = Buffer.from(ownerSecretConfig, 'base64')

  const workerFetch = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetchImpl(`${base}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${workerToken}`,
        ...(init.headers ?? {}),
      },
      dispatcher: directEgressDispatcher(),
    } as RequestInit & { dispatcher: Dispatcher })

  async function assertReady(): Promise<WorkerReady> {
    if (!base || !workerToken || !expectedRelease || keys.length === 0 || ownerSecret.length !== 32)
      throw new Error('not_configured')
    const response = await workerFetch('/ready', { signal: AbortSignal.timeout(10_000) })
    const value = (await jsonOf(response)) as WorkerReady
    const modes = value.capabilities?.modes ?? []
    if (
      !response.ok ||
      value.release !== expectedRelease ||
      value.protocol_major !== OCR_PROTOCOL_MAJOR ||
      !['pp', 'hybrid', 'vl'].every((mode) => modes.includes(mode))
    ) {
      throw new Error('worker_release_mismatch')
    }
    return value
  }

  return async function handle(req, res, ctx) {
    setSecurityHeaders(res)
    const requestId = ensureRequestId(req)
    res.setHeader(REQUEST_ID_HEADER, requestId)

    if (req.method !== 'POST') {
      sendErr(res, 405, 'METHOD_NOT_ALLOWED', 'POST required', requestId)
      return
    }

    let identity: { containerId: number; userId: number }
    try {
      identity = await verifyContainerIdentity(deps.identityRepo, ctx, req.headers.authorization)
    } catch (err) {
      if (err instanceof ContainerIdentityError) {
        sendErr(res, 401, 'UNAUTHORIZED', 'container identity verification failed', requestId)
        return
      }
      throw err
    }

    try {
      await assertReady()
    } catch (err) {
      const code = String(err).includes('not_configured')
        ? 'OCR_NOT_CONFIGURED'
        : 'OCR_WORKER_UNAVAILABLE'
      sendErr(res, 503, code, 'OCR worker is not ready', requestId)
      return
    }

    const path = (req.url ?? '').split('?')[0]
    try {
      if (path === `${OCR_PREFIX}submit`) {
        const owner = ownerKey(identity.userId, ownerSecret)
        const filename = String(req.headers['x-ocr-filename'] ?? 'document')
          .replace(/[\p{Cc}\\/]/gu, '_')
          .slice(0, 240)
        const mode = String(req.headers['x-ocr-mode'] ?? 'hybrid')
        const fallback = String(req.headers['x-ocr-fallback'] ?? '0.10')
        if (!/^(pp|hybrid|vl)$/.test(mode) || !/^0(?:\.\d+)?$|^1(?:\.0+)?$/.test(fallback)) {
          sendErr(res, 400, 'OCR_BAD_REQUEST', 'invalid OCR mode or fallback', requestId)
          return
        }
        const headers: Record<string, string> = {
          'content-type': String(req.headers['content-type'] ?? 'application/octet-stream'),
          'x-ocr-owner': owner,
          'x-ocr-filename': filename,
          'x-ocr-mode': mode,
          'x-ocr-fallback': fallback,
        }
        if (req.headers['content-length'])
          headers['content-length'] = String(req.headers['content-length'])
        const upstream = await workerFetch('/v1/jobs', {
          method: 'POST',
          headers,
          body: req as unknown as BodyInit,
          duplex: 'half',
          signal: AbortSignal.timeout(60 * 60_000),
        } as RequestInit & { duplex: 'half' })
        const value = await jsonOf(upstream)
        if (!upstream.ok) {
          sendErr(
            res,
            upstream.status,
            'OCR_SUBMIT_REJECTED',
            value?.error ?? 'OCR submit rejected',
            requestId,
            value?.details,
          )
          return
        }
        if (typeof value?.job_id !== 'string') throw new Error('worker_bad_job')
        const ticket = sealTicket({ v: 1, uid: identity.userId, job: value.job_id }, keys[0])
        sendJson(
          res,
          202,
          { ticket, status: value.status ?? 'queued', queue_position: value.queue_position },
          requestId,
        )
        return
      }

      let body: any
      try {
        body = await readJson(req)
      } catch {
        sendErr(res, 400, 'OCR_BAD_REQUEST', 'invalid JSON request', requestId)
        return
      }
      let ticket: TicketPayload
      try {
        ticket = openTicket(body?.ticket, identity.userId, keys)
      } catch {
        sendErr(res, 403, 'OCR_INVALID_TICKET', 'invalid OCR job ticket', requestId)
        return
      }
      // The owner secret is deliberately independent from rotating ticket keys,
      // so one user keeps a single quota ledger across rotations.
      const owner = ownerKey(identity.userId, ownerSecret)
      const workerHeaders = { 'x-ocr-owner': owner, 'content-type': 'application/json' }

      if (path === `${OCR_PREFIX}status`) {
        const upstream = await workerFetch(`/v1/jobs/${encodeURIComponent(ticket.job)}`, {
          method: 'GET',
          headers: workerHeaders,
          signal: AbortSignal.timeout(15_000),
        })
        const value = await jsonOf(upstream)
        if (!upstream.ok) {
          sendErr(
            res,
            upstream.status,
            'OCR_STATUS_FAILED',
            value?.error ?? 'OCR status failed',
            requestId,
            value?.details,
          )
          return
        }
        sendJson(res, 200, { ticket: body.ticket, ...cleanWorkerStatus(value) }, requestId)
        return
      }

      if (path === `${OCR_PREFIX}cancel`) {
        const upstream = await workerFetch(`/v1/jobs/${encodeURIComponent(ticket.job)}/cancel`, {
          method: 'POST',
          headers: workerHeaders,
          body: '{}',
          signal: AbortSignal.timeout(15_000),
        })
        const value = await jsonOf(upstream)
        if (!upstream.ok) {
          sendErr(
            res,
            upstream.status,
            'OCR_CANCEL_FAILED',
            value?.error ?? 'OCR cancel failed',
            requestId,
            value?.details,
          )
          return
        }
        sendJson(res, 200, { ticket: body.ticket, ...cleanWorkerStatus(value) }, requestId)
        return
      }

      if (path === `${OCR_PREFIX}result`) {
        const format = body?.format === 'jsonl' ? 'jsonl' : 'markdown'
        const upstream = await workerFetch(
          `/v1/jobs/${encodeURIComponent(ticket.job)}/result?format=${format}`,
          {
            method: 'GET',
            headers: { 'x-ocr-owner': owner },
            signal: AbortSignal.timeout(60 * 60_000),
          },
        )
        if (!upstream.ok) {
          const value = await jsonOf(upstream)
          sendErr(
            res,
            upstream.status,
            'OCR_RESULT_FAILED',
            value?.error ?? 'OCR result unavailable',
            requestId,
            value?.details,
          )
          return
        }
        const resultHeaders: Record<string, string> = {
          'content-type':
            format === 'jsonl' ? 'application/x-ndjson' : 'text/markdown; charset=utf-8',
          'cache-control': 'no-store',
          [REQUEST_ID_HEADER]: requestId,
        }
        const contentLength = upstream.headers.get('content-length')
        if (contentLength) resultHeaders['content-length'] = contentLength
        res.writeHead(200, resultHeaders)
        if (!upstream.body) {
          res.end()
          return
        }
        await pipeline(Readable.fromWeb(upstream.body as any), res)
        return
      }

      sendErr(res, 404, 'NOT_FOUND', 'unknown OCR operation', requestId)
    } catch {
      sendErr(res, 502, 'OCR_WORKER_ERROR', 'OCR worker request failed', requestId)
    }
  }
}
