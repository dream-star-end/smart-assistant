#!/usr/bin/env bash
# v5-selfhost-train-guards.sh — OCV5-904 发车前/后置物理硬门库：
#   1. 声明式镜像 pin 读取 (deploy/v5/runtime-image-pin.json，兼容旧变量回退)
#   2. 宿主 Governor 总闸模式 (control/mode.json: autonomous / debt_first / emergency_stop)
#   3. 发车前置 CI 绿灯硬门 (gh api 校验必需 workflow completed/success；仅 --rollback 或 root break-glass 豁免)
#   4. Incident trailer 物理 break-glass 校验 (彻底禁止 OC_V5_SKIP_TRAILER_GATE=1 环境变量逃生口)
#   5. 切流后置行为保留集校验 (/opt/openclaude/harness-gate/run-retention.sh) + 失败自动官方回滚 + 通知熔断器
#
# 由 scripts/deploy-v5-selfhost.sh source；所有逻辑均 fail-closed 且向后兼容首个滚动上线窗口。

V5_SELFHOST_DEFAULT_RUNTIME_IMAGE="openclaude/openclaude-runtime:v5-cli-cc2332-codex01720-grok1092-cur1122-zcode3153-agy1518-chrome-octave-z3-slim"
V5_CI_REQUIRED_WORKFLOWS_DEFAULT="V5 selfhost gates,V5 selfhost release gates"
RUNTIME_IMAGE_PIN_PREVIOUS="${RUNTIME_IMAGE_PIN_PREVIOUS:-}"
RUNTIME_IMAGE_PIN_CLI_VERSIONS="${RUNTIME_IMAGE_PIN_CLI_VERSIONS:-{}}"
RUNTIME_IMAGE_PIN_SOURCE="${RUNTIME_IMAGE_PIN_SOURCE:-fallback-default}"

_v5_tg_log() {
  if declare -F log >/dev/null 2>&1; then
    log "$*"
  else
    echo "$*"
  fi
}

_v5_tg_die() {
  if declare -F die >/dev/null 2>&1; then
    die "$*"
  else
    echo "✗ $*" >&2
    exit 1
  fi
}

v5_selfhost_governor_root() {
  printf '%s\n' "${OC_GOVERNOR_ROOT:-/opt/openclaude/harness-gate}"
}

v5_selfhost_governor_control_dir() {
  printf '%s\n' "${OC_V5_GOVERNOR_CONTROL_DIR:-$(v5_selfhost_governor_root)/control}"
}

# ── 1. 声明式 Runtime Image / CLI Pin 读取 ─────────────────────────────────
# 消费 deploy/v5/runtime-image-pin.json (schemaVersion=1, runtimeImage, previousRuntimeImage, cliVersions)。
# 若文件尚未落盘(首个滚动窗口)则回退到内置默认 RUNTIME_IMAGE；若文件存在但损坏/非法则 fail-closed。
v5_selfhost_load_runtime_image_pin() {
  local pin_file="${OC_V5_RUNTIME_IMAGE_PIN_FILE:-${REPO_ROOT:-.}/deploy/v5/runtime-image-pin.json}"
  local schema="" img="" prev="" clis=""
  if [[ ! -e "$pin_file" && ! -L "$pin_file" ]]; then
    RUNTIME_IMAGE="${RUNTIME_IMAGE:-$V5_SELFHOST_DEFAULT_RUNTIME_IMAGE}"
    RUNTIME_IMAGE_PIN_PREVIOUS=""
    RUNTIME_IMAGE_PIN_CLI_VERSIONS="{}"
    RUNTIME_IMAGE_PIN_SOURCE="fallback-default"
    return 0
  fi
  [[ -f "$pin_file" && ! -L "$pin_file" ]] \
    || _v5_tg_die "runtime-image-pin 非普通文件或为符号链接，拒绝读取: $pin_file"
  command -v jq >/dev/null 2>&1 || _v5_tg_die "缺少 jq，无法解析 $pin_file"
  schema="$(jq -er '.schemaVersion' "$pin_file" 2>/dev/null || true)"
  [[ "$schema" == 1 ]] \
    || _v5_tg_die "runtime-image-pin schemaVersion 非法(got=${schema:-<empty>}, want=1): $pin_file"
  img="$(jq -er '.runtimeImage | select(type == "string" and test("^[A-Za-z0-9._/:@-]+$"))' "$pin_file" 2>/dev/null || true)"
  [[ -n "$img" ]] \
    || _v5_tg_die "runtime-image-pin 缺合法字符串字段 .runtimeImage: $pin_file"
  prev="$(jq -r '.previousRuntimeImage // empty' "$pin_file" 2>/dev/null || true)"
  clis="$(jq -c 'if (.cliVersions | type) == "object" then .cliVersions else {} end' "$pin_file" 2>/dev/null || echo '{}')"
  RUNTIME_IMAGE="$img"
  RUNTIME_IMAGE_PIN_PREVIOUS="$prev"
  RUNTIME_IMAGE_PIN_CLI_VERSIONS="$clis"
  RUNTIME_IMAGE_PIN_SOURCE="pin-file:$pin_file"
}

