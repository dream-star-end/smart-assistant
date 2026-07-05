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
