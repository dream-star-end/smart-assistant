# 基于 CCB 的个人 AI 助手改造计划与任务表

日期：2026-04-12  
适用项目：`openclaude`  
目标执行者：Claude Code / 其他代码代理  

---

## 1. 背景与目标

当前项目的最大资产不是 Web UI、不是 Gateway，也不是多渠道，而是 `claude-code-best` 提供的强 `agent harness`。  
后续演进的正确方向不是重写一套新的 agent loop，而是：

- 保持 `CCB` 作为默认执行内核
- 在其上方补齐“个人 AI 助手操作系统”能力
- 把编排、自动化、记忆、技能、渠道、API、控制面从执行层中分离出来

这份计划的核心原则是：

1. **执行质量交给 CCB**  
   工具循环、补丁执行、推理过程、会话 resume、模型调用，不要在本项目里重造。

2. **助手能力交给 OpenClaude**  
   多 Agent、长期记忆、技能、自动化、Webhook、渠道、UI、API、任务流等，放在外层实现。

3. **先立边界，再加功能**  
   不先把架构边界理顺，后续所有新能力都会继续堆在 `server.ts`、`sessionManager.ts`、`app.js` 里。

4. **面向个人部署，优先易用性与能力上限**  
   安全策略保持“个人部署可接受边界”，不要引入明显损害可用性的复杂企业级控制。

---

## 2. 目标架构

目标形态拆成四层：

### 2.1 Harness Layer

职责：

- 启动和管理 CCB
- 注入 prompt slots、MCP、运行参数
- 统一 turn 执行、停止、恢复、能力探测

当前主入口：

- `packages/gateway/src/subprocessRunner.ts`
- `packages/gateway/src/sessionManager.ts`

目标状态：

- 第一阶段先做 `SessionManager` 瘦身
- 提取 `CcbMessageParser` 和会话生命周期管理逻辑
- 保持“同一 `sessionKey` 复用同一 CCB 子进程”的当前策略
- 只有当第二种 harness 需求真实出现时，再提升为 `AgentHarness` 抽象

### 2.2 Orchestration Layer

职责：

- 会话编排
- 多 Agent 协作
- 记忆、技能、归档
- reminders / cron / webhook / background tasks
- toolsets / backend / policy
- 任务状态与交付路由

当前主入口：

- `packages/gateway/src/server.ts`
- `packages/gateway/src/sessionManager.ts`
- `packages/gateway/src/cron.ts`
- `packages/mcp-memory/src/index.ts`

目标状态：

- 引入轻量内部事件总线
- 统一事件模型：`cron.fired`、`webhook.received`、`task.created`、`agent.delegated` 等
- 后续 webhook、standing orders、跨 Agent 协作都走同一条“事件 -> 路由 -> 执行”链路

### 2.3 Interface Layer

职责：

- Web UI
- Telegram 及未来渠道
- 第三方兼容 API
- 控制台、日志、任务视图、Agent 管理

当前主入口：

- `packages/web/public/*`
- `packages/channels/*`

### 2.4 Plugin / Capability Layer

职责：

- 渠道扩展
- Provider 扩展
- Automation / Webhook 扩展
- 未来设备能力或远程节点扩展

当前主入口：

- `packages/plugin-sdk/src/index.ts`

目标状态：

- 不再只支持 `ChannelAdapter`
- 扩展为多类插件槽位

---

## 3. 非目标

本轮不做以下事项，避免工程失焦：

- 不重写 CCB 内部 agent loop
- 不替换默认执行内核
- 不做 OpenClaw 全量节点/设备配对体系
- 不追求一次性接入大量渠道
- 不先做复杂企业级 RBAC / scope 系统
- 不先做完整移动端 App

---

## 4. 里程碑

### M0：架构边界收口

目标：让后续功能不再继续侵入执行层和单体前端。

### M1：Agent 能力增强

目标：让助手在复杂任务、多步流程、批处理场景下显著更强。

### M2：自动化与平台接入

目标：从“聊天助手”升级到“持续做事的助手”。

