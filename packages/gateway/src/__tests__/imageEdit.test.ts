import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import sharp from 'sharp'
import {
  compositeImageEdit,
  compositeImageOutpaint,
  enforceMinSelectionBox,
  type ImageEditJob,
  isOutpaintAspect,
  normalizeImageEditMask,
  normalizeImageEditSource,
  type OutpaintAspect,
  orientedImageDimensions,
  outpaintTargetDimensions,
  prepareImageEdit,
  prepareImageOutpaint,
} from '../imageEdit.js'

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

  it('rejects an empty selection before calling Image 2 (annotated)', async () => {
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

  it('enforceMinSelectionBox expands a degenerate box to the image short-edge floor, clamped', () => {
    // 1px 选区 → 短边扩到 8% × 1000 = 80,以中心为锚,clamp 回图像内。
    const tiny = enforceMinSelectionBox({ left: 4, top: 4, width: 1, height: 1 }, 1200, 1000)
    assert.equal(tiny.width, 80)
    assert.equal(tiny.height, 80)
    assert.equal(tiny.left, 0) // 中心(4.5)向左扩到下限后 clamp 到 0(不越界)
    assert.equal(tiny.top, 0)
    assert.ok(tiny.left + tiny.width <= 1200 && tiny.top + tiny.height <= 1000)
    // 已达标的选区原样返回(只在短边低于下限时才动)。
    const ok = enforceMinSelectionBox({ left: 100, top: 100, width: 300, height: 300 }, 1200, 1000)
    assert.deepEqual(ok, { left: 100, top: 100, width: 300, height: 300 })
  })

  it('prepareImageEdit floors a tiny annotated selection so the crop is never degenerate (anti-400)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oc-image-edit-'))
    roots.push(root)
    const width = 1000
    const height = 800
    const sourcePath = join(root, 'source.png')
    const maskPath = join(root, 'mask.png')
    await sharp({ create: { width, height, channels: 3, background: '#3355aa' } })
      .png()
      .toFile(sourcePath)
    // 一个 6×6 的极小白点选区(远低于 8% 短边 = 64px)。
    const mask = Buffer.alloc(width * height, 0)
    for (let y = 400; y < 406; y++) for (let x = 500; x < 506; x++) mask[y * width + x] = 255
    await sharp(mask, { raw: { width, height, channels: 1 } }).png().toFile(maskPath)
    const prepared = await prepareImageEdit({
      version: 1,
      jobId: 'c'.repeat(32),
      sourcePath,
      maskPath,
      guidePath: sourcePath,
      outputPath: join(root, 'out.png'),
      width,
      height,
      createdAt: new Date().toISOString(),
    })
    const floor = Math.round(Math.min(width, height) * 0.08) // 64
    assert.ok(
      Math.min(prepared.box.width, prepared.box.height) >= floor,
      `box short edge ${Math.min(prepared.box.width, prepared.box.height)} must be >= floor ${floor}`,
    )
    // 仍产出良构的 API 画布 + 透明可编辑区(不退化 → 不触发上游 400)。
    const apiMask = await sharp(prepared.mask).ensureAlpha().raw().toBuffer()
    assert.ok(apiMask.some((_, i) => i % 4 === 3 && apiMask[i] === 0), 'editable region present')
  })
})

