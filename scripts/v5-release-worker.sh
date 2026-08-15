#!/usr/bin/env bash
# v5-release-worker.sh — 把一次官方发布从 agent 主 turn 里剥到后台。
#
# 本脚本不是 production-mutation owner,也不替代 deploy-v5.sh。
# 它只做三件事:
#   1. 持久化发布任务状态机(进程重启不丢);
#   2. 复用 v5-release-queue.sh acquire --daemon + v5-deploy-detached.sh;
#   3. 打印一张可被网页 Bash 工具卡识别的进度快照,失败时留下唤回信封。
#
# agent 正确用法: start 成功后立刻结束当前 turn。不要调用 __supervise,
# 不要 while true,不要 gh --watch。后续用 status / list --recall 查询。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELF="$SCRIPT_DIR/$(basename "${BASH_SOURCE[0]}")"
QUEUE_BIN="${OC_V5_RELEASE_QUEUE_BIN:-$SCRIPT_DIR/v5-release-queue.sh}"
DETACHED_BIN="${OC_V5_DEPLOY_DETACHED_BIN:-$SCRIPT_DIR/v5-deploy-detached.sh}"
JOB_DIR="${OC_V5_RELEASE_JOB_DIR:-/var/lib/openclaude-v5/release-jobs}"
RUN_DIR="${OC_V5_RELEASE_WORKER_RUN_DIR:-/var/run/openclaude-v5/release-worker}"
POLL_SECONDS="${OC_V5_RELEASE_POLL_SECONDS:-2}"
STARTUP_POLLS="${OC_V5_RELEASE_STARTUP_POLLS:-15}"
CARD_MARKER="OC_RELEASE_JOB_V1"

die() { echo "✗ $*" >&2; exit 2; }

need_tool() {
  command -v "$1" >/dev/null 2>&1 || die "缺少必需命令:$1"
}

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

valid_job_id() {
  [[ "$1" =~ ^rel-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$ ]]
}

valid_queue_id() {
  [[ "$1" =~ ^rq-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$ ]]
}

valid_label() {
  [[ -n "$1" && ${#1} -le 200 && "$1" =~ ^[A-Za-z0-9._/@:+-]+$ ]]
}

valid_phase() {
  case "$1" in
    queued|acquiring_lease|deploying|smoking|completed|failed|rolled_back) return 0 ;;
    *) return 1 ;;
  esac
}

is_terminal() {
  case "$1" in
    completed|failed|rolled_back) return 0 ;;
    *) return 1 ;;
  esac
}

# 合法后继。与 packages/gateway/src/releaseJobStore.ts 必须保持一致。
legal_transition() {
  local from="$1" to="$2"
  case "$from:$to" in
    queued:acquiring_lease|queued:failed) return 0 ;;
    acquiring_lease:deploying|acquiring_lease:failed) return 0 ;;
    deploying:smoking|deploying:completed|deploying:failed|deploying:rolled_back) return 0 ;;
    smoking:completed|smoking:failed|smoking:rolled_back) return 0 ;;
    *) return 1 ;;
  esac
}

