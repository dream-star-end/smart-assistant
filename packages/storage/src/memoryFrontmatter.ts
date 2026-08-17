/**
 * Tolerant Core-memory frontmatter parser (hand-rolled, no YAML).
 * Shared by MemoryDir, TTL filtering, and the auto-write contract.
 */

// 记忆文件名白名单:首字母数字,其后 [A-Za-z0-9_-] 最多 63 个,以 .md 结尾。
// - 禁止 `.`(除 .md 后缀)→ 备份文件 `MEMORY.md.pre-memdir.bak` 天然不匹配;
// - 禁止 `/`、`..` → 防路径穿越(与 path.basename 双保险)。
export const MEMORY_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.md$/

/** Normalize newlines; drop CR. Frontmatter / index parsing always uses \n. */
export function normalizeMemoryEol(s: string): string {
  return s.replace(/\r\n/g, '\n')
}

/**
 * Tolerant frontmatter parse:
 *  - Text must start with a `---` line and have a later `---` closer;
 *    otherwise the whole blob is body (models sometimes omit frontmatter).
 *  - `key: value` lines only. Keys are case-insensitive. Quotes around values
 *    are stripped. Malformed lines are skipped, never thrown.
 */
export function parseMemoryFrontmatter(raw: string): { fm: Record<string, string>; body: string } {
  const lines = normalizeMemoryEol(raw).split('\n')
  if (lines[0]?.trim() !== '---') return { fm: {}, body: normalizeMemoryEol(raw) }
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i
      break
    }
  }
  if (end === -1) return { fm: {}, body: normalizeMemoryEol(raw) }
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
