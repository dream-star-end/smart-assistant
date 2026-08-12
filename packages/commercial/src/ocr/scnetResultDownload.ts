import { randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { type Dispatcher, fetch as undiciFetch } from 'undici'

import {
  type DnsResolver,
  type PinnedAddress,
  makePinnedDispatcher,
  resolvePinnedAddress,
} from '../connectors/outboundPolicy.js'
import type { ExpiredOcrArtifact, OcrJob } from './ocrStore.js'

export const OCR_RESULT_RETENTION_MS = 7 * 24 * 60 * 60_000

export class ScnetResultHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export class ScnetResultShapeError extends Error {}
export class ScnetRotatedEmptyPageError extends Error {}

interface CloseableDispatcher extends Dispatcher {
  close(): Promise<void>
}

export interface ScnetResultDownloadDeps {
  resolver?: DnsResolver
  fetchImpl?: (input: string, init: Record<string, unknown>) => Promise<Response>
  makeDispatcher?: (pin: PinnedAddress) => CloseableDispatcher
}

function resultUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ScnetResultShapeError('SCNet result URL is invalid')
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new ScnetResultShapeError('SCNet result URL violates the HTTPS-only contract')
  }
  return url
}

/**
 * Download one provider-owned result while pinning the validated public DNS
 * address. There is deliberately no total transfer timer: the dispatcher stays
 * alive until the response body has been consumed and parsed.
 */
export async function downloadScnetResultJson(
  rawUrl: string,
  deps: ScnetResultDownloadDeps = {},
): Promise<unknown> {
  const url = resultUrl(rawUrl)
  const pin = await resolvePinnedAddress(url.hostname, deps.resolver)
  const dispatcher = (deps.makeDispatcher ?? makePinnedDispatcher)(pin) as CloseableDispatcher
  const fetchImpl =
    deps.fetchImpl ??
    ((input: string, init: Record<string, unknown>) =>
      undiciFetch(input, init as never) as unknown as Promise<Response>)
  try {
    const response = await fetchImpl(url.toString(), {
      method: 'GET',
      redirect: 'error',
      dispatcher,
    })
    if (!response.ok) {
      throw new ScnetResultHttpError(
        response.status,
        `SCNet result download returned HTTP ${response.status}`,
      )
    }
    const text = await response.text()
    try {
      return JSON.parse(text)
    } catch {
      throw new ScnetResultShapeError('SCNet result is not valid JSON')
    }
  } finally {
    await dispatcher.close()
  }
}

export interface MaterializedOcrResult {
  pagesTotal: number
  markdownPath: string
  jsonlPath: string
}

export interface MaterializeScnetResultInput {
  urls: string[]
  userId: number
  jobId: string
  resultDir: string
  download?: (url: string) => Promise<unknown>
}

export interface ScnetResultGcStore {
  get(userId: number, id: string): Promise<OcrJob | null>
  listExpired(limit: number): Promise<ExpiredOcrArtifact[]>
  deleteExpired(userId: number, id: string): Promise<void>
}

function object(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ScnetResultShapeError(message)
  }
  return value as Record<string, unknown>
}

function array(value: unknown, message: string): unknown[] {
  if (!Array.isArray(value)) throw new ScnetResultShapeError(message)
  return value
}

function markdownOf(page: Record<string, unknown>): string {
  const md = page.md
  if (!md || typeof md !== 'object' || Array.isArray(md)) return ''
  const markdown = (md as Record<string, unknown>).markdown_content
  return typeof markdown === 'string' ? markdown : ''
}

function pageIsRecognized(page: Record<string, unknown>): boolean {
  if (markdownOf(page).trim()) return true
  if (!Array.isArray(page.blocks)) return false
  return page.blocks.some((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const block = value as Record<string, unknown>
    for (const key of ['text', 'html', 'latex', 'content']) {
      if (typeof block[key] === 'string' && block[key].trim()) return true
    }
    return (
      Array.isArray(block.lines) &&
      block.lines.some(
        (line) =>
          line != null &&
          typeof line === 'object' &&
          !Array.isArray(line) &&
          typeof (line as Record<string, unknown>).text === 'string' &&
          ((line as Record<string, unknown>).text as string).trim().length > 0,
      )
    )
  })
}

