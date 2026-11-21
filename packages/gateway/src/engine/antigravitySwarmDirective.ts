/**
 * Antigravity per-turn Swarm directive & historical-swarm detection (OCV5-842).
 *
 * Keeps `inboundDispatch.ts` concise and directly unit-testable for both:
 *   1. Swarm ON (`swarmMode: true` toggle or `/swarm` slash command)
 *   2. Swarm OFF follow-up on a session that previously created a swarm
 *      (injects an explicit suppression directive so resumed coordinators do
 *      not keep waking historical workers from earlier turns).
 */
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { parseSwarmSlashCommand } from '@openclaude/protocol'
import { antigravityRoot, antigravitySessionBrainDir } from './antigravityPlatform.js'
import { remoteSwarmLocationForSession } from '../remoteSwarmRuntime.js'

const CONVERSATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const ANTIGRAVITY_SWARM_OFF_MARKER = '[OpenClaude 蜂群模式已关闭]'

export const ANTIGRAVITY_SWARM_OFF_DIRECTIVE = [
  ANTIGRAVITY_SWARM_OFF_MARKER,
  '用户已在界面关闭本轮蜂群开关。请以单 Agent 模式直接回复并完成本轮任务，禁止调用 `swarm`、`post_message`、`read_board`、`swarm_wait` 工具，也不要唤醒、检查或复用此前的蜂群成员（除非用户在本轮消息中明确要求使用蜂群或 `/swarm`）。',
  '',
].join('\n')

function isRegularFileNoSymlink(rootDir: string, segments: readonly string[]): boolean {
  try {
    const rootStat = lstatSync(rootDir)
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return false
    let cur = rootDir
    for (let i = 0; i < segments.length - 1; i += 1) {
      cur = join(cur, segments[i]!)
      const st = lstatSync(cur)
      if (st.isSymbolicLink() || !st.isDirectory()) return false
    }
    const leaf = join(cur, segments[segments.length - 1]!)
    const leafStat = lstatSync(leaf)
    return !leafStat.isSymbolicLink() && leafStat.isFile()
  } catch {
    return false
  }
}

/**
 * Returns true if this Antigravity session already has a persisted swarm roster
 * (`members.json`) on disk for the active local conversation or remote session.
 */
export function hasHistoricalAntigravitySwarm(opts: {
  sessionKey: string
  isRemote: boolean
  conversationId?: string
  antigravityRootDir?: string
  remoteSwarmRootBase?: string
}): boolean {
  if (opts.isRemote) {
    const loc = remoteSwarmLocationForSession(opts.sessionKey, opts.remoteSwarmRootBase)
    return isRegularFileNoSymlink(loc.brainDir, [loc.swarmId, '.system_generated', 'swarm', 'members.json'])
  }
  const convId = opts.conversationId?.trim()
  if (!convId || !CONVERSATION_ID_RE.test(convId)) return false
  const brainDir = antigravitySessionBrainDir(opts.antigravityRootDir ?? antigravityRoot(), opts.sessionKey)
  return isRegularFileNoSymlink(brainDir, [convId, '.system_generated', 'swarm', 'members.json'])
}

export interface AntigravitySwarmTurnDirectiveResult {
  readonly text: string
  readonly mode: 'on' | 'off_with_history' | 'none'
  readonly viaSlash: boolean
  readonly viaToggle: boolean
}

