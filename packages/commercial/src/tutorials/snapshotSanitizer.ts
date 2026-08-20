import { createHash } from 'node:crypto'
import {
  PUBLIC_TUTORIAL_ROLES,
  STRIPPED_TUTORIAL_ROLES,
  TUTORIAL_SANITIZER_VERSION,
  isPrivatePublicReplayField,
  type PublicTutorialRole,
  type TutorialLeak,
  type TutorialLeakRule,
} from '@openclaude/protocol'

export { TUTORIAL_SANITIZER_VERSION }

const PUBLIC_ROLE_SET = new Set<string>(PUBLIC_TUTORIAL_ROLES)
const STRIP_ROLE_SET = new Set<string>(STRIPPED_TUTORIAL_ROLES)

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
const PHONE_RE = /(?<!\d)(?:\+?\d{1,3}[-.\s])?(?:\(?\d{2,4}\)?[-.\s])?\d{3,4}[-.\s]\d{4}(?!\d)/
const ABSOLUTE_PATH_RE =
  /(?:^|[\s"'`=(])(?:\/(?:home|root|opt|var|etc|usr|tmp|private)\/|\/home\/agent\/|[A-Za-z]:\\)/
const SESSION_ID_RE = /\b(?:session[_-]?id|session[_-]?key|sessionid)\b/i
const TRACE_ID_RE = /\b(?:trace[_-]?id|traceid)\b|[a-f0-9]{32}\b/i
const REQUEST_ID_RE = /\b(?:request[_-]?id|client[_-]?message[_-]?id|turn[_-]?key)\b/i
const CONTAINER_ID_RE = /\b(?:container[_-]?id|peer[_-]?id)\b|[a-f0-9]{64}\b/i
const SIGNED_MEDIA_RE = /\/api\/media-signed\b|\bmedia-signed\?t=/i
const DANGEROUS_SCHEME_RE = /(?:javascript|vbscript|file|data:\s*text\/html)\s*:/i
const PRIVATE_KEY_RE = /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/
const SECRET_TOKEN_RE =
  /\b(?:sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/
const HTML_EXTERNAL_RE =
  /\b(?:href|src|action|formaction|poster|cite)\s*=\s*["']\s*(?:https?:|\/\/)/i
const NETWORK_API_RE =
  /\b(?:fetch\s*\(|XMLHttpRequest|new\s+WebSocket|navigator\.sendBeacon|import\s*\(|connect-src)\b/
const HTML_NAV_RE =
  /<meta\b[^>]*http-equiv\s*=\s*['"]?refresh\b|\b(?:window|document)\.location\b|\blocation\.(?:href|assign|replace)\s*[=\(]|\blocation\s*=\s*['"]/i

export const SNAPSHOT_MAX_MESSAGES = 1000
export const SNAPSHOT_MESSAGE_PAGE_SIZE = 50
export const SNAPSHOT_MAX_MESSAGE_CHARS = 20_000
export const SNAPSHOT_MAX_ARTIFACTS = 8
export const SNAPSHOT_MAX_ARTIFACT_BYTES = 8 * 1024 * 1024
export const SNAPSHOT_MAX_TOTAL_ARTIFACT_BYTES = 32 * 1024 * 1024
export const SNAPSHOT_MAX_HTML_BYTES = 1 * 1024 * 1024
export const TUTORIAL_SNAPSHOT_MAX_BODY_BYTES = 48 * 1024 * 1024

export const PASSIVE_EMBED_MIMES = new Set([
  'text/html',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
  'audio/mp4',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'application/pdf',
])

export function normalizeTutorialMime(mime: string): string {
  const normalized = mime.trim().toLowerCase()
  if (normalized === 'image/jpg') return 'image/jpeg'
  return normalized
}

/** Strict RFC4648 base64: reject whitespace, url-safe alphabet, missing padding, and non-canonical encodings. */
export function decodeCanonicalBase64(input: string): Buffer | null {
  if (input.length === 0 || input.length % 4 !== 0) return null
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(input)) return null
  const padding = input.endsWith('==') ? 2 : input.endsWith('=') ? 1 : 0
  if (input.slice(0, input.length - padding).includes('=')) return null
  let decoded: Buffer
  try {
    decoded = Buffer.from(input, 'base64')
  } catch {
    return null
  }
  if (decoded.toString('base64') !== input) return null
  return decoded
}

export class SnapshotSanitizeError extends Error {
  constructor(
    readonly leaks: TutorialLeak[],
    message = 'snapshot contains unpublished secrets or unsafe content',
  ) {
    super(message)
    this.name = 'SnapshotSanitizeError'
  }
}

export type SanitizedPublicMessage = {
  id: string
  role: PublicTutorialRole
  text: string
  ts: number
  _media?: Array<{ kind: string; url: string; mimeType?: string; filename?: string }>
}

export type SelectedTutorialArtifact = {
  name: string
  mimeType: string
  contentBase64: string
}

export type TutorialBlobDraft = {
  sha256: string
  kind: 'messages' | 'artifact' | 'media' | 'htmlpreview'
  mime: string
  bytes: number
  body: Buffer
  role: string
  title: string
}

export type PublicSnapshotManifest = {
  schemaVersion: 1
  sanitizerVersion: string
  messageCount: number
  pages: Array<{
    role: string
    sha256: string
    bytes: number
    messageCount: number
    startOrdinal: number
  }>
  artifacts: Array<{
    title: string
    role: string
    sha256: string
    bytes: number
    mimeType: string
  }>
}

export type SnapshotSanitizeOk = {
  ok: true
  sanitizerVersion: string
  manifest: PublicSnapshotManifest
  messages: SanitizedPublicMessage[]
  blobs: TutorialBlobDraft[]
}

export type SnapshotSanitizeFail = {
  ok: false
  leakReport: { leaks: TutorialLeak[] }
}

function leak(rule: TutorialLeakRule, field: string): TutorialLeak {
  return { rule, field }
}

function pushUnique(into: TutorialLeak[], item: TutorialLeak): void {
  if (into.some((row) => row.rule === item.rule && row.field === item.field)) return
  into.push(item)
}

export function scanText(value: string, field: string): TutorialLeak[] {
  const found: TutorialLeak[] = []
  if (PRIVATE_KEY_RE.test(value)) pushUnique(found, leak('private_key', field))
  if (SECRET_TOKEN_RE.test(value)) pushUnique(found, leak('secret_token', field))
  if (EMAIL_RE.test(value)) pushUnique(found, leak('email', field))
  if (PHONE_RE.test(value)) pushUnique(found, leak('phone', field))
  if (ABSOLUTE_PATH_RE.test(value)) pushUnique(found, leak('absolute_path', field))
  if (SESSION_ID_RE.test(value)) pushUnique(found, leak('session_identifier', field))
  if (TRACE_ID_RE.test(value) && /trace/i.test(value))
    pushUnique(found, leak('trace_identifier', field))
  if (REQUEST_ID_RE.test(value)) pushUnique(found, leak('request_identifier', field))
  if (CONTAINER_ID_RE.test(value) && /container|peer/i.test(value))
    pushUnique(found, leak('container_identifier', field))
  if (SIGNED_MEDIA_RE.test(value)) pushUnique(found, leak('signed_media_url', field))
  if (DANGEROUS_SCHEME_RE.test(value)) pushUnique(found, leak('dangerous_scheme', field))
  if (HTML_EXTERNAL_RE.test(value)) pushUnique(found, leak('html_external', field))
  if (NETWORK_API_RE.test(value)) pushUnique(found, leak('network_api', field))
  if (HTML_NAV_RE.test(value)) pushUnique(found, leak('html_navigation', field))
  return found
}

export function scanJsonValue(value: unknown, field: string): TutorialLeak[] {
  const found: TutorialLeak[] = []
  if (typeof value === 'string') return scanText(value, field)
  if (Array.isArray(value)) {
    value.forEach((entry, index) => found.push(...scanJsonValue(entry, `${field}[${index}]`)))
    return found
  }
  if (!value || typeof value !== 'object') return found
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isPrivatePublicReplayField(key)) pushUnique(found, leak('private_field', `${field}.${key}`))
    found.push(...scanJsonValue(child, `${field}.${key}`))
  }
  return found
}

function looksLikeSvg(mime: string, bytes: Buffer): boolean {
  if (mime === 'image/svg+xml' || mime.endsWith('+svg')) return true
  const head = bytes.subarray(0, 256).toString('utf8').trim().toLowerCase()
  return head.startsWith('<svg') || head.includes('<svg ')
}

const TEXTUAL_MIME = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/javascript',
  'text/javascript',
  'text/css',
  'text/html',
  'application/xhtml+xml',
])

const SAFE_BINARY_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/pdf',
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
  'audio/mp4',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'application/zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
])

