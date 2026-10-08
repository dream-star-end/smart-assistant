/**
 * 会话产出物自动归集 + 上传参考资料 excerpt 提取。
 *
 * 产出物:扫助手正文里的 `/home/agent/.openclaude/generated/...` 绝对路径,
 * 登记为 source='output' 的项目资产。失败不得影响回合收口。
 *
 * 容器里(有 master 地址与容器令牌)必须登记到 master:容器自己的 sessions
 * 后端是本地 SQLite,界面读的是 master 的 PG,登记在本地等于没登记。项目
 * 取回合开始时解析出的 chat project(冻结),不取登记那一刻会话所在项目。
 * master 暂时不可达时重试,仍失败就写进本地待登记队列,下次归集时补发。
 *
 * 版本:登记前先把产出当前的字节复制进与上传同一个内容寻址区(sha256),登记行
 * 带 digest + url 指向这份不可变副本,containerPath 只作源路径。同一路径写两次
 * 不同内容 = 两个版本,各自可下载;源文件之后被覆盖或删除不影响旧版本。
 */
import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import {
  appendFile,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
  type FileHandle,
} from 'node:fs/promises'
import { basename, dirname, join, sep } from 'node:path'
import {
  createProjectAsset,
  parseProjectAssetContainerPath,
  parseProjectAssetExcerpt,
  paths as storagePaths,
  PROJECT_ASSET_EXCERPT_MAX,
  PROJECT_ASSET_URL_RE,
} from '@openclaude/storage'
import { PROJECT_ASSETS_REGISTER_PATH } from '@openclaude/protocol'
import { request as undiciRequest } from 'undici'
import { parseDocument } from './documentParser.js'
import { createLogger } from './logger.js'

const log = createLogger({ module: 'projectAssets' })

export const GENERATED_OUTPUT_PATH_RE = /\/home\/agent\/\.openclaude\/generated\/[^\s<"'\`>]+/g
export const PROJECT_ASSET_TURN_COLLECT_MAX = 5
/** Outputs above this are registered by source path only, without a version copy. */
export const OUTPUT_VERSION_COPY_MAX_BYTES = 50 * 1024 * 1024
const GENERATED_PREFIX = '/home/agent/.openclaude/generated/'
const COPY_CHUNK_BYTES = 1024 * 1024
const EXCERPT_PARSE_TIMEOUT_MS = 8_000
const EXCERPT_TEXT_BYTES_MAX = 16 * 1024

const TRAILING_PUNCT_RE = /[.,;:!?。，、)\]}>]+$/u

const EXT_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  webm: 'video/webm',
  html: 'text/html',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

export function mimeFromAssetName(name: string): string | undefined {
  const ext = name.split('.').pop()?.toLowerCase()
  return ext ? EXT_MIME[ext] : undefined
}

export function extractGeneratedOutputPaths(text: string): string[] {
  if (!text) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const match of text.matchAll(GENERATED_OUTPUT_PATH_RE)) {
    const raw = match[0].replace(TRAILING_PUNCT_RE, '')
    const parsed = parseProjectAssetContainerPath(raw)
    if (!parsed || !parsed.startsWith('/home/agent/.openclaude/generated/')) continue
    if (seen.has(parsed)) continue
    seen.add(parsed)
    out.push(parsed)
    if (out.length >= PROJECT_ASSET_TURN_COLLECT_MAX) break
  }
  return out
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

export function resolveUploadExcerptPath(url?: string | null, containerPath?: string | null): string | null {
  const parsedPath = containerPath ? parseProjectAssetContainerPath(containerPath) : null
  if (parsedPath) return parsedPath
  if (url && PROJECT_ASSET_URL_RE.test(url)) {
    return `/home/agent/.openclaude/uploads/${url.slice('/api/media/'.length)}`
  }
  return null
}

function isExcerptableMime(mime: string | undefined, pathOrName: string): boolean {
  const m = (mime ?? '').toLowerCase()
  const p = pathOrName.toLowerCase()
  if (m === 'application/pdf' || p.endsWith('.pdf')) return true
  if (m.includes('wordprocessingml.document') || p.endsWith('.docx')) return true
  if (m.startsWith('text/')) return true
  if (m === 'application/json' || m === 'application/csv' || m === 'text/csv' || m === 'text/markdown') return true
  if (/\.(md|markdown|csv|json|txt)$/.test(p)) return true
  return false
}

