import type { SwarmSnapshot } from '@openclaude/protocol/browser'
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import LiveAgentCapsule from './LiveAgentCapsule'
import { formatSwarmCapsuleDetail } from './swarmUtils'

afterEach(cleanup)

function makeSwarmSnapshot(overrides: Partial<SwarmSnapshot> = {}): SwarmSnapshot {
  return {
    swarmId: '93200000-0000-4000-8000-000000000932',
    title: 'Wave 1 并行整合',
    phase: 'running',
    revision: 12,
    updatedAt: 1_764_300_000_000,
    startedAt: 1_764_300_000_000 - 120_000,
    members: [
      { name: 'coordinator', role: 'coordinator', status: 'waiting', stepCount: 6, unreadCount: 0 },
      { name: 'b1-integrator', role: 'worker', status: 'working', stepCount: 18, unreadCount: 0 },
      { name: 'verifier', role: 'verifier', status: 'waiting', stepCount: 2, unreadCount: 0 },
    ],
    channels: [{ name: 'main', memberCount: 3, postCount: 2 }],
    posts: [
      {
        seq: 56,
        agent: 'b1-integrator',
        channel: 'main',
        text: '[progress] 正在运行全量门禁构建',
        mentions: [],
      },
      {
        seq: 57,
        agent: 'gateway-monitor',
        channel: 'main',
        text: '[stall] @coordinator 检测到讨论板暂时静默',
        mentions: ['coordinator'],
      },
    ],
    totalPosts: 57,
    ...overrides,
  }
}

describe('LiveAgentCapsule · OCV5-932 Defect #4 蜂群运行中成员署名去歧义', () => {
  it("回归：b1-integrator 运行中且最新帖子为 gateway-monitor 时，展示 '1 运行中：b1-integrator' 而非拼接 gateway-monitor", () => {
    const snap = makeSwarmSnapshot()
    expect(formatSwarmCapsuleDetail(snap)).toBe('1 运行中：b1-integrator')

    render(
      <LiveAgentCapsule
        todos={[]}
        settled={false}
        wsSending
        delegateItems={[]}
        onDismissDelegate={vi.fn()}
        latestSwarm={snap}
        onOpenSwarmBoard={vi.fn()}
      />,
    )

    const capsule = screen.getByTestId('live-agent-capsule')
    expect(capsule).toHaveAttribute('data-primary-kind', 'swarm')
    expect(capsule).toHaveTextContent('Wave 1 并行整合')
    expect(capsule).toHaveTextContent('1 运行中：b1-integrator')
    expect(capsule).not.toHaveTextContent('gateway-monitor')
  })

  it('多名核心成员并行运行时列出前 2 名并在超过 2 名时追加「等」，且忽略并行辅助 monitor/narrator', () => {
    const twoRunning = makeSwarmSnapshot({
      members: [
        {
          name: 'coordinator',
          role: 'coordinator',
          status: 'waiting',
          stepCount: 3,
          unreadCount: 0,
        },
        { name: 'slice-proto-ui', role: 'worker', status: 'working', stepCount: 8, unreadCount: 0 },
        { name: 'slice-gw-wake', role: 'worker', status: 'working', stepCount: 9, unreadCount: 0 },
        {
          name: 'gateway-monitor',
          role: 'monitor',
          status: 'working',
          stepCount: 1,
          unreadCount: 0,
        },
      ],
    })
    expect(formatSwarmCapsuleDetail(twoRunning)).toBe('2 运行中：slice-proto-ui、slice-gw-wake')

    const threeRunning = makeSwarmSnapshot({
      members: [
        { name: 'slice-proto-ui', role: 'worker', status: 'working', stepCount: 8, unreadCount: 0 },
        {
          name: 'slice-gw-monitor',
          role: 'worker',
          status: 'working',
          stepCount: 11,
          unreadCount: 0,
        },
        { name: 'slice-gw-wake', role: 'worker', status: 'working', stepCount: 9, unreadCount: 0 },
        { name: 'narrator-bot', role: 'narrator', status: 'working', stepCount: 2, unreadCount: 0 },
      ],
    })
    expect(formatSwarmCapsuleDetail(threeRunning)).toBe(
      '3 运行中：slice-proto-ui、slice-gw-monitor 等',
    )

    // 仅辅助角色在跑时兜底展示该辅助成员
    const auxOnly = makeSwarmSnapshot({
      members: [
        {
          name: 'coordinator',
          role: 'coordinator',
          status: 'waiting',
          stepCount: 3,
          unreadCount: 0,
        },
        {
          name: 'swarm-narrator',
          role: 'narrator',
          status: 'working',
          stepCount: 2,
          unreadCount: 0,
        },
      ],
    })
    expect(formatSwarmCapsuleDetail(auxOnly)).toBe('1 运行中：swarm-narrator')
  })

  it('核心成员全部待命（0 运行中）时清晰展示「N 成员待命」，区分非监控最新发言并过滤 gateway-monitor', () => {
    const allWaitingAfterMonitor = makeSwarmSnapshot({
      members: [
        {
          name: 'coordinator',
          role: 'coordinator',
          status: 'waiting',
          stepCount: 6,
          unreadCount: 0,
        },
        { name: 'b1-integrator', role: 'worker', status: 'waiting', stepCount: 18, unreadCount: 0 },
        { name: 'verifier', role: 'verifier', status: 'waiting', stepCount: 4, unreadCount: 0 },
      ],
      posts: [
        {
          seq: 57,
          agent: 'gateway-monitor',
          channel: 'main',
          text: '[stall] @coordinator 请检查待命状态',
          mentions: ['coordinator'],
        },
      ],
    })
    expect(formatSwarmCapsuleDetail(allWaitingAfterMonitor)).toBe('3 成员待命')

    const allWaitingAfterWorker = makeSwarmSnapshot({
      members: allWaitingAfterMonitor.members,
      posts: [
        {
          seq: 58,
          agent: 'b1-p0-fe',
          channel: 'main',
          text: '@b1-integrator [done] 前端切片已就绪',
          mentions: ['b1-integrator'],
        },
      ],
    })
    expect(formatSwarmCapsuleDetail(allWaitingAfterWorker)).toBe('3 成员待命 · 最新 b1-p0-fe')

    const allWaitingAfterMonitorNamedWorker = makeSwarmSnapshot({
      members: [
        ...allWaitingAfterMonitor.members,
        { name: 'slice-gw-monitor', role: 'worker', status: 'waiting', stepCount: 9, unreadCount: 0 },
      ],
      posts: [
        {
          seq: 59,
          agent: 'slice-gw-monitor',
          channel: 'main',
          text: '@verifier [done] 网关监控切片已就绪',
          mentions: ['verifier'],
        },
      ],
    })
    expect(formatSwarmCapsuleDetail(allWaitingAfterMonitorNamedWorker)).toBe('4 成员待命 · 最新 slice-gw-monitor')

    const allWaitingNoPosts = makeSwarmSnapshot({
      members: allWaitingAfterMonitor.members,
      posts: [],
      totalPosts: 0,
    })
    expect(formatSwarmCapsuleDetail(allWaitingNoPosts)).toBe('3 成员待命')
  })
})
