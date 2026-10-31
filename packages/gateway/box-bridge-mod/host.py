"""oc-box interactive host: one interactive `claude` in a tmux PTY, driven by
the oc-bridge mod, speaking the same stream-json stdio contract as the Route B
`claude -p` it replaces.

stdin  (fd 0, the Route B fifo): stream-json lines from the gateway
                                 (user / control_request / control_response)
stdout                         : stream-json lines the mod produced
stderr                         : operational lines (BOX_INTERACTIVE_*), no user text

argv: host.py <run_dir> <tmux_session> <claude> [claude args...]
      or, print mode (OC_BOX_HOST_MODE=print, OCV5-378): host.py <claude> [claude args...]
      The Box model route's supervisor runs this in place of `claude -p`: its argv without the
      --print-only flags (any that remain are dropped; OC_BOX_NO_SESSION_PERSISTENCE=1 stands for
      --no-session-persistence), the same stdin and stdout. The mod speaks -p's exact stream-json,
      and the host exits once every submitted message has its result. The login is CLAUDE_CONFIG_DIR.
env : OC_BOX_MOD_FILES  JSON {relpath: base64} of the mod, written into run_dir
      OC_BOX_MOD_SHA256 sha256 of the canonical file listing (see mod_digest)
      OC_BOX_READY_MS   ready timeout (default 20000)
      OC_BOX_CLAUDE_PROFILE  Claude Code login to run under: unset or `default` = $HOME/.claude
                             (no CLAUDE_CONFIG_DIR, as before); `<name>` = $HOME/.claude-<name>,
                             only after profile_safe() (else NOT_READY profile_unsafe, never -p)
"""
import base64, collections, hashlib, hmac, json, os, re, secrets, shutil, signal, socket, socketserver, stat, struct, subprocess, sys, threading, time

TAP_SOURCE = r'''
import socket, sys
token = sys.stdin.readline().strip()
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect(sys.argv[1])
s.sendall(b"TAP %s\n" % token.encode())
while True:
    b = s.recv(65536)
    if not b:
        break
    sys.stdout.buffer.write(b)
    sys.stdout.buffer.flush()
'''

MAX_REQ = 64 * 1024 * 1024
# Lines wait here only until the tap takes them; more than this undelivered
# means the session is not reading its input, and the host gives up on it.
MAX_INBOUND = 64 * 1024 * 1024
DECISION_TTL = 600
DECISION_MAX = 256
# Text of the native dialogs that draw before any hook runs (P0).
DIALOGS = ('trust this folder', 'Bypass Permissions mode')
PATH = '/home/box/.local/bin:/home/box/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
# Print mode: flags that exist only with --print (dropped), and the run's own CLI settings that
# pass through to the interactive process (the route's plan sets them).
PRINT_FLAGS = {'-p', '--print', '--include-partial-messages', '--verbose', '--no-session-persistence'}
PRINT_VALUE_FLAGS = {'--input-format', '--output-format'}
PASS_ENV = re.compile(r'(CLAUDE_CODE_[A-Z_]+|DISABLE_AUTO_COMPACT|MAX_MCP_OUTPUT_TOKENS)')
RESULT_LINE = re.compile(rb'\{\s*"type"\s*:\s*"result"')
# Ends the session if the host itself is killed (a supervisor kills the host's process group,
# and the tmux server is outside it).
WATCHDOG = r'''
import os, subprocess, sys, time
pid, session = int(sys.argv[1]), sys.argv[2]
def tmux(*a):
    return subprocess.run(['tmux', '-L', 'oc-box'] + list(a), stdin=subprocess.DEVNULL, capture_output=True).returncode
while True:
    time.sleep(1)
    try:
        os.kill(pid, 0)
    except OSError:
        tmux('kill-session', '-t', '=' + session)
        break
    if tmux('has-session', '-t', '=' + session) != 0:
        break
'''


def mod_digest(files):
    h = hashlib.sha256()
    for rel in sorted(files):
        data = files[rel]
        h.update(rel.encode() + b'\0' + str(len(data)).encode() + b'\0' + data)
    return h.hexdigest()


