import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

  test('bound user can toggle proactive delivery and unbind', async () => {
    vi.spyOn(api, 'getQqBinding')
      .mockResolvedValueOnce({
        available: true,
        bound: true,
        maskedOpenid: '••••abcd',
      })
      .mockResolvedValueOnce({ available: true, bound: false })
    vi.spyOn(api, 'deleteQqBinding').mockResolvedValue({ ok: true, unbound: true })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const patch = vi.fn(async () => {})
    render(<QqBindingCard auth={auth} prefs={{}} onPatch={patch} />)
    const proactive = await screen.findByRole('switch')
    expect(proactive).toBeChecked()
    fireEvent.click(proactive)
    expect(patch).toHaveBeenCalledWith({ qq_proactive_push: false })
    fireEvent.click(screen.getByRole('button', { name: /解绑/ }))
    await waitFor(() => expect(api.deleteQqBinding).toHaveBeenCalled())
  })
})
