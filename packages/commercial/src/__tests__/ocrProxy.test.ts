import assert from 'node:assert/strict'
import { createCipheriv, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { type Server, createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, test } from 'node:test'

import { hashSecret } from '../auth/containerIdentity.js'
import { makeOcrProxyHandler } from '../ocr/ocrProxy.js'
import type {
  CompleteOcrJobInput,
  CreateOcrJobInput,
  ExpiredOcrArtifact,
  OcrJob,
  OcrJobStatus,
  OcrJobStore,
} from '../ocr/ocrStore.js'
import type { ScnetFileUploadInput } from '../ocr/scnetFileUpload.js'
import { ScnetResultHttpError } from '../ocr/scnetResultDownload.js'

const SECRET = 'a1'.repeat(32)
const AUTH = `Bearer oc-v3.7.${SECRET}`
const KEY_BYTES = randomBytes(32)
const KEYS = `k1:${KEY_BYTES.toString('base64')}`
const ctx = { hostUuid: 'host', boundIp: '10.0.0.1' }
const servers: Server[] = []
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))),
  )
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true })))
})

function repo(userId = 42): any {
  return {
    findActiveByHostAndBoundIp: async () => ({
      id: 7,
      user_id: userId,
      bound_ip: ctx.boundIp,
      host_uuid: ctx.hostUuid,
      secret_hash: hashSecret(SECRET),
    }),
  }
}

class MemoryOcrStore implements OcrJobStore {
  readonly jobs = new Map<string, OcrJob>()

  async create(input: CreateOcrJobInput): Promise<OcrJob> {
    const timestamp = new Date()
    const job: OcrJob = {
      id: input.id,
      userId: input.userId,
      providerTaskId: null,
      status: 'submitting',
      phase: 'submitting',
      filename: input.filename,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      pagesTotal: null,
      markdownPath: null,
      jsonlPath: null,
      errorCode: null,
      errorMessage: null,
      cancelRequestedAt: null,
      expiresAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    this.jobs.set(job.id, job)
    return job
  }

  async get(userId: number, id: string): Promise<OcrJob | null> {
    const job = this.jobs.get(id)
    return job?.userId === userId ? job : null
  }

  async markSubmitted(
    userId: number,
    id: string,
    providerTaskId: string,
    status: OcrJobStatus,
  ): Promise<void> {
    const job = await this.get(userId, id)
    if (job?.status === 'submitting') Object.assign(job, { providerTaskId, status, phase: status })
  }

  async markProgress(
    userId: number,
    id: string,
    status: 'queued' | 'running',
    phase: string,
  ): Promise<void> {
    const job = await this.get(userId, id)
    if (job && ['queued', 'running'].includes(job.status)) Object.assign(job, { status, phase })
  }

  async markCompleted(input: CompleteOcrJobInput): Promise<boolean> {
    const job = await this.get(input.userId, input.id)
    if (!job || !['queued', 'running'].includes(job.status) || job.cancelRequestedAt) return false
    Object.assign(job, {
      status: 'completed',
      phase: 'completed',
      pagesTotal: input.pagesTotal,
      markdownPath: input.markdownPath,
      jsonlPath: input.jsonlPath,
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
    })
    return true
  }

  async markFailed(userId: number, id: string, code: string, message: string): Promise<void> {
    const job = await this.get(userId, id)
    if (job && !job.cancelRequestedAt && ['submitting', 'queued', 'running'].includes(job.status)) {
      Object.assign(job, {
        status: 'failed',
        phase: 'failed',
        errorCode: code,
        errorMessage: message,
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
      })
    }
  }

  async cancel(userId: number, id: string): Promise<OcrJob | null> {
    const job = await this.get(userId, id)
    if (job && !['completed', 'failed'].includes(job.status)) {
      Object.assign(job, {
        status: 'cancelled',
        phase: 'cancelled',
        cancelRequestedAt: new Date(),
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
      })
    }
    return job
  }

  async listExpired(_limit: number): Promise<ExpiredOcrArtifact[]> {
    return []
  }

  async deleteExpired(userId: number, id: string): Promise<void> {
    const job = await this.get(userId, id)
    if (job?.expiresAt && job.expiresAt.getTime() <= Date.now()) this.jobs.delete(id)
  }
}

async function resultDir(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'oc-scnet-ocr-'))
  tempDirs.push(directory)
  return directory
}

