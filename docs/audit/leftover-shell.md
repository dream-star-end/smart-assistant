# 遗留清扫 · market K-27 Checkbox 原语 + settings 备案判据去重 + misc-p3 D-02 / D-08 接线（t-1234）

- 分支 `feat/v5-selfhost-audit-leftover-shell`，基于 integration `feat/v5-selfhost-ocv5-audit-ux @ 2d2b5cafc`（集成④ 本地终点，含 `4a2745283` 的 D-02 App 接线；任务书「若集成④已 push 则基于它」——集成④ 尚未推远端，本地已可用，故直接接在它之后）。工作树 `wt\leftover-shell`。
- 范围：三处「当时因缺 shell 原语或属 App 接线而遗留」的项。三项**均不碰后端即可落地**，没有需要后端 / 产品拍板的点。
- 接手说明：前任会话 09-17 02:26–03:05 完成全部 5 个代码提交与取证（before / after 截图、CDP AX 扫描、五份 vitest 日志，均在 `D:\code\test_project\test123\.audit-tmp\leftover-shell*`），离线前**未写交付文档、未回写 market / misc-p3 状态、未推送、未交付**。fable-5-1-52 于 09-17 22:15 接手：逐提交复核 diff 与任务契约一致、工作树干净、无未提交改动；在 HEAD `3aba642ca` 重跑 typecheck / typecheck:preview / 相关 vitest / biome 与基线逐文件对比；逐张 Read before / after 截图；补本文档与两处状态回写；推送并交付。
- 边界遵守：未碰 tutorials 模块、未碰 a11y-C 清单文件、未改任何既有原语行为（只新增 Checkbox）、`App.tsx` 只动 D-08 一处（D-02 那一处由集成④ 动过）、未加依赖、提交 subject 无 `fix(v5)`。

| 项 | 结论 | 提交 |
|---|---|---|
| ① market K-27 审核面 / 发布页原生 checkbox | ✅ 落地：新增 `ui/Checkbox` 原语 + market 4 处接入 + 2 个 ui-preview 场景 | `959735722` `ffac63718` `dc404359b` |
| ② settings「备案判据去重」（集成③ §7 待办） | ✅ 落地：删本地 `hasIcpNumber`，改引 `lib/legal` `filedIcp()` | `74026e020` |
| ③ misc-p3 D-02 `onDemoSelect` 按 id 取 fixture | ✅ 已由集成④ `4a2745283` 接线（任务书明示不重做）；本轮补 `App.test` 用例锁定 | `3aba642ca` |
| ③ misc-p3 D-08 demo 下交互块未说明原因 | ✅ 落地：`ChatInteraction.reason` + demo 专用文案 | `3aba642ca` |

---

## 1. ① market K-27 —— `ui/Checkbox` 原语与接入

### 1.1 评估

- 现状（market.md §3 K-27 / §5 / §9）：`ReviewPanel` 三处（「全选」、逐行「选择 {name}」、连接器「真实功能验收」确认）+ `PublishPanel` 一处（智能体工具集勾选卡）全部是原生 `<input type=checkbox className="accent-accent">`。功能、label 关联与 44px 触控靶当时都做了，问题只在**视觉与全站 Switch / Chip 的设计语言漂移**；阻塞点是 `components/ui` 没有 Checkbox，market 不该在模块内造第二套。kp-automation.md 的同意勾选框也按同一口径保留原生。
- 能否不碰后端：纯前端。不引入新依赖——仓里没有 `@radix-ui/react-checkbox`，加依赖需 `ask_decision`（PLAYBOOK §7），且原生 input 已把状态机、键盘与读屏语义全给了，没有引入第二套的理由。
- 取舍：**保留原生 `<input type="checkbox">`，只用 `appearance-none` 换视觉**。键盘（Space 切换）、表单提交、`<label>` 关联、读屏的 checkbox 角色与 checked / mixed 状态全由浏览器给；受控 / 非受控两种用法都对。