### M3：控制面与生态接入

目标：降低前端绑定，增强可扩展性和外部兼容性。

---

## 5. 总任务表

| ID | 优先级 | 里程碑 | 任务 | 主要产出 | 主要触点 |
|---|---|---|---|---|---|
| A1 | P0 | M0 | `SessionManager` 瘦身 + `CcbMessageParser` 提取 | parser、生命周期管理、职责拆分 | `sessionManager.ts`, `subprocessRunner.ts` |
| A1b | P0 | M0 | 引入轻量 `EventBus` | 内部事件总线与统一事件模型 | `server.ts`, `cron.ts`, `sessionManager.ts` |
| A2 | P0 | M0 | 建立 prompt slots 分层 | `SOUL/AGENTS/MEMORY/USER` 注入规范 | `sessionManager.ts`, `storage/*` |
| A3 | P0 | M0 | 增加 `toolsets` 配置与生效链路 | `research/coding/browser/assistant` 四套 toolsets | `config.ts`, `server.ts`, `sessionManager.ts` |
| A4 | P1 | M0 | 增加 terminal backend 抽象 | `local/docker` backend | `config.ts`, `subprocessRunner.ts` |
| A5 | P0 | M1 | 新增 `delegate_task` | 同步型子 Agent 委派 | `mcp-memory/index.ts`, `sessionManager.ts` |
| A6 | P2 | M3 | 新增 `execute_code`（延后） | 脚本执行 + RPC 工具桥 | 新增 `packages/gateway/src/codeExecution.ts` 等 |
| A7 | P1 | M1 | 完善 skills/context 体系 | skill 元数据、环境变量、上下文装载顺序 | `skillStore.ts`, `mcp-memory/index.ts` |
| A8 | P0 | M2 | 新增 webhook automation | GitHub / 自定义 JSON webhook 路由 | `server.ts`, 新增 `webhooks.ts` |
| A9 | P1 | M2 | Standing Orders / Background Tasks | 持久任务规则 + 后台执行 | `cron.ts`, `storage/*`, `mcp-memory/*` |
| A10 | P0 | M1 | OpenAI-compatible API | `/v1/chat/completions` + `/v1/responses` | `server.ts`, `protocol/*` |
| A11 | P1 | M3 | 扩展 plugin-sdk | `ChannelPlugin / ProviderPlugin / HarnessPlugin / AutomationPlugin` | `plugin-sdk/*`, `cli/*`, `server.ts` |
| A12 | P1 | M3 | Web UI 技术路线决策 + 控制面增强 | UI ADR + 解耦实施 | `packages/web/public/*` |
| A13 | P2 | M3 | 可观测性与诊断 | run logs、tool trace、task history、doctor 视图 | `server.ts`, `web/*`, `cli/*` |
| A14 | P2 | M3 | 远端工作节点预留接口 | 不做完整节点体系，但先留 host/node 扩展点 | `plugin-sdk/*`, `sessionManager.ts` |
| A15 | P1 | M3 | 文档、迁移、回归测试 | 开发文档、配置迁移、集成测试 | `README.md`, `docs/*`, `tests/*` |

---

## 6. 详细任务卡

## A1. `SessionManager` 瘦身 + `CcbMessageParser` 提取

### 目标

先解决当前最大的真实问题：`SessionManager` 过胖、事件解析和生命周期管理耦合过深。  
本阶段不急着引入完整 `AgentHarness` 接口，而是先把 CCB 相关逻辑整理成清晰边界。

### 必做项

- 提取 `CcbMessageParser`
- 把 turn 流事件解析从 `SessionManager` 中拆出
- 把会话生命周期管理从消息解析逻辑中拆出
- 保持当前“同一 `sessionKey` 复用同一 CCB 子进程”的行为
- 为未来可能的 `AgentHarness` 抽象预留自然边界，但本阶段不强行造接口
- 保持现有 Web / Telegram / cron 行为不变

### 主要文件

