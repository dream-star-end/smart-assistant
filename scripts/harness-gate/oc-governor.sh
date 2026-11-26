#!/usr/bin/env bash
# oc-governor.sh — Host Physical 4-Gate Governance Control Plane (OCV5-906).
#
# Physical Gates:
#   1. Global Operating Mode   : mode [show | autonomous | debt_first | emergency_stop] --reason "..."
#   2. A0 Relaxation Seal      : approve-a0 / revoke-a0 / verify-a0 (--sha <40hex>)
#   3. Blast-Radius Hard-Lock  : check-blast-radius --branch <br> --files <...> [--voucher <path>]
#                                issue-blast-voucher --scope <ddl|billing> --files <...> --reason "..."
#   4. Dual Circuit Breaker    : record-rollback / trip-breaker / check-cost-breaker / unlock-breaker
#   Overview                   : status
set -Eeuo pipefail

GOV_ROOT="${OC_GOVERNOR_ROOT:-/opt/openclaude/harness-gate}"
CTRL_DIR="$GOV_ROOT/control"
APPROVALS_DIR="$CTRL_DIR/a0-approvals"
VOUCHERS_DIR="$CTRL_DIR/blast-vouchers"
MODE_FILE="$CTRL_DIR/mode.json"
AUDIT_FILE="$CTRL_DIR/audit.jsonl"
ROLLBACKS_FILE="$CTRL_DIR/rollbacks.jsonl"
BREAKER_FILE="$CTRL_DIR/breaker.json"
COST_BREAKER_FILE="$CTRL_DIR/cost-breaker.json"
BREAKER_CARD_FILE="$CTRL_DIR/breaker-card.md"

