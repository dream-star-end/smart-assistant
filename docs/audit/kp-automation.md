# kp-automation · 知识星球自动回复面板 审计 + 修复报告（G-3 / t-838）

- 分支：`feat/v5-selfhost-audit-kp-automation`（基线 `210b9967892b3624fb3984f69d2174e4a641b33d`），工作树 `wt\kp-automation`
- 阶段：A 审计 + B 修复同人合一（任务书要求先出 KP-xx 清单再修，本文 §3 即清单、§5 即逐条处置）
- 结论：**P1 × 1 / P2 × 7 / P3 × 11**，共 19 条；P1 / P2 全部修复，P3 修 9 条、2 条记为不修（理由见 §6）。
  P1 是「同意并开启」失败时错误写到**弹层背后**的面板顶部、上限输入又完全不校验 —— 用户看到的是按钮点了没反应。
- 背景：面板此前从「管理中心 → 插件账号 Tab → 账号行」外提到贴底 Sheet（ConnectorsTab，补丁① t-426 已修、本轮只读参照），
  但面板本体从没被审过（settings-A 与 manage-A 互相推让，t-760 缺口 G-3）。

---

## 1. 范围与文件清单

| 类别 | 文件（`packages/web-react/` 下） | 行数 |
|---|---|---|
| 面板本体（**唯一**改动的业务文件） | `src/components/settings/KnowledgePlanetAutomationPanel.tsx`（总开关 + 免责同意弹层 / 规则列表 / 批量新建与编辑弹层 / 星球多选 Popover / 最近执行记录） | 801 → 1035（+521 / −283） |
| 新增单测 | `src/components/settings/KnowledgePlanetAutomationPanel.test.tsx` | 新增 370 |
| 新增预览台场景 | `browser-tests/ui-preview/scenes-kp-automation.tsx`（14 个场景，见 §2.1） | 新增 400 |
| 只读参照（不改） | `settings/ConnectorsTab.tsx:1450-1478`（外提 Sheet 壳）、`lib/connectors.ts:198-289`（类型）、`lib/api.ts:4300-4440`（6 个接口） | — |

**不在本轮范围**（任务书边界）：插件 tab 容器与定时任务面板（patch1 / manage 归属）、应用壳层入口、`ui/**` 原语、集成分支。
面板没有独立的 `browser-tests` 交互用例；它不是 Composer / 消息 / 工具卡 / 侧栏那类高频交互面，`test:browser` 按任务书 NOT RUN。

---

## 2. 方法与证据

### 2.1 ui-preview 场景（新增 `scenes-kp-automation.tsx`）

面板挂在 ConnectorsTab 的贴底 Sheet 里，场景按同一份壳（标题 + 账号 + 关闭 + 滚动区）把面板原样包起来，只在 api 边界打桩
（`getKnowledgePlanetAutomation` / `listKnowledgePlanetAutomationGroups` / 四个写接口），**不动** `api-stub.ts`（api 代理是按方法名
查表的通用实现，无需登记）。全部场景 desktop + mobile × light + dark。

| 组 | 场景 id | 内容 |
|---|---|---|
| 一级状态 | `kp-automation-list` | 已开启：3 条规则（启用 / 停用 / 已暂停 CURSOR_NOT_FOUND）+ 6 条运行记录 |
| | `kp-automation-empty` | 已开启但无规则 |
| | `kp-automation-off` | 关闭中且写入能力未开（总开关不可点 + 引导） |
| | `kp-automation-paused` | 被安全停用（DISPATCH_UNKNOWN） |
| | `kp-automation-loading` / `kp-automation-error` | 加载中 / 加载失败 503 |
| 二级状态（`<AutoClick>` 挂载后按序点击） | `kp-automation-runs` | 展开「最近执行记录」 |
| | `kp-automation-consent` | 点总开关 → 免责声明与同意弹层 |
| | `kp-automation-new` / `kp-automation-new-picker` | 批量新建弹层 / 再打开星球选择器（含已配置项） |
| | `kp-automation-new-groups-error` | 星球列表读取失败（选择器内报错 + 重试） |
| | `kp-automation-validation` | 选 1 个星球、不填名称就保存 → 校验报错 |
| | `kp-automation-edit` / `kp-automation-delete` | 编辑一条规则 / 删除确认框 |

