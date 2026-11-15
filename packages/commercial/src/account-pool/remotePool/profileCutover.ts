/**
 * P0-1 Bounded Profile Cutover & CAS Revert (`OCV5-749`).
 *
 * Atomically transitions an idle legacy profile (`driver_id IS NULL`) to `remote-driver-v4`
 * (`execution_ready = FALSE`, `verified_fingerprint = NULL`), writes an atomic verified
 * pre-cutover snapshot file (`0o600` in `0o700` dir), enqueues a pending verification run,
 * and supports CAS revert back to legacy with monotonically increasing `ready_generation`.
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  REMOTE_DRIVER_BACKEND,
  REMOTE_DRIVER_PROTOCOL_VERSION,
  type RemoteProbeSnapshot,
  validateRemoteProbeSnapshot,
} from '@openclaude/protocol'
import type { Pool } from 'pg'
import { computeProbeFingerprintTs } from './driftCoordinator.js'
import { legacyProfileEngineForAuthority, loadRemoteDriverRegistry } from './registry.js'

const SHA256_RE = /^[a-f0-9]{64}$/
const UUID_RE = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const CONFORMANCE_SUITE_FILES = ['fixtures.ts', 'harness.ts', 'runner.ts', 'run.py'] as const
const DEFAULT_CUTOVER_SNAPSHOT_DIR = '/var/lib/openclaude/remote-driver-cutover'

function need(condition: unknown, code = 'REMOTE_CUTOVER_INVALID'): asserts condition {
  if (!condition) throw new Error(code)
}

function defaultRepoRoot(): string {
  return fileURLToPath(new URL('../../../../../', import.meta.url))
}

function resolveSnapshotDir(explicitDir?: string): string {
  const dir =
    explicitDir ?? process.env.OC_REMOTE_CUTOVER_SNAPSHOT_DIR ?? DEFAULT_CUTOVER_SNAPSHOT_DIR
  need(typeof dir === 'string' && dir.trim().length > 0, 'REMOTE_CUTOVER_SNAPSHOT_DIR_INVALID')
  return dir
}

function writeAtomicCutoverSnapshot(
  snapshotDir: string,
  profileId: string,
  convertedGeneration: string,
  backup: LegacyProfileCutoverBackup,
): { uri: string; sha256: string } {
  mkdirSync(snapshotDir, { recursive: true, mode: 0o700 })
  const dirSt = lstatSync(snapshotDir)
  need(dirSt.isDirectory() && !dirSt.isSymbolicLink(), 'REMOTE_CUTOVER_SNAPSHOT_DIR_UNSAFE')
  if (typeof process.getuid === 'function' && dirSt.uid === process.getuid()) {
    chmodSync(snapshotDir, 0o700)
  }
  const fileName = `cutover-${profileId}-gen-${convertedGeneration}.json`
  const finalPath = join(snapshotDir, fileName)
  const tmpPath = join(snapshotDir, `.${fileName}.${process.pid}.${randomUUID()}.tmp`)
  const serialized = `${JSON.stringify(backup, null, 2)}\n`
  try {
    writeFileSync(tmpPath, serialized, { mode: 0o600, flag: 'wx' })
    chmodSync(tmpPath, 0o600)
    renameSync(tmpPath, finalPath)
  } catch (err) {
    rmSync(tmpPath, { force: true })
    throw err
  }
  const readBack = readFileSync(finalPath)
  const sha256 = createHash('sha256').update(readBack).digest('hex')
  return { uri: finalPath, sha256 }
}

function readVerifiedCutoverSnapshot(
  uri: string,
  expectedSha256: string,
): LegacyProfileCutoverBackup {
  need(SHA256_RE.test(expectedSha256), 'REMOTE_REVERT_SNAPSHOT_CORRUPT')
  let parsed: unknown
  try {
    const st = lstatSync(uri)
    need(st.isFile() && !st.isSymbolicLink(), 'REMOTE_REVERT_SNAPSHOT_CORRUPT')
    const raw = readFileSync(uri)
    const actualSha = createHash('sha256').update(raw).digest('hex')
    need(actualSha === expectedSha256, 'REMOTE_REVERT_SNAPSHOT_CORRUPT')
    parsed = JSON.parse(raw.toString('utf8'))
  } catch {
    throw new Error('REMOTE_REVERT_SNAPSHOT_CORRUPT')
  }
  need(
    parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed),
    'REMOTE_REVERT_SNAPSHOT_CORRUPT',
  )
  return parsed as LegacyProfileCutoverBackup
}

/**
 * Computes the canonical SHA-256 suite digest across `scripts/agent-remote/conformance/`
 * matching `compute_suite_digest` in `scripts/agent-remote/conformance/run.py`.
 */
