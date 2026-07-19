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
| web-react | `check:tutorials` + `test:web-react` + `test:browser` | 同左(browser-tests 双遍:桌面+移动仿真,含覆盖面 manifest 门) | 30 min |
| web | `npm run test:web:gate` | 同左(基线 diff 门,`.github/known-failures/web.txt`) | 15 min |
| mcp-memory | `npm run test:mcp-memory` | 同左 | 10 min |
| cli | `npm run test:cli` | 同左(导入图冒烟;plugin-sdk 纯类型包有意不设) | 10 min |
| repo-lints | `lint:scheduler-wiring` + `lint:undefined-refs` | 同左 | 10 min |
| commercial-unit | `npm run test:commercial:unit:gate` | 同左(需本地 PG fixture,见下) | 30 min |
| commercial-integ | `npm run test:commercial:integ:gate` | 同左(需 PG+Redis fixture;基线 bootstrap 流程见 `.github/known-failures/commercial-integ.txt` 头注) | 45 min |
| v5-ops | `npm run test:v5:ops` | 同左(需 PG fixture + root;含 release-safety/canary 契约) | 20 min |

**required checks(GitHub 分支保护,2026-07-18 批F 起)**:typecheck / gateway / storage /
web-react / commercial-unit / v5-ops / web / mcp-memory / cli / repo-lints 共 10 项。
commercial-integ 待基线 bootstrap 完成后加入。改 required 集用
`gh api -X PATCH .../protection/required_status_checks --input <json>`(admin)。

注意:`check:v5` 是 v5 的质量门,**不含** biome lint / integ 测试;v3 的全量门仍是
`npm run check`。**有意不入门并登记为债(2026-07-18 门禁审计批C)**:biome(存量
3614 错误,须专项清理)、`lint:agent-containers-sql`(6 处存量违规待逐个裁定)、
evals(需真实 LLM key);web-react **包级** `tsc -b` 含 vitest 测试文件且有存量类型错
(根级 typecheck 不含),修完才能把包级 typecheck 入门。

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
2. `.github/scripts/diff-known-failures.sh` 从 TAP 提取**所有层级**失败点的
   **全路径**集合(2026-07-18 批C 升级:反向扫描按缩进建 "父 > 子" 路径;绝对路径
   顶层名归一化为仓库相对路径),与基线清单逐行比较。基线行支持两种形态:精确
   路径,或 `X > *` 结尾的显式 glob(仅限负载敏感 flaky 套件,必须带注释理由);
3. **只有基线之外的新增失败才 fail**;基线内的存量失败放行;
   基线里"本轮没失败"的条目打 warning 提示清理;
   TAP 里一个测试点都没有(套件没跑起来)、缺 `# tests N` 收尾汇总(runner 中途
   崩溃,截断守卫)、或 runner 非零退出但抓不到任何 `not ok`(基础设施崩溃)
   → 直接 fail,防假绿。
4. 同一门机制有三个消费者(`tap-suite-gate.sh` 通用 wrapper):commercial-unit /
   web(`known-failures/web.txt`)/ commercial-integ(`known-failures/commercial-integ.txt`,
   初始为空,bootstrap 流程见其头注)。

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

- **修掉一个存量失败 → 从清单删掉对应行**(CI 的 stale warning 会提醒你)。
  目标是清单单调递减、最终删空。
- **新增失败原则上禁止入清单**(那是回归,修代码去)。唯一例外:环境变化
  暴露出的、可证明与本次改动无关的历史失败,加行时必须在 PR 里说明依据。
- 重新生成 / 核对清单(在仓库根目录,需本地 PG fixture):

  **基线真值必须取自 CI 环境的 TAP artifact,不是本机**(两边环境失败集不同;
  历史清单曾由本机实跑生成,批C 起废止该做法):

  ```bash
  gh run list --branch feat/v5-aurora-rewrite --limit 3   # 找最近的绿 run
  gh run download <run-id> -n commercial-unit-tap
  # 提取全路径失败集(与 diff-known-failures.sh 的 awk 一字不差):
  tac commercial-unit.tap | awk '
  /^( *)(not )?ok [0-9]+ - / {
    line=$0; indent=0
    while (substr(line, indent+1, 1) == " ") indent++
    name=line
    sub(/^ *(not )?ok [0-9]+ - /, "", name)
    sub(/ # (TODO|SKIP).*$/, "", name)
    sub(/^\/[^ ]*\/packages\//, "packages/", name)
    sub(/^\/[^ ]*\/scripts\//, "scripts/", name)
    sub(/^\/[^ ]*\/e2e\//, "e2e/", name)
    ctx[indent]=name
    if (line ~ /^ *not ok /) {
      path=name
      for (d=indent-4; d>=0; d-=4) { if (d in ctx) path=ctx[d] " > " path }
      print path
    }
  }' | sort -u
  ```

  当前 commercial-unit 清单由三轮 CI TAP artifact(2026-07-18,HEAD=6cd5a5f7)
  并集生成:122 条精确路径 + 7 个 flaky 套件的显式 `> *` glob。

- 粒度语义(批C 升级后):基线内 suite 的**内部新增子失败一样会红**(旧版按顶层
  suite 整体豁免的盲区已消灭);只有显式 `X > *` glob 的 flaky 套件仍整体豁免——
  glob 越少门越灵敏,连续两周 stale 的 glob 条目应删除。

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
