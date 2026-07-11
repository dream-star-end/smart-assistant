import { rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import sharp from 'sharp'

export const IMAGE_EDIT_PRICE_CREDITS = 50

/** Normalize EXIF orientation before mask coordinates are validated. */
export async function normalizeImageEditSource(path: string): Promise<{
  data: Buffer
  width: number
  height: number
}> {
  const normalized = await sharp(path).rotate().png().toBuffer({ resolveWithObject: true })
  return { data: normalized.data, width: normalized.info.width, height: normalized.info.height }
}

export async function orientedImageDimensions(path: string): Promise<{ width: number; height: number }> {
  const metadata = await sharp(path).metadata()
  if (!metadata.width || !metadata.height) throw new Error('image dimensions unavailable')
  const swapsAxes = [5, 6, 7, 8].includes(metadata.orientation ?? 1)
  return swapsAxes
    ? { width: metadata.height, height: metadata.width }
    : { width: metadata.width, height: metadata.height }
}

/** Expand the bounded browser/display mask to original image coordinates on
 * the server. This avoids a second 48–67 MB full-resolution canvas during
 * mobile submit while preserving hard selection edges with nearest-neighbor
 * scaling. */
export async function normalizeImageEditMask(
  input: Buffer,
  target: { width: number; height: number },
): Promise<Buffer> {
  const metadata = await sharp(input).metadata()
  if (metadata.format !== 'png' || !metadata.width || !metadata.height) {
    throw new Error('mask must be a valid PNG')
  }
  if (metadata.width > target.width || metadata.height > target.height) {
    throw new Error('mask dimensions exceed source')
  }
  const sourceRatio = metadata.width / metadata.height
  const targetRatio = target.width / target.height
  if (Math.abs(sourceRatio - targetRatio) / targetRatio > 0.01) {
    throw new Error('mask aspect ratio differs from source')
  }
  if (metadata.width === target.width && metadata.height === target.height) return input
  return sharp(input)
    .resize(target.width, target.height, { fit: 'fill', kernel: sharp.kernel.nearest })
    .png()
    .toBuffer()
}

export type ImageEditJob = {
  version: 1
  jobId: string
  sourcePath: string
  maskPath: string
  guidePath: string
  outputPath: string
  width: number
  height: number
  createdAt: string
}

type Box = { left: number; top: number; width: number; height: number }

export async function selectionBox(
  maskPath: string,
): Promise<{ box: Box; width: number; height: number }> {
  const { data, info } = await sharp(maskPath)
    .removeAlpha()
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  let minX = info.width
  let minY = info.height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[y * info.width + x]! < 16) continue
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    }
  }
  if (maxX < minX || maxY < minY) throw new Error('selection mask is empty')
  const selectedW = maxX - minX + 1
  const selectedH = maxY - minY + 1
  const padding = Math.max(64, Math.round(Math.max(selectedW, selectedH) * 0.2))
  const left = Math.max(0, minX - padding)
  const top = Math.max(0, minY - padding)
  const right = Math.min(info.width, maxX + padding + 1)
  const bottom = Math.min(info.height, maxY + padding + 1)
  return {
    box: { left, top, width: right - left, height: bottom - top },
    width: info.width,
    height: info.height,
  }
}

function targetSize(box: Box): { width: number; height: number; api: string } {
  const ratio = box.width / box.height
  if (ratio > 1.2) return { width: 1536, height: 1024, api: '1536x1024' }
  if (ratio < 1 / 1.2) return { width: 1024, height: 1536, api: '1024x1536' }
  return { width: 1024, height: 1024, api: '1024x1024' }
}

/** Prepare a crop and an API-compatible mask. The browser mask uses white for
 * selected pixels; the Images API mask uses transparent alpha for editable
 * pixels. Padding remains opaque so the model cannot alter it. */
