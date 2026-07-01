# v5 团队模式重构设计 —— team run 服务端一等实体化 + web-react 团队 UI

> 状态：**v2 — Codex 复评 PASS，可开工 P1** ｜ 日期：2026-07-01 ｜ 分支：`feat/v5-team-mode-optimize`
> 前置调研：`/root/openclaude-scratch/v5-team-mode-optimization-2026-07-01.md`（Codex 后端调研 + 前端归属调研）
> 评审记录：见第 8 节（v1 → Codex BLOCK → v2 必改项已纳入）
> 定调：v5 未上线，允许大范围重构，一次做对。

---

## 1. 问题陈述（为什么要重构，而非打补丁）

**根因**：v5 团队模式没有服务端权威运行态。服务端只有团队配置 CRUD（`agents.yaml` 的 `teams`），团队"运行"是委派子会话的松散集合，协作规则（maxParallel/requireReview）只以 prompt 文案影响队长模型，服务端零强制。

**v5 特有事实**：v5 生产 serve 的 `web-react` **根本没有团队管理 UI**（编辑器/选择器/发起入口从未从老 `web/public` 港移，只有被动可视化 `TeamPanel.tsx`）。v5 用户当前无法显式组队或发起团队 run。

**结论**：任何"让用户显式发起并控制团队 run"的 UI，前提都是服务端有 run 实体。"补 UI"与"根治"是同一件事。web-react 是白纸（无老 hack 要拆），一次做对的最佳时机。

---

## 2. 目标与非目标

**目标**：team run 服务端一等实体（创建/查询/订阅/stop/regen/审计）；policy 服务端硬强制（maxParallel 信号量、成员白名单、requireReview finalization gate）；web-react 全新团队 UI（CRUD + 发起器 + run 实时账本）；渠道对称（Web/WeChat/TG 同一发起入口）；资源感知（撞限明确排队/报错，绝不静默降级为"缺口"）。

**非目标**：不改容器物理规格（1CPU/4GB，用调度缓解）；不做跨用户团队；不做团队 run 独立计费（预留字段）。

---

## 3. 服务端设计

### 3.1 实体模型（P1 落 SQLite）

```
TeamRun {
  teamRunId, teamId, teamSnapshot(冻结 policy+members 防运行中漂移),
  userGoal, origin{channel:'web'|'wechat'|'telegram', peer, sessionKey},
  leaderAgentId, leaderSessionKey,
  status: 'pending'|'running'|'waiting_review'|'finalize_required'|'finalizing'|'completed'|'failed'|'interrupted',
  policyRuntime{ maxParallel, reviewRequired, reviewAgentId?, reviewReturnedAt? },
  finalAcceptedAt?, finalContentRef?, costSummary?, parentRunId?, createdAt, updatedAt
}
TeamDelegation {
  delegationId, teamRunId, memberAgentId, goal,
  status:'queued'|'running'|'completed'|'failed'|'rejected',
  childSessionKey?, startedAt?, completedAt?, resultRef?, error?,
  rejectReason?:'maxParallel'|'not_member'|'memory'|'depth'|'timeout'
}
```

### 3.2 队长 prompt 服务端构建（Codex 必改：dedicated session，勿污染普通路径）
- `createTeamRun` 建**独立 leader session** `agent:<leader>:teamrun:<runId>`（不复用普通 chat session）。
- 服务端 `buildTeamLeaderPrompt(snapshot, goal)` 作为 **first-turn user payload** 传给 `sessions.submit()`（对接 `subprocessRunner.ts:1049` 写 stdin user message）。
- 只给该 dedicated leader runner 的 MCP env 注入 `OPENCLAUDE_TEAM_RUN_ID`（扩展点 `subprocessRunner.ts:1213`，与现有 `OPENCLAUDE_SESSION_KEY`/`OPENCLAUDE_DELEGATION_DEPTH` 并列）。
- **不走全局 promptSlots 注入 snapshot**：`extra-prompt.md` 是 runner spawn 级（`subprocessRunner.ts:1140`），普通 agent 复用 runner 会留错误上下文。

