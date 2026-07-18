/**
 * CcbMessageParser turn_status 归一化 —— compacting / retrying / 未知串。
 *
 * retrying 是 codex runner 注入的 fake-SDK 状态(自动重试等待期),parser 必须
 * 识别并透传 retry 载荷;畸形/未知 status 一律归 null(不把未审串塞前端)。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/turnStatusRetrying.test.ts
 */
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CcbMessageParser, type SessionStreamEvent } from '../ccbMessageParser.js'

function createParser() {
  const events: SessionStreamEvent[] = []
  const parser = new CcbMessageParser({
    toolUseIdToName: new Map<string, string>(),
    onEvent: (e) => events.push(e),
    onFinish: () => {},
    sessionTotals: { totalCostUSD: 0, turns: 0, _lastCcbCumulativeCost: 0 },
  })
  return { parser, events }
}

function turnStatusEvents(events: SessionStreamEvent[]) {
  return events.filter((e) => e.kind === 'turn_status') as Array<
    { kind: 'turn_status' } & Record<string, unknown>
  >
}

describe('CcbMessageParser turn_status: compacting / null 现状回归', () => {
  it('status=compacting 透传为 compacting', () => {
    const { parser, events } = createParser()
    parser.parse({ type: 'system', subtype: 'status', status: 'compacting' } as any)
    const ts = turnStatusEvents(events)
    assert.equal(ts.length, 1)
    assert.equal(ts[0].status, 'compacting')
  })

  it('未知 status 归 null', () => {
    const { parser, events } = createParser()
    parser.parse({ type: 'system', subtype: 'status', status: 'restoring' } as any)
    const ts = turnStatusEvents(events)
    assert.equal(ts.length, 1)
    assert.equal(ts[0].status, null)
  })
})

describe('CcbMessageParser turn_status: retrying 侧信道', () => {
  it('status=retrying + 合法 retry 载荷 → 透传嵌套形态', () => {
    const { parser, events } = createParser()
    parser.parse({
      type: 'system',
      subtype: 'status',
      status: 'retrying',
      retry: { attempt: 2, max: 5, delayMs: 3000, retryAt: 1_700_000_000_000 },
    } as any)
    const ts = turnStatusEvents(events)
    assert.equal(ts.length, 1)
    // gateway 侧建模:status = { status:'retrying', retry }(与 session cache 一致)。
    const status = ts[0].status as { status: string; retry: Record<string, number> }
    assert.equal(status.status, 'retrying')
    assert.deepEqual(status.retry, {
      attempt: 2,
      max: 5,
      delayMs: 3000,
      retryAt: 1_700_000_000_000,
    })
  })

  it('retry 载荷非法(缺字段)→ 降级为 null,不透畸形侧信道', () => {
    const { parser, events } = createParser()
    parser.parse({
      type: 'system',
      subtype: 'status',
      status: 'retrying',
      retry: { attempt: 1 },
    } as any)
    const ts = turnStatusEvents(events)
    assert.equal(ts.length, 1)
    assert.equal(ts[0].status, null)
  })

  it('retry 缺失(status=retrying 但无 retry)→ null', () => {
    const { parser, events } = createParser()
    parser.parse({ type: 'system', subtype: 'status', status: 'retrying' } as any)
    const ts = turnStatusEvents(events)
    assert.equal(ts.length, 1)
    assert.equal(ts[0].status, null)
  })

  it('retry 字段被取整、下界校验(attempt>=1, delayMs>=0)', () => {
    const { parser, events } = createParser()
    parser.parse({
      type: 'system',
      subtype: 'status',
      status: 'retrying',
      retry: { attempt: 2.9, max: 5.1, delayMs: 100.7, retryAt: 42.4 },
    } as any)
    const status = turnStatusEvents(events)[0].status as {
      status: string
      retry: Record<string, number>
    }
    assert.deepEqual(status.retry, { attempt: 2, max: 5, delayMs: 100, retryAt: 42 })
  })
})