### 1.2 改法

- `components/ui/Checkbox.tsx`（新增，144 行；`959735722`）：
  - Props：`label`（渲染为包住控件的 `<label>`，同时是可访问名称）/ `description`（`text-caption`，走 `aria-describedby`，`aria-hidden` 不混进名称；与调用方自带的 `aria-describedby` 合并）/ `indeterminate` / `className`（落在外层 label，卡片式外观交给调用方）/ `controlClassName`（落在 16px 控件盒，如 `mt-0.5` 对齐多行首行）+ 其余原生 input 属性透传；`forwardRef` 到 `<input>`。
  - 可访问名称不变量：有 `label` 就是它；无文字必须自带 `aria-label` / `aria-labelledby`。
  - 触控靶：外层**始终**是 `<label>`（真正接收点击的元素），触屏 `[@media(hover:none)]:min-h-11`；无文字时再补 `min-w-11` 把 16px 的框居中撑到 44×44。桌面 hover 可用时渲染零变化——与 Button / Chip / Switch（a11y-shell shell#9）同一条约定。
  - `indeterminate` 是 DOM 属性不是 HTML attribute，由 `useLayoutEffect` 在首帧绘制前同步；读屏读 mixed，视觉为减号。勾（`Check`）与减号（`Minus`）二选一渲染，靠 `peer-checked` / `peer-indeterminate` 显隐，`pointer-events-none` 不抢点击。
  - 视觉：`rounded-[5px] border-border-strong bg-surface`；checked / indeterminate → `border-accent bg-accent` + `text-accent-fg` 图标；`focus-visible` ring；disabled → `cursor-not-allowed opacity-60`（调用方可用 `opacity-100` 覆盖）。字号语义档 `text-body` / `text-caption`。
  - `data-ui="checkbox"` 供用例 / 场景 / AX 脚本定位。
- `components/ui/index.ts` 导出 `Checkbox` / `CheckboxProps`。**既有原语零改动。**
- market 四处接入（`ffac63718`，功能、可访问名称、键盘与触控靶不变）：
  - `ReviewPanel` 「全选」：`indeterminate={selectedVisibleIds.length > 0 && !allSelected}` 由 prop 驱动，删掉手写 `ref={(el) => { el.indeterminate = … }}`。
  - `ReviewPanel` 逐行「选择 {name}」：无文字 + `aria-label`，44×44 触控靶由原语自带（原来是外包一层 label 手写 `min-h-11 min-w-11`），`controlClassName="mt-1"`。
  - `ReviewPanel` 连接器「我已使用隔离测试账号完成绑定、身份探针及声明动作的真实功能验收。」：`text-meta leading-relaxed`，`controlClassName="mt-0.5"` 对齐首行；窄屏折行时原语的 `min-h-11` 兜底。
  - `PublishPanel` 智能体工具集勾选卡：卡片外观仍由调用方 `className` 决定（原语只管控件 + 触控靶）；「必选」项 `disabled` 但 `opacity-100` **不压暗**——它是已勾定的事实，不是不可用的选项；label 内 `flex-wrap` 放名称 / hint / `必选` Badge。
- ui-preview 场景（`browser-tests/ui-preview/scenes-market-audit.tsx`，随代码提交）：
  - `market-review-partial`（`ffac63718`）：只勾一行 → 「全选」进入部分选中（减号 / mixed）。
  - `market-publish-agent-toolsets`（`dc404359b`）：工具集区块在首屏之下，`ClickStep` 新增 `scroll` 标志（`scrollIntoView({ block: "center" })` 再 click），选中「核心」必选卡的 label 把区块滚进视口后截图。

### 1.3 用例

