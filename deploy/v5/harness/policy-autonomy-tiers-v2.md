# V5 自用实例 · Harness 自进化分层自治策略 v2（A0/A1 分离 + L3 园艺微 PR）

> 生效范围：仅限个人版 V5 自用实例（`uid3`，`openclaude-v5-selfhost`，分支 `feat/v5-selfhost`）。
> 严禁触碰商业版分支 `feat/v5-aurora-rewrite` 与商业生产机 `kl-mirror`。
> 版本：v2（2026-11-26，OCV5-905）。替代 v1（2026-08-27），根治 L4 一刀切死锁与 L3 技术债清零真空。

---

## 一、五层进化对象与 A0 / A1 元层解耦

为消除 v1 中「改一行镜像 pin 或加一道更严检查也卡死人工审批」的 9 周死锁，原 L4 元层与仓库门禁拆解为 **A0（真元层）** 与 **A1（单调收紧层）**：

| 层级 | 覆盖对象 | 自治度 | 强制硬门与宿主机裁判 |
|---|---|---|---|
| **L1 内容层** | `skills/`、`agents/*/memory`、prompt 片段 | 全自动（候选区 → 过门 → 合入） | skill evals + 6/6 行为保留集 + 防漂移 lint |
| **L2 配置层** | model catalog、`cron.yaml`（4 节拍内参数）、`agents.yaml`、tier 参数 | 全自动 | YAML/JSON schema 校验 + `check-cron-liveness.ts` + 6/6 保留集 + 自动回滚 |
| **L3 代码层 · 展示与园艺微 PR（白名单内）** | 纯展示组件 + **5 类受限园艺清债微 PR**（见第二节） | **全自动至 PR Auto-Merge 与搭车发布** | `verify-micro-pr-bounds.ts` + 单包测试 + 全套单调棘轮 + 外置宿主裁判 + 切流后保留集 |
| **L3 代码层 · 核心业务（T2 白名单外）** | 网关核心生命周期、协议/schema/migration、计费账本、账号池、egress、发布列车脚本、Top-10 巨型上帝文件 | 自动推进至「PR + CI 全绿 + 跨家族看护员签收」，合并/高危动作守物理边界 | 完整发布列车 + 跨家族 `Architecture Steward` 硬签收（`check-cross-family-audit.ts --enforce-commit`） |
| **A1 单调收紧层（原 L4 只严不松子集）** | `deploy/v5/runtime-image-pin.json`、新增 `scripts/check-*.ts`、收紧阈值/上限（如 `slack=0`）、拆分 `arch/modules.json`（不新增 `allow` 边）、单调消减各 `*-baseline.json` | **全自动放行**（由 `check-a0-monotonic.ts` AST/JSON 机械证明只严不松） | `check-a0-monotonic.ts` + GitHub Required Checks 全绿 |
| **A0 真元护栏层（物理硬锁）** | 删除门禁、放宽阈值/基线/slack、新增或续期豁免、向 `arch/modules.json` 新增 `allow` 边、修改 `check-a0-monotonic.ts` / `a0-protected-paths.json` / 保留集断言 / 本策略 / 计费与鉴权核心 | **永远人工批 + 宿主机 root 签章** | 必须持有宿主机 `/opt/openclaude/harness-gate/bin/oc-governor approve-a0 --sha <40hex>` 签发的 root 只读审批回执；评审器永不自批 |

---

## 二、L3 受限园艺微 PR 规则（Gardening Loop）

除 v1 原有的纯展示层（`packages/web-react/src/components/**` 纯视图与 adapter 格式化纯函数）外，**L3 新增「受限园艺清债微 PR」通道**，专门自动化偿还每周 `arch-health.json`（`magnetScore × ttlUrgency`）排出的高优技术债：

### 2.1 允许自动执行的 5 类园艺任务
1. `wheel-consolidation`：将散落在 `packages/gateway` / `packages/commercial` 非上帝文件中的重复工具函数（`sha256Hex`、`asRecord`、`isRecord`、`errMsg`、`sleep`、`atomicWriteJson`、`readBoundedJson`、`sendJson`）收敛至 `@openclaude/kernel` 单一权威导出；
2. `dead-code`：清理 `check-dead-code-weekly.ts` 与 30 天运行时遥测双重确认零引用的死导出/孤立模块；
3. `r2-export-star`：将模块 `index.ts` 中的 `export *` 通配桶展开为显式具名导出，单调核减 `arch/violations-baseline.json`；
4. `r3-env`：将业务模块散落的裸 `process.env.*` 收敛为配置注入，单调核减 `R3-env` 基线；
5. `strangler-extract`：对非 Top-10 超标/高耦合文件执行**绞杀者纯叶节点抽离**（严禁大爆炸重写）。

