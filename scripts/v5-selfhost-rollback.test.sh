#!/usr/bin/env bash
# OCV5-534(FINDINGS DEP-6)--rollback 行为测试:目标解析(.prev-release + history 血缘)与回退 schema 门。
# 用仓库真实的 master-release lib / runtime lib / 破坏性 DDL 检测器,只把 psql(sudo)换成假的;
# 全部在 mktemp 目录里跑,不碰宿主 release、history、env 或数据库。
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY="${DEPLOY_SCRIPT:-$DIR/deploy-v5-selfhost.sh}"
pass=0
fail=0
ok() { pass=$((pass + 1)); echo "PASS $*"; }
bad() { fail=$((fail + 1)); echo "FAIL $*"; }

BASE="$(mktemp -d "${TMPDIR:-/tmp}/v5-selfhost-rollback.XXXXXX")"
trap 'rm -rf "$BASE"' EXIT
mkdir -p "$BASE/bin"
# 假 sudo:只认 `sudo -u postgres psql ... -tAc <sql>`,打印 $C/applied.txt(schema_migrations)。
cat >"$BASE/bin/sudo" <<'SH'
#!/bin/sh
case "$*" in *schema_migrations*) cat "$C/applied.txt"; exit 0 ;; esac
echo "unexpected sudo $*" >&2; exit 99
SH
chmod 0755 "$BASE/bin/sudo"
export PATH="$BASE/bin:$PATH"

die() { echo "DIE $*"; return 1; }
# shellcheck disable=SC1091
source "$DIR/v5-runtime-release-lib.sh"
# shellcheck disable=SC1091
source "$DIR/lib/v5-migration-ddl.sh"
# shellcheck disable=SC1091
source "$DIR/v5-selfhost-master-release-lib.sh"
# shellcheck disable=SC1091
source "$DIR/lib/v5-selfhost-rollback.sh"
fn() { awk -v n="$1() {" 'index($0, n) == 1 {f=1} f {print} f && /^}/ {exit}' "$DEPLOY"; }
eval "$(fn cutover_expected_source_commit)"

mkrel() { # <name> <sha> <migration...>  → 带合法 .complete(真实 digest)的 master release
  local r="$MASTER_RELEASES_ROOT/$1" sha="$2" m art
  shift 2
  mkdir -p "$r/packages/commercial/src/db/migrations" "$r/deploy/v5"
  for m in "$@"; do printf 'CREATE TABLE IF NOT EXISTS t_%s(id int);\n' "$m" >"$r/packages/commercial/src/db/migrations/$m.sql"; done
  jq -cn '{requiredMigrations:$ARGS.positional}' --args "$@" >"$r/deploy/v5/release-metadata.json"
  art="$(release_artifact_digest "$r")"
  jq -cn --arg c "$sha" --arg a "$art" \
    '{schemaVersion:2,sourceCommit:$c,builtAt:"20261021-000000",metadataSha256:("0"*64),artifactSha256:$a}' >"$r/.complete"
}

SHA_P=1111111111111111111111111111111111111111
SHA_L=2222222222222222222222222222222222222222
ID_P="sha256:$(printf 'a%.0s' {1..64})"
ID_L="sha256:$(printf 'b%.0s' {1..64})"

