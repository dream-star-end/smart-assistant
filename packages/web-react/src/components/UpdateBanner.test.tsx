import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appUpdate } from '../lib/appUpdate'
import { UpdateBanner } from './UpdateBanner'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('UpdateBanner(版本更新横幅,shell 审计 S-13)', () => {
  it('governor 判定不可见时不渲染', () => {
    vi.spyOn(appUpdate, 'getBannerVisible').mockReturnValue(false)
    const { container } = render(<UpdateBanner />)
    expect(container).toBeEmptyDOMElement()
  })

  it('可见时:全角标点文案、两个动作是 Button 原语、且是 polite 的 status 而非打断式 alert', () => {
    vi.spyOn(appUpdate, 'getBannerVisible').mockReturnValue(true)
    const reload = vi.spyOn(appUpdate, 'reloadNow').mockImplementation(() => {})
    const dismiss = vi.spyOn(appUpdate, 'dismissBanner').mockImplementation(() => {})
    render(<UpdateBanner />)

    expect(screen.getByText('新版本已就绪，刷新页面即可更新。')).toBeInTheDocument()
    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()

    const refresh = screen.getByRole('button', { name: '立即刷新' })
    const later = screen.getByRole('button', { name: '稍后' })
    for (const b of [refresh, later]) {
      expect(b.className).toContain('[@media(hover:none)]:min-h-11')
      expect(b.className).toContain('focus-visible:ring-2')
    }
    fireEvent.click(refresh)
    expect(reload).toHaveBeenCalledTimes(1)
    fireEvent.click(later)
    expect(dismiss).toHaveBeenCalledTimes(1)
  })
})
