# OCV5-291 · 双 Box 付费进程一次性验收

此项仅检验已过离线门和 T2 审的自用实例并发改动，不是生产调试或长测。用户自行做数小时长测。唯一合格账号 20，uid 3；商业生产不参与。

## 执行边界

1. 运行在 v3-dev-sg，核自用 PG `openclaude_v5_selfhost`、Redis `/3`、当前容器身份、账号20 RUNNING/GRANTED、该账号 ACTIVE journal=0、钱包余额充足、无其他 operator/发布在飞。需显式 `OCV5_291_PARALLEL_PAID_ACK=1`，绝不唤醒休眠 Box。
2. 复用已验过的 `boxSignedToolLiveProbe` **签名本地 `/v1/messages` harness**，仅把它变成 import 不触发旧 main 的可复用 helper；新 operator 不复制认证/计费协议。注入真实 `BoxTextFetch`、detached runner、BoxReplayWriter、真实 BoxAccountResolver、真实 PG journal 和 Redis preCheck；journal 与 registry 使用和目标 selfhost egress 相同的 uid3/account20 cap2 函数。旧脚本直接运行行为不变。
3. 两个不同 session/turn/requestId，各有随机且相异的无用户数据答复标记。先持久写一次 operator receipt（uid/account/两个 requestId/随机标记哈希/本次代码 SHA/时间，不存认证或提示词），才并发发送**恰好两个**付费请求。绝不自动重试，包括超时、断流、HTTP 409/5xx。不要发送第三个真实付费候选来试容量；第三席位由 PG/handler 离线红绿覆盖，避免终态竞态使其合法启动。
4. 签名 harness 的 `BoxTextFetch` launch 路径记录每个请求 `admit` 后 runNonce/epoch，拦截 remote `launched` ack，仅作内存观测。两个响应头到达后必须在同一时刻查到两个不同 ACTIVE run 组、均有 launch permit 且未写终止证明；这证明有远端未终止的重叠窗口。若时间太短未观测到，不加付费请求、不臆称通过。
5. 完成后每条有独立精确答案（不得包含另一条随机标记）、单个 terminal proof `worker_complete`、Message capsule、`usage_records` 一行及对应 `credit_ledger` 实扣和 `cost_credits` 精确相等、`boxRemoteCleanup=done`；launch cwd 必须分别等于各自 `/tmp/ocv5-289-run-<nonce>`，不同 nonce 且无答案串读。首次文本调用不发行 `boxNativePointer`，不能拿该字段作为验收条件；项目转录沿现有按 cwd 分目录的实现，不读私有内容。stop/cleanup 按各自 nonce/epoch，第二条独立完成。总 paid launch 恰好2，预算只扣各自一次，余额不负。
6. 成功才把 receipt 标成功并写无隐私摘要；任一歧义/未知则留下 receipt 和 journal 原证据，不自动重放/手动放槽/补账，按现有 stop+proof/只读 observer 路径另查。验收未过不得合入/发布并发代码。

## 实施次序

先让 auditor 对此验收方案审到 PASS；再做可复用签名 helper 的窄改与新 operator（含离线假 Box 红绿、类型检查），T2 代码审到 PASS；非付费预检通过后，真实 Box 双付费只执行一次。通过才选择性把通用并发提交合到干净 shared 分支（不能带入当前隔离分支里旧用户专属 orphan operator 证据），按官方 selfhost 发布/只读核验。
