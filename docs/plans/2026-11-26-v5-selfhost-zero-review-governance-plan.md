# OpenClaude V5 selfhost 零人工看码自治治理与架构防腐化完整实施计划

- **制定日期**：2026-11-26
- **基线快照**：`feat/v5-selfhost @ 120d63ea1`（宿主仓库 `/opt/openclaude/openclaude-v5-selfhost`，live `rel-120d63ea1-20261126-103002`）
- **关联工单**：
  - 总纲 Epic：**`OCV5-903`**
  - Wave 1（P0 止血与裁判外置）：**`OCV5-904`**
  - Wave 2（P1 架构升级）：**`OCV5-905`**
  - Wave 3+4（P2 长期护城河 + 宿主物理控制面 + Ruleset 启用）：**`OCV5-906`**
- **适用边界（硬红线）**：
  - **仅限个人版 V5 selfhost**（`feat/v5-selfhost`、宿主 `/opt/openclaude/harness-gate/`、uid3 `/home/agent/.openclaude/`）；
  - **严格零触碰商业版生产**（`feat/v5-aurora-rewrite` 与商业生产机 `kl-mirror` 一律不动）。
- **授权记录**：2026-11-26 用户明确拍板全权授权落盘并全量落地（含 A0/L4 元层裁判外置、分支保护与定时任务重整）。

---

## 一、体检基线与核心诊断（2026-11-26 实测）

| 维度 | 2026-11-26 实测值 | 60 天趋势 / 风险本质 | 目标值 |
|---|---:|---|---|
| 生产代码总量（`.ts/.tsx`） | **1,003,714 LOC**（2,706 文件） | 60 天 +59.4%；`>1000` 行文件 121→219（翻倍） | 受控增速；新建 prod 文件 ≤800 行 |
| 近 2 周返工率（`fix+bug`） | **41.9%**（W47-48） | 6 周前 21.5%，周提交 821→150–227（失稳临界） | <30%（>35% 预警，连续 2 周 >40% 自动 Debt-First） |
| 架构违规基线存量 | **3,448 次**（`violations-baseline.json`） | 25 天裸奔暗增 +809；R2 结构耦合（975 次）4 天降幅 0 | 按 TTL 季度/月度单调净降，R2 每月必降 |
| 门禁-源码耦合 | **2,578 条**（453 门禁） | 35 天翻倍（1,309→2,578） | 增量受控、列车必检 |
| 生产 AI 代码坏味 | **1,587 空 catch / 971 as any+unknown / 1,320 `*Sync` / 465 disable** | 353 组 12 行克隆簇 + 93 组重复轮子（31 份 `sendJson`、20 份 `sha256Hex`） | 存量冻结单调降，增量零容忍 |
| 大文件 / 复杂函数 | Top 文件 13,972L / 10,671L；单函数 2,571L / CC=397 / 嵌套 11 | 20 个贴 3,000 线新上帝文件；红区 100L slack 吃光 | slack=0；新文件 ≤800L；新/改函数 ≤100L/CC≤20/嵌套≤5 |
| 发布列车 & CI 完整性 | 30 天失败率 **73.8%**（480 败 / 170 胜）；live `120d63ea1` CI 全红 | 零分支保护；4 天 bot 改 A 类 22 次；列车跑候选 `$staging` 脚本且不验 CI | 一次通过率 >80%；Ruleset+Auto-Merge；宿主外置裁判+CI 必绿 |
| 自进化闭环 | 近 3 个月自动合入 **0 件** | L4 死锁致 7–8 cron 停摆 9 周、熔断静默 40 天；L3 清债空白 | 每周 2–3 件受限微 PR 自动清债 + 存活自检 |

---

## 二、总体架构转型（三支柱 + 最小人类控制面）

1. **防失控元护栏（A0/A1 分离 + 宿主物理裁判外置）**：
   - 裁判从已验证 `$MASTER_LIVE_LINK` 或 root 只读 `/opt/openclaude/harness-gate/referee/` 执行，杜绝「运动员改裁判同提交过门」。
   - A0（真元层，物理硬锁需宿主 root 签章）：删门禁、放宽阈值/基线/slack、新增或续期豁免、增加 `modules.json` `allow` 边、修改 A0 裁判与计费/鉴权核。
   - A1（只严不松，全自动放行）：新增门禁、收紧阈值、拆分模块、单调消减基线、更新声明式 `deploy/v5/runtime-image-pin.json`。
