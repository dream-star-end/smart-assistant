#!/usr/bin/env bash
# OCV5-931 Layer 2: Host-side authoritative SSH command concurrency, memory & cgroup gate.
# Installed at /usr/local/bin/oc-host-cmd-gate and bound via authorized_keys:
#   command="/usr/local/bin/oc-host-cmd-gate" ssh-ed25519 ...
#
# Behavior summary:
#   - Empty SSH_ORIGINAL_COMMAND (interactive shell): exec login shell directly.
#   - Protocol channels (scp / sftp-server / rsync --server): zero-overhead passthrough.
#   - Authoritative classification: inspects BOTH raw SSH_ORIGINAL_COMMAND and decoded
#     _OC_B64_CMD payload; caller OC_HOST_CLASS=light can NEVER downgrade a heavy command.
#   - Light commands (git/gh/rg/cat/leases/deploy wrappers): sanitized syslog + direct exec.
#   - Heavy commands (tsc/vitest/playwright/npm build|test|check:*/etc.):
#       1) Bounded kernel flock slots (default 2) + live scope/pgid quota accounting
#          (surviving SIGKILL / OC_HOST_DETACH=1 tasks stay accounted until exit)
#          + MemAvailable admission guard (default 2500 MiB).
#       2) Private slot dir (0700) & files (0600); sanitized cmd_kind only (no raw secrets/args).
#       3) Fail-fast exit 75 (EX_TEMPFAIL) on timeout with active/detached/orphaned holder info.
#       4) Default NODE_OPTIONS="--max-old-space-size=3072" when not already specified.
#       5) systemd-run --scope --expand-environment=no --slice=oc-host-cmd.slice
#          --property=OOMPolicy=kill (fallback: setsid nice -n 15), plus /proc/self/oom_score_adj=500.
#       6) Preserves SSH stdin across background launch (FD 3 dup), signal traps + watchdog
#          covering both sshd disconnect and gate SIGKILL.
set -uo pipefail

# ─── Re-entrancy guard (prevent deadlock on nested invocations) ───────────────
if [[ "${OC_HOST_GATE_ACTIVE:-0}" == "1" ]]; then
  if [[ -z "${SSH_ORIGINAL_COMMAND:-}" ]]; then
    exec "${SHELL:-/bin/bash}" -l
  fi
  exec /bin/bash -c "$SSH_ORIGINAL_COMMAND"
fi

# ─── Optional debug/classification CLI mode (never triggered by sshd) ─────────
_CLI_CLASSIFY_ONLY=0
if [[ "${1:-}" == "--classify" ]]; then
  _CLI_CLASSIFY_ONLY=1
  SSH_ORIGINAL_COMMAND="${2:-}"
fi

# ─── Case A: Interactive shell (no SSH_ORIGINAL_COMMAND) ──────────────────────
if [[ $_CLI_CLASSIFY_ONLY -eq 0 && -z "${SSH_ORIGINAL_COMMAND:-}" ]]; then
  export OC_HOST_GATE_ACTIVE=1
  exec "${SHELL:-/bin/bash}" -l
fi

_RAW_CMD="${SSH_ORIGINAL_COMMAND:-}"
_GATE_PID=$$
_GATE_PARENT_PID=$PPID

# ─── Helpers ──────────────────────────────────────────────────────────────────
_log_syslog() {
  if [[ -S /dev/log ]] && command -v logger >/dev/null 2>&1; then
    logger -t oc-host-cmd-gate -- "$*" </dev/null >/dev/null 2>&1 || true
  fi
}

_sanitize_label() {
  local s="$1"
  local out="" i ch len=${#s}
  (( len > 64 )) && len=64
  for (( i = 0; i < len; i++ )); do
    ch="${s:i:1}"
    case "$ch" in
      [A-Za-z0-9._:-]) out+="$ch" ;;
      *) out+="_" ;;
    esac
  done
  printf '%s' "${out:-unknown}"
}

