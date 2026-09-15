# composer 模块审计（A 阶段）· 输入区 / 会话头 / 模型选择 / 会话目标 / 智能体选择

> 任务 t-34「A·composer 输入区/会话头/模型与目标审计」。分支 `feat/v5-selfhost-audit-composer`，基线 `210b9967`。
> 阶段 A 只产出本文档 + ui-preview 场景文件，**未改任何业务代码**。严重度口径见 TEAM_PLAYBOOK §5：P1 功能不可用/数据错误/阻断主流程；P2 明显体验缺陷/一致性破坏/移动端不可用；P3 打磨项。

## 1. 范围与文件清单

审计对象为 `packages/web-react/src/` 下 composer 归属文件（TEAM_PLAYBOOK §8），以及它们在 `App.tsx` 中的接线方式（只读，不改）。

| 类别 | 文件 | 行数 | 说明 |
|---|---|---|---|
| 组件 | `components/Composer.tsx` | 860 | 输入区本体：正文/草稿、附件 chip、拖放/粘贴、语音、发送/停止、「+」菜单、目标徽标、引用块、环境准备条、图片灯箱 |
| 组件 | `components/ChatHeader.tsx` | 369 | 会话顶栏：智能体入口、项目面包屑、团队/顾问模式 chip、模型选择器、查找/导出/站内信/余额 |
| 组件 | `components/ModelSelector.tsx` | 746 | 模型菜单：家族折叠、锁定/降级行、搜索、最近、思考档位、速度、上下文档位、1M 费用确认 |
| 组件 | `components/GoalDialog.tsx` | 167 | 会话目标对话框：目标/预算表单、运行统计、暂停/继续/完成/清除 |
| 组件 | `components/AgentPicker.tsx` | 337 | 智能体选择弹窗：全能助手 featured 卡 + 协作方式（单人/顾问/团队）+ 已安装智能体网格 + 市场入口 |
| 组件 | `components/AgentScopePicker.tsx` | 104 | 「适用智能体」多选与摘要徽章（技能/连接器安装面复用） |
| 组件 | `components/AgentGate.tsx` | 143 | 对话前置面板：检查中/引导开通/开机中/余额不足/运行时未就绪/出错 |
| 组件 | `components/LongContextCostWarning.tsx` | 15 | 1M 上下文费用确认正文 |
| hooks | `hooks/useVoiceInput.ts` | 268 | 语音输入 STT 状态机（MediaRecorder → WS） |
| hooks | `hooks/useComposerDraft.ts` `hooks/useLocalComposerPrefs.ts` | 26 / 76 | 会话级草稿；发送键/字号本地偏好 |
| hooks | `hooks/useLaneGate.ts` `hooks/useOptimizerPending.ts` `hooks/useInflightDelegates.ts` `hooks/useAgentGate.ts` | 43 / 66 / 122 / 177 | lane 闸、优化待办计数、在途委派、对话前置态机 |
| lib | `lib/modelPreferences.ts` `lib/modelSwitch.ts` `lib/recentModels.ts` `lib/cursorModelPicker.ts` | 123 / 67 / 23 / 360 | 模型偏好解析、切换约束与文案、最近模型、picker 行构造 |
| lib | `lib/agents.ts` `lib/teamMode.ts` `lib/composerDraft.ts` `lib/goalStart.ts` `lib/chatCreateTemplates.ts` `lib/sessionEffort.ts` `lib/sessionContextTier.ts` | 272 / 58 / 80 / 33 / 29 / 63 / 60 | 智能体模型、团队模式/档位/上下文档位的会话级持久化、草稿存储、目标启动、创建模板 |
| 接线（只读） | `App.tsx` L753-838（selectModel）、L1014-1039（effort / contextTier）、L1513-1533（锁定模型）、L3462-3500（ChatHeader）、L3750-3797（Composer）、L3823-3872（AgentPicker） | — | 用于判断真实 props 与状态来源 |

不在本模块范围、但审计中触及并在 §5 移交的：`App.tsx`（shell）、`components/ui/**`（shell）、消息列表里的「排队中」状态展示（messages）。

