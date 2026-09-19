import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { api } from '../../lib/api'
import { createMemoryAuthSession } from '../../lib/authSession'
import type { AuthSession } from '../../lib/types'
import { BuiltinHotkeysTable, PreferencesTab } from './PreferencesTab'

vi.mock('./QqBindingCard', () => ({ QqBindingCard: () => null }))

const auth: AuthSession = createMemoryAuthSession(() => {}, 'tok')

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('PreferencesTab · 对话行为', () => {
  test('默认模型切到 1M 前确认长上下文累计计费风险', async () => {
    vi.spyOn(api, 'getPublicModels').mockResolvedValue({
      models: [
        { id: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol' },
        { id: 'gpt-5.6-sol-1m', display_name: 'GPT-5.6-Sol' },
      ],
      lockedModels: [],
    })
    const onPatch = vi.fn(async () => {})
    render(
      <PreferencesTab
        auth={auth}
        prefs={{ default_model: 'gpt-5.6-sol' }}
        autoDream={null}
        theme="system"
        onSetTheme={() => {}}
        onPatch={onPatch}
        onUpgrade={() => {}}
        onOpenMemory={() => {}}
      />,
    )

    const select = await screen.findByRole('combobox', { name: '默认模型' })
    fireEvent.change(select, { target: { value: 'gpt-5.6-sol-1m' } })
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('实际总费用不一定只增加 50%')
    expect(onPatch).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '仍要切换' }))
    await waitFor(() => expect(onPatch).toHaveBeenCalledWith({ default_model: 'gpt-5.6-sol-1m' }))
  })

  test('不再提供自动继续执行设置', () => {
    vi.spyOn(api, 'getPublicModels').mockResolvedValue({ models: [], lockedModels: [] })
    render(
      <PreferencesTab
        auth={auth}
        prefs={{}}
        autoDream={null}
        theme="system"
        onSetTheme={() => {}}
        onPatch={async () => {}}
        onUpgrade={() => {}}
        onOpenMemory={() => {}}
      />,
    )

    expect(screen.queryByRole('switch', { name: '自动继续执行' })).not.toBeInTheDocument()
    expect(screen.queryByText('自动继续执行')).not.toBeInTheDocument()
  })
})

describe('PreferencesTab · Auto-Dream', () => {
  test('API Key 管理已迁到「API 接入」分区,偏好页不再挂载', () => {
    vi.spyOn(api, 'getPublicModels').mockResolvedValue({ models: [], lockedModels: [] })
    render(
      <PreferencesTab
        auth={auth}
        prefs={{}}
        autoDream={null}
        theme="system"
        onSetTheme={() => {}}
        onPatch={async () => {}}
        onUpgrade={() => {}}
        onOpenMemory={() => {}}
      />,
    )
    expect(screen.queryByText('API Key')).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText(/新密钥名称/)).not.toBeInTheDocument()
  })

  test('显示 MiniMax 全面审计范围，并提供优化建议入口', async () => {
    vi.spyOn(api, 'getPublicModels').mockResolvedValue({ models: [], lockedModels: [] })
    const openMemory = vi.fn()

    render(
      <PreferencesTab
        auth={auth}
        prefs={{ auto_optimizer_enabled: true }}
        autoDream={
          {
            eligible: true,
            available: true,
            enabled: true,
            optimizer_enabled: true,
            legacy_enabled: false,
            effective: true,
            minimum_plan_code: 'max',
            min_interval_hours: 168,
            min_new_sessions: 5,
            // 模拟滚动发布期间旧响应仍带字段；UI 也不能显示。
            model_id: 'MiniMax-M3',
            model_name: 'MiniMax M3',
          } as never
        }
        theme="system"
        onSetTheme={() => {}}
        onPatch={async () => {}}
        onUpgrade={() => {}}
        onOpenMemory={openMemory}
      />,
    )

    expect(screen.getByText(/MiniMax M3 结合平台功能与技能/)).toBeInTheDocument()
    expect(screen.queryByText(/MiniMax-M3/)).not.toBeInTheDocument()
    expect(screen.getByText(/所有用户内容和功能设置修改都先展示差异/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '查看优化建议' }))
    expect(openMemory).toHaveBeenCalledTimes(1)
  })

  test('开启全面优化前必须确认审计、计费和匿名上报', async () => {
    vi.spyOn(api, 'getPublicModels').mockResolvedValue({ models: [], lockedModels: [] })
    const onPatch = vi.fn(async () => {})
    render(
      <PreferencesTab
        auth={auth}
        prefs={{}}
        autoDream={{
          eligible: true,
          available: true,
          enabled: false,
          optimizer_enabled: false,
          legacy_enabled: false,
          effective: false,
          minimum_plan_code: 'max',
          min_interval_hours: 168,
          min_new_sessions: 5,
        }}
        theme="system"
        onSetTheme={() => {}}
        onPatch={onPatch}
        onUpgrade={() => {}}
        onOpenMemory={() => {}}
      />,
    )

    fireEvent.click(screen.getByRole('switch', { name: 'Auto-Dream' }))
    expect(screen.getByText('开启 Auto‑Dream 全面优化？')).toBeInTheDocument()
    expect(screen.getByText(/匿名平台优化发现/)).toBeInTheDocument()
    expect(onPatch).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '同意并开启' }))
    await vi.waitFor(() => expect(onPatch).toHaveBeenCalledWith({ auto_optimizer_enabled: true }))
  })

  test('不可用提示也不解释后台模型身份', () => {
    vi.spyOn(api, 'getPublicModels').mockResolvedValue({ models: [], lockedModels: [] })
    render(
      <PreferencesTab
        auth={auth}
        prefs={{}}
        autoDream={{
          eligible: true,
          available: false,
          enabled: false,
          effective: false,
          minimum_plan_code: 'max',
          min_interval_hours: 24,
          min_new_sessions: 5,
        }}
        theme="system"
        onSetTheme={() => {}}
        onPatch={async () => {}}
        onUpgrade={() => {}}
        onOpenMemory={() => {}}
      />,
    )

    expect(screen.getByText('Auto‑Dream 当前暂不可用，功能已安全暂停。')).toBeInTheDocument()
    expect(screen.queryByText(/模型当前不可用/)).not.toBeInTheDocument()
  })
})

