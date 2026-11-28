#!/usr/bin/env bash
# oc-governor.sh — Host Physical 4-Gate Governance Control Plane (OCV5-906 / OCV5-903 B2 & B3).
#
# Physical Gates:
#   1. Global Operating Mode   : mode [show | autonomous | debt_first | emergency_stop] --reason "..."
#   2. A0 Relaxation Seal      : approve-a0 / revoke-a0 / verify-a0 (--sha <40hex>)
#                                Byte-level parity with scripts/lib/a0ApprovalReceipt.ts:
#                                trimmed reason (>=8), canonical allowedPaths binding,
#                                optional root-only 0600 ${ROOT}/control/.hmac-key (no downgrade),
#                                strict root-owner/non-symlink/non-writable checks, and
#                                optional --publish-github-status (oc-v5/a0-approval).
#   3. Blast-Radius Hard-Lock  : check-blast-radius --branch <br> --files <...> [--voucher <path>]
#                                issue-blast-voucher --scope <ddl|billing> --files <...> --reason "..."
#   4. Dual Circuit Breaker    : record-rollback / trip-breaker / check-cost-breaker / unlock-breaker
#   Overview                   : status
set -Eeuo pipefail

GOV_ROOT="${OC_GOVERNOR_ROOT:-/opt/openclaude/harness-gate}"
CTRL_DIR="$GOV_ROOT/control"
APPROVALS_DIR="$CTRL_DIR/a0-approvals"
VOUCHERS_DIR="$CTRL_DIR/blast-vouchers"
PENDING_APPROVALS_DIR="$CTRL_DIR/pending-approvals"
PENDING_LOCKS_DIR="$PENDING_APPROVALS_DIR/.locks"
STEWARD_RECEIPTS_DIR="$GOV_ROOT/steward-receipts"
HMAC_KEY_FILE="$CTRL_DIR/.hmac-key"
MODE_FILE="$CTRL_DIR/mode.json"
AUDIT_FILE="$CTRL_DIR/audit.jsonl"
ROLLBACKS_FILE="$CTRL_DIR/rollbacks.jsonl"
BREAKER_FILE="$CTRL_DIR/breaker.json"
COST_BREAKER_FILE="$CTRL_DIR/cost-breaker.json"
BREAKER_CARD_FILE="$CTRL_DIR/breaker-card.md"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die_usage() { echo "✗ [oc-governor] $*" >&2; exit 2; }
die_gate() { echo "✗ [oc-governor] $*" >&2; exit 1; }
ensure_dirs() { mkdir -p "$CTRL_DIR" "$APPROVALS_DIR" "$VOUCHERS_DIR" "$PENDING_APPROVALS_DIR" "$PENDING_LOCKS_DIR"; }
actor_name() { id -un 2>/dev/null || echo "unknown"; }
now_iso() { [[ -n "${OC_GOVERNOR_NOW_ISO:-}" ]] && printf '%s\n' "$OC_GOVERNOR_NOW_ISO" || date -u +%Y-%m-%dT%H:%M:%SZ; }

append_audit_safe() {
  local payload="$1"
  if [[ -d "$CTRL_DIR" && -w "$CTRL_DIR" ]] || mkdir -p "$CTRL_DIR" 2>/dev/null; then
    if [[ ! -e "$AUDIT_FILE" || -w "$AUDIT_FILE" ]]; then
      printf '%s\n' "$payload" >>"$AUDIT_FILE" 2>/dev/null || true
      chmod 0644 "$AUDIT_FILE" 2>/dev/null || true
    fi
  fi
}

atomic_write_file() {
  local dest="$1" content="$2" mode="${3:-0644}" tmp="${1}.tmp.$$.${RANDOM}"
  mkdir -p "$(dirname "$dest")"
  printf '%s\n' "$content" >"$tmp"; chmod "$mode" "$tmp"; mv -f "$tmp" "$dest"
}

_assert_safe_dir_chain() {
  local skip_owner="${OC_GOVERNOR_UNSAFE_TEST_SKIP_OWNER:-0}"
  python3 - "$GOV_ROOT" "$CTRL_DIR" "$PENDING_APPROVALS_DIR" "$PENDING_LOCKS_DIR" "$skip_owner" <<'PY'
import os, stat, sys
gov_root, ctrl_dir, pending_dir, locks_dir, skip_owner_s = sys.argv[1:]
skip_owner = skip_owner_s == "1"
for d in (gov_root, ctrl_dir, pending_dir, locks_dir):
    if not os.path.lexists(d): continue
    st = os.lstat(d)
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode):
        sys.stderr.write(f"UNSAFE_CONTROL_DIR: symlink or non-directory in control chain: {d}\n"); sys.exit(1)
    if not skip_owner and os.geteuid() == 0 and d.startswith("/opt/openclaude/") and (st.st_uid != 0 or (st.st_mode & 0o022) != 0):
        sys.stderr.write(f"UNSAFE_CONTROL_DIR: untrusted owner/mode on {d} (uid={st.st_uid} mode={oct(st.st_mode & 0o777)})\n"); sys.exit(1)
PY
}

_resolve_steward_verifier_path() {
  [[ -n "${OC_GOVERNOR_STEWARD_VERIFIER:-}" ]] && { printf '%s\n' "$OC_GOVERNOR_STEWARD_VERIFIER"; return 0; }
  [[ -f "$GOV_ROOT/referee/scripts/lib/archStewardReceipt.ts" && ! -L "$GOV_ROOT/referee/scripts/lib/archStewardReceipt.ts" ]] && { printf '%s\n' "$GOV_ROOT/referee/scripts/lib/archStewardReceipt.ts"; return 0; }
  [[ -f "$SCRIPT_DIR/../lib/archStewardReceipt.ts" && ! -L "$SCRIPT_DIR/../lib/archStewardReceipt.ts" ]] && { printf '%s\n' "$SCRIPT_DIR/../lib/archStewardReceipt.ts"; return 0; }
  return 1
}

_resolve_trusted_node_modules_dir() {
  local verifier_path="${1:-}" candidate=""
  [[ -d "$GOV_ROOT/referee/node_modules" ]] && { printf '%s\n' "$GOV_ROOT/referee/node_modules"; return 0; }
  if [[ -n "$verifier_path" ]]; then
    candidate="$(cd "$(dirname "$verifier_path")/../.." 2>/dev/null && pwd)/node_modules"
    [[ -d "$candidate" ]] && { printf '%s\n' "$candidate"; return 0; }
  fi
  [[ -d "/opt/openclaude/node_modules" ]] && { printf '%s\n' "/opt/openclaude/node_modules"; return 0; }
  return 1
}

_verify_steward_receipt_authoritative() { # <40hex-sha> [40hex-base-sha]
  local sha="$1" base_sha="${2:-}" skip_owner="${OC_GOVERNOR_UNSAFE_TEST_SKIP_OWNER:-0}"
  local receipt_path="$STEWARD_RECEIPTS_DIR/${sha}.json"
  if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
    printf '{"present":false,"ok":false,"verdict":"missing","hmacVerified":false,"reason":"missing_sha"}\n'
    return 0
  fi

  local pre_out="" pre_rc=0
  set +e
  pre_out="$(python3 - "$GOV_ROOT" "$CTRL_DIR" "$STEWARD_RECEIPTS_DIR" "$receipt_path" "$HMAC_KEY_FILE" "$skip_owner" <<'PY'
import json, os, stat, sys
gov_root, ctrl_dir, receipts_dir, receipt_path, hmac_path, skip_owner_s = sys.argv[1:]
skip_owner = skip_owner_s == "1"
def emit(present, verdict, reason, summary):
    print(json.dumps({"present": present, "ok": False, "verdict": verdict, "hmacVerified": False, "reason": reason, "summary": summary}, ensure_ascii=False))
    sys.exit(10)
for d in (gov_root, ctrl_dir, receipts_dir):
    if os.path.lexists(d):
        st = os.lstat(d)
        if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode):
            emit(False, "invalid", "untrusted_dir_symlink", f"控制或签收目录存在符号链接: {d}")
if not os.path.lexists(receipt_path):
    emit(False, "missing", "steward_receipt_missing", "暂无跨家族独立审计签收，请谨慎核查")
try: rst = os.lstat(receipt_path)
except OSError: emit(True, "invalid", "steward_receipt_stat_failed", "审计签收文件无法访问")
if stat.S_ISLNK(rst.st_mode) or not stat.S_ISREG(rst.st_mode): emit(True, "invalid", "steward_receipt_symlink", "审计签收必须为普通文件（禁止符号链接）")
if (rst.st_mode & 0o022) != 0: emit(True, "invalid", "steward_receipt_writable", "审计签收权限不安全（禁止组/全局可写）")
if not skip_owner and os.geteuid() == 0 and receipt_path.startswith("/opt/openclaude/") and rst.st_uid != 0:
    emit(True, "invalid", "steward_receipt_not_root", "审计签收属主非 root")
# B2: Mandatory .hmac-key — ZERO downgrade to plain sha256!
if not os.path.lexists(hmac_path): emit(True, "invalid", "hmac_key_missing", "宿主机未配置 .hmac-key，拒绝降级为明文 sha256 审计签收")
try: kst = os.lstat(hmac_path)
except OSError: emit(True, "invalid", "hmac_key_stat_failed", "HMAC 密钥文件无法访问")
if stat.S_ISLNK(kst.st_mode) or not stat.S_ISREG(kst.st_mode): emit(True, "invalid", "hmac_key_symlink", "HMAC 密钥必须为普通文件（禁止符号链接）")
if (kst.st_mode & 0o077) != 0: emit(True, "invalid", "hmac_key_insecure_perms", "HMAC 密钥权限不安全（须为 0600/0400）")
if not skip_owner and os.geteuid() == 0 and hmac_path.startswith("/opt/openclaude/") and kst.st_uid != 0:
    emit(True, "invalid", "hmac_key_not_root", "HMAC 密钥属主非 root")
try: key_str = open(hmac_path, encoding="utf-8").read().strip()
except OSError: emit(True, "invalid", "hmac_key_unreadable", "HMAC 密钥文件不可读")
if not key_str: emit(True, "invalid", "hmac_key_empty", "HMAC 密钥文件为空，拒绝放行")
print("OK")
PY
)"
  pre_rc=$?
  set -e
  if [[ "$pre_rc" -ne 0 ]]; then printf '%s\n' "$pre_out"; return 0; fi

  local verifier_path="" nm_dir="" tsx_cli=""
  verifier_path="$(_resolve_steward_verifier_path || true)"
  if [[ -z "$verifier_path" || ! -e "$verifier_path" ]]; then
    printf '{"present":true,"ok":false,"verdict":"invalid","hmacVerified":false,"reason":"steward_verifier_missing","summary":"缺少宿主可信权威 Steward 校验器，按 fail-closed 拦截"}\n'; return 0
  fi
  if [[ -x "$verifier_path" && "$verifier_path" != *.ts && "$verifier_path" != *.mjs && "$verifier_path" != *.js ]]; then
    local hook_out="" hook_rc=0
    set +e; hook_out="$(env -u NODE_OPTIONS -u NODE_PATH -u TSX_TSCONFIG_PATH "$verifier_path" "$receipt_path" "$sha" "$base_sha" "$HMAC_KEY_FILE" 2>/dev/null)"; hook_rc=$?; set -e
    [[ "$hook_rc" -eq 0 && "$hook_out" == \{* ]] && { printf '%s\n' "$hook_out"; return 0; }
    printf '{"present":true,"ok":false,"verdict":"invalid","hmacVerified":false,"reason":"steward_verifier_hook_failed","summary":"权威 Steward 校验器执行失败"}\n'; return 0
  fi
  nm_dir="$(_resolve_trusted_node_modules_dir "$verifier_path" || true)"
  if [[ -n "$nm_dir" && -f "$nm_dir/tsx/dist/cli.mjs" ]]; then tsx_cli="$nm_dir/tsx/dist/cli.mjs"
  elif [[ -f "/opt/openclaude/node_modules/tsx/dist/cli.mjs" ]]; then tsx_cli="/opt/openclaude/node_modules/tsx/dist/cli.mjs"; fi
  if [[ -z "$tsx_cli" ]]; then
    printf '{"present":true,"ok":false,"verdict":"invalid","hmacVerified":false,"reason":"steward_tsx_missing","summary":"缺少宿主可信 tsx 运行时，无法执行权威 Steward 校验"}\n'; return 0
  fi

  local node_out="" node_rc=0
  set +e
  node_out="$(env -u NODE_OPTIONS -u NODE_PATH -u TSX_TSCONFIG_PATH node "$tsx_cli" -e '
const { readFileSync } = require("node:fs");
const { pathToFileURL } = require("node:url");
(async () => {
  const [verifierPath, receiptPath, headSha, baseSha, hmacKeyPath] = process.argv.slice(1);
  let raw;
  try { raw = JSON.parse(readFileSync(receiptPath, "utf8")); }
  catch { console.log(JSON.stringify({ present: true, ok: false, verdict: "invalid", hmacVerified: false, reason: "invalid_json", summary: "审计签收 JSON 损坏" })); return; }
  const mod = await import(pathToFileURL(verifierPath).href);
  const verifyFn = mod.verifyArchStewardReceipt ?? mod.verifyStewardReceipt;
  if (typeof verifyFn !== "function") { console.log(JSON.stringify({ present: true, ok: false, verdict: "invalid", hmacVerified: false, reason: "missing_verify_fn", summary: "权威校验器缺少校验函数" })); return; }
  const hmacKey = readFileSync(hmacKeyPath, "utf8").trim();
  const opts = { headSha, hmacKey, requireHmac: true };
  if (baseSha && /^[0-9a-f]{40}$/i.test(baseSha)) opts.baseSha = baseSha;
  const res = verifyFn(raw, opts);
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const meta = {};
  for (const k of ["authorFamily", "stewardFamily", "stewardModel"]) { if (typeof obj[k] === "string" && obj[k].trim()) meta[k] = obj[k].trim(); }
  const ue = obj.usageEvidence && typeof obj.usageEvidence === "object" ? obj.usageEvidence : null;
  if (ue && typeof ue.timestamp === "string" && ue.timestamp.trim()) meta.recordedAt = ue.timestamp.trim();
  else if (typeof obj.recordedAt === "string" && obj.recordedAt.trim()) meta.recordedAt = obj.recordedAt.trim();
  const hasHardVeto = Array.isArray(res.violations) && res.violations.some((v) => v && v.code === "STEWARD-HARD-VETO");
  const hmacOk = Boolean(res.hmacVerified);
  if (res.ok && hmacOk && obj.verdict === "approve") {
    const sf = meta.stewardFamily || "跨家族模型";
    const ml = meta.stewardModel ? `（${meta.stewardModel}）` : "";
    console.log(JSON.stringify({ present: true, ok: true, verdict: "approve", ...meta, hmacVerified: true, summary: `${sf}${ml} 跨家族独立审计通过 · HMAC 签章有效`, reason: "ok" }));
  } else if (hasHardVeto && hmacOk) {
    console.log(JSON.stringify({ present: true, ok: false, verdict: "veto", ...meta, hmacVerified: true, summary: `${meta.stewardFamily || "跨家族模型"} 独立审计否决（存在阻断项，不可绕过）`, reason: "STEWARD-HARD-VETO" }));
  } else {
    const first = Array.isArray(res.violations) && res.violations[0] ? `${res.violations[0].code}: ${res.violations[0].message}` : "verification_failed";
    console.log(JSON.stringify({ present: true, ok: false, verdict: "invalid", ...meta, hmacVerified: hmacOk, summary: `权威跨家族审计校验未通过（${first.slice(0, 140)}）`, reason: first }));
  }
})().catch((err) => { console.log(JSON.stringify({ present: true, ok: false, verdict: "invalid", hmacVerified: false, reason: String(err && err.message || err), summary: "权威 Steward 校验器异常" })); });
' -- "$verifier_path" "$receipt_path" "$sha" "$base_sha" "$HMAC_KEY_FILE" 2>/dev/null)"
  node_rc=$?
  set -e
  if [[ "$node_rc" -ne 0 || "$node_out" != \{* ]]; then
    printf '{"present":true,"ok":false,"verdict":"invalid","hmacVerified":false,"reason":"steward_verifier_exec_error","summary":"权威 Steward 校验器运行异常，按 fail-closed 拦截"}\n'
    return 0
  fi
  printf '%s\n' "$node_out"
}

write_breaker_card() {
  local trigger_summary="$1" train_or_ref="$2" ts="$3" raw_reason="$4"
  local clean_reason
  clean_reason="$(printf '%s' "$raw_reason" | tr '\r\n' '  ' | sed -E 's/[[:space:]]+/ /g; s/^ //; s/ $//')"
  local card
  card="$(cat <<EOF
1. [触发总闸] ${trigger_summary}
2. [关联标识] ${train_or_ref} @ ${ts}
3. [直接诱因] ${clean_reason}
4. [处置要求] 完成根因复盘、补齐回归验证并确认保留集 6/6 全绿后方可人工解锁
5. [解锁指令] oc-governor unlock-breaker --reason "<根因结论与验证证据>"
EOF
)"
  atomic_write_file "$BREAKER_CARD_FILE" "$card" 0644
}

resolve_github_repo_slug() {
  local explicit="${1:-}" origin_url=""
  [[ -n "$explicit" ]] && { printf '%s\n' "$explicit"; return 0; }
  [[ -n "${GITHUB_REPOSITORY:-}" ]] && { printf '%s\n' "$GITHUB_REPOSITORY"; return 0; }
  [[ -n "${GH_REPO:-}" ]] && { printf '%s\n' "$GH_REPO"; return 0; }
  origin_url="$(git -c safe.directory='*' remote get-url origin 2>/dev/null || true)"
  [[ -n "$origin_url" ]] && python3 -c 'import re,sys; m=re.search(r"github\.com[:/]([A-Za-z0-9._-]+/[A-Za-z0-9._-]+?)(?:\.git)?$",sys.argv[1].strip()); print(m.group(1)) if m else None' "$origin_url" || true
}

# ── Gate 1: Global Operating Mode ──────────────────────────────────────────

cmd_mode() {
  local sub="${1:-show}"
  if [[ "$sub" == --* ]]; then sub="show"; elif [[ $# -gt 0 ]]; then shift; fi
  local reason=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --reason) reason="${2:-}"; shift 2 ;;
      *) die_usage "unknown mode argument: $1" ;;
    esac
  done
  if [[ "$sub" == "show" ]]; then
    if [[ -f "$MODE_FILE" ]]; then cat "$MODE_FILE"
    else printf '{"schemaVersion":1,"mode":"autonomous","autoMergeFrozen":false,"reason":"default uninitialized","updatedAt":null,"updatedBy":null}\n'; fi
    return 0
  fi
  case "$sub" in
    autonomous|debt_first|emergency_stop) ;;
    *) die_usage "mode must be show | autonomous | debt_first | emergency_stop (got: $sub)" ;;
  esac
  [[ -n "${reason// /}" ]] || die_usage "mode $sub requires --reason \"...\""
  ensure_dirs
  # NB6-host: Never allow switching to autonomous while circuit breaker is still tripped!
  if [[ "$sub" == "autonomous" ]]; then
    local breaker_tripped="0"
    breaker_tripped="$(python3 - "$BREAKER_FILE" "$COST_BREAKER_FILE" <<'PY'
import json, os, sys
for p in sys.argv[1:]:
    if os.path.isfile(p) and not os.path.islink(p):
        try:
            d = json.loads(open(p, encoding="utf-8").read())
            if isinstance(d, dict) and d.get("tripped") is True: print("1"); sys.exit(0)
        except Exception: print("1"); sys.exit(0)
print("0")
PY
)"
    [[ "$breaker_tripped" == "1" ]] && die_gate "BREAKER_TRIPPED_USE_UNLOCK: circuit breaker is currently tripped; verify root cause and run 'oc-governor unlock-breaker --reason \"...\"' instead of switching mode to autonomous"
  fi
  local ts actor prev_mode="autonomous" frozen="false"
  ts="$(now_iso)"; actor="$(actor_name)"
  if [[ -f "$MODE_FILE" ]]; then
    prev_mode="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("mode","autonomous"))' "$MODE_FILE" 2>/dev/null || echo "autonomous")"
  fi
  [[ "$sub" == "emergency_stop" || "$sub" == "debt_first" ]] && frozen="true"
  local mode_json audit_json
  mode_json="$(python3 -c 'import json,sys; m,f,r,t,a=sys.argv[1:]; print(json.dumps({"schemaVersion":1,"mode":m,"autoMergeFrozen":f=="true","reason":r,"updatedAt":t,"updatedBy":a}, ensure_ascii=False, indent=2))' "$sub" "$frozen" "$reason" "$ts" "$actor")"
  atomic_write_file "$MODE_FILE" "$mode_json" 0644
  audit_json="$(python3 -c 'import json,sys; t,a,pm,m,r=sys.argv[1:]; print(json.dumps({"ts":t,"action":"mode_set","actor":a,"prevMode":pm,"mode":m,"reason":r,"outcome":"ok"}, ensure_ascii=False, separators=(",",":")))' "$ts" "$actor" "$prev_mode" "$sub" "$reason")"
  append_audit_safe "$audit_json"
  printf '%s\n' "$mode_json"
}

# ── Gate 2: A0 Relaxation Approval Seal ────────────────────────────────────

