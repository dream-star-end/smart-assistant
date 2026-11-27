/**
 * OCV5-890 Wave 3 — Extended Red-Control Proof Verifier (`R8`–`R11`) & Full `R1`–`R11` Matrix Gate.
 *
 * Extends the committed deterministic sandbox red-control proof (`R1`–`R7` in `sandboxRedProof.ts`)
 * with the four three-layer pool red-control invariants:
 *   - R8:  Loopback Self-Bypass (`ScopedCapabilityTokenAuthority` single-use `octk1.*`)
 *   - R9:  Policy & ReadOnly Parity (`ToolBrokerServer` monotonic tightening & action/shell guard)
 *   - R10: Brain-Switch Fencing (`ExecEnvLeaseManager` monotonic `brainGen` & `fencingToken`)
 *   - R11: Schema-Filtered Observation (`OCV5-800` schema-filtered args SHA-256 verification)
 *
 * Architecture invariants (`accounts` L3):
 * - Node 20 compatible: ZERO `node:sqlite` imports.
 * - ZERO `process.env`, `R3-crypto`, `R3-net`, `R3-special-case`, `R3-billing-sql`, `export *`.
 * - ZERO imports from `scripts/agent-remote/conformance/*`.
 * - Value imports restricted to L0 `@openclaude/protocol` and same-module `./sandboxRedProof.js`.
 */
import { assertWellFormedJsonValue, remoteCanonicalSha256 } from '@openclaude/protocol'
import {
  verifySandboxRedProofForDriver,
  type VerifySandboxRedProofInput,
  type VerifiedSandboxRedProof,
} from './sandboxRedProof.js'

export const EXTENDED_RED_CONTROL_IDS = ['R8', 'R9', 'R10', 'R11'] as const
export type ExtendedRedControlId = (typeof EXTENDED_RED_CONTROL_IDS)[number]

export const FULL_RED_CONTROL_IDS = [
  'R1',
  'R2',
  'R3',
  'R4a',
  'R4b',
  'R5',
  'R6',
  'R7',
  'R8',
  'R9',
  'R10',
  'R11',
] as const
export type FullRedControlId = (typeof FULL_RED_CONTROL_IDS)[number]

const SHA256_HEX_RE = /^[a-f0-9]{64}$/
const DRIVER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

const EXTENDED_CONTROL_ID_SET: ReadonlySet<string> = new Set<string>(EXTENDED_RED_CONTROL_IDS)
const EXTENDED_CONTROL_RANK: Readonly<Record<ExtendedRedControlId, number>> = Object.freeze({
  R8: 0,
  R9: 1,
  R10: 2,
  R11: 3,
})

const ARTIFACT_ALLOWED_KEYS: ReadonlySet<string> = new Set<string>([
  'schemaVersion',
  'baseProofSha256',
  'driverId',
  'controls',
  'extendedProofSha256',
])

const CONTROL_ALLOWED_KEYS: ReadonlySet<string> = new Set<string>([
  'requirementId',
  'dimension',
  'redControlCaught',
  'greenPassed',
  'injectedFault',
  'evidenceDigest',
])

export interface ExtendedRedControlEntry {
  readonly requirementId: ExtendedRedControlId
  readonly dimension: string
  readonly redControlCaught: true
  readonly greenPassed: true
  readonly injectedFault: string
  readonly evidenceDigest: string
}

export interface ExtendedRedProofArtifact {
  readonly schemaVersion: 2
  readonly baseProofSha256: string
  readonly driverId: string
  readonly controls: readonly ExtendedRedControlEntry[]
  readonly extendedProofSha256: string
}

export interface BuildExtendedRedProofInput {
  readonly baseProofSha256: string
  readonly driverId: string
  readonly controls: readonly ExtendedRedControlEntry[]
}

export interface VerifyExtendedRedProofExpectedBase {
  readonly baseProofSha256?: string
  readonly driverId?: string
}

export interface VerifiedExtendedRedProof {
  readonly schemaVersion: 2
  readonly baseProofSha256: string
  readonly driverId: string
  readonly controls: readonly ExtendedRedControlEntry[]
  readonly extendedProofSha256: string
  readonly verifiedControlIds: readonly ExtendedRedControlId[]
}

