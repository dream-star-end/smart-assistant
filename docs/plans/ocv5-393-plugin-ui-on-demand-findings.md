# OCV5-393 FINDINGS：插件智能 UI 组件怎么进上下文，以及怎么改成按需加载

> 2026-10-13 · 外机 · 范围：V5 个人版（feat/v5-selfhost @ fe489dedf）。商业版不动。
> 用户 11:24 CST：「给每个插件适配对应的智能 UI 组件（同花顺、知乎、微博、飞书等）。组件不默认放进上下文，
> 只在 agent 加载某插件时才加载它对应的组件定义。……这条规则以后所有插件都要遵守。」
> 方法：只读走读源码（文件:行号见下），再用真实回合实测 token（uid 3，box-claude-haiku-5-5，cc2 登录，
> 会话 g48mtmv651uo7，usage_records 23299–23306）。

## 一句话结论

现在**没有任何插件组件的定义在默认上下文里**，同花顺的行情组件是由 `ths --ui` 命令直接打印的。
但这只是 OCV5-383 做同花顺时的个案处理，不是规则：没有登记、没有守卫，微博、知乎、飞书也没有专属组件。
如果照通用组件的做法把它们写进系统提示，每个回合都要多付约 1.6k token。

本单把它定成规则并落地：
- 插件组件的定义放在插件自己的技能目录里（`references/ui-<插件>.md`），只在 Agent 要展示这个插件的结果时才读；
- 一张登记表（插件 → 组件类型 → 定义文件），加一个守卫测试，以后的插件不登记、或者把定义写进默认上下文，单测就会变红。

## 1. 现在组件怎么进上下文

| 内容 | 怎么进上下文 | 什么时候 | 证据 |
|---|---|---|---|
| 通用组件协议（table / chart / stats / cards …，24 种） | master `resolveIntelligentUiSlot` → `GET /internal/v3/platform-prompt-slots` → 容器 gateway 拼进 extra-prompt 的 `INTELLIGENT_UI` 段 | **每一轮**（总开关开、用户没关） | `commercial/src/intelligentUi/index.ts:76-146`、`http/internalPlatformPromptSlots.ts:246-252`、`gateway/src/promptSlots.ts:1850-1875` |
| 输入预测（`next` 块） | 同一个 slot 的第二段 | 每一轮 | `intelligentUi/index.ts:113-126` |
| 同花顺行情组件 quote / kline / intraday / stocklist | **不进提示**。`ths … --ui` 直接打印 ```ui 块，模型原样转贴；怎么用 `--ui` 写在 ths 的 SKILL.md 里 | 加载 ths 技能时（Skill 工具，「Launching skill: ths」） | `ccb-baseline/skills/ths/SKILL.md:38-48`；`__tests__/intelligentUi.test.ts`（OCV5-388 起要求通用协议不出现行情类型） |
| 微博 / 知乎 / 飞书 | **没有专属组件**。app-connectors 的 SKILL.md 只写 action 用法，模型拿到 JSON 后自己挑通用组件（实测：微博热搜→table，知乎回答→stats + cards） | 加载 app-connectors 技能时 | `skills/app-connectors/SKILL.md`；本单 before 回合 g393-u3-before-{weibo,zhihu,feishu}.log |
| 技能列表（每个技能的 frontmatter 描述） | CCB 原生技能列表 + extra-prompt `# Skills (N)` 段 | 每一轮 | `extra-prompt.md` 实例：uid 3 有 323 个技能、14.5KB |

