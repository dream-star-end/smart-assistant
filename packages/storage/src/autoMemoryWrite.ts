/**
 * ADD-only auto memory write contract (code-level guards).
 *
 * Auto path may only create a file that does not exist and append index lines.
 * It must never rewrite/delete existing memory files, never drop/rewrite
 * existing index lines, and never touch user.md / USER.md / the always-block.
 */

import { basename } from 'node:path'
import { MEMORY_FILE_RE, parseMemoryFrontmatter } from './memoryFrontmatter.js'
import {
  AUTO_MEMORY_SOURCE,
  defaultAutoExpires,
  parseMemoryExpires,
  type MemoryTtlWarn,
} from './memoryTtl.js'
import { paths } from './paths.js'

export const FORBIDDEN_AUTO_MEMORY_BASENAMES = new Set(['user.md', 'USER.md'])

export type AutoMemorySkipReason =
  | 'exists'
  | 'forbidden_user_md'
  | 'invalid_name'
  | 'strong_hit'
  | 'delete_refused'
  | 'update_refused'

export interface AutoMemorySkip {
  file: string
  reason: AutoMemorySkipReason
  detail?: string
}

export interface AutoMemoryCreate {
  file: string
  content: string
  name: string
  description: string
}

export function isForbiddenAutoMemoryTarget(file: string, agentId?: string): boolean {
  const normalized = file.replace(/\\/g, '/').trim()
  const base = basename(normalized)
  if (FORBIDDEN_AUTO_MEMORY_BASENAMES.has(base) || /^user\.md$/i.test(base)) return true
  if (normalized === paths.sharedUserMd) return true
  if (agentId && normalized === paths.agentUserMd(agentId)) return true
  if (agentId && paths.agentMemoryFile(agentId, base) === paths.sharedUserMd) return true
  if (normalized.includes('oc-user-always')) return true
  return false
}

export interface StampAutoMemoryOptions {
  warn?: MemoryTtlWarn
  context?: string
  fallbackName?: string
}

/**
 * Guarantee `source: auto` and a valid `expires` on auto-written content.
 *
 * Write vs retrieval asymmetry (intentional, do not unify):
 *  - Retrieval (`isMemoryExpired`): illegal/unparseable `expires` is treated as
 *    not expired so a parse failure cannot hide an existing memory.
 *  - Write (this function / `MemoryDir.applyAutoAdds`): illegal `expires` is
 *    replaced with today+30. An auto write must never land as "no expires"
 *    (that would be a never-expiring auto memory and bypass the TTL gate).
 * A caller-supplied valid `expires` is kept so a second stamp is idempotent.
 */
export function stampAutoMemoryFrontmatter(
  raw: string,
  today: string,
  opts?: StampAutoMemoryOptions,
): string {
  const { fm, body } = parseMemoryFrontmatter(raw)
  const name = (fm.name || '').trim() || (opts?.fallbackName || '').trim() || 'mem'
  const description = (fm.description || '').trim()
  const type = (fm.type || 'project').trim() || 'project'
  const fallback = defaultAutoExpires(today)
  const rawExpires = fm.expires
  let expires = fallback
  if (rawExpires !== undefined && rawExpires.trim() !== '') {
    const parsed = parseMemoryExpires(rawExpires)
    if (parsed) {
      expires = parsed
    } else {
      const where = opts?.context ? ` (${opts.context})` : ''
      opts?.warn?.(
        `invalid memory expires on auto write${where}: ${JSON.stringify(rawExpires)}; replacing with ${fallback} (write side tightens; retrieval treats invalid expires as not expired)`,
      )
    }
  }
  const rest = body.replace(/\s+$/, '')
  return `---\nname: ${name}\ndescription: ${description}\ntype: ${type}\nsource: ${AUTO_MEMORY_SOURCE}\nexpires: ${expires}\n---\n${rest}\n`
}

export function collectIndexContentLines(indexText: string, marker: string): string[] {
  const lines: string[] = []
  for (const line of indexText.replace(/\r\n/g, '\n').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed === marker) continue
    lines.push(trimmed)
  }
  return lines
}

/** True when every original line still appears (multiset) in the next index. */
export function existingIndexLinesPreserved(before: string[], after: string[]): boolean {
  const remaining = [...after]
  for (const line of before) {
    const at = remaining.indexOf(line)
    if (at < 0) return false
    remaining.splice(at, 1)
  }
  return true
}

export function assertValidAutoMemoryFile(file: string): boolean {
  return MEMORY_FILE_RE.test(file) && basename(file) === file
}
