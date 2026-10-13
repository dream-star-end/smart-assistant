/**
 * 哔哩哔哩插件组件（OCV5-402）：schema、渲染、Markdown。
 *
 * 字段样本照 commercial/src/connectors/official/bili.ts 各动作的结果 schema 写
 * （search 的 data.result、rank 的 data.list、video 的 data、comments 的 data、danmaku 的结果），
 * 证明模型照抄插件结果就能渲染，不需要改写字段。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import { IuiBlock } from './IuiBlock'
import { clock, peakOf, progressText } from './biliSchema'
import { validateSpec } from './schema'
import { specToMarkdown } from './toMarkdown'

afterEach(cleanup)

function spec(raw: Record<string, unknown>) {
  const v = validateSpec(raw, false)
  if (!v.ok) throw new Error(v.reason)
  return v
}

const ui = (o: unknown) => JSON.stringify(o)

/** search 的 data.result 原样照抄（含 <em> 高亮、// 开头的封面、"分:秒" 时长）。 */
const SEARCH = {
  type: 'bili_videos',
  title: '搜索：大模型',
  items: [
    {
      bvid: 'BV1xx411c7mD',
      title: '最新<em class="keyword">大模型</em>评测',
      author: '某UP',
      play: 123456,
      video_review: 789,
      duration: '12:34',
      pubdate: 1760000000,
      pic: '//i0.hdslb.com/bfs/archive/a.jpg',
    },
    { bvid: 'not-a-bvid', title: '第二个', pic: 'javascript:alert(1)' },
    { bvid: 'BV1yy411c7mE' },
  ],
}

const RANK = {
  type: 'bili_rank',
  items: Array.from({ length: 12 }, (_, i) => ({
    bvid: `BV1aa411c7m${String.fromCharCode(65 + i)}`,
    title: `排行视频 ${i + 1}`,
    pic: 'https://i0.hdslb.com/bfs/archive/r.jpg',
    duration: 245,
    owner: { mid: 1, name: `UP${i + 1}` },
    stat: { view: 2_000_000 - i * 1000, danmaku: 300, like: 9000 },
    score: 999 - i,
  })),
}

const VIDEO = {
  type: 'bili_video',
  bvid: 'BV1xx411c7mD',
  title: '示例视频',
  pic: '//i1.hdslb.com/bfs/archive/v.jpg',
  desc: '简介第一行\n第二行',
  duration: 3723,
  pubdate: 1760000000,
  tname: '知识',
  owner: { mid: 1, name: '某UP' },
  stat: {
    view: 12345678,
    danmaku: 4321,
    reply: 999,
    favorite: 8888,
    coin: 7777,
    share: 66,
    like: 555555,
  },
  pages: [
    { cid: 1, page: 1, part: '上集', duration: 1800 },
    { cid: 2, page: 2, part: '下集', duration: 1923 },
  ],
}

const COMMENTS = {
  type: 'bili_comments',
  bvid: 'BV1xx411c7mD',
  cursor: { all_count: 23456 },
  replies: [
    {
      rpid: 1,
      ctime: 1760000000,
      like: 1024,
      rcount: 12,
      member: { mid: '9', uname: '路人甲', level_info: { current_level: 6 } },
      content: { message: '说得好 [doge]' },
    },
    { member: { uname: '空评论' }, content: { message: '' } },
  ],
}

const DANMAKU = {
  type: 'bili_danmaku',
  bvid: 'BV1xx411c7mD',
  total: 3723,
  maxT: 600,
  density: [1, 2, 10, 3, 0, 1],
  items: [
    { t: 120.5, text: '前方高能' },
    { t: 3, text: '第一' },
  ],
}

const SUBTITLE = {
  type: 'bili_subtitle',
  bvid: 'BV1xx411c7mD',
  lang: '中文（自动生成）',
  lines: Array.from({ length: 14 }, (_, i) => ({
    from: i * 2.5,
    to: i * 2.5 + 2,
    text: `第 ${i + 1} 句`,
  })),
}

