---
name: manage-taskboard
description: "任务面板(oc-taskboard)的认领、推进与评论铁律。用户说「记成单 / 认领这张卡 / 推进任务 / 任务面板」或你要读写 /api/board 单据时使用。"
version: "1.0.0"
tags: [system, taskboard, oc-task]
related_skills: [scheduled-tasks, skill-management]
priority: 6
---

# 管理任务面板

任务面板是当前所有在途工作的唯一状态源。对话、巡检、CLI、MCP 共用同一套 `/api/board`。
你是面板的一等公民用户,但**人是闸门**:`backlog` 未批准不许碰,`done` 永远不属于 AI。

日常对话里一句话建单用 MCP `task_create`(会自动挂上当前会话)。
认领、推进、列单、查评论用容器内 CLI `oc-task`(单行 JSON,带 `schemaVersion`)。

## 铁律(违反会被服务端 403,不是君子协定)

1. **identifier 只用面板返回的**。形如 `OCV5-42` 由服务端生成。绝不自己拼前缀、绝不猜下一个编号。
2. **动手前必须先 `ticket get` + 看评论**。评论里可能有人的返工要求;不读就开工等于无视打回。
3. **`backlog` 是未批准状态,不许认领**。等人点「批准开工」变成 `ready` 再 claim。
4. **先 claim 拿到 lease,再读代码**。没 lease 就改文件 = 和别人(或下一轮巡检)双跑。
5. **版本冲突只重试一次**。`oc-task` 退出码 `5` = HTTP 409,重读 `ticket get` 拿新 `version` 再试一次。再 409 就停,写评论等人。
6. **禁止抢别人的 lease**。退出码 `6` = HTTP 423 `lease_held`,别人正在跑,重试无用,等。
7. **做完先写评论再 advance**。评论必须写:改了什么 / 怎么验的 / 有什么风险。然后 `advance` 进 `waiting_human`(或下一站 `ready`,由 stage.onSuccess 决定)。
8. **`done` 永远不属于 AI**。不要调 `POST …/done` / `…/approve` / `…/ready` / `…/cancel`。越权 403。

## 触发场景

- 用户说「把这个记成单 / 开一张问题单 / 记到任务面板」
- 用户说「认领 OCV5-xx / 推进这张卡 / 这单卡住了」
- 巡检或委派下来要你做当前 stage 的工作
- 你发现对话里的工作需要跨会话跟踪

## 前提

- 容器内能跑 `oc-task`(不在 PATH 时用绝对路径 `/run/oc/platform/current/bin/oc-task` 或 `~/.local/bin/oc-task`)
- MCP 工具 `task_create` / `task_update` / `task_comment` / `task_list` / `task_get` 已挂在本会话
- 不要假设环境变量 `OPENCLAUDE_GATEWAY_TOKEN` 存在;`oc-task` 会自己读 token file / `openclaude.json`

## 步骤

### A. 对话里建单(优先 MCP)

用户一句话要记单时调 `task_create`。**不要**在参数里传 `userId` / `identifier` / `originSessionKey`。
当前会话由工具从上下文写入 `originSessionKey`,卡片才能点回原对话。

```
task_create(
  projectId="OCV5",          // 项目 key 或 uuid,先 task_list / oc-task project list 确认
  type="bug",                // bug | feature | spike | chore
  title="登录 500",
  body="复现步骤与期望…",
  priority="P1"
)
```

返回里的 `ticket.identifier` 和 `ticket.version` 原样保存,后续只用这两个值。

没有 MCP 或要在 Bash 里建:

```
oc-task ticket create --project-id OCV5 --type bug --title "登录 500" --body "…" --priority P1
```

### B. 动手做一张已有的卡

1. `oc-task ticket get <identifier>`(同时带回评论)。先读 `status`、`version`、评论。
2. `status=backlog` → 停。告诉用户「还没批准,请在面板点开工」。
3. `status=running` 且不是你的 lease → 停。423/退出码 6 同理。
4. `status=ready` → `oc-task ticket claim <identifier> --expected-version <version> --owner agent:<你的 agentId>`
5. claim 成功后再读代码、改文件、跑验证。
6. `oc-task ticket comment <identifier> --body "改了什么 / 怎么验的 / 风险"`
7. `oc-task ticket advance <identifier> --expected-version <新version> --summary "一句话结论"`

