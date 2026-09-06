import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { describe, test } from 'node:test'
import { SignJWT } from 'jose'
import { ensureDesktopOriginCert } from '../desktop/deviceCa.js'
import { resetDesktopFlagCache, setDesktopSettingsLoader } from '../desktop/flags.js'
import {
  handleDesktopBootstrap,
  handleDesktopRuntimeManifest,
  parseDesktopRuntimeManifestJson,
  resetDesktopRuntimeManifestCacheForTest,
} from '../http/desktopBootstrap.js'
import type { CommercialHttpDeps, RequestContext } from '../http/handlers.js'
import { HttpError } from '../http/util.js'
import { rootLogger } from '../logging/logger.js'

const JWT = 'desktop-bootstrap-test-secret-32bytes-min!!'

function opensslBuf(args: string[], stdin?: Buffer | string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('openssl', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (c: Buffer) => out.push(c))
    child.stderr.on('data', (c: Buffer) => err.push(c))
    child.on('close', (code) => {
      if (code !== 0)
        reject(new Error(Buffer.concat(err).toString('utf8') || `openssl exit ${code}`))
      else resolve(Buffer.concat(out))
    })
    if (stdin !== undefined) child.stdin.end(stdin)
    else child.stdin.end()
  })
}

async function independentSpkiPin(certPem: string): Promise<string> {
  const pub = await opensslBuf(['x509', '-noout', '-pubkey'], certPem)
  const der = await opensslBuf(['pkey', '-pubin', '-outform', 'DER'], pub)
  return createHash('sha256').update(der).digest('base64')
}

function dummyDeps(redisIncr?: () => Promise<number>): CommercialHttpDeps {
  let n = 0
  return {
    jwtSecret: JWT,
    mailer: { send: async () => {} },
    redis: {
      async incr() {
        if (redisIncr) return redisIncr()
        n += 1
        return n
      },
      async expire() {
        return 1
      },
    },
  } as CommercialHttpDeps
}

function ctx(): RequestContext {
  return {
    requestId: 't',
    clientIp: '203.0.113.10',
    authBoundIp: '203.0.113.10',
    userAgent: 'test',
    log: rootLogger.child({ subsys: 'test' }),
  }
}

function getReq(url: string, headers: Record<string, string> = {}): IncomingMessage {
  const stream = Readable.from([]) as IncomingMessage
  stream.method = 'GET'
  stream.url = url
  stream.headers = headers
  return stream
}

function response(): {
  res: ServerResponse
  headers: Record<string, string>
  body: () => Record<string, unknown>
  status: () => number
} {
  const headers: Record<string, string> = {}
  let payload = ''
  let statusCode = 200
  const res = {
    setHeader(k: string, v: string) {
      headers[k.toLowerCase()] = String(v)
    },
    get statusCode() {
      return statusCode
    },
    set statusCode(v: number) {
      statusCode = v
    },
    end(chunk?: string) {
      payload = chunk ?? ''
    },
  } as unknown as ServerResponse
  return {
    res,
    headers,
    body: () => JSON.parse(payload || '{}') as Record<string, unknown>,
    status: () => statusCode,
  }
}