export function scanArtifactBytes(mime: string, body: Buffer, field: string): TutorialLeak[] {
  const found: TutorialLeak[] = []
  if (looksLikeSvg(mime, body)) {
    found.push(leak('svg_embed_forbidden', field))
    return found
  }
  if (mime === 'text/html' || mime === 'application/xhtml+xml') {
    const text = body.toString('utf8')
    found.push(...scanText(text, field))
    if (/<form\b/i.test(text) || /<iframe\b/i.test(text) || /<object\b/i.test(text)) {
      pushUnique(found, leak('html_external', field))
    }
    return found
  }
  if (TEXTUAL_MIME.has(mime) || mime.startsWith('text/')) {
    let text: string
    try {
      text = body.toString('utf8')
    } catch {
      return [leak('unparseable_artifact', field)]
    }
    if (mime === 'application/json') {
      try {
        found.push(...scanJsonValue(JSON.parse(text), field))
      } catch {
        found.push(...scanText(text, field))
      }
      return found
    }
    return [...found, ...scanText(text, field)]
  }
  if (SAFE_BINARY_MIME.has(mime)) return found
  return [leak('unknown_binary', field)]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sha256Hex(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex')
}

function safeArtifactName(name: string): string | null {
  const base = name.trim().split(/[/\\]/).pop() ?? ''
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(base)) return null
  return base
}

