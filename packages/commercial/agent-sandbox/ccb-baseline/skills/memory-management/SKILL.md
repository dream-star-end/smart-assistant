---
name: memory-management
description: "如何使用 MEMORY.md 和 USER.md 进行长期记忆管理,记住用户偏好和重要事实"
version: "1.1.0"
tags: [system, meta, learning]
related_skills: [skill-management]
---

# 记忆管理指南

你有两个持久化记忆文件,跨会话保留。所有记忆操作都通过 Bash 里的 **`oc-memory` CLI** 完成
(不是 MCP 工具)。CLI 是一次性命令:调用即执行、打印结果、退出。

## MEMORY.md — 你的观察笔记

存储你在工作中发现的重要事实、模式、决策记录。

**何时写入**:
- 发现了项目的架构特点或技术栈信息
- 踩到了坑并找到了 workaround
- 用户做了一个重要决策(技术选型、偏好等)
- 学到了某个 API/工具的使用技巧

**操作**(在 Bash 里运行):
```sh
oc-memory memory --action add     --target memory --content "项目用 Vite 而非 Webpack 构建,dev server 端口 5173"
oc-memory memory --action replace --target memory --needle "旧内容片段" --content "新内容"
oc-memory memory --action remove  --target memory --needle "过时的内容片段"
oc-memory memory --action read    --target memory
```

- `--content` 是要写入的内容(add / replace 用);`--needle` 是要匹配的已有条目子串
  (replace 指定要替换的旧条目、remove 指定要删除的条目,子串必须唯一命中)。
- 写入会做 prompt-injection 扫描,可疑内容会被拒绝。

**注意**: MEMORY.md 有字符预算限制(约 2200 字符)。保持条目简洁,定期清理过时信息;
Core 满了就把详细内容迁到 Archival(见下)。

## USER.md — 用户画像

存储关于用户的长期信息:身份、偏好、习惯。

**何时写入**:
- 用户告诉你他的职业/角色
- 用户表达了明确的偏好(语言、风格、技术栈)
- 用户纠正了你的行为("不要这样做")

**操作**: 同上,把 `--target memory` 换成 `--target user`。例如:
```sh
oc-memory memory --action add --target user --content "用户是前端工程师,偏好中文回复"
oc-memory memory --action read --target user
```

## session-search — 跨会话搜索(Recall)

当用户说"上次我们讨论的..."或"之前那个 bug"时,搜索历史会话:
```sh
oc-memory session-search "部署 VPS"
oc-memory session-search "部署 VPS" --limit 8           # 多返回几条
oc-memory session-search "部署 VPS" --summarize          # 附带完整摘要
oc-memory session-search "部署 VPS" --agent-id research   # 搜另一个 agent 的会话
```
返回匹配的历史会话片段,帮你回忆上下文。

## archival — 归档记忆(Archival,容量无限,需搜索才可见)

给太长塞不进 MEMORY.md 的详细知识(API 文档、架构笔记、代码模式、长流程)。归档条目
**不在**系统提示里,必须主动搜索才能取回。
```sh
oc-memory archival-add "MiniMax TTS 接口:端点 …,鉴权 …,常见坑 …" --tags "api,minimax,tts"
oc-memory archival-search "minimax tts 鉴权"
oc-memory archival-search "minimax tts 鉴权" --limit 10
oc-memory archival-delete <id>     # id 来自 archival-search 结果
```

## 最佳实践

1. **主动记忆**: 不要等用户要求才记。当你发现值得记的信息,立即写入。
2. **简洁**: 每条记忆一行,包含关键词方便日后搜索。
3. **去重**: 写入前先 `--action read`,避免重复。
4. **定期清理**: 发现过时信息及时 `--action remove`。
5. **分层**: 高频事实 → Core(MEMORY.md/USER.md);详细知识 → Archival;Core 满了迁 Archival。
6. **区分记忆 vs skill**: 单条事实 → 记忆; 可复用流程 → skill。创建 skill 前先 `skill_search` 查重。
