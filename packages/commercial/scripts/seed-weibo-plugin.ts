#!/usr/bin/env tsx
/** Exact-image DOM smoke, official Weibo seed, and verified-user account handoff. */

import assert from 'node:assert/strict'
import { createDecipheriv, createHash } from 'node:crypto'
import { lstat, readFile, rm } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

import Docker from 'dockerode'
import IORedis from 'ioredis'

import { closePool, getPool } from '../src/db/index.js'
import { installApprovedVersion } from '../src/marketplace/marketplaceDb.js'
import {
  assertWeiboUpgradeVerificationScope,
  seedWeiboPlugin,
} from '../src/marketplace/seedWeiboPlugin.js'
import {
  type BrowserStorageStateV1,
  bindManagedBrowserPluginAccount,
  decryptPluginAccountEnvelope,
  getPluginAccount,
} from '../src/plugins/accounts.js'
import { ManagedBrowserRuntime } from '../src/plugins/browserRuntime.js'
import {
  closeOfficialManagedBrowserPluginListingGate,
  openOfficialManagedBrowserPluginListingGate,
  readOfficialManagedBrowserTransitionCensus,
} from '../src/plugins/officialManagedBrowserTransition.js'
import { loadVerifiedRuntimePluginContract } from '../src/plugins/review.js'
import {
  COMPILED_WEIBO_PLUGIN,
  WEIBO_PLUGIN_CONTRACT,
  WEIBO_WORKER_DIGEST,
  WeiboDockerService,
  createWeiboRuntimeRegistries,
  validateWeiboAccountState,
} from '../src/plugins/weibo.js'
import { resolveWeiboLoginPins } from '../src/plugins/weiboSetup.js'

const IMAGE_ID_RE = /^sha256:[0-9a-f]{64}$/
const HANDOFF_AAD = Buffer.from('openclaude-v5-weibo-gatea-v1')

function exactImageId(): string {
  if (process.env.OC_RUNTIME_CHANNEL !== 'v5') throw new Error('Weibo Plugin seed is V5-only')
  const imageId = process.env.OC_RUNTIME_IMAGE_ID?.trim() ?? ''
  if (!IMAGE_ID_RE.test(imageId)) throw new Error('OC_RUNTIME_IMAGE_ID must be an exact image ID')
  return imageId
}

function dockerClient(): Docker {
  const socketPath = process.env.AGENT_DOCKER_SOCKET?.trim()
  return socketPath ? new Docker({ socketPath }) : new Docker()
}

async function privateRootFile(path: string, label: string): Promise<Buffer> {
  if (!isAbsolute(path)) throw new Error(`${label} path must be absolute`)
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o077) !== 0)
    throw new Error(`${label} file is unsafe`)
  return readFile(path)
}

async function loadVerifiedState(): Promise<BrowserStorageStateV1> {
  const statePath = process.env.OC_WEIBO_VERIFY_STATE_FILE?.trim() ?? ''
  const keyPath = process.env.OC_WEIBO_VERIFY_KEY_FILE?.trim() ?? ''
  if (!statePath || !keyPath) throw new Error('encrypted state and key paths are required')
  const [payloadBytes, keyBytes] = await Promise.all([
    privateRootFile(statePath, 'encrypted state'),
    privateRootFile(keyPath, 'state key'),
  ])
  let key = Buffer.alloc(0)
  let plaintext = Buffer.alloc(0)
  try {
    const payload = JSON.parse(payloadBytes.toString('utf8')) as Record<string, unknown>
    if (
      Object.keys(payload).sort().join('\0') !==
        ['alg', 'ciphertext', 'iv', 'tag', 'v'].sort().join('\0') ||
      payload.v !== 1 ||
      payload.alg !== 'aes-256-gcm' ||
      typeof payload.iv !== 'string' ||
      typeof payload.tag !== 'string' ||
      typeof payload.ciphertext !== 'string'
    )
      throw new Error('encrypted state envelope is invalid')
    key = Buffer.from(keyBytes.toString('utf8').trim(), 'base64')
    if (key.length !== 32) throw new Error('encrypted state key is invalid')
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'))
    decipher.setAAD(HANDOFF_AAD)
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'))
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertext, 'base64')),
      decipher.final(),
    ])
    const decoded = JSON.parse(plaintext.toString('utf8')) as Record<string, unknown>
    const cookies = Array.isArray(decoded.cookies)
      ? decoded.cookies.filter(
          (cookie) =>
            cookie !== null &&
            typeof cookie === 'object' &&
            (cookie as Record<string, unknown>).secure === true,
        )
      : decoded.cookies
    return validateWeiboAccountState({ ...decoded, cookies })
  } finally {
    payloadBytes.fill(0)
    keyBytes.fill(0)
    key.fill(0)
    plaintext.fill(0)
  }
}

