// 隐藏系统 agent 可见性 —— 权威源已上移到 @openclaude/protocol(agentVisibility 模块),
// 供 gateway 与 commercial 容器 entrypoint 编译期共享单一权威。本文件仅 re-export,
// 保持仓内既有 `./agentVisibility.js` import 路径全部不破。
//
// 判定/授权/执行面用 isHiddenSystemAgentId 看全量;枚举/展示面用投影 helper
// (filterUserVisibleAgentsForManagement / filterUserVisibleRoutesForManagement /
//  filterUserVisibleByAgentField / userVisibleDefaultAgentId)—— 语义见 protocol 模块注释。
export {
  HIDDEN_SYSTEM_AGENT_IDS,
  isHiddenSystemAgentId,
  filterUserVisibleAgentsForManagement,
  filterUserVisibleByAgentField,
  filterUserVisibleRoutesForManagement,
  userVisibleDefaultAgentId,
} from '@openclaude/protocol'
