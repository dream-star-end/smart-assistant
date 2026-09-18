# a11y-C · 跨模块同源项清扫（t-1233，接 a11y-shell 交付 §5）

- 分支：`feat/v5-selfhost-audit-a11y-c`。**基线 = 远端 integration `36bb9a677`（集成③ 记录）+ 按任务书 `--no-ff` 合入 a11y-shell @`4930707cc`**（新 token / `-fg` 就位）。集成④ 当时尚未 push（本地已合到 `b23955208`），为避免本条要改的文件与已验收分支二次冲突，又 `--no-ff` 合入了 6 条**已 push、已验收**且与本条改动文件重叠的分支：a11y-mod-a @`475e3e6c7`（RepoPill / ApiKeysSection …）、a11y-mod-b @`9710a3b24`（Image* / ModelSelector / MediaTaskCenter）、kp-automation @`b0fd16dad`、misc-p3 @`c834dffa1`（optionsGroup / RichBlocks）、tut-sync-2 @`67b1494ea`（AgentPicker / Composer）、qa-gap @`c1734aac6`（KP-14）。合入后 `packages/web-react/src` 与本地集成④ HEAD 的差异只剩 PermissionCard（本条明令不碰）。7 个合并提交内容与集成④ 完全相同，合入时应为零冲突。
- 依据：t-893 交付文档 `docs/audit/a11y-shell.md` §5 的跨模块同源项清单（行号以本基线为准重新定位），加上本基线复扫（288 场景）里属模块内写法、能一行改定的对比度命中。
- 边界：不改 token 值、不改 `components/ui` 原语层、不碰 `chat/PermissionCard.tsx`。改文件前 `check_paths` + 写锁；提交不用 `fix(v5)`。
- 结论：**§5 清单 13 项逐条有处置 —— 已修 7 项 / 9 处 className（6 个提交）、已由同批分支闭环 5 项（不重复改）、不修 1 项（写明理由；另 9′ 子项不修）**；另按复扫补修 2 处 placeholder。（计数按 §1 表逐行核对，第四手 §2.2 修正。）复扫后「bg-accent / bg-danger 上白字」类文本命中 ****0**（before 4）**；整体对比度命中 浅色 49 → 47、深色 77 → 70，触控 / 无名控件 / Tab 走查各项不变。
- 收尾说明（t-1344）：原持有人 fable-5-1-38 在 7 条代码提交（HEAD `faa6e8b26`）后离线，本文档未跟踪、分支未 push。fable-5-1-55 接手：复核 7 条提交 diff、独立重跑全部验证门（§2.1），按 biome 结果补 1 条用例格式化提交 `12275f27a`；成文前再次离线（本文档未提交、分支未 push、全量单测中断）。fable-5-1-50（指挥官，2026-09-17 23:5x）第三手接管：核对 §2.1 日志齐全、补全量单测结论（NOT RUN，交集成⑤）、提交本文并 push（`361f59b1f`）；t-1233 在原任务 id 下交付。fable-5-1-3（第四手，09-18 00:2x，t-1344）：接手时文档已提交、origin 已与本地一致，任务书里「未跟踪 / 未 push」的前提已不成立；本轮在同一代码 HEAD 上独立重跑全部验证门（§2.2）、复核 diff 与 §5 处置计数并修正、补远端跟踪引用、交付。

---

## 1. §5 清单逐条处置

对比度口径：文本 ≥4.5:1，非文本（图标 / 勾标）≥3:1。深色 `--accent #9a8aff` / `--danger #f0666e` 是浅色底，白字分别只有 2.82 / 3.07:1；`text-accent-fg` / `text-danger-fg` 在深色取近黑 `#15151c`（6.45 / ≈6:1），浅色仍为白（vs `#5a3fee` 6.21、vs `#bb202a` 6.26）。

