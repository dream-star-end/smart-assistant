# shellcheck shell=bash
# deploy-v5-selfhost.sh --p0-web / --p0-web-revert / --p0-web-status(OCV5-489)。
#
# P0-Web = 纯前端静态面的热修:只换 master serve 的前端构建目录(overlay 指针),不重启
# master、不碰 runtime tuple / egress / 模型目录,所以不重建用户容器、不打断在飞回合。
# 流程:资格判定(相对 live sourceCommit 只改前端静态面)→ 只解出前端构建输入在临时目录构建
# (live release 的 node_modules)→ 组装 webroot(旧 assets ∪ 新构建)→ 切换前静态门 →
# 持发布锁原子换指针 → 握手 + 资产面 + E2E J1-J5 → 后端快照前后一致;任一失败自动换回。
#
# 被部署脚本 source:复用其 die/log/锁/端口/canary 口径;纯函数在 v5-web-overlay-lib.sh。
# 普通发布侧:cutover 给新 release 建指针(wo_seed_pointer),--deploy 拒绝不包含当前 overlay
# sourceCommit 的目标(防 P0 修复被回退)。

P0WEB_CANARY_PASSWORD_FILE="${P0WEB_CANARY_PASSWORD_FILE:-/etc/openclaude/selfhost-canary.password}"
P0WEB_BUILD_DIR=""

# 换指针之后、判定通过之前,任何退出(die / set -e / 信号)都由 EXIT trap 切回原指针。
P0WEB_REVERT_BUCKET=""
P0WEB_REVERT_TARGET=""

p0web_cleanup_build() {
  if [[ -n "$P0WEB_REVERT_BUCKET" && -n "$P0WEB_REVERT_TARGET" ]]; then
    echo "✗ --p0-web 中途退出 → 切回 $P0WEB_REVERT_TARGET" >&2
    wo_point "$P0WEB_REVERT_BUCKET" "$P0WEB_REVERT_TARGET" \
      || echo "✗✗ 切回失败,人工核查 $P0WEB_REVERT_BUCKET/current" >&2
    P0WEB_REVERT_BUCKET=""
    P0WEB_REVERT_TARGET=""
  fi
  [[ -n "$P0WEB_BUILD_DIR" && -d "$P0WEB_BUILD_DIR" ]] && rm -rf -- "$P0WEB_BUILD_DIR"
  P0WEB_BUILD_DIR=""
}

p0web_live_release() {
  [[ -L "$MASTER_LIVE_LINK" ]] || die "缺 live symlink $MASTER_LIVE_LINK"
  readlink -f -- "$MASTER_LIVE_LINK"
}

p0web_live_bucket() { # <live-rel>
  local bucket
  bucket="$(wo_bucket "$WEB_OVERLAY_ROOT" "$1")" || die "live 不是 rel-* release: $1"
  [[ -L "$bucket/current" ]] || die "live release 还没有 overlay 指针($bucket/current)。
补救: 先用一次普通 --deploy 发布含 OCV5-489 的版本(cutover 会建指针,master 启动时接上)。"
  printf '%s\n' "$bucket"
}

