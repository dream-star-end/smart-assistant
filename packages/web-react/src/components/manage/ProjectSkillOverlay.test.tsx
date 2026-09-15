import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ApiError, api } from '../../lib/api'
import { createMemoryAuthSession } from '../../lib/authSession'
import type { ResolvedProjectScope } from '../../lib/projectScope'
import { taskboardApi } from '../../lib/taskboard'
import type { SkillSummary } from '../../lib/types'
import { ToastProvider } from '../ui'
import { ProjectSkillOverlay } from './ProjectSkillOverlay'

const WORK = { id: 'wp_muying_2026', key: 'MY', name: '小红书母婴号运营' }
const CHAT = { id: 'chat_muying_0001', name: 'momo 号运营', boardProjectId: WORK.id }

const WORK_SCOPE: ResolvedProjectScope = {
  kind: 'work',
  token: WORK.id,
  chatProject: CHAT,
  workProject: WORK,
  bound: true,
  chatProjectIdForFilter: CHAT.id,
  invalid: false,
}
const ALL_SCOPE: ResolvedProjectScope = {
  kind: 'all',
  token: 'all',
  chatProject: null,
  workProject: null,
  bound: false,
  chatProjectIdForFilter: undefined,
  invalid: false,
}

/** 直接给定已解析的作用域（不被 sidebar 归属的作用域重置竞态绑住，见 AgentProjectPreview.test）。 */
const scopeRef: { current: ResolvedProjectScope } = { current: WORK_SCOPE }

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

const SKILLS: SkillSummary[] = [
  {
    name: 'writer-pro',
    description: '帮你把草稿改成成稿\n第二行',
    writable: true,
    layer: 'shared',
    agentIds: [],
  },
  {
    name: 'xhs-publish',
    description: '发布小红书笔记',
    writable: true,
    layer: 'shared',
    agentIds: [],
  },
  {
    name: 'v5-selfhost-cursor-key-rotation',
    description: '轮换账号密钥',
    writable: true,
    layer: 'shared',
    agentIds: [],
  },
]

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  scopeRef.current = WORK_SCOPE
})

function mount(overlay: string[] = ['writer-pro']) {
  vi.spyOn(api, 'listSkills').mockResolvedValue(SKILLS)
  const getCtx = vi
    .spyOn(taskboardApi, 'getProjectContext')
    .mockResolvedValue({ version: 3, skillOverlay: overlay, instructions: null })
  const put = vi.spyOn(taskboardApi, 'putProjectContext')
  render(
    <ToastProvider>
      <ProjectSkillOverlay auth={auth} />
    </ToastProvider>,
  )
  return { getCtx, put }
}

async function expand() {
  fireEvent.click(await screen.findByRole('button', { name: /项目专属技能/ }))
}

describe('ProjectSkillOverlay', () => {
  test('非工作项目作用域整块不渲染，也不发任何请求', () => {
    scopeRef.current = ALL_SCOPE
    const list = vi.spyOn(api, 'listSkills')
    const getCtx = vi.spyOn(taskboardApi, 'getProjectContext')
    render(
      <ToastProvider>
        <ProjectSkillOverlay auth={auth} />
      </ToastProvider>,
    )
    // ToastProvider 会自己渲染 toast 容器，只断言面板本身不存在（改造前这里是一句孤零零的灰字）。
    expect(screen.queryByTestId('project-skill-overlay')).not.toBeInTheDocument()
    expect(screen.queryByText(/项目专属技能|选择工作项目后/)).not.toBeInTheDocument()
    expect(list).not.toHaveBeenCalled()
    expect(getCtx).not.toHaveBeenCalled()
  })

  test('默认折叠成一行摘要（已启用数），展开后才出现清单与保存', async () => {
    mount(['writer-pro'])
    const toggle = await screen.findByRole('button', { name: /项目专属技能/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(await within(toggle).findByText('已启用 1')).toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '保存' })).not.toBeInTheDocument()

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(await screen.findAllByRole('switch')).toHaveLength(3)
    expect(screen.getByRole('button', { name: '保存' })).toBeInTheDocument()
  })

  test('每行显示列表同款展示名 + slug 作补充；点文字即可切换开关', async () => {
    mount([])
    await expand()
    // 展示名（描述首行）与 slug 同时可见，「覆盖 / 已排除」这类实现词不再出现。
    expect(await screen.findByText('帮你把草稿改成成稿')).toBeInTheDocument()
    expect(screen.getByText('writer-pro')).toBeInTheDocument()
    expect(screen.queryByText(/覆盖|已排除/)).not.toBeInTheDocument()

    const sw = screen.getByTestId('project-skill-writer-pro')
    expect(sw).toHaveAttribute('aria-checked', 'false')
    // <label htmlFor> 关联：点击文字等同点击开关（改造前文字是 <span>，点了没反应）。
    fireEvent.click(screen.getByText('帮你把草稿改成成稿'))
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'true'))
  })

  test('与服务端快照无差异时「保存」禁用；改动后可保存，成功回写基线', async () => {
    const { put } = mount(['writer-pro'])
    put.mockResolvedValue({ ok: true, context: { version: 4, instructions: null } })
    await expand()
    await screen.findAllByRole('switch')
    const save = screen.getByRole('button', { name: '保存' })
    expect(save).toBeDisabled()

    fireEvent.click(screen.getByTestId('project-skill-xhs-publish'))
    await waitFor(() => expect(save).toBeEnabled())
    fireEvent.click(save)
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith(auth, WORK.id, {
        expectedVersion: 3,
        skillNames: ['writer-pro', 'xhs-publish'],
      }),
    )
    // 保存成功后基线更新 → 再次无差异 → 保存回到禁用。
    await waitFor(() => expect(screen.getByRole('button', { name: '保存' })).toBeDisabled())
  })

  test('保存失败留在块内（不是 toast），并给出重新读取的出口', async () => {
    const { put, getCtx } = mount([])
    put.mockRejectedValue(new ApiError({ status: 409, message: '版本冲突', requestId: 'r1' }))
    await expand()
    await screen.findAllByRole('switch')
    fireEvent.click(screen.getByTestId('project-skill-xhs-publish'))
    fireEvent.click(await screen.findByRole('button', { name: '保存' }))
    expect(await screen.findByText(/版本冲突/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重新读取' }))
    await waitFor(() => expect(getCtx).toHaveBeenCalledTimes(2))
  })

  test('密钥类技能按规则判定：开关禁用并带说明徽章，不再靠写死 slug', async () => {
    mount(['v5-selfhost-cursor-key-rotation'])
    await expand()
    const sw = await screen.findByTestId('project-skill-v5-selfhost-cursor-key-rotation')
    expect(sw).toBeDisabled()
    expect(sw).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByText('密钥类，不可用于项目')).toBeInTheDocument()
    // 服务端清单里即便带着它，摘要计数也不把它算作已启用。
    expect(screen.getByText('已启用 0')).toBeInTheDocument()
  })
})
