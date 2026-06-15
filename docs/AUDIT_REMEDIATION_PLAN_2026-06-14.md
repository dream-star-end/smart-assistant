# OpenClaude v3 商业版审计整改计划 (2026-06-14)

> 来源：2026-06-14 五路并行只读审计（前端架构 / UI-UX / 实时同步 / 商业后端安全 / 功能模块）。
> 负责人：boss + Claude。工作分支：`chore/audit-remediation`（worktree `openclaude-v3-audit-remediation`），base `ef8f907a`。

---

## 0. 硬约束（贯穿所有任务，违反即返工）

1. **不得降低易用性（最高约束）**。
   - UI 改动必须 **行为对等或纯增量**：原有鼠标/触控操作路径、视觉、键位一个都不能变差；新增能力（键盘、读屏、对比度）只能加分。
   - 每个 UI 项落地前必须做 **parity 验证**（改前/改后对照），并在任务条目记录验证结论。
   - 后端 fail-closed 类改动需评估"是否会让正常用户更难用"，若有副作用必须有兜底（告警/自愈/降级），并在条目显式标注权衡。
2. **强制评审流程（BLOCKING，见仓库 CLAUDE.md）**：每项改动 = ①写实现计划 → ②**Codex 审计计划并批准后才动手** → ③实现 → ④Codex 审计 diff → ⑤迭代到 PASS。单行 typo 除外。
3. **隔离与部署**：只在 worktree 开发；合并经 canonical `/opt/openclaude/openclaude-v3`；部署只用 `scripts/deploy-v3.sh`；按 `v3-commercial-deploy` 判定 runtime-image 是否重建。
4. **禁区**：不得自行改 `changelog.json`（boss 亲自决定）。
5. **每项独立可回滚**：小而可审的 commit，一项一审，互不耦合（大架构项内部再拆子步）。

---

## 1. 执行顺序原则

- **价值优先级**（架构重要性）与 **执行波次**（安全增量落地序）分列：大架构项价值最高，但风险也最高、最易误伤易用性，因此 **design-doc 先行 + Codex 批准计划后再写码**，并安排在零风险快赢之后。
- Wave 内可并行（文件所有权不冲突时）；Wave 间尽量串行以控制回归面。

---

## 2. 总览任务表

| ID | 任务 | 类别 | 严重度 | 价值优先级 | 执行波次 | 易用性影响 | 状态 |
|----|------|------|--------|-----------|---------|-----------|------|
| **A2** | egress fail-closed 泛化到 Claude 聊天+刷新 | 安全/架构 | P0 | 1 | **W1** | 无（后端） | ✅ Codex PASS, 已 commit (worktree) |
| U1 | `makeDisclosure` 折叠组件 a11y | UI | P1 | 6 | W1 | ↑ 提升 | ✅ Codex PASS, commit `753633b3` |
| U3 | `confirmDialog` 替换 12 处原生 confirm | UI | P2 | 8 | W1 | ↑ 提升 | ✅ Codex PASS, commit `3ad5b96f` |
| U5 | escape helper 去重 + wechat.js:113 转义 | 安全/质量 | P2/P3 | 12 | W1 | 无 | ✅ Codex PASS, commit `62ac2835` |
| U4 | `--fg-dim` 对比度达 WCAG AA | UI | P2 | 9 | W1 | ↑ 提升 | ✅ Codex PASS, commit `1d431a06` |
| B1 | `request_finalize_journal` 对账器+GC | 资金 | P1 | 4 | W2 | 无 | ✅ Codex PASS, commit `ef2022db` |
| B2 | admin 路由层声明式鉴权 | 安全 | P1 | 5 | W2 | 无 | ✅ Codex PASS, commit `67a4b8f8`(含 B5) |
| B3 | codex disable drift reconciler | 安全 | P1 | 5 | W2 | 无 | ✅ Codex PASS, commit `4faea489` |
| B4 | node-agent 缺失容器返真 404 | 正确性 | P1 | 5 | W2 | ↑（少卡死） | ✅ Codex PASS, commit `d214d57a`（**Go node-agent rollout 线,非 deploy-v3.sh**) |
| A3 | compute-host 吊销 kill-switch（+B8 NULL fingerprint fail-closed） | 安全/架构 | P0 | 3 | W2 | 无 | ✅ PASS（Codex 2 轮） |
| B5 | 只读 admin 路由升 `requireAdminVerifyDb` | 安全 | P2 | 10 | W2 | 无 | ✅ 由 B2 router gate 收编(所有 admin 走 verify-db) |
| U2 | CSS 双 token 词汇统一 + 品牌色 fallback | UI | P1 | 7 | **W3** | 须严防视觉回归 | ✅ PASS（Codex 2 轮） |
| U6 | `--z-*` 分层 token + 聊天流骨架屏一致性 | UI | P3 | 13 | W3 | ↑/中性 | 🟡 z-index ✅(Codex PASS);骨架屏 defer |
| **A1** | turn 生命周期单一权威源 + server `clientTurnId` | 架构 | P0 | 1 | **W4** | 须严防流式 UI 回归 | 🟡 design-doc ✅ Codex APPROVE(3 轮);实现待 dev/浏览器流式 smoke |
| R1 | 多标签页协调（leader/广播 turn_settled） | 实时 | P1 | 7 | W4 | ↑（消幽灵态） | ⬜ 随 A1 |
| R2 | IndexedDB 迁移框架 | 实时 | P1 | 8 | W4 | 中性 | ⬜ 随 A1 |
| R3 | 客户端 idempotencyKey 防重放重复计费 | 实时/资金 | P1 | 6 | W4 | 无 | ⬜ 随 A1 |
| A5 | 前端 `checkJs` + 消除 DI 隐式环 | 架构 | P1 | 4 | W4 | 无 | ⬜ A4 前置 |
| A4 | god-file 拆分（websocket/handleOutbound 注册表/admin） | 架构 | P1 | 5 | W4 | 无（纯重构） | ⬜ A5 之后 |
| B6 | per-account 并发上限改分布式租约 | 正确性 | P2 | 11 | W5 | 无 | ⬜ |
| B7 | Claude inflight slot TTL reaper | 正确性 | P2 | 11 | W5 | ↑（少误 429） | ⬜ |
| B9 | auth rate-limiter Redis down 优雅降级 | 可用性 | P3 | 14 | W5 | ↑ | ⬜ |

