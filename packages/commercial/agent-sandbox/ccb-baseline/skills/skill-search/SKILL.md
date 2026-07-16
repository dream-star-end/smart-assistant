---
name: skill-search
description: "搜索和发现当前可用 skills 的流程: 先用 skill_search 找候选,再 skill_view 加载,必要时用 skill_save 沉淀新技能"
version: "1.0.0"
tags: [system, meta, learning, discovery]
related_skills: [skill-management, memory-management]
priority: 6
---

# Skill 搜索与发现指南

当你或用户想找到“有没有现成技能能做 X”时,使用本 skill。

## 什么时候使用

- 用户问“有没有相关 skill / 技能 / SOP / 流程”。
- 你准备开始一个任务,但不确定是否已有可复用 skill。
- 完成复杂任务后,准备创建新 skill 前,先查重避免重复沉淀。
- 你只记得关键词,不记得准确 skill 名称。

## 推荐流程

1. **先搜索**: 用自然语言或关键词调用 `skill_search`。
   ```
   skill_search(query="定时任务 cron", limit=5)
   skill_search(query="wechat image vision")
   skill_search(query="部署 v3 commercial")
   ```
2. **看来源**:
   - `source=platform`: 平台基线 skill,只读、优先可信。
   - `source=user`: 用户或 agent 自建 skill,可用 `skill_save` 更新。
3. **加载候选**: 对最相关结果调用 `skill_view(name)` 阅读完整步骤。
4. **没有结果时**:
   - 换更宽泛的关键词再搜一次;或调用 `skill_list()` 浏览全部名称和描述。
   - 如果刚完成了一个可复用流程,用 `skill_save` 创建新 skill。

## 主动沉淀规则

复杂任务结束时不要等用户提醒。满足任一条件就评估是否沉淀:

- 使用了 3 次以上工具调用,并形成了稳定流程。
- 修复了一个可能复发的坑或平台/项目特定问题。
- 用户明确要求“记住这个流程”。
- 你发现现有 skill 缺少关键步骤、验证命令或注意事项。

评估顺序:

1. `skill_search(query="本次流程关键词")` 查重。
2. 已有合适 skill → 如需补充,用同名 `skill_save` 更新。
3. 没有合适 skill → 创建新 skill,内容包含触发场景、前提、步骤、验证、坑点。

## 注意事项

- 不要把一次性隐私、token、账号密钥、临时路径写入 skill。
- 不要为只发生一次且无复用价值的任务创建 skill。
- skill 名称使用小写英文和连字符,例如 `deploy-to-vps`、`fix-pdf-export`。
- 搜索结果只包含 metadata;真正执行前仍要 `skill_view(name)`。
