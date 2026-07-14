import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { inboxMarkdownToEmailText } from '../email.js'

describe('inbox rich email fallback', () => {
  test('图片和图表降级，普通 Markdown 文本保留', () => {
    const source = `# 公告

**重点**内容

![趋势图](/api/inbox-assets/550e8400-e29b-41d4-a716-446655440000)

\`\`\`chart
{"type":"bar","data":{"labels":["A"],"datasets":[]}}
\`\`\`

\`\`\`mermaid
flowchart LR
A --> B
\`\`\``
    const text = inboxMarkdownToEmailText(source)
    assert.match(text, /# 公告/)
    assert.match(text, /\*\*重点\*\*内容/)
    assert.match(text, /图片：趋势图， 请登录|图片：趋势图，请登录/)
    assert.equal((text.match(/图表请登录站内信查看/g) ?? []).length, 2)
    assert.ok(!text.includes('/api/inbox-assets/'))
    assert.ok(!text.includes('"type":"bar"'))
    assert.ok(!text.includes('flowchart LR'))
  })
})
