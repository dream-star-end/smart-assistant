import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  type DelegateChainSession,
  makeDelegateProgressBlock,
  resolveDelegateProgressRouting,
  toNestedDelegateProgressLine,
} from '../delegateProgress.js'

/** 用一个内存 Map 造委派会话父链,充当 resolveDelegateProgressRouting 的 getSession。 */
function makeChain(sessions: DelegateChainSession[]) {
  const map = new Map(sessions.map((s) => [s.sessionKey, s]))
  return (key: string) => map.get(key)
}

const WEBCHAT: DelegateChainSession = {
  sessionKey: 'agent:main:webchat:dm:web-1',
  channel: 'webchat',
  peerId: 'web-1',
  agentId: 'main',
  userId: 'u1',
}

describe('resolveDelegateProgressRouting — 一级(直接 webchat 父)与旧行为一致', () => {
  it('直接 webchat 父 → nested=false,target 即旧返回值,无追溯', () => {
    const routing = resolveDelegateProgressRouting({
      parentSessionKey: WEBCHAT.sessionKey,
      sourceAgent: 'main',
      getSession: makeChain([WEBCHAT]),
    })
    assert.deepEqual(routing, {
      target: {
        sessionKey: 'agent:main:webchat:dm:web-1',
        channel: 'webchat',
        peerId: 'web-1',
        userId: 'u1',
      },
      nested: false,
      firstLevelRunId: undefined,
      ancestorAgentPath: [],
    })
  })

  it('直接 webchat 父但 sourceAgent 不匹配 → null(反 spoof,与旧一致)', () => {
    const routing = resolveDelegateProgressRouting({
      parentSessionKey: WEBCHAT.sessionKey,
      sourceAgent: 'evil',
      getSession: makeChain([WEBCHAT]),
    })
    assert.equal(routing, null)
  })

  it('无 sourceAgent 时不校验归属(webchat 父直接命中)', () => {
    const routing = resolveDelegateProgressRouting({
      parentSessionKey: WEBCHAT.sessionKey,
      getSession: makeChain([WEBCHAT]),
    })
    assert.equal(routing?.nested, false)
    assert.equal(routing?.target.sessionKey, WEBCHAT.sessionKey)
  })
})

describe('resolveDelegateProgressRouting — 二级+嵌套追溯到 webchat 祖先', () => {
  const D1: DelegateChainSession = {
    sessionKey: 'agent:reviewer:delegate:main:1',
    channel: 'delegate',
    peerId: 'reviewer',
    agentId: 'reviewer',
    parentSessionKey: WEBCHAT.sessionKey,
    progressRunId: 'R1',
  }
  const D2: DelegateChainSession = {
    sessionKey: 'agent:coder:delegate:reviewer:2',
    channel: 'delegate',
    peerId: 'coder',
    agentId: 'coder',
    parentSessionKey: D1.sessionKey,
    progressRunId: 'R2',
  }

  it('二级(父是 delegate)→ 命中 webchat 祖先,firstLevelRunId=一级 runId,path=[一级名]', () => {
    const routing = resolveDelegateProgressRouting({
      parentSessionKey: D1.sessionKey,
      sourceAgent: 'reviewer',
      getSession: makeChain([WEBCHAT, D1]),
    })
    assert.ok(routing)
    assert.equal(routing.nested, true)
    // target 仍是 webchat 祖先(与一级路由到同一 webchat 会话,billing/repo 语义不变)。
    assert.deepEqual(routing.target, {
      sessionKey: WEBCHAT.sessionKey,
      channel: 'webchat',
      peerId: 'web-1',
      userId: 'u1',
    })
    assert.equal(routing.firstLevelRunId, 'R1')
    assert.deepEqual(routing.ancestorAgentPath, ['reviewer'])
  })

  it('三级 → firstLevelRunId 取链中最后一个 delegate(其父即 webchat=一级),path top-down', () => {
    const routing = resolveDelegateProgressRouting({
      parentSessionKey: D2.sessionKey,
      sourceAgent: 'coder',
      getSession: makeChain([WEBCHAT, D1, D2]),
    })
    assert.ok(routing)
    assert.equal(routing.nested, true)
    assert.equal(routing.target.sessionKey, WEBCHAT.sessionKey)
    // 一级委派是 D1(其父是 webchat),复用它的 R1 而非直接父 D2 的 R2。
    assert.equal(routing.firstLevelRunId, 'R1')
    // top-down:一级名在前,直接父名在后。
    assert.deepEqual(routing.ancestorAgentPath, ['reviewer', 'coder'])
  })

  it('嵌套但直接父 sourceAgent 不匹配 → null(仅校验直接父这一跳)', () => {
    const routing = resolveDelegateProgressRouting({
      parentSessionKey: D1.sessionKey,
      sourceAgent: 'not-reviewer',
      getSession: makeChain([WEBCHAT, D1]),
    })
    assert.equal(routing, null)
  })

  it('一级委派缺 progressRunId → nested 仍成立,firstLevelRunId=undefined(调用方退回自身卡)', () => {
    const d1NoRun: DelegateChainSession = { ...D1, progressRunId: undefined }
    const routing = resolveDelegateProgressRouting({
      parentSessionKey: d1NoRun.sessionKey,
      sourceAgent: 'reviewer',
      getSession: makeChain([WEBCHAT, d1NoRun]),
    })
    assert.equal(routing?.nested, true)
    assert.equal(routing?.firstLevelRunId, undefined)
  })
})