两条预览台经验（都写进了场景文件注释）：
1. `shoot.mjs` 把截图 clip 到 DOM 里**第一个** `[role=dialog]`；贴底 Sheet 高度按内容自适应、贴在视口底部，居中的 Modal 大半落在
   clip 之外。弹层类场景因此**不套 Sheet**，直接把面板铺在页面里，让 Modal 成为唯一的 dialog。
2. 快门在 `fonts.ready + OC_UI_SHOT_DELAY` 后按下，多步点击的总时长必须压在它之内；本组场景请用 **`OC_UI_SHOT_DELAY=1800`**
   （默认 400 / market 用的 900 会在第二步点击前就截图 —— 第一版 before 图里选择器"没打开"就是这个原因）。

### 2.2 截图

```powershell
cd d:\code\test_project\test123\wt\kp-automation\packages\web-react
$env:OC_E2E_BROWSER='C:\Program Files\Google\Chrome\Application\chrome.exe'
$env:OC_UI_SHOTS='D:\code\test_project\test123\.audit-tmp\kp-automation\before'   # 修复后换 ...\after
$env:OC_UI_SCENES='kp-automation'
$env:OC_UI_SHOT_DELAY='1800'
node browser-tests\ui-preview\shoot.mjs
```

before / after 各 56 张（14 场景 × 2 视口 × 2 主题），`failures: 0`、`retried: 0`、`unmockedApi: []`；before 用改动前的面板代码出
（场景文件先加、面板未动），after 用修复后代码出。PNG 不入库。直接充当证据的几张见 §3 的「证据」列与 §5 的 after 对照。

### 2.3 跑过的验证

见 §5.1。

---

## 3. 问题清单

严重度：**P1** 功能不可用 / 数据错误 / 阻断主流程；**P2** 明显体验缺陷 / 一致性破坏 / 移动端不可用；**P3** 打磨项。
位置为 `KnowledgePlanetAutomationPanel.tsx` 改动前行号。

