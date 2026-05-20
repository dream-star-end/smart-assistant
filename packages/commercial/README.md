# commercial — v3 商业版

v3 商业版后端 package。承载用户、账务、订单/支付、模型代理、compute-pool 调度等业务。

## 测试

### Layered

| Layer | 命令 | 依赖 |
|---|---|---|
| Unit | `npm run test:commercial:unit` | 无外部依赖 |
| Integ (default) | `npm run test:commercial:integ` | PG/Redis 不可达时**静默 skip** |
| Integ (strict) | `npm run test:commercial:integ:strict` | PG/Redis 必达;不可达 fail-fast |

`*.integ.test.ts` 文件按约定在 PG/Redis 不可达时静默 skip,以便本地 unit 测试不被 fixture 拖累。`:strict` 模式设 `REQUIRE_TEST_DB=1`,**强制** PG/Redis 必达,作为 CI 或本地"确认 integ 真跑过"的入口。

### Strict 的语义

`:strict` 只覆盖**依赖 PG/Redis 的 integ**(占 commercial integ 绝大多数)。**仍可能 skip 的**:

- 依赖 Docker socket 的 integ(如 `agentSupervisor.integ.test.ts`、`v3NetworkIsolation.integ.test.ts`)— 这些用 `process.env.DOCKER_HOST` 或 socket 路径探测,strict 不影响其 skip 行为。

简言之:`:strict` = "DB/Redis 强制",**不是** "所有 commercial integ 绝不 skip"。

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
