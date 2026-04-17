# 07 任务清单(TASKS)

本文件是**开发执行单**。每个任务都有:
- **依赖**:必须先完成的任务
- **Acceptance**:验收条件(即 TDD 的测试目标)
- **Status**:`[ ] todo` / `[~] doing` / `[x] done` / `[!] blocked`

**执行协议**:
1. 从最靠前的 `[ ] todo` 任务开始
2. 先读引用的文档条目
3. 按 06-TEST-STRATEGY §8 的 TDD 循环实现
4. 完成后就地更新状态 + 附简短完成说明(commit hash / 备注)
5. `git add . && git commit -m "task(NN): ..."`(不要合并 task)

---

## Phase 0 - 基础设施(共 ~5 task)

### T-00 目录初始化 + workspace 注册
**依赖**: 无
**文档**: 02-ARCH §2, 00-README

**内容**:
- [ ] 新建 `packages/commercial/`,含 `package.json`(workspace sub-package)、`tsconfig.json`
- [ ] 在根 `package.json` 的 `workspaces` 数组加 `"packages/commercial"`
- [ ] 目录结构按 02-ARCH §2 创建空目录(auth/billing/payment/account-pool/agent-sandbox/admin/db/crypto)
- [ ] 根 `package.json` scripts 加 `test:commercial:unit` / `test:commercial:integ` / `test:commercial` / 更新 `test` 聚合
- [ ] `packages/commercial/src/index.ts` 导出一个空的 `registerCommercial(app): Promise<void>`

**Acceptance**:
- [x] `ls packages/commercial/src/{auth,billing,payment,account-pool,agent-sandbox,admin,db,crypto}` 全部存在
- [x] `tsc -p packages/commercial/tsconfig.json --noEmit` 通过(空模块)
  - 注:根 `npm run typecheck` 有既存的 `storage/hubStore.ts` 错误,与本 task 无关,本 task 仅保证 commercial 包自己干净

**Status**: `[x] done` — 2026-04-17

完成说明:
- 新建 `packages/commercial/` 子包,含 package.json/tsconfig.json/src/index.ts
- 建立目录骨架 `{auth,billing,payment/hupijiao,account-pool,agent-sandbox,admin,db/migrations,crypto,__tests__}`
- 每个目录放 `.gitkeep` 保留
- 根 package.json 的 workspaces 添加 `"packages/commercial"`
- scripts 加 `test:commercial:unit` / `test:commercial:integ` / `test:commercial` / `migrate:commercial`
- scripts `typecheck` 末尾追加 commercial tsconfig
- `scripts.test` 追加 `test:commercial:unit`(integ 留给后续 task 按需跑,不纳入默认 test)
- 空壳 `registerCommercial()` 导出,后续 task 填充
- `npm install` 已执行,165 packages OK

---

### T-01 数据库依赖 & 连接池
**依赖**: T-00
**文档**: 02-ARCH §3, 03-DATA-MODEL

**内容**:
- [ ] 添加 dep: `pg` (8.x), `pg-pool` 随之;dev-dep:`@types/pg`
- [ ] `src/db/index.ts`:创建 `getPool(): Pool` 单例,参数从 env(`DATABASE_URL`),max=50
- [ ] `src/db/queries.ts`:提供 `query(sql, params)`, `tx(fn)`(事务辅助)
- [ ] `src/config.ts`:env 解析(用 zod schema 校验)

**Acceptance**:
- [x] 单元:`config.test.ts` 验证 env 缺失/非法时抛异常(8 tests,全绿)
- [x] 集成:起 pg test 容器,连接成功,`SELECT 1` 返回 `{?column?: 1}`(6 tests,全绿)
- [x] `query` 强制参数化(`queries.ts` 不暴露任何接受动态表名/列名的 API;`truncateAll` 白名单校验)

**Status**: `[x] done` — 2026-04-17

完成说明:
- dep: `pg@^8.20.0`, `zod@^4.3.6`;dev-dep: `@types/pg@^8.20.0`
- `src/config.ts`:
  * URL 字段走协议白名单 — `DATABASE_URL` 只接受 `postgres://|postgresql://`,`REDIS_URL` 只接受 `redis://|rediss://`,拒 http/ftp/file/mysql 等
  * `COMMERCIAL_ENABLED` 严格用 `z.enum(["0","1"]).optional()`,任何其他值(true/yes/01/"" 等)直接 ConfigError,避免部署错误被静默掩盖
  * `ConfigError` 携带 `issues[]`,error 消息不回显原始 env 值(防 secret 泄漏)
- `src/db/index.ts`:
  * `createPool/getPool/setPoolOverride/resetPool/closePool`,max=50,idle 30s,connect 5s
  * `statement_timeout=30s` 走 pg `PoolConfig.statement_timeout` (startup parameter,握手期下发,无竞态)
  * `positiveInt()` 对所有整数选项做运行时正整数校验
  * `setPoolOverride` 拒绝覆盖已存在的不同 pool(抛错要求先 closePool)
  * `resetPool` 改成 async,等价于 closePool(不再"只丢引用"伪装安全 API)