setup() { # <case>  标准现场:live=L,prev=P,history [P joint, L←P joint]
  C="$BASE/$1"
  export C
  export MASTER_RELEASES_ROOT="$C/releases" MASTER_LIVE_LINK="$C/live"
  export OC_HOTCFG_HISTORY="$C/history" OC_HOTCFG_RELEASES_ROOT="$C/rt" OC_HOTCFG_PLATFORM_ROOT="$C/platform"
  export V5_ENV="$C/env" PG_DB=openclaude_v5_selfhost
  mkdir -p "$MASTER_RELEASES_ROOT" "$C/rt/rel-p" "$C/rt/rel-l" "$C/platform/bundles/bp" "$C/platform/bundles/bl"
  mkrel rel-p "$SHA_P" 0001_a 0002_b
  mkrel rel-l "$SHA_L" 0001_a 0002_b 0003_c
  ln -s "$MASTER_RELEASES_ROOT/rel-l" "$MASTER_LIVE_LINK"
  printf '%s\n' "$MASTER_RELEASES_ROOT/rel-p" >"$MASTER_RELEASES_ROOT/.prev-release"
  printf 'COMMERCIAL_AUTO_MIGRATE=0\n' >"$V5_ENV"
  printf '0001_a\n0002_b\n0003_c\n' >"$C/applied.txt"
  oc_hotcfg_history_append "$OC_HOTCFG_HISTORY" img:p "$ID_P" "$C/rt/rel-p" "$C/platform/bundles/bp" \
    "$MASTER_RELEASES_ROOT/rel-p" "" joint "$MASTER_RELEASES_ROOT/rel-o" 2>/dev/null
  oc_hotcfg_history_append "$OC_HOTCFG_HISTORY" img:l "$ID_L" "$C/rt/rel-l" "$C/platform/bundles/bl" \
    "$MASTER_RELEASES_ROOT/rel-l" "" joint "$MASTER_RELEASES_ROOT/rel-p" 2>/dev/null
}
resolve_refuses() { # <label> <expected-substring>
  local out
  if out="$(rollback_resolve_target 2>&1)"; then bad "$1: 应拒绝却解析成功"; return; fi
  if [[ "$out" == *"$2"* ]]; then ok "$1"; else bad "$1: 拒绝原因不符: $out"; fi
}
gate_refuses() { # <label> <expected-substring>
  local out
  if out="$(rollback_schema_gate "$MASTER_RELEASES_ROOT/rel-p" "$MASTER_RELEASES_ROOT/rel-l" 2>&1)"; then
    bad "$1: 应拒绝却通过"; return
  fi
  if [[ "$out" == *"$2"* ]]; then ok "$1"; else bad "$1: 拒绝原因不符: $out"; fi
}

# R1 正常:目标=prev,四元组取 masterRelease==prev 那条记录
setup r1
if rollback_resolve_target 2>/dev/null \
  && [[ "$ROLLBACK_MASTER" == "$MASTER_RELEASES_ROOT/rel-p" && "$ROLLBACK_SHA" == "$SHA_P" \
     && "$ROLLBACK_IMAGE" == img:p && "$ROLLBACK_IMAGE_ID" == "$ID_P" \
     && "$ROLLBACK_RUNTIME_RELEASE" == "$C/rt/rel-p" && "$ROLLBACK_BUNDLE" == "$C/platform/bundles/bp" ]]; then
  ok "R1 resolves prev master + its committed tuple"
else
  bad "R1 resolve: master=$ROLLBACK_MASTER sha=$ROLLBACK_SHA image=$ROLLBACK_IMAGE rt=$ROLLBACK_RUNTIME_RELEASE"
fi
export CUTOVER_ROLLBACK=1
[[ "$(cutover_expected_source_commit)" == "$SHA_P" ]] && ok "R1 cutover pins rollback sourceCommit, not HEAD" \
  || bad "R1 cutover_expected_source_commit"
export CUTOVER_ROLLBACK=0

setup r2; printf 'none\n' >"$MASTER_RELEASES_ROOT/.prev-release"
resolve_refuses "R2 .prev-release=none" "不是可用的上一版"
setup r3; echo tamper >>"$MASTER_RELEASES_ROOT/rel-p/deploy/v5/release-metadata.json"
resolve_refuses "R3 prev digest mismatch" "不是可用的上一版"
setup r4; ln -sfn "$MASTER_RELEASES_ROOT/rel-p" "$MASTER_LIVE_LINK"
resolve_refuses "R4 prev equals live" "就是 live"
setup r5; mkrel rel-x "$SHA_L" 0001_a; ln -sfn "$MASTER_RELEASES_ROOT/rel-x" "$MASTER_LIVE_LINK"
resolve_refuses "R5 live not from joint saga" "≠ live="
setup r6; mkrel rel-q "$SHA_P" 0001_a; printf '%s\n' "$MASTER_RELEASES_ROOT/rel-q" >"$MASTER_RELEASES_ROOT/.prev-release"
resolve_refuses "R6 prev not parent in history" "previousMasterRelease="
setup r7; : >"$OC_HOTCFG_HISTORY"
oc_hotcfg_history_append "$OC_HOTCFG_HISTORY" img:l "$ID_L" "$C/rt/rel-l" "$C/platform/bundles/bl" \
  "$MASTER_RELEASES_ROOT/rel-l" "" joint "$MASTER_RELEASES_ROOT/rel-p" 2>/dev/null