export interface VerifyFullR1ToR11MatrixInput {
  readonly driverProofInput: VerifySandboxRedProofInput
  readonly extendedArtifact: unknown
}

export interface VerifiedFullR1ToR11Matrix {
  readonly driverId: string
  readonly baseProof: VerifiedSandboxRedProof
  readonly extendedProof: VerifiedExtendedRedProof
  readonly verifiedControlIds: readonly FullRedControlId[]
  readonly combinedMatrixSha256: string
}

function need(condition: unknown, reason: string): asserts condition {
  if (!condition) {
    throw new Error(`REMOTE_EXTENDED_RED_PROOF_INVALID:${reason}`)
  }
}

function asPlainObject(raw: unknown, reason: string): Record<string, unknown> {
  need(raw !== null && typeof raw === 'object' && !Array.isArray(raw), reason)
  const proto = Object.getPrototypeOf(raw)
  need(proto === Object.prototype || proto === null, reason)
  assertWellFormedJsonValue(raw, true)
  return raw as Record<string, unknown>
}

function assertAllowedKeys(
  obj: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  reason: string,
): void {
  for (const key of Object.keys(obj)) {
    need(allowed.has(key), `${reason}:unexpected_key_${key}`)
  }
}

function validateControlEntry(raw: unknown): ExtendedRedControlEntry {
  const c = asPlainObject(raw, 'control_entry_not_object')
  assertAllowedKeys(c, CONTROL_ALLOWED_KEYS, 'control_entry')

  need(
    typeof c.requirementId === 'string' && EXTENDED_CONTROL_ID_SET.has(c.requirementId),
    'control_requirement_id_invalid',
  )
  const reqId = c.requirementId as ExtendedRedControlId

  need(
    typeof c.dimension === 'string' && c.dimension.trim().length > 0 && c.dimension.length <= 128,
    `control_dimension_invalid:${reqId}`,
  )
  need(c.redControlCaught === true, `control_red_not_caught:${reqId}`)
  need(c.greenPassed === true, `control_green_not_passed:${reqId}`)
  need(
    typeof c.injectedFault === 'string' &&
      c.injectedFault.trim().length > 0 &&
      c.injectedFault.length <= 512,
    `control_injected_fault_invalid:${reqId}`,
  )
  need(
    typeof c.evidenceDigest === 'string' && SHA256_HEX_RE.test(c.evidenceDigest),
    `control_evidence_digest_invalid:${reqId}`,
  )

  return Object.freeze({
    requirementId: reqId,
    dimension: c.dimension,
    redControlCaught: true as const,
    greenPassed: true as const,
    injectedFault: c.injectedFault,
    evidenceDigest: c.evidenceDigest,
  })
}

function validateControlsList(rawControls: unknown): readonly ExtendedRedControlEntry[] {
  need(Array.isArray(rawControls), 'controls_not_array')
  need(
    rawControls.length === EXTENDED_RED_CONTROL_IDS.length,
    `controls_length_mismatch:${rawControls.length}`,
  )

  const seen = new Set<ExtendedRedControlId>()
  const validated: ExtendedRedControlEntry[] = []

  for (const rawEntry of rawControls) {
    const entry = validateControlEntry(rawEntry)
    need(!seen.has(entry.requirementId), `duplicate_control:${entry.requirementId}`)
    seen.add(entry.requirementId)
    validated.push(entry)
  }

  for (const requiredId of EXTENDED_RED_CONTROL_IDS) {
    need(seen.has(requiredId), `missing_control:${requiredId}`)
  }

  return Object.freeze(validated)
}

export function computeExtendedRedProofSha256(body: {
  readonly schemaVersion: 2
  readonly baseProofSha256: string
  readonly driverId: string
  readonly controls: readonly ExtendedRedControlEntry[]
}): string {
  return remoteCanonicalSha256({
    schemaVersion: body.schemaVersion,
    baseProofSha256: body.baseProofSha256,
    driverId: body.driverId,
    controls: body.controls,
  })
}

