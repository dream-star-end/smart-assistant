# arch-measure：第三阶段方案 §1 的数字怎么重跑（OCV5-540，P0a）

全部只读，不依赖 npm 包（只用 Node 标准库；宿主与库表的两项用 bash、sqlite3、psql）。每个脚本都收 `--root <仓库>`，可以对任意快照重跑，例如方案的基线 `3ef8d1d3d`。`--json` 输出机读结果。

| 脚本 | 覆盖 | 在哪跑 |
|---|---|---|
| `sizes.mjs` | §1.1、§1.3–§1.5 的行数、目录数、文件数 | 任何 checkout |
| `deps.mjs` | §1.1–§1.4 的依赖图：包级边、commercial→gateway、protocol 的 `node:*`、storage 引用方、commercial 目录级图与 SCC、文件级环、egress 入口的直接依赖、gateway `server.ts` 反向引用、29 文件环、engine 反向依赖 | 任何 checkout |
| `crosscut.mjs` | §1.5、§1.6、§1.8 的词法计数（鉴权调用、`user_id = $n`、校验库、出站、`console.*`、中文串、`HttpError`、计费写语句、裸 `BEGIN`、特判、env 读取） | 任何 checkout；`--strip` 先去注释 |
| `trains.mjs` | §1.9、§8.1：读 OCV5-539 的 `<trainId>.summary.json`，按阶段字母求 p50/p90、门禁逐个、缓存命中、失败所在阶段；`--check-last 10` 是 P0a 的退出检查 | v5-dev（`/opt/openclaude/tmp/lease-trains`） |
| `logs.mjs` | §1.7 日志形状：JSON 占比、带 traceId 的行、warn/error 带不带 id、用户键名混用 | v5-dev，root |
| `trace-facts.sh` | §1.7 库表事实（经本机 postgres 角色的 Unix socket 连接，命令行上没有口令）：`turn_traces.dispatch_id` 填充率、`request_id = billing_request_id`、哪些表有 `trace_id` 列、最近一个 crashed 回合（附录 A.3 演练的起点） | v5-dev，root；只读会话 |
| `host.sh` | §1.7 日志位置与轮转、容器日志驱动、§1.9 `lease.db` 列车状态与分钟数 | v5-dev，root |

口径（与方案 §1 序言一致）：“非测试”= `.ts/.tsx`，排除 `*.test.*` 与 `__tests__/`；包的行数按整个包目录算（例如 commercial 含 `agent-sandbox/`）。值导入跳过 `import type`/`export type`，以及类型位置的 `import("x").T` / `typeof import("x")`。commercial 目录图：每个顶层目录一个节点，根目录文件合成 `_root`，去掉 `index.ts`（组装根）的出边，Tarjan 求 SCC。

## 对照：方案 §1 的数字 vs 脚本在 `3ef8d1d3d` 上的输出

“一致”表示脚本逐字复现。“偏差”列写明原因；凡是方案原来用 `rg` 估的下限，以脚本的定义为准，后续步骤的目标值也按脚本重算。

