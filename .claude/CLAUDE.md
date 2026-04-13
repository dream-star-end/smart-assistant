# OpenClaude Project Context

## 部署流程

```bash
# 本地
npm run check          # lint + typecheck + test (必须全部通过)
git add . && git commit -m "..."
git push origin master

# VPS (45.32.41.166:2222, root, password in deploy/.env)
/opt/openclaude/deploy.sh   # git pull + restart gateway
```

## VPS 关键路径

- 代码: `/opt/openclaude/openclaude/` (git repo, tracks origin/master)
- CCB: `/opt/openclaude/claude-code-best/`
- 配置: `/root/.openclaude/openclaude.json`
- Agents: `/root/.openclaude/agents.yaml`
- CCB settings: `/root/.claude/settings.json` (ANTHROPIC_BASE_URL → MiniMax)
- Skills: `/root/.openclaude/agents/<id>/skills/`
- Cron: `/root/.openclaude/cron.yaml`

## Provider 路由

- `provider: claude-subscription` → 注入 CLAUDE_CODE_OAUTH_TOKEN + CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1, 清空 ANTHROPIC_BASE_URL
- `provider: minimax` 或无 → 不注入 token, CCB fallback 到 settings.json (MiniMax API)
- 每个 agent 有独立的 Chrome profile (`/tmp/openclaude-browser-<agentId>`)

## 前端架构

- **ES Modules**: 21 个模块文件在 `packages/web/public/modules/`，入口 `main.js`
- **依赖层级**: dom/util/state (L0) → api/db/theme/markdown (L1) → ui/attachments/speech/notifications/permissions (L2) → oauth/memory/tasks/agents/sessions (L3) → messages/websocket/commands (L4) → main (L5)
- **循环依赖处理**: 使用 `setXxxDeps()` late-binding 模式
- index.html 使用 `<script type="module" src="/modules/main.js?v=5">`
- SW 版本号在 sw.js 第 3 行 (`openclaude-v6`)
- 关键 DOM 元素: `#toast`, `#lightbox`, `#messages`, 各种 modal
- **修改 HTML 后务必运行 `npm run test:web` 检查 DOM 完整性**

## 前端测试

- `npm run test:web` 运行前端测试（DOM 完整性 + 纯函数）
- DOM 完整性测试自动扫描 modules/ 中所有 $() 引用，交叉检查 index.html 中的 id
- 纯函数测试覆盖 _basename, formatSize, shortTime, sessionGroup, _cronHuman, localPathToUrl, htmlSafeEscape, formatMeta, buildToolUseLabel
