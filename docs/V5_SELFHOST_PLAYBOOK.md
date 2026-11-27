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
- **前端细化分层（F0 → F5，`packages/web-react/src/`，已全量落地进 `arch/modules.json`）**：
  - `F0 web-primitives`：`components/ui/` + `lib/utils.ts` + `lib/ui/` + `styles.css` Token（零业务依赖）
  - `F1 web-lib`：`lib/`（排除 `lib/chat/` 与 `lib/timeline/`；唯一允许直接 `fetch` 的前端域）
  - `F2 web-state`：`lib/chat/`、`lib/timeline/` 与持久化/状态机（禁反向依赖 `F4`）
  - `F3 web-hooks`：`hooks/`（仅可依赖 `F0/F1/F2`，严禁反向依赖 `F4` 组件）
  - `F4 web-domains`：10 个严格平行业务域（`web-domain-chat | sidebar | workbench | swarm | sites | settings | manage | admin | iui | studio`，零新增 `allow` 边），跨域仅经 `F2` 事件/状态或公开入口
  - `F5 web-app`：`App.tsx` / `AppDialogs.tsx` / `appLazyViews.tsx` / `admin/{main,AdminApp,AdminShell}.tsx` 壳层装配，禁堆砌业务逻辑
- **文件级循环禁令与模块内子域边界**：`scripts/check-architecture.ts --enforce` 叠加 Tarjan SCC 全库文件级值导入环检测（`R2-file-cycle`，基线冻结于 `arch/file-cycles-baseline.json`，支持大型 SCC 严格子集拆分消债，新增环即红）以及 5 大后端模块（`interface-ws` / `platform-pg` / `gateway-core` / `gateway-runtime` / `interface-http`）内部 `subdomains` 边界检查（`R2-intramodule-boundary`，基线冻结于 `arch/subdomain-violations-baseline.json`）。
- **跨包导入与共享工具硬规**：全仓严禁跨包相对路径导入，一律使用 `@openclaude/<pkg>`；跨包通用纯工具（`sha256Hex` / `asRecord` / `isRecord` / `errMsg` / `sleep` / `atomicWriteJson` / `readBoundedJson` / `sendJson`）统一沉淀于 `packages/kernel/src/sharedUtils.ts`；变更 `gateway`/`protocol`/`storage`/`cli` 后必须跑 `node packages/cli/scripts/build-container-gateway.mjs`。

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
- **主开发自写 + 跨家族架构看护员（Architecture Steward）硬门**：主战模型在共享卷 worktree 亲自写码；当改动命中 `scripts/lib/archStewardContract.ts` 6 条确定性结构风险触发器之一（Top-20 `arch/append-magnets.json` 追加磁铁非净减行修改、净增生产代码 `>400` 行、跨 `>=2` 个架构模块、函数超 `100` 行或 `CC_direct > 20`、触碰门禁耦合、12 行克隆/T2 核心路径）时，PR CI（`--enforce-pr` 绑定真实 `pull_request.head.sha`）、push CI 与发布列车（`--enforce-commit`）强制校验绑定精确 40 位 `headSha` 的跨家族看护员只读回执（宿主 root 只读 `/opt/openclaude/harness-gate/steward-receipts/<sha>.json` 或提交外 GitHub Commit Status `oc-v5/arch-steward`，生产 schema `oc.v5.arch-steward-receipt/1`），同家族自审、弱模型、旧 SHA 重放、篡改摘要、`--dry-run` 预演回执（独立非生产 schema `oc.v5.arch-steward-dry-run/1`）、仓内未签名文件或 `veto` 不可绕过硬拒；0/6 触发的常规低风险改动秒级零开销放行。开发者可用 `scripts/arch-steward-review.sh --author-model <slug> --publish-github-status` 跑真实四维看护员审查并签发回执。
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
- **确定性防假绿与结构质量硬门**：
  - 防假绿与属性/变异测试：`npm run check:v5:regression-contracts`（SHA-256 锁定 + 负例变异证明）、`npm run check:test-retries`（封堵静默 retry）、`npm run lint:integ-tiers`（集成测试梯队全登记）、轻量确定性状态机属性测试引擎 `packages/kernel/src/testing/propertyCheck.ts` 驱动 4 条高爆破半径核心状态机属性测试（计费守恒、多租户隔离、Turn/Lease 收敛、Journal/Tape 恢复，PR 默认 200 runs / Nightly `PBT_RUNS=2000`），以及周度增量变异抽检 `scripts/check-mutation-weekly.ts`（`npm run check:mutation:weekly`）；
  - 零松弛止血与结构质量棘轮：
    - `scripts/check-file-size-ratchet.ts`（`npm run check:file-size`）：红/黄/橙三区 `slack=0`，新生产 `.ts/.tsx` 硬限 `<=800` 行，既有 801–1,999 行冻结零净增，禁止豁免续期；
    - `scripts/check-ai-smells-ratchet.ts --enforce`（`npm run check:ai-smells`）：TS AST 拦截 4 项 AI 坏味（空 `catch`、`as any`/`as unknown as`、同步 I/O、lint 静默抑制）零净增（基线 `arch/ai-smells-baseline.json`）；
    - `scripts/check-complexity-ratchet.ts --enforce`（`npm run check:complexity`）：函数级 `(100 行, CC_direct<=20, 嵌套<=5)` 棘轮（基线 `arch/complexity-baseline.json`）；
    - `scripts/check-clones-ratchet.ts --enforce`（`npm run check:clones`）：12 逻辑行跨文件克隆零净增（基线 `arch/clones-baseline.json`）；
    - `scripts/check-security-sast.ts --enforce`（`npm run check:security-sast`）：确定性密钥泄漏零容忍 + SQL 拼接 / Shell 注入 / 无界循环串行 await 棘轮（基线 `arch/security-sast-baseline.json`），叠加周度 `.github/workflows/v5-selfhost-security-weekly.yml`（gitleaks + 死码清单 `scripts/check-dead-code-weekly.ts` + `npm audit`）。

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

