#!/usr/bin/env tsx
/**
 * Official Douyin Plugin (OCV5-553): live verification and seed. This version is read-only.
 *
 *   --advisory-status
 *       No login, no worker. Prints whether the current listing exists and matches the code pins.
 *   --verify-and-seed-user=ID --qr-out=/root/<file>.png   (or --verify-only: no DB writes)
 *       Needs ONE real QR scan by the operator. Starts the exact-image login worker, writes the
 *       official Douyin QR PNG to --qr-out (root-only, refreshed while it changes), waits for the
 *       scan, runs every read action once through ManagedBrowserRuntime with that session (schema
 *       validated), and only if all pass: seeds the listing (functionalVerified), installs it for
 *       user ID and binds the scanned account. The storage state never leaves process memory and is
 *       never printed; the QR file is deleted on exit.
 */

import { execFileSync } from 'node:child_process'
import { closeSync, constants as fsConstants, lstatSync, openSync, readSync, rmSync } from 'node:fs'
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
// 与 douyinSetup 一致:二维码约 1 分钟出现,扫码后本人短信验证 3 分钟(设计 4.3.C)。
const LOGIN_WINDOW_MS = 8 * 60_000

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

/** 建 root-only 命名管道:验证码只经过内存,不落盘。 */
/**
 * 建 root-only 命名管道并以非阻塞方式打开读端:验证码只经过内存、不落盘;读取靠轮询,没有被阻塞的线程,
 * 管道被删或登录结束都不会让 CLI 卡住(Codex r2 P1)。
 */
function openSmsFifo(path: string): number {
  rmSync(path, { force: true })
  execFileSync('mkfifo', ['-m', '600', path])
  if (!lstatSync(path).isFIFO()) throw new Error('sms code path is not a FIFO')
  return openSync(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK)
}

/** 轮询读一次验证码:写端写完关闭后才算一条;超时或登录已结束返回 null。只返回数字,不打印。 */
async function waitForSmsCode(
  fd: number,
  untilMs: number,
  stopped: () => boolean,
): Promise<string | null> {
  const chunk = Buffer.alloc(64)
  let pending = ''
  while (Date.now() < untilMs && !stopped()) {
    let n = 0
    try {
      n = readSync(fd, chunk, 0, chunk.length, null)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') throw error
    }
    if (n > 0) {
      pending += chunk.toString('utf8', 0, n)
      chunk.fill(0)
      if (pending.length > 64) pending = ''
      continue
    }
    if (pending) {
      const code = pending.replace(/[^0-9]/g, '')
      pending = ''
      if (/^[0-9]{4,8}$/.test(code)) return code
      log({ step: 'sms-code-invalid-format' })
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200))
  }
  return null
}

async function scanLogin(
  service: DouyinDockerService,
  qrOut: string,
  smsCodeFifo: string,
): Promise<BrowserStorageStateV1> {
  const pins = await resolveDouyinLoginPins()
  let state = null as BrowserStorageStateV1 | null
  let failure = null as string | null
  let qrCount = 0
  let attempts = 0
  let smsDeadline = 0
  // 先声明再赋值:回调可能在 startLogin 返回前触发,命令通过 handleRef 发出。
  let handleRef: Awaited<ReturnType<DouyinDockerService['startLogin']>> | null = null
  const submitNextCode = async () => {
    if (!handleRef) return
    if (attempts >= 3) {
      await handleRef.command({ cmd: 'abort' }).catch(() => {})
      return
    }
    const code = await waitForSmsCode(fifoFd, smsDeadline, () => loginEnded)
    if (code === null) {
      log({ step: 'sms-timeout' })
      await handleRef.command({ cmd: 'abort' }).catch(() => {})
      return
    }
    attempts += 1
    log({ step: 'sms-submit', attempt: attempts })
    await handleRef.command({ cmd: 'sms_code', code }).catch(() => {})
  }
  const fifoFd = openSmsFifo(smsCodeFifo)
  let loginEnded = false
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
    onVerification: (kind) => {
      log({ step: 'verification', kind })
      smsDeadline = Date.now() + 3 * 60_000
      void handleRef
        ?.command({ cmd: kind === 'sms_available' ? 'send_sms' : 'abort' })
        .catch(() => {})
    },
    onSmsSent: () => {
      log({ step: 'sms-sent', fifo: smsCodeFifo, hint: '执行 echo <验证码> > 这个管道(只写数字)' })
      void submitNextCode()
    },
    onSmsRejected: () => {
      log({ step: 'sms-rejected', attemptsLeft: 3 - attempts })
      void submitNextCode()
    },
  })
  handleRef = handle
  let doneError: unknown = null
  await handle.done.catch((error: unknown) => {
    doneError = error ?? new Error('WORKER_FAILED')
  })
  loginEnded = true
  closeSync(fifoFd)
  await rm(smsCodeFifo, { force: true }).catch(() => {})
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
  const videos = await run('my_videos', { count: 5 })
  const items = videos.items as Array<{ awemeId?: string }>
  summary.my_videos = `n=${items.length} hasMore=${String(videos.hasMore)}`
  // 评论接口登录后的形状未实测：必须用真实作品跑一次。账号没有作品时无法完成上架前实测。
  const firstVideo = items.find((item) => item.awemeId)?.awemeId
  if (firstVideo) {
    const comments = await run('video_comments', { awemeId: firstVideo, count: 5 })
    summary.video_comments = `n=${(comments.items as unknown[]).length}`
  }
  // 每个动作都必须被真实执行过一次。
  const missing = douyinSmokeActionIds().filter((id) => !covered.has(id))
  if (missing.length > 0) throw new Error(`smoke did not exercise: ${missing.join(',')}`)
  return { storageState, summary }
}

async function verifyAndSeed(
  userId: number | null,
  qrOut: string,
  smsCodeFifo: string,
): Promise<void> {
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
    const scanned = await scanLogin(service, qrOut, smsCodeFifo)
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
    else if (cli.mode === 'verify-only') await verifyAndSeed(null, cli.qrOut, cli.smsCodeFifo)
    else await verifyAndSeed(cli.userId, cli.qrOut, cli.smsCodeFifo)
    return 0
  } catch (error) {
    console.error(`seed-douyin-plugin: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  } finally {
    await closePool().catch(() => {})
  }
}

process.exitCode = await main()
