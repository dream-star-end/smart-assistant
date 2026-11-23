/**
 * Container-gateway internal HTTP endpoints for zero-turn cached Office preview:
 *   - GET / POST `/internal/office-preview`
 *   - GET        `/internal/office-preview/page?handle=<handle>&page=<index>`
 *
 * Security invariants:
 *   - Protected by fail-closed `verifyInternalBridgeAuth(req)` (master → container bridge).
 *   - Calls `previewOfficeFile(...)` from `../officePreview.js` with container-scoped
 *     `allowedRoots` (`TRUSTED_CONTAINER_HOME` / `FILE_ALLOWED_DIRS` / agent CWDs) and
 *     checks `isFileBlocked(...)`.
 *   - Never exposes raw container cache paths as client-facing credentials: returns opaque
 *     `imgPath: "cph:<containerHandle>:<index>"` tokens resolved exclusively via an in-memory
 *     handle registry + `O_NOFOLLOW` containment inside the container preview cache root.
 */

import { randomBytes } from 'node:crypto'
import { constants as fsConstants, type Stats } from 'node:fs'
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  FILE_ALLOWED_DIRS,
  TRUSTED_CONTAINER_HOME,
  isFileBlocked,
  isTrustedContainerFileServeEnabled,
} from '../gatewayFilePolicy.js'
import {
  MAX_XLSX_ROWS_PER_SHEET,
  OfficePreviewError,
  previewOfficeFile,
  type OfficePreviewOptions,
  type OfficePreviewResult,
} from '../officePreview.js'
import { isPathWithinRoot } from '../pathAcl.js'
import {
  verifyInternalBridgeAuthDetailed,
  verifyInternalBridgeHeaderPrecheck,
  type InternalBridgeAuthResult,
  type InternalBridgeReplayCache,
} from './internalBridgeAuth.js'
import type { PlatformRoutesIo } from './platform.js'
import { type HttpRoute, predicateRoute } from './routeTable.js'

export const INTERNAL_OFFICE_PREVIEW_PATH = '/internal/office-preview'
export const INTERNAL_OFFICE_PREVIEW_PAGE_PATH = '/internal/office-preview/page'
export const CONTAINER_PAGE_TOKEN_PREFIX = 'cph:'

const DEFAULT_HANDLE_TTL_MS = 30 * 60_000
const DEFAULT_HANDLE_MAX_ENTRIES = 1_000
const MAX_PAGE_IMAGE_BYTES = 16 * 1024 * 1024 // 16 MiB
const SAFE_HANDLE_RE = /^[A-Za-z0-9_-]{16,96}$/

export interface ContainerPreviewHandleEntry {
  handle: string
  cacheRoot: string
  pagesByIndex: Map<number, string>
  expiresAt: number
}

export class ContainerOfficePreviewRegistry {
  private readonly entries = new Map<string, ContainerPreviewHandleEntry>()
  private readonly ttlMs: number
  private readonly maxEntries: number

  constructor(opts?: { ttlMs?: number; maxEntries?: number }) {
    this.ttlMs = opts?.ttlMs ?? DEFAULT_HANDLE_TTL_MS
    this.maxEntries = opts?.maxEntries ?? DEFAULT_HANDLE_MAX_ENTRIES
  }

  register(input: {
    cacheRoot: string
    pages: ReadonlyArray<{ index: number; imgPath: string }>
    now?: number
  }): string {
    const now = input.now ?? Date.now()
    this.prune(now)
    const handle = randomBytes(18).toString('base64url')
    const pagesByIndex = new Map<number, string>()
    for (const p of input.pages) {
      pagesByIndex.set(p.index, p.imgPath)
    }
    this.entries.set(handle, {
      handle,
      cacheRoot: input.cacheRoot,
      pagesByIndex,
      expiresAt: now + this.ttlMs,
    })
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
      else break
    }
    return handle
  }

  resolve(
    handle: string,
    pageIndex: number,
    now = Date.now(),
  ): { imgPath: string; cacheRoot: string } | null {
    const entry = this.entries.get(handle)
    if (!entry || entry.expiresAt <= now) {
      if (entry) this.entries.delete(handle)
      return null
    }
    const imgPath = entry.pagesByIndex.get(pageIndex)
    if (!imgPath) return null
    return { imgPath, cacheRoot: entry.cacheRoot }
  }

  private prune(now: number): void {
    for (const [k, v] of this.entries) {
      if (v.expiresAt <= now) this.entries.delete(k)
    }
  }
}

const defaultContainerPreviewRegistry = new ContainerOfficePreviewRegistry()