状态图例：⬜ 未开始 / 🟡 进行中(含子状态) / 🔵 待 Codex / ✅ PASS 已合并。

---

## 3. 各项详情（根因 / 改法 / 易用性守门 / 验证 / 依赖 / 风险）

### A2 — egress fail-closed 泛化（W1，先做）
- **根因**：`getDispatcherForAccount` 所有失败路径 `return undefined`（egressDispatcher.ts:161/191/202/230/247/258/295）。Codex 侧 refresh.ts:587 已 fail-closed（抛 `network_transient`，绝不回退全局/直连）；Claude 聊天(upstream.ts:639)与 refresh(refresh.ts:403) 仍 fail-open，绑定代理失败时静默走全局共享 IP → 账号池去匿名化 + 刷新 IP 漂移。
- **改法（根治）**：把 Codex 的 `resolveCodexAccountEgressDispatcher` 模式提升为 provider 无关 `resolveAccountEgressDispatcher(provider, accountId)`：**账号有非 NULL 绑定但拿不到可用 dispatcher 即抛**；聊天端映射 503+release，刷新端映射 `network_transient`；仅 NULL（未绑定）账号允许默认出口。
- **易用性守门**：纯后端，无 UI 影响。**权衡**：代理抖动时会多出 503 而非静默走全局。兜底=沿用 `transient_network`/release 语义 + 现有告警；正常（已绑定且代理健康）用户体验不变。
- **验证**：单元测试覆盖 {未绑定→放行, 绑定+成功→走绑定, 绑定+解析失败→抛/503/不回退全局}；grep 确认两条 provider 路径对称。
- **依赖**：无。**风险**：中（改核心出口）。

### A3 — compute-host 吊销 kill-switch（W2，**修前先聚焦复核**）
- **根因**：控制面/RPC/隧道/文件路径 `getHostById` 无 status 谓词（queries.ts:50, nodeAgentClient.ts:251）；`maybeRenewCert` 给 quarantined 也续签（nodeHealth.ts）→ 无急停、续签 defeat 过期吊销；`certAuthority.ts:19` 声称的吊销缓存无实现。
- **改法（根治）**：加显式 `revoked` 状态 + 单一入口 `resolveServiceableHostTarget(hostId)`（连接前拒绝不可服务状态）；renew/health 走同一谓词；吊销时清/换 pinned fingerprint。**B8**：RPC 路径 `agent_cert_fingerprint_sha256` 为 NULL 时 fail-closed（nodeAgentClient.ts:199）。
- **易用性守门**：无（运维面）。**风险**：高（误判会切断正常宿主）→ 必须先全量复核 host-connect 调用点清单，再设计。
- **验证**：单测 + 在 dev/单机复核所有 host 解析调用点。