# ── 2. 宿主机 root 专属 Break-Glass 凭证校验 ───────────────────────────────
# 仅允许精确绑定 40-hex SHA 的宿主机普通文件，彻底杜绝环境变量绕过或符号链接伪造。
# stdout: 审批理由第一行；rc=0 有效豁免；rc=1 文件不存在；若文件存在但权限/属主/内容非法则直接 die(fail-closed)。
_v5_selfhost_valid_breakglass_file() { # <kind: ci|trailer> <40-hex-sha>
  local kind="$1" sha="$2" ctrl_dir f parent uid mode puid pmode reason
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || return 1
  ctrl_dir="$(v5_selfhost_governor_control_dir)"
  f="${ctrl_dir}/${kind}-breakglass-${sha}"
  if [[ ! -e "$f" && ! -L "$f" ]]; then
    return 1
  fi
  if [[ -L "$f" || ! -f "$f" ]]; then
    _v5_tg_die "break-glass 凭证非法(符号链接或非普通文件)，fail-closed 拒绝: $f"
  fi
  if [[ "$(id -u)" == 0 && "$f" == /opt/openclaude/* ]] || [[ "${OC_V5_BREAKGLASS_REQUIRE_ROOT:-0}" == 1 ]]; then
    parent="$(dirname -- "$f")"
    read -r puid pmode < <(stat -Lc '%u %a' -- "$parent" 2>/dev/null || echo '999999 777')
    read -r uid mode < <(stat -Lc '%u %a' -- "$f" 2>/dev/null || echo '999999 777')
    if [[ "$puid" != 0 ]] || (( (8#$pmode & 8#022) != 0 )); then
      _v5_tg_die "break-glass 控制目录属主/权限不可信(uid=$puid mode=$pmode): $parent"
    fi
    if [[ "$uid" != 0 ]] || (( (8#$mode & 8#022) != 0 )); then
      _v5_tg_die "break-glass 凭证属主/权限不可信(uid=$uid mode=$mode，仅允许宿主机 root 只读文件): $f"
    fi
  fi
  reason="$(awk 'NF {print; exit}' "$f" 2>/dev/null | tr -cd 'A-Za-z0-9 ._:,/@+-' | cut -c1-160 || true)"
  [[ -n "$reason" ]] || _v5_tg_die "break-glass 凭证缺少审批理由(空文件拒绝): $f"
  printf '%s\n' "$reason"
  return 0
}

# ── 3. 宿主 Governor 运行模式总闸 (control/mode.json) ─────────────────────
# 返回 "mode\treason"；文件不存在时向后兼容返回 autonomous；文件损坏/非法/符号链接时 fail-closed。
v5_selfhost_read_governor_mode() {
  local mode_file="${OC_V5_GOVERNOR_MODE_FILE:-$(v5_selfhost_governor_control_dir)/mode.json}"
  local mode="" reason=""
  if [[ ! -e "$mode_file" && ! -L "$mode_file" ]]; then
    printf 'autonomous\t\n'
    return 0
  fi
  if [[ -L "$mode_file" || ! -f "$mode_file" ]]; then
    _v5_tg_die "governor mode.json 不能是符号链接或非普通文件: $mode_file"
  fi
  mode="$(jq -er '.mode // empty' "$mode_file" 2>/dev/null || true)"
  reason="$(jq -r '.reason // ""' "$mode_file" 2>/dev/null | tr '\n\r\t' '   ' | cut -c1-200 || true)"
  case "$mode" in
    autonomous|debt_first|emergency_stop)
      printf '%s\t%s\n' "$mode" "$reason"
      return 0
      ;;
    *)
      _v5_tg_die "governor mode.json 模式非法或 JSON 损坏(mode=${mode:-<empty>}): $mode_file"
      ;;
  esac
}

# 校验当前 Governor 模式是否允许发车 target_sha：
# - autonomous     : 放行
# - emergency_stop : 立即拒发
# - debt_first     : 校验 base..target_sha 区间内所有非合并提交不含 feat(...)，仅放行 bug/fix/refactor/chore/ci/docs/perf
v5_selfhost_check_governor_mode() { # <target-sha> [base-ref]
  local sha="$1" base_ref="${2:-}" mode_line mode reason live_root live_sha commits bad="" csha csubj
  local -a g=(env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory 'GIT_CONFIG_VALUE_0=*' git -C "$REPO_ROOT")
  if [[ "${CUTOVER_ROLLBACK:-0}" == 1 ]]; then
    _v5_tg_log "  ⚠ [governor] --rollback 模式放行应急回滚"
    return 0
  fi
  mode_line="$(v5_selfhost_read_governor_mode)"
  IFS=$'\t' read -r mode reason <<<"$mode_line"
  case "$mode" in
    autonomous)
      _v5_tg_log "  ✓ [governor] mode=autonomous"
      return 0
      ;;
    emergency_stop)
      _v5_tg_die "宿主 Governor 处于 emergency_stop 模式(reason=${reason:-<未说明>})，立即拒绝发车！补救: 宿主机 root 确认安全后执行 oc-governor mode autonomous --reason \"...\""
      ;;
    debt_first)
      if [[ -z "$base_ref" && -L "${MASTER_LIVE_LINK:-}" ]]; then
        live_root="$(readlink -f -- "$MASTER_LIVE_LINK" 2>/dev/null || true)"
        if [[ -n "$live_root" && -f "$live_root/.complete" ]]; then
          live_sha="$(jq -er '.sourceCommit // empty' "$live_root/.complete" 2>/dev/null || true)"
          if [[ "$live_sha" =~ ^[0-9a-f]{40}$ && "$live_sha" != "$sha" ]] \
            && "${g[@]}" merge-base --is-ancestor "$live_sha" "$sha" 2>/dev/null; then
            base_ref="$live_sha"
          fi
        fi
      fi
      if [[ -z "$base_ref" ]] && "${g[@]}" rev-parse --verify --quiet "${sha}^^{commit}" >/dev/null 2>&1; then
        base_ref="${sha}^"
      fi
      if [[ -n "$base_ref" ]]; then
        commits="$("${g[@]}" log --no-merges --format='%H%x09%s' "${base_ref}..${sha}" 2>/dev/null || true)"
      else
        commits="$("${g[@]}" log -1 --format='%H%x09%s' "$sha" 2>/dev/null || true)"
      fi
      if [[ -z "$commits" ]]; then
        commits="$("${g[@]}" log -1 --format='%H%x09%s' "$sha" 2>/dev/null || true)"
      fi
      local re_feat='^feat(\([^)]*\))?!?:'
      local re_allowed='^(bug|fix|refactor|chore|ci|docs|perf)(\([^)]*\))?!?:[[:space:]]'
      while IFS=$'\t' read -r csha csubj; do
        [[ -n "$csha" ]] || continue
        if [[ "$csubj" =~ $re_feat ]] || [[ ! "$csubj" =~ $re_allowed ]]; then
          bad+="${bad:+$'\n'}  - ${csha:0:12} ${csubj}"
        fi
      done <<<"$commits"
      if [[ -n "$bad" ]]; then
        _v5_tg_die "宿主 Governor 处于 debt_first 模式(reason=${reason:-<未说明>})，禁止发车含新 feat 或非清债提交(仅放行 bug/fix/refactor/chore/ci/docs/perf):
$bad
补救: 在 debt_first 期间仅合入清债/修复提交，或由宿主机 root 执行 oc-governor mode autonomous 解冻。"
      fi
      _v5_tg_log "  ✓ [governor] mode=debt_first 校验通过(${base_ref:+${base_ref:0:12}..}${sha:0:12} 全为 bug/fix/refactor/chore/ci/docs/perf)"
      return 0
      ;;
  esac
}

# ── 4. 发车前置 CI 绿灯硬门 (v5_selfhost_verify_ci_green) ──────────────────
_v5_selfhost_detect_gh_repo() {
  if [[ -n "${OC_V5_GH_REPO:-}" ]]; then
    printf '%s\n' "$OC_V5_GH_REPO"
    return 0
  fi
  local url="" slug=""
  url="$(env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory 'GIT_CONFIG_VALUE_0=*' \
    git -C "$REPO_ROOT" remote get-url origin 2>/dev/null || true)"
  if [[ "$url" =~ github\.com[:/]([A-Za-z0-9._-]+/[A-Za-z0-9._-]+)(\.git)?$ ]]; then
    slug="${BASH_REMATCH[1]}"
    slug="${slug%.git}"
    printf '%s\n' "$slug"
    return 0
  fi
  return 1
}

# 校验目标 SHA 在 GitHub Actions 的全部必需 workflow 均为 completed/success。
# 仅 --rollback 模式或宿主机 root 专属 break-glass 文件 (${CONTROL_DIR}/ci-breakglass-<sha>) 可豁免。
v5_selfhost_verify_ci_green() { # <40-hex-sha>
  local sha="$1" bg_reason="" gh_bin="${OC_V5_GH_BIN:-gh}" gh_repo="" req_csv="" resp="" report=""
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || _v5_tg_die "[ci-green] 目标 SHA 非法: $sha"
  if [[ "${OC_V5_SKIP_CI_GATE:-0}" == 1 ]]; then
    _v5_tg_die "禁止通过环境变量 OC_V5_SKIP_CI_GATE=1 绕过 CI 绿灯前置硬门！仅 --rollback 或宿主机 root 文件 $(v5_selfhost_governor_control_dir)/ci-breakglass-${sha} 可豁免。"
  fi
  if [[ "${CUTOVER_ROLLBACK:-0}" == 1 ]]; then
    _v5_tg_log "  ⚠ [ci-green] --rollback 模式豁免发车前置 CI 绿灯校验 (${sha:0:12})"
    return 0
  fi
  if bg_reason="$(_v5_selfhost_valid_breakglass_file ci "$sha")"; then
    _v5_tg_log "  ⚠ [ci-green] 命中宿主机 root break-glass 豁免 (${sha:0:12}, reason=$bg_reason)"
    tsum_note ciGreen "breakglass:${sha:0:12}" 2>/dev/null || :
    return 0
  fi
  command -v "$gh_bin" >/dev/null 2>&1 \
    || _v5_tg_die "[ci-green] 缺少 gh CLI ($gh_bin)，无法核验目标 SHA ${sha:0:12} CI 绿灯(fail-closed)"
  gh_repo="$(_v5_selfhost_detect_gh_repo)" \
    || _v5_tg_die "[ci-green] 无法从 origin 解析 GitHub owner/repo(可设 OC_V5_GH_REPO)，fail-closed 拒发"
  req_csv="${OC_V5_CI_REQUIRED_WORKFLOWS:-$V5_CI_REQUIRED_WORKFLOWS_DEFAULT}"
  _v5_tg_log "── 发车前置 CI 绿灯硬门(sha=${sha:0:12}, repo=$gh_repo, workflows=$req_csv) ──"
  if ! resp="$("$gh_bin" api "repos/${gh_repo}/actions/runs?head_sha=${sha}&per_page=100" 2>&1)"; then
    _v5_tg_die "[ci-green] gh api 查询失败(fail-closed): ${resp:0:300}"
  fi
  if ! report="$(V5_CI_RUNS_JSON="$resp" python3 - "$req_csv" "$sha" <<'PY'
import json, os, sys

req_csv, sha = sys.argv[1], sys.argv[2]
required = [x.strip() for x in req_csv.split(",") if x.strip()]
if not required:
    sys.stderr.write("required workflows list is empty\n")
    sys.exit(2)
try:
    data = json.loads(os.environ.get("V5_CI_RUNS_JSON", ""))
except Exception as exc:
    sys.stderr.write(f"invalid JSON from gh api: {exc}\n")
    sys.exit(2)
runs = data.get("workflow_runs")
if not isinstance(runs, list):
    sys.stderr.write("missing workflow_runs array in gh api response\n")
    sys.exit(2)

# Group runs by workflow name and pick the most recent run (by created_at, id)
by_name = {}
for r in runs:
    if not isinstance(r, dict):
        continue
    r_sha = r.get("head_sha")
    if r_sha and r_sha != sha:
        continue
    name = r.get("name")
    if not isinstance(name, str):
        continue
    key = (str(r.get("created_at") or ""), int(r.get("id") or 0))
    prev = by_name.get(name)
    if prev is None or key > prev[0]:
        by_name[name] = (key, r)

failed = []
passed = []
for wf in required:
    entry = by_name.get(wf)
    if entry is None:
        failed.append(f"  - {wf}: missing (no GitHub Actions run found for {sha[:12]})")
        continue
    r = entry[1]
    st = str(r.get("status") or "unknown")
    conc = str(r.get("conclusion") or "none")
    url = str(r.get("html_url") or "")
    if st == "completed" and conc == "success":
        passed.append(f"{wf}=completed/success")
    else:
        failed.append(f"  - {wf}: status={st} conclusion={conc}{(' ' + url) if url else ''}")

if failed:
    sys.stdout.write("\n".join(failed) + "\n")
    sys.exit(1)
sys.stdout.write(", ".join(passed) + "\n")
PY
  )"; then
    _v5_tg_die "发车前置 CI 绿灯硬门拒绝发布 (sha=${sha:0:12}):
$report
补救: 等待 GitHub Actions 全部必需 workflow 变为 completed/success 后再发车；
仅限紧急止血: 由宿主机 root 写原因至 $(v5_selfhost_governor_control_dir)/ci-breakglass-${sha}"
  fi
  tsum_note ciGreen "passed:${sha:0:12}" 2>/dev/null || :
  _v5_tg_log "  ✓ [ci-green] 全部必需 workflow 绿灯: $report"
}

# ── 5. Incident Trailer 物理豁免校验 (移除 OC_V5_SKIP_TRAILER_GATE=1 环境变量逃生口) ──
# 返回 0 表示命中宿主机 root 专属 trailer-breakglass-<sha> 豁免；返回 1 表示必须执行 trailer 门；
# 只要检测到 OC_V5_SKIP_TRAILER_GATE=1 环境变量立刻 fail-closed 拒发！
v5_selfhost_trailer_breakglass_check() { # <40-hex-sha>
  local sha="$1" bg_reason=""
  if [[ "${OC_V5_SKIP_TRAILER_GATE:-0}" == 1 ]]; then
    _v5_tg_die "OC_V5_SKIP_TRAILER_GATE=1 环境变量逃生口已物理移除，禁止绕过 Incident trailer 门！紧急止血仅允许宿主机 root 创建审批文件 $(v5_selfhost_governor_control_dir)/trailer-breakglass-${sha}"
  fi
  if bg_reason="$(_v5_selfhost_valid_breakglass_file trailer "$sha")"; then
    _v5_tg_log "  ⚠ [trailer-gate] 命中宿主机 root break-glass 豁免 (${sha:0:12}, reason=$bg_reason)"
    tsum_note trailerGate "breakglass:${sha:0:12}" 2>/dev/null || :
    return 0
  fi
  return 1
}

# ── 6. 切流后置保留集校验 + 失败自动官方回滚 + 通知熔断器 ──────────────────
v5_selfhost_notify_governor_breaker() { # <train-id> <reason>
  local train_id="${1:-manual}" reason="${2:-post-cutover-retention-failed}"
  local gov_bin="${OC_V5_GOVERNOR_BIN:-$(v5_selfhost_governor_root)/bin/oc-governor}"
  local ctrl_dir counter_file
  ctrl_dir="$(v5_selfhost_governor_control_dir)"
  counter_file="${ctrl_dir}/retention-rollbacks.jsonl"
  if [[ -d "$ctrl_dir" && -w "$ctrl_dir" && ! -L "$counter_file" ]]; then
    jq -cn --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg train "$train_id" --arg reason "$reason" \
      '{ts:$ts,train:$train,reason:$reason,source:"deploy-v5-selfhost"}' >>"$counter_file" 2>/dev/null || true
  fi
  if [[ -x "$gov_bin" ]]; then
    if "$gov_bin" trip-breaker --train "$train_id" --reason "$reason" >&2 2>/dev/null; then
      _v5_tg_log "  ✓ [governor] 已通知 $gov_bin trip-breaker (train=$train_id)"
      return 0
    fi
    if "$gov_bin" record-rollback --train "$train_id" --reason "$reason" >&2 2>/dev/null; then
      _v5_tg_log "  ✓ [governor] 已通知 $gov_bin record-rollback (train=$train_id)"
      return 0
    fi
    _v5_tg_log "  ⚠ [governor] 通知 $gov_bin 熔断脚本返回非零(已记本地计数)"
  else
    _v5_tg_log "  · [governor] 未安装 $gov_bin，跳过外部熔断调用"
  fi
}

v5_selfhost_trigger_official_rollback() { # <failed-rel> <sha> <retention-rc>
  local rel="$1" sha="$2" ret_rc="$3"
  if [[ -n "${OC_V5_RETENTION_ROLLBACK_CMD:-}" ]]; then
    bash -c "$OC_V5_RETENTION_ROLLBACK_CMD" -- "$rel" "$sha" "$ret_rc"
    return $?
  fi
  env -u LEASE_TRAIN_ID -u OC_V5_LEASE_TRAIN_ID "$SCRIPT_DIR/deploy-v5-selfhost.sh" --rollback
}

v5_selfhost_post_cutover_retention_gate() { # <release-path> <40-hex-sha>
  local rel="$1" sha="$2"
  local runner="${OC_V5_RETENTION_RUNNER:-$(v5_selfhost_governor_root)/run-retention.sh}"
  local settle_sec="${OC_V5_RETENTION_SETTLE_SEC:-5}"
  local attempts="${OC_V5_RETENTION_HEALTHZ_ATTEMPTS:-15}"
  local interval="${OC_V5_RETENTION_HEALTHZ_INTERVAL_SEC:-2}"
  local timeout_sec="${OC_V5_RETENTION_TIMEOUT_SEC:-420}"
  local healthz_url="${OC_V5_RETENTION_HEALTHZ_URL:-http://127.0.0.1:${V5_PORT:-18790}/healthz}"
  local i code="" hz_ok=0 rc=0 rb_rc=0 train_id="${LEASE_TRAIN_ID:-manual-$$}"

  if [[ "${DRY:-0}" == 1 ]]; then
    _v5_tg_log "  [dry-run] 切流后置行为保留集: 等 ${settle_sec}s + /healthz 200 → $runner (FAIL 触发官方 --rollback + oc-governor trip-breaker)"
    return 0
  fi
  if [[ "${CUTOVER_ROLLBACK:-0}" == 1 ]]; then
    return 0
  fi
  if [[ ! -x "$runner" ]]; then
    if [[ "${OC_V5_RETENTION_REQUIRED:-0}" == 1 ]]; then
      _v5_tg_die "[post-cutover-retention] OC_V5_RETENTION_REQUIRED=1 但缺少可执行 $runner"
    fi
    _v5_tg_log "  ⚠ [post-cutover-retention] 未安装可执行 $runner，跳过切流后置保留集"
    return 0
  fi

  _v5_tg_log "── 切流后置行为保留集硬门 ($runner, settle=${settle_sec}s, sha=${sha:0:12}) ──"
  if [[ "$settle_sec" =~ ^[1-9][0-9]*$ ]]; then
    sleep "$settle_sec"
  fi
  for (( i=1; i<=attempts; i++ )); do
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "$healthz_url" 2>/dev/null || true)"
    if [[ "$code" == 200 ]]; then
      hz_ok=1
      break
    fi
    _v5_tg_log "  [post-cutover-retention] 等待 /healthz 200 ($i/$attempts, got=${code:-err})…"
    sleep "$interval"
  done

  if [[ "$hz_ok" != 1 ]]; then
    rc=97
    _v5_tg_log "✗ [post-cutover-retention] 切流稳定窗口内 $healthz_url 未返回 200(last=${code:-err})"
  else
    _v5_tg_log "  ✓ [post-cutover-retention] /healthz 200 就绪，开始执行 $runner"
    if command -v timeout >/dev/null 2>&1; then
      timeout "${timeout_sec}s" "$runner" || rc=$?
    else
      "$runner" || rc=$?
    fi
  fi

  if [[ "$rc" == 0 ]]; then
    tsum_note retentionGate passed 2>/dev/null || :
    _v5_tg_log "  ✓ [post-cutover-retention] 行为保留集全部 PASS"
    return 0
  fi

  tsum_note retentionGate "failed:rc=$rc" 2>/dev/null || :
  _v5_tg_log "✗ [post-cutover-retention] 行为保留集 FAIL (rc=$rc) @ $rel → 立即触发官方自动回滚并通知熔断器！"
  if declare -F lease_train_finish >/dev/null 2>&1; then
    lease_train_finish failed "post-cutover retention gate failed (rc=$rc); auto-rollback triggered" || true
  fi
  v5_selfhost_trigger_official_rollback "$rel" "$sha" "$rc" || rb_rc=$?
  v5_selfhost_notify_governor_breaker "$train_id" "retention-gate-failed:rc=$rc:sha=${sha:0:12}:rollback_rc=$rb_rc" || true
  if declare -F deploy_alert >/dev/null 2>&1; then
    deploy_alert post_cutover_retention_rollback "$rel" \
      "切流后置行为保留集 FAIL (rc=$rc, sha=${sha:0:12})，已自动触发官方 --rollback (rb_rc=$rb_rc) 并通知熔断器。"
  fi
  _v5_tg_die "切流后置行为保留集 FAIL (rc=$rc, sha=${sha:0:12}): 已触发官方自动回滚 (rollback_rc=$rb_rc) 并记入熔断计数"
}
