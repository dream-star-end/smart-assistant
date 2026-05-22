#!/usr/bin/env bash
# diagnose-user.sh — 现网 hotfix 黄金诊断三件套 (placement + 日志 + 路径解析)
#
# 当用户报"下载失败 / 上传失败 / 容器卡住"等问题时第一时间跑这个,5 秒拿到
# 三件套结论再决定是否动代码:
#
#   1. 用户当前 placement(在 self 还是 remote 哪台 host?容器 state 如何?)
#   2. 最近 5 分钟 gateway log 里和这个用户相关的错误条目
#   3. master 视角解析出的 host-side media 路径 + volume 是否存在
#
# 用法 (在 kl-mirror 上跑,需 psql + docker + journalctl + jq + curl):
#
#   scripts/diagnose-user.sh 28
#   scripts/diagnose-user.sh c:28
#   scripts/diagnose-user.sh 28 --minutes=15      # 日志窗口
#   scripts/diagnose-user.sh 28 --probe-node-agent  # 顺便 ping 远端 node-agent
#
# 输出全是 plain text + 一些 emoji 状态标识,直接贴回对话框诊断够用。
#
# 历史:2026-05-16 Phase 2 上线时浪费了 ~2 小时改 remote-host 读路径,后来
# 才发现用户容器其实在 self。如果当时第一步跑这个脚本就能避免。

set -uo pipefail

# ── Parse args ──
USER_ARG=""
MINUTES=5
PROBE_NODE_AGENT=0
for arg in "$@"; do
  case "$arg" in
    --minutes=*) MINUTES="${arg#*=}" ;;
    --probe-node-agent) PROBE_NODE_AGENT=1 ;;
    --help|-h)
      sed -n '2,18p' "$0"
      exit 0
      ;;
    -*) echo "unknown flag: $arg" >&2; exit 2 ;;
    *) USER_ARG="$arg" ;;
  esac
done

if [[ -z "$USER_ARG" ]]; then
  echo "usage: $0 <user_id|c:user_id> [--minutes=N] [--probe-node-agent]" >&2
  exit 2
fi

# Normalize: accept "28" or "c:28" → UID="28"
UID_NUM="${USER_ARG#c:}"
if ! [[ "$UID_NUM" =~ ^[1-9][0-9]{0,18}$ ]]; then
  echo "ERROR: invalid user id '$USER_ARG' — expect positive integer (or 'c:<int>')" >&2
  exit 2
fi

# ── Source env (DATABASE_URL needed; HOST_SECRET_AESGCM_KEY for node-agent probe) ──
if [[ -r /etc/openclaude/commercial.env ]]; then
  set -a
  # shellcheck disable=SC1091
  source /etc/openclaude/commercial.env
  set +a
fi
if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL not set (expected from /etc/openclaude/commercial.env)" >&2
  exit 2
fi

VOLUME_NAME="oc-v3-data-u${UID_NUM}"
UPLOADS_HOST_DIR="/var/lib/docker/volumes/${VOLUME_NAME}/_data/uploads"
GENERATED_HOST_DIR="/var/lib/docker/volumes/${VOLUME_NAME}/_data/generated"

echo "═══════════════════════════════════════════════════════════════════"
echo "  diagnose-user uid=${UID_NUM}    (window: ${MINUTES} min)"
echo "═══════════════════════════════════════════════════════════════════"