_now_ms() {
  if [[ -n "${EPOCHREALTIME:-}" ]]; then
    local rt="$EPOCHREALTIME"
    local sec="${rt%.*}"
    local frac="${rt#*.}"
    frac="${frac}000"
    printf '%d\n' $(( 10#$sec * 1000 + 10#${frac:0:3} ))
  else
    printf '%d\n' $(( $(date +%s) * 1000 ))
  fi
}

_now_epoch() {
  if [[ -n "${EPOCHSECONDS:-}" ]]; then
    printf '%s\n' "$EPOCHSECONDS"
  else
    date +%s
  fi
}

_read_mem_avail_mb() {
  local meminfo="${OC_HOST_MEMINFO_FILE:-/proc/meminfo}"
  if [[ ! -r "$meminfo" ]]; then
    printf '%d\n' -1
    return 0
  fi
  local key val rest
  while IFS=': ' read -r key val rest; do
    if [[ "$key" == "MemAvailable" && "$val" =~ ^[0-9]+$ ]]; then
      printf '%d\n' $(( val / 1024 ))
      return 0
    fi
  done < "$meminfo"
  printf '%d\n' -1
}

_read_proc_start_ticks() {
  local pid="$1"
  [[ "$pid" =~ ^[0-9]+$ && -r "/proc/${pid}/stat" ]] || return 1
  local stat_line rest
  IFS= read -r stat_line < "/proc/${pid}/stat" || return 1
  rest="${stat_line##*) }"
  local fields=()
  read -r -a fields <<< "$rest"
  # Field 3 (state) is fields[0], so field 22 (starttime) is fields[19]
  if [[ -n "${fields[19]:-}" && "${fields[19]}" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "${fields[19]}"
    return 0
  fi
  return 1
}

# ─── Unwrap host wrapper payload (_OC_B64_CMD + metadata) ────────────────────
_IS_WRAPPER_PAYLOAD=0
_MULTI_B64_SMUGGLE=0
_INNER_CMD="$_RAW_CMD"
_WRAPPER_SESSION=""
_WRAPPER_DETACH=""
_WRAPPER_CLASS=""

if [[ "$_RAW_CMD" == *"_OC_B64_CMD="* ]]; then
  # Detect multiple _OC_B64_CMD= assignments (smuggling defense)
  _scan="$_RAW_CMD"
  _b64_first=""
  _b64_count=0
  while [[ "$_scan" == *"_OC_B64_CMD="* ]]; do
    _after="${_scan#*_OC_B64_CMD=}"
    _val=""
    if [[ "$_after" =~ ^\'([A-Za-z0-9+/=]+)\' ]]; then
      _val="${BASH_REMATCH[1]}"
    elif [[ "$_after" =~ ^\"([A-Za-z0-9+/=]+)\" ]]; then
      _val="${BASH_REMATCH[1]}"
    elif [[ "$_after" =~ ^([A-Za-z0-9+/=]+) ]]; then
      _val="${BASH_REMATCH[1]}"
    fi
    (( _b64_count += 1 ))
    if (( _b64_count == 1 )); then
      _b64_first="$_val"
    elif [[ "$_val" != "$_b64_first" ]]; then
      _MULTI_B64_SMUGGLE=1
    fi
    _scan="$_after"
  done

  if [[ -n "$_b64_first" ]]; then
    if _decoded="$(printf '%s' "$_b64_first" | base64 -d 2>/dev/null)"; then
      _INNER_CMD="$_decoded"
      _IS_WRAPPER_PAYLOAD=1
    fi
  fi
  if [[ "$_RAW_CMD" =~ OC_CALLER_SESSION=\'([^\']*)\' ]] || [[ "$_RAW_CMD" =~ OC_CALLER_SESSION=([A-Za-z0-9_.:-]+) ]]; then
    _WRAPPER_SESSION="${BASH_REMATCH[1]}"
  fi
  if [[ "$_RAW_CMD" =~ OC_HOST_DETACH=\'([0-9]*)\' ]] || [[ "$_RAW_CMD" =~ OC_HOST_DETACH=([0-9]+) ]]; then
    _WRAPPER_DETACH="${BASH_REMATCH[1]}"
  fi
  if [[ "$_RAW_CMD" =~ OC_HOST_CLASS=\'([A-Za-z0-9_-]*)\' ]] || [[ "$_RAW_CMD" =~ OC_HOST_CLASS=([A-Za-z0-9_-]+) ]]; then
    _WRAPPER_CLASS="${BASH_REMATCH[1]}"
  fi
fi

# ─── Pure-bash quote-aware shell tokenizer ────────────────────────────────────
_TOK_SEP=$'\x1f'
_TOKENS=()

_tokenize_shell_cmd() {
  local src="$1"
  local len=${#src}
  local i=0 ch next
  local cur="" has_cur=0
  local in_sq=0 in_dq=0
  _TOKENS=()

  while (( i < len )); do
    ch="${src:i:1}"
    if (( in_sq )); then
      if [[ "$ch" == "'" ]]; then
        in_sq=0
      else
        cur+="$ch"
      fi
      (( i += 1 ))
      continue
    fi
    if (( in_dq )); then
      if [[ "$ch" == '"' ]]; then
        in_dq=0
      elif [[ "$ch" == '\' && $(( i + 1 )) -lt len ]]; then
        next="${src:i+1:1}"
        cur+="$next"
        (( i += 1 ))
      else
        cur+="$ch"
      fi
      (( i += 1 ))
      continue
    fi

    case "$ch" in
      "'")
        in_sq=1
        has_cur=1
        ;;
      '"')
        in_dq=1
        has_cur=1
        ;;
      '\')
        if (( i + 1 < len )); then
          next="${src:i+1:1}"
          if [[ "$next" != $'\n' ]]; then
            cur+="$next"
            has_cur=1
          fi
          (( i += 1 ))
        fi
        ;;
      ' '|$'\t'|$'\r')
        if (( has_cur )); then
          _TOKENS+=("$cur")
          cur=""
          has_cur=0
        fi
        ;;
      '#')
        if (( has_cur == 0 )); then
          while (( i < len )) && [[ "${src:i:1}" != $'\n' ]]; do
            (( i += 1 ))
          done
          continue
        else
          cur+="$ch"
        fi
        ;;
      ';'|$'\n'|'('|')')
        if (( has_cur )); then
          _TOKENS+=("$cur")
          cur=""
          has_cur=0
        fi
        _TOKENS+=("$_TOK_SEP")
        ;;
      '|')
        if (( has_cur )); then
          _TOKENS+=("$cur")
          cur=""
          has_cur=0
        fi
        if (( i + 1 < len )); then
          next="${src:i+1:1}"
          if [[ "$next" == '|' || "$next" == '&' ]]; then
            (( i += 1 ))
          fi
        fi
        _TOKENS+=("$_TOK_SEP")
        ;;
      '&')
        next=""
        if (( i + 1 < len )); then
          next="${src:i+1:1}"
        fi
        if [[ "$next" == '>' ]]; then
          cur+="&>"
          has_cur=1
          (( i += 1 ))
        elif [[ "$cur" == *'>' || "$cur" == *'<' ]]; then
          cur+="&"
          has_cur=1
        else
          if (( has_cur )); then
            _TOKENS+=("$cur")
            cur=""
            has_cur=0
          fi
          if [[ "$next" == '&' ]]; then
            (( i += 1 ))
          fi
          _TOKENS+=("$_TOK_SEP")
        fi
        ;;
      *)
        cur+="$ch"
        has_cur=1
        ;;
    esac
    (( i += 1 ))
  done

  if (( has_cur )); then
    _TOKENS+=("$cur")
  fi
}

# ─── Extract caller metadata only from leading INNER_CMD prefixes ─────────────
# SECURITY: Never allow container-supplied command text to override host
# guardrails (OC_HOST_MIN_AVAIL_MB, OC_HOST_HEAVY_SLOTS, OC_HOST_SLICE,
# OC_HOST_MEMINFO_FILE, OC_HOST_GATE_SLOTS_DIR, OC_HOST_SYSTEMD_RUN_BIN, etc.).
# Only caller metadata/classification hints are accepted from INNER_CMD.
_INLINE_HOST_CLASS=""
_INLINE_CALLER_SESSION=""
_INLINE_HOST_DETACH=""

_apply_inline_config_var() {
  local k="$1" v="$2"
  case "$k" in
    OC_HOST_CLASS)
      _INLINE_HOST_CLASS="$v"
      ;;
    OC_CALLER_SESSION)
      _INLINE_CALLER_SESSION="$v"
      ;;
    OC_HOST_DETACH)
      _INLINE_HOST_DETACH="$v"
      ;;
  esac
}

_extract_leading_env_overrides() {
  _tokenize_shell_cmd "$1"
  local tok_count=${#_TOKENS[@]}
  local idx=0 tok
  local in_export=0 in_env=0
  while (( idx < tok_count )); do
    tok="${_TOKENS[idx]}"
    if [[ "$tok" == "$_TOK_SEP" ]]; then
      in_export=0
      in_env=0
      (( idx += 1 ))
      continue
    fi
    if [[ "$tok" == "export" && $in_env -eq 0 ]]; then
      in_export=1
      (( idx += 1 ))
      continue
    fi
    if [[ "$tok" == "env" && $in_export -eq 0 ]]; then
      in_env=1
      (( idx += 1 ))
      continue
    fi
    if (( in_env )); then
      case "$tok" in
        -u|-C|--unset|--chdir)
          (( idx += 2 ))
          continue
          ;;
        -*)
          (( idx += 1 ))
          continue
          ;;
      esac
    fi
    if [[ "$tok" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      _apply_inline_config_var "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
      (( idx += 1 ))
      continue
    fi
    if (( in_export )); then
      if [[ "$tok" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
        (( idx += 1 ))
        continue
      fi
    fi
    break
  done
}

# ─── Protocol channel check (Case B: scp / sftp-server / rsync --server) ─────
_PROTO_KIND=""

_is_protocol_channel() {
  (( _IS_WRAPPER_PAYLOAD == 0 )) || return 1
  _tokenize_shell_cmd "$1"
  local tok_count=${#_TOKENS[@]}
  (( tok_count > 0 )) || return 1

  local seg=() idx=0 tok seg_count=0
  while (( idx < tok_count )); do
    tok="${_TOKENS[idx]}"
    if [[ "$tok" == "$_TOK_SEP" ]]; then
      if (( ${#seg[@]} > 0 )); then
        (( seg_count += 1 ))
        (( seg_count > 1 )) && return 1
      fi
    else
      if (( seg_count >= 1 )); then
        return 1
      fi
      seg+=("$tok")
    fi
    (( idx += 1 ))
  done
  (( ${#seg[@]} > 0 )) || return 1

  local pos=0 len=${#seg[@]}
  while (( pos < len )); do
    tok="${seg[pos]}"
    if [[ "$tok" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || [[ "$tok" == "exec" ]] || [[ "$tok" == "env" ]]; then
      (( pos += 1 ))
      continue
    fi
    break
  done
  (( pos < len )) || return 1

  local cmd_base="${seg[pos]##*/}"
  case "$cmd_base" in
    scp|sftp-server|internal-sftp)
      _PROTO_KIND="$cmd_base"
      return 0
      ;;
    rsync)
      local j
      for (( j = pos + 1; j < len; j++ )); do
        if [[ "${seg[j]}" == "--server" ]]; then
          _PROTO_KIND="rsync:server"
          return 0
        fi
      done
      ;;
  esac
  return 1
}

# ─── Heavy script name matcher ────────────────────────────────────────────────
_is_heavy_script_name() {
  local base="${1##*/}"
  case "$base" in
    check-v5-*.sh|check-v5-*.ts|check-v5-*.mjs|check-v5-*.py|\
    check-governance|check-governance.*|check-governance-*|\
    check-architecture|check-architecture.*|check-architecture-*|\
    check-file-size|check-file-size.*|check-file-size-*|\
    check-ai-smells|check-ai-smells.*|check-ai-smells-*|\
    check-complexity|check-complexity.*|check-complexity-*|\
    check-clones|check-clones.*|check-clones-*|\
    check-security-sast|check-security-sast.*|check-security-sast-*|\
    *.test.sh|*.test.ts|*.test.py|*.test.mjs|*.node-test.mjs|*_test.py)
      return 0
      ;;
  esac
  return 1
}

_is_script_filename() {
  local base="${1##*/}"
  case "$base" in
    *.sh|*.ts|*.tsx|*.mjs|*.cjs|*.js|*.py)
      [[ "$base" =~ ^[A-Za-z0-9._-]+$ ]] && return 0
      ;;
  esac
  return 1
}

_is_safe_subcmd_token() {
  local t="$1"
  [[ "$t" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{0,47}$ ]] && [[ "$t" != *"="* && "$t" != *"/"* ]]
}

_is_heavy_npx_tool() {
  local raw="$1"
  local base="${raw##*/}"
  if [[ "$base" == *@* ]]; then
    base="${base%%@*}"
  fi
  case "$base" in
    tsc|tsx|vitest|jest|playwright|vite|esbuild|webpack)
      return 0
      ;;
  esac
  return 1
}

# ─── Classify a single parsed command segment & produce sanitized _SEG_KIND ──
# Sets _SEG_KIND (sanitized command/subcommand tag with NO raw args/secrets).
# Returns 0 if HEAVY, 1 if LIGHT.
_SEG_KIND=""

_classify_segment() {
  local depth="$1"
  shift
  local words=("$@")
  local len=${#words[@]}
  local pos=0 tok
  _SEG_KIND=""

  # Skip leading shell keywords, redirections, and VAR=VAL assignments
  while (( pos < len )); do
    tok="${words[pos]}"
    case "$tok" in
      if|then|elif|else|fi|do|done|while|until|for|in|time|'!'|coproc|'{'|'}'|command|builtin|exec|nohup)
        (( pos += 1 ))
        continue
        ;;
      '>'|'>>'|'<'|'<<'|'<<<'|'2>'|'2>>'|'&>'|'&>>'|'1>'|'1>>')
        (( pos += 2 ))
        continue
        ;;
      '>'*|'<'*|'1>'*|'2>'*|'&>'*)
        (( pos += 1 ))
        continue
        ;;
    esac
    if [[ "$tok" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
      (( pos += 1 ))
      continue
    fi

    local base="${tok##*/}"
    case "$base" in
      env)
        (( pos += 1 ))
        while (( pos < len )); do
          tok="${words[pos]}"
          case "$tok" in
            --) (( pos += 1 )); break ;;
            -u|-C|--unset|--chdir) (( pos += 2 )) ;;
            -*) (( pos += 1 )) ;;
            *)
              if [[ "$tok" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
                (( pos += 1 ))
              else
                break
              fi
              ;;
          esac
        done
        continue
        ;;
      timeout)
        (( pos += 1 ))
        while (( pos < len )); do
          tok="${words[pos]}"
          case "$tok" in
            --) (( pos += 1 )); break ;;
            -k|-s|--kill-after|--signal) (( pos += 2 )) ;;
            -*) (( pos += 1 )) ;;
            *) break ;;
          esac
        done
        (( pos < len )) && (( pos += 1 ))
        continue
        ;;
      nice)
        (( pos += 1 ))
        while (( pos < len )); do
          tok="${words[pos]}"
          case "$tok" in
            --) (( pos += 1 )); break ;;
            -n|--adjustment) (( pos += 2 )) ;;
            -*) (( pos += 1 )) ;;
            *) break ;;
          esac
        done
        continue
        ;;
      ionice)
        (( pos += 1 ))
        while (( pos < len )); do
          tok="${words[pos]}"
          case "$tok" in
            --) (( pos += 1 )); break ;;
            -c|-n|-p|--class|--classdata) (( pos += 2 )) ;;
            -*) (( pos += 1 )) ;;
            *) break ;;
          esac
        done
        continue
        ;;
      setsid)
        (( pos += 1 ))
        while (( pos < len )); do
          tok="${words[pos]}"
          case "$tok" in
            --) (( pos += 1 )); break ;;
            -*) (( pos += 1 )) ;;
            *) break ;;
          esac
        done
        continue
        ;;
      stdbuf)
        (( pos += 1 ))
        while (( pos < len )); do
          tok="${words[pos]}"
          case "$tok" in
            --) (( pos += 1 )); break ;;
            -i|-o|-e|--input|--output|--error) (( pos += 2 )) ;;
            -*) (( pos += 1 )) ;;
            *) break ;;
          esac
        done
        continue
        ;;
      sudo)
        (( pos += 1 ))
        while (( pos < len )); do
          tok="${words[pos]}"
          case "$tok" in
            --) (( pos += 1 )); break ;;
            -u|-g|-C|-h|-p|-r|-t) (( pos += 2 )) ;;
            -*) (( pos += 1 )) ;;
            *) break ;;
          esac
        done
        continue
        ;;
    esac
    break
  done

  (( pos < len )) || return 1

  local cmd="${words[pos]}"
  local cmd_base="${cmd##*/}"
  local safe_cmd_base
  safe_cmd_base="$(_sanitize_label "$cmd_base")"
  _SEG_KIND="$safe_cmd_base"

  # Shell wrappers: bash/sh/dash/zsh -c "<inner>" or script file
  case "$cmd_base" in
    bash|sh|dash|zsh)
      local j=$(( pos + 1 ))
      local saw_c=0
      while (( j < len )); do
        tok="${words[j]}"
        case "$tok" in
          --)
            (( j += 1 ))
            break
            ;;
          -o|+o)
            (( j += 2 ))
            continue
            ;;
          -*c*)
            if [[ "$tok" != --* ]]; then
              saw_c=1
              (( j += 1 ))
              break
            fi
            (( j += 1 ))
            continue
            ;;
          -*)
            (( j += 1 ))
            continue
            ;;
          *)
            break
            ;;
        esac
      done
      if (( saw_c )) && (( j < len )) && (( depth < 4 )); then
        local _prev_match_kind="$_LAST_MATCH_KIND"
        if _classify_cmd_is_heavy "${words[j]}" $(( depth + 1 )); then
          if [[ -n "$_LAST_MATCH_KIND" ]]; then
            _SEG_KIND="$_LAST_MATCH_KIND"
          fi
          return 0
        fi
        _LAST_MATCH_KIND="$_prev_match_kind"
        return 1
      elif (( !saw_c )) && (( j < len )); then
        if _is_script_filename "${words[j]}"; then
          _SEG_KIND="${safe_cmd_base}:$(_sanitize_label "${words[j]##*/}")"
        fi
        if _is_heavy_script_name "${words[j]}"; then
          return 0
        fi
      fi
      return 1
      ;;
  esac

  # Direct heavy commands
  case "$cmd_base" in
    tsc|vitest|jest|playwright|chromium|chromium-headless-shell|chrome|google-chrome|vite|esbuild|webpack|tsx|pytest)
      _SEG_KIND="$cmd_base"
      return 0
      ;;
  esac

  # Heavy script invoked directly
  if _is_heavy_script_name "$cmd_base"; then
    _SEG_KIND="$safe_cmd_base"
    return 0
  fi

  # Subcommand-sensitive tools (extract safe subcommand labels only)
  case "$cmd_base" in
    git|gh|systemctl)
      local j=$(( pos + 1 ))
      while (( j < len )); do
        tok="${words[j]}"
        case "$tok" in
          -C|-c|--git-dir|--work-tree) (( j += 2 )) ;;
          -*) (( j += 1 )) ;;
          *)
            if _is_safe_subcmd_token "$tok"; then
              _SEG_KIND="${cmd_base}:${tok}"
            fi
            break
            ;;
        esac
      done
      return 1
      ;;

    npm)
      local j=$(( pos + 1 )) sub="" sub2=""
      while (( j < len )); do
        tok="${words[j]}"
        case "$tok" in
          --prefix|-C|--workspace|-w|--userconfig|--cache)
            (( j += 2 ))
            continue
            ;;
          -*)
            (( j += 1 ))
            continue
            ;;
          *)
            if [[ -z "$sub" ]]; then
              sub="$tok"
            elif [[ -z "$sub2" ]]; then
              sub2="$tok"
              break
            fi
            (( j += 1 ))
            ;;
        esac
      done
      if _is_safe_subcmd_token "$sub"; then
        _SEG_KIND="npm:${sub}"
        if [[ "$sub" == "run" || "$sub" == "run-script" || "$sub" == "exec" ]] && _is_safe_subcmd_token "$sub2"; then
          _SEG_KIND="npm:${sub}:${sub2}"
        fi
      fi
      case "$sub" in
        test|t|tst|ci|install|i|build)
          return 0
          ;;
        run|run-script)
          case "$sub2" in
            test|test:*|test-*|build|build:*|build-*|typecheck|typecheck:*|typecheck-*|check:*|lint|lint:*|lint-*)
              return 0
              ;;
          esac
          ;;
        exec)
          if [[ -n "$sub2" ]] && _is_heavy_npx_tool "$sub2"; then
            return 0
          fi
          ;;
      esac
      return 1
      ;;

    npx)
      local j=$(( pos + 1 )) tool=""
      while (( j < len )); do
        tok="${words[j]}"
        case "$tok" in
          --)
            (( j += 1 ))
            (( j < len )) && tool="${words[j]}"
            break
            ;;
          -p|--package)
            (( j += 2 ))
            continue
            ;;
          -*)
            (( j += 1 ))
            continue
            ;;
          *)
            tool="$tok"
            break
            ;;
        esac
      done
      if [[ -n "$tool" ]]; then
        local tool_base="${tool##*/}"
        [[ "$tool_base" == *@* ]] && tool_base="${tool_base%%@*}"
        if _is_safe_subcmd_token "$tool_base"; then
          _SEG_KIND="npx:${tool_base}"
        fi
        if _is_heavy_npx_tool "$tool" || _is_heavy_script_name "$tool"; then
          return 0
        fi
      fi
      return 1
      ;;

    bun)
      local j=$(( pos + 1 )) sub="" sub2=""
      while (( j < len )); do
        tok="${words[j]}"
        case "$tok" in
          --cwd|-c|--config)
            (( j += 2 ))
            continue
            ;;
          -*)
            (( j += 1 ))
            continue
            ;;
          *)
            if [[ -z "$sub" ]]; then
              sub="$tok"
            elif [[ -z "$sub2" ]]; then
              sub2="$tok"
              break
            fi
            (( j += 1 ))
            ;;
        esac
      done
      if _is_safe_subcmd_token "$sub"; then
        _SEG_KIND="bun:${sub}"
        if [[ "$sub" == "run" || "$sub" == "x" ]] && _is_safe_subcmd_token "$sub2"; then
          _SEG_KIND="bun:${sub}:${sub2}"
        fi
      elif _is_script_filename "$sub"; then
        _SEG_KIND="bun:$(_sanitize_label "${sub##*/}")"
      fi
      case "$sub" in
        test|build|install|i)
          return 0
          ;;
        run)
          case "$sub2" in
            test|test:*|test-*|build|build:*|build-*|typecheck|typecheck:*|check:*|lint|lint:*)
              return 0
              ;;
          esac
          ;;
        x)
          if [[ -n "$sub2" ]] && _is_heavy_npx_tool "$sub2"; then
            return 0
          fi
          ;;
        *)
          if [[ -n "$sub" ]] && _is_heavy_script_name "$sub"; then
            return 0
          fi
          ;;
      esac
      return 1
      ;;

    bunx)
      local j=$(( pos + 1 ))
      while (( j < len )) && [[ "${words[j]}" == -* ]]; do
        (( j += 1 ))
      done
      if (( j < len )); then
        local tool_base="${words[j]##*/}"
        [[ "$tool_base" == *@* ]] && tool_base="${tool_base%%@*}"
        _is_safe_subcmd_token "$tool_base" && _SEG_KIND="bunx:${tool_base}"
        if _is_heavy_npx_tool "${words[j]}"; then
          return 0
        fi
      fi
      return 1
      ;;

    node)
      local j=$(( pos + 1 )) first_script=""
      while (( j < len )); do
        tok="${words[j]}"
        case "$tok" in
          --test|--test=*)
            _SEG_KIND="node:test"
            return 0
            ;;
          *build-container-gateway*)
            _SEG_KIND="node:build-container-gateway"
            return 0
            ;;
          *layout-invariants*)
            _SEG_KIND="node:layout-invariants"
            return 0
            ;;
          *playwright*)
            _SEG_KIND="node:playwright"
            return 0
            ;;
          -e|--eval|-p|--print|-r|--require|--import|--loader|--conditions)
            (( j += 2 ))
            continue
            ;;
          -*)
            (( j += 1 ))
            continue
            ;;
          *)
            if [[ -z "$first_script" ]]; then
              first_script="$tok"
              if _is_script_filename "$first_script"; then
                _SEG_KIND="node:$(_sanitize_label "${first_script##*/}")"
              fi
              if _is_heavy_script_name "$first_script"; then
                return 0
              fi
            fi
            (( j += 1 ))
            ;;
        esac
      done
      return 1
      ;;

    docker)
      local j=$(( pos + 1 )) sub="" sub2=""
      while (( j < len )); do
        tok="${words[j]}"
        case "$tok" in
          -H|--host|--context|--config)
            (( j += 2 ))
            continue
            ;;
          -*)
            (( j += 1 ))
            continue
            ;;
          *)
            sub="$tok"
            (( j += 1 ))
            break
            ;;
        esac
      done
      _is_safe_subcmd_token "$sub" && _SEG_KIND="docker:${sub}"
      case "$sub" in
        build)
          return 0
          ;;
        buildx)
          while (( j < len )); do
            tok="${words[j]}"
            case "$tok" in
              --builder) (( j += 2 )) ;;
              -*) (( j += 1 )) ;;
              *) sub2="$tok"; break ;;
            esac
          done
          [[ "$sub2" == "build" ]] && { _SEG_KIND="docker:buildx:build"; return 0; }
          ;;
        compose)
          while (( j < len )); do
            tok="${words[j]}"
            case "$tok" in
              -f|--file|-p|--project-name|--env-file|--profile|--project-directory)
                (( j += 2 ))
                ;;
              -*)
                (( j += 1 ))
                ;;
              *)
                sub2="$tok"
                break
                ;;
            esac
          done
          _is_safe_subcmd_token "$sub2" && _SEG_KIND="docker:compose:${sub2}"
          [[ "$sub2" == "build" ]] && return 0
          ;;
      esac
      return 1
      ;;

    go)
      local j=$(( pos + 1 ))
      while (( j < len )) && [[ "${words[j]}" == -* ]]; do
        (( j += 1 ))
      done
      if (( j < len )); then
        _is_safe_subcmd_token "${words[j]}" && _SEG_KIND="go:${words[j]}"
        case "${words[j]}" in
          build|test) return 0 ;;
        esac
      fi
      return 1
      ;;

    cargo)
      local j=$(( pos + 1 ))
      while (( j < len )); do
        tok="${words[j]}"
        case "$tok" in
          +*|-*) (( j += 1 )) ;;
          *) break ;;
        esac
      done
      if (( j < len )); then
        _is_safe_subcmd_token "${words[j]}" && _SEG_KIND="cargo:${words[j]}"
        case "${words[j]}" in
          build|test) return 0 ;;
        esac
      fi
      return 1
      ;;

    python|python3)
      local j=$(( pos + 1 ))
      while (( j < len )); do
        tok="${words[j]}"
        case "$tok" in
          -m)
            if (( j + 1 < len )); then
              _is_safe_subcmd_token "${words[j+1]}" && _SEG_KIND="${cmd_base}:${words[j+1]}"
              if [[ "${words[j+1]}" == "pytest" ]]; then
                return 0
              fi
            fi
            (( j += 2 ))
            continue
            ;;
          -c)
            _SEG_KIND="${cmd_base}:inline"
            return 1
            ;;
          -*)
            (( j += 1 ))
            continue
            ;;
          *)
            if _is_script_filename "$tok"; then
              _SEG_KIND="${cmd_base}:$(_sanitize_label "${tok##*/}")"
            fi
            if _is_heavy_script_name "$tok"; then
              return 0
            fi
            break
            ;;
        esac
      done
      return 1
      ;;
  esac

  return 1
}

