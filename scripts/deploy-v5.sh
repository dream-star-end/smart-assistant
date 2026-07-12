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
#   scripts/deploy-v5.sh --smoke       # 仅跑 v5 健康/隔离断言
#   scripts/deploy-v5.sh --dist        # 仅前端生效面:vite build + 竞态安全 rsync + 资产GC + restart + 版本握手 smoke
#
# 并发:所有写模式过 /var/lock/oc-v5-deploy.lock 全局互斥(多会话并行开发硬保证),
#       持有者信息在 .holder;等待 900s 超时 fail-loud。
#   scripts/deploy-v5.sh --prepare-offline-cutover --target-image=TAG
#                                  # 服务在线健康时生成一次性离线切换清单/完整恢复包
#   scripts/deploy-v5.sh --offline-recycle --cutover-nonce=NONCE
#   scripts/deploy-v5.sh --stage --cutover-nonce=NONCE
#   scripts/deploy-v5.sh --activate-staged --cutover-nonce=NONCE
#   scripts/deploy-v5.sh --rollback    # 恢复 .prev.1 + restart
#   scripts/deploy-v5.sh --rollback=N  # 恢复 .prev.N(N=1..5)+ restart
#   scripts/deploy-v5.sh --dry-run     # 只打印将执行的动作
#
# runtime hotcfg(§5,两轴独立开关):
#   --enable-runtime-release / --enable-platform-bundle    # 首次启用该轴(随本次 deploy 激活)
#   --disable-runtime-release / --disable-platform-bundle  # 禁用该轴:本次激活把 env 键写**空值**
#                                                          # (R2-B1 三态写),走完整 saga+smoke
#   --emergency-tuple [--image=REF --image-id=ID --bundle=DIR]
#       # 登记逃生 tuple。缺省取当前 env 四键;显式候选(R2-M1)供瘦身稳态直接登记内嵌镜像逃生点,
#       # 不必先把现网翻到空 release。硬验含 immutable ID 钉死(inspect .Id == image_id)。
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
CUTOVER_ROOT="/var/lib/openclaude-v5/cutovers"
CUTOVER_LOCK="/var/lib/openclaude-v5/cutover.lock"
MAINTENANCE_MARKER="/run/openclaude-v5/planned-maintenance.json"

# ── 定位 worktree 根 ──
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RELEASE_METADATA="$REPO_ROOT/deploy/v5/release-metadata.json"
cd "$REPO_ROOT"

# ── runtime tuple / platform bundle 纯函数库(宿主本地实现;真实部署 ship 到 kl-mirror 后跑)──
# 设计 docs/V5_RUNTIME_HOTCFG_PLAN.md §1.1/1.2/1.5/3.1。本文件 source 它取 bundle/release/saga/GC
# 的算法核心;deploy 面只做"组装 staging(git archive/cp)+ ship lib + 远端 invoke"的编排。
RUNTIME_LIB="$SCRIPT_DIR/v5-runtime-release-lib.sh"
[ -f "$RUNTIME_LIB" ] || { echo "FATAL: 缺 runtime release lib: $RUNTIME_LIB" >&2; exit 1; }
# shellcheck source=scripts/v5-runtime-release-lib.sh
source "$RUNTIME_LIB"
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
)

# REMOVE_KEYS 有两类:①"剥 v3 值 → overrides 设 v5 专属值"(AGENT_*/OC_RUNTIME_IMAGE/
# INTERNAL_PROXY_*/EXTERNAL_MTLS_* 等,overrides 里合法出现);②"必须绝不出现"——从 v3
# 继承会重新禁掉 v5-owned 职能的禁用旗标。守卫只拦第②类。
# 第②类:v5-owned codex 刷新 actor / drift reconciler 必须自己跑,overrides 里出现其
# *_DISABLED=1 会在"删 REMOVE_KEYS 再追加 overrides"时复活 → 重 bootstrap/DR 后 v5 codex
# token 无人续期,静默烂池。让这类矛盾在部署时爆而非 DR 时爆。
FORBIDDEN_IN_OVERRIDES=(
  COMMERCIAL_CODEX_REFRESH_ACTOR_DISABLED COMMERCIAL_CODEX_DRIFT_RECONCILER_DISABLED
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

DRY=0; MODE="deploy"; ROLLBACK_N=1; RESTART_EGRESS=0; WITH_DIST=0
CUTOVER_NONCE=""; CUTOVER_TARGET_IMAGE=""
# runtime hotcfg 两机制**各自独立开关,默认关**(§5:合并后未部署期间生产行为零变化)。
# 首次开启用 --enable-*;开启后写入 env 的 tuple 键会让后续 deploy 自动持续走该机制。
# --disable-*(R2-B1):该轴本次激活写**空值**(三态写:键在值空=禁用),走完整 saga+smoke。
ENABLE_BUNDLE_FLAG=0; ENABLE_RELEASE_FLAG=0
DISABLE_BUNDLE_FLAG=0; DISABLE_RELEASE_FLAG=0
# --emergency-tuple 的显式候选(R2-M1;空=取当前 env 现值)
EMERG_IMAGE=""; EMERG_IMAGE_ID=""; EMERG_BUNDLE=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    # 代码+前端两生效面合并为一次重启(见 deploy() 内注释,2026-07-10 成对重启事故)
    --with-dist) WITH_DIST=1 ;;
    --enable-platform-bundle) ENABLE_BUNDLE_FLAG=1 ;;
    --enable-runtime-release) ENABLE_RELEASE_FLAG=1 ;;
    --disable-platform-bundle) DISABLE_BUNDLE_FLAG=1 ;;
    --disable-runtime-release) DISABLE_RELEASE_FLAG=1 ;;
    --emergency-tuple) MODE="emergency-tuple" ;;
    --activate-emergency-tuple) MODE="activate-emergency-tuple" ;;
    --image=*) EMERG_IMAGE="${arg#*=}" ;;
    --image-id=*) EMERG_IMAGE_ID="${arg#*=}" ;;
    --bundle=*) EMERG_BUNDLE="${arg#*=}" ;;
    --bootstrap) MODE="bootstrap" ;;
    --migrate-bluegreen) MODE="migrate-bluegreen" ;;
    --smoke) MODE="smoke" ;;
    --dist) MODE="dist" ;;
    --prepare-offline-cutover) MODE="prepare-offline-cutover" ;;
    --offline-recycle) MODE="offline-recycle" ;;
    --stage) MODE="stage" ;;
    --activate-staged) MODE="activate-staged" ;;
    --rollback) MODE="rollback"; ROLLBACK_N=1 ;;
    --rollback=*) MODE="rollback"; ROLLBACK_N="${arg#*=}" ;;
    --cutover-nonce=*) CUTOVER_NONCE="${arg#*=}" ;;
    --target-image=*) CUTOVER_TARGET_IMAGE="${arg#*=}" ;;
    # egress split(2026-07-02):openclaude-v5-egress 持有在飞 LLM 流,默认部署
    # 【不】重启它(这正是解耦目的);仅 egress 相关代码(anthropicProxy/账号池/
    # 计费 finalize/egress/*)变更时显式带本 flag。重启走 SIGTERM drain。
    --egress) RESTART_EGRESS=1 ;;
    *) echo "未知参数: $arg" >&2; exit 2 ;;
  esac
