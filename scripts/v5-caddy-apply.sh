#!/usr/bin/env bash
# v5-caddy-apply.sh — Caddy 生成器**状态机化**(RFC-v5-dual-master-cohort D1/§2)。
#
# 【从 P0 secret 闸 → P3 cohort 状态机】旧实现:v3(默认)+ v5(secret/cookie 闸)手工过渡态。
# v3 已彻底退役,全流量落 v5。P3 起 Caddy 配置由 **deploy_state**(PG 单一权威)派生:
#   - 默认 upstream    → active_slot 端口(A=18790 / B=18795)
#   - /assets/*        → 共享加法式资产池(union pool)**直服**(file_server),跨 lane / abort 后
#                        懒加载 chunk 仍可得(RFC §2:池是并集,GC 保护双在役+回滚代+14 天谱系)
#   - candidate matcher→ 仅 phase∈{canary,finalizing} 且 transition_step≥READY 且有 candidate 时生成:
#                        按当前 generation 的 lane cookie 命中 candidate 端口,active 兜底(RFC D1)
#
# 【基建版兼容 / 纯加法不变量】deploy_state=seed(phase=stable、无 candidate)时,输出 = 只有
# @v5pay + /assets + 默认(→active)三块,**不含任何 candidate 构造**;开 canary 只是**插入**
# 一个 @v5canary 块,seed 的三块逐字节不动 → `--self-check` 断言 diff(seed↔canary) 只有新增(`>`)
# 行、无删除(`<`)行,证明"开灰度不扰动基线路由"。
#
# 用法:
#   scripts/v5-caddy-apply.sh --self-check   # 离线双态渲染 + 纯加法/matcher 断言(不碰 PG/远端)
#   scripts/v5-caddy-apply.sh --render        # 读 deploy_state → 打印将生成的 Caddyfile(不安装)
#   scripts/v5-caddy-apply.sh                 # apply:读 deploy_state → 渲染 → 备份 → validate →
#                                             #        adapt diff → 安装 → reload(期间探活)→ 验证
#   scripts/v5-caddy-apply.sh --verify        # 仅探活(默认落 active;若有 candidate 附带 lane 探测)
#   scripts/v5-caddy-apply.sh --rollback      # 还原最近一次本脚本备份 + reload
#   scripts/v5-caddy-apply.sh --dry-run       # 只打印将执行的动作
#
# deploy-v5.sh 的 canary/finalize/abort lane 在 CAS deploy_state 后调用本脚本(--apply)把状态
# 反映进 Caddy —— CAS 与 Caddy 渲染分离,权威恒在 PG。
set -euo pipefail

KL_HOST="${KL_HOST:-kl-mirror}"
V5_ENV="${V5_ENV:-/etc/openclaude/commercial-v5.env}"
CADDYFILE="/etc/caddy/Caddyfile"
BACKUP_TAG="pre-v5-p3"
# 共享资产池(union;deploy-v5.sh dist lane 加法式 rsync 各 release 的 dist/assets → 此处 assets/)。
ASSETS_POOL="${ASSETS_POOL:-/opt/openclaude/openclaude-v5-assets}"
UPSTREAM_ERRORS_IMPORT="/etc/caddy/openclaude-v5-upstream-errors.caddy"

# deploy_state 单一权威访问层(与 deploy-v5.sh 共用;lane_hash/CAS/read 同源)。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/v5-deploy-state-lib.sh
source "$SCRIPT_DIR/v5-deploy-state-lib.sh"

DRY=0; MODE="apply"
for a in "$@"; do case "$a" in
  --dry-run)    DRY=1 ;;
  --verify)     MODE="verify" ;;
  --rollback)   MODE="rollback" ;;
  --render)     MODE="render" ;;
  --self-check) MODE="self-check" ;;
  --apply)      MODE="apply" ;;
  *) echo "未知参数 $a" >&2; exit 2 ;;
esac; done
sshk() { if [[ "$DRY" == 1 ]]; then echo "  [dry-run] ssh $KL_HOST '$*'"; else ssh "$KL_HOST" "$@"; fi; }

slot_port() { case "$1" in A) echo 18790 ;; B) echo 18795 ;; *) echo "" ;; esac; }