### 3.3 finalization —— submit_team_final 为主 gate（Codex 必改，前置到 P1）
**为什么不能拦 leader final**：assistant text block 实时流给客户端（`sessionManager.ts:1935` 只 buffer final、`server.ts:8103` 收到 text block 立即 deliver），到 `final` 帧（`server.ts:8156`）时队长"最终答案"文本**已显示给用户**，无法优雅撤回。
**主方案**：
- `mcp-memory` 新增 `submit_team_final(content, summary?)`，**仅当 `OPENCLAUDE_TEAM_RUN_ID` 存在时暴露**。
- 工具 POST gateway `/api/team-runs/:id/finalize`，硬校验：run 属当前 leader session、`requireReview=false || reviewer delegation completed`、run 未 interrupted/failed。
- 通过→记 `finalAcceptedAt`/`finalContentRef`，发 `team_run.finalized`。
**兜底**（非主 gate）：leader 普通 final 分支若发现 run 无 `finalAcceptedAt`，把 run 标 `finalize_required`/`waiting_review`，UI 显示"队长草稿/未提交最终答案"。仅防 run 状态误 `completed`，不假装能撤回已流出文本。

### 3.4 协议
- `POST /api/agent-teams/:id/runs {goal, overrides?}` → `{teamRunId}`（冻结 snapshot、建 leader session、服务端构建 prompt、dispatch）。
- `POST /api/team-runs/:id/finalize`（见 3.3）。
- `GET /api/team-runs/:id` → run 快照。
- `delegate_task`（MCP）→ `/api/agents/:id/delegate` 新增 `teamRunId`（leader session→run 反查），gateway admission 时按 run 强制。
- **run 事件（Codex 必改：复用 delegateProgress，勿建两套）**：成员执行详情复用现有 `delegate_progress` block 透传（`delegateProgress.ts:208`、`server.ts:5350`），给其加 `teamRunId`/`delegationId` 字段；**仅新增最小 run-level 帧** `team_run.snapshot` / `team_run.patch`（queued/rejected/rejectReason/run status/review/finalization/stop）。不新建成员 transcript 流。

### 3.5 policy 硬强制 + 嵌套委派（Codex 必改：显式嵌套策略防死锁）
- **maxParallel**：per-teamRunId 信号量（替代松散全局 `_activeDelegations<5`，`server.ts:5153`；全局闸保留作 backstop）。
- **成员白名单**：带 teamRunId 的 delegate 只允许 snapshot member/reviewer，否则 `rejected(not_member)`。
- **嵌套委派策略（关键）**：team policy **只约束 leader-originated delegations**。团队成员的嵌套 delegate **不继承 teamRunId/run 信号量**（默认拒绝并提示"成员不得再委派，需队长发起"，或作为普通非团队 delegate 走全局闸）。避免 `maxParallel=1` 时 leader→A→B 共用信号量死锁。
- **调度用单一 scheduler**，不用嵌套锁：仅当 per-run token + 全局 token + 内存 guard 同时满足才启动 child。
- **requireReview**：finalization gate（3.3）。

### 3.6 资源模型（P1 先 reject，队列后置到 P5）
- P1：撞 per-run/全局/内存上限 → `rejected(reason)` + 明确前端上报（不进"缺口"文案）。
- P5：内存 85% guard（`server.ts:476,5306`）从硬拒改为与 run 队列集成（queued 等待+timeout）。不涨容器规格。

