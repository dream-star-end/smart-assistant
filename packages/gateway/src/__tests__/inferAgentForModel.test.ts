import * as assert from 'node:assert/strict'
/**
 * Tests for inferAgentForModel — pure routing decision for model→agent
 * fan-out in v3 commercial.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/inferAgentForModel.test.ts
 */
import { describe, it } from 'node:test'
import type { AgentDef } from '@openclaude/storage'
import { inferAgentForModel } from '../inferAgentForModel.js'

const claudeAgent: AgentDef = { id: 'main', model: 'claude-opus-4-7' }
const codexAgent: AgentDef = {
  id: 'codex',
  model: 'gpt-5.5',
  provider: 'codex-native',
  runnerKind: 'app-server',
}
const altCodexAgent: AgentDef = {
  id: 'gpt-alt',
  model: 'gpt-5.5',
  provider: 'codex-native',
}

const fullAgents: AgentDef[] = [claudeAgent, codexAgent]
const onlyClaudeAgents: AgentDef[] = [claudeAgent]
const onlyCodexAgents: AgentDef[] = [codexAgent, altCodexAgent]
const codexWrongProvider: AgentDef[] = [
  claudeAgent,
  { id: 'codex', model: 'gpt-5.5', provider: 'something-else' as unknown as 'codex-native' },
]

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

