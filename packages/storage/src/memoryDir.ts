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
//   - 注入(renderForInjection)逐行 scanMemoryContent 过滤 + 超 cap 截断——模型直写文件
//     会绕过写侧校验,读侧扫描才是安全权威兜底。

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { acquireFileLock, scanMemoryContent } from './memoryShared.js'
import { paths } from './paths.js'

export const MEMDIR_INDEX_MARKER = '<!-- oc-memdir-index v1 -->'

// 记忆文件名白名单:首字母数字,其后 [A-Za-z0-9_-] 最多 63 个,以 .md 结尾。
// - 禁止 `.`(除 .md 后缀)→ 备份文件 `MEMORY.md.pre-memdir.bak` 天然不匹配;
// - 禁止 `/`、`..` → 防路径穿越(与 path.basename 双保险)。
// API 层与写侧共用此正则拒绝非法名。
export const MEMORY_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.md$/

// 单条记忆的四类语义:user(用户画像,一般走 user.md)/ feedback(纠偏)/
// project(项目/工作笔记)/ reference(参考资料)。type 只是提示,解析容错时兜底为 project。
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference'

export interface MemoryFileMeta {
  file: string // 文件名(含 .md),= 相对 memory/ 目录
  name: string // frontmatter.name,缺失兜底为去后缀文件名
  description: string // frontmatter.description,缺失兜底为正文首个非空行
  type: string // frontmatter.type,缺失兜底为 'project'
  mtimeMs: number
  size: number
}

type WriteResult =
  | { ok: true; version: string }
  | { ok: false; conflict: { current: string; version: string } }
  | { ok: false; error: string }

/** sha256 前 16 位十六进制:内容指纹,用于乐观并发 version。空串也可算(确定值)。 */
function sha16(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16)
}

/** 归一化换行,去掉 \r。frontmatter/索引解析统一按 \n 处理。 */
function normalizeEol(s: string): string {
  return s.replace(/\r\n/g, '\n')
}

/** 正文首个非空行(用作 description 兜底)。 */
function firstNonEmptyLine(body: string): string {
  for (const line of body.split('\n')) {
    const t = line.trim()
    if (t) return t
  }
  return ''
}

/**
 * 容错解析 frontmatter。规则:
 *  - 文本必须以 `---` 独占首行开头,且后面有一行 `---` 闭合,才认定有 frontmatter;
 *    否则整段视为正文(容错:模型可能漏写 frontmatter)。
 *  - frontmatter 内按 `key: value` 逐行提取(手写解析,不用 YAML —— 避免 malformed
 *    内容抛异常;key 大小写不敏感,value 去两端引号)。
 */
function parseFrontmatter(raw: string): { fm: Record<string, string>; body: string } {
  const lines = normalizeEol(raw).split('\n')
  if (lines[0]?.trim() !== '---') return { fm: {}, body: normalizeEol(raw) }
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i
      break
    }
  }
  if (end === -1) return { fm: {}, body: normalizeEol(raw) } // 无闭合 → 容错当正文
  const fm: Record<string, string> = {}
  for (let i = 1; i < end; i++) {
    const m = lines[i].match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    fm[m[1].toLowerCase()] = v
  }
  const body = lines
    .slice(end + 1)
    .join('\n')
    .replace(/^\n+/, '')
  return { fm, body }
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

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const release = await acquireFileLock(this.lockPath())
    try {
      return await fn()
    } finally {
      await release()
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
    await this.withLock(() => this.ensureMigratedLocked())
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

  /**
   * 读记忆目录,逐文件解析 frontmatter(容错)。非法文件名 / 备份 / 目录项跳过。
   * 按 mtime 倒序(最近优先)。无锁快照读(每个文件原子写,单文件视图一致)。
   */
  async list(): Promise<MemoryFileMeta[]> {
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
      const { fm, body } = parseFrontmatter(raw)
      out.push({
        file: name,
        name: fm.name || name.replace(/\.md$/i, ''),
        description: fm.description || firstNonEmptyLine(body),
        type: fm.type || 'project',
        mtimeMs: st.mtimeMs,
        size: st.size,
      })
    }
    out.sort((a, b) => b.mtimeMs - a.mtimeMs)
    return out
  }

  /** 读单条记忆全文 + version。文件名非法或不存在 → null。 */
  async read(file: string): Promise<{ content: string; version: string } | null> {
    if (!MEMORY_FILE_RE.test(file) || basename(file) !== file) return null
    try {
      const content = await readFile(join(this.dirPath(), file), 'utf-8')
      return { content, version: sha16(content) }
    } catch {
      return null
    }
  }

  /**
   * 写单条记忆(受控三态):
   *  - 文件名非法 / 写侧 scan 命中 → { ok:false, error }(scan 只作友好提示,读侧兜底才是权威)。
   *  - expectedVersion 传入且与盘上当前 version 不符 → { ok:false, conflict }(不写盘)。
   *  - 新建应传 expectedVersion=undefined → 跳过冲突检查直接写(last-writer-wins)。
   *  写盘后锁内 reconcile 索引,保证新增/编辑文件的索引行在位。
   */
  async write(file: string, content: string, expectedVersion?: string): Promise<WriteResult> {
    if (!MEMORY_FILE_RE.test(file) || basename(file) !== file) {
      return { ok: false, error: `invalid memory file name: ${file}` }
    }
    const scan = scanMemoryContent(content)
    if (!scan.ok) return { ok: false, error: `rejected: ${scan.reason}` }
    return this.withLock(async () => {
      await this.ensureMigratedLocked()
      const full = join(this.dirPath(), file)
      let current: string | null = null
      try {
        current = await readFile(full, 'utf-8')
      } catch {
        current = null
      }
      const currentVersion = current === null ? undefined : sha16(current)
      if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
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
    return this.withLock(async () => {
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

  // ── 索引对账 ────────────────────────────────────────────────────────

  /** 公开入口:锁内先 ensureMigrated 再双向对账,返回索引全文。 */
  async reconcileIndex(): Promise<string> {
    return this.withLock(async () => {
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
    const files = await this.list()
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
   * 渲染索引供 system prompt 注入:
   *  ensureMigrated → reconcileIndex → 逐行 scanMemoryContent 过滤(剔注入行)→
   *  超 maxChars 截断(附提示行)。marker 本身不注入(内部不变量)。
   *  索引为空(仅 marker、无有效行)→ 返回 null(由 gateway 决定是否仍注入指令段)。
   */
  async renderForInjection(maxChars: number): Promise<string | null> {
    return this.withLock(async () => {
      await this.ensureMigratedLocked()
      const indexText = await this.reconcileIndexLocked()
      const kept: string[] = []
      for (const line of indexText.split('\n')) {
        const t = line.trim()
        if (t === '' || t === MEMDIR_INDEX_MARKER) continue
        if (!scanMemoryContent(line).ok) continue // 读侧权威扫描:剔除注入行
        kept.push(line)
      }
      if (kept.length === 0) return null
      let result = kept.join('\n')
      if (result.length > maxChars) {
        const notice = '\n…（记忆索引较长已截断,按需 Read 对应记忆文件查看完整内容）'
        const budget = Math.max(0, maxChars - notice.length)
        result = this.truncateAtLine(kept, budget) + notice
      }
      return result
    })
  }
}
