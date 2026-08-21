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
const CREDENTIAL_LABEL_RE =
  /["']?(?:[A-Za-z0-9]+[_-])*(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret)["']?\s*[:=]\s*["']?(?:bearer\s+)?[^\s"'`,;]{8,}/i
const BEARER_SECRET_RE = /\bbearer\s+[A-Za-z0-9._~+\/-]{12,}/i
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
  'image/webp',
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

export type PublicTutorialChildBlock = {
  kind:
    | 'text'
    | 'thinking'
    | 'tool_use'
    | 'tool_result'
    | 'tool_output_tail'
    | 'plan'
    | 'goal'
    | 'error'
    | 'final'
  text?: string
  toolName?: string
  inputPreview?: string
  inputJson?: unknown
  preview?: string
  isError?: boolean
  output?: string
  outputJson?: unknown
  error?: boolean
  childBlocks?: PublicTutorialChildBlock[]
  tail?: string
  totalBytes?: number
  truncatedHead?: boolean
  explanation?: string
  steps?: Array<{ step: string; status: string }>
  objective?: string
  status?: string
}

export type SanitizedPublicMessage = {
  id: string
  role: PublicTutorialRole
  text: string
  ts: number
  _media?: Array<{ kind: string; url: string; mimeType?: string; filename?: string }>
  toolName?: string
  inputPreview?: string
  inputJson?: unknown
  output?: string | null
  outputJson?: unknown
  error?: boolean
  _completed?: boolean
  steps?: Array<{ step: string; status: string }>
  explanation?: string
  goalStatus?: string
  tokenBudget?: number | null
  tokensUsed?: number
  timeUsedSeconds?: number
  childBlocks?: PublicTutorialChildBlock[]
  startTime?: number
  _duration?: number
  _resultPreview?: string
  _isError?: boolean
  _delegateStatus?: 'ok' | 'failed' | 'timeout'
}

export type SelectedTutorialArtifact = {
  name: string
  mimeType: string
  contentBase64: string
  sourcePath: string
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
  if (CREDENTIAL_LABEL_RE.test(value) || BEARER_SECRET_RE.test(value)) {
    pushUnique(found, leak('credential_label', field))
  }
  for (const candidate of value.match(/[A-Za-z0-9+/_=-]{32,}/g) ?? []) {
    if (
      !/^[a-f0-9]{32,}$/i.test(candidate) &&
      /[A-Z]/.test(candidate) &&
      /[a-z]/.test(candidate) &&
      /\d/.test(candidate)
    ) {
      pushUnique(found, leak('high_entropy_secret', field))
      break
    }
  }
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

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_PUBLIC_CHUNKS = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS'])
const WEBP_PUBLIC_CHUNKS = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF'])

function sanitizePng(body: Buffer): Buffer | null {
  if (body.length < 20 || !body.subarray(0, 8).equals(PNG_SIGNATURE)) return null
  const chunks: Buffer[] = [PNG_SIGNATURE]
  let offset = 8
  let sawHeader = false
  let sawEnd = false
  while (offset + 12 <= body.length) {
    const size = body.readUInt32BE(offset)
    const end = offset + 12 + size
    if (end > body.length) return null
    const type = body.subarray(offset + 4, offset + 8).toString('ascii')
    if (!/^[A-Za-z]{4}$/.test(type)) return null
    if (!sawHeader && type !== 'IHDR') return null
    if (type === 'IHDR') sawHeader = true
    if (PNG_PUBLIC_CHUNKS.has(type)) chunks.push(body.subarray(offset, end))
    offset = end
    if (type === 'IEND') {
      sawEnd = true
      break
    }
  }
  return sawHeader && sawEnd && offset === body.length ? Buffer.concat(chunks) : null
}

function sanitizeWebp(body: Buffer): Buffer | null {
  if (
    body.length < 20 ||
    body.subarray(0, 4).toString('ascii') !== 'RIFF' ||
    body.subarray(8, 12).toString('ascii') !== 'WEBP' ||
    body.readUInt32LE(4) + 8 !== body.length
  ) {
    return null
  }
  const chunks: Buffer[] = []
  let offset = 12
  let visual = false
  while (offset + 8 <= body.length) {
    const type = body.subarray(offset, offset + 4).toString('ascii')
    const size = body.readUInt32LE(offset + 4)
    const padded = size + (size % 2)
    const end = offset + 8 + padded
    if (end > body.length) return null
    if (WEBP_PUBLIC_CHUNKS.has(type)) {
      chunks.push(body.subarray(offset, end))
      if (type === 'VP8 ' || type === 'VP8L' || type === 'ANMF') visual = true
    }
    offset = end
  }
  if (offset !== body.length || !visual) return null
  const payload = Buffer.concat(chunks)
  const header = Buffer.alloc(12)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(payload.length + 4, 4)
  header.write('WEBP', 8, 'ascii')
  return Buffer.concat([header, payload])
}

function sanitizeBinaryArtifact(mime: string, body: Buffer): Buffer | null {
  if (mime === 'image/png') return sanitizePng(body)
  if (mime === 'image/webp') return sanitizeWebp(body)
  return null
}

function sanitizedArtifactBody(
  mime: string,
  body: Buffer,
  field: string,
): { body: Buffer; leaks: TutorialLeak[] } {
  if (TEXTUAL_MIME.has(mime) || mime.startsWith('text/')) {
    return { body, leaks: scanArtifactBytes(mime, body, field) }
  }
  const sanitized = sanitizeBinaryArtifact(mime, body)
  if (!sanitized) {
    return {
      body,
      leaks: [
        leak(PASSIVE_EMBED_MIMES.has(mime) ? 'mime_mismatch' : 'metadata_unsupported', field),
      ],
    }
  }
  return { body: sanitized, leaks: [] }
}

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
  const sanitized = sanitizeBinaryArtifact(mime, body)
  if (sanitized) return found
  if (PASSIVE_EMBED_MIMES.has(mime)) return [leak('mime_mismatch', field)]
  return [leak('metadata_unsupported', field)]
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

const GENERATED_ARTIFACT_PATH_RE =
  /\/home\/agent\/\.openclaude\/generated\/[A-Za-z0-9._@+=,/-]*[A-Za-z0-9]/g

function safeArtifactSourcePath(value: string): string | null {
  const normalized = value.trim()
  if (!normalized.startsWith('/home/agent/.openclaude/generated/')) return null
  if (normalized.includes('\0') || normalized.split('/').includes('..')) return null
  return /^\/home\/agent\/\.openclaude\/generated\/[A-Za-z0-9._@+=,/-]{1,300}$/.test(
    normalized,
  )
    ? normalized
    : null
}

const PUBLIC_CHILD_KINDS = new Set<PublicTutorialChildBlock['kind']>([
  'text',
  'thinking',
  'tool_use',
  'tool_result',
  'tool_output_tail',
  'plan',
  'goal',
  'error',
  'final',
])
const STRUCTURED_VALUE_MAX_BYTES = 200_000

function rewriteSelectedArtifactPaths(
  value: unknown,
  selectedPaths: ReadonlyMap<string, { title: string; role: string }>,
  depth = 0,
): unknown {
  if (depth > 12) return null
  if (typeof value === 'string') {
    let rewritten = value
    for (const [sourcePath, artifact] of selectedPaths) {
      rewritten = rewritten.split(sourcePath).join(`成果「${artifact.title}」`)
    }
    return rewritten
  }
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((entry) => rewriteSelectedArtifactPaths(entry, selectedPaths, depth + 1))
  }
  if (!value || typeof value !== 'object') return value
  const output: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 200)) {
    if (isPrivatePublicReplayField(key)) continue
    output[key] = rewriteSelectedArtifactPaths(child, selectedPaths, depth + 1)
  }
  return output
}