resolve_refuses "R7 only one committed entry" "不足两条"
setup r8; rmdir "$C/rt/rel-p"
resolve_refuses "R8 prev runtime release GC'd" "runtime release 不在"
setup r9; rmdir "$C/platform/bundles/bp"
resolve_refuses "R9 prev bundle GC'd" "platform bundle 不在"
setup r10; sed -i '1s/"checksum":"[0-9a-f]*"/"checksum":"00"/' "$OC_HOTCFG_HISTORY"
resolve_refuses "R10 tampered history entry (checksum) is not trusted" "不足两条"

# S* 回退 schema 门
setup s1
if out="$(rollback_schema_gate "$MASTER_RELEASES_ROOT/rel-p" "$MASTER_RELEASES_ROOT/rel-l" 2>&1)" \
  && [[ "$out" == *"0003_c 为非破坏性"* ]]; then ok "S1 newer additive migration passes"; else bad "S1: $out"; fi
setup s2; printf '0001_a\n' >"$C/applied.txt"
gate_refuses "S2 prev required migration not applied" "未全部 applied"
setup s3; printf 'COMMERCIAL_AUTO_MIGRATE=1\n' >"$V5_ENV"
gate_refuses "S3 boot auto-migrate on" "COMMERCIAL_AUTO_MIGRATE=1"
setup s4; : >"$V5_ENV"
gate_refuses "S4 boot auto-migrate unset" "COMMERCIAL_AUTO_MIGRATE=<未设>"
setup s5; printf 'ALTER TABLE t DROP COLUMN x;\n' >"$MASTER_RELEASES_ROOT/rel-l/packages/commercial/src/db/migrations/0003_c.sql"
gate_refuses "S5 newer breaking migration" "破坏性 DDL(DROP COLUMN)"
setup s6; export OC_V5_ALLOW_BREAKING_MIGRATION=1
printf 'ALTER TABLE t RENAME COLUMN x TO y;\n' >"$MASTER_RELEASES_ROOT/rel-l/packages/commercial/src/db/migrations/0003_c.sql"
gate_refuses "S6 breaking override env does not apply to rollback" "破坏性 DDL(RENAME)"
unset OC_V5_ALLOW_BREAKING_MIGRATION
setup s7; printf '0001_a\n0002_b\n0003_c\n0004_ghost\n' >"$C/applied.txt"
gate_refuses "S7 applied migration with no source" "0004_ghost"

setup s8
sql_file_has_breaking_ddl() { echo "Traceback: boom" >&2; return 2; }
gate_refuses "S8 detector error (rc 2) fails closed" "检测器对 0003_c 异常(rc=2)"
sql_file_has_breaking_ddl() { echo "Traceback: crash" >&2; return 1; }
gate_refuses "S9 detector crash with rc 1 fails closed" "检测器对 0003_c 异常(rc=1)"
# shellcheck disable=SC1091
source "$DIR/lib/v5-migration-ddl.sh"

# S10–S13 OCV5-542:兼容候选必须有声明;检测器异常 fail-closed
setup s10; printf 'UPDATE t SET a = 1;\n' >"$MASTER_RELEASES_ROOT/rel-l/packages/commercial/src/db/migrations/0003_c.sql"
gate_refuses "S10 newer migration with an undeclared UPDATE" "未声明兼容性的候选语句(line 1 [update])"
setup s11; printf 'ALTER TABLE cron_jobs ALTER COLUMN next_fire_at SET NOT NULL;\n' >"$MASTER_RELEASES_ROOT/rel-l/packages/commercial/src/db/migrations/0003_c.sql"
gate_refuses "S11 Codex r8 SET NOT NULL is refused" "[set-not-null]"
setup s12; printf -- '-- compat: backfills a column old code never reads\nUPDATE t SET a = 1;\n' >"$MASTER_RELEASES_ROOT/rel-l/packages/commercial/src/db/migrations/0003_c.sql"
if out="$(rollback_schema_gate "$MASTER_RELEASES_ROOT/rel-p" "$MASTER_RELEASES_ROOT/rel-l" 2>&1)"; then ok "S12 declared candidate passes"; else bad "S12: $out"; fi
setup s13; ROLLBACK_COMPAT_DETECTOR="$C/missing.py"
gate_refuses "S13 compat detector missing fails closed" "兼容候选检测器对 0003_c 异常"
ROLLBACK_COMPAT_DETECTOR="$DIR/lib/v5-migration-compat.py"