export function computeProductionConformanceSuiteDigest(
  repoRoot: string = defaultRepoRoot(),
): string {
  const confDir = join(repoRoot, 'scripts/agent-remote/conformance')
  const h = createHash('sha256')
  for (const name of CONFORMANCE_SUITE_FILES) {
    const filePath = join(confDir, name)
    const st = lstatSync(filePath)
    need(st.isFile() && !st.isSymbolicLink(), 'REMOTE_CONFORMANCE_FILE_UNSAFE')
    const fileDigest = createHash('sha256').update(readFileSync(filePath)).digest()
    h.update(`${name}\0`, 'utf8')
    h.update(fileDigest)
  }
  return h.digest('hex')
}

export interface LegacyProfileCutoverBackup {
  readonly driverId: string | null
  readonly engineId: string | null
  readonly engine: string
  readonly runnerMode: string | null
  readonly modDigest: string | null
  readonly lastProbeOkAt: string | null
  readonly executionReady: boolean
  readonly authEpoch: string | null
  readonly verifiedFingerprint: string | null
  readonly cliVersion: string | null
  readonly status: string
  readonly lastError: string | null
  readonly probeSnapshot: unknown
  readonly executionManifest: unknown
  readonly discoveredModels: unknown
  readonly readyGeneration: string
  readonly preCutoverReadyGeneration: string
}

export interface ConvertProfileToDriverV4Input {
  readonly profileId: string
  readonly driverId: string
  readonly targetFingerprint: string
  readonly suiteDigest?: string
  readonly policySha256: string
  readonly probeSnapshot: RemoteProbeSnapshot
  readonly authEpoch?: string
  readonly driverContext?: Record<string, unknown>
  readonly expectedReadyGeneration?: string | bigint | number
  readonly registryPath?: string
  readonly snapshotDir?: string
}

export interface ConvertProfileToDriverV4Result {
  readonly profileId: string
  readonly driverId: string
  readonly readyGeneration: string
  readonly targetFingerprint: string
  readonly executionReady: false
  readonly verificationRunId: string
  readonly suiteDigest: string
  readonly cutoverPreSnapshotUri: string
  readonly cutoverPreSnapshotSha256: string
  readonly legacyBackup: LegacyProfileCutoverBackup
}

/**
 * Atomically converts an idle legacy profile (`driver_id IS NULL`) to `driver-v4` with CAS.
 * Stores an atomic pre-cutover snapshot file, sets `execution_ready = FALSE` and
 * `verified_fingerprint = NULL`, and enqueues a pending verification run; only passing
 * `completeProductionDriverVerificationRun` may flip `execution_ready = TRUE`.
 */