cmd_approve_a0() {
  local sha="" reason="" ttl_hours="24" publish_gh=0 gh_repo="" hmac_key_file="$HMAC_KEY_FILE"
  local require_root_owner=1
  [[ "${OC_GOVERNOR_UNSAFE_TEST_SKIP_OWNER:-0}" == "1" ]] && require_root_owner=0
  local -a allowed_paths=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --sha) sha="${2:-}"; shift 2 ;;
      --reason) reason="${2:-}"; shift 2 ;;
      --ttl-hours) ttl_hours="${2:-}"; shift 2 ;;
      --allowed-path) allowed_paths+=("${2:-}"); shift 2 ;;
      --hmac-key-file) hmac_key_file="${2:-}"; shift 2 ;;
      --publish-github-status) publish_gh=1; shift ;;
      --github-repo) gh_repo="${2:-}"; shift 2 ;;
      --unsafe-test-skip-owner) require_root_owner=0; shift ;;
      *) die_usage "unknown approve-a0 argument: $1" ;;
    esac
  done
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die_usage "--sha must be a 40-char lowercase hex commit SHA"
  [[ "$ttl_hours" =~ ^[0-9]+([.][0-9]+)?$ ]] || die_usage "--ttl-hours must be a positive number"
  ensure_dirs
  local ts actor paths_joined="" out_payload doc_json risk_card gh_desc
  ts="$(now_iso)"; actor="$(actor_name)"
  (( ${#allowed_paths[@]} > 0 )) && paths_joined="$(printf '%s\n' "${allowed_paths[@]}")"

  out_payload="$(python3 - "$sha" "$reason" "$ttl_hours" "$ts" "$actor" "$paths_joined" "$hmac_key_file" "$require_root_owner" <<'PY'
import datetime as dt, hashlib, hmac, json, os, stat, sys
sha, raw_reason, ttl_s, issued_iso, actor, paths_raw, hmac_key_file, req_root_s = sys.argv[1:]
req_root = req_root_s == "1"
if "\n" in raw_reason or "\r" in raw_reason: raise SystemExit("--reason must be a single-line string")
reason = raw_reason.strip()
if len(reason) < 8: raise SystemExit("--reason must be at least 8 characters after trimming")
ttl = float(ttl_s)
if ttl <= 0 or ttl > 168: raise SystemExit("--ttl-hours must be in (0, 168]")
issued_dt = dt.datetime.fromisoformat(issued_iso.replace("Z", "+00:00"))
expires_iso = (issued_dt + dt.timedelta(hours=ttl)).strftime("%Y-%m-%dT%H:%M:%SZ")
issued_norm = issued_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
raw_lines = paths_raw.splitlines() if paths_raw else []
paths = []
if raw_lines:
    for p in raw_lines:
        if "\r" in p or "\n" in p or not p.strip(): raise SystemExit("--allowed-path entries must be non-empty single-line strings")
        paths.append(p.strip())
    paths = sorted(set(paths), key=lambda s: s.encode("utf-8"))
paths_canonical = "*" if not paths else json.dumps(paths, separators=(",", ":"), ensure_ascii=False)
canonical = f"a0-approval-v1\nsha={sha}\nissuedAt={issued_norm}\nexpiresAt={expires_iso}\nreason={reason}\nallowedPaths={paths_canonical}\n"
digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
hmac_hex = None
if hmac_key_file and os.path.lexists(hmac_key_file):
    st = os.lstat(hmac_key_file)
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode): raise SystemExit(f"HMAC key file must be a regular file (no symlinks): {hmac_key_file}")
    if (st.st_mode & 0o077) != 0: raise SystemExit(f"HMAC key file must be mode 0600/0400 (no group/world access): {hmac_key_file}")
    if req_root and st.st_uid != 0: raise SystemExit(f"HMAC key file must be owned by root (uid=0, got uid={st.st_uid}): {hmac_key_file}")
    key_str = open(hmac_key_file, encoding="utf-8").read().strip()
    if not key_str: raise SystemExit(f"HMAC key file is empty: {hmac_key_file}")
    hmac_hex = hmac.new(key_str.encode("utf-8"), canonical.encode("utf-8"), hashlib.sha256).hexdigest()
risk_card = f"[A0-RISK-CARD] SHA {sha[:12]} approved by {actor} until {expires_iso} (TTL {ttl:g}h) — Reason: {' '.join(reason.split())}"
doc = {"schemaVersion": 1, "sha": sha, "reason": reason, "approvedBy": actor, "issuedAt": issued_norm, "expiresAt": expires_iso, "sha256": digest, "riskCard": risk_card}
if hmac_hex is not None: doc["hmacSha256"] = hmac_hex
if paths: doc["allowedPaths"] = paths
paths_tag = "*" if not paths else ",".join(paths)
meta_prefix = f"sha={sha[:12]} exp={expires_iso} digest={digest[:16]} paths={paths_tag}"
reason_clean = " ".join(reason.split())
max_reason_len = 140 - len(meta_prefix) - 3
gh_desc_overflow = max_reason_len < 8
gh_desc = "" if gh_desc_overflow else f"{meta_prefix} | {reason_clean if len(reason_clean) <= max_reason_len else reason_clean[:max(8, max_reason_len - 3)] + '...'}"[:140]
print(json.dumps({"doc": doc, "riskCard": risk_card, "ghDesc": gh_desc, "ghDescOverflow": gh_desc_overflow, "ghMetaLen": len(meta_prefix), "reason": reason}, ensure_ascii=False))
PY
)" || die_usage "failed to build A0 approval seal"

  local gh_desc_overflow="" gh_meta_len=""
  local -a _a0_fields=()
  mapfile -d '' -t _a0_fields < <(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); vals=[json.dumps(d["doc"],ensure_ascii=False,indent=2),d["riskCard"],d["ghDesc"],"1" if d["ghDescOverflow"] else "0",str(d["ghMetaLen"]),d["reason"]]; sys.stdout.buffer.write(b"".join(v.encode("utf-8")+b"\x00" for v in vals))' "$out_payload")
  doc_json="${_a0_fields[0]}"; risk_card="${_a0_fields[1]}"; gh_desc="${_a0_fields[2]}"; gh_desc_overflow="${_a0_fields[3]}"; gh_meta_len="${_a0_fields[4]}"; reason="${_a0_fields[5]}"

  if [[ "$publish_gh" == "1" ]]; then
    if [[ "$gh_desc_overflow" == "1" ]]; then
      die_gate "cannot publish oc-v5/a0-approval: explicit paths= scope + metadata (${gh_meta_len} chars) cannot fit in GitHub 140-char description with >=8-char reason (refusing to silently drop allowedPaths scope!)"
    fi
    local resolved_repo=""
    resolved_repo="$(resolve_github_repo_slug "$gh_repo")"
    [[ -n "$resolved_repo" ]] || die_usage "--publish-github-status requires --github-repo <owner/repo> (or GITHUB_REPOSITORY / GH_REPO)"
    command -v gh >/dev/null 2>&1 || die_usage "--publish-github-status requires gh CLI in PATH"
    # B4: Publish GitHub status BEFORE persisting local A0 approval so a failed GH publish leaves zero orphaned local artifact
    gh api -X POST "repos/${resolved_repo}/statuses/${sha}" \
      -f state=success \
      -f context="oc-v5/a0-approval" \
      -f description="$gh_desc" >/dev/null || die_gate "failed to publish GitHub status oc-v5/a0-approval on ${resolved_repo}@${sha}"
    atomic_write_file "$APPROVALS_DIR/${sha}.json" "$doc_json" 0644
    atomic_write_file "$APPROVALS_DIR/${sha}.card.txt" "$risk_card" 0644
    atomic_write_file "$APPROVALS_DIR/${sha}.gh.json" "$(python3 -c 'import json,sys; print(json.dumps({"publishedGithubStatus":True,"githubRepo":sys.argv[1],"sha":sys.argv[2],"publishedAt":sys.argv[3]}, ensure_ascii=False))' "$resolved_repo" "$sha" "$ts")" 0644
  else
    atomic_write_file "$APPROVALS_DIR/${sha}.json" "$doc_json" 0644
    atomic_write_file "$APPROVALS_DIR/${sha}.card.txt" "$risk_card" 0644
  fi

  append_audit_safe "$(python3 -c 'import json,sys; t,a,s,r,ttl,pgh=sys.argv[1:]; print(json.dumps({"ts":t,"action":"approve_a0","actor":a,"sha":s,"ttlHours":float(ttl),"reason":r,"publishedGithubStatus":pgh=="1","outcome":"ok"}, ensure_ascii=False, separators=(",",":")))' "$ts" "$actor" "$sha" "$reason" "$ttl_hours" "$publish_gh")"
  printf '%s\n' "$doc_json"
}

cmd_revoke_a0() {
  local sha="" reason="manual revoke" publish_gh=0 local_only=0 gh_repo=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --sha) sha="${2:-}"; shift 2 ;;
      --reason) reason="${2:-}"; shift 2 ;;
      --publish-github-status) publish_gh=1; shift ;;
      --github-repo) gh_repo="${2:-}"; shift 2 ;;
      --local-only) local_only=1; shift ;;
      *) die_usage "unknown revoke-a0 argument: $1" ;;
    esac
  done
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die_usage "--sha must be a 40-char lowercase hex commit SHA"
  ensure_dirs

  local recorded_repo=""
  if [[ -f "$APPROVALS_DIR/${sha}.gh.json" && ! -L "$APPROVALS_DIR/${sha}.gh.json" ]]; then
    recorded_repo="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1],encoding="utf-8")); print(d.get("githubRepo") or "")' "$APPROVALS_DIR/${sha}.gh.json" 2>/dev/null || true)"
  fi
  if [[ "$local_only" != "1" && -n "$recorded_repo" ]]; then
    publish_gh=1
    [[ -n "$gh_repo" ]] || gh_repo="$recorded_repo"
  fi

  local published_revoke=0
  if [[ "$publish_gh" == "1" ]]; then
    local resolved_repo="" revoke_desc=""
    resolved_repo="$(resolve_github_repo_slug "$gh_repo")"
    [[ -n "$resolved_repo" ]] || die_usage "revoke-a0 --publish-github-status requires --github-repo <owner/repo> (or GITHUB_REPOSITORY / GH_REPO)"
    command -v gh >/dev/null 2>&1 || die_usage "revoke-a0 --publish-github-status requires gh CLI in PATH"
    revoke_desc="$(python3 -c 'import sys; s,r=sys.argv[1], " ".join(sys.argv[2].split()); p=f"revoked sha={s[:12]} paths=* | "; print((p + (r or "manual revoke"))[:140])' "$sha" "$reason")"
    gh api -X POST "repos/${resolved_repo}/statuses/${sha}" \
      -f state=failure \
      -f context="oc-v5/a0-approval" \
      -f description="$revoke_desc" >/dev/null || die_gate "failed to publish revocation GitHub status oc-v5/a0-approval on ${resolved_repo}@${sha}"
    published_revoke=1
  fi

  rm -f "$APPROVALS_DIR/${sha}.json" "$APPROVALS_DIR/${sha}.card.txt" "$APPROVALS_DIR/${sha}.gh.json"
  append_audit_safe "$(python3 -c 'import json,sys; t,a,s,r,pr=sys.argv[1:]; print(json.dumps({"ts":t,"action":"revoke_a0","actor":a,"sha":s,"reason":r,"publishedGithubRevocation":pr=="1","outcome":"ok"}, ensure_ascii=False, separators=(",",":")))' "$(now_iso)" "$(actor_name)" "$sha" "$reason" "$published_revoke")"
  printf '{"ok":true,"revokedSha":"%s","publishedGithubRevocation":%s}\n' "$sha" "$( [[ "$published_revoke" == "1" ]] && echo true || echo false )"
}

cmd_verify_a0() {
  local sha="" file="" hmac_key_file="" require_root_owner=1
  [[ "${OC_GOVERNOR_UNSAFE_TEST_SKIP_OWNER:-0}" == "1" ]] && require_root_owner=0
  local -a check_paths=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --sha) sha="${2:-}"; shift 2 ;;
      --file) file="${2:-}"; shift 2 ;;
      --path) check_paths+=("${2:-}"); shift 2 ;;
      --hmac-key-file) hmac_key_file="${2:-}"; shift 2 ;;
      --require-root-owner) require_root_owner=1; shift ;;
      --unsafe-test-skip-owner) require_root_owner=0; shift ;;
      *) die_usage "unknown verify-a0 argument: $1" ;;
    esac
  done
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die_usage "--sha must be a 40-char lowercase hex commit SHA"
  [[ -n "$file" ]] || file="$APPROVALS_DIR/${sha}.json"
  if [[ -z "$hmac_key_file" ]]; then
    hmac_key_file="$(dirname "$(dirname "$file")")/.hmac-key"
  fi
  local ts actor paths_nl=""
  ts="$(now_iso)"; actor="$(actor_name)"
  (( ${#check_paths[@]} > 0 )) && paths_nl="$(printf '%s\n' "${check_paths[@]}")"

  local check_out rc=0
  set +e
  check_out="$(python3 - "$file" "$sha" "$ts" "$require_root_owner" "$hmac_key_file" "$paths_nl" <<'PY'
import datetime as dt, hashlib, hmac, json, os, re, stat, sys
path, want_sha, now_iso, req_root_s, hmac_key_file, paths_nl = sys.argv[1:]
req_root = req_root_s == "1"
SHA40_RE, SHA64_RE = re.compile(r"^[0-9a-f]{40}$"), re.compile(r"^[0-9a-f]{64}$")
ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$")
def fail(code: str, exit_code: int = 10): print(code); sys.exit(exit_code)
def glob_to_regex(glob: str) -> re.Pattern:
    out, i, n = [], 0, len(glob)
    while i < n:
        ch = glob[i]
        if ch == "*":
            if i + 1 < n and glob[i + 1] == "*":
                if i + 2 < n and glob[i + 2] == "/": out.append("(?:.+/)?"); i += 3; continue
                out.append(".*"); i += 2; continue
            out.append("[^/]*")
        elif ch in "+?^${}()|[]\\.": out.append("\\" + ch)
        else: out.append(ch)
        i += 1
    return re.compile("^" + "".join(out) + "$")
if not SHA40_RE.fullmatch(want_sha): fail("invalid_sha", 10)
try: st = os.lstat(path)
except OSError: fail("missing_file", 10)
if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode): fail("not_regular_file_or_symlink", 10)
if (st.st_mode & 0o022) != 0: fail("group_or_world_writable", 10)
if req_root and st.st_uid != 0: fail(f"owner_not_root:uid={st.st_uid}", 10)
try: doc = json.loads(open(path, encoding="utf-8").read())
except Exception: fail("invalid_json", 11)
if not isinstance(doc, dict): fail("not_json_object", 11)
if type(doc.get("schemaVersion")) is not int or doc.get("schemaVersion") != 1: fail("unsupported_schema_version", 11)
if doc.get("sha") != want_sha: fail("sha_mismatch", 11)
raw_reason = doc.get("reason")
if not isinstance(raw_reason, str) or "\r" in raw_reason or "\n" in raw_reason: fail("invalid_reason", 11)
trimmed_reason = raw_reason.strip()
if len(trimmed_reason) < 8: fail("reason_too_short", 11)
issued, expires = doc.get("issuedAt"), doc.get("expiresAt")
if not isinstance(issued, str) or not isinstance(expires, str) or not ISO_RE.fullmatch(issued) or not ISO_RE.fullmatch(expires): fail("invalid_timestamps", 11)
try:
    issued_dt, expires_dt, now_dt = (dt.datetime.fromisoformat(s.replace("Z", "+00:00")) for s in (issued, expires, now_iso))
except Exception: fail("invalid_timestamps", 11)
if expires_dt <= issued_dt: fail("expires_before_issued", 11)
if now_dt >= expires_dt: fail("approval_expired", 13)
allowed_paths = None
if "allowedPaths" in doc and doc["allowedPaths"] is not None:
    raw_paths = doc["allowedPaths"]
    if not isinstance(raw_paths, list) or len(raw_paths) == 0: fail("invalid_allowed_paths", 11)
    cleaned = []
    for item in raw_paths:
        if not isinstance(item, str) or "\r" in item or "\n" in item or not item.strip(): fail("invalid_allowed_paths", 11)
        cleaned.append(item.strip())
    allowed_paths = sorted(set(cleaned), key=lambda s: s.encode("utf-8"))
paths_canonical = "*" if allowed_paths is None else json.dumps(allowed_paths, separators=(",", ":"), ensure_ascii=False)
canonical = f"a0-approval-v1\nsha={want_sha}\nissuedAt={issued}\nexpiresAt={expires}\nreason={trimmed_reason}\nallowedPaths={paths_canonical}\n"
sig = doc.get("sha256")
if not isinstance(sig, str) or not SHA64_RE.fullmatch(sig): fail("missing_sha256", 12)
if not hmac.compare_digest(sig, hashlib.sha256(canonical.encode("utf-8")).hexdigest()): fail("signature_tampered", 12)
hmac_key = None
if hmac_key_file and os.path.lexists(hmac_key_file):
    kst = os.lstat(hmac_key_file)
    if stat.S_ISLNK(kst.st_mode) or not stat.S_ISREG(kst.st_mode): fail("invalid_hmac_key_file", 12)
    if (kst.st_mode & 0o077) != 0: fail("hmac_key_insecure_permissions", 12)
    if req_root and kst.st_uid != 0: fail("hmac_key_owner_not_root", 12)
    try: hmac_key = open(hmac_key_file, encoding="utf-8").read().strip()
    except OSError: fail("hmac_key_unreadable", 12)
    if not hmac_key: fail("hmac_key_empty", 12)
hmac_field = doc.get("hmacSha256")
if hmac_key is not None:
    if not isinstance(hmac_field, str) or not SHA64_RE.fullmatch(hmac_field): fail("hmac_required_downgrade_rejected", 12)
    if not hmac.compare_digest(hmac_field, hmac.new(hmac_key.encode("utf-8"), canonical.encode("utf-8"), hashlib.sha256).hexdigest()): fail("hmac_tampered", 12)
elif hmac_field is not None: fail("unexpected_hmac_without_key", 12)
target_paths = [p.strip() for p in paths_nl.splitlines() if p.strip()]
if allowed_paths is not None and target_paths:
    matchers = [glob_to_regex(g) for g in allowed_paths]
    uncovered = [p for p in target_paths if not any(m.match(p) for m in matchers)]
    if uncovered: fail(f"allowed_paths_uncovered:{','.join(uncovered)}", 14)
print(json.dumps({"ok": True, "sha": want_sha, "expiresAt": expires, "hmacVerified": hmac_key is not None, "allowedPaths": allowed_paths, "riskCard": doc.get("riskCard")}))
PY
)"
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    local action_tag="check_a0"
    [[ "$check_out" == "signature_tampered" || "$check_out" == "hmac_tampered" || "$check_out" == "hmac_required_downgrade_rejected" ]] && action_tag="a0_tamper"
    append_audit_safe "$(python3 -c 'import json,sys; print(json.dumps({"ts":sys.argv[1],"action":sys.argv[2],"actor":sys.argv[3],"sha":sys.argv[4],"reason":sys.argv[5],"outcome":"blocked"}))' "$ts" "$actor" "$action_tag" "$sha" "$check_out")"
    die_gate "A0 approval invalid for $sha: $check_out"
  fi
  printf '%s\n' "$check_out"
}

# ── Gate 3: Irreversible Blast-Radius Hard-Lock ────────────────────────────

_resolve_exact_base_sha() { # <repo_root> <40hex-sha> [base_ref]
  local repo_root="$1" sha="$2" base_ref="${3:-}" resolved=""
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || return 0
  if [[ -n "$repo_root" && -d "$repo_root" ]] && git -C "$repo_root" -c safe.directory='*' cat-file -e "${sha}^{commit}" 2>/dev/null; then
    local ref="${base_ref:-${sha}^}"
    resolved="$(git -C "$repo_root" -c safe.directory='*' rev-parse --verify "${ref}^{commit}" 2>/dev/null || true)"
    [[ "$resolved" =~ ^[0-9a-f]{40}$ && "$resolved" != "$sha" ]] && printf '%s\n' "$resolved"
    return 0
  fi
  if [[ -n "$base_ref" && "$base_ref" =~ ^[0-9a-f]{40}$ && "$base_ref" != "$sha" ]]; then
    printf '%s\n' "$base_ref"
  fi
}

