# V5 受控并行委派发布门

这套人工发布评测验证两件事：

1. CCB 与 Codex 都会在适合的长任务中使用平台 `delegate_tasks`，不会递归委派、
   机械 fan-out 或叠加后台 Bash 并行；
2. 候选规则在确定性 hidden gold 全过的前提下，确实缩短墙钟时间，且不会明显增加
   CPU、token、费用、RSS 或 PID 压力。

静态测试只锁定正式 platform bundle 与 gateway fallback 逐字一致；是否真的委派、
是否并发、是否更快、质量是否保持，都由真实浏览器 turn 和权威账本/容器证据判定。

## 评测设计

V5 没有“仅给 synthetic canary 用户切换新 platform bundle”的官方 lane；bundle
激活是全局变更，`deploy-v5.sh --canary` 不能提供新 bundle 的用户级 0% 隔离。
因此不能伪造 0% bundle A/B，也不能手改 symlink/env/runtime tuple。

发布门分两阶段：

- **预部署因果 A/B**：在冻结的 stable lane 上，只通过产品支持的 persona API 给
  synthetic `main` Agent 的 system slot 追加候选规则。A 是原 persona，B 是原
  persona + 与正式 bundle 逐字相同的 `candidate-rule.md`。
- **正式激活后 smoke**：预部署 A/B 和完整 diff 审查 PASS 后，走官方部署激活正式
  bundle；立即用实际 stable release/bundle/image/prompt SHA 跑双引擎精确 smoke。
  任一新发、恶化或原因不明异常，先在同一操作回合执行官方 rollback，再排查。

预部署证明规则本身的因果效果；上线后 smoke 证明正式接线和实际 tuple。两者都 PASS
才算完成。

## 冻结门槛

- 每个 root 为 2 个 engine × 4 个 scenario × 4 个 pair × A/B，共 **64 个
  预部署 run**；必须用同一冻结 manifest 完整执行两个身份互不复用的 root，共
  **128 个 run**，两个 root 必须各自独立 PASS。
- pair 顺序固定为 `A_FIRST/B_FIRST/A_FIRST/B_FIRST`。总体和每个顺序层内都必须
  通过速度/资源门，排除“第二臂天然热身更快”。
- 每个 pair 使用一个全新 reprovision 后的 synthetic 容器；首臂开始时容器启动不超过
  5 分钟、restart count=0，且该 uid 在本次容器启动后没有任何 prior dispatch/usage。
  两臂必须是同一容器，不同 pair 的 Docker ID 不得复用。第二臂开始前只能存在首臂
  的一个 main dispatch，usage 行数必须精确等于首臂 receipt 行数，拒绝任何插入 turn。
- `document_batch` / `code_batch` 的 B 必须恰好成功调用一次 `delegate_tasks`，
  2–4 shards，且 canonical `delegate_progress` 证明至少两个 child 真实重叠。
- `simple` / `dependent` 禁止 batch fan-out，最多一次质量型 `delegate_task`。
- 零递归委派、零底座原生多 Agent；不得同时使用 `delegate_tasks` 与后台 Bash fan-out。
- A/B 每个 run 的确定性 gold 都必须全过。文档按页、表格、公式、样式精确比较；
  代码由 `bubblewrap + prlimit` 的一次性 network/PID/mount namespace 执行未公开边界
  测试，并限制 address space、heap、进程/FD/输出和硬 timeout；缺少沙箱命令即
  fail closed，不回退宿主执行。不使用 LLM-as-judge。
- 对每个 engine/正向 scenario 分别计算 B/A 中位数，并在 A_FIRST、B_FIRST 两层
  分别复核：wall `<= 0.85`，CPU/token/credit `<= 1.10`。至少 3/4 pair 必须在
  wall/CPU/token/credit 四项上**联合** `<= 1.10`，且至少 3/4 pair 的 wall
  `<= 0.85`，禁止中位数掩盖混合退化。
- 对 `simple` / `dependent` 同样按总体和两个顺序层复核 wall/CPU/token/credit，
  B/A 均须 `<= 1.10`，并要求至少 3/4 pair 在四项上联合 `<= 1.10`，避免“不误并行
  但普通任务整体或大多数重复样本变慢”。
- 峰值 RSS/PID 均低于容器 limit 的 90%；零 OOM/oom_kill、PID max、
  queue timeout/full、异常重试、失败/未结算 usage。
- generator/scenarios/gold、远端 probe、synthetic uid/container、stable lane、
  persona/prompt、model/effort、runtime tuple、peer→dispatch→agent_container→Docker
  的 SHA/身份全部预注册。
- root/child token 与费用来自精确 usage receipt；capture 和 scorer 都从原始 frames、
  cgroup samples、receipt 与 transcript SHA 重算关键证据；最终答案也以 canonical WS
  text blocks 为权威，不信任 DOM 转义后的文本。
