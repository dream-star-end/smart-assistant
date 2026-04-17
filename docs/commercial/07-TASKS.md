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
- [x] 单元:签发 → 校验通过
- [x] 单元:算法混淆攻击(alg=none / HS512)被拒(algorithms 白名单)
- [x] 单元:过期 token 校验失败(用注入 now 快进 16min)
- [x] 单元:secret 变化后旧 token 失效
- [x] 单元:tampered payload(改 role)签名失效
- [x] 单元:refresh token sha256 哈希基于 raw bytes 不是 base64 字符串
- [x] 单元:refresh token 1000 次唯一性

**Status**: `[x] done` — 2026-04-17

完成说明:
- dep `jose@^5.x`(workspace `packages/commercial`)
- `src/auth/jwt.ts`:
  * `signAccess(payload, secret, opts)` HS256,15min,jti = 16 bytes hex,sub 必须字符串
  * `verifyAccess(token, secret, opts)` jose `algorithms: ['HS256']` 白名单 + 业务字段二次断言(sub/role/iat/exp/jti)
  * `JwtError` 统一错误,分类细分 expired / alg_not_allowed / generic 但消息保持精简,不暴露内部
  * `secretToKey()` 强制 secret ≥ 32 bytes(HS256 安全下限),太短直接抛
  * `issueRefresh()` 32 bytes randomBytes → base64url + sha256 hex,30 day TTL
  * `refreshTokenHash(raw)` 服务端比对入口,**对 raw bytes 做 sha256**(不是对 base64 字符串)
- 16 个单测覆盖签发/过期/算法混淆/篡改/role 缺失/refresh 唯一性/hash 算法正确性
- 测试汇总:unit 69/69 全绿;typecheck 干净

---

### T-12 注册流程
**依赖**: T-02, T-10
**文档**: 04-API §1, 05-SEC §1/§7/§15

**内容**:
- [x] `src/auth/register.ts`:`register({email,password,turnstile_token}, deps)`
  - 入参 zod 校验(email RFC 简化 + 长度上限 254;password 8-72)
  - Turnstile 远程校验(`turnstileBypass=true` 测试跳过)
  - email unique:DB 唯一索引 + 23505 → CONFLICT
  - argon2id hash(复用 T-10)
  - 事务内 INSERT users + email_verifications(purpose=verify_email, 24h TTL)
  - mailer.send(接口 `Mailer.send`,MVP `stubMailer` 打 stdout)
  - mail 失败不回滚 user,返回 `verify_email_sent=false`
- [x] `src/auth/turnstile.ts`:`verifyTurnstile(token, secret, opts)` + `TurnstileError`
- [x] `src/auth/mail.ts`:`Mailer` 接口 + `stubMailer`
- [x] `src/config.ts`:扩 `TURNSTILE_SECRET` + `TURNSTILE_TEST_BYPASS`
- (路由挂载延后到 T-14+,本 task 只要纯函数)

**Acceptance**:
- [x] 集成:正常注册 → users + email_verifications 各一行,mailer 收到含 verify URL 的邮件
- [x] 集成:重复 email → RegisterError code=CONFLICT,无第二行 user
- [x] 集成:弱密码(<8)→ RegisterError code=VALIDATION,无 DB 写入

**实施记录**:
- 测试覆盖:turnstile 单测 8 / mail 单测 1 / register integ 8(含 email 归一化、turnstile 失败、mailer 失败非致命)
- 测试汇总:unit 78/78 + integ 33/33 全绿;typecheck 干净

**Status**: `[x] done`

---

### T-13 邮箱验证 + 密码重置
**依赖**: T-12

**内容**:
- [x] `verifyEmail(rawToken)`:hash → 单事务 SELECT FOR UPDATE → mark used_at + users.email_verified
- [x] `requestPasswordReset(email)`:防枚举(总返回 accepted=true);存在用户才写 reset 行 + 发邮件
- [x] `confirmPasswordReset(rawToken, newPassword)`:argon2 重 hash + mark used + 吊销所有未 revoke 的 refresh token
- [x] `src/auth/verify.ts`:`VerifyError` codes VALIDATION/INVALID_TOKEN/WEAK_PASSWORD
- [x] `RESET_PASSWORD_TTL_SECONDS = 3600`(短于 verify_email 的 24h)

**Acceptance**:
- [x] 集成:正确 token verify 成功、token 复用 → INVALID_TOKEN、过期 → INVALID_TOKEN
- [x] 集成:不存在邮箱的重置请求返回 accepted=true 且 email_verifications 不长行
- [x] 集成:confirmPasswordReset 后所有 active refresh_tokens 被 revoke,old revoked 时间戳不被覆盖

