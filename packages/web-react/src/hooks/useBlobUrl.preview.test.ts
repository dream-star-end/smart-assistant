import { describe, expect, test } from 'vitest'

import { previewUrl } from './useBlobUrl'

describe('previewUrl (Q2)', () => {
  test('turns a ticket URL into its preview at a width; other URLs are left alone', () => {
    const sha = 'a'.repeat(64)
    expect(previewUrl(`/api/studio/blobs/${sha}?ticket=x.y`, 640)).toBe(
      `/api/studio/blobs/${sha}/preview?w=640&ticket=x.y`,
    )
    expect(previewUrl('/blob/abc', 640)).toBe('/blob/abc')
    expect(previewUrl(`/api/studio/blobs/${sha}`, 640)).toBe(`/api/studio/blobs/${sha}`)
  })
})