describe('bili schema：照抄插件结果即可', () => {
  test('bili_videos：去掉 <em>、// 封面补 https、分:秒转秒、bvid 拼链接；非法 bvid / 链接被丢、无标题的条目被丢', () => {
    const v = spec(SEARCH)
    expect(v.spec.type).toBe('bili_videos')
    if (v.spec.type !== 'bili_videos') return
    expect(v.spec.items).toHaveLength(2)
    const [a, b] = v.spec.items
    expect(a).toMatchObject({
      bvid: 'BV1xx411c7mD',
      title: '最新大模型评测',
      url: 'https://www.bilibili.com/video/BV1xx411c7mD',
      cover: 'https://i0.hdslb.com/bfs/archive/a.jpg',
      author: '某UP',
      play: 123456,
      danmaku: 789,
      durationSec: 754,
    })
    expect(a?.pubdate).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
    expect(b?.bvid).toBeUndefined()
    expect(b?.url).toBeUndefined()
    expect(b?.cover).toBeUndefined()
  })

  test('bili_rank / bili_video / bili_comments / bili_danmaku / bili_subtitle 都按插件原字段解析', () => {
    const r = spec(RANK)
    if (r.spec.type !== 'bili_rank') throw new Error(r.spec.type)
    expect(r.spec.items[0]).toMatchObject({
      rank: 1,
      author: 'UP1',
      play: 2_000_000,
      likes: 9000,
      score: 999,
    })
    expect(r.spec.items[11]?.rank).toBe(12)

    const v = spec(VIDEO)
    if (v.spec.type !== 'bili_video') throw new Error(v.spec.type)
    expect(v.spec).toMatchObject({
      author: '某UP',
      category: '知识',
      durationSec: 3723,
      stats: { view: 12345678, coin: 7777 },
    })
    expect(v.spec.pages).toEqual([
      { page: 1, part: '上集', durationSec: 1800 },
      { page: 2, part: '下集', durationSec: 1923 },
    ])

    const c = spec(COMMENTS)
    if (c.spec.type !== 'bili_comments') throw new Error(c.spec.type)
    expect(c.spec.total).toBe(23456)
    expect(c.spec.items).toHaveLength(1)
    expect(c.spec.items[0]).toMatchObject({
      user: '路人甲',
      level: 6,
      likes: 1024,
      replies: 12,
      text: '说得好 [doge]',
    })

    const d = spec(DANMAKU)
    if (d.spec.type !== 'bili_danmaku') throw new Error(d.spec.type)
    expect(d.spec.items.map((x) => x.t)).toEqual([3, 120.5])
    expect(peakOf(d.spec)).toEqual({ index: 2, fromSec: 200, toSec: 300 })

    const s = spec(SUBTITLE)
    if (s.spec.type !== 'bili_subtitle') throw new Error(s.spec.type)
    expect(s.spec.lines).toHaveLength(14)
    expect(s.spec.lang).toBe('中文（自动生成）')
  })

  test('bili_rank：rank 动作的扁平行（author / play / video_review / pts=0）照抄即可，pts 为 0 不显示综合分', () => {
    const r = spec({
      type: 'bili_rank',
      items: [
        {
          aid: '117412577938174',
          bvid: 'BV1xx411c7mD',
          title: '近三天榜首',
          author: '某UP',
          play: 1234567,
          video_review: 890,
          duration: '2:50',
          pts: 0,
        },
      ],
    })
    if (r.spec.type !== 'bili_rank') throw new Error(r.spec.type)
    expect(r.spec.items[0]).toMatchObject({
      rank: 1,
      author: '某UP',
      play: 1234567,
      danmaku: 890,
      durationSec: 170,
    })
    expect(r.spec.items[0]?.score).toBeUndefined()
  })

  test('别名落到 bili 自己的类型', () => {
    expect(spec({ ...RANK, type: 'bili_ranking' }).spec.type).toBe('bili_rank')
    expect(spec({ ...DANMAKU, type: 'bili_dm' }).spec.type).toBe('bili_danmaku')
  })

  test('显示工具：clock / progressText', () => {
    expect(clock(754)).toBe('12:34')
    expect(clock(3723)).toBe('1:02:03')
    expect(progressText({ progressSec: -1 })).toBe('已看完')
    expect(progressText({ progressSec: 90, durationSec: 600 })).toBe('看到 1:30')
    expect(progressText({ progressSec: 600, durationSec: 600 })).toBe('已看完')
  })
})