**实施记录**:
- 测试覆盖:verify integ 16(verifyEmail 5 + requestPasswordReset 4 + confirmPasswordReset 6 + 1 跨 purpose)
- 防误用:verify_email token 走 confirmPasswordReset 也只返 INVALID_TOKEN(purpose 隔离)
- 测试汇总:unit 78 + integ 48 全绿;typecheck 干净

**Status**: `[x] done`

---

### T-14 登录 + Refresh
**依赖**: T-11, T-12
**文档**: 04-API §1, 05-SEC §2/§3

**内容**:
- [x] `login({email,password,turnstile_token}, deps)` → `{user, access_token, refresh_token, ...}`
  - zod 校验 + Turnstile + 密码 verify(argon2)
  - 即使 email 不存在也跑一次假 verify(`getDummyHash`),抹平时序侧信道
  - `INVALID_CREDENTIALS` 一律不区分原因(密码错/不存在/被封)
  - 未验证邮箱:允许登录,user 对象 `email_verified=false`
  - 签 access JWT + opaque refresh,refresh 入 `refresh_tokens(token_hash, ip, user_agent, expires_at)`
- [x] `refresh(rawRefresh, deps)` → `{access_token, access_exp}`
  - 查表(token_hash + revoked_at IS NULL + expires_at > now)+ 用户必须 active
  - 失败统一 INVALID_REFRESH;MVP 不轮换 refresh
- [x] `logout(rawRefresh)`:置 revoked_at,幂等(已 revoked / 不存在 → revoked=false)
- [x] LoginError codes:VALIDATION / TURNSTILE_FAILED / INVALID_CREDENTIALS
- [x] RefreshError codes:VALIDATION / INVALID_REFRESH
- (限流由 T-15 单独承担)

**Acceptance**:
- [x] 集成:正确密码登录 → 返回 access+refresh + refresh_tokens 入库;access JWT 可被 verifyAccess 解
- [x] 集成:错误密码 / 不存在 email / banned 用户 → INVALID_CREDENTIALS(同一码,不泄露原因)
- [x] 集成:refresh 正常 → 新 access;过期/已 revoke/banned 用户 → INVALID_REFRESH
- [x] 集成:logout 后 refresh 失效;二次 logout 幂等不报错

**实施记录**:
- 测试覆盖:login integ 8 + refresh integ 7 + logout integ 4 = 19
- 时序公平:`warmupLoginDummyHash()` 模块预热;dummy hash 模块级缓存
- IP 字段用 pg INET,SELECT 时 `host(ip)` 文本化
- 测试汇总:unit 78 + integ 67 全绿;typecheck 干净

**Status**: `[x] done`

---

### T-15 限流中间件
**依赖**: T-01
**文档**: 05-SEC §3, 04-API 末尾

**内容**:
- [x] dep: `ioredis@^5`(已加入 packages/commercial/package.json)
- [x] `src/middleware/rateLimit.ts`:核心是框架无关的 `checkRateLimit(redis, cfg, identifier)` 函数
  - 算法:固定窗口近似(`floor(now/window)*window` 作为窗口起点)
  - 流程:INCR → 首次 EXPIRE → 决策(count <= max)
  - EXPIRE 失败容忍(下个窗口仍能正常 expire,不致命)
  - 返回 `{allowed, count, limit, retryAfterSeconds, key}`,T-16 据此返 429+Retry-After
- [x] `recordRateLimitEvent(scope, identifier, blocked)`:写 rate_limit_events,失败仅 console.error
- [x] `wrapIoredis(client)`:把 ioredis 客户端包成 `RateLimitRedis` 接口,便于 mock
- (HTTP 中间件 wrapping 留给 T-16)

**Acceptance**:
- [x] 单元:mock Redis 上 5+1 次连续请求(max=5)→ 第 6 次拒;窗口滚动后重置;不同 identifier/scope 隔离;EXPIRE 失败不抛
- [x] 集成:真 Redis(127.0.0.1:56379)+ 真 PG;6/min 触发拒;TTL 通过 redis TTL 命令验证

**实施记录**:
- 单测 12(覆盖快慢路径 / 窗口滚动 / 隔离 / EXPIRE 失败 / 入参校验)
- integ 4(真 Redis 限流 + recordRateLimitEvent 写表 + TTL 校验 + 多 key 隔离)
- rate_limit_events 表 schema 是 `(scope, key, blocked, created_at)` — recordRateLimitEvent 已对齐
- 测试汇总:unit 90 + integ 71 全绿;typecheck 干净

**Status**: `[x] done`