| # | 位置（本基线行号） | 现象 → 前后对比度 | 处置 / 改法 | 提交 |
|---|---|---|---|---|
| 1 | `org/OrgSubscribeDialog.tsx:173` 套餐卡「当前」徽章 | `bg-accent text-white`，深色 2.82（复扫 before 命中 `#ffffff/#9a8aff`） → 6.45 | **已修**：`text-white → text-accent-fg`；新增 `OrgSubscribeDialog.test.tsx`（此前无用例）断言类名 | `b591e64b6` |
| 2 | `manage/OptimizationPanel.tsx:296` hero 图标块 | 白图标压 accent，深色 2.82（非文本需 ≥3） → 6.45 | **已修**：`text-accent-fg`；`OptimizationPanel.test` 新增一例 | `b591e64b6` |
| 3 | `settings/ApiKeysSection.tsx:476` CC Switch 教程头图标块 | 同上 | **已修**：`text-accent-fg`；`ApiAccessTab.test` 补断言（`guide-ccswitch` 内 `span.size-10`） | `b591e64b6` |
| 4 | `settings/ApiKeysSection.tsx` 已禁用密钥行整行 `opacity-60`、「设置上限」「已禁用」徽章（t-762 settings#3/#6） | before 2.9 / 2.5 | **已由 a11y-mod-a 闭环**（其分支改动含 `ApiKeysSection.tsx`；本基线复扫 `ApiKeyRow` 0 命中），不重复改 | — |
| 5 | `AgentPicker.tsx:148` 默认智能体「默认」徽章 | `bg-accent/15 text-accent` 浅色 4.40 / 深色 3.89。第一步改 `bg-accent-soft` 后浅色达标，但第 1 轮复扫深色仍 4.11（`#9a8aff/#383556`）—— 徽章落在本就 `bg-accent-soft` 着色的默认卡上，soft 叠 soft 底变深 → 第二步改实底 | **已修（两步）**：最终 `bg-accent text-accent-fg`，与 SubscriptionDialog「当前」同款，浅 6.21 / 深 6.45，内距尺寸不变；`AgentPicker.test` 新增一例 | `abb246fdb` → `faa6e8b26` |
| 6 | `ModelSelector.tsx` 锁定 / 不可用模型行（t-762 composer#2） | before 3.3–3.8 | **已由 a11y-mod-b 闭环**（锁定行改 `text-muted` + 锁图标）；复扫仅剩 `dis=true` 的不可用行（禁用态例外，见 §3） | — |
| 7 | `optionsGroup.tsx:173` 选项组页脚「发送选择」 | t-893 时为 `bg-accent text-white` | **已由 misc-p3 重构闭环**：页脚改用 `Button` 原语（`text-accent-fg`），源码已无 `bg-accent text-white`；复扫仅剩 `dis=true` 的禁用态 | — |
| 8 | `RichBlocks.tsx:256`（已选项勾标 ✓）、`:274`（「确认选择」按钮） | 深色 2.82（复扫 before `#ffffff/#9a8aff` ×3，misc-options-* 场景） → 6.45 | **已修**：两处 `text-accent-fg`；`RichBlocks.test` 新增一例断言勾标与确认键 | `59e66773f` |
| 9 | `ImageCommentMode.tsx:410`、`ImageAnnotationEditor.tsx:1057` 「放弃」危险主键 | `bg-danger text-white`，沉浸台恒深色，深色 3.07 → ≈6 | **已修**：`text-danger-fg`；两个放弃确认用例各补断言 | `5533e0503` |
| 9′ | 同三文件的 `bg-danger/25 … text-white` 提示条（`ImageCommentMode:332`、`ImageAnnotationEditor:917`、`ImageResizeMode:235`） | 底是 25% danger 叠在 `bg-black/95` 上，白字两套主题均 ≥12:1 | **不修**：换成 `-fg` 在深色会变成近黑压深底、反而不可读；保持白字 | — |
| 10 | `MediaTaskCenter.tsx:436` Sheet header 随内容滚（t-762 media#1） | — | **已由 a11y-mod-b 承接**（其分支改动含 `MediaTaskCenter.tsx`）；且 Sheet 原语已有「越界滚回」兜底（t-893 shell#8） | — |
| 11 | `github/RepoPill.tsx`、`RepoStatusBanner.tsx` `opacity-70/80` 降色（t-762 sidebar#1/#2） | before 2.5–4.0 | **已由 a11y-mod-a 闭环**（其分支改动含两文件；本基线复扫 0 命中） | — |
| 12 | `marketplace/ReviewPanel.tsx` RevokeBox「下架」、Installed「卸载」等禁用态按钮 | `Button` 禁用态 `opacity-50`，2.5 | **不修**：禁用控件属 WCAG 1.4.3 例外（非活动 UI 组件不要求对比度）；且改法在 `ui/Button` 原语层，不在本条边界 | — |
| 13 | `settings/KnowledgePlanetAutomationPanel.tsx:960` 批量新建·星球选项勾选框 | `border-accent bg-accent text-white`，深色 2.82 → 6.45 | **已修**：`text-accent-fg`；KP-05/06 用例补断言 | `00b86b565` |