async function readPlainExcerpt(filePath: string): Promise<string | null> {
  const buf = await readFile(filePath)
  const slice = buf.subarray(0, Math.min(buf.length, EXCERPT_TEXT_BYTES_MAX))
  const text = slice.toString('utf8').replace(/\u0000/g, '')
  const excerpt = parseProjectAssetExcerpt(text)
  return excerpt
}

/** 尽力解析前 2000 字符;失败/超时返回 null,调用方不得因此拒绝登记。 */
export async function tryExtractProjectAssetExcerpt(opts: {
  source: string
  mime?: string | null
  url?: string | null
  containerPath?: string | null
  name?: string | null
}): Promise<string | null> {
  if (opts.source !== 'upload') return null
  const filePath = resolveUploadExcerptPath(opts.url, opts.containerPath)
  if (!filePath) return null
  const hint = `${opts.mime ?? ''} ${opts.name ?? ''} ${filePath}`
  if (!isExcerptableMime(opts.mime ?? undefined, hint)) return null
  try {
    const mime = (opts.mime ?? mimeFromAssetName(opts.name ?? filePath) ?? '').toLowerCase()
    const looksDoc =
      mime === 'application/pdf' ||
      mime.includes('wordprocessingml.document') ||
      filePath.toLowerCase().endsWith('.pdf') ||
      filePath.toLowerCase().endsWith('.docx')
    if (looksDoc) {
      const parsed = await withTimeout(
        parseDocument(filePath, mime || 'application/octet-stream'),
        EXCERPT_PARSE_TIMEOUT_MS,
        'asset excerpt parseDocument',
      )
      if (!parsed?.markdown) return null
      return parseProjectAssetExcerpt(parsed.markdown.slice(0, PROJECT_ASSET_EXCERPT_MAX))
    }
    return await withTimeout(readPlainExcerpt(filePath), EXCERPT_PARSE_TIMEOUT_MS, 'asset excerpt read')
  } catch (err) {
    log.warn('asset excerpt extraction failed', { filePath }, err)
    return null
  }
}

const ENV_MASTER_URL = 'OPENCLAUDE_V3_MASTER_BASE_URL'
const ENV_CONTAINER_TOKEN = 'OPENCLAUDE_V3_CONTAINER_TOKEN'
const REGISTER_TIMEOUT_MS = 5_000
const REGISTER_RETRY_DELAYS_MS = [0, 1_000, 5_000]
const SPOOL_MAX_ENTRIES = 500
const SPOOL_FLUSH_MIN_INTERVAL_MS = 60_000

export interface OutputAssetItem {
  containerPath: string
  name: string
  mime?: string
  size?: number
  /** sha256 of the version copy; absent when the output was not copied (too big / copy failed). */
  digest?: string
  /** `/api/media/<digest>.<ext>` of the version copy; always sent together with digest. */
  url?: string
}

/** Where outputs are read from and where version copies go (test seam). */
export interface OutputVersionRoots {
  /** Real directory behind `/home/agent/.openclaude/generated/`. */
  generated: string
  /** Content-addressed store, the same directory uploads land in (served by /api/media). */
  cas: string
}

export interface CapturedOutputVersion {
  size: number
  digest?: string
  url?: string
}

/** One registration request; also the shape of a pending spool line. */
export interface OutputAssetRegistration {
  sessionId: string
  /** Chat project frozen at turn start; absent = unknown, master infers. */
  projectId?: string | null
  items: OutputAssetItem[]
}

export interface CollectSessionOutputAssetsOpts {
  userId: string
  sessionId: string
  assistantText: string
  /** Chat project the turn resolved when it started. undefined = not resolved (flag off). */
  chatProjectId?: string | null
  env?: NodeJS.ProcessEnv
  fetcher?: typeof undiciRequest
  sleep?: (ms: number) => Promise<void>
  spoolFile?: string
  /** Test seam: outputs live under /home/agent, which tests cannot create. */
  outputRoots?: OutputVersionRoots
}

