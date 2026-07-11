import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import sharp from 'sharp'
import { compositeImageEdit, normalizeImageEditMask, normalizeImageEditSource, orientedImageDimensions, prepareImageEdit, type ImageEditJob } from '../imageEdit.js'

const roots: string[] = []
afterEach(async () =>
  Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true }))),
)

describe('precise image editing', () => {
  it('expands a display-resolution mobile mask to original coordinates', async () => {
    const raw = Buffer.alloc(400 * 300)
    for (let y = 100; y < 200; y++) for (let x = 150; x < 250; x++) raw[y * 400 + x] = 255
    const small = await sharp(raw, { raw: { width: 400, height: 300, channels: 1 } }).png().toBuffer()
    const normalized = await normalizeImageEditMask(small, { width: 4000, height: 3000 })
    const metadata = await sharp(normalized).metadata()
    assert.deepEqual({ width: metadata.width, height: metadata.height, format: metadata.format }, {
      width: 4000, height: 3000, format: 'png',
    })
  })

  it('normalizes EXIF orientation before matching browser mask coordinates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oc-image-orientation-'))
    roots.push(root)
    const sourcePath = join(root, 'phone.jpg')
    await sharp({ create: { width: 120, height: 80, channels: 3, background: '#4477aa' } })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toFile(sourcePath)
    const normalized = await normalizeImageEditSource(sourcePath)
    assert.deepEqual(await orientedImageDimensions(sourcePath), { width: 80, height: 120 })
    assert.equal(normalized.width, 80)
    assert.equal(normalized.height, 120)
    assert.equal((await sharp(normalized.data).metadata()).format, 'png')
  })

  it('creates a transparent API edit mask and preserves pixels outside the user selection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oc-image-edit-'))
    roots.push(root)
    const width = 120
    const height = 80
    const sourcePath = join(root, 'source.png')
    const maskPath = join(root, 'mask.png')
    const outputPath = join(root, 'output.png')
    await sharp({
      create: { width, height, channels: 4, background: { r: 20, g: 80, b: 160, alpha: 1 } },
    })
      .png()
      .toFile(sourcePath)
    const mask = Buffer.alloc(width * height, 0)
    for (let y = 25; y < 55; y++) for (let x = 45; x < 75; x++) mask[y * width + x] = 255
    await sharp(mask, { raw: { width, height, channels: 1 } })
      .png()
      .toFile(maskPath)
    const job: ImageEditJob = {
      version: 1,
      jobId: 'a'.repeat(32),
      sourcePath,
      maskPath,
      guidePath: sourcePath,
      outputPath,
      width,
      height,
      createdAt: new Date().toISOString(),
    }
    const prepared = await prepareImageEdit(job)
    const apiMask = await sharp(prepared.mask)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    assert.ok(
      apiMask.data.some((_, i) => i % 4 === 3 && apiMask.data[i] === 0),
      'selection becomes transparent',
    )
    assert.ok(
      apiMask.data.some((_, i) => i % 4 === 3 && apiMask.data[i] === 255),
      'unselected padding remains opaque',
    )
    const generated = await sharp({
      create: {
        width: prepared.target.width,
        height: prepared.target.height,
        channels: 4,
        background: { r: 230, g: 30, b: 20, alpha: 1 },
      },
    })
      .png()
      .toBuffer()
    await compositeImageEdit(job, generated, prepared)
    const original = await sharp(sourcePath).ensureAlpha().raw().toBuffer()
    const output = await sharp(outputPath).ensureAlpha().raw().toBuffer()
    const outside = (10 * width + 10) * 4
    assert.deepEqual(
      [...output.subarray(outside, outside + 4)],
      [...original.subarray(outside, outside + 4)],
    )
    const edgeOutside = (40 * width + 44) * 4
    assert.deepEqual(
      [...output.subarray(edgeOutside, edgeOutside + 4)],
      [...original.subarray(edgeOutside, edgeOutside + 4)],
    )
    const inside = (40 * width + 60) * 4
    assert.notDeepEqual(
      [...output.subarray(inside, inside + 3)],
      [...original.subarray(inside, inside + 3)],
    )
    assert.equal((await readFile(outputPath)).length > 0, true)
  })

  it('rejects an empty selection before calling Image 2', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oc-image-edit-'))
    roots.push(root)
    const sourcePath = join(root, 'source.png')
    const maskPath = join(root, 'mask.png')
    await sharp({ create: { width: 20, height: 20, channels: 3, background: '#fff' } })
      .png()
      .toFile(sourcePath)
    await writeFile(
      maskPath,
      await sharp(Buffer.alloc(20 * 20), { raw: { width: 20, height: 20, channels: 1 } })
        .png()
        .toBuffer(),
    )
    await assert.rejects(
      () =>
        prepareImageEdit({
          version: 1,
          jobId: 'b'.repeat(32),
          sourcePath,
          maskPath,
          guidePath: sourcePath,
          outputPath: join(root, 'out.png'),
          width: 20,
          height: 20,
          createdAt: new Date().toISOString(),
        }),
      /empty/,
    )
  })
})
