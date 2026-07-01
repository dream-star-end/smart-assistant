import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { AgentDef } from '@openclaude/storage'
import { listCollaboratorAgents } from '../collaboratorAgents.js'

// v5 纯市场:可协作 agent = 市场安装集(source==='marketplace') [+ 可选 main]。排除幽灵平台 seed。
function cfg(agents: AgentDef[]) {
  return { agents }
}

const main: AgentDef = { id: 'main' }
const market1: AgentDef = { id: 'office-assistant', source: 'marketplace' }
const market2: AgentDef = { id: 'research-assistant', source: 'marketplace' }
// 存量容器里残留的、已退役的平台预置子 agent(无 source 标记):必须被排除。
const ghostSeed: AgentDef = { id: 'coder', displayName: '代码工程师' }

describe('listCollaboratorAgents', () => {
  it('队长组队引导(includeMain:false):只返回市场安装 agent,排除 main 与幽灵 seed', () => {
    const members = listCollaboratorAgents(cfg([main, market1, ghostSeed, market2]), {
      selfId: 'main',
      includeMain: false,
    })
    assert.deepEqual(
      members.map((a) => a.id),
      ['office-assistant', 'research-assistant'],
    )
  })

  it('系统提示协作块(includeMain:true):子 agent 视角包含 main + 其它市场 agent,排除自己与幽灵 seed', () => {
    const others = listCollaboratorAgents(cfg([main, market1, ghostSeed, market2]), {
      selfId: 'office-assistant',
      includeMain: true,
    })
    assert.deepEqual(
      others.map((a) => a.id),
      ['main', 'research-assistant'],
    )
  })

  it('includeMain:false 时即使 selfId 非 main 也不带出 main', () => {
    const others = listCollaboratorAgents(cfg([main, market1]), {
      selfId: 'office-assistant',
      includeMain: false,
    })
    assert.deepEqual(
      others.map((a) => a.id),
      [],
    )
  })

  it('对 seed 漂移免疫:只有幽灵 seed(无市场 agent)时,组队成员为空', () => {
    const members = listCollaboratorAgents(cfg([main, ghostSeed]), {
      selfId: 'main',
      includeMain: false,
    })
    assert.deepEqual(members, [])
  })

  it('保持 agents.yaml 原顺序', () => {
    const others = listCollaboratorAgents(cfg([market2, main, market1]), {
      selfId: 'main',
      includeMain: true,
    })
    assert.deepEqual(
      others.map((a) => a.id),
      ['research-assistant', 'office-assistant'],
    )
  })

  it('容忍 agents 缺失/非数组', () => {
    assert.deepEqual(
      listCollaboratorAgents({ agents: undefined as unknown as AgentDef[] }, {
        selfId: 'main',
        includeMain: true,
      }),
      [],
    )
  })
})