| §1 数字 | 方案值 | 脚本（`3ef8d1d3d`） | 结论 |
|---|---|---|---|
| commercial 行数 | 324,772 | 324,772 | 一致 |
| commercial 顶层目录 / 根文件 | 50 / 11 | 50 / 11 | 一致 |
| gateway / protocol / storage / mcp-memory / channels / plugin-sdk / cli 行数 | 139,225 / 13,527 / 23,910 / 7,110 / 2,303 / 115 / 628 | 同 | 一致 |
| web-react 行数 | 约 21 万 | 211,319 | 一致 |
| `egress/main.ts` 行数；直接值导入 commercial 文件 | 1,023；64（http 33、account-pool 7、billing 6、auth 4） | 1,023；64（同） | 一致（是直接导入，不是传递闭包；闭包另给 360） |
| storage 被引用文件 | gateway 100、commercial 37、mcp-memory 7、cli 5、wechat 4 | 同 | 一致 |
| 包级值依赖环 | 无 | 0 | 一致（渠道包按 `@openclaude/channel-*` → `packages/channels/*` 映射，有反例测试） |
| commercial→gateway 边 / 其中值导入 | 35 / 15 | 35 / 15 | 一致 |
| protocol 的 `node:*` 导入 | 5 | 6 | 偏差：方案漏了 `dispatchAuthority.ts` 的 `node:crypto` |
| web-react import protocol 的文件 / 经根桶 | 59 / 43 | 63 / 44（src 内 60） | 偏差：脚本含 `browser-tests/` 3 个文件 |
| commercial 目录图节点 / 边 / 非平凡 SCC / 最大 SCC | 51 / 275 / 1 / 38 | 51 / 275 / 1 / 38 | 一致，SCC 外的 13 个目录名单也一致 |
| 文件级值导入环 | 4 | 3 | 偏差（方案错）：方案把类型位置的 `import("…").Type` 算成了值导入，其中一个“环”实际没有运行时依赖（Codex r1 指出） |
| billing→http；db→上层；auth/billing/dispatch→ws | 8；10；4 | 语句数 值/全部：7/9；9/9；3/4 | 偏差：方案混用了值导入与全部导入；以脚本输出的两列为准 |
| http→admin | 128 条边 | 128（值）/ 130 | 一致 |
| `index.ts` 值依赖的目录 | 42 | 43（含 `_root`） | 偏差：口径差一个 `_root` |
| http / http/proxy / index.ts / pgSessionsBackend 行数 | 73,893 / 约 3 万 / 7,780 / 13,978 | 73,893 / 29,651 / 7,780 / 13,978 | 一致 |
| gateway 根目录文件 | 227 | 229 | 偏差 2：方案的排除规则未记录；以脚本为准 |
| `server.ts` 行数；反向引用 31（值 20，不含 index 19；仅类型 11） | 2,981；31/20/19/11 | 同 | 一致 |
| gateway 最大值导入环 | 29 | 28 | 偏差（方案错）：同上，类型位置的 `import()` 不是运行时边 |
| engine/ 反向依赖 logger / remoteTarget / subprocessRunner / promptSlots | 13 / 8 / 7 / 7 | 13 / 8 / 6 / 7 | 偏差 1：方案把一个 `import()` 或类型导入算进去了；脚本按 import 语句计 |
| `socket.ts` / `App.tsx` | 6,706 / 2,813 | 同 | 一致 |
| 组件直接 `fetch` | 9 个文件 12 处 | 9 个文件 13 处 | 偏差 1 |
| web-react `provider ===`（含 `!==`） | 30（45） | 30（45） | 一致 |
| `requireAdminVerifyDb` / `requireAdmin` / `requireAuth` / `verifyContainerIdentity` | 109 / 约 77 / 97 / 51 | 110（含定义）/ 88 / 97 / 51 | `requireAdmin` 方案是估计值 |
| `user_id = $n` | 916 / 117 文件 | 912 / 114 | 偏差小（方案含注释与测试辅助） |
| `role === 'admin'` | 52 / 35 | 54 / 36（含 `!==`） | 接近 |
| zod 文件 / TypeBox 文件 / `typeof` | 26 / 13 / 约 5,600 | 26 / 13 / 5,507 | 一致或接近 |
| `isRecord/isObject` 重复定义 | 40 | 25 | 偏差：方案的匹配规则未记录（可能含内联 arrow 与测试辅助）；以脚本为准 |
| commercial / gateway `fetch(` | 57/41、23 | 60/42、27 | 接近 |
| 自建 undici agent | 10 | 13 | 偏差：脚本也计 `ProxyAgent`/`Pool` |
| 服务端 `console.*`：commercial / gateway / cli | 383 / 87 / 81 | 372 / 22 / 77 | gateway 偏差大：方案把 `console` 的其它用法或测试辅助算进去了；以脚本为准 |
| 后端中文字面量行 | 约 4,200 / 396 文件 | 3,899 / 301（去注释） | 接近 |
| `new HttpError(`；码 | 1,044；161 | 1,044；181 | 次数一致；码数按“首参数字 + 次参大写字面量”取，口径不同 |
| ws 目录 catch / 静默 | 333 / 207 | 400 / 空 catch 61 | 偏差：方案的“静默”是人工判定（不记录也不重抛），脚本只能数空 catch；P1 的日志规则会给出可执行定义 |
| 计费表写语句；`credit_ledger` 写入文件 | 76 / 21；8 | 94 / 21；8 | 语句数口径不同，文件数一致 |
| 裸 `BEGIN` | 68 / 34 | 74 / 36 | 接近 |
| `provider ===` 全仓（含 `!==`） | 123（200） | 123（200） | 一致 |
| `engineId ===` | 116 | 168（`engine`/`engineId` 的 `===`/`!==`） | 偏差：方案的规则未记录；P0b 的检查器按符号解析重新给基线 |
| `selfhost` 分支 | 215 | 281 次提及（去注释） | 口径不同：方案数分支，脚本数提及 |
| env 直接读取：合计 / commercial / gateway / storage / mcp-memory / cli | 512 / 260 / 164 / 36 / 43 / 9 | 547 / 295 / 166 / 36 / 43 / 7 | storage、mcp-memory 一致；其余是 AST 与正则口径差异 |
| env 键 | 446 | 318（只算直接读取） | 方案还沿 `env = process.env` 别名追了读取；P3 的配置清单用 AST 给权威数字 |
| §1.7 日志、库表事实 | 见 §1.7 | `logs.mjs`、`trace-facts.sh` 现场重跑 | 现网数据，随时间变化 |
| §1.9 列车阶段耗时 | 推算值（无 `summary.json`） | `trains.mjs` 读 `summary.json` | OCV5-539 上线后用实测替代推算；§8.1 规定 2 周后重算目标 |

结论：结构类数字（依赖图、SCC、反向引用、行数）逐字复现，只有两个环的大小因方案把类型位置的 `import()` 算成值导入而偏大（4→3、29→28），以脚本为准；词法计数类有偏差的，方案原文本来就是 `rg` 下限估计，以后统一以这些脚本的输出为基线。P0b 的 `check-architecture.ts` 会用 TypeScript 符号解析重新给出规则 3 的违规基线，届时这里的正则计数只作为参考。
