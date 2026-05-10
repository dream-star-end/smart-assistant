# v3 商业版架构体检 — Phase 0 报告

日期: 2026-05-10(v2.4 修订:Codex 四审 3 blocker + 2 nit 全部采纳)
评审: Codex(gpt-5.5)4 轮已采纳;详见 §8
状态: **待 boss 拍板 v2.4**;尚未启动任何代码改造

---

## 0. 执行摘要

**结论**: v3 commercial 已经到了**该启动结构化重构**的阶段。理由:
1. 60 天内 437 个实质 commit,**清一色 fix** 占多数,且 fix 的根因在收敛(见 §2)
2. 5 个 >2000 行 god file,1 个函数 ~2000 行,1 个函数 ~1450 行,gateway/server.ts 5969 行
3. 既有的 2026-04-11 audit + 04-12 refactor plan 基本未执行就被 v3 fork 跨过去了
4. memory 反复出现"治本"型条目,patch 路径已耗尽
5. **dev pipeline 已成红线**: typecheck 72s + 14+ 既存 TS 错误长期红线 + 无 CI + deploy-v3.sh 554 行单脚本(详见 §1.4)

**建议方式**: 渐进切片,**25 个细粒度切片** 分 3 期推进 + 1 条平行 audit/ops track,**不做 big-bang**,**重构期不停发新功能但放慢**。

**预算**(Codex 二审建议下调,稳健档):
- 核心路径 **14-18 周**
- 实际日历周期 **24-36 周**(乐观档 18-26 周需要"无大事故 + ops track 有专人 + S12a/b/c/d 拆小成功"前提)
- 新功能吞吐下降 45-65%(Phase A 前半段 + Phase C 可能短期超过 -65%);**Parallel Audit/Ops Track 必须有独立 owner**,否则会直接吃掉主线吞吐

### 0.1 boss 7 大目标 → 切片映射

| # | 目标 | 主切片 | 辅助切片 |
|---|------|-------|---------|
| 1 | 数据流转更清晰 | S2 装配化、S6a/b 拆分、S8a 状态契约 | S4*, S10 |
| 2 | 问题定位更容易 | S11a Diagnostic、S11c Observability、S12 CI | S4*, S8b shadow |
| 3 | 不同模型前台 UI 稳定且统一(codex/cc) | **S10 ToolCallProtocol Unified** | S5(usage 统一)、S4*(error 统一) |
| 4 | 可扩展性更强 | S2 装配化、S10 协议化、S4 RemoteAgentError | S6a/b |
| 5 | 系统更稳定 | S5 shadow、S7a durable、S8a/b/c reconciler | S11d Release Safety |
| 6 | 运维能力更强 | **S11a/b + S12e + S11c + S11d** (Diagnostic / Ops / trace_id min / Observability full / Release Safety) | S12b CI |
| 7 | 开发到上线更快 | **S12a/b/c/d**(第零刀拆 4 子片) | — |

**关键判断**:
- **只有 S12a**(TS 清零 + project references)是**强制前置**,挡在 S3 之前;S12b/c/d 可并行推进至 Phase A/B,不再做成 2-3 周大包
- **S12e**(trace_id/request_id 最小贯通)提前到 Phase A 早期,作为 S11a `v3 trace` / S11d 灰度判决 / Phase B/C shadow 指标的共同关联键
- **S11 运维工具同时面向 human + agent**(贯穿性约束,不是单独切片): CLI 必出 `--json` 结构化输出 + MCP server 暴露;agent 默认仅 **readonly + dry-run**,任何 mutation(`--apply`、host drain/migrate、rollback 执行)必须**穿过 human approval gate**(对接现有 OpenClaude approval 机制);principal 模型支持 `human | agent`,审计日志强制带 `principal_kind` + `agent_id`(若 agent)+ trace_id

---

## 1. 现状画像 (代码 + 60 天 git log)

### 1.1 体量

| 维度 | 数字 |
|------|------|
| commercial 包 ts 文件 | 276 |
| commercial 总行数(含 tests) | ~110k |
| gateway 总行数 | ~27k |
| web public 总行数 | ~56k |
| 60 天实质 commits(去 deploy bump) | 437 |
| 60 天 v1.0.x 发版数 | ~80(平均不到 1 天 1 个) |

### 1.2 God file 清单

| 文件 | 行数 | 主要问题 |
|------|------|---------|
| `gateway/src/server.ts` | **5969** | Gateway class + 鉴权 + 文件白名单 + 上传策略 + 路由 + WS 全揉一起 |
| `commercial/src/http/admin.ts` | 2744 | 29+ admin handler 单文件 |
| `commercial/src/ws/userChatBridge.ts` | 2692 | `createUserChatBridge` 函数 ~2000 行,管 ws transport + pool binding + billing + codex auth |
| `commercial/src/agent-sandbox/v3supervisor.ts` | 2426 | 常量 + 锁 + provision + status + GC 混在一起 |
| `commercial/src/http/anthropicProxy.ts` | 2318 | zod + rate + concurrency + abort + journal 混在一起 |
| `commercial/src/index.ts` | 2147 | `registerCommercial` 函数 ~1450 行(386→1833) |
| `web/public/modules/admin.js` | **6442** | 整个 admin 控制台单文件 |
| `web/public/modules/websocket.js` | 3332 | ws 客户端单文件 |
| `web/public/modules/main.js` | 2869 | 主入口 |

### 1.4 dev pipeline 现状(2026-05-10 实测)

| 维度 | 数字 / 状况 | 痛点 |
|------|------------|------|
| `npm run typecheck` 实测 | **72s**(1m12s),6 个 tsc 串行(protocol→storage→gateway→mcp-memory→cli→commercial) | 改一行等 1+ min;CI 上更慢 |
| TypeScript 配置 | **0 个包** 用 `composite` / `incremental` / `references` | 无增量编译、无并行,每次全量 |
| 既存 TS 错误 | `packages/storage/src/hubStore.ts` 14+ 个 TS2339(missing properties) + `sessionsDb.ts` 2 个 TS2352 | typecheck 长期红线,等于 typecheck **实际不 block 任何东西** |
| CI/CD | **`.github/workflows/` 不存在** | merge 到 master 没任何自动门;全靠本地 + `deploy-v3.sh` 一把梭 |
| 部署脚本规模 | `deploy-v3.sh` **554 行** + `bump-version.ts` 288 + `distribute-image-explicit.ts` 97 | 单脚本承担 cache-bust/cf-purge/image build/health smoke/restart 全流程,改一处影响全局,失败无断点续 |
| 测试入口 | `test = test:gateway && test:web && test:commercial` 串行 | 失败信息埋末尾,无并行 |
| Image 分发 | 一台 host 一台 host 串行 push | 跨境网络 + N 台 host 线性增长 |

**结论**: 7 大目标里 Goal 7(开发到上线更快)和 Goal 6(运维更强)都被这条 pipeline 卡死。不修这条 pipeline,其余 20 个切片每片都背全量编译 + 无 CI 的隐性税。

### 1.3 既有 plan 的执行状态