- `packages/gateway/src/sessionManager.ts`
- `packages/gateway/src/subprocessRunner.ts`
- 新增 `packages/gateway/src/ccbMessageParser.ts`

### 验收标准

- 主流程仍可正常聊天、停止、resume
- `sessionManager.ts` 明显瘦身，职责聚焦于会话编排
- CCB 流式消息解析有独立测试
- 当前进程复用语义不变：同一 `sessionKey` 不重复 spawn

### 备注

如果未来真实出现第二种 harness 需求，再把这一阶段整理出的边界提升为 `AgentHarness` 接口。

---

## A1b. 引入轻量 `EventBus`

### 目标

为 webhook、cron、standing orders、跨 Agent 协作建立统一事件入口，避免每条链路继续在 `server.ts` 里硬编码。

### 必做项

- 新增轻量 `EventBus` 封装，基于 `EventEmitter` 即可
- 定义首批事件：
  - `cron.fired`
  - `webhook.received`
  - `task.created`
  - `agent.delegated`
  - `agent.completed`
- 统一事件载荷结构，至少包含：
  - `type`
  - `source`
  - `agentId`
  - `sessionKey`
  - `payload`
- 让现有 cron bridge 和后续 webhook 走事件总线而不是直接互相调用

### 主要文件

- 新增 `packages/gateway/src/eventBus.ts`
- `packages/gateway/src/server.ts`
- `packages/gateway/src/cron.ts`
- `packages/gateway/src/sessionManager.ts`

### 验收标准

- 新事件源接入不需要继续给 `server.ts` 塞新的直连逻辑
- cron 到执行链路可通过事件总线观测
- 不引入复杂分布式消息系统，只做进程内总线

---

## A2. 建立 prompt slots 分层

### 目标

把当前 prompt 注入从“零散拼接”提升为明确的槽位模型。

### 推荐槽位

- `SOUL`：Agent 身份与长期性格
- `AGENTS`：项目/工作区规则
- `MEMORY`：Agent 自身长期记忆
- `USER`：用户偏好与画像
- `SKILLS`：按需装载技能摘要

### 必做项

- 明确每个槽位的来源文件和优先级
- 为每个 Agent 增加稳定的槽位装配逻辑
- 加最小兼容：
  - 支持 `CLAUDE.md`
  - 支持未来扩展 `SOUL.md`
- 在代码中统一形成一个 `buildPromptContext()` 或等价函数

### 主要文件

- `packages/gateway/src/sessionManager.ts`
- `packages/storage/src/paths.ts`
- `packages/storage/src/memoryStore.ts`

### 验收标准

- 每个槽位有独立来源和装配顺序
- 不同 Agent 的 persona/memory 注入规则一致
- 后续加 standing orders/context files 时不需要再改 prompt 拼接结构

---

## A3. 增加 `toolsets`

### 目标

不要再让所有工具默认裸露给所有 Agent 和所有任务。

### 初始 toolsets

- `assistant`
- `research`
- `coding`
- `browser`

### 必做项

- 在配置层新增：
  - `toolsets`
  - `defaults.toolsets`
  - `agent.toolsets`
  - `route.toolsetsOverride`
- 对 MCP servers 和内建工具统一做过滤层
- Web UI 可展示当前 Agent 生效的 toolsets

### 主要文件

- `packages/storage/src/config.ts`
- `packages/gateway/src/server.ts`
- `packages/gateway/src/sessionManager.ts`
- `packages/web/public/app.js`

### 验收标准

- 可以给不同 Agent 指定不同工具集
- route 可以覆盖默认工具集
- toolsets 生效后不会破坏现有默认体验

---

## A4. 增加 terminal backend 抽象

### 目标

为后续 `execute_code`、隔离执行和远端执行打基础。

### 本轮范围

- 支持 `local`
- 支持 `docker`
- 不要求先做 `ssh`

### 必做项

- 配置新增 `terminal.backend`
- 抽象命令执行层，不直接把所有执行绑死在本机
- `docker` backend 至少支持：
  - image
  - volume mount
  - env allowlist
  - timeout