| 编号 | 位置 | 现象 | 影响 | 严重度 | 证据 |
|---|---|---|---|---|---|
| KP-01 | `:244-263`（`enableAutomation` catch → `setError`）、`:535-550`（上限输入无校验） | 「同意并开启」失败时错误写到**面板顶部**的 Alert，而同意弹层还开着、遮罩盖住面板；上限输入 `type=number min=1 max=30` 只是浏览器提示，空值 / 0 / 31 照样 `Number()` 后发给后端被拒 | 开启主流程可以静默失败：按钮转一下又亮起来，弹层原地不动，用户以为"点了没反应" | **P1** | 代码；`kp-automation-consent--*` |
| KP-02 | `:434-473`（规则行 `flex flex-wrap items-center`，开关 + 编辑 + 删除与主名同排） | 390px 下三个控件占掉 ~60% 行宽，主名只剩六个字「产品经理营 · 新…」，元信息挤成三行 | 移动端认不出是哪条规则 | P2 | `before/kp-automation-list--mobile--light.png` |
| KP-03 | `:357-362`（`!view` 时只渲染一条 Alert） | 加载失败无「重试」，只能关掉抽屉重开 | 错误态不可恢复 | P2 | `before/kp-automation-error--*` |
| KP-04 | `:479-503`（运行记录只有「主题 {id}」+ 状态，右对齐相隔一整行） | 看不出**何时**执行、**哪条规则**触发；summary 无计数；桌面端主题与状态相距 900px | 运行记录是自动回复"有没有在干活"的唯一反馈，却读不出信息 | P2 | `before/kp-automation-runs--desktop--light.png` |
| KP-05 | `:684-714`（星球选项是自绘方框 + ✓ 的 `<button>`，无 `aria-pressed` / `aria-checked`） | 读屏听不到"已选中 / 未选中"，只听到星球名 | 多选对辅助技术等于不可用 | P2 | 代码 |
| KP-06 | `:729-738`（已选星球芯片的 ✕ 是 11px 图标按钮，无内距） | 触控靶约 11px | 手机上点不中，反而容易误触旁边 | P2 | `before/kp-automation-validation--mobile--light.png`（芯片） |
| KP-07 | `:104-144`（`validateRuleDraft` 只回一句文案）、`:576-580`（错误落在 footer） | 校验错误不落到出错字段：无 `aria-invalid`、不聚焦；取值范围（1–10 / 5–1440 / 100–1200）只有报错后才知道 | 6 个字段的表单在手机上要来回滚动找哪里错了；读屏拿不到字段级错误 | P2 | `before/kp-automation-validation--mobile--light.png` |
| KP-08 | `:428-431`（空态一行灰字）、`:417-425`（「添加规则」禁用无解释） | 空态没有下一步；总开关关着时按钮灰掉不说为什么 | 新用户不知道从哪开始 | P3 | `before/kp-automation-empty--*` / `kp-automation-off--*` |
| KP-09 | `:371-375`（标题 `text-meta`、说明 `text-[11px]`）、`:532`（`text-[12px]`）、`:796-828`（`text-micro` 10px 标签） | 任意字号 + 面板层级仍按"嵌套在账号行里的小卡片"取值，外提到 Sheet 后整块字都偏小 | 违反设计系统字号纪律（`ui/index.ts` 头注释）；桌面 1440px 下 11px 说明文字勉强可读 | P3 | `before/kp-automation-list--desktop--light.png` |
| KP-10 | `:400-402` | 「请先开启上方“写入能力”」：外提后写入能力开关不在"上方"而在插件账号行；引号用 “ ” 与全文 「」 不一致 | 指错位置 | P3 | `before/kp-automation-off--mobile--light.png` |
| KP-11 | `:331` | `删除规则「…」?` 半角问号 | 标点 | P3 | 代码 |
| KP-12 | `:573` | 编辑弹层也写「新规则保存后立即启用…」 | 编辑态文案不符 | P3 | `before/kp-automation-edit--*` |
| KP-13 | `:619`（Popover `w-[min(30rem,calc(100vw-2rem))]`）、`:642`（「选择可用」） | 390px 下选择器比触发器宽、探出弹层右缘；「选择可用」不像"全选" | 布局 + 文案 | P3 | `before/kp-automation-new-picker--mobile--light.png` |
| KP-14 | `:159`（单个 `busy` 布尔）、`:315-327`（切换失败写面板顶部）、保存 / 删除成功无反馈 | 切一条规则所有行一起变灰；切换失败的错误在长列表顶部；保存 / 删除成功只能靠列表变化自己发现 | 反馈弱 | P3 | 代码 |
| KP-15 | `:382-386` | `control.available=false` 时总开关灰掉，没有任何解释 | 不可用无解释 | P3 | 代码 |
| KP-16 | `:514` | 「由 AI 自动计费并发布回复」 | "自动计费"不是用户话 | P3 | `before/kp-automation-consent--*` |
| KP-17 | `:781-793` | 触发范围用裸 `<select>` 而不是 `ui/Select`（高度 / 箭头 / 焦点环与其它控件不一致） | 一致性 | P3 | `before/kp-automation-new--*` |
| KP-18 | `:349-355` | 加载态是一行 spinner 文字，不是骨架 | 加载态 | P3 | `before/kp-automation-loading--*` |
| KP-19 | `:273-280` | 每次打开「编辑」都重新拉一次星球列表 | 多一次请求 | P3 | 代码 |

---

## 4. 修复计划（已按此落地，见 §5）

- **KP-01**：弹层内自持 `consentError`（服务端拒绝）与 `limitError`（客户端校验），错误渲染在弹层正文；`validateAccountLimit` 纯函数
  先拦 1–30 整数，失败聚焦输入框；上限输入改 `Field`（label / hint / error 一体，自动 `aria-describedby` / `aria-invalid`）。
