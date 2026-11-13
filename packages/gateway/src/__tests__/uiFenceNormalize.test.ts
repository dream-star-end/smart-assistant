/**
 * OCV5-482: server-side ui fence normalization stays identical to the web rule and keeps the
 * tape invariant (segments join to text).
 * Run: npx tsx --test packages/gateway/src/__tests__/uiFenceNormalize.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'

import {
  normalizeAssistantOutputUiFences,
  normalizeInlineUiFences,
} from '../uiFenceNormalize.js'

/** The rule body (from LINE_FENCE to the end of normalizeInlineUiFences) of a uiFence source file. */
function ruleBody(path: URL): string {
  const src = readFileSync(path, 'utf8')
  const start = src.indexOf('const LINE_FENCE')
  const end = src.indexOf('\n}\n', src.indexOf('export function normalizeInlineUiFences'))
  assert.ok(start >= 0 && end > start, `rule anchors missing in ${path}`)
  return src.slice(start, end + 3)
}

const SAMPLES = [
  '2```ui{"type":"next","text":"那2+2呢?"}\n```',
  '2\n```ui {"type":"next","text":"x"}\n```',
  '答案是 2```ui\n{"type":"next","text":"x"}```',
  '2\n\n```ui\n{"type":"next","text":"x"}\n```',
  '```md\n2```ui{"type":"next"}\n```\n正文',
  '    2```ui{"type":"next","text":"x"}\n后续正文',
  '正文里写 ```ui 这个写法不算围栏',
  '没有任何围栏的普通回答',
]

describe('normalizeInlineUiFences (server twin)', () => {
  test('rule body is byte-identical to web-react/src/lib/uiFence.ts', () => {
    assert.equal(
      ruleBody(new URL('../uiFenceNormalize.ts', import.meta.url)),
      ruleBody(new URL('../../../web-react/src/lib/uiFence.ts', import.meta.url)),
    )
  })

  test('expected output on every sample', () => {
    const expected = [
      '2\n```ui\n{"type":"next","text":"那2+2呢?"}\n```',
      '2\n```ui\n{"type":"next","text":"x"}\n```',
      '答案是 2\n```ui\n{"type":"next","text":"x"}\n```',
      '2\n\n```ui\n{"type":"next","text":"x"}\n```',
      '```md\n2```ui{"type":"next"}\n```\n正文',
      '    2```ui{"type":"next","text":"x"}\n后续正文',
      '正文里写 ```ui 这个写法不算围栏',
      '没有任何围栏的普通回答',
    ]
    SAMPLES.forEach((text, i) => assert.equal(normalizeInlineUiFences(text), expected[i], JSON.stringify(text)))
  })

  test('a glued prediction fence moves onto its own line', () => {
    assert.equal(
      normalizeInlineUiFences('2```ui{"type":"next","text":"那2+2呢?"}\n```'),
      '2\n```ui\n{"type":"next","text":"那2+2呢?"}\n```',
    )
  })
})

describe('normalizeAssistantOutputUiFences', () => {
  test('normalizes each segment and rebuilds text from them', () => {
    const out = normalizeAssistantOutputUiFences({
      text: '先查一下。2```ui{"type":"next","text":"x"}\n```',
      segments: [{ index: 0, text: '先查一下。', ts: 1 }, { index: 1, text: '2```ui{"type":"next","text":"x"}\n```', ts: 2 }],
    })
    assert.equal(out.segments[1]!.text, '2\n```ui\n{"type":"next","text":"x"}\n```')
    assert.equal(out.text, out.segments.map((s) => s.text).join(''))
    assert.equal(out.segments[0]!.ts, 1)
  })

  test('text without segments is normalized directly; plain output is unchanged', () => {
    assert.equal(normalizeAssistantOutputUiFences({ text: '2```ui{"type":"next","text":"x"}\n```', segments: [] }).text,
      '2\n```ui\n{"type":"next","text":"x"}\n```')
    const plain = { text: '普通回答', segments: [{ index: 0, text: '普通回答', ts: 1 }] }
    assert.deepEqual(normalizeAssistantOutputUiFences(plain), plain)
  })

  test('an output whose segments do not join to its text is returned untouched', () => {
    const odd = { text: '2```ui{"type":"next","text":"x"}\n```', segments: [{ index: 0, text: 'other', ts: 1 }] }
    assert.equal(normalizeAssistantOutputUiFences(odd), odd)
  })
})
