#!/usr/bin/env bash
# v5-lease-train-debounce.sh — OCV5-903/904 列车合流防抖 + 当前远端 tip CI 三态分类 + planned 安全 FF CAS + 宿主 Governor 模式总闸。
# 由 scripts/v5-lease-worker.sh source；无阻塞 sleep，完全兼容 30s systemd oneshot tick 与隔离沙箱单测。

OC_V5_TRAIN_DEBOUNCE_SEC="${OC_V5_TRAIN_DEBOUNCE_SEC:-45}"
OC_V5_CI_PENDING_GRACE_SEC="${OC_V5_CI_PENDING_GRACE_SEC:-2700}"
WORKER_CI_REQUIRED_WORKFLOWS_DEFAULT="V5 selfhost gates,V5 selfhost release gates,V5 selfhost commercial"

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

# 判断当前 worker 环境是否启用 CI 三态门（生产 GitHub 仓库或显式配置测试 hook 时必启；
# 离线本地 bare repo 单测无 GitHub remote 且未显式开启时跳过，不阻塞既有离线单测）。
worker_ci_precheck_applicable() {
  if [[ "${OC_V5_WORKER_CI_REQUIRED:-0}" == 1 ]]; then
    return 0
  fi
  if [[ -n "${OC_V5_WORKER_CI_STATUS_CMD:-}" || -n "${OC_V5_WORKER_CI_CHECK_CMD:-}" || -n "${OC_V5_GH_REPO:-}" ]]; then
    return 0
  fi
  _worker_detect_gh_repo >/dev/null 2>&1
}

# 计算当前最早待发 ride 的等待时长（秒），用于有界 pending 宽限判断。
_worker_oldest_pending_ride_age_sec() {
  if [[ -n "${OC_V5_CI_PENDING_AGE_SEC:-}" && "$OC_V5_CI_PENDING_AGE_SEC" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$OC_V5_CI_PENDING_AGE_SEC"
    return 0
  fi
  local row="" first_epoch="" now_epoch="" age=0
  row="$(lease_sql "SELECT COALESCE(CAST(strftime('%s', MIN(created_at)) AS INTEGER),0)||'|'||CAST(strftime('%s','now') AS INTEGER) FROM lease WHERE resource='$RESOURCE' AND status='registered' AND mode='ride';" 2>/dev/null || true)"
  IFS='|' read -r first_epoch now_epoch <<<"$row"
  if [[ -n "${OC_V5_NOW_EPOCH:-}" && "$OC_V5_NOW_EPOCH" =~ ^[0-9]+$ ]]; then
    now_epoch="$OC_V5_NOW_EPOCH"
  fi
  if [[ "$first_epoch" =~ ^[1-9][0-9]*$ && "$now_epoch" =~ ^[0-9]+$ ]]; then
    age=$(( now_epoch - first_epoch ))
    (( age < 0 )) && age=0
  fi
  printf '%s\n' "$age"
}

# B5: 对指定 40-hex SHA 的必需 CI 状态做严格三分类（只认受信任事件 push / pull_request / merge_group，拒 workflow_dispatch！）：
# stdout:
#   success\t<detail>          — 全部必需 workflow 均有受信任事件且最新为 completed/success
#   pending\t<detail>          — 无任一必需 workflow 终态失败，且至少一个为 queued/in_progress/waiting/尚未登记（在宽限期内）
#   pending_timeout\t<detail>  — 仍无终态失败但已超出有界宽限期（报警且仍明确区分于真红！）
#   failed\t<detail>           — 至少一个必需 workflow 终态失败（failure/cancelled/timed_out/startup_failure/action_required/stale）
worker_sha_ci_status() { # <40-hex-sha>
  local sha="$1" gh_bin="${OC_V5_GH_BIN:-gh}" gh_repo="" req_csv="" resp=""
  local grace="${OC_V5_CI_PENDING_GRACE_SEC:-2700}" age=0 out="" st="" detail=""
  if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
    printf 'failed\tinvalid-sha:%s\n' "$sha"
    return 0
  fi
  [[ "$grace" =~ ^(0|[1-9][0-9]*)$ ]] || grace=2700
  age="$(_worker_oldest_pending_ride_age_sec)"

  if [[ -n "${OC_V5_WORKER_CI_STATUS_CMD:-}" ]]; then
    out="$(bash -c "$OC_V5_WORKER_CI_STATUS_CMD" -- "$sha" 2>/dev/null || true)"
    IFS=$'\t' read -r st detail <<<"$out"
    if [[ -z "$detail" && "$st" == *" "* ]]; then
      detail="${st#* }"
      st="${st%% *}"
    fi
    case "$st" in
      success) printf 'success\t%s\n' "${detail:-custom-cmd}" ;;
      pending)
        if (( grace > 0 && age > grace )); then
          printf 'pending_timeout\t%s (age=%ss > grace=%ss)\n' "${detail:-pending}" "$age" "$grace"
        else
          printf 'pending\t%s\n' "${detail:-pending}"
        fi
        ;;
      pending_timeout) printf 'pending_timeout\t%s\n' "${detail:-pending-timeout}" ;;
      failed) printf 'failed\t%s\n' "${detail:-custom-cmd-failed}" ;;
      *) printf 'pending\tunexpected-status:%s\n' "${st:-empty}" ;;
    esac
    return 0
  fi

  if [[ -n "${OC_V5_WORKER_CI_CHECK_CMD:-}" ]]; then
    local rc=0
    bash -c "$OC_V5_WORKER_CI_CHECK_CMD" -- "$sha" >/dev/null 2>&1 || rc=$?
    if (( rc == 0 )); then
      printf 'success\tlegacy-check-cmd\n'
    elif (( rc == 10 )); then
      if (( grace > 0 && age > grace )); then
        printf 'pending_timeout\tlegacy-check-cmd-pending (age=%ss > grace=%ss)\n' "$age" "$grace"
      else
        printf 'pending\tlegacy-check-cmd-pending\n'
      fi
    else
      printf 'failed\tlegacy-check-cmd-rc=%s\n' "$rc"
    fi
    return 0
  fi

  if ! command -v "$gh_bin" >/dev/null 2>&1; then
    printf 'pending\tgh-cli-missing:%s\n' "$gh_bin"
    return 0
  fi
  if ! gh_repo="$(_worker_detect_gh_repo)"; then
    printf 'pending\tgh-repo-undetected\n'
    return 0
  fi
  req_csv="${OC_V5_CI_REQUIRED_WORKFLOWS:-$WORKER_CI_REQUIRED_WORKFLOWS_DEFAULT}"
  if ! resp="$("$gh_bin" api "repos/${gh_repo}/actions/runs?head_sha=${sha}&per_page=100" 2>&1)"; then
    if (( grace > 0 && age > grace )); then
      printf 'pending_timeout\tgh-api-error:%s\n' "$(printf '%s' "${resp:0:180}" | tr '\n\r\t' '   ')"
    else
      printf 'pending\tgh-api-error:%s\n' "$(printf '%s' "${resp:0:180}" | tr '\n\r\t' '   ')"
    fi
    return 0
  fi

  V5_CI_RUNS_JSON="$resp" python3 - "$req_csv" "$sha" "$age" "$grace" <<'PY'