new_job_id() {
  local stamp
  stamp="$(python3 -c 'from datetime import datetime, timezone; print(datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))')"
  [[ "$stamp" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || die "无法生成 UTC 任务时间戳"
  printf 'rel-%s-%s\n' "$stamp" "$(openssl rand -hex 6)"
}

job_file() { printf '%s/%s.json\n' "$JOB_DIR" "$1"; }
job_lock() { printf '%s/%s.lock\n' "$JOB_DIR" "$1"; }
job_log() { printf '%s/%s.log\n' "$RUN_DIR" "$1"; }
recall_file() { printf '%s/%s.recall.json\n' "$JOB_DIR" "$1"; }

with_job_lock() {
  local id="$1"
  shift
  mkdir -p "$JOB_DIR"
  exec 9>"$(job_lock "$id")"
  flock 9
  "$@"
}

read_job() {
  local file
  file="$(job_file "$1")"
  [[ -f "$file" ]] || die "找不到发布任务:$1"
  cat "$file"
}

write_job_json() {
  local id="$1" json="$2" tmp
  mkdir -p "$JOB_DIR"
  tmp="$(job_file "$id").tmp.$$"
  printf '%s\n' "$json" >"$tmp"
  mv -f "$tmp" "$(job_file "$id")"
}

append_entry() {
  local json="$1" phase="$2" text="$3"
  jq --arg at "$(now_iso)" --arg phase "$phase" --arg text "$text" \
    '.entries += [{at:$at, phase:$phase, text:$text}] | .updatedAt = $at' \
    <<<"$json"
}

project_card() {
  jq '
    .card = {
      kind: "release_progress",
      runId: .id,
      goal: .title,
      entries: [.entries[] | {phase, text}],
      summary: (if .phase == "completed" or .phase == "rolled_back" then (.title // .phase) else null end),
      error: (if .phase == "failed" then .error else null end),
      startTime: .createdAt,
      completedAt: .finishedAt,
      _completed: (.phase == "completed" or .phase == "failed" or .phase == "rolled_back"),
      _isError: (.phase == "failed"),
      phase: .phase,
      nextStep: .nextStep
    }
  '
}

transition_locked() {
  local id="$1" to="$2" text="${3:-}" error="${4:-}" next="${5:-}"
  local file json from
  file="$(job_file "$id")"
  [[ -f "$file" ]] || die "找不到发布任务:$id"
  json="$(cat "$file")"
  from="$(jq -r '.phase' <<<"$json")"
  valid_phase "$to" || die "非法阶段:$to"
  if [[ "$from" == "$to" ]]; then
    printf '%s\n' "$json"
    return 0
  fi
  legal_transition "$from" "$to" || die "非法状态转移:$from → $to"
  json="$(jq --arg phase "$to" --arg at "$(now_iso)" \
    --arg error "$error" --arg next "$next" \
    '
      .phase = $phase
      | .updatedAt = $at
      | if $error != "" then .error = $error else . end
      | if $next != "" then .nextStep = $next else . end
      | if ($phase == "completed" or $phase == "failed" or $phase == "rolled_back") then
          .finishedAt = $at
          | if $phase == "failed" then .recallRequired = true else . end
        else . end
    ' <<<"$json")"
  if [[ -n "$text" ]]; then
    json="$(append_entry "$json" "$to" "$text")"
  fi
  json="$(project_card <<<"$json")"
  write_job_json "$id" "$json"
  if [[ "$to" == "failed" ]]; then
    write_recall "$id" "$json"
  fi
  printf '%s\n' "$json"
}

write_recall() {
  local id="$1" json="$2" prompt
  prompt="$(jq -r '
    "发布任务 \(.id) 已失败。\n" +
    "阶段: \(.phase)\n" +
    "原因: \(.error // "未知")\n" +
    "下一步: \(.nextStep // "先 status --json,不要重跑 deploy-v5.sh")\n" +
    "queueId: \(.queueId // "")\n" +
    "deployUnit: \(.deployUnit // "")\n" +
    "请读取 scripts/v5-release-worker.sh status --id \(.id) --json;" +
    "复用官方 queue/lease/deploy-v5.sh --abort|--rollback,不要另开旁路。"
  ' <<<"$json")"
  jq -n --arg id "$id" --arg prompt "$prompt" --arg at "$(now_iso)" \
    --argjson job "$json" \
    '{
      kind: "release_recall",
      id: $id,
      createdAt: $at,
      deliver: "webchat",
      reminderKind: "task",
      prompt: $prompt,
      job: $job
    }' >"$(recall_file "$id")"
  if [[ -n "${OC_V5_RELEASE_RECALL_CMD:-}" ]]; then
    env OC_V5_RELEASE_JOB_ID="$id" \
      OC_V5_RELEASE_RECALL_FILE="$(recall_file "$id")" \
      bash -c "$OC_V5_RELEASE_RECALL_CMD" \
      >/dev/null 2>&1 || echo "! recall hook 失败(任务已标记 failed,信封在 $(recall_file "$id"))" >&2
  fi
}

print_card() {
  local json="$1"
  printf '%s\n' "$CARD_MARKER"
  jq '.' <<<"$json"
}

detect_smoke_in_text() {
  grep -Eiq 'smoke|冒烟|healthz|browser journey|version handshake' <<<"$1"
}

detect_rollback_in_text() {
  grep -Eiq 'rolled back|rollback complete|已回滚' <<<"$1"
}

assert_official_deploy_args() {
  [[ $# -gt 0 ]] || die "start 必须在 -- 后给出 deploy-v5.sh 参数"
  local a
  for a in "$@"; do
    case "$a" in
      --skip-queue|--force|--allow-unverified-ci|--hot-config)
        die "拒绝绕过安全约束的参数:$a"
        ;;
    esac
  done
}

find_open_job() {
  local f phase
  [[ -d "$JOB_DIR" ]] || return 1
  for f in "$JOB_DIR"/rel-*.json; do
    [[ -f "$f" ]] || continue
    phase="$(jq -r '.phase' "$f" 2>/dev/null || true)"
    if [[ -n "$phase" ]] && ! is_terminal "$phase"; then
      jq -r '.id' "$f"
      return 0
    fi
  done
  return 1
}

create_job() {
  local id="$1" owner="$2" queue_id="$3" title="$4" then_smoke="$5"
  shift 5
  local created args_json
  created="$(now_iso)"
  args_json="$(printf '%s\n' "$@" | jq -R . | jq -s .)"
  local then_json
  if [[ "$then_smoke" == 1 ]]; then then_json=true; else then_json=false; fi
  jq -n \
    --arg id "$id" --arg owner "$owner" --arg queueId "$queue_id" \
    --arg title "$title" --arg created "$created" \
    --argjson deployArgs "$args_json" --argjson thenSmoke "$then_json" \
    '{
      version: 1,
      id: $id,
      phase: "queued",
      createdAt: $created,
      updatedAt: $created,
      startedAt: $created,
      finishedAt: null,
      owner: $owner,
      queueId: $queueId,
      title: $title,
      deployArgs: $deployArgs,
      thenSmoke: $thenSmoke,
      deployUnit: null,
      smokeUnit: null,
      supervisorPid: null,
      exitCode: null,
      error: null,
      nextStep: null,
      recallRequired: false,
      entries: [{at:$created, phase:"queued", text:"发布任务已登记,等待转入后台"}]
    }' | project_card
}

start_supervisor() {
  local id="$1"
  mkdir -p "$RUN_DIR"
  if [[ "${OC_V5_RELEASE_SUPERVISE:-1}" == "0" ]]; then
    echo "· supervisor 跳过(OC_V5_RELEASE_SUPERVISE=0) id=$id" >&2
    return 0
  fi
  local log pid
  log="$(job_log "$id")"
  setsid nohup env \
    OC_V5_RELEASE_JOB_DIR="$JOB_DIR" \
    OC_V5_RELEASE_WORKER_RUN_DIR="$RUN_DIR" \
    OC_V5_RELEASE_QUEUE_BIN="$QUEUE_BIN" \
    OC_V5_DEPLOY_DETACHED_BIN="$DETACHED_BIN" \
    OC_V5_RELEASE_POLL_SECONDS="$POLL_SECONDS" \
    OC_V5_RELEASE_STARTUP_POLLS="$STARTUP_POLLS" \
    ${OC_V5_RELEASE_RECALL_CMD:+OC_V5_RELEASE_RECALL_CMD="$OC_V5_RELEASE_RECALL_CMD"} \
    "$SELF" __supervise --id "$id" \
    </dev/null >>"$log" 2>&1 &
  pid=$!
  local json
  json="$(read_job "$id")"
  json="$(jq --argjson pid "$pid" '.supervisorPid = $pid' <<<"$json")"
  write_job_json "$id" "$json"
  echo "✓ supervisor 已启动 id=$id pid=$pid log=$log" >&2
}

unit_show() {
  local unit="$1"
  "$DETACHED_BIN" status "$unit" 2>/dev/null || true
}

parse_unit_state() {
  local active="unknown" sub="unknown" code=""
  while IFS= read -r line; do
    case "$line" in
      ActiveState=*) active="${line#ActiveState=}" ;;
      SubState=*) sub="${line#SubState=}" ;;
      ExecMainStatus=*) code="${line#ExecMainStatus=}" ;;
    esac
  done
  printf '%s %s %s\n' "$active" "$sub" "$code"
}