2. **制度化跨家族架构看护员（Architecture Steward）**：
   - 按机械结构风险（触碰 Top-20 追加磁铁、新增/修改函数 >100L 或 CC>20、净增 >400L、跨 ≥2 模块、新增门耦合、命中克隆）自动触发，覆盖 T1 盲区；
   - 绑定 `commit_sha + 异家族实跑回执` 进入 CI 与列车硬门，拥有硬否决权，开发队长不得以 P2 风格单方驳回。
3. **自动化园艺清债闭环（Gardening Loop + Debt TTL）**：
   - 周一宿主自动跑 `arch-measure` + 基线统计产出 `arch-health.json`，按「磁铁分 × 债务 TTL」派发 2–3 件受限微 PR（硬限 ≤300 净行、≤5 文件、零行为变更、单调降基线）；单条失败仅冷却该条目 14 天不连坐全局。
4. **零看码人类控制面（4 驾驶舱信号 + 4 宿主物理总闸）**：
   - 4 信号周报：结构与返工晴雨表、交付与体验稳定度、算力与浪费护栏、元护栏完整性审计；
   - 4 宿主 root 物理总闸（`/opt/openclaude/harness-gate/bin/oc-governor`）：全局运行模式（`autonomous` / `debt_first` / `emergency_stop`）、A0 放宽审批签章、不可逆爆破半径硬锁、双重熔断与 5 行根因卡一键解锁。

---

## 三、分波次并行实施方案与零交集文件切分

### 并行执行拓扑（9 独立共享卷 Worktree 并行写手 → 1 专职 Integrator → T2 跨家族 Auditor → 上线激活）

