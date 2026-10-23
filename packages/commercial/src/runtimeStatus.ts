import { containerLogArchiveStats } from './compute-pool/containerLogArchive.js'
import type { LeadershipStatus } from './deploy/leaderLease.js'
import { getLaneMetricsSnapshot, type LaneMetricsSnapshot } from './deploy/laneEvaluate.js'
import { MASTER_CAPABILITIES } from './runtimeCapabilities.js'

export interface CommercialRuntimeStatus {
  /** 运行时 channel 单一权威(OC_RUNTIME_CHANNEL),默认 "v3"。 */
  channel: string
  /** 后台控制面 mutator 是否启用(v5 follower 恒为 false)。 */
  controlPlaneEnabled: boolean
  /** 启动是否执行了共享 PG migration(COMMERCIAL_AUTO_MIGRATE)。 */
  autoMigrate: boolean
  /** legacy agent 运行时(AGENT_IMAGE/docker)状态。 */
  agentRuntime: 'enabled' | 'disabled'
  /** v3 supervisor 容器运行时(OC_RUNTIME_IMAGE)状态。 */
  containerRuntime: 'enabled' | 'disabled'
  /** 当前存活的后台 scheduler/actor 名单(v5 follower 必须为空)。live getter:反映 LeaderBundle 实时启停。 */
  schedulers: string[]
  /**
   * 本 master 构建实现的协议能力(见 runtimeCapabilities.ts)。**构建级事实,不是开关态** ——
   * deploy 的四面 capability 守卫读 `/healthz` 的 `runtime.capabilities` 判断"这个 master
   * 版本认不认模型权威协议",据此拒绝把不认的旧版本翻上来(方案 §7 步 5 兼容地板)。
   * 注:gateway 顶层的 `body.capabilities` 是**容器 file-proxy 面**的语义,与本字段无关。
   */
  capabilities: string[]
  /**
   * P3 leader lease 归属(RFC-v5-dual-master-cohort D4)。healthz 只读断言面:
   * state=ineligible(env kill-switch)|standby(有 env 资格但 desired 非本 slot)|
   * acquiring|leader|fenced。env=1 不再等同 active leader(smoke 断言随之改为断言 state=leader)。
   */
  leadership: LeadershipStatus
  /** P3 lane 放量观测快照(evaluateLane 命中计数,详见 deploy/laneEvaluate.ts)。 */
  laneMetrics: LaneMetricsSnapshot
  containerLogArchive?: ReturnType<typeof containerLogArchiveStats> & { since: 'process-start' }
}

/** Health reads live scheduler, leadership and process counters on every serialization. */
export function makeCommercialRuntimeStatus(
  input: Pick<
    CommercialRuntimeStatus,
    'channel' | 'controlPlaneEnabled' | 'autoMigrate' | 'agentRuntime' | 'containerRuntime'
  > & {
    schedulers: () => string[]
    leadership: () => LeadershipStatus
  },
): CommercialRuntimeStatus {
  return {
    channel: input.channel,
    controlPlaneEnabled: input.controlPlaneEnabled,
    autoMigrate: input.autoMigrate,
    agentRuntime: input.agentRuntime,
    containerRuntime: input.containerRuntime,
    capabilities: [...MASTER_CAPABILITIES],
    get schedulers() {
      return input.schedulers()
    },
    get leadership() {
      return input.leadership()
    },
    get laneMetrics() {
      return getLaneMetricsSnapshot()
    },
    get containerLogArchive() {
      return { ...containerLogArchiveStats(), since: 'process-start' as const }
    },
  }
}
