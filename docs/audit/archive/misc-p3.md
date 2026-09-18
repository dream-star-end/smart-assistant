# 杂项 P3 · `?demo=1` 演示模式 + optionsGroup 多题聚合 · 归档摘要（t-839，覆盖复查缺口 G-4 / G-5）

> 正文：[`docs/audit/misc-p3.md`](../misc-p3.md)（已随集成④ `bf940d804` 合入 integration，2026-09-17；t-1234 在 leftover-shell 分支另回写 D-02 / D-08 状态，待集成⑤）。本文只做摘要与索引。
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
| D-02 余项：demo 其余会话点开为空 | shell `App.tsx` `onDemoSelect` | ✅ 集成④ `4a2745283` 接线 `setMessages(DEMO_MESSAGES_BY_SESSION[id] ?? [])`；t-1234 `3aba642ca` 补 `App.test`「demo 切换会话按 id 取 fixture」用例锁定（待集成⑤） |
| D-08 demo 下交互块未说明原因 | shell + messages | ✅ 遗留清扫 t-1234 `3aba642ca`：`ChatInteraction.reason?: "demo"` + `chatInteractionUnavailableText()`「(演示模式仅供浏览,登录后可在真实会话中点选)」，`RichBlocks` `OptionsBlock` 按 reason 取文案，`App.tsx` demo 分支传 `{ reason: "demo" }`；`RichBlocks.test` +1；分支 `feat/v5-selfhost-audit-leftover-shell@7e7c7e43b`，待集成⑤ |
| OG-05 发送文本半角标点 | messages 单独立项 | 同批改 `cards.test` / `RichBlocks.test` / `persist.test` 与历史数据口径；仍开放 |
| OG-09 发送失败后组锁定无恢复 | messages | `sendUserText` 需失败通道；仍开放 |
| D-04 `DEMO_USER.displayName="rqmn"` · D-09 气泡任意字号 | 产品 / 排版专项 | 不修 |
| `optionsGroup.tsx:173` / `RichBlocks.tsx:249,267`（a11y-C 基线 `:256,:274`）勾选框 `bg-accent text-white` | a11y-shell §5 同源项 | ✅ a11y-C t-1233 `59e66773f` 两处改 `text-accent-fg`（`optionsGroup` 页脚已由本任务改 `Button` 原语自带 `-fg`），`RichBlocks.test` +1；集成④ a11y 复扫 `misc-options-*` 残留 ×3 即此项，随集成⑤ 合入后应归零 |

## 5. 分支 / 提交

- `feat/v5-selfhost-audit-misc-p3` @ `c834dffa1`：`5ce25612b` `592ffcff5` `f76d0fcb6` `89ab0edd5` `c834dffa1`（另含 integration `1d8eaf769` 合并）
- 集成：✅ 集成④ `bf940d804`（9 files, +676/−51，零重叠）；D-02 接线 `4a2745283`。集成④ 全量门：`npm test` 302 / 4279（`optionsGroup.test` / `demo.test` 为 +4 测试文件之二）、`run.mjs` 68/68、截图 301 场景含 misc-p3 7 场景 failures 0
- 后续：D-08 由 t-1234 `3aba642ca`、勾选框白字由 a11y-C `59e66773f` 落地，均待集成⑤
