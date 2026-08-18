import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { type Actor, TICKET_STATUSES, type TicketStatus } from '../domain.js'
import {
  ACTORS,
  TRANSITION_TABLE,
  TaskboardTransitionDenied,
  assertTransition,
  canTransition,
  listAllowedTransitions,
} from '../stateMachine.js'

/** 默认上下文(无 lease / 无 autoClose / 无 onSuccess)下允许的三元组。独立于实现手写。 */
const DEFAULT_ALLOWS = new Set<string>([
  // human
  'human:backlog>ready',
  'human:backlog>done',
  'human:backlog>canceled',
  'human:ready>running',
  'human:ready>waiting_human',
  'human:ready>blocked',
  'human:ready>backlog',
  'human:ready>done',
  'human:ready>canceled',
  'human:running>waiting_human',
  'human:running>blocked',
  'human:running>ready',
  'human:running>backlog',
  'human:running>done',
  'human:running>canceled',
  'human:waiting_human>ready',
  'human:waiting_human>running',
  'human:waiting_human>blocked',
  'human:waiting_human>backlog',
  'human:waiting_human>done',
  'human:waiting_human>canceled',
  'human:blocked>ready',
  'human:blocked>waiting_human',
  'human:blocked>backlog',
  'human:blocked>done',
  'human:blocked>canceled',
  'human:done>ready',
  'human:done>waiting_human',
  'human:canceled>ready',
  'human:canceled>waiting_human',
  // agent:默认上下文只剩执行中的两条(认领/推进/关单都要额外条件)
  'agent:running>waiting_human',
  'agent:running>blocked',
  // system:熔断可把待执行/执行中打成受阻
  'system:ready>blocked',
  'system:running>blocked',
  'system:running>waiting_human',
])

function key(actor: Actor, from: TicketStatus, to: TicketStatus): string {
  return `${actor}:${from}>${to}`
}

describe('canTransition 全组合遍历(默认上下文,防意外放行)', () => {
  for (const from of TICKET_STATUSES) {
    for (const to of TICKET_STATUSES) {
      for (const actor of ACTORS) {
        it(`${actor}: ${from} → ${to}`, () => {
          const verdict = canTransition({ from, to, actor })
          const allowed = DEFAULT_ALLOWS.has(key(actor, from, to))
          if (allowed) {
            assert.equal(
              verdict.ok,
              true,
              `应当放行 ${key(actor, from, to)},实际 ${JSON.stringify(verdict)}`,
            )
          } else {
            assert.equal(verdict.ok, false, `不应当放行 ${key(actor, from, to)},这是意外放行`)
          }
        })
      }
    }
  }
})

describe('重点:AI 不能给 done、不能从 backlog 开工', () => {
  it('agent 不能 backlog → ready', () => {
    const v = canTransition({ from: 'backlog', to: 'ready', actor: 'agent' })
    assert.equal(v.ok, false)
    if (!v.ok) {
      assert.equal(v.code, 'actor_denied')
      assert.match(v.reason, /只有人能批准开工/)
    }
  })

  it('system 也不能 backlog → ready', () => {
    const v = canTransition({ from: 'backlog', to: 'ready', actor: 'system' })
    assert.equal(v.ok, false)
    if (!v.ok) assert.equal(v.code, 'actor_denied')
  })

  it('agent 不能把任意非终态标为 done', () => {
    for (const from of TICKET_STATUSES) {
      if (from === 'done') continue
      const v = canTransition({ from, to: 'done', actor: 'agent' })
      assert.equal(v.ok, false, `agent 不该从 ${from} 关单`)
      if (!v.ok && from !== 'canceled') {
        assert.equal(v.code, 'auto_close_required')
        assert.match(v.reason, /只有人能给/)
      }
    }
  })

  it('agent 配了 autoClose 才能关单', () => {
    const v = canTransition({
      from: 'running',
      to: 'done',
      actor: 'agent',
      autoClose: true,
    })
    assert.equal(v.ok, true)
  })
})

