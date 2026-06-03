import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

const src = readFileSync(resolve(import.meta.dirname, '..', 'public/modules/agentTeams.js'), 'utf-8')

function extractFunction(source: string, name: string): string {
  const lines = source.split('\n')
  const start = lines.findIndex((line) => new RegExp(`\\bfunction\\s+${name}\\s*\\(`).test(line))
  if (start < 0) throw new Error(`function not found: ${name}`)
  const indent = lines[start]!.match(/^(\s*)/)?.[1] || ''
  const closing = new RegExp(`^${indent}\\}\\s*$`)
  let end = start + 1
  for (; end < lines.length; end++) {
    if (closing.test(lines[end]!)) break
  }
  return lines.slice(start, end + 1).join('\n').replace(/^export\s+/, '')
}

const buildTeamRunPrompt = new Function(
  [
    extractFunction(src, '_cleanPromptText'),
    extractFunction(src, '_memberLines'),
    extractFunction(src, 'buildTeamRunPrompt'),
    'return buildTeamRunPrompt;',
  ].join('\n'),
)() as (team: any, userText: string) => string

describe('agent team prompt builder', () => {
  it('includes only configured leader and members and preserves the user goal', () => {
    const prompt = buildTeamRunPrompt(
      {
        id: 'dev_team',
        name: '研发小队',
        description: '代码任务',
        leaderAgentId: 'architect',
        members: [
          { agentId: 'coder', role: '实现', responsibility: '修改代码并说明文件' },
          { agentId: 'reviewer', role: '审阅', responsibility: '检查风险' },
        ],
        policy: { maxParallel: 2, requireReview: true, reviewAgentId: 'reviewer' },
      },
      '给仓库加一个导出 PDF 功能',
    )

    assert.match(prompt, /coordinator: architect/)
    assert.match(prompt, /- coder: 实现 — 修改代码并说明文件/)
    assert.match(prompt, /- reviewer: 审阅 — 检查风险/)
    assert.match(prompt, /最多同时推进 2 条子任务/)
    assert.match(prompt, /优先请 reviewer 复核/)
    assert.match(prompt, /给仓库加一个导出 PDF 功能/)
    assert.doesNotMatch(prompt, /researcher/)
  })
})
