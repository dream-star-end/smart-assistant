/**
 * Auto-write dedup: run the Core strong-hit predicate over current memories.
 * Expired files are skipped (same as core-search), so a lapsed auto entry
 * cannot block a new write.
 */

import { MemoryDir } from './memoryDir.js'
import { isStrongLexicalDocument } from './memoryLexical.js'
import { isMemoryExpired } from './memoryTtl.js'
import { parseMemoryFrontmatter } from './memoryFrontmatter.js'
import { paths } from './paths.js'
import { readUserProfile } from './userProfile.js'

export interface StrongLexicalHit {
  hit: true
  path: string
  label: string
}

export type StrongLexicalProbe = StrongLexicalHit | { hit: false }

function ttlWarn(message: string): void {
  process.stderr.write(`[memory-ttl] ${message}\n`)
}

export async function findStrongLexicalMemory(args: {
  agentId: string
  query: string
  today: string
}): Promise<StrongLexicalProbe> {
  const query = args.query.trim()
  if (!query) return { hit: false }

  try {
    const { text } = await readUserProfile()
    if (text.trim() && isStrongLexicalDocument(query, text)) {
      return { hit: true, path: paths.sharedUserMd, label: 'user profile' }
    }
  } catch {
    // Profile is optional for dedup.
  }

  const dir = new MemoryDir(args.agentId)
  for (const meta of await dir.list()) {
    const read = await dir.read(meta.file)
    if (!read) continue
    const { fm } = parseMemoryFrontmatter(read.content)
    if (isMemoryExpired(fm.expires, args.today, ttlWarn, meta.file)) continue
    if (isStrongLexicalDocument(query, read.content)) {
      return {
        hit: true,
        path: `${dir.dirPath()}/${meta.file}`,
        label: `${meta.name} (${meta.type})`,
      }
    }
  }
  return { hit: false }
}
