#!/usr/bin/env bash
# with-production-mutation-lease.sh — 人工运维包装器(RFC-v5-selfheal-batch1b §1.2 MAJOR4)。
#
# 非 deploy-v5.sh 的生产变更(人工 migration apply / env 同步 / systemd 单元安装或改动 /
# runtime image build+tag 切换等)也必须与自愈 host-action + deploy 互斥。本包装器用独立
# supervisor session 同时持远端 flock、运行前台命令并监督二者；任一 lease/父进程失活，
# 整个命令进程组立即 TERM→KILL，禁止脱离 lease 继续 mutation。
#
# 用法:
#   scripts/with-production-mutation-lease.sh <cmd> [args...]
# 例:
#   scripts/with-production-mutation-lease.sh psql "$DATABASE_URL" -f migrations/0160_x.sql
#   scripts/with-production-mutation-lease.sh ssh kl-mirror 'systemctl daemon-reload'
#
# 锁与 deploy-v5.sh 的远端 lease 是同一路径(PRODUCTION_MUTATION_LOCK)。紧急旁路:
# OC_V5_SKIP_MUTATION_LEASE=1(loud warning)。只支持前台命令；主动 daemonize / setsid 的
# 子进程不属于本包装器契约。
set -euo pipefail

KL_HOST="${KL_HOST:-kl-mirror}"
PRODUCTION_MUTATION_LOCK="/run/openclaude-v5/production-mutation.lock"
MUTATION_LEASE_TTL_SECONDS="${OC_V5_MUTATION_LEASE_TTL_SECONDS:-7200}"
[[ "$MUTATION_LEASE_TTL_SECONDS" =~ ^[1-9][0-9]*$ ]] || MUTATION_LEASE_TTL_SECONDS=7200
(( MUTATION_LEASE_TTL_SECONDS >= 2 )) || MUTATION_LEASE_TTL_SECONDS=7200
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

