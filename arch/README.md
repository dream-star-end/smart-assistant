# arch/：架构护栏（第三阶段方案 v3.6 §3、§5）

| 文件 | 是什么 | 谁改 |
|---|---|---|
| `modules.json` | 唯一的模块权威：每个生产源文件按 glob 映射到一个模块（最具体的匹配胜出；同等具体的两个模块会让检查失败），每个模块登记层（L0 契约 … L6 组装根；前端 F0–F5）、进程作用域 `scope`、同层允许依赖 `allow`（必须无环，编码 §3.5 的领域图）、单一权威 `authorities` | 改层、作用域、`allow`、`authorities` 是“护栏变更”：单独一个 PR，不和搬家或功能混在一起（§5.3、§5.4） |
| `violations-baseline.json` | 现存违规清单：`规则|文件|目标 → 次数` | 只能变小。违规消失后同一个 PR 删掉对应条目（否则报 STALE）；`--write-baseline` 只在护栏变更 PR 里用 |

检查器：`npx tsx scripts/check-architecture.ts [--base <ref>] [--enforce] [--json <out>]`，测试在 `scripts/__tests__/checkArchitecture.test.ts`。

规则（§5.5 首期 1–4）：

| 规则 id | 含义 | 怎么修 |
|---|---|---|
| `R1-unmapped` | 生产文件不属于任何模块 | 在 `modules.json` 给它找到模块（护栏变更） |
| `R2-upward` | 值导入指向更高的层 | 把被依赖的东西下沉，或调用方上移；类型可以 `import type` |
| `R2-same-layer` | 同层模块之间的依赖不在 `allow` 里 | 走对方公开 API 并在 `allow` 登记（护栏变更），或经上层编排 |
| `R2-scope` | 被多个进程用的模块依赖了作用域更窄的模块 | 把共享部分移到作用域足够的模块 |
| `R2-front-back` | 前端与服务端模块互相导入（契约 L0 除外） | 经 `@openclaude/protocol` |
| `R2-export-star` | 模块的 `index.ts` 用了 `export *` | 显式列出公开 API |
| `R2-cross-package-internal` | 用相对路径读别的包的内部文件 | 从对方包的入口导出 |
| `R2-unresolved-internal` | 内部导入（相对路径或 `@openclaude/*`）解析不到文件 | 修正导入路径或包的 `exports`；检查器跟不上的导入不算“没有违规” |
| `R2-dynamic-import` | 非字面量的 `import()`/`require()` | 改成字面量，或登记例外 |
| `R2-contract-node` | L0 契约导入 `node:*` | 移到 node 入口（P1 拆 protocol） |
| `R3-env` / `R3-net` / `R3-crypto` / `R3-billing-sql` / `R3-handler-auth` / `R3-special-case` | `process.env`、出站网络、密码学原语、计费表写入、处理器内鉴权、引擎/提供方字面量特判出现在没有登记该权威的模块里 | 经对应的唯一实现（配置注册表 P3、出站客户端 P5、`platform/auth-crypto`、`billing` store、路由策略 P4b、描述符/适配器 P7） |

报告期（现在）：CI job `architecture` 只报告 `NEW/GROWN` 与 `STALE`，退出 0；解析失败、`modules.json` 不合法、基线缺失照样失败。误报率 ≤ 5% 之后改为 `--enforce`（§5.1、§5.6）。文件改名用 `--base` 的 git 改名识别把基线条目带过去，次数不得增加。带 `--base` 时还要求提交的基线相对基准提交的基线只减不增，否则 `BASELINE-GROWN`（强制期退出 1）：不能在同一个 PR 里新增违规并把基线调高。

## gate-couplings.json：门禁 ↔ 源码路径耦合（§5.7 第 1 条、附录 D）

`scripts/check-gate-couplings.ts` 生成。门禁文件 = 受跟踪的 `scripts/**`、`.github/workflows/*`、`.github/*.json`、`deploy/**` 清单、各 `tsconfig*.json`、根 `package.json`、`docs/V5_CI.md`；耦合 = 门禁文本点名的受跟踪路径（`packages/…` 这类仓库相对路径，以及按门禁所在目录解析的 `./`、`../` 字符串，例如 tsconfig `paths`）。通配符和模板插值处截断，所以 `packages/x/src/${y}` 耦合到目录 `packages/x/src`。

- `--base <ref>`：从 merge base 的树计算耦合。一个被点名的文件（或整个目录）在 HEAD 消失了、而该门禁在 HEAD 仍点名它 → `UNCOVERED`。只改门禁别的地方不算覆盖；旧路径留薄的 re-export（§5.7 第 2 条）就没有消失。门禁随搬家更新时，同一 PR 还要附变异测试证据（§5.7 第 3 条，评审项）。
- `--write`：重新生成快照；`--check`：快照是否过期。
- 报告期：`UNCOVERED` 和快照过期都只报告，退出 0；`--enforce` 退出 1。git 失败、参数错误退出 2。和 `architecture` 一起转强制期。