export interface InternalOfficePreviewDeps {
  verifyAuth?: (
    req: IncomingMessage,
    body?: Buffer,
  ) => boolean | InternalBridgeAuthResult
  env?: NodeJS.ProcessEnv
  now?: () => number
  replayCache?: InternalBridgeReplayCache
  allowedRoots?: readonly string[]
  cacheDir?: string
  registry?: ContainerOfficePreviewRegistry
  previewFn?: (filePath: string, opts: OfficePreviewOptions) => Promise<OfficePreviewResult>
  readBody?: (req: IncomingMessage, maxBytes?: number) => Promise<string>
  agentCwds?: () => readonly string[]
  onErrorLog?: (code: string, detail: string) => void
}

/**
 * N2 (OCV5-832): Map internal OfficePreviewError codes to stable, path-free
 * external messages so stderr/filesystem paths never leak to HTTP callers.
 */
function sanitizeOfficePreviewExternalMessage(code: string): string {
  switch (code) {
    case 'INVALID_PATH':
      return 'valid absolute file path is required'
    case 'FILE_NOT_FOUND':
      return 'preview file not found'
    case 'FILE_TOO_LARGE':
      return 'file exceeds maximum preview size'
    case 'UNSUPPORTED_TYPE':
      return 'unsupported file type for office preview'
    case 'PATH_ESCAPE':
      return 'access to file path denied'
    case 'SYMLINK_REJECTED':
      return 'symbolic links are not allowed'
    case 'RENDER_TIMEOUT':
      return 'office preview rendering timed out'
    case 'RENDER_FAILED':
      return 'office preview rendering failed'
    default:
      return 'office preview failed'
  }
}

function normalizeAuthOutcome(res: boolean | InternalBridgeAuthResult): InternalBridgeAuthResult {
  if (typeof res === 'boolean') {
    return res
      ? { ok: true }
      : { ok: false, status: 401, code: 'UNAUTHORIZED', error: 'unauthorized' }
  }
  return res
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(payload))
}

function sendPreviewError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } })
}

function resolveContainerAllowedRoots(agentCwds: readonly string[]): string[] {
  const roots = new Set<string>()
  if (isTrustedContainerFileServeEnabled()) {
    roots.add(TRUSTED_CONTAINER_HOME)
  }
  for (const dir of FILE_ALLOWED_DIRS) {
    if (dir) roots.add(path.resolve(dir))
  }
  for (const cwd of agentCwds) {
    if (cwd && path.isAbsolute(cwd)) roots.add(path.resolve(cwd))
  }
  return [...roots]
}

function defaultCacheDir(): string {
  return path.join(tmpdir(), 'oc-office-preview-cache')
}

async function readBodyFallback(req: IncomingMessage, maxBytes = 16 * 1024): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > maxBytes) throw new Error('BODY_TOO_LARGE')
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function parseMaxRows(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n) || n < 1 || n > MAX_XLSX_ROWS_PER_SHEET) {
    throw new OfficePreviewError(
      'INVALID_PATH',
      400,
      `maxRowsPerSheet must be between 1 and ${MAX_XLSX_ROWS_PER_SHEET}`,
    )
  }
  return Math.floor(n)
}