- `src/db/queries.ts`:`query(sql, params)` 单条参数化 + `tx(fn)` 事务(rollback 失败不遮蔽原错误);**不提供**任何破坏性 helper(TRUNCATE/DROP 都不在生产模块)
- `src/__tests__/helpers/db.ts`(新建 test-only helper):`truncateAllForTest` 用两层防护 — (a) 运行时 `SELECT current_database()` 库名必须 `/_test$/`,(b) 表名白名单 `/^[a-z_][a-z0-9_]*$/`
- `tests/fixtures/docker-compose.test.yml`:pg:15 在 55432、redis:7 在 56379(127.0.0.1 绑定、非标端口防冲突);两容器 healthcheck
- `src/__tests__/config.test.ts`(13 tests):env 解析/默认值/缺失/非法 URL/错误协议/`postgresql://` 变体/`rediss://` 变体/`COMMERCIAL_ENABLED` 严格模式/`ConfigError.issues` 结构/error 消息不泄露 secret
- `src/__tests__/db.integ.test.ts`(8 tests):pool 连通、参数化抗 SQL 注入、tx commit、tx rollback、`truncateAllForTest` 拒坏表名、拒非 `_test` 库(stub runner 测)、`statement_timeout` 下发、`setPoolOverride` 拒重复覆盖
- 集成测试:`probe()` 未启动 pg 时本地 skip,CI (`CI=true` 或 `REQUIRE_TEST_DB=1`) 时 fail fast
- 根 `package.json` 的 `test` 聚合改为 `test:commercial`(同时跑 unit+integ);`test:commercial:*` 脚本改用 `find ... -name '*.test.ts' ! -name '*.integ.test.ts'` 和 `-name '*.integ.test.ts'` 拆分,规避 `**` 在 shell 下不展开
- Codex 双审:经 3 轮迭代
  * Round 1 (1 BLOCKER + 4 MAJOR + 1 MINOR):truncateAll 移 helper / statement_timeout 改原生字段 / URL 协议白名单 / pool override 收紧 / integ fail-fast / 枚举严格
  * Round 2 (1 MAJOR + 1 MINOR):根 `test` 聚合纳入 integ / stub runner 改显式 `QueryRunner`
  * Round 3:PASS
- typecheck: commercial 包 0 错误
- 测试:`npm run test:commercial` unit 13/13 + integ 8/8 全绿;`npm test` 整体 123 tests,commercial 全绿;有 4 个 pre-existing failure 在 gateway `ccbMessageParser`/`security.test.ts`(stash 后同样失败,v2 baseline 历史问题,另行处理)

---

### T-02 迁移系统
**依赖**: T-01
**文档**: 03-DATA-MODEL(末尾迁移清单)

**内容**:
- [ ] `src/db/migrate.ts`:
  - 建 `schema_migrations` 表(若无)
  - 扫描 `src/db/migrations/*.sql` 按文件名排序
  - 对未应用的每个文件:`BEGIN → 执行 → INSERT schema_migrations → COMMIT`
  - 任一失败 → `ROLLBACK` 且整体退出非 0
- [ ] 写前 2 个迁移文件:`0001_init_users_auth.sql`、`0002_init_billing.sql`(按 03-DATA-MODEL 的 DDL)
- [ ] CLI 入口:`npm run migrate:commercial` → 执行迁移
- [ ] 启动时自动执行(可通过 env `COMMERCIAL_AUTO_MIGRATE=0` 关闭)

**Acceptance**:
- [x] 集成:空库 → migrate → 期望表都存在(users/email_verifications/refresh_tokens/model_pricing/credit_ledger/usage_records/schema_migrations),`schema_migrations` 有 2 条
- [x] 集成:再跑一次 migrate → 幂等,不重复插入(applied=0, skipped=2)
- [x] 集成:人为改坏 0002(INSERT 不存在表)→ migrate 抛 nonexistent_table → 表结构回到 0001 状态(good_one 留下,bad_two 被 rollback)

**Status**: `[x] done` — 2026-04-17

完成说明(经 Codex 5 轮 review 迭代):
- `src/db/migrate.ts`:
  * 目录默认指向 `migrate.ts` 同级 `migrations/`(相对 import.meta.url,不受 cwd 影响)
  * `SCHEMA_MIGRATIONS_DDL` 用 `IF NOT EXISTS` 启动幂等
  * 并发策略:migrate 期间借一个独立 client 持有 session-level `pg_advisory_lock(0x0cbe1e5a01n)`,**在同一个持锁 client 上直接 BEGIN/COMMIT**(round 1 fix:不再借第二个 client 跑 tx —— 避免 pool.max=1 时双 client 死锁边界)
  * 每个迁移单独事务:`BEGIN → 执行 SQL → INSERT schema_migrations → COMMIT`,失败 ROLLBACK;不自动回滚已 applied
  * 完整性校验 `verifyIntegrity()`(round 1 fix):(a) 已 applied 的 version 必须在 dir 有 `.sql`(防止历史迁移被删造成静默漂移);(b) 新增 unapplied 的版本必须严格 > max(applied)(防止回填低号 out-of-order),违反抛 `MigrationIntegrityError`
  * unlock 错误处理(round 2/3 fix):内层 finally 用 try/catch 吞掉 `pg_advisory_unlock` 自身错误并仅 log,同时把 unlock error 传给外层 `client.release(err)`,**让 pg 销毁这个 client 而不是还回池** —— 防止未清理的 session lock 跟着连接复用卡死后续 migrate;同时保证原始 migration error 不被 unlock 异常遮蔽
  * 只扫 `*.sql`,`README.md`/`.bak` 等忽略
  * CLI 入口:`fileURLToPath(import.meta.url) === argv[1]` → 走 main → closePool → exit code