describe('inferAgentForModel — gpt model routing', () => {
  it('routes default agent + gpt-* to id="codex"', () => {
    const r = inferAgentForModel({
      model: 'gpt-5.5',
      requestedAgentId: 'main',
      defaultAgentId: 'main',
      agents: fullAgents,
    })
    assert.deepEqual(r, { agentId: 'codex' })
  })

  it('keeps id="codex" when user explicitly requests codex agent + gpt-*', () => {
    const r = inferAgentForModel({
      model: 'gpt-5.5',
      requestedAgentId: 'codex',
      defaultAgentId: 'main',
      agents: fullAgents,
    })
    assert.deepEqual(r, { agentId: 'codex' })
  })

  it('mismatch when user explicitly picks claude agent + gpt-* model', () => {
    const r = inferAgentForModel({
      model: 'gpt-5.5',
      requestedAgentId: 'main',
      defaultAgentId: 'codex',
      agents: fullAgents,
    })
    assert.equal('error' in r, true)
    if (!('error' in r)) return
    assert.equal(r.error, 'mismatch')
  })

  it('no_codex_agent when agents list lacks an id="codex"', () => {
    const r = inferAgentForModel({
      model: 'gpt-5.5',
      requestedAgentId: 'main',
      defaultAgentId: 'main',
      agents: onlyClaudeAgents,
    })
    assert.equal('error' in r, true)
    if (!('error' in r)) return
    assert.equal(r.error, 'no_codex_agent')
    assert.match(r.reason, /no agent with id='codex'/)
  })

  it('no_codex_agent when id="codex" exists but provider is not codex-native', () => {
    const r = inferAgentForModel({
      model: 'gpt-5.5',
      requestedAgentId: 'main',
      defaultAgentId: 'main',
      agents: codexWrongProvider,
    })
    assert.equal('error' in r, true)
    if (!('error' in r)) return
    assert.equal(r.error, 'no_codex_agent')
  })

  it('does NOT use a non-id="codex" codex-native agent (fixed id only)', () => {
    // Plan v3 explicitly: "必须用确定 id `codex`, 不是第一个 provider=codex-native"
    const agents = [claudeAgent, altCodexAgent] // has provider=codex-native but id != 'codex'
    const r = inferAgentForModel({
      model: 'gpt-5.5',
      requestedAgentId: 'main',
      defaultAgentId: 'main',
      agents,
    })
    assert.equal('error' in r, true)
    if (!('error' in r)) return
    assert.equal(r.error, 'no_codex_agent')
  })

  it('unknown explicit agentId + gpt-* falls through to id="codex" route', () => {
    // Unknown agent isn't 'mismatch' (we can't know its family); downstream
    // sessionManager.submit will reject if the id is genuinely invalid.
    // But routing-wise we still send the request to codex when model is gpt.
    const r = inferAgentForModel({
      model: 'gpt-5.5',
      requestedAgentId: 'no-such-agent',
      defaultAgentId: 'main',
      agents: fullAgents,
    })
    assert.deepEqual(r, { agentId: 'codex' })
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

  it('keeps requestedAgentId for explicit non-codex + claude-* model', () => {
    const otherClaude: AgentDef = { id: 'chatgpt', model: 'claude-sonnet-4-6' }
    const r = inferAgentForModel({
      model: 'claude-sonnet-4-6',
      requestedAgentId: 'chatgpt',
      defaultAgentId: 'main',
      agents: [...fullAgents, otherClaude],
    })
    assert.deepEqual(r, { agentId: 'chatgpt' })
  })

  it('routes explicit codex agent + claude-* back to default non-codex agent', () => {
    const r = inferAgentForModel({
      model: 'claude-opus-4-7',
      requestedAgentId: 'codex',
      defaultAgentId: 'main',
      agents: fullAgents,
    })
    assert.deepEqual(r, { agentId: 'main' })
  })

  it('preserves router-rule-resolved non-default claude agent (Fix 6 contract)', () => {
    // The dispatchInbound call site MUST pass the already-resolved `agent.id`
    // as requestedAgentId (NOT `frame.agentId ?? cfg.default`). When router rules
    // pick e.g. "coder" for some claude-* models with no explicit frame.agentId,
    // we must keep "coder" — not regress back to cfg.default. This test pins the
    // contract: given the resolved id, inferAgentForModel returns it untouched.
    const coderAgent: AgentDef = { id: 'coder', model: 'claude-opus-4-7' }
    const r = inferAgentForModel({
      model: 'claude-opus-4-7',
      requestedAgentId: 'coder', // ← what dispatchInbound now passes (agent.id post-router)
      defaultAgentId: 'main',
      agents: [...fullAgents, coderAgent],
    })
    assert.deepEqual(r, { agentId: 'coder' })
  })

  it('uses the first non-codex agent for claude-* when default is codex', () => {
    const r = inferAgentForModel({
      model: 'claude-opus-4-7',
      requestedAgentId: 'codex',
      defaultAgentId: 'codex',
      agents: fullAgents,
    })
    assert.deepEqual(r, { agentId: 'main' })
  })

  it('no_compatible_agent when claude-* has no non-codex agent to route to', () => {
    const r = inferAgentForModel({
      model: 'claude-opus-4-7',
      requestedAgentId: 'codex',
      defaultAgentId: 'codex',
      agents: onlyCodexAgents,
    })
    assert.equal('error' in r, true)
    if (!('error' in r)) return
    assert.equal(r.error, 'no_compatible_agent')
  })
})

describe('inferAgentForModel — deepseek model routing', () => {
  it('keeps default non-codex agent for deepseek-*', () => {
    const r = inferAgentForModel({
      model: 'deepseek-v4-pro',
      requestedAgentId: 'main',
      defaultAgentId: 'main',
      agents: fullAgents,
    })
    assert.deepEqual(r, { agentId: 'main' })
  })

  it('keeps explicit non-codex agent for deepseek-*', () => {
    const otherClaude: AgentDef = { id: 'chatgpt', model: 'claude-sonnet-4-6' }
    const r = inferAgentForModel({
      model: 'deepseek-v4-pro',
      requestedAgentId: 'chatgpt',
      defaultAgentId: 'main',
      agents: [...fullAgents, otherClaude],
    })
    assert.deepEqual(r, { agentId: 'chatgpt' })
  })

  it('routes explicit codex agent + deepseek-* back to default non-codex agent', () => {
    const r = inferAgentForModel({
      model: 'deepseek-v4-pro',
      requestedAgentId: 'codex',
      defaultAgentId: 'main',
      agents: fullAgents,
    })
    assert.deepEqual(r, { agentId: 'main' })
  })

  it('routes unknown requested agent + deepseek-* to default non-codex agent', () => {
    const r = inferAgentForModel({
      model: 'deepseek-v4-flash',
      requestedAgentId: 'no-such-agent',
      defaultAgentId: 'main',
      agents: fullAgents,
    })
    assert.deepEqual(r, { agentId: 'main' })
  })

  it('uses the first non-codex agent when default is codex', () => {
    const otherClaude: AgentDef = { id: 'chatgpt', model: 'claude-sonnet-4-6' }
    const r = inferAgentForModel({
      model: 'deepseek-v4-pro',
      requestedAgentId: 'codex',
      defaultAgentId: 'codex',
      agents: [codexAgent, otherClaude],
    })
    assert.deepEqual(r, { agentId: 'chatgpt' })
  })

  it('no_compatible_agent when deepseek-* has no non-codex agent to route to', () => {
    const r = inferAgentForModel({
      model: 'deepseek-v4-pro',
      requestedAgentId: 'codex',
      defaultAgentId: 'codex',
      agents: onlyCodexAgents,
    })
    assert.equal('error' in r, true)
    if (!('error' in r)) return
    assert.equal(r.error, 'no_compatible_agent')
  })
})
