# OCV5-383 FINDINGS：个人版插件定义审查

> 2026-10-12 · 外机 cc3 · 范围：V5 个人版（feat/v5-selfhost @ d20d2c5f9）。
> 操作者 13:03 CST：「让它再看下当前服务的插件定义是否有问题，我原来写插件的时候感觉定义有点乱」。
> 审查方法：只读走读源码与作者文档（git ls-files / git grep），逐条带文件:行号证据。

## 一句话结论

今天作者写一个「插件」，要在 **8 种格式**里挑一种。同一个身份字段有 4 个名字，限制和 slug 规则在前后两个阶段不一致（可能过了前一关、在后一关被拒）。**没有任何格式能描述「CLI + 技能 + 数据」这种插件**（同花顺 ths-plugin 正是这种），而 `sandboxed-local` 运行时是从没接线的死代码。

本轮定了一份统一的插件清单 **`plugin.json`（schema `openclaude-plugin/1`）**，并用同花顺插件做第一个样例。下表列出所有问题和处理方式：本轮修掉的，以及留到后续、需要和商业版同步或要迁移的。

## 1. 现有格式清单

| # | 格式 | 定义位置 | 校验方式 | 给作者的文档 | 个人版能用吗 |
|---|---|---|---|---|---|
| 1 | ConnectorSpec + SecurityDecision + 发布封套 | `commercial/src/connectors/spec/types.ts:455-477`；封套 `marketplace/publishConnectorPipeline.ts:88-211` | TypeBox，只报第一个错 | PublishPanel 文本框；`oc-market plugin examples` | 能，网页发布只认这一种 |
| 2 | plugin-blueprint-v1（紧凑写法） | `marketplace/pluginBlueprint.ts:417-589` | 手写；编译成 #1 后再校一遍 | `connector-authoring/SKILL.md` | 只能在容器 CLI 用 |
| 3 | 智能体清单 | `marketplace/agentManifest.ts:33-71` | 手写，收集全部错误 | `market/SKILL.md` | 能 |
| 4 | 技能发布（SKILL.md + 附属文件） | `marketplace/publishSkillPipeline.ts`、`protocol/src/marketplaceBundle.ts` | 手写 | `market/SKILL.md`、`skill-authoring/SKILL.md` | 能 |
| 5 | 运行时插件 v1 · managed-browser | `plugins/contracts.ts:585-733` | 手写，带字段路径 | 无（TS 常量 + seed 脚本） | 只有平台能发 |
| 6 | 运行时插件 v1 · sandboxed-local | `plugins/contracts.ts:495-583` | 手写 | 无 | **没接线** |
| 7 | sandboxed-local 包内清单 | `plugins/localSandbox.ts:242-300` | 手写 | 无 | **没接线** |
| 8 | 内置连接器 seed / v1 手写 provider | `connectors/defaults/*`、`connectors/providers/*` | 同 #1 | 无 | 只有平台能发 |

## 2. 问题清单

