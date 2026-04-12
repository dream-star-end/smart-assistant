// MemoryStore — bounded file-backed memory with char budget and injection scan.
// Ported from NousResearch/hermes-agent tools/memory_tool.py but rewritten in TS
// and per-agent instead of per-profile.
//
// Two targets per agent:
//   MEMORY.md — agent's observations (environment, conventions, lessons learned)
//   USER.md   — what the agent knows about the user (preferences, style)
//
// Entries are separated by "\n§\n". Character (not token) budgets are enforced
// because char counts are model-independent. Content is scanned for prompt
// injection and exfiltration patterns before being persisted, since these files
// get injected into the system prompt.

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
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
  [/act\s+as\s+(if|though)\s+you\s+(have\s+no|don['’]t\s+have)\s+(restrictions|limits|rules)/i, 'bypass_restrictions'],
  [/curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, 'exfil_curl'],
  [/wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, 'exfil_wget'],
  [/cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/i, 'read_secrets'],
  [/authorized_keys/i, 'ssh_backdoor'],
]

const INVISIBLE_CHARS = [
  '\u200b', '\u200c', '\u200d', '\u2060', '\ufeff',
  '\u202a', '\u202b', '\u202c', '\u202d', '\u202e',
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

export class MemoryStore {
  private memoryEntries: string[] = []
  private userEntries: string[] = []

  constructor(
    private agentId: string,
    private limits: MemoryLimits = DEFAULT_LIMITS,
  ) {}

  private pathFor(target: MemoryTarget): string {
    return target === 'user' ? paths.agentUserMd(this.agentId) : paths.agentMemoryMd(this.agentId)
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

  async load(): Promise<void> {
    this.memoryEntries = await this.readFile(this.pathFor('memory'))
    this.userEntries = await this.readFile(this.pathFor('user'))
    // Dedupe while preserving order
    this.memoryEntries = [...new Set(this.memoryEntries)]
    this.userEntries = [...new Set(this.userEntries)]
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
    await writeFile(path, content)
  }

  charCount(target: MemoryTarget): number {
    const entries = this.entriesFor(target)
    return entries.length === 0 ? 0 : entries.join(ENTRY_DELIMITER).length
  }

  async add(target: MemoryTarget, content: string): Promise<{ ok: boolean; error?: string }> {
    content = content.trim()
    if (!content) return { ok: false, error: 'empty content' }
    const scan = scanMemoryContent(content)
    if (!scan.ok) return { ok: false, error: `rejected: ${scan.reason}` }
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
  }

  async replace(
    target: MemoryTarget,
    needle: string,
    replacement: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const scan = scanMemoryContent(replacement)
    if (!scan.ok) return { ok: false, error: `rejected: ${scan.reason}` }
    const entries = this.entriesFor(target)
    const matches = entries
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.includes(needle))
    if (matches.length === 0) return { ok: false, error: 'needle not found' }
    if (matches.length > 1) return { ok: false, error: `ambiguous: ${matches.length} matches` }
    const newEntries = [...entries]
    newEntries[matches[0].i] = replacement.trim()
    this.setEntriesFor(target, newEntries)
    await this.saveTarget(target)
    return { ok: true }
  }

  async remove(target: MemoryTarget, needle: string): Promise<{ ok: boolean; error?: string }> {
    const entries = this.entriesFor(target)
    const filtered = entries.filter((e) => !e.includes(needle))
    if (filtered.length === entries.length) return { ok: false, error: 'needle not found' }
    this.setEntriesFor(target, filtered)
    await this.saveTarget(target)
    return { ok: true }
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
  async overwrite(target: MemoryTarget, fullContent: string): Promise<{ ok: boolean; error?: string }> {
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
    this.setEntriesFor(target, entries)
    await this.saveTarget(target)
    return { ok: true }
  }
}
