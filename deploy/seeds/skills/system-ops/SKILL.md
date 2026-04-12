---
name: system-ops
description: "OpenClaude 系统运维: 服务管理、日志查看、配置修改、故障排查"
version: "1.0.0"
tags: [system, ops, devops]
related_skills: [platform-capabilities]
---

# OpenClaude 系统运维

## 服务管理

OpenClaude 作为 systemd 服务运行:

```bash
systemctl status openclaude     # 查看状态
systemctl restart openclaude    # 重启服务
journalctl -u openclaude -n 50  # 查看最近 50 行日志
journalctl -u openclaude -f     # 实时跟踪日志
```

## 关键路径

| 路径 | 用途 |
|------|------|
| `/opt/openclaude/openclaude/` | 代码主目录 |
| `/opt/openclaude/claude-code-best/` | CCB agent 运行时 |
| `/root/.openclaude/openclaude.json` | 主配置(provider/MCP/gateway) |
| `/root/.openclaude/agents.yaml` | agent 路由配置 |
| `/root/.openclaude/agents/main/` | 默认 agent 目录 |
| `/root/.openclaude/agents/main/CLAUDE.md` | agent 人格定义 |
| `/root/.openclaude/agents/main/MEMORY.md` | agent 长期记忆 |
| `/root/.openclaude/agents/main/USER.md` | 用户画像 |
| `/root/.openclaude/agents/main/skills/` | skill 库 |
| `/root/.openclaude/uploads/` | 用户上传的文件 |
| `/root/.openclaude/generated/` | MCP 生成的媒体文件 |
| `/root/.openclaude/sessions.db` | 会话搜索索引(SQLite FTS5) |
| `/root/.openclaude/guard.py` | PreToolUse 安全钩子 |
| `/root/.openclaude/cron.yaml` | 定时任务配置 |

## 配置修改

`openclaude.json` 结构:
```json
{
  "version": 1,
  "provider": "minimax",
  "gateway": { "bind": "0.0.0.0", "port": 18789, "accessToken": "..." },
  "mcpServers": [ ... ],
  "defaults": { "model": "..." }
}
```

修改后需要 `systemctl restart openclaude` 生效。

## 故障排查

1. **服务不响应**: 查日志 `journalctl -u openclaude -n 100`
2. **MCP 工具报错**: 检查 `openclaude.json` 中的 API key 和 MCP 配置
3. **权限弹窗不出现**: 检查 `guard.py` 是否存在且可执行
4. **会话搜索无结果**: 检查 `sessions.db` 是否存在且有数据
5. **磁盘空间**: `df -h` + `du -sh /root/.openclaude/`

## 安全

- `guard.py` 作为 PreToolUse hook 拦截危险操作
- 所有危险操作弹窗让用户决定,不自动拒绝
- `/api/*` 端点需 accessToken 认证(media/file 端点除外)