export async function prepareImageEdit(job: ImageEditJob): Promise<{
  image: Buffer
  mask: Buffer
  box: Box
  target: { width: number; height: number; api: string }
  inner: { width: number; height: number; left: number; top: number }
}> {
  const meta = await sharp(job.sourcePath).metadata()
  const selected = await selectionBox(job.maskPath)
  if (meta.width !== selected.width || meta.height !== selected.height)
    throw new Error('source and mask dimensions differ')
  if (meta.width !== job.width || meta.height !== job.height)
    throw new Error('image edit dimensions were tampered with')
  const target = targetSize(selected.box)
  const scale = Math.min(target.width / selected.box.width, target.height / selected.box.height)
  const inner = {
    width: Math.max(1, Math.round(selected.box.width * scale)),
    height: Math.max(1, Math.round(selected.box.height * scale)),
    left: 0,
    top: 0,
  }
  inner.left = Math.floor((target.width - inner.width) / 2)
  inner.top = Math.floor((target.height - inner.height) / 2)
  const image = await sharp(job.sourcePath)
    .extract(selected.box)
    .resize(target.width, target.height, {
      fit: 'contain',
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .png()
    .toBuffer()
  const selectedRaw = await sharp(job.maskPath)
    .extract(selected.box)
    .removeAlpha()
    .greyscale()
    .resize(inner.width, inner.height, { fit: 'fill' })
    .raw()
    .toBuffer()
  const rgba = Buffer.alloc(target.width * target.height * 4, 255)
  for (let y = 0; y < inner.height; y++) {
    for (let x = 0; x < inner.width; x++) {
      const src = selectedRaw[y * inner.width + x]!
      const i = ((y + inner.top) * target.width + x + inner.left) * 4
      rgba[i] = 255
      rgba[i + 1] = 255
      rgba[i + 2] = 255
      rgba[i + 3] = 255 - src
    }
  }
  const mask = await sharp(rgba, {
    raw: { width: target.width, height: target.height, channels: 4 },
  })
    .png()
    .toBuffer()
  return { image, mask, box: selected.box, target, inner }
}

/** Deterministically place the model output back under the user's mask. The
 * source is the base image, therefore every pixel outside the feathered mask
 * stays byte-for-byte sourced from the original. */
export async function compositeImageEdit(
  job: ImageEditJob,
  generated: Buffer,
  prepared: Awaited<ReturnType<typeof prepareImageEdit>>,
): Promise<string> {
  const normalizedGenerated = await sharp(generated)
    .resize(prepared.target.width, prepared.target.height, { fit: 'fill' })
    .png()
    .toBuffer()
  const editedCrop = await sharp(normalizedGenerated)
    .extract({
      left: prepared.inner.left,
      top: prepared.inner.top,
      width: prepared.inner.width,
      height: prepared.inner.height,
    })
    .resize(prepared.box.width, prepared.box.height, { fit: 'fill' })
    .png()
    .toBuffer()
  const alpha = await sharp(job.maskPath)
    .extract(prepared.box)
    .removeAlpha()
    .greyscale()
    .blur(1.5)
    .raw()
    .toBuffer({ resolveWithObject: true })
  const hardSelection = await sharp(job.maskPath)
    .extract(prepared.box)
    .removeAlpha()
    .greyscale()
    .raw()
    .toBuffer()
  const editedRaw = await sharp(editedCrop).removeAlpha().raw().toBuffer()
  const rgba = Buffer.alloc(prepared.box.width * prepared.box.height * 4)
  for (let pixel = 0; pixel < prepared.box.width * prepared.box.height; pixel++) {
    rgba[pixel * 4] = editedRaw[pixel * 3]!
    rgba[pixel * 4 + 1] = editedRaw[pixel * 3 + 1]!
    rgba[pixel * 4 + 2] = editedRaw[pixel * 3 + 2]!
    // Inward-only feather: pixels outside the hard selection remain alpha=0
    // and therefore byte-for-byte original after compositing.
    rgba[pixel * 4 + 3] = Math.min(alpha.data[pixel]!, hardSelection[pixel]!)
  }
  const overlay = await sharp(rgba, {
    raw: { width: prepared.box.width, height: prepared.box.height, channels: 4 },
  })
    .png()
    .toBuffer()
  const output = await sharp(job.sourcePath)
    .composite([{ input: overlay, left: prepared.box.left, top: prepared.box.top, blend: 'over' }])
    .png()
    .toBuffer()
  const tmp = join(dirname(job.outputPath), `.${basename(job.outputPath)}.${process.pid}.tmp`)
  await writeFile(tmp, output, { mode: 0o600 })
  await rename(tmp, job.outputPath)
  return job.outputPath
}
