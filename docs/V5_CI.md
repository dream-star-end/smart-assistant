# V5 CI 回归自动化(Aurora v5 CI)

Workflow:`.github/workflows/v5-ci.yml`
触发:push / PR 到 **feat/v5-aurora-rewrite**,以及手动 `workflow_dispatch`。
所有 job 并行、`fail-fast: false`(一个套件失败不取消其余,永远看全量结果)。
同一 PR / ref 的新 push 会取消上一轮(concurrency cancel-in-progress)。

与 v3 CI(`fix/v3-test-gate` 分支的 `.github/workflows/ci.yml`)同源:依赖安装
(`actions/setup-node@v4` node 20 + `cache: npm` + `npm ci`)与 PG/Redis service
containers 配置照抄 v3,端口/凭证/健康检查完全一致。

## Job 一览与本地等价命令

| Job | CI 命令 | 证明的用户可见事实 | timeout |
| --- | --- | --- | --- |
| typecheck | `npm run typecheck && npm run check:ci-parity` | 全仓类型闭合;CI 门集合 ≡ `check:v5` 门集合(见下「CI parity 门」) | 20 min |
| lint | `npm run lint:scheduler-wiring && npm run lint:agent-containers-sql` | 导出的调度器/轮询器真的被 start(HealthPoller 事故);读 `agent_containers` 显式带 state,vanished 行不渗进用户视图/计费聚合 | 10 min |
| protocol | `npm run test:protocol` | gateway↔web-react↔容器的帧与错误码单一权威(frames / turnErrorTaxonomy / promptQueueFrames / modelAuthority)未漂 | 10 min |
| channels | `npm run test:channels` | 企微 iLink 收发/媒体/配对链路契约 | 10 min |
| gateway | `npm run test:gateway` | 网关侧会话/工具/路由行为 | 25 min |
| storage | `npm run test:storage && npm run test:mcp-memory` | 持久化层与记忆子系统 | 15 min |
| web-react | `npm run check:v5:incidents && npm run check:tutorials && npm run test:web-react` | 历史事故回归清单 + 教程 JSONL 只追加 + 前端组件单测(jsdom) | 30 min |
| web-react-browser | `npm run test:browser` | 真 Chromium 受信点击:附件/选择器一类"jsdom 恒假阴性"的交互真的能点开 | 20 min |
| node-agent-go | `npm run build:node-agent` | node-agent(Go)编译 + vet 闭合:容器资源限额/运维参数改动不能带着编译错误合入(2026-08 FormatFloat 事故) | 10 min |
| v5-ops | `npm run test:v5:ops` | 发布/回滚脚本的安全契约(真 psql 持久化);迁移编号门规则 + **对真实仓库状态的断言**(不重号、缺口必须声明 `-- order-dependency:`、新迁移登记进 `requiredMigrations`,规则同 `npm run lint:migration-order`) | 20 min |
| commercial-unit | `npm run test:commercial:unit:gate` | 商业后端全量 unit(基线失败集 diff 门,见下) | 30 min |
| commercial-integ | `bash .github/scripts/commercial-integ-gate.sh <shard>` | 真 PG 语义:能注册/能收验证信/能登录/refresh 家族被盗整族吊销/下单加积分/同一 request_id 只扣一次钱/会话 tape 落库读回/新表有保留策略 | 20 min/片 |

一把梭:`npm run check:v5`。**它与 CI 的 job 命令并集必须逐条相等**,由 `npm run
check:ci-parity`(挂在 typecheck job 里)机器核对 —— 任一方向差集非空即红。
历史教训:2026-07-26 审计发现 `check:v5` 缺 `test:browser`、CI 缺 `test:mcp-memory`,
开发者按文档跑绿却漏掉最贵的那道门。


本地预检快车道:`npm run check:v5:fast`(`scripts/select-gates.ts` + `scripts/run-v5-fast.ts`)。它按 `git diff origin/feat/v5-aurora-rewrite...HEAD` ∪ 工作区裁剪要跑的门,并把独立门并行执行;带 `test-mutex.sh commercial` 锁的 两门(unit / integ)彼此串行,避免再制造锁竞争。**它不是 CI 的替代,也不进入 `check:v5` 链** —— parity 门只核对全量集合。T2 / nightly / 合并前仍跑 `npm run check:v5`。

