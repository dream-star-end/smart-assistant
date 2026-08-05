/** Container-side transport for the V5 async OCR service. */
import { createReadStream, createWriteStream, renameSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import {
  CONNECTOR_NO_CONTAINER_TOKEN,
  CONNECTOR_NO_MASTER_BASE,
  ConnectorError,
  resolveConnectorEndpoint,
} from './ocConnectorsClient.js'

export type OcrMode = 'pp' | 'hybrid' | 'vl'
export type OcrFormat = 'markdown' | 'jsonl'

function endpoint(): { masterBaseUrl: string; containerToken: string } {
  try {
    return resolveConnectorEndpoint()
  } catch (err) {
    if (err instanceof ConnectorError) {
      if (err.code === CONNECTOR_NO_MASTER_BASE)
        throw new Error('not in a commercial container (no master base url)')
      if (err.code === CONNECTOR_NO_CONTAINER_TOKEN)
        throw new Error('not in a commercial container (no container token)')
    }
    throw err
  }
}

async function parseResponse(response: Response): Promise<any> {
  const text = await response.text()
  let value: any = {}
  try {
    value = text ? JSON.parse(text) : {}
  } catch {
    value = { raw: text }
  }
  if (!response.ok) {
    const error = value?.error
    throw new Error(`${response.status} ${error?.code ?? ''} ${error?.message ?? text}`.trim())
  }
  return value
}

function mimeFor(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith('.pdf')) return 'application/pdf'
  if (/\.(?:png|jpg|jpeg|webp|tif|tiff|bmp)$/.test(lower)) return `image/${lower.split('.').pop()}`
  return 'application/octet-stream'
}

export async function submitOcr(
  file: string,
  options: { mode: OcrMode; fallback: number },
): Promise<any> {
  const ep = endpoint()
  const size = statSync(file).size
  const response = await fetch(`${ep.masterBaseUrl}/v3/ocr/submit`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${ep.containerToken}`,
      'content-type': mimeFor(file),
      'content-length': String(size),
      'x-ocr-filename': basename(file),
      'x-ocr-mode': options.mode,
      'x-ocr-fallback': String(options.fallback),
    },
    body: createReadStream(file) as unknown as BodyInit,
    duplex: 'half',
    signal: AbortSignal.timeout(60 * 60_000),
  } as RequestInit & { duplex: 'half' })
  return parseResponse(response)
}

async function jobJson(operation: 'status' | 'cancel', ticket: string): Promise<any> {
  const ep = endpoint()
  const response = await fetch(`${ep.masterBaseUrl}/v3/ocr/${operation}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${ep.containerToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ ticket }),
    signal: AbortSignal.timeout(30_000),
  })
  return parseResponse(response)
}

export const statusOcr = (ticket: string): Promise<any> => jobJson('status', ticket)
export const cancelOcr = (ticket: string): Promise<any> => jobJson('cancel', ticket)

export async function downloadOcr(
  ticket: string,
  format: OcrFormat,
  output: string,
): Promise<void> {
  const ep = endpoint()
  const response = await fetch(`${ep.masterBaseUrl}/v3/ocr/result`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${ep.containerToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ ticket, format }),
    signal: AbortSignal.timeout(60 * 60_000),
  })
  if (!response.ok) await parseResponse(response)
  if (!response.body) throw new Error('OCR result response has no body')
  const temp = join(dirname(output), `.${basename(output)}.${process.pid}.${Date.now()}.tmp`)
  try {
    await pipeline(Readable.fromWeb(response.body as any), createWriteStream(temp, { mode: 0o600 }))
    renameSync(temp, output)
  } catch (err) {
    rmSync(temp, { force: true })
    throw err
  }
}