fail_job() {
  local id="$1" reason="$2" next="$3"
  with_job_lock "$id" transition_locked "$id" failed "$reason" "$reason" "$next" >/dev/null
}

cmd_start() {
  need_tool jq
  need_tool openssl
  need_tool flock
  local owner="" queue_id="" title="" then_smoke=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --owner) owner="${2:-}"; shift 2 ;;
      --queue-id) queue_id="${2:-}"; shift 2 ;;
      --title) title="${2:-}"; shift 2 ;;
      --then-smoke) then_smoke=1; shift ;;
      --) shift; break ;;
      --skip-queue) die "拒绝绕过安全约束的参数:--skip-queue" ;;
      *) die "start 未知参数:$1(官方 deploy 参数写在 -- 后面)" ;;
    esac
  done
  valid_label "$owner" || die "非法 owner:$owner"
  valid_queue_id "$queue_id" || die "必须提供已存在的 --queue-id(复用 release queue,不另开旁路)"
  assert_official_deploy_args "$@"
  [[ -x "$QUEUE_BIN" ]] || die "找不到 release queue:$QUEUE_BIN"
  [[ -x "$DETACHED_BIN" ]] || die "找不到 detached deploy:$DETACHED_BIN"

  local open
  open="$(find_open_job || true)"
  [[ -z "$open" ]] || die "已有未完成发布任务:$open;先 status / 等它结束,不要并行再开一条"

  local id json
  id="$(new_job_id)"
  title="${title:-发布 $queue_id}"
  json="$(create_job "$id" "$owner" "$queue_id" "$title" "$then_smoke" "$@")"
  write_job_json "$id" "$json"

  json="$(with_job_lock "$id" transition_locked "$id" acquiring_lease \
    "正在 acquire --daemon queue=$queue_id" "" \
    "若返回 75:查 v5-release-queue.sh status;陈旧 active 用官方 abandon-active")"

  local acquire_out acquire_rc=0
  set +e
  acquire_out="$("$QUEUE_BIN" acquire --id "$queue_id" --owner "$owner" --daemon 2>&1)"
  acquire_rc=$?
  set -e
  if [[ "$acquire_rc" -ne 0 ]]; then
    local next="查 scripts/v5-release-queue.sh status;若是陈旧幽灵 active,用官方 abandon-active,不要新建并行队列。"
    [[ "$acquire_rc" == 75 ]] && next="acquire 返回 75:挡住的是别人的 active 或陈旧幽灵。只读 status,按提示 abandon-active,禁止空转。"
    fail_job "$id" "acquire 失败(exit $acquire_rc): $acquire_out" "$next"
    print_card "$(read_job "$id")"
    exit "$acquire_rc"
  fi

  export OC_V5_RELEASE_QUEUE_ID="$queue_id"
  local captured detached_rc=0 unit
  set +e
  captured="$("$DETACHED_BIN" start -- "$@" 2>&1)"
  detached_rc=$?
  set -e
  unit="$(printf '%s\n' "$captured" | awk '/^openclaude-v5-deploy-[a-z0-9-]+\.service$/{print; exit}')"
  if [[ "$detached_rc" -ne 0 || -z "$unit" ]]; then
    fail_job "$id" "detached start 失败(exit $detached_rc): $captured" \
      "不要改 slot/symlink。先只读 deploy_state 与 v5-deploy-detached.sh 报错,按官方路径处理。"
    print_card "$(read_job "$id")"
    exit "${detached_rc:-2}"
  fi

  json="$(read_job "$id")"
  json="$(jq --arg unit "$unit" '.deployUnit = $unit' <<<"$json")"
  write_job_json "$id" "$json"
  with_job_lock "$id" transition_locked "$id" deploying \
    "已交给 $unit,agent 可结束当前 turn" "" \
    "用 status --id $id 查询;不要前台 wait / gh --watch" >/dev/null

  start_supervisor "$id"
  print_card "$(read_job "$id")"
  echo "✓ 发布已转入后台 job=$id unit=$unit queue=$queue_id(结束当前 turn,不要前台等待)" >&2
}

