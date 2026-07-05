// MemoryStore — bounded file-backed memory with char budget and injection scan.
// Ported from NousResearch/hermes-agent tools/memory_tool.py but rewritten in TS.
//
// Two targets:
//   MEMORY.md — agent's observations (environment, conventions, lessons learned).
//               PER-AGENT (~/.openclaude/agents/<id>/MEMORY.md). Stays isolated:
//               each agent's working notes shouldn't pollute another's role.
//   USER.md   — what we know about the user (identity, preferences, style).
//               USER-LEVEL SHARED (~/.openclaude/user.md). Any agent's learning about
//               the user reaches ALL of that user's agents. Because it is shared, all
//               user-target writes take a cross-process file lock and re-read under the
//               lock (read-modify-write) so concurrent agents don't lose updates.
//
// Entries are separated by "\n§\n". Character (not token) budgets are enforced
// because char counts are model-independent. Content is scanned for prompt
// injection and exfiltration patterns before being persisted, since these files
// get injected into the system prompt.

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { paths } from './paths.js'

export type MemoryTarget = 'memory' | 'user'

export interface MemoryLimits {
  memoryChars: number
  userChars: number
}

export const DEFAULT_LIMITS: MemoryLimits = {
  memoryChars: 4000, // ~1k tokens for MEMORY.md
  userChars: 2000, // ~500 tokens for USER.md
}

export const ENTRY_DELIMITER = '\n§\n'