前端：```ui 块由 `web-react/src/components/iui/` 解析、校验、渲染；未知类型退回原文或列表，不会让消息崩溃（`IuiBlock.tsx`）。

## 2. 默认占多少 token（实测）

uid 3，box-claude-haiku-5-5（cc2），live fe489dedf，同一会话里连续 3 轮。表里的 prompt 等于 input + cache_read + cache_write，取每轮第一次请求的值。

| 项 | prompt token | 增量 | 说明 |
|---|---:|---:|---|
| 默认上下文（第 1 轮「你好」） | **69,872** | — | 含 Claude Code 系统提示、工具定义、extra-prompt（其中 INTELLIGENT_UI 段 8,000 B + 输入预测 900 B）、技能列表 |
| 加载 ths 技能 | 72,935 | **+3,014** | ths SKILL.md 6,871 B（含 `--ui` 用法 1.2KB） |
| 加载 app-connectors 技能 | 77,638 | **+4,648** | app-connectors SKILL.md 11,359 B（微博 / 知乎 / 飞书 / 知识星球 / 邮件 … 全部 action） |

按 ths 的实测比例（6,871 B ≈ 3.0k token，约 2.3 B/token）估算：每轮都带的 INTELLIGENT_UI 段 + 输入预测约 **3.9k token**，
其中插件专属组件的定义是 **0**。

如果把本单的 6 个插件组件（微博 2、知乎 2、飞书 2）照通用组件的写法放进 INTELLIGENT_UI 段，
三个定义文件合计约 4.0KB，也就是**每轮多约 1.6k token**，不管这一轮用不用这些插件。插件越多，这部分越大。

## 3. 问题

| # | 问题 | 影响 |
|---|---|---|
| 1 | 「插件组件不进系统提示」只靠 OCV5-388 的一条测试守着同花顺的 4 个类型（它读 `marketSchema.ts` 里的类型名），换一个插件就不管了 | 下一个插件很容易照通用组件的做法写进系统提示，每轮都要付这部分 token |
| 2 | 没有登记表：前端的某个组件类型属于哪个插件、定义写在哪里，没有地方能查 | 无法检查「定义只在加载插件时进上下文」 |
| 3 | 微博 / 知乎 / 飞书没有专属组件，模型只能用 table / cards 拼 | 体验不一致：热搜的热度、认证标记、赞同数、日程按天分组都没有 |
| 4 | app-connectors 是一个大技能，加载一次就是 +4.6k token，涵盖 8 个插件 | 如果把三个插件的组件定义直接写进它的 SKILL.md，只用微博的人也要多付知乎和飞书的定义（约 1.1k token） |
| 5 | 基线技能目录只允许 `SKILL.md / plugin.json / evals / references / scripts`（三处同步守卫） | 定义文件不能另开 `ui/` 目录，否则同步时会被拒；只能放在 `references/` |
| 6 | `plugin.json`（openclaude-plugin/1）没有地方声明组件 | 带清单的插件（同花顺）无法在清单里说明自己产出哪些组件 |

## 4. 按需加载设计（本单实现）

```
默认上下文（每轮）      通用组件协议：24 种通用组件；不含任何插件组件 ← 守卫测试
                        技能列表：只有描述，不含组件 ← 守卫测试
加载插件技能（Skill）   ths：SKILL.md 写「--ui 原样贴」（组件由命令打印，emit: cli）
                        app-connectors：SKILL.md 多一段 6 行的指引（约 +0.3k token）
