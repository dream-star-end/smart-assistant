import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolveCodexConversationMode, shouldAutoPlanTurn } from '../codexAutoPlanMode.js'

const codexAgent = { provider: 'codex-native', runnerKind: 'app-server' }
const mainAgent = { provider: 'claude-subscription', runnerKind: undefined }

describe('codexAutoPlanMode', () => {
  it('routes explicit plan requests to plan mode', () => {
    assert.equal(shouldAutoPlanTurn('制定一个迁移计划'), true)
    assert.equal(shouldAutoPlanTurn('先给方案，暂时不要实施'), true)
    assert.equal(shouldAutoPlanTurn('plan this first'), true)
    assert.equal(
      resolveCodexConversationMode({
        agent: codexAgent,
        model: 'gpt-5.5',
        text: '制定一个迁移计划',
        attachmentCount: 0,
      }),
      'plan',
    )
  })

  it('keeps complex GPT-5.5 engineering work in default mode for Codex autonomy', () => {
    assert.equal(
      resolveCodexConversationMode({
        agent: codexAgent,
        model: 'gpt-5.5',
        text: '修复 gateway 认证问题，然后补测试并保证前端缓存兼容',
        attachmentCount: 0,
      }),
      'default',
    )
  })

  it('keeps image/design attachment requests in default mode', () => {
    assert.equal(
      resolveCodexConversationMode({
        agent: codexAgent,
        model: 'gpt-5.5',
        text: '还原设计稿',
        attachmentCount: 1,
      }),
      'default',
    )
  })

  it('keeps simple GPT-5.5 requests in default mode', () => {
    assert.equal(
      resolveCodexConversationMode({
        agent: codexAgent,
        model: 'gpt-5.5',
        text: '把按钮文案改成保存',
        attachmentCount: 0,
      }),
      'default',
    )
  })

  it('does not re-enter plan mode for explicit implementation prompts', () => {
    assert.equal(shouldAutoPlanTurn('按上面的计划开始实施。'), false)
    assert.equal(
      resolveCodexConversationMode({
        agent: codexAgent,
        model: 'gpt-5.5',
        text: '按上面的计划开始实施。',
        attachmentCount: 0,
      }),
      'default',
    )
  })

  it('honors explicit frontend/API conversationMode overrides', () => {
    assert.equal(
      resolveCodexConversationMode({
        requestedMode: 'default',
        agent: codexAgent,
        model: 'gpt-5.5',
        text: '制定完整迁移计划',
        attachmentCount: 0,
      }),
      'default',
    )
    assert.equal(
      resolveCodexConversationMode({
        requestedMode: 'plan',
        agent: mainAgent,
        model: 'claude-opus-4-7',
        text: 'hi',
        attachmentCount: 0,
      }),
      'plan',
    )
  })

  it('does not auto-decide for non-codex agents when no mode is requested', () => {
    assert.equal(
      resolveCodexConversationMode({
        agent: mainAgent,
        model: 'claude-opus-4-7',
        text: '制定一个迁移计划',
        attachmentCount: 0,
      }),
      undefined,
    )
  })

  it('does not auto-decide for non-GPT models even on codex app-server agents', () => {
    assert.equal(
      resolveCodexConversationMode({
        agent: codexAgent,
        model: 'deepseek-v4-pro',
        text: '制定一个迁移计划',
        attachmentCount: 0,
      }),
      undefined,
    )
  })
})
