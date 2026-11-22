#!/usr/bin/env bash
# OCV5-420 watch.sh --auto-recover 行为测试。只跑候选脚本,所有路径指向临时目录,不碰宿主标记。
# 健康用 file:// URL 模拟,让 tier2 的「恢复脚本」真的能把现场变绿。
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WATCH_SOURCE="${WATCH_BIN:-$DIR/v5-selfhost-watch.sh}"
if [[ "$(readlink -f "$WATCH_SOURCE")" == /opt/openclaude/v5-selfhost-watch/watch.sh ]]; then
  echo "REFUSE: 不测已安装副本" >&2
  exit 2
fi

pass=0
fail=0
ok() { pass=$((pass + 1)); echo "PASS $*"; }
bad() { fail=$((fail + 1)); echo "FAIL $*"; }

BASE="$(mktemp -d "${TMPDIR:-/tmp}/v5-watch-autorecover.XXXXXX")"
trap 'rm -rf "$BASE"' EXIT
BIN="$BASE/watch-fixture.sh"
# The test models CC5 absent/clear; the real recovery locks, probes and main
# still execute. Installed-source hash checks below keep using WATCH_SOURCE.
printf '#!/usr/bin/env bash\nsource %q\ncc5_activation_recovery_safe() { return 0; }\nmain "$@"\n' \
  "$WATCH_SOURCE" >"$BIN"
chmod 0700 "$BIN"

RED='{"ok":false}'
GREEN='{"ok":true,"deps":{"pg":"ok"}}'

setup() {
  C="$BASE/$1"
  mkdir -p "$C/run" "$C/inst" "$C/rel" "$C/backup"
  export WATCH_RUN_DIR="$C/run" WATCH_STATUS="$C/run/watch-status" WATCH_NOTIFY_STATE="$C/run/notify" \
    WATCH_LOG="$C/log" WATCH_DISARM="$C/inst/watch-disarmed" WATCH_MANUAL_RECOVERY="$C/rel/.manual-recovery-required" \
    WATCH_MAINT="$C/run/maint" WATCH_GRACE="$C/run/grace" WATCH_LOCK="$C/run/deploy.lock" \
    WATCH_FAIL_COUNT="$C/run/fail-count" WATCH_INSTALLED_BIN="$C/inst/watch.sh" WATCH_LIVE="$C/live" \
    WATCH_RELEASES_ROOT="$C/rel" WATCH_BACKUP_CURRENT="$C/backup" WATCH_RESTORE="$C/restore.sh" \
    WATCH_MASTER_URL="file://$C/master.json" WATCH_EGRESS_URL="file://$C/egress.json"
  export WATCH_DRY=0 WATCH_SKIP_ACTIONS=0 WATCH_REARM_CHECKS=2 WATCH_REARM_INTERVAL_SEC=0 WATCH_NOTIFY_COOLDOWN_SEC=86400 \
    WATCH_POST_RESTART_WAIT_SEC=0 WATCH_POST_RESTART_POLL_SEC=0
  export WATCH_STUB_UNIT_MASTER=active WATCH_STUB_UNIT_EGRESS=active WATCH_STUB_MASTER= WATCH_STUB_EGRESS=
  export WATCH_STUB_MASTER_BODY= WATCH_STUB_PG=ok WATCH_STUB_REDIS=ok WATCH_STUB_DOCKER=ok WATCH_STUB_JOURNAL=' ' WATCH_STUB_LOGTAIL=' '
  unset WATCH_STUB_FAIL_LOUD
  cp -- "$WATCH_SOURCE" "$WATCH_INSTALLED_BIN"
  printf '%s\n' "$GREEN" >"$C/master.json"
  printf '{"ok":true}\n' >"$C/egress.json"
  printf 'reason=tier1+tier2-failed\n' >"$WATCH_DISARM"
  printf 'until=1\nreason=tier1+tier2-failed\n' >"$WATCH_MANUAL_RECOVERY"
  printf '5\n' >"$WATCH_FAIL_COUNT"
  # 恢复脚本:记一笔,并按 FIXES 决定是否把 master 变绿。
  cat >"$C/restore.sh" <<EOS
#!/bin/sh
echo restored >>"$C/restore.calls"
[ "\${FIXES:-1}" = 1 ] && echo '$GREEN' >"$C/master.json"
exit 0
EOS
  chmod 0755 "$C/restore.sh"
}
ar() { set +e; OUT="$(bash "$BIN" --auto-recover "$@" 2>&1)"; EC=$?; set -e; }
markers_kept() { [[ -f "$WATCH_DISARM" && -f "$WATCH_MANUAL_RECOVERY" ]]; }
restores() { [[ -f "$C/restore.calls" ]] && wc -l <"$C/restore.calls" || echo 0; }

