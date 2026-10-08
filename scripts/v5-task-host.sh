#!/usr/bin/env bash
# 宿主侧任务面板入口:容器在就 docker exec oc-task;容器被 idle sweep 回收时,
# `ticket comment` 进持久队列,由 lease worker 每次 tick 在容器回来后按序送达。
#
# 为什么(2026-10-08 devflow-opt):面板 API 由用户容器自己的 gateway 提供(/api/board 回环),
# 容器 30 分钟无活动就被 v3/idleSweep 回收;此前外机/宿主 agent 只能把「回头补评论」写进交接文件,
# 经常漏。本脚本不改产品行为、不碰数据库、不借用户凭据、不唤醒容器:
#   · 读(get/list…)与 create(编号必须由服务端返回)在容器不在时直接失败并说明;
#   · comment 入队(root 0600,JSONL),送达用的仍是容器内官方 oc-task,保证与直接评论同一路径。
#   · 至多一次:送达前先把队首条目原子地挪进 inflight.json;成功后记 delivered.jsonl。flush 发现残留的
#     inflight.json(上次送达途中被杀,结果未知)时**不重发**,挪进 uncertain.jsonl 并告警,由人核对工单。
#   · 每次 docker exec 硬上限(TERM 后再 KILL);同一时刻只有一个 flush(拿不到锁就跳过,下个 tick 再来)。
#
# 用法:
#   scripts/v5-task-host.sh [--uid N] <oc-task 参数…>     # 默认 uid 3(个人版 owner)
#   scripts/v5-task-host.sh flush [--quiet]               # 容器在时按序送达队列(lease worker 每 tick 调用)
#   scripts/v5-task-host.sh pending                       # 只读:列出未送达 / 结果未知的条目
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

EXEC_TIMEOUT="${OC_V5_TASK_EXEC_TIMEOUT:-60}"
EXEC_KILL_AFTER="${OC_V5_TASK_EXEC_KILL_AFTER:-5}"

exec_task() { # <container> <args…>
  local ctr="$1"; shift
  timeout --kill-after="$EXEC_KILL_AFTER" "$EXEC_TIMEOUT" \
    docker exec -u agent -e HOME=/home/agent "$ctr" /home/agent/.local/bin/oc-task "$@"
}

spool_dir() {
  mkdir -p "$SPOOL_DIR"
  chmod 0700 "$SPOOL_DIR"
}

# 入队:短临界区,阻塞等锁。flush 的长 I/O(docker exec)不在这把锁里做,不会让入队久等。
spool_lock() {
  spool_dir
  exec 9>>"$SPOOL_DIR/.lock"
  flock 9
}

spool_unlock() { flock -u 9; exec 9>&-; }

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

# 原子取出队首一条到 inflight.json(持队列锁的短临界区);队列空返回 1。
take_head_locked() {
  local head
  spool_lock
  if [[ ! -s "$SPOOL_DIR/pending.jsonl" ]]; then spool_unlock; return 1; fi
  head="$(head -n 1 "$SPOOL_DIR/pending.jsonl")"
  ( umask 077; printf '%s\n' "$head" >"$SPOOL_DIR/.inflight.tmp" )
  mv -f "$SPOOL_DIR/.inflight.tmp" "$SPOOL_DIR/inflight.json"
  ( umask 077; tail -n +2 "$SPOOL_DIR/pending.jsonl" >"$SPOOL_DIR/.pending.tmp" )
  mv -f "$SPOOL_DIR/.pending.tmp" "$SPOOL_DIR/pending.jsonl"
  spool_unlock
}

# 送达失败:把 inflight 条目放回队首,保持顺序(持队列锁)。
requeue_inflight_locked() {
  spool_lock
  ( umask 077; { cat "$SPOOL_DIR/inflight.json"; cat "$SPOOL_DIR/pending.jsonl" 2>/dev/null || true; } >"$SPOOL_DIR/.pending.tmp" )
  mv -f "$SPOOL_DIR/.pending.tmp" "$SPOOL_DIR/pending.jsonl"
  rm -f "$SPOOL_DIR/inflight.json"
  spool_unlock
}

