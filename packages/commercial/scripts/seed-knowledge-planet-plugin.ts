#!/usr/bin/env tsx
/** Deploy-only exact-image smoke and idempotent official Knowledge Planet Plugin seed. */

import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import Docker from 'dockerode'
import IORedis from 'ioredis'

import { closePool, getPool } from '../src/db/index.js'
import { query } from '../src/db/queries.js'
import {
  findApprovedKnowledgePlanetPluginForDeploy,
  seedKnowledgePlanetPlugin,
} from '../src/marketplace/seedKnowledgePlanetPlugin.js'
import { ManagedBrowserRuntime } from '../src/plugins/browserRuntime.js'
import {
  COMPILED_KNOWLEDGE_PLANET_PLUGIN,
  KNOWLEDGE_PLANET_PLUGIN_CONTRACT,
  KNOWLEDGE_PLANET_WORKER_DIGEST,
  KnowledgePlanetDockerService,
  createKnowledgePlanetRuntimeRegistries,
  validateKnowledgePlanetAccountState,
} from '../src/plugins/knowledgePlanet.js'
import { resolveKnowledgePlanetLoginPins } from '../src/plugins/knowledgePlanetSetup.js'
import { runKnowledgePlanetActionSmoke } from '../src/plugins/knowledgePlanetSmoke.js'
import {
  closeOfficialManagedBrowserPluginListingGate,
  openOfficialManagedBrowserPluginListingGate,
  transitionOfficialManagedBrowserPluginVersion,
} from '../src/plugins/officialManagedBrowserTransition.js'
import { loadVerifiedRuntimePluginContract } from '../src/plugins/review.js'

const IMAGE_ID_RE = /^sha256:[0-9a-f]{64}$/
const EVIDENCE_PATH = '/run/openclaude-v5/knowledge-planet-plugin-smoke.json'
const QR_PATH = '/run/openclaude-v5/knowledge-planet-plugin-smoke-qr.png'
const EVIDENCE_TTL_MS = 10 * 60_000
const QR_DEADLINE_MS = 4 * 60_000
const RELEASES_ROOT = '/opt/openclaude/openclaude-v5-releases'

interface SmokeEvidence {
  schemaVersion: 2
  artifactHash: string
  execContractHash: string
  workerDigest: string
  imageId: string
  smokedAt: string
  verification: 'authenticated-action-smoke' | 'existing-platform-approval'
  passedActionIds: string[]
  qrRendered: true
  cleanupVerified: true
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
}

function imageIdFromEnv(): string {
  if (process.env.OC_RUNTIME_CHANNEL !== 'v5')
    throw new Error('Knowledge Planet Plugin deploy gate is V5-only')
  const imageId = process.env.OC_RUNTIME_IMAGE_ID?.trim() ?? ''
  if (!IMAGE_ID_RE.test(imageId))
    throw new Error('OC_RUNTIME_IMAGE_ID must be an exact sha256 image ID')
  return imageId
}

function dockerClient(): Docker {
  const socketPath = process.env.AGENT_DOCKER_SOCKET?.trim()
  return socketPath ? new Docker({ socketPath }) : new Docker()
}

async function inspectExactImage(docker: Docker, imageId: string): Promise<void> {
  const image = await docker
    .getImage(imageId)
    .inspect()
    .catch(() => null)
  if (!image || image.Id !== imageId) throw new Error('exact runtime image is unavailable')
}

async function ensurePrivateRoot(): Promise<string> {
  const root = dirname(EVIDENCE_PATH)
  await mkdir(root, { recursive: true, mode: 0o700 })
  let rootStat = await lstat(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== 0)
    throw new Error('Plugin smoke evidence root is unsafe')
  await chmod(root, 0o700)
  rootStat = await lstat(root)
  if ((rootStat.mode & 0o777) !== 0o700) throw new Error('Plugin smoke evidence root is unsafe')
  return root
}

