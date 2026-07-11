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

/** Nearest gpt-image-2 native canvas for a given width/height ratio. Single
 * authority shared by the annotated crop path and the outpaint canvas path so
 * both agree on the API `size` string. */
function targetSizeForRatio(ratio: number): { width: number; height: number; api: string } {
  if (ratio > 1.2) return { width: 1536, height: 1024, api: '1536x1024' }
  if (ratio < 1 / 1.2) return { width: 1024, height: 1536, api: '1024x1536' }
  return { width: 1024, height: 1024, api: '1024x1024' }
}

function targetSize(box: Box): { width: number; height: number; api: string } {
  return targetSizeForRatio(box.width / box.height)
}

// ───────────────────────────────────────────────
// Outpaint(调整画面比例)— v5 图片体验
// ───────────────────────────────────────────────
export type OutpaintAspect = '16:9' | '4:3' | '9:16' | '3:4' | '1:1'

const OUTPAINT_ASPECT_RATIOS: Record<OutpaintAspect, number> = {
  '16:9': 16 / 9,
  '4:3': 4 / 3,
  '9:16': 9 / 16,
  '3:4': 3 / 4,
  '1:1': 1,
}

export function isOutpaintAspect(value: unknown): value is OutpaintAspect {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(OUTPAINT_ASPECT_RATIOS, value)
}

/** Minimal canvas that fully contains the source at the requested aspect ratio.
 * The source is never cropped — one axis matches the source exactly, the
 * deficient axis is padded so `width/height === aspect`. This is the FINAL
 * (post-outpaint) output geometry and the single authority both the relay
 * compositor (`compositeImageOutpaint`) and the gateway output-dimension guard
 * (`server.ts`) use, so they can never disagree on the expected output size. */
export function outpaintTargetDimensions(
  sourceWidth: number,
  sourceHeight: number,
  aspect: OutpaintAspect,
): { width: number; height: number } {
  const targetRatio = OUTPAINT_ASPECT_RATIOS[aspect]
  const sourceRatio = sourceWidth / sourceHeight
  if (sourceRatio < targetRatio) {
    // Source relatively narrow → keep height, widen (pad left/right).
    return { width: Math.max(sourceWidth, Math.round(sourceHeight * targetRatio)), height: sourceHeight }
  }
  if (sourceRatio > targetRatio) {
    // Source relatively wide → keep width, heighten (pad top/bottom).
    return { width: sourceWidth, height: Math.max(sourceHeight, Math.round(sourceWidth / targetRatio)) }
  }
  return { width: sourceWidth, height: sourceHeight }
}

/** Build the gpt-image-2 `/images/edits` request for an outpaint. The source is
 * centred (at native resolution, letterboxed) inside a white API frame; the
 * Images-API mask is transparent (editable) over the padding that must be
 * generated and opaque (preserved) over the source footprint. `job.sourcePath`
 * MUST already be EXIF-normalised at `job.width × job.height` (the relay writes
 * a rotated PNG before calling this — same contract as `prepareImageEdit`). */
