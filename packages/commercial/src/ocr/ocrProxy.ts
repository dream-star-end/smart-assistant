/**
 * /v3/ocr/* — container-authenticated bridge to SCNet managed document parsing.
 *
 * Provider credentials stay on master. PostgreSQL owns tenant binding,
 * cancellation and the completion barrier; provider result URLs are mirrored
 * into master-owned files before a job becomes completed.
 */
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { type Stats, createReadStream } from 'node:fs'
import { rm, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Dispatcher } from 'undici'

import { directEgressDispatcher } from '../account-pool/egressDispatcher.js'
import {
  ContainerIdentityError,
  type ContainerIdentityRepo,
  verifyContainerIdentity,
} from '../auth/containerIdentity.js'
import { REQUEST_ID_HEADER, ensureRequestId, setSecurityHeaders } from '../http/util.js'
import { rootLogger } from '../logging/logger.js'
import type { OcrJob, OcrJobStatus, OcrJobStore } from './ocrStore.js'
import {
  type ScnetFileUploadDeps,
  type ScnetFileUploadInput,
  type ScnetUploadCredential,
  ScnetUploadHttpError,
  ScnetUploadShapeError,
  uploadScnetFile,
  validateScnetUploadCredential,
} from './scnetFileUpload.js'
import {
  type ScnetResultDownloadDeps,
  ScnetResultHttpError,
  ScnetResultShapeError,
  ScnetRotatedEmptyPageError,
  downloadScnetResultJson,
  gcScnetOcrResults,
  materializeScnetResults,
} from './scnetResultDownload.js'

export const OCR_PREFIX = '/v3/ocr/'
export const OCR_PROTOCOL_MAJOR = 2

const SCNET_API_BASE = 'https://api.scnet.cn/api/llm/v1'
const PROVIDER_REQUEST_TIMEOUT_MS = 30_000
const STALE_SUBMIT_MS = 65 * 60_000
const GC_INTERVAL_MS = 60 * 60_000
const FILE_VISIBILITY_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000] as const
const FILE_NOT_READY_PREFIX = 'file_url is not reachable or the file cannot be read:'
const log = rootLogger.child({ subsys: 'scnet-ocr' })

type HandlerCtx = { hostUuid: string; boundIp: string }
type TicketPayload = { v: 1 | 2; uid: number; job: string }
type TicketKey = { kid: string; key: Buffer }

export interface OcrProxyDeps {
  identityRepo: ContainerIdentityRepo
  store: OcrJobStore
  fetchImpl?: typeof fetch
  apiBaseUrl?: string
  apiKey?: string
  ticketKeys?: string
  resultDir?: string
  now?: () => number
  sleep?: (delayMs: number) => Promise<void>
  fileUploadDeps?: ScnetFileUploadDeps
  uploadFile?: (input: ScnetFileUploadInput) => Promise<void>
  resultDownloadDeps?: ScnetResultDownloadDeps
  downloadResult?: (url: string) => Promise<unknown>
}

export type OcrProxyHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HandlerCtx,
) => Promise<void>

class ProviderError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

interface ProviderTask {
  status: string
  results: string[]
  pagesTotal: number | null
  errorCode: string | null
  errorMessage: string | null
}

function sendJson(res: ServerResponse, status: number, body: unknown, requestId: string): void {
  if (res.headersSent || res.destroyed) return
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
    if (
      (payload?.v !== 1 && payload?.v !== 2) ||
      payload?.uid !== uid ||
      typeof payload?.job !== 'string'
    ) {
      throw new Error('invalid_ticket')
    }
    return payload as TicketPayload
  } catch {
    throw new Error('invalid_ticket')
  }
}

async function jsonOf(response: Response): Promise<any> {
  const text = await response.text()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new ProviderError(502, 'SCNET_BAD_JSON', 'SCNet returned invalid JSON')
  }
}

function providerStatus(response: Response, value: any): number {
  if (!response.ok) return response.status
  return String(value?.code) === '10011' ? 429 : 502
}

function providerMessage(value: any, fallback: string, apiKey: string): string {
  const raw = typeof value?.msg === 'string' ? value.msg : fallback
  const withoutKey = apiKey ? raw.replaceAll(apiKey, '[redacted]') : raw
  return withoutKey.replace(/https?:\/\/\S+/giu, '[redacted-url]').slice(0, 1000)
}