### 1.1 复扫补修（本基线复扫命中、模块内一行改定）

| 位置 | 现象 → 前后 | 改法 | 提交 |
|---|---|---|---|
| `ImageAnnotationEditor.tsx:946` 修改描述 textarea | `placeholder:text-white/40` 在 `bg-neutral-900` 上实测 `#757575/#1a1a1a` 3.81 → `/60` ≈ 6.9 | 一行 | `c0c9059a1` |
| `ImageCommentMode.tsx:364` 评论输入框 | 同源写法（复扫场景里输入框已有值故未命中） → 同改 `/60` | 一行 | `c0c9059a1` |

---

## 2. 验证

全部在 `wt\a11y-c`（代码 HEAD `faa6e8b26`）上跑；日志与产物在仓库外 `D:\code\test_project\test123\.audit-tmp\a11y-c\`。

- **typecheck**：`npm run typecheck --workspace packages/web-react` → ✅ exit 0（`typecheck.log`）。
- **涉及模块单测**：`npx vitest run` 8 个文件（OrgSubscribeDialog / OptimizationPanel / ApiAccessTab / RichBlocks / KnowledgePlanetAutomationPanel / ImageCommentMode / ImageAnnotationEditor / AgentPicker）→ ✅ 8 文件 / 121 例（`vitest-targets.log`）；placeholder 补修后 media 两文件复跑 ✅ 32 例。每处改动对应一条类名断言：新增用例 4（OrgSubscribeDialog、OptimizationPanel、RichBlocks、AgentPicker）、既有用例补断言 6（ApiAccessTab、KP、ImageCommentMode ×2、ImageAnnotationEditor ×2）。全量 `npm test` 原持有人未跑完（`vitest-full.log` 截断），收尾轮补跑，结果见 §2.1。
- **biome**：对 16 个改动文件分别在基线版本（`git show 9479bfd76:…`）与改后版本跑 `biome check --max-diagnostics=500`，按「文件 × 规则」计数 lint 规则逐项相同（`biome-base-counts.txt` / `biome-after-counts.txt`）。收尾轮复核发现原文「新增的 `OrgSubscribeDialog.test.tsx` 0 诊断」不成立——该新文件带 1 条 `format`（双引号 + 分号，不合 `biome.json` 的 `quoteStyle: single` / `semicolons: asNeeded`），已由 `12275f27a` 格式化归零，最终 **0 新增**（证据见 §2.1）。
- **CDP 复扫**（`.audit-tmp\a11y\scan.mjs`，288 场景，桌面浅/深 + 移动；before = 本基线 `9479bfd76`，after = 代码 HEAD）：

| 指标 | before | after | 变化 |
|---|---|---|---|
| 浅色文本对比度 <4.5 命中（cL） | 49 | 47 | −2 |
| 深色文本对比度 <4.5 命中（cD） | 77 | 70 | −7 |
| 「白字压 bg-accent / bg-danger」类命中（`#ffffff/#9a8aff`、`#ffffff/#f0666e`、`#ffffff/#5a3fee`、`#ffffff/#bb202a`） | 4（「当前」×1 + 勾标 ✓ ×3） | **0**（before 4） | — |
| 移动端 44px 触控（t44）/ 桌面 24px（t24） | 166 / 377 | 166 / 377 | 不在本条范围 |
| 无名控件（names / ax）/ Tab 异常（tabBad）/ 渲染失败 | 11 / 1 / 12 / 0 | 11 / 1 / 12 / 0 | 不在本条范围 |

