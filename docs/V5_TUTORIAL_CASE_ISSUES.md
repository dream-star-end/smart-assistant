# V5 场景教程验证与问题台账

这份台账只记录在场景实跑或代码路径审计中有证据的问题。教程正文不能把待采集、
模型自述或人工编写的示例冒充真实运行结果；只有同一案例三次独立运行均通过确定性门禁，
才可把 `replay.status` 从 `pending_capture` 改为 `verified`。

## 实跑状态

- 案例数：12（科研 5、编码 5、通用 2）
- 每案例要求：3 次全新会话、严格串行、相同冻结输入
- 公开 `verified`：0 / 12
- 完整门禁通过：0 / 36
- 全连接采集：1 次（编码；只是有效诊断样本，不等于完整门禁通过）
- durable 产品完成：2 次（科研 1、编码 1）
- 历史产品失败尝试：2（修复前科研 1、编码 1，均未计入公开回放）
- 当前状态：案例框架已上线；仍无案例满足三次独立运行的公开门禁，产品界面必须继续明确显示“待真实运行采集”

## 本轮真实案例结论

| 案例 | 产品结果 | 可核对证据 | 公开门禁判定 |
| --- | --- | --- | --- |
| `research-bike-demand` | 在已部署长任务修复后 durable 完成，耗时约 2 小时 35 分；产出固定数据哈希、时间切分、线性/非线性对照、图表、报告和 34 项测试 | 118 / 118 条 usage 成功，870 credits；durable tape 约 34.7 MB、101,876 条逻辑记录、177 parts | **不通过**：单连接 helper 在 2,700 秒先断开，未生成完整 `turn/frames` 证据；不得用 durable 事后结果冒充 product-visible capture |
| `coding-swe-bench-fix` | 全连接完成，耗时约 15 分 49 秒；定位 Astropy 嵌套 `CompoundModel` 可分离性根因，产出 1 行修复、回归测试和根因报告 | 64 / 64 条 usage 成功，209 credits；约 13.7 MB / 15,170 帧；修复前 2 项回归失败，修复后新增与邻近测试 13 项通过，外部复跑同样 13 项通过 | **不通过**：未运行官方 SWE-bench `FAIL_TO_PASS/PASS_TO_PASS` harness，且 product-visible 的“完整 git diff”漏了 untracked 回归测试内容 |

## 已证实缺口