### 3.7 持久化（Codex 必改：SQLite 权威，in-memory 仅 cache）
- **SQLite（agent home，复用 sessions.db 模式）存 TeamRun/TeamDelegation durable status = 权威**（团队配置本就在 `OPENCLAUDE_HOME` 的 agents.yaml，`config.ts:210`）。
- `_activeDelegationsByParent`（`server.ts:5156`）仅进程内 stop 递归的 live cache，**不作恢复权威**。
- admission 顺序：**先写 SQLite `queued/running` → 再启动 child → finally 更新 `completed/failed`**（否则 stop/refresh 见幽灵态）。
- gateway 重启：把 `running/queued/finalizing` 旧 run 标 `interrupted`/`recovering`，不假装恢复已丢的 in-memory interrupt map。
- master PG mirror 后置（P6）。

### 3.8 渠道对称
`createTeamRun` 唯一发起入口。WeChat/TG inbound 帧扩展可选 `teamId` → 走 `createTeamRun(origin=该渠道)`。前端无关，非 Web 天然获得团队模式。

---

## 4. web-react UI 设计

新增 `packages/web-react/src/components/team/`：
- **TeamManager**：团队列表 + 增删（消费已存在 `/api/agent-teams` CRUD）。
- **TeamEditor**：队长/成员/maxParallel/requireReview/reviewAgent/规则备注。字段权威=服务端校验（存盘即真值，UI 显示真实 cap，消除"三数字分裂"）。
- **TeamLauncher**：composer 旁入口——选团队+目标 → `POST runs`。用户消息只存目标，不存合成 prompt。
- **TeamRunView**（`TeamPanel.tsx` 演进）：**由服务端 run snapshot/patch 驱动**（非消息 coalesce 推断）。队长+成员 DAG、每成员状态/耗时/cost、review 态、被拒委派（含 rejectReason）、finalize 态、stop/单成员 retry。
- **teamRun store**：订阅 WS run 事件，替代客户端 `_teamRun`/`_activeTeamRun` 猜测；stop/regen 直接对 runId 操作。

**发现性**：TeamLauncher 入口显式化，解决"新用户不知团队模式存在"。

---

## 5. 分阶段落地（Codex 必改后顺序，每阶段独立可验 + Codex PASS 才进下阶段）

| 阶段 | 内容 | 包 |
|---|---|---|
| **P1 地基（协议全定死）** | TeamRun/TeamDelegation SQLite 最小表 + `createTeamRun` + dedicated leader session/prompt + **submit_team_final + finalization gate** + delegate admission（信号量+白名单+嵌套策略+reject）+ **run event schema（delegate_progress 扩展 + team_run.snapshot/patch）** | gateway, mcp-memory, storage |
| **P2 团队管理 UI** | web-react TeamManager + TeamEditor + TeamLauncher | web-react |
| **P3 run 可视化** | TeamRunView（消费 run snapshot/patch + delegate_progress） | web-react |
| **P4 生命周期 + 渠道** | stop/regen/resume 落 run 对象 + 渠道对称（WeChat/TG teamId inbound） | gateway, commercial |
| **P5 资源调度** | 内存 guard 集成 run 队列（reject→queue）、调度硬化 | gateway |
| **P6 增强** | master PG mirror / 审计 / costSummary | gateway, storage |

**关键改动（相对 v1）**：finalization + run event schema + SQLite 表**从 P4 提到 P1**——否则 P3 UI 与 WS 协议会围绕错误的 `completed` 语义搭建，返工。资源队列从 P1 降到 P5（P1 先 reject）。

---

## 6. 开放问题（Codex 已评审，结论纳入上文）
1. finalization 拦截 → **submit_team_final 为主、拦 final 为兜底**（3.3）。✅
2. 队长 prompt 注入 → **dedicated leader session first-turn + env**（3.2）。✅
3. 信号量/全局/depth 死锁 → **嵌套不继承 run 信号量 + 单 scheduler**（3.5）。✅
4. run 事件 → **复用 delegate_progress + 最小 run 帧**（3.4）。✅
5. 持久化权威 → **SQLite 权威、in-memory cache、write-before-start**（3.7）。✅
6. 阶段顺序 → **finalization/run-schema/SQLite 前置 P1**（5）。✅

---

