#!/usr/bin/env tsx
/**
 * Official Douyin Plugin (OCV5-553): live verification and seed. This version is read-only.
 *
 *   --advisory-status
 *       No login, no worker. Prints whether the 1.0.0 listing exists and matches the code pins.
 *   --verify-and-seed-user=ID --qr-out=/root/<file>.png   (or --verify-only: no DB writes)
 *       Needs ONE real QR scan by the operator. Starts the exact-image login worker, writes the
 *       official Douyin QR PNG to --qr-out (root-only, refreshed while it changes), waits for the
 *       scan, runs every read action once through ManagedBrowserRuntime with that session (schema
 *       validated), and only if all pass: seeds the listing (functionalVerified), installs it for
 *       user ID and binds the scanned account. The storage state never leaves process memory and is
 *       never printed; the QR file is deleted on exit.
 */

import { chmod, rm, writeFile } from 'node:fs/promises'

import Docker from 'dockerode'

import { closePool, getPool } from '../src/db/index.js'
import { query } from '../src/db/queries.js'
import { installApprovedVersion } from '../src/marketplace/marketplaceDb.js'
import {
  DOUYIN_SEED_CLI_USAGE,
  douyinSmokeActionIds,
  findApprovedDouyinPlugin,
  parseDouyinSeedCliArgs,
  requireCleanLogin,
  seedDouyinPlugin,
} from '../src/marketplace/seedDouyinPlugin.js'
import {
  type BrowserStorageStateV1,
  createManagedBrowserPluginAccount,
} from '../src/plugins/accounts.js'
import { ManagedBrowserRuntime } from '../src/plugins/browserRuntime.js'
import {
  COMPILED_DOUYIN_PLUGIN,
  DOUYIN_PLUGIN_CONTRACT,
  DOUYIN_SEED_BROKER_ROOT,
  DOUYIN_SEED_WORKER_ROOT,
  DouyinDockerService,
  createDouyinRuntimeRegistries,
  validateDouyinState,
} from '../src/plugins/douyin.js'
import { resolveDouyinLoginPins } from '../src/plugins/douyinSetup.js'

const IMAGE_ID_RE = /^sha256:[0-9a-f]{64}$/
// 与 douyinSetup 一致:二维码约 1 分钟后才出现,留 4 分钟扫码。
const LOGIN_WINDOW_MS = 5 * 60_000

function exactImageId(): string {
  if (process.env.OC_RUNTIME_CHANNEL !== 'v5') throw new Error('Douyin seed is V5-only')
  const imageId = process.env.OC_RUNTIME_IMAGE_ID?.trim() ?? ''
  if (!IMAGE_ID_RE.test(imageId)) throw new Error('OC_RUNTIME_IMAGE_ID must be an exact image ID')
  return imageId
}

function dockerClient(): Docker {
  const socketPath = process.env.AGENT_DOCKER_SOCKET?.trim()
  return socketPath ? new Docker({ socketPath }) : new Docker()
}

function log(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), ...event }))
}

async function advisoryStatus(): Promise<void> {
  const approved = await findApprovedDouyinPlugin()
  log({
    step: 'advisory-status',
    approved: approved !== null,
    versionId: approved?.versionId ?? null,
    artifactHash: COMPILED_DOUYIN_PLUGIN.artifactHash,
    execContractHash: COMPILED_DOUYIN_PLUGIN.execContractHash,
  })
}

async function scanLogin(
  service: DouyinDockerService,
  qrOut: string,
): Promise<BrowserStorageStateV1> {
  const pins = await resolveDouyinLoginPins()
  let state = null as BrowserStorageStateV1 | null
  let failure = null as string | null
  let qrCount = 0
  const handle = await service.startLogin({
    sessionId: crypto.randomUUID(),
    pins,
    deadlineMs: Date.now() + LOGIN_WINDOW_MS,
    onQr: (png) => {
      qrCount += 1
      void writeFile(qrOut, png, { mode: 0o600 })
        .then(() => chmod(qrOut, 0o600))
        .then(() => log({ step: 'qr', file: qrOut, n: qrCount, hint: '请用抖音 App 扫码并确认' }))
        .catch(() => log({ step: 'qr-write-failed' }))
    },
    onAuthenticated: (raw) => {
      try {
        state = validateDouyinState(raw)
        log({ step: 'authenticated', cookies: state.cookies.length })
      } catch {
        failure = 'STATE_INVALID'
      }
    },
    onFailed: (code) => {
      failure = code
    },
  })
  let doneError: unknown = null
  await handle.done.catch((error: unknown) => {
    doneError = error ?? new Error('WORKER_FAILED')
  })
  return requireCleanLogin({ state, failure, doneError })
}

