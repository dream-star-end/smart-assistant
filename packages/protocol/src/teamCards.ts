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
}