cmd_status() {
  need_tool jq
  local id="" json_only=0 recall=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --id) id="${2:-}"; shift 2 ;;
      --json) json_only=1; shift ;;
      --recall) recall=1; shift ;;
      *) die "status 未知参数:$1" ;;
    esac
  done
  if [[ -z "$id" ]]; then
    if [[ "$recall" == 1 ]]; then
      cmd_list --recall
    else
      cmd_list
    fi
    return 0
  fi
  valid_job_id "$id" || die "非法 job id:$id"
  local json
  json="$(read_job "$id")"
  if [[ "$json_only" == 1 ]]; then
    jq '.' <<<"$json"
  else
    print_card "$json"
  fi
}

cmd_list() {
  need_tool jq
  local recall=0 phase_filter="" f
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --recall) recall=1; shift ;;
      --phase) phase_filter="${2:-}"; shift 2 ;;
      *) die "list 未知参数:$1" ;;
    esac
  done
  mkdir -p "$JOB_DIR"
  local rows="[]"
  for f in "$JOB_DIR"/rel-*.json; do
    [[ -f "$f" ]] || continue
    rows="$(jq --argjson acc "$rows" --argjson job "$(cat "$f")" \
      --arg recall "$recall" --arg phase "$phase_filter" '
        (if $phase == "" then true else $job.phase == $phase end)
        and (if $recall == "1" then $job.phase == "failed" else true end)
        | if . then $acc + [$job] else $acc end
      ' <<<true)"
  done
  jq 'sort_by(.updatedAt) | reverse' <<<"$rows"
}

