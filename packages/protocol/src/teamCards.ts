// ───────────────────────────────────────────────
// 团队/委派卡片 —— 客户端展示字段清单(单一权威)
// ───────────────────────────────────────────────
// role 为 agent-group / delegate-progress 的消息行是客户端拥有的 UI 结构
// (delegate_task 工具卡 + 委派实时进度卡),必须跨 PUT/refresh 存活。这份
// 清单是这些行"客户端展示字段"的单一权威,同时喂两个消费方:
//
//   1. 服务端 strip 白名单 —— @openclaude/storage sessionsDb.ts 的
//      CLIENT_PUT_TEAM_MESSAGE_FIELDS:client PUT 时仅对 team-owned 行放行
//      这些字段,普通 assistant/tool 行照常剥掉;
//   2. 客户端回填清单 —— web-react lib/persist.ts 的
//      mergeLocalTeamDisplayFields:server 行缺失/更贫时从本地 IndexedDB
//      行补齐这些字段。
//
// 历史教训(f2272c08):前端加 _agentGroupOrigin/_teamFallback 只改了客户端
// 清单,服务端白名单没同步 → 走全量 PUT 的客户端一存就把新字段剥掉,跨设备
// 重开后"临时 Codex 子智能体"标注退化。新增团队展示字段必须加在这里,两侧
// 自然同步,清单不再漂移。
//
// 注:text 不在此清单(核心内容字段,对所有 role 通用放行/合并时特判);
// completedAt / childBlocks 同时也在服务端通用允许清单
// (CLIENT_PUT_ALLOWED_FIELDS)里 —— 重复列出无害(并集语义),列全是为了
// 让客户端回填清单能完整从这里派生。
export const TEAM_CARD_CLIENT_DISPLAY_FIELDS = [
  // 卡片时序 / 完成态
  'startTime',
  'completedAt',
  '_completed',
  // agent-group(delegate_task 工具卡)侧
  '_delegate',
  '_delegateAgentId',
  '_delegateGoal',
  '_delegateRunId',
  // 委派终态三态(ok/failed/timeout)。历史上前端只有 `_completed`+`_isError` 两个
  // 布尔,timeout 与 failed 无法区分(都落 _isError=true)。server-authored 化
  // (P2 债A)引入本字段承载完整终态,let 前端可分别渲染"超时/失败";server 行同时
  // 仍写 _isError=(status!=='ok')兼容既有渲染读取。是 f2272c08 教训之后新增的
  // 团队展示字段,加在此权威 → strip 白名单/客户端回填两侧自动同步。
  '_delegateStatus',
  // 隐藏审查员(hidden-reviewer)委派卡的结构化裁决(PASS / NEEDS_FIX)。P2 债C
  // reviewer 硬编排引入:审查**执行态**(_delegateStatus ok/failed/timeout)与审查
  // **裁决**是两回事 —— 一次成功执行(status='ok')的审查照样可能裁决 NEEDS_FIX。
  // 因此裁决必须独立承载,不能从 _delegateStatus 反推。仅审查员委派行携带;普通成员
  // 委派行不带此字段。前端据此把审查卡渲染成「质量审查员 · PASS/未通过」。
  '_reviewVerdict',
  '_duration',
  '_resultPreview',
  '_isError',
  // 临时 Codex 子智能体标注(f2272c08 引入的展示字段)
  '_agentGroupOrigin',
  '_teamFallback',
  // delegate-progress(委派进度卡)侧
  'runId',
  'goal',
  'entries',
  'summary',
  'error',
  '_adoptedInto',
  // 富子块(团队行合并时按"更富者胜"处理;服务端通用清单里也有)
  'childBlocks',
] as const

export type TeamCardClientDisplayField = (typeof TEAM_CARD_CLIENT_DISPLAY_FIELDS)[number]

// ───────────────────────────────────────────────
// 委派终态三态 + server-authored durable 载荷(单一权威)
// ───────────────────────────────────────────────
// P2 债A:团队卡(role 'agent-group')server-authored 化的 wire 契约。
// 生成点 = gateway handleDelegateTask 收尾;经 v3MasterSink 随
// persistServerAuthoredTurn 下发给 master;master 落库为 role 'agent-group'
// 的 server 行,字段映射成上面的 TEAM_CARD_CLIENT_DISPLAY_FIELDS 展示名。
//
// 显式权衡(见 docs/plans batch2 §2.1):childBlocks 过程树不进本载荷
// (sink body cap 256KB;live 富树仍走 delegate_progress 帧 + 本设备 IndexedDB)。
// 跨设备/清缓存时 server 行提供"完整团队结构 + 结果摘要 + 终态",过程细节降级。
//
// 契约不可擅改字段语义:gateway(V3MasterSinkWirePayload.agentGroups[])与 master
// (internalServerAuthored BodySchema,.strict())两侧同批同步。
export const AGENT_GROUP_STATUSES = ['ok', 'failed', 'timeout'] as const
export type AgentGroupStatus = (typeof AGENT_GROUP_STATUSES)[number]