- 复扫跑了两轮：第 1 轮（前 6 个代码提交）已把「白字压 accent / danger」清零，但暴露出 AgentPicker「默认」徽章在深色仍 4.11（soft 叠 soft），据此追加 `faa6e8b26`；第 2 轮 = 上表 after。两轮**逐场景对比均无任何指标上升**（`regress scenes: 0`）。
- before → after 清掉的组合：`#ffffff/#9a8aff`（「当前」×1、选项勾标 ✓ ×3）、`#5a3fee/#dbd5fb` 与 `#9a8aff/#3c385c`（「默认」浅 / 深）、`#757575/#1a1a1a`（圈选编辑器 placeholder）；增量不大是因为 a11y-mod-a / mod-b 已把 RepoPill / ApiKeysSection / ModelSelector 等大头清掉（本基线 before 已只剩 49 / 77）。
- after 剩余的非禁用态命中只有 §3 列的四类（`role=img` 示意图内文 ×3、`sr-only` ×2、禁用 textarea / Input 的 placeholder 与值 ×2），其余全部 `dis=true`。

- **截图对照**（`before\` = 主克隆 @ 本地集成④ `b23955208`，目标场景与本基线渲染一致；`after\` = 本分支）：场景 `org-subscribe-dialog`、`manage-optimization*`、`settings-api-access` / `settings-full-api-access`、`misc-options-*`、`kp-automation-new-picker`、`media-image-comment`、`media-annotation-editor`、`composer-agent-picker`，各 desktop / mobile × light / dark。两侧各 19 场景 / 60 张，failures = retried = 0，unmockedApi 为空（`shoot-before.log` / `shoot-after.log`）。**60 对截图尺寸逐张相同**（PNG IHDR 宽高比对，0 处变化）；31 对字节完全相同（浅色主题下 `-fg` 就是白，像素零变化），其余只有色值差（最大的是圈选编辑器 placeholder 变亮 ≈1.1KB）。

逐张看图（after）：

| 场景 | 看什么 | 结果 |
|---|---|---|
| `org-subscribe-dialog` desktop dark | 「当前」徽章 | 白字 → 近黑字压浅紫，清晰；卡片布局不变 |
| `misc-options-partial` desktop dark | 已选项勾标 ✓ ×3、「发送选择」 | 勾标改近黑字；页脚按钮（Button 原语）本就是 `-fg`；无布局变化 |
| `composer-agent-picker` desktop light / dark | 「默认」徽章 | 浅色白字压紫、深色近黑字压紫，与「预设」徽章并排尺寸一致 |
| `media-annotation-editor` desktop dark | 修改描述 placeholder | 由深灰 3.8:1 变为可读的浅灰；输入条尺寸不变 |
| `manage-optimization` / `settings-api-access` dark | 图标块 | 白图标 → 近黑图标压紫（字节差 185–396B，尺寸不变） |

### 2.1 收尾复核（t-1344 · fable-5-1-55）

接手时工作树 `wt\a11y-c` @ `faa6e8b26`：`origin` 上无 `feat/v5-selfhost-audit-a11y-c`（`git ls-remote` 空）、本文档 `??` 未跟踪；`git status` 另有 `packages/cli/src/index.ts`、`packages/mcp-memory/src/index.ts` 两个 `M`，`git diff` 内容为空（npm 行尾假改动，不动）。全部验证在本工作树独立重跑，日志在 `D:\code\test_project\test123\.audit-tmp\a11y-c\finish-*`。

**修复记录**

| 项 | 结果 |
|---|---|
| 7 条代码提交 diff 复核（`git diff 9479bfd76 faa6e8b26`） | 16 文件 / +143 −14：8 个源码文件共 11 处只改 className（`text-white → text-accent-fg / text-danger-fg`、`bg-accent/15 → bg-accent`、`placeholder:text-white/40 → /60`；第四手按 diff 逐处点数修正，原文写 10 处）外加 4 行注释，8 个用例文件只增断言 / 新用例；**无 style 之外的源码改动**，与 §1 表逐项对得上 |
| §5 清单 13 项 | 逐条有处置（§1 表）：已修 7 项（9 处）、同批分支闭环 5、不修 1（+9′ 子项），收尾轮未发现遗漏项（计数第四手按 §1 表逐行修正，原文写 8 / 4 / 1） |
| biome 新增诊断 | 新增文件 `OrgSubscribeDialog.test.tsx` 带 1 条 `format`（双引号 + 分号）→ 拿写锁后 `npx biome format --write` 该文件，只动引号 / 分号 / 换行（`git diff --ignore-all-space` 核对），单跑其用例 ✅ 1/1，`biome check` 该文件 0 诊断 → 提交 `12275f27a`（`style(v5)`）。是本轮唯一的代码改动，也是任务书「允许改动」之外唯一触碰的文件（本分支自己新增的用例，改动性质为纯格式） |

**验证（代码 HEAD `12275f27a`）**

- **typecheck**：`npm run typecheck --workspace packages/web-react` → ✅ exit 0（`finish-typecheck.log`）。
- **涉及模块单测**：`npx vitest run <8 个用例文件> --maxWorkers=1` → ✅ 8 文件 / 121 例，65s（`finish-vitest-targets.log`）。
- **全量单测**：`npx vitest run --maxWorkers=1`（packages/web-react）→ **NOT RUN**：收尾轮 22:41 启动后持有人 fable-5-1-55 掉线，`finish-vitest-full.log` 只剩 RUN 头一行；本分支 16 个改动文件对应的 8 个用例文件 121 例已全过（上一条），全量交集成⑤在合并树上统一复跑（集成④ HEAD 上同一套件 302 文件 / 4279 例全绿，本分支只改 className 与用例断言）。
- **biome**：`git archive` 导出基线 `9479bfd76` 与 HEAD `12275f27a` 的 16 个文件到仓库外临时目录，同一 `biome.json`、同一 biome 1.9.4 跑 `biome check --line-ending=crlf --max-diagnostics=500`（`--line-ending=crlf` 是为了排除 Windows `core.autocrlf=true` 检出带来的整文件行尾 `format` 噪音），按「文件 × 规则」计数 `Compare-Object` 为空：基线 36 错 / 1 警 → HEAD 36 错 / 1 警，全部是既有的 `useExhaustiveDependencies` / `useSemanticElements` / `noAutofocus` / `useTemplate` / `noShadowRestrictedNames` / `organizeImports` / 双引号风格 `format`；新增文件 0 诊断 → **新增 0**（`finish-biome-{base,head}-crlf.txt`、`finish-biome-{base,head}-crlf-counts.txt`）。不加 `--line-ending` 时基线 38+1 → HEAD 39+1，多出的 1 条是导出副本里新文件的 CRLF 行尾噪音（工作树里该文件为 LF、`biome check` 0 诊断）。
- **CDP 复扫**（`.audit-tmp\a11y\scan.mjs`，`OC_REPO=wt\a11y-c`，288 场景 → `finish-scan\`、`finish-scan.log`）：288 / 288 场景，渲染失败 0；汇总 cL 47 / cD 70 / t44 166 / t24 377 / names 11 / ax 1 / tabBad 12。`finish-compare.mjs`（→ `finish-compare.txt`）逐场景对比：**相对基线 `scan-before` 任一指标上升的场景 0**；与原持有人 `scan-after` 逐场景 0 差异（同一份代码，结果可复现）；对比度 fg/bg 组合 35 → 29，**新增 0**、清零 6（`#ffffff/#9a8aff` ×4、`#ebe8ff/#9a8aff`、「默认」浅 / 深、圈选编辑器 placeholder 浅 / 深）；「白字压 bg-accent / bg-danger」类命中 4 → **0**。
- **git**：`git status -sb` 除上述 2 个行尾假改动外干净；`git push -u origin feat/v5-selfhost-audit-a11y-c` 后 `git rev-parse origin/feat/v5-selfhost-audit-a11y-c` == 本地 HEAD（见 complete_task 交付）。

