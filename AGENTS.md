# OpenClaude 源码工程导航地图（Map, Not Manual）

> **定位声明**：本文是**代码仓库改码工程导航**，服务于所有在源码库开发/审查的 Coding Agent（**不是**容器运行时助手提示词 `/opt/openclaude/AGENTS.md`）。共享分支与紧急通道规则见 `CLAUDE.md`（若两处有差异，遵循更严者）。

## 1. 30 秒极速执行路由卡（V5 Selfhost `feat/v5-selfhost`）

| 改动范围 | 分级 & 提交前缀 | 动工前必读 | 本地秒级快门 | PR CI 与熔断 |
|---|---|---|---|---|
| 换 env/文案/Logo/文档 | **T0**<br>`chore/docs(v5):` | 本文 | 相关单测 + `npm run check:docs-links`（`<15s`）；**不上审** | 变更 Biome + 文档死链；绿灯自动合 |
| 单包 UI/组件/局部 Bug（不动协议/迁移） | **T1**<br>`ui/bug/perf/refactor(v5):` | `docs/UI_DESIGN_SYSTEM.md` + 包级 `AGENTS.md` | 目标包单测 + 增量 `tsc` + `npm run check:ui-gates`（改入口/CSS 加 `npm run build:web-react`）；**不上审** | `test:web-react` / `test:browser` 既有套件 + L1 静态门 / 选择器 / 几何 a11y 纯引擎单测（L2/L4 实景脚本本地按需跑，待 P1-3/P1-4 接 CI）；非必需红必核因；**CI 2 轮熔断转人** |
| 跨包/`gateway`/协议/存储/计费/迁移/权限 | **T2**<br>`bug/perf/refactor(v5):`（真线上事故复盘才用 `fix(v5):` + `Incident: INC-...`） | `docs/V5_SELFHOST_PLAYBOOK.md` + 包级 `AGENTS.md` | 以上 + `npm run check:governance:fast` + `node packages/cli/scripts/build-container-gateway.mjs` + **跨家族审（`1+1` 上限）** + 重型 proof 定稿单跑 1 次 | 全量静态门 + 迁移兼容 + 单包单测 + 回归契约；**CI 2 轮熔断转人** |
| **A 类 `CODEOWNERS`**（门禁/工作流/预算/豁免/发布脚本/权限核心/`changelog.json`）、商业生产 | **L4 人工红线** | `docs/V5_SELFHOST_PLAYBOOK.md` | 仅候选分支准备 PR + 完整证据，**严禁自批自合** | 全量 `--base` 单调校验 + **强制 `@dream-star-end` 人工审签** |

## 2. 十大北极星红线（一句话钩子）

- **P1 强模型主权**：主脑、`/btw`、Cron、`ai_review` 严禁黑盒降级弱模型，不写死思考深度（`npm run check:no-weak-downgrade`）。
- **P2 Clarvy Atelier 设计感**：组件级精雕暖中性双主题，拒绝仅换暖色与主聊/二级页断层（`docs/UI_DESIGN_SYSTEM.md`）。
- **P3 零学习成本无限续聊**：后台静默压缩/合并/可逆归档，禁向用户暴露 `checkpoint_reset`、80% 催压缩横幅。
- **P4 结果先于过程与红卡不可变**：单过程区线性流 + 极简完成单行；「厨房 ≠ 上桌」；计划重启不出红，真故障红卡不可变，工具报错中性折叠。
- **P5 空间工作台与对话内闭环**：左指挥右 Workbench（移动 2-Bar）+ `present_task_approval` 对话内审批，禁割裂跳页。
- **P6 交互与状态不变量**：聊天 `scrollTop` 仅由 `controller` 单 writer 写入；全链 Owner 围栏；嵌套弹窗留父子树；禁裸 `React.lazy`。
- **P7 测试证明真实业务结果**：真实入口 + 真实终态 + 有效红绿负控，禁止 mock/假绿；推送 ≠ 过测 ≠ 上线 ≠ 容器生效。
- **P8 机制替代纪律**：遵守 `T0/T1/T2` 快车道、`1+1` 审计硬上限与 Lease 搭车（`scripts/oc-lease.sh`），禁轮询烧 token。
- **P9 边界安全与人类主权**：`EnterPlanMode` 必经用户同意；顾问/只读执行端硬禁写；三套环境零串套；商业生产只读诊断优先。
- **P10 L4 元层隔离防改门凑绿**：A 类门禁/预算/豁免/发布脚本仅人可批；B 类基线只降不升；一周 ≥2 次回滚自动熔断。

## 3. 权威文档与包级地图