- `src/db/migrations/0001_init_users_auth.sql`:users(含 CHECK role/status + 部分索引)/email_verifications/refresh_tokens 及其索引,严格按 03-DATA-MODEL
- `src/db/migrations/0002_init_billing.sql`:model_pricing/credit_ledger(含 RULE 拦 UPDATE/DELETE)/usage_records;usage_records.account_id 先建成 BIGINT NULL 不加 FK,0004 会 ALTER ADD FK(避免跨迁移依赖锁死)
- `src/index.ts`:`registerCommercial(app)` 启动时自动 runMigrations;新增 `shouldAutoMigrate(env, warn?)` 旋钮三段语义(round 1 fix):未设/空串/"1" → true;"0" → false;其他值(如 "true"/"false"/"yes")仍然返回 true **但打 warning** 提示该值未被识别,避免"以为自己关了但其实没关"的脚枪(区别于 COMMERCIAL_ENABLED 的严格枚举)
- CLI 验证:`DATABASE_URL=... REDIS_URL=... npm run migrate:commercial` 两次运行 → 第一次 applied=2 skipped=0,第二次 applied=0 skipped=2
- `src/__tests__/migrate.integ.test.ts`(9 tests):
  * 空库 → 建表 + schema_migrations 准确
  * 二次运行幂等
  * 坏 SQL 回滚(0001_good 存活 + 0002_bad 回滚)
  * 文件名 lexical 顺序
  * 非 `*.sql` 文件过滤
  * 0001 关键列回归
  * credit_ledger RULE 拦住 UPDATE/DELETE
  * 完整性:已 applied 的文件被删除 → MigrationIntegrityError
  * 完整性:回填低号版本(out-of-order)→ MigrationIntegrityError
- `src/__tests__/auto_migrate_flag.test.ts`(6 tests):toggle 三段语义 + 默认 console.warn 劫持验证(round 2 fix:用 `mock.method(console, "warn")` 真正拦截并断言调用次数/内容)
- `src/__tests__/migrate_unlock_failure.test.ts`(3 tests,round 3/4 新增):unlock 失败 client 销毁、happy path release 无参、migration+unlock 同时失败时原始 migration error 仍向外传播
- 测试汇总:unit 22/22 + integ 17/17 = 39 全绿;typecheck 干净
- Codex review:round 1 发现 2 MAJOR + 1 MINOR → 修复;round 2 发现 1 MAJOR + 1 MINOR → 修复;round 3 发现 1 MAJOR → 修复;round 4 发现 1 MINOR → 修复;round 5 PASS

---

### T-03 完成剩余迁移文件
**依赖**: T-02
**文档**: 03-DATA-MODEL §3-§14

**内容**:
- [ ] `0003_init_payment.sql` (orders / topup_plans)
- [ ] `0004_init_account_pool.sql` (claude_accounts)
- [ ] `0005_init_agent.sql` (agent_subscriptions / agent_containers / agent_audit)
- [ ] `0006_init_audit.sql` (admin_audit / rate_limit_events)
- [ ] `0007_seed_pricing.sql` (model_pricing + topup_plans 种子)

**Acceptance**:
- [x] 集成:全部迁移应用后,所有表存在,`SELECT COUNT(*) FROM model_pricing` = 2, `topup_plans` = 4
- [x] 集成:credit_ledger/admin_audit 的 append-only RULE 生效(UPDATE/DELETE 无效)
- [x] 集成:usage_records.account_id → claude_accounts.id 的 FK 在 0004 后挂上
- [x] 集成:0007 seed 可重放(ON CONFLICT DO NOTHING,删掉 schema_migrations 重跑不炸、不复制行)

**Status**: `[x] done` — 2026-04-17

完成说明:
- 5 个迁移文件严格按 03-DATA-MODEL §7-§14 的 DDL 落盘
- 0004 负责补 `usage_records.account_id` → `claude_accounts.id` 的 FK(ON DELETE RESTRICT,延续全局约定)
- 0005 `agent_subscriptions` 的 "每用户最多 1 个 active" 用 **partial unique index** `WHERE status='active'`,canceled 后允许再插
- 0006 `admin_audit` 复用 credit_ledger 的 append-only 套路:`CREATE RULE ... DO INSTEAD NOTHING` 拦 UPDATE/DELETE
- 0007 种子用 `ON CONFLICT DO NOTHING`:保证 migrate 幂等,同时不会把管理员通过 admin UI 改过的价格覆盖回默认值
- 新增 `migrate_full.integ.test.ts` 8 个用例,对关键种子值(sonnet input=300、multiplier=2.000、plan-1000 金额/积分)做回归断言
- 扩 `migrate.integ.test.ts` 的 `COMMERCIAL_TABLES` 清单到全部新表,否则 beforeEach 遗漏 DROP 会让 "relation already exists"
- `package.json` 的 `test:commercial:integ` 加 `--test-concurrency=1`:两个 integ 文件默认并行会共用 `openclaude_test` 库互踩,串行稳
- 测试汇总:unit 22/22 + integ 25/25 = **47 全绿**;typecheck 干净

---

### T-04 加密模块 AEAD
**依赖**: T-00
**文档**: 05-SEC §10

**内容**:
- [ ] `src/crypto/keys.ts`:从 env 加载 `OPENCLAUDE_KMS_KEY`(base64 → 32 bytes),错误时抛
- [ ] `src/crypto/aead.ts`:
  - `encrypt(plaintext: string): { ciphertext: Buffer, nonce: Buffer }`
  - `decrypt(ciphertext: Buffer, nonce: Buffer): string`
  - 用 AES-256-GCM(Node 原生 `crypto.createCipheriv('aes-256-gcm', ...)`)
  - 解密后把中间 Buffer `.fill(0)`

