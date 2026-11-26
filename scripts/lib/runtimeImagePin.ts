/**
 * Declarative Runtime Image & Agent CLI Version Pin Loader/Validator (OCV5-904).
 *
 * Separates routine runtime image / CLI version pin bumps from the A0-protected
 * `scripts/deploy-v5-selfhost.sh` deploy script. Because `deploy/v5/runtime-image-pin.json`
 * is an A1 auto-pass surface, this validator enforces strict schema & supply-chain
 * constraints:
 *   - `schemaVersion === 1`
 *   - `runtimeImage` (and optional `previousRuntimeImage`) must use an allowed
 *     `openclaude/` repository prefix with an explicit immutable tag (never `:latest`)
 *   - zero shell metacharacters in any string field so bash (`jq`) consumers stay safe
 *   - valid `cliVersions` map, optional `capabilities`, `ticket`, and ISO `updatedAt`
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

export const RUNTIME_IMAGE_PIN_PATH = 'deploy/v5/runtime-image-pin.json'
export const DEFAULT_ALLOWED_IMAGE_PREFIXES = ['openclaude/openclaude-runtime:'] as const

export interface RuntimeImagePin {
  schemaVersion: 1
  channel: string
  runtimeImage: string
  previousRuntimeImage?: string
  ticket?: string
  updatedAt?: string
  cliVersions: Record<string, string>
  capabilities?: Record<string, string | string[]>
  note?: string
}

export type RuntimeImagePinValidationResult =
  | { ok: true; pin: RuntimeImagePin; errors: [] }
  | { ok: false; errors: string[] }

export interface ValidateRuntimeImagePinOptions {
  allowedImagePrefixes?: readonly string[]
}

const CHANNEL_RE = /^[a-z0-9][a-z0-9-]{1,63}$/
const DOCKER_REF_RE = /^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?:@sha256:[0-9a-f]{64})?$/
const CLI_KEY_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/
const TICKET_RE = /^OCV5-\d+$/
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const SHELL_META_RE = /[`$;&|<>()\\\r\n'"*?[\]{}!~]/

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isValidIsoDate(s: string): boolean {
  if (!ISO_DATE_RE.test(s)) return false
  const ms = Date.parse(`${s}T00:00:00Z`)
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === s
}

function validateDockerImageRef(
  field: string,
  value: unknown,
  allowedPrefixes: readonly string[],
  errors: string[],
): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push(`${field} must be a non-empty string`)
    return
  }
  if (value !== value.trim() || SHELL_META_RE.test(value)) {
    errors.push(`${field} contains forbidden whitespace or shell metacharacters`)
    return
  }
  if (!DOCKER_REF_RE.test(value)) {
    errors.push(`${field} must be a tagged Docker image ref (<repo>:<tag>[@sha256:...]): got "${value}"`)
    return
  }
  const tagPart = value.split(':')[1]?.split('@')[0] ?? ''
  if (tagPart.toLowerCase() === 'latest') {
    errors.push(`${field} must pin an explicit immutable tag, never ":latest"`)
  }
  if (allowedPrefixes.length > 0 && !allowedPrefixes.some((p) => value.startsWith(p))) {
    errors.push(
      `${field} must start with an allowed image prefix (${allowedPrefixes.join(', ')}): got "${value}"`,
    )
  }
}

export function validateRuntimeImagePin(
  raw: unknown,
  options?: ValidateRuntimeImagePinOptions,
): RuntimeImagePinValidationResult {
  const errors: string[] = []
  const allowedPrefixes = options?.allowedImagePrefixes ?? DEFAULT_ALLOWED_IMAGE_PREFIXES

  if (!isPlainObject(raw)) {
    return { ok: false, errors: ['runtime-image-pin must be a JSON object'] }
  }

  if (raw.schemaVersion !== 1) {
    errors.push(`schemaVersion must be 1 (got ${JSON.stringify(raw.schemaVersion)})`)
  }

  if (typeof raw.channel !== 'string' || !CHANNEL_RE.test(raw.channel)) {
    errors.push(`channel must match ${CHANNEL_RE.source} (got ${JSON.stringify(raw.channel)})`)
  }

  validateDockerImageRef('runtimeImage', raw.runtimeImage, allowedPrefixes, errors)

  if (raw.previousRuntimeImage !== undefined) {
    validateDockerImageRef(
      'previousRuntimeImage',
      raw.previousRuntimeImage,
      allowedPrefixes,
      errors,
    )
  }

  if (raw.ticket !== undefined && (typeof raw.ticket !== 'string' || !TICKET_RE.test(raw.ticket))) {
    errors.push(`ticket must match OCV5-<number> (got ${JSON.stringify(raw.ticket)})`)
  }

  if (
    raw.updatedAt !== undefined &&
    (typeof raw.updatedAt !== 'string' || !isValidIsoDate(raw.updatedAt))
  ) {
    errors.push(`updatedAt must be a valid YYYY-MM-DD date (got ${JSON.stringify(raw.updatedAt)})`)
  }

  if (!isPlainObject(raw.cliVersions)) {
    errors.push('cliVersions must be a non-empty JSON object mapping CLI name to version string')
  } else {
    const entries = Object.entries(raw.cliVersions)
    if (entries.length === 0) {
      errors.push('cliVersions must declare at least one CLI version pin')
    }
    for (const [k, v] of entries) {
      if (!CLI_KEY_RE.test(k)) {
        errors.push(`cliVersions key "${k}" must match ${CLI_KEY_RE.source}`)
      }
      if (typeof v !== 'string' || !VERSION_RE.test(v) || SHELL_META_RE.test(v)) {
        errors.push(`cliVersions.${k} must be a safe version string (got ${JSON.stringify(v)})`)
      }
    }
  }

  if (raw.capabilities !== undefined) {
    if (!isPlainObject(raw.capabilities)) {
      errors.push('capabilities must be a JSON object when provided')
    } else {
      for (const [k, v] of Object.entries(raw.capabilities)) {
        if (!CLI_KEY_RE.test(k)) {
          errors.push(`capabilities key "${k}" must match ${CLI_KEY_RE.source}`)
        }
        if (typeof v === 'string') {
          if (!v.trim() || SHELL_META_RE.test(v)) {
            errors.push(`capabilities.${k} must be a non-empty safe string`)
          }
        } else if (Array.isArray(v)) {
          if (
            v.length === 0 ||
            v.some((item) => typeof item !== 'string' || !item.trim() || SHELL_META_RE.test(item))
          ) {
            errors.push(`capabilities.${k} must be a non-empty array of safe strings`)
          }
        } else {
          errors.push(`capabilities.${k} must be a string or string[]`)
        }
      }
    }
  }

  if (raw.note !== undefined && (typeof raw.note !== 'string' || raw.note.trim().length === 0)) {
    errors.push('note must be a non-empty string when provided')
  }

  if (errors.length > 0) {
    return { ok: false, errors }
  }
  return { ok: true, pin: raw as unknown as RuntimeImagePin, errors: [] }
}

export function loadRuntimeImagePin(
  repoRoot: string,
  relPath = RUNTIME_IMAGE_PIN_PATH,
  options?: ValidateRuntimeImagePinOptions,
): RuntimeImagePin {
  const abs = path.isAbsolute(relPath) ? relPath : path.join(repoRoot, relPath)
  if (!existsSync(abs)) {
    throw new Error(`runtime image pin file not found: ${abs}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(abs, 'utf8'))
  } catch (err) {
    throw new Error(`failed to parse ${relPath} as JSON: ${(err as Error).message}`)
  }
  const res = validateRuntimeImagePin(parsed, options)
  if (!res.ok) {
    throw new Error(`invalid ${relPath}: ${res.errors.join('; ')}`)
  }
  return res.pin
}