type RegisterOutcome = 'registered' | 'rejected' | 'unreachable'

function defaultOutputRoots(): OutputVersionRoots {
  return { generated: GENERATED_PREFIX.slice(0, -1), cas: storagePaths.uploadsDir }
}

/** Storage suffix from the output's own name; same charset PROJECT_ASSET_URL_RE accepts. */
export function outputVersionExt(name: string): string {
  const m = name.match(/\.([A-Za-z0-9]{1,32})$/)
  return m ? m[1]!.toLowerCase() : 'bin'
}

async function writeAll(fh: FileHandle, chunk: Buffer): Promise<void> {
  let off = 0
  while (off < chunk.length) {
    const { bytesWritten } = await fh.write(chunk, off, chunk.length - off)
    off += bytesWritten
  }
}

/**
 * Copy the already-opened source into the content-addressed store, hashing
 * exactly the bytes copied (a file rewritten mid-copy still gets a digest
 * that matches what is stored). Publish is tmp + link, like uploads: an
 * existing `<digest>.<ext>` is the same bytes and is kept.
 */
async function copyIntoCas(src: FileHandle, name: string, casDir: string): Promise<CapturedOutputVersion> {
  await mkdir(casDir, { recursive: true })
  const tmp = join(casDir, `.tmp-output-${process.pid}-${randomUUID()}`)
  const out = await open(tmp, 'wx', 0o644)
  const hash = createHash('sha256')
  let copied = 0
  try {
    try {
      const buf = Buffer.allocUnsafe(COPY_CHUNK_BYTES)
      for (;;) {
        const { bytesRead } = await src.read(buf, 0, buf.length, copied)
        if (bytesRead === 0) break
        copied += bytesRead
        if (copied > OUTPUT_VERSION_COPY_MAX_BYTES) throw new Error('output grew past the version copy cap')
        const chunk = buf.subarray(0, bytesRead)
        hash.update(chunk)
        await writeAll(out, chunk)
      }
      await out.chmod(0o644)
    } finally {
      await out.close()
    }
    const digest = hash.digest('hex')
    const finalName = `${digest}.${outputVersionExt(name)}`
    const finalPath = join(casDir, finalName)
    try {
      await link(tmp, finalPath)
    } catch (err) {
      if ((err as { code?: string }).code !== 'EEXIST') throw err
      // Same digest already stored. Anything that is not a regular file of
      // the right size there is not those bytes: replace it.
      const existing = await lstat(finalPath)
      if (!existing.isFile() || existing.size !== copied) await rename(tmp, finalPath)
    }
    return { size: copied, digest, url: `/api/media/${finalName}` }
  } finally {
    await rm(tmp, { force: true })
  }
}

/**
 * Capture the current bytes of one output as an immutable version.
 * null = do not register (missing, not a regular file, or resolving outside
 * generated/ through a symlink). Over the cap, or if the copy fails, only
 * the size comes back and the output is registered by source path as before.
 */
export async function captureOutputVersion(
  containerPath: string,
  roots: OutputVersionRoots = defaultOutputRoots(),
): Promise<CapturedOutputVersion | null> {
  if (!containerPath.startsWith(GENERATED_PREFIX)) return null
  const rootReal = await realpath(roots.generated)
  const real = await realpath(join(rootReal, containerPath.slice(GENERATED_PREFIX.length)))
  if (!real.startsWith(rootReal + sep)) {
    log.warn('output path resolves outside generated/, not registered', { containerPath })
    return null
  }
  const src = await open(real, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    // A directory swapped for a symlink between realpath and open is caught
    // here: what we actually opened must still live under generated/.
    const opened = await realpath(`/proc/self/fd/${src.fd}`).catch(() => real)
    if (!opened.startsWith(rootReal + sep)) {
      log.warn('output path moved outside generated/ while opening, not registered', { containerPath })
      return null
    }
    const st = await src.stat()
    if (!st.isFile()) return null
    if (st.size > OUTPUT_VERSION_COPY_MAX_BYTES) return { size: st.size }
    try {
      return await copyIntoCas(src, basename(containerPath), roots.cas)
    } catch (err) {
      log.warn('output version copy failed, registering the source path only', { containerPath }, err)
      return { size: st.size }
    }
  } finally {
    await src.close()
  }
}