cmd_issue_blast_voucher() {
  local scope="" reason="" ttl_hours="4" sha="" branch="" approval_id="" explicit_id="" files_json="" files_nul=0
  local -a files=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --id) explicit_id="${2:-}"; shift 2 ;;
      --scope) scope="${2:-}"; shift 2 ;;
      --reason) reason="${2:-}"; shift 2 ;;
      --ttl-hours) ttl_hours="${2:-}"; shift 2 ;;
      --sha) sha="${2:-}"; shift 2 ;;
      --branch) branch="${2:-}"; shift 2 ;;
      --approval-id) approval_id="${2:-}"; shift 2 ;;
      --files-json) files_json="${2:-}"; shift 2 ;;
      --files-nul) files_nul=1; shift ;;
      --files) shift; while [[ $# -gt 0 && "$1" != --* ]]; do files+=("$1"); shift; done ;;
      *) die_usage "unknown issue-blast-voucher argument: $1" ;;
    esac
  done
  case "$scope" in ddl|billing|ddl+billing) ;; *) die_usage "--scope must be ddl | billing | ddl+billing" ;; esac
  [[ ${#reason} -ge 8 ]] || die_usage "--reason must be >= 8 characters"
  [[ -z "$explicit_id" || "$explicit_id" =~ ^bv-[a-z0-9_-]{4,64}$ ]] || die_usage "--id must match ^bv-[a-z0-9_-]{4,64}$"
  [[ -z "$sha" || "$sha" =~ ^[0-9a-f]{40}$ ]] || die_usage "--sha must be a 40-char lowercase hex commit SHA"
  [[ -z "$approval_id" || "$approval_id" =~ ^gov-[a-z0-9_-]{4,80}$ ]] || die_usage "--approval-id must match ^gov-[a-z0-9_-]{4,80}$"
  if [[ -n "$branch" ]]; then
    local norm_br="${branch#refs/heads/}"; norm_br="${norm_br#origin/}"
    [[ "$norm_br" != "feat/v5-aurora-rewrite" && "$norm_br" != *v5-aurora-rewrite* ]] \
      || die_gate "COMMERCIAL_BRANCH_HARD_LOCK: refusing to issue blast voucher for commercial branch $branch"
  fi
  ensure_dirs
  local ts actor voucher_json voucher_id rc=0 tmp_nul=""
  ts="$(now_iso)"; actor="$(actor_name)"
  if [[ "$files_nul" == "1" ]]; then tmp_nul="$(mktemp "${TMPDIR:-/tmp}/oc-bv-files.XXXXXX")"; cat >"$tmp_nul"; fi

  set +e
  voucher_json="$(python3 - "$scope" "$reason" "$ttl_hours" "$ts" "$actor" "$sha" "$branch" "$approval_id" "$explicit_id" "$files_json" "$tmp_nul" "${files[@]}" <<'PY'
import datetime as dt, hashlib, json, os, re, sys
scope, reason, ttl_s, issued_iso, actor, sha, branch, approval_id, explicit_id, files_json, nul_path = sys.argv[1:12]
raw_argv = sys.argv[12:]
if "\n" in reason or "\r" in reason: raise SystemExit("--reason must be single-line")
ttl = float(ttl_s)
if ttl <= 0 or ttl > 72: raise SystemExit("--ttl-hours must be in (0, 72]")
raw_list = []
if files_json:
    parsed = json.loads(files_json)
    if not isinstance(parsed, list): raise SystemExit("--files-json must be a JSON array")
    raw_list.extend(parsed)
elif nul_path and os.path.isfile(nul_path):
    raw_list.extend(tok.decode("utf-8", errors="strict") for tok in open(nul_path, "rb").read().split(b"\x00") if tok)
else:
    raw_list.extend(raw_argv)
files_set = set()
for p in raw_list:
    if not isinstance(p, str) or not p: raise SystemExit("INVALID_FILE_PATH: empty path")
    if "\n" in p or "\r" in p or "\x00" in p: raise SystemExit("INVALID_FILE_PATH: control characters forbidden")
    files_set.add(p)
files = sorted(files_set)
if not files: raise SystemExit("--files must list at least one path")
norm_branch = re.sub(r"^(?:refs/heads/|origin/)", "", branch.strip()) if branch.strip() else ""
if norm_branch == "feat/v5-aurora-rewrite" or "v5-aurora-rewrite" in norm_branch:
    sys.stderr.write("COMMERCIAL_BRANCH_HARD_LOCK\n"); sys.exit(21)
issued_dt = dt.datetime.fromisoformat(issued_iso.replace("Z", "+00:00"))
issued_norm = issued_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
expires_iso = (issued_dt + dt.timedelta(hours=ttl)).strftime("%Y-%m-%dT%H:%M:%SZ")
vid = explicit_id or ("bv-" + hashlib.sha256((f"approval:{approval_id}:{sha}:{norm_branch}:{scope}:{','.join(files)}" if approval_id else f"{issued_norm}:{scope}:{','.join(files)}:{os.getpid()}").encode("utf-8")).hexdigest()[:16])
canonical = f"blast-voucher-v1\nid={vid}\nscope={scope}\nissuedAt={issued_norm}\nexpiresAt={expires_iso}\nfiles={','.join(files)}\nreason={reason}\n"
if sha: canonical += f"sha={sha}\n"
if norm_branch: canonical += f"branch={norm_branch}\n"
if approval_id: canonical += f"approvalId={approval_id}\n"
doc = {"schemaVersion": 1, "id": vid, "scope": scope, "files": files, "reason": reason, "issuedBy": actor, "issuedAt": issued_norm, "expiresAt": expires_iso, "sha256": hashlib.sha256(canonical.encode("utf-8")).hexdigest()}
if sha: doc["sha"] = sha
if norm_branch: doc["branch"] = norm_branch
if approval_id: doc["approvalId"] = approval_id
print(json.dumps(doc, ensure_ascii=False, indent=2))
PY
)"
  rc=$?
  set -e
  [[ -n "$tmp_nul" ]] && rm -f -- "$tmp_nul" 2>/dev/null || true
  if [[ "$rc" -ne 0 ]]; then [[ "$rc" -eq 21 ]] && die_gate "COMMERCIAL_BRANCH_HARD_LOCK"; die_usage "failed to issue blast voucher"; fi
  voucher_id="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["id"])' "$voucher_json")"
  atomic_write_file "$VOUCHERS_DIR/${voucher_id}.json" "$voucher_json" 0644
  append_audit_safe "$(python3 -c 'import json,sys; t,a,v,s,sh,br,aid=sys.argv[1:]; ev={"ts":t,"action":"issue_blast_voucher","actor":a,"voucherId":v,"scope":s,"outcome":"ok"}; (ev.update({"sha":sh}) if sh else None); (ev.update({"branch":br}) if br else None); (ev.update({"approvalId":aid}) if aid else None); print(json.dumps(ev, ensure_ascii=False, separators=(",",":")))' "$ts" "$actor" "$voucher_id" "$scope" "$sha" "$branch" "$approval_id")"
  printf '%s\n' "$voucher_json"
}

_verify_noncore_ts_only_diff() { # <repo_root> <40hex-sha> <40hex-base-sha> <files_json>
  local repo_root="$1" sha="$2" base_sha="$3" files_json="$4" verifier_path="" nm_dir="" ts_pkg=""
  verifier_path="$(_resolve_steward_verifier_path || true)"
  nm_dir="$(_resolve_trusted_node_modules_dir "$verifier_path" || true)"
  if [[ -n "$nm_dir" && -d "$nm_dir/typescript" ]]; then ts_pkg="$nm_dir/typescript"
  elif [[ -d "/opt/openclaude/node_modules/typescript" ]]; then ts_pkg="/opt/openclaude/node_modules/typescript"; fi
  if [[ -z "$ts_pkg" ]]; then printf '{"ok":false,"reason":"缺少宿主可信 typescript 编译器（fail-closed）"}\n'; return 0; fi
  if [[ ! "$base_sha" =~ ^[0-9a-f]{40}$ || "$base_sha" == "$sha" ]]; then
    printf '{"ok":false,"reason":"无法确定精确比较基线 baseSha，按 fail-closed 转人工审批"}\n'; return 0
  fi
  local out="" rc=0
  set +e
  out="$(env -u NODE_OPTIONS -u NODE_PATH -u TSX_TSCONFIG_PATH node -e '
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const [tsPkgPath, repoRoot, sha, baseCommit, filesJson] = process.argv.slice(1);
const fail = (reason) => { console.log(JSON.stringify({ ok: false, reason })); process.exit(0); };
let ts;
try { ts = require(tsPkgPath); } catch { fail("加载宿主 typescript 编译器失败（fail-closed）"); }
const files = JSON.parse(filesJson);
const TS_EXT_RE = /\.(?:ts|tsx|mts|cts)$/i;
function git(args) {
  try { return { ok: true, out: execFileSync("git", ["-C", repoRoot, "-c", "safe.directory=*", ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }) }; }
  catch { return { ok: false, out: "" }; }
}
function canonicalRuntimeJs(src, fileName) {
  if (!src || !src.trim()) return "";
  const isTsx = fileName.toLowerCase().endsWith(".tsx");
  const res = ts.transpileModule(src, {
    fileName, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true, preserveConstEnums: true, removeComments: true, ...(isTsx ? { jsx: ts.JsxEmit.Preserve } : {}) },
  });
  if (Array.isArray(res.diagnostics) && res.diagnostics.some((d) => d.category === ts.DiagnosticCategory.Error)) throw new Error("TS 语法校验失败");
  const sf = ts.createSourceFile("canonical.js", res.outputText, ts.ScriptTarget.ESNext, false, isTsx ? ts.ScriptKind.JSX : ts.ScriptKind.JS);
  const printed = ts.createPrinter({ removeComments: true }).printFile(sf).trim();
  return printed === "export {};" ? "" : printed;
}
if (!git(["rev-parse", "--git-dir"]).ok) fail("repo-root 不是有效 git 仓库");
if (!git(["cat-file", "-e", `${sha}^{commit}`]).ok) fail(`目标提交 ${sha.slice(0, 12)} 不存在`);
if (!git(["cat-file", "-e", `${baseCommit}^{commit}`]).ok) fail(`基线提交 ${baseCommit.slice(0, 12)} 不存在`);
for (const f of files) {
  const nf = String(f).replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
  if (!TS_EXT_RE.test(nf)) fail(`核心计费文件 ${nf} 不是 TypeScript 源码`);
  const hasNew = git(["cat-file", "-e", `${sha}:${nf}`]).ok;
  const hasOld = git(["cat-file", "-e", `${baseCommit}:${nf}`]).ok;
  if (!hasNew && !hasOld) fail(`无法在基线或目标提交定位 ${nf}`);
  const newR = hasNew ? git(["show", `${sha}:${nf}`]) : { ok: true, out: "" };
  const oldR = hasOld ? git(["show", `${baseCommit}:${nf}`]) : { ok: true, out: "" };
  if (!newR.ok || !oldR.ok) fail(`读取 ${nf} 的 git 对象失败`);
  if (oldR.out === newR.out) fail(`未检测到 ${nf} 在基线与目标提交之间的内容差异`);
  try {
    if (canonicalRuntimeJs(oldR.out, path.basename(nf)) !== canonicalRuntimeJs(newR.out, path.basename(nf))) {
      fail(`核心计费文件 ${nf} 包含运行时代码变更（非纯注释/类型声明），需人工确认`);
    }
  } catch (err) { fail(`解析 ${nf} AST 失败（${err instanceof Error ? err.message : "unknown"}）`); }
}
console.log(JSON.stringify({ ok: true, reason: "ok" }));
' "$ts_pkg" "$repo_root" "$sha" "$base_sha" "$files_json" 2>/dev/null)"
  rc=$?
  set -e
  if [[ "$rc" -ne 0 || "$out" != \{* ]]; then printf '{"ok":false,"reason":"TS 语法树纯类型校验执行异常，按 fail-closed 拦截"}\n'; return 0; fi
  printf '%s\n' "$out"
}

cmd_check_blast_radius() {
  local branch="" voucher="" sql_snippet="" repo_root="." sha="" base_ref="" files_json="" files_nul=0
  local -a raw_files=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --branch) branch="${2:-}"; shift 2 ;;
      --voucher) voucher="${2:-}"; shift 2 ;;
      --sql) sql_snippet="${2:-}"; shift 2 ;;
      --repo-root) repo_root="${2:-}"; shift 2 ;;
      --sha) sha="${2:-}"; shift 2 ;;
      --base-ref) base_ref="${2:-}"; shift 2 ;;
      --files-json) files_json="${2:-}"; shift 2 ;;
      --files-nul) files_nul=1; shift ;;
      --files) shift; while [[ $# -gt 0 && "$1" != --* ]]; do raw_files+=("$1"); shift; done ;;
      *) die_usage "unknown check-blast-radius argument: $1" ;;
    esac
  done
  [[ -n "$branch" ]] || die_usage "check-blast-radius requires --branch <name>"
  local ts actor tmp_files_nul="" check_res rc=0 phase1_out="" phase1_rc=0 resolved_base_sha=""
  ts="$(now_iso)"; actor="$(actor_name)"
  resolved_base_sha="$(_resolve_exact_base_sha "$repo_root" "$sha" "$base_ref")"
  tmp_files_nul="$(mktemp "${TMPDIR:-/tmp}/oc-blast-files.XXXXXX")"
  if [[ "$files_nul" == "1" ]]; then cat >"$tmp_files_nul"
  elif (( ${#raw_files[@]} > 0 )); then printf '%s\0' "${raw_files[@]}" >"$tmp_files_nul"; fi

  set +e
  phase1_out="$(_pending_approval_py blast_p1 "$branch" "$tmp_files_nul" "$files_json" "$sql_snippet" "$repo_root" "$sha" "$base_ref" "$resolved_base_sha" "$voucher")"
  phase1_rc=$?
  set -e
  rm -f -- "$tmp_files_nul" 2>/dev/null || true
  if [[ "$phase1_rc" -eq 2 ]]; then die_usage "check-blast-radius invalid file path"; fi
  [[ "$phase1_rc" -eq 0 && "$phase1_out" == \{* ]] || die_gate "check-blast-radius internal error"

  local p1_phase=""
  p1_phase="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("phase",""))' "$phase1_out")"
  if [[ "$p1_phase" == "final" ]]; then
    local p1_exit=""
    p1_exit="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("exitCode",1))' "$phase1_out")"
    check_res="$(python3 -c 'import json,sys; print(json.dumps(json.loads(sys.argv[1])["payload"], ensure_ascii=False))' "$phase1_out")"
    if [[ "$p1_exit" -ne 0 ]]; then
      append_audit_safe "$(python3 -c 'import json,sys; t,a,b,raw=sys.argv[1:]; d=json.loads(raw); print(json.dumps({"ts":t,"action":"check_blast_radius","actor":a,"branch":b,"code":d.get("code","BLOCKED"),"classification":d.get("classification"),"outcome":"blocked"}, ensure_ascii=False, separators=(",",":")))' "$ts" "$actor" "$branch" "$check_res")"
      printf '%s\n' "$check_res" >&2; exit 1
    fi
    append_audit_safe "$(python3 -c 'import json,sys; t,a,b,s,raw=sys.argv[1:]; d=json.loads(raw); is_nc=bool(d.get("autoApprovedNonCoreBilling")); ev={"ts":t,"action":"check_blast_radius","actor":a,"branch":b,"classification":"auto_pass","outcome":"ok_auto_noncore_billing" if is_nc else "ok"}; (ev.update({"sha":s}) if s else None); (ev.update({"nonCoreBillingFiles":d.get("nonCoreBillingFiles")}) if is_nc else None); print(json.dumps(ev, ensure_ascii=False, separators=(",",":")))' "$ts" "$actor" "$branch" "$sha" "$check_res")"
    printf '%s\n' "$check_res"; return 0
  fi

  local core_ast_eligible="0" core_json="[]"
  core_ast_eligible="$(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); print("1" if (not d["ddlHits"] and d["coreBillingHits"]) else "0")' "$phase1_out")"
  core_json="$(python3 -c 'import json,sys; print(json.dumps(json.loads(sys.argv[1])["coreBillingHits"], ensure_ascii=False))' "$phase1_out")"

  local ts_check_json='{"ok":false,"reason":""}'
  if [[ "$core_ast_eligible" == "1" && "$sha" =~ ^[0-9a-f]{40}$ ]]; then
    if [[ -z "$resolved_base_sha" ]]; then
      ts_check_json='{"ok":false,"reason":"无法确定精确比较基线 baseSha，按保守策略转人工确认"}'
    else
      ts_check_json="$(_verify_noncore_ts_only_diff "$repo_root" "$sha" "$resolved_base_sha" "$core_json")"
    fi
  fi

  set +e
  check_res="$(_pending_approval_py blast_p3 "$branch" "$phase1_out" "$ts_check_json" "$voucher" "$VOUCHERS_DIR" "$ts" "$sha")"
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    append_audit_safe "$(python3 -c 'import json,sys; t,a,b,raw=sys.argv[1:]; d=json.loads(raw) if raw.startswith("{") else {}; print(json.dumps({"ts":t,"action":"check_blast_radius","actor":a,"branch":b,"code":d.get("code","BLOCKED"),"classification":d.get("classification"),"outcome":"blocked"}, ensure_ascii=False, separators=(",",":")))' "$ts" "$actor" "$branch" "$check_res")"
    printf '%s\n' "$check_res" >&2; exit 1
  fi
  append_audit_safe "$(python3 -c 'import json,sys; t,a,b,s,raw=sys.argv[1:]; d=json.loads(raw) if raw.startswith("{") else {}; out="ok_semantic_no_runtime_billing" if d.get("semanticNoRuntimeBillingChange") else ("ok_auto_noncore_billing" if d.get("autoApprovedNonCoreBilling") else "ok"); ev={"ts":t,"action":"check_blast_radius","actor":a,"branch":b,"classification":d.get("classification"),"outcome":out}; (ev.update({"sha":s}) if s else None); (ev.update({"coreBillingFiles":d.get("coreBillingFiles")}) if d.get("semanticNoRuntimeBillingChange") else None); (ev.update({"nonCoreBillingFiles":d.get("nonCoreBillingFiles")}) if d.get("autoApprovedNonCoreBilling") else None); (ev.update({"voucherId":d["voucherId"]}) if d.get("voucherId") else None); (ev.update({"voucherAutoDiscovered":bool(d["voucherAutoDiscovered"])}) if "voucherAutoDiscovered" in d else None); print(json.dumps(ev, ensure_ascii=False, separators=(",",":")))' "$ts" "$actor" "$branch" "$sha" "$check_res")"
  printf '%s\n' "$check_res"
}

# ── Gate 3b: Structured Pending Approvals Queue (OCV5-914) ─────────────────
# Single shared Python engine for blast_p1/blast_p3/record/list/decide_prep/decide_commit/reconcile/update_resume/resolve
_pending_approval_py() {
  OC_GOV_ROOT_RESOLVED="$GOV_ROOT" python3 - "$@" <<'PY'
import datetime as dt, hashlib, hmac, json, os, pathlib, re, secrets, stat, subprocess, sys
op, args = sys.argv[1], sys.argv[2:]
SHA40_RE, SHA64_RE = re.compile(r"^[0-9a-f]{40}$"), re.compile(r"^[0-9a-f]{64}$")
ID_RE, ID_FILE_RE = re.compile(r"^gov-[a-z0-9_-]{4,80}$"), re.compile(r"^gov-[a-z0-9_-]{4,80}\.json$")
VOUCHER_FILE_RE = re.compile(r"^bv-[a-z0-9_-]{4,64}\.json$")
MAX_BYTES = 256 * 1024
VALID_STATUSES = {"pending", "approving", "approved", "rejected", "expired", "reconcile_required"}
TEST_FILE_RE = re.compile(r"^packages/commercial/src/(?:billing|payment)/(?:.*/)?__tests__/.*\.(?:test|spec)\.[cm]?[jt]sx?$|^packages/commercial/src/(?:billing|payment)/.*\.(?:test|spec)\.[cm]?[jt]sx?$")
BILLING_DIR_RE, PAYMENT_DIR_RE = re.compile(r"^packages/commercial/src/billing/"), re.compile(r"^packages/commercial/src/payment/")
BILLING_CORE_EXTRA_PATHS = frozenset({"packages/protocol/src/serviceTiers.ts"})
DEFAULT_BILLING_NONCORE_ALLOWLIST = frozenset(f"packages/commercial/src/billing/{n}" for n in ("apiKeyMessageAudit.ts", "apiKeyUsageReport.ts", "ledgerRowContext.ts", "usageReport.ts"))
def _load_billing_noncore_allowlist() -> frozenset[str]:
    p = pathlib.Path(os.environ.get("OC_GOV_ROOT_RESOLVED") or "/opt/openclaude/harness-gate") / "referee" / "arch" / "a0-protected-paths.json"
    if not os.path.lexists(p): return DEFAULT_BILLING_NONCORE_ALLOWLIST
    try:
        st, skip_owner = os.lstat(p), os.environ.get("OC_GOVERNOR_UNSAFE_TEST_SKIP_OWNER") == "1"
        if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode) or (st.st_mode & 0o022) != 0 or (not skip_owner and os.geteuid() == 0 and str(p).startswith("/opt/openclaude/") and st.st_uid != 0): return DEFAULT_BILLING_NONCORE_ALLOWLIST
        raw = (json.loads(p.read_text(encoding="utf-8")) or {}).get("billingNonCoreAllowlist")
        if isinstance(raw, list) and all(isinstance(x, str) and x.startswith("packages/commercial/src/billing/") for x in raw): return frozenset(x.replace("\\", "/").lstrip("./") for x in raw)
    except Exception: pass
    return DEFAULT_BILLING_NONCORE_ALLOWLIST
BILLING_NONCORE_ALLOWLIST = _load_billing_noncore_allowlist()
def _classify_billing(f: str, nf: str, core_b: list, noncore_b: list):
    if TEST_FILE_RE.search(nf): return
    if nf in BILLING_CORE_EXTRA_PATHS or PAYMENT_DIR_RE.search(nf) or (BILLING_DIR_RE.search(nf) and nf not in BILLING_NONCORE_ALLOWLIST): core_b.append(f)
    elif BILLING_DIR_RE.search(nf): noncore_b.append(f)

# B3: Conservative SQL DDL safe-additive whitelist (strips SQL comments safely; ANY unrecognized statement -> human_review_required!)
SAFE_SQL_RES = [re.compile(p, re.IGNORECASE) for p in (r"^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(?:\"(?:\"\"|[^\"])+\"|[A-Za-z_][\w$.]*)\s*\(", r"^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?IF\s+NOT\s+EXISTS\b", r"^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:\"(?:\"\"|[^\"])+\"|[A-Za-z_][\w$.]*)\s+ADD\s+(?:COLUMN\s+)?", r"^COMMENT\s+ON\s+(?:TABLE|COLUMN|INDEX|SCHEMA|CONSTRAINT|VIEW|TYPE|FUNCTION)\b", r"^(?:BEGIN(?:\s+TRANSACTION|\s+WORK)?|COMMIT(?:\s+TRANSACTION|\s+WORK)?|SET\s+LOCAL\s+(?:lock_timeout|statement_timeout)\s*(?:=|TO)\s+'[^']+')$")]
UNSAFE_SQL_TOKEN_RE = re.compile(r"\b(?:DROP|TRUNCATE|DELETE\s+FROM|INSERT\s+INTO|UPDATE\s+(?:\"_id_\"|[A-Za-z_][\w$.]*)\s+SET|MERGE\s+INTO|WITH|SELECT|RETURNING|EXECUTE|PERFORM|CALL|COPY|GRANT|REVOKE|ALTER\s+COLUMN|SET\s+DATA\s+TYPE|RENAME)\b|\bAS\s+(?:WITH|SELECT)\b|,\s*(?:DROP|ALTER|RENAME|SET|OWNER|DISABLE|ENABLE)\b", re.IGNORECASE)
_ID, _CONST = r'(?:"_id_"|[A-Za-z_][A-Za-z0-9_]*)', r"(?:''(?:::[A-Za-z_][A-Za-z0-9_]*)?|-?\d+(?:\.\d+)?|true|false|null|now\(\)|current_timestamp|gen_random_uuid\(\))"
_QID, _TYPE = rf"{_ID}(?:\.{_ID})?", r"[A-Za-z_][A-Za-z0-9_]*(?:\s+[A-Za-z_][A-Za-z0-9_]*){0,2}(?:\s*\(\s*\d+(?:\s*,\s*\d+)?\s*\))?(?:\[\])?"
DO_SAFE_INNER_RES = [re.compile(p, re.IGNORECASE) for p in (rf"^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?IF\s+NOT\s+EXISTS\s+{_ID}\s+ON\s+{_QID}(?:\s+USING\s+(?:btree|hash|gin|gist))?\s*\(\s*{_ID}(?:\s+(?:ASC|DESC))?(?:\s+NULLS\s+(?:FIRST|LAST))?(?:\s*,\s*{_ID}(?:\s+(?:ASC|DESC))?(?:\s+NULLS\s+(?:FIRST|LAST))?)*\s*\)(?:\s+WHERE\s+{_ID}\s+(?:IS\s+(?:NOT\s+)?NULL|(?:=|!=|<>)\s+{_CONST}))?$", rf"^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?{_QID}\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?{_ID}\s+{_TYPE}(?:\s+(?:(?:NOT\s+)?NULL|DEFAULT\s+{_CONST}|UNIQUE))*$", rf"^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?{_QID}\s+ADD\s+CONSTRAINT\s+{_ID}\s+(?:(?:UNIQUE|PRIMARY\s+KEY)\s*\(\s*{_ID}(?:\s*,\s*{_ID})*\s*\)|FOREIGN\s+KEY\s*\(\s*{_ID}(?:\s*,\s*{_ID})*\s*\)\s+REFERENCES\s+{_QID}\s*\(\s*{_ID}(?:\s*,\s*{_ID})*\s*\)(?:\s+ON\s+DELETE\s+(?:CASCADE|SET\s+NULL|RESTRICT|NO\s+ACTION))?)$", rf"^COMMENT\s+ON\s+(?:TABLE|COLUMN|INDEX|SCHEMA|CONSTRAINT)\s+{_QID}\s+IS\s+''$")]
DO_BLOCK_RE = re.compile(r"^DO\s+(?:LANGUAGE\s+(?:'plpgsql'|plpgsql)\s+)?(\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$)([\s\S]*)\1(?:\s+LANGUAGE\s+(?:'plpgsql'|plpgsql))?\s*$", re.IGNORECASE)
DECL_LINE_RE = re.compile(r"^[A-Za-z_]\w*\s+[A-Za-z_]\w*(?:\s+[A-Za-z_]\w*)*(?:\s*\(\s*\d+(?:\s*,\s*\d+)?\s*\))?(?:\[\])?(?:\s*:=\s*(?:'[^']*'|[\d.]+|true|false|null))?$", re.IGNORECASE)
SAFE_CATALOG_TABLES = frozenset({"pg_class", "pg_namespace", "pg_constraint", "pg_indexes", "pg_attribute", "pg_type", "pg_enum", "pg_proc", "pg_trigger", "pg_tables"})
FORBIDDEN_COND_WORDS = frozenset({"select", "from", "where", "into", "join", "union", "with", "values", "returning", "drop", "delete", "update", "insert", "alter", "create", "truncate", "execute", "perform", "call", "copy", "grant", "revoke", "set", "do", "begin", "end", "loop", "while", "for"})
COND_TOK_RE = re.compile(r"\s*(?:('(?:''|[^'])*')|(\"(?:\"\"|[^\"])+\")|(!=|<>)|([=(),*.])|(\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_]*))")
def _is_safe_do_condition(cond: str) -> bool:
    if "$" in cond or not cond.strip(): return False
    toks, pos, n = [], 0, len(cond)
    while pos < n:
        if cond[pos].isspace(): pos += 1; continue
        m = COND_TOK_RE.match(cond, pos)
        if not m or m.end() == pos: return False
        toks.append(("str" if m.group(1) else "qid" if m.group(2) else "op" if (m.group(3) or m.group(4)) else "num" if m.group(5) else "word", m.group(0).strip())); pos = m.end()
    idx = 1 if (toks and toks[0][0] == "word" and toks[0][1].lower() == "not") else 0
    if idx + 2 >= len(toks) or toks[idx][0] != "word" or toks[idx][1].lower() != "exists" or toks[idx + 1] != ("op", "(") or toks[-1] != ("op", ")"): return False
    inner, depth = toks[idx + 2:-1], 0
    for kv in inner:
        depth += 1 if kv == ("op", "(") else (-1 if kv == ("op", ")") else 0)
        if depth < 0: return False
    if depth != 0 or len(inner) < 4 or inner[0][0] != "word" or inner[0][1].lower() != "select" or inner[2][0] != "word" or inner[2][1].lower() != "from": return False
    if not (inner[1] in (("num", "1"), ("op", "*")) or (inner[1][0] == "word" and inner[1][1].lower() not in FORBIDDEN_COND_WORDS)): return False
    j = 3
    if j + 2 < len(inner) and inner[j][0] == "word" and inner[j][1].lower() in ("information_schema", "pg_catalog") and inner[j + 1] == ("op", ".") and inner[j + 2][0] == "word" and inner[j + 2][1].lower() not in FORBIDDEN_COND_WORDS: j += 3
    elif j < len(inner) and inner[j][0] == "word" and inner[j][1].lower() in SAFE_CATALOG_TABLES: j += 1
    else: return False
    if j == len(inner): return True
    if inner[j][0] != "word" or inner[j][1].lower() != "where" or j + 1 >= len(inner): return False
    w, wn, KWR = inner[j + 1:], len(inner) - (j + 1), FORBIDDEN_COND_WORDS | {"and", "or", "not", "is", "in", "null", "limit", "offset", "order", "group", "having", "fetch", "for"}
    _w = lambda p, s: p < wn and w[p][0] == "word" and w[p][1].lower() == s
    def _atom(p: int) -> int:
        if p >= wn: return -1
        k, v = w[p]; vl = v.lower()
        if k in ("str", "num") or (k == "word" and vl in ("true", "false")): return p + 1
        if k == "word" and vl == "current_schema" and p + 2 < wn and w[p + 1] == ("op", "(") and w[p + 2] == ("op", ")"): return p + 3
        if k == "qid" or (k == "word" and vl not in KWR):
            p += 1
            if p + 1 < wn and w[p] == ("op", ".") and (w[p + 1][0] == "qid" or (w[p + 1][0] == "word" and w[p + 1][1].lower() not in KWR)): p += 2
            return -1 if (p < wn and w[p] == ("op", "(")) else p
        return -1
    def _pred(p: int) -> int:
        if p < wn and w[p] == ("op", "("): q = _or(p + 1); return q + 1 if (0 <= q < wn and w[q] == ("op", ")")) else -1
        q = _atom(p)
        if q < 0 or q >= wn: return -1
        if w[q][0] == "op" and w[q][1] in ("=", "!=", "<>"): return _atom(q + 1)
        if _w(q, "is"): q += 2 if _w(q + 1, "not") else 1; return q + 1 if _w(q, "null") else -1
        if _w(q, "not"): q += 1
        if _w(q, "in") and q + 1 < wn and w[q + 1] == ("op", "("):
            q = _atom(q + 2)
            while q >= 0 and q < wn and w[q] == ("op", ","): q = _atom(q + 1)
            return q + 1 if (q >= 0 and q < wn and w[q] == ("op", ")")) else -1
        return -1
    _not = lambda p: _not(p + 1) if _w(p, "not") else _pred(p)
    def _bin(p: int, kw: str, sub) -> int:
        q = sub(p)
        while q >= 0 and _w(q, kw): q = sub(q + 1)
        return q
    _or = lambda p: _bin(p, "or", lambda x: _bin(x, "and", _not))
    return _or(0) == wn

def _split_sql_stmts(sql_text: str) -> tuple[bool, str, list[str]]:
    stmts, buf, i, n, in_sq, in_eq, in_dq, dtag, bc = [], [], 0, len(sql_text), False, False, False, None, 0
    while i < n:
        ch = sql_text[i]
        if bc > 0:
            if sql_text[i:i+2] == "/*": bc += 1; i += 2
            elif sql_text[i:i+2] == "*/": bc -= 1; i += 2; buf.append(" ")
            else: i += 1
        elif in_eq:
            buf.append(ch)
            if ch == "\\" and i + 1 < n: buf.append(sql_text[i+1]); i += 2
            elif ch == "'" and i + 1 < n and sql_text[i+1] == "'": buf.append("'"); i += 2
            else: in_eq = (ch != "'"); i += 1
        elif in_sq or in_dq:
            q = "'" if in_sq else '"'; buf.append(ch)
            if ch == q and i + 1 < n and sql_text[i+1] == q: buf.append(q); i += 2
            else: in_sq, in_dq, i = (False if ch == q else in_sq), (False if ch == q else in_dq), i + 1
        elif dtag is not None:
            if sql_text.startswith(dtag, i): buf.append(dtag); i += len(dtag); dtag = None
            else: buf.append(ch); i += 1
        elif sql_text[i:i+2] == "--": nl = sql_text.find("\n", i); i = n if nl < 0 else nl + 1; buf.append(" ")
        elif sql_text[i:i+2] == "/*": bc = 1; i += 2
        elif ch in ("E", "e") and i + 1 < n and sql_text[i+1] == "'" and (i == 0 or not (sql_text[i-1].isalnum() or sql_text[i-1] in ("_", "$"))): in_eq = True; buf.append("E'"); i += 2
        elif ch == "'": in_sq = True; buf.append(ch); i += 1
        elif ch == '"': in_dq = True; buf.append(ch); i += 1
        elif ch == "$":
            m = re.match(r"\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$", sql_text[i:])
            if m: dtag = m.group(0); buf.append(dtag); i += len(dtag)
            else: buf.append(ch); i += 1
        elif ch == ";": stmts.append("".join(buf).strip()); buf = []; i += 1
        else: buf.append(ch); i += 1
    if bc > 0 or in_sq or in_eq or in_dq or dtag is not None: return False, "SQL 语法存在未闭合注释或引号（fail-closed）", []
    if "".join(buf).strip(): stmts.append("".join(buf).strip())
    return True, "ok", stmts

def _sanitize_sql(norm: str) -> str:
    return re.sub(r'"(?:""|[^"])*"', '"_id_"', re.sub(r"[Ee]'(?:\\.|''|[^'\\])*'|'(?:''|[^'])*'", "''", norm))

def _check_single_safe_ddl(norm: str, in_do: bool = False) -> tuple[bool, str]:
    if "$" in norm and re.search(r"\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$", norm): return False, f"SQL 包含未识别 dollar-quote，须人工确认: {norm[:70]}"
    if not any(r.match(norm) for r in SAFE_SQL_RES): return False, f"SQL 语句不在安全增量白名单内，须人工确认: {norm[:70]}"
    sanitized = _sanitize_sql(norm)
    if UNSAFE_SQL_TOKEN_RE.search(sanitized): return False, f"SQL 复合语句包含潜在破坏性子句: {norm[:70]}"
    if in_do and not any(r.match(sanitized) for r in DO_SAFE_INNER_RES): return False, f"SQL 匿名块内语句超出受限安全增量语法，须人工确认: {norm[:70]}"
    if re.match(r"^ALTER\s+TABLE\b", sanitized, re.IGNORECASE):
        clauses, depth, cur = [], 0, []
        for ch in sanitized:
            if ch == "," and depth == 0: clauses.append("".join(cur)); cur = []
            else: depth = depth + 1 if ch == "(" else (max(0, depth - 1) if ch == ")" else depth); cur.append(ch)
        for cl in clauses + ["".join(cur)]:
            if re.search(r"\bADD\b", cl, re.IGNORECASE) and re.search(r"\bNOT\s+NULL\b", cl, re.IGNORECASE) and not re.search(r"\bDEFAULT\b", cl, re.IGNORECASE):
                return False, f"SQL 包含无 DEFAULT 的 NOT NULL 列变更，须人工确认: {norm[:70]}"
    return True, "ok"

def is_safe_ddl_sql(sql_text: str) -> tuple[bool, str]:
    ok, err, stmts = _split_sql_stmts(sql_text)
    if not ok: return False, err
    for st in stmts:
        if not st: continue
        norm = re.sub(r"\s+", " ", st).strip()
        if re.match(r"^DO\b", norm, re.IGNORECASE):
            m = DO_BLOCK_RE.match(st.strip())
            if not m or m.group(1) in m.group(2): return False, f"SQL 匿名块格式不在安全白名单内，须人工确认: {norm[:70]}"
            i_ok, i_err, inner = _split_sql_stmts(m.group(2))
            if not i_ok: return False, i_err
            in_decl, safe_cnt = False, 0
            for ist in inner:
                s = re.sub(r"\s+", " ", ist).strip()
                if not s: continue
                if not safe_cnt and re.match(r"^DECLARE\b", s, re.IGNORECASE):
                    s = re.sub(r"^DECLARE\b\s*", "", s, flags=re.IGNORECASE)
                    bm = re.search(r"\bBEGIN\b", s, re.IGNORECASE)
                    if bm:
                        if s[:bm.start()].strip() and not DECL_LINE_RE.match(s[:bm.start()].strip()): return False, f"DO 块 DECLARE 语句不安全: {norm[:70]}"
                        s = s[bm.end():].strip()
                    else:
                        if s and not DECL_LINE_RE.match(s): return False, f"DO 块 DECLARE 语句不安全: {norm[:70]}"
                        in_decl = True; continue
                elif in_decl:
                    if re.match(r"^BEGIN\b", s, re.IGNORECASE): in_decl = False; s = re.sub(r"^BEGIN\b\s*", "", s, flags=re.IGNORECASE)
                    elif DECL_LINE_RE.match(s): continue
                    else: return False, f"DO 块 DECLARE 语句不安全: {s[:70]}"
                while s:
                    m_if = re.match(r"^(?:IF|ELSIF)\b([\s\S]*?)\bTHEN\b\s*", s, re.IGNORECASE)
                    if m_if:
                        if not _is_safe_do_condition(m_if.group(1)): return False, "SQL 匿名块条件非受信任只读目录查询，须人工审批"
                        s = s[m_if.end():].strip(); continue
                    m_ctl = re.match(r"^(?:BEGIN|END\s+IF|END|ELSE|EXCEPTION\s+WHEN\s+(?:duplicate_object|duplicate_column|duplicate_table|unique_violation)\s+THEN\s+NULL)\b\s*", s, re.IGNORECASE)
                    if m_ctl: s = s[m_ctl.end():].strip(); continue
                    break
                if not s: continue
                s_ok, s_msg = _check_single_safe_ddl(s, in_do=True)
                if not s_ok: return False, s_msg
                safe_cnt += 1
            if in_decl or safe_cnt == 0: return False, f"SQL 匿名块未包含有效安全增量语句: {norm[:70]}"
            continue
        s_ok, s_msg = _check_single_safe_ddl(norm)
        if not s_ok: return False, s_msg
    return True, "ok"

def parse_lossless_files(nul_path: str, files_json: str) -> list[str]:
    raw_list = []
    if files_json:
        try: parsed = json.loads(files_json)
        except Exception: sys.stderr.write("INVALID_FILES_JSON\n"); sys.exit(2)
        if not isinstance(parsed, list): sys.stderr.write("INVALID_FILES_JSON\n"); sys.exit(2)
        raw_list = parsed
    elif nul_path and os.path.isfile(nul_path):
        raw_list = [tok.decode("utf-8", errors="strict") for tok in pathlib.Path(nul_path).read_bytes().split(b"\x00") if tok]
    seen, out = set(), []
    for p in raw_list:
        if not isinstance(p, str) or not p: sys.stderr.write("INVALID_FILE_PATH: empty path\n"); sys.exit(2)
        if "\n" in p or "\r" in p or "\x00" in p: sys.stderr.write(f"INVALID_FILE_PATH: control chars forbidden in {p!r}\n"); sys.exit(2)
        if p not in seen: seen.add(p); out.append(p)
    return out

def norm_rel(p: str) -> str:
    s = p.replace("\\", "/")
    while s.startswith("./"): s = s[2:]
    return s
def norm_branch_name(b: str) -> str: return re.sub(r"^(?:refs/heads/|origin/)", "", str(b or "").strip())
def is_commercial_branch(nb: str) -> bool: return nb == "feat/v5-aurora-rewrite" or "v5-aurora-rewrite" in nb
def canonical_sort(val):
    if isinstance(val, list): return [canonical_sort(x) for x in val]
    return {k: canonical_sort(val[k]) for k in sorted(val.keys())} if isinstance(val, dict) else val
def compute_sig(doc: dict) -> str: return hashlib.sha256(("pending-approval-v1\n" + json.dumps(canonical_sort({k: v for k, v in doc.items() if k != "sha256"}), separators=(",", ":"), ensure_ascii=False)).encode("utf-8")).hexdigest()
def verify_sig(doc: dict) -> bool: return bool(re.fullmatch(r"[0-9a-f]{64}", str(doc.get("sha256") or ""))) and hmac.compare_digest(str(doc.get("sha256") or ""), compute_sig(doc))

def write_exclusive_atomic(target: pathlib.Path, content: str):
    tmp_path = target.parent / f".{target.name}.tmp.{os.getpid()}.{secrets.token_hex(6)}"
    fd = os.open(str(tmp_path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(content); fh.flush(); os.fsync(fh.fileno())
        os.chmod(str(tmp_path), 0o644)
        os.replace(str(tmp_path), str(target))
    except Exception:
        try: os.unlink(str(tmp_path))
        except OSError: pass
        raise

def load_verified(pending_dir: str, approval_id: str) -> tuple[pathlib.Path, dict]:
    root = pathlib.Path(pending_dir).resolve()
    fpath = root / f"{approval_id}.json"
    if fpath.parent != root or not ID_RE.fullmatch(approval_id): sys.stderr.write("INVALID_APPROVAL_PATH\n"); sys.exit(2)
    if not os.path.lexists(fpath): sys.stderr.write(f"NOT_FOUND: pending approval {approval_id} not found\n"); sys.exit(10)
    st = os.lstat(fpath)
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode) or fpath.resolve().parent != root: sys.stderr.write(f"INVALID_APPROVAL_FILE: {approval_id}\n"); sys.exit(10)
    try: doc = json.loads(fpath.read_text(encoding="utf-8"))
    except Exception: sys.stderr.write(f"INVALID_JSON: {approval_id}\n"); sys.exit(11)
    if not isinstance(doc, dict) or doc.get("schemaVersion") != 1 or doc.get("id") != approval_id: sys.stderr.write(f"INVALID_SCHEMA: {approval_id}\n"); sys.exit(11)
    if not verify_sig(doc): sys.stderr.write(f"APPROVAL_TAMPERED: sha256 mismatch for {approval_id}\n"); sys.exit(12)
    return fpath, doc

def run_git(repo_dir: str, git_args: list[str]):
    if not repo_dir or not os.path.isdir(repo_dir): return None
    try: return subprocess.run(["git", "-C", repo_dir, "-c", "safe.directory=*", *git_args], capture_output=True, text=True, encoding="utf-8", errors="replace")
    except Exception: return None

def is_safe_vouchers_dir(vouchers_dir: str):
    if not vouchers_dir or not os.path.lexists(vouchers_dir): return None
    vdir_abs = os.path.abspath(vouchers_dir)
    chain = [d for d in dict.fromkeys((vdir_abs, os.path.dirname(vdir_abs), os.path.dirname(os.path.dirname(vdir_abs)))) if d and d != os.path.dirname(d)]
    stats = []
    for d in chain:
        try: dst = os.lstat(d)
        except OSError: return None
        if stat.S_ISLNK(dst.st_mode) or not stat.S_ISDIR(dst.st_mode): return None
        stats.append(dst)
    try: vdir_res = pathlib.Path(vouchers_dir).resolve()
    except Exception: return None
    skip_owner = os.environ.get("OC_GOVERNOR_UNSAFE_TEST_SKIP_OWNER") == "1"
    in_opt = vdir_abs.startswith("/opt/openclaude/") or str(vdir_res).startswith("/opt/openclaude/")
    if not skip_owner and os.geteuid() == 0 and in_opt and any(dst.st_uid != 0 or (dst.st_mode & 0o022) != 0 for dst in stats): return None
    return vdir_res, in_opt

def verify_voucher_file(voucher_arg: str, vouchers_dir: str, now_iso: str, sha_arg: str, norm_branch: str, ddl_hits: list, billing_hits: list, require_bound: bool = False) -> tuple[bool, int, dict]:
    inv_path = {"ok": False, "classification": "human_review_required", "code": "INVALID_VOUCHER_PATH", "branch": norm_branch}
    tampered = {"ok": False, "classification": "human_review_required", "code": "VOUCHER_TAMPERED", "branch": norm_branch}
    dir_ok = is_safe_vouchers_dir(vouchers_dir)
    if dir_ok is None: return False, 23, inv_path
    vdir_res, in_opt = dir_ok
    vpath = pathlib.Path(voucher_arg)
    if not vpath.is_absolute(): vpath = pathlib.Path(vouchers_dir) / (voucher_arg if voucher_arg.endswith(".json") else f"{voucher_arg}.json")
    try: st = os.lstat(vpath)
    except OSError: return False, 23, inv_path
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode) or st.st_size > MAX_BYTES or (st.st_mode & 0o022) != 0: return False, 23, inv_path
    try: vpath_res = vpath.resolve()
    except Exception: return False, 23, inv_path
    skip_owner = os.environ.get("OC_GOVERNOR_UNSAFE_TEST_SKIP_OWNER") == "1"
    v_in_opt = in_opt or os.path.abspath(str(vpath)).startswith("/opt/openclaude/") or str(vpath_res).startswith("/opt/openclaude/")
    if vpath_res.parent != vdir_res or (not skip_owner and os.geteuid() == 0 and v_in_opt and st.st_uid != 0): return False, 23, inv_path
    try: vdoc = json.loads(vpath.read_text(encoding="utf-8"))
    except Exception: return False, 24, tampered
    if not isinstance(vdoc, dict) or type(vdoc.get("schemaVersion")) is not int or vdoc.get("schemaVersion") != 1: return False, 24, tampered
    vid, scope, issued, expires, reason, raw_files = vdoc.get("id"), vdoc.get("scope"), vdoc.get("issuedAt"), vdoc.get("expiresAt"), vdoc.get("reason"), vdoc.get("files")
    if not all(isinstance(x, str) for x in (vid, scope, issued, expires, reason)) or not vid or vid != vpath.stem: return False, 24, tampered
    if not isinstance(raw_files, list) or not all(isinstance(x, str) and x for x in raw_files): return False, 24, tampered
    vsha, vbranch, vapproval_id = vdoc.get("sha") or "", vdoc.get("branch") or "", vdoc.get("approvalId") or ""
    if not all(isinstance(x, str) for x in (vsha, vbranch, vapproval_id)): return False, 24, tampered
    vfiles = sorted(raw_files)
    canonical = f"blast-voucher-v1\nid={vid}\nscope={scope}\nissuedAt={issued}\nexpiresAt={expires}\nfiles={','.join(vfiles)}\nreason={reason}\n"
    if vsha: canonical += f"sha={vsha}\n"
    if vbranch: canonical += f"branch={vbranch}\n"
    if vapproval_id: canonical += f"approvalId={vapproval_id}\n"
    stored_sha = vdoc.get("sha256")
    if not isinstance(stored_sha, str) or not SHA64_RE.fullmatch(stored_sha) or not hmac.compare_digest(stored_sha, hashlib.sha256(canonical.encode("utf-8")).hexdigest()): return False, 24, tampered
    hmac_val = vdoc.get("hmacSha256")
    if hmac_val is not None:
        hmac_path, hmac_ok = vdir_res.parent / ".hmac-key", False
        if isinstance(hmac_val, str) and SHA64_RE.fullmatch(hmac_val) and os.path.lexists(hmac_path):
            try:
                kst = os.lstat(hmac_path)
                if not stat.S_ISLNK(kst.st_mode) and stat.S_ISREG(kst.st_mode) and (kst.st_mode & 0o077) == 0 and (skip_owner or os.geteuid() != 0 or not (in_opt or str(hmac_path.resolve()).startswith("/opt/openclaude/")) or kst.st_uid == 0):
                    kstr = hmac_path.read_text(encoding="utf-8").strip()
                    if kstr: hmac_ok = hmac.compare_digest(hmac_val, hmac.new(kstr.encode("utf-8"), canonical.encode("utf-8"), hashlib.sha256).hexdigest())
            except OSError: hmac_ok = False
        if not hmac_ok: return False, 24, tampered
    try:
        now_dt, expires_dt = dt.datetime.fromisoformat(now_iso.replace("Z", "+00:00")), dt.datetime.fromisoformat(expires.replace("Z", "+00:00"))
        if now_dt.tzinfo is None or expires_dt.tzinfo is None: raise ValueError("naive")
    except Exception: return False, 24, tampered
    if now_dt >= expires_dt: return False, 25, {"ok": False, "classification": "human_review_required", "code": "VOUCHER_EXPIRED", "branch": norm_branch}
    if require_bound:
        if "<inline-sql>" in ddl_hits: return False, 28, {"ok": False, "classification": "human_review_required", "code": "VOUCHER_FILES_UNCOVERED", "uncovered": ["<inline-sql>"]}
        if not SHA40_RE.fullmatch(sha_arg) or not SHA40_RE.fullmatch(vsha) or sha_arg != vsha: return False, 29, {"ok": False, "classification": "human_review_required", "code": "VOUCHER_SHA_MISMATCH", "voucherSha": vsha, "targetSha": sha_arg, "branch": norm_branch}
        vnb = norm_branch_name(vbranch)
        if not norm_branch or not vnb or vnb != norm_branch: return False, 30, {"ok": False, "classification": "human_review_required", "code": "VOUCHER_BRANCH_MISMATCH", "voucherBranch": vbranch, "branch": norm_branch}
    else:
        if vsha and (not SHA40_RE.fullmatch(sha_arg) or sha_arg != vsha): return False, 29, {"ok": False, "classification": "human_review_required", "code": "VOUCHER_SHA_MISMATCH", "voucherSha": vsha, "targetSha": sha_arg, "branch": norm_branch}
        if vbranch and norm_branch_name(vbranch) != norm_branch: return False, 30, {"ok": False, "classification": "human_review_required", "code": "VOUCHER_BRANCH_MISMATCH", "voucherBranch": vbranch, "branch": norm_branch}
    scopes = set(scope.split("+"))
    if ddl_hits and "ddl" not in scopes: return False, 26, {"ok": False, "classification": "human_review_required", "code": "VOUCHER_SCOPE_MISMATCH", "need": "ddl"}
    if billing_hits and "billing" not in scopes: return False, 27, {"ok": False, "classification": "human_review_required", "code": "VOUCHER_SCOPE_MISMATCH", "need": "billing"}
    uncovered = [x for x in (ddl_hits + billing_hits) if x != "<inline-sql>" and x not in set(vfiles)]
    if uncovered: return False, 28, {"ok": False, "classification": "human_review_required", "code": "VOUCHER_FILES_UNCOVERED", "uncovered": uncovered}
    return True, 0, {"vid": vid, "expiresAt": expires, "expiresDt": expires_dt}

def find_matching_voucher(vouchers_dir: str, now_iso: str, sha_arg: str, norm_branch: str, ddl_hits: list, billing_hits: list):
    if not SHA40_RE.fullmatch(sha_arg) or "<inline-sql>" in ddl_hits or (not ddl_hits and not billing_hits) or is_safe_vouchers_dir(vouchers_dir) is None: return None
    try: entries = sorted(pathlib.Path(vouchers_dir).iterdir(), key=lambda p: p.name)
    except OSError: return None
    best = None
    for ent in entries:
        if not VOUCHER_FILE_RE.fullmatch(ent.name): continue
        ok_v, _, v_pay = verify_voucher_file(ent.name, vouchers_dir, now_iso, sha_arg, norm_branch, ddl_hits, billing_hits, require_bound=True)
        if not ok_v: continue
        cand_key = (v_pay["expiresDt"], v_pay["vid"])
        if best is None or cand_key > best[0]: best = (cand_key, v_pay)
    return best[1] if best is not None else None

def reconcile_approving_doc(fpath: pathlib.Path, doc: dict, vouchers_dir: str, approvals_dir: str, breaker_file: str, cost_breaker_file: str) -> tuple[str, dict]:
    kind = str(doc.get("kind") or "")
    cur_ver = int(doc.get("version") or 1)
    sha = str(doc.get("sha") or "")
    pid = str(doc.get("pendingArtifactId") or "")
    pub_gh = bool(doc.get("publishGithubStatus"))
    state, err_msg, resume_def = "unclear", "interrupted approving state could not be verified", "not_applicable"
    if kind == "blast_voucher" and pid:
        resume_def = "not_started"
        vp = pathlib.Path(vouchers_dir) / f"{pid}.json"
        if not os.path.lexists(vp): state, err_msg = "absent", "recovered from interrupted approving state (no voucher created)"
        elif not vp.is_symlink() and vp.is_file():
            try:
                vd = json.loads(vp.read_text(encoding="utf-8"))
                if isinstance(vd, dict) and vd.get("id") == pid and isinstance(vd.get("sha256"), str) and len(vd["sha256"]) == 64: state = "present"
                else: err_msg = f"voucher file {pid}.json schema invalid"
            except Exception: err_msg = f"voucher file {pid}.json unreadable"
        else: err_msg = f"voucher path {pid}.json is symlink or non-regular"
    elif kind == "a0_approval" and SHA40_RE.fullmatch(sha):
        pid = pid or f"a0-{sha}"
        ap = pathlib.Path(approvals_dir) / f"{sha}.json"
        gp = pathlib.Path(approvals_dir) / f"{sha}.gh.json"
        a_exists, g_exists = os.path.lexists(ap), os.path.lexists(gp)
        if not a_exists and not g_exists:
            state, err_msg = "absent", "recovered from interrupted approving state (no A0 artifact created)"
        elif a_exists and not ap.is_symlink() and ap.is_file():
            gh_ok = True
            if pub_gh:
                gh_ok = False
                if g_exists and not gp.is_symlink() and gp.is_file():
                    try: gh_ok = bool(json.loads(gp.read_text(encoding="utf-8")).get("publishedGithubStatus") is True)
                    except Exception: gh_ok = False
            if gh_ok: state = "present"
            else: err_msg = "local A0 file exists without confirmed GitHub status publish"
        else: err_msg = "A0 approval file state inconsistent"
    elif kind == "breaker_unlock":
        pid = pid or f"unlock-{doc.get('id')}"
        tripped_vals = []
        ok_read = True
        for bf in (breaker_file, cost_breaker_file):
            if os.path.lexists(bf):
                try: tripped_vals.append(bool(json.loads(open(bf, encoding="utf-8").read()).get("tripped")))
                except Exception: ok_read = False
        if not ok_read: err_msg = "breaker state files unreadable during reconcile"
        elif any(tripped_vals): state, err_msg = "absent", "recovered from interrupted approving state (breaker still tripped)"
        else: state = "present"

    upd = {**doc}
    upd.pop("pendingArtifactId", None)
    upd["version"] = cur_ver + 1
    if state == "present":
        upd.pop("lastError", None); upd["status"] = "approved"
        dec = dict(upd.get("decision") or {}); dec["issuedArtifactId"] = pid; dec["resumeStatus"] = resume_def; upd["decision"] = dec
    elif state == "absent":
        upd["status"] = "pending"; upd.pop("decision", None); upd["lastError"] = err_msg
    else:
        upd["status"] = "reconcile_required"; upd["lastError"] = err_msg
        if pid:
            dec = dict(upd.get("decision") or {}); dec["issuedArtifactId"] = pid; upd["decision"] = dec
    upd["sha256"] = compute_sig(upd)
    write_exclusive_atomic(fpath, json.dumps(upd, ensure_ascii=False, indent=2) + "\n")
    return upd["status"], upd

if op == "blast_p1":
    branch, nul_path, files_json, sql_snippet, repo_root, sha_arg, base_ref, resolved_base_sha, voucher_arg = args
    norm_branch = norm_branch_name(branch)
    files = parse_lossless_files(nul_path, files_json)
    def emit_final(code_rc, payload):
        print(json.dumps({"phase": "final", "exitCode": code_rc, "payload": payload}, ensure_ascii=False)); sys.exit(0)
    if is_commercial_branch(norm_branch):
        emit_final(21, {"ok": False, "classification": "absolute_reject", "code": "COMMERCIAL_BRANCH_HARD_LOCK", "branch": branch, "message": "Physical hard-lock: commercial branch feat/v5-aurora-rewrite is strictly off-limits"})
    valid_sha = bool(SHA40_RE.fullmatch(sha_arg))
    gchk = run_git(repo_root, ["rev-parse", "--git-dir"]) if valid_sha else None
    git_ok = bool(gchk is not None and gchk.returncode == 0)
    if valid_sha and len(files) == 0 and not sql_snippet:
        if not git_ok:
            emit_final(22, {"ok": False, "classification": "human_review_required", "code": "EMPTY_FILE_LIST_UNVERIFIED", "branch": branch, "semanticReason": "传入了 --sha 但文件清单为空且无法通过 git 验证为空提交（fail-closed）"})
        chk = run_git(repo_root, ["diff", "--name-only", f"{resolved_base_sha}...{sha_arg}"] if resolved_base_sha else ["diff-tree", "--no-commit-id", "--root", "-r", "--name-only", sha_arg])
        if chk is None or chk.returncode != 0 or any(line for line in chk.stdout.splitlines() if line):
            emit_final(22, {"ok": False, "classification": "human_review_required", "code": "EMPTY_FILE_LIST_MISMATCH", "branch": branch, "semanticReason": "传入的文件清单为空但目标提交存在变更文件或 diff 校验失败（fail-closed）"})
    deleted_paths = set()
    if git_ok:
        st_cmd = ["diff", "-z", "--name-status", f"{resolved_base_sha}...{sha_arg}"] if resolved_base_sha else ["diff-tree", "--no-commit-id", "--root", "-r", "-z", "--name-status", sha_arg]
        st_res = subprocess.run(["git", "-C", repo_root, "-c", "safe.directory=*", *st_cmd], capture_output=True)
        if st_res.returncode == 0:
            toks, idx = st_res.stdout.split(b"\x00"), 0
            while idx < len(toks):
                if not toks[idx]: idx += 1; continue
                sc = toks[idx].decode("utf-8", errors="replace"); idx += 1
                if sc.startswith(("R", "C")):
                    if idx + 1 < len(toks): deleted_paths.add(norm_rel(toks[idx].decode("utf-8", errors="replace"))); idx += 2
                elif idx < len(toks):
                    if sc == "D": deleted_paths.add(norm_rel(toks[idx].decode("utf-8", errors="replace")))
                    idx += 1
    ddl_hits, core_b, noncore_b, sql_reason = [], [], [], ""
    if sql_snippet:
        safe_ok, safe_msg = is_safe_ddl_sql(sql_snippet)
        if not safe_ok: ddl_hits.append("<inline-sql>"); sql_reason = safe_msg
    root_path = pathlib.Path(repo_root)
    for f in files:
        nf = norm_rel(f)
        _classify_billing(f, nf, core_b, noncore_b)
        if nf.endswith(".sql") or "/migrations/" in nf:
            if valid_sha:
                if not git_ok: ddl_hits.append(f); sql_reason = f"无法通过 git 读取目标提交 SQL 文件 {f}（fail-closed）"
                elif nf in deleted_paths and (run_git(repo_root, ["cat-file", "-e", f"{sha_arg}:{nf}"]) or type("R", (), {"returncode": 1})()).returncode != 0: pass
                else:
                    gshow = run_git(repo_root, ["show", f"{sha_arg}:{nf}"])
                    if gshow is None or gshow.returncode != 0: ddl_hits.append(f); sql_reason = f"git show {sha_arg[:12]}:{nf} 读取 SQL 文件失败，拒绝回退脏工作树（fail-closed）"
                    else:
                        s_ok, s_msg = is_safe_ddl_sql(gshow.stdout)
                        if not s_ok: ddl_hits.append(f); sql_reason = s_msg
            else:
                cand = pathlib.Path(f) if pathlib.Path(f).is_absolute() else root_path / f
                if cand.is_file():
                    s_ok, s_msg = is_safe_ddl_sql(cand.read_text(encoding="utf-8", errors="replace"))
                    if not s_ok: ddl_hits.append(f); sql_reason = s_msg
                else: ddl_hits.append(f); sql_reason = f"SQL 文件 {f} 不存在，无法证明安全增量白名单（fail-closed）"
    # B6: Only short-circuit auto_pass when NO --voucher was supplied; explicit --voucher MUST still validate sha/branch!
    if not ddl_hits and not core_b and not voucher_arg:
        pay = {"ok": True, "classification": "auto_pass", "branch": branch, "checkedFiles": len(files)}
        if noncore_b: pay["autoApprovedNonCoreBilling"] = True; pay["nonCoreBillingFiles"] = noncore_b
        emit_final(0, pay)
    print(json.dumps({"phase": "evaluate", "normBranch": norm_branch, "checkedFiles": len(files), "ddlHits": ddl_hits, "coreBillingHits": core_b, "nonCoreBillingHits": noncore_b, "sqlReadFailReason": sql_reason}, ensure_ascii=False))

elif op == "blast_p3":
    branch, p1_raw, ts_raw, voucher_arg, vouchers_dir, now_iso, sha_arg = args
    p1, ts_res = json.loads(p1_raw), json.loads(ts_raw)
    norm_branch, ddl_hits, core_b, noncore_b, checked_files = p1["normBranch"], p1["ddlHits"], p1["coreBillingHits"], p1["nonCoreBillingHits"], p1["checkedFiles"]
    valid_sha = bool(SHA40_RE.fullmatch(sha_arg))
    if not ddl_hits and not core_b:
        # B6: Explicit voucher supplied on clean/noncore-only files — still enforce voucher integrity/sha/branch!
        ok_v, v_rc, v_pay = verify_voucher_file(voucher_arg, vouchers_dir, now_iso, sha_arg, norm_branch, [], [])
        if not ok_v: print(json.dumps(v_pay, ensure_ascii=False)); sys.exit(v_rc)
        pay = {"ok": True, "classification": "auto_pass", "branch": branch, "voucherId": v_pay["vid"], "checkedFiles": checked_files}
        if noncore_b: pay["autoApprovedNonCoreBilling"] = True; pay["nonCoreBillingFiles"] = noncore_b
        print(json.dumps(pay, ensure_ascii=False)); sys.exit(0)
    if not ddl_hits and core_b and valid_sha and ts_res.get("ok"):
        v_id = None
        if voucher_arg:
            ok_v, v_rc, v_pay = verify_voucher_file(voucher_arg, vouchers_dir, now_iso, sha_arg, norm_branch, [], [])
            if not ok_v: print(json.dumps(v_pay, ensure_ascii=False)); sys.exit(v_rc)
            v_id = v_pay["vid"]
        pay = {"ok": True, "classification": "auto_pass", "branch": branch, "semanticNoRuntimeBillingChange": True, "coreBillingFiles": core_b, "checkedFiles": checked_files}
        if noncore_b: pay["autoApprovedNonCoreBilling"] = True; pay["nonCoreBillingFiles"] = noncore_b
        if v_id: pay["voucherId"] = v_id
        print(json.dumps(pay, ensure_ascii=False)); sys.exit(0)
    semantic_reason = (p1.get("sqlReadFailReason") or "检测到破坏性或非白名单数据库变更，需要你确认") if ddl_hits else (str(ts_res.get("reason") or "") if (valid_sha and ts_res.get("reason")) else "命中核心计费/支付生产文件，需要你确认")
    billing_hits = core_b
    if not voucher_arg:
        auto_v = find_matching_voucher(vouchers_dir, now_iso, sha_arg, norm_branch, ddl_hits, billing_hits)
        if auto_v is not None:
            print(json.dumps({"ok": True, "classification": "human_review_required", "branch": branch, "voucherId": auto_v["vid"], "voucherAutoDiscovered": True, "ddlFiles": ddl_hits, "billingFiles": billing_hits, "coreBillingFiles": core_b, "nonCoreBillingFiles": noncore_b}, ensure_ascii=False)); sys.exit(0)
        code = "DESTRUCTIVE_DDL_LOCKED" if ddl_hits else "BILLING_CORE_LOCKED"
        risk_cat = "ux_degradation" if code == "DESTRUCTIVE_DDL_LOCKED" else "billing_change"
        print(json.dumps({"ok": False, "classification": "human_review_required", "code": code, "riskCategory": risk_cat, "branch": branch, "ddlFiles": ddl_hits, "billingFiles": billing_hits, "coreBillingFiles": core_b, "nonCoreBillingFiles": noncore_b, "semanticReason": semantic_reason}, ensure_ascii=False)); sys.exit(22)
    ok_v, v_rc, v_pay = verify_voucher_file(voucher_arg, vouchers_dir, now_iso, sha_arg, norm_branch, ddl_hits, billing_hits)
    if not ok_v: print(json.dumps(v_pay, ensure_ascii=False)); sys.exit(v_rc)
    print(json.dumps({"ok": True, "classification": "human_review_required", "branch": branch, "voucherId": v_pay["vid"], "ddlFiles": ddl_hits, "billingFiles": billing_hits, "coreBillingFiles": core_b, "nonCoreBillingFiles": noncore_b}, ensure_ascii=False))

elif op == "record":
    (approval_id, kind, code, branch, sha, train_id, ticket_id, scope, title_arg, summary_arg, ttl_s, repo_root, total_files_s, files_nul_path, files_json, now_iso, pending_dir, classification, allow_whole_s, steward_raw, risk_cat_arg) = args
    norm_branch = norm_branch_name(branch)
    if is_commercial_branch(norm_branch): sys.stderr.write("COMMERCIAL_BRANCH_HARD_LOCK: 商业分支永久硬锁\n"); sys.exit(21)
    ttl = float(ttl_s)
    if ttl <= 0 or ttl > 720: sys.stderr.write("--ttl-hours must be in (0, 720]\n"); sys.exit(2)
    pending_root = pathlib.Path(pending_dir).resolve()
    dest_path = pending_root / f"{approval_id}.json"
    if dest_path.parent != pending_root: sys.stderr.write("invalid approval path\n"); sys.exit(2)
    now_dt = dt.datetime.fromisoformat(now_iso.replace("Z", "+00:00"))
    next_version, next_round, prev_expired_at = 1, 1, ""
    if os.path.lexists(dest_path):
        st = os.lstat(dest_path)
        if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode): sys.stderr.write(f"INVALID_APPROVAL_FILE: {dest_path}\n"); sys.exit(1)
        existing = json.loads(dest_path.read_text(encoding="utf-8"))
        if not isinstance(existing, dict) or existing.get("id") != approval_id: sys.stderr.write(f"INVALID_EXISTING_SCHEMA: {dest_path}\n"); sys.exit(1)
        ex_status = str(existing.get("status") or "")
        ex_expired = ex_status == "expired"
        if ex_status == "pending":
            try: ex_expired = now_dt >= dt.datetime.fromisoformat(str(existing.get("expiresAt") or "").replace("Z", "+00:00"))
            except Exception: ex_expired = False
        if not ex_expired:
            print(json.dumps({"written": False, "doc": existing}, ensure_ascii=False)); sys.exit(0)
        ts_compact = now_dt.strftime("%Y%m%dT%H%M%SZ")
        arch_path, suffix = pending_root / f"{approval_id}.expired-{ts_compact}.json", 1
        while os.path.lexists(arch_path):
            arch_path = pending_root / f"{approval_id}.expired-{ts_compact}-{suffix}.json"; suffix += 1
        archived = {**existing, "status": "expired"}; archived["sha256"] = compute_sig(archived)
        write_exclusive_atomic(arch_path, json.dumps(archived, ensure_ascii=False, indent=2) + "\n")
        next_version, next_round, prev_expired_at = int(existing.get("version") or 1) + 1, int(existing.get("round") or 1) + 1, str(existing.get("expiresAt") or "")

    files = sorted(parse_lossless_files(files_nul_path, files_json))
    total_files = int(total_files_s) if total_files_s else len(files)
    core_b, noncore_b, ddl_f, root_path = [], [], [], pathlib.Path(repo_root)
    for f in files:
        nf = norm_rel(f)
        _classify_billing(f, nf, core_b, noncore_b)
        if nf.endswith(".sql") or "/migrations/" in nf:
            sql_text = None
            if sha:
                gshow = run_git(repo_root, ["show", f"{sha}:{nf}"])
                if gshow is not None and gshow.returncode == 0: sql_text = gshow.stdout
                else: ddl_f.append(f); continue
            else:
                cand = pathlib.Path(f) if pathlib.Path(f).is_absolute() else root_path / f
                if cand.is_file(): sql_text = cand.read_text(encoding="utf-8", errors="replace")
            if sql_text is None or not is_safe_ddl_sql(sql_text)[0]: ddl_f.append(f)

    has_ddl = bool(ddl_f) or code == "DESTRUCTIVE_DDL_LOCKED" or (scope and "ddl" in scope.split("+"))
    if not scope and kind == "blast_voucher":
        scope = "ddl+billing" if (has_ddl and (core_b or noncore_b)) else ("ddl" if has_ddl else "billing")
    if risk_cat_arg in ("ux_degradation", "billing_change"): risk_cat = risk_cat_arg
    elif code == "BILLING_CORE_LOCKED" or scope == "billing" or (core_b and not has_ddl): risk_cat = "billing_change"
    elif has_ddl or code == "DESTRUCTIVE_DDL_LOCKED" or kind == "breaker_unlock": risk_cat = "ux_degradation"
    elif any(PAYMENT_DIR_RE.search(norm_rel(f)) or BILLING_DIR_RE.search(norm_rel(f)) for f in files): risk_cat = "billing_change"
    else: risk_cat = "ux_degradation"

    comm_detail = "仅作用于个人版，完全不会影响商业版" if norm_branch == "feat/v5-selfhost" else "仅作用于当前测试分支，完全不会影响商业版"
    is_billing_risk = risk_cat == "billing_change" or bool(core_b)
    b_light = {"key": "billingFormulaSafety", "label": "计费方式影响", "level": "red" if is_billing_risk else "green", "detail": "涉及核心计费或支付逻辑，可能会改变扣费或定价方式" if is_billing_risk else "不涉及扣费、定价或支付逻辑，计费方式不变"}
    d_light = {"key": "dataIntegrity", "label": "数据与体验安全", "level": "red" if has_ddl else ("yellow" if risk_cat == "ux_degradation" else "green"), "detail": "包含数据库删除或不可逆修改，可能影响用户数据或线上体验" if has_ddl else ("涉及用户体验底线或稳定性防线，请确认不会导致体验下降" if risk_cat == "ux_degradation" else "无删表或破坏性结构修改，用户数据安全")}
    r_light = {"key": "rollbackSafety", "label": "回滚恢复能力", "level": "yellow" if has_ddl else "green", "detail": "含数据库结构变更，上线后若异常需要额外人工回滚" if has_ddl else "支持一键秒级回滚，异常可自动恢复到上一版本"}
    safety_lights = [{"key": "commercialIsolation", "label": "商业版隔离", "level": "green", "detail": comm_detail}, b_light, d_light, r_light]

    st_parsed = json.loads(steward_raw)
    steward_verdict = {"present": bool(st_parsed.get("present")), "verdict": str(st_parsed.get("verdict") or "missing")}
    for k in ("authorFamily", "stewardFamily", "stewardModel", "recordedAt", "summary"):
        if isinstance(st_parsed.get(k), str) and st_parsed[k].strip(): steward_verdict[k] = st_parsed[k].strip()
    if steward_verdict["present"]: steward_verdict["hmacVerified"] = bool(st_parsed.get("hmacVerified"))

    commit_subject = ""
    if sha:
        glog = run_git(repo_root, ["log", "-1", "--format=%s", sha])
        if glog is not None and glog.returncode == 0 and glog.stdout.strip(): commit_subject = glog.stdout.strip().splitlines()[0]
    clean_subj = re.sub(r"^(?:feat|fix|bug|refactor|chore|ci|docs|perf|test|revert|style|build)(?:\([^)]*\))?!?:\s*", "", commit_subject.strip(), flags=re.IGNORECASE)
    clean_subj = re.sub(r"\[?OCV5-\d+\]?:?\s*", "", clean_subj, flags=re.IGNORECASE)
    clean_subj = re.sub(r"\b[0-9a-f]{12,40}\b", "", clean_subj)
    clean_subj = re.sub(r"\s+", " ", clean_subj).strip(" ：:;-")

    if clean_subj: what_changed = f"本次改动：{clean_subj}（涉及 {len(files)} 个关键文件）。" if files else f"本次改动：{clean_subj}。"
    elif has_ddl: what_changed = f"本次改动包含 {len(ddl_f) or len(files) or 1} 处数据库结构删除或修改操作。"
    elif risk_cat == "billing_change": what_changed = f"本次改动修改了 {len(core_b) or len(files) or 1} 个核心计费或支付逻辑文件。"
    elif kind == "breaker_unlock": what_changed = "线上近期触发了自动保护暂停，现申请恢复个人版自动发版。"
    else: what_changed = f"本次改动调整了 {len(files) or total_files or 1} 项影响用户体验或核心保护的设置。"

    if has_ddl or code == "DESTRUCTIVE_DDL_LOCKED": why_need_you = "命中「用户体验可能下降」：检测到可能影响用户数据或线上体验的破坏性数据库变更，确认后才会放行。"
    elif risk_cat == "billing_change": why_need_you = "命中「计费方式可能变化」：本次改动涉及核心扣费/定价逻辑，可能会改变计费方式，需要你确认后才会生效。"
    elif kind == "breaker_unlock": why_need_you = "命中「用户体验可能下降」：近期连续出现异常回滚，系统已暂停自动发版，确认问题已修复后才会恢复。"
    else: why_need_you = "命中「用户体验可能下降」：本次改动放宽了页面体验或稳定性保护底线，可能会导致用户体验变差，需要你确认后才会放行。"

    sv = steward_verdict["verdict"]
    if sv == "veto": recommendation = {"action": "reject", "label": "建议驳回整改", "reason": "独立复核发现明确阻断风险，建议先驳回退回助手修复后再提交。"}
    elif sv == "invalid": recommendation = {"action": "caution", "label": "请核对后再决定", "reason": "独立复核结果未通过核验，请先确认改动细节无误后再拍板。"}
    elif sv == "approve" and steward_verdict.get("hmacVerified") is True:
        if has_ddl: recommendation = {"action": "caution", "label": "请核对后再决定", "reason": "独立复核已通过，但包含数据库结构变更，请确认无数据丢失风险后再批准。"}
        elif risk_cat == "billing_change": recommendation = {"action": "approve", "label": "建议批准", "reason": "独立复核已通过，商业版已隔离且支持秒级回滚；若计费调整符合预期可直接批准。"}
        else: recommendation = {"action": "approve", "label": "建议批准", "reason": "独立复核已通过，影响范围可控且支持秒级回滚，可直接批准放行。"}
    else:
        if has_ddl: recommendation = {"action": "caution", "label": "请核对后再决定", "reason": "本次包含数据库结构删除或修改且暂无独立复核结论，请确认不会影响用户数据后再决定。"}
        elif risk_cat == "billing_change": recommendation = {"action": "caution", "label": "请核对后再决定", "reason": "本次涉及核心扣费逻辑且暂无独立复核结论，请确认计费方式调整符合预期后再决定。"}
        else: recommendation = {"action": "caution", "label": "请核对后再决定", "reason": "暂无独立复核结论，请先确认改动不会导致用户体验下降后再决定。"}

    if title_arg.strip(): title = title_arg.strip()
    elif has_ddl or code == "DESTRUCTIVE_DDL_LOCKED": title = "数据库结构删除/修改，需要你确认"
    elif risk_cat == "billing_change": title = "计费规则变更，需要你确认"
    elif kind == "breaker_unlock": title = "恢复自动发版，需要你确认"
    else: title = "可能影响用户体验的变更，需要你确认"

    plain_summary = summary_arg.strip() if summary_arg.strip() else f"{what_changed}{why_need_you}"
    if kind == "blast_voucher":
        approve_effect = "立即放行本次变更并自动继续发版，同时自动通知助手继续后续处理"
        reject_effect = "拦下本次变更，线上版本与计费方式保持不变，退回助手调整" if risk_cat == "billing_change" else "拦下本次变更，线上版本与用户数据保持不变，退回助手调整"
    elif kind == "a0_approval":
        approve_effect, reject_effect = "立即放行本次变更并继续发版流程，同时自动通知助手继续后续处理", "拦下本次变更，原有体验与计费保护底线保持不变，退回助手调整"
    else:
        approve_effect, reject_effect = "解除暂停状态，恢复个人版自动发版，并通知助手继续处理", "保持暂停状态，继续拦截新改动上线，直到问题彻底解决"

    doc = {
        "schemaVersion": 1, "version": next_version, "round": next_round, "classification": classification, "id": approval_id,
        "kind": kind, "status": "pending", "code": code, "riskCategory": risk_cat, "branch": norm_branch,
        "title": title, "plainSummary": plain_summary, "whatChanged": what_changed, "whyNeedYou": why_need_you,
        "recommendation": recommendation, "approveEffect": approve_effect, "rejectEffect": reject_effect,
        "files": files, "totalChangedFiles": total_files, "safetyLights": safety_lights, "stewardVerdict": steward_verdict,
        "createdAt": now_dt.strftime("%Y-%m-%dT%H:%M:%SZ"), "expiresAt": (now_dt + dt.timedelta(hours=ttl)).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    if scope: doc["scope"] = scope
    if sha: doc["sha"] = sha
    if train_id: doc["trainId"] = train_id
    if ticket_id: doc["ticketId"] = ticket_id
    if allow_whole_s == "1": doc["allowWholeCommit"] = True
    if prev_expired_at: doc["previousExpiredAt"] = prev_expired_at
    doc["sha256"] = compute_sig(doc)
    write_exclusive_atomic(dest_path, json.dumps(doc, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"written": True, "doc": doc}, ensure_ascii=False))

elif op == "list":
    pending_dir, status_filter, limit_s, now_iso = args
    limit, now_dt, items = min(int(limit_s), 500), dt.datetime.fromisoformat(now_iso.replace("Z", "+00:00")), []
    root = pathlib.Path(pending_dir)
    if root.is_dir() and not root.is_symlink():
        root_resolved = root.resolve()
        for ent in sorted(root.iterdir()):
            if not ID_FILE_RE.fullmatch(ent.name): continue
            try: st = os.lstat(ent)
            except OSError: continue
            if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode) or st.st_size > MAX_BYTES or ent.resolve().parent != root_resolved: continue
            try: doc = json.loads(ent.read_text(encoding="utf-8"))
            except Exception: continue
            if not isinstance(doc, dict) or doc.get("schemaVersion") != 1 or doc.get("id") != ent.stem or not verify_sig(doc): continue
            eff = str(doc.get("status") or "")
            if eff not in VALID_STATUSES: continue
            if eff == "pending":
                try:
                    if now_dt >= dt.datetime.fromisoformat(str(doc.get("expiresAt") or "").replace("Z", "+00:00")): eff = "expired"; doc = {**doc, "status": "expired"}
                except Exception: continue
            if status_filter == "all" or eff == status_filter: items.append(doc)
    items.sort(key=lambda d: (str(d.get("createdAt") or ""), str(d.get("id") or "")), reverse=True)
    print(json.dumps({"items": items[:limit]}, ensure_ascii=False, indent=2))

elif op == "reconcile":
    pending_dir, vouchers_dir, approvals_dir, breaker_file, cost_breaker_file, approval_id = args
    fpath, doc = load_verified(pending_dir, approval_id)
    if doc.get("status") == "approving":
        _, doc = reconcile_approving_doc(fpath, doc, vouchers_dir, approvals_dir, breaker_file, cost_breaker_file)
    print(json.dumps(doc, ensure_ascii=False, indent=2))

elif op == "decide_prep":
    pending_dir, vouchers_dir, approvals_dir, breaker_file, cost_breaker_file, approval_id, decision, actor, note, exp_ver_s, exp_sha, allow_whole_s, pub_gh_s, now_iso = args
    fpath, doc = load_verified(pending_dir, approval_id)
    norm_branch = norm_branch_name(doc.get("branch"))
    if is_commercial_branch(norm_branch): sys.stderr.write("COMMERCIAL_BRANCH_HARD_LOCK: commercial branch cannot be approved\n"); sys.exit(21)
    if str(doc.get("classification") or "") == "absolute_reject": sys.stderr.write("ABSOLUTE_REJECT_FORBIDDEN\n"); sys.exit(21)

    # B4: Self-heal stale 'approving' state inside per-ID flock before proceeding!
    if str(doc.get("status") or "") == "approving":
        rec_st, rec_doc = reconcile_approving_doc(fpath, doc, vouchers_dir, approvals_dir, breaker_file, cost_breaker_file)
        if rec_st == "approved":
            if decision == "approve":
                print(json.dumps({"done": True, "doc": rec_doc}, ensure_ascii=False)); sys.exit(0)
            sys.stderr.write(f"ALREADY_RESOLVED: approval {approval_id} reconciled as approved\n"); sys.exit(15)
        elif rec_st == "reconcile_required":
            sys.stderr.write(f"RECONCILE_REQUIRED: {rec_doc.get('lastError')}\n"); sys.exit(20)
        doc = rec_doc  # Rolled back to pending cleanly!

    cur_ver = int(doc.get("version") or 1)
    if exp_ver_s and cur_ver != int(exp_ver_s): sys.stderr.write(f"CONFLICT_VERSION_MISMATCH: expected={exp_ver_s} actual={cur_ver}\n"); sys.exit(17)
    if exp_sha and not hmac.compare_digest(str(doc.get("sha256") or ""), exp_sha): sys.stderr.write("CONFLICT_SHA256_MISMATCH\n"); sys.exit(17)
    cur_status = str(doc.get("status") or "")
    if cur_status != "pending": sys.stderr.write(f"ALREADY_RESOLVED: approval {approval_id} is already in state '{cur_status}'\n"); sys.exit(15)
    now_dt = dt.datetime.fromisoformat(now_iso.replace("Z", "+00:00"))
    if now_dt >= dt.datetime.fromisoformat(str(doc.get("expiresAt") or "").replace("Z", "+00:00")):
        sys.stderr.write(f"APPROVAL_EXPIRED: approval {approval_id} expired at {doc.get('expiresAt')}\n"); sys.exit(16)

    clean_note = " ".join(note.replace("\r", " ").replace("\n", " ").split()).strip()
    dec_obj = {"action": decision, "decidedBy": actor.strip(), "decidedAt": now_dt.strftime("%Y-%m-%dT%H:%M:%SZ")}
    if clean_note: dec_obj["note"] = clean_note
    if decision == "reject":
        upd = {**doc}; upd.pop("lastError", None); upd.pop("pendingArtifactId", None); upd["status"] = "rejected"; upd["version"] = cur_ver + 1; upd["decision"] = dec_obj; upd["sha256"] = compute_sig(upd)
        write_exclusive_atomic(fpath, json.dumps(upd, ensure_ascii=False, indent=2) + "\n")
        print(json.dumps({"done": True, "doc": upd}, ensure_ascii=False)); sys.exit(0)

    kind = str(doc.get("kind") or "")
    files = [x for x in (doc.get("files") or []) if isinstance(x, str) and x]
    sha = str(doc.get("sha") or "").strip()
    scope = str(doc.get("scope") or "").strip()
    if kind == "blast_voucher":
        scope = scope or ("ddl" if doc.get("code") == "DESTRUCTIVE_DDL_LOCKED" else "billing")
        if scope not in ("ddl", "billing", "ddl+billing") or not files: sys.stderr.write("INVALID_BLAST_APPROVAL\n"); sys.exit(11)
        pending_aid = "bv-" + hashlib.sha256(f"{approval_id}:{cur_ver}:{sha}".encode("utf-8")).hexdigest()[:16]
    elif kind == "a0_approval":
        if not SHA40_RE.fullmatch(sha): sys.stderr.write("MISSING_A0_SHA\n"); sys.exit(11)
        if not files and allow_whole_s != "1" and doc.get("allowWholeCommit") is not True:
            sys.stderr.write("A0_WHOLE_COMMIT_CONFIRM_REQUIRED: empty files list requires explicit --allow-whole-commit\n"); sys.exit(14)
        pending_aid = f"a0-{sha}"
    elif kind == "breaker_unlock":
        if len(clean_note) < 8: sys.stderr.write("REASON_TOO_SHORT: breaker_unlock requires --note with at least 8 characters\n"); sys.exit(14)
        pending_aid = f"unlock-{approval_id}"
    else: sys.stderr.write(f"INVALID_KIND: {kind}\n"); sys.exit(11)

    app = {**doc}; app.pop("lastError", None); app["status"] = "approving"; app["version"] = cur_ver; app["pendingArtifactId"] = pending_aid; app["decision"] = dec_obj
    if kind == "a0_approval" and pub_gh_s == "1": app["publishGithubStatus"] = True
    app["sha256"] = compute_sig(app)
    write_exclusive_atomic(fpath, json.dumps(app, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"done": False, "kind": kind, "scope": scope, "branch": norm_branch, "sha": sha, "files": files, "curVersion": cur_ver, "cleanNote": clean_note, "pendingArtifactId": pending_aid}, ensure_ascii=False))

elif op == "decide_commit":
    pending_dir, vouchers_dir, approvals_dir, breaker_file, approval_id, kind, sha, cur_ver_s, mint_rc_s, issued_id, pending_aid, default_resume, pub_gh_s, mint_out, fail_after_s = args
    cur_ver, mint_rc, fail_after, pub_gh = int(cur_ver_s), int(mint_rc_s), fail_after_s == "1", pub_gh_s == "1"
    fpath = pathlib.Path(pending_dir).resolve() / f"{approval_id}.json"
    doc = json.loads(fpath.read_text(encoding="utf-8"))
    gh_verified = True
    if kind == "a0_approval" and pub_gh and mint_rc == 0:
        gp = pathlib.Path(approvals_dir) / f"{sha}.gh.json"
        try: gh_verified = gp.is_file() and not gp.is_symlink() and json.loads(gp.read_text(encoding="utf-8")).get("publishedGithubStatus") is True
        except Exception: gh_verified = False
    if mint_rc == 0 and issued_id and gh_verified and not fail_after:
        upd = {**doc}; upd.pop("lastError", None); upd.pop("pendingArtifactId", None); upd["status"] = "approved"; upd["version"] = cur_ver + 1
        dec = dict(upd.get("decision") or {}); dec["issuedArtifactId"] = issued_id; dec["resumeStatus"] = default_resume; upd["decision"] = dec; upd["sha256"] = compute_sig(upd)
        write_exclusive_atomic(fpath, json.dumps(upd, ensure_ascii=False, indent=2) + "\n")
        print(json.dumps(upd, ensure_ascii=False, indent=2)); sys.exit(0)

    detected = issued_id if (issued_id and (mint_rc == 0 or fail_after)) else ""
    if not detected:
        if kind == "blast_voucher" and pending_aid and os.path.isfile(os.path.join(vouchers_dir, f"{pending_aid}.json")): detected = pending_aid
        elif kind == "a0_approval" and sha and os.path.isfile(os.path.join(approvals_dir, f"{sha}.json")): detected = pending_aid or f"a0-{sha}"
        elif kind == "breaker_unlock" and os.path.isfile(breaker_file):
            try:
                if json.loads(open(breaker_file, encoding="utf-8").read()).get("tripped") is False: detected = pending_aid or f"unlock-{approval_id}"
            except Exception: pass
    err_summary = ("simulated post-mint persistence error" if fail_after else ("GitHub status publish not confirmed" if not gh_verified else mint_out.strip() or f"mint failed (rc={mint_rc})"))[:300]
    upd = {**doc}; upd.pop("pendingArtifactId", None); upd["version"] = cur_ver + 1; upd["lastError"] = err_summary
    if detected:
        upd["status"] = "reconcile_required"
        dec = dict(upd.get("decision") or {}); dec["issuedArtifactId"] = detected; upd["decision"] = dec; upd["sha256"] = compute_sig(upd)
        write_exclusive_atomic(fpath, json.dumps(upd, ensure_ascii=False, indent=2) + "\n")
        sys.stderr.write(f"RECONCILE_REQUIRED: artifact {detected} already created ({err_summary})\n"); sys.exit(20)
    upd["status"] = "pending"; upd.pop("decision", None); upd["sha256"] = compute_sig(upd)
    write_exclusive_atomic(fpath, json.dumps(upd, ensure_ascii=False, indent=2) + "\n")
    sys.stderr.write(f"ARTIFACT_MINT_FAILED: rolled back to pending ({err_summary})\n"); sys.exit(1)

elif op == "update_resume":
    pending_dir, approval_id, resume_status, claim_from, expected_unit, resume_unit, train_id, resume_detail, now_iso = args
    fpath, doc = load_verified(pending_dir, approval_id)
    if doc.get("status") != "approved": sys.stderr.write(f"NOT_APPROVED: cannot update resume status when status='{doc.get('status')}'\n"); sys.exit(15)
    dec = dict(doc.get("decision") or {})
    cur_resume = str(dec.get("resumeStatus") or "not_started")
    if not claim_from.strip() and not expected_unit.strip() and cur_resume in ("starting", "started", "running", "completed"):
        sys.stderr.write(f"RESUME_FENCE_REQUIRED: cannot overwrite active/terminal resumeStatus='{cur_resume}' without --claim-from or --expected-unit\n"); sys.exit(18)
    if claim_from.strip():
        allowed = {s.strip() for s in claim_from.split(",") if s.strip()}
        if cur_resume not in allowed:
            sys.stderr.write(f"RESUME_ALREADY_CLAIMED: current resumeStatus='{cur_resume}' not in [{claim_from}]\n"); sys.exit(18)
    if expected_unit.strip():
        cur_unit = str(dec.get("resumeUnit") or "").strip()
        if cur_unit != expected_unit.strip():
            sys.stderr.write(f"RESUME_UNIT_MISMATCH: current resumeUnit='{cur_unit}' != expected '{expected_unit.strip()}'\n"); sys.exit(18)
    dec["resumeStatus"] = resume_status
    if resume_status == "starting":
        now_dt = dt.datetime.fromisoformat(now_iso.replace("Z", "+00:00"))
        dec["resumeClaimExpiresAt"] = (now_dt + dt.timedelta(seconds=60)).strftime("%Y-%m-%dT%H:%M:%SZ")
    else:
        dec.pop("resumeClaimExpiresAt", None)
    if resume_unit.strip():
        dec["resumeUnit"] = resume_unit.strip()
    elif resume_status in ("not_started_busy", "head_moved", "not_applicable", "skipped"):
        dec.pop("resumeUnit", None)
    if resume_detail.strip(): dec["resumeDetail"] = resume_detail.strip()
    upd = {**doc, "decision": dec, "version": int(doc.get("version") or 1) + 1}
    if train_id.strip(): upd["trainId"] = train_id.strip()
    upd["sha256"] = compute_sig(upd)
    write_exclusive_atomic(fpath, json.dumps(upd, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(upd, ensure_ascii=False, indent=2))

elif op == "resolve":
    pending_dir, approval_id, decision, actor, note, voucher_id, resume_status, resume_unit, resume_detail, now_iso = args
    fpath, doc = load_verified(pending_dir, approval_id)
    if is_commercial_branch(norm_branch_name(doc.get("branch"))): sys.stderr.write("COMMERCIAL_BRANCH_HARD_LOCK\n"); sys.exit(21)
    if str(doc.get("classification") or "") == "absolute_reject": sys.stderr.write("ABSOLUTE_REJECT_FORBIDDEN\n"); sys.exit(21)
    if str(doc.get("status") or "") != "pending": sys.stderr.write(f"ALREADY_RESOLVED: state='{doc.get('status')}'\n"); sys.exit(15)
    now_dt = dt.datetime.fromisoformat(now_iso.replace("Z", "+00:00"))
    if now_dt >= dt.datetime.fromisoformat(str(doc.get("expiresAt") or "").replace("Z", "+00:00")): sys.stderr.write("APPROVAL_EXPIRED\n"); sys.exit(16)
    dec_obj = {"action": decision, "decidedBy": actor.strip(), "decidedAt": now_dt.strftime("%Y-%m-%dT%H:%M:%SZ")}
    if note.strip(): dec_obj["note"] = note.strip()
    if voucher_id.strip(): dec_obj["issuedArtifactId"] = voucher_id.strip()
    if resume_status.strip(): dec_obj["resumeStatus"] = resume_status.strip()
    if resume_unit.strip(): dec_obj["resumeUnit"] = resume_unit.strip()
    if resume_detail.strip(): dec_obj["resumeDetail"] = resume_detail.strip()
    upd = {**doc, "status": "approved" if decision == "approve" else "rejected", "version": int(doc.get("version") or 1) + 1, "decision": dec_obj}
    upd["sha256"] = compute_sig(upd)
    write_exclusive_atomic(fpath, json.dumps(upd, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(upd, ensure_ascii=False, indent=2))
PY
}

cmd_record_pending_approval() {
  local id="" kind="" code="" branch="" sha="" base_ref="" train_id="" ticket_id="" scope="" risk_category="" title="" summary="" ttl_hours="24" repo_root="." total_files="" files_json="" files_nul=0 classification="human_review_required" allow_whole_commit=0
  local -a raw_files=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --id) id="${2:-}"; shift 2 ;; --kind) kind="${2:-}"; shift 2 ;; --code) code="${2:-}"; shift 2 ;; --branch) branch="${2:-}"; shift 2 ;;
      --sha) sha="${2:-}"; shift 2 ;; --base-ref) base_ref="${2:-}"; shift 2 ;; --train) train_id="${2:-}"; shift 2 ;; --ticket) ticket_id="${2:-}"; shift 2 ;;
      --scope) scope="${2:-}"; shift 2 ;; --risk-category) risk_category="${2:-}"; shift 2 ;; --title) title="${2:-}"; shift 2 ;; --summary) summary="${2:-}"; shift 2 ;;
      --ttl-hours) ttl_hours="${2:-}"; shift 2 ;; --repo-root) repo_root="${2:-}"; shift 2 ;; --total-files) total_files="${2:-}"; shift 2 ;;
      --classification) classification="${2:-}"; shift 2 ;; --allow-whole-commit) allow_whole_commit=1; shift ;; --files-json) files_json="${2:-}"; shift 2 ;; --files-nul) files_nul=1; shift ;;
      --files) shift; while [[ $# -gt 0 && "$1" != --* ]]; do raw_files+=("$1"); shift; done ;;
      *) die_usage "unknown record-pending-approval argument: $1" ;;
    esac
  done
  [[ "$id" =~ ^gov-[a-z0-9_-]{4,80}$ ]] || die_usage "--id must match ^gov-[a-z0-9_-]{4,80}$ (got: ${id:-<empty>})"
  case "$kind" in blast_voucher|a0_approval|breaker_unlock) ;; *) die_usage "--kind must be blast_voucher | a0_approval | breaker_unlock" ;; esac
  case "$risk_category" in ""|ux_degradation|billing_change) ;; *) die_usage "--risk-category must be ux_degradation | billing_change" ;; esac
  case "$classification" in human_review_required|auto_pass) ;; absolute_reject) die_gate "ABSOLUTE_REJECT_FORBIDDEN: classification=absolute_reject 禁止创建审批单" ;; *) die_usage "--classification must be human_review_required | auto_pass | absolute_reject" ;; esac
  [[ -n "${code// /}" ]] || die_usage "--code is required"
  [[ -n "${branch// /}" ]] || die_usage "--branch is required"
  [[ -z "$sha" || "$sha" =~ ^[0-9a-f]{40}$ ]] || die_usage "--sha must be a 40-char lowercase hex commit SHA"
  [[ "$ttl_hours" =~ ^[0-9]+([.][0-9]+)?$ ]] || die_usage "--ttl-hours must be a positive number"
  [[ -z "$total_files" || "$total_files" =~ ^[0-9]+$ ]] || die_usage "--total-files must be a non-negative integer"
  local norm_br="${branch#refs/heads/}"; norm_br="${norm_br#origin/}"
  [[ "$norm_br" != "feat/v5-aurora-rewrite" && "$norm_br" != *v5-aurora-rewrite* ]] || die_gate "COMMERCIAL_BRANCH_HARD_LOCK: 商业分支 feat/v5-aurora-rewrite 永久物理硬锁，禁止创建审批单"
  ensure_dirs; _assert_safe_dir_chain || die_gate "unsafe control directory chain"
  local lock_file="$PENDING_LOCKS_DIR/${id}.lock"
  [[ ! -L "$lock_file" ]] || die_gate "UNSAFE_LOCK_FILE: symlink lock file refused: $lock_file"
  local ts actor resolved_base_sha="" steward_json='{"present":false,"ok":false,"verdict":"missing","hmacVerified":false}'
  ts="$(now_iso)"; actor="$(actor_name)"
  if [[ "$sha" =~ ^[0-9a-f]{40}$ ]]; then
    resolved_base_sha="$(_resolve_exact_base_sha "$repo_root" "$sha" "$base_ref")"
    if [[ -z "$resolved_base_sha" ]]; then
      [[ -e "$STEWARD_RECEIPTS_DIR/${sha}.json" || -L "$STEWARD_RECEIPTS_DIR/${sha}.json" ]] && steward_json='{"present":true,"ok":false,"verdict":"invalid","hmacVerified":false,"summary":"无法确定比较基线，需人工核验"}'
    else steward_json="$(_verify_steward_receipt_authoritative "$sha" "$resolved_base_sha")"; fi
  fi
  local tmp_files_nul="" out_res="" rc=0
  tmp_files_nul="$(mktemp "${TMPDIR:-/tmp}/oc-rec-files.XXXXXX")"
  if [[ "$files_nul" == "1" ]]; then cat >"$tmp_files_nul"
  elif (( ${#raw_files[@]} > 0 )); then printf '%s\0' "${raw_files[@]}" >"$tmp_files_nul"; fi
  set +e
  out_res="$(exec 9>"$lock_file"; flock -w 15 -x 9 || { echo "LOCK_TIMEOUT: could not acquire lock for $id" >&2; exit 19; }; _pending_approval_py record "$id" "$kind" "$code" "$branch" "$sha" "$train_id" "$ticket_id" "$scope" "$title" "$summary" "$ttl_hours" "$repo_root" "$total_files" "$tmp_files_nul" "$files_json" "$ts" "$PENDING_APPROVALS_DIR" "$classification" "$allow_whole_commit" "$steward_json" "$risk_category")"
  rc=$?; set -e
  rm -f -- "$tmp_files_nul" 2>/dev/null || true
  if [[ "$rc" -ne 0 ]]; then [[ "$rc" -eq 2 ]] && die_usage "record-pending-approval failed"; die_gate "record-pending-approval rejected (rc=$rc)"; fi
  local was_written="" doc_pretty=""
  was_written="$(python3 -c 'import json,sys; print("1" if json.loads(sys.argv[1]).get("written") else "0")' "$out_res")"
  doc_pretty="$(python3 -c 'import json,sys; print(json.dumps(json.loads(sys.argv[1])["doc"], ensure_ascii=False, indent=2))' "$out_res")"
  [[ "$was_written" == "1" ]] && append_audit_safe "$(python3 -c 'import json,sys; t,a,i,k,c,b,cls=sys.argv[1:]; print(json.dumps({"ts":t,"action":"record_pending_approval","actor":a,"approvalId":i,"kind":k,"code":c,"branch":b,"classification":cls,"outcome":"ok"}, ensure_ascii=False, separators=(",",":")))' "$ts" "$actor" "$id" "$kind" "$code" "$branch" "$classification")"
  printf '%s\n' "$doc_pretty"
}

cmd_list_pending_approvals() {
  local status_filter="pending" limit_arg="200"
  while [[ $# -gt 0 ]]; do case "$1" in --status) status_filter="${2:-}"; shift 2 ;; --limit) limit_arg="${2:-}"; shift 2 ;; *) die_usage "unknown list-pending-approvals argument: $1" ;; esac; done
  case "$status_filter" in pending|all|approving|approved|rejected|expired|reconcile_required) ;; *) die_usage "--status invalid" ;; esac
  [[ "$limit_arg" =~ ^[1-9][0-9]*$ ]] || die_usage "--limit must be a positive integer"
  _pending_approval_py list "$PENDING_APPROVALS_DIR" "$status_filter" "$limit_arg" "$(now_iso)"
}

cmd_reconcile_pending_approval() {
  local id=""
  while [[ $# -gt 0 ]]; do case "$1" in --id) id="${2:-}"; shift 2 ;; *) die_usage "unknown reconcile-pending-approval argument: $1" ;; esac; done
  [[ "$id" =~ ^gov-[a-z0-9_-]{4,80}$ ]] || die_usage "--id must match ^gov-[a-z0-9_-]{4,80}$"
  ensure_dirs; _assert_safe_dir_chain || die_gate "unsafe control directory chain"
  local lock_file="$PENDING_LOCKS_DIR/${id}.lock" out_json="" rc=0
  [[ ! -L "$lock_file" ]] || die_gate "UNSAFE_LOCK_FILE: $lock_file"
  set +e; out_json="$(exec 9>"$lock_file"; flock -w 15 -x 9 || { echo "LOCK_TIMEOUT: $id" >&2; exit 19; }; _pending_approval_py reconcile "$PENDING_APPROVALS_DIR" "$VOUCHERS_DIR" "$APPROVALS_DIR" "$BREAKER_FILE" "$COST_BREAKER_FILE" "$id")"; rc=$?; set -e
  [[ "$rc" -eq 0 ]] || die_gate "reconcile-pending-approval failed (rc=$rc)"
  printf '%s\n' "$out_json"
}

cmd_decide_pending_approval() {
  local id="" decision="" actor_arg="" note="" expected_version="" expected_sha256="" allow_whole_commit=0 publish_gh=0 gh_repo=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --id) id="${2:-}"; shift 2 ;; --decision) decision="${2:-}"; shift 2 ;; --actor) actor_arg="${2:-}"; shift 2 ;; --expected-version) expected_version="${2:-}"; shift 2 ;;
      --expected-sha256) expected_sha256="${2:-}"; shift 2 ;; --note) note="${2:-}"; shift 2 ;; --allow-whole-commit) allow_whole_commit=1; shift ;;
      --publish-github-status) publish_gh=1; shift ;; --github-repo) gh_repo="${2:-}"; shift 2 ;; *) die_usage "unknown decide-pending-approval argument: $1" ;;
    esac
  done
  [[ "$id" =~ ^gov-[a-z0-9_-]{4,80}$ ]] || die_usage "--id must match ^gov-[a-z0-9_-]{4,80}$"
  case "$decision" in approve|reject) ;; *) die_usage "--decision must be approve | reject" ;; esac
  [[ -n "${actor_arg// /}" ]] || die_usage "--actor <name> is required"
  [[ -z "$expected_version" || "$expected_version" =~ ^[1-9][0-9]*$ ]] || die_usage "--expected-version must be a positive integer"
  [[ -z "$expected_sha256" || "$expected_sha256" =~ ^[0-9a-f]{64}$ ]] || die_usage "--expected-sha256 must be a 64-char lowercase hex SHA-256"
  ensure_dirs; _assert_safe_dir_chain || die_gate "unsafe control directory chain"
  local lock_file="$PENDING_LOCKS_DIR/${id}.lock" ts out_json rc=0
  [[ ! -L "$lock_file" ]] || die_gate "UNSAFE_LOCK_FILE: $lock_file"
  ts="$(now_iso)"
  set +e
  out_json="$(
    exec 9>"$lock_file"
    flock -w 15 -x 9 || { echo "LOCK_TIMEOUT: could not acquire lock for $id" >&2; exit 19; }
    prep_out="$(_pending_approval_py decide_prep "$PENDING_APPROVALS_DIR" "$VOUCHERS_DIR" "$APPROVALS_DIR" "$BREAKER_FILE" "$COST_BREAKER_FILE" "$id" "$decision" "$actor_arg" "$note" "$expected_version" "$expected_sha256" "$allow_whole_commit" "$publish_gh" "$ts")"
    prep_rc=$?; [[ "$prep_rc" -eq 0 ]] || exit "$prep_rc"
    mapfile -d '' -t _dp < <(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); vals=["1" if d.get("done") else "0", json.dumps(d.get("doc"),ensure_ascii=False,indent=2) if d.get("done") else "", str(d.get("kind","")), str(d.get("scope","")), str(d.get("branch","")), str(d.get("sha","")), str(d.get("curVersion","")), str(d.get("cleanNote","")), str(d.get("pendingArtifactId","")), json.dumps(d.get("files",[]),ensure_ascii=False)]; sys.stdout.buffer.write(b"".join(v.encode("utf-8")+b"\x00" for v in vals))' "$prep_out")
    if [[ "${_dp[0]}" == "1" ]]; then printf '%s\n' "${_dp[1]}"; exit 0; fi
    kind="${_dp[2]}"; scope="${_dp[3]}"; branch="${_dp[4]}"; sha="${_dp[5]}"; cur_ver="${_dp[6]}"; clean_note="${_dp[7]}"; pending_aid="${_dp[8]}"; files_json_arg="${_dp[9]}"
    artifact_reason="Approved ${id} by ${actor_arg}${clean_note:+: ${clean_note}}"
    mint_out=""; mint_rc=0; issued_id=""; default_resume="not_applicable"
    if [[ "${OC_GOVERNOR_TEST_FAIL_BEFORE_MINT:-0}" == "1" ]]; then mint_rc=1; mint_out="simulated pre-mint failure"
    elif [[ "$kind" == "blast_voucher" ]]; then
      default_resume="not_started"
      b_args=(--id "$pending_aid" --scope "$scope" --reason "$artifact_reason" --ttl-hours 4 --branch "$branch" --approval-id "$id" --files-json "$files_json_arg")
      [[ -n "$sha" ]] && b_args+=(--sha "$sha")
      mint_out="$(cmd_issue_blast_voucher "${b_args[@]}" 2>&1)"; mint_rc=$?
      [[ "$mint_rc" -eq 0 ]] && issued_id="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["id"])' "$mint_out" 2>/dev/null || true)"
    elif [[ "$kind" == "a0_approval" ]]; then
      mapfile -d '' -t file_arr < <(python3 -c 'import json,sys; sys.stdout.buffer.write(b"".join((f.encode("utf-8")+b"\x00") for f in json.loads(sys.argv[1])["files"]))' "$prep_out")
      a_args=(--sha "$sha" --reason "$artifact_reason" --ttl-hours 24)
      for af in "${file_arr[@]}"; do a_args+=(--allowed-path "$af"); done
      if [[ "$publish_gh" == "1" ]]; then a_args+=(--publish-github-status); [[ -n "$gh_repo" ]] && a_args+=(--github-repo "$gh_repo"); fi
      mint_out="$(cmd_approve_a0 "${a_args[@]}" 2>&1)"; mint_rc=$?; [[ "$mint_rc" -eq 0 ]] && issued_id="$pending_aid"
    elif [[ "$kind" == "breaker_unlock" ]]; then
      mint_out="$(cmd_unlock_breaker --reason "$clean_note" 2>&1)"; mint_rc=$?; [[ "$mint_rc" -eq 0 ]] && issued_id="$pending_aid"
    fi
    _pending_approval_py decide_commit "$PENDING_APPROVALS_DIR" "$VOUCHERS_DIR" "$APPROVALS_DIR" "$BREAKER_FILE" "$id" "$kind" "$sha" "$cur_ver" "$mint_rc" "$issued_id" "$pending_aid" "$default_resume" "$publish_gh" "$mint_out" "${OC_GOVERNOR_TEST_FAIL_AFTER_MINT:-0}"
  )"
  rc=$?; set -e
  if [[ "$rc" -ne 0 ]]; then
    append_audit_safe "$(python3 -c 'import json,sys; t,a,i,d,r=sys.argv[1:]; print(json.dumps({"ts":t,"action":"decide_pending_approval","actor":a,"approvalId":i,"decision":d,"rc":int(r),"outcome":"failed"}, ensure_ascii=False, separators=(",",":")))' "$ts" "$actor_arg" "$id" "$decision" "$rc")"
    die_gate "decide-pending-approval failed (rc=$rc)"
  fi
  local out_art=""
  out_art="$(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); print((d.get("decision") or {}).get("issuedArtifactId") or "")' "$out_json" 2>/dev/null || true)"
  append_audit_safe "$(python3 -c 'import json,sys; t,a,i,d,v=sys.argv[1:]; ev={"ts":t,"action":"decide_pending_approval","actor":a,"approvalId":i,"decision":d,"outcome":"ok"}; (ev.update({"issuedArtifactId":v}) if v else None); print(json.dumps(ev, ensure_ascii=False, separators=(",",":")))' "$ts" "$actor_arg" "$id" "$decision" "$out_art")"
  printf '%s\n' "$out_json"
}