---

### T-16 认证中间件 + 路由挂载
**依赖**: T-14, T-15
**文档**: 02-ARCH §8, 04-API §1

**内容**:
- [x] `src/http/auth.ts`:`requireAuth(req, jwtSecret)` → 解析 `Bearer [A-Za-z0-9._-]+`,成功返回 `{id, role, jti}`,失败一律 401 UNAUTHORIZED(不区分缺 token / 过期 / 算法不允许 / 篡改,避免 oracle)
- [x] `src/http/util.ts`:`HttpError` 类 + `sendJson/sendError` + `ensureRequestId(req)` + `readJsonBody(req, 64KiB)` + `setSecurityHeaders(res)`(HSTS/CSP/XCTO/XFO/Referrer-Policy,对齐 05-SEC §6)
- [x] `src/http/handlers.ts`:8 个 handler(register/login/refresh/logout/verify-email/request-password-reset/confirm-password-reset/me),统一把 `RegisterError/LoginError/VerifyError/RefreshError` 映射成 HTTP 码;`/register` `/login` `/request-password-reset` 按 IP 走 T-15 限流(429 + Retry-After + rate_limit_events 记录)
- [x] `src/http/router.ts`:`createCommercialHandler(deps)` → `(req, res) => Promise<boolean>`。命中前缀 `/api/auth/`, `/api/me` 时统一 setSecurityHeaders + ensureRequestId + X-Request-Id 回写;路径不命中返 `false` 让 gateway fall-through;方法不匹配 → 405+Allow;未知路径 → 404
- [x] `src/index.ts` `registerCommercial(app, options?)`:loadConfig → 跑 migrations(除非 COMMERCIAL_AUTO_MIGRATE=0) → 组装 ioredis(lazyConnect:false, enableReadyCheck) → warmupLoginDummyHash → 返 `{handle, shutdown}`(shutdown 清 redis/pool)。JWT secret 从 options / COMMERCIAL_JWT_SECRET / JWT_SECRET 取,都没则直接抛
- [x] `packages/gateway/src/server.ts`:新增 `commercialHandle/commercialShutdown` 字段;`start()` 里当 `COMMERCIAL_ENABLED=1` 时动态 import `@openclaude/commercial` 并装载;`createServer` wrapper 改成先 await commercialHandle(req,res),为 true 直接 return,否则 fall through 到 `handleHttp`;`_doShutdown` 新增 Stage 6 关 commercial

**Acceptance**:
- [x] 集成:完整端到端注册 → 登录 → 用 access 访问 `/api/me` → 返回 `{id, email, email_verified, role, display_name, avatar_url, credits}` — `http.integ.test.ts#end-to-end`
- [x] 集成:不带 token / 过期 token / 乱填 token 访问 → 401 UNAUTHORIZED — `http.integ.test.ts#/api/me without/expired/garbage token`
- [x] 集成:gateway-style wrapper 下 `/healthz` 被 commercial handle 放行,fall through 到 gateway stub 返 200;而 `/api/auth/register` 被 commercial 吃掉,gateway stub 不会命中 — `http.integ.test.ts#commercial + gateway fall-through smoke`
- [x] 集成:所有响应都带 HSTS / X-Content-Type-Options / CSP `default-src 'none'` / X-Frame-Options DENY — `http.integ.test.ts#response carries security headers`
- [x] 集成:wrong method → 405+Allow;body > 64KiB → 413;错 JSON → 400 INVALID_JSON;限流超限 → 429+Retry-After 且 rate_limit_events 写了 blocked=true 行

**测试**: 15 个新 HTTP 集成 + 2 个 gateway fall-through smoke = 17 个 case(全部 pass,作为 commercial 套件的一部分跑)

**Status**: `[x] done` (commit e180114)

---

## Phase 2 - 计费与支付(共 ~5 task)

### T-20 定价查询 + 缓存
**依赖**: T-02, T-03
**文档**: 03-DATA-MODEL §4, 04-API §8

**内容**:
- [x] `src/billing/pricing.ts`:
  - `class PricingCache`:`load()` 一次性把 model_pricing 全表读入内存 Map;`get(modelId)` O(1) 无 I/O;`listPublic()` 过滤 enabled + 按 sort_order 升序 + 计算 `*_per_ktok_credits`
  - `startListener(connString)` 开一个独占 `pg.Client`,`LISTEN pricing_changed`;收到通知 → scheduleReload(合并并发:in-flight 时后来的通知不再新开 load)
  - reload 失败用 `onError` 钩子 + 保留旧缓存(绝不清空,避免热路径瞬间全部 miss)
  - 数值字段 BIGINT 经 pg 返 string,边界一次性 `BigInt(...)`;multiplier NUMERIC(6,3) 保留字符串(`perKtokCredits` helper 用 BigInt 精确算,不过 JS float)