import json, os, sys

req_csv, sha = sys.argv[1], sys.argv[2]
age = int(sys.argv[3])
grace = int(sys.argv[4])

TRUSTED_EVENTS = {"push", "pull_request", "merge_group"}
CANONICAL_PATHS = {
    "V5 selfhost gates": ".github/workflows/v5-selfhost-gates.yml",
    "V5 selfhost release gates": ".github/workflows/v5-selfhost-release-gates.yml",
    "V5 selfhost commercial": ".github/workflows/v5-selfhost-commercial.yml",
}
PENDING_STATUSES = {"queued", "in_progress", "waiting", "requested", "pending"}

required = [x.strip() for x in req_csv.split(",") if x.strip()]
if not required:
    print("failed\trequired-workflows-empty")
    sys.exit(0)

try:
    data = json.loads(os.environ.get("V5_CI_RUNS_JSON", ""))
except Exception as exc:
    st = "pending_timeout" if (grace > 0 and age > grace) else "pending"
    print(f"{st}\tinvalid-json:{exc}")
    sys.exit(0)

runs = data.get("workflow_runs")
if not isinstance(runs, list):
    st = "pending_timeout" if (grace > 0 and age > grace) else "pending"
    print(f"{st}\tmissing-workflow_runs")
    sys.exit(0)

def matches_req(run: dict, spec: str) -> bool:
    r_path = str(run.get("path") or "").strip()
    r_name = str(run.get("name") or "").strip()
    r_wfid = str(run.get("workflow_id") or "").strip()
    if spec.isdigit():
        return r_wfid == spec
    if spec.startswith(".github/workflows/"):
        return r_path == spec
    if r_name != spec:
        return False
    expected_path = CANONICAL_PATHS.get(spec)
    if expected_path and r_path and r_path != expected_path:
        return False
    return True