describe('resolveDelegateProgressRouting — 防御:断链/环/超深/杂 channel → null,不抛错', () => {
  it('直接父键缺失/非字符串 → null', () => {
    assert.equal(
      resolveDelegateProgressRouting({ parentSessionKey: undefined, getSession: makeChain([]) }),
      null,
    )
    assert.equal(
      resolveDelegateProgressRouting({ parentSessionKey: '', getSession: makeChain([]) }),
      null,
    )
    assert.equal(
      resolveDelegateProgressRouting({ parentSessionKey: 42, getSession: makeChain([]) }),
      null,
    )
  })

  it('父链某跳会话不在内存(断链)→ null', () => {
    const d1: DelegateChainSession = {
      sessionKey: 'D1',
      channel: 'delegate',
      peerId: 'reviewer',
      agentId: 'reviewer',
      parentSessionKey: 'gone', // 指向不存在的祖先
    }
    const routing = resolveDelegateProgressRouting({
      parentSessionKey: 'D1',
      sourceAgent: 'reviewer',
      getSession: makeChain([d1]),
    })
    assert.equal(routing, null)
  })

  it('链尾未碰到 webchat(delegate 父指针为空)→ null', () => {
    const d1: DelegateChainSession = {
      sessionKey: 'D1',
      channel: 'delegate',
      peerId: 'reviewer',
      agentId: 'reviewer',
      parentSessionKey: undefined,
    }
    assert.equal(
      resolveDelegateProgressRouting({
        parentSessionKey: 'D1',
        sourceAgent: 'reviewer',
        getSession: makeChain([d1]),
      }),
      null,
    )
  })

  it('父链成环 → null(visited 防护)', () => {
    const d1: DelegateChainSession = {
      sessionKey: 'D1',
      channel: 'delegate',
      peerId: 'reviewer',
      agentId: 'reviewer',
      parentSessionKey: 'D2',
    }
    const d2: DelegateChainSession = {
      sessionKey: 'D2',
      channel: 'delegate',
      peerId: 'coder',
      agentId: 'coder',
      parentSessionKey: 'D1', // 环
    }
    assert.equal(
      resolveDelegateProgressRouting({
        parentSessionKey: 'D1',
        sourceAgent: 'reviewer',
        getSession: makeChain([d1, d2]),
      }),
      null,
    )
  })

  it('链超过 maxDepth → null(默认深度 5 的兜底)', () => {
    // 造 6 层 delegate 再接 webchat,默认 maxDepth=5 追溯不到根 → null。
    const chain: DelegateChainSession[] = []
    for (let i = 1; i <= 6; i++) {
      chain.push({
        sessionKey: `L${i}`,
        channel: 'delegate',
        peerId: `a${i}`,
        agentId: `a${i}`,
        parentSessionKey: i === 6 ? WEBCHAT.sessionKey : `L${i + 1}`,
      })
    }
    const routing = resolveDelegateProgressRouting({
      parentSessionKey: 'L1',
      sourceAgent: 'a1',
      getSession: makeChain([WEBCHAT, ...chain]),
    })
    assert.equal(routing, null)
  })

  it('途中碰到既非 webchat 也非 delegate 的祖先(cron 等)→ null', () => {
    const d1: DelegateChainSession = {
      sessionKey: 'D1',
      channel: 'delegate',
      peerId: 'reviewer',
      agentId: 'reviewer',
      parentSessionKey: 'CRON',
    }
    const cron: DelegateChainSession = {
      sessionKey: 'CRON',
      channel: 'cron',
      peerId: 'cron',
      agentId: 'main',
    }
    assert.equal(
      resolveDelegateProgressRouting({
        parentSessionKey: 'D1',
        sourceAgent: 'reviewer',
        getSession: makeChain([d1, cron]),
      }),
      null,
    )
  })
})

