---
name: cursor-cli
description: 仅在用户明确要求使用 Cursor 或 Cursor CLI 时，用其账号专属的官方 Cursor Agent CLI 执行一次编码、审阅或分析任务；普通编码任务不得自动调用。
tags: [cursor, cli, coding, review]
---

# Cursor CLI（账号专属）

只有用户在当前请求中**明确点名“Cursor”或“Cursor CLI”**时，才可通过 Bash 调用
`oc-cursor`。普通编码、审查或“再找一个模型看看”都不得自动调用：Cursor 会把本次提示、
相关代码和工具结果发送给 Cursor 服务，并直接消耗该用户自己的 Cursor 账户额度；这部分
不计入 OpenClaude credits。

## 调用

在要处理的项目目录运行：

```bash
oc-cursor -- "分析这个项目中的登录失败根因，只给出证据和最小修复建议"
```

需要 Cursor 实际修改当前工作区时，且用户请求本身已明确授权修改，才加 `--force`：

```bash
oc-cursor --force -- "修复已复现的测试失败，并运行最小相关测试"
```

可选固定模型或只读模式：

```bash
oc-cursor --model composer-2.5-fast --mode plan -- "审阅当前 git diff，指出阻塞问题"
```

`oc-cursor` 固定以官方 `stream-json` 输出，并原样保留该固定 CLI 版本实际发出的 NDJSON

`--model` 仅接受平台验证过的官方 CLI 型号：`cursor-grok-4.6-high`、
`composer-2.5-fast`、`claude-opus-5-thinking-high`、
`claude-fable-5-thinking-high`、`cursor-grok-4.5-high`；省略时使用 Auto。
事件（当前包括 system/user/assistant/tool_call/result，未来可能增加字段或事件）。不要把它
改成 text，也不要丢弃原始事件；成功时核对 terminal result，失败时同时看非零退出码和
stderr（失败流可能没有 terminal result）。

## 结果核验

- Cursor 的结论只是外部 Agent 输出，不是最终裁决。当前 OpenClaude Agent 必须自己检查
  `git diff`、相关文件和测试结果。
- Cursor 改文件后，继续遵守当前仓库的 worktree、测试、审查和发布规则；不得让 Cursor
  直接部署、重启、写生产数据或绕过审批。
- 命令失败、被 Stop 或额度不足时如实返回；不自动重试，避免重复外部扣费和重复副作用。
- 绝不要求 Cursor 打印环境变量、认证文件或 `/run/oc/cursor-auth`。不要把任何密钥放进
  prompt、命令参数、产物或最终回复。
- 若提示“此账号未启用”，说明该账号没有专属授权；不得寻找、复制或借用其他账号密钥。
