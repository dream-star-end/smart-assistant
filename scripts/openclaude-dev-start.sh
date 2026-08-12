#!/usr/bin/env bash
set -euo pipefail
DEV_ROOT=${OPENCLAUDE_DEV_ROOT:-${1:-/opt/openclaude/openclaude-dev}}
DEV_HOME=${OPENCLAUDE_DEV_HOME:-/root/.openclaude-dev}
PROD_SERVICE=${OPENCLAUDE_PROD_SERVICE:-openclaude.service}
PROD_PORT=${OPENCLAUDE_PROD_PORT:-18789}
DEV_PORT=${OPENCLAUDE_DEV_PORT:-18790}
DEV_BIND=${OPENCLAUDE_DEV_BIND:-127.0.0.1}
PIDFILE=${OPENCLAUDE_DEV_PIDFILE:-/run/openclaude-dev.pid}
GUARD_PIDFILE=${OPENCLAUDE_DEV_GUARD_PIDFILE:-/run/openclaude-dev-guard.pid}
LOG=${OPENCLAUDE_DEV_LOG:-/var/log/openclaude-dev.log}
CANONICAL_ROOT=${OPENCLAUDE_CANONICAL_ROOT:-/opt/openclaude/openclaude}
SECRETS_ENV=${OPENCLAUDE_SECRETS_ENV:-/etc/openclaude/secrets.env}

if [[ ! -d "$DEV_ROOT" || ! -f "$DEV_ROOT/package.json" ]]; then
  echo "dev root not found or invalid: $DEV_ROOT" >&2
  exit 2
fi
if ! systemctl is-active --quiet "$PROD_SERVICE"; then
  echo "refusing to start dev: prod service $PROD_SERVICE is not active" >&2
  exit 1
fi
if command -v ss >/dev/null 2>&1 && ! ss -ltn "sport = :$PROD_PORT" | grep -q ":$PROD_PORT"; then
  echo "refusing to start dev: prod port $PROD_PORT is not listening" >&2
  exit 1
fi

/usr/local/bin/openclaude-dev-stop >/dev/null 2>&1 || true

mkdir -p "$DEV_HOME" /run
if [[ ! -f "$DEV_HOME/openclaude.json" ]]; then
  if [[ -f /root/.openclaude/openclaude.json ]]; then
    cp /root/.openclaude/openclaude.json "$DEV_HOME/openclaude.json"
  else
    echo "missing dev config and prod config cannot be copied" >&2
    exit 1
  fi
fi

# Enforce mandatory isolation every time dev starts. In particular, WeChat and
# Telegram are forcibly disabled so dev never competes with prod long polling.
python3 - "$DEV_HOME/openclaude.json" "$DEV_BIND" "$DEV_PORT" <<'PY'
import json, secrets, sys
path, bind, port = sys.argv[1], sys.argv[2], int(sys.argv[3])
with open(path, 'r', encoding='utf-8') as f:
    cfg = json.load(f)
cfg.setdefault('gateway', {})
cfg['gateway']['bind'] = bind
cfg['gateway']['port'] = port
cfg['gateway'].setdefault('accessToken', 'dev-' + secrets.token_hex(16))
cfg.setdefault('channels', {})
cfg['channels'].setdefault('webchat', {})['enabled'] = True
cfg['channels'].setdefault('telegram', {})['enabled'] = False
cfg['channels'].setdefault('wechat', {})['enabled'] = False
with open(path, 'w', encoding='utf-8') as f:
    json.dump(cfg, f, ensure_ascii=False, indent=2)
    f.write('\n')
PY
chmod 600 "$DEV_HOME/openclaude.json" || true

