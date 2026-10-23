#!/usr/bin/env bash
# Diagnostics use the live release. No source-time work or path resets.

cmd_smoke() {
  local hz i ok=0 code
  log "══ selfhost smoke ══"
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] curl healthz + leadership=leader + GET / oc-build + SSH 规则 + 个人版 18789"
    return 0
  fi
  for i in $(seq 1 90); do
    hz="$(curl -fsS --max-time 5 "http://127.0.0.1:${V5_PORT}/healthz" 2>/dev/null || true)"
    if echo "$hz" | jq -e '.ok==true and .runtime.controlPlaneEnabled==true and .runtime.leadership.state=="leader"' >/dev/null 2>&1; then
      ok=1
      break
    fi
    log "  /healthz 未收敛 leadership=leader,重试 $i/30…"
    sleep 2
  done
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${V5_PORT}/healthz" || true)"
  [[ "$code" == 200 ]] || die "selfhost /healthz HTTP $code(期望 200)。补救: journalctl -u $V5_UNIT -n 80。"
  [[ "$ok" == 1 ]] || die "healthz HTTP 200 但未收敛: ok=true 且 runtime.controlPlaneEnabled=true 且 runtime.leadership.state=leader。
  最近响应: ${hz:-<empty>}
  说明: V5 channel 走 leader lease(不是只看 OC_CONTROL_PLANE_LEADER);0135 seed desired_leader_slot=A,本实例 OC_SLOT 默认 A。补救: 查 journalctl 是否拒启,以及 deploy_state / leader_lease 行。"
  log "  ✓ /healthz 200 + controlPlaneEnabled + leadership.state=leader"
  local dist_html="" live_root=""
  if [[ -L "$MASTER_LIVE_LINK" ]]; then
    live_root="$(readlink -f "$MASTER_LIVE_LINK" 2>/dev/null || true)"
    if [[ -n "$live_root" && -f "$live_root/packages/web-react/dist/index.html" ]]; then
      dist_html="$live_root/packages/web-react/dist/index.html"
    fi
  fi
  if [[ -z "$dist_html" ]]; then
    dist_html="$REPO_ROOT/packages/web-react/dist/index.html"
  fi
  [[ -f "$dist_html" ]] \
    || die "缺 SPA dist/index.html($dist_html)。master 从 live release 的 packages/web-react/dist serve。补救: 重跑 --deploy。"
  local html spa_ok=0 expected_build got_build
  expected_build="$(grep -o 'name="oc-build" content="[0-9a-f]\{8,32\}"' "$dist_html" | grep -o '[0-9a-f]\{8,32\}' | head -1 || true)"
  for i in $(seq 1 15); do
    html="$(curl -fsS --max-time 5 "http://127.0.0.1:${V5_PORT}/" 2>/dev/null || true)"
    if echo "$html" | grep -q 'name="oc-build"'; then
      spa_ok=1
      break
    fi
    log "  GET / 尚未 serve SPA,重试 $i/15…"
    sleep 2
  done
  [[ "$spa_ok" == 1 ]] \
    || die "GET / 不是 SPA index.html(缺 oc-build meta)。补救: 确认 OC_RUNTIME_CHANNEL=v5 且 dist 已构建后 restart master。"
  got_build="$(echo "$html" | grep -o 'name="oc-build" content="[0-9a-f]\{8,32\}"' | grep -o '[0-9a-f]\{8,32\}' | head -1 || true)"
  if [[ -n "$expected_build" && -n "$got_build" && "$got_build" != "$expected_build" ]]; then
    die "GET / oc-build=$got_build 不等于 ${dist_html} 的 $expected_build。补救: 确认 live 指向本次 release 后 restart master。"
  fi
  log "  ✓ GET / 返回 SPA index.html(oc-build=${got_build:-present} src=${dist_html})"
  assert_ssh_rule_before_drop
  assert_personal_alive
  log "  ✓ 个人版 $PERSONAL_UNIT 仍 active 且 :$PERSONAL_PORT 仍 200"
  host_log_policy_check_release "$live_root" || return $?
  assert_watch_matches_live "$live_root"
  log "✓ smoke 通过"
}

# One state word per unit. `systemctl is-active` prints "inactive"/"failed" AND exits
# non-zero, so `$(systemctl is-active X || echo n/a)` printed two lines (OCV5-449).
status_unit_state() { # <unit> [fallback]
  local s
  s="$(systemctl is-active "$1" 2>/dev/null)" || true
  printf '%s' "${s:-${2:-n/a}}"
}

