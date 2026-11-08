#!/usr/bin/env python3
"""
OCV5-721: Pooled Remote Agent Brain Host Daemon (`oc-remote-hostd.py`).

Runs on remote Linux nodes under a restricted SSH forced-command:
  command="/home/<user>/.openclaude/bin/oc-remote-hostd.py --serve-mux",no-pty,no-agent-forwarding,no-X11-forwarding,no-user-rc

Supported subcommands:
  --probe       Discover installed CLI engines (`cc`, `codex`, `antigravity`, `grok-build`),
                login state, masked email/account hint, deterministic account_fingerprint,
                5h/7d quota windows, available models, and Gate G self-check.
  --self-check  Run Gate G security & MCP roundtrip self-check.
  --serve-mux   Accept framed JSON-RPC over stdin/stdout for multiplexed hot_idle / active
                sessions (cc interactive tmux+oc-bridge, codex app-server, antigravity, grok-build).

Hard rule for `cc` (Claude Code):
  100% interactive tmux PTY + oc-bridge Hook mode ONLY.
  `-p`, `--print`, `--input-format`, and `--output-format` are strictly forbidden.
"""

from __future__ import annotations

import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import time
from typing import Any, Dict, List, Optional

FORBIDDEN_CC_PRINT_FLAGS = {
    "-p",
    "--print",
    "--input-format",
    "--output-format",
    "--include-partial-messages",
    "--replay-user-messages",
}

# Only used when the CLI binary on disk is a tiny synthetic shell stub (< 64 KiB) in unit tests.
SYNTHETIC_STUB_FALLBACK_MODELS: Dict[str, List[Dict[str, str]]] = {
    "cc": [
        {"upstream_model_id": "claude-sonnet-4-6", "display_name": "Sonnet 4.6"},
        {"upstream_model_id": "claude-opus-4-7", "display_name": "Opus 4.7 (1M)"},
        {"upstream_model_id": "claude-sonnet-5", "display_name": "Sonnet 5"},
    ],
    "antigravity": [
        {"upstream_model_id": "gemini-4-argon", "display_name": "Gemini 4 Argon"},
        {"upstream_model_id": "gemini-3.8-flash", "display_name": "Gemini 3.8 Flash"},
    ],
    "grok-build": [
        {"upstream_model_id": "grok-4.7", "display_name": "Grok 4.7"},
        {"upstream_model_id": "grok-4.7-build-fast", "display_name": "Grok 4.7 Fast"},
    ],
}


def resolve_binary_path(binary: str) -> Optional[str]:
    exe = shutil.which(binary)
    if not exe:
        for prefix in ("/home/box/.local/bin", "/home/box/.npm-global/bin", "/usr/local/bin", "/usr/bin"):
            cand = os.path.join(prefix, binary)
            if os.path.isfile(cand) and os.access(cand, os.X_OK):
                exe = cand
                break
    return exe


def is_synthetic_stub_binary(exe_path: Optional[str]) -> bool:
    if not exe_path:
        return False
    try:
        p = pathlib.Path(exe_path).resolve()
        return p.is_file() and p.stat().st_size < 65536
    except Exception:
        return False


def discover_cc_models_from_cli(exe_path: Optional[str]) -> List[Dict[str, str]]:
    if not exe_path:
        return []
    try:
        p = pathlib.Path(exe_path).resolve()
        if not p.is_file():
            return []
        raw_bytes = p.read_bytes()
        models: List[Dict[str, str]] = []
        seen = set()
        fallback_models: List[Dict[str, str]] = []
        fallback_seen = set()
        pattern = re.compile(
            rb'\{id:"(claude-[a-z0-9-]+)",family:"(?:haiku|sonnet|opus|fable)",display_name:"([^"]+)"'
        )
        for m in pattern.finditer(raw_bytes):
            mid = m.group(1).decode("utf-8", errors="ignore").strip()
            disp = m.group(2).decode("utf-8", errors="ignore").strip()
            if not mid:
                continue
            tail = raw_bytes[m.end() : m.end() + 450].split(b',{id:"', 1)[0]
            if b"advisor_rank:" in tail:
                if mid not in seen:
                    seen.add(mid)
                    models.append({"upstream_model_id": mid, "display_name": disp or mid})
            elif re.match(r"^claude-(?:opus|sonnet|haiku|fable)-[45]", mid):
                if mid not in fallback_seen:
                    fallback_seen.add(mid)
                    fallback_models.append({"upstream_model_id": mid, "display_name": disp or mid})
        if models:
            return models
        if fallback_models:
            return fallback_models
    except Exception:
        pass
    if is_synthetic_stub_binary(exe_path):
        return list(SYNTHETIC_STUB_FALLBACK_MODELS["cc"])
    return []


# Codex discovery is a native protocol exchange, never a credential/cache heuristic.
CODEX_DISABLE = ('shell_tool', 'unified_exec', 'view_image', 'image_generation',
                 'multi_agent', 'multi_agent_v2', 'apps', 'plugins', 'browser_use',
                 'computer_use', 'in_app_browser', 'sleep_tool', 'skill_search',
                 'tool_suggest', 'goals', 'hooks', 'skill_mcp_dependency_install')


def codex_policy_args():
    args = ['app-server', '--strict-config', '--listen', 'stdio://']
    for feature in CODEX_DISABLE:
        args += ['--disable', feature]
    args += ['--enable', 'skip_host_skill_discovery']
    for value in ('approval_policy="never"', 'sandbox_mode="read-only"', 'web_search="disabled"'):
        args += ['-c', value]
    return args


def codex_check_config_sources(codex_home, cwd, system_root=pathlib.Path("/etc/codex")):
    # 0.167.0 has no --ignore-user-config. Reject before any MCP can be spawned.
    candidates = [codex_home / 'config.toml', codex_home / 'AGENTS.md',
                  codex_home / 'AGENTS.override.md', system_root / 'config.toml',
                  system_root / 'managed_config.toml', system_root / 'requirements.toml']
    for parent in (cwd, *cwd.parents):
        candidates += [parent / '.codex/config.toml', parent / 'AGENTS.md', parent / 'AGENTS.override.md']
    if any(p.exists() or p.is_symlink() for p in candidates):
        raise ValueError('CODEX_POLICY_REJECTED')


