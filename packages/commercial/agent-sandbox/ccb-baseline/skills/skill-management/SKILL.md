---
name: skill-management
description: "如何创建、查看、更新和删除 skills — 自我进化的核心机制"
version: "1.0.1"
tags: [system, meta, learning]
related_skills: [memory-management, platform-capabilities]
priority: 4
---

# Skill 管理指南

Skills 是你的可复用知识库。当你完成一个复杂任务并总结出可复用的模式时,应该将其保存为 skill。

## 什么时候创建 skill

- 完成了一个多步骤的复杂任务(超过 3 步)
- 发现了一个经过验证有效的工作模式
- 用户明确要求你记住某个流程
- 踩了坑并找到了解决方案(防止再犯)

创建前先用 `skill_search(query="关键词")` 查重;已有合适 skill 时优先更新,
不要造重复名称或内容高度重合的新 skill。

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

- `skill_search(query, limit=5)` — 按名称、描述、tags、related_skills 搜索相关 skills。只返回 metadata,适合先找候选。
- `skill_list()` — 列出当前 agent 可见的完整有效目录(名称+描述)。常驻提示中的菜单可能按预算截取；菜单未展示不等于技能不存在，优先 `skill_search`，需要全目录时再 list。
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

## 有效来源与写入归属

`skill_list` / `skill_view` 返回的是**当前 agent 的有效视图**，不是把磁盘所有目录直接相加。
平台、agent seed、项目、共享库、agent 私有库和已安装 hub 可参与覆盖；
平台基线优先，同名按当前作用域去重。不要单凭目录同名就判定冲突或删除副本。

### 平台 / seed / 项目 / hub

- 平台基线通常位于 `/run/oc/claude-config/skills/`，只读；工具输出标 `[source: platform]`。
- agent seed、项目冻结技能和 marketplace hub 各受其来源、作用域和权限约束。
- `source=user` 不是“当前 agent 可以覆盖所有来源”的承诺；编辑和删除必须由工具检查当前归属。
- 不得直接编辑只读挂载，也不能用同名用户文件覆盖基线。维护平台技能应修改平台源码中的权威文件并走正式发布；普通用户请求则反馈给平台维护者，不造一个近重复技能冒充已修复。

### 用户自建技能

- 默认全能 agent（当前为 main）的 `skill_save` 写入用户共享库：`/home/agent/.openclaude/skills/<name>/`。
- 专业 agent 的共享库视图只读；其自建技能写入该 agent 的私有技能目录，通常为 `/home/agent/.openclaude/agents/<agentId>/skills/`；兼容身份按注册的私有命名空间定位。
- 默认全能 agent 还聚合其它 agent 的私有技能；专业 agent 按授权范围读取共享技能和自己的私有技能。因此 list 数量不应直接等于某一个目录的文件数。
- 存储位于持久化卷，但写权限与共享范围仍由当前 SkillStore 决定；使用 `skill_save` / `skill_delete`，不要绕过工具直接改其它 agent 的私有副本。
- 对同名副本或被平台遮蔽的残件，先核清有效来源与所属写层；删除工具如允许清理用户残件，也不会删除平台基线。被拒绝时不要换路径强删。

## 对话内训练优化 / 生成评测用例(oc-skill)

除了手动 `skill_save` 覆盖,你还能让平台在后台**基于真实使用记录训练优化**某个用户自建
skill(产出改进草稿,用户在管理中心看 diff 后决定是否合并),或**AI 生成评测用例草稿**。
入口是容器内的 `oc-skill` CLI(打本容器 gateway 自己的接口):

```
oc-skill train <name> --confirm [--focus <侧重>]   # 发起训练优化,返回 runId
oc-skill train-status <runId>                       # 查训练进度/结果
oc-skill evals-generate <name> --confirm            # 生成评测用例草稿,返回 runId
oc-skill evals-gen-status <runId>                   # 查生成进度/结果
```

只能训练/评测**用户自建 skill**(平台基线 skill 不可训练,会被判 404)。

### 使用纪律(四条,务必遵守)

1. **仅按需**:只有用户**明确要求**「优化 / 训练某技能」或「补评测用例」时才用;不要主动、
   顺手发起。
2. **先同意再发起**:`train` / `evals-generate` 会**消耗积分**。发起前必须明确告知用户这一点
   并**取得用户同意**;得到同意后才带 `--confirm` 执行。缺 `--confirm` 时 CLI 只会打印
   「需先征得同意」的提示而**不发起**——这是安全门,不要试图绕过。
3. **发起后说明**:发起成功后告诉用户「已在后台训练/生成,完成后你会收到**站内信**」,
   不必让用户干等(你也不必反复轮询,可用 `*-status` 按需查一次)。
4. **合并权在用户**:完成后引导用户到 **管理中心 → 技能 → 训练优化** 查看 diff;**是否合并
   由用户决定**,你不替用户拍板合并。
