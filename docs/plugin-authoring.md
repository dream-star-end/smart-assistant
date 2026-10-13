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

再把命令名加进 `platform-runtime/entrypoint/entrypoint.ts` 的 `PLATFORM_LINKED_CLIS`。Agent 的 Bash 是 login shell，会重置 PATH，只有链进 `~/.local/bin` 和 `/usr/local/bin` 的命令才找得到；`ccbBaselineSkills.test.ts` 会检查这一项。

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
| `components.ui[]` | 否 | 插件专属的智能 UI 组件（见下文「智能 UI 组件」）：`{"types": ["x_card"], "path": "references/ui-x.md"}`（模型按定义写）或 `{"types": ["x_card"], "emit": "cli"}`（命令直接打印） |
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

## 智能 UI 组件：只在加载插件时进上下文（OCV5-393，所有插件都要遵守）

系统提示里的通用组件协议（INTELLIGENT_UI 段）每一轮都带，所以**插件专属组件的定义一律不放进去**。
它们只在 Agent 加载这个插件、要展示这个插件的结果时才进上下文。有两种做法：

| 做法 | 适用 | 放在哪 | 例子 |
|---|---|---|---|
| 命令直接打印组件（`emit: "cli"`） | 数据多、数字多、不能转写错的结果 | 命令加 `--ui` 输出 ```ui 块；SKILL.md 只写「原样贴」 | 同花顺 `ths quote 600519 --ui` → quote / kline / intraday / stocklist |
| 模型按定义写（`path`） | 结构简单、需要挑选和概括的结果 | 技能目录 `references/ui-<插件>.md`；SKILL.md 只留一行指引，让 Agent 用到时再读 | 微博 weibo_posts / weibo_hot，知乎 zhihu_answers / zhihu_hot，飞书 feishu_events / feishu_doc |

加一个插件组件的步骤：

1. 前端：在 `web-react/src/components/iui/` 写 schema（字段名照抄插件 JSON 结果）、渲染组件和 Markdown 转换，类型加进 `IUI_TYPES`。
2. 登记：在 `@openclaude/protocol` 的 `PLUGIN_UI_COMPONENTS`（`packages/protocol/src/pluginUi.ts`）登记 插件 → 类型 → 定义文件。
3. 定义文件：`references/ui-<插件>.md`，每个类型一行 `- <类型>：…` 加 JSON 形状，再附一个能渲染的示例块。不要超过 2.5KB。
   开头写明「没有 Intelligent UI 协议时不要写这些块」（微信、定时任务里没有这个协议）。
4. SKILL.md：加一句「要展示结果时先读 `references/ui-<插件>.md`」。不要把组件定义抄进 SKILL.md，
   也不要写进 frontmatter 的 description，因为 description 在技能列表里，每一轮都会带上。
5. 有 `plugin.json` 的插件，在 `components.ui` 里声明同一组类型。

`packages/commercial/src/__tests__/pluginUiOnDemand.test.ts` 会检查这些约定：默认上下文（通用协议、基线 AGENTS / CLAUDE、
技能描述）里不能出现插件组件；前端的每个类型要么属于通用协议，要么在登记表里恰好属于一个插件；
定义文件存在且覆盖每个类型；SKILL.md 不内联定义；清单与登记表一致。

## 各条路线的限制对照（现状，供排查用）

| 限制 | 本机插件 plugin.json | API 插件 blueprint → spec | 浏览器插件运行时工件 |
|---|---|---|---|
| 名字 | `^[a-z][a-z0-9-]{1,63}$` | spec `^[a-z]…`；发布门允许数字开头（不一致，见 FINDINGS #6） | `^[a-z]…` |
| useCases 每条 | 4–120 字 | blueprint 1–200 字，发布门 4–120 字（不一致，见 FINDINGS #5） | — |
| 动作数 | 由命令自己的子命令决定 | ≤64 | ≤32 |
| 报错 | 全部列出，带路径 | 只报第一个 | 带路径 |