export async function prepareImageOutpaint(
  job: ImageEditJob,
  aspect: OutpaintAspect,
): Promise<{
  image: Buffer
  mask: Buffer
  target: { width: number; height: number; api: string }
  /** Final output geometry (exact target aspect, source centred). */
  canvas: { width: number; height: number }
  /** Logical canvas placed inside the API frame (letterbox removed on composite). */
  inner: { width: number; height: number; left: number; top: number }
  /** Source footprint within the logical canvas (native resolution). */
  footprint: { width: number; height: number; left: number; top: number }
}> {
  const meta = await sharp(job.sourcePath).metadata()
  if (!meta.width || !meta.height) throw new Error('image dimensions unavailable')
  if (meta.width !== job.width || meta.height !== job.height)
    throw new Error('image outpaint dimensions were tampered with')

  const canvas = outpaintTargetDimensions(job.width, job.height, aspect)
  const footprintCanvas = {
    width: job.width,
    height: job.height,
    left: Math.floor((canvas.width - job.width) / 2),
    top: Math.floor((canvas.height - job.height) / 2),
  }

  // The logical canvas already carries the target aspect; letterbox it into the
  // nearest native API frame. Letterbox stays opaque so the model never spends
  // tokens painting pixels that the composite discards anyway.
  const target = targetSizeForRatio(canvas.width / canvas.height)
  const scale = Math.min(target.width / canvas.width, target.height / canvas.height)
  const inner = {
    width: Math.max(1, Math.round(canvas.width * scale)),
    height: Math.max(1, Math.round(canvas.height * scale)),
    left: 0,
    top: 0,
  }
  inner.left = Math.floor((target.width - inner.width) / 2)
  inner.top = Math.floor((target.height - inner.height) / 2)

  const footprintApi = {
    width: Math.max(1, Math.round(job.width * scale)),
    height: Math.max(1, Math.round(job.height * scale)),
    left: 0,
    top: 0,
  }
  footprintApi.left = inner.left + Math.floor((inner.width - footprintApi.width) / 2)
  footprintApi.top = inner.top + Math.floor((inner.height - footprintApi.height) / 2)

  const scaledSource = await sharp(job.sourcePath)
    .resize(footprintApi.width, footprintApi.height, { fit: 'fill' })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .png()
    .toBuffer()
  const image = await sharp({
    create: {
      width: target.width,
      height: target.height,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .composite([{ input: scaledSource, left: footprintApi.left, top: footprintApi.top }])
    .png()
    .toBuffer()

  // Mask alpha: opaque (preserve) everywhere, then carve the editable padding
  // = (inner ∖ footprint) transparent so only that band is generated.
  const rgba = Buffer.alloc(target.width * target.height * 4, 255)
  for (let y = inner.top; y < inner.top + inner.height; y++) {
    const row = y * target.width
    for (let x = inner.left; x < inner.left + inner.width; x++) rgba[(row + x) * 4 + 3] = 0
  }
  for (let y = footprintApi.top; y < footprintApi.top + footprintApi.height; y++) {
    const row = y * target.width
    for (let x = footprintApi.left; x < footprintApi.left + footprintApi.width; x++) rgba[(row + x) * 4 + 3] = 255
  }
  const mask = await sharp(rgba, { raw: { width: target.width, height: target.height, channels: 4 } })
    .png()
    .toBuffer()

  return { image, mask, target, canvas, inner, footprint: footprintCanvas }
}

/** Deterministically assemble the final outpaint image: take the model output,
 * drop the API letterbox, resize to the exact target-aspect canvas, then paste
 * the ORIGINAL source back over its footprint so every source pixel is
 * byte-for-byte preserved — the model only ever owns the padding band. */
export async function compositeImageOutpaint(
  job: ImageEditJob,
  generated: Buffer,
  prepared: Awaited<ReturnType<typeof prepareImageOutpaint>>,
): Promise<string> {
  const normalizedGenerated = await sharp(generated)
    .resize(prepared.target.width, prepared.target.height, { fit: 'fill' })
    .png()
    .toBuffer()
  const outpaintedCanvas = await sharp(normalizedGenerated)
    .extract({
      left: prepared.inner.left,
      top: prepared.inner.top,
      width: prepared.inner.width,
      height: prepared.inner.height,
    })
    .resize(prepared.canvas.width, prepared.canvas.height, { fit: 'fill' })
    .png()
    .toBuffer()
  // Source footprint == native source dimensions, so no resample — byte fidelity.
  const sourcePng = await sharp(job.sourcePath).png().toBuffer()
  const output = await sharp(outpaintedCanvas)
    .composite([{ input: sourcePng, left: prepared.footprint.left, top: prepared.footprint.top, blend: 'over' }])
    .png()
    .toBuffer()
  const tmp = join(dirname(job.outputPath), `.${basename(job.outputPath)}.${process.pid}.tmp`)
  await writeFile(tmp, output, { mode: 0o600 })
  await rename(tmp, job.outputPath)
  return job.outputPath
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
