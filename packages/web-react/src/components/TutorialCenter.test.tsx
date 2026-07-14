import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PRODUCT_CAPABILITIES,
  type ProductCapability,
  type ProductFeatureId,
} from '../lib/productCapabilities'
import { TutorialCenter } from './TutorialCenter'

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.clearAllMocks()
})

function Harness({
  initial = PRODUCT_CAPABILITIES.chatBasics.id,
  enabled = true,
  onRun = vi.fn<(feature: ProductCapability) => void>(),
}: {
  initial?: ProductFeatureId
  enabled?: boolean
  onRun?: (feature: ProductCapability) => void
}) {
  const [topic, setTopic] = useState<ProductFeatureId>(initial)
  return (
    <TutorialCenter
      open
      topicId={topic}
      onTopicChange={setTopic}
      onClose={() => {}}
      actionState={() =>
        enabled
          ? { enabled: true, label: '回到功能位置' }
          : { enabled: false, label: '打开组织中心', disabledReason: '只有组织管理员可以进入。' }
      }
      onRunAction={onRun}
    />
  )
}

describe('TutorialCenter', () => {
  it('展示详细步骤、本地演示媒体、风险提示与真实功能 CTA', () => {
    const onRun = vi.fn()
    render(<Harness onRun={onRun} />)

    expect(screen.getByRole('heading', { name: '开始一场高质量对话' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '跟着做' })).toBeInTheDocument()
    expect(screen.getAllByRole('listitem').length).toBeGreaterThanOrEqual(6)
    const video = screen.getByLabelText('对话入门演示视频')
    expect(video).toHaveAttribute('poster', '/tutorials/workspace.webp')
    expect(video.querySelector('source')).toHaveAttribute('src', '/tutorials/workspace.webm')

    fireEvent.click(screen.getByRole('button', { name: '回到功能位置' }))
    expect(onRun).toHaveBeenCalledWith(expect.objectContaining({ id: 'chat-basics' }))
  })

  it('搜索功能、场景和别名后可直接切换教程', () => {
    render(<Harness />)
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索教程' }), {
      target: { value: 'OAuth 仓库' },
    })
    fireEvent.click(screen.getByRole('button', { name: /GitHub 仓库/ }))
    expect(screen.getByRole('heading', { name: '连接 GitHub 仓库协作开发' })).toBeInTheDocument()
  })

  it('视频失败时显示同源截图兜底，不留下空白', () => {
    render(<Harness />)
    fireEvent.error(screen.getByLabelText('对话入门演示视频'))
    expect(screen.getByText('演示视频暂不可播放，已显示同一功能截图。')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: /在 Aurora 工作区/ })).toHaveAttribute(
      'src',
      '/tutorials/workspace.webp',
    )
  })

  it('不可用动作保持教程打开并解释权限原因', () => {
    render(<Harness initial={PRODUCT_CAPABILITIES.organization.id} enabled={false} />)
    expect(screen.getByText('只有组织管理员可以进入。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '打开组织中心' })).toBeDisabled()
    expect(screen.getByRole('heading', { name: '组织、成员、共享额度与发票' })).toBeInTheDocument()
  })
})