describe('BuiltinHotkeysTable · 快捷键只读表', () => {
  test('独立渲染内置说明,不发任何请求,没有可编辑 input', () => {
    const models = vi.spyOn(api, 'getPublicModels').mockResolvedValue({ models: [], lockedModels: [] })
    render(<BuiltinHotkeysTable />)
    expect(screen.getByText('搜索会话')).toBeInTheDocument()
    expect(screen.getByText('新建会话')).toBeInTheDocument()
    expect(screen.getByText('停止生成（生成中）')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText('动作名')).not.toBeInTheDocument()
    expect(models).not.toHaveBeenCalled()
  })

  test('修饰键随平台:非 mac 显示 Ctrl', () => {
    // jsdom 的 navigator.platform 为空串,isMacPlatform 走 userAgent 判定 → 非 mac。
    render(<BuiltinHotkeysTable />)
    expect(screen.getByText('Ctrl+K')).toBeInTheDocument()
    expect(screen.queryByText('⌘+K')).not.toBeInTheDocument()
  })
})

describe('PreferencesTab · 通知分区', () => {
  test('不渲染 Telegram 开关(用户侧无绑定通道),邮件通知带说明', async () => {
    vi.spyOn(api, 'getPublicModels').mockResolvedValue({ models: [], lockedModels: [] })
    render(
      <PreferencesTab
        auth={auth}
        prefs={{ notify_email: true, notify_telegram: true }}
        autoDream={null}
        theme="system"
        onSetTheme={() => {}}
        onPatch={async () => {}}
        onUpgrade={() => {}}
        onOpenMemory={() => {}}
      />,
    )
    expect(await screen.findByText('邮件通知')).toBeInTheDocument()
    expect(screen.getByText(/发送到账号邮箱/)).toBeInTheDocument()
    expect(screen.queryByText('Telegram 通知')).not.toBeInTheDocument()
  })

  test('模型列表返回体缺 models 时退化为空列表而不崩', async () => {
    vi.spyOn(api, 'getPublicModels').mockResolvedValue({} as never)
    render(
      <PreferencesTab
        auth={auth}
        prefs={{ default_model: 'cursor-x' }}
        autoDream={null}
        theme="system"
        onSetTheme={() => {}}
        onPatch={async () => {}}
        onUpgrade={() => {}}
        onOpenMemory={() => {}}
      />,
    )
    const select = await screen.findByRole('combobox', { name: '默认模型' })
    expect(select).toHaveValue('cursor-x')
  })
})

describe('PreferencesTab · 输入分区', () => {
  test('偏好首屏渲染「输入」分区与本设备说明', async () => {
    vi.spyOn(api, 'getPublicModels').mockResolvedValue({ models: [], lockedModels: [] })
    render(
      <PreferencesTab
        auth={auth}
        prefs={{}}
        autoDream={null}
        theme="system"
        onSetTheme={() => {}}
        onPatch={async () => {}}
        onUpgrade={() => {}}
        onOpenMemory={() => {}}
      />,
    )
    expect(await screen.findByText('输入')).toBeInTheDocument()
    expect(screen.getByText('仅本设备生效')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Enter 发送' })).toBeInTheDocument()
    // 修饰键随平台(审计 SET-20);jsdom 非 mac → Ctrl。
    expect(screen.getByRole('button', { name: 'Ctrl+Enter 发送' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '⌘+Enter 发送' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '默认' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '大' })).toBeInTheDocument()
  })
})
