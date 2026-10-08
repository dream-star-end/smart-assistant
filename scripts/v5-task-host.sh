#!/usr/bin/env bash
# 宿主侧任务面板入口:容器在就 docker exec oc-task;容器被 idle sweep 回收时,
# `ticket comment` 进持久队列,由 lease worker 每次 tick 在容器回来后按序送达。
#
# 为什么(2026-10-08 devflow-opt):面板 API 由用户容器自己的 gateway 提供(/api/board 回环),
# 容器 30 分钟无活动就被 v3/idleSweep 回收;此前外机/宿主 agent 只能把「回头补评论」写进交接文件,
# 经常漏。本脚本不改产品行为、不碰数据库、不借用户凭据、不唤醒容器:
#   · 读(get/list…)与 create(编号必须由服务端返回)在容器不在时直接失败并说明;
#   · comment 入队(root 0600,JSONL),送达用的仍是容器内官方 oc-task,保证与直接评论同一路径。
#
# 用法:
#   scripts/v5-task-host.sh [--uid N] <oc-task 参数…>     # 默认 uid 3(个人版 owner)
#   scripts/v5-task-host.sh flush [--quiet]               # 容器在时按序送达队列(lease worker 每 tick 调用)
#   scripts/v5-task-host.sh pending                       # 只读:列出未送达条目
# 退出码:oc-task 原样;75 = 已入队待送达;3 = 容器不在且该命令不能排队;2 = 用法错误。
set -euo pipefail

SPOOL_DIR="${OC_V5_TASK_SPOOL_DIR:-/var/lib/openclaude-v5-selfhost/oc-task-spool}"
CONTAINER_FMT="${OC_V5_TASK_CONTAINER_FMT:-oc-v5-u%s}"
UID_DEFAULT="${OC_V5_TASK_UID:-3}"

die() { echo "✗ $*" >&2; exit 2; }

container_of() { printf "$CONTAINER_FMT" "$1"; }

running() { # <container>
  [[ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null || true)" == true ]]
}

exec_task() { # <container> <args…>
  local ctr="$1"; shift
  docker exec -u agent -e HOME=/home/agent "$ctr" /home/agent/.local/bin/oc-task "$@"
}

spool_lock() {
  mkdir -p "$SPOOL_DIR"
  chmod 0700 "$SPOOL_DIR"
  exec 9>>"$SPOOL_DIR/.lock"
  flock 9
}

enqueue_comment() { # <uid> <args…>(已确认是 ticket comment)
  local uid="$1"; shift
  local id line
  spool_lock
  id="tq-$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
  # 参数经 NUL 分隔走 stdin(以 -- 开头的参数不能交给 jq 的 --args 解析)。
  line="$(printf '%s\0' "$@" | jq -cRs --arg id "$id" --arg uid "$uid" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{id: $id, uid: $uid, queuedAt: $at, args: (split("\u0000") | .[:-1])}')"
  ( umask 077; printf '%s\n' "$line" >>"$SPOOL_DIR/pending.jsonl" )
  echo "⏳ $(container_of "$uid") 未运行(idle sweep 回收后要等 owner 下次连接才重建):评论已入队 $id,容器回来后由 lease worker 按序送达。" >&2
  echo "   查看:scripts/v5-task-host.sh pending" >&2
  exit 75
}

cmd_flush() {
  local quiet=0 line uid ctr id rest kept=0 sent=0 failed=""
  [[ "${1:-}" == --quiet ]] && quiet=1
  [[ -s "$SPOOL_DIR/pending.jsonl" ]] || { [[ "$quiet" == 1 ]] || echo "队列为空"; return 0; }
  spool_lock
  rest="$(mktemp "$SPOOL_DIR/.pending.XXXXXX")"
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    if [[ -n "$failed" ]]; then printf '%s\n' "$line" >>"$rest"; kept=$((kept + 1)); continue; fi
    uid="$(jq -r '.uid' <<<"$line")"; id="$(jq -r '.id' <<<"$line")"
    ctr="$(container_of "$uid")"
    if ! running "$ctr"; then
      failed="容器 $ctr 未运行"; printf '%s\n' "$line" >>"$rest"; kept=$((kept + 1)); continue
    fi
    # 评论正文多行:参数按 NUL 分隔还原,不能按换行切。
    mapfile -d '' -t args < <(jq -j '.args[] | . + "\u0000"' <<<"$line")
    if exec_task "$ctr" "${args[@]}" </dev/null >/dev/null 2>"$SPOOL_DIR/.last-error"; then
      jq -c --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '. + {deliveredAt: $at}' <<<"$line" >>"$SPOOL_DIR/delivered.jsonl"
      sent=$((sent + 1))
    else
      # 按序送达:一条失败就停,后面的保持原顺序留在队列里,下一次 tick 再试。
      failed="$id 送达失败: $(head -c 300 "$SPOOL_DIR/.last-error" | tr '\n' ' ')"
      printf '%s\n' "$line" >>"$rest"; kept=$((kept + 1))
    fi
  done <"$SPOOL_DIR/pending.jsonl"
  chmod 0600 "$rest"
  mv -f "$rest" "$SPOOL_DIR/pending.jsonl"
  if [[ "$quiet" != 1 || "$sent" -gt 0 || -n "$failed" ]]; then
    echo "oc-task 队列:已送达 $sent,剩余 $kept${failed:+;停在:$failed}" >&2
  fi
  [[ "$sent" -gt 0 && "$kept" == 0 ]] && rm -f "$SPOOL_DIR/.last-error"
  return 0
}

cmd_pending() {
  [[ -s "$SPOOL_DIR/pending.jsonl" ]] || { echo "队列为空"; return 0; }
  jq -r '"\(.id)  uid=\(.uid)  \(.queuedAt)  \(.args | join(" ") | .[0:120])"' "$SPOOL_DIR/pending.jsonl"
}

main() {
  local uid="$UID_DEFAULT" ctr
  case "${1:-}" in
    flush) shift; command -v docker >/dev/null 2>&1 || return 0; cmd_flush "$@"; return ;;
    pending) cmd_pending; return ;;
    ""|-h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; return 0 ;;
  esac
  if [[ "$1" == --uid ]]; then
    [[ "${2:-}" =~ ^[0-9]+$ ]] || die "--uid 需要数字"
    uid="$2"; shift 2
  fi
  [[ $# -ge 1 ]] || die "缺少 oc-task 参数"
  ctr="$(container_of "$uid")"
  if running "$ctr"; then
    # 先把之前排队的评论送掉,保证顺序。
    cmd_flush --quiet || true
    exec_task "$ctr" "$@"
    return
  fi
  if [[ "${1:-}" == ticket && "${2:-}" == comment ]]; then
    enqueue_comment "$uid" "$@"
  fi
  echo "✗ $ctr 未运行(idle sweep 回收;owner 下次打开 Web 时重建)。只有 'ticket comment' 能排队;读和 create 需要容器在线。" >&2
  exit 3
}

main "$@"