describe('image outpaint (调整画面比例)', () => {
  it('recognizes exactly the five supported aspects', () => {
    for (const good of ['16:9', '4:3', '9:16', '3:4', '1:1']) {
      assert.equal(isOutpaintAspect(good), true, `${good} must be accepted`)
    }
    for (const bad of ['2:1', '16-9', '1:2', '', 'square', undefined, null, 169]) {
      assert.equal(isOutpaintAspect(bad), false, `${String(bad)} must be rejected`)
    }
  })

  it('expands the canvas to the target aspect without ever cropping the source', () => {
    // Source 120×80 (3:2). Each aspect keeps one axis and pads the other so the
    // source is fully contained; the returned canvas is the FINAL output size.
    const cases: Array<[OutpaintAspect, { width: number; height: number }]> = [
      ['16:9', { width: 142, height: 80 }], // widen: round(80*16/9)
      ['4:3', { width: 120, height: 90 }], // heighten: round(120/(4/3))
      ['9:16', { width: 120, height: 213 }], // heighten: round(120/(9/16))
      ['3:4', { width: 120, height: 160 }], // heighten: round(120/(3/4))
      ['1:1', { width: 120, height: 120 }], // heighten to square
    ]
    for (const [aspect, expected] of cases) {
      const dims = outpaintTargetDimensions(120, 80, aspect)
      assert.deepEqual(dims, expected, `${aspect} canvas dims`)
      assert.ok(dims.width >= 120 && dims.height >= 80, `${aspect}: source never cropped`)
    }
  })

  it('builds a transparent outpaint padding mask at the nearest native API size', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oc-image-outpaint-'))
    roots.push(root)
    const width = 120
    const height = 80
    const sourcePath = join(root, 'source.png')
    await sharp({ create: { width, height, channels: 3, background: { r: 20, g: 80, b: 160 } } })
      .png()
      .toFile(sourcePath)
    const job: ImageEditJob = {
      version: 1,
      jobId: 'd'.repeat(32),
      sourcePath,
      maskPath: '',
      guidePath: '',
      outputPath: join(root, 'out.png'),
      width,
      height,
      createdAt: new Date().toISOString(),
    }
    const prepared = await prepareImageOutpaint(job, '16:9')
    assert.equal(prepared.target.api, '1536x1024', 'ratio 1.775 → nearest native 1536x1024')
    assert.deepEqual(prepared.canvas, { width: 142, height: 80 })
    assert.deepEqual(prepared.footprint, { width: 120, height: 80, left: 11, top: 0 })
    const imgMeta = await sharp(prepared.image).metadata()
    assert.deepEqual({ w: imgMeta.width, h: imgMeta.height }, { w: 1536, h: 1024 }, 'API image = native frame')
    const maskMeta = await sharp(prepared.mask).metadata()
    assert.deepEqual({ w: maskMeta.width, h: maskMeta.height }, { w: 1536, h: 1024 }, 'API mask = native frame')
    const maskAlpha = await sharp(prepared.mask).ensureAlpha().raw().toBuffer()
    assert.ok(
      maskAlpha.some((_, i) => i % 4 === 3 && maskAlpha[i] === 0),
      'padding band is transparent (editable)',
    )
    assert.ok(
      maskAlpha.some((_, i) => i % 4 === 3 && maskAlpha[i] === 255),
      'source footprint stays opaque (preserved)',
    )
  })

  it('picks the nearest native API frame per aspect', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oc-image-outpaint-api-'))
    roots.push(root)
    const sourcePath = join(root, 's.png')
    await sharp({ create: { width: 120, height: 80, channels: 3, background: '#123456' } }).png().toFile(sourcePath)
    const job = (aspect: string): ImageEditJob => ({
      version: 1, jobId: 'e'.repeat(32), sourcePath, maskPath: '', guidePath: '',
      outputPath: join(root, `${aspect.replace(':', '_')}.png`), width: 120, height: 80,
      createdAt: new Date().toISOString(),
    })
    assert.equal((await prepareImageOutpaint(job('16:9'), '16:9')).target.api, '1536x1024')
    assert.equal((await prepareImageOutpaint(job('9:16'), '9:16')).target.api, '1024x1536')
    assert.equal((await prepareImageOutpaint(job('1:1'), '1:1')).target.api, '1024x1024')
  })

  it('crops the model output to the target ratio and keeps the source footprint byte-for-byte', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oc-image-outpaint-composite-'))
    roots.push(root)
    const width = 120
    const height = 80
    // Per-pixel gradient so a byte-identical footprint can only pass if the
    // original source bytes are preserved (a solid colour would pass trivially).
    const srcRaw = Buffer.alloc(width * height * 3)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 3
        srcRaw[i] = (x * 2) % 256
        srcRaw[i + 1] = (y * 3) % 256
        srcRaw[i + 2] = (x + y) % 256
      }
    }
    const sourcePath = join(root, 'source.png')
    await sharp(srcRaw, { raw: { width, height, channels: 3 } }).png().toFile(sourcePath)
    const outputPath = join(root, 'out.png')
    const job: ImageEditJob = {
      version: 1, jobId: 'f'.repeat(32), sourcePath, maskPath: '', guidePath: '', outputPath,
      width, height, createdAt: new Date().toISOString(),
    }
    const prepared = await prepareImageOutpaint(job, '1:1')
    assert.deepEqual(prepared.canvas, { width: 120, height: 120 })
    assert.deepEqual(prepared.footprint, { width: 120, height: 80, left: 0, top: 20 })
    // A uniform "generated" model frame at the requested native size.
    const generated = await sharp({
      create: { width: prepared.target.width, height: prepared.target.height, channels: 4, background: { r: 230, g: 30, b: 20, alpha: 1 } },
    }).png().toBuffer()
    await compositeImageOutpaint(job, generated, prepared)
    const outMeta = await sharp(outputPath).metadata()
    assert.deepEqual({ w: outMeta.width, h: outMeta.height }, { w: 120, h: 120 }, 'output cropped to exact target aspect')
    // Source footprint preserved byte-for-byte.
    const outFootprint = await sharp(outputPath)
      .extract({ left: prepared.footprint.left, top: prepared.footprint.top, width: prepared.footprint.width, height: prepared.footprint.height })
      .removeAlpha()
      .raw()
      .toBuffer()
    const srcRawOut = await sharp(sourcePath).removeAlpha().raw().toBuffer()
    assert.equal(Buffer.compare(outFootprint, srcRawOut), 0, 'source footprint is byte-identical')
    // Padding band comes from the model output, not the source.
    const padPixel = await sharp(outputPath).extract({ left: 40, top: 2, width: 1, height: 1 }).removeAlpha().raw().toBuffer()
    assert.deepEqual([...padPixel], [230, 30, 20], 'padding filled by the generated image')
  })

  it('rejects a tampered source size before calling Image 2', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oc-image-outpaint-tamper-'))
    roots.push(root)
    const sourcePath = join(root, 'source.png')
    await sharp({ create: { width: 100, height: 100, channels: 3, background: '#fff' } }).png().toFile(sourcePath)
    await assert.rejects(
      () =>
        prepareImageOutpaint(
          {
            version: 1, jobId: 'a'.repeat(32), sourcePath, maskPath: '', guidePath: '',
            outputPath: join(root, 'o.png'), width: 120, height: 80, createdAt: new Date().toISOString(),
          },
          '16:9',
        ),
      /tampered/,
    )
  })
})
