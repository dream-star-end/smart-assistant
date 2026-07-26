# CCB 上游跟进(vendored fork 单一权威)

`claude-code-best/` 是 vendored 进本仓的**完整上游项目**,不是 npm 依赖、不是 submodule。
它是 v5 商业版**全部 Claude 系模型的唯一执行底座**(codex 系走 `@openai/codex`,见
`packages/gateway/src/engine/registry.ts`)。

本文件是 pin 版本、定制层边界、升级 SOP 的**单一权威**。改 vendored 目录前先读这里。

---

## 1. 当前 pin

| 项 | 值 |
|---|---|
| upstream | https://github.com/claude-code-best/claude-code |
| pinned commit | `34b3dc99` = 上游 tag **v2.8.4**(2026-07-21,上游 main 最新) |
| 上次跟进 | 2026-07-26,本仓 commit `ac05464c` —— 从 `a7604f65` 跨 680 commits |
| 首次 vendored | 2026-04-12,本仓 commit `84ee42f6`,当时 pin `a7604f65`(v1.0.2..v1.0.3 之间) |
| 构建产物 | host `bun build` → `dist/cli.js` + chunks,见 `scripts/v5-runtime-release-lib.sh:build_ccb_dist` |

**pin 的含义**:`a7604f65` 的树 + 下面第 2 节的排除项 = 我们 vendored 时的原始状态。
`git diff a7604f65` 出来的一切,都是我们自己的定制。这个锚点是整套跟进机制的基石,
**不要在未更新本文件的情况下换 base**。

### 有意排除的上游文件

vendored 时未纳入。升级合并会把它们带回来,处置如下:

- `bun.lock` — **必须删除**。release 构建走 `bun install` 现算(ccb 依赖用 `workspace:*`,lock
  常按平台漂移)。⚠️ 升级必踩:上游 lock 里 1391 处 resolved URL 指向
  `registry.npmmirror.com`(上游作者的国内镜像),该域名在我们的出网环境不通(实测 HTTP 000)
  → `bun install` 会有几百个包 `ConnectionClosed` 失败。`rm -f bun.lock` 后 bun 才会走
  `~/.npmrc` 的官方 registry 重新解析。2026-07-26 升 v2.8.4 时实际踩过(297 包失败)。
- `.vscode/launch.json`、`.githooks/pre-commit` — 上游开发者本地设施,与本仓工具链无关。
  `.githooks/pre-commit` 在 v2.8.4 已被上游自己删除。

---

## 2. 定制层:动态导出,不手工维护 patch

**不维护 patch 文件**。手写的 patch series 会随上游重构静默腐坏,而我们已有一个精确锚点,
定制层可以由 git 现算:

```bash
scripts/ccb-upstream.sh diff          # 相对 pin 的净改动(= 完整定制层)
scripts/ccb-upstream.sh diff --stat   # 只看规模
```

截至 pin `a7604f65`,定制层为 **46 文件 / +2332 / -139**,按功能分七组:

| # | 定制 | 主要落点 | 性质 |
|---|---|---|---|
| 1 | 静态 key provider 接入(glm / kimi / qwen / minimax / ark) | `src/utils/model/staticKeyModels.ts` 等**新增文件** | 零冲突面 |
| 2 | 思考深度 effort 选择器 | `src/utils/effort.ts`、`src/utils/thinking.ts`、`src/commands/effort/` | 改上游文件 |
| 3 | WebSearch 走 MiniMax(替 Bing) | `tools/WebSearchTool/adapters/minimaxAdapter.ts` + `adapters/index.ts` | 走上游 adapter 扩展点 |
| 4 | per-model contextWindow(glm-5.2 1M) | `src/utils/context.ts`、`src/services/tokenEstimation.ts` | 改上游文件 |
| 5 | 尾流帧去重 / 工具输出 tail | `src/utils/sdkEventQueue.ts`、`src/utils/task/TaskOutput.ts` | 改上游文件 |
| 6 | 平台技能装载 | `src/tools/SkillTool/`、`src/skills/loadSkillsDir.ts` | 改上游文件 |
| 7 | Bash 沙箱策略 | `tools/BashTool/shouldUseSandbox.ts` | 改上游文件 |
| 8 | 构建适配(`target:'node'`、vendored ripgrep 缺失即跳过) | `build.ts` | 改上游文件 |

### 2.1 有意的语义偏离(升级时会反复撞上,先看这里再裁定)

上游改了行为、而我们**有意不跟**的地方。每次升级这些点都会重新变成冲突,照下表裁定即可,
不必重新考古:

| 位置 | 上游 v2.8.4 行为 | v5 保留的行为 | 为什么 |
|---|---|---|---|
| `modelSupportsMaxEffort` / `modelSupportsXhighEffort` | 限制全部移除,一律 `return true`("API 报错是用户的责任") | `getAuthorityModelCapabilities` 判定链 + 未知模型 `return false` | v5 接了 ark glm / kimi / qwen / deepseek 多 provider,各家 effort 支持面不同;放开会让不支持的 provider 收到 max → 上游 400,付费用户看到红框。配套 `resolveAppliedEffort` 降级 max/xhigh → high |
| `convertEffortValueToLevel` | `>100 → max` | `101-150 → xhigh`,`>150 → max` | v5 有独立 xhigh 档(Opus 4.7);上游数值区间无 xhigh 位置 |
| WebSearch 默认 adapter | `tavily`(需 API key) | `bing`(无 key)+ `minimax` 自动探测 | 商业容器靠 `minimaxSearchConfigured()` 探测 master 接线自动选 MiniMax;无 key 环境(个人版/dev/CI)落 bing 才不会硬失败。上游 brave/exa/tavily 仍可显式选用 |
| `build.ts` `target` | `'bun'` | `'node'` | 容器用 Node 22 跑 `node dist/cli.js`;`'bun'` 会保留 `await using` → SyntaxError crash-loop(2026-05-22 实发) |

**配套**:上游为"放开限制"写的测试(`returns true for unknown models`、`value > 100 maps to max`、
`modelSupportsMaxEffort`/`modelSupportsXhighEffort` 两个 describe 块)与上表矛盾,**有意不采纳** ——
不是漏合并。我们自己的 `effort.test.ts` 覆盖了对应语义(含 DeepSeek V4 回归套件)。

---

## 3. 与 gateway 的接缝(升级必须逐条实测)

CCB 不是黑盒 —— gateway 直接吃它的内部输出形状。**这些接缝出问题不会让 tsc 报错,
只会让线上 turn 静默错位**,是升级的头号风险:

| 接缝 | gateway 侧 | 断裂后果 |
|---|---|---|
| stream-json 输出帧 | `packages/gateway/src/ccbMessageParser.ts` | turn 内容解析错位。**codex 引擎复用同一解析器**(`engine/codexAppServerRunner.ts` 把 codex 输出适配成 CCB 形状),影响面覆盖两个引擎 |
| `getAPIMetadata()` | `subprocessRunner.ts:160` | 模型元数据/计费字段缺失 |
| effort 语义 | `subprocessRunner.ts:606`(权威在 `src/utils/effort.ts`) | 思考深度失效或映射错 |
| usage 形状 | `billing.calculator` | **计费错算** |
| 工具输出 tail | `sdkEventQueue` → `ccbMessageParser` → web `tool_output_tail` | 前端尾流洪水/丢帧 |

---

## 4. 升级 SOP

```bash
scripts/ccb-upstream.sh status          # 当前 pin vs 上游最新,落后多少
scripts/ccb-upstream.sh plan v2.8.4     # 三方合并预演:冲突面、搬迁文件、协议 diff
```

1. **预演**:`plan <tag>` 报冲突面。git 的 rename 检测能自动跟随上游分包重构
   (`src/tools/X` → `packages/builtin-tools/src/tools/X`),不要手工搬。
2. **协议闸门**:比对 `src/cli/print.ts` 的 stream-json 帧类型集合。
   **只增不减 = 可继续;有帧类型消失 = 停,先改 `ccbMessageParser` 再升。**
3. **合并**:在 worktree 内做,逐个冲突按第 2 节的功能分组裁定"我们的定制在新结构下落在哪"。
4. **构建**:先 `rm -f bun.lock`(见第 1 节陷阱),再 `bun install --ignore-scripts && bun run build`,
   确认 `dist/cli.js` 产出。上游要求 bun ≥ 1.3.11,release 构建机(kl-mirror)的 bun 版本要够。
   ⚠️ **退出码直接看,不要 `| tail`** —— 管道的退出码是 tail 的,会把 bun 的失败吞成"成功"
   (2026-07-26 实际踩过:install 挂了 297 个包、build 报 `Could not resolve "jsonfile/utils"`,
   但 `| tail` 让两步都显示 exit 0)。
5. **测试**:四层测试 + 第 3 节接缝逐条实测。
6. **e2e 硬门**:真 turn 跑通 —— 每个 Claude 系模型各一次,覆盖 effort / 搜索 / 技能 / 尾流四个改动面。
7. **上线**:CCB 走 release 轴(ro 挂载),**不重建镜像**,常规 `deploy-v5.sh`。
   canary → 观察 → finalize,`--abort` / `--rollback` 路径原样可用。
8. **收尾**:更新本文件第 1 节的 pin,并复核第 2 节分组是否需要增删。

---

## 4.0 UX 回退检查(每次升级必做,仓内铁律"任何优化不得降低用户体验")

跟进上游可能在两个地方悄悄拿掉用户已有的能力。**代码合并绿、测试绿,都不能证明没回退** ——
必须单独跑这两项对照:

### ① feature 门控的新增

上游 v2.8.4 起有 `DEFAULT_BUILD_FEATURES`(35 项默认开),而 v5 生产是零 feature(见 `build.ts`
的 v5 定制段)。危险情形是:**pin 时代某能力不受门控(直接可用),上游给它加了门控** ——
那我们不开就等于砍掉用户已有功能。