def err(line):
    try:
        sys.stderr.write(line.rstrip('\n') + '\n')
        sys.stderr.flush()
    except (OSError, ValueError):
        pass


PROFILE_NAME = re.compile(r'[a-z0-9][a-z0-9-]{0,31}')


def profile_config_dir(name, home):
    """CLAUDE_CONFIG_DIR for a login name, or None for the default login.
    Mirrors boxClaudeProfile.ts: `default` keeps the launch byte-for-byte as before.
    `home` is the launch exec's HOME (/home/box on the Box)."""
    if name in (None, '', 'default'):
        return None
    if not isinstance(name, str) or not PROFILE_NAME.fullmatch(name):
        raise ValueError('profile name')
    return home + '/.claude-' + name


def profile_safe(config_dir, home):
    """Same checks as the master's Box GUARD (boxProfileDiscovery.ts), on the Box at launch time:
    the dir is ours and real, it is logged in (credential file present; never read), and its
    projects is the literal symlink to the shared dir, so history, resume and cleanup see one tree."""
    try:
        st = os.lstat(config_dir)
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid():
            return False
        if os.readlink(os.path.join(config_dir, 'projects')) != home + '/.claude/projects':
            return False
        cred = os.lstat(os.path.join(config_dir, '.credentials.json'))
        return stat.S_ISREG(cred.st_mode) and cred.st_uid == os.getuid()
    except (OSError, ValueError):
        return False


def print_args(argv):
    """`claude -p` argv -> (interactive argv, no_persistence, init {tools, mcp_servers}, session id).
    Raises ValueError for an argv the route never produces."""
    out, no_persist, tools, servers, session_id = [], False, [], [], None
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in PRINT_FLAGS:
            no_persist = no_persist or a == '--no-session-persistence'
            i += 1
            continue
        if a in PRINT_VALUE_FLAGS:
            if i + 1 >= len(argv) or argv[i + 1] != 'stream-json':
                raise ValueError(a)
            i += 2
            continue
        if a in ('--mcp-config', '--allowedTools', '--session-id', '--resume') and i + 1 < len(argv):
            v = argv[i + 1]
            if a == '--mcp-config':
                servers = sorted((json.loads(v).get('mcpServers') or {}).keys())
            elif a == '--allowedTools':
                tools = [t for t in re.split(r'[,\s]+', v) if t]
            else:
                session_id = v
        out.append(a)
        i += 1
    if not servers:
        tools = []
    init = {'tools': tools, 'mcp_servers': [{'name': n, 'status': 'connected', 'source': 'dynamic'} for n in servers]}
    return out, no_persist, init, session_id


def only_text(msg):
    content = (msg.get('message') or {}).get('content')
    if isinstance(content, str):
        return True
    return isinstance(content, list) and all(isinstance(b, dict) and b.get('type') == 'text' for b in content)


def blocking_screen(pane):
    """A screen the mod cannot leave. Login is reported before onboarding.

    The result is an operational code. Callers must not attach the pane.
    """
    if ("Select login method:" in pane
            or "Not logged in \u00b7 Run /login" in pane):
        return "BOX_INTERACTIVE_LOGIN_REQUIRED"
    if "colorblind-friendly" in pane:
        return "BOX_INTERACTIVE_ONBOARDING"
    return None


