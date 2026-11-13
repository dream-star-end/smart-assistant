#!/usr/bin/env bash
# OCV5-404 deploy 侧看护同步/漂移检查测试。从 deploy-v5-selfhost.sh 抽出函数，在临时目录执行，
# 不碰宿主安装目录。另外核对接线：committed 之后才同步、只告警；smoke 查漂移；release 门跑看护测试。
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY="${DEPLOY_SCRIPT:-$DIR/deploy-v5-selfhost.sh}"
LIB="${RELEASE_LIB:-$DIR/v5-selfhost-master-release-lib.sh}"
DIAGNOSTICS="$(dirname "$DEPLOY")/lib/v5-selfhost-diagnostics.sh"

pass=0
fail=0
ok() { pass=$((pass + 1)); echo "PASS $*"; }
bad() { fail=$((fail + 1)); echo "FAIL $*"; }

fn() { awk -v n="$1() {" 'index($0, n) == 1 {f=1} f {print} f && /^}/ {exit}' "$DEPLOY" "$DIAGNOSTICS"; }
BASE="$(mktemp -d /tmp/v5-watch-sync.XXXXXX)"
trap 'rm -rf "$BASE"' EXIT
{
  echo 'log() { echo "$*"; }'
  echo 'die() { echo "DIE $*"; exit 1; }'
  grep -m1 '^WATCH_SYNC_FILES=' "$DEPLOY"
  for f in watch_install_state install_watch_file sync_watch_from watch_summary assert_watch_matches_live; do
    body="$(fn "$f")"
    [[ -n "$body" ]] || { echo "missing function $f" >&2; exit 1; }
    printf '%s\n' "$body"
  done
} >"$BASE/fns.sh"

setup() {
  C="$BASE/$1"
  mkdir -p "$C/inst" "$C/rel/scripts" "$C/run"
  export V5_WATCH_DIR="$C/inst" V5_WATCH_RUN_STATUS="$C/run/watch-status" DRY=0
  printf '#!/usr/bin/env bash\necho NEW\n' >"$C/rel/scripts/v5-selfhost-watch.sh"
  printf '#!/usr/bin/env bash\n# OCV5-410\necho "mode=dry ALERTNEW"\n' >"$C/rel/scripts/v5-selfhost-watch-alert.sh"
  printf '#!/usr/bin/env bash\necho OLD\n' >"$C/inst/watch.sh"
  chmod 0755 "$C/inst/watch.sh"
  printf 'reason=deps-pg\n' >"$C/inst/watch-disarmed"
  printf 'WATCH_DRY=0\n' >"$C/inst/watch.env"
  printf '#!/bin/sh\necho "$1" >>"%s/legacy-alert-called"\n' "$C" >"$C/inst/alert.sh"
  chmod 0755 "$C/inst/alert.sh"
  SIDE="$(side)"
}
side() { (cd "$C/inst" && stat -c '%n %i %Y %s' watch-disarmed watch.env && sha256sum watch-disarmed watch.env); }
tmps() { find "$C/inst" -maxdepth 1 -name 'watch.sh.*' | wc -l; }
run() { set +e; OUT="$(bash -c ". '$BASE/fns.sh'; $*" 2>&1)"; EC=$?; set -e; }

setup s1; run "sync_watch_from '$C/rel'"
if [[ "$EC" == 0 ]] && cmp -s "$C/rel/scripts/v5-selfhost-watch.sh" "$C/inst/watch.sh" \
  && cmp -s "$C/rel/scripts/v5-selfhost-watch-alert.sh" "$C/inst/alert.sh" && [[ "$(stat -c %a "$C/inst/alert.sh")" == 755 ]] \
  && [[ "$(stat -c %a "$C/inst/watch.sh")" == 755 && "$(side)" == "$SIDE" && "$(tmps)" == 0 && "$OUT" == *看护已同步* ]]; then
  ok "S1 drift installs watch.sh and alert.sh atomically; marker/env untouched"
else bad "S1 ec=$EC out=$OUT"; fi

ino="$(stat -c %i "$C/inst/watch.sh")"; run "sync_watch_from '$C/rel'"
if [[ "$EC" == 0 && "$(stat -c %i "$C/inst/watch.sh")" == "$ino" && "$OUT" == *已是本\ release* ]]; then ok "S2 same is a no-op"; else bad "S2 ec=$EC out=$OUT"; fi

setup s3; printf 'if then\n' >"$C/rel/scripts/v5-selfhost-watch.sh"; run "sync_watch_from '$C/rel'"
if [[ "$EC" == 1 && "$(cat "$C/inst/watch.sh" | tail -n1)" == "echo OLD" && "$(tmps)" == 0 && "$(side)" == "$SIDE" ]]; then ok "S3 syntax error keeps installed copy"; else bad "S3 ec=$EC out=$OUT"; fi

setup s4; rm -f "$C/inst/watch.sh"; run "sync_watch_from '$C/rel'"
if [[ "$EC" == 0 && ! -e "$C/inst/watch.sh" && "$OUT" == *未安装看护* ]]; then ok "S4 host without watch is left alone"; else bad "S4 ec=$EC out=$OUT"; fi

