/**
 * 提示词渲染单测。
 *
 * Run: npx tsx --test packages/gateway/src/taskboard/__tests__/promptRender.test.ts
 */
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { TicketComment } from '../domain.js'
import { COMMENTS_CHAR_BUDGET, formatCommentsForPrompt, renderPrompt } from '../promptRender.js'

function comment(over: Partial<TicketComment> & { body: string }): TicketComment {
  return {
    id: over.id ?? 'c',
    ticketId: 't',
    authorKind: over.authorKind ?? 'human',
    author: over.author ?? 'user:default',
    body: over.body,
    runId: over.runId ?? null,
    createdAt: over.createdAt ?? 1,
  }
}

describe('renderPrompt 占位符', () => {
  const ticket = { identifier: 'OCV5-42', title: '登录 500', body: '## 复现步骤\n点登录' }
  const stage = { name: '复现确认', exitChecklist: '复现结论明确;步骤可照做。' }

  it('替换全部已知占位,并附加 checklist 与产出格式', () => {
    const { prompt, unknownPlaceholders } = renderPrompt({
      template:
        '单号 {{ticket.identifier}} 标题 {{ticket.title}}\n{{ticket.body}}\n上次:{{last_run.summary}}\n评:{{comments}}\n表:{{stage.exit_checklist}}',
      ticket,
      stage,
      lastRun: { summary: '上次已复现' },
      comments: [comment({ body: '请先看日志' })],
    })
    assert.equal(unknownPlaceholders.length, 0)
    assert.match(prompt, /OCV5-42/)
    assert.match(prompt, /登录 500/)
    assert.match(prompt, /点登录/)
    assert.match(prompt, /上次已复现/)
    assert.match(prompt, /请先看日志/)
    assert.match(prompt, /复现结论明确/)
    assert.match(prompt, /本阶段 exit checklist/)
    assert.match(prompt, /产出格式要求/)
  })

  it('未知占位符原样保留,不报错、不留空', () => {
    const { prompt, unknownPlaceholders } = renderPrompt({
      template: '你好 {{ticket.title}} {{not.a.thing}} 结尾',
      ticket,
      stage,
    })
    assert.deepEqual(unknownPlaceholders, ['not.a.thing'])
    assert.match(prompt, /\{\{not\.a\.thing\}\}/)
    assert.match(prompt, /登录 500/)
  })

  it('缺模板时用默认骨架,缺 last_run / comments 有兜底文案', () => {
    const { prompt } = renderPrompt({ template: null, ticket, stage })
    assert.match(prompt, /OCV5-42/)
    assert.match(prompt, /尚无上次 run/)
    assert.match(prompt, /暂无评论/)
  })

  it('允许 {{ ticket.title }} 带空格', () => {
    const { prompt } = renderPrompt({
      template: '{{ ticket.title }}',
      ticket,
      stage,
    })
    assert.match(prompt, /登录 500/)
  })
})

describe('formatCommentsForPrompt 截断', () => {
  it('只留最近若干条并标注省略', () => {
    const comments = Array.from({ length: 20 }, (_, i) =>
      comment({ id: `c${i}`, body: `第${i}条`, createdAt: i }),
    )
    const text = formatCommentsForPrompt(comments, 4000, 5)
    assert.match(text, /已省略较早的 15 条/)
    assert.match(text, /第19条/)
    assert.doesNotMatch(text, /第0条/)
  })

  it('超字符预算时从最早的最近条开始丢,仍留最新', () => {
    const comments = [
      comment({ id: 'old', body: 'x'.repeat(3000), createdAt: 1 }),
      comment({ id: 'new', body: '最新意见', createdAt: 2 }),
    ]
    const text = formatCommentsForPrompt(comments, 200, 12)
    assert.match(text, /最新意见/)
    assert.match(text, /已省略/)
    assert.ok(text.length <= COMMENTS_CHAR_BUDGET)
  })
})