### 主要文件

- `packages/storage/src/config.ts`
- `packages/gateway/src/subprocessRunner.ts`
- 新增 `packages/gateway/src/terminalBackends/*`

### 验收标准

- `local` 模式行为与当前一致
- `docker` 模式能执行基础 shell 任务
- 不影响当前个人部署默认路径

---

## A5. 新增 `delegate_task`

### 目标

把当前异步 `send_to_agent` 升级为真正可控的多 Agent 委派。

### 目标行为

- 父 Agent 发起子任务
- 子 Agent 拥有隔离上下文
- 子 Agent 使用受限 toolsets
- 子 Agent 结果回到父 Agent，而不是只异步推给用户

### 必做项

- 新增 `delegate_task` 工具
- 参数至少包含：
  - `goal`
  - `agentId` 可选
  - `context` 可选
  - `toolsets` 可选
- 限制：
  - 子 Agent 禁止无限递归委派
  - 子 Agent 默认不能改 memory / cron / reminder
  - 有并发上限
- 父 Agent 能收到结构化结果

### 主要文件

- `packages/mcp-memory/src/index.ts`
- `packages/gateway/src/sessionManager.ts`
- 可能新增 `packages/gateway/src/delegation.ts`

### 验收标准

- 一个 Agent 可把研究任务派给另一个 Agent 并收回摘要
- 子 Agent 与主会话上下文隔离
- 失败可回传错误而不是静默丢失

---

## A6. 新增 `execute_code`

### 目标

增强复杂任务、多步工具调用、批处理任务能力，同时降低 token 消耗。  
但本任务暂时后置，原因是当前 ROI 未被证明，且 CCB 原生 Bash/Read/Write 工具链已经较强。

### 设计约束

- 运行脚本时不把中间工具结果灌回模型
- 只回最终 stdout / structured result
- 工具通过 RPC 被脚本调用
- 先支持 Python

### 必做项

- 新增内建工具 `execute_code`
- 生成 `openclaude_tools.py` 或等价 stub
- 脚本通过 socket / stdio RPC 调现有工具
- 限制：
  - 最大时长
  - 最大工具调用数
  - stdout 截断
  - 环境变量白名单
- 统一复用现有工具层，不要再造一套工具实现

### 主要文件

- 新增 `packages/gateway/src/codeExecution.ts`
- 新增 `packages/gateway/src/codeExecutionRpc.ts`
- `packages/mcp-memory/src/index.ts` 或工具注册链路

### 验收标准

- 支持“查多个文件再聚合”
- 支持“跑测试并解析摘要”
- 支持“多轮搜索与筛选”
- 中间结果不进入主上下文

### 备注

本任务作为延后实验项处理。只有在 `delegate_task`、OpenAI-compatible API、toolsets、webhook 路由都稳定后，再评估是否进入开发。

---

## A7. 完善 skills/context 体系

### 目标

把当前 skill 体系从“能保存、能查看”提升到“真正参与运行时能力增强”。

### 必做项

- 为 skill 增加更完整元数据：
  - tags
  - required_environment_variables
  - suggested_toolsets
  - examples
- skill 装载时只注入摘要，详情按需读取
- 预留 skill 与外部执行环境的联动接口
- `execute_code` / `terminal backend` 的具体联动放到 A4/A6 落地后再接入
- 保留自动 `skill_save` 路径，但加最低质量门槛

### 主要文件

- `packages/storage/src/skillStore.ts`
- `packages/mcp-memory/src/index.ts`

### 验收标准

- skill 能声明环境变量需求
- 长 skill 不会把 prompt 撑爆
- Agent 可以先看 skill 摘要，再按需展开正文

---

## A8. 新增 webhook automation

### 目标

让外部事件可以直接驱动 Agent，而不是只有用户主动发消息。

### 首批支持

- GitHub Webhook
- 通用 JSON Webhook

### 必做项

- 新增 webhook 路由模块
- 支持：
  - secret 校验
  - prompt template
  - 指定 agent
  - 指定 deliver target
