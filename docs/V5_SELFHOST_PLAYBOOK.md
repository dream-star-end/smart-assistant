# OpenClaude V5 Selfhost 权威开发、架构、门禁与自治闭环总手册

> **权威定位**：本文是 OpenClaude V5 个人版（Selfhost，主干 `feat/v5-selfhost`）唯一权威工程与治理总手册（对标商业版 `docs/V5_DEV_PLAYBOOK.md`）。快速路由见 `AGENTS.md`，UI/UX 设计宪章见 `docs/UI_DESIGN_SYSTEM.md`，包级红线见 `packages/web-react/AGENTS.md`、`packages/commercial/AGENTS.md`、`packages/gateway/AGENTS.md`。

---

## 1. 系统拓扑、四进程作用域与三套环境隔离

### 1.1 四进程作用域与后端 L0–L6 / 前端 F0–F5 分层

仓库由 `arch/modules.json` 定义 4 个进程作用域（`browser` / `master` / `egress` / `container`）与严格单向分层，并由 `scripts/check-architecture.ts --enforce` 与 `scripts/check-gate-couplings.ts --check` 硬阻断：

- **后端单向分层（L0 → L6）**：
  - `L0` 契约与类型：`packages/protocol/src/`（`browser`/`master`/`egress`/`container` 共享，严禁混入 Node 专有内置模块）、`packages/plugin-sdk/src/`、`packages/commercial/src/types/`
  - `L1` 基础内核与风味：`packages/kernel/src/`、日志、风味规则（`packages/commercial/src/flavor/flavor-rules.json`）、Gateway 核心类型
  - `L2` 持久化与配置权威：`packages/commercial/src/db/`、`packages/storage/src/`、配置注册表
  - `L3–L5` 领域服务、计费权威、协议通道、引擎适配与路由组装
  - `L6` 进程入口与装配层
- **前端细化分层（F0 → F5，`packages/web-react/src/`）**：
  - `F0 web-primitives`：`components/ui/` + `styles.css` Token（零业务依赖）
  - `F1 web-lib`：`lib/`（排除 `lib/chat/`；唯一允许直接 `fetch` 的前端域）
  - `F2 web-state`：`lib/chat/` + Swarm/Workbench 状态机（禁反向依赖 `F4`）
  - `F3 web-hooks`：`hooks/`（仅可依赖 `F0/F1/F2`，严禁反向依赖 `F4` 组件）
  - `F4 web-domains`：10 个平行业务域（`chat | sidebar | workbench | swarm | sites | settings | manage | admin | iui | studio`），跨域仅经 `F2` 事件/状态或公开入口
  - `F5 web-app`：`App.tsx` / `appLazyViews.tsx` / `admin/` 壳层装配，禁堆砌业务逻辑
- **跨包导入硬规**：全仓严禁跨包相对路径导入，一律使用 `@openclaude/<pkg>`；变更 `gateway`/`protocol`/`storage`/`cli` 后必须跑 `node packages/cli/scripts/build-container-gateway.mjs`。

### 1.2 三套环境红线与容器持久化

| 环境 | 分支与隔离边界 | 铁律 |
|---|---|---|
| 老个人版 | `master`（45.32 root 18789 / dev 18798） | 独立路径，见 `CLAUDE.md`，与 V5 严禁串套 |
| **V5 Selfhost（本文主域）** | `feat/v5-selfhost`（`uid=3` 端口 18790） | Worktree 放共享持久卷 `/home/agent/.openclaude/workspace/wt-<ticket>` 并播种暖 `dist-types`/`.tsc-cache`；容器内仅 `/home/agent/.openclaude/` 持久；commit 后即推远端 |
| V5 商业版（Aurora） | `feat/v5-aurora-rewrite`（独立宿主机 A/B 槽） | 开工必读 `docs/V5_DEV_PLAYBOOK.md`；“看下/查下”仅限只读诊断 |
| Windows 桌面端 | `feat/v5-windows-app` | 分支 `<type>/v5-windows-<slug>`，禁入 server 发布列车或 `scripts/deploy-v5.sh` |