cmd_update_approval_resume() {
  local id="" resume_status="" claim_from="" expected_unit="" resume_unit="" train_id="" resume_detail=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --id) id="${2:-}"; shift 2 ;; --status) resume_status="${2:-}"; shift 2 ;; --claim-from) claim_from="${2:-}"; shift 2 ;; --expected-unit) expected_unit="${2:-}"; shift 2 ;;
      --unit) resume_unit="${2:-}"; shift 2 ;; --train) train_id="${2:-}"; shift 2 ;; --detail) resume_detail="${2:-}"; shift 2 ;; *) die_usage "unknown update-approval-resume argument: $1" ;;
    esac
  done
  [[ "$id" =~ ^gov-[a-z0-9_-]{4,80}$ ]] || die_usage "--id must match ^gov-[a-z0-9_-]{4,80}$"
  case "$resume_status" in starting|running|started|not_started_busy|head_moved|failed|completed|skipped|not_applicable|not_started) ;; *) die_usage "invalid --status: $resume_status" ;; esac
  ensure_dirs; _assert_safe_dir_chain || die_gate "unsafe control directory chain"
  local lock_file="$PENDING_LOCKS_DIR/${id}.lock" ts actor out_json rc=0
  [[ ! -L "$lock_file" ]] || die_gate "UNSAFE_LOCK_FILE: $lock_file"
  ts="$(now_iso)"; actor="$(actor_name)"
  set +e; out_json="$(exec 9>"$lock_file"; flock -w 15 -x 9 || { echo "LOCK_TIMEOUT: could not acquire lock for $id" >&2; exit 19; }; _pending_approval_py update_resume "$PENDING_APPROVALS_DIR" "$id" "$resume_status" "$claim_from" "$expected_unit" "$resume_unit" "$train_id" "$resume_detail" "$ts")"; rc=$?; set -e
  [[ "$rc" -eq 0 ]] || die_gate "update-approval-resume failed (rc=$rc)"
  append_audit_safe "$(python3 -c 'import json,sys; t,a,i,s,u=sys.argv[1:]; ev={"ts":t,"action":"update_approval_resume","actor":a,"approvalId":i,"resumeStatus":s,"outcome":"ok"}; (ev.update({"resumeUnit":u}) if u else None); print(json.dumps(ev, ensure_ascii=False, separators=(",",":")))' "$ts" "$actor" "$id" "$resume_status" "$resume_unit")"
  printf '%s\n' "$out_json"
}

