#!/bin/sh
# oc-browser — per-Agent launcher for the pinned official Playwright CLI.
#
# Agent path: browser Skill -> Bash -> playwright-cli. There is no custom
# browser command translation or MCP stdio transport. Preserve the official
# daemon's structured error bit before the CLI discards it for display.
set -eu

# Never allow caller-supplied NODE_OPTIONS to hijack internal Node helpers or CLI.
unset NODE_OPTIONS

SELF="$(readlink -f "$0")"
# Bundle revision pin invariant shared by platform-runtime tools.
SELF_ROOT="$(cd "$(dirname "$SELF")/.." && pwd)"

die() {
  echo "oc-browser: $*" >&2
  exit 2
}

is_positive_integer() {
  case "$1" in
    ''|*[!0-9]*|0) return 1 ;;
    *) return 0 ;;
  esac
}

# Remove NODE_OPTIONS, global CLI config overrides, and every PLAYWRIGHT_MCP_*
# variable from the current (subshell) environment before invoking playwright-cli.
scrub_playwright_env() {
  unset NODE_OPTIONS PWTEST_CLI_GLOBAL_CONFIG
  _oc_mcp_vars="$(node -e '
    for (const k of Object.keys(process.env)) {
      if (/^PLAYWRIGHT_MCP_[A-Za-z0-9_]*$/.test(k)) console.log(k);
    }
  ' 2>/dev/null || true)"
  for _oc_var in $_oc_mcp_vars; do
    unset "$_oc_var"
  done
  unset _oc_mcp_vars _oc_var
}

# Returns 0 iff $1/human-takeover.json exists and has a future numeric expiresAt.
is_human_takeover_active() {
  _oc_takeover_file="$1/human-takeover.json"
  [ -r "$_oc_takeover_file" ] || return 1
  node -e '
    const fs = require("node:fs");
    try {
      const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (data && typeof data.expiresAt === "number" && Number.isFinite(data.expiresAt) && data.expiresAt > Date.now()) {
        process.exit(0);
      }
    } catch {}
    process.exit(1);
  ' "$_oc_takeover_file"
}

# Print PIDs of live Chrome/Chromium processes in this container using profile_dir.
find_profile_browser_pids() {
  _oc_profile="$1"
  [ -n "$_oc_profile" ] || return 0
  node -e '
    const fs = require("node:fs");
    const target = process.argv[1];
    const self = process.pid;
    const parent = process.ppid;
    let entries;
    try {
      entries = fs.readdirSync("/proc");
    } catch {
      process.exit(0);
    }
    for (const entry of entries) {
      if (!/^[0-9]+$/.test(entry)) continue;
      const pid = Number(entry);
      if (pid === self || pid === parent) continue;
      try {
        const raw = fs.readFileSync("/proc/" + entry + "/cmdline");
        if (!raw.length) continue;
        const parts = raw.toString("utf8").split("\0").filter(Boolean);
        if (!parts.length) continue;
        const exe = (parts[0] || "").toLowerCase();
        if (!/(?:chrome|chromium|headless_shell)/.test(exe)) continue;
        const matched = parts.some((p, i) =>
          p === "--user-data-dir=" + target ||
          (i > 0 && parts[i - 1] === "--user-data-dir" && p === target)
        );
        if (matched) console.log(pid);
      } catch {}
    }
  ' "$_oc_profile" 2>/dev/null || true
}

# Remove stale Chromium profile singleton locks & DevToolsActivePort when no live
# Chrome/Chromium process holds this profile_dir.
cleanup_stale_profile_locks() {
  _oc_profile="$1"
  [ -d "$_oc_profile" ] || return 0
  _oc_has_lock=0
  for _oc_f in SingletonLock SingletonCookie SingletonSocket DevToolsActivePort; do
    if [ -e "$_oc_profile/$_oc_f" ] || [ -L "$_oc_profile/$_oc_f" ]; then
      _oc_has_lock=1
      break
    fi
  done
  [ "$_oc_has_lock" -eq 1 ] || return 0
  _oc_live_pids="$(find_profile_browser_pids "$_oc_profile")"
  if [ -z "$_oc_live_pids" ]; then
    rm -f \
      "$_oc_profile/SingletonLock" \
      "$_oc_profile/SingletonCookie" \
      "$_oc_profile/SingletonSocket" \
      "$_oc_profile/DevToolsActivePort"
  fi
}

