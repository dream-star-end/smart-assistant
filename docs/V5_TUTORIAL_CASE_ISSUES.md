# V5 场景教程验证与问题台账

这份台账只记录在场景实跑或代码路径审计中有证据的问题。教程正文不能把待采集、
模型自述或人工编写的示例冒充真实运行结果；只有同一案例三次独立运行均通过确定性门禁，
才可把 `replay.status` 从 `pending_capture` 改为 `verified`。

## 实跑状态

- 案例数：12（科研 5、编码 5、通用 2）
- 每案例要求：3 次全新会话、严格串行、相同冻结输入
- 已验证：0 / 12
- 已完成运行：0 / 36
- 当前状态：案例框架实施中；真实回放尚未采集，产品界面必须明确显示“待真实运行采集”

## 已证实缺口

| ID | 严重性 | 状态 | 证据 | 影响 | 后续最小动作 |
| --- | --- | --- | --- | --- | --- |
| TUT-EVAL-001 | 中 | backlog | `packages/commercial/src/marketplace/seedPlatformAgents.ts` 把科研助手默认模型设为 `deepseek-v4-pro`；固定 synthetic eval 流量在模型授权路径中被排除 | 专用评测账号不能忠实复跑科研助手默认组合，只能显式覆盖模型 | 单独设计不扩大生产权限的科研默认组合评测通道；在此之前教程如实标注实跑模型与默认模型不同 |
| TUT-EVAL-002 | 中 | backlog | `scripts/v5-synthetic-eval-turn-helper.mjs` 的 Codex prompt watcher 要求容器内不存在其他 session 的 app-server | 同一稳定容器上连续 36 次 Codex 实跑不能无条件复现，不能用临时 restart 绕过 | 单独设计受 mutation lease 保护的 synthetic-only 冷复位，或提供 session 精确隔离的 watcher |
| TUT-EVAL-003 | 高 | in-scope | `scripts/v5-synthetic-eval-turn-helper.mjs` 只证明单次 live WebSocket、final、cost 与 prompt capture；不下载用户交付物，也不与 durable tape 分页对账 | 单靠现有 helper 不能声称“完整、持久化、可审计回放” | 本任务增加 fail-closed 的公开回放清单/校验器；每次采集还需分页对账 durable frames，并通过产品下载接口校验产物哈希 |

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
