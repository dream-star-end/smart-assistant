/**
 * 拖动语义解析表:每一行命名动作 + 每种拒绝码。纯函数,不打 HTTP、不碰库。
 *
 * Run: npx tsx --test packages/gateway/src/taskboard/__tests__/moveIntent.test.ts
 */
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { StageKind } from '../domain.js'
import {
  type MoveStageRef,
  formatMoveComment,
  interpretMove,
  isAuditLikeStage,
  listAllowedMoves,
  statusForStageKind,
} from '../moveIntent.js'

function stage(id: string, ordinal: number, name: string, kind: StageKind = 'ai'): MoveStageRef {
  return { id, ordinal, name, kind }
}

const STAGES: MoveStageRef[] = [
  stage('s0', 0, '复现确认'),
  stage('s1', 1, '定位根因'),
  stage('s2', 2, '修复'),
  stage('s3', 3, '自验'),
  stage('s4', 4, '待我确认', 'human'),
  stage('s5', 5, '完成', 'human'),
]

function move(over: {
  status: Parameters<typeof interpretMove>[0]['status']
  stageId: string | null
  toStageId: string | null
  stages?: MoveStageRef[]
}) {
  return interpretMove({
    status: over.status,
    stageId: over.stageId,
    pipelineId: 'pipe',
    toStageId: over.toStageId,
    stages: over.stages ?? STAGES,
  })
}

describe('动作解析表:每一行', () => {
  it('from=backlog → 第一站 = promote, status→ready', () => {
    const r = move({ status: 'backlog', stageId: 's0', toStageId: 's0' })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.intent.action, 'promote')
    assert.equal(r.intent.label, '批准开工')
    assert.equal(r.intent.toStatus, 'ready')
    assert.equal(r.intent.toStageId, 's0')
    assert.equal(r.intent.requiresConfirm, false)
    assert.equal(r.intent.requiresReason, false)
  })

  it('from=backlog → 中间/后面的站 = promote_at_stage,需确认,列出被跳过的站', () => {
    const r = move({ status: 'backlog', stageId: 's0', toStageId: 's3' })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.intent.action, 'promote_at_stage')
    assert.equal(r.intent.requiresConfirm, true)
    assert.equal(r.intent.toStatus, 'ready')
    assert.deepEqual(
      r.intent.skippedStages.map((s) => s.id),
      ['s0', 's1', 's2'],
    )
    // 目标本身是自验,被跳过的是前面几站,warning 只标「被跳过的」审查站
    assert.equal(r.intent.warning, null)
  })

  it('目标=下一站 且 waiting_human = ack_advance', () => {
    const r = move({ status: 'waiting_human', stageId: 's0', toStageId: 's1' })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.intent.action, 'ack_advance')
    assert.equal(r.intent.label, '确认过站')
    assert.equal(r.intent.toStatus, 'ready')
    assert.equal(r.intent.requiresConfirm, false)
    assert.equal(r.intent.skippedStages.length, 0)
    assert.equal(r.intent.abandonedStage, null)
  })

  it('ready 拖到下一站仍是 skip_forward,必须确认;abandonedStage=当前站,skippedStages=[]', () => {
    const r = move({ status: 'ready', stageId: 's0', toStageId: 's1' })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.intent.action, 'skip_forward')
    assert.equal(r.intent.requiresConfirm, true)
    assert.deepEqual(r.intent.skippedStages, [])
    assert.equal(r.intent.abandonedStage?.id, 's0')
    assert.equal(r.intent.abandonedStage?.name, '复现确认')
    assert.match(r.intent.warning ?? '', /「复现确认」站的工作将被视为不需要/)
  })

  it('running 拖到下一站同样 skip_forward,必须确认并标出被放弃的当前站', () => {
    const r = move({ status: 'running', stageId: 's2', toStageId: 's3' })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.intent.action, 'skip_forward')
    assert.equal(r.intent.requiresConfirm, true)
    assert.equal(r.intent.skippedStages.length, 0)
    assert.equal(r.intent.abandonedStage?.name, '修复')
  })

  it('ack_advance 拖到 human 下一站时仍走确认路径 → ready', () => {
    const r = move({ status: 'waiting_human', stageId: 's3', toStageId: 's4' })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.intent.action, 'ack_advance')
    assert.equal(r.intent.toStatus, 'ready')
  })

  it('目标 ordinal > 当前+1 = skip_forward,需确认;skipped=中间站,abandoned=当前站', () => {
    const r = move({ status: 'ready', stageId: 's0', toStageId: 's3' })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.intent.action, 'skip_forward')
    assert.equal(r.intent.requiresConfirm, true)
    assert.deepEqual(
      r.intent.skippedStages.map((s) => s.name),
      ['定位根因', '修复'],
    )
    assert.equal(r.intent.abandonedStage?.name, '复现确认')
    assert.equal(r.intent.toStatus, 'ready')
    assert.equal(isAuditLikeStage(STAGES[3]!), true)
    assert.match(r.intent.warning ?? '', /「复现确认」站的工作将被视为不需要/)
  })

  it('skip_forward 落到 human 站 → waiting_human', () => {
    const r = move({ status: 'ready', stageId: 's2', toStageId: 's4' })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.intent.action, 'skip_forward')
    assert.equal(r.intent.toStatus, 'waiting_human')
    assert.equal(r.intent.abandonedStage?.name, '修复')
    assert.deepEqual(
      r.intent.skippedStages.map((s) => s.name),
      ['自验'],
    )
    assert.match(r.intent.warning ?? '', /「修复」站的工作将被视为不需要/)
    assert.match(r.intent.warning ?? '', /自验/)
  })

  it('目标 ordinal < 当前 = send_back,理由必填,status 按目标 kind', () => {
    const r = move({ status: 'waiting_human', stageId: 's3', toStageId: 's2' })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.intent.action, 'send_back')
    assert.equal(r.intent.label, '打回重做')
    assert.equal(r.intent.requiresReason, true)
    assert.equal(r.intent.requiresConfirm, false)
    assert.equal(r.intent.toStatus, 'ready')
  })

  it('send_back 打到 human 站 → waiting_human', () => {
    const r = move({ status: 'waiting_human', stageId: 's5', toStageId: 's4' })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.intent.action, 'send_back')
    assert.equal(r.intent.toStatus, 'waiting_human')
  })

  it('目标=null(积压列) = return_to_backlog', () => {
    const r = move({ status: 'ready', stageId: 's1', toStageId: null })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.intent.action, 'return_to_backlog')
    assert.equal(r.intent.toStatus, 'backlog')
    assert.equal(r.intent.toStageId, null)
    assert.equal(r.intent.label, '退回积压')
  })

  it('from=done → 任意站 = reopen,需确认', () => {
    const r = move({ status: 'done', stageId: 's5', toStageId: 's2' })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.intent.action, 'reopen')
    assert.equal(r.intent.requiresConfirm, true)
    assert.equal(r.intent.toStatus, 'ready')
    assert.equal(r.intent.toStageId, 's2')
  })

  it('from=canceled → human 站 reopen → waiting_human', () => {
    const r = move({ status: 'canceled', stageId: 's2', toStageId: 's4' })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.intent.action, 'reopen')
    assert.equal(r.intent.toStatus, 'waiting_human')
  })

  it('目标=当前站 → noop,不改 status', () => {
    const r = move({ status: 'ready', stageId: 's1', toStageId: 's1' })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.intent.action, 'noop')
    assert.equal(r.intent.toStatus, 'ready')
    assert.equal(r.intent.toStageId, 's1')
  })

  it('已在积压再拖回积压 → noop', () => {
    const r = move({ status: 'backlog', stageId: 's0', toStageId: null })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.intent.action, 'noop')
  })
})