| 轨道 / Worker | 对应阶段 & 工单 | 独立 Worktree | 独占文件所有权（零交集） | 核心交付物与验收门 |
|---|---|---|---|---|
| **T1 `ci-medic`** | P0 / `OCV5-904` | `gov-ci-medic` | CI 现有红灯失败测试的最小根因修复面、`.github/workflows/v5-integ-nightly.yml`、`.githooks/pre-push` | 定位并修复 `120d63ea1` 上 `Incident ledger` / `gate-couplings` / `release-gate-parity` / `web-react` / `commercial` / `v5-ops` / `gateway` 现存红灯；`v5-integ-nightly.yml` 纳管 `feat/v5-selfhost`；落地真 `.githooks/pre-push` |
| **T2 `a0-ratchet`** | P0 / `OCV5-904` | `gov-a0-ratchet` | `deploy/v5/runtime-image-pin.json`、`arch/a0-protected-paths.json`、`scripts/check-a0-monotonic.ts`、`scripts/check-file-size-ratchet.ts`、`.github/file-size-baseline.json`、`scripts/check-ai-smells-ratchet.ts`、`arch/ai-smells-baseline.json`、`.github/CODEOWNERS`、对应单测 | 镜像/CLI pin 声明化抽离；A0/A1 单调裁判器（正反例单测全绿）；`file-size-ratchet` slack=0 + 新 prod 上限 800L + 禁豁免自动续期；4 坏味零净增棘轮（空 catch / `as any`+`as unknown as` / `*Sync` / `disable`）+ 冻结基线；CODEOWNERS A0/A1 分层 |
| **T3 `train-referee`** | P0 / `OCV5-904` | `gov-train-referee` | `scripts/deploy-v5-selfhost.sh`、`scripts/lib/v5-selfhost-governance-gates.sh`、`scripts/v5-selfhost-master-release-lib.sh`、`scripts/v5-lease-worker.sh`、对应单测 | 读取 `runtime-image-pin.json`；裁判外置执行（`$MASTER_LIVE_LINK` 或 `/opt/openclaude/harness-gate/referee/`，带安全首滚自举）；发车前置硬验 GitHub CI 绿灯（仅 `--rollback` / root break-glass 豁免）；删自动路径 `OC_V5_SKIP_TRAILER_GATE=1`；补齐全部缺失硬门 + `--fail-on-expired`；切流后置接入 `run-retention.sh` 失败自动回滚；`v5-lease-worker.sh` 45s 防抖 + `planned` 自动快进最新绿灯 SHA + 尊重宿主 `oc-governor` 模式 |
| **T4 `arch-map-p1`** | P1 / `OCV5-905` | `gov-arch-map` | `arch/modules.json`、`scripts/check-architecture.ts`、`arch/file-cycles-baseline.json`、对应单测 | 前端 `web-views` F4 实拆为 `F0 primitives` + `F2 state` + 10 个平行 F4 业务域；`check-architecture.ts` 复用 Tarjan SCC 补齐文件级循环依赖禁令（冻结既有环零新增）与模块内子域边界检查 |
| **T5 `complexity-sec-p1`** | P1 / `OCV5-905` | `gov-complexity-sec` | `scripts/check-complexity-ratchet.ts`、`arch/complexity-baseline.json`、`scripts/check-clones-ratchet.ts`、`arch/clones-baseline.json`、`scripts/check-dead-code-weekly.ts`、`scripts/check-security-sast.ts`、`.github/workflows/v5-selfhost-security-weekly.yml`、对应单测 | TS AST 函数复杂度棘轮（新/改函数 ≤100L / CC_direct ≤20 / 嵌套 ≤5，冻结存量 217 大函数）；增量 12 行克隆零净增门；周度死码清单脚本；轻量密钥/高危 SAST 门（裸 SQL/命令注入/硬编码凭据/无界循环 I/O）+ 周度 gitleaks/CVE workflow |
| **T6 `steward-p1`** | P1 / `OCV5-905` | `gov-steward` | `scripts/check-cross-family-audit.ts`、`arch/append-magnets.json`、`scripts/arch-steward-review.sh`、`scripts/lib/archStewardContract.ts`、对应单测 | 升级 `check-cross-family-audit.ts` 为 CI+列车必检硬门（绑定 `head_sha` + 异家族实跑回执签名/校验）；确定性结构风险触发器（Top-20 磁铁 / 函数 >100L 或 CC>20 / 净增 >400L / ≥2 模块 / 新增门耦合 / 克隆命中）；架构看护员硬否决契约（开发队长不可单方驳回） |
| **T7 `gardening-p1`** | P1 / `OCV5-905` | `gov-gardening` | `scripts/gardening/*`、`scripts/check-cron-liveness.ts`、`packages/kernel/src/sharedUtils.ts`、`packages/kernel/src/index.ts`（仅追加导出）+ 首批低风险重复轮子收敛样本 + `workspace/self-evolve/` 升级草稿与 `cron.yaml` 4 节拍清单 | 周度 `arch-health-snapshot.ts` + 优先级排序（磁铁分×TTL）+ `run-gardening-dispatch.ts` + `verify-micro-pr-bounds.ts`（≤300L/≤5 文件/零行为变/单调降基线/失败 14 天单条冷却）；cron 存活自检；`@openclaude/kernel` 统一工具模块（`sha256Hex`/`asRecord`/`isRecord`/`errMsg`/`sleep`/`atomicWriteJson`/`sendJson`/`readBoundedJson`）并完成首批零风险调用点收敛 |
| **T8 `p2-fastcheck-ttl`** | P2 / `OCV5-906` | `gov-p2-fastcheck` | `packages/kernel/src/testing/pbt.ts`（或 `fast-check`）、4 条核心状态机属性测试（`packages/commercial/src/__tests__/prop.billingConservation.test.ts`、`prop.multiTenantIsolation.test.ts`、`packages/gateway/src/__tests__/prop.turnLeaseConvergence.test.ts`、`packages/storage/src/__tests__/prop.journalTapeRecovery.test.ts`）、`scripts/check-mutation-weekly.ts`、`arch/debt-ttl-policy.json`、`scripts/check-debt-ttl.ts`、对应单测 | 4 条高爆破半径核心状态机随机交错属性测试（接入 nightly）；周度增量 T2 变异抽检脚本；债务 TTL 衰减策略与检查器（月/季净降预算 + 连续 2 周返工 >40% 或过期 TTL 超限触发 `Debt-First` 阻断新 `feat(v5):` 直至返工 <30%） |
| **T9 `p2-telemetry-control`** | P2+控制面 / `OCV5-906` | `gov-p2-telemetry` | `packages/commercial/src/observability/archTelemetry.ts`、`scripts/v5-selfhost-refactor-metrics.py`、`scripts/v5-governance-cockpit-digest.ts`、`scripts/harness-gate/oc-governor.sh`、`scripts/harness-gate/sync-referee.sh`、对应单测 | 运行时 30 天零命中路由/Flag/Skill/Cron 遥测、`monitorEventLoopDelay` + 单请求 PG 查询预算探针、`sourceCommit`+模块隐性差评归因；周度 4 信号驾驶舱摘要器；宿主物理 4 总闸 CLI（`oc-governor`：全局模式/A0 签章/不可逆爆破半径护栏/双重熔断与 5 行根因卡）+ 裁判镜像同步器 |
| **T10 `integrator`** | 全量合流 / `OCV5-903` | `gov-int` | 独占中央共享注册表：`package.json`、`scripts/check-monotonic-baselines.ts`、`scripts/check-release-gate-parity.ts`、`.github/workflows/v5-selfhost-gates.yml`、`.github/workflows/v5-selfhost-release-gates.yml`、`.github/workflows/v5-selfhost-gate-receipts.yml`、`arch/gate-couplings.json`、`docs/V5_SELFHOST_PLAYBOOK.md`、`docs/plans/2026-11-26-v5-selfhost-zero-review-governance-plan.md` | 合并 T1–T9 全部分支，统一接线所有门禁脚本、基线单调注册、CI 工作流与三向守恒校验；跑暖缓存增量 `tsc` + 全新增/受影响单测 + `check:governance:fast` + `check-release-gate-parity` + 全套新棘轮验证 |