async function signUser(uid = 3): Promise<string> {
  return new SignJWT({ sub: String(uid), role: 'user', jti: 'boot1' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(JWT))
}

type EnvSnap = Record<string, string | undefined>

function snapEnv(keys: string[]): EnvSnap {
  const o: EnvSnap = {}
  for (const k of keys) o[k] = process.env[k]
  return o
}

function unsetEnv(name: string): void {
  // Node turns `process.env.X = undefined` into the string "undefined".
  delete process.env[name]
}

function restoreEnv(s: EnvSnap): void {
  for (const [k, v] of Object.entries(s)) {
    if (v === undefined) unsetEnv(k)
    else process.env[k] = v
  }
}

const ENV_KEYS = [
  'OC_DESKTOP_VIRTUAL_CONTAINER',
  'OC_DESKTOP_KIND_KILLSWITCH',
  'OC_DESKTOP_PUBLIC_HOST',
  'OC_DESKTOP_TLS_PORT',
  'OC_DESKTOP_EGRESS_TLS_PORT',
  'OC_DESKTOP_PUBLIC_TLS_PORT',
  'OC_DESKTOP_PUBLIC_EGRESS_PORT',
  'OC_DESKTOP_RUNTIME_MANIFEST_PATH',
  'OC_DESKTOP_MIN_APP_VERSION',
  'OPENCLAUDE_DEVICE_CA_DIR',
  'OPENCLAUDE_PUBLIC_ORIGIN',
]

describe('desktop bootstrap + runtime-manifest', () => {
  test('flag off → 404', async () => {
    const env = snapEnv(ENV_KEYS)
    unsetEnv("OC_DESKTOP_VIRTUAL_CONTAINER")
    resetDesktopFlagCache()
    setDesktopSettingsLoader(async () => ({ settingsOn: true, allowlist: [1] }))
    const cap = response()
    await assert.rejects(
      () => handleDesktopBootstrap(getReq('/api/desktop/bootstrap'), cap.res, ctx(), dummyDeps()),
      (e: unknown) => e instanceof HttpError && e.status === 404 && e.code === 'NOT_FOUND',
    )
    restoreEnv(env)
    setDesktopSettingsLoader(null)
    resetDesktopFlagCache()
  })

  test('host unset → 503 DESKTOP_BOOTSTRAP_UNCONFIGURED and does not issue CA', async () => {
    const env = snapEnv(ENV_KEYS)
    const dir = await mkdtemp(path.join(os.tmpdir(), 'oc-boot-empty-'))
    process.env.OC_DESKTOP_VIRTUAL_CONTAINER = '1'
    process.env.OPENCLAUDE_DEVICE_CA_DIR = dir
    unsetEnv("OC_DESKTOP_PUBLIC_HOST")
    resetDesktopFlagCache()
    setDesktopSettingsLoader(async () => ({ settingsOn: true, allowlist: [1] }))
    try {
      const cap = response()
      await assert.rejects(
        () => handleDesktopBootstrap(getReq('/api/desktop/bootstrap'), cap.res, ctx(), dummyDeps()),
        (e: unknown) =>
          e instanceof HttpError && e.status === 503 && e.code === 'DESKTOP_BOOTSTRAP_UNCONFIGURED',
      )
      const names = await readdir(dir)
      assert.equal(names.length, 0, 'anonymous bootstrap must not create CA files')
    } finally {
      restoreEnv(env)
      setDesktopSettingsLoader(null)
      resetDesktopFlagCache()
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('host set but certs missing → 503 and still no issue', async () => {
    const env = snapEnv(ENV_KEYS)
    const dir = await mkdtemp(path.join(os.tmpdir(), 'oc-boot-nocert-'))
    process.env.OC_DESKTOP_VIRTUAL_CONTAINER = '1'
    process.env.OPENCLAUDE_DEVICE_CA_DIR = dir
    process.env.OC_DESKTOP_PUBLIC_HOST = 'desktop.example.test'
    resetDesktopFlagCache()
    setDesktopSettingsLoader(async () => ({ settingsOn: true, allowlist: [1] }))
    try {
      await assert.rejects(
        () =>
          handleDesktopBootstrap(
            getReq('/api/desktop/bootstrap'),
            response().res,
            ctx(),
            dummyDeps(),
          ),
        (e: unknown) =>
          e instanceof HttpError && e.status === 503 && e.code === 'DESKTOP_BOOTSTRAP_UNCONFIGURED',
      )
      const names = await readdir(dir)
      assert.equal(names.length, 0)
    } finally {
      restoreEnv(env)
      setDesktopSettingsLoader(null)
      resetDesktopFlagCache()
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('configured host + existing certs → 200 four-tuple, pin matches openssl, Cache-Control', async () => {
    const env = snapEnv(ENV_KEYS)
    const dir = await mkdtemp(path.join(os.tmpdir(), 'oc-boot-ok-'))
    process.env.OC_DESKTOP_VIRTUAL_CONTAINER = '1'
    process.env.OPENCLAUDE_DEVICE_CA_DIR = dir
    process.env.OC_DESKTOP_PUBLIC_HOST = 'desktop.example.test'
    process.env.OC_DESKTOP_PUBLIC_TLS_PORT = '18445'
    process.env.OC_DESKTOP_PUBLIC_EGRESS_PORT = '18446'
    process.env.OPENCLAUDE_PUBLIC_ORIGIN = 'https://claudeai.chat'
    resetDesktopFlagCache()
    setDesktopSettingsLoader(async () => ({ settingsOn: true, allowlist: [1] }))
    try {
      const material = await ensureDesktopOriginCert()
      const cap = response()
      await handleDesktopBootstrap(getReq('/api/desktop/bootstrap'), cap.res, ctx(), dummyDeps())
      assert.equal(cap.status(), 200)
      assert.equal(cap.headers['cache-control'], 'public, max-age=300')
      const body = cap.body()
      assert.equal(body.v, 1)
      assert.equal(
        body.register_wss,
        'wss://desktop.example.test:18445/ws/desktop-container-register',
      )
      assert.equal(body.master_https, 'https://desktop.example.test:18445')
      assert.equal(body.egress_https, 'https://desktop.example.test:18446')
      assert.equal(body.runtime_manifest_url, 'https://claudeai.chat/api/desktop/runtime-manifest')
      assert.equal(body.min_app_version, '0.5.0')
      assert.equal(typeof body.device_ca_pem, 'string')
      assert.match(String(body.device_ca_pem), /BEGIN CERTIFICATE/)
      assert.equal(
        String(body.device_ca_pem).replace(/\s+/g, ''),
        material.caCertPem.replace(/\s+/g, ''),
      )
      const expectedPin = await independentSpkiPin(material.certPem)
      assert.equal(body.origin_spki_pin, expectedPin)
    } finally {
      restoreEnv(env)
      setDesktopSettingsLoader(null)
      resetDesktopFlagCache()
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('rate limit → 429', async () => {
    const env = snapEnv(ENV_KEYS)
    const dir = await mkdtemp(path.join(os.tmpdir(), 'oc-boot-rl-'))
    process.env.OC_DESKTOP_VIRTUAL_CONTAINER = '1'
    process.env.OPENCLAUDE_DEVICE_CA_DIR = dir
    process.env.OC_DESKTOP_PUBLIC_HOST = 'desktop.example.test'
    resetDesktopFlagCache()
    setDesktopSettingsLoader(async () => ({ settingsOn: true, allowlist: [1] }))
    try {
      await assert.rejects(
        () =>
          handleDesktopBootstrap(
            getReq('/api/desktop/bootstrap'),
            response().res,
            ctx(),
            dummyDeps(async () => 61),
          ),
        (e: unknown) => e instanceof HttpError && e.status === 429,
      )
    } finally {
      restoreEnv(env)
      setDesktopSettingsLoader(null)
      resetDesktopFlagCache()
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('manifest path unset → 503 RUNTIME_MANIFEST_UNCONFIGURED', async () => {
    const env = snapEnv(ENV_KEYS)
    process.env.OC_DESKTOP_VIRTUAL_CONTAINER = '1'
    unsetEnv("OC_DESKTOP_RUNTIME_MANIFEST_PATH")
    resetDesktopFlagCache()
    resetDesktopRuntimeManifestCacheForTest()
    setDesktopSettingsLoader(async () => ({ settingsOn: true, allowlist: [1] }))
    try {
      const tok = await signUser()
      await assert.rejects(
        () =>
          handleDesktopRuntimeManifest(
            getReq('/api/desktop/runtime-manifest', { authorization: `Bearer ${tok}` }),
            response().res,
            ctx(),
            dummyDeps(),
          ),
        (e: unknown) =>
          e instanceof HttpError && e.status === 503 && e.code === 'RUNTIME_MANIFEST_UNCONFIGURED',
      )
    } finally {
      restoreEnv(env)
      setDesktopSettingsLoader(null)
      resetDesktopFlagCache()
    }
  })

  test('manifest schema rejects non-https url', async () => {
    const env = snapEnv(ENV_KEYS)
    const dir = await mkdtemp(path.join(os.tmpdir(), 'oc-mf-http-'))
    const file = path.join(dir, 'manifest.json')
    await writeFile(
      file,
      JSON.stringify({
        v: 1,
        engine: 'ccb',
        min_version: '1.0.0',
        artifacts: [
          {
            os: 'windows',
            arch: 'x64',
            url: 'http://example.invalid/ccb.zip',
            sha256: 'a'.repeat(64),
            size: 1,
            version: '1.0.0',
          },
        ],
      }),
    )
    process.env.OC_DESKTOP_VIRTUAL_CONTAINER = '1'
    process.env.OC_DESKTOP_RUNTIME_MANIFEST_PATH = file
    resetDesktopFlagCache()
    resetDesktopRuntimeManifestCacheForTest()
    setDesktopSettingsLoader(async () => ({ settingsOn: true, allowlist: [1] }))
    try {
      const tok = await signUser()
      await assert.rejects(
        () =>
          handleDesktopRuntimeManifest(
            getReq('/api/desktop/runtime-manifest', { authorization: `Bearer ${tok}` }),
            response().res,
            ctx(),
            dummyDeps(),
          ),
        (e: unknown) =>
          e instanceof HttpError && e.status === 503 && e.code === 'RUNTIME_MANIFEST_INVALID',
      )
    } finally {
      restoreEnv(env)
      setDesktopSettingsLoader(null)
      resetDesktopFlagCache()
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('manifest schema rejects non-ccb engine', async () => {
    const env = snapEnv(ENV_KEYS)
    const dir = await mkdtemp(path.join(os.tmpdir(), 'oc-mf-eng-'))
    const file = path.join(dir, 'manifest.json')
    await writeFile(
      file,
      JSON.stringify({
        v: 1,
        engine: 'grok',
        min_version: '1.0.0',
        artifacts: [],
      }),
    )
    process.env.OC_DESKTOP_VIRTUAL_CONTAINER = '1'
    process.env.OC_DESKTOP_RUNTIME_MANIFEST_PATH = file
    resetDesktopFlagCache()
    resetDesktopRuntimeManifestCacheForTest()
    setDesktopSettingsLoader(async () => ({ settingsOn: true, allowlist: [1] }))
    try {
      const tok = await signUser()
      await assert.rejects(
        () =>
          handleDesktopRuntimeManifest(
            getReq('/api/desktop/runtime-manifest', { authorization: `Bearer ${tok}` }),
            response().res,
            ctx(),
            dummyDeps(),
          ),
        (e: unknown) =>
          e instanceof HttpError && e.status === 503 && e.code === 'RUNTIME_MANIFEST_INVALID',
      )
      assert.throws(
        () =>
          parseDesktopRuntimeManifestJson({
            v: 1,
            engine: 'cursor',
            min_version: '1',
            artifacts: [],
          }),
        (e: unknown) => e instanceof HttpError && e.code === 'RUNTIME_MANIFEST_INVALID',
      )
    } finally {
      restoreEnv(env)
      setDesktopSettingsLoader(null)
      resetDesktopFlagCache()
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('manifest filters non-windows/x64 and stamps live keyring_fp', async () => {
    const env = snapEnv(ENV_KEYS)
    const dir = await mkdtemp(path.join(os.tmpdir(), 'oc-mf-ok-'))
    const file = path.join(dir, 'manifest.json')
    const sha = 'b'.repeat(64)
    await writeFile(
      file,
      JSON.stringify({
        v: 1,
        engine: 'ccb',
        min_version: '1.2.3',
        keyring_fp: 'untrusted',
        artifacts: [
          {
            os: 'linux',
            arch: 'x64',
            url: 'https://example.invalid/linux',
            sha256: sha,
            size: 9,
            version: '1.2.3',
          },
          {
            os: 'windows',
            arch: 'arm64',
            url: 'https://example.invalid/arm',
            sha256: sha,
            size: 9,
            version: '1.2.3',
          },
          {
            os: 'windows',
            arch: 'x64',
            url: 'https://example.invalid/ccb.zip',
            sha256: sha.toUpperCase(),
            size: 42,
            version: '1.2.3',
          },
        ],
      }),
    )
    process.env.OC_DESKTOP_VIRTUAL_CONTAINER = '1'
    process.env.OC_DESKTOP_RUNTIME_MANIFEST_PATH = file
    resetDesktopFlagCache()
    resetDesktopRuntimeManifestCacheForTest()
    setDesktopSettingsLoader(async () => ({ settingsOn: true, allowlist: [1] }))
    try {
      const tok = await signUser()
      const cap = response()
      await handleDesktopRuntimeManifest(
        getReq('/api/desktop/runtime-manifest', { authorization: `Bearer ${tok}` }),
        cap.res,
        ctx(),
        dummyDeps(),
      )
      assert.equal(cap.status(), 200)
      const body = cap.body() as {
        engine: string
        min_version: string
        keyring_fp: string
        artifacts: Array<{ os: string; arch: string; sha256: string; url: string }>
      }
      assert.equal(body.engine, 'ccb')
      assert.equal(body.min_version, '1.2.3')
      assert.equal(body.artifacts.length, 1)
      assert.equal(body.artifacts[0]!.os, 'windows')
      assert.equal(body.artifacts[0]!.arch, 'x64')
      assert.equal(body.artifacts[0]!.sha256, sha)
      assert.equal(body.artifacts[0]!.url, 'https://example.invalid/ccb.zip')
      assert.notEqual(body.keyring_fp, 'untrusted')
      assert.match(body.keyring_fp, /^[0-9a-f]{16,64}$/)
    } finally {
      restoreEnv(env)
      setDesktopSettingsLoader(null)
      resetDesktopFlagCache()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