# ── 通用 reverse_proxy 尾块(header_up + 超时;ws 版带 stream_close_delay)──
# 用函数收口,保证 @v5pay / 默认 / candidate 各块的转发参数**同一套**,避免复制漂移。
_rp_ws_body() { cat <<'BODY'
			header_up Host {host}
			header_up X-Real-IP {remote_host}
			header_up X-Forwarded-For {remote_host}
			header_up X-Forwarded-Proto {scheme}
			stream_close_delay 5m
BODY
}
_rp_http_body() { cat <<'BODY'
			header_up Host {host}
			header_up X-Real-IP {remote_host}
			header_up X-Forwarded-For {remote_host}
			header_up X-Forwarded-Proto {scheme}
			transport http {
				read_timeout 300s
				write_timeout 300s
			}
BODY
}

# ── 核心生成器(纯函数;所有输入显式传参 → --self-check 可离线驱动任意状态)──
# 参数:generation phase transition_step active_slot candidate_slot
gen_caddyfile() {
  local generation="$1" phase="$2" step="$3" active_slot="$4" candidate_slot="$5"
  local active_port candidate_port default_slot="$4" default_port emit_canary=0
  active_port="$(slot_port "$active_slot")"
  [[ -n "$active_port" ]] || { echo "gen_caddyfile: 非法 active_slot='$active_slot'" >&2; return 2; }
  # ── 相位感知的 matcher / 默认 upstream 决策(transition_step 是 phase 内步序,须按 phase 解释)──
  case "$phase" in
    canary)
      # 准备期(step<READY)对流量**不可见**,不产 matcher(即使 candidate unit 已起)。
      if [[ -n "$candidate_slot" && "$step" -ge "$DS_STEP_CANARY_READY" ]]; then emit_canary=1; fi
      # 默认恒 → active(cohort 用户经 lane cookie 命中 candidate,非 cohort 落 active)。
      ;;
    finalizing)
      # candidate 已 READY 并 100% 放量:matcher 恒可见;§D5 step②(step≥2)默认 upstream 亦切 candidate。
      if [[ -n "$candidate_slot" ]]; then
        emit_canary=1
        [[ "$step" -ge 2 ]] && default_slot="$candidate_slot"
      fi
      ;;
    aborting|stable|*)
      : # 摘 candidate matcher;默认恒 → active_slot(旧;active_slot 直到 finalize step7 才翻转)
      ;;
  esac
  default_port="$(slot_port "$default_slot")"
  [[ -n "$default_port" ]] || { echo "gen_caddyfile: 非法 default_slot='$default_slot'" >&2; return 2; }
  if [[ "$emit_canary" == 1 ]]; then
    candidate_port="$(slot_port "$candidate_slot")"
    [[ -n "$candidate_port" ]] || { echo "gen_caddyfile: 非法 candidate_slot='$candidate_slot'" >&2; return 2; }
  fi

  cat <<CADDY
# OpenClaude v5 reverse proxy —— 由 scripts/v5-caddy-apply.sh 从 deploy_state 生成(勿手改)。
# generation=$generation phase=$phase transition_step=$step active_slot=$active_slot candidate_slot=${candidate_slot:-<none>} default_slot=$default_slot
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

	@websocket {
		header Connection *Upgrade*
		header Upgrade websocket
	}
	# v5 支付回调:虎皮椒服务器回调不带 lane cookie,按 path 定向 active slot(计费权威在 PG,
	# active 处理正确;放最前,先于 candidate matcher,确保回调恒落 active)。
	@v5pay path /api/payment/hupi/callback-v5
CADDY

  # candidate matcher(仅 canary READY;RFC D1 cookie 编码 g<generation>.<slot>,只匹配当前代次)
  if [[ "$emit_canary" == 1 ]]; then
    cat <<CADDY
	# cohort 灰度:仅**当前 generation** 的 lane cookie 命中 candidate(陈旧代次 cookie 不命中→落 active)。
	@v5canary header_regexp oc_v5lane Cookie "(^|; )oc_v5lane=g${generation}\\.${candidate_slot}"
