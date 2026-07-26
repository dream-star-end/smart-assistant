# commercial — v3 商业版

v3 商业版后端 package。承载用户、账务、订单/支付、模型代理、compute-pool 调度等业务。

## 测试

### Layered

| Layer | 命令 | 依赖 |
|---|---|---|
| Unit | `npm run test:commercial:unit` | 无外部依赖 |
| Integ (全量) | `npm run test:commercial:integ` | PG/Redis **必达**;不可达 fail-fast |
| Integ (梯队/分片) | `npm run test:commercial:integ:shard -- pr` | 同上,只跑 PR 门第一梯队 |

`:strict` 是 `:integ` 的历史别名,现在两者等价 —— **fail-open 已废除**。

> 2026-07-26 门禁审计前:`test:commercial:integ` 默认不设 `REQUIRE_TEST_DB`,
> PG 不可达时整层静默 skip 且 **exit 0**(实测 `settleUsage.integ` 在坏连接串下
> `# tests 16 / pass 0 / fail 0 / skipped 16`,EXITCODE=0),只有 `:strict` 才是真跑。
> 而 `test:commercial` / `test` / `check` 聚合链串的全是 fail-open 那个版本 ——
> 于是整层在任何入口都从未被强制执行过。现已在 `test:commercial:integ` 本身
> `export REQUIRE_TEST_DB=1`,与 `.github/scripts/commercial-unit-gate.sh` 对齐。

### fixture fail-closed 覆盖到哪

fail-closed 必须**对每种 fixture 逐一成立**,漏一种就等于整条链 fail-open:

- **PG** — `REQUIRE_TEST_DB=1`(或 `CI=true`):107/107 个需要 DB 的文件已覆盖。
- **Redis** — 用到 `TEST_REDIS_URL` 的 20 个文件此前只有 6 个会抛,其余 14 个缺
  Redis 时静默降级(HTTP handler 干脆不装配,"绿"只证明了没跑)。现已统一补
  `if (!redis && REQUIRE_TEST_DB) throw`。
- **Docker socket** — `agentSupervisor.integ.test.ts` 用
  `REQUIRE_TEST_DOCKER=1`(CI 上恒真;GitHub runner 自带 dockerd)。本地开发机
  没有 docker 时仍允许 skip。
  (`v3NetworkIsolation.integ.test.ts` 已于同批删除:它自己复制一份 HostConfig
  字面量再去问内核,验的是 Linux 实现了 cap-drop,不是我们的 supervisor 传了
  cap-drop —— 把 `v3supervisor.ts` 的 CapDrop 删光它照样全绿。真正的守门在
  `v3Supervisor.test.ts` 断言 `createContainer` 实参,且早已进 CI。)

### 分层执行:哪些进 PR 门,哪些进夜跑

见 `.github/integ-tiers/README.md` 与 `docs/V5_CI.md` §commercial-integ。
一句话:22 个文件进 PR 阻塞门,87 个进 nightly;新增 `*.integ.test.ts`
必须登记进某个梯队,否则 `npm run lint:integ-tiers` 红。

### 本地起 PG + Redis

不依赖 docker-compose 文件,任何 docker 安装即可:

```bash
# PG 16(端口 55432,与 prod 5432 隔离)
docker run --rm -d --name oc-test-pg \
  -p 55432:5432 \
  -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=openclaude_test \
  postgres:16

# Redis 7(端口 56379,与 prod 6379 隔离)
docker run --rm -d --name oc-test-redis \
  -p 56379:6379 \
  redis:7

# 跑 strict integ
npm run test:commercial:integ:strict

# 收尾
docker rm -f oc-test-pg oc-test-redis
```

### 环境变量

| Env | 默认 | 作用 |
|---|---|---|
| `TEST_DATABASE_URL` | `postgres://test:test@127.0.0.1:55432/openclaude_test` | integ 测试连 PG URL |
| `TEST_REDIS_URL` | `redis://127.0.0.1:56379/0` | integ 测试连 Redis URL |
| `REQUIRE_TEST_DB` | unset | `=1` 时,PG/Redis 不可达 → fail-fast(非 skip)|
| `CI` | unset | `=true` 等价 `REQUIRE_TEST_DB=1` |