要展示某插件结果时      Read references/ui-weibo.md | ui-zhihu.md | ui-feishu.md（各约 0.55k token，只读用到的那一个）
```

1. **登记表** `@openclaude/protocol` 的 `PLUGIN_UI_COMPONENTS`（`packages/protocol/src/pluginUi.ts`）：
   同花顺（cli：quote / kline / intraday / stocklist）、微博（weibo_posts / weibo_hot）、知乎（zhihu_answers / zhihu_hot）、
   飞书（feishu_events / feishu_doc）。
2. **定义文件** `ccb-baseline/skills/app-connectors/references/ui-{weibo,zhihu,feishu}.md`：每个类型一行 JSON 形状，
   字段名直接沿用插件结果里的名字（authorName / likeCount / searches[].keyword / events[].startTime），
   模型照抄就行，不用改写数字；另附一个示例块。放在 `references/` 是因为基线同步守卫只允许这个目录（问题 5），守卫不用改。
3. **SKILL.md 指引**（app-connectors）：「在网页对话里要展示其中某个插件的结果时，先用 Read 读对应的定义文件，
   每个对话读一次即可」。没有 Intelligent UI 协议时（微信、定时任务）不读也不写。
4. **清单** `plugin.json` 加 `components.ui[]`：`{"types", "path": "references/ui-*.md"}` 或 `{"types", "emit": "cli"}`。
   二者必须且只能写一个；path 不能是 SKILL.md。同花顺清单声明 `emit: cli`。
5. **前端组件**（`web-react/src/components/iui/pluginSchema.ts`、`PluginBlocks.tsx`、`pluginMarkdown.ts`）：
   - 微博动态：作者、认证、长文折叠、九宫格配图、转评赞（按万显示）、原文链接；
   - 微博热搜、知乎热榜：前三名高亮、标签（热 / 新 / 爆）、热度，超过 10 条折叠；
   - 知乎问答：问题头（关注数、回答数）、回答卡（答主、签名、赞同、摘录折叠）；
   - 飞书日程：按本地日期分组（今天 / 明天）、时间段、已取消划线；
   - 飞书文档：标题、要点、开头摘录。
   每种都有 Markdown 版本，用于复制、导出、组件关闭和渲染失败。链接只接受 http(s)，外链不带来源页信息。
6. **守卫**（以后所有插件都要遵守）：`commercial/src/__tests__/pluginUiOnDemand.test.ts`
   - 默认上下文里不出现任何插件组件类型：INTELLIGENT_UI 段、输入预测段、基线 AGENTS / CLAUDE、所有技能的 frontmatter；
   - 前端的每个类型，要么在通用协议里，要么在登记表里恰好属于一个插件；
   - 模型写的组件：定义文件存在、覆盖每个类型、小于 2.5KB；SKILL.md 指向它，但不内联任何插件组件定义；
   - CLI 产出的组件：清单的 `emit: cli` 与登记表一致；基线里任何清单的 `components.ui` 都必须已登记；
   - 校验器拒绝 SKILL.md 作为定义文件、path 和 emit 同时写或都不写、非法或重复的类型名。
   OCV5-388 的 `intelligentUi.test.ts` 由「排除 marketSchema 的 4 个类型」改为「排除登记表的全部类型」（守的范围更大，没有放宽）。
7. **作者文档** `docs/plugin-authoring.md` 新增一节「智能 UI 组件：只在加载插件时进上下文」，写明两种做法和 5 个步骤。

## 5. 预期的 token 变化

| 场景 | 改前 | 改后（预期） |
|---|---|---|
| 默认上下文（不用插件） | 69,872 | 不变（只多了前端组件，提示没有变） |
| 加载 ths | +3,014 | 不变 |
| 加载 app-connectors | +4,648 | 约 +4.9k（多了 6 行指引） |
| 展示微博 / 知乎 / 飞书的结果 | 用通用组件拼 | 再读一个定义文件，约 +0.55k，只读用到的那一个 |
| 如果把定义写进系统提示（不采用） | — | 每轮约 +1.6k |

发布后用同一套回合实测，结果写进交接文件和工单。

## 6. 验证的限制（先说清楚）

- 个人版 uid 3 的 `oc-plugin list` / `oc-connect list` 在容器里都返回空：微博、知乎装过，但容器里调不到；飞书没有绑定。
  所以这三个插件**用不了真实数据**。验证时把插件 JSON 结果（照各自的 contract schema 写的样本）直接贴进对话，
  检查的是：模型会不会去读对应的定义文件、写出的块对不对、前端渲染是否正确。真实账号的端到端调用不在本单范围。
- 同花顺有真实数据（CLI 直连行情），本单不改它的组件，只做回归检查。
- 已有用户容器要等回收重建后才会拿到新的基线技能文件（个人版发布的已知缺口）。验证前要确认 u3 容器挂的是新 release。