setup w1; ar
if [[ "$EC" == 0 && "$OUT" == *AUTORECOVER_GREEN* && ! -e "$WATCH_DISARM" && ! -e "$WATCH_MANUAL_RECOVERY" \
  && -n "$(find "$C/inst" -name 'watch-disarmed.autorearmed-*')" && -n "$(find "$C/rel" -name '.manual-recovery-required.autocleared-*')" \
  && "$(cat "$WATCH_FAIL_COUNT")" == 0 && "$(grep '^health=' "$WATCH_STATUS")" == health=green && "$(restores)" == 0 ]]; then
  ok "W1 stable green archives manual-recovery + disarm, resets count, no restore"
else bad "W1 ec=$EC out=$OUT"; fi

setup w2; rm -f "$WATCH_DISARM" "$WATCH_MANUAL_RECOVERY"; ar
[[ "$EC" == 0 && "$OUT" == *AUTORECOVER_GREEN* ]] && ok "W2 green without markers is a clean no-op" || bad "W2 ec=$EC out=$OUT"

setup w3; printf '%s\n' "$GREEN" >"$C/master.json"; printf '%s\n' "$RED" >"$C/master.json"; export WATCH_STUB_PG=inactive; ar
if [[ "$EC" == 3 && "$OUT" == *"AUTORECOVER_WAIT class=external-pg"* ]] && markers_kept && [[ "$(restores)" == 0 ]]; then
  ok "W3 external dependency down → wait (rc 3), no rollback, markers kept"
else bad "W3 ec=$EC out=$OUT"; fi

setup w4; printf '%s\n' "$RED" >"$C/master.json"; export WATCH_STUB_FAIL_LOUD=schema; ar
if [[ "$EC" == 3 && "$OUT" == *"class=schema"* ]] && markers_kept && [[ "$(restores)" == 0 ]]; then
  ok "W4 schema class → no rollback (rc 3)"
else bad "W4 ec=$EC out=$OUT"; fi

setup w5; printf '%s\n' "$RED" >"$C/master.json"; ar
if [[ "$EC" == 0 && "$OUT" == *"AUTORECOVER_RESTORED tier2"* && "$(restores)" == 1 && ! -e "$WATCH_DISARM" && ! -e "$WATCH_MANUAL_RECOVERY" ]]; then
  ok "W5 red release fault → two-level fallback restores, then markers archived"
else bad "W5 ec=$EC out=$OUT restores=$(restores)"; fi

setup w6; printf '%s\n' "$RED" >"$C/master.json"; FIXES=0 ar
if [[ "$EC" == 1 && "$OUT" == *AUTORECOVER_STILL_RED* && "$(restores)" == 1 ]] && markers_kept; then
  ok "W6 restore does not help → rc 1, markers kept"
else bad "W6 ec=$EC out=$OUT"; fi

setup w7; printf '%s\n' "$RED" >"$C/master.json"; ar --probe-only
if [[ "$EC" == 1 && "$OUT" == *"probe-only"* && "$(restores)" == 0 ]] && markers_kept; then
  ok "W7 --probe-only never touches the host"
else bad "W7 ec=$EC out=$OUT"; fi

setup w8; ( exec 9<>"$WATCH_LOCK"; flock -n 9; sleep 5 ) & hp=$!; sleep 0.5; ar; wait "$hp" || true
if [[ "$EC" == 75 && "$OUT" == *"SKIP lock"* ]] && markers_kept; then ok "W8 deploy lock held → rc 75, untouched"; else bad "W8 ec=$EC out=$OUT"; fi

setup w9; printf 'until=%s\n' "$(( $(date +%s) + 600 ))" >"$WATCH_MAINT"; ar
if [[ "$EC" == 75 && "$OUT" == *"SKIP window"* ]] && markers_kept; then ok "W9 maintenance window → rc 75"; else bad "W9 ec=$EC out=$OUT"; fi

setup w10; export WATCH_DRY=1; ar
if [[ "$EC" == 75 && "$OUT" == *"SKIP dry"* ]] && markers_kept; then ok "W10 WATCH_DRY=1 → rc 75"; else bad "W10 ec=$EC out=$OUT"; fi

setup w11; printf '{"ok":true,"deps":{"pg":"degraded"}}\n' >"$C/master.json"; ar --probe-only
if [[ "$EC" != 0 ]] && markers_kept; then ok "W11 green without deps.pg=ok is not treated as recovered"; else bad "W11 ec=$EC out=$OUT"; fi