## 2. 方法与证据

1. **代码通读**：上表全部源文件 + 对应 `*.test.ts(x)` 的用例标题（`Composer.test.tsx` 18 条、`composerAttach.test.tsx` 12 条、`ChatHeader.test.tsx` 20 条、`ModelSelector.test.tsx`、`GoalDialog.test.tsx` 4 条、`AgentPicker.test.tsx` 9 条等），以及 `browser-tests/cases.json` 中覆盖本模块的真浏览器用例：T1–T4（附件 label / 「+」菜单 / chip / file input 结构红线）、T7（「+」→ 设定目标）、T18（引用）、T23（顶栏切模型、降级不可点）、T25（390×844 整页顶栏与输入区可点）、T35（唯一 Stop 入口 + 停止结算态）、T41（Codex 密度 token）。
2. **视觉预览台**（决策 d-28）：`browser-tests/ui-preview/scenes-composer.tsx` —— 沿用 opus-5-4 掉线前建好的 8 个场景，本轮**新增 2 个**：`composer-agent-gate-phases`（引导开通 / 运行时未就绪 / 出错带追踪号）、`composer-scope-picker`（AgentScopePicker 可选/只读 + 摘要徽章 + 1M 费用提示正文）。共 10 场景 × desktop/mobile × light/dark = **40 张 PNG**，全部成功、`unmockedApi: []`。
   - 截图目录：`D:\code\test_project\test123\.audit-tmp\composer\before\`（含 `manifest.json`；PNG 不入库）
   - 命令：`OC_UI_SCENES=composer- node browser-tests/ui-preview/shoot.mjs`（52s）
   - 逐张用 Read 看图；下表「现象」中标注 📷 的条目有截图佐证，文件名即场景 id。
3. **跑过的验证**（均在 `wt\composer`）：
   - `npm run typecheck --workspace packages/web-react` → 绿（35s）
   - `npx vitest run <本模块 24 个测试文件> --maxWorkers=2` → 绿（24 files / 230 tests，66s）
   - 未跑 `npm run test:browser`（阶段 A 未改代码；B 阶段改 Composer 必跑）
4. **尺寸推算**（用于移动端结论）：`Composer.tsx` L427 根容器 `max-w-3xl px-4`，L535 工具行 `px-2.5 gap-1.5`；触屏下 4 个圆形按钮各 `size-11`（`IconButton` md 档 `[@media(hover:none)]:size-11`，发送键 L727 同）。390px 视口：390 − 32 − 20 − 4×44 − 4×6 = **138px** 给 textarea。与 `composer-loaded--mobile` 截图中每行仅容 8 个汉字一致。

## 3. 问题清单

编号规则：`C-xx`。「位置」相对 `packages/web-react/src/`。

### P2（13 条）

| # | 位置 | 现象 | 影响 | 严重度 |
|---|---|---|---|---|
| C-01 | `components/Composer.tsx` L535-538（工具行）、L557-570（回形针）、L575-641（「+」）、L687-702（麦克风）、L707-742（发送）；L427 | 📷 `composer-loaded--mobile` / `composer-busy--mobile`：390px 下回形针、「+」、麦克风、发送 4 个 44px 按钮与 textarea 同排，textarea 只剩约 138px（35% 视口），正文每行 8 个字，长草稿变成窄条 | 移动端主输入面可读性/可编辑性差，多行消息几乎不可用；是本模块最影响日常使用的问题 | P2 |
| C-02 | `components/Composer.tsx` L335-346（submit 允许 busy 排队）、L657-679（Enter 逻辑，L671 粗指针直接 return）、L718-724（按钮 busy→onStop） | 生成中 Composer 的唯一按钮是「停止」；桌面按 Enter 会排队发送但界面无任何「已排队」反馈；**触屏设备 Enter=换行，生成中根本没有发送/排队入口**（📷 `composer-busy` 正文本身就写着这个矛盾） | 移动端生成中无法排队消息，只能等；桌面用户不知道 Enter 会排队、也不知道点按钮会打断生成 —— 误停风险 | P2 |
| C-03 | `components/Composer.tsx` L557-570（`<label htmlFor>` 无 tabIndex/role）、L545-556（input `tabIndex={-1}`） | 「添加附件」是 `<label>`，不在 Tab 序列；file input 又 `tabindex=-1` | 纯键盘/读屏用户完全无法触达附件功能（WCAG 2.1.1 Level A）。注意 T4 结构红线要求 input 保持 `tabindex=-1`、非 display:none、禁止合成 `input.click()`，修法必须绕开这三条 | P2 |
| C-04 | `components/Composer.tsx` L878-885（移除 `size-6`）、L855-864（重试 `h-6`）、L865-877（编辑 `min-h-11 sm:min-h-8` 但宽度仅 px-2） | 📷 `composer-attach-chips--mobile`：chip 内「×」24×24、「重试」高 24px，紧挨「编辑」 | 触控目标远低于 44px 红线（§5.2），移除/重试/编辑三键相邻易误触 | P2 |
| C-05 | `components/GoalDialog.tsx` L180（清除 ghost 按钮直接 `onAction("clear")`） | 📷 `composer-goal-dialog`：「清除」与「完成」并排，点一下目标即清、无确认、无 danger 视觉 | 危险操作无确认（§5.3），且 `visibleGoalOf` 语义下清除后徽标/菜单状态点立刻消失，不可撤销 | P2 |
| C-06 | `components/AgentPicker.tsx` L288-327（`disabled={unavailable}`，L321-325 仅文字提示） | 📷 `composer-agent-picker`：「数据采集助手 · Plugin 待授权」卡片整卡禁用，提示「完成必需能力授权或修复后可使用」但没有任何去授权的入口 | 错误态不可恢复（§5.3）：用户不知道去「管理中心 → 插件」授权；禁用按钮也不可聚焦，读屏读不到原因 | P2 |
| C-07 | `components/ModelSelector.tsx` L123-138（trigger 只显家族名）、L483-505 | 📷 `composer-idle`：trigger 显示「Opus 5 ×9.0」，当前思考档「高」只有点开菜单才知道；同一家族 medium/high 单价不同（×7.5 vs ×9.0） | 计费相关状态不可见；用户切了档位后顶栏看不出变化，仅靠倍率数字暗示 | P2 |
| C-08 | `components/ModelSelector.tsx` L540-554（降级提示只在菜单内）、L186-189 | 当前模型被后端标 degraded 时，trigger 无任何标识，只有点开菜单才看到「当前模型暂不可用」 | 用户可能持续在不可用模型上发送并失败后才知情；`resolveSessionModel` 只在切会话时回避降级模型，运行中降级不覆盖 | P2 |
| C-09 | `components/Composer.tsx` L91-113（`EnvironmentPrepBar` 按 20s 线性走到 100% 后停住） | 「环境准备中，约 20 秒」进度条是时间假进度：冷启超过 20s 时停在 100% 不动，文案仍是「约 20 秒」 | 反馈失真（§5.3）：最需要安抚的慢路径上给出错误信号；`chat.provisioning` 结束才卸载 | P2 |
| C-10 | `components/Composer.tsx` L707-717（禁用原因只放 `title`）、L725 | 附件上传中/失败时发送键禁用，原因只在 hover title 里；chip 的失败原因也只在 title（L828） | 触屏无 hover：移动端用户看到发送键灰掉、chip 变红，但看不到「为什么」和「怎么办」 | P2 |
| C-11 | `hooks/useVoiceInput.ts` L234-271（stop 置 transcribing）、L210-222（只有收到 polish/error 才回 idle） | 停止录音后进入「正在转写…」，若服务端不回 `polish`/`error`（网络抖动、WS 半开）状态永久卡在 transcribing，麦克风按钮持续禁用（`Composer.tsx` L691） | 语音功能一次异常后本会话不可再用，需刷新页面 | P2 |
| C-12 | `components/ChatHeader.tsx` L304-314（导出 `hidden sm:flex`） | 窄屏彻底没有「导出会话」入口，也没有溢出菜单承接 | 移动端功能缺失（§5.2）：功能按视口消失而非降级 | P2 |
| C-13 | `components/AgentScopePicker.tsx` L69-73（选中 id 不在列表时按原样渲染） | 📷 `composer-scope-picker`：已卸载/不存在的智能体以原始 id（如 `ghost-agent-removed`）+ 🤖 作为可点选项出现 | 开发者术语泄漏（§5.6）且可被反复勾选；用户无法分辨这是脏数据还是真实智能体 | P2 |

### P3（22 条）

| # | 位置 | 现象 | 影响 | 严重度 |
|---|---|---|---|---|
| C-14 | `components/Composer.tsx` L535（`items-end`）+ L427 | 📷 `composer-loaded--desktop`：多行草稿时按钮贴底、正文左侧留出约 70px 空白列，引用块/附件区却是通栏 —— 视觉不对齐 | 桌面观感；与 C-01 同源，两行式布局一并解决 | P3 |
| C-15 | `components/Composer.tsx` L621-641（无目标时禁用「+」`title="附件暂不可用"`） | 📷 `composer-busy` 第三个禁用输入框：「+」菜单早已只剩「设定目标」，禁用态 title 仍写「附件暂不可用」 | 文案过期误导 | P3 |
| C-16 | `components/Composer.tsx` L575-620 | 「+」菜单只有一项「设定目标/目标」，点开菜单再点一次才能到目标 | 多一跳；可考虑直接用目标图标按钮（需评估 T2/T7/T25 断言） | P3 |
| C-17 | `components/Composer.tsx` L703（`正在停止…` caption）+ App 传的 placeholder | 📷 `composer-busy` 第二个输入框：占位符与右下 caption 同时写「正在停止…」，caption 贴麦克风底部基线、字号 caption 挤在角落 | 冗余 + 对齐差 | P3 |
| C-18 | `components/Composer.tsx` L845-851（`max-w-[140px] truncate`） | 📷 `composer-attach-chips`：长文件名尾截断，扩展名一起被截掉（「一个名字特别长的设计…」） | 无法区分同名不同格式的文件 | P3 |
| C-19 | `components/Composer.tsx` L293-296（语音错误 3s 自动消失、无 `role=status`）、L747-752（状态放底部工具条 `text-xs`） | 「无法访问麦克风，请检查浏览器权限」3 秒后消失，且不走 live region | 读屏听不到；来不及读完 | P3 |
| C-20 | `components/Composer.tsx` L687-702（不支持时仅 title「语音输入暂不可用」） | 触屏无 title：不支持 MediaRecorder / 非安全上下文时麦克风只是灰掉 | 用户不知道原因 | P3 |
| C-21 | `components/Composer.tsx` L704-706 + `lib/composerDraft.ts` L2、L55-67 | 草稿超过 20KB 只留内存（reload 丢失），UI 没有任何提示；>2000 字只显示字数 | 长文粘贴后刷新丢稿且无预警 | P3 |
| C-22 | `components/Composer.tsx` L392-395（`attachments` 取渲染闭包） | 连续两次快速拖放时 `room` 用的是旧的 `attachments.length`，可超出 `MAX_ATTACH` | 边界竞态，后端会拒；概率低 | P3 |
| C-23 | `components/Composer.tsx` L657-679 | 引用块只能点「×」取消，无 Esc；全局 Esc 已被「停止生成」占用（`lib/hotkeys.ts`） | 键盘效率 | P3 |
| C-24 | `components/ChatHeader.tsx` L298 | 查找按钮 title 固定「(⌘F)」 | Windows/Linux 用户看到 Mac 符号 | P3 |
| C-25 | `components/ChatHeader.tsx` L236-249 + `components/ModelSelector.tsx` L495-501 | 📷 `composer-loaded--desktop`：团队模式开启时顶栏出现「团队模式」chip 与「团队模式 · GPT-6-Astra」trigger，同词两次 | 冗余，挤占顶栏（叠加顾问 chip 时更明显） | P3 |
| C-26 | `components/ChatHeader.tsx` L103 | `low` 只在余额为 0 或负数时为真 | 「快用完」没有预警态（阈值应由后端/产品定） | P3 |
| C-27 | `components/ModelSelector.tsx` L216-244（L222 只跳过 `id === selectedId`） | 切过同家族不同档位后，「最近」区会出现与当前选中同一家族的行且带 ✓，与主列表重复 | 视觉重复、语义混乱 | P3 |
| C-28 | `components/ModelSelector.tsx` L193 + L483-505 | `modelSwitchPreparing`（压缩切换中）trigger 直接禁用，无 spinner/文案 | 用户不知道在等什么 | P3 |
| C-29 | `components/ModelSelector.tsx` L513-526 | 菜单打开后焦点在首项，搜索框不自动聚焦；≥8 模型才显示搜索 | 键盘用户要多按一次 | P3 |
| C-30 | `components/ModelSelector.tsx` L653-683 vs L295-312 + `App.tsx` L1030-1036 | GPT/Kimi 1M 走 `LongContextCostWarning` 确认；Cursor Opus/Fable 1M 档位直接切换，仅靠「单轮消耗更高」半句说明 | 两套 1M 心智不一致；是否需要确认取决于计费语义 → 见 §5 | P3 |
| C-31 | `components/GoalDialog.tsx` L143（blocked → accent）、L113（原始 error.message）、L160-167（原生 textarea）、L79-84 | 「受阻」状态用 accent 色；错误直接展示 `err.message`；目标输入框不用 `ui/Textarea`；对话框打开期间 `stateRevision` 变化会覆盖正在编辑的表单 | 状态色语义、文案一致性、并发编辑丢失 | P3 |
| C-32 | `components/AgentPicker.tsx` L74-76、L193、L213 | 「一期仅 CCB 主会话可咨询」「队长切 Astra」—— CCB/一期/Astra 是内部代号，且 L213 硬编码 Astra 而 L218 用常量 `DEFAULT_CODEX_ENGINE_MODEL_DISPLAY_NAME` | 开发者术语泄漏（§5.6）；引擎更名时两处漂移 | P3 |
| C-33 | `components/AgentPicker.tsx` L226-238（原生 `<select>` py-1）、L252-257（原生 checkbox）、L110-114（加载中只有一行文字，网格先空后跳） | 📷 `composer-agent-picker`：顾问型号下拉与「同时作为新会话默认」复选框是浏览器原生控件，与设计系统不一致，下拉约 28px 高；每次打开都重拉列表，预设卡片延迟出现 | 一致性 + 触控 + 布局跳动 | P3 |
| C-34 | `components/AgentGate.tsx` L30（`h1`）、L99-101（shortfall 未千分位） | 📷 `composer-agent-gate`：「还差 12000 积分」而顶栏余额是「128,900」；面板用 `h1`，与 App L3461 的 sr-only h1 并存 | 数字格式不一致；一页多个 h1 | P3 |
| C-35 | `components/LongContextCostWarning.tsx` L9-12；`components/AgentScopePicker.tsx` L84-88 | 📷 `composer-scope-picker`：JSX 换行导致「上下文， 缓存读取」多出一个空格；AgentScopePicker 标题与提示同排，390px 下标题被挤成两行 | 排版打磨 | P3 |

统计：**P1 0 条 / P2 13 条 / P3 22 条**，共 35 条。

## 4. 修复计划（B 阶段）

原则：P2 必修，P3 量力；每条改动配测试；改到 Composer 的一律跑 `npm run test:browser`（T1–T4/T7/T18/T25/T35/T41 是本模块红线）。不动 `App.tsx`、`components/ui/**`；需要接线的走 §5 移交。

### 4.1 Composer 两行式布局（C-01、C-14、C-17、C-15）

- **改**：`Composer.tsx` L535-743 工具行拆成两行：第一行 textarea 通栏（保留 `max-h-[240px]` 自适应）；第二行左侧 回形针 / 「+」/ RepoPill，右侧 字数 / 语音状态 / 麦克风 / 发送。桌面也统一两行（解决 C-14 左侧空白列）。「正在停止…」caption 只保留一处（placeholder 由 App 传，故删 L703 caption，或改为 `aria-live` sr-only）。禁用「+」的 title 改为「会话目标暂不可用」。
- **红线**：T1/T3/T4 的 label→input 结构、`data-product-feature`/`data-testid` 一律保留；T25「汉堡与回形针附件与发送受信可点」需在新布局复核；T41 密度 token 的 class 断言（`Composer.test.tsx` L9 外壳 border 断言）保持。
- **测试**：`Composer.test.tsx` 新增「工具行与 textarea 分行（textarea 父级不含按钮）」结构断言；重出 `composer-idle/loaded/busy` after 截图；`test:browser` 全绿。
- **风险**：中。布局改动影响所有会话页；用 ui-preview desktop/mobile × light/dark 对照 + 真浏览器门兜底。

### 4.2 生成中排队发送入口（C-02）

- **改**：`Composer.tsx` 发送/停止区：busy 且 `canSend` 时，在「停止」旁增加一个次级「排队发送」按钮（`aria-label="排队发送"`，图标 `ListPlus`/`ArrowUp` + 角标），点击走 `submit()`；「停止」仍是唯一 Stop 控件（T35）。触屏 Enter 仍换行，发送靠该按钮。submit 成功后 toast「已加入队列，本轮结束后发送」（`useToast` 已在 Composer 内）。
- **测试**：`Composer.test.tsx` 新增 3 条：busy+有正文 → 出现排队按钮并调用 onSend；busy+空正文 → 不出现；stopping → 不出现。T35「只有一个 Stop 入口」保持（新按钮 aria-label 不含「停止」）。
- **移交**：消息列表侧「排队中」气泡状态由 messages 模块负责（已有 `status=queued` 路径），此处只补入口与 toast。
- **风险**：低-中。需确认 `useToast` 在 Composer 已挂载 Provider（L228 已在用）。

### 4.3 附件入口键盘可达（C-03）

- **改**：`Composer.tsx` L558-570 `<label>` 加 `tabIndex={0}` `role="button"`，`onKeyDown` 捕获 Enter/Space → `e.preventDefault(); e.currentTarget.click()`（触发 label 原生激活，**不是** `input.click()`，不改 input 的 `tabindex=-1`/非 display:none/无 accept 三条红线）；补 `focus-visible` ring（`iconButtonVariants` 已含）。
- **测试**：`composerAttach.test.tsx` 新增「label 可聚焦；Enter/Space 派发一次 click 到 file input」；T4 结构断言不变。
- **风险**：低。

### 4.4 附件 chip 触控与信息（C-04、C-10、C-18）

- **改**：`AttachChip`：移除键 `size-6 [@media(hover:none)]:size-11`，重试键 `h-6 [@media(hover:none)]:min-h-11 px-2.5`，三键之间 `gap-1`→`gap-1.5`；错误态在 chip 下方（或 chip 内第二行）用 `text-caption text-danger` 显示 `a.error`，不再只放 title；文件名改中段截断（保留扩展名，新增 `lib/…` 纯函数 `middleTruncate(name, 24)`）。发送键禁用原因：在工具行右侧加一条 `role=status` 的 caption（「附件上传中…」/「有附件上传失败」），替代 title。
- **测试**：`composerAttach.test.tsx` 断言 class 与错误文案可见；新增 `middleTruncate` 单测。
- **风险**：低。

### 4.5 GoalDialog 清除确认与状态色（C-05、C-31）

- **改**：`GoalDialog.tsx`：「清除」改 `variant="danger"`（或 ghost + `text-danger`），点击走 `useConfirm()`（`ui/ConfirmDialog` 已有）二次确认「清除会话目标？目标与预算统计将被移除」；blocked 状态 Badge tone→`warning`；错误经 `apiErrorMessage(err, "操作失败")`；目标输入框换 `ui/Textarea`；表单重置 effect 只在 `open` 翻真时执行（去掉 `stateRevision` 依赖，另加「服务端已更新，是否重载」提示仅当有未保存修改）。
- **测试**：`GoalDialog.test.tsx` 新增「清除需确认；取消不调 onAction」「blocked 用 warning」；既有 4 条保持。
- **风险**：低。

### 4.6 AgentPicker 不可用卡片可恢复 + 文案 + 控件（C-06、C-32、C-33）

- **改**：不可用卡片不再 `disabled`：可聚焦、点击弹出说明 + 「去授权」按钮（新增 prop `onOpenPluginAuth?: (agent) => void`，未传则只显说明）；文案：「顾问」卡副标改「主模型不变，仅当前会话支持时可咨询」，`advisorBlockReason` 默认文案去掉「一期/CCB」（保留 `advisorConsultParentReason` 服务端文案优先）；「团队」卡副标用 `DEFAULT_CODEX_ENGINE_MODEL_DISPLAY_NAME` 拼接；顾问型号 `<select>` 换 `ui/Select`，复选框换 `ui/Switch`（或 `Field` 内 checkbox 样式）；加载中用 `ListSkeleton` 占位两张卡，避免跳动。
- **测试**：`AgentPicker.test.tsx` L132「保留未就绪 Agent…禁止选择执行」改为「可聚焦但 onPick 不被调用，点击弹出授权指引」；L45 文案断言随常量更新；新增「onOpenPluginAuth 传入时渲染去授权按钮」。
- **移交**：`App.tsx` 需把 `onOpenPluginAuth` 接到 `openManage("plugins")`（shell owner，见 §5）。未接线时组件退化为仅说明，不阻塞合入。
- **风险**：低-中（ui/Select 的 Portal 在 Modal 内的层级需实测）。

### 4.7 ModelSelector（C-07、C-08、C-27、C-28、C-29）

- **改**：trigger 在 `sm+` 显示「家族 · 档位」（如「Opus 5 · 高」，Fast 时加「· Fast」），窄屏保持家族名；当前模型降级时 trigger 前置 `AlertTriangle` 小图标 + `aria-label` 带「暂不可用」；`recentRows` 去重时跳过与当前选中同一 family 的行；`loading` 时 trigger 显示 `Spinner` 与「切换中…」而非仅禁用；菜单打开且 `showSearch` 时用 `onOpenAutoFocus` 把焦点交给搜索框（Escape/ArrowDown 仍放行到菜单）。
- **测试**：`ModelSelector.test.tsx` 新增 5 条对应断言；T23 保持。
- **风险**：低。注意 `ChatHeader.test.tsx` L84/L91 对 trigger 文案的断言需同步。

### 4.8 环境准备条与语音（C-09、C-11、C-19、C-20）

- **改**：`EnvironmentPrepBar` 20s 后切为不确定态（条纹动画）并把文案改「仍在准备，请稍候…」；`useVoiceInput` 在 `stop()` 与 `connecting` 各加 15s 安全超时 → `fail("语音识别超时，请重试")` 并 cleanup；语音错误改为常驻到下一次交互（或 6s）且包在 `role="status"`；不支持时点麦克风 toast 说明原因（按钮不再 disabled，而是 `aria-disabled` + 点击提示）。
- **测试**：`Composer.test.tsx` 用 fake timers 断言 20s 后文案切换；新增 `useVoiceInput.test.ts`（模拟 WS 不回包 → 超时回 idle）。
- **风险**：低。

### 4.9 ChatHeader（C-12、C-24、C-25、C-26）

- **改**：窄屏把导出并入一个「更多」`DropdownMenu`（含导出、查找）；快捷键标签按 `navigator.platform` 切换 ⌘/Ctrl（新增 `lib/…` 小函数 `modKeyLabel()`，或复用 hotkeys 里的判断）；团队模式 trigger 去掉「团队模式 · 」前缀（chip 已表达），保留 `Users` 图标与 accent 色；`low` 阈值改为「≤ 后端给的提醒阈值」——后端字段不存在则保持现状（§5 记需后端配合）。
- **测试**：`ChatHeader.test.tsx` 补窄屏更多菜单、标签平台化；L84 断言随前缀调整。
- **风险**：低。

### 4.10 其余 P3 打磨（C-13、C-16、C-21、C-22、C-23、C-30、C-34、C-35）

- `AgentScopePicker`：不在列表的选中 id 渲染为「已卸载 · <id 前 8 位>」灰色不可选徽章并提供「移除」；标题/提示在 `sm` 以下改上下堆叠。
- `Composer`：草稿超过 20KB 时在字数旁显示「草稿过长，刷新后不保留」；`onFiles` 用 `setAttach` 回调内的最新长度算 `room`；引用块存在时 Esc 取消引用（仅当 textarea 聚焦且不在生成中）。
- `AgentGate`：`h1`→`h2`；shortfall 经 `groupDigits`。
- `LongContextCostWarning`：合并字符串去掉空格。
- 「+」菜单单项直达（C-16）与 Cursor 1M 确认（C-30）**先 ask_decision**，不在 B 阶段默认做。

### 4.11 B 阶段验证清单

`npm run typecheck` → `npx vitest run src/components/{Composer,composerAttach,ChatHeader,ModelSelector,GoalDialog,AgentPicker,AgentScopePicker}*.test.tsx src/hooks src/lib`（本模块）→ `npm run test:browser`（T1–T4/T7/T18/T23/T25/T35/T41 必绿）→ `OC_UI_SHOTS=…\composer\after` 重出 10 场景 40 张对照。

## 5. 建议不修 / 暂缓项及理由

| 项 | 处理 | 理由 |
|---|---|---|
| 「x9.0」倍率写法 | 不修 | `formatCostX` 来自 protocol，全站统一（settings/用量/市场同款）；单模块改会破坏一致性 |
| 草稿用 sessionStorage（关标签即丢） | 不修 | `composerDraft.ts` 头注释是有意的隐私/多标签隔离取舍；改 localStorage 需产品拍板 |
| Cursor 1M 档位是否要费用确认（C-30） | 暂缓 → `ask_decision` | Cursor 档位是同一模型收窄上下文窗口（单价不变、Token 更多），与 GPT 1M（单价 ×1.5）计费语义不同；是否复用同一确认框是产品口径问题 |
| 「+」菜单单项直达（C-16） | 暂缓 → `ask_decision` | T2/T7/T25 三条真浏览器用例围绕「+」菜单写死，改成直达按钮要同步改用例契约 |
| 团队模式双重「团队模式」文案（C-25） | B 阶段试做，若 ChatHeader.test L84 契约不允许则回退 | 该断言是「顶栏所见 = 实际所发」的产品承诺，文案可调但语义不能丢 |
| 余额「快用完」预警阈值（C-26） | 记「需后端配合」 | 前端没有阈值来源，硬编码会与套餐/计费漂移 |
| 顾问/CCB 相关文案（C-32） | B 阶段改默认文案，服务端 `advisorConsultParentReason` 优先 | 「一期/CCB」是内部叫法，但服务端已可下发原因文案；只改前端兜底句 |
| 「排队中」消息的时间线展示 | 移交 messages 模块 | Composer 只补入口（4.2）；气泡状态归 `lib/chat` / MessageList |
| `App.tsx` 接线（`onOpenPluginAuth`、可能的 `onOpenMobileMore`） | 移交 shell（opus-5-1）：`send_to` 说明「文件 / 想要的改动 / 为什么」 | 归属表规定 App.tsx 越界不改；组件侧 prop 可选，不接线也能合入 |
| `components/ui` 新原语 | 不新增 | 本模块全部改动可用现有 `Modal/ConfirmDialog/Select/Switch/DropdownMenu/Spinner/ListSkeleton` 完成 |

## 验证记录（A 阶段）

| 项 | 结果 |
|---|---|
| `npm run typecheck --workspace packages/web-react` | 绿，35s |
| ui-preview 截图（10 场景 / 40 张） | 全部成功，`failures: []`，`unmockedApi: []` |
| 本模块 vitest（24 个测试文件，`--maxWorkers=2`） | 绿：24 files / 230 tests passed，66s |
| `npx biome check browser-tests/ui-preview/scenes-composer.tsx` | 绿（已按 biome 整理导入与格式，LF 行尾） |
| `npm run test:browser` | NOT RUN（A 阶段未改业务代码） |