- **KP-02**：规则行改 `ui/CardRow`（主名单行截断、说明 ≤2 行、操作区窄屏自动落到第二行右对齐）；状态收成一枚 `Badge`。
- **KP-03**：`Alert title + action=重试`，重试重新进入 loading。
- **KP-04**：每条 = 状态 `Badge`（按状态取 success / neutral / danger / info）+ 规则名（`ruleId` 反查，已删标「（规则已删除）」）
  + 主题 id + `TimeAgo(createdAt)`，原因另起一行；summary 带计数。
- **KP-05**：选项 `aria-pressed={selected}`，自绘方框 `aria-hidden`；列表容器改 `<fieldset>` + `sr-only legend`。
- **KP-06**：整枚芯片改 `ui/Chip`（原语自带 ≥36px 触控靶 + `aria-pressed`），点芯片即移除。
- **KP-07**：`validateRuleDraft` 返回 `{field, error}`；六个字段全部改 `Field`（标签 / 范围 `hint` 常驻 / `aria-describedby` 连线）；
  校验失败时出错字段标 `aria-invalid` + 红描边 + 聚焦并滚进视口，文案仍放在 footer 紧挨「保存」按钮的 `Alert` 里
  （ConnectorsTab.test 既有契约：错误 alert 与保存按钮同一容器；同一句话不在字段下重复出现）；用户一改出错字段，标红与文案一起撤。
- **KP-08**：`EmptyState`（图标 + 标题 + 按总开关状态给不同 hint + 「添加第一条规则」CTA）；标题旁按原因给一行说明
  （「先开启上方总开关」/「已达 10 条上限」）。
- **KP-09**：标题 `text-section semibold`、说明 `text-caption`、全部 `text-[Npx]` / `text-micro` 换语义档位；`Alert` 用 `density="compact"`。
- **KP-10 / 11 / 12 / 16**：文案改写（见 §5 表）。
- **KP-13**：Popover 宽度 `w-[var(--radix-popover-trigger-width)]`；「选择可用」→「全选可用」（`Button variant=link`）。
- **KP-14**：`busyKey`（`control` / `save` / `toggle:<id>` / `delete:<id>`）只锁正在操作的那一处；保存 / 删除 / 开启成功 toast；
  切换失败 toast 带「重试」。
- **KP-15**：`!available` 时给一条 info Alert 说明总开关为何不可用。
- **KP-17**：`ui/Select`。
- **KP-18 / KP-19**：不修（§6）。

---

## 5. 修复记录

