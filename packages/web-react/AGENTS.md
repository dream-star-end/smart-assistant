# `packages/web-react` 前端改码硬纪律

> 完整设计宪章与 6 层 UI 门禁见 `docs/UI_DESIGN_SYSTEM.md`；仓库路由见 `AGENTS.md`。

## 1. Clarvy Atelier 视觉与 Token 铁律

- **单一色彩权威**：仅使用 `packages/web-react/src/styles.css` 定义的语义 Token（`--bg`/`--surface`/`--elevated`/`--accent`/`--accent-fg`/`--success-fg`/`--warning-fg`/`--danger-fg` 等）与 `color-mix(in oklch, ...)`；禁止新增硬编码 hex，逐步消化 `packages/web-react/src/components/iui/iui.css`、`packages/web-react/src/components/studio/studio.css`、`packages/web-react/src/styles/landing.css`、`packages/web-react/src/styles/containerWebPreview.css` 存量。
- **材质与原语**：全中心（含管理/市场/组织/后台/设置/站点/Studio/IUI）统一复用 `.oc-surface-card`、`.oc-surface-card-hover`、`.oc-surface-glass`、`.oc-surface-recessed`、`.oc-surface-popover`、`.oc-icon-badge*` 及 `packages/web-react/src/components/ui/` 原语；图标走 `packages/web-react/src/components/ui/AtelierIcons.tsx` 与 `packages/web-react/src/components/ui/ModelFamilyIcons.tsx`。
- **5+1 语义字号**：仅用 `text-title`/`text-section`/`text-body`/`text-meta`/`text-caption`（受限 `text-micro`）；**严禁覆写 Tailwind 原厂 `text-base`/`text-sm`/`text-xs`/`text-lg`**（保护 `<768px` 输入框 16px 防 iOS 自动缩放）；收敛 `text-[Npx]` 用 `scripts/codemod-text-size-tokens.mjs`。
- **11 档 `--z-*` 层级**：严守 `popover-portal(80) > viewer(70) > modal(60) > drawer(50) > popover-inline(40)`；禁止新增裸 `z-[60..999]` 或 `z-index: 60..999`。
- **动效降级**：所有新增 `@keyframes` / `animation:` 必须有 `prefers-reduced-motion` 覆盖；同轮最多 1 处流光。

## 2. 性能预算、滚动与状态不变量

- **470 KiB 首屏预算不可抬门**：`packages/web-react/budgets.json`（`481,280 B`）与 `packages/web-react/vite.config.ts` 受 A 类 `CODEOWNERS` 锁定；二级中心与重图表一律按需懒加载。
- **单 Writer 滚动铁律**：聊天主视口仅允许 `packages/web-react/src/components/chat/stickToBottom.ts` 与 `packages/web-react/src/hooks/useChatScroll.ts` 写 `scrollTop`（`.chat-scroll-area { overflow-anchor: none }`）；程序化跳转唯一路径为 `followBottomRef.current = false → stick.correctTo(scroller, targetTop)`；聊天核心域严禁新增 `.scrollTop =`/`.scrollTo(`/`.scrollIntoView(`。
- **禁裸 `React.lazy`**：所有动态导入视图必须经 `LazyBoundary` / `ChunkErrorBoundary`（`packages/web-react/src/components/ChunkErrorBoundary.tsx`、`packages/web-react/src/appLazyViews.tsx`）包裹，避免旧标签页 chunk 404 白屏。
- **Owner 围栏与三出口锁释放**：所有异步回调（含 `response.json()` 后与 `finally`）重核 `账号 epoch → 项目 → 会话/工单 → 请求`；互斥锁在跨会话切换、请求终态、组件卸载三出口幂等释放。
- **嵌套弹窗留父子树**：对话框内唤起子弹窗必须保留在父 React 子树内防 Radix `deferPointerDownOutside` 级联误关，并在关闭时清零唤起信号。
- **零学习成本与诚实错误**：用户聊天面禁现 `checkpoint_reset`、`PROMPT_TOO_LONG`、手动 `/compact` 催促横幅；真故障提交不可变 `_errorCardSnapshot`；工具非预期错误默认中性折叠；响应式统一用 `useViewportClass()`（`packages/web-react/src/hooks/useMdViewport.ts`），`<640px` 主按钮热区 ≥ `44×44px`，禁 `html/body` `overflow-x: hidden`。

## 3. 测试卫生与本地秒级验证

- **改公共 UI 先全量 Grep 关联测试**：修改 `App.tsx`、顶栏、侧栏、Composer、`MessageRenderer.tsx` 或 `components/ui/*` 前，先全仓搜索关联测试（如 `packages/web-react/src/App.test.tsx`），遵守 OCV5-343（`npm run test:web-react` 必须 100% 全绿，0 基线失败）。
- **日常迭代（`<20s`）**：
  - `npm run check:ui-gates`（滚动单 writer / `--z-*` / 零学习成本文案 / 动效降级）
  - `npx vitest run packages/web-react/src/test/designTokens.test.ts`（3 主题 AA + Token 棘轮 + `--z-*` 单调断言）
  - `npm run test:web-react`（目标文件可先定点跑，合前跑全量）
- **提交前收口**：
  - `npm run typecheck:preview --workspace packages/web-react`（防 `browser-tests/` 类型腐烂）
  - 改依赖/入口/CSS 跑 1 次 `npm run build:web-react`（470 KiB 首屏预算硬门）
  - 涉新入口/选择器跑 `npm run check:tutorials && npm run check:v5:e2e-selectors`
  - 视觉/布局实景扫描（已落盘，本地/按需运行，待 P1-3/P1-4 接入 PR CI；纯引擎单测已入 CI）：`node packages/web-react/browser-tests/layout-invariants.mjs` / `node packages/web-react/browser-tests/ui-preview/shoot.mjs --tier=core --list`
