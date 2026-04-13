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

## 前端注意事项

- app.js ~3500 行 vanilla JS, index.html ~475 行, style.css ~1900 行
- 关键 DOM 元素: `#toast`, `#lightbox`, `#messages`, 各种 modal
- **修改 HTML 后务必检查所有被 $() 引用的 id 元素是否存在**
- SW 版本号在 sw.js 第 3 行, app.js 缓存版本在 index.html 最后的 script 标签

## 下次待做

- 前端测试用例（DOM 元素完整性、关键函数）
- 前端代码拆分重构（保持 vanilla，用 ES module 或注释分区）
- VPS 上 git pull 部署已就绪