- [x] `src/db/migrations/0008_pricing_notify.sql`:在 model_pricing 挂 AFTER INSERT/UPDATE/DELETE trigger → `pg_notify('pricing_changed','')`。payload 为空,PricingCache 只要收到信号就全表 reload(简单 + 幂等)
- [x] `src/http/handlers.ts` + `router.ts`:`GET /api/public/models` → `{ models: [{id, display_name, input/output/cache_read/cache_write_per_ktok_credits, multiplier}] }`。`CommercialHttpDeps.pricing` 为 optional;未注入时 503 PRICING_NOT_READY
- [x] `src/index.ts` `registerCommercial`:启动时 `new PricingCache()` + `load()` + `startListener(DATABASE_URL)`,任一失败只 log 不阻塞启动;shutdown 负责关 listener
- [x] 更新 migrate_full.integ.test 中 "seed 幂等" 测试,避免新增 0008 后触发 out-of-order 检查(改为 `DELETE WHERE version >= '0007_seed_pricing'`)

**Acceptance**:
- [x] 单元:`perKtokCredits` 多组公式(sonnet/opus/自定义 multiplier/极小值/零值) — `pricing.test.ts`(10 case)
- [x] 单元:`PricingCache.get/listPublic/shutdown` 行为对(`_setForTests` 注入,无 DB)— `pricing.test.ts`
- [x] 集成:真 PG + trigger + LISTEN/NOTIFY,UPDATE multiplier → waitFor cache 反映新值(timeout 2s,轮询 25ms)
- [x] 集成:INSERT 新模型 → cache 里能 get 到;DELETE → get 返 null
- [x] 集成:disabled 模型不在 listPublic 里,但 get() 仍能查到
- [x] 集成:`/api/public/models` 端到端返 JSON + sort_order 正确 + per-ktok 字段格式 `\d+\.\d{6}`;POST → 405 Allow:GET;未注入 pricing → 503 PRICING_NOT_READY

**测试**: 10 + 4 unit case + 9 integ case 新增(全部 pass)

**Status**: `[x] done` (commit 6681cac)

---

### T-21 扣费计算器
**依赖**: T-20
**文档**: 01-SPEC F-2, 03-DATA-MODEL §4/§6

**内容**:
- [x] `src/billing/calculator.ts`:
  - `computeCost(usage, pricing, capturedAt?)` → `{cost_credits, snapshot}`
  - 4 维 token(input/output/cache_read/cache_write)统一公式:`Σ tokens_i × per_mtok_i × multiplier / 10^9`
  - BigInt 贯穿:pg 的 `::text` → `BigInt` 在 pricing 边界,multiplier 用 `"2.000"`→`2000n` 整数放大形式参与,中间计算不经 Number
  - **ceiling 在总和层做一次**(不在每维 ceiling 累加,避免双重舍入系统性高估)
  - 全零 usage → 精确 0,其他 → 至少 1 分
  - 负 token / 负 multiplier → `TypeError`(调用方 bug,不吞)
  - snapshot 所有数字字段序列化为 string(BigInt 不能直接 `JSON.stringify`),`captured_at` ISO 字符串
- [x] `src/index.ts`:导出 `computeCost` + `TokenUsage` / `PriceSnapshot` / `CostResult` 供 T-22/T-23 使用

**Acceptance**:
- [x] 单元:已知 usage + pricing → 已知 cost — sonnet 1M input=600 分,opus 1M input=3000 分,opus 混合 4 维=4718 分,multiplier 1.5=450 分
- [x] 单元:极大 token 不溢出 — 10^12 tok * 300 分 * 2.0 = 6×10^8 分精确;bigint 入参 10^15 tok 跑通(Number.MAX_SAFE_INTEGER ≈ 9×10^15)
- [x] 单元:极小 usage 不为 0 — 1 tok 在 input/cache_read 维均 → 1 分;每维各 1 tok 合起来仍 → 1 分(验证不是每维各 ceiling)
- [x] 单元:全零 usage → 精确 0,不被 ceiling 抬高
- [x] 单元:负 input_tokens / 负 output_tokens(bigint)/ 负 multiplier → TypeError
- [x] 单元:number + bigint 混用入参跑通
- [x] 单元:snapshot 字段完整、全 string,可 JSON 往返;captured_at 未传时默认 now

**测试**: 15 unit case 新增,122 unit/98 integ 全部 pass

