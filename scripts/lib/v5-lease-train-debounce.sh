#!/usr/bin/env bash
# v5-lease-train-debounce.sh — OCV5-904 列车合流防抖 + planned 自动快进最新 CI 绿灯 SHA + 宿主 Governor 模式总闸。
# 由 scripts/v5-lease-worker.sh source；无阻塞 sleep，完全兼容 30s systemd oneshot tick 与隔离沙箱单测。

OC_V5_TRAIN_DEBOUNCE_SEC="${OC_V5_TRAIN_DEBOUNCE_SEC:-45}"
OC_V5_PLANNED_FF_MAX_SCAN="${OC_V5_PLANNED_FF_MAX_SCAN:-8}"
WORKER_CI_REQUIRED_WORKFLOWS_DEFAULT="V5 selfhost gates,V5 selfhost release gates"

_worker_governor_mode_file() {
  printf '%s\n' "${OC_V5_GOVERNOR_MODE_FILE:-${OC_GOVERNOR_ROOT:-/opt/openclaude/harness-gate}/control/mode.json}"
}

# 检查宿主物理总闸 mode.json：
# - 返回 0 表示阻断发车(emergency_stop 或损坏/符号链接 fail-closed)
# - 返回 1 表示允许继续发车(文件不存在向后兼容、autonomous、或 debt_first 交由 deploy 验提交前缀)
worker_governor_blocks_dispatch() {
  local mode_file mode reason
  mode_file="$(_worker_governor_mode_file)"
  if [[ ! -e "$mode_file" && ! -L "$mode_file" ]]; then
    return 1
  fi
  if [[ -L "$mode_file" || ! -f "$mode_file" ]]; then
    wlog "🛑 宿主 Governor mode.json 非普通文件或为符号链接($mode_file)，fail-closed 暂停发车"
    return 0
  fi
  mode="$(jq -er '.mode // empty' "$mode_file" 2>/dev/null || true)"
  reason="$(jq -r '.reason // ""' "$mode_file" 2>/dev/null | tr '\n\r\t' '   ' | cut -c1-200 || true)"
  case "$mode" in
    autonomous)
      return 1
      ;;
    debt_first)
      wlog "  [governor] mode=debt_first(reason=${reason:-<未说明>})，放行至 deploy 校验清债提交前缀"
      return 1
      ;;
    emergency_stop)
      wlog "🛑 宿主 Governor 处于 emergency_stop 模式(reason=${reason:-<未说明>})，暂停自动发车"
      return 0
      ;;
    *)
      wlog "🛑 宿主 Governor mode.json 非法或损坏(mode=${mode:-<empty>}, file=$mode_file)，fail-closed 暂停发车"
      return 0
      ;;
  esac
}

# 45s 列车合流防抖窗口：
# 收到首个待发 ride lease 后等待 OC_V5_TRAIN_DEBOUNCE_SEC(默认 45s)内的后续连推合流为同一趟车。
# 返回 0 表示仍在防抖等待窗口内(本 tick 暂缓发车)；返回 1 表示窗口已满(或防抖=0)可立即发车。
worker_train_debounce_waiting() {
  local win="${OC_V5_TRAIN_DEBOUNCE_SEC:-45}" row first_epoch now_epoch pending_cnt age remain
  if [[ ! "$win" =~ ^(0|[1-9][0-9]*)$ ]]; then
    wlog "  ⚠ OC_V5_TRAIN_DEBOUNCE_SEC=$win 非法，回退默认 45s"
    win=45
  fi
  (( win > 0 )) || return 1

  row="$(lease_sql "SELECT COALESCE(CAST(strftime('%s', MIN(created_at)) AS INTEGER),0)||'|'||CAST(strftime('%s','now') AS INTEGER)||'|'||COUNT(*) FROM lease WHERE resource='$RESOURCE' AND status='registered' AND mode='ride';")" || return 1
  IFS='|' read -r first_epoch now_epoch pending_cnt <<<"$row"
  if [[ -n "${OC_V5_NOW_EPOCH:-}" && "$OC_V5_NOW_EPOCH" =~ ^[0-9]+$ ]]; then
    now_epoch="$OC_V5_NOW_EPOCH"
  fi
  [[ "$first_epoch" =~ ^[1-9][0-9]*$ && "$now_epoch" =~ ^[0-9]+$ ]] || return 1

  age=$(( now_epoch - first_epoch ))
  (( age < 0 )) && age=0
  if (( age < win )); then
    remain=$(( win - age ))
    wlog "⏳ 列车合流防抖窗口中: 首个待发 ride 已等 ${age}s / ${win}s (剩余 ${remain}s, 待合流 rides=${pending_cnt:-?})，等待后续连推合流"
    return 0
  fi
  wlog "✓ 列车合流防抖窗口已满 (${age}s >= ${win}s, 合流 rides=${pending_cnt:-?})，放行发车"
  return 1
}

