import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ApiError } from '../../lib/api'
import { createMemoryAuthSession } from '../../lib/authSession'
import type { ResolvedProjectScope } from '../../lib/projectScope'
import { taskboardApi } from '../../lib/taskboard'
import { AgentProjectPreview, slotLabel } from './AgentProjectPreview'

const WORK = { id: 'wp_muying_2026', key: 'MY', name: '小红书母婴号运营' }
const CHAT = { id: 'chat_muying_0001', name: 'momo 号运营', boardProjectId: WORK.id }

/**
 * 直接给定已解析的作用域：ProjectScopeProvider 挂载时先从 URL / localStorage 读 token，
 * 再异步拉工作项目列表，工作项目 id 在列表到达前会被判 invalid 而重置（sidebar 归属的 X-01），
 * 组件自身的行为不该被这条竞态绑住。
 */
const scopeRef: { current: ResolvedProjectScope } = {
  current: {
    kind: 'work',
    token: WORK.id,
    chatProject: CHAT,
    workProject: WORK,
    bound: true,
    chatProjectIdForFilter: CHAT.id,
    invalid: false,
  },
}

vi.mock('../../hooks/useProjectScope', () => ({
  useProjectScope: () => ({
    scope: scopeRef.current,
    token: scopeRef.current.token,
    setToken: () => {},
    workProjects: [],
    chatProjects: [],
    selectOptions: [],
    loading: false,
    refreshWorkProjects: async () => [],
  }),
}))

const auth = createMemoryAuthSession(() => {}, 'tok')

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('AgentProjectPreview', () => {
  test('读失败渲染带重试的错误条，不与「还没有会注入的内容」并排；重试成功后按用户语呈现注入槽', async () => {
    const preview = vi
      .spyOn(taskboardApi, 'previewProjectContext')
      .mockRejectedValueOnce(
        new ApiError({ status: 500, message: '预览服务暂不可用', requestId: 'r1' }),
      )
      .mockResolvedValueOnce({
        enabled: true,
        slots: [
          { name: 'instructions', bytes: 1240 },
          { name: 'memories', bytes: 3 * 1024, redacted: true },
          { name: 'custom_slot', bytes: 12 },
        ],
      })

    render(<AgentProjectPreview auth={auth} agentId="main" />)

    expect(await screen.findByText(/预览服务暂不可用/)).toBeInTheDocument()
    expect(screen.queryByText('这个项目还没有会注入的内容。')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('项目说明')).toBeInTheDocument()
    expect(screen.getByText('项目记忆')).toBeInTheDocument()
    // 未知槽名原样，字节数走 formatBytes，不再是 `instructions · 1240B`。
    expect(screen.getByText('custom_slot')).toBeInTheDocument()
    expect(screen.getByText('3 KB')).toBeInTheDocument()
    expect(screen.getByText('已脱敏')).toBeInTheDocument()
    expect(preview).toHaveBeenCalledTimes(2)
  })

  test('空槽与关闭注入各有一句用户语说明', async () => {
    const preview = vi
      .spyOn(taskboardApi, 'previewProjectContext')
      .mockResolvedValueOnce({ enabled: true, slots: [] })
      .mockResolvedValueOnce({ enabled: false, slots: [] })
    const { unmount } = render(<AgentProjectPreview auth={auth} agentId="main" />)
    expect(await screen.findByText('这个项目还没有会注入的内容。')).toBeInTheDocument()
    unmount()

    render(<AgentProjectPreview auth={auth} agentId="main" />)
    expect(await screen.findByText('该项目关闭了上下文注入。')).toBeInTheDocument()
    expect(preview).toHaveBeenCalledTimes(2)
  })

  test('用户可见文案不含 API 路径 / 槽名 / 裸字节数等开发者词汇', async () => {
    vi.spyOn(taskboardApi, 'previewProjectContext').mockResolvedValue({
      enabled: true,
      slots: [{ name: 'skills', bytes: 800 }],
    })
    const { container } = render(<AgentProjectPreview auth={auth} agentId="main" />)
    await screen.findByText('项目技能')
    const text = container.textContent ?? ''
    expect(text).not.toMatch(/\/api\/|API|facade|注入槽|\d+B\b|preview/)
    expect(text).toContain('智能体会带着这些项目信息开始对话')
  })

  test('非工作项目作用域不渲染', () => {
    const saved = scopeRef.current
    scopeRef.current = {
      kind: 'all',
      token: 'all',
      chatProject: null,
      workProject: null,
      bound: false,
      chatProjectIdForFilter: undefined,
      invalid: false,
    }
    const preview = vi.spyOn(taskboardApi, 'previewProjectContext')
    const { container } = render(<AgentProjectPreview auth={auth} agentId="main" />)
    expect(container).toBeEmptyDOMElement()
    expect(preview).not.toHaveBeenCalled()
    scopeRef.current = saved
  })
})

describe('slotLabel', () => {
  test('已知槽名映射为中文，未知原样', () => {
    expect(slotLabel('instructions')).toBe('项目说明')
    expect(slotLabel('memories')).toBe('项目记忆')
    expect(slotLabel('skills')).toBe('项目技能')
    expect(slotLabel('whatever')).toBe('whatever')
  })
})
