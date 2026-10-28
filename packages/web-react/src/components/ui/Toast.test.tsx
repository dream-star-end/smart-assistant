import '@testing-library/jest-dom/vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider, splitTraceId, useToast, useToastAnchor } from './Toast'

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
  it('轨道顶距走 --oc-toast-top 变量,不再写死 top-16;默认值定义在 styles.css', () => {
    render(
      <ToastProvider>
        <span>子树</span>
      </ToastProvider>,
    )
    const rail = document.querySelector('[data-toast-rail]') as HTMLElement
    expect(rail).not.toBeNull()
    expect(rail.className).toContain('top-[var(--oc-toast-top)]')
    expect(rail.className).not.toMatch(/\btop-16\b/)
    // 安全区已经算进顶距(顶栏实测下沿本就包含;默认值里显式加),轨道不再自带 header-safe-t。
    expect(rail.className).not.toContain('header-safe-t')
    // 默认值的唯一定义处在 styles.css:= 原 4rem 顶距 + 原轨道内边距(0.625rem + 安全区),位置不变。
    const css = readFileSync(locateStylesheet(), 'utf8')
    expect(css).toMatch(/--oc-toast-top:\s*calc\(4\.625rem \+ env\(safe-area-inset-top, 0px\)\);/)
  })

  it('顶栏登记实测下沿:toast 落在顶栏下面(手机两行顶栏也不压住),卸载后回落默认值', () => {
    let height = 100
    function Header() {
      const ref = useRef<HTMLElement>(null)
      useToastAnchor(ref)
      return <header ref={ref}>顶栏</header>
    }
    const spy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(() => ({ bottom: height }) as DOMRect)
    const root = document.documentElement
    const { unmount } = render(<Header />)
    expect(root.style.getPropertyValue('--oc-toast-top')).toBe('108px')
    height = 64
    unmount()
    expect(root.style.getPropertyValue('--oc-toast-top')).toBe('')
    spy.mockRestore()
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

describe('Toast 追踪号(UI-SPEC §1.1 C6:跟踪号不进正文)', () => {
  it('apiErrorMessage 尾部的「（追踪号 …）」剥出来,正文只留人话', () => {
    expect(splitTraceId('协作配置保存失败，请重新选择后重试（追踪号 5bb64a20b6）')).toEqual({
      text: '协作配置保存失败，请重新选择后重试',
      traceId: '5bb64a20b6',
    })
    expect(splitTraceId('保存失败(跟踪号: req-1)')).toEqual({ text: '保存失败', traceId: 'req-1' })
    expect(splitTraceId('保存失败')).toEqual({ text: '保存失败' })
    // 只有号码没有正文时不剥,免得剩一条空提示。
    expect(splitTraceId('（追踪号 abc）')).toEqual({ text: '（追踪号 abc）' })
  })

  it('错误提示正文不含号码,「复制追踪号」复制原号码', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    let toast: ReturnType<typeof useToast> = () => {}
    render(
      <ToastProvider>
        <Probe onReady={(fn) => (toast = fn)} />
      </ToastProvider>,
    )
    act(() => {
      toast('协作配置保存失败（追踪号 5bb64a20b6）', 'error')
    })
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('协作配置保存失败')
    expect(alert.textContent).not.toContain('5bb64a20b6')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '复制追踪号' }))
    })
    expect(writeText).toHaveBeenCalledWith('5bb64a20b6')
    expect(screen.getByRole('button', { name: '已复制' })).toBeInTheDocument()
    Reflect.deleteProperty(navigator, 'clipboard')
  })

  it('options.traceId 同样只进按钮;剪贴板不可用(非安全上下文)时直接亮出号码', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    let toast: ReturnType<typeof useToast> = () => {}
    render(
      <ToastProvider>
        <Probe onReady={(fn) => (toast = fn)} />
      </ToastProvider>,
    )
    act(() => {
      toast('导出失败', 'error', { traceId: 'tr-9' })
    })
    expect(screen.getByRole('alert').textContent).not.toContain('tr-9')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '复制追踪号' }))
    })
    expect(screen.getByRole('alert')).toHaveTextContent('tr-9')
    Reflect.deleteProperty(navigator, 'clipboard')
  })
})
