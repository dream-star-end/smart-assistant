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