export async function convertProfileToDriverV4(
  pool: Pool,
  input: ConvertProfileToDriverV4Input,
): Promise<ConvertProfileToDriverV4Result> {
  need(UUID_RE.test(input.profileId), 'REMOTE_PROFILE_ID_INVALID')
  need(SHA256_RE.test(input.targetFingerprint), 'REMOTE_CUTOVER_FINGERPRINT_INVALID')
  need(SHA256_RE.test(input.policySha256), 'REMOTE_CUTOVER_POLICY_DIGEST_INVALID')

  const regMap = loadRemoteDriverRegistry(input.registryPath)
  const reg = regMap.get(input.driverId)
  need(reg !== undefined, 'REMOTE_DRIVER_NOT_REGISTERED')

  const snapshot = validateRemoteProbeSnapshot(input.probeSnapshot)
  need(
    snapshot.driverId === reg.driverId &&
      snapshot.engineId === reg.engineId &&
      snapshot.driverVersion === reg.driverVersion,
    'REMOTE_CUTOVER_ENGINE_MISMATCH',
  )
  need(
    snapshot.authPresent === true &&
      snapshot.accountObserved === true &&
      snapshot.models.length > 0,
    'REMOTE_CUTOVER_UNHEALTHY_PROBE',
  )

  const expectedFp = computeProbeFingerprintTs(snapshot, {
    driverDigest: reg.driverDigest,
    coreDigest: reg.coreDigest,
    policySha256: input.policySha256,
  })
  need(expectedFp === input.targetFingerprint, 'REMOTE_CUTOVER_FINGERPRINT_MISMATCH')

  const suiteDigest = input.suiteDigest ?? computeProductionConformanceSuiteDigest()
  need(SHA256_RE.test(suiteDigest), 'REMOTE_CUTOVER_SUITE_DIGEST_INVALID')

  const snapshotDir = resolveSnapshotDir(input.snapshotDir)
  let writtenSnapshotUri: string | null = null
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const profRes = await client.query<Record<string, any>>(
      `SELECT p.*, n.disabled_by AS node_disabled_by, n.status AS node_status
         FROM remote_agent_profiles p
         JOIN remote_agent_nodes n ON n.id = p.node_id
        WHERE p.id = $1
        FOR UPDATE OF p`,
      [input.profileId],
    )
    need(profRes.rows.length === 1, 'REMOTE_PROFILE_NOT_FOUND')
    const row = profRes.rows[0]!

    need(row.driver_id === null, 'REMOTE_CUTOVER_ALREADY_V4')
    need(
      String(row.engine) === legacyProfileEngineForAuthority(reg.authorityEngine),
      'REMOTE_CUTOVER_ENGINE_MISMATCH',
    )
    if (input.expectedReadyGeneration !== undefined) {
      need(
        BigInt(row.ready_generation) === BigInt(input.expectedReadyGeneration),
        'REMOTE_CUTOVER_CAS_GENERATION_MISMATCH',
      )
    }
    need(
      row.disabled_by !== 'admin' && row.node_disabled_by !== 'admin',
      'REMOTE_CUTOVER_ADMIN_DISABLED',
    )
    need(['active', 'degraded'].includes(String(row.status)), 'REMOTE_CUTOVER_PROFILE_NOT_SERVABLE')

    const busyRes = await client.query(
      `SELECT 1 FROM remote_agent_bindings
        WHERE profile_id = $1 AND state <> 'released'
        LIMIT 1`,
      [input.profileId],
    )
    need(busyRes.rows.length === 0, 'REMOTE_CUTOVER_PROFILE_BUSY')

    const cutoverFromGeneration = String(row.ready_generation)
    const convertedGeneration = (BigInt(row.ready_generation) + 1n).toString()
    const legacyBackup: LegacyProfileCutoverBackup = {
      driverId: row.driver_id ? String(row.driver_id) : null,
      engineId: row.engine_id ? String(row.engine_id) : null,
      engine: String(row.engine),
      runnerMode: row.runner_mode ? String(row.runner_mode) : null,
      modDigest: row.mod_digest ? String(row.mod_digest) : null,
      lastProbeOkAt: row.last_probe_ok_at ? new Date(row.last_probe_ok_at).toISOString() : null,
      executionReady: row.execution_ready === true,
      authEpoch: row.auth_epoch ? String(row.auth_epoch) : null,
      verifiedFingerprint: row.verified_fingerprint ? String(row.verified_fingerprint) : null,
      cliVersion: row.cli_version ? String(row.cli_version) : null,
      status: String(row.status),
      lastError: row.last_error ? String(row.last_error) : null,
      probeSnapshot: row.probe_snapshot ?? null,
      executionManifest: row.execution_manifest ?? {},
      discoveredModels: row.discovered_models ?? [],
      readyGeneration: cutoverFromGeneration,
      preCutoverReadyGeneration: cutoverFromGeneration,
    }

    const written = writeAtomicCutoverSnapshot(
      snapshotDir,
      input.profileId,
      convertedGeneration,
      legacyBackup,
    )
    writtenSnapshotUri = written.uri

    const discoveredModels = snapshot.models.map((m) => ({
      upstream_model_id: m.upstreamModelId,
      display_name: m.displayName,
      supported_reasoning_efforts: m.supportedEfforts,
      default_reasoning_effort: m.defaultEffort,
      supports_adaptive_thinking: m.supportsAdaptiveThinking,
      supports_vision: m.supportsVision,
    }))
    const effectiveAuthEpoch =
      input.authEpoch !== undefined
        ? input.authEpoch
        : row.auth_epoch
          ? String(row.auth_epoch)
          : null
    const nextManifest = {
      version: REMOTE_DRIVER_PROTOCOL_VERSION,
      backendKind: REMOTE_DRIVER_BACKEND,
      driverId: reg.driverId,
      engineId: reg.engineId,
      driverVersion: reg.driverVersion,
      driverDigest: reg.driverDigest,
      coreDigest: reg.coreDigest,
      policySha256: input.policySha256,
      suiteDigest,
      latestFingerprint: expectedFp,
      cutoverPreSnapshotUri: written.uri,
      cutoverPreSnapshotSha256: written.sha256,
      cutoverFromGeneration,
      convertedGeneration,
      ...(input.driverContext ? { driverContext: input.driverContext } : {}),
      legacyCutoverBackup: legacyBackup,
    }

    const updated = await client.query<{ ready_generation: string }>(
      `UPDATE remote_agent_profiles
          SET driver_id = $2,
              engine_id = $3,
              cli_version = $4,
              execution_ready = FALSE,
              verified_fingerprint = NULL,
              ready_generation = ready_generation + 1,
              auth_epoch = COALESCE($5, auth_epoch),
              probe_snapshot = $6::jsonb,
              execution_manifest = $7::jsonb,
              discovered_models = $8::jsonb,
              last_probe_ok_at = NOW(),
              last_error = NULL,
              updated_at = NOW()
        WHERE id = $1
          AND driver_id IS NULL
          AND ready_generation = $9
          AND (disabled_by IS NULL OR disabled_by <> 'admin')
      RETURNING ready_generation::text AS ready_generation`,
      [
        input.profileId,
        reg.driverId,
        reg.engineId,
        snapshot.cliVersion,
        input.authEpoch ?? null,
        JSON.stringify(snapshot),
        JSON.stringify(nextManifest),
        JSON.stringify(discoveredModels),
        row.ready_generation,
      ],
    )
    need(updated.rows.length === 1, 'REMOTE_CUTOVER_CAS_FAILED')

    await client.query(
      `UPDATE remote_driver_verification_runs
          SET state = 'superseded',
              error_code = COALESCE(error_code, 'SUPERSEDED_BY_CUTOVER'),
              completed_at = COALESCE(completed_at, NOW()),
              updated_at = NOW()
        WHERE profile_id = $1
          AND state IN ('pending', 'running')`,
      [input.profileId],
    )

    const verifIns = await client.query<{ id: string }>(
      `INSERT INTO remote_driver_verification_runs
         (node_id, profile_id, engine_id, driver_id, target_fingerprint,
          driver_digest, core_digest, suite_digest, ready_generation,
          auth_epoch, auto_eligible, state)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE, 'pending')
       RETURNING id::text AS id`,
      [
        row.node_id,
        input.profileId,
        reg.engineId,
        reg.driverId,
        expectedFp,
        reg.driverDigest,
        reg.coreDigest,
        suiteDigest,
        updated.rows[0]!.ready_generation,
        effectiveAuthEpoch,
      ],
    )

    await client.query('COMMIT')
    return {
      profileId: input.profileId,
      driverId: reg.driverId,
      readyGeneration: updated.rows[0]!.ready_generation,
      targetFingerprint: expectedFp,
      executionReady: false,
      verificationRunId: verifIns.rows[0]!.id,
      suiteDigest,
      cutoverPreSnapshotUri: written.uri,
      cutoverPreSnapshotSha256: written.sha256,
      legacyBackup,
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    if (writtenSnapshotUri) {
      rmSync(writtenSnapshotUri, { force: true })
    }
    throw err
  } finally {
    client.release()
  }
}

