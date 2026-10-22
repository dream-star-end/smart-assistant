/**
 * 删容器前先存日志(第三阶段方案 v3.6 §7.5,OCV5-568)。
 *
 * 容器 stdout/stderr 在 docker json-file 里,容器一删就没了;回合崩溃 / OOM / 重建的「为什么」常常只在
 * 那里。commercial/src 里所有本地删容器的地方都经 removeContainerSavingLogs:
 *   1. 先把该容器的 `docker logs`(stdout+stderr,带时间戳,尾 TAIL_LINES 行,封顶 MAX_BYTES)写到
 *      `<dir>/<容器 id 前 12 位>-<UTC 时间>-<原因>.log`(0600,目录 0700);整个保存有 SAVE_TIMEOUT_MS 预算;
 *   2. 再原样 `container.remove({ force: true })` —— 删除的报错语义与之前完全一样(调用方照旧判 404 等)。
 * 保存失败或超时只告警、计数,**不挡删除**(不让日志问题卡住回收)。每次保存后按 MAX_AGE_DAYS 与
 * MAX_TOTAL_BYTES 清理归档目录,磁盘占用有上限。远端主机上的容器(containerService.remove)日志不在本机,
 * 不在此覆盖(扫描测试里显式列出)。gateway 日志已经过 kernel 脱敏(§7.8),归档与宿主日志同等对待(root 可读)。
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

export interface ArchiveOptions {
  dir?: string
  maxBytes?: number
  timeoutMs?: number
  maxAgeDays?: number
  maxTotalBytes?: number
  now?: () => Date
  log?: Logger
}

/** The parts of a dockerode Container this module uses (so tests can pass a fake). */
export interface RemovableContainer {
  id: string
  logs(opts: {
    stdout: boolean
    stderr: boolean
    timestamps: boolean
    tail: number
    follow?: false
  }): Promise<Buffer>
  remove(opts: { force: boolean }): Promise<unknown>
}

const stats = { saved: 0, failed: 0, pruned: 0 }
/** Counters since process start (saved files, failed/timed-out saves, pruned files). */
export function containerLogArchiveStats(): Readonly<typeof stats> {
  return { ...stats }
}

/**
 * docker logs of a non-TTY container is a multiplexed stream: 8-byte frame headers
 * ([stream 1|2, 0, 0, 0, size u32be]) before each chunk. Strip them; anything that does not parse as
 * frames (a TTY container) is returned as is.
 */
export function demuxDockerLogs(buf: Buffer): Buffer {
  const parts: Buffer[] = []
  let off = 0
  while (off < buf.length) {
    if (off + 8 > buf.length) return buf
    const type = buf[off]!
    if (
      (type !== 0 && type !== 1 && type !== 2) ||
      buf[off + 1] !== 0 ||
      buf[off + 2] !== 0 ||
      buf[off + 3] !== 0
    )
      return buf
    const size = buf.readUInt32BE(off + 4)
    if (off + 8 + size > buf.length) return buf
    parts.push(buf.subarray(off + 8, off + 8 + size))
    off += 8 + size
  }
  return Buffer.concat(parts)
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 48) || 'unknown'

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, rej) => {
        t = setTimeout(() => rej(new Error(`timed out after ${ms} ms`)), ms)
      }),
    ])
  } finally {
    if (t) clearTimeout(t)
  }
}

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

/** Save a container's logs to the archive. Never throws; returns the file written or null. */
export async function saveContainerLogs(
  container: Pick<RemovableContainer, 'id' | 'logs'>,
  reason: string,
  opts: ArchiveOptions = {},
): Promise<string | null> {
  const dir = opts.dir ?? CONTAINER_LOG_DIR
  const log = opts.log ?? rootLogger.child({ subsys: 'containerLogArchive' })
  const maxBytes = opts.maxBytes ?? MAX_BYTES
  // a fake or odd handle may lack an id; the archive must never be the reason a removal fails
  const shortId = String((container as { id?: unknown }).id ?? 'unknown').slice(0, 12)
  try {
    const file = await withTimeout(
      (async () => {
        const raw = await container.logs({
          stdout: true,
          stderr: true,
          timestamps: true,
          tail: TAIL_LINES,
          follow: false,
        })
        let body = demuxDockerLogs(Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw)))
        if (body.length > maxBytes) body = body.subarray(body.length - maxBytes) // keep the end (the crash)
        await mkdir(dir, { recursive: true, mode: 0o700 })
        const stamp = (opts.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, '-')
        const f = path.join(dir, `${safe(shortId)}-${stamp}-${safe(reason)}.log`)
        await writeFile(f, body, { mode: 0o600 })
        return f
      })(),
      opts.timeoutMs ?? SAVE_TIMEOUT_MS,
    )
    stats.saved++
    await pruneContainerLogArchive(opts).catch(() => 0)
    return file
  } catch (err) {
    // already gone (removal is idempotent and often runs on absent containers): nothing to save
    if ((err as { statusCode?: number } | null)?.statusCode === 404) return null
    stats.failed++
    log.warn('container logs not saved before removal', { containerId: shortId, reason, err })
    return null
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
