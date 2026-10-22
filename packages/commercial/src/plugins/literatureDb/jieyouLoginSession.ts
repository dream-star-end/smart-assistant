import { existsSync } from 'node:fs'
import path from 'node:path'
import { LiteratureArtifactStore, type LiteratureArtifactStoreOptions } from './artifactStore.js'
import {
  LITERATURE_ARTIFACT_LOG_MSG,
  LITERATURE_CALL_LOG_MSG,
  type LiteratureCallEvent,
} from './observability.js'
import { WanfangLiteratureHttpExecutor } from './httpExecutor.js'
import { createLocalCaptchaReader } from './localCaptchaReader.js'
import { LiteratureSetupService, type LiteratureSetupOptions } from './setupService.js'
/** Positive login session adapter over JieyouHttpClient for LiteratureSetupService. */
import type { JieyouAccountState } from './accountState.js'
import {
  type CaptchaBudget,
  type CaptchaImage,
  type CaptchaReader,
  LiteratureCaptchaSolver,
} from './captcha.js'
import { type LiteratureCredentials, parseLiteratureCredentials } from './credentials.js'
import { LiteratureError } from './errors.js'
import { JieyouHttpClient, type JieyouLoginForm } from './jieyouHttpClient.js'
import type { LiteratureLoginSession, LoginOutcome } from './login.js'
import { LITERATURE_SITE } from './policy.js'
import { type LiteratureHttpResponse, LiteratureHttpTransport } from './transport.js'

const MEMBER_LIST_URL = `${LITERATURE_SITE}/e/action/ListInfo/?classid=61`

function decodeHtmlBody(body: Buffer, contentType?: string): string {
  const declared =
    /charset=([\w-]+)/i.exec(contentType ?? '')?.[1] ??
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(body.subarray(0, 4096).toString('latin1'))?.[1] ??
    'utf-8'
  const enc = /gb/i.test(declared) ? 'gb18030' : declared.toLowerCase()
  try {
    return new TextDecoder(enc, { fatal: false }).decode(body)
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(body)
  }
}

export function hasJieyouMemberAuthCookies(state: JieyouAccountState): boolean {
  const names = new Set(state.cookies.map((c) => c.name))
  let hasUserId = false
  let hasAuth = false
  for (const name of names) {
    if (name.endsWith('mluserid')) hasUserId = true
    if (name.endsWith('mlauth')) hasAuth = true
  }
  return hasUserId && hasAuth
}

export function classifyJieyouLoginPost(
  response: LiteratureHttpResponse,
  state: JieyouAccountState,
): LoginOutcome {
  if (response.status === 403 || response.status === 429) return 'blocked'
  if (response.status >= 300 && response.status < 400) {
    return hasJieyouMemberAuthCookies(state) ? 'authenticated' : 'unknown'
  }
  if (response.status !== 200) return 'unknown'
  const html = decodeHtmlBody(response.body, response.headers['content-type'])
  if (/禁止|锁定|封禁|频繁/.test(html) && !/登录成功/.test(html)) return 'blocked'
  if (/验证码/.test(html) && !/登录成功/.test(html)) return 'captcha_invalid'
  if (
    /用户名|密码|账号/.test(html) &&
    /错误|有误|不存在|不正确|失败/.test(html) &&
    !/登录成功/.test(html)
  ) {
    return 'credentials_invalid'
  }
  if (/登录成功/.test(html) && hasJieyouMemberAuthCookies(state)) {
    return 'authenticated'
  }
  return 'unknown'
}

function selectLifetime(form: JieyouLoginForm): string {
  const preferred =
    form.lifetimes.find((item) => item.value === '86400') ??
    form.lifetimes.find((item) => item.value === '3600')
  if (preferred) return preferred.value
  const checked = form.lifetimes.find((item) => item.checked)
  if (checked) return checked.value
  const first = form.lifetimes[0]
  if (!first) throw new LiteratureError('RESPONSE_INVALID')
  return first.value
}

