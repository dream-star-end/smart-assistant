/**
 * Fail-closed verifier for the committed deterministic sandbox red-control proof (`OCV5-749`, R12).
 *
 * Reads `scripts/agent-remote/conformance/sandbox-red-proof.json` via `fs` (ZERO imports from
 * `scripts/agent-remote/conformance/*`), recomputes `remoteCanonicalSha256`, and validates exact
 * suite/driver/core digests plus all 8 caught negative controls (`R1`..`R7`).
 */
import { lstatSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { remoteCanonicalSha256 } from '@openclaude/protocol'

const EXPECTED_REQUIREMENT_IDS = ['R1', 'R2', 'R3', 'R4a', 'R4b', 'R5', 'R6', 'R7'] as const
const DEFAULT_PROOF_PATH = resolve(
  fileURLToPath(
    new URL(
      '../../../../../scripts/agent-remote/conformance/sandbox-red-proof.json',
      import.meta.url,
    ),
  ),
)

function need(condition: unknown, code = 'REMOTE_SANDBOX_RED_PROOF_INVALID'): asserts condition {
  if (!condition) throw new Error(code)
}

export interface SandboxRedRequirementProof {
  readonly requirementId: string
  readonly redEnvironment: 'local-sandbox-fault-injection'
  readonly redControlCaught: true
  readonly injectedFault: string
}

export interface SandboxRedDriverProof {
  readonly driverId: string
  readonly engineId: string
  readonly driverDigest: string
  readonly coreDigest: string
  readonly controllerSha256: string
  readonly policySha256: string
  readonly requirements: readonly SandboxRedRequirementProof[]
}

export interface SandboxRedProofFile {
  readonly schemaVersion: 1
  readonly suiteDigest: string
  readonly drivers: Readonly<Record<string, SandboxRedDriverProof>>
  readonly proofSha256: string
}

export interface VerifySandboxRedProofInput {
  readonly driverId: string
  readonly expectedDriverDigest: string
  readonly expectedCoreDigest: string
  readonly expectedSuiteDigest: string
  readonly proofPath?: string
}

export interface VerifiedSandboxRedProof {
  readonly proofPath: string
  readonly schemaVersion: 1
  readonly suiteDigest: string
  readonly proofSha256: string
  readonly driverEntry: SandboxRedDriverProof
}

export function verifySandboxRedProofForDriver(
  input: VerifySandboxRedProofInput,
): VerifiedSandboxRedProof {
  const proofPath = input.proofPath ?? DEFAULT_PROOF_PATH
  let st: ReturnType<typeof lstatSync>
  try {
    st = lstatSync(proofPath)
  } catch {
    throw new Error('REMOTE_SANDBOX_RED_PROOF_INVALID')
  }
  need(!st.isSymbolicLink() && st.isFile(), 'REMOTE_SANDBOX_RED_PROOF_INVALID')

  let rawObj: unknown
  try {
    rawObj = JSON.parse(readFileSync(proofPath, 'utf8'))
  } catch {
    throw new Error('REMOTE_SANDBOX_RED_PROOF_INVALID')
  }
  need(
    rawObj && typeof rawObj === 'object' && !Array.isArray(rawObj),
    'REMOTE_SANDBOX_RED_PROOF_INVALID',
  )
  const parsed = rawObj as Record<string, unknown>
  need(parsed.schemaVersion === 1, 'REMOTE_SANDBOX_RED_PROOF_INVALID')
  need(
    typeof parsed.proofSha256 === 'string' && /^[a-f0-9]{64}$/.test(parsed.proofSha256),
    'REMOTE_SANDBOX_RED_PROOF_INVALID',
  )
  need(
    typeof parsed.suiteDigest === 'string' && parsed.suiteDigest === input.expectedSuiteDigest,
    'REMOTE_SANDBOX_RED_PROOF_INVALID',
  )
  need(
    parsed.drivers && typeof parsed.drivers === 'object' && !Array.isArray(parsed.drivers),
    'REMOTE_SANDBOX_RED_PROOF_INVALID',
  )

  const expectedSha = remoteCanonicalSha256({
    schemaVersion: parsed.schemaVersion,
    suiteDigest: parsed.suiteDigest,
    drivers: parsed.drivers,
  })
  need(expectedSha === parsed.proofSha256, 'REMOTE_SANDBOX_RED_PROOF_INVALID')

  const drivers = parsed.drivers as Record<string, unknown>
  const driverRaw = drivers[input.driverId]
  need(
    driverRaw && typeof driverRaw === 'object' && !Array.isArray(driverRaw),
    'REMOTE_SANDBOX_RED_PROOF_INVALID',
  )
  const driverEntry = driverRaw as SandboxRedDriverProof
  need(
    driverEntry.driverId === input.driverId &&
      driverEntry.driverDigest === input.expectedDriverDigest &&
      driverEntry.coreDigest === input.expectedCoreDigest &&
      Array.isArray(driverEntry.requirements) &&
      driverEntry.requirements.length === EXPECTED_REQUIREMENT_IDS.length,
    'REMOTE_SANDBOX_RED_PROOF_INVALID',
  )

  const seen = new Set<string>()
  for (const req of driverEntry.requirements) {
    need(
      req &&
        typeof req === 'object' &&
        typeof req.requirementId === 'string' &&
        req.redEnvironment === 'local-sandbox-fault-injection' &&
        req.redControlCaught === true &&
        typeof req.injectedFault === 'string' &&
        req.injectedFault.length > 0,
      'REMOTE_SANDBOX_RED_PROOF_INVALID',
    )
    seen.add(req.requirementId)
  }
  for (const expectedId of EXPECTED_REQUIREMENT_IDS) {
    need(seen.has(expectedId), 'REMOTE_SANDBOX_RED_PROOF_INVALID')
  }

  return {
    proofPath,
    schemaVersion: 1,
    suiteDigest: String(parsed.suiteDigest),
    proofSha256: String(parsed.proofSha256),
    driverEntry,
  }
}
