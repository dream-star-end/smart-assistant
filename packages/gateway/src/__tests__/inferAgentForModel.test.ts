import * as assert from 'node:assert/strict'
/**
 * Tests for inferAgentForModel — pure routing decision for model→agent
 * fan-out in v5 commercial.
 *
 * M1a(codex 复活):gpt-5.5 不再 fail-closed 拒绝,也不再路由到固定 id='codex'
 * 专属 agent —— engine 由 engine/registry.ts 按 model 判定(getOrCreate 收口),
 * 任意 agent 都能以 gpt-5.5 跑 codex 底座。本 helper 对 gpt-* 与 claude/deepseek
 * 等已知家族同规则:requested 存在则用之,否则回落 default。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/inferAgentForModel.test.ts
 */
import { describe, it } from 'node:test'
import type { AgentDef } from '@openclaude/storage'
import { inferAgentForModel } from '../inferAgentForModel.js'

const mainAgent: AgentDef = { id: 'main', model: 'claude-opus-4-7' }
const coderAgent: AgentDef = { id: 'coder', model: 'claude-opus-4-7' }
const fullAgents: AgentDef[] = [mainAgent, coderAgent]

describe('inferAgentForModel — pass-through cases', () => {
  it('returns requestedAgentId when model is undefined', () => {
    const r = inferAgentForModel({
      model: undefined,
      requestedAgentId: 'main',
      defaultAgentId: 'main',
      agents: fullAgents,
    })
    assert.deepEqual(r, { agentId: 'main' })
  })

  it('returns requestedAgentId for unknown model family (e.g. mistral-)', () => {
    const r = inferAgentForModel({
      model: 'mistral-large',
      requestedAgentId: 'main',
      defaultAgentId: 'main',
      agents: fullAgents,
    })
    assert.deepEqual(r, { agentId: 'main' })
  })
})

describe('inferAgentForModel — gpt model routing (M1a engine registry)', () => {
  it('keeps requested agent for gpt-5.5 (engine 由 registry 判定,不换 agent)', () => {
    const r = inferAgentForModel({
      model: 'gpt-5.5',
      requestedAgentId: 'main',
      defaultAgentId: 'main',
      agents: fullAgents,
    })
    assert.deepEqual(r, { agentId: 'main' })
  })

  it('keeps explicit non-default agent for gpt-*', () => {
    const r = inferAgentForModel({
      model: 'gpt-5-codex',
      requestedAgentId: 'coder',
      defaultAgentId: 'main',
      agents: fullAgents,
    })
    assert.deepEqual(r, { agentId: 'coder' })
  })

  it('falls back to default agent for unknown requested agent + gpt-*', () => {
    const r = inferAgentForModel({
      model: 'gpt-5.5',
      requestedAgentId: 'no-such-agent',
      defaultAgentId: 'main',
      agents: fullAgents,
    })
    assert.deepEqual(r, { agentId: 'main' })
  })

  it('no_compatible_agent when gpt-* has no agent configured at all', () => {
    const r = inferAgentForModel({
      model: 'gpt-5.5',
      requestedAgentId: 'main',
      defaultAgentId: 'main',
      agents: [],
    })
    assert.equal('error' in r, true)
    if (!('error' in r)) return
    assert.equal(r.error, 'no_compatible_agent')
  })
})

describe('inferAgentForModel — claude model routing', () => {
  it('keeps requestedAgentId for default + claude-* model', () => {
    const r = inferAgentForModel({
      model: 'claude-opus-4-7',
      requestedAgentId: 'main',
      defaultAgentId: 'main',
      agents: fullAgents,
    })
    assert.deepEqual(r, { agentId: 'main' })
  })

  it('preserves router-rule-resolved non-default claude agent (Fix 6 contract)', () => {
    const r = inferAgentForModel({
      model: 'claude-opus-4-7',
      requestedAgentId: 'coder',
      defaultAgentId: 'main',
      agents: fullAgents,
    })
    assert.deepEqual(r, { agentId: 'coder' })
  })

  it('falls back to default agent for unknown requested agent + claude-*', () => {
    const r = inferAgentForModel({
      model: 'claude-opus-4-7',
      requestedAgentId: 'no-such-agent',
      defaultAgentId: 'main',
      agents: fullAgents,
    })
    assert.deepEqual(r, { agentId: 'main' })
  })

  it('no_compatible_agent when claude-* has no agent configured', () => {
    const r = inferAgentForModel({
      model: 'claude-opus-4-7',
      requestedAgentId: 'main',
      defaultAgentId: 'main',
      agents: [],
    })
    assert.equal('error' in r, true)
    if (!('error' in r)) return
    assert.equal(r.error, 'no_compatible_agent')
  })
})

describe('inferAgentForModel — deepseek model routing', () => {
  it('keeps default agent for deepseek-*', () => {
    const r = inferAgentForModel({
      model: 'deepseek-v4-pro',
      requestedAgentId: 'main',
      defaultAgentId: 'main',
      agents: fullAgents,
    })
    assert.deepEqual(r, { agentId: 'main' })
  })

  it('keeps explicit agent for deepseek-*', () => {
    const r = inferAgentForModel({
      model: 'deepseek-v4-pro',
      requestedAgentId: 'coder',
      defaultAgentId: 'main',
      agents: fullAgents,
    })
    assert.deepEqual(r, { agentId: 'coder' })
  })

  it('routes unknown requested agent + deepseek-* to default agent', () => {
    const r = inferAgentForModel({
      model: 'deepseek-v4-flash',
      requestedAgentId: 'no-such-agent',
      defaultAgentId: 'main',
      agents: fullAgents,
    })
    assert.deepEqual(r, { agentId: 'main' })
  })
})

describe('inferAgentForModel — MiniMax model routing', () => {
  it('keeps default agent for MiniMax-M3', () => {
    const r = inferAgentForModel({
      model: 'MiniMax-M3',
      requestedAgentId: 'main',
      defaultAgentId: 'main',
      agents: fullAgents,
    })
    assert.deepEqual(r, { agentId: 'main' })
  })
})

describe('inferAgentForModel — Ark glm-5.1/glm-5.2 model routing', () => {
  it('keeps default agent for glm-5.1(兼容存量)', () => {
    const r = inferAgentForModel({
      model: 'glm-5.1',
      requestedAgentId: 'main',
      defaultAgentId: 'main',
      agents: fullAgents,
    })
    assert.deepEqual(r, { agentId: 'main' })
  })

  it('keeps default agent for glm-5.2(平台默认)', () => {
    const r = inferAgentForModel({
      model: 'glm-5.2',
      requestedAgentId: 'main',
      defaultAgentId: 'main',
      agents: fullAgents,
    })
    assert.deepEqual(r, { agentId: 'main' })
  })
})
