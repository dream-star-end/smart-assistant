#!/usr/bin/env bash
# OCV5-534(FINDINGS DEP-6)个人版 --rollback:目标解析、回退 schema 门、失败时恢复 .prev-release、入口。
# 由 deploy-v5-selfhost.sh 在 master release lib 之后 source;翻转本身复用 cmd_cutover 的 joint 状态机。
# 依赖调用方提供:mlog/log/die、canonicalize_prev_release、read_required_migration_gap、write_prev_release_file、
# sql_file_has_breaking_ddl、oc_hotcfg_*(runtime lib)、preflight_common、lease_train_begin/finish、cmd_cutover。
# OCV5-542:本阶段只做加法的兼容候选检测器(逐条语句;候选须带 -- compat: 声明),与本文件同目录。
ROLLBACK_COMPAT_DETECTOR="${ROLLBACK_COMPAT_DETECTOR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/v5-migration-compat.py}"

# ── --rollback(OCV5-534,FINDINGS DEP-6)────────────────────────────────────
# 一次只退一步:master 目标只取 .prev-release(canonicalize + digest),运行四元组只取 history 里
# masterRelease==prev 的那条 committed 记录。血缘不连续就拒绝,不猜(同商业 --rollback=1 的取舍)。
# 成功时设置 ROLLBACK_MASTER / ROLLBACK_SHA / ROLLBACK_IMAGE / ROLLBACK_IMAGE_ID /
# ROLLBACK_RUNTIME_RELEASE / ROLLBACK_BUNDLE;失败 return 1 并 mlog 原因,不改任何东西。
rollback_resolve_target() {
  local live raw prev last before f
  ROLLBACK_MASTER=""; ROLLBACK_SHA=""; ROLLBACK_IMAGE=""; ROLLBACK_IMAGE_ID=""
  ROLLBACK_RUNTIME_RELEASE=""; ROLLBACK_BUNDLE=""
  [[ -L "$MASTER_LIVE_LINK" ]] || { mlog "回退: 缺 live symlink $MASTER_LIVE_LINK"; return 1; }
  live="$(readlink -f -- "$MASTER_LIVE_LINK" 2>/dev/null || true)"
  [[ -n "$live" && -d "$live" ]] || { mlog "回退: live symlink 无法解析"; return 1; }
  raw="$(tr -d '[:space:]' <"$MASTER_RELEASES_ROOT/.prev-release" 2>/dev/null || true)"
  if ! prev="$(canonicalize_prev_release "$raw")"; then
    mlog "回退: .prev-release=${raw:-<空>} 不是可用的上一版(none、不在 releases 根内、.poisoned 或 digest 不符)"
    return 1
  fi
  [[ "$prev" != "$live" ]] || { mlog "回退: .prev-release 就是 live($live),没有可退的上一版"; return 1; }
  last="$(oc_hotcfg_history_nth_committed "$OC_HOTCFG_HISTORY" 1)"
  before="$(oc_hotcfg_history_nth_committed "$OC_HOTCFG_HISTORY" 2)"
  [[ -n "$last" && -n "$before" ]] \
    || { mlog "回退: $OC_HOTCFG_HISTORY 里不足两条校验通过的 committed 记录"; return 1; }
  f="$(jq -r '.masterRelease' <<<"$last")"
  [[ "$f" == "$live" ]] \
    || { mlog "回退: history 最后一条 masterRelease=$f ≠ live=$live(live 不是经 joint 状态机上线的,不自动回退)"; return 1; }
  f="$(jq -r '.transitionKind' <<<"$last")"
  [[ "$f" == joint ]] || { mlog "回退: history 最后一条 transitionKind=$f,只从 joint 记录回退"; return 1; }
  f="$(jq -r '.previousMasterRelease' <<<"$last")"
  [[ "$f" == "$prev" ]] \
    || { mlog "回退: history 最后一条 previousMasterRelease=$f ≠ .prev-release=$prev(血缘断开)"; return 1; }
  f="$(jq -r '.masterRelease' <<<"$before")"
  [[ "$f" == "$prev" ]] \
    || { mlog "回退: history 倒数第二条 masterRelease=$f ≠ .prev-release=$prev(找不到上一版当时的运行四元组)"; return 1; }
  case "$(jq -r '.transitionKind' <<<"$before")" in
    joint|prestate) ;;
    *) mlog "回退: history 倒数第二条 transitionKind=$(jq -r '.transitionKind' <<<"$before"),只接受 joint/prestate"; return 1 ;;
  esac
  ROLLBACK_IMAGE="$(jq -r '.image' <<<"$before")"
  ROLLBACK_IMAGE_ID="$(jq -r '.image_id' <<<"$before")"
  ROLLBACK_RUNTIME_RELEASE="$(jq -r '.release' <<<"$before")"
  ROLLBACK_BUNDLE="$(jq -r '.bundle' <<<"$before")"
  [[ -n "$ROLLBACK_IMAGE" && "$ROLLBACK_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] \
    || { mlog "回退: 上一版四元组镜像字段非法 image=$ROLLBACK_IMAGE id=$ROLLBACK_IMAGE_ID"; return 1; }
  [[ "$ROLLBACK_RUNTIME_RELEASE" == "$OC_HOTCFG_RELEASES_ROOT"/rel-* && -d "$ROLLBACK_RUNTIME_RELEASE" ]] \
    || { mlog "回退: 上一版 runtime release 不在或已被回收: $ROLLBACK_RUNTIME_RELEASE"; return 1; }
  [[ "$ROLLBACK_BUNDLE" == "$OC_HOTCFG_PLATFORM_ROOT"/bundles/* && -d "$ROLLBACK_BUNDLE" ]] \
    || { mlog "回退: 上一版 platform bundle 不在或已被回收: $ROLLBACK_BUNDLE"; return 1; }
  ROLLBACK_SHA="$(jq -er '.sourceCommit' "$prev/.complete" 2>/dev/null || true)"
  [[ "$ROLLBACK_SHA" =~ ^[0-9a-f]{40}$ ]] || { mlog "回退: $prev/.complete sourceCommit 非法"; return 1; }
  ROLLBACK_MASTER="$prev"
}

# 回退只换代码,从不跑迁移、不回滚 schema。旧代码面对新库成立的条件(全部只读检查):
# ① 上一版 requiredMigrations 全部已 applied;
# ② 库里有、上一版目录里没有的迁移,每一支都能在 live release 里找到原文,且不是破坏性 DDL
#    (旧代码可能还读被删/改名的列);OC_V5_ALLOW_BREAKING_MIGRATION 对回退无效;
# ③ COMMERCIAL_AUTO_MIGRATE=0:旧 migrate.ts 规则 (a) 见到目录里没有的已 applied 版本会拒绝,master 起不来。
rollback_schema_gate() { # <prev-rel> <live-rel>
  local prev="$1" live="$2" gap applied v sql hit auto out rc r newer=0
  if ! gap="$(read_required_migration_gap "$prev")"; then
    mlog "回退 schema 门: requiredMigrations↔schema_migrations 比对失败(fail-closed)"
    return 1
  fi
  [[ -z "$gap" ]] || { mlog "回退 schema 门: 上一版要求的迁移未全部 applied:"; mlog "$gap"; return 1; }
  auto="$(oc_hotcfg_env_get "$V5_ENV" COMMERCIAL_AUTO_MIGRATE)"
  [[ "$auto" == 0 ]] \
    || { mlog "回退 schema 门: $V5_ENV COMMERCIAL_AUTO_MIGRATE=${auto:-<未设>},必须是 0(否则旧 master 启动时迁移器会因库比代码新而拒起)"; return 1; }
  if ! applied="$(sudo -u postgres psql -X -d "${PG_DB:-openclaude_v5_selfhost}" -tAc \
    "SELECT version FROM schema_migrations ORDER BY version" 2>/dev/null)"; then
    mlog "回退 schema 门: 只读查询 schema_migrations 失败(fail-closed)"
    return 1
  fi
  while IFS= read -r v; do
    v="${v//[[:space:]]/}"
    [[ -n "$v" ]] || continue
    [[ -f "$prev/packages/commercial/src/db/migrations/$v.sql" ]] && continue
    newer=$((newer + 1))
    sql="$live/packages/commercial/src/db/migrations/$v.sql"
    [[ -f "$sql" ]] || { mlog "回退 schema 门: 库里已 applied 的 $v 在上一版和 live 里都没有原文,来源不明,拒绝"; return 1; }
    # 检测器 rc 0=破坏性,1=未命中;但 python 异常也是 rc 1,所以只有“rc 1 且无任何输出”才算安全,其余 fail-closed。
    out="$( { r=0; sql_file_has_breaking_ddl "$sql" || r=$?; printf '\nrc=%s' "$r"; } 2>&1 )"
    rc="${out##*rc=}"
    hit="${out%$'\n'rc=*}"
    hit="${hit//$'\n'/ }"
    hit="${hit## }"; hit="${hit%% }"
    if [[ "$rc" == 0 ]]; then
      mlog "回退 schema 门: 上一版之后 applied 的 $v 含破坏性 DDL($hit),旧代码可能读不到,拒绝回退。改走前滚修复。"
      return 1
    fi
    if [[ "$rc" != 1 || -n "$hit" ]]; then
      mlog "回退 schema 门: 破坏性 DDL 检测器对 $v 异常(rc=$rc),无法证明兼容,拒绝回退(fail-closed)"
      return 1
    fi
    # OCV5-542:还要过兼容候选检测器。候选(改类型/非空/约束/唯一索引/单独 DROP/改名/触发器/函数/
    # UPDATE/DELETE/动态 SQL/无法分类)没有 -- compat: 声明 → 无法证明旧代码能读写,拒绝。rc 0=无未声明候选,
    # 1=有,其余(含检测器缺失)fail-closed。
    out="$( { r=0; python3 "$ROLLBACK_COMPAT_DETECTOR" "$sql" 2>&1 || r=$?; printf '\nrc=%s' "$r"; } )"
    rc="${out##*rc=}"
    if [[ "$rc" == 1 ]]; then
      hit="$(grep -F '"declared": false' <<<"${out%$'\n'rc=*}" | jq -r '"line \(.line) [\(.kinds | join(","))]"' 2>/dev/null | tr '\n' ' ')"
      mlog "回退 schema 门: 上一版之后 applied 的 $v 有未声明兼容性的候选语句(${hit% }),无法证明旧代码能读写,拒绝回退。改走前滚修复。"
      return 1
    fi
    if [[ "$rc" != 0 ]]; then
      mlog "回退 schema 门: 兼容候选检测器对 $v 异常(rc=$rc),无法证明兼容,拒绝回退(fail-closed)"
      return 1
    fi
    mlog "  回退 schema 门: 上一版之后 applied 的 $v 为非破坏性 DDL,旧代码可共存"
  done <<<"$applied"
  mlog "  ✓ 回退 schema 门通过(上一版之后新增迁移 $newer 支,均非破坏性;不跑迁移、不回滚 schema)"
}

# cmd_cutover 在等空闲之前就把 .prev-release 改成当前 live。回退没生效(切流前失败,或被补偿切回原 live)
# 时把它恢复成原来的上一版,否则下一次 --rollback 会因“上一版就是 live”被拒。只在仍持锁的 EXIT 里调用。
rollback_restore_prev_if_unchanged() {
  [[ "${CUTOVER_ROLLBACK:-0}" == 1 && "$DRY" != 1 && -n "$ROLLBACK_FROM" && -n "$ROLLBACK_ORIG_PREV" ]] || return 0
  [[ "$(readlink -f -- "$MASTER_LIVE_LINK" 2>/dev/null || true)" == "$ROLLBACK_FROM" ]] || return 0
  [[ "$(tr -d '[:space:]' <"$MASTER_RELEASES_ROOT/.prev-release" 2>/dev/null || true)" != "$ROLLBACK_ORIG_PREV" ]] || return 0
  if write_prev_release_file "$ROLLBACK_ORIG_PREV"; then
    log "  回退未生效,live 仍是 $ROLLBACK_FROM:已把 .prev-release 恢复为 $ROLLBACK_ORIG_PREV"
  else
    log "  ⚠ 回退未生效,但恢复 .prev-release=$ROLLBACK_ORIG_PREV 失败;下次回退前请人工核对"
  fi
}

# OCV5-534(FINDINGS DEP-6):官方回退入口。只解析目标与只读门,翻转完全复用 cmd_cutover 的 joint
# 状态机(survivor、两级补偿、C1–C3/G1 门、stay 策略都不变),不是第二份切流逻辑。
cmd_rollback() {
  local live
  log "══ v5 selfhost --rollback(退回 .prev-release 与它当时的运行四元组,一次一步) ══"
  preflight_common
  [[ -f "$V5_ENV" ]] || die "缺 $V5_ENV,这不是已安装实例。"
  live="$(readlink -f -- "$MASTER_LIVE_LINK" 2>/dev/null || true)"
  rollback_resolve_target || die "回退目标不成立,未改任何东西。现场: live=${live:-?} .prev-release 与 $OC_HOTCFG_HISTORY"
  CUTOVER_ROLLBACK=1
  ROLLBACK_FROM="$live"
  ROLLBACK_ORIG_PREV="$ROLLBACK_MASTER"
  log "  live   = $live"
  log "  目标   = $ROLLBACK_MASTER (sourceCommit ${ROLLBACK_SHA:0:12})"
  log "  四元组 = image=$ROLLBACK_IMAGE id=${ROLLBACK_IMAGE_ID:7:12} runtime=${ROLLBACK_RUNTIME_RELEASE##*/} bundle=${ROLLBACK_BUNDLE##*/}"
  oc_hotcfg_assert_tuple_viable "$ROLLBACK_IMAGE" "$ROLLBACK_IMAGE_ID" "$ROLLBACK_RUNTIME_RELEASE" \
    || die "上一版运行四元组不可激活(镜像缺失/被重打或地板不满足),未改任何东西。"
  lease_train_begin "$ROLLBACK_SHA"
  RUNTIME_IMAGE="$ROLLBACK_IMAGE"
  RUNTIME_IMAGE_ID="$ROLLBACK_IMAGE_ID"
  BUILT_RUNTIME_RELEASE="$ROLLBACK_RUNTIME_RELEASE"
  BUILT_BUNDLE_REV="${ROLLBACK_BUNDLE##*/}"
  CUTOVER_TUPLE_BUNDLE="$ROLLBACK_BUNDLE"
  DEPLOY_BUILT_RELEASE="$ROLLBACK_MASTER"
  DEPLOY_BUILT_SOURCE_COMMIT="$ROLLBACK_SHA"
  CUTOVER_JOINT=1
  log "── 进入 --cutover 翻转窗口(同一套状态机) release=$ROLLBACK_MASTER ──"
  cmd_cutover
  lease_train_finish committed "rollback committed live=$ROLLBACK_MASTER from=$live"
  log "✓ --rollback 完成 live → $ROLLBACK_MASTER(.prev-release 现指向 $live;再跑一次 --rollback 即前滚回去)"
}