### 6.1 防线 1：A0 / A1 / Class B 单调分层（`arch/a0-protected-paths.json` + `.github/CODEOWNERS`）

为同时实现「元护栏零被篡改」与「常规加门/清债/升级免人工瓶颈」，将原 A 类拆分为 **A0（真元层）** 与 **A1（机械单调自证层）**，由 `scripts/check-a0-monotonic.ts`（`npm run check:a0-monotonic`）在 PR CI 与发布列车硬裁决：

- **A0（静态锁进 `.github/CODEOWNERS` 与 `arch/a0-protected-paths.json`，强制 `@dream-star-end` 对精确 `prHeadSha` 的 PR `APPROVED` 审签、或提交外 GitHub Commit Status `oc-v5/a0-approval`、或宿主 root `oc-governor approve-a0` 签发的 `a0-approval-v1` / HMAC 回执）**：
  - 10 类真元层：A0 裁判自身（`scripts/check-a0-monotonic.ts`、`scripts/lib/a0MonotonicRules.ts`、`scripts/lib/a0ApprovalReceipt.ts`、`scripts/lib/githubTrustedApproval.ts`、`arch/a0-protected-paths.json`、`.github/CODEOWNERS`）；核心单调与棘轮检查器及其支撑库；CI Workflows 与发布门清单（`.github/workflows/`、`.github/scripts/`、`deploy/v5/selfhost-release-gates.json`、`biome.json`）；宿主控制面、发布编排与列车护栏（`scripts/harness-gate/`、`scripts/deploy-v5-selfhost.sh`、`scripts/v5-selfhost-master-release-lib.sh`、`scripts/v5-selfhost-migration-*.sh`、`scripts/v5-lease-worker.sh`、`scripts/lib/v5-lease-train-debounce.sh`、`scripts/lib/v5-selfhost-*.sh`）；事故账本冻结锚点；计费核心 7 文件；权限与契约核；豁免续期与 known-failures；`changelog.json`；以及删改任何既有门禁脚本（对 git `R` 重命名两端均按删除与新增分类校验）。