export function outputAssetSpoolFile(): string {
  return join(storagePaths.home, 'pending-output-assets.jsonl')
}

async function postRegistration(
  reg: OutputAssetRegistration,
  opts: CollectSessionOutputAssetsOpts,
): Promise<RegisterOutcome> {
  const env = opts.env ?? process.env
  const base = env[ENV_MASTER_URL]
  const bearer = env[ENV_CONTAINER_TOKEN]
  if (!base || !bearer) return 'unreachable'
  const fetcher = opts.fetcher ?? undiciRequest
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)))
  const url = `${base.replace(/\/+$/, '')}${PROJECT_ASSETS_REGISTER_PATH}`
  for (const delay of REGISTER_RETRY_DELAYS_MS) {
    if (delay > 0) await sleep(delay)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REGISTER_TIMEOUT_MS)
    try {
      const res = await fetcher(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        body: JSON.stringify(reg),
        signal: controller.signal,
      })
      const text = await res.body.text().catch(() => '')
      if (res.statusCode === 200) return 'registered'
      // A 4xx will not change on retry (bad item, foreign session, identity).
      if (res.statusCode >= 400 && res.statusCode < 500 && res.statusCode !== 408 && res.statusCode !== 429) {
        log.warn('output asset registration rejected', {
          sessionId: reg.sessionId,
          status: res.statusCode,
          body: text.slice(0, 200),
        })
        return 'rejected'
      }
    } catch {
      /* network / timeout: retry */
    } finally {
      clearTimeout(timer)
    }
  }
  return 'unreachable'
}

// Every spool file operation runs through this one in-process lock. The
// container gateway is the only writer (single process), so a promise chain
// is enough. A flush moves the queue to <file>.inflight under the lock and
// sends without holding it; appends during the send land in a fresh queue
// file, and whatever still fails is appended back under the lock. An
// .inflight left by a crash is picked up by the next flush, so a record is
// never dropped (at worst sent twice, which the master dedups).
let spoolChain: Promise<unknown> = Promise.resolve()
function withSpoolLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = spoolChain.then(fn, fn)
  spoolChain = run.catch(() => undefined)
  return run
}

function serialize(regs: OutputAssetRegistration[]): string {
  return regs.map((r) => `${JSON.stringify(r)}\n`).join('')
}

function parseSpool(raw: string): OutputAssetRegistration[] {
  const out: OutputAssetRegistration[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const reg = JSON.parse(line) as OutputAssetRegistration
      if (reg && typeof reg.sessionId === 'string' && Array.isArray(reg.items)) out.push(reg)
    } catch {
      /* drop a torn line */
    }
  }
  return out
}

async function readIfExists(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return ''
  }
}

async function appendSpool(file: string, regs: OutputAssetRegistration[]): Promise<void> {
  if (regs.length === 0) return
  await withSpoolLock(async () => {
    await mkdir(dirname(file), { recursive: true })
    await appendFile(file, serialize(regs), { encoding: 'utf8', mode: 0o600 })
  })
}

let lastFlushAt = 0
let flushing: Promise<void> | null = null