cmd_status() {
  local live_now prev_now status_rc=0
  log "══ selfhost status ══"
  log "  worktree: $REPO_ROOT"
  log "  HEAD: $(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo '?')"
  if [[ -L "$MASTER_LIVE_LINK" ]]; then
    live_now="$(readlink -f "$MASTER_LIVE_LINK" 2>/dev/null || echo dangling)"
    log "  live: $MASTER_LIVE_LINK → $live_now"
  else
    log "  live: MISSING $MASTER_LIVE_LINK"
  fi
  if [[ -f "$MASTER_RELEASES_ROOT/.prev-release" ]]; then
    prev_now="$(tr -d '[:space:]' <"$MASTER_RELEASES_ROOT/.prev-release")"
    log "  prev: $prev_now"
  else
    log "  prev: MISSING"
  fi
  log "  env: $V5_ENV $([ -f "$V5_ENV" ] && echo present || echo MISSING) mode=$(stat -c %a "$V5_ENV" 2>/dev/null || echo -)"
  if [[ -f "$V5_ENV" ]]; then
    log "  OC_RUNTIME_IMAGE=$(oc_hotcfg_env_get "$V5_ENV" OC_RUNTIME_IMAGE)"
    log "  OC_RUNTIME_IMAGE_ID=$(oc_hotcfg_env_get "$V5_ENV" OC_RUNTIME_IMAGE_ID)"
    log "  OC_RUNTIME_RELEASE=$(oc_hotcfg_env_get "$V5_ENV" OC_RUNTIME_RELEASE)"
    log "  OC_PLATFORM_BUNDLE=$(oc_hotcfg_env_get "$V5_ENV" OC_PLATFORM_BUNDLE)"
    log "  OC_CONTROL_PLANE_LEADER=$(oc_hotcfg_env_get "$V5_ENV" OC_CONTROL_PLANE_LEADER)"
  fi
  log "  unit master:  $(status_unit_state "$V5_UNIT" n/a)"
  log "  unit egress:  legacy=$(status_unit_state "$V5_EGRESS_UNIT" n/a) slotA=$(status_unit_state "$(egress_slot_unit A service)" n/a) slotB=$(status_unit_state "$(egress_slot_unit B service)" n/a) serving=$(egress_describe_topology) tcp_migrate_req=$(sysctl -n net.ipv4.tcp_migrate_req 2>/dev/null || echo n/a)"
  log "  unit hostnet: $(status_unit_state "$V5_HOSTNET_UNIT" n/a)"
  log "  unit ccb-proxy: $(status_unit_state "$V5_CCB_PROXY_UNIT" n/a)"
  log "  unit sshgate: $(status_unit_state "$V5_SSHGATE_UNIT" n/a)"
  # tunnel 是公网入口,不随部署自动 enable —— 由人显式决定是否对外暴露。
  log "  unit tunnel:  $(status_unit_state "$V5_TUNNEL_UNIT" inactive) (enable 后跑 scripts/selfhost-sync-tunnel-url.sh --apply)"
  # What is served is the live release, not this worktree (OCV5-449).
  if [[ -n "${live_now:-}" && -d "$live_now" ]]; then
    if [[ -f "$live_now/packages/web-react/dist/index.html" ]]; then
      log "  spa dist:    present (live)"
    else
      log "  spa dist:    MISSING (live $live_now)"
    fi
    if [[ -f "$live_now/.complete" ]]; then
      log "  .complete:   present (live) $(jq -er '.sourceCommit' "$live_now/.complete" 2>/dev/null || echo '?')"
    else
      log "  .complete:   MISSING (live $live_now)"
    fi
  else
    log "  spa dist:    n/a (no live release)"
    log "  .complete:   n/a (no live release)"
  fi
  host_log_policy_check_release "${live_now:-}" || status_rc=$?
  log "  watch:       $(watch_summary "${live_now:-}")"
  log "  gate-fail:   policy=$(gate_fail_policy 2>/dev/null) survivor-phase=$(sed -n 's/^phase=//p' "${SURVIVOR_STATE:-/run/openclaude-v5-selfhost/cutover-survivor.state}" 2>/dev/null | head -n1 || true) maint=$(sed -n 's/^until=//p' "$V5_WATCH_MAINT" 2>/dev/null | head -n1 || true)"
  if [[ -f "$V5_ENV" ]]; then
    log "  OC_SESSIONS_STORE=$(oc_hotcfg_env_get "$V5_ENV" OC_SESSIONS_STORE)"
    log "  env keys:    $(bash "$SCRIPT_DIR/v5-selfhost-env-drift.sh" --env "$V5_ENV" --quiet \
      --template "$REPO_ROOT/deploy/v5-selfhost/commercial-v5-selfhost.env.template" 2>&1 | tail -n1 || true)"
  fi
  log "  personal:     $(status_unit_state "$PERSONAL_UNIT" n/a)"
  if docker network inspect openclaude-v5-net >/dev/null 2>&1; then
    log "  net: openclaude-v5-net 存在"
  else
    log "  net: openclaude-v5-net 不存在"
  fi
  if sudo -u postgres psql -X -tAc "SELECT 1 FROM pg_database WHERE datname='${PG_DB}'" >/dev/null 2>&1; then
    if pg_db_exists; then
      log "  pg: $PG_DB 存在"
    else
      log "  pg: $PG_DB 不存在"
    fi
  else
    log "  pg: 无法查询(postgres 不可达)"
  fi
  local p
  for p in "$V5_PORT" "$V5_EGRESS_PORT" "$PERSONAL_PORT"; do
    if port_in_use "$p"; then log "  port $p: listen"; else log "  port $p: idle"; fi
  done
  return "$status_rc"
}