- **AUDIT_REMEDIATION_TASKS_2026-04-11.md** 16 个任务,**针对老个人版**:
  - T01 文件鉴权: **部分完成**(`/api/file` 已入 needsAuth + FILE_ALLOWED_DIRS,但 bridgeBypass 旁路待 audit)
  - T02 token in URL: **基本完成**(改 Bearer + access/refresh 双 token,access 仍存 localStorage)
  - T03 htmlpreview: **最低要求满足**(只剩 allow-scripts,无 allow-same-origin)
  - T04 上传配额: 部分(常量已加,单 token 限流/配额未做)
  - T05-T16: **基本未动**
- **CCB_ASSISTANT_REFACTOR_PLAN_2026-04-12.md** A1-A15:
  - 仅 A12 中"app.js 拆 21 模块"完成
  - 其余 14 项基本未动
- **2026-04-20 v3 fork**: 直接重起,带着上面两份 plan 的未完成部分,叠加新的多 host / docker pool / codex / 远端 nodeAgent 复杂度

**结论**: 这两份 plan 是**老个人版的债**,跟 v3 关系是间接的。本计划专注 v3 fork 之后 50 天堆出来的新债,但顺手关闭老 audit 的相关项作为平行 track(见 §3.4)。

---

## 2. 根因分类(把 60 天 fix 收敛成 6 类)

### Class A — 异步状态权威源分裂

**症状群**:
- v3 docker save\|load sha 漂移(memory: image_sha_divergence)
- codex token refresh master 端点 + cooldown 半开 actor (v1.0.115)
- v3 ensureRunning stopped/missing 统一 reprovision (v1.0.117)
- reset-cooldown 不再卡死永久态 (v1.0.86)
- NULL-bind stale recycle 加 host 守护 (v1.0.71)
- session_not_found vs session_deleted 拆分阻止 24h retry storms (v1.0.91)
- server-authoritative usage/status 字段化 (v1.0.90)
- drop legacy global uniq_ac_bound_ip_active (v1.0.55)

**根因**: 状态散布在 docker daemon、master DB、nodeAgentClient 缓存、容器自身,缺少明确的"单一真理源 + reconciler"。

### Class B — 事件循环 / 事务边界 / 幂等-重试-ack 屏障

**症状群**:
- tryAutoRebindFlush 微任务死循环(v1.0.119,finally 同步递归)
- codex token refresh 把远端 PUT 移出 PG tx 修 master event-loop wedge (v1.0.115)
- v3 master gateway pre-existing fatal uncaughtException 脆弱性 (v1.0.82)
- codex drain in-flight item handlers before emitResult — race fix (v1.0.74)
- bind 前刷新 hello 修 SESSION_NOT_REGISTERED race (v1.0.111)
- preCheck 估算 ceiling 移除(v1.0.89)

**根因**: 同步/异步边界、事务/IO 边界、ack 屏障与重连竞态、幂等键 / operation id / terminal state 缺位。**注意**: outbox 不能单独解决这类问题 — 没有 idempotency 和 retry 语义,outbox 只是把同步 bug 换成异步重复执行 bug。

### Class C — 错误模型不统一(尤其多 host)

**症状群**:
- multihost 404 双形状(memory: v3-multihost-404-error-shapes)
- file-proxy 多 host 远端容器走 node-agent tunnel (v1.0.73)
- file-proxy chunked transfer-encoding (v1.0.77) / healthz timeout 跨境 mTLS (v1.0.76)
- 跨 host readiness timeout 25s vs self 10s (v1.0.53)
- client_error 释放路径不打到账号 cooldown (v1.0.86)
- 容器→master HTTP sink 根治 server-authored 文本丢失 (v1.0.81)

**根因**: 多 host 架构下 **本地 docker / 远端 nodeAgent / cross-host file-proxy / mTLS** 几种通道各自有错误形状,没有"远端容器错误"的统一抽象层。

### Class D — 职责未分层 / God file

证据见 §1.2。**v3 fork 之后,userChatBridge.ts 和 v3supervisor.ts 从 day 1 就 ≥2000 行**,设计期"实现方案 → 单文件实现"直接落地。

### Class E — 计费 / Pricing / Usage 真理源分裂

**症状群**:
- preCheck 估算 ceiling 移除 (v1.0.89)
- codex turn 真扣费 + per-agent cost multiplier (v1.0.66)
- codex input_tokens normalize to Anthropic shape (v1.0.107)
- canonicalize firstParty model id at PricingCache.get() (v1.0.43)
- 「按会话消耗」表永远空 — Claude Code 的 metadata.user_id JSON 编码 (v1.0.41)
- 修对话响应有时显示 \$X.XXXX USD 而非 ¥X.XX (v1.0.50)

**根因**: pricing canonicalization 散落,model id 在 gateway/commercial/ledger 各处没统一入口。usage shape 不同 provider(claude / codex / deepseek)直接进 cost 计算,适配在多文件拷贝。

### Class F — 跨边界契约漂移 / Schema 版本不受控(meta-class)

**症状群**(很多其实也属于 C/E,但根因层面单独成类):
- v3-master schema 放宽 requestId (v1.0.99)
- multihost 404 双形状(C 子集)
- usage shape 不一致(E 子集)
- metadata.user_id JSON 编码兼容(E 子集)
- file-proxy chunked transfer-encoding 通道差异(C 子集)
- gateway/commercial/nodeAgent/file-proxy 错误与响应形状不齐

**根因**: 跨进程/跨包/跨 provider 的 contract 没有统一入口、版本号、回放测试。每加一种新通道(新 host / 新 provider / 新 schema 字段)都要在多个文件里追加适配,容易漏。

**与本计划的关系**: 不单独起切片;但作为治理理念在 S4(error contract)、S5(usage contract)、S2/S6(模块间 IPC contract)落地时显式定义 contract + 加 contract test。**长期**应建立"contract testing 文化"作为团队治理项,本计划暂不展开。

---

## 3. 重构切片表(25 切片,3 期 + 1 平行 audit/ops track)

### Phase A — 基建 + 基础切分 + 抽象骨架(10-12 周日历)

#### S12a. TS 错误清零 + project references ⭐⭐**Phase A 第零刀(强制前置)**
- **目标**:
  1. 修 `packages/storage/src/hubStore.ts` 14+ 个 TS2339(missing properties:hubLockfile/hubDir/hubSkillDir/hubSkillMd) + `sessionsDb.ts` 2 个 TS2352
  2. 6 个包加 `composite: true` + `references` 互引,根 `tsconfig.json` 用 `tsc --build`
- **目标值(非承诺)**: typecheck 72s → 期望 <20s,增量改一包期望 <5s。**实际数值实施后实测决定是否继续优化**(project references 可能暴露隐式跨包循环依赖、测试编译配置问题,需人工拆环)
- **收益**: typecheck 重新成为门 → 后续切片有 TS 安全网;改一行编译反馈秒级
- **风险**: 中(暴露循环依赖)
- **验证**:
  - `npm run typecheck` exit 0
  - composite 启用后实测全量 + 单包增量 wall time,记录基线
  - 跨包 import 路径无 type-only 漏写
- **大小**: 1-1.5 周
- **顺序约束**: **挡在 S3 之前**;后续切片均依赖此完成

#### S12b. CI 引入(`.github/workflows/`)
- **目标**: `ci.yml` 跑 typecheck + lint(biome)+ test(三包并行),PR 必过门
- **风险**: 中
  - **CI 引入第一周大概率红**;先用 `continue-on-error: true` **软门 1 周**观察,再切硬门
  - 第三方 action 版本钉死(防供应链)
