// memoryDir — Core 记忆的 memdir 范式(取代 §-blob 版 MemoryStore)。
//
// 布局(权威,见设计契约):
//   索引  agents/<id>/MEMORY.md      — 首行 marker + 每条一行 `- [标题](memory/<file>.md) — 钩子`
//   记忆  agents/<id>/memory/<slug>.md — frontmatter(name/description/type)+ 正文
//
// 设计要点:
//   - 引擎(CCB/codex)原生用 Write/Edit 直接写记忆文件与索引;本类提供 API 侧的
//     受控 CRUD + 读侧对账自愈 + 注入渲染。
//   - 单一权威锁 = paths.agentMemoryLock(id):索引重写、懒迁移、记忆文件写/删 共用一把
//     per-agent 锁,与 gateway(UI PUT)/ mcp-memory 双进程写互斥。
//   - 幂等懒迁移:老 §-blob 首次被读到时(首行非 marker)拆成文件 + 建索引 + 备份原 blob。
//   - 读侧对账(reconcileIndex)是权威自愈:索引缺文件补行、行指向不存在文件剔除。
//   - 注入有两条路径,语义刻意不同:
//       renderForInjection          — 带锁 + ensureMigrated + reconcileIndex(会写盘),
//         给 API/对账/测试用,自愈索引。
//       renderForInjectionReadonly  — 纯只读,不锁、不写、不对账;prompt 热路径必须走这条,
//         缺文件/空库/读失败一律 null,漂移(死链/孤儿)原样容忍。
//     两条都逐行 scanMemoryContent 过滤 + 超 cap 截断。模型直写文件会绕过写侧校验,
//     读侧扫描才是安全权威兜底。

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import {
  collectIndexContentLines,
  existingIndexLinesPreserved,
  isForbiddenAutoMemoryTarget,
  stampAutoMemoryFrontmatter,
} from './autoMemoryWrite.js'
import { acquireKernelFileLock, type KernelFileLock } from './kernelFileLock.js'
import {
  MEMORY_FILE_RE,
  normalizeMemoryEol,
  parseMemoryFrontmatter,
} from './memoryFrontmatter.js'
import { acquireFileLock, scanMemoryContent } from './memoryShared.js'
import { isMemoryExpired, memoryCalendarDate } from './memoryTtl.js'
import { paths } from './paths.js'

export const MEMDIR_INDEX_MARKER = '<!-- oc-memdir-index v1 -->'
export { MEMORY_FILE_RE, parseMemoryFrontmatter } from './memoryFrontmatter.js'

// 单条记忆的四类语义:user(用户画像,一般走 user.md)/ feedback(纠偏)/
// project(项目/工作笔记)/ reference(参考资料)。type 只是提示,解析容错时兜底为 project。
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference'

export interface MemoryFileMeta {
  file: string // 文件名(含 .md),= 相对 memory/ 目录
  name: string // frontmatter.name,缺失兜底为去后缀文件名
  description: string // frontmatter.description,缺失兜底为正文首个非空行
  type: string // frontmatter.type,缺失兜底为 'project'
  expires?: string // frontmatter.expires,缺省表示永不过期
  source?: string // frontmatter.source,auto 写入会盖 source: auto
  mtimeMs: number
  size: number
}

export type MemoryAutoAddResult =
  | { ok: true; created: string[] }
  | { ok: false; error: string; reason: 'exists' | 'forbidden' | 'index_mutated' | 'invalid' }

type WriteResult =
  | { ok: true; version: string }
  | { ok: false; conflict: { current: string; version: string } }
  | { ok: false; error: string }

export type RemoveIfVersionResult =
  | { ok: true; removed: boolean }
  | { ok: false; conflict: { current: string; version: string } }
  | { ok: false; error: string }

export interface MemoryBatchUpsert {
  file: string
  content: string
  /** null means create-only; a string requires an exact content version. */
  expectedVersion: string | null
}

export interface MemoryBatchDelete {
  file: string
  expectedVersion: string
}

export type MemoryBatchResult =
  | { ok: true }
  | { ok: false; conflict: { file: string; current: string; version: string } }
  | { ok: false; error: string }

interface MemoryBatchJournal {
  schemaVersion: 1
  phase: 'prepared' | 'committed'
  indexOriginal: string
  entries: Array<{ file: string; original: string | null }>
}

/** sha256 前 16 位十六进制:内容指纹,用于乐观并发 version。空串也可算(确定值)。 */
function sha16(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16)
}

const normalizeEol = normalizeMemoryEol

/** 正文首个非空行(用作 description 兜底)。 */
function firstNonEmptyLine(body: string): string {
  for (const line of body.split('\n')) {
    const t = line.trim()
    if (t) return t
  }
  return ''
}