/** Resend spooled registrations. Keeps whatever still fails; bounded. */
export async function flushOutputAssetSpool(opts: CollectSessionOutputAssetsOpts, force = false): Promise<void> {
  // One flush at a time; a collection arriving meanwhile does not wait for it
  // (its own failures are appended under the lock and picked up next time).
  if (flushing) return
  if (!force && Date.now() - lastFlushAt < SPOOL_FLUSH_MIN_INTERVAL_MS) return
  lastFlushAt = Date.now()
  const file = opts.spoolFile ?? outputAssetSpoolFile()
  const inflight = `${file}.inflight`
  flushing = (async () => {
    const pending = await withSpoolLock(async () => {
      const carried = await readIfExists(inflight)
      const queued = await readIfExists(file)
      if (!carried.trim() && !queued.trim()) return [] as OutputAssetRegistration[]
      await mkdir(dirname(file), { recursive: true })
      const tmp = `${inflight}.tmp-${process.pid}`
      await writeFile(tmp, carried + queued, { encoding: 'utf8', mode: 0o600 })
      await rename(tmp, inflight)
      await writeFile(file, '', { encoding: 'utf8', mode: 0o600 })
      return parseSpool(carried + queued)
    })
    if (pending.length === 0) return
    // At most SPOOL_MAX_ENTRIES per flush; the rest stays queued, nothing is dropped.
    const keep: OutputAssetRegistration[] = pending.slice(SPOOL_MAX_ENTRIES)
    const sendable = pending.slice(0, SPOOL_MAX_ENTRIES)
    for (const reg of sendable) {
      const outcome = await postRegistration(reg, { ...opts, sleep: async () => {} })
      if (outcome === 'unreachable') keep.push(reg)
    }
    await withSpoolLock(async () => {
      if (keep.length > 0) await appendFile(file, serialize(keep), { encoding: 'utf8', mode: 0o600 })
      await rm(inflight, { force: true })
    })
  })()
  try {
    await flushing
  } finally {
    flushing = null
  }
}

export async function collectSessionOutputAssets(opts: CollectSessionOutputAssetsOpts): Promise<void> {
  const env = opts.env ?? process.env
  const viaMaster = Boolean(env[ENV_MASTER_URL] && env[ENV_CONTAINER_TOKEN])
  if (viaMaster) {
    await flushOutputAssetSpool(opts).catch((err) => log.warn('output asset spool flush failed', {}, err))
  }
  const paths = extractGeneratedOutputPaths(opts.assistantText)
  if (paths.length === 0) return
  const items: OutputAssetItem[] = []
  for (const containerPath of paths) {
    try {
      // The copy happens before the registration exists, so a registered
      // version always points at bytes that are already stored.
      const captured = await captureOutputVersion(containerPath, opts.outputRoots)
      if (!captured) continue
      const name = basename(containerPath)
      const mime = mimeFromAssetName(name)
      items.push({
        containerPath,
        name,
        ...(mime ? { mime } : {}),
        size: captured.size,
        ...(captured.digest && captured.url ? { digest: captured.digest, url: captured.url } : {}),
      })
    } catch (err) {
      log.warn('collectSessionOutputAssets skipped', { sessionId: opts.sessionId, containerPath }, err)
    }
  }
  if (items.length === 0) return

  if (viaMaster) {
    const reg: OutputAssetRegistration = {
      sessionId: opts.sessionId,
      ...(opts.chatProjectId !== undefined ? { projectId: opts.chatProjectId } : {}),
      items,
    }
    const outcome = await postRegistration(reg, opts)
    if (outcome === 'unreachable') {
      await appendSpool(opts.spoolFile ?? outputAssetSpoolFile(), [reg])
      log.warn('output assets queued for later registration', {
        sessionId: opts.sessionId,
        count: items.length,
      })
    }
    return
  }

  // Personal / test: the local sessions backend is the one the UI reads.
  for (const item of items) {
    try {
      const result = await createProjectAsset(opts.userId, {
        source: 'output',
        sessionId: opts.sessionId,
        ...(opts.chatProjectId !== undefined ? { projectId: opts.chatProjectId } : {}),
        name: item.name,
        containerPath: item.containerPath,
        mime: item.mime,
        size: item.size,
        ...(item.digest && item.url ? { digest: item.digest, url: item.url } : {}),
      })
      if (!result.ok && result.error !== 'limit_exceeded') {
        log.warn('collectSessionOutputAssets create failed', {
          sessionId: opts.sessionId,
          containerPath: item.containerPath,
          error: result.error,
        })
      }
    } catch (err) {
      log.warn('collectSessionOutputAssets skipped', { sessionId: opts.sessionId, containerPath: item.containerPath }, err)
    }
  }
}

/** Test seam. */
export function _resetOutputAssetSpoolThrottleForTest(): void {
  lastFlushAt = 0
  flushing = null
}
