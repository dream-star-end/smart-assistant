# A·manage 管理中心 · 审计报告

- 分支：`feat/v5-selfhost-audit-manage`（基线 `210b9967892b3624fb3984f69d2174e4a641b33d`）
- 阶段：A（审计，§1–§6）→ B（修复，§7–§9；发现 27 / 修复 22 / 遗留 5）
- 结论：**P1 × 1 / P2 × 8 / P3 × 18**，共 27 条。P1 是「未绑定聊天项目」作用域下定时任务
  面板把用户的任务表渲染成「还没有定时任务」空态（`cronBlocked` 算出来了却没渲染）。
- 跨模块另记 3 条（见 §6），其中 `hooks/useProjectScope` 的作用域重置竞态会让持久化 /
  深链的工作项目作用域在刷新后丢失，属 sidebar 归属；sidebar 负责人不在本协同组
  （`send_to` 回 `wrong_group`），需指挥官转达。

---

## 1. 范围与文件清单

管理中心六个标签页（记忆 / 技能 / 定时 / 插件 / 文献 / 优化）及其二级面板。

| 类别 | 文件（`packages/web-react/src/` 下） |
|---|---|
| 壳与分区注册表 | `components/ManageCenter.tsx`（197 行）、`lib/manageTabs.ts` |
| 记忆 / Auto-Dream | `components/manage/MemoryPanel.tsx`（1819 行：核心记忆 / 项目记忆 / 用户画像 / 用量 / 梦境报告卡 / 记忆编辑器 / 新建）、`components/manage/IdentityManual.tsx`、`components/manage/AgentProjectPreview.tsx`、`components/manage/ProjectAssetsManagePanel.tsx` |
| 技能 | `components/manage/SkillsPanel.tsx`、`components/manage/SkillEditor.tsx`（工作台：正文 / 文件 / 评测 / 训练优化 / 历史）、`components/manage/SkillOptPanel.tsx`（评测 + 训练分区，1403 行）、`components/manage/ProjectSkillOverlay.tsx`、`components/manage/skillDisplay.ts`、`lib/skillRunCost.ts`、`lib/skillTrainReentry.ts` |
| 定时任务 | `components/manage/CronPanel.tsx`（1087 行）、`lib/cron.ts` |
| 连接器 / 插件账号 | `lib/connectors.ts`（契约类型 + 错误码文案 + 图标 / 能力标注）；渲染层 `components/settings/ConnectorsTab.tsx`（2503 行）与 `components/settings/KnowledgePlanetAutomationPanel.tsx` **归 settings（fable-5-1-21）**，本轮只审不改，见 §6 |
| 文献库 | `components/manage/LibraryPanel.tsx`、`lib/research/cite.ts` |
| 优化 | `components/manage/OptimizationPanel.tsx`（816 行） |

对应 `*.test.ts(x)` 随源文件归属。审计维度按 PLAYBOOK §5 七项清单逐项过：UI/视觉、
响应式/移动端、交互友好性、功能正确性、可访问性、文案、代码质量。

**不在本轮范围**：`components/ui/**` 原语本身（shell）、`hooks/useProjectScope`（sidebar）、
`components/ProjectAssetsPanel`（sidebar）、`components/settings/**` 的修改权（settings）、
需要改协议 / 后端才能修的问题（记入 §5「需后端配合」）。

---

## 2. 方法与证据

### 2.1 ui-preview 场景

既有 `browser-tests/ui-preview/scenes-manage.tsx` 已覆盖六个 Tab 的首屏三态（有数据 / 空 /
错，20 个场景），但只有「记忆」「定时」给了移动端视口，且**所有要点一下才能到达的二级状态**
（工作台、编辑器、表单、弹层、扫码中间态）和**工作项目作用域**下才出现的三块面板一个都没有。

新增 `browser-tests/ui-preview/scenes-manage-audit.tsx`（只增不改既有文件），28 个场景：

| 组 | 场景 id | 内容 | 视口 |
|---|---|---|---|
| 移动端补齐 | `manage-{skills,connectors,library,optimization,skills-empty}-mobile` | 直接派生既有场景对象（同一份 mock），只跑 mobile | mobile |
| 记忆二级 | `manage-memory-usage` / `-profile` / `-editor` / `-new` / `-coldstart` | 用量页签、用户画像页签、打开一条记忆的编辑器、新建弹层、503 冷启动提示 | desktop（前三个 + mobile） |
| 定时二级 | `manage-cron-create` / `manage-cron-edit-advanced` | 新建表单；编辑 `*/30 * * * *`（还原不出友好预设 → 高级 Cron + 「改用友好模式」） | desktop / mobile |
| 技能工作台 | `manage-skill-workbench-{body,readonly,files,evals,train-draft,history}` | 五个页签 + 只读技能；训练草稿就绪态带行级 diff 与评测门结论 | desktop / mobile（history 仅 desktop） |
| 优化二级 | `manage-optimization-diff` / `-conflict` | 建议 Diff 弹层；有冲突的建议 | desktop（diff + mobile） |
| 插件二级 | `manage-connectors-qr-waiting` / `-qr-expired` / `-write-consent` | 知识星球扫码授权等待态（伪二维码 blob）、二维码过期失败态、开启写入能力的免责确认 | desktop / mobile |
| 工作项目作用域 | `manage-skills-workscope` / `manage-memory-workscope` / `-workscope-project` / `-workscope-appendix` / `manage-cron-chatscope` | 项目专属技能勾选块；核心记忆 + 追加的项目资产 / Agent 上下文预览；项目记忆页签；**未绑定聊天项目下的定时任务面板（P1 证据）** | desktop / mobile |

两处预览台技术点（都收在场景文件里，不动 harness / shoot.mjs / api-stub.ts）：

- **`<AutoClick>`**：挂载后按顺序模拟点击（selector 或按钮文案子串），把静态预览台推进到
  二级状态；`OC_UI_SHOT_DELAY=900` 给点击链足够时间。
- **`installBoardStub()`**：`taskboardApi` / `identityCompatApi` 走原生 `fetch`（不经 api 代理），
  在场景 render 时接管 `/api/board/*` 与 `/api/agents`，未命中回落 harness 的 204；卸载清表。
  作用域 token 同时写 `localStorage` 与 `?project=`（provider 以 URL 优先）。

`api-stub.ts` **未改**。manifest 的 `unmockedApi`：`listCronChannels`（既有 scenes-manage 场景
未打桩，中性值 → 送达方式回落写死三项，属预期）、`listProjectAssets`（`ProjectAssetsPanel`
是 sidebar 组件，中性值 → 渲染其空态，正是要看的形态）。

### 2.2 截图基线

```
D:\code\test_project\test123\.audit-tmp\manage\before\
```

132 张 PNG（48 场景 × desktop/mobile × light/dark，按场景声明的视口：既有 20 + 新增 28），
外加 `manifest.json`（`failures: 0`、`retried: 0`）与三份 `shoot-before-*.log`。复跑命令：

```powershell
cd d:\code\test_project\test123\wt\manage\packages\web-react
$env:OC_E2E_BROWSER='C:\Program Files\Google\Chrome\Application\chrome.exe'
$env:OC_UI_SHOTS='D:\code\test_project\test123\.audit-tmp\manage\before'
$env:OC_UI_SCENES='manage-'
$env:OC_UI_SHOT_DELAY='900'
node browser-tests\ui-preview\shoot.mjs
```

直接充当证据的几张：

- `manage-cron-chatscope--desktop--light.png` —— 作用域选「会话组 · momo 号日常」（未绑定看板的
  聊天项目），面板渲染「还没有定时任务 + 创建第一个定时任务」，而同一份 mock 在「全部项目」下
  有 3 条任务（M-01）。