注意:`check:v5` 是 v5 的质量门,**不含** biome lint(`npm run lint`,当前 3657 error
存量,见「已知风险」)/ `test:web` / `lint:undefined-refs`(后两者只服务
`packages/web`);v3 / 个人版的全量门仍是 `npm run check`。

integ 分两档:**PR 门第一梯队**(22 文件 / 473 例,pr-1/2/3 三片)已在 `check:v5` 与 CI 里;
**夜跑梯队**(其余 87 文件)走 `.github/workflows/v5-integ-nightly.yml`,失败开工单而非阻塞 PR。
梯队清单由 `npm run lint:integ-tiers` 强制:新增 `*.integ.test.ts` 不登记进任一梯队即红
(近 30 天新增了 59 个 integ 文件,没有这条门一年后又会攒出一堆谁也不跑的用例)。

`packages/web` 的作用面**不是"v5 完全不加载"那么简单**,见
`packages/web/README.md`:v5 master 注入 `OC_RUNTIME_CHANNEL=v5` → web root =
`packages/web-react/dist`,本包确实不加载;但 master **有意不**向用户容器注入该 env
(v3supervisor 明确注释:它会改变 in-container CLI 的 web-root 语义),所以容器里
CLI 落到默认 `v3` 分支、`packages/web/public` 就是容器的 web root。
因此本轮只把它移出 v5 门禁范围,**没有**把它加进任何生产分发排除清单。

### CI parity 门(`scripts/check-ci-parity.ts`)

它做三件事:
1. 解析 `.github/workflows/v5-ci.yml`,展开 matrix,收集所有 job `run:` 里的
   `npm run <script>`;
2. 与 `package.json` 的 `check:v5` 链里的 `npm run <script>` 集合**双向比对**;
3. 核对本文件上面那张 job 表格的首列 ≡ workflow 里真实的 job 名。

硬要求:**CI 里禁止写 `npm run --workspace <ws> <script>`** —— 脚本名不在固定位置、
无法与根脚本集合对齐。要跑 workspace 脚本就在根 `package.json` 加 alias(例:
`test:browser` → `npm run --workspace @openclaude/web-react test:browser`),两侧都用 alias。
违反时 parity 门直接红并给出改法。
## commercial-unit:基线失败集 diff 门

商业 unit 套件(`test:commercial:unit`)存在**已知存量失败**(多为 v3 迁移
ledger / v3Supervisor / userChatBridge 一带,尚未在 v5 轨修复)。为了让 CI 对
**新增回归**敏感而不被存量失败刷屏,commercial-unit job 不直接看测试退出码,
而是走基线 diff:

1. `.github/scripts/commercial-unit-gate.sh` 跑套件并生成 TAP。为避免多 worktree /
   多 agent 并发互相截断,本地默认写到当前 worktree 的 Git 目录;可用
   `TAP_OUT=/path/xx.tap` 显式重定向。CI job 通过唯一变量
   `COMMERCIAL_UNIT_TAP=commercial-unit.tap` 把 `TAP_OUT` 和 artifact 上传路径绑在
   一起;无论测试成败都上传名为 `commercial-unit-tap` 的产物,产物缺失本身也会让
   job 失败,避免门禁只报套件名却丢失真实断言详情;
2. `.github/scripts/diff-known-failures.sh` 判定,判据见下。

### diff 门的七条判据(2026-07-26 重写)

重写前它只做"顶层失败名 diff"一件事,实测有三个洞(主干全绿 run 30190800591 的
commercial-unit TAP artifact:`1..1067` / `# tests 4696 / # pass 4590 / # fail 61 /
# cancelled 39 / # skipped 0 / # todo 6`,顶层 `not ok` 19 条、嵌套 `not ok` 103 条):

- 判据只覆盖 19 个顶层名 → 61 个真实失败 + 39 个 cancelledByParent 全部不入判据;
- 跑了一半也算绿(OOM / test-mutex 看门狗 kill rc=124 / 中途崩溃);
- infra-failure 分支要求"actual 为空",而基线保证 actual 恒非空 → 实际走不到。

现在的判据(任一不满足即红):