cmd_resolve_pending_approval() {
  local id="" decision="" actor_arg="" note="" voucher_id="" resume_status="" resume_unit="" resume_detail=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --id) id="${2:-}"; shift 2 ;; --decision) decision="${2:-}"; shift 2 ;; --actor) actor_arg="${2:-}"; shift 2 ;; --note) note="${2:-}"; shift 2 ;;
      --voucher-id) voucher_id="${2:-}"; shift 2 ;; --resume-status) resume_status="${2:-}"; shift 2 ;; --resume-unit) resume_unit="${2:-}"; shift 2 ;; --resume-detail) resume_detail="${2:-}"; shift 2 ;;
      *) die_usage "unknown resolve-pending-approval argument: $1" ;;
    esac
  done
  [[ "$id" =~ ^gov-[a-z0-9_-]{4,80}$ ]] || die_usage "--id must match ^gov-[a-z0-9_-]{4,80}$"
  case "$decision" in approve|reject) ;; *) die_usage "--decision must be approve | reject" ;; esac
  [[ -n "${actor_arg// /}" ]] || die_usage "--actor <name> is required"
  ensure_dirs; _assert_safe_dir_chain || die_gate "unsafe control directory chain"
  local lock_file="$PENDING_LOCKS_DIR/${id}.lock" ts out_json rc=0
  [[ ! -L "$lock_file" ]] || die_gate "UNSAFE_LOCK_FILE: $lock_file"
  ts="$(now_iso)"
  set +e; out_json="$(exec 9>"$lock_file"; flock -w 15 -x 9 || { echo "LOCK_TIMEOUT: could not acquire lock for $id" >&2; exit 19; }; _pending_approval_py resolve "$PENDING_APPROVALS_DIR" "$id" "$decision" "$actor_arg" "$note" "$voucher_id" "$resume_status" "$resume_unit" "$resume_detail" "$ts")"; rc=$?; set -e
  [[ "$rc" -eq 0 ]] || die_gate "resolve-pending-approval failed (rc=$rc)"
  append_audit_safe "$(python3 -c 'import json,sys; t,a,i,d,v=sys.argv[1:]; ev={"ts":t,"action":"resolve_pending_approval","actor":a,"approvalId":i,"decision":d,"outcome":"ok"}; (ev.update({"issuedArtifactId":v}) if v else None); print(json.dumps(ev, ensure_ascii=False, separators=(",",":")))' "$ts" "$actor_arg" "$id" "$decision" "$voucher_id")"
  printf '%s\n' "$out_json"
}