### A1 — turn 生命周期单一权威源 + server turnId（W4，design-doc 先行）
- **根因**：turn 存活由 `sess._sendingInFlight` / 全局 `state.sendingInFlight` / `_reconnectInFlightSet` 三套表示；拆解逻辑复制于 5 文件 11 处；无 server `turnId`，靠跨时钟域比较+消息数组扫描绑定帧↔turn（websocket.js:2341 自承认风险）→ "clear in-flight after X"/"stream final disappear" 反复冒头。
- **改法（根治）**：①新建 `turnLifecycle.js`，`sess.turn={status,turnId,boundMsgId,startedAt}`，唯一 mutator `beginTurn/endTurn(reason)`；`state.sendingInFlight` 降级为派生 getter。②gateway 给每帧打 server `turnId`（复用 frameSeq 机制扩字段），客户端按 id 绑定。
- **易用性守门（关键）**：这是最易误伤流式体验的项。要求：保留全部现有可见行为（打字指示器、停止按钮、流式增量、重连恢复）；先写 design-doc + 行为对照清单 → Codex 批准 → 分子步实现，每子步 dev 流式 smoke（正常 final / 重连后 final / abort / 切会话 / 移动端弱网）。
- **依赖**：R1/R2/R3 随此项规划。**风险**：高 → 必须 design-doc 先行、分步落地、可回滚。

### U1 — makeDisclosure 折叠 a11y（W1）
- **根因**：messages.js:751/805/887/2725 折叠卡片为 `<div onclick>`，0 keydown，无 role/tabindex/aria-expanded。
- **改法**：抽 `makeDisclosure(headerEl, bodyEl)`（role=button + tabindex=0 + aria-expanded + aria-controls + Enter/Space），替换 4 处。
- **易用性守门**：鼠标点击行为完全不变（仍 toggle collapsed）；纯增量加键盘/读屏。改前后鼠标交互逐一对照。

### U2 — CSS 双 token 统一 + 品牌色 fallback（W3，严防视觉回归）
- **根因**：`--bg-primary/secondary/tertiary`、`--text-primary` 从未定义，仅靠 `var(--token,#fallback)` 续命，且 fallback 用禁用 Tailwind 紫 `#7c3aed` 等 → CSS 变量失效即全页变紫。98 种硬编码 hex。
- **改法**：在 `:root` 把未定义别名映射到设计系统 canonical token；fallback 换品牌色或去掉；加 stylelint 禁 hex。
- **易用性守门（重）**：必须视觉对等——逐屏对照（亮/暗/三主题），确认所有 `var()` 解析后颜色与现状一致；优先"定义别名"而非"全局替换"以降低回归面。

### U3 — confirmDialog 替换原生 confirm（W1）
- **根因**：12 处 `confirm()`（sessions/agents/agentTeams/memory/github/wechat/apiKeys.js），可被浏览器压制 → 危险操作无确认直接执行。
- **改法**：抽 `confirmDialog({title,body,danger})`（复用 ui.js 现有 modal+focus trap，返回 Promise），替换 12 处。
- **易用性守门**：确认/取消语义不变；新增暗色/键盘/focus trap = 加分。逐处验证"取消即中止、确认才执行"。

### U4 — --fg-dim 对比度 AA（W1）
- **根因**：`--fg-dim` 暗 3.12 / 亮 2.60 < 4.5。**改法**：调到 ≥4.5（暗≈`#7d7a73`+，亮≈`#75736b`），token 级一处生效。**守门**：仅变更对比度，色相保持，对照时间戳/eyebrow/placeholder 观感。

### U5 — escape 去重 + wechat 转义（W1）
- **根因**：4 处重复 `escapeHtml/_escape`（modelPicker/admin/billing/userPrefs.js）；wechat.js:113 `binding.status` 未转义。
- **改法**：删 4 份本地拷贝，统一 import `dom.js` `htmlSafeEscape`；wechat 该行包 `htmlSafeEscape`。**守门**：纯等价替换，无行为变化。

