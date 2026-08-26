/**
 * openclaude-memory MCP launch resolution: prebuilt CJS bundle preferred,
 * per-consumer historical tsx fallbacks preserved.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/mcpMemoryEntry.test.ts
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'

import { resolveMcpMemoryEntry, resolveMcpMemoryLaunch } from '../mcpMemoryEntry.js'

// A node binary path that never exists → bundle fast path is skipped.
const NO_NODE = '/nonexistent-oc-test-node'

describe('resolveMcpMemoryLaunch', () => {
  test('prefers the prebuilt CJS bundle when the node binary and bundle exist', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'oc-mcp-launch-'))
    try {
      // claudeCodePath-relative layout: <ccb>/../openclaude/packages/mcp-memory/…
      const ccb = path.join(root, 'claude-code-best')
      const distDir = path.join(root, 'openclaude/packages/mcp-memory/dist')
      mkdirSync(ccb, { recursive: true })
      mkdirSync(distDir, { recursive: true })
      const bundle = path.join(distDir, 'oc-memory-mcp.cjs')
      writeFileSync(bundle, '// bundle\n')
      const launch = resolveMcpMemoryLaunch(ccb, {
        fallback: 'node-tsx',
        // Use a binary guaranteed to exist so the bundle path is taken.
        nodeBin: process.execPath,
      })
      assert.ok(launch)
      assert.equal(launch.bundled, true)
      assert.equal(launch.command, process.execPath)
      // Repo-local dist may also exist in built worktrees; either way the
      // resolved target must be an oc-memory-mcp.cjs bundle run directly.
      assert.equal(launch.args.length, 1)
      assert.ok(launch.args[0]!.endsWith('oc-memory-mcp.cjs'))
      assert.equal(launch.entry, launch.args[0])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('node-tsx fallback keeps the historical node+tsx-cli shape', () => {
    const launch = resolveMcpMemoryLaunch(undefined, { fallback: 'node-tsx', nodeBin: NO_NODE })
    assert.ok(launch, 'repo layout must resolve entry + tsx cli')
    assert.equal(launch.bundled, false)
    // Command is the pinned runtime node path even when probing was skipped.
    assert.equal(launch.command, NO_NODE)
    assert.equal(launch.args.length, 2)
    assert.ok(launch.args[0]!.endsWith('node_modules/tsx/dist/cli.mjs'))
    assert.ok(launch.args[1]!.endsWith('packages/mcp-memory/src/index.ts'))
    assert.equal(launch.entry, launch.args[1])
  })

  test('npx-tsx fallback keeps the historical npx tsx shape', () => {
    const launch = resolveMcpMemoryLaunch(undefined, { fallback: 'npx-tsx', nodeBin: NO_NODE })
    assert.ok(launch)
    assert.equal(launch.bundled, false)
    assert.equal(launch.command, 'npx')
    assert.equal(launch.args[0], 'tsx')
    assert.ok(launch.args[1]!.endsWith('packages/mcp-memory/src/index.ts'))
  })

  test('fallback entry matches resolveMcpMemoryEntry (single authority)', () => {
    const entry = resolveMcpMemoryEntry()
    const launch = resolveMcpMemoryLaunch(undefined, { fallback: 'npx-tsx', nodeBin: NO_NODE })
    assert.ok(entry && launch)
    assert.equal(launch.entry, entry)
  })
})
