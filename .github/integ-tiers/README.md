# integ 分层清单(单一权威)

`packages/**/*.integ.test.ts` 的执行分层在这里定义,**这是唯一权威**:
CI job、本地 `npm run test:commercial:integ:shard`、以及漂移门
`npm run lint:integ-tiers` 三者读同一批清单文件。

## 文件

| 文件 | 含义 |
| --- | --- |
| `pr-*.txt` | **PR 门第一梯队**。每个 PR 都跑,红了直接拦合并。 |
| `nightly-*.txt` | 夜跑梯队。红了开工单,不阻塞 PR。 |

`*` 是分片号。分片只为并行缩短墙钟时间,**不改变判绿语义**:每一片都要
求 `失败集 ⊆ 基线 且 skipped==0 且 executed>=min-tests 且 TAP plan 完整`。

## 格式

- 一行一个仓根相对路径,`#` 开头是注释,空行忽略。
- 每个清单**必须**有一行 `# min-tests: N` 指令 —— 判绿的执行下界。
  用例只增不减,所以 N 取"当前实测用例数"即可;有人删用例导致低于 N,
  门会红,这是刻意的(防"把测试删了让门变绿")。
- 每个清单**必须**有一行 `# max-minutes: N` —— 该片在 2 核 runner 上的
  预算上限,写进 CI job 的 timeout-minutes,防 PR#131 那种撞 45min 全局
  超时后卡死 8 天的重演。

## 加了新 integ 文件怎么办

`npm run lint:integ-tiers` 会红,提示把新文件登记进某个清单。
判断标准只有一条:**这个文件绿了能证明哪一条用户可见事实?**

- 能直接证明"能注册 / 能登录 / 能收信 / 钱只扣一次 / 会话能落库读回"
  一类主干事实 → `pr-*`。
- 管理面、连接器、自愈、账号池、单条 migration 回放等 → `nightly-*`。

登记进 `pr-*` 的同时必须把该清单的 `min-tests` 一起上调,否则
新用例可以被 `--test-only`/skip 悄悄绕过而门仍然绿。