trusted_best: dict[str, tuple[tuple[str, int], dict]] = {}
untrusted_seen: dict[str, set[str]] = {}

for r in runs:
    if not isinstance(r, dict):
        continue
    r_sha = r.get("head_sha")
    if r_sha and r_sha != sha:
        continue
    event = str(r.get("event") or "").strip()
    key = (str(r.get("created_at") or ""), int(r.get("id") or 0))
    for spec in required:
        if not matches_req(r, spec):
            continue
        if event not in TRUSTED_EVENTS:
            untrusted_seen.setdefault(spec, set()).add(event or "unknown")
            continue
        prev = trusted_best.get(spec)
        if prev is None or key > prev[0]:
            trusted_best[spec] = (key, r)

failed_items: list[str] = []
pending_items: list[str] = []
success_items: list[str] = []

for spec in required:
    ent = trusted_best.get(spec)
    if ent is None:
        ev_note = ""
        if spec in untrusted_seen:
            ev_note = f"(ignored untrusted event={','.join(sorted(untrusted_seen[spec]))})"
        pending_items.append(f"{spec}=unregistered{ev_note}")
        continue
    r = ent[1]
    status = str(r.get("status") or "unknown")
    conc = str(r.get("conclusion") or "")
    event = str(r.get("event") or "")
    if status == "completed":
        if conc == "success":
            success_items.append(f"{spec}=success({event})")
        else:
            failed_items.append(f"{spec}=completed/{conc or 'unknown'}({event})")
    elif status in PENDING_STATUSES:
        pending_items.append(f"{spec}={status}({event})")
    else:
        pending_items.append(f"{spec}={status}/{conc or 'none'}({event})")

if failed_items:
    print("failed\t" + "; ".join(failed_items))
elif pending_items:
    state = "pending_timeout" if (grace > 0 and age > grace) else "pending"
    extra = f" [age={age}s > grace={grace}s]" if state == "pending_timeout" else ""
    print(f"{state}\t" + "; ".join(pending_items) + extra)
else:
    print("success\t" + "; ".join(success_items))
PY
}

# 向后兼容布尔封装：仅当三态严格为 success 时返回 0。
worker_sha_ci_green() { # <40-hex-sha>
  local out="" st=""
  out="$(worker_sha_ci_status "$1")" || return 1
  IFS=$'\t' read -r st _ <<<"$out"
  [[ "$st" == "success" ]]
}

# 发车前对当前远端 tip 执行三态 CI 分类门：
# - success         → 返回 0，放行建 train / 发车
# - pending         → 返回 1，绝不建 train、绝不结算 ride 为 failed，保持 registered 等待下一 30s tick
# - pending_timeout → 返回 1，发告警（仍明确区分超时与真红），绝不误杀 ride 为 CI 红，等待下一 tick
# - failed          → 返回 1，清晰记录 CI 终态红，不启动注定失败的 deploy
worker_pre_dispatch_ci_gate() { # <40-hex-tip-sha>
  local tip="$1" out="" st="" detail=""
  worker_ci_precheck_applicable || return 0
  out="$(worker_sha_ci_status "$tip")"
  IFS=$'\t' read -r st detail <<<"$out"
  case "$st" in
    success)
      wlog "✓ [ci-gate] tip ${tip:0:12} 全部必需 CI 已绿灯: $detail"
      return 0
      ;;
    pending)
      wlog "⏳ [ci-gate] tip ${tip:0:12} CI 仍在运行/排队 ($detail)，保持 ride=registered，不建 train、不误判失败，下 30s tick 重查"
      return 1
      ;;
    pending_timeout)
      wlog "⚠ [ci-gate] tip ${tip:0:12} CI pending 超出宽限 ($detail；区别于终态红，保持 ride=registered 暂不发车)"
      if declare -F enqueue_lease_outbox >/dev/null 2>&1; then
        local rid=""
        while read -r rid; do
          [[ -n "$rid" ]] || continue
          enqueue_lease_outbox "$rid" ci_pending_timeout \
            "⏰ [CI pending 超时提醒] tip ${tip:0:12} 必需 CI 仍处于 pending 状态（未报终态失败）：${detail}。你的 ride(${rid}) 仍保持 registered 排队，绿灯后自动发车。"
        done < <(lease_sql "SELECT id FROM lease WHERE resource='$RESOURCE' AND status='registered' AND mode='ride';" 2>/dev/null || true)
      fi
      return 1
      ;;
    failed)
      wlog "✗ [ci-gate] tip ${tip:0:12} 必需 CI 终态失败 ($detail)，拒绝启动注定失败的 deploy（等待修复推送新 tip）"
      return 1
      ;;
    *)
      wlog "⚠ [ci-gate] tip ${tip:0:12} CI 状态未知 (${st:-empty}: $detail)，暂缓发车并保持 ride=registered"
      return 1
      ;;
  esac
}