# Record managed daemon identity (pid, /proc/<pid>/stat starttime, display, kind)
# so later cleanup can verify process identity and never kill an unrelated reused PID.
write_daemon_meta() {
  _oc_kind="$1"
  _oc_pid="$2"
  _oc_disp="$3"
  _oc_meta_file="$4"
  node -e '
    const fs = require("node:fs");
    const [kind, pidStr, display, metaPath] = process.argv.slice(1);
    const pid = Number(pidStr);
    if (!Number.isInteger(pid) || pid <= 0) process.exit(1);
    const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
    const lastParen = stat.lastIndexOf(")");
    if (lastParen < 0) process.exit(1);
    const fields = stat.slice(lastParen + 2).trim().split(/\s+/);
    const starttime = fields[19];
    if (!starttime || !/^[0-9]+$/.test(starttime)) process.exit(1);
    const tmp = metaPath + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ kind, pid, starttime, display }) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, metaPath);
  ' "$_oc_kind" "$_oc_pid" "$_oc_disp" "$_oc_meta_file" 2>/dev/null || true
}

# Verify that pid_file + meta_file still refer to the exact managed Xvfb/openbox
# process we started (checking /proc/<pid>/stat starttime, comm/cmdline, and display).
# Returns 0 iff verified; 1 otherwise (never guess on missing/mismatched metadata).
verify_managed_daemon() {
  _oc_kind="$1"
  _oc_pid_file="$2"
  _oc_meta_file="$3"
  _oc_expected_disp="${4:-}"
  [ -r "$_oc_pid_file" ] && [ -r "$_oc_meta_file" ] || return 1
  _oc_pid="$(cat "$_oc_pid_file" 2>/dev/null || true)"
  is_positive_integer "$_oc_pid" || return 1
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const [kind, pidStr, metaPath, expectedDisp] = process.argv.slice(1);
    const pid = Number(pidStr);
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      if (!meta || meta.kind !== kind || meta.pid !== pid) process.exit(1);
      if (typeof meta.starttime !== "string" || !/^[0-9]+$/.test(meta.starttime)) process.exit(1);
      if (typeof meta.display !== "string" || !/^:[0-9]+$/.test(meta.display)) process.exit(1);
      if (expectedDisp && meta.display !== expectedDisp) process.exit(1);

      const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
      const lastParen = stat.lastIndexOf(")");
      if (lastParen < 0) process.exit(1);
      const fields = stat.slice(lastParen + 2).trim().split(/\s+/);
      if (fields[19] !== meta.starttime) process.exit(1);

      const comm = fs.readFileSync("/proc/" + pid + "/comm", "utf8").trim().toLowerCase();
      const cmdRaw = fs.readFileSync("/proc/" + pid + "/cmdline");
      const cmdParts = cmdRaw.toString("utf8").split("\0").filter(Boolean);
      const exeBase = cmdParts[0] ? path.basename(cmdParts[0]).toLowerCase() : "";

      if (kind === "xvfb") {
        if (comm !== "xvfb" && exeBase !== "xvfb") process.exit(1);
        if (!cmdParts.includes(meta.display)) process.exit(1);
        process.exit(0);
      }
      if (kind === "wm") {
        if (comm !== "openbox" && exeBase !== "openbox") process.exit(1);
        const envRaw = fs.readFileSync("/proc/" + pid + "/environ");
        const envParts = envRaw.toString("utf8").split("\0");
        if (!envParts.includes("DISPLAY=" + meta.display)) process.exit(1);
        process.exit(0);
      }
    } catch {}
    process.exit(1);
  ' "$_oc_kind" "$_oc_pid" "$_oc_meta_file" "$_oc_expected_disp"
}