| 文件 | 增量 | 覆盖 |
|---|---|---|
| `ui/Checkbox.test.tsx`（新增） | 9 例 | label 即名称 + 点文字切换；`aria-label` + 触控靶类名（`min-h-11` 恒有、无文字补 `min-w-11`）；有文字不补 `min-w-11`；`description` 走 `aria-describedby` 并与调用方 describedby 合并（`toHaveAccessibleDescription`）；`indeterminate` → `toBePartiallyChecked` + 减号，取消后回到勾；受控用法 + focus / click；disabled 点文字不切换；ref 透传到 `<input type=checkbox>`；`className` / `controlClassName` 落点 |
| `marketplace/ReviewPanel.test.tsx` | +1 | 四处 `data-ui=checkbox`；全无 / 部分 / 全选三态的 `indeterminate` 与 mixed；点「全选」文字全部取消 |
| `marketplace/PublishPanel.test.tsx` | +1 | 原语标记；卡片勾选态样式；必选项已勾、禁用、不压暗 |

### 1.4 验证（AX / 触控 / 视觉）

- **CDP 无障碍树 + 触控靶量化**（前任脚本 `.audit-tmp\leftover-shell\ax-checkbox.mjs`，改自 a11y-mod-b `measure-touch.mjs` 的构建链：esbuild 打 ui-preview harness + vite 出 production CSS + playwright-core 起本机 Chrome，`Accessibility.getPartialAXTree` 读 role / name / checked / disabled / describedby，`getBoundingClientRect` 量外层 label；日志 `ax-checkbox-after.{log,json}`，EXIT=0，32s）：
  - `market-review-partial` / `market-review-detail` / `market-publish-agent-toolsets` × mobile(390, hover:none) / desktop(1440) 共 **28 个** `input[data-ui=checkbox]`，**全部 `role=checkbox` 且有名**：「全选」「选择 周报生成器」「选择 站点批量抓取」「选择 合同审查员」「选择 CRM 客户档案桥接」「核心 文件 / 终端 / 基础工具 必选」「浏览器 操作真实浏览器」「研究检索 文献检索与引用」「网页提取 抓取网页 / 文档」。
  - `market-review-partial` 的「全选」`checked=mixed`、`indeterminate=true`（减号）；「周报生成器」`checked=true`；工具集「核心」`checked=true disabled=true`。
  - 移动端 14/14 外层 label **高恒 44px**（无文字 44×44、「全选」50×44、工具集卡 290×44）→ `touch=OK`；桌面端 label 16×20 / 50×18 / 174–234×36–38，无 `min-h`（按约定 hover 可用时零变化）。