# 只解出前端构建输入(与 build_master_release 的 web dist key 同一口径),用 live release 的
# node_modules 构建。资格判定保证 lock / package.json 与 live 相同,依赖就是 live 那份。
# 结果写全局 P0WEB_DIST(不走命令替换:构建目录要留在本进程里由 EXIT trap 清理)。
P0WEB_DIST=""
p0web_build() { # <sha> <live-rel>
  local sha="$1" live="$2" paths=() p
  for p in "${WEB_DIST_KEY_PATHS[@]}"; do
    [[ "$p" == scripts/* ]] || paths+=("$p")
  done
  P0WEB_BUILD_DIR="$WEB_OVERLAY_ROOT/.build.${sha:0:12}.$$"
  rm -rf -- "$P0WEB_BUILD_DIR"
  mkdir -p -- "$P0WEB_BUILD_DIR" || die "无法创建构建目录 $P0WEB_BUILD_DIR"
  git -C "$REPO_ROOT" archive "$sha" -- "${paths[@]}" | tar -x -C "$P0WEB_BUILD_DIR" \
    || die "git archive $sha 前端构建输入失败"
  ln -s -- "$live/node_modules" "$P0WEB_BUILD_DIR/node_modules"
  log "  构建 web-react @ ${sha:0:12}(tsc -b && vite build,node_modules=live)"
  ( cd "$P0WEB_BUILD_DIR/packages/web-react" && NODE_OPTIONS='--max-old-space-size=4096' npm run build ) \
    || die "web-react 构建失败(线上未变)"
  P0WEB_DIST="$P0WEB_BUILD_DIR/packages/web-react/dist"
}

# 后端不变的证据:master / egress 进程、runtime tuple env、/version。P0-Web 不应改动其中任何一项。
p0web_backend_snapshot() {
  local tuple ver
  tuple="$({ grep -E '^(OC_RUNTIME_RELEASE|OC_PLATFORM_BUNDLE|OC_RUNTIME_IMAGE[A-Z_]*)=' "$V5_ENV" || true; } | LC_ALL=C sort | sha256sum | cut -c1-16)"
  ver="$(curl -fsS --max-time 5 "http://127.0.0.1:${V5_PORT}/version" 2>/dev/null | jq -c . 2>/dev/null || echo none)"
  printf 'master=%s egressA=%s egressB=%s tuple=%s version=%s\n' \
    "$(systemctl show -p MainPID -p ExecMainStartTimestampMonotonic --value "$V5_UNIT" | paste -sd/)" \
    "$(systemctl show -p MainPID --value "$(egress_slot_unit A service)")" \
    "$(systemctl show -p MainPID --value "$(egress_slot_unit B service)")" \
    "$tuple" "$ver"
}

p0web_epoch() {
  psql_as_postgres -d "$PG_DB" -tAc 'SELECT epoch FROM model_security_epoch WHERE id' 2>/dev/null | tr -d '[:space:]' || true
}

# 线上 GET / 的 oc-build 等于期望,且 index.html / admin.html 引用的每个 /assets/* 都 200。
p0web_handshake() { # <expected-build>
  local want="$1" base="http://127.0.0.1:${V5_PORT}" html="" got="" ref code page bad=0
  for _ in $(seq 1 10); do
    html="$(curl -fsS --max-time 5 "$base/" 2>/dev/null || true)"
    got="$(grep -o 'name="oc-build" content="[0-9a-f]\{8,32\}"' <<<"$html" | grep -o '[0-9a-f]\{8,32\}' | head -1 || true)"
    [[ "$got" == "$want" ]] && break
    sleep 1
  done
  [[ "$got" == "$want" ]] || { log "  ✗ 线上 oc-build=${got:-空} ≠ $want"; return 1; }
  for page in / /admin.html; do
    while IFS= read -r ref; do
      [[ -n "$ref" ]] || continue
      code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$base$ref" || true)"
      [[ "$code" == 200 ]] || { log "  ✗ $page 引用的 $ref → HTTP $code"; bad=1; }
    done < <(curl -fsS --max-time 5 "$base$page" | grep -oE '(src|href)="/assets/[^"?#]+' | sed -E 's/^(src|href)="//' | sort -u)
  done
  [[ "$bad" == 0 ]] || return 1
  log "  ✓ 握手:oc-build=$got,index/admin 引用的 assets 全部 200"
}

p0web_journey() {
  [[ -s "$P0WEB_CANARY_PASSWORD_FILE" && -r "$P0WEB_CANARY_PASSWORD_FILE" ]] \
    || { log "  ✗ canary 密码文件缺失/不可读: $P0WEB_CANARY_PASSWORD_FILE"; return 1; }
  log "── E2E 旅程门 J1-J5(真浏览器,canary,直连 127.0.0.1:${V5_PORT})──"
  V5_E2E_BASE="http://127.0.0.1:${V5_PORT}" \
    V5_CANARY_EMAIL="${V5_CANARY_EMAIL:-v5-selfhost-canary@claudeai.chat}" \
    V5_CANARY_PASSWORD="$(<"$P0WEB_CANARY_PASSWORD_FILE")" \
    timeout 510 node "$SCRIPT_DIR/v5-e2e-journey-canary.mjs"
}

cmd_p0_web() {
  local t0 sha live live_sha active bucket bad dist build webroot prev prev_build pre post fail="" epoch0 epoch1
  t0="$(date +%s)"
  log "══ v5 selfhost --p0-web(前端构建目录热切换;不重启 master、不动 runtime/egress/目录)══"
  [[ "$LEASE_TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] || die "--p0-web 需要 --target-sha=<40 位 sha>"
  sha="$LEASE_TARGET_SHA"
  live="$(p0web_live_release)"
  bucket="$(p0web_live_bucket "$live")"
  live_sha="$(jq -er '.sourceCommit' "$live/.complete")" || die "读不到 live .complete sourceCommit"
  git -C "$REPO_ROOT" fetch -q origin feat/v5-selfhost || die "git fetch origin feat/v5-selfhost 失败"
  git -C "$REPO_ROOT" merge-base --is-ancestor "$sha" origin/feat/v5-selfhost \
    || die "目标 $sha 不在已推送的 origin/feat/v5-selfhost 上"
  git -C "$REPO_ROOT" merge-base --is-ancestor "$live_sha" "$sha" \
    || die "目标不包含 live sourceCommit ${live_sha:0:12}:P0-Web 只能在 live 之上前进"
  active="$(wo_active_overlay_commit "$WEB_OVERLAY_ROOT" "$live")" || die "读不到当前 overlay 元数据"
  if [[ -n "$active" ]]; then
    git -C "$REPO_ROOT" merge-base --is-ancestor "$active" "$sha" \
      || die "目标不包含当前生效的 P0-Web 修复 ${active:0:12}:只能前进,不能覆盖已上线的修复"
  fi
  log "── 资格:live ${live_sha:0:12} → 目标 ${sha:0:12} 只改前端静态面 ──"
  bad="$(wo_check_surface "$REPO_ROOT" "$live_sha" "$sha")" \
    || die "不能走 P0-Web(请走普通 --deploy)。不在前端静态面的改动:
${bad:-<见上方错误>}"
  assert_fix_trailers "$sha"
  p0web_build "$sha" "$live"
  dist="$P0WEB_DIST"
  build="$(wo_build_id_of "$dist")" || die "新 dist 缺 oc-build"
  webroot="$(wo_stage_webroot "$bucket" "$dist" "$sha" "$live")" || die "组装 webroot 失败(线上未变)"
  p0web_cleanup_build
  wo_static_gate "$webroot" "$build" || die "切换前静态门失败(线上未变)"
  log "  ✓ webroot=$webroot oc-build=$build(构建+组装 $(( $(date +%s) - t0 ))s)"

  acquire_selfhost_deploy_lock
  [[ "$(readlink -f -- "$MASTER_LIVE_LINK")" == "$live" ]] \
    || die "等锁期间 live release 变了($live → $(readlink -f -- "$MASTER_LIVE_LINK"))。重跑 --p0-web。"
  prev="$(wo_current_target "$bucket")" || die "读不到当前指针"
  [[ "$prev" == "$(wo_staged_from "$webroot")" ]] \
    || die "等锁期间前端指针变了(组装基线 $(wo_staged_from "$webroot") → 现在 $prev),新 webroot 可能缺新上线的 chunk。重跑 --p0-web。"
  prev_build="$(wo_build_id_of "$prev")" || die "当前指针目标缺 oc-build: $prev"
  pre="$(p0web_backend_snapshot)"
  epoch0="$(p0web_epoch)"
  P0WEB_REVERT_BUCKET="$bucket"
  P0WEB_REVERT_TARGET="$prev"
  wo_point "$bucket" "$webroot" || die "换指针失败"
  wo_append_history "$bucket" "$webroot" "$build" "$sha" || fail="history 写入失败"
  log "  ✓ 已切换 $prev_build → $build(+$(( $(date +%s) - t0 ))s)"

  if [[ -z "$fail" ]]; then p0web_handshake "$build" || fail="握手/资产面"; fi
  if [[ -z "$fail" ]]; then p0web_journey || fail="E2E J1-J5"; fi
  post="$(p0web_backend_snapshot)"
  if [[ -z "$fail" && "$pre" != "$post" ]]; then fail="后端快照变化(pre=$pre post=$post)"; fi
  epoch1="$(p0web_epoch)"
  [[ "$epoch0" == "$epoch1" ]] \
    || log "  ⚠ model_security_epoch 窗口内 $epoch0 → $epoch1(P0-Web 不写库;是别处的目录操作)"
  if [[ -n "$fail" ]]; then
    log "  ✗ $fail → 自动切回 $prev_build"
    P0WEB_REVERT_BUCKET=""
    P0WEB_REVERT_TARGET=""
    wo_point "$bucket" "$prev" || die "--p0-web 失败:$fail;切回也失败,人工核查 $bucket/current"
    wo_append_history "$bucket" "$prev" "$prev_build" "revert" || log "  ⚠ 切回已生效,history 未记"
    p0web_handshake "$prev_build" || log "  ⚠ 切回后握手未通过,人工核查 $bucket/current"
    die "--p0-web 失败:$fail;已切回 $prev_build(用时 $(( $(date +%s) - t0 ))s)"
  fi
  P0WEB_REVERT_BUCKET=""
  P0WEB_REVERT_TARGET=""
  wo_gc_webroots "$bucket" || log "  ⚠ webroot GC 失败(仅告警)"
  log "✓ --p0-web 完成 oc-build=$build sha=${sha:0:12} 用时 $(( $(date +%s) - t0 ))s;后端快照不变:$post"
  log "  回滚: scripts/deploy-v5-selfhost.sh --p0-web-revert(秒级,不重启)"
}

cmd_p0_web_revert() {
  local live bucket cur target build
  live="$(p0web_live_release)"
  bucket="$(p0web_live_bucket "$live")"
  acquire_selfhost_deploy_lock
  cur="$(wo_current_target "$bucket")" || die "读不到当前指针 $bucket/current"
  target="$(wo_previous_target "$bucket" 1)" || die "history 里没有可回退的上一份($bucket/history)"
  build="$(wo_build_id_of "$target")" || die "回退目标缺 oc-build: $target"
  wo_point "$bucket" "$target" || die "换指针失败(线上未变)"
  wo_append_history "$bucket" "$target" "$build" "revert"
  log "  已切回 $(basename -- "$cur") → $build"
  p0web_handshake "$build" || die "已切回但握手未通过,人工核查 $bucket/current"
  log "✓ --p0-web-revert 完成"
}

cmd_p0_web_status() {
  local live bucket cur c
  live="$(p0web_live_release)"
  bucket="$(wo_bucket "$WEB_OVERLAY_ROOT" "$live")" || die "live 不是 rel-* release"
  log "live=$live"
  if ! cur="$(wo_current_target "$bucket")"; then
    log "overlay 指针:无(master 用 release 自带 dist,不能 --p0-web)"
    return 0
  fi
  c="$(wo_active_overlay_commit "$WEB_OVERLAY_ROOT" "$live" || true)"
  log "overlay 指针:$cur oc-build=$(wo_build_id_of "$cur" || echo '?') ${c:+P0-Web sourceCommit=$c}"
  [[ -f "$bucket/history" ]] && tail -n 5 "$bucket/history" | sed 's/^/  history: /'
}

# 普通 --deploy 前:live 上有生效的 P0-Web overlay 时,目标必须包含它的 sourceCommit。
assert_p0_web_overlay_contained() { # <target-sha>
  local live c
  [[ -L "$MASTER_LIVE_LINK" ]] || return 0
  live="$(readlink -f -- "$MASTER_LIVE_LINK")"
  c="$(wo_active_overlay_commit "$WEB_OVERLAY_ROOT" "$live")" \
    || die "无法判定 live 上的 P0-Web overlay 元数据($WEB_OVERLAY_ROOT)。补救: --p0-web-status 核查。"
  [[ -n "$c" ]] || return 0
  git -C "$REPO_ROOT" merge-base --is-ancestor "$c" "$1" \
    || die "live 上有生效的 P0-Web 修复(${c:0:12}),本次目标 ${1:0:12} 不包含它,发布会把修复回退。
补救: 先把 ${c:0:12} 合进目标分支再发。"
  log "  ✓ 目标包含 live 上的 P0-Web 修复 ${c:0:12}"
}