- **A1（不锁进 `CODEOWNERS`，由 `scripts/check-a0-monotonic.ts` 机械校验后自动放行）**：
  - 声明式镜像/CLI 版本 pin：`deploy/v5/runtime-image-pin.json`（强校验 schema + 禁 `:latest` 与非法镜像源，彻底替代直接改 `deploy-v5-selfhost.sh`；正向列车严格按 `git show <target_sha>:deploy/v5/runtime-image-pin.json` 绑定目标 commit，`--rollback` 优先读历史 release 元数据与脏工作树隔离）；
  - 新增门禁脚本（status `A` 的 `scripts/check-*.ts` / `scripts/check-*.sh`）；
  - 不新增 `allow` 边、不新增 `authorities`、不抬高 `layer`、不扩宽 `scope` 的 `arch/modules.json` 模块拆分与子域细化；
  - 单调收紧 `packages/web-react/budgets.json`、`.github/context-eval-baseline.json` 与 `packages/web-react/design-tokens-exempt.json` 删减。
- **Class B（单调只降不升债表，不进 `CODEOWNERS`，由 `scripts/check-monotonic-baselines.ts --base` + 各棘轮门机械防抬升）**：
  - `.github/file-size-baseline.json`（三区 `slack=0`）、`arch/violations-baseline.json`、`arch/file-cycles-baseline.json`、`arch/subdomain-violations-baseline.json`、`arch/ai-smells-baseline.json`、`arch/complexity-baseline.json`、`arch/clones-baseline.json`、`arch/security-sast-baseline.json`、`arch/gate-couplings.json`、`packages/web-react/design-tokens-counts.json`、`packages/web-react/ui-static-baseline.json`、`packages/web-react/layout-invariants-baseline.json`、`deploy/v5/feature-flags-registry.json`（`--fail-on-expired`）、`e2e/session-display/incidents.json`、`e2e/session-display/regression-contract-locks.json`。

### 6.2 防线 2–5：宿主物理外置裁判、宿主 4 总闸、债务 TTL 与自治园艺闭环