async function listen(handler: ReturnType<typeof makeOcrProxyHandler>): Promise<string> {
  const server = createServer((req, res) => void handler(req, res, ctx))
  servers.push(server)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return `http://127.0.0.1:${address.port}`
}

async function post(
  base: string,
  route: string,
  body: BodyInit,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(`${base}${route}`, {
    method: 'POST',
    headers: { authorization: AUTH, ...headers },
    body,
    signal,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' })
}

async function submit(base: string, bytes = Buffer.from('stream-me')): Promise<string> {
  const response = await post(base, '/v3/ocr/submit', bytes, {
    'content-type': 'application/pdf',
    'content-length': String(bytes.length),
    'x-ocr-filename': 'scan.pdf',
    'x-ocr-mode': 'hybrid',
    'x-ocr-fallback': '0.1',
  })
  assert.equal(response.status, 202)
  return String(((await response.json()) as any).ticket)
}

function taskResponse(
  taskId: string,
  status: string,
  urls: string[] = [],
  pages?: number,
): Response {
  return Response.json({
    code: '0',
    data: [
      {
        output: { task_id: taskId, task_status: status, results: urls },
        ...(pages === undefined ? {} : { usage: { image_count: pages } }),
      },
    ],
  })
}

function presignResponse(): Response {
  return Response.json({
    code: '0',
    msg: 'success',
    data: {
      upload_url: 'https://uploads.example:58003/llm',
      file_url: 'https://uploads.example:58003/llm/uploads/job.pdf?signature=x',
      policy: 'policy-value',
      x_amz_algorithm: 'AWS4-HMAC-SHA256',
      x_amz_credential: 'credential-value',
      x_amz_date: '20260811T000000Z',
      x_amz_signature: 'signature-value',
      key: '/uploads/job.pdf',
    },
  })
}

async function consumeUpload(input: ScnetFileUploadInput): Promise<void> {
  for await (const _chunk of input.source) {
    // Consume the single-pass client stream like the real object-store upload.
  }
}

function legacyTicket(userId: number, job: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', KEY_BYTES, iv)
  cipher.setAAD(Buffer.from('k1'))
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify({ v: 1, uid: userId, job })),
    cipher.final(),
  ])
  return [
    'k1',
    iv.toString('base64url'),
    encrypted.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
  ].join('.')
}