# ── OCV5-818 Stage 1: deps-pg 单次/偶发抖动不直接 disarm,连续达阈值才 FAIL-LOUD ──
setup w12
rm -f "$WATCH_DISARM" "$WATCH_MANUAL_RECOVERY" "$WATCH_FAIL_COUNT"
printf '{"ok":false,"deps":{"pg":"error"}}\n' >"$C/master.json"
WATCH_DEPS_PG_FAIL_THRESHOLD=3 bash "$BIN" --once >/dev/null 2>&1 || true
c1_disarm=$([[ -e "$WATCH_DISARM" ]] && echo y || echo n)
c1_fail="$(cat "$WATCH_FAIL_COUNT" 2>/dev/null || echo 0)"
c1_pg="$(cat "$WATCH_RUN_DIR/deps-pg-fail-count" 2>/dev/null || echo 0)"
WATCH_DEPS_PG_FAIL_THRESHOLD=3 bash "$BIN" --once >/dev/null 2>&1 || true
c2_disarm=$([[ -e "$WATCH_DISARM" ]] && echo y || echo n)
# 一次转绿清零 deps-pg 计数
printf '%s\n' "$GREEN" >"$C/master.json"
WATCH_DEPS_PG_FAIL_THRESHOLD=3 bash "$BIN" --once >/dev/null 2>&1 || true
c_green_pg="$(cat "$WATCH_RUN_DIR/deps-pg-fail-count" 2>/dev/null || echo 99)"
# 连续 3 次 deps-pg 才触发 FAIL-LOUD + disarm
printf '{"ok":false,"deps":{"pg":"error"}}\n' >"$C/master.json"
WATCH_DEPS_PG_FAIL_THRESHOLD=3 bash "$BIN" --once >/dev/null 2>&1 || true
WATCH_DEPS_PG_FAIL_THRESHOLD=3 bash "$BIN" --once >/dev/null 2>&1 || true
c_pre3=$([[ -e "$WATCH_DISARM" ]] && echo y || echo n)
WATCH_DEPS_PG_FAIL_THRESHOLD=3 bash "$BIN" --once >/dev/null 2>&1 || true
if [[ "$c1_disarm" == n && "$c1_fail" == 0 && "$c1_pg" == 1 && "$c2_disarm" == n && "$c_green_pg" == 0 \
  && "$c_pre3" == n && -f "$WATCH_DISARM" && -f "$WATCH_MANUAL_RECOVERY" ]] \
  && grep -q 'reason=deps-pg' "$WATCH_DISARM"; then
  ok "W12 transient deps-pg (<threshold) stays armed and resets on green; 3 consecutive trigger FAIL-LOUD"
else
  bad "W12 c1=$c1_disarm/$c1_fail/$c1_pg c2=$c2_disarm green_pg=$c_green_pg pre3=$c_pre3 disarm=$([[ -f "$WATCH_DISARM" ]] && cat "$WATCH_DISARM" || echo no)"
fi

# ── OCV5-818 Stage 2: tier1 重启后在启动宽限窗口内变绿 → 判 tier1 成功,不跌入 tier2 ──
setup w13
printf '%s\n' "$RED" >"$C/master.json"
W13_BIN="$C/watch-w13.sh"
cat >"$W13_BIN" <<EOS
#!/usr/bin/env bash
source $(printf '%q' "$WATCH_SOURCE")
cc5_activation_recovery_safe() { return 0; }
prev_release_is_valid() { return 0; }
tier1_rollback_legacy() {
  write_grace
  ( sleep 1; printf '%s\n' '$GREEN' >"$C/master.json" ) &
  return 0
}
main "\$@"
EOS
chmod 0700 "$W13_BIN"
set +e
OUT="$(WATCH_POST_RESTART_WAIT_SEC=5 WATCH_POST_RESTART_POLL_SEC=1 bash "$W13_BIN" --auto-recover 2>&1)"
EC=$?
set -e
if [[ "$EC" == 0 && "$OUT" == *"AUTORECOVER_RESTORED tier1"* && "$(restores)" == 0 && ! -e "$WATCH_DISARM" && ! -e "$WATCH_MANUAL_RECOVERY" ]]; then
  ok "W13 tier1 waits for slow gateway startup within grace window and succeeds without falling through to tier2"
else
  bad "W13 ec=$EC restores=$(restores) out=$OUT"
fi

# ── OCV5-818 Stage 3a: tier2 备份为非 live 工作树 unit 时拒绝回装,不调用 restore.sh ──
setup w14
printf '%s\n' "$RED" >"$C/master.json"
cat >"$C/backup/openclaude-v5-selfhost.service" <<'UNIT'
[Service]
WorkingDirectory=/opt/openclaude/openclaude-v5-selfhost
ExecStart=/usr/bin/npx tsx packages/cli/src/index.ts gateway
UNIT
ar
if [[ "$EC" == 1 && "$OUT" == *AUTORECOVER_STILL_RED* && "$(restores)" == 0 ]] \
  && markers_kept && grep -q 'tier2 拒绝恢复非 live 工作树备份 unit' "$WATCH_LOG"; then
  ok "W14 tier2 refuses worktree-WD unit backup and never invokes restore script"