function boundedPublicJson(
  value: unknown,
  field: string,
  selectedPaths: ReadonlyMap<string, { title: string; role: string }>,
): { value: unknown; leaks: TutorialLeak[] } {
  const rewritten = rewriteSelectedArtifactPaths(value, selectedPaths)
  let encoded: string
  try {
    encoded = JSON.stringify(rewritten)
  } catch {
    return { value: null, leaks: [leak('unparseable_artifact', field)] }
  }
  if (Buffer.byteLength(encoded) > STRUCTURED_VALUE_MAX_BYTES) {
    return { value: null, leaks: [leak('unparseable_artifact', field)] }
  }
  return { value: rewritten, leaks: scanJsonValue(rewritten, field) }
}

function sanitizePublicSteps(
  value: unknown,
  field: string,
  selectedPaths: ReadonlyMap<string, { title: string; role: string }>,
): { value: Array<{ step: string; status: string }>; leaks: TutorialLeak[] } {
  const output: Array<{ step: string; status: string }> = []
  const leaks: TutorialLeak[] = []
  if (!Array.isArray(value) || value.length > 100) {
    return { value: output, leaks: [leak('unparseable_artifact', field)] }
  }
  for (const [index, raw] of value.entries()) {
    if (!isRecord(raw) || typeof raw.step !== 'string' || typeof raw.status !== 'string') {
      leaks.push(leak('unparseable_artifact', `${field}[${index}]`))
      continue
    }
    const step = rewriteSelectedArtifactPaths(raw.step, selectedPaths) as string
    if (step.length > SNAPSHOT_MAX_MESSAGE_CHARS || raw.status.length > 40) {
      leaks.push(leak('unparseable_artifact', `${field}[${index}]`))
      continue
    }
    leaks.push(...scanText(step, `${field}[${index}].step`))
    leaks.push(...scanText(raw.status, `${field}[${index}].status`))
    output.push({ step, status: raw.status })
  }
  return { value: output, leaks }
}

