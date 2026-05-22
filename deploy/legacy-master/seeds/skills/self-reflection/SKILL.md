---
name: self-reflection
description: "定期自我反思的流程: 审视记忆质量、skill 覆盖度、用户满意度,持续改进"
version: "1.0.0"
tags: [system, meta, learning, cron]
related_skills: [skill-management, memory-management]
---

# 自我反思流程

这个 skill 指导你进行定期自我反思。可手动触发,也会被 cron 定时任务调用。

## 每日反思 (daily-reflection)

1. **回顾今日对话**
   - `session_search("*")` 查看今天的会话
   - 哪些任务完成得好?哪些遇到了困难?

2. **更新记忆**
   - `memory(action="read", target="memory")` 审视当前记忆
   - 添加今天发现的重要信息
   - 删除过时/不准确的条目

3. **检查 skill 机会**
   - 今天是否有可复用的工作模式?
   - `skill_list()` 确认是否已存在类似 skill
   - 如果没有,用 `skill_save()` 创建

4. **更新用户画像**
   - `memory(action="read", target="user")`
   - 今天是否了解到用户新的偏好或背景?

## 每周整理 (weekly-curation)

1. **skill 质量审计**
   - `skill_list()` 列出所有 skills
   - 逐个 `skill_view()` 检查是否过时
   - 更新或删除不再准确的 skills

2. **记忆精简**
   - MEMORY.md 有字符预算,确保每条记忆都有价值
   - 合并相似条目,删除琐碎信息

3. **模式识别**
   - 用户最常问什么类型的问题?
   - 有没有反复出现的工作流可以固化为 skill?

## 反思原则

- **诚实**: 承认不足,不回避失败
- **具体**: "今天在 X 场景下发现 Y 方法比 Z 更有效" > "今天学到了很多"
- **行动导向**: 每次反思至少产出一个具体改进(新 skill / 更新记忆 / 调整策略)
- **克制**: 不要为了凑数而创建低质量 skill