setup s5; rm -f "$C/rel/scripts/v5-selfhost-watch.sh"; run "sync_watch_from '$C/rel'"
if [[ "$EC" == 1 && "$(tail -n1 "$C/inst/watch.sh")" == "echo OLD" ]]; then ok "S5 release without watch fails without touching"; else bad "S5 ec=$EC out=$OUT"; fi

setup s6; export DRY=1; run "sync_watch_from '$C/rel'"; export DRY=0
if [[ "$EC" == 0 && "$(tail -n1 "$C/inst/watch.sh")" == "echo OLD" && "$OUT" == *dry-run* ]]; then ok "S6 dry-run does not install"; else bad "S6 ec=$EC out=$OUT"; fi

# OCV5-410:只有 alert.sh 漂移也算 drift 并同步;旧 alert.sh 不被 --status 调用(它会把参数当单元名记假告警)。
setup s10a; cp "$C/rel/scripts/v5-selfhost-watch.sh" "$C/inst/watch.sh"
run "watch_install_state '$C/rel'"; st_a="$OUT"
run "watch_summary '$C/rel'"; sum_legacy="$OUT"
run "sync_watch_from '$C/rel'"
if [[ "$st_a" == drift && "$EC" == 0 ]] && cmp -s "$C/rel/scripts/v5-selfhost-watch-alert.sh" "$C/inst/alert.sh" \
  && [[ "$sum_legacy" == *alert=legacy* && ! -e "$C/legacy-alert-called" && "$(side)" == "$SIDE" ]]; then
  ok "S10a alert.sh-only drift is synced; legacy alert.sh never gets --status"
else bad "S10a st=$st_a out=$OUT sum=$sum_legacy called=$(cat "$C/legacy-alert-called" 2>/dev/null)"; fi
run "watch_summary '$C/rel'"
if [[ "$OUT" == *alert=mode=dry,ALERTNEW* ]]; then ok "S10b new alert.sh status shown in summary"; else bad "S10b out=$OUT"; fi

setup s8; run "assert_watch_matches_live '$C/rel'"
if [[ "$EC" == 1 && "$OUT" == *DIE*不一致* ]]; then ok "S8 smoke check dies on drift"; else bad "S8 ec=$EC out=$OUT"; fi
cp "$C/rel/scripts/v5-selfhost-watch.sh" "$C/inst/watch.sh"
cp "$C/rel/scripts/v5-selfhost-watch-alert.sh" "$C/inst/alert.sh"
printf 'recovery_armed=false\nhealth=green\nchecked_at=2026-10-13T00:00:00Z\n' >"$V5_WATCH_RUN_STATUS"
run "assert_watch_matches_live '$C/rel'"
if [[ "$EC" == 0 && "$OUT" == *install=same\ disarm=present\(deps-pg\)\ recovery_armed=false\ health=green* ]]; then ok "S9 smoke check passes when same and reports watch state"; else bad "S9 ec=$EC out=$OUT"; fi

# 接线：committed + disarm survivor 之后才同步，且失败只告警。
cut="$(awk '/cutover_persist_phase "committed"/{f=1} f' "$DEPLOY")"
if grep -q 'cutover_disarm_survivor' <<<"$cut" && grep -A1 '^  sync_watch_from "\$rel"' <<<"$cut" | grep -q '|| cutover_clog'; then
  ok "S10 sync runs after committed and is warn-only"
else bad "S10 wiring"; fi
pre="$(awk '/cutover_persist_phase "committed"/{exit} {print}' "$DEPLOY")"
if ! grep -q '^  sync_watch_from "\$rel"' <<<"$pre" && fn cmd_smoke | grep -q 'assert_watch_matches_live "\$live_root"' \
  && fn cmd_status | grep -q 'watch_summary'; then
  ok "S11 no sync before committed; smoke and status wired"
else bad "S11 wiring"; fi
gate="$(awk '/rootfix contract gate 失败/{f=1} f; /harden_unique_release_tree "\$staging"/{exit}' "$LIB")"
# OCV5-447: the list lives in scripts/v5-selfhost-watch-gate.sh (shared with PR CI); the
# gate section must run that runner, and the runner must list every watch test.
missing=""
grep -q 'bash scripts/v5-selfhost-watch-gate.sh' <<<"$gate" || missing="$missing runner-call"
gate_list="$(bash "$(dirname "$LIB")/v5-selfhost-watch-gate.sh" --list 2>/dev/null || true)"
for t in v5-selfhost-watch-selftest.sh v5-selfhost-watch-disarm-observe.test.sh v5-selfhost-watch-lock.test.sh \
  v5-selfhost-watch-rearm.test.sh v5-selfhost-watch-sync.test.sh v5-selfhost-watch-alert.test.sh; do
  grep -qx "$t" <<<"$gate_list" || missing="$missing $t"
done
if [[ -z "$missing" ]]; then ok "S12 release gate runs every watch test before harden"; else bad "S12 missing:$missing"; fi

echo "SYNC_CASES pass=$pass fail=$fail"
(( fail == 0 )) && echo SYNC_TEST_ALL_PASS
(( fail == 0 ))
