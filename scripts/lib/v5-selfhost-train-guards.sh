#!/usr/bin/env bash
# v5-selfhost-train-guards.sh — OCV5-903/904 共同正向切流护栏、Commit 绑定镜像 Pin、爆破半径与后置保留集硬门库：
#   1. Commit 绑定声明式镜像 Pin (git show <sha>:deploy/v5/runtime-image-pin.json，与 runtimeImagePin.ts 同构全字段校验；绝不提前读脏工作树！)
#   2. 宿主 Governor 总闸模式 (control/mode.json: autonomous / debt_first / emergency_stop)
#   3. 物理调用宿主 oc-governor check-blast-radius（拦截无凭证商业分支 / 破坏性 DDL / 计费核心变更）
#   4. 可信 CI 事件绿灯硬门（只认 push/pull_request/merge_group，拒 workflow_dispatch；默认 3 条必需 workflow）
#   5. 共同正向切流护栏边界 v5_selfhost_enforce_forward_cutover_guards（cmd_deploy 与独立 cmd_cutover 共同在改 live 前强制调用；仅已验证 --rollback 豁免）
#   6. 切流前 retention runner 预检（改 live 前 fail-closed）+ 切流后置 retention 移入 committed 之前（phase=verifying 阻断 worker 提前结算；失败真回滚校验 → failed 或 recovery_required）
#   7. Incident trailer 物理 break-glass 校验（彻底禁止 OC_V5_SKIP_TRAILER_GATE=1 环境变量逃生口）

V5_SELFHOST_DEFAULT_RUNTIME_IMAGE="openclaude/openclaude-runtime:v5-cli-cc2332-codex01720-grok1092-cur1122-zcode3153-agy1518-chrome-octave-z3-slim"
V5_CI_REQUIRED_WORKFLOWS_DEFAULT="V5 selfhost gates,V5 selfhost release gates,V5 selfhost commercial"
RUNTIME_IMAGE_PIN_PREVIOUS="${RUNTIME_IMAGE_PIN_PREVIOUS:-}"
RUNTIME_IMAGE_PIN_CLI_VERSIONS="${RUNTIME_IMAGE_PIN_CLI_VERSIONS:-{}}"
RUNTIME_IMAGE_PIN_SHA256="${RUNTIME_IMAGE_PIN_SHA256:-}"
RUNTIME_IMAGE_PIN_COMMIT="${RUNTIME_IMAGE_PIN_COMMIT:-}"
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

# ── 1. Commit 绑定声明式 Runtime Image / CLI Pin（与 scripts/lib/runtimeImagePin.ts 同构全字段校验）──
# 从 stdin 解析并严格校验 runtime-image-pin.json：
# stdout: runtimeImage\tpreviousRuntimeImage\tcliVersionsJson\tpinSha256
_v5_selfhost_parse_runtime_image_pin_json() { # <source-label>  (stdin = raw JSON)
  local label="${1:-runtime-image-pin.json}"
  local allowed_prefixes="${OC_V5_ALLOWED_IMAGE_PREFIXES:-openclaude/openclaude-runtime:}"
  python3 -c '
import hashlib, json, re, sys

label = sys.argv[1]
allowed_prefixes = [p.strip() for p in sys.argv[2].split(",") if p.strip()]

DOCKER_IMAGE_REF_RE = re.compile(
    r"^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?:@sha256:[0-9a-f]{64})?$"
)
SHELL_META_RE = re.compile(r"[\s;&|`$()<>\\\x27\"]")
CLI_KEY_RE = re.compile(r"^[a-zA-Z0-9._-]{1,40}$")
CLI_VER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$")
CHANNEL_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
TICKET_RE = re.compile(r"^OCV5-\d+$")
ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$")

raw_bytes = sys.stdin.buffer.read()
if not raw_bytes.strip():
    print(f"runtime-image-pin 为空: {label}", file=sys.stderr)
    sys.exit(1)

try:
    doc = json.loads(raw_bytes.decode("utf-8"))
except Exception as exc:
    print(f"runtime-image-pin JSON 解析失败 ({label}): {exc}", file=sys.stderr)
    sys.exit(1)

errors = []

def validate_image_ref(val, field):
    if not isinstance(val, str) or not val.strip():
        errors.append(f"{field} 必须是非空字符串")
        return
    if SHELL_META_RE.search(val):
        errors.append(f"{field} 含非法空白或 shell 元字符: {val!r}")
        return
    if not DOCKER_IMAGE_REF_RE.fullmatch(val):
        errors.append(f"{field} 必须为合法固定镜像 tag/digest 引用: {val!r}")
        return
    tag_part = val.split(":", 1)[1].split("@", 1)[0].lower()
    if tag_part == "latest":
        errors.append(f"{field} 禁止使用浮动 :latest 标签: {val!r}")
        return
    if allowed_prefixes and not any(val.startswith(p) for p in allowed_prefixes):
        joined_p = ", ".join(allowed_prefixes)
        errors.append(f"{field} 必须匹配允许的镜像仓库前缀 ({joined_p}): {val!r}")

if not isinstance(doc, dict):
    errors.append("root 必须是 JSON 对象")
else:
    sv = doc.get("schemaVersion")
    if type(sv) is not int or sv != 1:
        errors.append(f"schemaVersion 必须为整数 1 (got={sv!r})")
    ch = doc.get("channel")
    if not isinstance(ch, str) or not CHANNEL_RE.fullmatch(ch):
        errors.append(f"channel 格式非法 (got={ch!r})")
    validate_image_ref(doc.get("runtimeImage"), "runtimeImage")
    prev = doc.get("previousRuntimeImage")
    if prev is not None:
        validate_image_ref(prev, "previousRuntimeImage")
    if "ticket" in doc and doc["ticket"] is not None:
        tval = doc["ticket"]
        if not isinstance(tval, str) or not TICKET_RE.fullmatch(tval):
            errors.append(f"ticket 必须匹配 OCV5-<digits> (got={tval!r})")
    if "updatedAt" in doc and doc["updatedAt"] is not None:
        uval = doc["updatedAt"]
        if not isinstance(uval, str) or not ISO_DATE_RE.fullmatch(uval):
            errors.append(f"updatedAt 必须为有效 ISO 日期/时间戳 (got={uval!r})")
    if "capabilities" in doc and doc["capabilities"] is not None:
        caps = doc["capabilities"]
        if not isinstance(caps, list) or any(not isinstance(c, str) or not c.strip() for c in caps):
            errors.append("capabilities 必须为非空字符串数组")
    if "note" in doc and doc["note"] is not None and not isinstance(doc["note"], str):
        errors.append("note 必须是字符串")
    clis = doc.get("cliVersions")
    if not isinstance(clis, dict) or len(clis) == 0:
        errors.append("cliVersions 必须是非空 JSON 对象")
    else:
        for k, v in clis.items():
            if not isinstance(k, str) or not CLI_KEY_RE.fullmatch(k):
                errors.append(f"cliVersions 键名非法: {k!r}")
            if not isinstance(v, str) or not CLI_VER_RE.fullmatch(v):
                errors.append(f"cliVersions[{k!r}] 版本号非法: {v!r}")

if errors:
    print(f"runtime-image-pin 校验失败 ({label}): " + "; ".join(errors), file=sys.stderr)
    sys.exit(1)

pin_sha256 = hashlib.sha256(raw_bytes).hexdigest()
img = doc["runtimeImage"]
prev_str = doc.get("previousRuntimeImage") or ""
clis_json = json.dumps(doc["cliVersions"], separators=(",", ":"), sort_keys=True)
print(f"{img}\t{prev_str}\t{clis_json}\t{pin_sha256}")
' "$label" "$allowed_prefixes"
}

