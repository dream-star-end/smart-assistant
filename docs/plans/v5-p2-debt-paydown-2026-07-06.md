# v5 P2 登记债偿还方案(2026-07-06)

> 目标:清零 roadmap P2 出口条件三债——债A 团队卡 server-authored 化、债C hidden reviewer 硬编排(+债D 审查成本披露)、债E 可见性黑名单散点;顺带偿 TeamPanel 聚合脆弱(渲染半边)与委派并发挤兑(审查保障所需的最小部分)。
> 取证:2026-07-06 两路 opus 调研(server-authored 链路 / reviewer+可见性),关键锚点行号已核。Codex 口径:不强制送审,批次 3 若触计费扣费收口再自行送审(现方案只动展示投影,不动 spendTwoBucket)。

## 批次 1 — 债E 可见性投影收口(先行,风险最低)

1. **权威源上移**:`HIDDEN_SYSTEM_AGENT_IDS` + `isHiddenSystemAgentId` 迁入 `@openclaude/protocol`(新模块 agentVisibility);`packages/gateway/src/agentVisibility.ts` 改 re-export;`packages/commercial/agent-sandbox/runtime/entrypoint.ts:914-919` 删除独立手抄实现改 import——编译期单一权威,消最脆弱漂移点。
2. **用户可见视图**:gateway 加 `_getAgentsConfigUserView()`(包 `_getAgentsConfig()`,内建 filterUserVisibleAgents/Routes/default 三投影);**枚举/展示消费面**改走它并删手工 filter:管理面 GET(server.ts:4943)、openaiCompat models(openaiCompat.ts:58)、task/cron/webhook 列表、skill scope(server.ts:5271)、collaboratorAgents(collaboratorAgents.ts:37)。
3. **明确保留全量+predicate 的面(不收敛)**:delegate 执行 find(6441)、熔断/资源闸(6421)、cron 执行跳过(cron.ts:332)、入站 frame 拒绝(8744/8777)、自动续写跳过(8391/8441)、seed reconcile(entrypoint)、agentModelAuthority、admin 聚合——判定类不是枚举泄漏面,继续用 predicate。
4. 前端「质量审查员」显示名映射通道(agentNames.ts)是有意展示,保留不动。
5. 测试:既有 agentVisibility/openaiCompatVisibility/teamModeHiddenReviewer 全绿;新增投影单测(枚举面不含 hidden id、default 收敛)。

生效面:runtime image(gateway+entrypoint)+ protocol 共享包。

## 批次 2 — 债A 团队卡 server-authored 化 + TeamPanel 聚合加固

1. **生成点 = handleDelegateTask 收尾**(server.ts:6388 委派完成/失败/超时处),不撤 ccbMessageParser.ts:959 的 Agent 排除(排除注释更新指向新机制)。durable agent-group 载荷:`{runId, agentId, goal, status(ok/failed/timeout), resultSummary(截断), ts}`;master 侧补 usage 成本(见批次 3.4)。
   - **显式权衡**:childBlocks 过程树不全量持久化(sink body cap 256KB;live 富树仍走 delegate_progress 帧 + 本设备 IndexedDB)。跨设备看到的是完整团队结构+结果+成本,过程细节降级。若未来要全量过程,升级为独立 blob 通道,不在本批。
2. **通道扩展四处同批改**(f2272c08 白名单漂移前科):v3MasterSink wire payload 加 `agentGroups[]`(注意 body cap 与 drop 顺序);master `internalServerAuthored.ts` BodySchema(strict)显式加字段 + role 联合加 `'agent-group'`;storage `sessionsDb.ts:1523` role 联合;`protocol/teamCards.ts` 展示字段权威 + `sessionsDb` strip 白名单同步。无 DDL(messages 为不透明 blob)。
3. **去重合并(最高危面)**:server 行带 runId;前端 `mergeFullServerWins`/`normalizeDelegateCards` 按 runId 折叠——本地 `m-*` 同 runId 存在 → local-wins 展示字段、server 行不重复渲染;缺席(跨设备/清缓存)→ 渲染 server 行。服务端 `mergePreservingServerAuthored`/`_localMessageSupersedes` 对 agent-group 行按 runId 合一,**禁止 role-mismatch server-wins 吞 childBlocks**(2c73030d 原始事故回归用例必须加)。
4. **TeamPanel 聚合加固**:`MessageRenderer.tsx coalesceTeam` 从"相邻连续行"启发式改为按 turn 锚点归组(同 turn 内 agent-group 归一个面板),穿插行不再劈裂面板。
5. 迁移边界登记:cutover 已全量、迁移引擎 inert;若重跑 L2 会整 blob 覆盖新团队行——记为已知边界不改引擎。
6. 恢复语义:重启后 REST getSession 能带回 server 团队行,补上 ring-miss 场景团队卡缺口(即债 A 的另一半动机)。