// ───────────────────────────────────────────────
// 团队模式隐藏审查员裁决词汇(单一权威)
// ───────────────────────────────────────────────
// P2 债C:hidden reviewer 硬编排。这份词汇同时喂三个消费方,消"审查裁决词汇漂移"
// (历史断裂:reviewer persona 输出 PASS/NEEDS_FIX,gateway parseVerificationVerdict
// 却只认 PASS/FAIL/PARTIAL,两条管线互不相认):
//   1. reviewer persona(commercial entrypoint.ts)—— 审查完在末行输出 `VERDICT: <这里的值>`;
//   2. gateway parseVerificationVerdict —— 解析该行,PASS 放行 / NEEDS_FIX 触发 continuation;
//   3. 团队卡展示(DurableAgentGroup.verdict → 行 `_reviewVerdict`)—— 前端渲染 PASS/未通过。
// PASS = 无阻塞问题可放行;NEEDS_FIX = 有必须修改的问题(FAIL 语义)。
export const REVIEW_VERDICT_PASS = 'PASS'
export const REVIEW_VERDICT_NEEDS_FIX = 'NEEDS_FIX'
export const REVIEW_VERDICTS = [REVIEW_VERDICT_PASS, REVIEW_VERDICT_NEEDS_FIX] as const
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number]

// ───────────────────────────────────────────────
// 队长助手行 per-delegate 成本明细(债D in-chat 成本披露)
// ───────────────────────────────────────────────
// P2 债D:委派成本已 durable 合计入队长助手行 usage.costCredits(Fix A drain),但明细
// 被折没。本类型是"合计的同时附上 per-agent 明细"的展示投影 —— master
// drainDelegateCostForClientSession 排空 pending 时按 delegate_agent_id 分组求和,写进
// 队长行 usage.delegates[];前端团队卡/委派卡据此渲染「质量审查员 · PASS · X 积分」。
// **纯展示投影**:不改 spendTwoBucket / 不新增查询面 / 不影响真实扣费(扣费早已发生)。
export interface MessageUsageDelegate {
  /** 被委派子 agent id(与 DurableAgentGroup.agentId 同源;前端经 agentDisplayName 映射)。 */
  agentId: string
  /** 该 agent 本 turn 委派成本合计(十进制大数字符串,与 usage.costCredits 同单位/精度)。 */
  costCredits: string
}

export interface DurableAgentGroup {
  /** 委派 run 关联键(= gateway progressRunId `dlg-…`)。落库映射为行的
   *  `_delegateRunId`,是 server 行 ↔ 本地 `m-*` agent-group 行的去重合并键
   *  (server-wins 禁用,local 富行胜)。 */
  runId: string
  /** 被委派的子 agent id(落库 `_delegateAgentId`;前端经 agentDisplayName 映射,
   *  隐藏审查员显示为"质量审查员")。 */
  agentId: string
  /** 委派目标文本(落库 `_delegateGoal` + 行 `text`)。 */
  goal: string
  /** 委派终态(落库 `_delegateStatus`;并派生 `_isError = status !== 'ok'`)。 */
  status: AgentGroupStatus
  /** 结果/错误摘要,生成点已截断 ≤ 2KB(落库 `_resultPreview`)。可空
   *  (无文本输出的成功委派)。 */
  resultSummary?: string
  /** 委派实际完成时刻(epoch ms)。落库同时作行 `ts`(turn 内插序)与
   *  `completedAt`(展示)。 */
  completedAt: number
  /** P2 债C — 隐藏审查员委派专属:gateway 硬编排 review pass 从审查输出解析出的
   *  结构化裁决(落库 `_reviewVerdict`)。仅审查员委派行携带,普通成员委派恒
   *  undefined。与 `status`(执行态)正交:一次成功执行的审查照样可裁决 NEEDS_FIX。 */
  verdict?: ReviewVerdict
}