# P* 回退没生效时恢复 .prev-release(Codex r1 P1)
log() { :; }
export DRY=0 CUTOVER_ROLLBACK=1
setup p1
ROLLBACK_FROM="$MASTER_RELEASES_ROOT/rel-l"; ROLLBACK_ORIG_PREV="$MASTER_RELEASES_ROOT/rel-p"
printf '%s\n' "$ROLLBACK_FROM" >"$MASTER_RELEASES_ROOT/.prev-release"   # cmd_cutover 已改写,随后失败,live 未变
rollback_restore_prev_if_unchanged
[[ "$(cat "$MASTER_RELEASES_ROOT/.prev-release")" == "$ROLLBACK_ORIG_PREV" ]] \
  && rollback_resolve_target 2>/dev/null && [[ "$ROLLBACK_MASTER" == "$MASTER_RELEASES_ROOT/rel-p" ]] \
  && ok "P1 failed rollback restores .prev-release; a retry resolves the same target" || bad "P1 restore"
setup p2
ROLLBACK_FROM="$MASTER_RELEASES_ROOT/rel-l"; ROLLBACK_ORIG_PREV="$MASTER_RELEASES_ROOT/rel-p"
ln -sfn "$MASTER_RELEASES_ROOT/rel-p" "$MASTER_LIVE_LINK"
printf '%s\n' "$ROLLBACK_FROM" >"$MASTER_RELEASES_ROOT/.prev-release"   # 回退已生效(含 stay 保留)
rollback_restore_prev_if_unchanged
[[ "$(cat "$MASTER_RELEASES_ROOT/.prev-release")" == "$MASTER_RELEASES_ROOT/rel-l" ]] \
  && ok "P2 effective rollback keeps .prev-release = rolled-back-from (roll forward possible)" || bad "P2"
export CUTOVER_ROLLBACK=0

# E* 回退身份不从环境继承(Codex r1 P1)
pre="$(awk '/^for arg in "\$@"; do$/{exit} {print}' "$DEPLOY")"
for v in CUTOVER_ROLLBACK=0 'ROLLBACK_SHA=""' 'ROLLBACK_FROM=""' 'ROLLBACK_ORIG_PREV=""'; do
  grep -qxF -- "$v" <<<"$pre" && ok "E1 $v reset before argument parsing" || bad "E1 $v not reset at top level"
done

# W* 接线:回退模式下 cmd_cutover 走回退 schema 门而不是迁移门/迁移 runner
step3="$(awk '/^cmd_cutover\(\) \{/{f=1} f && /step=3/{g=1} g{print} g && /^  fi$/{exit}' "$DEPLOY")"
if [[ "$step3" == *'CUTOVER_ROLLBACK:-0}" == 1'*'rollback_schema_gate'*'CUTOVER_HAS_MIGRATION=0'*'gate_cutover_migrations'* ]]; then
  ok "W1 cutover step 3 gates rollback with rollback_schema_gate and never applies migrations"
else
  bad "W1 cutover step 3 wiring"
fi
grep -qE '^  rollback\) cmd_rollback ;;$' "$DEPLOY" && ok "W2 --rollback dispatches to cmd_rollback" || bad "W2 dispatch"
grep -qE '^    deploy\|bootstrap\|build-master-only\|cutover\|rollback\)$' "$DEPLOY" \
  && ok "W3 --rollback takes the deploy lock" || bad "W3 lock"

# OCV5-541:dry-run 结束只报计划,不报“完成”
tail_rb="$(awk '/^cmd_rollback\(\) \{/{f=1} f{print} f && /^\}$/{exit}' "$DIR/lib/v5-selfhost-rollback.sh")"
dry_line="$(grep -n -- '--rollback --dry-run 计划结束' <<<"$tail_rb" | cut -d: -f1)"
done_line="$(grep -n -- '✓ --rollback 完成' <<<"$tail_rb" | cut -d: -f1)"
guard_line="$(grep -nE '^  if \[\[ "\$DRY" == 1 \]\]; then' <<<"$tail_rb" | tail -1 | cut -d: -f1)"
if [[ -n "$dry_line" && -n "$done_line" && -n "$guard_line" ]] && (( guard_line < dry_line && dry_line < done_line )) \
  && sed -n "${dry_line},${done_line}p" <<<"$tail_rb" | grep -qE '^    return 0$'; then
  ok "W4 --rollback --dry-run ends with a plan line and returns before the 完成 line"
else
  bad "W4 dry-run end message"
fi

echo "rollback tests: $pass passed, $fail failed"
[[ "$fail" == 0 ]]
