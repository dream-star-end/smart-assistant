/**
 * msc-config 阶段 B(CFG-23):SettingsCenter 偏好快照的「重开重拉 + 乱序 patch 丢弃」,
 * ProjectSettingsDialog 两阶段保存的版本推进与失败提示。
 * 运行:cd packages/web-react; npx vitest run src/components/mscConfigSettingsStateMachine.test.tsx --maxWorkers=1
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { api } from '../lib/api'
import { createMemoryAuthSession } from '../lib/authSession'
import { taskboardApi } from '../lib/taskboard'
import type { AuthSession, ChatProject } from '../lib/types'
import { ProjectSettingsDialog } from './ProjectSettingsDialog'
import { SettingsCenter } from './SettingsCenter'
import { ToastProvider, TooltipProvider } from './ui'

vi.mock('./settings/AccountTab', () => ({ AccountTab: () => <div>账户页</div> }))
vi.mock('./settings/UsageTab', () => ({ UsageTab: () => <div>用量页</div> }))
const preferencesProps = vi.hoisted(() => vi.fn())
vi.mock('./settings/PreferencesTab', () => ({
  PreferencesTab: (props: {
    prefs: Record<string, unknown>
    onPatch: (p: Record<string, unknown>) => Promise<void>
  }) => {
    preferencesProps(props)
    return <div>偏好页 theme={String(props.prefs.theme ?? '')}</div>
  },
  BuiltinHotkeysTable: () => <div>快捷键页</div>,
}))
vi.mock('./settings/SubscriptionDialog', () => ({ SubscriptionDialog: () => null }))
vi.mock('./settings/ApiAccessTab', () => ({ ApiAccessTab: () => <div>API 接入页</div> }))

const auth: AuthSession = createMemoryAuthSession(() => {}, 'token')
const base = {
  auth,
  user: { id: 'u1', displayName: '用户', roles: ['user'] as string[], role: 'user' as const },
  theme: 'light' as const,
  onClose: () => {},
  onSetTheme: () => {},
  onOpenMemory: () => {},
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  preferencesProps.mockClear()
})

describe('SettingsCenter preferences snapshot (CFG-23)', () => {
  test('closing and reopening the settings center refetches preferences instead of reusing the stale snapshot', async () => {
    const get = vi
      .spyOn(api, 'getPreferences')
      .mockResolvedValueOnce({ prefs: { theme: 'light' } } as never)
      .mockResolvedValueOnce({ prefs: { theme: 'dark' } } as never)
    const { rerender } = render(<SettingsCenter {...base} open initialSection="preferences" />)
    expect(await screen.findByText('偏好页 theme=light')).toBeInTheDocument()
    expect(get).toHaveBeenCalledTimes(1)

    rerender(<SettingsCenter {...base} open={false} initialSection="preferences" />)
    rerender(<SettingsCenter {...base} open initialSection="preferences" />)
    expect(await screen.findByText('偏好页 theme=dark')).toBeInTheDocument()
    expect(get).toHaveBeenCalledTimes(2)
  })

  test('a late response from an earlier patch cannot overwrite the snapshot of a later patch', async () => {
    vi.spyOn(api, 'getPreferences').mockResolvedValue({ prefs: { theme: 'light' } } as never)
    let resolveFirst: (v: unknown) => void = () => {}
    const first = new Promise((resolve) => {
      resolveFirst = resolve
    })
    const patch = vi
      .spyOn(api, 'patchPreferences')
      .mockImplementationOnce(() => first as never)
      .mockResolvedValueOnce({ prefs: { theme: 'dark' } } as never)
    render(<SettingsCenter {...base} open initialSection="preferences" />)
    expect(await screen.findByText('偏好页 theme=light')).toBeInTheDocument()
    const onPatch = preferencesProps.mock.calls.at(-1)?.[0].onPatch as (
      p: Record<string, unknown>,
    ) => Promise<void>

    const p1 = onPatch({ theme: 'auto' }) // 先发,后到
    const p2 = onPatch({ theme: 'dark' }) // 后发,先到
    await p2
    expect(await screen.findByText('偏好页 theme=dark')).toBeInTheDocument()
    resolveFirst({ prefs: { theme: 'auto' } })
    await p1
    // 旧响应被丢弃:仍显示最后一次 patch 的结果
    expect(screen.getByText('偏好页 theme=dark')).toBeInTheDocument()
    expect(patch).toHaveBeenCalledTimes(2)
  })
})

const project: ChatProject = {
  id: 'p1',
  name: '调研',
  instructions: '用中文回答',
  color: 'accent',
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
  sessionCount: 2,
  boardProjectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
}

describe('ProjectSettingsDialog two-phase save (CFG-23)', () => {
  test('when the board context saved but the project patch failed, the retry uses the new version and the message says which half failed', async () => {
    vi.spyOn(taskboardApi, 'listProjects').mockResolvedValue([
      { id: project.boardProjectId, key: 'B', name: 'Board' } as never,
    ])
    vi.spyOn(taskboardApi, 'getProjectContext').mockResolvedValue({
      version: 2,
      instructions: 'from-board',
    })
    const put = vi
      .spyOn(taskboardApi, 'putProjectContext')
      .mockResolvedValueOnce({ ok: true, context: { version: 3, instructions: 'from-board' } })
      .mockResolvedValueOnce({ ok: true, context: { version: 4, instructions: 'from-board' } })
    const onSave = vi
      .fn()
      .mockRejectedValueOnce(new Error('PG 拒绝'))
      .mockResolvedValueOnce(undefined)
    const onClose = vi.fn()
    const session = createMemoryAuthSession(() => {}, 'tok')
    render(
      <ToastProvider>
        <TooltipProvider>
          <ProjectSettingsDialog
            open
            project={project}
            onClose={onClose}
            onSave={onSave}
            auth={session}
            authSession={session}
          />
        </TooltipProvider>
      </ToastProvider>,
    )
    await waitFor(() => expect(screen.getByLabelText('自定义指令')).toHaveValue('from-board'))

    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(put).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      project.boardProjectId,
      expect.objectContaining({ expectedVersion: 2 }),
    )
    const alert = await screen.findByText(/看板项目指令已保存，但项目名称/)
    expect(alert).toBeInTheDocument()
    expect(screen.queryByText(/刚被他处修改/)).not.toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()

    // 重试:必须带上第一阶段返回的新版本 3,而不是旧的 2
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2))
    expect(put).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      project.boardProjectId,
      expect.objectContaining({ expectedVersion: 3 }),
    )
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })
})