done
[[ "$MODE" == "rollback" && ! "$ROLLBACK_N" =~ ^[1-5]$ ]] && { echo "✗ --rollback=N 需 N∈1..5" >&2; exit 2; }
[[ -n "$CUTOVER_NONCE" && ! "$CUTOVER_NONCE" =~ ^[0-9a-f]{32}$ ]] && { echo "✗ cutover nonce 必须是 32 位小写 hex" >&2; exit 2; }
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

run() { if [[ "$DRY" == 1 ]]; then echo "  [dry-run] $*"; else eval "$@"; fi; }
sshk() { if [[ "$DRY" == 1 ]]; then echo "  [dry-run] ssh $KL_HOST '$*'"; else ssh "$KL_HOST" "$@"; fi; }

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
  [[ "$DRY" == 1 ]] && { echo "  [dry-run] recover old activation and start $V5_UNIT ($reason)"; return 0; }
  echo "⚠ 离线步骤失败，恢复旧激活面并启动旧服务：$reason" >&2
  ssh "$KL_HOST" bash -s -- "$CUTOVER_ROOT" "$CUTOVER_LOCK" "$CUTOVER_NONCE" "$REMOTE_SRC" "$V5_ENV" "$V5_UNIT" "$V5_PORT" "$MAINTENANCE_MARKER" <<'REMOTE'
set -Eeuo pipefail
root="$1"; lock="$2"; nonce="$3"; remote_src="$4"; env_file="$5"; unit="$6"; port="$7"; marker="$8"
mkdir -p "$(dirname "$lock")"; touch "$lock"; chmod 600 "$lock"; exec 9>"$lock"; flock -x 9
bundle="$root/$nonce"
secure=0
if [[ "$nonce" =~ ^[0-9a-f]{32}$ && -d "$bundle" && -f "$bundle/manifest.json" &&
      "$(stat -c '%U:%G' "$bundle")" == 'root:root' && "$(stat -c '%a' "$bundle")" == 700 &&
      "$(stat -c '%a' "$bundle/manifest.json")" == 600 &&
      "$(jq -r '.host // empty' "$bundle/manifest.json" 2>/dev/null)" == "$(hostname -f)" ]]; then
  secure=1
fi
if [[ "$secure" != 1 ]]; then
  rm -f "$marker" || true
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
    rm -f "$marker" || true
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
rm -f "$marker"
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
  ssh "$KL_HOST" bash -s -- "$CUTOVER_ROOT" "$CUTOVER_NONCE" "$MAINTENANCE_MARKER" <<'REMOTE'
set -Eeuo pipefail
root="$1"; nonce="$2"; marker="$3"; manifest="$root/$nonce/manifest.json"
[[ -f "$manifest" && "$(jq -r '.host' "$manifest")" == "$(hostname -f)" ]] || exit 1
deadline="$(jq -r '.expires_at' "$manifest")"; mkdir -p -m 700 "$(dirname "$marker")"
jq -n --arg host "$(hostname -f)" --arg nonce "$nonce" --argjson deadline "$deadline" \
  '{schema:1,host:$host,nonce:$nonce,deadline:$deadline}' >"$marker.tmp"
chmod 600 "$marker.tmp"; mv "$marker.tmp" "$marker"
REMOTE
}

