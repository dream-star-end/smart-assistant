---
name: memory-management
description: "如何用 memdir 范式管理长期记忆:一条记忆一个文件 + MEMORY.md 索引 + user.md 用户画像,记住用户偏好和重要事实"
version: "2.0.0"
tags: [system, meta, learning]
related_skills: [skill-management]
---

# 记忆管理指南

你有跨会话保留的长期记忆。**核心记忆(Core)现在就是磁盘上的普通 Markdown 文件 ——
你直接用 `Write` / `Edit` 工具读写,不需要任何专用命令或工具调用。** 更深层的召回
(session-search / archival)仍然通过 Bash 里的 `oc-memory` CLI。

## 记忆布局(memdir 范式)

- **一条记忆 = 一个文件**:`~/.openclaude/agents/<你的 agentId>/memory/<slug>.md`,带 frontmatter。
- **MEMORY.md = 纯索引**:`~/.openclaude/agents/<你的 agentId>/MEMORY.md`,每条记忆一行链接。
  系统提示会常驻注入这份索引,让未来的你一眼看到"我记过哪些事",需要细节时再 `Read` 对应文件。
- **user.md = 用户画像**:`~/.openclaude/user.md`,记录用户长期身份/偏好,跨所有 agent 共享。

> `~` 在容器里就是 `/home/agent/.openclaude`。你的**确切绝对路径**由系统提示的 `# Memory`
> 段给出;拿不到时用 `ls -d ~/.openclaude/agents/*/` 查看,默认主助手的 agentId 是 `main`。

---

## Core 记忆:两步保存

发现值得长期记住的事实时,分两步(都用 `Write` / `Edit`):

### 第 1 步 — 写记忆文件

在 `~/.openclaude/agents/<你的 agentId>/memory/` 下新建一个文件,文件名是 kebab-case 短 slug
(只用字母/数字/`-`/`_`,例如 `vite-build-config.md`)。内容以 frontmatter 开头:

```markdown
---
name: vite-build-config
description: 项目用 Vite(非 Webpack)构建,dev server 端口 5173
type: project
---
项目根 `vite.config.ts` 里 server.port=5173;别改成 3000。
构建产物在 dist/,部署脚本 deploy.sh 直接 rsync dist。
```

**`type` 四类**(决定记忆语义,也帮未来的你分类):

| type        | 用途                                         |
| ----------- | -------------------------------------------- |
| `user`      | 用户的身份/偏好/习惯(轻量的也可写 user.md)  |
| `feedback`  | 用户对你行为的纠正/反馈(附 Why + How to apply)|
| `project`   | 项目架构/技术栈/踩坑/决策记录                |
| `reference` | 某个 API/工具/流程的用法要点                 |

`feedback` 和 `project` 类记忆,正文建议附上:

```markdown
**Why:** 用户上次因为我改了端口导致 dev server 起不来,明确要求别动。
**How to apply:** 涉及本项目端口/构建配置时,先读这条,保持 5173。
```

- **description 很关键**:它是一句话摘要,决定未来会话"要不要召回这条记忆",写清楚关键词。
- 正文没有字符预算,可以写详细。但**别把长文档塞进 Core**(见下方"臃肿内容迁 archival")。

### 第 2 步 — 把索引行加进 MEMORY.md

用 `Edit` 在 `MEMORY.md` **末尾追加一行**(不要用 `Write` 覆盖整个文件,会丢掉已有索引行):

```
- [Vite 构建配置](memory/vite-build-config.md) — 端口 5173,别改;产物在 dist/
```

- 格式固定:`- [标题](memory/文件名.md) — 一句话钩子`,**整行 ≤150 字符**。
- "钩子"是给未来的你的线索:看一眼就知道"这条讲什么、什么时候该点开读"。
- MEMORY.md 首行是自动维护的标记 `<!-- oc-memdir-index v1 -->`,**别删它**;若文件还不存在或
  首行不是这个标记,先确保首行是它,再在下面追加索引行。
- 索引由读侧自动对账自愈:文件被删了对应索引行会被清掉、漏了索引行会按 frontmatter 补上,
  所以你只要保证"新建文件时顺手加一行索引"即可,不必手工维护一致性。

---

## 何时写 / 何时不写

**硬触发(命中即本轮就写,不等收尾、不等用户要求)**:
- 用户明确陈述身份/偏好/习惯(「我喜欢…」「我不喜欢/讨厌…」「我是…」「以后都…」)→ `type: user`
- 用户明确纠正你(「不要这样做」「你错了,应该…」)→ `type: feedback`(带 Why / How to apply)

**该写**(收尾时回顾):
- 发现项目的架构特点、技术栈、目录约定
- 踩了坑并找到 workaround
- 用户做了重要决策(技术选型、命名规范、部署方式)
- 学到某个 API/工具的关键用法

