/**
 * TOOLS ↔ toolNames.ts 锁步测试。
 *
 * toolNames.ts 是 openclaude-memory MCP 工具名的单一权威表:index.ts(经 toolDefs.ts)
 * 与 web-react 的 MCP_OP_META 锁步测试都从它取名。本测试把 toolDefs.ts 的真实 TOOLS
 * 名单钉到该权威表——新增/改名/删工具漏改任一侧立即红(前端漏登记会把工具卡渲染成
 * 「记忆: <英文>」兜底标签,这是本 UX 批要根治的一类回归)。
 *
 * 之所以能直接 import 校验:TOOLS / SKILL_PROPOSE_TOOL 已抽到零副作用的 toolDefs.ts,
 * 不再埋在带顶层 server.connect 的 index.ts 里(index.ts import 即连 stdio transport)。
 *
 * Run: npx tsx --test packages/mcp-memory/src/__tests__/toolNames.test.ts
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { SKILL_PROPOSE_TOOL, TOOLS } from '../toolDefs.js'
import { MEMORY_MCP_TOOL_NAMES, MEMORY_MCP_TRAIN_ONLY_TOOL_NAMES } from '../toolNames.js'

describe('TOOLS ↔ toolNames.ts 锁步', () => {
  it('TOOLS 的 name 序列逐一等于 MEMORY_MCP_TOOL_NAMES(顺序即声明顺序)', () => {
    assert.deepEqual(
      TOOLS.map((t) => t.name),
      [...MEMORY_MCP_TOOL_NAMES],
    )
  })

  it('name 集合相等且无重名(顺序无关的二次保险)', () => {
    const names = TOOLS.map((t) => t.name)
    assert.deepEqual(new Set(names), new Set(MEMORY_MCP_TOOL_NAMES))
    assert.equal(new Set(names).size, names.length, 'TOOLS 内不得有重名')
    assert.equal(names.length, MEMORY_MCP_TOOL_NAMES.length)
  })

  it('skill_propose 归 TRAIN_ONLY(训练会话专属),不在常规集内', () => {
    assert.deepEqual([SKILL_PROPOSE_TOOL.name], [...MEMORY_MCP_TRAIN_ONLY_TOOL_NAMES])
    for (const n of MEMORY_MCP_TRAIN_ONLY_TOOL_NAMES) {
      assert.ok(
        !MEMORY_MCP_TOOL_NAMES.includes(n as (typeof MEMORY_MCP_TOOL_NAMES)[number]),
        `${n} 不应同时出现在常规工具集`,
      )
    }
  })

  it('每个工具定义结构完整(name 为字符串 + 带 inputSchema)', () => {
    for (const t of [...TOOLS, SKILL_PROPOSE_TOOL]) {
      assert.equal(typeof t.name, 'string')
      assert.ok(t.name.length > 0)
      assert.ok(t.inputSchema, `${t.name} 缺 inputSchema`)
    }
  })
})
