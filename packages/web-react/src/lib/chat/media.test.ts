import { afterEach, describe, expect, test, vi } from 'vitest'
import { classifyMediaRef, fetchImageBlobWithResign, isContainerPath, needsSignedSrc } from './media'

afterEach(() => vi.unstubAllGlobals())

const res = (status: number, blob?: Blob): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    // 渐进 fetch 会读 content-length；无流(body=null)时回落 res.blob()。
    headers: { get: () => null },
    body: null,
    blob: async () => blob ?? new Blob(),
  }) as unknown as Response

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

describe('needsSignedSrc（签名管线单一权威判定）', () => {
  test('容器路径、/api/media 与站内信资产都需签名(凭证进 URL,不靠 SameSite cookie)', () => {
    expect(needsSignedSrc('/home/agent/.openclaude/generated/a.png')).toBe(true)
    expect(needsSignedSrc('/api/media/abc123.png')).toBe(true)
    expect(needsSignedSrc('/api/media/b99bc530.mp3')).toBe(true) // 非图媒体条(那条 401 的 mp3)同样走通
    expect(needsSignedSrc('/api/inbox-assets/550e8400-e29b-41d4-a716-446655440000')).toBe(true)
  })
  test('http/data/blob 与其它 /api 端点不走签名', () => {
    expect(needsSignedSrc('https://cdn.test/x.png')).toBe(false)
    expect(needsSignedSrc('data:image/png;base64,AAAA')).toBe(false)
    expect(needsSignedSrc('blob:https://app/uuid')).toBe(false)
    expect(needsSignedSrc('/api/media-signed?t=xyz')).toBe(false) // 已签名端点自身不再套娃
    expect(needsSignedSrc('/api/uploads')).toBe(false)
    expect(needsSignedSrc('')).toBe(false)
  })
  test('/api/media 不再被 isContainerPath 误分类为容器路径(两谓词职责分明)', () => {
    expect(isContainerPath('/api/media/x.png')).toBe(false)
    expect(isContainerPath('/home/agent/x.png')).toBe(true)
  })
})

describe('classifyMediaRef', () => {
  test('/api/media 上传/生成媒体收口到签名管线(此前裸 direct → iOS/CF 下 401 持久裂图根因)', () => {
    expect(classifyMediaRef({ kind: 'image', url: '/api/media/example.png' })).toMatchObject({
      mode: 'sign',
      path: '/api/media/example.png',
      kind: 'image',
    })
  })

  test('/api/media 非图媒体条(audio)同样走签名', () => {
    expect(classifyMediaRef({ kind: 'audio', url: '/api/media/b99bc530.mp3' })).toMatchObject({
      mode: 'sign',
      path: '/api/media/b99bc530.mp3',
      kind: 'audio',
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

  test('乐观气泡:localSrc(本地 blob)优先直渲,盖过 url(消除上传→回显裂图窗口)', () => {
    expect(
      classifyMediaRef({ kind: 'image', url: '/api/media/x.png', localSrc: 'blob:local-preview' }),
    ).toMatchObject({
      mode: 'direct',
      src: 'blob:local-preview',
      kind: 'image',
    })
  })

  test('http/data URL 仍直渲(无 localSrc 时)', () => {
    expect(classifyMediaRef({ kind: 'image', url: 'https://cdn.test/x.png' })).toMatchObject({
      mode: 'direct',
      src: 'https://cdn.test/x.png',
    })
    expect(classifyMediaRef({ kind: 'image', base64: 'AAAA', mimeType: 'image/png' })).toMatchObject({
      mode: 'direct',
      src: 'data:image/png;base64,AAAA',
    })
  })
})
