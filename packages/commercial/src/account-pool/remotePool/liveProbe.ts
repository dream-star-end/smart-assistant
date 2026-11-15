/**
 * Live probe helper for `remote-driver-v4` profiles (`OCV5-749`, R11 & R12).
 *
 * `probeRemoteDriverProfileLive` remains strictly `dryRun = true` in CLI (`R11`), while
 * `executeLiveRemoteDriverProbe` exposes the full probe output + `nonBlobDriverContext`
 * for `commissioningService.ts` and `driftScheduler.ts` (`R12`).
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RemoteCcTarget } from '@openclaude/gateway/cc5-container-runtime'
import {
  DriverWorkerClient,
  RemotePoolProbeHost,
  type RemotePoolProbeOutput,
  type RemotePoolProbeSpec,
} from '@openclaude/gateway/remote-pool'
import type { RemoteProbeSnapshot } from '@openclaude/protocol'
import type { Pool } from 'pg'
import { remoteNodeExecKeyDir } from '../remoteBrainPool.js'
import { computeProbeFingerprintTs } from './driftCoordinator.js'
import {
  buildBridgeFilesForDriver,
  buildDefaultDriverContextForNode,
} from './modelResolution.js'
import { resolveRemoteDriverV4ExecKeyPath } from './placement.js'
import { loadRemoteDriverRegistry } from './registry.js'

const UUID_RE = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i

function need(condition: unknown, code = 'REMOTE_LIVE_PROBE_INVALID'): asserts condition {
  if (!condition) throw new Error(code)
}

export interface ProbeRemoteDriverProfileLiveInput {
  readonly profileId: string
  readonly driverId?: string
  readonly dryRun?: boolean
  readonly driverContext?: Record<string, unknown>
  readonly keyDir?: string
  readonly registryPath?: string
}

export interface ProbeRemoteDriverProfileLiveOptions {
  readonly probeHostFactory?: (
    target: RemoteCcTarget,
    spec: RemotePoolProbeSpec,
  ) => { probe(context: Record<string, unknown>): Promise<RemotePoolProbeOutput> }
}

export interface ProbeRemoteDriverProfileLiveResult {
  readonly dryRun: true
  readonly profileId: string
  readonly nodeId: string
  readonly driverId: string
  readonly engineId: string
  readonly probeFingerprint: string
  readonly driverDigest: string
  readonly coreDigest: string
  readonly policySha256: string
  readonly snapshot: RemoteProbeSnapshot
  readonly matchedVerifiedFingerprint: boolean
}

export interface ExecuteLiveRemoteDriverProbeResult {
  readonly profileRow: Record<string, any>
  readonly profileId: string
  readonly nodeId: string
  readonly driverId: string
  readonly engineId: string
  readonly probeFingerprint: string
  readonly driverDigest: string
  readonly coreDigest: string
  readonly policySha256: string
  readonly snapshot: RemoteProbeSnapshot
  readonly matchedVerifiedFingerprint: boolean
  readonly nonBlobDriverContext: Record<string, unknown>
}

export async function executeLiveRemoteDriverProbe(
  pool: Pool,
  input: Omit<ProbeRemoteDriverProfileLiveInput, 'dryRun'>,
  options: ProbeRemoteDriverProfileLiveOptions = {},
): Promise<ExecuteLiveRemoteDriverProbeResult> {
  need(UUID_RE.test(input.profileId), 'REMOTE_PROFILE_ID_INVALID')

  const res = await pool.query<Record<string, any>>(
    `SELECT p.*, n.ssh_host, n.ssh_port, n.ssh_user, n.host_key_fp, n.key_id
       FROM remote_agent_profiles p
       JOIN remote_agent_nodes n ON n.id = p.node_id
      WHERE p.id = $1`,
    [input.profileId],
  )
  need(res.rows.length === 1, 'REMOTE_PROFILE_NOT_FOUND')
  const row = res.rows[0]!

  if (row.driver_id && input.driverId && String(row.driver_id) !== input.driverId) {
    throw new Error('REMOTE_PROFILE_DRIVER_MISMATCH')
  }
  const driverId =
    (row.driver_id ? String(row.driver_id) : undefined) ??
    input.driverId ??
    (row.engine === 'codex' ? 'codex' : row.engine === 'cc' ? 'cc' : '')
  const regMap = loadRemoteDriverRegistry(input.registryPath)
  const reg = regMap.get(driverId)
  need(reg !== undefined, 'REMOTE_DRIVER_NOT_REGISTERED')

  const keyId = String(row.key_id)
  const execDir = remoteNodeExecKeyDir(keyId, input.keyDir)
  const sshUser = String(row.ssh_user)
  const safeDriverSlug = reg.driverId.replaceAll('_', '-')
  const home = sshUser === 'root' ? '/root' : `/home/${sshUser}`
  const probeRoot = `${home}/oc-remotedrv-probe-${safeDriverSlug.slice(0, 12)}-${randomUUID().replace(/-/g, '').slice(0, 16)}`
  const controllerPath = `/opt/openclaude/remote-driver/${reg.controllerSha256}/core/controller.py`

  const firstOfferModel = (
    await pool.query<{ upstream_model_id: string }>(
      `SELECT upstream_model_id FROM remote_model_offers
        WHERE profile_id = $1 AND enabled = TRUE
        ORDER BY updated_at DESC LIMIT 1`,
      [input.profileId],
    )
  ).rows[0]?.upstream_model_id

  const sshTarget: RemoteCcTarget = Object.freeze({
    host: String(row.ssh_host),
    port: Number(row.ssh_port ?? 22),
    user: sshUser,
    keyPath: resolveRemoteDriverV4ExecKeyPath(keyId, reg.driverId, input.keyDir),
    knownHostsPath: join(execDir, 'known_hosts'),
    controllerSha256: reg.controllerSha256,
    taskRootPrefix: `${home}/oc-remotedrv-`,
    upstreamModel: firstOfferModel ?? (reg.driverId === 'codex' ? 'gpt-6-luna' : 'claude-sonnet-5'),
  })

  const probeSpec: RemotePoolProbeSpec = Object.freeze({
    controllerPath,
    controllerSha256: reg.controllerSha256,
    driverId: reg.driverId,
    profileId: String(row.profile_name),
    probeRoot,
    ...(input.registryPath ? { registryPath: input.registryPath } : {}),
  })

  const execManifest =
    row.execution_manifest && typeof row.execution_manifest === 'object'
      ? (row.execution_manifest as Record<string, unknown>)
      : {}
  const manifestDriverCtx =
    execManifest.driverContext && typeof execManifest.driverContext === 'object'
      ? (execManifest.driverContext as Record<string, unknown>)
      : {}
  const profileName = String(row.profile_name)
  const defaultDriverProbeCtx = buildDefaultDriverContextForNode({
    driverId: reg.driverId,
    sshUser,
    profileName,
    controllerSha256: reg.controllerSha256,
    includeBridgeFiles: false,
  })
  const bridgeFiles = buildBridgeFilesForDriver(reg.driverId)
  const mergedWithoutBridgeFiles: Record<string, unknown> = {
    ...defaultDriverProbeCtx,
    ...manifestDriverCtx,
    ...(input.driverContext ?? {}),
  }
  const { bridgeFiles: _strippedBridgeFiles, ...probeContext } = mergedWithoutBridgeFiles

  const probeHost = options.probeHostFactory
    ? options.probeHostFactory(sshTarget, probeSpec)
    : RemotePoolProbeHost.forSshTarget(sshTarget, probeSpec)
  const probed = await probeHost.probe(probeContext)
  need(probed.snapshot.driverId === reg.driverId, 'REMOTE_PROBE_DRIVER_MISMATCH')
  need(probed.driverDigest === reg.driverDigest, 'REMOTE_PROBE_DRIVER_DIGEST_MISMATCH')
  need(probed.coreDigest === reg.coreDigest, 'REMOTE_PROBE_CORE_DIGEST_MISMATCH')
  need(probed.snapshot.models.length > 0, 'REMOTE_PROBE_NO_MODELS_OBSERVED')

  const defaultCtxAfterProbe = buildDefaultDriverContextForNode({
    driverId: reg.driverId,
    sshUser,
    profileName,
    controllerSha256: reg.controllerSha256,
    cliVersion: probed.snapshot.cliVersion,
    includeBridgeFiles: false,
  })
  const { bridgeFiles: _stripped2, ...nonBlobDriverContext } = {
    ...defaultCtxAfterProbe,
    ...manifestDriverCtx,
    ...(input.driverContext ?? {}),
  }

  const policyTempDir = mkdtempSync(join(tmpdir(), 'oc-r11-probe-policy-'))
  const worker = new DriverWorkerClient(
    input.registryPath ? { registryPath: input.registryPath } : {},
  )
  try {
    const sampleRoot = join(policyTempDir, 'run-policy-sample')
    const codexHome = join(policyTempDir, 'codex-home')
    const systemCodexRoot = join(policyTempDir, 'etc-codex')
    mkdirSync(join(sampleRoot, 'cwd'), { recursive: true })
    mkdirSync(codexHome, { recursive: true })
    mkdirSync(systemCodexRoot, { recursive: true })
    writeFileSync(join(codexHome, 'auth.json'), '{}')

    const sampleModel = probed.snapshot.models[0]!.upstreamModelId
    const policySampleCtx: Record<string, unknown> = {
      ...nonBlobDriverContext,
      ...(bridgeFiles ? { bridgeFiles } : {}),
      cliPath:
        typeof nonBlobDriverContext.cliPath === 'string'
          ? nonBlobDriverContext.cliPath
          : reg.driverId === 'codex'
            ? '/usr/bin/codex'
            : '/usr/bin/claude',
      codexHome,
      systemCodexRoot,
      modelCatalog: {
        models: probed.snapshot.models.map((m) => ({ slug: m.upstreamModelId })),
      },
      root: sampleRoot,
      model: sampleModel,
      operationId: randomUUID(),
      tools: {
        tools: [{ name: 'Write', description: 'Write file', inputSchema: { type: 'object' } }],
      },
    }
    const specSample = await worker.launchSpec(reg.driverId, policySampleCtx, probed.snapshot)
    const policySha256 = String(specSample.policySha256 ?? '')
    need(/^[a-f0-9]{64}$/.test(policySha256), 'REMOTE_POLICY_SHA256_INVALID')

    const probeFingerprint = computeProbeFingerprintTs(probed.snapshot, {
      driverDigest: reg.driverDigest,
      coreDigest: reg.coreDigest,
      policySha256,
    })
    need(probeFingerprint === probed.probeFingerprint, 'REMOTE_PROBE_FINGERPRINT_MISMATCH')

    return {
      profileRow: row,
      profileId: String(row.id),
      nodeId: String(row.node_id),
      driverId: reg.driverId,
      engineId: reg.engineId,
      probeFingerprint,
      driverDigest: reg.driverDigest,
      coreDigest: reg.coreDigest,
      policySha256,
      snapshot: probed.snapshot,
      matchedVerifiedFingerprint: row.verified_fingerprint === probeFingerprint,
      nonBlobDriverContext,
    }
  } finally {
    await worker.close().catch(() => {})
    rmSync(policyTempDir, { recursive: true, force: true })
  }
}

/**
 * Executes a read-only probe for a DB profile without persisting any probe snapshot or cutover state.
 * In R11, `dryRun: false` is explicitly disabled fail-closed (`REMOTE_LIVE_PROBE_WRITE_DISABLED_IN_R11`).
 */
export async function probeRemoteDriverProfileLive(
  pool: Pool,
  input: ProbeRemoteDriverProfileLiveInput,
  options: ProbeRemoteDriverProfileLiveOptions = {},
): Promise<ProbeRemoteDriverProfileLiveResult> {
  if (input.dryRun === false) {
    throw new Error('REMOTE_LIVE_PROBE_WRITE_DISABLED_IN_R11')
  }
  const result = await executeLiveRemoteDriverProbe(pool, input, options)
  return {
    dryRun: true,
    profileId: result.profileId,
    nodeId: result.nodeId,
    driverId: result.driverId,
    engineId: result.engineId,
    probeFingerprint: result.probeFingerprint,
    driverDigest: result.driverDigest,
    coreDigest: result.coreDigest,
    policySha256: result.policySha256,
    snapshot: result.snapshot,
    matchedVerifiedFingerprint: result.matchedVerifiedFingerprint,
  }
}