| 编号 | 状态 | 改动（`KnowledgePlanetAutomationPanel.tsx`） | 用例（`KnowledgePlanetAutomationPanel.test.tsx`） |
|---|---|---|---|
| KP-01 | ✅ | 新增导出 `validateAccountLimit`；`enableAutomation` 先校验、失败落 `limitError` 并聚焦；服务端拒绝落 `consentError`，以 `Alert` 渲染在弹层正文；成功 toast「无人值守自动回复已开启」。上限输入改 `Field`（hint「1–30 条。这是账号级总量…」）。 | 「同意弹层:上限越界先在输入框下报错且不发请求;服务端拒绝时错误在弹层内可见」+ 纯函数用例 |
| KP-02 | ✅ | 规则行改 `CardRow`：title=规则名（truncate）、description=星球 · 触发 · 每日 · 冷却 · 最多字数、meta=状态徽章（运行中 / 已停用 / 待总开关开启 / 已暂停：原因）、actions=开关 + 编辑 + 删除。 | 「规则行走 CardRow:操作区在窄屏落到第二行整行右对齐…」 |
| KP-03 | ✅ | `Alert title="没能加载无人值守自动回复设置" action=<重试>`，重试 `setLoading(true)+reload()`。 | 「加载失败给「重试」出口,点击后重新拉取并渲染」 |
| KP-04 | ✅ | `ruleById` 反查规则名；每条 = `Badge(runStatusTone)` + 规则名 / 「（规则已删除）」 + 主题 id + `TimeAgo` + 原因行；summary「最近执行记录（N）」。 | 「运行记录:summary 带计数,每条给状态徽章 + 规则名 + 时间 + 原因…」 |
| KP-05 | ✅ | 选项 `aria-pressed`；方框 `aria-hidden`；容器 `<fieldset><legend class=sr-only>可选择的知识星球`；选项补焦点环与 44px 触控高。 | 「批量新建:星球选项以 aria-pressed 表达选中态,已配置的不可选;整枚芯片即「移除」」 |
| KP-06 | ✅ | 已选星球芯片改 `Chip selected size=sm aria-label="移除 X"`，整枚可点。 | 同上 |
| KP-07 | ✅ | `RuleValidation = {ok:false, field, error}`；`RULE_FIELD_ID` 表；`invalidField` 状态 + `focusField`（聚焦 + `scrollIntoView`）+ `invalidProps()`（`aria-invalid` + `border-danger`）；六个字段 `Field`（hint 写范围与用途；必填走控件 `aria-required`，标签不加星号以保住 ConnectorsTab.test 的精确标签查找）；文案在 footer `Alert` 紧挨保存按钮；`updateDraft` 一改即撤；数值三列 `grid-cols-1 sm:grid-cols-3`。 | 「规则表单:校验失败落到出错字段(aria-invalid + 聚焦),不提交;范围提示常驻」+ 纯函数用例；ConnectorsTab.test 既有 2 例（原子创建 / 编辑拦截）不改一字仍绿 |
| KP-08 | ✅ | `EmptyState icon=ListChecks`，hint 按总开关状态二选一，CTA「添加第一条规则」（可添加时）；标题旁 `addRuleHint`。 | 「空态用 EmptyState 给出下一步;总开关关着时说明为什么不能添加」 |
| KP-09 | ✅ | 标题 `text-section font-semibold`、说明 `text-caption text-muted`、图标芯片 36px；`text-[11px]` / `text-[12px]` / `text-micro` 全部清零；弹层内 `Alert density=compact`；容器 `p-3 sm:p-4`。 | —（视觉，after 图） |
| KP-10 | ✅ | 「请先在插件账号里开启「写入能力」，再单独同意并开启无人值守自动回复。」 | 「文案:删除确认标题全角问号;写入能力提示不再指向已不存在的"上方"」 |
| KP-11 | ✅ | `删除规则「…」？` | 同上 |
| KP-12 | ✅ | 编辑态描述「修改保存后立即生效；尚未发送的旧任务会被安全取消，不补发历史主题。」（与 `RULE_CHANGED` 原因码口径一致） | 「规则表单…」内断言 |
| KP-13 | ✅ | `PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-[16rem] p-0"`；「全选可用」/「清空」改 `Button variant=link size=sm`。 | 「批量新建…」内断言「全选可用」 |
| KP-14 | ✅ | `busyKey` 分键；toast：开启 / 保存并启用 N 条 / 规则「x」已保存 / 已删除规则「x」；切换失败 `toast(error, {actionLabel:重试})`；删除按钮 `loading`。 | 「只锁正在操作的那一行:切换第一条时第二条的开关仍可用;失败走 toast 带重试」 |
| KP-15 | ✅ | `manualWriteEnabled && !enabled && !available` → info Alert「当前账号暂不支持无人值守自动回复（插件版本或账号状态不满足），总开关不可用。」 | —（文案） |
| KP-16 | ✅ | 「开启后，AI 会在你离线时自动生成并发布回复，每条回复都会消耗你的模型额度。」 | —（文案） |
| KP-17 | ✅ | 触发范围改 `ui/Select`（`Field htmlFor` 连线）。 | 「规则表单…」（`getByLabelText` 可达即为连线成功） |
| KP-18 / KP-19 | ⏸ 不修 | 见 §6。 | — |