- **视觉**：`.audit-tmp\leftover-shell\{before,after}\`，before 22 张 / after 30 张（after 多出 `market-review-partial` ×4、`market-publish-agent-toolsets` ×4 两个新场景），`failures: 0`、`unmockedApi: []`；逐张 Read 对照见 §5。

---

## 2. ② settings 备案判据去重

### 2.1 评估

- 出处：INTEGRATION.md 集成③ §7「待办登记：… settings 备案判据可选去重（owner）」；settings.md §（关于页「备案」占位文案）行：settings 二期（t-628）为「占位文案不上备案栏」写了本地 `hasIcpNumber(icp)`（`/\d{4,}/`），代码注释即标明「集成合入后可直接改为引用 `filedIcp()`」。
- 能否不碰后端：纯前端。landing-B 的 `lib/legal.ts` `filedIcp(icp)`（`trim` + 同一正则，就位则返回归一后的文本、否则 `null`）已在 integration，可直接引用。

### 2.2 改法（`74026e020`）

- `components/SettingsCenter.tsx`：删掉本地 `hasIcpNumber`，`import { filedIcp } from "../lib/legal"`；`AboutSection` 「备案」行的**条件与展示值都取 `filedIcp(BRAND.icp)`**——关于页 / landing 页脚 / 法务页三处判据与归一口径同源，不再各写一份。
- `components/SettingsCenter.test.tsx`：「备案占位文案不渲染，真实备案号才出现」用例追加第三段：`BRAND.icp = "  赣公网安备 36010002000123号  "` → 页面展示首尾空白归一后的文本。

---

## 3. ③ misc-p3 D-02 / D-08

### 3.1 D-02 `onDemoSelect` 按 id 取 fixture —— 集成④已接线，本轮补用例

- 出处：misc-p3.md §3.1 D-02 / §6「D-02 余项：demo 其余会话点开为空 → shell `App.tsx` `onDemoSelect` 一行改为 `setMessages(DEMO_MESSAGES_BY_SESSION[id] ?? [])`」。
- 评估：集成④ `4a2745283`「集成④ App 接线 · … misc-p3 D-02 demo 会话按 id 取 fixture」已把 `App.tsx:646` 改成 `onDemoSelect: (id) => setMessages(DEMO_MESSAGES_BY_SESSION[id] ?? [])`；任务书明示「H-18 接线已由集成④ 做，不要重做」，D-02 同理，本轮**不改代码**。
- 补齐：`App.test.tsx` +1（`3aba642ca`）「demo 切换会话按 id 取 fixture：其余会话为空会话且不出历史骨架，切回 s1 恢复消息（D-02）」——`?demo=1` 下点「锂金属负极枝晶抑制机理综述」（s2）：s1 的消息消失、`aria-label「正在加载会话历史」` 与 `partial-history-skeleton` 均不在；点回「把商业版重做成 ChatGPT 风格」（s1）恢复 fixture；全程 `fetch` 零调用。此前 D-02 只有 `lib/demo.test.ts` 守 fixture 与 `messageCount` 对齐，App 侧的接线没有用例。

### 3.2 D-08 demo 下交互块「(此会话中不可交互)」未说明原因 —— 落地

- 出处：misc-p3.md §3.1 D-08 / §6「`ChatInteraction` 加 `reason` 或 demo 下专用文案（shell + messages）」。
- 评估：`App.tsx` demo 分支给 `ChatInteractionContext` 传 `{}`，回复里的 options 选择卡只能笼统写「(此会话中不可交互)」，没说明是因为演示模式。跨 shell（`App.tsx`）/ tools（`components/tool/context.ts`）/ messages（`RichBlocks.tsx`）三个归属，纯前端文案 + 一个可选字段；不需要后端。
- 改法（`3aba642ca`）：
  - `components/tool/context.ts`：`ChatInteraction` 加可选 `reason?: ChatInteractionUnavailableReason`（联合类型，当前仅 `"demo"`；不传 = 历史 / 只读等一般情形）；新增 `chatInteractionUnavailableText(reason)`：`"demo"` →「(演示模式仅供浏览,登录后可在真实会话中点选)」，其余 →「(此会话中不可交互)」。文案集中在一处，不写死在各个块里。
  - `components/RichBlocks.tsx` `OptionsBlock`：无 `sendUserText` 时按 `reason` 取文案，其它分支不变。
  - `App.tsx`：`chatInteraction` 的 `useMemo<ChatInteraction>` demo 分支 `{}` → `{ reason: "demo" }`。**`App.tsx` 本轮只动这一处**（连同集成④已动的 D-02 一处，即任务书「App.tsx 只动这两处」）。
- 用例：`RichBlocks.test.tsx` +1（demo 文案与通用文案二分：`reason: "demo"` 出「演示模式仅供浏览」、不出「此会话中不可交互」；`{}` 反之）。

---

## 4. 验证汇总（fable-5-1-52 · HEAD `3aba642ca` · 09-17 22:20–22:30，均在 `wt\leftover-shell`）

| 门 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck --workspace packages/web-react` | ✅ `tsc -b` exit 0（`.audit-tmp\leftover-shell-typecheck.log`） |
| 场景类型检查 | `npm run typecheck:preview`（`tsc -p tsconfig.browser-tests.json`） | ✅ exit 0，**0 错**（含新增 `scroll` 字段与两个新场景） |
| 相关单测 ① | `npx vitest run src/components/ui/Checkbox.test.tsx src/components/marketplace/ReviewPanel.test.tsx src/components/marketplace/PublishPanel.test.tsx src/components/SettingsCenter.test.tsx src/components/RichBlocks.test.tsx src/components/MarketplaceCenter.test.tsx --maxWorkers=1` | ✅ **6 文件 / 92 例全绿**（`leftover-shell-vitest-final-1.log`）；新增 9 + 1 + 1 + 1 例，既有 1 例（备案）追加断言；无 `.only` / `.skip` |
| 相关单测 ② | `npx vitest run src/App.test.tsx --maxWorkers=1` | ✅ **48/48**（第二次，35.6s，`…-final-app-2.log`）。第一次 47/48：`authenticated send goes through the real WS engine…` 15s 超时——与本轮改动无关（authenticated 路径，不经 demo 分支），是 INTEGRATION.md 集成③ §6 已登记的「`App.test.tsx` 15s 超时 · 负载偶发」基线项（当时本机 CPU 53%，多会话并行）；同一 HEAD 立即复跑全绿（`…-final-app.log` / `…-final-app-2.log` 两份日志都留） |
| 代码风格 | `npx biome lint <15 个改动 / 新增文件>` HEAD vs. integration `2d2b5cafc`（主克隆同一组文件） | ✅ **0 新增**：13 个既有文件的诊断按「文件 × 规则」逐条对比**完全相同**（合计 29：`App.tsx` `useExhaustiveDependencies` 14、`PublishPanel.tsx` `noDelete` 1 + `noArrayIndexKey` 3、`ReviewPanel.tsx` `useExhaustiveDependencies` 2 + `noArrayIndexKey` 2 + `suppressions/unused` 1、`RichBlocks.tsx` `useTemplate` 3 + `noShadowRestrictedNames` 1 + `suppressions/unused` 1、`SettingsCenter.tsx` `noNoninteractiveTabindex` 1，全在未触碰的行）；新增 `Checkbox.tsx` / `Checkbox.test.tsx` **0 条**（`leftover-shell-biome-{head,base}-detail.log`、`…-head-checkbox.log`） |
| AX / 触控靶 | `OC_TAG=after node .audit-tmp\leftover-shell\ax-checkbox.mjs`（前任 09-17 03:0x，代码自此未变） | ✅ 28/28 有名、`mixed` 正确、移动端 14/14 label 高 44px（§1.4） |
| 视觉 | `OC_UI_SCENES=market-review,market-publish-agent node browser-tests\ui-preview\shoot.mjs` → before 22 / after 30 张 | ✅ `failures: 0`、`retried: 0`、`unmockedApi: []`；逐张 Read 对照见 §5 |

