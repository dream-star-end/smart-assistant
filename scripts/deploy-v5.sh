#!/usr/bin/env bash
# deploy-v5.sh — v5 Aurora 灰度实例的专属部署 lane(与 deploy-v3.sh 完全分离)。
#
# v5 = 同机(kl-mirror)第二 gateway 实例,与现网 v3 完全隔离:
#   - 源码树   /opt/openclaude/openclaude-v5      (本脚本 rsync 的单一权威)
#   - HOME     /root/.openclaude-v5               (会话 SQLite/uploads,独立)
#   - env      /etc/openclaude/commercial-v5.env  (从 v3 env 派生 + 覆盖键)
#   - 端口     127.0.0.1:18790                    (openclaude.json gateway.port)
#   - systemd  openclaude-v5.service
#   - 日志     /var/log/openclaude-v5.log
#   - 共享     PG / Redis(身份·计费·账号池权威),但控制面静默(channel=v5)
#
# 红线:本脚本【绝不】 touch v3 的 openclaude.service / commercial.env /
#       /opt/openclaude/openclaude / /root/.openclaude / Caddy。Caddy 标签分流由
#       独立步骤(scripts/v5-caddy-*.sh,人工 + 加法式 + 备份 + reload)处理。
#
# 用法:
#   scripts/deploy-v5.sh --bootstrap   # 首次:建源码树/HOME/openclaude.json/env/unit + 拷依赖 + 起服务
#   scripts/deploy-v5.sh               # 增量部署:快照 + rsync 源码 + restart v5 + smoke
#   scripts/deploy-v5.sh --smoke       # 仅跑 v5 健康/隔离断言
#   scripts/deploy-v5.sh --rollback    # 恢复 .prev.1 + restart
#   scripts/deploy-v5.sh --rollback=N  # 恢复 .prev.N(N=1..5)+ restart
#   scripts/deploy-v5.sh --dry-run     # 只打印将执行的动作
set -euo pipefail

KL_HOST="${KL_HOST:-kl-mirror}"
REMOTE_SRC="/opt/openclaude/openclaude-v5"
REMOTE_V3_SRC="/opt/openclaude/openclaude"
V5_HOME="/root/.openclaude-v5"
V5_ENV="/etc/openclaude/commercial-v5.env"
V3_ENV="/etc/openclaude/commercial.env"
V5_UNIT="openclaude-v5.service"
# egress split 独立进程 unit(容器 LLM 出站面 172.31.0.1:18892)。bootstrap 必装:
# overrides 无条件 OC_EGRESS_SPLIT=1,unit 缺失 → master 以 split 模式起但 18892
# 无人监听,容器 LLM 流量全挂(新机 bootstrap 曾踩此雷)。
V5_EGRESS_UNIT="openclaude-v5-egress.service"
V5_PORT="18790"

# ── 定位 worktree 根 ──
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# Sanity:必须在 v5 worktree(分支 feat/v5-aurora-rewrite),不能在 v3/master 误跑。
BR="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
if [[ "$BR" != feat/v5-* && "${ALLOW_ANY_BRANCH:-0}" != "1" ]]; then
  echo "✗ 当前分支 '$BR' 不是 v5 分支(feat/v5-*)。拒绝部署(ALLOW_ANY_BRANCH=1 跳过)。" >&2
  exit 1
fi

# v3 env 与 v5 覆盖键不可继承的键(端口冲突 / 容器运行时 / 不需要副作用)。
REMOVE_KEYS=(
  AGENT_IMAGE AGENT_NETWORK AGENT_PROXY_URL AGENT_RPC_SOCKET_DIR AGENT_SECCOMP_PATH
  OC_RUNTIME_IMAGE
  EXTERNAL_MTLS_ENABLED EXTERNAL_MTLS_BIND EXTERNAL_MTLS_PORT
  INTERNAL_PROXY_BIND INTERNAL_PROXY_PORT
  FILE_PROXY_ENABLED
  # OC_CODEX_* 六键自 feat/v5-codex-oauth-egress 起重新剥除:v5 codex 只走
  # official_oauth(容器 loopback relay → egress 账号代理 → chatgpt backend,
  # 上游常量在代码内),不再依赖任何 OC_CODEX_* env;防 bootstrap 从 v3 env 回灌。
  OC_CODEX_BASE_URL OC_CODEX_DISABLE_RESPONSE_STORAGE OC_CODEX_MODEL_PROVIDER
  OC_CODEX_PREFERRED_AUTH_METHOD OC_CODEX_PROVIDER_NAME OC_CODEX_WIRE_API
  # v5-owned codex 刷新 actor / drift reconciler 必须自己跑,禁止从 v3 env 继承禁用旗标
  COMMERCIAL_CODEX_REFRESH_ACTOR_DISABLED COMMERCIAL_CODEX_DRIFT_RECONCILER_DISABLED
)

