/**
 * Auto-write dedup: run the Core strong-hit predicate over current memories.
 * Expired files are skipped (same as core-search), so a lapsed auto entry
 * cannot block a new write.
 */

import { MemoryDir } from './memoryDir.js'
import { isStrongLexicalDocument } from './memoryLexical.js'
import { isMemoryExpired } from './memoryTtl.js'
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

  // 单次快照(一次屏障 + 一次锁 + 每文件读一次)拿到元信息与全文;此前是 list() 后再逐条
  // read(),2N 次读盘 + N+1 次跨进程锁(MSC MEM-10)。entry.expires 即 frontmatter.expires。
  const dir = new MemoryDir(args.agentId)
  for (const entry of await dir.listWithContent()) {
    if (isMemoryExpired(entry.expires, args.today, ttlWarn, entry.file)) continue
    if (isStrongLexicalDocument(query, entry.content)) {
      return {
        hit: true,
        path: `${dir.dirPath()}/${entry.file}`,
        label: `${entry.name} (${entry.type})`,
      }
    }
  }
  return { hit: false }
}
