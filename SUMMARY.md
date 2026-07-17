# UX 审计第三轮执行摘要

## 结果

本轮先以 `gh pr diff 72` 和现行代码逐项复核。任务候选中的 14 项已由 #72 修复，本轮不重复实现；实际新增修复 CHAT-10、CHAT-13、MOB-10 三项。冷类型检查另暴露并修正了 #72 `UsageTab` 数据表分支缺少 `report` 窄化的问题，不重复计为审计项。42 项台账现为：#68 修复 12 项、#72 修复 19 项、本批修复 3 项、待处理 8 项。

## 逐项处置

| ID | 处置 | 说明 |
|---|---|---|
| CHAT-05 | 已由 #72 修复 | 委派进度两行断词并保留完整 `title`。 |
| CHAT-06 | 已由 #72 修复 | Thinking 折叠标题可取得完整文本。 |
| CHAT-07 | 已由 #72 修复 | Plan 标题具备 `min-w-0`、伸缩与截断约束。 |
| CHAT-08 | 已由 #72 修复 | 两类历史分页按钮仅在粗指针下扩大到 44px。 |
| CHAT-09 | 已由 #72 修复 | 代码复制按钮补 `type="button"` 与粗指针命中区。 |
| CHAT-10 | 本批修复 | GFM 表格改由具可访问名称、焦点环和 `tabIndex=0` 的 region 承担横滚；窄屏提示在首次滚动/指针/方向键交互后收起。 |
| CHAT-11 | 已由 #72 修复 | Tool 摘要保留完整 `title`。 |
| CHAT-12 | 已由 #72 修复 | 查看器顶部动作仅在粗指针下扩大到 44px。 |
| CHAT-13 | 本批修复 | 已允许的站内信外链图复用只读查看器，支持放大并保留懒加载；链接图片将灯箱与原链接拆为独立动作，安全面见下节。 |
| MOB-05 | 已由 #72 修复 | 告警摘要窄屏单列、`sm` 以上三列。 |
| MOB-06 | 已由 #72 修复 | 市场分类横滚区可聚焦并带窄屏提示。 |
| MOB-07 | 已由 #72 修复 | 组织用量表横滚 region 可聚焦且不删列。 |
| MOB-09 | 已由 #72 修复 | 管理抽屉已有可见 44px 关闭按钮。 |
| MOB-10 | 本批修复 | 设置、管理、市场、组织四中心共用 `vh` 回退 → `dvh` → App 实测 visualViewport 的渐进增强与 safe-area 可用区居中约定，各自固定/最大高度与内部滚动语义保持不变。 |
| SURF-01 | 已由 #72 修复 | 四中心关闭按钮沿粗指针模式扩大，桌面密度不变。 |
| SURF-02 | 已由 #72 修复 | 市场标题区 `min-w-0`、关闭按钮 `shrink-0`。 |
| SURF-03 | 已由 #72 修复 | 市场二级分类仅在粗指针下提升到 44px。 |

## CHAT-13 安全面

- 来源校验未放宽：仅现有 `readOnly + signMedia` 分支认可的 `http://`、`https://`、`//` 外链进入只读查看器；`/api/inbox-assets/` 继续走既有 `SignedImg` 签名路径；容器私有路径等其他来源仍降级为文本。
- 只读语义不变：查看器仅保留关闭和下载，不继承聊天上下文的编辑、评论、调整大小、分享或“更多”动作，也不会启用只读上下文禁用的媒体路径 rehype 转换或 HTML 预览。
- Referrer policy 未降级：`no-referrer` 同时落在缩略图和全屏查看器的实际 `<img>`；下载仍走既有 `rel="noreferrer"` 原生路径。
- 远程图片保留原生 `loading="lazy"`；Markdown 链接图片（包括格式包装）递归识别，将灯箱按钮与原链接拆为同级动作，避免 `<a><button>` 非法嵌套和一次点击双重导航，同时不丢链接能力。

## 台账更新

`docs/UX_AUDIT_2026-07-16.md` 已逐行标明 #68、#72、本批或未修状态，并把旧的“修复 12 / 余 30”改为“修复 34 / 余 8”。待处理项为 COMP-01～03、MOB-02、SURF-04/05、ERR-07/08。

## 测试证据

| 命令 | 结果 |
|---|---|
| `cd packages/web-react && npx vitest run src/components/MarkdownImpl.test.tsx src/components/ImageViewer.test.tsx src/components/SettingsCenter.test.tsx src/components/ManageCenter.test.tsx src/components/MarketplaceCenter.test.tsx src/components/OrgCenter.test.tsx src/components/settings/UsageTab.test.tsx` | 7 文件、49 用例全绿。 |
| `npm run check:tutorials` | 通过：23 capabilities、23 media pairs、2,177,652 B；无 hash 漂移，无需 `tutorials:accept`。 |
| `cd packages/web-react && npx vitest run --maxWorkers=4` | 145 文件、1,533 用例全绿；默认高并发两次分别触发既有 admin/App 时序用例单点波动，单文件均通过，受控并发全绿。 |
| `npm run typecheck` | `tsc --build` 通过。 |
| `git diff --check` | 通过。 |
| 独立 Codex 代码审计 | 前两轮 findings 逐项修正后，最终复核返回 `CODEX AUDIT PASS`。 |

## 风险与未尽事项

- 按任务红线未改 COMP-01～03。Composer busy 草稿应在队列批统一设计显式“停止 / 排队发送”，并覆盖键盘、粗指针和附件。
- MOB-02 需要产品确定窄屏顶栏入口层级；建议保留智能体/模型，把低频入口收入不丢功能的 overflow 菜单，再做 320/375px 真机回归。
- SURF-04 需要明确 SubscriptionDialog 初始分区契约，使“套餐订阅 / 加量包”落点一致；SURF-05 的市场徽章密度留后续低风险批。
- ERR-07/08 继续按 Playbook 技术债处理，需前后端结构化错误信封同批迁移，不能前端单点替换。
- 本 worktree 无真机视觉链路；MOB-10 仍需 iPhone Safari / 鸿蒙 ArkWeb 验证地址栏、软键盘和 safe-area 组合。
- 生效面仅为 `packages/web-react/**`（dist）与 `docs/**`（master 文档），无需 runtime image、egress、迁移或 env 变更。按 TASK 要求未 push、未 deploy。