def engine_resources():
    # Same immutable bundle as this controller; never import user search paths.
    import types
    source = pathlib.Path(__file__).resolve().with_name('remote-engine-resources.py')
    data = source.read_bytes()
    if hashlib.sha256(data).hexdigest() != '66083b5913581789232d8ec3535427cc1aef34601f0e4b2c6fee6534af9e2feb':
        raise RuntimeError('REMOTE_RESOURCE_BUNDLE_MISMATCH')
    module = types.ModuleType('remote_engine_resources'); module.__file__ = str(source)
    exec(compile(data, str(source), 'exec'), module.__dict__)
    return module


def codex_scope_command(unit, argv, environment, role='app'):
    c = engine_resources().config('codex')
    return ['/usr/bin/systemd-run', '--user', '--scope', '--quiet', '--unit', unit,
            '-p', 'Slice=' + c['slice'], '-p', 'MemoryMax=' + str(c[role]),
            '-p', 'TasksMax=128', '-p', 'KillMode=control-group',
            '--', '/usr/bin/env', '-i', *[k + '=' + v for k, v in environment.items()], *argv]


def codex_systemctl(*args):
    env = {'PATH': '/usr/bin:/bin', 'XDG_RUNTIME_DIR': '/run/user/' + str(os.getuid())}
    return subprocess.run(['/usr/bin/systemctl', '--user', *args], env=env,
                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=8, text=True)


def codex_scope_state(unit):
    result = codex_systemctl('show', unit, '--property=ActiveState,SubState,ControlGroup,LoadState')
    if result.returncode:
        raise ValueError('CODEX_STOP_UNKNOWN')
    return dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)


def codex_scope_stop(unit):
    codex_systemctl('kill', '--signal=KILL', '--kill-whom=all', unit)
    result = codex_systemctl('stop', unit)
    state = codex_scope_state(unit)
    if state.get('ActiveState') not in ('inactive', 'failed') or state.get('ControlGroup'):
        raise ValueError('CODEX_STOP_UNKNOWN')


# Runs inside the scope before any CLI/auth/config processing. A dead probe owner can
# fence a queued systemd launch; late workers cannot use a new generation's claim.
# OCV5-746 §4: the probe has its own claim file and exec gate; runtime Codex lanes never take
# either, so a discovery probe cannot block a running session and a running session never
# blocks discovery for longer than the probe's own scope.
CODEX_PROBE_WRAPPER = """import fcntl,json,os,pathlib,sys
home=pathlib.Path(os.environ['CODEX_HOME']); unit=sys.argv[1]
fd=os.open(home/'PROBE-LAUNCH.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
fcntl.flock(fd,fcntl.LOCK_EX); os.set_inheritable(fd,True)
claim=json.loads((home/'PROBE_ACTIVE.json').read_text())
if claim.get('unit')!=unit or (home/(unit+'.revoked')).exists(): sys.exit(126)
os.execve(sys.argv[2],sys.argv[2:],dict(os.environ))
"""