### U6 — z-index token + 骨架屏一致性（W3）
- **改法**：抽 `--z-dropdown/modal/toast/lightbox` token；聊天流/会话列表复用 admin 既有 `.skeleton-*`。**守门**：层级关系不变，仅可维护性提升。

### B1 — finalize journal 对账器+GC（W2）
- **根因**：migration 0015 承诺的 inflight reconciler+7d GC 从未实现（proxyBilling.ts:175/204/260 只写不收），崩溃→行卡 inflight→白嫖+表无限增长。
- **改法**：照 `pendingOrdersExpirer` 加 30s sweeper（超时→aborted 退款，fail-closed）+ 日 GC（committed/aborted >7d）。注意 schema 只记 precheck_credits，"补扣真实用量"需额外记增量（标注为后续增强）。**守门**：无 UI 影响。

### B2 — admin 路由声明式鉴权（W2）
- **根因**：router.ts:1328 直接 `route.handler`，鉴权靠每 handler 自觉。**改法**：路由声明 `auth:'admin-read'|'admin-verify-db'|'user'|'public'`，router 在 handler 前强制；现有 handler 内 require 调用渐进移除或保留双保险。**守门**：现状全部受保护，零行为变化，仅消除"新路由漏鉴权"这类风险。

### B3 — codex disable drift reconciler（W2）
- **根因**：codexDisableFanout fire-and-forget 失败丢弃；恢复只扫 active 账号看不到禁用账号绑定的容器。**改法**：周期 drift reconciler（JOIN 找 state=active 但绑定账号 status≠active 的容器→强一致 rebind）。**守门**：无 UI。

### B4 — node-agent 返真 404（W2）
- **根因**：远程 stop/remove/inspect 对缺失容器返 500，master 正确的双形状 isNotFound 成死代码→行卡 active、slot/IP 泄漏、用户重连死循环。**改法**：node-agent 缺失容器返真 404/`CONTAINER_NOT_FOUND`。**守门**：减少卡死=提升可用性。

### B5 — 只读 admin 升 verify-db（W2）
- **根因**：requireAdmin 信 JWT role 不回查，降权后 ≤15min 仍可读 ledger/users/orders。**改法**：这几个读路由升 `requireAdminVerifyDb`。**守门**：仅 admin 面，对普通用户无影响。

### B6 — per-account 并发上限分布式租约（W5）
- **根因**：scheduler.ts:617 内存态，蓝绿双实例真实上限 N×10。**改法**：DB/Redis TTL CAS 租约或硬启动守卫。

### B7 — Claude inflight slot TTL reaper（W5）
- **根因**：Claude 侧无 600s reaper（Codex 有），杀进程→计数虚高→虚假 429。**改法**：对齐 Codex 加 reaper。**守门**：减少误 429=提升可用性。

### B9 — auth rate-limiter Redis down 降级（W5）
- **根因**：Redis 挂时 login/register/reset 500 全宕（聊天代理有 FallbackRateLimiter）。**改法**：鉴权端也接 in-process fallback。**守门**：提升可用性。

### A5 — 前端 checkJs + 消环（W4，A4 前置）
- **改法**：对 `public/modules` 开 `checkJs`+叶子契约 JSDoc 进 CI；抽共享契约成叶子模块消除 setWsDeps/setMessageDeps 环。**守门**：无运行时行为变化。