| # | 级别 | 问题 | 证据 | 对作者的影响 | 本轮处理 |
|---|---|---|---|---|---|
| 1 | 高 | 「插件」没有统一的名字：存储 `kind=connector`、对外 `artifactKind=plugin`、子类型 `pluginType`（3 种）、签名方案 `connector-v1`/`plugin-v2`，所有东西都存在 `marketplace_skill_listings` 表里；身份字段有 `id`/`slug`/`label`/`name`/`displayName` 几种叫法 | `protocol/src/marketplaceArtifact.ts:5-19`；`oc-market.sh:257-265`（把 `kind:"plugin"` 改写成 `connector`） | 作者要先学一套内部词汇 | **新清单只用 `name`（唯一 slug）+ `displayName`**；存储层名字后续再动 |
| 2 | 高 | 描述一个插件要写两份文档再套一层封套（spec + SecurityDecision + 封套），来源白名单还藏在「审核决定」字段里 | `PublishPanel.tsx:2082-2130` | 网页上要手写两段 JSON | 新清单把权限（`permissions.network`）写在一处；网页发布流程本轮不动（见后续） |
| 3 | 高 | 没有格式能表达「CLI + 技能 + 数据」；插件不能打包技能，技能也不能依赖插件 | `marketplaceBundle.ts:12-15`（只收文本，≤20 文件）；`marketplaceSync.ts:240-249`（脚本没有执行位、不上 PATH） | ths 这类插件没地方放 | **`plugin.json` 的 `components.skills/bin/data` + 平台启动器 `plugin-exec`**，ths 是第一个样例 |
| 4 | 高 | `sandboxed-local` 是死代码（约 1.9k 行）：运行时门面构造时没传 localRuntime，镜像表为空 | `index.ts:1715,1733`；`runtime.ts:1889-1893`；`localRuntime.ts:18-19` | 文档和 CLI 却说支持它 | `oc-plugin.sh` 删掉相关说法；删不删留给后续决定 |
| 5 | 中 | blueprint 接受的元数据，到下一阶段会被拒：useCases 1–200 字 vs 4–120 字，outcomeExamples ≤240 vs ≤200，humanMd ≤32000 vs ≤16384 | `pluginBlueprint.ts:458-582` vs `marketplaceMeta.ts:45-50` | 改好 blueprint 后又报 `BAD_USE_CASES` | 新清单直接用 4–120 字；blueprint 对齐留到后续（会改发布门） |
| 6 | 中 | slug 规则不一致：发布门和网页表单允许数字开头，spec / blueprint / 运行时要求字母开头 | `publishConnectorPipeline.ts:22`、`PublishPanel.tsx:278` vs `types.ts:28`、`pluginBlueprint.ts:12` | `1x-api` 先过了再被拒 | 新清单统一为 `^[a-z][a-z0-9-]{1,63}$`；旧管线留到后续 |
| 7 | 中 | 其它限制也不一致：动作数 64 / 32 / 16，描述长度 2000 / 512 / 1000，副作用种类不同 | `types.ts:473`、`contracts.ts:446`、`localSandbox.ts:255` | 换个格式就踩不同的坑 | 写进 `docs/plugin-authoring.md` 汇总表 |
| 8 | 中 | 静默截断或丢弃：标签被截、非法标签被丢、默认标签不一致（「插件」vs「API插件」）、技能 frontmatter 被重建时丢掉 priority | `publishSkillPipeline.ts:105,199-208`、`agentManifest.ts:250-256`、`pluginBlueprint.ts:466` | 发布后内容和写的不一样 | 新清单只拒不改（多写的字段、超长都报错）；默认标签已在 OCV5-379 统一为「插件」 |
| 9 | 中 | 报错不好用：一次只报一个错、正则原文、不带动作 id；blueprint 的报错指向编译生成的 spec，而不是作者自己写的文件；运行时只说「params are invalid」 | `compiler.ts:216-219,651,670` | 改一处、跑一次、再改一处 | **新校验器一次收集全部错误，每条带字段路径和中文修改建议**（`formatPluginManifestErrors`） |
| 10 | 中 | schema 接受但永远会失败的字段：`requestTransform` 等（白名单为空）、`hmac-signing`/`oauth1a` | `types.ts:428-430`、`compiler.ts:58` | 写了以为能用 | 文档注明；删字段留到后续 |
| 11 | 中 | 网页发布不做 prepare（只看 JSON 能不能解析），CLI 会给权限摘要并要求确认 | `PublishPanel.tsx:1913-1930` | 两条路体验不同 | 后续 |
| 12 | 低 | `oc-market --help` 列出已禁用的 `publish-connector` | `oc-market.sh:12,376-380` | 照着帮助试了才知道不能用 | **已从帮助里去掉**（保留它的跳转提示） |
| 13 | 低 | 残留旧路径「管理中心 → 插件账号」 | `connector-authoring/SKILL.md:48`、`market/SKILL.md:93`、`app-connectors/SKILL.md:162` | Agent 会指错路 | **已改成「管理中心 → 插件」** |
| 14 | 低 | 存的是展开后的 spec 而不是 blueprint，更新插件要凭记忆重写 | `internalMarketplaceAgent.ts:576` | 很难迭代 | 后续（存原始清单） |
| 15 | 低 | `oc-plugin` 帮助说支持 sandboxed-local | `oc-plugin.sh:2` | 误导 | **已改** |