- 每个 pair 的受支持 reprovision 登录只执行一次，并把 access expiry 与最新 `oc_rt`
  放进该 pair 独占的 0700 临时目录/0600 session 文件。A/B capture 和 persona 切换
  串行复用该 session；access 临期或 401 时正常 refresh，浏览器轮换后的最新 cookie
  必须回写。pair 结束先 logout 撤销 refresh token，再无条件删除临时目录。不得通过
  放宽生产登录限流或清 Redis 来运行评测。
- 缺失、额外、重复 run，任一 `*.failed.json`，或任一证据字段不完整，全部失败。
- 两个 root 的 manifest 必须 byte-identical；每个 root 内的 A/B 身份关系由完整 scorer
  逐项验证，Docker ID、peer ID、pair execution ID、transcript SHA 和 run SHA 在两个
  root 之间不得复用。两个报告在冻结生产证据时都会重新评分并要求 byte-identical。
- 质量 PASS 但速度门未过也不发布；不得为过门临时放宽阈值或并发。

## 1. 生成 fixture

```bash
ROOT=$(mktemp -d /tmp/v5-parallel-eval.XXXXXX)
python3 evals/v5-parallel-delegation/generate-fixtures.py --out "$ROOT"
```

`$ROOT/input` 是唯一允许上传给 Agent 的目录。`gold`、manifest、generator 和仓库源码
不得进入 Agent workspace。generator 拒绝写入非空目录；重复生成必须使用新目录且
输入 byte-identical，禁止删除失败证据后在原 root 重跑。

## 2. 冻结 stable lane、persona、prompt、probe 与 synthetic 目标

先确认官方 `deploy_state.phase=stable`、candidate 为空、没有 mutation owner/marker。
分别为 CCB、Codex 准备无真实流量的 synthetic 账号；保存原 persona：

```bash
node evals/v5-parallel-delegation/persona-variant.mjs snapshot \
  --out /secure/path/ccb-base-persona.txt
# 切换到 Codex synthetic 凭据后另存 codex-base-persona.txt。
```

把仓库内 probe 原样复制到远端只读临时路径，随后绑定 manifest：

```bash
node evals/v5-parallel-delegation/bind-manifest.mjs \
  --manifest "$ROOT/manifest.json" \
  --ccb-base-persona /secure/path/ccb-base-persona.txt \
  --codex-base-persona /secure/path/codex-base-persona.txt \
  --rule evals/v5-parallel-delegation/candidate-rule.md \
  --baseline-prompt-rev <active-platform-prompt-sha256> \
  --candidate-prompt-file \
    packages/commercial/agent-sandbox/platform-runtime/prompts/platform-capabilities.md \
  --probe evals/v5-parallel-delegation/remote-probe.sh \
  --ccb-user-id <uid> --ccb-container <oc-v5-uN> \
  --codex-user-id <uid> --codex-container <oc-v5-uN> \
  --baseline-generation <deploy-generation> \
  --baseline-active-slot <A-or-B> \
  --baseline-active-release <absolute-active-release> \
  --baseline-image <exact-image> \
  --baseline-image-id <exact-image-id> \
  --baseline-runtime-release <exact-runtime-release> \
  --baseline-platform-bundle <exact-platform-bundle>
```

Binder 会把传入 rule、正式 prompt 和 probe 与当前 checkout 内上述三个 canonical 文件
逐字比较，并要求正式 prompt 含完整 rule；替换路径或更易过门的变体会直接失败。

正式 root 一旦出现失败证据就整体保留并重建，不删除失败 run 后挑样。

## 3. 执行两套独立预部署 64-run A/B

公共环境：

```bash
export V5_EVAL_BASE=https://claudeai.chat
export V5_EVAL_SSH_HOST=kl-mirror
export V5_EVAL_FIXTURES="$ROOT"
export V5_EVAL_MANIFEST="$ROOT/manifest.json"
export V5_EVAL_PROBE_PATH=/remote/path/remote-probe-<sha>.sh
export V5_EVAL_RUNS_DIR="$ROOT/runs"
export V5_EVAL_PERSONA_PATH=/home/agent/.openclaude/agents/main/CLAUDE.md
export V5_EVAL_RULE_FILE="$PWD/evals/v5-parallel-delegation/candidate-rule.md"
```

每次运行 pair 前必须通过产品支持的容器回收/reprovision 路径得到新 Docker ID，再为
对应 engine 设置账号、密码和 base persona。reprovision 的唯一一次登录还必须原子写入
本 pair 的 auth session；目录必须由 `mktemp -d /tmp/v5-parallel-auth.XXXXXX` 创建，
且不得与其他 pair/engine 共用：

```bash
export V5_EVAL_ENGINE=ccb                 # 或 codex
export V5_EVAL_EMAIL=<synthetic-email>
export V5_EVAL_PASSWORD_FILE=<password-file>
export V5_EVAL_PERSONA_BASE_FILE=/secure/path/base-persona.txt
AUTH_DIR=$(mktemp -d /tmp/v5-parallel-auth.XXXXXX)
chmod 0700 "$AUTH_DIR"
export V5_EVAL_AUTH_SESSION_FILE="$AUTH_DIR/session.json"
export V5_EVAL_SCENARIO=code_batch        # 四个 scenario 逐一执行
export V5_EVAL_PAIR_ID=01                 # 01..04
# 产品支持的 reprovision helper 在此执行唯一一次登录并写入 session.json。
evals/v5-parallel-delegation/run-pair.sh
```