- **验证**: CI 主分支跑通 3 次无误报;PR red 阻挡至少 1 次合理拦截
- **大小**: 1 周
- **顺序约束**: S12a 完成后启动;可与 Phase A 其它切片并行

#### S12c. deploy-v3.sh 分阶段 + image 并发分发
- **目标**: build / distribute / restart / verify 四阶段独立命令,每阶段失败可断点续;image 分发用 `p-limit` 控制并发(跨境带宽不打满);**老命令 `bash scripts/deploy-v3.sh` 一把梭仍可用,backward-compatible**
- **目标值**: 部署时间期望 ↓30-50%,实施后实测
- **风险**: 中(release skill 全靠 deploy-v3.sh,任何 incompat 全线失效)
- **验证**: 拆分后灰度 1 次正式发版健康;断点续模拟测试(故意中断 distribute 后重跑只重做未完成 host)
- **大小**: 1.5-2 周
- **顺序约束**: 可与 S12b 并行;不阻塞 Phase A/B 主线

#### S12d. release prep 一条命合并
- **目标**: `npm run release:prep` 自动跑 sw.js bump + `?v=` bump + VERSION.json bump + changelog.json append-with-approval-gate(BOSS_APPROVED_CHANGELOG=1 校验保留)
- **风险**: 低
- **验证**: 单测覆盖 bump + gate 逻辑;实际发版 1 次走完
- **大小**: 3-5 天
- **顺序约束**: 可与 S12b/c 并行

#### S12e. trace_id/request_id 最小贯通(原计划 S11c 拆出的最小子集)
- **目标**: WS frame → bridge → nodeAgent → daemon 五段透传 trace_id;deploy verify 阶段也带 trace_id;structured log 统一字段名
- **必须覆盖的标准字段**(为 S11 agent 接入 + audit chain 服务): `trace_id` / `principal_kind` / `principal_id` / `agent_id`(若 agent)/ `run_id` / `model_or_client`(若 agent)/ `human_approver_id`(若 agent mutation)/ `user_id` / `session_id` / `container_id`
- **为什么不放进 S11c**: S11a `v3 trace` 命令、S11d 灰度判决、Phase B/C shadow 指标都需要 trace_id 作为关联键 — 它是 cross-cutting 基建,必须前置
- **风险**: 中(透传缺一段就废)
- **验证**: 集成测试覆盖 5 段链路,缺段直接失败;structured log 上述字段 100% 覆盖(类型 + 出现率断言)
- **大小**: 1-2 周
- **顺序约束**: S12a 后启动,Phase A 内完成

#### S3. admin.ts 按资源分文件 ⭐**Phase A 第一刀(切片流程 PoC)**
- **当前**: 2744 行,29+ handler 单文件
- **目标**: `admin/{users,accounts,containers,pricing,plans,ledger,oauth,metrics,export}.ts`,router 按资源 mount
- **根因桶**: D
- **收益**: 维护性 + **作为整套 dev/Codex/灰度流程的 PoC**,验证之后再大切片
- **风险**: 低
- **验证**:
  - **route inventory**(自动扫描比对 mount 后端点列表零丢失,防 29+ handler 拆分时漏 mount)
  - **高风险端点 golden tests**: `adjustCredits` / `listUsers` / `exportLedger` 等钱+隐私端点输入输出固化
  - 现有 adminAccounts integ test 全过
- **大小**: 1-1.5 周(测试增量略增)

#### S2. commercial/index.ts → 装配模块化
- **当前**: registerCommercial 函数 1450 行
- **目标**: 拆成 `wireDb()` + `wireRedis()` + `wireMailer()` + `wireAccountPool()` + `wireBilling()` + `wireV3Supervisor()` + `wireHttp()` + `wireWs()` 装配函数序列;主入口只编排顺序。**只切结构,不顺手改初始化语义**。
- **根因桶**: D
- **收益**: 启动顺序可读化,任一子系统可单独 wire 测试 — **这是 S5/S6/S8 的测试入口**,所以排早期
- **风险**: 启动顺序耦合(redis 必须先于 ratelimit 等)
- **验证**: registerCommercial 集成测试 + wireXxx 单测
- **大小**: 中

#### S4a. RemoteAgentError 最小抽象 + 现有形状快照测试
- **目标**: 新增 `commercial/remoteHosts/agentError.ts` 定义 `RemoteAgentError` + `classifyRemoteError(err)`,枚举 `{ kind: 'not_found' | 'unauthorized' | 'unavailable' | 'timeout' | 'transport' | 'unknown', cause }`。**只定义类型 + 给 4 种通道(local docker / nodeAgent http / cross-host tunnel / mTLS)写形状快照测试**。不替换调用点。
- **根因桶**: C / F
- **收益**: 给 S4b/S4c/S6/S8 共用抽象;通过 snapshot test 把现状形状钉住,后续才能安全替换
- **风险**: 低(纯新增 + 测试)
- **验证**: 4 通道 snapshot test
- **大小**: 1 周

#### S1a. gateway/server.ts 纯逻辑提取(不动 mount 顺序)
- **目标**: 把 `auth/needsAuth/checkHttpAuth/bridgeBypass`、`fileServe/FILE_ALLOWED_DIRS/isFileAllowed/isFileBlocked`、`uploads/MAX_UPLOAD_*/MIME helpers` 提到 `gateway/{auth,fileServe,uploads}.ts`,**Gateway class 内部仍然按原顺序调用**,不重排路由。
- **根因桶**: D
- **收益**: 给 S1b 让出空间;为 audit T01 bridgeBypass 旁路收尾、T04 配额收尾创造条件
- **风险**: 中(行为对齐;需要审 bridgeBypass 旁路逻辑 line 2098-2126)
- **验证**: 现有 gateway tests 全过 + bridgeBypass 单元覆盖
- **大小**: 中(2 周)

### Phase B — 抽象层接入 + 高频路径拆分(6-8 周日历)

#### S5. pricing/usage 真理源统一 ⭐**业务风险最高,必须 shadow**
- **目标**:
  - PricingCache.get() 改为唯一 model id canonicalize 入口
  - 引入 `NormalizedUsage` 内部规范化结构,所有 provider(anthropic / codex / deepseek)进 normalizer 后再进 cost calculator
  - **必须**: 历史 ledger 回放对账 + shadow calculate(新旧并行,差异打 metric,不直接改账) + 差异阈值 + 人工抽样 + 至少 2 周观察期
- **根因桶**: E / F
- **收益**: 消除 USD vs 积分、各路 model id mismatch、metadata.user_id JSON 编码 一整波
- **风险**: **中(业务风险高)** — 钱相关
- **验证**: provider × usage shape 矩阵单测 + ledger 历史数据回放 + shadow 阶段差异告警
- **大小**: 中-大

#### S4b. RemoteAgentError 接入高频路径(1-2 条)
- **目标**: 选 file-proxy multi-host + ensureRunning 这两条最高频路径,把错误识别替换为 `classifyRemoteError`;旧分支保留 fallback,新旧并行 1 周观察
- **根因桶**: C
- **收益**: 验证抽象覆盖度,暴露漏掉的形状
- **风险**: 中
- **验证**: 现有相关 tests + 灰度观察
- **大小**: 1-2 周