**NOT RUN**：`npm test` 全量（改动限于 `ui/Checkbox`、marketplace 两面、`SettingsCenter`、`tool/context` + `RichBlocks` 一句文案、`App.tsx` 一行；直接使用方 7 个测试文件已单跑绿，全量门交集成⑤统一跑）；`npm run test:browser`（未碰 Composer / 消息时间线状态机 / 工具卡 / 侧栏——`RichBlocks` 只换一句静态文案；真 Chromium 覆盖走 ui-preview 截图台 + CDP AX 脚本）；真机 iOS Safari；真实 `?demo=1` 整页截图（截图台不挂整 App，D-08 文案以 `RichBlocks.test` 覆盖，D-02 以 `App.test` 覆盖）。

---

## 5. 视觉 before / after 对照（同名 PNG，逐张 Read；PNG 不入库）

- **字节相同 6 张**：`market-publish-agent--*` ×4（工具集区块在首屏之下，静态图拍不到——正因如此补了 `market-publish-agent-toolsets` 场景）、`market-review-empty--*` ×2（空态没有 checkbox）。
- **不同 16 张**（`market-review` / `-batch` / `-detail(-mobile)` / `-mobile` / `-reject` 全部 desktop + mobile × light + dark）：差异全部是 checkbox 本体——原生 13px 方块（浏览器默认 + `accent-color`）→ 16px、圆角 5px、`border-strong` 描边的空框；勾选态 accent 填充 + 白勾；暗色下描边 / 填充随 token 走，不再是浏览器自绘的灰白方块。行高、卡片间距、按钮位置不变。
- **已核对并接受的一处布局差异**：`market-review--desktop--*`「站点批量抓取」行的第 4 枚徽章「自报增益存疑」从同一行折到第二行。原因：行首控件 13 → 16px，该行内容区窄了 3px，而这一行（版本号 + 4 枚徽章）在 1440 宽下本就贴着折行临界；容器是 `flex-wrap`，折行是既定行为，其余三行不变，移动端 before 已折行、无差。不算回归，不为此改控件尺寸（16px 与 Switch / Chip 同档）。
- `market-review-partial--*`（新）：只勾「周报生成器」→ 行首 accent 实心勾、「全选」减号（mixed）、「已选 1」、批量拒绝 / 批准按钮从禁用变可用。
- `market-publish-agent-toolsets--*`（新）：「核心 · 文件 / 终端 / 基础工具 · 必选」卡 accent 描边 + 浅 accent 底、已勾、禁用但**不压暗**；其余三卡空框；移动端每卡高 ≥ 44px、勾选框与文字首行对齐。
- `market-review-detail--*`（desktop / mobile）：展开「站点批量抓取」审查区，行首空框与「全选」空框视觉一致，展开区内容与 before 一致。
- **未入图的一处**：连接器「我已使用隔离测试账号…真实功能验收」确认框只在展开 **API 插件行**（CRM 客户档案桥接）的审查区里出现，现有 `market-review-*` 场景展开的是技能行，截图与 AX 扫描都没覆盖到它；接入方式与另三处相同（`label` + `controlClassName="mt-0.5"`），由 `ReviewPanel.test` 的「四处 `data-ui=checkbox`」用例覆盖。要补图需新增一个展开 CRM 行的场景，本轮未做。