def codex_reconcile_probe_locked(codex_home):
    """PROBE-CLAIM.lock held exclusively. Never reads or clears runtime lane claims."""
    import fcntl
    import stat
    active=codex_home/'PROBE_ACTIVE.json'
    fd=os.open(active,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        st=os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or st.st_mode&0o077 or st.st_size>16384:
            raise ValueError('CODEX_PROFILE_BUSY')
        claim=json.loads(os.read(fd,16385))
    finally: os.close(fd)
    unit=claim.get('unit'); pid=claim.get('ownerPid'); ticks=claim.get('ownerStartTicks')
    if (not isinstance(unit,str) or not re.fullmatch(r'oc-codex-probe-[0-9a-f]{32}\.scope',unit)
            or type(pid) is not int or pid<=0 or not isinstance(ticks,str) or not ticks.isdigit()
            or claim.get('bootId')!=pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()):
        raise ValueError('CODEX_STOP_UNKNOWN')
    # The probe claim lock, not the long-lived hostd PID, is the probe's authority: holding it
    # proves the previous probe returned or died, and the exec gate below still fences a queued
    # child. Fence first; even a systemd job queued before owner death cannot launch its CLI later.
    revoked=codex_home/(unit+'.revoked')
    fd=os.open(revoked,os.O_CREAT|os.O_WRONLY|os.O_NOFOLLOW,0o600)
    try: os.fsync(fd)
    finally: os.close(fd)
    dfd=os.open(codex_home,os.O_RDONLY|os.O_DIRECTORY)
    try: os.fsync(dfd)
    finally: os.close(dfd)
    codex_scope_stop(unit)
    gate=os.open(codex_home/'PROBE-LAUNCH.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    try:
        try: fcntl.flock(gate,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError: raise ValueError('CODEX_STOP_UNKNOWN') from None
        # Stop verified by systemd; gate and retained revocation prevent a delayed exec.
        engine_resources().release('probe:' + unit)
        active.unlink()
        dfd=os.open(codex_home,os.O_RDONLY|os.O_DIRECTORY)
        try: os.fsync(dfd)
        finally: os.close(dfd)
    finally: os.close(gate)


CODEX_NATIVE_BINARY = pathlib.Path('/usr/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex')

def codex_execution_snapshot(codex_home, exe_path, models):
    """Read-only provisioning material, never auth.json; unavailable is not fabricated readiness."""
    import stat
    def read(path, limit):
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            st = os.fstat(fd)
            if not stat.S_ISREG(st.st_mode) or st.st_size <= 0 or st.st_size > limit:
                raise ValueError('CODEX_SNAPSHOT_UNAVAILABLE')
            data = os.read(fd, limit + 1)
            if len(data) != st.st_size: raise ValueError('CODEX_SNAPSHOT_UNAVAILABLE')
            return data
        finally: os.close(fd)
    try:
        native = CODEX_NATIVE_BINARY
        catalog = json.loads(read(codex_home / 'models_cache.json', 4 * 1024 * 1024))
        raw = catalog.get('models')
        if not isinstance(raw, list): raise ValueError('CODEX_SNAPSHOT_UNAVAILABLE')
        ids = {m['upstream_model_id'] for m in models}
        selected = [m for m in raw if isinstance(m, dict) and m.get('slug') in ids]
        if len(selected) != len(ids) or {m['slug'] for m in selected} != ids:
            raise ValueError('CODEX_SNAPSHOT_UNAVAILABLE')
        # CLI is the installed symlink, but only its resolved regular file is read.
        cli_sha = hashlib.sha256(read(pathlib.Path(exe_path).resolve(), 4 * 1024 * 1024)).hexdigest()
        fd = os.open(native, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            st = os.fstat(fd)
            if not stat.S_ISREG(st.st_mode) or not 0 < st.st_size <= 512 * 1024 * 1024:
                raise ValueError('CODEX_SNAPSHOT_UNAVAILABLE')
            digest = hashlib.sha256(); size = 0
            while True:
                chunk = os.read(fd, 1024 * 1024)
                if not chunk: break
                size += len(chunk)
                if size > st.st_size: raise ValueError('CODEX_SNAPSHOT_UNAVAILABLE')
                digest.update(chunk)
            after = os.fstat(fd)
            if size != st.st_size or (st.st_size,st.st_mtime_ns,st.st_ctime_ns) != (after.st_size,after.st_mtime_ns,after.st_ctime_ns):
                raise ValueError('CODEX_SNAPSHOT_UNAVAILABLE')
            native_sha = digest.hexdigest()
        finally: os.close(fd)
        controller_sha = hashlib.sha256(read(pathlib.Path(__file__).resolve().with_name('codex-host-controller.py'), 256 * 1024)).hexdigest()
        return {'version': 1, 'modelList': [m['native'] for m in models], 'modelCatalog': {'models': selected},
                'cliSha256': cli_sha, 'nativeSha256': native_sha, 'controllerSha256': controller_sha}, None
    except (OSError, ValueError, KeyError, TypeError):
        return None, 'CODEX_SNAPSHOT_UNAVAILABLE'


def codex_profile_probe(codex_home, exe_path, timeout=20):
    """Exact CODEX_HOME; full pages or no catalog. Returns observed, not online-verified auth."""
    import fcntl
    import selectors
    import tempfile
    import uuid
    result = {'auth_present': (codex_home / 'auth.json').is_file(), 'account_observed': False,
              'models_observed': False, 'execution_ready': False, 'probe_schema_version': 2,
              'source': 'codex-app-server:model/list', 'freshness': 'cli-observed',
              'discovered_models': [], 'error_code': None, 'account': None}
    if not exe_path:
        result['error_code'] = 'CODEX_NOT_INSTALLED'; return result
    if not result['auth_present']:
        result['error_code'] = 'CODEX_AUTH_MISSING'; return result
    process = None
    lock = None
    unit = 'oc-codex-probe-' + uuid.uuid4().hex + '.scope'
    started = False
    claimed = False
    reserved = False
    temporary = None
    active = codex_home / 'PROBE_ACTIVE.json'
    try:
        if codex_home.is_symlink() or codex_home.resolve() != codex_home.absolute():
            raise ValueError('CODEX_POLICY_REJECTED')
        # The probe is exclusive only with another probe: runtime lanes share CODEX_HOME and are
        # never blocked by discovery (OCV5-746 §4).
        lock = os.open(codex_home / 'PROBE-CLAIM.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError('CODEX_PROFILE_BUSY') from None
        if active.exists() or active.is_symlink(): codex_reconcile_probe_locked(codex_home)
        fd = os.open(active, os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_WRONLY, 0o600)
        with os.fdopen(fd, 'wb') as out:
            out.write(json.dumps({'kind':'probe','unit':unit,'bootId':pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
                                  'ownerPid':os.getpid(),'ownerStartTicks':pathlib.Path('/proc/self/stat').read_text().rsplit(')',1)[1].split()[19]}).encode())
            out.flush(); os.fsync(out.fileno())
        directory_fd = os.open(codex_home, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(directory_fd)
        finally: os.close(directory_fd)
        claimed = True
        temporary = tempfile.mkdtemp(prefix='oc-codex-probe-')
        if temporary:
            root = pathlib.Path(temporary)
            cwd = root / 'empty'; cwd.mkdir(mode=0o500)
            home = root / 'home'; home.mkdir(mode=0o700)
            codex_check_config_sources(codex_home, cwd)
            resources = engine_resources()
            resources.admit('probe:' + unit, 'codex', str(codex_home),
                            {unit: resources.config('codex')['app']}, kind='probe')
            reserved = True
            env = {'HOME': str(home), 'CODEX_HOME': str(codex_home), 'PATH': '/usr/bin:/bin',
                   'LANG': 'C.UTF-8', 'XDG_CONFIG_HOME': str(home / 'config'),
                   'XDG_DATA_HOME': str(home / 'data'), 'XDG_CACHE_HOME': str(home / 'cache')}
            argv = codex_scope_command(unit, ['/usr/bin/python3','-I','-B','-c',CODEX_PROBE_WRAPPER,unit,exe_path,*codex_policy_args()], env)
            process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                       stderr=subprocess.DEVNULL, cwd=cwd, bufsize=0,
                                       env={'PATH': '/usr/bin:/bin', 'XDG_RUNTIME_DIR': '/run/user/' + str(os.getuid())})
            started = True
            deadline = time.monotonic() + timeout
            selector = selectors.DefaultSelector(); selector.register(process.stdout, selectors.EVENT_READ)
            buffer = b''; received = 0; rid = 0
            def rpc(method, params):
                nonlocal rid, buffer, received
                rid += 1
                process.stdin.write((json.dumps({'id': rid, 'method': method, 'params': params})+'\n').encode())
                while time.monotonic() < deadline:
                    while b'\n' in buffer:
                        line, buffer = buffer.split(b'\n', 1)
                        frame = json.loads(line)
                        if 'method' in frame and 'id' in frame:
                            raise ValueError('CODEX_POLICY_REJECTED')
                        if frame.get('id') == rid:
                            if 'error' in frame or not isinstance(frame.get('result'), dict):
                                raise ValueError('CODEX_MODEL_LIST_FAILED')
                            return frame['result']
                    if not selector.select(max(0, deadline - time.monotonic())):
                        break
                    data = os.read(process.stdout.fileno(), 65536)
                    if not data: raise ValueError('CODEX_MODEL_LIST_FAILED')
                    buffer += data; received += len(data)
                    if received > 8 * 1024 * 1024 or len(buffer) > 2 * 1024 * 1024:
                        raise ValueError('CODEX_MODEL_LIST_FAILED')
                raise ValueError('CODEX_PROBE_TIMEOUT')
            try:
                rpc('initialize', {'clientInfo': {'name': 'openclaude_remote_probe', 'version': '2'},
                                   'capabilities': {'experimentalApi': True}})
                process.stdin.write(b'{"method":"initialized","params":{}}\n')
                account = rpc('account/read', {}) .get('account')
                if not isinstance(account, dict) or account.get('type') != 'chatgpt':
                    raise ValueError('CODEX_ACCOUNT_UNAVAILABLE')
                result['account_observed'] = True
                # Never return a token-bearing account object to hostd callers.
                result['account'] = {k: account[k] for k in ('type','email','planType') if isinstance(account.get(k), str)}
                models = []; ids = set(); cursors = set(); cursor = None
                for _ in range(64):
                    page = rpc('model/list', {'cursor': cursor, 'limit': 100, 'includeHidden': True})
                    if not isinstance(page.get('data'), list): raise ValueError('CODEX_MODEL_LIST_FAILED')
                    for item in page['data']:
                        if not isinstance(item, dict): raise ValueError('CODEX_MODEL_LIST_FAILED')
                        mid = item.get('model') or item.get('id')
                        if not isinstance(mid, str) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}', mid) or mid in ids:
                            raise ValueError('CODEX_MODEL_LIST_FAILED')
                        ids.add(mid)
                        normalized = {'upstream_model_id': mid, 'display_name': item.get('displayName') or mid,
                                      'native': item}
                        for native, key in (('supportedReasoningEfforts','supported_reasoning_efforts'),
                                            ('defaultReasoningEffort','default_reasoning_effort'),
                                            ('inputModalities','input_modalities'), ('serviceTiers','service_tiers'),
                                            ('hidden','hidden')):
                            if native in item: normalized[key] = item[native]
                        models.append(normalized)
                    cursor = page.get('nextCursor')
                    if cursor is None: break
                    if not isinstance(cursor, str) or not cursor or cursor in cursors:
                        raise ValueError('CODEX_MODEL_LIST_FAILED')
                    cursors.add(cursor)
                else: raise ValueError('CODEX_MODEL_LIST_FAILED')
                if not models: raise ValueError('CODEX_MODEL_LIST_EMPTY')
                result.update(discovered_models=models, models_observed=True,
                              observed_at=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                              snapshot_sha256=hashlib.sha256(json.dumps(models,sort_keys=True,separators=(',',':')).encode()).hexdigest())
                snapshot, error = codex_execution_snapshot(codex_home, exe_path, models)
                result.update(execution_snapshot=snapshot, execution_snapshot_error=error)
            finally:
                selector.close()
                # Always stop before temp HOME is removed or the auth writer lock released.
                codex_scope_stop(unit)
                process.wait(timeout=8)
                started = False
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
        code = str(exc)
        result.update(discovered_models=[], models_observed=False,
                      error_code=code if re.fullmatch(r'(?:CODEX|REMOTE)_[A-Z_]+', code) else 'CODEX_MODEL_LIST_FAILED')
    finally:
        if started:
            try:
                codex_scope_stop(unit)
                process.wait(timeout=8)
                started = False
            except (OSError, ValueError, subprocess.SubprocessError):
                result.update(discovered_models=[], models_observed=False, error_code='CODEX_STOP_UNKNOWN')
        if reserved and not started: engine_resources().release('probe:' + unit)
        if claimed and not started:
            active.unlink()
            directory_fd = os.open(codex_home, os.O_RDONLY | os.O_DIRECTORY)
            try: os.fsync(directory_fd)
            finally: os.close(directory_fd)
            if temporary: shutil.rmtree(temporary)
        if process is not None:
            for stream in (process.stdin, process.stdout):
                stream.close()
            if process.poll() is None:
                # Reap the transport eventually; this is NOT a stop proof or claim release.
                import threading
                threading.Thread(target=process.wait, daemon=True).start()
        if lock is not None: os.close(lock)
    return result


def discover_codex_models_from_cli(codex_home, exe_path):
    return codex_profile_probe(codex_home, exe_path)['discovered_models']


def probe_codex_profiles(home, exe_path, cli_ver):
    dirs = [('default', home / '.codex')]; names = {'default'}
    for path in sorted(home.glob('.codex-*')):
        name = path.name[len('.codex-'):]
        if path.is_dir() and re.fullmatch(r'[a-z0-9][a-z0-9-]{0,31}', name):
            dirs.append((name, path)); names.add(name)
    for parent in (home / 'accounts', home / '.openclaude/profiles'):
        if parent.is_dir():
            for path in sorted(parent.iterdir()):
                name = path.name.lower()
                actual = path / '.codex' if (path / '.codex/auth.json').is_file() else path
                if re.fullmatch(r'[a-z0-9][a-z0-9-]{0,31}',name) and name not in names and (actual/'auth.json').is_file():
                    dirs.append((name, actual)); names.add(name)
    managed = home / '.oc-remote-codex/profiles'
    if managed.is_dir():
        for profile in sorted(managed.iterdir()):
            name = profile.name; actual = profile / 'codex-home'
            if re.fullmatch(r'[a-z0-9][a-z0-9-]{0,31}',name) and actual.is_dir():
                # A managed migration replaces discovery of the legacy profile with this id.
                dirs = [(n,p) for n,p in dirs if n != name]
                dirs.append((name,actual)); names.add(name)
    profiles = []
    for name, path in dirs:
        probe = codex_profile_probe(path, exe_path)
        account = probe.pop('account') or {}
        email = account.get('email')
        profiles.append({**probe, 'engine':'codex', 'profile_name':name, 'cli_version':cli_ver,
                         'runner_mode':'app-server', 'mod_digest':None,
                         'logged_in':probe['account_observed'] and probe['models_observed'],
                         'account_hint':mask_email(email) or 'codex:'+name,
                         'account_fingerprint':account_fingerprint('codex', email or str(path)),
                         'plan_type':account.get('planType'), 'quota_windows':[]})
    return profiles


def discover_grok_models_from_cli(home: pathlib.Path, exe_path: Optional[str]) -> List[Dict[str, str]]:
    cache_file = home / ".grok" / "models_cache.json"
    if cache_file.is_file():
        try:
            data = json.loads(cache_file.read_text("utf-8", errors="ignore"))
            raw_models = data.get("models") if isinstance(data, dict) else None
            if isinstance(raw_models, dict):
                models: List[Dict[str, str]] = []
                for mid, entry in raw_models.items():
                    if not isinstance(mid, str) or not mid.strip():
                        continue
                    info = entry.get("info") if isinstance(entry, dict) and isinstance(entry.get("info"), dict) else {}
                    if info.get("hidden") is True:
                        continue
                    disp = info.get("name") or info.get("system_prompt_label") or mid
                    models.append({"upstream_model_id": mid.strip(), "display_name": str(disp).strip() or mid.strip()})
                if models:
                    return models
        except Exception:
            pass
    if exe_path:
        try:
            out = subprocess.check_output([exe_path, "models"], stderr=subprocess.STDOUT, timeout=5.0, text=True)
            models = []
            seen = set()
            for line in out.splitlines():
                m = re.match(r"^\s*[\*-]\s+([a-zA-Z0-9._-]+)", line)
                if m:
                    mid = m.group(1).strip()
                    if mid and mid not in seen:
                        seen.add(mid)
                        models.append({"upstream_model_id": mid, "display_name": mid})
            if models:
                return models
        except Exception:
            pass
    if is_synthetic_stub_binary(exe_path):
        return list(SYNTHETIC_STUB_FALLBACK_MODELS["grok-build"])
    return []


def discover_antigravity_models_from_cli(exe_path: Optional[str]) -> List[Dict[str, str]]:
    if not exe_path:
        return []
    try:
        p = pathlib.Path(exe_path).resolve()
        if p.is_file() and p.stat().st_size >= 65536:
            raw_bytes = p.read_bytes()
            candidates = [
                ("gemini-4-argon", "Gemini 4 Argon"),
                ("gemini-3.8-flash", "Gemini 3.8 Flash"),
                ("claude-opus-5-5", "Claude Opus 5.5 (Antigravity)"),
                ("claude-sonnet-5-5", "Claude Sonnet 5.5 (Antigravity)"),
                ("gpt-oss-120b", "GPT-OSS 120B"),
                ("gemini-3.1-pro", "Gemini 3.1 Pro"),
                ("gemini-3.1-flash", "Gemini 3.1 Flash"),
            ]
            models: List[Dict[str, str]] = []
            for mid, disp in candidates:
                if mid.encode("ascii") in raw_bytes:
                    models.append({"upstream_model_id": mid, "display_name": disp})
            if models:
                return models
    except Exception:
        pass
    if is_synthetic_stub_binary(exe_path):
        return list(SYNTHETIC_STUB_FALLBACK_MODELS["antigravity"])
    return []


def parse_verified_models(raw: Any) -> List[Dict[str, str]]:
    if not isinstance(raw, list):
        return []
    models: List[Dict[str, str]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        mid = item.get("upstream_model_id") or item.get("id")
        if not isinstance(mid, str) or not mid.strip():
            continue
        disp = item.get("display_name") or item.get("name") or mid
        models.append(
            {
                "upstream_model_id": mid.strip(),
                "display_name": str(disp).strip() or mid.strip(),
            }
        )
    return models


def is_valid_token_str(val: Any) -> bool:
    return isinstance(val, str) and len(val.strip()) >= 16


def is_not_expired(exp_val: Any) -> bool:
    if exp_val is None:
        return True
    if isinstance(exp_val, (int, float)) and not isinstance(exp_val, bool):
        now_sec = globals()["time"].time() if "time" in globals() else __import__("time").time()
        # Handle both epoch milliseconds and epoch seconds
        if exp_val > 1e11:
            return exp_val > (now_sec * 1000.0)
        return exp_val > now_sec
    return False


def self_sha256() -> str:
    path = pathlib.Path(__file__).resolve()
    return hashlib.sha256(path.read_bytes()).hexdigest()


def mask_email(raw: Optional[str]) -> Optional[str]:
    if not raw or not isinstance(raw, str):
        return None
    s = raw.strip()
    if "@" not in s:
        return s[:3] + "***" if len(s) > 3 else "***"
    local, domain = s.split("@", 1)
    if len(local) <= 2:
        masked_local = (local[:1] or "*") + "***"
    else:
        masked_local = local[:2] + "***" + local[-1:]
    return f"{masked_local}@{domain}"


def account_fingerprint(engine: str, raw_identity: str) -> str:
    norm = f"{engine.strip().lower()}:{raw_identity.strip().lower()}"
    return hashlib.sha256(norm.encode("utf-8")).hexdigest()


def assert_cc_interactive_args(argv: List[str], env: Dict[str, str]) -> None:
    if env.get("OC_BOX_CC_RUNNER", "interactive") != "interactive":
        raise RuntimeError("REMOTE_CC_PRINT_MODE_FORBIDDEN: OC_BOX_CC_RUNNER must be interactive")
    for token in argv:
        flag = token.split("=", 1)[0]
        if flag in FORBIDDEN_CC_PRINT_FLAGS:
            raise RuntimeError(f"REMOTE_CC_PRINT_MODE_FORBIDDEN: {flag}")


def run_cmd_version(binary: str, args: List[str] = ["--version"]) -> Optional[str]:
    exe = shutil.which(binary)
    if not exe:
        for prefix in ("/home/box/.local/bin", "/home/box/.npm-global/bin", "/usr/local/bin", "/usr/bin"):
            cand = os.path.join(prefix, binary)
            if os.path.isfile(cand) and os.access(cand, os.X_OK):
                exe = cand
                break
    if not exe:
        return None
    try:
        out = subprocess.check_output([exe, *args], stderr=subprocess.STDOUT, timeout=4.0, text=True)
        first = out.strip().splitlines()[0] if out.strip() else None
        return first[:120] if first else None
    except Exception:
        return None


def compute_oc_bridge_digest(home: pathlib.Path) -> Optional[str]:
    candidates = [
        home / ".openclaude" / "box-bridge-mod" / "oc-bridge",
        pathlib.Path("/opt/openclaude/box-bridge-mod/oc-bridge"),
    ]
    for root in candidates:
        if (root / ".claude-plugin" / "plugin.json").is_file() and (root / "hooks" / "hooks.json").is_file():
            h = hashlib.sha256()
            files: List[pathlib.Path] = []
            for p in root.rglob("*"):
                if p.is_file():
                    rel = p.relative_to(root).as_posix()
                    if rel.startswith(".claude-plugin/types") or rel.endswith(".test.ts") or rel == "tsconfig.json":
                        continue
                    files.append(p)
            for p in sorted(files, key=lambda item: item.relative_to(root).as_posix()):
                rel = p.relative_to(root).as_posix()
                data = p.read_bytes()
                h.update(f"{rel}\0{len(data)}\0".encode("utf-8"))
                h.update(data)
            return h.hexdigest()
    return None


def probe_cc_profiles(home: pathlib.Path) -> List[Dict[str, Any]]:
    cc_exe = resolve_binary_path("claude")
    cli_ver = run_cmd_version("claude")
    if not cli_ver:
        return []
    tmux_ver = run_cmd_version("tmux", ["-V"])
    mod_digest = compute_oc_bridge_digest(home)
    cli_models: Optional[List[Dict[str, str]]] = None
    profiles: List[Dict[str, Any]] = []
    dirs: List[tuple[str, pathlib.Path]] = []
    seen_names: set[str] = set()
    default_dir = home / ".claude"
    if default_dir.is_dir():
        dirs.append(("default", default_dir))
        seen_names.add("default")
    for entry in sorted(home.glob(".claude-*")):
        if entry.is_dir():
            name = entry.name[len(".claude-") :]
            if re.match(r"^[a-z0-9][a-z0-9-]{0,31}$", name) and name not in seen_names:
                dirs.append((name, entry))
                seen_names.add(name)
    for parent in (home / "accounts", home / ".openclaude" / "profiles"):
        if parent.is_dir():
            for sub in sorted(parent.iterdir()):
                if sub.is_dir():
                    name = sub.name.lower()
                    cc_sub = sub / ".claude" if (sub / ".claude").is_dir() else sub
                    if (
                        re.match(r"^[a-z0-9][a-z0-9-]{0,31}$", name)
                        and name not in seen_names
                        and any((cc_sub / f).is_file() for f in (".credentials.json", "config.json", ".claude.json"))
                    ):
                        dirs.append((name, cc_sub))
                        seen_names.add(name)
    if not dirs:
        dirs.append(("default", default_dir))

    for profile_name, cfg_dir in dirs:
        email = None
        plan_type: Optional[str] = None
        has_valid_token = False
        used_5h: Optional[float] = None
        used_7d: Optional[float] = None
        discovered_models: List[Dict[str, str]] = []
        candidates = [cfg_dir / ".credentials.json", cfg_dir / "config.json", cfg_dir / ".claude.json"]
        if profile_name == "default":
            candidates.append(home / ".claude.json")
        for candidate in candidates:
            if candidate.is_file():
                try:
                    data = json.loads(candidate.read_text("utf-8", errors="strict"))
                    if isinstance(data, dict):
                        acct = data.get("oauthAccount") or data.get("account") or {}
                        if isinstance(acct, dict):
                            email = acct.get("emailAddress") or acct.get("email") or email
                            plan_type = (
                                acct.get("SubscriptionType")
                                or acct.get("planType")
                                or acct.get("organizationType")
                                or plan_type
                            )
                        oauth = data.get("claudeAiOauth")
                        if isinstance(oauth, dict):
                            tok = oauth.get("accessToken") or oauth.get("access_token")
                            refresh_tok = oauth.get("refreshToken") or oauth.get("refresh_token")
                            plan_type = oauth.get("subscriptionType") or oauth.get("SubscriptionType") or plan_type
                            exp = oauth["expiresAt"] if "expiresAt" in oauth and oauth["expiresAt"] is not None else oauth.get("expires_at")
                            now_sec = globals()["time"].time() if "time" in globals() else __import__("time").time()
                            exp_ok = (
                                globals()["is_not_expired"](exp)
                                if "is_not_expired" in globals()
                                else (
                                    True
                                    if exp is None
                                    else (
                                        ((exp > now_sec * 1000.0) if exp > 1e11 else (exp > now_sec))
                                        if (isinstance(exp, (int, float)) and not isinstance(exp, bool))
                                        else False
                                    )
                                )
                            )
                            has_refresh = (
                                isinstance(refresh_tok, str)
                                and len(refresh_tok.strip()) >= 16
                                and (
                                    exp is None
                                    or (isinstance(exp, (int, float)) and not isinstance(exp, bool) and exp > 0)
                                )
                            )
                            if isinstance(tok, str) and len(tok.strip()) >= 16 and (exp_ok or has_refresh):
                                has_valid_token = True
                        if isinstance(data.get("five_hour_used_pct"), (int, float)):
                            used_5h = float(data["five_hour_used_pct"])
                        if isinstance(data.get("seven_day_used_pct"), (int, float)):
                            used_7d = float(data["seven_day_used_pct"])
                        if isinstance(data.get("available_models"), list) and data["available_models"]:
                            verified = [
                                {
                                    "upstream_model_id": str(m.get("upstream_model_id") or m.get("id")).strip(),
                                    "display_name": str(m.get("display_name") or m.get("name") or m.get("id")).strip(),
                                }
                                for m in data["available_models"]
                                if isinstance(m, dict)
                                and isinstance(m.get("upstream_model_id") or m.get("id"), str)
                                and str(m.get("upstream_model_id") or m.get("id")).strip()
                            ]
                            if verified:
                                discovered_models = verified
                except Exception:
                    pass
        if has_valid_token and not discovered_models:
            if cli_models is None:
                cli_models = discover_cc_models_from_cli(cc_exe)
            discovered_models = list(cli_models)
        logged_in = bool(has_valid_token and len(discovered_models) > 0)
        raw_id = email or f"{os.uname().nodename}:cc:{profile_name}"
        shared_projects = profile_name == "default" or (
            (cfg_dir / "projects").is_symlink()
            and os.readlink(cfg_dir / "projects") == str(default_dir / "projects")
        )
        profiles.append(
            {
                "engine": "cc",
                "profile_name": profile_name,
                "cli_version": cli_ver,
                "tmux_version": tmux_ver,
                "runner_mode": "interactive",
                "mod_digest": mod_digest,
                "logged_in": logged_in,
                "account_hint": mask_email(email) or f"cc:{profile_name}",
                "account_fingerprint": account_fingerprint("cc", raw_id),
                "plan_type": str(plan_type) if (logged_in and plan_type) else None,
                "discovered_models": discovered_models if logged_in else [],
                "quota_windows": [
                    {"label": "5h", "usedPct": used_5h, "resetsAt": None},
                    {"label": "7d", "usedPct": used_7d, "resetsAt": None},
                ],
                "_shared_projects": shared_projects,
            }
        )
    deduped: List[Dict[str, Any]] = []
    fp_index: Dict[str, int] = {}
    for item in profiles:
        shared = bool(item.pop("_shared_projects", False))
        fp = item["account_fingerprint"]
        if not item.get("logged_in"):
            deduped.append(item)
            continue
        if fp not in fp_index:
            fp_index[fp] = len(deduped)
            item["_shared"] = shared
            deduped.append(item)
        else:
            existing_idx = fp_index[fp]
            if shared and not deduped[existing_idx].get("_shared", False):
                item["_shared"] = shared
                deduped[existing_idx] = item
    for item in deduped:
        item.pop("_shared", None)
    return deduped


def probe_other_engine(home: pathlib.Path, engine: str, binary: str, auth_files: List[pathlib.Path]) -> List[Dict[str, Any]]:
    exe_path = resolve_binary_path(binary)
    cli_ver = run_cmd_version(binary)
    if not cli_ver and engine == "antigravity":
        alt_bin = "antigravity" if binary == "agy" else "agy"
        exe_path = resolve_binary_path(alt_bin)
        cli_ver = run_cmd_version(alt_bin)
    if engine == "codex":
        return probe_codex_profiles(home, exe_path, cli_ver)
    if not cli_ver:
        return []

    profile_Auths: List[tuple[str, pathlib.Path, List[pathlib.Path]]] = [("default", home, auth_files)]
    seen_names: set[str] = {"default"}
    if engine == "antigravity":
        for prefix in (".gemini-", ".antigravity-"):
            for entry in sorted(home.glob(f"{prefix}*")):
                if entry.is_dir():
                    name = entry.name[len(prefix) :]
                    if re.match(r"^[a-z0-9][a-z0-9-]{0,31}$", name) and name not in seen_names:
                        profile_Auths.append(
                            (
                                name,
                                entry,
                                [
                                    entry / "antigravity-cli" / "antigravity-oauth-token",
                                    entry / "antigravity-cli" / "auth.json",
                                    entry / "antigravity-oauth-token",
                                    entry / "auth.json",
                                ],
                            )
                        )
                        seen_names.add(name)
        for parent in (home / "accounts", home / ".openclaude" / "profiles"):
            if parent.is_dir():
                for sub in sorted(parent.iterdir()):
                    if sub.is_dir():
                        name = sub.name.lower()
                        cands = [
                            sub / ".gemini" / "antigravity-cli" / "antigravity-oauth-token",
                            sub / ".gemini" / "antigravity-cli" / "auth.json",
                            sub / "antigravity-oauth-token",
                            sub / "auth.json",
                        ]
                        if re.match(r"^[a-z0-9][a-z0-9-]{0,31}$", name) and name not in seen_names and any(c.is_file() for c in cands):
                            profile_Auths.append((name, sub, cands))
                            seen_names.add(name)
    elif engine == "grok-build":
        for entry in sorted(home.glob(".grok-*")):
            if entry.is_dir():
                name = entry.name[len(".grok-") :]
                if re.match(r"^[a-z0-9][a-z0-9-]{0,31}$", name) and name not in seen_names:
                    profile_Auths.append((name, entry, [entry / "auth.json", entry / "config.json"]))
                    seen_names.add(name)
        for parent in (home / "accounts", home / ".openclaude" / "profiles"):
            if parent.is_dir():
                for sub in sorted(parent.iterdir()):
                    if sub.is_dir():
                        name = sub.name.lower()
                        cands = [sub / ".grok" / "auth.json", sub / "auth.json", sub / "config.json"]
                        if re.match(r"^[a-z0-9][a-z0-9-]{0,31}$", name) and name not in seen_names and any(c.is_file() for c in cands):
                            profile_Auths.append((name, sub, cands))
                            seen_names.add(name)

    results: List[Dict[str, Any]] = []
    seen_fps: set[str] = set()
    for profile_name, prof_root, files in profile_Auths:
        email = None
        plan_type: Optional[str] = None
        has_valid_token = False
        used_5h: Optional[float] = None
        used_7d: Optional[float] = None
        discovered_models: List[Dict[str, str]] = []
        for f in files:
            if f.is_file():
                try:
                    data = json.loads(f.read_text("utf-8", errors="strict"))
                    if isinstance(data, dict):
                        email = data.get("email") or data.get("account_email") or data.get("id_token_email") or email
                        plan_type = data.get("plan") or data.get("plan_type") or plan_type
                        tokens_obj = (
                            data.get("tokens")
                            if isinstance(data.get("tokens"), dict)
                            else (data.get("token") if isinstance(data.get("token"), dict) else {})
                        )
                        # Support xAI grok auth.json issuer-keyed dict format (e.g. "https://auth.x.ai::...")
                        if not tokens_obj and engine == "grok-build":
                            for k, v in data.items():
                                if isinstance(k, str) and "auth.x.ai" in k and isinstance(v, dict):
                                    tokens_obj = v
                                    email = v.get("email") or email
                                    plan_type = v.get("principal_type") or plan_type
                                    break
                        token_candidate = (
                            data.get("access_token")
                            or data.get("id_token")
                            or data.get("api_key")
                            or data.get("OPENAI_API_KEY")
                            or tokens_obj.get("access_token")
                            or tokens_obj.get("id_token")
                            or tokens_obj.get("key")
                        )
                        refresh_tok = (
                            data.get("refresh_token")
                            or data.get("refreshToken")
                            or tokens_obj.get("refresh_token")
                            or tokens_obj.get("refreshToken")
                        )
                        exp = (
                            data["expires_at"]
                            if "expires_at" in data and data["expires_at"] is not None
                            else (
                                data["expiresAt"]
                                if "expiresAt" in data and data["expiresAt"] is not None
                                else (
                                    tokens_obj["expires_at"]
                                    if "expires_at" in tokens_obj and tokens_obj["expires_at"] is not None
                                    else tokens_obj.get("expiresAt")
                                )
                            )
                        )
                        now_sec = globals()["time"].time() if "time" in globals() else __import__("time").time()
                        if isinstance(exp, str) and exp.strip():
                            exp_ok = True
                        else:
                            exp_ok = (
                                globals()["is_not_expired"](exp)
                                if "is_not_expired" in globals()
                                else (
                                    True
                                    if exp is None
                                    else (
                                        ((exp > now_sec * 1000.0) if exp > 1e11 else (exp > now_sec))
                                        if (isinstance(exp, (int, float)) and not isinstance(exp, bool))
                                        else False
                                    )
                                )
                            )
                        has_refresh = (
                            isinstance(refresh_tok, str)
                            and len(refresh_tok.strip()) >= 16
                            and (
                                exp is None
                                or isinstance(exp, str)
                                or (isinstance(exp, (int, float)) and not isinstance(exp, bool) and exp > 0)
                            )
                        )
                        if isinstance(token_candidate, str) and len(token_candidate.strip()) >= 16 and (exp_ok or has_refresh):
                            has_valid_token = True
                        if isinstance(data.get("five_hour_used_pct"), (int, float)):
                            used_5h = float(data["five_hour_used_pct"])
                        if isinstance(data.get("seven_day_used_pct"), (int, float)):
                            used_7d = float(data["seven_day_used_pct"])
                        if isinstance(data.get("available_models"), list) and data["available_models"]:
                            verified = [
                                {
                                    "upstream_model_id": str(m.get("upstream_model_id") or m.get("id")).strip(),
                                    "display_name": str(m.get("display_name") or m.get("name") or m.get("id")).strip(),
                                }
                                for m in data["available_models"]
                                if isinstance(m, dict)
                                and isinstance(m.get("upstream_model_id") or m.get("id"), str)
                                and str(m.get("upstream_model_id") or m.get("id")).strip()
                            ]
                            if verified:
                                discovered_models = verified
                except Exception:
                    pass
        if has_valid_token and not discovered_models:
            if engine == "grok-build":
                discovered_models = discover_grok_models_from_cli(prof_root if (prof_root / "models_cache.json").is_file() else home, exe_path)
            elif engine == "antigravity":
                discovered_models = discover_antigravity_models_from_cli(exe_path)
        logged_in = bool(has_valid_token and len(discovered_models) > 0)
        if profile_name != "default" and not logged_in:
            continue
        raw_id = email or f"{os.uname().nodename}:{engine}:{profile_name}"
        fp = account_fingerprint(engine, raw_id)
        if logged_in and fp in seen_fps:
            continue
        if logged_in:
            seen_fps.add(fp)
        results.append(
            {
                "engine": engine,
                "profile_name": profile_name,
                "cli_version": cli_ver,
                "runner_mode": "interactive",
                "mod_digest": None,
                "logged_in": logged_in,
                "account_hint": mask_email(email) or f"{engine}:{profile_name}",
                "account_fingerprint": fp,
                "plan_type": str(plan_type) if (logged_in and plan_type) else None,
                "discovered_models": discovered_models if logged_in else [],
                "quota_windows": [
                    {"label": "5h", "usedPct": used_5h, "resetsAt": None},
                    {"label": "7d", "usedPct": used_7d, "resetsAt": None},
                ],
            }
        )
    return results


def check_credential_paths_isolated(home: pathlib.Path) -> bool:
    uid = os.getuid()
    try:
        if not home.is_dir() or home.is_symlink():
            return False
        for rel in (".ssh", ".claude", ".codex"):
            target = home / rel
            if target.exists():
                if target.is_symlink():
                    return False
                st = target.lstat()
                if st.st_uid != uid or (st.st_mode & 0o022) != 0:
                    return False
        return True
    except Exception:
        return False


def run_gate_g_self_check(home: pathlib.Path) -> Dict[str, Any]:
    """Gate G: verify interactive CC flag guard and credential isolation."""
    try:
        try:
            assert_cc_interactive_args(["claude", "-p", "forbidden"], {"OC_BOX_CC_RUNNER": "interactive"})
            return {"ok": False, "reason": "print_flag_not_blocked"}
        except RuntimeError:
            pass
        isolated = check_credential_paths_isolated(home)
        return {
            "ok": isolated,
            "cc_print_mode_blocked": True,
            "credential_paths_isolated": isolated,
            "checked_at": int(time.time() * 1000),
        }
    except Exception as exc:
        return {"ok": False, "reason": str(exc)}


def handle_probe() -> Dict[str, Any]:
    home = pathlib.Path.home()
    profiles: List[Dict[str, Any]] = []
    profiles.extend(probe_cc_profiles(home))
    profiles.extend(probe_other_engine(home, "codex", "codex", [home / ".codex" / "auth.json"]))
    profiles.extend(
        probe_other_engine(
            home,
            "antigravity",
            "agy",
            [
                home / ".gemini" / "antigravity-cli" / "antigravity-oauth-token",
                home / ".gemini" / "antigravity-cli" / "auth.json",
                home / ".config" / "antigravity" / "auth.json",
            ],
        )
    )
    profiles.extend(probe_other_engine(home, "grok-build", "grok", [home / ".grok" / "auth.json", home / ".config" / "grok" / "config.json"]))
    gate_g = run_gate_g_self_check(home)
    return {
        "ok": True,
        "protocol_version": 1,
        "controller_sha256": self_sha256(),
        "hostname": os.uname().nodename,
        "probed_at": int(time.time() * 1000),
        "gate_g": gate_g,
        "profiles": profiles,
    }


def serve_mux() -> int:
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            sys.stdout.write(json.dumps({"ok": False, "error": "INVALID_JSON"}) + "\n")
            sys.stdout.flush()
            continue
        op = msg.get("op")
        req_id = msg.get("id")
        if op == "ping":
            sys.stdout.write(json.dumps({"id": req_id, "ok": True, "pong": int(time.time() * 1000)}) + "\n")
            sys.stdout.flush()
        elif op == "probe":
            res = handle_probe()
            res["id"] = req_id
            sys.stdout.write(json.dumps(res) + "\n")
            sys.stdout.flush()
        elif op == "self_check":
            res = {"id": req_id, **run_gate_g_self_check(pathlib.Path.home())}
            sys.stdout.write(json.dumps(res) + "\n")
            sys.stdout.flush()
        elif op == "assert_cc_interactive":
            try:
                assert_cc_interactive_args(list(msg.get("argv") or []), dict(msg.get("env") or {"OC_BOX_CC_RUNNER": "interactive"}))
                sys.stdout.write(json.dumps({"id": req_id, "ok": True, "runner_mode": "interactive"}) + "\n")
            except Exception as exc:
                sys.stdout.write(json.dumps({"id": req_id, "ok": False, "error": str(exc)}) + "\n")
            sys.stdout.flush()
        else:
            sys.stdout.write(json.dumps({"id": req_id, "ok": False, "error": f"UNKNOWN_OP:{op}"}) + "\n")
            sys.stdout.flush()
    return 0


def main(argv: List[str]) -> int:
    if "--probe" in argv:
        sys.stdout.write(json.dumps(handle_probe()) + "\n")
        sys.stdout.flush()
        return 0
    if "--self-check" in argv:
        res = run_gate_g_self_check(pathlib.Path.home())
        sys.stdout.write(json.dumps(res) + "\n")
        sys.stdout.flush()
        return 0 if res.get("ok") else 1
    if "--serve-mux" in argv:
        return serve_mux()
    sys.stdout.write(json.dumps(handle_probe()) + "\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
