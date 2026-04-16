# 06 测试策略(TEST STRATEGY)

## 1. 原则

- **TDD(Test-Driven Development)**:实现每个函数/路由前先写测试,让测试指引实现
- 测试是规格的**可执行副本**,文档改了测试要跟着改
- **不写的测试也是设计决策**:明确不测的部分(见 §5)

## 2. 三层分法

| 层级 | 工具 | 范围 | 运行速度 |
|------|------|------|---------|
| **单元** | `node:test` + `tsx` | 纯函数、类、模块,mock 所有外部依赖 | 快(<10ms/case) |
| **集成** | `node:test` + pg + redis(真实,docker-compose) | 一个 API 路由串起 DB/Redis/fetch mock | 中(100ms-1s/case) |
| **E2E** | Playwright(可选 V2) | 浏览器驱动真实浏览、支付沙箱、Agent 容器 | 慢(5-30s/case) |

MVP 只做**单元 + 集成**。E2E 延后。

## 3. 目录结构

```
packages/commercial/
├── src/
│   ├── auth/
│   │   ├── passwords.ts
│   │   └── __tests__/
│   │       ├── passwords.test.ts      # 单元
│   │       └── register.integ.test.ts # 集成(.integ. 命名)
│   └── ...
└── tests/
    └── e2e/                            # E2E(后期)
```

约定:
- 单元测试文件名 `*.test.ts`,与被测源文件同目录 `__tests__/`
- 集成测试文件名 `*.integ.test.ts`,同样在 `__tests__/` 下
- E2E 在 `tests/e2e/` 下(后期)

## 4. 覆盖目标

| 模块 | 单元 | 集成 | 关键行为必须测 |
|------|:----:|:----:|--------------|
| auth/passwords | ✅ | — | 哈希/校验、timing-safe 比较 |
| auth/jwt | ✅ | — | 签发、校验、过期、篡改 |
| auth/register | — | ✅ | 邮箱重复、弱密码、验证邮件、Turnstile |
| auth/login | — | ✅ | 正确/错误密码、未验证邮箱、限流 |
| auth/refresh | — | ✅ | 正常刷新、吊销后无效、过期 |
| billing/calculator | ✅ | — | 4 维 token 分别计费、倍率、快照 |
| billing/ledger | — | ✅ | 并发扣费(`FOR UPDATE`)、余额负数拒绝 |
| billing/preCheck | ✅ | ✅ | 余额不足/充足、边界 |
| payment/hupi/sign | ✅ | — | 签名生成、校验成功/失败 |
| payment/createOrder | — | ✅ | 订单创建、过期、重复请求 |
| payment/callback | — | ✅ | 幂等、签名错误、金额篡改、成功加积分 |
| account-pool/scheduler | ✅ | — | sticky、加权、全部不可用 |
| account-pool/health | ✅ | ✅ | 熔断、半开恢复 |
| account-pool/crypto | ✅ | — | 加密/解密、篡改检测、nonce 唯一 |
| account-pool/refresh | ✅ | ✅ | 过期自动刷新、刷新失败处理 |
| agent-sandbox/supervisor | — | ✅(docker 可用时) | provision/stop/remove、幂等 |
| agent-sandbox/lifecycle | ✅ | ✅ | 到期 stop、volume GC |
| admin/requireAdmin | ✅ | ✅ | 403 非 admin、admin 通过 |
| admin/users | — | ✅ | 封禁、积分调整、审计写入 |
| crypto/aead | ✅ | — | 加密/解密、GCM 认证失败 |
| db/migrations | — | ✅ | 空库迁移成功、幂等、失败回滚 |

**总覆盖率目标**:line coverage ≥ 80%,关键模块(auth / billing)≥ 95%。

## 5. 不测的部分(明确)

- ❌ 日志格式(eyeball)
- ❌ HTML/CSS 渲染(MVP 前端简单)
- ❌ Docker daemon 本身行为
- ❌ 虎皮椒第三方 API(用 sandbox / mock)
- ❌ Claude API(用 mock server / recorded fixtures)
- ❌ 网络代理的内部实现