**Status**: `[x] done`

---

### T-22 流水 + 余额(事务)
**依赖**: T-02, T-21
**文档**: 01-SPEC F-2, 03-DATA-MODEL §1/§5

**内容**:
- [x] `src/billing/ledger.ts`:
  - `debit(userId, amount, reason, ref?, memo?)` → `{ledger_id, balance_after}`
    - `tx()` 包裹:`SELECT credits FROM users WHERE id=$1 FOR UPDATE` → 校验 → `UPDATE users SET credits = new` → `INSERT credit_ledger`
    - amount 必须 > 0;余额不足抛 `InsufficientCreditsError` (code=`ERR_INSUFFICIENT_CREDITS`,带 balance/required/shortfall)
  - `credit(userId, amount, reason, ref?, memo?)` → 同结构,delta 正数
  - `adminAdjust(userId, delta, memo, adminId, ref?, ip?, ua?)` → 同事务内:
    - UPDATE users.credits + INSERT credit_ledger(reason=`admin_adjust`) + INSERT admin_audit(action=`credits.adjust`, before/after JSONB)
    - delta 必须 ≠ 0;memo 必传非空;余额会被打成负值 → 抛 `InsufficientCreditsError` 整事务回滚
  - 读路径辅助:`getBalance(userId)` / `listLedger(userId, {limit,before})`
  - BIGINT / bigint 贯穿:pg `::text AS col` → `BigInt(...)` 在边界,中间不经 Number
  - `LEDGER_REASONS` 枚举与 0002 的 CHECK 白名单 1:1(含 topup/chat/agent_chat/agent_subscription/refund/admin_adjust/promotion 共 7 个)
- [x] `listLedger` 排序用 `ORDER BY id DESC` —— `created_at = transaction_timestamp()` 在并发时不稳定(先 BEGIN 后拿锁的 tx 时间戳会更早),BIGSERIAL id 在 FOR UPDATE 串行化前提下严格对齐 commit 顺序
- [x] `src/index.ts`:导出 debit/credit/adminAdjust/getBalance/listLedger/InsufficientCreditsError/LEDGER_REASONS + 类型

**Acceptance**:
- [x] 集成:正常 debit → users.credits 减 + credit_ledger 新增(delta<0,balance_after 与 users.credits 一致,ref_type/ref_id/memo 落地)
- [x] 集成:余额不足 → 抛 InsufficientCreditsError(shortfall 字段正确),users.credits 未变,ledger 无新增
- [x] 集成:并发 10 个 debit(余额 500 每次 100)→ 严格 5 成功 5 失败;剩余余额 0;5 行 ledger 的 balance_after 单调(400→300→200→100→0)
- [x] 集成:credit_ledger UPDATE/DELETE 被 0002 RULE 拦住,实际行不变(回归)
- [x] 集成:adminAdjust 正向 → ledger + admin_audit 各出一行,before.credits / after.credits / delta / ledger_id 齐全,ip/ua 落地
- [x] 集成:adminAdjust 负向合法(余额够);会把余额打成负值 → InsufficientCreditsError,ledger + audit 都未写(事务原子回滚)
- [x] 集成:user 不存在 → TypeError
- [x] 集成:listLedger limit 参数生效,按 id DESC 倒序
- [x] 单元:InsufficientCreditsError 结构(code/balance/required/shortfall);入参校验(amount≤0 / reason 非法 / user_id 非正整数 / delta=0 / memo 空)

**测试**: +10 unit case + 12 integ case 新增,242 tests 全绿(132 unit + 110 integ)

**Status**: `[x] done`

---

### T-23 预检中间件 + chat 接口骨架
**依赖**: T-22, T-16
**文档**: 04-API §5, 05-SEC §15

**内容**:
- [x] `src/billing/preCheck.ts`:
  - `estimateMaxCost(maxTokens, pricing)` — **按 output 维度保守估**(通常是 input 单价的 5x,最悲观,不会低估),向上取整到 1 分
  - `preCheck(redis, {userId, requestId, model, maxTokens, pricing})`:
    - Redis key `precheck:user:<id>:<req_id>`,TTL 5min
    - 聚合当前用户所有 `precheck:user:<id>:*` 已预扣总和,加上本次 `maxCost`
    - 与 `users.credits` 比对 → 不足抛 `PreCheckInsufficientError`(含 balance/required/shortfall)
  - `releasePreCheck(redis, lockKey)` 幂等删除
  - `wrapIoredisForPreCheck` 对 ioredis 的 SCAN+MGET 适配;`InMemoryPreCheckRedis` 测试用内存实现(支持 TTL swap)