# ── Gate 4: Dual Circuit Breaker & 5-Line Root-Cause Card ──────────────────

_record_or_trip_rollback() {
  local force_trip="$1"; shift
  local train="" reason=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --train) train="${2:-}"; shift 2 ;;
      --reason) reason="${2:-}"; shift 2 ;;
      *) die_usage "unknown rollback argument: $1" ;;
    esac
  done
  [[ -n "${train// /}" ]] || die_usage "--train <id> is required"
  [[ -n "${reason// /}" ]] || die_usage "--reason \"...\" is required"
  ensure_dirs
  local ts actor count_7d tripped="false"
  ts="$(now_iso)"; actor="$(actor_name)"
  printf '%s\n' "$(python3 -c 'import json,sys; print(json.dumps({"ts":sys.argv[1],"train":sys.argv[2],"reason":sys.argv[3],"actor":sys.argv[4]}, ensure_ascii=False, separators=(",",":")))' "$ts" "$train" "$reason" "$actor")" >>"$ROLLBACKS_FILE"
  chmod 0644 "$ROLLBACKS_FILE" 2>/dev/null || true

  count_7d="$(python3 - "$ROLLBACKS_FILE" "$ts" <<'PY'
import datetime as dt, json, sys
path, now_iso = sys.argv[1:]
now_dt = dt.datetime.fromisoformat(now_iso.replace("Z", "+00:00"))
since_dt = now_dt - dt.timedelta(days=7)
n = 0
for line in open(path, encoding="utf-8"):
    if not line.strip(): continue
    try:
        t = dt.datetime.fromisoformat(str(json.loads(line)["ts"]).replace("Z", "+00:00"))
        if since_dt <= t <= now_dt: n += 1
    except Exception: pass
