import { describe, expect, test } from 'vitest'
import type { TicketActivity, TicketComment, TicketRun } from './taskboard'
import {
  COMMENT_GROUP_WINDOW_MS,
  buildTicketTimeline,
  formatShanghaiAbsolute,
  formatTimelineTime,
  isTimelineCommentLong,
  timelineAuthorLabel,
} from './ticketTimeline'

const T0 = 1_700_000_000_000

function comment(over: Partial<TicketComment> = {}): TicketComment {
  return {
    id: 'c1',
    ticketId: 't1',
    authorKind: 'human',
    author: 'user:alice',
    body: 'hello',
    runId: null,
    createdAt: T0,
    ...over,
  }
}

function activity(over: Partial<TicketActivity> = {}): TicketActivity {
  return {
    id: 'a1',
    ticketId: 't1',
    actor: 'human',
    actorId: 'user:alice',
    action: 'status_changed',
    field: 'status',
    fromValue: 'backlog',
    toValue: 'ready',
    createdAt: T0,
    ...over,
  }
}

function run(over: Partial<TicketRun> = {}): TicketRun {
  return {
    id: 'r1',
    ticketId: 't1',
    stageId: 's1',
    agentId: 'coding-assistant',
    trigger: 'manual',
    sessionKey: null,
    status: 'succeeded',
    skipReason: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    startedAt: T0,
    finishedAt: T0 + 60_000,
    durationMs: 60_000,
    tokensIn: 1,
    tokensOut: 1,
    costUsd: 0.01,
    summary: null,
    outputMd: null,
    error: null,
    createdAt: T0,
    ...over,
  }
}