# Gracefully terminate a verified managed daemon (xvfb or wm).
# If the PID no longer matches recorded starttime + command identity, only remove
# stale pid/meta files and NEVER signal an unrelated process.
stop_managed_daemon() {
  _oc_kind="$1"
  _oc_pid_file="$2"
  _oc_meta_file="$3"
  _oc_expected_disp="${4:-}"
  if verify_managed_daemon "$_oc_kind" "$_oc_pid_file" "$_oc_meta_file" "$_oc_expected_disp"; then
    _oc_pid="$(cat "$_oc_pid_file" 2>/dev/null || true)"
    kill -TERM "$_oc_pid" 2>/dev/null || true
    _oc_i=0
    while [ "$_oc_i" -lt 10 ]; do
      if ! verify_managed_daemon "$_oc_kind" "$_oc_pid_file" "$_oc_meta_file" "$_oc_expected_disp"; then
        break
      fi
      sleep 0.1
      _oc_i=$((_oc_i + 1))
    done
    if verify_managed_daemon "$_oc_kind" "$_oc_pid_file" "$_oc_meta_file" "$_oc_expected_disp"; then
      kill -KILL "$_oc_pid" 2>/dev/null || true
    fi
  fi
  rm -f "$_oc_pid_file" "$_oc_meta_file"
}

# Kill any orphaned Chrome/Chromium processes still referencing profile_dir.
kill_profile_orphans() {
  _oc_profile="$1"
  [ -n "$_oc_profile" ] || return 0
  _oc_pids="$(find_profile_browser_pids "$_oc_profile")"
  if [ -n "$_oc_pids" ]; then
    for _oc_p in $_oc_pids; do
      kill -TERM "$_oc_p" 2>/dev/null || true
    done
    _oc_i=0
    while [ "$_oc_i" -lt 10 ]; do
      _oc_remaining="$(find_profile_browser_pids "$_oc_profile")"
      [ -n "$_oc_remaining" ] || break
      sleep 0.1
      _oc_i=$((_oc_i + 1))
    done
    _oc_remaining="$(find_profile_browser_pids "$_oc_profile")"
    for _oc_p in $_oc_remaining; do
      kill -KILL "$_oc_p" 2>/dev/null || true
    done
  fi
  if [ -d "$_oc_profile" ]; then
    rm -f \
      "$_oc_profile/SingletonLock" \
      "$_oc_profile/SingletonCookie" \
      "$_oc_profile/SingletonSocket" \
      "$_oc_profile/DevToolsActivePort"
  fi
}

# Clean up browser runtime artifacts on close/reap/delete-data.
# Preserves profile_dir unless delete_profile=1 (delete-data).
cleanup_session_runtime() {
  _oc_state="$1"
  _oc_profile="$2"
  _oc_delete_profile="${3:-0}"

  kill_profile_orphans "$_oc_profile"
  stop_managed_daemon wm "$_oc_state/wm.pid" "$_oc_state/wm.meta"
  stop_managed_daemon xvfb "$_oc_state/xvfb.pid" "$_oc_state/xvfb.meta"
  rm -rf "$_oc_state/sockets" "$_oc_state/cache"
  rm -f \
    "$_oc_state/runtime-playwright-cli.config.json" \
    "$_oc_state/xvfb.display" \
    "$_oc_state/xvfb.pid" \
    "$_oc_state/xvfb.meta" \
    "$_oc_state/wm.pid" \
    "$_oc_state/wm.meta" \
    "$_oc_state/profile-dir" \
    "$_oc_state/human-takeover.json" \
    "$_oc_state/activity"
  if [ "$_oc_delete_profile" = "1" ] && [ -n "$_oc_profile" ]; then
    rm -rf "$_oc_profile"
  fi
}

# Read existing live Xvfb display for state_dir (prints ":<N>" if verified alive, else empty).
read_live_display() {
  _oc_state="$1"
  [ -r "$_oc_state/xvfb.display" ] && [ -r "$_oc_state/xvfb.pid" ] && [ -r "$_oc_state/xvfb.meta" ] || return 0
  _oc_disp="$(cat "$_oc_state/xvfb.display" 2>/dev/null || true)"
  case "$_oc_disp" in
    :[0-9]*)
      _oc_num="${_oc_disp#:}"
      if [ -S "/tmp/.X11-unix/X$_oc_num" ] \
        && verify_managed_daemon xvfb "$_oc_state/xvfb.pid" "$_oc_state/xvfb.meta" "$_oc_disp"; then
        printf '%s' "$_oc_disp"
      fi
      ;;
  esac
}

