# QA 复核三轮 · 归档摘要（t-1028 二期 P3 / t-1038 B 轮 P3 / t-1029 缺口补审）

> 正文：`docs/audit/qa/QA-p3-tail.md`（t-1028）、`docs/audit/qa/QA-b-p3.md`（t-1038）、`docs/audit/qa/qa-gap.md`（t-1029），随 `feat/v5-selfhost-audit-qa-p3` / `-qa-b-p3` / `-qa-gap` 合入后可读 **[待集成④]**。本文只做摘要与索引。
> 角色：测试 / QA「第二双眼睛」，对照被复核任务的验收标准逐项定位到 integration 代码行，复跑门禁，按 d-28 用截图台重出截图逐张看图；发现不合格项直接修（t-1029）或在任务书边界内移交（t-1038）。三轮核对态均为 integration `c034f05d7`（集成③ 6/6 之后、q-979 之后）。

## 1. t-1028 · 二期 P3 收尾复核（market2 t-625 / manage2 t-626 / sidebar2 t-627 / settings2 t-628）

| 任务 | 核对项 | ✅ | ❌ | 结论 |
|---|---|---|---|---|
| t-625 market2 | 10 条 P3 落地 + 3 条保持遗留 + 验证门 | 13 | 0 | 通过 |
| t-626 manage2 | §9 遗留 5 条处置 + X-03 + 验证门（`cronHuman` 另跑 23 组边界探针） | 6 | 0 | 通过 |
| t-627 sidebar2 | §6.2 遗留 6 条处置 + RepoPill 顺手项 + shell 接线闭环 + 验证门 | 7 | 0 | 通过 |
| t-628 settings2 | 遗留表 11 项处置（4 项落地）+ 验证门 | 11 | 0 | 通过 |

- ❌ 0；四条交付声称的代码 / 用例 / 场景在 integration HEAD 上全部存在且行为一致；biome 31 条诊断逐处 `git blame` 判定全部来自二期之前。
- 观察项 2（P3 nit，不改代码）→ 转 a11y-mod-a 已修（`beb48d930` / `4efc0fa35`）。
- 验证：四模块单测（manage 17 文件 / 214 例等）、typecheck、`typecheck:preview`、`test:browser`（`run.mjs` 68/68；`node --test` 70/73 基线）在合并后 integration 上复跑全绿；截图 45 场景 126 张。
- 分支 `feat/v5-selfhost-audit-qa-p3` @ `3e640a85d`（纯文档）。

## 2. t-1038 · B 轮 P3 修复交付复核（landing-B t-49 / media-B t-51 / tutorials-B t-53）

| | landing-B | media-B | tutorials-B |
|---|---|---|---|
| 修复记录 vs 代码 | 20 条 + X-01~03 逐条对上，**0 不符** | 27 条 + X-M1~M4 逐条对上，**1 不符**（M-23 性能半条文档写 ✅ 实为未做） | 37 条 + 追加①② 逐条对上，**0 不符** |
| P1 / P2 | P2 3/3 ✅ | P1 2/2 · P2 11/11 ✅ | P2 12/12 ✅ |
| 阶段 B 验证门复跑 | ✅ | ✅（含 `test:browser` T30） | ✅；`check:tutorials` 在核对态红 → q-1076 处置后 `b249317f4` 转绿 |
| 集成后回归 | 无 | 无 | 无 |