# 守卫:overrides 文件不得含任何 REMOVE_KEYS —— env 生成顺序是"删 REMOVE_KEYS 再追加
# overrides",若 overrides 里又出现被剥离的键,会覆盖剥离让它复活(如 CODEX_REFRESH_ACTOR_DISABLED
# 复活 → 重 bootstrap/DR 后 v5 codex token 无人续期,静默烂池)。让这类矛盾在部署时爆而非 DR 时爆。
assert_overrides_no_remove_keys() {
  local ov="$REPO_ROOT/deploy/v5/commercial-v5.env.overrides" k bad=0
  [ -f "$ov" ] || { echo "FATAL: overrides 文件缺失: $ov" >&2; exit 1; }
  for k in "${REMOVE_KEYS[@]}"; do
    if grep -Eq "^[[:space:]]*${k}=" "$ov"; then
      echo "FATAL: overrides 含 REMOVE_KEYS 键 '${k}' —— 会覆盖 deploy 的剥离,禁止。删掉该行。" >&2
      bad=1
    fi
  done
  [ "$bad" = 0 ] || exit 1
}

DRY=0; MODE="deploy"; ROLLBACK_N=1; RESTART_EGRESS=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --bootstrap) MODE="bootstrap" ;;
    --smoke) MODE="smoke" ;;
    --rollback) MODE="rollback"; ROLLBACK_N=1 ;;
    --rollback=*) MODE="rollback"; ROLLBACK_N="${arg#*=}" ;;
    # egress split(2026-07-02):openclaude-v5-egress 持有在飞 LLM 流,默认部署
    # 【不】重启它(这正是解耦目的);仅 egress 相关代码(anthropicProxy/账号池/
    # 计费 finalize/egress/*)变更时显式带本 flag。重启走 SIGTERM drain。
    --egress) RESTART_EGRESS=1 ;;
    *) echo "未知参数: $arg" >&2; exit 2 ;;
  esac
done
[[ "$MODE" == "rollback" && ! "$ROLLBACK_N" =~ ^[1-5]$ ]] && { echo "✗ --rollback=N 需 N∈1..5" >&2; exit 2; }

run() { if [[ "$DRY" == 1 ]]; then echo "  [dry-run] $*"; else eval "$@"; fi; }
sshk() { if [[ "$DRY" == 1 ]]; then echo "  [dry-run] ssh $KL_HOST '$*'"; else ssh "$KL_HOST" "$@"; fi; }

# 部署顺序守卫(Codex 铁律):引用 runtime_channel 的 P1a 代码上线前,共享库必须先 apply 0088
# 加列(v5 AUTO_MIGRATE=0,须 v3 控制面/人工先迁)。否则 channel-aware 查询会报 "column
# runtime_channel does not exist"。本守卫【只读】校验列存在,缺失即拒部署 + 提示,绝不自行迁移。
assert_runtime_channel_column() {
  if [[ "$DRY" == 1 ]]; then echo "  [dry-run] 跳过 runtime_channel 列前置校验"; return 0; fi
  local has
  has="$(ssh "$KL_HOST" "set -a; . '$V5_ENV' 2>/dev/null; psql \"\$DATABASE_URL\" -tAc \"SELECT 1 FROM information_schema.columns WHERE table_name='agent_containers' AND column_name='runtime_channel' LIMIT 1\"" 2>/dev/null | tr -d '[:space:]')"
  if [[ "$has" != "1" ]]; then
    echo "✗ 部署中止:共享库 agent_containers 缺 runtime_channel 列(迁移 0088 未应用)。" >&2
    echo "  P1a channel-aware 代码依赖该列;请先在受控窗口应用 0088(加列,additive 安全),再重试部署。" >&2
    echo "  (v5 AUTO_MIGRATE=0 不会自动迁移;DR=0,迁移前先备份。)" >&2
    exit 1
  fi
  echo "  ✓ runtime_channel 列已存在(0088 已应用),部署顺序前置满足。"
}