describe('拒绝分支(纯解析层)', () => {
  it('目标站不在本流水线 → stage_pipeline_mismatch', () => {
    const r = move({ status: 'ready', stageId: 's0', toStageId: 'other-pipe-stage' })
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.equal(r.code, 'stage_pipeline_mismatch')
    assert.match(r.why, /不属于/)
  })

  it('无当前站且非积压/终态/回积压 → no_interpretable_intent', () => {
    const r = move({ status: 'ready', stageId: null, toStageId: 's1' })
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.equal(r.code, 'no_interpretable_intent')
    assert.equal(r.detail?.why, 'missing_current_stage')
  })
})

describe('listAllowedMoves 与 interpretMove 共用同一份表', () => {
  it('积压票可 promote 到第一站、promote_at_stage 到后面、不可 noop', () => {
    const moves = listAllowedMoves({
      status: 'backlog',
      stageId: 's0',
      pipelineId: 'pipe',
      stages: STAGES,
    })
    assert.ok(moves.some((m) => m.action === 'promote' && m.toStageId === 's0'))
    assert.ok(moves.some((m) => m.action === 'promote_at_stage' && m.toStageId === 's3'))
    assert.ok(!moves.some((m) => m.toStageId === null))
    for (const m of moves) {
      const r = interpretMove({
        status: 'backlog',
        stageId: 's0',
        pipelineId: 'pipe',
        toStageId: m.toStageId,
        stages: STAGES,
      })
      assert.equal(r.ok, true)
      if (!r.ok) continue
      assert.equal(r.intent.action, m.action)
      assert.equal(r.intent.requiresConfirm, m.requiresConfirm)
      assert.equal(r.intent.requiresReason, m.requiresReason)
    }
  })

  it('ready 下一站出现在 allowedMoves 里也是 skip_forward,必须确认并带 abandonedStage', () => {
    const moves = listAllowedMoves({
      status: 'ready',
      stageId: 's2',
      pipelineId: 'pipe',
      stages: STAGES,
    })
    const next = moves.find((m) => m.toStageId === 's3')
    assert.equal(next?.action, 'skip_forward')
    assert.equal(next?.requiresConfirm, true)
    assert.equal(next?.abandonedStage?.name, '修复')
    assert.equal(next?.skippedStages, undefined)
    assert.match(next?.warning ?? '', /「修复」站的工作将被视为不需要/)
  })

  it('waiting_human 下一站是 ack_advance,更远是 skip_forward,更近是 send_back,积压可退', () => {
    const moves = listAllowedMoves({
      status: 'waiting_human',
      stageId: 's2',
      pipelineId: 'pipe',
      stages: STAGES,
    })
    const byDest = new Map(moves.map((m) => [m.toStageId, m]))
    assert.equal(byDest.get('s3')?.action, 'ack_advance')
    assert.equal(byDest.get('s3')?.requiresConfirm, false)
    assert.equal(byDest.get('s4')?.action, 'skip_forward')
    assert.equal(byDest.get('s4')?.requiresConfirm, true)
    assert.equal(byDest.get('s4')?.abandonedStage?.name, '修复')
    assert.deepEqual(
      byDest.get('s4')?.skippedStages?.map((s) => s.name),
      ['自验'],
    )
    assert.equal(byDest.get('s1')?.action, 'send_back')
    assert.equal(byDest.get('s1')?.requiresReason, true)
    assert.equal(byDest.get(null)?.action, 'return_to_backlog')
    assert.equal(byDest.has('s2'), false, '当前站不应出现在 allowedMoves')
  })

  it('有未解除 blocker 时隐藏往后的站,保留打回与退回积压', () => {
    const moves = listAllowedMoves({
      status: 'blocked',
      stageId: 's2',
      pipelineId: 'pipe',
      stages: STAGES,
      hasOpenBlockers: true,
    })
    assert.ok(!moves.some((m) => m.action === 'skip_forward' || m.action === 'ack_advance'))
    assert.ok(moves.some((m) => m.action === 'send_back'))
    assert.ok(moves.some((m) => m.action === 'return_to_backlog'))
  })
})