```bash
# 对每个 feature 名,对比两侧的门控点数量
for f in $(feature 名单); do
  echo "$f  pin=$(git grep -l "feature('$f')" <pin> -- src | wc -l)" \
       "new=$(git grep -l "feature('$f')" <target> -- src packages | wc -l)"
done
# pin=0 且 new>0  → 重点:再查该功能在 pin 时代是否存在
#   pin 时代无此功能 → 上游新功能,不开 = 暂不新增,不是回退
#   pin 时代有此功能 → **必须开**,否则是回退
```

2026-07-26 v2.8.4 实测:35 项中 30 项 pin 时代就有门控(生产一直关着,关掉=维持现状);
5 项新增门控(ACP / EXPERIMENTAL_SEARCH_EXTRA_TOOLS / POOR / AUTOFIX_PR / GOAL)经查
**pin 时代功能均不存在** → 全关零回退。注:CCB 的 `GOAL` 与 v5 自己的 `/goal`
(`packages/protocol/src/goalState.ts`)是两套独立机制,不要混淆。

### ② 工具集缩减

```bash
git ls-tree -r --name-only <pin>    -- src/tools | grep -oE 'src/tools/[A-Za-z]+Tool' | sed 's|.*/||' | sort -u
git ls-tree -r --name-only <target> -- src/tools packages/builtin-tools | grep -oE 'tools/[A-Za-z]+Tool' | sed 's|tools/||' | sort -u
# comm -23 两侧 = 被上游移除的工具 → 逐个查它在 pin 时代是否受(v5 关着的)feature 门控
```

2026-07-26 实测:上游移除 `ToolSearchTool`(pin 时代由 `isToolSearchEnabledOptimistic()`
控制,挂 EXPERIMENTAL_SKILL_SEARCH,v5 关着)与 `WorkflowTool`(pin 时代就在
`feature('WORKFLOW_SCRIPTS')` 门内)→ 两者对 v5 用户本来都不可达,移除无影响。
同期新增 10 个工具(ArtifactTool / ExecuteTool / GoalTool / PushNotificationTool 等),
多数在 feature 门内,属后续 feature 批的候选增益。

---

## 4.1 测试基线与判定方法(升级验证必读)

CCB 的测试套件有两个坑,不知道会把好几个小时浪费在假失败上:

1. **必须在真实路径下跑**。有测试按 `../../../../../static-key-providers.snapshot.json`
   读**本仓仓根**的文件(如 `staticKeyModels` 漂移守护),把 CCB 拷到独立目录跑会 ENOENT
   假失败。跑全量前先把合并结果落回 `claude-code-best/`。
2. **全量跑的失败集不稳定**。上游大量测试用 `mock.module`(bun 里是**进程全局、
   last-write-wins**),失败与否取决于文件执行组合;上游自己也只在个别文件用 `afterAll`
   重注册来缓解。所以**全量的失败数不能直接当回归证据**。

判定一条失败是否真回归,三步:

```
① 单独跑该测试文件            → 过 = 全量污染,非回归
② 在纯净上游 tag 上跑同一文件  → 也失败 = 上游自身缺陷
③ 在 canonical(未升级)上跑   → 也失败 = 既有 bug,与升级无关
```

### 已知既有失败(不是升级引入,勿在升级批里追)

- `sanitizeData > truncates arrays longer than MAX_ARRAY_LEN` —— `_openclaude/telemetry.ts:113`
  把 `_truncatedFromN` 挂成数组的**非索引属性**,而 `JSON.stringify` 序列化数组时会丢弃
  非索引属性 → 断言恒 `undefined`。canonical 同样红。属独立可修项(改成对象包裹或
  单独字段),不在升级批范围内。

### 2026-07-26 跟进 v2.8.4 的验证结果

- CCB 全量:**5918 pass / 9 fail**(纯净 v2.8.4 同环境基线 5763 pass / 9 fail / 7 errors ——
  我们 errors 更少,所以跑起来的测试更多、暴露的 fail 也更多)。
- 9 条逐一走上面三步定性:5 条 mock 污染(单独跑全绿)、1 条既有 bug、其余落在上游基线内
  → **零真实回归**。
- 定制测试全绿:effort 54 / sdkEventQueue 11 / bashCommandNormalize 19 / bingAdapter 38 /
  minimaxAdapter 5 / adapterFactory 4 / staticKeyModels 漂移守护 13(零漂移)。

---

## 5. 红线

- **禁止在 vendored 目录做"顺手"重构**。每一行非必要改动都是未来的合并冲突。
  格式化、重命名、类型收紧,一律不做。
- **新定制优先走上游扩展点**(adapter 目录 / env feature / 新增文件),
  收敛不了才改上游文件 —— 改了就要在第 2 节登记。
- **不要让 pin 落后超过一个上游 minor**。本次从 `a7604f65` 到 v2.8.4 跨了 657 个
  commit / 3.5 个月,冲突面才 21 文件是运气(上游分包重构 rename 可检测),下次未必。
- **升级必过真 turn e2e**。CCB 是全部 Claude turn 的唯一底座,V5 有真实付费用户;
  单测和 tsc 拦不住接缝错位。
