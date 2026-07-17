import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { ManageCenter } from './ManageCenter'

afterEach(cleanup)

test('管理中心关闭按钮仅在粗指针扩大到 44px', () => {
  render(
    <ManageCenter
      open
      tab="memory"
      auth={null}
      agentId="main"
      agents={[]}
      onTabChange={() => {}}
      onClose={() => {}}
    />,
  )
  expect(screen.getByRole('button', { name: '关闭' })).toHaveClass('[@media(hover:none)]:size-11')
  expect(screen.getByRole('dialog')).toHaveClass('oc-center-dialog', 'h-[min(85vh,44rem)]', 'h-[min(85dvh,44rem)]')
  expect(screen.getByRole('dialog')).not.toHaveClass('top-1/2')
})
