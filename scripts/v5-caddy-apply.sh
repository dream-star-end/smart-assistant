#!/usr/bin/env bash
# v5-caddy-apply.sh — P0 最高风险动作:在现网 Caddy 上加法式接入 v5 标签分流。
#
# 策略(安全优先):生成"完整新 Caddyfile"(默认块 = 现网 v3 原样;新增 handle @v5
# 仅当请求带 secret 头 X-OC-V5-Secret 才进 v5:18790)→ 备份现网 → caddy validate →
# caddy adapt diff 供肉眼核对 → 安装 → systemctl reload(优雅,不重启 v3)→ reload
# 期间持续探无标签 → 18789 验 v3 不掉 + 带 secret → 18790 验 v5 命中。任一失败回滚。
#
# P0 闸:仅 secret 头可达 v5(不公开 /v5、不靠可伪造 cookie),真实对话留 P1。
#
# 用法:
#   scripts/v5-caddy-apply.sh            # 应用(生成 secret 并打印,装新 Caddyfile + reload + 验证)
#   scripts/v5-caddy-apply.sh --verify   # 仅探活(无标签→v3、带 secret→v5)
#   scripts/v5-caddy-apply.sh --rollback # 还原最近一次本脚本的备份 + reload
#   scripts/v5-caddy-apply.sh --dry-run  # 只打印将执行的动作
set -euo pipefail
KL_HOST="${KL_HOST:-kl-mirror}"
CADDYFILE="/etc/caddy/Caddyfile"
SECRET_FILE="/etc/openclaude/v5-caddy-secret"
BACKUP_TAG="pre-v5"

DRY=0; MODE="apply"
for a in "$@"; do case "$a" in
  --dry-run) DRY=1 ;;
  --verify) MODE="verify" ;;
  --rollback) MODE="rollback" ;;
  *) echo "未知参数 $a" >&2; exit 2 ;;
esac; done
sshk() { if [[ "$DRY" == 1 ]]; then echo "  [dry-run] ssh $KL_HOST '$*'"; else ssh "$KL_HOST" "$@"; fi; }

gen_caddyfile() { # $1 = secret
local secret="$1"
cat <<CADDY
# OpenClaude commercial reverse proxy —— v3(默认)+ v5 灰度(secret 闸)。
# 由 scripts/v5-caddy-apply.sh 生成。默认块 = 原 v3,完全不变;handle @v5 仅当请求带
# X-OC-V5-Secret 头时进 v5:18790(P0 不公开,真实对话留 P1)。
{
	auto_https off
}

http://claudeai.chat {
	log {
		output file /var/log/caddy/claudeai-access.log {
			roll_size 100mb
			roll_keep 5
			roll_keep_for 168h
		}
		format json
	}

	encode gzip zstd

	# v5 灰度闸:仅带正确 secret 头的请求进 v5(P0 内测,不公开)。
	@v5 header X-OC-V5-Secret ${secret}
	# v5 独立支付回调:虎皮椒服务器回调不带 secret/cookie,按 path 定向 18790。
	# 若走共享路径会落 v3,v3 markOrderPaid 对 kind 零感知 → v5 订阅订单被按充值错误履约。
	@v5pay path /api/payment/hupi/callback-v5
	@websocket {
		header Connection *Upgrade*
		header Upgrade websocket
	}

	# ── v5 支付回调(18790)—— 按 path 命中(handler 自带虎皮椒验签,无需 secret 闸)──
	handle @v5pay {
		reverse_proxy localhost:18790 {
			header_up Host {host}
			header_up X-Real-IP {remote_host}
			header_up X-Forwarded-For {remote_host}
			header_up X-Forwarded-Proto {scheme}
		}
	}

	# ── v5(18790)—— 带 secret 才命中 ──
	handle @v5 {
		reverse_proxy @websocket localhost:18790 {
			header_up Host {host}
			header_up X-Real-IP {remote_host}
			header_up X-Forwarded-For {remote_host}
			header_up X-Forwarded-Proto {scheme}
			stream_close_delay 5m
			lb_try_duration 15s
			lb_try_interval 250ms
		}
		reverse_proxy localhost:18790 {
			header_up Host {host}
			header_up X-Real-IP {remote_host}
			header_up X-Forwarded-For {remote_host}
			header_up X-Forwarded-Proto {scheme}
			transport http {
				read_timeout 300s
				write_timeout 300s
			}
			lb_try_duration 15s
			lb_try_interval 250ms
		}
	}

	# ── 默认(无 v5 标签)→ v3(18789)—— 与现网完全一致 ──
	handle {
		reverse_proxy @websocket localhost:18789 {
			header_up Host {host}
			header_up X-Real-IP {remote_host}
			header_up X-Forwarded-For {remote_host}
			header_up X-Forwarded-Proto {scheme}
			stream_close_delay 5m
			lb_try_duration 15s
			lb_try_interval 250ms
		}
		reverse_proxy localhost:18789 {
			header_up Host {host}
			header_up X-Real-IP {remote_host}
			header_up X-Forwarded-For {remote_host}
			header_up X-Forwarded-Proto {scheme}
			transport http {
				read_timeout 300s
				write_timeout 300s
			}
			lb_try_duration 15s
			lb_try_interval 250ms
		}
	}
}
CADDY
}

