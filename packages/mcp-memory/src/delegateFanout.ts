/**
 * delegate_tasks(fan-out 并行委派)的纯逻辑:入参校验 + 结果聚合。
 *
 * 抽成无副作用的纯函数,与 index.ts 的 IPC/env/MCP 编排解耦,便于单测
 * (index.ts 是带顶层 await + stdio server.connect 的入口模块,不适合直接 import 测)。
 * 编排(Promise.all 各自 POST /delegate、单项失败隔离)留在 index.ts handleDelegateTasks。
 */

import { normalizeDelegateAgentId, normalizeDelegateModel } from './delegateArgs.js'

/** 单个并行子任务的规范化描述。 */
export interface FanoutTask {
  agentId?: string
  model?: string
  goal: string
  context?: string
  effort?: string
  toolsets?: string[]
  resumeSessionKey?: string
}

/** 一次 fan-out 中单个子任务的执行结果(供聚合)。 */
export interface FanoutItemResult {
  /** 目标 agent 标签(agentId 或 'main')。 */
  label: string
  /** 子任务目标(聚合小标题用,过长会截断)。 */
  goal: string
  /** 该子任务是否失败(handleDelegateTaskToAgent 的 toolError → true)。 */
  isError: boolean
  /** 子任务回传正文(成功=输出/摘要,失败=错误文本)。 */
  text: string
}

/** delegate_tasks 单次并行子任务数上限。 */
export const MAX_FANOUT_TASKS = 4
const EFFORT_ALLOW = new Set(['low', 'medium', 'high'])

/**
 * 校验并规范化 delegate_tasks 的 tasks 入参。
 *   - 必须是非空数组,长度 1..MAX_FANOUT_TASKS;
 *   - 每项必须有非空 goal;
 *   - effort 仅接受 low/medium/high,其余(含缺省/非法)丢弃(不报错,退回成员默认);
 *   - model / 非法 agentId(含点的型号)硬拒,避免打到 HTML 回退;
 *   - toolsets 仅接受字符串数组,其余忽略。
 * 校验不过返回 { ok:false, error }(供调用方转 toolError),成功返回规范化后的 tasks。
 */
export function normalizeFanoutTasks(
  raw: unknown,
): { ok: true; tasks: FanoutTask[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: 'tasks 必填,且至少 1 个子任务' }
  }
  if (raw.length > MAX_FANOUT_TASKS) {
    return {
      ok: false,
      error: `delegate_tasks 单次最多 ${MAX_FANOUT_TASKS} 个并行子任务,收到 ${raw.length} 个;请拆成多批或合并子任务`,
    }
  }
  const tasks: FanoutTask[] = []
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i] as Record<string, unknown> | null
    const goal = item && typeof item.goal === 'string' ? item.goal.trim() : ''
    if (!goal) {
      return { ok: false, error: `第 ${i + 1} 个子任务缺少 goal` }
    }
    const effort =
      item && typeof item.effort === 'string' && EFFORT_ALLOW.has(item.effort)
        ? item.effort
        : undefined
    const toolsets =
      item && Array.isArray(item.toolsets)
        ? item.toolsets.filter((x): x is string => typeof x === 'string')
        : undefined
    const resumeSessionKey =
      item && typeof item.resumeSessionKey === 'string' && item.resumeSessionKey.trim()
        ? item.resumeSessionKey.trim()
        : undefined
    const agentNorm = normalizeDelegateAgentId(item?.agentId)
    if (!agentNorm.ok) return { ok: false, error: `第 ${i + 1} 个子任务 ${agentNorm.error}` }
    const modelNorm = normalizeDelegateModel(item?.model)
    if (!modelNorm.ok) return { ok: false, error: `第 ${i + 1} 个子任务 ${modelNorm.error}` }
    tasks.push({
      agentId: agentNorm.agentId,
      model: modelNorm.model,
      goal,
      context: item && typeof item.context === 'string' ? item.context : undefined,
      effort,
      toolsets: toolsets && toolsets.length > 0 ? toolsets : undefined,
      resumeSessionKey,
    })
  }
  return { ok: true, tasks }
}

/**
 * 把各子任务结果按输入顺序聚合成一段队长可读文本:顶部一行汇总(成功/失败计数),
 * 每项独立小节标注 ✅/❌ + 目标摘要 + 回传正文。单项失败不影响其余的呈现。
 */
export function aggregateDelegateFanoutResults(items: FanoutItemResult[]): string {
  const total = items.length
  const okCount = items.filter((it) => !it.isError).length
  const failCount = total - okCount
  const header = `并行委派 ${total} 个子任务已全部返回:${okCount} 成功 / ${failCount} 失败。`
  const sections = items.map((it, i) => {
    const mark = it.isError ? '❌' : '✅'
    const goalPreview = it.goal.length > 60 ? `${it.goal.slice(0, 60)}…` : it.goal
    return [`### ${i + 1}. ${mark} ${it.label} — ${goalPreview}`, it.text].join('\n')
  })
  return [header, '', sections.join('\n\n')].join('\n')
}