describe('buildTicketTimeline', () => {
  test('keeps actual models and bounded live preview through the real normalization path', () => {
    const model = buildTicketTimeline([], [run({ status: 'running', finishedAt: null, actualModels: ['actual-a', 'actual-b'], preview: { text: '实时输出', toolNames: ['Read'], lastActivityAt: T0 } })], [])
    const node = model.nodes.find((entry) => 'run' in entry)
    expect(node?.run?.actualModels).toEqual(['actual-a', 'actual-b'])
    expect(node?.run?.preview).toEqual({ text: '实时输出', toolNames: ['Read'], lastActivityAt: T0 })
  })

  test('评论、状态、执行按时间从旧到新', () => {
    const model = buildTicketTimeline(
      [comment({ id: 'c', createdAt: T0 + 20 })],
      [run({ id: 'r', startedAt: T0 + 30, finishedAt: T0 + 40, createdAt: T0 + 30 })],
      [activity({ id: 'a', createdAt: T0 + 10 })],
    )
    expect(model.nodes.map((node) => node.kind)).toEqual([
      'status',
      'comment',
      'run_start',
      'run_end',
    ])
    expect(model.nodes.map((node) => node.createdAt)).toEqual([
      T0 + 10,
      T0 + 20,
      T0 + 30,
      T0 + 40,
    ])
  })

  test('同一作者 5 分钟内连续评论合并，整 5 分钟算内，多 1 毫秒拆开', () => {
    const inside = buildTicketTimeline(
      [
        comment({ id: 'c1', createdAt: T0 }),
        comment({ id: 'c2', createdAt: T0 + COMMENT_GROUP_WINDOW_MS }),
      ],
      [],
      [],
    )
    expect(inside.groups).toHaveLength(1)
    expect(inside.groups[0]?.nodes.map((node) => node.id)).toEqual(['c1', 'c2'])

    const outside = buildTicketTimeline(
      [
        comment({ id: 'c1', createdAt: T0 }),
        comment({ id: 'c2', createdAt: T0 + COMMENT_GROUP_WINDOW_MS + 1 }),
      ],
      [],
      [],
    )
    expect(outside.groups).toHaveLength(2)

    const otherAuthor = buildTicketTimeline(
      [
        comment({ id: 'c1', createdAt: T0, author: 'user:alice' }),
        comment({ id: 'c2', createdAt: T0 + 1_000, author: 'user:bob' }),
      ],
      [],
      [],
    )
    expect(otherAuthor.groups).toHaveLength(2)

    const otherKind = buildTicketTimeline(
      [
        comment({ id: 'c1', createdAt: T0, author: 'main', authorKind: 'human' }),
        comment({ id: 'c2', createdAt: T0 + 1_000, author: 'main', authorKind: 'agent' }),
      ],
      [],
      [],
    )
    expect(otherKind.groups).toHaveLength(2)
  })

  test('中间隔着执行记录时，即使评论相距不到 5 分钟也不合并；筛掉执行后仍不合并', () => {
    const model = buildTicketTimeline(
      [
        comment({ id: 'c1', createdAt: T0 }),
        comment({ id: 'c2', createdAt: T0 + 60_000 }),
      ],
      [
        run({
          id: 'r',
          startedAt: T0 + 30_000,
          finishedAt: null,
          createdAt: T0 + 30_000,
          status: 'running',
        }),
      ],
      [],
    )
    expect(model.groups.map((group) => group.nodes.map((node) => node.kind))).toEqual([
      ['comment'],
      ['run_start'],
      ['comment'],
    ])
    const commentsOnly = buildTicketTimeline(
      [
        comment({ id: 'c1', createdAt: T0 }),
        comment({ id: 'c2', createdAt: T0 + 60_000 }),
      ],
      [
        run({
          id: 'r',
          startedAt: T0 + 30_000,
          finishedAt: null,
          createdAt: T0 + 30_000,
          status: 'running',
        }),
      ],
      [],
      { filter: 'comment' },
    )
    expect(commentsOnly.groups).toHaveLength(2)
    expect(commentsOnly.nodes.map((node) => node.id)).toEqual(['c1', 'c2'])
  })

  test('筛选全部 / 评论 / 状态 / 执行，审批算状态', () => {
    const input = {
      comments: [comment({ id: 'c', createdAt: T0 + 3 })],
      runs: [run({ id: 'r', startedAt: T0 + 4, finishedAt: T0 + 5, createdAt: T0 + 4 })],
      events: [
        activity({ id: 'st', createdAt: T0 + 1, action: 'status_changed' }),
        activity({
          id: 'ap',
          createdAt: T0 + 2,
          action: 'ticket_approved',
          field: null,
          fromValue: null,
          toValue: null,
        }),
      ],
    }
    const all = buildTicketTimeline(input.comments, input.runs, input.events, { filter: 'all' })
    expect(all.counts).toEqual({ all: 5, comment: 1, status: 2, run: 2 })
    expect(all.nodes).toHaveLength(5)

    const onlyComments = buildTicketTimeline(input.comments, input.runs, input.events, {
      filter: 'comment',
    })
    expect(onlyComments.nodes.map((node) => node.kind)).toEqual(['comment'])

    const onlyStatus = buildTicketTimeline(input.comments, input.runs, input.events, {
      filter: 'status',
    })
    expect(onlyStatus.nodes.map((node) => node.kind)).toEqual(['status', 'approval'])

    const onlyRuns = buildTicketTimeline(input.comments, input.runs, input.events, {
      filter: 'run',
    })
    expect(onlyRuns.nodes.map((node) => node.kind)).toEqual(['run_start', 'run_end'])

    const unknown = buildTicketTimeline(input.comments, input.runs, input.events, {
      filter: 'nope',
    })
    expect(unknown.nodes).toHaveLength(5)
  })

  test('缺字段、null 和非数组不抛错，没有时间的条目跳过', () => {
    expect(() =>
      buildTicketTimeline(
        [null, undefined, { body: '没有时间' }, comment({ id: 'ok', body: '' })],
        [null, { id: 'no-time' }, 'bad'],
        undefined,
      ),
    ).not.toThrow()
    const model = buildTicketTimeline(
      [null, { body: '没有时间' }, { id: '', createdAt: T0, author: 'user:a', body: '留下' }],
      [null, { status: 'failed' }],
      'not-a-list',
    )
    expect(model.nodes.map((node) => node.kind)).toEqual(['comment'])
    expect(model.nodes[0]?.comment?.body).toBe('留下')
    expect(model.nodes[0]?.id.startsWith('comment:')).toBe(true)
    expect(model.counts.all).toBe(1)
  })

  test('同一时间戳按类型再按 id 稳定排序，不依赖输入顺序', () => {
    const comments = [
      comment({ id: 'c-b', createdAt: T0 }),
      comment({ id: 'c-a', createdAt: T0 }),
    ]
    const events = [
      activity({ id: 'z-status', createdAt: T0, action: 'status_changed' }),
      activity({
        id: 'm-approval',
        createdAt: T0,
        action: 'ticket_approved',
        field: null,
        fromValue: null,
        toValue: null,
      }),
      activity({
        id: 'a-note',
        createdAt: T0,
        action: 'field_updated',
        field: 'title',
        fromValue: '旧',
        toValue: '新',
      }),
    ]
    const runs = [
      run({
        id: 'r-b',
        createdAt: T0,
        startedAt: null,
        finishedAt: null,
        status: 'succeeded',
      }),
    ]
    const forward = buildTicketTimeline(comments, runs, events)
    const backward = buildTicketTimeline(
      [...comments].reverse(),
      [...runs].reverse(),
      [...events].reverse(),
    )
    const order = ['a-note', 'm-approval', 'z-status', 'c-a', 'c-b', 'r-b:end']
    expect(forward.nodes.map((node) => node.id)).toEqual(order)
    expect(backward.nodes.map((node) => node.id)).toEqual(order)
  })

  test('执行有不同的开始和结束时间时拆成两个节点；同一毫秒只留结束', () => {
    const split = buildTicketTimeline(
      [],
      [run({ id: 'r', startedAt: T0, finishedAt: T0 + 5, createdAt: T0 - 10 })],
      [],
    )
    expect(split.nodes.map((node) => [node.kind, node.createdAt, node.runPhase])).toEqual([
      ['run_start', T0, 'start'],
      ['run_end', T0 + 5, 'end'],
    ])
    expect(split.nodes[0]?.authorKind).toBe('agent')
    expect(split.nodes[0]?.stageId).toBe('s1')

    const same = buildTicketTimeline(
      [],
      [run({ id: 'r', startedAt: T0, finishedAt: T0, createdAt: T0, status: 'skipped' })],
      [],
    )
    expect(same.nodes.map((node) => node.kind)).toEqual(['run_end'])
    expect(same.nodes[0]?.runPhase).toBe('single')
  })

  test('评论能挂上关联执行的阶段；长评论按 8 行判断', () => {
    const model = buildTicketTimeline(
      [comment({ id: 'c', runId: 'r', createdAt: T0 + 10 })],
      [run({ id: 'r', stageId: 'stage-build', startedAt: T0, finishedAt: null, status: 'running' })],
      [],
    )
    expect(model.nodes.find((node) => node.kind === 'comment')?.stageId).toBe('stage-build')
    expect(isTimelineCommentLong('短评')).toBe(false)
    expect(isTimelineCommentLong(Array.from({ length: 8 }, () => '行').join('\n'))).toBe(false)
    expect(isTimelineCommentLong(Array.from({ length: 9 }, () => '行').join('\n'))).toBe(true)
    // 400 个中文、两段：全角按 2 单位、每行 80，两段各 5 行，超过 8 行。
    expect(isTimelineCommentLong(`${'中'.repeat(200)}\n${'中'.repeat(200)}`)).toBe(true)
    // 160 个英文只折成 2 行，不算长。
    expect(isTimelineCommentLong('a'.repeat(160))).toBe(false)
  })

  test('绝对时间用 Asia/Shanghai，而不是 UTC', () => {
    expect(formatShanghaiAbsolute(Date.UTC(2026, 0, 1, 0, 0, 0))).toBe('2026-01-01 08:00:00')
    expect(formatShanghaiAbsolute(Number.NaN)).toBe('—')
  })

  test('时间线时间：近 24 小时相对，同年写出时刻，跨年带年份', () => {
    const at = Date.UTC(2026, 8, 8, 0, 43, 17)
    expect(formatTimelineTime(at, at + 30_000)).toBe('刚刚')
    expect(formatTimelineTime(at, at + 59_999)).toBe('刚刚')
    expect(formatTimelineTime(at, at + 60_000)).toBe('1 分钟前')
    expect(formatTimelineTime(at, at + 59 * 60_000)).toBe('59 分钟前')
    expect(formatTimelineTime(at, at + 60 * 60_000)).toBe('1 小时前')
    expect(formatTimelineTime(at, at + 23 * 60 * 60_000)).toBe('23 小时前')
    expect(formatTimelineTime(at, at + 24 * 60 * 60_000)).toBe('09-08 08:43')
    expect(formatTimelineTime(at, Date.UTC(2027, 0, 1))).toBe('2026-09-08 08:43')
    expect(formatTimelineTime(Number.NaN, at)).toBe('—')
  })

  test('UTC 16:30 在上海是次日 00:30', () => {
    const utc1630 = Date.UTC(2026, 0, 1, 16, 30, 0)
    expect(formatShanghaiAbsolute(utc1630)).toBe('2026-01-02 00:30:00')
    expect(formatTimelineTime(utc1630, Date.UTC(2026, 6, 1))).toBe('01-02 00:30')
    expect(formatTimelineTime(utc1630, Date.UTC(2027, 0, 3))).toBe('2026-01-02 00:30')
  })

  test('unidentified 作者显示为未识别来源', () => {
    expect(timelineAuthorLabel('unidentified', 'system')).toBe('未识别来源')
    expect(timelineAuthorLabel('agent:unidentified', 'agent')).toBe('未识别来源')
    expect(timelineAuthorLabel('user:alice', 'human')).toBe('alice')
    expect(timelineAuthorLabel('user:alice', 'human', true)).toBe('我')
    expect(timelineAuthorLabel('', 'system')).toBe('未识别来源')
  })
})