- **诊断前置核验**：查代码行为前必核容器 `MANIFEST.json` 的 `sourceCommit` 与宿主 HEAD 一致，严禁把旧快照当当前主干排查；**严禁**执行 `systemctl restart openclaude*` 绕过发布列车。

---

## 2. 强模型主权、存储分层与单权威源

### 2.1 强模型主权（第一红线）与跨家族审计

- **禁黑盒弱模型暗降**：主对话、`/btw` 快问、Cron 定时任务、`ai_review` 预审必须保持显式选定的强模型，严禁任何后台回退分支静默降级至弱模型；轻量模型仅限显式隔离的无决策杂务（标题/索引）或用户手动显式指定（由 `scripts/check-no-silent-model-downgrade.ts` / `npm run check:no-weak-downgrade` 拦截）。
- **主开发自写 + 跨家族 T2 审计**：主战模型在共享卷 worktree 亲自写码；T2 审计强制跨家族（GPT 家族开发 → Gemini 家族审；其余默认 GPT 家族审），派审必传精确模型 slug 并核对 `usage_log` 实跑型号（本地/派审可用 `npm run check:cross-family-audit` 即 `scripts/check-cross-family-audit.ts` 机械校验，自测已入 PR CI）。
- **团队模式「一开关两策略」**：*审议（deliberation）* 走多家族并行 panel + 五段对比（共识/矛盾/部分覆盖/独有洞见/盲点）；*执行（execution）* 走领域拆分 + 逐条核对 runId/状态/产物路径，严禁把失败/超时成员包装成功，超长证据显式标截断。
- **顾问与只读角色执行端硬禁写**：`advisor`、`auditor`、`verifier` 与只读诊断的无写/无执行/无 `skill_save`/无嵌套委派必须在执行端工具白名单物理拦截（`packages/protocol/src/advisorNoWrite.ts`、`packages/gateway/src/actionPolicyEngine.ts`、`packages/protocol/src/actionPolicy.ts`），绝不只靠 prompt 声明；无法证明工具限制生效的引擎禁止开放为顾问。

### 2.2 PG + SQLite Sidecar 务实分层与单权威源

- **Master PostgreSQL 权威**：Selfhost 主库为 PostgreSQL（`OC_SESSIONS_STORE=pg`），迁移入口 `packages/commercial/src/db/migrate.ts`，启动由 `packages/commercial/src/db/sessionsStoreAuthority.ts` 四元组矩阵 fail-closed 裁决。
- **容器 SQLite Sidecar（设计内分层）**：容器本地 `sessions.db`、`taskboard.db`、`delegate-jobs.db`、`delegate-inflight-surface.db` 属有意识的性能与隔离分层而非遗留债务；**严禁运行中删除或移动 `sessions.db`**（会触发 WAL 撕裂与重启静默建空库而 `healthz` 假绿），仅当跨机多节点共享需求触发时再迁 PG。
- **单一权威源铁律**：模型可执行性、价格冻结/结算（`packages/commercial/src/billing/`）、Agent 身份、会话 tape/live、调度（`npm run lint:scheduler-wiring`）、发布态、平台能力提示词（`packages/commercial/agent-sandbox/platform-runtime/prompts/platform-capabilities.md` 与 `packages/gateway/src/promptSlots.ts` fallback）各持唯一权威源，禁止双写分叉或用 user skill shadow 掩盖平台基线 bug。
- **多租户路由三处同步（硬门）**：`packages/gateway/src/server.ts` 暴露的敏感/memory 子路由、`packages/gateway/src/bridgeApiAllowlist.ts` 与 `packages/commercial/src/http/router.ts`（`BLOCKED_FOR_USER_RULES`）必须三处精确同步，由 `scripts/check-v5-route-sync.ts`（`npm run check:route-sync`）机械守恒。