# ─── Extract command substitutions $(...) and `...` outside single quotes ─────
# Populates _CMD_SUBSTS with inner command strings from unquoted and double-quoted
# regions so commands like `echo "$(npx tsc -b)"` or `echo \`vitest run\`` cannot
# hide heavy work inside arguments, while single-quoted `'$(npx tsc -b)'` stays light.
_CMD_SUBSTS=()

_extract_cmd_substs() {
  local src="$1"
  local len=${#src}
  local i=0 ch next
  local in_sq=0 in_dq=0
  _CMD_SUBSTS=()

  while (( i < len )); do
    ch="${src:i:1}"
    if (( in_sq )); then
      if [[ "$ch" == "'" ]]; then
        in_sq=0
      fi
      (( i += 1 ))
      continue
    fi

    if (( in_dq )); then
      if [[ "$ch" == '\' && $(( i + 1 )) -lt len ]]; then
        (( i += 2 ))
        continue
      elif [[ "$ch" == '"' ]]; then
        in_dq=0
        (( i += 1 ))
        continue
      fi
    else
      if [[ "$ch" == '\' && $(( i + 1 )) -lt len ]]; then
        (( i += 2 ))
        continue
      elif [[ "$ch" == "'" ]]; then
        in_sq=1
        (( i += 1 ))
        continue
      elif [[ "$ch" == '"' ]]; then
        in_dq=1
        (( i += 1 ))
        continue
      elif [[ "$ch" == '#' ]] && (( i == 0 || "${src:i-1:1}" == ' ' || "${src:i-1:1}" == $'\t' || "${src:i-1:1}" == $'\n' || "${src:i-1:1}" == ';' )); then
        while (( i < len )) && [[ "${src:i:1}" != $'\n' ]]; do
          (( i += 1 ))
        done
        continue
      fi
    fi

    # $(...) command substitution (active both unquoted and inside double quotes)
    if [[ "$ch" == '$' && $(( i + 1 )) -lt len && "${src:i+1:1}" == '(' ]]; then
      (( i += 2 ))
      local pdepth=1 sub="" s_sq=0 s_dq=0 sch
      while (( i < len && pdepth > 0 )); do
        sch="${src:i:1}"
        if (( s_sq )); then
          sub+="$sch"
          [[ "$sch" == "'" ]] && s_sq=0
        elif (( s_dq )); then
          if [[ "$sch" == '\' && $(( i + 1 )) -lt len ]]; then
            sub+="$sch${src:i+1:1}"
            (( i += 1 ))
          else
            sub+="$sch"
            [[ "$sch" == '"' ]] && s_dq=0
          fi
        else
          if [[ "$sch" == '\' && $(( i + 1 )) -lt len ]]; then
            sub+="$sch${src:i+1:1}"
            (( i += 1 ))
          elif [[ "$sch" == "'" ]]; then
            s_sq=1
            sub+="$sch"
          elif [[ "$sch" == '"' ]]; then
            s_dq=1
            sub+="$sch"
          elif [[ "$sch" == '(' ]]; then
            (( pdepth += 1 ))
            sub+="$sch"
          elif [[ "$sch" == ')' ]]; then
            (( pdepth -= 1 ))
            if (( pdepth > 0 )); then
              sub+="$sch"
            fi
          else
            sub+="$sch"
          fi
        fi
        (( i += 1 ))
      done
      if [[ -n "$sub" ]]; then
        _CMD_SUBSTS+=("$sub")
      fi
      continue
    fi

    # `...` backtick command substitution (active both unquoted and inside double quotes)
    if [[ "$ch" == '`' ]]; then
      (( i += 1 ))
      local bsub="" bch
      while (( i < len )); do
        bch="${src:i:1}"
        if [[ "$bch" == '\' && $(( i + 1 )) -lt len ]]; then
          next="${src:i+1:1}"
          case "$next" in
            '$'|'`'|'\') bsub+="$next" ;;
            *) bsub+="$bch$next" ;;
          esac
          (( i += 2 ))
          continue
        elif [[ "$bch" == '`' ]]; then
          (( i += 1 ))
          break
        else
          bsub+="$bch"
          (( i += 1 ))
        fi
      done
      if [[ -n "$bsub" ]]; then
        _CMD_SUBSTS+=("$bsub")
      fi
      continue
    fi

    (( i += 1 ))
  done
}

# Returns 0 if ANY command segment in $1 is HEAVY, 1 if all segments are LIGHT.
# Sets _LAST_MATCH_KIND to the sanitized kind of the triggering heavy segment
# (or first meaningful non-cd/export segment when light).
_LAST_MATCH_KIND=""

_classify_cmd_is_heavy() {
  local cmd_str="$1"
  local depth="${2:-0}"
  _tokenize_shell_cmd "$cmd_str"
  if (( ${#_TOKENS[@]} > 0 )); then
    local local_tokens=("${_TOKENS[@]}")
    local tok_count=${#local_tokens[@]}
    local seg=() idx=0 tok
    local first_light_kind=""

    while (( idx < tok_count )); do
      tok="${local_tokens[idx]}"
      if [[ "$tok" == "$_TOK_SEP" ]]; then
        if (( ${#seg[@]} > 0 )); then
          if _classify_segment "$depth" "${seg[@]}"; then
            _LAST_MATCH_KIND="${_SEG_KIND:-heavy}"
            return 0
          fi
          if [[ -z "$first_light_kind" && -n "$_SEG_KIND" && "$_SEG_KIND" != "cd" && "$_SEG_KIND" != "export" && "$_SEG_KIND" != "true" && "$_SEG_KIND" != "logger" ]]; then
            first_light_kind="$_SEG_KIND"
          fi
          seg=()
        fi
      else
        seg+=("$tok")
      fi
      (( idx += 1 ))
    done

    if (( ${#seg[@]} > 0 )); then
      if _classify_segment "$depth" "${seg[@]}"; then
        _LAST_MATCH_KIND="${_SEG_KIND:-heavy}"
        return 0
      fi
      if [[ -z "$first_light_kind" && -n "$_SEG_KIND" && "$_SEG_KIND" != "cd" && "$_SEG_KIND" != "export" && "$_SEG_KIND" != "true" && "$_SEG_KIND" != "logger" ]]; then
        first_light_kind="$_SEG_KIND"
      fi
    fi

    if (( depth == 0 )) && [[ -n "$first_light_kind" ]]; then
      _LAST_MATCH_KIND="$first_light_kind"
    fi
  fi

  # Also recursively classify any $(...) / `...` command substitutions outside single quotes
  if (( depth < 4 )) && [[ "$cmd_str" == *'$('* || "$cmd_str" == *'`'* ]]; then
    _extract_cmd_substs "$cmd_str"
    if (( ${#_CMD_SUBSTS[@]} > 0 )); then
      local local_substs=("${_CMD_SUBSTS[@]}")
      local sub
      for sub in "${local_substs[@]}"; do
        if _classify_cmd_is_heavy "$sub" $(( depth + 1 )); then
          return 0
        fi
      done
    fi
  fi

  return 1
}

# ─── Case B: Protocol channels (scp / sftp-server / rsync --server) ───────────
if _is_protocol_channel "$_RAW_CMD"; then
  if (( _CLI_CLASSIFY_ONLY )); then
    printf 'light\n'
    exit 0
  fi
  _log_syslog "action=passthrough class=light reason=protocol cmd_kind=${_PROTO_KIND:-protocol} pid=${_GATE_PID}"
  export OC_HOST_GATE_ACTIVE=1
  exec /bin/bash -c "$_RAW_CMD"
fi

# ─── Resolve caller metadata (env + wrapper + leading INNER_CMD prefixes) ─────
_extract_leading_env_overrides "$_INNER_CMD"

# Caller metadata (sanitized; precedence: inline INNER_CMD > wrapper > env)
_RAW_CALLER_SESSION="${_INLINE_CALLER_SESSION:-${_WRAPPER_SESSION:-${OC_CALLER_SESSION:-unknown}}}"
CALLER_SESSION="$(_sanitize_label "${_RAW_CALLER_SESSION:-unknown}")"
if [[ -n "$_INLINE_HOST_DETACH" ]]; then
  OC_HOST_DETACH="$_INLINE_HOST_DETACH"
elif [[ -n "$_WRAPPER_DETACH" ]]; then
  OC_HOST_DETACH="$_WRAPPER_DETACH"
else
  OC_HOST_DETACH="${OC_HOST_DETACH:-0}"
fi
[[ "$OC_HOST_DETACH" == "1" ]] || OC_HOST_DETACH="0"

# Host-authoritative gate tunables (NEVER overridable from SSH_ORIGINAL_COMMAND)
SLOTS_DIR="${OC_HOST_GATE_SLOTS_DIR:-/run/oc-host-cmd/slots}"
HEAVY_SLOTS="${OC_HOST_HEAVY_SLOTS:-2}"
if ! [[ "$HEAVY_SLOTS" =~ ^[0-9]+$ ]] || (( HEAVY_SLOTS < 1 || HEAVY_SLOTS > 16 )); then
  HEAVY_SLOTS=2
fi

MIN_AVAIL_MB="${OC_HOST_MIN_AVAIL_MB:-2500}"
if ! [[ "$MIN_AVAIL_MB" =~ ^[0-9]+$ ]]; then
  MIN_AVAIL_MB=2500
fi

WAIT_TIMEOUT_SEC="${OC_HOST_WAIT_TIMEOUT_SEC:-180}"
if ! [[ "$WAIT_TIMEOUT_SEC" =~ ^[0-9]+$ ]]; then
  WAIT_TIMEOUT_SEC=180
fi

POLL_INTERVAL_SEC="${OC_HOST_POLL_INTERVAL_SEC:-1}"
if ! [[ "$POLL_INTERVAL_SEC" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
  POLL_INTERVAL_SEC=1
fi

HOST_SLICE="${OC_HOST_SLICE:-oc-host-cmd.slice}"
CGROUP_ROOT="${OC_HOST_CGROUP_ROOT:-/sys/fs/cgroup}"
DEFAULT_NODE_MAX_OLD_SPACE_MB="${OC_HOST_DEFAULT_NODE_MAX_OLD_SPACE_MB:-3072}"
if ! [[ "$DEFAULT_NODE_MAX_OLD_SPACE_MB" =~ ^[0-9]+$ ]] || (( DEFAULT_NODE_MAX_OLD_SPACE_MB < 128 )); then
  DEFAULT_NODE_MAX_OLD_SPACE_MB=3072
fi

HEAVY_OOM_SCORE_ADJ="${OC_HOST_HEAVY_OOM_SCORE_ADJ:-500}"
if ! [[ "$HEAVY_OOM_SCORE_ADJ" =~ ^-?[0-9]+$ ]] || (( HEAVY_OOM_SCORE_ADJ < -1000 || HEAVY_OOM_SCORE_ADJ > 1000 )); then
  HEAVY_OOM_SCORE_ADJ=500
fi
OOM_SCORE_ADJ_FILE="${OC_HOST_OOM_SCORE_ADJ_FILE:-/proc/self/oom_score_adj}"

# ─── Authoritative Classification (RAW + INNER; never allow light downgrade) ──
_EXPLICIT_CLASS=""
if [[ -n "$_INLINE_HOST_CLASS" ]]; then
  _EXPLICIT_CLASS="$_INLINE_HOST_CLASS"
elif [[ -n "$_WRAPPER_CLASS" ]]; then
  _EXPLICIT_CLASS="$_WRAPPER_CLASS"
elif [[ -n "${OC_HOST_CLASS:-}" ]]; then
  _EXPLICIT_CLASS="$OC_HOST_CLASS"
fi

_AUTO_HEAVY=0
_CMD_KIND=""

if (( _MULTI_B64_SMUGGLE )); then
  _AUTO_HEAVY=1
  _CMD_KIND="multi-b64-payload"
else
  _LAST_MATCH_KIND=""
  if _classify_cmd_is_heavy "$_RAW_CMD" 0; then
    _AUTO_HEAVY=1
    _CMD_KIND="${_LAST_MATCH_KIND:-heavy}"
  else
    _raw_light_kind="$_LAST_MATCH_KIND"
    if (( _IS_WRAPPER_PAYLOAD )); then
      _LAST_MATCH_KIND=""
      if _classify_cmd_is_heavy "$_INNER_CMD" 0; then
        _AUTO_HEAVY=1
        _CMD_KIND="${_LAST_MATCH_KIND:-heavy}"
      else
        _CMD_KIND="${_LAST_MATCH_KIND:-${_raw_light_kind:-cmd}}"
      fi
    else
      _CMD_KIND="${_raw_light_kind:-cmd}"
    fi
  fi
fi
_CMD_KIND="$(_sanitize_label "${_CMD_KIND:-cmd}")"

_CMD_CLASS="light"
if (( _AUTO_HEAVY )); then
  _CMD_CLASS="heavy"
  case "$_EXPLICIT_CLASS" in
    light|LIGHT)
      _log_syslog "action=warn reason=ignored_light_downgrade session=${CALLER_SESSION} pid=${_GATE_PID} cmd_kind=${_CMD_KIND}"
      ;;
  esac
else
  case "$_EXPLICIT_CLASS" in
    heavy|HEAVY)
      _CMD_CLASS="heavy"
      ;;
    *)
      _CMD_CLASS="light"
      ;;
  esac
fi

if (( _CLI_CLASSIFY_ONLY )); then
  printf '%s\n' "$_CMD_CLASS"
  exit 0
fi

# ─── Light Path: zero-queue direct exec ───────────────────────────────────────
if [[ "$_CMD_CLASS" == "light" ]]; then
  _log_syslog "action=passthrough class=light session=${CALLER_SESSION} pid=${_GATE_PID} cmd_kind=${_CMD_KIND}"
  export OC_HOST_GATE_ACTIVE=1
  exec /bin/bash -c "$_RAW_CMD"
fi

# ─── Heavy Path: private slots (0700/0600) + live quota + MemAvailable ────────
_ORIG_UMASK="$(umask)"
umask 077
mkdir -p "$SLOTS_DIR"
chmod 0700 "$SLOTS_DIR"

_JOB_ID="g-${_GATE_PID}-${RANDOM}"
_DONE_FILE="${SLOTS_DIR}/.done-${_JOB_ID}"
_READY_FILE="${SLOTS_DIR}/.ready-${_JOB_ID}"
_ACQUIRED_SLOT=""
_META_FILE=""
_CHILD_PID=""
_CHILD_PGID=""
_CHILD_START_TICKS=""
_CHILD_EXITED=0
_WD_PID=""
_SCOPE_UNIT=""
_USED_SYSTEMD_SCOPE=0
_USED_SETSID_FALLBACK=0
_FD3_OPEN=0
_FD9_OPEN=0
_CLEANED_UP=0
_STARTED_AT=""
_STARTED_EPOCH=""

# Check whether the task recorded in a slot .meta file is STILL alive
# (protects quota across gate SIGKILL and OC_HOST_DETACH=1).
_slot_task_is_alive() {
  local meta_f="$1"
  [[ -r "$meta_f" ]] || return 1

  local m_scope="" m_child_pid="" m_child_pgid="" m_child_ticks="" k v
  while IFS='=' read -r k v; do
    case "$k" in
      scope_unit) m_scope="$v" ;;
      child_pid) m_child_pid="$v" ;;
      child_pgid) m_child_pgid="$v" ;;
      child_start_ticks) m_child_ticks="$v" ;;
    esac
  done < "$meta_f"

  # 1. Check systemd scope unit (cgroup.procs non-empty OR systemctl is-active)
  if [[ -n "$m_scope" ]]; then
    local cg_procs="${CGROUP_ROOT}/${HOST_SLICE}/${m_scope}.scope/cgroup.procs"
    if [[ -r "$cg_procs" ]]; then
      local first_pid=""
      IFS= read -r first_pid < "$cg_procs" || true
      if [[ "$first_pid" =~ ^[0-9]+$ ]]; then
        return 0
      fi
    fi
    if [[ -d /run/systemd/system ]] && command -v systemctl >/dev/null 2>&1; then
      if systemctl is-active --quiet "${m_scope}.scope" 2>/dev/null; then
        return 0
      fi
    fi
  fi

  # 2. Check child_pid with start-ticks PID-reuse verification
  local pid_reused=0
  if [[ "$m_child_pid" =~ ^[0-9]+$ ]] && (( m_child_pid > 1 )); then
    if kill -0 "$m_child_pid" 2>/dev/null; then
      if [[ "$m_child_ticks" =~ ^[0-9]+$ ]]; then
        local cur_ticks=""
        cur_ticks="$(_read_proc_start_ticks "$m_child_pid" 2>/dev/null || true)"
        if [[ -n "$cur_ticks" && "$cur_ticks" == "$m_child_ticks" ]]; then
          return 0
        else
          pid_reused=1
        fi
      else
        return 0
      fi
    fi
  fi

  # 3. Check process group (catches grandchildren/detached tasks after leader exits)
  if [[ "$m_child_pgid" =~ ^[0-9]+$ ]] && (( m_child_pgid > 1 )); then
    if (( !pid_reused )) || [[ "$m_child_pgid" != "$m_child_pid" ]]; then
      if kill -0 -- "-${m_child_pgid}" 2>/dev/null; then
        return 0
      fi
    fi
  fi

  return 1
}

_write_slot_meta() {
  [[ -n "$_META_FILE" ]] || return 0
  local _prev_umask
  _prev_umask="$(umask)"
  umask 077
  local meta_tmp="${_META_FILE}.tmp.${_GATE_PID}"
  {
    printf 'job_id=%s\n' "$_JOB_ID"
    printf 'gate_pid=%s\n' "$_GATE_PID"
    printf 'slot=%s\n' "$_ACQUIRED_SLOT"
    printf 'scope_unit=%s\n' "$_SCOPE_UNIT"
    printf 'child_pid=%s\n' "$_CHILD_PID"
    printf 'child_pgid=%s\n' "$_CHILD_PGID"
    printf 'child_start_ticks=%s\n' "$_CHILD_START_TICKS"
    printf 'detach=%s\n' "$OC_HOST_DETACH"
    printf 'session=%s\n' "$CALLER_SESSION"
    printf 'started_at=%s\n' "$_STARTED_AT"
    printf 'started_epoch=%s\n' "$_STARTED_EPOCH"
    printf 'cmd_kind=%s\n' "$_CMD_KIND"
  } > "$meta_tmp"
  chmod 0600 "$meta_tmp" 2>/dev/null || true
  mv -f "$meta_tmp" "$_META_FILE"
  umask "$_prev_umask"
}

_child_or_pg_alive() {
  [[ -n "$_CHILD_PID" ]] && kill -0 "$_CHILD_PID" 2>/dev/null && return 0
  if (( _USED_SETSID_FALLBACK )) && [[ -n "$_CHILD_PGID" ]]; then
    kill -0 -- "-${_CHILD_PGID}" 2>/dev/null && return 0
  fi
  return 1
}

_cleanup() {
  if (( _CLEANED_UP )); then
    return 0
  fi
  _CLEANED_UP=1

  # Mark controlled cleanup so watchdog does not treat normal/handled exit as SIGKILL
  ( umask 077 && : > "$_DONE_FILE" ) 2>/dev/null || true

  if [[ -n "$_WD_PID" ]]; then
    kill "$_WD_PID" 2>/dev/null || true
    wait "$_WD_PID" 2>/dev/null || true
  fi

  if [[ -n "$_CHILD_PID" && "${OC_HOST_DETACH:-0}" != "1" ]]; then
    if _child_or_pg_alive; then
      if (( _USED_SETSID_FALLBACK )) && [[ -n "$_CHILD_PGID" ]]; then
        kill -TERM -- "-${_CHILD_PGID}" 2>/dev/null || true
      fi
      kill -TERM "$_CHILD_PID" 2>/dev/null || true
      if (( _USED_SYSTEMD_SCOPE )) && [[ -n "$_SCOPE_UNIT" && -d /run/systemd/system ]] && command -v systemctl >/dev/null 2>&1; then
        systemctl kill --kill-who=all -s SIGTERM "${_SCOPE_UNIT}.scope" 2>/dev/null || \
          systemctl kill --kill-who=all -s SIGTERM "${_SCOPE_UNIT}" 2>/dev/null || true
      fi
      local _i
      for (( _i = 0; _i < 10; _i++ )); do
        _child_or_pg_alive || break
        sleep 0.1
      done
      if _child_or_pg_alive; then
        if (( _USED_SETSID_FALLBACK )) && [[ -n "$_CHILD_PGID" ]]; then
          kill -KILL -- "-${_CHILD_PGID}" 2>/dev/null || true
        fi
        kill -KILL "$_CHILD_PID" 2>/dev/null || true
        if (( _USED_SYSTEMD_SCOPE )) && [[ -n "$_SCOPE_UNIT" && -d /run/systemd/system ]] && command -v systemctl >/dev/null 2>&1; then
          systemctl kill --kill-who=all -s SIGKILL "${_SCOPE_UNIT}.scope" 2>/dev/null || \
            systemctl kill --kill-who=all -s SIGKILL "${_SCOPE_UNIT}" 2>/dev/null || true
        fi
      fi
      wait "$_CHILD_PID" 2>/dev/null || true
    fi
  fi

  # Retain .meta if a detached (or still-alive) task continues running so it stays
  # accounted in slot quota; otherwise remove .meta cleanly.
  if [[ -n "$_META_FILE" ]]; then
    if [[ "${OC_HOST_DETACH:-0}" == "1" ]] && (( ! _CHILD_EXITED )); then
      : # Detached task interrupted by gate signal: keep .meta intact
    elif _slot_task_is_alive "$_META_FILE"; then
      : # Task/scope still has live processes: keep .meta intact
    else
      rm -f "$_META_FILE" 2>/dev/null || true
    fi
  fi

  rm -f "$_READY_FILE" "$_DONE_FILE" 2>/dev/null || true
  if (( _FD3_OPEN )); then
    exec 3<&-
    _FD3_OPEN=0
  fi
  if (( _FD9_OPEN )); then
    exec 9>&-
    _FD9_OPEN=0
  fi
}

_on_signal() {
  local sig="$1"
  local code=143
  case "$sig" in
    INT)  code=130 ;;
    HUP)  code=129 ;;
    TERM) code=143 ;;
  esac
  _cleanup
  trap - EXIT INT TERM HUP
  exit "$code"
}

trap '_cleanup' EXIT
trap '_on_signal INT' INT
trap '_on_signal TERM' TERM
trap '_on_signal HUP' HUP

_dump_active_holders() {
  local s lock_f meta_f any=0 now_ep
  now_ep="$(_now_epoch)"
  for (( s = 1; s <= HEAVY_SLOTS; s++ )); do
    lock_f="${SLOTS_DIR}/heavy-${s}.lock"
    meta_f="${SLOTS_DIR}/heavy-${s}.meta"
    local is_locked=0 task_alive=0
    if [[ -e "$lock_f" ]]; then
      if ( exec 8>>"$lock_f" && ! flock -n 8 ) 2>/dev/null; then
        is_locked=1
      fi
    fi
    if [[ -r "$meta_f" ]] && _slot_task_is_alive "$meta_f"; then
      task_alive=1
    fi
    if (( is_locked || task_alive )) && [[ -r "$meta_f" ]]; then
      any=1
      local m_job="" m_pid="" m_child="" m_slot="$s" m_session="" m_started="" m_started_ep="" m_cmd_kind="" m_detach="0"
      local k v
      while IFS='=' read -r k v; do
        case "$k" in
          job_id) m_job="$v" ;;
          gate_pid) m_pid="$v" ;;
          child_pid) m_child="$v" ;;
          slot) m_slot="$v" ;;
          session) m_session="$v" ;;
          started_at) m_started="$v" ;;
          started_epoch) m_started_ep="$v" ;;
          cmd_kind) m_cmd_kind="$v" ;;
          detach) m_detach="$v" ;;
        esac
      done < "$meta_f"
      local state="active" elapsed="unknown"
      if (( ! is_locked )); then
        if [[ "$m_detach" == "1" ]]; then
          state="detached"
        else
          state="orphaned"
        fi
      fi
      if [[ "$m_started_ep" =~ ^[0-9]+$ ]] && (( now_ep >= m_started_ep )); then
        elapsed="$(( now_ep - m_started_ep ))s"
      fi
      printf '  slot=%s state=%s job_id=%s pid=%s child_pid=%s session=%s started_at=%s elapsed=%s cmd_kind=%s\n' \
        "$m_slot" "$state" "${m_job:-unknown}" "${m_pid:-unknown}" "${m_child:-unknown}" \
        "${m_session:-unknown}" "${m_started:-unknown}" "$elapsed" "${m_cmd_kind:-unknown}" >&2
    elif (( is_locked )); then
      any=1
      printf '  slot=%s state=active job_id=unknown pid=unknown child_pid=unknown session=unknown started_at=unknown elapsed=unknown cmd_kind=pending\n' "$s" >&2
    fi
  done
  if (( !any )); then
    printf '  (none)\n' >&2
  fi
}

_start_ms="$(_now_ms)"
_deadline_ms=$(( _start_ms + WAIT_TIMEOUT_SEC * 1000 ))
_wait_reason="slot_busy"
_avail_mb="-1"

while true; do
  _avail_mb="$(_read_mem_avail_mb)"

  if (( _avail_mb >= 0 && _avail_mb < MIN_AVAIL_MB )); then
    _wait_reason="low_memory"
  else
    _slot_found=0
    for (( _s = 1; _s <= HEAVY_SLOTS; _s++ )); do
      _lock_path="${SLOTS_DIR}/heavy-${_s}.lock"
      _cand_meta="${SLOTS_DIR}/heavy-${_s}.meta"
      exec 9>>"$_lock_path"
      _FD9_OPEN=1
      if flock -n 9; then
        # Quota check: refuse slot if previous task's scope/pgid is STILL alive
        # (e.g. gate was SIGKILLed or task was OC_HOST_DETACH=1)
        if [[ -r "$_cand_meta" ]]; then
          if _slot_task_is_alive "$_cand_meta"; then
            exec 9>&-
            _FD9_OPEN=0
            _wait_reason="slot_busy"
            continue
          fi
          rm -f "$_cand_meta" 2>/dev/null || true
        fi
        # Re-check MemAvailable after acquiring lock to prevent brief race
        _avail_mb="$(_read_mem_avail_mb)"
        if (( _avail_mb >= 0 && _avail_mb < MIN_AVAIL_MB )); then
          exec 9>&-
          _FD9_OPEN=0
          _wait_reason="low_memory"
          break
        fi
        _ACQUIRED_SLOT="$_s"
        _slot_found=1
        break
      else
        exec 9>&-
        _FD9_OPEN=0
        _wait_reason="slot_busy"
      fi
    done

    if (( _slot_found )); then
      break
    fi
  fi

  _now="$(_now_ms)"
  if (( _now >= _deadline_ms )); then
    _waited_sec=$(( (_now - _start_ms) / 1000 ))
    _log_syslog "action=reject rc=75 reason=${_wait_reason} job_id=${_JOB_ID} wait_sec=${_waited_sec} avail_mb=${_avail_mb} min_avail_mb=${MIN_AVAIL_MB} slots=${HEAVY_SLOTS} session=${CALLER_SESSION} pid=${_GATE_PID} cmd_kind=${_CMD_KIND}"
    {
      printf '[oc-host-cmd-gate] EX_TEMPFAIL (75): heavy command admission timed out after %ss (reason=%s)\n' \
        "$_waited_sec" "$_wait_reason"
      printf '  MemAvailable: %s MiB (threshold: %s MiB)\n' "$_avail_mb" "$MIN_AVAIL_MB"
      printf '  Heavy slots: %s\n' "$HEAVY_SLOTS"
      printf '  Caller: job_id=%s session=%s cmd_kind=%s\n' "$_JOB_ID" "$CALLER_SESSION" "$_CMD_KIND"
      printf '  Active slot holders:\n'
    } >&2
    _dump_active_holders
    printf '  Hint: retry after active heavy tasks finish.\n' >&2
    exit 75
  fi

  sleep "$POLL_INTERVAL_SEC"
done

# Determine execution backend before pre-writing metadata (so scope_unit is recorded pre-launch)
_systemd_run_bin=""
if [[ "${OC_HOST_SYSTEMD_RUN_BIN+x}" == "x" ]]; then
  if [[ "$OC_HOST_SYSTEMD_RUN_BIN" != "none" && -n "$OC_HOST_SYSTEMD_RUN_BIN" && -x "$OC_HOST_SYSTEMD_RUN_BIN" ]]; then
    _systemd_run_bin="$OC_HOST_SYSTEMD_RUN_BIN"
  fi
else
  if [[ -d /run/systemd/system ]]; then
    _systemd_run_bin="$(command -v systemd-run 2>/dev/null || true)"
  fi
fi

if [[ -n "$_systemd_run_bin" ]]; then
  _SCOPE_UNIT="oc-host-cmd-heavy-${_GATE_PID}-${RANDOM}"
  _USED_SYSTEMD_SCOPE=1
fi

# Pre-write slot metadata atomically (0600) before spawning child
_META_FILE="${SLOTS_DIR}/heavy-${_ACQUIRED_SLOT}.meta"
_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
_STARTED_EPOCH="$(_now_epoch)"
_write_slot_meta

_admit_ms="$(_now_ms)"
_wait_sec=$(( (_admit_ms - _start_ms) / 1000 ))
_log_syslog "action=admit class=heavy job_id=${_JOB_ID} slot=${_ACQUIRED_SLOT}/${HEAVY_SLOTS} wait_sec=${_wait_sec} avail_mb=${_avail_mb} session=${CALLER_SESSION} pid=${_GATE_PID} detach=${OC_HOST_DETACH} cmd_kind=${_CMD_KIND}"

# ─── Default NODE_OPTIONS memory guardrail ────────────────────────────────────
if [[ "${NODE_OPTIONS:-}" != *"--max-old-space-size"* ]] && [[ "$_INNER_CMD" != *"--max-old-space-size"* ]]; then
  export NODE_OPTIONS="${NODE_OPTIONS:+${NODE_OPTIONS} }--max-old-space-size=${DEFAULT_NODE_MAX_OLD_SPACE_MB}"
fi

# ─── Execute under systemd-run cgroup scope (or setsid nice -n 15 fallback) ───
# Restore original umask before launching user command so child file creation
# observes normal umask while slot metadata remains 0700/0600.
umask "$_ORIG_UMASK"
export OC_HOST_GATE_ACTIVE=1

# Duplicate original SSH stdin onto FD 3 WITHOUT redirecting outer FD 2 (stderr!).
# (NOTE: `exec 3<&0 2>/dev/null` would permanently redirect the shell's FD 2 to /dev/null!)
if { true <&0; } 2>/dev/null; then
  exec 3<&0
else
  exec 3</dev/null
fi
_FD3_OPEN=1

# Zero-race startup latch: child waits for $_READY_FILE before running any user code,
# exiting 143 within 20ms if gate is SIGKILLed before releasing the latch. Once
# released, .meta (with child_pid/pgid/ticks) and watchdog are guaranteed ready.
# NOTE: systemd 255 rejects --property=OOMScoreAdjust= on --scope units and warns
# on '$1' expansion unless --expand-environment=no is passed; use OOMPolicy=kill
# and write /proc/self/oom_score_adj before exec'ing the user command.
_OOM_EXEC_SH='while [ ! -e "$4" ]; do kill -0 "$5" 2>/dev/null || exit 143; sleep 0.02; done; printf "%s\n" "$1" > "$2" 2>/dev/null || true; exec /bin/bash -c "$3"'

# Step 1: Fork child (parked on $_READY_FILE)
if [[ -n "$_systemd_run_bin" ]]; then
  "$_systemd_run_bin" \
    --quiet \
    --scope \
    --expand-environment=no \
    --slice="$HOST_SLICE" \
    --unit="$_SCOPE_UNIT" \
    --property=OOMPolicy=kill \
    --description="oc-host-cmd heavy (${CALLER_SESSION})" \
    -- /bin/bash -c "$_OOM_EXEC_SH" _ "$HEAVY_OOM_SCORE_ADJ" "$OOM_SCORE_ADJ_FILE" "$_RAW_CMD" "$_READY_FILE" "$_GATE_PID" \
    <&3 3<&- 9>&- &
  _CHILD_PID=$!
else
  if command -v setsid >/dev/null 2>&1; then
    _USED_SETSID_FALLBACK=1
    setsid nice -n 15 /bin/bash -c "$_OOM_EXEC_SH" _ "$HEAVY_OOM_SCORE_ADJ" "$OOM_SCORE_ADJ_FILE" "$_RAW_CMD" "$_READY_FILE" "$_GATE_PID" \
      <&3 3<&- 9>&- &
    _CHILD_PID=$!
    _CHILD_PGID="$_CHILD_PID"
  else
    nice -n 15 /bin/bash -c "$_OOM_EXEC_SH" _ "$HEAVY_OOM_SCORE_ADJ" "$OOM_SCORE_ADJ_FILE" "$_RAW_CMD" "$_READY_FILE" "$_GATE_PID" \
      <&3 3<&- 9>&- &
    _CHILD_PID=$!
  fi
fi

# Close parent's stdin duplicate immediately
exec 3<&-
_FD3_OPEN=0

# Step 2: Atomically backfill child_pid / child_pgid / child_start_ticks into .meta
_CHILD_START_TICKS="$(_read_proc_start_ticks "$_CHILD_PID" 2>/dev/null || true)"
_write_slot_meta

# Step 3: Start watchdog (handles BOTH sshd disconnect AND gate SIGKILL takeover)
if [[ "${OC_HOST_DETACH:-0}" != "1" ]]; then
  (
    _wd_parent="$_GATE_PARENT_PID"
    _wd_gate="$_GATE_PID"
    _wd_child="$_CHILD_PID"
    _wd_pgid="$_CHILD_PGID"
    _wd_scope="$_SCOPE_UNIT"
    _wd_used_scope="$_USED_SYSTEMD_SCOPE"
    _wd_used_setsid="$_USED_SETSID_FALLBACK"
    _wd_done="$_DONE_FILE"
    _wd_interval="${OC_HOST_WATCHDOG_INTERVAL_SEC:-1}"

    while true; do
      [[ -e "$_wd_done" ]] && exit 0
      # If sshd parent vanished, request graceful cleanup via SIGTERM to gate
      if [[ -n "$_wd_parent" ]] && (( _wd_parent > 1 )) && ! kill -0 "$_wd_parent" 2>/dev/null; then
        if kill -0 "$_wd_gate" 2>/dev/null; then
          kill -TERM "$_wd_gate" 2>/dev/null || true
        fi
      fi
      # If gate itself vanished without creating _DONE_FILE (e.g. SIGKILL), reap child/scope
      if ! kill -0 "$_wd_gate" 2>/dev/null; then
        if [[ ! -e "$_wd_done" ]]; then
          if (( _wd_used_setsid )) && [[ -n "$_wd_pgid" ]]; then
            kill -TERM -- "-${_wd_pgid}" 2>/dev/null || true
          fi
          [[ -n "$_wd_child" ]] && kill -TERM "$_wd_child" 2>/dev/null || true
          if (( _wd_used_scope )) && [[ -n "$_wd_scope" && -d /run/systemd/system ]] && command -v systemctl >/dev/null 2>&1; then
            systemctl kill --kill-who=all -s SIGTERM "${_wd_scope}.scope" 2>/dev/null || \
              systemctl kill --kill-who=all -s SIGTERM "${_wd_scope}" 2>/dev/null || true
          fi
          sleep 1
          if (( _wd_used_setsid )) && [[ -n "$_wd_pgid" ]]; then
            kill -KILL -- "-${_wd_pgid}" 2>/dev/null || true
          fi
          [[ -n "$_wd_child" ]] && kill -KILL "$_wd_child" 2>/dev/null || true
          if (( _wd_used_scope )) && [[ -n "$_wd_scope" && -d /run/systemd/system ]] && command -v systemctl >/dev/null 2>&1; then
            systemctl kill --kill-who=all -s SIGKILL "${_wd_scope}.scope" 2>/dev/null || \
              systemctl kill --kill-who=all -s SIGKILL "${_wd_scope}" 2>/dev/null || true
          fi
        fi
        exit 0
      fi
      sleep "$_wd_interval"
    done
  ) 3<&- 9>&- </dev/null >/dev/null 2>&1 &
  _WD_PID=$!
fi

# Step 4: Release startup latch (child begins executing user command now)
( umask 077 && : > "$_READY_FILE" )

_child_rc=0
wait "$_CHILD_PID" || _child_rc=$?
_CHILD_EXITED=1
_CHILD_PID=""

_cleanup
trap - EXIT INT TERM HUP
exit "$_child_rc"