`run-pair.sh` 按 manifest 顺序切 system-slot persona、连续跑两臂，并用 trap 恢复原
persona、logout 并删除 auth session。`capture.mjs` 通过真实 Web session 上传、发送和
WS 获取最终结果；远端
`remote-probe.sh` 同一次 SSH 采集 uid 精确 activity、usage receipts、dispatch/
container binding、容器启动后的 prior turn 数、deploy lane 和 cgroup 指标。

第一套 64-run 完成后，从另一个全新空 root 重新生成全套 fixture，使用完全相同的冻结
参数绑定 manifest，并在开跑前确认两份 `manifest.json` byte-identical，再执行全部
64 个 run。不得复用第一套的容器、peer、pair execution、transcript 或 run 证据，也
不得在看到第一套结果后修改门槛、fixture、gold、rule 或 manifest。

## 4. 评分并冻结证据

```bash
node evals/v5-parallel-delegation/score.mjs \
  --runs "$ROOT/runs" \
  --gold "$ROOT/gold/gold.json" \
  --manifest "$ROOT/manifest.json" \
  --mode isolated-ab \
  --out "$ROOT/report.json"
```

两个 root 都必须分别评分且退出码为 0，才能进入完整 diff 独立审查、CI 和正式部署。
冻结生产 smoke manifest 时会对两个 root 重新执行完整 scorer，要求两份重算报告各自与
现有 report **byte-identical**，并验证跨 root 身份/证据互不复用，因此伪造 PASS、
只放 A 臂、漏 run、替换 transcript 或复制第一套结果都无法冻结：

```bash
node evals/v5-parallel-delegation/freeze-production-manifest.mjs \
  --isolated-manifest "$ROOT/manifest.json" \
  --isolated-report "$ROOT/report.json" \
  --isolated-runs "$ROOT/runs" \
  --replicate-manifest "$REPLICATE_ROOT/manifest.json" \
  --replicate-report "$REPLICATE_ROOT/report.json" \
  --replicate-runs "$REPLICATE_ROOT/runs" \
  --gold "$ROOT/gold/gold.json" \
  --out "$ROOT/production-manifest.json" \
  --candidate-bundle-rev <actual-bundle> \
  --candidate-runtime-release <actual-runtime-release> \
  --candidate-image <actual-image> \
  --candidate-image-id <actual-image-id> \
  --candidate-master-release <actual-stable-master-release> \
  --candidate-generation <actual-stable-generation> \
  --candidate-slot <actual-stable-slot>
```

## 5. 正式激活后的双引擎 smoke

官方部署稳定后，production manifest 只接受：

- B / `platform-bundle`；
- 精确 candidate prompt、base persona、rule SHA；
- 精确 stable lane 与 image/runtime/bundle tuple；
- CCB + Codex；
- `code_batch`（必须真实并行且 hidden gold 全过）和 `dependent`（不得 fan-out）；
- 固定 pair01，共 **4 个 run**。

评分：

```bash
node evals/v5-parallel-delegation/score.mjs \
  --runs "$ROOT/production-smoke-runs" \
  --gold "$ROOT/gold/gold.json" \
  --manifest "$ROOT/production-manifest.json" \
  --mode production-smoke \
  --out "$ROOT/production-smoke-report.json"
```

production smoke 的 wall 上限是冻结 A baseline 中位数的 125%，只负责发现正式接线后的
灾难性退化；15% 加速结论来自两套各自完整、顺序平衡且独立 PASS 的预部署
128-run A/B。

四次 smoke 每次都先通过产品支持路径 reprovision 对应 synthetic 容器，再执行：

```bash
export V5_EVAL_MANIFEST="$ROOT/production-manifest.json"
export V5_EVAL_RUNS_DIR="$ROOT/production-smoke-runs"
export V5_EVAL_ENGINE=ccb           # ccb、codex 各执行
export V5_EVAL_SCENARIO=code_batch # code_batch、dependent 各执行
export V5_EVAL_EMAIL=<matching-synthetic-email>
export V5_EVAL_PASSWORD_FILE=<matching-password-file>
evals/v5-parallel-delegation/run-production-smoke.sh
```

脚本只产生 B / `platform-bundle` run，不会改 persona；capture 会拒绝非 fresh container、
错误 lane/tuple/prompt/persona，以及同名证据覆盖。

上线验收还必须检查官方 health、真实双引擎 turn、J1–J5、monitor，以及 V3 inactive。
任何上线期异常先按 `deploy_state` 使用 canonical `scripts/deploy-v5.sh --abort` 或
`--rollback` 恢复旧稳定版，禁止先排查、手改 tuple/symlink/unit 或清 mutation marker。