# B8: 绑定精确目标 commit SHA 的 runtime-image-pin（只读 git show <sha>:deploy/v5/runtime-image-pin.json，
# 绝不读脏工作树文件！仅当目标 commit 本身不含该文件时回落历史默认常量）。
v5_selfhost_load_runtime_image_pin_for_commit() { # <40-hex-target-sha>
  local sha="$1" parsed="" img="" prev="" clis="" digest=""
  local -a g=(env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory 'GIT_CONFIG_VALUE_0=*' git -C "${REPO_ROOT:-.}")
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] \
    || _v5_tg_die "v5_selfhost_load_runtime_image_pin_for_commit 要求 40-hex target SHA (got=${sha:-<empty>})"
  if ! "${g[@]}" cat-file -e "${sha}^{commit}" 2>/dev/null; then
    _v5_tg_die "runtime-image-pin 目标 commit 不存在: $sha"
  fi
  if ! "${g[@]}" cat-file -e "${sha}:deploy/v5/runtime-image-pin.json" 2>/dev/null; then
    RUNTIME_IMAGE="$V5_SELFHOST_DEFAULT_RUNTIME_IMAGE"
    RUNTIME_IMAGE_PIN_PREVIOUS=""
    RUNTIME_IMAGE_PIN_CLI_VERSIONS="{}"
    RUNTIME_IMAGE_PIN_SHA256=""
    RUNTIME_IMAGE_PIN_COMMIT="$sha"
    RUNTIME_IMAGE_PIN_SOURCE="fallback-default:${sha}"
    return 0
  fi
  local raw_err=""
  if ! parsed="$("${g[@]}" show "${sha}:deploy/v5/runtime-image-pin.json" | _v5_selfhost_parse_runtime_image_pin_json "${sha}:deploy/v5/runtime-image-pin.json" 2>&1)"; then
    _v5_tg_die "$parsed"
  fi
  IFS=$'\t' read -r img prev clis digest <<<"$parsed"
  RUNTIME_IMAGE="$img"
  RUNTIME_IMAGE_PIN_PREVIOUS="$prev"
  RUNTIME_IMAGE_PIN_CLI_VERSIONS="$clis"
  RUNTIME_IMAGE_PIN_SHA256="$digest"
  RUNTIME_IMAGE_PIN_COMMIT="$sha"
  RUNTIME_IMAGE_PIN_SOURCE="commit:${sha}:deploy/v5/runtime-image-pin.json"
}

