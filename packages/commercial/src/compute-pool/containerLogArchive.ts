/**
 * 删容器前先存日志(第三阶段方案 v3.6 §7.5,OCV5-568)。
 *
 * 容器 stdout/stderr 在 docker json-file 里,容器一删就没了;回合崩溃 / OOM / 重建的「为什么」常常只在
 * 那里。commercial/src 里所有本地删容器的地方都经 removeContainerSavingLogs:
 *   1. 先把该容器的 `docker logs`(stdout+stderr,带时间戳,尾 TAIL_LINES 行)以流的方式读入,边读边解复用,
 *      内存里只留最后 MAX_BYTES 字节(崩溃在尾部);整个读取有 SAVE_TIMEOUT_MS 截止,到点即中止请求,
 *      已读到的部分照样落盘(末尾标注被截断)。写到 `<dir>/<容器 id 前 12 位>-<UTC 时间>-<原因>.log`
 *      (0600,目录 0700),随后按 MAX_AGE_DAYS 与 MAX_TOTAL_BYTES 清理归档目录 —— 写入与清理都在本次调用
 *      内完成,删除返回后不会再有后台写入,磁盘占用有上限;
 *   2. 再原样 `container.remove({ force: true })` —— 删除的报错语义与之前完全一样(调用方照旧判 404 等)。
 * 保存失败只告警、计数,**不挡删除**(不让日志问题卡住回收)。远端主机上的容器(containerService.remove
 * 的远端 backend)日志不在本机,不在此覆盖。gateway 日志已经过 kernel 脱敏(§7.8),归档与宿主日志同等
 * 对待(root 可读)。
 */
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { type Logger, rootLogger } from '../logging/logger.js'

export const CONTAINER_LOG_DIR = '/var/log/openclaude-v5-containers'
const TAIL_LINES = 20_000
const MAX_BYTES = 8 * 1024 * 1024
const SAVE_TIMEOUT_MS = 5_000
const MAX_AGE_DAYS = 14
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024

export interface LogQuery {
  stdout: true
  stderr: true
  timestamps: true
  tail: number
}

/** The parts of a dockerode Container this module uses (so tests can pass a fake). */
export interface RemovableContainer {
  id: string
  remove(opts: { force: boolean }): Promise<unknown>
  /** dockerode's docker-modem; used to read the logs as a stream (Container.logs buffers it all) */
  modem?: { dial(opts: object, cb: (err: unknown, data: unknown) => void): void }
}

/** Opens a container's (non-follow) log response as a stream; aborting the signal cancels it. */
export type LogStreamOpener = (
  container: RemovableContainer,
  query: LogQuery,
  signal: AbortSignal,
) => Promise<NodeJS.ReadableStream>

export interface ArchiveOptions {
  dir?: string
  maxBytes?: number
  timeoutMs?: number
  maxAgeDays?: number
  maxTotalBytes?: number
  now?: () => Date
  log?: Logger
  openLogs?: LogStreamOpener
}

const stats = { saved: 0, cut: 0, failed: 0, pruned: 0 }
/** Counters since process start (saved files, saves cut at the deadline, failed saves, pruned files). */
export function containerLogArchiveStats(): Readonly<typeof stats> {
  return { ...stats }
}

/**
 * Same request as dockerode's Container.logs, but with isStream so the body is never buffered whole
 * (Container.logs only streams with follow, and follow on a running container waits for new lines).
 */
const dockerLogStream: LogStreamOpener = (container, query, signal) =>
  new Promise((resolve, reject) => {
    if (!container.modem) {
      reject(new Error('container handle has no docker modem'))
      return
    }
    container.modem.dial(
      {
        path: `/containers/${container.id}/logs?`,
        method: 'GET',
        isStream: true,
        abortSignal: signal,
        statusCodes: { 200: true, 404: 'no such container', 500: 'server error' },
        options: query,
      },
      (err, data) => (err ? reject(err) : resolve(data as NodeJS.ReadableStream)),
    )
  })

/**
 * Incremental docker log demuxer that keeps only the last `max` bytes. A non-TTY container's log is a
 * multiplexed stream: 8-byte frame headers ([stream 0|1|2, 0, 0, 0, size u32be]) before each chunk;
 * headers are stripped (also when split across reads). Input that does not parse as frames (a TTY
 * container) is kept as is from that point on.
 */
export class TailDemuxer {
  private mode: 'framed' | 'raw' = 'framed'
  private header = Buffer.alloc(0)
  private remaining = 0
  private chunks: Buffer[] = []
  private total = 0

  constructor(private readonly max: number) {}

  push(buf: Buffer): void {
    let off = 0
    while (off < buf.length) {
      if (this.mode === 'raw') {
        this.keep(buf.subarray(off))
        return
      }
      if (this.remaining > 0) {
        const n = Math.min(this.remaining, buf.length - off)
        this.keep(buf.subarray(off, off + n))
        this.remaining -= n
        off += n
        continue
      }
      const take = buf.subarray(off, off + 8 - this.header.length)
      this.header = Buffer.concat([this.header, take])
      off += take.length
      if (this.header.length < 8) return
      const h = this.header
      this.header = Buffer.alloc(0)
      if (h[0]! > 2 || h[1] !== 0 || h[2] !== 0 || h[3] !== 0) {
        this.mode = 'raw'
        this.keep(h)
        continue
      }
      this.remaining = h.readUInt32BE(4)
    }
  }