cmd_failed() {
  cmd_list --recall
}

maybe_start_smoke() {
  local id="$1"
  local json captured rc=0 unit
  json="$(read_job "$id")"
  [[ "$(jq -r '.thenSmoke' <<<"$json")" == "true" ]] || return 1
  set +e
  captured="$("$DETACHED_BIN" start -- --smoke 2>&1)"
  rc=$?
  set -e
  unit="$(printf '%s\n' "$captured" | awk '/^openclaude-v5-deploy-[a-z0-9-]+\.service$/{print; exit}')"
  if [[ "$rc" -ne 0 || -z "$unit" ]]; then
    fail_job "$id" "smoke detached start 失败: $captured" \
      "部署可能已完成。先只读 active release 与 --smoke 报错,不要叠另一次 --with-dist。"
    return 0
  fi
  json="$(jq --arg unit "$unit" '.smokeUnit = $unit' <<<"$json")"
  write_job_json "$id" "$json"
  with_job_lock "$id" transition_locked "$id" smoking \
    "部署成功,已拉起官方 --smoke unit=$unit" "" "" >/dev/null
  return 0
}

cmd_supervise() {
  need_tool jq
  local id=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --id) id="${2:-}"; shift 2 ;;
      *) die "__supervise 未知参数:$1" ;;
    esac
  done
  valid_job_id "$id" || die "非法 job id:$id"
  [[ "$POLL_SECONDS" =~ ^[1-9][0-9]*$ ]] || die "POLL_SECONDS 必须是正整数"
  (( POLL_SECONDS < 60 )) || die "POLL_SECONDS 必须 < 60(后台守护也禁止长 sleep)"

  local json phase unit polls=0 watching="deploy"
  json="$(read_job "$id")"
  phase="$(jq -r '.phase' <<<"$json")"
  is_terminal "$phase" && return 0

  while :; do
    json="$(read_job "$id")"
    phase="$(jq -r '.phase' <<<"$json")"
    is_terminal "$phase" && return 0

    if [[ "$watching" == "deploy" ]]; then
      unit="$(jq -r '.deployUnit // empty' <<<"$json")"
    else
      unit="$(jq -r '.smokeUnit // empty' <<<"$json")"
    fi

    if [[ -z "$unit" ]]; then
      polls=$((polls + 1))
      if (( polls >= STARTUP_POLLS )); then
        fail_job "$id" "supervisor 等不到 deploy unit" \
          "查 start 日志与 v5-deploy-detached.sh status;不要空转。"
        return 1
      fi
      sleep "$POLL_SECONDS"
      continue
    fi

    local blob parsed active rest sub code
    blob="$(unit_show "$unit")"
    parsed="$(parse_unit_state <<<"$blob")"
    active="${parsed%% *}"
    rest="${parsed#* }"
    sub="${rest%% *}"
    code="${rest#* }"

    if [[ "$active" == "active" && "$sub" == "running" ]]; then
      if [[ "$watching" == "deploy" ]] && detect_smoke_in_text "$blob"; then
        with_job_lock "$id" transition_locked "$id" smoking \
          "journal 出现冒烟迹象" "" "" >/dev/null || true
      fi
      sleep "$POLL_SECONDS"
      continue
    fi

    if [[ "$active" == "activating" || "$active" == "reloading" || "$active" == "deactivating" ]]; then
      sleep "$POLL_SECONDS"
      continue
    fi

    if [[ "$active" == "failed" || ( -n "$code" && "$code" != "0" && ( "$active" == "inactive" || "$sub" == "exited" ) ) ]]; then
      json="$(jq --argjson code "${code:-1}" '.exitCode = $code' <<<"$json")"
      write_job_json "$id" "$json"
      fail_job "$id" "官方脚本退出码 ${code:-failed}(unit=$unit)" \
        "不要重跑。先只读 deploy_state / queue status / $unit journal,再走官方 --abort/--rollback。"
      return 0
    fi

    if [[ "$active" == "inactive" || "$sub" == "exited" ]]; then
      if [[ "$watching" == "deploy" && "$(jq -r '.thenSmoke' <<<"$json")" == "true" ]]; then
        maybe_start_smoke "$id" || true
        json="$(read_job "$id")"
        if [[ "$(jq -r '.phase' <<<"$json")" == "smoking" ]]; then
          watching="smoke"
          polls=0
          continue
        fi
        return 0
      fi
      local rb=0
      if jq -e '.deployArgs[] | select(. == "--rollback")' <<<"$json" >/dev/null 2>&1; then
        rb=1
      fi
      if [[ "$rb" == 1 ]] || detect_rollback_in_text "$blob"; then
        json="$(jq '.exitCode = 0' <<<"$json")"
        write_job_json "$id" "$json"
        with_job_lock "$id" transition_locked "$id" rolled_back \
          "官方回滚完成 unit=$unit" "" "核验 deploy_state.phase=stable 与 active_slot。" >/dev/null
        return 0
      fi
      json="$(jq '.exitCode = 0' <<<"$json")"
      write_job_json "$id" "$json"
      with_job_lock "$id" transition_locked "$id" completed \
        "官方发布完成 unit=$unit" "" "再跑 scripts/v5-release-queue.sh finish。" >/dev/null
      return 0
    fi

    sleep "$POLL_SECONDS"
  done
}