# Start openbox on $1 display and record verified pid + identity metadata under $2 state_dir.
start_openbox_wm() {
  _oc_disp="$1"
  _oc_state="$2"
  command -v openbox >/dev/null 2>&1 || return 0
  DISPLAY="$_oc_disp" setsid openbox 9>&- </dev/null >/dev/null 2>&1 &
  _oc_wmpid=$!
  _oc_w=0
  while [ "$_oc_w" -lt 10 ]; do
    if ! kill -0 "$_oc_wmpid" 2>/dev/null; then
      return 0
    fi
    if [ "$(cat "/proc/$_oc_wmpid/comm" 2>/dev/null || true)" = "openbox" ]; then
      break
    fi
    sleep 0.05
    _oc_w=$((_oc_w + 1))
  done
  if kill -0 "$_oc_wmpid" 2>/dev/null; then
    printf '%s\n' "$_oc_wmpid" >"$_oc_state/wm.pid"
    write_daemon_meta wm "$_oc_wmpid" "$_oc_disp" "$_oc_state/wm.meta"
    sleep 0.05
  fi
}

# Ensure a per-Agent Xvfb (+ optional openbox WM) is running on an isolated display >= :90.
# Sets global browser_display=":<N>". Never leaks FD9 to child daemons.
ensure_display() {
  _oc_state="$1"
  _oc_existing="$(read_live_display "$_oc_state")"
  if [ -n "$_oc_existing" ]; then
    browser_display="$_oc_existing"
    if command -v openbox >/dev/null 2>&1; then
      if ! verify_managed_daemon wm "$_oc_state/wm.pid" "$_oc_state/wm.meta" "$browser_display"; then
        rm -f "$_oc_state/wm.pid" "$_oc_state/wm.meta"
        start_openbox_wm "$browser_display" "$_oc_state"
      fi
    fi
    return 0
  fi

  stop_managed_daemon wm "$_oc_state/wm.pid" "$_oc_state/wm.meta"
  stop_managed_daemon xvfb "$_oc_state/xvfb.pid" "$_oc_state/xvfb.meta"
  rm -f "$_oc_state/xvfb.display"

  _oc_n=90
  while [ "$_oc_n" -le 290 ]; do
    if [ -e "/tmp/.X11-unix/X$_oc_n" ] || [ -e "/tmp/.X$_oc_n-lock" ]; then
      _oc_n=$((_oc_n + 1))
      continue
    fi
    setsid Xvfb ":$_oc_n" -screen 0 1440x900x24 -nolisten tcp -ac 9>&- </dev/null >/dev/null 2>&1 &
    _oc_xpid=$!
    _oc_wait=0
    _oc_ready=0
    while [ "$_oc_wait" -lt 60 ]; do
      if [ -S "/tmp/.X11-unix/X$_oc_n" ] && kill -0 "$_oc_xpid" 2>/dev/null; then
        _oc_ready=1
        break
      fi
      if ! kill -0 "$_oc_xpid" 2>/dev/null; then
        break
      fi
      sleep 0.05
      _oc_wait=$((_oc_wait + 1))
    done
    if [ "$_oc_ready" -eq 1 ]; then
      browser_display=":$_oc_n"
      printf '%s\n' "$browser_display" >"$_oc_state/xvfb.display"
      printf '%s\n' "$_oc_xpid" >"$_oc_state/xvfb.pid"
      write_daemon_meta xvfb "$_oc_xpid" "$browser_display" "$_oc_state/xvfb.meta"
      start_openbox_wm "$browser_display" "$_oc_state"
      return 0
    fi
    if kill -0 "$_oc_xpid" 2>/dev/null \
      && [ "$(cat "/proc/$_oc_xpid/comm" 2>/dev/null || true)" = "Xvfb" ]; then
      kill -TERM "$_oc_xpid" 2>/dev/null || true
    fi
    _oc_n=$((_oc_n + 1))
  done
  die "failed to start isolated Xvfb display"
}

