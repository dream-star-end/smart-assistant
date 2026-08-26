/**
 * Run: npx tsx --test packages/gateway/src/__tests__/emptyCompletedTurn.test.ts
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  EMPTY_COMPLETED_TURN_NOTICE,
  emptyCompletedTurnAssistantText,
  hasPlatedAssistantOutput,
  shouldAnnounceEmptyCompletedTurn,
} from '../emptyCompletedTurn.js'

describe('shouldAnnounceEmptyCompletedTurn', () => {
  it('completed + 空正文 → 注入中性说明', () => {
    assert.equal(shouldAnnounceEmptyCompletedTurn({ status: 'completed', assistantText: '' }), true)
    assert.equal(
      shouldAnnounceEmptyCompletedTurn({ status: 'completed', assistantText: '   ' }),
      true,
    )
    assert.equal(
      emptyCompletedTurnAssistantText({ status: 'completed' }),
      EMPTY_COMPLETED_TURN_NOTICE,
    )
  })

  it('有 plated 正文 → 不注入', () => {
    assert.equal(
      shouldAnnounceEmptyCompletedTurn({ status: 'completed', assistantText: '已完成' }),
      false,
    )
    assert.equal(
      emptyCompletedTurnAssistantText({ status: 'completed', assistantText: '已完成' }),
      '已完成',
    )
  })

  it('interrupted / crashed / SERVICE_RESTART / USER_CANCELLED → 不注入', () => {
    assert.equal(shouldAnnounceEmptyCompletedTurn({ status: 'interrupted' }), false)
    assert.equal(shouldAnnounceEmptyCompletedTurn({ status: 'crashed' }), false)
    assert.equal(
      shouldAnnounceEmptyCompletedTurn({ status: 'completed', errorCode: 'SERVICE_RESTART' }),
      false,
    )
    assert.equal(
      shouldAnnounceEmptyCompletedTurn({ status: 'completed', errorCode: 'USER_CANCELLED' }),
      false,
    )
  })
})

describe('hasPlatedAssistantOutput', () => {
  it('thinking / delegate_progress / tool 不算 plated', () => {
    assert.equal(
      hasPlatedAssistantOutput({
        blocks: [
          { kind: 'thinking', text: '先想想' },
          { kind: 'delegate_progress', text: '运行子任务' },
          { kind: 'tool_use', text: 'Bash' },
          { kind: 'tool_result', text: 'ok' },
        ],
      }),
      false,
    )
  })

  it('text 或 extraText 才算 plated', () => {
    assert.equal(hasPlatedAssistantOutput({ blocks: [{ kind: 'text', text: '答案' }] }), true)
    assert.equal(hasPlatedAssistantOutput({ extraText: 'auto' }), true)
    assert.equal(hasPlatedAssistantOutput({ blocks: [{ kind: 'text', text: '  ' }] }), false)
  })
})
