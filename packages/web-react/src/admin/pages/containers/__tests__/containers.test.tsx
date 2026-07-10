import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ToastProvider, TooltipProvider } from '../../../../components/ui'

// chart.js 需要真实 canvas ctx（jsdom 无）→ 桩掉，避免 useChart 内 new Chart 抛错。
vi.mock('chart.js/auto', () => ({
  default: class {
    destroy() {}
  },
}))

// 数据层：路由式 adminGet + resolve 型 adminSend。保留 ApiError 导出（页面按 instanceof 分支）。
vi.mock('../../../lib/adminApi', () => {
  class ApiError extends Error {}
  return { ApiError, adminGet: vi.fn(), adminSend: vi.fn(), adminText: vi.fn() }
})

import { adminGet, adminSend } from '../../../lib/adminApi'
import ContainersPage from '../index'

const STATS = {
  total: 42,
  running: 10,
  provisioning: 2,
  stopped: 5,
  error: 1,
  gone: 3,
  v2: 20,
  v3: 22,
  expiring_7d: 4,
  with_last_error: 6,
}

const ROWS = [
  {
    id: 123,
    user_id: 7,
    user_email: 'alice@example.com',
    subscription_id: null,
    subscription_status: null,
    subscription_end_at: null,
    docker_id: 'abc123def456',
    docker_name: null,
    workspace_volume: null,
    home_volume: null,
    image: 'registry/oc-runtime:v5-ccb-aaa',
    status: 'running',
    state: 'running',
    lifecycle: 'running',
    row_kind: 'v3',
    last_started_at: new Date().toISOString(),
    last_stopped_at: null,
    volume_gc_at: null,
    last_error: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    host_uuid: '11111111-1111-1111-1111-111111111111',
    host_name: 'tk-01',
  },
  {
    id: 200,
    user_id: 9,
    user_email: 'bob@example.com',
    subscription_id: null,
    subscription_status: null,
    subscription_end_at: null,
    docker_id: null,
    docker_name: 'oc_v2_bob',
    workspace_volume: null,
    home_volume: null,
    image: 'registry/oc-runtime:v5-ccb-bbb',
    status: 'error',
    state: 'error',
    lifecycle: 'error',
    row_kind: 'v2',
    last_started_at: null,
    last_stopped_at: new Date().toISOString(),
    volume_gc_at: null,
    last_error: 'boom last error',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    host_uuid: null,
    host_name: null,
  },
]

function routeGet(path: string) {
  if (path === '/agent-containers/stats') return Promise.resolve(STATS)
  if (path === '/agent-containers') return Promise.resolve({ rows: ROWS })
  return Promise.resolve({})
}

function renderPage() {
  return render(
    <ToastProvider>
      <TooltipProvider>
        <ContainersPage />
      </TooltipProvider>
    </ToastProvider>,
  )
}

beforeEach(() => {
  window.location.hash = ''
  ;(adminGet as ReturnType<typeof vi.fn>).mockImplementation(routeGet)
  ;(adminSend as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true })
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ContainersPage', () => {
  test('渲染 KPI + 容器行 + 生命周期徽标', async () => {
    renderPage()
    // KPI（loading 结束后 label 才出现）
    expect(await screen.findByText('总容器')).toBeTruthy()
    expect(screen.getByText('42')).toBeTruthy()
    expect(screen.getByText('错误 / 曾报错')).toBeTruthy()
    // 行
    expect(await screen.findByText('alice@example.com')).toBeTruthy()
    expect(screen.getByText('bob@example.com')).toBeTruthy()
    // 曾报错 chip
    expect(screen.getByText('最近出错')).toBeTruthy()
  })

  test('email/user_id 客户端过滤', async () => {
    renderPage()
    await screen.findByText('alice@example.com')
    const search = screen.getByPlaceholderText('email / user_id 过滤') as HTMLInputElement
    fireEvent.change(search, { target: { value: 'bob' } })
    await waitFor(() => expect(screen.queryByText('alice@example.com')).toBeNull())
    expect(screen.getByText('bob@example.com')).toBeTruthy()
  })

  test('重启动作走确认弹窗 + 正确端点', async () => {
    renderPage()
    await screen.findByText('alice@example.com')
    // 第一行的「重启」按钮
    const restartBtns = screen.getAllByRole('button', { name: '重启' })
    fireEvent.click(restartBtns[0])
    // 确认弹窗
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('重启容器 #123')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: '重启' }))
    await waitFor(() =>
      expect(adminSend).toHaveBeenCalledWith('POST', '/agent-containers/123/restart'),
    )
  })

  test('删除动作二次确认后才调用端点', async () => {
    renderPage()
    await screen.findByText('alice@example.com')
    fireEvent.click(screen.getAllByRole('button', { name: '删除' })[0])
    // 第一次确认
    let dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('删除容器 #123')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: '删除' }))
    // 二次确认
    dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('再次确认删除')).toBeTruthy()
    // 尚未调用端点
    expect(adminSend).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: '确认删除' }))
    await waitFor(() =>
      expect(adminSend).toHaveBeenCalledWith('POST', '/agent-containers/123/remove'),
    )
  })

  test('host_uuid 深链 → 服务端过滤参数生效', async () => {
    window.location.hash = '#tab=containers&host_uuid=hostabc'
    renderPage()
    await screen.findByText('alice@example.com')
    // list 拉取带上 host_uuid
    await waitFor(() =>
      expect(adminGet).toHaveBeenCalledWith(
        '/agent-containers',
        expect.objectContaining({ host_uuid: 'hostabc' }),
      ),
    )
    // 清除虚机过滤按钮渲染
    expect(screen.getByRole('button', { name: /清除虚机过滤/ })).toBeTruthy()
  })
})