_worker_detect_gh_repo() {
  if [[ -n "${OC_V5_GH_REPO:-}" ]]; then
    printf '%s\n' "$OC_V5_GH_REPO"
    return 0
  fi
  local url="" slug=""
  url="$(git -C "$LEASE_REPO_ROOT" remote get-url origin 2>/dev/null || true)"
  if [[ "$url" =~ github\.com[:/]([A-Za-z0-9._-]+/[A-Za-z0-9._-]+)(\.git)?$ ]]; then
    slug="${BASH_REMATCH[1]}"
    slug="${slug%.git}"
    printf '%s\n' "$slug"
    return 0
  fi
  return 1
}

# 判定某 40-hex SHA 在 GitHub Actions 全部必需 workflow 均为 completed/success。
# fail-closed: 无 gh / 非 GitHub origin / API 错误 / 任一必需 workflow 非绿均返回 1(不做盲目快进)。
worker_sha_ci_green() { # <40-hex-sha>
  local sha="$1" gh_bin="${OC_V5_GH_BIN:-gh}" gh_repo="" req_csv="" resp=""
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || return 1
  if [[ -n "${OC_V5_WORKER_CI_CHECK_CMD:-}" ]]; then
    bash -c "$OC_V5_WORKER_CI_CHECK_CMD" -- "$sha" >/dev/null 2>&1
    return $?
  fi
  command -v "$gh_bin" >/dev/null 2>&1 || return 1
  gh_repo="$(_worker_detect_gh_repo)" || return 1
  req_csv="${OC_V5_CI_REQUIRED_WORKFLOWS:-$WORKER_CI_REQUIRED_WORKFLOWS_DEFAULT}"
  resp="$("$gh_bin" api "repos/${gh_repo}/actions/runs?head_sha=${sha}&per_page=100" 2>/dev/null)" || return 1
  V5_CI_RUNS_JSON="$resp" python3 - "$req_csv" "$sha" <<'PY' >/dev/null 2>&1
import json, os, sys

req = [x.strip() for x in sys.argv[1].split(",") if x.strip()]
sha = sys.argv[2]
if not req:
    sys.exit(1)
data = json.loads(os.environ.get("V5_CI_RUNS_JSON", ""))
runs = data.get("workflow_runs")
if not isinstance(runs, list):
    sys.exit(1)
by_name = {}
for r in runs:
    if not isinstance(r, dict):
        continue
    if r.get("head_sha") and r.get("head_sha") != sha:
        continue
    name = r.get("name")
    if not isinstance(name, str):
        continue
    key = (str(r.get("created_at") or ""), int(r.get("id") or 0))
    if name not in by_name or key > by_name[name][0]:
        by_name[name] = (key, r)
for wf in req:
    ent = by_name.get(wf)
    if ent is None:
        sys.exit(1)
    r = ent[1]
    if r.get("status") != "completed" or r.get("conclusion") != "success":
        sys.exit(1)
sys.exit(0)
PY
}

