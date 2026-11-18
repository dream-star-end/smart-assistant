/**
 * Crash-safe evidence persistence for `remote-driver-v4` verification runs (`OCV5-749`, R12).
 */
import { constants, closeSync, fsyncSync, mkdirSync, openSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CommissionEvidence, evidenceHash } from '../codexCommissioningEvidence.js'

export const DEFAULT_EVIDENCE_ROOT = '/var/lib/openclaude/remote-driver-verification'

export function writeArtifactSafely(
  rootDir: string,
  runId: string,
  artifact: Record<string, unknown>,
  allowSandboxRoot = false,
): { evidenceUri: string; evidenceDigest: string } {
  const payload = JSON.stringify(artifact, null, 2)
  const evidenceDigest = evidenceHash(payload)
  const isSandboxRoot = allowSandboxRoot && rootDir.startsWith('/tmp/oc-drvtest-')
  if (process.getuid?.() === 0 && !isSandboxRoot) {
    const store = new CommissionEvidence(rootDir)
    store.create(runId)
    store.write(runId, 'artifact.json', artifact)
    const uri = join(store.dir(runId), 'artifact.json')
    return {
      evidenceUri: uri,
      evidenceDigest: evidenceHash(store.bytes(uri)),
    }
  }
  mkdirSync(rootDir, { recursive: true, mode: 0o700 })
  const runDir = join(rootDir, runId)
  mkdirSync(runDir, { recursive: true, mode: 0o700 })
  const artifactPath = join(runDir, 'artifact.json')
  const fd = openSync(
    artifactPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    writeFileSync(fd, payload)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  return { evidenceUri: artifactPath, evidenceDigest }
}