export interface RevertDriverV4ProfileInput {
  readonly profileId: string
  readonly expectedMinReadyGeneration: string | bigint | number
  readonly legacyBackup?: LegacyProfileCutoverBackup
  readonly allowEmbeddedBackupFallback?: boolean
}

export interface RevertDriverV4ProfileResult {
  readonly profileId: string
  readonly readyGeneration: string
}

/**
 * Reverts a `driver-v4` profile back to legacy (`driver_id = NULL`) via monotonic CAS
 * (`ready_generation` always increments and never rolls backward) once all bindings are released.
 * Verifies the on-disk pre-cutover snapshot SHA-256 fail-closed unless
 * `allowEmbeddedBackupFallback: true` is explicitly supplied for emergency tests.
 */
export async function revertDriverV4ProfileToLegacy(
  pool: Pool,
  input: RevertDriverV4ProfileInput,
): Promise<RevertDriverV4ProfileResult> {
  need(UUID_RE.test(input.profileId), 'REMOTE_PROFILE_ID_INVALID')

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const profRes = await client.query<Record<string, any>>(
      'SELECT * FROM remote_agent_profiles WHERE id = $1 FOR UPDATE',
      [input.profileId],
    )
    need(profRes.rows.length === 1, 'REMOTE_PROFILE_NOT_FOUND')
    const row = profRes.rows[0]!

    need(row.driver_id !== null, 'REMOTE_REVERT_NOT_V4')
    need(
      BigInt(row.ready_generation) >= BigInt(input.expectedMinReadyGeneration),
      'REMOTE_REVERT_CAS_GENERATION_MISMATCH',
    )

    const busyRes = await client.query(
      `SELECT 1 FROM remote_agent_bindings
        WHERE profile_id = $1 AND state <> 'released'
        LIMIT 1`,
      [input.profileId],
    )
    need(busyRes.rows.length === 0, 'REMOTE_REVERT_ACTIVE_BINDINGS_EXIST')

    const manifestObj =
      row.execution_manifest && typeof row.execution_manifest === 'object'
        ? (row.execution_manifest as Record<string, unknown>)
        : {}

    const preUri =
      typeof manifestObj.cutoverPreSnapshotUri === 'string'
        ? manifestObj.cutoverPreSnapshotUri
        : undefined
    const preSha =
      typeof manifestObj.cutoverPreSnapshotSha256 === 'string'
        ? manifestObj.cutoverPreSnapshotSha256
        : ''

    let fileBackup: LegacyProfileCutoverBackup | undefined
    if (preUri !== undefined) {
      try {
        fileBackup = readVerifiedCutoverSnapshot(preUri, preSha)
      } catch (err) {
        if (!input.allowEmbeddedBackupFallback) {
          throw err
        }
      }
    }

    const backup =
      input.legacyBackup ??
      fileBackup ??
      (manifestObj.legacyCutoverBackup as LegacyProfileCutoverBackup | undefined)
    need(backup !== undefined && typeof backup === 'object', 'REMOTE_REVERT_BACKUP_MISSING')

    const casRes = await client.query<{ ready_generation: string }>(
      `UPDATE remote_agent_profiles
          SET driver_id = NULL,
              engine_id = NULL,
              runner_mode = COALESCE($2, runner_mode),
              mod_digest = $3,
              last_probe_ok_at = $4::timestamptz,
              verified_fingerprint = $5,
              execution_ready = $6,
              auth_epoch = $7,
              cli_version = $8,
              status = $9,
              last_error = $10,
              probe_snapshot = $11::jsonb,
              execution_manifest = $12::jsonb,
              discovered_models = $13::jsonb,
              ready_generation = ready_generation + 1,
              updated_at = NOW()
        WHERE id = $1
          AND driver_id IS NOT NULL
          AND ready_generation = $14
      RETURNING ready_generation::text AS ready_generation`,
      [
        input.profileId,
        backup.runnerMode ?? null,
        backup.modDigest ?? null,
        backup.lastProbeOkAt ? new Date(backup.lastProbeOkAt).toISOString() : null,
        backup.verifiedFingerprint ?? null,
        backup.executionReady === true,
        backup.authEpoch ?? null,
        backup.cliVersion ?? null,
        backup.status ?? 'active',
        backup.lastError ?? null,
        backup.probeSnapshot === undefined ? null : JSON.stringify(backup.probeSnapshot),
        JSON.stringify(backup.executionManifest ?? {}),
        JSON.stringify(backup.discoveredModels ?? []),
        row.ready_generation,
      ],
    )
    need(casRes.rows.length === 1, 'REMOTE_REVERT_CAS_FAILED')

    await client.query(
      `UPDATE remote_driver_verification_runs
          SET state = 'superseded',
              error_code = COALESCE(error_code, 'REVERTED_TO_LEGACY'),
              completed_at = COALESCE(completed_at, NOW()),
              updated_at = NOW()
        WHERE profile_id = $1
          AND state IN ('pending', 'running')`,
      [input.profileId],
    )

    await client.query('COMMIT')
    return {
      profileId: input.profileId,
      readyGeneration: casRes.rows[0]!.ready_generation,
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}