**Acceptance**:
- [x] 单元:roundtrip encrypt → decrypt 得回原文(含 AAD 场景)
- [x] 单元:篡改 ciphertext 1 byte / truncate tag / 换 nonce / 换 key / 错 AAD → decrypt 抛 AeadError
- [x] 单元:nonce 唯一性(连续 1000 次生成无重复)
- [x] 单元:错误 env(无 key / 空 / base64 长度不对 16/48)→ 抛 KmsKeyError,消息不回显原 secret

**Status**: `[x] done` — 2026-04-17

完成说明:
- `src/crypto/keys.ts`:`loadKmsKey(env)` 从 `OPENCLAUDE_KMS_KEY` base64 解码,严格校验 32 字节;`KmsKeyError` 不回显原始 env 值;`zeroBuffer(b)` 原地清零
- `src/crypto/aead.ts`:`encrypt(plaintext, key, aad?)` / `decrypt(ct, nonce, key, aad?)`,AES-256-GCM,nonce=12B,tag=16B 拼接在 ciphertext 末尾
  * decrypt tag/AAD 不匹配抛 `AeadError`,原始错误仅作为 cause,message 不暴露 OSSL 细节
  * decrypt 内部明文 Buffer 在 toString 后 fill(0) 清零
  * 不提供"确定性 nonce"接口(GCM 下 nonce 重用会彻底破坏 IND-CPA)
- 测试 18 个 crypto 用例(crypto.test.ts):key 加载四种失败路径、roundtrip、篡改/nonce/key/AAD/truncation 五类 detect、nonce 1000 次唯一性、ciphertext 不泄漏明文长度模式
- 测试汇总:unit 42/42 全绿;typecheck 干净

---

## Phase 1 - 认证与用户(共 ~6 task)

### T-10 密码哈希
**依赖**: T-00
**文档**: 05-SEC §1

**内容**:
- [ ] dep: `argon2` (node)
- [ ] `src/auth/passwords.ts`:`hashPassword(p) → string`, `verifyPassword(p, hash) → boolean`
- [ ] 参数固定:`memory=64MiB, iters=3, parallelism=1, type=argon2id`

**Acceptance**:
- [x] 单元:roundtrip、wrong password 返回 false、hash 前缀 `$argon2id$`
- [x] 单元:两次 hash 同密码结果不同(salt 随机)
- [x] 单元:malformed hash 返回 false 不抛(防侧信道)
- [x] 单元:超长密码不会被静默截断匹配

**Status**: `[x] done` — 2026-04-17

完成说明:
- dep `argon2@^0.44.0`(workspace `packages/commercial`)
- `src/auth/passwords.ts`:`hashPassword(p)` 返回 PHC string;`verifyPassword(p, hash)` 任何错误统一返回 false 不抛
- 参数固化在 `PASSWORD_HASH_PARAMS`:argon2id / mem 64 MiB / iters 3 / parallelism 1 / hashLength 32(05-SEC §1)
- 测试 9 个用例:PHC 格式、roundtrip、wrong/empty pwd、malformed hash、随机 salt、非 string 边界、长密码不截断
- 测试汇总:unit 51/51 全绿

---

### T-11 JWT 签发与校验
**依赖**: T-00
**文档**: 05-SEC §2

**内容**:
- [ ] dep: `jose` (推荐,比 `jsonwebtoken` 现代)
- [ ] `src/auth/jwt.ts`:
  - `signAccess(payload)` → `{ token, exp }`(15min)
  - `verifyAccess(token)` → payload 或抛
  - `issueRefresh()` → `{ token, hash, expires_at }`(随机 32 bytes)
- [ ] 常量:15min / 30d

**Acceptance**:
- [ ] 单元:签发 → 校验通过
- [ ] 单元:算法混淆攻击(alg=none)被拒
- [ ] 单元:过期 token 校验失败(用 mock timers 快进 16min)
- [ ] 单元:secret 变化后旧 token 失效

**Status**: `[ ] todo`

---

### T-12 注册流程
**依赖**: T-02, T-10
**文档**: 04-API §1, 05-SEC §1/§7/§15

**内容**:
- [ ] `src/auth/register.ts`:`register({email,password,turnstileToken})`
  - 入参 zod 校验
  - Turnstile 远程校验(测试用 dummy key 跳过)
  - email unique 检查
  - argon2 hash
  - INSERT users
  - 生成 email verification token → INSERT email_verifications
  - 发邮件(接口:`sendMail(to, subject, body)`,MVP 先 stub 打 log)
- [ ] `src/auth/middleware.ts` 暂不挂路由,先纯函数

**Acceptance**:
- [ ] 集成:正常注册 → users 有一条 + email_verifications 有一条 + log 显示邮件发出
- [ ] 集成:重复 email → 抛 CONFLICT
- [ ] 集成:弱密码(< 8)→ VALIDATION

**Status**: `[ ] todo`

---

### T-13 邮箱验证 + 密码重置
**依赖**: T-12

**内容**:
- [ ] `verifyEmail(token)`:按 token_hash 查、未过期、未使用 → UPDATE users.email_verified=true + UPDATE used_at
- [ ] `requestPasswordReset(email)`:生成 token、发邮件、不管 email 是否存在都返回相同响应(防枚举)
- [ ] `confirmPasswordReset(token, newPassword)`:校验 token → 更新密码 → 标记 used + 吊销所有 refresh token

**Acceptance**:
- [ ] 集成:正确 token verify 成功、token 复用失败、过期 token 失败
- [ ] 集成:不存在邮箱的重置请求返回 200 且无 DB 行变化(除限流)
- [ ] 集成:重置成功后,原有 refresh token 全部被吊销

**Status**: `[ ] todo`

---

