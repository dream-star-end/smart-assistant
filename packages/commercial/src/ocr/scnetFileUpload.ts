import { randomBytes } from 'node:crypto'
import type { Readable } from 'node:stream'
import { Readable as NodeReadable } from 'node:stream'
import { type Dispatcher, fetch as undiciFetch } from 'undici'

import {
  type DnsResolver,
  type PinnedAddress,
  makePinnedDispatcher,
  resolvePinnedAddress,
} from '../connectors/outboundPolicy.js'

export interface ScnetUploadCredential {
  uploadUrl: string
  fileUrl: string
  policy: string
  algorithm: string
  credential: string
  date: string
  signature: string
  key: string
}

export interface ScnetFileUploadInput {
  credential: ScnetUploadCredential
  source: Readable
  filename: string
  contentType: string
  contentLength: bigint
}

interface CloseableDispatcher extends Dispatcher {
  close(): Promise<void>
}

export interface ScnetFileUploadDeps {
  resolver?: DnsResolver
  fetchImpl?: (input: string, init: Record<string, unknown>) => Promise<Response>
  makeDispatcher?: (pin: PinnedAddress) => CloseableDispatcher
}

export class ScnetUploadHttpError extends Error {
  constructor(readonly status: number) {
    super(`SCNet file upload returned HTTP ${status}`)
  }
}

export class ScnetUploadShapeError extends Error {}

function httpsUrl(raw: string, label: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ScnetUploadShapeError(`SCNet ${label} URL is invalid`)
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new ScnetUploadShapeError(`SCNet ${label} URL violates the HTTPS-only contract`)
  }
  return url
}

export function validateScnetUploadCredential(value: unknown): ScnetUploadCredential {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ScnetUploadShapeError('SCNet upload credential is missing')
  }
  const raw = value as Record<string, unknown>
  const required = [
    'upload_url',
    'file_url',
    'policy',
    'x_amz_algorithm',
    'x_amz_credential',
    'x_amz_date',
    'x_amz_signature',
    'key',
  ] as const
  for (const field of required) {
    if (typeof raw[field] !== 'string' || raw[field].length === 0) {
      throw new ScnetUploadShapeError(`SCNet upload credential is missing ${field}`)
    }
  }
  httpsUrl(raw.upload_url as string, 'upload')
  httpsUrl(raw.file_url as string, 'file')
  return {
    uploadUrl: raw.upload_url as string,
    fileUrl: raw.file_url as string,
    policy: raw.policy as string,
    algorithm: raw.x_amz_algorithm as string,
    credential: raw.x_amz_credential as string,
    date: raw.x_amz_date as string,
    signature: raw.x_amz_signature as string,
    key: raw.key as string,
  }
}

function multipart(input: ScnetFileUploadInput): {
  body: Readable
  contentType: string
  contentLength: string
} {
  const boundary = `oc-${randomBytes(18).toString('hex')}`
  const fields = [
    ['policy', input.credential.policy],
    ['x-amz-algorithm', input.credential.algorithm],
    ['x-amz-credential', input.credential.credential],
    ['x-amz-date', input.credential.date],
    ['x-amz-signature', input.credential.signature],
    ['key', input.credential.key],
  ]
  let prefix = ''
  for (const [name, value] of fields) {
    prefix += `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
  }
  prefix += `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${input.filename.replace(/"/g, '_')}"\r\nContent-Type: ${input.contentType}\r\n\r\n`
  const suffix = `\r\n--${boundary}--\r\n`
  const prefixBytes = Buffer.from(prefix)
  const suffixBytes = Buffer.from(suffix)
  return {
    body: NodeReadable.from(
      (async function* () {
        yield prefixBytes
        for await (const chunk of input.source) yield Buffer.from(chunk)
        yield suffixBytes
      })(),
    ),
    contentType: `multipart/form-data; boundary=${boundary}`,
    contentLength: (
      BigInt(prefixBytes.length) +
      input.contentLength +
      BigInt(suffixBytes.length)
    ).toString(),
  }
}

/**
 * Stream a user file to SCNet's provider-owned object store without trusting
 * provider-returned DNS. There is no total transfer timer; the one-shot pinned
 * dispatcher remains alive through the complete response body.
 */
export async function uploadScnetFile(
  input: ScnetFileUploadInput,
  deps: ScnetFileUploadDeps = {},
): Promise<void> {
  const url = httpsUrl(input.credential.uploadUrl, 'upload')
  const pin = await resolvePinnedAddress(url.hostname, deps.resolver)
  const dispatcher = (deps.makeDispatcher ?? makePinnedDispatcher)(pin) as CloseableDispatcher
  const fetchImpl =
    deps.fetchImpl ??
    ((target: string, init: Record<string, unknown>) =>
      undiciFetch(target, init as never) as unknown as Promise<Response>)
  const upload = multipart(input)
  try {
    const response = await fetchImpl(url.toString(), {
      method: 'POST',
      headers: {
        'content-type': upload.contentType,
        'content-length': upload.contentLength,
      },
      body: upload.body,
      duplex: 'half',
      redirect: 'error',
      dispatcher,
    })
    await response.text()
    if (response.status !== 200 && response.status !== 204) {
      throw new ScnetUploadHttpError(response.status)
    }
  } finally {
    await dispatcher.close()
  }
}