RSYNC_EXCLUDES=(--exclude '.git' --exclude 'node_modules' --exclude 'data'
  --exclude '*.log' --exclude 'dist' --exclude '.codex' --exclude 'packages/desktop'
  --exclude 'VERSION.json')

# 写 VERSION.json(gateway /version 读 cwd/VERSION.json)—— 灰度归属:channel + commit + builtAt。
write_version() {
  local commit builtAt tag
  commit="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  builtAt="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  tag="v5-$commit"
  local json="{\"tag\":\"$tag\",\"commit\":\"$commit\",\"channel\":\"v5\",\"builtAt\":\"$builtAt\"}"
  if [[ "$DRY" == 1 ]]; then echo "  [dry-run] write VERSION.json: $json"; return; fi
  ssh "$KL_HOST" "cat > '$REMOTE_SRC/VERSION.json'" <<<"$json"
  echo "  ✓ VERSION.json: $json"
}

# ───────────────────────── smoke:健康 + 隔离断言 ─────────────────────────
smoke() {
  echo "── v5 smoke(健康 + 隔离断言)──"
  local hz=""; local i
  for i in $(seq 1 10); do
    hz="$(ssh "$KL_HOST" "curl -fsS http://127.0.0.1:${V5_PORT}/healthz" 2>/dev/null || true)"
    [[ -n "$hz" ]] && break
    echo "  /healthz 未就绪,重试 $i/10..."; sleep 2
  done
  echo "  /healthz: $hz"
  [[ -z "$hz" ]] && { echo "✗ v5 /healthz 无响应(10 次重试后)" >&2; return 1; }
  # 深度健康断言(fail-closed):ok=true 含 sessions.db 探活。2026-07-06 存量库
  # schema 事故教训:进程活着但 sessions API 全 500,当时 smoke 只看有响应就放行。
  echo "$hz" | grep -q '"ok":true' || { echo "✗ /healthz ok != true(sessions.db 探活失败?deps 见上方输出)" >&2; return 1; }
  echo "$hz" | grep -q '"sessionsDb":"ok"' || { echo "✗ /healthz deps.sessionsDb != ok(master 形态必须带深度探活字段)" >&2; return 1; }
  # 断言 channel=v5、shared 域 mutator 静默、legacy agentRuntime disabled。
  # 注:P1+ 后 v5 跑真实 on-demand 容器(v3supervisor),containerRuntime=enabled 为正确态。
  # mutator 归属矩阵(commit c79d083e)后,v5 合法运行 v5-owned/local 域 scheduler:
  #   subscriptionRollover(0096 订阅域,v3 树无代码,v5 不跑则全网真空)
  #   accountSlotReaper(纯进程内 slot 租约自愈)
  #   researchJobs(claim/recoverStale 均按 channel 过滤,只动 v5 行)
  #   codexRefresh / codexDriftReconciler(codex OAuth 重接入后 v5-owned:账号池查询
  #     按 runtime_channel 圈定只动 v5 codex 行;v5 不跑则 v5 codex token 无人续期、
  #     禁用账号绑定漂移无人对账。feat/v5-codex-oauth-egress 删两个 DISABLED 旗标后启用)
  #   providerHealth(P3.2:egress 写 provider_health_samples,master 判定写 provider_ops
  #     健康列,均 v5 引入表 / v3 树无代码;仅 health_mode='auto' 自动转移)
  #   wecomAlert(企业微信告警投递:iLink/Telegram 投递寄生 shared 域 startAlertScheduler
  #     v5 controlPlane 关 → 只入库不推送;本 dispatcher 独立 gate 在 channel=v5,claim 按
  #     channel_type='wecom_bot' 过滤,推 admin_alert_outbox 的 wecom 行到企微 webhook。
  #     v3 不认 wecom_bot(else→markFailed,不发)→ 无双发。关停:OC_WECOM_ALERT_DISABLED=1)
  # 隔离不变量升级为**白名单**:schedulers 出现任何名单外条目 = shared 域泄漏,FAIL。
  # (服务端 index.ts 有同语义的 fail-closed 拒启断言,本处是部署面第二道防线。)
  echo "$hz" | grep -q '"channel":"v5"' || { echo "✗ channel != v5" >&2; return 1; }
  local scheds allowed bad
  scheds="$(echo "$hz" | grep -o '"schedulers":\[[^]]*\]' | sed 's/.*\[//;s/\]//;s/"//g')"
  allowed="subscriptionRollover accountSlotReaper researchJobs codexRefresh codexDriftReconciler marketplaceAiReview orphanReconcile providerHealth wecomAlert"
  bad=""
  IFS=',' read -ra _sarr <<<"$scheds"
  for s in "${_sarr[@]}"; do
    [[ -z "$s" ]] && continue
    grep -qw "$s" <<<"$allowed" || bad="$bad $s"
  done
  [[ -n "$bad" ]] && { echo "✗ shared 域 scheduler 泄漏到 v5:$bad" >&2; return 1; }
  echo "$hz" | grep -q '"controlPlaneEnabled":false' || { echo "✗ controlPlaneEnabled 非 false" >&2; return 1; }
  echo "$hz" | grep -q '"agentRuntime":"disabled"' || { echo "✗ agentRuntime 非 disabled(不应起 legacy agent 运行时)" >&2; return 1; }
  local ver; ver="$(ssh "$KL_HOST" "curl -fsS http://127.0.0.1:${V5_PORT}/version" 2>/dev/null || true)"
  echo "  /version: $ver"
  # 现网 v3 零影响断言:v3:18789 仍健康
  local v3hz; v3hz="$(ssh "$KL_HOST" "curl -fsS http://127.0.0.1:18789/healthz" 2>/dev/null || true)"
  echo "  v3 /healthz(应不受影响): $v3hz"
  [[ -z "$v3hz" ]] && { echo "✗ v3 /healthz 异常 —— 现网受影响!" >&2; return 1; }
  # egress split:V5_ENV 声明 OC_EGRESS_SPLIT=1 → 【无条件】断言 egress active + 健康。
  # 旧写法"is-enabled 才查"会在 unit 未安装的坏实例上静默跳过 —— 恰是最该 fail 的场景
  # (master 以 split 模式起,容器 LLM 流量 18892 无人监听、聊天全挂),绿灯放行坏实例。
  # fail-closed:V5_ENV 缺失/ssh 异常 → smoke fail,而非静默按"非 split"跳过断言。
  local split
  split="$(ssh "$KL_HOST" "test -r '$V5_ENV' && grep -E '^OC_EGRESS_SPLIT=' '$V5_ENV' | tail -n 1 | cut -d= -f2-")" \
    || { echo "✗ 读取 $V5_ENV 的 OC_EGRESS_SPLIT 失败(env 文件缺失或 ssh 异常)" >&2; return 1; }
  if [[ "$split" == "1" ]]; then
    ssh "$KL_HOST" "systemctl is-active --quiet openclaude-v5-egress" \
      || { echo "✗ OC_EGRESS_SPLIT=1 但 openclaude-v5-egress 非 active —— 容器 LLM 流量无人监听" >&2; return 1; }
    local eg; eg="$(ssh "$KL_HOST" "curl -fsS --max-time 5 http://172.31.0.1:18892/internal/v5/egress-health" 2>/dev/null || true)"
    echo "  egress-health: $eg"
    echo "$eg" | grep -q '"role":"egress"' || { echo "✗ egress 进程不健康(18892 无响应或非 egress)" >&2; return 1; }
  fi
  echo "✓ v5 smoke 通过:隔离空壳健康、控制面静默、v3 未受影响"
}

