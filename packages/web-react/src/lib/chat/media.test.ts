import { afterEach, describe, expect, test, vi } from 'vitest'
import { classifyMediaRef, fetchImageBlobWithResign } from './media'

afterEach(() => vi.unstubAllGlobals())

const res = (status: number, blob?: Blob): Response =>
  ({ ok: status >= 200 && status < 300, status, blob: async () => blob ?? new Blob() }) as unknown as Response

describe('fetchImageBlobWithResign（图片编辑取图过期自愈）', () => {
  test('过期 URL 入口(410)→ 强制重签一次 → 用新 URL 取图成功', async () => {
    const good = new Blob(['png-bytes'], { type: 'image/png' })
    // 第一次(旧签名 URL)服务端裁决 410;重签后的 fresh URL 返回 200 + 图片字节。
    const fetchMock = vi.fn(async (url: string) => (url.includes('fresh') ? res(200, good) : res(410)))
    vi.stubGlobal('fetch', fetchMock)
    const resolveSrc = vi.fn(async (opts?: { forceResign?: boolean }) =>
      opts?.forceResign ? '/api/media-signed?t=fresh' : '/api/media-signed?t=stale',
    )

    const out = await fetchImageBlobWithResign('/api/media-signed?t=stale', resolveSrc)

    expect(out).toBe(good) // 拿到的是重签后成功取回的字节,不是留白
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/media-signed?t=stale')
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/media-signed?t=fresh')
    expect(resolveSrc).toHaveBeenCalledWith({ forceResign: true }) // 强制重签
  })

  test('403 同样触发一次重签重试', async () => {
    const good = new Blob(['x'], { type: 'image/png' })
    const fetchMock = vi.fn(async (url: string) => (url.includes('fresh') ? res(200, good) : res(403)))
    vi.stubGlobal('fetch', fetchMock)
    const resolveSrc = vi.fn(async () => '/api/media-signed?t=fresh')
    await expect(fetchImageBlobWithResign('/api/media-signed?t=stale', resolveSrc)).resolves.toBe(good)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test('无 resolveSrc(本地 objectURL 无过期概念)→ 直取,失败即抛(转显式错误态,永不留白)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(500)))
    await expect(fetchImageBlobWithResign('blob:local-preview')).rejects.toThrow('读取图片失败 (500)')
  })
})

describe('classifyMediaRef', () => {
  test('/api/media uploads are same-origin direct images rather than permanent placeholders', () => {
    expect(classifyMediaRef({ kind: 'image', url: '/api/media/example.png' })).toEqual({
      mode: 'direct',
      kind: 'image',
      src: '/api/media/example.png',
      filename: undefined,
      mimeType: undefined,
    })
  })

  test('container absolute paths still require a signed URL', () => {
    expect(
      classifyMediaRef({ kind: 'image', url: '/home/agent/.openclaude/generated/a.png' }),
    ).toMatchObject({
      mode: 'sign',
      path: '/home/agent/.openclaude/generated/a.png',
      kind: 'image',
    })
  })
})