describe('评论正文必须带动作名和打回理由', () => {
  it('send_back 把理由写进正文', () => {
    const text = formatMoveComment({
      action: 'send_back',
      label: '打回重做',
      fromStageName: '自验',
      toStageName: '修复',
      toBacklog: false,
      reason: '复现步骤没过',
    })
    assert.match(text, /人工从 「自验」站 移到 「修复」站/)
    assert.match(text, /动作=打回重做/)
    assert.match(text, /理由=复现步骤没过/)
  })

  it('promote_at_stage 写明被跳过的站由人工判定免做', () => {
    const text = formatMoveComment({
      action: 'promote_at_stage',
      label: '批准并指定入站',
      fromStageName: null,
      toStageName: '修复',
      toBacklog: false,
      skippedStages: [STAGES[0]!, STAGES[1]!],
    })
    assert.match(text, /积压/)
    assert.match(text, /复现确认、定位根因/)
    assert.match(text, /人工判定免做/)
  })

  it('skip_forward 评论写明当前站工作不需要,中间站免做', () => {
    const text = formatMoveComment({
      action: 'skip_forward',
      label: '跳到后续站',
      fromStageName: '修复',
      toStageName: '待我确认',
      toBacklog: false,
      abandonedStage: STAGES[2]!,
      skippedStages: [STAGES[3]!],
    })
    assert.match(text, /「修复」站的工作由人工判定不需要/)
    assert.match(text, /被跳过的站（自验）由人工判定免做/)
  })

  it('skip_forward 无中间站时仍写当前站工作不需要', () => {
    const text = formatMoveComment({
      action: 'skip_forward',
      label: '跳到后续站',
      fromStageName: '复现确认',
      toStageName: '定位根因',
      toBacklog: false,
      abandonedStage: STAGES[0]!,
      skippedStages: [],
    })
    assert.match(text, /「复现确认」站的工作由人工判定不需要/)
    assert.doesNotMatch(text, /被跳过的站/)
  })
})

describe('statusForStageKind', () => {
  it('ai/gate → ready, human → waiting_human', () => {
    assert.equal(statusForStageKind('ai'), 'ready')
    assert.equal(statusForStageKind('gate'), 'ready')
    assert.equal(statusForStageKind('human'), 'waiting_human')
  })
})