# Worktrees normally share the canonical install's dependencies, but they must
# NOT share it via one blanket `ln -s canonical/node_modules dev/node_modules`:
# the @openclaude/* entries inside are relative links (../../packages/x), so
# through that symlink they resolve back into the canonical checkout and dev
# silently runs canonical code instead of the branch being validated (hit
# 2026-08-13 while validating a codex interrupt change — the dev result was a
# false negative and took hours to attribute). Link third-party packages
# individually and point the workspace packages at THIS root.
link_shared_deps() {
  local dst="$DEV_ROOT/node_modules"
  local entry name pkg rel canonical_real
  # Strip against the canonicalised root: CANONICAL_ROOT is a caller-settable
  # env var, so a trailing slash or a symlinked path would otherwise fail to
  # match readlink's normalised output and yield a bogus link target.
  canonical_real=$(readlink -f "$CANONICAL_ROOT")
  mkdir -p "$dst"
  shopt -s dotglob nullglob
  for entry in "$CANONICAL_ROOT"/node_modules/*; do
    name=$(basename "$entry")
    # Never link the scope dir itself — later writes would follow it into the
    # canonical tree.
    [[ "$name" == "@openclaude" ]] && continue
    [[ -e "$dst/$name" ]] || ln -s "$entry" "$dst/$name"
  done
  [[ -L "$dst/@openclaude" ]] && rm "$dst/@openclaude"
  mkdir -p "$dst/@openclaude"
  for pkg in "$CANONICAL_ROOT"/node_modules/@openclaude/*; do
    name=$(basename "$pkg")
    rel=$(readlink -f "$pkg")
    rel=${rel#"$canonical_real"/}
    ln -sfn "$DEV_ROOT/$rel" "$dst/@openclaude/$name"
  done
  shopt -u dotglob nullglob
}

if [[ -d "$CANONICAL_ROOT/node_modules" && "$DEV_ROOT" != "$CANONICAL_ROOT" ]]; then
  if [[ ! -e "$DEV_ROOT/node_modules" ]]; then
    link_shared_deps
  elif [[ -L "$DEV_ROOT/node_modules" ]] &&
    [[ "$(readlink -f "$DEV_ROOT/node_modules")" == "$(readlink -f "$CANONICAL_ROOT/node_modules")" ]]; then
    # Blanket symlink left by an older version of this script.
    rm "$DEV_ROOT/node_modules"
    link_shared_deps
  fi
fi
if [[ ! -f "$DEV_ROOT/node_modules/tsx/dist/preflight.cjs" ]]; then
  echo "missing tsx dependency under $DEV_ROOT/node_modules; run npm install in canonical checkout" >&2
  exit 1
fi

# Fail closed when workspace packages resolve outside DEV_ROOT: dev would run
# another checkout's code and every validation verdict from it is meaningless.
dev_real=$(readlink -f "$DEV_ROOT")
gateway_real=$(readlink -f "$DEV_ROOT/node_modules/@openclaude/gateway" 2>/dev/null || true)
if [[ -z "$gateway_real" || "$gateway_real" != "$dev_real"/* ]]; then
  echo "refusing to start dev: @openclaude/gateway resolves to ${gateway_real:-<missing>}," >&2
  echo "which is outside $dev_real — dev would run that code, not $DEV_ROOT." >&2
  echo "Fix: rm -rf $DEV_ROOT/node_modules and re-run, or npm install inside $DEV_ROOT." >&2
  exit 1
fi

: > "$LOG"
(
  cd "$DEV_ROOT"
  export OPENCLAUDE_HOME="$DEV_HOME"
  export PATH="/root/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  export FEATURE_FORK_SUBAGENT="${FEATURE_FORK_SUBAGENT:-1}"
  export CLAUDE_AUTO_BACKGROUND_TASKS="${CLAUDE_AUTO_BACKGROUND_TASKS:-0}"
  export TZ="${TZ:-Asia/Shanghai}"
  if [[ -f "$SECRETS_ENV" ]]; then
    set +u
    set -a
    # shellcheck disable=SC1090
    source "$SECRETS_ENV"
    set +a
    set -u
  fi
  exec /usr/bin/node --max-old-space-size=3072 \
    --require "$DEV_ROOT/node_modules/tsx/dist/preflight.cjs" \
    --import "file://$DEV_ROOT/node_modules/tsx/dist/loader.mjs" \
    packages/cli/src/index.ts gateway
) >>"$LOG" 2>&1 &
dev_pid=$!
echo "$dev_pid" > "$PIDFILE"

# Start guard after pidfile exists. It kills dev if prod becomes unhealthy.
OPENCLAUDE_DEV_PIDFILE="$PIDFILE" OPENCLAUDE_DEV_GUARD_PIDFILE="$GUARD_PIDFILE" \
  OPENCLAUDE_PROD_SERVICE="$PROD_SERVICE" OPENCLAUDE_PROD_PORT="$PROD_PORT" \
  nohup /usr/local/bin/openclaude-dev-guard >>"$LOG" 2>&1 &

echo "started openclaude dev pid=$dev_pid root=$DEV_ROOT home=$DEV_HOME bind=$DEV_BIND port=$DEV_PORT"
for _ in {1..40}; do
  if ! kill -0 "$dev_pid" 2>/dev/null; then
    echo "dev process exited during startup; tail $LOG:" >&2
    tail -80 "$LOG" >&2 || true
    rm -f "$PIDFILE"
    exit 1
  fi
  if command -v ss >/dev/null 2>&1 && ss -ltn "sport = :$DEV_PORT" | grep -q ":$DEV_PORT"; then
    echo "dev listening on $DEV_BIND:$DEV_PORT"
    echo "log: $LOG"
    exit 0
  fi
  sleep 0.25
done

echo "dev did not start listening on $DEV_PORT in time; tail $LOG:" >&2
tail -80 "$LOG" >&2 || true
exit 1
