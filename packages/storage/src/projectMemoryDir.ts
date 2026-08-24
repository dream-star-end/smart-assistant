/**
 * Project memory files (content carriers).
 *
 * Official injection NEVER trusts MEMORY.md or a file that merely exists
 * under memory/. Callers must pass ledger rows (slug + contentSha256). A
 * direct engine Write to memory/foo.md is ignored unless a matching
 * gateway promotion record exists.
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  isForbiddenAutoMemoryTarget,
  stampAutoMemoryFrontmatter,
} from './autoMemoryWrite.js'
import {
  MEMORY_FILE_RE,
  normalizeMemoryEol,
  parseMemoryFrontmatter,
} from './memoryFrontmatter.js'
import { acquireFileLock, scanMemoryContent } from './memoryShared.js'
import {
  defaultProjectAutoExpires,
  isMemoryExpired,
  memoryCalendarDate,
} from './memoryTtl.js'
import { paths } from './paths.js'
import { BOARD_PROJECT_ID_RE } from './projectContext.js'

export const PROJECT_MEMORY_INDEX_MAX_CHARS = 8 * 1024
export const PROJECT_MEMORY_INDEX_MAX_LINES = 80
export const PROJECT_MEMORY_INDEX_MARKER = '<!-- oc-project-memdir-index v1 -->'
export const PROJECT_CANDIDATES_INDEX_MARKER = '<!-- oc-project-candidates-index v1 -->'

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

export function assertProjectMemoryFile(file: string): string {
  const base = basename(file)
  if (!MEMORY_FILE_RE.test(base) || base !== file) {
    throw new Error(`invalid project memory file: ${file}`)
  }
  return base
}

function assertBoardId(id: string): string {
  const trimmed = id.trim().toLowerCase()
  if (!BOARD_PROJECT_ID_RE.test(trimmed)) {
    throw new Error(`invalid boardProjectId: ${id}`)
  }
  return trimmed
}

function firstNonEmptyLine(body: string): string {
  for (const line of body.split('\n')) {
    const t = line.trim()
    if (t) return t
  }
  return ''
}

export interface OfficialInjectEntry {
  slug: string
  contentSha256: string
  name?: string
  description?: string
  expires?: string | null
  deprecated?: boolean
}

export interface ProjectMemoryFileRead {
  file: string
  content: string
  sha256: string
  name: string
  description: string
  expires?: string
  source?: string
}

export type ProjectCandidateWriteResult =
  | { ok: true; file: string; sha256: string; bytes: number }
  | { ok: false; error: 'invalid' | 'forbidden' | 'scan_rejected'; detail: string }

export class ProjectMemoryDir {
  readonly boardProjectId: string

  constructor(boardProjectId: string) {
    this.boardProjectId = assertBoardId(boardProjectId)
  }

  officialDir(): string {
    return paths.projectMemoryDir(this.boardProjectId)
  }

  candidateDir(): string {
    return paths.projectCandidateDir(this.boardProjectId)
  }

  officialFile(slug: string): string {
    return paths.projectMemoryFile(this.boardProjectId, assertProjectMemoryFile(slug))
  }

  candidateFile(file: string): string {
    return paths.projectCandidateFile(this.boardProjectId, assertProjectMemoryFile(file))
  }

  private lockPath(): string {
    return paths.projectMemoryLock(this.boardProjectId)
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    mkdirSync(paths.projectDir(this.boardProjectId), { recursive: true, mode: 0o700 })
    const release = await acquireFileLock(this.lockPath())
    try {
      return await fn()
    } finally {
      await release()
    }
  }

  private async atomicWrite(target: string, body: string): Promise<void> {
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    const tmp = `${target}.tmp-${randomUUID()}`
    try {
      await writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 })
      await rename(tmp, target)
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {})
      throw err
    }
  }

  async readFileIfHashMatches(
    fullPath: string,
    expectedSha256: string,
  ): Promise<ProjectMemoryFileRead | null> {
    try {
      const content = normalizeMemoryEol(await readFile(fullPath, 'utf8'))
      const sha = sha256Hex(content)
      if (sha !== expectedSha256) return null
      const { fm, body } = parseMemoryFrontmatter(content)
      const file = basename(fullPath)
      return {
        file,
        content,
        sha256: sha,
        name: (fm.name || '').trim() || file.replace(/\.md$/i, ''),
        description: (fm.description || '').trim() || firstNonEmptyLine(body),
        expires: fm.expires,
        source: fm.source,
      }
    } catch {
      return null
    }
  }

  async readOfficial(slug: string, expectedSha256: string): Promise<ProjectMemoryFileRead | null> {
    return this.readFileIfHashMatches(this.officialFile(slug), expectedSha256)
  }

  async readCandidate(file: string, expectedSha256?: string): Promise<ProjectMemoryFileRead | null> {
    try {
      const content = normalizeMemoryEol(await readFile(this.candidateFile(file), 'utf8'))
      const sha = sha256Hex(content)
      if (expectedSha256 && sha !== expectedSha256) return null
      const { fm, body } = parseMemoryFrontmatter(content)
      return {
        file,
        content,
        sha256: sha,
        name: (fm.name || '').trim() || file.replace(/\.md$/i, ''),
        description: (fm.description || '').trim() || firstNonEmptyLine(body),
        expires: fm.expires,
        source: fm.source,
      }
    } catch {
      return null
    }
  }

  /**
   * Write a candidate file. Does not touch official memory/ or MEMORY.md.
   * `conflictSuffix` (8 hex) makes a distinct filename when the slug is taken.
   */
  async writeCandidate(
    slug: string,
    content: string,
    opts: { auto?: boolean; today?: string; conflictSuffix?: string } = {},
  ): Promise<ProjectCandidateWriteResult> {
    let file: string
    try {
      file = assertProjectMemoryFile(slug)
    } catch (err) {
      return { ok: false, error: 'invalid', detail: (err as Error).message }
    }
    if (isForbiddenAutoMemoryTarget(file) || /^user\.md$/i.test(file) || file.toLowerCase() === 'project.md') {
      return { ok: false, error: 'forbidden', detail: file }
    }
    if (opts.conflictSuffix) {
      const stem = file.replace(/\.md$/i, '').slice(0, 40)
      file = assertProjectMemoryFile(`${stem}--${opts.conflictSuffix.slice(0, 8)}.md`)
    }
    const today = opts.today ?? memoryCalendarDate()
    let body = normalizeMemoryEol(content)
    if (opts.auto) {
      const { fm, body: rest } = parseMemoryFrontmatter(body)
      const expires = fm.expires?.trim() || defaultProjectAutoExpires(today)
      body = stampAutoMemoryFrontmatter(
        `---\nname: ${(fm.name || file.replace(/\.md$/i, '')).trim()}\ndescription: ${(fm.description || '').trim()}\ntype: ${(fm.type || 'project').trim() || 'project'}\nsource: auto\nexpires: ${expires}\n---\n${rest}`,
        today,
        { fallbackName: file.replace(/\.md$/i, '') },
      )
    }
    const scan = scanMemoryContent(body)
    if (!scan.ok) return { ok: false, error: 'scan_rejected', detail: scan.reason ?? 'rejected' }
    const stored = body.endsWith('\n') ? body : `${body}\n`
    const sha = sha256Hex(stored)
    await this.withLock(async () => {
      await this.atomicWrite(this.candidateFile(file), stored)
    })
    return { ok: true, file, sha256: sha, bytes: stored.length }
  }

  async copyCandidateToOfficial(
    candidateFile: string,
    officialSlug: string,
    expectedSha256: string,
  ): Promise<{ ok: true; sha256: string } | { ok: false; error: 'hash_mismatch' | 'missing' }> {
    const src = await this.readCandidate(candidateFile, expectedSha256)
    if (!src) {
      const raw = await this.readCandidate(candidateFile)
      return { ok: false, error: raw ? 'hash_mismatch' : 'missing' }
    }
    const dest = this.officialFile(officialSlug)
    await this.withLock(async () => {
      await this.atomicWrite(dest, src.content.endsWith('\n') ? src.content : `${src.content}\n`)
    })
    return { ok: true, sha256: src.sha256 }
  }

  /**
   * Prompt-hot-path renderer. Only ledger-matched, unexpired, non-deprecated
   * files are included. Tampered or missing files are skipped (not injected).
   */
  async renderOfficialIndex(
    entries: readonly OfficialInjectEntry[],
    maxChars = PROJECT_MEMORY_INDEX_MAX_CHARS,
    maxLines = PROJECT_MEMORY_INDEX_MAX_LINES,
    opts?: { today?: string },
  ): Promise<string | null> {
    const today = opts?.today ?? memoryCalendarDate()
    const lines: string[] = []
    for (const entry of entries) {
      if (entry.deprecated) continue
      if (isMemoryExpired(entry.expires ?? undefined, today)) continue
      let slug: string
      try {
        slug = assertProjectMemoryFile(entry.slug)
      } catch {
        continue
      }
      const read = await this.readOfficial(slug, entry.contentSha256)
      if (!read) continue
      const name = entry.name?.trim() || read.name
      const desc = entry.description?.trim() || read.description
      const hook = desc ? ` — ${desc}` : ''
      lines.push(`- [${name}](memory/${slug})${hook}`)
    }
    if (lines.length === 0) return null
    const notice =
      '\n\n(项目索引已截断；用 `oc-memory project-search` 或 Read `memory/<file>.md` 查看其余条目。动态事实须 live 核验。)'
    const kept = lines.slice(0, maxLines)
    let result = kept.join('\n')
    if (kept.length < lines.length || result.length > maxChars) {
      const budget = Math.max(0, maxChars - notice.length)
      while (kept.length && kept.join('\n').length > budget) kept.pop()
      result = kept.join('\n') + notice
    }
    if (result.length > maxChars) result = result.slice(0, maxChars)
    return result
  }
}

export function conflictFileName(slug: string, sha256: string): string {
  const base = assertProjectMemoryFile(slug)
  const stem = base.replace(/\.md$/i, '').slice(0, 40)
  return `${stem}--${sha256.slice(0, 8)}.md`
}

/** Convenience: join(home, 'projects', id) data root must never be advertised as cwd. */
export function projectMemoryDataRootHint(boardProjectId: string): string {
  return join(paths.projectDir(assertBoardId(boardProjectId)), 'memory')
}
