import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Resolve the bundled `openclaude-memory` MCP entry without importing a
 * runner. Keeping this helper runner-neutral prevents Cursor/Codex adapters
 * from creating a runtime dependency cycle through subprocessRunner.
 */
export function resolveMcpMemoryEntry(claudeCodePath?: string): string | null {
  const moduleDir = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]):/, '$1:')
  const candidates: string[] = [
    resolve(moduleDir, '../../mcp-memory/src/index.ts'),
    resolve(process.cwd(), 'packages/mcp-memory/src/index.ts'),
  ]
  if (claudeCodePath) {
    candidates.push(resolve(claudeCodePath, '..', 'openclaude/packages/mcp-memory/src/index.ts'))
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}