# 显式单文件读取封装（仅供工具/单测直接校验特定文件；deploy 启动阶段绝不自动调用读脏工作树！）。
v5_selfhost_load_runtime_image_pin() {
  local pin_file="${OC_V5_RUNTIME_IMAGE_PIN_FILE:-${REPO_ROOT:-.}/deploy/v5/runtime-image-pin.json}"
  local parsed="" img="" prev="" clis="" digest=""
  if [[ ! -e "$pin_file" && ! -L "$pin_file" ]]; then
    RUNTIME_IMAGE="${RUNTIME_IMAGE:-$V5_SELFHOST_DEFAULT_RUNTIME_IMAGE}"
    RUNTIME_IMAGE_PIN_PREVIOUS=""
    RUNTIME_IMAGE_PIN_CLI_VERSIONS="{}"
    RUNTIME_IMAGE_PIN_SHA256=""
    RUNTIME_IMAGE_PIN_COMMIT=""
    RUNTIME_IMAGE_PIN_SOURCE="fallback-default"
    return 0
  fi
  [[ -f "$pin_file" && ! -L "$pin_file" ]] \
    || _v5_tg_die "runtime-image-pin 非普通文件或为符号链接，拒绝读取: $pin_file"
  if ! parsed="$(_v5_selfhost_parse_runtime_image_pin_json "$pin_file" <"$pin_file" 2>&1)"; then
    _v5_tg_die "$parsed"
  fi
  IFS=$'\t' read -r img prev clis digest <<<"$parsed"
  RUNTIME_IMAGE="$img"
  RUNTIME_IMAGE_PIN_PREVIOUS="$prev"
  RUNTIME_IMAGE_PIN_CLI_VERSIONS="$clis"
  RUNTIME_IMAGE_PIN_SHA256="$digest"
  RUNTIME_IMAGE_PIN_COMMIT=""
  RUNTIME_IMAGE_PIN_SOURCE="pin-file:$pin_file"
}

# ── 2. 宿主机 root 专属 Break-Glass 凭证校验 ───────────────────────────────
# 仅允许精确绑定 40-hex SHA 的宿主机普通文件，彻底杜绝环境变量绕过或符号链接伪造。
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

# 解析目标提交的对比基线（explicit > 已验证 live .complete 祖先 > ${sha}^）
_v5_selfhost_resolve_diff_base() { # <target-sha> [explicit-base]
  local sha="$1" base_ref="${2:-}" live_root="" live_sha=""
  local -a g=(env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory 'GIT_CONFIG_VALUE_0=*' git -C "$REPO_ROOT")
  if [[ -n "$base_ref" ]]; then
    printf '%s\n' "$base_ref"
    return 0
  fi
  if [[ -L "${MASTER_LIVE_LINK:-}" ]]; then
    live_root="$(readlink -f -- "$MASTER_LIVE_LINK" 2>/dev/null || true)"
    if [[ -n "$live_root" && -f "$live_root/.complete" ]]; then
      live_sha="$(jq -er '.sourceCommit // empty' "$live_root/.complete" 2>/dev/null || true)"
      if [[ "$live_sha" =~ ^[0-9a-f]{40}$ && "$live_sha" != "$sha" ]] \
        && "${g[@]}" merge-base --is-ancestor "$live_sha" "$sha" 2>/dev/null; then
        printf '%s\n' "$live_sha"
        return 0
      fi
    fi
  fi
  if "${g[@]}" rev-parse --verify --quiet "${sha}^^{commit}" >/dev/null 2>&1; then
    printf '%s\n' "${sha}^"
    return 0
  fi
  printf '\n'
}

# ── 3. 宿主 Governor 运行模式总闸 (control/mode.json) ─────────────────────
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
# - debt_first     : 校验 base..target_sha 区间内所有非合并提交不含 feat(...)，仅放行清债/修复提交
v5_selfhost_check_governor_mode() { # <target-sha> [base-ref]
  local sha="$1" base_ref="${2:-}" mode_line mode reason commits bad="" csha csubj
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
      base_ref="$(_v5_selfhost_resolve_diff_base "$sha" "$base_ref")"
      if [[ -n "$base_ref" ]]; then
        commits="$("${g[@]}" log --no-merges --format='%H%x09%s' "${base_ref}..${sha}" 2>/dev/null || true)"
      else
        commits="$("${g[@]}" log -1 --format='%H%x09%s' "$sha" 2>/dev/null || true)"
      fi
      if [[ -z "$commits" ]]; then
        commits="$("${g[@]}" log -1 --format='%H%x09%s' "$sha" 2>/dev/null || true)"
      fi
      local re_feat='^feat(\([^)]*\))?!?:'
      local re_allowed='^(bug|fix|refactor|chore|ci|docs|perf|test|revert)(\([^)]*\))?!?:[[:space:]]'
      while IFS=$'\t' read -r csha csubj; do
        [[ -n "$csha" ]] || continue
        if [[ "$csubj" =~ $re_feat ]] || [[ ! "$csubj" =~ $re_allowed ]]; then
          bad+="${bad:+$'\n'}  - ${csha:0:12} ${csubj}"
        fi
      done <<<"$commits"
      if [[ -n "$bad" ]]; then
        _v5_tg_die "宿主 Governor 处于 debt_first 模式(reason=${reason:-<未说明>})，禁止发车含新 feat 或非清债提交(仅放行 bug/fix/refactor/chore/ci/docs/perf/test/revert):
$bad
补救: 在 debt_first 期间仅合入清债/修复提交，或由宿主机 root 执行 oc-governor mode autonomous 解冻。"
      fi
      _v5_tg_log "  ✓ [governor] mode=debt_first 校验通过(${base_ref:+${base_ref:0:12}..}${sha:0:12} 全为清债/修复提交)"
      return 0
      ;;
  esac
}

