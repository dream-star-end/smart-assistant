import { afterEach, describe, expect, test, vi } from 'vitest'
import { normalizeImageSourceForGateway } from './ImageAnnotationEditor'

afterEach(() => vi.restoreAllMocks())

describe('ImageAnnotationEditor source normalization', () => {
  test('browser-decodable HEIC is converted to PNG before upload', async () => {
    const drawImage = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as never)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
      callback(new Blob(['normalized'], { type: 'image/png' }))
    })

    const source = new Blob(['heic'], { type: 'image/heic' })
    const result = await normalizeImageSourceForGateway(source, {
      naturalWidth: 3024,
      naturalHeight: 4032,
    })

    expect(result.type).toBe('image/png')
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 3024, 4032)
  })

  test('PNG/JPEG/WebP sources keep their original bytes', async () => {
    const source = new Blob(['jpeg'], { type: 'image/jpeg' })
    await expect(normalizeImageSourceForGateway(source, {
      naturalWidth: 10,
      naturalHeight: 10,
    })).resolves.toBe(source)
  })
})
