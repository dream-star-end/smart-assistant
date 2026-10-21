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
| `R2-dynamic-import` | 非字面量的 `import()`/`require()` | 改成字面量，或登记例外 |
| `R2-contract-node` | L0 契约导入 `node:*` | 移到 node 入口（P1 拆 protocol） |
| `R3-env` / `R3-net` / `R3-crypto` / `R3-billing-sql` / `R3-handler-auth` / `R3-special-case` | `process.env`、出站网络、密码学原语、计费表写入、处理器内鉴权、引擎/提供方字面量特判出现在没有登记该权威的模块里 | 经对应的唯一实现（配置注册表 P3、出站客户端 P5、`platform/auth-crypto`、`billing` store、路由策略 P4b、描述符/适配器 P7） |

报告期（现在）：CI job `architecture` 只报告 `NEW/GROWN` 与 `STALE`，退出 0；解析失败、`modules.json` 不合法、基线缺失照样失败。误报率 ≤ 5% 之后改为 `--enforce`（§5.1、§5.6）。文件改名用 `--base` 的 git 改名识别把基线条目带过去，次数不得增加。