- **V5 个人版（Selfhost）总手册**：`docs/V5_SELFHOST_PLAYBOOK.md`（架构分层、高可靠 5 律、状态四象限、迁移三问、A/B 防篡改、L4 决策边界）
- **UI/UX 设计与门禁宪章**：`docs/UI_DESIGN_SYSTEM.md`（Clarvy Atelier、`--z-*` 11 档、5+1 字号、交互铁律、6 层 UI 硬门禁）
- **V5 商业版（Aurora）总手册**：`docs/V5_DEV_PLAYBOOK.md` 与 `docs/V5_ROADMAP_2026H2.md`（商业版任务开工必读）
- **跨分支规则与紧急通道**：`CLAUDE.md`（含 dx 声明的 P0 emergency lane、工作树与 `changelog.json` 审批制度）
- **包级高频红线指南**：`packages/web-react/AGENTS.md` | `packages/commercial/AGENTS.md` | `packages/gateway/AGENTS.md`
- **一键秒级治理快门**：`npm run check:governance:fast`（涵盖 `scripts/check-docs-links.ts`、`scripts/check-ui-hard-gates.ts`、`scripts/check-no-silent-model-downgrade.ts`、`scripts/check-v5-route-sync.ts`、`scripts/check-changelog-guard.ts`、`scripts/check-feature-flags-ttl.ts` 等）；架构与棘轮门：`scripts/check-architecture.ts`、`scripts/check-gate-couplings.ts`、`scripts/check-file-size-ratchet.ts`、`scripts/check-monotonic-baselines.ts`。

## 4. 分支、Worktree 与诊断只读边界（BLOCKING）

- **三线隔离**：Selfhost=`feat/v5-selfhost`（uid=3 共享卷 `/home/agent/.openclaude/workspace/wt-<ticket>` + 暖 `dist-types`/`.tsc-cache`，禁 host 私有 `/opt/openclaude/wt-*`）；商业版=`feat/v5-aurora-rewrite`；Windows App=`feat/v5-windows-app`（分支 `<type>/v5-windows-<slug>`，禁进 server 发布队列或 `scripts/deploy-v5.sh`）。
- **并发与工作树**：并行/主树脏时强制独立 git worktree；多会话触碰面有交集强制串行；不得覆盖他人改动；详细命令见 `CLAUDE.md`。
- **只读诊断红线**：「看下/啥问题/是否正常/先告诉根因」仅授权只读，禁部署、回退、重启或写生产数据；健康目标由 `deploy_state.active_slot` 推导；production mutation 唯一 owner 为持有官方 flock 且 lease fencing meta（`deploy_id`）+ invocation nonce 与 marker 匹配的进程，未证实 owner 保持只读。
- **`changelog.json`**：`releases[]` 必须由 boss 决定，AI 严禁擅改（`npm run check:changelog-guard`）。

## 5. 用例卫生（BLOCKING，OCV5-343）

- 改动导致已有用例**过期**（行为有意变化）→ 同 PR 更新断言并写明依据；**无用**（功能删除/重复）→ 删除；断言仍正确 → 修产品，**严禁为凑绿放宽或删有效用例**。
- `npm run test:web-react` 必须 100% 全绿，「与基线相同、0 新增」不合格（受 `.github/workflows/v5-selfhost-web-react.yml` 守卫）。

## 6. Codex 审查核心规则（BLOCKING）

被要求「审查/review/审计」时按本节执行（不改变 CI、事故证明或发布脚本门禁；「Codex 审计 PASS」= 输出 `APPROVED`）：
1. **范围**：仅审本次 diff 及直接调用方/被调用方；既有老问题最多单行列入「非阻断」。
2. **严重度**：仅 **P0/P1**（正确性/崩溃/丢数/安全/计费/数据完整性/门禁被削弱或绕过）阻断；风格/命名/锦上添花测试一律 P2 非阻断。
3. **轮次记忆与上限**：第 2 轮起只核上轮 P0/P1 修复及新增 diff，不重提已定设计决定。V5 Selfhost T0/T1 不上审，**T2 硬上限 `1+1`**（1 轮首审 + 最多 1 轮增量复核，到上限由队长三判裁决）；商业版小改 1 轮、大改最多 3 轮。
4. **用例卫生即 P1**：改行为未同 PR 同步过期用例或令 `npm run test:web-react` 变红，按 P1 报并给出失败用例名。
5. **固定输出**：无 P0/P1 仅首行 `APPROVED`（可选「非阻断:」单行列 P2）；有 P0/P1 首行 `REQUEST_CHANGES`，逐项 `[P0|P1] 文件:行 — 原因 — 复现(输入/状态 → 错误结果)`（无复现降为非阻断）；沙箱跑不了测试仅说明一次。
6. **统一调用**：`scripts/codex-review.sh --base <ref> --round <N> --max-rounds <M> [--prev <file>] [--decisions <file>] [--focus <msg>] -o <out>`。