# ── 4. B7 物理接入宿主 oc-governor check-blast-radius ──────────────────────
# 在正向切流前物理调用 ${OC_GOVERNOR_ROOT}/bin/oc-governor check-blast-radius，
# 强制拦截商业分支(feat/v5-aurora-rewrite)及无凭证破坏性 DDL / 计费核心变更！
v5_selfhost_check_blast_radius() { # <target-sha> [base-ref] [target-branch]
  local sha="$1" base_ref="${2:-}" branch="${3:-}"
  local gov_bin="${OC_V5_GOVERNOR_BIN:-$(v5_selfhost_governor_root)/bin/oc-governor}"
  local -a g=(env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory 'GIT_CONFIG_VALUE_0=*' git -C "$REPO_ROOT")
  if [[ "${CUTOVER_ROLLBACK:-0}" == 1 ]]; then
    _v5_tg_log "  ⚠ [blast-radius] --rollback 模式放行应急回滚"
    return 0
  fi
  if [[ ! -x "$gov_bin" ]]; then
    if [[ "${OC_V5_BLAST_RADIUS_REQUIRED:-0}" == 1 ]]; then
      _v5_tg_die "[blast-radius] OC_V5_BLAST_RADIUS_REQUIRED=1 但缺少可执行 $gov_bin (fail-closed)"
    fi
    _v5_tg_log "  · [blast-radius] 未安装可执行 $gov_bin，跳过物理爆破半径校验"
    return 0
  fi
  if [[ -z "$branch" ]]; then
    branch="${OC_V5_TARGET_BRANCH:-}"
  fi
  if [[ -z "$branch" ]]; then
    branch="$("${g[@]}" symbolic-ref -q --short HEAD 2>/dev/null || true)"
  fi
  [[ -n "$branch" ]] || branch="feat/v5-selfhost"

  base_ref="$(_v5_selfhost_resolve_diff_base "$sha" "$base_ref")"
  local -a changed_files=()
  local f=""
  if [[ -n "$base_ref" ]]; then
    while IFS= read -r f; do
      [[ -n "$f" ]] && changed_files+=("$f")
    done < <("${g[@]}" diff --name-only "${base_ref}...${sha}" 2>/dev/null || true)
  else
    while IFS= read -r f; do
      [[ -n "$f" ]] && changed_files+=("$f")
    done < <("${g[@]}" show --pretty="" --name-only "$sha" 2>/dev/null || true)
  fi

  # 若存在 pinned candidate release 目录，用其作为 --repo-root 确保 SQL 扫描读的是精确候选提交内容而非脏工作树
  local scan_root="${CUTOVER_REL:-}"
  local tmp_sql_root=""
  if [[ -z "$scan_root" || ! -d "$scan_root" ]]; then
    # 从目标 commit 导出变更的 .sql 文件到临时目录，彻底防止脏工作树 SQL 掩盖目标提交里的破坏性 DDL
    local has_sql=0
    for f in "${changed_files[@]}"; do
      if [[ "$f" == *.sql || "$f" == */migrations/* ]]; then has_sql=1; break; fi
    done
    if [[ "$has_sql" == 1 ]]; then
      tmp_sql_root="$(mktemp -d "${TMPDIR:-/tmp}/oc-blast-sql.XXXXXX")"
      for f in "${changed_files[@]}"; do
        if [[ "$f" == *.sql || "$f" == */migrations/* ]] && "${g[@]}" cat-file -e "${sha}:${f}" 2>/dev/null; then
          mkdir -p "$tmp_sql_root/$(dirname -- "$f")"
          "${g[@]}" show "${sha}:${f}" >"$tmp_sql_root/$f"
        fi
      done
      scan_root="$tmp_sql_root"
    else
      scan_root="$REPO_ROOT"
    fi
  fi

  local -a args=(check-blast-radius --branch "$branch" --repo-root "$scan_root")
  if [[ -n "${OC_V5_BLAST_VOUCHER:-}" ]]; then
    args+=(--voucher "$OC_V5_BLAST_VOUCHER")
  fi
  if (( ${#changed_files[@]} > 0 )); then
    args+=(--files "${changed_files[@]}")
  fi

  local out="" rc=0
  out="$(OC_GOVERNOR_ROOT="$(v5_selfhost_governor_root)" "$gov_bin" "${args[@]}" 2>&1)" || rc=$?
  if [[ -n "$tmp_sql_root" && -d "$tmp_sql_root" ]]; then
    rm -rf -- "$tmp_sql_root"
  fi
  if (( rc != 0 )); then
    _v5_tg_die "[blast-radius] 宿主 oc-governor 拒绝正向切流 (branch=$branch, sha=${sha:0:12}, files=${#changed_files[@]}):
$out
补救: 禁止触碰商业分支 feat/v5-aurora-rewrite；若涉及破坏性 DDL 或计费核心变更，须由宿主机 root 签发凭证 oc-governor issue-blast-voucher 并通过 OC_V5_BLAST_VOUCHER 传入。"
  fi
  tsum_note blastRadius "passed:${branch}:${#changed_files[@]}" 2>/dev/null || :
  _v5_tg_log "  ✓ [blast-radius] oc-governor 校验通过 (branch=$branch, files=${#changed_files[@]})"
}

# ── 5. 发车/切流前置可信 CI 事件绿灯硬门 (B5 / B7 / Non-blocker 2) ───────────
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

# 校验目标 SHA 在 GitHub Actions 的全部必需 workflow 均为 completed/success，
# 且严格只认受信任事件 (push / pull_request / merge_group)，拒绝 workflow_dispatch 绕过！
# 默认必需清单：V5 selfhost gates, V5 selfhost release gates, V5 selfhost commercial（精确核验权威 workflow 路径）。
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
  _v5_tg_log "── 发车/切流前置可信 CI 绿灯硬门(sha=${sha:0:12}, repo=$gh_repo, workflows=$req_csv) ──"
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

TRUSTED_EVENTS = {"push", "pull_request", "merge_group"}
CANONICAL_PATHS = {
    "V5 selfhost gates": ".github/workflows/v5-selfhost-gates.yml",
    "V5 selfhost release gates": ".github/workflows/v5-selfhost-release-gates.yml",
    "V5 selfhost commercial": ".github/workflows/v5-selfhost-commercial.yml",
}

def matches_req(run: dict, spec: str) -> bool:
    r_path = str(run.get("path") or "").strip()
    r_name = str(run.get("name") or "").strip()
    r_wfid = str(run.get("workflow_id") or "").strip()
    if spec.isdigit():
        return r_wfid == spec
    if spec.startswith(".github/workflows/"):
        return r_path == spec
    if r_name != spec:
        return False
    expected_path = CANONICAL_PATHS.get(spec)
    if expected_path and r_path and r_path != expected_path:
        return False
    return True

trusted_best: dict[str, tuple[tuple[str, int], dict]] = {}
untrusted_seen: dict[str, set[str]] = {}
for r in runs:
    if not isinstance(r, dict):
        continue
    r_sha = r.get("head_sha")
    if r_sha and r_sha != sha:
        continue
    event = str(r.get("event") or "").strip()
    key = (str(r.get("created_at") or ""), int(r.get("id") or 0))
    for spec in required:
        if not matches_req(r, spec):
            continue
        if event not in TRUSTED_EVENTS:
            untrusted_seen.setdefault(spec, set()).add(event or "unknown")
            continue
        prev = trusted_best.get(spec)
        if prev is None or key > prev[0]:
            trusted_best[spec] = (key, r)

failed = []
passed = []
for wf in required:
    entry = trusted_best.get(wf)
    if entry is None:
        if wf in untrusted_seen:
            failed.append(
                f"  - {wf}: rejected untrusted event(s)={','.join(sorted(untrusted_seen[wf]))} (only push/pull_request/merge_group allowed)"
            )
        else:
            failed.append(f"  - {wf}: missing trusted-event GitHub Actions run for {sha[:12]}")
        continue
    r = entry[1]
    st = str(r.get("status") or "unknown")
    conc = str(r.get("conclusion") or "none")
    ev = str(r.get("event") or "unknown")
    url = str(r.get("html_url") or "")
    if st == "completed" and conc == "success":
        passed.append(f"{wf}=completed/success({ev})")
    else:
        failed.append(f"  - {wf}: status={st} conclusion={conc} event={ev}{(' ' + url) if url else ''}")

if failed:
    sys.stdout.write("\n".join(failed) + "\n")
    sys.exit(1)
sys.stdout.write(", ".join(passed) + "\n")
PY
  )"; then
    _v5_tg_die "发车/切流前置可信 CI 绿灯硬门拒绝发布 (sha=${sha:0:12}):
$report
补救: 等待 GitHub Actions 全部必需 workflow 由 push/pull_request/merge_group 触发并变为 completed/success（禁止 workflow_dispatch 绕过）；
仅限紧急止血: 由宿主机 root 写原因至 $(v5_selfhost_governor_control_dir)/ci-breakglass-${sha}"
  fi
  tsum_note ciGreen "passed:${sha:0:12}" 2>/dev/null || :
  _v5_tg_log "  ✓ [ci-green] 全部必需可信 workflow 绿灯: $report"
}

# ── 6. B6 切流前保留集 runner 预检（改 live 之前 fail-closed！）────────────
v5_selfhost_retention_runner_path() {
  printf '%s\n' "${OC_V5_RETENTION_RUNNER:-$(v5_selfhost_governor_root)/run-retention.sh}"
}

v5_selfhost_preflight_retention_runner() {
  local runner="" uid="" mode=""
  if [[ "${CUTOVER_ROLLBACK:-0}" == 1 || "${DRY:-0}" == 1 ]]; then
    return 0
  fi
  if [[ "${OC_V5_RETENTION_ENABLED:-1}" == 0 ]]; then
    _v5_tg_log "  · [retention-preflight] OC_V5_RETENTION_ENABLED=0，已显式关闭切流后置保留集"
    return 0
  fi
  runner="$(v5_selfhost_retention_runner_path)"
  if [[ -L "$runner" || ! -f "$runner" || ! -x "$runner" ]]; then
    _v5_tg_die "[retention-preflight] 切流前预检失败(live 未改动): 缺少可执行普通文件 $runner（禁止缺失时静默当作成功跳过！）"
  fi
  if [[ "$(id -u)" == 0 && "$runner" == /opt/openclaude/* ]] || [[ "${OC_V5_RETENTION_REQUIRE_ROOT:-0}" == 1 ]]; then
    read -r uid mode < <(stat -Lc '%u %a' -- "$runner" 2>/dev/null || echo '999999 777')
    if [[ "$uid" != 0 ]] || (( (8#$mode & 8#022) != 0 )); then
      _v5_tg_die "[retention-preflight] retention runner 属主/权限不可信(uid=$uid mode=$mode): $runner"
    fi
  fi
  _v5_tg_log "  ✓ [retention-preflight] 切流前保留集 runner 就绪: $runner"
}

# ── 7. B7 统一共同正向切流护栏边界 ──────────────────────────────────────────
# 在持 deploy.lock 且尚未修改 live 之前，由 cmd_deploy 与独立正向 cmd_cutover 共同强制调用！
# 仅已验证回滚血缘 (CUTOVER_ROLLBACK=1) 走应急豁免。
v5_selfhost_enforce_forward_cutover_guards() { # <target-sha> [base-ref] [target-branch]
  local sha="$1" base_ref="${2:-}" branch="${3:-}"
  if [[ "${CUTOVER_ROLLBACK:-0}" == 1 ]]; then
    _v5_tg_log "  ⚠ [forward-guards] --rollback 已验证回滚血缘，放行应急回滚豁免 (${sha:0:12})"
    return 0
  fi
  v5_selfhost_check_governor_mode "$sha" "$base_ref"
  v5_selfhost_check_blast_radius "$sha" "$base_ref" "$branch"
  v5_selfhost_verify_ci_green "$sha"
  v5_selfhost_preflight_retention_runner
}

# ── 8. Incident Trailer 物理豁免校验 ────────────────────────────────────────
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

# ── 9. B6 切流后置保留集硬门（移入 committed 之前！+ 真回滚终态校验与 recovery_required）──
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
    local gov_root_eff=""
    gov_root_eff="$(v5_selfhost_governor_root)"
    if OC_GOVERNOR_ROOT="$gov_root_eff" "$gov_bin" trip-breaker --train "$train_id" --reason "$reason" >&2 2>/dev/null; then
      _v5_tg_log "  ✓ [governor] 已通知 $gov_bin trip-breaker (train=$train_id)"
      return 0
    fi
    if OC_GOVERNOR_ROOT="$gov_root_eff" "$gov_bin" record-rollback --train "$train_id" --reason "$reason" >&2 2>/dev/null; then
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
  env -u LEASE_TRAIN_ID -u OC_V5_LEASE_TRAIN_ID \
    OC_V5_RETENTION_INTERNAL_ROLLBACK=1 \
    OC_V5_SELFHOST_DEPLOY_LOCK_HELD="${OC_V5_SELFHOST_DEPLOY_LOCK_HELD:-1}" \
    "$SCRIPT_DIR/deploy-v5-selfhost.sh" --rollback
}

# 校验官方回滚后 live 确实回到了上一健康版本（live symlink == expected_prev 且非 failed_rel 且健康检查 200）。
v5_selfhost_verify_rollback_live() { # <expected-prev-rel> <failed-rel> <healthz-url>
  local expected_prev="$1" failed_rel="$2" healthz_url="$3"
  local live_now="" prev_canon="" failed_canon="" code=""
  if [[ -z "$expected_prev" || "$expected_prev" == "none" ]]; then
    _v5_tg_log "✗ [retention-rollback-verify] 缺少可验证的上一健康版本路径 (expected_prev=${expected_prev:-<empty>})"
    return 1
  fi
  prev_canon="$(readlink -f -- "$expected_prev" 2>/dev/null || true)"
  failed_canon="$(readlink -f -- "$failed_rel" 2>/dev/null || true)"
  live_now="$(readlink -f -- "${MASTER_LIVE_LINK:-}" 2>/dev/null || true)"
  if [[ -z "$prev_canon" || -z "$live_now" || "$live_now" != "$prev_canon" ]]; then
    _v5_tg_log "✗ [retention-rollback-verify] live 未回到上一版本 (got=${live_now:-<empty>}, want=${prev_canon:-$expected_prev})"
    return 1
  fi
  if [[ -n "$failed_canon" && "$live_now" == "$failed_canon" ]]; then
    _v5_tg_log "✗ [retention-rollback-verify] live 仍指向失败版本: $live_now"
    return 1
  fi
  if [[ -n "${OC_V5_RETENTION_ROLLBACK_VERIFY_CMD:-}" ]]; then
    bash -c "$OC_V5_RETENTION_ROLLBACK_VERIFY_CMD" -- "$live_now" "$prev_canon" "$failed_rel"
    return $?
  fi
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "$healthz_url" 2>/dev/null || true)"
  if [[ "$code" != 200 ]]; then
    _v5_tg_log "✗ [retention-rollback-verify] 回滚后旧 live 健康检查未返回 200 ($healthz_url -> ${code:-err})"
    return 1
  fi
  return 0
}

# B6 核心切流后置保留集门（在 cmd_cutover 内、smoke 通过之后、写 committed / disarm survivor / resolve forward 之前执行！）：
# - 运行期间保持 survivor phase=verifying 与 train 非 committed（policy 模式保持 unresolved.json 占位），
#   保证 v5-lease-worker.sh 即使在 retention 运行期间 tick 也绝不会提前结算 ride 为 satisfied！
# - 目标 /healthz 200 且 run-retention.sh exit 0 → 返回 0，由调用方 finalize committed + resolve forward；
# - 任一失败 → 立即调用官方 --rollback 并验证 live 真实回到上一健康版本：
#   * 回滚成功且旧 live 健康 → 原 train 原子标为 failed（绝非 committed！），调用 oc-governor 熔断，返回非零；
#   * 回滚失败或旧 live 不健康 → 置 CUTOVER_RECOVERY_REQUIRED=1 + phase=compensate-failed + 原 train 转入 recovery_required（暂停一切正向发车）并告警，返回 79！
v5_selfhost_post_cutover_retention_gate() { # <release-path> <40-hex-sha>
  local rel="$1" sha="$2"
  local runner="" settle_sec="${OC_V5_RETENTION_SETTLE_SEC:-5}"
  local attempts="${OC_V5_RETENTION_HEALTHZ_ATTEMPTS:-15}"
  local interval="${OC_V5_RETENTION_HEALTHZ_INTERVAL_SEC:-2}"
  local timeout_sec="${OC_V5_RETENTION_TIMEOUT_SEC:-420}"
  local healthz_url="${OC_V5_RETENTION_HEALTHZ_URL:-http://127.0.0.1:${V5_PORT:-18790}/healthz}"
  local i code="" hz_ok=0 rc=0 rb_rc=0 verify_rc=0
  local train_id="${LEASE_TRAIN_ID:-manual-$$}" prev_live="${CUTOVER_PREV_LIVE:-}"

  if [[ "${DRY:-0}" == 1 ]]; then
    _v5_tg_log "  [dry-run] 切流后置行为保留集(committed 前, phase=verifying): 等 ${settle_sec}s + /healthz 200 → $(v5_selfhost_retention_runner_path)"
    return 0
  fi
  if [[ "${CUTOVER_ROLLBACK:-0}" == 1 ]]; then
    return 0
  fi
  if [[ "${OC_V5_RETENTION_ENABLED:-1}" == 0 ]]; then
    _v5_tg_log "  · [post-cutover-retention] OC_V5_RETENTION_ENABLED=0，跳过切流后置保留集"
    return 0
  fi

  v5_selfhost_preflight_retention_runner
  runner="$(v5_selfhost_retention_runner_path)"

  # 1. 进入持久化、不可结算为 satisfied 的 verifying 状态（绝不在 retention 通过前写 committed / resolve forward！）
  CUTOVER_PHASE="verifying"
  if declare -F cutover_persist_phase >/dev/null 2>&1; then
    cutover_persist_phase "verifying" \
      || { _v5_tg_log "✗ [post-cutover-retention] 无法持久化 phase=verifying"; return 79; }
  elif [[ -n "${SURVIVOR_STATE:-}" ]]; then
    mkdir -p -- "$(dirname -- "$SURVIVOR_STATE")"
    printf 'phase=verifying\nexecutor_pid=%s\n' "$$" >"$SURVIVOR_STATE"
  fi
  if declare -F lease_train_mark_verifying >/dev/null 2>&1; then
    lease_train_mark_verifying "$rel" || true
  fi

  _v5_tg_log "── 切流后置行为保留集硬门(phase=verifying, committed 前; runner=$runner, settle=${settle_sec}s, sha=${sha:0:12}) ──"
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
    _v5_tg_log "  ✓ [post-cutover-retention] 行为保留集全部 PASS，放行 finalize committed"
    return 0
  fi

  # 2. Retention 失败：绝不写 committed！立即执行官方 --rollback 并验证旧 live 健康
  tsum_note retentionGate "failed:rc=$rc" 2>/dev/null || :
  _v5_tg_log "✗ [post-cutover-retention] 行为保留集 FAIL (rc=$rc) @ $rel → 立即触发官方自动回滚并核验旧 live！"
  if [[ -z "$prev_live" || "$prev_live" == "none" ]] && [[ -n "${MASTER_RELEASES_ROOT:-}" && -f "$MASTER_RELEASES_ROOT/.prev-release" ]]; then
    prev_live="$(tr -d '[:space:]' <"$MASTER_RELEASES_ROOT/.prev-release" 2>/dev/null || true)"
  fi

  v5_selfhost_trigger_official_rollback "$rel" "$sha" "$rc" || rb_rc=$?
  if (( rb_rc == 0 )); then
    v5_selfhost_verify_rollback_live "$prev_live" "$rel" "$healthz_url" || verify_rc=$?
  else
    verify_rc=1
  fi

  if (( rb_rc == 0 && verify_rc == 0 )); then
    # 回滚成功且旧 live 健康 → 原 train 原子标为 failed（绝非 committed！），调用 oc-governor 熔断
    CUTOVER_RECOVERY_REQUIRED=0
    CUTOVER_PHASE="rolled-back"
    if declare -F cutover_persist_phase >/dev/null 2>&1; then
      cutover_persist_phase "rolled-back" || true
    fi
    if declare -F cutover_disarm_survivor >/dev/null 2>&1; then
      cutover_disarm_survivor || true
    fi
    if declare -F lease_train_finish >/dev/null 2>&1; then
      lease_train_finish failed "post-cutover retention gate failed (rc=$rc); official rollback verified live=$prev_live" || true
    fi
    if declare -F release_policy_enabled >/dev/null 2>&1 && release_policy_enabled \
      && declare -F release_policy_context_present >/dev/null 2>&1 && release_policy_context_present; then
      local before_digest=""
      if declare -F release_policy_probe_stack >/dev/null 2>&1 \
        && before_digest="$(release_policy_probe_stack before 2>/dev/null)" \
        && release_policy_py verify-resolution before "$before_digest" >/dev/null 2>&1; then
        release_policy_py resolve compensated >/dev/null 2>&1 || true
      fi
    fi
    v5_selfhost_notify_governor_breaker "$train_id" "retention-gate-failed:rc=$rc:sha=${sha:0:12}:rollback=verified" || true
    if declare -F deploy_alert >/dev/null 2>&1; then
      deploy_alert post_cutover_retention_rollback "$rel" \
        "切流后置行为保留集 FAIL (rc=$rc, sha=${sha:0:12})，已自动官方回滚并核验恢复至 $prev_live（原列车终态=failed，已通知熔断器）。"
    fi
    _v5_tg_log "✗ 切流后置行为保留集 FAIL (rc=$rc, sha=${sha:0:12}): 官方回滚已验证恢复至 $prev_live，原列车已标 failed"
    return 1
  fi

  # 回滚失败或旧 live 不健康 → 原 train 转入 recovery_required，暂停所有正向切流并告警！
  CUTOVER_RECOVERY_REQUIRED=1
  CUTOVER_PHASE="compensate-failed"
  if declare -F cutover_disarm_survivor >/dev/null 2>&1; then
    cutover_disarm_survivor || true
  fi
  if declare -F cutover_persist_phase >/dev/null 2>&1; then
    cutover_persist_phase "compensate-failed" || true
  elif [[ -n "${SURVIVOR_STATE:-}" ]]; then
    mkdir -p -- "$(dirname -- "$SURVIVOR_STATE")"
    printf 'phase=compensate-failed\nexecutor_pid=%s\n' "$$" >"$SURVIVOR_STATE"
  fi
  if [[ -n "${MASTER_RELEASES_ROOT:-}" && -d "$MASTER_RELEASES_ROOT" && -w "$MASTER_RELEASES_ROOT" ]]; then
    printf 'reason=retention-rollback-failed\nret_rc=%s\nrollback_rc=%s\nverify_rc=%s\nsha=%s\nwritten=%s\n' \
      "$rc" "$rb_rc" "$verify_rc" "$sha" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      >"$MASTER_RELEASES_ROOT/.manual-recovery-required" 2>/dev/null || true
  fi
  if declare -F lease_train_finish >/dev/null 2>&1; then
    lease_train_finish failed "post-cutover retention failed (rc=$rc) and rollback failed/unhealthy (rb_rc=$rb_rc verify_rc=$verify_rc); recovery_required" || true
  fi
  v5_selfhost_notify_governor_breaker "$train_id" "retention-rollback-failed:rc=$rc:rb_rc=$rb_rc:verify_rc=$verify_rc:sha=${sha:0:12}" || true
  if declare -F deploy_alert >/dev/null 2>&1; then
    deploy_alert deploy_recovery_required "$rel" \
      "切流后置行为保留集 FAIL (rc=$rc, sha=${sha:0:12}) 且官方回滚失败/旧 live 不健康 (rb_rc=$rb_rc, verify_rc=$verify_rc)，原列车已转入 recovery_required 并暂停一切正向切流！"
  fi
  _v5_tg_log "✗ 切流后置行为保留集 FAIL 且回滚失败/旧 live 不健康 (ret_rc=$rc rb_rc=$rb_rc verify_rc=$verify_rc): 已转入 recovery_required"
  return 79
}