describe('bili 渲染', () => {
  test('视频卡片：标题链接到视频页、时长角标、计数按万显示；外链新窗口不带来源页', () => {
    render(<IuiBlock code={ui(SEARCH)} />)
    const link = screen.getByRole('link', { name: '最新大模型评测' })
    expect(link).toHaveAttribute('href', 'https://www.bilibili.com/video/BV1xx411c7mD')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', expect.stringContaining('noreferrer'))
    expect(screen.getByText('12:34')).toBeInTheDocument()
    expect(screen.getByText('12.3万')).toBeInTheDocument()
    expect(screen.getByText('UP 某UP')).toBeInTheDocument()
  })

  test('排行：前三名高亮，超过 10 名折叠，可展开', () => {
    render(<IuiBlock code={ui(RANK)} />)
    expect(screen.getByText('B 站排行榜')).toBeInTheDocument()
    expect(screen.getByLabelText('第 1 名')).toHaveClass('is-top')
    expect(screen.getByLabelText('第 4 名')).not.toHaveClass('is-top')
    expect(screen.queryByText('排行视频 11')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '显示全部 12 名' }))
    expect(screen.getByText('排行视频 11')).toBeInTheDocument()
  })

  test('视频详情：七项数据、分 P 列表、在 B 站观看', () => {
    const { container } = render(<IuiBlock code={ui(VIDEO)} />)
    const stats = container.querySelector('.oc-bili-stats') as HTMLElement
    expect(within(stats).getByText('播放')).toBeInTheDocument()
    expect(within(stats).getByText('1234.6万')).toBeInTheDocument()
    expect(within(stats).getByText('投币')).toBeInTheDocument()
    expect(screen.getByText('上集')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '在 B 站观看' })).toHaveAttribute(
      'href',
      'https://www.bilibili.com/video/BV1xx411c7mD',
    )
  })

  test('评论与弹幕：等级、总数、密度图带无障碍摘要并标出高能段', () => {
    render(<IuiBlock code={ui(COMMENTS)} />)
    expect(screen.getByText('评论 · 共 2.3万 条')).toBeInTheDocument()
    expect(screen.getByText('Lv6')).toBeInTheDocument()
    cleanup()
    render(<IuiBlock code={ui(DANMAKU)} />)
    expect(
      screen.getByRole('img', { name: /弹幕密度分布，共 6 段，最密集在 3:20–5:00/ }),
    ).toBeInTheDocument()
    expect(screen.getByText('高能 3:20–5:00')).toBeInTheDocument()
    expect(screen.getByText('前方高能')).toBeInTheDocument()
  })

  test('字幕：默认 12 行，展开看全部', () => {
    render(<IuiBlock code={ui(SUBTITLE)} />)
    expect(screen.getByText('字幕 · 中文（自动生成）')).toBeInTheDocument()
    expect(screen.queryByText('第 14 句')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '显示全部 14 行' }))
    expect(screen.getByText('第 14 句')).toBeInTheDocument()
  })
})

describe('bili Markdown：第三方文字一律转义', () => {
  test('标题里的围栏、链接写法、HTML 只能显示成文字', () => {
    const evil = {
      type: 'bili_videos',
      items: [
        {
          bvid: 'BV1xx411c7mD',
          title: '```htmlpreview <script>x</script> [点我](https://evil.example)',
        },
      ],
    }
    const md = specToMarkdown(spec(evil).spec)
    expect(md).not.toContain('```')
    expect(md).not.toContain('<script>')
    expect(md).not.toContain('[点我](https://evil.example)')
    expect(md).toContain('(https://www.bilibili.com/video/BV1xx411c7mD)')
  })

  test('每种类型都有 Markdown 版本，带上关键信息', () => {
    expect(specToMarkdown(spec(RANK).spec)).toContain('1. [排行视频 1]')
    const video = specToMarkdown(spec(VIDEO).spec)
    expect(video).toContain('播放 1234.6万')
    expect(video).toContain('P2 下集')
    expect(specToMarkdown(spec(COMMENTS).spec)).toContain('路人甲')
    expect(specToMarkdown(spec(DANMAKU).spec)).toContain('弹幕最密集:3:20–5:00')
    expect(specToMarkdown(spec(SUBTITLE).spec)).toContain('0:00 第 1 句')
  })
})