class Host:
    def __init__(self, run_dir, session, claude, args, config_dir=None, extra_env=None, print_mode=False):
        self.run_dir = run_dir
        self.extra_env = extra_env or []
        self.print_mode = print_mode
        self.users = 0             # print mode: user messages handed to the session
        self.results = 0           # print mode: result lines written out
        self.config_dir = config_dir  # None: the default login, launched exactly as before
        self.session = session
        self.claude = claude
        self.args = args
        self.sock_path = os.path.join(run_dir, 'bridge.sock')
        self.out_lock = threading.Lock()
        self.cv = threading.Condition()
        self.inbound = collections.deque()  # lines not yet handed to the tap
        self.inbound_bytes = 0
        self.fatal = None          # why the session can no longer take input
        self.decisions = {}        # request_id -> (received_at, control_response line)
        # Capability for the mod: written to the run dir before claude starts,
        # removed at the mod's first request, i.e. before any tool can run.
        self.token = secrets.token_hex(32)
        self.token_path = os.path.join(run_dir, 'token')
        self.tap_taken = False
        self.ready = threading.Event()
        self.stdin_closed = False
        self.claude_pid = None

    # ---- outbound -------------------------------------------------------
    def write_out(self, data):
        with self.out_lock:
            sys.stdout.buffer.write(data if data.endswith(b'\n') else data + b'\n')
            sys.stdout.buffer.flush()
        if self.print_mode:
            n = 0
            for line in data.split(b'\n'):
                if RESULT_LINE.match(line):
                    n += 1
            if n:
                with self.cv:
                    self.results += n
                    self.cv.notify_all()

    # ---- inbound --------------------------------------------------------
    def read_stdin(self):
        buf = b''
        fd = sys.stdin.buffer
        while True:
            chunk = fd.read1(1 << 20) if hasattr(fd, 'read1') else fd.read(65536)
            if not chunk:
                break
            buf += chunk
            while True:
                nl = buf.find(b'\n')
                if nl < 0:
                    break
                line, buf = buf[:nl], buf[nl + 1:]
                if line.strip():
                    self.route(line)
        with self.cv:
            self.stdin_closed = True
            self.cv.notify_all()

    def route(self, line):
        try:
            msg = json.loads(line)
        except ValueError:
            err('BOX_BRIDGE_PROTOCOL bad inbound json')
            return
        if msg.get('type') == 'control_response':
            rid = (msg.get('response') or {}).get('request_id')
            if isinstance(rid, str):
                with self.cv:
                    now = time.time()
                    for k in [k for k, (at, _) in self.decisions.items() if now - at > DECISION_TTL]:
                        del self.decisions[k]
                    if len(self.decisions) >= DECISION_MAX:
                        del self.decisions[min(self.decisions, key=lambda k: self.decisions[k][0])]
                    self.decisions[rid] = (now, line)
                    self.cv.notify_all()
            return
        if msg.get('type') == 'user':
            if self.print_mode:
                # The route's prompt is text; anything else would be lost on the way to the model.
                if not only_text(msg):
                    with self.cv:
                        self.fatal = self.fatal or 'input_unsupported'
                        self.cv.notify_all()
                    return
                with self.cv:
                    self.users += 1
            else:
                line = self.stage_attachments(msg)
        with self.cv:
            if self.fatal:
                return
            if self.inbound_bytes + len(line) > MAX_INBOUND:
                self.fatal = 'inbound_overflow'
            else:
                self.inbound.append(line)
                self.inbound_bytes += len(line)
            self.cv.notify_all()

    def stage_attachments(self, msg):
        """A plugin's prompt carries text only. Images and documents become
        files in the run dir, referenced from the text (SCHEME D8)."""
        content = (msg.get('message') or {}).get('content')
        if not isinstance(content, list):
            return json.dumps(msg).encode()
        att = os.path.join(self.run_dir, 'attachments')
        out = []
        for block in content:
            src = block.get('source') if isinstance(block, dict) else None
            if isinstance(src, dict) and src.get('type') == 'base64' and isinstance(src.get('data'), str):
                raw = base64.b64decode(src['data'])
                media = src.get('media_type') or 'application/octet-stream'
                ext = {'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
                       'application/pdf': 'pdf'}.get(media, 'bin')
                os.makedirs(att, mode=0o700, exist_ok=True)
                path = os.path.join(att, '%s.%s' % (hashlib.sha256(raw).hexdigest()[:24], ext))
                with open(path, 'wb') as f:
                    f.write(raw)
                out.append({'type': 'text', 'text': '[Attached %s: %s]' % (block.get('type', 'file'), path)})
            else:
                out.append(block)
        msg = dict(msg)
        msg['message'] = dict(msg['message'], content=out)
        return json.dumps(msg).encode()

    # ---- socket ---------------------------------------------------------
    def peer_pid(self, conn):
        try:
            cred = conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i'))
            pid, uid, _ = struct.unpack('3i', cred)
        except OSError:
            return None
        return pid if uid == os.getuid() else None

    def descends_from_claude(self, pid):
        p = pid
        for _ in range(8):
            if p == self.claude_pid:
                return True
            try:
                with open('/proc/%d/stat' % p) as f:
                    p = int(f.read().rsplit(')', 1)[1].split()[1])
            except (OSError, ValueError, IndexError):
                return False
            if p <= 1:
                return False
        return False

    def token_ok(self, presented):
        if not presented or not hmac.compare_digest(presented.encode(), self.token.encode()):
            return False
        try:
            os.unlink(self.token_path)
        except OSError:
            pass
        return True

    def serve(self):
        host = self

        class Handler(socketserver.StreamRequestHandler):
            def handle(self):
                # Tools run as the same user and inherit the run dir's name,
                # so uid is no boundary: requests must come from the claude
                # process itself (the mod's fetch) with the token, and the tap
                # (claude's child) must present the token, once.
                conn = self.request
                pid = host.peer_pid(conn)
                if pid is None or host.claude_pid is None:
                    err('BOX_BRIDGE_PEER_REFUSED')
                    return
                first = self.rfile.readline(65536)
                if first.startswith(b'TAP '):
                    if not host.descends_from_claude(pid) or not host.token_ok(first[4:].decode('latin-1').strip()):
                        err('BOX_BRIDGE_PEER_REFUSED tap')
                        return
                    return host.handle_tap(conn)
                parts = first.decode('latin-1').split()
                if len(parts) < 2:
                    return
                method, target = parts[0], parts[1]
                length = 0
                presented = ''
                while True:
                    h = self.rfile.readline(65536)
                    if h in (b'\r\n', b'\n', b''):
                        break
                    k, _, v = h.decode('latin-1').partition(':')
                    if k.strip().lower() == 'content-length':
                        length = int(v.strip())
                    elif k.strip().lower() == 'x-oc-bridge-token':
                        presented = v.strip()
                if pid != host.claude_pid or not host.token_ok(presented):
                    err('BOX_BRIDGE_PEER_REFUSED http')
                    return self.reply(403, b'')
                if length > MAX_REQ:
                    return self.reply(413, b'')
                body = self.rfile.read(length) if length else b''
                status, payload = host.http(method, target, body)
                self.reply(status, payload)

            def reply(self, status, payload):
                reason = {200: 'OK', 204: 'No Content', 403: 'Forbidden', 404: 'Not Found', 413: 'Too Large'}.get(status, 'X')
                head = 'HTTP/1.1 %d %s\r\nContent-Length: %d\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n' % (
                    status, reason, len(payload))
                self.wfile.write(head.encode() + payload)

        class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
            daemon_threads = True

        if len(self.sock_path.encode()) > 100:
            raise RuntimeError('BOX_INTERACTIVE_SOCK_PATH_TOO_LONG')
        if os.path.exists(self.sock_path):
            os.unlink(self.sock_path)
        srv = Server(self.sock_path, Handler)
        os.chmod(self.sock_path, 0o600)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        return srv

    def http(self, method, target, body):
        if method == 'POST' and target == '/out':
            if body:
                self.write_out(body)
            return 204, b''
        if method == 'POST' and target == '/ready':
            self.ready.set()
            try:
                info = json.loads(body or b'{}')
                err('BOX_INTERACTIVE_READY plugins=%s version=%s' % (
                    ','.join(info.get('plugins') or []), info.get('version')))
            except ValueError:
                pass
            return 204, b''
        if method == 'GET' and target.startswith('/decision?id='):
            rid = target.split('=', 1)[1]
            deadline = time.time() + 50
            with self.cv:
                while rid not in self.decisions and not self.stdin_closed:
                    left = deadline - time.time()
                    if left <= 0:
                        return 204, b''
                    self.cv.wait(left)
                got = self.decisions.pop(rid, None)
            return (200, got[1]) if got is not None else (204, b'')
        return 404, b''

    def handle_tap(self, conn):
        with self.cv:
            if self.tap_taken:
                err('BOX_BRIDGE_TAP_REFUSED second tap')
                return
            self.tap_taken = True

        def watch():
            # The tap sends nothing after its hello: EOF means it is gone.
            try:
                while conn.recv(4096):
                    pass
            except OSError:
                pass
            with self.cv:
                if not self.stdin_closed:
                    self.fatal = self.fatal or 'tap_lost'
                self.cv.notify_all()

        threading.Thread(target=watch, daemon=True).start()
        while True:
            with self.cv:
                while not self.inbound and not self.stdin_closed and not self.fatal:
                    self.cv.wait()
                if self.fatal:
                    return
                batch = list(self.inbound)
                self.inbound.clear()
                self.inbound_bytes = 0
                closed = self.stdin_closed
            try:
                for line in batch:
                    conn.sendall(line + b'\n')
            except OSError:
                # The tap is the session's only input and cannot reconnect.
                with self.cv:
                    self.fatal = self.fatal or 'tap_lost'
                    self.cv.notify_all()
                return
            if closed and not batch:
                return

    # ---- claude under tmux ---------------------------------------------
    def tmux(self, *a, **kw):
        return subprocess.run(['tmux', '-L', 'oc-box'] + list(a), stdin=subprocess.DEVNULL,
                              capture_output=True, text=True, **kw)

    def launch(self):
        fd = os.open(self.token_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o400)
        with os.fdopen(fd, 'w') as f:
            f.write(self.token)
        mode = 'default'
        if '--permission-mode' in self.args:
            i = self.args.index('--permission-mode')
            mode = self.args[i + 1] if i + 1 < len(self.args) else mode
        env = ['HOME=/home/box', 'PATH=' + PATH, 'LANG=C.UTF-8', 'TERM=xterm-256color',
               'DISABLE_AUTOUPDATER=1', 'OC_BRIDGE_DIR=' + self.run_dir, 'OC_BRIDGE_PERMISSION_MODE=' + mode]
        if self.config_dir:
            env.append('CLAUDE_CONFIG_DIR=' + self.config_dir)
        env += self.extra_env
        exit_file = os.path.join(self.run_dir, 'exit')
        pid_file = os.path.join(self.run_dir, 'claude.pid')
        script = 'echo $$ > "$OC_BRIDGE_DIR/claude.pid"; exec "$@"'
        # The pane runs `sh` which execs claude, so the recorded pid is claude's.
        # `exit` is written by a wrapper so the host learns the exit status.
        wrapper = ['sh', '-c', 'sh -c \'%s\' sh "$@"; echo $? > "%s"' % (script, exit_file), 'sh', self.claude] + self.args
        cmd = ['env', '-i'] + env + wrapper
        r = self.tmux('new-session', '-d', '-s', self.session, '-x', '200', '-y', '50', '-c', os.getcwd(), '--', *cmd)
        if r.returncode != 0:
            err('BOX_INTERACTIVE_NOT_READY tmux %s' % r.stderr.strip()[:200])
            return False
        for _ in range(100):
            try:
                with open(pid_file) as f:
                    self.claude_pid = int(f.read().strip())
                    return True
            except (OSError, ValueError):
                time.sleep(0.05)
        err('BOX_INTERACTIVE_NOT_READY no pid')
        return False

    def alive(self):
        return self.tmux('has-session', '-t', '=' + self.session).returncode == 0

    def kill(self):
        self.tmux('kill-session', '-t', '=' + self.session)
        if self.claude_pid:
            for _ in range(50):
                try:
                    os.kill(self.claude_pid, 0)
                except OSError:
                    return
                time.sleep(0.1)
            try:
                os.kill(self.claude_pid, signal.SIGKILL)
            except OSError:
                pass

    def pane(self):
        r = self.tmux('capture-pane', '-p', '-t', '=' + self.session + ':')
        return r.stdout[-4000:] if r.returncode == 0 else ''