CADDY
  fi

  # ── @v5pay → active ──
  cat <<CADDY

	handle @v5pay {
		reverse_proxy localhost:${active_port} {
			header_up Host {host}
			header_up X-Real-IP {remote_host}
			header_up X-Forwarded-For {remote_host}
			header_up X-Forwarded-Proto {scheme}
		}
	}

	# ── /assets/* → 共享 union 资产池直服(lane 无关;跨 lane/abort 懒加载 chunk 仍可得,RFC §2)──
	handle /assets/* {
		root * ${ASSETS_POOL}
		file_server
	}
CADDY

  # ── @v5canary → candidate(first[candidate,active];active health + passive;仅连接失败重试 2s)──
  if [[ "$emit_canary" == 1 ]]; then
    cat <<CADDY

	handle @v5canary {
		reverse_proxy @websocket localhost:${candidate_port} localhost:${active_port} {
			lb_policy first
			lb_try_duration 2s
			health_uri /healthz
			health_interval 3s
			health_timeout 2s
			health_status 200
			max_fails 2
			fail_duration 10s
$(_rp_ws_body)
		}
		reverse_proxy localhost:${candidate_port} localhost:${active_port} {
			lb_policy first
			lb_try_duration 2s
			health_uri /healthz
			health_interval 3s
			health_timeout 2s
			health_status 200
			max_fails 2
			fail_duration 10s
$(_rp_http_body)
		}
	}
CADDY
  fi

  # ── 默认(无 lane 标签)→ active slot ──
  cat <<CADDY

	handle {
		reverse_proxy @websocket localhost:${default_port} {
$(_rp_ws_body)
			lb_try_duration 15s
			lb_try_interval 250ms
		}
		reverse_proxy localhost:${default_port} {
$(_rp_http_body)
			lb_try_duration 15s
			lb_try_interval 250ms
		}
	}
	import ${UPSTREAM_ERRORS_IMPORT}
}
CADDY
}

# 读 deploy_state → 渲染当前应生效的 Caddyfile(apply/render/verify 用)。
render_from_state() {
  # dry-run:绝不碰 PG/远端;用占位(可经 DS_DRY_* 由调用方透传 lane 状态,预览将生成的 Caddyfile)。
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] render_from_state 用占位 deploy_state(gen=${DS_DRY_GEN:-42} phase=${DS_DRY_PHASE:-stable} step=${DS_DRY_STEP:-0} active=${DS_DRY_ACTIVE:-A} candidate=${DS_DRY_CAND:-<none>})" >&2
    gen_caddyfile "${DS_DRY_GEN:-42}" "${DS_DRY_PHASE:-stable}" "${DS_DRY_STEP:-0}" "${DS_DRY_ACTIVE:-A}" "${DS_DRY_CAND:-}"
    return 0
  fi
  ds_load || { echo "✗ 无法读取 deploy_state(未 seed / PG 不可达)" >&2; return 1; }
  # MAJOR 2:DS_RENDER_STEP_OVERRIDE 让 finalize 能"先按 step2 语义渲染默认→candidate + reload + 硬验证,
  # 成功后才 CAS transition_step=2"——避免"记录 step2 但 Caddy 未真正切/未验证"的状态-现实撕裂。
  local step="$DS_transition_step"
  [[ -n "${DS_RENDER_STEP_OVERRIDE:-}" ]] && step="$DS_RENDER_STEP_OVERRIDE"
  echo "  · deploy_state: gen=$DS_generation phase=$DS_phase step=$step(db=$DS_transition_step) active=$DS_active_slot candidate=${DS_candidate_slot:-<none>}" >&2
  gen_caddyfile "$DS_generation" "$DS_phase" "$step" "$DS_active_slot" "$DS_candidate_slot"
}

# ── 离线双态自检(不碰 PG/远端):seed 纯加法不变量 + canary matcher 精确性 ──
self_check() {
  local seed canary canary_prep tmp; tmp="$(mktemp -d)"
  # seed:stable,无 candidate
  gen_caddyfile 41 stable 0 A ""            > "$tmp/seed"
  # canary 准备期:step<READY → 不应出现 matcher
  gen_caddyfile 42 canary 0 A B             > "$tmp/canary_prep"
  # canary READY:step≥READY → matcher 出现
  gen_caddyfile 42 canary "$DS_STEP_CANARY_READY" A B > "$tmp/canary"

  local ok=1
  # if-based:set -e 下 grep 未命中(rc=1)不得让 helper 以非零退出而中止 self_check。
  _need()  { if ! grep -q -- "$2" "$1"; then echo "  ✗ [$3] 缺: $2" >&2; ok=0; fi; }
  _deny()  { if   grep -q -- "$2" "$1"; then echo "  ✗ [$3] 不应出现: $2" >&2; ok=0; fi; }

  echo "── self-check ①:seed 态(现行/基建版)──"
  _deny "$tmp/seed"  '@v5canary'                'seed'   # seed 绝无 candidate 构造
  _deny "$tmp/seed"  'localhost:18795'          'seed'   # seed 绝不出现 B 端口
  _need "$tmp/seed"  'localhost:18790'          'seed'   # 默认 → active(A)
  _need "$tmp/seed"  'handle /assets/\*'        'seed'   # /assets 直服
  _need "$tmp/seed"  'root \* /opt/openclaude/openclaude-v5-assets' 'seed'
  _need "$tmp/seed"  'import /etc/caddy/openclaude-v5-upstream-errors.caddy' 'seed'
  _need "$tmp/seed"  '@v5pay path /api/payment/hupi/callback-v5' 'seed'

  echo "── self-check ②:canary 准备期(step<READY)matcher 不可见 ──"
  _deny "$tmp/canary_prep" '@v5canary'          'canary-prep'

  echo "── self-check ③:canary READY matcher 精确性(RFC D1)──"
  _need "$tmp/canary" '@v5canary header_regexp oc_v5lane Cookie "(^|; )oc_v5lane=g42\\.B"' 'canary'
  _need "$tmp/canary" 'localhost:18795 localhost:18790' 'canary'   # first[candidate,active]
  _need "$tmp/canary" 'lb_policy first'         'canary'
  _need "$tmp/canary" 'lb_try_duration 2s'      'canary'
  _need "$tmp/canary" 'health_uri /healthz'     'canary'
  _need "$tmp/canary" 'health_interval 3s'      'canary'
  _need "$tmp/canary" 'health_timeout 2s'       'canary'
  _need "$tmp/canary" 'max_fails 2'             'canary'
  _need "$tmp/canary" 'fail_duration 10s'       'canary'

  echo "── self-check ④:finalizing/aborting 相位(相位感知 step 解释)──"
  local fin1 fin2 abo; fin1="$tmp/fin1"; fin2="$tmp/fin2"; abo="$tmp/abo"
  gen_caddyfile 42 finalizing 1 A B > "$fin1"   # step1:matcher 可见,默认仍 → active
  gen_caddyfile 42 finalizing 2 A B > "$fin2"   # step2:matcher 可见,默认切 → candidate
  gen_caddyfile 42 aborting   0 A B > "$abo"    # aborting:摘 matcher,默认回 active
  _need "$fin1" '@v5canary'                'finalizing-1'
  _need "$fin1" 'handle {'                 'finalizing-1'
  # finalizing step1 默认块仍 → active(18790):默认 handle 内应含 localhost:18790
  grep -A6 'handle {' "$fin1" | grep -q 'localhost:18790' || { echo "  ✗ [finalizing-1] 默认应仍→active(18790)" >&2; ok=0; }
  _need "$fin2" '@v5canary'                'finalizing-2'
  # finalizing step2 默认块 → candidate(18795)
  grep -A6 'handle {' "$fin2" | grep -q 'localhost:18795' || { echo "  ✗ [finalizing-2] 默认应→candidate(18795)" >&2; ok=0; }
  # 支付回调是无 lane cookie 的外部请求，finalizing 默认切 candidate 后仍必须钉 active。
  grep -A2 'handle @v5pay' "$fin2" | grep -q 'localhost:18790' || { echo "  ✗ [finalizing-2] 支付回调必须恒→active(18790)" >&2; ok=0; }
  _deny "$abo" '@v5canary'                 'aborting'
  grep -A6 'handle {' "$abo" | grep -q 'localhost:18790' || { echo "  ✗ [aborting] 默认应回 active(18790)" >&2; ok=0; }
  echo "  ✓ finalizing step1 默认→active、step2 默认→candidate、aborting 摘 matcher 默认回 active"

  echo "── self-check ⑤:seed↔canary 纯加法(seed 三块逐字节不动,只插入 @v5canary)──"
  # 归一化首部状态注释整行(seed/canary 的 gen/phase/step/candidate 本就不同,与路由无关),
  # 再比对:删除(`<`)行必须为 0 → 证明基线三块逐字节不动。
  local seed_n canary_n; seed_n="$tmp/seed.n"; canary_n="$tmp/canary.n"
  sed -E 's/^# generation=.*/# HDR/' "$tmp/seed"   > "$seed_n"
  sed -E 's/^# generation=.*/# HDR/' "$tmp/canary" > "$canary_n"
  local removed; removed="$(diff "$seed_n" "$canary_n" | grep -c '^<' || true)"
  if [[ "$removed" != 0 ]]; then
    echo "  ✗ canary 相对 seed 有 $removed 处删除行(应为纯加法):" >&2
    diff "$seed_n" "$canary_n" | grep '^<' >&2
    ok=0
  else
    echo "  ✓ 纯加法:canary 相对 seed 无删除行(基线路由零扰动)"
  fi
  local added; added="$(diff "$seed_n" "$canary_n" | grep -c '^>' || true)"
  echo "  · 新增行数(@v5canary matcher+handle)= $added"

  echo "── 渲染样例(供人工核对)──"
  echo "  [seed]  默认→active(A/18790)、/assets 直服、无 matcher"
  echo "  [canary] 追加 @v5canary → candidate(B/18795) first-fallback active"
  # 若本机装了 caddy,顺带 validate 两态(非必需,缺失则跳过)
  if command -v caddy >/dev/null 2>&1; then
    caddy validate --config "$tmp/seed"   --adapter caddyfile >/dev/null 2>&1 && echo "  ✓ caddy validate seed 通过"   || echo "  ⚠ caddy validate seed 失败(见上)"
    caddy validate --config "$tmp/canary" --adapter caddyfile >/dev/null 2>&1 && echo "  ✓ caddy validate canary 通过" || echo "  ⚠ caddy validate canary 失败(见上)"
  else
    echo "  (本机无 caddy 二进制,跳过 validate;远端 apply 时会 validate)"
  fi
  rm -rf "$tmp"
  [[ "$ok" == 1 ]] || { echo "✗ self-check 失败" >&2; return 1; }
  echo "✓ self-check 通过(seed 纯加法不变量 + canary matcher 精确)"
}

