import '@testing-library/jest-dom/vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider, useToast } from './Toast'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function locateStylesheet(): string {
  let dir = process.cwd()
  for (let i = 0; i < 6; i += 1) {
    for (const candidate of [
      resolve(dir, 'src/styles.css'),
      resolve(dir, 'packages/web-react/src/styles.css'),
    ]) {
      if (existsSync(candidate)) return candidate
    }
    dir = resolve(dir, '..')
  }
  throw new Error(`找不到 styles.css(cwd=${process.cwd()})`)
}

/** 把 toast 函数从子树里递出来,用例里直接调用。 */
function Probe({ onReady }: { onReady: (fn: ReturnType<typeof useToast>) => void }) {
  onReady(useToast())
  return null
}

describe('Toast 轨道(shell 审计 S-20:顶距与头部高度解耦)', () => {
  it('轨道顶距走 --oc-toast-top 变量,不再写死 top-16;变量本身定义在 styles.css', () => {
    render(
      <ToastProvider>
        <span>子树</span>
      </ToastProvider>,
    )
    const rail = document.querySelector('[data-toast-rail]') as HTMLElement
    expect(rail).not.toBeNull()
    expect(rail.className).toContain('top-[var(--oc-toast-top,4rem)]')
    expect(rail.className).not.toMatch(/\btop-16\b/)
    // 变量的唯一定义处在 styles.css:Toast.tsx 只消费、不定义。两处钉在一起,值漂移即转红。
    const css = readFileSync(locateStylesheet(), 'utf8')
    expect(css).toMatch(/--oc-toast-top:\s*4rem;/)
  })

  it('error 用 alert/assertive 打断朗读;success / info 用 status/polite', () => {
    let toast: ReturnType<typeof useToast> = () => {}
    render(
      <ToastProvider>
        <Probe onReady={(fn) => (toast = fn)} />
      </ToastProvider>,
    )
    act(() => {
      toast('保存失败', 'error')
      toast('已保存', 'success')
      toast('提示', 'info')
    })
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('保存失败')
    expect(alert.getAttribute('aria-live')).toBe('assertive')
    const statuses = screen.getAllByRole('status')
    expect(statuses).toHaveLength(2)
    for (const s of statuses) expect(s.getAttribute('aria-live')).toBe('polite')
  })

  it('自隐提示在悬停 / 聚焦时暂停计时,离开后重新计满 3.5s(a11y shell#10 · WCAG 2.2.1)', () => {
    vi.useFakeTimers()
    let toast: ReturnType<typeof useToast> = () => {}
    render(
      <ToastProvider>
        <Probe onReady={(fn) => (toast = fn)} />
      </ToastProvider>,
    )
    act(() => {
      toast('已保存', 'success')
    })
    const status = screen.getByRole('status')
    expect(status.getAttribute('data-auto-dismiss')).toBe('true')
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    fireEvent.mouseEnter(status)
    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    expect(screen.queryByRole('status')).not.toBeNull()
    fireEvent.mouseLeave(status)
    act(() => {
      vi.advanceTimersByTime(3400)
    })
    expect(screen.queryByRole('status')).not.toBeNull()
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('键盘焦点落进提示(关闭键)同样暂停;error 提示本就不自隐,不挂暂停开关', () => {
    vi.useFakeTimers()
    let toast: ReturnType<typeof useToast> = () => {}
    render(
      <ToastProvider>
        <Probe onReady={(fn) => (toast = fn)} />
      </ToastProvider>,
    )
    act(() => {
      toast('已连接', 'info')
      toast('保存失败', 'error')
    })
    const info = screen.getByRole('status')
    const close = info.querySelector('button[aria-label="关闭提示"]') as HTMLButtonElement
    act(() => {
      close.focus()
    })
    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    expect(screen.queryByRole('status')).not.toBeNull()
    act(() => {
      close.blur()
      vi.advanceTimersByTime(3600)
    })
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByRole('alert').getAttribute('data-auto-dismiss')).toBeNull()
  })
})
