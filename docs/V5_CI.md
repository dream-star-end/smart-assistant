# V5 CI 回归自动化(Aurora v5 CI)

Workflow:`.github/workflows/v5-ci.yml`
触发:push / PR 到 **feat/v5-aurora-rewrite**,以及手动 `workflow_dispatch`。
所有 job 并行、`fail-fast: false`(一个套件失败不取消其余,永远看全量结果)。
同一 PR / ref 的新 push 会取消上一轮(concurrency cancel-in-progress)。

与 v3 CI(`fix/v3-test-gate` 分支的 `.github/workflows/ci.yml`)同源:依赖安装
(`actions/setup-node@v4` node 20 + `cache: npm` + `npm ci`)与 PG/Redis service
containers 配置照抄 v3,端口/凭证/健康检查完全一致。

## Job 一览与本地等价命令

| Job | CI 命令 | 本地等价 | timeout |
| --- | --- | --- | --- |
| typecheck | `npm run typecheck` | 同左(`tsc --build`) | 20 min |
| gateway | `npm run test:gateway` | 同左 | 25 min |
| storage | `npm run test:storage` | 同左 | 15 min |
| web-react | `npm run test:web-react` | 同左(等价 `cd packages/web-react && npx vitest run`) | 25 min |
| commercial-unit | `npm run test:commercial:unit:gate` | 同左(需本地 PG fixture,见下) | 30 min |

一把梭:`npm run check:v5` 依次跑全部五项(与 CI 完全同一组命令)。

注意:`check:v5` 是 v5 的质量门,**不含** biome lint / integ 测试;v3 的全量门仍是
`npm run check`。

## commercial-unit:基线失败集 diff 门

商业 unit 套件(`test:commercial:unit`)存在**已知存量失败**(多为 v3 迁移
ledger / v3Supervisor / userChatBridge 一带,尚未在 v5 轨修复)。为了让 CI 对
**新增回归**敏感而不被存量失败刷屏,commercial-unit job 不直接看测试退出码,
而是走基线 diff:

1. `.github/scripts/commercial-unit-gate.sh` 跑套件,把 TAP 输出落到
   `commercial-unit.tap`(CI 里无论成败都作为 artifact 上传,名为
   `commercial-unit-tap`;本地跑 gate 会把它落在仓库根,未被 git 跟踪,
   用完可删,或用 `TAP_OUT=/path/xx.tap` 重定向);
2. `.github/scripts/diff-known-failures.sh` 从 TAP 提取**顶层**失败集
   (`^not ok` 只匹配列 0 = 顶层 test/suite 名;嵌套子测试是缩进的,不参与),
   与 `.github/known-failures/commercial-unit.txt` 逐行比较;
3. **只有基线之外的新增失败才 fail**;基线内的存量失败放行;
   基线里"本轮没失败"的条目打 warning 提示清理;
   TAP 里一个测试点都没有(套件没跑起来)或 runner 非零退出但抓不到任何
   `not ok`(基础设施崩溃)→ 直接 fail,防假绿。

防静默 skip:商业测试的 DB 门控是 `process.env.CI === "true" ||
process.env.REQUIRE_TEST_DB === "1"` —— 命中门控时 PG 不可用会直接 throw
"Postgres test fixture required" 而不是 skip。gate 脚本无条件
`export REQUIRE_TEST_DB=1`,CI job 又设 `CI=true` + 起 PG/Redis services,
双保险:DB 门控测试要么真跑,要么显式红,绝不静默绿。

### known-failures 清单维护

文件:`.github/known-failures/commercial-unit.txt`
格式:每行一个顶层 test/suite 名(与 TAP `not ok N - ` 后的文本一字不差,
含 TAP 转义如 `\#`);空行与 `#` 开头整行是注释。

- **修掉一个存量失败 → 从清单删掉对应行**(CI 的 stale warning 会提醒你)。
  目标是清单单调递减、最终删空。
- **新增失败原则上禁止入清单**(那是回归,修代码去)。唯一例外:环境变化
  暴露出的、可证明与本次改动无关的历史失败,加行时必须在 PR 里说明依据。
- 重新生成 / 核对清单(在仓库根目录,需本地 PG fixture):

  ```bash
  CI=true REQUIRE_TEST_DB=1 \
  TEST_DATABASE_URL=postgres://test:test@127.0.0.1:55432/openclaude_test \
  npm run test:commercial:unit > commercial-unit.tap 2>&1
  grep '^not ok' commercial-unit.tap | sed 's/^not ok [0-9]* - //' | sort -u
  ```

  当前清单即由该命令于 2026-07-05(HEAD=151f7b41)本机两次实跑取并集生成
  (30 条稳定 + 1 条负载敏感 flaky,共 31 条)。

- 已知局限:基线粒度是**顶层 suite/test**。若一个 suite 已在基线内,其内部
  新增的子测试失败不会被 diff 捕获(整个 suite 已被豁免)。所以清单越短,
  门越灵敏 —— 又一个尽快清零存量的理由。

### 本地 PG/Redis fixture

与 CI 完全一致的一次性 fixture(Docker):

```bash
docker run -d --name oc-test-pg -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=openclaude_test -p 55432:5432 postgres:16
docker run -d --name oc-test-redis -p 56379:6379 redis:7
```

unit 套件只用到 PG(`TEST_REDIS_URL` 仅 integ 测试使用);测试代码内置默认
`postgres://test:test@127.0.0.1:55432/openclaude_test`,端口对上即可零配置。

## 已知风险(交集成者首跑观察)

1. **依赖安装方式**:仓库同时存在 `bun.lock` 与 `package-lock.json`。CI 沿用
   v3 先例 `npm ci`(本地验证过 `npm ci --dry-run` 与 package.json 同步,
   exit 0)。若后续以 bun.lock 为唯一权威并停止维护 package-lock.json,
   两个 workflow 需同步改造(setup-bun + `bun install --frozen-lockfile`)。
2. **本地基线与 CI 环境差异**:基线清单产自本机(node v20.20.2,本地
   node_modules 与 lockfile 有漂移)。GitHub 2-core runner 上失败集可能有
   出入 —— 首跑若出现 `[NEW]` 且能确认是历史失败换了环境现形,按上节规则
   补一行;若基线条目稳定不再失败,删行。
3. **负载敏感 flaky**:`assertPlatformDefaultModelConfigured` 与
   `v3 supervisor.ensureRunning — open-migration guard (R6.11 §13.3)` 在本机
   多轮间出现/消失,已收进基线。web-react 的
   `MessageRenderer … 懒加载 chunk` 用例在机器高负载下会 5s 超时(单独跑
   全绿,未入任何基线);web-react job 若偶发红,先重跑再怀疑回归。
4. **service containers**:PG/Redis 配置照抄 v3 workflow,但 v3 的 ci.yml
   在分支 `fix/v3-test-gate` 上、未见实际 Actions 运行记录,等效于首次验证。
5. **workflow_dispatch 可见性**:GitHub UI 的手动触发入口要求 workflow 文件
   存在于仓库默认分支;在此之前只有 push/PR 到 feat/v5-aurora-rewrite 会触发
   (对该分支的 push/PR 事件按事件所在 ref 读取 workflow,不受默认分支限制)。
