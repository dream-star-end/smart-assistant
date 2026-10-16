// OCV5-452: the platform engines advertise one memory-MCP tool list, and every
// canonical tool is explicitly placed (advertised or not).
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ANTIGRAVITY_MEMORY_MCP_TOOLS } from '../engine/antigravityPlatform.js'
import { _internals as cursorInternals } from '../engine/cursorAdapter.js'
import { GROK_MEMORY_MCP_TOOLS } from '../engine/grokPlatform.js'
import {
  PLATFORM_MEMORY_MCP_TOOLS,
  PLATFORM_MEMORY_MCP_TOOLS_NOT_ADVERTISED,
} from '../engine/platformMemoryMcpTools.js'
import { ZCODE_MEMORY_MCP_TOOLS } from '../engine/zcodePlatform.js'

// mcp-memory is not part of the gateway tsconfig project; load its canonical list at
// runtime (a computed specifier keeps tsc --build from pulling the file in).
const toolNamesModule = '../../../mcp-memory/src/toolNames.js'
const { MEMORY_MCP_TOOL_NAMES } = (await import(toolNamesModule)) as {
  MEMORY_MCP_TOOL_NAMES: readonly string[]
}

test('Grok, Antigravity and ZCode advertise the same list', () => {
  assert.deepEqual([...GROK_MEMORY_MCP_TOOLS], [...PLATFORM_MEMORY_MCP_TOOLS])
  assert.deepEqual([...ANTIGRAVITY_MEMORY_MCP_TOOLS], [...PLATFORM_MEMORY_MCP_TOOLS])
  assert.deepEqual([...ZCODE_MEMORY_MCP_TOOLS], [...PLATFORM_MEMORY_MCP_TOOLS])
})

test('ZCode advertises present_task_approval (missed when e87e3723a added it)', () => {
  assert.ok((ZCODE_MEMORY_MCP_TOOLS as readonly string[]).includes('present_task_approval'))
})

test('every canonical memory-MCP tool is either advertised or explicitly not', () => {
  const advertised = new Set<string>(PLATFORM_MEMORY_MCP_TOOLS)
  const notAdvertised = new Set<string>(PLATFORM_MEMORY_MCP_TOOLS_NOT_ADVERTISED)
  for (const t of advertised) assert.equal(notAdvertised.has(t), false, `${t} is in both lists`)
  const placed = new Set([...advertised, ...notAdvertised])
  const canonical = new Set<string>(MEMORY_MCP_TOOL_NAMES)
  for (const t of canonical) {
    assert.ok(placed.has(t), `${t}: add it to PLATFORM_MEMORY_MCP_TOOLS or ..._NOT_ADVERTISED`)
  }
  for (const t of placed) assert.ok(canonical.has(t), `${t} is not a canonical memory-MCP tool`)
  assert.equal(advertised.size, PLATFORM_MEMORY_MCP_TOOLS.length, 'duplicate in advertised list')
})

test('Cursor advertises only canonical tools', () => {
  const canonical = new Set<string>(MEMORY_MCP_TOOL_NAMES)
  for (const t of cursorInternals.OPENCLAUDE_MEMORY_MCP_TOOLS) assert.ok(canonical.has(t), t)
})