### T-14 登录 + Refresh
**依赖**: T-11, T-12
**文档**: 04-API §1, 05-SEC §2/§3

**内容**:
- [ ] `login({email,password,turnstileToken,userAgent,ip})` → `{access,refresh,user}`
  - 校验密码
  - 未验证邮箱:允许登录但 user 对象标记 `email_verified=false`(前端提示验证)
  - 签发 access + refresh,refresh 入库 sha256 hash
- [ ] `refresh({refresh_token})` → 新 access
  - 查 refresh_tokens(revoked_at IS NULL AND expires_at > now())
- [ ] `logout({refresh_token})`:置 revoked_at
- [ ] 限流:在集成测试中用 Redis 实现(见 T-15)

**Acceptance**:
- [ ] 集成:正确密码登录 → 返回 token + DB 有 refresh 记录
- [ ] 集成:错误密码 → UNAUTHORIZED 不泄露原因
- [ ] 集成:refresh 正常 → 新 access
- [ ] 集成:logout 后 refresh 失效

**Status**: `[ ] todo`

---

### T-15 限流中间件
**依赖**: T-01
**文档**: 05-SEC §3, 04-API 末尾

**内容**:
- [ ] dep: `ioredis`
- [ ] `src/middleware/rateLimit.ts`:`rateLimit({scope, keyBy, window, max})` 中间件工厂
- [ ] 实现滑动窗口(固定窗口近似已足够 MVP):Redis INCR + EXPIRE
- [ ] 超限:返回 429 + `Retry-After`,写 `rate_limit_events`

**Acceptance**:
- [ ] 单元:在 mock redis 上验证计数 + 过期
- [ ] 集成:连续 6 次 login 触发 429(配 5/min)

**Status**: `[ ] todo`

---

### T-16 认证中间件 + 路由挂载
**依赖**: T-14, T-15
**文档**: 02-ARCH §8, 04-API §1

**内容**:
- [ ] `src/auth/middleware.ts`:`requireAuth(req)` → 解析 Bearer token,注入 `req.user`,失败 401
- [ ] `src/index.ts` 的 `registerCommercial(app)`:
  - 挂载路由 `/api/auth/*`(前缀统一 `/api/...`)
  - 挂所有必要中间件:request-id → logger → cors → security-headers → rateLimit → 路由
- [ ] `packages/gateway/src/server.ts` 加条件挂载(见 02-ARCH §8)
- [ ] 所有全局安全 headers(05-SEC §6)统一中间件设置

**Acceptance**:
- [ ] 集成:完整端到端注册 → 登录 → 用 access 访问 `/api/me` → 返回用户信息
- [ ] 集成:不带 token 访问 → 401
- [ ] 集成:过期 token → 401
- [ ] 集成:启动 Gateway(COMMERCIAL_ENABLED=1)后 `/healthz` 正常响应
- [ ] 集成:响应头含 HSTS/X-Content-Type-Options/CSP

**Status**: `[ ] todo`

---

## Phase 2 - 计费与支付(共 ~5 task)

### T-20 定价查询 + 缓存
**依赖**: T-02, T-03
**文档**: 03-DATA-MODEL §4, 04-API §8

**内容**:
- [ ] `src/billing/pricing.ts`:`getPricing(modelId)` → `{input, output, cache_read, cache_write, multiplier}`
- [ ] 启动加载全表到内存 Map
- [ ] 监听 Postgres `LISTEN pricing_changed`(`NOTIFY` 由 admin 改价时触发)→ 重新加载
- [ ] `GET /api/public/models`:返回启用模型列表(带预估价格字段)

**Acceptance**:
- [ ] 单元:已知 modelId → 返回正确价格
- [ ] 集成:UPDATE model_pricing → NOTIFY → 内存更新(测试用 sleep 100ms)

**Status**: `[ ] todo`

---

### T-21 扣费计算器
**依赖**: T-20
**文档**: 01-SPEC F-2, 03-DATA-MODEL §4/§6

**内容**:
- [ ] `src/billing/calculator.ts`:
  - `computeCost(usage, pricing)` → `{cost_credits, snapshot}`
  - 4 维 token 分别算:`(tok/1_000_000) * per_mtok_price * multiplier`
  - 所有算术用 BigInt,最后向上取整到分
  - snapshot 包含当时所有价格字段(可审计)

**Acceptance**:
- [ ] 单元:已知 usage + pricing → 已知 cost(若干 case)
- [ ] 单元:极大 token 不溢出(BigInt 保证)
- [ ] 单元:极小 usage 不为 0(向上取整保证至少 1 分)

**Status**: `[ ] todo`

---

### T-22 流水 + 余额(事务)
**依赖**: T-02, T-21
**文档**: 01-SPEC F-2, 03-DATA-MODEL §1/§5

**内容**:
- [ ] `src/billing/ledger.ts`:
  - `debit(user_id, amount, reason, ref)` → 事务
    - `SELECT credits FROM users WHERE id=$1 FOR UPDATE`
    - 余额 < amount → 抛 `ERR_INSUFFICIENT_CREDITS`
    - `UPDATE users SET credits = credits - amount`
    - `INSERT credit_ledger (..., balance_after=new_credits)`
    - 返回 `{ledger_id, balance_after}`
  - `credit(user_id, amount, reason, ref)` → 同结构,正数
  - `adminAdjust(user_id, delta, memo, admin_id)` → 调整 + 写 admin_audit

**Acceptance**:
- [ ] 集成:正常扣费 → users.credits 减 + ledger 有记录
- [ ] 集成:余额不足 → 抛 + users.credits 未变
- [ ] 集成:并发 10 个 debit(只够扣 5 次)→ 严格 5 成功 5 失败
- [ ] 集成:ledger UPDATE/DELETE 被 RULE 拦住