verify_routing() {
  echo "── 验证分流(默认 → active;canary READY 时附带 lane cookie 探测)──"
  [[ "$DRY" == 1 ]] && { echo "  [dry-run] 探默认 /healthz(应 active);canary READY 时带 lane cookie 探 candidate"; return 0; }
  ds_load || { echo "✗ 读 deploy_state 失败" >&2; return 1; }
  local step="$DS_transition_step"
  [[ -n "${DS_RENDER_STEP_OVERRIDE:-}" ]] && step="$DS_RENDER_STEP_OVERRIDE"
  # 期望默认 slot(与 gen_caddyfile 同逻辑):finalizing ∧ step>=2 → candidate;否则 active。
  local exp_default="$DS_active_slot"
  if [[ "$DS_phase" == "finalizing" && -n "$DS_candidate_slot" && "$step" -ge 2 ]]; then exp_default="$DS_candidate_slot"; fi
  local exp_default_port; exp_default_port="$(slot_port "$exp_default")"
  # 默认(无 lane cookie):经 Caddy 回源应命中 exp_default,healthz ok
  local dresp; dresp="$(ssh "$KL_HOST" "curl -fsS -H 'Host: claudeai.chat' http://127.0.0.1:80/healthz" 2>/dev/null || true)"
  echo "  默认 /healthz(应 slot=$exp_default:$exp_default_port): $dresp"
  [[ -z "$dresp" ]] && { echo "✗ 默认请求无响应(受影响!)" >&2; return 1; }
  echo "$dresp" | grep -q '"ok":true' || { echo "✗ 默认 /healthz ok!=true" >&2; return 1; }
  # BLOCKER 5②:断言响应**确实来自期望 slot**(healthz 顶层/leadership 的 slot 字段),而非只看 ok:true。
  echo "$dresp" | grep -q "\"slot\":\"$exp_default\"" || {
    echo "✗ 默认路由响应 slot != $exp_default(路由未生效或落错 slot;healthz 缺 slot 字段=master 过旧)。拒绝。" >&2
    return 1
  }
  # canary/finalizing READY:带当前代次 lane cookie 应命中 candidate 且响应 slot=candidate
  if [[ "$DS_phase" == "canary" || "$DS_phase" == "finalizing" ]] && [[ -n "$DS_candidate_slot" ]] && [[ "$step" -ge "$DS_STEP_CANARY_READY" ]]; then
    local cport cookie cresp; cport="$(slot_port "$DS_candidate_slot")"
    cookie="oc_v5lane=g${DS_generation}.${DS_candidate_slot}"
    cresp="$(ssh "$KL_HOST" "curl -fsS -H 'Host: claudeai.chat' -H 'Cookie: $cookie' http://127.0.0.1:80/healthz" 2>/dev/null || true)"
    echo "  lane cookie=$cookie /healthz(应 candidate=$DS_candidate_slot:$cport): $cresp"
    echo "$cresp" | grep -q '"ok":true' || { echo "✗ lane cookie 未命中健康 candidate" >&2; return 1; }
    echo "$cresp" | grep -q "\"slot\":\"$DS_candidate_slot\"" || {
      echo "✗ lane cookie 响应 slot != candidate($DS_candidate_slot)(matcher 未生效/落错 slot)。拒绝。" >&2
      return 1
    }
  fi
  echo "✓ 分流验证通过(默认 slot=$exp_default 已核实)"
}

