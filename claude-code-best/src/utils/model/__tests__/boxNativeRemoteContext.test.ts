import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { boxNativeRemoteContextOwnsHistory, isLiveToolChainContinuation } from '../boxNativeRemoteContext.js'

const liveChain = [
  { type: 'user', message: { role: 'user', content: 'run the tool' } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_live', name: 'Bash', input: {} }] } },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_live', content: 'ok' }] } },
]
const freshAfterCompletedTools = [
  ...liveChain,
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
  { type: 'user', message: { role: 'user', content: 'a new question' } },
]
const freshUserAfterToolResult = [
  ...liveChain,
  { type: 'user', message: { role: 'user', content: 'a new question' } },
]
const resumedMetaContinuation = [
  ...liveChain,
  { type: 'user', isMeta: true, message: { role: 'user', content: 'Continue from where you left off.' } },
]

const ENV = 'OC_MODEL_EXECUTION_DESCRIPTOR'
const descriptor = {
  canonicalModel: 'box-api-claude-opus-5-5',
  contextWindow: 200_000,
  capabilityZero: false,
  supportsThinking: true,
  supportsVision: false,
  supportedEfforts: ['high'],
  contextOwner: 'box-native-v1',
}

describe('box native remote context', () => {
  afterEach(() => {
    delete process.env[ENV]
    delete process.env.OC_BOX_CONTEXT_OWNER
  })

  it('exact signed box model owns only a live tool continuation', () => {
    process.env[ENV] = JSON.stringify(descriptor)
    process.env.OC_BOX_CONTEXT_OWNER = 'box-native-v1'
    assert.equal(boxNativeRemoteContextOwnsHistory({
      model: 'box-api-claude-opus-5-5',
      querySource: 'sdk',
    }), false)
    assert.equal(boxNativeRemoteContextOwnsHistory({
      model: 'box-api-claude-opus-5-5',
      querySource: 'sdk',
      messages: [{ type: 'user', message: { role: 'user', content: 'x'.repeat(1000) } }],
    }), false)
    assert.equal(boxNativeRemoteContextOwnsHistory({
      model: 'box-api-claude-opus-5-5',
      querySource: 'sdk',
      messages: freshAfterCompletedTools,
    }), false)
    assert.equal(boxNativeRemoteContextOwnsHistory({
      model: 'box-api-claude-opus-5-5',
      querySource: 'sdk',
      messages: liveChain,
    }), true)
    assert.equal(boxNativeRemoteContextOwnsHistory({
      model: 'box-api-claude-opus-5-5',
      querySource: 'repl_main_thread',
      messages: liveChain,
    }), true)
    assert.equal(isLiveToolChainContinuation(liveChain), true)
    assert.equal(isLiveToolChainContinuation(freshAfterCompletedTools), false)
    assert.equal(isLiveToolChainContinuation(freshUserAfterToolResult), false)
    assert.equal(isLiveToolChainContinuation(resumedMetaContinuation), true)
    assert.equal(boxNativeRemoteContextOwnsHistory({
      model: 'box-api-claude-opus-5-5',
      querySource: 'sdk',
      messages: freshUserAfterToolResult,
    }), false)
    assert.equal(boxNativeRemoteContextOwnsHistory({
      model: 'box-api-claude-opus-5-5',
      querySource: 'sdk',
      messages: resumedMetaContinuation,
    }), true)
    assert.equal(boxNativeRemoteContextOwnsHistory({
      model: 'box-api-claude-opus-5-5',
      querySource: 'compact',
    }), false)
    assert.equal(boxNativeRemoteContextOwnsHistory({
      model: 'box-api-claude-opus-5-5',
      querySource: 'agent:worker',
    }), false)
    assert.equal(boxNativeRemoteContextOwnsHistory({
      model: 'claude-3-5-haiku-latest',
      querySource: 'sdk',
    }), false)
    assert.equal(boxNativeRemoteContextOwnsHistory({
      model: 'box-api-claude-opus-5-5',
      querySource: 'session_memory_idle',
      messages: liveChain,
    }), false)
    assert.equal(boxNativeRemoteContextOwnsHistory({
      model: 'box-api-claude-opus-5-5',
      querySource: 'sdk',
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_api', name: 'Bash', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_api', content: 'ok' }] },
      ],
    }), true)
  })

  it('no cap, wrong model, and a fake token do not own history', () => {
    process.env.OC_BOX_CONTEXT_OWNER = 'box-native-v1'
    assert.equal(boxNativeRemoteContextOwnsHistory({
      model: 'box-api-claude-opus-5-5',
      querySource: 'sdk',
    }), false)
    process.env[ENV] = JSON.stringify({ ...descriptor, canonicalModel: 'glm-5.2' })
    assert.equal(boxNativeRemoteContextOwnsHistory({
      model: 'box-api-claude-opus-5-5',
      querySource: 'sdk',
    }), false)
    process.env[ENV] = JSON.stringify({ ...descriptor, contextOwner: 'fake' })
    assert.throws(() => boxNativeRemoteContextOwnsHistory({
      model: 'box-api-claude-opus-5-5',
      querySource: 'sdk',
    }), /invalid shape/)
  })
})

describe('box native remote context: every listed model', () => {
  afterEach(() => {
    delete process.env[ENV]
  })

  for (const model of ['box-api-claude-sonnet-5-5', 'box-api-claude-haiku-4-5']) {
    it(`${model} owns a live tool continuation under its own descriptor`, () => {
      process.env[ENV] = JSON.stringify({ ...descriptor, canonicalModel: model })
      assert.equal(boxNativeRemoteContextOwnsHistory({ model, querySource: 'sdk', messages: liveChain }), true)
      assert.equal(boxNativeRemoteContextOwnsHistory({
        model, querySource: 'sdk', messages: freshAfterCompletedTools }), false)
      assert.equal(boxNativeRemoteContextOwnsHistory({ model, querySource: 'compact', messages: liveChain }), false)
    })
  }

  it('a descriptor of another model, or a model outside the list, does not own history', () => {
    process.env[ENV] = JSON.stringify(descriptor)
    assert.equal(boxNativeRemoteContextOwnsHistory({
      model: 'box-api-claude-sonnet-5-5', querySource: 'sdk', messages: liveChain }), false)
    process.env[ENV] = JSON.stringify({ ...descriptor, canonicalModel: 'box-api-claude-sonnet-5' })
    assert.equal(boxNativeRemoteContextOwnsHistory({
      model: 'box-api-claude-sonnet-5', querySource: 'sdk', messages: liveChain }), false)
  })
})