# ── 1. Placement: agent_containers + compute_hosts join ──
echo ""
echo "── [1/4] Placement ──"
PLACEMENT_JSON=$(psql "$DATABASE_URL" -At -F$'\t' -c "
SELECT c.id, c.status, c.state, h.name, h.host, h.status,
       c.bound_ip, c.host_uuid, c.docker_id,
       to_char(c.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SSZ'),
       to_char(c.last_ws_activity AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SSZ')
  FROM agent_containers c
  LEFT JOIN compute_hosts h ON c.host_uuid = h.id
 WHERE c.user_id = ${UID_NUM}
 ORDER BY
   (c.state = 'active' AND c.status = 'running') DESC,  -- 活着的容器永远第一行
   c.updated_at DESC
 LIMIT 8;
" 2>&1)

if [[ -z "$PLACEMENT_JSON" ]]; then
  echo "  ❌ no agent_containers row for user_id=${UID_NUM}"
  echo "     → 用户从未起过容器,或 DB 不通"
  HOST_NAME=""
  CONTAINER_STATE=""
else
  echo "  container_id | status | state | host_name | host_ip | host_status | bound_ip | host_uuid | docker_id | updated_at | last_ws_activity"
  echo "$PLACEMENT_JSON" | awk -F'\t' '{printf "  %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s\n", $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11}'
  # Pick top row — SQL ORDER BY 把 active+running 排第一,如有则它就是"活着"的容器
  TOP_ROW=$(echo "$PLACEMENT_JSON" | head -1)
  TOP_STATUS=$(echo "$TOP_ROW" | cut -f2)
  CONTAINER_STATE=$(echo "$TOP_ROW" | cut -f3)
  HOST_NAME=$(echo "$TOP_ROW" | cut -f4)
  HOST_IP=$(echo "$TOP_ROW" | cut -f5)
  DOCKER_ID=$(echo "$TOP_ROW" | cut -f9)

  IS_LIVE=0
  if [[ "$TOP_STATUS" == "running" && "$CONTAINER_STATE" == "active" ]]; then
    IS_LIVE=1
  fi

  echo ""
  if [[ "$IS_LIVE" -eq 1 && "$HOST_NAME" == "self" ]]; then
    echo "  ✅ LIVE on SELF (status=running, state=active) — 走本地路径 (handleApiFile realpathSync)"
  elif [[ "$IS_LIVE" -eq 1 ]]; then
    echo "  🌐 LIVE on REMOTE host '${HOST_NAME}' (${HOST_IP}) — 走 node-agent RPC"
    echo "     → Phase 2 read-path 在生效 (master gateway → node-agent GET /files)"
  else
    echo "  ⏸  顶部 row 非 live (status=${TOP_STATUS}, state=${CONTAINER_STATE})"
    echo "     → 用户没活着的容器,/api/file 会按 resolveMediaDirs 失败 (not-ready/vanished)"
  fi
fi

# ── 2. Resolved media paths + volume sanity ──
echo ""
echo "── [2/4] Master-view 路径 + Docker volume ──"
echo "  uploads:   ${UPLOADS_HOST_DIR}"
echo "  generated: ${GENERATED_HOST_DIR}"

if docker volume inspect "${VOLUME_NAME}" >/dev/null 2>&1; then
  MP=$(docker volume inspect -f '{{.Mountpoint}}' "${VOLUME_NAME}" 2>/dev/null)
  echo "  ✅ docker volume ${VOLUME_NAME} exists  → ${MP}"
  if [[ -d "${MP}/uploads" ]]; then
    UP_CNT=$(find "${MP}/uploads" -maxdepth 1 -type f 2>/dev/null | wc -l)
    UP_SZ=$(du -sh "${MP}/uploads" 2>/dev/null | awk '{print $1}')
    echo "  ✅ uploads/   ${UP_CNT} files, ${UP_SZ}"
  else
    echo "  ⚠  uploads/ 目录不存在"
  fi
  if [[ -d "${MP}/generated" ]]; then
    GN_CNT=$(find "${MP}/generated" -maxdepth 1 -type f 2>/dev/null | wc -l)
    GN_SZ=$(du -sh "${MP}/generated" 2>/dev/null | awk '{print $1}')
    echo "  ✅ generated/ ${GN_CNT} files, ${GN_SZ}"
  else
    echo "  ⚠  generated/ 目录不存在"
  fi
else
  echo "  ❌ docker volume ${VOLUME_NAME} 不存在于本机 (${HOSTNAME})"
  if [[ -n "${HOST_NAME}" && "$HOST_NAME" != "self" ]]; then
    echo "     (正常 — volume 在远端 host '${HOST_NAME}' 上,master 没有物理 mountpoint)"
  fi
fi

# ── 3. Gateway journal: 最近 N 分钟里和这个 uid 相关的错误 ──
echo ""
echo "── [3/4] Gateway log (最近 ${MINUTES} 分钟内 uid=${UID_NUM} 相关条目) ──"
# 抓 c:<uid> JWT sub + uid=<uid> 数字字段两种格式;同时过 ERROR/warn/upload/api/file/api/media
LOG_LINES=$(journalctl -u openclaude --since "${MINUTES} min ago" --no-pager 2>/dev/null \
  | grep -E "\"sub\":\"c:${UID_NUM}\"|\"uid\":${UID_NUM}([^0-9]|$)|c:${UID_NUM}|uid=${UID_NUM}([^0-9]|$)" \
  | grep -E "ERROR|WARN|warn|error|/api/file|/api/media|upload|503|404|502" \
  | tail -30)
if [[ -z "$LOG_LINES" ]]; then
  echo "  ✅ 无错误条目"
else
  echo "$LOG_LINES"
fi

# ── 4. Node-agent probe (optional, only if remote + flag) ──
if [[ "$PROBE_NODE_AGENT" -eq 1 && -n "$HOST_NAME" && "$HOST_NAME" != "self" ]]; then
  echo ""
  echo "── [4/4] node-agent /health probe (${HOST_NAME}:9443) ──"
  PROBE=$(curl -sk --max-time 5 "https://${HOST_IP}:9443/health" 2>&1 || echo "{\"error\":\"connect failed\"}")
  echo "$PROBE" | head -5
else
  echo ""
  echo "── [4/4] node-agent probe skipped (self placement or --probe-node-agent 未带) ──"
fi

echo ""
echo "═══════════════════════════════════════════════════════════════════"
echo "  Done. 下一步建议:"
if [[ -z "$HOST_NAME" ]]; then
  echo "    - 用户从未起容器 → 让用户登录触发 supervisor.ensureRunning"
elif [[ "$CONTAINER_STATE" != "active" ]]; then
  echo "    - 容器 state=${CONTAINER_STATE} → 查 supervisor log 看为啥没到 active"
elif [[ "$HOST_NAME" == "self" ]]; then
  echo "    - self placement,问题在本机 handleApiFile / 文件系统层,看 [3/4] 日志"
else
  echo "    - remote placement,问题可能在 node-agent ↔ master 链路或 node-agent binary 版本"
  echo "    - 加 --probe-node-agent 看远端 binary /health"
fi
echo "═══════════════════════════════════════════════════════════════════"
