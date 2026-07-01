// Team run orchestration helpers (server-side).
//
// v5 团队模式：team run 是服务端一等实体。队长 prompt 由服务端构建（把成员/policy
// 作为"事实"注入队长 first-turn），取代老 vanilla web `buildTeamRunPrompt` 的客户端
// 拼装 —— v5 serve 的 web-react 根本没有那套逻辑。policy 由 gateway 硬强制（per-run
// 信号量/成员白名单/requireReview finalization gate），故 prompt 只作"告知"，不作
// "约束权威"。

import type { AgentTeamDef } from '@openclaude/storage'

/**
 * 构建团队队长的 first-turn prompt。
 *
 * @param team 冻结的团队定义（发起时 snapshot）
 * @param goal 用户目标
 */
export function buildTeamLeaderPrompt(team: AgentTeamDef, goal: string): string {
  const members = team.members ?? []
  const policy = team.policy ?? {}
  const maxParallel = policy.maxParallel ?? 1
  const reviewerId = policy.requireReview ? policy.reviewAgentId : undefined

  const memberLines =
    members.length > 0
      ? members
          .map((m) => {
            const role = m.role ? `（${m.role}）` : ''
            const resp = m.responsibility ? ` — ${m.responsibility}` : ''
            return `- \`${m.agentId}\`${role}${resp}`
          })
          .join('\n')
      : '（无成员，本次由你独立完成）'

  const sections: string[] = []

  sections.push('# 团队协作任务（你是队长）')

  if (team.leaderPrompt?.trim()) {
    sections.push(team.leaderPrompt.trim())
  }

  sections.push(`## 用户目标\n${goal}`)

  sections.push(
    `## 你的团队成员（用 \`delegate_task\` 委派，agentId 必须来自下表）\n${memberLines}`,
  )

  const rules: string[] = [
    `并发上限：同时最多 ${maxParallel} 个委派在跑（服务端硬强制，超出会被拒绝，不要强行多开）。`,
    '只能委派给上表中的成员 agentId；委派非成员会被服务端拒绝。',
    '成员不得再向下委派（服务端会拒绝成员的嵌套委派）。',
  ]
  if (reviewerId) {
    rules.push(
      `复核强制：交付前必须先用 \`delegate_task\` 把最终草稿委派给复核者 \`${reviewerId}\`，待其返回后方可交付。未经复核，\`submit_team_final\` 会被服务端拒绝。`,
    )
  }
  rules.push(
    '交付方式：完成后**必须**调用 `submit_team_final` 工具提交最终答案 —— 这是唯一的收尾方式。' +
      '不要只在普通消息里写"已完成"，那不会被登记为团队 run 的最终交付。',
  )
  sections.push(`## 协作规则（服务端强制）\n${rules.map((r) => `- ${r}`).join('\n')}`)

  return sections.join('\n\n')
}
