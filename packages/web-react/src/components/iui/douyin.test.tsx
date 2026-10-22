/**
 * 抖音插件组件（OCV5-553）：schema、渲染、Markdown。
 *
 * 字段样本照 commercial/src/plugins/douyinContract.ts 的 my_videos / video_comments 结果 schema 写，
 * 证明模型照抄插件结果就能渲染，不需要改写字段。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import { IuiBlock } from './IuiBlock'
import { dateText, mmss } from './douyinSchema'
import { validateSpec } from './schema'
import { specToMarkdown } from './toMarkdown'

afterEach(cleanup)

function spec(raw: Record<string, unknown>) {
  const v = validateSpec(raw, false)
  if (!v.ok) throw new Error(v.reason)
  return v
}

const ui = (o: unknown) => JSON.stringify(o)

const COVER = 'https://p3-sign.douyinpic.com/tos-cn-i-0813/abc~tplv-dy-360p.jpeg?x-expires=1'

/** my_videos 的 items 原样照抄。 */
const VIDEOS = {
  type: 'douyin_videos',
  title: '我的作品',
  items: [
    {
      awemeId: '7400000000000000001',
      url: 'https://www.douyin.com/video/7400000000000000001',
      title: '周末探店',
      desc: '简介 #探店',
      createTime: 1_760_000_000,
      durationSec: 75,
      cover: COVER,
      playCount: 12_345,
      diggCount: 678,
      commentCount: 12,
      shareCount: 3,
      collectCount: 9,
      isPrivate: true,
      inReview: true,
    },
    {
      awemeId: '7400000000000000002',
      url: 'https://www.douyin.com/note/7400000000000000002',
      desc: '只有简介的图文',
      durationSec: 0,
      isImagePost: true,
    },
  ],
}

/** video_comments 的结果原样照抄。 */
const COMMENTS = {
  type: 'douyin_comments',
  awemeId: '7400000000000000001',
  total: 23_456,
  hasMore: true,
  items: [
    {
      cid: '7400000000000000101',
      text: '好看',
      nickname: '路人',
      createTime: 1_760_000_100,
      diggCount: 4,
      replyCount: 1,
    },
    { cid: '7400000000000000102', text: '长评'.repeat(200), nickname: '话痨' },
  ],
}