- 共 84 条修复记录核对；⚠ 3 项均已处置 / 有去向：① `check:tutorials` 红 → 集成③ q-1076 → A（`29a277b25` / `b249317f4`）；② landing L-11 遗留理由失效（可做了）→ 移交 t-895 附录 `6236dfb08`；③ media M-23 文档与代码不符 → `media.md` 勘误 + 移交 t-895 附录 `986f72b2f` / `85a7aea54`。
- 本轮代码改动 0（可动手的两个文件当时由 t-895 持锁）；文档改动 3（本文 + `landing.md` §7.1 备注 + `media.md` M-23 勘误与遗留补记）。
- 验证：三模块 vitest + typecheck / `typecheck:preview`、biome 对照基线、`test:browser`、`check:tutorials`（integration 与 tutorials 分支各一次）、截图 70 场景 258 张（看了 30 张关键图）。
- 分支 `feat/v5-selfhost-audit-qa-b-p3` @ `0ac949b2e`（`d1b2bbaa8` 报告 · `3cee09477` 按指挥官意见改写 `check:tutorials` 处置 · `0ac949b2e` 三项去向口径对齐）。

## 3. t-1029 · 缺口补审交付复核（hud t-836 / kp-automation t-838 / misc-p3 t-839 / 集成待办 t-865）

- 复核基线：`c034f05d7` + 三条专项分支干净合入（`0bdc40afc` / `fe35506a1` / `010b532ee`），工作树 `wt\qa-gap`。
- **核对 61 项：✅ 59 / ❌ 2，两处 ❌ 已在本分支修复并验证**：
  - ❌1 t-836：`typecheck:preview` 红 TS2353（`scenes-hud.tsx:199` 字面量多写 `estimated`；hud 交付只跑了 `typecheck`）→ `747596782` test(v5) 改 `LiveTurnTokenUsageSnapshot` 类型常量，运行时零变化，修后 0 错（taskboard TS2322 亦随集成③ 自消）。
  - ❌2 t-838 KP-14：`busyKey` 单值 + `if (busy) return`，切第一条时第二条开关看似可用但点击被静默丢弃 → `1db992620` refactor(v5) `busyKeys` 集合门控 + 用例补「第一条在飞时点第二条真的发请求」（修前 1 failed / 9 passed，修后 70/70）。
- t-839 12 项、t-865 9 项全 ✅：`MarkdownImpl` 记忆化闭包审读无陈旧依赖；t-865 各项（`allowImportingTsExtensions`、`USER_STATUS_LABEL.queued`、`AgentPicker` 展示名常量、`styles.css` caption token、`Sheet closeButton`、`MediaTaskCenter onReusePrompt`、TU-37 随 tutorials 合入）在 HEAD 逐项定位。
- 验证：typecheck ✅；`typecheck:preview` ✅（修后）；vitest HUD 4 文件 55 例 / KP 2 文件 70 例 / misc 8 文件 167 例（`MessageRenderer.test` 首跑 beforeAll 超时属 INTEGRATION §6 已知偶发，单跑 150/150）/ t-865 5 文件 115 例；biome 3 文件 0；`test:browser` `run.mjs` 68/68、`node --test` 70/73（基线）；截图 hud 40 + kp 56 + misc 24 = 120 张 failures 0，关键图逐张 Read。
- 已确认仍开放的遗留：H-18 `App.tsx:3745` `onStop` 一行接线（shell）、H-12 / H-20、D-02 余项 / D-08、OG-05 / OG-09。
- 分支 `feat/v5-selfhost-audit-qa-gap` @ `c1734aac6`（`747596782` `1db992620` 代码；`c06947a0c` `c1734aac6` 文档，含 §7「QA 直接修复」）。

## 4. 分支 / 集成

| 分支 | HEAD | 内容 | 集成 |
|---|---|---|---|
| `feat/v5-selfhost-audit-qa-p3` | `3e640a85d` | `qa/QA-p3-tail.md` | **[待集成④]** |
| `feat/v5-selfhost-audit-qa-b-p3` | `0ac949b2e` | `qa/QA-b-p3.md` + `landing.md` / `media.md` 勘误 | **[待集成④]**（与 a11y-mod-b 同文件，留意合并） |
| `feat/v5-selfhost-audit-qa-gap` | `c1734aac6` | `qa/qa-gap.md` + 2 处修复 + hud / kp-automation / misc-p3 三支合并 | **[待集成④]**（整支 ff 可带上三条专项） |
