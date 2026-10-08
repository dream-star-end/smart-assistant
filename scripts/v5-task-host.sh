#!/usr/bin/env bash
# 宿主侧任务面板入口:容器在就 docker exec oc-task;容器被 idle sweep 回收时,
# `ticket comment` 进持久队列,容器回来后按序送达。
#
# 为什么(2026-10-08 devflow-opt):面板 API 由用户容器自己的 gateway 提供(/api/board 回环),
# 容器 30 分钟无活动就被 v3/idleSweep 回收;此前外机/宿主 agent 只能把「回头补评论」写进交接文件,
# 经常漏。本脚本不改产品行为、不碰数据库、不借用户凭据、不唤醒容器:
#   · 读(get/list…)与 create(编号必须由服务端返回)在容器不在时直接失败并说明,从不排队;
#   · 送达用的仍是容器内官方 oc-task,与直接评论走同一路径。
#
# 队列 = 每条一个文件,只靠同一文件系统内的 rename 在目录间移动(原子,任一时刻只在一处):
#   q/ ──取出──▶ inflight/ ──成功──▶ delivered/
#                         └─写入失败/超时/结果不明──▶ uncertain/(至多一次:永不重发,`pending` 列出待人核对)
#   q/ ──预探测确认工单不存在──▶ failed/(从未发送)
# 每次写之前先做只读探测(ticket get <工单>):探测不通 → 一条都没发,原样留在 q/。
# flush 开始时 inflight/ 里的残留(上次送达途中被杀)一律移入 uncertain/,不重发。
#
# 用法:
#   scripts/v5-task-host.sh [--uid N] <oc-task 参数…>     # 默认 uid 3(个人版 owner)
#   scripts/v5-task-host.sh flush [--quiet]               # 送达队列(lease worker 每 tick 以 transient unit 启动)
#   scripts/v5-task-host.sh pending                       # 只读:列出排队 / 结果不明 / 失败的条目
# 退出码:oc-task 原样;75 = 已入队待送达;3 = 容器不在且该命令不能排队;2 = 用法错误。
set -euo pipefail

SPOOL_DIR="${OC_V5_TASK_SPOOL_DIR:-/var/lib/openclaude-v5-selfhost/oc-task-spool}"
CONTAINER_FMT="${OC_V5_TASK_CONTAINER_FMT:-oc-v5-u%s}"
UID_DEFAULT="${OC_V5_TASK_UID:-3}"
EXEC_TIMEOUT="${OC_V5_TASK_EXEC_TIMEOUT:-60}"
EXEC_KILL_AFTER="${OC_V5_TASK_EXEC_KILL_AFTER:-5}"

die() { echo "✗ $*" >&2; exit 2; }

container_of() { printf "$CONTAINER_FMT" "$1"; }