async function exactImageSmoke(
  service: WeiboDockerService,
  initialState: BrowserStorageStateV1,
): Promise<{ storageState: BrowserStorageStateV1; selfId: string; passed: string[] }> {
  const runtime = new ManagedBrowserRuntime({
    ...createWeiboRuntimeRegistries(service),
    profileRoot: '/run/openclaude-v5/weibo-plugin-smoke-profiles',
    expectedOwnerUid: 0,
  })
  let storageState = initialState
  const passed: string[] = []
  const run = async (actionId: string, params: Record<string, unknown>) => {
    const executed = await runtime.runReadAction({
      contract: WEIBO_PLUGIN_CONTRACT,
      storageState,
      actionId,
      params,
      signal: new AbortController().signal,
    })
    storageState = executed.storageState
    if (!passed.includes(actionId)) passed.push(actionId)
    return executed.result as Record<string, unknown>
  }
  const self = await run('get_self', {})
  const user = self.user as Record<string, unknown>
  const selfId = String(user?.id ?? '')
  if (!/^\d{5,20}$/.test(selfId)) throw new Error('get_self did not prove a numeric account')
  await run('get_user', { userId: selfId })
  const home = await run('list_home_posts', { count: 5 })
  const own = await run('list_user_posts', { userId: selfId, count: 5 })
  const posts = Array.isArray(own.posts) ? (own.posts as Record<string, unknown>[]) : []
  const homePosts = Array.isArray(home.posts) ? (home.posts as Record<string, unknown>[]) : []
  let post: Record<string, unknown> | null = null
  for (const candidate of [...posts.filter((item) => item.owned === true), ...homePosts]) {
    const postId = String(candidate.id ?? '')
    const postUserId = String(candidate.userId ?? '')
    try {
      await run('get_post', { userId: postUserId, postId })
      post = candidate
      break
    } catch {}
  }
  if (!post) throw new Error('verified account has no readable post for detail smoke')
  const postId = String(post.id ?? '')
  const postUserId = String(post.userId ?? '')
  await run('list_comments', { userId: postUserId, postId, count: 10 })
  await run('search_posts', {
    keyword: String(user?.name ?? '微博').slice(0, 30) || '微博',
    count: 5,
  })
  await run('get_unread_counts', {})
  for (const category of ['mentions', 'comments', 'likes', 'followers'])
    await run('list_notifications', { category, count: 5 })
  const followers = await run('list_followers', { count: 5 })
  const following = await run('list_following', { count: 5 })
  const searchedUsers = await run('search_users', {
    keyword: String(user?.name ?? '微博').slice(0, 30) || '微博',
    count: 5,
  })
  await run('list_favorites', { count: 5 })
  await run('list_liked_posts', { count: 5 })
  await run('list_hot_searches', { count: 10 })
  const threads = await run('list_message_threads', { count: 5 })
  const messageTarget = [threads.threads, following.users, followers.users, searchedUsers.users]
    .flatMap((items) => (Array.isArray(items) ? (items as Record<string, unknown>[]) : []))
    .map((item) => String(item.userId ?? item.id ?? ''))
    .find((candidate) => /^\d{5,20}$/.test(candidate))
  if (!messageTarget)
    throw new Error('verified account has no readable user for message-thread smoke')
  await run('get_message_thread', { userId: messageTarget, count: 5 })
  return { storageState, selfId, passed }
}