#### S4c. RemoteAgentError 批量替换
- **目标**: 把剩余调用点(cross-host operations、cooldown 释放、readiness、HTTP sink)统一替换;移除 fallback 旧分支
- **根因桶**: C
- **风险**: 低-中(S4a/S4b 跑稳后)
- **大小**: 中

#### S6a. userChatBridge transport/binding 拆分
- **目标**: `bridge/transport.ts`(byte pipe + close code + frame size guard) + `bridge/binding.ts`(ensureRunning + endpoint resolve + maintenance gate)。billing/codexAuth 留在原文件
- **根因桶**: D(顺便给 Class B 微任务问题让出可识别边界)
- **收益**: 高频路径开始拆,但每次只动 2 个责任域,回归更易定位
- **风险**: 中
- **验证**: 现有 userChatBridge.test.ts 1300 行 pass + 新 transport/binding 独立 test
- **大小**: 中

#### S6b. userChatBridge billing/codexAuth 拆分(对齐 S5/S7)
- **目标**: `bridge/billing.ts`(preCheck + finalize + release,直接接 S5 的 `NormalizedUsage`) + `bridge/codexAuth.ts`(token refresh + write auth file,准备对接 S7 试点)
- **根因桶**: D
- **风险**: 中
- **大小**: 中

#### S1b. gateway httpRoutes / wsRoutes / Gateway 装配拆分
- **目标**: 路由分文件,Gateway class 改为只持有装配 + lifecycle;路由顺序仍然显式写出
- **根因桶**: D
- **风险**: 中
- **大小**: 1-2 周

#### S10. ToolCallProtocol Unified — codex/cc 工具调用 UI 统一 ⭐**Goal 3 主切片**
- **背景**: 现状有两条独立 emit 路径 + 三套独立 meta 表 + 一个 dispatch 分叉
  - 后端: `gateway/src/codexAppServerRunner.ts` 把 codex ThreadItem 包成 `tool_use` 名为 `codex:<itemType>` 走 `emitAssistantToolUse` ;cc 路径走 `ccbMessageParser.ts` 直出原生 `tool_use`
  - 前端: `web/public/modules/messages.js` `_renderToolBody` 先 switch CC 名(Bash/Edit/Read/...),fallthrough 解析 `codex:` 前缀走 `_renderCodexItem`,再 fallthrough `mcp__` 走 `_renderMcpOp`;`_TOOL_META` / `_CODEX_TYPE_META` / `_MCP_OP_META` 是 3 套独立常量表,字段不一致
  - 历史漂移: messages.js 注释 `Lowercase prefix is required (gateway emits lowercase as of v1.0.65)` 即两端契约靠版本兼容硬扛
- **范围严格限定**: **UI presentation protocol**(展示协议),**不是** provider/tool 的 canonical execution protocol。第一版**只统一展示壳和渲染管线**,**不强迫**三路 emit 把执行语义压成同一种业务模型。Read/Edit/Bash 这类"同义操作"的 semantic 收敛留作可选后续层。
- **与 agent 消费的边界(v2.3 补充)**: S10 `UnifiedToolCallView` **只负责展示**,**不是 agent 可执行语义,也不是 ops approval 依据**。Agent 通过 MCP 拿到的工具调用结果走 `protocol/opsApi.ts` schema(S11 定义);ops approval 必须以 `ops_pending_operations` 中的 plan 为唯一权威源,不消费 S10 的展示结构。两条协议互不替代。
- **目标**:
  1. 定义 `protocol/toolCall.ts` `UnifiedToolCallView { kind: 'cc' | 'codex' | 'mcp', name, status, title, summary, durationMs?, error?, raw, providerPayload }` — **保留 `raw` + `providerPayload` 完整透传**,只抽取展示需要的公共字段
  2. **后端**: cc/codex/mcp 三路 emit 在原有 wire format 之外**新增 `unified_view` 字段**(envelope 模式),前端 capability negotiate;**旧 wire format 长期可读**,只承诺停止"新写入"旧结构,不承诺短期删除读取能力
  3. **前端**: `messages.js` 引入 `_renderUnifiedView(view)`,内部 `kind` switch 选 renderer 但**共享 80% UI 壳**(标题、状态条、错误条、耗时、复制按钮);老数据通过 **legacy adapter** 注入 `unified_view` 兼容,不强行改老数据结构
  4. meta 表合并为 `protocol/toolMeta.ts`,但 codex/cc/mcp **保留各自命名空间**,只共享 icon/displayName/summarizeInput 接口签名
- **根因桶**: D / F(跨边界契约 — Class F 第一个落地点)
- **收益**(Goal 3 + Goal 4):
  - 同一种语义在 codex 和 cc 模型下**视觉壳一致**(标题/状态/错误/耗时/折叠行为);深层语义解读各自保留
  - 新接入模型只需提供 `unified_view` envelope,**不必**改造执行语义就能复用 80% UI
  - 减少 messages.js god file 一大块(目前 2218 行,工具渲染估算 ~600 行)
- **风险**: 中
  - **历史回放兼容**: 解法是 legacy adapter 长期可读,而不是"保留旧 wire 仅一个版本"(后者会变成时间炸弹)
  - codex item 类型谱比 cc tool 谱更杂(thread/turn/cmd/file_read/tool_call 等嵌套),unify view 时**不强压执行语义**,只取展示信息
- **验证**:
  - **Semantic DOM snapshot**(不要求 byte-level): 关键节点结构 + class 集合 + 文本内容一致;无关字段(时间戳/uuid/order)忽略
  - 视觉关键截图人工审 + render error count = 0 作为硬指标
  - 历史会话 replay 至少 100 条 cc + 100 条 codex,无 render 异常
  - 接入一个新 mock provider,confirm 不需要改 messages.js renderer 主路径
- **大小**: 中-大(2-3 周,后端 envelope + 前端 + legacy adapter)

### Phase C — 状态模型 + 选择性 outbox(4-6 周日历)

**关键调整**: **不做"全局 outbox"**,不做"一次性接管所有 lifecycle"。先把状态模型读懂、shadow 验证、再选高价值路径接管。

#### S8a. ContainerStateModel — 状态契约
- **目标**: 写 `compute-pool/stateModel.ts` 明确 desired/actual/observed/terminal/transient 状态;把散布在多文件的状态判断按这个契约重新命名(不改行为,只统一术语)
- **根因桶**: A / F
- **收益**: 让"状态漂移"有共同语言,后续讨论修复用同一套词
- **风险**: 低(纯定义)
- **大小**: 1 周

#### S8b. ContainerStateInspector — Read-only shadow authority
- **目标**: 实现 `compute-pool/stateInspector.ts` 提供 `getDesired(uid)` / `getActual(uid)` / `diff(uid)`;**只读,不执行修复**;在 ensureRunning / cooldown reset / image sha guard 等热点旁挂 shadow 调用,产出 diff metric 和告警
- **根因桶**: A
- **收益**: 收集真实漂移点;**先证明读得对,再决定改得动**
- **风险**: 低-中
- **验证**: 至少 1 周 shadow 数据 + 与现有 hotfix 类型对照
- **大小**: 中

#### S7a. tx-内 remote IO 审计 + codex token refresh durable side-effect 试点
- **目标**:
  - 全 commercial grep `tx(`/`BEGIN` 调用,产出 tx 内 remote IO 清单
  - 选**最高危的 codex token refresh** 做单点 durable 改造(可以是简化版 outbox,也可以是"先标 dirty + 异步 actor 推送")
  - 引入 idempotency key + operation id + terminal state(success / failed-permanent / pending-retry),不做全局 outbox 框架