describe('gated 转移', () => {
  it('agent ready → running 必须持有 lease', () => {
    const denied = canTransition({ from: 'ready', to: 'running', actor: 'agent' })
    assert.equal(denied.ok, false)
    if (!denied.ok) assert.equal(denied.code, 'lease_required')

    const ok = canTransition({
      from: 'ready',
      to: 'running',
      actor: 'agent',
      hasLease: true,
    })
    assert.equal(ok.ok, true)
  })

  it('human ready → running 不要求 lease', () => {
    const v = canTransition({ from: 'ready', to: 'running', actor: 'human' })
    assert.equal(v.ok, true)
  })

  it('agent running → ready 仅 advance/stay', () => {
    assert.equal(canTransition({ from: 'running', to: 'ready', actor: 'agent' }).ok, false)
    assert.equal(
      canTransition({
        from: 'running',
        to: 'ready',
        actor: 'agent',
        stageOnSuccess: 'wait_human',
      }).ok,
      false,
    )
    assert.equal(
      canTransition({
        from: 'running',
        to: 'ready',
        actor: 'agent',
        stageOnSuccess: 'advance',
      }).ok,
      true,
    )
    assert.equal(
      canTransition({
        from: 'running',
        to: 'ready',
        actor: 'agent',
        stageOnSuccess: 'stay',
      }).ok,
      true,
    )
  })

  it('human 打断 running → ready 不看 onSuccess', () => {
    const v = canTransition({ from: 'running', to: 'ready', actor: 'human' })
    assert.equal(v.ok, true)
  })
})

describe('终态与自转', () => {
  it('done/canceled 人重开只能 ready 或 waiting_human,agent 不能转出', () => {
    const reopenTo = new Set<TicketStatus>(['ready', 'waiting_human'])
    for (const from of ['done', 'canceled'] as const) {
      for (const to of TICKET_STATUSES) {
        if (to === from) continue
        const human = canTransition({ from, to, actor: 'human' })
        if (reopenTo.has(to)) assert.equal(human.ok, true)
        else {
          assert.equal(human.ok, false)
          if (!human.ok) assert.equal(human.code, 'terminal_locked')
        }
        assert.equal(canTransition({ from, to, actor: 'agent' }).ok, false)
      }
    }
  })

  it('同状态自转一律拒绝', () => {
    for (const status of TICKET_STATUSES) {
      for (const actor of ACTORS) {
        const v = canTransition({ from: status, to: status, actor })
        assert.equal(v.ok, false)
        if (!v.ok) assert.equal(v.code, 'same_status')
      }
    }
  })
})

describe('assertTransition / listAllowedTransitions / 表完整性', () => {
  it('拒绝时抛 TaskboardTransitionDenied 且带 code', () => {
    assert.throws(
      () => assertTransition({ from: 'backlog', to: 'ready', actor: 'agent' }),
      (err: unknown) => {
        assert.ok(err instanceof TaskboardTransitionDenied)
        assert.equal(err.code, 'actor_denied')
        assert.match(err.message, /只有人能批准开工/)
        return true
      },
    )
  })

  it('放行时不抛', () => {
    assert.doesNotThrow(() => assertTransition({ from: 'backlog', to: 'ready', actor: 'human' }))
  })

  it('listAllowedTransitions 与 canTransition 一致', () => {
    const listed = listAllowedTransitions('running', 'human')
    for (const to of TICKET_STATUSES) {
      const ok = canTransition({ from: 'running', to, actor: 'human' }).ok
      assert.equal(listed.includes(to), ok)
    }
  })

  it('TRANSITION_TABLE 无自转、无重复边', () => {
    const seen = new Set<string>()
    for (const rule of TRANSITION_TABLE) {
      assert.notEqual(rule.from, rule.to)
      const k = `${rule.from}>${rule.to}`
      assert.equal(seen.has(k), false, `重复边 ${k}`)
      seen.add(k)
    }
  })
})