export async function createJieyouLoginSession(input: {
  credentials: LiteratureCredentials
  signal: AbortSignal
  transport?: LiteratureHttpTransport
  client?: JieyouHttpClient
}): Promise<LiteratureLoginSession> {
  if (input.signal.aborted) throw new LiteratureError('CANCELLED')
  const parsed = parseLiteratureCredentials(input.credentials)
  const credentialBytes = Buffer.from(JSON.stringify(parsed), 'utf8')
  const client =
    input.client ??
    new JieyouHttpClient(
      input.transport ??
        new LiteratureHttpTransport({ timeoutMs: 15_000, maxResponseBytes: 2 * 1024 * 1024 }),
    )
  let form: JieyouLoginForm | undefined
  let currentChallengeId: string | undefined
  let closed = false

  const readCredentials = (): LiteratureCredentials => {
    if (closed) throw new LiteratureError('CANCELLED')
    return parseLiteratureCredentials(JSON.parse(credentialBytes.toString('utf8')))
  }

  const probeMemberList = async (signal: AbortSignal): Promise<boolean> => {
    if (closed || signal.aborted) throw new LiteratureError('CANCELLED')
    const state = client.exportPrivateCookies()
    if (!hasJieyouMemberAuthCookies(state)) return false
    const { response } = await client.getMemberPage(MEMBER_LIST_URL, signal)
    if (response.status !== 200) return false
    const html = decodeHtmlBody(response.body, response.headers['content-type'])
    if (html.includes('您还没登录') || html.includes('请先登录')) return false
    return html.includes('ShowInfo.php') || html.includes('classid=') || html.includes('解忧图书馆')
  }

  return {
    async challenge(signal: AbortSignal): Promise<CaptchaImage> {
      if (closed || signal.aborted) throw new LiteratureError('CANCELLED')
      if (!form) {
        form = await client.loadLoginPage(signal)
      }
      const next = await client.getChallenge(signal)
      currentChallengeId = next.challengeId
      return next.image
    },
    async submit(answer: string, signal: AbortSignal): Promise<LoginOutcome> {
      if (closed || signal.aborted) throw new LiteratureError('CANCELLED')
      if (!form || !currentChallengeId) throw new LiteratureError('CHALLENGE_STALE')
      const challengeId = currentChallengeId
      currentChallengeId = undefined
      const lifetime = selectLifetime(form)
      const { response } = await client.submit(
        {
          challengeId,
          credentials: readCredentials(),
          answer,
          lifetime,
        },
        signal,
      )
      const state = client.exportPrivateCookies()
      const outcome = classifyJieyouLoginPost(response, state)
      if (outcome === 'authenticated') {
        const verified = await probeMemberList(signal)
        return verified ? 'authenticated' : 'unknown'
      }
      return outcome
    },
    async probe(signal: AbortSignal): Promise<boolean> {
      return probeMemberList(signal)
    },
    async snapshot(signal: AbortSignal): Promise<JieyouAccountState> {
      if (closed || signal.aborted) throw new LiteratureError('CANCELLED')
      return client.exportPrivateCookies()
    },
    async close(): Promise<void> {
      closed = true
      currentChallengeId = undefined
      form = undefined
      credentialBytes.fill(0)
      await client.close()
    },
  }
}

export async function reloginJieyouAutomatically(input: {
  credentials: LiteratureCredentials
  readers: readonly CaptchaReader[]
  signal: AbortSignal
  maxAttempts?: number
  maxCloudCalls?: number
  createSession?: typeof createJieyouLoginSession
}): Promise<{ storageState: JieyouAccountState; verifiedAt: number }> {
  if (input.signal.aborted) throw new LiteratureError('CANCELLED')
  const maxAttempts = input.maxAttempts ?? 4
  const budget: CaptchaBudget = {
    cloudCalls: 0,
    maxCloudCalls: input.maxCloudCalls ?? 2,
  }
  const solver = new LiteratureCaptchaSolver(input.readers, 15_000, true)
  const session = await (input.createSession ?? createJieyouLoginSession)({
    credentials: input.credentials,
    signal: input.signal,
  })
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (input.signal.aborted) throw new LiteratureError('CANCELLED')
      const challenge = await session.challenge(input.signal)
      let answer: string
      try {
        answer = await solver.solve(challenge, budget, input.signal)
      } catch (err) {
        if (input.signal.aborted) throw err
        if (attempt < maxAttempts) continue
        throw err
      }
      const outcome = await session.submit(answer, input.signal)
      if (outcome === 'authenticated') {
        const storageState = (await session.snapshot(input.signal)) as JieyouAccountState
        return { storageState, verifiedAt: Date.now() }
      }
      if (outcome === 'unknown') {
        if (await session.probe(input.signal)) {
          const storageState = (await session.snapshot(input.signal)) as JieyouAccountState
          return { storageState, verifiedAt: Date.now() }
        }
        throw new LiteratureError('LOGIN_FAILED')
      }
      if (outcome === 'credentials_invalid') {
        throw new LiteratureError('CREDENTIALS_INVALID')
      }
      if (outcome === 'blocked') {
        throw new LiteratureError('UPSTREAM_BLOCKED')
      }
    }
    throw new LiteratureError('LOGIN_FAILED')
  } finally {
    await session.close().catch(() => {})
  }
}

