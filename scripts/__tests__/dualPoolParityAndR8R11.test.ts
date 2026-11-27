import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { remoteCanonicalSha256 } from '@openclaude/protocol'
import {
  DUAL_POOL_PARITY_DIMENSION_NAMES,
  runDualPoolParitySuite,
  type DualPoolParityReport,
} from '../agent-remote/conformance/dualPoolParity.js'
import {
  EXTENDED_RED_CONTROL_IDS,
  FULL_RED_CONTROL_IDS,
  buildExtendedRedProofArtifact,
  verifyExtendedRedProof,
  verifyFullR1ToR11Matrix,
  type ExtendedRedControlEntry,
} from '../../packages/commercial/src/account-pool/remotePool/extendedRedProof.js'
import type { SandboxRedProofFile } from '../../packages/commercial/src/account-pool/remotePool/sandboxRedProof.js'

const SANDBOX_PROOF_PATH = resolve(
  fileURLToPath(
    new URL('../agent-remote/conformance/sandbox-red-proof.json', import.meta.url),
  ),
)

function loadCommittedSandboxProof(): SandboxRedProofFile {
  return JSON.parse(readFileSync(SANDBOX_PROOF_PATH, 'utf8')) as SandboxRedProofFile
}

describe('OCV5-890 Wave 3: Dual-Pool Parity Conformance Matrix & R8–R11 Extended Red Proof', () => {
  let cachedReport: DualPoolParityReport | null = null

  async function getParityReport(): Promise<DualPoolParityReport> {
    if (!cachedReport) {
      cachedReport = await runDualPoolParitySuite()
    }
    return cachedReport
  }

  it('passes all 5 dual-pool parity dimensions end-to-end and emits deterministic R8–R11 evidence', async () => {
    const report = await getParityReport()

    assert.equal(report.schemaVersion, 1)
    assert.equal(report.overallPassed, true)
    assert.match(report.reportSha256, /^[a-f0-9]{64}$/)
    assert.deepEqual(
      report.dimensions.map((d) => d.dimension),
      [...DUAL_POOL_PARITY_DIMENSION_NAMES],
    )

    for (const dim of report.dimensions) {
      assert.equal(dim.passed, true, `dimension ${dim.dimension} failed`)
      assert.equal(dim.localPassed, true, `dimension ${dim.dimension} local failed`)
      assert.equal(dim.remotePassed, true, `dimension ${dim.dimension} remote failed`)
      assert.equal(dim.parityMatched, true, `dimension ${dim.dimension} parity mismatch`)
      assert.ok(dim.checks.length > 0, `dimension ${dim.dimension} has no checks`)
      assert.match(dim.evidenceDigest, /^[a-f0-9]{64}$/)
      for (const chk of dim.checks) {
        assert.equal(chk.passed, true, `check ${dim.dimension}:${chk.name} failed (${chk.detail ?? ''})`)
      }
    }

    assert.deepEqual(
      report.r8ToR11Controls.map((c) => c.requirementId),
      [...EXTENDED_RED_CONTROL_IDS],
    )
    for (const ctrl of report.r8ToR11Controls) {
      assert.equal(ctrl.redControlCaught, true)
      assert.equal(ctrl.greenPassed, true)
      assert.ok(ctrl.injectedFault.length > 0)
      assert.match(ctrl.evidenceDigest, /^[a-f0-9]{64}$/)
    }

    const recomputedReportSha = remoteCanonicalSha256({
      schemaVersion: report.schemaVersion,
      logicalModel: report.logicalModel,
      overallPassed: report.overallPassed,
      dimensions: report.dimensions,
      r8ToR11Controls: report.r8ToR11Controls,
    })
    assert.equal(recomputedReportSha, report.reportSha256)
  })

  it('builds and verifies ExtendedRedProofArtifact and closes full R1..R11 matrix against sandbox-red-proof.json', async () => {
    const report = await getParityReport()
    const committed = loadCommittedSandboxProof()
    const driverIds = Object.keys(committed.drivers)
    assert.ok(driverIds.length > 0, 'sandbox-red-proof.json must list at least one driver')

    for (const driverId of driverIds) {
      const driverEntry = committed.drivers[driverId]!
      const reversedControls = [...report.r8ToR11Controls].reverse()
      const extendedArtifact = buildExtendedRedProofArtifact({
        baseProofSha256: committed.proofSha256,
        driverId,
        controls: reversedControls,
      })

      assert.equal(extendedArtifact.schemaVersion, 2)
      assert.equal(extendedArtifact.baseProofSha256, committed.proofSha256)
      assert.equal(extendedArtifact.driverId, driverId)
      assert.deepEqual(
        extendedArtifact.controls.map((c) => c.requirementId),
        [...EXTENDED_RED_CONTROL_IDS],
      )
      assert.match(extendedArtifact.extendedProofSha256, /^[a-f0-9]{64}$/)

      const verifiedExt = verifyExtendedRedProof(extendedArtifact, {
        baseProofSha256: committed.proofSha256,
        driverId,
      })
      assert.equal(verifiedExt.extendedProofSha256, extendedArtifact.extendedProofSha256)
      assert.deepEqual(verifiedExt.verifiedControlIds, EXTENDED_RED_CONTROL_IDS)

      const fullMatrix = verifyFullR1ToR11Matrix({
        driverProofInput: {
          driverId,
          expectedDriverDigest: driverEntry.driverDigest,
          expectedCoreDigest: driverEntry.coreDigest,
          expectedSuiteDigest: committed.suiteDigest,
          proofPath: SANDBOX_PROOF_PATH,
        },
        extendedArtifact,
      })

      assert.equal(fullMatrix.driverId, driverId)
      assert.deepEqual(fullMatrix.verifiedControlIds, FULL_RED_CONTROL_IDS)
      assert.equal(fullMatrix.verifiedControlIds.length, 12)
      assert.equal(fullMatrix.baseProof.proofSha256, committed.proofSha256)
      assert.equal(fullMatrix.extendedProof.extendedProofSha256, extendedArtifact.extendedProofSha256)
      assert.match(fullMatrix.combinedMatrixSha256, /^[a-f0-9]{64}$/)
    }
  })

  it('fails closed on tampered extendedProofSha256, missing R8..R11, redControlCaught=false, and base mismatch', async () => {
    const report = await getParityReport()
    const committed = loadCommittedSandboxProof()
    const sampleDriverId = Object.keys(committed.drivers)[0]!
    const sampleDriver = committed.drivers[sampleDriverId]!

    const validArtifact = buildExtendedRedProofArtifact({
      baseProofSha256: committed.proofSha256,
      driverId: sampleDriverId,
      controls: report.r8ToR11Controls,
    })

    const flippedSha = `${validArtifact.extendedProofSha256.slice(0, 63)}${
      validArtifact.extendedProofSha256.endsWith('0') ? '1' : '0'
    }`
    assert.throws(
      () =>
        verifyExtendedRedProof({
          ...validArtifact,
          extendedProofSha256: flippedSha,
        }),
      /REMOTE_EXTENDED_RED_PROOF_INVALID:extended_proof_sha256_mismatch/,
    )

    for (const missingId of EXTENDED_RED_CONTROL_IDS) {
      const subset = report.r8ToR11Controls.filter((c) => c.requirementId !== missingId)
      assert.throws(
        () =>
          buildExtendedRedProofArtifact({
            baseProofSha256: committed.proofSha256,
            driverId: sampleDriverId,
            controls: subset,
          }),
        /REMOTE_EXTENDED_RED_PROOF_INVALID:controls_length_mismatch/,
      )
      const dupControls = [...subset, subset[0]!] as readonly ExtendedRedControlEntry[]
      assert.throws(
        () =>
          buildExtendedRedProofArtifact({
            baseProofSha256: committed.proofSha256,
            driverId: sampleDriverId,
            controls: dupControls,
          }),
        /REMOTE_EXTENDED_RED_PROOF_INVALID:duplicate_control/,
      )
    }

    const uncaughtControls = validArtifact.controls.map((c) =>
      c.requirementId === 'R10' ? { ...c, redControlCaught: false } : c,
    )
    assert.throws(
      () =>
        verifyExtendedRedProof({
          ...validArtifact,
          controls: uncaughtControls,
          extendedProofSha256: remoteCanonicalSha256({
            schemaVersion: 2,
            baseProofSha256: validArtifact.baseProofSha256,
            driverId: validArtifact.driverId,
            controls: uncaughtControls,
          }),
        }),
      /REMOTE_EXTENDED_RED_PROOF_INVALID:control_red_not_caught:R10/,
    )

    const wrongBaseArtifact = buildExtendedRedProofArtifact({
      baseProofSha256: 'f'.repeat(64),
      driverId: sampleDriverId,
      controls: report.r8ToR11Controls,
    })
    assert.throws(
      () =>
        verifyFullR1ToR11Matrix({
          driverProofInput: {
            driverId: sampleDriverId,
            expectedDriverDigest: sampleDriver.driverDigest,
            expectedCoreDigest: sampleDriver.coreDigest,
            expectedSuiteDigest: committed.suiteDigest,
            proofPath: SANDBOX_PROOF_PATH,
          },
          extendedArtifact: wrongBaseArtifact,
        }),
      /REMOTE_EXTENDED_RED_PROOF_INVALID:base_proof_sha256_mismatch/,
    )
  })
})