- **根因桶**: B
- **收益**: 消除 token refresh 类 wedge,验证 durable 模式;留下"是否扩大"的判断依据
- **风险**: 中
- **验证**: 故意慢 remote 模拟 master 不 wedge + token refresh 幂等单测
- **大小**: 中

#### S8c. ContainerStateAuthority — 第一个 mutation path 接管
- **目标**: 选**最痛的 ensureRunning stopped/missing 路径**,从 inspector 升级为 authority,由 stateModel 驱动 reprovision 决策;其它 mutation 仍走旧逻辑
- **根因桶**: A
- **收益**: 实测 reconciler 模式价值;之后再决定要不要扩大
- **风险**: 高(动 lifecycle 核心,但范围已收窄到单 path)
- **验证**: ensureRunning 单元覆盖 + drain-migration e2e + 灰度先单 host
- **大小**: 中

### Parallel Audit / Ops Track(与上面三期并行,**不阻塞 phase 推进**)

#### S9. 老 audit P0/P1 收尾(选定项)
- audit T04 上传配额(单 token 限流 / 配额统计 / 上传目录清理)
- audit T07 流式渲染节流(rAF / 50-100ms batch / sidebar 低频刷新)
- audit T05/T06/T08/T11 待 v3 web 重写决策再处理
- 其余 audit P2/P3 项明文 deprecate(在 audit 文档加 status note)
- **根因桶**: 历史
- **风险**: 低-中
- **大小**: 中(分散在 8-12 周内执行)

#### S11a. Ops — Diagnostic 工具链 ⭐**Goal 6 第一刀**(human + agent 双面向)
- **现状**: 用户卡住时,定位流程靠人手 SQL — 查 `agent_containers` + `compute_hosts` + `sessions` 三表 join,核对 `bound_ip` 是否在 host `bridge_cidr` 网段;memory 里 `feedback_diagnosis_topology_first.md` 已经把这条总结成规范但每次还是手敲
- **目标 — human 面向**:
  - 新增 `packages/cli/src/commands/topo.ts`: `v3 topo --user <id>` 一条命列出 user → sessions → containers → host → bound_ip → bridge_cidr → status,自动标红 cidr 错位 / NULL bind / cooldown 卡死
  - `v3 inspect --container <id>` 输出 master 视角 desired + nodeAgent 视角 actual + docker 视角 observed,三路 diff
  - `v3 trace --request <reqId>` 串联 master + bridge + nodeAgent + daemon 全程日志(依赖 **S12e** 的 trace_id 贯通)
  - 默认 TTY 表格输出,着色 + 标红
- **目标 — agent 面向**(贯穿约束落地):
  - **三条命都必须支持 `--json` 结构化输出**,字段名稳定 + schema 版本号 (`schemaVersion: 'v1'`)
  - **新增 MCP server**: `packages/v3-ops-mcp/`(参考 `packages/mcp-memory` 模式)暴露 `topo / inspect / trace` 三个 readonly tool,agent 通过 MCP 调用得到结构化 JSON
  - 全部三命 **readonly,无 mutation**,因此 agent 默认放行,无需 approval gate
  - 输出 schema 在 `protocol/opsApi.ts` 集中定义 + zod 校验,human 侧渲染器和 agent 侧 MCP 共用同一 schema
- **根因桶**: 运维(独立类别)
- **风险**: 低
- **大小**: 中(纯 readonly,但 MCP 接入是新工作量)
- **顺序约束**: `v3 trace` 子命依赖 **S12e** 完成;MCP 暴露依赖 schema 在 `protocol/` 包定义完成

#### S11b. Ops — Operations 流程脚本化(human + agent 双面向,**mutation 必须 human approval gate**)
- **现状**: `v3-host-pool-drain-migration` skill 6 phases,全靠人手敲 PG SQL + ssh + docker;memory 中已确认这套流程失效成本高
- **目标 — human 面向**:
  - `v3 host drain <name>` / `v3 host migrate <from> <to>` / `v3 host quiesce <name>`,统一封装那 6 phases
  - 强制 `--dry-run` 默认,`--apply` 才执行;每步打印 will-affect users + containers + volume size
  - id-snapshot + INSERT trigger 防 race detection 模式从 skill 提取成代码,不再每次重写
- **目标 — agent 面向**(本切片最敏感的 agent 接入面):
  - MCP server 暴露 `host_drain / host_migrate / host_quiesce` 三个 tool
  - **agent 调用 = 强制 dry-run,无论是否传 `--apply`**: agent 永远只能产出 plan + diff,不能直接 mutation
  - **mutation 必须经 human approval gate**: agent 调 dry-run → 产出 `OperationPlan { id, principal: agent_id, command, args, diff, willAffect }` → 落 `ops_pending_operations` 表 → 通过现有 OpenClaude approval channel(Telegram / Web push)推给 human → human 审完点确认按钮,后端用 `OperationPlan.id` 真正执行
  - 同一个 plan 不可重复 apply(operation id 幂等);expire 30 分钟后**只能 refresh / re-dry-run 生成新 plan**,**不支持人工延期**(stale diff/willAffect 继续可执行是漏洞)
  - approval 后的执行仍走相同 5 项生产安全保险(下方),principal 链记录 `agent_id → human_approver_id`,审计 100% 带 `principal_kind` / `agent_id` / `run_id` / `model_or_client` / `human_approver_id` / `trace_id`
- **生产安全约束**(human 和 agent mutation 都过这 5 项,不是 nice-to-have 是硬要求):
  - **RBAC**: 命令调用必须验证 principal(human admin auth 或 agent token);未授权拒绝 + 审计;principal 模型 = `{ kind: 'human' | 'agent', id, displayName }`
  - **审计日志**: 每次执行(含 dry-run + agent 调用)落 `ops_audit_log` 表 — `principal_kind` / `principal_id` / `agent_id` / `run_id` / `model_or_client` / `human_approver_id` / `command` / `args` / `diff` / `timestamp` / `result` / `trace_id`,**不可篡改 append-only**
  - **幂等 operation id**: 每条命令生成 UUID,重复提交识别为重试,不重复执行 mutation;agent dry-run 产出的 plan id 即 operation id
  - **并发锁**: 同一 host / 同一 user 上的 mutation 互斥,通过 PG advisory lock 实现
  - **可恢复步骤记录**: 多步骤命令(如 migrate)每步状态写库,中途失败可从断点续行,不全部重做
- **根因桶**: 运维
- **风险**: 中-高(操作真实生产数据,**agent 调用面是新增风险面 — LLM 误调或 prompt injection 触发危险命令** — approval gate + 强制 dry-run 是核心防线)
- **大小**: 大(approval gate 接入 + agent identity 建模显著增加工作量)