**Status**: `[ ] todo`

---

### T-23 预检中间件 + chat 接口骨架
**依赖**: T-22, T-16
**文档**: 04-API §5, 05-SEC §15

**内容**:
- [ ] `src/billing/preCheck.ts`:
  - 根据 req.body 的 `model` + `max_tokens` 估算 `max_cost`
  - Redis 预锁 `precheck:user:<id>:<req_id>` TTL 5min
  - 余额 < max_cost → 403 `ERR_INSUFFICIENT_CREDITS`
- [ ] `POST /api/chat` 骨架(**不接真 Claude**,先 mock 返回固定 usage):
  - 经过预检 → mock LLM → 按 usage 扣费 → 返回
- [ ] 释放预锁

**Acceptance**:
- [ ] 集成:余额足够 → 200 + 扣费正确
- [ ] 集成:余额不足 → 402 + 未扣费
- [ ] 集成:mock LLM 异常 → 不扣费(预锁过期释放)

**Status**: `[ ] todo`

---

### T-24 虎皮椒支付
**依赖**: T-22
**文档**: 01-SPEC F-3, 04-API §4, 05-SEC §11

**内容**:
- [ ] `src/payment/hupijiao/sign.ts`:MD5 签名(按虎皮椒规范)
- [ ] `src/payment/hupijiao/client.ts`:`createQr(order)` 调虎皮椒 API
- [ ] `src/payment/orders.ts`:订单状态机
- [ ] `POST /api/payment/hupi/create`:
  - 校验 plan_code 存在且 enabled
  - 生成 order_no(ULID),INSERT orders status=pending, expires_at=now+15min
  - 调虎皮椒 → 拿 qrcode_url
  - 返回
- [ ] `POST /api/payment/hupi/callback`:
  - 解析 form-urlencoded
  - 校验签名(错 → 400)
  - 查 orders by order_no,已 paid → 返回 success(幂等)
  - 事务:status=paid + credit(user, plan.credits, 'topup', order_id) + UPDATE ledger_id
  - 返回 text "success"
- [ ] `GET /api/payment/orders/:order_no`
- [ ] 定时任务:扫 pending 且 expires_at < now → status=expired(每 5min)

**Acceptance**:
- [ ] 单元:sign 输入已知 payload → 已知 md5(用虎皮椒文档示例)
- [ ] 集成:create → 本地 orders 状态 pending;过期 15min → 自动 expired
- [ ] 集成:callback 签名错 → 400
- [ ] 集成:callback 正确 → status=paid + 积分到账 + ledger 记录
- [ ] 集成:callback 重复 → 仍返回 success + 积分只加一次

**Status**: `[ ] todo`

---

## Phase 3 - 账号池(共 ~4 task)

### T-30 账号 CRUD + 加密存储
**依赖**: T-03, T-04
**文档**: 03-DATA-MODEL §7, 05-SEC §10/§12

**内容**:
- [ ] `src/account-pool/store.ts`:
  - `createAccount({label,plan,token,refresh,expires_at})` → 加密后 INSERT
  - `updateAccount(id, partial)` → 包括可选更新 token(重新加密)
  - `listAccounts()` → 不含 token 字段(或含密文但不解密)
  - `getTokenForUse(id)` → 解密后内存对象,调用方用完 `.fill(0)`
  - `deleteAccount(id)`

**Acceptance**:
- [ ] 集成:create 后 DB 里 oauth_token_enc 是密文(非原文)
- [ ] 集成:getTokenForUse 解密还原
- [ ] 集成:篡改密文 1 byte → 解密失败

**Status**: `[ ] todo`

---

### T-31 健康度 + 熔断
**依赖**: T-30
**文档**: 01-SPEC F-6, 02-ARCH §5.1

**内容**:
- [ ] `src/account-pool/health.ts`:
  - `onSuccess(id)` → success_count++, health += 10 (cap 100), last_used = now
  - `onFailure(id, error)` → fail_count++, health -= 20, 连续 3 次失败 → status=cooldown + cooldown_until = now + 10min
  - `halfOpen()`:扫 cooldown_until < now 的账号 → status=active, health=50
  - `manualDisable(id)` / `manualEnable(id)`
- [ ] Redis 缓存最近 health 分数(减 DB 压力)

**Acceptance**:
- [ ] 单元:3 次失败触发熔断,cooldown_until 设对
- [ ] 单元:halfOpen 恢复 cooldown 过期账号
- [ ] 集成:DB 行和 Redis 一致

**Status**: `[ ] todo`

---

### T-32 调度器
**依赖**: T-31
**文档**: 01-SPEC F-6.4

**内容**:
- [ ] `src/account-pool/scheduler.ts`:
  - `pick({mode, session_id, model})` → `{account_id, token}`
  - mode=agent:按 session_id 哈希 → 稳定选一个(sticky)
  - mode=chat:按 health_score 加权随机
  - 无可用 → 抛 `ERR_ACCOUNT_POOL_UNAVAILABLE`
- [ ] `release({account_id, result})` 触发 health 更新

**Acceptance**:
- [ ] 单元:sticky 对同 session_id 稳定
- [ ] 单元:sticky 账号不可用时 fallback 到其他账号
- [ ] 单元:chat 模式加权分布大致符合(大量采样统计)
- [ ] 单元:全部 cooldown → 抛 503

**Status**: `[ ] todo`

---

### T-33 Token 刷新 + Claude API 代理
**依赖**: T-32
**文档**: 01-SPEC F-6.7

