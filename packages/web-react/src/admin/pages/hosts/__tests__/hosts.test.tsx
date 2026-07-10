import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ToastProvider, TooltipProvider } from '../../../../components/ui'

vi.mock('chart.js/auto', () => ({
  default: class {
    destroy() {}
  },
}))

vi.mock('../../../lib/adminApi', () => {
  class ApiError extends Error {}
  return { ApiError, adminGet: vi.fn(), adminSend: vi.fn(), adminText: vi.fn() }
})

import { adminGet, adminSend } from '../../../lib/adminApi'
import HostsPage from '../index'
import { SetExpiresModal } from '../modals'
import type { HostRow } from '../types'

function host(partial: Partial<HostRow> & Pick<HostRow, 'id' | 'name' | 'status'>): HostRow {
  return {
    host: '1.2.3.4',
    ssh_port: 22,
    ssh_user: 'root',
    agent_port: 9443,
    max_containers: 20,
    active_containers: 0,
    cert_not_before: null,
    cert_not_after: null,
    last_health_at: null,
    last_health_ok: null,
    last_health_err: null,
    consecutive_health_ok: 0,
    consecutive_health_fail: 0,
    last_bootstrap_at: null,
    last_bootstrap_err: null,
    expires_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    loaded_image_id: null,
    desired_image_id: null,
    last_health_endpoint_ok: null,
    last_uplink_ok: null,
    last_egress_probe_ok: null,
    last_health_poll_at: null,
    last_uplink_at: null,
    last_egress_probe_at: null,
    placement_gate_open: true,
    disk_pct: null,
    mem_pct: null,
    load1: null,
    cpu_count: null,
    metrics_at: null,
    req_5m: 0,
    ...partial,
  }
}

const HOSTS: HostRow[] = [
  host({
    id: 'h1',
    name: 'tk-01',
    status: 'ready',
    active_containers: 2,
    max_containers: 20,
    disk_pct: 88,
    mem_pct: 40,
    load1: 1.2,
    cpu_count: 4,
    metrics_at: new Date().toISOString(),
    placement_gate_open: true,
  }),
  host({
    id: 'h2',
    name: 'tk-02',
    status: 'draining',
    active_containers: 0,
    placement_gate_open: false,
  }),
]

const BASELINE = {
  master_version: 'v5-ccb-aaa',
  master_err: null,
  per_host: [
    { host_id: 'h1', name: 'tk-01', remote_version: 'v5-ccb-aaa', err: null },
    { host_id: 'h2', name: 'tk-02', remote_version: 'v5-ccb-old', err: null },
  ],
}

function routeGet(path: string) {
  if (path === '/v3/compute-hosts') return Promise.resolve({ hosts: HOSTS })
  if (path === '/v3/baseline-version') return Promise.resolve(BASELINE)
  return Promise.resolve({})
}

function renderPage() {
  return render(
    <ToastProvider>
      <TooltipProvider>
        <HostsPage />
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

describe('HostsPage', () => {
  test('渲染 KPI + host 卡 + baseline', async () => {
    renderPage()
    expect(await screen.findByText('总虚机')).toBeTruthy()
    expect(screen.getByText('tk-01')).toBeTruthy()
    expect(screen.getByText('tk-02')).toBeTruthy()
    // baseline master 版本
    expect(await screen.findByText('v5-ccb-aaa')).toBeTruthy()
    // 资源水位 label
    expect(screen.getAllByText('磁盘').length).toBeGreaterThan(0)
  })

  test('排空 ready host → 确认 → 正确端点', async () => {
    renderPage()
    await screen.findByText('tk-01')
    fireEvent.click(screen.getByRole('button', { name: '排空' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('排空虚机 tk-01')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: '确定' }))
    await waitFor(() =>
      expect(adminSend).toHaveBeenCalledWith('POST', '/v3/compute-hosts/h1/drain', {}),
    )
  })

  test('删除 draining host（active=0）→ 确认 → 正确端点', async () => {
    renderPage()
    await screen.findByText('tk-02')
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('删除虚机 tk-02')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: '确定' }))
    await waitFor(() =>
      expect(adminSend).toHaveBeenCalledWith('POST', '/v3/compute-hosts/h2/remove', {}),
    )
  })

  test('expires-at 返回 204（空体）不被误报为失败', async () => {
    // 地基 adminSend 对 204 会抛 SyntaxError；SetExpiresModal.sendVoid 应吞掉并当成功。
    ;(adminSend as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new SyntaxError('Unexpected end of JSON input'),
    )
    const onSaved = vi.fn()
    const onClose = vi.fn()
    render(
      <ToastProvider>
        <TooltipProvider>
          <SetExpiresModal
            target={{ id: 'h1', name: 'tk-01', current: null }}
            onClose={onClose}
            onSaved={onSaved}
          />
        </TooltipProvider>
      </ToastProvider>,
    )
    fireEvent.click(await screen.findByRole('button', { name: '清空' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(onClose).toHaveBeenCalled()
    expect(adminSend).toHaveBeenCalledWith('POST', '/v3/compute-hosts/h1/expires-at', {
      expires_at: null,
    })
  })

  test('添加虚机弹窗校验必填', async () => {
    renderPage()
    await screen.findByText('tk-01')
    fireEvent.click(screen.getByRole('button', { name: /添加虚机/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /添加并 Bootstrap/ }))
    expect(await within(dialog).findByText(/请填完必填项/)).toBeTruthy()
    expect(adminSend).not.toHaveBeenCalled()
  })
})