**不该写**(避免记忆变噪音):
- 一次性、本轮就用完的临时信息(某个具体报错、临时路径)
- 从当前代码/文档随时能查到的东西
- 泛泛而无行动价值的话("今天学了很多")
- 会很快过时的易变状态(除非它就是要长期跟踪的事实)

拿不准时:用户亲口说的偏好与纠正永远偏向写入——写错了能删,漏掉了未来每轮都在重复犯错。

## 更新优先于新建

写之前先看索引(它就在系统提示里)。如果已有相关记忆:
- **优先 `Edit` 更新那个文件**,而不是再建一个近似的新文件 —— 避免同一主题散成多条互相矛盾。
- 主题变了、旧结论被推翻,就把旧文件的正文改掉,必要时同步更新索引行的钩子。

## 删除错误记忆

发现某条记忆过时/错误:
1. 删掉记忆文件:`rm ~/.openclaude/agents/<你的 agentId>/memory/<slug>.md`(或用工具删)。
2. 从 MEMORY.md 里 `Edit` 掉对应索引行。
读侧对账也会兜底剔除指向已删文件的索引行,但你主动清理能让索引立刻干净。

## 如何按需 Read 正文

系统提示里注入的是**索引**(只有标题 + 钩子),不是全文。当某条记忆的钩子和当前任务相关时,
用 `Read` 打开对应文件拿完整正文。例如索引里看到
`- [Vite 构建配置](memory/vite-build-config.md) — 端口 5173...`,要动构建配置前就
`Read ~/.openclaude/agents/<你的 agentId>/memory/vite-build-config.md`。

---

## user.md — 用户画像(共享)

关于用户的长期信息(身份、职业、语言/风格偏好、跨项目习惯),写进 `~/.openclaude/user.md`。
它是**纯 Markdown**,直接 `Read` / `Edit` / `Write`(单文件,可整体重写),无字符预算(注入侧有 cap)。

**何时写**:用户告诉你职业/角色;表达明确偏好(语言、代码风格、技术栈);给出跨会话通用的行为要求。

```markdown
# 用户画像
- 前端工程师,主用 React + TypeScript
- 偏好中文回复,代码注释也用中文
- 讨厌过度封装,喜欢直白的实现
```

> 轻量的用户偏好写 user.md 即可;如果是"针对某次行为的具体纠正",更适合在 agent 记忆里建
> 一条 `type: feedback` 文件(带 Why / How to apply)。

---

## session-search — 跨会话搜索(Recall)

当用户说"上次我们讨论的…""之前那个 bug"时,搜索历史会话(仍走 `oc-memory` CLI):

```sh
oc-memory session-search "部署 VPS"
oc-memory session-search "部署 VPS" --limit 8            # 多返回几条
oc-memory session-search "部署 VPS" --summarize          # 附带完整摘要
oc-memory session-search "部署 VPS" --agent-id research   # 搜另一个 agent 的会话
```

返回匹配的历史会话片段,帮你回忆上下文。

## archival — 归档记忆(容量无限,需搜索才可见)

给太长、塞进 Core 会喧宾夺主的详细知识(API 全文文档、长架构笔记、代码模式、长流程)用归档。
归档条目**不进**系统提示,必须主动搜索才能取回(仍走 `oc-memory` CLI):

```sh
oc-memory archival-add "MiniMax TTS 接口:端点 …,鉴权 …,常见坑 …" --tags "api,minimax,tts"
oc-memory archival-search "minimax tts 鉴权"
oc-memory archival-search "minimax tts 鉴权" --limit 10
oc-memory archival-delete <id>     # id 来自 archival-search 结果
```

**臃肿内容迁 archival**:Core 记忆正文本身没有硬预算,但索引会常驻注入(有注入 cap)。所以
Core 只放"高频、需要一眼看到"的事实;成篇的长知识用 `oc-memory archival-add` 归档,Core 里
最多留一条指路的短记忆(钩子写清"细节在 archival,搜 X")。

## 最佳实践

1. **主动记忆**:不要等用户要求才记。发现值得记的信息,立即写文件 + 加索引。
2. **一条一文件**:每条记忆聚焦一个主题,description/钩子写清关键词,方便日后召回。
3. **先看再写**:写前扫一眼索引,能更新就别新建(见"更新优先于新建")。
4. **及时清理**:过时/错误的记忆立刻删文件 + 删索引行。
5. **分层**:高频事实 → Core(memory/ + MEMORY.md);用户画像 → user.md;长知识 → archival。
6. **区分记忆 vs skill**:单条事实 → 记忆;可复用流程 → skill。创建 skill 前先 `skill_search` 查重。