## 3. 新定义：`plugin.json`（openclaude-plugin/1）

- **校验器**：`packages/protocol/src/pluginManifest.ts`。纯函数、零依赖，master、测试、前端共用同一份。
- **校验规则**：不认识的字段、超长、格式不对都报错，一次全部报出，每条带路径和怎么改；只拒不改。
- **组件**：本版接通 `skills` / `bin` / `data`，也就是在容器里运行的本机插件。`http` / `browser` 先占位，写了会明确报「暂不支持，请先用 AI 市场发布流程」。
- **样例**：`ccb-baseline/skills/ths/plugin.json`（同花顺行情）。
- **作者文档**：`docs/plugin-authoring.md`。

| 字段 | 含义 |
|---|---|
| `schema` | 固定写 `"openclaude-plugin/1"` |
| `name` | 唯一 slug，也是目录名；同时是启用开关、偏好、日志里用的键 |
| `version` / `displayName` / `description` / `author` / `license` / `homepage` | 展示与归属 |
| `category` / `tags` / `useCases` | AI 市场分类与「可以这样用」；`useCases` 每条 4–120 字，与市场一致 |
| `components.skills[]` | `SKILL.md` 路径：教 Agent 什么时候用、怎么用 |
| `components.bin[]` | 命令名、`entry`（必须在 `scripts/` 下）、`interpreter`（只支持 python3）。平台为每个命令放一个 2 行 shim，经启动器先查启用状态再运行 |
| `components.data[]` | 随包数据（必须在 `references/` 下） |
| `auth` | `mode`，以及可选的 `login{optional, kind, description, start}`；`start` 是「在对话中登录」按钮预填的话 |
| `permissions` | `network` 来源白名单、`writes` 写操作清单、`userInteraction`（如需要用户提供短信验证码） |
| `disclaimer` | 数据声明，带版本号 |
| `compat` | 最低运行环境（用 python3 时必填） |

## 4. 本轮一起落地的配套

- **启用开关**：存在 `user_preferences.prefs.disabled_plugins`。停用后各路径都不能再调用它：
  - 容器 RPC 的 list / catalog 隐藏，call 和确认执行拒绝；
  - 运行时门面 `loadManagedTarget` 统一收口；
  - 知识星球自动回复调度跳过并顺延，不暂停规则；
  - 本机插件由 `plugin-exec` 启动器拦截。
- **基线守卫**：三处同步只多允许一个根目录 `plugin.json`（普通文件、≤64KB、JSON 可解析），并新增单测，用校验器逐个检查清单。
- **master `GET /api/plugins/local`**：读基线里的清单，附带当前用户的启用状态，供插件列表和 AI 市场使用。

## 5. 后续（本轮不做，原因）

这些都会改动发布门、共享代码或数据库，需要和商业版同步（两树），或者要先由 operator 定方向：

1. 网页发布接受 `plugin.json`，与 blueprint 一起编译进现有管线；blueprint 的限制改为直接引用 `marketplaceMeta` 常量；slug 规则统一到发布门。
2. `marketplaceSync` 支持 `bin/` 和 `data/` 前缀、执行位和 PATH shim，让市场安装的插件也能带 CLI；扩展 `0152` 依赖表，支持技能声明依赖插件。
3. 存储层改名（`kind=connector` → `plugin`），以及新增 `pluginType: container-cli`（需要迁移）。
4. 删除 `sandboxed-local` 死代码，或者把它的 `actions` 结构作为 bin 子命令的声明格式。
5. 写入免责声明从按 slug 写死的 `writePolicy.ts` 移进清单的 `disclaimer`。
6. 存原始清单，而不是展开后的 spec。
