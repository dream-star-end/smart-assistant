/**
 * Canonical JSON and raw-frame evidence hashing shared across TypeScript (master/container)
 * and Python (`scripts/agent-remote/core/canonical.py`).
 *
 * Rules (compatible with `cc5NativeTool.ts` and `codex-fixed-mcp.py`):
 * - Object keys sorted by raw UTF-8 byte order (= Unicode code point order).
 * - Numbers formatted per ECMAScript Number::toString; NaN, +/-Infinity, and integers
 *   outside [-(2^53 - 1), 2^53 - 1] (including float integers like 1e21) are rejected.
 * - -0 serializes as "0".
 * - Strings must contain no lone UTF-16 surrogates; serialized as compact raw UTF-8 JSON.
 */
import { createHash } from 'node:crypto'

const LONE_SURROGATE = /\p{Surrogate}/u

export function isWellFormedJsonValue(value: unknown, rejectUndefined = false): boolean {
  if (value === null || typeof value === 'boolean') return true
  if (value === undefined) return !rejectUndefined
  if (typeof value === 'string') return !LONE_SURROGATE.test(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return false
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) return false
    return true
  }
  if (Array.isArray(value)) {
    return value.every((item) => isWellFormedJsonValue(item, rejectUndefined))
  }
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return false
    return Object.entries(value as Record<string, unknown>).every(
      ([key, item]) => !LONE_SURROGATE.test(key) && isWellFormedJsonValue(item, rejectUndefined),
    )
  }
  return false
}

export function assertWellFormedJsonValue(value: unknown, rejectUndefined = false): void {
  if (!isWellFormedJsonValue(value, rejectUndefined)) {
    throw new Error('REMOTE_CANONICAL_JSON_INVALID')
  }
}

export function remoteCanonicalJson(value: unknown): string {
  assertWellFormedJsonValue(value, false)
  return serializeCanonical(value)
}

function serializeCanonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => serializeCanonical(item === undefined ? null : item)).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort((left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')))
    return `{${keys.map((key) => `${JSON.stringify(key)}:${serializeCanonical(record[key])}`).join(',')}}`
  }
  if (typeof value === 'number' && Object.is(value, -0)) return '0'
  return JSON.stringify(value) ?? 'null'
}

export function remoteCanonicalSha256(value: unknown): string {
  return createHash('sha256').update(remoteCanonicalJson(value), 'utf8').digest('hex')
}

export interface RemoteRawFrameSample {
  readonly channel: 'native_stdout' | 'native_stdin' | 'fixed_mcp' | 'probe'
  readonly seq: number
  readonly rawBytes: Uint8Array | string
}

export const GENESIS_RAW_EVIDENCE_DIGEST = '0'.repeat(64)

/**
 * Stepwise ordered hash chain over raw received/sent frame bytes (never re-encoded JSON).
 * H_i = sha256(H_{i-1} || ":" || channel || ":" || seq || ":" || byteLength || ":" || rawBytes)
 */
export function advanceRawEvidenceDigest(
  previousDigest: string,
  sample: RemoteRawFrameSample,
): string {
  if (
    !/^[a-f0-9]{64}$/.test(previousDigest) ||
    !['native_stdout', 'native_stdin', 'fixed_mcp', 'probe'].includes(sample.channel) ||
    !Number.isSafeInteger(sample.seq) ||
    sample.seq < 1
  ) {
    throw new Error('REMOTE_RAW_EVIDENCE_INVALID')
  }
  const bytes =
    typeof sample.rawBytes === 'string' ? Buffer.from(sample.rawBytes, 'utf8') : Buffer.from(sample.rawBytes)
  const header = Buffer.from(`${previousDigest}:${sample.channel}:${sample.seq}:${bytes.byteLength}:`, 'utf8')
  return createHash('sha256').update(header).update(bytes).digest('hex')
}

export function computeRawEvidenceDigest(samples: readonly RemoteRawFrameSample[]): string {
  let digest = GENESIS_RAW_EVIDENCE_DIGEST
  let expectedSeq = 1
  for (const sample of samples) {
    if (sample.seq !== expectedSeq++) {
      throw new Error('REMOTE_RAW_EVIDENCE_SEQ_GAP')
    }
    digest = advanceRawEvidenceDigest(digest, sample)
  }
  return digest
}

export interface CanonicalGoldenVector {
  readonly name: string
  readonly value: unknown
  readonly canonical: string
  readonly sha256: string
}

const RAW_VECTORS: ReadonlyArray<{ name: string; value: unknown; canonical: string }> = [
  {
    name: 'key_order_utf8_bytes_and_integer_keys',
    value: { b: 1, '10': 'ten', '2': 'two', a: true, '中文': 'ok', _z: null },
    canonical: '{"10":"ten","2":"two","_z":null,"a":true,"b":1,"中文":"ok"}',
  },
  {
    name: 'negative_zero_and_floats',
    value: { negZero: -0, half: 0.5, tiny: 1e-7, big: 9007199254740991, arr: [-0, 1.25, 1000] },
    canonical: '{"arr":[0,1.25,1000],"big":9007199254740991,"half":0.5,"negZero":0,"tiny":1e-7}',
  },
  {
    name: 'unicode_emoji_non_bmp_utf8_order',
    value: { '😀': 'smile', '\uFFFD': 'replacement', ascii: 'hello\n"world"' },
    // U+FFFD (EF BF BD) sorts before U+1F600 (F0 9F 98 80) in UTF-8 byte order!
    // In UTF-16 code units, \uD83D\uDE00 (0xD83D) would wrongly sort BEFORE \uFFFD (0xFFFD).
    canonical: `{"ascii":"hello\\n\\"world\\"","${'\uFFFD'}":"replacement","😀":"smile"}`,
  },
]

export const REMOTE_CANONICAL_GOLDEN_VECTORS: readonly CanonicalGoldenVector[] = Object.freeze(
  RAW_VECTORS.map((entry) =>
    Object.freeze({
      ...entry,
      sha256: createHash('sha256').update(entry.canonical, 'utf8').digest('hex'),
    }),
  ),
)