### A4 — god-file 拆分（W4，A5 之后）
- **改法**：websocket.js 按 export 分组拆 wsTransport/messageStore/frameDispatch；handleOutbound 换帧处理器注册表（Map<type,handler>，一类一文件）；admin.js 按 tab 懒加载拆 admin/tabs/*。**守门**：纯重构，行为零变化，靠 A5 静态校验 + 回归 smoke 保证。

### R1/R2/R3 — 多标签页协调 / IDB 迁移 / 客户端幂等（W4，随 A1）
见 A1。R1 守门：消除幽灵"发送中"=提升体验；R3 防重复计费。

---

## 4. 进度日志（每项完成后追加：日期 / commit / Codex 结论 / 验证结论）

- 2026-06-14：创建 worktree `chore/audit-remediation`、本计划文档。
- 2026-06-14：**A2 完成**（commit `aaef2c02`）。Codex 双审 PASS（计划 v3 PASS → 代码 PASS）。
  - 根因：`getDispatcherForAccount` 的 undefined 语义重载（未绑 vs 已绑解析失败）。
  - 改法：绑定权威源 `egress_proxy_id`/`egress_host_uuid` 贯通 AccountToken→PickResult；
    新增 `resolveAccountEgressDispatcher` 优先级状态机；chat 路径已绑但解析失败 → fail-closed
    (release transient_network + pool_unavailable 503 + 独立 metric label)。
  - 验证：tsc src 0 错（测试文件预存错误已对比 canonical 确认无新增）；biome 0 新增；
    egressDispatcher+proxyUpstream 单测 80/80 通过。
  - 关键复审收获：Codex 抓出 ① 仅按已解析 egress 判定会漏掉"proxy 被 disabled"这个最常见泄露
    场景（必须用权威源列）② proxy 失败不能回落 mTLS host（IP 分叉）③ refresh rebind 丢字段。
  - **未部署**：等 boss 批准后按 v3-commercial-deploy 合并 canonical + deploy-v3.sh。
- 2026-06-14：**W1 全部完成**（A2 + U5 `62ac2835` + U1 `753633b3` + U3 `3ad5b96f` + U4 `1d431a06`），逐项 Codex 计划审+代码审 PASS。
  - U5：转义原语单一来源（admin 保留 null-guard 包装），wechat status 转义。
  - U1：`makeDisclosure`（role/tabindex/aria-expanded/键盘），4 处折叠卡；含 tool-card 重渲染 aria 同步 + inset 焦点环（overflow:hidden 裁外环）。
  - U3：`confirmDialog`（Promise，复用 modal+焦点陷阱，capture 阶段 Escape 防嵌套双关，串行化），替换 12 处 confirm + 收编 modelPicker confirmExitTeam。
  - U4：`--fg-dim` 提对比度达 AA（--bg/elevated/subtle），raised/tinted 次要文字降级 --fg-muted。
  - 验证：全程 node --check + biome 0 新增 + test:web 993/993；前端 cache-bust 由 deploy-v3.sh 自动处理。
- 2026-06-15：**B1 完成**（commit `ef2022db`，Codex 计划审+代码审 PASS）。terminalizer（非 replay,journal 无观测用量不可重算）:有 usage_records→committed 回填,无→aborted 不退不扣;7d GC 批量删。阈值根治:不用 0015 字面 30s（journal 不心跳、codex 600s,会误 abort 活流）,默认 30min/env 向上夹 max(codexMax*3,30min)/24h 上限+isSafeInteger 防 ::bigint 打挂。接进 index.ts 调度+关停;单测 14/14;SQL integ 留批量部署阶段验。
- 2026-06-15:**W1+B1 已部署上线**(v1.0.322,commit `e0a1ff99`)。deploy-v3.sh --force,smoke 5/5,无错误;B1 对账器 boot 即清掉生产 40 条卡死 inflight 行(0 残留),A2+B1 已对本地真 PG integ 验证。changelog 本次不写(currentVersion 仅 v1.0.321→322)。
- 2026-06-15:**B2 完成**(commit `67a4b8f8`,Codex 计划审+代码审 PASS,**含 B5**)。router dispatch 对 /api/admin/* 一律 requireAdminVerifyDb(放 405 之前;method-aware 白名单仅 `GET /api/admin/metrics` 走自带 bearer 鉴权);metrics JWT 回落也升 verify-db。整组 admin(含只读)关闭降权 stale-role 窗口。adminRouteGate.integ 7/7,apiKeyAdmin 7/7 无回归。
- 2026-06-15:**B3 完成**(`4faea489`,Codex PASS,unit 19/19 + integ 2/2)。**B4 完成**(`d214d57a`,Codex PASS,go build/test 通过;Go node-agent rollout 线,与 master deploy 分开)。
- 2026-06-15:**A3 host-connect 调用点复核完成**(改前必做)。~20 处 host 解析跨 5 文件,分三类语义:
  - **service**(容器文件 IO putRemoteCodexAuth/getRemoteFile、容器生命周期 RPC run/stop/remove/inspect、tunnel)→ **应**被吊销 gate。index.ts 406/427/551/1114/1499/1512/1534/1744/1830/2348/3073、codexLazyMigrate、v3readiness。
  - **bootstrap/provisioning**(nodeBootstrap.ts 140/660/700/740/783)→ **不可** gate(新 host 尚未 ready,gate 会断 onboarding)。
  - **health/cert**(nodeHealth.ts 96/154 maybeRenewCert)→ **不可**全 gate(health 要能探 quarantined/broken 去恢复;但 maybeRenewCert 需对 revoked 跳过,否则续签 defeat 吊销)。
  - 结论:A3 需 **category-aware** `resolveServiceableHostTarget`(只 gate service 路径)+ 加 `revoked` 状态(migration)+ maybeRenewCert 对 revoked 跳过 + 吊销时清/换 pinned fingerprint + B8(RPC NULL fingerprint fail-closed)。本机无第二 host/node-agent,**无法多机 integ**,故 A3 走 Codex 计划审 + 单元测 + 部署阶段多机 smoke。
- 2026-06-15:**A3(+B8)设计已锁定**(Codex 计划审 PASS,3 轮)。**仅加终态 `revoked` kill-switch,不动 quarantined/broken/draining 现有 service 语义**(零回归)。实现清单:
  1. migration:DO 块按 pg_constraint 发现匿名 status CHECK 名 → DROP → ADD `compute_hosts_status_check`(超集 `bootstrapping/ready/quarantined/draining/broken/revoked`,不删任何现行)。
  2. types.ts:`ComputeHostStatus` 加 `revoked`。
  3. `resolveServiceableHostTarget(hostId)`:getHostById → null/revoked/**fingerprint NULL** 任一即 throw HostNotServiceableError → hostRowToTarget{requireFingerprint:true}。service 非 withTarget 路径(index.ts 容器文件 IO、codexLazyMigrate putRemote、v3readiness tunnel)改走它。
  4. lifecycle RPC:gate 放 `RemoteNodeAgentBackend.withTarget`(containerService.ts:391,共享 choke point,重查不吃 60s 行缓存);**排除 self/local**(本机 docker 不需 node-agent fingerprint)。
  5. B8:NodeAgentTarget 加 `requireFingerprint`;verifyServerCert `if(requireFingerprint && !expectedFingerprint) throw` + 原 compare。bootstrap target 不带该 flag → 不受影响(bootstrap 合法无 fingerprint)。
  6. nodeHealth.pollHost:re-read 后 hostRowToTarget 前 recheck `status==='revoked'` → skip(防 revoke 与 poll 的 race);maybeRenewCert 加 `if revoked return`。
  7. 非 service 控制面也 gate:poolInit backfill(:125 skip)、admin baseline-version(:571 skip)、tunnelHealthzProbe(:9 deny)、baselineServer 入站鉴权(:219 加 status deny)。
  8. admin:`revokeComputeHost(id,ctx)` → 拒 self → `setRevoked`(status='revoked' + agent_cert_fingerprint_sha256=NULL 立即断)+ audit;路由 `POST /api/admin/v3/compute-hosts/:id/revoke`(走 B2 router admin gate)。un-revoke 需 re-bootstrap(可接受,终态)。
  9. 验收:patch 后**重审所有直用 hostRowToTarget 的生产路径** —— 任何可能 RPC/tunnel/file/baseline/egress 接触终态 host 的路径,必须经 resolveServiceableHostTarget / withTarget / 显式 skip-deny。
  - 单测(本地 PG):resolver {revoked/null-fp→throw, ready+fp→ok}、verifyServerCert requireFingerprint fail-closed、setRevoked SQL+audit、pollHost race recheck、≥1 非 service caller skip/deny、migration 超集保行。多机 smoke 留部署阶段。
- 2026-06-15:**A3(+B8)实现完成,Codex code review PASS(2 轮:FAIL→修复→PASS)**。
  - 状态机/DB:migration 0081(发现谓词从 `%status%IN%` 硬化为 `%status%`,按引用 status 列唯一匹配,不依赖枚举值子串/IN 归一化);`setRevoked`(tx FOR UPDATE,清 fingerprint,admin.revoke audit,self/不存在→false,幂等);types.ts `revoked`。
  - **终态不变量(防无声 un-revoke,DB 层统一封)**:`setQuarantined` 跳过表 +revoked;`updateStatus` WHERE `AND (status<>'revoked' OR $2='revoked')`;`markBootstrapResult` 事务内 FOR UPDATE 预检 revoked→ROLLBACK;`updateCert` WHERE `AND status<>'revoked'`(**原子消除 revoke/renew 竞态** —— Codex Finding 2:maybeRenewCert 持旧 row 续签会写回 fingerprint,WHERE 守卫按 committed status 判定,无 TOCTOU);既有 setDraining/clearQuarantine(ByReason)/applyHealthSnapshot 经核已不外迁 revoked。
  - 解析器+B8:`assertHostServiceable`(self 豁免/revoked/null-fp,revoked 优先)+ `resolveServiceableHostTarget`(requireFingerprint=true);`verifyServerCert` 加 requireFingerprint 形参,3 个 TLS 建连点(request/file-stream/dialTunnelSocket)透传。
  - service 路径全 gate(重审闭合):withTarget(lifecycle RPC+inspectImage)、index.ts 远端 file-IO put/pull×2/**delete**(Codex Finding 1:漏的 deleteRemoteCodexAuth 已补)/inbound file-proxy/sshMux resolvePlacement、tunnelHealthzProbe/v3readiness/v3ensureRunning bridge/containerApiProxy/containerFileProxy/volumeContextReader、nodeBootstrap 入口/adminDistributeImageToHost(SSH)、nodeHealth poll+renew、poolInit/baselineServer/getBaselineVersions。`grep hostRowToTarget( index.ts` 仅余 sshMux 一处(已 gated)。
  - 验证:tsc 改动文件 0 error;biome 0 new(工作树 32≤HEAD 35);测试 hostServiceable 5/5 + computeHostRevoke.integ 15/15(真 PG octest);回归 queriesAtomicLifecycle 62/62、v3EnsureRunning 21/21、v3Readiness 20/20、containerApiProxy 5/5。
  - **已知 tech-debt(Codex 同意为 A3 边界,后续单独硬化)**:① revoked host 上活跃用户的 deny 是 retryable 形态(ContainerUnreadyError/502)→ 会被无意义重试(安全无损:每次重试重查 DB 再 deny,host 永不被接触);根治需 caller re-placement + data-host 迁移语义。② in-flight egress CONNECT / 已建 tunnel / bootstrap 进行中的 step 不被同步 teardown(revoke 只切新接触+清 fp+新 egress fail-closed);根治需 per-host active-socket/dispatcher 追踪与主动 kill。
- 2026-06-15:**U2(CSS 双 token 统一)实现完成,Codex PASS(2 轮)**。审计发现主应用散落整套"旧别名"词汇(permission/askUserQuestion 模态、api-keys 面板等),从未在 :root/主题定义,只靠 `var(别名,#硬编码)` 续命 → **亮色主题下模态错乱**(深底+浅灰字几乎不可见)、无 fallback 的 `--radius/--brand/--error/--text` 直接失效(方角/无 outline)。
  - 按"看一类问题"原则**一次性**把 16 个别名全部映射到 canonical token(base :root 定义,主题感知 lazy 解析;fallback 用 dark canonical 品牌安全值):--bg-primary/secondary/tertiary/base/soft/muted→--bg*;--text/-primary、--fg-primary→--fg;--text-secondary、--fg-secondary→--fg-muted;--brand→--accent;--error、--accent-danger→--danger;--radius→--radius-md;--mono→--font-mono。
  - 同步删坏 fallback:30×`var(--accent,#7c3aed)`(禁用紫)、10×`var(--danger,#ef4444)`、6+3+3×`--bg-*` 偏蓝深色、9×`--fg-primary,#e0e0e0`、3×`--fg-secondary,#aaa`、3+1×`--accent-danger,#d33`。
  - 净效果:dark 主题 sub-perceptual 微调(近黑/浅灰几无变化);light 主题 + mermaid label = 真 bug 修复(模态/文字恢复主题感知与可读对比)。审计脚本确认**主应用未定义别名 = 空**(整类消除)。admin.html 自带独立 token 体系,不在此统一。
  - defer(后续 stylelint + 硬编码 hex 清扫):1×standalone `#7c3aed`(voice 字面量)、53×死 `var(--tok,#hex)` fallback(token 均已定义,5×已是品牌色)。
  - 验证:brace 1960/1960;`git diff --check` 干净;web 测试 styleThemeConsistency 4/4、mermaidRenderingConfig 3/3、githubModalStyles 2/2;node --check apiKeys.js OK。
- 2026-06-15:**U6 z-index token 化完成,Codex PASS**。style.css 41 处散落 z-index 魔数(含 9999/10000"层级战争")→ base :root 新增全局 `--z-*` 标度(18 token),把 25 处跨组件全局层级 decl 换成 token。**严格保值**:每 token 值=原 raw 值,层级关系 byte 级不变(纯命名+集中+文档化);局部 stacking(-1/0/1/2/5/10)保留裸值。验证:无残留裸 ≥20;token 引用 25=原 decl 数;brace 1960/1960;web 测试 4/4+3/3+2/2 全绿。
  - **骨架屏一致性 defer**:主应用无 `.skeleton-*`(仅 admin.html 自带),聊天流/会话列表加骨架屏属**新增 UX 功能**(需 DOM 接线 + 视觉设计 + 浏览器验证),非纯维护性重构,留作独立 UX 项(同 U2/U6 的 stylelint 禁裸 hex/裸 z-index 一并做)。
- 2026-06-15:**第二批已部署上线 v1.0.323**(commit 81b3a369)。canonical v3 merge 38b8d65b(B2/B3/B4/A3/U2/U6-z)→ `deploy-v3.sh --force`(6 活跃用户已确认 --force)。smoke 5/5;前端 38/47 文件 cache-bust 重写;migration 0081 已在生产 schema_migrations,`compute_hosts_status_check` 已含 `revoked`;`/version`=v1.0.323;origin/v3 已推。⚠ 唯一警告:trace propagation found 2<3(warn-only,HTTP logger traceId 子绑定,**与本批无关**,留观)。
  - **仍待办:B4(Go node-agent)单独 rollout** —— deploy-v3.sh 只部署 master;B4 改的是 `packages/commercial/node-agent/**`(Go),需另走 node-agent build+distribute+restart 流水线(非 P0,容器 stop/remove/inspect 缺失返真 404 的正确性修复),建议作为独立 ops 操作或与下次 node-agent 改动合并。
- 2026-06-15:**A1 设计文档完成,Codex 计划审 APPROVE(3 轮 REVISE→APPROVE)**,见 `docs/A1_TURN_LIFECYCLE_DESIGN.md`。Explore agent 实测映射:3 套并行 in-flight 表示(`sess._sendingInFlight` 17R/16W、被独立赋值的派生量 `state.sendingInFlight` 16R/14W、`_reconnectInFlightSet`)+ teardown 复制 11 处(仅 isFinal 完整)+ 帧↔turn 靠跨时钟域 ts 比较(自承认设备钟快>5s 丢 final)。设计:客户端 `turnLifecycle.js` `sess.turn` 单一真相 + `beginTurn/endTurn(reason,{finalize})` reason 策略 + UI/transport 读点分层(非一刀切派生 getter);server `clientTurnId`(client-mint 全链路 echo,含商业 bridge)+ per-turn binding mode(capability 协商,未确证→legacy,杜绝混用)。Codex 关键修正已纳入:派生 getter 会破坏 reconnect UI 抑制(1829)→改分层 + 镜像过渡;非 final 不得自动定稿流式行→finalize 三策略(full/flushOnly/none);bridge echo + 合成帧 turnId 规则;full finalize 须抽完整有序阶段(2441+2997)。
  - **实现待办(本环境无法 headless 完成的硬前置)**:A1 验收门是**dev 起站 + 浏览器逐条流式 smoke**(P1-P6:打字指示器/停止按钮/流式增量/重连恢复/切会话/弱网),headless 无法验证可见流式体验。按 Codex 建议 Phase 1 起(1a facade+镜像零行为变 → 1b reason 策略 teardown → 1c UI getter 分层),每子步浏览器 smoke。**留待具备 dev/浏览器的会话实现,或由用户在每子步跑 smoke。**
- 下一步(按"可否 headless 完成"分流):
  - **headless 可完成**(同 A3/B1/B3 范式,有 PG/Redis 可 integ 测):**W5 B6**(per-account 并发分布式租约)、**B7**(Claude inflight slot TTL reaper)、**B9**(auth rate-limiter Redis-down 降级);**A5**(前端 checkJs 消环,tsc 可验)、**A4**(god-file 拆分,单测可验)。
  - **需 dev/浏览器验证**(流式/多标签/IDB 可见行为):**A1 实现**、**R1/R2/R3**(多标签协调 / IDB 迁移 / 客户端幂等)。
