# 写一个插件（V5 个人版）

> OCV5-383 · 适用于 V5 个人版。问题背景见 `docs/plans/ocv5-383-plugin-definition-findings.md`。

## 先选路线

| 你要做的插件 | 路线 | 在哪里写 |
|---|---|---|
| 一个在用户容器里跑的命令行工具 + 教 Agent 用它的说明（如同花顺行情） | **本机插件**：`plugin.json`（openclaude-plugin/1） | 平台基线 `ccb-baseline/skills/<name>/` |
| 调用一个 HTTP API（GitHub、Notion 一类，凭据由平台托管） | **API 插件** | AI 市场 → 发布 → 插件（或容器里 `oc-market plugin prepare`），写 plugin-blueprint-v1 |
| 驱动浏览器操作某个网站（微博、知乎一类） | **浏览器插件** | 目前只有平台能发 |
| 只是一套做法、没有自己的工具 | **技能** | AI 市场 → 发布 → 技能 |

## 本机插件：目录结构

```
ccb-baseline/skills/<name>/
├── plugin.json          # 插件清单（必须）
├── SKILL.md             # 教 Agent 什么时候用、怎么用（必须）
├── scripts/<entry>.py   # 命令入口（components.bin[].entry 必须在 scripts/ 下）
└── references/          # 随包数据、许可证、上游说明（components.data[].path 必须在这里）
```

基线目录对每个技能目录有白名单，只允许 `SKILL.md`、`plugin.json`、`evals/`、`references/`、`scripts/`，不能有符号链接。把新目录名加进 `V3_CCB_BASELINE_SKILL_NAMES`（`v3supervisor.ts`）和 `scripts/v5-baseline-security.sh` 的 `EXPECTED_SKILLS`；`ccbBaselineSkills.test.ts` 会检查两边一致，以及清单是否合法、文件是否齐全。

每个命令还要在 `platform-runtime/bin/<命令名>.sh` 放一个 2 行 shim：

```sh
#!/bin/sh
exec "$(dirname "$(readlink -f "$0")")/plugin-exec" <插件名> <命令名> "$@"
```

`plugin-exec` 依次做三件事：

1. 读清单，确认命令入口在插件目录内；
2. 问 master 用户是否已在「管理中心 → 插件」停用这个插件，停用则退出码 3 并给出中文提示；
3. 用 `python3 -I` 运行入口。

## `plugin.json` 字段

完整样例见 `ccb-baseline/skills/ths/plugin.json`。

| 字段 | 必填 | 规则 |
|---|---|---|
| `schema` | 是 | 固定 `"openclaude-plugin/1"` |
| `name` | 是 | `^[a-z][a-z0-9-]{1,63}$`，与目录名相同 |
| `version` | 是 | `N.N.N` |
| `displayName` | 是 | 1–40 字，用户看到的名字 |
| `description` | 是 | 10–400 字 |
| `author` | 是 | `{"name": "…", "url": "https://…"}` |
| `license` / `homepage` | 否 | homepage 必须是 https |
| `category` | 否 | AI 市场分类 id（如 `finance-business`、`daily-tools`） |
| `tags` | 否 | ≤8 个，每个 1–20 字 |
| `useCases` | 否 | ≤4 条，每条 4–120 字。会显示在详情页「可以这样用」，点一下会在新对话里预填 |
| `components.skills[]` | 至少一项 skills 或 bin | `{"path": "SKILL.md"}` |
| `components.bin[]` | 同上 | `{"name": "命令名", "entry": "scripts/x.py", "interpreter": "python3", "description": "…"}` |
| `components.data[]` | 否 | `{"path": "references/…", "description": "…"}` |
| `auth.mode` | 否 | `none`（默认）、`static-token`、`oauth2-auth-code`、`token-exchange`、`browser-session` |
| `auth.login` | 否 | `{"optional": true, "kind": "sms-code", "description": "…", "start": "帮我登录…"}`。`start` 是「在对话中登录」按钮预填的话 |
| `permissions.network` | 是 | 会访问的来源，如 `"https://api.example.com"`（不带路径）；不访问网络就写 `[]` |
| `permissions.writes` | 否 | 会改动用户数据的操作 `{"id", "description"}`；Agent 执行前要向用户确认 |
| `permissions.userInteraction` | 否 | `sms-code`、`qr-scan`、`confirm-each-write` |
| `disclaimer` | 否 | `{"version": 1, "text": "…"}`；改了文字就把版本加 1 |
| `compat.python` | 用 python3 时必填 | `">=3.8"` |

校验器是 `@openclaude/protocol` 的 `parsePluginManifest`，一次返回全部问题，每条带字段路径和怎么改。不认识的字段会报错，不会被悄悄忽略。

## 给 Agent 的说明（SKILL.md）

- 写清楚**什么时候用**（frontmatter `description` 里列出用户会说的话）和**每个命令的用法**。
- 写清楚**拿不到什么**，要求 Agent 拿不到就直说，绝不编造。
- 如果命令能输出智能 UI 块（`--ui`），要求 Agent **原样**把块贴进回答、不改数字；只有在系统提示里有 Intelligent UI 协议时才贴，否则写 Markdown 表格。
- 需要用户配合的步骤（登录、验证码）写成分步说明，并告诉 Agent 哪些步骤由它自己完成、哪些需要问用户。

## 各条路线的限制对照（现状，供排查用）

| 限制 | 本机插件 plugin.json | API 插件 blueprint → spec | 浏览器插件运行时工件 |
|---|---|---|---|
| 名字 | `^[a-z][a-z0-9-]{1,63}$` | spec `^[a-z]…`；发布门允许数字开头（不一致，见 FINDINGS #6） | `^[a-z]…` |
| useCases 每条 | 4–120 字 | blueprint 1–200 字，发布门 4–120 字（不一致，见 FINDINGS #5） | — |
| 动作数 | 由命令自己的子命令决定 | ≤64 | ≤32 |
| 报错 | 全部列出，带路径 | 只报第一个 | 带路径 |