function isUploadedFileNotReady(response: Response, value: any): boolean {
  return (
    response.status === 422 &&
    String(value?.code) === '10013' &&
    typeof value?.msg === 'string' &&
    value.msg.startsWith(FILE_NOT_READY_PREFIX)
  )
}

function publicStatus(ticket: string, job: OcrJob): Record<string, unknown> {
  return {
    ticket,
    status: job.status,
    phase: job.phase,
    pages_done: job.status === 'completed' ? (job.pagesTotal ?? 0) : 0,
    pages_total: job.pagesTotal,
    provider: 'scnet-doc-parsing',
    ...(job.errorMessage ? { error: job.errorMessage, error_code: job.errorCode } : {}),
    ...(job.expiresAt ? { result_expires_at: job.expiresAt.toISOString() } : {}),
  }
}

export function makeOcrProxyHandler(deps: OcrProxyDeps): OcrProxyHandler {
  const fetchImpl = deps.fetchImpl ?? fetch
  const apiBase = (deps.apiBaseUrl ?? SCNET_API_BASE).replace(/\/$/, '')
  const apiKey = deps.apiKey ?? process.env.OC_SCNET_OCR_API_KEY ?? ''
  const keyConfig = deps.ticketKeys ?? process.env.OC_OCR_TICKET_KEYS ?? ''
  const resultDir = deps.resultDir ?? process.env.OC_OCR_RESULT_DIR ?? ''
  const now = deps.now ?? Date.now
  const sleep =
    deps.sleep ?? ((delayMs: number) => new Promise<void>((done) => setTimeout(done, delayMs)))
  const materializations = new Map<string, Promise<void>>()
  let keys: TicketKey[] = []
  try {
    if (keyConfig) keys = parseTicketKeys(keyConfig)
  } catch {
    keys = []
  }

  const providerFetch = (operation: string, init: RequestInit): Promise<Response> =>
    fetchImpl(`${apiBase}${operation}`, {
      ...init,
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(init.headers ?? {}),
      },
      dispatcher: directEgressDispatcher(),
    } as RequestInit & { dispatcher: Dispatcher })

  async function queryTask(providerTaskId: string): Promise<ProviderTask> {
    const response = await providerFetch('/ocrdoc/result', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task_ids: [providerTaskId] }),
      signal: AbortSignal.timeout(30_000),
    })
    const value = await jsonOf(response)
    if (!response.ok || String(value?.code) !== '0') {
      throw new ProviderError(
        providerStatus(response, value),
        String(value?.code ?? 'SCNET_RESULT_FAILED'),
        providerMessage(value, 'SCNet status request failed', apiKey),
      )
    }
    const item = Array.isArray(value?.data)
      ? value.data.find((candidate: any) => String(candidate?.output?.task_id) === providerTaskId)
      : null
    const output = item?.output
    if (!output || typeof output.task_status !== 'string') {
      throw new ProviderError(502, 'SCNET_BAD_RESULT_SHAPE', 'SCNet status response is incomplete')
    }
    return {
      status: output.task_status,
      results: Array.isArray(output.results)
        ? output.results.filter((entry: unknown): entry is string => typeof entry === 'string')
        : [],
      pagesTotal: Number.isInteger(item?.usage?.image_count) ? item.usage.image_count : null,
      errorCode: output.error_code == null ? null : String(output.error_code),
      errorMessage:
        output.error_message == null ? null : String(output.error_message).slice(0, 1000),
    }
  }

  async function materialize(job: OcrJob, task: ProviderTask): Promise<void> {
    const download =
      deps.downloadResult ??
      ((url: string) => downloadScnetResultJson(url, deps.resultDownloadDeps))
    try {
      const result = await materializeScnetResults({
        urls: task.results,
        userId: job.userId,
        jobId: job.id,
        resultDir,
        download,
      })
      if (task.pagesTotal !== null && task.pagesTotal !== result.pagesTotal) {
        throw new ScnetResultShapeError(
          `SCNet reported ${task.pagesTotal} pages but returned ${result.pagesTotal}`,
        )
      }
      const committed = await deps.store.markCompleted({
        id: job.id,
        userId: job.userId,
        pagesTotal: result.pagesTotal,
        markdownPath: result.markdownPath,
        jsonlPath: result.jsonlPath,
      })
      if (!committed) {
        const current = await deps.store.get(job.userId, job.id)
        if (!current || current.status === 'cancelled') {
          await rm(path.dirname(result.markdownPath), { recursive: true, force: true })
        }
      }
    } catch (error) {
      if (error instanceof ScnetResultHttpError) throw error
      if (error instanceof ScnetRotatedEmptyPageError || error instanceof ScnetResultShapeError) {
        await rm(path.join(path.resolve(resultDir), String(job.userId), job.id), {
          recursive: true,
          force: true,
        })
        await deps.store.markFailed(
          job.userId,
          job.id,
          error instanceof ScnetRotatedEmptyPageError
            ? 'SCNET_EMPTY_ROTATED_PAGE'
            : 'SCNET_BAD_RESULT_SHAPE',
          error.message,
        )
        return
      }
      throw error
    }
  }

  async function refresh(job: OcrJob): Promise<void> {
    if (!job.providerTaskId) {
      if (now() - job.updatedAt.getTime() > STALE_SUBMIT_MS) {
        await deps.store.markFailed(
          job.userId,
          job.id,
          'OCR_SUBMIT_INTERRUPTED',
          'OCR submission was interrupted before SCNet acknowledged the task',
        )
      }
      return
    }
    const task = await queryTask(job.providerTaskId)
    if (task.status === 'pending') {
      await deps.store.markProgress(job.userId, job.id, 'queued', 'queued')
      return
    }
    if (task.status === 'running') {
      await deps.store.markProgress(job.userId, job.id, 'running', 'recognizing')
      return
    }
    if (task.status === 'failed' || task.status === 'unknown') {
      await deps.store.markFailed(
        job.userId,
        job.id,
        task.errorCode ?? (task.status === 'unknown' ? 'SCNET_UNKNOWN_TASK' : 'SCNET_TASK_FAILED'),
        task.errorMessage ?? `SCNet task ${task.status}`,
      )
      return
    }
    if (task.status !== 'succeeded') {
      throw new ProviderError(502, 'SCNET_UNKNOWN_STATUS', 'SCNet returned an unknown task status')
    }
    let work = materializations.get(job.id)
    if (!work) {
      work = materialize(job, task).finally(() => materializations.delete(job.id))
      materializations.set(job.id, work)
    }
    await work
  }

  async function gcExpired(): Promise<void> {
    await gcScnetOcrResults({ store: deps.store, resultDir, now: now() })
  }

  if (resultDir) {
    let gcRunning = false
    const runGc = (): void => {
      if (gcRunning) return
      gcRunning = true
      void gcExpired()
        .catch((error) => {
          log.warn('ocr_result_gc_failed', {
            err: error instanceof Error ? error.message : String(error),
          })
        })
        .finally(() => {
          gcRunning = false
        })
    }
    runGc()
    const gcTimer = setInterval(runGc, GC_INTERVAL_MS)
    gcTimer.unref()
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
    } catch (error) {
      if (error instanceof ContainerIdentityError) {
        sendErr(res, 401, 'UNAUTHORIZED', 'container identity verification failed', requestId)
        return
      }
      throw error
    }

    if (keys.length === 0) {
      sendErr(res, 503, 'OCR_NOT_CONFIGURED', 'OCR ticket keys are not configured', requestId)
      return
    }
    const requestPath = (req.url ?? '').split('?')[0]
    try {
      if (requestPath === `${OCR_PREFIX}submit`) {
        if (!apiKey || !resultDir) {
          sendErr(res, 503, 'OCR_NOT_CONFIGURED', 'SCNet OCR is not configured', requestId)
          return
        }
        const filename = String(req.headers['x-ocr-filename'] ?? 'document')
          .replace(/[\p{Cc}\\/]/gu, '_')
          .slice(0, 240)
        const mode = String(req.headers['x-ocr-mode'] ?? 'hybrid')
        const fallback = String(req.headers['x-ocr-fallback'] ?? '0.10')
        if (!/^(pp|hybrid|vl)$/.test(mode) || !/^0(?:\.\d+)?$|^1(?:\.0+)?$/.test(fallback)) {
          sendErr(res, 400, 'OCR_BAD_REQUEST', 'invalid OCR mode or fallback', requestId)
          return
        }
        const rawLength = String(req.headers['content-length'] ?? '')
        if (!/^\d+$/.test(rawLength)) {
          sendErr(res, 411, 'OCR_LENGTH_REQUIRED', 'content-length is required', requestId)
          return
        }
        const contentLength = BigInt(rawLength)
        if (contentLength > BigInt(Number.MAX_SAFE_INTEGER)) {
          sendErr(
            res,
            413,
            'OCR_FILE_TOO_LARGE',
            'file size exceeds the local filesystem range',
            requestId,
          )
          return
        }
        const contentType = String(req.headers['content-type'] ?? 'application/octet-stream')
        const job = await deps.store.create({
          id: randomUUID(),
          userId: identity.userId,
          filename,
          contentType,
          sizeBytes: Number(contentLength),
        })
        const extension = path
          .extname(filename)
          .replace(/[^A-Za-z0-9.]/g, '')
          .slice(0, 16)
        const providerFilename = `${job.id}${extension}`
        let response: Response
        let value: any
        try {
          const presignResponse = await providerFetch(
            `/upload/presign?file_name=${encodeURIComponent(providerFilename)}`,
            {
              method: 'GET',
              headers: { 'content-type': 'application/json' },
              signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
            },
          )
          const presignValue = await jsonOf(presignResponse)
          if (!presignResponse.ok || String(presignValue?.code) !== '0') {
            throw new ProviderError(
              providerStatus(presignResponse, presignValue),
              String(presignValue?.code ?? 'SCNET_PRESIGN_FAILED'),
              providerMessage(presignValue, 'SCNet upload authorization failed', apiKey),
            )
          }
          let credential: ScnetUploadCredential
          try {
            credential = validateScnetUploadCredential(presignValue?.data)
          } catch (error) {
            if (error instanceof ScnetUploadShapeError) {
              throw new ProviderError(502, 'SCNET_BAD_PRESIGN_SHAPE', error.message)
            }
            throw error
          }
          await (deps.uploadFile ?? ((input) => uploadScnetFile(input, deps.fileUploadDeps)))({
            credential,
            source: req,
            filename,
            contentType,
            contentLength,
          })
          const form = new URLSearchParams({
            file_url: credential.fileUrl,
            ocr_type: 'DOC_PARING',
            is_table_cls: 'true',
            is_doc_ori: 'true',
            is_inline_formula: 'true',
          })
          for (let attempt = 0; ; attempt += 1) {
            response = await providerFetch('/ocrdoc/submit', {
              method: 'POST',
              headers: {
                'content-type': 'application/x-www-form-urlencoded',
              },
              body: form.toString(),
              signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
            })
            value = await jsonOf(response)
            const delay = FILE_VISIBILITY_RETRY_DELAYS_MS[attempt]
            if (!isUploadedFileNotReady(response, value) || delay === undefined) break
            await sleep(delay)
          }
        } catch (error) {
          const failure =
            error instanceof ProviderError
              ? { code: error.code, message: error.message }
              : error instanceof ScnetUploadHttpError
                ? { code: 'SCNET_UPLOAD_FAILED', message: error.message }
                : error instanceof ScnetUploadShapeError
                  ? { code: 'SCNET_BAD_UPLOAD_SHAPE', message: error.message }
                  : {
                      code: 'SCNET_SUBMIT_FAILED',
                      message: 'SCNet submission failed before a task was acknowledged',
                    }
          await deps.store.markFailed(identity.userId, job.id, failure.code, failure.message)
          throw error
        }
        if (!response.ok || String(value?.code) !== '0') {
          const status = providerStatus(response, value)
          const code = String(value?.code ?? 'SCNET_SUBMIT_REJECTED')
          const message = providerMessage(value, 'SCNet rejected the OCR submission', apiKey)
          await deps.store.markFailed(identity.userId, job.id, code, message)
          sendErr(res, status, 'OCR_SUBMIT_REJECTED', message, requestId, { provider_code: code })
          return
        }
        const output = value?.data?.output
        if (typeof output?.task_id !== 'string' || !output.task_id) {
          await deps.store.markFailed(
            identity.userId,
            job.id,
            'SCNET_BAD_SUBMIT_SHAPE',
            'SCNet submission response did not contain a task id',
          )
          sendErr(
            res,
            502,
            'OCR_SUBMIT_REJECTED',
            'SCNet submission response is incomplete',
            requestId,
          )
          return
        }
        const status: OcrJobStatus = output.task_status === 'running' ? 'running' : 'queued'
        await deps.store.markSubmitted(identity.userId, job.id, output.task_id, status)
        const ticket = sealTicket({ v: 2, uid: identity.userId, job: job.id }, keys[0]!)
        sendJson(res, 202, { ticket, status, provider: 'scnet-doc-parsing' }, requestId)
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
      if (ticket.v === 1) {
        sendErr(
          res,
          410,
          'OCR_LEGACY_JOB_UNAVAILABLE',
          'this job belongs to the retired OCR worker and is no longer available',
          requestId,
        )
        return
      }
      let job = await deps.store.get(identity.userId, ticket.job)
      if (!job) {
        sendErr(res, 410, 'OCR_JOB_EXPIRED', 'OCR job is no longer available', requestId)
        return
      }
      if (job.expiresAt && job.expiresAt.getTime() <= now()) {
        sendErr(res, 410, 'OCR_JOB_EXPIRED', 'OCR job result has expired', requestId)
        return
      }

      if (requestPath === `${OCR_PREFIX}status`) {
        if (!['completed', 'failed', 'cancelled'].includes(job.status)) {
          if (!apiKey || !resultDir) {
            sendErr(res, 503, 'OCR_NOT_CONFIGURED', 'SCNet OCR is not configured', requestId)
            return
          }
          await refresh(job)
          job = (await deps.store.get(identity.userId, ticket.job)) ?? job
        }
        sendJson(res, 200, publicStatus(String(body.ticket), job), requestId)
        return
      }

      if (requestPath === `${OCR_PREFIX}cancel`) {
        job = (await deps.store.cancel(identity.userId, ticket.job)) ?? job
        sendJson(res, 200, publicStatus(String(body.ticket), job), requestId)
        return
      }

      if (requestPath === `${OCR_PREFIX}result`) {
        if (job.status !== 'completed') {
          sendErr(res, 409, 'OCR_RESULT_NOT_READY', `OCR job is ${job.status}`, requestId)
          return
        }
        const format = body?.format === 'jsonl' ? 'jsonl' : 'markdown'
        const resultPath = format === 'jsonl' ? job.jsonlPath : job.markdownPath
        if (!resultPath) {
          sendErr(res, 500, 'OCR_RESULT_CORRUPT', 'OCR result metadata is incomplete', requestId)
          return
        }
        let resultStat: Stats
        try {
          resultStat = await stat(resultPath)
        } catch {
          sendErr(res, 500, 'OCR_RESULT_CORRUPT', 'OCR result file is missing', requestId)
          return
        }
        res.writeHead(200, {
          'content-type':
            format === 'jsonl' ? 'application/x-ndjson' : 'text/markdown; charset=utf-8',
          'content-length': String(resultStat.size),
          'cache-control': 'no-store',
          [REQUEST_ID_HEADER]: requestId,
        })
        await pipeline(createReadStream(resultPath), res)
        return
      }

      sendErr(res, 404, 'NOT_FOUND', 'unknown OCR operation', requestId)
    } catch (error) {
      if (error instanceof ProviderError) {
        sendErr(res, error.status, 'OCR_PROVIDER_ERROR', error.message, requestId, {
          provider_code: error.code,
        })
        return
      }
      if (error instanceof ScnetResultHttpError) {
        sendErr(res, 502, 'OCR_RESULT_DOWNLOAD_FAILED', error.message, requestId)
        return
      }
      sendErr(res, 502, 'OCR_PROVIDER_ERROR', 'SCNet OCR request failed', requestId)
    }
  }
}