cmd_flush() {
  local quiet=0 line uid ctr id rc sent=0 stop=""
  [[ "${1:-}" == --quiet ]] && quiet=1
  [[ -d "$SPOOL_DIR" ]] || { [[ "$quiet" == 1 ]] || echo "队列为空"; return 0; }
  # 同时只允许一个 flush;另一个在跑就直接返回(lease worker 每 30s 都会再来)。
  exec 8>>"$SPOOL_DIR/.flush.lock"
  flock -n 8 || { [[ "$quiet" == 1 ]] || echo "另一个 flush 正在进行,跳过"; return 0; }
  if [[ -s "$SPOOL_DIR/inflight.json" ]]; then
    # 上次送达途中被打断,无法判断评论是否已写入:至多一次 → 不重发,交给人核对。
    ( umask 077; cat "$SPOOL_DIR/inflight.json" >>"$SPOOL_DIR/uncertain.jsonl" )
    rm -f "$SPOOL_DIR/inflight.json"
    echo "⚠ oc-task 队列:发现上次中断的送达($(jq -r '.id' "$SPOOL_DIR/uncertain.jsonl" | tail -n 1)),结果未知,已移入 uncertain.jsonl,不重发;请到工单核对。" >&2
  fi
  while [[ -z "$stop" ]]; do
    [[ -s "$SPOOL_DIR/pending.jsonl" ]] || break
    line="$(head -n 1 "$SPOOL_DIR/pending.jsonl")"
    uid="$(jq -r '.uid' <<<"$line" 2>/dev/null)" || { stop="队首条目不是合法 JSON"; break; }
    ctr="$(container_of "$uid")"
    running "$ctr" || { stop="容器 $ctr 未运行"; break; }
    take_head_locked || break
    line="$(cat "$SPOOL_DIR/inflight.json")"
    id="$(jq -r '.id' <<<"$line")"
    # 评论正文多行:参数按 NUL 分隔还原,不能按换行切。
    mapfile -d '' -t args < <(jq -j '.args[] | . + "\u0000"' <<<"$line")
    rc=0
    exec_task "$ctr" "${args[@]}" </dev/null >/dev/null 2>"$SPOOL_DIR/.last-error" || rc=$?
    if [[ "$rc" == 0 ]]; then
      ( umask 077; jq -c --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '. + {deliveredAt: $at}' <<<"$line" >>"$SPOOL_DIR/delivered.jsonl" )
      rm -f "$SPOOL_DIR/inflight.json"
      sent=$((sent + 1))
    elif [[ "$rc" == 124 || "$rc" == 137 ]]; then
      # 超时被杀:评论可能已写入,至多一次 → 不重发,交给人核对。
      ( umask 077; cat "$SPOOL_DIR/inflight.json" >>"$SPOOL_DIR/uncertain.jsonl" )
      rm -f "$SPOOL_DIR/inflight.json"
      stop="$id 送达超时(rc=$rc),结果未知,已移入 uncertain.jsonl,不重发"
    else
      # oc-task 明确报错(没写入):放回队首,按序停下,下个 tick 再试。
      requeue_inflight_locked
      stop="$id 送达失败(rc=$rc): $(head -c 300 "$SPOOL_DIR/.last-error" | tr '\n' ' ')"
    fi
  done
  if [[ "$quiet" != 1 || "$sent" -gt 0 || ( -n "$stop" && "$stop" != 容器*未运行 ) ]]; then
    echo "oc-task 队列:已送达 $sent,剩余 $(grep -c . "$SPOOL_DIR/pending.jsonl" 2>/dev/null || echo 0)${stop:+;停在:$stop}" >&2
  fi
  return 0
}

cmd_pending() {
  local f any=0
  for f in pending inflight uncertain; do
    local path="$SPOOL_DIR/$f.json"; [[ "$f" == inflight ]] || path="$SPOOL_DIR/$f.jsonl"
    [[ -s "$path" ]] || continue
    any=1
    jq -r --arg f "$f" '"[\($f)] \(.id)  uid=\(.uid)  \(.queuedAt)  \(.args | join(" ") | .[0:120])"' "$path"
  done
  [[ "$any" == 1 ]] || echo "队列为空"
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
