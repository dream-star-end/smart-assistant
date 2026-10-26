#!/usr/bin/env bash
# 个人版 master env 的唯一写入点与键清单检查(OCV5-535,FINDINGS DEP-7)。由 deploy-v5-selfhost.sh source。
# 键清单:deploy/v5-selfhost/commercial-v5-selfhost.env.template;scripts/v5-selfhost-env-drift.test.sh
# 从本文件读出 bootstrap 模板、ensure_env_kv 与 provider 透传规则,保证代码与清单一致。
# 依赖调用方提供:log/die/run、V5_ENV、SECRETS_ENV、FORCE_ENV、DRY 与 bootstrap 用到的端口/路径常量。

# 从 secrets.env 追加 provider 相关键。永不把值打印到 stdout。
# 跳过任何 DATABASE/REDIS/SESSION/JWT/KMS/HUPIJIAO,避免把个人版库 URL 写进来。
append_provider_keys() {
  local dest="$1" line key
  [[ -f "$SECRETS_ENV" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || continue
    key="${line%%=*}"
    case "$key" in
      *DATABASE*|*REDIS*|HUPIJIAO*|COMMERCIAL_JWT*|JWT_SECRET|OPENCLAUDE_KMS*|PLATFORM_HMAC*|OC_EGRESS_SECRET*)
        continue
        ;;
    esac
    case "$key" in
      ARK_*|DEEPSEEK_*|DEEPGRAM_*|EMBEDDING_*|OPENAI_*|ANTHROPIC_*|GLM_*|DASHSCOPE_*|MOONSHOT_*|MINIMAX_*|GROK_*|GEMINI_*|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|ALL_PROXY|*_API_KEY|*_API_TOKEN)
        printf '%s\n' "$line" >>"$dest"
        ;;
    esac
  done <"$SECRETS_ENV"
}

write_env_file() {
  local pass="$1" jwt kms hmac egress tmp
  log "── 生成 $V5_ENV ──"
  if [[ -f "$V5_ENV" && "$FORCE_ENV" != 1 ]]; then
    log "  ⚠ $V5_ENV 已存在 → 保留不覆盖(权威=现网文件)。要重建请加 --force-env"
    return 0
  fi
  if [[ -f "$V5_ENV" && "$FORCE_ENV" == 1 ]]; then
    log "  ⚠ --force-env:将覆盖已存在的 env(旧文件备份为 ${V5_ENV}.bak-force)"
    run "cp -a '$V5_ENV' '${V5_ENV}.bak-force-$(date -u +%Y%m%d%H%M%S)'"
  fi
  jwt="$(openssl rand -hex 32)"
  # crypto/keys.ts 要求 OPENCLAUDE_KMS_KEY 是 base64(32 bytes),不是 hex。
  kms="$(openssl rand -base64 32 | tr -d '\n')"
  hmac="$(openssl rand -hex 32)"
  egress="$(openssl rand -hex 32)"
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] 写 $V5_ENV (mode 600;密钥不打印)"
    return 0
  fi
  tmp="$(mktemp)"
  local old_umask
  old_umask="$(umask)"
  umask 077
  cat >"$tmp" <<EOF