| 判据 | 内容 | 它让"门绿"多证明什么 |
| --- | --- | --- |
| A | 必须有顶层 plan 行 `1..N` 且 `N` == 实际顶层测试点数;`# tests / # pass / # fail / # cancelled / # skipped` 汇总行齐全 | 这一轮**跑完了**,不是跑了 60% 被 kill |
| B | `# skipped` 必须为 0 | fixture 真起来了(没起来时整套会静默 skip,node 还退 0) |
| C | `# fail` / `# cancelled` 不超过 `commercial-unit.counts` 的上界 | 已登记套件**内部**没有多出失败;灵敏度从 19 提到 4696 |
| D | 顶层新增失败(不在基线里)→ 红 | 没有新的整套件回归 |
| E | `core-contract-suites.txt` 里的套件名一旦进基线 → 红 | 那几条用户当场可见的事实**永远没有豁免通道** |
| F | stale 条目(基线里本轮没失败的)→ CI 里红 | 基线单调递减,不给未来的真回归预留豁免 |
| G | runner 非零退出时,只有 A–F 全过才放行;若 TAP 显示零失败零取消却非零退出 → 红 | 非零退出不会被"没有新失败"顺手洗白 |

严格档:`CI=true` 时默认开(判据 **B、C、F** 是红)。本地默认宽松档(这三条降为
warning),因为它们都依赖"判绿环境 = CI"这个前提:CI 以 root + PG + Redis 跑,
commercial unit 里 16 个文件的 `{ skip: !IS_ROOT … }` 环境门在那里全部命中真跑
(实测 `# skipped 0`),而开发机非 root 必然 skip 几条;基线失败集同样按 CI 的
docker mock 行为校准。本地想跑严格档:`KNOWN_FAILURES_STRICT=1`。
A / D / E / G 两档下都是硬红 —— 截断就是截断,新失败就是新失败,禁豁免就是禁豁免。

门自身的红绿对照锁在 `scripts/__tests__/knownFailuresGate.test.ts`(随 `test:v5:ops`
在 CI 跑):每条判据都有"该拦的输入确实 exit 1"和"修好后 exit 0"两侧用例。

### 配套的两个基线文件

- `.github/known-failures/commercial-unit.counts` —— `fail_max` / `cancelled_max`
  两个上界。**超过 → 红;低于 → warning 提示收紧,看到就把数字改小。**
  文件里有变更记录,抬高上界必须写理由。
- `.github/known-failures/core-contract-suites.txt` —— 禁豁免清单,以及"新增条目
  的判据"(用户当场可见 + 无声失效 + 有事故前科/单一权威语义,三条全中才加)。

这两个文件缺失时门直接红 —— 删文件不等于跳过判据。

防静默 skip:商业测试的 DB 门控是 `process.env.CI === "true" ||
process.env.REQUIRE_TEST_DB === "1"` —— 命中门控时 PG 不可用会直接 throw
"Postgres test fixture required" 而不是 skip。gate 脚本无条件
`export REQUIRE_TEST_DB=1`,CI job 又设 `CI=true` + 起 PG/Redis services,
双保险:DB 门控测试要么真跑,要么显式红,绝不静默绿。

CI 的 commercial-unit 命令通过 `sudo env ...` 以 root 执行。这不是放宽测试:
v5 master 的 systemd unit 明确是 `User=root`,而 container provision 的真实权限契约
会创建 `/run/ccb-ssh/u<uid>` 并 `chown root:1000`。GitHub 托管 runner 的普通用户既
不能在 `/run` 建目录也不能 chown,会让所有触发 provision 的单测稳定报 `EACCES`,
形成“本机(root)绿、CI(runner)红”的假回归。root 运行同时让标记为 requires-root 的
artifact/seed 校验在 CI 真正执行;runner 是 GitHub 一次性虚机,不接触生产主机。

### known-failures 清单维护

文件:`.github/known-failures/commercial-unit.txt`
格式:每行一个顶层 test/suite 名(与 TAP `not ok N - ` 后的文本一字不差,
含 TAP 转义如 `\#`);空行与 `#` 开头整行是注释。

- **修掉一个存量失败 → 从清单删掉对应行**,这是**硬要求**:stale 条目在 CI 里
  直接判红(判据 F),不再只是 warning。目标是清单单调递减、最终删空。
- **新增失败原则上禁止入清单**(那是回归,修代码去)。唯一例外:环境变化
  暴露出的、可证明与本次改动无关的历史失败,加行时必须在 PR 里说明依据。
  `core-contract-suites.txt` 里的套件**连这个例外都没有**,只能修。