## 6. 测试基础设施

### 6.1 测试数据库

`tests/fixtures/docker-compose.test.yml` 起一个 pg + redis:
```yaml
services:
  pg:
    image: postgres:15
    environment:
      POSTGRES_PASSWORD: test
      POSTGRES_DB: openclaude_test
    ports: ["55432:5432"]
  redis:
    image: redis:7
    ports: ["56379:6379"]
```

集成测试 `globalSetup`:
1. `docker compose up -d`
2. 等健康
3. 跑所有迁移到 `openclaude_test`
4. 每个 `describe` 前 TRUNCATE 所有业务表(保留 `model_pricing` 种子)

### 6.2 Mock 策略

- **Claude API**:
  - `tests/mocks/claudeApi.ts` 提供 `mockClaudeStream(fixture)` 函数,用 `fetch` polyfill 拦截
  - Fixtures 存放在 `tests/fixtures/claude/` 下,一个 stream 一个 `.jsonl`
- **虎皮椒**:同理,`mockHupijiao()` 返回固定 qrcode_url,回调用本地签名生成器
- **Turnstile**:测试环境 `TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA` (dummy always-pass key)
- **邮件发送**:`nodemailer` 的 `jsonTransport`,断言发出的邮件内容

### 6.3 时间控制

- 使用 `node:test` 的 `mock.timers.enable()` 控制 `Date.now` / setTimeout
- 对于 JWT 过期、订阅到期等时间相关测试,明确快进时间

### 6.4 随机性控制

- `crypto.randomBytes` 在测试中可通过 `mock.method` 替换成确定序列
- 订单号生成用**可注入的 ULID/UUID 提供者**,测试传固定值

## 7. 测试脚本

`package.json`:
```json
{
  "scripts": {
    "test:commercial:unit":  "tsx --test packages/commercial/src/**/__tests__/*.test.ts",
    "test:commercial:integ": "tsx --test packages/commercial/src/**/__tests__/*.integ.test.ts",
    "test:commercial": "npm run test:commercial:unit && npm run test:commercial:integ",
    "test": "npm run test:gateway && npm run test:web && npm run test:commercial"
  }
}
```

## 8. TDD 工作流(每个 Task 必须遵守)

```
1. 读 07-TASKS 中该 task 的 "Acceptance"
2. 在 __tests__/ 下新建(或打开)测试文件
3. 写一个会失败的测试,覆盖 task 要实现的**一个**行为
4. 运行 → 红色
5. 写最小实现代码让测试变绿
6. 运行 → 绿色
7. 重构(保持绿色)
8. 回到 3,下一个行为
9. 所有 Acceptance 条目都有测试 + 绿色 → task 完成
10. `npm run check` 最终验证
```

**禁止**:先写完代码再补测试(这样测试容易追认实现而不是验证规格)。

## 9. CI(暂缺,记账)

MVP 在本地 `npm run check` 就当 CI。V2 接入 GitHub Actions:
- PR:lint + typecheck + unit
- merge to v2:+ integ + deploy

---

## 常用断言模板

### 单元:密码哈希
```ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../passwords.ts';

describe('passwords', () => {
  test('hash and verify roundtrip', async () => {
    const hash = await hashPassword('correct horse battery staple');
    assert.ok(hash.startsWith('$argon2id$'));
    assert.equal(await verifyPassword('correct horse battery staple', hash), true);
    assert.equal(await verifyPassword('wrong', hash), false);
  });
});
```

### 集成:注册接口
```ts
describe('POST /api/auth/register', () => {
  test('rejects duplicate email', async () => {
    await seedUser({ email: 'a@b.com' });
    const res = await request('POST', '/api/auth/register', {
      email: 'a@b.com', password: 'strong123',
      turnstile_token: 'ok'
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'ERR_CONFLICT');
  });
});
```

Last updated: 2026-04-17
