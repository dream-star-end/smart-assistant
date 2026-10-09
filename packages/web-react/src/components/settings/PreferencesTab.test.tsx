import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { api } from '../../lib/api'
import { createMemoryAuthSession } from '../../lib/authSession'
import type { PrefsView } from '../../lib/modelPreferences'
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
        { id: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol' },
        { id: 'gpt-6.1-sol-1m', display_name: 'GPT-6.1-Sol' },
      ],
      lockedModels: [],
    })
    const onPatch = vi.fn(async () => {})
    render(
      <PreferencesTab
        auth={auth}
        prefs={{ default_model: 'gpt-6.1-sol' }}
        theme="system"
        onSetTheme={() => {}}
        onPatch={onPatch}
      />,
    )

    const select = await screen.findByRole('combobox', { name: '默认模型' })
    fireEvent.change(select, { target: { value: 'gpt-6.1-sol-1m' } })
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('实际总费用不一定只增加 50%')
    expect(onPatch).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '仍要切换' }))
    await waitFor(() => expect(onPatch).toHaveBeenCalledWith({ default_model: 'gpt-6.1-sol-1m' }))
  })

  test('不再提供自动继续执行设置', () => {
    vi.spyOn(api, 'getPublicModels').mockResolvedValue({ models: [], lockedModels: [] })
    render(
      <PreferencesTab
        auth={auth}
        prefs={{}}
        theme="system"
        onSetTheme={() => {}}
        onPatch={async () => {}}
      />,
    )

    expect(screen.queryByRole('switch', { name: '自动继续执行' })).not.toBeInTheDocument()
    expect(screen.queryByText('自动继续执行')).not.toBeInTheDocument()
  })
})

describe('PreferencesTab · 已下线入口', () => {
  test('API Key 管理已迁到「API 接入」分区,偏好页不再挂载', () => {
    vi.spyOn(api, 'getPublicModels').mockResolvedValue({ models: [], lockedModels: [] })
    render(
      <PreferencesTab
        auth={auth}
        prefs={{}}
        theme="system"
        onSetTheme={() => {}}
        onPatch={async () => {}}
      />,
    )
    expect(screen.queryByText('API Key')).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText(/新密钥名称/)).not.toBeInTheDocument()
  })

  test('「全面优化」开关、同意弹窗与「查看优化建议」入口随管理中心「优化」分区下线', () => {
    vi.spyOn(api, 'getPublicModels').mockResolvedValue({ models: [], lockedModels: [] })
    const onPatch = vi.fn(async () => {})
    render(
      <PreferencesTab
        auth={auth}
        prefs={{ auto_optimizer_enabled: true }}
        theme="system"
        onSetTheme={() => {}}
        onPatch={onPatch}
      />,
    )
    expect(screen.queryByRole('switch', { name: 'Auto-Dream' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '查看优化建议' })).not.toBeInTheDocument()
    expect(screen.queryByText(/开启 Auto‑Dream 全面优化/)).not.toBeInTheDocument()
    expect(screen.queryByText(/全面审计/)).not.toBeInTheDocument()
    expect(onPatch).not.toHaveBeenCalled()
  })
})

describe('PreferencesTab · 全面优化关闭出口', () => {
  function Harness({ onPatch }: { onPatch: (p: Record<string, unknown>) => void }) {
    const [prefs, setPrefs] = useState<PrefsView>({ auto_optimizer_enabled: true })
    return (
      <PreferencesTab
        auth={auth}
        prefs={prefs}
        theme="system"
        onSetTheme={() => {}}
        onPatch={async (p) => {
          onPatch(p)
          setPrefs((prev) => ({ ...prev, ...(p as PrefsView) }))
        }}
      />
    )
  }

  test('仍开启时只给一个「关闭」，点击写 auto_optimizer_enabled=false 后整行消失', async () => {
    vi.spyOn(api, 'getPublicModels').mockResolvedValue({ models: [], lockedModels: [] })
    const onPatch = vi.fn()
    render(<Harness onPatch={onPatch} />)
    expect(screen.getByText('全面优化已下线')).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Auto-Dream' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(onPatch).toHaveBeenCalledWith({ auto_optimizer_enabled: false }))
    expect(onPatch).toHaveBeenCalledTimes(1)
    // 关闭不弹同意框
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText('全面优化已下线')).not.toBeInTheDocument())
    expect(screen.queryByRole('button', { name: '关闭' })).not.toBeInTheDocument()
  })

  test.each([[{}], [{ auto_optimizer_enabled: false }]])('未开启（%o）时不渲染', (prefs) => {
    vi.spyOn(api, 'getPublicModels').mockResolvedValue({ models: [], lockedModels: [] })
    render(
      <PreferencesTab
        auth={auth}
        prefs={prefs}
        theme="system"
        onSetTheme={() => {}}
        onPatch={async () => {}}
      />,
    )
    expect(screen.queryByText('全面优化已下线')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '关闭' })).not.toBeInTheDocument()
  })
})

describe('BuiltinHotkeysTable · 快捷键只读表', () => {
  test('独立渲染内置说明,不发任何请求,没有可编辑 input', () => {
    const models = vi.spyOn(api, 'getPublicModels').mockResolvedValue({ models: [], lockedModels: [] })
    render(<BuiltinHotkeysTable />)
    expect(screen.getByText('搜索与跳转（项目、会话、文件）')).toBeInTheDocument()
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
        theme="system"
        onSetTheme={() => {}}
        onPatch={async () => {}}
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
        theme="system"
        onSetTheme={() => {}}
        onPatch={async () => {}}
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
        theme="system"
        onSetTheme={() => {}}
        onPatch={async () => {}}
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