- [x] `POST /api/chat` 骨架(**不接真 Claude**,注入 `stubChatLLM` 返回固定 1000 in / 500 out):
  - requireAuth → parseChatBody(model / max_tokens / messages 校验)
  - preCheck → 不足 402 `ERR_INSUFFICIENT_CREDITS`
  - `deps.chatLLM.complete(...)` → success 走事务内 FOR UPDATE debit + INSERT usage_records(status=success, ledger_id 挂上);error 只 INSERT usage_records(status=error, cost_credits=0)
  - 模型未知/未启用 → 400 `UNKNOWN_MODEL`
  - max_tokens 非法(≤0 / >1M / 非整数)→ 400 VALIDATION
  - finally 释放预扣(best-effort,崩溃时 TTL 兜底)
- [x] 路由:`router.ts` 加 `POST /api/chat` + 前缀 `/api/chat` 入白名单(POST 否则 405)
- [x] `src/index.ts`:导出 preCheck 全家 + ChatLLM / stubChatLLM;`registerCommercial()` 注入 `wrapIoredisForPreCheck(redis)` 到 handler deps

**Acceptance**:
- [x] 单元:`estimateMaxCost` 已知 case(1M tok sonnet=3000分 / 1 tok ceil→1 / 0→0 / 不同 multiplier),非法入参 TypeError
- [x] 单元:`InMemoryPreCheckRedis` set/get/del/sumByPrefix,TTL 过期自动清,脏数据(非 BigInt)被忽略不 throw
- [x] 集成:余额足够 → 200 + cost_credits/balance_after 正确 + credit_ledger(reason=chat, ref_id=request_id)+ usage_records(status=success, ledger_id 挂上)+ 预扣已释放
- [x] 集成:余额不足 → 402 ERR_INSUFFICIENT_CREDITS + users.credits 未变 + 无 ledger + 无 usage_records + Redis 锁未写(preCheck 抛错前)
- [x] 集成:mock LLM 异常 → 502 + 未扣费 + usage_records.status='error' + cost_credits=0 + 预扣已释放
- [x] 集成:未知/disabled 模型 → 400 UNKNOWN_MODEL(预检前拦截)
- [x] 集成:max_tokens 非法 → 400 VALIDATION(0 / 负 / > 1M)
- [x] 集成:未携带 Authorization → 401 UNAUTHORIZED
- [x] 集成:同用户并发锁叠加 → 先锁 3500 分,再请求最多估 3000 分,余额 ≈ 6000 → 第 2 个请求 402(locked + needNew > balance)

**测试**: +9 unit case + 7 integ case 新增,258 tests 全绿(141 unit + 117 integ)

**Status**: `[x] done`

---

### T-24 虎皮椒支付
**依赖**: T-22
**文档**: 01-SPEC F-3, 04-API §4, 05-SEC §11

**内容**:
- [x] `src/payment/hupijiao/sign.ts`:MD5 签名(按虎皮椒规范)—— 字典序 + 跳 hash / 空值 + `&<APP_SECRET>` + md5 小写;`verifyHupijiao` 用 timingSafeEqual 大小写归一
- [x] `src/payment/hupijiao/client.ts`:`createQr(order)` 调虎皮椒 API(`createHttpHupijiaoClient(cfg, fetchImpl?)`),errcode≠0 → HupijiaoError("UPSTREAM_<code>"),missing qrcode → UPSTREAM_NO_QRCODE
- [x] `src/payment/orders.ts`:订单状态机(`createPendingOrder` / `markOrderPaid` 事务内 SELECT FOR UPDATE → credit+ledger+update / `expirePendingOrders` / `getOrderByNo`)
- [x] `GET /api/payment/plans`:公开,返回 enabled 档(按 sort_order DESC)
- [x] `POST /api/payment/hupi/create`:
  - requireAuth + 10 次/1h 限流(04-API §8)
  - 校验 plan_code → `createPendingOrder`(expires_at=now+15min)→ mock/prod 虎皮椒拿 qrcode
  - 502 UPSTREAM_\* 时订单留 pending(后续 expire 扫到)
- [x] `POST /api/payment/hupi/callback`:
  - 解析 form-urlencoded(新增 `readFormBody` / `sendText` util)
  - 校验签名(错 → 400 SIGNATURE_INVALID)
  - `status != "OD"` → 回 `success` 但不推进状态(避免虎皮椒一直重试)
  - `markOrderPaid` 幂等:已 paid 直接返 `success`;pending → paid + credit(topup) + ledger + 回写 callback_payload;expired/refunded/canceled → warn log + `success`(记运维看得到)