export const DEFAULT_LITERATURE_CAPTCHA_BUNDLE_ROOT = '/opt/openclaude/literature-captcha-bundle'

export function resolveLiteratureCaptchaBundleRoot(
  env: NodeJS.ProcessEnv = process.env,
  hasFile: (filePath: string) => boolean = existsSync,
): string | undefined {
  const raw = env.OPENCLAUDE_LITERATURE_CAPTCHA_BUNDLE_ROOT
  if (raw !== undefined) {
    const trimmed = raw.trim()
    return trimmed && path.isAbsolute(trimmed) ? trimmed : undefined
  }
  const python = path.join(DEFAULT_LITERATURE_CAPTCHA_BUNDLE_ROOT, 'venv/bin/python')
  const runner = path.join(DEFAULT_LITERATURE_CAPTCHA_BUNDLE_ROOT, 'runner.py')
  return hasFile(python) && hasFile(runner) ? DEFAULT_LITERATURE_CAPTCHA_BUNDLE_ROOT : undefined
}

export function createCommercialLiteratureRuntime(input: {
  runtimeChannel: string
  redis: LiteratureSetupOptions['redis']
  env?: NodeJS.ProcessEnv
  onArtifactEvent?: LiteratureArtifactStoreOptions['onEvent']
  /** Structured logger (rootLogger); wires literature_plugin_call / literature_artifact lines. */
  logger?: {
    child(bindings: Record<string, unknown>): {
      info(msg: string, fields?: Record<string, unknown>): void
    }
  }
}) {
  const log = input.logger?.child({ subsys: 'plugins', module: 'literature-db' })
  const onArtifactEvent =
    input.onArtifactEvent ??
    (log
      ? (event: Parameters<NonNullable<LiteratureArtifactStoreOptions['onEvent']>>[0]) =>
          log.info(LITERATURE_ARTIFACT_LOG_MSG, { ...event })
      : undefined)
  const literatureObserver = log
    ? (event: LiteratureCallEvent) => log.info(LITERATURE_CALL_LOG_MSG, { ...event })
    : undefined
  const bundleRoot = resolveLiteratureCaptchaBundleRoot(input.env)
  const readers = bundleRoot ? () => [createLocalCaptchaReader({ bundleRoot })] : () => []
  const literatureArtifacts =
    input.runtimeChannel === 'v5'
      ? new LiteratureArtifactStore(onArtifactEvent ? { onEvent: onArtifactEvent } : {})
      : undefined
  const literatureHttp =
    literatureArtifacts !== undefined
      ? new WanfangLiteratureHttpExecutor({
          artifactStore: literatureArtifacts,
          ...(input.env ? { env: input.env } : {}),
        })
      : undefined
  const literatureRelogin =
    input.runtimeChannel === 'v5'
      ? ({
          credentials,
          signal,
        }: {
          userId: number
          accountId: string
          credentials: LiteratureCredentials
          signal: AbortSignal
        }) => reloginJieyouAutomatically({ credentials, readers: readers(), signal })
      : undefined
  const literatureSetup = new LiteratureSetupService(
    input.runtimeChannel === 'v5'
      ? {
          redis: input.redis,
          createSession: ({ credentials, signal }) =>
            createJieyouLoginSession({ credentials, signal }),
          readers: () => readers(),
          isAgentReady: () => literatureHttp !== undefined,
        }
      : { redis: input.redis },
  )
  return {
    literatureSetup,
    literatureArtifacts,
    literatureHttp,
    literatureRelogin,
    literatureObserver,
  }
}