# commercial-v5-selfhost.env — 本机自用 V5,由 scripts/deploy-v5-selfhost.sh 生成。
# 人工不要手改 OC_RUNTIME_* 四元组;由 hotcfg saga 原子写入。
COMMERCIAL_ENABLED=1
OC_RUNTIME_CHANNEL=v5
OC_CONTROL_PLANE_LEADER=1
OC_SELFHEAL_DISABLED=1
OC_INSTANCE_ID=${INSTANCE_ID}
OC_SLOT=A
DATABASE_URL=postgres://${PG_ROLE}:${pass}@127.0.0.1:5432/${PG_DB}
REDIS_URL=${REDIS_URL}
COMMERCIAL_JWT_SECRET=${jwt}
OPENCLAUDE_KMS_KEY=${kms}
PLATFORM_HMAC_SECRET=${hmac}
OC_EGRESS_SECRET=${egress}
OC_V3_MEMORY_MB=4096
OC_V3_CPUS=2
OC_V3_PIDS_LIMIT=4096
OC_IDLE_SWEEP_DISABLED=1
OC_VOLUME_GC_DISABLED=1
COMMERCIAL_AUTO_MIGRATE=0
# 制品根覆盖:OC_HOTCFG_* 只决定构建产物落在哪,master 侧校验 release/bundle 走这两个键。
# 不配则回落 DEFAULT_*_ROOT(/var/lib/openclaude-v5/...) → 本实例 release 一律判 invalid、拒 provision。
# 下面两行在生成时展开为真实路径(EnvironmentFile 不会二次展开)。
OC_PLATFORM_ROOT=${OC_HOTCFG_PLATFORM_ROOT}
OC_RUNTIME_RELEASES_ROOT=${OC_HOTCFG_RELEASES_ROOT}
# 与 sessions_store_migration_state=pg_authoritative + 本地 manifest 三件套必须同时到位,
# 否则启动矩阵 fail-closed 拒起(env≠pg 不得退回 SQLite)。
OC_SESSIONS_STORE=pg
TURNSTILE_ENFORCE=0
WECHAT_BROKER_ENABLED=0
OC_EGRESS_SPLIT=1
INTERNAL_PROXY_BIND=${V5_EGRESS_BIND}
INTERNAL_PROXY_PORT=${V5_EGRESS_PORT}
INTERNAL_CONTROL_BIND=${V5_CONTROL_BIND}
INTERNAL_CONTROL_PORT=${V5_CONTROL_PORT}
AGENT_RPC_SOCKET_DIR=/var/run/openclaude-agent-rpc-v5-selfhost
AGENT_DOCKER_SOCKET=/var/run/docker.sock
OC_RUNTIME_IMAGE=${RUNTIME_IMAGE}
OC_PREHEAT_DISABLED=1
OC_IMAGE_DISTRIBUTE_DISABLED=1
OC_MIGRATION_RECONCILER_DISABLED=1
OC_HEALTH_POLLER_DISABLED=1
# Privacy-safe continuous-iteration telemetry. No raw prompt/tool output leaves the container.
OC_TOOL_FAILURE_AUDIT=1
OC_SKILL_SHADOW_SAMPLE_RATE=0.1
OC_DURABLE_METRIC_ROLLUPS=1
OC_LOCAL_OBSERVABILITY_RETENTION=1
OC_LOCAL_EVENT_RETENTION_DAYS=30
OC_LOCAL_USAGE_RETENTION_DAYS=365
OC_REDACT_TOOL_EVENT_PREVIEWS=1
# Bound project context (PROJECT.md / skill overlay / run snapshots). Commercial
# production does not set this; gateway keeps the old path when unset.
OC_PROJECT_CONTEXT=1
# Project smart assist (OCV5-354), one flag each; the master forwards them into
# user containers. OC_P5_UNFILED_SUGGEST stays unset: its precision on the
# operator's real unfiled chats was below the bar (evidence in OCV5-354).
OC_P5_PROJECT_SEARCH=1
OC_P5_CHIPS=1
OC_P5_RECIPE_SCHEDULE=1
# Claude Code external HTTPS transport:keep internal http://172.31.0.1:18892
# on NO_PROXY while login/telemetry endpoints share the stable Japan egress.
OC_CLAUDE_CODE_HTTPS_PROXY=http://172.31.0.1:18991
OC_CLAUDE_CODE_TZ=Asia/Tokyo
# 用户面时区(OCV5-166)—— 与上面的 OC_CLAUDE_CODE_TZ **正交**,不要混改。
#   OC_CLAUDE_CODE_TZ : 引擎子进程 TZ,跟随日本出口 IP,是风控一致性控制;
#   OC_USER_TZ        : 用户真实所在地。两处消费:① 外接 ApiKey 路径的 system-reminder
#                       追加「用户本地日期+UTC 偏移」;② 注入容器 env(docker Create.Env),
#                       容器 gateway envProbe 渲染成 ENV slot 的 user_tz= 行给网页/cron 会话。
#                       不改子进程 TZ、不参与选路;非缺省值改后需重建容器才进 PID1。
OC_USER_TZ=Asia/Shanghai
# 不要在本文件写入 OPENCLAUDE_V3_MASTER_BASE_URL / OPENCLAUDE_V3_CONTAINER_TOKEN。
# 这两项由 v3supervisor 按用户容器注入;写进 host env 会让 cron 站内信全部落到同一个 uid。
# token 明文不得进 git。上线无需改本文件,下一次容器重建即带上 supervisor 注入的 env。
EOF
  append_provider_keys "$tmp"
  mkdir -p "$(dirname "$V5_ENV")"
  mv -f "$tmp" "$V5_ENV"
  chmod 600 "$V5_ENV"
  umask "$old_umask"
  log "  ✓ 已写入 $V5_ENV (mode 600;密钥未打印)"
}