else
  bad "W14 ec=$EC restores=$(restores) out=$OUT log=$(tail -n5 "$WATCH_LOG" 2>/dev/null || true)"
fi

# ── OCV5-818 Stage 3b: restore-worktree-units.sh 真恢复(DO_RESTART=1)遇缺 .complete 工作树在写 unit 前拒绝 ──
setup w15
mkdir -p "$C/wt-backup" "$C/systemd" "$C/fake-wt"
printf '[Service]\nWorkingDirectory=/opt/openclaude/openclaude-v5-selfhost\nExecStart=/bin/true\n' >"$C/wt-backup/openclaude-v5-selfhost.service"
printf '[Service]\nWorkingDirectory=/opt/openclaude/openclaude-v5-selfhost\nExecStart=/bin/true\n' >"$C/wt-backup/openclaude-v5-selfhost-egress.service"
printf 'LIVE_UNIT_ORIG\n' >"$C/systemd/openclaude-v5-selfhost.service"
W15_RESTORE="$C/restore-tested.sh"
python3 - "$DIR/v5-selfhost-restore-worktree-units.sh" "$W15_RESTORE" "$C/fake-wt" <<'PY'
import pathlib, re, sys
src = pathlib.Path(sys.argv[1]).read_text()
src, n = re.subn(r'^cc5_activation_recovery_safe\(\) \{.*?^\}', 'cc5_activation_recovery_safe() { return 0; }', src, flags=re.M | re.S)
assert n == 1
src = src.replace('/opt/openclaude/openclaude-v5-selfhost)', sys.argv[3] + ')')
pathlib.Path(sys.argv[2]).write_text(src)
PY
chmod 0700 "$W15_RESTORE"
sed -i "s|/opt/openclaude/openclaude-v5-selfhost|$C/fake-wt|g" "$C/wt-backup/"*.service
set +e
W15_OUT="$(bash "$W15_RESTORE" --backup-dir "$C/wt-backup" --systemd-dir "$C/systemd" --no-reload --no-healthz 2>&1)"
W15_EC=$?
set -e
if [[ "$W15_EC" != 0 && "$W15_OUT" == *"未通过运行时安全契约"* && "$(cat "$C/systemd/openclaude-v5-selfhost.service")" == "LIVE_UNIT_ORIG" ]]; then
  ok "W15 restore-worktree-units refuses restart when worktree lacks .complete before mutating systemd units"
else
  bad "W15 ec=$W15_EC unit=$(cat "$C/systemd/openclaude-v5-selfhost.service") out=$W15_OUT"
fi

# ── OCV5-818 Stage 3c (Audit R1 #1 + R2 #1): 端到端 backup_installed_units_for_cutover → live-current → watch 自动 tier2 ──
setup w16
mkdir -p "$C/releases/rel-good" "$C/systemd-src" "$C/systemd-dst" "$C/bin" \
  "$C/breakglass/unit-backups/pre-cutover-20260818-144626"
printf '{"sourceCommit":"%s"}\n' "$(printf 'a%.0s' {1..40})" >"$C/releases/rel-good/.complete"
chmod 0755 "$C/releases/rel-good"
chmod 0644 "$C/releases/rel-good/.complete"
ln -sfn "$C/releases/rel-good" "$WATCH_LIVE"
# 陈旧工作树备份挂在 worktree-current 上(模拟现网默认 WATCH_BACKUP_CURRENT)
printf '[Service]\nWorkingDirectory=/opt/openclaude/openclaude-v5-selfhost\nExecStart=/bin/false\n' \
  >"$C/breakglass/unit-backups/pre-cutover-20260818-144626/openclaude-v5-selfhost.service"
printf '[Service]\nWorkingDirectory=/opt/openclaude/openclaude-v5-selfhost\nExecStart=/bin/false\n' \
  >"$C/breakglass/unit-backups/pre-cutover-20260818-144626/openclaude-v5-selfhost-egress.service"
ln -sfn "$C/breakglass/unit-backups/pre-cutover-20260818-144626" "$C/breakglass/unit-backups/worktree-current"
# 真实生产者从 systemd-src 备份当前 live-WD unit → 产出 live-current(且不改 worktree-current)
cat >"$C/systemd-src/openclaude-v5-selfhost.service" <<UNIT
[Service]
WorkingDirectory=$WATCH_LIVE
ExecStart=/usr/bin/npx tsx packages/cli/src/index.ts gateway
UNIT
cat >"$C/systemd-src/openclaude-v5-selfhost-egress.service" <<UNIT
[Service]
WorkingDirectory=$WATCH_LIVE
ExecStart=/usr/bin/npx tsx packages/commercial/src/egress/main.ts
UNIT
bash -c '
  set -euo pipefail
  source "$1"
  mlog() { :; }
  V5_SYSTEMD_DIR="$2" BREAKGLASS_ROOT="$3" MASTER_LIVE_LINK="$4" \
    V5_UNIT=openclaude-v5-selfhost.service V5_EGRESS_UNIT=openclaude-v5-selfhost-egress.service \
    backup_installed_units_for_cutover OUT_DIR
  [[ -n "$OUT_DIR" && -L "$3/unit-backups/live-current" ]]
