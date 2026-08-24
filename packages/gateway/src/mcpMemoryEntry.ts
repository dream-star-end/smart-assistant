import { constants, accessSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

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

export type McpMemoryLaunch = {
  /** Absolute command to spawn (node for the bundle / tsx fallback) or `npx`. */
  command: string
  args: string[]
  /** The file actually executed (cjs bundle or ts entry) — for logging/tests. */
  entry: string
  /** True when launching the prebuilt CJS bundle (fast path, ~no cold start). */
  bundled: boolean
}

const BUNDLE_NODE_BIN = '/usr/local/bin/node'

function readableFile(path: string): boolean {
  try {
    accessSync(path, constants.R_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Resolve the full launch descriptor for the openclaude-memory MCP server.
 *
 * Fast path: the release-built CJS bundle (`dist/oc-memory-mcp.cjs`) run by
 * `/usr/local/bin/node` — avoids the ~7s tsx cold start that grok/cursor pay
 * on every turn and CCB/codex pay on every engine spawn. Release builds
 * assert the bundle exists (fail-loud), so the tsx fallback below only runs
 * in trees that never built dist/.
 *
 * The bundle command is fixed to `/usr/local/bin/node` (runtime-image node,
 * same absolute path grok/cursor/zcode configs always used). When that binary
 * does not exist (host dev layouts), the bundle fast path is skipped so each
 * consumer keeps its exact historical fallback shape:
 *   - `fallback: 'node-tsx'` (grok/cursor/zcode): `node <tsx-cli> <entry>`,
 *     requires the co-located tsx CLI — else null (no MCP), as before.
 *   - `fallback: 'npx-tsx'` (CCB/codex): `npx tsx <entry>`, as before.
 */
export function resolveMcpMemoryLaunch(
  claudeCodePath: string | undefined,
  opts: { fallback: 'node-tsx' | 'npx-tsx'; nodeBin?: string },
): McpMemoryLaunch | null {
  const nodeBin = opts.nodeBin ?? BUNDLE_NODE_BIN
  const moduleDir = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]):/, '$1:')
  const bundleCandidates: string[] = [
    resolve(moduleDir, '../../mcp-memory/dist/oc-memory-mcp.cjs'),
    resolve(process.cwd(), 'packages/mcp-memory/dist/oc-memory-mcp.cjs'),
  ]
  if (claudeCodePath) {
    bundleCandidates.push(
      resolve(claudeCodePath, '..', 'openclaude/packages/mcp-memory/dist/oc-memory-mcp.cjs'),
    )
  }
  if (existsSync(nodeBin)) {
    for (const bundle of bundleCandidates) {
      if (readableFile(bundle)) {
        return { command: nodeBin, args: [bundle], entry: bundle, bundled: true }
      }
    }
  }
  const entry = resolveMcpMemoryEntry(claudeCodePath)
  if (!entry) return null
  if (opts.fallback === 'npx-tsx') {
    return { command: 'npx', args: ['tsx', entry], entry, bundled: false }
  }
  const tsxCli = resolve(dirname(entry), '../../../node_modules/tsx/dist/cli.mjs')
  if (!existsSync(tsxCli)) return null
  return { command: nodeBin, args: [tsxCli, entry], entry, bundled: false }
}