- [x] `GET /api/payment/orders/:order_no`:requireAuth + user-scoped(非属主 404);`extractOrderNoFromUrl` 白名单字符 + 长度限制
- [x] `expirePendingOrders()`:已实现,部署期间挂 cron(工具期在 T-80 集成)

**Acceptance**:
- [x] 单元:`hupijiaoSign.test.ts` — 16 case(字典序 / 跳空 / bigint/bool 归一 / verify 篡改字段/hash/secret / 大小写 hash)
- [x] 单元:`orders.test.ts` — generateOrderNo 格式与唯一性 / extractOrderNoFromUrl 非法输入
- [x] 集成:`orders.integ.test.ts` — listPlans 种子、createPendingOrder、disabled plan → PlanNotFoundError、首次 markPaid、幂等回放、expired → InvalidOrderStateError、并发同单只加一次、expirePendingOrders
- [x] 集成:`payment.integ.test.ts` — GET plans 公开、create 全路径、callback 签名错 → 400、正确回调 → paid + 积分到账、status=PN → 不推进、重复回调只加一次、非属主 GET → 404、非法 order_no 字符 → 400

**测试**: +2 unit 文件(22 case) + 2 integ 文件(23 case),共 **162 unit + 140 integ = 302 全绿**

**Status**: `[x] done`

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
- [x] 集成:create 后 DB 里 oauth_token_enc 是密文(非原文)
- [x] 集成:getTokenForUse 解密还原
- [x] 集成:篡改密文 1 byte → 解密失败

**Status**: `[x] done` — 2026-04-17

完成说明:
- 新 `src/account-pool/store.ts`:`createAccount` / `getAccount` / `listAccounts` / `getTokenForUse` / `updateAccount` / `deleteAccount` + `ACCOUNT_PLANS` / `ACCOUNT_STATUSES` 常量、`AccountRow` / `AccountToken` / `CreateAccountInput` / `UpdateAccountPatch` / `ListAccountsOptions` 类型。
- AEAD:
  * `createAccount` 用 `encrypt(token, key)` + `encrypt(refresh, key)`(可选),每次独立 12B nonce;access 和 refresh 密文/nonce 分两对列存。
  * `getTokenForUse` 新增 `decryptToBuffer`(aead.ts),返回明文 Buffer 给上游;成功路径 Buffer 不清零(交给调用方 .fill(0));抛错路径就地 zero,不泄漏。
  * `updateAccount(patch)` 显式区分 `token = string` / `refresh = string | null | undefined` 三种语义:string 重加密换 nonce,null 清空,undefined 保持。
  * 密钥:默认 `loadKmsKey()`,每次函数结束 `zeroBuffer(key)`,不做进程级缓存;测试可注入 `keyFn`。
- 查询白名单:`listAccounts` / `getAccount` / `updateAccount.RETURNING` 只走 `META_COLUMNS` 常量,**永不**选 `oauth_*_enc` / `oauth_*_nonce` → 防未来同事改 SQL 时回退把密文打进 log。测试里断言返回对象 key 集合不含密文列。
- 参数化 + 白名单校验:plan / status 入库前 `ACCOUNT_PLANS.includes` / `ACCOUNT_STATUSES.includes`,health_score 强制 [0,100],token/refresh 空串直接 TypeError → 单元级反馈快,DB CHECK 约束作为二道防线。
- `listAccounts` 支持 `status?: AccountStatus | AccountStatus[]`,`limit` 在 [1, 500] 之间 clamp(防无界扫描)。
- `deleteAccount` 不阻断 FK — 让 `usage_records.account_id ON DELETE RESTRICT` 抛错透传;运维应先 `status='disabled'` 保留历史(测试里断言 FK 违反会 reject + 账号仍在)。
- 更新 `src/index.ts` 导出全部公共 API + 类型,供后续 T-31/T-32 直接引用。

**测试**: +1 unit 文件(12 case) + 1 integ 文件(25 case)。
- accountStore.test.ts:ACCOUNT_PLANS/STATUSES 枚举、create 的非法 plan/空 token/非字符串 token/空 refresh、update 的非法 plan/非法 status/health_score 越界/空 token/空 refresh,共 12 case,都在 DB 调用前就拒绝。
- accountStore.integ.test.ts:createAccount DB 真的是密文(含 16B tag / nonce 12B / 密文不包含明文片段)、含 refresh 时两对密文不冲突、listAccounts 列白名单断言、status 过滤(单值+数组)、id DESC、limit clamp、getAccount 命中/null、getTokenForUse 还原 access+refresh+expires_at、没 refresh 返 null、篡改密文 1 byte → AeadError、错 key → AeadError、update 普通字段时密文不动、update token 时两列都换、refresh=null 清空、refresh=string 重加密、空 patch → 不发 SQL 返现状(updated_at 不变)、update 不存在 id → null、health_score 越界 RangeError、非法 status TypeError、deleteAccount 成功/不存在、有 usage_records 引用时 FK RESTRICT 拒绝。

