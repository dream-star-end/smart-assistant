import { createHash } from 'node:crypto'
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import https from 'node:https'
import { pipeline } from 'node:stream/promises'
import { createSpkiPinChecker, parseHttpsOrigin } from '../../tunnel/bootstrap.mjs'

export class RuntimeCorruptError extends Error {
  constructor(message = '运行时损坏') {
    super(message)
    this.name = 'RuntimeCorruptError'
    this.code = 'RUNTIME_CORRUPT'
  }
}

export function defaultRuntimeRoot({ env = process.env, platform = process.platform } = {}) {
  if (env.OC_RUNTIME_ROOT) return env.OC_RUNTIME_ROOT
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA || path.join(env.USERPROFILE || '', 'AppData', 'Local')
    return path.join(base, 'Clarvy', 'runtime')
  }
  return path.join(tmpdir(), 'clarvy-runtime')
}

export function artifactDir(sha256, root) {
  return path.join(root, 'ccb', String(sha256).toLowerCase())
}

export function createArtifactTlsOptions({ url, spkiPin, publicOrigin, caPem }) {
  const parsed = typeof url === 'string' ? parseHttpsOrigin(url, 'artifactUrl') : url
  let samePublic = false
  if (publicOrigin) {
    const pub = parseHttpsOrigin(publicOrigin, 'publicOrigin')
    samePublic = pub.origin === parsed.origin
  }
  if (!samePublic && !spkiPin) {
    throw new Error('artifact url must share public origin or provide SPKI pin')
  }
  const opts = {
    rejectUnauthorized: true,
    minVersion: 'TLSv1.3',
    maxVersion: 'TLSv1.3',
  }
  // Public-origin artifacts use the system trust store. Host 18445 SPKI pin +
  // device CA would replace Node's default CAs and fail Let's Encrypt
  // (and pin-mismatch the public leaf). Pin/CA apply only to non-public origins.
  if (!samePublic && spkiPin) {
    opts.checkServerIdentity = createSpkiPinChecker(spkiPin)
    if (caPem) opts.ca = caPem
  }
  return Object.freeze(opts)
}

function basenameFromUrl(url) {
  try {
    const parsed = new URL(url)
    const base = path.posix.basename(parsed.pathname)
    return base && base !== '/' ? base : 'artifact.bin'
  } catch {
    return 'artifact.bin'
  }
}

export async function sha256File(filePath) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(filePath), hash)
  return hash.digest('hex')
}

function downloadHttps({ parsed, dest, tls, expected }) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const file = createWriteStream(dest)
    const req = https.get({
      hostname: parsed.hostname,
      port: Number(parsed.port) || 443,
      path: `${parsed.pathname}${parsed.search}`,
      servername: /^\d{1,3}(\.\d{1,3}){3}$/.test(parsed.hostname) ? undefined : parsed.hostname,
      rejectUnauthorized: true,
      minVersion: tls.minVersion,
      maxVersion: tls.maxVersion,
      ca: tls.ca,
      checkServerIdentity: tls.checkServerIdentity,
    }, (res) => {
      if ((res.statusCode || 500) !== 200) {
        res.resume()
        file.destroy()
        reject(new Error(`artifact HTTP ${res.statusCode}`))
        return
      }
      res.on('data', (chunk) => hash.update(chunk))
      res.pipe(file)
      file.on('finish', () => {
        const digest = hash.digest('hex')
        if (digest !== expected) {
          reject(new RuntimeCorruptError('运行时损坏'))
          return
        }
        resolve(digest)
      })
    })
    req.on('error', reject)
    file.on('error', reject)
  })
}

export async function fetchArtifact({
  url,
  sha256,
  destRoot,
  filename,
  spkiPin,
  publicOrigin,
  caPem,
}) {
  const expected = String(sha256).toLowerCase()
  const parsed = parseHttpsOrigin(url, 'artifactUrl')
  const tls = createArtifactTlsOptions({ url: parsed, spkiPin, publicOrigin, caPem })
  const root = destRoot || defaultRuntimeRoot()
  const dir = artifactDir(expected, root)
  mkdirSync(dir, { recursive: true })
  const dest = path.join(dir, filename || basenameFromUrl(url))
  if (existsSync(dest)) {
    const got = await sha256File(dest)
    if (got === expected) return { path: dest, downloaded: false }
    try { unlinkSync(dest) } catch { /* */ }
    throw new RuntimeCorruptError('运行时损坏')
  }
  const tmp = `${dest}.part`
  try {
    await downloadHttps({ parsed, dest: tmp, tls, expected })
  } catch (err) {
    try { unlinkSync(tmp) } catch { /* */ }
    if (err && err.code === 'RUNTIME_CORRUPT') throw err
    throw err
  }
  renameSync(tmp, dest)
  try { chmodSync(dest, 0o755) } catch { /* */ }
  return { path: dest, downloaded: true }
}