#### S11c. Ops — Observability 完整层(metric + structured log,human + agent 双面向)
- **注意**: trace_id 最小贯通已**前置到 S12e**,本切片只做完整可观测性层,**依赖 S12e 完成**
- **目标 — human 面向**:
  - 日志全面结构化(`pino` 或现有 logger 加 S12e 定义的全部标准字段:`trace_id`/`principal_kind`/`principal_id`/`agent_id`/`run_id`/`model_or_client`/`human_approver_id`/`user_id`/`session_id`/`container_id`),覆盖 commercial/gateway/storage 全部模块
  - Prometheus exporter 拉关键计数器: `usage_finalize_failed_total`、`image_sha_drift_detected_total`、`reservation_orphan_total`、`bridge_wedge_detected_total`、`token_refresh_pending_total`
  - 把 §2 6 类根因每类挑 1-2 个关键 metric,作为复盘事故的硬指标
  - 接 Grafana dashboard 模板(参考 v3-commercial-deploy skill)
- **目标 — agent 面向**:
  - MCP server 暴露 `query_metrics(query, range)` + `query_logs(filter, range)` readonly tool
  - 全部 readonly,agent 默认放行无需 approval
  - 对 LLM 友好的输出格式: metric 结果带单位 + 时间序列摘要(min/max/p50/p95/p99),log 结果分页 + 总命中数
  - 输出量保护: agent 单次查询 hard cap(metric 1k 数据点 / log 200 条),超量返回 truncated 标记
- **根因桶**: 运维 / Class F(契约可观测性)
- **风险**: 低-中
- **大小**: 中-大(2-3 周 + agent MCP 接入)

#### S11d. Ops — Release Safety 灰度框架(human + agent 双面向,自动判定 + 人工确认 rollback)
- **现状**: deploy-v3 是全量推所有 host,失败靠人手 rollback
- **目标 — human 面向**:
  - 灰度框架: 按 `host` 分桶(canary host → 50% → 100%)、按 `user` 分桶(beta users 优先)
  - **自动判定信号**(不直接执行回滚): `healthz` 失败 / `error_rate` 突增超阈值 / `usage_finalize_failed` 突增 → **自动生成 rollback plan(候选命令 + 影响面 + diff)**,**人工确认后才执行**;同时 alert PagerDuty/Telegram
  - 对接 S12c 的 deploy-v3.sh 拆分(verify 阶段对接监控,自动判决是否 advance 到下一桶 — advance 是默认安全方向,所以可以自动;rollback 不是)
  - **真实自动 rollback 不在本计划范围**: 触发逻辑先 dry-run 1 个月,确认阈值合理后再作为**独立后续决策**讨论是否启用
- **目标 — agent 面向**:
  - MCP server 暴露 `release_status / canary_progress / rollback_plan_inspect` readonly tool — agent 可查灰度进度、查当前是否有待 approval 的 rollback plan、查 plan 详情
  - **Agent 与 advance/rollback mutation 的边界(明确)**:
    - **自动 advance 只能由 server-side release controller** 基于固定阈值执行,**不能由 MCP/agent path 触发**
    - **任何主动 advance/rollback 请求(无论 human 还是 agent 发起)均视为 release mutation**,统一走 S11b approval gate(ops_pending_operations + human approval),**不存在 agent 的"快速 advance"通道**
    - agent MCP tool **没有 advance/rollback 入口**,只暴露 readonly + 主动告警(通过 OpenClaude 通知通道 push 给 boss): "灰度第 2 桶 error_rate 异常,已生成 rollback plan id=xxx,需要审批"
- **根因桶**: 运维
- **风险**: 中(自动 rollback 误触发也是事故,所以本切片不做;agent 仅 readonly + alert,无 mutation 风险)
- **大小**: 中(2 周)
- **顺序约束**: 依赖 S11c metric + S12c deploy 拆分 + S12e trace_id + S11b approval gate 模式

---

## 4. 风险与约束

1. **重构期不停发新功能,但放慢** — 商用线上有付费用户。每个切片必须 dev instance + Codex 双审 + 灰度
2. **每个切片必须独立发布并独立回滚**。Phase B/C 的切片必须等 Phase A 抽象骨架稳定再上
3. **Phase 之间留 1 周稳定期看 monitor**,避免改造期 hotfix 在未稳定的新结构上又起雪球
4. **测试投入**: commercial 测试 ~17k 行(占代码 ~15%),但 lifecycle / state authority 状态机测试稀薄,Phase C 必须配套补
5. **过度工程红线**:
   - **不做全局 outbox 框架**(只做单点 durable side-effect)
   - **不做一次性接管所有 lifecycle**(先 shadow 再 mutation)
   - **不在 S4 第一版替换所有调用点**(先定义 + 测试,再分批替换)
   - **S5 必须 shadow**,不直接切真账
   - **S10 第一版仅引入 Unified 协议,不删除老 wire format**(避免历史会话回放炸)
   - **S12 CI 第一周软门**(`continue-on-error: true`)再切硬门,避免一上来一片红卡住所有 PR

6. **Agent 接入安全红线**(S11 贯穿约束):
   - **Agent 永远不能直接 mutation**: 任何会改数据库 / docker 状态 / host 拓扑 / release 状态的命令,agent 调用强制 dry-run,产出 plan 落 `ops_pending_operations`,经 human approval gate 后由后端执行
   - **Agent 默认 readonly**: 只有显式标注 `safe: 'readonly'` 的 MCP tool 才暴露给 agent;readonly 的反义不是默认放行,而是**默认拒绝 + 显式白名单**
   - **Agent identity 是独立 service principal,不是 human session 复用**:
     - principal model 严格 `{ kind: 'human' | 'agent', id, displayName }`
     - **认证最低线**: 短 TTL(≤1h)signed token + audience(限定 v3-ops-mcp endpoint)+ scope(限定 agent 可见 tool 集合)+ run_id(本次 agent 会话标识)
     - **生产优先**: mTLS / workload identity(对接现有 OpenClaude mTLS 体系,boheyun 18443 已是 mTLS endpoint 模式可参考)
     - **不得复用 human session/token**: agent 与 human 是不同 principal,审计 100% 带 `principal_kind`、`agent_id`、`run_id`、`model_or_client`(哪个 LLM/agent 应用调用的);mutation 链记录 `agent_id → human_approver_id`
   - **Approval plan 时效**: agent 产出的 plan 30 分钟过期,**过期后只能 refresh / re-dry-run 生成新 plan(重新计算 diff、重新审批)**;**不支持人工延期**(stale diff/willAffect 继续可执行是漏洞);同一 plan id 不可重复 apply
   - **Prompt injection 防御**: agent 调用参数走 zod 严格校验,host name / user id 等关键字段限定枚举或正则,不接受自由文本
   - **Rate limit 多维度**(只限 agent_id 不够):
     - 维度: `agent_id` × `tool/command` × `target_resource(host/user/release)` × time window(分钟/小时)
     - 全局 breaker: 单位时间内全局 mutation plan 生成上限,触发后 ops MCP 整体降级为只读
     - 防止单 agent 高频打 observability 查询、重复生成 pending plan、集中打单 host/release

### 4.5 测试覆盖策略矩阵(每片绑定具体测试形态)