  /** The kept tail (a partial header left at the end is kept as raw bytes). */
  result(): Buffer {
    if (this.header.length) {
      this.keep(this.header)
      this.header = Buffer.alloc(0)
    }
    const all = Buffer.concat(this.chunks)
    return all.length > this.max ? all.subarray(all.length - this.max) : all
  }

  private keep(b: Buffer): void {
    if (!b.length) return
    this.chunks.push(b)
    this.total += b.length
    while (this.chunks.length > 1 && this.total - this.chunks[0]!.length >= this.max)
      this.total -= this.chunks.shift()!.length
  }
}

/** Read a log stream into a TailDemuxer until it ends or `signal` aborts (then keep what was read). */
function readTail(
  stream: NodeJS.ReadableStream,
  max: number,
  signal: AbortSignal,
): Promise<{ body: Buffer; cut: boolean }> {
  const d = new TailDemuxer(max)
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (cut: boolean, err?: unknown) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      if (err && !cut) reject(err)
      else resolve({ body: d.result(), cut })
    }
    const onAbort = () => {
      ;(stream as { destroy?: () => void }).destroy?.()
      finish(true)
    }
    stream.on('data', (c: Buffer | string) => {
      if (!settled) d.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
    })
    stream.once('end', () => finish(false))
    stream.once('error', (e: unknown) => finish(signal.aborted, e))
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Resolve with `p`, or reject when `signal` aborts first (a late value is handed to `onLate`). */
function untilAbort<T>(p: Promise<T>, signal: AbortSignal, onLate: (v: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error('timed out'))
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        if (signal.aborted) onLate(v)
        else resolve(v)
      },
      (e) => {
        signal.removeEventListener('abort', onAbort)
        reject(e)
      },
    )
  })
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 48) || 'unknown'

/** Delete archive files older than maxAgeDays, then the oldest until the total fits maxTotalBytes. */
export async function pruneContainerLogArchive(opts: ArchiveOptions = {}): Promise<number> {
  const dir = opts.dir ?? CONTAINER_LOG_DIR
  const now = (opts.now ?? (() => new Date()))().getTime()
  const maxAge = (opts.maxAgeDays ?? MAX_AGE_DAYS) * 86_400_000
  const maxTotal = opts.maxTotalBytes ?? MAX_TOTAL_BYTES
  const files = []
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.log')) continue
    const st = await stat(path.join(dir, name)).catch(() => null)
    if (st?.isFile()) files.push({ name, mtime: st.mtimeMs, size: st.size })
  }
  files.sort((a, b) => a.mtime - b.mtime)
  let total = files.reduce((n, f) => n + f.size, 0)
  let removed = 0
  for (const f of files) {
    if (now - f.mtime <= maxAge && total <= maxTotal) continue
    await rm(path.join(dir, f.name), { force: true })
    total -= f.size
    removed++
  }
  stats.pruned += removed
  return removed
}

/**
 * Save a container's logs to the archive. Never throws; returns the file written or null. Nothing is
 * read or written after it returns: the read is cancelled at the deadline, then write and prune run.
 */
export async function saveContainerLogs(
  container: RemovableContainer,
  reason: string,
  opts: ArchiveOptions = {},
): Promise<string | null> {
  const dir = opts.dir ?? CONTAINER_LOG_DIR
  const log = opts.log ?? rootLogger.child({ subsys: 'containerLogArchive' })
  const maxBytes = opts.maxBytes ?? MAX_BYTES
  // a fake or odd handle may lack an id; the archive must never be the reason a removal fails
  const shortId = String((container as { id?: unknown }).id ?? 'unknown').slice(0, 12)
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), opts.timeoutMs ?? SAVE_TIMEOUT_MS)
  try {
    const open = opts.openLogs ?? dockerLogStream
    const query: LogQuery = { stdout: true, stderr: true, timestamps: true, tail: TAIL_LINES }
    const stream = await untilAbort(open(container, query, deadline.signal), deadline.signal, (s) =>
      (s as { destroy?: () => void }).destroy?.(),
    )
    const { body, cut } = await readTail(stream, maxBytes, deadline.signal)
    clearTimeout(timer)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const stamp = (opts.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, '-')
    const f = path.join(dir, `${safe(shortId)}-${stamp}-${safe(reason)}.log`)
    const note = cut ? Buffer.from('\n[oc: log save cut at its deadline; lines read so far kept]\n') : null
    await writeFile(f, note ? Buffer.concat([body, note]) : body, { mode: 0o600 })
    stats.saved++
    if (cut) {
      stats.cut++
      log.warn('container logs cut at save deadline', { containerId: shortId, reason })
    }
    await pruneContainerLogArchive(opts).catch(() => 0)
    return f
  } catch (err) {
    // already gone (removal is idempotent and often runs on absent containers): nothing to save
    if ((err as { statusCode?: number } | null)?.statusCode === 404) return null
    stats.failed++
    log.warn('container logs not saved before removal', { containerId: shortId, reason, err })
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The one way commercial/src removes a turn-runtime container: save its logs (bounded, best-effort),
 * then `remove({ force })` exactly as before (force defaults to true) — removal errors propagate unchanged.
 */
export async function removeContainerSavingLogs(
  container: RemovableContainer,
  reason: string,
  opts: ArchiveOptions & { force?: boolean } = {},
): Promise<void> {
  await saveContainerLogs(container, reason, opts)
  await container.remove({ force: opts.force ?? true })
}