# Atomically merge base template config with per-Agent runtime browser config.
write_runtime_config() {
  _oc_base="$1"
  _oc_out="$2"
  _oc_profile="$3"
  _oc_headless="$4"
  _oc_channel="$5"

  node -e '
    const fs = require("node:fs");
    const [basePath, outPath, profileDir, headlessFlag, channel] = process.argv.slice(1);
    let base = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(basePath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) base = parsed;
    } catch {}
    const baseBrowser = (base.browser && typeof base.browser === "object" && !Array.isArray(base.browser)) ? base.browser : {};
    const baseLaunch = (baseBrowser.launchOptions && typeof baseBrowser.launchOptions === "object" && !Array.isArray(baseBrowser.launchOptions)) ? baseBrowser.launchOptions : {};
    const baseContext = (baseBrowser.contextOptions && typeof baseBrowser.contextOptions === "object" && !Array.isArray(baseBrowser.contextOptions)) ? baseBrowser.contextOptions : {};
    const headless = headlessFlag === "1";
    const requiredArgs = [
      "--remote-debugging-port=0",
      "--disable-dev-shm-usage",
      "--window-size=1440,900",
      "--window-position=0,0",
      "--no-first-run",
      "--no-default-browser-check",
      "--lang=zh-CN"
    ];
    const mergedArgs = [];
    const existingArgs = Array.isArray(baseLaunch.args) ? baseLaunch.args : [];
    for (const arg of [...existingArgs, ...requiredArgs]) {
      if (typeof arg === "string" && arg.length > 0 && !mergedArgs.includes(arg)) {
        mergedArgs.push(arg);
      }
    }
    const launchOptions = {
      ...baseLaunch,
      chromiumSandbox: false,
      headless,
      args: mergedArgs
    };
    if (channel) {
      launchOptions.channel = channel;
    } else {
      delete launchOptions.channel;
    }
    const contextOptions = {
      ...baseContext,
      viewport: null
    };
    const next = {
      ...base,
      browser: {
        ...baseBrowser,
        browserName: typeof baseBrowser.browserName === "string" && baseBrowser.browserName ? baseBrowser.browserName : "chromium",
        isolated: false,
        userDataDir: profileDir,
        launchOptions,
        contextOptions
      }
    };
    const tmp = outPath + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, outPath);
  ' "$_oc_base" "$_oc_out" "$_oc_profile" "$_oc_headless" "$_oc_channel"
}

reap_idle_session() {
  state_dir="$1"
  lock_file="$2"
  activity_file="$3"
  pid_file="$4"
  browser_home="$5"
  cache_home="$6"
  session_name="$7"
  idle_seconds="$8"
  poll_seconds="$9"
  cli_bin="${10}"
  config_file="${11}"
  profile_dir="${12}"

  while sleep "$poll_seconds"; do
    [ -d "$state_dir" ] || exit 0
    exec 9>"$lock_file"
    flock -x 9
    if [ ! -f "$activity_file" ]; then
      if [ "$(cat "$pid_file" 2>/dev/null || true)" = "$$" ]; then rm -f "$pid_file"; fi
      flock -u 9
      exec 9>&-
      exit 0
    fi
    pending_live=0
    for pending in "$state_dir"/pending.*; do
      [ -e "$pending" ] || continue
      pending_pid="${pending##*.}"
      if is_positive_integer "$pending_pid" && kill -0 "$pending_pid" 2>/dev/null; then
        pending_live=1
      else
        rm -f "$pending"
      fi
    done
    cli_live=0
    for cli_active in "$state_dir"/cli-active.*; do
      [ -e "$cli_active" ] || continue
      cli_pid="${cli_active##*.}"
      if is_positive_integer "$cli_pid" && kill -0 "$cli_pid" 2>/dev/null; then
        cli_live=1
      else
        rm -f "$cli_active"
      fi
    done
    if [ "$pending_live" -eq 1 ] || [ "$cli_live" -eq 1 ] || is_human_takeover_active "$state_dir"; then
      flock -u 9
      exec 9>&-
      continue
    fi
    now="$(date +%s)"
    last="$(stat -c %Y "$activity_file" 2>/dev/null || echo 0)"
    if [ $((now - last)) -lt "$idle_seconds" ]; then
      flock -u 9
      exec 9>&-
      continue
    fi

    # Keep the reaper lock, but never leak FD9 into the official CLI daemon or
    # Chromium descendants; otherwise all future calls would deadlock.
    reap_config="$config_file"
    if [ -r "$state_dir/runtime-playwright-cli.config.json" ]; then
      reap_config="$state_dir/runtime-playwright-cli.config.json"
    fi
    reap_display="$(read_live_display "$state_dir")"
    (
      cd "$browser_home"
      scrub_playwright_env
      if [ -n "$reap_display" ]; then
        export DISPLAY="$reap_display"
      else
        unset DISPLAY
      fi
      XDG_CACHE_HOME="$cache_home" PLAYWRIGHT_CLI_SESSION="$session_name" \
        PWTEST_SOCKETS_DIR="$state_dir/sockets" \
        PLAYWRIGHT_MCP_CONFIG="$reap_config" \
        "$cli_bin" close 9>&- >/dev/null 2>&1 || true
    )
    cleanup_session_runtime "$state_dir" "$profile_dir" 0
    if [ "$(cat "$pid_file" 2>/dev/null || true)" = "$$" ]; then rm -f "$pid_file"; fi
    rmdir "$state_dir" 2>/dev/null || true
    flock -u 9
    exec 9>&-
    exit 0
  done
}

