# kp-automation · 知识星球自动回复面板 · 归档摘要（t-838，覆盖复查缺口 G-3）

> 正文：[`docs/audit/kp-automation.md`](../kp-automation.md)（已随集成④ `d83d4a368` 合入 integration，2026-09-17）。本文只做摘要与索引。
> 任务：t-838「知识星球自动回复面板 审计+修复（G-3）」，A→B 同人合一（settings-A 与 manage-A 互相推让，面板本体此前从未被审）；QA 复核 t-1029（[qa.md](./qa.md)）。
> 分支 `feat/v5-selfhost-audit-kp-automation`，HEAD `b0fd16dad`，基线 `210b9967`；QA 修复 `1db992620` 在 `feat/v5-selfhost-audit-qa-gap`。
> 范围：`components/settings/KnowledgePlanetAutomationPanel.tsx`（唯一改动的业务文件，801 → 1035 行）+ 新增 `.test.tsx`（370 行）+ `scenes-kp-automation.tsx`（14 场景）。

## 1. 审出问题（P1 1 / P2 7 / P3 11，共 19）

| 严重度 | 编号与要点 |
|---|---|
| P1 | KP-01「同意并开启」失败时错误写到弹层背后的面板顶部；上限输入完全不校验 → 主流程可静默失败 |
| P2 | KP-02 规则行 390px 三控件占 60% 行宽 · KP-03 加载失败无重试 · KP-04 运行记录看不出何时 / 哪条规则 · KP-05 星球多选无 `aria-pressed` · KP-06 已选芯片 ✕ 仅 11px · KP-07 校验错误不落字段 |
| P3 | KP-08 空态无下一步 · KP-09 任意字号 · KP-10 / 11 / 12 / 16 文案 · KP-13 选择器探出弹层 · KP-14 单布尔 busy 全灰 / 无成功反馈 · KP-15 不可用无解释 · KP-17 裸 `<select>` · KP-18 加载态非骨架 · KP-19 每次编辑重拉星球 |

→ 正文 §3 问题清单（含每条证据图）。

## 2. 修复情况（发现 19 / 修复 17 / 不修 2）

- `2517de4c1` feat：KP-01（弹层内 `consentError` + `validateAccountLimit` 1–30 先拦并聚焦）· KP-02 `CardRow` · KP-03 `Alert action=重试` · KP-04 `Badge` + 规则名反查 + `TimeAgo` + 原因行 · KP-05 `aria-pressed` + `<fieldset>` · KP-06 `Chip` 整枚可点 · KP-07 `{field,error}` + `aria-invalid` + 聚焦 + `Field` hint 常驻 · KP-08 `EmptyState` + CTA · KP-09 字号全部语义档 · KP-10 / 11 / 12 / 16 文案 · KP-13 Popover 宽跟触发器 + 「全选可用」· KP-14 分键忙态 + toast · KP-15 info Alert · KP-17 `ui/Select`。
- `9c5ca666a` test：14 个 ui-preview 场景（两条预览台经验写进场景注释：弹层类场景不套 Sheet；`OC_UI_SHOT_DELAY=1800`）。
- `b0fd16dad` 文档。不修：KP-18（骨架行数无从预估）、KP-19（列表轻、缓存收益小于复杂度）；弹层形态改贴底 Sheet 与 Checkbox 原语归 shell 统一决定。
- QA t-1029 追加：KP-14 的 `busyKey` 是单值，`toggleRule` / `deleteRule` 开头 `if (busy) return` → 切第一条时第二条开关看似可用但点击被静默丢弃；`1db992620`（qa-gap 分支）改 `busyKeys: ReadonlySet<string>` 按键门控，用例补「第一条在飞时点第二条真的发请求」（修前红 1 failed / 9 passed，修后 70/70）。

→ 正文 §5 修复记录、§6 不修 / 暂缓。

## 3. 验证摘要（工作树 `wt\kp-automation`；QA 复核见 [qa.md](./qa.md) §3）

| 门 | 结果 |
|---|---|
| `typecheck` | ✅ exit 0 |
| 面板单测 | ✅ 10 例（此前该面板零用例） |
| settings + manage 目录单测 | ✅ 22 文件 / 270 例（含 `ConnectorsTab.test` 2 例直接驱动本面板弹层，未改一字仍绿） |
| `biome lint` 3 文件 | ✅ 0（1 条 `useSemanticElements` → 已改 `<fieldset>`） |
| 视觉 | ✅ before / after 各 56 张（14 场景），failures 0 |
| NOT RUN | `npm test` 全量、`test:browser`（非高频面）、真机 iOS Safari、Popover 在 Dialog 内的真实焦点循环 |

## 4. 遗留与理由

| 项 | 归属 | 说明 |
|---|---|---|
| KP-18 骨架加载态 / KP-19 编辑重拉星球列表 | 不修有判据 | 见正文 §6 |
| 表单弹层改 `Modal mobile="sheet"` | shell 统一决定 | 全站设置类弹层均为居中形态 |
| 同意勾选框 / 星球选项的 Checkbox 原语 | shell（`ui/` 尚无 Checkbox） | 与 market K-27 同口径 → shell 原语 `ui/Checkbox` 已由遗留清扫 t-1234 `959735722` 新增（待集成⑤）；本面板同意勾选换用原语属后续建议（manage / settings owner，需另出 before / after），未做 |
| `KnowledgePlanetAutomationPanel.tsx:700`（a11y-C 基线 `:960`）勾选态 `bg-accent text-white` 深色对比度 | a11y-shell §5 同源项 | ✅ a11y-C t-1233 `00b86b565` 改 `text-accent-fg`（2.82 → 6.45），KP-05/06 用例补断言；分支 `feat/v5-selfhost-audit-a11y-c@c35fd00c6`，待集成⑤ |
| 「从当前账号已加入的星球中选择」钮触屏 316×42 | kp-automation P3 nit | QA t-1232 §7 #2 复扫指出（差 2px）；a11y-C 按「对比度命中」口径未动，仍开放 |

## 5. 分支 / 提交

- `feat/v5-selfhost-audit-kp-automation` @ `b0fd16dad`：`9c5ca666a` `2517de4c1` `b0fd16dad`
- QA 修复：`feat/v5-selfhost-audit-qa-gap` `1db992620`
- 集成：✅ 集成④ `d83d4a368`（4 files, +1525/−283，零重叠）；QA 修复随 qa-gap `902ade6e8`。集成④ 全量门：`npm test` 302 / 4279（`KnowledgePlanetAutomationPanel.test` 为 +4 测试文件之一）、截图 301 场景含 kp 14 场景 failures 0、a11y 复扫 kp 14 场景命中均为禁用按钮（WCAG 例外）+ 勾选态白字（a11y-C 已修，待集成⑤）