- 重新生成 / 核对清单(在仓库根目录,需本地 PG fixture):

  ```bash
  CI=true REQUIRE_TEST_DB=1 \
  TEST_DATABASE_URL=postgres://test:test@127.0.0.1:55432/openclaude_test \
  npm run test:commercial:unit > commercial-unit.tap 2>&1
  grep '^not ok' commercial-unit.tap | sed 's/^not ok [0-9]* - //' | sort -u
  ```

  清单最初由该命令于 2026-07-05(HEAD=151f7b41)本机两次实跑取并集生成
  (30 条稳定 + 1 条负载敏感 flaky)。2026-07-08 / 07-11 / 07-26 三轮清债后
  **只剩 2 条**(见清单内注释)。07-26 一轮删了 24 条 —— 全部是夹具坏死而非
  产品缺陷,顺带把"开会话 → 容器起来 → 挂对卷 → 注对 env → 停容器回收"这条
  主路径的回归保护收回门内;同一轮另按主干 run 30190800591 的 TAP artifact
  删掉 7 条 stale,并把 stale 从 warning 升级为 CI 硬红(此前文档写的
  "31 条"早已陈旧)。

- 已知局限 ①(粒度):基线粒度是**顶层 suite/test**。若一个 suite 已在基线内,
  其内部新增的子测试失败不会被名字 diff 捕获。**这一条现在由判据 C 的
  `fail_max` / `cancelled_max` 计数上界兜住** —— 名字看不见,数字看得见。
  清单越短门越灵敏的结论不变。

- 已知局限 ②(键的唯一性,**登记为债**):基线键是裸的顶层套件名,不含文件路径。
  当前 19 条零重名纯属运气,不是机制:两个不同文件里出现同名 `describe` 时,
  一条基线行会同时豁免两处。
  触发条件:出现同名顶层套件(可用
  `grep -rhoP '^describe\("\K[^"]+' packages/commercial/src --include='*.test.ts' | sort | uniq -d`
  查)。届时把键升级为 `<相对路径>::<套件名>`;代价是 node:test 的 TAP 顶层行不带
  文件名,需要改成按文件分组跑或改用 `--test-reporter` 自定义输出,不是一行改动,
  所以本轮先登记不做。

### 本地 PG/Redis fixture

与 CI 完全一致的一次性 fixture(Docker):

```bash
docker run -d --name oc-test-pg -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=openclaude_test -p 55432:5432 postgres:16
docker run -d --name oc-test-redis -p 56379:6379 redis:7
```

unit 套件只用到 PG(`TEST_REDIS_URL` 仅 integ 测试使用);测试代码内置默认
`postgres://test:test@127.0.0.1:55432/openclaude_test`,端口对上即可零配置。

## commercial-integ:分层 + 四条判绿判据

### 为什么单独一层

`packages/commercial` 的单测把"SQL 真行为"**显式 delegate 给 integ**
(`turnDispatchStore.test.ts` / `turnDispatchReconciler.test.ts` /
`preferences.test.ts` 的头注释白纸黑字写着"由 integ 覆盖")。而 2026-07-26 门禁
审计实测:这 110 个 `*.integ.test.ts` / 1549 个用例在 CI、deploy、playbook 三处
**都不跑** —— 委派链的下游根本不存在,近 30 天还新增了 59 个文件进这个黑洞。
本节记录把它接成真门的方案。

### 分层与分片

单一权威 = `.github/integ-tiers/*.txt`(格式与登记规则见该目录 README):

| 梯队 | 文件数 | 在哪跑 | 红了怎么办 |
| --- | --- | --- | --- |
| `pr-1` / `pr-2` / `pr-3` | 22 | `v5-ci.yml` 的 `commercial-integ` matrix,每 PR | 阻塞合并 |
| `nightly-1` … `nightly-5` | 87 | `v5-integ-nightly.yml`,每日 03:00 沪时 | 开工单,不阻塞 PR |

PR 门第一梯队绿 = **能注册、能收到验证信、能登录、refresh 家族被盗会整族吊销、
下单加积分、同一 request_id 只扣一次钱、会话 tape 能落 PG 也能读回、迁移链能从零
重放且校验和不漂、每张新表都登记了保留策略**。

分片不是为了好看:PR#131 当初就是 integ job 撞 45min 全局 timeout,把合并卡死
8 天。每片在清单头声明 `# max-minutes: N` 预算,超预算的正确处置是**拆片**,
不是调大 timeout。