- `manage-memory-usage--desktop--light.png` —— 「记忆在会话里如何被使用」「按操作」字号明显大于
  面板其余文字（`text-body-sm` 不存在 → 继承），四张统计卡只有描边没有底色（`bg-surface-subtle`
  不存在）（M-02）。
- `manage-memory--desktop--light.png` —— 记忆面板首屏第一块就是一条橙色告警「无法读取本实例手册
  的注册信息 / 重试手册入口」；预览台没有打桩 `/api/agents`，生产里该接口失败或返回非 JSON 时
  用户看到的就是这一屏（M-04）。
- `manage-skill-workbench-readonly--desktop--light.png` —— 只读技能的描述与正文以 `disabled`
  控件 50% 透明度呈现，且标题 / 描述 / 标签全是半角标点（M-05、M-12）。
- `manage-skills-workscope--desktop--light.png` —— 「项目专属技能」块：原生方框复选框、裸 slug、
  「· 覆盖 · 已排除 · 适用 …」拼接文案、常驻蓝色说明条；整块把搜索框与技能列表往下顶了约 250px
  （M-06）。
- `manage-memory-workscope-appendix--desktop--light.png` —— 「上传、删除、固定/取消固定走既有
  /api/project-assets。按 digest 去重；文件名含密钥/二维码等会标敏感。」「只读 preview API。
  不可逐字重放。」「instructions · 1240B」（M-07）。
- `manage-skills-mobile--mobile--light.png` —— 390px 下技能行标题被徽章 + 三个图标压成约 110px
  宽两行截断（「OpenClaude / v5（Auror…」）（M-08）。
- `manage-connectors-mobile--mobile--light.png` —— 微博插件卡：右侧「更新 / 卸载」动作簇不收缩，
  描述被压成每行 6 字的窄柱（M-09）。
- `manage-connectors--desktop--dark.png` —— 邮箱卡第二个账号 `displayName` 为空，
  `accountHint` 既当标题又在元信息行重复一遍（M-18）。
- `manage-memory--mobile--light.png` —— 六个 Tab 单行横滚，第 6 个「优化」（唯一带待办徽标的）
  在 390px 下整个在视口外（M-23）。

预览台已知伪差异：嵌套弹层（记忆编辑器 / 新建、工作台、Diff、扫码）场景里 `shoot.mjs` 把截图
clip 到**第一个** `[role=dialog]`（外层管理中心壳），mobile 下 `mobile="fullscreen"` 的内层弹层
标题栏会落在 clip 之外（如 `manage-memory-editor--mobile-*`）。实际 DOM 里标题 / 关闭键都在，
**不是缺陷**；`shoot.mjs` 是共享设施，本轮不改。

