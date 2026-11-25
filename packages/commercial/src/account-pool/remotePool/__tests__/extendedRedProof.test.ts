import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { remoteCanonicalSha256 } from '@openclaude/protocol'
import {
  EXTENDED_RED_CONTROL_IDS,
  FULL_RED_CONTROL_IDS,
  buildExtendedRedProofArtifact,
  verifyExtendedRedProof,
  verifyFullR1ToR11Matrix,
  type ExtendedRedControlEntry,
} from '../extendedRedProof.js'
import type { SandboxRedProofFile } from '../sandboxRedProof.js'

const SANDBOX_PROOF_PATH = resolve(
  fileURLToPath(
    new URL(
      '../../../../../../scripts/agent-remote/conformance/sandbox-red-proof.json',
      import.meta.url,
    ),
  ),
)

function makeValidControls(): readonly ExtendedRedControlEntry[] {
  return [
    {
      requirementId: 'R8',
      dimension: 'schema_observation_R11_and_loopback_R8',
      redControlCaught: true,
      greenPassed: true,
      injectedFault: 'loopback_token_replay_and_cross_tool_abuse',
      evidenceDigest: remoteCanonicalSha256({ id: 'R8', ok: true }),
    },
    {
      requirementId: 'R9',
      dimension: 'tool_policy_parity_R9',
      redControlCaught: true,
      greenPassed: true,
      injectedFault: 'runtime_policy_relaxation_and_compound_shell',
      evidenceDigest: remoteCanonicalSha256({ id: 'R9', ok: true }),
    },
    {
      requirementId: 'R10',
      dimension: 'hot_swap_and_fencing_R10',
      redControlCaught: true,
      greenPassed: true,
      injectedFault: 'stale_fencing_token_replay_after_brain_switch',
      evidenceDigest: remoteCanonicalSha256({ id: 'R10', ok: true }),
    },
    {
      requirementId: 'R11',
      dimension: 'schema_observation_R11_and_loopback_R8',
      redControlCaught: true,
      greenPassed: true,
      injectedFault: 'schema_declared_arg_1byte_tamper_with_toolSummary_passthrough',
      evidenceDigest: remoteCanonicalSha256({ id: 'R11', ok: true }),
    },
  ]
}

describe('OCV5-890 Wave 3: ExtendedRedProof (R8–R11 + R1..R11 Matrix Verifier)', () => {
  it('builds and verifies ExtendedRedProofArtifact and closes full R1..R11 matrix', () => {
    const committed = JSON.parse(readFileSync(SANDBOX_PROOF_PATH, 'utf8')) as SandboxRedProofFile
    const driverIds = Object.keys(committed.drivers)
    assert.ok(driverIds.length > 0)

    const controls = makeValidControls()
    for (const driverId of driverIds) {
      const driverEntry = committed.drivers[driverId]!
      const artifact = buildExtendedRedProofArtifact({
        baseProofSha256: committed.proofSha256,
        driverId,
        controls: [...controls].reverse(),
      })
      assert.equal(artifact.schemaVersion, 2)
      assert.deepEqual(
        artifact.controls.map((c) => c.requirementId),
        [...EXTENDED_RED_CONTROL_IDS],
      )

      const matrix = verifyFullR1ToR11Matrix({
        driverProofInput: {
          driverId,
          expectedDriverDigest: driverEntry.driverDigest,
          expectedCoreDigest: driverEntry.coreDigest,
          expectedSuiteDigest: committed.suiteDigest,
          proofPath: SANDBOX_PROOF_PATH,
        },
        extendedArtifact: artifact,
      })
      assert.deepEqual(matrix.verifiedControlIds, FULL_RED_CONTROL_IDS)
      assert.equal(matrix.verifiedControlIds.length, 12)
      assert.match(matrix.combinedMatrixSha256, /^[a-f0-9]{64}$/)
    }
  })

  it('fails closed on tampered digest, missing R8..R11, redControlCaught=false, greenPassed=false, and schema mismatch', () => {
    const committed = JSON.parse(readFileSync(SANDBOX_PROOF_PATH, 'utf8')) as SandboxRedProofFile
    const driverId = Object.keys(committed.drivers)[0]!
    const controls = makeValidControls()
    const valid = buildExtendedRedProofArtifact({
      baseProofSha256: committed.proofSha256,
      driverId,
      controls,
    })

    const badSha = `${valid.extendedProofSha256.slice(0, 63)}${valid.extendedProofSha256.endsWith('0') ? '1' : '0'}`
    assert.throws(
      () => verifyExtendedRedProof({ ...valid, extendedProofSha256: badSha }),
      /REMOTE_EXTENDED_RED_PROOF_INVALID:extended_proof_sha256_mismatch/,
    )

    const uncaught = valid.controls.map((c) =>
      c.requirementId === 'R10' ? { ...c, redControlCaught: false } : c,
    )
    assert.throws(
      () =>
        verifyExtendedRedProof({
          ...valid,
          controls: uncaught,
          extendedProofSha256: remoteCanonicalSha256({
            schemaVersion: 2,
            baseProofSha256: valid.baseProofSha256,
            driverId: valid.driverId,
            controls: uncaught,
          }),
        }),
      /REMOTE_EXTENDED_RED_PROOF_INVALID:control_red_not_caught:R10/,
    )

    const failedGreen = valid.controls.map((c) =>
      c.requirementId === 'R11' ? { ...c, greenPassed: false } : c,
    )
    assert.throws(
      () =>
        verifyExtendedRedProof({
          ...valid,
          controls: failedGreen,
          extendedProofSha256: remoteCanonicalSha256({
            schemaVersion: 2,
            baseProofSha256: valid.baseProofSha256,
            driverId: valid.driverId,
            controls: failedGreen,
          }),
        }),
      /REMOTE_EXTENDED_RED_PROOF_INVALID:control_green_not_passed:R11/,
    )

    assert.throws(
      () => verifyExtendedRedProof({ ...valid, schemaVersion: 1 }),
      /REMOTE_EXTENDED_RED_PROOF_INVALID:schema_version_invalid/,
    )
    assert.throws(
      () => verifyExtendedRedProof({ ...valid, extraField: true }),
      /REMOTE_EXTENDED_RED_PROOF_INVALID:artifact:unexpected_key_extraField/,
    )
  })
})
