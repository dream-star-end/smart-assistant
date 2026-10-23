#!/usr/bin/env bash
# Candidate unit snapshot lifecycle; paths and ownership rules are unchanged.

snapshot_cutover_units_from_release() { # <rel> <out-var>
  local rel="$1" dest_var="$2" snap src_dir
  [[ "$dest_var" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || return 1
  src_dir="$rel/deploy/v5-selfhost"
  [[ -d "$src_dir" ]] || { mlog "候选缺 $src_dir"; return 1; }
  assert_unit_templates_live_wd "$src_dir"
  snap="/run/openclaude-v5-selfhost/cutover-unit-snap.$$"
  rm -rf -- "$snap"
  mkdir -p -- "$snap" || return 1
  chmod 0700 -- "$snap" || return 1
  cp -a -- "$src_dir/${V5_UNIT}" "$snap/" || { rm -rf -- "$snap"; return 1; }
  cp -a -- "$src_dir/${V5_EGRESS_UNIT}" "$snap/" || { rm -rf -- "$snap"; return 1; }
  # 双槽 egress 模板 + sysctl(候选自带才快照)。
  local f
  for f in "${V5_EGRESS_SLOT_SOCKET_TPL:-openclaude-v5-selfhost-egress@.socket}" \
           "${V5_EGRESS_SLOT_SERVICE_TPL:-openclaude-v5-selfhost-egress@.service}" \
           "${V5_EGRESS_SYSCTL_FILE:-99-openclaude-v5-selfhost-egress.sysctl.conf}"; do
    if [[ -f "$src_dir/$f" && ! -L "$src_dir/$f" ]]; then
      cp -a -- "$src_dir/$f" "$snap/" || { rm -rf -- "$snap"; return 1; }
      fsync_path "$snap/$f" || { rm -rf -- "$snap"; return 1; }
    fi
  done
  snapshot_host_log_policy "$rel" "$snap" || { rm -rf -- "$snap"; return 1; }
  assert_unit_templates_live_wd "$snap"
  fsync_path "$snap/${V5_UNIT}" || { rm -rf -- "$snap"; return 1; }
  fsync_path "$snap/${V5_EGRESS_UNIT}" || { rm -rf -- "$snap"; return 1; }
  CUTOVER_UNIT_SNAP="$snap"
  printf -v "$dest_var" '%s' "$snap"
}

cleanup_cutover_unit_snap() {
  local snap="${CUTOVER_UNIT_SNAP:-}"
  CUTOVER_UNIT_SNAP=""
  [[ -n "$snap" ]] || return 0
  case "$snap" in
    /run/openclaude-v5-selfhost/cutover-unit-snap.*)
      rm -rf -- "$snap"
      ;;
  esac
}
