import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const baseline = new URL('../../agent-sandbox/ccb-baseline/', import.meta.url)
const read = (path: string) => readFileSync(new URL(path, baseline), 'utf8')

test('ordinary user rules describe the current runtime without repository train rules', () => {
  const claude = read('CLAUDE.md')
  assert.doesNotMatch(claude, /## 效率契约|--with-dist|host cat|\*\*T[012]\*\*|完整列车|底层模型是 Claude|OpenClaude 商业版/)
  assert.match(claude, /当前会话运行环境/)
  for (const file of ['CLAUDE.md', 'AGENTS.md']) {
    assert.doesNotMatch(read(file), /## 需要用户决策时|不看代码、不翻上下文也能拍板/)
  }
})

test('system-info uses the current skill inventory and persistent memory paths', () => {
  const skill = read('skills/system-info/SKILL.md')
  assert.doesNotMatch(skill, /底层模型是 Claude|8 个内置技能|OpenClaude 商业版/)
  assert.match(skill, /当前会话运行环境/)
  assert.ok(skill.includes('/home/agent/.openclaude/skills/'))
  assert.ok(skill.includes('/run/oc/claude-config/skills/'))
  assert.ok(skill.includes('/home/agent/.openclaude/agents/<agentId>/memory/'))
  assert.ok(skill.includes('/home/agent/.openclaude/user.md'))
  assert.match(skill, /find \/home\/agent\/\.openclaude\/agents.*-print/)
  assert.match(skill, /find \/home\/agent\/\.openclaude\/agents.*-delete/)
  assert.doesNotMatch(skill, /find \/run\/oc\/claude-config\/projects -type f -path/)
  assert.match(skill, /用户再次明确.*删除/)
  assert.match(skill, /两步之间 AI 必须停下等用户确认/)
})