### 2.2 四条机械硬红线（由 `scripts/gardening/verify-micro-pr-bounds.ts` 强制阻断）
每件 L3 园艺微 PR 必须同时满足：
1. **代码体量硬上限**：非基线代码变更 `netLoc <= 300`（且 `added <= 300`、`totalChurn = added + deleted <= 600`），优先净减行；
2. **爆炸半径硬上限**：非基线文件数 `touchedFiles <= 5`（仅 `wheel-consolidation` 纯机械 `import` 替换允许放宽至 `<= 8` 文件，混入任何非机械逻辑重写立即阻断）；
3. **断言与门禁神圣不可侵犯**：严禁删除/弱化既有测试断言、严禁加 `.skip/.only`、严禁触碰 `scripts/check-*` / `.github/workflows/*` / `arch/modules.json` 等门禁与 A0 文件；
4. **基线严格单调下降**：所有基线零上涨，且至少一项治理基线严格下降（`minBaselineDelta < 0`）。

> **明确排除（仍留 T2）**：Top-10 巨无霸上帝文件的核心状态重写、跨模块协议变更、数据库 DDL/migration、计费扣池核心、外置发布脚本。

---

## 三、单条 14 天隔离冷却 vs. 全局双重熔断（消除连坐死锁）

v1 中「单次候选门禁失败或回退导致全平台静默停摆 40 天」的连坐机制正式废止，升级为两级隔离机制（由 `scripts/gardening/run-gardening-dispatch.ts` 与宿主机 `oc-governor` 协同执行）：

1. **单条 14 天隔离冷却（Per-Item Cooldown）**：
   - 当某件园艺微 PR 在门禁、CI 或单次验证中失败/回退时，仅将该条目的唯一 `itemKey`（如 `wheel-consolidation:packages/gateway/src/foo.ts`）记入 `cooldown.json`，**单独冷却 14 天**；
   - 队列中其他互不相关的清债条目与日常 L1/L2 自进化正常推进，**绝不连坐冻结全平台**。
2. **全局熔断与自动 Debt-First 模式（Host Governor 物理接管）**：
   - **回滚熔断**：仅当 **7 天内生产真实回滚 `>= 2` 次** 时，触发全局熔断并生成 5 行根因卡（`breaker-card.md`），暂停自动合入直至人工执行 `oc-governor unlock-breaker`；
   - **返工率 / TTL 自动 Debt-First**：当近 14 天 `fix+bug` 返工提交占比连续超 `40%` 或债务 TTL 过期数超限时，切换至 `debt_first` 模式（阻断新 `feat(v5):` 提交，但**继续放行** `refactor/bug/chore` 清债微 PR，越乱越优先清债）；
   - **紧急停机**：`oc-governor mode emergency_stop` 时，`run-gardening-dispatch.ts` 与发布列车立即跳过一切自动派单与发车。

---

## 四、周度自治预算与 4 节拍巡检闭环

- **周度预算**：
  - L1 + L2 自动合入：`<= 10` 件/周；
  - L3 园艺微 PR：每周一由 `run-gardening-dispatch.ts` 自动从 `arch-health.json` 挑选未冷却的 Top `2–3` 件挂 `OCV5` 单（labels: `self-evolve,gardening,l3-micro-pr`）派发执行。
- **4 节拍防静默巡检**（详见 `deploy/v5/harness/cron-recommended-cadence.yaml`）：
  1. **小时级**：`butler-light`（宿主/容器健康 + `check-cron-liveness.ts` 检测任意 `enabled: true` 任务停跑 `> 2 × 周期` 即刻 `crit` 微信告警，彻底杜绝 9 周静默停摆）；
  2. **日级**：`daily-friction-triage`（每日 06:30 摩擦信号聚合 + 高置信 `OCV5` 提单 + 核心记忆去重）；
  3. **周级清债与驾驶舱**：`weekly-gardening-and-cockpit`（周一 08:00 产出 `arch-health.json` + 派发 2–3 件园艺微 PR + 推送 4 信号高管驾驶舱卡片）；
  4. **周级防漂移与保留集**：`weekly-antidrift-retention`（周一 09:30 跑宿主机 `run-gates.sh` 6/6 行为保留集 + 记忆归档裁剪 + 预算/熔断账本核验）。