export async function materializeScnetResults(
  input: MaterializeScnetResultInput,
): Promise<MaterializedOcrResult> {
  if (input.urls.length === 0) throw new ScnetResultShapeError('SCNet returned no result files')
  const root = path.resolve(input.resultDir)
  const directory = path.join(root, String(input.userId), input.jobId)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const nonce = `${process.pid}-${randomUUID()}`
  const markdownTemp = path.join(directory, `.result.md.${nonce}.tmp`)
  const jsonlTemp = path.join(directory, `.result.jsonl.${nonce}.tmp`)
  const markdownPath = path.join(directory, 'result.md')
  const jsonlPath = path.join(directory, 'result.jsonl')
  const markdown = await open(markdownTemp, 'wx', 0o600)
  const jsonl = await open(jsonlTemp, 'wx', 0o600)
  let pagesTotal = 0
  try {
    const download = input.download ?? downloadScnetResultJson
    for (let resultIndex = 0; resultIndex < input.urls.length; resultIndex += 1) {
      const rawResult = object(
        await download(input.urls[resultIndex]!),
        'SCNet result root must be an object',
      )
      const documents = array(rawResult.documents, 'SCNet result documents must be an array')
      for (let documentIndex = 0; documentIndex < documents.length; documentIndex += 1) {
        const document = object(documents[documentIndex], 'SCNet document must be an object')
        const pages = array(document.datas, 'SCNet document pages must be an array')
        for (let sourcePageIndex = 0; sourcePageIndex < pages.length; sourcePageIndex += 1) {
          const page = object(pages[sourcePageIndex], 'SCNet page must be an object')
          pagesTotal += 1
          const markdownContent = markdownOf(page)
          const rotateAngle = Number(page.rotate_angle ?? 0)
          if (rotateAngle !== 0 && !pageIsRecognized(page)) {
            throw new ScnetRotatedEmptyPageError(
              `SCNet returned an empty rotated page at page ${pagesTotal} (angle ${rotateAngle})`,
            )
          }
          if (pagesTotal > 1) await markdown.write('\n\n---\n\n')
          await markdown.write(`<!-- page ${pagesTotal} -->\n\n`)
          await markdown.write(
            markdownContent || `<!-- blank page ${pagesTotal}: no recognized content -->`,
          )
          await markdown.write('\n')
          await jsonl.write(
            `${JSON.stringify({
              page: pagesTotal,
              engine: 'scnet-doc-parsing',
              result_index: resultIndex,
              document_index: documentIndex,
              source_page_index: sourcePageIndex,
              provider_document_id:
                typeof document.documentId === 'string' ? document.documentId : null,
              provider_filename: typeof document.fileName === 'string' ? document.fileName : null,
              markdown: markdownContent,
              raw: page,
            })}\n`,
          )
        }
      }
    }
    if (pagesTotal === 0) throw new ScnetResultShapeError('SCNet result contains no pages')
    await markdown.sync()
    await jsonl.sync()
    await markdown.close()
    await jsonl.close()
    await rename(markdownTemp, markdownPath)
    await rename(jsonlTemp, jsonlPath)
    return { pagesTotal, markdownPath, jsonlPath }
  } catch (error) {
    await Promise.allSettled([markdown.close(), jsonl.close()])
    await Promise.allSettled([rm(markdownTemp, { force: true }), rm(jsonlTemp, { force: true })])
    throw error
  }
}

/**
 * Drain every database-expired result and remove stale filesystem orphans left
 * after a user's ON DELETE CASCADE removed the corresponding job authority.
 */
export async function gcScnetOcrResults(input: {
  store: ScnetResultGcStore
  resultDir: string
  now?: number
}): Promise<void> {
  const root = path.resolve(input.resultDir)
  const rootPrefix = `${root}${path.sep}`
  for (;;) {
    const artifacts = await input.store.listExpired(100)
    for (const artifact of artifacts) {
      const candidate = artifact.markdownPath ?? artifact.jsonlPath
      if (candidate) {
        const directory = path.resolve(path.dirname(candidate))
        if (`${directory}${path.sep}`.startsWith(rootPrefix)) {
          await rm(directory, { recursive: true, force: true })
        }
      }
      await input.store.deleteExpired(artifact.userId, artifact.id)
    }
    if (artifacts.length < 100) break
  }

  let users: Dirent[]
  try {
    users = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const staleBefore = (input.now ?? Date.now()) - OCR_RESULT_RETENTION_MS
  for (const userEntry of users) {
    if (!userEntry.isDirectory() || !/^[1-9]\d*$/.test(userEntry.name)) continue
    const userId = Number(userEntry.name)
    if (!Number.isSafeInteger(userId)) continue
    const userDirectory = path.join(root, userEntry.name)
    const jobs = await readdir(userDirectory, { withFileTypes: true })
    for (const jobEntry of jobs) {
      if (!jobEntry.isDirectory() || !/^[A-Za-z0-9_-]{1,128}$/.test(jobEntry.name)) continue
      const directory = path.join(userDirectory, jobEntry.name)
      const metadata = await lstat(directory)
      if (!metadata.isDirectory() || metadata.mtimeMs > staleBefore) continue
      if (await input.store.get(userId, jobEntry.name)) continue
      await rm(directory, { recursive: true, force: true })
    }
  }
}