### 四条判绿判据(刻意比 unit 的基线 diff 严)

`diff-known-failures.sh` 只比"失败集 ⊆ 基线",skip 掉的、根本没跑的、TAP plan 被
截断的,它一律当绿。integ 恰恰是最容易"静默不跑"的一层 —— 实测坏连接串下
`settleUsage.integ` 输出 `# tests 16 / pass 0 / fail 0 / skipped 16`,**exit 0**。
照抄那套等于把 fail-open 换个地方复现。`commercial-integ-gate.sh` 要求四条同时成立:

| 判据 | 含义 | 防的是 |
| --- | --- | --- |
| G1 | 失败集 ⊆ 基线 | 新增回归 |
| G2 | `skipped == 0` | fixture 缺失被当成"通过" |
| G3 | `executed >= min-tests` | 用例被删 / 被 `--test-only` 圈掉 |
| G4 | TAP `1..N` 存在且 N == 实际测试点数 | 进程中途死掉、输出被截断 |

`min-tests` 写在各清单头。**用例只增不减**,所以它取"当前实测用例数"即可;
有人删用例导致低于下界,门会红,这是刻意的。有意删用例时同步下调并在 PR 说明。

### fixture fail-closed 必须对每种 fixture 逐一成立

- PG:`REQUIRE_TEST_DB=1`(gate 脚本无条件 export,CI job 又设 `CI=true`)。
- Redis:此前 20 个用到 `TEST_REDIS_URL` 的文件只有 6 个在缺 Redis 时抛,其余 14 个
  静默降级(HTTP handler 干脆不装配)—— "绿"只证明了没跑。现已统一补
  `if (!redis && REQUIRE_TEST_DB) throw`。
- docker:`agentSupervisor.integ` 用 `REQUIRE_TEST_DOCKER`(CI 上恒真,GitHub runner
  自带 dockerd);本地开发机没 docker 仍可 skip。

### 漂移门

`npm run lint:integ-tiers`(`scripts/check-integ-tiers.ts`,范式同
`scripts/check-schedulers.ts`)守 5 条规则:每个磁盘上的 integ 文件必须被某清单
收录 / 清单里的路径必须存在 / 不得重复登记 / 每清单必须声明 `min-tests` 与
`max-minutes` / 至少有一个 `pr-*` 清单。没有这条门,一年后又会攒出一堆谁也不跑的
用例 —— 这正是本次审计发现的那 110 个的成因。

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
6. **biome lint 尚未进 CI**:`npm run lint`(`biome check packages`)当前
   **3657 error / 38 warning** 存量(2026-07-26 实测,退出码 1)。直接挂进 CI 会让
   所有 PR 永久红,等于把 required check 变成噪声。正确顺序是先立"新增文件必须
   干净"的增量门(biome 只扫改动文件),再分批清存量,最后才把全量 `npm run lint`
   提为硬门。本轮只把 `lint:scheduler-wiring` 与 `lint:agent-containers-sql`
   两条**已经是绿的**规则挂进 lint job。
8. **`lint:migration-order` 暂未挂进 lint job**:改 `.github/workflows/*` 需要
   `workflow` scope,当前 gh token(OAuth,scopes: gist/read:org/repo)没有,push 会被
   GitHub 直接拒。折中是把同一套规则**对真实仓库状态的断言**放进
   `scripts/__tests__/migrationOrderGate.test.ts`,由已在 CI 里的 `test:v5:ops` 执行 ——
   强制力等价,只是报错落在 v5-ops job 而不是 lint job。拿到 workflow scope 后可以把
   `npm run lint:migration-order` 直接加进 lint job 与 `check:v5`(两处必须同时加,
   否则 `check:ci-parity` 红)。
7. **`test:v5:ops` 仍是显式文件清单**:`scripts/__tests__/` 下有
   `v5ModelAuthorityRollback` / `v5MutationLease` / `v5RuntimeReleaseLib` /
   `v5SelfhealDrillSafety` 四个测试文件,全仓无任何 script / workflow / 文档引用
   —— 写了从来没跑过。本机实跑 4 个文件共 40 断言,其中
   `v5 runtime-release lib (hotcfg core)` 一条红(疑与本机 docker/权限环境有关,
   未定性)。因为不能带着红进 CI,本轮只补挂了 `knownFailuresGate.test.ts`,
   其余四个连同"改成递归 `find` 发现"一起留到下一轮。