print(n)
PY
)"
  [[ "$force_trip" == "1" || "$count_7d" -ge 2 ]] && tripped="true"
  if [[ "$tripped" == "true" ]]; then
    local cur_mode="autonomous" next_mode="debt_first"
    [[ -f "$MODE_FILE" ]] && cur_mode="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("mode","autonomous"))' "$MODE_FILE" 2>/dev/null || echo "autonomous")"
    [[ "$cur_mode" == "emergency_stop" ]] && next_mode="emergency_stop"
    local mode_reason="circuit breaker tripped: ${count_7d} rollback(s) in 7d (latest train=${train})"
    atomic_write_file "$MODE_FILE" "$(python3 -c 'import json,sys; print(json.dumps({"schemaVersion":1,"mode":sys.argv[1],"autoMergeFrozen":True,"reason":sys.argv[2],"updatedAt":sys.argv[3],"updatedBy":sys.argv[4]}, ensure_ascii=False, indent=2))' "$next_mode" "$mode_reason" "$ts" "$actor")" 0644
    atomic_write_file "$BREAKER_FILE" "$(python3 -c 'import json,sys; print(json.dumps({"schemaVersion":1,"tripped":True,"kind":"rollback_breaker","rollbackCount7d":int(sys.argv[1]),"latestTrain":sys.argv[2],"reason":sys.argv[3],"trippedAt":sys.argv[4]}, ensure_ascii=False, indent=2))' "$count_7d" "$train" "$reason" "$ts")" 0644
    write_breaker_card "7天内回滚熔断触发（累计 ${count_7d} 次，已自动切入 ${next_mode} 并冻结新特性合入）" "$train" "$ts" "$reason"
  fi
  append_audit_safe "$(python3 -c 'import json,sys; print(json.dumps({"ts":sys.argv[1],"action":sys.argv[2],"actor":sys.argv[3],"train":sys.argv[4],"rollbackCount7d":int(sys.argv[5]),"breakerTripped":sys.argv[6]=="true","outcome":"ok"}))' "$ts" "$actor" "$([[ "$force_trip" == "1" ]] && echo trip_breaker || echo record_rollback)" "$train" "$count_7d" "$tripped")"
  python3 -c 'import json,sys; print(json.dumps({"ok":True,"train":sys.argv[1],"rollbackCount7d":int(sys.argv[2]),"breakerTripped":sys.argv[3]=="true","breakerCard":sys.argv[4] if sys.argv[3]=="true" else None}))' "$train" "$count_7d" "$tripped" "$BREAKER_CARD_FILE"
}

