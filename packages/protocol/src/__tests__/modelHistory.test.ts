import assert from 'node:assert/strict'
import { test } from 'node:test'
import { estimateModelHistoryTokens, modelHistorySemanticText } from '../modelHistory.js'

test('tool text/output aliases appear once in semantic sidecar and token estimate', () => {
  const marker = `REAL-BASH-${'x'.repeat(64 * 1024)}-TAIL`
  const semantic = modelHistorySemanticText({
    id: 'tool-1',
    role: 'tool',
    toolName: 'Bash',
    text: marker,
    output: marker,
  })
  assert.equal(semantic, `Tool: Bash\nOutput: ${marker}`)
  assert.equal(semantic.split('REAL-BASH-').length - 1, 1)
  assert.equal(estimateModelHistoryTokens(semantic), estimateModelHistoryTokens(`Tool: Bash\nOutput: ${marker}`))
})

test('a distinct tool summary remains alongside the exact output', () => {
  assert.equal(
    modelHistorySemanticText({
      id: 'tool-2', role: 'tool', toolName: 'Fetch', text: 'HTTP 200', output: 'full body',
    }),
    'Tool: Fetch\nSummary: HTTP 200\nOutput: full body',
  )
})

test('user continuity uses the exact model-visible prompt rather than bubble presentation text', () => {
  assert.equal(
    modelHistorySemanticText({
      id: 'user-1',
      role: 'user',
      text: '请看附件',
      _modelText: '请看附件\n[attachment: exact extracted text]',
    }),
    '请看附件\n[attachment: exact extracted text]',
  )
})
