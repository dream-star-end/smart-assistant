/**
 * GET /api/desktop/bootstrap (anonymous) and GET /api/desktop/runtime-manifest
 * (JWT or 18445 device mTLS). Design v2 §4.3 / §6.2 / §6.3.
 */

import { promises as fs } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { verifyCommercialJwtSync } from '../auth/jwtSync.js'
import { authorityKeyringProvider } from '../billing/modelCatalogRuntime.js'
import { loadDesktopOriginMaterialIfPresent, originSpkiPinBase64 } from '../desktop/deviceCa.js'
import { type DesktopFlagSnapshot, getDesktopFlagSnapshot } from '../desktop/flags.js'
import { desktopKeyringFpFrom, hashEmptyKeyring } from '../desktop/keyringFp.js'
import {
  formatDesktopHostForUrl,
  readDesktopMinAppVersion,
  readDesktopPublicEgressPort,
  readDesktopPublicHost,
  readDesktopPublicTlsPort,
  readDesktopRuntimeManifestPath,
} from '../desktop/publicHost.js'
import { extractDesktopTlsContext } from '../desktop/tlsContext.js'
import type { RateLimitConfig } from '../middleware/rateLimit.js'
import { getBearerToken } from './authHelpers.js'
import { type CommercialHttpDeps, type RequestContext, enforceRateLimit } from './handlers.js'
import { HttpError, sendJson } from './util.js'

export const DESKTOP_BOOTSTRAP_RATE_LIMITS = {
  bootstrapIp: { scope: 'desktop_bootstrap', windowSeconds: 60, max: 60 } satisfies RateLimitConfig,
}

const MANIFEST_CACHE_MS = 60_000
const SHA256_RE = /^[0-9a-f]{64}$/

export interface DesktopRuntimeArtifact {
  os: 'windows'
  arch: 'x64'
  url: string
  sha256: string
  size: number
  version: string
}

export interface DesktopRuntimeManifest {
  v: 1
  engine: 'ccb'
  min_version: string
  keyring_fp: string
  artifacts: DesktopRuntimeArtifact[]
}

interface ManifestCache {
  path: string
  loadedAt: number
  value: Omit<DesktopRuntimeManifest, 'keyring_fp'>
}

let manifestCache: ManifestCache | null = null

export function resetDesktopRuntimeManifestCacheForTest(): void {
  manifestCache = null
}

async function requireAssembled(flags: DesktopFlagSnapshot): Promise<void> {
  if (!flags.assembled) {
    throw new HttpError(404, 'NOT_FOUND', 'not found')
  }
}

async function requireNotKilled(flags: DesktopFlagSnapshot): Promise<void> {
  if (flags.killSwitch) {
    throw new HttpError(503, 'DESKTOP_KILLSWITCH', 'desktop runtime temporarily unavailable')
  }
}

function publicWebOrigin(deps: CommercialHttpDeps): string {
  const base = deps.verifyEmailUrlBase ?? process.env.OPENCLAUDE_PUBLIC_ORIGIN ?? ''
  try {
    if (base) return new URL(base).origin
  } catch {
    /* ignore */
  }
  return 'https://claudeai.chat'
}

function liveKeyringFp(): string {
  try {
    return desktopKeyringFpFrom(authorityKeyringProvider()())
  } catch {
    return hashEmptyKeyring()
  }
}

/** Exported so tests can pin against the same function register_ok uses. */
function authorizeRuntimeManifest(req: IncomingMessage, deps: CommercialHttpDeps): void {
  const tls = deps.desktopPeerCert
    ? extractDesktopTlsContext(req, { peerCert: deps.desktopPeerCert })
    : extractDesktopTlsContext(req)
  if (tls) return
  const token = getBearerToken(req)
  const claims = token ? verifyCommercialJwtSync(token, deps.jwtSecret) : null
  if (claims) return
  throw new HttpError(401, 'UNAUTHORIZED', 'login required')
}

export async function handleDesktopBootstrap(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const flags = await getDesktopFlagSnapshot()
  await requireAssembled(flags)
  await requireNotKilled(flags)
  await enforceRateLimit(deps, DESKTOP_BOOTSTRAP_RATE_LIMITS.bootstrapIp, ctx.clientIp)

  const host = readDesktopPublicHost()
  if (!host) {
    throw new HttpError(
      503,
      'DESKTOP_BOOTSTRAP_UNCONFIGURED',
      'desktop public host is not configured',
    )
  }
  const material = await loadDesktopOriginMaterialIfPresent()
  if (!material) {
    throw new HttpError(
      503,
      'DESKTOP_BOOTSTRAP_UNCONFIGURED',
      'desktop origin material is not present',
    )
  }

  const hostUrl = formatDesktopHostForUrl(host)
  const masterPort = readDesktopPublicTlsPort()
  const egressPort = readDesktopPublicEgressPort()
  const pin = await originSpkiPinBase64(material.certPem)
  const origin = publicWebOrigin(deps).replace(/\/+$/, '')

  sendJson(
    res,
    200,
    {
      v: 1,
      register_wss: `wss://${hostUrl}:${masterPort}/ws/desktop-container-register`,
      master_https: `https://${hostUrl}:${masterPort}`,
      egress_https: `https://${hostUrl}:${egressPort}`,
      device_ca_pem: `${material.caCertPem.trim()}\n`,
      origin_spki_pin: pin,
      runtime_manifest_url: `${origin}/api/desktop/runtime-manifest`,
      min_app_version: readDesktopMinAppVersion(),
    },
    { 'Cache-Control': 'public, max-age=300' },
  )
}

function isHttpsUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    return u.protocol === 'https:'
  } catch {
    return false
  }
}

export function parseDesktopRuntimeManifestJson(
  raw: unknown,
): Omit<DesktopRuntimeManifest, 'keyring_fp'> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new HttpError(503, 'RUNTIME_MANIFEST_INVALID', 'runtime manifest schema invalid')
  }
  const obj = raw as Record<string, unknown>
  if (obj.v !== 1) {
    throw new HttpError(503, 'RUNTIME_MANIFEST_INVALID', 'runtime manifest schema invalid')
  }
  if (obj.engine !== 'ccb') {
    throw new HttpError(503, 'RUNTIME_MANIFEST_INVALID', 'runtime manifest engine must be ccb')
  }
  if (typeof obj.min_version !== 'string' || obj.min_version.trim().length === 0) {
    throw new HttpError(503, 'RUNTIME_MANIFEST_INVALID', 'runtime manifest schema invalid')
  }
  if (!Array.isArray(obj.artifacts)) {
    throw new HttpError(503, 'RUNTIME_MANIFEST_INVALID', 'runtime manifest schema invalid')
  }
  const artifacts: DesktopRuntimeArtifact[] = []
  for (const item of obj.artifacts) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new HttpError(503, 'RUNTIME_MANIFEST_INVALID', 'runtime manifest schema invalid')
    }
    const a = item as Record<string, unknown>
    if (a.os !== 'windows' || a.arch !== 'x64') continue
    if (typeof a.url !== 'string' || !isHttpsUrl(a.url)) {
      throw new HttpError(
        503,
        'RUNTIME_MANIFEST_INVALID',
        'runtime manifest artifact url must be https',
      )
    }
    if (typeof a.sha256 !== 'string' || !SHA256_RE.test(a.sha256.toLowerCase())) {
      throw new HttpError(503, 'RUNTIME_MANIFEST_INVALID', 'runtime manifest schema invalid')
    }
    if (
      typeof a.size !== 'number' ||
      !Number.isFinite(a.size) ||
      a.size < 0 ||
      !Number.isInteger(a.size)
    ) {
      throw new HttpError(503, 'RUNTIME_MANIFEST_INVALID', 'runtime manifest schema invalid')
    }
    if (typeof a.version !== 'string' || a.version.trim().length === 0) {
      throw new HttpError(503, 'RUNTIME_MANIFEST_INVALID', 'runtime manifest schema invalid')
    }
    artifacts.push({
      os: 'windows',
      arch: 'x64',
      url: a.url,
      sha256: a.sha256.toLowerCase(),
      size: a.size,
      version: a.version.trim(),
    })
  }
  return {
    v: 1,
    engine: 'ccb',
    min_version: obj.min_version.trim(),
    artifacts,
  }
}

async function loadRuntimeManifestFile(
  filePath: string,
): Promise<Omit<DesktopRuntimeManifest, 'keyring_fp'>> {
  const now = Date.now()
  if (
    manifestCache &&
    manifestCache.path === filePath &&
    now - manifestCache.loadedAt < MANIFEST_CACHE_MS
  ) {
    return manifestCache.value
  }
  let text: string
  try {
    text = await fs.readFile(filePath, 'utf8')
  } catch {
    throw new HttpError(503, 'RUNTIME_MANIFEST_UNCONFIGURED', 'runtime manifest is not configured')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    throw new HttpError(503, 'RUNTIME_MANIFEST_INVALID', 'runtime manifest schema invalid')
  }
  const value = parseDesktopRuntimeManifestJson(parsed)
  manifestCache = { path: filePath, loadedAt: now, value }
  return value
}

export async function handleDesktopRuntimeManifest(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const flags = await getDesktopFlagSnapshot()
  await requireAssembled(flags)
  await requireNotKilled(flags)
  authorizeRuntimeManifest(req, deps)

  const filePath = readDesktopRuntimeManifestPath()
  if (!filePath || !path.isAbsolute(filePath)) {
    throw new HttpError(503, 'RUNTIME_MANIFEST_UNCONFIGURED', 'runtime manifest is not configured')
  }
  const body = await loadRuntimeManifestFile(filePath)
  sendJson(res, 200, {
    ...body,
    keyring_fp: liveKeyringFp(),
  })
}