cmd_check_cost_breaker() {
  local daily_usd="" limit_usd=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --daily-usd) daily_usd="${2:-}"; shift 2 ;;
      --limit-usd) limit_usd="${2:-}"; shift 2 ;;
      *) die_usage "unknown check-cost-breaker argument: $1" ;;
    esac
  done
  [[ "$daily_usd" =~ ^[0-9]+([.][0-9]+)?$ ]] || die_usage "--daily-usd must be a non-negative number"
  [[ "$limit_usd" =~ ^[0-9]+([.][0-9]+)?$ ]] || die_usage "--limit-usd must be a positive number"
  ensure_dirs
  local ts actor eval_out tripped
  ts="$(now_iso)"; actor="$(actor_name)"
  eval_out="$(python3 -c 'import json,sys; d,l,ts=float(sys.argv[1]),float(sys.argv[2]),sys.argv[3]; assert l>0; print(json.dumps({"schemaVersion":1,"tripped":d>=l,"dailyUsd":d,"limitUsd":l,"checkedAt":ts}, indent=2))' "$daily_usd" "$limit_usd" "$ts")" || die_usage "invalid cost breaker numbers"
  atomic_write_file "$COST_BREAKER_FILE" "$eval_out" 0644
  tripped="$(python3 -c 'import json,sys; print("true" if json.loads(sys.argv[1])["tripped"] else "false")' "$eval_out")"
  if [[ "$tripped" == "true" ]]; then
    local cur_mode="autonomous" next_mode="debt_first"
    [[ -f "$MODE_FILE" ]] && cur_mode="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("mode","autonomous"))' "$MODE_FILE" 2>/dev/null || echo "autonomous")"
    [[ "$cur_mode" == "emergency_stop" ]] && next_mode="emergency_stop"
    local reason="daily compute spend \$${daily_usd} exceeded hard limit \$${limit_usd}"
    atomic_write_file "$MODE_FILE" "$(python3 -c 'import json,sys; print(json.dumps({"schemaVersion":1,"mode":sys.argv[1],"autoMergeFrozen":True,"reason":sys.argv[2],"updatedAt":sys.argv[3],"updatedBy":sys.argv[4]}, ensure_ascii=False, indent=2))' "$next_mode" "$reason" "$ts" "$actor")" 0644
    atomic_write_file "$BREAKER_FILE" "$(python3 -c 'import json,sys; print(json.dumps({"schemaVersion":1,"tripped":True,"kind":"cost_breaker","dailyUsd":float(sys.argv[1]),"limitUsd":float(sys.argv[2]),"reason":sys.argv[3],"trippedAt":sys.argv[4]}, ensure_ascii=False, indent=2))' "$daily_usd" "$limit_usd" "$reason" "$ts")" 0644
    write_breaker_card "单日算力预算熔断触发（\$${daily_usd} >= \$${limit_usd}，已切入 ${next_mode}）" "cost-guard" "$ts" "$reason"
    append_audit_safe "$(python3 -c 'import json,sys; print(json.dumps({"ts":sys.argv[1],"action":"check_cost_breaker","actor":sys.argv[2],"dailyUsd":float(sys.argv[3]),"limitUsd":float(sys.argv[4]),"outcome":"tripped"}))' "$ts" "$actor" "$daily_usd" "$limit_usd")"
    printf '%s\n' "$eval_out" >&2; exit 1
  fi
  append_audit_safe "$(python3 -c 'import json,sys; print(json.dumps({"ts":sys.argv[1],"action":"check_cost_breaker","actor":sys.argv[2],"dailyUsd":float(sys.argv[3]),"limitUsd":float(sys.argv[4]),"outcome":"ok"}))' "$ts" "$actor" "$daily_usd" "$limit_usd")"
  printf '%s\n' "$eval_out"
}

cmd_unlock_breaker() {
  local reason=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --reason) reason="${2:-}"; shift 2 ;;
      *) die_usage "unknown unlock-breaker argument: $1" ;;
    esac
  done
  [[ ${#reason} -ge 8 ]] || die_usage "unlock-breaker requires --reason \"<>=8 chars>\""
  ensure_dirs
  local ts actor
  ts="$(now_iso)"; actor="$(actor_name)"
  atomic_write_file "$BREAKER_FILE" "$(python3 -c 'import json,sys; print(json.dumps({"schemaVersion":1,"tripped":False,"unlockedAt":sys.argv[1],"unlockedBy":sys.argv[2],"unlockReason":sys.argv[3]}, ensure_ascii=False, indent=2))' "$ts" "$actor" "$reason")" 0644
  if [[ -f "$COST_BREAKER_FILE" ]]; then
    atomic_write_file "$COST_BREAKER_FILE" "$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); d["tripped"]=False; d["unlockedAt"]=sys.argv[2]; print(json.dumps(d, ensure_ascii=False, indent=2))' "$COST_BREAKER_FILE" "$ts")" 0644
  fi
  atomic_write_file "$MODE_FILE" "$(python3 -c 'import json,sys; print(json.dumps({"schemaVersion":1,"mode":"autonomous","autoMergeFrozen":False,"reason":"unlocked: "+sys.argv[1],"updatedAt":sys.argv[2],"updatedBy":sys.argv[3]}, ensure_ascii=False, indent=2))' "$reason" "$ts" "$actor")" 0644
  rm -f "$BREAKER_CARD_FILE"
  append_audit_safe "$(python3 -c 'import json,sys; print(json.dumps({"ts":sys.argv[1],"action":"unlock_breaker","actor":sys.argv[2],"reason":sys.argv[3],"outcome":"ok"}))' "$ts" "$actor" "$reason")"
  printf '{"ok":true,"mode":"autonomous","tripped":false}\n'
}

cmd_status() {
  python3 - "$GOV_ROOT" "$(now_iso)" <<'PY'
import datetime as dt, hashlib, hmac, json, os, pathlib, stat, sys
root, now_iso = pathlib.Path(sys.argv[1]), sys.argv[2]
now_dt = dt.datetime.fromisoformat(now_iso.replace("Z", "+00:00"))
since_7d = now_dt - dt.timedelta(days=7)
ctrl = root / "control"
def load_json(p):
    try: return json.loads(p.read_text(encoding="utf-8")) if p.is_file() else None
    except Exception: return None
mode_doc = load_json(ctrl / "mode.json") or {"schemaVersion": 1, "mode": "autonomous", "autoMergeFrozen": False, "reason": "default uninitialized"}
hmac_key = None
hmac_path = ctrl / ".hmac-key"
if hmac_path.exists() and not hmac_path.is_symlink() and (os.lstat(hmac_path).st_mode & 0o077) == 0:
    try: hmac_key = hmac_path.read_text(encoding="utf-8").strip() or None
    except Exception: hmac_key = None
active_a0, expired_a0, tampered_a0 = [], 0, 0
if (ctrl / "a0-approvals").is_dir():
    for f in sorted((ctrl / "a0-approvals").glob("*.json")):
        if f.name.endswith(".gh.json"): continue
        doc = load_json(f)
        if not isinstance(doc, dict): tampered_a0 += 1; continue
        sha = str(doc.get("sha") or "")
        issued = str(doc.get("issuedAt") or "")
        expires = str(doc.get("expiresAt") or "")
        reason = str(doc.get("reason") or "").strip()
        raw_paths = doc.get("allowedPaths")
        paths_canonical = "*" if raw_paths is None else json.dumps(sorted(set(str(p).strip() for p in raw_paths)), separators=(",", ":"), ensure_ascii=False) if isinstance(raw_paths, list) else None
        if paths_canonical is None: tampered_a0 += 1; continue
        canonical = f"a0-approval-v1\nsha={sha}\nissuedAt={issued}\nexpiresAt={expires}\nreason={reason}\nallowedPaths={paths_canonical}\n"
        if hashlib.sha256(canonical.encode("utf-8")).hexdigest() != doc.get("sha256"): tampered_a0 += 1; continue
        if hmac_key is not None:
            expected_hmac = hmac.new(hmac_key.encode("utf-8"), canonical.encode("utf-8"), hashlib.sha256).hexdigest()
            if not isinstance(doc.get("hmacSha256"), str) or not hmac.compare_digest(doc["hmacSha256"], expected_hmac):
                tampered_a0 += 1; continue
        try: exp_dt = dt.datetime.fromisoformat(expires.replace("Z", "+00:00"))
        except Exception: tampered_a0 += 1; continue
        if now_dt >= exp_dt: expired_a0 += 1
        else: active_a0.append(sha)
active_vouchers = 0
if (ctrl / "blast-vouchers").is_dir():
    for f in (ctrl / "blast-vouchers").glob("*.json"):
        doc = load_json(f)
        if doc:
            try:
                if now_dt < dt.datetime.fromisoformat(str(doc.get("expiresAt") or "").replace("Z", "+00:00")): active_vouchers += 1
            except Exception: pass
blocked_blast_7d, rollbacks_7d = 0, 0
if (ctrl / "audit.jsonl").is_file():
    for line in (ctrl / "audit.jsonl").read_text(encoding="utf-8", errors="replace").splitlines():
        if not line.strip(): continue
        try:
            ev = json.loads(line)
            t = dt.datetime.fromisoformat(str(ev.get("ts") or "").replace("Z", "+00:00"))
            if since_7d <= t <= now_dt and ev.get("action") == "check_blast_radius" and ev.get("outcome") == "blocked": blocked_blast_7d += 1
        except Exception: pass
if (ctrl / "rollbacks.jsonl").is_file():
    for line in (ctrl / "rollbacks.jsonl").read_text(encoding="utf-8", errors="replace").splitlines():
        if not line.strip(): continue
        try:
            t = dt.datetime.fromisoformat(str(json.loads(line).get("ts") or "").replace("Z", "+00:00"))
            if since_7d <= t <= now_dt: rollbacks_7d += 1
        except Exception: pass
breaker_doc = load_json(ctrl / "breaker.json") or {"tripped": False}
cost_doc = load_json(ctrl / "cost-breaker.json") or {"tripped": False}
card_path = ctrl / "breaker-card.md"
print(json.dumps({
    "schemaVersion": 1, "root": str(root), "checkedAt": now_iso,
    "gate1_mode": mode_doc,
    "gate2_a0_approvals": {"activeCount": len(active_a0), "activeShas": active_a0, "expiredCount": expired_a0, "tamperedCount": tampered_a0, "hmacActive": hmac_key is not None},
    "gate3_blast_radius": {"hardLockedBranches": ["feat/v5-aurora-rewrite"], "activeVouchers": active_vouchers, "blockedAttempts7d": blocked_blast_7d},
    "gate4_circuit_breaker": {"tripped": bool(breaker_doc.get("tripped") or cost_doc.get("tripped")), "kind": breaker_doc.get("kind"), "rollbackCount7d": rollbacks_7d, "costBreakerTripped": bool(cost_doc.get("tripped")), "dailyUsd": cost_doc.get("dailyUsd"), "limitUsd": cost_doc.get("limitUsd"), "breakerCardPresent": card_path.is_file(), "breakerCardPath": str(card_path) if card_path.is_file() else None},
}, ensure_ascii=False, indent=2))
PY
}

usage() {
  cat <<'EOF'
Usage: oc-governor <command> [options]
  mode [show | autonomous | debt_first | emergency_stop] [--reason "..."]
  approve-a0 --sha <40hex> --reason "..." [--ttl-hours 24] [--allowed-path <p>] [--publish-github-status] [--github-repo <owner/repo>]
  revoke-a0 --sha <40hex> [--reason "..."]
  verify-a0 --sha <40hex> [--file <path>] [--path <rel>] [--hmac-key-file <path>] [--unsafe-test-skip-owner]
  check-blast-radius --branch <br> [--files <f1> [f2...] | --files-nul] [--sha <40hex>] [--base-ref <ref>] [--repo-root <dir>] [--voucher <id|path>]
  issue-blast-voucher --scope <ddl|billing|ddl+billing> --files <...> --reason "..." [--ttl-hours 4] [--sha <40hex>] [--branch <br>] [--approval-id <gov-...>]
  record-pending-approval --id <gov-...> --kind <blast_voucher|a0_approval|breaker_unlock> --code <code> --branch <br> [--risk-category <ux_degradation|billing_change>] [--sha <40hex>] [--base-ref <ref>] [--train <id>] [--ticket <id>] [--scope <scope>] [--classification <cls>] [--title "..."] [--summary "..."] [--ttl-hours 24] [--repo-root <dir>] [--total-files N] [--allow-whole-commit] [--files f1 f2 ...]
  list-pending-approvals [--status pending|all] [--limit N]
  decide-pending-approval --id <gov-...> --decision <approve|reject> --actor <name> [--expected-version N] [--expected-sha256 <hex>] [--note "..."] [--allow-whole-commit] [--publish-github-status] [--github-repo <owner/repo>]
  reconcile-pending-approval --id <gov-...>
  update-approval-resume --id <gov-...> --status <starting|running|started|not_started_busy|head_moved|failed|completed|skipped|not_applicable> [--claim-from <csv>] [--unit <u>] [--train <t>] [--detail "..."]
  resolve-pending-approval --id <gov-...> --decision <approve|reject> --actor <name> [--note "..."] [--voucher-id <id>] [--resume-status <st>] [--resume-unit <u>] [--resume-detail <d>]
  record-rollback --train <id> --reason "..."
  trip-breaker --train <id> --reason "..."
  check-cost-breaker --daily-usd <n> --limit-usd <m>
  unlock-breaker --reason "..."
  status
EOF
}

main() {
  local cmd="${1:-}"
  if [[ -z "$cmd" || "$cmd" == "-h" || "$cmd" == "--help" ]]; then usage; exit 0; fi
  shift
  case "$cmd" in
    mode) cmd_mode "$@" ;;
    approve-a0) cmd_approve_a0 "$@" ;;
    revoke-a0) cmd_revoke_a0 "$@" ;;
    verify-a0) cmd_verify_a0 "$@" ;;
    check-blast-radius) cmd_check_blast_radius "$@" ;;
    issue-blast-voucher) cmd_issue_blast_voucher "$@" ;;
    record-pending-approval) cmd_record_pending_approval "$@" ;;
    list-pending-approvals) cmd_list_pending_approvals "$@" ;;
    decide-pending-approval) cmd_decide_pending_approval "$@" ;;
    reconcile-pending-approval) cmd_reconcile_pending_approval "$@" ;;
    update-approval-resume) cmd_update_approval_resume "$@" ;;
    resolve-pending-approval) cmd_resolve_pending_approval "$@" ;;
    record-rollback) _record_or_trip_rollback 0 "$@" ;;
    trip-breaker) _record_or_trip_rollback 1 "$@" ;;
    check-cost-breaker) cmd_check_cost_breaker "$@" ;;
    unlock-breaker) cmd_unlock_breaker "$@" ;;
    status) cmd_status "$@" ;;
    *) die_usage "unknown command: $cmd" ;;
  esac
}

main "$@"