# ───────────────────────── bootstrap:首次建立 v5 ─────────────────────────
bootstrap() {
  echo "══ v5 bootstrap on $KL_HOST ══"
  echo "── 守卫:overrides 不得含 REMOVE_KEYS ──"
  assert_overrides_no_remove_keys
  # 1) 源码树
  echo "── 1) rsync v5 源码 → $REMOTE_SRC ──"
  run "rsync -az --delete ${RSYNC_EXCLUDES[*]} '$REPO_ROOT/' '$KL_HOST:$REMOTE_SRC/'"
  write_version
  # 2) 依赖:从 v3 树硬拷(同机同 HEAD 同 lockfile;.ts 经 tsx 运行无需 build)
  echo "── 2) 拷贝 node_modules(root + commercial)从 v3 树 ──"
  sshk "test -d '$REMOTE_SRC/node_modules' || cp -a '$REMOTE_V3_SRC/node_modules' '$REMOTE_SRC/node_modules'"
  # commercial 包级 node_modules:dev worktree 可能有、kl-mirror prod 树通常没有(依赖 hoist 到 root)。
  # 仅当源存在且目标缺失才拷;否则跳过(root node_modules 已含全部依赖)。
  sshk "if [ ! -d '$REMOTE_SRC/packages/commercial/node_modules' ] && [ -d '$REMOTE_V3_SRC/packages/commercial/node_modules' ]; then cp -a '$REMOTE_V3_SRC/packages/commercial/node_modules' '$REMOTE_SRC/packages/commercial/node_modules' && echo '  ✓ commercial pkg node_modules 已拷'; else echo '  (commercial pkg node_modules 源不存在/目标已有 → 跳过;依赖在 root node_modules)'; fi"
  # 3) HOME + openclaude.json(从 v3 派生:改 gateway.port/bind、清空 channels)
  echo "── 3) $V5_HOME/openclaude.json(port=$V5_PORT, channels 清空)──"
  sshk "mkdir -p '$V5_HOME'"
  # 从 v3 的 openclaude.json 派生:改 gateway.port/bind/accessToken、清空 channels(P0 壳不跑渠道)
  sshk "jq '.gateway.port=${V5_PORT} | .gateway.bind=\"127.0.0.1\" | .gateway.accessToken=\"commercial-v5-unused\" | .channels={}' /root/.openclaude/openclaude.json > '$V5_HOME/openclaude.json'"
  # 4) env:拷 v3 env → 删 REMOVE_KEYS → 追加 v5 覆盖键
  echo "── 4) $V5_ENV(派生自 v3 + 覆盖)──"
  local rmpat; rmpat="$(IFS='|'; echo "${REMOVE_KEYS[*]}")"
  run "rsync -az '$REPO_ROOT/deploy/v5/commercial-v5.env.overrides' '$KL_HOST:/tmp/commercial-v5.env.overrides'"
  sshk "set -e; preserved_secret=''; if [ -f '$V5_ENV' ]; then preserved_secret=\$(grep -E '^OC_EGRESS_SECRET=' '$V5_ENV' | tail -n 1 | cut -d= -f2- || true); fi; if [ -z \"\$preserved_secret\" ]; then pid=\$(systemctl show -p MainPID --value openclaude-v5-egress 2>/dev/null || true); if [ -n \"\$pid\" ] && [ \"\$pid\" != 0 ] && [ -r /proc/\$pid/environ ]; then preserved_secret=\$(tr '\\0' '\\n' < /proc/\$pid/environ | sed -n 's/^OC_EGRESS_SECRET=//p' | tail -n 1 || true); fi; fi; if [ -z \"\$preserved_secret\" ]; then preserved_secret=\$(openssl rand -hex 32); fi; grep -Ev '^[[:space:]]*(${rmpat})=' '$V3_ENV' > '$V5_ENV.tmp' && { echo ''; echo '# ===== v5 overrides (deploy-v5.sh) ====='; cat /tmp/commercial-v5.env.overrides; printf '\nOC_EGRESS_SECRET=%s\n' \"\$preserved_secret\"; } >> '$V5_ENV.tmp' && mv '$V5_ENV.tmp' '$V5_ENV' && chmod 600 '$V5_ENV'"
  # 5) systemd unit(master + egress 一并装:见 V5_EGRESS_UNIT 定义处的踩雷说明)
  echo "── 5) 安装 $V5_UNIT + $V5_EGRESS_UNIT ──"
  run "rsync -az '$REPO_ROOT/deploy/v5/$V5_UNIT' '$KL_HOST:/etc/systemd/system/$V5_UNIT'"
  run "rsync -az '$REPO_ROOT/deploy/v5/$V5_EGRESS_UNIT' '$KL_HOST:/etc/systemd/system/$V5_EGRESS_UNIT'"
  sshk "systemctl daemon-reload"
  # 5.5) 部署顺序守卫:P1a channel-aware 代码需共享库已加 runtime_channel 列(0088)。
  echo "── 5.5) 部署顺序守卫:校验 runtime_channel 列(0088)已应用 ──"
  assert_runtime_channel_column
  # 6) 启动 + 环境隔离断言(egress 先起:master split 模式依赖 18892 已有人监听)
  echo "── 6) 启动 openclaude-v5-egress + openclaude-v5 + 环境隔离断言 ──"
  sshk "systemctl enable --now $V5_EGRESS_UNIT"
  sshk "systemctl enable --now $V5_UNIT"
  echo "  等待起活..."; run "sleep 4"
  sshk "systemctl show $V5_UNIT -p Environment | grep -q 'OPENCLAUDE_HOME=$V5_HOME' && echo '  ✓ OPENCLAUDE_HOME 隔离' || echo '  ✗ HOME 未隔离'"
  sshk "grep -q 'COMMERCIAL_AUTO_MIGRATE=0' '$V5_ENV' && echo '  ✓ AUTO_MIGRATE=0' || echo '  ✗ AUTO_MIGRATE 未关'"
  [[ "$DRY" == 1 ]] || smoke
  echo "✓ bootstrap 完成。下一步:Caddy 标签分流(独立、人工、加法式)。"
}