2. **防线 2（`--base` 单调校验 + 债务 TTL 衰减）**：CI 与列车相对 `origin/feat/v5-selfhost` 执行 `check-architecture.ts`、`check-file-size-ratchet.ts`、`check-monotonic-baselines.ts`（纳管全部 11 份基线/预算/Flag 表）、`check-a0-monotonic.ts` 及 `check-debt-ttl.ts --enforce --base <base> --head <head>`（`arch/debt-ttl-policy.json`：月度违规/R2/大文件衰减棘轮；`emergency_stop` 恒阻断；`debt_first` 仅拦截 `feat(...)` 与非法前缀，放行预算达标或净清债的 `bug/fix/refactor/...` 修复提交）。
3. **防线 3（宿主机物理外置隔离裁判 + 共同正向切流护栏 + 封堵逃生口）**：发布列车在 `scripts/lib/v5-selfhost-governance-gates.sh` 强制从宿主 root 只读外置裁判 `/opt/openclaude/harness-gate/referee`（由 `scripts/harness-gate/sync-referee.sh` 同步；元层/schema 首滚须经 `sync-referee.sh --stage-audited` 预装绑定精确 `targetSha` 与 A0 审签的 `TRANSITION_APPROVAL.json` + `MANIFEST.json`，严禁旧门失败回落候选）执行完全隔离的裁判视图（解释器 `tsx`/`biome` 与依赖 100% 来自可信裁判环境，候选仅作为显式只读 `--root "$staging"` 数据根传入并断言 `gatewayFiles > 0`）；`scripts/lib/v5-selfhost-train-guards.sh` 在 `cmd_deploy` 与独立正向 `cmd_cutover` 持锁改 live 前共同强制执行 Governor `mode.json`、物理调用 `oc-governor check-blast-radius`、校验目标 SHA 可信事件（`push`/`pull_request`/`merge_group`，拒 `workflow_dispatch`）的 3 条必需 CI workflow（`V5 selfhost gates`、`V5 selfhost release gates`、`V5 selfhost commercial`）全绿及 retention runner 预检；切流后在持久化 `verifying` 态先验 `/healthz` 与保留集全绿才 `committed` 结算，失败立即官方 `--rollback` 并将原 train 原子落定为 `failed`（回滚失败则进入 `recovery_required` 暂停正向切流）；`scripts/lib/v5-lease-train-debounce.sh` 对当前远端 tip 做 `success`/`pending`/`failed` 三态分类（`pending` 保持 `registered` 不误标失败）并在 SQLite 事务内 CAS 快进。
4. **防线 4（双轨独立执行、回执与自治园艺清债）**：本地快门仅用于 Shift-Left 提速，绝不替代 GitHub Actions Runner 与宿主外置裁判复验（`.github/workflows/v5-selfhost-gate-receipts.yml`）。园艺闭环由 `scripts/gardening/arch-health-snapshot.ts`、`scripts/gardening/verify-micro-pr-bounds.ts`（硬限 `netLoc<=300`、`<=5` 文件、必净降基线）、`scripts/gardening/run-gardening-dispatch.ts`（单条 14d 隔离冷却）与 `scripts/check-cron-liveness.ts`（监控启用 Cron 停跑 >2×周期）驱动，配合 `packages/commercial/src/observability/archTelemetry.ts` 运行时遥测与 `scripts/v5-governance-cockpit-digest.ts` 周度 4 信号高管驾驶舱。
5. **防线 5（宿主物理 4 总闸控制面 `scripts/harness-gate/oc-governor.sh`）**：通过 `sudo bash scripts/harness-gate/install-host-control-plane.sh --sync-referee` 安装到 `/opt/openclaude/harness-gate/`（root 属主，容器不可写）：① **总闸 1（运行模式）**：`oc-governor mode [autonomous|debt_first|emergency_stop]`；② **总闸 2（A0 签批）**：`oc-governor approve-a0 --sha <40hex> [--publish-github-status]` 签发 `a0-approval-v1`（含 `allowedPaths` 与可选 `0600` `.hmac-key` HMAC-SHA256，与 TS 验签字节等价）；③ **总闸 3（爆破半径硬拒）**：`oc-governor check-blast-radius` 接入共同正向切流护栏，物理拒绝商业分支与无凭证破坏性 DDL/计费核心变更；④ **总闸 4（回滚与成本熔断）**：7d 生产回滚 ≥2 次自动切 `debt_first` 并生成 5 行 `control/breaker-card.md` 待人工 `unlock-breaker`。

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

# 架构边界、门禁耦合、文件棘轮、跨基线单调校验、A0 裁判、质量棘轮与跨家族看护员
npx tsx scripts/check-architecture.ts --enforce
npx tsx scripts/check-gate-couplings.ts --check
npm run check:file-size
npm run check:monotonic-baselines
npm run check:a0-monotonic
npm run check:ai-smells
npm run check:complexity
npm run check:clones
npm run check:security-sast
npm run check:debt-ttl
npm run check:pg-migration-safety -- --base origin/feat/v5-selfhost
scripts/arch-steward-review.sh --author-model <dev-model>

# 园艺健康、Cron 存活、周度变异抽检、4 信号高管驾驶舱与本地 pre-push 钩子
npm run check:cron-liveness
npm run check:dead-code
npm run check:mutation:weekly
npm run check:cockpit-digest
git config core.hooksPath .githooks

# 发布门与 CI 双向守恒
npx tsx scripts/check-release-gate-parity.ts

# 核心包单测与构建
npm run test:web-react && npm run build:web-react
npm run test:commercial:unit:gate
npm run test:gateway && node packages/cli/scripts/build-container-gateway.mjs
npm run test:protocol && npm run test:storage && npm run test:mcp-memory && npm run test:channels
```