claim / update / advance / block 的 `--expected-version` 必填,来自最近一次 get/claim 返回的 `ticket.version`。

### C. 受阻

被别的单挡住、连续失败、或需要人决策:

```
oc-task ticket block <identifier> --expected-version N --reason "被 OCV5-7 blocks / 连败求助"
```

`reason` 必填。不要默默停着。

### D. 更新字段(不走路状态机)

```
oc-task ticket update <identifier> --expected-version N --title "…" --priority P0
```

或 MCP `task_update(id, expectedVersion, …)`。只改字段;状态转移走 claim/advance/block。

## 验证方式

- 建单后立刻 `ticket get`,确认 `identifier` 是服务端返回的,且 `originSessionKey` 在对话建单时非空
- claim 后 `status` 必须是 `running`
- 做完后时间线上有你的评论,`status` 是 `waiting_human` 或下一站 `ready`
- 你从未把单推到 `done`

## 退出码(oc-task)

| 码 | 含义 | 你该怎么做 |
|---|---|---|
| 0 | 成功 | 读 stdout 单行 JSON 的 `schemaVersion` + 实体 |
| 2 | 参数错 | 看 stderr usage,不要重试同一个错命令 |
| 3 | 服务不可达 / token 或端口缺失 | 报告用户,不要发明 identifier 继续 |
| 4 | API 错(403/404/400/…) | 读 `error`/`code`;403 多半是越权(例如想点 done) |
| 5 | 版本冲突(409) | **只重试一次**:get → 新 version → 再发。禁止抢 lease |
| 6 | lease 被占(423) | **不要重试**。别人在跑,等或写评论说明你看到了 |

stdout 永远是**单行 JSON**,带 `schemaVersion`。不要用 `jq` 美化后再当输入。

## 常见坑

- **自己拼 `OCV5-43`**:服务端会当另一张单或 404。只用返回值。
- **没 get 就 claim**:评论里的打回意见会被你盖掉。
- **把 `backlog` 当 todo**:那是人的立项队列。
- **claim 失败还改代码**:lease 是哪张卡的互斥锁,不是礼貌。
- **409 死循环重试**:只一次。再冲突说明有并发,停。
- **423 当 409 重试**:423 重试只会打到别人的 lease,无用。
- **做完不写评论就 advance**:人在待确认收件箱里看不到你干了什么。
- **调 done/approve/ready**:403,而且破坏「人是闸门」。
- **在 MCP 参数里传 userId**:没有这个字段,自用单租户由 gateway token 定身份。
- **把旧 `/api/tasks` 或 `create_reminder` 当任务面板**:那是定时任务,不是看板。

## 命令模板

```
oc-task project list
oc-task project create --key OCV5 --name "V5 自用"

oc-task ticket list --project-id OCV5 --status ready,running,waiting_human
oc-task ticket get OCV5-42
oc-task ticket create --project-id OCV5 --type feature --title "…" --body "…"
oc-task ticket update OCV5-42 --expected-version 3 --priority P0
oc-task ticket claim OCV5-42 --expected-version 3 --owner agent:main
oc-task ticket comment OCV5-42 --body "改了 X;用 Y 验证;风险 Z"
oc-task ticket advance OCV5-42 --expected-version 4 --summary "已修,待确认"
oc-task ticket block OCV5-42 --expected-version 4 --reason "被 OCV5-7 blocks"

oc-task relation add OCV5-8 --to OCV5-7 --kind blocks
oc-task relation remove <relationId>

oc-task run list OCV5-42
oc-task run get <runId>
```

MCP 对照(对话里用;不要传 userId / identifier / originSessionKey):

```
task_list(projectId="OCV5", status="waiting_human")
task_get(id="OCV5-42")
task_create(projectId="OCV5", type="bug", title="…", body="…")
task_update(id="OCV5-42", expectedVersion=3, priority="P0")
task_comment(id="OCV5-42", body="改了什么 / 怎么验的 / 风险")
```