# Private detached entry used only by this launcher.
if [ "${1:-}" = "__openclaude_reap" ]; then
  [ "$#" -eq 13 ] || exit 2
  shift
  reap_idle_session "$@"
  exit 0
fi

raw_agent_id="${OPENCLAUDE_AGENT_ID:-${OC_AGENT_ID:-}}"
[ -n "$(printf '%s' "$raw_agent_id" | tr -d '[:space:]')" ] \
  || die "Agent identity is unavailable"
agent_prefix="$(printf '%s' "$raw_agent_id" | tr -c 'A-Za-z0-9._-' '_' | cut -c1-32)"
[ -n "$agent_prefix" ] || agent_prefix=agent
agent_hash="$(printf '%s' "$raw_agent_id" | sha256sum | cut -c1-16)"
agent_key="${agent_prefix}-${agent_hash}"

# Reject every escape hatch that could create/control another session or attach
# to an external browser. Scan the complete argv, including after `--`.
for arg in "$@"; do
  case "$arg" in
    -s|-s*|--session|--session=*|--profile|--profile=*|--config|--config=*|\
    --executable-path|--executable-path=*|\
    --extension|--extension=*|\
    --endpoint|--endpoint=*|\
    --cdp|--cdp=*|\
    --cdp-endpoint|--cdp-endpoint=*|\
    --user-data-dir|--user-data-dir=*|\
    --storage-state|--storage-state=*|\
    --browser|--browser=*)
      die "session/profile/config overrides are managed by OpenClaude"
      ;;
  esac
done

command=""
for arg in "$@"; do
  [ -n "$command" ] && break
  case "$arg" in
    --json|--raw|--help|--version|-h|-v|--) ;;
    -*) ;;
    *) command="$arg" ;;
  esac
done
case "$command" in
  kill-all|close-all|attach|detach)
    die "command '$command' is unavailable in an isolated Agent browser"
    ;;
esac

browser_home="${OPENCLAUDE_HOME:-/home/agent/.openclaude}"
[ -d "$browser_home" ] || die "browser workspace is unavailable: $browser_home"
state_dir="/tmp/openclaude-playwright-cli/$agent_key"
profile_dir="${browser_home}/browser-profiles/${agent_key}"
cache_home="$state_dir/cache"
lock_file="$state_dir/activity.lock"
activity_file="$state_dir/activity"
pid_file="$state_dir/reaper.pid"
runtime_config_file="$state_dir/runtime-playwright-cli.config.json"
session_name=browser
cli_bin=/usr/local/bin/playwright-cli
[ -x "$cli_bin" ] || die "pinned Playwright CLI is unavailable"
config_file=/etc/openclaude/playwright-cli.config.json
if [ -r "$SELF_ROOT/seed/playwright-cli.config.json" ]; then
  config_file="$SELF_ROOT/seed/playwright-cli.config.json"
