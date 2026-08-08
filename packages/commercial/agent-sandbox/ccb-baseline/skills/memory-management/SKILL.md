---
name: memory-management
description: "按需检索并维护 Core、Recall 与 Archival 长期记忆，避免跨项目污染和重复写入"
version: "3.0.0"
tags: [system, meta, learning]
related_skills: [skill-management]
priority: 6
---

# 记忆管理指南

## 默认原则

- Core 的 `MEMORY.md` 索引和正文**不会自动进入新会话**。
- 新的、无关的问题直接回答，不为“可能有用”搜索记忆。
- 只有当前问题依赖长期偏好、既有项目、过去决定，或用户明确要求继续/回忆时，才运行：
  `oc-memory core-search "<具体主题>" [--limit N] [--offset N]`
- 搜索结果只是有界 excerpt；需要完整内容时，按返回的绝对路径用 `Read` 的 offset/limit 分段读取。
- 用户说“忽略历史/从头开始”时，本轮不搜索、不采用、不提及记忆。
- 当前消息和当前可验证事实优先；旧记忆不得覆盖新证据。

## Core 布局与写入

- 一条记忆一个文件：`~/.openclaude/agents/<agentId>/memory/<slug>.md`。
- 索引：`~/.openclaude/agents/<agentId>/MEMORY.md`。
- **每次写 Core 前必须先用同主题 `core-search` 查重**；命中就 `Edit` 已有文件，不创建近似重复。
- 用户明确要求“记住”，或信息被明确说明为长期适用且范围清楚时才写。项目关键决定和可复用纠正也可在收尾时写；拿不准是否长期有效时留在当前会话，不写 Core。
- 不保存一次性细节、未经确认推断、易查询信息、密钥/token/密码/隐私原文。

文件格式：

```markdown
---
name: <kebab-slug>
description: <一句话召回摘要>
type: user | feedback | project | reference
---
<正文；feedback/project 写清 Why 与 How to apply>
```

写文件后，用 `Edit` 向 MEMORY.md 追加：
`- [标题](memory/<slug>.md) — 一句话钩子`。更新或删除正文时同步维护索引。

## user.md 的常驻边界

普通身份、背景、偏好和项目资料保持搜索态，不因写进 `user.md` 就自动注入。只有用户明确说某项是“默认/所有未来会话”均适用时，才把它放进**唯一一对**标记之间：

```markdown
<!-- oc-user-always:start -->
- 默认用中文回答
<!-- oc-user-always:end -->
```

不要制造多对、嵌套或残缺标记；畸形标记会 fail-closed，整块不注入。

## Recall 与 Archival

用户要求回忆过去对话时：`oc-memory session-search "<query>" [--limit N] [--summarize]`。
长篇、低频资料用 `oc-memory archival-add/search/delete`，不要塞进 Core。