function ttlWarn(message: string): void {
  process.stderr.write(`[memory-ttl] ${message}\n`)
}

/** ascii 化 kebab slug(中文标题会被清空 → 由调用方兜底 'mem')。 */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\x20-\x7e]/g, '') // 丢非 ascii(中文等)
    .replace(/[^a-z0-9]+/g, '-') // 非字母数字 → 连字符
    .replace(/^-+|-+$/g, '') // 去首尾连字符
    .slice(0, 40)
}

export class MemoryDir {
  constructor(private readonly agentId: string) {}

  /** 记忆文件目录 agents/<id>/memory/。 */
  dirPath(): string {
    return paths.agentMemoryDir(this.agentId)
  }

  /** 索引路径 agents/<id>/MEMORY.md(**不变**的跨组件契约路径)。 */
  indexPath(): string {
    return paths.agentMemoryMd(this.agentId)
  }

  private lockPath(): string {
    return paths.agentMemoryLock(this.agentId)
  }

  private batchJournalPath(): string {
    return paths.agentMemoryBatchJournal(this.agentId)
  }

  private async withFileLock<T>(fn: () => Promise<T>): Promise<T> {
    const release = await acquireFileLock(this.lockPath())
    try {
      return await fn()
    } finally {
      await release()
    }
  }

  private async batchJournalExists(): Promise<boolean> {
    try {
      await stat(this.batchJournalPath())
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw err
    }
  }

  private async recoverBatchWithExclusiveBarrier(timeoutMs = 5_000): Promise<void> {
    const barrier = await acquireKernelFileLock(
      paths.agentMemoryBarrier(this.agentId),
      timeoutMs,
      'exclusive',
    )
    try {
      await this.withFileLock(() => this.recoverBatchLocked())
    } finally {
      await barrier.release().catch(() => {})
    }
  }

