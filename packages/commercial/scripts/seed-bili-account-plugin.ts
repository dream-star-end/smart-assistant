#!/usr/bin/env tsx
/**
 * Official Bilibili account Plugin (OCV5-402): live verification and seed. Read-only plugin.
 *
 *   --advisory-status
 *       No login, no worker. Prints whether the 1.0.0 listing exists and matches the code pins.
 *   --verify-and-seed-user=ID --qr-out=/root/<file>.png [--subtitle-bvid=BV…]
 *       Needs ONE real QR scan by the operator. Starts the exact-image login worker, writes the
 *       official Bilibili QR PNG to --qr-out (root-only, refreshed while it changes), waits for the
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
  BILI_ACCOUNT_SEED_CLI_USAGE,
  biliAccountSmokeActionIds,
  findApprovedBiliAccountPlugin,
  requireCleanLogin,
  parseBiliAccountSeedCliArgs,
  seedBiliAccountPlugin,
} from '../src/marketplace/seedBiliAccountPlugin.js'
import {
  type BrowserStorageStateV1,
  createManagedBrowserPluginAccount,
} from '../src/plugins/accounts.js'
import {
  BILI_ACCOUNT_PLUGIN_CONTRACT,
  BiliAccountDockerService,
  COMPILED_BILI_ACCOUNT_PLUGIN,
  createBiliAccountRuntimeRegistries,
  validateBiliAccountState,
} from '../src/plugins/biliAccount.js'
import { resolveBiliAccountLoginPins } from '../src/plugins/biliAccountSetup.js'
import { ManagedBrowserRuntime } from '../src/plugins/browserRuntime.js'

const IMAGE_ID_RE = /^sha256:[0-9a-f]{64}$/
const LOGIN_WINDOW_MS = 4 * 60_000

function exactImageId(): string {
  if (process.env.OC_RUNTIME_CHANNEL !== 'v5') throw new Error('Bilibili account seed is V5-only')
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
  const approved = await findApprovedBiliAccountPlugin()
  log({
    step: 'advisory-status',
    approved: approved !== null,
    versionId: approved?.versionId ?? null,
    artifactHash: COMPILED_BILI_ACCOUNT_PLUGIN.artifactHash,
    execContractHash: COMPILED_BILI_ACCOUNT_PLUGIN.execContractHash,
  })
}

async function scanLogin(
  service: BiliAccountDockerService,
  qrOut: string,
): Promise<BrowserStorageStateV1> {
  const pins = await resolveBiliAccountLoginPins()
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
        .then(() =>
          log({ step: 'qr', file: qrOut, n: qrCount, hint: '请用哔哩哔哩 App 扫码并确认' }),
        )
        .catch(() => log({ step: 'qr-write-failed' }))
    },
    onAuthenticated: (raw) => {
      try {
        state = validateBiliAccountState(raw)
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
  service: BiliAccountDockerService,
  initial: BrowserStorageStateV1,
  subtitleBvid: string | null,
): Promise<{ storageState: BrowserStorageStateV1; summary: Record<string, string> }> {
  const runtime = new ManagedBrowserRuntime({
    ...createBiliAccountRuntimeRegistries(service),
    profileRoot: '/run/openclaude-v5/bili-account-smoke-profiles',
    expectedOwnerUid: 0,
  })
  let storageState = initial
  const summary: Record<string, string> = {}
  const covered = new Set<string>()
  const run = async (actionId: string, params: Record<string, unknown>) => {
    const executed = await runtime.runReadAction({
      contract: BILI_ACCOUNT_PLUGIN_CONTRACT,
      storageState,
      actionId,
      params,
      signal: new AbortController().signal,
    })
    storageState = executed.storageState
    covered.add(actionId)
    return executed.result as Record<string, unknown>
  }
  const me = await run('me', {})
  if (!(typeof me.mid === 'number' && me.mid > 0)) throw new Error('me returned no account')
  summary.me = 'ok'
  const folders = (await run('favorite_folders', {})).folders as Array<{ id: number }>
  summary.favorite_folders = `n=${folders.length}`
  const firstFolder = folders[0]?.id
  if (firstFolder) {
    const fav = await run('favorite_items', { folderId: firstFolder, pageSize: 5 })
    summary.favorite_items = `n=${(fav.items as unknown[]).length}`
  }
  const history = (await run('history', { pageSize: 5 })).items as Array<{ bvid?: string }>
  summary.history = `n=${history.length}`
  const bvid = subtitleBvid ?? history.find((item) => item.bvid)?.bvid
  if (bvid) {
    const sub = await run('subtitle', { bvid })
    summary.subtitle = `available=${(sub.available as unknown[]).length} lines=${(sub.lines as unknown[]).length}`
  }
  // 每个动作都必须被真实执行过一次;收藏夹为空或没有历史时,要求运维给 --subtitle-bvid 并补齐。
  const missing = biliAccountSmokeActionIds().filter((id) => !covered.has(id))
  if (missing.length > 0) throw new Error(`smoke did not exercise: ${missing.join(',')}`)
  return { storageState, summary }
}

async function verifyAndSeed(
  userId: number,
  qrOut: string,
  subtitleBvid: string | null,
): Promise<void> {
  const user = await query<{ status: string }>('SELECT status FROM users WHERE id = $1', [userId])
  if (user.rows[0]?.status !== 'active') throw new Error('verification user is not active')
  const docker = dockerClient()
  const imageId = exactImageId()
  const service = new BiliAccountDockerService(docker, {
    imageId,
    workerRoot: '/var/lib/openclaude-v5/plugin-workers-bili-account-seed',
    brokerRoot: '/run/openclaude-v5/plugin-browser-brokers-bili-account-seed',
    expectedOwnerUid: 0,
    socketUid: 1000,
    socketGid: 1000,
  })
  try {
    log({ step: 'login-start', windowSec: LOGIN_WINDOW_MS / 1000 })
    const scanned = await scanLogin(service, qrOut)
    await rm(qrOut, { force: true })
    const { storageState, summary } = await smoke(service, scanned, subtitleBvid)
    log({ step: 'smoke-passed', ...summary })
    const seeded = await seedBiliAccountPlugin({ functionalVerified: true })
    log({ step: 'seeded', versionId: seeded.versionId, published: seeded.published })
    await installApprovedVersion({ userId, versionId: seeded.versionId })
    const account = await createManagedBrowserPluginAccount({
      userId,
      versionId: Number(seeded.versionId),
      displayName: '哔哩哔哩',
      accountHint: 'B 站扫码账号',
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
  let cli: ReturnType<typeof parseBiliAccountSeedCliArgs>
  try {
    cli = parseBiliAccountSeedCliArgs(process.argv.slice(2))
  } catch {
    console.error(BILI_ACCOUNT_SEED_CLI_USAGE)
    return 2
  }
  try {
    if (cli.mode === 'advisory-status') await advisoryStatus()
    else await verifyAndSeed(cli.userId, cli.qrOut, cli.subtitleBvid)
    return 0
  } catch (error) {
    console.error(
      `seed-bili-account-plugin: ${error instanceof Error ? error.message : String(error)}`,
    )
    return 1
  } finally {
    await closePool().catch(() => {})
  }
}

process.exitCode = await main()