export function applyAntigravitySwarmTurnDirective(opts: {
  finalText: string
  rawUserText: string
  isAntigravityTurn: boolean
  isRemoteAntigravity: boolean
  swarmMode: boolean
  hasHistoricalSwarm: boolean
}): AntigravitySwarmTurnDirectiveResult {
  const slashSwarm = parseSwarmSlashCommand(opts.rawUserText)
  const viaSlash = Boolean(slashSwarm?.matched)
  const viaToggle = opts.swarmMode
  const swarmRequested = viaToggle || viaSlash

  if (!opts.isAntigravityTurn) {
    return { text: opts.finalText, mode: 'none', viaSlash, viaToggle }
  }

  if (swarmRequested) {
    let nextText = opts.finalText
    if (viaSlash && opts.rawUserText && nextText.endsWith(opts.rawUserText)) {
      const prefixPart = nextText.slice(0, nextText.length - opts.rawUserText.length)
      const taskBody =
        slashSwarm?.task ||
        '请先了解当前工作区与上下文，并告知我可以如何拆分为并行蜂群任务。'
      nextText = `${prefixPart}${taskBody}`
    }
    const swarmToolsIntro = opts.isRemoteAntigravity
      ? '用户已显式开启远端 Antigravity 蜂群（Swarm）模式（由容器侧蜂群运行时驱动，通过 `swarm`、`post_message`、`read_board`、`swarm_wait` 四个 MCP 工具编排并行成员，每个成员同样运行在远端 Gemini 并拥有完整的本地工作区工具与 Git Worktree 隔离）。请按以下规则作为 Coordinator 编排蜂群：'
      : '用户已显式开启 Antigravity 原生蜂群（Swarm）模式。请按以下规则作为 Coordinator 编排蜂群：'
    const swarmDirective = [
      '[OpenClaude Antigravity 蜂群模式已激活]',
      swarmToolsIntro,
      opts.isRemoteAntigravity
        ? '1. 若任务可拆分为 2 个及以上可并行推进的独立子方向（或需要独立校验者 review），先用 `swarm{action:"title", title:"..."}` 命名蜂群，再用 `swarm{action:"add", name:"...", brief:"..."}` 招募精简、职责不重叠的成员（必要时配备 `verifier` 校验者），随后调用 `swarm_wait{since:...}` 等待成员汇报并用 `read_board` 审阅结果。'
        : '1. 若任务可拆分为 2 个及以上可并行推进的独立子方向（或需要独立校验者 review），请立即读取内置 `swarm` skill，先用 `swarm{action:"title", title:"..."}` 命名蜂群，再用 `swarm{action:"add", name:"...", brief:"..."}` 招募精简、职责不重叠的成员（必要时配备 `verifier` 校验者，若有 `swarm_monitor` 技能可配 `monitor`）。',
      '2. 招募成员时**不要指定 `model` 参数**（留空以继承当前会话模型，确保计费与权限一致）。',
      '3. **生命周期边界（仅限本轮蜂群开启时）**：若本轮是同一任务的续聊或追问且蜂群仍开启，可复用既有蜂群继续推进；若用户切换到全新无关任务，先确认旧成员无未合入改动后再用 `swarm{action:"kill"}` 回收旧 worker（或开独立频道隔离）并更新 `swarm{action:"title"}`，避免旧讨论串扰。若后续回合用户关闭了蜂群开关，不得再自动复用旧蜂群。',
      '4. **Git 仓库并行写手与防丢合入**：在 git 仓库中安排多个写手并行改码时，默认给写手成员传 `workspace:"share"`（独立 worktree 隔离）同时在 `brief` 中按文件/模块划分清晰所有权规避语义冲突（只读调研/校验成员保留默认 `inherit`）；收尾前必须检查并合入所有 `share`/`branch` 成员的改动到主工作区，确认无改动遗漏在孤儿 worktree 里后再 `kill` 回收。',
      '5. OpenClaude 网页端会实时原生渲染蜂群看板（成员矩阵、实时活动、worktree 隔离标识、频道与讨论流），**切勿**在回复中输出本地 `open_board` 链接或终端 `/swarm board` 命令。',
      '6. 所有成员收口后，先在讨论板发一行 `[done] <总结>` 让监控停止，再向用户交付清晰、完整的最终汇总（含各独立 worktree 的合入确认结果）。',
      '',
    ].join('\n')
    return {
      text: `${swarmDirective}\n${nextText}`,
      mode: 'on',
      viaSlash,
      viaToggle,
    }
  }

  if (opts.hasHistoricalSwarm) {
    return {
      text: `${ANTIGRAVITY_SWARM_OFF_DIRECTIVE}\n${opts.finalText}`,
      mode: 'off_with_history',
      viaSlash,
      viaToggle,
    }
  }

  return { text: opts.finalText, mode: 'none', viaSlash, viaToggle }
}