# OCV5-535(FINDINGS DEP-7):env 键漂移。只比键名,不读出值。缺 @required 键拒绝发布(此前要到启动或
# 运行期才暴露);未登记键只告警(新键先登记到 deploy/v5-selfhost/commercial-v5-selfhost.env.template)。
assert_env_key_drift() {
  local out rc=0
  log "── env 键漂移检查(对照 deploy/v5-selfhost/commercial-v5-selfhost.env.template,只比键名)──"
  out="$(bash "$SCRIPT_DIR/v5-selfhost-env-drift.sh" --env "$V5_ENV" \
    --template "$REPO_ROOT/deploy/v5-selfhost/commercial-v5-selfhost.env.template" 2>&1)" || rc=$?
  printf '%s\n' "$out" | sed 's/^/  /'
  case "$rc" in
    0) ;;
    1) die "env 缺少 @required 键(见上方 MISSING 行)。补救: 按模板补齐后再发布;不要绕过本检查。" ;;
    *) die "env 漂移检查无法运行(rc=$rc)。fail-closed。" ;;
  esac
}

# 幂等 upsert env 键。值不含换行/|;不打印 val(可能跟在含密钥的文件里)。
ensure_env_kv() {
  local file="$1" key="$2" val="$3" cur
  cur="$(oc_hotcfg_env_get "$file" "$key")"
  if [[ "$cur" == "$val" ]]; then
    return 0
  fi
  if grep -Eq "^[[:space:]]*${key}=" "$file"; then
    sed -i "s|^[[:space:]]*${key}=.*|${key}=${val}|" "$file"
  else
    printf '%s=%s\n' "$key" "$val" >>"$file"
  fi
  chmod 600 "$file"
}

ensure_selfhost_env_keys() {
  log "── 确认制品根 + OC_SESSIONS_STORE=pg 写在 $V5_ENV ──"
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] upsert OC_PLATFORM_ROOT OC_RUNTIME_RELEASES_ROOT OC_SESSIONS_STORE=pg"
    return 0
  fi
  [[ -f "$V5_ENV" ]] || die "缺 $V5_ENV。补救: write_env_file 应先跑。"
  ensure_env_kv "$V5_ENV" OC_PLATFORM_ROOT "$OC_HOTCFG_PLATFORM_ROOT"
  ensure_env_kv "$V5_ENV" OC_RUNTIME_RELEASES_ROOT "$OC_HOTCFG_RELEASES_ROOT"
  ensure_env_kv "$V5_ENV" OC_SESSIONS_STORE pg
  ensure_env_kv "$V5_ENV" OC_TOOL_FAILURE_AUDIT 1
  ensure_env_kv "$V5_ENV" OC_SKILL_SHADOW_SAMPLE_RATE 0.1
  ensure_env_kv "$V5_ENV" OC_DURABLE_METRIC_ROLLUPS 1
  ensure_env_kv "$V5_ENV" OC_LOCAL_OBSERVABILITY_RETENTION 1
  ensure_env_kv "$V5_ENV" OC_LOCAL_EVENT_RETENTION_DAYS 30
  ensure_env_kv "$V5_ENV" OC_LOCAL_USAGE_RETENTION_DAYS 365
  ensure_env_kv "$V5_ENV" OC_REDACT_TOOL_EVENT_PREVIEWS 1
  ensure_env_kv "$V5_ENV" OC_PROJECT_CONTEXT 1
  ensure_env_kv "$V5_ENV" OC_P5_PROJECT_SEARCH 1
  ensure_env_kv "$V5_ENV" OC_P5_CHIPS 1
  ensure_env_kv "$V5_ENV" OC_P5_RECIPE_SCHEDULE 1
  ensure_env_kv "$V5_ENV" OC_CLAUDE_CODE_HTTPS_PROXY "http://172.31.0.1:18991"
  ensure_env_kv "$V5_ENV" OC_CLAUDE_CODE_TZ "Asia/Tokyo"
  ensure_env_kv "$V5_ENV" OC_USER_TZ "Asia/Shanghai"
  ensure_env_kv "$V5_ENV" OC_SELFHOST_ENGINE_LOCAL_TURNS 1
  ensure_env_kv "$V5_ENV" SELFHOST_CURSOR_EGRESS 1
  ensure_env_kv "$V5_ENV" OC_V5_WEB_OVERLAY_ROOT "$WEB_OVERLAY_ROOT"
  # OCV5-633:master 在 spa 模式 /assets 未命中时回落的资产池根(网关只认绝对路径;master 重启生效)。
  ensure_env_kv "$V5_ENV" OC_V5_WEB_ASSETS_POOL "$WEB_ASSETS_POOL"
  log "  ✓ 制品根 / PG sessions / privacy-safe telemetry / CCB Japan transport keys"
}