**总计**: 174 unit + 165 integ = 339 全绿(较 T-24 完成时 302 新增 +12 unit + 25 integ = +37)。

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
- [x] 单元:3 次失败触发熔断,cooldown_until 设对
- [x] 单元:halfOpen 恢复 cooldown 过期账号
- [x] 集成:DB 行和 Redis 一致

**Status**: `[x] done` — 2026-04-17

完成说明:
- 新 `src/account-pool/health.ts`:`AccountHealthTracker` 类封装 onSuccess / onFailure / halfOpen / manualDisable / manualEnable / getHealthScore / peekFailCount。
- **熔断触发语义**:onFailure 用 Redis `acct:fail:<id>` 独立维护连续失败计数(INCR + 首次 EXPIRE 600s),当计数 ≥ 3 **且** 当前 `status='active'` 时,二次 UPDATE WHERE status='active' 切 cooldown + cooldown_until = now + 10min(由 `now()` 注入,测试可冻结时钟),并清空 Redis 计数 —— 下一轮 halfOpen 恢复后从 0 开始累积。onSuccess 总是先 `DEL failKey`,哪怕还没到阈值也能把计数打回零,避免"熔断前夜"残留状态。
- **halfOpen 语义**:单条 UPDATE `WHERE status='cooldown' AND cooldown_until < NOW()`,RETURNING 所有 recover 行,逐一回写 Redis `health=50` + DEL fail counter。无候选返 []。再调幂等(因为第一次调用已把 cooldown 迁 active)。
- **Redis 缓存**:`acct:health:<id>` TTL 60s 存当前 health_score;所有写入类 API(除 manualDisable)都在 DB UPDATE 后 SET Redis —— 保证 scheduler(T-32)读 Redis 不拿到过期数据。manualDisable 则 DEL 两个 key(不留脏缓存)。`getHealthScore` read-through:Redis 命中返 cached(数值校验),miss 回 DB 并回填。
- **floor/cap**:UPDATE 里 `LEAST(100, health_score + 10)` 和 `GREATEST(0, health_score - 20)`,保证 [0,100] 硬边界,不依赖应用层计算。
- **不存在账号**:所有写入 API RETURNING 空行 → 返 null + 清 Redis(healthKey/failKey),防 ghost 脏计数残留。
- **InMemoryHealthRedis**:测试用内存实现,带简化 TTL(get 时检查过期),拿 `ttlMs(key)` / `snapshot()` 方便断言。
- **wrapIoredisForHealth**:适配 ioredis 签名(`set(k,v,'EX',sec)`),已 typed;暴露给 `index.ts` 供 `registerCommercial` 接入(本 task 不改 index 注册流程,等 T-32 一并接)。
- 更新 `src/index.ts` 导出 AccountHealthTracker / InMemoryHealthRedis / wrapIoredisForHealth / 常量 / 类型。

**测试**: +1 unit 文件(11 case)+ 1 integ 文件(15 case)。
- accountHealth.test.ts:healthKey/failKey 命名、DEFAULT 常量、InMemoryHealthRedis(get/set/incr/expire/del + TTL + snapshot)、wrapIoredisForHealth(set 带 EX 参数签名、get/incr/expire/del 透传)。
- accountHealth.integ.test.ts:onSuccess 清 fail 计数 + success_count++ + health cap 100 + last_used_at 更新 + Redis 缓存;onFailure 1 次 health-20 + fail_count++ + last_error + Redis fail=1 + health=80;连续 3 次失败触发 cooldown + cooldown_until 精确 now+10min + fail counter 清;2 次 + 成功后 fail 清 + 再 3 次才熔断;已 cooldown 账号的 onFailure 只累计数不改状态;health 到 0 后继续失败不为负;cap 不超 100;halfOpen 恢复到期账号(只动目标,其他账号不变)+ Redis 一致;无候选返 [];幂等;manualDisable 清两 key;manualEnable reset 到 100 + cooldown_until=null + last_error=null;getHealthScore miss 回 DB + 回填;Redis 脏值 non-number 回 DB;不存在 id 全部返 null 且清 Redis。

**总计**: 185 unit + 180 integ = 365 全绿(较 T-30 完成时 339 新增 +11 unit + 15 integ = +26)。

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