async function smoke(
  service: DouyinDockerService,
  initial: BrowserStorageStateV1,
): Promise<{ storageState: BrowserStorageStateV1; summary: Record<string, string> }> {
  const runtime = new ManagedBrowserRuntime({
    ...createDouyinRuntimeRegistries(service),
    profileRoot: '/run/openclaude-v5/douyin-smoke-profiles',
    expectedOwnerUid: 0,
  })
  let storageState = initial
  const summary: Record<string, string> = {}
  const covered = new Set<string>()
  const run = async (actionId: string, params: Record<string, unknown>) => {
    // 失败时记下是哪个动作(只记动作名和错误码,不记参数和登录态)。
    const executed = await runtime
      .runReadAction({
        contract: DOUYIN_PLUGIN_CONTRACT,
        storageState,
        actionId,
        params,
        signal: new AbortController().signal,
      })
      .catch((error: unknown) => {
        const code = (error as { code?: unknown } | null)?.code
        log({
          step: 'smoke-failed',
          action: actionId,
          code: typeof code === 'string' ? code : null,
        })
        throw error
      })
    storageState = executed.storageState
    covered.add(actionId)
    return executed.result as Record<string, unknown>
  }
  const me = await run('me', {})
  if (!(typeof me.nickname === 'string' && me.nickname && (me.uid || me.secUid)))
    throw new Error('me returned no account')
  // 只记形状(哪些字段有值),不记昵称和 ID。
  summary.me = `fields=${Object.keys(me).sort().join('+')}`
  // 每个动作都必须被真实执行过一次。
  const missing = douyinSmokeActionIds().filter((id) => !covered.has(id))
  if (missing.length > 0) throw new Error(`smoke did not exercise: ${missing.join(',')}`)
  return { storageState, summary }
}

async function verifyAndSeed(userId: number | null, qrOut: string): Promise<void> {
  if (userId !== null) {
    const user = await query<{ status: string }>('SELECT status FROM users WHERE id = $1', [userId])
    if (user.rows[0]?.status !== 'active') throw new Error('verification user is not active')
  }
  const docker = dockerClient()
  const imageId = exactImageId()
  const service = new DouyinDockerService(docker, {
    imageId,
    workerRoot: DOUYIN_SEED_WORKER_ROOT,
    brokerRoot: DOUYIN_SEED_BROKER_ROOT,
    expectedOwnerUid: 0,
    socketUid: 1000,
    socketGid: 1000,
  })
  try {
    log({ step: 'login-start', windowSec: LOGIN_WINDOW_MS / 1000 })
    const scanned = await scanLogin(service, qrOut)
    await rm(qrOut, { force: true })
    const { storageState, summary } = await smoke(service, scanned)
    log({ step: 'smoke-passed', ...summary })
    // --verify-only:到此为止(上架前检查),不发布、不安装、不绑定,登录状态随进程丢弃。
    if (userId === null) {
      log({ step: 'verify-only-done', seeded: false })
      return
    }
    const seeded = await seedDouyinPlugin({ functionalVerified: true })
    log({ step: 'seeded', versionId: seeded.versionId, published: seeded.published })
    await installApprovedVersion({ userId, versionId: seeded.versionId })
    const account = await createManagedBrowserPluginAccount({
      userId,
      versionId: Number(seeded.versionId),
      displayName: '抖音',
      accountHint: '抖音扫码账号',
      storageState,
      pool: getPool(),
    })
    log({ step: 'bound', accountId: account.id })
  } finally {
    await rm(qrOut, { force: true }).catch(() => {})
    await service.closeAndDrain().catch(() => {})
  }
}

async function main(): Promise<number> {
  let cli: ReturnType<typeof parseDouyinSeedCliArgs>
  try {
    cli = parseDouyinSeedCliArgs(process.argv.slice(2))
  } catch {
    console.error(DOUYIN_SEED_CLI_USAGE)
    return 2
  }
  try {
    if (cli.mode === 'advisory-status') await advisoryStatus()
    else if (cli.mode === 'verify-only') await verifyAndSeed(null, cli.qrOut)
    else await verifyAndSeed(cli.userId, cli.qrOut)
    return 0
  } catch (error) {
    console.error(`seed-douyin-plugin: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  } finally {
    await closePool().catch(() => {})
  }
}

process.exitCode = await main()