- 最小模板变量替换：
  - dot path 读取
  - 全量原始 payload 注入
- Web UI 能看 webhook 路由列表和最近执行记录

### 主要文件

- 新增 `packages/gateway/src/webhooks.ts`
- `packages/gateway/src/server.ts`
- `packages/web/public/app.js`

### 验收标准

- GitHub PR / push webhook 能被接收并触发 agent
- 能将结果投递回 Web 会话或 Telegram

---

## A9. Standing Orders / Background Tasks

### 目标

把提醒和 cron 从“时间触发器”升级成“长期任务系统”。

### 必做项

- 引入 `standing_orders.md` 或等价配置
- 定义后台任务状态：
  - pending
  - running
  - completed
  - failed
- 支持：
  - 持续关注型任务
  - 周期回顾型任务
  - 事件驱动型任务
- Web UI 增加任务页

### 主要文件

- `packages/gateway/src/cron.ts`
- 新增 `packages/storage/src/taskStore.ts`
- `packages/web/public/*`

### 验收标准

- 能持久化任务定义与最近执行记录
- 能区分 cron job 与 assistant task
- 能在 UI 中查看最近结果

---

## A10. OpenAI-compatible API

### 目标

开放标准接口，降低前端和生态耦合。  
这项优先级前移，因为它能尽早减轻当前 Web UI 单体维护压力，并快速接入现成生态。

### 首批范围

- `POST /v1/chat/completions`
- `POST /v1/responses`
- 基础流式输出

### 必做项

- 请求映射到当前 session / agent
- 兼容 Bearer 鉴权
- 支持：
  - system/user/assistant messages
  - stream
  - tool call 输出的基础映射
- 提供清晰的限制说明，不假装完全兼容

### 主要文件

- `packages/gateway/src/server.ts`
- 可新增 `packages/gateway/src/openaiCompat.ts`

### 验收标准

- 可被 Open WebUI/LobeChat 做基本对接
- 普通文本对话和流式返回可用

---

## A11. 扩展 plugin-sdk

### 目标

从“只有渠道工厂”升级为真正的能力插件面。

### 插件类型建议

- `ChannelPlugin`
- `ProviderPlugin`
- `HarnessPlugin`
- `AutomationPlugin`
- `NodeCapabilityPlugin`

### 必做项

- 扩展 SDK 接口
- Gateway 启动时做插件发现和注册
- 配置层支持 plugin entries
- 保持现有 Telegram channel 兼容

### 主要文件

- `packages/plugin-sdk/src/index.ts`
- `packages/gateway/src/server.ts`
- `packages/cli/src/commands/gateway.ts`

### 验收标准

- 现有 channel 通过新接口正常运行
- 新增 plugin 类型不需要改核心 router

---

## A12. Web UI 技术路线决策 + 控制面增强

### 目标

减少 `app.js` 继续膨胀，但在动手拆分前，必须先明确 UI 技术路线。

### 必做项

- 先产出一份 UI ADR，二选一：
  - 保持 vanilla 路线：IIFE 模块化 + 单文件/少量文件组织
  - 引入 `Vite + Preact/Lit`：真正模块化
- 在 ADR 确定之前，不做大规模 UI 结构重写
- ADR 确定后，再实施控制面增强
- 增加以下视图：
  - Agent 列表与当前 toolsets/backend
  - Task / webhook / cron 执行状态
  - 最近运行记录

### 主要文件

- `packages/web/public/app.js`
- `packages/web/public/index.html`
- `packages/web/public/style.css`

### 验收标准

- UI 技术路线有明确结论并沉淀成文档
- 选定路线后，`app.js` 或对应新入口明显瘦身
- 新视图不依赖大量全局变量
- 不回退当前 UI 体验

---

## A13. 可观测性与诊断

### 目标

让系统具备“能调试、能解释、能复盘”的最低能力。

### 必做项

- 每个 run 记录：
  - agent
  - session
  - task type
  - tool calls
  - duration
  - cost
  - result state
