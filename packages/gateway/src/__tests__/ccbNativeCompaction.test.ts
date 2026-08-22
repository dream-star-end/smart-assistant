import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CCB_NATIVE_COMPACTION_PREFIX,
  ccbStdinUserContent,
  extractCcbNativeCompactionSummary,
  flattenCcbUserText,
  isCcbSlashCommandPrompt,
} from '../ccbNativeCompaction.js'

describe('ccbStdinUserContent', () => {
  it('keeps /compact as a string so CCB slash parsing can fire', () => {
    const prompt = '/compact preserve the user goal'
    assert.equal(ccbStdinUserContent(prompt), prompt)
  })

  it('wraps ordinary text in a single text block', () => {
    assert.deepEqual(ccbStdinUserContent('hello'), [{ type: 'text', text: 'hello' }])
  })

  it('passes multimodal blocks through unchanged', () => {
    const blocks = [
      { type: 'text', text: 'see' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'xx' } },
    ]
    assert.equal(ccbStdinUserContent(blocks), blocks)
  })
})

describe('extractCcbNativeCompactionSummary', () => {
  const continuation = `${CCB_NATIVE_COMPACTION_PREFIX} that ran out of context.\n\nSummary: native ccb`

  it('captures string synthetic continuation', () => {
    assert.match(
      extractCcbNativeCompactionSummary({
        isSynthetic: true,
        isReplay: false,
        message: { content: continuation },
      }) ?? '',
      /native ccb/,
    )
  })

  it('captures text-block synthetic continuation', () => {
    assert.match(
      extractCcbNativeCompactionSummary({
        isSynthetic: true,
        isReplay: false,
        message: { content: [{ type: 'text', text: continuation }] },
      }) ?? '',
      /native ccb/,
    )
  })

  it('captures continuation after compact_boundary even without isSynthetic', () => {
    assert.match(
      extractCcbNativeCompactionSummary({
        isSynthetic: false,
        sawCompactBoundary: true,
        message: { content: continuation },
      }) ?? '',
      /native ccb/,
    )
  })

  it('ignores replayed continuation', () => {
    assert.equal(
      extractCcbNativeCompactionSummary({
        isSynthetic: true,
        isReplay: true,
        message: { content: continuation },
      }),
      undefined,
    )
  })

  it('ignores a visible model essay that is not a native carrier', () => {
    assert.equal(
      extractCcbNativeCompactionSummary({
        isSynthetic: false,
        message: { content: '**会话状态摘要（供压缩后延续）**\n\n用户运营知识星球' },
      }),
      undefined,
    )
  })

  it('accepts result compact_summary after compact_boundary', () => {
    const text = extractCcbNativeCompactionSummary({
      sawCompactBoundary: true,
      compact_summary: 'decisions, files, next steps',
    })
    assert.match(text ?? '', /decisions, files, next steps/)
    assert.ok(text?.startsWith(CCB_NATIVE_COMPACTION_PREFIX))
  })
})

describe('slash prompt detection', () => {
  it('detects /compact and rejects wrapped text', () => {
    assert.equal(isCcbSlashCommandPrompt('/compact keep the goal'), true)
    assert.equal(isCcbSlashCommandPrompt('please compact'), false)
    assert.equal(flattenCcbUserText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb')
  })
})