### 5.1 验证

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck --workspace packages/web-react` | ✅ 绿（exit 0） |
| 面板单测 | `npx vitest run src/components/settings/KnowledgePlanetAutomationPanel.test.tsx --maxWorkers=1` | ✅ 1 文件 / 10 例全绿（新增；此前该面板零用例） |
| settings + manage 目录单测 | `npx vitest run src/components/settings src/components/manage --maxWorkers=1` | ✅ 22 文件 / 270 例全绿（含 `ConnectorsTab.test` 53 例 —— 其中 2 例直接驱动本面板的新建 / 编辑弹层，未改一字仍绿；过程中曾因标签加了必填星号而红过一次，改回纯词标签后恢复） |
| 代码风格 | `npx biome lint <面板 / 单测 / 场景 3 个文件>` | ✅ 0 诊断（过程中 1 条 `useSemanticElements`：`role=group` 的 div → 已改 `<fieldset>`） |
| 视觉 before / after | `OC_UI_SCENES=kp-automation OC_UI_SHOT_DELAY=1800` → `.audit-tmp\kp-automation\{before,after}` | ✅ 各 56 张，`failures: 0`、`unmockedApi: []`，逐张对照见下 |

after 对照（同名 PNG，`before/` ↔ `after/`）：

- `kp-automation-list--mobile--*` —— 规则主名从「产品经理营 · 新…」变成整行可读，元信息一行半，开关 / 编辑 / 删除落到卡片第二行右对齐；
  每行多一枚状态徽章（运行中 / 已停用 / 已暂停：原因）。
- `kp-automation-list--desktop--*` —— 面板标题 13.5px 半粗、说明 11px→text-caption 且改 muted；「最近执行记录」带计数。
- `kp-automation-runs--desktop--*` —— 每条记录从「主题 588… ……已回复」变成「[已回复] 产品经理营 · 新提问自动答疑 · 主题 588… 3 小时前」，
  跳过 / 失败原因另起一行；失败与待核实用 danger 徽章。
- `kp-automation-consent--*` —— 上限输入有标签、范围提示；描述不再说「自动计费」；（服务端拒绝时错误出现在弹层内，见单测）。
- `kp-automation-validation--mobile--*` —— 「请输入规则名称」仍紧挨保存按钮，但出错的规则名称字段同时带红色描边（`aria-invalid`）并被聚焦；
  已选星球是一枚可整体点击的药丸芯片；数值字段带「1–10 / 5–1440 / 100–1200」常驻提示；窄屏 footer 按钮竖排铺满。
- `kp-automation-new-picker--mobile--*` —— 选择器宽度与触发器一致，不再探出弹层右缘；「全选可用」。
- `kp-automation-empty--*` / `kp-automation-off--*` —— 空态变成图标 + 标题 + 说明（+ CTA）；总开关关着时标题旁写明「先开启上方总开关，再添加规则。」；
  写入能力提示改指「插件账号里」。
- `kp-automation-error--*` —— 红条带标题与「重试」按钮。
- 暗色 / 移动端各场景同样成立（56 张全部成功）。

**NOT RUN**：`npm test` 全量（改动限于本面板 + 新增用例；全量门由集成分支统一跑）、`npm run test:browser`（任务书明示非高频面可不跑）、
真机 iOS Safari、Popover 在 Radix Dialog 内的真实焦点循环（jsdom 用例只验 DOM 契约；FocusScope 栈按 Radix 文档会在 Popover 打开时暂停
Dialog 的焦点陷阱，与仓内其它「Modal 内嵌 Popover」写法一致）。

---

## 6. 不修 / 暂缓项

| 项 | 理由 |
|---|---|
| KP-18 加载态用骨架 | 面板高度取决于规则数，骨架行数无从预估；一行 spinner 文字 + 上方 Sheet 标题已足够说明"在加载"。保留。 |
| KP-19 每次编辑重拉星球列表 | 星球名字要靠它反查；列表通常 <20 条、接口轻。加缓存要处理账号切换失效，收益小于复杂度。保留。 |
| 弹层形态改 `Modal mobile="sheet"` | 表单弹层在手机上用贴底形态会更顺手，但全站其它设置类弹层都是居中形态，单独改会破一致性；建议由 shell 统一决定后再切。 |
| 消费 `Checkbox` 原语 | `ui/` 尚无 Checkbox，同意勾选框保留原生 `<input type=checkbox>`（功能与可访问性完整），不在本模块内造第二套（与 market K-27 同口径）。 |