---

## 3. 高可靠代码 5 律、状态四象限与迁移三问

### 3.1 高可靠代码 5 律

1. **Upsert 守卫函数依赖律**：`ON CONFLICT (k) DO UPDATE ... WHERE` 等值守卫仅能比对冲突键 `k` 函数决定的列；`RETURNING` 0 行必显式区分「守卫为假」与「行不存在」。
2. **结构化可重试分类律**：写失败在抛出点附带结构化 retryable 标记，跨层禁止用正则匹配错误文案决定是否重试；永久失败绝不进入重试、毒化或断连风暴。
3. **单例 Latch 与退避重置律**：进程内任何 latch/熔断位必须具备 TTL 或显式恢复路径；客户端重连退避严禁在 `onopen` 立刻清零，须在连接稳定超过阈值后重置。
4. **懒加载与 Owner 围栏律**：前端禁裸 `React.lazy`（必须经 `packages/web-react/src/components/ChunkErrorBoundary.tsx` / `LazyBoundary` 包裹）；全局互斥锁在跨会话切换/请求终态/组件卸载三出口幂等释放；所有异步边界（含 `response.json()` 后与 `finally`）重核 `账号 epoch → 项目 → 会话/工单 → 请求`；持久失败条目须服务端 ACK 后方可清除。
5. **缓存与安全边界契约**：Box 路由坚持走 Box，维持会话级提示词冻结（`packages/gateway/src/promptFreeze.ts`）+ Antigravity 续轮去重与固定 `launchHome`；`remote-driver-v4` 策略变更同步 `policySha256`、`readOnly` fail-closed 白名单、`cc5-att-us` 固定端口 `22022`；Sites `/api/*` 走 `bwrap` 沙箱与 AES-256-GCM 密文 env，`editor` 不可篡改 `server/api.mjs`。

### 3.2 T2 动工前必查：状态演化四象限 & 迁移阶段 0 三问

- **状态演化四象限自查**：
  1. **旧数据缺失新字段**：老行/旧缓存/跨版本 payload 缺省新字段时如何零崩溃兼容？
  2. **多流并发与分片/上限溢出**：多标签页、并发 turn、队列满/单分片超限时是否保持守恒？
  3. **乱序与迟到异步幂等**：晚到的旧响应、重连重放、重复回调是否被幂等忽略而不覆写新态？
  4. **取消/切换/卸载锁释放**：Abort、切会话、切账号、组件卸载时锁/定时器/订阅是否 100% 清理？
- **数据库迁移阶段 0 三问（写 SQL 前必答）**：
  1. 新迁移先上库、旧版本服务仍在运行期间，旧代码读写是否 100% 兼容？
  2. DDL 是否会长时间锁表或阻塞线上读写（强制 Expand-Contract 两步迁移，先加可空/带默认列、`NOT VALID` 约束与 `CONCURRENTLY` 索引）？
  3. 若发布回滚到旧码，旧代码读新库是否无错？
  - 已入 PR CI 迁移与契约硬门：`npm run lint:migration-order`、`scripts/v5-selfhost-migration-precheck.sh`、`scripts/v5-selfhost-migration-compat-check.sh`、`scripts/check-pg-migration-safety.ts`（`npm run check:pg-migration-safety`，零停机 Expand-Contract 7 类危险 DDL 硬拦截，可选叠加 `squawk`）与 `scripts/check-rest-contract-compat.ts`（`npm run check:rest-contract`，核心 5 域 `packages/protocol/src/httpContracts.ts` 快照与递归防破坏兼容门）。

---

## 4. 测试真实业务结果铁律（零假绿）

