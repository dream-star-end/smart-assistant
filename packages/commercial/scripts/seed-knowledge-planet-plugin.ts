#!/usr/bin/env tsx
/** Deploy-only exact-image smoke and idempotent official Knowledge Planet Plugin seed. */

import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import Docker from 'dockerode'
import IORedis from 'ioredis'

import { canonicalSha256Hex } from '../src/connectors/spec/canonical.js'
import { closePool, getPool } from '../src/db/index.js'
import { query } from '../src/db/queries.js'
import {
  findApprovedKnowledgePlanetPluginForDeploy,
  seedKnowledgePlanetPlugin,
} from '../src/marketplace/seedKnowledgePlanetPlugin.js'
import {
  type BrowserStorageStateV1,
  PluginAccountError,
  bindManagedBrowserPluginAccount,
  decryptPluginAccountEnvelope,
  getPluginAccount,
} from '../src/plugins/accounts.js'
import { ManagedBrowserRuntime } from '../src/plugins/browserRuntime.js'
import {
  COMPILED_KNOWLEDGE_PLANET_PLUGIN,
  KNOWLEDGE_PLANET_PLUGIN_CONTRACT,
  KNOWLEDGE_PLANET_WORKER_DIGEST,
  KnowledgePlanetDockerService,
  KnowledgePlanetRuntimeError,
  classifyKnowledgePlanetSetupPin,
  createKnowledgePlanetRuntimeRegistries,
  validateKnowledgePlanetAccountState,
} from '../src/plugins/knowledgePlanet.js'
import { resolveKnowledgePlanetLoginPins } from '../src/plugins/knowledgePlanetSetup.js'
import { runKnowledgePlanetActionSmoke } from '../src/plugins/knowledgePlanetSmoke.js'
import {
  KNOWLEDGE_PLANET_VERIFICATION_HANDOFF_PATH,
  type KnowledgePlanetVerificationExpected,
  type KnowledgePlanetVerificationHandoff,
  deleteKnowledgePlanetVerificationHandoff,
  readKnowledgePlanetVerificationHandoff,
  writeKnowledgePlanetVerificationHandoff,
} from '../src/plugins/knowledgePlanetVerificationHandoff.js'
import {
  OFFICIAL_MANAGED_BROWSER_TRANSITION_GATE_REASON,
  closeOfficialManagedBrowserPluginListingGate,
  openOfficialManagedBrowserPluginListingGate,
  transitionOfficialManagedBrowserPluginVersion,
} from '../src/plugins/officialManagedBrowserTransition.js'
import { loadVerifiedRuntimePluginContract } from '../src/plugins/review.js'

const IMAGE_ID_RE = /^sha256:[0-9a-f]{64}$/
const SOURCE_COMMIT_RE = /^[0-9a-f]{40}$/
const LEGACY_EVIDENCE_PATH = '/run/openclaude-v5/knowledge-planet-plugin-smoke.json'
const QR_PATH = '/run/openclaude-v5/knowledge-planet-plugin-smoke-qr.png'
const QR_DEADLINE_MS = 4 * 60_000
const RELEASES_ROOT = '/opt/openclaude/openclaude-v5-releases'

function imageIdFromEnv(): string {
  if (process.env.OC_RUNTIME_CHANNEL !== 'v5')
    throw new Error('Knowledge Planet Plugin deploy gate is V5-only')
  const imageId = process.env.OC_RUNTIME_IMAGE_ID?.trim() ?? ''
  if (!IMAGE_ID_RE.test(imageId))
    throw new Error('OC_RUNTIME_IMAGE_ID must be an exact sha256 image ID')
  return imageId
}

function sourceCommitFromEnv(): string {
  const sourceCommit = process.env.OC_KNOWLEDGE_PLANET_SOURCE_COMMIT?.trim() ?? ''
  if (!SOURCE_COMMIT_RE.test(sourceCommit))
    throw new Error('OC_KNOWLEDGE_PLANET_SOURCE_COMMIT must be an exact full git commit')
  return sourceCommit
}