| 切片 | 测试形态 | 强度 | 为什么必须这种 |
|------|---------|------|--------------|
| **S12a** TS + references | typecheck exit 0;实测 wall time 记录基线(不写承诺值) | 硬门 | 基建正确性 |
| **S12b** CI | 主分支跑通 3 次;先软门(continue-on-error)1 周再硬门 | 软门→硬门 | 第一周大概率红,避免卡死所有 PR |
| **S12c** deploy 拆分 | 灰度 1 次正式发版健康;断点续模拟测试 | 硬门 | release skill 全靠它 |
| **S12d** release prep | bump+gate 单测 + 实际发版 1 次 | 硬门 | 发版仪式正确性 |
| **S12e** trace_id | 5 段链路集成测试,缺段直接失败;structured log 关键字段 100% 覆盖 | 硬门 | 后续 ops/灰度/shadow 都依赖它 |
| **S3** admin 拆分 | **route inventory**(自动扫描比对 mount 后端点列表零丢失)+ **高风险端点 golden tests**(adjustCredits/listUsers/exportLedger 等钱+隐私 endpoint 输入输出固化)+ 现有 adminAccounts integ test 全过 | 硬门 | 29+ handler 全部 e2e snapshot 过重,改用 inventory+高风险端点 |
| **S2** 装配化 | 现有 `registerCommercial` 集成测试 + 每个 `wireXxx` 单测启动顺序断言 | 硬门 | 启动顺序是隐性契约 |
| **S4a** RemoteAgentError 类型 | 4 通道(local docker / nodeAgent / cross-host tunnel / mTLS)**形状 snapshot 测试** | 硬门 | 钉住现状,后续 S4b/c 才能安全替换 |
| **S4b/c** 错误替换 | snapshot diff 双跑(老分支 fallback vs 新 classifyRemoteError) | 硬门 + 灰度 1 周 | 错误是隐藏分支,易漏 |
| **S5** Pricing 真理源 | **Shadow calculate 2 周**(只读不写)+ ledger 全量 replay,差异 > 0.01 cent 报警;provider × usage shape 矩阵单测 | **mandatory** | 钱不能错,boss 已批 |
| **S6a/b** userChatBridge 拆分 | 现有 `userChatBridge.test.ts` 1300 行 pass + 新 transport/binding/billing/codexAuth 独立单测 | 硬门 | 已有覆盖,拆分必须不退化 |
| **S1a/b** gateway 拆分 | 现有 gateway tests 全过 + bridgeBypass 单元覆盖(line 2098-2126 历史漏洞口) | 硬门 + audit | bridgeBypass 是已知风险点 |
| **S10** ToolCallProtocol Unified | **Semantic DOM snapshot**(关键节点结构 + class 集合 + 文本一致,无关字段忽略)+ 视觉关键截图人工审 + render error count = 0 + 历史会话 replay ≥100 cc + 100 codex + mock provider 接入测试 | 硬门(语义层) | byte-level 易被时间戳/uuid/order 卡死,改语义层 |
| **S7a** Codex token refresh durable | **故障注入测试**(refresh 中途 kill / tx commit 后 nodeAgent 中断)+ 恢复后自动续行 + 幂等单测 | 硬门 | 真实事故场景重放 |
| **S8a** 状态契约 | 状态枚举命名扫描 + grep 跨文件命名一致性 | 软门 | 纯定义层 |
| **S8b** Inspector shadow | shadow 至少 1 周数据 + 与现有 hotfix 类型对照,desired/actual diff 分布报告 | 硬门 + 观察 1 周 | 先证明读得对再改 |
| **S8c** Authority 单 path | ensureRunning 单元覆盖 + drain-migration e2e + 灰度先单 host 1 周 | **mandatory** + 灰度 | lifecycle 核心 |
| **S9** 老 audit 收尾 | 各 audit 项原 acceptance criteria | 单项 | 历史 |
| **S11a** Diagnostic | dry-run 输出 snapshot(human TTY + `--json` 双格式)+ MCP tool schema 校验 + zod parse 反序列化 round-trip | 软门 | 工具类,易迭代 |
| **S11b** Operations | dry-run 必经 + e2e 用 Boheyun 次要 host 演练 + RBAC 拒绝测试 + audit log 落库验证 + advisory lock 并发冲突测试 + 中断续行测试 + **agent-call 矩阵**(强制 dry-run / mutation 必走 approval gate / 30min expire 只能 re-dry-run 不能延期 / 重复 apply 拒绝 / rate limit 多维度 by `agent_id × tool × target × window` + 全局 breaker / agent token 不可复用 human session) | **mandatory** dry-run + 5 项硬保险 + agent gate | 真实生产数据,误操作灾难;agent 接入是新风险面 |
| **S11c** Observability | structured log 关键字段覆盖率 + prometheus exporter 单测 + Grafana dashboard 模板渲染过 + agent query 输出量上限测试(超量 truncated)+ schema 版本号兼容测试 | 硬门 | 可观测性本身要可观测 |
| **S11d** Release Safety | canary 灰度仿真(注入 healthz 失败,确认**自动生成 rollback plan + alert 触发**)+ 阈值灵敏度测试(过度敏感 / 漏报)+ **agent cannot trigger advance**(MCP tool 列表无 advance 入口 + 通过任何形式构造 advance/rollback request 都被 approval gate 拦)+ release controller 触发自动 advance 路径不依赖 MCP | **mandatory** + 故障注入 | 自动判定要准但不直接执行;agent advance/rollback 通道必须不存在 |

**总体原则**: 每片 PR 不带对应测试形态,**Codex 一审直接打回**,不进入实施阶段。

---

## 5. 给 boss 的决策点

1. **资源预算稳健档 24-36 周 / 乐观档 18-26 周 + 新功能 -45%~-65% 节奏**(Codex 二审建议,Parallel track 必须有独立 owner 否则吃主线)— 是否接受稳健档?
2. **只有 S12a 强制前置**(TS 清零 + project references)挡 S3 之前;S12b/c/d/e 可与 Phase A 主线切片并行 — 是否接受?
3. **是否启用 Parallel Audit/Ops Track**(S9 老 audit + S11a-d 运维)+ 是否分配独立 owner?(建议: 启用 + 必须独立 owner)
4. **是否先做 S12a + S3 双 PoC 验证整套流程**,再启动后续切片?(强烈建议: 是)
5. **S5 业务风险最高,是否同意必须 shadow + 2 周观察后再切真账**?(强烈建议: 同意)
6. **Phase C 是否同意"shadow + 单 path 试点"的保守路线**,而不是大规模 reconciler 接管?(强烈建议: 同意)
7. **S10 范围严格限定为 UI presentation protocol**,保留 raw/providerPayload + 旧 wire format 长期可读 + legacy adapter,**不强压执行语义** — 是否接受?(强烈建议: 同意)
8. **S11d 本计划只做"自动判定 + 自动生成 rollback plan + 人工确认执行"**;真实自动 rollback 作为后续独立决策(dry-run 1 个月后再讨论)— 是否接受?(强烈建议: 同意)
9. **S11b 5 项生产安全约束**(RBAC/审计日志/幂等/并发锁/可恢复)是否接受作为硬要求?(强烈建议: 同意,运维工具误操作风险高)
10. **S11 工具同时面向 human + agent**,agent 默认 readonly + 任何 mutation 必须 human approval gate(对接 OpenClaude approval channel),principal 模型 `{ human | agent }` + audit chain `agent_id → human_approver_id` — 是否接受?(强烈建议: 同意,LLM 误调和 prompt injection 是真实威胁)

---

## 6. 不在本计划范围

- 不做新功能(webhook automation / OpenAI-compatible API / standing orders 等 CCB_ASSISTANT_REFACTOR_PLAN 后段)
- 不重写 docker / nodeAgent 协议(只在其上加抽象层)
- 不更换前端框架(web 端债另立专题)
- 不做 multi-region / 异地灾备
- 不建立完整的 contract testing 文化(Class F 治理项,长期投入)