**内容**:
- [ ] `src/account-pool/refresh.ts`:
  - 检测 token 即将过期(< 5min) → 调 Anthropic OAuth refresh endpoint
  - 成功 → 更新加密 token + expires_at
  - 失败 → 账号 status=disabled + 告警
- [ ] `src/account-pool/proxy.ts`:
  - `streamClaude({account, body}) → AsyncIterable<event>`
  - 用 `fetch` + ReadableStream 读 SSE
  - 透传到调用方

**Acceptance**:
- [ ] 集成:mock Anthropic API → 正常流式
- [ ] 集成:token 过期 mock → 调 refresh → 拿新 token → 重试
- [ ] 集成:refresh 失败 → account disabled + 抛

**Status**: `[ ] todo`

---

## Phase 4 - Chat 主流程(共 ~2 task)

### T-40 Chat WebSocket
**依赖**: T-23, T-33
**文档**: 04-API §5

**内容**:
- [ ] `ws /ws/chat`:在 gateway 里新增 ws 路由
- [ ] 握手时 `?token=` 校验
- [ ] 前端 send `start` frame → 服务端走完整链:preCheck → scheduler.pick → proxy.streamClaude → 转发 delta → debit → done
- [ ] 同用户 >3 连接 → 最老的那个被 kick

**Acceptance**:
- [ ] 集成(用 ws client 模拟):stream 正常、usage frame、debit frame、done frame
- [ ] 集成:断开连接时释放预锁
- [ ] 集成:账号池 503 → error frame

**Status**: `[ ] todo`

---

### T-41 Chat REST 备用
**依赖**: T-40

**内容**:
- [ ] `POST /api/chat`:非流式,内部聚合所有 delta 返回一次

**Acceptance**:
- [ ] 集成:请求 → 单次 JSON 响应,含 content + usage + cost_credits

**Status**: `[ ] todo`

---

## Phase 5 - Agent 沙箱(共 ~5 task)

### T-50 Docker API 封装
**依赖**: T-00
**文档**: 02-ARCH §4.2, 05-SEC §13

**内容**:
- [ ] dep: `dockerode`
- [ ] `src/agent-sandbox/supervisor.ts`:
  - `createContainer(uid, opts)` → create + start
  - `stopContainer(uid)`, `removeContainer(uid)`
  - `getContainerStatus(uid)` → docker inspect
  - 启动参数严格按 05-SEC §13
- [ ] 预留 `agent-net` bridge 网络自动创建(若不存在)

**Acceptance**:
- [ ] 集成(需本地 docker):createContainer → inspect → 看到预期 limits
- [ ] 集成:stop → running=false;remove → container 不存在

**Status**: `[ ] todo`

---

### T-51 镜像 `openclaude/agent-runtime`
**依赖**: T-50

**内容**:
- [ ] `deploy/commercial/agent-runtime/Dockerfile`
  - base: `node:22-slim`
  - 装 bun + 必要工具(git, curl, ripgrep)
  - COPY 一个简化 CCB 实例源代码(或直接装 ccb 包)
  - 非 root 用户 `agent`(uid 1000)
  - ENTRYPOINT 跑 agent RPC server(pending T-52 详细)
- [ ] 本地 `docker build` 成功

**Acceptance**:
- [ ] `docker build` 成功
- [ ] `docker run --rm openclaude/agent-runtime whoami` → `agent`

**Status**: `[ ] todo`

---

### T-52 Agent 内 RPC server + Gateway 代理
**依赖**: T-51

**内容**:
- [ ] 容器内 `supervisor.sh` 启动 RPC server,监听 `/var/run/agent-rpc.sock`
- [ ] 协议:长连接,JSON lines,转发 stream-json 与 Gateway
- [ ] Gateway `/ws/agent`:接 ws + 打开容器 unix socket → 双向 pipe
- [ ] 每个工具调用经过 Gateway 代理(便于计费和审计)

**Acceptance**:
- [ ] 集成:Gateway → ws → container echo hello 回流
- [ ] 集成:工具调用 tool=bash,命令 `echo hi` → 输出正确 + audit 写入

**Status**: `[ ] todo`

---

### T-53 Agent 订阅 + 生命周期
**依赖**: T-50, T-22
**文档**: 01-SPEC F-5

**内容**:
- [ ] `POST /api/agent/open`:扣积分 ¥29×100 = 2900 分(折算 29 积分) + INSERT agent_subscriptions + 触发 supervisor.provision
- [ ] `GET /api/agent/status`
- [ ] 定时任务 `lifecycle.ts`(每小时):
  - end_at < now → status=expired + stopContainer + volume_gc_at=now+30d
  - volume_gc_at < now → removeVolume + agent_containers.status=removed
- [ ] `POST /api/agent/cancel`:置 auto_renew=false(本期仍有效)

**Acceptance**:
- [ ] 集成:open → 扣积分 + container provisioning → 轮询到 running
- [ ] 集成:人工改 end_at 到过去 → lifecycle 触发 → container stop
- [ ] 集成:volume_gc_at 过期 → volume 被删
- [ ] 集成:重复 open 同用户 → 409

**Status**: `[ ] todo`

---

### T-54 Agent 审计
**依赖**: T-52, T-03
**文档**: 03-DATA-MODEL §12

**内容**:
- [ ] Gateway 代理工具调用时写 `agent_audit`
- [ ] `GET /api/admin/agent-audit?user_id=&tool=&limit=&before=`(超管可查)
- [ ] 用户自己也能查:`GET /api/agent/audit`(未来,MVP 超管可查即可)