def stage_mod(run_dir):
    """Writes the mod and the tap into the run dir; the mod root, or None (error printed)."""
    files = {k: base64.b64decode(v) for k, v in json.loads(os.environ['OC_BOX_MOD_FILES']).items()}
    if mod_digest(files) != os.environ.get('OC_BOX_MOD_SHA256'):
        err('BOX_INTERACTIVE_MOD_DIGEST_MISMATCH')
        return None
    os.makedirs(run_dir, mode=0o700, exist_ok=True)
    os.chmod(run_dir, 0o700)
    # For the bridge's abandon exec, which ends this host and nothing else
    # (it checks that the pid's argv names this run dir).
    fd = os.open(os.path.join(run_dir, 'host.pid'), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as f:
        f.write(str(os.getpid()))
    mod_root = os.path.join(run_dir, 'mod', 'oc-bridge')
    for rel, data in files.items():
        if rel.startswith('/') or '..' in rel.split('/'):
            err('BOX_INTERACTIVE_MOD_PATH_INVALID')
            return None
        path = os.path.join(mod_root, rel)
        os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
        with open(path, 'wb') as f:
            f.write(data)
        os.chmod(path, 0o400)
    with open(os.path.join(run_dir, 'tap.py'), 'w') as f:
        f.write(TAP_SOURCE)
    os.chmod(os.path.join(run_dir, 'tap.py'), 0o400)
    return mod_root


def main():
    if os.environ.get('OC_BOX_HOST_MODE') == 'print':
        return main_print()
    run_dir, session, claude = sys.argv[1], sys.argv[2], sys.argv[3]
    args = sys.argv[4:]
    home = os.environ.get('HOME', '/home/box')
    try:
        config_dir = profile_config_dir(os.environ.get('OC_BOX_CLAUDE_PROFILE'), home)
    except ValueError:
        err('BOX_INTERACTIVE_NOT_READY profile_invalid')
        return 1
    if config_dir is not None and not profile_safe(config_dir, home):
        err('BOX_INTERACTIVE_NOT_READY profile_unsafe')
        return 1
    mod_root = stage_mod(run_dir)
    if mod_root is None:
        return 1
    host = Host(run_dir, session, claude, args + ['--plugin-dir', mod_root], config_dir)
    return serve_host(host)


def main_print():
    """The Box model route's runner for interactive models: `claude -p` in, `claude -p` out."""
    claude = sys.argv[1] if len(sys.argv) >= 3 else ''
    if not os.path.isabs(claude):
        err('BOX_INTERACTIVE_ARGS_INVALID')
        return 126
    home = os.environ.get('HOME', '/home/box')
    # The route picks the login as for `-p` (CLAUDE_CONFIG_DIR); a non-default one is re-checked here.
    config_dir = os.environ.get('CLAUDE_CONFIG_DIR') or None
    if config_dir is not None:
        name = config_dir[len(home + '/.claude-'):] if config_dir.startswith(home + '/.claude-') else ''
        try:
            ok = profile_config_dir(name, home) == config_dir and profile_safe(config_dir, home)
        except ValueError:
            ok = False
        if not ok:
            err('BOX_INTERACTIVE_NOT_READY profile_unsafe')
            return 1
    try:
        args, no_persist, init, session_id = print_args(sys.argv[2:])
    except (ValueError, AttributeError):
        err('BOX_INTERACTIVE_ARGS_INVALID')
        return 126
    no_persist = no_persist or os.environ.get('OC_BOX_NO_SESSION_PERSISTENCE') == '1'
    nonce = secrets.token_hex(8)
    run_dir = '/tmp/ocb-' + nonce
    mod_root = stage_mod(run_dir)
    if mod_root is None:
        return 1
    extra = ['%s=%s' % (k, v) for k, v in sorted(os.environ.items()) if PASS_ENV.fullmatch(k)]
    extra += ['OC_BRIDGE_MODE=print', 'OC_BRIDGE_INIT=' + json.dumps(init)]
    host = Host(run_dir, 'ocp-' + nonce, claude, args + ['--plugin-dir', mod_root], config_dir,
                extra_env=extra, print_mode=True)
    try:
        return serve_host(host)
    finally:
        # `--no-session-persistence` cannot reach an interactive session: its transcript goes here.
        if no_persist and session_id and re.fullmatch(r'[0-9a-f-]{36}', session_id):
            project = re.sub(r'[^A-Za-z0-9]', '-', os.getcwd())
            try:
                os.unlink(os.path.join(config_dir or home + '/.claude', 'projects', project, session_id + '.jsonl'))
            except OSError:
                pass


def serve_host(host):
    stopping = threading.Event()

    def on_signal(signum, _frame):
        stopping.set()

    for s in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(s, on_signal)

    srv = host.serve()
    try:
        return run(host, srv, stopping)
    finally:
        # Whatever ends the host ends its claude: one session, one process.
        host.kill()
        srv.shutdown()
        # The CLI transcript lives under ~/.claude/projects (as with -p);
        # the run dir holds only the mod copy, socket and attachments.
        shutil.rmtree(host.run_dir, ignore_errors=True)


def run(host, srv, stopping):
    run_dir = host.run_dir
    if not host.launch():
        return 1
    if host.print_mode:
        subprocess.Popen([sys.executable, '-I', '-c', WATCHDOG, str(os.getpid()), host.session],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True, close_fds=True)
    threading.Thread(target=host.read_stdin, daemon=True).start()

    ready_ms = int(os.environ.get('OC_BOX_READY_MS', '20000'))
    deadline = time.time() + ready_ms / 1000.0
    ticks = 0
    while not host.ready.is_set():
        why = 'stopped' if stopping.is_set() else 'timeout' if time.time() > deadline else \
            'exited' if not host.alive() else None
        ticks += 1
        pane = host.pane()
        # A theme page or a logged-out page never reaches /ready. Say which
        # one and stop; do not wait out the ready budget or copy the pane.
        block = blocking_screen(pane)
        if block:
            err(block)
            return 1
        # A dialog never clears by itself: stop waiting once one is drawn.
        if not why and ticks % 10 == 0 and any(d in pane for d in DIALOGS):
            why = 'dialog'
        if why:
            # A dialog drawn before the hooks run cannot be answered by the mod;
            # it must be prevented by configuration (P0), never by keystrokes.
            if 'trust this folder' in pane:
                why += ' dialog=trust'
            elif 'Bypass Permissions mode' in pane:
                why += ' dialog=bypass'
            err('BOX_INTERACTIVE_NOT_READY %s' % why)
            for ln in pane.splitlines()[-25:]:
                if ln.strip():
                    err('  | ' + ln)
            return 1
        time.sleep(0.1)

    code = 0
    while True:
        if stopping.is_set():
            code = 143
            break
        if host.fatal:
            err('BOX_INTERACTIVE_INPUT_LOST %s' % host.fatal)
            code = 1
            break
        if host.print_mode and host.stdin_closed:
            # As `-p`: done once every submitted message has its result.
            if host.users == 0:
                err('BOX_INTERACTIVE_NO_INPUT')
                code = 1
                break
            if host.results >= host.users:
                code = 0
                break
        if not host.alive():
            try:
                with open(os.path.join(run_dir, 'exit')) as f:
                    code = int(f.read().strip() or '1')
            except (OSError, ValueError):
                code = 1
            break
        time.sleep(0.25)
    return code


if __name__ == '__main__':
    code = main()
    try:
        sys.stdout.flush()
    except (OSError, ValueError):
        pass
    # Daemon threads may sit in a blocking stdin read; leave without joining.
    os._exit(code if isinstance(code, int) else 1)