# planned 阶段启动 deploy-v5-selfhost.sh 前：
# 自动 git fetch origin $LEASE_BRANCH 检查是否有更新的已推送且 CI 绿灯 SHA；
# 若存在(且本 train 未绑定精确源 policy/inflight)，快进工作树与 planned train.target_sha，
# 并合并覆盖期间所有祖先 ride leases，避免发车过时 SHA 导致覆盖错配。
worker_planned_fast_forward_green_tip() { # <train_id> <tip_var_name>
  local train_id="$1" tip_var="$2" cur_tip="" latest_tip="" ev_doc="" max_scan=""
  local cand="" chosen="" head="" now="" ride_row rid rsha covered_count=0
  local -a covered_ids=()
  cur_tip="${!tip_var}"
  [[ "$cur_tip" =~ ^[0-9a-f]{40}$ ]] || return 0

  git -C "$LEASE_REPO_ROOT" fetch -q origin "$LEASE_BRANCH" 2>/dev/null || true
  latest_tip="$(lease_remote_tip 2>/dev/null || true)"
  [[ -n "$latest_tip" && "$latest_tip" != "$cur_tip" ]] || return 0

  if ! git -C "$LEASE_REPO_ROOT" merge-base --is-ancestor "$cur_tip" "$latest_tip" 2>/dev/null; then
    wlog "train $train_id planned 检测到 origin tip ${latest_tip:0:12} 与 ${cur_tip:0:12} 非快进血缘，保持原 target"
    return 0
  fi

  # 若已绑定精确源 releasePolicy 或 allow-inflight，禁止漂移 target_sha(遵守精确源授权契约)
  ev_doc="$(train_field "$train_id" evidence_json 2>/dev/null || true)"
  [[ -n "$ev_doc" ]] || ev_doc='{}'
  if jq -e 'type=="object" and (has("releasePolicy") or has("cutover"))' <<<"$ev_doc" >/dev/null 2>&1; then
    wlog "train $train_id 已绑定精确源 policy/inflight(${cur_tip:0:12})，不快进 target_sha"
    return 0
  fi

  max_scan="${OC_V5_PLANNED_FF_MAX_SCAN:-8}"
  [[ "$max_scan" =~ ^[1-9][0-9]*$ ]] || max_scan=8
  while IFS= read -r cand; do
    [[ "$cand" =~ ^[0-9a-f]{40}$ ]] || continue
    if worker_sha_ci_green "$cand"; then
      chosen="$cand"
      break
    fi
  done < <(git -C "$LEASE_REPO_ROOT" rev-list --max-count="$max_scan" "${cur_tip}..${latest_tip}" 2>/dev/null || true)

  if [[ -z "$chosen" ]]; then
    wlog "train $train_id planned 检测到更新推送 ${latest_tip:0:12}，但尚无 CI 绿灯新提交，保持原 target ${cur_tip:0:12}"
    return 0
  fi

  # 在持 deploy.lock(fd 8) 内将发版工作树快进到最新绿灯 SHA
  head="$(git -C "$LEASE_REPO_ROOT" rev-parse HEAD 2>/dev/null || true)"
  if [[ "$head" != "$chosen" ]]; then
    if ! canonical_fast_forward "$head" "$chosen"; then
      wlog "train $train_id planned 快进工作树到 ${chosen:0:12} 失败，保持原 target ${cur_tip:0:12}"
      return 0
    fi
  fi

  # 统计期间所有被 chosen 覆盖的祖先 ride leases
  while IFS='|' read -r rid rsha; do
    [[ -n "$rid" && "$rsha" =~ ^[0-9a-f]{40}$ ]] || continue
    if lease_sha_contained "$rsha" "$chosen"; then
      covered_ids+=("$rid")
      covered_count=$((covered_count + 1))
    fi
  done < <(lease_sql "SELECT id||'|'||want_sha FROM lease WHERE resource='$RESOURCE' AND status='registered' AND mode='ride' ORDER BY seq;")

  local ids_json ev_patch ev_merge
  if (( covered_count > 0 )); then
    ids_json="$(printf '%s\n' "${covered_ids[@]}" | jq -R . | jq -cs .)"
  else
    ids_json='[]'
  fi
  now="$(lease_now)"
  ev_patch="$(jq -cn --arg from "$cur_tip" --arg to "$chosen" --arg at "$now" --argjson rides "$ids_json" \
    '{plannedFastForward:{from:$from,to:$to,at:$at,coveredLeaseIds:$rides}}')" || return 0
  ev_merge="$(lease_json_object_merge_sql evidence_json "$ev_patch")" || return 0

  if lease_tx <<SQL
.bail on
BEGIN IMMEDIATE;
UPDATE train
   SET target_sha='$(lease_q "$chosen")',
       evidence_json=$ev_merge,
       updated_at='$now'
 WHERE id='$(lease_q "$train_id")' AND status='planned' AND target_sha='$(lease_q "$cur_tip")';
$(lease_event_sql "$train_id" train-fast-forward "$ACTOR" "from=$cur_tip to=$chosen covered_rides=$covered_count")
COMMIT;
SQL
  then
    printf -v "$tip_var" '%s' "$chosen"
    wlog "train $train_id planned 自动快进: ${cur_tip:0:12} → ${chosen:0:12} (CI 绿灯, 合并覆盖祖先 rides=$covered_count)"
  else
    wlog "train $train_id planned 快进写库失败，保持原 target ${cur_tip:0:12}"
  fi
  return 0
}