function sanitizePublicChildBlock(
  raw: unknown,
  field: string,
  selectedPaths: ReadonlyMap<string, { title: string; role: string }>,
  depth = 0,
): PublicTutorialChildBlock | null {
  if (depth > 4 || !isRecord(raw) || !PUBLIC_CHILD_KINDS.has(raw.kind as PublicTutorialChildBlock['kind'])) {
    return null
  }
  const output: PublicTutorialChildBlock = { kind: raw.kind as PublicTutorialChildBlock['kind'] }
  const stringKeys = [
    'text',
    'toolName',
    'inputPreview',
    'preview',
    'output',
    'tail',
    'explanation',
    'objective',
    'status',
  ] as const
  for (const key of stringKeys) {
    if (raw[key] === undefined) continue
    if (typeof raw[key] !== 'string' || raw[key].length > SNAPSHOT_MAX_MESSAGE_CHARS) return null
    const value = rewriteSelectedArtifactPaths(raw[key], selectedPaths) as string
    if (scanText(value, `${field}.${key}`).length > 0) return null
    ;(output as Record<string, unknown>)[key] = value
  }
  for (const key of ['inputJson', 'outputJson'] as const) {
    if (raw[key] === undefined) continue
    const value = boundedPublicJson(raw[key], `${field}.${key}`, selectedPaths)
    if (value.leaks.length > 0) return null
    output[key] = value.value
  }
  for (const key of ['isError', 'error', 'truncatedHead'] as const) {
    if (typeof raw[key] === 'boolean') output[key] = raw[key]
  }
  if (typeof raw.totalBytes === 'number' && Number.isSafeInteger(raw.totalBytes) && raw.totalBytes >= 0) {
    output.totalBytes = raw.totalBytes
  }
  if (raw.steps !== undefined) {
    const steps = sanitizePublicSteps(raw.steps, `${field}.steps`, selectedPaths)
    if (steps.leaks.length > 0) return null
    output.steps = steps.value
  }
  if (Array.isArray(raw.childBlocks)) {
    output.childBlocks = raw.childBlocks
      .slice(0, 200)
      .map((child, index) =>
        sanitizePublicChildBlock(child, `${field}.childBlocks[${index}]`, selectedPaths, depth + 1),
      )
      .filter((child): child is PublicTutorialChildBlock => child !== null)
  }
  return output
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
  const selectedPaths = new Map<string, { title: string; role: string }>()
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
    const sourcePath =
      typeof raw.sourcePath === 'string' ? safeArtifactSourcePath(raw.sourcePath) : null
    if (!name || !mimeType || !contentBase64 || !sourcePath) {
      leaks.push(leak('unparseable_artifact', field))
      return
    }
    const decodedBody = decodeCanonicalBase64(contentBase64)
    if (!decodedBody) {
      leaks.push(leak('unparseable_artifact', `${field}.base64`))
      return
    }
    if (decodedBody.length === 0 || decodedBody.length > SNAPSHOT_MAX_ARTIFACT_BYTES) {
      leaks.push(leak('unparseable_artifact', `${field}.bytes`))
      return
    }
    totalArtifactBytes += decodedBody.length
    if (totalArtifactBytes > SNAPSHOT_MAX_TOTAL_ARTIFACT_BYTES) {
      leaks.push(leak('unparseable_artifact', 'selectedArtifacts.bytes'))
      return
    }
    const artifact = sanitizedArtifactBody(mimeType, decodedBody, field)
    leaks.push(...artifact.leaks)
    const body = artifact.body
    if (mimeType === 'text/html' && decodedBody.length > SNAPSHOT_MAX_HTML_BYTES) {
      leaks.push(leak('unparseable_artifact', `${field}.bytes`))
    }
    const kind =
      mimeType === 'text/html'
        ? 'htmlpreview'
        : mimeType.startsWith('image/') || mimeType.startsWith('audio/') || mimeType.startsWith('video/')
          ? 'media'
          : 'artifact'
    const digest = sha256Hex(body)
    const role = `${kind}:${name}`
    selectedPaths.set(sourcePath, { title: name, role })
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
  const richFieldsByRole: Record<string, readonly string[]> = {
    tool: [
      'toolName',
      'inputPreview',
      'inputJson',
      'output',
      'outputJson',
      'error',
      '_completed',
    ],
    plan: ['explanation', 'steps'],
    goal: ['goalStatus', 'tokenBudget', 'tokensUsed', 'timeUsedSeconds'],
    'agent-group': [
      'startTime',
      'childBlocks',
      '_duration',
      '_resultPreview',
      '_isError',
      '_delegateStatus',
    ],
  }
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
    const allowedInputFields = new Set(['id', 'role', 'text', 'ts', ...(richFieldsByRole[role] ?? [])])
    for (const key of Object.keys(raw)) {
      if (!allowedInputFields.has(key) || isPrivatePublicReplayField(key)) {
        leaks.push(leak('private_field', `${field}.${key}`))
      }
    }
    if (typeof raw.text !== 'string' || raw.text.length > SNAPSHOT_MAX_MESSAGE_CHARS) {
      leaks.push(leak('unparseable_artifact', `${field}.text`))
      return
    }
    let publicText = raw.text
    for (const [sourcePath, artifact] of selectedPaths) {
      publicText = publicText.split(sourcePath).join(`成果「${artifact.title}」`)
    }
    const textLeaks = scanText(publicText, `${field}.text`)
    for (const path of raw.text.match(GENERATED_ARTIFACT_PATH_RE) ?? []) {
      if (!selectedPaths.has(path)) textLeaks.push(leak('unselected_artifact', `${field}.text`))
    }
    if (role === 'thinking' || role === 'tool') {
      if (textLeaks.length > 0) return
    } else {
      leaks.push(...textLeaks)
    }
    const ts =
      typeof raw.ts === 'number' && Number.isFinite(raw.ts) && raw.ts >= 0 ? raw.ts : previousTs + 1
    previousTs = ts
    const publicMessage: SanitizedPublicMessage = {
      id: `tutorial-${messages.length + 1}`,
      role: role as PublicTutorialRole,
      text: publicText,
      ts,
    }

    const structuredLeaks: TutorialLeak[] = []
    if (role === 'tool') {
      for (const key of ['toolName', 'inputPreview', 'output'] as const) {
        const rawValue = raw[key]
        if (rawValue === undefined || rawValue === null) {
          if (key === 'output' && rawValue === null) publicMessage.output = null
          continue
        }
        if (typeof rawValue !== 'string' || rawValue.length > SNAPSHOT_MAX_MESSAGE_CHARS) {
          structuredLeaks.push(leak('unparseable_artifact', `${field}.${key}`))
          continue
        }
        const value = rewriteSelectedArtifactPaths(rawValue, selectedPaths) as string
        structuredLeaks.push(...scanText(value, `${field}.${key}`))
        publicMessage[key] = value
      }
      for (const key of ['inputJson', 'outputJson'] as const) {
        if (raw[key] === undefined) continue
        const value = boundedPublicJson(raw[key], `${field}.${key}`, selectedPaths)
        structuredLeaks.push(...value.leaks)
        publicMessage[key] = value.value
      }
      if (typeof raw.error === 'boolean') publicMessage.error = raw.error
      if (typeof raw._completed === 'boolean') publicMessage._completed = raw._completed
    } else if (role === 'plan') {
      if (raw.explanation !== undefined) {
        if (typeof raw.explanation !== 'string' || raw.explanation.length > SNAPSHOT_MAX_MESSAGE_CHARS) {
          structuredLeaks.push(leak('unparseable_artifact', `${field}.explanation`))
        } else {
          const explanation = rewriteSelectedArtifactPaths(raw.explanation, selectedPaths) as string
          structuredLeaks.push(...scanText(explanation, `${field}.explanation`))
          publicMessage.explanation = explanation
        }
      }
      if (raw.steps !== undefined) {
        const steps = sanitizePublicSteps(raw.steps, `${field}.steps`, selectedPaths)
        structuredLeaks.push(...steps.leaks)
        publicMessage.steps = steps.value
      }
    } else if (role === 'goal') {
      if (raw.goalStatus !== undefined) {
        if (typeof raw.goalStatus !== 'string' || raw.goalStatus.length > 40) {
          structuredLeaks.push(leak('unparseable_artifact', `${field}.goalStatus`))
        } else {
          structuredLeaks.push(...scanText(raw.goalStatus, `${field}.goalStatus`))
          publicMessage.goalStatus = raw.goalStatus
        }
      }
      if (raw.tokenBudget === null) publicMessage.tokenBudget = null
      else if (typeof raw.tokenBudget === 'number' && Number.isFinite(raw.tokenBudget)) {
        publicMessage.tokenBudget = raw.tokenBudget
      }
      if (typeof raw.tokensUsed === 'number' && Number.isFinite(raw.tokensUsed)) {
        publicMessage.tokensUsed = raw.tokensUsed
      }
      if (typeof raw.timeUsedSeconds === 'number' && Number.isFinite(raw.timeUsedSeconds)) {
        publicMessage.timeUsedSeconds = raw.timeUsedSeconds
      }
    } else if (role === 'agent-group') {
      if (Array.isArray(raw.childBlocks)) {
        publicMessage.childBlocks = raw.childBlocks
          .slice(0, 200)
          .map((child, childIndex) =>
            sanitizePublicChildBlock(
              child,
              `${field}.childBlocks[${childIndex}]`,
              selectedPaths,
            ),
          )
          .filter((child): child is PublicTutorialChildBlock => child !== null)
      }
      for (const key of ['startTime', '_duration'] as const) {
        if (typeof raw[key] === 'number' && Number.isFinite(raw[key])) publicMessage[key] = raw[key]
      }
      if (typeof raw._resultPreview === 'string') {
        const preview = rewriteSelectedArtifactPaths(raw._resultPreview, selectedPaths) as string
        structuredLeaks.push(...scanText(preview, `${field}._resultPreview`))
        publicMessage._resultPreview = preview.slice(0, SNAPSHOT_MAX_MESSAGE_CHARS)
      }
      if (typeof raw._isError === 'boolean') publicMessage._isError = raw._isError
      if (raw._delegateStatus === 'ok' || raw._delegateStatus === 'failed' || raw._delegateStatus === 'timeout') {
        publicMessage._delegateStatus = raw._delegateStatus
      }
    }

    if (structuredLeaks.length > 0 && (role === 'tool' || role === 'agent-group')) return
    leaks.push(...structuredLeaks)
    messages.push(publicMessage)
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
