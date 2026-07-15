import { expect, test } from 'vitest'
import { DEFAULT_AGENT, MAIN_AGENT, agentById, agentFromApiRow } from './agents'

test('DEFAULT_AGENT is the 全能助手 with backend id main (B-positioning)', () => {
  expect(DEFAULT_AGENT.id).toBe('main')
  expect(DEFAULT_AGENT.name).toBe('全能助手')
  expect(DEFAULT_AGENT.isDefault).toBe(true)
})

test('agentById unifies legacy general → main, unknown → main', () => {
  expect(agentById('general')).toBe(MAIN_AGENT)
  expect(agentById('main')).toBe(MAIN_AGENT)
  expect(agentById(undefined)).toBe(MAIN_AGENT)
  expect(agentById('does-not-exist')).toBe(MAIN_AGENT)
})

test('agentById never resolves the Landing-only AGENTS list (no old hardcoded agent leak)', () => {
  // Regression guard: even ids that exist in AGENTS must NOT come back — the picker
  // is data-driven; AGENTS is display-only on the landing page.
  expect(agentById('coder')).toBe(MAIN_AGENT)
  expect(agentById('research')).toBe(MAIN_AGENT)
})

test('agentFromApiRow maps a market agent (emoji + installed) and folds default→MAIN_AGENT', () => {
  const market = agentFromApiRow({
    id: 'writer-bot',
    name: '写作机器人',
    description: '润色中文',
    avatarEmoji: '✍️',
    installed: true,
    capabilityReadiness: { ready: false, needsAuthorization: ['docs-plugin'] },
  })
  expect(market.id).toBe('writer-bot')
  expect(market.avatarEmoji).toBe('✍️')
  expect(market.installed).toBe(true)
  expect(market.ready).toBe(false)
  expect(market.needsAuthorization).toEqual(['docs-plugin'])
  expect(market.icon).toBeUndefined() // market agents render via emoji, not a lucide icon

  // a row flagged default (or id main) collapses to the canonical MAIN_AGENT
  expect(agentFromApiRow({ id: 'main', name: 'x', isDefault: true })).toBe(MAIN_AGENT)
})