export function buildExtendedRedProofArtifact(
  input: BuildExtendedRedProofInput,
): ExtendedRedProofArtifact {
  const raw = asPlainObject(input, 'build_input_not_object')
  need(
    typeof raw.baseProofSha256 === 'string' && SHA256_HEX_RE.test(raw.baseProofSha256),
    'base_proof_sha256_invalid',
  )
  need(
    typeof raw.driverId === 'string' && DRIVER_ID_RE.test(raw.driverId),
    'driver_id_invalid',
  )

  const validatedControls = validateControlsList(raw.controls)
  const orderedControls = Object.freeze(
    [...validatedControls].sort(
      (a, b) => EXTENDED_CONTROL_RANK[a.requirementId] - EXTENDED_CONTROL_RANK[b.requirementId],
    ),
  )

  const extendedProofSha256 = computeExtendedRedProofSha256({
    schemaVersion: 2,
    baseProofSha256: raw.baseProofSha256,
    driverId: raw.driverId,
    controls: orderedControls,
  })

  return Object.freeze({
    schemaVersion: 2 as const,
    baseProofSha256: raw.baseProofSha256,
    driverId: raw.driverId,
    controls: orderedControls,
    extendedProofSha256,
  })
}

export function verifyExtendedRedProof(
  artifact: unknown,
  expectedBase?: VerifyExtendedRedProofExpectedBase,
): VerifiedExtendedRedProof {
  const parsed = asPlainObject(artifact, 'artifact_not_object')
  assertAllowedKeys(parsed, ARTIFACT_ALLOWED_KEYS, 'artifact')

  need(parsed.schemaVersion === 2, 'schema_version_invalid')
  need(
    typeof parsed.baseProofSha256 === 'string' && SHA256_HEX_RE.test(parsed.baseProofSha256),
    'base_proof_sha256_invalid',
  )
  need(
    typeof parsed.driverId === 'string' && DRIVER_ID_RE.test(parsed.driverId),
    'driver_id_invalid',
  )
  need(
    typeof parsed.extendedProofSha256 === 'string' && SHA256_HEX_RE.test(parsed.extendedProofSha256),
    'extended_proof_sha256_invalid',
  )

  if (expectedBase?.baseProofSha256 !== undefined) {
    need(
      parsed.baseProofSha256 === expectedBase.baseProofSha256,
      'base_proof_sha256_mismatch',
    )
  }
  if (expectedBase?.driverId !== undefined) {
    need(parsed.driverId === expectedBase.driverId, 'driver_id_mismatch')
  }

  const controls = validateControlsList(parsed.controls)

  const recomputedSha256 = computeExtendedRedProofSha256({
    schemaVersion: 2,
    baseProofSha256: parsed.baseProofSha256,
    driverId: parsed.driverId,
    controls,
  })
  need(recomputedSha256 === parsed.extendedProofSha256, 'extended_proof_sha256_mismatch')

  return Object.freeze({
    schemaVersion: 2 as const,
    baseProofSha256: parsed.baseProofSha256,
    driverId: parsed.driverId,
    controls,
    extendedProofSha256: recomputedSha256,
    verifiedControlIds: EXTENDED_RED_CONTROL_IDS,
  })
}

export function verifyFullR1ToR11Matrix(
  input: VerifyFullR1ToR11MatrixInput,
): VerifiedFullR1ToR11Matrix {
  const baseProof = verifySandboxRedProofForDriver(input.driverProofInput)
  const extendedProof = verifyExtendedRedProof(input.extendedArtifact, {
    baseProofSha256: baseProof.proofSha256,
    driverId: baseProof.driverEntry.driverId,
  })

  const combinedMatrixSha256 = remoteCanonicalSha256({
    domain: 'oc-full-r1-to-r11-red-proof-matrix-v2',
    driverId: baseProof.driverEntry.driverId,
    suiteDigest: baseProof.suiteDigest,
    baseProofSha256: baseProof.proofSha256,
    extendedProofSha256: extendedProof.extendedProofSha256,
    verifiedControlIds: FULL_RED_CONTROL_IDS,
  })

  return Object.freeze({
    driverId: baseProof.driverEntry.driverId,
    baseProof,
    extendedProof,
    verifiedControlIds: FULL_RED_CONTROL_IDS,
    combinedMatrixSha256,
  })
}
