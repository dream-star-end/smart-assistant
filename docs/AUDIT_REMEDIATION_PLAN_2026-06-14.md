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
| **A2** | egress fail-closed 泛化到 Claude 聊天+刷新 | 安全/架构 | P0 | 1 | **W1** | 无（后端） | ⬜ 计划中 |
| U1 | `makeDisclosure` 折叠组件 a11y | UI | P1 | 6 | W1 | ↑ 提升 | ⬜ |
| U3 | `confirmDialog` 替换 12 处原生 confirm | UI | P2 | 8 | W1 | ↑ 提升 | ⬜ |
| U5 | escape helper 去重 + wechat.js:113 转义 | 安全/质量 | P2/P3 | 12 | W1 | 无 | ⬜ |
| U4 | `--fg-dim` 对比度达 WCAG AA | UI | P2 | 9 | W1 | ↑ 提升 | ⬜ |
| B1 | `request_finalize_journal` 对账器+GC | 资金 | P1 | 4 | W2 | 无 | ⬜ |
| B2 | admin 路由层声明式鉴权 | 安全 | P1 | 5 | W2 | 无 | ⬜ |
| B3 | codex disable drift reconciler | 安全 | P1 | 5 | W2 | 无 | ⬜ |
| B4 | node-agent 缺失容器返真 404 | 正确性 | P1 | 5 | W2 | ↑（少卡死） | ⬜ |
| A3 | compute-host 吊销 kill-switch（+B8 NULL fingerprint fail-closed） | 安全/架构 | P0 | 3 | W2 | 无 | ⬜ 需先复核 |
| B5 | 只读 admin 路由升 `requireAdminVerifyDb` | 安全 | P2 | 10 | W2 | 无 | ⬜ |
| U2 | CSS 双 token 词汇统一 + 品牌色 fallback | UI | P1 | 7 | **W3** | 须严防视觉回归 | ⬜ |
| U6 | `--z-*` 分层 token + 聊天流骨架屏一致性 | UI | P3 | 13 | W3 | ↑/中性 | ⬜ |
| **A1** | turn 生命周期单一权威源 + server `turnId` | 架构 | P0 | 1 | **W4** | 须严防流式 UI 回归 | ⬜ design-doc 先行 |
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

- 2026-06-14：创建 worktree `chore/audit-remediation`、本计划文档。下一步：A2 实现计划 → Codex 计划审。