export async function handleInternalOfficePreview(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: InternalOfficePreviewDeps = {},
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'POST') {
    sendPreviewError(res, 405, 'METHOD_NOT_ALLOWED', 'GET or POST required')
    return
  }

  let rawBodyText = ''
  if (method === 'POST') {
    if (!deps.verifyAuth) {
      const pre = verifyInternalBridgeHeaderPrecheck(req, { env: deps.env, now: deps.now })
      if (!pre.ok) {
        sendPreviewError(res, pre.status, pre.code, pre.error)
        return
      }
    }
    try {
      rawBodyText = deps.readBody
        ? await deps.readBody(req, 16 * 1024)
        : await readBodyFallback(req, 16 * 1024)
    } catch {
      sendPreviewError(res, 400, 'INVALID_BODY', 'invalid request parameters')
      return
    }
  }

  const rawBodyBuf = method === 'POST' ? Buffer.from(rawBodyText, 'utf8') : Buffer.alloc(0)
  const authOutcome = deps.verifyAuth
    ? normalizeAuthOutcome(deps.verifyAuth(req, rawBodyBuf))
    : verifyInternalBridgeAuthDetailed(req, {
        env: deps.env,
        body: rawBodyBuf,
        now: deps.now,
        replayCache: deps.replayCache,
      })
  if (!authOutcome.ok) {
    sendPreviewError(res, authOutcome.status, authOutcome.code, authOutcome.error)
    return
  }

  let filePath = ''
  let maxRowsPerSheet: number | undefined
  try {
    if (method === 'GET') {
      filePath = (url.searchParams.get('path') ?? '').trim()
      maxRowsPerSheet = parseMaxRows(
        url.searchParams.get('maxRows') ?? url.searchParams.get('maxRowsPerSheet'),
      )
    } else {
      const parsed = rawBodyText.trim() ? (JSON.parse(rawBodyText) as unknown) : null
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        sendPreviewError(res, 400, 'INVALID_BODY', 'JSON object body is required')
        return
      }
      const body = parsed as Record<string, unknown>
      filePath = typeof body.path === 'string' ? body.path.trim() : ''
      maxRowsPerSheet = parseMaxRows(body.maxRowsPerSheet ?? body.maxRows)
    }
  } catch (err) {
    if (err instanceof OfficePreviewError) {
      deps.onErrorLog?.(err.code, err.message)
      sendPreviewError(res, err.httpStatus, err.code, sanitizeOfficePreviewExternalMessage(err.code))
      return
    }
    sendPreviewError(res, 400, 'INVALID_BODY', 'invalid request parameters')
    return
  }

  if (!filePath || filePath.includes('\0') || !path.isAbsolute(filePath)) {
    sendPreviewError(res, 400, 'INVALID_PATH', 'valid absolute file path is required')
    return
  }
  if (isFileBlocked(path.resolve(filePath))) {
    sendPreviewError(res, 403, 'PATH_ESCAPE', 'access to file path denied')
    return
  }

  const cacheDir = deps.cacheDir ?? defaultCacheDir()
  const allowedRoots = deps.allowedRoots ?? resolveContainerAllowedRoots(deps.agentCwds?.() ?? [])
  const runPreview = deps.previewFn ?? previewOfficeFile
  const registry = deps.registry ?? defaultContainerPreviewRegistry

  try {
    const result = await runPreview(filePath, {
      allowedRoots,
      cacheDir,
      ...(maxRowsPerSheet !== undefined ? { maxRowsPerSheet } : {}),
    })

    if (result.kind === 'pptx' || result.kind === 'docx') {
      const containerHandle = registry.register({
        cacheRoot: cacheDir,
        pages: result.pages,
      })
      const sanitized: OfficePreviewResult = {
        ...result,
        pages: result.pages.map((p) => ({
          index: p.index,
          imgPath: `${CONTAINER_PAGE_TOKEN_PREFIX}${containerHandle}:${p.index}`,
          ...(p.notes !== undefined ? { notes: p.notes } : {}),
        })),
      }
      sendJson(res, 200, { preview: sanitized })
      return
    }

    sendJson(res, 200, { preview: result })
  } catch (err) {
    if (err instanceof OfficePreviewError) {
      deps.onErrorLog?.(err.code, err.message)
      sendPreviewError(res, err.httpStatus, err.code, sanitizeOfficePreviewExternalMessage(err.code))
      return
    }
    deps.onErrorLog?.('INTERNAL', err instanceof Error ? err.message : String(err))
    sendPreviewError(res, 500, 'INTERNAL', 'office preview failed')
  }
}

async function readCachedPageImageSafe(
  imgPath: string,
  cacheRoot: string,
): Promise<{ bytes: Buffer; contentType: 'image/png' | 'image/jpeg' }> {
  const ext = path.extname(imgPath).toLowerCase()
  const contentType =
    ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : null
  if (!contentType) {
    throw new OfficePreviewError('UNSUPPORTED_TYPE', 415, 'only PNG/JPEG preview images are allowed')
  }

  let realRoot: string
  try {
    realRoot = await realpath(cacheRoot)
  } catch {
    throw new OfficePreviewError('FILE_NOT_FOUND', 404, 'preview image not found')
  }

  let st: Stats
  try {
    st = await lstat(imgPath)
  } catch {
    throw new OfficePreviewError('FILE_NOT_FOUND', 404, 'preview image not found')
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new OfficePreviewError('SYMLINK_REJECTED', 403, 'symbolic links are not allowed')
  }

  let realImg: string
  try {
    realImg = await realpath(imgPath)
  } catch {
    throw new OfficePreviewError('FILE_NOT_FOUND', 404, 'preview image not found')
  }
  if (!isPathWithinRoot(realImg, realRoot)) {
    throw new OfficePreviewError('PATH_ESCAPE', 403, 'preview image escapes cache root')
  }

  let fh: FileHandle | null = null
  try {
    const flags =
      fsConstants.O_RDONLY |
      (typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0)
    fh = await open(realImg, flags)
    const fst = await fh.stat()
    if (!fst.isFile() || fst.dev !== st.dev || fst.ino !== st.ino) {
      throw new OfficePreviewError('SYMLINK_REJECTED', 403, 'preview image changed during read')
    }
    if (fst.size > MAX_PAGE_IMAGE_BYTES) {
      throw new OfficePreviewError('FILE_TOO_LARGE', 413, 'preview page image exceeds size limit')
    }
    const bytes = await fh.readFile()
    if (bytes.length > MAX_PAGE_IMAGE_BYTES) {
      throw new OfficePreviewError('FILE_TOO_LARGE', 413, 'preview page image exceeds size limit')
    }
    return { bytes, contentType }
  } catch (err) {
    if (err instanceof OfficePreviewError) throw err
    throw new OfficePreviewError('FILE_NOT_FOUND', 404, 'preview image unreadable')
  } finally {
    if (fh !== null) {
      try {
        await fh.close()
      } catch {
        // ignore
      }
    }
  }
}

