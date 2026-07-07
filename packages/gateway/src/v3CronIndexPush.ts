// 容器 → master「cron 唤醒索引」push client。
//
// 背景(docs/plans/v5-cron-master-wake-2026-07-07.md):CronScheduler 寄生在临时容器
// 内,容器一旦被 idle-sweep 回收就没人到点叫醒它。根治是把「唤醒」职责上移 master:
// master 持有一份**派生**索引(user × runtime_channel → next_fire_at / jobs_enabled),
// 到点若容器不在就把它拉起来。cron.yaml(容器卷)仍是任务定义的唯一权威——本 push
// 只是把「下一次何时该醒」这个可随时从卷重算的派生值捎给 master,不构成第二权威。
//
// 通道/鉴权复用 v3WechatOutbound 的 env(OPENCLAUDE_V3_MASTER_BASE_URL +
// OPENCLAUDE_V3_CONTAINER_TOKEN,master 凭容器 bearer 权威解析 uid)。两 env 缺 →
// 个人/dev/master 不启用 → no-op。
//
// 语义:fire-and-forget,永不抛。丢一次 push 最坏只是延迟到 master 的兜底 rescan
// 周期(方案第 3 节),不影响任务执行/送达(那两条仍在容器内)。所以这里既不重试也
// 不落盘队列——刻意比 v3ToolFailureReporter 更轻。

import { request as undiciRequest } from 'undici'

import {
  readV3WechatOutboundConfig,
  type V3WechatOutboundConfig,
} from './v3WechatOutbound.js'
import { createLogger } from './logger.js'

const log = createLogger({ module: 'v3CronIndexPush' })

/** 容器侧路径常量,必须与 master internal 路由 CRON_INDEX_PATH 对齐。 */
export const CRON_INDEX_PATH = '/internal/v3/cron-index'

const ATTEMPT_TIMEOUT_MS = 10_000

/** 复用 outbound 的 env 配置(同 master baseUrl + 容器 bearer)。缺 env → null。 */
export function readV3CronIndexConfig(
  env: NodeJS.ProcessEnv = process.env,
): V3WechatOutboundConfig | null {
  return readV3WechatOutboundConfig(env)
}

export interface CronIndexPayload {
  /** 全部 enabled 任务里最近一次触发的 ISO 时间;null = 无 enabled 任务。 */
  nextFireAt: string | null
  /** 当前 enabled 任务数(粒度=用户,master 用它判断是否还需要保留唤醒条目)。 */
  enabledCount: number
}

export interface PostCronIndexOpts {
  /** 显式注入配置(测试用);不传则读 env,读不到即 no-op。 */
  config?: V3WechatOutboundConfig | null
  /** Override only for tests。 */
  fetcher?: typeof undiciRequest
  /** Override only for tests。 */
  timeoutMs?: number
}

/**
 * 上报一次唤醒索引。best-effort:无 env / 任何网络/HTTP 错误都静默吞掉(永不抛,永不
 * 阻断调用方的 tick/CRUD)。调用方负责「变化才发」的去重(scheduler 内存记忆上次值)。
 */
export async function postCronIndex(
  payload: CronIndexPayload,
  opts: PostCronIndexOpts = {},
): Promise<void> {
  const config = opts.config !== undefined ? opts.config : readV3CronIndexConfig()
  if (!config) return
  const fetcher = opts.fetcher ?? undiciRequest
  const timeoutMs = opts.timeoutMs ?? ATTEMPT_TIMEOUT_MS
  // master 的 BodySchema 是 .strict():只认 { nextFireAt, enabledCount }。uid 由 master
  // 从 bearer 权威解析,故这里**不能**捎带 agentId(会被 strict 拒成 400)。
  const body = JSON.stringify({
    nextFireAt: payload.nextFireAt,
    enabledCount: payload.enabledCount,
  })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetcher(`${config.baseUrl}${CRON_INDEX_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${config.bearer}`,
      },
      body,
      signal: controller.signal,
    })
    // 主动 drain body 释放连接;内容无用,不解析。
    try {
      for await (const _chunk of res.body) {
        // discard
      }
    } catch {
      // drain 失败无所谓,已是 best-effort
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      log.debug('cron index push non-2xx', { status: res.statusCode })
    }
  } catch {
    // 网络 / DNS / TCP / TLS / abort → 静默;master 兜底 rescan 会对账
  } finally {
    clearTimeout(timer)
  }
}