clear_cutover_maintenance() {
  [[ "$DRY" == 1 ]] && { echo "  [dry-run] clear planned-maintenance marker"; return 0; }
  ssh "$KL_HOST" "rm -f '$MAINTENANCE_MARKER'"
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
now="$(date +%s)"; jq -n --arg state "$next" --argjson at "$now" '{state:$state,updated_at:$at}' >"$state_file.tmp"
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
RELEASES_KEEP="${RELEASES_KEEP:-6}"

# 当前 release 目录(REMOTE_SRC symlink 的 target);未迁移(实目录)或无 symlink → 空。
bg_current_release() {
  ssh "$KL_HOST" "test -L '$REMOTE_SRC' && readlink -f '$REMOTE_SRC' || true" 2>/dev/null || true
}

# 蓝绿前置:REMOTE_SRC 必须已是 symlink 布局且指向 RELEASES_ROOT 下的完整 release(否则先迁移)。
assert_bluegreen_layout() {
  [[ "$DRY" == 1 ]] && { echo "  [dry-run] 断言蓝绿 symlink 布局"; return 0; }
  ssh "$KL_HOST" "set -e
    test -L '$REMOTE_SRC'
    t=\$(readlink -f '$REMOTE_SRC')
    case \"\$t\" in '$RELEASES_ROOT'/rel-*) : ;; *) echo '✗ $REMOTE_SRC symlink 未指向 RELEASES_ROOT/rel-*: '\"\$t\" >&2; exit 1 ;; esac
    test -f \"\$t/.complete\" || { echo '✗ current release 无 .complete 标记' >&2; exit 1; }" || {
    echo "✗ 蓝绿布局校验失败:$REMOTE_SRC 需为指向 RELEASES_ROOT/rel-* 完整 release 的 symlink。先在受控窗口跑:deploy-v5.sh --migrate-bluegreen" >&2
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
BUILT_RELEASE=""
build_release() {
  BUILT_RELEASE=""; DIST_BUILD_ID=""
  local full_sha short_sha ts staging reldir cur
  full_sha="$(git -C "$REPO_ROOT" rev-parse HEAD)"
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
  # dist:--with-dist 时**在 staging(archive pinned 源)上 vite build**(R2#2:不从共用工作树构建,
  # 彻底消 dist 与 archive 不同源);否则硬链继承当前 release 的 dist(前端未变)。两路 DIST_BUILD_ID
  # 都从 staging 读。
  if [[ "$WITH_DIST" == 1 ]]; then
    echo "── vite build @ staging(pinned $short_sha,不读共用工作树)──" >&2
    if ! ssh "$KL_HOST" "set -e; cd '$staging/packages/web-react' && npx vite build >/dev/null 2>&1"; then
      echo "✗ staging vite build 失败" >&2; ssh "$KL_HOST" "rm -rf '$staging'" 2>/dev/null; return 1; fi
  else
    if ! ssh "$KL_HOST" "set -e
        [ -n '$cur' ] && [ -d '$cur/packages/web-react/dist' ] || { echo '✗ 当前 release 无 dist 可继承' >&2; exit 1; }
        mkdir -p '$staging/packages/web-react'; rm -rf '$staging/packages/web-react/dist'; cp -al '$cur/packages/web-react/dist' '$staging/packages/web-react/dist'"; then
      echo "✗ dist 继承失败" >&2; ssh "$KL_HOST" "rm -rf '$staging'" 2>/dev/null; return 1; fi
  fi
  DIST_BUILD_ID="$(ssh "$KL_HOST" "grep -o 'name=\"oc-build\" content=\"[0-9a-f]\\{8,32\\}\"' '$staging/packages/web-react/dist/index.html' 2>/dev/null | grep -o '[0-9a-f]\\{8,32\\}' | head -1" 2>/dev/null || true)"
  [[ -n "$DIST_BUILD_ID" ]] || { echo "✗ staging dist 缺 oc-build meta" >&2; ssh "$KL_HOST" "rm -rf '$staging'" 2>/dev/null; return 1; }
  # VERSION(钉死 short_sha)+ 完整性校验 + .complete + 原子改名 staging→rel-*
  if ! write_version "$staging" "$short_sha" >&2; then ssh "$KL_HOST" "rm -rf '$staging'" 2>/dev/null; return 1; fi
  if ! ssh "$KL_HOST" "set -e
      test -f '$staging/package.json' && test -d '$staging/node_modules' && test -f '$staging/VERSION.json' && test -f '$staging/packages/web-react/dist/index.html'
      printf '{\"sha\":\"$short_sha\",\"builtAt\":\"$ts\"}\n' > '$staging/.complete'
      mv -T '$staging' '$reldir'"; then
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

# 原子激活 release:只认带 .complete 的目录;翻转**前**先原子写 prev(rollback 元数据与翻转
# 不脱域,Codex P1#7);唯一临时 symlink(防前次残留 .newlink 阻断);mv -T 原子翻转 → restart。
activate_release() {
  local reldir="$1" prev tmplink
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] 校验 $reldir/.complete;写 .prev-release;ln -s + mv -T 原子翻转 $REMOTE_SRC;systemctl restart $V5_UNIT"
    return 0
  fi
  ssh "$KL_HOST" "test -f '$reldir/.complete'" || { echo "✗ 目标 release 无 .complete 标记,拒绝激活: $reldir" >&2; exit 1; }
  # 割接后 capability 门:deploy/dist/rollback 的激活都经本函数,一处即覆盖全部激活/回滚路径。
  assert_release_capability_for_sessions_pg "$reldir"
  prev="$(bg_current_release)"
  tmplink="$REMOTE_SRC.newlink.$$"
  # 翻转前先落 prev(原子);再翻转(ln -sfn 非原子,故临时链+mv -T)
  ssh "$KL_HOST" "set -Eeuo pipefail
    printf '%s\n' '$prev' > '$RELEASES_ROOT/.prev-release.tmp' && mv -f '$RELEASES_ROOT/.prev-release.tmp' '$RELEASES_ROOT/.prev-release'
    rm -f '$tmplink'
    ln -s '$reldir' '$tmplink'
    mv -T '$tmplink' '$REMOTE_SRC'" || { echo "✗ symlink 翻转失败(live 未改)" >&2; exit 1; }
  echo "  ✓ 原子翻转:$REMOTE_SRC → $reldir(旧=$prev)"
  echo "── restart openclaude-v5(仅 v5,绝不碰 v3)──"
  ssh "$KL_HOST" "systemctl restart '$V5_UNIT'" || { echo "✗ restart 失败——symlink 已指新 release,须人工 restart/回切" >&2; exit 1; }
  run "sleep 4"
}

# GC:保留最近 RELEASES_KEEP 个 release,删更老;**绝不删** current / .prev-release / master 与
# egress 进程 cwd 指向的(egress 默认不随 deploy 重启,cwd 可能停在更老 release,Codex P1#5)。
# 只删带 .complete 的正式 rel-*;顺带清超 1 天的孤儿 .staging-*。
gc_releases() {
  [[ "$DRY" == 1 ]] && { echo "  [dry-run] GC:保留最近 $RELEASES_KEEP 个,护 current/prev/master+egress cwd"; return 0; }
  ssh "$KL_HOST" "set -e
    cur=\$(readlink -f '$REMOTE_SRC' 2>/dev/null || true)
    prev=\$(readlink -f \"\$(cat '$RELEASES_ROOT/.prev-release' 2>/dev/null || true)\" 2>/dev/null || true)
    mpid=\$(systemctl show -p MainPID --value '$V5_UNIT' 2>/dev/null || echo 0)
    epid=\$(systemctl show -p MainPID --value openclaude-v5-egress 2>/dev/null || echo 0)
    mcwd=\$([ \"\${mpid:-0}\" -gt 0 ] && readlink -f /proc/\$mpid/cwd 2>/dev/null || true)
    ecwd=\$([ \"\${epid:-0}\" -gt 0 ] && readlink -f /proc/\$epid/cwd 2>/dev/null || true)
    ls -1dt '$RELEASES_ROOT'/rel-* 2>/dev/null | tail -n +$((RELEASES_KEEP+1)) | while read -r d; do
      rd=\$(readlink -f \"\$d\" 2>/dev/null || echo \"\$d\")
      case \"\$rd\" in \"\$cur\"|\"\$prev\"|\"\$mcwd\"|\"\$ecwd\") continue ;; esac
      [ -f \"\$d/.complete\" ] || continue
      rm -rf \"\$d\"
    done
    find '$RELEASES_ROOT' -maxdepth 1 -name '.staging-*' -type d -mtime +1 -exec rm -rf {} + 2>/dev/null || true" 2>&1 | sed 's/^/  /' || true
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

# ── 1. build_platform_bundle:从**钉死的** BUILT_RELEASE 内 platform-runtime/ 组装 → 落 bundles/<rev> ──
# 源必须取本次 deploy 已建的不可变 master release(而非 live 树),与 VERSION/archive 同 sha 自洽。
BUILT_BUNDLE_REV=""
build_platform_bundle() {
  BUILT_BUNDLE_REV=""
  local src="$BUILT_RELEASE/packages/commercial/agent-sandbox/platform-runtime"
  local full_sha nonce staging
  full_sha="$(git -C "$REPO_ROOT" rev-parse HEAD)"
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
  local full_sha nonce raw staging
  local excl='packages/commercial/agent-sandbox/runtime-src-excludes.txt'
  full_sha="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  echo "── build runtime release(源钉死 git archive $full_sha)──"
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] archive→prune(--exclude-from=$excl)→敏感扫描→docker npm ci(root 一套)→ccb host bun build 仅拷 dist(无 ccb node_modules)→manifest→rel-<digest>"
    BUILT_RUNTIME_RELEASE="$OC_HOTCFG_RELEASES_ROOT/rel-dryrunrelease"; RUNTIME_IMAGE_REF="dry"; RUNTIME_IMAGE_ID="sha256:dry"; return 0
  fi
  hotcfg_ship_lib || return 1
  RUNTIME_IMAGE_REF="$(ssh "$KL_HOST" "grep '^OC_RUNTIME_IMAGE=' '$V5_ENV' | tail -n1 | cut -d= -f2-")"
  [[ -n "$RUNTIME_IMAGE_REF" ]] || { echo "✗ env 缺 OC_RUNTIME_IMAGE(release 依赖目标镜像装依赖)" >&2; return 1; }
  RUNTIME_IMAGE_ID="$(ssh "$KL_HOST" "docker image inspect --format '{{.Id}}' '$RUNTIME_IMAGE_REF'" 2>/dev/null)" \
    || { echo "✗ 目标 runtime 镜像不存在(须先 build-image 并写入 env): $RUNTIME_IMAGE_REF" >&2; return 1; }
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
  BUILT_RUNTIME_RELEASE="$(hotcfg_rmt oc_hotcfg_finalize_release "$staging" "$RUNTIME_IMAGE_ID" "$full_sha" "${prev:-}")" \
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
  printf '%s' 'hz=""; for i in $(seq 1 15); do hz=$(curl -fsS http://127.0.0.1:'"$V5_PORT"'/healthz 2>/dev/null||true); [ -n "$hz" ] && break; sleep 2; done; printf "%s" "$hz" | grep -q "\"ok\":true" && printf "%s" "$hz" | grep -q "\"channel\":\"v5\"" && printf "%s" "$hz" | grep -q "\"sessionsDb\":\"ok\""'
}

activate_runtime_tuple() {
  echo "── 激活 runtime tuple saga ──"
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] saga: [pre-state(首启)]→[canary validate-only]→extra_apply(master symlink→$BUILT_RELEASE)→env tuple(四键恒写,禁用轴空值)→[flip current]→restart→smoke→history commit"
    return 0
  fi
  local prev_src old_prev image image_id release bundle_val flip_rev restart_cmd smoke_cmd extra_apply extra_revert
  prev_src="$(bg_current_release)"
  # M7c:快照翻转**前**的 .prev-release 指针内容,失败恢复时一并还原(否则 saga 失败一次丢 rollback 指针)。
  old_prev="$(ssh "$KL_HOST" "cat '$RELEASES_ROOT/.prev-release' 2>/dev/null || true")"
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
  # bundle 轴:启用则翻新 rev + 写新绝对路径;禁用/未启用 → flip_rev 空(不翻 current)+ 写空值(R2-B1)。
  if hotcfg_bundle_axis_on; then
    flip_rev="$BUILT_BUNDLE_REV"; bundle_val="$OC_HOTCFG_PLATFORM_ROOT/bundles/$BUILT_BUNDLE_REV"
  else
    flip_rev=""; bundle_val=""
  fi
  restart_cmd="systemctl restart '$V5_UNIT'"
  # 远端核心健康门(fail-closed):ok=true + channel=v5 + sessionsDb=ok(与 smoke() 深度探活同不变量)。
  # 全量 smoke(调度器白名单等第二道防线)在 saga 提交后由 deploy() 另跑本地 smoke() 兜底。
  smoke_cmd="$(hotcfg_core_smoke_cmd)"
  # extra:master 源码 symlink 翻转(先原子落 .prev-release=prev_src,再 ln+mv -T);
  # revert(M7c):**先还原 .prev-release=old_prev**(翻转前快照),再翻回 master symlink=prev_src。
  extra_apply="printf '%s\n' '$prev_src' > '$RELEASES_ROOT/.prev-release.tmp' && mv -f '$RELEASES_ROOT/.prev-release.tmp' '$RELEASES_ROOT/.prev-release'; rm -f '$REMOTE_SRC.hotlink'; ln -s '$BUILT_RELEASE' '$REMOTE_SRC.hotlink'; mv -T '$REMOTE_SRC.hotlink' '$REMOTE_SRC'"
  extra_revert="printf '%s\n' '$old_prev' > '$RELEASES_ROOT/.prev-release.tmp' && mv -f '$RELEASES_ROOT/.prev-release.tmp' '$RELEASES_ROOT/.prev-release'; rm -f '$REMOTE_SRC.hotlink'; ln -s '$prev_src' '$REMOTE_SRC.hotlink'; mv -T '$REMOTE_SRC.hotlink' '$REMOTE_SRC'"
  # M7a:masterRelease=$BUILT_RELEASE(本次激活的 master 蓝绿 release)进 history,rollback 从同一条取回对齐。
  # R2-B2:prev_master=$prev_src(激活前 live master)供首次启用的 pre-state 记录。
  hotcfg_rmt oc_hotcfg_activate_saga \
    "$V5_ENV" "$OC_HOTCFG_PLATFORM_ROOT" "$flip_rev" "$OC_HOTCFG_HISTORY" \
    "$image" "$image_id" "$release" "$bundle_val" \
    "$restart_cmd" "$smoke_cmd" "$extra_apply" "$extra_revert" "$BUILT_RELEASE" "$prev_src" \
    || { echo "✗ 激活 saga 失败,已自动回滚旧 tuple(env/current/master 源码/.prev-release/重启旧 master)" >&2; return 1; }
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
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] 读 OC_RUNTIME_EMERGENCY_TUPLE → 核验 ID → saga{canary→env(release=空)→flip current→restart→smoke→history}"
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
  prev_src="$(bg_current_release)"
  local restart_cmd smoke_cmd
  restart_cmd="systemctl restart '$V5_UNIT'"
  smoke_cmd="$(hotcfg_core_smoke_cmd)"  # R4-M2:与正常激活同强度(含 sessionsDb=ok)
  # masterRelease=prev_src(master 源码不动,history 记当前 live);extra_apply/revert 传空。
  hotcfg_rmt oc_hotcfg_activate_saga \
    "$V5_ENV" "$OC_HOTCFG_PLATFORM_ROOT" "$rev" "$OC_HOTCFG_HISTORY" \
    "$image" "$image_id" "" "$bundle" \
    "$restart_cmd" "$smoke_cmd" "" "" "$prev_src" "$prev_src" \
    || { echo "✗ emergency 激活 saga 失败,已自动回滚" >&2; exit 1; }
  echo "✓ emergency tuple 已激活(image=$image release=<empty> bundle=$rev);存量容器按 runtimeStale 滚动。"
}

# 一次性迁移:实目录 $REMOTE_SRC → symlink 布局(须在无并发部署的受控窗口跑)。
migrate_to_bluegreen() {
  echo "══ v5 迁移蓝绿 symlink 布局 on $KL_HOST ══"
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] 已 symlink 则跳过;否则 stop→mv 实目录→唯一 rel-<sha>-<ts>-migrated(写 .complete)→ln -s→start→smoke(带 ERR 恢复 trap)"
    return 0
  fi
  # R2#3:幂等跳过必须是**合法**蓝绿布局(指向 rel-* 且带 .complete),不能见 symlink 就当已迁移
  if ssh "$KL_HOST" "test -L '$REMOTE_SRC'"; then
    if ssh "$KL_HOST" "set -e; t=\$(readlink -f '$REMOTE_SRC'); case \"\$t\" in '$RELEASES_ROOT'/rel-*) test -f \"\$t/.complete\" ;; *) exit 1 ;; esac"; then
      echo "  ✓ 已是合法蓝绿布局,幂等跳过"; return 0
    fi
    echo "✗ $REMOTE_SRC 是 symlink 但非合法蓝绿布局(悬垂/非 rel-*/缺 .complete),拒绝自动迁移,人工处置" >&2; return 1
  fi
  local sha ts reldir
  sha="$(ssh "$KL_HOST" "jq -r .commit '$REMOTE_SRC/VERSION.json' 2>/dev/null || echo unknown")"
  ts="$(date -u +%Y%m%d-%H%M%S)"
  reldir="$RELEASES_ROOT/rel-$sha-$ts-migrated"
  echo "── 停机 → 实目录搬入 $reldir → 写 .complete → symlink → 启动(一次性,几秒停机;ERR 自动恢复贯穿 start)──"
  # ERR trap 覆盖到 start 成功之后才 `trap - ERR`(R2#3:start 失败也回滚);restore 处理已建 symlink 状态
  ssh "$KL_HOST" "set -Eeuo pipefail
    mkdir -p '$RELEASES_ROOT'
    test ! -e '$reldir'                    # 唯一目标必须不存在(防 mv 进已存在目录内部)
    systemctl stop '$V5_UNIT'
    moved=0; linked=0
    restore() {
      [ \"\$linked\" = 1 ] && rm -f '$REMOTE_SRC'
      if [ \"\$moved\" = 1 ] && [ ! -e '$REMOTE_SRC' ] && [ -d '$reldir' ]; then mv '$reldir' '$REMOTE_SRC' || true; fi
      systemctl start '$V5_UNIT' || true; echo 'FATAL: 迁移失败,已尽力恢复实目录并启动旧服务' >&2; }
    trap restore ERR
    mv '$REMOTE_SRC' '$reldir'; moved=1
    printf '{\"sha\":\"$sha\",\"builtAt\":\"$ts\",\"migrated\":true}\n' > '$reldir/.complete'
    ln -s '$reldir' '$REMOTE_SRC'; linked=1
    systemctl start '$V5_UNIT'
    trap - ERR" || { echo "✗ 迁移执行失败(见上 FATAL 恢复日志)" >&2; return 1; }
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
  echo "── vite build ──"
  run "(cd '$REPO_ROOT/packages/web-react' && npx vite build)"
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
  echo "── 版本握手 smoke:线上 oc-build == 本地构建(fail-closed)──"
  local live_id
  live_id="$(ssh "$KL_HOST" "curl -fsS http://127.0.0.1:${V5_PORT}/" | grep -o 'name="oc-build" content="[0-9a-f]\{8,32\}"' | grep -o '[0-9a-f]\{8,32\}' | head -1)"
  [[ "$live_id" == "$DIST_BUILD_ID" ]] || { echo "✗ 线上 oc-build=${live_id:-空} ≠ 本地 $DIST_BUILD_ID(rsync 目标/静态层缓存有诈)" >&2; exit 1; }
  echo "  ✓ 线上 oc-build: $live_id"
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
  # v3 退役后 leader 形态(OC_CONTROL_PLANE_LEADER=1,9ecfc97d):v5 接管 shared 域调度器,
  # 白名单语义不变(名单外条目仍 FAIL),只是 leader 下名单扩入 shared 域合法集。
  local leader
  leader="$(ssh "$KL_HOST" "test -r '$V5_ENV' && grep -E '^OC_CONTROL_PLANE_LEADER=' '$V5_ENV' | tail -n 1 | cut -d= -f2-" 2>/dev/null || true)"
  local scheds allowed bad
  scheds="$(echo "$hz" | grep -o '"schedulers":\[[^]]*\]' | sed 's/.*\[//;s/\]//;s/"//g')"
  #   cronWake(cron 触发权威上移,dae6d97d:cron_wake_index 为 v5 引入表(0119)且按
  #     runtime_channel 行级隔离;只唤醒容器不做执行/送达。关停:COMMERCIAL_CRON_WAKE_DISABLED=1)
  #   connectorSweeper(应用连接器,0130 三表均 v5 引入/v3 无代码:stale executing→unknown、
  #     确认过期销毁 params、OAuth pending 过期清理、ledger retention。关停:OC_CONNECTOR_SWEEPER_DISABLED=1)
  #   sessionsGcSweep(P2 会话权威迁 PG:usage 聚合 pending/map 老化 GC,advisory lease fencing,
  #     仅 OC_SESSIONS_STORE=pg 时启动——白名单允许≠必然存在。RFC-v5-sessions-pg D3)
  allowed="subscriptionRollover accountSlotReaper researchJobs codexRefresh codexDriftReconciler marketplaceAiReview orphanReconcile providerHealth wecomAlert cronWake connectorSweeper sessionsGcSweep"
  if [[ "$leader" == "1" ]]; then
    allowed="$allowed containerEvents alert refreshEventsSweep auditRetentionSweep cooldownRecovery pendingOrdersExpirer finalizeReconciler onboarding inboxEmail"
  fi
  bad=""
  IFS=',' read -ra _sarr <<<"$scheds"
  for s in "${_sarr[@]}"; do
    [[ -z "$s" ]] && continue
    grep -qw "$s" <<<"$allowed" || bad="$bad $s"
  done
  [[ -n "$bad" ]] && { echo "✗ shared 域 scheduler 泄漏到 v5:$bad" >&2; return 1; }
  if [[ "$leader" == "1" ]]; then
    echo "$hz" | grep -q '"controlPlaneEnabled":true' || { echo "✗ leader 模式下 controlPlaneEnabled 非 true" >&2; return 1; }
  else
    echo "$hz" | grep -q '"controlPlaneEnabled":false' || { echo "✗ controlPlaneEnabled 非 false" >&2; return 1; }
  fi
  echo "$hz" | grep -q '"agentRuntime":"disabled"' || { echo "✗ agentRuntime 非 disabled(不应起 legacy agent 运行时)" >&2; return 1; }
  local ver; ver="$(ssh "$KL_HOST" "curl -fsS http://127.0.0.1:${V5_PORT}/version" 2>/dev/null || true)"
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
  echo "══ v5 deploy on $KL_HOST(蓝绿:release 目录 + 原子 symlink)══"
  echo "── 守卫:overrides 不得含 REMOVE_KEYS ──"
  assert_overrides_no_remove_keys
  assert_bluegreen_layout
  echo "── 部署顺序守卫:校验 runtime_channel 列(0088)已应用 ──"
  assert_runtime_channel_column
  # build_release:从锁定 sha 的 git archive 建不可变 release(--with-dist 时 vite build 进
  # reldir,代码+前端同一 release 共享一次翻转+重启;无 --with-dist 则硬链继承当前 dist)。
  # 背景(2026-07-10 事故):deploy 后紧跟 --dist 的成对重启会把刚续写的 turn 二次掐死 →
  # 蓝绿下天然一次翻转一次重启,不会再成对重启。
  build_release || { echo "✗ build_release 失败,未激活任何 release(live 未改)" >&2; exit 1; }
  # runtime hotcfg 机制门控(§5):两机制**各自独立开关,默认关**;未启用 → 完全退化为原
  # "activate_release(翻转+restart)"路径,合并后未部署期间生产行为**零变化**。
  # 启用时:build bundle/release(仅启用者)→ activate saga 取代直接 restart(master 源码翻转
  # 作为 saga 的 extra_apply,与 tuple env/current 同一原子回滚单元,单次重启)。
  # R2-B1:--disable-* 时该轴不 build,但**必须走 saga**(把空值写进 env + restart + smoke + history 留痕)。
  local hc_bundle=0 hc_release=0 hc_any=0
  if hotcfg_bundle_axis_on; then hc_bundle=1; hc_any=1; fi
  if hotcfg_release_axis_on; then hc_release=1; hc_any=1; fi
  [[ "$DISABLE_BUNDLE_FLAG" == 1 || "$DISABLE_RELEASE_FLAG" == 1 ]] && hc_any=1
  if [[ "$hc_any" == 1 ]]; then
    echo "── runtime hotcfg 已启用(bundle=$hc_bundle release=$hc_release disable_bundle=$DISABLE_BUNDLE_FLAG disable_release=$DISABLE_RELEASE_FLAG)──"
    if [[ "$hc_bundle" == 1 ]]; then build_platform_bundle || { echo "✗ platform bundle 构建失败(live 未改)" >&2; exit 1; }; fi
    if [[ "$hc_release" == 1 ]]; then build_runtime_release || { echo "✗ runtime release 构建失败(live 未改)" >&2; exit 1; }; fi
    activate_runtime_tuple || { echo "✗ tuple 激活失败(saga 已自动回滚)" >&2; exit 1; }
  else
    activate_release "$BUILT_RELEASE"   # 原子 symlink 翻转 + restart(master 只从完整不可变 release 启动)
  fi
  if [[ "$RESTART_EGRESS" == 1 ]]; then
    echo "── restart openclaude-v5-egress(显式 --egress;SIGTERM drain 在飞流)──"
    sshk "systemctl restart openclaude-v5-egress"
    run "sleep 3"
  fi
  [[ "$DRY" == 1 ]] || smoke
  if [[ "$WITH_DIST" == 1 ]]; then
    dist_handshake_smoke
  fi
  gc_releases
  [[ "$hc_any" == 1 ]] && gc_runtime_artifacts   # best-effort(§1.4:失败只告警不回滚)
  echo "✓ deploy 完成(release=$BUILT_RELEASE)。"
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
  begin_cutover_step prepared recycling || return 1
  if ( set -Eeuo pipefail; offline_recycle_inner ); then
    cutover_transition recycling recycled || { recover_cutover "cannot commit recycled state"; return 1; }
  else
    local rc=$?; recover_cutover "offline recycle failed"; return "$rc"
  fi
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
  begin_cutover_step recycled staging || return 1
  if ( set -Eeuo pipefail; stage_inner ); then
    cutover_transition staging staged || { recover_cutover "cannot commit staged state"; return 1; }
  else
    local rc=$?; recover_cutover "stage failed"; return "$rc"
  fi
}

activate_staged_inner() {
  echo "══ v5 activate staged on $KL_HOST ══"
  assert_overrides_no_remove_keys
  assert_clean_source_tree
  assert_v5_master_inactive
  assert_v3_inactive_for_gpt_cutover
  assert_runtime_channel_column
  assert_gpt56_migration_ready
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
  begin_cutover_step staged activating || return 1
  if ( set -Eeuo pipefail; activate_staged_inner ); then
    cutover_transition activating activated || { recover_cutover "cannot commit activated state"; return 1; }
    clear_cutover_maintenance || echo "⚠ 激活成功但 maintenance marker 清理失败；最迟在 deadline 自动失效" >&2
  else
    local rc=$?; recover_cutover "activate failed"; return "$rc"
  fi
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
  assert_bluegreen_layout
  WITH_DIST=1   # 蓝绿:前端变更=建含新 dist 的完整 release + 原子翻转(同 deploy,一次重启)
  build_release || { echo "✗ build_release 失败,未激活(live 未改)" >&2; exit 1; }
  # hotcfg 启用时同样走 tuple saga(master 源码翻转=extra_apply,单次重启)。纯前端变更下
  # bundle/release digest 不变 → 幂等复用零 churn;tuple env 不变 → 只是随本次重启一并生效。
  # R2-B1:--disable-* 同 deploy(),该轴不 build 但强制走 saga 写空值。
  local hc_bundle=0 hc_release=0 hc_any=0
  if hotcfg_bundle_axis_on; then hc_bundle=1; hc_any=1; fi
  if hotcfg_release_axis_on; then hc_release=1; hc_any=1; fi
  [[ "$DISABLE_BUNDLE_FLAG" == 1 || "$DISABLE_RELEASE_FLAG" == 1 ]] && hc_any=1
  if [[ "$hc_any" == 1 ]]; then
    if [[ "$hc_bundle" == 1 ]]; then build_platform_bundle || { echo "✗ platform bundle 构建失败(live 未改)" >&2; exit 1; }; fi
    if [[ "$hc_release" == 1 ]]; then build_runtime_release || { echo "✗ runtime release 构建失败(live 未改)" >&2; exit 1; }; fi
    activate_runtime_tuple || { echo "✗ tuple 激活失败(saga 已自动回滚)" >&2; exit 1; }
  else
    activate_release "$BUILT_RELEASE"
  fi
  [[ "$DRY" == 1 ]] || smoke
  dist_handshake_smoke
  gc_releases
  [[ "$hc_any" == 1 ]] && gc_runtime_artifacts
  echo "✓ dist deploy 完成(release=$BUILT_RELEASE)。"
}

# ───────────────────────── rollback ─────────────────────────
rollback() {
  echo "══ v5 rollback(蓝绿:symlink 回切,秒级)══"
  assert_bluegreen_layout
  # hotcfg 启用 → tuple 感知回滚:master 源码 symlink 与 runtime tuple(env 四键+current)是同一
  # deploy 的一对孪生产物,必须从**同一条** history 记录一起翻回(M7:master 与 tuple 不再各取一源)。
  # R2-B1:两轴刚被 --disable(env 已空)时 enabled 判定全 0,但 history 有账 → 仍须走 tuple 感知
  # 路径才能"退回启用态";故入口判定并上 hotcfg_history_present。
  if hotcfg_bundle_enabled || hotcfg_release_enabled || hotcfg_history_present; then
    if [[ "$DRY" == 1 ]]; then
      echo "  [dry-run] hotcfg rollback:读 history 倒数第 $((ROLLBACK_N+1)) 条 committed(master+tuple 同源)→ saga 全量恢复(env 四键逐字面含空值+current+master 源码+.prev-release+restart+smoke)"
      return 0
    fi
    rollback_runtime_tuple "$ROLLBACK_N" || { echo "✗ tuple 回滚失败(saga 已自动恢复现场)" >&2; exit 1; }
    smoke
    echo "✓ rollback(tuple 感知,master+tuple 同条 history)完成。"
    return 0
  fi
  # 非 hotcfg:N=1 → .prev-release 记录的上一个;N>1 → 按 mtime 第 N 个更老的 release
  local target
  if [[ "$ROLLBACK_N" == 1 ]]; then
    target="$(ssh "$KL_HOST" "cat '$RELEASES_ROOT/.prev-release' 2>/dev/null || true")"
  else
    target="$(ssh "$KL_HOST" "ls -1dt '$RELEASES_ROOT'/rel-* 2>/dev/null | sed -n '$((ROLLBACK_N+1))p'")"
  fi
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] rollback → ${target:-<第$ROLLBACK_N个更老release>}"; activate_release "${target:-<dry>}"; return 0
  fi
  [[ -n "$target" ]] || { echo "✗ 找不到回滚目标(N=$ROLLBACK_N;.prev-release 或第 N 个更老 release 不存在)" >&2; exit 1; }
  ssh "$KL_HOST" "test -d '$target'" || { echo "✗ 回滚目标目录不存在: $target" >&2; exit 1; }
  activate_release "$target"
  smoke
  echo "✓ rollback 完成 → $target。"
}

# tuple 感知回滚(M7):从**同一条** history 记录(倒数第 N+1 条 committed;last=当前 live,故
# N=1→倒数第2条=上一激活)同时取回 master 源码目录(masterRelease)与 runtime tuple(image/id/
# release/bundle),一起走同一激活 saga(任一步失败自动恢复现场)。成功后 history 追加一条(=回滚也
# 留痕,last committed 恒=live)。根治旧实现"master 从 .prev-release、tuple 从 history 各取一源"的错位。
rollback_runtime_tuple() {
  local n="$1" nth=$((n+1)) prev image image_id release bundle master flip_rev prev_src old_prev restart_cmd smoke_cmd extra_apply extra_revert
  prev="$(hotcfg_rmt oc_hotcfg_history_nth_committed "$OC_HOTCFG_HISTORY" "$nth")"
  [[ -n "$prev" ]] || { echo "✗ history 无倒数第 $nth 条 committed tuple 可回滚(N=$n)" >&2; return 1; }
  image="$(jq -r '.image' <<<"$prev")"; image_id="$(jq -r '.image_id' <<<"$prev")"
  release="$(jq -r '.release' <<<"$prev")"; bundle="$(jq -r '.bundle' <<<"$prev")"
  master="$(jq -r '.masterRelease // ""' <<<"$prev")"
  [[ -n "$master" ]] || { echo "✗ 目标 history 记录缺 masterRelease 字段,无法对齐回滚 master 源码(旧格式 history?)" >&2; return 1; }
  ssh "$KL_HOST" "test -d '$master'" || { echo "✗ 目标 master release 目录不存在(可能已被 GC): $master" >&2; return 1; }
  # R2-B1:是否翻 current 由**目标记录的 bundle 值**决定(逐字面恢复:目标空=当时该轴禁用 → 不翻;
  # 目标非空=当时启用 → 必翻回,即使当前 env 已被 --disable 清空)。不再看当前 enabled 态。
  flip_rev=""
  if [[ -n "$bundle" && "$bundle" == "$OC_HOTCFG_PLATFORM_ROOT"/bundles/* ]]; then
    flip_rev="${bundle##*/}"
  fi
  prev_src="$(bg_current_release)"   # 当前 master 源码(回滚后成为新的 .prev-release)
  # M7c:快照翻转前的 .prev-release,saga 失败时一并还原
  old_prev="$(ssh "$KL_HOST" "cat '$RELEASES_ROOT/.prev-release' 2>/dev/null || true")"
  restart_cmd="systemctl restart '$V5_UNIT'"
  smoke_cmd="$(hotcfg_core_smoke_cmd)"
  extra_apply="printf '%s\n' '$prev_src' > '$RELEASES_ROOT/.prev-release.tmp' && mv -f '$RELEASES_ROOT/.prev-release.tmp' '$RELEASES_ROOT/.prev-release'; rm -f '$REMOTE_SRC.hotlink'; ln -s '$master' '$REMOTE_SRC.hotlink'; mv -T '$REMOTE_SRC.hotlink' '$REMOTE_SRC'"
  extra_revert="printf '%s\n' '$old_prev' > '$RELEASES_ROOT/.prev-release.tmp' && mv -f '$RELEASES_ROOT/.prev-release.tmp' '$RELEASES_ROOT/.prev-release'; rm -f '$REMOTE_SRC.hotlink'; ln -s '$prev_src' '$REMOTE_SRC.hotlink'; mv -T '$REMOTE_SRC.hotlink' '$REMOTE_SRC'"
  echo "  回滚到倒数第 $nth 条 committed tuple(同条恢复,四键逐字面含空值): image_id=$image_id release=${release:-<none>} bundle=${flip_rev:-<none>} master源码=$master"
  # 新 committed 条目 masterRelease=$master(=回滚到的 master),last committed 恒=live。
  # 末参 prev_master(R2-B2)仅供首启 pre-state;回滚时 history 必已有 committed 条目,不会触发。
  hotcfg_rmt oc_hotcfg_activate_saga \
    "$V5_ENV" "$OC_HOTCFG_PLATFORM_ROOT" "$flip_rev" "$OC_HOTCFG_HISTORY" \
    "$image" "$image_id" "$release" "$bundle" \
    "$restart_cmd" "$smoke_cmd" "$extra_apply" "$extra_revert" "$master" "$prev_src"
}

# ── 全局部署互斥(硬机制,2026-07-10 boss 指令:多会话并发改 v5 不靠记忆自觉)──
# 同机所有 deploy-v5.sh 写模式实例串行:并发 rsync/restart 交错会产生半新半旧源码树
# 与连环重启。锁文件记录持有者(pid/mode/tree/时刻)供另一会话诊断;等待 ≤900s 后
# fail-loud。只读模式(--dry-run / --smoke)不抢锁。cutover 自有的 CUTOVER_LOCK 是
# 远端状态机锁,与本地这把互斥锁正交,两把都要。
DEPLOY_LOCK="/var/lock/oc-v5-deploy.lock"
if [[ "$DRY" != 1 && "$MODE" != "smoke" ]]; then
  exec 8>"$DEPLOY_LOCK"
  if ! flock -n 8; then
    echo "⏳ 部署锁被占:$(cat "${DEPLOY_LOCK}.holder" 2>/dev/null || echo '持有者未知')"
    echo "   等待释放(≤900s;另一会话部署完成后自动继续)..."
    flock -w 900 8 || { echo "✗ 900s 未取得部署锁 —— 另一会话的部署可能挂死,人工核查 ${DEPLOY_LOCK}.holder 后处置" >&2; exit 3; }
  fi
  printf 'pid=%s mode=%s tree=%s started=%s\n' "$$" "$MODE" "$REPO_ROOT" "$(date -Is)" > "${DEPLOY_LOCK}.holder"
  trap 'rm -f "${DEPLOY_LOCK}.holder"' EXIT
fi

case "$MODE" in
  bootstrap) bootstrap ;;
  migrate-bluegreen) migrate_to_bluegreen ;;
  smoke)     smoke ;;
  deploy)    deploy ;;
  dist)      deploy_dist ;;
  emergency-tuple) emergency_tuple ;;
  activate-emergency-tuple) activate_emergency_tuple ;;
  prepare-offline-cutover) assert_not_bluegreen_for_cutover; prepare_offline_cutover ;;
  offline-recycle) assert_not_bluegreen_for_cutover; offline_recycle ;;
  stage)     assert_not_bluegreen_for_cutover; stage ;;
  activate-staged) assert_not_bluegreen_for_cutover; activate_staged ;;
  rollback)  rollback ;;
esac
