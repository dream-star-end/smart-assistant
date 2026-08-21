# Codex 0.144.0 `requestUserInput` 协议取证

取证日期：2026-07-16。本文只描述当前 v5 商业版宿主实际安装的 Codex
0.144.0，不把后续版本的协议假设带入实现。

## 结论

- server-initiated method 的准确名称是 `item/tool/requestUserInput`。
- 请求参数类型是 `ToolRequestUserInputParams`；必需字段为 `threadId`、
  `turnId`、`itemId`、`questions`。`autoResolutionMs` 在线上 TypeScript 类型中为
  `number | null`，JSON Schema 允许字段缺省并以 `null` 为默认值。
- 每个问题有 `id`、`header`、`question`、`isOther`、`isSecret`、`options`。
  `options` 是 `{ label, description }[] | null`。
- 0.144.0 请求中没有 `multiSelect` 字段。模型侧 tool schema 把选项定义为互斥；
  OpenClaude 映射时固定使用既有 AskUserQuestion 的 `multiSelect: false`。
- response 是 `{ answers: { [questionId]: { answers: string[] } } }`。key 是稳定的
  question `id`，不是问题文本。
- 拒绝、RPC 异常或生命周期清理使用 schema-valid 的 `{ answers: {} }`，表示没有
  用户答案；不能返回新造的 `decision` 字段。

## 二进制与 schema 证据

实际二进制：

```text
/usr/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex
codex-cli 0.144.0
```

执行过的关键命令：

```bash
strings /usr/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex

/usr/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex \
  app-server generate-json-schema --experimental --out /tmp/codex-0144-schema

/usr/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex \
  app-server generate-ts --experimental --out /tmp/codex-0144-ts
```

`strings` 可见 `requestUserInput`、`ToolRequestUserInputParams`、
`ToolRequestUserInputResponse` 等符号。二进制生成的 `ServerRequest` 联合类型把该
方法固定为：

```ts
{
  method: "item/tool/requestUserInput"
  id: RequestId
  params: ToolRequestUserInputParams
}
```

二进制生成的请求/响应类型是：

```ts
type ToolRequestUserInputParams = {
  threadId: string
  turnId: string
  itemId: string
  questions: Array<{
    id: string
    header: string
    question: string
    isOther: boolean
    isSecret: boolean
    options: Array<{ label: string; description: string }> | null
  }>
  autoResolutionMs: number | null
}

type ToolRequestUserInputResponse = {
  answers: { [questionId: string]?: { answers: string[] } }
}
```

补充核对了官方仓库精确标签 `rust-v0.144.0`。模型-facing tool 名称是
`request_user_input`，每题必须有非空 options；归一化会把 `isOther` 设为 true。
`autoResolutionMs` 只用于可非阻塞地继续执行的问题，归一化范围为 60,000–240,000
ms。默认只在 Plan mode 可用；启用相应 feature 后也可在 Default mode 暴露。

## 同版本 round-trip 原始样本

下面请求按 0.144.0 官方 app-server round-trip fixture 的实际问题数据与该版本生成
schema 展开。app-server 的 stdio transport 是 JSONL，并按其 README 省略
`"jsonrpc":"2.0"` header：

```json
{"method":"item/tool/requestUserInput","id":17,"params":{"threadId":"<thread-id>","turnId":"<turn-id>","itemId":"call1","questions":[{"id":"confirm_path","header":"Confirm","question":"Proceed with the plan?","isOther":true,"isSecret":false,"options":[{"label":"Yes (Recommended)","description":"Continue the current plan."},{"label":"No","description":"Stop and revisit the approach."}]}],"autoResolutionMs":60000}}
```

fixture 的客户端响应是：

```json
{"id":17,"result":{"answers":{"confirm_path":{"answers":["yes"]}}}}
```

OpenClaude 的 writer 保留现有实现习惯，会额外带标准
`"jsonrpc":"2.0"` header；0.144.0 parser 接受该 header。无答案响应为：

```json
{"jsonrpc":"2.0","id":17,"result":{"answers":{}}}
```

app-server 在响应后发送 `serverRequest/resolved`。同版本 README 还明确：turn start、
turn completion 或 interrupt 清理 pending request 时也会发送该 notification。

## Live app-server 验证范围

按任务给出的 `CODEX_HOME=/root/codex-goal-probe.R3TgSa` 取现有配置；由于该目录在
本工作区只读，先完整复制到 `/tmp/codex-goal-probe-live.zlDeJ3`，然后用上面的准确
二进制启动 `codex app-server --listen stdio://`。

本次真实交互结果：

```text
initialize(experimentalApi=true) -> success
thread/start -> thread.id = 019f6c11-0854-7c41-b6f6-8bebf2fcdcc1
turn/start(Plan mode) -> turn.id = 019f6c11-5a08-70b1-bbd6-d8d8b3f1129d
upstream model transport -> HTTP/WebSocket 401: Missing bearer authentication
turn/completed -> failed (26271 ms)
```

因此这次 live 环境没有成功运行模型，也就不能让模型现场发出
`request_user_input`。准确 method/schema 由同一实际二进制的生成器确定；原始请求与
response 形状再由同版本官方 round-trip fixture 交叉验证。实现和测试均按该 method
注册，不声称拿到了本次 live 的反向请求抓包。

## OpenClaude 映射

不引入 Codex 专用前端模型。runner 把请求投影为现有 CCB `control_request` 入口：

```text
tool_name  = AskUserQuestion
tool_use_id = Codex itemId
input.questions[*].question/header/options = Codex 同名字段
input.questions[*].multiSelect = false
```

既有浏览器响应的 `answers` 以问题文本为 key；runner pending 表保留
`question text -> question id` 对照，回写时转换为 Codex 以 id 为 key 的 response。
`annotations` 仍可通过现有白名单校验，但 0.144.0 response schema 没有 annotation
字段，因此不会透传给 app-server。其他未知 server request 继续返回 `-32601`。

## 2026-08-21：Codex 0.149.0 升级补充

0.149.0 的实际二进制（SHA-256
`bbc3341e44c9ead340ed9570c17be936e37870f570751a941699ffd04d672827`）重新执行同一
`generate-json-schema --experimental` 命令后，`ToolRequestUserInputParams` 新增必需
布尔字段 `isBlocking`；`autoResolutionMs` 仍可出现，但 schema 已标为 deprecated。
`turn/steer` 的必需字段保持 `expectedTurnId`、`input`、`threadId`，同时 UserInput
联合类型新增 `audio` 与 `localAudio`。

OpenClaude 的兼容矩阵固定为：

- `isBlocking: true`：不向平台提问卡附带自动结束时间；合法的旧
  `autoResolutionMs` 不改变阻塞语义。
- `isBlocking: false`：保留 60,000–240,000 ms 的合法值；缺省/null 时使用平台最小值
  60,000 ms。
- `isBlocking` 缺省：按 0.144.0 兼容路径处理；数字 duration 表示自动结束，缺省/null
  表示阻塞。
- 非布尔 `isBlocking`、非整数或越界 duration 返回 JSON-RPC `-32602`，不打开提问卡。

字节级证据在
`packages/gateway/src/__tests__/fixtures/codex-app-server-0.149.0/`，同时保留 0.144.0
fixture 作为旧请求兼容与历史错误契约。
