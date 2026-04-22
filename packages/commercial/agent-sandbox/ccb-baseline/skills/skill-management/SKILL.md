---
name: skill-management
description: "如何创建、查看、更新和删除 skills — 自我进化的核心机制"
version: "1.0.0"
tags: [system, meta, learning]
related_skills: [memory-management, platform-capabilities]
---

# Skill 管理指南

Skills 是你的可复用知识库。当你完成一个复杂任务并总结出可复用的模式时,应该将其保存为 skill。

## 什么时候创建 skill

- 完成了一个多步骤的复杂任务(超过 3 步)
- 发现了一个经过验证有效的工作模式
- 用户明确要求你记住某个流程
- 踩了坑并找到了解决方案(防止再犯)

## 如何创建 skill

```
skill_save(
  name: "deploy-to-vps",              // 小写+连字符,最长 64 字符
  description: "部署代码到 VPS 的完整流程",  // 简短描述,最长 1024 字符
  body: "## 步骤\n1. ...\n2. ..."      // Markdown 正文: 步骤、注意事项、示例
)
```

### 好的 skill 结构

```markdown
## 前提条件
- 需要什么环境/工具/权限

## 步骤
1. 具体操作步骤
2. 包含实际命令或代码

## 注意事项
- 常见坑点
- 边界条件

## 示例
- 成功案例参考
```

## 查看和使用 skill

- `skill_list()` — 列出所有 skills(名称+描述)。每次会话开始时,所有 skill 的名称和描述已在你的 system prompt 中。
- `skill_view(name)` — 加载完整内容。当你要执行一个与已有 skill 相关的任务时,先 view 获取完整指令。

## 更新 skill

再次调用 `skill_save()` 并传入相同的 name,会覆盖旧版本。在以下场景更新:
- 发现 skill 中的步骤过时了
- 找到了更好的做法
- 需要补充新的注意事项

## 删除 skill

- `skill_delete(name)` — 当 skill 已过时或不再需要时删除

## 命名规范

- 全小写,单词用连字符分隔: `deploy-to-vps`, `fix-css-layout`
- 动词开头表示操作类: `generate-video`, `search-sessions`
- 名词开头表示知识类: `minimax-api-quirks`, `css-grid-patterns`
- 以 `system-` 前缀标记平台内置 skill(不要删除这些)

## 两套 skill 来源(不要混淆)

容器里有**两套独立 skill 机制**,走不同的路径、不同的工具:

### 1. 平台基线 skill(只读,Claude Code 直接加载)

claudeai.chat 容器启动时,平台通过 kernel ro bind mount 把一批基线 skill 挂进
`/run/oc/claude-config/skills/`(整目录只读,EROFS)。这些是:

- `system-info` — 容器环境/能力/守则自述
- `memory-management` — 记忆系统使用指南
- `platform-capabilities` — 多媒体和内联富内容
- `scheduled-tasks` — 定时任务创建方法
- `skill-management` — 本文件

基线 skill **不进 `skill_list` / `skill_view`**。Claude Code(CCB)启动时直接从
`$CLAUDE_CONFIG_DIR/skills/` 扫这批 skill,它们是 system-prompt 层面的能力,
对基线路径的写操作都会被 kernel 拒,`skill_delete` 也删不掉。

### 2. OpenClaude SkillStore(可读写,`skill_save` / `skill_list` / `skill_view`)

`skill_save` 写到 `/home/agent/.openclaude/agents/<agentId>/skills/`(named volume,
跨容器重启保留,用户容器内读写没问题)。`skill_list` / `skill_view` / `skill_delete`
**只看这条路径**,不跨界读基线挂载点。

所以:
- 要用户读到"基线 skill 做什么",引导他们看 `/run/oc/claude-config/skills/<name>/SKILL.md`
- 要保存自己总结的新 skill,用 `skill_save(...)` —— 它会进 SkillStore,下次对话前自动出现在 system prompt
