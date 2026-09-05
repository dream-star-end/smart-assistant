import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const MANIFEST_VERSION = 1
const SHA256_RE = /^[0-9a-f]{64}$/i
const SUPPORTED_OS = new Set(['windows', 'linux', 'darwin'])
const SUPPORTED_ARCH = new Set(['x64', 'arm64'])

export class ManifestError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ManifestError'
    this.code = code
  }
}

export function defaultBakeManifestPath() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../runtime-manifest.json')
}

function parseArtifact(raw, index) {
  if (!raw || typeof raw !== 'object') {
    throw new ManifestError('INVALID_ARTIFACT', `artifacts[${index}] must be an object`)
  }
  if (raw.engine && raw.engine !== 'ccb') {
    throw new ManifestError('ENGINE_NOT_CCB', `artifacts[${index}] engine must be ccb`)
  }
  if (!SUPPORTED_OS.has(raw.os)) {
    throw new ManifestError('OS_ARCH_MISMATCH', `artifacts[${index}] os=${raw.os} is not supported`)
  }
  if (!SUPPORTED_ARCH.has(raw.arch)) {
    throw new ManifestError('OS_ARCH_MISMATCH', `artifacts[${index}] arch=${raw.arch} is not supported`)
  }
  if (typeof raw.url !== 'string' || !raw.url.startsWith('https://')) {
    throw new ManifestError('NON_HTTPS_URL', `artifacts[${index}] url must be https`)
  }
  if (typeof raw.sha256 !== 'string' || !SHA256_RE.test(raw.sha256)) {
    throw new ManifestError('INVALID_SHA256', `artifacts[${index}] sha256 must be 64 hex`)
  }
  return {
    os: raw.os,
    arch: raw.arch,
    url: raw.url,
    sha256: raw.sha256.toLowerCase(),
    size: typeof raw.size === 'number' ? raw.size : undefined,
    version: typeof raw.version === 'string' ? raw.version : undefined,
  }
}

export function publicOriginFromHttpsUrl(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new ManifestError('NON_HTTPS_URL', 'url must be https')
  }
  if (parsed.protocol !== 'https:') {
    throw new ManifestError('NON_HTTPS_URL', 'url must be https')
  }
  return parsed.origin
}

export function assertArtifactsSharePublicOrigin(artifacts, publicOrigin) {
  const expected = publicOriginFromHttpsUrl(publicOrigin)
  for (const [index, item] of artifacts.entries()) {
    const origin = publicOriginFromHttpsUrl(item.url)
    if (origin !== expected) {
      throw new ManifestError('ORIGIN_MISMATCH', `artifacts[${index}] origin ${origin} != ${expected}`)
    }
  }
  return expected
}

export function parseRuntimeManifest(raw, { expectedOs, expectedArch } = {}) {
  const doc = typeof raw === 'string' ? JSON.parse(raw) : raw
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new ManifestError('INVALID_MANIFEST', 'manifest must be an object')
  }
  if (doc.v !== MANIFEST_VERSION) {
    throw new ManifestError('INVALID_MANIFEST', `unsupported manifest v=${doc.v}`)
  }
  if (doc.engine !== 'ccb') {
    throw new ManifestError('ENGINE_NOT_CCB', 'engine must be ccb')
  }
  if (!Array.isArray(doc.artifacts) || doc.artifacts.length === 0) {
    throw new ManifestError('INVALID_MANIFEST', 'artifacts required')
  }
  const artifacts = doc.artifacts.map((item, i) => parseArtifact(item, i))
  const os = expectedOs || process.platform
  const arch = expectedArch || process.arch
  const mappedOs = os === 'win32' ? 'windows' : os
  const selected = artifacts.find((item) => item.os === mappedOs && item.arch === arch)
  if (!selected) {
    throw new ManifestError('OS_ARCH_MISMATCH', `no ccb artifact for ${mappedOs}/${arch}`)
  }
  assertArtifactsSharePublicOrigin(artifacts, artifacts[0].url)
  return {
    v: doc.v,
    engine: doc.engine,
    min_version: typeof doc.min_version === 'string' ? doc.min_version : '',
    keyring_fp: typeof doc.keyring_fp === 'string' ? doc.keyring_fp : '',
    artifacts,
    selected,
  }
}

export function overlayArtifact(manifest, overlay = {}) {
  const selected = { ...manifest.selected }
  if (overlay.url != null) {
    if (typeof overlay.url !== 'string' || !overlay.url.startsWith('https://')) {
      throw new ManifestError('NON_HTTPS_URL', 'overlay url must be https')
    }
    selected.url = overlay.url
  }
  if (overlay.sha256 != null) {
    if (typeof overlay.sha256 !== 'string' || !SHA256_RE.test(overlay.sha256)) {
      throw new ManifestError('INVALID_SHA256', 'overlay sha256 must be 64 hex')
    }
    selected.sha256 = overlay.sha256.toLowerCase()
  }
  return { ...manifest, selected }
}

export function applyManifestEnvOverlay(manifest, env = process.env) {
  return overlayArtifact(manifest, {
    ...(env.OC_RUNTIME_ARTIFACT_URL ? { url: env.OC_RUNTIME_ARTIFACT_URL } : {}),
    ...(env.OC_RUNTIME_ARTIFACT_SHA256 ? { sha256: env.OC_RUNTIME_ARTIFACT_SHA256 } : {}),
  })
}

export function loadRuntimeManifest(filePath = defaultBakeManifestPath(), opts = {}) {
  const raw = readFileSync(filePath, 'utf8')
  const parsed = parseRuntimeManifest(raw, opts)
  return applyManifestEnvOverlay(parsed, opts.env || process.env)
}