### 2.3 跑过的验证

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck --workspace packages/web-react` | ✅ 绿（exit 0；注意 `browser-tests/**` 不在 tsconfig include 内，场景文件靠 esbuild 构建 + 运行期 0 失败兜底） |
| 代码风格 | `npx biome check packages/web-react/browser-tests/ui-preview/scenes-manage-audit.tsx` | ✅ 绿（既有 `scenes-manage.tsx` 本身不过 biome 格式检查——双引号 + 分号，与 biome.json 的 single/asNeeded 相反，本轮不动它） |
| 视觉基线 | `node browser-tests/ui-preview/shoot.mjs`（`OC_UI_SCENES=manage-`） | ✅ 132 张全部成功，0 渲染错误 0 页面异常 |
| 未定义 token 取证 | `rg "surface-subtle|body-sm|foreground" src/styles.css` | 三个类名在 `styles.css` 中零命中（`--color-*` 与 `--text-*` 都没有），只在 `MemoryPanel.tsx` 用到 |
| 文案取证 | 逐文件人工过（半角标点 / 开发者词汇 / 内部路径） | 见 M-07、M-12、M-22 |

**未跑**（`NOT RUN`）：

- `npm test`（全量 web-react 单测）—— 阶段 A 未改任何业务代码与既有测试，对本轮结论不增加
  信息；阶段 B 改代码时必跑。
- `npm run test:browser` —— 同上；本轮未触碰 Composer / 消息 / 工具卡 / 侧栏交互面。
- 真机 iOS Safari —— 本机网络受限；`mobile="fullscreen"` 弹层与 `.oc-center-dialog` 键盘契约
  只经 Chromium 移动模拟核过。
- 真实 OAuth 回跳（`/?connector_linked=` / `connector_error=`）—— 需要真后端，只做了代码审阅
  （`App.tsx:1764-1777` 有两条分支的 toast）。

---

## 3. 问题清单

严重度：**P1** 功能不可用/数据错误/阻断主流程；**P2** 明显体验缺陷/一致性破坏/移动端不可用；
**P3** 打磨项。文件路径省略 `packages/web-react/src/` 前缀。

| 编号 | 位置 | 现象 | 影响 | 严重度 |
|---|---|---|---|---|
| M-01 | `components/manage/CronPanel.tsx:224-231`、`:284-292`、`:654-680` | `cronBlocked`（作用域是未绑定看板的聊天项目）算出了一句「当前是未绑定的聊天项目，定时任务不能按该 facade 过滤。」，但**没有任何 JSX 渲染它**；effect 直接 `commitJobs([])` → `total === 0` → 走「还没有定时任务 / 创建第一个定时任务」空态 | 用户在作用域选择器里选一个「会话组」后，面板**宣称他没有任何定时任务**并邀请重新创建；同一份任务在切回「全部项目」后又都在。既是数据呈现错误，也会诱导重复建任务。见 `manage-cron-chatscope` | **P1** |
| M-02 | `components/manage/MemoryPanel.tsx:371`、`:415`、`:417`、`:423`、`:428`、`:435`、`:442`、`:447` | 用量分区用了 `text-body-sm` / `text-foreground` / `bg-surface-subtle` 三个**设计系统里不存在**的工具类（`styles.css` 无对应 `--text-*` / `--color-*`），Tailwind v4 不生成 CSS；另用 `text-lg` 任意档 | 标题 / 表头 / 行文字回落到继承字号，明显大于面板其余 13px 正文；四张统计卡没有底色只剩描边；语义色缺失时暗色主题靠继承勉强成立。见 `manage-memory-usage` | P2 |
| M-03 | `MemoryPanel.tsx:388-397`（用量）、`:178-215` + `:253-260`（项目记忆）、`components/manage/AgentProjectPreview.tsx:28-29` + `:63` | 三处读取失败都与空态**并排出现**：用量失败 = 红条 + 「还没有可统计的记忆操作」，且红条无重试；项目记忆失败只闪一条 toast，随后列表落成「还没有项目记忆」；上下文预览失败 toast 后落成「暂无注入槽」 | 核心记忆已经用 `failedCold` 把「报错 + 暂无」互斥掉了（`:701`），同一面板里另三段还在制造「记忆被清空了？」的误读；toast 消失后没有任何可见出口 | P2 |
| M-04 | `components/manage/IdentityManual.tsx:38-43`、`MemoryPanel.tsx:108` | 「本实例运行手册」是挂在记忆面板**首屏第一块**的附属能力；其注册信息读失败时渲染整宽 warning Alert「无法读取本实例手册的注册信息」+「重试手册入口」 | 一个多数用户从不使用的高级功能，一旦 `GET /api/agents` 失败 / 返回非 JSON（旧后端、网关抖动），就以告警形态占据记忆首屏；文案是仓库词汇。梦境报告同为附属能力，失败是静默降级（`:679`），两者标准不一 | P2 |
| M-05 | `components/manage/SkillEditor.tsx:617-625`、`:648-656`、`:808-816`；`components/ui/Input.tsx:26`（`disabled:opacity-50`） | 只读技能（市场安装 / 平台内置）的描述、正文与辅助文件全部用 `disabled` 的 Input / Textarea 呈现 | 正文以 50% 透明度显示（对比度约减半，不达 AA）；禁用控件不可聚焦、Chromium 里不可选中复制、触屏内不可滚动 —— 「只读但可阅读」变成了「基本读不了」。见 `manage-skill-workbench-readonly` | P2 |
| M-06 | `components/manage/ProjectSkillOverlay.tsx:55-61`、`:66-84`、`:86`、`:96-119`、`:124-126` | 工作项目作用域下的「项目专属技能」块：① 原生 `<input type=checkbox>`，文字是 `<span>` 不是 `<label>`（点文字不勾选、无可访问名、命中区 ~13px）；② 只显示裸 slug，状态靠 `· 覆盖 / · 已排除 / · 适用 …` 字符串拼接；③ 「保存」恒可点，无脏态；④ 常驻一条 info Alert 解释保存失败语义；⑤ 三个排除技能名硬编码；⑥ 非工作作用域时把一句灰字塞在 PanelHeader 与搜索框之间，形成两段互不相关的 hint | 这是技能 Tab 在工作项目下的第一屏内容，把搜索框与列表下推约 250px；勾选交互与全站 Switch/Chip 体系脱节；「覆盖」是实现词。见 `manage-skills-workscope`、`manage-skills` | P2 |
| M-07 | `AgentProjectPreview.tsx:49-63`、`components/manage/ProjectAssetsManagePanel.tsx:17-25`、`CronPanel.tsx:226`、`:1022-1026` | 用户可见文案里的开发者词汇：「只读 preview API。不可逐字重放。」「暂无注入槽」「instructions · 1240B」「上传、删除、固定/取消固定走既有 /api/project-assets。按 digest 去重」「绑定聊天 facade 后…」「不能按该 facade 过滤」「目标缺失或归档则失败并写审计，不会静默退到全局」「按来源会话当时归属解析」 | 这两块面板是对用户「智能体到底看到了我项目的什么」的唯一解释窗口，却在念代码注释；API 路径与字节数直接暴露。见 `manage-memory-workscope-appendix` | P2 |
| M-08 | `components/manage/SkillsPanel.tsx:317-383` | 技能行头部：来源图标 + 标题按钮 + 「自建」徽章 + 折叠箭头 + 编辑 IconButton + 删除 IconButton 全在一行，标题按钮 `flex-1` 但右侧四个元素 `shrink-0` | 390px 下标题只剩约 110px：「OpenClaude / v5（Auror…」两行即截断，slug 反而完整可读 —— 主标识不可读。见 `manage-skills-mobile` | P2 |
| M-09 | `components/settings/ConnectorsTab.tsx:1055-1143`（RuntimePluginCard）、`:1939-2023`（ProviderCard） | 卡头 `flex items-start` 里右侧动作簇 `shrink-0 flex-wrap justify-end`，最多三个按钮（更新 / 授权 / 卸载）不让位 | 390px 下微博卡的描述与能力说明被压成每行 6 个字的窄柱，高度翻三倍；「更新」按钮压在徽章上。见 `manage-connectors-mobile`。**文件归 settings** | P2 |
| M-10 | `components/manage/SkillOptPanel.tsx:887-897` | 「放弃本次训练与全部草稿」：`discardSkillTrainRun` 的失败被 `.catch(() => {})` 吞掉，随后无条件清本地 run 并 toast「已放弃本次训练草稿」 | 服务端 run 仍在 → 下次打开工作台被 `pickResumableTrainRun` 找回，弹「发现一个未处理的训练草稿」；用户看到自己刚放弃的东西又回来了 | P3 |
| M-11 | `MemoryPanel.tsx:292-316` | 项目记忆「早前留下的待确认条目」的采纳 / 忽略按钮没有 loading / disabled | 慢网下可连点重复 POST；成功也无 toast，只靠列表刷新 | P3 |
| M-12 | `SkillEditor.tsx:531-536`、`:617`、`:645`；`SkillOptPanel.tsx:149-157`、`:171-178`、`:288-297`、`:620`、`:638`、`:1315`、`:1345`；`SkillsPanel.tsx:457`；`components/manage/LibraryPanel.tsx:111`、`:114`、`:283`；`ConnectorsTab.tsx:456`、`:526`、`:548`、`:582`、`:641` | 技能 / 文献 / 插件三块大量半角标点混在中文里：`技能工作台:name`、`描述(触发的唯一依据:做什么 + 何时用)`、`正文(v3.2.0;保存后旧版自动入历史)`、`预计消耗:` `,折算约` `(实际扣费以账单为准)`、`仅显示前 20 行,共 N 行`、`删除文献「…」?`、`(无标题文档)`、`解绑「…」?`；而记忆 / 定时两块全是全角 | 同一个弹层里两套标点；shell 审计 S-13 已把半角逗号列为全站文案问题，这里是密度最高的一片 | P3 |
| M-13 | `SkillsPanel.tsx:107`、`SkillEditor.tsx:531`、`components/manage/skillDisplay.ts` | 列表把描述首行当标题、slug 当 caption（`skillDisplayTitle`），但删除确认「删除技能「v5-commercial-deploy」?」和工作台标题「技能工作台:v5-commercial-deploy」都用裸 slug | 同一个技能在三处叫三个名字；确认框里用户要靠 slug 反推自己在删哪个 | P3 |
| M-14 | `SkillsPanel.tsx:399-411` | 「适用：」智能体芯片（`AgentScopeSummary`）与标签 Badge 同形状同尺寸排在同一行，只靠颜色区分；`+N` 用 `title` 承载剩余标签 | 「全能助手 · 部署 · 运维 · v5 · +1」读起来像五个标签；触屏 / 键盘看不到 `+1` 的内容 | P3 |
| M-15 | `CronPanel.tsx:172-196`、`:506-512` | 已翻译的排程只在 `Tooltip` 里露原始 cron，且宿主是 `cursor-default` 的不可聚焦 `<span>`；下次执行的绝对时间只在 `title` 里 | 触屏与键盘用户拿不到原始表达式和精确时间；`title` 在读屏上也基本不读 | P3 |
| M-16 | `CronPanel.tsx:920-927`、`:517-528` | ① 「某时一次」的 `datetime-local` 没有 `min`，选了过去时间才在预览行报「该时间已过去」；② `heartbeat: true` 的任务（线上健康探针一类）在行上没有任何标识，与普通任务一样 | ① 多一步回退；② 用户分不清哪条是心跳探针、哪条会真正推消息 | P3 |
| M-17 | `LibraryPanel.tsx:135-140`、`:278-307`；`lib/research/cite.ts`（仅被 `components/chat/researchEvidence.tsx:215` 使用） | ① 文献行不可点开：看不到片段、入库来源，只能删；② 搜索只匹配标题，`title: null` 的文档搜不到；③ 「引用导出」（`cite.ts` 的 GB/T 7714 / APA / BibTeX）只挂在对话里的证据卡上，文献库本身没有导出入口，而 `ResearchLibraryDoc` 只有 docId/title/lang/spanCount，缺作者 / 年份 | 文献库是「证据可回查」的入口，却只有增删；任务书点名的「引用导出」在这里不存在 | P3（导出部分需后端配合，见 §5） |
| M-18 | `ConnectorsTab.tsx:2131-2133`、`:2162-2164` | 连接行标题取 `displayName \|\| accountHint`，元信息行又无条件渲染 `accountHint` | `displayName` 为空时同一串 `momo.muying@163.com · imap.163.com` 上下各出一遍。见 `manage-connectors--desktop--dark` | P3 |
| M-19 | `lib/connectors.ts:457-460`、`:491` | `UPSTREAM_FAILED` / `CONNECTION_ERROR` / `EXECUTION_FAILED` 是通用错误码（`ConnectorsTab.tsx:115-122` 对知乎也用 `UPSTREAM_FAILED`），文案却写死「微博触发了验证码或风控」「若微博已授权仍反复失败」「微博动作执行失败」 | 知乎 / 知识星球账号出这些码时，用户看到的是微博 | P3 |
| M-20 | `ConnectorsTab.tsx:281-290`、`:354` | ① 声明式目录与运行时 Plugin 目录读失败各自 `console.warn` 后降级为空，UI 零提示；② 市场回跳的自动授权分支把「Plugin 尚未安装到当前版本」写进为「整表读不到」保留的顶层 `err` 通道 | ① 用户看到卡片少了一半却不知道是没装还是没读到；② 违反该组件自己「反馈渲染在发起它的容器里」的规则 | P3 |
| M-21 | `ConnectorsTab.tsx:2088-2092`、`:495-505` | 备注名行内编辑只认 Enter / Esc / 两个图标，失焦不提交也不取消；改名成功无任何反馈（只 reload） | 点到别处编辑框还挂着；改完像没改 | P3 |
| M-22 | `components/manage/OptimizationPanel.tsx:705`、`:352`、`:325-334` + `:482-491` | ① Diff 弹层 description 直接拼 `targetId`（`memory/xhs-muying-account.md`、`settings/effort`、`user.md`）；② hero 元信息「42 个审计分片」；③ 待确认为空时 hero 里的「立即审计」与空态里的「立即审计」两个 primary 同屏 | 内部存储路径与实现词汇进用户界面；两个同名主按钮 | P3 |
| M-23 | `ManageCenter.tsx:107-121`、`lib/manageTabs.ts:23-27` | 移动端六个 Tab 单行横滚 + 选中项自动居中；第 6 个「优化」是**唯一带待办徽标**的分区 | 390px 下「优化」及其徽标整个在视口外（`manage-memory--mobile`），选中「技能」时第一个「记忆」也滚出去；代码注释里「3×2 宫格弃用」的决定与徽标信号互相打架 | P3 |
| M-24 | `MemoryPanel.tsx:108`、`ManageCenter.tsx:152-161` | ① 「本实例运行手册」折叠区挂在记忆二级页签**之上**；② 工作项目作用域下「项目资产」「Agent 项目上下文预览」两块追加在 `MemoryPanel` 之后，不随二级页签切换，定高壳内要滚过整张核心记忆列表才看得到 | 高级功能占了主内容之前的位置；两块与「项目」相关的面板却不在「项目记忆」页签里，且不可发现 | P3 |
| M-25 | `MemoryPanel.tsx:1684-1685`、`:1807-1809` | 用户画像字数：正常态显示 `trim()` 后长度，超限态切换成未 trim 的 `text.length` | 超限瞬间数字会跳一下，与限额比较的口径也变了 | P3 |
| M-26 | `SkillEditor.tsx:513-519`、`:645` | ① 「历史（N）」的 N 只在访问过历史页签后才出现（懒加载），页签标签中途变化；② 正文 Field label 在加载期显示 `正文(v?;…)` | 标签抖动；`v?` 是占位符泄漏 | P3 |
| M-27 | `SkillOptPanel.tsx:706`、`:1333-1343` | ① 评测结果里出错的 arm 显示「✗错」；② 多份草稿的切换 Tabs 用 `layout="grid"` 且标签形如「✓ name · 更新」 | 「✗错」不成词；grid 在窄屏三列宫格里长 slug 会被截到只剩 ✓ | P3 |

---

## 4. 修复计划

### M-01 cronBlocked 分支渲染成空态（P1，必修）

- **改**：`components/manage/CronPanel.tsx`。
- **怎么改**：把 `cronBlocked` 从「算了不用」变成第一优先的渲染分支：`jobs === null && cronBlocked`
  时不进 `listCron`，主体区渲染 `EmptyState`（icon `Clock`，标题「这个会话组没有绑定工作项目」，
  hint「定时任务按工作项目归属；切到『全部项目』或某个工作项目即可查看和创建。」，action =
  切换作用域的按钮，调 `useProjectScope().setToken("all")`）；PanelHeader 的「新建」在该分支下隐藏。
  文案不再出现 facade。
- **补测试**：`CronPanel.test.tsx` 加一例：用 `ProjectScopeProvider` 包裹并给一个
  `boardProjectId: null` 的聊天项目 token，断言 `listCron` 未被调用、出现「没有绑定工作项目」、
  不出现「创建第一个定时任务」。`scenes-manage-audit.tsx` 的 `manage-cron-chatscope` 出 after 图。
- **风险**：低。只影响 `scope.kind === "chat" && !workProject` 这条分支，其余作用域零变化。

### M-02 用量分区的未定义工具类（P2，必修）

- **改**：`MemoryPanel.tsx` 用量分区 8 处类名。
- **怎么改**：`text-body-sm` → `text-body`，`text-foreground` → `text-fg`，`bg-surface-subtle` →
  `bg-hover`（与面板内其它「下沉」卡一致，见 `SkillEditor` 的 `Card tone="sunken"`），
  统计数字 `text-lg` → `text-title font-semibold`（15px 语义档；若视觉上需要更大，走
  `StatCard` 原语——它就是为这种四联统计卡存在的）。
- **补测试**：`MemoryPanel.test.tsx` 加一例渲染用量页签，断言 DOM 里不含
  `text-body-sm|text-foreground|surface-subtle`（防回归）；`manage-memory-usage` 出 after 图。
- **风险**：无。纯类名替换，行为不变。

### M-03 错误态与空态并排（P2，必修）

- **改**：`MemoryPanel.tsx`（`MemoryUsageSection`、`ProjectMemorySection`）、
  `AgentProjectPreview.tsx`。
- **怎么改**：三处统一到核心记忆已有的 `failedCold` 模式：加 `err` state，读失败时渲染带
  「重试」的 `Alert tone="danger"`，**不再**渲染 EmptyState；项目记忆与上下文预览不再用 toast
  报读失败（toast 留给写操作）。用量分区的现有红条补 `action` 重试按钮。
- **补测试**：`MemoryPanel.test.tsx` 三例：分别让 `getMemoryUsage` / `listProjectMemories` /
  `previewProjectContext` reject，断言出现「重试」且不出现「还没有 / 暂无」文案。
- **风险**：低。

### M-04 本实例手册读失败过于响亮（P2，必修）

- **改**：`IdentityManual.tsx`、`MemoryPanel.tsx:108`。
- **怎么改**：`useIdentityManualAuthority` 失败时 `IdentityManual` 不再渲染 warning Alert，改为
  在「本实例运行手册」这一行（折叠头）旁给一枚 `Badge tone="warning"`「暂时读不到」+ 行内
  `Button variant="link"`「重试」；整块随 M-24 一起下移到二级页签之后。文案去掉「注册信息 /
  手册入口」。
- **补测试**：`IdentityManual.test.tsx` 改现有失败用例断言：无 `role="alert"`，有「重试」链接。
- **风险**：低。该组件本轮有 9.5KB 测试覆盖，改动面小。

### M-05 只读技能用 disabled 控件呈现（P2，必修）

- **改**：`SkillEditor.tsx` 正文 / 描述 / 文件三处。
- **怎么改**：`writable === false` 时不渲染 Input / Textarea，改渲染只读块：描述用
  `<p className="text-body text-fg">`，正文与文件内容用 `<pre tabIndex={0} aria-label=…>` +
  `bg-code font-mono whitespace-pre-wrap`（与 `SkillsPanel` 行内预览同款，可选中、可滚动、
  可聚焦）。不动 `ui/Textarea`（shell 归属）；若后续需要 `readOnly` 视觉态再向 shell 提需求。
- **补测试**：`SkillEditor.test.tsx` 加一例：只读技能下 `queryByRole("textbox")` 为 null、
  正文以 `<pre>` 呈现；`manage-skill-workbench-readonly` 出 after 图。
- **风险**：低。只读路径本来就没有写逻辑。

### M-06 项目专属技能块（P2，必修）

- **改**：`ProjectSkillOverlay.tsx`；`SkillsPanel.tsx:170`。
- **怎么改**：
  1. 勾选控件换 `Switch`（`ui`）+ `<label htmlFor>`，每行显示 `skillDisplayTitle(skill).title`，
     slug 降为 caption；「覆盖」→ 「已启用」，「已排除」→ 「不可用于项目（密钥类）」并用
     `Badge tone="neutral"`；适用智能体沿用 `AgentScopeSummary`。
  2. 引入脏态：`selected` 与服务端 `overlay` 快照比对，无变化时「保存」禁用；保存成功 toast
     已有，失败留在块内 `Alert`（替代那条常驻说明）。
  3. 排除清单不再硬编码 slug：按 `tags` 含「密钥」或名称匹配 `key|secret|token|account-pool`
     判定，并把判定抽成纯函数 `isSecretSkill(skill)` 放 `lib/`（可单测）。
  4. 非工作作用域时整块不渲染（去掉那句孤零零的灰字，作用域提示已在壳的 `ProjectScopeSelect`）。
  5. 整块改为默认折叠的 `Disclosure`（复用 `MemoryPanel` 的写法）或移到列表末尾，首屏还给搜索
     与技能列表。
- **补测试**：`ProjectSkillOverlay.test.tsx`（现有 704B 壳）补：label 点击可切换、无变化保存
  禁用、`isSecretSkill` 三例；`manage-skills-workscope` 出 after 图。
- **风险**：中。`ProjectSkillOverlay.test.tsx` 与 `SkillsPanel.test.tsx` 里依赖
  `data-testid="project-skill-*"` 的断言要同步。

### M-07 开发者词汇进用户文案（P2，必修）

- **改**：`AgentProjectPreview.tsx`、`ProjectAssetsManagePanel.tsx`、`CronPanel.tsx:226`、
  `:1022-1026`。
- **怎么改**（对照替换，其余不动）：
  - 「该 Agent 将看到的项目上下文 / 只读 preview API。不可逐字重放。」→ 「智能体会带着这些
    项目信息开始对话 / 只展示注入了哪些内容和大小，不展示原文。」
  - `{name} · {bytes}B` → 名称映射（instructions→项目说明、memories→项目记忆、skills→项目技能，
    未知原样）+ `formatBytes()`（`lib/utils` 若无则新增）；「已脱敏」保留；「暂无注入槽」→
    「这个项目还没有会注入的内容」；「项目上下文未启用。」→ 「该项目关闭了上下文注入。」
  - 「上传、删除、固定/取消固定走既有 /api/project-assets。按 digest 去重；…」→ 「上传给这个
    项目的参考文件；重复文件只保留一份，含密钥或二维码的文件会标记为敏感。」
  - 「绑定聊天 facade 后…」→ 「把一个会话组绑定到这个工作项目后，就能在这里管理它的文件。」
  - CronForm 项目 hint：「固定到当前工作项目；项目被归档或删除后任务会失败并记录原因。」
    「随会话移动：由触发它的会话所属项目决定。」
- **补测试**：三个组件各加一例断言不含 `/api/`、`facade`、`API`、`B$` 字样。
- **风险**：无。

### M-08 技能行头部在窄屏挤掉标题（P2，必修）

- **改**：`SkillsPanel.tsx:317-383`。
- **怎么改**：头部改两行布局：第一行 图标 + 标题按钮（`flex-1`）+ 折叠箭头；来源徽章、只读锁
  移到标题按钮内部的第二行（与 caption 同行，`flex-wrap`）；编辑 / 删除两个 IconButton 在
  `max-sm` 下移到底部「适用 / 标签」那一行的右侧（`max-sm:ml-auto`），桌面保持现状。
- **补测试**：`SkillsPanel.test.tsx` 现有用例只查按钮可访问名，布局改动不破坏；
  `manage-skills-mobile` 出 after 图对比标题可读行数。
- **风险**：低。

### M-09 插件卡动作簇在窄屏不让位（P2，必修，**跨模块**）

- **改**：`components/settings/ConnectorsTab.tsx` 两处卡头（settings 归属）。
- **怎么改**：动作簇加 `max-sm:basis-full max-sm:justify-start max-sm:pt-1`（窄屏整行换到卡头
  下方），外层 `flex-wrap`；桌面不变。
- **补测试**：`manage-connectors-mobile` after 图。
- **风险**：低；**需先 `send_to` fable-5-1-21（settings）**：由其在 settings-B 顺手改，或授权我在
  manage-B 改这两处并拿锁。

### M-10 放弃训练草稿吞错（P3）

- **改**：`SkillOptPanel.tsx:887-897`。
- **怎么改**：`discardSkillTrainRun` 失败 → `setErr(apiErrorMessage(e, "放弃失败"))`，不清本地
  run；成功才清并 toast。
- **补测试**：`SkillOptPanel.test.tsx` 加一例 reject 路径断言 run 仍在、出现「放弃失败」。
- **风险**：无。

### M-11 采纳 / 忽略无忙态（P3）

- **改**：`MemoryPanel.tsx:292-316`。
- **怎么改**：加 `busyId` state，两按钮 `loading={busyId === c.id}`、`disabled={!!busyId}`；
  成功 toast「已采纳 / 已忽略」。
- **补测试**：`MemoryPanel.test.tsx` 加一例 pending Promise 下按钮 disabled。
- **风险**：无。

### M-12 半角标点（P3）

- **改**：清单里列出的 20 处字符串。
- **怎么改**：`:` → `：`，`,` → `，`，`;` → `；`，`(…)` → `（…）`，`?` → `？`；
  `技能工作台:name` → `技能工作台 · name`。数字 / 代码片段（`v3.2.0`、cron）不动。
- **补测试**：无需新增；现有测试若用 `getByText` 精确匹配会跟着改。
- **风险**：无。

### M-13 技能三处三个名字（P3）

- **改**：`SkillsPanel.tsx:107`、`SkillEditor.tsx:531`。
- **怎么改**：删除确认与工作台标题都用 `skillDisplayTitle(skill).title`，slug 放 description
  / 确认框正文；`SkillEditor` 需要拿到 `description`（列表已有，透传 `displayTitle` prop，
  未传时回退 slug）。
- **补测试**：`SkillsPanel.test.tsx` 断言确认框标题含描述首行。
- **风险**：低。

### M-14 智能体芯片与标签同形（P3）

- **改**：`SkillsPanel.tsx:399-411`。
- **怎么改**：标签用 `Chip`（`ui`）而非 `Badge`，或在标签前加 `Tag` 图标 + `text-faint`；
  `+N` 改为可展开（点击把剩余标签全部展开），去掉 `title`。
- **风险**：低。

### M-15 排程原文 / 精确时间只在 Tooltip · title（P3）

- **改**：`CronPanel.tsx:172-196`、`:506-512`。
- **怎么改**：`NextRunMeta` 直接渲染 `title` 里的绝对时间（`下次 3 小时后 · 09-16 08:00`），
  去掉 `title`；原始 cron 在行的第三级元信息里以 `<code>` 常驻显示（`text-caption text-faint`），
  Tooltip 删除。
- **风险**：低；行高多约 0 ~ 1 行。

### M-16 datetime-local 无 min / 心跳无标识（P3）

- **改**：`CronPanel.tsx:920-927`、`:517-528`。
- **怎么改**：`min` 取当前本地时间的 `YYYY-MM-DDTHH:mm`；`heartbeat` 加 `Badge size="sm"`
  「心跳探针」。
- **风险**：无。

### M-17 文献库只有增删（P3，部分需后端配合）

- **改**：`LibraryPanel.tsx`。
- **怎么改**（前端可做的）：搜索同时匹配 `docId` 前 8 位与语言标签；`(无标题文档)` → 全角并附
  docId 前 8 位作副标题；行尾加「复制文档 ID」`CopyChip`。**导出与详情**需后端提供
  `GET /api/me/research/library/:docId`（片段 / 元数据）与文献元数据（作者 / 年份 / 来源），
  记入 §5 需后端配合。
- **风险**：低。

### M-18 accountHint 重复（P3，跨模块）

- **改**：`ConnectorsTab.tsx:2162`：`conn.displayName && conn.accountHint && …` 才渲染元信息里的
  accountHint。归 settings，随 M-09 一并 `send_to`。

### M-19 通用错误码写死「微博」（P3）

- **改**：`lib/connectors.ts:457-460`、`:491`。
- **怎么改**：`UPSTREAM_FAILED` → 「平台触发了验证码或风控，请本人完成验证后再试」；
  `CONNECTION_ERROR` → 「插件运行失败。若账号已授权仍反复失败，请重新扫码绑定」；
  `EXECUTION_FAILED` → 「插件动作执行失败」。微博专属措辞保留在 `WEIBO_*` 码上。
- **补测试**：新建 `lib/connectors.test.ts`（该文件目前没有单测）覆盖 `connectorErrorText`
  三例 + 未知码回退。
- **风险**：无。

### M-20 / M-21 连接器降级零提示 · 备注名编辑（P3，跨模块）

- **改**：`ConnectorsTab.tsx:281-290`、`:354`、`:2088-2092`。
- **怎么改**：目录降级时在列表顶部给 `Alert tone="info" density="compact"`「部分插件目录暂时
  读不到，已显示可用部分」+ 重试；自动授权分支改用 `setCardNotice`；备注名 Input `onBlur` 提交、
  成功 toast「已改名」。归 settings。

### M-22 优化面板文案与双主按钮（P3）

- **改**：`OptimizationPanel.tsx:705`、`:352`、`:482-491`。
- **怎么改**：description 只显示分类中文名，`targetId` 收进弹层正文一行 `text-caption text-faint`
  「作用对象：…」；「审计分片」→ 「批次」；空态里的按钮改 `variant="secondary"`。
- **风险**：无。

### M-23 移动端「优化」Tab 在视口外（P3）

- **改**：`ManageCenter.tsx:73-90`。
- **怎么改**：`optimizerPendingCount > 0` 时，窄屏在 Tab 条右缘渐隐区外叠一枚固定的
  `Badge tone="accent"` 小圆点（`md:hidden`），点击滚到并选中「优化」；或把待办数并进
  PanelHeader 一行「有 N 项优化建议待确认 →」。**是否改回 3×2 宫格属产品决定**，见附录。
- **风险**：中（涉及 Tabs 原语的横滚容器，需与 shell 确认不动 `ui/Tabs`）。

### M-24 记忆面板信息架构（P3）

- **改**：`MemoryPanel.tsx:108`、`ManageCenter.tsx:152-161`。
- **怎么改**：`IdentityManual` 移到核心记忆分区末尾（索引 Disclosure 之后）；「项目资产」
  「Agent 项目上下文预览」两块移入「项目记忆」页签（`ProjectMemorySection` 之后渲染），
  `ManageCenter` 不再在 `MemoryPanel` 外追加。
- **补测试**：`MemoryPanel.test.tsx` 加一例工作作用域下项目页签含「项目资产」。
- **风险**：低；`ManageCenter.test.tsx` 若断言追加块存在需同步。

### M-25 / M-26 / M-27（P3，顺手项）

- `MemoryPanel.tsx:1684-1685`：`overLimit` 与显示都用 `norm(text).length`（不 trim，与后端
  limit 口径一致）。
- `SkillEditor.tsx:513-519`：工作台打开时并行请求一次 `getSkillHistory`（已在 `load` 里拿
  `detail`，多一个请求可接受），标签首屏就带 N；`:645` 加载期显示「正文」不带版本。
- `SkillOptPanel.tsx:706`：「✗错」→ 「出错」；`:1333` 草稿 Tabs 用 `layout="scroll"`。

---

## 5. 建议不修 / 暂缓项

| 项 | 理由 |
|---|---|
| **文献库的引用导出 / 文档详情** | `ResearchLibraryDoc` 只有 docId / title / lang / spanCount / createdAt，`cite.ts` 需要作者 / 年份 / venue / DOI；后端 `/api/me/research/library*` 也没有单文档读接口。**需后端配合**，本轮只做前端可做的搜索 / 标识增强（M-17）。 |
| **`ProjectAssetsPanel` 空态与上传区** | 组件归 sidebar，本轮只在工作作用域截到它的空态，未发现 manage 侧可改的问题。 |
| **`scenes-manage.tsx` 的 biome 格式不合规** | 既有文件双引号 + 分号与 biome.json 相反，但它不在任何门禁里；格式化会产生一次 1300 行的纯格式 diff，混进审计分支会淹没真实改动。建议由指挥官安排单独一条格式化提交。 |
| **`browser-tests/**` 不在 typecheck 范围** | shell 审计 S-19 已立项（独立 tsconfig），本轮场景文件靠 esbuild + 0 运行失败兜底，不重复立项。 |
| **`shoot.mjs` 嵌套弹层截图 clip 到外层** | 共享设施；改成「clip 到最后一个 `[role=dialog]`」会改变所有既有基线的取景，需指挥官定夺后由 shell 或基建持有人改。 |
| **知识星球自动回复面板（`KnowledgePlanetAutomationPanel.tsx`，847 行）** | 已被外提进 Sheet，本轮通读未发现阻断项；规则表单 / 运行记录的细节属 settings 归属，交 settings-A 覆盖。 |
| **`OptimizationPanel` hero 图标 `bg-accent text-white`** | 与 shell S-03 同类（填充 + 白字），但 accent 的明暗两档实测都能过 4.5:1，不占预算；shell 的 `--*-fg` 方案落地后顺手改 `text-accent-fg`。 |
| **`MemoryPanel` / `SkillOptPanel` 的体量（1819 / 1403 行）** | 拆文件属重构，不影响用户可感知结果；阶段 B 改动集中在少数分区，不借机拆分。 |

---

## 6. 跨模块发现（不在本模块归属，已 / 待通报）

| 编号 | 位置 | 现象 | 归属 / 处置 |
|---|---|---|---|
| X-01 | `hooks/useProjectScope.tsx:153-163` | 挂载时先从 URL / localStorage 读到作用域 token，再异步拉工作项目列表；列表未到时**工作项目 id 解析为 `invalid`**，effect 立刻 `setToken("all")` 并**写回 localStorage、抹掉 URL 参数**。结果：持久化的工作项目作用域与 `?project=<workId>` 深链在每次刷新后都回到「全部项目」（只有聊天项目 id 能活下来，因为它在 `chatProjects` 里同步可解析）。本轮预览场景就是被这条竞态打回「全部项目」后才改用「已绑定的聊天项目 id」绕过的（见 `scenes-manage-audit.tsx` `CHAT_BOUND` 注释）。 | **sidebar（fable-5-1-19）**。`send_to` 回 `wrong_group`（不在本协同组），**待指挥官转达**；建议 `loading` 期间不执行重置。P2。 |
| X-02 | `components/settings/ConnectorsTab.tsx` | 管理中心「插件」Tab 的整个渲染层在 settings 目录；本轮 M-09 / M-18 / M-20 / M-21 四条落在该文件。 | **settings（fable-5-1-21）**：manage-B 开工前 `send_to` 商定由谁改；本文档的修复方案可直接复用。 |
| X-03 | `components/ui/Textarea.tsx` | 没有 `readOnly` 视觉态（只有 `disabled:opacity-50`）。M-05 在本模块内用 `<pre>` 绕开，不向 shell 提需求；若其它模块也需要「只读但可读」的多行文本，可由 shell 统一加变体。 | shell，仅备注。 |

---

## 附：阶段 B 开工前需要拍板的事

1. **M-01 严重度**：按 PLAYBOOK「数据错误」判 P1；若指挥官认为「会话组」作用域进管理中心是边缘
   路径，可降 P2，修法不变。
2. **M-09 / M-18 / M-20 / M-21**：`ConnectorsTab.tsx` 归 settings，由 settings-B 修还是授权
   manage-B 拿锁修？
3. **M-23**：移动端 Tab 条是补一枚「有待办」指示，还是恢复 3×2 宫格（代码注释记录了弃用理由：
   压掉两行首屏高度）？
4. **M-06 ③**：排除「密钥类技能」改为按标签 / 名称规则判定，规则口径（`key|secret|token|
   account-pool`）需产品确认，或改由后端在 `SkillSummary` 上下发 `sensitive: true`。
5. **X-01**：是否本轮由 sidebar-B 修（影响所有带作用域的面板，manage 三个 Tab 都受益）。

---

## 7. 修复记录（阶段 B）

- 分支：`feat/v5-selfhost-audit-manage`（阶段 A 基线 `43a6d52f`）
- 执行：fable-5-1-20 完成 M-01/02/04/05/06/08/11/13/14/15/16/25/26 及 M-03/07/12/24 的一部分后掉线；
  fable-5-1-22 接手补齐其余项、修通测试、出 after 截图、归档。
- 统计：发现 27 / 修复 22（含 2 条部分修复）/ 遗留 5（4 条落在 settings 归属文件，1 条需后端）。
- 附录 5 件拍板事项的落地口径：① M-01 维持 P1，修法同计划；② ConnectorsTab 四处**未动**（见 §9）；
  ③ M-23 取「窄屏补待办提示行」方案，**不**恢复 3×2 宫格；④ M-06 ③ 密钥类判定按规则
  `isSecretSkill`（名称分段 key/secret/token/credential/password/account-pool 或标签 密钥/凭据/secret/credential），
  后端 `sensitive:true` 记为需后端配合；⑤ X-01 未在本模块动，测试里用聊天项目 token 绕开。

| 编号 | 状态 | 改动（`packages/web-react/src/` 下） | 用例 |
|---|---|---|---|
| M-01 | ✅ | `manage/CronPanel.tsx`：`cronBlocked` 成为首选渲染分支 —— `EmptyState`「这个会话组没有绑定工作项目」+「查看全部项目的定时任务」（`setToken("all")`）；该分支下不发 `listCron`、`commitJobs(null)`、隐藏「新建」。 | `CronPanel.test` 「未绑定聊天项目作用域」（断言不调 `listCron`、无「创建第一个」、出口可切回） |
| M-02 | ✅ | `manage/MemoryPanel.tsx` 用量分区 8 处：`text-body-sm→text-body`、`text-foreground→text-fg`、`bg-surface-subtle→bg-hover`、`text-lg→text-title tabular-nums`。 | `MemoryPanel.test` 「统计卡与表头走设计系统档位」（`innerHTML` 不含三个类名） |
| M-03 | ✅ | `MemoryUsageSection`（`err` 时只渲染带「重试」的 Alert，不渲染空态）、`ProjectMemorySection`（`loadErr` 取代 toast，Alert + 重试）、`manage/AgentProjectPreview.tsx`（同款 `err` + 重试，不再 toast）。 | `MemoryPanel.test` ×2（用量 / 项目记忆）、`AgentProjectPreview.test` 「读失败渲染带重试的错误条」 |
| M-04 | ✅ | `manage/IdentityManual.tsx`：读失败改为一行 `Badge`「本实例运行手册」+ 原因 + 行内「重试」（可访问名「重试读取本实例运行手册」，与核心记忆的「重试」分得开）；整块移到核心记忆分区之后（随 M-24）。 | `IdentityManual.test` 「registration read failure degrades to a one-line notice…」（无 `role=alert`、DOM 顺序在页签之后、重试再发一次 `/api/agents`） |
| M-05 | ✅ | `manage/SkillEditor.tsx`：`writable=false` 时描述用 `<p>`，正文 / 辅助文件用 `ReadOnlyText`（`<section tabIndex=0 aria-label>` + `<pre>`，`bg-code`，可聚焦 / 可选中 / 可滚）。 | `SkillEditor.test` 「只读技能的正文 / 辅助文件以可聚焦的只读文本呈现」 |
| M-06 | ✅ | `manage/ProjectSkillOverlay.tsx` 重写：非工作作用域不渲染；默认折叠为一行摘要（名称 + 「已启用 N」）；`Switch` + `<label htmlFor>`；每行展示名 + slug caption + 适用；密钥类 `Badge`「密钥类，不可用于项目」并禁用；脏态（与服务端快照比对）无差异时保存禁用；保存失败留在块内 Alert + 「重新读取」；`manage/skillDisplay.ts` 新增 `isSecretSkill`。 | `ProjectSkillOverlay.test` ×6、`skillDisplay.test` `isSecretSkill` ×2 |
| M-07 | ✅ | `manage/AgentProjectPreview.tsx`（标题「智能体会带着这些项目信息开始对话」、hint、槽名映射 `slotLabel`、`formatBytes`、「这个项目还没有会注入的内容」「该项目关闭了上下文注入」）、`manage/ProjectAssetsManagePanel.tsx`（hint、未绑定空态）、`CronPanel.tsx` 项目 hint 两句。 | `AgentProjectPreview.test` 「不含 API 路径 / 槽名 / 裸字节数」、`ProjectAssetsManagePanel.test` ×2 |
| M-08 | ✅ | `manage/SkillsPanel.tsx` 行头：容器 `flex-wrap`；标题按钮 `flex-1 basis-48` 独占主宽度；来源徽章 / 只读锁 / slug 降到标题下第二行；编辑 / 删除簇 `max-sm:basis-full max-sm:justify-end`。 | `SkillsPanel.test` 「编辑 / 删除动作簇在窄屏整行换到行头下方」 |
| M-09 | ⏸ | **遗留**：`components/settings/ConnectorsTab.tsx` 归 settings（settings-B 待领、无 owner），按 PLAYBOOK §8 不越界；修法见 §4，已 `send_to` 指挥官。 | — |
| M-10 | ✅ | `manage/SkillOptPanel.tsx` `discard`：`discardSkillTrainRun` 失败 → `setErr(放弃失败)` 且**不清**本地 run；成功才清并 toast。 | `SkillOptPanel.test` 「放弃训练草稿:服务端失败时 run 原样留着并报错」 |
| M-11 | ✅ | `ProjectMemorySection`：`busyId` → 采纳 `loading` / 两键 `disabled`，成功 toast「已采纳 / 已忽略」。 | `MemoryPanel.test` 「采纳 / 忽略在请求在途时进忙态」 |
| M-12 | ◐ | 全角化：`SkillEditor.tsx` 全部、`SkillsPanel.tsx` 全部、`LibraryPanel.tsx` 3 处、`SkillOptPanel.tsx` 清单所列 7 处 + 放弃确认标题。**遗留**：`SkillOptPanel.tsx` 其余成本确认 / 提示文案约 40 处（该文件既有风格，宜单独一条 `style(v5)` 提交）；`ConnectorsTab.tsx`（settings）。 | 既有 `getByText` 精确匹配用例同步（`SkillEditor.test` / `SkillsPanel.test` / `SkillOptPanel.test`） |
| M-13 | ✅ | `SkillsPanel.remove(sk)` 确认框标题用展示名、正文「技能标识 slug」；`SkillEditor` 新增 `displayTitle` prop → 标题「技能工作台 · 展示名」。 | `SkillsPanel.test` 「删除确认与工作台标题都用列表同款展示名」、`SkillEditor.test` 「标题用列表同款展示名」 |
| M-14 | ✅ | 标签改 `#tag` 弱化文字（与「适用」芯片不同形）；`+N` 变按钮可展开 / 收起，去掉 `title`。 | `SkillsPanel.test` 「标签以 # 弱化文字呈现」 |
| M-15 | ✅ | `NextRunMeta` 精确时刻直接可见（`（MM-DD HH:mm）`），去 `title`；已翻译排程的 Tooltip 触发器 `tabIndex=0` + `aria-label` 含 cron 原串。 | `CronPanel.test` 「已翻译排程的触发器可聚焦且可访问名含 cron 原串」 |
| M-16 | ✅ | `datetime-local` 加 `min`（`localDateTimeMin()`）；`heartbeat` 行加 `Badge`「心跳探针」。 | `CronPanel.test` 同上 + 「日期时间控件带 min」 |
| M-17 | ◐ | `manage/LibraryPanel.tsx`：`matchesLibraryQuery`（标题 / 文档 ID 前缀 / 语言标签或代码）；无标题显示「（无标题文档）」；每行「文档 ID」`CopyChip`（8 位前缀，复制完整值）；搜索占位更新。**导出 / 详情**仍需后端（§5）。 | `LibraryPanel.test` ×3 |
| M-18 / M-20 / M-21 | ⏸ | **遗留**：同 M-09，`ConnectorsTab.tsx` 归 settings。 | — |
| M-19 | ✅ | `lib/connectors.ts`：`UPSTREAM_FAILED` / `CONNECTION_ERROR` / `EXECUTION_FAILED` / `LOGIN_EXPIRED_ACCOUNT` 四个通用码去掉「微博」，微博措辞只留 `WEIBO_*`。 | 新建 `lib/connectors.test.ts` ×3 |
| M-22 | ✅ | `manage/OptimizationPanel.tsx`：弹层 `description` 只放分类中文名，`targetId` 收进正文「作用对象：」caption；「审计分片」→「批次」；空态「立即审计」降为 `secondary`。 | `OptimizationPanel.test` ×2 |
| M-23 | ✅ | `ManageCenter.tsx`：`optimizerPendingCount > 0 && tab !== "optimization"` 时在 Tab 条下补一行可点的「有 N 项优化建议待确认 →」（`md:hidden`，点击切到「优化」）。不动 `ui/Tabs`，不恢复宫格。 | `ManageCenter.test` 「窄屏下有待确认建议时补一行可点的待办提示」 |
| M-24 | ✅ | `IdentityManual` 移到核心记忆分区之后；「项目资产」「智能体项目上下文预览」移入「项目记忆」页签（`MemoryPanel`），`ManageCenter` 不再在面板外追加。 | `IdentityManual.test`（DOM 顺序）、`MemoryPanel.test` 「项目页签含项目资产」 |
| M-25 | ✅ | 用户画像 `chars` / `overLimit` 同用 `norm(text).length`。 | `MemoryPanel.test` 「计数与超限判定同一口径」 |
| M-26 | ✅ | 打开工作台时并行拉 `getSkillHistory`，「历史（N）」首屏即带 N；加载期正文 label 不带 `v?`。 | `SkillEditor.test` 「历史页签计数在打开时就带上」 |
| M-27 | ✅ | 「✗错」→「出错」；多份草稿 Tabs `layout="scroll"`。 | —（视觉项） |

计划外顺手项：`AgentProjectPreview` 新增 `slotLabel()`、`LibraryPanel` 新增 `shortDocId()` 纯函数（均有用例）；
`ProjectSkillOverlay` 的加载失败也改为块内 Alert + 重试（原为 toast）。

ui-preview 新增场景 `manage-skills-workscope-open`（把折叠后的项目专属技能块点开，看 after 形态）。

## 8. 验证（阶段 B）

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck --workspace packages/web-react` | ✅ 绿（exit 0） |
| 模块单测 | `npx vitest run src/components/manage src/components/ManageCenter.test.tsx src/lib/connectors.test.ts --maxWorkers=1` | ✅ 14 个文件 / 153 例全绿（阶段 A 基线 127 例，新增 26 例） |
| 全量 web-react 单测 | `npm test`（`vitest run --maxWorkers=1`，699s） | ◐ 279 文件 / 3591 通过 / 147 跳过 / **3 失败均在 manage 之外且与本轮改动无关**：`MessageRenderer.test`（`beforeAll` 载入 MarkdownImpl chunk 超时 10s，用例注释自述全量并行时偶发）、`Markdown.prefetch.test`（同一 chunk 15s 超时）—— 两者**单独复跑 148/148 全绿**；`tutorialShowcase.test`（Windows `autocrlf` 使提交的 `dashboard.html` 字节数 46712→46755，SHA 校验用例，tutorials 归属 / 环境问题） |
| 代码风格 | `npx biome check <新建 / 重写的 7 个文件>` | ✅ 绿；既有 manage 文件（含阶段 A 之前）本就不过 biome 格式检查（双引号 + 分号 / 依赖数组），本轮不做整文件格式化，未新增 lint 诊断（`LibraryPanel` 一处 `useOptionalChain` 已改） |
| 视觉 after | `OC_UI_SCENES=manage-` `node browser-tests/ui-preview/shoot.mjs` → `D:\code\test_project\test123\.audit-tmp\manage\after\` | ✅ 49 场景 × 视口 × 主题 = 136 张，`manifest.json` `failures: 0`、`retried: 0`（`unmockedApi` 同阶段 A：`listCronChannels` / `listProjectAssets`） |

after 对照（同名 PNG，`before/` ↔ `after/`）：

- `manage-cron-chatscope--desktop--light` —— 「还没有定时任务 / 创建第一个」假空态 → 「这个会话组没有绑定工作项目」+ 切作用域出口，无「新建」。
- `manage-memory-usage--desktop--light` —— 标题 / 表头字号回到 13px 档，四张统计卡有底色。
- `manage-memory--desktop--light` —— 首屏不再是整宽橙色告警；本实例手册在核心记忆列表之后一行。
- `manage-skill-workbench-readonly--desktop--light` —— 正文由 50% 透明 disabled 控件 → 正常对比度只读块，标题「技能工作台 · …」。
- `manage-skills-workscope--desktop--light` / `manage-skills-workscope-open--*` —— 首屏还给搜索框与列表；展开后 Switch + 展示名 + slug + 「密钥类，不可用于项目」徽章，保存禁用直到有改动。
- `manage-memory-workscope-appendix--*` / `manage-memory-workscope-project--*` —— 文案不再含 `/api/project-assets` / `digest` / `facade` / `preview API` / `instructions · 1240B`；两块面板进「项目记忆」页签。
- `manage-skills-mobile--mobile--light` —— 390px 下标题两行完整可读，动作簇换行到行头下方。
- `manage-optimization-diff--*` —— 弹层副标题只剩「记忆」，`memory/xhs-…md` 收进「作用对象」行。

**NOT RUN**：`npm run test:browser`（本轮未触碰 Composer / 消息 / 工具卡 / 侧栏交互面）；真机 iOS Safari；真实 OAuth 回跳。

## 9. 遗留

| 项 | 归属 / 原因 | 建议 |
|---|---|---|
| M-09（P2）、M-18 / M-20 / M-21（P3） | `components/settings/ConnectorsTab.tsx` 归 settings；settings-B 待领 | 修法已写在 §4（各 1–5 行），交 settings-B 顺手改，或授权 manage 拿锁改 |
| M-12 余量 | `SkillOptPanel.tsx` 其余 ~40 处半角标点为该文件既有风格 | 单独一条 `style(v5): manage SkillOptPanel 标点全角化` 提交，避免混进逻辑改动 |
| M-17 导出 / 详情 | 需后端单文档接口与作者 / 年份元数据 | 记入「需后端配合」 |
| X-01 | `hooks/useProjectScope.tsx` 作用域重置竞态，sidebar 归属 | 待 sidebar-B；本轮 4 个测试文件用聊天项目 token / 直接给定作用域绕开 |
| M-06 ③ 后端口径 | `SkillSummary.sensitive` 下发 | 需后端配合；前端规则先兜底 |