生效面:runtime image(gateway)+ master(commercial)+ storage + web-react dist。

## 批次 3 — 债C reviewer 硬编排 + 债D in-chat 成本披露 + 并发闸补强

1. **verdict 协议统一**:protocol 定义审查 verdict 词汇(PASS/NEEDS_FIX);`parseVerificationVerdict`(sessionManager.ts:3051)吸收 NEEDS_FIX(FAIL 语义);reviewer persona(entrypoint.ts:1057-1059)输出结构化 `VERDICT:` 行;两源一致性测试扩展。现有解析器与 reviewer 管线"互相孤立"的断裂就此接上,不另造解析。
2. **gateway 硬编排 review pass**:teamMode 且本 turn 实际发生过非 hidden 委派 → 队长 final 放行前由 gateway 代码触发 review delegate(经 handleDelegateTask 内部调用),解析 verdict:
   - PASS → 放行 final;NEEDS_FIX → 审查意见以系统 continuation 喂回队长,迭代封顶 2 轮 + 预算封顶(env 可配),到顶强制放行+披露。
   - **降级分支代码化**:排队超时/429/503/重启中断 → 放行 final + 卡片披露「审查未完成」;绝不允许队长卡死等 verdict(重启恢复时 review 未完成一律判定跳过)。
   - **消双机制**:硬编排上线即从队长 preamble(server.ts:9396-9403)删除"自觉调用审查/verdict 解读/迭代自律"软约束(协作语义保留);HiddenDelegateGuard 额度语义改为只约束硬编排重试;审查触发权威唯一 = gateway 代码。teamModeHiddenReviewer.test.ts 的 prompt 文本断言同步重写为编排行为断言。
3. **runLog + 持久审计**:RunLogEntry 加 isReview/verdict;handleDelegateTask start/complete 打标;审查发生与结果经 master 审计通道持久化(runLog 纯内存仅背 doctor)。
4. **in-chat 成本披露(债D)**:master drainDelegateCost(internalServerAuthored.ts:1140-1180)在合计入队长行的同时,把 per-delegate 明细附进队长行 `usage.delegates[]`(agentId+costCredits);前端团队卡/委派卡渲染「质量审查员 · PASS · X 积分」。用量页(UsageTab 组队明细)已披露,不动;不新增查询面,不碰扣费收口。
5. **并发闸补强(挤兑债的审查保障部分)**:`_activeDelegations` 全局计数分桶 per-parent(每父会话上限,容器总上限保留)+ 硬编排 review 保留槽,消 cron/他会话挤兑审查。fan-out 并行原语、委派上下文结构化等仍属 P2.2b 产品化,不在本批。

生效面:runtime image + master + web-react。

## 执行与验收纪律(每批)

- 独立 worktree 基 feat/v5-aurora-rewrite;opus 子 agent 实现、不 commit;我逐 agent 验收 diff+实跑测试后分批 commit(boss 07-06 分工)。
- typecheck + 四层测试实跑 + commercial unit 基线失败集 diff(本树 ⊆ 基线);行为断言,不接受源码 regex 测试(teamModeHiddenReviewer 现有 regex 测试在批次 3 换掉)。
- gateway/entrypoint 改动合并后 canary 镜像以 agent uid 真机验证再放量;部署走 v5-commercial-deploy 生效面矩阵。
- 批次顺序 1→2→3;批次 2/3 有共享面(server-authored usage 字段),批次 3 依赖批次 2 的 agentGroups 通道先落。
