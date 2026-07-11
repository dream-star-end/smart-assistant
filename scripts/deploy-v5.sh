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
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    # 代码+前端两生效面合并为一次重启(见 deploy() 内注释,2026-07-10 成对重启事故)
    --with-dist) WITH_DIST=1 ;;
    --bootstrap) MODE="bootstrap" ;;
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
  local commit builtAt tag
  commit="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  builtAt="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  tag="v5-$commit"
  local json="{\"tag\":\"$tag\",\"commit\":\"$commit\",\"channel\":\"v5\",\"builtAt\":\"$builtAt\"}"
  if [[ "$DRY" == 1 ]]; then echo "  [dry-run] write VERSION.json: $json"; return; fi
  ssh "$KL_HOST" "cat > '$REMOTE_SRC/VERSION.json'" <<<"$json"
  echo "  ✓ VERSION.json: $json"
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
  echo "── rsync v5 源码 ──"
  run "rsync -az --delete ${RSYNC_EXCLUDES[*]} '$REPO_ROOT/' '$KL_HOST:$REMOTE_SRC/'"
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
  allowed="subscriptionRollover accountSlotReaper researchJobs codexRefresh codexDriftReconciler marketplaceAiReview orphanReconcile providerHealth wecomAlert cronWake connectorSweeper"
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
  snapshot_and_sync_source
  echo "── 部署顺序守卫:校验 runtime_channel 列(0088)已应用 ──"
  assert_runtime_channel_column
  # --with-dist:dist 在 restart **之前**全部就位 → 代码+前端两生效面共享**一次**重启。
  # 背景(2026-07-10 事故放大器):deploy 后紧跟 --dist 的成对重启(间隔 30-60s)会把
  # 「刚被第一次重启打断、自动续写刚跑起来」的 turn 第二次掐死。禁止再回到两段式。
  if [[ "$WITH_DIST" == 1 ]]; then
    build_and_sync_dist
  fi
  echo "── restart openclaude-v5(仅 v5,绝不碰 v3)──"
  sshk "systemctl restart $V5_UNIT"
  run "sleep 4"
  if [[ "$RESTART_EGRESS" == 1 ]]; then
    echo "── restart openclaude-v5-egress(显式 --egress;SIGTERM drain 在飞流)──"
    sshk "systemctl restart openclaude-v5-egress"
    run "sleep 3"
  fi
  [[ "$DRY" == 1 ]] || smoke
  if [[ "$WITH_DIST" == 1 ]]; then
    dist_handshake_smoke
  fi
  echo "✓ deploy 完成。"
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
  echo "══ v5 dist deploy(前端生效面)on $KL_HOST ══"
  build_and_sync_dist
  echo "── restart openclaude-v5(dist 生效面必重启,版本握手依赖此纪律)──"
  sshk "systemctl restart $V5_UNIT"
  run "sleep 4"
  [[ "$DRY" == 1 ]] || smoke
  dist_handshake_smoke
  echo "✓ dist deploy 完成。"
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
  deploy)    deploy ;;
  smoke)     smoke ;;
  dist)      deploy_dist ;;
  prepare-offline-cutover) prepare_offline_cutover ;;
  offline-recycle) offline_recycle ;;
  stage)     stage ;;
  activate-staged) activate_staged ;;
  rollback)  rollback ;;
esac
