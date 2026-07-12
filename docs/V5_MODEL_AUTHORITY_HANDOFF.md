# 模型权威批次 · 交接文档（2026-07-12 阶段性收尾）

分支 `feat/v5-model-authority`（worktree `/opt/openclaude/openclaude-v5-modelauth`）
基于 canonical `c67b9428`。**代码全绿、未合并、未部署、零现网影响**（所有新机制默认关）。

## 一、这批在做什么

根治「模型清单散在 6 处人工同步」+「可路由（编译期硬编码，改要重启+重建镜像）与
可计费（DB 热重载）分裂」。目标：既有 provider 内加/停/改模型 = 纯 DB 操作全链热生效。

核心机制（设计审 5 轮 PASS，方案见 `docs/V5_MODEL_AUTHORITY_PLAN.md`）：
1. **model_catalog 单一权威**（版本化 entry_id + state 状态机 + DB trigger 强制 + security_epoch）
2. **Ed25519 签名 execution descriptor**：bridge 每 inbound 铸票，容器该 turn 全部执行语义
   取自 descriptor（不查本地 catalog）→ master 计费判定与容器执行判定物理同一次判定
3. **双进程 epoch fence**（master + egress）：每请求直读单行 epoch，安全变更零 stale 窗口
4. **六步上线 + 四面兼容地板**（DB/master/egress/runtime release）

## 二、已完成（代码全绿）

| 面 | 内容 | 测试 |
|---|---|---|
| DB | 0135 catalog/aliases/epoch + 0136 guards（状态机 trigger、权限边界、grants epoch） | 真 PG：guards 24/24、catalog 33/33、admin 12/12 |
| protocol | modelAuthority.ts（JCS/验签/lease/auxModels） | 36 |
| master | authoritySigner（keyring/轮换/census）、bridge 签发+fence+补偿、admin catalog 入口、投影收口 | signer 20、bridge 21、codex billing 42、admin 5 suite |
| egress | 每请求 fence + 验票 + provider_id 数据驱动路由 + capability 上限 + usage 四列 | gate 29 |
| 容器 | catalog client（TTL/LKG/epoch 验证）、验签消费（WeakMap/replay/水位）、本地路径投影判定、CCB per-turn 票据（stdin env 通道） | gateway 1741 全绿 |
| seed | schema v2 声明化 + master 按容器实际 bundle_rev 推导 | 87 + 8 |
| 部署 | release-metadata capability、四面 preflight、flag 开关、cutover marker、不可逆地板 | drill 160、v5ReleaseSafety |

**四层测试**：tsc 0 / gateway 1741 / storage 292 / commercial gate「PASS: no new failures beyond baseline」

## 三、剩余工作（交接给下一位）

### A. Codex 代码审 R2（必须，R1 已整改完但未复审）
`mcp__codex__codex-reply` 续 thread `019f560c-ff93-7fd1-8072-493559bae509`，
发增量 `git diff a766229f^..a766229f`。R1 是 3B+8M+6m 全整改，需复审确认闭合。

### B. R1 遗留的两个 MAJOR（因文件冲突未做，现在无冲突可做）
1. **MAJOR-4 descriptor 未真正完整消费**：gateway 只消费了 signed engine/model/effort；
   `contextWindow`/vision/capability_profile **没有进入 CCB spawn override**（CCB 仍读本地
   staticKeyModels 表）。`context_window=NULL` 被签成自造语义的 `0`（协议应显式表达 NULL）。
2. **MAJOR-6 codex usage 无权威留证**：新的 execution_revision/security_epoch/authority_kind
   四列只接到了 proxy billing insert，**codex bridge settle 没传** → 相应列为空。
   且 gateway 未断言 `billingRequestId === frame.requestId`。

### C. 各 agent 报告里的登记项
- **master 侧 aliases 未下发**：容器 client 消费面已做齐（缺席=空 map，不放宽判定），
  master 补 `WireCatalogResponse.aliases` 即闭环。当前 model_aliases 表为空 → 生产零影响。
- **`OC_MODEL_AUTHORITY` 第二份拷贝**（subprocessRunner.ts:202）→ 收口到 `isModelAuthorityRequired()`。
- **egress authz loader** 用 gate 内进程级默认实例（与 identity strategy 各一份 60s 缓存，
  规则同源无分叉）→ wiring 批次收口为同一实例。
- **权限层割接**（0136 文件尾有 runbook）：建低权角色 → `fn_model_authority_grant_app_role`
  → 换 DATABASE_URL。割接前必须先把 `admin/modelCatalogOps.ts` 的直写改为受控过程（过程已就位）。
- **0135 双向 trigger 锁序耦合**：admin pricing 写与 catalog 写并发可能 40P01（已翻 409 可重试，
  非数据损坏）；根治=给 admin/pricing.ts 统一锁序（catalog → pricing）。
- **新增 model_id 仍需一次代码发版**：gateway inbound 白名单走 protocol `matchesRoute`、
  codex adapter 走 `CODEX_ENGINE_MODEL_IDS`，catalog 尚未接管这两处判定源。纯 DB 可改的是
  upstream_model_id/context_window/capability/上下线/价格/alias。**放开前必须先 descriptor 化
  这两处**，否则会静默放行一个"影子/回落路径打到 OAuth 池烧真钱"的行。

### D. 部署（六步矩阵，agent C 已写可执行 runbook）
见 `scripts/deploy-v5.sh` 的 `--model-authority-preflight` / `--enable-model-authority` /
`--model-authority-cutover`。**关键**：
- 步骤 2/4 必须 `--egress`（生产 `/v1/messages` 全在 egress，只重启 master 等于没上线）
- 步骤 4 前四面 capability preflight 全绿
- **步骤 5 后不可逆**（cutover marker 置位 → 缺 capability 的任何一面拒绝激活）
- 步骤 6 seed 阶段 A 核验「全部 managed 容器（含 stopped）带有效 bundle_rev label」

### E. 运维铁律（实现期发现，务必进 runbook）
1. **先 recycle 后 retire**：阶段 B 下旧容器跑旧 rev 的 seed 声明，退役 seed 模型前先确认无容器引用。
2. **禁 disable 平台必需模型**：`deepseek-v4-flash`（次级模型，WebFetch/WebSearch）被 disable
   → 全站 ccb turn 签发期 fail-closed 拒帧（有意设计，但 blast radius 大 → 建议加 trigger 护栏）。
3. **keyring 轮换五步**：keyring env 只在 provision 注入 → "下发新公钥" = 换 env + 全量 recycle；
   census（`authorityKeyCensus.isFullyCovered`）是步骤② 的 gate。
4. **价格变更打断在途 turn**：epoch bump → 长 CCB turn 下次上游请求被拒
   （`MODEL_CONFIG_CHANGED_RETRY_TURN`，前端已有引导重开）。监控需区分安全撤销 vs 价格版本变化。

## 四、上个批次（hotcfg）顺带修的既有漏洞（已在本批 commit 里）
hotcfg 的 master symlink 翻转走 saga `extra_apply`，**从不经过 `activate_release`**
→ sessions-pg 割接地板的 capability 断言此前被完全绕过。已在 tuple 激活/回滚两处补挂。

## 五、并行 agent 工作流的坑（已修，值得记住）
- `commercial-unit-gate.sh` 的 TAP 默认写仓根固定名 → 并发跑互相截断报假 infrastructure failure。
  已改进程隔离；**worktree 的 `.git` 是文件不是目录**，必须用 `git rev-parse --git-dir`。
- integ 测试必须走 `scripts/test-mutex.sh`（直跑会 deadlock）。