### 2.2 第四手独立复核（t-1344 · fable-5-1-3，2026-09-18 00:2x–00:4x）

接手状态：`wt\a11y-c` @ `361f59b1f`（= 代码 HEAD `12275f27a` + 指挥官的本文 docs 提交），`git ls-remote origin refs/heads/feat/v5-selfhost-audit-a11y-c` == 本地 HEAD——任务书写的「文档未跟踪 / 分支未 push」在派单前已由第三手完成；工作树除 `packages/cli/src/index.ts`、`packages/mcp-memory/src/index.ts` 两个 `M`（`git diff --stat` 为空，npm 行尾假改动）外干净；`node_modules\@openclaude\protocol` junction 指向本工作树。分支缺远端跟踪引用（`remote.origin.fetch` 只收 `feat/v5-selfhost`，`@{u}` 解析失败），本轮 push 后补 `git fetch origin +refs/heads/feat/v5-selfhost-audit-a11y-c:refs/remotes/origin/feat/v5-selfhost-audit-a11y-c`。全部验证在本工作树、同一代码 HEAD `12275f27a` 上独立重跑，日志在 `D:\code\test_project\test123\.audit-tmp\a11y-c\t1344-*`。

**复核**

| 项 | 结果 |
|---|---|
| diff 复核 `git diff 9479bfd76 12275f27a` | 16 文件 / +164 −14（含 `12275f27a` 格式化）；8 个源码文件 11 处 className（9 处接 §5：OrgSubscribeDialog 1 / OptimizationPanel 1 / ApiKeysSection 1 / AgentPicker 1 / RichBlocks 2 / ImageCommentMode 1 / ImageAnnotationEditor 1 / KnowledgePlanetAutomationPanel 1；2 处 placeholder）+ 4 行注释（AgentPicker 2、ImageCommentMode 1、ImageAnnotationEditor 1），无任何逻辑 / 结构改动；8 个用例文件只增断言 / 新用例。**无 style 之外的源码改动** |
| §5 处置计数 | 按 §1 表逐行点数：已修 7 项（#1/2/3/5/8/9/13，共 9 处）、同批分支闭环 5 项（#4/6/7/10/11）、不修 1 项（#12）+ 9′ 子项不修 = 13 项；文首结论与 §2.1 原写「8 / 4 / 1」「10 处 / 2 行注释」已同步修正，各项处置内容本身无改动 |
| 本轮代码改动 | 0（只改本文档） |