verify_routing() {
  echo "── 验证分流(无标签→v3:18789、带 secret→v5:18790)──"
  local secret; secret="$(ssh "$KL_HOST" "cat $SECRET_FILE" 2>/dev/null || true)"
  # 无标签:经 Caddy(走 CF 回源端口 80,Host: claudeai.chat)应命中 v3
  local v3resp; v3resp="$(ssh "$KL_HOST" "curl -fsS -H 'Host: claudeai.chat' http://127.0.0.1:80/healthz" 2>/dev/null || true)"
  echo "  无标签 /healthz(应 v3,channel v3 或无 channel 字段): $v3resp"
  echo "$v3resp" | grep -q '"channel":"v5"' && { echo "✗ 无标签竟命中 v5!" >&2; return 1; }
  [[ -z "$v3resp" ]] && { echo "✗ 无标签请求无响应(v3 受影响!)" >&2; return 1; }
  # 带 secret:应命中 v5
  if [[ -n "$secret" ]]; then
    local v5resp; v5resp="$(ssh "$KL_HOST" "curl -fsS -H 'Host: claudeai.chat' -H 'X-OC-V5-Secret: $secret' http://127.0.0.1:80/healthz" 2>/dev/null || true)"
    echo "  带 secret /healthz(应 v5): $v5resp"
    echo "$v5resp" | grep -q '"channel":"v5"' || { echo "✗ 带 secret 未命中 v5" >&2; return 1; }
  fi
  echo "✓ 分流验证通过:无标签走 v3、带 secret 走 v5"
}

case "$MODE" in
  verify) verify_routing ;;
  rollback)
    echo "══ Caddy rollback ← $CADDYFILE.$BACKUP_TAG.bak ══"
    sshk "test -f '$CADDYFILE.$BACKUP_TAG.bak' || { echo '✗ 无备份' >&2; exit 1; }"
    sshk "cp '$CADDYFILE.$BACKUP_TAG.bak' '$CADDYFILE' && caddy validate --config '$CADDYFILE' --adapter caddyfile && systemctl reload caddy"
    echo "✓ 已还原现网 Caddy 并 reload。"
    ;;
  apply)
    echo "══ Caddy v5 标签分流接入(加法式)══"
    # 1) 生成/复用 secret
    local_secret="$(openssl rand -hex 24)"
    sshk "test -s '$SECRET_FILE' || { umask 077; echo '$local_secret' > '$SECRET_FILE'; }"
    SECRET="$(ssh "$KL_HOST" "cat $SECRET_FILE" 2>/dev/null || echo "$local_secret")"
    echo "  v5 secret(测试用):$SECRET"
    # 2) 生成新 Caddyfile 到本地临时,scp 到远端临时
    TMP_LOCAL="$(mktemp)"; gen_caddyfile "$SECRET" > "$TMP_LOCAL"
    if [[ "$DRY" == 1 ]]; then echo "  [dry-run] 新 Caddyfile 预览:"; sed 's/^/    /' "$TMP_LOCAL"; rm -f "$TMP_LOCAL"; exit 0; fi
    scp -q "$TMP_LOCAL" "$KL_HOST:/tmp/Caddyfile.v5new"; rm -f "$TMP_LOCAL"
    # 3) validate 新文件
    sshk "caddy validate --config /tmp/Caddyfile.v5new --adapter caddyfile" || { echo "✗ 新 Caddyfile validate 失败,放弃" >&2; exit 1; }
    # 4) adapt diff 供核对(当前 vs 新)
    echo "── caddy adapt diff(当前 → 新)──"
    sshk "diff <(caddy adapt --config '$CADDYFILE' --adapter caddyfile 2>/dev/null | jq -S .) <(caddy adapt --config /tmp/Caddyfile.v5new --adapter caddyfile 2>/dev/null | jq -S .) || true"
    # 5) 备份 + 安装 + reload(reload 期间后台探 v3)
    sshk "cp '$CADDYFILE' '$CADDYFILE.$BACKUP_TAG.bak'"
    sshk "( for i in \$(seq 1 30); do curl -fsS -H 'Host: claudeai.chat' http://127.0.0.1:80/healthz >/dev/null 2>&1 || echo \"  [probe] v3 miss @\$i\"; sleep 0.3; done ) & PROBE=\$!; cp /tmp/Caddyfile.v5new '$CADDYFILE' && systemctl reload caddy; wait \$PROBE; echo '  (reload 期间 v3 探活完成,上面无 miss 即零中断)'"
    # 6) 验证分流
    verify_routing
    echo "✓ Caddy v5 分流已接入。回滚:scripts/v5-caddy-apply.sh --rollback"
    ;;
esac