' _ "$DIR/v5-selfhost-master-release-lib.sh" "$C/systemd-src" "$C/breakglass" "$WATCH_LIVE"
printf 'BROKEN_OLD_UNIT\n' >"$C/systemd-dst/openclaude-v5-selfhost.service"
printf '%s\n' "$RED" >"$C/master.json"
cat >"$C/bin/systemctl" <<EOS
#!/usr/bin/env bash
printf 'systemctl %s\n' "\$*" >>"$C/systemctl.calls"
if [[ "\$1" == restart && "\$2" == openclaude-v5-selfhost.service ]]; then
  printf '%s\n' '$GREEN' >"$C/master.json"
fi
exit 0
EOS
cat >"$C/bin/timeout" <<'EOS'
#!/usr/bin/env bash
exit 0
EOS
chmod 0755 "$C/bin/systemctl" "$C/bin/timeout"
w16_can_root=0
if [[ "$(id -u)" == 0 ]]; then
  w16_can_root=1
elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  sudo -n chown 0:0 "$C/releases/rel-good" "$C/releases/rel-good/.complete"
  w16_can_root=1
fi
if [[ "$w16_can_root" == 1 ]]; then
  set +e
  # 刻意让 WATCH_BACKUP_CURRENT 指向陈旧 worktree-current,且不覆写 WATCH_LIVE_BACKUP_CURRENT,
  # 验收 watch 默认从同目录 live-current 消费真实生产者发布的 live 备份。
  OUT="$(env -u WATCH_LIVE_BACKUP_CURRENT PATH="$C/bin:$PATH" \
    WATCH_BACKUP_CURRENT="$C/breakglass/unit-backups/worktree-current" \
    WATCH_SYSTEMD_DIR="$C/systemd-dst" bash "$BIN" --auto-recover 2>&1)"
  EC=$?
  set -e
  if [[ "$EC" == 0 && "$OUT" == *"AUTORECOVER_RESTORED tier2"* ]] \
    && [[ "$(readlink "$C/breakglass/unit-backups/worktree-current")" == *pre-cutover-20260818-144626 ]] \
    && cmp -s "$C/systemd-src/openclaude-v5-selfhost.service" "$C/systemd-dst/openclaude-v5-selfhost.service" \
    && cmp -s "$C/systemd-src/openclaude-v5-selfhost-egress.service" "$C/systemd-dst/openclaude-v5-selfhost-egress.service" \
    && grep -q '^systemctl daemon-reload$' "$C/systemctl.calls" \
    && grep -q '^systemctl restart openclaude-v5-selfhost-egress.service$' "$C/systemctl.calls" \
    && grep -q '^systemctl restart openclaude-v5-selfhost.service$' "$C/systemctl.calls" \
    && [[ ! -e "$WATCH_DISARM" && ! -e "$WATCH_MANUAL_RECOVERY" ]]; then
    ok "W16 producer→live-current→watch tier2 restores live units atomically without touching worktree-current"
  else
    bad "W16 ec=$EC out=$OUT calls=$(cat "$C/systemctl.calls" 2>/dev/null || true)"
  fi
  if [[ "$(id -u)" != 0 ]]; then
    sudo -n chown -R "$(id -u):$(id -g)" "$C/releases/rel-good" 2>/dev/null || true
  fi
else
  ok "W16 skipped root-owned positive setup (non-root without sudo)"
fi