**验证（代码 HEAD `12275f27a`）**

- **typecheck**：`npm run typecheck --workspace packages/web-react` → ✅ exit 0，39s（`t1344-typecheck.log`）。
- **涉及模块单测**：`npx vitest run <8 个用例文件> --maxWorkers=1` → ✅ 8 文件 / 121 例，73.9s（`t1344-vitest-targets.log`）。
- **全量单测**：**NOT RUN**——任务书判据只要求触及模块；本分支只改 className 与用例断言，全量沿 §2.1 口径交集成⑤在合并树上统一复跑。
- **biome**：`git archive` 导出基线 `9479bfd76`（15 文件，`OrgSubscribeDialog.test.tsx` 基线不存在）与 HEAD `12275f27a`（16 文件）各带 `biome.json` 到 `.audit-tmp\a11y-c\t1344-biome\{base,head}`，同一 biome 1.9.4 在各自目录内 `biome check --line-ending=crlf --max-diagnostics=500 packages`：基线 36 错 / 1 警 → HEAD 36 错 / 1 警；`t1344-biome-count.mjs` 按「文件 × 规则」计数 37 = 37，`Compare-Object` 为空；新增文件 0 诊断 → **新增 0**（`t1344-biome-{base,head}.txt`、`t1344-biome-{base,head}-counts.txt`）。
- **CDP 复扫**（`.audit-tmp\a11y\scan.mjs`，`OC_REPO=wt\a11y-c`，288 场景 → `t1344-scan\`、`t1344-scan.log`，约 8.5 min）：288 / 288，渲染失败 0；汇总 cL 47 / cD 70 / t44 166 / t24 377 / names 11 / ax 1 / tabBad 13。`t1344-compare.mjs`（→ `t1344-compare.txt`）：对比度 fg/bg 组合 35 → 29，**新增 0**、清零 6（与 §2.1 同一组）；「白字压 bg-accent / bg-danger」4 → **0**；对比度 / 触控 / 无名控件任一指标相对基线上升的场景 **0**。唯一逐场景差异是 `tutorials-help-menu-open` tabBad 1 → 2：本轮 Tab 走查把 Radix FocusScope 护栏 `<span>`（`html > body > span`，0×0、`tabindex=0`、invisible）多计了一次（i=0 与 i=2 为同一元素），与 a11y-shell §4.5 记录的同场景计数抖动同源，`report.mjs` 本就把 `focusable-invisible` 排除在问题外；tutorials 不在本分支改动面内，非回归。
- **git**：本文提交后 `git push -u origin feat/v5-selfhost-audit-a11y-c`（HTTPS + 代理，非 force）→ origin HEAD == 本地 HEAD；`git status -sb` 除 2 个行尾假改动外干净（最终 SHA 见 complete_task 交付）。

### 2.3 t-1233 收尾补门：真浏览器交互门（fable-5-1-5，2026-09-18 00:3x–00:4x）

接手状态：t-1233 从待办池领到时 `wt\a11y-c` 已在 `361f59b1f`、origin 同步，fable-5-1-3 正以 t-1344 在同一工作树跑 §2.2 复核；故本手不改代码、不重复 §2.2 已跑的门，只补一项前三手都没跑过的门：本分支改到 `AgentPicker`（Composer）与 `RichBlocks`（消息面），按任务书 ③ / d-28 属高频交互面，`npm run test:browser` 必跑。等 §2.2 的 288 场景复扫进程退出后再启动，避免两套 Chromium 抢 CPU。

- **test:browser**（`cd packages\web-react; $env:OC_E2E_BROWSER='C:\Program Files\Google\Chrome\Application\chrome.exe'; npm run test:browser`，代码 HEAD `12275f27a`，日志 `.audit-tmp\a11y-c\t1233-test-browser.log`）：`run.mjs` 组件门 **68 / 68 全过**（自检「清单 68 条全部执行」；含 Composer T1–T4 / T22 / T23 / T35、消息面 T8–T12 / T18 / T21 / T68、工具卡 T13、T41 密度 token 明暗主题）；随后 `node --test` 16 文件 73 例：**70 过 / 3 败**，3 败与 INTEGRATION §5 集成①②③登记的基线逐条相同、与本分支改动无关：`cc-switch-ascii-name` ×2（settings `ApiKeysSection` 等「还没有 API Key」10s 超时 + 模型 id 断言 `gemini-3.8-flash` vs `sonnet-5`，未改动的主克隆同红）、`ocv5-185-qa` ×1（Windows `symlinkSync packages/protocol → node_modules/@openclaude/protocol` EPERM，环境项）。**无新增失败**。
- 只读复核：`git grep text-white` 全 `src`，与实底 `bg-accent` / `bg-danger` 同行的只剩 `TutorialCenter.tsx:387`（见 §3 补记）；`bg-grad-cta text-white`（Button gradient / Avatar brand / Sidebar / TeamPanel 等）与 `bg-black/xx` 上的白字不属本类。§1 表 13 项与 a11y-shell §5 表 13 行逐条对得上；8 个用例文件的 className 断言（`text-accent-fg` ×7 / `text-danger-fg` ×2 / `placeholder:text-white/60` ×2）与 `before\` / `after\` 各 60 张截图均在。
- 本手代码改动 0；文档提交见 §4。

---

## 3. 复扫后仍有命中但不属本条的项（逐条理由）

复扫 after 剩余的对比度命中全部落在下面四类，都不是「模块内一行改定」的对象：

1. **禁用态控件**（`dis=true`，占绝大多数）：`Button` 原语 `disabled:opacity-50` 把前景压到 3.35 / 3.44（保存 / 创建 / 登录 / 批量批准 / 下架 / 卸载 …），以及 ModelSelector 不可用行、市场禁用按钮、沉浸式编辑器禁用键。WCAG 1.4.3 对非活动 UI 组件不作对比度要求；改法也在 `ui/Button` 原语层（本条边界外）。
2. **禁用态输入框的 placeholder / 值**：Composer 「容器未就绪，输入区禁用」（textarea `disabled` + `disabled:opacity-50`）、taskboard 项目设置的项目前缀 Input（`disabled={mode === 'edit'}`）—— 同为禁用态例外。
3. **`role="img"` 示意图内文**：`TutorialCenter.tsx:1292` `ArtifactPreview` 假终端提示行 `text-white/35`（3.15）。整块是 `role="img"` + aria-label 的示意图（TU-16 已明示「示意图 · 非本案例实际产物」），内文对辅助技术不可达、视觉上属装饰，按 1.4.3 装饰性文本例外不改。
4. **`sr-only` 文本**：`容器网页预览与元素评论`（1.07）是视觉隐藏的读屏文案，扫描器读到的是隐藏元素，不构成问题。

另：`ContainerWebPreview.tsx:1345/1403/1775` 有同类 `text-white/35` 写法，但预览场景（加载 / 错误态）里这些元素未渲染、复扫未命中，本条按「复扫命中」口径未动，留给 media owner 顺手收。

另（t-1233 收尾补记）：`TutorialCenter.tsx:387` 教程中心头部图标块 `text-white` + `mode === "cases" ? "bg-accent" : "bg-grad-cta"`——「案例」模式下是白图标压实底 accent（深色 2.82 <3:1），与 shell#1 同根因；但它不在 a11y-shell §5 清单里，复扫也未命中（`<svg>` 图标不是文本节点，扫描器不计），且归 tutorials（本条边界外），按「§5 清单 + 复扫命中」口径不动。一行改法：`mode === "cases" ? "bg-accent text-accent-fg" : "bg-grad-cta text-white"`（`text-accent-fg` 不能直接套到 `bg-grad-cta` 分支上），留给 tutorials owner / 集成⑤ 顺手收。

---

## 4. 交付清单

- 分支 `feat/v5-selfhost-audit-a11y-c`，代码 HEAD `12275f27a`（本文档的三个 `docs(v5)` 提交紧随其后，最终 SHA 与 origin HEAD 见 complete_task 交付），基线见文首；本条自有提交 11 个（7 代码 + 1 用例格式化 + 3 文档，均 `style(v5)` / `docs(v5)`，未碰 changelog.json）：
  `b591e64b6` settings/org/manage 三处 `-fg`｜`59e66773f` messages RichBlocks 勾标 + 确认键｜`00b86b565` kp-automation 勾选框｜`5533e0503` media 两处「放弃」危险键｜`abb246fdb` composer 「默认」徽章底 soft｜`c0c9059a1` media 两处 placeholder｜`faa6e8b26` composer 「默认」徽章改实底 + `-fg`（复扫修正）｜`12275f27a` OrgSubscribeDialog.test 按 biome.json 格式化（收尾）｜`361f59b1f` 交付文档（第三手）｜`ea9348b2b` 收尾复核文档（第四手，t-1344）｜本次 test:browser 补门 + 遗留登记文档提交（t-1233 收尾，fable-5-1-5）。
- 未做（最少可交付口径）：相关模块 md 回写——同一清单已在 `a11y-shell.md` §5 按 owner 列出，本条处置以本文 §1 为准，模块文档的交叉引用交集成⑤ / 归档终稿统一登记。
- 改动文件（16 + 本文）：`OrgSubscribeDialog.tsx` + `OrgSubscribeDialog.test.tsx`（新）、`OptimizationPanel.tsx` + `.test.tsx`、`ApiKeysSection.tsx` + `ApiAccessTab.test.tsx`、`RichBlocks.tsx` + `.test.tsx`、`KnowledgePlanetAutomationPanel.tsx` + `.test.tsx`、`ImageCommentMode.tsx` + `.test.tsx`、`ImageAnnotationEditor.tsx` + `.test.tsx`、`AgentPicker.tsx` + `.test.tsx`、`docs/audit/a11y-c.md`。
- 未改：token 值、`components/ui/**`、`chat/PermissionCard.tsx`、任何分支合入。
- 仓库外产物：`.audit-tmp\a11y-c\{scan-before, scan-after, list.mjs, list-before.txt, list-after.txt, before, after, typecheck.log, vitest-targets.log, biome-*.txt, shoot-*.log}`；收尾轮 `finish-{typecheck,vitest-targets,vitest-full}.log`、`finish-biome-*.txt`、`finish-scan\`、`finish-scan.log`、`finish-compare.mjs`、`finish-compare.txt`；第四手 `t1344-{typecheck,vitest-targets,scan}.log`、`t1344-biome\{base,head}`、`t1344-biome-{base,head}.txt`、`t1344-biome-{base,head}-counts.txt`、`t1344-biome-count.mjs`、`t1344-scan\`、`t1344-compare.mjs`、`t1344-compare.txt`；t-1233 收尾 `t1233-test-browser.log`。