process_state_start() { # <pid> -> "state starttime"
  local raw rest
  raw="$(cat "/proc/$1/stat" 2>/dev/null)" || return 1
  rest="${raw##*) }"
  set -- $rest
  [[ $# -ge 20 ]] || return 1
  printf '%s %s\n' "$1" "${20}"
}

process_start_time() { # <pid>
  local state start
  read -r state start < <(process_state_start "$1") || return 1
  printf '%s\n' "$start"
}

same_live_process() { # <pid> <starttime>
  local state start
  read -r state start < <(process_state_start "$1") || return 1
  [[ "$state" != Z && "$state" != X && "$state" != x && "$start" == "$2" ]]
}

same_supervised_process() { # stopped supervision is equivalent to lost supervision
  local state start
  read -r state start < <(process_state_start "$1") || return 1
  case "$state" in Z|X|x|T|t) return 1 ;; esac
  [[ "$start" == "$2" ]]
}

terminate_process_group() { # <pgid>; idempotent, bounded TERM -> KILL
  local pgid="$1" i
  [[ "$pgid" =~ ^[0-9]+$ && "$pgid" -gt 1 ]] || return 0
  kill -TERM -- "-$pgid" 2>/dev/null || true
  for i in $(seq 1 20); do
    kill -0 -- "-$pgid" 2>/dev/null || return 0
    sleep 0.1
  done
  kill -KILL -- "-$pgid" 2>/dev/null || true
}

terminate_exact_process() { # <pid> <starttime>; never signal a reused pid
  local pid="$1" start="$2" i
  same_live_process "$pid" "$start" || return 0
  kill -TERM "$pid" 2>/dev/null || true
  for i in $(seq 1 20); do
    same_live_process "$pid" "$start" || return 0
    sleep 0.1
  done
  same_live_process "$pid" "$start" && kill -KILL "$pid" 2>/dev/null || true
}

hard_kill_exact_process() { # supervision already lost: no TERM grace
  same_live_process "$1" "$2" && kill -KILL "$1" 2>/dev/null || true
}

manual_watchdog_main() { # ready outer{pid,start} supervisor{pid,start} lease{pid,start} ttl{pid,start} command{pid,start,pgid}
  local ready="$1" outer_pid="$2" outer_start="$3" supervisor_pid="$4" supervisor_start="$5"
  local lease_pid="$6" lease_start="$7" ttl_pid="$8" ttl_start="$9"
  local command_pid="${10}" command_start="${11}" command_pgid="${12}" state seen_start
  for value in "$outer_pid" "$outer_start" "$supervisor_pid" "$supervisor_start" \
      "$lease_pid" "$lease_start" "$ttl_pid" "$ttl_start" "$command_pid" "$command_start" "$command_pgid"; do
    [[ "$value" =~ ^[1-9][0-9]*$ ]] || { echo "✗ manual watchdog identity invalid" >&2; return 2; }
  done
  [[ "$command_pgid" == "$command_pid" ]] || return 2
  trap 'exit 0' INT TERM HUP
  # spawn→ready 窗同样必须受保护：若此刻任一 supervisor identity 已
  # STOP/dead，不直接 return，而是落到与运行期相同的 crash-stop 顺序。
  if same_supervised_process "$outer_pid" "$outer_start" \
      && same_supervised_process "$supervisor_pid" "$supervisor_start" \
      && same_supervised_process "$lease_pid" "$lease_start" \
      && same_supervised_process "$ttl_pid" "$ttl_start" \
      && same_live_process "$command_pid" "$command_start"; then
    : >"$ready"
    while same_supervised_process "$outer_pid" "$outer_start" \
        && same_supervised_process "$supervisor_pid" "$supervisor_start" \
        && same_supervised_process "$lease_pid" "$lease_start" \
        && same_supervised_process "$ttl_pid" "$ttl_start"; do
      if read -r state seen_start < <(process_state_start "$command_pid") \
          && [[ "$seen_start" == "$command_start" && ( "$state" == T || "$state" == t ) ]]; then
        break
      fi
      # command 的正常 gone/Z 由 supervisor wait-n 裁决；watchdog 不与正常收尾抢跑。
      sleep 0.02
    done
  fi
  # 任一监督身份失活/STOP：先在 exact command leader 仍锚定 PGID 时 KILL
  # mutation，再断 holder/TTL，最后仅对 exact supervisor group 发 KILL。
  if same_live_process "$command_pid" "$command_start"; then
    kill -KILL -- "-$command_pgid" 2>/dev/null || true
  fi
  hard_kill_exact_process "$lease_pid" "$lease_start"
  hard_kill_exact_process "$ttl_pid" "$ttl_start"
  if same_live_process "$supervisor_pid" "$supervisor_start" \
      && [[ "$(ps -o pgid= -p "$supervisor_pid" 2>/dev/null | tr -d '[:space:]')" == "$supervisor_pid" ]]; then
    kill -KILL -- "-$supervisor_pid" 2>/dev/null || true
  fi
  return 86
}

supervisor_main() { # <outer-pid> <outer-starttime> <cmd> [args...]
  local outer_pid="$1" outer_start="$2" supervisor_pid="$$" supervisor_start
  shift 2
  [[ "$outer_pid" =~ ^[0-9]+$ && "$outer_pid" -gt 1 && "$outer_start" =~ ^[0-9]+$ ]] \
    || { echo "✗ manual lease supervisor parent identity invalid" >&2; return 2; }
  [[ $# -ge 1 ]] || { echo "✗ manual lease supervisor missing command" >&2; return 2; }
  supervisor_start="$(process_start_time "$supervisor_pid")" \
    || { echo "✗ manual lease supervisor identity unavailable" >&2; return 3; }
  [[ "$(ps -o pgid= -p "$supervisor_pid" 2>/dev/null | tr -d '[:space:]')" == "$supervisor_pid" ]] \
    || { echo "✗ manual lease supervisor 未隔离为独立 PGID" >&2; return 3; }

  # EXIT trap runs after supervisor_main returns, so cleanup state must outlive this
  # function's local scope. The internal supervisor is a dedicated process; globals
  # are invocation-private and cannot collide with an outer wrapper.
  SUP_LEASE_PID=""; SUP_LEASE_START=""; SUP_LEASE_OUT=""
  SUP_PARENT_WATCH_PID=""; SUP_PARENT_WATCH_START=""
  SUP_LOCAL_TTL_PID=""; SUP_LOCAL_TTL_START=""
  SUP_COMMAND_PID=""; SUP_COMMAND_START=""; SUP_COMMAND_PGID=""; SUP_COMMAND_GATE=""; SUP_STATE_DIR=""
  SUP_WATCH_PID=""; SUP_WATCH_START=""; SUP_WATCH_PGID=""; SUP_WATCH_READY=""
  SUP_CLEANUP_STARTED=0

  stop_manual_watchdog() {
    [[ -n "$SUP_WATCH_PID" && -n "$SUP_WATCH_START" ]] || return 0
    terminate_exact_process "$SUP_WATCH_PID" "$SUP_WATCH_START"
    if same_live_process "$SUP_WATCH_PID" "$SUP_WATCH_START"; then
      echo "✗ manual independent watchdog 仍为 KILL-pending；拒绝无界 wait" >&2
      return 1
    fi
    wait "$SUP_WATCH_PID" 2>/dev/null || true
    SUP_WATCH_PID=""; SUP_WATCH_START=""; SUP_WATCH_PGID=""
    return 0
  }

  supervisor_cleanup() {
    local rc=$?
    [[ "$SUP_CLEANUP_STARTED" == 0 ]] || return
    SUP_CLEANUP_STARTED=1
    trap - EXIT INT TERM HUP
    set +e
    if [[ -n "$SUP_COMMAND_PGID" ]] \
        && same_live_process "$SUP_COMMAND_PID" "$SUP_COMMAND_START"; then
      if [[ "$rc" == 86 ]]; then
        # Lease loss is already unsafe: do not grant a TERM grace period after flock
        # may be free. Normal exits retain bounded TERM -> KILL while lease is held.
        kill -KILL -- "-$SUP_COMMAND_PGID" 2>/dev/null || true
      else
        terminate_process_group "$SUP_COMMAND_PGID"
      fi
    fi
    stop_manual_watchdog || rc=86
    if [[ -n "$SUP_COMMAND_PID" ]] \
        && ! same_live_process "$SUP_COMMAND_PID" "$SUP_COMMAND_START"; then
      wait "$SUP_COMMAND_PID" 2>/dev/null || true
    fi
    if [[ -n "$SUP_LEASE_PID" ]]; then
      terminate_exact_process "$SUP_LEASE_PID" "$SUP_LEASE_START"
      if same_live_process "$SUP_LEASE_PID" "$SUP_LEASE_START"; then
        rc=86
      else
        wait "$SUP_LEASE_PID" 2>/dev/null || true
      fi
    fi
    if [[ -n "$SUP_PARENT_WATCH_PID" ]]; then
      terminate_exact_process "$SUP_PARENT_WATCH_PID" "$SUP_PARENT_WATCH_START"
      if same_live_process "$SUP_PARENT_WATCH_PID" "$SUP_PARENT_WATCH_START"; then
        rc=86
      else
        wait "$SUP_PARENT_WATCH_PID" 2>/dev/null || true
      fi
    fi
    if [[ -n "$SUP_LOCAL_TTL_PID" ]]; then
      terminate_exact_process "$SUP_LOCAL_TTL_PID" "$SUP_LOCAL_TTL_START"
      if same_live_process "$SUP_LOCAL_TTL_PID" "$SUP_LOCAL_TTL_START"; then
        rc=86
      else
        wait "$SUP_LOCAL_TTL_PID" 2>/dev/null || true
      fi
    fi
    [[ -n "$SUP_LEASE_OUT" ]] && rm -f -- "$SUP_LEASE_OUT"
    [[ -n "$SUP_STATE_DIR" ]] && rm -rf -- "$SUP_STATE_DIR"
    exit "$rc"
  }
  trap supervisor_cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP

  same_live_process "$outer_pid" "$outer_start" \
    || { echo "✗ manual lease wrapper parent disappeared before supervisor start" >&2; return 137; }

  # 独立 supervisor 是 wrapper 的 SIGKILL watchdog。其 child 只监原 wrapper 的
  # PID+starttime（防 PID reuse）；wrapper 正常时会一直 wait supervisor，不会误触发。
  (
    trap - EXIT INT TERM HUP
    while same_live_process "$outer_pid" "$outer_start"; do sleep 0.1; done
  ) &
  SUP_PARENT_WATCH_PID=$!
  SUP_PARENT_WATCH_START="$(process_start_time "$SUP_PARENT_WATCH_PID")" || {
    kill -KILL "$SUP_PARENT_WATCH_PID" 2>/dev/null || true
    SUP_PARENT_WATCH_PID=""
    echo "✗ 无法记录 manual parent-watch 身份" >&2
    return 3
  }

  SUP_LEASE_OUT="$(mktemp "${TMPDIR:-/tmp}/oc-v5-manual-lease.XXXXXX")"
  SUP_STATE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/oc-v5-manual-state.XXXXXX")"
  SUP_COMMAND_GATE="$SUP_STATE_DIR/command.go"

  # Bound authorization from before transport startup. Starting this only after
  # LEASED would accept a stale, delayed handshake after remote flock had expired.
  # The remote countdown starts no earlier than this point, so this local monotonic
  # deadline is conservatively earlier by ttl_margin (plus acquisition latency).
  local ttl_margin=2 local_ttl
  (( MUTATION_LEASE_TTL_SECONDS > 10 )) && ttl_margin=5
  (( MUTATION_LEASE_TTL_SECONDS > ttl_margin )) || ttl_margin=1
  local_ttl=$(( MUTATION_LEASE_TTL_SECONDS - ttl_margin ))
  (( local_ttl >= 1 )) || local_ttl=1
  sleep "$local_ttl" &
  SUP_LOCAL_TTL_PID=$!
  SUP_LOCAL_TTL_START="$(process_start_time "$SUP_LOCAL_TTL_PID")" || {
    kill -KILL "$SUP_LOCAL_TTL_PID" 2>/dev/null || true
    SUP_LOCAL_TTL_PID=""
    echo "✗ 无法启动 manual lease 本地 TTL watchdog" >&2
    return 3
  }

  # 后台 ssh:远端 shell 自身持 flock。实时 PPid 防 SSH 断链后 orphan；硬 TTL 防本地
  # supervisor/ssh 极端同时失联时永久焊锁。TTL 到点会让本地 lease_pid 退出，随即由
  # wait-n 路径终止仍在运行的命令进程组。
  local remote_holder
  remote_holder="mkdir -p -m 700 '$(dirname "$PRODUCTION_MUTATION_LOCK")' 2>/dev/null || true
exec 9>'$PRODUCTION_MUTATION_LOCK'
trap 'exit 0' HUP INT TERM
lease_parent=\"\$PPID\"
case \"\$lease_parent\" in ''|*[!0-9]*) exit 76 ;; esac
[ \"\$lease_parent\" -gt 1 ] || exit 76
kill -0 \"\$lease_parent\" 2>/dev/null || exit 76
flock -w 60 9 || exit 75
current_parent=\"\$(awk '/^PPid:/{print \$2; exit}' \"/proc/\$\$/status\" 2>/dev/null)\" || exit 76
case \"\$current_parent\" in ''|*[!0-9]*) exit 76 ;; esac
[ \"\$current_parent\" = \"\$lease_parent\" ] || exit 76
kill -0 \"\$lease_parent\" 2>/dev/null || exit 76
lease_start=\"\$(date +%s)\"
lease_ttl=$MUTATION_LEASE_TTL_SECONDS
echo LEASED
while :; do
  current_parent=\"\$(awk '/^PPid:/{print \$2; exit}' \"/proc/\$\$/status\" 2>/dev/null)\" || exit 0
  case \"\$current_parent\" in ''|*[!0-9]*) exit 0 ;; esac
  [ \"\$current_parent\" = \"\$lease_parent\" ] || exit 0
  kill -0 \"\$lease_parent\" 2>/dev/null || exit 0
  now=\"\$(date +%s)\"
  [ \$(( now - lease_start )) -lt \"\$lease_ttl\" ] || exit 0
  sleep 1
done"

  # Keepalive bounds a transport blackhole where the remote holder has exited but the
  # local ssh PID has not observed channel close yet. The independent local TTL below
  # is the stronger fence for the scheduled remote hard-TTL boundary.
  ssh -o ServerAliveInterval=2 -o ServerAliveCountMax=2 \
    "$KL_HOST" "$remote_holder" </dev/null >"$SUP_LEASE_OUT" 2>/dev/null &
  SUP_LEASE_PID=$!
  SUP_LEASE_START="$(process_start_time "$SUP_LEASE_PID")" || {
    kill -KILL "$SUP_LEASE_PID" 2>/dev/null || true
    SUP_LEASE_PID=""
    echo "✗ 无法记录 manual lease ssh 身份" >&2
    return 3
  }

  local got=0 waited=0
  while (( waited < 900 )); do
    same_live_process "$outer_pid" "$outer_start" || return 137
    if ! same_live_process "$SUP_LOCAL_TTL_PID" "$SUP_LOCAL_TTL_START"; then
      echo "✗ production-mutation lease 本地安全 TTL 在取锁期间已到" >&2
      return 86
    fi
    same_live_process "$SUP_LEASE_PID" "$SUP_LEASE_START" || break
    if grep -q LEASED "$SUP_LEASE_OUT" 2>/dev/null; then got=1; break; fi
    sleep 0.1
    waited=$((waited + 1))
  done
  if [[ "$got" != 1 ]]; then
    echo "✗ 未取得 kl-mirror production-mutation lease(远端 flock -w 60 竞争超时 / ssh 失败 / 90s 无 LEASED)。" >&2
    echo "  可能有部署 / 自愈 host-action / 另一人工变更正持锁;稍后重试或核查 $KL_HOST:$PRODUCTION_MUTATION_LOCK。" >&2
    return 3
  fi
  same_live_process "$outer_pid" "$outer_start" || return 137
  same_live_process "$SUP_LEASE_PID" "$SUP_LEASE_START" \
    || { echo "✗ LEASED 回执到达时 ssh 已失活；拒绝运行命令" >&2; return 86; }
  same_live_process "$SUP_LOCAL_TTL_PID" "$SUP_LOCAL_TTL_START" \
    || { echo "✗ LEASED 回执晚于本地安全 TTL；拒绝运行命令" >&2; return 86; }

  # Bash monitor mode 只围绕 spawn 打开，使 child 成为独立 PGID；gate 在验证 PGID 前
  # 阻止命令接触生产。gate 等待自身也核验 wrapper 身份，覆盖父在 spawn→验证微窗 SIGKILL。
  local monitor_was_on=0
  [[ $- == *m* ]] && monitor_was_on=1
  set -m
  (
    trap - EXIT INT TERM HUP
    set +m
    while [[ ! -e "$SUP_COMMAND_GATE" ]]; do
      same_live_process "$outer_pid" "$outer_start" || exit 137
      sleep 0.02
    done
    unset OC_V5_MANUAL_LEASE_INTERNAL
    exec "$@"
  ) &
  SUP_COMMAND_PID=$!
  [[ "$monitor_was_on" == 1 ]] || set +m
  SUP_COMMAND_START="$(process_start_time "$SUP_COMMAND_PID")" || {
    kill -KILL "$SUP_COMMAND_PID" 2>/dev/null || true
    SUP_COMMAND_PID=""
    echo "✗ 无法记录 wrapped command exact identity" >&2
    return 3
  }
  SUP_COMMAND_PGID="$(ps -o pgid= -p "$SUP_COMMAND_PID" 2>/dev/null | tr -d '[:space:]')"
  if [[ "$SUP_COMMAND_PGID" != "$SUP_COMMAND_PID" ]]; then
    echo "✗ wrapped command 未隔离为独立进程组(pid=$SUP_COMMAND_PID pgid=${SUP_COMMAND_PGID:-missing});拒绝执行" >&2
    hard_kill_exact_process "$SUP_COMMAND_PID" "$SUP_COMMAND_START"
    SUP_COMMAND_PGID=""
    return 3
  fi
  if ! same_supervised_process "$outer_pid" "$outer_start"; then
    terminate_process_group "$SUP_COMMAND_PGID"
    return 137
  fi
  if ! same_supervised_process "$SUP_LEASE_PID" "$SUP_LEASE_START" \
      || ! same_supervised_process "$SUP_LOCAL_TTL_PID" "$SUP_LOCAL_TTL_START"; then
    echo "✗ production-mutation lease 在 command gate 开启前失活；拒绝运行命令" >&2
    return 86
  fi

  # 独立 session watchdog 不属于 supervisor PGID。整组 STOP/KILL supervisor 时，
  # 它仍能先 KILL command PGID，再断 holder/TTL；ready 前绝不开放 command gate。
  SUP_WATCH_READY="$SUP_STATE_DIR/watchdog.ready"
  local watch_monitor_was_on=0 watch_isolated=0 i
  if [[ $- == *m* ]]; then watch_monitor_was_on=1; set +m; fi
  OC_V5_MANUAL_LEASE_WATCHDOG=1 setsid "$SELF" \
    "$SUP_WATCH_READY" "$outer_pid" "$outer_start" "$supervisor_pid" "$supervisor_start" \
    "$SUP_LEASE_PID" "$SUP_LEASE_START" "$SUP_LOCAL_TTL_PID" "$SUP_LOCAL_TTL_START" \
    "$SUP_COMMAND_PID" "$SUP_COMMAND_START" "$SUP_COMMAND_PGID" &
  SUP_WATCH_PID=$!
  [[ "$watch_monitor_was_on" == 1 ]] && set -m
  SUP_WATCH_START="$(process_start_time "$SUP_WATCH_PID")" || {
    kill -KILL "$SUP_WATCH_PID" 2>/dev/null || true
    SUP_WATCH_PID=""
    echo "✗ 无法记录 manual independent watchdog identity" >&2
    return 86
  }
  for i in $(seq 1 100); do
    same_live_process "$SUP_WATCH_PID" "$SUP_WATCH_START" || break
    SUP_WATCH_PGID="$(ps -o pgid= -p "$SUP_WATCH_PID" 2>/dev/null | tr -d '[:space:]')"
    if [[ "$SUP_WATCH_PGID" == "$SUP_WATCH_PID" ]]; then watch_isolated=1; break; fi
    sleep 0.01
  done
  [[ "$watch_isolated" == 1 ]] || { echo "✗ manual independent watchdog 未隔离为独立 PGID" >&2; return 86; }
  for i in $(seq 1 100); do
    [[ -e "$SUP_WATCH_READY" ]] && break
    same_live_process "$SUP_WATCH_PID" "$SUP_WATCH_START" || break
    sleep 0.02
  done
  if [[ ! -e "$SUP_WATCH_READY" ]] \
      || ! same_supervised_process "$outer_pid" "$outer_start" \
      || ! same_supervised_process "$SUP_LEASE_PID" "$SUP_LEASE_START" \
      || ! same_supervised_process "$SUP_LOCAL_TTL_PID" "$SUP_LOCAL_TTL_START" \
      || ! same_live_process "$SUP_COMMAND_PID" "$SUP_COMMAND_START"; then
    echo "✗ manual independent watchdog gate 前未就绪；拒绝运行命令" >&2
    return 86
  fi
  : >"$SUP_COMMAND_GATE"
  echo "  ✓ 持有 kl-mirror production-mutation lease(后台 ssh pid=$SUP_LEASE_PID),执行:$*" >&2

  local completed="" event_rc=0
  if wait -n -p completed \
    "$SUP_COMMAND_PID" "$SUP_LEASE_PID" "$SUP_PARENT_WATCH_PID" "$SUP_LOCAL_TTL_PID" "$SUP_WATCH_PID"; then
    event_rc=0
  else
    event_rc=$?
  fi
  if [[ "$completed" == "$SUP_COMMAND_PID" ]]; then
    # wait-n 已回收 exact leader；前台-only 契约下不得再向可能复用的裸 PGID
    # 发信号。主动 daemonize/background 本就不属于本 wrapper 契约。
    SUP_COMMAND_PID=""; SUP_COMMAND_START=""; SUP_COMMAND_PGID=""
    # command/holder 同时终止时 fail-closed：zombie holder 也不算 live。
    if ! same_live_process "$SUP_LEASE_PID" "$SUP_LEASE_START" \
        || ! same_live_process "$SUP_LOCAL_TTL_PID" "$SUP_LOCAL_TTL_START"; then
      echo "✗ production-mutation lease 与 wrapped command 同时失活；按 lease loss 裁决" >&2
      return 86
    fi
    stop_manual_watchdog || return 86
    return "$event_rc"
  fi
  if [[ "$completed" == "$SUP_LEASE_PID" ]]; then
    echo "✗ production-mutation lease holder 已失活；终止 wrapped command 整个进程组" >&2
    return 86
  fi
  if [[ "$completed" == "$SUP_PARENT_WATCH_PID" ]]; then
    echo "✗ manual lease wrapper parent 已失活；watchdog 终止 lease 与命令组" >&2
    return 137
  fi
  if [[ "$completed" == "$SUP_LOCAL_TTL_PID" ]]; then
    echo "✗ production-mutation lease 本地安全 TTL 已到；在远端 TTL 释放前终止命令组" >&2
    return 86
  fi
  if [[ "$completed" == "$SUP_WATCH_PID" ]]; then
    echo "✗ manual independent watchdog 意外先退；fail-closed" >&2
    return 86
  fi
  echo "✗ manual lease supervisor 无法裁决首个退出进程" >&2
  return 86
}

if [[ "${OC_V5_MANUAL_LEASE_WATCHDOG:-0}" == 1 ]]; then
  if manual_watchdog_main "$@"; then exit 0; else rc=$?; exit "$rc"; fi
fi

if [[ "${OC_V5_MANUAL_LEASE_INTERNAL:-0}" == 1 ]]; then
  if supervisor_main "$@"; then exit 0; else rc=$?; exit "$rc"; fi
fi

[[ $# -ge 1 ]] || { echo "用法: with-production-mutation-lease.sh <cmd> [args...]" >&2; exit 2; }
if [[ "${OC_V5_SKIP_MUTATION_LEASE:-0}" == 1 ]]; then
  echo "⚠⚠⚠ WARNING: OC_V5_SKIP_MUTATION_LEASE=1 —— 跳过 kl-mirror PRODUCTION-MUTATION LEASE。" >&2
  echo "⚠⚠⚠ 本次人工变更不与部署/自愈 host-action 互斥。仅限 runbook 明确记载的紧急旁路。" >&2
  exec "$@"
fi
command -v setsid >/dev/null 2>&1 || { echo "✗ 缺 setsid，无法建立独立 manual lease supervisor" >&2; exit 3; }

OUTER_START="$(process_start_time "$$")" || { echo "✗ 无法记录 wrapper 进程身份" >&2; exit 3; }
SUPERVISOR_PID=""; SUPERVISOR_START=""
outer_cleanup() {
  local rc=$?
  trap - EXIT INT TERM HUP
  set +e
  if [[ -n "$SUPERVISOR_PID" ]]; then
    terminate_exact_process "$SUPERVISOR_PID" "$SUPERVISOR_START"
    if ! same_live_process "$SUPERVISOR_PID" "$SUPERVISOR_START"; then
      wait "$SUPERVISOR_PID" 2>/dev/null || true
    fi
  fi
  exit "$rc"
}
trap outer_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

OC_V5_MANUAL_LEASE_INTERNAL=1 setsid "$SELF" "$$" "$OUTER_START" "$@" &
SUPERVISOR_PID=$!
SUPERVISOR_START="$(process_start_time "$SUPERVISOR_PID")" || {
  kill -KILL "$SUPERVISOR_PID" 2>/dev/null || true
  SUPERVISOR_PID=""
  echo "✗ 无法记录 manual lease supervisor exact identity" >&2
  exit 3
}
if wait "$SUPERVISOR_PID"; then rc=0; else rc=$?; fi
SUPERVISOR_PID=""; SUPERVISOR_START=""
exit "$rc"
