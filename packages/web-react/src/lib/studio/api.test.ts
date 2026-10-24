import { afterEach, describe, expect, test, vi } from 'vitest'

vi.mock('../api', () => ({
  callWithRefresh: async (_a: unknown, make: (t: string) => Promise<Response>) => make('t'),
  bearerHeaders: (_t: string, json?: boolean) =>
    json ? { 'content-type': 'application/json' } : {},
  assertAuthResponseCurrent: () => {},
}))

import { StudioApiError, studioApi, studioErrorText } from './api'

afterEach(() => vi.unstubAllGlobals())
const auth = {} as never

describe('studioApi.uploadAsset (OCV5-593 FE-2c)', () => {
  test('refuses a non-image or an oversize file before any request', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await expect(
      studioApi.uploadAsset(auth, 'p', new File(['x'], 'a.txt', { type: 'text/plain' })),
    ).rejects.toMatchObject({
      code: 'STUDIO_UNSUPPORTED_MEDIA',
    })
    const big = new File([new Uint8Array(1)], 'b.png', { type: 'image/png' })
    Object.defineProperty(big, 'size', { value: 26 * 1024 * 1024 })
    await expect(studioApi.uploadAsset(auth, 'p', big)).rejects.toMatchObject({
      code: 'STUDIO_UPLOAD_TOO_LARGE',
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test('sends the bytes with their own content type and an encoded file name', async () => {
    const fetchSpy = vi.fn(
      async () => new Response(JSON.stringify({ asset: { id: 'u1' } }), { status: 201 }),
    )
    vi.stubGlobal('fetch', fetchSpy)
    const f = new File([new Uint8Array([1])], '狐狸.png', { type: 'image/png' })
    expect(await studioApi.uploadAsset(auth, 'p', f)).toEqual({ id: 'u1' })
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/studio/projects/p/uploads')
    expect(init.body).toBe(f)
    expect(init.headers).toMatchObject({
      'content-type': 'image/png',
      'x-filename': encodeURIComponent('狐狸.png'),
    })
  })

  test('error text by code', () => {
    expect(studioErrorText(new StudioApiError(415, 'STUDIO_UNSUPPORTED_MEDIA', 'x'))).toBe(
      '只支持 PNG、JPEG、WebP 图片',
    )
    expect(studioErrorText(new StudioApiError(409, 'STUDIO_NOT_DRAFT', 'x'))).toBe(
      '项目已开拍，需求和画幅不能再改',
    )
    expect(studioErrorText(new Error('net'))).toBe('网络异常，请稍后再试')
  })
})