- **业务不变量优先**：每条测试必须对应真实用户可见业务不变量，走真实入口验证终态（审批核真实 permission response，计费核双池 ledger 收敛，崩溃恢复由新子进程仅靠持久态完成，UI 核真 React + 真 CSS + 真实量级数据）；**禁止**以 mock called、静态 HTML 替身或源码正则冒充功能验收。
- **有效红绿负控**：测试对旧缺陷/关闭防线必须真红，对候选修复真绿；导入失败、全 skip、过滤后 0 用例执行均视为无效。
- **严格证据分层口径**：`推送 ≠ 过测 ≠ 独审 PASS ≠ 合入 ≠ 上线 ≠ 容器生效`；「重启后消失」不是根治修复。报告必须含场景、expected/actual、SHA、run/fail/skip 计数与 exit code。
- **确定性防假绿硬门**：`npm run check:v5:regression-contracts`（SHA-256 锁定 + 负例变异证明）、`npm run check:test-retries`（封堵静默 retry）、`npm run lint:integ-tiers`（集成测试梯队全登记）、OCV5-343 `npm run test:web-react` 100% 全绿（P2 计划补齐核心状态机 `fast-check` 属性测试与 Nightly 增量 `Stryker` 变异抽检）。

---

## 5. 自治迭代快车道、审计熔断与发布闭环

### 5.1 风险分级快车道（`T0 / T1 / T2 / L4`）与并发防踩踏

| 级别 | 触发范围 | 提交前缀 | 本地快门预算 | 审计与合并策略 |
|---|---|---|---|---|
| **T0** | env/目录别名/纯文案/文档 | `chore/docs(v5):` | `<15s`（相关单测 + `npm run check:docs-links`） | **不上审**；PR 绿灯 Auto-Merge |
| **T1** | 单包 UI/样式/组件/局部 Bug | `ui/bug/perf/refactor(v5):` | 迭代 `<20s` / 收口 `<60s`（目标单测 + 增量 `tsc` + 触碰面快门；改入口/CSS 跑 1 次 `npm run build:web-react`） | **不上审**；CI 跑 `test:web-react` / `typecheck:preview` / `test:browser` / L2-L3 `layout-invariants.mjs --tier core` + L1 静态门与选择器（L4 `shoot.mjs --tier=core` 本地按需跑，L6 `check:vlm-judge` 为 `advisory` 校准态），未碰 A 类文件绿灯 Auto-Merge |
| **T2** | 跨包、`gateway`/协议/存储/计费/迁移/权限 | `bug/perf/refactor(v5):`（**仅真实线上事故复盘**用 `fix(v5):` + `Incident: INC-YYYYMMDD-SLUG`） | `<3min`（T1 全部 + 四象限 + 迁移三问 + `build-container-gateway.mjs` + `npm run check:governance:fast`；重型 proof 定稿单跑 1 次） | **跨家族强模型审（`1+1` 硬上限，`npm run check:cross-family-audit` 核验）** + `selfhost-storage`/PG 迁移安全/REST 契约硬门；未碰 A 类文件绿灯 Auto-Merge |
| **L4** | A 类 `CODEOWNERS`、L4 自进化策略、商业生产 | 候选分支 PR | 准备 PR + 完整证据，**严禁自批自合** | 全量 `--base` 单调校验 + **强制 `@dream-star-end` 人工审签** |

- **前缀精确分流**：`fix(v5):` 专供真实线上事故复盘（本地仅跑本次新增的 1 条 proof + `scripts/check-v5-fix-trailers.sh`，绝不本地重跑 10+ 分钟全量历史 proof）。
- **多会话并发防踩踏**：并行改码前必须建单声明触碰面，触碰面有交集时**强制串行**。
- **非必需 CI 变红必核因**：任何 non-required CI 变红必须与 base commit 比对定性，严禁直接忽略合入。

### 5.2 `1+1` 审计硬上限、队长三判与止损熔断