describe('toNestedDelegateProgressLine — 嵌套 rich block 原样挂卡，纯生命周期帧转非终态文本', () => {
  const args = { runId: 'R1', agentId: 'coder', label: 'reviewer↳coder' }

  it('tool 帧 → text 行,复用一级 runId,带层级前缀,末尾换行', () => {
    const source = makeDelegateProgressBlock({
      runId: 'R2',
      agentId: 'coder',
      phase: 'tool',
      toolName: 'Bash',
      text: '调用工具 Bash',
    })
    const line = toNestedDelegateProgressLine(source, args)
    assert.deepEqual(line, {
      kind: 'delegate_progress',
      runId: 'R1',
      agentId: 'coder',
      phase: 'text',
      text: '↳ reviewer↳coder: 调用工具 Bash\n',
      block: { kind: 'text', text: '↳ reviewer↳coder: 调用工具 Bash\n' },
    })
  })

  it('done/error 一律降为非终态 text 行(不会用 done/error 关掉一级卡)', () => {
    const done = toNestedDelegateProgressLine(
      makeDelegateProgressBlock({ runId: 'R2', agentId: 'coder', phase: 'done', text: '搞定' }),
      args,
    )
    assert.equal(done?.phase, 'text')
    assert.equal(done?.text, '↳ reviewer↳coder: 完成:搞定\n')

    const err = toNestedDelegateProgressLine(
      makeDelegateProgressBlock({
        runId: 'R2',
        agentId: 'coder',
        phase: 'error',
        isError: true,
        text: '炸了',
      }),
      args,
    )
    assert.equal(err?.phase, 'text')
    assert.equal(err?.text, '↳ reviewer↳coder: 失败:炸了\n')
  })

  it('start 帧带 goal → text 行', () => {
    const line = toNestedDelegateProgressLine(
      makeDelegateProgressBlock({
        runId: 'R2',
        agentId: 'coder',
        phase: 'start',
        text: '开始委派给 coder: 修 bug',
      }),
      args,
    )
    assert.equal(line?.phase, 'text')
    assert.equal(line?.text, '↳ reviewer↳coder: 开始委派给 coder: 修 bug\n')
  })

  it('thinking / text 帧保留为一级卡内的真实非终态子记录', () => {
    const thinking = toNestedDelegateProgressLine(
      makeDelegateProgressBlock({ runId: 'R2', agentId: 'coder', phase: 'thinking', text: '想…' }),
      args,
    )
    assert.equal(thinking?.phase, 'text')
    assert.equal((thinking?.block as any)?.text, '↳ reviewer↳coder: 想…\n')

    const text = toNestedDelegateProgressLine(
      makeDelegateProgressBlock({ runId: 'R2', agentId: 'coder', phase: 'text', text: 'hello' }),
      args,
    )
    assert.equal(text?.phase, 'text')
    assert.equal((text?.block as any)?.text, '↳ reviewer↳coder: hello\n')
  })

  it('rich nested block is rebound without changing any content', () => {
    const exact = `${'q'.repeat(40_000)}EXACT_NESTED_END`
    const line = toNestedDelegateProgressLine({
      kind: 'delegate_progress',
      runId: 'R2',
      agentId: 'coder',
      phase: 'text',
      text: 'legacy preview',
      block: { kind: 'text', text: exact },
    }, args)
    assert.equal(line?.runId, 'R1')
    assert.equal(line?.phase, 'text')
    assert.equal((line?.block as any)?.text, exact)
  })

  it('空 detail → null(无可展示内容)', () => {
    assert.equal(
      toNestedDelegateProgressLine(
        makeDelegateProgressBlock({ runId: 'R2', agentId: 'coder', phase: 'tool' }),
        args,
      ),
      null,
    )
  })
})