describe('douyin schema：照抄插件结果即可', () => {
  test('douyin_videos：合法结果原样通过，没有修复说明', () => {
    const v = spec(VIDEOS)
    if (v.spec.type !== 'douyin_videos') throw new Error(v.spec.type)
    expect(v.notes).toEqual([])
    expect(v.spec.items).toHaveLength(2)
    expect(v.spec.items[0]).toMatchObject({
      awemeId: '7400000000000000001',
      cover: COVER,
      playCount: 12_345,
      isPrivate: true,
    })
  })

  test('修复：数字字符串转数字、非抖音图床封面被丢、非法行被丢，并各记一句', () => {
    const v = spec({
      type: 'douyin_videos',
      items: [
        {
          awemeId: '7400000000000000001',
          url: 'https://www.douyin.com/video/7400000000000000001',
          playCount: '1,234',
          diggCount: '1.2万',
          createTime: '1760000000',
          cover: 'https://evil.example/douyinpic.com/a.jpg',
        },
        { awemeId: '74a', url: 'https://www.douyin.com/video/74a' },
        { url: 'https://www.douyin.com/video/1' },
        'not an object',
        {
          awemeId: '7400000000000000003',
          url: 'https://www.douyin.com/video/7400000000000000003',
          cover: 'http://p3.douyinpic.com/a.jpg',
        },
      ],
    })
    if (v.spec.type !== 'douyin_videos') throw new Error(v.spec.type)
    expect(v.spec.items).toHaveLength(2)
    expect(v.spec.items[0]).toMatchObject({
      playCount: 1234,
      diggCount: 12_000,
      createTime: 1_760_000_000,
    })
    expect(v.spec.items[0]?.cover).toBeUndefined()
    expect(v.spec.items[1]?.cover).toBeUndefined()
    expect(v.notes).toContain('数字字符串已转成数字')
    expect(v.notes).toContain('封面不是抖音图床地址，已省略')
    expect(v.notes).toContain('丢弃 3 条无效作品')

    const c = spec({
      type: 'douyin_comments',
      total: '88',
      items: [
        { cid: 'x', text: 't' },
        { cid: '9', text: '   ' },
        { cid: 9, text: '好', diggCount: '2' },
      ],
    })
    if (c.spec.type !== 'douyin_comments') throw new Error(c.spec.type)
    expect(c.spec.total).toBe(88)
    expect(c.spec.items).toEqual([{ cid: '9', text: '好', diggCount: 2 }])
    expect(c.notes).toContain('丢弃 2 条无效评论')
  })

  test('没有一条合法数据时降级（不渲染空组件）', () => {
    expect(validateSpec({ type: 'douyin_videos', items: [] }, false)).toEqual({
      ok: false,
      reason: 'invalid_douyin_videos',
    })
    expect(validateSpec({ type: 'douyin_videos', items: [{ url: 'x' }] }, false).ok).toBe(false)
    expect(validateSpec({ type: 'douyin_comments', items: [{ cid: '1' }] }, false)).toEqual({
      ok: false,
      reason: 'invalid_douyin_comments',
    })
    // 流式半截：类型已知就先渲染。
    expect(validateSpec({ type: 'douyin_comments', items: [] }, true).ok).toBe(true)
  })

  test('链接安全：非 https / 非 douyin.com 的 url 不用，改用作品 ID 生成抖音链接', () => {
    const v = spec({
      type: 'douyin_videos',
      items: [
        { awemeId: '7400000000000000001', url: 'javascript:alert(1)' },
        { awemeId: '7400000000000000002', url: 'http://www.douyin.com/video/7400000000000000002' },
        {
          awemeId: '7400000000000000003',
          url: 'https://www.douyin.com.evil.example/x',
          isImagePost: true,
        },
      ],
    })
    if (v.spec.type !== 'douyin_videos') throw new Error(v.spec.type)
    expect(v.spec.items.map((x) => x.url)).toEqual([
      'https://www.douyin.com/video/7400000000000000001',
      'https://www.douyin.com/video/7400000000000000002',
      'https://www.douyin.com/note/7400000000000000003',
    ])
    expect(v.notes).toContain('作品链接不合规，已按作品 ID 重新生成')
  })

  test('别名与显示工具', () => {
    expect(spec({ ...VIDEOS, type: 'douyin_works' }).spec.type).toBe('douyin_videos')
    expect(spec({ ...COMMENTS, type: 'douyin_video_comments' }).spec.type).toBe('douyin_comments')
    expect(mmss(75)).toBe('1:15')
    expect(mmss(3723)).toBe('1:02:03')
    expect(dateText(1_760_000_000)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(dateText(1_760_000_000, true)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  })
})

describe('douyin 渲染', () => {
  test('作品卡片：标题链接、封面不带来源页、时长、万单位计数、徽章；图文用简介作标题且无时长', () => {
    const { container } = render(<IuiBlock code={ui(VIDEOS)} />)
    expect(screen.getByText('我的作品')).toBeInTheDocument()
    const link = screen.getByRole('link', { name: '周末探店' })
    expect(link).toHaveAttribute('href', 'https://www.douyin.com/video/7400000000000000001')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', expect.stringContaining('noreferrer'))
    const img = container.querySelector('img') as HTMLImageElement
    expect(img).toHaveAttribute('src', COVER)
    expect(img).toHaveAttribute('referrerpolicy', 'no-referrer')
    expect(screen.getByText('1:15')).toBeInTheDocument()
    expect(screen.getByText('1.2万')).toBeInTheDocument()
    expect(screen.getByText('私密')).toBeInTheDocument()
    expect(screen.getByText('审核中')).toBeInTheDocument()
    expect(screen.getByText('图文')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '只有简介的图文' })).toHaveAttribute(
      'href',
      'https://www.douyin.com/note/7400000000000000002',
    )
    expect(screen.queryByText('0:00')).not.toBeInTheDocument()
  })

  test('作品超过 10 个折叠，可展开', () => {
    const items = Array.from({ length: 12 }, (_, i) => ({
      awemeId: `74000000000000001${String(i).padStart(2, '0')}`,
      url: `https://www.douyin.com/video/74000000000000001${String(i).padStart(2, '0')}`,
      title: `作品 ${i + 1}`,
    }))
    render(<IuiBlock code={ui({ type: 'douyin_videos', items })} />)
    expect(screen.getByText('我的抖音作品')).toBeInTheDocument()
    expect(screen.queryByText('作品 11')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '显示全部 12 个' }))
    expect(screen.getByText('作品 11')).toBeInTheDocument()
  })

  test('评论：总数标题、昵称、赞与回复；长评论可展开', () => {
    render(<IuiBlock code={ui(COMMENTS)} />)
    expect(screen.getByText('评论 · 共 2.3万 条')).toBeInTheDocument()
    expect(screen.getByText('路人')).toBeInTheDocument()
    expect(screen.getByText('好看')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '展开全文' })).toBeInTheDocument()
  })

  test('修复说明显示在组件底部', () => {
    render(
      <IuiBlock
        code={ui({
          type: 'douyin_videos',
          items: [
            {
              awemeId: '1',
              url: 'https://www.douyin.com/video/1',
              cover: 'https://x.example/a.jpg',
            },
          ],
        })}
      />,
    )
    expect(screen.getByText(/封面不是抖音图床地址，已省略/)).toBeInTheDocument()
  })
})

describe('douyin Markdown：第三方文字一律转义', () => {
  test('作品与评论都有 Markdown 版本，带上关键信息', () => {
    const md = specToMarkdown(spec(VIDEOS).spec)
    expect(md).toContain('**我的作品**')
    expect(md).toContain('1. [周末探店](https://www.douyin.com/video/7400000000000000001)')
    expect(md).toContain('私密 · 审核中')
    expect(md).toContain('播放 1.2万')
    expect(md).toContain('1:15')
    expect(md).toContain('(https://www.douyin.com/note/7400000000000000002)')
    const cm = specToMarkdown(spec(COMMENTS).spec)
    // 标题是普通文字，经 mdText 转义（. 变成 \\.）。
    expect(cm).toContain('**评论(共 2\\.3万 条)**')
    expect(cm).toContain('**路人** · 赞 4 · 回复 1')
    expect(cm).toContain('> 好看')
  })

  test('标题、评论里的围栏、链接写法、HTML 只能显示成文字', () => {
    const evil = '```htmlpreview <script>x</script> [点我](https://evil.example)'
    const md = specToMarkdown(
      spec({
        type: 'douyin_videos',
        items: [{ awemeId: '1', url: 'https://www.douyin.com/video/1', title: evil }],
      }).spec,
    )
    expect(md).not.toContain('```')
    expect(md).not.toContain('<script>')
    expect(md).not.toContain('[点我](https://evil.example)')
    const cm = specToMarkdown(
      spec({ type: 'douyin_comments', items: [{ cid: '1', text: evil }] }).spec,
    )
    expect(cm).not.toContain('<script>')
    expect(cm).not.toContain('[点我](https://evil.example)')
  })
})
