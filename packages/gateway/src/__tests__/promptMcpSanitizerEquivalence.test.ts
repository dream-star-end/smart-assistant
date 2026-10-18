import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PLATFORM_MCP_TOOL_NAMES, createMcpClaimSanitizer, buildPromptContext } from '../promptSlots.js'

function baseline(
  content: string,
  availableMcpTools: string[] | undefined,
): string {
  if (availableMcpTools === undefined) return content
  const available = new Set(availableMcpTools)
  let out = content
  for (const tool of PLATFORM_MCP_TOOL_NAMES) {
    if (available.has(tool)) continue
    const escaped = tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out = out.replace(new RegExp(`\\b${escaped}\\b(?:\\([^\\n\\r]*?\\))?`, 'g'), '（当前未注册）')
  }
  return out
}


test('all tool boundaries, subsets and repeated calls match the pre-change algorithm byte-for-byte', () => {
  const contents = [
    PLATFORM_MCP_TOOL_NAMES.map(name => `${name} ${name}(query) x${name} ${name}_suffix`).join('\r\n'),
    '中文 skill_view(多行\n参数) skill_view(a(b)) skill_view()\r\nproject_search(路径) 🐈',
    '',
  ]
  const sets: (string[] | undefined)[] = [undefined, [], [...PLATFORM_MCP_TOOL_NAMES]]
  for (const tool of PLATFORM_MCP_TOOL_NAMES) sets.push([tool])
  for (let mask = 0; mask < 128; mask++) {
    sets.push(PLATFORM_MCP_TOOL_NAMES.filter((_, i) => ((mask * 1664525 + i * 1013904223) >>> (i % 16)) & 1))
  }
  for (const tools of sets) {
    const sanitize = createMcpClaimSanitizer(tools)
    for (const content of contents) {
      const expected = baseline(content, tools)
      assert.equal(sanitize(content), expected)
      assert.equal(sanitize(content), expected, 'global regex must not retain lastIndex')
    }
  }
})

test('availability is captured per build, with undefined distinct from empty', () => {
  const input = ['skill_view']
  const registered = createMcpClaimSanitizer(input)
  input.length = 0
  assert.equal(registered('skill_view(query)'), 'skill_view(query)')
  assert.equal(createMcpClaimSanitizer(undefined)('skill_view(query)'), 'skill_view(query)')
  assert.equal(createMcpClaimSanitizer([])('skill_view(query)'), '（当前未注册）')
})

test('complete prompts preserve current availability and exact warm rebuild output', async () => {
  for (const provider of ['ccb', 'grok-build', 'antigravity'] as const) {
    const ctx = { agentId: 'nonexistent-sanitizer-test', provider, availableMcpTools: ['skill_view'] }
    const a = await buildPromptContext(ctx)
    const b = await buildPromptContext(ctx)
    assert.equal(a.content, b.content)
    assert.deepEqual(a.applied, b.applied)
    assert.match(a.content, /skill_view/)
    assert.doesNotMatch(a.content, /delegate_task/)
  }
})