---

## 四、严格遵守的红队反模式（明确不做）

1. 不写 100 万行全量 Kani / TLA+ 形式化证明（`z3-solver` 留给科研审稿；平台锁定 4 条核心状态机属性测试即可）；
2. 严禁园艺 Agent 单 PR 大爆炸重写巨无霸文件（严格 ≤300 净行绞杀者微 PR）；
3. 绝不放开 A0 元裁判给 Agent 自改自松（靠 A0/A1 分层解决死锁，而非拆墙）；
4. 不把原 A 类全量锁回人工审签（防复发 9 周死锁）；
5. 不对无结构风险的 T0/T1 小改动强拉跨家族架构审查；
6. 不再造无消费方的只读死信周报，所有新规则一律「存量冻结单调降 + 增量零容忍」。

---

## 五、收口、审计、上线与激活验收顺序（防死锁安全时序）

1. **Wave 1–3 代码合流与自验**（`integrator`）：合并 T1–T9 到 `gov-int`，通过全部单测、增量 `tsc`、治理快门、架构门、三向守恒门。
2. **T2 四象限自检 + 跨家族独立 `auditor`（`gpt-6.2-astra`）`1+1` 审计**：
   - 四象限核验：① 无新字段旧缓存/旧基线/旧 live 脚本向后兼容（含首个部署滚动期裁判自举）；② 多流/大 diff/超上限分片与大仓库扫描性能预算；③ 乱序/并发列车合流/重复触发幂等性；④ 取消/异常退出锁释放与自动回滚干净收口。
   - 仅修真实 blocker 并做最多 1 轮增量复核关门。
3. **宿主物理控制面安装 + Harness/Cron 激活**：
   - 宿主机 root 安装 `/opt/openclaude/harness-gate/bin/oc-governor`、`/opt/openclaude/harness-gate/control/`（默认 `mode=autonomous`）与 `/opt/openclaude/harness-gate/referee/`；
   - 更新容器 `/home/agent/.openclaude/workspace/self-evolve/`（接 L3 园艺管线、清理 2 个陈旧死候选）与 `cron.yaml`（清理僵尸 job，保留 4 条清晰节拍 + 存活自检），登记 `self-evolve/ledger.md` 并 commit+push harness 仓；
   - 注册宿主 cron（周一 `arch-health-snapshot` + 园艺派单 + 4 信号驾驶舱周报）。
4. **合入 `feat/v5-selfhost` 并 Push + 验证 GitHub CI 全绿 + `oc-lease` 搭车上线**：
   - 先推送 `feat/v5-selfhost`，等待并确认 GitHub Actions 关键检查全绿（验证 `ci-medic` 与新门禁全部在真实 CI 上通过！）；
   - 走 `oc-lease.sh register --resource deploy:selfhost --mode ride` 搭车上线（带真实 `OC_USER_ID` + `OC_SESSION_KEY`）；
   - 上线后同步更新 `/opt/openclaude/harness-gate/referee/` 指向新 verified live，运行 `/opt/openclaude/harness-gate/run-retention.sh` 核验 6/6 PASS。
5. **激活 `feat/v5-selfhost` GitHub Ruleset（最后一步！防自锁）**：
   - 在确认 GitHub CI 全绿且 live 已切到含新治理体系的提交后，通过 GitHub API 为 `feat/v5-selfhost` 开启 Ruleset（强制 PR + Required Status Checks + 启用仓库 Auto-Merge，确保后续非 A0 放宽 PR 无人点选秒合、A0 放宽机械阻断）。