# ── OCV5-818 Stage 3d (Audit #2): .complete 严格契约(空文件 / NaN 常量 / go+w 权限 / 非 root 属主)均在写 grace 与改 unit 前拒绝 ──
setup w17
mkdir -p "$C/releases/rel-bad" "$C/systemd"
ln -sfn "$C/releases/rel-bad" "$WATCH_LIVE"
printf '[Service]\nWorkingDirectory=%s\nExecStart=/bin/true\n' "$WATCH_LIVE" >"$C/backup/openclaude-v5-selfhost.service"
printf 'ORIG_UNIT\n' >"$C/systemd/openclaude-v5-selfhost.service"
printf '%s\n' "$RED" >"$C/master.json"
rm -f "$WATCH_GRACE"
# (a) 空 .complete 文件(旧 jq -e 会误返 0)
: >"$C/releases/rel-bad/.complete"
chmod 0755 "$C/releases/rel-bad"; chmod 0644 "$C/releases/rel-bad/.complete"
set +e; W17A="$(WATCH_SYSTEMD_DIR="$C/systemd" bash "$BIN" --auto-recover 2>&1)"; W17A_EC=$?; set -e
w17a_grace=$([[ -e "$WATCH_GRACE" ]] && echo y || echo n)
# (b) group-writable .complete(mode 0664)
printf '{"sourceCommit":"%s"}\n' "$(printf 'b%.0s' {1..40})" >"$C/releases/rel-bad/.complete"
chmod 0664 "$C/releases/rel-bad/.complete"
set +e; W17B="$(WATCH_SYSTEMD_DIR="$C/systemd" bash "$BIN" --auto-recover 2>&1)"; W17B_EC=$?; set -e
w17b_grace=$([[ -e "$WATCH_GRACE" ]] && echo y || echo n)
# (c) 非 root 属主(root 下 chown 65534; 非 root 下本身非 0)
chmod 0644 "$C/releases/rel-bad/.complete"
[[ "$(id -u)" == 0 ]] && chown 65534:65534 "$C/releases/rel-bad/.complete"
set +e; W17C="$(WATCH_SYSTEMD_DIR="$C/systemd" bash "$BIN" --auto-recover 2>&1)"; W17C_EC=$?; set -e
w17c_grace=$([[ -e "$WATCH_GRACE" ]] && echo y || echo n)
# (c2) 非标准 JSON 常量 NaN(Node JSON.parse 拒绝,默认 python json.loads 会接受)
[[ "$(id -u)" == 0 ]] && chown 0:0 "$C/releases/rel-bad/.complete"
printf '{"sourceCommit":"%s","extra":NaN}\n' "$(printf 'b%.0s' {1..40})" >"$C/releases/rel-bad/.complete"
chmod 0644 "$C/releases/rel-bad/.complete"
set +e; W17N="$(WATCH_SYSTEMD_DIR="$C/systemd" bash "$BIN" --auto-recover 2>&1)"; W17N_EC=$?; set -e
w17n_grace=$([[ -e "$WATCH_GRACE" ]] && echo y || echo n)
# (d) restore-worktree-units.sh 空文件与 NaN .complete 也必须拒绝(不碰 systemd unit)
mkdir -p "$C/wt17-backup" "$C/wt17-dir"
: >"$C/wt17-dir/.complete"
chmod 0755 "$C/wt17-dir"; chmod 0644 "$C/wt17-dir/.complete"
printf '[Service]\nWorkingDirectory=%s\nExecStart=/bin/true\n' "$C/wt17-dir" >"$C/wt17-backup/openclaude-v5-selfhost.service"
printf '[Service]\nWorkingDirectory=%s\nExecStart=/bin/true\n' "$C/wt17-dir" >"$C/wt17-backup/openclaude-v5-selfhost-egress.service"
W17_RESTORE="$C/restore-w17.sh"
python3 - "$DIR/v5-selfhost-restore-worktree-units.sh" "$W17_RESTORE" "$C/wt17-dir" <<'PY'
import pathlib, re, sys
src = pathlib.Path(sys.argv[1]).read_text()
src, n = re.subn(r'^cc5_activation_recovery_safe\(\) \{.*?^\}', 'cc5_activation_recovery_safe() { return 0; }', src, flags=re.M | re.S)
assert n == 1
src = src.replace('/opt/openclaude/openclaude-v5-selfhost)', sys.argv[3] + ')')
pathlib.Path(sys.argv[2]).write_text(src)
PY
chmod 0700 "$W17_RESTORE"
set +e; W17D="$(bash "$W17_RESTORE" --backup-dir "$C/wt17-backup" --systemd-dir "$C/systemd" --no-reload --no-healthz 2>&1)"; W17D_EC=$?; set -e
printf '{"sourceCommit":"%s","extra":NaN}\n' "$(printf 'b%.0s' {1..40})" >"$C/wt17-dir/.complete"
set +e; W17DN="$(bash "$W17_RESTORE" --backup-dir "$C/wt17-backup" --systemd-dir "$C/systemd" --no-reload --no-healthz 2>&1)"; W17DN_EC=$?; set -e
if [[ "$W17A_EC" == 1 && "$w17a_grace" == n && "$W17B_EC" == 1 && "$w17b_grace" == n \
  && "$W17C_EC" == 1 && "$w17c_grace" == n && "$W17N_EC" == 1 && "$w17n_grace" == n \
  && "$W17D_EC" != 0 && "$W17DN_EC" != 0 \
  && "$(cat "$C/systemd/openclaude-v5-selfhost.service")" == "ORIG_UNIT" ]]; then
  ok "W17 empty/NaN/go+w/non-root .complete all rejected fail-closed before writing grace or mutating systemd units"