---

## 7. 下一步

1. **boss 拍板 v2.1** — 是否启动、Phase 边界、Parallel Audit/Ops Track 是否启用 + 是否分配独立 owner、稳健档 24-36 周是否接受
2. boss OK 后,**Codex 三审 v2.1**,确认 5 blocker + 3 nit 的修订全部到位
3. boss + Codex 都 OK 后,开 **S12a**(修 14+ TS 错误 + project references)的具体 plan,走 CLAUDE.md plan→codex→implement→codex 流程
4. S12a 完成(typecheck 重新成为门 + 实测 wall time 基线),启动 **S3 admin 拆分** PoC + 并行启动 S12b CI 软门 + S12e trace_id 最小贯通
5. S3 落地稳定 ≥ 1 周后,启动 S2;S12c/d 可在此期并行

---

## 8. Codex 评审采纳要点

### 8.1 一审(Phase 0 草稿)— **全部采纳**

Codex 反馈整体在帮我刹车防止过度工程,符合 boss CLAUDE.md "三行直白代码胜过过早抽象" 原则。

| 草稿原方案 | Codex 建议 | 修订采纳 |
|----------|-----------|---------|
| 5 类根因 | 加 Class F 跨边界契约漂移;B 内细化 idempotency | 已加 F + B 已细化 |
| S1 一次拆完 5969 行 | 拆 S1a(纯逻辑提取)+ S1b(路由+装配) | 已拆 |
| S4 一次替换所有调用点 | S4a 定义+快照 / S4b 1-2 高频路径 / S4c 批量 | 已三段 |
| S5 风险标低 | 风险升中 + 必须 shadow + ledger 回放 | 已升中 + 强制 shadow |
| S6 一次拆 4 责任 | S6a transport/binding / S6b billing/codexAuth | 已拆 |
| S7 全局 outbox + 全 tx 禁止 remote IO | 改成审计清单 + codex token refresh 单点 durable;不做全局 outbox 框架 | 已改 |
| S8 一次性 Authority | S8a 状态契约 / S8b read-only shadow / S8c 单 path 接管;先 inspector 名再 authority | 已三段 + 改名 |
| S9 排在 Phase D | 提为 Parallel Audit Track,不阻塞主 phase | 已改 |
| Phase 顺序 S7→S8 | 改为 S8a/b → S7a → S8c | 已倒序 |
| 风险预算 12-16 周 | 改为核心 12-16 周 / 实际日历 16-24 周 / 新功能 -40%~-60% | 已调整 |
| S3 排在 Phase A 中段 | 提到第一刀作为流程 PoC | 已提前 |
| S2 排序 | 早期保留,但只切结构不顺手改初始化语义 | 已加注 |

### 8.3 四审(v2.3 增量 — boss 加 "S11 工具要给 agent 用" 贯穿约束)— **3 blocker + 2 nit,全部采纳,产出 v2.4**

v2.3 在 v2.2 基础上加入 S11 human + agent 双面向贯穿约束,Codex 四审 3 blocker + 2 nit 全部采纳:

| Codex 四审反馈 | 严重性 | 修订采纳 |
|--------------|-------|---------|
| S11d advance 边界不清晰(agent 不能 advance,但自动 advance 路径未明确不依赖 MCP) | blocker | 明确"自动 advance 只能由 server-side release controller 基于固定阈值执行,不能由 MCP/agent 触发";任何主动 advance/rollback 请求(无论 human/agent 发起)统一走 S11b approval gate;agent MCP 不暴露 advance/rollback 入口;测试矩阵补 `agent cannot trigger advance` 具体形态 |
| principal 仅 token 偏弱,有冒充风险 | blocker | 改"agent 是独立 service principal";最低线短 TTL(≤1h)signed token + audience + scope + run_id;**生产优先 mTLS / workload identity**(对接现有 OpenClaude mTLS,boheyun 18443 可参考);审计 100% 带 `principal_kind` / `agent_id` / `run_id` / `model_or_client` / `human_approver_id`;不可复用 human session/token |
| rate limit 仅按 agent_id 不够 | blocker | 多维度: `agent_id` × `tool/command` × `target_resource` × time window;加全局 breaker(单位时间内全局 mutation plan 上限,触发后 ops MCP 整体降级只读) |
| 30min expire 不应支持人工延期(stale diff 漏洞) | nit | 改"过期后只能 refresh / re-dry-run 生成新 plan,重新计算 diff 重新审批";同步 S11b 描述 + 测试矩阵 |
| S10 在 v2.3 后需要补 agent 边界注释 | nit | S10 加注:`UnifiedToolCallView` 只负责展示,**不是 agent 可执行语义,也不是 ops approval 依据**;agent ops 走 `opsApi.ts` schema + `ops_pending_operations` plan |
| S12e/S11c 日志字段需覆盖 principal/agent 链路 | nit | S12e 标准字段列表追加 `principal_kind` / `principal_id` / `agent_id` / `run_id` / `model_or_client` / `human_approver_id`;S11c 同步引用 S12e 完整字段集 |

### 8.2 二审(v2 增量)— **5 blocker + 3 nit,全部采纳,产出 v2.1**

| Codex 二审反馈 | 严重性 | 修订采纳 |
|--------------|-------|---------|
| S12 过大,5 件事不应一刀做 | blocker | 拆 S12a(TS+references,强制前置)/ S12b(CI 软门→硬门)/ S12c(deploy 分阶段)/ S12d(release prep)/ **S12e(trace_id 最小贯通,从 S11c 拆出来)** |
| S10 应是 UI presentation protocol,不要变成 canonical execution protocol | blocker | 保留 `raw + providerPayload`,只抽展示字段 `kind/name/status/title/summary/duration/error`;executor semantic 收敛留作可选后续层 |
| S10 旧 wire format "保留仅一个版本"是定时炸弹 | blocker | 改"长期可读 + legacy adapter,只承诺停止新写入,不承诺短期删除读取能力" |
| S11d 本计划不应做真实自动 rollback | blocker | 改"自动判定 + 自动生成 rollback plan + 人工确认执行";真实自动 rollback 作为后续独立决策 |
| trace_id 最小贯通应提前 | blocker | 拆出 **S12e** 放 Phase A;S11c 留完整 observability 层 |
| 测试矩阵 S10 byte-level diff 过硬 | nit | 改 semantic DOM snapshot + 视觉关键截图 + render error = 0 |
| 测试矩阵 S3 全 endpoint e2e 过重 | nit | 改 route inventory(自动扫描比对端点列表零丢失)+ 高风险端点 golden tests(钱+隐私 endpoint) |
| S11b 缺生产安全约束(RBAC/audit/idempotency/lock/恢复) | nit | 加 5 项硬保险作为生产安全约束 |
| S12 数字"<20s"写成承诺 | nit | 改"目标值,实施后实测决定是否继续优化" |
| 总体节奏 18-26 周偏乐观 | 节奏 | 改稳健档 **24-36 周**,18-26 周作为乐观档(需要"无大事故 + ops track 独立 owner + S12 拆小成功") |
| Parallel track 没独立 owner = 直接吃主线吞吐 | 节奏 | 在 §0 摘要 + §5 决策点 3 显式标注 |
