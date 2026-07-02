/**
 * 容器 gateway → master 的 turn 免单上报(best-effort)。
 *
 * 触发点:sessionManager 的两处 idle-timeout 杀 turn 路径(liveness watchdog
 * 5/15min 档 + _runOneTurn 内 30min 硬兜底)。用户视角这轮"模型无响应/超时",
 * boss 红线是这种 turn 不许扣费 —— 但计费在 master 代理层按上游请求逐笔 settle,
 * 容器这边只能事后上报窗口让 master 冲正(见 master 侧
 * packages/commercial/src/http/internalTurnWaive.ts 头注)。
 *
 * 语义:
 *   - fire-and-forget:失败只 warn,绝不影响 turn 清理主路径。
 *   - **延迟 5s 发送**:idle-timeout interrupt 后,在飞的上游请求可能还差最后
 *     一拍 settle(Ark 缓冲流被掐时 usage 可能刚好 commit);等一拍再上报,
 *     把这笔也圈进退款窗口。
 *   - 复用 v3MasterSink 同款 env(OPENCLAUDE_V3_MASTER_BASE_URL /
 *     OPENCLAUDE_V3_CONTAINER_TOKEN);env 缺(个人版/dev)→ 静默 no-op。
 *   - 单次尝试 + 一次重试(10s 后)。幂等由 master 端保证,重复无害。
 */

import { request as undiciRequest } from 'undici'

import { createLogger } from './logger.js'

const log = createLogger({ module: 'masterTurnWaive' })

const SEND_DELAY_MS = 5_000
const RETRY_DELAY_MS = 10_000
const ATTEMPT_TIMEOUT_MS = 10_000
const WAIVE_PATH = '/internal/v3/turn-waive'

export interface TurnWaiveReport {
  /** CCB 内部会话 UUID(= master usage_records.session_id 口径)。 */
  sessionId: string
  /** turn 起始 ms epoch —— master 只冲正这之后 settle 的记录。 */
  sinceTs: number
  reason: 'idle_timeout' | 'no_response'
}

/** 测试钩子:注入假 fetcher/timer。生产走默认。 */
export interface TurnWaiveSendOpts {
  fetcher?: typeof undiciRequest
  env?: NodeJS.ProcessEnv
  /** 测试直发(跳过 5s 延迟)。 */
  immediate?: boolean
}

async function attempt(
  baseUrl: string,
  bearer: string,
  report: TurnWaiveReport,
  fetcher: typeof undiciRequest,
): Promise<void> {
  const r = await fetcher(`${baseUrl}${WAIVE_PATH}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bearer}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(report),
    headersTimeout: ATTEMPT_TIMEOUT_MS,
    bodyTimeout: ATTEMPT_TIMEOUT_MS,
  })
  const text = await r.body.text().catch(() => '')
  if (r.statusCode !== 200) {
    throw new Error(`turn-waive HTTP ${r.statusCode}: ${text.slice(0, 200)}`)
  }
  let refunded = 'unknown'
  try {
    refunded = String(JSON.parse(text)?.refundedCredits ?? 'unknown')
  } catch {
    /* body shape drift — non-fatal */
  }
  log.info('turn waive reported', {
    sessionId: report.sessionId,
    reason: report.reason,
    refundedCredits: refunded,
  })
}

/**
 * Fire-and-forget 上报。env 缺失(个人版/dev sandbox)静默跳过。
 * 绝不 throw —— 所有失败路径收敛为 warn 日志。
 */
export function sendTurnWaiveBestEffort(report: TurnWaiveReport, opts: TurnWaiveSendOpts = {}): void {
  const env = opts.env ?? process.env
  const baseUrl = env.OPENCLAUDE_V3_MASTER_BASE_URL?.replace(/\/+$/, '')
  const bearer = env.OPENCLAUDE_V3_CONTAINER_TOKEN
  if (!baseUrl || !bearer) return
  const fetcher = opts.fetcher ?? undiciRequest
  const run = async () => {
    try {
      await attempt(baseUrl, bearer, report, fetcher)
    } catch (err) {
      log.warn('turn waive first attempt failed, retrying once', {
        sessionId: report.sessionId,
        err: (err as Error).message,
      })
      await new Promise((r) => setTimeout(r, opts.immediate ? 0 : RETRY_DELAY_MS))
      try {
        await attempt(baseUrl, bearer, report, fetcher)
      } catch (err2) {
        log.warn('turn waive report dropped after retry', {
          sessionId: report.sessionId,
          sinceTs: report.sinceTs,
          err: (err2 as Error).message,
        })
      }
    }
  }
  if (opts.immediate) {
    void run()
  } else {
    setTimeout(() => void run(), SEND_DELAY_MS).unref?.()
  }
}