else
  bad "W17 a=$W17A_EC/$w17a_grace b=$W17B_EC/$w17b_grace c=$W17C_EC/$w17c_grace n=$W17N_EC/$w17n_grace d=$W17D_EC/$W17DN_EC unit=$(cat "$C/systemd/openclaude-v5-selfhost.service")"
fi

# ── OCV5-818 Stage 2b (Audit #3): --once 整拍共享预算(egress 已耗时 + master 慢就绪 → 持久化待复查,下一拍转绿不误跌 tier2) ──
setup w18
rm -f "$WATCH_DISARM" "$WATCH_MANUAL_RECOVERY" "$WATCH_GRACE" "$WATCH_FAIL_COUNT"
printf '%s\n' "$RED" >"$C/master.json"
W18_BIN="$C/watch-w18.sh"
cat >"$W18_BIN" <<EOS
#!/usr/bin/env bash
source $(printf '%q' "$WATCH_SOURCE")
cc5_activation_recovery_safe() { return 0; }
prev_release_is_valid() { return 0; }
tier1_rollback_legacy() {
  write_grace
  sleep 2
  return 0
}
main "\$@"
EOS
chmod 0700 "$W18_BIN"
set +e
WATCH_FAIL_THRESHOLD=1 WATCH_ONCE_BUDGET_SEC=3 WATCH_POST_RESTART_WAIT_SEC=5 WATCH_POST_RESTART_POLL_SEC=1 \
  WATCH_NOW_OVERRIDE=1700000000 bash "$W18_BIN" --once >/dev/null 2>&1
e18_1=$?
p18_exists=$([[ -f "$WATCH_RUN_DIR/watch-tier-pending" ]] && echo y || echo n)
p18_tier="$(sed -n 's/^tier=//p' "$WATCH_RUN_DIR/watch-tier-pending" 2>/dev/null || true)"
p18_r1="$(restores)"
# 第 2 拍仍在宽限内且红 → 继续等待,不跌入 tier2
WATCH_FAIL_THRESHOLD=1 WATCH_ONCE_BUDGET_SEC=3 WATCH_POST_RESTART_WAIT_SEC=5 WATCH_POST_RESTART_POLL_SEC=1 \
  WATCH_NOW_OVERRIDE=1700000002 bash "$W18_BIN" --once >/dev/null 2>&1
e18_2=$?
p18_r2="$(restores)"
# 第 3 拍 master 转绿 → 清除待复查,归零计数,不触碰 tier2
printf '%s\n' "$GREEN" >"$C/master.json"
WATCH_FAIL_THRESHOLD=1 WATCH_ONCE_BUDGET_SEC=3 WATCH_POST_RESTART_WAIT_SEC=5 WATCH_POST_RESTART_POLL_SEC=1 \
  WATCH_NOW_OVERRIDE=1700000003 bash "$W18_BIN" --once >/dev/null 2>&1
e18_3=$?
set -e
if [[ "$e18_1" == 0 && "$e18_2" == 0 && "$e18_3" == 0 && "$p18_exists" == y && "$p18_tier" == tier1 \
  && "$p18_r1" == 0 && "$p18_r2" == 0 && "$(restores)" == 0 && ! -e "$WATCH_RUN_DIR/watch-tier-pending" \
  && ! -e "$WATCH_DISARM" && "$(grep '^health=' "$WATCH_STATUS")" == health=green ]]; then
  ok "W18 --once shared tick budget defers slow master verify to next tick and recovers green without falling into tier2"
else
  bad "W18 ec=$e18_1/$e18_2/$e18_3 pend=$p18_exists/$p18_tier r=$p18_r1/$p18_r2/$(restores) status=$(cat "$WATCH_STATUS" 2>/dev/null || true)"
fi

# ── OCV5-818 (Audit extra): --auto-recover 短路 WATCH_SKIP_ACTIONS=1,不持锁等 90s 且不动标记 ──
setup w19
printf '%s\n' "$RED" >"$C/master.json"
t0=$SECONDS
set +e
OUT="$(WATCH_SKIP_ACTIONS=1 WATCH_POST_RESTART_WAIT_SEC=60 bash "$BIN" --auto-recover 2>&1)"
EC=$?
set -e
dt=$((SECONDS - t0))
if [[ "$EC" == 75 && "$OUT" == *"AUTORECOVER_SKIP skip-actions"* && "$dt" -lt 5 ]] && markers_kept; then
  ok "W19 --auto-recover short-circuits WATCH_SKIP_ACTIONS=1 with rc 75 (${dt}s) and keeps markers"
else
  bad "W19 ec=$EC dt=${dt}s out=$OUT"
fi