fi
[ -r "$config_file" ] || die "pinned Playwright CLI config is unavailable"
chrome_bin_stable=/usr/bin/google-chrome-stable
chrome_bin_compat=/usr/bin/google-chrome

effective_config="$config_file"
browser_display=""

# Keep the official CLI's argv, output and isolated environment identical on
# both paths. FD9 must never reach its daemon or Chromium descendants.
run_cli() (
  cd "$browser_home"
  scrub_playwright_env
  if [ -n "$browser_display" ]; then
    export DISPLAY="$browser_display"
  else
    unset DISPLAY
  fi
  XDG_CACHE_HOME="$cache_home" PLAYWRIGHT_CLI_SESSION="$session_name" \
    PWTEST_SOCKETS_DIR="$state_dir/sockets" \
    PLAYWRIGHT_MCP_CONFIG="$effective_config" \
    node -e '
      const { realpathSync } = require("node:fs");
      const { createRequire } = require("node:module");
      const { dirname, join } = require("node:path");
      const cli = realpathSync(process.argv[1]);
      const cliRequire = createRequire(cli);
      const core = dirname(cliRequire.resolve("playwright-core/package.json"));
      const { Session } = cliRequire(join(core, "lib/tools/cli-client/session.js"));
      const run = Session.prototype.run;
      if (typeof run !== "function") {
        throw new Error("oc-browser: incompatible pinned Playwright CLI Session.run");
      }
      // CLI 0.1.14 prints only result.text. Read the trusted daemon envelope,
      // never page text, and leave official text/JSON/raw output untouched.
      Session.prototype.run = async function (...args) {
        const result = await run.apply(this, args);
        if (result.isError === true && !process.exitCode) process.exitCode = 1;
        return result;
      };
      process.argv = [process.execPath, cli, ...process.argv.slice(2)];
      cliRequire(cli);
    ' "$cli_bin" "$@" 9>&-
)

# help-fast-path: these official CLI operations never touch a browser. Do not
# queue diagnostics behind a busy page, create activity files or start a reaper.
# Only unambiguous standalone/command-help forms bypass the lock. In particular,
# `-- --help` is positional data and a later `--help=false` can cancel help.
# Identity and forbidden overrides above still fail closed on this path.
if [ "$#" -eq 1 ] || { [ "$#" -eq 2 ] && [ -n "$command" ]; }; then
  for arg in "$@"; do
    case "$arg" in
      --help|-h|--version|-v) run_cli "$@"; exit $? ;;
    esac
  done
fi
[ "$#" -ne 0 ] || { run_cli; exit $?; }

# Block agent browser actions while a human holds an active takeover lease.
# Only OPENCLAUDE_LIVE_BROWSER_INTERNAL=1 (user close via Gateway) may close during takeover.
check_human_takeover() {
  if [ "${OPENCLAUDE_LIVE_BROWSER_INTERNAL:-0}" = "1" ]; then
    return 0
  fi
  case "$command" in
    ''|list) return 0 ;;
  esac
  if is_human_takeover_active "$state_dir"; then
    echo "oc-browser: browser is currently under human takeover; wait for user to hand back control" >&2
    exit 1
  fi
}

check_human_takeover

idle_seconds="${OPENCLAUDE_PLAYWRIGHT_CLI_IDLE_SECONDS:-1800}"
poll_seconds="${OPENCLAUDE_PLAYWRIGHT_CLI_POLL_SECONDS:-30}"
is_positive_integer "$idle_seconds" || die "invalid idle timeout"
is_positive_integer "$poll_seconds" || die "invalid reaper poll interval"

umask 077
mkdir -p "$cache_home"
track_activity=1
case "$command" in
  ''|list|close|delete-data) track_activity=0 ;;