function verificationExpected(imageId: string): KnowledgePlanetVerificationExpected {
  return {
    artifactHash: COMPILED_KNOWLEDGE_PLANET_PLUGIN.artifactHash,
    execContractHash: COMPILED_KNOWLEDGE_PLANET_PLUGIN.execContractHash,
    workerDigest: KNOWLEDGE_PLANET_WORKER_DIGEST,
    imageId,
    sourceCommit: sourceCommitFromEnv(),
    actionIds: KNOWLEDGE_PLANET_PLUGIN_CONTRACT.actions.map((action) => action.id),
    contract: KNOWLEDGE_PLANET_PLUGIN_CONTRACT,
  }
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
  const root = dirname(QR_PATH)
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

async function writeQr(png: Buffer): Promise<void> {
  if (
    png.length < 8 ||
    png.length > 512 * 1024 ||
    !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    throw new Error('Knowledge Planet QR is not a bounded PNG')
  await writePrivateFile(QR_PATH, png)
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

async function handoffExists(): Promise<boolean> {
  return (await lstat(KNOWLEDGE_PLANET_VERIFICATION_HANDOFF_PATH).catch(() => null)) !== null
}

async function readHandoffIfPresent(
  expected: KnowledgePlanetVerificationExpected,
): Promise<KnowledgePlanetVerificationHandoff | null> {
  if (!(await handoffExists())) return null
  return readKnowledgePlanetVerificationHandoff({ expected, env: process.env })
}

async function runActionSmoke(
  service: KnowledgePlanetDockerService,
  storageState: BrowserStorageStateV1,
): Promise<{ passedActionIds: string[]; storageState: BrowserStorageStateV1 }> {
  const registries = createKnowledgePlanetRuntimeRegistries(service)
  const runtime = new ManagedBrowserRuntime({
    ...registries,
    profileRoot: '/run/openclaude-v5/plugin-smoke-profiles',
    expectedOwnerUid: 0,
  })
  return runKnowledgePlanetActionSmoke({
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
}

async function loadReusableAccountState(
  userId: number,
): Promise<{ storageState: BrowserStorageStateV1; accountInstanceId: string } | null> {
  const located = await query<{ id: string }>(
    `SELECT id::text AS id FROM connections
      WHERE user_id = $1 AND provider = $2 AND status IN ('active','error')
        AND revoked_at IS NULL
      ORDER BY id`,
    [userId, KNOWLEDGE_PLANET_PLUGIN_CONTRACT.id],
  )
  if (located.rowCount === 0) return null
  if (located.rowCount !== 1)
    throw new Error('Knowledge Planet user has multiple active Plugin accounts')
  const row = await getPluginAccount(located.rows[0]!.id, userId, getPool(), {
    includeError: true,
  })
  if (!row) throw new Error('Knowledge Planet reusable Plugin account disappeared')
  const versionId = Number(row.connector_version_id)
  if (!Number.isSafeInteger(versionId) || versionId <= 0)
    throw new Error('Knowledge Planet reusable Plugin account version is invalid')
  const verified = await loadVerifiedRuntimePluginContract(versionId, getPool(), {
    env: process.env,
  })
  if (
    verified.pluginType !== 'managed-browser' ||
    verified.slug !== KNOWLEDGE_PLANET_PLUGIN_CONTRACT.id ||
    row.provider !== verified.slug ||
    row.spec_hash.toString('hex') !== verified.artifactHash ||
    row.exec_contract_hash.toString('hex') !== verified.execContractHash
  )
    throw new Error('Knowledge Planet reusable Plugin account trust pins do not match')
  const envelope = decryptPluginAccountEnvelope(row, verified.contract, process.env)
  return { storageState: envelope.storageState, accountInstanceId: envelope.accountInstanceId }
}

async function waitForQrLogin(
  service: KnowledgePlanetDockerService,
): Promise<BrowserStorageStateV1> {
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
    process.stdout.write(`KNOWLEDGE_PLANET_VERIFICATION_QR_READY=${QR_PATH}\n`)
    process.stdout.write('Waiting for one WeChat verification scan.\n')
    const storageState = await beforeDeadline(
      authenticated,
      deadlineMs,
      'Knowledge Planet verification scan was not confirmed before the deadline',
    )
    await handle.done
    return storageState
  } finally {
    await handle?.stop().catch(() => {})
    await rm(QR_PATH, { force: true })
  }
}

function canRelinkAfter(error: unknown): boolean {
  return (
    (error instanceof KnowledgePlanetRuntimeError && error.code === 'LOGIN_EXPIRED_ACCOUNT') ||
    (error instanceof PluginAccountError && error.code === 'INVALID_STATE')
  )
}

async function verifyUser(userId: number): Promise<void> {
  const imageId = imageIdFromEnv()
  const expected = verificationExpected(imageId)
  const docker = dockerClient()
  await inspectExactImage(docker, imageId)
  const alreadyApproved = (await findApprovedKnowledgePlanetPluginForDeploy(process.env)) !== null
  if (await handoffExists()) {
    try {
      const existing = await readKnowledgePlanetVerificationHandoff({
        expected,
        env: process.env,
      })
      if (existing.metadata.userId !== userId)
        throw new Error(
          `a fresh Knowledge Planet verification is already pending for user ${existing.metadata.userId}`,
        )
      process.stdout.write(
        `Knowledge Planet verification is already ready for user ${userId}; no scan needed.\n`,
      )
      return
    } catch (error) {
      if (error instanceof Error && error.message.includes('already pending')) throw error
      await deleteKnowledgePlanetVerificationHandoff()
    }
  }
  const reusable = await loadReusableAccountState(userId)
  if (alreadyApproved && reusable) {
    process.stdout.write(
      `Knowledge Planet exact candidate is approved and user ${userId} already has a reusable encrypted account; no scan needed.\n`,
    )
    return
  }
  await rm(LEGACY_EVIDENCE_PATH, { force: true })
  await rm(QR_PATH, { force: true })
  const service = new KnowledgePlanetDockerService(docker, {
    imageId,
    workerRoot: '/var/lib/openclaude-v5/plugin-workers',
    brokerRoot: '/run/openclaude-v5/plugin-browser-brokers',
    expectedOwnerUid: 0,
    socketUid: 1000,
    socketGid: 1000,
  })
  let verification: 'existing-account' | 'qr-login' = 'existing-account'
  let replaceExistingAccount = false
  let expectedExistingAccountInstanceId: string | null = null
  let replacementAccountInstanceId: string | null = null
  let completed: Awaited<ReturnType<typeof runActionSmoke>> | null = null
  try {
    if (reusable) {
      expectedExistingAccountInstanceId = reusable.accountInstanceId
      try {
        completed = await runActionSmoke(
          service,
          validateKnowledgePlanetAccountState(reusable.storageState),
        )
        process.stdout.write(
          `Knowledge Planet user ${userId} existing encrypted login passed all actions; no scan needed.\n`,
        )
      } catch (error) {
        if (!canRelinkAfter(error)) throw error
        verification = 'qr-login'
        replaceExistingAccount = true
        replacementAccountInstanceId = randomUUID()
      }
    } else {
      verification = 'qr-login'
    }
    if (!completed) {
      const authenticated = await waitForQrLogin(service)
      completed = await runActionSmoke(service, authenticated)
    }
  } finally {
    await service.closeAndDrain()
    await rm(QR_PATH, { force: true })
  }
  if (!completed) throw new Error('Knowledge Planet verification did not complete')
  const metadata = await writeKnowledgePlanetVerificationHandoff({
    expected,
    userId,
    verification,
    replaceExistingAccount,
    expectedExistingAccountInstanceId,
    replacementAccountInstanceId,
    passedActionIds: completed.passedActionIds,
    storageState: completed.storageState,
    env: process.env,
  })
  process.stdout.write(
    `KNOWLEDGE_PLANET_VERIFICATION_READY=${KNOWLEDGE_PLANET_VERIFICATION_HANDOFF_PATH}\n`,
  )
  process.stdout.write(
    `Knowledge Planet exact-image action smoke passed (${metadata.verification}); encrypted handoff expires at ${metadata.expiresAt}.\n`,
  )
}

async function smokeOnly(): Promise<void> {
  const imageId = imageIdFromEnv()
  const expected = verificationExpected(imageId)
  const docker = dockerClient()
  await inspectExactImage(docker, imageId)
  const alreadyApproved = (await findApprovedKnowledgePlanetPluginForDeploy(process.env)) !== null
  const handoff = await readHandoffIfPresent(expected)
  if (!alreadyApproved && !handoff)
    throw new Error(
      'new Knowledge Planet candidate requires preverification; run scripts/deploy-v5.sh --verify-knowledge-planet-user=<user-id>',
    )
  process.stdout.write(
    `Knowledge Planet Plugin noninteractive exact-image gate passed (${handoff ? `verified user ${handoff.metadata.userId}` : 'existing platform approval'}).\n`,
  )
}

async function seedOnly(): Promise<void> {
  const imageId = imageIdFromEnv()
  const expected = verificationExpected(imageId)
  const docker = dockerClient()
  await inspectExactImage(docker, imageId)
  const handoff = await readHandoffIfPresent(expected)
  const alreadyApproved = (await findApprovedKnowledgePlanetPluginForDeploy(process.env)) !== null
  if (!alreadyApproved && !handoff)
    throw new Error('new Knowledge Planet Plugin versions require an encrypted action handoff')
  const redis = await leaseRedis()
  try {
    let accountBind: Awaited<ReturnType<typeof bindManagedBrowserPluginAccount>> | null = null
    const result = await seedKnowledgePlanetPlugin({
      functionalVerified: true,
      env: process.env,
      leaseRedis: redis,
      ...(handoff
        ? {
            beforeListingOpen: async ({ versionId }: { versionId: string }) => {
              const numericVersionId = Number(versionId)
              if (!Number.isSafeInteger(numericVersionId) || numericVersionId <= 0)
                throw new Error('Knowledge Planet approved version ID is invalid')
              accountBind = await bindManagedBrowserPluginAccount({
                userId: handoff.metadata.userId,
                versionId: numericVersionId,
                displayName: '知识星球',
                accountHint: '微信扫码账号',
                storageState: handoff.storageState,
                existing: handoff.metadata.replaceExistingAccount
                  ? ('replace' as const)
                  : handoff.metadata.expectedExistingAccountInstanceId
                    ? ('refresh-fenced' as const)
                    : ('reuse-identical' as const),
                ...(handoff.metadata.expectedExistingAccountInstanceId
                  ? {
                      expectedExistingAccountInstanceId:
                        handoff.metadata.expectedExistingAccountInstanceId,
                    }
                  : {}),
                ...(handoff.metadata.replacementAccountInstanceId
                  ? {
                      replacementAccountInstanceId: handoff.metadata.replacementAccountInstanceId,
                    }
                  : {}),
                unlistedGateReason: OFFICIAL_MANAGED_BROWSER_TRANSITION_GATE_REASON,
                env: process.env,
                pool: getPool(),
              })
            },
          }
        : {}),
    })
    if (handoff && !accountBind)
      throw new Error('Knowledge Planet verification handoff was not bound to its user')
    if (handoff) await deleteKnowledgePlanetVerificationHandoff()
    await rm(LEGACY_EVIDENCE_PATH, { force: true })
    process.stdout.write(`${JSON.stringify({ ...result, accountBind })}\n`)
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
  const modulePath = join(target, 'packages/commercial/src/plugins/knowledgePlanetContract.ts')
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

async function assertSetupFirstSafe(phase: 'pre' | 'post'): Promise<void> {
  const row = await query<{
    listing_state: string
    revoked_reason: string | null
    version_id: string
    version_review_source: string | null
    active_installs: string
    exact_active_installs: string
    active_accounts: string
  }>(
    `SELECT l.state AS listing_state, l.revoked_reason,
            v.id::text AS version_id, v.review_source AS version_review_source,
            (SELECT count(*)::text FROM marketplace_installs i
              WHERE i.slug = l.slug AND i.uninstalled_at IS NULL) AS active_installs,
            (SELECT count(*)::text FROM marketplace_installs i
              WHERE i.slug = l.slug AND i.version_id = v.id
                AND i.artifact_hash = v.artifact_hash
                AND i.uninstalled_at IS NULL) AS exact_active_installs,
            (SELECT count(*)::text FROM connections c
              WHERE c.provider = l.slug AND c.revoked_at IS NULL) AS active_accounts
       FROM marketplace_skill_listings l
       JOIN marketplace_skill_versions v ON v.id = l.current_approved_version_id
      WHERE l.slug = $1 AND l.kind = 'connector' AND l.plugin_type = 'managed-browser'
        AND v.status = 'approved' AND v.security_review_state = 'security_approved'
        AND v.functional_verify_state = 'verified' AND v.exec_revoked_at IS NULL`,
    [KNOWLEDGE_PLANET_PLUGIN_CONTRACT.id],
  )
  const current = row.rows[0]
  if (!current || current.version_review_source !== 'platform')
    throw new Error('setup-first requires an approved platform Knowledge Planet version')
  if (
    (phase === 'pre' && (current.listing_state !== 'active' || current.revoked_reason !== null)) ||
    (phase === 'post' &&
      (current.listing_state !== 'unlisted' ||
        current.revoked_reason !== OFFICIAL_MANAGED_BROWSER_TRANSITION_GATE_REASON))
  )
    throw new Error(`setup-first ${phase} listing gate state is invalid`)
  const versionId = Number(current.version_id)
  if (!Number.isSafeInteger(versionId) || versionId <= 0)
    throw new Error('setup-first current version ID is invalid')
  const verified = await loadVerifiedRuntimePluginContract(versionId, getPool(), {
    env: process.env,
    allowUnlisted: phase === 'post',
  })
  if (
    verified.pluginType !== 'managed-browser' ||
    verified.slug !== KNOWLEDGE_PLANET_PLUGIN_CONTRACT.id ||
    verified.artifactHash === COMPILED_KNOWLEDGE_PLANET_PLUGIN.artifactHash ||
    classifyKnowledgePlanetSetupPin({
      version: verified.contract.version,
      artifactHash: verified.artifactHash,
      execContractHash: verified.execContractHash,
    }) !== 'compatible-predecessor'
  )
    throw new Error('setup-first current Plugin is not the exact compatible predecessor')
  if (
    canonicalSha256Hex(verified.contract.account) !==
      canonicalSha256Hex(KNOWLEDGE_PLANET_PLUGIN_CONTRACT.account) ||
    canonicalSha256Hex(verified.contract.runtime.accountState) !==
      canonicalSha256Hex(KNOWLEDGE_PLANET_PLUGIN_CONTRACT.runtime.accountState)
  )
    throw new Error('setup-first predecessor browser account contract is incompatible')
  const activeInstalls = Number(current.active_installs)
  const exactActiveInstalls = Number(current.exact_active_installs)
  const activeAccounts = Number(current.active_accounts)
  if (
    !Number.isSafeInteger(activeInstalls) ||
    activeInstalls <= 0 ||
    exactActiveInstalls !== activeInstalls
  )
    throw new Error('setup-first requires only exact current active installs')
  if (!Number.isSafeInteger(activeAccounts) || activeAccounts !== 0)
    throw new Error('setup-first requires zero active Knowledge Planet accounts')
  process.stdout.write(
    `${JSON.stringify({
      safe: true,
      phase,
      currentVersionId: current.version_id,
      currentArtifactHash: verified.artifactHash,
      targetArtifactHash: COMPILED_KNOWLEDGE_PLANET_PLUGIN.artifactHash,
      activeInstalls,
      activeAccounts,
    })}\n`,
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
  const verifyUserRaw = mode?.startsWith('--verify-user=')
    ? mode.slice('--verify-user='.length)
    : null
  const verifyUserId =
    verifyUserRaw && /^\d{1,16}$/.test(verifyUserRaw) ? Number(verifyUserRaw) : null
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
  const setupFirstPhase = mode?.startsWith('--assert-setup-first-safe=')
    ? mode.slice('--assert-setup-first-safe='.length)
    : null
  if (
    process.argv.length !== 3 ||
    (mode !== '--smoke-only' &&
      mode !== '--seed-only' &&
      mode !== '--close-listing-gate' &&
      !(verifyUserId && Number.isSafeInteger(verifyUserId) && verifyUserId > 0) &&
      !transitionTarget &&
      !openGateTarget &&
      !compatibilityTarget &&
      !classifyTarget &&
      setupFirstPhase !== 'pre' &&
      setupFirstPhase !== 'post')
  )
    throw new Error(
      'usage: seed-knowledge-planet-plugin.ts --verify-user=ID|--smoke-only|--seed-only|--close-listing-gate|--transition-to-release=PATH|--open-listing-gate-to-release=PATH|--assert-current-release-compatible=PATH|--classify-current-for-release=PATH|--assert-setup-first-safe=pre|post',
    )
  try {
    if (verifyUserId) await verifyUser(verifyUserId)
    else if (mode === '--smoke-only') await smokeOnly()
    else if (mode === '--seed-only') await seedOnly()
    else if (mode === '--close-listing-gate') await closeListingGate()
    else if (transitionTarget) await transitionToRelease(transitionTarget)
    else if (openGateTarget) await openListingGateToRelease(openGateTarget)
    else if (compatibilityTarget) await assertCurrentReleaseCompatible(compatibilityTarget)
    else if (setupFirstPhase === 'pre' || setupFirstPhase === 'post')
      await assertSetupFirstSafe(setupFirstPhase)
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
