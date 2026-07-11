/**
 * oc-skill 对话内技能训练/评测生成的「服务端纯逻辑」——回环-only relay 路由决策 +
 * 训练完成站内信文案。两者都是无 IO 的纯函数,便于单测,server.ts 只做装配(loopback
 * 守卫 + 派发到既有 _handleSkillTrainStart/_handleSkillEvalGenStart/状态查询处理器)。
 *
 * 为什么要一条 loopback-only relay:
 *   - oc-skill CLI 打的是**本容器 gateway 自己的** train/eval-gen API(不是 master)。
 *   - 但容器里的工具(尤其 Codex 子进程)env 被擦,拿不到 gateway 的随机 accessToken,
 *     直接打 /api/skills/:name/train 会 401。故开一条 /internal/v3/skill-local/* 的
 *     回环-only 路径,把请求映射到同一批 /api 处理器上。
 *   - 身份仍走 server.getUserId:回环请求无 JWT → 'default';而 master 容器代理转发前端
 *     请求时会剥掉 authorization/cookie(containerApiProxy),前端请求在容器里同样解析成
 *     'default'。两条路径落同一 userId 分区 → CLI 起的训练在管理中心可见/可合并。
 *   - relay 只做「回环 + 路径匹配」两件事,**不做第二套校验**:可写性门 / 生成-评测互斥 /
 *     owner 归属 / method 全部由被派发的既有处理器权威执行。
 */

import { isLoopbackRemoteAddress } from './v3CodexRelay.js'

/** 回环-only relay 路径前缀(与 oc-skill CLI resolveLocalSkillBase 对齐)。 */
export const SKILL_LOCAL_RELAY_PREFIX = '/internal/v3/skill-local'

/** relay 命中的既有处理器种类。 */
export type SkillLocalRelayRoute =
  | 'train-start'
  | 'train-status'
  | 'evalgen-start'
  | 'evalgen-status'

/**
 * relay 决策:
 *   - forbidden:非回环来源(唯一的访问控制,与 marketplace/codex relay 同款)。
 *   - not-found:回环但子路径不认识。
 *   - dispatch:派发到 route 对应的既有处理器,param = 捕获的 skillName 或 runId。
 */
export type SkillLocalRelayDecision =
  | { action: 'forbidden' }
  | { action: 'not-found' }
  | { action: 'dispatch'; route: SkillLocalRelayRoute; param: string }

// 子路径 1:1 镜像 /api 真路由段(skill 名 [a-z0-9-]+、runId [A-Za-z0-9_-]+ 与 server.ts
// 的路由正则完全一致),这样 relay 不引入第二套命名规则。方法不在此判(由处理器权威判)。
const TRAIN_START = new RegExp(`^${SKILL_LOCAL_RELAY_PREFIX}/skills/([a-z0-9-]+)/train$`)
const EVALGEN_START = new RegExp(`^${SKILL_LOCAL_RELAY_PREFIX}/skills/([a-z0-9-]+)/evals/generate$`)
const TRAIN_STATUS = new RegExp(`^${SKILL_LOCAL_RELAY_PREFIX}/skill-training/([A-Za-z0-9_-]+)$`)
const EVALGEN_STATUS = new RegExp(`^${SKILL_LOCAL_RELAY_PREFIX}/skill-eval-gen/([A-Za-z0-9_-]+)$`)

/**
 * 纯决策:先做回环守卫(唯一门),再做路径匹配。method / 可写性 / 互斥 / owner 一律不判,
 * 交给被派发的既有处理器。
 */
export function decideSkillLocalRelay(
  pathname: string,
  remoteAddress: string | null | undefined,
): SkillLocalRelayDecision {
  if (!isLoopbackRemoteAddress(remoteAddress)) return { action: 'forbidden' }

  let m = TRAIN_START.exec(pathname)
  if (m) return { action: 'dispatch', route: 'train-start', param: m[1] }
  m = EVALGEN_START.exec(pathname)
  if (m) return { action: 'dispatch', route: 'evalgen-start', param: m[1] }
  m = TRAIN_STATUS.exec(pathname)
  if (m) return { action: 'dispatch', route: 'train-status', param: m[1] }
  m = EVALGEN_STATUS.exec(pathname)
  if (m) return { action: 'dispatch', route: 'evalgen-status', param: m[1] }

  return { action: 'not-found' }
}

/** 站内信内容(交给 postInboxMessage 发送,标题/正文超长由其兜底截断)。 */
export interface SkillTrainCompleteNotice {
  title: string
  bodyMd: string
}

/**
 * 训练完成站内信文案。draft>0 报草稿数并引导到管理中心看 diff;draft=0 明确「未产生改进
 * 草稿」,避免用户白跑一趟管理中心。skillName 为 null(前端自动选目标)时用通用措辞。
 */
export function buildSkillTrainCompleteNotice(
  skillName: string | null,
  draftCount: number,
): SkillTrainCompleteNotice {
  const title = skillName ? `技能「${skillName}」训练优化完成` : '技能训练优化完成'
  const bodyMd =
    draftCount > 0
      ? `本次训练生成了 ${draftCount} 份改进草稿。到 管理中心 → 技能 → 训练优化 查看 diff 并决定是否合并。`
      : '本次训练未产生改进草稿。'
  return { title, bodyMd }
}
