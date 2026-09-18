import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { api } from '../../lib/api'
import { createMemoryAuthSession } from '../../lib/authSession'
import type { ResolvedProjectScope } from '../../lib/projectScope'
import { ToastProvider, TooltipProvider } from '../ui'
import { ProjectAssetsManagePanel } from './ProjectAssetsManagePanel'

const WORK = { id: 'wp_muying_2026', key: 'MY', name: '小红书母婴号运营' }
const CHAT = { id: 'chat_muying_0001', name: 'momo 号运营', boardProjectId: WORK.id }

/** 直接给定已解析的作用域（同 AgentProjectPreview.test：不被 sidebar 的作用域重置竞态绑住）。 */
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

function mount() {
  return render(
    <ToastProvider>
      <TooltipProvider>
        <ProjectAssetsManagePanel auth={auth} />
      </TooltipProvider>
    </ToastProvider>,
  )
}

describe('ProjectAssetsManagePanel', () => {
  test('已绑定会话组：标题与说明面向用户，不念 API 路径 / digest / facade', async () => {
    vi.spyOn(api, 'listProjectAssets').mockResolvedValue([])
    const { container } = mount()
    expect(await screen.findByText('项目资产')).toBeInTheDocument()
    const text = container.textContent ?? ''
    expect(text).toContain('上传给这个项目的参考文件')
    expect(text).not.toMatch(/\/api\/|digest|facade|API/i)
  })

  test('工作项目没有绑定会话组：空态说明下一步，而不是「绑定聊天 facade」', () => {
    const saved = scopeRef.current
    scopeRef.current = {
      ...saved,
      chatProject: null,
      bound: false,
      chatProjectIdForFilter: undefined,
    }
    const { container } = mount()
    expect(screen.getByText('这个工作项目还没有绑定会话组')).toBeInTheDocument()
    expect(screen.getByText(/把一个会话组绑定到这个工作项目后/)).toBeInTheDocument()
    expect(container.textContent ?? '').not.toMatch(/facade/)
    scopeRef.current = saved
  })

  test('「全部项目」作用域不渲染', () => {
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
    mount()
    // Provider 会自己渲染 toast 容器，只断言面板本身不存在。
    expect(screen.queryByTestId('project-assets-manage')).not.toBeInTheDocument()
    expect(screen.queryByText('项目资产')).not.toBeInTheDocument()
    scopeRef.current = saved
  })
})