- **`1+1` 硬上限（V5 Selfhost T2）**：1 轮完整 diff 首审 + 最多 1 轮同会话增量复核（仅核上轮 P0/P1 修复与新增 diff），**绝对禁止进入第 3–4 轮审查乒乓**。
- **队长三判裁决**：审出以下三类非真阻断项，队长直接裁决驳回、留痕并另记待办停派：
  1. 范围外老问题（非本次 diff 引入）；
  2. 过度防御或脱离真实入口的极端理论构造（无具体输入→错误结果复现）；
  3. 风格/命名/可读性/锦上添花测试（P2 及以下）。
  若存在真实主路径安全、多租户越权、账务资金或数据损坏阻断且在冻结范围内无法收敛，立即升级人类决策。
- **本地止损三律**：① 严禁 `sleep >= 60` 干等；② 同一命令/错误连续失败 2 次必须换排障策略；③ 单次连续工具调用接近 80 次主动拆分阶段交付。
- **2 轮 CI 自动熔断**：PR 推送后若 CI 失败，Agent 最多自动修复 **2 轮**（第 1 轮自动修 lint/格式/显式报错，第 2 轮定向修根因逻辑/测试）；第 2 轮仍未全绿立刻熔断停止烧算力，生成结构化失败归因卡移交人类。

### 5.3 个人版 Flag 上线即启用 + 判停秒回 + Lease 搭车回调

- **Flag 上线即启用（跳过 2h shadow 窗）**：个人版根治件 Feature Flag 上线即直切 `enforce`（无依赖开关同窗合并，拒绝层层开关官僚）。所有活跃 Flag 必须登记在 `deploy/v5/feature-flags-registry.json`（默认 TTL ≤30 天，由 `scripts/check-feature-flags-ttl.ts` / `npm run check:feature-flags-ttl` 巡检）。
- **判停自动秒回**：上线后若命中任一判停信号（新红卡出现、委派失败率上升、`mismatch > 0`、`healthz` 异常），立即秒回至 `off` 并事后通报；**无明确根因证据禁止二次重试**。
- **Lease Center 搭车回调（0 轮询等待）**：PR 合入 `feat/v5-selfhost` 后，立即执行：
  ```bash
  scripts/oc-lease.sh register --resource deploy:selfhost --mode ride --sha <40hex> --ticket OCV5-xxx
  ```
  看到 `▶ 已登记` 立即收口本回合，严禁挂起轮询或用 `create_reminder` 空烧上下文；宿主 `lease-worker.timer`（30s）自动校验并推进发布列车，结算 `survivor committed` 且 `.complete.sourceCommit ⊇ want_sha` 后自动回调。发布门与 CI 双向守恒由 `deploy/v5/selfhost-release-gates.json` 与 `scripts/check-release-gate-parity.ts` 锁定。

---

## 6. 防“改门凑绿”（Tamper-Proof）A/B 分层与五重硬防线

任何仅靠提示词劝阻“不要放宽门禁/不要改基线”的约束都会被突破，因此建立五重机械防线：

### 6.1 防线 1：A / B 分类治理（`.github/CODEOWNERS` + Rulesets + Auto-Merge）