---

## 6. 交集成⑤ / 归档 / 其他 owner 的事（本轮只回写 `market.md` / `misc-p3.md` 主文档）

| 位置 | 现状 | 处置建议 |
|---|---|---|
| `INTEGRATION.md` 集成③ §7「待办登记：… settings 备案判据可选去重（owner）」 | 待办 | 集成⑤ 划掉，指 `74026e020` |
| `SUMMARY.md` 跨模块遗留表「market K-27 / kp-automation 同意勾选 → Checkbox 原语」「misc-p3 D-02 余项 / D-08」「settings 备案判据去重」三行 | 遗留 | 归档终稿改为已落地（t-1234，本文档） |
| `archive/market.md` §4 K-27 行、`archive/misc-p3.md` D-02 余项 / D-08 行、`archive/README.md` market「3 遗留」/ 杂项 P3 遗留列、`qa/qa-gap.md` §5 D-02 余项 / D-08 行 | 遗留 | 归档终稿同步（本轮不动归档 / QA 文档） |
| `settings.md` 关于页「备案」行「集成③ 合入后可改为直接引用，已在代码注释里标出」 | 描述的是改前状态 | settings owner / 归档补一句「已由 t-1234 `74026e020` 改引 `filedIcp()`」 |
| `kp-automation.md`「同意勾选框保留原生 `<input type=checkbox>`（`ui/` 尚无 Checkbox）」 | 原语已就位 | 后续可把 `KnowledgePlanetAutomationPanel` 同意勾选换成 `ui/Checkbox`；不在本任务边界（manage / settings owner，且需另出 before / after），列为建议 |
| `market.md` §3 K-27 行「`ui/` 没有 Checkbox 原语」 | 审计原文 | 保留原文，§9 / §10 状态行已回写（见本次 `docs` 提交） |

## 7. 遗留

无。三项全部落地或已由集成④落地并补用例；上表为文档同步项与一条可选的后续采用建议。
