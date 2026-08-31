/**
 * V3 commercial — master→container 委派并发旋钮与 OC_DELEGATE 特性 flag 透传。
 *
 * 仅当 master env 值匹配 /^[0-9]+$/ 才注入(flag 值 "1"/"0" 走同一数值门);
 * 缺省/非法不注入任何键,容器侧 gateway 回落自身默认值。
 *
 * Run: npx tsx --test packages/commercial/src/__tests__/v3SupervisorDelegateKnobEnv.test.ts
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  DELEGATE_KNOB_CONTAINER_ENV_KEYS,
  buildDelegateKnobContainerEnv,
} from '../agent-sandbox/v3supervisor.js'

const KEYS = [
  'OPENCLAUDE_DELEGATE_MAX_CONCURRENT',
  'OPENCLAUDE_DELEGATE_REVIEW_RESERVED_SLOTS',
  'OPENCLAUDE_DELEGATE_MAX_PER_PARENT',
  'OPENCLAUDE_TEAM_MEMBER_DELEGATIONS_PER_TURN',
  'OPENCLAUDE_HIDDEN_DELEGATIONS_PER_TURN',
  'OPENCLAUDE_DELEGATE_QUEUE_WAIT_MS',
  'OC_DELEGATE_SM',
  'OC_DELEGATE_DURABLE',
  'OC_DELEGATE_NOTIFIER',
  'OC_DELEGATE_CUTOVER',
  'OC_DELEGATE_INFLIGHT_SURFACE',
  'OC_DELEGATE_INLINE_PUSH_CCB',
  'OC_DELEGATE_INLINE_PUSH_CODEX',
  'OC_DELEGATE_CURSOR_MCP_WAIT',
] as const

describe('buildDelegateKnobContainerEnv', () => {
  test('exported key list matches the fourteen knobs and feature flags', () => {
    assert.equal(KEYS.length, 14)
    assert.deepEqual([...DELEGATE_KNOB_CONTAINER_ENV_KEYS], [...KEYS])
  })

  test('合法值注入', () => {
    const out = buildDelegateKnobContainerEnv({
      OPENCLAUDE_DELEGATE_MAX_CONCURRENT: '8',
      OPENCLAUDE_DELEGATE_REVIEW_RESERVED_SLOTS: '2',
      OPENCLAUDE_DELEGATE_MAX_PER_PARENT: '3',
      OPENCLAUDE_TEAM_MEMBER_DELEGATIONS_PER_TURN: '4',
      OPENCLAUDE_HIDDEN_DELEGATIONS_PER_TURN: '12',
      OPENCLAUDE_DELEGATE_QUEUE_WAIT_MS: '120000',
    })
    assert.deepEqual(out, [
      'OPENCLAUDE_DELEGATE_MAX_CONCURRENT=8',
      'OPENCLAUDE_DELEGATE_REVIEW_RESERVED_SLOTS=2',
      'OPENCLAUDE_DELEGATE_MAX_PER_PARENT=3',
      'OPENCLAUDE_TEAM_MEMBER_DELEGATIONS_PER_TURN=4',
      'OPENCLAUDE_HIDDEN_DELEGATIONS_PER_TURN=12',
      'OPENCLAUDE_DELEGATE_QUEUE_WAIT_MS=120000',
    ])
  })

  test('OPENCLAUDE_HIDDEN_DELEGATIONS_PER_TURN 合法值单独放行', () => {
    const out = buildDelegateKnobContainerEnv({
      OPENCLAUDE_HIDDEN_DELEGATIONS_PER_TURN: '12',
    })
    assert.deepEqual(out, ['OPENCLAUDE_HIDDEN_DELEGATIONS_PER_TURN=12'])
  })

  test('非法值不注入', () => {
    const out = buildDelegateKnobContainerEnv({
      OPENCLAUDE_DELEGATE_MAX_CONCURRENT: 'abc',
      OPENCLAUDE_DELEGATE_REVIEW_RESERVED_SLOTS: '-1',
      OPENCLAUDE_DELEGATE_MAX_PER_PARENT: '1.5',
      OPENCLAUDE_TEAM_MEMBER_DELEGATIONS_PER_TURN: ' 8',
      OPENCLAUDE_HIDDEN_DELEGATIONS_PER_TURN: '12.0',
      OPENCLAUDE_DELEGATE_QUEUE_WAIT_MS: '8e4',
    })
    assert.deepEqual(out, [])
  })

  test('缺省不注入', () => {
    assert.deepEqual(buildDelegateKnobContainerEnv({}), [])
    assert.deepEqual(
      buildDelegateKnobContainerEnv({
        OPENCLAUDE_DELEGATE_MAX_CONCURRENT: '',
        OC_LOCAL_OBSERVABILITY_RETENTION: '30',
      }),
      [],
    )
  })

  test('部分合法只注入合法键,不夹带其它 env', () => {
    const out = buildDelegateKnobContainerEnv({
      OPENCLAUDE_DELEGATE_MAX_CONCURRENT: '10',
      OPENCLAUDE_DELEGATE_REVIEW_RESERVED_SLOTS: 'nope',
      OPENCLAUDE_DELEGATE_QUEUE_WAIT_MS: '0',
      OC_LOCAL_EVENT_RETENTION_DAYS: '7',
      OC_CODEX_API_KEY: 'must-not-leak',
    })
    assert.deepEqual(out, [
      'OPENCLAUDE_DELEGATE_MAX_CONCURRENT=10',
      'OPENCLAUDE_DELEGATE_QUEUE_WAIT_MS=0',
    ])
    assert.equal(out.some((v) => v.includes('OC_CODEX_API_KEY')), false)
    assert.equal(out.some((v) => v.includes('OC_LOCAL_')), false)
  })

  test('feature flag key 值 "1" 被注入', () => {
    const out = buildDelegateKnobContainerEnv({
      OC_DELEGATE_SM: '1',
      OC_DELEGATE_DURABLE: '0',
      OC_DELEGATE_NOTIFIER: '1',
      OC_DELEGATE_CUTOVER: '0',
      OC_DELEGATE_INFLIGHT_SURFACE: '1',
      OC_DELEGATE_INLINE_PUSH_CCB: '1',
      OC_DELEGATE_INLINE_PUSH_CODEX: '0',
      OC_DELEGATE_CURSOR_MCP_WAIT: '1',
    })
    assert.deepEqual(out, [
      'OC_DELEGATE_SM=1',
      'OC_DELEGATE_DURABLE=0',
      'OC_DELEGATE_NOTIFIER=1',
      'OC_DELEGATE_CUTOVER=0',
      'OC_DELEGATE_INFLIGHT_SURFACE=1',
      'OC_DELEGATE_INLINE_PUSH_CCB=1',
      'OC_DELEGATE_INLINE_PUSH_CODEX=0',
      'OC_DELEGATE_CURSOR_MCP_WAIT=1',
    ])
  })

  test('feature flag key 值 "true" 被省略', () => {
    const out = buildDelegateKnobContainerEnv({
      OC_DELEGATE_SM: 'true',
      OC_DELEGATE_DURABLE: 'false',
      OC_DELEGATE_NOTIFIER: 'on',
      OC_DELEGATE_CURSOR_MCP_WAIT: 'yes',
    })
    assert.deepEqual(out, [])
  })
})