die_usage() { echo "✗ [oc-governor] $*" >&2; exit 2; }
die_gate() { echo "✗ [oc-governor] $*" >&2; exit 1; }
ensure_dirs() { mkdir -p "$CTRL_DIR" "$APPROVALS_DIR" "$VOUCHERS_DIR"; }
actor_name() { id -un 2>/dev/null || echo "unknown"; }
now_iso() {
  if [[ -n "${OC_GOVERNOR_NOW_ISO:-}" ]]; then printf '%s\n' "$OC_GOVERNOR_NOW_ISO"
  else date -u +%Y-%m-%dT%H:%M:%SZ; fi
}

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
  local dest="$1" content="$2" mode="${3:-0644}"
  local tmp="${dest}.tmp.$$.${RANDOM}"
  mkdir -p "$(dirname "$dest")"
  printf '%s\n' "$content" >"$tmp"
  chmod "$mode" "$tmp"
  mv -f "$tmp" "$dest"
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
  local sha="" reason="" ttl_hours="24"
  local -a allowed_paths=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --sha) sha="${2:-}"; shift 2 ;;
      --reason) reason="${2:-}"; shift 2 ;;
      --ttl-hours) ttl_hours="${2:-}"; shift 2 ;;
      --allowed-path) allowed_paths+=("${2:-}"); shift 2 ;;
      *) die_usage "unknown approve-a0 argument: $1" ;;
    esac
  done
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die_usage "--sha must be a 40-char lowercase hex commit SHA"
  [[ ${#reason} -ge 8 ]] || die_usage "--reason must be at least 8 characters"
  [[ "$ttl_hours" =~ ^[0-9]+([.][0-9]+)?$ ]] || die_usage "--ttl-hours must be a positive number"
  ensure_dirs
  local ts actor paths_joined="" out_payload doc_json risk_card
  ts="$(now_iso)"; actor="$(actor_name)"
  (( ${#allowed_paths[@]} > 0 )) && paths_joined="$(printf '%s\n' "${allowed_paths[@]}")"

  out_payload="$(python3 - "$sha" "$reason" "$ttl_hours" "$ts" "$actor" "$paths_joined" <<'PY'
import datetime as dt, hashlib, json, sys
sha, reason, ttl_s, issued_iso, actor, paths_raw = sys.argv[1:]
ttl = float(ttl_s)
if ttl <= 0 or ttl > 168: raise SystemExit("--ttl-hours must be in (0, 168]")
issued_dt = dt.datetime.fromisoformat(issued_iso.replace("Z", "+00:00"))
expires_iso = (issued_dt + dt.timedelta(hours=ttl)).strftime("%Y-%m-%dT%H:%M:%SZ")
issued_norm = issued_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
canonical = f"a0-approval-v1\nsha={sha}\nissuedAt={issued_norm}\nexpiresAt={expires_iso}\nreason={reason}\n"
digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
risk_card = f"[A0-RISK-CARD] SHA {sha[:12]} approved by {actor} until {expires_iso} (TTL {ttl:g}h) — Reason: {' '.join(reason.split())}"
doc = {"schemaVersion": 1, "sha": sha, "reason": reason, "approvedBy": actor, "issuedAt": issued_norm, "expiresAt": expires_iso, "sha256": digest, "riskCard": risk_card}
paths = [p.strip() for p in paths_raw.splitlines() if p.strip()]
if paths: doc["allowedPaths"] = paths
print(json.dumps({"doc": doc, "riskCard": risk_card}, ensure_ascii=False))
PY
)" || die_usage "failed to build A0 approval seal"

  doc_json="$(python3 -c 'import json,sys; print(json.dumps(json.loads(sys.argv[1])["doc"], ensure_ascii=False, indent=2))' "$out_payload")"
  risk_card="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["riskCard"])' "$out_payload")"
  atomic_write_file "$APPROVALS_DIR/${sha}.json" "$doc_json" 0644
  atomic_write_file "$APPROVALS_DIR/${sha}.card.txt" "$risk_card" 0644
  append_audit_safe "$(python3 -c 'import json,sys; t,a,s,r,ttl=sys.argv[1:]; print(json.dumps({"ts":t,"action":"approve_a0","actor":a,"sha":s,"ttlHours":float(ttl),"reason":r,"outcome":"ok"}, ensure_ascii=False, separators=(",",":")))' "$ts" "$actor" "$sha" "$reason" "$ttl_hours")"
  printf '%s\n' "$doc_json"
}

cmd_revoke_a0() {
  local sha="" reason="manual revoke"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --sha) sha="${2:-}"; shift 2 ;;
      --reason) reason="${2:-}"; shift 2 ;;
      *) die_usage "unknown revoke-a0 argument: $1" ;;
    esac
  done
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die_usage "--sha must be a 40-char lowercase hex commit SHA"
  ensure_dirs
  rm -f "$APPROVALS_DIR/${sha}.json" "$APPROVALS_DIR/${sha}.card.txt"
  append_audit_safe "$(python3 -c 'import json,sys; t,a,s,r=sys.argv[1:]; print(json.dumps({"ts":t,"action":"revoke_a0","actor":a,"sha":s,"reason":r,"outcome":"ok"}, ensure_ascii=False, separators=(",",":")))' "$(now_iso)" "$(actor_name)" "$sha" "$reason")"
  printf '{"ok":true,"revokedSha":"%s"}\n' "$sha"
}

cmd_verify_a0() {
  local sha=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --sha) sha="${2:-}"; shift 2 ;;
      *) die_usage "unknown verify-a0 argument: $1" ;;
    esac
  done
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die_usage "--sha must be a 40-char lowercase hex commit SHA"
  local file="$APPROVALS_DIR/${sha}.json" ts actor
  ts="$(now_iso)"; actor="$(actor_name)"
  if [[ -L "$file" || ! -f "$file" ]]; then
    append_audit_safe "$(python3 -c 'import json,sys; print(json.dumps({"ts":sys.argv[1],"action":"check_a0","actor":sys.argv[2],"sha":sys.argv[3],"reason":"missing_or_symlink","outcome":"blocked"}))' "$ts" "$actor" "$sha")"
    die_gate "A0 approval missing or symlink for SHA $sha"
  fi
  local check_out rc=0
  set +e
  check_out="$(python3 - "$file" "$sha" "$ts" <<'PY'
import datetime as dt, hashlib, json, sys
path, want_sha, now_iso = sys.argv[1:]
doc = json.load(open(path, encoding="utf-8"))
if doc.get("sha") != want_sha: print("sha_mismatch"); sys.exit(11)
issued, expires, reason, sig = str(doc.get("issuedAt") or ""), str(doc.get("expiresAt") or ""), str(doc.get("reason") or ""), str(doc.get("sha256") or "")
canonical = f"a0-approval-v1\nsha={want_sha}\nissuedAt={issued}\nexpiresAt={expires}\nreason={reason}\n"
if sig != hashlib.sha256(canonical.encode("utf-8")).hexdigest(): print("signature_tampered"); sys.exit(12)
if dt.datetime.fromisoformat(now_iso.replace("Z", "+00:00")) >= dt.datetime.fromisoformat(expires.replace("Z", "+00:00")): print("approval_expired"); sys.exit(13)
print(json.dumps({"ok": True, "sha": want_sha, "expiresAt": expires, "riskCard": doc.get("riskCard")}))
PY
)"
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    local action_tag="check_a0"
    [[ "$check_out" == "signature_tampered" ]] && action_tag="a0_tamper"
    append_audit_safe "$(python3 -c 'import json,sys; print(json.dumps({"ts":sys.argv[1],"action":sys.argv[2],"actor":sys.argv[3],"sha":sys.argv[4],"reason":sys.argv[5],"outcome":"blocked"}))' "$ts" "$actor" "$action_tag" "$sha" "$check_out")"
    die_gate "A0 approval invalid for $sha: $check_out"
  fi
  printf '%s\n' "$check_out"
}

