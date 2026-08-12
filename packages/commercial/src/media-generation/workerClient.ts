import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Dispatcher } from 'undici'
import { directEgressDispatcher } from '../account-pool/egressDispatcher.js'
import type { MediaInputRow, MediaJobRow } from './store.js'

export interface WorkerStatus {
  job_id: string
  attempt_id: string
  fence_version: number
  /** Immutable worker release that created this attempt/tombstone. */
  origin_release: string
  resource_class: 'gpu-h3' | 'cpu-compose'
  status: 'staging' | 'queued' | 'running' | 'completed' | 'failed' | 'canceled'
  phase: string
  request_digest: string | null
  current_step: number | null
  total_steps: number | null
  result_sha256: string | null
  result_size: number | null
  error_code: string | null
  error_message: string | null
  recovery_disposition: 'unknown' | 'definitive_retry_safe'
  cleanup_proven: boolean | number
  result_ready: boolean
}

export type WorkerUpload = Pick<
  MediaInputRow,
  'storagePath' | 'sha256' | 'sizeBytes' | 'mime' | 'kind' | 'workerFilename'
>

const WORKER_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024

export class MediaWorkerHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code)
    this.name = 'MediaWorkerHttpError'
  }
}

export class MediaWorkerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private url(job: MediaJobRow, action: string): string {
    return `${this.baseUrl}/v1/attempts/${encodeURIComponent(job.id)}/${encodeURIComponent(job.attemptId!)}/${action}`
  }

  private headers(job?: MediaJobRow): Record<string, string> {
    return {
      authorization: `Bearer ${this.token}`,
      ...(job ? { 'x-fence-version': String(job.fenceVersion) } : {}),
    }
  }

  private request(url: string, init: RequestInit = {}): Promise<Response> {
    return fetch(url, {
      ...init,
      dispatcher: directEgressDispatcher(),
    } as RequestInit & { dispatcher: Dispatcher })
  }

  private signal(timeoutMs: number, external?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(timeoutMs)
    return external ? AbortSignal.any([external, timeout]) : timeout
  }

  private async checked(response: Response): Promise<Response> {
    if (response.ok) return response
    let code = `worker_http_${response.status}`
    let message = code
    try {
      const body = (await response.json()) as { error?: unknown; detail?: unknown }
      if (typeof body.error === 'string') code = body.error
      if (typeof body.detail === 'string') message = body.detail
      else message = code
    } catch {
      // The status is still authoritative when a tunnel closes mid-response.
    }
    throw new MediaWorkerHttpError(response.status, code, message)
  }

  async health(): Promise<unknown> {
    const response = await this.request(`${this.baseUrl}/v1/health`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(10_000),
    })
    return this.checked(response).then((value) => value.json())
  }

  async capabilities(): Promise<unknown> {
    const response = await this.request(`${this.baseUrl}/v1/capabilities`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(10_000),
    })
    return this.checked(response).then((value) => value.json())
  }

  async upload(
    job: MediaJobRow,
    ordinal: number,
    input: WorkerUpload,
    external?: AbortSignal,
  ): Promise<void> {
    let offset = 0
    do {
      const chunkSize = Math.min(WORKER_UPLOAD_CHUNK_BYTES, input.sizeBytes - offset)
      const body =
        chunkSize === 0
          ? Buffer.alloc(0)
          : createReadStream(input.storagePath, {
              start: offset,
              end: offset + chunkSize - 1,
            })
      const response = await this.request(this.url(job, `inputs/${ordinal}`), {
        method: 'PUT',
        headers: {
          ...this.headers(job),
          'content-length': String(chunkSize),
          'content-type': input.mime,
          'x-content-sha256': input.sha256,
          'x-content-size': String(input.sizeBytes),
          'x-input-kind': input.kind,
          'x-input-filename': input.workerFilename,
          'x-upload-offset': String(offset),
        },
        body: body as unknown as BodyInit,
        duplex: 'half',
        signal: this.signal(30 * 60_000, external),
      } as RequestInit & { duplex: 'half' })
      await this.checked(response)
      offset += chunkSize
    } while (offset < input.sizeBytes)
  }

  async submit(
    job: MediaJobRow,
    request: Record<string, unknown>,
    external?: AbortSignal,
  ): Promise<WorkerStatus> {
    const response = await this.request(this.url(job, 'submit'), {
      method: 'POST',
      headers: { ...this.headers(job), 'content-type': 'application/json' },
      body: JSON.stringify({
        fence_version: job.fenceVersion,
        resource_class: job.resourceClass,
        request,
      }),
      signal: this.signal(30_000, external),
    })
    return this.checked(response).then((value) => value.json() as Promise<WorkerStatus>)
  }

  async status(job: MediaJobRow, external?: AbortSignal): Promise<WorkerStatus> {
    const response = await this.request(this.url(job, 'status'), {
      headers: this.headers(job),
      signal: this.signal(15_000, external),
    })
    return this.checked(response).then((value) => value.json() as Promise<WorkerStatus>)
  }

  async cancel(job: MediaJobRow, external?: AbortSignal): Promise<WorkerStatus> {
    const response = await this.request(this.url(job, 'cancel'), {
      method: 'POST',
      headers: { ...this.headers(job), 'content-type': 'application/json' },
      body: JSON.stringify({ resource_class: job.resourceClass }),
      signal: this.signal(30_000, external),
    })
    return this.checked(response).then((value) => value.json() as Promise<WorkerStatus>)
  }

  async download(
    job: MediaJobRow,
    target: string,
    external?: AbortSignal,
  ): Promise<{ sha256: string; size: number }> {
    const response = await this.request(this.url(job, 'result'), {
      headers: this.headers(job),
      signal: this.signal(30 * 60_000, external),
    })
    await this.checked(response)
    if (!response.body) throw new Error('worker_result_body_missing')
    const sha256 = response.headers.get('x-content-sha256')
    const size = Number(response.headers.get('content-length'))
    if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256) || !Number.isSafeInteger(size) || size < 0) {
      throw new Error('worker_result_metadata_invalid')
    }
    await mkdir(dirname(target), { recursive: true })
    const temporary = `${target}.part`
    await rm(temporary, { force: true })
    await pipeline(
      Readable.fromWeb(response.body as never),
      createWriteStream(temporary, { flags: 'wx' }),
    )
    await rename(temporary, target)
    return { sha256, size }
  }

  async ack(job: MediaJobRow, external?: AbortSignal): Promise<void> {
    const response = await this.request(this.url(job, 'ack'), {
      method: 'POST',
      headers: { ...this.headers(job), 'content-type': 'application/json' },
      body: '{}',
      signal: this.signal(30_000, external),
    })
    await this.checked(response)
  }
}
