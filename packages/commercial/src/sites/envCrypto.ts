import { createHmac, hkdfSync } from 'node:crypto'
import { decrypt, encrypt } from '../crypto/aead.js'
import { SitesError } from './types.js'

export function deriveSiteDbEnvKey(secret: string): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(secret, 'utf8'),
      Buffer.from('oc-site-db-env-v1', 'utf8'),
      Buffer.alloc(0),
      32,
    ),
  )
}

export function deriveEdgeEnvKey(edgeSecret: string, slug: string): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(edgeSecret, 'utf8'),
      Buffer.from('oc-site-edge-env-v1', 'utf8'),
      Buffer.from(slug, 'utf8'),
      32,
    ),
  )
}

function deriveEnvDigestKey(edgeSecret: string): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(edgeSecret, 'utf8'),
      Buffer.from('oc-site-env-digest-v1', 'utf8'),
      Buffer.alloc(0),
      32,
    ),
  )
}

/** Keyed HMAC-SHA-256 digest bound to immutable siteId; empty string when env map is empty. */
export function computeEnvMapDigest(
  envMap: Record<string, string>,
  siteId: string,
  edgeSecret: string,
): string {
  const entries = Object.entries(envMap).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  if (entries.length === 0) return ''
  return createHmac('sha256', deriveEnvDigestKey(edgeSecret))
    .update(`${siteId}\0${JSON.stringify(entries)}`, 'utf8')
    .digest('hex')
}

export function encryptSiteSecretForDb(args: {
  key: Buffer
  userId: number
  siteId: string
  envKey: string
  plaintext: string
}): { ciphertext: Buffer; nonce: Buffer } {
  const aad = Buffer.from(`${args.userId}:${args.siteId}:${args.envKey}`, 'utf8')
  return encrypt(args.plaintext, args.key, aad)
}

export function decryptSiteSecretFromDb(args: {
  key: Buffer
  userId: number
  siteId: string
  envKey: string
  ciphertext: Buffer
  nonce: Buffer
}): string {
  try {
    const aad = Buffer.from(`${args.userId}:${args.siteId}:${args.envKey}`, 'utf8')
    return decrypt(args.ciphertext, args.nonce, args.key, aad)
  } catch {
    throw new SitesError('INTERNAL', `无法解密站点环境变量 ${args.envKey}`, 500)
  }
}

export function sealEdgeEnvMap(
  edgeSecret: string,
  slug: string,
  envMap: Record<string, string>,
): string {
  const key = deriveEdgeEnvKey(edgeSecret, slug)
  const aad = Buffer.from(slug, 'utf8')
  const { ciphertext, nonce } = encrypt(JSON.stringify(envMap), key, aad)
  const envelope = {
    v: 1,
    n: nonce.toString('base64url'),
    c: ciphertext.toString('base64url'),
  }
  return Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url')
}

export function unsealEdgeEnvMap(
  edgeSecret: string,
  slug: string,
  sealedB64: string,
): Record<string, string> {
  if (!sealedB64) return {}
  let raw: { v?: unknown; n?: unknown; c?: unknown }
  try {
    raw = JSON.parse(Buffer.from(sealedB64, 'base64url').toString('utf8')) as {
      v?: unknown
      n?: unknown
      c?: unknown
    }
  } catch {
    throw new SitesError('INTERNAL', '站点环境变量密文损坏', 500)
  }
  if (!raw || raw.v !== 1 || typeof raw.n !== 'string' || typeof raw.c !== 'string') {
    throw new SitesError('INTERNAL', '站点环境变量密文格式无效', 500)
  }
  let parsed: unknown
  try {
    const key = deriveEdgeEnvKey(edgeSecret, slug)
    const aad = Buffer.from(slug, 'utf8')
    const json = decrypt(
      Buffer.from(raw.c, 'base64url'),
      Buffer.from(raw.n, 'base64url'),
      key,
      aad,
    )
    parsed = JSON.parse(json) as unknown
  } catch {
    throw new SitesError('INTERNAL', '站点环境变量密文校验或解密失败', 500)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SitesError('INTERNAL', '站点环境变量密文结构无效', 500)
  }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v !== 'string') {
      throw new SitesError('INTERNAL', '站点环境变量密文字段类型无效', 500)
    }
    out[k] = v
  }
  return out
}
