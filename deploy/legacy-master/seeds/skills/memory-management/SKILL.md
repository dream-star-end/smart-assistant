---
name: memory-management
description: "如何使用 MEMORY.md 和 USER.md 进行长期记忆管理,记住用户偏好和重要事实"
version: "1.0.0"
tags: [system, meta, learning]
related_skills: [skill-management]
---

# 记忆管理指南

你有两个持久化记忆文件,跨会话保留:

## MEMORY.md — 你的观察笔记

存储你在工作中发现的重要事实、模式、决策记录。

**何时写入**:
- 发现了项目的架构特点或技术栈信息
- 踩到了坑并找到了 workaround
- 用户做了一个重要决策(技术选型、偏好等)
- 学到了某个 API/工具的使用技巧

**操作**:
```
memory(action="add", target="memory", text="MiniMax coding plan 仅支持 speech-2.8-hd 模型")
memory(action="replace", target="memory", old_text="旧内容", text="新内容")
memory(action="remove", target="memory", text="过时的内容")
memory(action="read", target="memory")
```

**注意**: MEMORY.md 有字符预算限制(约 2200 字符)。保持条目简洁,定期清理过时信息。

## USER.md — 用户画像

存储关于用户的长期信息:身份、偏好、习惯。

**何时写入**:
- 用户告诉你他的职业/角色
- 用户表达了明确的偏好(语言、风格、技术栈)
- 用户纠正了你的行为("不要这样做")

**操作**: 同上,但 `target="user"`

## session_search — 跨会话搜索

当用户说"上次我们讨论的..."或"之前那个bug"时:
```
session_search(query="部署 VPS")
```
返回匹配的历史会话片段,帮你回忆上下文。

## 最佳实践

1. **主动记忆**: 不要等用户要求才记。当你发现值得记的信息,立即写入。
2. **简洁**: 每条记忆一行,包含关键词方便日后搜索。
3. **去重**: 写入前先 read,避免重复。
4. **定期清理**: 发现过时信息及时 remove。
5. **区分记忆 vs skill**: 单条事实 → 记忆; 可复用流程 → skill。