esac
# Record a waiting command before it blocks on another browser action. The
# reaper's lock-protected second check will then preserve the active session.
if [ "$track_activity" -eq 1 ]; then touch "$activity_file"; fi
pending_file="$state_dir/pending.$$"
cli_active_file="$state_dir/cli-active.$$"
: >"$pending_file"
: >"$cli_active_file"
trap 'rm -f "$pending_file" "$cli_active_file"' EXIT
trap 'exit 130' HUP INT TERM
exec 9>"$lock_file"
while ! flock -n 9; do
  if [ "$track_activity" -eq 1 ]; then touch "$activity_file"; fi
  sleep 1
done
rm -f "$pending_file"
check_human_takeover
if [ "$track_activity" -eq 1 ]; then touch "$activity_file"; fi

# Reuse live Xvfb display and existing runtime config when present.
browser_display="$(read_live_display "$state_dir")"
if [ -r "$runtime_config_file" ]; then
  effective_config="$runtime_config_file"
fi

if [ "${OPENCLAUDE_BROWSER_OPEN_IF_IDLE:-0}" = "1" ] && [ "$command" = "open" ]; then
  # Atomic under flock: if another process already opened a session before we acquired
  # the lock, preserve that live page instead of letting Playwright CLI stop/replace it.
  if run_cli tab-list >/dev/null 2>&1; then
    set -- tab-list
    command=tab-list
  fi
fi

# Detect real Chrome channel (gracefully fall back to Playwright Chromium if absent).
chrome_channel=""
if [ "${OPENCLAUDE_BROWSER_FORCE_CHROMIUM:-0}" != "1" ]; then
  if [ -x "$chrome_bin_stable" ] || [ -x "$chrome_bin_compat" ]; then
    chrome_channel="chrome"
  fi
fi

use_headed=1
if [ "${OPENCLAUDE_BROWSER_HEADLESS:-0}" = "1" ] || ! command -v Xvfb >/dev/null 2>&1; then
  use_headed=0
fi

if [ "$track_activity" -eq 1 ]; then
  mkdir -p "$profile_dir"
  printf '%s\n' "$profile_dir" >"$state_dir/profile-dir.tmp.$$"
  mv -f "$state_dir/profile-dir.tmp.$$" "$state_dir/profile-dir"
fi

if [ "$command" = "open" ]; then
  cleanup_stale_profile_locks "$profile_dir"
  if [ "$use_headed" -eq 1 ]; then
    ensure_display "$state_dir"
    write_runtime_config "$config_file" "$runtime_config_file" "$profile_dir" 0 "$chrome_channel"
  else
    browser_display=""
    write_runtime_config "$config_file" "$runtime_config_file" "$profile_dir" 1 "$chrome_channel"
  fi
  effective_config="$runtime_config_file"
elif [ "$track_activity" -eq 1 ] && [ ! -r "$runtime_config_file" ]; then
  if [ -n "$browser_display" ]; then
    write_runtime_config "$config_file" "$runtime_config_file" "$profile_dir" 0 "$chrome_channel"
  else
    write_runtime_config "$config_file" "$runtime_config_file" "$profile_dir" 1 "$chrome_channel"
  fi
  effective_config="$runtime_config_file"
fi

reaper_pid="$(cat "$pid_file" 2>/dev/null || true)"
if [ "$track_activity" -eq 1 ] && \
  { ! is_positive_integer "$reaper_pid" || ! kill -0 "$reaper_pid" 2>/dev/null; }; then
  # Register the singleton while holding the lock. 9>&- ensures the detached
  # child opens the lock independently instead of inheriting ownership.
  setsid "$SELF" __openclaude_reap \
    "$state_dir" "$lock_file" "$activity_file" "$pid_file" \
    "$browser_home" "$cache_home" "$session_name" \
    "$idle_seconds" "$poll_seconds" "$cli_bin" "$config_file" "$profile_dir" \
    9>&- </dev/null >/dev/null 2>&1 &
  printf '%s\n' "$!" >"$pid_file"
fi

set +e
run_cli "$@"
status=$?
set -e

case "$command" in
  close)
    cleanup_session_runtime "$state_dir" "$profile_dir" 0
    ;;
  delete-data)
    cleanup_session_runtime "$state_dir" "$profile_dir" 1
    ;;
esac
flock -u 9
exec 9>&-
exit "$status"