# main guard:被 source(如单测 gen_caddyfile)时只定义函数,不执行任何 mode。
[[ "${BASH_SOURCE[0]}" == "${0}" ]] || return 0

case "$MODE" in
  self-check) self_check ;;
  render)
    render_from_state
    ;;
  verify) verify_routing ;;
  rollback)
    echo "══ Caddy rollback ← $CADDYFILE.$BACKUP_TAG.bak ══"
    sshk "test -f '$CADDYFILE.$BACKUP_TAG.bak' || { echo '✗ 无备份' >&2; exit 1; }"
    sshk "cp '$CADDYFILE.$BACKUP_TAG.bak' '$CADDYFILE' && caddy validate --config '$CADDYFILE' --adapter caddyfile && systemctl reload caddy"
    echo "✓ 已还原 Caddy 并 reload。"
    ;;
  apply)
    echo "══ Caddy 状态机 apply(从 deploy_state 渲染,加法式安装)══"
    TMP_LOCAL="$(mktemp)"
    if ! render_from_state > "$TMP_LOCAL"; then rm -f "$TMP_LOCAL"; exit 1; fi
    if [[ "$DRY" == 1 ]]; then echo "  [dry-run] 新 Caddyfile 预览:"; sed 's/^/    /' "$TMP_LOCAL"; rm -f "$TMP_LOCAL"; exit 0; fi
    scp -q "$TMP_LOCAL" "$KL_HOST:/tmp/Caddyfile.v5p3new"; rm -f "$TMP_LOCAL"
    # validate 新文件(缺 import 文件会失败 → fail-closed)
    sshk "caddy validate --config /tmp/Caddyfile.v5p3new --adapter caddyfile" || { echo "✗ 新 Caddyfile validate 失败,放弃" >&2; exit 1; }
    echo "── caddy adapt diff(当前 → 新)──"
    sshk "diff <(caddy adapt --config '$CADDYFILE' --adapter caddyfile 2>/dev/null | jq -S .) <(caddy adapt --config /tmp/Caddyfile.v5p3new --adapter caddyfile 2>/dev/null | jq -S .) || true"
    sshk "cp '$CADDYFILE' '$CADDYFILE.$BACKUP_TAG.bak'"
    # reload 期间后台探默认路由不掉线
    sshk "( for i in \$(seq 1 30); do curl -fsS -H 'Host: claudeai.chat' http://127.0.0.1:80/healthz >/dev/null 2>&1 || echo \"  [probe] 默认 miss @\$i\"; sleep 0.3; done ) & PROBE=\$!; cp /tmp/Caddyfile.v5p3new '$CADDYFILE' && systemctl reload caddy; wait \$PROBE; echo '  (reload 期间默认路由探活完成,上面无 miss 即零中断)'"
    verify_routing
    echo "✓ Caddy 已按 deploy_state 渲染安装。回滚:scripts/v5-caddy-apply.sh --rollback"
    ;;
esac
