import { createMemoryAuthSession } from '../../../lib/authSession'
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../../lib/api'
import { prefetchMarkdownImpl } from '../../Markdown'
import { loadBeforeAll } from '../../../test/moduleLoad'
import { BlogProse } from './BlogArticle'
import { BlogEditor } from './BlogEditor'

loadBeforeAll(prefetchMarkdownImpl)

vi.mock('./blogLib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./blogLib')>()
  // jsdom 没有 createImageBitmap/canvas:压缩直接返回原文件(压缩逻辑在 blogLib.test 单测)。
  return { ...actual, compressBlogImage: async (file: Blob) => file }
})

const auth = createMemoryAuthSession(() => {})
auth.commitToken(auth.beginIdentity(), 'token')

const TRACKER = 'https://tracker.test/pixel.png'

beforeEach(() => {
  window.localStorage.removeItem('oc:blog-draft')
  let n = 0
  URL.createObjectURL = vi.fn(() => `blob:local-${++n}`)
  URL.revokeObjectURL = vi.fn()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('经验分享正文：投稿内容不能拉外部资源（Codex R1 P1）', () => {
  it('ui / options / html 围栏按代码块显示，不渲染组件、不请求外链图片', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const markdown = [
      '正文开头。',
      '',
      '```ui',
      JSON.stringify({ type: 'gallery', images: [TRACKER] }),
      '```',
      '',
      '```options',
      '- 选项 A',
      '```',
      '',
      '```html',
      `<img src="${TRACKER}">`,
      '```',
    ].join('\n')
    const { container } = render(<BlogProse markdown={markdown} source={{ kind: 'public' }} />)
    await screen.findByText('正文开头。')
    expect(container.textContent).toContain('"type":"gallery"')
    expect(container.querySelector(`img[src*="tracker.test"]`)).toBeNull()
    expect(container.querySelector('iframe')).toBeNull()
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('tracker.test'))).toBe(false)
  })
})

describe('编辑器一次插入多张图（Codex R1 P1）', () => {
  it('两张都替换成 tutorial-blob 引用，没有残留的上传占位', async () => {
    let call = 0
    vi.spyOn(api, 'uploadTutorialImage').mockImplementation(async () => {
      call += 1
      // 第一张慢一点返回：替换发生在 React 渲染之前时，下一张必须读到最新正文。
      await new Promise((resolve) => setTimeout(resolve, call === 1 ? 20 : 0))
      return { sha256: String(call).repeat(64).slice(0, 64), mime: 'image/webp', bytes: 10, width: 4, height: 4 }
    })
    render(<BlogEditor auth={auth} aiReview={false} onBack={() => {}} onSubmitted={() => {}} />)
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    const files = [
      new File([new Uint8Array(8)], 'a.png', { type: 'image/png' }),
      new File([new Uint8Array(8)], 'b.png', { type: 'image/png' }),
    ]
    await act(async () => {
      fireEvent.change(input, { target: { files } })
    })
    const body = screen.getByLabelText('正文（Markdown）') as HTMLTextAreaElement
    await waitFor(() => expect(body.value.match(/tutorial-blob:/g)?.length).toBe(2))
    expect(body.value).not.toContain('uploading:')
    expect(body.value).toContain(`tutorial-blob:${'1'.repeat(64)}`)
    expect(body.value).toContain(`tutorial-blob:${'2'.repeat(64)}`)
  })

  it('卸载后才返回的上传不再创建 object URL', async () => {
    let resolveUpload: (value: { sha256: string; mime: string; bytes: number; width: number; height: number }) => void = () => {}
    vi.spyOn(api, 'uploadTutorialImage').mockImplementation(
      () => new Promise((resolve) => {
        resolveUpload = resolve
      }),
    )
    const { unmount } = render(<BlogEditor auth={auth} aiReview={false} onBack={() => {}} onSubmitted={() => {}} />)
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File([new Uint8Array(8)], 'a.png', { type: 'image/png' })] } })
    })
    await waitFor(() => expect(api.uploadTutorialImage).toHaveBeenCalled())
    unmount()
    await act(async () => {
      resolveUpload({ sha256: 'c'.repeat(64), mime: 'image/webp', bytes: 10, width: 4, height: 4 })
    })
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })
})
