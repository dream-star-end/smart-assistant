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
#   scripts/deploy-v5.sh --with-dist   # 代码+前端两生效面、【单次】重启(首选;两段式成对重启会二次掐断在途 turn)
#   scripts/deploy-v5.sh --runtime-image=REF --runtime-image-id=sha256:...
#                                  # 在线切换已构建 slim image；完整 tuple 由 hotcfg joint saga 原子提交
#   scripts/deploy-v5.sh --with-dist --defer-knowledge-planet-upgrade
#                                  # 一次性先上线知识星球扫码 UI；保留旧 v1.0 执行 pin，扫码后再走正常升级
#   scripts/deploy-v5.sh --smoke       # 仅跑 v5 健康/隔离断言
#   scripts/deploy-v5.sh --dist        # 仅前端生效面:vite build + 竞态安全 rsync + 资产GC + restart + 版本握手 smoke
#   scripts/deploy-v5.sh --census-ccb-baseline  # 只读统计缺 baseline mount 的 V5 容器
#   scripts/deploy-v5.sh --remount-ccb-baseline # 持部署锁，逐个 drain/reprovision 后复验
#
# 并发:所有写模式过 /var/lock/oc-v5-deploy.lock 全局互斥(多会话并行开发硬保证),
#       持有者信息在 .holder;等待 900s 超时 fail-loud。开发发布还必须先进入
#       scripts/v5-release-queue.sh 的持久 FIFO；一个 active 项覆盖 merge→finalize 全周期。
#   scripts/deploy-v5.sh --prepare-offline-cutover --target-image=TAG
#                                  # 服务在线健康时生成一次性离线切换清单/完整恢复包
#   scripts/deploy-v5.sh --offline-recycle --cutover-nonce=NONCE
#   scripts/deploy-v5.sh --stage --cutover-nonce=NONCE
#   scripts/deploy-v5.sh --activate-staged --cutover-nonce=NONCE
#   scripts/deploy-v5.sh --rollback    # 恢复 .prev.1 + restart(收尾追加一次非阻断 real-turn canary)
#   scripts/deploy-v5.sh --rollback=N  # 恢复 .prev.N(N=1..5)+ restart
#   scripts/deploy-v5.sh --install-monitor # 原子安装独立于 A/B slot 的 host monitor bundle
#   scripts/deploy-v5.sh --reclaim-mutation-lease
#                                  # 回收陈旧的 kl-mirror production-mutation lease:读远端 fencing meta →
#                                  # kill -0 校验 holder → 仅当陈旧(holder 不存在 / 超 TTL)才清锁,否则拒绝并打印持有者。
#                                  # 明知部署已死时可 OC_V5_RECLAIM_FORCE=1 强制(runbook 记载的紧急旁路)。
#   scripts/deploy-v5.sh --dry-run     # 只打印将执行的动作
#
# runtime hotcfg(§5,两轴独立开关):
#   --enable-runtime-release / --enable-platform-bundle    # 首次启用该轴(随本次 deploy 激活)
#   --disable-runtime-release / --disable-platform-bundle  # 禁用该轴:本次激活把 env 键写**空值**
#                                                          # (R2-B1 三态写),走完整 saga+smoke
#   --emergency-tuple [--image=REF --image-id=ID --bundle=DIR]
#       # 登记逃生 tuple。缺省取当前 env 四键;显式候选(R2-M1)供瘦身稳态直接登记内嵌镜像逃生点,
#       # 不必先把现网翻到空 release。硬验含 immutable ID 钉死(inspect .Id == image_id)。
#
# 模型权威(docs/V5_MODEL_AUTHORITY_PLAN.md §7 六步上线;四面 = DB/master/egress/容器 runtime):
#   --model-authority-preflight   # 只读:四面活体 capability 逐面结论(不抢部署锁)
#   --enable-model-authority      # 步骤 4:四面全绿 → OC_MODEL_AUTHORITY=1 → 重启 master+egress → smoke
#   --disable-model-authority     # 步骤 4 回滚:关 flag(**cutover 后拒绝执行**)
#   --model-authority-observation-status # 只读:观察窗/请求/长 turn/canary/seed/emergency 证据
#   --enable-seed-authority-by-rev # 全 fleet(含 stopped)bundle census 后开启 seed 阶段 B
#   --record-model-authority-emergency-drill # emergency 激活+恢复后核验 history 并登记证据
#   --model-authority-cutover     # 步骤 5:置位不可逆兼容地板 marker(DB 单行 + env 键)
#                                 # 置位后:deploy/rollback 拒绝激活缺 capability 的 release/tuple;
#                                 #        master/egress 在 flag 关闭态拒启;admin catalog 状态机开放。
#   --enable-runtime-tape-batching # 显式开启 format-3 runtime-event 物理批存储；要求当前及
#                                  # previous rollback release 都具备 reader capability。
set -euo pipefail

KL_HOST="${KL_HOST:-kl-mirror}"
REMOTE_SRC="/opt/openclaude/openclaude-v5"
REMOTE_V3_SRC="/opt/openclaude/openclaude"
V5_HOME="/root/.openclaude-v5"
V5_ENV="/etc/openclaude/commercial-v5.env"
V3_ENV="/etc/openclaude/commercial.env"
V5_UNIT="openclaude-v5.service"
V5_BASELINE_PORT="18893"
V5_BASELINE_PORT_GUARD_SOCKET="openclaude-v5-baseline-port-guard.socket"
V5_BASELINE_PORT_GUARD_SERVICE="openclaude-v5-baseline-port-guard.service"
# egress split 独立进程 unit(容器 LLM 出站面 172.31.0.1:18892)。bootstrap 必装:
# overrides 无条件 OC_EGRESS_SPLIT=1,unit 缺失 → master 以 split 模式起但 18892
# 无人监听,容器 LLM 流量全挂(新机 bootstrap 曾踩此雷)。
V5_EGRESS_UNIT="openclaude-v5-egress.service"
# 全局 egress 独立 release 指针。它不能跟随 A/B candidate 自动切换；只有显式
# --egress 才原子翻转到本次 release，避免 P3 stable=B 时仍从 slot A 跑旧代码。
V5_EGRESS_SRC="/opt/openclaude/openclaude-v5-egress"
V5_PORT="18790"
# Caddy 对外 HTTP 监听端口。生产固定默认 80；仅隔离预发在宿主 80 被占用时覆盖。
# 在线 deploy 的 planned-maintenance public probe 与 P3 Caddy apply/verify 必须共用此值。
CADDY_HTTP_PORT="${CADDY_HTTP_PORT:-80}"
# ── P3 双 master slot 静态映射(RFC-v5-dual-master-cohort §3)──
# A={openclaude-v5.service, 18790, 私有 18896, HOME /root/.openclaude-v5, 源码 /opt/openclaude/openclaude-v5}
# B={openclaude-v5-b.service, 18795, 私有 18897, HOME /root/.openclaude-v5-b, 源码 /opt/openclaude/openclaude-v5-b}
# leader/VIP(18894)归属由 deploy_state.desired_* 运行时决定,不由 slot 静态映射决定(见 D3/D4)。
slot_port() { case "$1" in A) echo 18790 ;; B) echo 18795 ;; *) return 1 ;; esac; }
slot_priv() { case "$1" in A) echo 18896 ;; B) echo 18897 ;; *) return 1 ;; esac; }
slot_home() { case "$1" in A) echo /root/.openclaude-v5 ;; B) echo /root/.openclaude-v5-b ;; *) return 1 ;; esac; }
slot_unit() { case "$1" in A) echo openclaude-v5.service ;; B) echo openclaude-v5-b.service ;; *) return 1 ;; esac; }
slot_src()  { case "$1" in A) echo /opt/openclaude/openclaude-v5 ;; B) echo /opt/openclaude/openclaude-v5-b ;; *) return 1 ;; esac; }
slot_other() { case "$1" in A) echo B ;; B) echo A ;; *) return 1 ;; esac; }
V5_VIP_PORT="18894"     # egress 唯一目标(desired_control_slot 匹配的实例 bind)
# 共享 union 资产池(Caddy /assets 直服目标;各 release dist/assets 加法式 rsync 进 <pool>/assets/)
V5_ASSETS_POOL="/opt/openclaude/openclaude-v5-assets"
CUTOVER_ROOT="/var/lib/openclaude-v5/cutovers"
CUTOVER_LOCK="/var/lib/openclaude-v5/cutover.lock"
MAINTENANCE_MARKER="/run/openclaude-v5/planned-maintenance.json"
MAINTENANCE_LOCK="/run/openclaude-v5/planned-maintenance.lock"
V5_MONITOR_ROOT="/opt/openclaude/v5-monitor"
V5_MONITOR_STATE="/var/lib/openclaude-v5/monitor-state.json"
# kl-mirror production-mutation lease(RFC-v5-selfheal-batch1b §1.2)。独立于 planned-maintenance
# marker 的一把远端 flock:每个写 lane 在进入任何 lane 逻辑前统一取得,持有到收尾。自愈
# host-action wrapper 用 flock -n 竞同一把锁,拿不到即让路(exit 66)——消除 marker 的
# TTL(180s)/SKIPPED/check→action TOCTOU 三缺陷,把互斥正确性从 marker 移交给真锁。
# OC_V5_PRODUCTION_MUTATION_LOCK 仅供本地 hermetic 测试注入独立锁文件(与 OC_V5_DEPLOY_LOCK_FILE
# 同款"自测可覆盖"约定),线上恒用默认路径。
PRODUCTION_MUTATION_LOCK="${OC_V5_PRODUCTION_MUTATION_LOCK:-/run/openclaude-v5/production-mutation.lock}"
# 远端 holder 硬 TTL(秒):即便本地部署进程被 SIGKILL 绕过 trap、残活的后台 ssh 被 init 收养
# 使远端 sshd 父进程不变(PPid 检测因此不触发),holder 也会在 TTL 到点后自 exit 释放 flock,
# 消除"生产变更被永久焊死、无自动过期"的死锁(C1)。非法/0 → 回退 7200(2h)。
MUTATION_LEASE_TTL_SECONDS="${OC_V5_MUTATION_LEASE_TTL_SECONDS:-7200}"
[[ "$MUTATION_LEASE_TTL_SECONDS" =~ ^[1-9][0-9]*$ ]] || MUTATION_LEASE_TTL_SECONDS=7200
(( MUTATION_LEASE_TTL_SECONDS >= 2 )) || MUTATION_LEASE_TTL_SECONDS=7200
# holder fencing 元数据(reclaim 读它裁决陈旧):{remote_pid,started_at,ttl,deploy_id,holder_host,mode}。
PRODUCTION_MUTATION_LEASE_META="${PRODUCTION_MUTATION_LOCK}.meta"
BASELINE_REMOUNT_TIMEOUT_SECONDS="${OC_V5_BASELINE_REMOUNT_TIMEOUT_SECONDS:-2700}"

# ── 定位 worktree 根 ──
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RELEASE_METADATA="$REPO_ROOT/deploy/v5/release-metadata.json"
BASELINE_GUARD_SCRIPT="$SCRIPT_DIR/v5-baseline-security.sh"
[ -x "$BASELINE_GUARD_SCRIPT" ] || {
  echo "FATAL: 缺或不可执行的 V5 baseline guard: $BASELINE_GUARD_SCRIPT" >&2
  exit 1
}
RELEASE_GC_SCRIPT="$SCRIPT_DIR/v5-release-gc.sh"
[ -x "$RELEASE_GC_SCRIPT" ] || {
  echo "FATAL: 缺或不可执行的 V5 release GC guard: $RELEASE_GC_SCRIPT" >&2
  exit 1
}
cd "$REPO_ROOT"

# ── runtime tuple / platform bundle 纯函数库(宿主本地实现;真实部署 ship 到 kl-mirror 后跑)──
# 设计 docs/V5_RUNTIME_HOTCFG_PLAN.md §1.1/1.2/1.5/3.1。本文件 source 它取 bundle/release/saga/GC
# 的算法核心;deploy 面只做"组装 staging(git archive/cp)+ ship lib + 远端 invoke"的编排。
RUNTIME_LIB="$SCRIPT_DIR/v5-runtime-release-lib.sh"
[ -f "$RUNTIME_LIB" ] || { echo "FATAL: 缺 runtime release lib: $RUNTIME_LIB" >&2; exit 1; }
# shellcheck source=scripts/v5-runtime-release-lib.sh
source "$RUNTIME_LIB"
RELEASE_QUEUE_SCRIPT="$SCRIPT_DIR/v5-release-queue.sh"
[ -x "$RELEASE_QUEUE_SCRIPT" ] || {
  echo "FATAL: 缺或不可执行的 V5 release queue: $RELEASE_QUEUE_SCRIPT" >&2
  exit 1
}
# deploy_state 单一权威访问层(P3;与 v5-caddy-apply.sh 共用 CAS/read/journal/lane_hash 同源)。
DEPLOY_STATE_LIB="$SCRIPT_DIR/v5-deploy-state-lib.sh"
[ -f "$DEPLOY_STATE_LIB" ] || { echo "FATAL: 缺 deploy_state lib: $DEPLOY_STATE_LIB" >&2; exit 1; }
# shellcheck source=scripts/v5-deploy-state-lib.sh
source "$DEPLOY_STATE_LIB"
DS_MODE="${DS_MODE:-remote}"   # remote:ssh→source V5_ENV→psql(生产);local:直连 DS_DATABASE_URL(冒烟)
# hotcfg 制品根(契约固定;env 覆盖仅供本地自测)。history 落 /etc/openclaude(与 env 同域)。
OC_HOTCFG_PLATFORM_ROOT="${OC_HOTCFG_PLATFORM_ROOT:-/var/lib/openclaude-v5/platform}"
OC_HOTCFG_RELEASES_ROOT="${OC_HOTCFG_RELEASES_ROOT:-/var/lib/openclaude-v5/runtime-releases}"
OC_HOTCFG_HISTORY="/etc/openclaude/runtime-tuple.history"
HOTCFG_REMOTE_LIB="/var/lib/openclaude-v5/.deploy-lib/v5-runtime-release-lib.sh"

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
  # CCB baseline 是 slot-local release 内容。共享 env 里的固定 A 路径会让 B slot
  # 挂错 release；OPTIONAL 是 dev-only fail-open；V5 local-only 不跑远程 baseline server。
  OC_V3_CCB_BASELINE_DIR OC_V3_CCB_BASELINE_OPTIONAL OPENCLAUDE_MASTER_BASELINE_BASE_URL
)

# REMOVE_KEYS 有两类:①"剥 v3 值 → overrides 设 v5 专属值"(AGENT_*/OC_RUNTIME_IMAGE/
# INTERNAL_PROXY_*/EXTERNAL_MTLS_* 等,overrides 里合法出现);②"必须绝不出现"——从 v3
# 继承会重新禁掉 v5-owned 职能的禁用旗标。守卫只拦第②类。
# 第②类:v5-owned codex 刷新 actor / drift reconciler 必须自己跑,overrides 里出现其
# *_DISABLED=1 会在"删 REMOVE_KEYS 再追加 overrides"时复活 → 重 bootstrap/DR 后 v5 codex
# token 无人续期,静默烂池。让这类矛盾在部署时爆而非 DR 时爆。
FORBIDDEN_IN_OVERRIDES=(
  COMMERCIAL_CODEX_REFRESH_ACTOR_DISABLED COMMERCIAL_CODEX_DRIFT_RECONCILER_DISABLED
  OC_V3_CCB_BASELINE_DIR OC_V3_CCB_BASELINE_OPTIONAL OPENCLAUDE_MASTER_BASELINE_BASE_URL
)
assert_overrides_no_remove_keys() {
  local ov="$REPO_ROOT/deploy/v5/commercial-v5.env.overrides" k bad=0
  [ -f "$ov" ] || { echo "FATAL: overrides 文件缺失: $ov" >&2; exit 1; }
  for k in "${FORBIDDEN_IN_OVERRIDES[@]}"; do
    if grep -Eq "^[[:space:]]*${k}=" "$ov"; then
      echo "FATAL: overrides 含禁用旗标 '${k}' —— 会覆盖 REMOVE_KEYS 的剥离让 v5-owned 职能被禁,禁止。删掉该行。" >&2
      bad=1
    fi
  done
  [ "$bad" = 0 ] || exit 1
}

DRY=0; MODE="deploy"; ROLLBACK_N=1; RESTART_EGRESS=0; WITH_DIST=0; ALLOW_UNVERIFIED_CI=0
DEFER_KNOWLEDGE_PLANET_UPGRADE=0
KNOWLEDGE_PLANET_VERIFY_USER=""
CUTOVER_NONCE=""; CUTOVER_TARGET_IMAGE=""
# P3 cohort lane 参数
CANARY_RELEASE=""     # --canary [<rel-*目录名>];空=从当前 HEAD build_release
PROMOTE_PCT=""        # --promote <0..100>
DRAIN_WS=0            # --finalize 时可选 WS drain(step3)
# runtime hotcfg 两机制**各自独立开关,默认关**(§5:合并后未部署期间生产行为零变化)。
# 首次开启用 --enable-*;开启后写入 env 的 tuple 键会让后续 deploy 自动持续走该机制。
# --disable-*(R2-B1):该轴本次激活写**空值**(三态写:键在值空=禁用),走完整 saga+smoke。
ENABLE_BUNDLE_FLAG=0; ENABLE_RELEASE_FLAG=0
DISABLE_BUNDLE_FLAG=0; DISABLE_RELEASE_FLAG=0
# --emergency-tuple 的显式候选(R2-M1;空=取当前 env 现值)
EMERG_IMAGE=""; EMERG_IMAGE_ID=""; EMERG_BUNDLE=""
# 普通 deploy 的在线 slim image 切换候选。只作为 build_runtime_release 的输入，
# 绝不预写线上 env；四键仍由 hotcfg joint saga 一次提交。
TARGET_RUNTIME_IMAGE=""; TARGET_RUNTIME_IMAGE_ID=""
# dx-declared P0 containment lane. These values are invalid unless supplied as one exact set.
EMERGENCY_INCIDENT=""; EMERGENCY_APPROVAL=""; EMERGENCY_COMMIT=""
EMERGENCY_APPROVAL_EVIDENCE=""
EMERGENCY_CLOSE_INCIDENT=""; PROTECTED_MERGE_SHA=""; CI_EVIDENCE_FILE=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    # 代码+前端两生效面合并为一次重启(见 deploy() 内注释,2026-07-10 成对重启事故)
    --with-dist) WITH_DIST=1 ;;
    # 一次性 setup-first lane：仅把扫码实时感知/加密持久化先上线，DB 继续钉旧
    # Knowledge Planet v1.0。用户扫码后，正常 deploy 再消费同一账号升级到 v1.1。
    --defer-knowledge-planet-upgrade) DEFER_KNOWLEDGE_PLANET_UPGRADE=1 ;;
    --enable-platform-bundle) ENABLE_BUNDLE_FLAG=1 ;;
    --enable-runtime-release) ENABLE_RELEASE_FLAG=1 ;;
    --disable-platform-bundle) DISABLE_BUNDLE_FLAG=1 ;;
    --disable-runtime-release) DISABLE_RELEASE_FLAG=1 ;;
    --emergency-tuple) MODE="emergency-tuple" ;;
    --activate-emergency-tuple) MODE="activate-emergency-tuple" ;;
    --image=*) EMERG_IMAGE="${arg#*=}" ;;
    --image-id=*) EMERG_IMAGE_ID="${arg#*=}" ;;
    --bundle=*) EMERG_BUNDLE="${arg#*=}" ;;
    --runtime-image=*) TARGET_RUNTIME_IMAGE="${arg#*=}" ;;
    --runtime-image-id=*) TARGET_RUNTIME_IMAGE_ID="${arg#*=}" ;;
    --bootstrap) MODE="bootstrap" ;;
    --migrate-bluegreen) MODE="migrate-bluegreen" ;;
    --smoke) MODE="smoke" ;;
    --verify-knowledge-planet-user=*)
      MODE="knowledge-planet-verify"
      KNOWLEDGE_PLANET_VERIFY_USER="${arg#*=}"
      ;;
    --census-ccb-baseline) MODE="baseline-census" ;;
    --remount-ccb-baseline) MODE="baseline-remount" ;;
    --install-monitor) MODE="install-monitor" ;;
    --dist) MODE="dist" ;;
    --prepare-offline-cutover) MODE="prepare-offline-cutover" ;;
    --offline-recycle) MODE="offline-recycle" ;;
    --stage) MODE="stage" ;;
    --activate-staged) MODE="activate-staged" ;;
    --rollback) MODE="rollback"; ROLLBACK_N=1 ;;
    --rollback=*) MODE="rollback"; ROLLBACK_N="${arg#*=}" ;;
    # 陈旧 production-mutation lease 回收(C1):只读探测 + 条件清理,不抢任何本地/全局锁。
    --allow-unverified-ci) ALLOW_UNVERIFIED_CI=1 ;;
    --reclaim-mutation-lease) MODE="reclaim-mutation-lease" ;;
    # 模型权威(方案 §7 步 4/5)。preflight 是四面活体门,cutover 是不可逆地板。
    --model-authority-preflight) MODE="model-authority-preflight" ;;
    --enable-model-authority) MODE="enable-model-authority" ;;
    --disable-model-authority) MODE="disable-model-authority" ;;
    --model-authority-observation-status) MODE="model-authority-observation-status" ;;
    --enable-seed-authority-by-rev) MODE="enable-seed-authority-by-rev" ;;
    --record-model-authority-emergency-drill) MODE="record-model-authority-emergency-drill" ;;
    --model-authority-cutover) MODE="model-authority-cutover" ;;
    --enable-runtime-tape-batching) MODE="enable-runtime-tape-batching" ;;
    # ── P3 双 master cohort lane(全部经 deploy_state CAS + journal;§D5 逐步)──
    --canary) MODE="canary" ;;
    --canary=*) MODE="canary"; CANARY_RELEASE="${arg#*=}" ;;
    --promote=*) MODE="promote"; PROMOTE_PCT="${arg#*=}" ;;
    --finalize) MODE="finalize" ;;
    --drain-ws) DRAIN_WS=1 ;;
    --abort) MODE="abort" ;;
    --recover) MODE="recover" ;;
    --authorize-emergency=*) MODE="authorize-emergency"; EMERGENCY_INCIDENT="${arg#*=}" ;;
    --emergency-containment=*) EMERGENCY_INCIDENT="${arg#*=}" ;;
    --emergency-approval=*) EMERGENCY_APPROVAL="${arg#*=}" ;;
    --emergency-commit=*) EMERGENCY_COMMIT="${arg#*=}" ;;
    --emergency-approval-evidence=*) EMERGENCY_APPROVAL_EVIDENCE="${arg#*=}" ;;
    --close-emergency-debt=*) MODE="close-emergency-debt"; EMERGENCY_CLOSE_INCIDENT="${arg#*=}" ;;
    --protected-merge-sha=*) PROTECTED_MERGE_SHA="${arg#*=}" ;;
    --ci-evidence-file=*) CI_EVIDENCE_FILE="${arg#*=}" ;;
    --publish-luna) MODE="publish-luna" ;;
    --hide-luna) MODE="hide-luna" ;;
    --cutover-nonce=*) CUTOVER_NONCE="${arg#*=}" ;;
    --target-image=*) CUTOVER_TARGET_IMAGE="${arg#*=}" ;;
    # egress split(2026-07-02):openclaude-v5-egress 持有在飞 LLM 流,默认部署
    # 【不】重启它(这正是解耦目的);仅 egress 相关代码(anthropicProxy/账号池/
    # 计费 finalize/egress/*)变更时显式带本 flag。重启走 SIGTERM drain。
    --egress) RESTART_EGRESS=1 ;;
    *) echo "未知参数: $arg" >&2; exit 2 ;;
  esac
done
if [[ -n "$EMERGENCY_INCIDENT$EMERGENCY_APPROVAL$EMERGENCY_COMMIT" ]]; then
  [[ -n "$EMERGENCY_INCIDENT" && -n "$EMERGENCY_APPROVAL" && -n "$EMERGENCY_COMMIT" ]] \
    || { echo "✗ emergency containment 必须同时提供 incident/approval/exact commit" >&2; exit 2; }
  [[ "$MODE" == canary || "$MODE" == finalize || "$MODE" == authorize-emergency ]] \
    || { echo "✗ emergency 参数只允许独立 --authorize-emergency / --canary / --finalize" >&2; exit 2; }
  [[ "$EMERGENCY_INCIDENT" =~ ^INC-[0-9]{8}-[A-Z0-9-]{3,40}$ ]] \
    || { echo "✗ emergency incident id 非法:$EMERGENCY_INCIDENT" >&2; exit 2; }
  [[ ${#EMERGENCY_APPROVAL} -ge 8 && ${#EMERGENCY_APPROVAL} -le 256 ]] \
    || { echo "✗ emergency approval ref 长度需 8..256" >&2; exit 2; }
  [[ "$EMERGENCY_COMMIT" =~ ^[0-9a-f]{40}$ ]] \
    || { echo "✗ emergency exact commit 必须是 40 位小写 sha" >&2; exit 2; }
fi
if [[ "$MODE" == authorize-emergency ]]; then
  [[ -f "$EMERGENCY_APPROVAL_EVIDENCE" ]] \
    || { echo "✗ --authorize-emergency 需要 --emergency-approval-evidence=<dx approval json>" >&2; exit 2; }
elif [[ -n "$EMERGENCY_APPROVAL_EVIDENCE" ]]; then
  echo "✗ approval evidence 只允许在独立 --authorize-emergency invocation 中使用" >&2
  exit 2
fi
if [[ "$MODE" == close-emergency-debt ]]; then
  [[ "$EMERGENCY_CLOSE_INCIDENT" =~ ^INC-[0-9]{8}-[A-Z0-9-]{3,40}$ ]] \
    || { echo "✗ --close-emergency-debt incident id 非法" >&2; exit 2; }
  [[ "$PROTECTED_MERGE_SHA" =~ ^[0-9a-f]{40}$ && -f "$CI_EVIDENCE_FILE" ]] \
    || { echo "✗ close debt 需要 --protected-merge-sha=<40sha> + --ci-evidence-file=<json>" >&2; exit 2; }
fi
[[ "$MODE" == "rollback" && ! "$ROLLBACK_N" =~ ^[1-5]$ ]] && { echo "✗ --rollback=N 需 N∈1..5" >&2; exit 2; }
[[ "$MODE" == "promote" && ! "$PROMOTE_PCT" =~ ^([0-9]|[1-9][0-9]|100)$ ]] && { echo "✗ --promote=<pct> 需 pct∈0..100" >&2; exit 2; }
[[ "$MODE" == "knowledge-planet-verify" && ! "$KNOWLEDGE_PLANET_VERIFY_USER" =~ ^[1-9][0-9]{0,15}$ ]] \
  && { echo "✗ --verify-knowledge-planet-user=<id> 需正整数用户 ID" >&2; exit 2; }
if [[ "$DEFER_KNOWLEDGE_PLANET_UPGRADE" == 1 \
      && ( "$MODE" != "deploy" || "$WITH_DIST" != 1 ) ]]; then
  echo "✗ --defer-knowledge-planet-upgrade 仅允许与普通 deploy + --with-dist 同用" >&2
  exit 2
fi
[[ -n "$CUTOVER_NONCE" && ! "$CUTOVER_NONCE" =~ ^[0-9a-f]{32}$ ]] && { echo "✗ cutover nonce 必须是 32 位小写 hex" >&2; exit 2; }
[[ "$CADDY_HTTP_PORT" =~ ^[1-9][0-9]{0,4}$ ]] && (( CADDY_HTTP_PORT <= 65535 )) \
  || { echo "✗ CADDY_HTTP_PORT 必须是 1..65535 的规范十进制端口" >&2; exit 2; }
if [[ ! "$BASELINE_REMOUNT_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] \
  || (( BASELINE_REMOUNT_TIMEOUT_SECONDS < 60 || BASELINE_REMOUNT_TIMEOUT_SECONDS > 7200 )); then
  echo "✗ OC_V5_BASELINE_REMOUNT_TIMEOUT_SECONDS 必须为 60..7200 秒" >&2
  exit 2
fi
# R2-B1/R2-M1 旗标一致性
[[ "$ENABLE_RELEASE_FLAG" == 1 && "$DISABLE_RELEASE_FLAG" == 1 ]] && { echo "✗ --enable-runtime-release 与 --disable-runtime-release 互斥" >&2; exit 2; }
[[ "$ENABLE_BUNDLE_FLAG" == 1 && "$DISABLE_BUNDLE_FLAG" == 1 ]] && { echo "✗ --enable-platform-bundle 与 --disable-platform-bundle 互斥" >&2; exit 2; }
if [[ ( "$DISABLE_RELEASE_FLAG" == 1 || "$DISABLE_BUNDLE_FLAG" == 1 ) && "$MODE" != "deploy" && "$MODE" != "dist" ]]; then
  echo "✗ --disable-* 仅适用于 deploy / --dist(禁用轴须走完整激活 saga+smoke)" >&2; exit 2
fi
# --image/--image-id 的合法宿主:emergency-tuple(显式候选)与 --disable-runtime-release
# (R3-B1:瘦身稳态下禁用 release 轴必须显式给出**内嵌源码**镜像,否则 tuple 可行性守卫
# 会拒'瘦身镜像+空 release';--bundle 仅 emergency-tuple 用)。
if [[ -n "$EMERG_BUNDLE" && "$MODE" != "emergency-tuple" ]]; then
  echo "✗ --bundle 是 --emergency-tuple 的显式候选参数,不用于其它模式" >&2; exit 2
fi
if [[ -n "$EMERG_IMAGE$EMERG_IMAGE_ID" && "$MODE" != "emergency-tuple" && "$DISABLE_RELEASE_FLAG" != 1 ]]; then
  echo "✗ --image/--image-id 仅用于 --emergency-tuple 或 --disable-runtime-release" >&2; exit 2
fi
if [[ "$DISABLE_RELEASE_FLAG" == 1 && ( ( -n "$EMERG_IMAGE" && -z "$EMERG_IMAGE_ID" ) || ( -z "$EMERG_IMAGE" && -n "$EMERG_IMAGE_ID" ) ) ]]; then
  echo "✗ --disable-runtime-release 的 --image=/--image-id= 必须成对出现(ID 钉死,防 tag 漂移;单传 --image-id 会被静默忽略故拒)" >&2; exit 2
fi
if [[ -n "$TARGET_RUNTIME_IMAGE$TARGET_RUNTIME_IMAGE_ID" ]]; then
  [[ "$MODE" == "deploy" ]] \
    || { echo "✗ --runtime-image/--runtime-image-id 只允许普通 deploy" >&2; exit 2; }
  [[ -n "$TARGET_RUNTIME_IMAGE" && -n "$TARGET_RUNTIME_IMAGE_ID" ]] \
    || { echo "✗ --runtime-image/--runtime-image-id 必须成对提供" >&2; exit 2; }
  [[ "$TARGET_RUNTIME_IMAGE" =~ ^[A-Za-z0-9._/:@-]+$ ]] \
    || { echo "✗ --runtime-image 格式非法" >&2; exit 2; }
  [[ "$TARGET_RUNTIME_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] \
    || { echo "✗ --runtime-image-id 必须是 sha256:64位小写hex" >&2; exit 2; }
  [[ "$DISABLE_RELEASE_FLAG" != 1 ]] \
    || { echo "✗ 在线 slim image 切换不能同时 --disable-runtime-release" >&2; exit 2; }
fi

run() { if [[ "$DRY" == 1 ]]; then echo "  [dry-run] $*"; else eval "$@"; fi; }
sshk() { if [[ "$DRY" == 1 ]]; then echo "  [dry-run] ssh $KL_HOST '$*'"; else ssh "$KL_HOST" "$@"; fi; }

slot_baseline_dir() { # <A|B>
  printf '%s/packages/commercial/agent-sandbox/ccb-baseline\n' "$(slot_src "$1")"
}

run_baseline_guard_remote() { # <check-release|harden-release|check-dir|harden-dir> <absolute-path>
  local guard_mode="$1" target="$2" qmode qtarget
  [[ "$guard_mode" =~ ^(check-release|harden-release|check-dir|harden-dir)$ ]] \
    || { echo "✗ baseline guard mode 非法:$guard_mode" >&2; return 2; }
  [[ "$target" =~ ^/[A-Za-z0-9._/-]+$ ]] \
    || { echo "✗ baseline guard path 非法:$target" >&2; return 2; }
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] baseline guard $guard_mode $target"
    return 0
  fi
  printf -v qmode '%q' "$guard_mode"
  printf -v qtarget '%q' "$target"
  ssh "$KL_HOST" "bash -s -- $qmode $qtarget" < "$BASELINE_GUARD_SCRIPT"
}

assert_release_baseline_security() { # <absolute-release-root>
  run_baseline_guard_remote check-release "$1" \
    || { echo "✗ 目标 release 的 CCB baseline 不完整/不安全:$1" >&2; return 1; }
}

harden_release_baseline() { # <absolute-release-root>
  run_baseline_guard_remote harden-release "$1" \
    || { echo "✗ release CCB baseline 权限收紧/复验失败:$1" >&2; return 1; }
}

install_v5_slot_units() {
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] 安装 A/B slot + loopback baseline port guard units，启用并实测 18893 占位"
    return 0
  fi
  local unit
  for unit in openclaude-v5.service openclaude-v5-b.service \
    "$V5_BASELINE_PORT_GUARD_SOCKET" "$V5_BASELINE_PORT_GUARD_SERVICE"; do
    rsync -az "$REPO_ROOT/deploy/v5/$unit" \
      "$KL_HOST:/etc/systemd/system/$unit" || return 1
  done
  ssh "$KL_HOST" "set -Eeuo pipefail
    test -x /usr/lib/systemd/systemd-socket-proxyd
    systemd-analyze verify \
      /etc/systemd/system/openclaude-v5.service \
      /etc/systemd/system/openclaude-v5-b.service \
      /etc/systemd/system/$V5_BASELINE_PORT_GUARD_SOCKET \
      /etc/systemd/system/$V5_BASELINE_PORT_GUARD_SERVICE
    systemctl daemon-reload
    systemctl enable '$V5_BASELINE_PORT_GUARD_SOCKET' >/dev/null
    # Restarting a required socket propagates to A/B dependents on systemd 255.
    # Never hide a master restart in this pre-maintenance preparation lane.
    if ! systemctl is-active --quiet '$V5_BASELINE_PORT_GUARD_SOCKET'; then
      systemctl start '$V5_BASELINE_PORT_GUARD_SOCKET'
    fi" || return 1
  assert_v5_baseline_port_guard
}

# 高频 monitor 是 host ops surface，不属于 A/B master release。固定版本目录 + current
# 指针让 active slot 切换/回滚都不会把 timer 带回旧脚本；安装仍只走本脚本的部署锁、
# production-mutation lease 与 mutation supervisor。
install_v5_host_monitor() {
  echo "══ v5 host monitor bundle 原子安装(A/B 独立)══"
  local local_stage remote_stage monitor_sha rc=0
  local_stage="$(mktemp -d "${TMPDIR:-/tmp}/oc-v5-monitor-stage.XXXXXX")" || return 1
  for file in scripts/v5-monitor.sh scripts/v5-daily-check.sh \
    scripts/v5-alert-fail.sh scripts/v5-alert-fanout.sql \
    scripts/v5-monitor-host-install-remote.sh \
    deploy/v5/openclaude-v5-monitor.service deploy/v5/openclaude-v5-monitor.timer \
    deploy/v5/openclaude-v5-daily.service deploy/v5/openclaude-v5-daily.timer \
    deploy/v5/openclaude-v5-alert-fail@.service; do
    [[ -f "$REPO_ROOT/$file" ]] || {
      echo "✗ monitor bundle 缺文件:$file" >&2
      rm -rf -- "$local_stage"
      return 1
    }
    cp -a -- "$REPO_ROOT/$file" "$local_stage/$(basename "$file")"
  done
  chmod 0755 "$local_stage/v5-monitor.sh" "$local_stage/v5-daily-check.sh" \
    "$local_stage/v5-alert-fail.sh" \
    "$local_stage/v5-monitor-host-install-remote.sh"
  chmod 0644 "$local_stage/v5-alert-fanout.sql" "$local_stage"/*.service "$local_stage"/*.timer
  (
    cd "$local_stage"
    sha256sum v5-monitor.sh v5-daily-check.sh v5-alert-fail.sh v5-alert-fanout.sql \
      v5-monitor-host-install-remote.sh \
      openclaude-v5-monitor.service openclaude-v5-monitor.timer \
      openclaude-v5-daily.service openclaude-v5-daily.timer \
      openclaude-v5-alert-fail@.service > SHA256SUMS
  )
  monitor_sha="$(sha256sum "$local_stage/SHA256SUMS" | awk '{print $1}')"
  remote_stage="/var/lib/openclaude-v5/.monitor-stage-${monitor_sha}-$$"

  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] ship monitor-$monitor_sha → $KL_HOST:$V5_MONITOR_ROOT/releases/monitor-$monitor_sha"
    echo "  [dry-run] stop monitor+daily timers，等待 oneshot/alert-fail 自然排空 → exact pool-state migration → atomically install current+units → live monitor oneshot → restore both timers"
    rm -rf -- "$local_stage"
    return 0
  fi

  if ! ssh "$KL_HOST" "rm -rf -- '$remote_stage' && install -d -m 0700 '$remote_stage'" \
      || ! rsync -az --chmod=F600,D700 "$local_stage/" "$KL_HOST:$remote_stage/"; then
    echo "✗ monitor bundle staging 上传失败" >&2
    ssh "$KL_HOST" "rm -rf -- '$remote_stage'" >/dev/null 2>&1 || true
    rm -rf -- "$local_stage"
    return 1
  fi
  rm -rf -- "$local_stage"

  if ssh "$KL_HOST" bash "$remote_stage/v5-monitor-host-install-remote.sh" \
      "$remote_stage" "$V5_MONITOR_ROOT" "$monitor_sha" "$V5_MONITOR_STATE"; then
    rc=0
  else
    rc=$?
    echo "✗ host monitor 原子安装失败" >&2
  fi
  if [[ "$rc" == 86 ]]; then
    echo "FATAL:monitor 安装回滚未完整收敛；保留远端 stage=$remote_stage 与 mutation in-flight marker 供 --recover 裁决" >&2
  else
    ssh "$KL_HOST" "rm -rf -- '$remote_stage'" >/dev/null 2>&1 || true
  fi
  return "$rc"
}

strip_shared_baseline_env_keys() {
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] 原子剥离 V5 shared env 的 baseline DIR/OPTIONAL/remote URL(保 owner/mode+备份)"
    return 0
  fi
  ssh "$KL_HOST" bash -s -- "$V5_ENV" <<'REMOTE'
set -Eeuo pipefail
env_file="$1"
lock=/var/lock/oc-v5-baseline-env.lock
mkdir -p "$(dirname "$lock")"
touch "$lock"; chmod 600 "$lock"
exec 9>"$lock"; flock -x 9
[[ -f "$env_file" && ! -L "$env_file" ]] || {
  echo "FATAL: V5 env missing or symlink: $env_file" >&2; exit 1;
}
forbidden='^[[:space:]]*(OC_V3_CCB_BASELINE_DIR|OC_V3_CCB_BASELINE_OPTIONAL|OPENCLAUDE_MASTER_BASELINE_BASE_URL)='
probe_rc=0
grep -Eq "$forbidden" "$env_file" || probe_rc=$?
if (( probe_rc == 0 )); then
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  backup="${env_file}.bak-baseline-${ts}"
  cp -a -- "$env_file" "$backup"
  tmp="${env_file}.baseline.$$"
  trap 'rm -f -- "$tmp"' EXIT
  filter_rc=0
  grep -Ev "$forbidden" "$env_file" > "$tmp" || filter_rc=$?
  (( filter_rc <= 1 )) || {
    echo "FATAL: failed to filter shared V5 env(rc=$filter_rc); original preserved" >&2
    exit 1
  }
  [[ -s "$tmp" ]] || { echo "FATAL: stripped V5 env would be empty" >&2; exit 1; }
  chown --reference="$env_file" "$tmp"
  chmod --reference="$env_file" "$tmp"
  sync -f "$tmp" 2>/dev/null || sync
  mv -f -- "$tmp" "$env_file"
  sync -f "$(dirname "$env_file")" 2>/dev/null || sync
  trap - EXIT
  echo "  ✓ shared baseline env keys removed(backup=$backup)"
elif (( probe_rc == 1 )); then
  echo "  · shared baseline env keys already absent"
else
  echo "FATAL: failed to inspect shared V5 env(rc=$probe_rc)" >&2
  exit 1
fi
verify_rc=0
grep -Eq "$forbidden" "$env_file" || verify_rc=$?
case "$verify_rc" in
  0) echo "FATAL: shared baseline env keys remain after migration" >&2; exit 1 ;;
  1) : ;;
  *) echo "FATAL: failed to verify migrated V5 env(rc=$verify_rc)" >&2; exit 1 ;;
esac
REMOTE
}

assert_v5_baseline_port_guard() {
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] 18893 必须仅有 systemd loopback 占位，且 wildcard bind 实测 EADDRINUSE"
    return 0
  fi
  ssh "$KL_HOST" bash -s -- "$V5_BASELINE_PORT_GUARD_SOCKET" "$V5_BASELINE_PORT" <<'REMOTE'
set -Eeuo pipefail
unit="$1"; port="$2"
systemctl is-active --quiet "$unit" || {
  echo "FATAL: V5 baseline port guard is not active: $unit" >&2
  exit 1
}
command -v ss >/dev/null
ss_rc=0
listeners="$(ss -ltnH "sport = :$port")" || ss_rc=$?
(( ss_rc == 0 )) || {
  echo "FATAL: cannot inspect V5 baseline guard listener(rc=$ss_rc)" >&2
  exit 1
}
count="$(printf '%s\n' "$listeners" | awk 'NF { n += 1 } END { print n + 0 }')"
address="$(printf '%s\n' "$listeners" | awk 'NF { print $4 }')"
[[ "$count" == 1 && "$address" == "127.0.0.1:$port" ]] || {
  echo "FATAL: expected exactly one loopback V5 baseline guard on 127.0.0.1:$port; listeners=${listeners:-<none>}" >&2
  exit 1
}
# This is the enforcement proof that SocketBindDeny could not provide on the
# production kernel/systemd combination: the legacy wildcard bind must fail
# specifically because the loopback reservation already owns this TCP port.
python3 - "$port" <<'PY'
import errno
import socket
import sys

port = int(sys.argv[1])
probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
try:
    probe.bind(("0.0.0.0", port))
except OSError as exc:
    if exc.errno != errno.EADDRINUSE:
        raise
else:
    raise SystemExit(f"FATAL: wildcard bind unexpectedly succeeded on {port}")
finally:
    probe.close()
PY
REMOTE
}

# One-time-safe and idempotent transition for the historical V5 layout:
# install the loopback-only 18893 reservation + slot-local units first (without
# restarting master), then harden the serving release and remove shared keys.
# Ordering matters: once the previously invalid tree becomes valid, an old
# release would otherwise start its legacy BaselineServer during compensation.
# The occupied loopback port makes its wildcard bind fail while staying remote-inaccessible.
prepare_live_baseline_safety() {
  local live_release
  live_release="$(bg_current_release "$ACTIVE_SRC")"
  [[ "$DRY" == 1 ]] && live_release="${live_release:-$RELEASES_ROOT/rel-active-dry}"
  [[ -n "$live_release" ]] || { echo "✗ 无法解析当前 serving release,拒绝迁移 baseline 配置" >&2; return 1; }
  if [[ "$DRY" != 1 ]]; then
    [[ "$live_release" == "$RELEASES_ROOT"/rel-* ]] \
      || { echo "✗ serving release 不在可信 releases 根:$live_release" >&2; return 1; }
    assert_release_marker "$live_release" \
      || { echo "✗ serving release 完整标记无效:$live_release" >&2; return 1; }
  fi
  echo "── V5 CCB baseline 一次性安全迁移(current=$live_release)──"
  install_v5_slot_units || return 1
  harden_release_baseline "$live_release" || return 1
  strip_shared_baseline_env_keys || return 1
  assert_release_baseline_security "$live_release" || return 1
}

assert_live_baseline_security_for_slot() { # <A|B>
  local slot="$1" unit src expected
  unit="$(slot_unit "$slot")"; src="$(slot_src "$slot")"; expected="$(slot_baseline_dir "$slot")"
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] $unit /proc env baseline=$expected,OPTIONAL/remote URL absent,tree strict"
    return 0
  fi
  ssh "$KL_HOST" bash -s -- "$unit" "$expected" "$V5_ENV" <<'REMOTE' || return 1
set -Eeuo pipefail
unit="$1"; expected="$2"; env_file="$3"
pid="$(systemctl show -p MainPID --value "$unit")"
[[ "$pid" =~ ^[1-9][0-9]*$ && -r "/proc/$pid/environ" ]] || {
  echo "FATAL: $unit has no readable live process env" >&2; exit 1;
}
mapfile -t dirs < <(tr '\0' '\n' < "/proc/$pid/environ" | sed -n 's/^OC_V3_CCB_BASELINE_DIR=//p')
[[ "${#dirs[@]}" == 1 && "${dirs[0]}" == "$expected" ]] || {
  echo "FATAL: $unit effective baseline path mismatch(expected=$expected count=${#dirs[@]})" >&2; exit 1;
}
if tr '\0' '\n' < "/proc/$pid/environ" | grep -Eqi \
    '^(OC_V3_CCB_BASELINE_OPTIONAL=(1|true|yes)|OPENCLAUDE_MASTER_BASELINE_BASE_URL=)'; then
  echo "FATAL: $unit still has dev-only/remote baseline env" >&2; exit 1
fi
shared_rc=0
grep -Eq '^[[:space:]]*(OC_V3_CCB_BASELINE_DIR|OC_V3_CCB_BASELINE_OPTIONAL|OPENCLAUDE_MASTER_BASELINE_BASE_URL)=' "$env_file" || shared_rc=$?
case "$shared_rc" in
  0) echo "FATAL: shared V5 env still contains slot/dev/remote baseline key" >&2; exit 1 ;;
  1) : ;;
  *) echo "FATAL: cannot inspect shared V5 env(rc=$shared_rc)" >&2; exit 1 ;;
esac
REMOTE
  run_baseline_guard_remote check-dir "$expected" || return 1
  # V5 is local-only (deploy/v5/P1-PLAN.md). A loopback-only reservation blocks
  # the old wildcard BaselineServer bind across rollback and A/B canary masters.
  assert_v5_baseline_port_guard || {
    echo "✗ V5 baseline 历史端口未被可信回环守卫占位" >&2; return 1;
  }
  echo "  ✓ $unit baseline 生效路径/结构/fail-closed 配置完整"
}

run_ccb_baseline_remount() {
  local action="$1"
  [[ "$action" == census || "$action" == remount ]] \
    || { echo "✗ baseline remount action 非法:$action" >&2; return 2; }
  assert_no_rollout_in_progress
  resolve_active_lane
  assert_bluegreen_layout "$ACTIVE_SRC"
  assert_live_baseline_security_for_slot "$ACTIVE_SLOT" || return 1
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] $action CCB baseline containers(slot=$ACTIVE_SLOT timeout=${BASELINE_REMOUNT_TIMEOUT_SECONDS}s)"
    return 0
  fi
  # remount 只能从本脚本正式模式进入：调用进程在整个远端命令期间持有
  # /var/lock/oc-v5-deploy.lock；独立 TS 工具拒绝无锁的破坏性直跑。
  ssh "$KL_HOST" bash -s -- \
    "$ACTIVE_UNIT" "$ACTIVE_SRC" "$V5_ENV" "$action" "$BASELINE_REMOUNT_TIMEOUT_SECONDS" <<'REMOTE'
set -Eeuo pipefail
unit="$1"; active_src="$2"; env_file="$3"; action="$4"; timeout="$5"
pid="$(systemctl show -p MainPID --value "$unit")"
[[ "$pid" =~ ^[1-9][0-9]*$ && -r "/proc/$pid/environ" ]] || {
  echo "FATAL: active V5 unit has no readable process env" >&2; exit 1;
}
live_cwd="$(readlink -f "/proc/$pid/cwd")"
expected_cwd="$(readlink -f "$active_src")"
[[ "$live_cwd" == "$expected_cwd" ]] || {
  echo "FATAL: active V5 process cwd does not match active slot" >&2; exit 1;
}
mapfile -t baseline_dirs < <(tr '\0' '\n' < "/proc/$pid/environ" | sed -n 's/^OC_V3_CCB_BASELINE_DIR=//p')
[[ "${#baseline_dirs[@]}" == 1 ]] || {
  echo "FATAL: active V5 process must expose exactly one baseline dir" >&2; exit 1;
}
set -a
. "$env_file"
set +a
export OC_V3_CCB_BASELINE_DIR="${baseline_dirs[0]}"
cd "$live_cwd"
if [[ "$action" == census ]]; then
  exec npx --no-install tsx scripts/v5-remount-ccb-baseline.ts --dry-run
fi
export OC_V5_DEPLOY_LOCK_HELD=1
exec npx --no-install tsx scripts/v5-remount-ccb-baseline.ts --timeout-seconds "$timeout"
REMOTE
}

# 发布元数据是所有写/激活 lane 的统一数据库前置。AUTO_MIGRATE=0，因此部署脚本只读
# schema_migrations 并 fail-closed，绝不替操作者偷偷迁库。既校验当前 checkout，也可校验
# rollback/canary 的远端 release，避免“当前库够新”被误当成“目标 release 依赖已满足”。
required_migrations_csv() { # <metadata-path> <local|remote>
  local metadata="$1" location="$2"
  # Validate metadata against the migration files in THIS target release. Never
  # use the current checkout to judge an older rollback archive: migrations that
  # did not exist in that immutable release are not its dependencies. Exact
  # array equality also rejects duplicates, omissions and hand-reordering.
  case "$location" in
    local)
      node - "$metadata" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const metadata = process.argv[2]
const suffix = path.join('deploy', 'v5', 'release-metadata.json')
if (!metadata.endsWith(suffix)) throw new Error(`unexpected metadata path: ${metadata}`)
const root = metadata.slice(0, -suffix.length).replace(/[\\/]$/, '')
const doc = JSON.parse(fs.readFileSync(metadata, 'utf8'))
const min = doc.minimumRequiredMigration
if (typeof min !== 'string' || !/^[0-9]{4}_[a-z0-9_]+$/.test(min))
  throw new Error('invalid minimumRequiredMigration')
const dir = path.join(root, 'packages', 'commercial', 'src', 'db', 'migrations')
const expected = fs.readdirSync(dir).filter((f) => f.endsWith('.sql'))
  .map((f) => f.slice(0, -4)).filter((v) => v >= min).sort()
const actual = doc.requiredMigrations
if (!Array.isArray(actual) || actual.length === 0 ||
    actual.some((v) => typeof v !== 'string' || !/^[0-9]{4}_[a-z0-9_]+$/.test(v)) ||
    JSON.stringify(actual) !== JSON.stringify(expected)) {
  throw new Error(`requiredMigrations mismatch; expected=${expected.join(',')} actual=${Array.isArray(actual) ? actual.join(',') : '<invalid>'}`)
}
process.stdout.write(actual.join(','))
NODE
      ;;
    remote)
      ssh "$KL_HOST" node - "$metadata" "$RELEASES_ROOT" "${TRUSTED_LEGACY_PREDECESSOR:-}" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const metadata = process.argv[2]
const releasesRoot = process.argv[3]
const trustedLegacyPredecessor = process.argv[4]
const suffix = path.join('deploy', 'v5', 'release-metadata.json')
if (!metadata.endsWith(suffix)) throw new Error(`unexpected metadata path: ${metadata}`)
const root = metadata.slice(0, -suffix.length).replace(/[\\/]$/, '')
const doc = JSON.parse(fs.readFileSync(metadata, 'utf8'))
const min = doc.minimumRequiredMigration
const dir = path.join(root, 'packages', 'commercial', 'src', 'db', 'migrations')
const actual = doc.requiredMigrations

// Releases built after this gate must carry an exact floor-derived manifest.
// Immutable pre-floor archives cannot be rewritten, though, and their curated
// lists were not globally sorted. Permit that historical shape only for a real
// completed rel-* archive which explicitly lacks the history-revision capability.
// Once the capability is adopted, the separate capability floor forbids falling
// back to these archives; a capable or local candidate can never use this escape.
if (min === undefined) {
  const resolvedRoot = path.resolve(root)
  const resolvedReleasesRoot = path.resolve(releasesRoot)
  const capabilities = doc.capabilities
  const immutableLegacyRelease =
    path.dirname(resolvedRoot) === resolvedReleasesRoot &&
    path.basename(resolvedRoot).startsWith('rel-') &&
    resolvedRoot === trustedLegacyPredecessor &&
    fs.lstatSync(resolvedRoot).isDirectory() &&
    fs.realpathSync(resolvedRoot) === resolvedRoot &&
    fs.lstatSync(path.join(resolvedRoot, '.complete')).isFile() &&
    path.resolve(metadata) === path.join(resolvedRoot, suffix)
  const validCapabilities =
    Array.isArray(capabilities) &&
    capabilities.every((v) => typeof v === 'string') &&
    new Set(capabilities).size === capabilities.length
  const validLegacyMigrations =
    Array.isArray(actual) && actual.length > 0 &&
    actual.every((v) => typeof v === 'string' && /^[0-9]{4}_[a-z0-9_]+$/.test(v)) &&
    new Set(actual).size === actual.length &&
    actual.every((v) => fs.statSync(path.join(dir, `${v}.sql`)).isFile())
  if (!immutableLegacyRelease) throw new Error('legacy migration manifest requires the exact captured predecessor')
  if (!validCapabilities) throw new Error('invalid legacy capabilities')
  if (capabilities.includes('history-projection-revision-v1') || capabilities.includes('direct-turn-timeline-v1'))
    throw new Error('legacy migration manifest cannot declare a post-floor history capability')
  if (!validLegacyMigrations) throw new Error('invalid legacy requiredMigrations')
} else {
  if (typeof min !== 'string' || !/^[0-9]{4}_[a-z0-9_]+$/.test(min))
    throw new Error('invalid minimumRequiredMigration')
  const expected = fs.readdirSync(dir).filter((f) => f.endsWith('.sql'))
    .map((f) => f.slice(0, -4)).filter((v) => v >= min).sort()
  if (!Array.isArray(actual) || actual.length === 0 ||
      actual.some((v) => typeof v !== 'string' || !/^[0-9]{4}_[a-z0-9_]+$/.test(v)) ||
      JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`requiredMigrations mismatch; expected=${expected.join(',')} actual=${Array.isArray(actual) ? actual.join(',') : '<invalid>'}`)
  }
}
process.stdout.write(actual.join(','))
NODE
      ;;
    *) echo "✗ required_migrations_csv location 非法:$location" >&2; return 2 ;;
  esac
}

assert_required_migrations() { # <metadata-path> <local|remote>
  local metadata="$1" location="$2" required_csv
  if [[ "$DRY" == 1 && "$location" == remote ]]; then
    echo "  [dry-run] 校验远端 release metadata=$metadata 的 requiredMigrations 已全部记录"
    return 0
  fi
  if ! required_csv="$(required_migrations_csv "$metadata" "$location")"; then
    echo "✗ release metadata 缺失/损坏或 requiredMigrations 非法:$metadata($location)" >&2
    return 1
  fi
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] 校验 requiredMigrations 已全部记录:$required_csv"
    return 0
  fi
  if ssh "$KL_HOST" bash -s -- "$V5_ENV" "$required_csv" <<'REMOTE'
set -Eeuo pipefail
env_file="$1"; required_csv="$2"
[[ -r "$env_file" ]] || { echo "FATAL: env 不可读:$env_file" >&2; exit 1; }
dburl="$(grep '^DATABASE_URL=' "$env_file" | tail -n 1 | cut -d= -f2-)"
[[ -n "$dburl" ]] || { echo "FATAL: DATABASE_URL missing:$env_file" >&2; exit 1; }
IFS=',' read -ra required <<<"$required_csv"
for migration in "${required[@]}"; do
  [[ "$migration" =~ ^[0-9]{4}_[a-z0-9_]+$ ]] || { echo "FATAL: invalid migration id:$migration" >&2; exit 1; }
  applied="$(psql "$dburl" -X -v ON_ERROR_STOP=1 -tAc "SELECT count(*) FROM schema_migrations WHERE version='${migration}'" | tr -d '[:space:]')"
  [[ "$applied" == 1 ]] || { echo "FATAL: required migration not applied:$migration" >&2; exit 1; }
done
REMOTE
  then
    echo "  ✓ requiredMigrations 已应用:$required_csv"
  else
    echo "✗ requiredMigrations 远端校验失败:$required_csv" >&2
    return 1
  fi
}

assert_repo_required_migrations() { assert_required_migrations "$RELEASE_METADATA" local; }
assert_release_required_migrations() { assert_required_migrations "$1/deploy/v5/release-metadata.json" remote; }

# 0151 once got applied as postgres instead of `SET LOCAL ROLE openclaude`, so
# schema_migrations was green while the runtime role could not write either new
# telemetry table. Keep this an explicit application-role capability gate: a
# recorded migration without its effective grants is not deploy/smoke-ready.
assert_0151_runtime_privileges() {
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] 校验 0151 runtime 对象 owner 与应用角色逐项权限"
    return 0
  fi
  if ssh "$KL_HOST" bash -s -- "$V5_ENV" <<'REMOTE'
set -Eeuo pipefail
env_file="$1"
[[ -r "$env_file" ]] || { echo "FATAL: env 不可读:$env_file" >&2; exit 1; }
dburl="$(grep '^DATABASE_URL=' "$env_file" | tail -n 1 | cut -d= -f2-)"
[[ -n "$dburl" ]] || { echo "FATAL: DATABASE_URL missing:$env_file" >&2; exit 1; }
ready="$(psql "$dburl" -X -v ON_ERROR_STOP=1 -tAc "SELECT (
  has_table_privilege(current_user,'public.product_friction_events','SELECT')
  AND has_table_privilege(current_user,'public.product_friction_events','INSERT')
  AND has_table_privilege(current_user,'public.product_friction_events','UPDATE')
  AND has_table_privilege(current_user,'public.product_friction_events','DELETE')
  AND has_table_privilege(current_user,'public.image_generation_attempts','SELECT')
  AND has_table_privilege(current_user,'public.image_generation_attempts','INSERT')
  AND has_table_privilege(current_user,'public.image_generation_attempts','UPDATE')
  AND has_table_privilege(current_user,'public.image_generation_attempts','DELETE')
  AND has_sequence_privilege(current_user,'public.image_generation_attempts_id_seq','SELECT')
  AND has_sequence_privilege(current_user,'public.image_generation_attempts_id_seq','USAGE')
  AND has_function_privilege(current_user,'public.canonicalize_legacy_codex_terminal_snapshot()','EXECUTE')
  AND has_function_privilege(current_user,'public.oc_0151_canonicalize_billing_array(jsonb)','EXECUTE')
  AND has_function_privilege(current_user,'public.canonicalize_legacy_lossless_tape_header()','EXECUTE')
  AND has_function_privilege(current_user,'public.canonicalize_legacy_lossless_agent_group()','EXECUTE')
  AND has_function_privilege(current_user,'public.reject_finalized_lossless_tape_part()','EXECUTE')
  AND has_function_privilege(current_user,'public.capture_legacy_image_attempt_on_terminal()','EXECUTE')
  AND has_function_privilege(current_user,'public.clear_github_workspace_on_session_delete()','EXECUTE')
  AND (SELECT pg_get_userbyid(c.relowner)='openclaude' FROM pg_class c
        WHERE c.oid='public.product_friction_events'::regclass)
  AND (SELECT pg_get_userbyid(c.relowner)='openclaude' FROM pg_class c
        WHERE c.oid='public.image_generation_attempts'::regclass)
  AND (SELECT pg_get_userbyid(c.relowner)='openclaude' FROM pg_class c
        WHERE c.oid='public.image_generation_attempts_id_seq'::regclass)
  AND (SELECT pg_get_userbyid(p.proowner)='openclaude' FROM pg_proc p
        WHERE p.oid='public.canonicalize_legacy_codex_terminal_snapshot()'::regprocedure)
  AND (SELECT pg_get_userbyid(p.proowner)='openclaude' FROM pg_proc p
        WHERE p.oid='public.oc_0151_canonicalize_billing_array(jsonb)'::regprocedure)
  AND (SELECT pg_get_userbyid(p.proowner)='openclaude' FROM pg_proc p
        WHERE p.oid='public.canonicalize_legacy_lossless_tape_header()'::regprocedure)
  AND (SELECT pg_get_userbyid(p.proowner)='openclaude' FROM pg_proc p
        WHERE p.oid='public.canonicalize_legacy_lossless_agent_group()'::regprocedure)
  AND (SELECT pg_get_userbyid(p.proowner)='openclaude' FROM pg_proc p
        WHERE p.oid='public.reject_finalized_lossless_tape_part()'::regprocedure)
  AND (SELECT pg_get_userbyid(p.proowner)='openclaude' FROM pg_proc p
        WHERE p.oid='public.capture_legacy_image_attempt_on_terminal()'::regprocedure)
  AND (SELECT pg_get_userbyid(p.proowner)='openclaude' FROM pg_proc p
        WHERE p.oid='public.clear_github_workspace_on_session_delete()'::regprocedure)
)::text" | tr -d '[:space:]')"
[[ "$ready" == true ]] || { echo "FATAL: 0151 runtime privileges incomplete for DATABASE_URL role" >&2; exit 1; }
REMOTE
  then
    echo "  ✓ 0151 runtime ownership/privileges 完整"
  else
    echo "✗ 0151 runtime ownership/privileges 校验失败（迁移可能由错误 owner apply）" >&2
    return 1
  fi
}

# 普通 deploy/dist/rollback 的短维护窗。只把 restart 前“即时确认健康”的检查写进
# marker，部署前已坏/无法确认的项继续正常告警。schema=2 与 offline cutover 的
# schema=1 共用一把远端锁，但互不覆盖、互不清理。
PLANNED_MAINTENANCE_NONCE=""
PLANNED_MAINTENANCE_ACTIVE=0
DEPLOY_HOLDER_OWNED=0
# production-mutation lease 运行态(见 PRODUCTION_MUTATION_LOCK 注释)。
MUTATION_LEASE_PID=""       # 后台 ssh(远端持 flock)的本地 pid
MUTATION_LEASE_START=""     # /proc starttime，防 PID reuse / zombie 假活
MUTATION_LEASE_PGID=""      # 独立 PGID，outer 整组 STOP/KILL 不冻结 ssh client
MUTATION_LEASE_TTL_PID=""   # 早于远端 hard TTL 的本地 monotonic watchdog
MUTATION_LEASE_TTL_START=""
MUTATION_LEASE_TTL_PGID=""  # 独立 PGID，outer 整组 STOP/KILL 时 deadline 仍推进
MUTATION_LEASE_ACTIVE=0     # 1=已持有,cleanup 需释放
MUTATION_LEASE_BYPASSED=0   # 1=OC_V5_SKIP_MUTATION_LEASE 紧急旁路,活性断言直接放行
MUTATION_DEPLOY_ID=""       # 与 lease fencing meta 的 deploy_id 同值；不是 lane marker nonce
MUTATION_HOLDER_IDENTITY=""
KNOWLEDGE_PLANET_VERIFY_HOLDER_OWNED=0
MUTATION_LANE_PID=""
MUTATION_LANE_START=""
MUTATION_LANE_PGID=""
MUTATION_LANE_ANCHOR_PID=""   # lane PGID 内独立 sentinel；leader 被 reap 后仍防 PGID reuse
MUTATION_LANE_ANCHOR_START=""
MUTATION_LANE_WATCH_PID=""
MUTATION_LANE_WATCH_START=""
MUTATION_LANE_WATCH_PGID=""
MUTATION_LANE_STATE_DIR=""
MUTATION_LANE_INFLIGHT_ACTIVE=0
MUTATION_LANE_INFLIGHT_NONCE=""

process_state_start() { # <pid> -> "state starttime"
  local raw rest
  raw="$(cat "/proc/$1/stat" 2>/dev/null)" || return 1
  rest="${raw##*) }"
  set -- $rest
  [[ $# -ge 20 ]] || return 1
  printf '%s %s\n' "$1" "${20}"
}

process_start_time() { # <pid>
  local state start
  read -r state start < <(process_state_start "$1") || return 1
  printf '%s\n' "$start"
}

same_live_process() { # <pid> <starttime>
  local state start
  read -r state start < <(process_state_start "$1") || return 1
  [[ "$state" != Z && "$state" != X && "$state" != x && "$start" == "$2" ]]
}

same_process_identity() { # <pid> <starttime>; zombies still anchor PID/PGID against reuse
  local state start
  read -r state start < <(process_state_start "$1") || return 1
  [[ "$start" == "$2" ]]
}

same_supervised_process() { # <pid> <starttime>; stopped supervisors are not healthy
  local state start
  read -r state start < <(process_state_start "$1") || return 1
  case "$state" in Z|X|x|T|t) return 1 ;; esac
  [[ "$start" == "$2" ]]
}

terminate_exact_process() { # <pid> <starttime>; never signal a reused pid
  local pid="$1" start="$2" i
  [[ "$pid" =~ ^[0-9]+$ && "$pid" -gt 1 && -n "$start" ]] || return 0
  same_live_process "$pid" "$start" || return 0
  kill -TERM "$pid" 2>/dev/null || true
  for i in $(seq 1 20); do
    same_live_process "$pid" "$start" || return 0
    sleep 0.1
  done
  same_live_process "$pid" "$start" && kill -KILL "$pid" 2>/dev/null || true
}

process_group_has_live_members() { # <pgid>; zombies cannot execute mutations
  local pgid="$1" snapshot rc
  [[ "$pgid" =~ ^[0-9]+$ && "$pgid" -gt 1 ]] || return 1
  snapshot="$(ps -eo pgid=,stat= 2>/dev/null)" || {
    echo "FATAL:无法枚举 PGID=$pgid；保守裁决为仍有 live member" >&2
    return 0
  }
  if awk -v wanted="$pgid" '
    $1 == wanted && substr($2,1,1) != "Z" { found=1 }
    END { exit(found ? 0 : 1) }
  ' <<<"$snapshot"; then
    return 0
  else
    rc=$?
    [[ "$rc" == 1 ]] && return 1
    echo "FATAL:无法解析 PGID=$pgid 进程快照；保守裁决为仍有 live member" >&2
    return 0
  fi
}

process_group_has_live_members_except() { # <pgid> <allowed-pid>
  local pgid="$1" allowed="$2" snapshot rc
  [[ "$pgid" =~ ^[0-9]+$ && "$pgid" -gt 1 && "$allowed" =~ ^[0-9]+$ ]] || return 1
  snapshot="$(ps -eo pgid=,stat=,pid= 2>/dev/null)" || {
    echo "FATAL:无法枚举 PGID=$pgid descendants；保守裁决为仍有 live member" >&2
    return 0
  }
  if awk -v wanted="$pgid" -v allowed="$allowed" '
    $1 == wanted && $3 != allowed && substr($2,1,1) != "Z" { found=1 }
    END { exit(found ? 0 : 1) }
  ' <<<"$snapshot"; then
    return 0
  else
    rc=$?
    [[ "$rc" == 1 ]] && return 1
    echo "FATAL:无法解析 PGID=$pgid descendants 快照；保守裁决为仍有 live member" >&2
    return 0
  fi
}

process_group_has_live_members_except_two() { # <pgid> <allowed-pid-1> <allowed-pid-2>
  local pgid="$1" allowed1="$2" allowed2="$3" snapshot rc
  [[ "$pgid" =~ ^[0-9]+$ && "$pgid" -gt 1 \
    && "$allowed1" =~ ^[0-9]+$ && "$allowed2" =~ ^[0-9]+$ ]] || return 1
  snapshot="$(ps -eo pgid=,stat=,pid= 2>/dev/null)" || {
    echo "FATAL:无法枚举 PGID=$pgid descendants；保守裁决为仍有 live member" >&2
    return 0
  }
  if awk -v wanted="$pgid" -v allowed1="$allowed1" -v allowed2="$allowed2" '
    $1 == wanted && $3 != allowed1 && $3 != allowed2 && substr($2,1,1) != "Z" { found=1 }
    END { exit(found ? 0 : 1) }
  ' <<<"$snapshot"; then
    return 0
  else
    rc=$?
    [[ "$rc" == 1 ]] && return 1
    echo "FATAL:无法解析 PGID=$pgid descendants 快照；保守裁决为仍有 live member" >&2
    return 0
  fi
}

terminate_mutation_lane_group() { # <pgid>; safe only while lease is still live
  local pgid="$1" i
  [[ "$pgid" =~ ^[0-9]+$ && "$pgid" -gt 1 ]] || return 0
  kill -TERM -- "-$pgid" 2>/dev/null || true
  for i in $(seq 1 20); do
    process_group_has_live_members "$pgid" || return 0
    sleep 0.1
  done
  kill -KILL -- "-$pgid" 2>/dev/null || true
}

begin_planned_maintenance() { # <deploy|dist|rollback> <include-egress:0|1>
  local maintenance_mode="$1" include_egress="$2" target_commit nonce result healthy_checks
  target_commit="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  nonce="$(openssl rand -hex 16)"
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] begin planned-maintenance schema=2 mode=$maintenance_mode ttl<=180s checks=svc_v5,http_v5,public_route,turn_failures$([[ "$include_egress" == 1 ]] && printf ',svc_egress,http_egress')"
    PLANNED_MAINTENANCE_NONCE="$nonce"
    PLANNED_MAINTENANCE_ACTIVE=1
    return 0
  fi

  local bpm_rc=0
  result="$(ssh "$KL_HOST" bash -s -- \
      "$MAINTENANCE_MARKER" "$MAINTENANCE_LOCK" "$maintenance_mode" \
      "$target_commit" "$nonce" "$include_egress" "${ACTIVE_UNIT:-$V5_UNIT}" "${ACTIVE_PORT:-$V5_PORT}" "$CUTOVER_ROOT" "$CADDY_HTTP_PORT" \
      "$([[ "${OC_DEPLOY_ONTO_UNHEALTHY:-0}" == 1 ]] && echo 1 || echo 0)" <<'REMOTE'
set -Eeuo pipefail
marker="$1"; lock="$2"; mode="$3"; target_commit="$4"; nonce="$5"; include_egress="$6"
v5_unit="$7"; v5_port="$8"; cutover_root="$9"; caddy_http_port="${10}"; onto_unhealthy="${11}"; ttl=180
[[ "$mode" =~ ^(deploy|dist|rollback)$ && "$target_commit" =~ ^[0-9a-f]{40}$ &&
   "$nonce" =~ ^[0-9a-f]{32}$ && "$include_egress" =~ ^[01]$ ]] || exit 2
[[ "$caddy_http_port" =~ ^[1-9][0-9]{0,4}$ ]] && (( caddy_http_port <= 65535 )) || exit 2
[[ "$onto_unhealthy" =~ ^[01]$ ]] || exit 2
mkdir -p -m 700 "$(dirname "$marker")"
touch "$lock"; chmod 600 "$lock"
exec 9>"$lock"; flock -x 9
now="$(date +%s)"
healthy=()
body=""
systemctl is-active --quiet "$v5_unit" 2>/dev/null && healthy+=(svc_v5)
body="$(curl -fsS --max-time 5 "http://127.0.0.1:${v5_port}/healthz" 2>/dev/null || true)"
jq -e '.ok == true and .channel == "v5"' <<<"$body" >/dev/null 2>&1 && healthy+=(http_v5)
body="$(curl -fsS --max-time 5 -H 'Host: claudeai.chat' "http://127.0.0.1:${caddy_http_port}/healthz" 2>/dev/null || true)"
jq -e '.ok == true and .channel == "v5"' <<<"$body" >/dev/null 2>&1 && healthy+=(public_route)
# turn_failures 是窗口聚合检查(v5-monitor.sh):部署窗内 turn 瞬断是预期行为,无条件静默。
healthy+=(turn_failures)
if [[ "$include_egress" == 1 ]]; then
  systemctl is-active --quiet openclaude-v5-egress.service 2>/dev/null && healthy+=(svc_egress)
  body="$(curl -fsS --max-time 5 'http://172.31.0.1:18892/internal/v5/egress-health' 2>/dev/null || true)"
  jq -e '.ok == true and .role == "egress"' <<<"$body" >/dev/null 2>&1 && healthy+=(http_egress)
fi
is_healthy() {
  local wanted="$1" item
  for item in "${healthy[@]}"; do [[ "$item" == "$wanted" ]] && return 0; done
  return 1
}
if [[ -f "$marker" ]]; then
  schema="$(jq -r '.schema // empty' "$marker" 2>/dev/null || true)"
  if [[ "$schema" == 1 ]]; then
    old_nonce="$(jq -r '.nonce // empty' "$marker" 2>/dev/null || true)"
    manifest="$cutover_root/$old_nonce/manifest.json"
    trusted_schema1=0
    if [[ "$(stat -c '%U:%G' "$marker" 2>/dev/null || true)" == root:root &&
          "$(stat -c '%a' "$marker" 2>/dev/null || true)" == 600 &&
          "$old_nonce" =~ ^[0-9a-f]{32}$ && -f "$manifest" &&
          "$(stat -c '%U:%G' "$manifest" 2>/dev/null || true)" == root:root &&
          "$(stat -c '%a' "$manifest" 2>/dev/null || true)" == 600 ]] &&
       jq -e --arg host "$(hostname -f)" --arg nonce "$old_nonce" '
         .schema == 1 and .host == $host and .nonce == $nonce
       ' "$marker" >/dev/null 2>&1 &&
       jq -e --arg host "$(hostname -f)" --arg nonce "$old_nonce" '
         .schema == 1 and .host == $host and .nonce == $nonce
       ' "$manifest" >/dev/null 2>&1; then
      trusted_schema1=1
    fi
    if [[ "$trusted_schema1" == 1 ]] && jq -e --argjson now "$now" '
        (.deadline | type) == "number" and .deadline >= $now
      ' "$marker" >/dev/null 2>&1; then
      echo "CONFLICT:active trusted schema1 cutover marker exists" >&2
      exit 20
    fi
    if [[ "$trusted_schema1" == 1 ]] && jq -e --argjson now "$now" '
        (.deadline | type) == "number" and .deadline < $now
      ' "$marker" >/dev/null 2>&1 &&
       is_healthy svc_v5 && is_healthy http_v5 && is_healthy public_route; then
      rm -f "$marker"
      echo "STALE:safely cleared expired schema1 marker nonce=$old_nonce after full v5/public health" >&2
    else
      echo "SKIPPED:stale/untrusted schema1 marker preserved; deployment continues fail-open"
      exit 0
    fi
  elif [[ "$schema" == 2 ]]; then
    if jq -e --argjson now "$now" '
        .schema == 2 and (.deadline | type) == "number" and .deadline >= $now
      ' "$marker" >/dev/null 2>&1; then
      echo "CONFLICT:active schema2 deploy marker exists" >&2
      exit 20
    fi
  else
    echo "SKIPPED:unknown maintenance marker preserved; deployment continues fail-open"
    exit 0
  fi
fi
# 2026-07-26(审计 11)fail-closed 收紧。原语义:「没有任何健康检查通过 → SKIPPED,部署继续」。
# 注意 healthy 里 turn_failures 是**无条件**加入的,所以 `#healthy == 0` 其实永远不成立 ——
# 真正的洞是:svc_v5/http_v5 全挂时 healthy=(turn_failures),marker 照样 SET、部署照样往下叠。
# 「服务当前就是全挂的」是最不该盲目叠加新 release 的时刻:一旦叠上去,回退目标的健康性也
# 失去了基线,事后分不清是旧版本挂的还是新版本挂的。
# 判据:被替换的那一面(svc_v5 + http_v5)必须此刻健康,否则拒绝。
# 【绝不挡住恢复路径】① mode=rollback 永远放行 —— 在坏服务上回退正是救援本身;
#                    ② 冷启动/已知故障态可由操作者用 OC_DEPLOY_ONTO_UNHEALTHY=1 明示确认,
#                       该确认会写进 maintenance marker(onto_unhealthy=true)留痕。
missing_core=()
is_healthy svc_v5 || missing_core+=(svc_v5)
is_healthy http_v5 || missing_core+=(http_v5)
if (( ${#missing_core[@]} > 0 )) && [[ "$mode" != rollback && "$onto_unhealthy" != 1 ]]; then
  echo "UNHEALTHY:${missing_core[*]}" >&2
  exit 21
fi
if (( ${#healthy[@]} == 0 )); then
  echo "SKIPPED:no currently healthy checks"
  exit 0
fi

started_at="$(date +%s)"; deadline=$((started_at + ttl))
checks_json="$(printf '%s\n' "${healthy[@]}" | jq -R . | jq -s .)"
tmp="${marker}.tmp.$$"
jq -n --arg host "$(hostname -f)" --arg nonce "$nonce" --arg kind deploy \
  --arg mode "$mode" --arg target_commit "$target_commit" \
  --argjson started_at "$started_at" --argjson deadline "$deadline" \
  --argjson checks "$checks_json" \
  --argjson onto_unhealthy "$([[ ${#missing_core[@]} -gt 0 ]] && echo true || echo false)" \
  '{schema:2,host:$host,nonce:$nonce,kind:$kind,mode:$mode,target_commit:$target_commit,
    started_at:$started_at,deadline:$deadline,checks:$checks,onto_unhealthy:$onto_unhealthy}' >"$tmp"
chmod 600 "$tmp"; chown root:root "$tmp"; mv -f "$tmp" "$marker"
echo "SET:$nonce:${healthy[*]}"
REMOTE
  )" || bpm_rc=$?
  if [[ "$bpm_rc" == 21 ]]; then
    echo "✗ 拒绝在不健康的现网上叠加新 release(mode=$maintenance_mode):svc_v5/http_v5 此刻不健康。" >&2
    echo "  服务当前就是挂的 —— 叠上去以后连「回退目标是否健康」的基线都没有了,事后分不清是旧版本挂的还是新版本挂的。" >&2
    echo "  先查清现网为何不健康;若确认是预期冷启动/已知故障且就是要用部署来修:" >&2
    echo "    · 修的是刚上线的版本 → 用 scripts/deploy-v5.sh --rollback(rollback lane 永远放行)" >&2
    echo "    · 确实要在坏态上叠新版本 → OC_DEPLOY_ONTO_UNHEALTHY=1 明示确认(会写进 maintenance marker 留痕)" >&2
    return 1
  fi
  if [[ "$bpm_rc" != 0 ]]; then
    echo "✗ 无法开启 planned-maintenance；保留现有 marker，拒绝冒险覆盖" >&2
    return 1
  fi
  if [[ "$result" == SKIPPED:* ]]; then
    echo "  ⚠ planned-maintenance 未开启(${result#SKIPPED:});所有检查继续 fail-open 告警"
    return 0
  fi
  [[ "$result" == "SET:$nonce:"* ]] || { echo "✗ planned-maintenance 返回异常:$result" >&2; return 1; }
  PLANNED_MAINTENANCE_NONCE="$nonce"
  PLANNED_MAINTENANCE_ACTIVE=1
  healthy_checks="${result#SET:"$nonce":}"
  echo "  ✓ planned-maintenance 已开启(mode=$maintenance_mode,checks=$healthy_checks)"
}

end_planned_maintenance() {
  local nonce="$PLANNED_MAINTENANCE_NONCE" result
  [[ "$PLANNED_MAINTENANCE_ACTIVE" == 1 && -n "$nonce" ]] || return 0
  require_mutation_lease_for_compensation "planned-maintenance-cleanup" || exit 86
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] end planned-maintenance schema=2 nonce=$nonce(nonce-match)"
    PLANNED_MAINTENANCE_ACTIVE=0; PLANNED_MAINTENANCE_NONCE=""
    return 0
  fi
  if result="$(ssh "$KL_HOST" bash -s -- "$MAINTENANCE_MARKER" "$MAINTENANCE_LOCK" "$nonce" <<'REMOTE'
set -Eeuo pipefail
marker="$1"; lock="$2"; nonce="$3"
mkdir -p -m 700 "$(dirname "$marker")"; touch "$lock"; chmod 600 "$lock"
exec 9>"$lock"; flock -x 9
if [[ -f "$marker" ]] && jq -e --arg nonce "$nonce" \
    '.schema == 2 and .nonce == $nonce' "$marker" >/dev/null 2>&1; then
  rm -f "$marker"; echo CLEARED
else
  echo PRESERVED
fi
REMOTE
  )"; then
    PLANNED_MAINTENANCE_ACTIVE=0; PLANNED_MAINTENANCE_NONCE=""
    [[ "$result" == CLEARED ]] && echo "  ✓ planned-maintenance 已清除" \
      || echo "  · planned-maintenance 已被替换/不存在，按 nonce 保留现场"
    return 0
  fi
  echo "⚠ planned-maintenance 清理失败；保留 active 供 EXIT 再试，marker 最迟按 TTL 失效" >&2
  return 1
}

cleanup_deploy_process() {
  local rc=$?
  trap - EXIT
  set +e
  if [[ -n "$MUTATION_LANE_PGID" ]] && {
      same_process_identity "$MUTATION_LANE_PID" "$MUTATION_LANE_START" \
        || same_process_identity "$MUTATION_LANE_ANCHOR_PID" "$MUTATION_LANE_ANCHOR_START"
    }; then
    if mutation_lease_live; then
      terminate_mutation_lane_group "$MUTATION_LANE_PGID"
    else
      kill -KILL -- "-$MUTATION_LANE_PGID" 2>/dev/null || true
    fi
  fi
  if [[ -n "$MUTATION_LANE_PID" ]] \
      && ! same_live_process "$MUTATION_LANE_PID" "$MUTATION_LANE_START"; then
    wait "$MUTATION_LANE_PID" 2>/dev/null || true
  fi
  stop_mutation_lane_watchdog
  [[ -n "$MUTATION_LANE_STATE_DIR" ]] && rm -rf -- "$MUTATION_LANE_STATE_DIR"
  [[ "$PLANNED_MAINTENANCE_ACTIVE" == 1 ]] && end_planned_maintenance >/dev/null 2>&1
  # 释放远端 lease 先于本地 holder(锁序反向):kill 后台 ssh → 远端 flock 随通道关闭而释放。
  release_production_mutation_lease >/dev/null 2>&1
  [[ "$DEPLOY_HOLDER_OWNED" == 1 ]] && rm -f "${DEPLOY_LOCK}.holder"
  [[ "$KNOWLEDGE_PLANET_VERIFY_HOLDER_OWNED" == 1 ]] \
    && rm -f "${KNOWLEDGE_PLANET_VERIFY_LOCK}.holder"
  exit "$rc"
}

# ───────────────────────── production-mutation lease(RFC §1.2)────────────────
# 取得远端一把 flock 并由后台 ssh 的父进程感知 holder 长持,直到 release/cleanup 断开它。
# 与本地 deploy lock 固定锁序:先本地(fd 8)后远端(本函数),防死锁。
# 超时/失败一律 return 非零,调用方 exit 3。紧急旁路 OC_V5_SKIP_MUTATION_LEASE=1(大写 WARNING)。
acquire_production_mutation_lease() {  # [<wait_secs>=60]
  # 远端 flock 竞锁等待秒数(默认 60；仅首次 acquisition 可等待，失锁补偿禁止重取)。
  # LEASED 轮询上限 = wait + 30s 冗余。
  local lease_wait="${1:-60}"
  [[ "$lease_wait" =~ ^[0-9]+$ ]] || lease_wait=60
  local poll_ceiling=$(( lease_wait + 30 )) poll_attempts=$(( (lease_wait + 30) * 10 ))
  [[ "$MUTATION_LEASE_ACTIVE" == 1 ]] && return 0
  if [[ "${OC_V5_SKIP_MUTATION_LEASE:-0}" == 1 ]]; then
    MUTATION_LEASE_BYPASSED=1
    echo "⚠⚠⚠ WARNING: OC_V5_SKIP_MUTATION_LEASE=1 —— 跳过 kl-mirror PRODUCTION-MUTATION LEASE。" >&2
    echo "⚠⚠⚠ 本次写操作不与自愈 host-action / 其它生产变更互斥。仅限 runbook 明确记载的紧急旁路。" >&2
    return 0
  fi
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] acquire production-mutation lease @ $KL_HOST:$PRODUCTION_MUTATION_LOCK(后台 ssh flock -w ${lease_wait} fd 9,读 LEASED,超时 ${poll_ceiling}s)"
    MUTATION_LEASE_ACTIVE=1
    MUTATION_DEPLOY_ID="000000000000000000000000"
    MUTATION_HOLDER_IDENTITY="dry-run"
    return 0
  fi
  local out got=0 waited=0 remote_script ttl_isolated=0 holder_isolated=0 i
  local lease_monitor_was_on=0
  local lease_ttl="$MUTATION_LEASE_TTL_SECONDS"
  local ttl_margin=2 local_ttl
  # deploy_id/holder_host = fencing 证据(reclaim 打印持有者身份;deploy_id 也用作 holder 自清 meta 的归属校验)。
  local deploy_id holder_host meta_path
  deploy_id="$(openssl rand -hex 12)"
  holder_host="$(hostname -f 2>/dev/null || hostname 2>/dev/null || echo unknown)"
  meta_path="$PRODUCTION_MUTATION_LEASE_META"
  out="$(mktemp "${TMPDIR:-/tmp}/oc-v5-lease.XXXXXX")" || { echo "✗ 无法创建 lease 临时文件" >&2; return 1; }
  # 后台 ssh:远端取 flock,成功打印 LEASED 后由 shell 自身持锁。不能 exec sleep infinity:
  # OpenSSH 断链时 sleep 可能被 PID 1 收养并永久保留 fd9。holder 每秒从 /proc 读取内核
  # 实时 PPid(不能用 bash 缓存的 $PPID)；sshd session parent 消失/reparent 后立即退出释放锁。
  # 关键:后台 ssh 必须关掉继承的本地部署锁 fd(fd 8 / OC_V5_DEPLOY_LOCK_FD)。否则本进程
  # 被 SIGKILL 绕过 trap 时,残活的 holder ssh 会同时焊死本地部署锁与远端 lease,
  # 后续一切部署 900s 超时。fd 号已通过整数校验,eval 仅拼接受控数字,无注入面。
  # C1 硬 TTL + fencing:PPid 检测只覆盖"ssh 通道断"这一路;若本地部署进程被 SIGKILL、残活
  # 后台 ssh 被 init 收养仍维持通道,则远端 holder 的 sshd 父进程不变、PPid 检测不触发,flock
  # 会被永久焊死。holder 因此额外(a)到 TTL 自 exit 释放;(b)LEASED 时原子写 fencing meta,
  # 供 --reclaim-mutation-lease 裁决陈旧;(c)自身任一退出路径清掉自己的 meta(持锁期间 meta 必属己)。
  remote_script="mkdir -p -m 700 '$(dirname "$PRODUCTION_MUTATION_LOCK")' 2>/dev/null || true
exec 9>'$PRODUCTION_MUTATION_LOCK'
flock -w ${lease_wait} 9 || exit 75
lease_parent=\"\$PPID\"
lease_ttl=${lease_ttl}
lease_start=\"\$(date +%s)\"
meta='$meta_path'
drop_meta() { rm -f \"\$meta\" 2>/dev/null || true; }
write_meta() {
  printf '{\"schema\":1,\"remote_pid\":%s,\"started_at\":%s,\"ttl\":%s,\"deploy_id\":\"%s\",\"holder_host\":\"%s\",\"mode\":\"%s\"}\n' \\
    \"\$\$\" \"\$lease_start\" \"\$lease_ttl\" '$deploy_id' '$holder_host' '$MODE' > \"\${meta}.tmp.\$\$\" 2>/dev/null \\
    && mv -f \"\${meta}.tmp.\$\$\" \"\$meta\" 2>/dev/null || rm -f \"\${meta}.tmp.\$\$\" 2>/dev/null || true
}
trap 'drop_meta; exit 0' HUP INT TERM
current_parent=\"\$(awk '/^PPid:/{print \$2; exit}' \"/proc/\$\$/status\" 2>/dev/null)\" || exit 76
case \"\$current_parent\" in ''|*[!0-9]*) exit 76 ;; esac
[ \"\$current_parent\" = \"\$lease_parent\" ] || exit 76
write_meta
echo LEASED
while :; do
  current_parent=\"\$(awk '/^PPid:/{print \$2; exit}' \"/proc/\$\$/status\" 2>/dev/null)\" || { drop_meta; exit 0; }
  case \"\$current_parent\" in ''|*[!0-9]*) drop_meta; exit 0 ;; esac
  [ \"\$current_parent\" = \"\$lease_parent\" ] || { drop_meta; exit 0; }
  kill -0 \"\$lease_parent\" 2>/dev/null || { drop_meta; exit 0; }
  now=\"\$(date +%s)\"
  if [ \"\$lease_ttl\" -gt 0 ] && [ \$(( now - lease_start )) -ge \"\$lease_ttl\" ]; then drop_meta; exit 0; fi
  sleep 1
done"
  # 本地 deadline 从 ssh spawn **之前**开始，且早于远端 hard TTL。若 LEASED
  # 因网络缓冲迟到至远端 flock 已释放，acquire loop 会先看到本地 watchdog 已死，
  # 永不接受 stale handshake。watchdog/ssh 均关闭本地 deploy/KP 锁 fd，避免 outer
  # 在 supervisor 尚未启动的 acquisition 窗被 SIGKILL 后焊死本地锁。
  (( lease_ttl > 10 )) && ttl_margin=5
  (( lease_ttl > ttl_margin )) || ttl_margin=1
  local_ttl=$(( lease_ttl - ttl_margin ))
  (( local_ttl >= 1 )) || local_ttl=1
  # 后台 child 必须先在非 job-control 模式继承 outer PGID，setsid 才能以同一
  # PID 成为新 session leader；若调用者原本开了 monitor mode，随后恢复。
  if [[ $- == *m* ]]; then lease_monitor_was_on=1; set +m; fi
  (
    trap - EXIT INT TERM HUP
    exec 8>&- 9>&-
    if [[ -n "${OC_V5_DEPLOY_LOCK_FD:-}" && "${OC_V5_DEPLOY_LOCK_FD}" =~ ^[0-9]+$ ]]; then
      eval "exec ${OC_V5_DEPLOY_LOCK_FD}>&-"
    fi
    # setsid 必须发生在 exec 链内，保持 $! / starttime 是最终 sleep 的 exact
    # identity；否则 outer 整个 PGID 被 STOP 时 deadline 也会冻结。
    exec setsid sleep "$local_ttl"
  ) &
  MUTATION_LEASE_TTL_PID=$!
  MUTATION_LEASE_TTL_START="$(process_start_time "$MUTATION_LEASE_TTL_PID")" || {
    kill -KILL "$MUTATION_LEASE_TTL_PID" 2>/dev/null || true
    # 无 exact starttime 时绝不做可能无界的 wait；该 child 尚未持任何生产资源。
    MUTATION_LEASE_TTL_PID=""; MUTATION_LEASE_TTL_PGID=""
    rm -f "$out"
    [[ "$lease_monitor_was_on" == 1 ]] && set -m
    echo "✗ 无法启动 production-mutation 本地 TTL watchdog" >&2
    return 1
  }
  MUTATION_LEASE_ACTIVE=1
  for i in $(seq 1 100); do
    same_live_process "$MUTATION_LEASE_TTL_PID" "$MUTATION_LEASE_TTL_START" || break
    MUTATION_LEASE_TTL_PGID="$(ps -o pgid= -p "$MUTATION_LEASE_TTL_PID" 2>/dev/null | tr -d '[:space:]')"
    if [[ "$MUTATION_LEASE_TTL_PGID" == "$MUTATION_LEASE_TTL_PID" ]]; then
      ttl_isolated=1
      break
    fi
    sleep 0.01
  done
  if [[ "$ttl_isolated" != 1 ]]; then
    release_production_mutation_lease || true
    rm -f "$out"
    [[ "$lease_monitor_was_on" == 1 ]] && set -m
    echo "✗ production-mutation 本地 TTL watchdog 未隔离为独立 PGID" >&2
    return 1
  fi
  (
    trap - EXIT INT TERM HUP
    exec 8>&- 9>&-
    if [[ -n "${OC_V5_DEPLOY_LOCK_FD:-}" && "${OC_V5_DEPLOY_LOCK_FD}" =~ ^[0-9]+$ ]]; then
      eval "exec ${OC_V5_DEPLOY_LOCK_FD}>&-"
    fi
    exec setsid ssh -o ServerAliveInterval=2 -o ServerAliveCountMax=2 "$KL_HOST" "$remote_script"
  ) >"$out" 2>/dev/null &
  MUTATION_LEASE_PID=$!
  [[ "$lease_monitor_was_on" == 1 ]] && set -m
  MUTATION_LEASE_START="$(process_start_time "$MUTATION_LEASE_PID")" || {
    kill -KILL "$MUTATION_LEASE_PID" 2>/dev/null || true
    # 未取得 starttime 时不能证明可安全 wait；远端 holder 自身仍受 hard TTL 限制。
    MUTATION_LEASE_PID=""; MUTATION_LEASE_PGID=""
    release_production_mutation_lease || true
    rm -f "$out"
    echo "✗ 无法记录 production-mutation ssh 进程身份" >&2
    return 1
  }
  for i in $(seq 1 100); do
    same_live_process "$MUTATION_LEASE_PID" "$MUTATION_LEASE_START" || break
    MUTATION_LEASE_PGID="$(ps -o pgid= -p "$MUTATION_LEASE_PID" 2>/dev/null | tr -d '[:space:]')"
    if [[ "$MUTATION_LEASE_PGID" == "$MUTATION_LEASE_PID" ]]; then
      holder_isolated=1
      break
    fi
    sleep 0.01
  done
  if [[ "$holder_isolated" != 1 ]]; then
    release_production_mutation_lease
    rm -f "$out"
    echo "✗ production-mutation ssh holder 未隔离为独立 PGID" >&2
    return 1
  fi
  # 轮询 LEASED(截止 poll_ceiling=wait+30s);ssh 提前退出(flock 竞争失败/连接失败)→ kill -0 断链即止。
  while (( waited < poll_attempts )); do
    same_live_process "$MUTATION_LEASE_TTL_PID" "$MUTATION_LEASE_TTL_START" || break
    same_live_process "$MUTATION_LEASE_PID" "$MUTATION_LEASE_START" || break
    if grep -q LEASED "$out" 2>/dev/null; then got=1; break; fi
    sleep 0.1; waited=$((waited + 1))
  done
  rm -f "$out"
  if [[ "$got" != 1 ]] \
      || ! same_live_process "$MUTATION_LEASE_TTL_PID" "$MUTATION_LEASE_TTL_START" \
      || ! same_live_process "$MUTATION_LEASE_PID" "$MUTATION_LEASE_START"; then
    release_production_mutation_lease
    echo "✗ 未取得 kl-mirror production-mutation lease(远端 flock -w ${lease_wait} 竞争超时 / ssh 失败 / ${poll_ceiling}s 无 LEASED)。" >&2
    echo "  可能有另一生产变更(部署 / 自愈 host-action / 人工 runbook wrapper)正持锁;" >&2
    echo "  稍后重试或核查 $KL_HOST:$PRODUCTION_MUTATION_LOCK。紧急旁路(仅 runbook 记载):OC_V5_SKIP_MUTATION_LEASE=1。" >&2
    return 1
  fi
  MUTATION_DEPLOY_ID="$deploy_id"
  MUTATION_HOLDER_IDENTITY="$holder_host:$$:$MODE"
  echo "  ✓ 已取得 kl-mirror production-mutation lease(后台 ssh pid=$MUTATION_LEASE_PID,本地安全 TTL ${local_ttl}s,远端 holder 硬 TTL ${lease_ttl}s,deploy_id=$deploy_id)"
  return 0
}

# 陈旧 lease 回收(C1)。读远端 fencing meta → kill -0 校验 holder 死活 → 仅当陈旧
# (holder 进程不存在 或 超 TTL)才 kill 残留 holder 并清 meta(flock 随 holder 进程退出由内核释放);
# 否则拒绝并打印持有者身份。OC_V5_RECLAIM_FORCE=1 = 明知部署已死时的显式强制旁路(与
# OC_V5_SKIP_MUTATION_LEASE 同哲学:仅 runbook 记载、大写告警),仍要求 meta 存在、大声打印。
# 只读+条件清理,不抢本地 deploy lock、不取全局 lease(见 MODE 门跳过),避免被同一残留焊死时自我阻塞。
reclaim_production_mutation_lease() {
  echo "══ kl-mirror production-mutation lease 陈旧回收(reclaim)══"
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] 读 $KL_HOST:$PRODUCTION_MUTATION_LEASE_META → kill -0 校验 holder → 陈旧(不存在/超TTL)才清锁,否则拒绝(force=${OC_V5_RECLAIM_FORCE:-0})"
    return 0
  fi
  local result
  # 远端 heredoc:每条判定路径都 exit 0 + 结构化结论行;仅 ssh/脚本异常才非零 → 外层按"探测失败"fail-closed(不清)。
  if ! result="$(ssh "$KL_HOST" bash -s -- \
      "$PRODUCTION_MUTATION_LOCK" "$PRODUCTION_MUTATION_LEASE_META" "${OC_V5_RECLAIM_FORCE:-0}" <<'REMOTE'
set -Eeuo pipefail
lock="$1"; meta="$2"; force="$3"
[ "$force" = 1 ] || force=0
now="$(date +%s)"
# 独立 probe 若能取锁，必须**保持到 meta 清完**：这既证明旧 holder 已无 OFD flock，
# 也堵住“probe 解锁→新 holder 插入→误删新 meta”的 TOCTOU。此分支绝不读取/发送
# meta PID（旧 PID 可能已被无关进程复用）。
exec 8>"$lock" 2>/dev/null || { echo "ERROR:lock-open-failed"; exit 0; }
if flock -n 8 2>/dev/null; then
  rm -f "$meta" 2>/dev/null || true
  echo "CLEAN:no-meta-lock-free"
  flock -u 8 2>/dev/null || true
  exec 8>&- 2>/dev/null || true
  exit 0
fi
exec 8>&- 2>/dev/null || true
if [ ! -f "$meta" ]; then
  echo "REFUSE:lock-held-without-meta(有 OFD 持锁但无 fencing meta;拒绝盲清)"; exit 0
fi
command -v jq >/dev/null 2>&1 || { echo "ERROR:jq-missing"; exit 0; }
rpid="$(jq -r '.remote_pid // empty' "$meta" 2>/dev/null || true)"
started="$(jq -r '.started_at // empty' "$meta" 2>/dev/null || true)"
ttl="$(jq -r '.ttl // empty' "$meta" 2>/dev/null || true)"
did="$(jq -r '.deploy_id // empty' "$meta" 2>/dev/null || true)"
hhost="$(jq -r '.holder_host // empty' "$meta" 2>/dev/null || true)"
hmode="$(jq -r '.mode // empty' "$meta" 2>/dev/null || true)"
case "$rpid" in ''|*[!0-9]*) echo "REFUSE:meta-unparseable"; exit 0 ;; esac
case "$started" in ''|*[!0-9]*) started=0 ;; esac
case "$ttl" in ''|*[!0-9]*) ttl=0 ;; esac
lock_id="$(stat -L -c '%d:%i' "$lock" 2>/dev/null || true)"
case "$lock_id" in ''|*[!0-9:]*) echo "ERROR:lock-stat-failed"; exit 0 ;; esac
lock_inode="${lock_id##*:}"
pid_owns_lock() {
  pid="$1"
  kill -0 "$pid" 2>/dev/null || return 1
  [ -d "/proc/$pid/fd" ] || return 1
  for fd_path in "/proc/$pid"/fd/*; do
    [ -e "$fd_path" ] || continue
    [ "$(stat -L -c '%d:%i' "$fd_path" 2>/dev/null || true)" = "$lock_id" ] || continue
    fd="${fd_path##*/}"
    grep -Eq "^lock:.*[[:space:]]FLOCK[[:space:]]+ADVISORY[[:space:]]+WRITE[[:space:]]+.*:${lock_inode}[[:space:]]" \
      "/proc/$pid/fdinfo/$fd" 2>/dev/null && return 0
  done
  return 1
}

# kill -0 只证明 PID 存在，不能证明它仍是 meta 所指 holder。真正授权信号的证据是：
# 同一 PID 的某 fd 指向当前 lock dev:inode，且该 fdinfo 直证 FLOCK WRITE。
holder_alive=0; kill -0 "$rpid" 2>/dev/null && holder_alive=1
if [ "$holder_alive" != 1 ] || ! pid_owns_lock "$rpid"; then
  echo "REFUSE:holder-identity-mismatch pid=$rpid deploy_id=$did"
  exit 0
fi
age=$(( now - started ))
stale=0
[ "$ttl" -gt 0 ] && [ "$age" -ge "$ttl" ] && stale=1
if [ "$stale" = 0 ] && [ "$force" != 1 ]; then
  printf 'REFUSE:holder-live pid=%s host=%s mode=%s age=%ss ttl=%ss deploy_id=%s\n' "$rpid" "$hhost" "$hmode" "$age" "$ttl" "$did"
  exit 0
fi
reason=stale; [ "$stale" = 0 ] && reason=forced
# 发 TERM 前重验，禁止 fd close / PID reuse 窗把信号送给无关进程。
pid_owns_lock "$rpid" || { echo "REFUSE:holder-identity-changed pid=$rpid"; exit 0; }
kill -TERM "$rpid" 2>/dev/null || true

# 等 holder 正常 trap 退出；若仍持锁，KILL 前再次证明**同一个 PID 仍持同一 flock**。
i=0
while [ "$i" -lt 5 ]; do
  exec 8>"$lock" 2>/dev/null || { echo "ERROR:lock-open-failed"; exit 0; }
  if flock -n 8 2>/dev/null; then break; fi
  exec 8>&- 2>/dev/null || true
  sleep 1
  i=$((i+1))
done
if ! flock -n 8 2>/dev/null; then
  exec 8>&- 2>/dev/null || true
  pid_owns_lock "$rpid" || { echo "REFUSE:holder-identity-changed-before-kill pid=$rpid"; exit 0; }
  kill -KILL "$rpid" 2>/dev/null || true
  i=0
  while [ "$i" -lt 5 ]; do
    exec 8>"$lock" 2>/dev/null || { echo "ERROR:lock-open-failed"; exit 0; }
    if flock -n 8 2>/dev/null; then break; fi
    exec 8>&- 2>/dev/null || true
    sleep 1
    i=$((i+1))
  done
fi
# 只有 probe 现持 flock 才能删 meta / 宣告 CLEAN；否则未知 holder 仍在，fail-closed。
if ! flock -n 8 2>/dev/null; then
  exec 8>&- 2>/dev/null || true
  echo "REFUSE:termination-unconfirmed pid=$rpid"
  exit 0
fi
rm -f "$meta" 2>/dev/null || true
printf 'CLEAN:%s pid=%s host=%s mode=%s age=%ss ttl=%ss deploy_id=%s\n' "$reason" "$rpid" "$hhost" "$hmode" "$age" "$ttl" "$did"
flock -u 8 2>/dev/null || true
exec 8>&- 2>/dev/null || true
exit 0
REMOTE
  )"; then
    echo "✗ reclaim:远端探测失败(ssh 不通 / 脚本异常);未做任何清理(fail-closed)。" >&2
    return 1
  fi
  echo "  远端结论:$result"
  case "$result" in
    CLEAN:*)  echo "  ✓ 已回收陈旧 production-mutation lease(下一次部署可正常取锁)。"; return 0 ;;
    REFUSE:*) echo "  ⚠ 拒绝回收:lease 仍由活跃 holder 持有 / 无法确认归属。" >&2
              echo "    若确信该部署已死:等待远端 holder TTL(${MUTATION_LEASE_TTL_SECONDS}s)自动过期,或复核持有者后带 OC_V5_RECLAIM_FORCE=1 强制回收。" >&2
              return 4 ;;
    ERROR:*)  echo "  ✗ reclaim 远端错误:$result" >&2; return 1 ;;
    *)        echo "  ✗ reclaim 未知结论:$result" >&2; return 1 ;;
  esac
}

release_production_mutation_lease() {
  local incomplete=0
  [[ "$MUTATION_LEASE_ACTIVE" == 1 ]] || return 0
  if [[ "$DRY" == 1 ]]; then MUTATION_LEASE_ACTIVE=0; return 0; fi
  if [[ -n "$MUTATION_LEASE_PID" ]]; then
    terminate_exact_process "$MUTATION_LEASE_PID" "$MUTATION_LEASE_START"
    if same_live_process "$MUTATION_LEASE_PID" "$MUTATION_LEASE_START"; then
      incomplete=1
    else
      wait "$MUTATION_LEASE_PID" 2>/dev/null || true
      MUTATION_LEASE_PID=""; MUTATION_LEASE_START=""; MUTATION_LEASE_PGID=""
    fi
  fi
  if [[ -n "$MUTATION_LEASE_TTL_PID" ]]; then
    terminate_exact_process "$MUTATION_LEASE_TTL_PID" "$MUTATION_LEASE_TTL_START"
    if same_live_process "$MUTATION_LEASE_TTL_PID" "$MUTATION_LEASE_TTL_START"; then
      incomplete=1
    else
      wait "$MUTATION_LEASE_TTL_PID" 2>/dev/null || true
      MUTATION_LEASE_TTL_PID=""; MUTATION_LEASE_TTL_START=""; MUTATION_LEASE_TTL_PGID=""
    fi
  fi
  # Keep ACTIVE=1 until both exact identities are collected. A controlled
  # signal/EXIT trap in the middle can then re-enter this cleanup idempotently
  # instead of mistaking a still-live holder for an already released lease.
  if [[ "$incomplete" == 1 ]]; then
    echo "FATAL:production-mutation lease 有 KILL-pending 进程；不阻塞 wait，保留 exact identity 供重试" >&2
    return 1
  fi
  MUTATION_LEASE_ACTIVE=0
  return 0
}

mutation_lease_live() {
  [[ "$MUTATION_LEASE_BYPASSED" == 1 || "$DRY" == 1 ]] && return 0
  [[ "$MUTATION_LEASE_ACTIVE" == 1 ]] || return 1
  [[ -n "$MUTATION_LEASE_PID" && -n "$MUTATION_LEASE_START" \
    && -n "$MUTATION_LEASE_TTL_PID" && -n "$MUTATION_LEASE_TTL_START" ]] || return 1
  same_live_process "$MUTATION_LEASE_PID" "$MUTATION_LEASE_START" \
    && same_live_process "$MUTATION_LEASE_TTL_PID" "$MUTATION_LEASE_TTL_START"
}

# 翻转/激活类关键点前活体断言:后台 ssh 死 → 远端 flock 已随通道关闭释放,自愈 host-action
# 可能已插入 → 返回专用 86；调用方必须直接 crash-stop，禁止 cleanup/补偿。
assert_mutation_lease_alive() {
  local ctx="${1:-flip}"
  [[ "$MUTATION_LEASE_BYPASSED" == 1 || "$DRY" == 1 ]] && return 0
  if [[ "$MUTATION_LEASE_ACTIVE" != 1 ]]; then
    echo "✗ [$ctx] production-mutation lease 未持有(不应发生);中止本次翻转。" >&2
    return 86
  fi
  if ! mutation_lease_live; then
    echo "✗ [$ctx] production-mutation lease ssh/本地 TTL 已失活(远端 flock 可能已释放);crash-stop 本 lane。" >&2
    return 86
  fi
  return 0
}

# 补偿路径同样禁止越过 lease。失锁后 generic parent 不猜 child saga 阶段、不重取后
# 自动补偿（期间其它 holder 可能已经写过）；直接返回专用 86，由 supervisor crash-stop
# 整个 lane，保留 deploy_state / in-flight marker，待人工核对后显式恢复。
require_mutation_lease_for_compensation() {  # <ctx>
  local ctx="${1:-compensation}"
  [[ "$MUTATION_LEASE_BYPASSED" == 1 || "$DRY" == 1 ]] && return 0
  mutation_lease_live && return 0
  echo "FATAL [$ctx] production-mutation lease 已失活；禁止无 lease 补偿/回滚。保留持久状态，crash-stop 后人工核对并显式 recover。" >&2
  return 86
}

# ───────────────────────── dangerous offline cutover guard ────────────────
# 普通 deploy/smoke/dist/rollback 永远不会调用本段。只有显式离线三步需要一次性
# nonce；prepare 必须在服务在线健康、目标镜像已构建后执行，确保构建时间不可能
# 再落入停机窗口。离线三步严禁 migration/DDL/DML。
cutover_break_glass() {
  [[ "${OC_BREAK_GLASS_OFFLINE_RECYCLE:-}" == "I_ACCEPT_V5_OUTAGE" ]]
}

cutover_require_args() {
  if cutover_break_glass; then
    echo "⚠ BREAK-GLASS: I_ACCEPT_V5_OUTAGE（仅本次显式离线子命令）" >&2
    return 0
  fi
  [[ -n "$CUTOVER_NONCE" ]] || {
    echo "✗ 危险离线操作缺 --cutover-nonce；先在 v5 在线健康时运行 --prepare-offline-cutover" >&2
    return 1
  }
}

prepare_offline_cutover() {
  echo "══ prepare v5 offline cutover（服务保持在线）══"
  assert_clean_source_tree
  [[ -n "$CUTOVER_TARGET_IMAGE" ]] || {
    echo "✗ --prepare-offline-cutover 必须带 --target-image=不可变构建对应的TAG" >&2
    return 2
  }
  [[ "$CUTOVER_TARGET_IMAGE" =~ ^[A-Za-z0-9._/:@-]+$ ]] || {
    echo "✗ target image 格式非法" >&2; return 2;
  }
  [[ -r "$RELEASE_METADATA" ]] || { echo "✗ 缺 release metadata: $RELEASE_METADATA" >&2; return 1; }
  [[ "$(jq -r '.databaseCompatibility' "$RELEASE_METADATA")" == "backward-compatible" ]] || {
    echo "✗ 离线自动切换只接受 backward-compatible 数据库变更；不可用 break-glass 绕过" >&2
    return 1
  }

  local target_commit required_csv migration_tree_hash expected_host nonce
  target_commit="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  required_csv="$(jq -er '.requiredMigrations | join(",")' "$RELEASE_METADATA")"
  migration_tree_hash="$(cd "$REPO_ROOT/packages/commercial/src/db/migrations" && find . -maxdepth 1 -type f -name '*.sql' -printf '%f\n' | sort | while read -r f; do sha256sum "$f"; done | sha256sum | awk '{print $1}')"
  expected_host="$(ssh "$KL_HOST" 'hostname -f')"
  nonce="${CUTOVER_NONCE:-$(openssl rand -hex 16)}"

  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] validate active+internal/public health, target image immutable ID/labels/binary, required migrations"
    echo "  [dry-run] create $CUTOVER_ROOT/$nonce complete rollback bundle + one-shot manifest"
    echo "CUTOVER_NONCE=$nonce"
    return 0
  fi

  ssh "$KL_HOST" bash -s -- \
    "$CUTOVER_ROOT" "$CUTOVER_LOCK" "$nonce" "$expected_host" "$target_commit" \
    "$CUTOVER_TARGET_IMAGE" "$required_csv" "$migration_tree_hash" "$REMOTE_SRC" \
    "$V5_ENV" "$V5_UNIT" "$V5_PORT" <<'REMOTE'
set -Eeuo pipefail
root="$1"; lock="$2"; nonce="$3"; expected_host="$4"; target_commit="$5"
target_image="$6"; required_csv="$7"; migration_tree_hash="$8"; remote_src="$9"
env_file="${10}"; unit="${11}"; port="${12}"
mkdir -p "$root"; chmod 700 "$root"; touch "$lock"; chmod 600 "$lock"
exec 9>"$lock"; flock -x 9

[[ "$(hostname -f)" == "$expected_host" ]] || { echo 'FATAL: host binding mismatch' >&2; exit 1; }
systemctl is-active --quiet "$unit" || { echo 'FATAL: prepare requires v5 active' >&2; exit 1; }
internal="$(curl -fsS --max-time 5 "http://127.0.0.1:${port}/healthz")"
jq -e '.ok == true and .channel == "v5"' <<<"$internal" >/dev/null || { echo 'FATAL: internal health is not v5/ok' >&2; exit 1; }
public="$(curl -fsS --max-time 5 -H 'Host: claudeai.chat' http://127.0.0.1/healthz)"
jq -e '.ok == true and .channel == "v5"' <<<"$public" >/dev/null || { echo 'FATAL: public route health is not v5/ok' >&2; exit 1; }

target_image_id="$(docker image inspect --format '{{.Id}}' "$target_image")"
image_commit="$(docker image inspect --format '{{ index .Config.Labels "oc.runtime.source_commit" }}' "$target_image")"
image_codex="$(docker image inspect --format '{{ index .Config.Labels "oc.runtime.codex_version" }}' "$target_image")"
[[ "$image_commit" =~ ^[0-9a-f]{7,40}$ && "$target_commit" == "$image_commit"* ]] || { echo "FATAL: image source_commit is not a prefix of target commit" >&2; exit 1; }
[[ -n "$image_codex" ]] || { echo 'FATAL: image missing codex version label' >&2; exit 1; }
actual_codex="$(docker run --rm --entrypoint codex "$target_image" --version)"
[[ "$actual_codex" == "codex-cli $image_codex" ]] || { echo 'FATAL: image codex label/binary mismatch' >&2; exit 1; }

dburl="$(grep '^DATABASE_URL=' "$env_file" | tail -n 1 | cut -d= -f2-)"
[[ -n "$dburl" ]] || { echo 'FATAL: DATABASE_URL missing' >&2; exit 1; }
IFS=',' read -ra required <<<"$required_csv"
for migration in "${required[@]}"; do
  [[ "$migration" =~ ^[0-9]{4}_[a-z0-9_]+$ ]] || { echo 'FATAL: invalid migration id in metadata' >&2; exit 1; }
  applied="$(psql "$dburl" -X -v ON_ERROR_STOP=1 -tAc "SELECT count(*) FROM schema_migrations WHERE version='${migration}'" | tr -d '[:space:]')"
  [[ "$applied" == 1 ]] || { echo "FATAL: required migration not applied: $migration" >&2; exit 1; }
done
applied_set="$(psql "$dburl" -X -v ON_ERROR_STOP=1 -tAc "SELECT COALESCE(string_agg(version,',' ORDER BY version),'') FROM schema_migrations")"
applied_hash="$(printf '%s' "$applied_set" | sha256sum | awk '{print $1}')"

final="$root/$nonce"; tmp="$root/.tmp-$nonce"
[[ ! -e "$final" && ! -e "$tmp" ]] || { echo 'FATAL: nonce already exists/replay' >&2; exit 1; }
mkdir -m 700 "$tmp" "$tmp/source"
rsync -a --delete \
  --exclude '.git' --exclude 'node_modules' --exclude 'data' --exclude '*.log' \
  --exclude '.codex' --exclude 'packages/desktop' \
  "$remote_src/" "$tmp/source/"
install -m 600 "$env_file" "$tmp/commercial-v5.env"
for f in "/etc/systemd/system/$unit" "/etc/systemd/system/$unit.d/override.conf"; do
  if [[ -f "$f" ]]; then mkdir -p "$tmp$(dirname "$f")"; install -m 600 "$f" "$tmp$f"; fi
done
old_image="$(grep '^OC_RUNTIME_IMAGE=' "$env_file" | tail -n 1 | cut -d= -f2-)"
old_image_id="$(docker image inspect --format '{{.Id}}' "$old_image")"
old_commit="$(jq -r '.commit // "unknown"' "$remote_src/VERSION.json" 2>/dev/null || echo unknown)"
now="$(date +%s)"; expires="$((now + 1800))"
jq -n \
  --arg host "$expected_host" --arg nonce "$nonce" --arg target_commit "$target_commit" \
  --arg target_image "$target_image" --arg target_image_id "$target_image_id" \
  --arg old_commit "$old_commit" --arg old_image "$old_image" --arg old_image_id "$old_image_id" \
  --arg migration_tree_hash "$migration_tree_hash" --arg applied_migrations_hash "$applied_hash" \
  --argjson created_at "$now" --argjson expires_at "$expires" \
  '{schema:1,host:$host,nonce:$nonce,target_commit:$target_commit,target_image:$target_image,
    target_image_id:$target_image_id,old_commit:$old_commit,old_image:$old_image,
    old_image_id:$old_image_id,database_compatibility:"backward-compatible",
    migration_tree_hash:$migration_tree_hash,applied_migrations_hash:$applied_migrations_hash,
    created_at:$created_at,expires_at:$expires_at,
    operation_sequence:["offline-recycle","stage","activate-staged"]}' >"$tmp/manifest.json"
jq -n --argjson at "$now" '{state:"prepared",updated_at:$at}' >"$tmp/state.json"
chmod 600 "$tmp/manifest.json" "$tmp/state.json"
sync -f "$tmp" || sync
mv "$tmp" "$final"
sync -f "$root" || sync
echo "  ✓ prepared nonce=$nonce target_image_id=$target_image_id expires_at=$expires"
REMOTE
  echo "CUTOVER_NONCE=$nonce"
  echo "✓ 目标镜像已在服务在线期间验证，完整旧激活面已快照；现在才允许进入离线窗口。"
}

recover_cutover() {
  local reason="${1:-offline cutover failed}"
  require_mutation_lease_for_compensation "offline-cutover-recovery" || exit 86
  [[ "$DRY" == 1 ]] && { echo "  [dry-run] recover old activation and start $V5_UNIT ($reason)"; return 0; }
  echo "⚠ 离线步骤失败，恢复旧激活面并启动旧服务：$reason" >&2
  ssh "$KL_HOST" bash -s -- "$CUTOVER_ROOT" "$CUTOVER_LOCK" "$CUTOVER_NONCE" "$REMOTE_SRC" "$V5_ENV" "$V5_UNIT" "$V5_PORT" "$MAINTENANCE_MARKER" "$MAINTENANCE_LOCK" "$DIRECT_TURN_TIMELINE_CAP" <<'REMOTE'
set -Eeuo pipefail
root="$1"; lock="$2"; nonce="$3"; remote_src="$4"; env_file="$5"; unit="$6"; port="$7"; marker="$8"; maintenance_lock="$9"; direct_cap="${10}"
mkdir -p "$(dirname "$lock")"; touch "$lock"; chmod 600 "$lock"; exec 9>"$lock"; flock -x 9
mkdir -p -m 700 "$(dirname "$marker")"; touch "$maintenance_lock"; chmod 600 "$maintenance_lock"
exec 8>"$maintenance_lock"; flock -x 8
clear_own_marker() {
  if [[ -f "$marker" ]] && jq -e --arg nonce "$nonce" \
      '.schema == 1 and .nonce == $nonce' "$marker" >/dev/null 2>&1; then
    rm -f "$marker"
  fi
}
bundle="$root/$nonce"
secure=0
if [[ "$nonce" =~ ^[0-9a-f]{32}$ && -d "$bundle" && -f "$bundle/manifest.json" &&
      "$(stat -c '%U:%G' "$bundle")" == 'root:root' && "$(stat -c '%a' "$bundle")" == 700 &&
      "$(stat -c '%a' "$bundle/manifest.json")" == 600 &&
      "$(jq -r '.host // empty' "$bundle/manifest.json" 2>/dev/null)" == "$(hostname -f)" ]]; then
  secure=1
fi
if [[ "$secure" != 1 ]]; then
  clear_own_marker || true
  echo 'FATAL: no trusted rollback bundle; refusing to start an unverified/mixed activation' >&2
  exit 1
fi
if [[ "$secure" == 1 ]]; then
  manifest="$bundle/manifest.json"
  old_image="$(jq -r '.old_image' "$manifest")"; old_image_id="$(jq -r '.old_image_id' "$manifest")"
  [[ -f "$bundle/commercial-v5.env" && -d "$bundle/source" ]] || { echo 'FATAL: rollback bundle incomplete' >&2; exit 1; }
  [[ "$(docker image inspect --format '{{.Id}}' "$old_image")" == "$old_image_id" ]] || { echo 'FATAL: old runtime image identity missing/drifted' >&2; exit 1; }

  txn="$root/.recovery-$nonce"; restore_dir="${remote_src}.restore-$nonce"; live_backup="${remote_src}.failed-$nonce"
  rm -rf "$txn" "$restore_dir" "$live_backup"; mkdir -m 700 "$txn" "$restore_dir"
  cp -a "$env_file" "$txn/current.env"
  had_current_unit=0; had_current_override=0
  [[ -f "/etc/systemd/system/$unit" ]] && { cp -a "/etc/systemd/system/$unit" "$txn/current.unit"; had_current_unit=1; }
  [[ -f "/etc/systemd/system/$unit.d/override.conf" ]] && { cp -a "/etc/systemd/system/$unit.d/override.conf" "$txn/current.override"; had_current_override=1; }
  source_moved=0; source_installed=0; env_installed=0
  rollback_partial() {
    local rc=$? restore_failed=0
    [[ $# -eq 0 ]] || rc="$1"
    trap - ERR
    if [[ "$source_moved" == 1 ]]; then
      if [[ "$source_installed" == 1 && -d "$remote_src" ]]; then
        mv "$remote_src" "${restore_dir}.broken" || restore_failed=1
      fi
      if [[ -d "$live_backup" ]]; then
        mv "$live_backup" "$remote_src" || restore_failed=1
      else
        restore_failed=1
      fi
    fi
    if [[ "$env_installed" == 1 && -f "$txn/current.env" ]]; then
      install -m 600 "$txn/current.env" "$env_file" || restore_failed=1
    fi
    if [[ "$had_current_unit" == 1 ]]; then
      install -m 644 "$txn/current.unit" "/etc/systemd/system/$unit" || restore_failed=1
    else
      rm -f "/etc/systemd/system/$unit" || restore_failed=1
    fi
    if [[ "$had_current_override" == 1 ]]; then
      mkdir -p "/etc/systemd/system/$unit.d" || restore_failed=1
      install -m 644 "$txn/current.override" "/etc/systemd/system/$unit.d/override.conf" || restore_failed=1
    else
      rm -f "/etc/systemd/system/$unit.d/override.conf" || restore_failed=1
    fi
    if [[ "$restore_failed" == 0 ]]; then
      systemctl daemon-reload || restore_failed=1
    fi
    if [[ "$restore_failed" == 0 ]]; then
      systemctl start "$unit" || restore_failed=1
    fi
    clear_own_marker || true
    if [[ "$restore_failed" == 0 ]]; then
      echo 'FATAL: old activation restore failed before commit; verified pre-recovery activation restored and started' >&2
      exit "$rc"
    else
      echo 'FATAL: rollback of pre-recovery activation also failed; service deliberately remains stopped' >&2
      exit 70
    fi
  }
  trap rollback_partial ERR

  # Freeze the failed/new activation before cloning its preserved runtime-only
  # paths (node_modules/data). The old tracked activation is overlaid in an
  # isolated sibling directory; no live file changes until the directory swap.
  systemctl stop "$unit"
  candidate_start_attempted="$(jq -er '
    if .candidate_start_attempted == true then "true"
    elif (.candidate_start_attempted // false) == false then "false"
    else error("invalid candidate_start_attempted") end
  ' "$bundle/state.json")"
  # Once the candidate may have served, direct timeline is an irreversible UI
  # data floor. If the trusted old source is legacy but the stopped current
  # source is capable, restore/restart current rather than hide statuses that
  # were written without legacy shadow rows.
  old_metadata="$bundle/source/deploy/v5/release-metadata.json"
  old_direct_capability="$(jq -er --arg c "$direct_cap" '(.capabilities // []) as $caps
    | if ($caps | type) != "array" then error("capabilities must be an array")
      elif (($caps | index($c)) != null) then "capable" else "incapable" end' "$old_metadata")"
  if [[ "$candidate_start_attempted" == true && "$old_direct_capability" == incapable ]]; then
    current_metadata="$remote_src/deploy/v5/release-metadata.json"
    current_direct_capability="$(jq -er --arg c "$direct_cap" '(.capabilities // []) as $caps
      | if ($caps | type) != "array" then error("capabilities must be an array")
        elif (($caps | index($c)) != null) then "capable" else "incapable" end' "$current_metadata")"
    if [[ "$current_direct_capability" != incapable ]]; then
      echo "FATAL: refusing irreversible direct turn timeline downgrade during offline recovery" >&2
      rollback_partial 1
    fi
  fi
  cp -al "$remote_src/." "$restore_dir/"
  rsync -a --delete \
    --exclude '.git' --exclude 'node_modules' --exclude 'data' --exclude '*.log' \
    --exclude '.codex' --exclude 'packages/desktop' \
    "$bundle/source/" "$restore_dir/"
  install -m 600 "$bundle/commercial-v5.env" "$txn/old.env"

  mv "$remote_src" "$live_backup"; source_moved=1
  mv "$restore_dir" "$remote_src"; source_installed=1
  mv "$txn/old.env" "$env_file"; env_installed=1
  for saved in "$bundle"/etc/systemd/system/* "$bundle"/etc/systemd/system/*.d/override.conf; do
    [[ -f "$saved" ]] || continue
    dest="/${saved#"$bundle"/}"
    mkdir -p "$(dirname "$dest")"; install -m 644 "$saved" "$dest.tmp"; mv "$dest.tmp" "$dest"
  done
  systemctl daemon-reload
  now="$(date +%s)"; jq -n --argjson at "$now" '{state:"recovered",updated_at:$at}' >"$bundle/state.json.tmp"
  chmod 600 "$bundle/state.json.tmp"; mv "$bundle/state.json.tmp" "$bundle/state.json"
  trap - ERR
fi

# Once the old activation is committed, never stop it again merely because
# start/health is slow. Alerting is re-enabled and manual repair can continue.
start_rc=0; systemctl start "$unit" || start_rc=$?
clear_own_marker
[[ "$start_rc" == 0 ]] || { echo 'FATAL: restored activation could not be started' >&2; exit "$start_rc"; }
for _ in $(seq 1 10); do
  body="$(curl -fsS --max-time 3 "http://127.0.0.1:${port}/healthz" 2>/dev/null)"
  if jq -e '.ok == true and .channel == "v5"' <<<"$body" >/dev/null 2>&1; then
    [[ "$secure" == 1 ]] && rm -rf "$live_backup" "$txn" "${restore_dir}.broken"
    echo '  ✓ old v5 activation healthy'; exit 0
  fi
  sleep 2
done
echo 'FATAL: old service was started but recovery smoke timed out; service intentionally left running for manual repair' >&2
exit 1
REMOTE
}

set_cutover_maintenance() {
  cutover_break_glass && return 0
  [[ "$DRY" == 1 ]] && { echo "  [dry-run] set planned-maintenance marker for nonce=$CUTOVER_NONCE"; return 0; }
  ssh "$KL_HOST" bash -s -- "$CUTOVER_ROOT" "$CUTOVER_NONCE" "$MAINTENANCE_MARKER" "$MAINTENANCE_LOCK" <<'REMOTE'
set -Eeuo pipefail
root="$1"; nonce="$2"; marker="$3"; lock="$4"; manifest="$root/$nonce/manifest.json"
[[ -f "$manifest" && "$(jq -r '.host' "$manifest")" == "$(hostname -f)" ]] || exit 1
mkdir -p -m 700 "$(dirname "$marker")"; touch "$lock"; chmod 600 "$lock"
exec 9>"$lock"; flock -x 9
if [[ -f "$marker" ]]; then
  existing_schema="$(jq -r '.schema // empty' "$marker" 2>/dev/null || true)"
  existing_nonce="$(jq -r '.nonce // empty' "$marker" 2>/dev/null || true)"
  [[ "$existing_schema" == 1 && "$existing_nonce" == "$nonce" ]] \
    || { echo 'FATAL: another planned-maintenance marker exists' >&2; exit 1; }
fi
deadline="$(jq -r '.expires_at' "$manifest")"; mkdir -p -m 700 "$(dirname "$marker")"
jq -n --arg host "$(hostname -f)" --arg nonce "$nonce" --argjson deadline "$deadline" \
  '{schema:1,host:$host,nonce:$nonce,deadline:$deadline}' >"$marker.tmp"
chmod 600 "$marker.tmp"; mv "$marker.tmp" "$marker"
REMOTE
}

clear_cutover_maintenance() {
  [[ "$DRY" == 1 ]] && { echo "  [dry-run] clear planned-maintenance marker"; return 0; }
  ssh "$KL_HOST" bash -s -- "$MAINTENANCE_MARKER" "$MAINTENANCE_LOCK" "$CUTOVER_NONCE" <<'REMOTE'
set -Eeuo pipefail
marker="$1"; lock="$2"; nonce="$3"
mkdir -p -m 700 "$(dirname "$marker")"; touch "$lock"; chmod 600 "$lock"
exec 9>"$lock"; flock -x 9
if [[ -f "$marker" ]] && jq -e --arg nonce "$nonce" \
    '.schema == 1 and .nonce == $nonce' "$marker" >/dev/null 2>&1; then
  rm -f "$marker"
fi
REMOTE
}

install_cutover_target_image_env() {
  cutover_break_glass && return 0
  [[ "$DRY" == 1 ]] && { echo "  [dry-run] atomically install manifest target image into $V5_ENV"; return 0; }
  ssh "$KL_HOST" bash -s -- "$CUTOVER_ROOT" "$CUTOVER_LOCK" "$CUTOVER_NONCE" "$V5_ENV" <<'REMOTE'
set -Eeuo pipefail
root="$1"; lock="$2"; nonce="$3"; env_file="$4"; bundle="$root/$nonce"
exec 9>"$lock"; flock -x 9
[[ "$(jq -r '.state' "$bundle/state.json")" == activating ]] || { echo 'FATAL: target env install requires activating state' >&2; exit 1; }
target_image="$(jq -r '.target_image' "$bundle/manifest.json")"
target_id="$(jq -r '.target_image_id' "$bundle/manifest.json")"
[[ "$(docker image inspect --format '{{.Id}}' "$target_image")" == "$target_id" ]] || { echo 'FATAL: target image identity drift before env install' >&2; exit 1; }
[[ "$(grep -c '^OC_RUNTIME_IMAGE=' "$env_file")" == 1 ]] || { echo 'FATAL: env must contain exactly one OC_RUNTIME_IMAGE' >&2; exit 1; }
awk -v image="$target_image" '/^OC_RUNTIME_IMAGE=/{print "OC_RUNTIME_IMAGE=" image; next} {print}' "$env_file" >"$env_file.tmp"
chmod --reference="$env_file" "$env_file.tmp"; chown --reference="$env_file" "$env_file.tmp"
mv "$env_file.tmp" "$env_file"
[[ "$(grep '^OC_RUNTIME_IMAGE=' "$env_file" | cut -d= -f2-)" == "$target_image" ]] || { echo 'FATAL: target image env verification failed' >&2; exit 1; }
[[ "$(docker image inspect --format '{{.Id}}' "$target_image")" == "$target_id" ]] || { echo 'FATAL: target image drift after env install' >&2; exit 1; }
REMOTE
}

mark_cutover_candidate_start_attempted() {
  cutover_break_glass && return 0
  [[ "$DRY" == 1 ]] && { echo "  [dry-run] persist candidate_start_attempted before staged start"; return 0; }
  ssh "$KL_HOST" bash -s -- "$CUTOVER_ROOT" "$CUTOVER_LOCK" "$CUTOVER_NONCE" <<'REMOTE'
set -Eeuo pipefail
root="$1"; lock="$2"; nonce="$3"; bundle="$root/$nonce"; state_file="$bundle/state.json"
exec 9>"$lock"; flock -x 9
[[ "$(jq -r '.state' "$state_file")" == activating ]] \
  || { echo 'FATAL: candidate start marker requires activating state' >&2; exit 1; }
now="$(date +%s)"
jq --argjson at "$now" \
  '.candidate_start_attempted=true | .candidate_start_attempted_at=$at | .updated_at=$at' \
  "$state_file" >"$state_file.tmp"
chmod 600 "$state_file.tmp"; sync -f "$state_file.tmp" || sync
mv "$state_file.tmp" "$state_file"; sync -f "$bundle" || sync
REMOTE
}

cutover_transition() {
  local expected="$1" next="$2"
  cutover_require_args || return 1
  cutover_break_glass && return 0
  local target_commit
  target_commit="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  if [[ "$DRY" == 1 ]]; then echo "  [dry-run] cutover $expected → $next (nonce=$CUTOVER_NONCE)"; return 0; fi
  ssh "$KL_HOST" bash -s -- "$CUTOVER_ROOT" "$CUTOVER_LOCK" "$CUTOVER_NONCE" "$target_commit" "$expected" "$next" "$V5_ENV" <<'REMOTE'
set -Eeuo pipefail
root="$1"; lock="$2"; nonce="$3"; target_commit="$4"; expected="$5"; next="$6"; env_file="$7"
exec 9>"$lock"; flock -x 9
bundle="$root/$nonce"; manifest="$bundle/manifest.json"; state_file="$bundle/state.json"
[[ -d "$bundle" && -f "$manifest" && -f "$state_file" ]] || { echo 'FATAL: cutover manifest missing' >&2; exit 1; }
[[ "$(stat -c '%U:%G' "$bundle")" == 'root:root' && "$(stat -c '%a' "$bundle")" == 700 ]] || { echo 'FATAL: insecure cutover directory' >&2; exit 1; }
[[ "$(stat -c '%U:%G' "$manifest")" == 'root:root' && "$(stat -c '%a' "$manifest")" == 600 ]] || { echo 'FATAL: insecure manifest' >&2; exit 1; }
[[ "$(jq -r '.host' "$manifest")" == "$(hostname -f)" ]] || { echo 'FATAL: host binding mismatch' >&2; exit 1; }
[[ "$(jq -r '.nonce' "$manifest")" == "$nonce" ]] || { echo 'FATAL: nonce binding mismatch' >&2; exit 1; }
[[ "$(jq -r '.target_commit' "$manifest")" == "$target_commit" ]] || { echo 'FATAL: target commit mismatch' >&2; exit 1; }
[[ "$(jq -r '.database_compatibility' "$manifest")" == 'backward-compatible' ]] || { echo 'FATAL: DB compatibility is not safe' >&2; exit 1; }
(( $(date +%s) <= $(jq -r '.expires_at' "$manifest") )) || { echo 'FATAL: cutover manifest expired' >&2; exit 1; }
image="$(jq -r '.target_image' "$manifest")"; expected_id="$(jq -r '.target_image_id' "$manifest")"
[[ "$(docker image inspect --format '{{.Id}}' "$image")" == "$expected_id" ]] || { echo 'FATAL: target image tag drift' >&2; exit 1; }
dburl="$(grep '^DATABASE_URL=' "$env_file" | tail -n 1 | cut -d= -f2-)"
applied_set="$(psql "$dburl" -X -v ON_ERROR_STOP=1 -tAc "SELECT COALESCE(string_agg(version,',' ORDER BY version),'') FROM schema_migrations")"
applied_hash="$(printf '%s' "$applied_set" | sha256sum | awk '{print $1}')"
[[ "$applied_hash" == "$(jq -r '.applied_migrations_hash' "$manifest")" ]] || { echo 'FATAL: applied migration set changed after prepare' >&2; exit 1; }
[[ "$(jq -r '.state' "$state_file")" == "$expected" ]] || { echo 'FATAL: invalid/replayed cutover state' >&2; exit 1; }
now="$(date +%s)"
jq --arg state "$next" --argjson at "$now" '.state=$state | .updated_at=$at' \
  "$state_file" >"$state_file.tmp"
chmod 600 "$state_file.tmp"; sync -f "$state_file.tmp" || sync; mv "$state_file.tmp" "$state_file"; sync -f "$bundle" || sync
REMOTE
}

begin_cutover_step() {
  local expected="$1" next="$2"
  if cutover_transition "$expected" "$next"; then
    if [[ "$next" == recycling ]] && ! set_cutover_maintenance; then
      recover_cutover "failed to create planned-maintenance marker"
      return 1
    fi
    return 0
  fi
  local state
  state="$(ssh "$KL_HOST" "systemctl is-active '$V5_UNIT' 2>/dev/null || true")"
  [[ "$state" == active ]] || recover_cutover "hard gate rejected ${expected}->${next}"
  return 1
}

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

assert_gpt56_migration_ready() {
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] 断言 migration 0123 + GPT-5.6 三型号已就绪、GPT-5.5 已退役"
    return 0
  fi
  local ready
  ready="$(ssh "$KL_HOST" "set -a; . '$V5_ENV' 2>/dev/null; psql \"\$DATABASE_URL\" -X -v ON_ERROR_STOP=1 -tAc \"SELECT (EXISTS (SELECT 1 FROM schema_migrations WHERE version='0123_gpt56_models') AND (SELECT count(*) FROM model_pricing WHERE model_id IN ('gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna') AND enabled IS TRUE) = 3 AND EXISTS (SELECT 1 FROM model_pricing WHERE model_id='gpt-5.5' AND enabled IS FALSE AND visibility='hidden') AND NOT EXISTS (SELECT 1 FROM account_group_models WHERE model_id='gpt-5.5') AND NOT EXISTS (SELECT 1 FROM user_preferences WHERE prefs->>'default_model'='gpt-5.5'))::text\"" 2>/dev/null)" || {
    echo "✗ 无法验证 0123 GPT-5.6 数据迁移状态" >&2
    exit 1
  }
  ready="${ready//[[:space:]]/}"
  [[ "$ready" == "true" ]] || {
    echo "✗ 0123 GPT-5.6 数据迁移未完整就绪；保持 $V5_UNIT 停机" >&2
    exit 1
  }
  echo "  ✓ migration 0123 + GPT-5.6 数据切换已就绪"

  # 仅 target checkout 自带 0124 时，离线 activate 才要求该 migration。普通
  # deploy/smoke/dist/rollback 不调用本函数，因此旧 release 回滚不会被新迁移误杀。
  if [[ -f "$REPO_ROOT/packages/commercial/src/db/migrations/0124_gpt56_xhigh_defaults.sql" ]]; then
    local defaults_ready
    defaults_ready="$(ssh "$KL_HOST" "set -a; . '$V5_ENV' 2>/dev/null; psql \"\$DATABASE_URL\" -X -v ON_ERROR_STOP=1 -tAc \"SELECT (EXISTS (SELECT 1 FROM schema_migrations WHERE version='0124_gpt56_xhigh_defaults') AND (SELECT count(*) FROM model_pricing WHERE model_id IN ('gpt-5.6-sol','gpt-5.6-terra') AND default_effort='xhigh') = 2)::text\"" 2>/dev/null)" || {
      echo "✗ 无法验证 target release 的 0124 默认深度迁移" >&2; return 1;
    }
    defaults_ready="${defaults_ready//[[:space:]]/}"
    [[ "$defaults_ready" == true ]] || {
      echo "✗ target release 包含 0124，但数据库尚未在线完成 Sol/Terra=xhigh；拒绝激活" >&2
      return 1
    }
    echo "  ✓ target release 所需 0124 已在线应用"
  fi
}

RSYNC_EXCLUDES=(--exclude '.git' --exclude 'node_modules' --exclude 'data'
  --exclude '*.log' --exclude 'dist' --exclude '.codex' --exclude 'packages/desktop'
  --exclude 'VERSION.json')

# 写 VERSION.json(gateway /version 读 cwd/VERSION.json)—— 灰度归属:channel + commit + builtAt。
write_version() {
  local target="${1:-$REMOTE_SRC}"   # 蓝绿:可写入 release 目录;默认 $REMOTE_SRC(向后兼容)
  local commit builtAt tag
  # P0#2(Codex):commit 由调用方**显式钉死**(蓝绿传 build_release 捕获的 sha),不再重读 HEAD
  # —— 否则并发会话移动 HEAD 时 VERSION 与 archive 源码会不同 sha。缺省才回退读 HEAD。
  commit="${2:-$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)}"
  builtAt="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  tag="v5-$commit"
  local json="{\"tag\":\"$tag\",\"commit\":\"$commit\",\"channel\":\"v5\",\"builtAt\":\"$builtAt\"}"
  if [[ "$DRY" == 1 ]]; then echo "  [dry-run] write VERSION.json → $target: $json"; return; fi
  # 原子写(temp + mv):裸 `cat > VERSION.json` 传输期可能短暂为空/半写,master /version 读到空。
  ssh "$KL_HOST" "cat > '$target/VERSION.json.tmp' && mv -f '$target/VERSION.json.tmp' '$target/VERSION.json'" <<<"$json"
  echo "  ✓ VERSION.json ($target): $json"
}

# ═══════════════════════ 蓝绿部署(release 目录 + 原子 symlink)═══════════════════════
# 根治并发部署崩溃循环 + 部署树 HEAD 被并发会话移走(2026-07-11 事故)。原理:
#   - REMOTE_SRC=/opt/openclaude/openclaude-v5 是 **symlink** → RELEASES_ROOT/rel-<sha>-<ts>
#   - 部署 = 从**锁定 sha** 的 `git archive`(不读共用工作树活状态)建**不可变** release 目录
#     (硬链 node_modules,package-lock 变才 npm ci;dist 构建进 reldir 或硬链继承)→ **原子
#     symlink 翻转**(mv -T)→ restart。master 永远只从完整不可变 release 启动 → 无半同步树、
#     无崩溃循环;VERSION/源码/dist 永远同 sha 自洽;并发部署=串行原子翻转,各发布 canonical 超集。
#   - sessions.db 早已外置 /root/.openclaude-v5/,data/ 空 → 无"运行中 master 数据在树内"问题。
RELEASES_ROOT="/opt/openclaude/openclaude-v5-releases"
DEPLOY_RECOVERY_MARKER="$RELEASES_ROOT/.manual-recovery-required"
MUTATION_LANE_INFLIGHT_MARKER="${OC_V5_MUTATION_LANE_MARKER:-$RELEASES_ROOT/.mutation-lane-inflight}"
RELEASES_KEEP="${RELEASES_KEEP:-6}"

arm_mutation_lane_inflight() { # parent-only; called while lease is live
  [[ "$DRY" == 1 || "$MUTATION_LEASE_BYPASSED" == 1 ]] && return 0
  local nonce source_commit result
  nonce="$(openssl rand -hex 16)"
  source_commit="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)"
  [[ "$nonce" =~ ^[0-9a-f]{32}$ && "$source_commit" =~ ^[0-9a-f]{40}$ ]] || {
    echo "✗ 无法生成 mutation lane in-flight 身份" >&2
    return 1
  }
  if ! result="$(ssh "$KL_HOST" bash -s -- "$MUTATION_LANE_INFLIGHT_MARKER" \
      "$nonce" "$MODE" "$source_commit" "$$" <<'REMOTE'
set -Eeuo pipefail
marker="$1"; nonce="$2"; mode="$3"; source_commit="$4"; outer_pid="$5"
[[ "$nonce" =~ ^[0-9a-f]{32}$ && "$source_commit" =~ ^[0-9a-f]{40}$ && "$outer_pid" =~ ^[1-9][0-9]*$ ]] || exit 2
dir="$(dirname "$marker")"
mkdir -p -m 700 "$dir"
tmp="${marker}.tmp.$$"
umask 077
jq -n --arg nonce "$nonce" --arg mode "$mode" --arg source_commit "$source_commit" \
  --argjson outer_pid "$outer_pid" --argjson started_at "$(date +%s)" \
  '{schema:1,nonce:$nonce,mode:$mode,source_commit:$source_commit,outer_pid:$outer_pid,started_at:$started_at}' >"$tmp"
chmod 600 "$tmp"
sync -f "$tmp" || sync
if ! ln "$tmp" "$marker" 2>/dev/null; then rm -f "$tmp"; echo EXISTS; exit 20; fi
sync -f "$dir" || sync
jq -e --arg nonce "$nonce" --arg mode "$mode" --arg source_commit "$source_commit" \
  '.schema == 1 and .nonce == $nonce and .mode == $mode and .source_commit == $source_commit' \
  "$marker" >/dev/null
rm -f "$tmp"
sync -f "$dir" || sync
echo "ARMED:$nonce"
REMOTE
  )"; then
    echo "✗ mutation lane in-flight marker 已存在或无法原子预置:$KL_HOST:$MUTATION_LANE_INFLIGHT_MARKER" >&2
    return 1
  fi
  [[ "$result" == "ARMED:$nonce" ]] || { echo "✗ mutation lane marker 返回异常:$result" >&2; return 1; }
  MUTATION_LANE_INFLIGHT_NONCE="$nonce"
  MUTATION_LANE_INFLIGHT_ACTIVE=1
  echo "  ✓ mutation lane in-flight 已预置(mode=$MODE nonce=$nonce)"
}

clear_mutation_lane_inflight_exact() { # child-only; last mutation before controlled exit
  [[ "$MUTATION_LANE_INFLIGHT_ACTIVE" == 1 && -n "$MUTATION_LANE_INFLIGHT_NONCE" ]] || return 0
  [[ "$DRY" == 1 || "$MUTATION_LEASE_BYPASSED" == 1 ]] && return 0
  local result
  if ! result="$(ssh "$KL_HOST" bash -s -- "$MUTATION_LANE_INFLIGHT_MARKER" \
      "$MUTATION_LANE_INFLIGHT_NONCE" <<'REMOTE'
set -Eeuo pipefail
marker="$1"; nonce="$2"; dir="$(dirname "$marker")"
if [[ -f "$marker" ]] && jq -e --arg nonce "$nonce" '.schema == 1 and .nonce == $nonce' "$marker" >/dev/null 2>&1; then
  rm -f "$marker"
  sync -f "$dir" || sync
  [[ ! -e "$marker" ]]
  echo CLEARED
else
  echo PRESERVED
fi
REMOTE
  )"; then
    echo "✗ mutation lane in-flight marker exact clear 失败；保留供人工恢复" >&2
    return 1
  fi
  [[ "$result" == CLEARED ]] || { echo "✗ mutation lane marker nonce 已变化/不存在；拒绝宣告收尾:$result" >&2; return 1; }
  MUTATION_LANE_INFLIGHT_ACTIVE=0
  MUTATION_LANE_INFLIGHT_NONCE=""
}

mutation_lane_inflight_absent() { # read-only parent verification
  [[ "$DRY" == 1 || "$MUTATION_LEASE_BYPASSED" == 1 ]] && return 0
  ssh "$KL_HOST" "test ! -e '$MUTATION_LANE_INFLIGHT_MARKER'"
}

# 状态提交回执无法裁决时，绝不能继续猜测并翻另一生效面。落一个远端持久标记，后续所有
# 写 lane 起手即拒；人工核对 deploy_state / A/B symlink / unit / tuple history 后才能移除。
mark_deploy_recovery_required() {  # $1=reason
  local reason="$1" encoded
  [[ "$DRY" == 1 ]] && { echo "  [dry-run] mark manual recovery required:$reason"; return 0; }
  encoded="$(printf '%s' "$reason" | base64 -w0)"
  if ! ssh "$KL_HOST" bash -s -- "$DEPLOY_RECOVERY_MARKER" "$encoded" <<'REMOTE'
set -Eeuo pipefail
marker="$1"; encoded="$2"; dir="$(dirname "$marker")"; tmp="${marker}.tmp.$$"
umask 077
mkdir -p -m 700 "$dir"
printf '%s' "$encoded" | base64 -d >"$tmp"
chmod 600 "$tmp"
sync -f "$tmp" || sync
mv -f "$tmp" "$marker"
sync -f "$dir" || sync
[[ "$(base64 -w0 <"$marker")" == "$encoded" ]]
REMOTE
  then
    echo "FATAL:人工恢复标记写入/回读失败:$DEPLOY_RECOVERY_MARKER；保留 mutation in-flight 证据并 crash-stop" >&2
    exit 86
  fi
  echo "FATAL:部署进入人工恢复态:$reason" >&2
  echo "  标记:$KL_HOST:$DEPLOY_RECOVERY_MARKER（核对并修复 state/runtime 后人工移除）" >&2
  return 0
}

assert_no_deploy_recovery_marker() {
  [[ "$DRY" == 1 ]] && return 0
  if ! ssh "$KL_HOST" "test ! -e '$DEPLOY_RECOVERY_MARKER'"; then
    echo "✗ 检测到未收敛的人工恢复标记:$KL_HOST:$DEPLOY_RECOVERY_MARKER" >&2
    ssh "$KL_HOST" "sed -n '1,20p' '$DEPLOY_RECOVERY_MARKER'" 2>/dev/null | sed 's/^/  /' >&2 || true
    echo "  禁止任何新写 lane；先核对 deploy_state、A/B symlink/unit 与 runtime tuple，收敛后人工移除。" >&2
    return 1
  fi
  if ! ssh "$KL_HOST" "test ! -e '$MUTATION_LANE_INFLIGHT_MARKER'"; then
    echo "✗ 检测到未收敛的 mutation lane in-flight 标记:$KL_HOST:$MUTATION_LANE_INFLIGHT_MARKER" >&2
    ssh "$KL_HOST" "cat '$MUTATION_LANE_INFLIGHT_MARKER'" 2>/dev/null | sed 's/^/  /' >&2 || true
    echo "  上次 lane 可能因 lease/parent 丢失被 crash-stop；禁止自动补偿或新写。先核对 deploy_state、symlink/unit/runtime 后人工移除。" >&2
    return 1
  fi
}

# ═══════════════ durable gate waiver:门禁豁免 = 一次性可记账债务 ═══════════════
# 2026-07-26 出口矩阵审计的架构主线。此前 V5_SMOKE_TURN=0 / V5_SMOKE_E2E=0 /
# OC_FINALIZE_SKIP_EGRESS_GATE / OC_CAPMATRIX_COMPAT / V5_CANARY_REQUIRE_COST=0 这五个
# 豁免都是「一条 env + 一句 echo」就把门整个关掉:不落任何持久证据、monitor 看不见、
# 下一次发布照跑不误 —— 豁免强度比门本身还高,方向是反的。
#
# 仓内已有正确形态:emergency lane 跳过回归矩阵会写 emergency_containment_debts,并由
# assert_emergency_debt_gate 阻断后续所有普通生产写 lane。本机制与之同构,只是载体用
# 远端持久 marker(与 DEPLOY_RECOVERY_MARKER 同一 idiom:root-only 目录 + base64 回读校验),
# 不引入新表/新迁移:
#   ① 用掉豁免 → record_gate_waiver 在 kl-mirror 写持久 marker(写不成功 = 不给豁免);
#   ② monitor 的 check_gate_waivers 看得见并告警;
#   ③ assert_no_open_gate_waivers 阻断下一次普通生产写 lane —— 只放行"能真跑该门把债
#      还上"的 lane,且那条 lane 不许再次带同一豁免 env(禁止连环跳);
#   ④ 门真跑并通过 → clear_gate_waiver 自动销账。
# 【红线】恢复 lane(abort/rollback/recover/reclaim/smoke/hide-luna/emergency containment)
# 永不被本机制阻断 —— 回退路径永远优先于任何新门。
GATE_WAIVER_DIR="$RELEASES_ROOT/.gate-waivers"
GATE_WAIVER_KEYS="smoke-turn e2e-journey finalize-egress-gate capmatrix-compat canary-turn-cost ci-verification"

# 每个 key 的「还债 lane」= 会真跑该门的 mode。不在此列的普通写 lane 一律被阻断。
gate_waiver_repay_modes() { # <key>
  case "$1" in
    smoke-turn)           echo "deploy dist canary promote finalize" ;;
    e2e-journey)          echo "deploy dist canary finalize" ;;
    canary-turn-cost)     echo "deploy dist canary promote finalize" ;;
    finalize-egress-gate) echo "canary promote finalize" ;;
    capmatrix-compat)     echo "canary" ;;
    ci-verification)      echo "deploy dist canary" ;;
    *) return 1 ;;
  esac
}

# 本次调用是否仍带着该豁免(带着 = 禁止用它来还债)。
gate_waiver_env_active() { # <key>
  case "$1" in
    smoke-turn)           [[ "${V5_SMOKE_TURN:-1}" != 1 ]] ;;
    e2e-journey)          [[ "${V5_SMOKE_E2E:-1}" != 1 ]] ;;
    canary-turn-cost)     [[ "${V5_CANARY_REQUIRE_COST:-1}" == 0 ]] ;;
    finalize-egress-gate) [[ "${OC_FINALIZE_SKIP_EGRESS_GATE:-0}" == 1 ]] ;;
    capmatrix-compat)     [[ -n "${OC_CAPMATRIX_COMPAT:-}" ]] ;;
    # ci-verification 有意**不**参与「禁止连环跳过」:CI 证据取不到的常见原因是 gh 未装/
    # 未认证/网络不通,那是环境故障而非操作者偷懒。若把它也纳入连环跳禁令,一次 gh 故障就会
    # 让「必须带 --allow-unverified-ci 才能发」与「带了就被闸挡住」互锁,连热修都发不出去。
    # 债务照样落库、照样在 monitor 常驻、照样阻断不跑该门的 lane,只是不制造死锁。
    ci-verification)      return 1 ;;
    *) return 1 ;;
  esac
}

# 登记豁免债务。写入/回读失败 = fail-closed 返回非零 → 调用方把门当成"没被豁免"处理并失败,
# 绝不出现"豁免生效但没人记账"的静默洞。
record_gate_waiver() { # <key> <reason>
  local key="$1" reason="$2" payload encoded
  gate_waiver_repay_modes "$key" >/dev/null || {
    echo "✗ 未注册的门禁豁免 key=$key(必须先登记进 GATE_WAIVER_KEYS + gate_waiver_repay_modes)" >&2
    return 1
  }
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] record durable gate waiver key=$key reason=$reason"
    return 0
  fi
  payload="$(printf 'key=%s\nmode=%s\nreason=%s\nrecorded_at=%s\nhost=%s\ndeploy_id=%s\ncommit=%s\nrepay_modes=%s\n' \
    "$key" "$MODE" "$reason" "$(date -Is)" "$(hostname -f 2>/dev/null || hostname)" \
    "${MUTATION_DEPLOY_ID:-<none>}" "$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo '<unknown>')" \
    "$(gate_waiver_repay_modes "$key")")"
  encoded="$(printf '%s' "$payload" | base64 -w0)"
  if ! ssh "$KL_HOST" bash -s -- "$GATE_WAIVER_DIR" "$key" "$encoded" <<'REMOTE'
set -Eeuo pipefail
dir="$1"; key="$2"; encoded="$3"; marker="$dir/$key"; tmp="$marker.tmp.$$"
umask 077
mkdir -p -m 700 "$dir"
printf '%s' "$encoded" | base64 -d >"$tmp"
chmod 600 "$tmp"
sync -f "$tmp" || sync
mv -f "$tmp" "$marker"
sync -f "$dir" || sync
[[ "$(base64 -w0 <"$marker")" == "$encoded" ]]
REMOTE
  then
    echo "✗ 门禁豁免债务写入/回读失败:$KL_HOST:$GATE_WAIVER_DIR/$key —— 豁免不成立,门保持强制。" >&2
    return 1
  fi
  echo "  ⚠ 门禁豁免已登记为 durable debt:key=$key($reason)" >&2
  echo "    marker=$KL_HOST:$GATE_WAIVER_DIR/$key;下一次普通发布必须真跑该门才能销账。" >&2
  return 0
}

# 门真跑并通过后销账。清理失败只告警:残留 marker 只会**多**阻断普通 lane(永不影响回退),
# 属安全方向,不因此判部署失败。
clear_gate_waiver() { # <key>
  local key="$1"
  [[ "$DRY" == 1 ]] && return 0
  ssh -n "$KL_HOST" "test -e '$GATE_WAIVER_DIR/$key'" 2>/dev/null || return 0
  if ssh -n "$KL_HOST" "rm -f '$GATE_WAIVER_DIR/$key'"; then
    echo "  ✓ 门禁豁免债务已销账(门真跑通过):key=$key"
  else
    echo "⚠ 门禁豁免债务销账失败(marker 残留,只会多阻断普通 lane):$GATE_WAIVER_DIR/$key" >&2
  fi
  return 0
}

# 单点闸:与 assert_emergency_debt_gate 同一位置挂载(lease 取得之后)。
assert_no_open_gate_waivers() {
  [[ "$DRY" == 1 ]] && return 0
  local open_keys key modes blocked=0
  if ! open_keys="$(ssh -n "$KL_HOST" "ls -1 '$GATE_WAIVER_DIR' 2>/dev/null || true")"; then
    echo "✗ 无法读取门禁豁免债务目录 $KL_HOST:$GATE_WAIVER_DIR(ssh/远端故障);fail-closed 拒绝发布。" >&2
    return 1
  fi
  [[ -n "$open_keys" ]] || return 0
  while read -r key; do
    [[ -n "$key" ]] || continue
    if ! modes="$(gate_waiver_repay_modes "$key")"; then
      echo "✗ 未知门禁豁免债务 key=$key(marker 被手写?)。人工核对后移除:$KL_HOST:$GATE_WAIVER_DIR/$key" >&2
      blocked=1; continue
    fi
    ssh -n "$KL_HOST" "sed -n '1,8p' '$GATE_WAIVER_DIR/$key'" 2>/dev/null | sed 's/^/    /' >&2 || true
    if ! grep -qw -- "$MODE" <<<"$modes"; then
      echo "✗ 未偿还的门禁豁免债务 key=$key:本 lane($MODE)不会真跑该门,禁止发布。" >&2
      echo "  先走能还债的 lane($modes)让门真跑一次;回退 lane(abort/rollback/recover)不受本闸影响。" >&2
      blocked=1; continue
    fi
    if gate_waiver_env_active "$key"; then
      echo "✗ 未偿还的门禁豁免债务 key=$key,而本次调用仍带着同一豁免 env —— 禁止连环跳过。" >&2
      echo "  去掉豁免 env 让门真跑一次即自动销账。" >&2
      blocked=1; continue
    fi
    echo "  · 门禁豁免债务 key=$key 待偿还;本 lane($MODE)将真跑该门,通过后自动销账。"
  done <<<"$open_keys"
  [[ "$blocked" == 0 ]]
}

# 入口单点记账:本次调用声明了哪些豁免 env,就在**任何构建/翻转副作用之前**把债记上。
# 为什么不在每个使用点分别记:OC_FINALIZE_SKIP_EGRESS_GATE 与 OC_CAPMATRIX_COMPAT 分散在
# 5+ 个只读 helper(_egress_num_or_die 一次 finalize 会被调 10 次、_capmatrix_version_compat
# 每个 key 一次),分别记 = 重复 ssh + 权威分裂。豁免的权威语义是「操作者声明要跳过这道门」,
# 所以记账点就是声明点 = lane 入口。fail-closed:记不上就不给跑(否则又回到"豁免无痕")。
record_declared_gate_waivers() {
  local key modes rc=0
  for key in $GATE_WAIVER_KEYS; do
    gate_waiver_env_active "$key" || continue
    # 本 lane 根本不跑该门时,豁免它是空操作(如在 deploy lane 设 OC_CAPMATRIX_COMPAT ——
    # capability matrix 只在 canary 跑)。空操作不该欠债,否则一次操作者笔误会凭空阻断下次发布。
    modes="$(gate_waiver_repay_modes "$key")" || { rc=1; continue; }
    if ! grep -qw -- "$MODE" <<<"$modes"; then
      echo "  · 忽略与本 lane 无关的豁免声明 key=$key(本 lane=$MODE 不跑该门;它只在 $modes 生效)"
      continue
    fi
    record_gate_waiver "$key" "lane 入口声明豁免(mode=$MODE)" || rc=1
  done
  [[ "$rc" == 0 ]] || {
    echo "✗ 门禁豁免债务登记失败 —— 拒绝以「无痕豁免」的方式发布。去掉豁免 env 让门真跑,或修复 $KL_HOST 记账通路。" >&2
    return 1
  }
}

# ── 传统 deploy/dist/rollback 的严格状态快照 ──
# 0135 必须先于 P3 基建版部署 apply；从此 deploy_state 是 active slot/release 的唯一权威。
# 查询失败、零行、非法字段一律在 build/symlink/systemd 等副作用前拒绝，绝不再把“PG 故障”
# 误判成“未 seed”并默认 A。一次快照同时钉 phase/slot/candidate/lock/release，后续 CAS 用同一
# lock_version，防部署期间有人绕过全局 flock 推进状态。
ACTIVE_SLOT="A"; ACTIVE_SRC="$REMOTE_SRC"; ACTIVE_UNIT="$V5_UNIT"; ACTIVE_PORT="$V5_PORT"
ACTIVE_STATE_LOADED=0; ACTIVE_STATE_PHASE=""; ACTIVE_STATE_CANDIDATE_SLOT=""; ACTIVE_STATE_CANDIDATE_RELEASE=""
ACTIVE_STATE_LOCK_VERSION=""; ACTIVE_STATE_RELEASE=""; ACTIVE_STATE_PREVIOUS_RELEASE=""
load_active_lane_state_strict() {
  [[ "$ACTIVE_STATE_LOADED" == 1 ]] && return 0
  if [[ "$DRY" == 1 ]]; then
    ACTIVE_STATE_PHASE="${DRY_DS_PHASE:-stable}"
    ACTIVE_SLOT="${DRY_DS_ACTIVE:-A}"
    ACTIVE_STATE_CANDIDATE_SLOT="${DRY_DS_CANDIDATE:-}"
    ACTIVE_STATE_CANDIDATE_RELEASE="${DRY_DS_CANDIDATE_RELEASE:-}"
    ACTIVE_STATE_LOCK_VERSION="${DRY_DS_LOCK_VERSION:-1}"
    ACTIVE_STATE_RELEASE="${DRY_DS_ACTIVE_RELEASE:-}"
    ACTIVE_STATE_PREVIOUS_RELEASE="${DRY_DS_PREV_RELEASE:-}"
  else
    if ! ds_load; then
      echo "✗ 无法读取 deploy_state 严格快照(PG 不可达/0135 未 apply/单行缺失)。" >&2
      echo "  传统 deploy/dist/rollback 在权威不明时禁止任何 release、symlink 或 systemd 副作用。" >&2
      return 1
    fi
    ACTIVE_STATE_PHASE="$DS_phase"
    ACTIVE_SLOT="$DS_active_slot"
    ACTIVE_STATE_CANDIDATE_SLOT="$DS_candidate_slot"
    ACTIVE_STATE_CANDIDATE_RELEASE="$DS_candidate_release"
    ACTIVE_STATE_LOCK_VERSION="$DS_lock_version"
    ACTIVE_STATE_RELEASE="$DS_active_release"
    ACTIVE_STATE_PREVIOUS_RELEASE="$DS_previous_active_release"
  fi
  [[ "$ACTIVE_SLOT" == A || "$ACTIVE_SLOT" == B ]] || { echo "✗ deploy_state.active_slot 非法:$ACTIVE_SLOT" >&2; return 1; }
  [[ "$ACTIVE_STATE_PHASE" =~ ^(stable|canary|finalizing|aborting)$ ]] || { echo "✗ deploy_state.phase 非法:$ACTIVE_STATE_PHASE" >&2; return 1; }
  [[ "$ACTIVE_STATE_LOCK_VERSION" =~ ^[1-9][0-9]*$ ]] || { echo "✗ deploy_state.lock_version 非法:$ACTIVE_STATE_LOCK_VERSION" >&2; return 1; }
  ACTIVE_SRC="$(slot_src "$ACTIVE_SLOT")"
  ACTIVE_UNIT="$(slot_unit "$ACTIVE_SLOT")"
  ACTIVE_PORT="$(slot_port "$ACTIVE_SLOT")"
  ACTIVE_STATE_LOADED=1
}

resolve_active_lane() {
  load_active_lane_state_strict || return 1
  echo "  · active lane: slot=$ACTIVE_SLOT src=$ACTIVE_SRC unit=$ACTIVE_UNIT port=$ACTIVE_PORT state_lock=$ACTIVE_STATE_LOCK_VERSION"
}

# 传统 deploy/dist/rollback lane 起手闸:cohort rollout 进行中拒绝旁路；candidate 两字段也必须为空。
assert_no_rollout_in_progress() {
  load_active_lane_state_strict || return 1
  if [[ "$ACTIVE_STATE_PHASE" != stable || -n "$ACTIVE_STATE_CANDIDATE_SLOT" || -n "$ACTIVE_STATE_CANDIDATE_RELEASE" ]]; then
    echo "✗ cohort rollout/候选状态未收敛(phase=$ACTIVE_STATE_PHASE candidate_slot=${ACTIVE_STATE_CANDIDATE_SLOT:-<none>} candidate_release=${ACTIVE_STATE_CANDIDATE_RELEASE:-<none>})。" >&2
    echo "  传统 deploy/dist/rollback 会绕过状态机；请先 --finalize 或 --abort 收敛到 stable。" >&2
    return 1
  fi
  [[ "$DRY" == 1 ]] && echo "  [dry-run] 严格 deploy_state 快照通过(phase=stable,candidate=NULL)"
  return 0
}

# 当前 release 目录(active slot symlink 的 target);未迁移(实目录)或无 symlink → 空。
bg_current_release() {
  local src="${1:-${ACTIVE_SRC:-$REMOTE_SRC}}"
  ssh "$KL_HOST" "test -L '$src' && readlink -f '$src' || true" 2>/dev/null || true
}

# Release 完整标记 v2。旧 `{sha,builtAt}` 标记从来没有绑定源码 full SHA、metadata 或
# 实际制品；因此不能继续作为任意 rollback/canary 的信任根。唯一兼容例外是：本次
# invocation 已同时持有 deploy lock + production-mutation lease 后、任何 release 写入前
# 精确捕获并验证的 serving predecessor。这个例外只活在当前进程内，不落盘、不泛化。
RELEASE_COMPLETE_SCHEMA_VERSION=2
CAPTURED_RELEASE_PREDECESSOR=""
TRUSTED_LEGACY_PREDECESSOR=""
TRUSTED_LEGACY_SOURCE_COMMIT=""
TRUSTED_LEGACY_ARTIFACT_SHA256=""
CAPTURED_EGRESS_PREDECESSOR=""
TRUSTED_LEGACY_EGRESS_PREDECESSOR=""
TRUSTED_LEGACY_EGRESS_SOURCE_COMMIT=""
TRUSTED_LEGACY_EGRESS_ARTIFACT_SHA256=""

# 对 release 全树（含 node_modules/dist、常规文件 mode 与 symlink 原始 target）做稳定
# SHA-256；只排除根 `.complete` 本身，避免 marker 自引用。函数既可本地自测，也会通过
# `declare -f` 原样流到 kl-mirror，build/verify 共用一份算法，禁止双实现漂移。
release_artifact_digest() { # <absolute-release-root>
  local root="$1"
  [[ -d "$root" && ! -L "$root" ]] || {
    echo "FATAL: release artifact root 非真实目录:$root" >&2
    return 1
  }
  # One Python walker avoids spawning ~4 processes per file (the old shell
  # manifest took >90 s on the 38k-file production release). Length-prefixed
  # byte fields cover arbitrary path/symlink bytes without TSV ambiguity; file,
  # directory and symlink type/mode/uid/gid are all bound. Root .complete alone
  # is excluded to avoid self-reference.
  python3 - "$root" <<'PY'
import hashlib
import os
import stat
import sys

root = os.fsencode(os.path.abspath(sys.argv[1]))
if not os.path.isdir(root) or os.path.islink(root):
    raise SystemExit("FATAL: release artifact root is not a real directory")

def identity(st):
    return (st.st_dev, st.st_ino, st.st_mode, st.st_uid, st.st_gid,
            st.st_size, st.st_mtime_ns, st.st_ctime_ns)

def snapshot_tree():
    root_stat = os.lstat(root)
    if not stat.S_ISDIR(root_stat.st_mode):
        raise RuntimeError("release artifact root changed type")
    rows = []

    def collect(directory, prefix=b""):
        with os.scandir(directory) as scan:
            for entry in scan:
                name = entry.name
                rel = name if not prefix else prefix + b"/" + name
                if rel == b".complete":
                    continue
                st = entry.stat(follow_symlinks=False)
                mode = st.st_mode
                if not (stat.S_ISREG(mode) or stat.S_ISDIR(mode) or stat.S_ISLNK(mode)):
                    raise RuntimeError(f"non-regular release entry: {os.fsdecode(rel)!r}")
                rows.append((rel, entry.path, identity(st)))
                if stat.S_ISDIR(mode):
                    collect(entry.path, rel)

    collect(root)
    rows.sort(key=lambda item: item[0])
    return identity(root_stat), rows

root_before, entries = snapshot_tree()
digest = hashlib.sha256(b"openclaude-release-artifact-v2\0")

def field(value):
    if isinstance(value, str):
        value = value.encode("ascii")
    digest.update(len(value).to_bytes(8, "big"))
    digest.update(value)

root_stat = os.lstat(root)
if identity(root_stat) != root_before:
    raise RuntimeError("release artifact root changed before digest")
field(b"D")
field(b"")
field(str(stat.S_IMODE(root_stat.st_mode)))
field(str(root_stat.st_uid))
field(str(root_stat.st_gid))

for rel, absolute, before in entries:
    st = os.lstat(absolute)
    if identity(st) != before:
        raise RuntimeError(f"release entry changed during digest: {os.fsdecode(rel)!r}")
    mode = st.st_mode
    kind = b"F" if stat.S_ISREG(mode) else b"D" if stat.S_ISDIR(mode) else b"L"
    field(kind)
    field(rel)
    field(str(stat.S_IMODE(mode)))
    field(str(st.st_uid))
    field(str(st.st_gid))
    if kind == b"F":
        field(str(st.st_size))
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(absolute, flags)
        if identity(os.fstat(fd)) != before:
            os.close(fd)
            raise RuntimeError(f"release file changed before open: {os.fsdecode(rel)!r}")
        with os.fdopen(fd, "rb", buffering=1024 * 1024) as fh:
            while chunk := fh.read(1024 * 1024):
                digest.update(chunk)
            if identity(os.fstat(fh.fileno())) != before:
                raise RuntimeError(f"release file changed while open: {os.fsdecode(rel)!r}")
    elif kind == b"L":
        field(os.readlink(absolute))
    if identity(os.lstat(absolute)) != before:
        raise RuntimeError(f"release entry changed while hashing: {os.fsdecode(rel)!r}")

# A per-entry check alone misses a new/deleted path after the directory was
# scanned or after that directory's own hash step. Re-snapshot the entire tree
# and compare the exact path/type/identity set plus the release root identity.
root_after, entries_after = snapshot_tree()
before_signature = [(rel, before) for rel, _absolute, before in entries]
after_signature = [(rel, after) for rel, _absolute, after in entries_after]
if root_after != root_before or after_signature != before_signature:
    raise RuntimeError("release tree changed during digest")

print(digest.hexdigest())
PY
}

# 远端只读 probe：物理边界、marker schema、目录名、VERSION、metadata digest 与全树
# artifact digest 一次核完。stdout 是内部 TSV，不承载人类日志。
release_marker_probe() { # <release-dir>
  local reldir="$1"
  {
    declare -f release_artifact_digest
    cat <<'REMOTE'
set -Eeuo pipefail
reldir="$1"; releases_root="$2"; schema="$3"
root_real="$(readlink -f -- "$releases_root")"
dir_real="$(readlink -f -- "$reldir")"
[[ -n "$root_real" && -n "$dir_real" && "$dir_real" == "$reldir" \
  && "$(dirname -- "$dir_real")" == "$root_real" && -d "$dir_real" && ! -L "$dir_real" ]] || {
  echo "FATAL: release 不是真实 releases-root 直系目录:$reldir" >&2; exit 1;
}
marker="$reldir/.complete"; metadata="$reldir/deploy/v5/release-metadata.json"; version="$reldir/VERSION.json"
[[ -f "$marker" && ! -L "$marker" && -f "$metadata" && ! -L "$metadata" \
  && -f "$version" && ! -L "$version" ]] || {
  echo "FATAL: release marker/metadata/VERSION 缺失或为 symlink:$reldir" >&2; exit 1;
}
read -r root_uid root_gid root_mode < <(stat -Lc '%u %g %a' -- "$reldir")
read -r marker_uid marker_gid marker_mode < <(stat -Lc '%u %g %a' -- "$marker")
[[ "$root_uid" == 0 && "$root_gid" == 0 && $((8#$root_mode & 8#22)) -eq 0 ]] || {
  echo "FATAL: release root ownership/mode 不可信:$reldir uid=$root_uid gid=$root_gid mode=$root_mode" >&2; exit 1;
}
[[ "$marker_uid" == 0 && "$marker_gid" == 0 \
  && ( "$marker_mode" == 644 || "$marker_mode" == 444 ) ]] || {
  echo "FATAL: release marker ownership/mode 不可信:$marker uid=$marker_uid gid=$marker_gid mode=$marker_mode" >&2; exit 1;
}
kind="$(jq -er --argjson schema "$schema" '
  if (.schemaVersion == $schema) then "strong"
  elif (has("schemaVersion") | not) then "legacy"
  else error("unsupported release marker schema") end
' "$marker")" || exit 1
base="$(basename -- "$reldir")"
version_commit="$(jq -er '.commit | select(type == "string")' "$version")" || exit 1
if [[ "$kind" == strong ]]; then
  row="$(jq -er --argjson schema "$schema" '
    if ((keys | sort) == (["artifactSha256","builtAt","metadataSha256","schemaVersion","sourceCommit"] | sort)
      and .schemaVersion == $schema
      and (.sourceCommit | type == "string" and test("^[0-9a-f]{40}$"))
      and (.builtAt | type == "string" and test("^[0-9]{8}-[0-9]{6}$"))
      and (.metadataSha256 | type == "string" and test("^[0-9a-f]{64}$"))
      and (.artifactSha256 | type == "string" and test("^[0-9a-f]{64}$")))
    then [.sourceCommit,.builtAt,.metadataSha256,.artifactSha256] | @tsv
    else error("invalid strong release marker") end
  ' "$marker")" || exit 1
  IFS=$'\t' read -r source_commit built_at metadata_want artifact_want <<<"$row"
  stem="${base#rel-}"; stem="${stem%-migrated}"; suffix="-$built_at"
  [[ "$base" == rel-* && "$stem" == *"$suffix" ]] || {
    echo "FATAL: strong marker builtAt 与 release dirname 不一致:$base" >&2; exit 1;
  }
  short="${stem%"$suffix"}"
  [[ "$short" =~ ^[0-9a-f]{7,40}$ && "$source_commit" == "$short"* \
    && "$version_commit" == "$short" ]] || {
    echo "FATAL: strong marker sourceCommit/dirname/VERSION 不一致:$base" >&2; exit 1;
  }
  metadata_have="$(sha256sum -- "$metadata" | cut -d' ' -f1)"
  [[ "$metadata_have" == "$metadata_want" ]] || {
    echo "FATAL: release metadata digest mismatch:$reldir" >&2; exit 1;
  }
  artifact_have="$(release_artifact_digest "$reldir")"
  [[ "$artifact_have" == "$artifact_want" ]] || {
    echo "FATAL: release artifact digest mismatch:$reldir" >&2; exit 1;
  }
  printf 'strong\t%s\t%s\t%s\t%s\n' "$source_commit" "$short" "$built_at" "$artifact_want"
else
  row="$(jq -er '
    if (((keys | sort) == (["builtAt","sha"] | sort)
        or (keys | sort) == (["builtAt","migrated","sha"] | sort))
      and (.sha | type == "string" and test("^[0-9a-f]{7,40}$"))
      and (.builtAt | type == "string" and test("^[0-9]{8}-[0-9]{6}$"))
      and ((has("migrated") | not) or .migrated == true))
    then [.sha,.builtAt] | @tsv else error("invalid legacy release marker") end
  ' "$marker")" || exit 1
  IFS=$'\t' read -r short built_at <<<"$row"
  [[ "$base" == "rel-$short-$built_at" || "$base" == "rel-$short-$built_at-migrated" ]] || {
    echo "FATAL: legacy marker sha/builtAt 与 release dirname 不一致:$base" >&2; exit 1;
  }
  [[ "$version_commit" == "$short" ]] || {
    echo "FATAL: legacy marker 与 VERSION.commit 不一致:$base" >&2; exit 1;
  }
  artifact_have="$(release_artifact_digest "$reldir")"
  [[ "$artifact_have" =~ ^[0-9a-f]{64}$ ]] || exit 1
  # Keep probe columns uniform:kind,source identity,dirname short,builtAt,artifact.
  # Legacy has no full source identity, so its validated short SHA occupies both
  # identity columns until the caller resolves it against trusted git objects.
  printf 'legacy\t%s\t%s\t%s\t%s\n' "$short" "$short" "$built_at" "$artifact_have"
fi
REMOTE
  } | ssh "$KL_HOST" bash -s -- "$reldir" "$RELEASES_ROOT" "$RELEASE_COMPLETE_SCHEMA_VERSION"
}

assert_release_metadata_matches_commit() { # <release-dir> <full-commit>
  local reldir="$1" full="$2"
  [[ "$full" =~ ^[0-9a-f]{40}$ ]] || return 1
  git -C "$REPO_ROOT" cat-file -e "${full}^{commit}" 2>/dev/null || {
    echo "✗ release sourceCommit 不在本地 trusted git object store:$full" >&2; return 1;
  }
  if ! git -C "$REPO_ROOT" show "${full}:deploy/v5/release-metadata.json" \
      | ssh "$KL_HOST" "cmp - '$reldir/deploy/v5/release-metadata.json'"; then
    echo "✗ release-metadata 原始字节不等于 trusted git $full:$reldir" >&2
    return 1
  fi
}

assert_release_marker() { # <release-dir> [master|egress legacy trust scope]
  local reldir="$1" trust_scope="${2:-master}" probe kind source short built artifact
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] 验证 release strong marker/full sourceCommit/metadata+artifact digest:$reldir"
    return 0
  fi
  probe="$(release_marker_probe "$reldir")" || {
    echo "✗ release 完整标记校验失败:$reldir" >&2; return 1;
  }
  IFS=$'\t' read -r kind source short built artifact <<<"$probe"
  case "$kind" in
    strong)
      assert_release_metadata_matches_commit "$reldir" "$source" || return 1
      ;;
    legacy)
      local trusted_path trusted_source trusted_artifact
      case "$trust_scope" in
        master)
          trusted_path="$TRUSTED_LEGACY_PREDECESSOR"
          trusted_source="$TRUSTED_LEGACY_SOURCE_COMMIT"
          trusted_artifact="$TRUSTED_LEGACY_ARTIFACT_SHA256"
          ;;
        egress)
          trusted_path="$TRUSTED_LEGACY_EGRESS_PREDECESSOR"
          trusted_source="$TRUSTED_LEGACY_EGRESS_SOURCE_COMMIT"
          trusted_artifact="$TRUSTED_LEGACY_EGRESS_ARTIFACT_SHA256"
          ;;
        *) echo "✗ legacy release trust scope 非法:$trust_scope" >&2; return 1 ;;
      esac
      [[ -n "$trusted_path" && "$reldir" == "$trusted_path" \
        && "$trusted_source" =~ ^[0-9a-f]{40}$ && "$trusted_source" == "$source"* \
        && "$trusted_artifact" =~ ^[0-9a-f]{64}$ && "$artifact" == "$trusted_artifact" ]] || {
        echo "✗ generic legacy .complete 非本 invocation 精确捕获且制品未变的 $trust_scope predecessor，拒绝:$reldir" >&2
        return 1
      }
      assert_release_metadata_matches_commit "$reldir" "$trusted_source" || return 1
      ;;
    *) echo "✗ release marker probe 返回非法 kind:${kind:-<empty>}" >&2; return 1 ;;
  esac
  echo "  ✓ release marker 校验通过(kind=$kind path=$reldir)"
}

capture_trusted_release_predecessor() { # [explicit-release-dir，仅供 hermetic test]
  local current="${1:-}" probe kind source short built artifact full
  [[ "$DRY" == 1 ]] && return 0
  if [[ -z "$current" ]]; then
    resolve_active_lane || return 1
    current="$(bg_current_release "$ACTIVE_SRC")"
  fi
  [[ -n "$current" ]] || { echo "✗ 无法在 mutation 前捕获 serving predecessor" >&2; return 1; }
  probe="$(release_marker_probe "$current")" || {
    echo "✗ serving predecessor marker/目录/VERSION 校验失败:$current" >&2; return 1;
  }
  IFS=$'\t' read -r kind source short built artifact <<<"$probe"
  CAPTURED_RELEASE_PREDECESSOR="$current"
  TRUSTED_LEGACY_PREDECESSOR=""; TRUSTED_LEGACY_SOURCE_COMMIT=""; TRUSTED_LEGACY_ARTIFACT_SHA256=""
  case "$kind" in
    strong)
      assert_release_metadata_matches_commit "$current" "$source" || return 1
      ;;
    legacy)
      full="$(git -C "$REPO_ROOT" rev-parse --verify "${source}^{commit}" 2>/dev/null || true)"
      [[ "$full" =~ ^[0-9a-f]{40}$ && "$full" == "$source"* ]] || {
        echo "✗ legacy predecessor short SHA 无法唯一解析为 trusted full commit:$source" >&2; return 1;
      }
      assert_release_metadata_matches_commit "$current" "$full" || return 1
      TRUSTED_LEGACY_PREDECESSOR="$current"
      TRUSTED_LEGACY_SOURCE_COMMIT="$full"
      TRUSTED_LEGACY_ARTIFACT_SHA256="$artifact"
      ;;
    *) echo "✗ serving predecessor marker kind 非法:${kind:-<empty>}" >&2; return 1 ;;
  esac
  echo "  ✓ 已在 deploy+mutation lock 内捕获 predecessor(kind=$kind path=$current)"
}

# Egress may intentionally lag the serving master by many releases. Capture its
# real process cwd under the same two locks, but grant this legacy pin only to
# egress activation/compensation; it is never a master rollback trust root.
capture_trusted_egress_predecessor() { # [explicit-release-dir，仅供 hermetic test]
  local current="${1:-}" probe kind source short built artifact full
  [[ "$DRY" == 1 ]] && return 0
  if [[ -z "$current" ]]; then
    current="$(ssh "$KL_HOST" "pid=\$(systemctl show -p MainPID --value '$V5_EGRESS_UNIT' 2>/dev/null || echo 0); test \"\${pid:-0}\" -gt 0 && readlink -f /proc/\$pid/cwd" 2>/dev/null || true)"
  fi
  [[ -n "$current" ]] || { echo "✗ 无法在 mutation 前捕获 egress predecessor" >&2; return 1; }
  probe="$(release_marker_probe "$current")" || {
    echo "✗ egress predecessor marker/目录/VERSION 校验失败:$current" >&2; return 1;
  }
  IFS=$'\t' read -r kind source short built artifact <<<"$probe"
  CAPTURED_EGRESS_PREDECESSOR="$current"
  TRUSTED_LEGACY_EGRESS_PREDECESSOR=""; TRUSTED_LEGACY_EGRESS_SOURCE_COMMIT=""
  TRUSTED_LEGACY_EGRESS_ARTIFACT_SHA256=""
  case "$kind" in
    strong)
      assert_release_metadata_matches_commit "$current" "$source" || return 1
      ;;
    legacy)
      full="$(git -C "$REPO_ROOT" rev-parse --verify "${source}^{commit}" 2>/dev/null || true)"
      [[ "$full" =~ ^[0-9a-f]{40}$ && "$full" == "$source"* ]] || {
        echo "✗ legacy egress predecessor short SHA 无法唯一解析:$source" >&2; return 1;
      }
      assert_release_metadata_matches_commit "$current" "$full" || return 1
      TRUSTED_LEGACY_EGRESS_PREDECESSOR="$current"
      TRUSTED_LEGACY_EGRESS_SOURCE_COMMIT="$full"
      TRUSTED_LEGACY_EGRESS_ARTIFACT_SHA256="$artifact"
      ;;
    *) echo "✗ egress predecessor marker kind 非法:${kind:-<empty>}" >&2; return 1 ;;
  esac
  echo "  ✓ 已在 deploy+mutation lock 内捕获 egress predecessor(kind=$kind path=$current)"
}

# 蓝绿前置:active slot 的 src 必须已是 symlink 布局且指向 RELEASES_ROOT 下的完整 release(否则先迁移)。
# $1=要校验的 src(默认 ACTIVE_SRC;传统 lane resolve_active_lane 后传 active slot 的 src)。
assert_bluegreen_layout() {
  local src="${1:-${ACTIVE_SRC:-$REMOTE_SRC}}"
  [[ "$DRY" == 1 ]] && { echo "  [dry-run] 断言蓝绿 symlink 布局(src=$src)"; return 0; }
  ssh "$KL_HOST" "set -e
    test -L '$src'
    t=\$(readlink -f '$src')
    case \"\$t\" in '$RELEASES_ROOT'/rel-*) : ;; *) echo '✗ $src symlink 未指向 RELEASES_ROOT/rel-*: '\"\$t\" >&2; exit 1 ;; esac
    test -f \"\$t/.complete\" || { echo '✗ current release 无 .complete 标记' >&2; exit 1; }" || {
    echo "✗ 蓝绿布局校验失败:$src 需为指向 RELEASES_ROOT/rel-* 完整 release 的 symlink。先在受控窗口跑:deploy-v5.sh --migrate-bluegreen" >&2
    exit 1
  }
}

# P0#4(Codex):offline cutover lane(stage/activate-staged/offline-recycle/prepare-offline-cutover)
# 仍按**实目录 in-place + mv 语义**操作 REMOTE_SRC,在 symlink 布局下会把 symlink 搬走/装回实目录、
# 破坏蓝绿不变量。该 lane 尚未适配蓝绿 → symlink 布局下 **fail-closed 拒绝**(不静默破坏)。
assert_not_bluegreen_for_cutover() {
  [[ "$DRY" == 1 ]] && return 0
  if ssh "$KL_HOST" "test -L '$REMOTE_SRC'"; then
    echo "✗ 蓝绿 symlink 布局下 offline cutover lane 尚未适配(会破坏布局)。该 lane 需单独迁移蓝绿(登记 playbook 债);当前 fail-closed 拒绝。" >&2
    exit 1
  fi
}

# 建不可变 release:**当前 shell 执行**(不走 command-substitution 子 shell,否则 errexit 被清、
# 失败被吞、DIST_BUILD_ID 丢,Codex P0#1),成功后**设全局 BUILT_RELEASE**,失败 return 1。
# 建到唯一 .staging-* → 完整性校验 → 写 .complete → **原子 mv -T 改名**为 rel-*(半成品永不落
# rel-* 命名空间,activate/rollback/GC 只认带 .complete 的目录,Codex P0#3)。sha 全程钉死一次
# 贯穿 archive/VERSION/dist(工作树必须干净=即该 sha,Codex P0#2)。
BUILT_RELEASE=""; BUILT_RELEASE_SOURCE_COMMIT=""

write_strong_release_marker_local() { # <release-root> <full-sha> <short-sha> <builtAt> <schema>
  local root="$1" full_sha="$2" short_sha="$3" built_at="$4" schema="$5"
  local metadata_sha artifact_sha marker_tmp root_uid root_gid root_mode marker_uid marker_gid marker_mode
  [[ "$full_sha" =~ ^[0-9a-f]{40}$ && "$short_sha" =~ ^[0-9a-f]{7,40}$ \
    && "$full_sha" == "$short_sha"* && "$built_at" =~ ^[0-9]{8}-[0-9]{6}$ \
    && "$schema" =~ ^[1-9][0-9]*$ ]] || {
    echo 'FATAL: strong release identity 参数非法' >&2; return 1;
  }
  [[ -d "$root" && ! -L "$root" ]] || { echo 'FATAL: strong release root 非法' >&2; return 1; }
  # Legacy real-directory migration may start from the historical 0775 root.
  # Normalize only the release root itself while stopped/staged, then prove the
  # trust anchor is root-owned and not group/other writable before hashing it.
  chown 0:0 -- "$root" || return 1
  chmod go-w -- "$root" || return 1
  read -r root_uid root_gid root_mode < <(stat -Lc '%u %g %a' -- "$root")
  [[ "$root_uid" == 0 && "$root_gid" == 0 && $((8#$root_mode & 8#22)) -eq 0 ]] || {
    echo "FATAL: strong release root ownership/mode 不可信:$root" >&2; return 1;
  }
  test -f "$root/package.json"
  test -d "$root/node_modules"
  test -f "$root/VERSION.json"
  test -f "$root/packages/web-react/dist/index.html"
  test -f "$root/deploy/v5/release-metadata.json"
  [[ "$(jq -er '.commit | select(type == "string")' "$root/VERSION.json")" == "$short_sha" ]] || {
    echo 'FATAL: VERSION.commit 与 pinned source short SHA 不一致' >&2; return 1;
  }
  metadata_sha="$(sha256sum -- "$root/deploy/v5/release-metadata.json" | cut -d' ' -f1)"
  artifact_sha="$(release_artifact_digest "$root")"
  [[ "$metadata_sha" =~ ^[0-9a-f]{64}$ && "$artifact_sha" =~ ^[0-9a-f]{64}$ ]] || return 1
  marker_tmp="${root}.complete.$$"
  if ! jq -n \
    --argjson schemaVersion "$schema" \
    --arg sourceCommit "$full_sha" \
    --arg builtAt "$built_at" \
    --arg metadataSha256 "$metadata_sha" \
    --arg artifactSha256 "$artifact_sha" \
    '{schemaVersion:$schemaVersion,sourceCommit:$sourceCommit,builtAt:$builtAt,
      metadataSha256:$metadataSha256,artifactSha256:$artifactSha256}' >"$marker_tmp"; then
    rm -f -- "$marker_tmp"
    return 1
  fi
  chmod 0644 "$marker_tmp" || { rm -f -- "$marker_tmp"; return 1; }
  chown 0:0 "$marker_tmp" || { rm -f -- "$marker_tmp"; return 1; }
  mv -f -- "$marker_tmp" "$root/.complete" || { rm -f -- "$marker_tmp"; return 1; }
  read -r marker_uid marker_gid marker_mode < <(stat -Lc '%u %g %a' -- "$root/.complete")
  [[ "$marker_uid" == 0 && "$marker_gid" == 0 && "$marker_mode" == 644 ]] || {
    echo "FATAL: strong release marker ownership/mode 不可信:$root/.complete" >&2; return 1;
  }
  # Re-hash after the marker is durably in place (the marker itself is excluded)
  # so a concurrent tree mutation between the first digest and publish cannot
  # create a self-consistent-looking marker that was never verified as a whole.
  [[ "$(release_artifact_digest "$root")" == "$artifact_sha" ]] || {
    echo "FATAL: strong release tree changed while publishing marker:$root" >&2; return 1;
  }
}

publish_strong_release() { # <staging> <final-dir> <full-sha> <short-sha> <builtAt>
  local staging="$1" reldir="$2" full_sha="$3" short_sha="$4" built_at="$5"
  {
    declare -f release_artifact_digest write_strong_release_marker_local
    cat <<'REMOTE'
set -Eeuo pipefail
staging="$1"; reldir="$2"; full_sha="$3"; short_sha="$4"; built_at="$5"; schema="$6"
[[ -d "$staging" && ! -L "$staging" && ! -e "$reldir" ]] || {
  echo 'FATAL: strong release staging/final path 非法' >&2; exit 1;
}
write_strong_release_marker_local "$staging" "$full_sha" "$short_sha" "$built_at" "$schema"
mv -T -- "$staging" "$reldir"
REMOTE
  } | ssh "$KL_HOST" bash -s -- \
    "$staging" "$reldir" "$full_sha" "$short_sha" "$built_at" "$RELEASE_COMPLETE_SCHEMA_VERSION"
}

# ══════════ 部署与 CI 绿的机械绑定(2026-07-26;审计 9)══════════
# 背景:`grep -n "gh run|gh api|check-runs|conclusion" scripts/deploy-v5.sh` 此前**零命中** ——
# 分支保护只管「能不能合进 canonical」,完全不管「部署的是哪个 commit」。仓内已有走 hotfix
# 分支绕过 CI 直接部署的先例(2026-07-17 kimi-k3 上线)。本门把两者机械绑定:即将被 build 成
# release 的那个 commit,其**必需** check 必须全 success,否则要显式 --allow-unverified-ci 并记账。
#
# 判定口径故意只认 required_status_checks.contexts(分支保护的权威必需集),不把可选/实验 job
# 的红当成阻断 —— 否则一个 flaky 可选 job 就能卡死正常发布。
CI_PROTECTED_BRANCH="${CI_PROTECTED_BRANCH:-feat/v5-aurora-rewrite}"
_gh_api() { env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy gh api "$@"; }
assert_ci_green_for_source_commit() { # <full sha>
  local sha="$1" required runs missing="" bad="" ctx line name status conclusion
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "✗ CI 门:source commit 非法:$sha" >&2; return 1; }
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] 校验 $sha 的 required checks(分支保护 $CI_PROTECTED_BRANCH 的 contexts)全 success"
    return 0
  fi
  # 【绝不挡住止血】dx-declared emergency containment lane 天然是「CI 还没跑完就要上」的场景,
  # 它已有更强的独立约束(canonical clean + exact HEAD + 已 push 到 origin + dx 审批证据 +
  # emergency_containment_debts 阻断后续所有普通发布)。在这里再加一道 CI 门只会把止血拦死。
  if [[ -n "$EMERGENCY_INCIDENT" ]]; then
    echo "  · dx-declared emergency containment lane:跳过 CI 绿门(止血优先;containment debt 已阻断后续普通发布)"
    return 0
  fi
  echo "── CI 绿门:$sha 的必需 check 必须全 success ──"
  local unverifiable=""
  required="$(_gh_api "repos/{owner}/{repo}/branches/$(printf '%s' "$CI_PROTECTED_BRANCH" | sed 's|/|%2F|g')/protection/required_status_checks" --jq '.contexts[]' 2>/dev/null || true)"
  if [[ -z "$required" ]]; then
    unverifiable="无法取得分支保护的 required contexts(gh 未装/未认证/无权限/网络不通)"
  else
    runs="$(_gh_api --paginate "repos/{owner}/{repo}/commits/$sha/check-runs" \
      --jq '.check_runs[] | [.name, .status, (.conclusion // "")] | @tsv' 2>/dev/null || true)"
    if [[ -z "$runs" ]]; then
      unverifiable="commit $sha 上查不到任何 check-run(未 push?未触发 CI?)"
    else
      while IFS= read -r ctx; do
        [[ -n "$ctx" ]] || continue
        line="$(awk -F'\t' -v n="$ctx" '$1==n{print; exit}' <<<"$runs")"
        if [[ -z "$line" ]]; then missing="$missing $ctx"; continue; fi
        IFS=$'\t' read -r name status conclusion <<<"$line"
        if [[ "$status" != completed ]]; then
          bad="$bad $ctx(status=$status)"
        elif [[ ! "$conclusion" =~ ^(success|skipped|neutral)$ ]]; then
          bad="$bad $ctx(conclusion=$conclusion)"
        fi
      done <<<"$required"
    fi
  fi
  if [[ -z "$unverifiable" && -z "$missing" && -z "$bad" ]]; then
    echo "  ✓ required checks 全绿($(tr '\n' ' ' <<<"$required"))"
    clear_gate_waiver ci-verification
    return 0
  fi
  echo "✗ CI 绿门未通过(commit=$sha)" >&2
  [[ -z "$unverifiable" ]] || echo "   · 证据不可得:$unverifiable" >&2
  [[ -z "$missing" ]] || echo "   · 缺失的必需 check:$missing" >&2
  [[ -z "$bad" ]] || echo "   · 未成功的必需 check:$bad" >&2
  if [[ "$ALLOW_UNVERIFIED_CI" != 1 ]]; then
    echo "   分支保护只管「合进 canonical」,不管「部署哪个 commit」—— 本门是第二道。" >&2
    echo "   先把 CI 跑绿再部署;确需带红上线(热修/CI 自身故障)用 --allow-unverified-ci(会登记 durable debt)。" >&2
    return 1
  fi
  record_gate_waiver ci-verification \
    "--allow-unverified-ci 放行未验证 CI 的 commit=$sha(${unverifiable:-未绿:${missing}${bad}})" || return 1
  echo "  ⚠ --allow-unverified-ci 已放行,债务已登记;CI 恢复后重跑一次普通发布即自动销账。" >&2
  return 0
}

# 「这次发布的源 commit」的单一权威。
#
# 2026-07-26 角色分离:此前直接取 `rev-parse HEAD`,于是 $REPO_ROOT 这棵树同时是
# (a) 所有会话共享、随 base 不断 fast-forward 的开发 checkout,和 (b) 必须钉死在 pinned
# SHA 的发布源。两个角色冲突的后果是 release queue 的 assert 必须要求 HEAD 逐字节等于
# pinned,任何人合一个 PR 就让 active job 作废并堵住唯一 active 槽(今天真实死锁一次)。
#
# 现在:有 queue job 时,发布源 = 该 job 的 **pinned canonical SHA**;没有 queue 的
# 豁免 lane 回落 HEAD(行为不变)。git archive 按任意 sha 取源、不读工作树活状态,
# 所以开发树前进不再影响"发什么"。queue 侧 assert 相应放宽为"pinned 是 HEAD 的祖先"
# —— 两处必须成对存在:只放宽 assert 而不在这里按 pinned 取源,就等于允许发出未 pin 的代码。
resolve_release_source_commit() {
  local pinned
  if [[ -n "${OC_V5_RELEASE_QUEUE_ID:-}" ]] && [[ -x "$RELEASE_QUEUE_SCRIPT" ]]; then
    pinned="$("$RELEASE_QUEUE_SCRIPT" pinned-sha --id "$OC_V5_RELEASE_QUEUE_ID" 2>/dev/null || true)"
    if [[ "$pinned" =~ ^[0-9a-f]{40}$ ]]; then
      git -C "$REPO_ROOT" cat-file -e "${pinned}^{commit}" 2>/dev/null \
        || { echo "✗ queue pinned SHA 在本地不可达:$pinned" >&2; return 1; }
      printf '%s\n' "$pinned"
      return 0
    fi
  fi
  git -C "$REPO_ROOT" rev-parse HEAD
}

build_release() {
  BUILT_RELEASE=""; BUILT_RELEASE_SOURCE_COMMIT=""; DIST_BUILD_ID=""
  local full_sha short_sha ts staging reldir cur
  full_sha="$(resolve_release_source_commit)" || return 1
  [[ -n "$full_sha" ]] || { echo "✗ 无法解析发布源 commit(空值)" >&2; return 1; }
  BUILT_RELEASE_SOURCE_COMMIT="$full_sha"
  # 审计 9:build_release 是「哪个 commit 会变成线上 release」的唯一收口点,CI 绿门挂在这里。
  assert_ci_green_for_source_commit "$full_sha" || return 1
  short_sha="$(git -C "$REPO_ROOT" rev-parse --short "$full_sha")"   # 从 full_sha 派生,不二次读 HEAD(R2#2:消两读竞态)
  ts="$(date -u +%Y%m%d-%H%M%S)"
  cur="$(bg_current_release)"
  staging="$RELEASES_ROOT/.staging-$short_sha-$$-$ts"
  reldir="$RELEASES_ROOT/rel-$short_sha-$ts"
  echo "── 建 release(staging→原子改名):$reldir(pinned $short_sha)──" >&2
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] build→$staging(archive+node_modules+dist 从 staging pinned 源构建+VERSION+.complete)→ mv -T→$reldir" >&2
    BUILT_RELEASE="$reldir"; return 0
  fi
  [[ -n "$cur" && "$cur" == "$CAPTURED_RELEASE_PREDECESSOR" ]] || {
    echo "✗ build_release 前 serving predecessor 未在持锁后精确捕获/已漂移(captured=${CAPTURED_RELEASE_PREDECESSOR:-<none>} current=${cur:-<none>})" >&2
    return 1
  }
  # 工作树非干净只是提示(archive 用 full_sha 已 pin,uncommitted 被忽略;避免"以为部署了未提交改动")
  assert_clean_source_tree
  # 远端建到 staging;任一步失败 → 清 staging + return 1(半成品不落 rel-*)
  ssh "$KL_HOST" "mkdir -p '$staging'" || { echo "✗ mkdir staging 失败" >&2; return 1; }
  if ! git -C "$REPO_ROOT" archive --format=tar "$full_sha" | ssh "$KL_HOST" "tar -x -C '$staging'"; then
    echo "✗ git archive/解包失败" >&2; ssh "$KL_HOST" "rm -rf '$staging'" 2>/dev/null; return 1; fi
  # node_modules:lock 未变且当前有 → 硬链复用;否则空目录 npm ci(不碰旧 release 硬链)
  if ! ssh "$KL_HOST" "set -e
      if [ -n '$cur' ] && [ -d '$cur/node_modules' ] && cmp -s '$staging/package-lock.json' '$cur/package-lock.json' 2>/dev/null; then
        cp -al '$cur/node_modules' '$staging/node_modules'; echo '  lock 未变 → 硬链复用 node_modules' >&2
      else
        echo '  lock 变化/无基线 → npm ci' >&2; cd '$staging' && npm ci --no-audit --no-fund >/dev/null 2>&1
      fi"; then echo "✗ node_modules 准备失败" >&2; ssh "$KL_HOST" "rm -rf '$staging'" 2>/dev/null; return 1; fi
  # dist:--with-dist 时**在 staging(archive pinned 源)上跑官方 workspace build**
  # (`tsc -b && vite build`;R2#2:不从共用工作树构建,
  # 彻底消 dist 与 archive 不同源);否则硬链继承当前 release 的 dist(前端未变)。两路 DIST_BUILD_ID
  # 都从 staging 读。
  if [[ "$WITH_DIST" == 1 ]]; then
    echo "── web official build @ staging(pinned $short_sha,不读共用工作树)──" >&2
    if ! ssh "$KL_HOST" "set -e; cd '$staging' && npm run build --workspace packages/web-react >/dev/null 2>&1"; then
      echo "✗ staging web official build 失败" >&2; ssh "$KL_HOST" "rm -rf '$staging'" 2>/dev/null; return 1; fi
  else
    if ! ssh "$KL_HOST" "set -e
        [ -n '$cur' ] && [ -d '$cur/packages/web-react/dist' ] || { echo '✗ 当前 release 无 dist 可继承' >&2; exit 1; }
        mkdir -p '$staging/packages/web-react'; rm -rf '$staging/packages/web-react/dist'; cp -al '$cur/packages/web-react/dist' '$staging/packages/web-react/dist'"; then
      echo "✗ dist 继承失败" >&2; ssh "$KL_HOST" "rm -rf '$staging'" 2>/dev/null; return 1; fi
  fi
  DIST_BUILD_ID="$(ssh "$KL_HOST" "grep -o 'name=\"oc-build\" content=\"[0-9a-f]\\{8,32\\}\"' '$staging/packages/web-react/dist/index.html' 2>/dev/null | grep -o '[0-9a-f]\\{8,32\\}' | head -1" 2>/dev/null || true)"
  [[ -n "$DIST_BUILD_ID" ]] || { echo "✗ staging dist 缺 oc-build meta" >&2; ssh "$KL_HOST" "rm -rf '$staging'" 2>/dev/null; return 1; }
  # VERSION(钉死 short_sha)；所有 npm/vite/dist 步骤完成后才收紧 baseline，随后用
  # 当前 checkout 的可信 guard 做最终只读复验。guard 失败时 staging 必须清掉，绝不能
  # 写 .complete 或进入 rel-* 命名空间。
  if ! write_version "$staging" "$short_sha" >&2; then ssh "$KL_HOST" "rm -rf '$staging'" 2>/dev/null; return 1; fi
  if ! harden_release_baseline "$staging"; then
    echo "✗ staging CCB baseline hardening/validation 失败" >&2
    ssh "$KL_HOST" "rm -rf '$staging'" 2>/dev/null
    return 1
  fi
  # 完整性校验 + strong .complete(full source/metadata/tree digests) + 原子改名。
  if ! publish_strong_release "$staging" "$reldir" "$full_sha" "$short_sha" "$ts"; then
    echo "✗ 完整性校验/原子改名失败" >&2; ssh "$KL_HOST" "rm -rf '$staging'" 2>/dev/null; return 1; fi
  BUILT_RELEASE="$reldir"
  echo "  ✓ release 就绪(带 .complete):$reldir" >&2
}

# sessions-store-pg 割接后的 capability 门(RFC-v5-sessions-pg §D4,R2 MAJOR#5)。
# 会话权威割接到 PG 后,PG 即唯一权威。此时激活/回滚只能翻到**声明 sessions-store-pg-v1
# capability 的 release**;旧蓝绿目录里割接前的老 release 缺 PG sessions backend,一次普通
# rollback 误启它 → master 以 SQLite 语义起(拒起或权威分叉)。
#
# "已割接"判定 = (远端 env OC_SESSIONS_STORE=pg) OR (远端本地权威 manifest 存在且
# authority=pg_authoritative)。env 与 manifest 是 PG 权威的两个独立信号:割接窗先写 PG 状态行 +
# manifest(双写),再补 env=pg;env 同步可能滞后,若只看 env 会在"manifest 已 pg_authoritative 但
# env 尚未同步"的窗口误放行无 cap 的老 release。故两者任一成立即要求 cap。
#
# 不确定即拒(fail-closed):仅"env≠pg 且 manifest 确认不存在"= 未割接(基建先行期)才放行任意 release;
# ssh 探测失败(连不上)= 无法判定 → 拒绝激活。用 ssh 退出码区分"文件不存在(远端明确回报)"与
# "探测本身失败(传输错误)":单次 ssh 内 [ -f manifest ] 判存在并回传 authority,remote 恒以 printf
# 收尾(exit 0),故 ssh rc≠0 只可能是传输失败。
assert_release_capability_for_sessions_pg() {
  local reldir="$1" store home manifest probe rc has cutover_done=0
  [[ "$DRY" == 1 ]] && { echo "  [dry-run] 跳过 sessions-store-pg capability 门"; return 0; }
  # 读远端 master env 的实际生效值(与 assert_runtime_channel_column 同法 source env 文件)。
  store="$(ssh "$KL_HOST" "set -a; . '$V5_ENV' 2>/dev/null; printf '%s' \"\${OC_SESSIONS_STORE:-}\"" 2>/dev/null | tr -d '[:space:]')"
  if [[ "$store" == "pg" ]]; then
    cutover_done=1
  else
    # env≠pg:从远端 env 推导 OPENCLAUDE_HOME(默认 $V5_HOME),拼 manifest 路径再探。
    home="$(ssh "$KL_HOST" "set -a; . '$V5_ENV' 2>/dev/null; printf '%s' \"\${OPENCLAUDE_HOME:-$V5_HOME}\"" 2>/dev/null | tr -d '[:space:]')"
    [[ -n "$home" ]] || home="$V5_HOME"
    manifest="$home/sessions-store-authority.json"
    # 单次 ssh 回传"文件是否存在 + authority";remote 恒以 printf 收尾(exit 0),ssh rc≠0=传输失败。
    # 用 if 捕获退出码(set -e 下命令替换失败会误杀脚本;if 条件豁免 set -e)。
    if probe="$(ssh "$KL_HOST" "if [ -f '$manifest' ]; then printf 'EXISTS:'; jq -r '.authority // empty' '$manifest' 2>/dev/null || true; else printf 'ABSENT:'; fi")"; then rc=0; else rc=$?; fi
    if [[ $rc -ne 0 ]]; then
      echo "✗ 激活中止:无法探测远端 sessions manifest(ssh 探测失败 rc=$rc):$manifest" >&2
      echo "  且 OC_SESSIONS_STORE≠pg → 无法判定会话权威是否已割接到 PG。" >&2
      echo "  fail-closed 拒绝激活(不确定即拒);请确认 $KL_HOST 可达 / 割接状态后重试。" >&2
      exit 1
    fi
    probe="$(printf '%s' "$probe" | tr -d '[:space:]')"   # 归一化 jq 输出末尾换行
    case "$probe" in
      ABSENT:)
        echo "  ✓ capability 门:OC_SESSIONS_STORE≠pg 且远端无 sessions manifest(未割接,基建先行期),放行任意 release。"
        return 0 ;;
      EXISTS:pg_authoritative)
        cutover_done=1
        echo "  · 远端 manifest.authority=pg_authoritative(会话权威已在 PG)→ 要求 capability。" ;;
      EXISTS:*)
        # manifest 存在但 authority≠pg_authoritative(prepared / sqlite_disaster_recovered / 空 / 异常)。
        # 权威链已进入 PG 生命周期,回退到无 PG backend 的 release 会拒起 / 分叉 → fail-closed 要求 cap。
        cutover_done=1
        echo "  · 远端 manifest 存在但 authority='${probe#EXISTS:}'≠pg_authoritative(割接生命周期中/异常态)→ fail-closed 要求 capability。" ;;
    esac
  fi

  [[ "$cutover_done" == 1 ]] || return 0
  has="$(ssh "$KL_HOST" "jq -r '(.capabilities // []) | index(\"sessions-store-pg-v1\") // empty' '$reldir/deploy/v5/release-metadata.json' 2>/dev/null" 2>/dev/null | tr -d '[:space:]')"
  if [[ -z "$has" ]]; then
    echo "✗ 激活中止:会话权威已割接到 PG(env=pg 或 manifest.authority=pg_authoritative),但目标 release 未声明 capability 'sessions-store-pg-v1':" >&2
    echo "    $reldir/deploy/v5/release-metadata.json" >&2
    echo "  该 release 缺 PG sessions backend,激活会让 master 以 SQLite 语义起(拒起或权威分叉)。" >&2
    echo "  回滚只能翻到同样声明该 capability 的前序 release;禁止回退到 PG 割接前的旧 release。" >&2
    exit 1
  fi
  echo "  ✓ capability 门:目标 release 声明 sessions-store-pg-v1(已割接前置满足)。"
}

# Lossless turn-tape compatibility floor. A finalized v2 tape is represented
# in client_sessions by a textless constant-size anchor; an older master would
# return that anchor verbatim and make an already-paid reply disappear after
# login. Likewise, an older runtime would resume lossy v1 writes. Therefore the
# first finalized tape makes reader+writer capability irreversible.
LOSSLESS_TURN_TAPE_CAP="lossless-turn-tape-v2"
LOSSLESS_RUNTIME_BATCH_CAP="lossless-turn-runtime-batch-v1"
LOSSLESS_RUNTIME_BATCH_ENV="LOSSLESS_TURN_TAPE_RUNTIME_BATCHING"
DIRECT_TURN_TIMELINE_CAP="direct-turn-timeline-v1"
WEB_STORAGE_ROLLBACK_CAP="web-storage-rollback-safe-v1"

# Browser-local schema changes outlive a release rollback. The bridge release
# keeps the monolithic session DB versionless and moves the dispatch journal to
# a separate DB. After two bridge generations are both in the official
# active/previous lineage, never activate an older frontend that explicitly
# opens the session DB at a lower version.
probe_release_web_storage_rollback_capability() { # $1=release; 0=present,1=absent,2=unknown
  local reldir="$1" result="" rc=0
  if result="$(ssh "$KL_HOST" "set -e
      metadata='$reldir/deploy/v5/release-metadata.json'
      [ -r \"\$metadata\" ]
      jq -er --arg c '$WEB_STORAGE_ROLLBACK_CAP' '(.capabilities // []) as \$caps
        | if (\$caps | type) != \"array\" then error(\"capabilities must be an array\")
          elif ((\$caps | index(\$c)) != null) then \"capable\"
          else \"incapable\"
          end' \"\$metadata\"" 2>/dev/null)"; then
    rc=0
  else
    rc=$?
  fi
  result="$(printf '%s' "$result" | tr -d '[:space:]')"
  [[ $rc -eq 0 ]] || return 2
  case "$result" in
    capable) return 0 ;;
    incapable) return 1 ;;
    *) return 2 ;;
  esac
}

assert_web_storage_rollback_transition() { # $1=current $2=official previous $3=target $4=context
  local current="$1" previous="$2" target="$3" context="${4:-activation}"
  local current_rc=0 previous_rc=1 target_rc=0
  [[ "$DRY" == 1 ]] && {
    echo "  [dry-run] 跳过 browser storage rollback 地板($context)"
    return 0
  }
  probe_release_web_storage_rollback_capability "$current" || current_rc=$?
  if [[ -n "$previous" ]]; then
    previous_rc=0
    probe_release_web_storage_rollback_capability "$previous" || previous_rc=$?
  fi
  probe_release_web_storage_rollback_capability "$target" || target_rc=$?
  if [[ $current_rc -eq 2 || $previous_rc -eq 2 || $target_rc -eq 2 ]]; then
    echo "✗ $context 无法核验 $WEB_STORAGE_ROLLBACK_CAP(current=$current_rc previous=$previous_rc target=$target_rc),fail-closed。" >&2
    return 1
  fi
  if [[ $current_rc -eq 0 && $previous_rc -eq 0 ]]; then
    if [[ $target_rc -ne 0 ]]; then
      echo "✗ $context 拒绝 browser storage 代际降级:active+previous 已建立安全地板，目标缺 '$WEB_STORAGE_ROLLBACK_CAP':$target" >&2
      return 1
    fi
    echo "  ✓ browser storage rollback 地板:active/previous/target 均兼容。"
    return 0
  fi
  echo "  · browser storage bridge 地板尚未建立(active_rc=$current_rc previous_rc=$previous_rc)；保留首轮官方回退路径。"
}

# A direct-timeline master records verified failures only in turn_dispatches
# and serves immutable process rows directly from the tape. A projection-era
# master cannot display failures created after that switch, so mixed masters or
# rollback after the new reader/writer may serve would restore the broken UX.
# First adoption is therefore single-master and this floor is irreversible.
probe_release_direct_turn_timeline() { # $1=release; 0=present,1=absent,2=unknown
  local reldir="$1" result="" rc=0
  if result="$(ssh "$KL_HOST" "set -e
      metadata='$reldir/deploy/v5/release-metadata.json'
      [ -r \"\$metadata\" ]
      jq -er --arg c '$DIRECT_TURN_TIMELINE_CAP' '(.capabilities // []) as \$caps
        | if (\$caps | type) != \"array\" then error(\"capabilities must be an array\")
          elif ((\$caps | index(\$c)) != null) then \"capable\"
          else \"incapable\"
          end' \"\$metadata\"" 2>/dev/null)"; then
    rc=0
  else
    rc=$?
  fi
  result="$(printf '%s' "$result" | tr -d '[:space:]')"
  [[ $rc -eq 0 ]] || return 2
  case "$result" in
    capable) return 0 ;;
    incapable) return 1 ;;
    *) return 2 ;;
  esac
}

assert_direct_turn_timeline_pair() { # $1=live $2=target $3=context
  local live="$1" target="$2" context="${3:-transition}" live_rc=0 target_rc=0
  probe_release_direct_turn_timeline "$live" || live_rc=$?
  probe_release_direct_turn_timeline "$target" || target_rc=$?
  if [[ $live_rc -eq 2 || $target_rc -eq 2 ]]; then
    echo "✗ $context 无法核验 $DIRECT_TURN_TIMELINE_CAP(live_rc=$live_rc target_rc=$target_rc),fail-closed。" >&2
    return 1
  fi
  if [[ $live_rc -ne $target_rc ]]; then
    echo "✗ $context 的 live/target direct timeline 代际不一致；禁止双 master 或自动 saga 回切(live_rc=$live_rc target_rc=$target_rc)。" >&2
    return 1
  fi
  echo "  ✓ $context 的 live/target direct timeline 代际一致。"
}

assert_direct_turn_timeline_offline_target() { # $1=target $2=previous; caller proved master inactive
  prepare_direct_turn_timeline_activation "$1" "$2"
}

prepare_direct_turn_timeline_activation() { # $1=target $2=current
  local target="$1" current="$2" target_rc=0 current_rc=0
  probe_release_direct_turn_timeline "$target" || target_rc=$?
  case "$target_rc" in
    0) return 0 ;;
    2)
      echo "✗ 目标 release 的 $DIRECT_TURN_TIMELINE_CAP 状态不可核验:$target" >&2
      return 1 ;;
  esac
  probe_release_direct_turn_timeline "$current" || current_rc=$?
  [[ $current_rc -eq 1 ]] && return 0
  echo "✗ 拒绝不可逆 direct turn timeline 降级:current_rc=$current_rc；旧 master 无法显示新 direct 状态（即使当前没有失败行也存在首写竞态）。" >&2
  return 1
}

# Tri-state artifact probe. Return codes are part of the safety contract:
#   0 = capability is explicitly present
#   1 = immutable metadata was read successfully and explicitly lacks it
#   2 = transport/read/parse/output failure, so capability is unknown
# Missing/unreadable/malformed metadata is unknown (2); only a successfully
# parsed artifact that lacks the token is definitive absence (1). Callers that
# decide whether a writer may have served MUST treat 2 like 0; collapsing both
# to false re-opens a fail-open compensation path.
probe_release_lossless_capability_field() {  # $1=release $2=capabilities|runtimeCapabilities
  local reldir="$1" field="$2" result="" rc=0
  [[ "$field" == capabilities || "$field" == runtimeCapabilities ]] || return 2
  if result="$(ssh "$KL_HOST" "set -e
      metadata='$reldir/deploy/v5/release-metadata.json'
      [ -r \"\$metadata\" ]
      jq -er --arg c '$LOSSLESS_TURN_TAPE_CAP' '(.$field // []) as \$caps
        | if (\$caps | type) != \"array\" then error(\"capability field must be an array\")
          elif ((\$caps | index(\$c)) != null) then \"capable\"
          else \"incapable\"
          end' \"\$metadata\"" 2>/dev/null)"; then
    rc=0
  else
    rc=$?
  fi
  result="$(printf '%s' "$result" | tr -d '[:space:]')"
  [[ $rc -eq 0 ]] || return 2
  case "$result" in
    capable) return 0 ;;
    incapable) return 1 ;;
    *) return 2 ;;
  esac
}

probe_release_lossless_master_capability() {
  probe_release_lossless_capability_field "$1" capabilities
}

probe_release_lossless_runtime_capability() {
  probe_release_lossless_capability_field "$1" runtimeCapabilities
}

# Compressed runtime-event rows are a master-only storage format. Keep their
# declaration separate from the container v2 wire capability so an older
# master cannot pass the floor merely because it understands tape uploads.
probe_release_lossless_runtime_batch_capability() {
  local reldir="$1" result="" rc=0
  if result="$(ssh "$KL_HOST" "set -e
      metadata='$reldir/deploy/v5/release-metadata.json'
      [ -r \"\$metadata\" ]
      jq -er --arg c '$LOSSLESS_RUNTIME_BATCH_CAP' '(.capabilities // []) as \$caps
        | if (\$caps | type) != \"array\" then error(\"capability field must be an array\")
          elif ((\$caps | index(\$c)) != null) then \"capable\"
          else \"incapable\"
          end' \"\$metadata\"" 2>/dev/null)"; then
    rc=0
  else
    rc=$?
  fi
  result="$(printf '%s' "$result" | tr -d '[:space:]')"
  [[ $rc -eq 0 ]] || return 2
  case "$result" in
    capable) return 0 ;;
    incapable) return 1 ;;
    *) return 2 ;;
  esac
}

assert_lossless_runtime_batch_capability() {
  local reldir="$1" rc=0
  probe_release_lossless_runtime_batch_capability "$reldir" || rc=$?
  if [[ $rc -eq 0 ]]; then return 0; fi
  if [[ $rc -eq 2 ]]; then
    echo "✗ 目标 master release 的 runtime-batch capability 状态不可核验(探测失败):" >&2
  else
    echo "✗ 目标 master release 未声明 reader capability '$LOSSLESS_RUNTIME_BATCH_CAP':" >&2
  fi
  echo "    $reldir/deploy/v5/release-metadata.json" >&2
  return 1
}

# Tri-state storage floor. The explicit opt-in closes the first-write race;
# any format-3 pin keeps the floor irreversible after the flag is ever removed
# or an env file is restored, including an unfinalized tape that must resume
# with the same writer format. 0=armed, 1=definitively inactive,
# 2=unknown (production callers fail closed).
probe_lossless_runtime_batch_floor() {
  local state="" rc=0
  if state="$(ssh "$KL_HOST" "test -r '$V5_ENV' || exit 20
      set -a; . '$V5_ENV' 2>/dev/null || exit 21
      case \"\${$LOSSLESS_RUNTIME_BATCH_ENV:-}\" in 1|true|TRUE|on|ON) printf true; exit 0 ;; esac
      test -n \"\${DATABASE_URL:-}\" || exit 22
      psql \"\$DATABASE_URL\" -X -v ON_ERROR_STOP=1 -tAc \"SELECT EXISTS (
        SELECT 1 FROM client_session_turn_tapes
         WHERE record_storage_format >= 3
      )::text\"" 2>/dev/null)"; then
    rc=0
  else
    rc=$?
  fi
  state="$(printf '%s' "$state" | tr -d '[:space:]')"
  if [[ $rc -eq 0 && "$state" == true ]]; then return 0; fi
  if [[ $rc -eq 0 && "$state" == false ]]; then return 1; fi
  return 2
}

assert_lossless_runtime_batch_floor() {
  local reldir="$1" rc=0
  probe_lossless_runtime_batch_floor || rc=$?
  if [[ $rc -eq 1 ]]; then
    echo "  · runtime-event batch 地板尚未启用且无 format-3 tape。"
    return 0
  fi
  if [[ $rc -eq 2 ]]; then
    echo "  · runtime-event batch 地板状态不可核验 → 对旧 master fail-closed。" >&2
  else
    echo "  · runtime-event batch 地板生效(opt-in 已开或已有 format-3 tape)。"
  fi
  assert_lossless_runtime_batch_capability "$reldir" || return 1
  echo "  ✓ runtime-event batch 地板:目标 master 声明 $LOSSLESS_RUNTIME_BATCH_CAP。"
}

# True when a candidate may have accepted v2 writes. Only a successfully read
# explicit absence proves it could not; probe failure is conservatively armed.
lossless_release_may_have_served() {
  local rc=0
  probe_release_lossless_master_capability "$1" || rc=$?
  [[ $rc -ne 1 ]]
}

assert_lossless_master_release_capability() {
  local reldir="$1" rc=0
  probe_release_lossless_master_capability "$reldir" || rc=$?
  if [[ $rc -eq 0 ]]; then return 0; fi
  if [[ $rc -eq 2 ]]; then
    echo "✗ 目标 master release 的 lossless capability 状态不可核验(探测失败):" >&2
  else
    echo "✗ 目标 master release 未声明 reader capability '$LOSSLESS_TURN_TAPE_CAP':" >&2
  fi
  echo "    $reldir/deploy/v5/release-metadata.json" >&2
  return 1
}

assert_lossless_release_capability() {
  local reldir="$1" master_rc=0 runtime_rc=0
  probe_release_lossless_master_capability "$reldir" || master_rc=$?
  probe_release_lossless_runtime_capability "$reldir" || runtime_rc=$?
  if [[ $master_rc -ne 0 || $runtime_rc -ne 0 ]]; then
    if [[ $master_rc -eq 2 || $runtime_rc -eq 2 ]]; then
      echo "✗ 目标 release 的 lossless reader/writer capability 状态不可核验(探测失败):" >&2
    else
      echo "✗ 目标 release 未同时声明 reader/writer capability '$LOSSLESS_TURN_TAPE_CAP':" >&2
    fi
    echo "    $reldir/deploy/v5/release-metadata.json" >&2
    echo "  finalized tape 的 hot row 只有 textless anchor;旧 master 重登会丢回复,旧 runtime 会恢复有损写入。" >&2
    return 1
  fi
  return 0
}

# Close the explicit-rollback check-then-first-write race. When the live master
# is capable (or its declaration cannot be read), a concurrent turn may finalize
# immediately after any DB floor query. Therefore prove the rollback target
# reader and the actual target runtime tuple unconditionally, before maintenance
# or any symlink/env/state mutation. Only a successfully read legacy live master
# can use the DB floor alone: it cannot finalize v2 concurrently.
assert_lossless_explicit_rollback_target() {  # $1=live master $2=target master $3=image id $4=runtime release
  local live_master="$1" target_master="$2" image_id="$3" runtime_release="$4" live_rc=0
  assert_lossless_runtime_batch_floor "$target_master" || return 1
  probe_release_lossless_master_capability "$live_master" || live_rc=$?
  if [[ $live_rc -eq 1 ]]; then
    echo "  · 当前 master 明确不具备 $LOSSLESS_TURN_TAPE_CAP；显式回滚继续由 finalized tape 地板裁决。"
    return 0
  fi
  if [[ $live_rc -eq 2 ]]; then
    echo "  · 当前 master capability 不可核验 → 按可能正在写 v2 tape fail-closed。" >&2
  else
    echo "  · 当前 master 已具备 $LOSSLESS_TURN_TAPE_CAP → 回滚目标须无条件兼容。"
  fi
  assert_lossless_master_release_capability "$target_master" || return 1
  assert_lossless_runtime_tuple_capability "$image_id" "$runtime_release" || return 1
  echo "  ✓ 显式回滚目标 master/runtime 均具备 $LOSSLESS_TURN_TAPE_CAP(不查询 DB,无首写竞态)。"
}

assert_lossless_turn_tape_floor() {
  local reldir="$1" finalized rc
  [[ "$DRY" == 1 ]] && { echo "  [dry-run] 跳过 lossless turn-tape 兼容地板"; return 0; }
  assert_lossless_runtime_batch_floor "$reldir" || exit 1
  if finalized="$(ssh "$KL_HOST" "set -a; . '$V5_ENV' 2>/dev/null
      test -n \"\${DATABASE_URL:-}\"
      psql \"\$DATABASE_URL\" -X -v ON_ERROR_STOP=1 -tAc \"SELECT EXISTS (SELECT 1 FROM client_session_turn_tapes WHERE finalized_at IS NOT NULL)::text\"" 2>/dev/null)"; then
    rc=0
  else
    rc=$?
  fi
  finalized="$(printf '%s' "$finalized" | tr -d '[:space:]')"
  if [[ $rc -eq 0 && "$finalized" == "false" ]]; then
    echo "  · lossless turn-tape 地板:尚无 finalized v2 tape,暂不设限。"
    return 0
  fi
  if [[ $rc -ne 0 || "$finalized" != "true" ]]; then
    echo "  · lossless turn-tape 状态不可核验(rc=$rc result=${finalized:-<empty>})→ 对旧目标 fail-closed。"
  else
    echo "  · lossless turn-tape 地板生效:已存在 finalized v2 tape。"
  fi
  if ! assert_lossless_release_capability "$reldir"; then
    echo "  数据库不可读时也只允许激活明确具备该 capability 的目标。" >&2
    exit 1
  fi
  echo "  ✓ lossless turn-tape 地板:目标 release reader+writer 均声明 $LOSSLESS_TURN_TAPE_CAP。"
}

# 核验**实际** runtime tuple，而不是仅看 master release metadata 里的期望声明。
# release 非空读其 MANIFEST；空 release 读 immutable image label。
assert_lossless_runtime_tuple_capability() {
  local image_id="$1" release="$2"
  [[ "$DRY" == 1 ]] && { echo "  [dry-run] 核验实际 runtime tuple 声明 $LOSSLESS_TURN_TAPE_CAP"; return 0; }
  hotcfg_rmt oc_hotcfg_assert_tuple_lossless_capability "$image_id" "$release" \
    || { echo "✗ 实际 runtime tuple 未证明 capability '$LOSSLESS_TURN_TAPE_CAP'(image_id=${image_id:-<none>} release=${release:-<embedded>})" >&2; return 1; }
  echo "  ✓ 实际 runtime tuple 声明 $LOSSLESS_TURN_TAPE_CAP。"
}

# 仅在首个 finalized tape 后要求实际 tuple；DB 不可读由 runtime lib fail-closed。
assert_lossless_runtime_tuple_floor() {
  local image_id="$1" release="$2"
  [[ "$DRY" == 1 ]] && { echo "  [dry-run] 核验实际 runtime tuple 的 lossless 不可逆地板"; return 0; }
  hotcfg_rmt oc_hotcfg_assert_tuple_lossless_floor "$image_id" "$release" \
    || { echo "✗ lossless 不可逆地板拒绝实际 runtime tuple(image_id=${image_id:-<none>} release=${release:-<embedded>})" >&2; return 1; }
}

# Canary 一旦可见，candidate 可能接受由 lossless runtime 产生的 v2 tape。为消除
# “查询时尚无 tape → candidate 写入首条 → abort 回旧 reader”的竞态，READY 前无条件
# 要求 active/candidate 两个 master release 及其 runtime 声明都具备 capability，并核验
# 当前真实 runtime tuple。首批引入该协议应走原子全量 deploy，不能拿旧 active 做 canary。
assert_lossless_canary_pair() {
  local active_rel="$1" candidate_rel="$2" rel kind has image_id runtime_release
  [[ "$DRY" == 1 ]] && { echo "  [dry-run] 核验 active+candidate master/runtime 与实际 tuple 的 lossless capability"; return 0; }
  assert_lossless_runtime_batch_floor "$active_rel" || return 1
  assert_lossless_runtime_batch_floor "$candidate_rel" || return 1
  for rel in "$active_rel" "$candidate_rel"; do
    for kind in capabilities runtimeCapabilities; do
      has="$(ssh "$KL_HOST" "jq -r --arg c '$LOSSLESS_TURN_TAPE_CAP' '(.${kind} // []) | index(\$c) // empty' '$rel/deploy/v5/release-metadata.json' 2>/dev/null" 2>/dev/null | tr -d '[:space:]')"
      [[ -n "$has" ]] || {
        echo "✗ canary 拒绝:$rel 的 $kind 未声明 '$LOSSLESS_TURN_TAPE_CAP'。首批协议升级须先走原子全量 deploy。" >&2
        return 1
      }
    done
  done
  image_id="$(remote_env_get OC_RUNTIME_IMAGE_ID)"
  runtime_release="$(remote_env_get OC_RUNTIME_RELEASE)"
  assert_lossless_runtime_tuple_capability "$image_id" "$runtime_release" || return 1
  echo "  ✓ canary active/candidate reader+writer 与实际 runtime tuple 均具备 lossless capability。"
}

# ═════════════════ 模型权威:四面 capability 守卫(方案 §7 步 4/5,R3-B4 + R4-M2)═════════════
#
# 四面 = {DB schema, master, egress, 容器 runtime}。判定单点化后 master 签发签名 execution
# descriptor、容器验签消费、egress 每请求 epoch fence —— 任一面回到 legacy/baked 判定 =
# 判定源分叉(签发的人与执行的人不同源),轻则模型不可用,重则按已撤销的价格/能力执行。
#
# 两个不同强度的门:
#   ① **preflight**(开 flag / 走 cutover 前):四面**活体**全绿才允许 —— 活体证据来自
#      /healthz.runtime.capabilities(master)、egress-health.capabilities(egress)、
#      schema_migrations(DB)、env tuple 指向的 release MANIFEST / 镜像 label(容器)。
#   ② **地板**(cutover marker 置位后,不可逆):**每一次**激活/回滚都要求目标制品声明
#      capability —— master release 看 deploy/v5/release-metadata.json;容器 tuple 由
#      v5-runtime-release-lib.sh 的 assert_tuple_viable ③ 覆盖(release MANIFEST / 镜像 label)。
#      egress 与 master 同源同树(同一 release symlink),故 master release 的声明同时覆盖
#      egress 制品面;egress **进程**是否真的带上了新代码,由 smoke 的活体断言兜底。
#
# marker 双源(env 键 + DB 单行):env 让 DB 不可达时也能判定地板已生效,DB 让主机重建/DR 后
# marker 不丢(它和它保护的 model_catalog 同库同命运)。任一为真即地板生效(OR)。
MODEL_AUTHORITY_CAP="model_authority_v1"
MODEL_AUTHORITY_EGRESS_CAP="model_authority_v1-egress"
MODEL_AUTHORITY_CUTOVER_KEY="OC_MODEL_AUTHORITY_CUTOVER"
MODEL_AUTHORITY_FLAG_KEY="OC_MODEL_AUTHORITY"
MODEL_AUTHORITY_PROVISION_FLAG_KEY="OC_MODEL_AUTHORITY_PROVISION_REQUIRED"
MODEL_AUTHORITY_CATALOG_MIGRATION="0143_model_catalog"
MODEL_AUTHORITY_GUARDS_MIGRATION="0144_model_authority_guards"
MODEL_AUTHORITY_SETTING_KEY="cutover"
MODEL_AUTHORITY_OBSERVATION_KEY="observation"
MODEL_AUTHORITY_CANARY_MODEL="oc-catalog-canary-glm52"
MODEL_AUTHORITY_CANARY_ALIAS="oc-catalog-canary"
MODEL_AUTHORITY_MIN_OBSERVE_SECONDS=900
MODEL_AUTHORITY_MIN_REQUESTS=10
# long-turn rollout 证据:同一 lease 须有一条短 authority TTL 内的早期请求，且 5min 后
# 仍有另一条请求通过 egress 验签并提交。前者须与 protocol AUTHORITY_TTL_MS(120s)同步。
MODEL_AUTHORITY_EARLY_REQUEST_MAX_MS=120000
MODEL_AUTHORITY_LONG_TURN_MIN_MS=300000

# 远端 env 取键值(末行为准,与 hotcfg env_get 同法)。缺失 → 空。
remote_env_get() {
  ssh "$KL_HOST" "grep -E '^[[:space:]]*$1=' '$V5_ENV' 2>/dev/null | tail -n1 | cut -d= -f2-" 2>/dev/null | tr -d '[:space:]' || true
}

# 远端 env 原子写单键(备份 + tmp + mv;值只允许 [0-9A-Za-z_.-])。
remote_env_set() {
  local key="$1" val="$2"
  [[ "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]] || { echo "✗ remote_env_set: 非法键 '$key'" >&2; return 1; }
  [[ "$val" =~ ^[0-9A-Za-z_.-]*$ ]] || { echo "✗ remote_env_set: 非法值 '$val'" >&2; return 1; }
  ssh "$KL_HOST" "set -Eeuo pipefail
    ts=\$(date -u +%Y%m%d%H%M%S)
    cp -a '$V5_ENV' '$V5_ENV.bak-\$ts'
    tmp='$V5_ENV.keyset.\$\$'
    cp -a '$V5_ENV' \"\$tmp\"
    if grep -Eq '^[[:space:]]*$key=' \"\$tmp\"; then
      sed -i 's|^[[:space:]]*$key=.*|$key=$val|' \"\$tmp\"
    else
      printf '%s=%s\n' '$key' '$val' >> \"\$tmp\"
    fi
    chmod --reference='$V5_ENV' \"\$tmp\" 2>/dev/null || true
    mv -f \"\$tmp\" '$V5_ENV'" || { echo "✗ 写 env 键 $key 失败" >&2; return 1; }
  echo "  ✓ env $key=$val(已备份 $V5_ENV.bak-<ts>)"
}

# 模型权威 DB 三角色。任何 URL 缺失都 fail-closed，绝不回退 DATABASE_URL/owner。
remote_model_authority_psql_as() {
  local url_var="$1" sql="$2"
  ssh "$KL_HOST" "set -a; . '$V5_ENV' 2>/dev/null
    name='$url_var'; url=\"\${!name:-}\"; test -n \"\$url\"
    psql \"\$url\" -X -v ON_ERROR_STOP=1 -tAc \"$sql\"" 2>/dev/null | tr -d '[:space:]'
}

remote_model_authority_psql() {
  remote_model_authority_psql_as MODEL_AUTHORITY_DEPLOY_DATABASE_URL "$1"
}

remote_model_authority_psql_app() {
  remote_model_authority_psql_as DATABASE_URL "$1"
}

remote_model_authority_psql_admin() {
  remote_model_authority_psql_as MODEL_CATALOG_ADMIN_DATABASE_URL "$1"
}

remote_model_authority_psql_script() {
  ssh "$KL_HOST" "set -a; . '$V5_ENV' 2>/dev/null
    test -n \"\${MODEL_AUTHORITY_DEPLOY_DATABASE_URL:-}\"
    psql \"\$MODEL_AUTHORITY_DEPLOY_DATABASE_URL\" -X -v ON_ERROR_STOP=1 -q"
}

model_authority_release_sha() {
  local sha
  [[ "$ACTIVE_STATE_LOADED" == 1 ]] || assert_no_rollout_in_progress || return 1
  sha="$(ssh "$KL_HOST" "jq -er '.commit' '$ACTIVE_SRC/VERSION.json'" 2>/dev/null || true)"
  [[ "$sha" =~ ^[0-9a-f]{7,40}$ ]] || {
    echo "✗ 无法从 live VERSION.json 取得 release sha(实收 '${sha:-<empty>}')" >&2
    return 1
  }
  printf '%s' "$sha"
}

model_authority_runtime_tuple() {
  jq -cn \
    --arg image "$(remote_env_get OC_RUNTIME_IMAGE)" \
    --arg image_id "$(remote_env_get OC_RUNTIME_IMAGE_ID)" \
    --arg release "$(remote_env_get OC_RUNTIME_RELEASE)" \
    --arg bundle "$(remote_env_get OC_PLATFORM_BUNDLE)" \
    '{image:$image,image_id:$image_id,release:$release,bundle:$bundle}'
}

model_authority_b64() { printf '%s' "$1" | base64 -w0; }

# release 制品声明的 capabilities(空格分隔)。文件缺失/无法解析 → 非 0(fail-closed)。
release_declared_caps() {
  local reldir="$1"
  ssh "$KL_HOST" "jq -er '(.capabilities // []) | join(\" \")' '$reldir/deploy/v5/release-metadata.json'" 2>/dev/null
}

caps_contain() { case " $1 " in *" $2 "*) return 0 ;; *) return 1 ;; esac; }

# DB 面就绪不只看 schema_migrations 记账行。0144 里的 grants epoch /
# epoch 单调守卫 / 受控过程才是安全边界；记账误写但对象缺失时必须拒绝开启。
model_authority_db_ready() {
  local schema app admin deploy app_user admin_user deploy_user app_ok admin_ok deploy_ok
  schema="$(remote_model_authority_psql "SELECT (
    EXISTS (SELECT 1 FROM schema_migrations WHERE version='$MODEL_AUTHORITY_CATALOG_MIGRATION')
    AND EXISTS (SELECT 1 FROM schema_migrations WHERE version='$MODEL_AUTHORITY_GUARDS_MIGRATION')
    AND EXISTS (
      SELECT 1 FROM pg_trigger
       WHERE tgname='trg_model_grants_security_after' AND NOT tgisinternal
    )
    AND EXISTS (
      SELECT 1 FROM pg_trigger
       WHERE tgname='trg_users_model_role_security_after' AND NOT tgisinternal
    )
    AND EXISTS (
      SELECT 1 FROM pg_trigger
       WHERE tgname='trg_model_security_epoch_guard' AND NOT tgisinternal
    )
    AND to_regprocedure('fn_model_activate_entry(bigint,integer,bigint)') IS NOT NULL
    AND to_regprocedure('fn_model_stage_version(text,text,text,text,integer,jsonb,integer,bigint)') IS NOT NULL
    AND to_regprocedure('fn_model_authority_grant_admin_role(text)') IS NOT NULL
    AND to_regprocedure('fn_model_authority_grant_deploy_role(text)') IS NOT NULL
    AND to_regprocedure('fn_model_switch_version(text,text,text,text,integer,jsonb,integer,bigint,integer)') IS NOT NULL
    AND to_regclass('model_authority_deploy_state') IS NOT NULL
    AND to_regclass('model_runtime_requirements') IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM pg_trigger
       WHERE tgname='trg_model_runtime_requirements_catalog' AND NOT tgisinternal
    )
    AND EXISTS (
      SELECT 1 FROM pg_trigger
       WHERE tgname='trg_model_runtime_requirements_pricing' AND NOT tgisinternal
    )
  )::text")" || { printf false; return 1; }
  [[ "$schema" == "true" ]] || { printf false; return 0; }

  app="$(remote_model_authority_psql_app "SELECT current_user || '|' || (
    has_table_privilege(current_user,'model_catalog','SELECT')
    AND NOT has_table_privilege(current_user,'model_catalog','INSERT,UPDATE,DELETE')
    AND NOT has_function_privilege(current_user,'fn_model_switch_version(text,text,text,text,integer,jsonb,integer,bigint,integer)','EXECUTE')
    AND NOT has_table_privilege(current_user,'model_authority_deploy_state','SELECT,INSERT,UPDATE')
  )::text")" || { printf false; return 1; }
  admin="$(remote_model_authority_psql_admin "SELECT current_user || '|' || (
    has_table_privilege(current_user,'model_catalog','SELECT')
    AND NOT has_table_privilege(current_user,'model_catalog','INSERT,UPDATE,DELETE')
    AND has_function_privilege(current_user,'fn_model_switch_version(text,text,text,text,integer,jsonb,integer,bigint,integer)','EXECUTE')
    AND has_table_privilege(current_user,'model_authority_deploy_state','SELECT')
    AND NOT has_table_privilege(current_user,'model_authority_deploy_state','INSERT,UPDATE')
    AND has_table_privilege(current_user,'admin_audit','INSERT')
  )::text")" || { printf false; return 1; }
  deploy="$(remote_model_authority_psql "SELECT current_user || '|' || (
    has_table_privilege(current_user,'model_catalog','SELECT')
    AND NOT has_table_privilege(current_user,'model_catalog','INSERT,UPDATE,DELETE')
    AND has_function_privilege(current_user,'fn_model_switch_version(text,text,text,text,integer,jsonb,integer,bigint,integer)','EXECUTE')
    AND has_table_privilege(current_user,'model_authority_deploy_state','SELECT')
    AND has_table_privilege(current_user,'model_authority_deploy_state','INSERT')
    AND has_table_privilege(current_user,'model_authority_deploy_state','UPDATE')
    AND has_table_privilege(current_user,'model_security_epoch','UPDATE')
    AND has_table_privilege(current_user,'model_visibility_grants','SELECT')
    AND has_table_privilege(current_user,'model_visibility_grants','INSERT')
    AND has_table_privilege(current_user,'model_visibility_grants','UPDATE')
    AND has_table_privilege(current_user,'model_visibility_grants','DELETE')
    AND has_table_privilege(current_user,'model_pricing','SELECT')
    AND has_table_privilege(current_user,'model_pricing','INSERT')
    AND has_table_privilege(current_user,'model_pricing','UPDATE')
    AND has_table_privilege(current_user,'model_pricing','DELETE')
  )::text")" || { printf false; return 1; }
  IFS='|' read -r app_user app_ok <<<"$app"
  IFS='|' read -r admin_user admin_ok <<<"$admin"
  IFS='|' read -r deploy_user deploy_ok <<<"$deploy"
  if [[ "$app_ok" == true && "$admin_ok" == true && "$deploy_ok" == true \
        && -n "$app_user" && -n "$admin_user" && -n "$deploy_user" \
        && "$app_user" != "$admin_user" && "$app_user" != "$deploy_user" \
        && "$admin_user" != "$deploy_user" ]]; then
    printf true
  else
    printf false
  fi
}

# cutover marker 是否置位(env OR DB)。**fail-closed**:env≠1 且 DB 探测失败 → 视为置位并拒
# (不确定即拒;与 sessions-pg capability 门同口径)。返回 0=已置位 / 1=未置位。
model_authority_cutover_done() {
  local env_marker db_marker
  env_marker="$(remote_env_get "$MODEL_AUTHORITY_CUTOVER_KEY")"
  [[ "$env_marker" == "1" ]] && return 0
  if ! db_marker="$(remote_model_authority_psql "SELECT EXISTS (SELECT 1 FROM model_authority_deploy_state WHERE key='$MODEL_AUTHORITY_SETTING_KEY')::text")"; then
    echo "✗ 无法探测 cutover marker(psql 失败;env $MODEL_AUTHORITY_CUTOVER_KEY≠1)" >&2
    echo "  fail-closed:无法证明步骤 5 尚未执行 → 按已置位处理(拒绝激活缺 capability 的版本)。" >&2
    echo "  请先恢复 DB 连通性,或直接在 $V5_ENV 写 $MODEL_AUTHORITY_CUTOVER_KEY=0/1 明示状态。" >&2
    return 0
  fi
  [[ "$db_marker" == "true" ]]
}

# 地板:cutover 后任何 master release 激活/回滚都必须声明 master + egress 两个 capability,
# 且 catalog + guards 两条迁移与关键 DB 对象已就绪。容器面在 lib 的
# assert_tuple_viable ③(release MANIFEST / 镜像 label)。
assert_model_authority_floor() {
  local reldir="$1" caps db_ready
  [[ "$DRY" == 1 ]] && { echo "  [dry-run] 跳过模型权威兼容地板"; return 0; }
  if ! model_authority_cutover_done; then
    echo "  · 模型权威地板:cutover marker 未置位(步骤 5 之前)→ 不设限。"
    return 0
  fi
  echo "  · 模型权威地板生效(步骤 5 已 cutover):校验目标 release 与 DB schema。"
  # ① DB schema 面
  db_ready="$(model_authority_db_ready)" \
    || { echo "✗ 激活中止:无法核验模型权威 DB 边界(DB 不可达)—— 不确定即拒。" >&2; exit 1; }
  [[ "$db_ready" == "true" ]] || {
    echo "✗ 激活中止:cutover 已置位但 DB 未就绪(需 $MODEL_AUTHORITY_CATALOG_MIGRATION + $MODEL_AUTHORITY_GUARDS_MIGRATION 及关键 trigger/procedure)。" >&2
    exit 1
  }
  # ②③ master / egress 制品面(同一 release 树,一个文件两个 token)
  caps="$(release_declared_caps "$reldir")" || {
    echo "✗ 激活中止:目标 release 无法读取 deploy/v5/release-metadata.json:$reldir" >&2
    echo "  cutover 后必须能自证 capability;不确定即拒。" >&2
    exit 1
  }
  caps_contain "$caps" "$MODEL_AUTHORITY_CAP" || {
    echo "✗ 激活中止:目标 release 未声明 '$MODEL_AUTHORITY_CAP'(caps=[$caps]):$reldir" >&2
    echo "  步骤 5 后 catalog 里已有 baked 判定不认识的行,回退到 legacy master = 判定源分叉。" >&2
    echo "  回滚只能翻到同样声明该 capability 的前序 release。" >&2
    exit 1
  }
  caps_contain "$caps" "$MODEL_AUTHORITY_EGRESS_CAP" || {
    echo "✗ 激活中止:目标 release 未声明 '$MODEL_AUTHORITY_EGRESS_CAP'(caps=[$caps]):$reldir" >&2
    echo "  egress 与 master 同树同源:该 release 的 egress 进程没有每请求 epoch fence," >&2
    echo "  下线/收窄一个模型后出站面仍会放行(安全变更有 stale window)。" >&2
    exit 1
  }
  echo "  ✓ 模型权威地板:release 声明 [$caps],catalog+guards DB 边界已就绪。"
}

# ── 活体四面探测(preflight:开 flag / cutover 前)──────────────────────────────
# 打印每一面的结论;全绿 → 0,任一红 → 1。**只读**,不改现场。
model_authority_preflight() {
  local ok=1 hz caps rt_release rt_image_id eg
  echo "── 模型权威四面 preflight(活体)──"
  # P3 后 serving master 不再恒为 A；同时模型权威开关/cutover 不能与 cohort rollout
  # 交错，否则两个 slot 会读同一 env 却只重启其中一个，形成 split authority。
  assert_no_rollout_in_progress || return 1
  echo "  · 稳定 active lane:slot=$ACTIVE_SLOT unit=$ACTIVE_UNIT port=$ACTIVE_PORT"
  # ① DB schema
  local db_ready
  if db_ready="$(model_authority_db_ready)" && [[ "$db_ready" == "true" ]]; then
    echo "  ✓ ① DB:$MODEL_AUTHORITY_CATALOG_MIGRATION + $MODEL_AUTHORITY_GUARDS_MIGRATION 及关键 trigger/procedure 已就绪"
  else
    echo "  ✗ ① DB:$MODEL_AUTHORITY_CATALOG_MIGRATION + $MODEL_AUTHORITY_GUARDS_MIGRATION 或关键 trigger/procedure 未就绪(psql 结果='${db_ready:-<err>}')" >&2; ok=0
  fi
  # ② master 活体 capability(/healthz.runtime.capabilities —— commercial 广播,gateway 透传)
  hz="$(ssh "$KL_HOST" "curl -fsS --max-time 5 http://127.0.0.1:${ACTIVE_PORT}/healthz" 2>/dev/null || true)"
  caps="$(printf '%s' "$hz" | jq -r '(.runtime.capabilities // []) | join(" ")' 2>/dev/null || true)"
  if caps_contain "$caps" "$MODEL_AUTHORITY_CAP"; then
    echo "  ✓ ② master:/healthz runtime.capabilities=[$caps]"
  else
    echo "  ✗ ② master:/healthz 未广播 '$MODEL_AUTHORITY_CAP'(caps=[${caps:-<none>}])—— 现网 master 版本不认模型权威协议" >&2; ok=0
  fi
  # ③ egress 活体 capability(独立进程:deploy 默认不重启它 → 必须单独证明)
  eg="$(ssh "$KL_HOST" "curl -fsS --max-time 5 http://172.31.0.1:18892/internal/v5/egress-health" 2>/dev/null || true)"
  caps="$(printf '%s' "$eg" | jq -r '(.capabilities // []) | join(" ")' 2>/dev/null || true)"
  if caps_contain "$caps" "$MODEL_AUTHORITY_EGRESS_CAP"; then
    echo "  ✓ ③ egress:capabilities=[$caps]"
  else
    echo "  ✗ ③ egress:未广播 '$MODEL_AUTHORITY_EGRESS_CAP'(caps=[${caps:-<none>}])—— 旧 egress 进程无 epoch fence" >&2
    echo "      修法:scripts/deploy-v5.sh --egress(把 egress 重启到当前 release)" >&2; ok=0
  fi
  # ④ 容器 runtime:env tuple 指向的 release MANIFEST(release 轴启用)或镜像 features label
  rt_release="$(remote_env_get OC_RUNTIME_RELEASE)"
  rt_image_id="$(remote_env_get OC_RUNTIME_IMAGE_ID)"
  if [[ -n "$rt_release" ]]; then
    caps="$(ssh "$KL_HOST" "jq -r '(.capabilities // []) | join(\" \")' '$rt_release/MANIFEST.json'" 2>/dev/null || true)"
    if caps_contain "$caps" "$MODEL_AUTHORITY_CAP"; then
      echo "  ✓ ④ runtime release:$rt_release capabilities=[$caps]"
    else
      echo "  ✗ ④ runtime release:$rt_release 未声明 '$MODEL_AUTHORITY_CAP'(caps=[${caps:-<none>}])" >&2
      echo "      修法:scripts/deploy-v5.sh(带 runtime release 轴)重建 release 并激活" >&2; ok=0
    fi
  else
    [[ -n "$rt_image_id" ]] || rt_image_id="$(remote_env_get OC_RUNTIME_IMAGE)"
    caps="$(ssh "$KL_HOST" "docker image inspect --format '{{index .Config.Labels \"oc.runtime.features\"}}' '$rt_image_id'" 2>/dev/null || true)"
    if caps_contain "$caps" "$MODEL_AUTHORITY_CAP"; then
      echo "  ✓ ④ runtime 镜像(内嵌源码):$rt_image_id features=[$caps]"
    else
      echo "  ✗ ④ runtime 镜像:$rt_image_id 的 oc.runtime.features=[${caps:-<none>}] 不含 '$MODEL_AUTHORITY_CAP'" >&2
      echo "      修法:用带该能力的 commit 重建镜像(build-image.sh 写 label)后写入 env" >&2; ok=0
    fi
  fi
  [[ "$ok" == 1 ]]
}

# bootstrap 专用:DB marker(跨主机权威)存在 → 把 flag + marker 回写到**新派生**的 env。
# 不确定即拒(DB 探不到 → 拒绝 bootstrap:宁可不起,也不让一个判定源不明的 master 上线)。
restore_model_authority_env_after_bootstrap() {
  [[ "$DRY" == 1 ]] && { echo "  [dry-run] 查 DB cutover marker → 必要时回写 env(flag + marker)"; return 0; }
  local db_marker
  db_marker="$(remote_model_authority_psql "SELECT EXISTS (SELECT 1 FROM model_authority_deploy_state WHERE key='$MODEL_AUTHORITY_SETTING_KEY')::text")" \
    || { echo "✗ bootstrap 中止:无法探测 cutover marker(DB 不可达)—— 不确定即拒。" >&2; exit 1; }
  if [[ "$db_marker" != "true" ]]; then
    echo "  · DB 无 cutover marker(步骤 5 之前)→ env 不动。"
    return 0
  fi
  echo "  · DB cutover marker 已置位 → 回写 env(否则重建实例会以 baked 判定静默起来)。"
  remote_env_set "$MODEL_AUTHORITY_FLAG_KEY" 1 || exit 1
  remote_env_set "$MODEL_AUTHORITY_CUTOVER_KEY" 1 || exit 1
}

install_model_authority_canary() {
  echo "── 安装受限 catalog canary($MODEL_AUTHORITY_CANARY_MODEL)──"
  remote_model_authority_psql_script <<'SQL'
DO $do$
DECLARE
  v_entry BIGINT;
  v_uid BIGINT;
  v_bad BOOLEAN;
BEGIN
  SELECT id INTO v_uid FROM users
   WHERE role = 'admin' AND status = 'active' ORDER BY id LIMIT 1;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'model authority canary requires one active admin user';
  END IF;

  SELECT entry_id,
         NOT (engine='ccb' AND provider_id='ark' AND upstream_model_id='glm-5.2'
              AND context_window=1000000 AND capability_schema_version=1)
    INTO v_entry, v_bad
    FROM model_catalog
   WHERE model_id='oc-catalog-canary-glm52' AND state='active'
   ORDER BY entry_id DESC LIMIT 1;
  IF v_entry IS NOT NULL AND v_bad THEN
    RAISE EXCEPTION 'existing model authority canary has unexpected execution descriptor';
  END IF;

  IF v_entry IS NULL THEN
    v_entry := fn_model_stage_version(
      'oc-catalog-canary-glm52', 'ccb', 'ark', 'glm-5.2', 1000000,
      '{"supports_vision":false,"reasoning":{"supported":["high","max"],"codex_model_default":null},"ccb":{"capability_zero":true,"supports_thinking":true}}'::jsonb,
      1, NULL
    );
    INSERT INTO model_pricing(
      model_id, display_name, input_per_mtok, output_per_mtok,
      cache_read_per_mtok, cache_write_per_mtok, multiplier,
      enabled, sort_order, visibility, default_effort
    )
    SELECT 'oc-catalog-canary-glm52', 'Catalog Canary (restricted)', input_per_mtok,
           output_per_mtok, cache_read_per_mtok, cache_write_per_mtok, multiplier,
           FALSE, 9999, 'hidden', default_effort
      FROM model_pricing WHERE model_id='glm-5.2'
    ON CONFLICT (model_id) DO UPDATE SET
      display_name=EXCLUDED.display_name,
      input_per_mtok=EXCLUDED.input_per_mtok,
      output_per_mtok=EXCLUDED.output_per_mtok,
      cache_read_per_mtok=EXCLUDED.cache_read_per_mtok,
      cache_write_per_mtok=EXCLUDED.cache_write_per_mtok,
      multiplier=EXCLUDED.multiplier,
      enabled=FALSE,
      sort_order=EXCLUDED.sort_order,
      visibility=EXCLUDED.visibility,
      default_effort=EXCLUDED.default_effort;
    PERFORM fn_model_activate_entry(v_entry, NULL, NULL);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM model_pricing WHERE model_id='oc-catalog-canary-glm52' AND enabled) THEN
    RAISE EXCEPTION 'model authority canary is not priced/enabled';
  END IF;
  PERFORM fn_model_alias_set('oc-catalog-canary', 'oc-catalog-canary-glm52', NULL);
  INSERT INTO model_visibility_grants(user_id, model_id)
  VALUES (v_uid, 'oc-catalog-canary-glm52') ON CONFLICT DO NOTHING;
END $do$;
SQL
  echo "  ✓ canary active + hidden + alias + 单 admin grant"
}

start_model_authority_observation() {
  local release tuple epoch rel64 tuple64 out
  release="$(model_authority_release_sha)" || return 1
  tuple="$(model_authority_runtime_tuple)" || return 1
  epoch="$(remote_model_authority_psql "SELECT epoch::text FROM model_security_epoch WHERE id")" || return 1
  [[ "$epoch" =~ ^[0-9]+$ ]] || { echo "✗ 无法读取 observation epoch" >&2; return 1; }
  rel64="$(model_authority_b64 "$release")"; tuple64="$(model_authority_b64 "$tuple")"
  out="$(remote_model_authority_psql "WITH f AS (
    SELECT convert_from(decode('$rel64','base64'),'UTF8') AS release_sha,
           convert_from(decode('$tuple64','base64'),'UTF8')::jsonb AS runtime_tuple,
           '$epoch'::text AS security_epoch,
           (SELECT user_id::text FROM model_visibility_grants WHERE model_id='$MODEL_AUTHORITY_CANARY_MODEL' ORDER BY user_id LIMIT 1) AS canary_uid,
           (SELECT count(*)::text FROM usage_records WHERE authority_kind='bridge_signed') AS request_baseline
  ), persisted AS (
    INSERT INTO model_authority_deploy_state(key,value,description)
    SELECT '$MODEL_AUTHORITY_OBSERVATION_KEY', jsonb_build_object(
      'release_sha',release_sha,'runtime_tuple',runtime_tuple,'security_epoch',security_epoch,
      'canary_model','$MODEL_AUTHORITY_CANARY_MODEL','canary_alias','$MODEL_AUTHORITY_CANARY_ALIAS',
      'canary_uid',canary_uid,'started_at',NOW()::text,'request_baseline',request_baseline,
      'seed_census',NULL,'emergency_drill',NULL
    ), 'model authority reversible observation evidence; cutover locks this row + security epoch'
    FROM f WHERE canary_uid IS NOT NULL
    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,description=EXCLUDED.description,updated_at=NOW()
    RETURNING 1
  )
  SELECT 'ok' FROM persisted")" || return 1
  [[ "$out" == "ok" ]] || { echo "✗ observation 未写入(canary grant 缺失?)" >&2; return 1; }
  echo "  ✓ observation 已开始(release=$release epoch=$epoch;最短 ${MODEL_AUTHORITY_MIN_OBSERVE_SECONDS}s / ${MODEL_AUTHORITY_MIN_REQUESTS} requests)"
}

model_authority_fleet_census() {
  ssh "$KL_HOST" 'ids=$(docker ps -aq --filter label=com.openclaude.runtime_channel=v5); if [ -z "$ids" ]; then printf "[]\n"; else docker inspect $ids | jq -c '\''[.[] | {id:.Id,name:(.Name|ltrimstr("/")),status:.State.Status,bundle_rev:(.Config.Labels["com.openclaude.runtime.bundle_rev"] // "")} ] | sort_by(.id)'\''; fi'
}

rollback_seed_authority_by_rev() { # <reason>
  local reason="$1" live
  require_mutation_lease_for_compensation "seed-authority-rollback" || exit 86
  if ! remote_env_set OC_SEED_AUTHORITY_BY_REV 0; then
    live="$(remote_env_get OC_SEED_AUTHORITY_BY_REV)"
    [[ "$live" == 0 ]] || {
      echo "FATAL:seed authority 补偿无法确认 env=0(reason=$reason,live=${live:-<unreadable>})" >&2
      return 1
    }
    echo "  · seed=0 写回执丢失，但 env 回读已确认 0"
  fi
  ssh "$KL_HOST" "systemctl restart '$ACTIVE_UNIT'" || {
    echo "FATAL:seed authority 补偿 master 重启失败(reason=$reason)" >&2
    return 1
  }
  wait_for_model_authority_master_ready "$ACTIVE_UNIT" 1 1 0 60 || {
    echo "FATAL:seed authority 补偿未活体确认 authority=1/provision=1/seed=0(reason=$reason)" >&2
    return 1
  }
  echo "  ✓ seed authority 已验证回滚(reason=$reason):live authority=1/provision=1/seed=0"
}

enable_seed_authority_by_rev() {
  echo "══ seed authority 阶段 B:全 fleet bundle-rev census(含 stopped)══"
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] 枚举 docker ps -aq runtime_channel=v5 → 全部 bundle_rev=current → 校验 seed → env OC_SEED_AUTHORITY_BY_REV=1 → restart master → observation 留证"
    return 0
  fi
  assert_no_rollout_in_progress || exit 1
  local bundle rev census count bad release tuple epoch rel64 tuple64 census64 out
  bundle="$(remote_env_get OC_PLATFORM_BUNDLE)"; rev="${bundle##*/}"
  [[ "$bundle" == "$OC_HOTCFG_PLATFORM_ROOT/bundles/$rev" && "$rev" =~ ^[0-9a-f]{12}$ ]] || {
    echo "✗ current OC_PLATFORM_BUNDLE 不是 canonical bundles/<12hex>:$bundle" >&2; exit 1;
  }
  ssh "$KL_HOST" "test -f '$bundle/MANIFEST.json'" || { echo "✗ current bundle 缺 MANIFEST:$bundle" >&2; exit 1; }
  census="$(model_authority_fleet_census)" || { echo "✗ fleet census 失败" >&2; exit 1; }
  count="$(jq -r 'length' <<<"$census")"
  [[ "$count" =~ ^[0-9]+$ && "$count" -gt 0 ]] || { echo "✗ fleet census 为空,不能把零容器当作已验证覆盖" >&2; exit 1; }
  bad="$(jq -r --arg rev "$rev" '[.[] | select(.bundle_rev != $rev)] | map(.name+":"+.status+":"+(.bundle_rev|if .=="" then "<missing>" else . end)) | join(",")' <<<"$census")"
  [[ -z "$bad" ]] || { echo "✗ fleet 含旧/缺 bundle_rev 容器(含 stopped):$bad" >&2; echo "  先 recycle/remove 后重试;禁止部分 fleet 开 seed 阶段 B。" >&2; exit 1; }
  ssh "$KL_HOST" "cd '$ACTIVE_SRC' && npx --no-install tsx packages/commercial/agent-sandbox/platform-runtime/entrypoint/validatePlatformSeedCli.ts '$bundle'" \
    || { echo "✗ current bundle seed 声明校验失败" >&2; exit 1; }

  if ! remote_env_set OC_SEED_AUTHORITY_BY_REV 1; then
    rollback_seed_authority_by_rev "seed=1 env 写回执失败(commit-unknown)" || exit 1
    echo "✗ seed=1 env 写入未确认，已完成活体回滚；未登记 census 证据" >&2
    exit 1
  fi
  if ! ssh "$KL_HOST" "systemctl restart '$ACTIVE_UNIT'"; then
    rollback_seed_authority_by_rev "seed=1 master restart failed" || exit 1
    echo "✗ seed=1 master 重启失败，已完成活体回滚" >&2; exit 1
  fi
  if ! wait_for_model_authority_master_ready "$ACTIVE_UNIT" 1 1 1 60; then
    rollback_seed_authority_by_rev "seed=1 master readiness failed" || exit 1
    echo "✗ seed=1 未在当前 MainPID 活体生效，已完成活体回滚" >&2; exit 1
  fi
  if ! smoke "$ACTIVE_PORT"; then
    rollback_seed_authority_by_rev "seed=1 full smoke failed" || exit 1
    echo "✗ seed 阶段 B smoke 失败，已完成活体回滚" >&2; exit 1
  fi

  if ! release="$(model_authority_release_sha)"; then
    rollback_seed_authority_by_rev "seed census release binding read failed" || exit 1
    echo "✗ seed census 无法读取 live release，seed 已完成活体回滚" >&2; exit 1
  fi
  if ! tuple="$(model_authority_runtime_tuple)"; then
    rollback_seed_authority_by_rev "seed census runtime tuple read failed" || exit 1
    echo "✗ seed census 无法读取 runtime tuple，seed 已完成活体回滚" >&2; exit 1
  fi
  if ! epoch="$(remote_model_authority_psql "SELECT epoch::text FROM model_security_epoch WHERE id")" \
    || [[ ! "$epoch" =~ ^[0-9]+$ ]]; then
    rollback_seed_authority_by_rev "seed census security epoch read failed" || exit 1
    echo "✗ seed census 无法读取 security epoch，seed 已完成活体回滚" >&2; exit 1
  fi
  rel64="$(model_authority_b64 "$release")"; tuple64="$(model_authority_b64 "$tuple")"; census64="$(model_authority_b64 "$census")"
  out="$(remote_model_authority_psql "WITH persisted AS (
  UPDATE model_authority_deploy_state SET value=jsonb_set(value,'{seed_census}',jsonb_build_object(
    'recorded_at',NOW()::text,'bundle_rev','$rev','container_count','$count',
    'fleet',convert_from(decode('$census64','base64'),'UTF8')::jsonb
  )),updated_at=NOW()
  WHERE key='$MODEL_AUTHORITY_OBSERVATION_KEY'
    AND value->>'release_sha'=convert_from(decode('$rel64','base64'),'UTF8')
    AND value->'runtime_tuple'=convert_from(decode('$tuple64','base64'),'UTF8')::jsonb
    AND value->>'security_epoch'='$epoch'
  RETURNING 1
  )
  SELECT 'ok' FROM persisted")" || true
  if [[ "$out" != "ok" ]]; then
    rollback_seed_authority_by_rev "seed census observation binding drift" || exit 1
    echo "✗ observation 绑定漂移，seed 已完成活体回滚；重新开启 observation" >&2; exit 1
  fi
  echo "✓ seed authority by rev 已开启并留证(bundle=$rev fleet=$count,含 stopped)。"
}

record_model_authority_emergency_drill() {
  echo "══ 登记 emergency 激活→恢复实跑证据══"
  [[ "$DRY" == 1 ]] && { echo "  [dry-run] history last=third=current,second=emergency → observation 留证"; return 0; }
  assert_no_rollout_in_progress || exit 1
  local last emergency before registered current norm_last norm_emergency norm_before norm_registered release epoch rel64 tuple64 image64 out
  last="$(hotcfg_rmt oc_hotcfg_history_nth_committed "$OC_HOTCFG_HISTORY" 1)"
  emergency="$(hotcfg_rmt oc_hotcfg_history_nth_committed "$OC_HOTCFG_HISTORY" 2)"
  before="$(hotcfg_rmt oc_hotcfg_history_nth_committed "$OC_HOTCFG_HISTORY" 3)"
  registered="$(ssh "$KL_HOST" "grep '^OC_RUNTIME_EMERGENCY_TUPLE=' '$V5_ENV' | tail -n1 | cut -d= -f2-")"
  current="$(model_authority_runtime_tuple)"
  norm_last="$(jq -c '{image,image_id,release,bundle}' <<<"$last")"
  norm_emergency="$(jq -c '{image,image_id,release,bundle}' <<<"$emergency")"
  norm_before="$(jq -c '{image,image_id,release,bundle}' <<<"$before")"
  norm_registered="$(jq -c '{image,image_id,release:"",bundle}' <<<"$registered")"
  [[ "$norm_last" == "$norm_before" && "$norm_last" == "$current" ]] || {
    echo "✗ history 不证明已恢复原 tuple(last != third/current)" >&2; exit 1;
  }
  [[ "$norm_emergency" == "$norm_registered" ]] || {
    echo "✗ history 倒数第 2 条不是当前登记的 emergency tuple" >&2; exit 1;
  }
  release="$(model_authority_release_sha)"; epoch="$(remote_model_authority_psql "SELECT epoch::text FROM model_security_epoch WHERE id")"
  rel64="$(model_authority_b64 "$release")"; tuple64="$(model_authority_b64 "$current")"; image64="$(model_authority_b64 "$norm_emergency")"
  out="$(remote_model_authority_psql "WITH persisted AS (
  UPDATE model_authority_deploy_state SET value=jsonb_set(value,'{emergency_drill}',jsonb_build_object(
    'recorded_at',NOW()::text,'activated_and_restored',true,
    'emergency_tuple',convert_from(decode('$image64','base64'),'UTF8')::jsonb
  )),updated_at=NOW()
  WHERE key='$MODEL_AUTHORITY_OBSERVATION_KEY'
    AND value->>'release_sha'=convert_from(decode('$rel64','base64'),'UTF8')
    AND value->'runtime_tuple'=convert_from(decode('$tuple64','base64'),'UTF8')::jsonb
    AND value->>'security_epoch'='$epoch'
  RETURNING 1
  )
  SELECT 'ok' FROM persisted")" || true
  [[ "$out" == "ok" ]] || { echo "✗ observation 绑定漂移,拒绝登记 emergency drill" >&2; exit 1; }
  echo "✓ emergency 激活与原 tuple 恢复已由三条 committed history 交叉核验并留证。"
}

model_authority_observation_status() {
  local raw
  raw="$(remote_model_authority_psql "WITH o AS (SELECT value FROM model_authority_deploy_state WHERE key='$MODEL_AUTHORITY_OBSERVATION_KEY'),
  lease_requests AS (
    SELECT j.request_id,j.ctx->>'authorityTurnId' AS authority_turn_id,
      CASE WHEN jsonb_typeof(j.ctx->'turnLeaseIssuedAtMs')='number'
           THEN (j.ctx->>'turnLeaseIssuedAtMs')::numeric END AS issued_ms,
      CASE WHEN jsonb_typeof(j.ctx->'turnLeaseVerifiedAtMs')='number'
           THEN (j.ctx->>'turnLeaseVerifiedAtMs')::numeric END AS verified_ms,
      floor(extract(epoch FROM (o.value->>'started_at')::timestamptz)*1000)::numeric AS observation_started_ms
    FROM request_finalize_journal j,o
    WHERE j.created_at >= (o.value->>'started_at')::timestamptz
      AND j.state='committed' AND j.user_id::text=o.value->>'canary_uid'
      AND j.ctx->>'model'=o.value->>'canary_model'
      AND j.ctx->>'source'='ccb_proxy' AND j.ctx->>'authorityKind'='bridge_signed'
      AND NULLIF(j.ctx->>'executionRevision','') IS NOT NULL
      AND j.ctx->>'securityEpoch'=o.value->>'security_epoch'
  ), long_turns AS (
    SELECT DISTINCT late.authority_turn_id
    FROM lease_requests early JOIN lease_requests late
      ON late.authority_turn_id=early.authority_turn_id
     AND late.request_id<>early.request_id AND late.issued_ms=early.issued_ms
    WHERE early.authority_turn_id ~ '^[0-9a-f]{32}$'
      AND early.verified_ms>=early.observation_started_ms
      AND late.verified_ms>=late.observation_started_ms
      AND early.verified_ms>=early.issued_ms
      AND early.verified_ms<early.issued_ms+$MODEL_AUTHORITY_EARLY_REQUEST_MAX_MS
      AND late.verified_ms>=late.issued_ms+$MODEL_AUTHORITY_LONG_TURN_MIN_MS
  )
  SELECT jsonb_build_object(
    'observation',(SELECT value FROM o),
    'elapsed_seconds',COALESCE((SELECT floor(extract(epoch FROM (NOW()-(value->>'started_at')::timestamptz)))::bigint FROM o),0),
    'signed_requests',COALESCE((SELECT count(*) FROM usage_records u,o WHERE u.created_at >= (o.value->>'started_at')::timestamptz AND u.authority_kind='bridge_signed' AND u.execution_revision IS NOT NULL AND u.security_epoch::text=o.value->>'security_epoch'),0),
    'canary_requests',COALESCE((SELECT count(*) FROM usage_records u,o WHERE u.created_at >= (o.value->>'started_at')::timestamptz AND u.model=o.value->>'canary_model' AND u.authority_kind='bridge_signed'),0),
    'long_ccb_turns',COALESCE((SELECT count(*) FROM long_turns),0),
    'minimums',jsonb_build_object('elapsed_seconds',$MODEL_AUTHORITY_MIN_OBSERVE_SECONDS,'signed_requests',$MODEL_AUTHORITY_MIN_REQUESTS,'canary_requests',1,'long_ccb_turns',1)
  )::text")" || { echo "✗ observation status 查询失败" >&2; return 1; }
  jq . <<<"$raw"
}

# systemd restart 后禁止固定 sleep/单点探测。每轮把 unit active + 同一个非零 MainPID
# 的 live env/health 绑成一个样本，并在 health 后重读 PID；本地 timeout 钉死整次 SSH。
MODEL_AUTHORITY_MASTER_LAST_STATE_BEFORE=""; MODEL_AUTHORITY_MASTER_LAST_PID_BEFORE=""
MODEL_AUTHORITY_MASTER_LAST_AUTHORITY=""; MODEL_AUTHORITY_MASTER_LAST_PROVISION=""
MODEL_AUTHORITY_MASTER_LAST_SEED=""; MODEL_AUTHORITY_MASTER_LAST_HEALTH=""
MODEL_AUTHORITY_MASTER_LAST_STATE_AFTER=""; MODEL_AUTHORITY_MASTER_LAST_PID_AFTER=""

model_authority_master_ready_once() { # <unit> <authority> <provision> <seed:0|1|-> <request-timeout-seconds>
  local unit="$1" authority="$2" provision="$3" seed="$4" request_timeout="${5:-2}" raw health_b64
  raw="$(timeout --signal=KILL "${request_timeout}s" ssh "$KL_HOST" bash -s -- \
    "$unit" "$ACTIVE_PORT" "$request_timeout" <<'REMOTE'
set +e
unit="$1"; port="$2" request_timeout="$3"
state_before="$(systemctl is-active "$unit" 2>/dev/null || true)"
pid_before="$(systemctl show -p MainPID --value "$unit" 2>/dev/null || true)"
authority=""; provision=""; seed=""; health=""
if [[ "$state_before" == active && "$pid_before" =~ ^[1-9][0-9]*$ ]] && kill -0 "$pid_before" 2>/dev/null; then
  env_file="/proc/$pid_before/environ"
  if test -r "$env_file"; then
    authority="$(tr '\0' '\n' <"$env_file" | sed -n 's/^OC_MODEL_AUTHORITY=//p' | tail -n1)"
    provision="$(tr '\0' '\n' <"$env_file" | sed -n 's/^OC_MODEL_AUTHORITY_PROVISION_REQUIRED=//p' | tail -n1)"
    seed="$(tr '\0' '\n' <"$env_file" | sed -n 's/^OC_SEED_AUTHORITY_BY_REV=//p' | tail -n1)"
  fi
  health="$(curl -fsS --max-time "$request_timeout" "http://127.0.0.1:${port}/healthz" 2>/dev/null || true)"
fi
state_after="$(systemctl is-active "$unit" 2>/dev/null || true)"
pid_after="$(systemctl show -p MainPID --value "$unit" 2>/dev/null || true)"
[[ "$pid_after" =~ ^[1-9][0-9]*$ ]] && kill -0 "$pid_after" 2>/dev/null || pid_after=""
printf '%s\n%s\n%s\n%s\n%s\n' "$state_before" "$pid_before" "$authority" "$provision" "$seed"
printf '%s' "$health" | base64 -w0; printf '\n'
printf '%s\n%s\n' "$state_after" "$pid_after"
REMOTE
)" || raw=""

  local -a lines=()
  mapfile -t lines <<<"$raw"
  MODEL_AUTHORITY_MASTER_LAST_STATE_BEFORE="${lines[0]:-}"
  MODEL_AUTHORITY_MASTER_LAST_PID_BEFORE="${lines[1]:-}"
  MODEL_AUTHORITY_MASTER_LAST_AUTHORITY="${lines[2]:-}"
  MODEL_AUTHORITY_MASTER_LAST_PROVISION="${lines[3]:-}"
  MODEL_AUTHORITY_MASTER_LAST_SEED="${lines[4]:-}"
  health_b64="${lines[5]:-}"
  MODEL_AUTHORITY_MASTER_LAST_STATE_AFTER="${lines[6]:-}"
  MODEL_AUTHORITY_MASTER_LAST_PID_AFTER="${lines[7]:-}"
  MODEL_AUTHORITY_MASTER_LAST_HEALTH=""
  if [[ -n "$health_b64" ]]; then
    MODEL_AUTHORITY_MASTER_LAST_HEALTH="$(printf '%s' "$health_b64" | base64 -d 2>/dev/null || true)"
  fi

  [[ "$MODEL_AUTHORITY_MASTER_LAST_STATE_BEFORE" == active \
    && "$MODEL_AUTHORITY_MASTER_LAST_STATE_AFTER" == active \
    && "$MODEL_AUTHORITY_MASTER_LAST_PID_BEFORE" =~ ^[1-9][0-9]*$ \
    && "$MODEL_AUTHORITY_MASTER_LAST_PID_BEFORE" == "$MODEL_AUTHORITY_MASTER_LAST_PID_AFTER" \
    && "$MODEL_AUTHORITY_MASTER_LAST_AUTHORITY" == "$authority" \
    && "$MODEL_AUTHORITY_MASTER_LAST_PROVISION" == "$provision" ]] || return 1
  [[ "$seed" == - || "$MODEL_AUTHORITY_MASTER_LAST_SEED" == "$seed" ]] || return 1
  jq -e '.ok == true and .runtime.leadership.state == "leader"' \
    <<<"$MODEL_AUTHORITY_MASTER_LAST_HEALTH" >/dev/null 2>&1 \
    && grep -q '"sessionsDb":"ok"' <<<"$MODEL_AUTHORITY_MASTER_LAST_HEALTH"
}

wait_for_model_authority_master_ready() { # <unit> <authority> <provision> <seed:0|1|-> [timeout-seconds]
  local unit="$1" authority="$2" provision="$3" seed="$4" wait_seconds="${5:-60}"
  local deadline remaining request_timeout sleep_for
  [[ "$authority" =~ ^[01]$ && "$provision" =~ ^[01]$ && "$seed" =~ ^[01-]$ \
    && "$wait_seconds" =~ ^[1-9][0-9]*$ ]] || {
    echo "✗ master readiness 参数非法(authority=$authority provision=$provision seed=$seed timeout=$wait_seconds)" >&2
    return 2
  }
  deadline=$((SECONDS + wait_seconds))
  MODEL_AUTHORITY_MASTER_LAST_STATE_BEFORE=""; MODEL_AUTHORITY_MASTER_LAST_PID_BEFORE=""
  MODEL_AUTHORITY_MASTER_LAST_AUTHORITY=""; MODEL_AUTHORITY_MASTER_LAST_PROVISION=""
  MODEL_AUTHORITY_MASTER_LAST_SEED=""; MODEL_AUTHORITY_MASTER_LAST_HEALTH=""
  MODEL_AUTHORITY_MASTER_LAST_STATE_AFTER=""; MODEL_AUTHORITY_MASTER_LAST_PID_AFTER=""
  echo "── 有界轮询等待 master ready(≤${wait_seconds}s,authority=$authority provision=$provision seed=$seed)──"
  while (( SECONDS < deadline )); do
    remaining=$((deadline - SECONDS))
    request_timeout="$remaining"; (( request_timeout > 2 )) && request_timeout=2
    (( request_timeout < 1 )) && request_timeout=1
    if model_authority_master_ready_once "$unit" "$authority" "$provision" "$seed" "$request_timeout"; then
      echo "  ✓ master ready(pid=$MODEL_AUTHORITY_MASTER_LAST_PID_AFTER authority=$authority provision=$provision seed=$seed)"
      return 0
    fi
    (( SECONDS >= deadline )) && break
    remaining=$((deadline - SECONDS)); sleep_for="$remaining"; (( sleep_for > 1 )) && sleep_for=1
    (( sleep_for > 0 )) && sleep "$sleep_for"
  done
  echo "✗ master 在 ${wait_seconds}s 内未就绪(authority=$authority provision=$provision seed=$seed)" >&2
  echo "  last state/pid=${MODEL_AUTHORITY_MASTER_LAST_STATE_BEFORE:-<empty>}/${MODEL_AUTHORITY_MASTER_LAST_PID_BEFORE:-<empty>}→${MODEL_AUTHORITY_MASTER_LAST_STATE_AFTER:-<empty>}/${MODEL_AUTHORITY_MASTER_LAST_PID_AFTER:-<empty>}" >&2
  echo "  last live env:authority=${MODEL_AUTHORITY_MASTER_LAST_AUTHORITY:-<empty>} provision=${MODEL_AUTHORITY_MASTER_LAST_PROVISION:-<empty>} seed=${MODEL_AUTHORITY_MASTER_LAST_SEED:-<empty>}" >&2
  echo "  last master health:${MODEL_AUTHORITY_MASTER_LAST_HEALTH:-<empty>}" >&2
  return 1
}

MODEL_AUTHORITY_EGRESS_LAST_STATE_BEFORE=""; MODEL_AUTHORITY_EGRESS_LAST_PID_BEFORE=""
MODEL_AUTHORITY_EGRESS_LAST_STATE_AFTER=""; MODEL_AUTHORITY_EGRESS_LAST_PID_AFTER=""
MODEL_AUTHORITY_EGRESS_LAST_HEALTH=""

model_authority_egress_ready_once() { # <true|false> <request-timeout-seconds>
  local expected="$1" request_timeout="${2:-2}" raw health_b64
  raw="$(timeout --signal=KILL "${request_timeout}s" ssh "$KL_HOST" bash -s -- \
    "$V5_EGRESS_UNIT" "$request_timeout" <<'REMOTE'
set +e
unit="$1"; request_timeout="$2"
state_before="$(systemctl is-active "$unit" 2>/dev/null || true)"
pid_before="$(systemctl show -p MainPID --value "$unit" 2>/dev/null || true)"
health=""
if [[ "$state_before" == active && "$pid_before" =~ ^[1-9][0-9]*$ ]] && kill -0 "$pid_before" 2>/dev/null; then
  health="$(curl -fsS --max-time "$request_timeout" http://172.31.0.1:18892/internal/v5/egress-health 2>/dev/null || true)"
fi
state_after="$(systemctl is-active "$unit" 2>/dev/null || true)"
pid_after="$(systemctl show -p MainPID --value "$unit" 2>/dev/null || true)"
[[ "$pid_after" =~ ^[1-9][0-9]*$ ]] && kill -0 "$pid_after" 2>/dev/null || pid_after=""
printf '%s\n%s\n' "$state_before" "$pid_before"
printf '%s' "$health" | base64 -w0; printf '\n'
printf '%s\n%s\n' "$state_after" "$pid_after"
REMOTE
)" || raw=""

  local -a lines=()
  mapfile -t lines <<<"$raw"
  MODEL_AUTHORITY_EGRESS_LAST_STATE_BEFORE="${lines[0]:-}"
  MODEL_AUTHORITY_EGRESS_LAST_PID_BEFORE="${lines[1]:-}"
  health_b64="${lines[2]:-}"
  MODEL_AUTHORITY_EGRESS_LAST_STATE_AFTER="${lines[3]:-}"
  MODEL_AUTHORITY_EGRESS_LAST_PID_AFTER="${lines[4]:-}"
  MODEL_AUTHORITY_EGRESS_LAST_HEALTH=""
  if [[ -n "$health_b64" ]]; then
    MODEL_AUTHORITY_EGRESS_LAST_HEALTH="$(printf '%s' "$health_b64" | base64 -d 2>/dev/null || true)"
  fi

  [[ "$MODEL_AUTHORITY_EGRESS_LAST_STATE_BEFORE" == active \
    && "$MODEL_AUTHORITY_EGRESS_LAST_STATE_AFTER" == active \
    && "$MODEL_AUTHORITY_EGRESS_LAST_PID_BEFORE" =~ ^[1-9][0-9]*$ \
    && "$MODEL_AUTHORITY_EGRESS_LAST_PID_BEFORE" == "$MODEL_AUTHORITY_EGRESS_LAST_PID_AFTER" ]] || return 1
  jq -e --argjson expected "$expected" \
    '.ok == true and .role == "egress" and .modelAuthority.enforced == $expected' \
    <<<"$MODEL_AUTHORITY_EGRESS_LAST_HEALTH" >/dev/null 2>&1
}

wait_for_model_authority_egress_ready() { # <true|false> [timeout-seconds]
  local expected="$1" wait_seconds="${2:-60}" deadline remaining request_timeout sleep_for
  [[ "$expected" == true || "$expected" == false ]] && [[ "$wait_seconds" =~ ^[1-9][0-9]*$ ]] || {
    echo "✗ egress authority readiness 参数非法(expected=$expected timeout=$wait_seconds)" >&2
    return 2
  }
  deadline=$((SECONDS + wait_seconds))
  MODEL_AUTHORITY_EGRESS_LAST_STATE_BEFORE=""; MODEL_AUTHORITY_EGRESS_LAST_PID_BEFORE=""
  MODEL_AUTHORITY_EGRESS_LAST_STATE_AFTER=""; MODEL_AUTHORITY_EGRESS_LAST_PID_AFTER=""
  MODEL_AUTHORITY_EGRESS_LAST_HEALTH=""
  echo "── 有界轮询等待 egress authority ready(≤${wait_seconds}s,enforced=$expected)──"
  while (( SECONDS < deadline )); do
    remaining=$((deadline - SECONDS))
    request_timeout="$remaining"; (( request_timeout > 2 )) && request_timeout=2
    (( request_timeout < 1 )) && request_timeout=1
    if model_authority_egress_ready_once "$expected" "$request_timeout"; then
      echo "  ✓ egress authority ready(pid=$MODEL_AUTHORITY_EGRESS_LAST_PID_AFTER enforced=$expected)"
      return 0
    fi
    (( SECONDS >= deadline )) && break
    remaining=$((deadline - SECONDS)); sleep_for="$remaining"; (( sleep_for > 1 )) && sleep_for=1
    (( sleep_for > 0 )) && sleep "$sleep_for"
  done
  echo "✗ egress 在 ${wait_seconds}s 内未就绪(enforced=$expected)" >&2
  echo "  last state/pid=${MODEL_AUTHORITY_EGRESS_LAST_STATE_BEFORE:-<empty>}/${MODEL_AUTHORITY_EGRESS_LAST_PID_BEFORE:-<empty>}→${MODEL_AUTHORITY_EGRESS_LAST_STATE_AFTER:-<empty>}/${MODEL_AUTHORITY_EGRESS_LAST_PID_AFTER:-<empty>}" >&2
  echo "  last egress health:${MODEL_AUTHORITY_EGRESS_LAST_HEALTH:-<empty>}" >&2
  return 1
}

run_model_authority_container_rollback() {
  local active_home
  active_home="$(slot_home "$ACTIVE_SLOT")"
  ssh "$KL_HOST" "set -Eeuo pipefail
    set -a; . '$V5_ENV'; set +a
    export OPENCLAUDE_HOME='$active_home' OC_RUNTIME_CHANNEL=v5
    cd '$ACTIVE_SRC'
    ./node_modules/.bin/tsx scripts/v5-model-authority-container-rollback.ts --timeout-seconds 2700"
}

model_authority_rollback_diagnostics() { # <reason>
  local reason="$1"
  echo "FATAL:模型权威回滚未完成:$reason" >&2
  echo "  安全态可能仍为 flag=1 + egress enforce=true；不要手工只关一面。" >&2
  echo "  修复故障后原命令重跑:scripts/deploy-v5.sh --disable-model-authority" >&2
  ssh "$KL_HOST" "systemctl --no-pager --full status '$ACTIVE_UNIT' '$V5_EGRESS_UNIT' 2>&1 | tail -n 50" >&2 || true
}

# 步骤 4 的统一回滚闭环。关键顺序：
#   停止制造 flagged 容器 → **无条件**重启 active master 并验 live env → authenticated
#   drain + 20s quiet census →（若仍为 1）关总 flag → master 先回 legacy → egress 后撤
#   enforce → full smoke。若上次已写 flag=0 后失败，重跑会在 live flag0 下重做 census 并前滚。
# 任一步失败立即短路；尤其 census/CLI 失败时总 flag 与 egress 均保持开启，fail-closed。
rollback_model_authority_before_cutover() { # <reason>
  local reason="${1:-manual disable}" current_flag
  require_mutation_lease_for_compensation "model-authority-rollback" || exit 86
  assert_no_rollout_in_progress || { model_authority_rollback_diagnostics "deploy_state 非 stable"; return 1; }
  current_flag="$(remote_env_get "$MODEL_AUTHORITY_FLAG_KEY")" \
    || { model_authority_rollback_diagnostics "无法读取总 flag"; return 1; }
  [[ "$current_flag" == 0 || "$current_flag" == 1 ]] \
    || { model_authority_rollback_diagnostics "总 flag 非规范值:${current_flag:-<empty>}"; return 1; }
  remote_env_set "$MODEL_AUTHORITY_PROVISION_FLAG_KEY" 0 \
    || { model_authority_rollback_diagnostics "无法停止新 flagged provision"; return 1; }
  ssh "$KL_HOST" "systemctl restart '$ACTIVE_UNIT'" \
    || { model_authority_rollback_diagnostics "provision=0 后 active master 重启失败"; return 1; }
  wait_for_model_authority_master_ready "$ACTIVE_UNIT" "$current_flag" 0 - 60 \
    || { model_authority_rollback_diagnostics "active master 未就绪 flag=$current_flag/provision=0"; return 1; }
  # current_flag=0 是上次已过 census、但后续 master/egress/smoke 失败留下的可恢复状态。
  # 仍重跑 Docker+DB census：既让 documented retry 真正前滚，也覆盖人工误写 0 时可能
  # 残留的 flagged 容器；绝不因为 flag 已 0 就跳过清退证据。
  run_model_authority_container_rollback \
    || { model_authority_rollback_diagnostics "容器 drain/census 未在时限内收敛"; return 1; }

  if [[ "$current_flag" == 1 ]]; then
    # census 收敛后才允许写 0。写失败时不重启任何进程，避免 env 与活体面进一步分叉。
    remote_env_set "$MODEL_AUTHORITY_FLAG_KEY" 0 \
      || { model_authority_rollback_diagnostics "总 flag 写 0 失败（未执行后续重启）"; return 1; }
    ssh "$KL_HOST" "systemctl restart '$ACTIVE_UNIT'" \
      || { model_authority_rollback_diagnostics "flag=0 后 active master 重启失败（egress 尚未后撤）"; return 1; }
    wait_for_model_authority_master_ready "$ACTIVE_UNIT" 0 0 - 60 \
      || { model_authority_rollback_diagnostics "active master legacy 未就绪 flag=0/provision=0"; return 1; }
  fi
  ssh "$KL_HOST" "systemctl restart '$V5_EGRESS_UNIT'" \
    || { model_authority_rollback_diagnostics "egress 后撤重启失败"; return 1; }
  wait_for_model_authority_egress_ready false 60 \
    || { model_authority_rollback_diagnostics "egress 未活体确认 enforce=false"; return 1; }
  smoke "$ACTIVE_PORT" \
    || { model_authority_rollback_diagnostics "回滚后 full smoke 失败"; return 1; }
  echo "✓ 模型权威已完整回滚(reason=$reason):容器 census 收敛，master→egress 顺序回到 legacy。"
}

# enable 尚未重启 master 时的窄补偿：此时没有新签发面，只需先写 flag=0，再重启
# egress 并活体确认 enforce=false；写 0 失败时禁止任何重启。
rollback_model_authority_egress_only() {
  require_mutation_lease_for_compensation "model-authority-egress-rollback" || exit 86
  remote_env_set "$MODEL_AUTHORITY_FLAG_KEY" 0 || return 1
  ssh "$KL_HOST" "systemctl restart '$V5_EGRESS_UNIT'" || return 1
  wait_for_model_authority_egress_ready false 60
}

# --enable-model-authority:四面全绿 → 写 OC_MODEL_AUTHORITY=1 → 重启 master + egress → smoke。
# (方案 §7 步 4:判定源切换。egress 也读该 flag —— /v1/messages 在 egress 进程,必须一起重启。)
enable_model_authority() {
  echo "══ 开启模型权威 flag(方案 §7 步 4)══"
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] preflight → 安装受限 canary → provision-required=1 + flag=1 → egress enforce → master → smoke → 持久 observation"
    return 0
  fi
  model_authority_preflight || { echo "✗ preflight 未全绿,拒绝开启 flag(见上方逐面结论)" >&2; exit 1; }
  install_model_authority_canary || { echo "✗ canary 安装失败,flag 尚未改动" >&2; exit 1; }
  remote_env_set "$MODEL_AUTHORITY_PROVISION_FLAG_KEY" 1 || exit 1
  if ! remote_env_set "$MODEL_AUTHORITY_FLAG_KEY" 1; then
    # 写失败的远端状态不确定：只做 env 补偿并验证，不重启任何进程。
    require_mutation_lease_for_compensation "model-authority-flag-write-compensation" || exit 86
    remote_env_set "$MODEL_AUTHORITY_FLAG_KEY" 0 || true
    [[ "$(remote_env_get "$MODEL_AUTHORITY_FLAG_KEY")" == 0 ]] \
      || { echo "FATAL:flag=1 写失败且无法确认补偿为 0；禁止重启，人工核查 $V5_ENV" >&2; exit 1; }
    echo "✗ flag=1 写失败，已确认 env 补偿为 0（未重启任何进程）" >&2
    exit 1
  fi
  echo "── 先重启 egress 并确认 enforce=true(允许短暂 fail-closed,禁止新 master+旧 egress fail-open)──"
  if ! ssh "$KL_HOST" "systemctl restart '$V5_EGRESS_UNIT'"; then
    rollback_model_authority_egress_only \
      || { model_authority_rollback_diagnostics "egress enable 失败后的窄补偿未确认"; exit 1; }
    echo "✗ egress 重启失败,已窄补偿为 flag=0/enforce=false" >&2
    exit 1
  fi
  if ! wait_for_model_authority_egress_ready true 60; then
    rollback_model_authority_egress_only \
      || { model_authority_rollback_diagnostics "egress enforce 探测失败后的窄补偿未确认"; exit 1; }
    echo "✗ egress 未活体确认 enforce=true,已窄补偿为 flag=0/enforce=false" >&2
    exit 1
  fi
  echo "  ✓ egress 已 enforce=true;现在才允许 master 开始签发"
  if ! ssh "$KL_HOST" "systemctl restart '$ACTIVE_UNIT'"; then
    rollback_model_authority_before_cutover "enable master restart failed" || exit 1
    echo "✗ master 开启重启失败，已完成全量安全回滚" >&2
    exit 1
  fi
  if ! wait_for_model_authority_master_ready "$ACTIVE_UNIT" 1 1 - 60; then
    rollback_model_authority_before_cutover "post-enable master readiness failed" || exit 1
    echo "✗ master 开启后未在当前 MainPID 就绪，已完成全量安全回滚" >&2
    exit 1
  fi
  if ! smoke "$ACTIVE_PORT"; then
    rollback_model_authority_before_cutover "post-enable smoke failed" || exit 1
    echo "✗ 开启后 smoke 失败，已完成全量安全回滚" >&2
    exit 1
  fi
  if ! start_model_authority_observation; then
    rollback_model_authority_before_cutover "observation persistence failed" || exit 1
    echo "✗ observation 无法持久化，已完成全量安全回滚；禁止无证据运行后 cutover" >&2
    exit 1
  fi
  # 审计 10:enable 只有 smoke,不证明「请求能穿过 epoch fence 出正文」—— 而这条 flag 改的正是
  # 模型判定源。非阻断真 turn:失败不自动回滚(observation 已开始,回滚有自身流程),但必须留证据。
  smoke_turn_canary_advisory "$(bg_current_release "$ACTIVE_SRC")" "model-authority enable"
  echo "✓ $MODEL_AUTHORITY_FLAG_KEY=1 已生效(判定源 = catalog),observation 已开始。"
}

# --disable-model-authority:关 flag(步骤 4 的回滚)。**cutover 后禁用**(地板不可逆)。
disable_model_authority() {
  echo "══ 关闭模型权威 flag(步骤 4 回滚)══"
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] 校验 cutover marker 未置位 → provision=0 → restart master → drain+census quiet → flag=0 → restart master→egress → smoke"
    return 0
  fi
  if model_authority_cutover_done; then
    echo "✗ 拒绝:cutover marker 已置位(步骤 5 已执行),兼容地板不可逆。" >&2
    echo "  catalog 里可能已有 baked 判定不认识的行,关 flag = 容器按旧表执行 → 判定源分叉。" >&2
    echo "  合法退路(方案 §7 步 5 回滚列):事务性把 catalog 恢复到 baked 等价值 + bump epoch +" >&2
    echo "  等全部快照与运行容器收敛,再清 marker(env 键 + model_authority_deploy_state 行),才允许关 flag。" >&2
    exit 1
  fi
  rollback_model_authority_before_cutover "manual disable" || exit 1
}

# --model-authority-cutover:步骤 5 的持久化 marker。置位后地板不可逆(见 assert_model_authority_floor)。
# 前置:flag 已开 + 四面活体全绿。写 DB 单行(权威)+ env 键(DB 不可达时的本地信号)。
model_authority_cutover() {
  echo "══ 步骤 5:置位模型权威 cutover marker(不可逆兼容地板)══"
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] 断言 flag/preflight + fleet/seed → DB 原子锁 observation+epoch 并验证 15m/请求/canary/长 CCB/emergency → marker → env"
    return 0
  fi
  local flag db_marker release tuple rel64 tuple64 census observation current_fp observed_fp rev
  flag="$(remote_env_get "$MODEL_AUTHORITY_FLAG_KEY")"
  [[ "$flag" == "1" ]] || {
    echo "✗ 拒绝:$MODEL_AUTHORITY_FLAG_KEY≠1(当前='${flag:-<unset>}')—— 步骤 5 必须在步骤 4 之后。" >&2
    exit 1
  }
  model_authority_preflight || { echo "✗ preflight 未全绿,拒绝 cutover" >&2; exit 1; }
  db_marker="$(remote_model_authority_psql "SELECT EXISTS(SELECT 1 FROM model_authority_deploy_state WHERE key='$MODEL_AUTHORITY_SETTING_KEY')::text")" || exit 1
  if [[ "$db_marker" == "true" ]]; then
    echo "  · DB marker 已存在(上次可能只差 env),跳过不可逆事务重放。"
    remote_env_set "$MODEL_AUTHORITY_CUTOVER_KEY" 1 || exit 1
    model_authority_cutover_done || exit 1
    return 0
  fi
  [[ "$(remote_env_get OC_SEED_AUTHORITY_BY_REV)" == "1" ]] || {
    echo "✗ seed 阶段 B 尚未开启;先 --enable-seed-authority-by-rev" >&2; exit 1;
  }
  tuple="$(model_authority_runtime_tuple)"; release="$(model_authority_release_sha)"
  rev="$(jq -r '.bundle|split("/")[-1]' <<<"$tuple")"
  census="$(model_authority_fleet_census)"; observation="$(remote_model_authority_psql "SELECT value::text FROM model_authority_deploy_state WHERE key='$MODEL_AUTHORITY_OBSERVATION_KEY'")"
  [[ -n "$observation" ]] || { echo "✗ 缺 observation;重新 --enable-model-authority" >&2; exit 1; }
  [[ "$(jq -r 'length' <<<"$census")" -gt 0 ]] || { echo "✗ cutover fleet census 为空" >&2; exit 1; }
  [[ "$(jq -r --arg rev "$rev" '[.[]|select(.bundle_rev!=$rev)]|length' <<<"$census")" == "0" ]] || {
    echo "✗ cutover 瞬时 census 出现旧 bundle_rev;重新完成 seed census" >&2; exit 1;
  }
  current_fp="$(jq -c '[.[]|{id,bundle_rev}]|sort_by(.id)' <<<"$census")"
  observed_fp="$(jq -c '[.seed_census.fleet[]|{id,bundle_rev}]|sort_by(.id)' <<<"$observation")"
  [[ "$current_fp" == "$observed_fp" ]] || {
    echo "✗ fleet 在 seed census 后发生增删/换 rev;重新跑 --enable-seed-authority-by-rev 取得新证据" >&2; exit 1;
  }
  rel64="$(model_authority_b64 "$release")"; tuple64="$(model_authority_b64 "$tuple")"
  echo "── DB 原子线性化:锁 observation + security epoch → 全证据校验 → marker ──"
  remote_model_authority_psql_script <<SQL
DO \$cutover\$
DECLARE
  v_obs JSONB;
  v_epoch BIGINT;
  v_n BIGINT;
BEGIN
  SELECT value INTO v_obs FROM model_authority_deploy_state
   WHERE key='$MODEL_AUTHORITY_OBSERVATION_KEY' FOR UPDATE;
  IF v_obs IS NULL THEN RAISE EXCEPTION 'model authority observation missing'; END IF;
  SELECT epoch INTO v_epoch FROM model_security_epoch WHERE id FOR UPDATE;
  IF v_obs->>'release_sha' <> convert_from(decode('$rel64','base64'),'UTF8')
     OR v_obs->'runtime_tuple' <> convert_from(decode('$tuple64','base64'),'UTF8')::jsonb
     OR v_obs->>'security_epoch' <> v_epoch::text THEN
    RAISE EXCEPTION 'observation binding drifted (release/runtime tuple/security epoch)';
  END IF;
  IF NOW() - (v_obs->>'started_at')::timestamptz < interval '${MODEL_AUTHORITY_MIN_OBSERVE_SECONDS} seconds' THEN
    RAISE EXCEPTION 'observation window shorter than ${MODEL_AUTHORITY_MIN_OBSERVE_SECONDS}s';
  END IF;
  IF COALESCE((v_obs->'seed_census'->>'container_count')::int,0) < 1 THEN
    RAISE EXCEPTION 'seed fleet census evidence missing';
  END IF;
  IF COALESCE((v_obs->'emergency_drill'->>'activated_and_restored')::boolean,FALSE) IS NOT TRUE THEN
    RAISE EXCEPTION 'emergency activate/restore drill evidence missing';
  END IF;
  SELECT count(*) INTO v_n FROM usage_records
   WHERE created_at >= (v_obs->>'started_at')::timestamptz
     AND authority_kind='bridge_signed' AND execution_revision IS NOT NULL
     AND security_epoch::text=v_epoch::text;
  IF v_n < $MODEL_AUTHORITY_MIN_REQUESTS THEN
    RAISE EXCEPTION 'signed request evidence % < ${MODEL_AUTHORITY_MIN_REQUESTS}', v_n;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM usage_records
     WHERE created_at >= (v_obs->>'started_at')::timestamptz
       AND model=v_obs->>'canary_model' AND authority_kind='bridge_signed'
  ) THEN RAISE EXCEPTION 'catalog canary has no signed usage'; END IF;
  IF NOT EXISTS (
    WITH lease_requests AS (
      SELECT request_id,ctx->>'authorityTurnId' AS authority_turn_id,
        CASE WHEN jsonb_typeof(ctx->'turnLeaseIssuedAtMs')='number'
             THEN (ctx->>'turnLeaseIssuedAtMs')::numeric END AS issued_ms,
        CASE WHEN jsonb_typeof(ctx->'turnLeaseVerifiedAtMs')='number'
             THEN (ctx->>'turnLeaseVerifiedAtMs')::numeric END AS verified_ms
      FROM request_finalize_journal
      WHERE created_at >= (v_obs->>'started_at')::timestamptz
        AND state='committed' AND user_id::text=v_obs->>'canary_uid'
        AND ctx->>'model'=v_obs->>'canary_model'
        AND ctx->>'source'='ccb_proxy' AND ctx->>'authorityKind'='bridge_signed'
        AND NULLIF(ctx->>'executionRevision','') IS NOT NULL
        AND ctx->>'securityEpoch'=v_epoch::text
    )
    SELECT 1 FROM lease_requests early JOIN lease_requests late
      ON late.authority_turn_id=early.authority_turn_id
     AND late.request_id<>early.request_id AND late.issued_ms=early.issued_ms
    WHERE early.authority_turn_id ~ '^[0-9a-f]{32}$'
      AND early.verified_ms>=floor(extract(epoch FROM (v_obs->>'started_at')::timestamptz)*1000)::numeric
      AND late.verified_ms>=floor(extract(epoch FROM (v_obs->>'started_at')::timestamptz)*1000)::numeric
      AND early.verified_ms>=early.issued_ms
      AND early.verified_ms<early.issued_ms+$MODEL_AUTHORITY_EARLY_REQUEST_MAX_MS
      AND late.verified_ms>=late.issued_ms+$MODEL_AUTHORITY_LONG_TURN_MIN_MS
  ) THEN RAISE EXCEPTION 'no committed multi-request CCB turn continuing on a verified lease after 5m'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM model_catalog c
    JOIN model_aliases a ON a.entry_id=c.entry_id
    JOIN model_visibility_grants g ON g.model_id=c.model_id
     WHERE c.model_id='$MODEL_AUTHORITY_CANARY_MODEL' AND c.state='active'
       AND a.alias='$MODEL_AUTHORITY_CANARY_ALIAS' AND g.user_id::text=v_obs->>'canary_uid'
  ) THEN RAISE EXCEPTION 'catalog canary active/alias/grant invariant failed'; END IF;
  IF EXISTS (
    SELECT 1 FROM model_runtime_requirements r
     WHERE NOT EXISTS (SELECT 1 FROM model_catalog c WHERE c.model_id=r.model_id AND c.state='active')
        OR NOT EXISTS (SELECT 1 FROM model_pricing p WHERE p.model_id=r.model_id AND p.enabled)
  ) THEN RAISE EXCEPTION 'required runtime model invariant failed'; END IF;
  INSERT INTO model_authority_deploy_state(key,value,description)
  VALUES ('$MODEL_AUTHORITY_SETTING_KEY',jsonb_build_object(
    'at',NOW()::text,'by','deploy-v5.sh','release_sha',v_obs->>'release_sha',
    'runtime_tuple',v_obs->'runtime_tuple','security_epoch',v_epoch::text,
    'observation',v_obs
  ),'model authority step-5 cutover: atomic observation+epoch evidence; baked rollback forbidden');
END \$cutover\$;
SQL
  echo "  ✓ DB marker 与 observation/epoch 锁在同一事务提交"
  echo "── 写 env marker ──"
  remote_env_set "$MODEL_AUTHORITY_CUTOVER_KEY" 1 || {
    echo "✗ env marker 写失败(DB marker 已置位 → 地板已生效);重试本命令即可补齐 env" >&2; exit 1
  }
  model_authority_cutover_done || { echo "✗ 复核失败:marker 写完却读不到" >&2; exit 1; }
  echo "✓ cutover marker 已置位(DB + env)。此后:"
  echo "   · deploy/rollback 拒绝激活缺 capability 的 master release / runtime tuple;"
  echo "   · master 与 egress 在 flag 关闭态下**拒启**(runtimeCapabilities.ts 地板断言);"
  echo "   · admin catalog 状态机(/api/admin/model-catalog)即为开放状态。"
}

# Runtime-event physical batching is deliberately dark by default. Enabling is
# a separate locked rollout only after both the live and immediate rollback
# masters can hydrate format 3. A failed restart/smoke reverts only the flag and
# restarts the same capable release; it never falls through to an old reader.
enable_runtime_tape_batching() {
  echo "══ 开启 lossless runtime-event batching(format 3)══"
  assert_no_rollout_in_progress
  resolve_active_lane
  local active previous current
  active="$(bg_current_release "$ACTIVE_SRC")"
  previous="$ACTIVE_STATE_PREVIOUS_RELEASE"
  [[ -n "$active" && -n "$previous" ]] || {
    echo "✗ 缺当前/previous release 权威，无法证明安全回滚。先完成两代含新 reader 的正常部署。" >&2
    return 1
  }
  assert_release_required_migrations "$active" || return 1
  assert_lossless_runtime_batch_capability "$active" || return 1
  assert_lossless_runtime_batch_capability "$previous" || {
    echo "✗ previous release 不支持 format 3；保持 batching 关闭。再完成一轮正常部署后重试。" >&2
    return 1
  }
  current="$(remote_env_get "$LOSSLESS_RUNTIME_BATCH_ENV")"
  if [[ "$current" =~ ^(1|true|TRUE|on|ON)$ ]]; then
    assert_lossless_runtime_batch_floor "$active" || return 1
    smoke "$ACTIVE_PORT"
    echo "✓ runtime-event batching 已开启且健康。"
    return 0
  fi
  begin_planned_maintenance deploy 0
  if ! remote_env_set "$LOSSLESS_RUNTIME_BATCH_ENV" 1 \
      || ! ssh "$KL_HOST" "systemctl restart '$ACTIVE_UNIT'" \
      || ! smoke "$ACTIVE_PORT" \
      || ! assert_lossless_runtime_batch_floor "$active"; then
    echo "✗ batching 开启未通过健康门；恢复 flag=0 并重启同一 capable release。" >&2
    require_mutation_lease_for_compensation "runtime-batching-compensation" || exit 86
    # 2026-07-26(审计 10):这三步此前各挂一个 `|| true`,把恢复结果整个吞掉 —— 操作者只看到
    # 一句「未通过健康门」+ rc=1,无法区分「已安全回到 flag=0 且服务健康」与「回退了但服务已挂」。
    # 改法:逐步取回退出码 + 明确判词;恢复本体绝不因此被阻断(每一步都跑完,不 early return),
    # 但恢复未确认时落 durable recovery marker,让下一次普通发布停在现场而不是往损坏态上叠新版本。
    local batch_recover_failed=""
    remote_env_set "$LOSSLESS_RUNTIME_BATCH_ENV" 0 || batch_recover_failed="env flag 未能置回 0"
    ssh "$KL_HOST" "systemctl restart '$ACTIVE_UNIT'" \
      || batch_recover_failed="${batch_recover_failed:+$batch_recover_failed; }restart $ACTIVE_UNIT 失败"
    smoke "$ACTIVE_PORT" \
      || batch_recover_failed="${batch_recover_failed:+$batch_recover_failed; }恢复后 smoke 未通过"
    end_planned_maintenance
    if [[ -n "$batch_recover_failed" ]]; then
      echo "✗✗ batching 恢复未确认:$batch_recover_failed" >&2
      echo "   现网可能处于 flag/进程状态未知态,须人工核对后再发布。" >&2
      mark_deploy_recovery_required "runtime tape batching enable failed and recovery unconfirmed: $batch_recover_failed"
    else
      echo "  ✓ 已确认回到 flag=0 且服务健康(batching 未开启,现网与操作前一致)"
    fi
    return 1
  fi
  end_planned_maintenance
  # 审计 10:本 flag 改的是**会话正文的物理存储格式**,smoke 只证明进程起来了。非阻断真 turn
  # 至少证明「新格式下还能写出并读回一条完整 turn」。
  smoke_turn_canary_advisory "$active" "runtime-tape-batching enable"
  echo "✓ runtime-event batching 已安全开启(active+previous reader 均兼容 format 3)。"
}

# 自动回切的 lossless 能力门。candidate 一旦可能服务过 v2 写入，必须在任何
# deploy_state/symlink/unit 补偿之前证明旧 master 和**当前实际** runtime tuple 都兼容。
# 调用方持有 deploy lock，release metadata 不可变；同一次补偿只检查一次，避免状态已
# 回退后第二次瞬态探测失败而留下 state=old/runtime=new 的分裂现场。
assert_release_activation_compensation_compatible() {  # $1=old_release $2=candidate_release
  local old_release="$1" candidate_release="$2" image_id runtime_release
  require_mutation_lease_for_compensation "release-activation-compensation" || exit 86
  assert_web_storage_rollback_transition \
    "$old_release" "${ACTIVE_STATE_PREVIOUS_RELEASE:-}" "$old_release" \
    "release activation compensation" || {
    mark_deploy_recovery_required "browser storage rollback 地板拒绝旧 master:$old_release"
    return 1
  }
  if ! assert_lossless_runtime_batch_floor "$old_release"; then
    mark_deploy_recovery_required "lossless writer 已可能对外服务,runtime-event batch 地板拒绝旧 master:$old_release"
    return 1
  fi
  # The candidate may have accepted traffic as soon as restart was attempted.
  # If it is a v2 writer OR its capability probe failed, require the
  # compensation target unconditionally. Unknown must be armed: treating a
  # transient ssh/jq failure as "not capable" would fail open. A DB
  # "no finalized tape" probe would also race a concurrent first finalize.
  if lossless_release_may_have_served "$candidate_release"; then
    if ! assert_lossless_master_release_capability "$old_release"; then
      mark_deploy_recovery_required "lossless writer 已可能对外服务,禁止自动回切旧 master:$old_release"
      return 1
    fi
    image_id="$(remote_env_get OC_RUNTIME_IMAGE_ID)"
    runtime_release="$(remote_env_get OC_RUNTIME_RELEASE)"
    if ! assert_lossless_runtime_tuple_capability "$image_id" "$runtime_release"; then
      mark_deploy_recovery_required "lossless writer 已可能对外服务,禁止自动恢复无能力 runtime tuple"
      return 1
    fi
    echo "  ✓ 自动补偿目标 master/runtime 均具备 $LOSSLESS_TURN_TAPE_CAP(无条件检查,无首写竞态)。" >&2
  fi
  if ! prepare_direct_turn_timeline_activation "$old_release" "$candidate_release"; then
    mark_deploy_recovery_required "direct turn timeline prevents automatic compensation to old master:$old_release"
    return 1
  fi
}

# 仅供紧邻的已通过能力门的补偿路径调用：恢复旧 symlink/.prev-release 并 restart 旧 unit。
# 此函数故意不重新探测，见 assert_release_activation_compensation_compatible 的一次性检查说明。
restore_release_runtime_after_compatibility_guard() {  # $1=old_release $2=old_prev_file $3=reason
  local old_release="$1" old_prev_file="$2" reason="$3"
  local tmplink="$ACTIVE_SRC.rollback.$$"
  require_mutation_lease_for_compensation "release-runtime-rollback" || exit 86
  echo "⚠ 激活未提交($reason)→ 补偿恢复 slot=$ACTIVE_SLOT old=$old_release" >&2
  if ! ssh "$KL_HOST" "set -Eeuo pipefail
      rm -f '$tmplink'
      ln -s '$old_release' '$tmplink'
      mv -T '$tmplink' '$ACTIVE_SRC'
      if [ '$ACTIVE_SLOT' = A ]; then
        if [ -n '$old_prev_file' ]; then
          printf '%s\n' '$old_prev_file' > '$RELEASES_ROOT/.prev-release.tmp'
          mv -f '$RELEASES_ROOT/.prev-release.tmp' '$RELEASES_ROOT/.prev-release'
        else
          rm -f '$RELEASES_ROOT/.prev-release'
        fi
      fi
      systemctl restart '$ACTIVE_UNIT'"; then
    echo "FATAL:补偿失败！slot=$ACTIVE_SLOT symlink/unit 可能处于混合现场，停止并人工核查。" >&2
    return 1
  fi
  if ! smoke "$ACTIVE_PORT"; then
    echo "FATAL:旧 release 已回切但 smoke 未过，停止并人工核查 slot=$ACTIVE_SLOT。" >&2
    return 1
  fi
  echo "  ✓ 补偿完成:slot=$ACTIVE_SLOT 已恢复 $old_release" >&2
}

# restart/smoke 失败发生在 deploy_state 提交前：先过能力门，再恢复运行面。
restore_release_activation() {  # $1=old_release $2=old_prev_file $3=reason $4=candidate_release
  local old_release="$1" old_prev_file="$2" reason="$3" candidate_release="$4"
  assert_release_activation_compensation_compatible "$old_release" "$candidate_release" || return 1
  restore_release_runtime_after_compatibility_guard "$old_release" "$old_prev_file" "$reason"
}

# 状态提交回执丢失时做三态裁决，并把 state 收敛回提交前值。只有确认 original/reverted
# 才允许继续回切 symlink/unit；PG 不可读、竞争或其它状态一律 unknown，落人工恢复标记并
# 保持当前运行面不动，避免 state=new/runtime=old 的盲补偿分裂。
restore_release_state_if_committed() {  # $1=target
  local target="$1" status="" i status_sql
  require_mutation_lease_for_compensation "release-state-reconcile" || exit 86
  status_sql="$(ds_stable_release_status_sql "$ACTIVE_STATE_LOCK_VERSION" "$ACTIVE_SLOT" \
    "$ACTIVE_STATE_RELEASE" "$ACTIVE_STATE_PREVIOUS_RELEASE" "$target")"
  for i in 1 2 3; do
    status="$(ds_exec <<<"$status_sql" 2>/dev/null || true)"
    status="$(printf '%s' "$status" | tr -d '[:space:]')"
    [[ "$status" =~ ^(applied|original|reverted|unknown)$ ]] && break
    sleep 1
  done
  case "$status" in
    original|reverted)
      echo "  ✓ deploy_state 已确认处于提交前血缘(status=$status)，允许运行面补偿。" >&2
      return 0 ;;
    applied)
      # 只允许精确的 expect+1/target 血缘执行补偿 CAS；回执仍可能丢失，随后再次三态回读。
      ds_stable_release_revert "$((ACTIVE_STATE_LOCK_VERSION + 1))" "$ACTIVE_SLOT" "$target" \
        "$ACTIVE_STATE_RELEASE" "$ACTIVE_STATE_PREVIOUS_RELEASE" >/dev/null 2>&1 || true
      for i in 1 2 3; do
        status="$(ds_exec <<<"$status_sql" 2>/dev/null || true)"
        status="$(printf '%s' "$status" | tr -d '[:space:]')"
        [[ "$status" == original || "$status" == reverted ]] && {
          echo "  ✓ deploy_state 补偿确认完成(status=$status active=${ACTIVE_STATE_RELEASE:-NULL} previous=${ACTIVE_STATE_PREVIOUS_RELEASE:-NULL})" >&2
          return 0
        }
        sleep 1
      done ;;
  esac
  mark_deploy_recovery_required "release CAS 回执无法裁决/补偿未确认(target=$target status=${status:-unreadable})"
  return 1
}

# 原子激活 release:assets 先就位；随后 symlink→restart→健康门→deploy_state CAS。
# 任一步失败都回切旧 symlink/unit；状态 CAS 落空/PG 错误绝不再被吞成成功。
activate_release() {
  local reldir="$1" prev tmplink old_prev_file=""
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] 校验+assets 先就位→翻转 $ACTIVE_SRC(slot=$ACTIVE_SLOT)→restart/smoke $ACTIVE_UNIT:$ACTIVE_PORT→严格 state CAS；任一步失败回切旧 release"
    return 0
  fi
  assert_release_marker "$reldir" || return 1
  assert_release_required_migrations "$reldir" || return 1
  assert_release_baseline_security "$reldir" || return 1
  # 割接后 capability 门:deploy/dist/rollback 的激活都经本函数,一处即覆盖全部激活/回滚路径。
  assert_release_capability_for_sessions_pg "$reldir"
  assert_lossless_turn_tape_floor "$reldir"
  # 模型权威兼容地板(步骤 5 后):同上,激活/回滚同一处收口。
  assert_model_authority_floor "$reldir"
  prev="$(bg_current_release "$ACTIVE_SRC")"
  [[ -n "$prev" ]] || { echo "✗ 无法解析 active slot 当前 release，拒绝激活。" >&2; return 1; }
  assert_web_storage_rollback_transition \
    "$prev" "${ACTIVE_STATE_PREVIOUS_RELEASE:-}" "$reldir" "release activation" || return 1
  assert_release_marker "$prev" || {
    echo "✗ 激活前无法证明 exact predecessor 可安全补偿:$prev" >&2; return 1;
  }
  [[ "$ACTIVE_SLOT" == A ]] && old_prev_file="$(ssh "$KL_HOST" "cat '$RELEASES_ROOT/.prev-release' 2>/dev/null || true")"
  # 前端资产先于任何 live 翻转就位；失败仅留下加法式孤儿资产，无运行态变化。
  sync_assets_to_pool "$reldir" || return 1
  prepare_direct_turn_timeline_activation "$reldir" "$prev" || return 1
  tmplink="$ACTIVE_SRC.newlink.$$"
  # A slot:同时写 .prev-release 文件(传统 lane 兼容兜底);B slot:rollback 权威在 deploy_state.previous_active_release,不写文件(不污染 A 的兜底)。
  local prev_file_cmd=""
  [[ "$ACTIVE_SLOT" == A ]] && prev_file_cmd="printf '%s\n' '$prev' > '$RELEASES_ROOT/.prev-release.tmp' && mv -f '$RELEASES_ROOT/.prev-release.tmp' '$RELEASES_ROOT/.prev-release';"
  # 翻转前先落 prev(原子);再翻转(ln -sfn 非原子,故临时链+mv -T)
  ssh "$KL_HOST" "set -Eeuo pipefail
    $prev_file_cmd
    rm -f '$tmplink'
    ln -s '$reldir' '$tmplink'
    mv -T '$tmplink' '$ACTIVE_SRC'" || { echo "✗ symlink 翻转失败(live 未改)" >&2; exit 1; }
  echo "  ✓ 原子翻转:$ACTIVE_SRC(slot=$ACTIVE_SLOT)→ $reldir(旧=$prev)"
  echo "── restart $ACTIVE_UNIT(仅 v5 active slot=$ACTIVE_SLOT,绝不碰 v3)──"
  if ! ssh "$KL_HOST" "systemctl restart '$ACTIVE_UNIT'"; then
    restore_release_activation "$prev" "$old_prev_file" "restart new failed" "$reldir" \
      || mark_deploy_recovery_required "新 release restart 失败且旧运行面补偿未确认(slot=$ACTIVE_SLOT)"
    return 1
  fi
  run "sleep 4"
  if ! smoke "$ACTIVE_PORT"; then
    restore_release_activation "$prev" "$old_prev_file" "new release smoke failed" "$reldir" \
      || mark_deploy_recovery_required "新 release smoke 失败且旧运行面补偿未确认(slot=$ACTIVE_SLOT)"
    return 1
  fi
  if ! ds_commit_active_release "$reldir"; then
    # PG 可能已经提交但 ACK 丢失。candidate 已对外服务过时，必须先证明旧栈兼容，
    # 再触碰 deploy_state；否则会留下 state=old/runtime=new 的权威分裂。
    if ! assert_release_activation_compensation_compatible "$prev" "$reldir"; then
      echo "FATAL:旧栈兼容性未证明，保持 deploy_state 与新运行面不动；禁止盲目补偿。" >&2
    elif restore_release_state_if_committed "$reldir"; then
      restore_release_runtime_after_compatibility_guard "$prev" "$old_prev_file" "deploy_state commit failed" \
        || mark_deploy_recovery_required "state 已恢复但 slot=$ACTIVE_SLOT 运行面回切失败(target=$reldir)"
    else
      echo "FATAL:state 未确认恢复，保持新运行面不动；禁止盲目回切旧 symlink/unit。" >&2
    fi
    return 1
  fi
}

# 传统 deploy/rollback 的严格状态提交：消费起手快照 lock/version/release，CAS 落空或 PG 错误即失败。
ds_commit_active_release() {
  local reldir="$1" out
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] 严格提交 deploy_state(slot=$ACTIVE_SLOT lock=$ACTIVE_STATE_LOCK_VERSION expected=${ACTIVE_STATE_RELEASE:-NULL} → $reldir)"
    return 0
  fi
  if ! out="$(ds_stable_release_commit "$ACTIVE_STATE_LOCK_VERSION" "$ACTIVE_SLOT" "$ACTIVE_STATE_RELEASE" "$reldir")"; then
    echo "✗ deploy_state release CAS 查询失败(PG/认证/连接错误)。" >&2
    return 1
  fi
  [[ -n "$out" ]] || { echo "✗ deploy_state release CAS 落空(lock/phase/candidate/slot/release 已漂移)。" >&2; return 1; }
  ACTIVE_STATE_PREVIOUS_RELEASE="$ACTIVE_STATE_RELEASE"
  ACTIVE_STATE_RELEASE="$reldir"
  ACTIVE_STATE_LOCK_VERSION="$out"
  echo "  ✓ deploy_state 提交:active_release=$reldir(slot=$ACTIVE_SLOT,lock=$out),previous←旧 active"
}

# GC:保留最近 RELEASES_KEEP 个 release,删更老;**绝不删** current / .prev-release /
# deploy_state / master+egress cwd，以及任一 managed V5 容器三条 baseline bind 引用的 release。
# 删除前完整 Docker census；list/inspect/Source 解析任一异常都以 rc=75 整轮安全跳过、零删除。
# 只删带 .complete 的正式 rel-*;顺带清超 1 天的孤儿 .staging-*。
gc_releases() {
  [[ "$DRY" == 1 ]] && { echo "  [dry-run] GC:保留最近 $RELEASES_KEEP 个,护 A/B/deploy_state/cwd + 全部 V5 容器 baseline release 引用"; return 0; }
  # 双 master 下 A/B 两 slot symlink 都可能在役；previous_active_release 还可能是唯一指向 B
  # 直接回滚代的引用。删除型 GC 对 PG 读取必须 fail-closed：查询失败/零行就整轮跳过。
  local dsrels ds_active ds_candidate ds_previous gc_out gc_rc=0 quoted
  if ! dsrels="$(ds_exec 2>/dev/null <<'SQL'
SELECT coalesce(active_release,'')||'|'||coalesce(candidate_release,'')||'|'||coalesce(previous_active_release,'') FROM deploy_state WHERE singleton = true;
SQL
)" || [[ -z "$dsrels" ]]; then
    echo "  ⚠ deploy_state 保护集读取失败/无行 → 本轮安全跳过 release 删除型 GC" >&2
    return 0
  fi
  IFS='|' read -r ds_active ds_candidate ds_previous <<<"${dsrels:-||}"
  local srcA srcB; srcA="$(slot_src A)"; srcB="$(slot_src B)"
  printf -v quoted '%q ' \
    "$RELEASES_ROOT" "$RELEASES_KEEP" "$srcA" "$srcB" "$V5_EGRESS_SRC" \
    "$RELEASES_ROOT/.prev-release" "$(slot_unit A)" "$(slot_unit B)" "$V5_EGRESS_UNIT" \
    "$ds_active" "$ds_candidate" "$ds_previous"
  gc_out="$(ssh "$KL_HOST" "bash -s -- $quoted" < "$RELEASE_GC_SCRIPT" 2>&1)" || gc_rc=$?
  [[ -z "$gc_out" ]] || printf '%s\n' "$gc_out" | sed 's/^/  /'
  case "$gc_rc" in
    0) return 0 ;;
    75)
      echo "  ⚠ release GC 引用 census/校验失败 → 已在首个 rm 前安全跳过整轮删除" >&2
      return 0
      ;;
    *)
      echo "✗ release GC 远端删除失败——中止 lane，不吞掉部分删除错误。" >&2
      return 1
      ;;
  esac
}

# ═══════════════════ runtime tuple / platform bundle 编排(§1.1/1.2/1.5/3.1)═══════════════════
# 编排层职责边界:只做「组装 staging(git archive / cp 钉死源)+ ship lib + 远端 invoke 纯函数」。
# 所有 digest/MANIFEST/自检/GC 保护集/激活 saga 的算法核心都在 v5-runtime-release-lib.sh(宿主本地
# 纯函数,同一份代码本地自测 + kl-mirror 部署两处跑,无第二权威源)。

# ship 纯函数库到 kl-mirror(幂等,一次部署一次)。
_hotcfg_lib_shipped=0
hotcfg_ship_lib() {
  [[ "$DRY" == 1 ]] && { echo "  [dry-run] ship runtime-release-lib → $KL_HOST:$HOTCFG_REMOTE_LIB"; return 0; }
  [[ "$_hotcfg_lib_shipped" == 1 ]] && return 0
  ssh "$KL_HOST" "mkdir -p '$(dirname "$HOTCFG_REMOTE_LIB")' && cat > '$HOTCFG_REMOTE_LIB' && chmod 700 '$HOTCFG_REMOTE_LIB'" < "$RUNTIME_LIB" \
    || { echo "✗ ship runtime-release-lib 失败" >&2; return 1; }
  _hotcfg_lib_shipped=1
}

# 在 kl-mirror 上 source lib 后调用一个纯函数;根路径经 env 透传;args 经 printf %q 安全传递。
# stdout = 该函数 stdout(如 bundleRev / releaseDir),供 $(...) 捕获;lib 的日志走 stderr。
hotcfg_rmt() {
  local fn="$1"; shift
  hotcfg_ship_lib || return 1
  ssh "$KL_HOST" "bash -s -- $(printf '%q ' "$@")" <<RLIB
set -Eeuo pipefail
export OC_HOTCFG_PLATFORM_ROOT='$OC_HOTCFG_PLATFORM_ROOT'
export OC_HOTCFG_RELEASES_ROOT='$OC_HOTCFG_RELEASES_ROOT'
export OC_HOTCFG_ENV_FILE='$V5_ENV'
export OC_HOTCFG_HISTORY='$OC_HOTCFG_HISTORY'
. '$HOTCFG_REMOTE_LIB'
$fn "\$@"
RLIB
}

# 机制启用判定:显式 --enable-* flag,或**远端 env 对应 tuple 键存在且值非空**(开启后持续生效)。
# R2-B1 三态写语义:env_write_tuple 恒写四键,禁用轴写**空值** —— 故"键缺失/值空"= 未启用,
# "值非空绝对路径"= 已启用,enabled 判定的单一权威就是"值非空"。用与 oc_hotcfg_env_get 同法取末行值判空。
# 未启用 → 该机制零行为(保证合并后未部署期间生产零变化)。
hotcfg_bundle_enabled() {
  [[ "$ENABLE_BUNDLE_FLAG" == 1 ]] && return 0
  [[ "$DRY" == 1 ]] && return 1
  ssh "$KL_HOST" "test -r '$V5_ENV' && [ -n \"\$(grep -E '^[[:space:]]*OC_PLATFORM_BUNDLE=' '$V5_ENV' 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '[:space:]')\" ]" 2>/dev/null
}
hotcfg_release_enabled() {
  [[ "$ENABLE_RELEASE_FLAG" == 1 ]] && return 0
  [[ "$DRY" == 1 ]] && return 1
  ssh "$KL_HOST" "test -r '$V5_ENV' && [ -n \"\$(grep -E '^[[:space:]]*OC_RUNTIME_RELEASE=' '$V5_ENV' 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '[:space:]')\" ]" 2>/dev/null
}
hotcfg_any_enabled() { hotcfg_bundle_enabled || hotcfg_release_enabled; }

# 轴的**本次部署生效态**(R2-B1):--disable-* 恒 0(该轴本次写空值);否则同 enabled 判定。
# build 与 activate 都按此取轴,保证"禁用轴不 build、激活传空串"。
hotcfg_bundle_axis_on()  { [[ "$DISABLE_BUNDLE_FLAG" == 1 ]] && return 1; hotcfg_bundle_enabled; }
hotcfg_release_axis_on() { [[ "$DISABLE_RELEASE_FLAG" == 1 ]] && return 1; hotcfg_release_enabled; }

# tuple 账本是否已有记录(R2-B1):--disable 把两轴 env 都清空后,rollback 的入口判定若只看
# enabled 会漏掉"退回启用态"场景 —— history 非空即认为 tuple 账本在管辖,rollback 走 tuple 感知路径。
hotcfg_history_present() {
  [[ "$DRY" == 1 ]] && return 1
  ssh "$KL_HOST" "test -s '$OC_HOTCFG_HISTORY'" 2>/dev/null
}

# 在线 slim runtime image 切换前置门。目标镜像必须先完成不可变构建，且 durable
# override 已随 protected commit 合并；这里只读核验，不预写 V5_ENV。真正切换仍由
# activate_runtime_tuple → oc_hotcfg_activate_saga 原子提交完整 tuple。
assert_target_runtime_image_ready() {
  [[ -n "$TARGET_RUNTIME_IMAGE" ]] || return 0
  local -a pinned=()
  local inspect actual_id source_commit embed_source
  mapfile -t pinned < <(grep -E '^OC_RUNTIME_IMAGE=' "$REPO_ROOT/deploy/v5/commercial-v5.env.overrides" || true)
  [[ ${#pinned[@]} == 1 && "${pinned[0]#OC_RUNTIME_IMAGE=}" == "$TARGET_RUNTIME_IMAGE" ]] || {
    echo "✗ repo overrides 必须唯一且精确钉住 --runtime-image（先合并 durable config）" >&2
    return 1
  }
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] 核验 target runtime image ID/slim label/source ancestor，随后以该 ID 构建 release 并由 joint saga 原子激活"
    return 0
  fi
  hotcfg_release_axis_on || {
    echo "✗ --runtime-image 要求 runtime release hotcfg 轴已开启（或本次显式 --enable-runtime-release）" >&2
    return 1
  }
  inspect="$(ssh "$KL_HOST" "docker image inspect --format '{{.Id}}|{{ index .Config.Labels \"oc.runtime.source_commit\" }}|{{ index .Config.Labels \"oc.runtime.embed_source\" }}' '$TARGET_RUNTIME_IMAGE'" 2>/dev/null)" || {
    echo "✗ 目标 runtime image 不存在或 inspect 失败:$TARGET_RUNTIME_IMAGE" >&2
    return 1
  }
  IFS='|' read -r actual_id source_commit embed_source <<<"$inspect"
  [[ "$actual_id" == "$TARGET_RUNTIME_IMAGE_ID" ]] || {
    echo "✗ 目标 runtime image immutable ID 漂移(expected=$TARGET_RUNTIME_IMAGE_ID actual=${actual_id:-<none>})" >&2
    return 1
  }
  [[ "$embed_source" == 0 ]] || {
    echo "✗ --runtime-image 在线切换只接受 slim image(oc.runtime.embed_source=0)" >&2
    return 1
  }
  [[ "$source_commit" =~ ^[0-9a-f]{40}$ ]] \
    && git -C "$REPO_ROOT" cat-file -e "${source_commit}^{commit}" 2>/dev/null \
    && git -C "$REPO_ROOT" merge-base --is-ancestor "$source_commit" HEAD || {
    echo "✗ 目标 runtime image source_commit 不是 canonical HEAD 的可验证 ancestor:${source_commit:-<none>}" >&2
    return 1
  }
  echo "  ✓ target runtime image 已钉死(ref=$TARGET_RUNTIME_IMAGE id=$TARGET_RUNTIME_IMAGE_ID source=$source_commit slim=1)"
}

# ── 1. build_platform_bundle:从**钉死的** BUILT_RELEASE 内 platform-runtime/ 组装 → 落 bundles/<rev> ──
# 源必须取本次 deploy 已建的不可变 master release(而非 live 树),与 VERSION/archive 同 sha 自洽。
BUILT_BUNDLE_REV=""
build_platform_bundle() {
  BUILT_BUNDLE_REV=""
  local src="$BUILT_RELEASE/packages/commercial/agent-sandbox/platform-runtime"
  local full_sha nonce staging
  # 与 build_release 同源:bundle 的 rev 必须标注它真正来自哪个 commit,
  # 否则 tuple 里 release 与 bundle 会指向两个不同的 commit(release 按 pinned、
  # bundle 按 HEAD),而 tuple 是原子回滚单元 —— 两半不同源就无法可靠回退。
  # 优先复用 build_release 已解析好的值,避免二次查询产生新的读竞态。
  full_sha="${BUILT_RELEASE_SOURCE_COMMIT:-$(resolve_release_source_commit)}"
  [[ -n "$full_sha" ]] || { echo "✗ 无法解析 bundle 源 commit(空值)" >&2; return 1; }
  echo "── build platform bundle(源=pinned $src)──"
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] assert platform-runtime+prompts/ 存在;cp → bundles/.staging;seed 语义校验(validatePlatformSeedCli,缺 CLI 即 fail);finalize → bundles/<rev>"
    BUILT_BUNDLE_REV="dryrunbundle0"; return 0
  fi
  nonce="$(openssl rand -hex 8)"
  staging="$OC_HOTCFG_PLATFORM_ROOT/bundles/.staging-$nonce"
  hotcfg_ship_lib || return 1
  # 组装 staging(agent D 依赖:platform-runtime/ 与 prompts/ 缺失即 fail-loud)
  ssh "$KL_HOST" "set -Eeuo pipefail
    test -d '$src' || { echo 'FATAL: 缺 platform-runtime 源(agent D 未就位?): $src' >&2; exit 1; }
    test -d '$src/prompts' || { echo 'FATAL: platform-runtime 缺 prompts/ 子目录(agent D 未就位?)' >&2; exit 1; }
    mkdir -p '$OC_HOTCFG_PLATFORM_ROOT/bundles'
    rm -rf '$staging'; mkdir -p '$staging'
    cp -a '$src/.' '$staging/'" || { echo "✗ bundle staging 组装失败" >&2; return 1; }
  # R2-M2②:seed 语义校验(EG2 契约 CLI:参数=bundle 根;exit 0/非 0;stderr 给原因)。
  # finalize 前对 staging 跑(幂等复用路径的内容 ≡ staging,校验 staging 即覆盖);CLI 与 node_modules
  # 都取本次 pinned 的 BUILT_RELEASE(同 sha 自洽);npx --no-install 禁网络兜底;**CLI 文件不存在 →
  # fail-loud**(防 TS 侧文件挪位/漂移后校验被静默跳过)。
  local seed_cli="$BUILT_RELEASE/packages/commercial/agent-sandbox/platform-runtime/entrypoint/validatePlatformSeedCli.ts"
  ssh "$KL_HOST" "test -f '$seed_cli'" \
    || { echo "✗ 缺 seed 语义校验 CLI(agent EG2 契约文件,拒绝静默跳过): $seed_cli" >&2; return 1; }
  ssh "$KL_HOST" "cd '$BUILT_RELEASE' && npx --no-install tsx '$seed_cli' '$staging'" \
    || { echo "✗ seed 语义校验失败(validatePlatformSeedCli 非 0,原因见其 stderr)" >&2; return 1; }
  BUILT_BUNDLE_REV="$(hotcfg_rmt oc_hotcfg_finalize_bundle "$staging" 1 "$full_sha")" \
    || { echo "✗ bundle finalize 失败(结构自检/MANIFEST/校验)" >&2; return 1; }
  BUILT_BUNDLE_REV="$(printf '%s' "$BUILT_BUNDLE_REV" | tr -d '[:space:]')"
  [[ "$BUILT_BUNDLE_REV" =~ ^[0-9a-f]{12}$ ]] || { echo "✗ bundle rev 非法: '$BUILT_BUNDLE_REV'" >&2; return 1; }
  echo "  ✓ platform bundle rev=$BUILT_BUNDLE_REV"
}

# ── 2. build_runtime_release:git archive 钉死源 → exclude-from prune → docker npm ci + ccb bun build → rel-<digest> ──
BUILT_RUNTIME_RELEASE=""; RUNTIME_IMAGE_REF=""; RUNTIME_IMAGE_ID=""
build_runtime_release() {
  BUILT_RUNTIME_RELEASE=""; RUNTIME_IMAGE_REF=""; RUNTIME_IMAGE_ID=""
  local full_sha nonce raw staging runtime_caps
  local excl='packages/commercial/agent-sandbox/runtime-src-excludes.txt'
  # tuple 的第三半。runtime release / platform bundle / master release 是同一个原子
  # 回滚单元,三者必须来自**同一个** commit —— 否则回滚一条 tuple 会把三个不同 commit
  # 的产物混在一起。与 build_release 同源(优先复用已解析值,不二次读)。
  full_sha="${BUILT_RELEASE_SOURCE_COMMIT:-$(resolve_release_source_commit)}"
  [[ -n "$full_sha" ]] || { echo "✗ 无法解析 runtime release 源 commit(空值)" >&2; return 1; }
  # runtime capability 是随 pinned 源码 commit 交付的制品声明。必须读该 commit 自己的
  # metadata，而非可并发变化的 working tree；整列透传，避免新增 capability 时被旧接线抹掉。
  if ! runtime_caps="$(
    git -C "$REPO_ROOT" show "${full_sha}:deploy/v5/release-metadata.json" \
      | jq -er --arg required "$MODEL_AUTHORITY_CAP" '
          .runtimeCapabilities as $caps
          | if (($caps | type) != "array") then error("runtimeCapabilities must be an array")
            elif (($caps | length) == 0) then error("runtimeCapabilities must not be empty")
            elif any($caps[]; type != "string") then error("runtimeCapabilities must contain only strings")
            elif any($caps[]; test("^[A-Za-z0-9][A-Za-z0-9._-]*$") | not) then error("invalid runtime capability token")
            elif (($caps | unique | length) != ($caps | length)) then error("duplicate runtime capability token")
            elif (($caps | index($required)) == null) then error("required runtime capability is missing")
            else $caps | join(" ")
            end
        '
  )"; then
    echo "✗ pinned release metadata 的 runtimeCapabilities 非法或缺 '$MODEL_AUTHORITY_CAP':$full_sha" >&2
    return 1
  fi
  echo "── build runtime release(源钉死 git archive $full_sha)──"
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] archive→prune(--exclude-from=$excl)→敏感扫描→docker npm ci(root 一套)→ccb host bun build 仅拷 dist(无 ccb node_modules)→manifest→rel-<digest>"
    BUILT_RUNTIME_RELEASE="$OC_HOTCFG_RELEASES_ROOT/rel-dryrunrelease"; RUNTIME_IMAGE_REF="dry"; RUNTIME_IMAGE_ID="sha256:dry"; return 0
  fi
  hotcfg_ship_lib || return 1
  if [[ -n "$TARGET_RUNTIME_IMAGE" ]]; then
    RUNTIME_IMAGE_REF="$TARGET_RUNTIME_IMAGE"
    RUNTIME_IMAGE_ID="$(ssh "$KL_HOST" "docker image inspect --format '{{.Id}}' '$RUNTIME_IMAGE_REF'" 2>/dev/null)" \
      || { echo "✗ 目标 runtime 镜像不存在:$RUNTIME_IMAGE_REF" >&2; return 1; }
    [[ "$RUNTIME_IMAGE_ID" == "$TARGET_RUNTIME_IMAGE_ID" ]] || {
      echo "✗ runtime release 构建前目标 image ID 漂移(expected=$TARGET_RUNTIME_IMAGE_ID actual=${RUNTIME_IMAGE_ID:-<none>})" >&2
      return 1
    }
  else
    RUNTIME_IMAGE_REF="$(ssh "$KL_HOST" "grep '^OC_RUNTIME_IMAGE=' '$V5_ENV' | tail -n1 | cut -d= -f2-")"
    [[ -n "$RUNTIME_IMAGE_REF" ]] || { echo "✗ env 缺 OC_RUNTIME_IMAGE(release 依赖目标镜像装依赖)" >&2; return 1; }
    RUNTIME_IMAGE_ID="$(ssh "$KL_HOST" "docker image inspect --format '{{.Id}}' '$RUNTIME_IMAGE_REF'" 2>/dev/null)" \
      || { echo "✗ 目标 runtime 镜像不存在(须先 build-image 并写入 env): $RUNTIME_IMAGE_REF" >&2; return 1; }
  fi
  local prev; prev="$(ssh "$KL_HOST" "grep '^OC_RUNTIME_RELEASE=' '$V5_ENV' | tail -n1 | cut -d= -f2-" 2>/dev/null || true)"
  nonce="$(openssl rand -hex 8)"
  raw="$OC_HOTCFG_RELEASES_ROOT/.raw-$nonce"; staging="$OC_HOTCFG_RELEASES_ROOT/.staging-$nonce"
  # 源钉死:git archive full_sha → raw → rsync --exclude-from(与 build-image.sh 同 excludes 权威)→ staging
  git -C "$REPO_ROOT" archive --format=tar "$full_sha" | ssh "$KL_HOST" "set -Eeuo pipefail
    mkdir -p '$OC_HOTCFG_RELEASES_ROOT'
    rm -rf '$raw' '$staging'; mkdir -p '$raw' '$staging'
    tar -x -C '$raw'
    test -f '$raw/$excl' || { echo 'FATAL: 缺 runtime-src-excludes.txt(agent B 未就位?): $excl' >&2; exit 1; }
    rsync -a --exclude-from='$raw/$excl' '$raw/' '$staging/'
    rm -rf '$raw'" || { echo "✗ release 源钉死/prune 失败" >&2; ssh "$KL_HOST" "rm -rf '$raw' '$staging'" 2>/dev/null; return 1; }
  BUILT_RUNTIME_RELEASE="$(hotcfg_rmt oc_hotcfg_finalize_release "$staging" "$RUNTIME_IMAGE_ID" "$full_sha" "${prev:-}" "$runtime_caps")" \
    || { echo "✗ release finalize 失败(npm ci / ccb build / manifest)" >&2; ssh "$KL_HOST" "rm -rf '$staging'" 2>/dev/null; return 1; }
  BUILT_RUNTIME_RELEASE="$(printf '%s' "$BUILT_RUNTIME_RELEASE" | tr -d '[:space:]')"
  [[ "$BUILT_RUNTIME_RELEASE" == "$OC_HOTCFG_RELEASES_ROOT"/rel-* ]] || { echo "✗ release 目录非法: '$BUILT_RUNTIME_RELEASE'" >&2; return 1; }
  echo "  ✓ runtime release=$BUILT_RUNTIME_RELEASE image_id=$RUNTIME_IMAGE_ID"
}

# ── 3. activate_runtime_tuple:激活 saga(env tuple + master 源码翻转 + current 翻转 + restart + smoke + history)──
# 取代"直接 restart 段":master 源码 symlink 翻转作为 saga 的 extra_apply(与 tuple 同原子回滚)。
# 两轴独立 + R2-B1 三态写:启用轴产新值;禁用/未启用轴传**空串**(env_write_tuple 恒写四键,空值落盘
# = 该轴禁用可表达,--disable-* 即走此路)。saga 内含 R2-B2 pre-state(首次启用记激活前现场)与
# R2-M2③ canary boot 冒烟(restart 前,validate-only)。
# 激活提交的核心健康门(单一权威,R4-M2):正常激活与 emergency 激活**同强度**,
# 恒含 sessionsDb=ok(数据库失联时不许提交任何 tuple history)。
hotcfg_core_smoke_cmd() {
  printf '%s' 'hz=""; for i in $(seq 1 15); do hz=$(curl -fsS http://127.0.0.1:'"$ACTIVE_PORT"'/healthz 2>/dev/null||true); [ -n "$hz" ] && break; sleep 2; done; printf "%s" "$hz" | grep -q "\"ok\":true" && printf "%s" "$hz" | grep -q "\"channel\":\"v5\"" && printf "%s" "$hz" | grep -q "\"sessionsDb\":\"ok\""'
}

# 把 deploy_state release CAS 作为 hotcfg saga 的 commit/revert 钩子。命令在 kl-mirror 的
# bash 内执行，严格复用 v5-deploy-state-lib.sh 生成的 SQL；commit 落空/PG 错误会触发 hotcfg
# 原有的 env/current/symlink/unit 全补偿，history 写失败则再用 revert SQL 恢复原 release 血缘。
HOTCFG_STATE_COMMIT_CMD=""; HOTCFG_STATE_REVERT_CMD=""
build_hotcfg_state_hooks() {  # $1=target master release
  local target="$1" apply_sql revert_sql status_sql next_lock
  next_lock=$((ACTIVE_STATE_LOCK_VERSION + 1))
  apply_sql="$(ds_stable_release_commit_sql "$ACTIVE_STATE_LOCK_VERSION" "$ACTIVE_SLOT" "$ACTIVE_STATE_RELEASE" "$target")"
  revert_sql="$(ds_stable_release_revert_sql "$next_lock" "$ACTIVE_SLOT" "$target" "$ACTIVE_STATE_RELEASE" "$ACTIVE_STATE_PREVIOUS_RELEASE")"
  status_sql="$(ds_stable_release_status_sql "$ACTIVE_STATE_LOCK_VERSION" "$ACTIVE_SLOT" \
    "$ACTIVE_STATE_RELEASE" "$ACTIVE_STATE_PREVIOUS_RELEASE" "$target")"
  # commit 三态协议:0=applied(含“UPDATE 已提交但回执丢失后回读确认”)；10=original 确认；
  # 11=unknown。命令包在子 shell，避免 exit/return 穿透调用 saga。
  printf -v HOTCFG_STATE_COMMIT_CMD \
    '( set -a; . %q; if out="$(psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -tAq -c %q 2>/dev/null)" && [ -n "$out" ]; then exit 0; fi; for i in 1 2 3; do status="$(psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -tAq -c %q 2>/dev/null || true)"; status="$(printf %%s "$status" | tr -d "[:space:]")"; case "$status" in applied) exit 0 ;; original) exit 10 ;; esac; sleep 1; done; exit 11 )' \
    "$V5_ENV" "$apply_sql" "$status_sql"
  # revert 是幂等 reconcile：无论 apply 明确成功、回执不明或明确未命中，只有回读确认
  # original/reverted 才返回 0；PG 不可读/竞争/alien state 均返回 11，让 saga 保持新运行面。
  printf -v HOTCFG_STATE_REVERT_CMD \
    '( set -a; . %q; for i in 1 2 3; do out="$(psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -tAq -c %q 2>/dev/null || true)"; [ -n "$out" ] && exit 0; status="$(psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -tAq -c %q 2>/dev/null || true)"; status="$(printf %%s "$status" | tr -d "[:space:]")"; case "$status" in original|reverted) exit 0 ;; esac; sleep 1; done; exit 11 )' \
    "$V5_ENV" "$revert_sql" "$status_sql"
}

activate_runtime_tuple() {
  echo "── 激活 runtime tuple saga ──"
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] saga: [pre-state(首启)]→[canary validate-only]→extra_apply(master symlink→$BUILT_RELEASE)→env tuple(四键恒写,禁用轴空值)→[flip current]→restart→smoke→history commit"
    return 0
  fi
  assert_release_marker "$BUILT_RELEASE" || return 1
  assert_release_required_migrations "$BUILT_RELEASE" || return 1
  assert_release_baseline_security "$BUILT_RELEASE" || return 1
  # hotcfg 路径的 master symlink 翻转走 saga 的 extra_apply,**不经 activate_release** →
  # 两个 capability 门必须在这里显式再挂一次(否则开了 hotcfg 就等于绕过了所有制品守卫)。
  # 容器 tuple 面由 lib 的 assert_tuple_viable ③ 在 saga 内覆盖(release MANIFEST / 镜像 label)。
  assert_release_capability_for_sessions_pg "$BUILT_RELEASE"
  assert_lossless_turn_tape_floor "$BUILT_RELEASE"
  assert_model_authority_floor "$BUILT_RELEASE"
  local prev_src old_prev="" image image_id release bundle_val flip_rev restart_cmd smoke_cmd extra_apply extra_revert prev_apply="" prev_revert=""
  prev_src="$(bg_current_release "$ACTIVE_SRC")"
  [[ -n "$prev_src" ]] || { echo "✗ hotcfg 激活前无法解析 slot=$ACTIVE_SLOT 当前 release" >&2; return 1; }
  assert_web_storage_rollback_transition \
    "$prev_src" "${ACTIVE_STATE_PREVIOUS_RELEASE:-}" "$BUILT_RELEASE" \
    "runtime hotcfg master activation" || return 1
  assert_release_marker "$prev_src" || {
    echo "✗ hotcfg 激活前 exact predecessor marker 无效:$prev_src" >&2; return 1;
  }
  assert_direct_turn_timeline_pair "$prev_src" "$BUILT_RELEASE" "runtime hotcfg activation" || return 1
  # M7c:快照翻转**前**的 .prev-release 指针内容,失败恢复时一并还原(否则 saga 失败一次丢 rollback 指针)。
  if [[ "$ACTIVE_SLOT" == A ]]; then
    old_prev="$(ssh "$KL_HOST" "cat '$RELEASES_ROOT/.prev-release' 2>/dev/null || true")"
    prev_apply="printf '%s\\n' '$prev_src' > '$RELEASES_ROOT/.prev-release.tmp' && mv -f '$RELEASES_ROOT/.prev-release.tmp' '$RELEASES_ROOT/.prev-release';"
    if [[ -n "$old_prev" ]]; then
      prev_revert="printf '%s\\n' '$old_prev' > '$RELEASES_ROOT/.prev-release.tmp' && mv -f '$RELEASES_ROOT/.prev-release.tmp' '$RELEASES_ROOT/.prev-release';"
    else
      prev_revert="rm -f '$RELEASES_ROOT/.prev-release';"
    fi
  fi
  # image / image_id **恒写**:release 轴启用则用刚 inspect 的;否则从 env 取 image 并 inspect 出 id(供 stale/label/canary)。
  if hotcfg_release_axis_on; then
    image="$RUNTIME_IMAGE_REF"; image_id="$RUNTIME_IMAGE_ID"; release="$BUILT_RUNTIME_RELEASE"
  else
    if [[ "$DISABLE_RELEASE_FLAG" == 1 && -n "$EMERG_IMAGE" ]]; then
      # R3-B1:禁用 release 轴时显式切换到内嵌源码镜像(tuple 可行性守卫要求 embed_source≠0;
      # ID 就地核验,tag 漂移在此拦下而非等 saga)。
      image="$EMERG_IMAGE"
      image_id="$(ssh "$KL_HOST" "docker image inspect --format '{{.Id}}' '$image'" 2>/dev/null || true)"
      [[ "$image_id" == "$EMERG_IMAGE_ID" ]] \
        || { echo "✗ --image 的 immutable ID($image_id)与 --image-id($EMERG_IMAGE_ID)不符" >&2; return 1; }
    else
      image="$(ssh "$KL_HOST" "grep '^OC_RUNTIME_IMAGE=' '$V5_ENV' | tail -n1 | cut -d= -f2-")"
      image_id="$(ssh "$KL_HOST" "docker image inspect --format '{{.Id}}' '$image'" 2>/dev/null || true)"
    fi
    # R2-B1:release 轴禁用/未启用 → 传**空串**(恒写 OC_RUNTIME_RELEASE=,值空=禁用,--disable 后即稳态)。
    # 注:saga 内 oc_hotcfg_assert_tuple_viable 会对"镜像 embed_source=0 + 空 release"fail-loud(R3-B1)。
    release=""
  fi
  # This activation introduces a v2 writer together with its capable master.
  # Prove the actual target tuple before any saga side effect, even before the
  # first tape exists; metadata-only declarations are insufficient.
  assert_lossless_runtime_tuple_capability "$image_id" "$release" || return 1
  # bundle 轴:启用则翻新 rev + 写新绝对路径;禁用/未启用 → flip_rev 空(不翻 current)+ 写空值(R2-B1)。
  if hotcfg_bundle_axis_on; then
    flip_rev="$BUILT_BUNDLE_REV"; bundle_val="$OC_HOTCFG_PLATFORM_ROOT/bundles/$BUILT_BUNDLE_REV"
  else
    flip_rev=""; bundle_val=""
  fi
  restart_cmd="systemctl restart '$ACTIVE_UNIT'"
  # 远端核心健康门(fail-closed):ok=true + channel=v5 + sessionsDb=ok(与 smoke() 深度探活同不变量)。
  # 全量 smoke(调度器白名单等第二道防线)在 saga 提交后由 deploy() 另跑本地 smoke() 兜底。
  smoke_cmd="$(hotcfg_core_smoke_cmd)"
  # extra:master 源码 symlink 翻转(先原子落 .prev-release=prev_src,再 ln+mv -T);
  # revert(M7c):**先还原 .prev-release=old_prev**(翻转前快照),再翻回 master symlink=prev_src。
  extra_apply="$prev_apply rm -f '$ACTIVE_SRC.hotlink'; ln -s '$BUILT_RELEASE' '$ACTIVE_SRC.hotlink'; mv -T '$ACTIVE_SRC.hotlink' '$ACTIVE_SRC'"
  extra_revert="$prev_revert rm -f '$ACTIVE_SRC.hotlink'; ln -s '$prev_src' '$ACTIVE_SRC.hotlink'; mv -T '$ACTIVE_SRC.hotlink' '$ACTIVE_SRC'"
  build_hotcfg_state_hooks "$BUILT_RELEASE"
  # M7a:masterRelease=$BUILT_RELEASE(本次激活的 master 蓝绿 release)进 history,rollback 从同一条取回对齐。
  # R2-B2:prev_master=$prev_src(激活前 live master)供首次启用的 pre-state 记录。
  hotcfg_rmt oc_hotcfg_activate_saga \
    "$V5_ENV" "$OC_HOTCFG_PLATFORM_ROOT" "$flip_rev" "$OC_HOTCFG_HISTORY" \
    "$image" "$image_id" "$release" "$bundle_val" \
    "$restart_cmd" "$smoke_cmd" "$extra_apply" "$extra_revert" "$BUILT_RELEASE" "$prev_src" \
    "$HOTCFG_STATE_COMMIT_CMD" "$HOTCFG_STATE_REVERT_CMD" "$DEPLOY_RECOVERY_MARKER" "joint" \
    || { echo "✗ 激活 saga 失败,已自动回滚旧 tuple(env/current/master 源码/.prev-release/重启旧 master)" >&2; return 1; }
  ACTIVE_STATE_PREVIOUS_RELEASE="$ACTIVE_STATE_RELEASE"
  ACTIVE_STATE_RELEASE="$BUILT_RELEASE"
  ACTIVE_STATE_LOCK_VERSION=$((ACTIVE_STATE_LOCK_VERSION + 1))
  echo "  ✓ runtime tuple 激活并提交 history(release=${release:-<none>} bundle=${flip_rev:-<unchanged>} master=$BUILT_RELEASE)"
  run "sleep 3"
}

# ── 4. gc_runtime_artifacts:best-effort GC(§1.4)。失败只告警不回滚。──
gc_runtime_artifacts() {
  [[ "$DRY" == 1 ]] && { echo "  [dry-run] GC runtime-releases/platform-bundles(保护集=history N/emergency/env/docker label)"; return 0; }
  hotcfg_rmt oc_hotcfg_gc "$V5_ENV" "$OC_HOTCFG_HISTORY" 2>&1 | sed 's/^/  /' || echo "  ⚠ runtime GC 失败(仅告警,不回滚)" >&2
}

# ── 5. --emergency-tuple:写 OC_RUNTIME_EMERGENCY_TUPLE(部署 checklist 用,§1.1 / R2-M1)──
# 缺省候选=当前 env 四键;显式候选 --image=/--image-id=/--bundle=(瘦身稳态直接登记内嵌镜像逃生点,
# 不必先把现网翻到空 release)。硬验含 immutable ID 钉死(inspect .Id == image_id),见 lib 头注。
emergency_tuple() {
  echo "══ 写 emergency tuple(→ OC_RUNTIME_EMERGENCY_TUPLE)══"
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] 候选(显式 --image/--image-id/--bundle,缺省取 env 现值)→ 硬验(embed≠0 / inspect .Id==image_id / release 空 / bundle MANIFEST 全量)→ 写键 + env.bak 轮转"
    return 0
  fi
  hotcfg_rmt oc_hotcfg_write_emergency_tuple "$V5_ENV" "$EMERG_IMAGE" "$EMERG_IMAGE_ID" "$EMERG_BUNDLE" 2>&1 | sed 's/^/  /' \
    || { echo "✗ 写 emergency tuple 失败" >&2; exit 1; }
  echo "✓ emergency tuple 已写入 $V5_ENV(破坏兼容性变更后须刷新并实跑 smoke)。"
}

# ── 5b. --activate-emergency-tuple:把已登记的 emergency tuple 激活为现网 tuple(R3-B1)──
# 逃生场景(瘦身稳态下 release/bundle 产物不可用、须退回内嵌源码镜像)的一等路径:
# 读 OC_RUNTIME_EMERGENCY_TUPLE(登记时已过完整硬验:embed≠0/ID 钉死/bundle 完整门/canary)
# → 组目标 tuple{image,image_id,release="",bundle} 走**完整激活 saga**(canary+restart+smoke+
# history 记账,失败自动回滚)。master 源码不动(extra 空);再次核验 inspect .Id==登记 ID,
# 防登记后镜像被删/tag 漂移(恢复前复核,R2-M1)。
activate_emergency_tuple() {
  echo "══ 激活 emergency tuple(逃生:内嵌源码镜像 + 登记 bundle,release 置空)══"
  assert_no_rollout_in_progress
  resolve_active_lane
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] slot=$ACTIVE_SLOT 读 emergency tuple → saga{canary→env→flip current→restart $ACTIVE_UNIT→smoke $ACTIVE_PORT→history}"
    return 0
  fi
  local ej image image_id bundle rev live_id prev_src
  ej="$(ssh "$KL_HOST" "grep '^OC_RUNTIME_EMERGENCY_TUPLE=' '$V5_ENV' | tail -n1 | cut -d= -f2-")"
  [[ -n "$ej" ]] || { echo "✗ env 无 OC_RUNTIME_EMERGENCY_TUPLE(先 --emergency-tuple 登记)" >&2; exit 1; }
  image="$(jq -r '.image // empty' <<<"$ej")"; image_id="$(jq -r '.image_id // empty' <<<"$ej")"; bundle="$(jq -r '.bundle // empty' <<<"$ej")"
  [[ -n "$image" && -n "$image_id" && -n "$bundle" ]] || { echo "✗ emergency tuple JSON 字段缺失: $ej" >&2; exit 1; }
  # R4-B1:按 **tag** inspect —— 容器最终以 tag 起,必须证明 tag 此刻仍指向登记的 immutable ID
  # (按 ID inspect 只能证明旧镜像还在,发现不了 tag 已被重打)。
  live_id="$(ssh "$KL_HOST" "docker image inspect --format '{{.Id}}' '$image'" 2>/dev/null || true)"
  [[ "$live_id" == "$image_id" ]] || { echo "✗ emergency 镜像 tag↔ID 复核失败(登记 $image_id,inspect($image)=${live_id:-<gone>})—— tag 漂移或镜像被删,须重建/重打后重新登记" >&2; exit 1; }
  # R4-M1(激活侧):登记值应恒为 canonical bundles/<12hex>;再验一次防手改 env。
  rev="$(basename "$bundle")"
  [[ "$rev" =~ ^[0-9a-f]{12}$ && "$bundle" == "$OC_HOTCFG_PLATFORM_ROOT/bundles/$rev" ]] \
    || { echo "✗ emergency bundle 路径非 canonical bundles/<12hex> 形态: $bundle(重新 --emergency-tuple 登记)" >&2; exit 1; }
  ssh "$KL_HOST" "[ -d '$bundle' ]" || { echo "✗ emergency bundle 已不存在: $bundle(GC 保护集应含它,须排查)" >&2; exit 1; }
  prev_src="$(bg_current_release "$ACTIVE_SRC")"
  assert_lossless_turn_tape_floor "$prev_src"
  assert_lossless_runtime_tuple_floor "$image_id" ""
  local restart_cmd smoke_cmd
  restart_cmd="systemctl restart '$ACTIVE_UNIT'"
  smoke_cmd="$(hotcfg_core_smoke_cmd)"  # R4-M2:与正常激活同强度(含 sessionsDb=ok)
  # masterRelease=prev_src(master 源码不动,history 记当前 live);extra_apply/revert 传空。
  # RFC §1.2:进入不可逆激活 saga(env 翻转 + current + restart)前活体断言远端 lease。此刻 live tuple
  # 未改,失活即以专用 rc=86 crash-stop(saga 未起,无需回滚/cleanup)。
  assert_mutation_lease_alive "emergency-tuple-flip" || { echo "✗ production-mutation lease 失活;crash-stop(live 未改)" >&2; exit 86; }
  hotcfg_rmt oc_hotcfg_activate_saga \
    "$V5_ENV" "$OC_HOTCFG_PLATFORM_ROOT" "$rev" "$OC_HOTCFG_HISTORY" \
    "$image" "$image_id" "" "$bundle" \
    "$restart_cmd" "$smoke_cmd" "" "" "$prev_src" "$prev_src" \
    "" "" "$DEPLOY_RECOVERY_MARKER" "tuple-only" \
    || { echo "✗ emergency 激活 saga 失败,已自动回滚" >&2; exit 1; }
  # 审计 10:逃生通道换掉的正是「执行 agent turn 的容器镜像」,而此前唯一证据是 hotcfg saga 里的
  # 三字段 healthz —— master 的 /healthz 根本不经过容器。挂**非阻断**真 turn:不给逃生通道加阻断门
  # (那会把救援自我否决),但「逃生成功」必须有活体证据,而不是只证明 master 进程还活着。
  smoke_turn_canary_advisory "$prev_src" "emergency-tuple 激活"
  echo "✓ emergency tuple 已激活(image=$image release=<empty> bundle=$rev);存量容器按 runtimeStale 滚动。"
}

# 一次性迁移:实目录 $REMOTE_SRC → symlink 布局(须在无并发部署的受控窗口跑)。
migrate_to_bluegreen() {
  echo "══ v5 迁移蓝绿 symlink 布局 on $KL_HOST ══"
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] 已 symlink 则强 marker 校验后跳过;否则钉 full commit+metadata 原始字节→stop→mv→写 strong .complete→ln -s→start→smoke"
    return 0
  fi
  # R2#3:幂等跳过必须是**合法**蓝绿布局(指向 rel-* 且带 .complete),不能见 symlink 就当已迁移
  if ssh "$KL_HOST" "test -L '$REMOTE_SRC'"; then
    local migrated_current
    migrated_current="$(bg_current_release "$REMOTE_SRC")"
    if [[ -n "$migrated_current" && "$migrated_current" == "$CAPTURED_RELEASE_PREDECESSOR" ]] \
        && assert_release_marker "$migrated_current"; then
      echo "  ✓ 已是合法蓝绿布局,幂等跳过"; return 0
    fi
    echo "✗ $REMOTE_SRC 是 symlink 但 marker/血缘不可信,拒绝自动迁移,人工处置" >&2; return 1
  fi
  # 实目录首次迁移没有旧 marker 可用。首写前从 VERSION.short 唯一解析 trusted local
  # full commit，并逐字节比对该 commit 的 release metadata；unknown/漂移一律拒绝。
  local sha full_sha ts reldir
  sha="$(ssh "$KL_HOST" "jq -er '.commit | select(type == \"string\")' '$REMOTE_SRC/VERSION.json'")" || return 1
  [[ "$sha" =~ ^[0-9a-f]{7,40}$ ]] || { echo "✗ 实目录 VERSION.commit 非法:$sha" >&2; return 1; }
  full_sha="$(git -C "$REPO_ROOT" rev-parse --verify "${sha}^{commit}" 2>/dev/null || true)"
  [[ "$full_sha" =~ ^[0-9a-f]{40}$ && "$full_sha" == "$sha"* ]] || {
    echo "✗ 实目录 VERSION short SHA 无法唯一解析:$sha" >&2; return 1;
  }
  assert_release_metadata_matches_commit "$REMOTE_SRC" "$full_sha" || return 1
  # Legacy real-directory migration is another old-code restart path. Establish
  # the reservation before changing modes or stopping/starting that process.
  echo "── 蓝绿迁移前建立 CCB baseline 安全边界 ──"
  install_v5_slot_units || return 1
  harden_release_baseline "$REMOTE_SRC" || return 1
  strip_shared_baseline_env_keys || return 1
  assert_release_baseline_security "$REMOTE_SRC" || return 1
  ts="$(date -u +%Y%m%d-%H%M%S)"
  reldir="$RELEASES_ROOT/rel-$sha-$ts-migrated"
  echo "── 停机 → 实目录搬入 $reldir → 写 strong .complete → symlink → 启动(一次性,几秒停机;ERR 自动恢复贯穿 start)──"
  # ERR trap 覆盖到 start 成功之后才 `trap - ERR`(R2#3:start 失败也回滚);restore 处理已建 symlink 状态
  {
    declare -f release_artifact_digest write_strong_release_marker_local
    cat <<'REMOTE'
set -Eeuo pipefail
remote_src="$1"; releases_root="$2"; reldir="$3"; unit="$4"
full_sha="$5"; short_sha="$6"; built_at="$7"; schema="$8"
mkdir -p "$releases_root"
test ! -e "$reldir"
systemctl stop "$unit"
    moved=0; linked=0
    restore() {
      [ "$linked" = 1 ] && rm -f "$remote_src"
      if [ "$moved" = 1 ] && [ ! -e "$remote_src" ] && [ -d "$reldir" ]; then mv "$reldir" "$remote_src" || true; fi
      systemctl start "$unit" || true; echo 'FATAL: 迁移失败,已尽力恢复实目录并启动旧服务' >&2; }
    trap restore ERR
mv "$remote_src" "$reldir"; moved=1
write_strong_release_marker_local "$reldir" "$full_sha" "$short_sha" "$built_at" "$schema"
ln -s "$reldir" "$remote_src"; linked=1
systemctl start "$unit"
trap - ERR
REMOTE
  } | ssh "$KL_HOST" bash -s -- "$REMOTE_SRC" "$RELEASES_ROOT" "$reldir" "$V5_UNIT" \
    "$full_sha" "$sha" "$ts" "$RELEASE_COMPLETE_SCHEMA_VERSION" \
    || { echo "✗ 迁移执行失败(见上 FATAL 恢复日志)" >&2; return 1; }
  run "sleep 4"
  if ! smoke; then
    echo "✗ 迁移后 smoke 失败,自动回切实目录布局并重启旧服务" >&2
    ssh "$KL_HOST" "set -e; systemctl stop '$V5_UNIT' || true
      [ -L '$REMOTE_SRC' ] && rm -f '$REMOTE_SRC'
      if [ ! -e '$REMOTE_SRC' ] && [ -d '$reldir' ]; then mv '$reldir' '$REMOTE_SRC'; fi
      systemctl start '$V5_UNIT'" || echo "✗ 自动回切也失败,人工核查 $reldir 与 $REMOTE_SRC" >&2
    return 1
  fi
  echo "✓ 蓝绿布局迁移完成:$REMOTE_SRC → $reldir"
}

assert_v5_master_inactive() {
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] 断言 $V5_UNIT inactive"
    return 0
  fi
  local state
  state="$(ssh "$KL_HOST" "systemctl is-active '$V5_UNIT' 2>/dev/null || true")"
  [[ "$state" == "inactive" || "$state" == "failed" ]] || {
    echo "✗ 要求 $V5_UNIT 已停机,当前 state=${state:-unknown}" >&2
    exit 1
  }
}

assert_v3_inactive_for_gpt_cutover() {
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] 断言 openclaude-v3 inactive(GPT-5.5 共享库退役前置)"
    return 0
  fi
  local state
  state="$(ssh "$KL_HOST" "systemctl is-active openclaude-v3 2>/dev/null || true")"
  [[ "$state" == "inactive" || "$state" == "failed" || "$state" == "unknown" ]] || {
    echo "✗ GPT-5.5 共享库切换要求 openclaude-v3 已退役停机,当前 state=${state:-unknown}" >&2
    exit 1
  }
  echo "  ✓ openclaude-v3 已停机(GPT-5.5 可安全退役)"
}

assert_clean_source_tree() {
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] 断言本地部署树无 staged/unstaged/untracked 改动"
    return 0
  fi
  local dirty
  dirty="$(git -C "$REPO_ROOT" status --porcelain --untracked-files=all)"
  [[ -z "$dirty" ]] || {
    echo "✗ 拒绝从脏工作树 stage/activate:VERSION 与 runtime image 无法证明对应 HEAD" >&2
    printf '%s\n' "$dirty" >&2
    exit 1
  }
}

snapshot_and_sync_source() {
  echo "── 快照 $REMOTE_SRC → .prev.1(轮转 1..5)──"
  sshk "set -e; for n in 5 4 3 2 1; do m=\$((n+1)); if [ -d '$REMOTE_SRC.prev.'\$n ]; then if [ \$m -le 5 ]; then rm -rf '$REMOTE_SRC.prev.'\$m; mv '$REMOTE_SRC.prev.'\$n '$REMOTE_SRC.prev.'\$m; else rm -rf '$REMOTE_SRC.prev.'\$n; fi; fi; done; rm -rf '$REMOTE_SRC.prev.6'; rsync -a --delete ${RSYNC_EXCLUDES[*]} '$REMOTE_SRC/' '$REMOTE_SRC.prev.1/'"
  # 半同步窗口缓解(2026-07-11 并发部署崩溃循环事故;注意:缓解非根治,见下)。
  # 事故根因:systemd ExecStart 直接 tsx 解释 live 源码树(WorkingDirectory=$REMOTE_SRC)+
  # Restart=on-failure/RestartSec=5。旧实现裸 `--delete` in-place rsync 让 live 树在整个传输期
  # (秒级)处于半同步态;此窗口内 master 若被拉起(systemd 自动重启 / 并发 deploy 的 restart /
  # 运行中崩溃)就读到半同步树 → tsx import 报错 exit 1,每 5s 崩溃重启直到 rsync 完成
  # (实测 6 次/~60s,smoke 误判失败)。
  # 本改动:`--delay-updates`(更新先写临时名,传输末尾批量 rename)+ `--delete-after`(删除挪到
  # 传输之后)→ 传输期 live 树基本保持旧完整态,不一致窗口从"整段传输"**缩短**到"末尾 rename/
  # delete 逐项突发"(亚秒级,非事务原子)。因此**只显著降低概率、不能 100% 消除**:systemd 若恰在
  # 该突发窗口启动,仍可能失败一次(下次 5s 重启时同步已结束,不再 60s 循环)。
  # 未采用运行中整目录 swap:running master 的 cwd 与打开的 data/ SQLite 在 $REMOTE_SRC 内,搬目录
  # 会撕裂其相对路径写入/split-brain(rollback 路径能整目录 swap 是因为它先 systemctl stop)。
  # 若要 100% 保证不从混合源码启动:改 systemctl stop→rsync→start(几秒计划停机),或长期改
  # "外置持久数据 + 不可变 release 目录 + 原子 current 指针"架构(见 playbook §5 债)。
  echo "── rsync v5 源码(--delay-updates:缩短半同步窗口,非根治)──"
  run "rsync -az --delete-after --delay-updates ${RSYNC_EXCLUDES[*]} '$REPO_ROOT/' '$KL_HOST:$REMOTE_SRC/'"
  write_version
}

# dist 生效面的**单一权威**构建+同步实现(stage / --dist / deploy --with-dist 三处共用,
# 不许再复制)。副作用:设全局 DIST_BUILD_ID 供 dist_handshake_smoke 校验。不含 restart。
DIST_BUILD_ID=""
build_and_sync_dist() {
  echo "── web official build(tsc + vite) ──"
  run "(cd '$REPO_ROOT' && npm run build --workspace packages/web-react)"
  local dist="$REPO_ROOT/packages/web-react/dist"
  if [[ "$DRY" != 1 ]]; then
    DIST_BUILD_ID="$(grep -o 'name="oc-build" content="[0-9a-f]\{8,32\}"' "$dist/index.html" | grep -o '[0-9a-f]\{8,32\}' | head -1)"
    [[ -n "$DIST_BUILD_ID" ]] || { echo "✗ dist/index.html 缺 oc-build meta(vite ocBuildMeta 插件失效?)" >&2; exit 1; }
    echo "  本地构建 oc-build: $DIST_BUILD_ID"
  fi
  echo "── rsync assets(加法,必须先于根文件)──"
  run "rsync -az '$dist/assets/' '$KL_HOST:$REMOTE_SRC/packages/web-react/dist/assets/'"
  echo "── rsync 根文件(--delete,排除 assets)──"
  run "rsync -az --delete --exclude assets '$dist/' '$KL_HOST:$REMOTE_SRC/packages/web-react/dist/'"
  echo "── GC:清 14 天未被任何构建 ship 的旧资产 ──"
  sshk "find '$REMOTE_SRC/packages/web-react/dist/assets' -type f -mtime +14 -delete"
}

# 版本握手 smoke:线上 oc-build 必须等于本地刚构建的 DIST_BUILD_ID(fail-closed)。
dist_handshake_smoke() {
  [[ "$DRY" == 1 ]] && return 0
  local sport="${1:-$V5_PORT}"
  echo "── 版本握手 smoke:线上 oc-build == 本地构建(fail-closed;port=$sport)──"
  local live_id
  if ! live_id="$(ssh "$KL_HOST" "curl -fsS http://127.0.0.1:${sport}/" | grep -o 'name="oc-build" content="[0-9a-f]\{8,32\}"' | grep -o '[0-9a-f]\{8,32\}' | head -1)"; then
    echo "✗ 无法读取线上 oc-build(port=$sport)" >&2
    return 1
  fi
  [[ -n "$DIST_BUILD_ID" && "$live_id" == "$DIST_BUILD_ID" ]] || {
    echo "✗ 线上 oc-build=${live_id:-空} ≠ 期望 ${DIST_BUILD_ID:-空}(release/dist 握手失败)" >&2
    return 1
  }
  echo "  ✓ 线上 oc-build: $live_id"
  # 2026-07-26(审计 8②③):版本字符串对上 ≠ 页面能加载。资产是**加法式** rsync 进 union 池的,
  # 一次部分失败就是用户白屏而握手照样绿;admin.html 更是 vite 第二入口且**故意不注入 oc-build**,
  # 只校验 index.html 时 admin 后台整体白屏可以带门全绿上线。故握手必须连带资产可达性一起判。
  verify_asset_surface "$sport" || return 1
}

# ───────────────────────── smoke:健康 + 隔离断言 ─────────────────────────
smoke() {
  # V5_PORT/smoke 参数化(RFC D5;$1=探测端口,默认 A 的 18790)。finalize 后 candidate 已成 leader,
  # 用其端口跑本 smoke 即验证"新 active 完整健康+leader 形态"。
  local sport="${1:-$V5_PORT}"
  echo "── v5 smoke(健康 + 隔离断言;port=$sport)──"
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] /healthz 深度健康、leadership、调度器/环境/端口/隔离断言"
    return 0
  fi
  local hz=""; local i
  for i in $(seq 1 10); do
    hz="$(ssh "$KL_HOST" "curl -fsS http://127.0.0.1:${sport}/healthz" 2>/dev/null || true)"
    if [[ -n "$hz" ]] && echo "$hz" | jq -e '.ok == true and .runtime.leadership.state == "leader"' >/dev/null 2>&1; then
      break
    fi
    echo "  /healthz/leadership 未就绪,重试 $i/10..."; sleep 2
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
  # 双 master 下两槽 env 都是 eligibility=1，静态 OC_CONTROL_PLANE_LEADER 已不能代表此刻
  # 的单 leader。以 healthz.runtime.leadership.state 为唯一实时判据；follower 只允许
  # local/v5-owned eager 项，LeaderBundle 成员只能出现在 state=leader 的实例。
  local leadership
  leadership="$(jq -r '.runtime.leadership.state // empty' <<<"$hz" 2>/dev/null || true)"
  [[ "$leadership" =~ ^(leader|standby|ineligible|acquiring|fenced)$ ]] || {
    echo "✗ healthz.runtime.leadership.state 缺失/非法:${leadership:-<empty>}" >&2; return 1; }
  [[ "$leadership" == leader ]] || {
    echo "✗ stable active leadership=$leadership(必须为 leader；candidate standby 使用 candidate_self_check)" >&2
    return 1
  }
  local scheds allowed bad
  scheds="$(echo "$hz" | grep -o '"schedulers":\[[^]]*\]' | sed 's/.*\[//;s/\]//;s/"//g')"
  #   cronWake(cron 触发权威上移,dae6d97d:cron_wake_index 为 v5 引入表(0119)且按
  #     runtime_channel 行级隔离;只唤醒容器不做执行/送达。关停:COMMERCIAL_CRON_WAKE_DISABLED=1)
  #   connectorSweeper(应用连接器,0130 三表均 v5 引入/v3 无代码:stale executing→unknown、
  #     确认过期销毁 params、OAuth pending 过期清理、ledger retention。关停:OC_CONNECTOR_SWEEPER_DISABLED=1)
  #   knowledgePlanetAutomation(知识星球无人值守回复,只写 0168 的 v5 专属表；用户开关
  #     默认关闭,且挂 LeaderBundle 单 leader。关停:OC_KNOWLEDGE_PLANET_AUTOMATION_DISABLED=1)
  #   imageUsageSweep / githubWorkspaceSweeper 均由 index.ts 明确登记为 v5-owned，
  #     分别收敛生图旅程与临时 GitHub workspace；只允许 v5 leader 启动。
  #   sessionsGcSweep(P2 会话权威迁 PG:usage 聚合 pending/map 老化 GC,advisory lease fencing,
  #     仅 OC_SESSIONS_STORE=pg 时启动——白名单允许≠必然存在。RFC-v5-sessions-pg D3)
  allowed="subscriptionRollover accountSlotReaper researchJobs codexRefresh codexDriftReconciler marketplaceAiReview providerHealth sessionsGcSweep incidentSnapshot"
  allowed="$allowed idleSweep volumeGc orphanReconcile migrationReconcile healthPoller containerEvents alert refreshEventsSweep auditRetentionSweep imageUsageSweep cooldownRecovery pendingOrdersExpirer finalizeReconciler turnDispatchReconciler onboarding inboxEmail cronWake incidentReconciler incidentSweeper connectorSweeper knowledgePlanetAutomation githubWorkspaceSweeper wecomAlert userNoticeApproval"
  bad=""
  IFS=',' read -ra _sarr <<<"$scheds"
  for s in "${_sarr[@]}"; do
    [[ -z "$s" ]] && continue
    grep -qw "$s" <<<"$allowed" || bad="$bad $s"
  done
  [[ -n "$bad" ]] && { echo "✗ shared 域 scheduler 泄漏到 v5:$bad" >&2; return 1; }
  echo "$hz" | grep -q '"controlPlaneEnabled":true' || { echo "✗ 双 master eligibility(controlPlaneEnabled)非 true" >&2; return 1; }
  echo "$hz" | grep -q '"agentRuntime":"disabled"' || { echo "✗ agentRuntime 非 disabled(不应起 legacy agent 运行时)" >&2; return 1; }
  local ver; ver="$(ssh "$KL_HOST" "curl -fsS http://127.0.0.1:${sport}/version" 2>/dev/null || true)"
  echo "  /version: $ver"
  # 现网 v3 零影响断言:v3 服务仍在跑才断言;已退役停服(inactive)则跳过。
  local v3active
  v3active="$(ssh "$KL_HOST" "systemctl is-active openclaude-v3 2>/dev/null" || true)"
  if [[ "$v3active" == "active" ]]; then
    local v3hz; v3hz="$(ssh "$KL_HOST" "curl -fsS http://127.0.0.1:18789/healthz" 2>/dev/null || true)"
    echo "  v3 /healthz(应不受影响): $v3hz"
    [[ -z "$v3hz" ]] && { echo "✗ v3 /healthz 异常 —— 现网受影响!" >&2; return 1; }
  else
    echo "  v3 已停服(退役,is-active=$v3active),跳过 v3 零影响断言"
  fi
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
    EGRESS_HEALTH_JSON="$eg"
  fi
  # 模型权威(flag 开启后):master 与 egress 两个**活体进程**都必须广播 capability。
  # 制品面(release metadata / MANIFEST / 镜像 label)由激活期地板守卫;这里补的是"进程真的
  # 换上了新代码"——egress 默认不随 deploy 重启,最容易出现"master 新 / egress 旧"的错配
  # (R4-m6:master 新 + egress 旧必拒)。flag 未开 → 影子期,不断言(旧 egress 合法存活)。
  local ma_flag
  ma_flag="$(ssh "$KL_HOST" "test -r '$V5_ENV' && grep -E '^OC_MODEL_AUTHORITY=' '$V5_ENV' | tail -n 1 | cut -d= -f2-" 2>/dev/null || true)"
  if [[ "$ma_flag" == "1" ]]; then
    local mcaps
    mcaps="$(printf '%s' "$hz" | jq -r '(.runtime.capabilities // []) | join(" ")' 2>/dev/null || true)"
    caps_contain "$mcaps" "$MODEL_AUTHORITY_CAP" \
      || { echo "✗ OC_MODEL_AUTHORITY=1 但 master /healthz 未广播 '$MODEL_AUTHORITY_CAP'(caps=[${mcaps:-<none>}])—— 旧 master 版本" >&2; return 1; }
    [[ "$split" == "1" ]] \
      || { echo "✗ OC_MODEL_AUTHORITY=1 但 OC_EGRESS_SPLIT≠1 —— /v1/messages 的 epoch fence 面无法证明" >&2; return 1; }
    local ecaps
    ecaps="$(printf '%s' "${EGRESS_HEALTH_JSON:-}" | jq -r '(.capabilities // []) | join(" ")' 2>/dev/null || true)"
    caps_contain "$ecaps" "$MODEL_AUTHORITY_EGRESS_CAP" \
      || { echo "✗ OC_MODEL_AUTHORITY=1 但 egress 未广播 '$MODEL_AUTHORITY_EGRESS_CAP'(caps=[${ecaps:-<none>}])—— 旧 egress 进程无每请求 epoch fence;修法:deploy-v5.sh --egress" >&2; return 1; }
    echo "  ✓ 模型权威:master=[$mcaps] egress=[$ecaps](flag=1,两进程活体 capability 齐)"
  fi
  local baseline_slot
  case "$sport" in
    18790) baseline_slot=A ;;
    18795) baseline_slot=B ;;
    *) echo "✗ 无法由 smoke port=$sport 判定 slot baseline 路径" >&2; return 1 ;;
  esac
  assert_live_baseline_security_for_slot "$baseline_slot" || return 1
  echo "✓ v5 smoke 通过:隔离空壳健康、控制面静默、v3 未受影响"
}

# ───────────────────────── bootstrap:首次建立 v5 ─────────────────────────
bootstrap() {
  echo "══ v5 bootstrap on $KL_HOST ══"
  echo "── 守卫:overrides 不得含 REMOVE_KEYS ──"
  assert_overrides_no_remove_keys
  # bootstrap 也支持已有实例的恢复重跑。rsync 本身会改 baseline mode/内容，
  # 因而端口占位必须早于任何 live tree 写入，而不只是早于显式 harden。
  echo "── 0.5) live tree 写入前安装并实测 CCB 端口守卫 ──"
  install_v5_slot_units
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
  echo "── 2.5) 收紧并验证初始 CCB baseline(端口守卫已生效)──"
  harden_release_baseline "$REMOTE_SRC"
  # 3) HOME + openclaude.json(从 v3 派生:改 gateway.port/bind、清空 channels)
  #
  # 【存在性守卫,2026-07-11 事故】openclaude.json / env 一旦存在即为现网权威,
  # 重跑 bootstrap(如崩溃恢复)绝不重建 —— 07-11 事故恢复重跑 bootstrap,
  # env 从 v3 env(已退役、内容陈旧)回灌,冲掉 07-10 热修的 RESEND_API_KEY,
  # 验证邮件全断且无痕。派生逻辑只服务"文件不存在"的真·初装场景。
  echo "── 3) $V5_HOME/openclaude.json(port=$V5_PORT, channels 清空)──"
  sshk "mkdir -p '$V5_HOME'"
  # 从 v3 的 openclaude.json 派生:改 gateway.port/bind/accessToken、清空 channels(P0 壳不跑渠道)
  sshk "if [ -f '$V5_HOME/openclaude.json' ]; then echo '  ⚠ openclaude.json 已存在 → 保留现网文件(权威=现网),跳过派生'; else jq '.gateway.port=${V5_PORT} | .gateway.bind=\"127.0.0.1\" | .gateway.accessToken=\"commercial-v5-unused\" | .channels={}' /root/.openclaude/openclaude.json > '$V5_HOME/openclaude.json'; fi"
  # 4) env:拷 v3 env → 删 REMOVE_KEYS → 追加 v5 覆盖键(仅当 $V5_ENV 不存在)
  echo "── 4) $V5_ENV(派生自 v3 + 覆盖;已存在则保留现网)──"
  local rmpat; rmpat="$(IFS='|'; echo "${REMOVE_KEYS[*]}")"
  run "rsync -az '$REPO_ROOT/deploy/v5/commercial-v5.env.overrides' '$KL_HOST:/tmp/commercial-v5.env.overrides'"
  sshk "set -e; if [ -f '$V5_ENV' ]; then echo '  ⚠ $V5_ENV 已存在 → 保留现网 env(权威=现网文件,含热修密钥),跳过派生;如确要重建请先手动移走该文件'; exit 0; fi; preserved_secret=''; pid=\$(systemctl show -p MainPID --value openclaude-v5-egress 2>/dev/null || true); if [ -n \"\$pid\" ] && [ \"\$pid\" != 0 ] && [ -r /proc/\$pid/environ ]; then preserved_secret=\$(tr '\\0' '\\n' < /proc/\$pid/environ | sed -n 's/^OC_EGRESS_SECRET=//p' | tail -n 1 || true); fi; if [ -z \"\$preserved_secret\" ]; then preserved_secret=\$(openssl rand -hex 32); fi; grep -Ev '^[[:space:]]*(${rmpat})=' '$V3_ENV' > '$V5_ENV.tmp' && { echo ''; echo '# ===== v5 overrides (deploy-v5.sh) ====='; cat /tmp/commercial-v5.env.overrides; printf '\nOC_EGRESS_SECRET=%s\n' \"\$preserved_secret\"; } >> '$V5_ENV.tmp' && mv '$V5_ENV.tmp' '$V5_ENV' && chmod 600 '$V5_ENV'"
  echo "── 4.5) release metadata 数据库前置硬门 ──"
  assert_repo_required_migrations
  assert_0151_runtime_privileges
  # 5) A/B + baseline guard 已在首次 harden 前安装；此处补 egress unit。
  echo "── 5) 安装 $V5_EGRESS_UNIT(A/B + baseline guard 已验证)──"
  run "rsync -az '$REPO_ROOT/deploy/v5/$V5_EGRESS_UNIT' '$KL_HOST:/etc/systemd/system/$V5_EGRESS_UNIT'"
  # bootstrap 没有旧 egress release 可做 saga；先把独立指针绑定初始 A 源码。后续普通
  # deploy --egress 会把它钉到对应不可变 release，且失败自动回切。
  sshk "set -e; rm -f '$V5_EGRESS_SRC.newlink.bootstrap'; ln -s '$REMOTE_SRC' '$V5_EGRESS_SRC.newlink.bootstrap'; mv -Tf '$V5_EGRESS_SRC.newlink.bootstrap' '$V5_EGRESS_SRC'"
  sshk "systemctl daemon-reload"
  strip_shared_baseline_env_keys
  # 5.5) 部署顺序守卫:P1a channel-aware 代码需共享库已加 runtime_channel 列(0088)。
  echo "── 5.5) 部署顺序守卫:校验 runtime_channel 列(0088)已应用 ──"
  assert_runtime_channel_column
  # 5.6) 模型权威地板的 DR 守卫(方案 §7 步 5)。
  # bootstrap 是**唯一**会重新派生 env 的路径(从 v3 env + overrides),而 cutover marker 的
  # 进程侧信号就在 env 里 —— 不补回来,重建后的 master 会以 baked 判定**静默**起来(flag 丢了,
  # 地板断言也看不到 marker),正是 R3-B4 要根治的那类分叉。DB marker 是跨主机权威,故以它为准。
  echo "── 5.6) 模型权威:按 DB cutover marker 回填 env(flag + marker)──"
  restore_model_authority_env_after_bootstrap
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

# egress 是全局单实例，不能直接使用任何 master slot 的 WorkingDirectory。显式
# --egress 才把独立 symlink 原子切到本次不可变 release；restart/活体/进程 cwd 任一
# 失败都回切调用方在部署起手时钉住的旧 release。unit 本身也从目标 release 安装，
# 防止源码与 systemd 声明跨代。
EGRESS_READY_LAST_STATE=""; EGRESS_READY_LAST_PID=""; EGRESS_READY_LAST_CWD=""; EGRESS_READY_LAST_HEALTH=""

# egress 冷启动会先加载 pricing/catalog/host identity，再 bind 18892；固定 sleep 会在宿主
# 抖动时把“尚未 ready”误判成坏 release。单次探针把 systemd/PID/cwd/health 绑在同一轮，
# 整个 SSH+curl transport 由本地 timeout 钉死，供下面绝对截止轮询消费。
egress_release_ready_once() { # <expected-release> <require-authority-cap:0|1> <request-timeout-seconds>
  local expected="$1" require_cap="$2" request_timeout="${3:-2}" raw health_b64
  raw="$(timeout --signal=KILL "${request_timeout}s" ssh "$KL_HOST" "set +e
    state=\$(systemctl is-active '$V5_EGRESS_UNIT' 2>/dev/null || true)
    pid=\$(systemctl show -p MainPID --value '$V5_EGRESS_UNIT' 2>/dev/null || true)
    cwd=''
    if [[ \"\$pid\" =~ ^[1-9][0-9]*\$ ]]; then cwd=\$(readlink -f \"/proc/\$pid/cwd\" 2>/dev/null || true); fi
    hz=\$(curl -fsS --max-time '$request_timeout' http://172.31.0.1:18892/internal/v5/egress-health 2>/dev/null || true)
    printf '%s\\n%s\\n%s\\n' \"\$state\" \"\$pid\" \"\$cwd\"
    printf '%s' \"\$hz\" | base64 -w0
    printf '\\n'" 2>/dev/null)" || raw=""

  local -a lines=()
  mapfile -t lines <<<"$raw"
  EGRESS_READY_LAST_STATE="${lines[0]:-}"
  EGRESS_READY_LAST_PID="${lines[1]:-}"
  EGRESS_READY_LAST_CWD="${lines[2]:-}"
  health_b64="${lines[3]:-}"
  EGRESS_READY_LAST_HEALTH=""
  if [[ -n "$health_b64" ]]; then
    EGRESS_READY_LAST_HEALTH="$(printf '%s' "$health_b64" | base64 -d 2>/dev/null || true)"
  fi

  [[ "$EGRESS_READY_LAST_STATE" == active \
    && "$EGRESS_READY_LAST_PID" =~ ^[1-9][0-9]*$ \
    && "$EGRESS_READY_LAST_CWD" == "$expected" ]] || return 1
  jq -e '.ok == true and .role == "egress"' >/dev/null 2>&1 \
    <<<"$EGRESS_READY_LAST_HEALTH" || return 1
  if [[ "$require_cap" == 1 ]]; then
    jq -e --arg cap "$MODEL_AUTHORITY_EGRESS_CAP" '.capabilities | index($cap) != null' \
      >/dev/null 2>&1 <<<"$EGRESS_READY_LAST_HEALTH" || return 1
  fi
  return 0
}

wait_for_egress_release_ready() { # <expected-release> <require-authority-cap:0|1> [timeout-seconds]
  local expected="$1" require_cap="$2" wait_seconds="${3:-30}" deadline remaining request_timeout
  [[ "$require_cap" =~ ^[01]$ && "$wait_seconds" =~ ^[1-9][0-9]*$ ]] || {
    echo "✗ egress readiness 参数非法(require_cap=$require_cap timeout=$wait_seconds)" >&2
    return 2
  }
  deadline=$((SECONDS + wait_seconds))
  EGRESS_READY_LAST_STATE=""; EGRESS_READY_LAST_PID=""; EGRESS_READY_LAST_CWD=""; EGRESS_READY_LAST_HEALTH=""
  echo "── 有界轮询等待 egress release ready(≤${wait_seconds}s,cwd=$expected,cap=$require_cap)──"
  while (( SECONDS < deadline )); do
    remaining=$((deadline - SECONDS))
    request_timeout="$remaining"; (( request_timeout > 2 )) && request_timeout=2
    (( request_timeout < 1 )) && request_timeout=1
    if egress_release_ready_once "$expected" "$require_cap" "$request_timeout"; then
      echo "  ✓ egress ready(state=$EGRESS_READY_LAST_STATE pid=$EGRESS_READY_LAST_PID cwd=$EGRESS_READY_LAST_CWD)"
      return 0
    fi
    (( SECONDS >= deadline )) && break
    sleep 1
  done
  echo "✗ egress 在 ${wait_seconds}s 内未从预期 release 就绪:$expected" >&2
  echo "  last state=${EGRESS_READY_LAST_STATE:-<empty>} pid=${EGRESS_READY_LAST_PID:-<empty>} cwd=${EGRESS_READY_LAST_CWD:-<empty>}" >&2
  echo "  last egress health: ${EGRESS_READY_LAST_HEALTH:-<empty>}" >&2
  return 1
}

# Official managed-browser Plugin publication is a deploy-time operation, never a
# gateway-startup side effect. Human verification is an explicit pre-deploy lane:
# it exercises the exact pinned image and all declared actions, then leaves only a
# short-lived encrypted, candidate-bound account handoff. Normal deploy is strictly
# noninteractive and fails fast before activation when a new candidate lacks it.
knowledge_planet_candidate_commit() {
  [[ "$BUILT_RELEASE_SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || {
    echo "✗ Knowledge Planet candidate source commit is not pinned" >&2
    return 1
  }
  printf '%s' "$BUILT_RELEASE_SOURCE_COMMIT"
}

KNOWLEDGE_PLANET_BUILD_STATE_FILE=""
knowledge_planet_build_release_mutation() {
  [[ -n "$KNOWLEDGE_PLANET_BUILD_STATE_FILE" ]] || return 2
  build_release || return $?
  printf '%s\n%s\n' "$BUILT_RELEASE" "$BUILT_RELEASE_SOURCE_COMMIT" \
    >"$KNOWLEDGE_PLANET_BUILD_STATE_FILE"
}

knowledge_planet_plugin_verify_user() {
  echo "══ Knowledge Planet Plugin preverification(user=$KNOWLEDGE_PLANET_VERIFY_USER)══"
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] clean pinned release → exact-image existing-account reuse or one QR → 15 actions → encrypted handoff"
    return 0
  fi
  assert_no_rollout_in_progress
  resolve_active_lane
  assert_bluegreen_layout "$ACTIVE_SRC"
  # C7:全局 production-mutation lease 只围绕 build_release(唯一写共享不可变 release 命名空间的段)窄取窄放;
  # 下方 ssh --verify-user 的**人工扫码轮询窗(≤4min)**只是浏览器登录 + 写 /run 加密 handoff 文件,
  # 不动任何生产共享状态,故**不持全局 lease**——避免像旧实现那样跨扫码窗焊住 lease、饿死紧急自愈 host-action。
  # "同一时刻至多一个 verifier / 不与部署对撞"仍由入口的 KP-verify 专用锁(fd 9)+ 全局 deploy lock(fd 8)保证。
  # 锁序:deploy lock(fd 8)→ KP-verify lock(fd 9)→ 全局 lease(此处,先本地后远端,与既有约定一致)。
  acquire_production_mutation_lease || { echo "✗ 未取得 production-mutation lease;拒绝构建 Knowledge Planet 验证 release" >&2; return 3; }
  if ! capture_trusted_release_predecessor; then
    release_production_mutation_lease
    echo "✗ 无法在 Knowledge Planet build 首写前捕获可信 serving predecessor" >&2
    return 3
  fi
  local build_rc=0 kp_errexit_was_on=0
  local -a build_state=()
  KNOWLEDGE_PLANET_BUILD_STATE_FILE="$(mktemp "${TMPDIR:-/tmp}/oc-v5-kp-build-state.XXXXXX")" || {
    release_production_mutation_lease
    return 3
  }
  [[ $- == *e* ]] && kp_errexit_was_on=1
  set +e
  run_mutation_lane_supervised knowledge_planet_build_release_mutation
  build_rc=$?
  [[ "$kp_errexit_was_on" == 1 ]] && set -e
  release_production_mutation_lease
  if [[ "$build_rc" == 0 ]]; then
    mapfile -t build_state <"$KNOWLEDGE_PLANET_BUILD_STATE_FILE"
  fi
  rm -f -- "$KNOWLEDGE_PLANET_BUILD_STATE_FILE"
  KNOWLEDGE_PLANET_BUILD_STATE_FILE=""
  [[ "$build_rc" == 0 ]] || { echo "✗ Knowledge Planet verification release build failed/crash-stopped(rc=$build_rc)" >&2; return "$build_rc"; }
  [[ "${#build_state[@]}" == 2 && "${build_state[0]}" == "$RELEASES_ROOT"/rel-* \
    && "${build_state[1]}" =~ ^[0-9a-f]{40}$ ]] || {
    echo "✗ Knowledge Planet supervised build state missing/invalid" >&2
    return 1
  }
  BUILT_RELEASE="${build_state[0]}"
  BUILT_RELEASE_SOURCE_COMMIT="${build_state[1]}"
  local source_commit
  source_commit="$(knowledge_planet_candidate_commit)" || return 1
  echo "── 人工扫码验证窗(不持全局 lease;紧急自愈 host-action 此窗内可正常抢锁)──"
  ssh "$KL_HOST" "set -a; . '$V5_ENV'; set +a
    export OC_KNOWLEDGE_PLANET_SOURCE_COMMIT='$source_commit'
    cd '$BUILT_RELEASE'
    npx --no-install tsx packages/commercial/scripts/seed-knowledge-planet-plugin.ts '--verify-user=$KNOWLEDGE_PLANET_VERIFY_USER'"
}

knowledge_planet_plugin_smoke_gate() { # <pinned master release>
  local release="$1"
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] noninteractive exact-image Knowledge Planet approval/handoff gate @ $release"
    return 0
  fi
  local source_commit
  source_commit="$(knowledge_planet_candidate_commit)" || return 1
  ssh "$KL_HOST" "set -a; . '$V5_ENV'; set +a
    export OC_KNOWLEDGE_PLANET_SOURCE_COMMIT='$source_commit'
    cd '$release'
    npx --no-install tsx packages/commercial/scripts/seed-knowledge-planet-plugin.ts --smoke-only"
}

# 2026-07-17 goal 事故门禁补强:激活后真跑一个 codex 引擎聊天 turn(canary 账号,
# WS 全链路,PUT 建会话→inbound.message→text 判成)。背景:goal bug 致 codex 引擎
# 100% turn 必挂时,健康端点/调度器 smoke 全绿——没有任何门跑过真 turn。
# 失败 = 与 full smoke 同级的强校验失败(走对称补偿回滚)。V5_SMOKE_TURN=0 可跳过
# (紧急场景明示豁免;默认必跑)。
verify_candidate_ccb_ledger_cost() { # <session-id> <model>
  local session_id="$1" model="$2" proof i
  [[ "$session_id" =~ ^smoketurn[a-z0-9]+$ ]] || {
    echo "✗ candidate CCB ledger proof session 非法:$session_id" >&2
    return 1
  }
  [[ "$model" == deepseek-v4-flash ]] || {
    echo "✗ candidate CCB ledger proof model 非法:$model" >&2
    return 1
  }
  # 0% candidate 的 CCB 请求仍经单例 egress 出站；egress cost-event 固定投递
  # deploy_state.desired_control_slot 对应的 18894（此时仍是旧 active），所以真实
  # debit 会落 PG、live cost frame 却只会在旧 active 广播。按本次 smoke 生成的
  # 唯一 client session + 精确 model + canary 邮箱核对 tape/cost/usage/ledger 同一
  # 事务结果。usage_records.session_id 是 engine session，不能拿它匹配 client
  # session；不允许用“最近一条 DeepSeek usage”之类模糊证据放宽门禁。
  for i in $(seq 1 10); do
    proof="$(remote_model_authority_psql_app "
SELECT CASE WHEN COUNT(*) = 1 THEN 'ok' ELSE 'missing' END
  FROM client_session_turn_tapes t
  JOIN users u ON t.user_id = 'c:' || u.id::text
  JOIN turn_tape_cost_components tc
    ON tc.user_id = t.user_id
   AND tc.session_id = t.session_id
   AND tc.tape_id = t.tape_id
   AND tc.billing_anchor_id = t.billing_anchor_id
  JOIN usage_records ur
    ON ur.user_id = u.id
   AND ur.request_id = tc.request_id
   AND ur.turn_key = t.turn_key
  JOIN credit_ledger cl ON cl.id = ur.ledger_id
 WHERE u.email = 'v5-canary@claudeai.chat'
   AND t.session_id = '$session_id'
   AND t.status = 'completed'
   AND ur.model = '$model'
   AND ur.status = 'success'
   AND ur.cost_credits > 0
   AND tc.cost_credits = ur.cost_credits
   AND ur.created_at >= clock_timestamp() - interval '10 minutes'
   AND cl.user_id = ur.user_id
   AND cl.reason = 'chat'
   AND cl.ref_type = 'usage_record'
   AND cl.ref_id = ur.id::text
   AND cl.delta = -ur.cost_credits
" 2>/dev/null || true)"
    if [[ "$proof" == ok ]]; then
      echo "turn-canary: TURN_OK model=$model exact_text=2 final=true cost_evidence=ledger session=$session_id"
      return 0
    fi
    sleep 1
  done
  echo "✗ candidate CCB ledger proof 未在截止时间内形成精确 usage+ledger 闭环(session=$session_id model=$model)" >&2
  return 1
}

smoke_turn_canary() { # <pinned master release> [port] [model] [cost-evidence-mode]
  local release="$1" port="${2:-$ACTIVE_PORT}" model="${3:-${V5_TURN_MODEL:-}}"
  local cost_evidence_mode="${4:-live}" output rc proof session_id proof_model
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] real-turn canary(model=${model:-<script default>},cost=$cost_evidence_mode)@ $release port=$port"
    return 0
  fi
  [[ "$cost_evidence_mode" == live || "$cost_evidence_mode" == candidate-ledger ]] || {
    echo "✗ 未知真 turn cost evidence mode:$cost_evidence_mode" >&2
    return 1
  }
  echo "── smoke:canary 真 turn(model=${model:-<script default>},port=$port,cost=$cost_evidence_mode)──"
  if [[ "$cost_evidence_mode" == candidate-ledger ]]; then
    [[ "$model" == deepseek-v4-flash ]] || {
      echo "✗ candidate-ledger 只允许精确模型 deepseek-v4-flash" >&2
      return 1
    }
    if output="$(ssh "$KL_HOST" "cd '$release' && V5_BASE='http://127.0.0.1:${port}' V5_TURN_MODEL='$model' V5_CANARY_ALLOW_LEDGER_COST_EVIDENCE=1 timeout 300 node scripts/v5-smoke-turn-canary.mjs" 2>&1)"; then
      printf '%s\n' "$output"
      return 0
    else
      rc=$?
    fi
    printf '%s\n' "$output"
    [[ "$rc" == 3 ]] || return "$rc"
    mapfile -t proof < <(
      printf '%s\n' "$output" |
        sed -nE 's/^turn-canary: TURN_LEDGER_PROOF_REQUIRED session=(smoketurn[a-z0-9]+) model=([a-z0-9.-]+)$/\1|\2/p'
    )
    [[ "${#proof[@]}" == 1 ]] || {
      echo "✗ candidate CCB ledger proof 行缺失或不唯一" >&2
      return 1
    }
    session_id="${proof[0]%%|*}"
    proof_model="${proof[0]#*|}"
    [[ "$proof_model" == "$model" ]] || {
      echo "✗ candidate CCB ledger proof model 不匹配:$proof_model != $model" >&2
      return 1
    }
    verify_candidate_ccb_ledger_cost "$session_id" "$proof_model"
    return $?
  fi
  ssh "$KL_HOST" "cd '$release' && V5_BASE='http://127.0.0.1:${port}' ${model:+V5_TURN_MODEL='$model'} timeout 300 node scripts/v5-smoke-turn-canary.mjs"
}

# ══════════ 双引擎真 turn 矩阵(2026-07-26;审计 13)══════════
# 旧 deploy lane 的真 turn 只跑 v5-smoke-turn-canary.mjs 默认模型(gpt-5.6-sol / codex 引擎),
# CCB(claude)引擎在 deploy 与 --dist 通道零真 turn 覆盖 —— 与 canary 的固定 live 矩阵
# (Codex/gpt-5.6-luna + CCB/deepseek-v4-flash)不对齐。此处对齐成双引擎各一 turn。
# 稳定 lane 每个 turn 仍严格要求三信号(exactText='2' + isFinal + cost_charged)。
# 只有 0% candidate/promote-candidate 的 deepseek-v4-flash 因 cost-event 必然投旧 active，
# 才允许用同一 smoke session 的精确 usage+ledger 闭环替代 live cost frame；finalize
# 交接 control VIP 后仍必须回到 live frame，不能把 candidate 拓扑例外扩散到稳定态。
V5_TURN_ENGINE_MATRIX_DEFAULT="gpt-5.6-sol deepseek-v4-flash"
smoke_turn_matrix() { # <pinned master release> [port] [lane]
  local release="$1" port="${2:-$ACTIVE_PORT}" lane="${3:-stable}" model models cost_evidence_mode
  if [[ "${V5_SMOKE_TURN:-1}" != 1 ]]; then
    record_gate_waiver smoke-turn "V5_SMOKE_TURN=0 关闭了双引擎真 turn 矩阵(mode=$MODE release=$release)" || return 1
    echo "  · 双引擎真 turn 矩阵已显式豁免(V5_SMOKE_TURN=0;已登记 durable debt,下次普通发布必须真跑)"
    return 0
  fi
  if [[ "${V5_CANARY_REQUIRE_COST:-1}" == 0 ]]; then
    record_gate_waiver canary-turn-cost "V5_CANARY_REQUIRE_COST=0 关闭了真 turn 的计费到账断言(mode=$MODE)" || return 1
  fi
  models="${V5_TURN_MODELS:-$V5_TURN_ENGINE_MATRIX_DEFAULT}"
  echo "── 双引擎真 turn 矩阵(models=$models,port=$port,lane=$lane)──"
  for model in $models; do
    cost_evidence_mode=live
    if [[ ( "$lane" == canary-ready || "$lane" == promote-candidate ) && "$model" == deepseek-v4-flash ]]; then
      cost_evidence_mode=candidate-ledger
    fi
    smoke_turn_canary "$release" "$port" "$model" "$cost_evidence_mode" || {
      echo "✗ 真 turn 矩阵失败(model=$model port=$port):引擎未出正文/未收尾/未计费。" >&2
      return 1
    }
  done
  clear_gate_waiver smoke-turn
  [[ "${V5_CANARY_REQUIRE_COST:-1}" == 0 ]] || clear_gate_waiver canary-turn-cost
  echo "  ✓ 双引擎真 turn 矩阵全部通过($models)"
}

# 2026-07-18 附件事故门禁补强:E2E 用户旅程门(真浏览器)。背景:「点击添加附件无反应」
# 回归上线 ~20h 才被用户报障 —— turn canary 只覆盖 WS 契约,健康端点不点 UI,前端交互
# 层此前没有任何门。本门在**部署发起机本机**用真 Chromium(受信事件)走核心旅程:
# UI 登录 → 附件全链(filechooser 弹出+真实上传)→ 目标入口 → 带附件发送上屏。
# 脚本自建 ssh 隧道访问 $ACTIVE_PORT(kl-mirror 无浏览器;隧道由 node 进程管理,
# libuv spawn 不继承部署锁 fd,不会占住 /var/lock/oc-v5-deploy.lock)。
# 失败语义(2026-07-26 升级,第一期裁定到期):第一期(2026-07-18)约定「fail-loud 但不进
# validation 自动回滚链,连续两周零假阳性后升级」。到 2026-07-26 已满 8 天且零假阳性记录,
# 且第一期形态被审计判定为无效门 —— 四个调用点全在 end_planned_maintenance **之后**,
# 新版本已经 live 且失败只 `|| exit 1`,坏版本照样在线服务真实用户,把「20 小时才被报障」
# 缩短成「脚本 4 分钟后打印红字」而已。现升级为:与 full smoke / 真 turn 同级的强校验,
# 进 validation_failure 对称补偿链(deploy/dist),或走官方 abort 路径(canary/finalize)。
# 假阳性逃生口 = V5_SMOKE_E2E=0,但它现在会登记 durable debt 并阻断下一次普通发布。
# V5_E2E_REMOTE_PORT 目标端口参数化:candidate lane 对 candidate 私有端口跑,切流前发现问题。
smoke_e2e_journey() { # [port]
  local port="${1:-$ACTIVE_PORT}"
  if [[ "${V5_SMOKE_E2E:-1}" != 1 ]]; then
    record_gate_waiver e2e-journey "V5_SMOKE_E2E=0 关闭了真浏览器 J1-J5 旅程门(mode=$MODE)" || return 1
    echo "  · E2E 旅程门已显式豁免(V5_SMOKE_E2E=0;已登记 durable debt,下次普通发布必须真跑)"
    return 0
  fi
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] E2E journey canary(真浏览器用户旅程,port=$port)"
    return 0
  fi
  # 依赖活体探测:部署树 node_modules 必须已含 playwright-core(合并本批后需 npm install)。
  # 缺失 = fail-loud 指引,绝不静默跳过(浏览器缺失→跳过 = fail-open,正是本门要消灭的洞)。
  if [[ ! -d "$REPO_ROOT/node_modules/playwright-core" ]]; then
    echo "✗✗ E2E 旅程门依赖缺失:$REPO_ROOT/node_modules/playwright-core 不存在。" >&2
    echo "   在部署树执行 npm install 后重试;紧急豁免用 V5_SMOKE_E2E=0(会登记 durable debt)。" >&2
    return 1
  fi
  echo "── smoke:E2E 旅程门(真浏览器·登录/附件/目标/发送,remote port=$port)──"
  # 外层只作最终失控保护；脚本内 J1-J4 总预算 240s、J5 独立 180s，另留 30s 清理余量。
  if ! V5_E2E_REMOTE_PORT="$port" timeout 450 node "$SCRIPT_DIR/v5-e2e-journey-canary.mjs"; then
    echo "✗✗ E2E 旅程门失败:用户可感知路径疑似回归(登录/附件/目标/发送其一)。" >&2
    echo "   核查失败截图(/tmp/e2e-journey-fail-*.png);本门已进补偿链,调用方会走对称回滚/abort。" >&2
    echo "   确认假阳性则修 journey 脚本断言并登记;紧急放行用 V5_SMOKE_E2E=0(会登记 durable debt)。" >&2
    return 1
  fi
  clear_gate_waiver e2e-journey   # 门真跑通过 → 自动销账
}

# ══════════ 最小功能核(2026-07-26 出口矩阵整改;审计 1)══════════
# 【判据】任何一条会改变用户流量走向的 lane,过门之后必须能证明同一组用户可见事实:
#   ① 真 turn:双引擎(codex + ccb)各一条,三信号判成(正文精确、干净收尾、计费到账);
#   ② 真浏览器旅程 J1-J5:UI 登录 / 附件全链 / 目标入口 / 发送 / 送达上屏。
# 旧状态是出口矩阵残缺:journey 只挂 deploy 与 dist 的成功出口,candidate 回归矩阵只挂
# canary lane,于是「canary→promote→finalize」这条 playbook 声明的普通发布通道全程不跑
# journey,而日常首选的 deploy/--with-dist 完全不跑 candidate 回归矩阵 —— 每次上线都有
# 一半 E2E 没执行过。此处收口成**一个函数**,各 lane 复用,禁止各 lane 各写一套。
# 适用 lane:deploy / --dist / canary READY / promote / finalize / activate-emergency-tuple(非阻断)。
minimum_functional_core() { # <lane-label> <pinned release> <port>
  local lane="$1" release="$2" port="$3"
  echo "══ 最小功能核(lane=$lane,release=$release,port=$port)══"
  smoke_turn_matrix "$release" "$port" "$lane" || {
    echo "✗ 最小功能核失败(lane=$lane):真 turn 矩阵未通过。" >&2; return 1; }
  smoke_e2e_journey "$port" || {
    echo "✗ 最小功能核失败(lane=$lane):E2E 用户旅程未通过。" >&2; return 1; }
  echo "  ✓ 最小功能核通过(lane=$lane):双引擎真 turn + J1-J5 旅程"
}

# ══════════ 公网面 + 资产面验证(2026-07-26;审计 8)══════════
# 背景三个盲区:
#  ① deploy/--dist 的成功出口没有任何一层经 Caddy 公网入口验证 —— smoke 全程 ssh 打
#     127.0.0.1:port,journey 走 ssh 隧道直连 master 端口。Caddy 落错 slot / 配置漂移
#     不会被任何门发现。verify_routing 现成(带 Host 头打 CADDY_HTTP_PORT,断言 ok:true
#     且响应 slot == 期望 slot),接上即可。
#  ② dist_handshake_smoke 只 curl `/` 抓 index.html 的 oc-build meta,不证明它引用的
#     哈希 JS 能 200。资产是加法式 rsync 进 union 池,一次部分失败 = 用户白屏而握手照样绿。
#  ③ admin.html 是 vite 第二入口且**故意不注入 oc-build**,dist 握手只校验 index.html
#     → admin 后台整体白屏可以带门全绿上线。
# ②③ 的修法收在 verify_asset_surface,并**并入 dist_handshake_smoke** —— 那样 deploy/--dist/
# finalize 三个握手点一次到位,不用每条 lane 各记得挂一遍。
verify_public_surface() { # <lane-label>
  local lane="$1"
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] 公网面验证(Caddy Host 头 → 期望 slot)+ 资产面验证(index.html 首个 /assets/*.js + /admin.html)"
    return 0
  fi
  echo "── 公网面验证(经 Caddy $CADDY_HTTP_PORT,断言 ok:true ∧ slot=期望;lane=$lane)──"
  KL_HOST="$KL_HOST" V5_ENV="$V5_ENV" ASSETS_POOL="$V5_ASSETS_POOL" CADDY_HTTP_PORT="$CADDY_HTTP_PORT" \
    bash "$SCRIPT_DIR/v5-caddy-apply.sh" --verify || {
    echo "✗ 公网面验证失败:Caddy 入口未确认落到期望 slot(公网用户看到的可能不是刚部署的这一份)。" >&2
    return 1
  }
  # 资产面通常并在 dist_handshake_smoke 里(它有 DIST_BUILD_ID 权威);不带 --with-dist 的普通
  # deploy 不跑握手,资产可达性就落在这里补上(release 里那份 dist 仍是用户真正加载的那份)。
  [[ "$WITH_DIST" == 1 ]] || verify_asset_surface "${ACTIVE_PORT:-$V5_PORT}" || return 1
}

# 资产可达性:解析线上 index.html 首个 /assets/*.js → GET 断言 200 + JS Content-Type;
# 再断言 /admin.html 200 且其首个 /assets/*.js 可达(admin 是第二入口,不带 oc-build)。
verify_asset_surface() { # <port>
  local port="$1"
  [[ "$DRY" == 1 ]] && { echo "  [dry-run] 资产可达性断言(index.html + admin.html 各自首个 /assets/*.js)"; return 0; }
  echo "── 资产面验证(哈希 chunk 真能 200;union 池加法同步的部分失败=白屏但握手绿)──"
  local page asset code ctype
  for page in / /admin.html; do
    local html
    html="$(ssh -n "$KL_HOST" "curl -fsS --max-time 10 'http://127.0.0.1:${port}${page}'" 2>/dev/null)" || {
      echo "✗ 资产面验证:GET $page 失败(port=$port)——入口 HTML 不可达。" >&2
      return 1
    }
    asset="$(grep -o '/assets/[A-Za-z0-9._-]*\.js' <<<"$html" | head -1)"
    [[ -n "$asset" ]] || {
      echo "✗ 资产面验证:$page 未引用任何 /assets/*.js(vite 产物残缺/入口 HTML 不是构建产物)。" >&2
      return 1
    }
    code="$(ssh -n "$KL_HOST" "curl -s -o /dev/null -w '%{http_code}' --max-time 10 'http://127.0.0.1:${port}${asset}'" 2>/dev/null || true)"
    [[ "$code" == 200 ]] || {
      echo "✗ 资产面验证:$page 引用的 $asset HTTP=$code(≠200)—— 用户拿到 HTML 但 JS 404 = 白屏。" >&2
      return 1
    }
    ctype="$(ssh -n "$KL_HOST" "curl -s -o /dev/null -w '%{content_type}' --max-time 10 'http://127.0.0.1:${port}${asset}'" 2>/dev/null || true)"
    grep -qiE 'javascript|ecmascript' <<<"$ctype" || {
      echo "✗ 资产面验证:$asset Content-Type=$ctype 不是 JS —— SPA fallback 把 404 兜成了 index.html。" >&2
      return 1
    }
    echo "  ✓ $page → $asset 200 ($ctype)"
  done
}

# 2026-07-26 安全整改:sourcemap 封堵活体门(第四层)。前三层是"配置对了应该没事"
# (vite hidden / rsync --exclude / Caddy 404),这一层是**活体证明**:真的从 Caddy
# 取一次 .map,断言拿不到 200。为什么必须有:三层里任意一层被后人改回去(改 vite、
# 改池子同步、重生成 Caddyfile 时漏了 handle 顺序)都不会有任何报错,只会静默重新
# 泄漏全量源码 —— 正是 2026-07-26 之前的状态。
#
# 探测对象取**池子里真实存在的一个 .map**(存量 7312 个),没有则回退到一个必然不
# 存在的路径:两种情况都必须非 200。前者证明"拦截生效",后者至少证明"没有目录遍历"。
# 走 Caddy(带 Host 头 + $CADDY_HTTP_PORT),不走 master 端口 —— 拦截规则在 Caddy 层。
#
# 铁律遵循:远端 heredoc 退出码必须接(不接 = fail-open,requiredMigrations 就这样漏过);
# 不硬编码 :80;curl 失败(连不上)与"拿到 200"分开判 —— 前者是探测本身坏了,同样 fail-loud。
smoke_sourcemap_sealed() {
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] sourcemap 封堵活体门:经 Caddy 取 *.map 断言非 200"
    return 0
  fi
  echo "── smoke:sourcemap 封堵活体门(经 Caddy:${CADDY_HTTP_PORT})──"
  if ! ssh "$KL_HOST" bash -s -- "$V5_ASSETS_POOL" "$CADDY_HTTP_PORT" <<'REMOTE'
set -euo pipefail
POOL="$1"; PORT="$2"
# ① 配置层断言:live Caddyfile 必须真的有拦截块。
#    没这一条,池子被清空后 curl 探测会退化成"文件本来就不存在 → 404",门变空断言。
#    注意 caddy_render_reload 只在 canary/finalize/abort 流程调 —— 普通 deploy 不重渲染,
#    所以改了模板必须显式跑 scripts/v5-caddy-apply.sh --apply,本断言就是那一步的活体回执。
#
#    【断言形态的由来,别再改回去】守卫**嵌在** handle /assets/* 内、被 route 包住:
#      handle /assets/* { root * POOL; route { @sourcemap path *.map; respond @sourcemap 404; file_server } }
#    早期版本把它写成独立 handle 排在 /assets 之前,并在这里断言"文本行号更小"——
#    那个前提是错的:Caddyfile adapter 会按路径特异性给同组 handle 重排,/assets/* 反而
#    排到前面,*.map 永不命中,而文本断言照样绿(2026-07-26 实测线上仍 200)。
#    所以这里**不再断言文本行号**,只断言"守卫在 /assets 块内、route 内、respond 早于 file_server"。
CADDYFILE=/etc/caddy/Caddyfile
if [ ! -r "$CADDYFILE" ]; then
  echo "✗ 读不到 $CADDYFILE,无法确认 sourcemap 拦截已生效" >&2
  exit 1
fi
assets_block="$(awk '/^\thandle \/assets\/\*/{f=1} f{print} f&&/^\t}/{exit}' "$CADDYFILE")"
if [ -z "$assets_block" ]; then
  echo "✗ live Caddyfile 找不到 handle /assets/* 块 —— 需先跑 scripts/v5-caddy-apply.sh --apply" >&2
  exit 1
fi
for needle in 'route {' '@sourcemap path *.map' 'respond @sourcemap 404'; do
  if ! printf '%s\n' "$assets_block" | grep -qF "$needle"; then
    echo "✗ live Caddyfile 的 /assets 块内缺 [$needle] —— 需先跑 scripts/v5-caddy-apply.sh --apply" >&2
    exit 1
  fi
done
r_line="$(printf '%s\n' "$assets_block" | grep -nF 'respond @sourcemap 404' | head -1 | cut -d: -f1)"
f_line="$(printf '%s\n' "$assets_block" | grep -nF 'file_server'            | head -1 | cut -d: -f1)"
if [ -z "$r_line" ] || [ -z "$f_line" ] || [ "$r_line" -ge "$f_line" ]; then
  echo "✗ live Caddyfile 的 route 内 respond(${r_line:-<none>})未排在 file_server(${f_line:-<none>})之前 —— 拦不住" >&2
  exit 1
fi

# ② 活体断言:取池内任意一个真实 .map 探测;池已清空则用必然不存在的哨兵路径。
#    两种情况都必须非 200(前者证明拦截生效,后者至少证明没有目录遍历)。
probe="$(find "$POOL/assets" -maxdepth 1 -name '*.map' -printf '%f\n' 2>/dev/null | head -1)"
[ -n "$probe" ] || probe="oc-sourcemap-seal-probe.js.map"
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
  -H 'Host: claudeai.chat' "http://127.0.0.1:${PORT}/assets/${probe}" 2>/dev/null || echo "000")"
if [ "$code" = "000" ]; then
  echo "✗ sourcemap 探测本身失败(curl 连不上 Caddy:${PORT}) probe=${probe}" >&2
  exit 1
fi
if [ "$code" = "200" ]; then
  echo "✗ sourcemap 仍可公网获取:/assets/${probe} → HTTP 200(源码泄漏)" >&2
  exit 1
fi
echo "  · sourcemap 已封堵:/assets/${probe} → HTTP ${code}"
REMOTE
  then
    echo "✗✗ sourcemap 封堵门失败 —— 前端源码可能正经公网泄漏。" >&2
    echo "   排查:①Caddyfile 是否含 @sourcemap 且排在 handle /assets/* 之前" >&2
    echo "        (bash scripts/v5-caddy-apply.sh 重生成并看 self-check)" >&2
    echo "        ②资产池同步是否漏了 --exclude='*.map'" >&2
    echo "        ③vite.config.ts 的 build.sourcemap 是否被改回 true" >&2
    return 1
  fi
}

# C5:rollback 收尾后的 real-turn canary —— **非阻断**。回滚本体必须能落地,故这里
# 的真 turn 只做"回滚后引擎是否真能出正文"的健康观测:失败只大声告警,**绝不**反向翻回
# 已成功的回滚(回滚往往正是在引擎已坏时执行,再拿 turn 结果当门会把救援自我否决)。
# V5_SMOKE_TURN=0 显式豁免(与 deploy 侧同一开关)。
# 2026-07-26(审计 10)第二参数化 lane 标签:逃生/单轴翻转通道(emergency tuple、model
# authority epoch fence、runtime tape batching)改的正是「agent turn 能不能出正文」这条链,
# 但它们此前只有健康端点级证据(master 的 /healthz 根本不经过容器)。给它们挂**非阻断**真 turn:
# 逃生通道不该被新门挡住(那会把救援自我否决),但「逃生成功」本身必须留下证据而不是全凭健康端点。
smoke_turn_canary_advisory() { # <pinned master release> [lane-label]
  local release="$1" lane="${2:-rollback}"
  [[ "${V5_SMOKE_TURN:-1}" == 1 ]] || { echo "  · real-turn canary 已显式豁免(V5_SMOKE_TURN=0)"; return 0; }
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] real-turn canary($lane 后·非阻断)@ $release"
    return 0
  fi
  echo "── $lane 后 real-turn canary(非阻断观测,port=$ACTIVE_PORT)──"
  if smoke_turn_canary "$release"; then
    echo "  ✓ $lane 后 real-turn canary 通过(引擎可出正文且计费到账)。"
  else
    echo "⚠⚠ $lane 后 real-turn canary 未通过(非阻断:$lane 已落地,不翻回)。引擎可能仍不健康,请人工核查 turn 主链路。" >&2
    echo "   健康端点绿 ≠ agent turn 能出正文(2026-07-17 goal 事故正是这一对);release=$release port=$ACTIVE_PORT。" >&2
  fi
  return 0
}

# 2026-07-17 架构纠偏(goal 事故复盘产物):插件审批状态不再阻断平台部署。
# 插件信任的强制点在**运行时**(三表 pin + plugin-v2 验签 + 摘要派生 driver 匹配,
# 全部 fail-closed)——未审批制品在任何 release 下都没有执行入口,部署门的旧职责
# (挡住未验证候选)是纵深防御的冗余层,却把整个平台的部署/回滚锁在单个插件的
# 扫码审批后面(07-17 故障期间紧急 hotfix 与回滚双双被拦)。
# 本咨询门只判定:本次部署是否会做插件版本迁移(KP_PLUGIN_PROMOTE),以及不迁移
# 时插件是继续服务还是休眠,打印告知后放行。stdout 单行 JSON 契约 + jq 校验,
# 不依赖 tsx 退出码(fail-open 历史教训);基础设施故障(读不到状态)仍 fail-closed。
KP_PLUGIN_PROMOTE=0
knowledge_planet_plugin_advisory_gate() { # <pinned master release>
  local release="$1"
  KP_PLUGIN_PROMOTE=0
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] Knowledge Planet advisory status(非阻断;判定是否做插件迁移)@ $release"
    return 0
  fi
  local source_commit output
  source_commit="$(knowledge_planet_candidate_commit)" || return 1
  output="$(ssh "$KL_HOST" "set -a; . '$V5_ENV'; set +a
    export OC_KNOWLEDGE_PLANET_SOURCE_COMMIT='$source_commit'
    cd '$release'
    npx --no-install tsx packages/commercial/scripts/seed-knowledge-planet-plugin.ts --advisory-status")" || {
    echo "✗ Knowledge Planet advisory status 执行失败(基础设施:镜像/DB/ssh)" >&2
    return 1
  }
  local line
  line="$(printf '%s\n' "$output" | grep -a '"advisory":"knowledge-planet"' | tail -1)"
  if [[ -z "$line" ]] || ! jq -e '
      .advisory == "knowledge-planet"
      and (.approvedForDeploy | type == "boolean")
      and (.handoffPresent | type == "boolean")
      and (.artifactMatchesCurrentApproved | type == "boolean")' >/dev/null 2>&1 <<<"$line"; then
    echo "✗ Knowledge Planet advisory status 输出不符合 JSON 契约:$(printf '%s' "$output" | head -c 200)" >&2
    return 1
  fi
  local approved handoff matches
  approved="$(jq -r '.approvedForDeploy' <<<"$line")"
  handoff="$(jq -r '.handoffPresent' <<<"$line")"
  matches="$(jq -r '.artifactMatchesCurrentApproved' <<<"$line")"
  if [[ "$approved" == true || "$handoff" == true ]]; then
    KP_PLUGIN_PROMOTE=1
    echo "  · Knowledge Planet:候选已审批/持有 handoff → 本次部署执行插件版本迁移段"
  elif [[ "$matches" == true ]]; then
    echo "  · Knowledge Planet:插件制品与线上已审批版本一致 → 零接触(插件不受影响继续服务;运行时按已审批版本 pin 执行)"
  else
    echo "⚠ Knowledge Planet:插件制品有改动且未验证 → 零接触部署;新 release 下该插件将 RUNTIME_UNAVAILABLE(运行时 fail-closed 拒未审批制品),直至 --verify-knowledge-planet-user=<id> 验证晋升。平台部署不因此阻断。" >&2
  fi
  return 0
}

# One-shot setup-first deploy guard. It permits exactly the currently signed
# platform v1.0 predecessor, identical encrypted browser-account semantics,
# exact active installs, and zero persisted accounts. The post phase repeats
# the proof after the old gateway process has drained while the listing gate is
# still closed, so a late QR completion cannot race the source cutover.
knowledge_planet_plugin_assert_setup_first_safe() { # <pinned master release> <pre|post>
  local release="$1" phase="$2"
  KNOWLEDGE_PLANET_SETUP_VERSION_ID=""
  [[ "$phase" == pre || "$phase" == post ]] || {
    echo "✗ Knowledge Planet setup-first phase 非法:$phase" >&2
    return 2
  }
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] assert Knowledge Planet setup-first $phase: exact signed v1.0 + exact installs + zero accounts @ $release"
    KNOWLEDGE_PLANET_SETUP_VERSION_ID=1
    return 0
  fi
  local output result
  output="$(ssh "$KL_HOST" "set -a; . '$V5_ENV'; set +a
    cd '$release'
    npx --no-install tsx packages/commercial/scripts/seed-knowledge-planet-plugin.ts '--assert-setup-first-safe=$phase'")" || {
    [[ -n "$output" ]] && printf '%s\n' "$output"
    return 1
  }
  printf '%s\n' "$output"
  result="$(tail -n 1 <<<"$output")"
  jq -e --arg phase "$phase" '
    .safe == true and .phase == $phase and
    (.currentVersionId | type == "string" and test("^[0-9]+$")) and
    (.currentArtifactHash | type == "string" and test("^[0-9a-f]{64}$")) and
    (.targetArtifactHash | type == "string" and test("^[0-9a-f]{64}$")) and
    .currentArtifactHash != .targetArtifactHash and
    (.activeInstalls | type == "number" and . > 0) and
    .activeAccounts == 0' >/dev/null <<<"$result" || {
    echo "✗ Knowledge Planet setup-first $phase 返回非法结果" >&2
    return 1
  }
  KNOWLEDGE_PLANET_SETUP_VERSION_ID="$(jq -r '.currentVersionId' <<<"$result")"
}

knowledge_planet_plugin_seed() { # <active master release>
  local release="$1"
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] consume encrypted handoff when present → bind user before gate open → official seed/migration @ $release"
    return 0
  fi
  local source_commit
  source_commit="$(knowledge_planet_candidate_commit)" || return 1
  ssh "$KL_HOST" "set -a; . '$V5_ENV'; set +a
    export OC_KNOWLEDGE_PLANET_SOURCE_COMMIT='$source_commit'
    cd '$release'
    npx --no-install tsx packages/commercial/scripts/seed-knowledge-planet-plugin.ts --seed-only"
}

# Close only the Knowledge Planet execution/install/setup surface while source
# and encrypted account pins are on different versions. Unlike the monitor's
# maintenance marker, listing.state=unlisted is enforced by every runtime trust
# load and is therefore a real cross-process fail-closed gate.
knowledge_planet_plugin_close_gate() { # <release containing transition helper>
  local runner="$1"
  KNOWLEDGE_PLANET_GATE_VERSION_ID=""
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] close Knowledge Planet listing execution gate @ $runner"
    return 0
  fi
  local output result
  output="$(ssh "$KL_HOST" "set -a; . '$V5_ENV'; set +a
    cd '$runner'
    npx --no-install tsx packages/commercial/scripts/seed-knowledge-planet-plugin.ts --close-listing-gate")" || {
    [[ -n "$output" ]] && printf '%s\n' "$output"
    return 1
  }
  printf '%s\n' "$output"
  result="$(tail -n 1 <<<"$output")"
  jq -e '(.changed | type == "boolean") and
         (.currentVersionId == null or
          (.currentVersionId | type == "string" and test("^[0-9]+$")))' \
    >/dev/null <<<"$result" || {
    echo "✗ Knowledge Planet gate close 返回非法结果" >&2
    return 1
  }
  KNOWLEDGE_PLANET_GATE_VERSION_ID="$(jq -r '.currentVersionId // ""' <<<"$result")"
}

# Decide whether the previous source has an exact approved platform Plugin
# version that compensation can actually transition back to. The current DB
# pointer alone is insufficient after a partial first publication: it may point
# at the new candidate while the previous source never had a published version.
knowledge_planet_plugin_classify_previous_release() { # <helper> <previous-release> <expected-current-version-or-empty>
  local runner="$1" previous="$2" expected_current="$3"
  KNOWLEDGE_PLANET_PREVIOUS_RELEASE_AVAILABLE=0
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] classify exact approved Knowledge Planet version for previous release @ $previous"
    return 0
  fi
  local output result actual_current available
  output="$(ssh "$KL_HOST" "set -a; . '$V5_ENV'; set +a
    cd '$runner'
    npx --no-install tsx packages/commercial/scripts/seed-knowledge-planet-plugin.ts '--classify-current-for-release=$previous'")" || {
    [[ -n "$output" ]] && printf '%s\n' "$output"
    return 1
  }
  printf '%s\n' "$output"
  result="$(tail -n 1 <<<"$output")"
  jq -e '(.available | type == "boolean") and
         (.versionId == null or (.versionId | type == "string" and test("^[0-9]+$"))) and
         (.currentVersionId == null or
          (.currentVersionId | type == "string" and test("^[0-9]+$")))' \
    >/dev/null <<<"$result" || {
    echo "✗ Knowledge Planet previous-release classifier 返回非法结果" >&2
    return 1
  }
  actual_current="$(jq -r '.currentVersionId // ""' <<<"$result")"
  [[ "$actual_current" == "$expected_current" ]] || {
    echo "✗ Knowledge Planet current version 在 close/classify 间变化(expected=${expected_current:-<none>} actual=${actual_current:-<none>})" >&2
    return 1
  }
  available="$(jq -r '.available' <<<"$result")"
  if [[ "$available" == true ]]; then
    KNOWLEDGE_PLANET_PREVIOUS_RELEASE_AVAILABLE=1
  fi
}

knowledge_planet_plugin_transition_to_release() { # <helper release> <target release>
  local runner="$1" target="$2"
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] transition Knowledge Planet installs/accounts → $target (gate stays closed) @ $runner"
    return 0
  fi
  ssh "$KL_HOST" "set -a; . '$V5_ENV'; set +a
    cd '$runner'
    npx --no-install tsx packages/commercial/scripts/seed-knowledge-planet-plugin.ts '--transition-to-release=$target'"
}

knowledge_planet_plugin_open_gate_to_release() { # <helper release> <target release>
  local runner="$1" target="$2"
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] verify $target exact official contract → open Knowledge Planet listing gate @ $runner"
    return 0
  fi
  ssh "$KL_HOST" "set -a; . '$V5_ENV'; set +a
    cd '$runner'
    npx --no-install tsx packages/commercial/scripts/seed-knowledge-planet-plugin.ts '--open-listing-gate-to-release=$target'"
}

# 兜底重开:把执行门恢复到 listing 当前已审批版本(DB 行身份,与 release 无关)。
# release 身份钉死的 open-to-release 在"目标 release 早于插件审批"(紧急回滚)时
# 无版本可解(2026-07-17 rollback 实测被它打进 manual-recovery);本兜底恒可执行,
# 无已审批版本时 TS 侧如实上报 no-approved-version 且退出 0(无门可开≠失败)。
knowledge_planet_plugin_open_gate_current() { # <helper release>
  local runner="$1"
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] open Knowledge Planet listing gate to current approved version @ $runner"
    return 0
  fi
  ssh "$KL_HOST" "set -a; . '$V5_ENV'; set +a
    cd '$runner'
    npx --no-install tsx packages/commercial/scripts/seed-knowledge-planet-plugin.ts --open-listing-gate-current"
}

knowledge_planet_plugin_open_setup_first_gate_to_version() { # <helper release> <exact predecessor version ID>
  local runner="$1" version_id="$2"
  [[ "$version_id" =~ ^[1-9][0-9]{0,15}$ ]] || {
    echo "✗ Knowledge Planet setup-first version ID 非法:${version_id:-<empty>}" >&2
    return 2
  }
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] verify/open exact signed Knowledge Planet setup-first predecessor version=$version_id @ $runner"
    return 0
  fi
  local output result
  output="$(ssh "$KL_HOST" "set -a; . '$V5_ENV'; set +a
    cd '$runner'
    npx --no-install tsx packages/commercial/scripts/seed-knowledge-planet-plugin.ts '--open-setup-first-gate-to-version=$version_id'")" || {
    [[ -n "$output" ]] && printf '%s\n' "$output"
    return 1
  }
  printf '%s\n' "$output"
  result="$(tail -n 1 <<<"$output")"
  jq -e --arg version_id "$version_id" '
    .setupFirst == true and (.changed | type == "boolean") and
    .currentVersionId == $version_id' >/dev/null <<<"$result" || {
    echo "✗ Knowledge Planet setup-first exact gate open 返回非法结果" >&2
    return 1
  }
}

# Non-normal activation lanes are not allowed to change the global managed
# browser account contract: two masters cannot safely execute different driver
# pins against one shared account table. A mismatch must go through deploy(),
# which performs QR/action verification and an atomic account/install cutover.
knowledge_planet_plugin_assert_release_compatible() { # <helper release> <target release>
  local runner="$1" target="$2"
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] assert Knowledge Planet target contract == DB current @ $target"
    return 0
  fi
  ssh "$KL_HOST" "set -a; . '$V5_ENV'; set +a
    cd '$runner'
    npx --no-install tsx packages/commercial/scripts/seed-knowledge-planet-plugin.ts '--assert-current-release-compatible=$target'"
}

# Unified compensation after a new master has been activated while the
# Knowledge Planet listing gate is closed. It restores an explicitly switched
# egress first, then restores the master source + encrypted account/install pins
# + listing gate as one fail-closed sequence. Callers mark recovery-required if
# this returns non-zero. First publication has no old Plugin pins to restore, so
# a partially created new listing deliberately remains globally unlisted.
knowledge_planet_compensate_deploy() { # <helper/new> <previous> <hotcfg:0|1> <egress-switched:0|1> <previous-egress> [had-previous-plugin:0|1]
  local helper="$1" previous="$2" hotcfg="$3" egress_switched="$4" previous_egress="$5"
  local had_previous_plugin="${6:-1}"
  local failed=0
  require_mutation_lease_for_compensation "knowledge-planet-deploy-compensation" || exit 86
  [[ "$had_previous_plugin" =~ ^[01]$ ]] || {
    echo "✗ Knowledge Planet compensation previous-plugin flag 非法:$had_previous_plugin" >&2
    return 2
  }
  if [[ "$egress_switched" == 1 ]]; then
    activate_egress_release "$previous_egress" "$helper" || failed=1
  fi
  if [[ "$hotcfg" == 1 ]]; then
    if ! rollback_runtime_tuple 1 1 "$helper" "$had_previous_plugin"; then
      failed=1
    elif ! smoke "$ACTIVE_PORT"; then
      failed=1
    elif [[ "$had_previous_plugin" == 1 ]] \
      && ! knowledge_planet_plugin_open_gate_to_release "$helper" "$previous"; then
      failed=1
    fi
  elif [[ "$had_previous_plugin" == 0 ]]; then
    # Fresh-install compensation has no approved previous Plugin version to
    # transition to. Close a listing if the failed seed created one, leave it
    # globally inert, and restore only the source. The legacy Skill is retired
    # last, so partial per-user migration remains usable through that old entry.
    if ! knowledge_planet_plugin_close_gate "$helper" \
      || ! activate_release "$previous" \
      || ! smoke "$ACTIVE_PORT"; then
      failed=1
    fi
  else
    if ! knowledge_planet_plugin_close_gate "$helper" \
      || ! knowledge_planet_plugin_transition_to_release "$helper" "$previous" \
      || ! activate_release "$previous" \
      || ! smoke "$ACTIVE_PORT" \
      || ! knowledge_planet_plugin_open_gate_to_release "$helper" "$previous"; then
      failed=1
    fi
  fi
  return "$failed"
}

# setup-first never changes the Plugin/install/account version pin. Compensation
# therefore restores only source/tuple/egress while the gate stays closed, then
# reopens the exact signed predecessor captured by the pre-cutover DB guard.
knowledge_planet_compensate_setup_first() { # <helper/new> <previous> <hotcfg:0|1> <egress-switched:0|1> <previous-egress> <predecessor-version-id>
  local helper="$1" previous="$2" hotcfg="$3" egress_switched="$4" previous_egress="$5"
  local predecessor_version_id="$6" failed=0 source_restored=0
  require_mutation_lease_for_compensation "knowledge-planet-setup-first-compensation" || exit 86
  [[ "$predecessor_version_id" =~ ^[1-9][0-9]{0,15}$ ]] || {
    echo "✗ Knowledge Planet setup-first compensation version ID 非法:${predecessor_version_id:-<empty>}" >&2
    return 2
  }
  if [[ "$egress_switched" == 1 ]]; then
    activate_egress_release "$previous_egress" "$helper" || failed=1
  fi
  if [[ "$hotcfg" == 1 ]]; then
    if rollback_runtime_tuple 1 1 "$helper" 0 && smoke "$ACTIVE_PORT"; then
      source_restored=1
    else
      failed=1
    fi
  elif knowledge_planet_plugin_close_gate "$helper" \
    && activate_release "$previous" \
    && smoke "$ACTIVE_PORT"; then
    source_restored=1
  else
    failed=1
  fi
  if [[ "$source_restored" == 1 ]] \
    && ! knowledge_planet_plugin_open_setup_first_gate_to_version \
      "$helper" "$predecessor_version_id"; then
    failed=1
  fi
  return "$failed"
}

activate_egress_release() {
  local reldir="$1" prev="$2" tmplink="$V5_EGRESS_SRC.newlink.$$" caps running_cwd require_cap=0
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] egress 独立指针 $V5_EGRESS_SRC:$prev→$reldir;安装目标 unit→restart→health/cwd；失败回切"
    return 0
  fi
  assert_release_marker "$reldir" egress || return 1
  assert_release_marker "$prev" egress || return 1
  running_cwd="$(ssh "$KL_HOST" "pid=\$(systemctl show -p MainPID --value '$V5_EGRESS_UNIT' 2>/dev/null || echo 0); test \"\${pid:-0}\" -gt 0 && readlink -f /proc/\$pid/cwd" 2>/dev/null || true)"
  [[ "$running_cwd" == "$prev" ]] || {
    echo "✗ egress 激活前进程 cwd 已漂移(expected=$prev actual=${running_cwd:-<none>})" >&2; return 1;
  }
  ssh "$KL_HOST" "test -f '$reldir/deploy/v5/$V5_EGRESS_UNIT'" || {
    echo "✗ egress 目标 release 不完整或缺 unit:$reldir" >&2; return 1;
  }
  if ! ssh "$KL_HOST" "set -Eeuo pipefail
    rm -f '$tmplink'
    ln -s '$reldir' '$tmplink'
    mv -T '$tmplink' '$V5_EGRESS_SRC'
    install -m 0644 '$reldir/deploy/v5/$V5_EGRESS_UNIT' '/etc/systemd/system/$V5_EGRESS_UNIT'
    systemctl daemon-reload
    systemctl restart '$V5_EGRESS_UNIT'"; then
    echo "✗ egress 新 release 安装/restart 失败，尝试回切 $prev" >&2
  else
    caps="$(release_declared_caps "$reldir" 2>/dev/null || true)"
    caps_contain "$caps" "$MODEL_AUTHORITY_EGRESS_CAP" && require_cap=1
    if wait_for_egress_release_ready "$reldir" "$require_cap" 30; then
      echo "  ✓ egress 已从独立指针运行目标 release:$reldir"
      return 0
    fi
    echo "✗ egress 新 release 活体/进程 cwd/capability 未就绪，尝试回切 $prev" >&2
  fi

  # 新 unit 的 WorkingDirectory 是稳定独立指针，所以回切只需原子翻回旧 release；
  # 不必恢复旧 unit 文件（旧代码仍由同一个 ExecStart 入口启动）。
  require_mutation_lease_for_compensation "egress-release-compensation" || exit 86
  if ssh "$KL_HOST" "set -Eeuo pipefail
    rm -f '$tmplink'
    ln -s '$prev' '$tmplink'
    mv -T '$tmplink' '$V5_EGRESS_SRC'
    systemctl daemon-reload
    systemctl restart '$V5_EGRESS_UNIT'"; then
    if wait_for_egress_release_ready "$prev" 0 30; then
      echo "  ✓ egress 已回切旧 release:$prev" >&2
      return 1
    fi
  fi
  mark_deploy_recovery_required "egress release 切换失败且旧 release 回切未确认(target=$reldir prev=$prev)"
  return 1
}

# ───────────────────────── deploy:增量 ─────────────────────────
deploy() {
  echo "══ v5 deploy on $KL_HOST(蓝绿:release 目录 + 原子 symlink)══"
  echo "── 守卫:overrides 不得含 REMOVE_KEYS ──"
  assert_overrides_no_remove_keys
  # MAJOR 3:cohort rollout 进行中(phase≠stable)拒绝传统 deploy(状态机外入口封死)。
  assert_no_rollout_in_progress
  # BLOCKER 4:解析 active slot(A/B;蓝绿 finalize 后可能是 B)→ 后续 build/activate/smoke 全 slot-aware。
  resolve_active_lane
  assert_bluegreen_layout "$ACTIVE_SRC"
  # 必须早于 build_release 后的 baseline 安全迁移、插件门和任何 live mutation。
  assert_target_runtime_image_ready || exit 1
  local egress_prev_release="" kp_previous_release=""
  local kp_previous_plugin_version_id="" kp_setup_plugin_version_id="" kp_had_previous_plugin=0
  kp_previous_release="$(bg_current_release "$ACTIVE_SRC")"
  [[ "$DRY" == 1 || -n "$kp_previous_release" ]] || {
    echo "✗ 无法钉住 Knowledge Planet Plugin source 回退点" >&2; exit 1;
  }
  if [[ "$RESTART_EGRESS" == 1 && "$DRY" != 1 ]]; then
    # 必须在 master symlink 翻转前钉住旧 egress 真正 cwd；active=A 时翻转后再读会丢回退点。
    egress_prev_release="$CAPTURED_EGRESS_PREDECESSOR"
    local current_egress_cwd
    current_egress_cwd="$(ssh "$KL_HOST" "pid=\$(systemctl show -p MainPID --value '$V5_EGRESS_UNIT' 2>/dev/null || echo 0); test \"\${pid:-0}\" -gt 0 && readlink -f /proc/\$pid/cwd" 2>/dev/null || true)"
    [[ -n "$egress_prev_release" && "$current_egress_cwd" == "$egress_prev_release" ]] \
      && assert_release_marker "$egress_prev_release" egress || {
      echo "✗ --egress 起手无法钉住完整旧 egress cwd:$egress_prev_release；拒绝先改 master" >&2; exit 1;
    }
    echo "  · egress 回退点:$egress_prev_release"
  fi
  echo "── 部署顺序守卫:校验 runtime_channel 列(0088)已应用 ──"
  assert_runtime_channel_column
  # build_release:从锁定 sha 的 git archive 建不可变 release(--with-dist 时 vite build 进
  # reldir,代码+前端同一 release 共享一次翻转+重启;无 --with-dist 则硬链继承当前 dist)。
  # 背景(2026-07-10 事故):deploy 后紧跟 --dist 的成对重启会把刚续写的 turn 二次掐死 →
  # 蓝绿下天然一次翻转一次重启,不会再成对重启。
  build_release || { echo "✗ build_release 失败,未激活任何 release(live 未改)" >&2; exit 1; }
  # 历史部署曾把 release 解成 775/664，并在共享 env 留 dev-only OPTIONAL=1。
  # 目标 release 已由 build_release 收紧后，先无重启地修 current+unit+env；即使后续
  # tuple/激活失败，未来意外重启也不会再无 baseline 裸奔。
  prepare_live_baseline_safety || { echo "✗ live baseline 安全迁移失败,未激活新 release" >&2; exit 1; }
  if [[ "$DEFER_KNOWLEDGE_PLANET_UPGRADE" == 1 ]]; then
    echo "── Knowledge Planet Plugin:setup-first 前置守卫(旧 v1.0 exact pin + 零账号)──"
    knowledge_planet_plugin_assert_setup_first_safe "$BUILT_RELEASE" pre \
      || { echo "✗ Knowledge Planet setup-first 前置守卫失败,未激活新 release" >&2; exit 1; }
    kp_setup_plugin_version_id="$KNOWLEDGE_PLANET_SETUP_VERSION_ID"
  else
    echo "── Knowledge Planet Plugin:advisory status(非阻断;DB 零写入)──"
    knowledge_planet_plugin_advisory_gate "$BUILT_RELEASE" \
      || { echo "✗ Knowledge Planet advisory status 基础设施故障(读不到状态,fail-closed),未激活新 release" >&2; exit 1; }
  fi
  # runtime hotcfg 机制门控(§5):两机制**各自独立开关,默认关**;未启用 → 完全退化为原
  # "activate_release(翻转+restart)"路径,合并后未部署期间生产行为**零变化**。
  # 启用时:build bundle/release(仅启用者)→ activate saga 取代直接 restart(master 源码翻转
  # 作为 saga 的 extra_apply,与 tuple env/current 同一原子回滚单元,单次重启)。
  # R2-B1:--disable-* 时该轴不 build,但**必须走 saga**(把空值写进 env + restart + smoke + history 留痕)。
  local hc_bundle=0 hc_release=0 hc_any=0
  if hotcfg_bundle_axis_on; then hc_bundle=1; hc_any=1; fi
  if hotcfg_release_axis_on; then hc_release=1; hc_any=1; fi
  [[ "$DISABLE_BUNDLE_FLAG" == 1 || "$DISABLE_RELEASE_FLAG" == 1 ]] && hc_any=1
  if [[ "$hc_any" == 1 ]] && ! assert_direct_turn_timeline_pair "$kp_previous_release" "$BUILT_RELEASE" "runtime hotcfg activation"; then
    if [[ "$DISABLE_BUNDLE_FLAG" == 1 || "$DISABLE_RELEASE_FLAG" == 1 ]]; then
      echo "✗ 首次 direct timeline capability 升级不能与 hotcfg disable 轴变更合并；先完成普通单-master deploy。" >&2
      exit 1
    fi
    # The hotcfg saga may automatically restore the old master after the new
    # process has served. Across this irreversible floor, first adoption uses
    # the ordinary single-master restart and leaves the runtime tuple unchanged.
    echo "  · 首次 direct timeline capability 升级改走普通单-master restart；runtime tuple 保持不变。"
    hc_bundle=0; hc_release=0; hc_any=0
  fi
  if [[ "$hc_any" == 1 ]]; then
    echo "── runtime hotcfg 已启用(bundle=$hc_bundle release=$hc_release disable_bundle=$DISABLE_BUNDLE_FLAG disable_release=$DISABLE_RELEASE_FLAG)──"
    if [[ "$hc_bundle" == 1 ]]; then build_platform_bundle || { echo "✗ platform bundle 构建失败(live 未改)" >&2; exit 1; }; fi
    if [[ "$hc_release" == 1 ]]; then build_runtime_release || { echo "✗ runtime release 构建失败(live 未改)" >&2; exit 1; }; fi
    sync_assets_to_pool "$BUILT_RELEASE" || { echo "✗ assets 预同步失败(live 未改)" >&2; exit 1; }
  fi
  begin_planned_maintenance deploy "$RESTART_EGRESS"
  # RFC §1.2:进入不可逆翻转段(KP 门关闭 / release 激活 / egress)前活体断言远端 lease 仍持有。
  # 此刻 live master 仍未改,失活即 end maintenance 后干净退出(无 KP 门需回滚)。
  if ! assert_mutation_lease_alive "deploy-master-flip"; then
    echo "✗ production-mutation lease 失活;跳过 maintenance cleanup，crash-stop(live 未改)" >&2
    exit 86
  fi
  echo "── Knowledge Planet Plugin:关闭跨版本执行门──"
  local kp_deploy_bracket=1
  if ! knowledge_planet_plugin_close_gate "$BUILT_RELEASE"; then
    require_mutation_lease_for_compensation "knowledge-planet-close-gate-recovery" || exit 86
    if [[ "$DEFER_KNOWLEDGE_PLANET_UPGRADE" == 1 ]]; then
      # setup-first 是显式插件升级 lane,门关不上=前提不成立,保持阻断语义。
      knowledge_planet_plugin_open_setup_first_gate_to_version \
        "$BUILT_RELEASE" "$kp_setup_plugin_version_id" \
        || mark_deploy_recovery_required "Knowledge Planet setup-first gate close commit unknown and exact restore failed"
      end_planned_maintenance || true
      echo "✗ Knowledge Planet setup-first 执行门关闭失败(live 未改)" >&2
      exit 1
    fi
    # 2026-07-17 架构纠偏:普通 deploy 的插件括号 best-effort——门关不上则插件
    # 零接触(不迁移不 seed,handoff 保留待下次),平台部署继续。
    echo "⚠ Knowledge Planet 执行门关闭失败:插件零接触继续部署(版本 pin 不动,promotion 顺延)" >&2
    # C6:关门失败后重开 current-version 门若**也**失败,则门处于无法裁决态,须标记人工恢复
    # (与 4649/4994/5026 的兄弟路径对称,不再 `|| true` 静默吞掉门恢复失败)。
    knowledge_planet_plugin_open_gate_current "$BUILT_RELEASE" \
      || mark_deploy_recovery_required "Knowledge Planet gate close failed and current-version gate restore also failed"
    kp_deploy_bracket=0
    KP_PLUGIN_PROMOTE=0
  fi
  kp_previous_plugin_version_id="$KNOWLEDGE_PLANET_GATE_VERSION_ID"
  if [[ "$DEFER_KNOWLEDGE_PLANET_UPGRADE" == 1 ]]; then
    if [[ "$DRY" != 1 && "$kp_previous_plugin_version_id" != "$kp_setup_plugin_version_id" ]]; then
      require_mutation_lease_for_compensation "knowledge-planet-setup-first-version-recovery" || exit 86
      knowledge_planet_plugin_open_setup_first_gate_to_version \
        "$BUILT_RELEASE" "$kp_setup_plugin_version_id" \
        || mark_deploy_recovery_required "Knowledge Planet setup-first close changed the exact predecessor and restore failed"
      end_planned_maintenance || true
      echo "✗ Knowledge Planet setup-first 关闭门前后 current version 不一致(pre=${kp_setup_plugin_version_id:-<none>} close=${kp_previous_plugin_version_id:-<none>})" >&2
      exit 1
    fi
    # pre guard has already proven the exact compatible predecessor. setup-first
    # never transitions its DB pin; compensation reopens this captured ID.
    kp_had_previous_plugin=1
  elif [[ "$kp_deploy_bracket" == 0 ]]; then
    # 零接触:门未关,不做 classify,补偿路径也不得碰插件。
    kp_had_previous_plugin=0
  else
    if ! knowledge_planet_plugin_classify_previous_release \
      "$BUILT_RELEASE" "$kp_previous_release" "$kp_previous_plugin_version_id"; then
      # 2026-07-17 纠偏:classify 只服务于"插件迁移的补偿目标可用性"判定;
      # 失败=降级为零接触(重开门后继续部署),不再阻断平台部署。
      echo "⚠ Knowledge Planet previous-release classify 失败:插件零接触继续部署" >&2
      require_mutation_lease_for_compensation "knowledge-planet-classify-recovery" || exit 86
      knowledge_planet_plugin_open_gate_to_release "$BUILT_RELEASE" "$kp_previous_release" \
        || knowledge_planet_plugin_open_gate_current "$BUILT_RELEASE" \
        || mark_deploy_recovery_required "Knowledge Planet previous-release classification failed and gate restore was not confirmed"
      kp_deploy_bracket=0
      KP_PLUGIN_PROMOTE=0
      kp_had_previous_plugin=0
    else
      kp_had_previous_plugin="$KNOWLEDGE_PLANET_PREVIOUS_RELEASE_AVAILABLE"
    fi
  fi
  echo "  · Knowledge Planet closed current=${kp_previous_plugin_version_id:-<none>} previous-exact-available=$kp_had_previous_plugin"
  if [[ "$hc_any" == 1 ]]; then
    if ! activate_runtime_tuple; then
      require_mutation_lease_for_compensation "runtime-tuple-activation-recovery" || exit 86
      if [[ "$kp_had_previous_plugin" == 1 ]]; then
        if [[ "$DEFER_KNOWLEDGE_PLANET_UPGRADE" == 1 ]]; then
          knowledge_planet_plugin_open_setup_first_gate_to_version \
            "$BUILT_RELEASE" "$kp_setup_plugin_version_id" \
            || mark_deploy_recovery_required "tuple 激活回滚后 Knowledge Planet setup-first exact gate 未恢复"
        else
          knowledge_planet_plugin_open_gate_to_release "$BUILT_RELEASE" "$kp_previous_release" \
            || mark_deploy_recovery_required "tuple 激活回滚后 Knowledge Planet 执行门未恢复"
        fi
      fi
      end_planned_maintenance || true
      echo "✗ tuple 激活失败(saga 已自动回滚)" >&2
      exit 1
    fi
  else
    if ! activate_release "$BUILT_RELEASE"; then
      require_mutation_lease_for_compensation "release-activation-gate-recovery" || exit 86
      if [[ "$kp_had_previous_plugin" == 1 ]]; then
        if [[ "$DEFER_KNOWLEDGE_PLANET_UPGRADE" == 1 ]]; then
          knowledge_planet_plugin_open_setup_first_gate_to_version \
            "$BUILT_RELEASE" "$kp_setup_plugin_version_id" \
            || mark_deploy_recovery_required "release 激活回滚后 Knowledge Planet setup-first exact gate 未恢复"
        else
          knowledge_planet_plugin_open_gate_to_release "$BUILT_RELEASE" "$kp_previous_release" \
            || mark_deploy_recovery_required "release 激活回滚后 Knowledge Planet 执行门未恢复"
        fi
      fi
      end_planned_maintenance || true
      exit 1
    fi
  fi
  local egress_switched=0 validation_failure=""
  if [[ "$RESTART_EGRESS" == 1 ]]; then
    # egress 翻转前再断言一次 lease(master 已翻转,失活 → 走 validation_failure 对称补偿)。
    if ! assert_mutation_lease_alive "deploy-egress-flip"; then
      echo "✗ production-mutation lease 失活(egress 激活前)；禁止进入 validation compensation" >&2
      exit 86
    else
      echo "── 激活 openclaude-v5-egress 独立 release(显式 --egress;SIGTERM drain 在飞流)──"
      if activate_egress_release "$BUILT_RELEASE" "$egress_prev_release"; then
        egress_switched=1
      else
        validation_failure="egress activation failed"
      fi
    fi
  fi
  if [[ -z "$validation_failure" && "$DEFER_KNOWLEDGE_PLANET_UPGRADE" == 1 ]]; then
    echo "── Knowledge Planet Plugin:setup-first drain 后守卫(门保持关闭、账号仍为零)──"
    if ! knowledge_planet_plugin_assert_setup_first_safe "$BUILT_RELEASE" post; then
      validation_failure="Knowledge Planet setup-first post-drain guard failed"
    elif [[ "$DRY" != 1 && "$KNOWLEDGE_PLANET_SETUP_VERSION_ID" != "$kp_setup_plugin_version_id" ]]; then
      validation_failure="Knowledge Planet setup-first predecessor changed during drain"
    fi
  fi
  if [[ -z "$validation_failure" && "$DRY" != 1 ]] && ! smoke "$ACTIVE_PORT"; then
    validation_failure="full master smoke failed"
  fi
  # 2026-07-26:真 turn 升级为双引擎矩阵,且 E2E 旅程门从「end_planned_maintenance 之后
  # 裸 exit 1」上移进本 validation 链 —— 失败走与 full smoke 同一条对称补偿(回旧 source/
  # 账号版本),不再把坏版本留在线上只打印红字。
  if [[ -z "$validation_failure" && "$DRY" != 1 ]] \
    && ! minimum_functional_core deploy "$BUILT_RELEASE" "$ACTIVE_PORT"; then
    validation_failure="minimum functional core failed(双引擎真 turn / J1-J5 用户旅程)"
  fi
  if [[ -z "$validation_failure" && "$WITH_DIST" == 1 ]] \
    && ! dist_handshake_smoke "$ACTIVE_PORT"; then
    validation_failure="frontend build handshake failed"
  fi
  # 公网面 + 资产面(审计 8):smoke/journey 都直连 master 端口,Caddy 落错 slot 与
  # 哈希 chunk/admin.html 不可达此前均无门。同样进对称补偿链。
  if [[ -z "$validation_failure" && "$DRY" != 1 ]] && ! verify_public_surface deploy; then
    validation_failure="public/asset surface verification failed(Caddy 入口 slot 或 /assets|/admin.html 不可达)"
  fi
  if [[ -z "$validation_failure" && "$DEFER_KNOWLEDGE_PLANET_UPGRADE" == 1 ]]; then
    echo "── Knowledge Planet Plugin:扫码 UI 已就绪，恢复旧 v1.0 listing gate──"
    if ! knowledge_planet_plugin_open_setup_first_gate_to_version \
      "$BUILT_RELEASE" "$kp_setup_plugin_version_id"; then
      validation_failure="Knowledge Planet setup-first exact old gate reopen failed"
    fi
  fi
  if [[ -n "$validation_failure" ]]; then
    echo "✗ $validation_failure；Plugin 门仍关闭，开始 source/DB 对称补偿" >&2
    # F7:补偿(恢复旧稳态)前 复核 lease,缩小与自愈 host-action 并发窗;失活则 crash-stop，禁止无 lease 补偿。
    require_mutation_lease_for_compensation "deploy-validation-compensation" || exit 86
    if [[ "$DEFER_KNOWLEDGE_PLANET_UPGRADE" == 1 ]]; then
      knowledge_planet_compensate_setup_first \
        "$BUILT_RELEASE" "$kp_previous_release" "$hc_any" \
        "$egress_switched" "$egress_prev_release" "$kp_setup_plugin_version_id" \
        || { mark_deploy_recovery_required "setup-first validation failed and exact source/gate compensation failed: $validation_failure"; exit 1; }
    else
      knowledge_planet_compensate_deploy \
        "$BUILT_RELEASE" "$kp_previous_release" "$hc_any" \
        "$egress_switched" "$egress_prev_release" "$kp_had_previous_plugin" \
        || { mark_deploy_recovery_required "pre-seed validation failed and Plugin/source compensation failed: $validation_failure"; exit 1; }
    fi
    end_planned_maintenance || true
    echo "✗ 部署强校验失败；已确认回到旧 source/账号版本，部署未生效" >&2
    exit 1
  fi
  if [[ "$DEFER_KNOWLEDGE_PLANET_UPGRADE" == 1 ]]; then
    echo "  ✓ setup-first 完成：扫码实时感知已上线；Plugin/安装仍钉旧 v1.0，等待用户在界面绑定"
    end_planned_maintenance
    smoke_sourcemap_sealed || exit 1
    gc_releases
    [[ "$hc_any" == 1 ]] && gc_runtime_artifacts
    echo "✓ deploy 完成(release=$BUILT_RELEASE,slot=$ACTIVE_SLOT,knowledge-planet=setup-first)。"
    return 0
  fi
  if [[ "$kp_deploy_bracket" == 0 ]]; then
    echo "  · Knowledge Planet:零接触部署(门未关/classify 降级),跳过 seed;promotion 顺延至下次部署或显式 verify lane"
    end_planned_maintenance
    smoke_sourcemap_sealed || exit 1
    gc_releases
    [[ "$hc_any" == 1 ]] && gc_runtime_artifacts
    echo "✓ deploy 完成(release=$BUILT_RELEASE,slot=$ACTIVE_SLOT,knowledge-planet=zero-touch)。"
    return 0
  fi
  echo "── Knowledge Planet Plugin:消费加密交接 + 绑定账号 + 官方发布/install 升级 + 旧 Skill 加法迁移──"
  if ! knowledge_planet_plugin_seed "$BUILT_RELEASE"; then
    echo "✗ Knowledge Planet Plugin 发布/迁移失败；执行门保持关闭，开始 source+DB 对称补偿" >&2
    # F7:同上,补偿前 复核 lease(helper 幂等,与上方 validation 补偿可安全连调)。
    require_mutation_lease_for_compensation "deploy-validation-compensation" || exit 86
    knowledge_planet_compensate_deploy \
      "$BUILT_RELEASE" "$kp_previous_release" "$hc_any" \
      "$egress_switched" "$egress_prev_release" "$kp_had_previous_plugin" \
      || { mark_deploy_recovery_required "Plugin seed failed and source/DB/egress compensation failed"; exit 1; }
    end_planned_maintenance || true
    echo "✗ Knowledge Planet Plugin seed 失败；已确认回到旧 source/账号版本，部署未生效" >&2
    exit 1
  fi
  end_planned_maintenance
  smoke_sourcemap_sealed || exit 1
  gc_releases
  [[ "$hc_any" == 1 ]] && gc_runtime_artifacts   # best-effort(§1.4:失败只告警不回滚)
  echo "✓ deploy 完成(release=$BUILT_RELEASE,slot=$ACTIVE_SLOT)。"
}

# ───────────────────────── offline recycle:原子切换前停机清场 ───────────────
offline_recycle_inner() {
  echo "══ v5 offline recycle on $KL_HOST ══"
  assert_v5_master_inactive
  assert_v3_inactive_for_gpt_cutover
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] Docker v5 label 清理 + 5s quiet barrier（禁止 DB mutation）"
    return 0
  fi
  ssh "$KL_HOST" bash -s <<'REMOTE'
set -euo pipefail
label='com.openclaude.runtime_channel=v5'
quiet_since=''
deadline=$(( $(date +%s) + 60 ))

while :; do
  ids="$(docker ps -aq --filter "label=$label")"
  if [[ -n "$ids" ]]; then
    docker rm -f $ids >/dev/null
    quiet_since=''
  fi

  remain="$(docker ps -aq --filter "label=$label")"
  now="$(date +%s)"

  if [[ -z "$remain" ]]; then
    [[ -n "$quiet_since" ]] || quiet_since="$now"
    if (( now - quiet_since >= 5 )); then break; fi
  else
    quiet_since=''
  fi

  (( now < deadline )) || {
    echo 'FATAL: v5 Docker/DB failed to reach 5s quiet window within 60s' >&2
    exit 1
  }
  sleep 1
done

[[ -z "$(docker ps -aq --filter "label=$label")" ]] || {
  echo 'FATAL: v5 container appeared after quiet barrier' >&2
  exit 1
}
echo '  ✓ v5 offline recycle: Docker empty + quiet>=5s（数据库零写入）'
REMOTE
}

offline_recycle() {
  local rc had_errexit=0
  begin_cutover_step prepared recycling || return 1
  [[ $- == *e* ]] && had_errexit=1
  set +e
  ( set -Eeuo pipefail; offline_recycle_inner )
  rc=$?
  if [[ "$had_errexit" == 1 ]]; then set -e; fi
  if [[ "$rc" == 0 ]]; then
    cutover_transition recycling recycled || { recover_cutover "cannot commit recycled state"; return 1; }
    return 0
  fi
  [[ "$rc" == 86 ]] && { echo "FATAL:offline recycle lease loss；跳过 recovery，保留 cutover 状态" >&2; return 86; }
  recover_cutover "offline recycle failed"
  return "$rc"
}

# ───────────────────────── stage/activate:停机原子迁移 lane ─────────────────
stage_inner() {
  echo "══ v5 stage(source + dist, no start)on $KL_HOST ══"
  assert_overrides_no_remove_keys
  assert_clean_source_tree
  assert_v5_master_inactive
  assert_v3_inactive_for_gpt_cutover
  snapshot_and_sync_source
  assert_runtime_channel_column
  build_and_sync_dist
  assert_v5_master_inactive
  echo "✓ stage 完成:$V5_UNIT 保持停机,等待 migration/runtime env 后 activate。"
}

stage() {
  local rc had_errexit=0
  begin_cutover_step recycled staging || return 1
  [[ $- == *e* ]] && had_errexit=1
  set +e
  ( set -Eeuo pipefail; stage_inner )
  rc=$?
  if [[ "$had_errexit" == 1 ]]; then set -e; fi
  if [[ "$rc" == 0 ]]; then
    cutover_transition staging staged || { recover_cutover "cannot commit staged state"; return 1; }
    return 0
  fi
  [[ "$rc" == 86 ]] && { echo "FATAL:stage lease loss；跳过 recovery，保留 cutover 状态" >&2; return 86; }
  recover_cutover "stage failed"
  return "$rc"
}

activate_staged_inner() {
  echo "══ v5 activate staged on $KL_HOST ══"
  assert_overrides_no_remove_keys
  assert_clean_source_tree
  assert_v5_master_inactive
  assert_v3_inactive_for_gpt_cutover
  assert_runtime_channel_column
  assert_gpt56_migration_ready
  knowledge_planet_plugin_assert_release_compatible "$REMOTE_SRC" "$REMOTE_SRC" \
    || echo "⚠ staged source 的 Knowledge Planet 插件制品与 DB 已审批版本不一致:插件将 RUNTIME_UNAVAILABLE 直至验证晋升(运行时按内容 pin fail-closed);staged cutover 不因此阻断(2026-07-17 纠偏)" >&2
  install_cutover_target_image_env
  local expected_commit expected_full_commit expected_build remote_commit remote_build runtime_image
  local image_commit image_codex_version actual_codex_version
  expected_commit="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
  expected_full_commit="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  expected_build=""
  if [[ "$DRY" != 1 ]]; then
    expected_build="$(grep -o 'name="oc-build" content="[0-9a-f]\{8,32\}"' "$REPO_ROOT/packages/web-react/dist/index.html" | grep -o '[0-9a-f]\{8,32\}' | head -1 || true)"
    [[ -n "$expected_build" ]] || { echo "✗ 本地 dist 缺 oc-build meta" >&2; exit 1; }
    remote_commit="$(ssh "$KL_HOST" "jq -r .commit '$REMOTE_SRC/VERSION.json'")"
    remote_build="$(ssh "$KL_HOST" "grep -o 'name=\"oc-build\" content=\"[0-9a-f]\\{8,32\\}\"' '$REMOTE_SRC/packages/web-react/dist/index.html' | grep -o '[0-9a-f]\\{8,32\\}' | head -1")"
    [[ "$remote_commit" == "$expected_commit" ]] || {
      echo "✗ staged commit=$remote_commit,expected=$expected_commit" >&2; exit 1;
    }
    [[ -n "$expected_build" && "$remote_build" == "$expected_build" ]] || {
      echo "✗ staged oc-build=$remote_build,expected=$expected_build" >&2; exit 1;
    }
    runtime_image="$(ssh "$KL_HOST" "grep '^OC_RUNTIME_IMAGE=' '$V5_ENV' | tail -n 1 | cut -d= -f2-")"
    [[ -n "$runtime_image" ]] || { echo "✗ OC_RUNTIME_IMAGE missing" >&2; exit 1; }
    ssh "$KL_HOST" "docker image inspect '$runtime_image' >/dev/null"
    image_commit="$(ssh "$KL_HOST" "docker image inspect --format '{{ index .Config.Labels \"oc.runtime.source_commit\" }}' '$runtime_image'")"
    image_codex_version="$(ssh "$KL_HOST" "docker image inspect --format '{{ index .Config.Labels \"oc.runtime.codex_version\" }}' '$runtime_image'")"
    [[ "$image_commit" =~ ^[0-9a-f]{7,40}$ && "$expected_full_commit" == "$image_commit"* ]] || {
      echo "✗ runtime image source_commit=$image_commit is not target commit $expected_full_commit 的前缀" >&2; exit 1;
    }
    [[ "$image_codex_version" == "0.144.0" ]] || {
      echo "✗ runtime image codex label=$image_codex_version,expected=0.144.0" >&2; exit 1;
    }
    actual_codex_version="$(ssh "$KL_HOST" "docker run --rm --entrypoint codex '$runtime_image' --version")"
    [[ "$actual_codex_version" == "codex-cli 0.144.0" ]] || {
      echo "✗ runtime image codex binary=$actual_codex_version,expected='codex-cli 0.144.0'" >&2; exit 1;
    }
    echo "  ✓ runtime image source=$image_commit,codex=$actual_codex_version"
  fi
  # RFC §1.2:此处 sshk start 是 staged lane 的真正激活翻转点(unit 从停机→起旧同构状态)。翻转前
  # 活体断言远端 lease;此刻 unit 仍停(live 未改),失活即 rc=86，wrapper 明确跳过 recover_cutover。
  assert_direct_turn_timeline_offline_target "$REMOTE_SRC" "$CUTOVER_ROOT/$CUTOVER_NONCE/source" || return 1
  assert_mutation_lease_alive "activate-staged-flip" || { echo "✗ production-mutation lease 失活;crash-stop staged(unit 仍停,live 未改)" >&2; exit 86; }
  mark_cutover_candidate_start_attempted || return 1
  echo "── start openclaude-v5(同构状态一次性激活)──"
  sshk "systemctl start $V5_UNIT"
  run "sleep 4"
  if [[ "$DRY" != 1 ]]; then
    if ! smoke; then
      echo "✗ staged activate smoke 失败；交由统一恢复器恢复旧版本（不会再次停掉恢复中的服务）" >&2
      return 1
    fi
    local live_build
    live_build="$(ssh "$KL_HOST" "curl -fsS http://127.0.0.1:${V5_PORT}/" | grep -o 'name=\"oc-build\" content=\"[0-9a-f]\{8,32\}\"' | grep -o '[0-9a-f]\{8,32\}' | head -1 || true)"
    [[ "$live_build" == "$expected_build" ]] || {
      echo "✗ live oc-build=$live_build,expected=$expected_build；交由统一恢复器" >&2
      return 1
    }
  fi
  echo "✓ staged v5 已激活。"
}

activate_staged() {
  local rc had_errexit=0
  begin_cutover_step staged activating || return 1
  [[ $- == *e* ]] && had_errexit=1
  set +e
  ( set -Eeuo pipefail; activate_staged_inner )
  rc=$?
  if [[ "$had_errexit" == 1 ]]; then set -e; fi
  if [[ "$rc" == 0 ]]; then
    cutover_transition activating activated || { recover_cutover "cannot commit activated state"; return 1; }
    clear_cutover_maintenance || echo "⚠ 激活成功但 maintenance marker 清理失败；最迟在 deadline 自动失效" >&2
    return 0
  fi
  [[ "$rc" == 86 ]] && { echo "FATAL:activate-staged lease loss；跳过 recovery/maintenance cleanup，保留 cutover 状态" >&2; return 86; }
  recover_cutover "activate failed"
  return "$rc"
}

# ───────────────────────── dist:前端生效面(web-react)─────────────────────────
# dist 被默认 deploy 的 RSYNC_EXCLUDES 排除——前端是独立生效面。本模式收口旧的
# "手敲 vite build + rsync --delete" 流程(playbook §生效面矩阵同步改),三点语义:
#   1. 竞态安全:资产**加法**同步(无 --delete)且先资产后根文件 → 新 index.html 永远
#      只引用已就位的哈希资产,部署窗口内也无 404;旧资产保留给长驻旧 index.html 的
#      标签页(2026-07-07 07:31 实测 --delete 造成过 404 白屏)。
#   2. GC:assets 下 mtime +14 天(=14 天未被任何构建重新 ship,rsync -a 保留构建时
#      间戳)删除,防无限膨胀。
#   3. restart + 版本握手 smoke:SPA 缓存与 sys.frontend_build 握手都要求 dist 变更后
#      重启 master(全量 WS 重连 → 客户端拿到新 build id → 安全点软刷新);线上 / 的
#      oc-build meta 必须等于本地构建值,fail-closed。
# 回滚:index.html 回滚 = checkout 旧源码重跑 --dist;旧资产 14 天窗口内一直在线。
deploy_dist() {
  echo "══ v5 dist deploy(前端生效面,蓝绿)on $KL_HOST ══"
  # MAJOR 3 + BLOCKER 4:rollout 进行中拒绝;解析 active slot(蓝绿 finalize 后可能 B)。
  assert_no_rollout_in_progress
  resolve_active_lane
  assert_bluegreen_layout "$ACTIVE_SRC"
  WITH_DIST=1   # 蓝绿:前端变更=建含新 dist 的完整 release + 原子翻转(同 deploy,一次重启)
  # 2026-07-26 审计 3:--dist 此前零补偿(smoke/handshake 失败 = set -e 裸退出,坏前端保持 live)。
  # 对称补偿的前提是**翻转前**钉死回退点,故 previous release 提前到任何 build/flip 之前捕获。
  local dist_previous_release=""
  dist_previous_release="$(bg_current_release "$ACTIVE_SRC")"
  [[ "$DRY" == 1 || -n "$dist_previous_release" ]] \
    || { echo "✗ --dist 无法解析当前 live release(无回退点),拒绝翻转" >&2; exit 1; }
  build_release || { echo "✗ build_release 失败,未激活(live 未改)" >&2; exit 1; }
  knowledge_planet_plugin_assert_release_compatible "$BUILT_RELEASE" "$BUILT_RELEASE" \
    || echo "⚠ --dist 目标的 Knowledge Planet 插件制品与 DB 已审批版本不一致:插件将 RUNTIME_UNAVAILABLE 直至验证晋升;--dist 不因此阻断(2026-07-17 纠偏)" >&2
  prepare_live_baseline_safety || { echo "✗ live baseline 安全迁移失败,未激活新 release" >&2; exit 1; }
  # hotcfg 启用时同样走 tuple saga(master 源码翻转=extra_apply,单次重启)。纯前端变更下
  # bundle/release digest 不变 → 幂等复用零 churn;tuple env 不变 → 只是随本次重启一并生效。
  # R2-B1:--disable-* 同 deploy(),该轴不 build 但强制走 saga 写空值。
  local hc_bundle=0 hc_release=0 hc_any=0
  if hotcfg_bundle_axis_on; then hc_bundle=1; hc_any=1; fi
  if hotcfg_release_axis_on; then hc_release=1; hc_any=1; fi
  [[ "$DISABLE_BUNDLE_FLAG" == 1 || "$DISABLE_RELEASE_FLAG" == 1 ]] && hc_any=1
  if [[ "$hc_any" == 1 ]]; then
    if ! assert_direct_turn_timeline_pair "$dist_previous_release" "$BUILT_RELEASE" "runtime hotcfg dist activation"; then
      if [[ "$DISABLE_BUNDLE_FLAG" == 1 || "$DISABLE_RELEASE_FLAG" == 1 ]]; then
        echo "✗ 首次 direct timeline capability 升级不能与 hotcfg disable 轴变更合并；先完成普通单-master deploy。" >&2
        exit 1
      fi
      echo "  · 首次 direct timeline capability 升级改走普通单-master restart；runtime tuple 保持不变。"
      hc_bundle=0; hc_release=0; hc_any=0
    fi
  fi
  if [[ "$hc_any" == 1 ]]; then
    if [[ "$hc_bundle" == 1 ]]; then build_platform_bundle || { echo "✗ platform bundle 构建失败(live 未改)" >&2; exit 1; }; fi
    if [[ "$hc_release" == 1 ]]; then build_runtime_release || { echo "✗ runtime release 构建失败(live 未改)" >&2; exit 1; }; fi
    sync_assets_to_pool "$BUILT_RELEASE" || { echo "✗ assets 预同步失败(live 未改)" >&2; exit 1; }
  fi
  begin_planned_maintenance dist 0
  # RFC §1.2:dist 翻转前活体断言远端 lease(此刻 live 未改,失活即干净退出)。
  if ! assert_mutation_lease_alive "dist-flip"; then
    echo "✗ production-mutation lease 失活;跳过 maintenance cleanup，crash-stop(live 未改)" >&2
    exit 86
  fi
  if [[ "$hc_any" == 1 ]]; then
    activate_runtime_tuple || { echo "✗ tuple 激活失败(saga 已自动回滚)" >&2; exit 1; }
  else
    activate_release "$BUILT_RELEASE" || {
      end_planned_maintenance || true
      echo "✗ --dist release 激活失败(activate_release 已自恢复旧运行面)" >&2
      exit 1
    }
  fi
  # ── validation 链(与 deploy() 对称;审计 3)──────────────────────────────
  # --dist 走 build_release 构建的是整棵源码树 = 完整后端部署,不只前端;此前它既没有
  # 真 turn 硬门,失败也零补偿。现补齐:full smoke → 最小功能核(双引擎真 turn + J1-J5)
  # → dist 版本握手 → 公网/资产面,任一失败走 compensate_dist_activation 回旧 release。
  local dist_validation_failure=""
  if [[ "$DRY" != 1 ]] && ! smoke "$ACTIVE_PORT"; then
    dist_validation_failure="full master smoke failed"
  fi
  if [[ -z "$dist_validation_failure" && "$DRY" != 1 ]] \
    && ! minimum_functional_core dist "$BUILT_RELEASE" "$ACTIVE_PORT"; then
    dist_validation_failure="minimum functional core failed(双引擎真 turn / J1-J5 用户旅程)"
  fi
  if [[ -z "$dist_validation_failure" ]] && ! dist_handshake_smoke "$ACTIVE_PORT"; then
    dist_validation_failure="frontend build handshake failed"
  fi
  if [[ -z "$dist_validation_failure" && "$DRY" != 1 ]] && ! verify_public_surface dist; then
    dist_validation_failure="public/asset surface verification failed(Caddy 入口 slot 或 /assets|/admin.html 不可达)"
  fi
  if [[ -n "$dist_validation_failure" ]]; then
    echo "✗ --dist 强校验失败:$dist_validation_failure;开始对称补偿(回 $dist_previous_release)" >&2
    compensate_dist_activation "$BUILT_RELEASE" "$dist_previous_release" "$hc_any" \
      || { mark_deploy_recovery_required "--dist validation failed and activation compensation failed: $dist_validation_failure"; exit 1; }
    end_planned_maintenance || true
    echo "✗ --dist 强校验失败；已确认回到旧 release,前端变更未生效" >&2
    exit 1
  fi
  end_planned_maintenance
  # dist(纯前端)是 UI 回归的最高发面(2026-07-18 附件事故即 --dist 上线),E2E 旅程门必跑。
  smoke_sourcemap_sealed || exit 1
  gc_releases
  [[ "$hc_any" == 1 ]] && gc_runtime_artifacts
  echo "✓ dist deploy 完成(release=$BUILT_RELEASE,slot=$ACTIVE_SLOT)。"
}

# --dist 的对称补偿(审计 3)。**复用**既有机制,不造第二套:hotcfg 面走 rollback_runtime_tuple
# 反向一步(与 knowledge_planet_compensate_setup_first 同形参),非 hotcfg 面走 activate_release
# 回旧 release(与 knowledge_planet_compensate_deploy 同一路径)。--dist 从不关插件执行门,
# 故 defer_plugin_open=1 + plugin_previous_exists=0,绝不在补偿里去碰插件 pin。
compensate_dist_activation() { # <candidate release> <previous release> <hotcfg:0|1>
  local candidate="$1" previous="$2" hotcfg="$3" failed=0
  require_mutation_lease_for_compensation "dist-activation-compensation" || exit 86
  [[ "$hotcfg" =~ ^[01]$ ]] || { echo "✗ dist compensation hotcfg 标志非法:$hotcfg" >&2; return 2; }
  [[ -n "$previous" ]] || { echo "✗ dist compensation 缺 previous release 回退点" >&2; return 2; }
  echo "── --dist 对称补偿:回到 $previous(hotcfg=$hotcfg)──"
  if [[ "$hotcfg" == 1 ]]; then
    if ! rollback_runtime_tuple 1 1 "$candidate" 0; then
      failed=1
    elif ! smoke "$ACTIVE_PORT"; then
      failed=1
    fi
  else
    if ! activate_release "$previous"; then
      failed=1
    elif ! smoke "$ACTIVE_PORT"; then
      failed=1
    fi
  fi
  [[ "$failed" == 0 ]] && echo "  ✓ --dist 补偿完成:旧 release 已回到 live 并通过 smoke"
  return "$failed"
}

# ───────────────────────── rollback ─────────────────────────
rollback() {
  echo "══ v5 rollback(蓝绿:symlink 回切,秒级)══"
  # MAJOR 3:rollout 进行中(canary/finalizing/aborting)拒绝 rollback——用 --abort/--finalize 收敛到 stable 再回滚。
  assert_no_rollout_in_progress
  # BLOCKER 4:解析 active slot(蓝绿 A→B finalize 后 active 可能是 B)→ 回滚操作 active slot 的 symlink/unit。
  resolve_active_lane
  assert_bluegreen_layout "$ACTIVE_SRC"
  prepare_live_baseline_safety || { echo "✗ live baseline 安全迁移失败,拒绝 rollback" >&2; exit 1; }
  # hotcfg 启用 → tuple 感知回滚:master 源码 symlink 与 runtime tuple(env 四键+current)是同一
  # deploy 的一对孪生产物,必须从**同一条** history 记录一起翻回(M7:master 与 tuple 不再各取一源)。
  # R2-B1:两轴刚被 --disable(env 已空)时 enabled 判定全 0,但 history 有账 → 仍须走 tuple 感知
  # 路径才能"退回启用态";故入口判定并上 hotcfg_history_present。
  if hotcfg_bundle_enabled || hotcfg_release_enabled || hotcfg_history_present; then
    if [[ "$DRY" == 1 ]]; then
      echo "  [dry-run] hotcfg rollback(slot=$ACTIVE_SLOT):N=1 以 state.previous 为 master 权威(P3 master-only 则保留当前 tuple)→slot-aware saga+三态 state commit/reconcile"
      return 0
    fi
    local kp_rollback_helper kp_rollback_target storage_rollback_target storage_history_row
    kp_rollback_helper="$(bg_current_release "$ACTIVE_SRC")"
    if [[ "$ROLLBACK_N" == 1 ]]; then
      storage_rollback_target="${ACTIVE_STATE_PREVIOUS_RELEASE:-$ACTIVE_STATE_RELEASE}"
    else
      storage_history_row="$(hotcfg_rmt oc_hotcfg_history_nth_committed "$OC_HOTCFG_HISTORY" "$((ROLLBACK_N + 1))")"
      storage_rollback_target="$(jq -r '.masterRelease // ""' <<<"$storage_history_row")"
    fi
    [[ -n "$storage_rollback_target" ]] || {
      echo "✗ tuple rollback 无法预解析 browser storage 目标，拒绝写 maintenance marker。" >&2
      exit 1
    }
    assert_web_storage_rollback_transition \
      "$ACTIVE_STATE_RELEASE" "${ACTIVE_STATE_PREVIOUS_RELEASE:-}" "$storage_rollback_target" \
      "tuple rollback preflight" || exit 1
    begin_planned_maintenance rollback 0
    if ! assert_mutation_lease_alive "rollback-tuple-flip"; then
      echo "✗ production-mutation lease 失活;跳过 maintenance cleanup，crash-stop(live 未改)" >&2
      exit 86
    fi
    rollback_runtime_tuple "$ROLLBACK_N" 1 "$kp_rollback_helper" \
      || { echo "✗ tuple 回滚失败(saga 已自动恢复现场)" >&2; exit 1; }
    kp_rollback_target="$(bg_current_release "$ACTIVE_SRC")"
    if [[ -z "$kp_rollback_target" ]] || ! smoke "$ACTIVE_PORT"; then
      # F7:反向补偿(恢复回滚前 tuple)前 复核 lease;失活则 crash-stop。
      require_mutation_lease_for_compensation "rollback-compensation" || exit 86
      if rollback_runtime_tuple 1 1 "$kp_rollback_helper" && smoke "$ACTIVE_PORT"; then
        # 2026-07-17 纠偏:插件门恢复 best-effort(release 身份 → current 兜底),
        # 门恢复失败不推翻已成功的 source 反向补偿。
        knowledge_planet_plugin_open_gate_to_release "$kp_rollback_helper" "$kp_rollback_helper" \
          || knowledge_planet_plugin_open_gate_current "$kp_rollback_helper" \
          || mark_deploy_recovery_required "tuple rollback reverse compensation succeeded but Plugin gate restore failed"
      else
        mark_deploy_recovery_required "tuple rollback full smoke failed and reverse compensation failed"
        exit 1
      fi
      end_planned_maintenance || true
      echo "✗ tuple rollback target full smoke 失败；已恢复原 source/账号版本" >&2
      exit 1
    fi
    if ! knowledge_planet_plugin_open_gate_to_release "$kp_rollback_helper" "$kp_rollback_target"; then
      # 2026-07-17 纠偏:回滚本体已成功,插件门开启失败不再反向推翻整个回滚
      # (昨日实测该反向补偿链条二次失败直接打进 manual-recovery)。兜底重开
      # 当前已审批版本;兜底也失败才标记人工恢复,回滚仍算成功。
      echo "⚠ Knowledge Planet release 身份门开启失败(目标可能早于插件审批),走 current-version 兜底,不推翻回滚" >&2
      require_mutation_lease_for_compensation "tuple-rollback-gate-recovery" || exit 86
      knowledge_planet_plugin_open_gate_current "$kp_rollback_helper" \
        || mark_deploy_recovery_required "tuple rollback succeeded but Plugin gate could not be reopened (current-version fallback also failed)"
    fi
    end_planned_maintenance
    echo "✓ rollback(tuple 感知,master+tuple 同条 history)完成。"
    smoke_turn_canary_advisory "$kp_rollback_target"   # C5:非阻断,失败不翻回
    return 0
  fi
  # 非 hotcfg:N=1 → deploy_state.previous_active_release(state 权威;蓝绿 slot-aware);
  #            .prev-release 文件仅作 A-slot 传统 lane 兼容兜底(state 未 seed 时)。N>1 → 按 mtime 第 N 个更老 release。
  local target live_master image_id runtime_release
  if [[ "$ROLLBACK_N" == 1 ]]; then
    if [[ "$DRY" == 1 ]]; then
      target="${DRY_DS_PREV_RELEASE:-$RELEASES_ROOT/rel-prev-dry}"
      echo "  · 回滚目标(dry;权威=deploy_state.previous_active_release)= $target"
    else
      target="$ACTIVE_STATE_PREVIOUS_RELEASE"
      if [[ -n "$target" ]]; then
        echo "  · 回滚目标(权威=deploy_state.previous_active_release,slot=$ACTIVE_SLOT)= $target"
      else
        # state 未 seed / previous 为空 → A-slot .prev-release 兼容兜底(B slot 无兜底:必须靠 state 权威)。
        if [[ "$ACTIVE_SLOT" == A ]]; then
          target="$(ssh "$KL_HOST" "cat '$RELEASES_ROOT/.prev-release' 2>/dev/null || true")"
          echo "  · deploy_state.previous_active_release 空 → A-slot .prev-release 兜底= ${target:-<无>}"
        else
          echo "✗ active slot=B 但 deploy_state.previous_active_release 为空,无回滚权威目标(B slot 无 .prev-release 兜底)。" >&2
          echo "  核查 deploy_state 或用 --rollback=N(N>1)按 mtime 选更老 release。" >&2
          exit 1
        fi
      fi
    fi
  else
    target="$(ssh "$KL_HOST" "ls -1dt '$RELEASES_ROOT'/rel-* 2>/dev/null | sed -n '$((ROLLBACK_N+1))p'")"
  fi
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] rollback(slot=$ACTIVE_SLOT)→ ${target:-<第$ROLLBACK_N个更老release>}"
    begin_planned_maintenance rollback 0
    activate_release "${target:-<dry>}"
    end_planned_maintenance
    return 0
  fi
  [[ -n "$target" ]] || { echo "✗ 找不到回滚目标(N=$ROLLBACK_N;previous_active_release/.prev-release 或第 N 个更老 release 不存在)" >&2; exit 1; }
  ssh "$KL_HOST" "test -d '$target'" || { echo "✗ 回滚目标目录不存在: $target" >&2; exit 1; }
  # This guard is deliberately independent of the finalized-tape DB query in
  # activate_release. If the live v2 master can still finish a concurrent turn,
  # a query returning false is stale before the later symlink switch.
  live_master="$(bg_current_release "$ACTIVE_SRC")"
  [[ -n "$live_master" ]] || { echo "✗ 显式回滚前无法解析当前 live master" >&2; exit 1; }
  assert_release_marker "$live_master" || exit 1
  assert_release_marker "$target" || exit 1
  image_id="$(remote_env_get OC_RUNTIME_IMAGE_ID)"
  runtime_release="$(remote_env_get OC_RUNTIME_RELEASE)"
  assert_lossless_explicit_rollback_target \
    "$live_master" "$target" "$image_id" "$runtime_release" || exit 1
  assert_web_storage_rollback_transition \
    "$live_master" "${ACTIVE_STATE_PREVIOUS_RELEASE:-}" "$target" "explicit rollback" || exit 1
  begin_planned_maintenance rollback 0
  if ! assert_mutation_lease_alive "rollback-flip"; then
    echo "✗ production-mutation lease 失活;跳过 maintenance cleanup，crash-stop(live 未改)" >&2
    exit 86
  fi
  # 2026-07-17 架构纠偏:插件括号 best-effort——回滚是紧急通道,插件侧失败只降级
  # (零接触/兜底重开当前已审批版本),永不阻断回滚本体。
  echo "── Knowledge Planet Plugin:回滚前关闭执行门并反向迁移账号/install(best-effort)──"
  local kp_rb_bracket=1
  if ! knowledge_planet_plugin_close_gate "$live_master"; then
    echo "⚠ Knowledge Planet 执行门关闭失败:插件零接触继续回滚(门保持现状,版本 pin 不迁移)" >&2
    kp_rb_bracket=0
  fi
  if [[ "$kp_rb_bracket" == 1 ]] && ! knowledge_planet_plugin_transition_to_release "$live_master" "$target"; then
    echo "⚠ Knowledge Planet 版本反向迁移失败(目标 release 可能早于插件审批):跳过迁移,兜底重开当前已审批版本后继续回滚" >&2
    require_mutation_lease_for_compensation "rollback-plugin-transition-recovery" || exit 86
    knowledge_planet_plugin_open_gate_current "$live_master" \
      || mark_deploy_recovery_required "rollback Plugin transition failed and current-version gate restore also failed"
    kp_rb_bracket=0
  fi
  # activate_release 内 ds_commit_active_release 会把 previous_active_release←旧 active(=回滚前的 release)、
  # active_release←target 原子对调(BLOCKER 4:rollback 成功后 CAS 更新 active_release+previous 对调)。
  if ! activate_release "$target"; then
    # activate_release 已把 source 补偿回 live_master。插件补偿 best-effort:
    # 迁移过才迁回;兜底 current;只有兜底也失败才标记人工恢复。
    # F7:补偿前 复核 lease(非 hotcfg rollback 补偿入口,与其它补偿同类)。
    require_mutation_lease_for_compensation "rollback-compensation" || exit 86
    if [[ "$kp_rb_bracket" == 1 ]]; then
      knowledge_planet_plugin_transition_to_release "$live_master" "$live_master" \
        && knowledge_planet_plugin_open_gate_to_release "$live_master" "$live_master" \
        || knowledge_planet_plugin_open_gate_current "$live_master" \
        || mark_deploy_recovery_required "rollback source compensation succeeded but Knowledge Planet DB compensation failed"
    fi
    end_planned_maintenance || true
    exit 1
  fi
  if ! smoke "$ACTIVE_PORT"; then
    knowledge_planet_compensate_deploy "$live_master" "$live_master" 0 0 "" "$kp_rb_bracket" \
      || { mark_deploy_recovery_required "rollback target smoke failed and source/Plugin compensation failed"; exit 1; }
    end_planned_maintenance || true
    echo "✗ rollback target full smoke 失败；已恢复原 source/账号版本" >&2
    exit 1
  fi
  if [[ "$kp_rb_bracket" == 1 ]] && ! knowledge_planet_plugin_open_gate_to_release "$live_master" "$target"; then
    # 2026-07-17 纠偏:回滚本体已成功,门开启失败不再反向推翻;兜底 current,
    # 兜底也失败才标记人工恢复,回滚仍算成功。
    echo "⚠ Knowledge Planet release 身份门开启失败(目标可能早于插件审批),走 current-version 兜底,不推翻回滚" >&2
    require_mutation_lease_for_compensation "rollback-gate-recovery" || exit 86
    knowledge_planet_plugin_open_gate_current "$live_master" \
      || mark_deploy_recovery_required "rollback succeeded but Plugin gate could not be reopened (current-version fallback also failed)"
  fi
  end_planned_maintenance
  echo "✓ rollback 完成 → $target(slot=$ACTIVE_SLOT)。"
  smoke_turn_canary_advisory "$target"   # C5:非阻断,失败不翻回
}

# tuple 感知回滚：history v3 用 transitionKind+previousMasterRelease 区分 joint/master-only/
# tuple-only。tuple-only 只恢复上一 tuple，master/state 不动；master-only 用 state.previous+
# current tuple 对称反向；joint 恢复上一条同源 master+tuple。P3 finalize 未写 history 时由
# history.last.master!=active 识别为未记账 master-only。N>1 仅允许纯 joint 起点。
rollback_runtime_tuple() {
  local n="$1" defer_plugin_open="${2:-0}" helper_override="${3:-}"
  local plugin_previous_exists="${4:-1}"
  [[ "$plugin_previous_exists" =~ ^[01]$ ]] || {
    echo "✗ tuple rollback previous-plugin flag 非法:$plugin_previous_exists" >&2
    return 2
  }
  local nth prev last last_master last_kind last_previous last_schema image image_id release bundle master source_desc transition_kind state_commit=1
  nth=$((n+1))
  local flip_rev prev_src plugin_helper old_prev="" restart_cmd smoke_cmd extra_apply extra_revert prev_apply="" prev_revert=""
  prev_src="$(bg_current_release "$ACTIVE_SRC")"   # 当前 active slot master 源码
  plugin_helper="${helper_override:-$prev_src}"
  [[ -n "$prev_src" ]] || { echo "✗ tuple 回滚前无法解析 slot=$ACTIVE_SLOT 当前 release" >&2; return 1; }
  assert_release_marker "$prev_src" || {
    echo "✗ tuple 回滚前当前 master marker 无效:$prev_src" >&2; return 1;
  }
  [[ "$prev_src" == "$ACTIVE_STATE_RELEASE" ]] || {
    echo "✗ deploy_state.active_release=$ACTIVE_STATE_RELEASE 与 slot=$ACTIVE_SLOT symlink=$prev_src 不一致，拒绝回滚。" >&2
    return 1
  }
  last="$(hotcfg_rmt oc_hotcfg_history_last_committed "$OC_HOTCFG_HISTORY")"
  [[ -n "$last" ]] || { echo "✗ hotcfg history 无 committed tuple，无法安全回滚" >&2; return 1; }
  last_master="$(jq -r '.masterRelease // ""' <<<"$last")"
  last_kind="$(jq -r '.transitionKind // "joint"' <<<"$last")"
  last_previous="$(jq -r '.previousMasterRelease // ""' <<<"$last")"
  last_schema="$(jq -r '.schemaVer // 0' <<<"$last")"
  if [[ "$n" == 1 ]]; then
    if [[ "$last_master" != "$ACTIVE_STATE_RELEASE" ]]; then
      # P3 finalize 不写 tuple history：history 落后于 live master 即为未记账的 master-only 转换。
      master="$ACTIVE_STATE_PREVIOUS_RELEASE"
      [[ -n "$master" ]] || { echo "✗ P3 master-only 回滚缺 state.previous 权威目标" >&2; return 1; }
      prev="$(hotcfg_rmt oc_hotcfg_env_tuple_json "$V5_ENV" "$master")"
      [[ -n "$prev" ]] || { echo "✗ 无法读取当前 live tuple，拒绝 P3 master-only 回滚" >&2; return 1; }
      transition_kind="master-only"
      source_desc="unrecorded P3 master-only(state.previous + current tuple)"
    elif [[ "$last_kind" == tuple-only ]]; then
      # emergency 等只改 tuple 的事件：回到上一条 tuple，但 master/state 血缘完全不动。
      prev="$(hotcfg_rmt oc_hotcfg_history_nth_committed "$OC_HOTCFG_HISTORY" 2)"
      [[ -n "$prev" ]] || { echo "✗ tuple-only history 缺上一条 tuple 可恢复" >&2; return 1; }
      master="$ACTIVE_STATE_RELEASE"
      state_commit=0
      transition_kind="tuple-only"
      source_desc="tuple-only history previous(master/state 不动)"
    elif [[ "$last_kind" == master-only ]]; then
      master="$ACTIVE_STATE_PREVIOUS_RELEASE"
      [[ -n "$master" && "$last_previous" == "$master" ]] || {
        echo "✗ master-only history 父 master 与 state.previous 不一致(history=$last_previous state=${master:-<empty>})" >&2
        return 1
      }
      prev="$(hotcfg_rmt oc_hotcfg_env_tuple_json "$V5_ENV" "$master")"
      [[ -n "$prev" ]] || { echo "✗ 无法读取当前 live tuple，拒绝 master-only 反向" >&2; return 1; }
      transition_kind="master-only"
      source_desc="recorded master-only(parent=$master,current tuple)"
    elif [[ "$last_kind" == joint ]]; then
      master="$ACTIVE_STATE_PREVIOUS_RELEASE"
      [[ -n "$master" ]] || { echo "✗ joint 回滚缺 state.previous 权威目标" >&2; return 1; }
      prev="$(hotcfg_rmt oc_hotcfg_history_nth_committed "$OC_HOTCFG_HISTORY" 2)"
      [[ -n "$prev" ]] || { echo "✗ joint history 缺上一条 committed tuple" >&2; return 1; }
      if [[ "$last_schema" -ge 3 ]]; then
        # v3 的 parent 是当前 joint 事件真正的前一 master。中间若有未记账 P3 finalize，
        # 倒数第二条仍携带正确旧 tuple、但其 master 会更老；此时以 parent/state.previous
        # 作为 master 目标并保留该 tuple，而不是因 history 中没有 P3 节点而拒绝。
        [[ -n "$last_previous" && "$last_previous" == "$master" ]] || {
          echo "✗ joint history 父 master 与 state.previous 不一致(history=${last_previous:-<empty>} state=$master)" >&2
          return 1
        }
        transition_kind="joint"
        if [[ "$(jq -r '.masterRelease // ""' <<<"$prev")" == "$master" ]]; then
          source_desc="joint history previous(同条 master+tuple)"
        else
          source_desc="joint previous tuple + parent master(跨未记账 P3 master-only)"
        fi
      elif [[ "$(jq -r '.masterRelease // ""' <<<"$prev")" != "$master" ]]; then
        # v2 没有 transitionKind/parent；同 master 的旧 emergency 条目按 tuple-only 兼容恢复。
        if [[ "$(jq -r '.masterRelease // ""' <<<"$prev")" == "$ACTIVE_STATE_RELEASE" ]]; then
          master="$ACTIVE_STATE_RELEASE"; state_commit=0; transition_kind="tuple-only"
          source_desc="legacy-v2 inferred tuple-only"
        else
          echo "✗ joint history 上一 master 与 state.previous 不一致(history=$(jq -r '.masterRelease // ""' <<<"$prev") state=$master)" >&2
          return 1
        fi
      else
        transition_kind="joint"
        source_desc="joint history previous(同条 master+tuple)"
      fi
    else
      echo "✗ last transitionKind=$last_kind 不可作为 rollback 起点" >&2
      return 1
    fi
  else
    [[ "$last_schema" -ge 3 && "$last_master" == "$ACTIVE_STATE_RELEASE" && "$last_kind" == joint ]] || {
      echo "✗ N=$n 相对 history 回滚仅接受 v3 连续 joint 血缘：last(schema=$last_schema kind=$last_kind master=$last_master) active=$ACTIVE_STATE_RELEASE。请逐次 --rollback=1。" >&2
      return 1
    }
    # 逐边验证 result.previousMasterRelease == 下一条 result.masterRelease；任一 P3
    # 未记账 gap / tuple-only / master-only 都不能安全跨越，要求操作者逐次 N=1 收敛。
    local edge=1 edge_cur edge_next edge_parent edge_next_master
    while [[ "$edge" -le "$n" ]]; do
      edge_cur="$(hotcfg_rmt oc_hotcfg_history_nth_committed "$OC_HOTCFG_HISTORY" "$edge")"
      edge_next="$(hotcfg_rmt oc_hotcfg_history_nth_committed "$OC_HOTCFG_HISTORY" "$((edge+1))")"
      [[ -n "$edge_cur" && -n "$edge_next" ]] || {
        echo "✗ history 无倒数第 $((edge+1)) 条 committed tuple 可回滚(N=$n)" >&2; return 1; }
      [[ "$(jq -r '.schemaVer // 0' <<<"$edge_cur")" -ge 3 && "$(jq -r '.transitionKind // ""' <<<"$edge_cur")" == joint ]] || {
        echo "✗ N=$n 第 $edge 条边不是 v3 joint，拒绝跨轴/旧格式多步回滚" >&2; return 1; }
      edge_parent="$(jq -r '.previousMasterRelease // ""' <<<"$edge_cur")"
      edge_next_master="$(jq -r '.masterRelease // ""' <<<"$edge_next")"
      [[ -n "$edge_parent" && "$edge_parent" == "$edge_next_master" ]] || {
        echo "✗ N=$n 第 $edge 条 history 父链断裂(parent=${edge_parent:-<empty>} next=$edge_next_master)，请逐次 --rollback=1" >&2
        return 1
      }
      if [[ "$edge" == 1 && "$edge_parent" != "$ACTIVE_STATE_PREVIOUS_RELEASE" ]]; then
        echo "✗ N=$n 首边 parent=$edge_parent 与 state.previous=$ACTIVE_STATE_PREVIOUS_RELEASE 不一致" >&2
        return 1
      fi
      edge=$((edge+1))
    done
    prev="$edge_next"
    master="$(jq -r '.masterRelease // ""' <<<"$prev")"
    transition_kind="joint"
    source_desc="history nth=$nth"
  fi
  image="$(jq -r '.image' <<<"$prev")"; image_id="$(jq -r '.image_id' <<<"$prev")"
  release="$(jq -r '.release' <<<"$prev")"; bundle="$(jq -r '.bundle' <<<"$prev")"
  [[ -n "$master" ]] || master="$(jq -r '.masterRelease // ""' <<<"$prev")"
  [[ -n "$master" ]] || { echo "✗ 目标 history 记录缺 masterRelease 字段,无法对齐回滚 master 源码(旧格式 history?)" >&2; return 1; }
  ssh "$KL_HOST" "test -d '$master'" || { echo "✗ 目标 master release 目录不存在(可能已被 GC): $master" >&2; return 1; }
  assert_release_marker "$master" || return 1
  assert_release_required_migrations "$master" || return 1
  assert_release_baseline_security "$master" || return 1
  assert_web_storage_rollback_transition \
    "$prev_src" "${ACTIVE_STATE_PREVIOUS_RELEASE:-}" "$master" \
    "tuple rollback exact target" || return 1
  # Current-capable/unknown → target reader+actual writer are proved without a
  # DB observation, before any history/state/env/symlink mutation. This closes
  # "floor query=false → concurrent first finalize → rollback".
  assert_lossless_explicit_rollback_target \
    "$prev_src" "$master" "$image_id" "$release" || return 1
  # 回滚同样过两个 capability 门(地板的核心场景就是"拒绝把旧版本翻回来")。
  # 容器 tuple(image/release)面在 saga 内由 lib 的 assert_tuple_viable ③ 覆盖。
  assert_release_capability_for_sessions_pg "$master"
  assert_lossless_turn_tape_floor "$master"
  assert_lossless_runtime_tuple_floor "$image_id" "$release"
  assert_model_authority_floor "$master"
  # R2-B1:是否翻 current 由**目标记录的 bundle 值**决定(逐字面恢复:目标空=当时该轴禁用 → 不翻;
  # 目标非空=当时启用 → 必翻回,即使当前 env 已被 --disable 清空)。不再看当前 enabled 态。
  flip_rev=""
  if [[ -n "$bundle" && "$bundle" == "$OC_HOTCFG_PLATFORM_ROOT"/bundles/* ]]; then
    flip_rev="${bundle##*/}"
  fi
  # M7c:只有 master 变更才维护 .prev-release；tuple-only 不碰 master 血缘。
  if [[ "$state_commit" == 1 && "$ACTIVE_SLOT" == A ]]; then
    old_prev="$(ssh "$KL_HOST" "cat '$RELEASES_ROOT/.prev-release' 2>/dev/null || true")"
    prev_apply="printf '%s\\n' '$prev_src' > '$RELEASES_ROOT/.prev-release.tmp' && mv -f '$RELEASES_ROOT/.prev-release.tmp' '$RELEASES_ROOT/.prev-release';"
    if [[ -n "$old_prev" ]]; then
      prev_revert="printf '%s\\n' '$old_prev' > '$RELEASES_ROOT/.prev-release.tmp' && mv -f '$RELEASES_ROOT/.prev-release.tmp' '$RELEASES_ROOT/.prev-release';"
    else
      prev_revert="rm -f '$RELEASES_ROOT/.prev-release';"
    fi
  fi
  restart_cmd="systemctl restart '$ACTIVE_UNIT'"
  smoke_cmd="$(hotcfg_core_smoke_cmd)"
  if [[ "$state_commit" == 1 ]]; then
    extra_apply="$prev_apply rm -f '$ACTIVE_SRC.hotlink'; ln -s '$master' '$ACTIVE_SRC.hotlink'; mv -T '$ACTIVE_SRC.hotlink' '$ACTIVE_SRC'"
    extra_revert="$prev_revert rm -f '$ACTIVE_SRC.hotlink'; ln -s '$prev_src' '$ACTIVE_SRC.hotlink'; mv -T '$ACTIVE_SRC.hotlink' '$ACTIVE_SRC'"
  else
    extra_apply=""; extra_revert=""
  fi
  sync_assets_to_pool "$master" || return 1
  HOTCFG_STATE_COMMIT_CMD=""; HOTCFG_STATE_REVERT_CMD=""
  [[ "$state_commit" == 1 ]] && build_hotcfg_state_hooks "$master"
  echo "  回滚计划($source_desc): image_id=$image_id release=${release:-<none>} bundle=${flip_rev:-<none>} master源码=$master"
  # 2026-07-17 架构纠偏:插件括号 best-effort 化——回滚是平台紧急通道,任何
  # 插件侧失败都不得阻断(运行时按内容 pin fail-closed,插件门状态不影响平台
  # 完整性;最坏情形=插件休眠,用 open_gate_current 兜底恢复已审批版本)。
  echo "── Knowledge Planet Plugin:tuple 回滚前关闭执行门并反向迁移账号/install(best-effort)──"
  local kp_plugin_bracket=1
  if ! knowledge_planet_plugin_close_gate "$plugin_helper"; then
    echo "⚠ Knowledge Planet 执行门关闭失败:插件零接触继续回滚(门保持现状,版本 pin 不迁移)" >&2
    kp_plugin_bracket=0
  fi
  if [[ "$kp_plugin_bracket" == 1 && "$plugin_previous_exists" == 1 ]]; then
    if ! knowledge_planet_plugin_transition_to_release "$plugin_helper" "$master"; then
      echo "⚠ Knowledge Planet 版本反向迁移失败(目标 release 可能早于插件审批):跳过迁移,兜底重开当前已审批版本后继续回滚" >&2
      require_mutation_lease_for_compensation "tuple-rollback-plugin-transition-recovery" || exit 86
      knowledge_planet_plugin_open_gate_current "$plugin_helper" \
        || mark_deploy_recovery_required "tuple rollback Plugin transition failed and current-version gate restore also failed"
      kp_plugin_bracket=0
    fi
  fi
  if ! prepare_direct_turn_timeline_activation "$master" "$prev_src"; then
    if [[ "$kp_plugin_bracket" == 1 && "$plugin_previous_exists" == 1 ]]; then
      require_mutation_lease_for_compensation "tuple-rollback-timeline-compensation" || exit 86
      knowledge_planet_plugin_transition_to_release "$plugin_helper" "$prev_src" \
        && knowledge_planet_plugin_open_gate_to_release "$plugin_helper" "$prev_src" \
        || knowledge_planet_plugin_open_gate_current "$plugin_helper" \
        || mark_deploy_recovery_required "master capability floor rejected tuple rollback and Plugin DB compensation failed"
    fi
    return 1
  fi
  # 新 committed 条目 masterRelease=$master(=回滚到的 master),last committed 恒=live。
  # 末参 prev_master(R2-B2)仅供首启 pre-state;回滚时 history 必已有 committed 条目,不会触发。
  if ! hotcfg_rmt oc_hotcfg_activate_saga \
    "$V5_ENV" "$OC_HOTCFG_PLATFORM_ROOT" "$flip_rev" "$OC_HOTCFG_HISTORY" \
    "$image" "$image_id" "$release" "$bundle" \
    "$restart_cmd" "$smoke_cmd" "$extra_apply" "$extra_revert" "$master" "$prev_src" \
      "$HOTCFG_STATE_COMMIT_CMD" "$HOTCFG_STATE_REVERT_CMD" "$DEPLOY_RECOVERY_MARKER" "$transition_kind"; then
    require_mutation_lease_for_compensation "tuple-rollback-saga-compensation" || exit 86
    if [[ "$kp_plugin_bracket" == 1 && "$plugin_previous_exists" == 1 ]]; then
      knowledge_planet_plugin_transition_to_release "$plugin_helper" "$prev_src" \
        && knowledge_planet_plugin_open_gate_to_release "$plugin_helper" "$prev_src" \
        || {
          # 2026-07-17 实测:release 身份的 open 在此处失败曾直接打 manual-recovery。
          # 兜底恢复当前已审批版本;兜底也失败才升级为人工恢复态。
          echo "⚠ Knowledge Planet release 身份门恢复失败,走 current-version 兜底" >&2
          knowledge_planet_plugin_open_gate_current "$plugin_helper" \
            || mark_deploy_recovery_required "tuple rollback saga compensated source but Plugin DB compensation failed"
        }
    elif [[ "$kp_plugin_bracket" == 1 ]]; then
      knowledge_planet_plugin_close_gate "$plugin_helper" \
        || mark_deploy_recovery_required "tuple rollback saga failed and first-publication Plugin gate state is unknown"
    fi
    return 1
  fi
  if [[ "$defer_plugin_open" != 1 && "$kp_plugin_bracket" == 1 && "$plugin_previous_exists" == 1 ]]; then
    knowledge_planet_plugin_open_gate_to_release "$plugin_helper" "$master" \
      || {
        echo "⚠ Knowledge Planet release 身份门开启失败(目标可能早于插件审批),走 current-version 兜底,不阻断回滚" >&2
        require_mutation_lease_for_compensation "tuple-rollback-target-gate-recovery" || exit 86
        knowledge_planet_plugin_open_gate_current "$plugin_helper" \
          || mark_deploy_recovery_required "tuple rollback target active but Plugin gate failed to open (current-version fallback also failed)"
      }
  fi
  if [[ "$state_commit" == 1 ]]; then
    ACTIVE_STATE_PREVIOUS_RELEASE="$ACTIVE_STATE_RELEASE"
    ACTIVE_STATE_RELEASE="$master"
    ACTIVE_STATE_LOCK_VERSION=$((ACTIVE_STATE_LOCK_VERSION + 1))
  fi
}

# ═══════════════════════ P3 双 master cohort lane(RFC-v5-dual-master-cohort §D5/§8)═══════════════════════
# 全部经 deploy_state CAS(UPDATE ... WHERE lock_version=$n RETURNING)+ journal;每个外部效果完成即
# CAS transition_step 推进;崩溃重跑按 (phase, transition_step) 走 §8 恢复矩阵(recover 函数)。
# 权威在 PG:CAS 与 Caddy 渲染/unit 起停分离,Caddy 由 v5-caddy-apply.sh 从 deploy_state 派生。

# 本 lane 的 operation_id(每次运行唯一;journal 记账 + 崩溃诊断)
OP=""
new_operation_id() { OP="p3-$1-$(date -u +%Y%m%dT%H%M%SZ)-$$"; echo "  operation_id=$OP"; }

# 读 deploy_state → DS_* 全局(dry-run:占位,phase/candidate 由调用方经 DRY_DS_* 预设)。
DRY_DS_PHASE="${DRY_DS_PHASE:-stable}"; DRY_DS_CANDIDATE="${DRY_DS_CANDIDATE:-}"
DRY_DS_STEP="${DRY_DS_STEP:-0}"; DRY_DS_PCT="${DRY_DS_PCT:-0}"
ds_snapshot() {
  if [[ "$DRY" == 1 ]]; then
    DS_generation=42; DS_phase="$DRY_DS_PHASE"; DS_active_slot=A; DS_candidate_slot="$DRY_DS_CANDIDATE"
    DS_active_release="$RELEASES_ROOT/rel-active-dry"; DS_candidate_release="$RELEASES_ROOT/rel-cand-dry"
    DS_desired_leader_slot=A; DS_desired_control_slot=A; DS_cohort_percent="$DRY_DS_PCT"
    DS_cohort_salt="drysalt"; DS_transition_step="$DRY_DS_STEP"; DS_operation_id="$OP"; DS_lock_version=7
    echo "  [dry-run] ds_snapshot: gen=$DS_generation phase=$DS_phase active=$DS_active_slot candidate=${DS_candidate_slot:-<none>} step=$DS_transition_step pct=$DS_cohort_percent lv=$DS_lock_version"
    return 0
  fi
  ds_load || { echo "✗ 读取 deploy_state 失败(未 seed / PG 不可达)。基建版须先 apply 0135 迁移建表并 seed。" >&2; exit 1; }
  echo "  · deploy_state: gen=$DS_generation phase=$DS_phase step=$DS_transition_step active=$DS_active_slot candidate=${DS_candidate_slot:-<none>} pct=$DS_cohort_percent desired(leader=$DS_desired_leader_slot control=$DS_desired_control_slot) lv=$DS_lock_version op=${DS_operation_id:-<none>}"
}

# CAS 一步 + journal(dry-aware)。$1=set_clause $2=step(journal;空=不记) $3=action
ds_cas_or_die() {
  local set_clause="$1" step="${2:-}" action="${3:-}"
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] CAS(WHERE lock_version=$DS_lock_version): SET $set_clause"
    [[ -n "$step" ]] && echo "  [dry-run] journal: op=$OP step=$step action='$action'"
    DS_lock_version=$((DS_lock_version+1))
    return 0
  fi
  local newlv
  # MAJOR 1:CAS + journal 同一事务(ds_cas 给了 op/step/action 时走原子 CTE);无 step 则纯 CAS。
  if [[ -n "$step" ]]; then
    newlv="$(ds_cas "$DS_lock_version" "$set_clause" "$OP" "$step" "$action")" || { echo "✗ CAS 执行失败(psql 错误)" >&2; exit 1; }
  else
    newlv="$(ds_cas "$DS_lock_version" "$set_clause")" || { echo "✗ CAS 执行失败(psql 错误)" >&2; exit 1; }
  fi
  if [[ -z "$newlv" ]]; then
    echo "✗ CAS 落空:lock_version=$DS_lock_version 已被并发/崩溃重跑推进。" >&2
    echo "  勿盲目重跑本 lane;用 deploy-v5.sh --recover 从 (phase, transition_step) 按 §8 续作。" >&2
    exit 1
  fi
  DS_lock_version="$newlv"
  ds_load   # 重载最新行(拿到刚写入字段:operation_id/candidate_slot 等)
}

# 断言当前 phase ∈ 允许集(dry-run:仅提示)。$@=允许的 phase 列表
ds_assert_phase() {
  if [[ "$DRY" == 1 ]]; then echo "  [dry-run] 断言 phase ∈ [$*](当前 dry 占位=$DS_phase)"; return 0; fi
  local p; for p in "$@"; do [[ "$DS_phase" == "$p" ]] && return 0; done
  echo "✗ 当前 phase=$DS_phase,本操作要求 phase ∈ [$*]。" >&2; exit 1
}

# 私有诊断控制口 healthz(RFC D3;$1=slot)。dry:合成健康体。
slot_priv_healthz() {
  local slot="$1" request_timeout="${2:-5}" priv; priv="$(slot_priv "$slot")"
  if [[ "$DRY" == 1 ]]; then echo '{"ok":true,"channel":"v5","leadership":{"state":"standby","slot":"'"$slot"'"},"vip":"released"}'; return 0; fi
  # 远端 curl 的 max-time 不覆盖 SSH 建连/握手；本地 timeout(KILL)钉死整个 transport 墙钟。
  timeout --signal=KILL "${request_timeout}s" \
    ssh "$KL_HOST" "curl -fsS --max-time '$request_timeout' http://127.0.0.1:${priv}/healthz" 2>/dev/null || true
}

# BLOCKER 5⑤:有界轮询等待某 slot 私有口 healthz 到达 leadership=leader(want_vip=1 时并要求 vip=owner)。
# 取代固定 sleep 8/6。$1=slot $2=want_vip(0|1) $3=timeout秒(默认60)。2s 间隔;达成 return 0,超时 return 1。
wait_for_slot_leadership() {
  local slot="$1" want_vip="${2:-0}" timeout="${3:-60}" waited=0 hz
  echo "── 有界轮询等待 slot=$slot leadership=leader$([[ "$want_vip" == 1 ]] && echo '+vip=owner')(≤${timeout}s,2s 间隔)──"
  if [[ "$DRY" == 1 ]]; then echo "  [dry-run] 轮询等待(跳过)"; return 0; fi
  while [[ "$waited" -lt "$timeout" ]]; do
    hz="$(slot_priv_healthz "$slot")"
    if echo "$hz" | grep -q '"state":"leader"'; then
      if [[ "$want_vip" != 1 ]] || echo "$hz" | grep -q '"vip":"owner"'; then
        echo "  ✓ slot=$slot 已 leader$([[ "$want_vip" == 1 ]] && echo '+VIP owner')(等待 ${waited}s)"
        return 0
      fi
    fi
    sleep 2; waited=$((waited+2))
  done
  echo "  ⚠ 等待 ${timeout}s 仍未达成 leadership=leader$([[ "$want_vip" == 1 ]] && echo '+vip=owner')" >&2
  return 1
}

# candidate 起手自检(RFC D5 canary step3):四项必须同时成立；缺字段/畸形 JSON 一律 fail-closed。
candidate_health_ready() {
  jq -e '.ok == true and .channel == "v5" and .leadership.state == "standby" and .vip == "released"' \
    >/dev/null 2>&1 <<<"$1"
}

# 单次诊断供 --recover 展示；真实 canary 起活使用下面的有界轮询。
candidate_self_check() {
  local slot="$1" hz
  hz="$(slot_priv_healthz "$slot")"
  echo "  private healthz: $hz"
  candidate_health_ready "$hz"
}

# 冷启动时间随宿主/tsx 缓存变化，不能靠固定 sleep。以 SECONDS 绝对截止控制总墙钟，
# 每次 curl 与 sleep 都不超过剩余时间；超时仍处于 canary<READY，对流量不可见。
wait_for_candidate_ready() {
  local slot="$1" timeout="${2:-90}" deadline
  deadline=$((SECONDS + timeout))
  local hz="" remaining request_timeout sleep_for
  echo "── 有界轮询等待 candidate=$slot standby+VIP released(≤${timeout}s,2s 间隔)──"
  if [[ "$DRY" == 1 ]]; then echo "  [dry-run] 轮询等待(跳过)"; return 0; fi
  while (( SECONDS < deadline )); do
    remaining=$((deadline - SECONDS))
    request_timeout="$remaining"; (( request_timeout > 2 )) && request_timeout=2
    (( request_timeout < 1 )) && request_timeout=1
    hz="$(slot_priv_healthz "$slot" "$request_timeout")"
    if candidate_health_ready "$hz"; then
      echo "  ✓ candidate=$slot 已 standby+VIP released"
      echo "  private healthz: $hz"
      return 0
    fi
    (( SECONDS >= deadline )) && break
    remaining=$((deadline - SECONDS))
    sleep_for="$remaining"; (( sleep_for > 2 )) && sleep_for=2
    (( sleep_for > 0 )) && sleep "$sleep_for"
  done
  echo "✗ candidate=$slot 在 ${timeout}s 内未达 standby+VIP released" >&2
  echo "  last private healthz: ${hz:-<empty>}" >&2
  return 1
}

# canary step3 单一收口：候选起活超时必须执行 §8 pre-READY 恢复，而不是只返回错误留脏状态。
start_candidate_unit_and_wait() {
  local cand="$1"
  echo "── 起 candidate unit $(slot_unit "$cand") ──"
  if ! sshk "systemctl enable --now $(slot_unit "$cand")"; then
    echo "✗ candidate unit 启动失败:$(slot_unit "$cand")" >&2
    return 1
  fi
  if wait_for_candidate_ready "$cand" 90; then
    if assert_live_baseline_security_for_slot "$cand"; then return 0; fi
    echo "✗ candidate baseline 生效路径/结构不安全" >&2
  fi
  echo "✗ candidate 自检失败;stop candidate + 回 stable(§8 canary<READY)" >&2
  recover_canary_prep "$cand" || return 1
  return 1
}

# 版本兼容判定(MAJOR 7):candidate 与 active 的某版本字段必须**相等**,或命中显式兼容表
# OC_CAPMATRIX_COMPAT(逗号分隔 "<key>:<activeVer>~<candidateVer>",如 "bridgeFrameSchema:1~2")。
# $1=key $2=activeVer $3=candidateVer → 兼容 return 0。
_capmatrix_version_compat() {
  local key="$1" av="$2" cv="$3" entry
  [[ "$av" == "$cv" ]] && return 0
  local IFS=','
  for entry in ${OC_CAPMATRIX_COMPAT:-}; do
    [[ "$entry" == "$key:$av~$cv" ]] && return 0
  done
  return 1
}

# capability matrix preflight(RFC D5 canary step4 / R1 M7):
#  ① candidate release-metadata capabilities 含 sessions-store-pg-v1 + dual-master-v1
#  ② active release 也须含 dual-master-v1(双 master 同容器 bridge 帧兼容前提)
#  ③ 版本兼容(MAJOR 7):bridgeFrameSchema / runtimeApi 在 candidate 与 active 间相等或显式兼容
#     (新 master↔旧容器 bridge 帧 / 新 master↔旧前端 runtime API 的双 master 同容器共存前提)
#  ④ sw.js 门(MAJOR 6):两边都有且字节同,或两边都无;一有一无=拒绝(origin-global SW 不随 cohort 灰度)
capability_matrix_preflight() {
  local active_rel="$1" candidate_rel="$2"
  echo "── capability matrix preflight(capabilities + bridgeFrameSchema/runtimeApi 版本兼容 + sw.js 门)──"
  if [[ "$DRY" == 1 ]]; then echo "  [dry-run] jq 校验 capabilities + 比较 bridgeFrameSchema/runtimeApi(相等或 OC_CAPMATRIX_COMPAT)+ sw.js 两边同有/同无"; return 0; fi
  local cma="$active_rel/deploy/v5/release-metadata.json" cmc="$candidate_rel/deploy/v5/release-metadata.json"
  local req="sessions-store-pg-v1 dual-master-v1" cap miss=""
  for cap in $req; do
    ssh "$KL_HOST" "jq -e --arg c '$cap' '(.capabilities // []) | index(\$c)' '$cmc'" >/dev/null 2>&1 \
      || miss="$miss $cap"
  done
  [[ -z "$miss" ]] || { echo "✗ candidate release 缺 capability:$miss" >&2; return 1; }
  ssh "$KL_HOST" "jq -e '(.capabilities // []) | index(\"dual-master-v1\")' '$cma'" >/dev/null 2>&1 \
    || { echo "✗ active release 未声明 dual-master-v1 —— 双 master 不兼容,拒绝 canary(active 须先经基建版升级)" >&2; return 1; }
  assert_lossless_canary_pair "$active_rel" "$candidate_rel" || return 1
  assert_direct_turn_timeline_pair "$active_rel" "$candidate_rel" "canary" || return 1
  # ③ 版本字段兼容(MAJOR 7):bridgeFrameSchema / runtimeApi
  local key av cv
  for key in bridgeFrameSchema runtimeApi; do
    av="$(ssh "$KL_HOST" "jq -r --arg k '$key' '.[\$k] // \"MISSING\"' '$cma'" 2>/dev/null || echo MISSING)"
    cv="$(ssh "$KL_HOST" "jq -r --arg k '$key' '.[\$k] // \"MISSING\"' '$cmc'" 2>/dev/null || echo MISSING)"
    [[ "$av" != "MISSING" && "$cv" != "MISSING" ]] || {
      echo "✗ release-metadata 缺 $key 版本字段(active=$av candidate=$cv)。双 master 版本兼容矩阵要求显式声明,拒绝。" >&2; return 1; }
    if _capmatrix_version_compat "$key" "$av" "$cv"; then
      echo "  ✓ $key 兼容(active=$av candidate=$cv$([[ "$av" != "$cv" ]] && echo ',经 OC_CAPMATRIX_COMPAT'))"
    else
      echo "✗ $key 不兼容(active=$av candidate=$cv;既不相等也不在 OC_CAPMATRIX_COMPAT 兼容表)。双 master 同容器 bridge 帧/runtime API 不兼容,拒绝 canary。" >&2; return 1
    fi
  done
  # ④ sw.js 门(MAJOR 6):两边同有(字节同)/ 两边同无 = 通过;一有一无 = 拒绝。
  local swa="$active_rel/packages/web-react/dist/sw.js" swb="$candidate_rel/packages/web-react/dist/sw.js"
  local swa_ex swb_ex
  ssh "$KL_HOST" "test -f '$swa'" && swa_ex=1 || swa_ex=0
  ssh "$KL_HOST" "test -f '$swb'" && swb_ex=1 || swb_ex=0
  if [[ "$swa_ex" == 1 && "$swb_ex" == 1 ]]; then
    ssh "$KL_HOST" "cmp -s '$swa' '$swb'" \
      || { echo "✗ active/candidate 的 sw.js 字节不一致 —— SW 是 origin-global release-neutral 资产(RFC §2 R3 M2),SW 变更须走协调全量发布,不随 cohort 灰度。拒绝 canary。" >&2; return 1; }
    echo "  ✓ sw.js 两边都有且字节一致"
  elif [[ "$swa_ex" == 0 && "$swb_ex" == 0 ]]; then
    echo "  ✓ sw.js 两边都无(无 Service Worker,合法)"
  else
    echo "✗ sw.js 一有一无(active 存在=$swa_ex / candidate 存在=$swb_ex)—— 新增/移除 SW = origin-global 行为变更,必须走协调全量发布而非 cohort 灰度。拒绝 canary。" >&2; return 1
  fi
  echo "  ✓ capability matrix 通过"
  # 只有在**没有**声明兼容表的情况下真跑通过(= 所有版本字段本来就相等)才销账。
  [[ -n "${OC_CAPMATRIX_COMPAT:-}" ]] || clear_gate_waiver capmatrix-compat
}

# 同步某 release 的 dist/assets → 共享 union 池(加法式)+ 14 天 GC(保护双在役+回滚代;RFC §2)。
# 现行 build_and_sync_dist 的加法+14d GC 语义在此对 union 池复用;per-slot 根文件(index/manifest/sw)
# 仍留在各 release 目录,由各 slot master 直服 → active/candidate 用户各拿本 lane 前端。
sync_assets_to_pool() {
  local reldir="$1"
  echo "── 同步 assets → union 池 $V5_ASSETS_POOL/assets(加法,无 --delete)──"
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] mkdir -p $V5_ASSETS_POOL/assets; rsync -a --exclude='*.map'(加法) $reldir/packages/web-react/dist/assets/ → 池"
  else
    # MAJOR 2:去 || true —— assets 未就位 = 前端 chunk 404,rsync 失败即**中止 lane**(fail-loud),
    # 绝不"绿灯放行 chunk 缺失"。(reldir 无 assets 目录=旧 release,内部 if 跳过,非失败。)
    # --exclude='*.map':sourcemap 绝不进公网直服池(2026-07-26 安全整改第三层)。
    # 实测事故:/assets/main-*.js.map 公网 200、901KB、含 72 个源文件完整 sourcesContent。
    # .map 仍留在 release 目录(本机栈帧还原/排障要用),只是不 ship 到 Caddy 直服的池子。
    # 另两层:vite `sourcemap:'hidden'`(不写 sourceMappingURL 指针)、
    # v5-caddy-apply.sh 的 `@sourcemap → 404`(兜住池里的历史残留)。
    if ! ssh "$KL_HOST" "set -e
      mkdir -p '$V5_ASSETS_POOL/assets'
      if [ -d '$reldir/packages/web-react/dist/assets' ]; then
        rsync -a --exclude='*.map' '$reldir/packages/web-react/dist/assets/' '$V5_ASSETS_POOL/assets/'
      fi" 2>&1 | sed 's/^/  /'; then
      echo "✗ assets 同步到 union 池失败(远端 rsync/ssh 错误)—— 前端 chunk 未就位,中止 lane。" >&2
      return 1
    fi
  fi
  gc_assets_pool "$reldir"
}

# BLOCKER 6②:/assets union 池 GC 改**显式保护集**。旧实现"删 mtime>14d"隐性依赖"in-use 资产每次
# rsync 刷新 mtime"——一旦某 release 长期不 redeploy(如稳定 active 数周不动),它引用但未被任何新
# rsync 触碰的 chunk 会 mtime 过期被误删,老浏览器谱系/跨 lane 懒加载 404。改为:遍历 active/candidate/
# 回滚代(.prev-release)+ 本次 reldir 四个 release 的 dist/assets 文件名并集为保护集,只删"不在保护集
# **且** mtime>14d"的文件(保护集内的资产不论多老都不删)。
gc_assets_pool() {
  local reldir="$1"
  echo "── /assets 池 GC(显式保护集=active/candidate/.prev-release/本次 release 的 dist/assets 并集;只删非保护且 >14d)──"
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] 收集四 release 的 dist/assets 文件名并集为保护集;删池内不在保护集且 mtime>14d 的文件"
    return 0
  fi
  # 删除型 GC 对权威读取 fail-closed：PG 错误/零行时安全跳过删除（加法式同步已完成，不影响上线）。
  local rels active_rel candidate_rel previous_rel
  if ! rels="$(ds_exec <<'SQL'
SELECT coalesce(active_release,'') || '|' || coalesce(candidate_release,'') || '|' || coalesce(previous_active_release,'')
  FROM deploy_state WHERE singleton = true;
SQL
)" || [[ -z "$rels" ]]; then
    echo "  ⚠ deploy_state 保护集读取失败/无行 → 本轮安全跳过 /assets 删除型 GC" >&2
    return 0
  fi
  IFS='|' read -r active_rel candidate_rel previous_rel <<<"$rels"
  # MAJOR 2:保护集用**相对路径**(find -printf '%P' 相对 assets 根),支持嵌套子目录 —— 旧实现 ls -1 只取
  # 一级 basename,嵌套 chunk 会漏保护(误删)或跨目录同名误命中。删除侧同样以相对路径比对。去 || true:GC 远端失败即中止 lane。
  if ! ssh "$KL_HOST" "set -e
    POOL='$V5_ASSETS_POOL/assets'
    [ -d \"\$POOL\" ] || exit 0
    prev=\$(cat '$RELEASES_ROOT/.prev-release' 2>/dev/null || true)
    curA=\$(readlink -f '$(slot_src A)' 2>/dev/null || true)
    curB=\$(readlink -f '$(slot_src B)' 2>/dev/null || true)
    protect=\$(mktemp)
    for r in '$(ds_lit "$reldir")' '$(ds_lit "$active_rel")' '$(ds_lit "$candidate_rel")' '$(ds_lit "$previous_rel")' \"\$curA\" \"\$curB\" \"\$prev\"; do
      [ -n \"\$r\" ] || continue
      case \"\$r\" in /*) d=\"\$r\" ;; *) d=\"$RELEASES_ROOT/\$r\" ;; esac
      ad=\"\$d/packages/web-react/dist/assets\"
      if [ -d \"\$ad\" ]; then find \"\$ad\" -type f -printf '%P\n' >> \"\$protect\"; fi
    done
    sort -u \"\$protect\" -o \"\$protect\"
    prot_n=\$(wc -l < \"\$protect\" 2>/dev/null || echo 0)
    echo \"  保护集资产数=\$prot_n(来自 A/B symlink+active/candidate/previous/.prev/本次 release;相对路径)\"
    del=0
    while IFS= read -r rel; do
      [ -n \"\$rel\" ] || continue
      if grep -qxF \"\$rel\" \"\$protect\"; then continue; fi
      rm -f \"\$POOL/\$rel\" && del=\$((del+1))
    done < <(find \"\$POOL\" -type f -mtime +14 -printf '%P\n')
    echo \"  已删非保护且>14d 资产数=\$del\"
    rm -f \"\$protect\"" 2>&1 | sed 's/^/  /'; then
    echo "✗ /assets 池 GC 远端失败(ssh/find 错误)—— 中止 lane。" >&2
    return 1
  fi
}

# 调 v5-caddy-apply.sh 把当前 deploy_state 反映进 Caddy(渲染+validate+reload)。dry:透传 --dry-run。
caddy_render_reload() {
  echo "── re-render Caddy(从 deploy_state)+ reload ──"
  if [[ "$DRY" == 1 ]]; then
    # dry:透传当前 lane 的 DS_* 占位,让 caddy 预览反映 phase/candidate(绝不碰 PG)
    DS_DRY_GEN="$DS_generation" DS_DRY_PHASE="$DS_phase" DS_DRY_STEP="$DS_transition_step" \
    DS_DRY_ACTIVE="$DS_active_slot" DS_DRY_CAND="$DS_candidate_slot" \
    KL_HOST="$KL_HOST" V5_ENV="$V5_ENV" ASSETS_POOL="$V5_ASSETS_POOL" CADDY_HTTP_PORT="$CADDY_HTTP_PORT" \
      bash "$SCRIPT_DIR/v5-caddy-apply.sh" --apply --dry-run
    return 0
  fi
  KL_HOST="$KL_HOST" V5_ENV="$V5_ENV" ASSETS_POOL="$V5_ASSETS_POOL" CADDY_HTTP_PORT="$CADDY_HTTP_PORT" \
    bash "$SCRIPT_DIR/v5-caddy-apply.sh" --apply
}

# 初始化 candidate slot 实例形态(RFC D2):HOME + openclaude.json(端口)+ unit + 源码 symlink→release。
# HOME 存在性守卫:openclaude.json 已存在即保留(它可能是上一轮该 slot 的持久家,含 uploads/诊断)。
init_candidate_slot() {
  local slot="$1" reldir="$2" cport chome cunit csrc
  cport="$(slot_port "$slot")"; chome="$(slot_home "$slot")"; cunit="$(slot_unit "$slot")"; csrc="$(slot_src "$slot")"
  echo "── 初始化 candidate slot $slot(port=$cport HOME=$chome unit=$cunit src=$csrc → $reldir)──"
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] mkdir $chome; 派生 openclaude.json(port=$cport,已存在则保留);装 $cunit;symlink $csrc→$reldir"
    return 0
  fi
  assert_release_marker "$reldir" || return 1
  # openclaude.json:从 A 的派生,仅改 gateway.port;已存在则保留(权威=现网 slot 家)
  ssh "$KL_HOST" "set -e
    mkdir -p '$chome'
    if [ -f '$chome/openclaude.json' ]; then
      echo '  ⚠ $chome/openclaude.json 已存在 → 保留(权威=现网 slot 家)'
    else
      jq '.gateway.port=${cport} | .gateway.bind=\"127.0.0.1\"' '$V5_HOME/openclaude.json' > '$chome/openclaude.json'
    fi"
  # 源码 symlink → release(原子:临时链 + mv -T)
  ssh "$KL_HOST" "set -e
    rm -f '$csrc.newlink.$$'
    ln -s '$reldir' '$csrc.newlink.$$'
    mv -T '$csrc.newlink.$$' '$csrc'"
  # 安装 B slot unit(A 的 unit 已在,幂等 rsync)
  run "rsync -az '$REPO_ROOT/deploy/v5/$cunit' '$KL_HOST:/etc/systemd/system/$cunit'"
  sshk "systemctl daemon-reload"
  echo "  ✓ candidate slot $slot 形态就绪"
}

# ── finalize 四门槛(RFC D3;$1=candidate_slot)──
# ① VIP owner(candidate 私有口自检报告持有 VIP)② control-probe 只读(Agent A 端点;缺则 healthz 代替+TODO)
# ③ egress pendingCostEvents==0(前置已查)④ egress 计数守恒(startId 未变 ∧ pendingEnd=0 ∧ enqueuedΔ==sentΔ ∧ expired/overflowΔ=0)
# 任一超时(60s)→ 补偿:回滚 desired=旧 slot、重启旧 unit、phase=aborting(调用方处理)。
_egress_health() {
  if [[ "$DRY" == 1 ]]; then echo '{"role":"egress","processStartId":"dry-1","pendingCostEvents":0,"enqueuedTotal":100,"sentTotal":100,"expiredDropsTotal":0,"overflowDropsTotal":0}'; return 0; fi
  ssh "$KL_HOST" "curl -fsS --max-time 5 http://172.31.0.1:18892/internal/v5/egress-health" 2>/dev/null || true
}
# BLOCKER 5③:egress 计数字段严格数字校验。非数字(NA / 缺字段 / 脏值)= 拒绝(除非显式豁免),
# 绝不让 "NA" 落进 $((...)) 被当 0 静默算出"守恒"假绿。$1=字段值 $2=字段名。
_egress_num_or_die() {
  local v="$1" name="$2"
  if [[ "$v" =~ ^[0-9]+$ ]]; then return 0; fi
  if [[ "${OC_FINALIZE_SKIP_EGRESS_GATE:-0}" == 1 ]]; then
    echo "  ⚠ egress 计数 $name='$v' 非数字,OC_FINALIZE_SKIP_EGRESS_GATE=1 已放行(危险,登记债)" >&2
    return 0
  fi
  echo "✗ egress 计数 $name='$v' 非数字(NA/缺字段/脏值)。RFC D3 计数守恒门槛拒非数字;设 OC_FINALIZE_SKIP_EGRESS_GATE=1 显式豁免(危险)。" >&2
  return 1
}
EGR_START_STARTID=""; EGR_START_ENQ=""; EGR_START_SENT=""; EGR_START_EXP=""; EGR_START_OVF=""
# finalize 前置:pendingCostEvents==0 + 快照基线计数(RFC D3:有 backlog 先等排空防基线污染)。
egress_gate_prelude() {
  echo "── egress 前置门槛:pendingCostEvents==0 + 计数基线快照 ──"
  local eh; eh="$(_egress_health)"
  echo "  egress-health: $eh"
  if [[ "$DRY" == 1 ]]; then echo "  [dry-run] 断言 pending==0 并快照 startId/enqueued/sent/expired/overflow"; return 0; fi
  [[ -n "$eh" ]] || { echo "✗ egress 无响应,拒绝 finalize" >&2; return 1; }
  local pend; pend="$(jq -r '.pendingCostEvents // "NA"' <<<"$eh")"
  if [[ "$pend" == "NA" ]]; then
    [[ "${OC_FINALIZE_SKIP_EGRESS_GATE:-0}" == 1 ]] || { echo "✗ egress-health 缺 pendingCostEvents 字段(egress 计数面未上线?)。RFC D3 要求计数守恒门槛;设 OC_FINALIZE_SKIP_EGRESS_GATE=1 显式跳过(危险,登记债)后重试。" >&2; return 1; }
    echo "  ⚠ egress 计数字段缺失,OC_FINALIZE_SKIP_EGRESS_GATE=1 已放行(TODO:egress 计数面上线后收紧)"
    return 0
  fi
  [[ "$pend" == "0" ]] || { echo "✗ egress pendingCostEvents=$pend≠0,先等排空再 finalize(防基线污染)" >&2; return 1; }
  EGR_START_STARTID="$(jq -r '.processStartId // "NA"' <<<"$eh")"
  EGR_START_ENQ="$(jq -r '.enqueuedTotal // "NA"' <<<"$eh")"
  EGR_START_SENT="$(jq -r '.sentTotal // "NA"' <<<"$eh")"
  EGR_START_EXP="$(jq -r '.expiredDropsTotal // "NA"' <<<"$eh")"
  EGR_START_OVF="$(jq -r '.overflowDropsTotal // "NA"' <<<"$eh")"
  # BLOCKER 5③:严格数字校验基线计数(startId 是字符串,只需非 NA/非空)。
  [[ "$EGR_START_STARTID" != "NA" && -n "$EGR_START_STARTID" ]] || { [[ "${OC_FINALIZE_SKIP_EGRESS_GATE:-0}" == 1 ]] || { echo "✗ egress processStartId 缺失,拒绝" >&2; return 1; }; }
  _egress_num_or_die "$EGR_START_ENQ" enqueuedTotal || return 1
  _egress_num_or_die "$EGR_START_SENT" sentTotal || return 1
  _egress_num_or_die "$EGR_START_EXP" expiredDropsTotal || return 1
  _egress_num_or_die "$EGR_START_OVF" overflowDropsTotal || return 1
  echo "  ✓ pending==0;基线 startId=$EGR_START_STARTID enq=$EGR_START_ENQ sent=$EGR_START_SENT"
}
# finalize 计数守恒终判(交接窗后)。
egress_gate_conservation() {
  echo "── egress 计数守恒终判:startId 未变 ∧ pendingEnd=0 ∧ enqueuedΔ==sentΔ ∧ expired/overflowΔ=0 ──"
  if [[ "$DRY" == 1 ]]; then echo "  [dry-run] 差分校验守恒"; return 0; fi
  [[ "${OC_FINALIZE_SKIP_EGRESS_GATE:-0}" == 1 && -z "$EGR_START_STARTID" ]] && { echo "  ⚠ 已跳过 egress 门槛"; return 0; }
  local eh; eh="$(_egress_health)"; echo "  egress-health(end): $eh"
  [[ -n "$eh" ]] || { echo "✗ egress 无响应" >&2; return 1; }
  local sid pend enq sent exp ovf
  sid="$(jq -r '.processStartId // "NA"' <<<"$eh")"; pend="$(jq -r '.pendingCostEvents // "NA"' <<<"$eh")"
  enq="$(jq -r '.enqueuedTotal // "NA"' <<<"$eh")"; sent="$(jq -r '.sentTotal // "NA"' <<<"$eh")"
  exp="$(jq -r '.expiredDropsTotal // "NA"' <<<"$eh")"; ovf="$(jq -r '.overflowDropsTotal // "NA"' <<<"$eh")"
  # BLOCKER 5③:终判前严格数字校验(防 NA 落进 $((...)) 被当 0 算出假守恒)。
  _egress_num_or_die "$pend" pendingCostEvents || return 1
  _egress_num_or_die "$enq" enqueuedTotal || return 1
  _egress_num_or_die "$sent" sentTotal || return 1
  _egress_num_or_die "$exp" expiredDropsTotal || return 1
  _egress_num_or_die "$ovf" overflowDropsTotal || return 1
  [[ "$sid" == "$EGR_START_STARTID" ]] || { echo "✗ egress processStartId 变化($EGR_START_STARTID→$sid):中途重启计数归零假绿,进人工核对" >&2; return 1; }
  [[ "$pend" == "0" ]] || { echo "✗ egress pendingEnd=$pend≠0" >&2; return 1; }
  [[ $((enq-EGR_START_ENQ)) -eq $((sent-EGR_START_SENT)) ]] || { echo "✗ enqueuedΔ=$((enq-EGR_START_ENQ)) ≠ sentΔ=$((sent-EGR_START_SENT))(交接窗有事件未送达)" >&2; return 1; }
  [[ "$exp" == "$EGR_START_EXP" && "$ovf" == "$EGR_START_OVF" ]] || { echo "✗ expired/overflow 增长(exp $EGR_START_EXP→$exp / ovf $EGR_START_OVF→$ovf)" >&2; return 1; }
  echo "  ✓ egress 计数守恒"
  # 计费守恒门在**没有豁免**的情况下真跑通过 → 销账(带着 OC_FINALIZE_SKIP_EGRESS_GATE 跑出来的
  # 「通过」不算数:门里有多处 || 放行分支,那不是证据)。
  [[ "${OC_FINALIZE_SKIP_EGRESS_GATE:-0}" == 1 ]] || clear_gate_waiver finalize-egress-gate
}
# VIP owner + control-probe 门槛(RFC D3;$1=candidate_slot)。
vip_control_gate() {
  local slot="$1" cpriv hz; cpriv="$(slot_priv "$slot")"
  echo "── VIP owner + control-probe 门槛(candidate=$slot 私有口 $cpriv)──"
  if [[ "$DRY" == 1 ]]; then echo "  [dry-run] 私有口断言 leadership=leader ∧ vip=owner;GET /internal/v5/control-probe(缺则 healthz 代替+TODO)"; return 0; fi
  hz="$(slot_priv_healthz "$slot")"; echo "  private healthz: $hz"
  [[ -n "$hz" ]] || { echo "✗ candidate 私有口无响应" >&2; return 1; }
  echo "$hz" | grep -q '"state":"leader"' || { echo "✗ candidate leadership!=leader(lease 未接管)" >&2; return 1; }
  # ① VIP owner(BLOCKER 5①:fail-closed,不降级)——私有 healthz 必须带 "vip":"owner"。
  #    缺 vip 字段 = master 版本过旧/未补齐(现已在 master 侧实现),一律拒绝,绝不"暂以 leader 代替"。
  echo "$hz" | grep -q '"vip":"owner"' || {
    echo "✗ candidate 未持有 VIP 或 healthz 缺 vip 字段(egress 控制口未 bind 到 candidate / master 过旧)。拒绝。" >&2
    return 1
  }
  echo "  ✓ candidate 持有 VIP(18894)"
  # ② control-probe 只读(带 egress secret;BLOCKER 5①:fail-closed,不降级)。master 侧端点现已实现。
  local secret probe; secret="$(ssh "$KL_HOST" "grep -E '^OC_EGRESS_SECRET=' '$V5_ENV' | tail -n1 | cut -d= -f2-" 2>/dev/null || true)"
  [[ -n "$secret" ]] || { echo "✗ 无法读取 OC_EGRESS_SECRET(control-probe 无法校验),拒绝" >&2; return 1; }
  probe="$(ssh "$KL_HOST" "curl -fsS --max-time 5 -H 'X-OC-Egress-Secret: $secret' http://127.0.0.1:${cpriv}/internal/v5/control-probe" 2>/dev/null || true)"
  [[ -n "$probe" ]] || { echo "✗ /internal/v5/control-probe 无响应(端点未就绪 / secret 不匹配)。拒绝。" >&2; return 1; }
  echo "  control-probe: $probe"
  echo "$probe" | grep -q '"ok":true' || { echo "✗ control-probe 非 ok(dispatcher 路由表/PG/持有 VIP 自检未过)" >&2; return 1; }
  echo "  ✓ control-probe 通过"
}

# ═════════ lane: --canary ═════════
assert_emergency_source_provenance() {
  [[ -n "$EMERGENCY_INCIDENT" ]] || return 0
  local head remote_refs
  head="$(git rev-parse HEAD)"
  [[ "$BR" == "feat/v5-aurora-rewrite" ]] \
    || { echo "✗ emergency lane 只允许 canonical feat/v5-aurora-rewrite" >&2; return 1; }
  [[ "$head" == "$EMERGENCY_COMMIT" ]] \
    || { echo "✗ emergency exact commit != canonical HEAD($EMERGENCY_COMMIT != $head)" >&2; return 1; }
  [[ -z "$(git status --porcelain)" ]] \
    || { echo "✗ emergency canonical 必须 clean" >&2; return 1; }
  remote_refs="$(env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy \
    git ls-remote --heads origin 2>/dev/null || true)"
  grep -Eq "^${EMERGENCY_COMMIT}[[:space:]]+refs/heads/" <<<"$remote_refs" \
    || { echo "✗ emergency commit 未证明已 push 到 origin 任一 task branch" >&2; return 1; }
  [[ "$MUTATION_LEASE_BYPASSED" != 1 && -n "$MUTATION_DEPLOY_ID" && -n "$MUTATION_HOLDER_IDENTITY" ]] \
    || { echo "✗ emergency lane 禁止 mutation lease 旁路，且必须取得 fencing identity" >&2; return 1; }
  echo "  ✓ emergency provenance:canonical clean/exact HEAD/remote branch/mutation holder"
}

record_emergency_authorization() {
  [[ -n "$EMERGENCY_INCIDENT" ]] || return 0
  [[ "$DRY" == 1 ]] && { echo "  [dry-run] independently record dx emergency approval bound to exact commit"; return 0; }
  assert_emergency_source_provenance || return 1
  local evidence_hash authorized evidence_uid evidence_mode
  evidence_uid="$(stat -c '%u' "$EMERGENCY_APPROVAL_EVIDENCE" 2>/dev/null || true)"
  evidence_mode="$(stat -c '%a' "$EMERGENCY_APPROVAL_EVIDENCE" 2>/dev/null || true)"
  [[ "$evidence_uid" == 0 && "$evidence_mode" =~ ^[46]00$ ]] \
    || { echo "✗ emergency approval evidence 必须 root-owned 且 group/other 无权限(0400/0600)" >&2; return 1; }
  node - "$EMERGENCY_APPROVAL_EVIDENCE" "$EMERGENCY_INCIDENT" "$EMERGENCY_COMMIT" "$EMERGENCY_APPROVAL" <<'NODE'
const fs=require('node:fs');
const [path,incident,commit,approvalRef]=process.argv.slice(2);
const j=JSON.parse(fs.readFileSync(path,'utf8'));
if (j.schema!==1 || j.approver!=='dx' || j.decision!=='APPROVE_P0_CONTAINMENT' ||
    j.ongoingRealUserFinancialOrSecurityHarm!==true || j.smallestContainmentFirst!==true ||
    j.incidentId!==incident || j.exactCommit!==commit || j.approvalRef!==approvalRef ||
    typeof j.approvedAt!=='string' || !Number.isFinite(Date.parse(j.approvedAt))) {
  throw new Error('approval evidence must bind dx + ongoing harm + smallest containment + incident/commit/ref');
}
NODE
  evidence_hash="$(sha256sum "$EMERGENCY_APPROVAL_EVIDENCE" | awk '{print $1}')" || return 1
  authorized="$(ds_exec <<SQL
WITH admin AS (
  SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1
), ins AS (
  INSERT INTO emergency_containment_authorizations(
    incident_id,approval_ref,exact_commit,approval_evidence_sha256,authorized_by
  )
  SELECT '$(ds_lit "$EMERGENCY_INCIDENT")','$(ds_lit "$EMERGENCY_APPROVAL")','$EMERGENCY_COMMIT',
         '$evidence_hash',admin.id FROM admin
  ON CONFLICT (incident_id) DO NOTHING
  RETURNING authorized_by
), audited AS (
  INSERT INTO admin_audit(admin_id,action,target,before,after)
  SELECT authorized_by,'emergency_containment.authorize','incident:$(ds_lit "$EMERGENCY_INCIDENT")',NULL,
         jsonb_build_object('incident_id','$(ds_lit "$EMERGENCY_INCIDENT")','exact_commit','$EMERGENCY_COMMIT',
                            'approval_ref','$(ds_lit "$EMERGENCY_APPROVAL")','evidence_sha256','$evidence_hash')
    FROM ins RETURNING 1
)
SELECT count(*) FROM (
  SELECT 1 FROM ins
  UNION ALL
  SELECT 1 FROM emergency_containment_authorizations
   WHERE incident_id='$(ds_lit "$EMERGENCY_INCIDENT")' AND status='authorized'
     AND approval_ref='$(ds_lit "$EMERGENCY_APPROVAL")' AND exact_commit='$EMERGENCY_COMMIT'
     AND approval_evidence_sha256='$evidence_hash'
) matched;
SQL
)" || return 1
  [[ "$authorized" == 1 ]] \
    || { echo "✗ emergency pre-authorization 与 incident/approval/commit/evidence 不一致" >&2; return 1; }
  echo "✓ emergency pre-authorization recorded:$EMERGENCY_INCIDENT evidence=$evidence_hash"
}

consume_emergency_authorization() {
  [[ -n "$EMERGENCY_INCIDENT" ]] || return 0
  [[ "$DRY" == 1 ]] && { echo "  [dry-run] consume pre-existing one-shot emergency authorization into durable debt"; return 0; }
  assert_emergency_source_provenance || return 1
  local nonce nonce_hash authorized
  nonce="$(openssl rand -hex 32)"; nonce_hash="$(printf '%s' "$nonce" | sha256sum | awk '{print $1}')"
  ds_exec <<SQL >/dev/null
WITH consumed AS (
  UPDATE emergency_containment_authorizations
     SET status='consumed',consumed_at=NOW(),consumed_deploy_id='$MUTATION_DEPLOY_ID',
         consumed_holder_identity='$(ds_lit "$MUTATION_HOLDER_IDENTITY")'
   WHERE incident_id='$(ds_lit "$EMERGENCY_INCIDENT")' AND status='authorized'
     AND approval_ref='$(ds_lit "$EMERGENCY_APPROVAL")' AND exact_commit='$EMERGENCY_COMMIT'
   RETURNING *
)
INSERT INTO emergency_containment_debts(
  incident_id,approval_ref,exact_commit,approval_evidence_sha256,
  deploy_id,holder_identity,authorization_nonce_hash
)
SELECT incident_id,approval_ref,exact_commit,approval_evidence_sha256,
       '$MUTATION_DEPLOY_ID','$(ds_lit "$MUTATION_HOLDER_IDENTITY")','$nonce_hash'
  FROM consumed
ON CONFLICT (incident_id) DO NOTHING;
SQL
  authorized="$(ds_exec <<SQL
SELECT count(*)
  FROM emergency_containment_authorizations a
  JOIN emergency_containment_debts d USING(incident_id)
 WHERE a.incident_id='$(ds_lit "$EMERGENCY_INCIDENT")' AND a.status='consumed' AND d.status='open'
   AND a.approval_ref='$(ds_lit "$EMERGENCY_APPROVAL")' AND a.exact_commit='$EMERGENCY_COMMIT'
   AND d.approval_ref=a.approval_ref AND d.exact_commit=a.exact_commit
   AND d.approval_evidence_sha256=a.approval_evidence_sha256;
SQL
)"
  [[ "$authorized" == 1 ]] \
    || { echo "✗ 缺少独立预授权，或 authorization/debt 与 incident/approval/commit 不一致" >&2; return 1; }
  echo "  ✓ pre-authorized emergency durably consumed/resumed:$EMERGENCY_INCIDENT deploy_id=$MUTATION_DEPLOY_ID"
}

bind_emergency_candidate_release() {
  local release="$1"
  [[ -n "$EMERGENCY_INCIDENT" ]] || return 0
  [[ "$DRY" == 1 ]] && { echo "  [dry-run] bind emergency debt → $release"; return 0; }
  ds_exec <<SQL >/dev/null
UPDATE emergency_containment_debts
   SET candidate_release='$(ds_lit "$release")'
 WHERE incident_id='$(ds_lit "$EMERGENCY_INCIDENT")' AND status='open'
   AND exact_commit='$EMERGENCY_COMMIT' AND approval_ref='$(ds_lit "$EMERGENCY_APPROVAL")'
   AND candidate_release IS NULL;
SQL
  local bound
  bound="$(ds_exec <<SQL
SELECT count(*) FROM emergency_containment_debts
 WHERE incident_id='$(ds_lit "$EMERGENCY_INCIDENT")' AND status='open'
   AND exact_commit='$EMERGENCY_COMMIT' AND approval_ref='$(ds_lit "$EMERGENCY_APPROVAL")'
   AND candidate_release='$(ds_lit "$release")';
SQL
)"
  [[ "$bound" == 1 ]] || { echo "✗ emergency debt 未绑定 exact candidate release" >&2; return 1; }
}

assert_emergency_debt_gate() {
  [[ "$DRY" == 1 ]] && return 0
  local open_id
  open_id="$(ds_exec <<'SQL'
SELECT coalesce((SELECT incident_id FROM emergency_containment_debts WHERE status='open'),'');
SQL
)"
  if [[ -z "$open_id" ]]; then
    [[ "$MODE" != finalize || -z "$EMERGENCY_INCIDENT" ]] \
      || { echo "✗ emergency finalize 缺 durable open debt" >&2; return 1; }
    return 0
  fi
  case "$MODE" in
    abort|rollback|recover|hide-luna) return 0 ;;
    close-emergency-debt)
      [[ "$open_id" == "$EMERGENCY_CLOSE_INCIDENT" ]] \
        || { echo "✗ open debt=$open_id，不允许关闭其它 incident" >&2; return 1; }
      return 0 ;;
    canary|finalize)
      [[ -n "$EMERGENCY_INCIDENT" && "$open_id" == "$EMERGENCY_INCIDENT" ]] \
        || { echo "✗ open emergency debt=$open_id；非同一 emergency lane 禁止发布" >&2; return 1; }
      return 0 ;;
    *) echo "✗ open emergency containment debt=$open_id；补测试/Codex/CI/protected merge 并关闭前，所有非恢复生产变更被阻断" >&2; return 1 ;;
  esac
}

assert_emergency_finalize_authorized() {
  [[ -n "$EMERGENCY_INCIDENT" ]] || return 1
  local ok
  ok="$(ds_exec <<SQL
SELECT count(*)
  FROM emergency_containment_debts d
  JOIN emergency_containment_authorizations a USING(incident_id)
 WHERE d.incident_id='$(ds_lit "$EMERGENCY_INCIDENT")' AND d.status='open' AND a.status='consumed'
   AND d.approval_ref='$(ds_lit "$EMERGENCY_APPROVAL")' AND d.exact_commit='$EMERGENCY_COMMIT'
   AND d.candidate_release='$(ds_lit "$DS_candidate_release")'
   AND d.approval_ref=a.approval_ref AND d.exact_commit=a.exact_commit
   AND d.approval_evidence_sha256=a.approval_evidence_sha256;
SQL
)"
  [[ "$ok" == 1 ]] || { echo "✗ emergency finalize authorization 与 durable debt/candidate 不一致" >&2; return 1; }
}

VERIFICATION_RUN_ID=""
VERIFICATION_SESSION_PREFIX=""
create_release_verification_run() {
  local release="$1" generation="$2" prefix row
  prefix="e2e-$(openssl rand -hex 12)-"
  row="$(ds_exec <<SQL
WITH eval_user AS (
  SELECT id FROM users WHERE email='v5-evals@claudeai.chat' AND credits > 0
), ready AS (
  SELECT (SELECT count(*) FROM eval_user)=1
     AND EXISTS (SELECT 1 FROM model_catalog WHERE model_id='gpt-5.6-luna' AND state='active'
                  AND engine='codex' AND provider_id='codex')
     AND EXISTS (SELECT 1 FROM model_pricing WHERE model_id='gpt-5.6-luna'
                  AND enabled IS TRUE AND visibility IN ('hidden','public'))
     AND (SELECT count(*) FROM model_pricing p,eval_user u
           WHERE p.model_id IN ('gpt-5.6-luna','deepseek-v4-flash') AND p.enabled IS TRUE
             AND (p.visibility='public' OR EXISTS (
               SELECT 1 FROM model_visibility_grants g
                WHERE g.user_id=u.id AND g.model_id=p.model_id
             )))=2 AS ok
), ins AS (
  INSERT INTO verification_runs(
    token_hash,user_id,session_prefix,allowed_models,expected_release,
    expected_generation,approval_ref,expires_at
  )
  SELECT encode(public.digest(convert_to('$prefix','UTF8'),'sha256'),'hex'),u.id,'$prefix',
         ARRAY['deepseek-v4-flash','gpt-5.6-luna']::text[],
         '$(ds_lit "$release")',$generation,'deploy:$(ds_lit "$OP")',NOW()+INTERVAL '90 minutes'
    FROM eval_user u,ready r WHERE r.ok
  RETURNING id::text,session_prefix
)
SELECT id || '|' || session_prefix FROM ins;
SQL
)" || return 1
  [[ -n "$row" ]] || {
    echo "✗ v5-evals/Luna activation/two accessible models/positive precheck balance 不完整" >&2
    return 1
  }
  IFS='|' read -r VERIFICATION_RUN_ID VERIFICATION_SESSION_PREFIX <<<"$row"
  [[ "$VERIFICATION_RUN_ID" =~ ^[0-9a-f-]{36}$ && "$VERIFICATION_SESSION_PREFIX" =~ ^e2e-[a-z0-9]+-$ ]] \
    || { echo "✗ verification run identity 非法:$row" >&2; return 1; }
  echo "  ✓ verification run=$VERIFICATION_RUN_ID prefix=$VERIFICATION_SESSION_PREFIX"
}

close_release_verification_run() {
  local status="$1"
  [[ -n "$VERIFICATION_RUN_ID" ]] || return 0
  ds_exec <<SQL >/dev/null
UPDATE verification_runs SET status='$status',closed_at=NOW()
 WHERE id='$VERIFICATION_RUN_ID' AND status='active';
SQL
}

current_egress_release() {
  ssh "$KL_HOST" "pid=\$(systemctl show -p MainPID --value '$V5_EGRESS_UNIT' 2>/dev/null || echo 0); test \"\${pid:-0}\" -gt 0 && readlink -f /proc/\$pid/cwd" 2>/dev/null || true
}

begin_candidate_egress_transition() { # <candidate-release> <generation>
  local release="$1" generation="$2" predecessor current
  [[ "$DRY" == 1 ]] && { echo "  [dry-run] test candidate egress then restore exact predecessor"; return 0; }
  predecessor="$CAPTURED_EGRESS_PREDECESSOR"
  current="$(current_egress_release)"
  [[ -n "$predecessor" && "$current" == "$predecessor" ]] \
    || { echo "✗ candidate egress predecessor drift(expected=$predecessor actual=${current:-<none>})" >&2; return 1; }
  assert_release_marker "$predecessor" egress || return 1
  ds_exec <<SQL >/dev/null
INSERT INTO release_egress_transitions(release_id,generation,predecessor_release,status)
VALUES ('$(ds_lit "$release")',$generation,'$(ds_lit "$predecessor")','testing');
SQL
  if ! activate_egress_release "$release" "$predecessor"; then
    ds_exec <<SQL >/dev/null
UPDATE release_egress_transitions SET status='rolled_back'
 WHERE release_id='$(ds_lit "$release")' AND generation=$generation AND status='testing';
SQL
    return 1
  fi
  echo "  ✓ candidate tests are now using egress=$release (predecessor durably pinned)"
}

complete_candidate_egress_transition() { # <candidate-release> <generation>
  local release="$1" generation="$2" predecessor count
  [[ "$DRY" == 1 ]] && return 0
  predecessor="$(ds_exec <<SQL
SELECT predecessor_release FROM release_egress_transitions
 WHERE release_id='$(ds_lit "$release")' AND generation=$generation AND status='testing';
SQL
)"
  [[ -n "$predecessor" ]] || { echo "✗ candidate egress testing row missing" >&2; return 1; }
  activate_egress_release "$predecessor" "$release" || return 1
  count="$(ds_exec <<SQL
WITH changed AS (
  UPDATE release_egress_transitions SET status='ready',ready_at=NOW()
   WHERE release_id='$(ds_lit "$release")' AND generation=$generation AND status='testing'
   RETURNING 1
) SELECT count(*) FROM changed;
SQL
)"
  [[ "$count" == 1 ]] || { echo "✗ candidate egress ready CAS failed" >&2; return 1; }
  echo "  ✓ egress restored to predecessor; exact candidate transition is ready for post-finalize activation"
}

reconcile_testing_egress_transition() { # <generation>
  local generation="$1" row release predecessor current count
  [[ "$DRY" == 1 ]] && { echo "  [dry-run] reconcile testing egress → exact predecessor + ready"; return 0; }
  row="$(ds_exec <<SQL
SELECT release_id || '|' || predecessor_release FROM release_egress_transitions
 WHERE generation=$generation AND status='testing';
SQL
)" || return 1
  [[ -n "$row" ]] || return 0
  IFS='|' read -r release predecessor <<<"$row"
  current="$(current_egress_release)"
  if [[ "$current" == "$release" ]]; then
    activate_egress_release "$predecessor" "$release" || return 1
  elif [[ "$current" != "$predecessor" ]]; then
    echo "✗ testing egress cwd 无法裁决(expected candidate=$release or predecessor=$predecessor actual=${current:-<none>})" >&2
    return 1
  fi
  count="$(ds_exec <<SQL
WITH changed AS (
  UPDATE release_egress_transitions SET status='ready',ready_at=NOW()
   WHERE release_id='$(ds_lit "$release")' AND generation=$generation AND status='testing'
   RETURNING 1
) SELECT count(*) FROM changed;
SQL
)" || return 1
  [[ "$count" == 1 ]] || { echo "✗ testing egress → ready CAS failed" >&2; return 1; }
  echo "  ✓ crash-safe egress reconcile:predecessor restored, transition ready generation=$generation"
}

rollback_egress_transition_for_generation() { # <generation>
  local generation="$1" row release predecessor current count
  [[ "$DRY" == 1 ]] && return 0
  row="$(ds_exec <<SQL
SELECT release_id || '|' || predecessor_release FROM release_egress_transitions
 WHERE generation=$generation AND status IN ('testing','ready');
SQL
)"
  [[ -n "$row" ]] || return 0
  IFS='|' read -r release predecessor <<<"$row"
  current="$(current_egress_release)"
  if [[ "$current" == "$release" ]]; then
    activate_egress_release "$predecessor" "$release" || return 1
  elif [[ "$current" != "$predecessor" ]]; then
    echo "✗ abort 后 egress cwd 无法裁决(expected target=$release or predecessor=$predecessor actual=${current:-<none>})" >&2
    return 1
  fi
  count="$(ds_exec <<SQL
WITH changed AS (
  UPDATE release_egress_transitions SET status='rolled_back',activated_at=NULL
   WHERE generation=$generation AND status IN ('testing','ready') RETURNING 1
) SELECT count(*) FROM changed;
SQL
)"
  [[ "$count" == 1 ]] || { echo "✗ egress rollback transition CAS failed" >&2; return 1; }
  echo "  ✓ egress transition rolled back to exact predecessor=$predecessor"
}

finalize_ready_egress_transition() {
  [[ "$DRY" == 1 ]] && { echo "  [dry-run] activate ready egress transition after stable master commit"; return 0; }
  ds_snapshot
  [[ "$DS_phase" == stable ]] || return 0
  # finalize step7 has already changed the active slot/release, but this shell
  # still carries the pre-finalize ACTIVE_STATE_* cache. Refresh it before any
  # post-commit failure can call rollback, and before smoke chooses a port.
  ACTIVE_STATE_LOADED=0
  if ! resolve_active_lane; then
    echo "✗ stable handoff active lane refresh failed；第一动作=官方 rollback" >&2
    rollback || return 1
    return 1
  fi
  if ! assert_release_required_migrations "$DS_active_release"; then
    echo "✗ stable active release migration contract failed；第一动作=官方 rollback" >&2
    rollback || return 1
    return 1
  fi
  local row release predecessor current count transition_generation="$DS_generation"
  row="$(ds_exec <<SQL
SELECT release_id || '|' || predecessor_release FROM release_egress_transitions
 WHERE release_id='$(ds_lit "$DS_active_release")' AND generation=$transition_generation AND status='ready';
SQL
)"
  [[ -n "$row" ]] || return 0
  IFS='|' read -r release predecessor <<<"$row"
  current="$(current_egress_release)"
  if [[ "$current" == "$predecessor" ]]; then
    if ! activate_egress_release "$release" "$predecessor"; then
      echo "✗ stable release egress activation failed；第一动作=官方 rollback" >&2
      rollback
      ds_exec <<SQL >/dev/null
UPDATE release_egress_transitions SET status='rolled_back',activated_at=NULL
 WHERE release_id='$(ds_lit "$release")' AND generation=$transition_generation AND status='ready';
SQL
      return 1
    fi
  elif [[ "$current" != "$release" ]]; then
    echo "✗ stable egress handoff cwd unknown；第一动作=官方 rollback" >&2
    rollback
    return 1
  fi
  count="$(ds_exec <<SQL
WITH changed AS (
  UPDATE release_egress_transitions SET status='active',activated_at=NOW()
   WHERE release_id='$(ds_lit "$release")' AND generation=$transition_generation AND status='ready'
   RETURNING 1
) SELECT count(*) FROM changed;
SQL
)"
  if [[ "$count" != 1 ]]; then
    echo "✗ egress activation evidence CAS failed；第一动作=官方 rollback，随后恢复 egress predecessor" >&2
    rollback || return 1
    activate_egress_release "$predecessor" "$release" || return 1
    ds_exec <<SQL >/dev/null
UPDATE release_egress_transitions SET status='rolled_back',activated_at=NULL
 WHERE release_id='$(ds_lit "$release")' AND generation=$transition_generation AND status='ready';
SQL
    return 1
  fi
  smoke "$ACTIVE_PORT" || {
    echo "✗ egress handoff 后 smoke failed；第一动作=官方 rollback，随后恢复 egress predecessor" >&2
    rollback || return 1
    activate_egress_release "$predecessor" "$release" || return 1
    ds_exec <<SQL >/dev/null
UPDATE release_egress_transitions SET status='rolled_back',activated_at=NULL
 WHERE release_id='$(ds_lit "$release")' AND generation=$transition_generation AND status='active';
SQL
    return 1
  }
  echo "  ✓ stable master + egress activated from exact tested release=$release"
}

assert_v3_inactive() {
  [[ "$DRY" == 1 ]] && { echo "  [dry-run] assert openclaude-v3 inactive"; return 0; }
  local state
  state="$(ssh "$KL_HOST" "systemctl is-active openclaude-v3 2>/dev/null || true")"
  [[ "$state" == inactive || "$state" == failed || "$state" == unknown || -z "$state" ]] \
    || { echo "✗ V3 必须 inactive，当前=$state" >&2; return 1; }
  echo "  ✓ V3 inactive"
}

verify_stable_predecessor_after_gate_failure() {
  local predecessor="$1" predecessor_runtime_tuple="$2" predecessor_egress="${3:-}" current_runtime_tuple current_egress
  ds_snapshot
  [[ "$DS_phase" == stable && "$DS_active_release" == "$predecessor" ]] \
    || { echo "✗ E2E failure abort 后未恢复 exact stable predecessor" >&2; return 1; }
  current_runtime_tuple="$(model_authority_runtime_tuple)" || return 1
  [[ "$current_runtime_tuple" == "$predecessor_runtime_tuple" ]] \
    || { echo "✗ gate failure abort 后 runtime tuple 未恢复 exact predecessor" >&2; return 1; }
  if [[ -n "$predecessor_egress" ]]; then
    current_egress="$(current_egress_release)"
    [[ "$current_egress" == "$predecessor_egress" ]] \
      || { echo "✗ gate failure abort 后 egress 未恢复 exact predecessor" >&2; return 1; }
  fi
  resolve_active_lane
  smoke "$ACTIVE_PORT" || return 1
  assert_v3_inactive || return 1
  echo "  ✓ abort 验收:stable predecessor/runtime health/real turn/V3 inactive"
}

run_candidate_release_verification() {
  local cand="$1" release="$2" generation="$3" incident_sha result_sha
  [[ "$DRY" == 1 ]] && { echo "  [dry-run] fixed Luna/DeepSeek live E2E + zero-skip evidence"; return 0; }
  npm run check:v5:incidents || return 1
  npx --no-install tsx "$REPO_ROOT/scripts/v5-auto-dream-collector-smoke.ts" || return 1
  create_release_verification_run "$release" "$generation" || return 1
  rm -rf "$REPO_ROOT/e2e/session-display/reports" "$REPO_ROOT/e2e/session-display/test-results"
  if [[ ! -x "$REPO_ROOT/e2e/session-display/node_modules/.bin/playwright" ]]; then
    echo "── 安装隔离 Playwright gate 依赖(浏览器下载禁用)──"
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --prefix "$REPO_ROOT/e2e/session-display" || return 1
  fi
  echo "── candidate 固定 live matrix:Luna/Codex + DeepSeek V4 Flash/CCB ──"
  if ! timeout 1800 env \
      OC_E2E_SSH_HOST="$KL_HOST" OC_E2E_PW_HOST="$KL_HOST" \
      OC_E2E_REMOTE_PORT="$(slot_port "$cand")" \
      OC_E2E_REMOTE_ENV="$V5_ENV" \
      OC_E2E_SESSION_PREFIX="$VERIFICATION_SESSION_PREFIX" \
      OC_E2E_RETRIES=0 \
      "$REPO_ROOT/e2e/session-display/run.sh"; then
    return 1
  fi
  incident_sha="$(sha256sum "$REPO_ROOT/e2e/session-display/incidents.json" | awk '{print $1}')"
  result_sha="$(find "$REPO_ROOT/e2e/session-display/reports" -type f -print0 \
    | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')"
  ds_exec <<SQL >/dev/null
UPDATE verification_runs SET status='closed',closed_at=NOW()
 WHERE id='$VERIFICATION_RUN_ID' AND status='active';
INSERT INTO release_verification_evidence(
  release_id,generation,run_id,model_matrix,incident_manifest_sha256,result_sha256
) SELECT '$(ds_lit "$release")',$generation,'$VERIFICATION_RUN_ID',
         ARRAY['deepseek-v4-flash','gpt-5.6-luna']::text[],'$incident_sha','$result_sha'
 WHERE EXISTS (SELECT 1 FROM verification_runs WHERE id='$VERIFICATION_RUN_ID' AND status='closed');
SQL
  local evidence
  evidence="$(ds_exec <<SQL
SELECT count(*) FROM release_verification_evidence
 WHERE release_id='$(ds_lit "$release")' AND generation=$generation AND run_id='$VERIFICATION_RUN_ID';
SQL
)"
  [[ "$evidence" == 1 ]] || { echo "✗ verification evidence 未持久化" >&2; return 1; }
  echo "  ✓ candidate evidence persisted release=$release generation=$generation run=$VERIFICATION_RUN_ID"
}

assert_release_verification_evidence() {
  [[ "$DRY" == 1 ]] && return 0
  local count
  count="$(ds_exec <<SQL
SELECT count(*) FROM release_verification_evidence e
JOIN verification_runs r ON r.id=e.run_id
 WHERE e.release_id='$(ds_lit "$DS_candidate_release")' AND e.generation=$DS_generation
   AND e.model_matrix=ARRAY['deepseek-v4-flash','gpt-5.6-luna']::text[]
   AND r.status='closed';
SQL
)" || return 1
  [[ "$count" == 1 ]]
}

close_emergency_debt() {
  [[ "$DRY" == 1 ]] && { echo "  [dry-run] validate protected merge/Codex/tests/CI evidence and close debt"; return 0; }
  local evidence origin_head
  [[ "$BR" == feat/v5-aurora-rewrite && -z "$(git status --porcelain)" ]] \
    || { echo "✗ emergency debt 只能从 clean canonical branch 关闭" >&2; return 1; }
  env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy \
    git fetch origin feat/v5-aurora-rewrite || return 1
  evidence="$(node - "$CI_EVIDENCE_FILE" "$PROTECTED_MERGE_SHA" <<'NODE'
const fs=require('node:fs'); const p=process.argv[2]; const j=JSON.parse(fs.readFileSync(p,'utf8'));
if (j.schema!==1 || j.codexReview!=='PASS' || j.regressionTests!=='PASS' || j.ci!=='PASS' ||
    j.protectedBranch!=='feat/v5-aurora-rewrite' || j.commit!==process.argv[3] ||
    typeof j.ciUrl!=='string' || !/^https:\/\//.test(j.ciUrl)) {
  throw new Error('evidence must prove Codex PASS + regression PASS + CI PASS + protected branch URL');
}
process.stdout.write(JSON.stringify(j));
NODE
)" || return 1
  git merge-base --is-ancestor "$PROTECTED_MERGE_SHA" HEAD \
    || { echo "✗ protected merge sha 不在 canonical HEAD 血缘" >&2; return 1; }
  origin_head="$(git rev-parse origin/feat/v5-aurora-rewrite 2>/dev/null || true)"
  [[ "$origin_head" == "$PROTECTED_MERGE_SHA" ]] \
    || { echo "✗ origin protected branch head($origin_head) != protected merge sha($PROTECTED_MERGE_SHA)" >&2; return 1; }
  ds_exec <<SQL >/dev/null
UPDATE emergency_containment_debts
   SET status='closed',closed_at=NOW(),protected_merge_sha='$PROTECTED_MERGE_SHA',
       ci_evidence='$(ds_lit "$evidence")'::jsonb
 WHERE incident_id='$(ds_lit "$EMERGENCY_CLOSE_INCIDENT")' AND status='open';
SQL
  local closed
  closed="$(ds_exec <<SQL
SELECT count(*) FROM emergency_containment_debts
 WHERE incident_id='$(ds_lit "$EMERGENCY_CLOSE_INCIDENT")' AND status='closed'
   AND protected_merge_sha='$PROTECTED_MERGE_SHA';
SQL
)"
  [[ "$closed" == 1 ]] || { echo "✗ emergency debt closure CAS 未命中" >&2; return 1; }
  echo "✓ emergency debt closed:$EMERGENCY_CLOSE_INCIDENT protected=$PROTECTED_MERGE_SHA"
}

set_luna_visibility() { # public|hidden
  local visibility="$1" evidence_count=0
  [[ "$visibility" == public || "$visibility" == hidden ]] || return 2
  [[ "$DRY" == 1 ]] && { echo "  [dry-run] set Luna visibility=$visibility with pricing.patch audit"; return 0; }
  ds_snapshot
  if [[ "$visibility" == public ]]; then
    ds_assert_phase stable
    evidence_count="$(ds_exec <<SQL
SELECT count(*) FROM release_verification_evidence e
JOIN verification_runs r ON r.id=e.run_id
 WHERE e.release_id='$(ds_lit "$DS_active_release")' AND e.generation=$DS_generation
   AND r.status='closed';
SQL
)"
    [[ "$evidence_count" == 1 ]] \
      || { echo "✗ Luna public 只允许 stable active exact release/generation 已有双模型证据后执行" >&2; return 1; }
  fi
  local changed
  changed="$(ds_exec <<SQL
WITH admin AS (
  SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1
), before_row AS (
  SELECT jsonb_build_object('visibility',visibility,'enabled',enabled) AS value
    FROM model_pricing WHERE model_id='gpt-5.6-luna'
), updated AS (
  UPDATE model_pricing SET visibility='$visibility',enabled=TRUE,lock_version=lock_version+1,updated_at=NOW()
   WHERE model_id='gpt-5.6-luna'
     AND EXISTS (SELECT 1 FROM admin)
     AND EXISTS (SELECT 1 FROM before_row)
     AND EXISTS (SELECT 1 FROM model_catalog WHERE model_id='gpt-5.6-luna' AND state='active'
                  AND engine='codex' AND provider_id='codex')
   RETURNING jsonb_build_object('visibility',visibility,'enabled',enabled) AS value
), audited AS (
  INSERT INTO admin_audit(admin_id,action,target,before,after)
  SELECT admin.id,'pricing.patch','model:gpt-5.6-luna',before_row.value,updated.value
    FROM admin,before_row,updated RETURNING 1
)
SELECT count(*) FROM audited;
SQL
)" || return 1
  [[ "$changed" == 1 ]] || { echo "✗ Luna visibility/audit transaction 未命中" >&2; return 1; }
  echo "✓ Luna visibility=$visibility（pricing trigger 已通知 master/egress caches）"
}

canary() {
  echo "══ v5 --canary(蓝绿双 master 起手;RFC D5)══"
  if [[ -n "$EMERGENCY_INCIDENT" ]]; then
    consume_emergency_authorization || exit 1
  fi
  resolve_active_lane
  assert_bluegreen_layout "$ACTIVE_SRC"
  [[ "$DRY" == 1 ]] || assert_release_marker "$(bg_current_release "$ACTIVE_SRC")"
  assert_runtime_channel_column
  prepare_live_baseline_safety || { echo "✗ live baseline 安全迁移失败,拒绝 canary" >&2; exit 1; }
  if [[ -n "$CANARY_RELEASE" ]]; then
    local requested_release="$RELEASES_ROOT/$CANARY_RELEASE"
    [[ "$CANARY_RELEASE" == /* ]] && requested_release="$CANARY_RELEASE"
    assert_release_marker "$requested_release"
    assert_release_required_migrations "$requested_release"
  fi
  ds_snapshot
  ds_assert_phase stable
  local predecessor_release="$DS_active_release" predecessor_runtime_tuple
  if [[ "$DRY" == 1 ]]; then
    predecessor_runtime_tuple='{"dry_run":true}'
  else
    predecessor_runtime_tuple="$(model_authority_runtime_tuple)" || exit 1
  fi
  # BLOCKER 6:canary 起手断言 active_release 非 NULL 且目录存在(seed=NULL;基建版须先跑一次传统
  # deploy 校准 active_release)。否则 capability preflight 会拿假/空 active release 做兼容比较。
  if [[ "$DRY" != 1 ]]; then
    [[ -n "$DS_active_release" ]] || {
      echo "✗ deploy_state.active_release 为空(NULL)。基建版首个 --canary 前必须先跑一次传统 deploy" >&2
      echo "  (deploy-v5.sh 或 --dist)以把 active_release 校准成真实 release 目录。" >&2
      exit 1
    }
    local _ar="$DS_active_release"; [[ "$_ar" == /* ]] || _ar="$RELEASES_ROOT/$_ar"
    ssh "$KL_HOST" "test -d '$_ar'" || {
      echo "✗ active_release 目录不存在:$_ar(已被 GC?先跑一次传统 deploy 重新校准)。" >&2
      exit 1
    }
  fi
  local cand; cand="$(slot_other "$DS_active_slot")"
  echo "  · active=$DS_active_slot → candidate=$cand"
  new_operation_id canary
  # step0(起手):CAS phase=canary,预留 candidate,transition_step=0,operation_id(准备期 matcher 不可见)
  ds_cas_or_die "phase='canary', candidate_slot='$cand', transition_step=0, operation_id='$OP'" 0 "canary-begin candidate=$cand"

  # step1:build release(--canary=<rel> 复用现有 release;否则从 HEAD build_release --with-dist)
  local reldir
  if [[ -n "$CANARY_RELEASE" ]]; then
    reldir="$RELEASES_ROOT/$CANARY_RELEASE"; [[ "$CANARY_RELEASE" == /* ]] && reldir="$CANARY_RELEASE"
    echo "── 复用指定 release:$reldir ──"
  else
    WITH_DIST=1
    build_release || { echo "✗ build_release 失败(未 CAS candidate_release,live 未改)" >&2; exit 1; }
    reldir="$BUILT_RELEASE"
  fi
  [[ "$DRY" == 1 ]] && reldir="$RELEASES_ROOT/rel-cand-dry"
  assert_release_marker "$reldir" || {
    echo "✗ candidate release 完整 marker 无效;回 stable(§8 canary<READY)" >&2
    recover_canary_prep "$cand"
    exit 1
  }
  assert_release_baseline_security "$reldir" || {
    echo "✗ candidate release baseline 不安全;回 stable(§8 canary<READY)" >&2
    recover_canary_prep "$cand"
    exit 1
  }
  knowledge_planet_plugin_assert_release_compatible "$reldir" "$reldir" \
    || echo "⚠ canary candidate 的 Knowledge Planet 插件制品与 DB 已审批版本不一致:candidate lane 上该插件将 RUNTIME_UNAVAILABLE(active lane 不受影响,运行时按内容 pin);canary 不因此阻断(2026-07-17 纠偏)" >&2
  ds_cas_or_die "candidate_release='$(ds_lit "$reldir")', transition_step=1" 1 "built candidate_release=$reldir"
  bind_emergency_candidate_release "$reldir" || exit 1

  # candidate release 的 capability 门(与 active 激活同一 sessions-pg 门,复用)
  assert_release_capability_for_sessions_pg "$reldir"
  assert_lossless_turn_tape_floor "$reldir"
  # cutover 后 P3 candidate 也是一条真实激活路径；不能绕过模型权威兼容地板。
  assert_model_authority_floor "$reldir"
  # Direct-timeline generations may not be started side-by-side. First adoption
  # must use the ordinary single-master restart lane.
  assert_direct_turn_timeline_pair "$DS_active_release" "$reldir" "canary pre-start" || {
    echo "✗ direct timeline 代际不兼容;candidate 尚未初始化/启动,回 stable" >&2
    recover_canary_prep "$cand"
    exit 1
  }
  assert_web_storage_rollback_transition \
    "$DS_active_release" "${DS_previous_active_release:-}" "$reldir" "canary pre-start" || {
    echo "✗ browser storage rollback 地板不兼容;candidate 尚未初始化/启动,回 stable" >&2
    recover_canary_prep "$cand"
    exit 1
  }
  # assets → union 池(candidate 与 active 前端 chunk 并集,跨 lane 可得)
  sync_assets_to_pool "$reldir"

  # step2:初始化 candidate slot(HOME/openclaude.json/unit/symlink)
  init_candidate_slot "$cand" "$reldir"
  ds_cas_or_die "transition_step=2" 2 "candidate slot $cand initialized"

  # step3:起 candidate unit + 自检(私有口 healthz/standby/VIP 未 bind)
  start_candidate_unit_and_wait "$cand" || exit 1
  ds_cas_or_die "transition_step=3" 3 "candidate unit started + self-check ok"

  # step4:capability matrix preflight(sessions-pg + dual-master + sw.js 字节一致)
  capability_matrix_preflight "$DS_active_release" "$reldir" || { echo "✗ capability preflight 失败;回 stable(§8 canary<READY)" >&2; recover_canary_prep "$cand"; exit 1; }
  ds_cas_or_die "transition_step=4" 4 "capability matrix preflight ok"

  # step5(=READY):CAS generation+1 + salt 随机 + percent 0 + allowlist 内部账号 + step READY
  local salt allowlist
  salt="$(openssl rand -hex 16 2>/dev/null || echo "salt-$OP")"
  allowlist="$(_internal_allowlist_sql)"
  ds_cas_or_die "generation=generation+1, cohort_salt='$salt', cohort_percent=0, cohort_allowlist=$allowlist, transition_step=$DS_STEP_CANARY_READY" "$DS_STEP_CANARY_READY" "canary READY gen bumped salt rotated allowlist=internal"
  # RFC §1.2:candidate 变为可路由(Caddy 产 matcher)前活体断言 lease;失活 → 回 stable(§8 canary<READY)。
  assert_mutation_lease_alive "canary-ready" || {
    echo "✗ production-mutation lease 失活;candidate 已 READY 但不暴露；保留 deploy_state，crash-stop" >&2
    exit 86; }
  # 此刻起 Caddy 生成器才产 matcher(step≥READY)
  caddy_render_reload
  # 内部账号验证:带当前代次 lane cookie 探 candidate(BLOCKER 5②:硬门,去 || true)
  echo "── 内部账号验证(lane cookie 命中 candidate)──"
  KL_HOST="$KL_HOST" V5_ENV="$V5_ENV" ASSETS_POOL="$V5_ASSETS_POOL" CADDY_HTTP_PORT="$CADDY_HTTP_PORT" \
    bash "$SCRIPT_DIR/v5-caddy-apply.sh" --verify $([[ "$DRY" == 1 ]] && echo --dry-run) || {
    echo "✗ canary READY 验证失败；第一动作=同一 mutation lease 内官方 abort" >&2
    abort
    verify_stable_predecessor_after_gate_failure "$predecessor_release" "$predecessor_runtime_tuple" "$CAPTURED_EGRESS_PREDECESSOR" \
      || { echo "FATAL:Caddy gate failure 后 stable predecessor 验收未通过" >&2; exit 1; }
    exit 1
  }
  if [[ "$RESTART_EGRESS" == 1 ]] \
    && ! begin_candidate_egress_transition "$reldir" "$DS_generation"; then
    echo "✗ candidate egress preflight failed；第一动作=官方 abort" >&2
    abort
    verify_stable_predecessor_after_gate_failure "$predecessor_release" "$predecessor_runtime_tuple" "$CAPTURED_EGRESS_PREDECESSOR" \
      || { echo "FATAL:egress preflight failure 后 stable predecessor 验收未通过" >&2; exit 1; }
    exit 1
  fi
  if [[ -n "$EMERGENCY_INCIDENT" ]]; then
    echo "  ⚠ dx-declared emergency containment:跳过 full candidate regression matrix；止血稳定后 durable debt 将阻断后续普通发布"
  elif ! run_candidate_release_verification "$cand" "$reldir" "$DS_generation"; then
    echo "✗ candidate regression gate failed；第一动作=同一 mutation lease 内官方 abort" >&2
    abort
    close_release_verification_run failed || true
    verify_stable_predecessor_after_gate_failure "$predecessor_release" "$predecessor_runtime_tuple" "$CAPTURED_EGRESS_PREDECESSOR" \
      || { echo "FATAL:E2E failure 后 stable predecessor 验收未通过" >&2; exit 1; }
    exit 1
  fi
  if [[ "$RESTART_EGRESS" == 1 ]] \
    && ! complete_candidate_egress_transition "$reldir" "$DS_generation"; then
    echo "✗ candidate egress predecessor restore/evidence failed；第一动作=官方 abort" >&2
    abort
    verify_stable_predecessor_after_gate_failure "$predecessor_release" "$predecessor_runtime_tuple" "$CAPTURED_EGRESS_PREDECESSOR" \
      || { echo "FATAL:egress restore failure 后 stable predecessor 验收未通过" >&2; exit 1; }
    exit 1
  fi
  # ── canary READY 最小功能核(2026-07-26;审计 5)────────────────────────────
  # canary 的全部意义就是「放量前发现问题」,但此前它自己不跑一个真 turn:regression matrix
  # 跑的是 session-display 的 9 个 spec,不含 v5-smoke-turn-canary 的三信号真 turn(exactText
  # +isFinal+cost_charged),也不含 J1-J5 真浏览器旅程。percent=0 时 candidate 不承接任何真实
  # 用户流量,此处跑功能核的成本≈零,却是放量前最强的用户可见事实证据。
  # 失败语义与本 lane 其它门**完全一致**:同一 mutation lease 内官方 abort + stable predecessor
  # 验收(不新造「READY 但中毒」这种状态机外的第三态);放量侧另有 promote 的 candidate 探针兜底。
  if [[ -n "$EMERGENCY_INCIDENT" ]]; then
    echo "  ⚠ dx-declared emergency containment:跳过 canary READY 最小功能核;止血稳定后 durable debt 将阻断后续普通发布"
  elif ! minimum_functional_core "canary-ready" "$reldir" "$(slot_port "$cand")"; then
    echo "✗ canary READY 最小功能核失败(真 turn / J1-J5 旅程);第一动作=同一 mutation lease 内官方 abort" >&2
    abort
    verify_stable_predecessor_after_gate_failure "$predecessor_release" "$predecessor_runtime_tuple" "$CAPTURED_EGRESS_PREDECESSOR" \
      || { echo "FATAL:功能核 failure 后 stable predecessor 验收未通过" >&2; exit 1; }
    exit 1
  fi
  echo "✓ --canary 完成(gen=$((DS_generation)) candidate=$cand percent=0 allowlist=内部)。放量:deploy-v5.sh --promote=<pct>"
}

# 内部账号 allowlist SQL 数组(env OC_CANARY_INTERNAL_UIDS=csv;空=空数组,仅手工 cookie 可达 candidate,RFC D1 m2 允许)
_internal_allowlist_sql() {
  local csv="${OC_CANARY_INTERNAL_UIDS:-}"
  if [[ -z "$csv" ]]; then echo "'{}'::bigint[]"; return 0; fi
  [[ "$csv" =~ ^[0-9]+(,[0-9]+)*$ ]] || { echo "✗ OC_CANARY_INTERNAL_UIDS 非法(须逗号分隔的 uid):$csv" >&2; exit 2; }
  echo "'{$csv}'::bigint[]"
}

# canary 准备期(<READY)恢复:stop candidate unit + 只清本 operation 产物(symlink/未激活),回 stable。
# 【铁律】HOME 绝不递归删(RFC §8 R4:HOME 是持久 slot 状态含 uploads/诊断,可能是上一轮 active 的家)。
recover_canary_prep() {
  local cand="$1" csrc cunit; csrc="$(slot_src "$cand")"; cunit="$(slot_unit "$cand")"
  require_mutation_lease_for_compensation "canary-prep-recovery" || exit 86
  echo "── 恢复(canary<READY):stop candidate + 清本 operation 产物(不删 HOME)→ 回 stable ──"
  # step0-1 尚未执行 init_candidate_slot，candidate unit 可能从未安装；这种“确实无 unit 文件”
  # 是已清理状态而非失败。unit 文件存在时 stop/disable 必须成功；SSH/远端命令失败仍 fail-closed。
  if ! sshk "if [ -e '/etc/systemd/system/$cunit' ] || [ -e '/run/systemd/system/$cunit' ] || [ -e '/usr/lib/systemd/system/$cunit' ] || [ -e '/lib/systemd/system/$cunit' ]; then systemctl disable --now '$cunit'; else echo '  · candidate unit 未安装(step0-1)，无需 stop'; fi"; then
    echo "✗ candidate stop/disable 失败，保持 canary 准备态供 --recover 重试" >&2
    return 1
  fi
  if ! sshk "rm -f '$csrc.newlink.'*"; then   # 只清未激活临时 symlink;不动 HOME/release
    echo "✗ candidate 临时 symlink 清理失败，保持 canary 准备态" >&2
    return 1
  fi
  ds_cas_or_die "phase='stable', candidate_slot=NULL, candidate_release=NULL, transition_step=0, operation_id=NULL" 0 "recovered canary<READY → stable" || return 1
  echo "  ✓ 已回 stable(零流量影响)"
}

# ═════════ lane: --promote ═════════
promote() {
  echo "══ v5 --promote=$PROMOTE_PCT(cohort 放量;RFC D5)══"
  ds_snapshot
  ds_assert_phase canary
  local promote_candidate="$DS_candidate_release"
  if [[ "$DRY" != 1 ]]; then
    [[ "$promote_candidate" == /* ]] || promote_candidate="$RELEASES_ROOT/$promote_candidate"
    assert_release_marker "$promote_candidate" || exit 1
    assert_release_marker "$(bg_current_release "$(slot_src "$DS_active_slot")")" || exit 1
  fi
  [[ "$DRY" == 1 || "$DS_transition_step" -ge "$DS_STEP_CANARY_READY" ]] || { echo "✗ canary 未到 READY(step=$DS_transition_step),不能放量" >&2; exit 1; }
  new_operation_id promote
  assert_mutation_lease_alive "promote" || { echo "✗ production-mutation lease 失活;放量 crash-stop(cohort_percent 未改)" >&2; exit 86; }
  # ── promote 前的 candidate 活体探针(2026-07-26;审计 6)────────────────────
  # 此前 promote() 整函数只有一条 cohort_percent CAS,之后 echo「观察面=人工」。可**真实用户
  # 暴露正是从 promote 才开始**:canary READY 到 promote 之间可能隔了几小时,candidate 完全
  # 可能已 OOM 重启/lease 抖动/引擎凭据过期。抬 percent 之前必须重新证明 candidate 还能出正文。
  # 【为什么不是 vip_control_gate】审计建议复用 vip_control_gate,但按实际代码它断言
  # `state=leader ∧ vip=owner` —— 那是 finalize step4 交接**之后**的不变量;canary 期
  # candidate 恒为 standby + VIP released,挂 vip_control_gate 会让每一次正常放量都失败。
  # 故此处用同一 lane 自己的就绪不变量 wait_for_candidate_ready(standby+VIP released)。
  # 【为什么不跑 journey】J1-J5 已在同一 candidate release 的 canary READY 跑过;promote
  # 新增的风险面是「candidate 自 READY 以来是否退化」,一条三信号真 turn 即可判定,且多档
  # 放量(5→25→50)不会被浏览器旅程拖成分钟级。
  if [[ "$DRY" != 1 ]]; then
    wait_for_candidate_ready "$DS_candidate_slot" 60 || {
      echo "✗ promote 前 candidate($DS_candidate_slot)未处于 standby+VIP released:拒绝放量(cohort_percent 未改)。" >&2
      echo "  candidate 已不健康 → 走官方 --abort 回退,不要在坏 candidate 上放量。" >&2
      exit 1
    }
    smoke_turn_matrix "$promote_candidate" "$(slot_port "$DS_candidate_slot")" "promote-candidate" || {
      echo "✗ promote 前 candidate 真 turn 矩阵失败:拒绝放量(cohort_percent 未改)。" >&2
      echo "  candidate 引擎已不能出正文/收尾/计费 → 走官方 --abort 回退。" >&2
      exit 1
    }
  fi
  ds_cas_or_die "cohort_percent=$PROMOTE_PCT, operation_id='$OP'" "$DS_STEP_CANARY_READY" "promote percent=$PROMOTE_PCT"
  echo "  · percent=$PROMOTE_PCT(在线用户下次 /api/me 重评;观察面=双 slot healthz + 错误日志 diff + 计费一致性抽查)"
  echo "✓ --promote 完成。continue:--promote=<更高> / --finalize / --abort"
}

# ── BLOCKER 3:finalize egress 基线持久化到 journal(step0)+ resume 从 journal 恢复(绝不重新 baseline=假绿)──
# step0 的 journal action 内嵌 egress 基线 JSON;resume 用**原基线**做守恒差分(startId 未变 ∧
# enqueuedΔ==sentΔ…),中途 egress 重启(startId 变、计数归零)才能被守恒门抓到。重新 baseline 会捕获
# 新 startId + 归零计数 → 差分恒 0 假绿,丢失的计费事件无人察觉。
egress_baseline_journal_fragment() {
  printf 'egress-baseline={"startId":"%s","enq":"%s","sent":"%s","exp":"%s","ovf":"%s"}' \
    "$EGR_START_STARTID" "$EGR_START_ENQ" "$EGR_START_SENT" "$EGR_START_EXP" "$EGR_START_OVF"
}
# 从本 OP 的 step0 journal action 恢复 egress 基线到 EGR_START_*。marker 在=成功(即使值为空=skip 态,
# 守恒门会据空 startId 跳过);marker 不在(step0 journal 缺失/旧格式)=返回 1(基线丢失,调用方 fail-closed)。
egress_baseline_restore_from_journal() {
  local action json
  action="$(ds_exec 2>/dev/null <<SQL || true
SELECT action FROM deploy_state_journal
 WHERE operation_id = '$(ds_lit "$OP")' AND step = 0 AND action LIKE '%egress-baseline=%'
 ORDER BY id DESC LIMIT 1;
SQL
)"
  json="$(printf '%s' "$action" | sed -n 's/.*egress-baseline=\({[^}]*}\).*/\1/p')"
  [[ -n "$json" ]] || return 1
  EGR_START_STARTID="$(jq -r '.startId // ""' <<<"$json" 2>/dev/null || echo "")"
  EGR_START_ENQ="$(jq -r '.enq // ""' <<<"$json" 2>/dev/null || echo "")"
  EGR_START_SENT="$(jq -r '.sent // ""' <<<"$json" 2>/dev/null || echo "")"
  EGR_START_EXP="$(jq -r '.exp // ""' <<<"$json" 2>/dev/null || echo "")"
  EGR_START_OVF="$(jq -r '.ovf // ""' <<<"$json" 2>/dev/null || echo "")"
  echo "  · 从 journal(step0)恢复 egress 原基线(不重新 baseline):startId=$EGR_START_STARTID enq=$EGR_START_ENQ sent=$EGR_START_SENT"
  return 0
}

# ═════════ lane: --finalize(七步序;RFC D5 B2 + BLOCKER 4 可续作 resume)═════════
# 入口接受 phase ∈ {canary(全新), finalizing(断点续作)}。resume 时按 (phase, transition_step) 逐步
# 核验外部事实后从断点前滚(每步 `-lt N` 幂等守卫);step6(旧 unit 已停)= 直接前滚 step7。
# --recover 对 finalizing 直接调用本函数,而非仅打印提示。
finalize() {
  echo "══ v5 --finalize(cohort 收敛 + master 交接;RFC D5 七步;可 resume)══"
  ds_snapshot
  if [[ "$DS_phase" == canary || "$DS_phase" == finalizing ]]; then
    if [[ -n "$EMERGENCY_INCIDENT" ]]; then
      if ! assert_emergency_source_provenance || ! assert_emergency_finalize_authorized; then
        echo "✗ emergency authorization mismatch；第一动作=官方 abort" >&2
        abort
        exit 1
      fi
    elif ! assert_release_verification_evidence; then
      echo "✗ candidate 缺 exact release/generation fixed-matrix evidence；第一动作=官方 abort" >&2
      abort
      exit 1
    fi
    if ! reconcile_testing_egress_transition "$DS_generation"; then
      echo "✗ testing egress transition 无法收敛；第一动作=官方 abort" >&2
      abort
      exit 1
    fi
  fi
  local cand old kp_candidate_release
  kp_candidate_release="$DS_candidate_release"
  [[ "$DRY" == 1 || -n "$kp_candidate_release" ]] \
    || { echo "✗ finalize 缺 candidate_release，无法校验 Knowledge Planet contract" >&2; exit 1; }
  [[ -z "$kp_candidate_release" || "$kp_candidate_release" == /* ]] \
    || kp_candidate_release="$RELEASES_ROOT/$kp_candidate_release"
  [[ "$DRY" == 1 ]] || {
    assert_release_marker "$kp_candidate_release" || exit 1
    assert_release_marker "$(bg_current_release "$(slot_src "$DS_active_slot")")" || exit 1
  }
  knowledge_planet_plugin_assert_release_compatible \
    "$kp_candidate_release" "$kp_candidate_release" \
    || echo "⚠ candidate 的 Knowledge Planet 插件制品与 DB 已审批版本不一致:finalize 后该插件将 RUNTIME_UNAVAILABLE 直至验证晋升;finalize 不因此阻断(2026-07-17 纠偏)" >&2
  if [[ "$DRY" == 1 ]]; then
    ds_assert_phase canary
    cand="${DS_candidate_slot:-B}"; old="$DS_active_slot"
    new_operation_id finalize
    egress_gate_prelude || { echo "✗ egress 前置未过" >&2; exit 1; }
    finalize_run_steps "$cand" "$old"
    return 0
  fi
  case "$DS_phase" in
    canary)
      cand="$DS_candidate_slot"; old="$DS_active_slot"
      [[ -n "$cand" ]] || { echo "✗ 无 candidate,无法 finalize" >&2; exit 1; }
      new_operation_id finalize
      # egress 前置(pending==0 + 基线快照);未过不进 finalizing
      egress_gate_prelude || { echo "✗ egress 前置未过,拒绝 finalize(不改状态)" >&2; exit 1; }
      # 起手 CAS phase=finalizing step0。BLOCKER 3①:step0 journal action 内嵌 egress 基线(resume 从此恢复原基线)。
      ds_cas_or_die "phase='finalizing', transition_step=0, operation_id='$OP'" 0 "finalize-begin candidate=$cand $(egress_baseline_journal_fragment)"
      ;;
    finalizing)
      # resume:cand/old 由 deploy_state 派生(step7 前 active_slot 恒=旧,candidate_slot=cand)。
      cand="$DS_candidate_slot"; old="$DS_active_slot"
      [[ -n "$cand" ]] || { echo "✗ finalizing 但无 candidate_slot,状态损坏,人工介入" >&2; exit 1; }
      # MINOR:resume 沿用状态行原 operation_id(不新造 OP;journal 归并同一操作)。
      OP="${DS_operation_id:-p3-finalize-resume-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
      echo "  · finalize resume:phase=finalizing step=$DS_transition_step candidate=$cand active(old)=$old op=$OP"
      # BLOCKER 3①②:守恒门槛还会跑的 step(<6)必须用 step0 持久化的**原基线**(绝不重新 baseline=假绿)。
      # 取不到(journal 缺失/损坏)→ fail-closed 转 aborting(先起旧 unit 核验健康再切回);step>=6 已过门槛不需基线。
      if [[ "$DS_transition_step" -lt 6 ]]; then
        if ! egress_baseline_restore_from_journal; then
          if [[ "${OC_FINALIZE_SKIP_EGRESS_GATE:-0}" == 1 ]]; then
            echo "  ⚠ 无法从 journal 恢复 egress 基线,但 OC_FINALIZE_SKIP_EGRESS_GATE=1 已放行(危险,登记债)"
          else
            echo "✗ finalize resume 无法恢复 step0 egress 原基线(journal 缺失/损坏)→ fail-closed 转 aborting(§8)" >&2
            require_mutation_lease_for_compensation "finalize-baseline-recovery" || exit 86
            ds_cas_or_die "phase='aborting', transition_step=0" 0 "finalize resume: egress baseline unrecoverable → aborting"
            sshk "systemctl start $(slot_unit "$old") 2>/dev/null || true"
            abort_continue "$old" "$cand"
            exit 1
          fi
        fi
      fi
      ;;
    *)
      echo "✗ finalize 仅接受 phase ∈ {canary(全新), finalizing(resume)}(当前=$DS_phase)。aborting 请用 --abort/--recover。" >&2
      exit 1
      ;;
  esac
  finalize_run_steps "$cand" "$old"
  finalize_ready_egress_transition || exit 1
  echo "✓ --finalize 全部完成:master/egress 已收敛到 exact tested release。"
}

# finalize step1..7 主体(每步 `-lt N` 幂等守卫;fresh 全跑,resume 从断点前滚)。$1=cand $2=old。
finalize_run_steps() {
  local cand="$1" old="$2"
  # candidate_release 在 precommit 功能门也要用(见⑥⑦),故提到函数作用域顶层。
  local candidate_release=""

  # 独立 --finalize 是新 shell，不能依赖 --canary 时的内存变量。始终从 deploy_state 钉死的
  # candidate_release 读取期望 dist build id，且在停旧 slot / commit stable 前做严格握手。
  if [[ "$DRY" != 1 ]]; then
    candidate_release="$DS_candidate_release"
    [[ -n "$candidate_release" ]] || {
      echo "✗ finalize 缺 candidate_release，无法建立 dist 版本权威" >&2
      exit 1
    }
    [[ "$candidate_release" == /* ]] || candidate_release="$RELEASES_ROOT/$candidate_release"
    DIST_BUILD_ID="$(ssh "$KL_HOST" "grep -o 'name=\"oc-build\" content=\"[0-9a-f]\\{8,32\\}\"' '$candidate_release/packages/web-react/dist/index.html' 2>/dev/null | grep -o '[0-9a-f]\\{8,32\\}' | head -1" 2>/dev/null || true)"
    [[ -n "$DIST_BUILD_ID" ]] || {
      echo "✗ candidate_release dist 缺 oc-build:$candidate_release" >&2
      exit 1
    }
    echo "  · candidate release oc-build 权威:$DIST_BUILD_ID"
  fi

  # ① percent=100 观察窗(step1)
  if [[ "$DRY" == 1 || "$DS_transition_step" -lt 1 ]]; then
    ds_cas_or_die "cohort_percent=100, transition_step=1" 1 "percent=100 observe"
    echo "  · percent=100:活跃评估者全量迁 candidate(观察窗)"
  fi

  # ② Caddy 默认 upstream 切 candidate + 硬验证,**成功后才 CAS step=2**(MAJOR 2)。渲染用
  #    DS_RENDER_STEP_OVERRIDE=2 表达 step2 语义(默认→candidate),避免"记录 step2 但 Caddy 未真正
  #    切/验证未过"的状态-现实撕裂。验证失败 → 转 aborting 补偿(§8),不留错误的 step2 记录。
  if [[ "$DRY" == 1 || "$DS_transition_step" -lt 2 ]]; then
    # RFC §1.2:默认流量 master 交接(step2)是 finalize 唯一用户可感翻转,交接前活体断言 lease。
    if ! assert_mutation_lease_alive "finalize-step2"; then
      echo "✗ production-mutation lease 失活;finalize step2 前 crash-stop，保留 deploy_state 供人工裁决" >&2
      exit 86
    fi
    echo "── ② 渲染默认→candidate(step2 语义)+ reload + 硬验证新请求全落 candidate ──"
    export DS_RENDER_STEP_OVERRIDE=2
    caddy_render_reload
    local step2_ok=1
    KL_HOST="$KL_HOST" V5_ENV="$V5_ENV" ASSETS_POOL="$V5_ASSETS_POOL" CADDY_HTTP_PORT="$CADDY_HTTP_PORT" \
      bash "$SCRIPT_DIR/v5-caddy-apply.sh" --verify $([[ "$DRY" == 1 ]] && echo --dry-run) || step2_ok=0
    unset DS_RENDER_STEP_OVERRIDE
    if [[ "$step2_ok" != 1 ]]; then
      echo "✗ finalize step2 验证失败(默认未确认切到 candidate)→ 转 aborting 补偿(§8)" >&2
      require_mutation_lease_for_compensation "finalize-step2-compensation" || exit 86
      ds_cas_or_die "phase='aborting', transition_step=0" 0 "finalize step2 verify FAILED → aborting"
      sshk "systemctl start $(slot_unit "$old") 2>/dev/null || true"
      abort_continue "$old" "$cand"
      exit 1
    fi
    ds_cas_or_die "transition_step=2" 2 "default upstream → candidate (rendered+verified)"
  fi

  # ③ 旧 WS 自然存活或有界 drain(step3)——--drain-ws 时对旧 slot 发安全点重连
  if [[ "$DRY" == 1 || "$DS_transition_step" -lt 3 ]]; then
    if [[ "$DRAIN_WS" == 1 ]]; then
      echo "── 有界 drain 旧 slot($old)WS(可选)──"
      sshk "curl -fsS --max-time 5 -X POST http://127.0.0.1:$(slot_priv "$old")/internal/v5/drain-ws 2>/dev/null || echo '  ⚠ drain-ws 端点未就绪(TODO:Agent A)'"
    else
      echo "  · 旧 slot WS 自然存活(resume 权威=容器 ring+客户端游标,跨实例透明)"
    fi
    ds_cas_or_die "transition_step=3" 3 "ws drain (drain_ws=$DRAIN_WS)"
  fi

  # ④ CAS desired_*=candidate(step4)→ 旧 master fence + close VIP;candidate 竞 lease + bind VIP
  if [[ "$DRY" == 1 || "$DS_transition_step" -lt 4 ]]; then
    ds_cas_or_die "desired_leader_slot='$cand', desired_control_slot='$cand', transition_step=4" 4 "desired_* → candidate (lease/VIP handover)"
  fi

  # ⑤ D3 四门槛(step5;超时→转 aborting 按 §8)。BLOCKER 3③:resume 落到 step4/5(未 commit)都**重跑**门槛
  #    (idempotent 只读核验 + 用 step0 原基线守恒),绝不凭 stale step5 记录就停旧 unit / commit stable。
  #    故 guard=`-lt 6`(resume step5 也进);step5 CAS 仅在尚未记录时推进(resume step5 只重验不重复 CAS)。
  if [[ "$DRY" == 1 || "$DS_transition_step" -lt 6 ]]; then
    echo "── 四门槛(fresh 或 resume 重验:leader/VIP 交接 + VIP owner + control-probe + egress 守恒)──"
    # BLOCKER 5⑤:固定 sleep 改有界轮询(2s 间隔,60s 上限);权威裁决在下方四门槛。
    wait_for_slot_leadership "$cand" 1 60 || echo "  · 轮询超时,交由四门槛裁决"
    if ! ( vip_control_gate "$cand" && egress_gate_conservation ); then
      echo "✗ finalize 四门槛未过 → 补偿:desired 收回旧 slot + 重启旧 unit + 转 aborting(§8)" >&2
      require_mutation_lease_for_compensation "finalize-gate-compensation" || exit 86
      ds_cas_or_die "phase='aborting', transition_step=0" 0 "finalize gate FAILED → compensate → aborting"
      sshk "systemctl start $(slot_unit "$old") 2>/dev/null || true"
      abort_continue "$old" "$cand"
      exit 1
    fi
    if [[ "$DRY" == 1 || "$DS_transition_step" -lt 5 ]]; then
      ds_cas_or_die "transition_step=5" 5 "four gates passed (VIP+control-probe+egress conservation)"
    fi
  fi

  # ⑥⑦ 提交(step6 stop 旧 unit → step7 commit stable)。BLOCKER 3④:resume 落到 step6(旧 unit 已停,未 commit)
  #    → 提交 stable 前**重新核验** candidate liveness+leadership=leader+VIP owner+control-probe;candidate 异常
  #    → 转 aborting(§8:先起旧 unit 核验健康再切回),绝不凭"旧 unit 已停"的既成事实盲目 commit。
  if [[ "$DRY" == 1 || "$DS_transition_step" -lt 7 ]]; then
    if [[ "$DRY" != 1 && "$DS_transition_step" -ge 6 ]]; then
      echo "── (resume step6)提交 stable 前重新核验 candidate($cand)liveness+leadership+VIP+control-probe ──"
      if ! ( wait_for_slot_leadership "$cand" 1 60 && vip_control_gate "$cand" ); then
        echo "✗ (resume step6)candidate 异常 → 转 aborting(§8:先起旧 unit 核验健康再切回)" >&2
        require_mutation_lease_for_compensation "finalize-step6-compensation" || exit 86
        ds_cas_or_die "phase='aborting', transition_step=0" 0 "finalize resume step6 candidate UNHEALTHY → aborting"
        sshk "systemctl start $(slot_unit "$old") 2>/dev/null || true"
        abort_continue "$old" "$cand"
        exit 1
      fi
    fi
    # fresh step5 与 resume step6 都在 commit stable 前跑完整 leader smoke + release/dist 握手。
    # 任一失败都保留/拉起旧 slot 并进入 aborting，不制造“已切换但命令判失败”的终态。
    # 2026-07-26(审计 4):finalize 是 candidate 变成吃 100% 流量的 stable 的**不可逆点**,
    # 而此前提交前只有 smoke + dist_handshake_smoke —— 两者都是健康端点/版本字符串级证据。
    # 2026-07-17 goal 事故的教训正是「健康端点全绿 + codex 引擎 100% turn 必挂」。此处补最小
    # 功能核(双引擎三信号真 turn + J1-J5 真浏览器旅程)。失败仍走既有 aborting 补偿路径,
    # 旧 unit 拉起 + abort_continue,恢复路径一字未动。
    if [[ "$DRY" != 1 ]]; then
      echo "── 提交 stable 前完整 smoke + 最小功能核 + candidate release/dist 握手 ──"
      if ! smoke "$(slot_port "$cand")" \
        || ! minimum_functional_core finalize-precommit "$candidate_release" "$(slot_port "$cand")" \
        || ! dist_handshake_smoke "$(slot_port "$cand")"; then
        echo "✗ finalize 提交前 smoke/功能核/版本握手失败 → 转 aborting，保留恢复路径" >&2
        require_mutation_lease_for_compensation "finalize-precommit-compensation" || exit 86
        ds_cas_or_die "phase='aborting', transition_step=0" 0 "finalize precommit functional gate FAILED → aborting"
        sshk "systemctl start $(slot_unit "$old") 2>/dev/null || true"
        abort_continue "$old" "$cand"
        exit 1
      fi
    fi
    # step<6:停旧 unit(step6)
    if [[ "$DRY" == 1 || "$DS_transition_step" -lt 6 ]]; then
      echo "── stop 旧 unit $(slot_unit "$old")──"
      sshk "systemctl stop $(slot_unit "$old")"
      ds_cas_or_die "transition_step=6" 6 "old unit $old stopped"
    fi
    # ⑦ commit stable(step7)。BLOCKER 4:previous_active_release←旧 active_release(rollback 权威血缘;
    #    PG SET 表达式全引用 OLD 行 → previous←旧 active、active←旧 candidate,一次原子对调)。
    ds_cas_or_die "active_slot='$cand', previous_active_release=active_release, active_release=candidate_release, candidate_slot=NULL, candidate_release=NULL, phase='stable', transition_step=0, cohort_percent=0" 7 "finalize commit active_slot=$cand phase=stable (previous←old active)"
    # 收敛后 Caddy re-render(此刻 active=cand,无 candidate → 回 seed 形态,默认→新 active)
    caddy_render_reload
  fi
  echo "  ✓ master finalize steps 完成:active_slot=$cand(原 candidate 已成新主+leader+VIP),旧 slot=$old 已停。"
}

# ═════════ lane: --abort ═════════
abort() {
  echo "══ v5 --abort(秒级回退到旧 active;RFC D5)══"
  ds_snapshot
  ds_assert_phase canary finalizing aborting
  require_mutation_lease_for_compensation "abort-entry" || exit 86
  local cand="${DS_candidate_slot:-B}" old="$DS_active_slot"
  # MINOR:aborting resume 沿用状态行原 operation_id(崩溃重跑不新造 OP;journal 归并同一操作)。
  if [[ "$DS_phase" == "aborting" && -n "${DS_operation_id:-}" ]]; then
    OP="$DS_operation_id"; echo "  · abort resume:沿用状态行原 operation_id=$OP"
  else
    new_operation_id abort
  fi
  # 起手 CAS aborting(若已 aborting 幂等续作)
  [[ "$DS_phase" == "aborting" ]] || ds_cas_or_die "phase='aborting', transition_step=0, operation_id='$OP'" 0 "abort-begin candidate=$cand"
  # 恢复前置(关键):若 finalize 已过 step6(旧 unit 已停)——先起旧 unit + 私有口健康 + capability 校验
  echo "── 恢复前置:确保旧 slot($old)running + 健康(绝不在旧 slot 未确认健康时先切流,防全停)──"
  sshk "systemctl start $(slot_unit "$old") 2>/dev/null || true"
  run "sleep 4"
  if [[ "$DRY" != 1 ]]; then
    local ohz; ohz="$(ssh "$KL_HOST" "curl -fsS --max-time 5 http://127.0.0.1:$(slot_priv "$old")/healthz" 2>/dev/null || true)"
    echo "  旧 slot 私有 healthz: $ohz"
    echo "$ohz" | grep -q '"ok":true' || { echo "✗ 旧 slot 未健康,中止 abort(人工介入;绝不切流到不健康旧 slot)" >&2; exit 1; }
  fi
  abort_continue "$old" "$cand"
}

# abort ①→④ **按 step 幂等续作**(finalize 补偿与 --abort/--recover 共用)。$1=old(恢复目标) $2=candidate
# BLOCKER 4:每步 `-lt N` 守卫 → resume(aborting 崩溃重跑)不回退已完成步;caddy 渲染/等旧 leader
# 是幂等核验,总是执行。abort transition_step 序:0(begin)→2(desired 收回)→3(candidate 停)→commit。
abort_continue() {
  local old="$1" cand="$2" csrc; csrc="$(slot_src "$cand")"
  local old_src old_release image_id runtime_release
  old_src="$(slot_src "$old")"
  old_release="$(bg_current_release "$old_src")"
  [[ "$DRY" == 1 ]] || {
    [[ -n "$old_release" ]] || { echo "✗ abort 无法解析旧 slot release:$old_src" >&2; return 1; }
    assert_release_marker "$old_release" || return 1
    assert_release_required_migrations "$old_release" || return 1
  }
  image_id="$(remote_env_get OC_RUNTIME_IMAGE_ID)"
  runtime_release="$(remote_env_get OC_RUNTIME_RELEASE)"
  # F7:abort/recover 是补偿/恢复路径(把公共流量与 leadership 收回旧 slot),恢复动作前
  # 复核 lease；失活即 crash-stop，保留 aborting 状态供人工裁决后显式恢复。
  require_mutation_lease_for_compensation "abort-continue" || exit 86
  # Must run before Caddy can route a single request back to old. The canary
  # preflight already closes the first-tape race; this fresh fail-closed check
  # also protects abort/recover after tapes exist.
  assert_web_storage_rollback_transition \
    "$old_release" "${DS_previous_active_release:-}" "$old_release" "canary abort" || return 1
  assert_lossless_turn_tape_floor "$old_src"
  assert_lossless_runtime_tuple_floor "$image_id" "$runtime_release"
  # MAJOR 1:**先** Caddy 摘 matcher + 默认回旧 slot(aborting 态 default→old)+ reload + verify_routing 断言,
  #         **再** CAS desired 收回 —— 消"CAS desired 先收回(candidate 失去 leader/VIP)但 Caddy 仍把公共流量
  #         全落 candidate"的短窗。caddy_render_reload(--apply)内含 verify_routing;失败即中止,绝不带此窗收 desired。
  #         幂等,总是执行(resume 也要确保路由已回 old 才继续)。
  caddy_render_reload || {
    echo "✗ Caddy 摘 matcher/默认回旧 slot($old)失败(reload/verify 未过)。中止 abort:绝不在公共流量仍落 candidate 时收回 desired(会造成 candidate 无 leader/VIP 却仍收全部流量)。停在 phase=aborting,人工介入。" >&2
    exit 1
  }
  # ② CAS desired_*=old(旧 master 重竞 lease/VIP)——guard -lt 2(resume 已收回则不回退)。此刻 Caddy 已先回 old。
  if [[ "$DRY" == 1 || "$DS_transition_step" -lt 2 ]]; then
    echo "── ② CAS desired_*=old($old)(旧 master 重竞 lease/VIP;Caddy 已先摘 matcher + 默认回 $old)──"
    ds_cas_or_die "desired_leader_slot='$old', desired_control_slot='$old', transition_step=2" 2 "desired_* → old slot $old (reclaim lease/VIP; caddy already reverted first)"
  fi
  # BLOCKER 5④+⑤:有界轮询等旧 master 重获 leadership+VIP;**未恢复则绝不前滚提交 stable**——停在
  # aborting 告警人工介入(旧 leader 未确认时切流会全停)。取代固定 sleep + 仅告警的旧行为。幂等核验。
  if ! wait_for_slot_leadership "$old" 1 60; then
    echo "✗ 旧 slot($old)60s 内未重获 leadership=leader+VIP owner(lease/VIP 未回)。" >&2
    echo "  绝不在旧 leader 未确认时停 candidate/提交 stable(会全停)。停在 phase=aborting,人工介入:" >&2
    echo "  核查旧 slot lease 竞争 / desired 是否已=$old / 旧 unit 是否健康;修复后重跑 deploy-v5.sh --abort(或 --recover)。" >&2
    exit 1
  fi
  # candidate 仍保持运行、phase 仍为 aborting 时先做完整旧 active smoke。任何不变量失败都
  # 停在可恢复态并返回非零，绝不吞错后停 candidate / commit stable。
  if [[ "$DRY" != 1 ]] && ! smoke "$(slot_port "$old")"; then
    echo "✗ 旧 slot($old)完整 smoke 未过；保持 phase=aborting 且 candidate 继续运行，人工修复后重跑 --abort/--recover" >&2
    exit 1
  fi
  # ③ stop candidate unit(仅在旧 slot 已确认 leader+VIP 后)——guard -lt 3
  if [[ "$DRY" == 1 || "$DS_transition_step" -lt 3 ]]; then
    echo "── ③ stop candidate unit $(slot_unit "$cand")──"
    sshk "systemctl stop $(slot_unit "$cand") 2>/dev/null || true"
    # 只清本 operation 产物(未激活 symlink);HOME 绝不递归删(§8 R4)
    sshk "rm -f '$csrc.newlink.'* 2>/dev/null || true"
    ds_cas_or_die "transition_step=3" 3 "candidate unit $cand stopped"
  fi
  # ④ CAS phase=stable,candidate_*=NULL,percent=0(cookie 靠 generation 不匹配自动失效)——guard -lt 4
  if [[ "$DRY" == 1 || "$DS_transition_step" -lt 4 ]]; then
    ds_cas_or_die "phase='stable', candidate_slot=NULL, candidate_release=NULL, cohort_percent=0, transition_step=0, operation_id=NULL" 4 "abort commit → stable (old active=$old)"
  fi
  rollback_egress_transition_for_generation "$DS_generation" || return 1
  echo "✓ --abort 完成:回退到旧 active_slot=$old;candidate=$cand 已停。cohort cookie 靠 generation 失配自动失效。"
}

# ═════════ --recover:崩溃重跑,按 (phase, transition_step) 走 §8 恢复矩阵 ═════════
recover() {
  echo "══ v5 --recover(按 §8 恢复矩阵从 (phase, transition_step) 续作)══"
  ds_snapshot
  local p="$DS_phase" s="$DS_transition_step" cand="${DS_candidate_slot:-}" old="$DS_active_slot"
  OP="${DS_operation_id:-p3-recover-$$}"
  echo "  · 当前 (phase=$p, step=$s, candidate=${cand:-<none>}, active=$old)"
  if [[ "$p" != stable ]]; then
    require_mutation_lease_for_compensation "recover-entry" || exit 86
  fi
  case "$p" in
    stable)
      echo "  · phase=stable:检查是否有 master 已提交但 egress 尚待激活的 durable transition。"
      finalize_ready_egress_transition ;;
    canary)
      if [[ "$s" -lt "$DS_STEP_CANARY_READY" ]]; then
        echo "  · canary<READY(准备期,candidate 对流量不可见)→ §8:stop/清本 operation 产物 → 回 stable(零影响)"
        if [[ -n "$cand" ]]; then
          recover_canary_prep "$cand"
        else
          ds_cas_or_die "phase='stable', transition_step=0, operation_id=NULL" 0 "recover canary<READY (no candidate) → stable"
        fi
      else
        echo "  · canary≥READY:先收敛可能遗留的 testing egress transition，再由 operator 裁决"
        if ! reconcile_testing_egress_transition "$DS_generation"; then
          echo "✗ testing egress recovery failed；第一动作=官方 abort" >&2
          abort
          exit 1
        fi
        echo "  · §8=candidate 死则重启 unit 或 --abort;活则继续 --promote/--finalize(operator 裁决)"
        [[ -n "$cand" ]] && candidate_self_check "$cand" || true
        echo "  → 请据 candidate 健康决定:deploy-v5.sh --promote=<pct> / --finalize / --abort"
      fi ;;
    finalizing)
      # BLOCKER 4:--recover 对 finalizing **直接调用 finalize()**(它按 (phase,step) 逐步核验外部事实
      # 后从断点前滚),而非仅打印提示。前滚优先(§8);若 candidate 异常,step5 四门槛会失败并自动
      # 补偿转 aborting(先起旧 unit 核验健康再切回),故前滚是安全的自愈默认。
      if [[ "$s" -le 1 ]]; then
        echo "  · finalizing 0-1(默认流量仍在 active,安全)→ §8:前滚续作(或人工 --abort 零损回退)"
      elif [[ "$s" -le 3 ]]; then
        echo "  · finalizing 2-3(默认已在 candidate,desired 仍旧)→ §8:前滚续作(旧 slot 仍健康,失败可 --abort)"
      elif [[ "$s" -le 5 ]]; then
        echo "  · finalizing 4-5(desired 已=candidate,VIP/lease 可能已交接)→ §8:前滚重跑门槛;失败自动 aborting"
      else
        echo "  · finalizing 6(旧 unit 已停)→ §8:前滚优先,直达 step7 完成"
      fi
      echo "  → 自动前滚:finalize() resume from step=$s"
      finalize ;;
    aborting)
      echo "  · aborting(any step)→ §8:旧 slot 未确认健康则先恢复旧 unit;确认→按 abort ①→④ 幂等续作"
      abort ;;
    *)
      echo "✗ 未知 phase=$p,人工介入" >&2; exit 1 ;;
  esac
}

close_mutation_lane_inherited_locks() {
  exec 8>&- 9>&-
  if [[ -n "${OC_V5_DEPLOY_LOCK_FD:-}" && "${OC_V5_DEPLOY_LOCK_FD}" =~ ^[0-9]+$ ]]; then
    eval "exec ${OC_V5_DEPLOY_LOCK_FD}>&-"
  fi
}

hard_stop_mutation_lane_group() { # lease is lost/unknown: no TERM grace
  local i signalled=0
  if [[ -n "$MUTATION_LANE_PGID" ]] && {
      same_process_identity "$MUTATION_LANE_PID" "$MUTATION_LANE_START" \
        || same_process_identity "$MUTATION_LANE_ANCHOR_PID" "$MUTATION_LANE_ANCHOR_START"
    }; then
    kill -KILL -- "-$MUTATION_LANE_PGID" 2>/dev/null || true
    signalled=1
  elif [[ -n "$MUTATION_LANE_PID" ]] \
      && same_process_identity "$MUTATION_LANE_PID" "$MUTATION_LANE_START"; then
    kill -KILL "$MUTATION_LANE_PID" 2>/dev/null || true
    signalled=1
  else
    echo "FATAL:mutation lane leader identity 已消失；拒绝向可能复用的 PGID=$MUTATION_LANE_PGID 发信号" >&2
  fi
  if [[ "$signalled" == 1 ]]; then
    for i in $(seq 1 20); do
      process_group_has_live_members "$MUTATION_LANE_PGID" || break
      sleep 0.05
    done
  fi
  if [[ -n "$MUTATION_LANE_PID" ]] \
      && ! same_live_process "$MUTATION_LANE_PID" "$MUTATION_LANE_START"; then
    # Zombie/gone leaders are safe to reap without blocking. A KILL-pending
    # D-state leader must never wedge the supervisor in wait(2); outer exit will
    # reparent it and the durable in-flight marker remains.
    wait "$MUTATION_LANE_PID" 2>/dev/null || true
  fi
  # KILL-pending D-state tasks cannot return to userspace to mutate; keep the marker.
  [[ "$signalled" == 1 ]] && process_group_has_live_members "$MUTATION_LANE_PGID" \
    && echo "FATAL:mutation lane PGID=$MUTATION_LANE_PGID 仍有 KILL-pending 进程；保留 in-flight marker" >&2
  return 0
}

stop_mutation_lane_watchdog() {
  local i incomplete=0
  if [[ -n "$MUTATION_LANE_WATCH_PID" && -n "$MUTATION_LANE_WATCH_START" ]] \
      && same_live_process "$MUTATION_LANE_WATCH_PID" "$MUTATION_LANE_WATCH_START"; then
    if [[ "$MUTATION_LANE_WATCH_PGID" == "$MUTATION_LANE_WATCH_PID" ]]; then
      kill -TERM -- "-$MUTATION_LANE_WATCH_PGID" 2>/dev/null || true
      for i in $(seq 1 20); do
        process_group_has_live_members "$MUTATION_LANE_WATCH_PGID" || break
        sleep 0.05
      done
      process_group_has_live_members "$MUTATION_LANE_WATCH_PGID" \
        && kill -KILL -- "-$MUTATION_LANE_WATCH_PGID" 2>/dev/null || true
    else
      terminate_exact_process "$MUTATION_LANE_WATCH_PID" "$MUTATION_LANE_WATCH_START"
    fi
  fi
  if [[ -n "$MUTATION_LANE_WATCH_PGID" ]] \
      && process_group_has_live_members "$MUTATION_LANE_WATCH_PGID"; then
    incomplete=1
  fi
  if [[ -n "$MUTATION_LANE_WATCH_PID" ]]; then
    if same_live_process "$MUTATION_LANE_WATCH_PID" "$MUTATION_LANE_WATCH_START"; then
      incomplete=1
    else
      wait "$MUTATION_LANE_WATCH_PID" 2>/dev/null || true
    fi
  fi
  if [[ "$incomplete" == 1 ]]; then
    echo "FATAL:mutation watchdog 仍为 KILL-pending；不阻塞 wait，保留 identity/state" >&2
    return 1
  fi
  MUTATION_LANE_WATCH_PID=""; MUTATION_LANE_WATCH_START=""; MUTATION_LANE_WATCH_PGID=""
  return 0
}

reset_mutation_lane_runtime() {
  stop_mutation_lane_watchdog || return 86
  [[ -n "$MUTATION_LANE_STATE_DIR" ]] && rm -rf -- "$MUTATION_LANE_STATE_DIR"
  MUTATION_LANE_PID=""; MUTATION_LANE_START=""; MUTATION_LANE_PGID=""
  MUTATION_LANE_ANCHOR_PID=""; MUTATION_LANE_ANCHOR_START=""; MUTATION_LANE_STATE_DIR=""
  return 0
}

mutation_lane_payload_cleanup() {
  local rc=$?
  trap - EXIT INT TERM HUP
  set +e
  # Payload owns PLANNED_MAINTENANCE_* state. Signal/crash/lease-loss exits skip
  # all mutation cleanup. Controlled exits may clear only that exact nonce while
  # the parent concurrently supervises the lease. The durable in-flight marker
  # is intentionally left for the two-phase parent/leader handshake below.
  if (( rc < 128 )) && [[ "$rc" != 86 ]] && mutation_lease_live; then
    if [[ "$PLANNED_MAINTENANCE_ACTIVE" == 1 ]]; then
      end_planned_maintenance || rc=1
    fi
    mutation_lease_live || rc=86
  else
    echo "FATAL:mutation payload 非受控退出/lease loss(rc=$rc)；跳过 planned-maintenance cleanup" >&2
    rc=86
  fi
  exit "$rc"
}

run_mutation_lane_supervised() { # <function> [args...]
  local lane_fn="$1" outer_pid="$$" outer_start monitor_was_on=0
  local gate ready done authorize anchor_ready anchor_release anchor_wait completed="" event_rc=0 lane_rc=0 i
  shift
  if [[ "$DRY" == 1 || "$MUTATION_LEASE_BYPASSED" == 1 ]]; then
    "$lane_fn" "$@"
    return $?
  fi
  mutation_lease_live || { echo "FATAL:mutation lane 启动前 lease 已失活" >&2; return 86; }
  arm_mutation_lane_inflight || return 3
  mutation_lease_live || { echo "FATAL:预置 in-flight marker 后 lease 已失活；拒绝启动 lane" >&2; return 86; }
  outer_start="$(process_start_time "$outer_pid")" || return 86
  MUTATION_LANE_STATE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/oc-v5-mutation-lane.XXXXXX")" || return 86
  gate="$MUTATION_LANE_STATE_DIR/go"
  ready="$MUTATION_LANE_STATE_DIR/watchdog-ready"
  done="$MUTATION_LANE_STATE_DIR/payload-done"
  authorize="$MUTATION_LANE_STATE_DIR/authorize-clear"
  anchor_ready="$MUTATION_LANE_STATE_DIR/anchor-ready"
  anchor_release="$MUTATION_LANE_STATE_DIR/anchor-release"
  anchor_wait="$MUTATION_LANE_STATE_DIR/anchor-wait"
  MUTATION_LANE_ANCHOR_PID=""; MUTATION_LANE_ANCHOR_START=""
  if ! mkfifo -m 600 "$anchor_wait"; then
    echo "FATAL:无法创建 mutation lane sentinel wait FIFO；保留 in-flight marker" >&2
    reset_mutation_lane_runtime || true
    return 86
  fi

  [[ $- == *m* ]] && monitor_was_on=1
  set -m
  (
    trap - EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    trap 'exit 129' HUP
    set +m
    # 独立 sentinel 与 payload leader 同 PGID，但不执行 mutation。它在 phase1
    # 持续锚定 PGID：即使 Bash 抢先 reap leader，parent/watchdog 仍可证明该
    # numeric PGID 未复用并安全 KILL 整组。watchdog ready 前它自行监 outer/lease，
    # 且关闭继承锁，避免极早期 outer SIGKILL 留下锁泄漏。
    (
      trap - EXIT
      trap 'exit 0' INT TERM HUP
      close_mutation_lane_inherited_locks
      exec 7<>"$anchor_wait" || exit 86
      while [[ ! -e "$anchor_release" ]]; do
        if [[ ! -e "$ready" ]]; then
          same_live_process "$outer_pid" "$outer_start" || exit 137
          mutation_lease_live || exit 86
        fi
        # Bash builtin timed read: unlike external sleep, this creates no
        # same-PGID child that could pollute the phase1 descendant census.
        read -r -t 0.02 -u 7 _ || true
      done
    ) &
    anchor_pid=$!
    anchor_start="$(process_start_time "$anchor_pid")" || {
      kill -KILL "$anchor_pid" 2>/dev/null || true
      exit 86
    }
    printf '%s %s\n' "$anchor_pid" "$anchor_start" >"${anchor_ready}.tmp.$BASHPID"
    mv -f "${anchor_ready}.tmp.$BASHPID" "$anchor_ready"
    while [[ ! -e "$gate" ]]; do
      same_live_process "$outer_pid" "$outer_start" || exit 137
      mutation_lease_live || exit 86
      sleep 0.02
    done
    # Never call the payload in an if/|| context: Bash propagates conditional
    # errexit suppression into functions. This nested, non-conditional subshell
    # explicitly restores -Eeuo so a naked failure cannot run later mutations.
    set +e
    (
      trap mutation_lane_payload_cleanup EXIT
      trap 'exit 130' INT
      trap 'exit 143' TERM
      trap 'exit 129' HUP
      set -Eeuo pipefail
      "$lane_fn" "$@"
    )
    lane_rc=$?
    set -e
    if [[ "$lane_rc" == 86 || "$lane_rc" -ge 128 ]]; then exit 86; fi
    printf '%s\n' "$lane_rc" >"${done}.tmp.$BASHPID"
    mv -f "${done}.tmp.$BASHPID" "$done"
    while [[ ! -e "$authorize" ]]; do
      same_live_process "$outer_pid" "$outer_start" || exit 86
      mutation_lease_live || exit 86
      sleep 0.02
    done
    same_live_process "$outer_pid" "$outer_start" || exit 86
    mutation_lease_live || exit 86
    same_live_process "$anchor_pid" "$anchor_start" || exit 86
    clear_mutation_lane_inflight_exact || exit 1
    # The sentinel must outlive every child-spawning mutation. In particular,
    # clear_mutation_lane_inflight_exact uses ssh; releasing the PGID anchor
    # before that child returns would let a killed/reaped leader strand an
    # unfenced clear process. These are the final local actions before exit.
    : >"$anchor_release" || exit 86
    anchor_released=0
    for i in $(seq 1 100); do
      if ! same_live_process "$anchor_pid" "$anchor_start"; then
        anchor_released=1
        break
      fi
      same_live_process "$outer_pid" "$outer_start" || exit 86
      mutation_lease_live || exit 86
      sleep 0.02
    done
    [[ "$anchor_released" == 1 ]] || exit 86
    wait "$anchor_pid" 2>/dev/null || true
    exit "$lane_rc"
  ) &
  MUTATION_LANE_PID=$!
  MUTATION_LANE_START="$(process_start_time "$MUTATION_LANE_PID")" || {
    kill -KILL "$MUTATION_LANE_PID" 2>/dev/null || true
    MUTATION_LANE_PID=""
    [[ "$monitor_was_on" == 1 ]] || set +m
    reset_mutation_lane_runtime || true
    return 86
  }
  MUTATION_LANE_PGID="$(ps -o pgid= -p "$MUTATION_LANE_PID" 2>/dev/null | tr -d '[:space:]')"
  if [[ "$MUTATION_LANE_PGID" != "$MUTATION_LANE_PID" ]]; then
    echo "FATAL:mutation lane 未隔离为独立 PGID(pid=$MUTATION_LANE_PID pgid=${MUTATION_LANE_PGID:-missing})" >&2
    hard_stop_mutation_lane_group
    [[ "$monitor_was_on" == 1 ]] || set +m
    reset_mutation_lane_runtime || true
    return 86
  fi
  for i in $(seq 1 100); do
    [[ -e "$anchor_ready" ]] && break
    same_live_process "$MUTATION_LANE_PID" "$MUTATION_LANE_START" || break
    sleep 0.02
  done
  read -r MUTATION_LANE_ANCHOR_PID MUTATION_LANE_ANCHOR_START <"$anchor_ready" 2>/dev/null || true
  if ! { [[ "$MUTATION_LANE_ANCHOR_PID" =~ ^[1-9][0-9]*$ \
        && "$MUTATION_LANE_ANCHOR_START" =~ ^[1-9][0-9]*$ ]] \
      && same_process_identity "$MUTATION_LANE_ANCHOR_PID" "$MUTATION_LANE_ANCHOR_START" \
      && [[ "$(ps -o pgid= -p "$MUTATION_LANE_ANCHOR_PID" 2>/dev/null | tr -d '[:space:]')" == "$MUTATION_LANE_PGID" ]]; }; then
    echo "FATAL:mutation lane PGID sentinel 未就绪/身份不匹配；拒绝开放 gate" >&2
    hard_stop_mutation_lane_group
    [[ "$monitor_was_on" == 1 ]] || set +m
    reset_mutation_lane_runtime || true
    return 86
  fi

  # Independent-PGID sibling survives outer process-group SIGKILL and a stopped
  # outer supervisor. Gate is opened only after this watcher has closed inherited
  # lock FDs and published readiness. Any exact outer/holder/local-TTL loss KILLs
  # the entire lane group first, then terminates remaining lease identities; no
  # cleanup/rollback runs without lease and the pre-armed marker remains.
  (
    trap - EXIT
    trap 'exit 0' INT TERM HUP
    set +m
    close_mutation_lane_inherited_locks
    : >"$ready"
    while same_supervised_process "$outer_pid" "$outer_start" \
        && same_supervised_process "$MUTATION_LEASE_PID" "$MUTATION_LEASE_START" \
        && same_supervised_process "$MUTATION_LEASE_TTL_PID" "$MUTATION_LEASE_TTL_START" \
        && { [[ -e "$anchor_release" ]] \
          || same_supervised_process "$MUTATION_LANE_ANCHOR_PID" "$MUTATION_LANE_ANCHOR_START"; }; do
      sleep 0.02
    done
    if same_process_identity "$MUTATION_LANE_PID" "$MUTATION_LANE_START" \
        || same_process_identity "$MUTATION_LANE_ANCHOR_PID" "$MUTATION_LANE_ANCHOR_START"; then
      kill -KILL -- "-$MUTATION_LANE_PGID" 2>/dev/null || true
    fi
    for i in $(seq 1 20); do
      process_group_has_live_members "$MUTATION_LANE_PGID" || break
      sleep 0.05
    done
    terminate_exact_process "$MUTATION_LEASE_PID" "$MUTATION_LEASE_START"
    terminate_exact_process "$MUTATION_LEASE_TTL_PID" "$MUTATION_LEASE_TTL_START"
    rm -rf -- "$MUTATION_LANE_STATE_DIR"
  ) &
  MUTATION_LANE_WATCH_PID=$!
  MUTATION_LANE_WATCH_START="$(process_start_time "$MUTATION_LANE_WATCH_PID")" || {
    kill -KILL "$MUTATION_LANE_WATCH_PID" 2>/dev/null || true
    MUTATION_LANE_WATCH_PID=""
    [[ "$monitor_was_on" == 1 ]] || set +m
    hard_stop_mutation_lane_group; reset_mutation_lane_runtime || true; return 86
  }
  MUTATION_LANE_WATCH_PGID="$(ps -o pgid= -p "$MUTATION_LANE_WATCH_PID" 2>/dev/null | tr -d '[:space:]')"
  if [[ "$MUTATION_LANE_WATCH_PGID" != "$MUTATION_LANE_WATCH_PID" ]]; then
    echo "FATAL:mutation watchdog 未隔离为独立 PGID(pid=$MUTATION_LANE_WATCH_PID pgid=${MUTATION_LANE_WATCH_PGID:-missing})" >&2
    terminate_exact_process "$MUTATION_LANE_WATCH_PID" "$MUTATION_LANE_WATCH_START"
    [[ "$monitor_was_on" == 1 ]] || set +m
    hard_stop_mutation_lane_group; reset_mutation_lane_runtime || true; return 86
  fi
  [[ "$monitor_was_on" == 1 ]] || set +m
  for i in $(seq 1 100); do
    [[ -e "$ready" ]] && break
    same_live_process "$MUTATION_LANE_WATCH_PID" "$MUTATION_LANE_WATCH_START" || break
    sleep 0.02
  done
  if [[ ! -e "$ready" ]] || ! same_live_process "$outer_pid" "$outer_start" \
      || ! same_live_process "$MUTATION_LANE_WATCH_PID" "$MUTATION_LANE_WATCH_START" \
      || ! mutation_lease_live; then
    echo "FATAL:mutation lane gate 前 supervisor/lease 不完整；crash-stop" >&2
    hard_stop_mutation_lane_group
    reset_mutation_lane_runtime || true
    return 86
  fi
  : >"$gate"

  # Phase 1: payload finishes but the lane leader waits for a plain authorize file.
  # Parent can now prove there are no live descendants while the durable marker
  # still exists. Any holder/TTL/watchdog/leader loss before authorization is a
  # crash-stop and therefore cannot create a marker-clear gap.
  while [[ ! -e "$done" ]]; do
    if ! mutation_lease_live; then
      echo "FATAL:production-mutation lease/本地 TTL 在 payload 期间失活；立即 KILL lane PGID" >&2
      hard_stop_mutation_lane_group
      reset_mutation_lane_runtime || true
      return 86
    fi
    if ! same_live_process "$MUTATION_LANE_WATCH_PID" "$MUTATION_LANE_WATCH_START"; then
      echo "FATAL:mutation lane parent watchdog 在 payload 期间退出；fail-closed" >&2
      hard_stop_mutation_lane_group
      reset_mutation_lane_runtime || true
      return 86
    fi
    if [[ -e "$anchor_release" ]] \
        || ! same_live_process "$MUTATION_LANE_ANCHOR_PID" "$MUTATION_LANE_ANCHOR_START"; then
      echo "FATAL:mutation lane PGID sentinel 在 payload 期间提前释放/退出；fail-closed" >&2
      hard_stop_mutation_lane_group
      reset_mutation_lane_runtime || true
      return 86
    fi
    if ! same_live_process "$MUTATION_LANE_PID" "$MUTATION_LANE_START"; then
      # Keep the recorded PGID occupied until hard_stop signals/reaps it; waiting
      # first would create an avoidable PID/PGID reuse window.
      echo "FATAL:mutation lane leader 在 payload-done 前退出；保留 in-flight marker" >&2
      hard_stop_mutation_lane_group
      reset_mutation_lane_runtime || true
      return 86
    fi
    sleep 0.05
  done
  lane_rc="$(cat "$done" 2>/dev/null || true)"
  [[ "$lane_rc" =~ ^[0-9]+$ && "$lane_rc" -lt 128 && "$lane_rc" != 86 ]] || {
    echo "FATAL:payload completion rc 非法:$lane_rc" >&2
    hard_stop_mutation_lane_group
    reset_mutation_lane_runtime || true
    return 86
  }
  # Freeze the exact leader before proving its group empty. This lets its current
  # 20ms polling sleep drain, while persistent payload descendants remain visible.
  # A plain file authorization is nonblocking, so leader death can never wedge the
  # parent in a FIFO open while lease supervision is paused.
  same_live_process "$MUTATION_LANE_PID" "$MUTATION_LANE_START" \
    && kill -STOP "$MUTATION_LANE_PID" 2>/dev/null || {
      echo "FATAL:payload-done 后无法 STOP exact lane leader" >&2
      hard_stop_mutation_lane_group
      reset_mutation_lane_runtime || true
      return 86
    }
  local group_quiet=0
  for i in $(seq 1 100); do
    if ! mutation_lease_live \
        || ! same_live_process "$MUTATION_LANE_WATCH_PID" "$MUTATION_LANE_WATCH_START" \
        || ! same_live_process "$MUTATION_LANE_PID" "$MUTATION_LANE_START" \
        || ! same_live_process "$MUTATION_LANE_ANCHOR_PID" "$MUTATION_LANE_ANCHOR_START" \
        || [[ -e "$anchor_release" ]]; then
      break
    fi
    if ! process_group_has_live_members_except_two "$MUTATION_LANE_PGID" \
        "$MUTATION_LANE_PID" "$MUTATION_LANE_ANCHOR_PID"; then
      group_quiet=1
      break
    fi
    sleep 0.02
  done
  if [[ "$group_quiet" != 1 ]]; then
    echo "FATAL:payload 返回后 lane PGID 仍有 descendants；KILL 并保留 in-flight marker" >&2
    hard_stop_mutation_lane_group
    reset_mutation_lane_runtime || true
    return 86
  fi
  if ! mutation_lease_live \
      || ! same_live_process "$MUTATION_LANE_WATCH_PID" "$MUTATION_LANE_WATCH_START" \
      || ! same_live_process "$MUTATION_LANE_PID" "$MUTATION_LANE_START" \
      || ! same_live_process "$MUTATION_LANE_ANCHOR_PID" "$MUTATION_LANE_ANCHOR_START" \
      || [[ -e "$anchor_release" ]]; then
    echo "FATAL:marker-clear 授权前 lease/watchdog/sentinel 条件失活；保留 in-flight marker" >&2
    hard_stop_mutation_lane_group
    reset_mutation_lane_runtime || true
    return 86
  fi
  : >"$authorize"
  same_live_process "$MUTATION_LANE_PID" "$MUTATION_LANE_START" \
    && kill -CONT "$MUTATION_LANE_PID" 2>/dev/null || {
      echo "FATAL:marker-clear authorize 后 exact lane leader 已失活" >&2
      hard_stop_mutation_lane_group
      reset_mutation_lane_runtime || true
      return 86
    }

  # Phase 2: leader performs exact marker clear while the non-mutating sentinel
  # continues to anchor this PGID. Only after the clear ssh child has returned
  # does the leader release/reap the sentinel and exit. Continue racing both
  # identities against ssh/TTL/outer-watchdog.
  if wait -n -p completed "$MUTATION_LANE_PID" "$MUTATION_LEASE_PID" \
      "$MUTATION_LEASE_TTL_PID" "$MUTATION_LANE_WATCH_PID"; then
    event_rc=0
  else
    event_rc=$?
  fi
  if [[ "$completed" == "$MUTATION_LANE_PID" ]]; then
    lane_rc="$event_rc"
    if same_process_identity "$MUTATION_LANE_ANCHOR_PID" "$MUTATION_LANE_ANCHOR_START"; then
      echo "FATAL:lane leader 已退出但 PGID sentinel 未受控回收；crash-stop 并保留 in-flight marker" >&2
      hard_stop_mutation_lane_group
      reset_mutation_lane_runtime || true
      return 86
    fi
    # wait-n 已回收 exact leader；立即丢弃 raw PID/PGID，确保后续任一
    # reset/EXIT 失败路径都不可能向复用后的无关进程组发信号。
    MUTATION_LANE_PID=""; MUTATION_LANE_START=""; MUTATION_LANE_PGID=""
    MUTATION_LANE_ANCHOR_PID=""; MUTATION_LANE_ANCHOR_START=""
    if ! mutation_lease_live \
        || ! same_live_process "$MUTATION_LANE_WATCH_PID" "$MUTATION_LANE_WATCH_START"; then
      echo "FATAL:lane 与 lease/watchdog 同时退出；按 lease loss 裁决" >&2
      # wait-n 已回收 lane leader；授权前已证明无 descendants，禁止再向旧
      # numeric PGID 发信号（可能已被无关进程组复用）。
      reset_mutation_lane_runtime || true
      return 86
    fi
    # wait -n 已回收 leader，旧 numeric PGID 此刻不再是可安全发信号的
    # identity。授权前已证明 group 只剩 leader；授权后固定代码仅同步 clear
    # marker，不会留下后台 descendant，因此这里禁止再 probe/kill 旧 PGID。
    if [[ "$lane_rc" == 86 || "$lane_rc" -ge 128 ]]; then
      echo "FATAL:mutation lane crash-stop rc=$lane_rc；保留 in-flight marker" >&2
      reset_mutation_lane_runtime || true
      return 86
    fi
    if ! mutation_lane_inflight_absent; then
      echo "FATAL:受控 lane 退出但 exact in-flight clear 未确认；保留标记" >&2
      reset_mutation_lane_runtime || return 86
      return 1
    fi
    MUTATION_LANE_INFLIGHT_ACTIVE=0; MUTATION_LANE_INFLIGHT_NONCE=""
    reset_mutation_lane_runtime || return 86
    return "$lane_rc"
  fi

  if [[ "$completed" == "$MUTATION_LEASE_PID" ]]; then
    echo "FATAL:production-mutation ssh holder 先退出；立即 KILL lane PGID，禁止补偿" >&2
  elif [[ "$completed" == "$MUTATION_LEASE_TTL_PID" ]]; then
    echo "FATAL:production-mutation 本地安全 TTL 到点；立即 KILL lane PGID" >&2
  elif [[ "$completed" == "$MUTATION_LANE_WATCH_PID" ]]; then
    echo "FATAL:mutation lane parent watchdog 意外退出；fail-closed KILL lane PGID" >&2
  else
    echo "FATAL:mutation lane supervisor 无法裁决首退进程；fail-closed" >&2
  fi
  hard_stop_mutation_lane_group
  reset_mutation_lane_runtime || true
  return 86
}

run_selected_mode() { # [mode]
  local selected_mode="${1:-$MODE}"
  case "$selected_mode" in
    bootstrap) bootstrap ;;
    migrate-bluegreen) migrate_to_bluegreen ;;
    smoke)     resolve_active_lane; smoke "$ACTIVE_PORT" ;;
    knowledge-planet-verify) knowledge_planet_plugin_verify_user ;;
    baseline-census) run_ccb_baseline_remount census ;;
    baseline-remount) run_ccb_baseline_remount remount ;;
    install-monitor) install_v5_host_monitor ;;
    deploy)    deploy ;;
    dist)      deploy_dist ;;
    model-authority-preflight) model_authority_preflight ;;
    enable-model-authority)    enable_model_authority ;;
    disable-model-authority)   disable_model_authority ;;
    model-authority-observation-status) model_authority_observation_status ;;
    enable-seed-authority-by-rev) enable_seed_authority_by_rev ;;
    record-model-authority-emergency-drill) record_model_authority_emergency_drill ;;
    model-authority-cutover)   model_authority_cutover ;;
    enable-runtime-tape-batching) enable_runtime_tape_batching ;;
    emergency-tuple) emergency_tuple ;;
    activate-emergency-tuple) activate_emergency_tuple ;;
    prepare-offline-cutover) assert_not_bluegreen_for_cutover; prepare_offline_cutover ;;
    offline-recycle) assert_not_bluegreen_for_cutover; offline_recycle ;;
    stage)     assert_not_bluegreen_for_cutover; stage ;;
    activate-staged) assert_not_bluegreen_for_cutover; activate_staged ;;
    rollback)  rollback ;;
    reclaim-mutation-lease) reclaim_production_mutation_lease ;;
    canary)    canary ;;
    promote)   promote ;;
    finalize)  finalize ;;
    abort)     abort ;;
    recover)   recover ;;
    authorize-emergency) record_emergency_authorization ;;
    close-emergency-debt) close_emergency_debt ;;
    publish-luna) set_luna_visibility public ;;
    hide-luna) set_luna_visibility hidden ;;
    *) echo "✗ 未知 mode:$selected_mode" >&2; return 2 ;;
  esac
}

# 开发发布队列是生命周期锁；本地 deploy flock 是单条命令锁。除只读、恢复/回退和
# emergency 授权关账外，所有当前及未来写 mode 默认 fail-closed 要求 active+pinned 队列项。
release_queue_required_for_mode() { # <mode>; 0=required, 1=exempt
  case "$1" in
    smoke|baseline-census|model-authority-preflight|model-authority-observation-status)
      return 1 ;;
    abort|rollback|recover|reclaim-mutation-lease|hide-luna)
      return 1 ;;
    authorize-emergency|close-emergency-debt)
      return 1 ;;
    *)
      return 0 ;;
  esac
}

assert_selfheal_release_identity() {
  local rrid="${OC_V5_SELFHEAL_RELEASE_REQUEST_ID:-}"
  local db="${OC_V5_SELFHEAL_DB:-/root/.openclaude/selfheal.db}"
  local cgroup_file="${OC_V5_SELFHEAL_CGROUP_FILE:-/proc/self/cgroup}"
  local row status approved_sha scope_unit current_head
  [[ -n "$rrid" && "$rrid" =~ ^[A-Za-z0-9._:@+-]+$ ]] || {
    echo "✗ 继承部署锁缺少合法 OC_V5_SELFHEAL_RELEASE_REQUEST_ID；禁止旁路开发发布队列" >&2
    return 1
  }
  [[ -r "$db" ]] || {
    echo "✗ selfheal release ledger 不可读:$db" >&2
    return 1
  }
  row="$(sqlite3 -noheader "$db" \
    "SELECT status || '|' || approved_sha || '|' || coalesce(scope_unit,'')
       FROM selfheal_release_jobs
      WHERE release_request_id='${rrid//\'/\'\'}'
      LIMIT 1;" 2>/dev/null || true)"
  IFS='|' read -r status approved_sha scope_unit <<<"$row"
  current_head="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)"
  [[ "$status" == deploying && "$approved_sha" =~ ^[0-9a-f]{40}$ \
      && "$approved_sha" == "$current_head" && -n "$scope_unit" ]] || {
    echo "✗ selfheal release identity 与 deploying ledger/canonical HEAD 不一致(rrid=$rrid status=${status:-missing} approved=${approved_sha:-missing} head=${current_head:-missing} scope=${scope_unit:-missing})" >&2
    return 1
  }
  [[ -r "$cgroup_file" ]] || {
    echo "✗ 无法读取当前 selfheal scope cgroup:$cgroup_file" >&2
    return 1
  }
  grep -Fq "/${scope_unit}.scope" "$cgroup_file" || {
    echo "✗ 当前进程不属于 ledger 钉死的 selfheal scope:${scope_unit}.scope" >&2
    return 1
  }
  echo "  ✓ selfheal release identity 已由 ledger+canonical SHA+cgroup scope 证明(rrid=$rrid)"
}

assert_development_release_queue() {
  [[ "$DRY" == 1 ]] && return 0
  release_queue_required_for_mode "$MODE" || return 0
  if [[ -n "${OC_V5_DEPLOY_LOCK_FD:-}" ]]; then
    # 继承 fd 只用于 selfheal release lane。上方真锁 fdinfo 验证通过后，还必须把
    # durable rrid、approved SHA 与当前 systemd scope 三面钉死，不能用布尔 env 伪造旁路。
    assert_selfheal_release_identity
    return
  fi
  "$RELEASE_QUEUE_SCRIPT" assert --id "${OC_V5_RELEASE_QUEUE_ID:-}"
}

# ── 全局部署互斥(硬机制,2026-07-10 boss 指令:多会话并发改 v5 不靠记忆自觉)──
# 同机所有 deploy-v5.sh 写模式实例串行:并发 rsync/restart 交错会产生半新半旧源码树
# 与连环重启。锁文件记录持有者(pid/mode/tree/时刻)供另一会话诊断;等待 ≤900s 后
# fail-loud。只读模式(--dry-run / --smoke)不抢锁。cutover 自有的 CUTOVER_LOCK 是
# 远端状态机锁,与本地这把互斥锁正交,两把都要。
# 测试 harness 可 source 本文件复用真实编排函数，但必须在任何锁/dispatch 前退出。
if [[ "${V5_DEPLOY_SOURCE_ONLY:-0}" == 1 ]]; then
  if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then return 0; else exit 0; fi
fi
# 锁文件路径:生产恒为全局 /var/lock/oc-v5-deploy.lock(env 不设 → 与旧行为逐字节一致)。
# OC_V5_DEPLOY_LOCK_FILE 仅供**本地 hermetic 测试**注入独立锁文件(与 v5-runtime-release-lib.sh
# 的 OC_HOTCFG_* 根路径同款"自测可覆盖"约定),避免测试去抢真实部署锁而挂死 900s。
DEPLOY_LOCK="${OC_V5_DEPLOY_LOCK_FILE:-/var/lock/oc-v5-deploy.lock}"
KNOWLEDGE_PLANET_VERIFY_LOCK="${OC_V5_KP_VERIFY_LOCK_FILE:-/var/lock/oc-v5-knowledge-planet-verify.lock}"
trap cleanup_deploy_process EXIT
# One verifier at a time. It also takes the global deploy lock below because
# build_release writes the shared immutable-release namespace; the human wait
# therefore cannot race deploy/GC, while ordinary deploy never launches QR.
if [[ "$DRY" != 1 && "$MODE" == "knowledge-planet-verify" ]]; then
  exec 9>"$KNOWLEDGE_PLANET_VERIFY_LOCK"
  if ! flock -n 9; then
    echo "⏳ Knowledge Planet 验证锁被占:$(cat "${KNOWLEDGE_PLANET_VERIFY_LOCK}.holder" 2>/dev/null || echo '持有者未知')"
    flock -w 900 9 || { echo "✗ 900s 未取得 Knowledge Planet 验证锁" >&2; exit 3; }
  fi
  printf 'pid=%s user=%s tree=%s started=%s\n' \
    "$$" "$KNOWLEDGE_PLANET_VERIFY_USER" "$REPO_ROOT" "$(date -Is)" \
    > "${KNOWLEDGE_PLANET_VERIFY_LOCK}.holder"
  KNOWLEDGE_PLANET_VERIFY_HOLDER_OWNED=1
fi
if [[ "$DRY" != 1 && "$MODE" != "smoke" && "$MODE" != "baseline-census" && "$MODE" != "model-authority-preflight" && "$MODE" != "model-authority-observation-status" && "$MODE" != "reclaim-mutation-lease" ]]; then
  # reclaim 是"陈旧锁被同一残留焊死"时的救援入口:必须**不**抢本地 deploy lock(否则会被残留 fd 8 阻塞 900s)。
  if [[ -n "${OC_V5_DEPLOY_LOCK_FD:-}" ]]; then
    # ── 继承锁 FD(RFC-v5-selfheal-batch1b §4.1 锁交接协议 · probe-then-relock)──
    # 自愈 release lane 在任何 canonical mutation 前先 `exec 200>$DEPLOY_LOCK; flock 200` 抢全局锁,
    # 再 `OC_V5_DEPLOY_LOCK_FD=200 bash deploy-v5.sh …` spawn 本脚本。本脚本若自行 `exec 8>` 重开同
    # 一 lock file 会去等**自己已持有**的锁 → 900s 超时假死。故继承路径严格校验后跳过自抢:
    #   ① fd 是整数且 /proc/self/fd/<fd> 已打开;② 与 $DEPLOY_LOCK 同 dev:inode;
    #   ③ **probe-then-relock**:另开一把独立 OFD 的 probe fd 抢 flock -n —— **必须失败**
    #      (失败=确有人/父进程经另一 OFD 持锁);若 probe 竟**成功**=锁本空闲=调用方谎称已持锁 → exit 3;
    #   ④ probe 冲突失败(正常)→ 关闭 probe;⑤ 最后对继承 lock_fd `flock -n`(与父同 OFD,重入幂等)必须成功。
    # 关键 flock 语义:锁绑定在 open file description(OFD)。父经 fd 继承(fork/exec)传下的 lock_fd
    # 与父**共享同一 OFD** → 重入 flock 幂等成功;而 probe 由 `exec {probe_fd}>` 新开=**独立 OFD** →
    # 父确实持锁时 probe 的 flock -n 必冲突失败(即便同进程,独立 OFD 也互斥,见 flock(2))。这正是
    # 用来区分"真持锁 vs 谎称持锁"。旧实现只 `flock -n <lock_fd>`:调用方只 open 未 flock(谎称)时
    # 会**当场取锁成功**而误判继承有效,绕过"必须已持锁"不变量(F6)。
    # **禁任何可伪造布尔 env 旁路(如 LOCK_HELD=1)**——只认真锁事实。
    lock_fd="$OC_V5_DEPLOY_LOCK_FD"
    [[ "$lock_fd" =~ ^[0-9]+$ ]] || { echo "✗ OC_V5_DEPLOY_LOCK_FD 不是整数 fd:'$lock_fd'" >&2; exit 3; }
    [[ -e "/proc/self/fd/$lock_fd" ]] || { echo "✗ 继承锁 fd $lock_fd 未打开(/proc/self/fd/$lock_fd 不存在)" >&2; exit 3; }
    inh_id="$(stat -L -c '%d:%i' "/proc/self/fd/$lock_fd" 2>/dev/null || true)"
    lock_id="$(stat -L -c '%d:%i' "$DEPLOY_LOCK" 2>/dev/null || true)"
    [[ -n "$inh_id" && -n "$lock_id" && "$inh_id" == "$lock_id" ]] || {
      echo "✗ 继承锁 fd $lock_fd 与部署锁 $DEPLOY_LOCK 非同一 inode(fd=[$inh_id] lock=[$lock_id]);拒绝继承" >&2; exit 3; }
    # ③ probe:独立 OFD 抢锁,**必须失败**(证明确有另一 OFD——即父进程——持锁)。
    exec {probe_fd}>"$DEPLOY_LOCK" || { echo "✗ 无法开 probe fd 复核继承锁($DEPLOY_LOCK)" >&2; exit 3; }
    if flock -n "$probe_fd"; then
      # probe 竟当场取到锁 = 锁本空闲 = 调用方只 open 未 flock,谎称已持锁 → 释放 probe 后拒绝。
      flock -u "$probe_fd" 2>/dev/null || true
      exec {probe_fd}>&-
      echo "✗ 继承锁 fd $lock_fd 未真正持有部署锁(独立 probe OFD 当场抢到锁=锁本空闲=调用方谎称已持锁;须在**抢到锁后**再 spawn 本脚本)" >&2
      exit 3
    fi
    # ④ probe 冲突失败(正常路径)→ 关闭 probe fd(确有他人持锁)。
    exec {probe_fd}>&-
    # ⑤ 继承 fd 归属证明(R2-5:消 probe→relock 残留 TOCTOU · per-fd FLOCK 事实)。
    #   残留 TOCTOU:probe 只证明"锁被某 OFD 持有";若真持有者恰在 probe 与下方 relock 之间释放,relock 的
    #   flock -n 会**当场取得空闲锁**而误判继承有效(caller 此前并未持锁,其 canonical mutation 有一段未受锁
    #   保护)。根治=在 relock **之前**直接读**继承 fd 自身**的 FLOCK 事实:/proc/self/fdinfo/<fd> 的 `lock:`
    #   行当且仅当该 fd 的 OFD 持有 flock 时出现(纯状态读,无 acquire → 无 TOCTOU)。要求存在一条
    #   inode==$DEPLOY_LOCK 的 FLOCK ADVISORY WRITE lock 行,证明继承 fd 确已持锁;缺失/不符/异常 → fail-closed exit 3。
    #   [偏离原议见 R2-5 报告] 原议"/proc/locks 取持有 pid + PPid 祖先链"对 flock(1) 不可行:/proc/locks
    #   记录的是**临时 flock(1) 命令进程**的 pid(检时已被 reap,fd-继承协议下既非 $$ 亦非 $$ 祖先),且
    #   /proc/locks 为 inode 全局态、无法回答"哪个 fd/OFD 持锁";fdinfo 为 per-fd,直证继承 fd 持锁,是同一
    #   意图(证明调用方真持锁而非谎称、非 relock 当场取得)的正确且更强(零 TOCTOU)实现,祖先链因此无需。
    lock_inode="${lock_id##*:}"
    if ! grep -Eq "^lock:[[:space:]]+[0-9]+:[[:space:]]+FLOCK[[:space:]]+ADVISORY[[:space:]]+WRITE[[:space:]]+[0-9]+[[:space:]]+[0-9a-f]+:[0-9a-f]+:${lock_inode}[[:space:]]" "/proc/self/fdinfo/$lock_fd" 2>/dev/null; then
      echo "✗ 继承锁归属证明失败:/proc/self/fdinfo/$lock_fd 无 inode=$lock_inode 的 FLOCK ADVISORY WRITE lock 行 —— 继承 fd 并未持有部署锁(调用方谎称已持锁,或真持有者已于 probe 与 relock 之间释放);fail-closed 拒绝继承(须在**已 flock 的 fd** 上再 spawn 本脚本)" >&2
      exit 3
    fi
    # ⑥ 与父同 OFD 重入取锁,幂等应成功(归属已由 fdinfo 证明);不成则继承 fd 已非持锁态,拒绝。
    if ! flock -n "$lock_fd"; then
      echo "✗ 继承锁 fd $lock_fd 重入 flock -n 失败(与父同 OFD 本应幂等成功;继承 fd 已非持锁态)" >&2; exit 3; fi
    echo "  ✓ 继承部署锁 fd=$lock_fd(dev:inode=$inh_id 与 $DEPLOY_LOCK 一致;probe 独立 OFD 冲突失败 + fdinfo per-fd FLOCK 归属证明=继承 fd 确已持锁)"
    printf 'pid=%s mode=%s tree=%s started=%s inherited_fd=%s\n' "$$" "$MODE" "$REPO_ROOT" "$(date -Is)" "$lock_fd" > "${DEPLOY_LOCK}.holder"
    DEPLOY_HOLDER_OWNED=1
  else
    exec 8>"$DEPLOY_LOCK"
    if ! flock -n 8; then
      echo "⏳ 部署锁被占:$(cat "${DEPLOY_LOCK}.holder" 2>/dev/null || echo '持有者未知')"
      echo "   等待释放(≤900s;另一会话部署完成后自动继续)..."
      flock -w 900 8 || { echo "✗ 900s 未取得部署锁 —— 另一会话的部署可能挂死,人工核查 ${DEPLOY_LOCK}.holder 后处置" >&2; exit 3; }
    fi
    printf 'pid=%s mode=%s tree=%s started=%s\n' "$$" "$MODE" "$REPO_ROOT" "$(date -Is)" > "${DEPLOY_LOCK}.holder"
    DEPLOY_HOLDER_OWNED=1
  fi
fi

# 必须在本地 deploy flock 已真实取得/复核之后、migration/marker/远端 lease/任何远端副作用之前
# 执行。这样 normal 开发发布无法跨队，selfheal 也只能凭 durable identity 使用继承锁旁路。
assert_development_release_queue || exit 3

# bootstrap 必须先生成/保留 V5_ENV，故在 bootstrap() 的 4.5 步单独执行；其余所有写 lane
# 在任何 release/symlink/unit/Caddy/状态机副作用前统一 fail-closed。
# reclaim 是纯远端 lease 救援(不建 release、不写 DB),且必须能在有 recovery marker / 迁移未就绪时照跑,
# 故一并跳过下面三道写前门。
# Recovery/compensation must not depend on forward migrations declared only by
# today's checkout. Those lanes validate the immutable target release instead
# (abort/rollback/recover), or execute Luna's self-contained fail-closed audit
# transaction (hide-luna). This keeps rollback available when canonical moves
# ahead of the currently deployed schema.
case "$MODE" in
  smoke|bootstrap|reclaim-mutation-lease|abort|rollback|recover|hide-luna) ;;
  *) assert_repo_required_migrations || exit 1 ;;
esac
# Smoke 也必须验证应用角色真能使用已记账的 0151 对象；bootstrap 在 env 建好后
# 于 4.5 步单独执行。其余模式在任何远端状态副作用前统一 fail-closed。
if [[ "$MODE" != "bootstrap" && "$MODE" != "reclaim-mutation-lease" ]]; then
  assert_0151_runtime_privileges || exit 1
fi

# 任一历史部署若留下 state/runtime 无法裁决的持久标记，所有后续写 lane 必须停住，避免用新
# 发布覆盖现场证据。只读 smoke 仍允许，供人工诊断；dry-run 不访问远端。
# reclaim 必须在 marker 存在时照样能跑(它正是清理陈旧锁的救援手段)。
if [[ "$DRY" != 1 && "$MODE" != "smoke" && "$MODE" != "baseline-census" && "$MODE" != "reclaim-mutation-lease" && "$MODE" != "hide-luna" ]]; then
  assert_no_deploy_recovery_marker || exit 1
fi

# ── 远端 production-mutation lease(RFC-v5-selfheal-batch1b §1.2)──
# 锁序:本地 deploy lock(上文,fd 8/继承 fd)→ 远端 lease(此处),固定先本地后远端防死锁。
# 单点 gate:每个写 lane 在进入任何 lane 逻辑(含各自 build_release / 首次远端写)之前统一取得,
# 持有到 cleanup 释放。分散逐 lane 挂载易漏(新增写 lane 忘记挂=整类回归),故收口于此。
# 只读 lane(smoke/baseline-census/两个 model-authority 只读态)不取;dry-run 只打印意图。
case "$MODE" in
  smoke|baseline-census|model-authority-preflight|model-authority-observation-status) ;;
  # reclaim = 陈旧 lease 救援,自身绝不能去取全局 lease(否则被残留焊死时自我阻塞)。
  reclaim-mutation-lease) ;;
  # knowledge-planet-verify:人工扫码轮询窗(~4min)不持全局 lease,避免饿死紧急自愈 host-action(C7);
  # 全局 lease 仅在函数内围绕 build_release(唯一共享命名空间写)窄取窄放。
  knowledge-planet-verify) ;;
  *) acquire_production_mutation_lease || exit 3 ;;
esac

# Durable containment debt is checked only after the real mutation lease has been acquired.
# Recovery/rollback/abort and Luna-hide compensation remain available; every other write lane
# is fenced until the exact protected merge + Codex/tests/CI evidence closes the debt.
case "$MODE" in
  smoke|baseline-census|model-authority-preflight|model-authority-observation-status|reclaim-mutation-lease|knowledge-planet-verify) ;;
  *) assert_emergency_debt_gate || exit 1 ;;
esac

# 门禁豁免债务闸(2026-07-26):与 emergency debt 同一挂载点、同一放行集合语义。
# 恢复/回退 lane 与 dx-declared containment lane 永不被阻断(回退优先于任何新门)。
case "$MODE" in
  smoke|baseline-census|model-authority-preflight|model-authority-observation-status|reclaim-mutation-lease|knowledge-planet-verify) ;;
  abort|rollback|recover|hide-luna|authorize-emergency|close-emergency-debt) ;;
  # 逃生/回滚/观测 lane 同样永不被阻断(2026-07-26 主控复核补齐):
  #   · emergency-tuple / activate-emergency-tuple = 逃生镜像的登记与激活(R2-M1/R3-B1)。
  #     它们**无法**用 --emergency-containment 旁路(EMERGENCY_INCIDENT 只接受
  #     --authorize-emergency / --canary / --finalize,见入参校验),所以不在这里显式放行
  #     就等于「有未偿门禁债时逃生通道被自我否决」—— 与 smoke_turn_canary_advisory
  #     恒返回 0 的设计意图直接冲突。
  #   · disable-model-authority = 步骤 4 的显式回滚(关 flag),回退性质。
  #   · install-monitor = 纯 host 观测面安装,不碰用户流量;有未偿债务时更需要监控在线。
  emergency-tuple|activate-emergency-tuple|disable-model-authority|install-monitor) ;;
  *)
    if [[ -n "$EMERGENCY_INCIDENT" ]]; then
      echo "  · dx-declared emergency containment lane:跳过门禁豁免债务闸(止血优先;debt 仍在,普通发布仍被阻断)"
    else
      assert_no_open_gate_waivers || exit 1
    fi
    # 记账在闸之后:闸负责「上一次的债还没还清就别发」,记账负责「这一次声明的豁免必须留痕」。
    # 顺序反了会把本次刚写的 marker 当成上次的旧债自我阻塞。
    record_declared_gate_waivers || exit 1
    ;;
esac

# Legacy marker 兼容权只在会 build/flip/放量 master release 的 invocation 建立：此刻本地
# deploy lock 与远端 mutation lease 均已持有，而 run_mutation_lane_supervised 尚未 arm
# in-flight marker，故这是任何 release/state/unit 写入前的唯一可信捕获点。
case "$MODE" in
  deploy)
    capture_trusted_release_predecessor || exit 1
    [[ "$RESTART_EGRESS" != 1 ]] || capture_trusted_egress_predecessor || exit 1
    ;;
  canary)
    capture_trusted_release_predecessor || exit 1
    [[ "$RESTART_EGRESS" != 1 ]] || capture_trusted_egress_predecessor || exit 1
    ;;
  dist|rollback|promote|finalize|abort|recover)
    capture_trusted_release_predecessor || exit 1 ;;
  migrate-bluegreen)
    # 首次实目录迁移没有 predecessor marker；已是 symlink 的幂等重跑则必须也在
    # supervisor arm 首写前捕获 exact target，函数内只消费这份已锁定身份。
    migrate_predecessor="$(bg_current_release "$REMOTE_SRC")"
    [[ -z "$migrate_predecessor" ]] \
      || capture_trusted_release_predecessor "$migrate_predecessor" || exit 1 ;;
esac

case "$MODE" in
  smoke|baseline-census|model-authority-preflight|model-authority-observation-status|reclaim-mutation-lease|knowledge-planet-verify)
    run_selected_mode "$MODE" ;;
  *)
    run_mutation_lane_supervised run_selected_mode "$MODE" ;;
esac
