import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { api } from '../../lib/api'
import { createMemoryAuthSession } from '../../lib/authSession'
import { QqBindingCard } from './QqBindingCard'

const auth = createMemoryAuthSession(() => {}, 'token')

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('QqBindingCard', () => {
  test('creates one-time code and explains scan-then-send flow', async () => {
    vi.spyOn(api, 'getQqBinding').mockResolvedValue({
      available: true,
      bound: false,
      entry_url: 'https://qq.example/bot',
    })
    vi.spyOn(api, 'startQqBinding').mockResolvedValue({
      available: true,
      entry_url: 'https://qq.example/bot',
      bind_code: '23AB45CD67',
      expires_at: Date.now() + 600_000,
    })
    render(<QqBindingCard auth={auth} prefs={{}} onPatch={async () => {}} />)
    const button = await screen.findByRole('button', { name: /扫码绑定 QQ/ })
    fireEvent.click(button)
    expect(await screen.findByText('/bind 23AB45CD67')).toBeInTheDocument()
    expect(screen.getByAltText('QQ Bot 入口二维码')).toBeInTheDocument()
  })

  test('复制绑定命令：clipboard 缺失（非安全上下文）不抛错并给出提示；可用时显示已复制', async () => {
    // 审计 SET-23：此前 `void navigator.clipboard.writeText()` 无兜底，clipboard 为 undefined 会同步抛。
    vi.spyOn(api, 'getQqBinding').mockResolvedValue({
      available: true,
      bound: false,
      entry_url: 'https://qq.example/bot',
    })
    vi.spyOn(api, 'startQqBinding').mockResolvedValue({
      available: true,
      entry_url: 'https://qq.example/bot',
      bind_code: '23AB45CD67',
      expires_at: Date.now() + 600_000,
    })
    const original = Object.getOwnPropertyDescriptor(window.navigator, 'clipboard')
    Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: undefined })
    try {
      render(<QqBindingCard auth={auth} prefs={{}} onPatch={async () => {}} />)
      fireEvent.click(await screen.findByRole('button', { name: /扫码绑定 QQ/ }))
      const copyBtn = await screen.findByRole('button', { name: '复制绑定命令' })
      expect(() => fireEvent.click(copyBtn)).not.toThrow()
      expect(await screen.findByText('复制失败，请手动输入上面的绑定命令。')).toBeInTheDocument()

      const writeText = vi.fn().mockResolvedValue(undefined)
      Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText } })
      fireEvent.click(copyBtn)
      await waitFor(() => expect(writeText).toHaveBeenCalledWith('/bind 23AB45CD67'))
    } finally {
      if (original) Object.defineProperty(window.navigator, 'clipboard', original)
      else Reflect.deleteProperty(window.navigator, 'clipboard')
    }
  })

  test('bound user can toggle proactive delivery and unbind', async () => {
    vi.spyOn(api, 'getQqBinding')
      .mockResolvedValueOnce({
        available: true,
        bound: true,
        maskedOpenid: '••••abcd',
      })
      .mockResolvedValueOnce({ available: true, bound: false })
    vi.spyOn(api, 'deleteQqBinding').mockResolvedValue({ ok: true, unbound: true })
    const patch = vi.fn(async () => {})
    render(<QqBindingCard auth={auth} prefs={{}} onPatch={patch} />)
    const proactive = await screen.findByRole('switch')
    expect(proactive).toBeChecked()
    fireEvent.click(proactive)
    expect(patch).toHaveBeenCalledWith({ qq_proactive_push: false })
    fireEvent.click(screen.getByRole('button', { name: /解绑/ }))
    // 解绑走项目内 Promise 式确认对话框（不再用原生 window.confirm）。
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '解绑' }))
    await waitFor(() => expect(api.deleteQqBinding).toHaveBeenCalled())
  })
})
