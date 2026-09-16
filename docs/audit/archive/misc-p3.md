# 杂项 P3 · `?demo=1` 演示模式 + optionsGroup 多题聚合 · 归档摘要（t-839，覆盖复查缺口 G-4 / G-5）

> 正文：`docs/audit/misc-p3.md`（随 `feat/v5-selfhost-audit-misc-p3` 合入后可读 **[待集成④]**）。本文只做摘要与索引。
> 任务：t-839，轻审 + 修复同人合一（fable-5-1-55）；QA 复核 t-1029（[qa.md](./qa.md)）。
> 分支 `feat/v5-selfhost-audit-misc-p3`，HEAD `c834dffa1`（基线 `210b9967`，开工先合入 integration `1d8eaf769` 对齐 `Message.tsx` / `RichBlocks.tsx` 基线）。
> 范围：`lib/demo.ts`（+test）、`components/Message.tsx`、`components/optionsGroup.tsx`（+test）、`scenes-misc-p3.tsx`（7 场景）；越界（指挥官批准）：`components/RichBlocks.tsx` OptionsBlock 3 处、`components/MarkdownImpl.tsx` `components` 记忆化。`App.tsx` demo 分支约 60 处只审不改。

## 1. 审出问题（D 9 + OG 9 = 18；P2 2 / P3 16）

| 编号 | 要点 |
|---|---|
| D-01…D-09（demo） | 回复文案模型名与选择器打架 · `messageCount` 与 fixture 不符 · 缺 `createdAt` · 演示账号真人 handle · `OptionsGroupProvider` 未传 `live` · 流式三点读屏不可达 · App demo 分支自洽（只审无发现）· 交互块「不可交互」未说明原因 · 气泡任意字号 |
| OG-01…OG-09（optionsGroup） | **OG-01（P2）** 注册走 `useEffect`，首帧点第一题误走「单块点击即发」（隐式发送 + 漏计）· **OG-02（P2）** 流式结束后点选与页脚全部丢失（根因 `MarkdownImpl` 每次渲染新造 `components` → 富块整体重挂）· OG-03 有未答仍说「已发送全部选择」· OG-04 发送键裸 `<button>` · OG-05 半角标点进用户消息 · OG-06 计数非 live region · OG-07 未提示未答题一并发出 · OG-08 非流式单块点击即发（设计如此）· OG-09 发送失败后组锁定无恢复 |

→ 正文 §3 问题清单与处置。

## 2. 修复情况（修复 D 5 / OG 7 = 12；不修 / 遗留 6）

- `5ce25612b` feat：OG-01（注册改 `useLayoutEffect`，点击时刻读 `store.getSnapshot().grouped`）· OG-02（`MarkdownImpl.components` `useMemo(deps: signMedia / blockImages / readOnly)`，`live` 走 ref；`Snapshot.grouped = count>=2 ∥ live ∥ answered>=1`）· OG-03 / 06 / 07 页脚文案与 `<output aria-live>` · OG-04 `ui/Button variant=accent`；新增 `optionsGroup.test.tsx` 10 例。
- `592ffcff5` feat：D-01（`demoReply` 模型名同源）· D-02（`messageCount` 对齐 fixture、`DEMO_MESSAGES_BY_SESSION`）· D-03（`createdAt`）· D-05（`live` 透传）· D-06（`<output aria-live="polite" aria-label="正在生成回复">`）；新增 `demo.test.ts` 4 例；`scenes-misc-p3.tsx` 7 场景。
- `c834dffa1` test：直接断言「live 翻转前后选项按钮是同一 DOM 节点」（指挥官批准② 要求，修前红修后绿）+ messages 三场景对照记录。`f76d0fcb6` / `89ab0edd5` 文档。
- 不修 / 遗留：D-04（产品）· D-09（排版专项）· OG-05（被 8 处断言与历史数据锁定，单独立项）· OG-08（设计如此）· D-02 余项 / D-08（shell）· OG-09（`sendUserText` 需失败通道）。

→ 正文 §4 修复记录、§6 遗留、§7 归属表勘误（`optionsGroup.tsx` → messages、`researchEvidence.tsx` → tools、`mathDelimiters.ts` → messages）。

## 3. 验证摘要（工作树 `wt\misc-p3`；QA 复核见 [qa.md](./qa.md) §3）

| 门 | 结果 |
|---|---|
| `typecheck` | ✅ 0 错 |
| `typecheck:preview` | `scenes-misc-p3.tsx` 0 错（余 3 错为他人存量，集成③ 已消） |
| 相关单测 | ✅ 7 文件 / 270 例（optionsGroup / demo / RichBlocks / MarkdownImpl / Markdown / cards / MessageRenderer）+ `App.test` demo 用例 |
| `test:browser` | ✅ 两轮 `run.mjs` 68 全过；`node --test` 70/73（基线 3） |
| `biome lint` 9 文件 | ✅ 新增 0 |
| 视觉 | ✅ before / after 各 24 张（7 场景）+ messages 三场景 `messages-timeline-rich / assistant-streaming / thinking-live` 重拍 12 张与 messages-B after 逐张比无差 |
| NOT RUN | `npm test` 全量、真机、真实 `?demo=1` 整页截图（截图台不挂整 App） |

## 4. 遗留与理由

| 项 | 归属 | 说明 |
|---|---|---|
| D-02 余项：demo 其余会话点开为空 | shell `App.tsx` `onDemoSelect` | 一行改 `DEMO_MESSAGES_BY_SESSION[id] ?? []` |
| D-08 demo 下交互块未说明原因 | shell + messages | `ChatInteraction` 加 `reason` |
| OG-05 发送文本半角标点 | messages 单独立项 | 同批改 `cards.test` / `RichBlocks.test` / `persist.test` 与历史数据口径 |
| OG-09 发送失败后组锁定无恢复 | messages | `sendUserText` 需失败通道 |
| D-04 `DEMO_USER.displayName="rqmn"` · D-09 气泡任意字号 | 产品 / 排版专项 | 不修 |
| `optionsGroup.tsx:173` / `RichBlocks.tsx:249,267` 勾选框 `bg-accent text-white` | a11y-shell §5 同源项 | 待定 **[待集成④]** |

## 5. 分支 / 提交

- `feat/v5-selfhost-audit-misc-p3` @ `c834dffa1`：`5ce25612b` `592ffcff5` `f76d0fcb6` `89ab0edd5` `c834dffa1`（另含 integration `1d8eaf769` 合并）
- 集成：**[待集成④]**
