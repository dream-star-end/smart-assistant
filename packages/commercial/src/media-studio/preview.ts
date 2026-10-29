// Downscaled WebP previews of studio images (Q2, 2026-10-30): shot cards, version strips and the
// board asked for the full-size original of every frame (often 1–3 MB PNG) just to draw a 300 px
// tile. A preview is derived from the blob (sha + width), made once on first request with sharp,
// and kept beside the blob store; it holds no quota of its own and is dropped with its blob.

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import sharp from 'sharp'

/** Widths a preview is made at; a request is rounded up to the next one (at most the largest). */
export const PREVIEW_WIDTHS = [320, 640, 1280] as const
export type PreviewWidth = (typeof PREVIEW_WIDTHS)[number]
const PREVIEW_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const SHA_RE = /^[0-9a-f]{64}$/

export function previewWidth(raw: string | null): PreviewWidth {
  const n = Number(raw)
  if (!raw || !Number.isFinite(n) || n <= 0) return 640
  return PREVIEW_WIDTHS.find((w) => w >= n) ?? 1280
}

export function canPreview(mime: string): boolean {
  return PREVIEW_MIMES.has(mime)
}

export function previewPath(root: string, sha: string, w: PreviewWidth): string {
  if (!SHA_RE.test(sha)) throw new Error('invalid blob sha')
  return join(root, 'previews', sha.slice(0, 2), `${sha}-${w}.webp`)
}

/** Every preview of one blob (called when the blob itself is removed). */
export async function removePreviews(root: string, sha: string): Promise<void> {
  await Promise.all(PREVIEW_WIDTHS.map((w) => rm(previewPath(root, sha, w), { force: true })))
}

// One render per preview at a time: concurrent first requests share it.
const rendering = new Map<string, Promise<Buffer>>()

async function render(src: string, dest: string, w: PreviewWidth): Promise<Buffer> {
  const out = await sharp(src)
    .rotate()
    .resize({ width: w, height: w, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 78 })
    .toBuffer()
  await mkdir(dirname(dest), { recursive: true })
  const tmp = `${dest}.${randomUUID()}.tmp`
  try {
    await writeFile(tmp, out)
    await rename(tmp, dest)
  } catch {
    // Not cached this time (disk full, race with a GC): the bytes are still served.
    await rm(tmp, { force: true }).catch(() => {})
  }
  return out
}

/** The preview's bytes, from the cache or freshly made from the original at `src`. */
export async function previewBytes(
  root: string,
  file: { path: string; sha: string },
  w: PreviewWidth,
): Promise<Buffer> {
  const dest = previewPath(root, file.sha, w)
  const cached = await stat(dest).then(
    (s) => s.isFile() && s.size > 0,
    () => false,
  )
  if (cached) return readFile(dest)
  const key = `${file.sha}-${w}`
  let job = rendering.get(key)
  if (!job) {
    job = render(file.path, dest, w).finally(() => rendering.delete(key))
    rendering.set(key, job)
  }
  return job
}

/** Sends a preview; content-addressed (sha + width), so it is cacheable for good. */
export function sendPreview(
  req: IncomingMessage,
  res: ServerResponse,
  sha: string,
  w: PreviewWidth,
  bytes: Buffer,
): void {
  const etag = `"${sha}-${w}"`
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
  res.setHeader('ETag', etag)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  if (req.headers['if-none-match'] === etag) {
    res.statusCode = 304
    res.end()
    return
  }
  res.statusCode = 200
  res.setHeader('Content-Type', 'image/webp')
  res.setHeader('Content-Length', String(bytes.length))
  res.end(bytes)
}