| ID | 严重性 | 状态 | 证据 | 影响 | 后续最小动作 |
| --- | --- | --- | --- | --- | --- |
| TUT-EVAL-001 | 中 | backlog | `packages/commercial/src/marketplace/seedPlatformAgents.ts` 把科研助手默认模型设为 `deepseek-v4-pro`；固定 synthetic eval 流量在模型授权路径中被排除 | 专用评测账号不能忠实复跑科研助手默认组合，只能显式覆盖模型 | 单独设计不扩大生产权限的科研默认组合评测通道；在此之前教程如实标注实跑模型与默认模型不同 |
| TUT-EVAL-002 | 中 | backlog | `scripts/v5-synthetic-eval-turn-helper.mjs` 的 Codex prompt watcher 要求容器内不存在其他 session 的 app-server | 同一稳定容器上连续 36 次 Codex 实跑不能无条件复现，不能用临时 restart 绕过 | 单独设计受 mutation lease 保护的 synthetic-only 冷复位，或提供 session 精确隔离的 watcher |
| TUT-EVAL-003 | 高 | backlog | `scripts/v5-synthetic-eval-turn-helper.mjs` 只证明单次 live WebSocket、final、cost 与 prompt capture；不下载用户交付物，也不与 durable tape 分页对账 | 单靠现有 helper 不能声称“完整、持久化、可审计回放” | 后续实现 fail-closed 的公开回放清单/校验器；每次采集还需分页对账 durable frames，并通过产品下载接口校验产物哈希 |
| TUT-EVAL-004 | 高 | deployed-fixed | 2026-08-08 的科研与编码实跑都在最后一条成功模型用量记录后约 5 分钟终止，代码路径是 `pickIdleTimeoutMs(..., engineId='ccb')` 落入 5 分钟 DEFAULT 档；修复于 `b655bc764` 部署后，科研任务持续 2 小时 35 分并 durable 完成，编码任务全连接完成 | 修复前，合法的大上下文/高思考 CCB 请求会被误判死锁，复杂科研和编码流程无法交付最终答案 | 已解析的 CCB 与 Codex engine 统一使用现有 15 分钟 idle 档；未解析的 legacy 调用仍保留 5 分钟，真死锁仍由 15 分钟 watchdog 收敛 |
| TUT-EVAL-005 | 中 | partial | low-level helper 与 run-arm 的单轮 capture 上限已从 1,050 秒提高到 2,700 秒，但真实科研任务约耗时 2 小时 35 分 | 2,700 秒只是更宽的单连接窗口，仍会先于合法长任务断开；继续增加硬上限不能解决根因 | 保留已部署的 2,700 秒兼容改善，根修转入 TUT-EVAL-007 的 durable 续采集方案 |
| TUT-EVAL-006 | 中 | backlog | 编码实跑期间，生产 systemd 在 2026-08-08 17:21:57 UTC 因另一条有独立 owner 的官方 rollout 重启 active gateway；单连接 helper 收到 1006 后 fail-closed，而 durable dispatch 继续执行并在稍后收尾 | 现有 helper 适合稳定窗口的确定性采集，不能验证用户前端的断线重连/持久化回放路径 | 只在 release queue 空闲且 deploy state 全程 stable 时采集公开证据；另建断线重连专项，不把该次失败伪装成案例通过 |
| TUT-EVAL-007 | 高 | backlog | 科研任务的 durable tape 完成时约 34.7 MB、101,876 条逻辑记录、177 parts；现有 helper 在单个 WebSocket 上把 frames 留在内存，只在收到 final 后一次性写文件 | 任何连接中断或 helper 时限都会丢失已采集证据；超长任务还会带来不必要的内存峰值 | 发送后固化 dispatch 身份，按 durable tape 游标分页续采，frames 增量落盘并做顺序/哈希对账；断线后恢复采集，不再增加新的模型任务硬上限 |
| TUT-EVAL-008 | 高 | backlog | 科研交付把非负的积分绝对差异（IAD）的普通 bootstrap 区间“排除 0”表述为差异证据；该统计量在有限样本下即使零假设成立也会因取绝对值产生正偏 | 用户可能把描述性稳定性区间误读成零假设显著性检验，损害科研结论可信度 | 对非负/边界统计量增加 null permutation 或等价的预先指定推断门；普通 bootstrap 区间只允许表述重采样稳定性，禁止自动等同为“显著” |
| TUT-EVAL-009 | 中 | backlog | 编码交付最终显示的 `git diff` 只含已跟踪源文件的 1 行修复，而 `git status` 仍有 untracked 回归测试；完整测试文件只存在 workspace 和私有帧中 | 用户复制所谓“完整 patch”时会丢失回归测试，无法重现先红后绿证据 | 出口门禁对账 `git status --porcelain`、patch manifest 与实际 workspace；必须用 intent-to-add 或等价机制把 untracked 文件内容纳入完整 patch |

## 优先级

- **P0：无。** 本轮未发现正在造成用户数据、安全或计费损害的新问题。
- **P1：TUT-EVAL-003 / 007 / 008。** 先补齐 durable 全量回放与交付物对账，再建立科研推断质量门。
- **P2：TUT-EVAL-001 / 002 / 006 / 009。** 解决默认模型忠实评测、连续 Codex 采集、断线专项与完整 patch 出口门禁。

## 发布回放的硬门禁

1. 仅使用专用 synthetic eval 账号和明确许可的公开材料；禁止真人数据、付费墙正文、私有仓库。
2. 每轮前后都必须证明生产处于同一 `stable` release/runtime tuple，且没有 candidate 或 rollout。
3. 原始 `frames.json`、`turn.json`、`extra-prompt.md` 永远留在私有 0700 证据目录；
   `extra-prompt`、token、UID、容器/进程/会话/trace/request/ledger 身份、绝对路径和一次性 URL 不得公开。
4. 公开回放只能由该轮 product-visible frames 确定性生成，不得人工补写 thinking、工具调用或结果。
5. 保留完整可见文本、thinking、工具和协作卡；超长内容用分块、游标和按需加载，不摘要替代、不静默截断。
6. 科研案例必须通过引用可定位、未接地陈述为零、固定数据哈希与统计/图表格式门禁；
   编码案例必须证明固定 base 的测试先红、修改后目标与正常路径测试全绿、diff 路径白名单和 patch 可应用。
7. 三次均通过才发布；公开回放选耗时中位数那次，指标报告中位数和范围，不挑最好看的一次。