- Web / CLI 提供最小 `doctor` 视图
- 错误日志与普通日志分层

### 主要文件

- `packages/gateway/src/server.ts`
- `packages/gateway/src/sessionManager.ts`
- `packages/web/public/*`

### 验收标准

- 能快速定位失败任务
- 能看到一次任务到底用了哪些关键工具

---

## A14. 远端工作节点预留接口

### 目标

先为未来“远端执行主机 / remote workspace”预留扩展点，但本轮不做完整节点体系。

### 必做项

- 在 terminal/backend 抽象里允许 `host` 维度
- 在 plugin-sdk 里为未来 node capability 留接口
- 配置层允许定义远端执行目标

### 验收标准

- 未来加远端执行不需要再推翻现有 backend 设计

---

## A15. 文档、迁移、测试

### 目标

避免这轮改造完成后只有代码，没有稳定交付面。

### 必做项

- 更新 README
- 新增架构文档
- 给配置增加迁移说明
- 最少补充：
  - `CcbMessageParser` 单元测试
  - delegate_task 集成测试
  - webhook 路由测试
  - openai-compatible API smoke test
  - 如 A6 进入主线，再补充 `execute_code` 集成测试

### 主要文件

- `README.md`
- `docs/*`
- `packages/*/__tests__/*`

### 验收标准

- `npm run check` 持续可过
- 关键能力有最小回归测试覆盖

---

## 7. 推荐开发顺序

严格按下面顺序推进，不要跳跃开发：

1. `A1 SessionManager 瘦身 + CcbMessageParser`
2. `A1b EventBus`
3. `A2 Prompt slots`
4. `A3 Toolsets`
5. `A5 delegate_task`
6. `A10 OpenAI-compatible API`
7. `A4 terminal backend`
8. `A8 webhook automation`
9. `A9 standing orders / background tasks`
10. `A11 plugin-sdk 扩展`
11. `A12 Web UI 技术路线决策 + 控制面增强`
12. `A13/A14/A15 收尾`
13. `A6 execute_code（延后评估）`

原因：

- `A1-A3` 是基础结构
- `A5` 是最直接的能力跃迁
- `A10` 是最直接的生态入口
- `A8-A12` 是平台化与控制面
- `A6` 作为后置实验项

---

## 8. 建议按批次交付

### 批次 1

- A1
- A1b
- A2
- A3

目标：把架构骨架立住。

### 批次 2

- A5
- A10
- A4

目标：让 agent 能力增强，同时尽早打开生态接入口。

### 批次 3

- A8
- A9
- A11

目标：从聊天工具升级为自动化助手平台。

### 批次 4

- A12
- A13
- A14
- A15
- A6

目标：把项目从“能跑”变成“可持续演进”，并评估 `execute_code` 是否值得进入主线。

---

## 9. 给 Claude Code 的执行约束

让 Claude Code 开发时遵守以下约束：

1. 不侵入修改 `claude-code-best` 内部，除非绝对必要。  
2. 所有新增能力优先通过 OpenClaude 外层桥接实现。  
3. 每次只做一个任务卡，不要跨多个里程碑混改。  
4. 每个任务必须同时提交：
   - 代码
   - 配置变更
   - 最小测试
   - 文档更新
5. 不接受“功能能跑但破坏 `npm run check`”的交付。  
6. 默认保持“个人部署优先”的易用性，不引入高摩擦复杂流程。  

---

## 10. 每项任务的统一完成定义

每个任务完成时，必须同时满足：

- 功能可运行
- `npm run check` 通过
- 至少有 1 个回归测试或 smoke test
- README 或对应文档已更新
- 不破坏当前 Web 会话主流程
- 对个人部署的默认体验无明显倒退

---

## 11. 最高优先级结论

如果只能先做 3 项，就做：

1. `A1 SessionManager 瘦身 + CcbMessageParser`
2. `A5 delegate_task`
3. `A10 OpenAI-compatible API`

这是对当前项目收益最大、且最符合“CCB 作为最强 harness”的三项。
