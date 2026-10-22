import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { WriteUsageRow } from './WriteUsageRow'

const usage = {
  day: '2026-10-22',
  available: true,
  cooldownUntil: null,
  buckets: [
    { bucket: 'publish_video', label: '发布视频', used: 1, cap: 3 },
    { bucket: 'publish_images', label: '发布图文', used: 0, cap: 3 },
    { bucket: 'comment', label: '评论与回复', used: 20, cap: 20 },
    { bucket: 'digg', label: '点赞', used: 4, cap: 30 },
  ],
}

describe('WriteUsageRow (OCV5-553 今日已用 / 上限)', () => {
  afterEach(cleanup)

  it('lists every bucket as used / cap and highlights a bucket at its cap', () => {
    render(<WriteUsageRow usage={usage} accountName="抖音测试号" />)
    const list = screen.getByRole('list', { name: '抖音测试号今日写入用量' })
    const items = Array.from(list.querySelectorAll('li')).map((li) => li.textContent)
    expect(items).toEqual(['发布视频 1 / 3', '发布图文 0 / 3', '评论与回复 20 / 20', '点赞 4 / 30'])
    expect(screen.getByText('评论与回复').closest('li')?.className).toContain('text-warning')
    expect(screen.getByText('发布视频').closest('li')?.className ?? '').not.toContain(
      'text-warning',
    )
    expect(screen.getByText(/2026-10-22/)).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('says the numbers are unavailable instead of showing zeros when Redis could not be read', () => {
    render(<WriteUsageRow usage={{ ...usage, available: false }} accountName="抖音测试号" />)
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.getByText(/今日用量暂不可用/)).toBeTruthy()
  })

  it('shows the risk-control cooldown end in Beijing time', () => {
    render(
      <WriteUsageRow
        usage={{ ...usage, cooldownUntil: '2026-10-23T01:05:00.000Z' }}
        accountName="抖音测试号"
      />,
    )
    expect(screen.getByRole('status').textContent).toBe(
      '账号触发过风控，写操作暂停到北京时间 09:05。',
    )
  })
})