**Acceptance**:
- [ ] 集成:在 agent 里执行 `ls /workspace` → DB 有 1 条 audit,tool=bash,success=true
- [ ] 集成:错误命令 → success=false + error_msg

**Status**: `[ ] todo`

---

## Phase 6 - 超管后台(共 ~3 task)

### T-60 超管 API
**依赖**: T-22, T-30, T-53
**文档**: 04-API §7, 05-SEC §14

**内容**:
- [ ] `src/admin/requireAdmin.ts` 中间件
- [ ] 按 04-API §7 实现全部端点
- [ ] 所有写操作包装 `writeAdminAudit(admin, action, target, before, after)`

**Acceptance**:
- [ ] 集成:非 admin → 403
- [ ] 集成:admin 改倍率 → pricing 更新 + admin_audit 记录
- [ ] 集成:admin 给用户加积分 → users.credits + ledger(reason=admin_adjust) + admin_audit

**Status**: `[ ] todo`

---

### T-61 超管前端(最简)
**依赖**: T-60

**内容**:
- [ ] `packages/web/public/admin.html`:单页面,JWT 登录 + tab 切换
- [ ] tabs:用户 / 账号池 / 定价 / 流水 / Agent 实例 / 审计
- [ ] 表格 + 简单表单,不引入框架,vanilla JS

**Acceptance**:
- [ ] 手动:浏览器登录后能看到所有列表
- [ ] 手动:修改倍率/封禁用户等能走完链

**Status**: `[ ] todo`

---

### T-62 Metrics + 告警
**依赖**: T-60

**内容**:
- [ ] `GET /api/admin/metrics`:输出 Prometheus text
- [ ] 关键指标埋点(02-ARCH §7.2)
- [ ] 告警器:扫指标 + 触发邮件/Telegram(复用 env `ALERT_TG_BOT_TOKEN`/`ALERT_TG_CHAT`)

**Acceptance**:
- [ ] 集成:curl /metrics 看到计数
- [ ] 集成:mock 账号池全部 down → 触发 Telegram 告警消息

**Status**: `[ ] todo`

---

## Phase 7 - 用户前端(共 ~2 task)

### T-70 用户 Web(最简)
**依赖**: T-41, T-24

**内容**:
- [ ] `packages/web/public/app.html` 加商业化版本:登录/注册/充值/聊天 4 页面
- [ ] vanilla JS,复用 04-API
- [ ] 基础 UX:模型选择、余额显示、扣费实时显示

**Acceptance**:
- [ ] 手动 E2E:注册 → 邮件验证 → 登录 → 充值 → 对话

**Status**: `[ ] todo`

---

### T-71 Agent UI
**依赖**: T-52

**内容**:
- [ ] 用户前端加 `agent.html`:订阅状态 + 开通按钮 + Agent 会话窗(简版 terminal/chat)

**Acceptance**:
- [ ] 手动:未订阅 → 显示开通按钮 → 点开通 → 扣积分 → 进入 Agent 会话 → 执行工具
- [ ] 手动:浏览器关闭 24h 后回来,agent 历史仍在

**Status**: `[ ] todo`

---

## Phase 8 - 部署与上线(共 ~3 task)

### T-80 systemd + env 配置模板
**依赖**: 所有 Phase 0-7

**内容**:
- [ ] `deploy/commercial/openclaude-commercial.service`(或复用 openclaude.service,但加 EnvironmentFile)
- [ ] `deploy/commercial/commercial.env.example`
- [ ] `deploy/commercial/install.sh`:本地部署脚本(生成密钥、拷贝 env、systemd enable)

**Acceptance**:
- [ ] 手动:在 38.55 跑 install.sh → 服务起来 → /healthz OK

**Status**: `[ ] todo`

---

### T-81 数据备份脚本
**依赖**: T-80

**内容**:
- [ ] `deploy/commercial/backup.sh`:`pg_dump` + gpg 加密 + rclone 到 R2
- [ ] cron daily 2:00

**Acceptance**:
- [ ] 手动:备份 → 下载 → 解密 → 恢复到新 DB 验证数据完整

**Status**: `[ ] todo`

---

### T-82 安全审查 + 上线 checklist
**依赖**: 全部

**内容**:
- [ ] 逐项打勾 05-SECURITY §20 checklist
- [ ] 人工 pentest 基本路径
- [ ] 依赖扫描
- [ ] 日志抽样脱敏审计
- [ ] 备份恢复演练

**Acceptance**:
- [ ] 全部 checklist 打勾

**Status**: `[ ] todo`

---

## 进度统计

- Phase 0 基础: 5 task (T-00 ~ T-04)
- Phase 1 认证: 7 task (T-10 ~ T-16)
- Phase 2 计费支付: 5 task (T-20 ~ T-24)
- Phase 3 账号池: 4 task (T-30 ~ T-33)
- Phase 4 Chat: 2 task (T-40 ~ T-41)
- Phase 5 Agent: 5 task (T-50 ~ T-54)
- Phase 6 超管: 3 task (T-60 ~ T-62)
- Phase 7 前端: 2 task (T-70 ~ T-71)
- Phase 8 部署: 3 task (T-80 ~ T-82)

**合计 36 task**。每 task 体量 0.5-3 小时不等。

---

## 优先级与冻结

**不得跳过前置依赖直接做靠后的任务**。如果某 task 被 block,标 `[!] blocked` 并说明原因。

**冻结**:完成 T-16(认证闭环)后,如无重大设计变更,**不再回改 auth 模块**(以免反复破坏已通过的测试)。其他 Phase 同理。

Last updated: 2026-04-17
