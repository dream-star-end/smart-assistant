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

## 两套 skill 来源(skill_list/skill_view 会统一合并展示)

容器里有**两套存储**,但 MCP 工具会按 baseline-wins 规则合并给你看:

### 1. 平台基线 skill(只读,权威)

claudeai.chat 容器启动时,平台通过 kernel ro bind mount 把一批基线 skill 挂进
`/run/oc/claude-config/skills/`(整目录只读,EROFS)。这些是:

- `system-info` — 容器环境/能力/守则自述
- `memory-management` — 记忆系统使用指南
- `platform-capabilities` — 多媒体和内联富内容
- `scheduled-tasks` — 定时任务创建方法
- `skill-management` — 本文件

这批 skill 在 `skill_list` 输出里标 `source=platform`,在 `skill_view` 输出顶部
也带 `[source: platform]` 标记。**只读**:`skill_save` 传相同 name 会被拒绝
(错误文案里写 "reserved for platform baseline skill"),`skill_delete` 传基线
名字也会被拒。同时 Claude Code(CCB)启动时还会从 `$CLAUDE_CONFIG_DIR/skills/`
自动扫到这批 skill 进系统 prompt,所以你启动起来就能感知它们的存在。

### 2. 用户自建 skill(可读写)

`skill_save` 写到 `/home/agent/.openclaude/agents/<agentId>/skills/`(named volume,
跨容器重启保留)。`skill_list` 里标 `source=user`,`skill_view` 顶部带
`[source: user]` 标记。

### baseline-wins 语义

- **读路径**(list / view):平台基线优先 —— 如果用户目录里碰巧有同名 skill 残留
  (比如历史版本写过),会被基线遮蔽,不会出现在 list 输出,view 也只返回基线内容。
- **清理路径**(delete):对被 shadow 的用户残件调用 `skill_delete(<baseline_name>)`
  会清掉用户这一份(note 提示"platform baseline remains"),基线本身仍然保留、仍然
  可见。纯粹基线 skill(用户目录里没同名)delete 会直接被拒。
- **写路径**(save):命中基线名字直接被拒。想要"改基线"的想法是违规的,
  写一个不同名的 skill 或者向平台团队反馈需求。