# ── Gate 3: Irreversible Blast-Radius Hard-Lock ────────────────────────────

cmd_issue_blast_voucher() {
  local scope="" reason="" ttl_hours="4"
  local -a files=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --scope) scope="${2:-}"; shift 2 ;;
      --reason) reason="${2:-}"; shift 2 ;;
      --ttl-hours) ttl_hours="${2:-}"; shift 2 ;;
      --files) shift; while [[ $# -gt 0 && "$1" != --* ]]; do files+=("$1"); shift; done ;;
      *) die_usage "unknown issue-blast-voucher argument: $1" ;;
    esac
  done
  case "$scope" in ddl|billing|ddl+billing) ;; *) die_usage "--scope must be ddl | billing | ddl+billing" ;; esac
  [[ ${#reason} -ge 8 ]] || die_usage "--reason must be >= 8 characters"
  (( ${#files[@]} > 0 )) || die_usage "--files must list at least one path"
  ensure_dirs
  local ts actor joined_files voucher_json voucher_id
  ts="$(now_iso)"; actor="$(actor_name)"; joined_files="$(printf '%s\n' "${files[@]}")"

  voucher_json="$(python3 - "$scope" "$reason" "$ttl_hours" "$ts" "$actor" "$joined_files" <<'PY'
import datetime as dt, hashlib, json, os, sys
scope, reason, ttl_s, issued_iso, actor, files_raw = sys.argv[1:]
ttl = float(ttl_s)
if ttl <= 0 or ttl > 72: raise SystemExit("--ttl-hours must be in (0, 72]")
files = sorted({p.strip() for item in files_raw.splitlines() for p in item.split(",") if p.strip()})
issued_dt = dt.datetime.fromisoformat(issued_iso.replace("Z", "+00:00"))
expires_iso = (issued_dt + dt.timedelta(hours=ttl)).strftime("%Y-%m-%dT%H:%M:%SZ")
issued_norm = issued_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
vid = "bv-" + hashlib.sha256(f"{issued_norm}:{scope}:{','.join(files)}:{os.getpid()}".encode()).hexdigest()[:16]
canonical = f"blast-voucher-v1\nid={vid}\nscope={scope}\nissuedAt={issued_norm}\nexpiresAt={expires_iso}\nfiles={','.join(files)}\nreason={reason}\n"
sig = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
print(json.dumps({"schemaVersion": 1, "id": vid, "scope": scope, "files": files, "reason": reason, "issuedBy": actor, "issuedAt": issued_norm, "expiresAt": expires_iso, "sha256": sig}, ensure_ascii=False, indent=2))
PY
)" || die_usage "failed to issue blast voucher"

  voucher_id="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["id"])' "$voucher_json")"
  atomic_write_file "$VOUCHERS_DIR/${voucher_id}.json" "$voucher_json" 0644
  append_audit_safe "$(python3 -c 'import json,sys; print(json.dumps({"ts":sys.argv[1],"action":"issue_blast_voucher","actor":sys.argv[2],"voucherId":sys.argv[3],"scope":sys.argv[4],"outcome":"ok"}))' "$ts" "$actor" "$voucher_id" "$scope")"
  printf '%s\n' "$voucher_json"
}

cmd_check_blast_radius() {
  local branch="" voucher="" sql_snippet="" repo_root="."
  local -a raw_files=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --branch) branch="${2:-}"; shift 2 ;;
      --voucher) voucher="${2:-}"; shift 2 ;;
      --sql) sql_snippet="${2:-}"; shift 2 ;;
      --repo-root) repo_root="${2:-}"; shift 2 ;;
      --files) shift; while [[ $# -gt 0 && "$1" != --* ]]; do raw_files+=("$1"); shift; done ;;
      *) die_usage "unknown check-blast-radius argument: $1" ;;
    esac
  done
  [[ -n "$branch" ]] || die_usage "check-blast-radius requires --branch <name>"
  local ts actor files_nl check_res rc=0
  ts="$(now_iso)"; actor="$(actor_name)"; files_nl="$(printf '%s\n' "${raw_files[@]}")"

  set +e
  check_res="$(python3 - "$branch" "$files_nl" "$voucher" "$VOUCHERS_DIR" "$ts" "$sql_snippet" "$repo_root" <<'PY'
import datetime as dt, hashlib, json, pathlib, re, sys
branch, files_nl, voucher_arg, vouchers_dir, now_iso, sql_snippet, repo_root = sys.argv[1:]
norm_branch = re.sub(r"^(?:refs/heads/|origin/)", "", branch.strip())
files = [p.strip() for line in files_nl.splitlines() for p in line.split(",") if p.strip()]

if norm_branch == "feat/v5-aurora-rewrite" or "v5-aurora-rewrite" in norm_branch:
    print(json.dumps({"ok": False, "code": "COMMERCIAL_BRANCH_HARD_LOCK", "branch": branch, "message": "Physical hard-lock: commercial branch feat/v5-aurora-rewrite is strictly off-limits"}))
    sys.exit(21)

DESTRUCTIVE_SQL_RE = re.compile(r"\b(?:DROP\s+(?:TABLE|COLUMN|INDEX|SCHEMA)|TRUNCATE\s+TABLE?|ALTER\s+TABLE\s+\S+\s+DROP\b|ALTER\s+COLUMN\s+\S+\s+TYPE\b|DELETE\s+FROM\s+\w+\s*;)", re.IGNORECASE)
BILLING_CORE_RE = re.compile(r"^packages/commercial/src/(?:billing/|payment/)")
ddl_hits, billing_hits = [], []
if sql_snippet and DESTRUCTIVE_SQL_RE.search(sql_snippet): ddl_hits.append("<inline-sql>")

root_path = pathlib.Path(repo_root)
for f in files:
    if BILLING_CORE_RE.search(f): billing_hits.append(f)
    if f.endswith(".sql") or "/migrations/" in f:
        cand = pathlib.Path(f) if pathlib.Path(f).is_absolute() else root_path / f
        if cand.is_file() and DESTRUCTIVE_SQL_RE.search(cand.read_text(encoding="utf-8", errors="replace")): ddl_hits.append(f)
        elif not cand.is_file() and ("drop" in f.lower() or "truncate" in f.lower()): ddl_hits.append(f)

if not ddl_hits and not billing_hits:
    print(json.dumps({"ok": True, "branch": branch, "checkedFiles": len(files)})); sys.exit(0)
if not voucher_arg:
    code = "DESTRUCTIVE_DDL_LOCKED" if ddl_hits else "BILLING_CORE_LOCKED"
    print(json.dumps({"ok": False, "code": code, "branch": branch, "ddlFiles": ddl_hits, "billingFiles": billing_hits})); sys.exit(22)

vpath = pathlib.Path(voucher_arg)
if not vpath.is_absolute(): vpath = pathlib.Path(vouchers_dir) / (voucher_arg if voucher_arg.endswith(".json") else f"{voucher_arg}.json")
vdir_resolved = pathlib.Path(vouchers_dir).resolve()
if vpath.is_symlink() or not vpath.is_file() or vpath.resolve().parent != vdir_resolved:
    print(json.dumps({"ok": False, "code": "INVALID_VOUCHER_PATH", "branch": branch})); sys.exit(23)

vdoc = json.loads(vpath.read_text(encoding="utf-8"))
vid, scope, issued, expires, reason = str(vdoc.get("id") or ""), str(vdoc.get("scope") or ""), str(vdoc.get("issuedAt") or ""), str(vdoc.get("expiresAt") or ""), str(vdoc.get("reason") or "")
vfiles = sorted(str(x) for x in (vdoc.get("files") or []))
canonical = f"blast-voucher-v1\nid={vid}\nscope={scope}\nissuedAt={issued}\nexpiresAt={expires}\nfiles={','.join(vfiles)}\nreason={reason}\n"
if hashlib.sha256(canonical.encode("utf-8")).hexdigest() != vdoc.get("sha256"):
    print(json.dumps({"ok": False, "code": "VOUCHER_TAMPERED", "branch": branch})); sys.exit(24)
if dt.datetime.fromisoformat(now_iso.replace("Z", "+00:00")) >= dt.datetime.fromisoformat(expires.replace("Z", "+00:00")):
    print(json.dumps({"ok": False, "code": "VOUCHER_EXPIRED", "branch": branch})); sys.exit(25)

scopes = set(scope.split("+"))
if ddl_hits and "ddl" not in scopes: print(json.dumps({"ok": False, "code": "VOUCHER_SCOPE_MISMATCH", "need": "ddl"})); sys.exit(26)
if billing_hits and "billing" not in scopes: print(json.dumps({"ok": False, "code": "VOUCHER_SCOPE_MISMATCH", "need": "billing"})); sys.exit(27)
uncovered = [x for x in (ddl_hits + billing_hits) if x != "<inline-sql>" and x not in set(vfiles)]
if uncovered: print(json.dumps({"ok": False, "code": "VOUCHER_FILES_UNCOVERED", "uncovered": uncovered})); sys.exit(28)
print(json.dumps({"ok": True, "branch": branch, "voucherId": vid, "ddlFiles": ddl_hits, "billingFiles": billing_hits}))
PY
)"
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    append_audit_safe "$(python3 -c 'import json,sys; t,a,b,raw=sys.argv[1:]; d=json.loads(raw) if raw.startswith("{") else {}; print(json.dumps({"ts":t,"action":"check_blast_radius","actor":a,"branch":b,"code":d.get("code","BLOCKED"),"outcome":"blocked"}, separators=(",",":")))' "$ts" "$actor" "$branch" "$check_res")"
    printf '%s\n' "$check_res" >&2; exit 1
  fi
  append_audit_safe "$(python3 -c 'import json,sys; print(json.dumps({"ts":sys.argv[1],"action":"check_blast_radius","actor":sys.argv[2],"branch":sys.argv[3],"outcome":"ok"}))' "$ts" "$actor" "$branch")"
  printf '%s\n' "$check_res"
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
import datetime as dt, hashlib, json, pathlib, sys
root, now_iso = pathlib.Path(sys.argv[1]), sys.argv[2]
now_dt = dt.datetime.fromisoformat(now_iso.replace("Z", "+00:00"))
since_7d = now_dt - dt.timedelta(days=7)
ctrl = root / "control"
def load_json(p):
    try: return json.loads(p.read_text(encoding="utf-8")) if p.is_file() else None
    except Exception: return None
mode_doc = load_json(ctrl / "mode.json") or {"schemaVersion": 1, "mode": "autonomous", "autoMergeFrozen": False, "reason": "default uninitialized"}
active_a0, expired_a0, tampered_a0 = [], 0, 0
if (ctrl / "a0-approvals").is_dir():
    for f in sorted((ctrl / "a0-approvals").glob("*.json")):
        doc = load_json(f)
        if not doc: tampered_a0 += 1; continue
        sha, issued, expires, reason = str(doc.get("sha") or ""), str(doc.get("issuedAt") or ""), str(doc.get("expiresAt") or ""), str(doc.get("reason") or "")
        canonical = f"a0-approval-v1\nsha={sha}\nissuedAt={issued}\nexpiresAt={expires}\nreason={reason}\n"
        if hashlib.sha256(canonical.encode("utf-8")).hexdigest() != doc.get("sha256"): tampered_a0 += 1; continue
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
    "gate2_a0_approvals": {"activeCount": len(active_a0), "activeShas": active_a0, "expiredCount": expired_a0, "tamperedCount": tampered_a0},
    "gate3_blast_radius": {"hardLockedBranches": ["feat/v5-aurora-rewrite"], "activeVouchers": active_vouchers, "blockedAttempts7d": blocked_blast_7d},
    "gate4_circuit_breaker": {"tripped": bool(breaker_doc.get("tripped") or cost_doc.get("tripped")), "kind": breaker_doc.get("kind"), "rollbackCount7d": rollbacks_7d, "costBreakerTripped": bool(cost_doc.get("tripped")), "dailyUsd": cost_doc.get("dailyUsd"), "limitUsd": cost_doc.get("limitUsd"), "breakerCardPresent": card_path.is_file(), "breakerCardPath": str(card_path) if card_path.is_file() else None},
}, ensure_ascii=False, indent=2))
PY
}

usage() {
  cat <<'EOF'
Usage: oc-governor <command> [options]
  mode [show | autonomous | debt_first | emergency_stop] [--reason "..."]
  approve-a0 --sha <40hex> --reason "..." [--ttl-hours 24] [--allowed-path <p>]
  revoke-a0 --sha <40hex> [--reason "..."]
  verify-a0 --sha <40hex>
  check-blast-radius --branch <br> --files <f1> [f2...] [--voucher <id|path>]
  issue-blast-voucher --scope <ddl|billing|ddl+billing> --files <...> --reason "..." [--ttl-hours 4]
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
    record-rollback) _record_or_trip_rollback 0 "$@" ;;
    trip-breaker) _record_or_trip_rollback 1 "$@" ;;
    check-cost-breaker) cmd_check_cost_breaker "$@" ;;
    unlock-breaker) cmd_unlock_breaker "$@" ;;
    status) cmd_status "$@" ;;
    *) die_usage "unknown command: $cmd" ;;
  esac
}

main "$@"