- **A 类（静态锁进 `.github/CODEOWNERS`，强制 `@dream-star-end` 人工审签）**：
  - CI 与规则基础设施：`.github/CODEOWNERS`、`.github/workflows/`、`.github/scripts/`、`.github/known-failures/`、`.github/integ-tiers/`、`.github/file-size-ratchet-exceptions.json`、`biome.json`、`arch/modules.json`
  - 前端预算/豁免/核心门：`packages/web-react/vite.config.ts`、`packages/web-react/budgets.json`、`packages/web-react/design-tokens-exempt.json`、`packages/web-react/src/test/designTokens.test.ts`、`packages/web-react/browser-tests/layout-invariants.mjs`、`packages/web-react/browser-tests/vlm-rubric/`、`packages/web-react/tutorial-sync-history-head.json`
  - 校验与发布脚本：`scripts/check-*.ts`、`scripts/check-*.sh`、`scripts/v5-selfhost-migration-*.sh`、`scripts/v5-selfhost-master-release-lib.sh`、`scripts/deploy-v5-selfhost.sh`、`packages/commercial/scripts/lint-agent-containers-sql.ts`、`deploy/v5/selfhost-release-gates.json`
  - 冻结锚点、契约、权限核心与公告：`e2e/session-display/incident-ledger-baseline.json`、`e2e/session-display/incident-ledger-baseline.sha256`、`e2e/session-display/incident-tombstones.json`、`e2e/session-display/incident-tombstone-approvers.json`、`packages/commercial/src/flavor/flavor-rules.json`、`packages/protocol/src/advisorNoWrite.ts`、`packages/protocol/src/httpContracts.ts`、`packages/protocol/rest-contract-snapshot.json`、`packages/gateway/src/actionPolicyEngine.ts`、`changelog.json`
- **B 类（刻意不进 `CODEOWNERS`，支持 Agent 自主清债/追加，由 A 类 Checker + `--base` 机械守单调）**：
  - `arch/violations-baseline.json`（`scripts/check-architecture.ts --enforce --base` 守只降不升）
  - `arch/gate-couplings.json`（`scripts/check-gate-couplings.ts --check` 守路径全覆盖）
  - `.github/file-size-baseline.json`（`scripts/check-file-size-ratchet.ts --base` 守只降不升，含 `.css` 与 2,000–3,000 行黄区冻结）
  - `packages/web-react/design-tokens-counts.json`、`packages/web-react/ui-static-baseline.json`、`packages/web-react/layout-invariants-baseline.json`、`deploy/v5/feature-flags-registry.json`（`scripts/check-monotonic-baselines.ts --base` 守计数不升、禁增新键、TTL 不延后、不得私标 `permanent: true`）
  - `e2e/session-display/incidents.json`（`scripts/check-incident-ledger-superset.ts` 守超集只增不减）
  - `e2e/session-display/regression-contract-locks.json`（`scripts/check-v5-regression-contracts.ts --prove` 守旧契约哈希不可变）
- **无摩擦双轨**：未触碰 A 类文件的 T0/T1/T2 PR 在 CI 全绿后经 Auto-Merge 秒级自动合入；凡触碰任意 A 类文件必须人类审批；宿主机发布列车纵深复用受保护基线与门禁脚本，阻断未审 A 类变更。

### 6.2 防线 2–5：单调校验、封堵逃生口、双轨复验与 L4 硬隔离

2. **防线 2（`--base` 单调校验）**：CI 统一相对受保护分支 `origin/feat/v5-selfhost` 执行 `check-architecture.ts`、`check-file-size-ratchet.ts`、`check-v5-regression-contracts.ts` 与 `check-monotonic-baselines.ts`，清债降数绿灯、抬升基线硬阻断。
3. **防线 3（封堵逃生环境变量）**：常规 `.github/workflows/v5-selfhost-gates.yml` 与发车脚本显式强制执行开关（如 `OC_TEST_RETRY_ENFORCE="1"`、`OC_PG_MIGRATION_BOSS_APPROVED="0"`），拒绝外部跳过变量；`scripts/check-changelog-guard.ts` 机械阻断 AI 修改 `changelog.json`。
4. **防线 4（双轨独立执行与回执）**：本地快门仅用于 Shift-Left 提速，绝不替代洁净 GitHub Actions Runner 与宿主 Staging 列车复验（`.github/workflows/v5-selfhost-gate-receipts.yml`）。
5. **防线 5（L4 元层与执行端硬隔离）**：只读/顾问在执行层物理移除写工具；宿主机门禁只读隔离；自进化一周内回滚 **≥ 2 次**自动熔断全部自动合入待人解锁；定期开展后台 GC 微 PR（清债/文档保鲜/过期 Flag）与季度 Model-Aware Harness Pruning（随强模型进步主动裁剪冗余脚手架）。