export function sanitizeTutorialSnapshot(input: {
  messages: unknown
  selectedArtifacts?: unknown
}): SnapshotSanitizeOk | SnapshotSanitizeFail {
  const leaks: TutorialLeak[] = []
  if (!Array.isArray(input.messages)) {
    return { ok: false, leakReport: { leaks: [leak('unparseable_artifact', 'messages')] } }
  }
  if (input.messages.length === 0 || input.messages.length > SNAPSHOT_MAX_MESSAGES) {
    return {
      ok: false,
      leakReport: { leaks: [leak('unparseable_artifact', 'messages.length')] },
    }
  }

  const selected = Array.isArray(input.selectedArtifacts) ? input.selectedArtifacts : []
  if (selected.length > SNAPSHOT_MAX_ARTIFACTS) {
    leaks.push(leak('unparseable_artifact', 'selectedArtifacts.length'))
  }

  const blobs: TutorialBlobDraft[] = []
  const artifactManifest: PublicSnapshotManifest['artifacts'] = []
  const selectedNames = new Set<string>()
  let totalArtifactBytes = 0

  selected.forEach((raw, index) => {
    const field = `selectedArtifacts[${index}]`
    if (!isRecord(raw)) {
      leaks.push(leak('unparseable_artifact', field))
      return
    }
    const name = typeof raw.name === 'string' ? safeArtifactName(raw.name) : null
    const mimeType =
      typeof raw.mimeType === 'string' ? normalizeTutorialMime(raw.mimeType) : ''
    const contentBase64 = typeof raw.contentBase64 === 'string' ? raw.contentBase64 : ''
    if (!name || !mimeType || !contentBase64) {
      leaks.push(leak('unparseable_artifact', field))
      return
    }
    const body = decodeCanonicalBase64(contentBase64)
    if (!body) {
      leaks.push(leak('unparseable_artifact', `${field}.base64`))
      return
    }
    if (body.length === 0 || body.length > SNAPSHOT_MAX_ARTIFACT_BYTES) {
      leaks.push(leak('unparseable_artifact', `${field}.bytes`))
      return
    }
    totalArtifactBytes += body.length
    if (totalArtifactBytes > SNAPSHOT_MAX_TOTAL_ARTIFACT_BYTES) {
      leaks.push(leak('unparseable_artifact', 'selectedArtifacts.bytes'))
      return
    }
    leaks.push(...scanArtifactBytes(mimeType, body, field))
    if (mimeType === 'text/html' && body.length > SNAPSHOT_MAX_HTML_BYTES) {
      leaks.push(leak('unparseable_artifact', `${field}.bytes`))
    }
    selectedNames.add(name)
    const kind =
      mimeType === 'text/html'
        ? 'htmlpreview'
        : mimeType.startsWith('image/') || mimeType.startsWith('audio/') || mimeType.startsWith('video/')
          ? 'media'
          : 'artifact'
    const digest = sha256Hex(body)
    const role = `${kind}:${name}`
    blobs.push({
      sha256: digest,
      kind,
      mime: mimeType,
      bytes: body.length,
      body,
      role,
      title: name,
    })
    artifactManifest.push({
      title: name,
      role,
      sha256: digest,
      bytes: body.length,
      mimeType,
    })
  })

  const messages: SanitizedPublicMessage[] = []
  let previousTs = 0
  const allowedInputFields = new Set(['id', 'role', 'text', 'ts'])
  input.messages.forEach((raw, index) => {
    const field = `messages[${index}]`
    if (!isRecord(raw)) {
      leaks.push(leak('unparseable_artifact', field))
      return
    }
    const role = typeof raw.role === 'string' ? raw.role : ''
    if (STRIP_ROLE_SET.has(role)) return
    if (!PUBLIC_ROLE_SET.has(role)) {
      leaks.push(leak('private_field', `${field}.role`))
      return
    }
    for (const key of Object.keys(raw)) {
      if (!allowedInputFields.has(key) || isPrivatePublicReplayField(key)) {
        leaks.push(leak('private_field', `${field}.${key}`))
      }
    }
    if (typeof raw.text !== 'string' || raw.text.length > SNAPSHOT_MAX_MESSAGE_CHARS) {
      leaks.push(leak('unparseable_artifact', `${field}.text`))
      return
    }
    const textLeaks = scanText(raw.text, `${field}.text`)
    if (raw.text.includes('/home/agent/.openclaude/generated/') && selectedNames.size === 0) {
      textLeaks.push(leak('unselected_artifact', `${field}.text`))
    }
    if (role === 'thinking' || role === 'tool') {
      if (textLeaks.length > 0) return
    } else {
      leaks.push(...textLeaks)
    }
    const ts =
      typeof raw.ts === 'number' && Number.isFinite(raw.ts) && raw.ts >= 0 ? raw.ts : previousTs + 1
    previousTs = ts
    messages.push({
      id: `tutorial-${messages.length + 1}`,
      role: role as PublicTutorialRole,
      text: raw.text,
      ts,
    })
  })

  if (messages.length < 1) leaks.push(leak('unparseable_artifact', 'messages'))
  if (leaks.length > 0) return { ok: false, leakReport: { leaks } }

  const messageBlobs: TutorialBlobDraft[] = []
  const pages: PublicSnapshotManifest['pages'] = []
  for (let startOrdinal = 0; startOrdinal < messages.length; startOrdinal += SNAPSHOT_MESSAGE_PAGE_SIZE) {
    const pageIndex = pages.length
    const pageMessages = messages.slice(startOrdinal, startOrdinal + SNAPSHOT_MESSAGE_PAGE_SIZE)
    const role = `messages:${String(pageIndex + 1).padStart(4, '0')}`
    const pageBody = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        pageIndex,
        startOrdinal,
        messages: pageMessages,
      }),
      'utf8',
    )
    const pageSha = sha256Hex(pageBody)
    messageBlobs.push({
      sha256: pageSha,
      kind: 'messages',
      mime: 'application/json',
      bytes: pageBody.length,
      body: pageBody,
      role,
      title: `${role.replace(':', '-')}.json`,
    })
    pages.push({
      role,
      sha256: pageSha,
      bytes: pageBody.length,
      messageCount: pageMessages.length,
      startOrdinal,
    })
  }
  blobs.unshift(...messageBlobs)

  const manifest: PublicSnapshotManifest = {
    schemaVersion: 1,
    sanitizerVersion: TUTORIAL_SANITIZER_VERSION,
    messageCount: messages.length,
    pages,
    artifacts: artifactManifest,
  }
  return {
    ok: true,
    sanitizerVersion: TUTORIAL_SANITIZER_VERSION,
    manifest,
    messages,
    blobs,
  }
}

export function scanMarkdownBody(body: string, field = 'bodyMarkdown'): TutorialLeak[] {
  return scanText(body, field)
}

export function leakReportPublic(leaks: TutorialLeak[]): { leaks: TutorialLeak[] } {
  return { leaks: leaks.map((row) => ({ rule: row.rule, field: row.field })) }
}
