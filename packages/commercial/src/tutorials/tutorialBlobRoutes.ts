import type { IncomingMessage, ServerResponse } from 'node:http'

import { getApprovedTutorialBlob } from './tutorialBlobs.js'
import { PASSIVE_EMBED_MIMES } from './snapshotSanitizer.js'
import { HttpError } from '../http/util.js'

const SHA_RE = /^\/api\/tutorial-(?:blobs|embeds)\/([a-f0-9]{64})(?:\?|$)/

export const TUTORIAL_EMBED_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src 'none'",
  "connect-src 'none'",
  "form-action 'none'",
  "navigate-to 'none'",
  "frame-src 'none'",
  "frame-ancestors 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "worker-src 'none'",
  "sandbox allow-scripts",
].join('; ')

function shaFromReq(req: IncomingMessage): string {
  const match = SHA_RE.exec(req.url ?? '')
  if (!match?.[1]) throw new HttpError(400, 'BAD_REQUEST', 'invalid blob id')
  return match[1]
}

function sendBlob(
  res: ServerResponse,
  args: {
    body: Buffer
    mime: string
    filename: string
    disposition: 'attachment' | 'inline'
    csp?: string
  },
): void {
  res.statusCode = 200
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', args.disposition === 'inline' ? 'SAMEORIGIN' : 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Length', String(args.body.length))
  res.setHeader(
    'Content-Disposition',
    `${args.disposition}; filename="${args.filename.replace(/["\r\n]/g, '_')}"`,
  )
  if (args.csp) res.setHeader('Content-Security-Policy', args.csp)
  res.setHeader('Content-Type', args.mime)
  res.end(args.body)
}

export async function handleGetTutorialBlob(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const sha = shaFromReq(req)
  const blob = await getApprovedTutorialBlob(sha)
  if (!blob) throw new HttpError(404, 'NOT_FOUND', 'blob not found')
  const filename = blob.role.split(':').pop() || 'artifact.bin'
  sendBlob(res, {
    body: blob.body,
    mime: 'application/octet-stream',
    filename,
    disposition: 'attachment',
  })
}

export async function handleGetTutorialEmbed(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const sha = shaFromReq(req)
  const blob = await getApprovedTutorialBlob(sha)
  if (!blob) throw new HttpError(404, 'NOT_FOUND', 'embed not found')
  const mime = blob.mime.split(';')[0]!.trim().toLowerCase()
  if (!PASSIVE_EMBED_MIMES.has(mime)) throw new HttpError(404, 'NOT_FOUND', 'embed not found')
  if (mime === 'text/html') {
    if (blob.kind !== 'htmlpreview') throw new HttpError(404, 'NOT_FOUND', 'embed not found')
    const filename = blob.role.split(':').pop() || 'preview.html'
    sendBlob(res, {
      body: blob.body,
      mime: 'text/html; charset=utf-8',
      filename,
      disposition: 'inline',
      csp: TUTORIAL_EMBED_CSP,
    })
    return
  }
  const filename = blob.role.split(':').pop() || 'media.bin'
  sendBlob(res, {
    body: blob.body,
    mime,
    filename,
    disposition: 'inline',
    csp: "default-src 'none'; sandbox; connect-src 'none'; form-action 'none'; navigate-to 'none'",
  })
}