async function qrSmoke(service: WeiboDockerService): Promise<string> {
  const pins = await resolveWeiboLoginPins()
  const sessionId = `verify-${Date.now()}`
  const deadlineMs = Date.now() + 90_000
  let resolveQr!: (digest: string) => void
  let rejectQr!: (error: Error) => void
  const qr = new Promise<string>((resolve, reject) => {
    resolveQr = resolve
    rejectQr = reject
  })
  const handle = await service.startLogin({
    sessionId,
    pins,
    deadlineMs,
    onQr: (png) => {
      if (
        png.length < 8 ||
        png.length > 512 * 1024 ||
        !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      )
        rejectQr(new Error('Weibo QR is not a bounded PNG'))
      else resolveQr(createHash('sha256').update(png).digest('hex'))
    },
    onAuthenticated: () => rejectQr(new Error('fresh QR worker unexpectedly authenticated')),
    onFailed: (code) => rejectQr(new Error(`Weibo QR worker failed (${code})`)),
  })
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      qr,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Weibo QR did not render')), 85_000)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    await handle.stop().catch(() => {})
    await handle.done.catch(() => {})
  }
}

async function leaseRedis(): Promise<IORedis> {
  const url = process.env.REDIS_URL?.trim()
  if (!url) throw new Error('REDIS_URL is required')
  const redis = new IORedis(url, {
    lazyConnect: true,
    enableReadyCheck: true,
    maxRetriesPerRequest: 1,
  })
  await redis.connect()
  await redis.ping()
  return redis
}

function writePolicyFingerprint(
  row: NonNullable<Awaited<ReturnType<typeof getPluginAccount>>>,
): string {
  return JSON.stringify({
    writeEnabled: row.plugin_write_enabled,
    writeVersion: row.plugin_write_disclaimer_version,
    writeAcceptedAt: row.plugin_write_disclaimer_accepted_at?.toISOString() ?? null,
    preapprovalEnabled: row.plugin_write_preapproval_enabled,
    preapprovalVersion: row.plugin_write_preapproval_disclaimer_version,
    preapprovalAcceptedAt: row.plugin_write_preapproval_accepted_at?.toISOString() ?? null,
  })
}

async function loadUpgradeAccount(userId: number) {
  const census = await readOfficialManagedBrowserTransitionCensus(WEIBO_PLUGIN_CONTRACT.id)
  const sourceVersionIdText = census.currentVersionId
  const sourceVersionId = Number(sourceVersionIdText)
  if (
    sourceVersionIdText === null ||
    !Number.isSafeInteger(sourceVersionId) ||
    sourceVersionId <= 0
  )
    throw new Error('Weibo upgrade source version is invalid')
  const verified = await loadVerifiedRuntimePluginContract(sourceVersionId, getPool(), {
    env: process.env,
  })
  assertWeiboUpgradeVerificationScope(census, userId, verified.artifactHash)
  const accountId = census.accounts[0].id
  const row = await getPluginAccount(accountId, userId, getPool(), { includeError: true })
  if (!row || row.status !== 'active') throw new Error('Weibo upgrade account disappeared')
  if (
    verified.pluginType !== 'managed-browser' ||
    verified.slug !== WEIBO_PLUGIN_CONTRACT.id ||
    row.provider !== verified.slug ||
    row.spec_hash.toString('hex') !== verified.artifactHash ||
    row.exec_contract_hash.toString('hex') !== verified.execContractHash
  )
    throw new Error('Weibo upgrade account trust pins do not match its exact source contract')
  const envelope = decryptPluginAccountEnvelope(row, verified.contract, process.env)
  return {
    census,
    storageState: envelope.storageState,
    accountInstanceId: envelope.accountInstanceId,
    writePolicyFingerprint: writePolicyFingerprint(row),
    sourceVersionId: sourceVersionIdText,
    sourceArtifactHash: verified.artifactHash,
    sourceExecContractHash: verified.execContractHash,
  }
}