## 7. 落地纪律
- worktree `/root/openclaude-wt/v5-team-mode-optimize`；每阶段小 commit。
- **遵循 worktree CLAUDE.md BLOCKING 流程：Plan→Codex 评审 Plan→实现→Codex 评审 Code→迭代至 PASS**。
- Codex review 大 diff 只贴关键 hunk，让 Codex 自己 git diff。
- 前端阶段：vite build + rsync dist + 重启验证；后端容器代理 API：重建 runtime image。
- lint 只手改自己引入的，不跑 biome --write。
- v5 未上线，无 v3 影响顾虑；仍走 v5 灰度 smoke。
- changelog 由 boss 亲自决定，AI 不改。

---

## 8. 评审记录
- **v1 → Codex（conversationId 019f1b95…）评审 = BLOCK**，5 必改项：① submit_team_final 为主 gate（拦 final 太晚，文本已流出，证据 sessionManager.ts:1935/server.ts:8103）；② finalization+run schema+SQLite 前置 P1；③ 队长 prompt 走 dedicated session（勿全局 promptSlots）；④ 嵌套委派不继承 run 信号量（防死锁）；⑤ 复用 delegate_progress，不建两套事件流。
- **v2 已全部纳入**（本文档）。**Codex 复评 v2 = PASS，可开工 P1。**
- **P1 实现提醒（Codex，复评时给出）**：① `submit_team_final` 必须校验 `teamRunId + leaderSessionKey + OPENCLAUDE_SESSION_KEY` 三者绑定，不能只信工具传来的 runId；② SQLite admission 严格"事务写 delegation 状态成功 → 再启动 child"，防不可恢复幽灵态；③ 嵌套委派 P1 先"拒绝"（更可解释），不降级为普通 delegate。

---

## 9. P1 锁定决策（2026-07-01，基于 P1 实现地图 + 读 server.ts deliver 链路确认）

> 编码前定死。样板均在现仓：`skillTrainRunId`/`skill_propose` 与 `teamRunId`/`submit_team_final` 完全同构；SQLite store 样板 = `wechatBindings.ts`（CREATE 在 sessionsDb.ts、CRUD 独立文件）。

**D-A｜leader session 输出桥接回用户会话**（原最大坑，已解）：
- createTeamRun 在 `POST /runs` 请求内捕获 origin = 用户当前 webchat session 的 `{sessionKey, channel, peerId, userId}`。
- 建独立 leader session `agent:<leader>:teamrun:<runId>`（隔离 agent/env，注入 `OPENCLAUDE_TEAM_RUN_ID`）。
- `sessions.submit(leaderSession, buildTeamLeaderPrompt(snapshot,goal), cb)` 回调里把 block 组成 `out`（指向 origin，形态同 `server.ts:5353` emitProgress / `8103` WebChat 逐块流）→ `this.deliver(out)`；leader final → 发 isFinal 终止帧。
- leader 跑独立 session（正确 agent/env 隔离），输出流进用户 session 显示。P1 无新 UI，靠此桥接即可观测。

**D-B｜teamRunId 权威 = leaderSessionKey 反查（不改 mcp delegate body）**：
- `/api/agents/:id/delegate` 用 `parentSessionKey` 查 teamRunStore：命中 `TeamRun.leaderSessionKey` → leader 委派 → 强制 policy（信号量+白名单）；命中 `delegation.childSessionKey` → 成员嵌套委派 → **P1 拒绝**；都不命中 → 普通非团队 delegate（原逻辑）。
- 天然实现"嵌套不继承信号量"，避免 maxParallel=1 死锁。

**D-C｜admission = SQLite 事务，写序 + 双闸**：
- 入口事务：`count(running delegations where teamRunId) < snapshot.maxParallel` → 插 delegation 行(queued→running)；否则 `reject(maxParallel)`（P1 先拒不排队）。
- 写序：delegation running 落库 **在 getOrCreate/spawn(`server.ts:5341`) 之前**；终态 completed/failed **在 finally(`server.ts:5484`)**。
- 三数字消歧：config cap `TEAM_MAX_PARALLEL_CAP=2`（存盘层 agentTeams.ts）→ snapshot.maxParallel(≤2)→ per-run 信号量按 snapshot 强制；全局 `MAX_CONCURRENT_DELEGATIONS=5` 独立 backstop（跨所有委派），不与 per-run 混算。