// Threat patterns — reject writes that match. These files are injected into
// the model's system prompt so they're a prime target for self-injection.
const THREAT_PATTERNS: Array<[RegExp, string]> = [
  [/ignore\s+(previous|all|above|prior)\s+instructions/i, 'prompt_injection'],
  [/you\s+are\s+now\s+/i, 'role_hijack'],
  [/do\s+not\s+tell\s+the\s+user/i, 'deception_hide'],
  [/system\s+prompt\s+override/i, 'sys_prompt_override'],
  [/disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i, 'disregard_rules'],
  [
    /act\s+as\s+(if|though)\s+you\s+(have\s+no|don['’]t\s+have)\s+(restrictions|limits|rules)/i,
    'bypass_restrictions',
  ],
  [/curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, 'exfil_curl'],
  [/wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, 'exfil_wget'],
  [/cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/i, 'read_secrets'],
  [/authorized_keys/i, 'ssh_backdoor'],
]

const INVISIBLE_CHARS = [
  '\u200b',
  '\u200c',
  '\u200d',
  '\u2060',
  '\ufeff',
  '\u202a',
  '\u202b',
  '\u202c',
  '\u202d',
  '\u202e',
]

export interface ScanResult {
  ok: boolean
  reason?: string
}

export function scanMemoryContent(content: string): ScanResult {
  for (const ch of INVISIBLE_CHARS) {
    if (content.includes(ch)) {
      return {
        ok: false,
        reason: `invisible unicode character U+${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
      }
    }
  }
  for (const [re, id] of THREAT_PATTERNS) {
    if (re.test(content)) return { ok: false, reason: `threat pattern: ${id}` }
  }
  return { ok: true }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Cross-process advisory lock for the shared user.md via O_CREAT|O_EXCL lockfile.
 * Returns a release fn. Steals stale locks (mtime older than STALE_MS) to survive a
 * crashed holder; throws if it can't acquire within ACQUIRE_TIMEOUT_MS.
 */
export async function acquireUserLock(lockPath: string): Promise<() => Promise<void>> {
  const STALE_MS = 15_000
  const ACQUIRE_TIMEOUT_MS = 8_000
  const myToken = randomUUID()
  const start = Date.now()
  for (;;) {
    try {
      const fh = await open(lockPath, 'wx') // O_CREAT | O_EXCL — atomic create
      // Write an owner token so that if another writer later steals this lock (judging
      // us stale), our release won't unlink THEIR lock.
      await fh.writeFile(myToken).catch(() => {})
      await fh.close().catch(() => {})
      let released = false
      return async () => {
        if (released) return
        released = true
        // Only remove the lock if we still own it. If it was stolen+recreated by another
        // writer, leave their lock intact so mutual exclusion is preserved.
        try {
          const cur = await readFile(lockPath, 'utf-8')
          if (cur.trim() === myToken) await rm(lockPath, { force: true })
        } catch {
          /* lock already gone */
        }
      }
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err
      // Steal if stale (previous holder crashed without releasing).
      try {
        const st = await stat(lockPath)
        if (Date.now() - st.mtimeMs > STALE_MS) {
          await rm(lockPath, { force: true }).catch(() => {})
          continue
        }
      } catch {
        // lock vanished between EEXIST and stat — retry immediately
        continue
      }
      if (Date.now() - start > ACQUIRE_TIMEOUT_MS) {
        throw new Error('user memory lock acquire timeout')
      }
      await sleep(15 + Math.floor(Math.random() * 25))
    }
  }
}

export class MemoryStore {
  private memoryEntries: string[] = []
  private userEntries: string[] = []

  constructor(
    private agentId: string,
    private limits: MemoryLimits = DEFAULT_LIMITS,
  ) {}

  private pathFor(target: MemoryTarget): string {
    // user → user-level shared (volume root); memory → per-agent.
    return target === 'user' ? paths.sharedUserMd : paths.agentMemoryMd(this.agentId)
  }

  private limitFor(target: MemoryTarget): number {
    return target === 'user' ? this.limits.userChars : this.limits.memoryChars
  }

  private entriesFor(target: MemoryTarget): string[] {
    return target === 'user' ? this.userEntries : this.memoryEntries
  }

  private setEntriesFor(target: MemoryTarget, entries: string[]): void {
    if (target === 'user') this.userEntries = entries
    else this.memoryEntries = entries
  }

  // Track file mtimes to skip unnecessary disk reads
  private _memoryMtime = 0
  private _userMtime = 0

  async load(): Promise<void> {
    const memPath = this.pathFor('memory')
    const usrPath = this.pathFor('user')
    const { statSync } = await import('node:fs')
    let memMtime = 0
    let usrMtime = 0
    try { memMtime = statSync(memPath).mtimeMs } catch { /* file absent or raced */ }
    try { usrMtime = statSync(usrPath).mtimeMs } catch { /* file absent or raced */ }

    if (memMtime !== this._memoryMtime) {
      this.memoryEntries = await this.readFile(memPath)
      this.memoryEntries = [...new Set(this.memoryEntries)]
      // Scan loaded entries for injection threats (in case files were edited externally)
      this.memoryEntries = this.memoryEntries.filter(e => scanMemoryContent(e).ok)
      this._memoryMtime = memMtime
    }
    if (usrMtime !== this._userMtime) {
      this.userEntries = await this.readFile(usrPath)
      this.userEntries = [...new Set(this.userEntries)]
      this.userEntries = this.userEntries.filter(e => scanMemoryContent(e).ok)
      this._userMtime = usrMtime
    }
  }

  /** Force-reread the user entries from disk (used under the write lock so the
   *  read-modify-write sees the latest content another process may have written). */
  private async reloadUserFromDisk(): Promise<void> {
    this.userEntries = await this.readFile(this.pathFor('user'))
    this.userEntries = [...new Set(this.userEntries)].filter((e) => scanMemoryContent(e).ok)
    this._userMtime = 0 // invalidate cache; next load() re-stats
  }

  /**
   * Serialize a read-modify-write on the target. For the shared `user` target this
   * takes the cross-process lock and re-reads under it (so concurrent agents don't
   * lose updates). For per-agent `memory` there's a single writer → no lock needed.
   */
  private async withWriteGuard<T>(target: MemoryTarget, fn: () => Promise<T>): Promise<T> {
    if (target !== 'user') return fn()
    const release = await acquireUserLock(paths.sharedUserLock)
    try {
      await this.reloadUserFromDisk()
      return await fn()
    } finally {
      await release()
    }
  }

  private async readFile(path: string): Promise<string[]> {
    if (!existsSync(path)) return []
    try {
      const raw = await readFile(path, 'utf-8')
      return raw
        .split(ENTRY_DELIMITER)
        .map((s) => s.trim())
        .filter(Boolean)
    } catch {
      return []
    }
  }

  private async saveTarget(target: MemoryTarget): Promise<void> {
    const path = this.pathFor(target)
    await mkdir(dirname(path), { recursive: true })
    const content = this.entriesFor(target).join(ENTRY_DELIMITER)
    // Atomic write: temp + rename so a concurrent reader never sees a half-written file
    // (and a crash mid-write leaves the previous content intact).
    const tmp = `${path}.tmp-${randomUUID()}`
    try {
      await writeFile(tmp, content)
      await rename(tmp, path)
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {})
      throw err
    }
  }

  charCount(target: MemoryTarget): number {
    const entries = this.entriesFor(target)
    return entries.length === 0 ? 0 : entries.join(ENTRY_DELIMITER).length
  }

  /** Public read of the per-target char budget. Single authority = DEFAULT_LIMITS;
   *  surfaced so the Web UI can render remaining budget instead of hard-coding it. */
  charLimit(target: MemoryTarget): number {
    return this.limitFor(target)
  }

  async add(target: MemoryTarget, content: string): Promise<{ ok: boolean; error?: string }> {
    content = content.trim()
    if (!content) return { ok: false, error: 'empty content' }
    const scan = scanMemoryContent(content)
    if (!scan.ok) return { ok: false, error: `rejected: ${scan.reason}` }
    return this.withWriteGuard(target, async () => {
      const entries = this.entriesFor(target)
      // Dedupe: if this exact content already exists, treat as success no-op
      if (entries.includes(content)) return { ok: true }
      const newEntries = [...entries, content]
      const projected = newEntries.join(ENTRY_DELIMITER).length
      const limit = this.limitFor(target)
      if (projected > limit) {
        // Auto-trim oldest entries until it fits
        const trimmed = [...newEntries]
        while (trimmed.join(ENTRY_DELIMITER).length > limit && trimmed.length > 1) {
          trimmed.shift()
        }
        if (trimmed.join(ENTRY_DELIMITER).length > limit) {
          return { ok: false, error: `content exceeds ${limit}-char limit even alone` }
        }
        this.setEntriesFor(target, trimmed)
      } else {
        this.setEntriesFor(target, newEntries)
      }
      await this.saveTarget(target)
      return { ok: true }
    })
  }

  async replace(
    target: MemoryTarget,
    needle: string,
    replacement: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const scan = scanMemoryContent(replacement)
    if (!scan.ok) return { ok: false, error: `rejected: ${scan.reason}` }
    return this.withWriteGuard(target, async () => {
      const entries = this.entriesFor(target)
      const matches = entries.map((e, i) => ({ e, i })).filter(({ e }) => e.includes(needle))
      if (matches.length === 0) return { ok: false, error: 'needle not found' }
      if (matches.length > 1) return { ok: false, error: `ambiguous: ${matches.length} matches` }
      const newEntries = [...entries]
      newEntries[matches[0].i] = replacement.trim()
      this.setEntriesFor(target, newEntries)
      await this.saveTarget(target)
      return { ok: true }
    })
  }

  async remove(target: MemoryTarget, needle: string): Promise<{ ok: boolean; error?: string }> {
    return this.withWriteGuard(target, async () => {
      const entries = this.entriesFor(target)
      const filtered = entries.filter((e) => !e.includes(needle))
      if (filtered.length === entries.length) return { ok: false, error: 'needle not found' }
      this.setEntriesFor(target, filtered)
      await this.saveTarget(target)
      return { ok: true }
    })
  }

  read(target: MemoryTarget): string {
    return this.entriesFor(target).join(ENTRY_DELIMITER)
  }

  formatForSystemPrompt(target: MemoryTarget): string {
    const content = this.read(target)
    if (!content) return ''
    if (target === 'user') {
      return `# USER IDENTITY (重要 — 回答任何关于用户的问题时必须参考此节)\n\n${content}`
    }
    return `# My notes\n\n${content}`
  }

  // Overwrite the whole target. Used by the Web UI editor.
  async overwrite(
    target: MemoryTarget,
    fullContent: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const scan = scanMemoryContent(fullContent)
    if (!scan.ok) return { ok: false, error: `rejected: ${scan.reason}` }
    const entries = fullContent
      .split(ENTRY_DELIMITER)
      .map((s) => s.trim())
      .filter(Boolean)
    const total = entries.join(ENTRY_DELIMITER).length
    if (total > this.limitFor(target)) {
      return { ok: false, error: `content exceeds ${this.limitFor(target)}-char limit` }
    }
    return this.withWriteGuard(target, async () => {
      // Explicit full replace (UI editor). The lock still serializes it against
      // concurrent add/replace/remove; it intentionally does not merge with the
      // re-read entries (the editor is overwriting the whole document on purpose).
      this.setEntriesFor(target, entries)
      await this.saveTarget(target)
      return { ok: true }
    })
  }
}
