/**
 * @openclaude/kernel shared single-authority utilities (OCV5-905 gardening loop).
 *
 * Strict constraints:
 * - Zero external dependencies and zero top-level `node:*` imports (`kernel.test.ts` layering rule),
 *   so `@openclaude/kernel` remains safe across master, egress, and container runtimes.
 * - Zero synchronous I/O (`*Sync`), zero type escapes, and 100% strict TypeScript types.
 */

const UTF8_ENCODER = new TextEncoder()
const UTF8_DECODER = new TextDecoder('utf-8')

const SHA256_INIT = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
])

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

function rotr32(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0
}

function sha256CompressBlock(state: Uint32Array, view: DataView, offset: number, w: Uint32Array): void {
  for (let i = 0; i < 16; i++) {
    w[i] = view.getUint32(offset + i * 4, false)
  }
  for (let i = 16; i < 64; i++) {
    const w15 = w[i - 15]!
    const w2 = w[i - 2]!
    const s0 = rotr32(w15, 7) ^ rotr32(w15, 18) ^ (w15 >>> 3)
    const s1 = rotr32(w2, 17) ^ rotr32(w2, 19) ^ (w2 >>> 10)
    w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0
  }

  let a = state[0]!
  let b = state[1]!
  let c = state[2]!
  let d = state[3]!
  let e = state[4]!
  let f = state[5]!
  let g = state[6]!
  let h = state[7]!

  for (let i = 0; i < 64; i++) {
    const bigS1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25)
    const ch = ((e & f) ^ (~e & g)) >>> 0
    const temp1 = (h + bigS1 + ch + SHA256_K[i]! + w[i]!) >>> 0
    const bigS0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22)
    const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0
    const temp2 = (bigS0 + maj) >>> 0

    h = g
    g = f
    f = e
    e = (d + temp1) >>> 0
    d = c
    c = b
    b = a
    a = (temp1 + temp2) >>> 0
  }

  state[0] = (state[0]! + a) >>> 0
  state[1] = (state[1]! + b) >>> 0
  state[2] = (state[2]! + c) >>> 0
  state[3] = (state[3]! + d) >>> 0
  state[4] = (state[4]! + e) >>> 0
  state[5] = (state[5]! + f) >>> 0
  state[6] = (state[6]! + g) >>> 0
  state[7] = (state[7]! + h) >>> 0
}

/**
 * Pure RFC 6234 SHA-256 hex digest (64 lowercase hex characters).
 * Accepts UTF-8 strings or any `Uint8Array` (including Node `Buffer`).
 */
export function sha256Hex(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? UTF8_ENCODER.encode(input) : input
  const len = bytes.byteLength
  const paddedLen = Math.ceil((len + 9) / 64) * 64
  const padded = new Uint8Array(paddedLen)
  padded.set(bytes, 0)
  padded[len] = 0x80

  const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength)
  const bitLenHi = Math.floor(len / 0x20000000)
  const bitLenLo = (len << 3) >>> 0
  view.setUint32(paddedLen - 8, bitLenHi, false)
  view.setUint32(paddedLen - 4, bitLenLo, false)

  const state = new Uint32Array(SHA256_INIT)
  const w = new Uint32Array(64)
  for (let offset = 0; offset < paddedLen; offset += 64) {
    sha256CompressBlock(state, view, offset, w)
  }

  let hex = ''
  for (let i = 0; i < 8; i++) {
    hex += state[i]!.toString(16).padStart(8, '0')
  }
  return hex
}

/** Narrow an unknown value to a non-null, non-array record object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Return `value` as `Record<string, unknown>` if it is a non-array object, otherwise `null`. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

/** Extract a human-readable string message from an unknown thrown value. */
export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function toAbortError(reason: unknown): Error {
  if (reason instanceof Error) return reason
  const err = new Error(reason === undefined ? 'The operation was aborted' : String(reason))
  err.name = 'AbortError'
  return err
}

/** Promise-based delay supporting optional `AbortSignal` cancellation without timer leaks. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(toAbortError(signal.reason))
  }
  const delay = Number.isFinite(ms) && ms > 0 ? ms : 0
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(toAbortError(signal?.reason))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, delay)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export interface AtomicWriteFileHandle {
  writeFile(data: string, options?: { encoding?: 'utf8' }): Promise<void>
  sync(): Promise<void>
  close(): Promise<void>
}

export interface AtomicWriteFsDeps {
  mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>
  open(path: string, flags: string, mode?: number): Promise<AtomicWriteFileHandle>
  rename(oldPath: string, newPath: string): Promise<void>
  unlink(path: string): Promise<void>
}

export interface AtomicWriteJsonOptions {
  /** JSON indentation spaces (default `2`). */
  indent?: number
  /** File mode applied to the temporary file before atomic rename (default `0o600`). */
  mode?: number
  /** Whether to fsync the parent directory when supported by the OS/filesystem (default `true`). */
  syncDir?: boolean
  /** Optional injected filesystem promises implementation (defaults to Node `fs/promises`). */
  fs?: AtomicWriteFsDeps
}