# ───────────────────────── deploy:增量 ─────────────────────────
deploy() {
  echo "══ v5 deploy on $KL_HOST ══"
  echo "── 守卫:overrides 不得含 REMOVE_KEYS ──"
  assert_overrides_no_remove_keys
  # 快照轮转 .prev.1..5
  echo "── 快照 $REMOTE_SRC → .prev.1(轮转 1..5)──"
  # 轮转用 if(非 && 链)——避免 set -e 下 `[ test ] && cmd` 在 test 失败时整体非零退出;
  # 且 n=5(最旧)直接 rm 丢弃,不再 mv 到 .prev.6(旧逻辑那条 bug 会造出嵌套的 .prev.6)。
  sshk "set -e; for n in 5 4 3 2 1; do m=\$((n+1)); if [ -d '$REMOTE_SRC.prev.'\$n ]; then if [ \$m -le 5 ]; then rm -rf '$REMOTE_SRC.prev.'\$m; mv '$REMOTE_SRC.prev.'\$n '$REMOTE_SRC.prev.'\$m; else rm -rf '$REMOTE_SRC.prev.'\$n; fi; fi; done; rm -rf '$REMOTE_SRC.prev.6'; rsync -a --delete ${RSYNC_EXCLUDES[*]} '$REMOTE_SRC/' '$REMOTE_SRC.prev.1/'"
  echo "── rsync v5 源码 ──"
  run "rsync -az --delete ${RSYNC_EXCLUDES[*]} '$REPO_ROOT/' '$KL_HOST:$REMOTE_SRC/'"
  write_version
  echo "── 部署顺序守卫:校验 runtime_channel 列(0088)已应用 ──"
  assert_runtime_channel_column
  echo "── restart openclaude-v5(仅 v5,绝不碰 v3)──"
  sshk "systemctl restart $V5_UNIT"
  run "sleep 4"
  if [[ "$RESTART_EGRESS" == 1 ]]; then
    echo "── restart openclaude-v5-egress(显式 --egress;SIGTERM drain 在飞流)──"
    sshk "systemctl restart openclaude-v5-egress"
    run "sleep 3"
  fi
  [[ "$DRY" == 1 ]] || smoke
  echo "✓ deploy 完成。"
}

# ───────────────────────── rollback ─────────────────────────
rollback() {
  echo "══ v5 rollback ← .prev.$ROLLBACK_N ══"
  sshk "test -d '$REMOTE_SRC.prev.$ROLLBACK_N' || { echo '✗ 快照 .prev.$ROLLBACK_N 不存在' >&2; exit 1; }"
  sshk "rsync -a --delete ${RSYNC_EXCLUDES[*]} '$REMOTE_SRC.prev.$ROLLBACK_N/' '$REMOTE_SRC/'"
  sshk "systemctl restart $V5_UNIT"
  run "sleep 4"
  [[ "$DRY" == 1 ]] || smoke
  echo "✓ rollback 完成。"
}

case "$MODE" in
  bootstrap) bootstrap ;;
  deploy)    deploy ;;
  smoke)     smoke ;;
  rollback)  rollback ;;
esac