---

## 7. 「Agent 自主拍板 vs 必经人工拍板」L4 权威决策边界表

| 决策领域 | Agent 可完全自主拍板并闭环 | 必经人工拍板（硬闸门 / HITL） |
|---|---|---|
| **个人版 UI/UX 与日常优化** | `OCV5-145` 授权下，T0/T1 组件精雕、交互/性能修复、单包重构、`ui(v5):` 在 L1/L2-L3 实景布局不变量/既有浏览器套件全绿且本地按需复验 L4 脚本后更新受控快照，Auto-Merge 后搭车上线 | 修改品牌北极星/主视觉方向；修改 A 类 `CODEOWNERS` 预算/豁免/Rubric/测试；涉计费、法律协议或备案文案 |
| **个人版 Feature Flag 与回滚** | 根治件上线即切 `enforce`；同窗合并无依赖开关；命中判停指标立即秒回 `off` 并通报；稳定后清理过期 Flag | 不可逆数据清理/格式破坏开关；延长过期 Flag TTL 或改为 `permanent: true`；无明确根因的回滚后二次重试 |
| **T2 审计与范围争议** | `1+1` 上限内按队长三判自主驳回范围外/过度防御/理论构造/P2 项并留痕停派 | 真实主路径安全、多租户越权或账务资金阻断，在冻结范围内无法收敛 |
| **CI 失败与异常熔断** | CI 第 1、2 轮自主修复重推；本地同错 1 次后换策略排障 | **CI 连续 2 轮仍失败自动熔断**；连续 2 次同错无法破局；单周自进化回滚 ≥2 次后的熔断解锁 |
| **任务单状态流转** | 入口创建 `backlog`（不自批）；有明确授权且具备真实交付证据时按规审计关单并回读 | 无明确关单授权时交人验收；**`cancel`（取消）与 `reopen`（重开）永远仅限人类** |
| **运行态模式与外部写动作** | `action-policy` `allow` 动作、经强模型 `ai_review` 通过的低风险动作 | **进入计划模式（`EnterPlanMode`）** 必经用户同意；`human_approval` 档外部写动作；云浏览器登录/2FA/CAPTCHA 人工接管 |
| **架构、数据、自进化与多环境** | 商业版生产只读诊断；Selfhost L1–L3 白名单候选在周预算内过门自动合入（必挂工单与留痕） | **商业版生产变更/发布/切流**；**破坏性/锁表 DB 迁移**；**资金/计费口径改动**；**重建仍在跑他会话的容器**；**所有 L4 元层与 A 类 `CODEOWNERS` 改动** |

---

## 8. 常用本地治理与验证命令速查

```bash
# 一键全量秒级治理快门（<15s，覆盖文档死链/UI硬门/强模型红线/路由三同步/changelog/Flag TTL/REST契约/调度/SQL/重试/梯队/选择器）
npm run check:governance:fast

# 架构边界、门禁耦合、文件棘轮、跨基线单调校验、PG 迁移安全与跨家族审计
npx tsx scripts/check-architecture.ts --enforce
npx tsx scripts/check-gate-couplings.ts --check
npx tsx scripts/check-file-size-ratchet.ts
npm run check:monotonic-baselines
npm run check:pg-migration-safety -- --base origin/feat/v5-selfhost
npm run check:cross-family-audit -- --dev-model <dev> --audit-model <audit>

# 发布门与 CI 双向守恒
npx tsx scripts/check-release-gate-parity.ts

# 核心包单测与构建
npm run test:web-react && npm run build:web-react
npm run test:commercial:unit:gate
npm run test:gateway && node packages/cli/scripts/build-container-gateway.mjs
npm run test:protocol && npm run test:storage && npm run test:mcp-memory && npm run test:channels
```
