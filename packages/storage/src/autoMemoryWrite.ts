/**
 * ADD-only auto memory write contract (code-level guards).
 *
 * Auto path may only create a file that does not exist and append index lines.
 * It must never rewrite/delete existing memory files, never drop/rewrite
 * existing index lines, and never touch user.md / USER.md / the always-block.
 */

import { basename } from 'node:path'
import { MEMORY_FILE_RE, parseMemoryFrontmatter } from './memoryFrontmatter.js'
import { AUTO_MEMORY_SOURCE, defaultAutoExpires } from './memoryTtl.js'
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

export function stampAutoMemoryFrontmatter(raw: string, today: string): string {
  const { fm, body } = parseMemoryFrontmatter(raw)
  const name = (fm.name || '').trim() || 'mem'
  const description = (fm.description || '').trim()
  const type = (fm.type || 'project').trim() || 'project'
  const expires = defaultAutoExpires(today)
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