  /**
   * Shared cross-process barrier for a normal model turn or MemoryDir read/write.
   * A journal observed before/after acquisition is recovered under an exclusive
   * barrier first; once shared is held, no Auto-Dream batch can begin.
   */
  async acquireSharedBarrier(timeoutMs = 5_000): Promise<KernelFileLock> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await this.batchJournalExists()) {
        await this.recoverBatchWithExclusiveBarrier(timeoutMs)
        continue
      }
      const barrier = await acquireKernelFileLock(
        paths.agentMemoryBarrier(this.agentId),
        timeoutMs,
        'shared',
      )
      try {
        if (!(await this.batchJournalExists())) return barrier
      } catch (err) {
        await barrier.release().catch(() => {})
        throw err
      }
      await barrier.release().catch(() => {})
    }
    throw new Error('memory batch recovery did not quiesce')
  }

  private async withSharedBarrier<T>(fn: () => Promise<T>): Promise<T> {
    const barrier = await this.acquireSharedBarrier()
    try {
      return await this.withFileLock(fn)
    } finally {
      await barrier.release().catch(() => {})
    }
  }

  /** 原子写:temp + rename,避免并发读者看到半写文件 / 崩溃残留。 */
  private async atomicWrite(fullPath: string, content: string): Promise<void> {
    await mkdir(this.dirPath(), { recursive: true })
    const tmp = `${fullPath}.tmp-${randomUUID()}`
    try {
      await writeFile(tmp, content)
      await rename(tmp, fullPath)
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {})
      throw err
    }
  }

  private async writeIndexText(text: string): Promise<void> {
    const p = this.indexPath()
    const tmp = `${p}.tmp-${randomUUID()}`
    // 索引父目录是 agents/<id>/,首次写可能不存在。
    await mkdir(join(p, '..'), { recursive: true })
    try {
      await writeFile(tmp, text)
      await rename(tmp, p)
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {})
      throw err
    }
  }

  private async writeBatchJournal(journal: MemoryBatchJournal): Promise<void> {
    const p = this.batchJournalPath()
    const tmp = `${p}.tmp-${randomUUID()}`
    await mkdir(join(p, '..'), { recursive: true })
    try {
      await writeFile(tmp, JSON.stringify(journal), { mode: 0o600 })
      await rename(tmp, p)
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {})
      throw err
    }
  }

  /**
   * Recover a batch whose process died after its durable prepare marker but
   * before the atomic commit marker. Restoring the complete before-image is
   * idempotent, so another crash during recovery is safe to retry.
   */
  private async recoverBatchLocked(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.batchJournalPath(), 'utf-8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
    const parsed = JSON.parse(raw) as Partial<MemoryBatchJournal>
    if (
      parsed.schemaVersion !== 1 ||
      (parsed.phase !== 'prepared' && parsed.phase !== 'committed') ||
      typeof parsed.indexOriginal !== 'string' ||
      !Array.isArray(parsed.entries) ||
      parsed.entries.some((entry) =>
        !entry ||
        typeof entry !== 'object' ||
        typeof entry.file !== 'string' ||
        !MEMORY_FILE_RE.test(entry.file) ||
        basename(entry.file) !== entry.file ||
        (entry.original !== null && typeof entry.original !== 'string')
      )
    ) {
      throw new Error('invalid memory batch recovery journal')
    }
    if (parsed.phase === 'committed') {
      await rm(this.batchJournalPath(), { force: true })
      return
    }
    await mkdir(this.dirPath(), { recursive: true })
    for (const entry of parsed.entries as MemoryBatchJournal['entries']) {
      const full = join(this.dirPath(), entry.file)
      if (entry.original === null) await rm(full, { force: true })
      else await this.atomicWrite(full, entry.original)
    }
    await this.writeIndexText(parsed.indexOriginal)
    await rm(this.batchJournalPath(), { force: true })
  }

  private renderFileBody(name: string, description: string, type: string, body: string): string {
    // description 是单行(迁移时来自首行 slice;API 写入时模型自填),这里不做转义,
    // 只保证不含换行(调用方已保证)。frontmatter 用手写解析,无需 YAML 引号。
    const safeDesc = description.replace(/\n/g, ' ').trim()
    const trimmedBody = body.replace(/\s+$/, '')
    return `---\nname: ${name}\ndescription: ${safeDesc}\ntype: ${type}\n---\n${trimmedBody}\n`
  }

  /** 迁移时为一条 §-blob 生成唯一 slug:ascii 化标题 + 4 位内容 hash 防撞 + 批内去重。 */
  private uniqueSlug(title: string, blob: string, used: Set<string>): string {
    const hash4 = createHash('sha256').update(blob).digest('hex').slice(0, 4)
    const base = slugify(title) || 'mem'
    const slug = `${base}-${hash4}`.slice(0, 60)
    let candidate = slug
    let n = 1
    while (used.has(candidate)) {
      candidate = `${slug.slice(0, 57)}-${n}`
      n++
    }
    used.add(candidate)
    return candidate
  }

  // ── 懒迁移 ──────────────────────────────────────────────────────────

  /** 公开入口:锁内做一次幂等懒迁移。 */
  async ensureMigrated(): Promise<void> {
    await this.withSharedBarrier(() => this.ensureMigratedLocked())
  }

  /**
   * 锁内懒迁移(幂等)。触发条件与动作:
   *  - 索引不存在 → 写仅含 marker 的空索引(建立 memdir 不变量)。
   *  - 索引首行 = marker → 已迁移,直接返回(幂等)。
   *  - 索引存在但为空 blob → 写仅含 marker 的空索引。
   *  - 索引存在且首行非 marker(老 §-blob)→ 按 `\n§\n` 拆条,每条生成文件,
   *    写 marker 索引,原 blob 改名 `MEMORY.md.pre-memdir.bak`(留回滚)。
   */
  private async ensureMigratedLocked(): Promise<void> {
    const idxPath = this.indexPath()
    let raw: string | null = null
    try {
      raw = await readFile(idxPath, 'utf-8')
    } catch {
      raw = null
    }
    if (raw === null) {
      await this.writeIndexText(`${MEMDIR_INDEX_MARKER}\n`)
      return
    }
    const normalized = normalizeEol(raw)
    // 已迁移判定:marker 出现在**任何位置**即算(而非仅首行)。模型手编索引时可能在
    // marker 前混入空行/杂行——那是格式漂移,交给 reconcile 归位;若按首行严判,
    // 整份索引会被误当老 §-blob 拆成一条垃圾记忆。老 blob 不可能含 marker 串。
    if (normalized.includes(MEMDIR_INDEX_MARKER)) return
    if (normalized.trim() === '') {
      await this.writeIndexText(`${MEMDIR_INDEX_MARKER}\n`)
      return
    }

    // 老 §-blob → 拆条迁移。
    const blobs = normalized
      .split('\n§\n')
      .map((s) => s.trim())
      .filter(Boolean)
    await mkdir(this.dirPath(), { recursive: true })
    const indexLines: string[] = [MEMDIR_INDEX_MARKER]
    const used = new Set<string>()
    for (const blob of blobs) {
      const firstBlobLine = firstNonEmptyLine(blob) || blob
      const title = firstBlobLine.slice(0, 18)
      const slug = this.uniqueSlug(title, blob, used)
      const description = firstBlobLine.slice(0, 150)
      const file = `${slug}.md`
      await this.atomicWrite(
        join(this.dirPath(), file),
        this.renderFileBody(slug, description, 'project', blob),
      )
      indexLines.push(this.indexRow({ file, name: title || slug, description }))
    }
    // 先备份原 blob(索引路径),再写新索引到同一路径。
    try {
      await rename(idxPath, `${idxPath}.pre-memdir.bak`)
    } catch {
      /* 原 blob 可能已被并发处理 */
    }
    await this.writeIndexText(`${indexLines.join('\n')}\n`)
  }

  // ── 列表 / 读 / 写 / 删 ──────────────────────────────────────────────

  /** 锁内目录快照；调用方负责先完成迁移/批恢复。 */
  private async listLocked(): Promise<MemoryFileMeta[]> {
    let names: string[] = []
    try {
      names = await readdir(this.dirPath())
    } catch {
      return []
    }
    const out: MemoryFileMeta[] = []
    for (const name of names) {
      if (!MEMORY_FILE_RE.test(name)) continue
      const full = join(this.dirPath(), name)
      let st: Awaited<ReturnType<typeof stat>>
      try {
        st = await stat(full)
      } catch {
        continue
      }
      if (!st.isFile()) continue
      let raw = ''
      try {
        raw = await readFile(full, 'utf-8')
      } catch {
        continue
      }
      const { fm, body } = parseMemoryFrontmatter(raw)
      out.push({
        file: name,
        name: fm.name || name.replace(/\.md$/i, ''),
        description: fm.description || firstNonEmptyLine(body),
        type: fm.type || 'project',
        ...(fm.expires ? { expires: fm.expires } : {}),
        ...(fm.source ? { source: fm.source } : {}),
        mtimeMs: st.mtimeMs,
        size: st.size,
      })
    }
    out.sort((a, b) => b.mtimeMs - a.mtimeMs)
    return out
  }

  /**
   * 读记忆目录,逐文件解析 frontmatter(容错)。非法文件名 / 备份 / 目录项跳过。
   * 按 mtime 倒序(最近优先)。读前进入同一把锁并恢复未提交批次，因此进程
   * 崩溃后不会把半批结果暴露给 UI / prompt 构建器。
   */
  async list(): Promise<MemoryFileMeta[]> {
    return this.withSharedBarrier(async () => {
      await this.ensureMigratedLocked()
      return this.listLocked()
    })
  }

  /** 读单条记忆全文 + version。文件名非法或不存在 → null。 */
  async read(file: string): Promise<{ content: string; version: string } | null> {
    if (!MEMORY_FILE_RE.test(file) || basename(file) !== file) return null
    return this.withSharedBarrier(async () => {
      await this.ensureMigratedLocked()
      try {
        const content = await readFile(join(this.dirPath(), file), 'utf-8')
        return { content, version: sha16(content) }
      } catch {
        return null
      }
    })
  }

  /**
   * 写单条记忆(受控三态):
   *  - 文件名非法 / 写侧 scan 命中 → { ok:false, error }(scan 只作友好提示,读侧兜底才是权威)。
   *  - expectedVersion=string:盘上必须存在且 version 相等。
   *  - expectedVersion=null: create-only CAS,盘上必须仍不存在。
   *  - expectedVersion=undefined:兼容旧调用,last-writer-wins。
   *  写盘后锁内 reconcile 索引,保证新增/编辑文件的索引行在位。
   */
  async write(file: string, content: string, expectedVersion?: string | null): Promise<WriteResult> {
    if (!MEMORY_FILE_RE.test(file) || basename(file) !== file) {
      return { ok: false, error: `invalid memory file name: ${file}` }
    }
    const scan = scanMemoryContent(content)
    if (!scan.ok) return { ok: false, error: `rejected: ${scan.reason}` }
    return this.withSharedBarrier(async () => {
      await this.ensureMigratedLocked()
      const full = join(this.dirPath(), file)
      let current: string | null = null
      try {
        current = await readFile(full, 'utf-8')
      } catch {
        current = null
      }
      const currentVersion = current === null ? undefined : sha16(current)
      const conflicts =
        expectedVersion === null
          ? current !== null
          : expectedVersion !== undefined && expectedVersion !== currentVersion
      if (conflicts) {
        return {
          ok: false as const,
          conflict: { current: current ?? '', version: currentVersion ?? sha16('') },
        }
      }
      await this.atomicWrite(full, content)
      await this.reconcileIndexLocked()
      return { ok: true as const, version: sha16(content) }
    })
  }

  /** 删除单条记忆。返回是否真的删除了(文件原本存在)。删后锁内 reconcile 索引剔除悬挂行。 */
  async remove(file: string): Promise<boolean> {
    if (!MEMORY_FILE_RE.test(file) || basename(file) !== file) return false
    return this.withSharedBarrier(async () => {
      await this.ensureMigratedLocked()
      const full = join(this.dirPath(), file)
      let existed = false
      try {
        await stat(full)
        existed = true
      } catch {
        existed = false
      }
      if (existed) await rm(full, { force: true })
      await this.reconcileIndexLocked()
      return existed
    })
  }

  /**
   * Versioned delete for background reconcilers.  The read/version check and
   * unlink happen under the same memdir lock, so a foreground edit can never
   * be deleted after the caller's snapshot went stale.
   */
  async removeIfVersion(file: string, expectedVersion: string): Promise<RemoveIfVersionResult> {
    if (!MEMORY_FILE_RE.test(file) || basename(file) !== file) {
      return { ok: false, error: `invalid memory file name: ${file}` }
    }
    return this.withSharedBarrier(async () => {
      await this.ensureMigratedLocked()
      const full = join(this.dirPath(), file)
      let current: string | null = null
      try {
        current = await readFile(full, 'utf-8')
      } catch {
        current = null
      }
      if (current === null) return { ok: true as const, removed: false }
      const version = sha16(current)
      if (version !== expectedVersion) {
        return { ok: false as const, conflict: { current, version } }
      }
      await rm(full, { force: true })
      await this.reconcileIndexLocked()
      return { ok: true as const, removed: true }
    })
  }

  /**
   * All-or-nothing multi-file CAS used by background reconcilers.
   *
   * Every expected version is checked under the exclusive cross-process
   * barrier and memdir lock before the first mutation. A durable before-image
   * journal makes a process crash recoverable: prepared batches roll back on
   * the next memdir operation, while a committed marker means the complete
   * batch is authoritative.
   */
  async applyBatchCas(input: {
    upserts: readonly MemoryBatchUpsert[]
    deletes: readonly MemoryBatchDelete[]
  }): Promise<MemoryBatchResult> {
    const seen = new Set<string>()
    for (const row of input.upserts) {
      if (!MEMORY_FILE_RE.test(row.file) || basename(row.file) !== row.file) {
        return { ok: false, error: `invalid memory file name: ${row.file}` }
      }
      if (seen.has(row.file)) return { ok: false, error: `duplicate memory file: ${row.file}` }
      seen.add(row.file)
      const scan = scanMemoryContent(row.content)
      if (!scan.ok) return { ok: false, error: `rejected: ${scan.reason}` }
      if (row.expectedVersion !== null && typeof row.expectedVersion !== 'string') {
        return { ok: false, error: `invalid expected version: ${row.file}` }
      }
    }
    for (const row of input.deletes) {
      if (!MEMORY_FILE_RE.test(row.file) || basename(row.file) !== row.file) {
        return { ok: false, error: `invalid memory file name: ${row.file}` }
      }
      if (seen.has(row.file)) return { ok: false, error: `duplicate memory file: ${row.file}` }
      seen.add(row.file)
      if (!row.expectedVersion) return { ok: false, error: `invalid expected version: ${row.file}` }
    }
    if (seen.size === 0) return { ok: true }

    const barrier = await acquireKernelFileLock(
      paths.agentMemoryBarrier(this.agentId),
      5_000,
      'exclusive',
    )
    try {
      return await this.withFileLock(async () => {
        await this.recoverBatchLocked()
        await this.ensureMigratedLocked()
        const originals = new Map<string, string | null>()
        for (const file of seen) {
          try {
            originals.set(file, await readFile(join(this.dirPath(), file), 'utf-8'))
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') originals.set(file, null)
            else throw err
          }
        }
        for (const row of input.upserts) {
          const current = originals.get(row.file) ?? null
          const version = current === null ? sha16('') : sha16(current)
          const conflicts = row.expectedVersion === null
            ? current !== null
            : current === null || version !== row.expectedVersion
          if (conflicts) {
            return {
              ok: false as const,
              conflict: { file: row.file, current: current ?? '', version },
            }
          }
        }
        for (const row of input.deletes) {
          const current = originals.get(row.file) ?? null
          const version = current === null ? sha16('') : sha16(current)
          if (current === null || version !== row.expectedVersion) {
            return {
              ok: false as const,
              conflict: { file: row.file, current: current ?? '', version },
            }
          }
        }

        let indexOriginal = `${MEMDIR_INDEX_MARKER}\n`
        try {
          indexOriginal = await readFile(this.indexPath(), 'utf-8')
        } catch {
          // ensureMigratedLocked normally created it; marker-only is a safe
          // before-image if external code removed it between those operations.
        }
        const prepared: MemoryBatchJournal = {
          schemaVersion: 1,
          phase: 'prepared',
          indexOriginal,
          entries: [...originals].map(([file, original]) => ({ file, original })),
        }
        await this.writeBatchJournal(prepared)
        try {
          for (const row of input.upserts) {
            await this.atomicWrite(join(this.dirPath(), row.file), row.content)
          }
          for (const row of input.deletes) {
            await rm(join(this.dirPath(), row.file), { force: true })
          }
          await this.reconcileIndexLocked()
          await this.writeBatchJournal({ ...prepared, phase: 'committed' })
          // Cleanup is not part of commit correctness. If unlink fails, the
          // committed marker is safely discarded by the next memdir operation.
          await rm(this.batchJournalPath(), { force: true }).catch(() => {})
          return { ok: true as const }
        } catch (err) {
          try {
            await this.recoverBatchLocked()
          } catch {
            // Keep the prepared journal in place. The next memdir operation will
            // retry the idempotent rollback before exposing or mutating memory.
          }
          return {
            ok: false as const,
            error: err instanceof Error ? err.message : String(err),
          }
        }
      })
    } finally {
      await barrier.release().catch(() => {})
    }
  }

  /**
   * ADD-only auto write: create files that do not exist and append index lines.
   * Existing files are refused. Existing index lines must survive unchanged;
   * otherwise this write is rolled back. Never calls reconcileIndex (that can
   * drop or rewrite human-authored rows).
   *
   * Invariant: every file that lands on disk is stamped with `source: auto`
   * and a valid `expires` (default today+30). Callers cannot skip the TTL gate
   * by omitting frontmatter. See stampAutoMemoryFrontmatter for the write-side
   * tighten / retrieval-side loosen asymmetry.
   */
  async applyAutoAdds(input: {
    creates: readonly { file: string; content: string }[]
    /** Test seam: freeze the TTL calendar day (YYYY-MM-DD). */
    today?: string
  }): Promise<MemoryAutoAddResult> {
    const today = input.today ?? memoryCalendarDate()
    const seen = new Set<string>()
    const stampedCreates: Array<{ file: string; content: string }> = []
    for (const row of input.creates) {
      if (!MEMORY_FILE_RE.test(row.file) || basename(row.file) !== row.file) {
        return { ok: false, error: `invalid memory file name: ${row.file}`, reason: 'invalid' }
      }
      if (isForbiddenAutoMemoryTarget(row.file, this.agentId)) {
        return { ok: false, error: `auto write refused user.md: ${row.file}`, reason: 'forbidden' }
      }
      if (seen.has(row.file)) {
        return { ok: false, error: `duplicate memory file: ${row.file}`, reason: 'invalid' }
      }
      seen.add(row.file)
      const content = stampAutoMemoryFrontmatter(row.content, today, {
        warn: ttlWarn,
        context: row.file,
        fallbackName: row.file.replace(/\.md$/i, ''),
      })
      const scan = scanMemoryContent(content)
      if (!scan.ok) return { ok: false, error: `rejected: ${scan.reason}`, reason: 'invalid' }
      stampedCreates.push({ file: row.file, content })
    }
    if (seen.size === 0) return { ok: true, created: [] }

    const barrier = await acquireKernelFileLock(
      paths.agentMemoryBarrier(this.agentId),
      5_000,
      'exclusive',
    )
    try {
      return await this.withFileLock(async () => {
        await this.recoverBatchLocked()
        await this.ensureMigratedLocked()
        const accepted: Array<{ file: string; content: string }> = []
        for (const row of stampedCreates) {
          const full = join(this.dirPath(), row.file)
          if (isForbiddenAutoMemoryTarget(full, this.agentId) || full === paths.sharedUserMd) {
            return {
              ok: false as const,
              error: `auto write refused user.md: ${row.file}`,
              reason: 'forbidden' as const,
            }
          }
          try {
            await stat(full)
            return {
              ok: false as const,
              error: `auto write refused existing file: ${row.file}`,
              reason: 'exists' as const,
            }
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
          }
          accepted.push(row)
        }

        let indexOriginal = `${MEMDIR_INDEX_MARKER}\n`
        try {
          indexOriginal = normalizeEol(await readFile(this.indexPath(), 'utf-8'))
        } catch {
          // Missing index: start from the marker only. Do not reconcile.
        }
        if (!indexOriginal.startsWith(MEMDIR_INDEX_MARKER)) {
          indexOriginal = `${MEMDIR_INDEX_MARKER}\n${indexOriginal.replace(/^\n+/, '')}`
        }
        const originalLines = collectIndexContentLines(indexOriginal, MEMDIR_INDEX_MARKER)
        const appended: string[] = []
        for (const row of accepted) {
          const { fm, body } = parseMemoryFrontmatter(row.content)
          appended.push(
            this.indexRow({
              file: row.file,
              name: fm.name || row.file.replace(/\.md$/i, ''),
              description: fm.description || firstNonEmptyLine(body),
            }),
          )
        }
        const base = indexOriginal.endsWith('\n') ? indexOriginal : `${indexOriginal}\n`
        const nextIndex = `${base}${appended.join('\n')}\n`
        const nextLines = collectIndexContentLines(nextIndex, MEMDIR_INDEX_MARKER)
        if (!existingIndexLinesPreserved(originalLines, nextLines)) {
          return {
            ok: false as const,
            error: 'auto write refused: existing index lines would change',
            reason: 'index_mutated' as const,
          }
        }

        const written: string[] = []
        try {
          for (const row of accepted) {
            await this.atomicWrite(join(this.dirPath(), row.file), row.content)
            written.push(row.file)
          }
          await this.writeIndexText(nextIndex)
          const after = collectIndexContentLines(
            normalizeEol(await readFile(this.indexPath(), 'utf-8')),
            MEMDIR_INDEX_MARKER,
          )
          if (!existingIndexLinesPreserved(originalLines, after)) {
            throw new Error('index_mutated')
          }
          return { ok: true as const, created: written }
        } catch (err) {
          for (const file of written) {
            await rm(join(this.dirPath(), file), { force: true }).catch(() => {})
          }
          await this.writeIndexText(indexOriginal).catch(() => {})
          return {
            ok: false as const,
            error: err instanceof Error ? err.message : String(err),
            reason: 'index_mutated' as const,
          }
        }
      })
    } finally {
      await barrier.release().catch(() => {})
    }
  }

  // ── 索引对账 ────────────────────────────────────────────────────────

  /** 公开入口:锁内先 ensureMigrated 再双向对账,返回索引全文。 */
  async reconcileIndex(): Promise<string> {
    return this.withSharedBarrier(async () => {
      await this.ensureMigratedLocked()
      return this.reconcileIndexLocked()
    })
  }

  private indexRow(meta: { file: string; name: string; description: string }): string {
    // 整行 ≤ 150 字符:先算前缀,余量给钩子;超出截断加省略号。
    const prefix = `- [${meta.name}](memory/${meta.file}) — `
    const budget = Math.max(0, 150 - prefix.length)
    let hook = (meta.description || meta.name || '').replace(/\n/g, ' ').trim()
    if (hook.length > budget) hook = `${hook.slice(0, Math.max(0, budget - 1)).trimEnd()}…`
    return prefix + hook
  }

  /**
   * 锁内双向对账(权威自愈):
   *  - 保留索引中指向**存在**文件的行(维持人写钩子文本);
   *  - 行指向不存在文件 → 剔除;
   *  - 目录中有文件但索引缺行 → 按 frontmatter 补行(mtime 倒序);
   *  - 非标准行(不含 `](memory/<file>)`)一律丢弃(索引是纯索引)。
   *  写回磁盘并返回索引全文。
   */
  private async reconcileIndexLocked(): Promise<string> {
    const files = await this.listLocked()
    const byFile = new Map(files.map((f) => [f.file, f]))
    let raw = ''
    try {
      raw = normalizeEol(await readFile(this.indexPath(), 'utf-8'))
    } catch {
      raw = ''
    }
    const out: string[] = [MEMDIR_INDEX_MARKER]
    const referenced = new Set<string>()
    for (const line of raw.split('\n')) {
      const t = line.trim()
      if (t === '' || t === MEMDIR_INDEX_MARKER) continue
      const m = line.match(/\]\(memory\/([^)]+)\)/)
      if (!m) continue // 非标准行丢弃
      const f = m[1]
      if (byFile.has(f) && !referenced.has(f)) {
        out.push(t)
        referenced.add(f)
      }
      // 指向不存在文件 → 剔除(不 push)
    }
    for (const meta of files) {
      if (referenced.has(meta.file)) continue
      out.push(this.indexRow(meta))
      referenced.add(meta.file)
    }
    const text = `${out.join('\n')}\n`
    await this.writeIndexText(text)
    return text
  }

  // ── 注入渲染 ────────────────────────────────────────────────────────

  /** 从 kept 行里按 budget 逐行拼接(行边界截断)。 */
  private truncateAtLine(lines: string[], budget: number): string {
    const acc: string[] = []
    let len = 0
    for (const l of lines) {
      const add = (acc.length ? 1 : 0) + l.length // +1 换行
      if (len + add > budget) break
      acc.push(l)
      len += add
    }
    return acc.join('\n')
  }

  /**
   * Drop index rows whose target file has a valid `expires` before `today`.
   * Unreadable / missing files stay (readonly drift tolerance). Invalid
   * expires stay (fail-open) and emit a warn.
   */
  private async dropExpiredIndexLines(indexText: string, today: string): Promise<string> {
    const out: string[] = []
    for (const line of indexText.split('\n')) {
      const match = line.match(/\]\(memory\/([^)]+)\)/)
      if (!match) {
        out.push(line)
        continue
      }
      const file = match[1]
      if (!MEMORY_FILE_RE.test(file)) {
        out.push(line)
        continue
      }
      try {
        const raw = await readFile(join(this.dirPath(), file), 'utf-8')
        const { fm } = parseMemoryFrontmatter(raw)
        if (isMemoryExpired(fm.expires, today, ttlWarn, file)) continue
      } catch {
        // Keep dead links / unreadable files. Expiry only applies when we can read.
      }
      out.push(line)
    }
    return out.join('\n')
  }

  /**
   * 把索引文本滤成可注入正文:跳过 marker/空行,逐行 scan,超 cap 按行边界截断。
   * 两条注入路径共用,保证截断/扫描口径一致。
   */
  private formatIndexLinesForInjection(
    indexText: string,
    maxChars: number,
    maxLines: number,
  ): string | null {
    const kept: string[] = []
    for (const line of indexText.split('\n')) {
      const t = line.trim()
      if (t === '' || t === MEMDIR_INDEX_MARKER) continue
      if (!scanMemoryContent(line).ok) continue // 读侧权威扫描:剔除注入行
      kept.push(line)
    }
    if (kept.length === 0) return null
    const notice = '\n…（索引已截断，用 `oc-memory core-search` 查完整列表）'
    const lineLimited = kept.length > maxLines ? kept.slice(0, maxLines) : kept
    let result = lineLimited.join('\n')
    if (kept.length <= maxLines && result.length <= maxChars) return result
    const budget = Math.max(0, maxChars - notice.length)
    return this.truncateAtLine(lineLimited, budget) + notice
  }

  /**
   * 渲染索引供 system prompt 注入(带锁自愈路径):
   *  ensureMigrated → reconcileIndex → 滤行/截断。会写回索引、空库会落 marker。
   *  **prompt 热路径不要用这个**;生产注入走 renderForInjectionReadonly。
   *  本方法语义保持给 API/对账/既有测试:调用后磁盘可能变化。
   *
   *  默认 200 行 / 由调用方传入的字符上限对齐 Claude Code MEMORY.md
   *  (200 行或 25 KB,先到为准)。
   */
  async renderForInjection(
    maxChars: number,
    maxLines = 200,
    opts?: { today?: string },
  ): Promise<string | null> {
    return this.withSharedBarrier(async () => {
      await this.ensureMigratedLocked()
      const indexText = await this.reconcileIndexLocked()
      const today = opts?.today ?? memoryCalendarDate()
      const filtered = await this.dropExpiredIndexLines(indexText, today)
      return this.formatIndexLinesForInjection(filtered, maxChars, maxLines)
    })
  }

  /**
   * prompt 热路径专用:纯只读渲染索引。
   *  - 不取共享屏障 / 文件锁,不 ensureMigrated,不 reconcileIndex,不写盘。
   *  - 索引文件缺失、为空、仅 marker、有效行全被 scan 剔除 → null。
   *  - 漂移容忍:死链行照注,memory/ 里的孤儿文件不补进索引(因为根本不对账)。
   *  - 任何读/解析异常(含并发写撕成半截导致 readFile 抛错)→ null,不抛给调用方。
   *    MemoryDir 自己的写用 temp+rename,读者看到的是完整旧文件或完整新文件;
   *    引擎原生 Write/Edit 可能就地覆盖,那时宁可本轮不注入也不能阻塞 turn。
   */
  async renderForInjectionReadonly(
    maxChars: number,
    maxLines = 200,
    opts?: { today?: string },
  ): Promise<string | null> {
    try {
      const raw = await readFile(this.indexPath(), 'utf-8')
      const today = opts?.today ?? memoryCalendarDate()
      const filtered = await this.dropExpiredIndexLines(normalizeEol(raw), today)
      return this.formatIndexLinesForInjection(filtered, maxChars, maxLines)
    } catch {
      return null
    }
  }
}
