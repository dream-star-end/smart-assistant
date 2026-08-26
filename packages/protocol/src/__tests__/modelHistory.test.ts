import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  collectModelHistoryMediaPathHints,
  estimateModelHistoryTokens,
  estimateModelHistoryUtf8Bytes,
  modelHistoryReservedTokens,
  modelHistorySemanticText,
  sanitizePersistedModelHistoryText,
} from '../modelHistory.js'
import {
  formatMessageReplyPrompt,
  normalizeMessageReplyQuote,
} from '../messageReply.js'

test('CCB and Codex rebuilt history reserve proactive-compaction headroom', () => {
  assert.equal(modelHistoryReservedTokens('ccb'), 33_256)
  assert.equal(modelHistoryReservedTokens('codex'), 33_256)
  assert.equal(modelHistoryReservedTokens(undefined), 256)
})

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

test('model projection removes only explicitly labelled binary payloads', () => {
  const base64 = 'A'.repeat(128 * 1024)
  const semantic = modelHistorySemanticText({
    id: 'tool-image',
    role: 'tool',
    toolName: 'Read',
    output: {
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: base64 },
      note: 'keep this exact semantic note',
    },
  })
  assert.doesNotMatch(semantic, new RegExp(`A{${base64.length}}`))
  assert.match(semantic, /binary image\/jpeg omitted from model context/)
  assert.match(semantic, /base64_chars=131072/)
  assert.match(semantic, /keep this exact semantic note/)

  const ordinaryLongAscii = 'ACGT'.repeat(40_000)
  assert.equal(
    modelHistorySemanticText({ id: 'user-code', role: 'user', text: ordinaryLongAscii }),
    ordinaryLongAscii,
  )
})

test('explicit data URIs and old structured sidecars are bounded without guessing mid-blob suffixes', () => {
  const data = 'aGVsbG8='.repeat(2_000)
  const projected = modelHistorySemanticText({
    id: 'assistant-data-uri', role: 'assistant', text: `result=data:image/png;base64,${data};done`,
  })
  assert.match(projected, /binary image\/png omitted from model context/)
  assert.match(projected, /;done$/)

  const legacy = `Output: {"source":{"type":"base64","media_type":"image/png","data":"${data}"},"caption":"kept"}`
  const sanitized = sanitizePersistedModelHistoryText(legacy)
  assert.match(sanitized, /binary image\/png omitted from model context/)
  assert.match(sanitized, /"caption":"kept"/)
  const midBlobSuffix = `${data.slice(1_000)}"},"caption":"tail"}`
  assert.equal(sanitizePersistedModelHistoryText(midBlobSuffix), midBlobSuffix)
})

test('UTF-8 byte estimator charges dense ASCII and multibyte current text conservatively', () => {
  assert.equal(estimateModelHistoryUtf8Bytes('abcd'), 4)
  assert.equal(estimateModelHistoryUtf8Bytes('继续😀'), Buffer.byteLength('继续😀', 'utf8'))
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

test('reply snapshots normalize through an allow-list and share one deterministic model envelope', () => {
  const quote = normalizeMessageReplyQuote({
    messageId: 'assistant-42',
    role: 'assistant',
    text: '完整历史回答',
    injected: 'must not persist',
  })
  assert.deepEqual(quote, {
    messageId: 'assistant-42',
    role: 'assistant',
    text: '完整历史回答',
  })
  const expected = [
    '[被引用的历史消息｜发送者：助手｜消息ID：assistant-42｜原文字符数：6]',
    '完整历史回答',
    '[用户当前消息]',
    '请解释这一段',
  ].join('\n')
  assert.equal(formatMessageReplyPrompt('请解释这一段', quote), expected)
  assert.equal(
    modelHistorySemanticText({
      id: 'user-reply',
      role: 'user',
      text: '请解释这一段',
      _replyTo: quote,
    }),
    expected,
  )
  assert.equal(normalizeMessageReplyQuote({
    messageId: 'line\nbreak',
    role: 'assistant',
    text: 'x',
  }), undefined)
})

test('user history folds trusted _media paths and omits hidden, traversal, and base64', () => {
  const digest = `${'a'.repeat(64)}.png`
  const path = `/home/agent/.openclaude/uploads/${digest}`
  const semantic = modelHistorySemanticText({
    id: 'user-media',
    role: 'user',
    text: '看看这张图',
    _media: [
      {
        kind: 'image',
        url: `/api/media/${digest}`,
        mimeType: 'image/png',
        filename: '金丝雀.png',
        base64: 'AAAA',
        localSrc: 'blob:local',
      },
      { kind: 'image', url: '/api/media/secret.png', hidden: true },
      { kind: 'image', url: '/api/media/../etc/passwd' },
      { kind: 'image', url: '/api/media/%2e%2e%2fetc%2fpasswd' },
      { kind: 'file', path: '/etc/passwd', filename: 'passwd' },
      { kind: 'audio', url: `/api/media/${'b'.repeat(64)}.mp3`, mimeType: 'audio/mpeg' },
    ],
  })
  assert.match(semantic, /看看这张图/)
  assert.match(semantic, new RegExp(path.replace(/\./g, '\\.')))
  assert.match(semantic, /用户附带了以下图片/)
  assert.match(semantic, /用户附带了以下音频文件/)
  assert.match(semantic, /原名: 金丝雀.png/)
  assert.doesNotMatch(semantic, /secret\.png/)
  assert.doesNotMatch(semantic, /etc\/passwd/)
  assert.doesNotMatch(semantic, /AAAA/)
  assert.doesNotMatch(semantic, /blob:local/)
})

test('user history with only an image still emits a reconstructable path', () => {
  const digest = `${'c'.repeat(64)}.webp`
  const semantic = modelHistorySemanticText({
    id: 'user-image-only',
    role: 'user',
    text: '',
    _media: [{ kind: 'image', url: `/api/media/${digest}` }],
  })
  assert.match(semantic, new RegExp(`/home/agent/\\.openclaude/uploads/${digest}`))
  assert.doesNotMatch(semantic, /oc-vision/)
})

test('plain text user history does not grow a media path section', () => {
  assert.equal(
    modelHistorySemanticText({ id: 'user-plain', role: 'user', text: '你好' }),
    '你好',
  )
})

test('user history does not repeat a path already present in the model prompt', () => {
  const path = `/home/agent/.openclaude/uploads/${'d'.repeat(64)}.png`
  const semantic = modelHistorySemanticText({
    id: 'user-dup',
    role: 'user',
    text: '看图',
    _modelText: `看图\n${path}`,
    _media: [{ kind: 'image', url: `/api/media/${'d'.repeat(64)}.png` }],
  })
  assert.equal(semantic.split(path).length - 1, 1)
})

test('collectModelHistoryMediaPathHints uniques paths from _media and already-projected text', () => {
  const digest = `${'f'.repeat(64)}.png`
  const path = `/home/agent/.openclaude/uploads/${digest}`
  const hints = collectModelHistoryMediaPathHints([
    {
      role: 'user',
      text: `看图\n- \`${path}\``,
    },
    {
      role: 'user',
      text: '另一张',
      _media: [{ kind: 'image', url: `/api/media/${digest}` }],
    },
    {
      role: 'user',
      text: '',
      _media: [{ kind: 'file', url: `/api/media/${'0'.repeat(64)}.pdf` }],
    },
  ])
  assert.equal(hints.split(path).length - 1, 1)
  assert.match(hints, /\/home\/agent\/\.openclaude\/uploads\/0{64}\.pdf/)
  assert.equal(
    collectModelHistoryMediaPathHints([{ role: 'user', text: '你好' }]),
    '',
  )
})