let writeSeq = 0

function parentDirOf(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  const trimmed =
    normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized
  const slash = trimmed.lastIndexOf('/')
  if (slash < 0) return '.'
  if (slash === 0) return '/'
  return trimmed.slice(0, slash)
}

async function resolveDefaultFs(): Promise<AtomicWriteFsDeps> {
  const mod: AtomicWriteFsDeps = await import('node:fs/promises')
  return mod
}

/**
 * Atomically write a JSON value to `filePath` via `mkdir -> open(tmp) -> writeFile -> fsync -> close -> rename`.
 * Cleans up the temporary file on error and never leaves truncated JSON at `filePath`.
 */
export async function atomicWriteJson(
  filePath: string,
  value: unknown,
  options: AtomicWriteJsonOptions = {},
): Promise<void> {
  if (!filePath || typeof filePath !== 'string') {
    throw new TypeError('atomicWriteJson requires a non-empty filePath')
  }
  const serialized = JSON.stringify(value, null, options.indent ?? 2)
  if (serialized === undefined) {
    throw new TypeError('atomicWriteJson cannot serialize undefined root value')
  }
  const fsDeps = options.fs ?? (await resolveDefaultFs())
  const dir = parentDirOf(filePath)
  await fsDeps.mkdir(dir, { recursive: true })

  const pid = typeof process !== 'undefined' && typeof process.pid === 'number' ? process.pid : 0
  const nonce = `${Date.now().toString(36)}-${(++writeSeq).toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const tmpPath = `${filePath}.tmp-${pid}-${nonce}`
  const mode = options.mode ?? 0o600

  let renamed = false
  try {
    const handle = await fsDeps.open(tmpPath, 'w', mode)
    try {
      await handle.writeFile(`${serialized}\n`, { encoding: 'utf8' })
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fsDeps.rename(tmpPath, filePath)
    renamed = true
  } finally {
    if (!renamed) {
      await fsDeps.unlink(tmpPath).catch((cleanupErr: unknown) => {
        void cleanupErr
      })
    }
  }

  if (options.syncDir !== false) {
    try {
      const dirHandle = await fsDeps.open(dir, 'r')
      try {
        await dirHandle.sync()
      } finally {
        await dirHandle.close()
      }
    } catch (dirErr: unknown) {
      const code = (dirErr as { code?: unknown } | null)?.code
      if (
        code !== 'EINVAL' &&
        code !== 'EPERM' &&
        code !== 'EISDIR' &&
        code !== 'EBADF' &&
        code !== 'ENOTSUP'
      ) {
        throw dirErr
      }
    }
  }
}

/**
 * Read and parse a JSON body from an async byte/string stream (such as Node `http.IncomingMessage`),
 * enforcing a strict `maxBytes` ceiling before buffering unbounded payloads.
 */
export async function readBoundedJson(
  req: AsyncIterable<Uint8Array | string>,
  maxBytes: number,
): Promise<unknown> {
  if (!Number.isFinite(maxBytes) || maxBytes < 1) {
    throw new RangeError(`maxBytes must be a positive finite number, got ${String(maxBytes)}`)
  }
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of req) {
    const bytes =
      typeof chunk === 'string'
        ? UTF8_ENCODER.encode(chunk)
        : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    total += bytes.byteLength
    if (total > maxBytes) {
      const err = new RangeError(`body exceeds ${maxBytes} bytes`)
      Object.assign(err, { code: 'PAYLOAD_TOO_LARGE', statusCode: 413 })
      throw err
    }
    chunks.push(bytes)
  }
  if (total === 0) {
    throw new SyntaxError('empty body')
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const part of chunks) {
    merged.set(part, offset)
    offset += part.byteLength
  }
  return JSON.parse(UTF8_DECODER.decode(merged))
}

/** Structural contract satisfied by Node's `http.ServerResponse` without importing `node:http`. */
export interface JsonResponseLike {
  readonly headersSent?: boolean
  statusCode?: number
  setHeader?(name: string, value: string | number): unknown
  writeHead?(statusCode: number, headers?: Record<string, string | number>): unknown
  end(chunk?: string): unknown
}

/**
 * Write a UTF-8 JSON response with status code and optional extra headers.
 * Safely no-ops if `res.headersSent` is already `true`.
 */
export function sendJson(
  res: JsonResponseLike,
  status: number,
  body: unknown,
  extraHeaders?: Readonly<Record<string, string>>,
): void {
  if (res.headersSent) return
  const payload = JSON.stringify(body) ?? 'null'
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    ...(extraHeaders ?? {}),
  }
  if (typeof res.setHeader === 'function') {
    res.statusCode = status
    for (const [k, v] of Object.entries(headers)) {
      res.setHeader(k, v)
    }
  } else if (typeof res.writeHead === 'function') {
    res.writeHead(status, headers)
  } else {
    res.statusCode = status
  }
  res.end(payload)
}