async function assertUpgradeCensusUnchanged(
  expected: Awaited<ReturnType<typeof readOfficialManagedBrowserTransitionCensus>>,
): Promise<void> {
  const current = await readOfficialManagedBrowserTransitionCensus(WEIBO_PLUGIN_CONTRACT.id)
  assert.deepEqual(
    current,
    expected,
    'Weibo install/account census changed during live verification',
  )
}

async function verifyUpgradedAccount(
  reusable: Awaited<ReturnType<typeof loadUpgradeAccount>>,
  userId: number,
  targetVersionId: string,
): Promise<Awaited<ReturnType<typeof bindManagedBrowserPluginAccount>>> {
  const finalCensus = await readOfficialManagedBrowserTransitionCensus(WEIBO_PLUGIN_CONTRACT.id)
  assert.deepEqual(
    finalCensus,
    {
      currentVersionId: targetVersionId,
      installs: reusable.census.installs.map((row) => ({
        ...row,
        versionId: targetVersionId,
        artifactHash: COMPILED_WEIBO_PLUGIN.artifactHash,
      })),
      accounts: reusable.census.accounts.map((row) => {
        const migrated = row.versionId !== targetVersionId
        return {
          ...row,
          versionId: targetVersionId,
          revision: row.revision + (migrated ? 1 : 0),
          secretGeneration: migrated
            ? String(BigInt(row.secretGeneration) + 1n)
            : row.secretGeneration,
          specHash: COMPILED_WEIBO_PLUGIN.artifactHash,
          execContractHash: COMPILED_WEIBO_PLUGIN.execContractHash,
          authContractVersion: WEIBO_PLUGIN_CONTRACT.account.contractVersion,
        }
      }),
    },
    'Weibo upgrade final census is not the exact verified scope',
  )
  const finalRow = await getPluginAccount(reusable.census.accounts[0]!.id, userId, getPool(), {
    includeError: true,
  })
  if (!finalRow || finalRow.connector_version_id !== targetVersionId)
    throw new Error('Weibo upgraded account pin is missing')
  const finalVerified = await loadVerifiedRuntimePluginContract(
    Number(targetVersionId),
    getPool(),
    {
      env: process.env,
      allowUnlisted: true,
    },
  )
  if (
    finalVerified.pluginType !== 'managed-browser' ||
    finalVerified.slug !== WEIBO_PLUGIN_CONTRACT.id ||
    finalVerified.artifactHash !== COMPILED_WEIBO_PLUGIN.artifactHash ||
    finalVerified.execContractHash !== COMPILED_WEIBO_PLUGIN.execContractHash
  )
    throw new Error('Weibo upgraded account target contract is not exact')
  const finalEnvelope = decryptPluginAccountEnvelope(finalRow, finalVerified.contract, process.env)
  assert.equal(
    finalEnvelope.accountInstanceId,
    reusable.accountInstanceId,
    'Weibo account identity changed during version migration',
  )
  assert.deepEqual(
    finalEnvelope.storageState,
    reusable.storageState,
    'Weibo persisted login state changed during version migration',
  )
  assert.equal(
    writePolicyFingerprint(finalRow),
    reusable.writePolicyFingerprint,
    'Weibo raw write/preapproval grants changed during version migration',
  )
  return {
    id: finalRow.id,
    accountInstanceId: finalEnvelope.accountInstanceId,
    outcome: 'reused',
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? ''
  const match = /^--verify-and-(seed|upgrade)-user=(\d{1,16})$/.exec(mode)
  if (process.argv.length !== 3 || !match)
    throw new Error(
      'usage: seed-weibo-plugin.ts --verify-and-seed-user=ID | --verify-and-upgrade-user=ID',
    )
  const operation = match[1] as 'seed' | 'upgrade'
  const userId = Number(match[2])
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('verification user is invalid')
  const imageId = exactImageId()
  const docker = dockerClient()
  const image = await docker
    .getImage(imageId)
    .inspect()
    .catch(() => null)
  if (!image || image.Id !== imageId) throw new Error('exact runtime image is unavailable')
  if (operation === 'seed') {
    const census = await readOfficialManagedBrowserTransitionCensus(WEIBO_PLUGIN_CONTRACT.id)
    if (census.installs.length > 0 || census.accounts.length > 0)
      throw new Error('existing Weibo users require --verify-and-upgrade-user, not fresh seed mode')
  }
  const reusable = operation === 'upgrade' ? await loadUpgradeAccount(userId) : null
  const storageState = reusable?.storageState ?? (await loadVerifiedState())
  const service = new WeiboDockerService(docker, {
    imageId,
    workerRoot: '/run/openclaude-v5/weibo-plugin-smoke-workers',
    brokerRoot: '/run/openclaude-v5/weibo-plugin-smoke-brokers',
    expectedOwnerUid: 0,
    socketUid: 1000,
    socketGid: 1000,
  })
  let redis: IORedis | null = null
  let restoreSourceGate = false
  try {
    const smoke = await exactImageSmoke(service, storageState)
    const qrDigest = await qrSmoke(service)
    redis = await leaseRedis()
    if (reusable) {
      await assertUpgradeCensusUnchanged(reusable.census)
      await closeOfficialManagedBrowserPluginListingGate({
        slug: WEIBO_PLUGIN_CONTRACT.id,
        env: process.env,
        pool: getPool(),
      })
      restoreSourceGate = true
    }
    let account: Awaited<ReturnType<typeof bindManagedBrowserPluginAccount>> | null = null
    const seeded = await seedWeiboPlugin({
      functionalVerified: true,
      env: process.env,
      leaseRedis: redis,
      ...(reusable
        ? {
            expectedScope: reusable.census,
            beforeListingOpen: async ({ versionId }: { versionId: string }) => {
              // The transition committed, so the old gate can no longer be
              // reopened. Keep the target gated until all exact postconditions pass.
              restoreSourceGate = false
              account = await verifyUpgradedAccount(reusable, userId, versionId)
            },
          }
        : {}),
    })
    restoreSourceGate = false
    if (!reusable) {
      await installApprovedVersion({
        userId,
        versionId: seeded.versionId,
        installAudit: { source: 'official-weibo-live-verification', installedBy: userId },
      })
      account = await bindManagedBrowserPluginAccount({
        userId,
        versionId: Number(seeded.versionId),
        displayName: '微博',
        accountHint: '微博扫码账号',
        storageState: smoke.storageState,
        existing: 'reuse-identical',
        env: process.env,
        pool: getPool(),
      })
    } else if (!account) throw new Error('Weibo upgrade did not verify before listing open')
    process.stdout.write(
      `${JSON.stringify({
        ...seeded,
        account,
        verification: {
          operation,
          userId,
          selfIdDigest: createHash('sha256').update(smoke.selfId).digest('hex'),
          passedActionIds: smoke.passed,
          qrDigest,
          imageId,
          artifactHash: COMPILED_WEIBO_PLUGIN.artifactHash,
          execContractHash: COMPILED_WEIBO_PLUGIN.execContractHash,
          workerDigest: WEIBO_WORKER_DIGEST,
        },
      })}\n`,
    )
  } catch (error) {
    if (restoreSourceGate && reusable) {
      await openOfficialManagedBrowserPluginListingGate({
        slug: WEIBO_PLUGIN_CONTRACT.id,
        expectedVersionId: reusable.sourceVersionId,
        expectedArtifactHash: reusable.sourceArtifactHash,
        expectedExecContractHash: reusable.sourceExecContractHash,
        env: process.env,
        pool: getPool(),
      }).catch((restoreError) => {
        process.stderr.write(
          `Weibo source listing gate recovery failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}\n`,
        )
      })
    }
    throw error
  } finally {
    await service.closeAndDrain().catch(() => {})
    if (redis) await redis.quit().catch(() => redis?.disconnect())
    await closePool().catch(() => {})
    if (operation === 'seed') {
      const keyPath = process.env.OC_WEIBO_VERIFY_KEY_FILE?.trim()
      if (keyPath) await rm(keyPath, { force: true }).catch(() => {})
    }
  }
}

main().catch((error) => {
  process.stderr.write(
    `Weibo Plugin verification/seed failed: ${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exit(1)
})
