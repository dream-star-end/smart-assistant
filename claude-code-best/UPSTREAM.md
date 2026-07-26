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
| pinned commit | `a7604f65` (2026-04-03) |
| pinned 位置 | `v1.0.2..v1.0.3` 之间(晚于 v1.0.2,早于 v1.0.3 的 OpenAI 兼容层) |
| vendored 于 | 2026-04-12,本仓 commit `84ee42f6` |
| 构建产物 | host `bun build` → `dist/cli.js` + chunks,见 `scripts/v5-runtime-release-lib.sh:build_ccb_dist` |

**pin 的含义**:`a7604f65` 的树 + 下面第 2 节的排除项 = 我们 vendored 时的原始状态。
`git diff a7604f65` 出来的一切,都是我们自己的定制。这个锚点是整套跟进机制的基石,
**不要在未更新本文件的情况下换 base**。

### 有意排除的上游文件

vendored 时未纳入,升级时若被上游带回属正常,按需保留:

- `bun.lock` — release 构建走 `bun install` 现算(ccb 依赖用 `workspace:*`,lock 常按平台漂移)
- `.vscode/launch.json`、`.githooks/pre-commit` — 上游开发者本地设施,与本仓工具链无关

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
4. **构建**:`bun install --ignore-scripts && bun run build`,确认 `dist/cli.js` 产出。
   上游要求 bun ≥ 1.3.11,release 构建机(kl-mirror)的 bun 版本要够。
5. **测试**:四层测试 + 第 3 节接缝逐条实测。
6. **e2e 硬门**:真 turn 跑通 —— 每个 Claude 系模型各一次,覆盖 effort / 搜索 / 技能 / 尾流四个改动面。
7. **上线**:CCB 走 release 轴(ro 挂载),**不重建镜像**,常规 `deploy-v5.sh`。
   canary → 观察 → finalize,`--abort` / `--rollback` 路径原样可用。
8. **收尾**:更新本文件第 1 节的 pin,并复核第 2 节分组是否需要增删。

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
