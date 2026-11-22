# OpenClaude Agent 入口指针

> **已废止提示**：本文件原有的 V1/V3 Vanilla 前端（`packages/web/public/modules/`、`npm run test:web`）及 45.32 VPS 手动部署指令已过时，**严禁再用于 V5 开发与发布**。

所有 Coding Agent 在本仓库开展工作前，请按以下权威地图读取规范：

1. **源码工程总导航（必读，30 秒路由卡）**：`AGENTS.md`
2. **跨分支流程、Worktree、紧急通道与 `changelog.json` 规则**：`CLAUDE.md`
3. **V5 Selfhost（`feat/v5-selfhost`）唯一权威总手册**：`docs/V5_SELFHOST_PLAYBOOK.md`
4. **V5 个人版（从简 AI / Clarvy）UI/UX 设计与硬门禁宪章**：`docs/UI_DESIGN_SYSTEM.md`
5. **V5 商业版（Aurora，`feat/v5-aurora-rewrite`）权威手册**：`docs/V5_DEV_PLAYBOOK.md`

## 包级高频红线速查

- 前端 React / Tailwind v4（Clarvy Atelier）：`packages/web-react/AGENTS.md`
- Master / Egress / 计费 / 迁移：`packages/commercial/AGENTS.md`
- 容器 Gateway / 6 引擎适配 / 强模型主权：`packages/gateway/AGENTS.md`

## 本地秒级治理快门

```bash
npm run check:governance:fast
```