running() { # <container>
  [[ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null || true)" == true ]]
}

exec_task() { # <container> <args…>  硬上限:TERM 后再 KILL
  local ctr="$1"; shift
  timeout --kill-after="$EXEC_KILL_AFTER" "$EXEC_TIMEOUT" \
    docker exec -u agent -e HOME=/home/agent "$ctr" /home/agent/.local/bin/oc-task "$@" </dev/null
}

spool_dirs() {
  local d
  for d in "" /q /inflight /delivered /uncertain /failed; do
    mkdir -p "$SPOOL_DIR$d"
    chmod 0700 "$SPOOL_DIR$d"
  done
}

queued_count() { find "$SPOOL_DIR/q" -maxdepth 1 -type f -name '*.json' 2>/dev/null | wc -l; }

enqueue_comment() { # <uid> <args…>(已确认是 ticket comment)
  local uid="$1"; shift
  local id name
  spool_dirs
  id="tq-$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
  name="$(date +%s%N)-$id.json"   # 文件名即顺序
  # 参数经 NUL 分隔走 stdin(以 -- 开头的参数不能交给 jq 的 --args 解析)。先写临时名再 rename,读者看不到半个文件。
  ( umask 077
    printf '%s\0' "$@" | jq -cRs --arg id "$id" --arg uid "$uid" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      '{id: $id, uid: $uid, queuedAt: $at, args: (split("\u0000") | .[:-1])}' >"$SPOOL_DIR/q/.$name.tmp" )
  mv -f "$SPOOL_DIR/q/.$name.tmp" "$SPOOL_DIR/q/$name"
  echo "⏳ 评论已入队 $id;容器在线且前面的条目送完后按序送达(lease worker 每 tick 都会尝试)。" >&2
  echo "   查看:scripts/v5-task-host.sh pending" >&2
  exit 75
}

# 结果写回条目文件旁的 .note(不改条目本身),供 pending 展示。
note() { # <file> <text>
  ( umask 077; printf '%s\n' "$2" >"$1.note" )
}

cmd_flush() {
  local quiet=0 f base line uid ctr id ticket rc out sent=0 stop=""
  [[ "${1:-}" == --quiet ]] && quiet=1
  [[ -d "$SPOOL_DIR/q" ]] || { [[ "$quiet" == 1 ]] || echo "队列为空"; return 0; }
  spool_dirs
  # 同时只允许一个 flush;另一个在跑就直接返回。
  exec 8>>"$SPOOL_DIR/.flush.lock"
  flock -n 8 || { [[ "$quiet" == 1 ]] || echo "另一个 flush 正在进行,跳过"; return 0; }
  for f in "$SPOOL_DIR"/inflight/*.json; do
    [[ -e "$f" ]] || continue
    mv -f "$f" "$SPOOL_DIR/uncertain/"
    note "$SPOOL_DIR/uncertain/$(basename "$f")" "上次送达途中被打断,结果未知;未重发"
    echo "⚠ oc-task 队列:$(basename "$f") 上次送达途中被打断,结果未知,已移入 uncertain/,不重发;请到工单核对。" >&2
  done
  while [[ -z "$stop" ]]; do
    f="$(find "$SPOOL_DIR/q" -maxdepth 1 -type f -name '*.json' -printf '%f\n' | LC_ALL=C sort | head -n 1)"
    [[ -n "$f" ]] || break
    base="$f"; line="$(cat "$SPOOL_DIR/q/$base")"
    uid="$(jq -r '.uid' <<<"$line" 2>/dev/null)" || { stop="队首 $base 不是合法 JSON"; break; }
    id="$(jq -r '.id' <<<"$line")"
    mapfile -d '' -t args < <(jq -j '.args[] | . + "\u0000"' <<<"$line")   # 多行正文:NUL 分隔还原
    ticket="${args[2]:-}"
    ctr="$(container_of "$uid")"
    running "$ctr" || { stop="容器 $ctr 未运行"; break; }
    # 只读预探测:网关可达且工单存在才发。探测失败 = 一个字节都没写,条目留在 q/。
    rc=0; out="$(exec_task "$ctr" ticket get "$ticket" 2>&1)" || rc=$?
    if [[ "$rc" != 0 ]]; then
      if grep -q '"code":"not_found"' <<<"$out"; then
        mv -f "$SPOOL_DIR/q/$base" "$SPOOL_DIR/failed/"
        note "$SPOOL_DIR/failed/$base" "工单 $ticket 不存在;未发送"
        echo "✗ oc-task 队列:$id 的工单 $ticket 不存在,已移入 failed/(未发送)" >&2
        continue
      fi
      stop="预探测失败(rc=$rc),网关未就绪:$(head -c 200 <<<"$out" | tr '\n' ' ')"
      break
    fi
    # 写:先原子挪进 inflight/,之后任何非成功结果都只能是「结果不明」。
    mv -f "$SPOOL_DIR/q/$base" "$SPOOL_DIR/inflight/"
    rc=0; out="$(exec_task "$ctr" "${args[@]}" 2>&1)" || rc=$?
    if [[ "$rc" == 0 ]]; then
      mv -f "$SPOOL_DIR/inflight/$base" "$SPOOL_DIR/delivered/"
      sent=$((sent + 1))
    else
      mv -f "$SPOOL_DIR/inflight/$base" "$SPOOL_DIR/uncertain/"
      note "$SPOOL_DIR/uncertain/$base" "写入返回 rc=$rc,结果未知;未重发:$(head -c 300 <<<"$out" | tr '\n' ' ')"
      stop="$id 写入返回 rc=$rc,结果未知,已移入 uncertain/,不重发"
    fi
  done
  if [[ "$quiet" != 1 || "$sent" -gt 0 || ( -n "$stop" && "$stop" != 容器*未运行 ) ]]; then
    echo "oc-task 队列:已送达 $sent,剩余 $(queued_count)${stop:+;停在:$stop}" >&2
  fi
  return 0
}

cmd_pending() {
  local st f any=0
  for st in q inflight uncertain failed; do
    for f in "$SPOOL_DIR/$st"/*.json; do
      [[ -e "$f" ]] || continue
      any=1
      jq -r --arg st "$st" '"[\($st)] \(.id)  uid=\(.uid)  \(.queuedAt)  \(.args | join(" ") | .[0:120])"' "$f"
      [[ -f "$f.note" ]] && sed 's/^/      /' "$f.note"
    done
  done
  [[ "$any" == 1 ]] || echo "队列为空"
}

main() {
  local uid="$UID_DEFAULT" ctr
  case "${1:-}" in
    flush) shift; command -v docker >/dev/null 2>&1 || return 0; cmd_flush "$@"; return ;;
    pending) cmd_pending; return ;;
    ""|-h|--help) sed -n '2,29p' "$0" | sed 's/^# \{0,1\}//'; return 0 ;;
  esac
  if [[ "$1" == --uid ]]; then
    [[ "${2:-}" =~ ^[0-9]+$ ]] || die "--uid 需要数字"
    uid="$2"; shift 2
  fi
  [[ $# -ge 1 ]] || die "缺少 oc-task 参数"
  ctr="$(container_of "$uid")"
  local is_comment=0
  [[ "${1:-}" == ticket && "${2:-}" == comment ]] && is_comment=1
  if running "$ctr"; then
    cmd_flush --quiet || true
    # 前面还有没送完的评论时,新评论排到它们后面,不插队。
    if [[ "$is_comment" == 1 && "$(queued_count)" -gt 0 ]]; then
      enqueue_comment "$uid" "$@"
    fi
    exec_task "$ctr" "$@"
    return
  fi
  if [[ "$is_comment" == 1 ]]; then
    echo "⏳ $ctr 未运行(idle sweep 回收后要等 owner 下次连接才重建)。" >&2
    enqueue_comment "$uid" "$@"
  fi
  echo "✗ $ctr 未运行(idle sweep 回收;owner 下次打开 Web 时重建)。只有 'ticket comment' 能排队;读和 create 需要容器在线。" >&2
  exit 3
}

main "$@"