async function writePrivateFile(path: string, body: Buffer | string): Promise<void> {
  const root = await ensurePrivateRoot()
  if (dirname(path) !== root) throw new Error('Plugin smoke file path is unsafe')
  const temporary = `${path}.tmp-${randomUUID()}`
  const file = await open(temporary, 'wx', 0o600)
  try {
    await file.writeFile(body)
    await file.sync()
  } finally {
    await file.close()
  }
  try {
    await chmod(temporary, 0o600)
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o777) !== 0o600)
    throw new Error('Plugin smoke file is unsafe')
}

async function writeEvidence(evidence: SmokeEvidence): Promise<void> {
  await writePrivateFile(EVIDENCE_PATH, `${JSON.stringify(evidence)}\n`)
}

async function writeQr(png: Buffer): Promise<void> {
  if (
    png.length < 8 ||
    png.length > 512 * 1024 ||
    !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    throw new Error('Knowledge Planet QR is not a bounded PNG')
  await writePrivateFile(QR_PATH, png)
}

async function readEvidence(imageId: string, now = Date.now()): Promise<SmokeEvidence> {
  const stat = await lstat(EVIDENCE_PATH).catch(() => null)
  if (
    !stat ||
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== 0 ||
    (stat.mode & 0o777) !== 0o600
  )
    throw new Error('valid Knowledge Planet Plugin smoke evidence is required')
  let value: unknown
  try {
    value = JSON.parse(await readFile(EVIDENCE_PATH, 'utf8'))
  } catch {
    throw new Error('Knowledge Planet Plugin smoke evidence is invalid')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Knowledge Planet Plugin smoke evidence is invalid')
  const evidence = value as Record<string, unknown>
  if (
    !exactKeys(evidence, [
      'schemaVersion',
      'artifactHash',
      'execContractHash',
      'workerDigest',
      'imageId',
      'smokedAt',
      'verification',
      'passedActionIds',
      'qrRendered',
      'cleanupVerified',
    ]) ||
    evidence.schemaVersion !== 2 ||
    evidence.artifactHash !== COMPILED_KNOWLEDGE_PLANET_PLUGIN.artifactHash ||
    evidence.execContractHash !== COMPILED_KNOWLEDGE_PLANET_PLUGIN.execContractHash ||
    evidence.workerDigest !== KNOWLEDGE_PLANET_WORKER_DIGEST ||
    evidence.imageId !== imageId ||
    !['authenticated-action-smoke', 'existing-platform-approval'].includes(
      String(evidence.verification),
    ) ||
    !Array.isArray(evidence.passedActionIds) ||
    evidence.passedActionIds.join('\0') !==
      KNOWLEDGE_PLANET_PLUGIN_CONTRACT.actions.map((action) => action.id).join('\0') ||
    evidence.qrRendered !== true ||
    evidence.cleanupVerified !== true ||
    typeof evidence.smokedAt !== 'string'
  )
    throw new Error('Knowledge Planet Plugin smoke evidence does not match this artifact/image')
  const smokedAt = Date.parse(evidence.smokedAt)
  if (!Number.isFinite(smokedAt) || smokedAt > now + 30_000 || now - smokedAt > EVIDENCE_TTL_MS)
    throw new Error('Knowledge Planet Plugin smoke evidence expired')
  return evidence as unknown as SmokeEvidence
}

async function beforeDeadline<T>(
  promise: Promise<T>,
  deadlineMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), Math.max(1, deadlineMs - Date.now()))
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

async function smokeOnly(): Promise<void> {
  const imageId = imageIdFromEnv()
  const docker = dockerClient()
  await inspectExactImage(docker, imageId)
  const alreadyApproved =
    (await findApprovedKnowledgePlanetPluginForDeploy(process.env)) !== null
  const service = new KnowledgePlanetDockerService(docker, {
    imageId,
    workerRoot: '/var/lib/openclaude-v5/plugin-workers',
    brokerRoot: '/run/openclaude-v5/plugin-browser-brokers',
    expectedOwnerUid: 0,
    socketUid: 1000,
    socketGid: 1000,
  })
  const sessionId = randomUUID()
  const deadlineMs = Date.now() + QR_DEADLINE_MS
  let handle: Awaited<ReturnType<KnowledgePlanetDockerService['startLogin']>> | null = null
  let qrResolve!: () => void
  let qrReject!: (error: Error) => void
  const qrReady = new Promise<void>((resolve, reject) => {
    qrResolve = resolve
    qrReject = reject
  })
  void qrReady.catch(() => {})
  let authenticationResolve!: (
    state: ReturnType<typeof validateKnowledgePlanetAccountState>,
  ) => void
  let authenticationReject!: (error: Error) => void
  const authenticated = new Promise<ReturnType<typeof validateKnowledgePlanetAccountState>>(
    (resolve, reject) => {
      authenticationResolve = resolve
      authenticationReject = reject
    },
  )
  void authenticated.catch(() => {})
  let verification: SmokeEvidence['verification'] = 'existing-platform-approval'
  let passedActionIds = KNOWLEDGE_PLANET_PLUGIN_CONTRACT.actions.map((action) => action.id)
  try {
    const pins = await resolveKnowledgePlanetLoginPins()
    handle = await service.startLogin({
      sessionId,
      pins,
      deadlineMs,
      onQr: (png) => {
        void writeQr(png).then(qrResolve, (error: unknown) =>
          qrReject(error instanceof Error ? error : new Error('Knowledge Planet QR write failed')),
        )
      },
      onAuthenticated: (state) => {
        try {
          authenticationResolve(validateKnowledgePlanetAccountState(state))
        } catch {
          authenticationReject(new Error('Knowledge Planet authenticated state is invalid'))
        }
      },
      onFailed: (code) => {
        const error = new Error(`Knowledge Planet login worker failed (${code})`)
        qrReject(error)
        authenticationReject(error)
      },
    })
    void handle.done.then(
      () => authenticationReject(new Error('Knowledge Planet login worker exited before login')),
      (error: unknown) =>
        authenticationReject(
          error instanceof Error ? error : new Error('Knowledge Planet login worker failed'),
        ),
    )
    await beforeDeadline(
      qrReady,
      deadlineMs,
      'Knowledge Planet QR did not render before the smoke deadline',
    )
    process.stdout.write(`KNOWLEDGE_PLANET_SMOKE_QR_READY=${QR_PATH}\n`)

    if (!alreadyApproved) {
      process.stdout.write(
        'Knowledge Planet v1.1 requires one release-verification scan; waiting for WeChat confirmation.\n',
      )
      const storageState = await beforeDeadline(
        authenticated,
        deadlineMs,
        'Knowledge Planet verification scan was not confirmed before the deadline',
      )
      await handle.done
      await rm(QR_PATH, { force: true })
      const registries = createKnowledgePlanetRuntimeRegistries(service)
      const runtime = new ManagedBrowserRuntime({
        ...registries,
        profileRoot: '/run/openclaude-v5/plugin-smoke-profiles',
        expectedOwnerUid: 0,
      })
      const actionSmoke = await runKnowledgePlanetActionSmoke({
        storageState,
        run: ({ actionId, params, storageState: currentState }) =>
          runtime.runReadAction({
            contract: KNOWLEDGE_PLANET_PLUGIN_CONTRACT,
            storageState: currentState,
            actionId,
            params,
            signal: new AbortController().signal,
          }),
      })
      passedActionIds = actionSmoke.passedActionIds
      verification = 'authenticated-action-smoke'
    }
  } finally {
    await handle?.stop().catch(() => {})
    await service.closeAndDrain()
    await rm(QR_PATH, { force: true })
  }
  await writeEvidence({
    schemaVersion: 2,
    artifactHash: COMPILED_KNOWLEDGE_PLANET_PLUGIN.artifactHash,
    execContractHash: COMPILED_KNOWLEDGE_PLANET_PLUGIN.execContractHash,
    workerDigest: KNOWLEDGE_PLANET_WORKER_DIGEST,
    imageId,
    smokedAt: new Date().toISOString(),
    verification,
    passedActionIds,
    qrRendered: true,
    cleanupVerified: true,
  })
  process.stdout.write(
    `Knowledge Planet Plugin exact-image smoke passed (${verification}); cleanup verified.\n`,
  )
}

async function seedOnly(): Promise<void> {
  const imageId = imageIdFromEnv()
  const docker = dockerClient()
  await inspectExactImage(docker, imageId)
  const evidence = await readEvidence(imageId)
  const alreadyApproved =
    (await findApprovedKnowledgePlanetPluginForDeploy(process.env)) !== null
  if (!alreadyApproved && evidence.verification !== 'authenticated-action-smoke')
    throw new Error('new Knowledge Planet Plugin versions require authenticated action smoke')
  const redis = await leaseRedis()
  try {
    const result = await seedKnowledgePlanetPlugin({
      functionalVerified: true,
      env: process.env,
      leaseRedis: redis,
    })
    await rm(EVIDENCE_PATH, { force: true })
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } finally {
    await redis.quit().catch(() => redis.disconnect())
  }
}

async function leaseRedis(): Promise<IORedis> {
  const url = process.env.REDIS_URL?.trim()
  if (!url) throw new Error('REDIS_URL is required for Plugin account version fencing')
  const redis = new IORedis(url, {
    lazyConnect: true,
    enableReadyCheck: true,
    maxRetriesPerRequest: 1,
  })
  await redis.connect()
  await redis.ping()
  return redis
}

interface TargetReleaseContract {
  slug: string
  version: string
  artifactHash: string
  execContractHash: string
}

async function locateApprovedTarget(target: TargetReleaseContract): Promise<{
  versionId: string
  ownerUserId: number
} | null> {
  const row = await query<{ version_id: string; owner_user_id: string }>(
    `SELECT v.id::text AS version_id, l.owner_user_id::text
       FROM marketplace_skill_versions v
       JOIN marketplace_skill_listings l ON l.slug = v.slug
      WHERE v.slug = $1 AND v.version = $2 AND v.artifact_hash = $3
        AND v.status = 'approved' AND v.review_source = 'platform'
        AND v.security_review_state = 'security_approved'
        AND v.functional_verify_state = 'verified' AND v.exec_revoked_at IS NULL
        AND l.kind = 'connector' AND l.plugin_type = 'managed-browser'
        AND l.state IN ('active','unlisted')
      LIMIT 1`,
    [target.slug, target.version, target.artifactHash],
  )
  const versionId = row.rows[0]?.version_id
  const ownerUserId = Number(row.rows[0]?.owner_user_id)
  if (!versionId) return null
  if (!Number.isSafeInteger(ownerUserId) || ownerUserId <= 0)
    throw new Error('target approved platform Plugin has an invalid owner')
  const verified = await loadVerifiedRuntimePluginContract(Number(versionId), getPool(), {
    env: process.env,
    allowUnlisted: true,
  })
  if (
    verified.pluginType !== 'managed-browser' ||
    verified.slug !== target.slug ||
    verified.artifactHash !== target.artifactHash ||
    verified.execContractHash !== target.execContractHash
  )
    throw new Error('target Plugin signature/contract does not match the release')
  return { versionId, ownerUserId }
}

async function resolveApprovedTarget(target: TargetReleaseContract): Promise<{
  versionId: string
  ownerUserId: number
}> {
  const approved = await locateApprovedTarget(target)
  if (!approved) throw new Error('target does not have an approved platform Plugin version')
  return approved
}

async function targetReleaseContractIfPresent(
  targetInput: string,
  opts: { allowStagedSource?: boolean } = {},
): Promise<TargetReleaseContract | null> {
  if (process.getuid?.() !== 0) throw new Error('Plugin release transition must run as root')
  const target = await realpath(targetInput)
  if (
    !target.startsWith(`${RELEASES_ROOT}/rel-`) &&
    !(opts.allowStagedSource === true && target === '/opt/openclaude/openclaude-v5')
  )
    throw new Error('Plugin transition target is outside the immutable V5 release root')
  const complete = await lstat(join(target, '.complete'))
  if (!complete.isFile() || complete.isSymbolicLink() || complete.uid !== 0)
    throw new Error('Plugin transition target release is unsafe')
  const modulePath = join(
    target,
    'packages/commercial/src/plugins/knowledgePlanetContract.ts',
  )
  const moduleStat = await lstat(modulePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!moduleStat) return null
  if (!moduleStat.isFile() || moduleStat.isSymbolicLink() || moduleStat.uid !== 0)
    throw new Error('Plugin transition target release is unsafe')
  const loaded = (await import(
    `${pathToFileURL(modulePath).href}?transition=${randomUUID()}`
  )) as Record<string, unknown>
  const compiled = loaded.COMPILED_KNOWLEDGE_PLANET_PLUGIN as
    | { artifactHash?: unknown; execContractHash?: unknown }
    | undefined
  const meta = {
    slug: loaded.KNOWLEDGE_PLANET_PLUGIN_SLUG,
    version: loaded.KNOWLEDGE_PLANET_PLUGIN_VERSION,
    artifactHash: compiled?.artifactHash,
    execContractHash: compiled?.execContractHash,
  }
  if (
    meta.slug !== KNOWLEDGE_PLANET_PLUGIN_CONTRACT.id ||
    typeof meta.version !== 'string' ||
    typeof meta.artifactHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(meta.artifactHash) ||
    typeof meta.execContractHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(meta.execContractHash)
  )
    throw new Error('Plugin transition target release contract is invalid')
  return meta as TargetReleaseContract
}

async function targetReleaseContract(
  targetInput: string,
  opts: { allowStagedSource?: boolean } = {},
): Promise<TargetReleaseContract> {
  const target = await targetReleaseContractIfPresent(targetInput, opts)
  if (!target) throw new Error('Plugin transition target release has no Knowledge Planet contract')
  return target
}

async function transitionToRelease(targetRelease: string): Promise<void> {
  const target = await targetReleaseContract(targetRelease)
  const { versionId, ownerUserId } = await resolveApprovedTarget(target)
  const redis = await leaseRedis()
  try {
    const result = await transitionOfficialManagedBrowserPluginVersion({
      slug: target.slug,
      targetVersionId: versionId,
      expectedArtifactHash: target.artifactHash,
      expectedExecContractHash: target.execContractHash,
      ownerUserId,
      env: process.env,
      pool: getPool(),
      redis,
      openListingAtCommit: false,
    })
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } finally {
    await redis.quit().catch(() => redis.disconnect())
  }
}

async function closeListingGate(): Promise<void> {
  const result = await closeOfficialManagedBrowserPluginListingGate({
    slug: KNOWLEDGE_PLANET_PLUGIN_CONTRACT.id,
    env: process.env,
    pool: getPool(),
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

async function openListingGateToRelease(targetRelease: string): Promise<void> {
  const target = await targetReleaseContract(targetRelease)
  const { versionId } = await resolveApprovedTarget(target)
  const result = await openOfficialManagedBrowserPluginListingGate({
    slug: target.slug,
    expectedVersionId: versionId,
    expectedArtifactHash: target.artifactHash,
    expectedExecContractHash: target.execContractHash,
    env: process.env,
    pool: getPool(),
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

async function assertCurrentReleaseCompatible(targetRelease: string): Promise<void> {
  const target = await targetReleaseContract(targetRelease, { allowStagedSource: true })
  const row = await query<{ version_id: string }>(
    `SELECT v.id::text AS version_id
       FROM marketplace_skill_listings l
       JOIN marketplace_skill_versions v ON v.id = l.current_approved_version_id
      WHERE l.slug = $1 AND l.kind = 'connector' AND l.plugin_type = 'managed-browser'
        AND l.state IN ('active','unlisted')
        AND v.status = 'approved' AND v.review_source = 'platform'
        AND v.security_review_state = 'security_approved'
        AND v.functional_verify_state = 'verified' AND v.exec_revoked_at IS NULL`,
    [target.slug],
  )
  const versionId = row.rows[0]?.version_id
  if (!versionId)
    throw new Error('Knowledge Planet Plugin is not published; use the normal deploy lane')
  const verified = await loadVerifiedRuntimePluginContract(Number(versionId), getPool(), {
    env: process.env,
    allowUnlisted: true,
  })
  if (
    verified.pluginType !== 'managed-browser' ||
    verified.slug !== target.slug ||
    verified.contract.version !== target.version ||
    verified.artifactHash !== target.artifactHash ||
    verified.execContractHash !== target.execContractHash
  )
    throw new Error(
      'target release changes the Knowledge Planet Plugin contract; use the normal deploy lane',
    )
  process.stdout.write(
    `${JSON.stringify({ compatible: true, versionId, artifactHash: target.artifactHash })}\n`,
  )
}

async function classifyCurrentForRelease(targetRelease: string): Promise<void> {
  const target = await targetReleaseContractIfPresent(targetRelease, {
    allowStagedSource: true,
  })
  const row = await query<{ version_id: string | null }>(
    `SELECT current_approved_version_id::text AS version_id
       FROM marketplace_skill_listings
      WHERE slug = $1`,
    [KNOWLEDGE_PLANET_PLUGIN_CONTRACT.id],
  )
  const versionId = row.rows[0]?.version_id ?? null
  const approved = target ? await locateApprovedTarget(target) : null
  process.stdout.write(
    `${JSON.stringify({
      available: approved !== null,
      versionId: approved?.versionId ?? null,
      currentVersionId: versionId,
    })}\n`,
  )
}

async function main(): Promise<void> {
  const mode = process.argv[2]
  const transitionTarget = mode?.startsWith('--transition-to-release=')
    ? mode.slice('--transition-to-release='.length)
    : null
  const openGateTarget = mode?.startsWith('--open-listing-gate-to-release=')
    ? mode.slice('--open-listing-gate-to-release='.length)
    : null
  const compatibilityTarget = mode?.startsWith('--assert-current-release-compatible=')
    ? mode.slice('--assert-current-release-compatible='.length)
    : null
  const classifyTarget = mode?.startsWith('--classify-current-for-release=')
    ? mode.slice('--classify-current-for-release='.length)
    : null
  if (
    process.argv.length !== 3 ||
    (mode !== '--smoke-only' &&
      mode !== '--seed-only' &&
      mode !== '--close-listing-gate' &&
      !transitionTarget &&
      !openGateTarget &&
      !compatibilityTarget &&
      !classifyTarget)
  )
    throw new Error(
      'usage: seed-knowledge-planet-plugin.ts --smoke-only|--seed-only|--close-listing-gate|--transition-to-release=PATH|--open-listing-gate-to-release=PATH|--assert-current-release-compatible=PATH|--classify-current-for-release=PATH',
    )
  try {
    if (mode === '--smoke-only') await smokeOnly()
    else if (mode === '--seed-only') await seedOnly()
    else if (mode === '--close-listing-gate') await closeListingGate()
    else if (transitionTarget) await transitionToRelease(transitionTarget)
    else if (openGateTarget) await openListingGateToRelease(openGateTarget)
    else if (compatibilityTarget) await assertCurrentReleaseCompatible(compatibilityTarget)
    else await classifyCurrentForRelease(classifyTarget!)
  } finally {
    await closePool().catch(() => {})
  }
}

main().catch((error) => {
  process.stderr.write(
    `Knowledge Planet Plugin deploy gate failed: ${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exitCode = 1
})