**D-D｜SQLite co-locate 进 sessions.db**（wechat_bindings 同款）：
- 表 CREATE 在 `sessionsDb.ts:~289`（末尾 db.exec 块）；CRUD 新文件 `packages/storage/src/teamRunStore.ts`（拷 wechatBindings.ts 结构）；`storage/src/index.ts` 加 barrel export。零新单例。

**P1 开工子步顺序**：P1a storage（表+teamRunStore，greenfield 最低风险）→ P1b createTeamRun+路由+桥接 → P1c delegate admission → P1d submit_team_final 工具+finalize 路由+兜底 gate。每子步 typecheck + Codex 审 code。

---

## 10. P1b-2 Codex 审 = BLOCK（2026-07-01）→ 桥接架构需 rework

进度：P1a(cb1a8774) + P1b-1(97cf2df8) + P1b-2(5116acfe) 已 commit + typecheck 干净。Codex 审 P1b-2 = **BLOCK**（conversationId 019f1b95 复评2）。

**确认 OK**：teamRunId env 注入、队长 prompt first-turn、admitTeamDelegation 原子事务。

**必改**：
1. **origin 依赖已存在 AgentSession（会 404 + deliver 无处可送）**：`handleCreateTeamRun` 用 `getByKey(sessionKey)` 要求 origin 会话已存在；但新 TeamLauncher 可能在新 client session 上发 REST /runs（无 AgentSession，clientsByPeer 未注册）。
2. **leader error 被误标 finalize_required**：`SessionManager.submit` error path = onEvent(error)+resolve()（非 reject），`.then` 仍跑把失败标成"未提交"。→ 追踪 leaderHadError，error→failed。
3. **桥接输出不进 durable client_sessions**：leader session=channel:'delegate'，durable 写回只对 webchat/wechat；手动 deliver 只进 outbound ring，刷新/断线丢队长 transcript。
4. **interruptStaleTeamRuns 实现了没接线**（gateway 启动未调用）。

**P1c/P1d 前接口缺口**：final/delegation content 存哪未定（只有 *_content_ref）；maxParallel rejection 无账本行（admitTeamDelegation 超额只返回不记录）；origin 缺 peer kind 字段（P5 渠道对称需要，现在加免迁移）。

**→ 修正的桥接架构决策（下一步 rework，取代第 3/4 节部分桥接描述）**：team run 可观测性**不 piggyback 聊天 transcript**：
- (a) `createTeamRun` 不依赖已存在 AgentSession —— 接收显式 origin routing（channel/peerId/**peerKind**/userId），需要时登记 peer；team_runs 加 `origin_peer_kind` 字段。
- (b) **durable 真相源 = team_runs + team_delegations 表 + final content**（新增 content 存储约定，P1d 定死）。
- (c) live 更新走 **team_run.snapshot/patch 事件**（run event schema，本是 P3，**提前作为核心观测机制**）+ 尽力而为的 leader 直播到活跃连接。
- (d) TeamRunView 从 `GET /api/team-runs/:id` + 订阅 run 事件读状态，**不读聊天 transcript**。
- (e) 附带修：leader error 终态、gateway 启动接线 interruptStaleTeamRuns、admission 超额原子记 rejected 行、加 origin_peer_kind。

**结论**：P1b-2 commit 5116acfe 保留但标"桥接待 rework"。下一步 = 按上述 (a)-(e) 重做桥接 + 提前落 run event schema，再 Codex 复审 → PASS 后才进 P1c/P1d。**这是先设计对再写的正确迭代，不是返工浪费**。
