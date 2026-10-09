import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { PanelHeader } from './Panel'
import { HeaderSlotProvider, InlineSelect, QuietSurface } from './Quiet'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function stubViewport(md: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(min-width: 768px)' ? md : !md,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

function Shell({ children }: { children: React.ReactNode }) {
  const [slot, setSlot] = useState<HTMLDivElement | null>(null)
  return (
    <QuietSurface>
      <HeaderSlotProvider value={slot}>
        <div data-testid="slot" ref={setSlot} />
        <div data-testid="panel">{children}</div>
      </HeaderSlotProvider>
    </QuietSurface>
  )
}

test('窄屏 + 插槽：页面标题只留给读屏，操作搬进上下文行插槽', () => {
  stubViewport(false)
  render(
    <Shell>
      <PanelHeader title="技能" hint="说明" action={<button type="button">市场</button>} />
    </Shell>,
  )
  const header = document.querySelector('[data-panel-header]')
  expect(header).toHaveClass('sr-only')
  expect(screen.getByRole('heading', { name: '技能' })).toBeInTheDocument()
  expect(screen.getByTestId('slot')).toContainElement(screen.getByRole('button', { name: '市场' }))
  expect(screen.getByTestId('panel')).not.toContainElement(screen.getByRole('button', { name: '市场' }))
})

test('桌面：页面标题照常显示，操作留在标题右侧', () => {
  stubViewport(true)
  render(
    <Shell>
      <PanelHeader title="技能" action={<button type="button">市场</button>} />
    </Shell>,
  )
  expect(document.querySelector('[data-panel-header]')).not.toHaveClass('sr-only')
  expect(screen.getByTestId('slot')).toBeEmptyDOMElement()
  expect(screen.getByTestId('panel')).toContainElement(screen.getByRole('button', { name: '市场' }))
})

test('没有插槽（管理中心之外）时窄屏也不收起标题', () => {
  stubViewport(false)
  render(
    <QuietSurface>
      <PanelHeader title="技能" action={<button type="button">市场</button>} />
    </QuietSurface>,
  )
  expect(document.querySelector('[data-panel-header]')).not.toHaveClass('sr-only')
})

test('InlineSelect：无框的行内取值，可见标签是真 <label>，切换透出值', () => {
  const onValueChange = vi.fn()
  render(
    <InlineSelect
      id="agent"
      label="智能体"
      value="main"
      onValueChange={onValueChange}
      options={[
        { value: 'main', label: '全能助手' },
        { value: 'xhs', label: '小红书运营' },
      ]}
    />,
  )
  const select = screen.getByRole('combobox', { name: '智能体' })
  expect(select.closest('.oc-inline-select')).not.toBeNull()
  expect(select).toHaveAttribute('title', '全能助手')
  fireEvent.change(select, { target: { value: 'xhs' } })
  expect(onValueChange).toHaveBeenCalledWith('xhs')
})