cmd_transition() {
  local id="" to="" text=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --id) id="${2:-}"; shift 2 ;;
      --to) to="${2:-}"; shift 2 ;;
      --text) text="${2:-}"; shift 2 ;;
      *) die "__transition 未知参数:$1" ;;
    esac
  done
  valid_job_id "$id" || die "非法 job id:$id"
  with_job_lock "$id" transition_locked "$id" "$to" "$text"
}

usage() {
  cat <<'EOF'
Usage:
  scripts/v5-release-worker.sh start --owner O --queue-id RQ [--title T] [--then-smoke] -- [deploy-v5.sh args]
  scripts/v5-release-worker.sh status [--id ID] [--json]
  scripts/v5-release-worker.sh list [--phase P] [--recall]
  scripts/v5-release-worker.sh failed

start 会:登记任务 → acquire --daemon → v5-deploy-detached.sh start → 拉起 supervisor。
成功后立刻把 OC_RELEASE_JOB_V1 JSON 打到 stdout,agent 应结束当前 turn。

禁止:
  前台 wait / while true / gh --watch / sleep>=60
  --skip-queue / --allow-unverified-ci / 绕过 deploy-v5.sh
  新开一条不受 queue/lease 约束的发布路径

失败唤回:
  任务进入 failed 时写入 $JOB_DIR/<id>.recall.json
  (kind=release_recall, reminderKind=task, deliver=webchat)。
  设置 OC_V5_RELEASE_RECALL_CMD 可把信封交给现有 create_reminder 钩子。
  agent 用 list --recall / failed 找回,不要自己轮询。
EOF
}

need_tool jq

command_name="${1:-}"
[[ -n "$command_name" ]] || { usage >&2; exit 2; }
shift

case "$command_name" in
  start) cmd_start "$@" ;;
  status) cmd_status "$@" ;;
  list) cmd_list "$@" ;;
  failed) cmd_failed "$@" ;;
  __supervise) cmd_supervise "$@" ;;
  __transition) cmd_transition "$@" ;;
  --help|-h) usage ;;
  *) usage >&2; exit 2 ;;
esac