export async function handleInternalOfficePreviewPage(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: InternalOfficePreviewDeps = {},
): Promise<void> {
  const authOutcome = deps.verifyAuth
    ? normalizeAuthOutcome(deps.verifyAuth(req, Buffer.alloc(0)))
    : verifyInternalBridgeAuthDetailed(req, {
        env: deps.env,
        body: Buffer.alloc(0),
        now: deps.now,
        replayCache: deps.replayCache,
      })
  if (!authOutcome.ok) {
    sendPreviewError(res, authOutcome.status, authOutcome.code, authOutcome.error)
    return
  }
  if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
    sendPreviewError(res, 405, 'METHOD_NOT_ALLOWED', 'GET required')
    return
  }
  if (url.searchParams.has('path')) {
    sendPreviewError(res, 400, 'RAW_PATH_FORBIDDEN', 'raw filesystem path is not accepted; use preview handle')
    return
  }

  const handle = (url.searchParams.get('handle') ?? '').trim()
  const pageIndex = Number((url.searchParams.get('page') ?? '').trim())
  if (!handle || !SAFE_HANDLE_RE.test(handle)) {
    sendPreviewError(res, 400, 'INVALID_HANDLE', 'valid preview handle is required')
    return
  }
  if (!Number.isInteger(pageIndex) || pageIndex < 1 || pageIndex > 2000) {
    sendPreviewError(res, 400, 'INVALID_PAGE', 'valid positive page index is required')
    return
  }

  const registry = deps.registry ?? defaultContainerPreviewRegistry
  const resolved = registry.resolve(handle, pageIndex)
  if (!resolved) {
    sendPreviewError(res, 404, 'NOT_FOUND', 'preview page not found')
    return
  }

  try {
    const img = await readCachedPageImageSafe(resolved.imgPath, resolved.cacheRoot)
    res.statusCode = 200
    res.setHeader('Content-Type', img.contentType)
    res.setHeader('Content-Length', img.bytes.length)
    res.setHeader('Content-Disposition', 'inline')
    res.setHeader('Cache-Control', 'private, max-age=300')
    res.end(img.bytes)
  } catch (err) {
    if (err instanceof OfficePreviewError) {
      deps.onErrorLog?.(err.code, err.message)
      sendPreviewError(res, err.httpStatus, err.code, sanitizeOfficePreviewExternalMessage(err.code))
      return
    }
    deps.onErrorLog?.('INTERNAL', err instanceof Error ? err.message : String(err))
    sendPreviewError(res, 500, 'INTERNAL', 'failed to read preview page image')
  }
}

export const OFFICE_PREVIEW_INTERNAL_ROUTES: readonly HttpRoute<PlatformRoutesIo>[] = [
  predicateRoute(
    'INTERNAL /internal/office-preview',
    (req, url) =>
      url.pathname === INTERNAL_OFFICE_PREVIEW_PATH &&
      (req.method === 'GET' || req.method === 'POST'),
    (io, req, res, url) => {
      handleInternalOfficePreview(req, res, url, {
        readBody: (r, max) => io.readBody(r, max),
        agentCwds: () =>
          io.deps.agentsConfig.agents.map((a) => a.cwd).filter((c): c is string => Boolean(c)),
        onErrorLog: (code, detail) =>
          io.log.warn('internal office-preview error', { code, detail }),
      }).catch((err) => {
        io.log.error('internal office-preview handler crashed', undefined, err as Error)
        if (!res.headersSent) {
          sendPreviewError(res, 500, 'INTERNAL', 'internal office preview error')
        }
      })
      return true
    },
  ),
  predicateRoute(
    'GET /internal/office-preview/page',
    (req, url) => url.pathname === INTERNAL_OFFICE_PREVIEW_PAGE_PATH && req.method === 'GET',
    (io, req, res, url) => {
      handleInternalOfficePreviewPage(req, res, url, {
        onErrorLog: (code, detail) =>
          io.log.warn('internal office-preview/page error', { code, detail }),
      }).catch((err) => {
        io.log.error('internal office-preview/page handler crashed', undefined, err as Error)
        if (!res.headersSent) {
          sendPreviewError(res, 500, 'INTERNAL', 'internal office preview page error')
        }
      })
      return true
    },
  ),
]