# ── OCV5-818 Stage 2c (Audit R2 #3): 真实 restart_egress_for_live 新槽探针超时绝不停旧槽,待下一拍新槽就绪后再停旧槽并重启 master ──
setup w20
rm -f "$WATCH_DISARM" "$WATCH_MANUAL_RECOVERY" "$WATCH_GRACE" "$WATCH_FAIL_COUNT"
mkdir -p "$C/rel/rel-prev/deploy/v5-selfhost" "$C/bin"
printf '# fixture\n' >"$C/rel/rel-prev/deploy/v5-selfhost/openclaude-v5-selfhost-egress@.service"
printf '%s\n' "$C/rel/rel-prev" >"$C/rel/.prev-release"
ln -sfn "$C/rel/rel-prev" "$WATCH_LIVE"
printf '%s\n' "$RED" >"$C/master.json"
cat >"$C/bin/systemctl" <<EOS
#!/usr/bin/env bash
printf 'systemctl %s\n' "\$*" >>"$C/systemctl.calls"
if [[ "\$1" == is-active ]]; then
  if [[ "\$2" == openclaude-v5-selfhost-egress@A.service ]]; then echo active; exit 0; fi
  echo inactive; exit 3
fi
if [[ "\$1" == restart && "\$2" == openclaude-v5-selfhost.service ]]; then
  printf '%s\n' '$GREEN' >"$C/master.json"
fi
exit 0
EOS
cat >"$C/bin/curl" <<EOS
#!/usr/bin/env bash
for a in "\$@"; do
  case "\$a" in
    *18899/internal/v5/egress-slot-health*)
      [[ -f "$C/slotB.ready" ]] && { echo '{"ok":true}'; exit 0; }
      exit 22
      ;;
  esac
done
exec /usr/bin/curl "\$@"
EOS
chmod 0755 "$C/bin/systemctl" "$C/bin/curl"
W20_BIN="$C/watch-w20.sh"
cat >"$W20_BIN" <<EOS
#!/usr/bin/env bash
source $(printf '%q' "$WATCH_SOURCE")
cc5_activation_recovery_safe() { return 0; }
prev_release_is_valid() { return 0; }
main "\$@"
EOS
chmod 0700 "$W20_BIN"
set +e
# 第 1 拍: 预算 11s → 新槽 B 探针限时 1s 超时 → 绝不停旧槽 A,持久化 stage=egress-flip
PATH="$C/bin:$PATH" WATCH_FAIL_THRESHOLD=1 WATCH_ONCE_BUDGET_SEC=11 WATCH_POST_RESTART_WAIT_SEC=2 \
  WATCH_POST_RESTART_POLL_SEC=1 WATCH_NOW_OVERRIDE=1700000000 bash "$W20_BIN" --once >/dev/null 2>&1
e20_1=$?
w20_stage="$(sed -n 's/^stage=//p' "$WATCH_RUN_DIR/watch-tier-pending" 2>/dev/null || true)"
w20_stopped_early=$(grep -q 'stop .*@A' "$C/systemctl.calls" 2>/dev/null && echo y || echo n)
w20_master_early=$(grep -q 'restart openclaude-v5-selfhost.service' "$C/systemctl.calls" 2>/dev/null && echo y || echo n)
# 第 2 拍: 新槽 B 就绪 → 此时才停 A.socket + A.service 并重启 master → 转绿
touch "$C/slotB.ready"
PATH="$C/bin:$PATH" WATCH_FAIL_THRESHOLD=1 WATCH_ONCE_BUDGET_SEC=20 WATCH_POST_RESTART_WAIT_SEC=2 \
  WATCH_POST_RESTART_POLL_SEC=1 WATCH_NOW_OVERRIDE=1700000010 bash "$W20_BIN" --once >/dev/null 2>&1
e20_2=$?
set -e
if [[ "$e20_1" == 0 && "$e20_2" == 0 && "$w20_stage" == egress-flip && "$w20_stopped_early" == n \
  && "$w20_master_early" == n && ! -e "$WATCH_RUN_DIR/watch-tier-pending" && ! -e "$WATCH_DISARM" ]] \
  && grep -q 'stop --job-mode=ignore-dependencies openclaude-v5-selfhost-egress@A.socket' "$C/systemctl.calls" \
  && grep -q 'stop --no-block openclaude-v5-selfhost-egress@A.service' "$C/systemctl.calls" \
  && grep -q 'restart openclaude-v5-selfhost.service' "$C/systemctl.calls" \
  && [[ "$(grep '^health=' "$WATCH_STATUS")" == health=green ]]; then
  ok "W20 real restart_egress_for_live keeps old slot A on new-slot timeout, defers flip, stops A only after B is ready"
else
  bad "W20 ec=$e20_1/$e20_2 stage=$w20_stage early=$w20_stopped_early/$w20_master_early calls=$(tr '\n' ';' <"$C/systemctl.calls" 2>/dev/null || true)"
fi

echo "watch-autorecover: pass=$pass fail=$fail"
[[ "$fail" == 0 ]]