describe('ocrProxy SCNet adapter', () => {
  test('fails closed when SCNet configuration is absent', async () => {
    const base = await listen(
      makeOcrProxyHandler({
        identityRepo: repo(),
        store: new MemoryOcrStore(),
        apiKey: '',
        ticketKeys: KEYS,
        resultDir: '',
      }),
    )
    const response = await post(base, '/v3/ocr/submit', Buffer.from('x'), {
      'content-length': '1',
    })
    assert.equal(response.status, 503)
  })

  test('presigns and uploads once, then mirrors all pages as complete Markdown and JSONL', async () => {
    const uploaded: Buffer[] = []
    let polls = 0
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const target = new URL(String(url))
      const pathname = target.pathname
      assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer provider-key')
      if (pathname.endsWith('/upload/presign')) {
        assert.equal(init?.method, 'GET')
        assert.match(target.searchParams.get('file_name') ?? '', /^[0-9a-f-]{36}\.pdf$/)
        return presignResponse()
      }
      if (pathname.endsWith('/ocrdoc/submit')) {
        assert.equal(
          (init?.headers as Record<string, string>)['content-type'],
          'application/x-www-form-urlencoded',
        )
        const form = new URLSearchParams(String(init?.body))
        assert.equal(
          form.get('file_url'),
          'https://uploads.example:58003/llm/uploads/job.pdf?signature=x',
        )
        assert.equal(form.get('ocr_type'), 'DOC_PARING')
        assert.equal(form.get('is_table_cls'), 'true')
        assert.equal(form.get('is_doc_ori'), 'true')
        assert.equal(form.get('is_inline_formula'), 'true')
        return Response.json({
          code: '0',
          data: { output: { task_id: 'task-secret', task_status: 'pending' } },
        })
      }
      polls += 1
      return polls === 1
        ? taskResponse('task-secret', 'running')
        : taskResponse(
            'task-secret',
            'succeeded',
            ['https://result.example/a', 'https://result.example/b'],
            3,
          )
    }) as typeof fetch
    const store = new MemoryOcrStore()
    const base = await listen(
      makeOcrProxyHandler({
        identityRepo: repo(),
        store,
        fetchImpl,
        apiKey: 'provider-key',
        ticketKeys: KEYS,
        resultDir: await resultDir(),
        uploadFile: async (input) => {
          assert.equal(input.filename, 'scan.pdf')
          assert.equal(input.contentType, 'application/pdf')
          assert.equal(input.contentLength, 9n)
          for await (const chunk of input.source) uploaded.push(Buffer.from(chunk))
        },
        downloadResult: async (url) =>
          url.endsWith('/a')
            ? {
                taskId: 'task-secret',
                documents: [
                  {
                    documentId: 'd1',
                    fileName: 'a.pdf',
                    datas: [
                      {
                        rotate_angle: 0,
                        blocks: [{ type: 'text' }],
                        md: { markdown_content: '第一页' },
                      },
                      {
                        rotate_angle: 0,
                        blocks: [{ type: 'table', html: '<table><tr><td>A</td></tr></table>' }],
                        md: { markdown_content: '<table><tr><td>A</td></tr></table>' },
                      },
                    ],
                  },
                ],
              }
            : {
                taskId: 'task-secret',
                documents: [
                  {
                    documentId: 'd2',
                    fileName: 'b.pdf',
                    datas: [
                      {
                        rotate_angle: 0,
                        blocks: [{ type: 'formula' }],
                        md: { markdown_content: '$$x^2$$' },
                      },
                    ],
                  },
                ],
              },
      }),
    )
    const ticket = await submit(base)
    assert.equal(Buffer.concat(uploaded).toString('utf8'), 'stream-me')
    assert.equal(ticket.includes('task-secret'), false)

    let response = await post(base, '/v3/ocr/status', JSON.stringify({ ticket }), {
      'content-type': 'application/json',
    })
    assert.equal(((await response.json()) as any).status, 'running')
    response = await post(base, '/v3/ocr/status', JSON.stringify({ ticket }), {
      'content-type': 'application/json',
    })
    const completed = (await response.json()) as any
    assert.equal(completed.status, 'completed')
    assert.equal(completed.pages_total, 3)

    response = await post(base, '/v3/ocr/result', JSON.stringify({ ticket, format: 'markdown' }), {
      'content-type': 'application/json',
    })
    const markdown = await response.text()
    assert.match(markdown, /第一页/)
    assert.match(markdown, /<table><tr><td>A<\/td><\/tr><\/table>/)
    assert.match(markdown, /\$\$x\^2\$\$/)
    assert.ok(markdown.indexOf('第一页') < markdown.indexOf('<table>'))
    assert.ok(markdown.indexOf('<table>') < markdown.indexOf('$$x^2$$'))

    response = await post(base, '/v3/ocr/result', JSON.stringify({ ticket, format: 'jsonl' }), {
      'content-type': 'application/json',
    })
    const pages = (await response.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.deepEqual(
      pages.map((page) => page.page),
      [1, 2, 3],
    )
    assert.equal(pages[1].raw.blocks[0].type, 'table')
    assert.equal(pages[2].provider_document_id, 'd2')
  })

  test('persists local cancellation and never revives a cancelled job', async () => {
    let resultPolls = 0
    const store = new MemoryOcrStore()
    const fetchImpl = (async (url: string | URL | Request) => {
      const pathname = new URL(String(url)).pathname
      if (pathname.endsWith('/upload/presign')) return presignResponse()
      if (pathname.endsWith('/submit')) {
        return Response.json({
          code: '0',
          data: { output: { task_id: 'task-cancel', task_status: 'pending' } },
        })
      }
      resultPolls += 1
      return taskResponse('task-cancel', 'succeeded', ['https://result.example/c'], 1)
    }) as typeof fetch
    const base = await listen(
      makeOcrProxyHandler({
        identityRepo: repo(),
        store,
        fetchImpl,
        apiKey: 'provider-key',
        ticketKeys: KEYS,
        resultDir: await resultDir(),
        uploadFile: consumeUpload,
      }),
    )
    const ticket = await submit(base)
    let response = await post(base, '/v3/ocr/cancel', JSON.stringify({ ticket }), {
      'content-type': 'application/json',
    })
    assert.equal(((await response.json()) as any).status, 'cancelled')
    response = await post(base, '/v3/ocr/status', JSON.stringify({ ticket }), {
      'content-type': 'application/json',
    })
    assert.equal(((await response.json()) as any).status, 'cancelled')
    assert.equal(resultPolls, 0)
  })

  test('fails loudly on the reproduced empty rotated page', async () => {
    const fetchImpl = (async (url: string | URL | Request) => {
      const pathname = new URL(String(url)).pathname
      if (pathname.endsWith('/upload/presign')) return presignResponse()
      return pathname.endsWith('/submit')
        ? Response.json({
            code: '0',
            data: { output: { task_id: 'task-rotate', task_status: 'pending' } },
          })
        : taskResponse('task-rotate', 'succeeded', ['https://result.example/rotate'], 1)
    }) as typeof fetch
    const base = await listen(
      makeOcrProxyHandler({
        identityRepo: repo(),
        store: new MemoryOcrStore(),
        fetchImpl,
        apiKey: 'provider-key',
        ticketKeys: KEYS,
        resultDir: await resultDir(),
        uploadFile: consumeUpload,
        downloadResult: async () => ({
          documents: [
            {
              datas: [
                {
                  rotate_angle: -90,
                  blocks: [{ type: 'text', lines: [] }],
                  md: { markdown_content: '' },
                },
              ],
            },
          ],
        }),
      }),
    )
    const ticket = await submit(base)
    const response = await post(base, '/v3/ocr/status', JSON.stringify({ ticket }), {
      'content-type': 'application/json',
    })
    const value = (await response.json()) as any
    assert.equal(value.status, 'failed')
    assert.equal(value.error_code, 'SCNET_EMPTY_ROTATED_PAGE')
  })

  test('keeps provider result download errors retryable', async () => {
    const store = new MemoryOcrStore()
    const fetchImpl = (async (url: string | URL | Request) => {
      const pathname = new URL(String(url)).pathname
      if (pathname.endsWith('/upload/presign')) return presignResponse()
      return pathname.endsWith('/submit')
        ? Response.json({
            code: '0',
            data: { output: { task_id: 'task-retry', task_status: 'pending' } },
          })
        : taskResponse('task-retry', 'succeeded', ['https://result.example/retry'], 1)
    }) as typeof fetch
    const base = await listen(
      makeOcrProxyHandler({
        identityRepo: repo(),
        store,
        fetchImpl,
        apiKey: 'provider-key',
        ticketKeys: KEYS,
        resultDir: await resultDir(),
        uploadFile: consumeUpload,
        downloadResult: async () => {
          throw new ScnetResultHttpError(503, 'temporary result host failure')
        },
      }),
    )
    const ticket = await submit(base)
    const response = await post(base, '/v3/ocr/status', JSON.stringify({ ticket }), {
      'content-type': 'application/json',
    })
    assert.equal(response.status, 502)
    assert.equal([...store.jobs.values()][0]?.status, 'queued')
  })

  test('client disconnect does not cancel in-progress result materialization', async () => {
    const store = new MemoryOcrStore()
    const fetchImpl = (async (url: string | URL | Request) => {
      const pathname = new URL(String(url)).pathname
      if (pathname.endsWith('/upload/presign')) return presignResponse()
      return pathname.endsWith('/submit')
        ? Response.json({
            code: '0',
            data: { output: { task_id: 'task-slow', task_status: 'pending' } },
          })
        : taskResponse('task-slow', 'succeeded', ['https://result.example/slow'], 1)
    }) as typeof fetch
    const base = await listen(
      makeOcrProxyHandler({
        identityRepo: repo(),
        store,
        fetchImpl,
        apiKey: 'provider-key',
        ticketKeys: KEYS,
        resultDir: await resultDir(),
        uploadFile: consumeUpload,
        downloadResult: async () => {
          await new Promise((done) => setTimeout(done, 80))
          return {
            documents: [
              {
                datas: [
                  { rotate_angle: 0, blocks: [{ type: 'text' }], md: { markdown_content: 'done' } },
                ],
              },
            ],
          }
        },
      }),
    )
    const ticket = await submit(base)
    const controller = new AbortController()
    const pending = post(
      base,
      '/v3/ocr/status',
      JSON.stringify({ ticket }),
      { 'content-type': 'application/json' },
      controller.signal,
    )
    setTimeout(() => controller.abort(), 10)
    await assert.rejects(pending)
    await new Promise((done) => setTimeout(done, 120))
    const response = await post(base, '/v3/ocr/status', JSON.stringify({ ticket }), {
      'content-type': 'application/json',
    })
    assert.equal(((await response.json()) as any).status, 'completed')
  })

  test('rejects tampered/cross-tenant tickets and expires legacy worker tickets explicitly', async () => {
    const fetchImpl = (async (url: string | URL | Request) =>
      new URL(String(url)).pathname.endsWith('/upload/presign')
        ? presignResponse()
        : Response.json({
            code: '0',
            data: { output: { task_id: 'task-ticket', task_status: 'pending' } },
          })) as typeof fetch
    const store = new MemoryOcrStore()
    const shared = {
      store,
      fetchImpl,
      apiKey: 'provider-key',
      ticketKeys: KEYS,
      resultDir: await resultDir(),
      uploadFile: consumeUpload,
    }
    const base = await listen(makeOcrProxyHandler({ ...shared, identityRepo: repo(42) }))
    const ticket = await submit(base)
    const parts = ticket.split('.')
    parts[2] = `${parts[2]![0] === 'A' ? 'B' : 'A'}${parts[2]!.slice(1)}`
    let response = await post(base, '/v3/ocr/status', JSON.stringify({ ticket: parts.join('.') }), {
      'content-type': 'application/json',
    })
    assert.equal(response.status, 403)
    const other = await listen(makeOcrProxyHandler({ ...shared, identityRepo: repo(43) }))
    response = await post(other, '/v3/ocr/status', JSON.stringify({ ticket }), {
      'content-type': 'application/json',
    })
    assert.equal(response.status, 403)
    response = await post(
      base,
      '/v3/ocr/status',
      JSON.stringify({ ticket: legacyTicket(42, 'old') }),
      {
        'content-type': 'application/json',
      },
    )
    assert.equal(response.status, 410)
    assert.equal(((await response.json()) as any).error.code, 'OCR_LEGACY_JOB_UNAVAILABLE')
  })

  test('provider submit rejection is explicit and terminal locally', async () => {
    const store = new MemoryOcrStore()
    const base = await listen(
      makeOcrProxyHandler({
        identityRepo: repo(),
        store,
        fetchImpl: (async (url: string | URL | Request) =>
          new URL(String(url)).pathname.endsWith('/upload/presign')
            ? presignResponse()
            : Response.json({
                code: '10011',
                msg: 'Burst rate limit exceeded for model',
              })) as typeof fetch,
        apiKey: 'provider-key',
        ticketKeys: KEYS,
        resultDir: await resultDir(),
        uploadFile: consumeUpload,
      }),
    )
    const response = await post(base, '/v3/ocr/submit', Buffer.from('x'), {
      'content-length': '1',
    })
    assert.equal(response.status, 429)
    assert.equal([...store.jobs.values()][0]?.status, 'failed')
  })
})