# B5 安全 FF CAS（planned 阶段启动 deploy-v5-selfhost.sh 前）：
# - 严禁在远端 tip 已经推进到 C4 时反选旧绿 C3（因为 prepare 要求目标严格等于远端当前 tip）；
# - 仅当远端最新实际 tip 本身是 cur_tip 的快进后代且 CI 三态严格为 success 时，才快进到 latest_tip；
# - 在 UPDATE train ... WHERE id=... AND status='planned' AND target_sha=... 后硬校验 SQLite changes() == 1，
#   CAS 失败原子回滚、绝不写假事件、绝不修改内存 tip 变量！
worker_planned_fast_forward_green_tip() { # <train_id> <tip_var_name>
  local train_id="$1" tip_var="$2" cur_tip="" latest_tip="" ev_doc=""
  local ci_out="" ci_st="" ci_detail="" head="" now="" rid rsha covered_count=0
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

  # 仅评估远端最新实际 tip，绝不回溯挑选已非 tip 的旧绿提交 C3！
  ci_out="$(worker_sha_ci_status "$latest_tip")"
  IFS=$'\t' read -r ci_st ci_detail <<<"$ci_out"
  if [[ "$ci_st" != "success" ]]; then
    wlog "train $train_id planned 检测到远端新 tip ${latest_tip:0:12} CI=${ci_st} (${ci_detail})，禁止反选非 tip 旧绿提交，保持原 target ${cur_tip:0:12}"
    return 0
  fi

  # 在持 deploy.lock(fd 8) 内将发版工作树快进到最新绿灯 tip
  head="$(git -C "$LEASE_REPO_ROOT" rev-parse HEAD 2>/dev/null || true)"
  if [[ "$head" != "$latest_tip" ]]; then
    if ! canonical_fast_forward "$head" "$latest_tip"; then
      wlog "train $train_id planned 快进工作树到 ${latest_tip:0:12} 失败，保持原 target ${cur_tip:0:12}"
      return 0
    fi
  fi

  # 统计期间所有被 latest_tip 覆盖的祖先 ride leases
  while IFS='|' read -r rid rsha; do
    [[ -n "$rid" && "$rsha" =~ ^[0-9a-f]{40}$ ]] || continue
    if lease_sha_contained "$rsha" "$latest_tip"; then
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
  ev_patch="$(jq -cn --arg from "$cur_tip" --arg to "$latest_tip" --arg at "$now" --argjson rides "$ids_json" \
    '{plannedFastForward:{from:$from,to:$to,at:$at,coveredLeaseIds:$rides}}')" || return 0
  ev_merge="$(lease_json_object_merge_sql evidence_json "$ev_patch")" || return 0

  # 硬 CAS 校验：UPDATE train 必须严格命中 1 行 (changes() == 1)，否则事务回滚、不写事件、不改内存 tip_var！
  if lease_tx <<SQL
.bail on
CREATE TEMP TABLE IF NOT EXISTS _ff_cas_guard(ok INTEGER NOT NULL CHECK(ok = 1));
DELETE FROM _ff_cas_guard;
BEGIN IMMEDIATE;
UPDATE train
   SET target_sha='$(lease_q "$latest_tip")',
       evidence_json=$ev_merge,
       updated_at='$now'
 WHERE id='$(lease_q "$train_id")' AND status='planned' AND target_sha='$(lease_q "$cur_tip")';
INSERT INTO _ff_cas_guard(ok) VALUES(changes());
$(lease_event_sql "$train_id" train-fast-forward "$ACTOR" "from=$cur_tip to=$latest_tip covered_rides=$covered_count")
COMMIT;
SQL
  then
    printf -v "$tip_var" '%s' "$latest_tip"
    wlog "train $train_id planned 自动快进: ${cur_tip:0:12} → ${latest_tip:0:12} (远端最新 tip CI 绿灯, CAS=1, 合并覆盖祖先 rides=$covered_count)"
  else
    wlog "train $train_id planned 快进 CAS 失败(changes()!=1 或写库失败)，回滚并保持内存 target ${cur_tip:0:12}"
  fi
  return 0
}
