# Minimal mock of the selfhost master side of the muse-bridge protocol.
import hashlib, json, queue, re, threading, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
TOKEN = "mbr_test_token_not_real"
P = "/api/muse-bridge/v1"
class State:
    def __init__(self):
        self.jobs = queue.Queue(); self.results = {}; self.chunks = {}; self.heartbeats = {}
        self.cancel = set(); self.session = None; self.hellos = 0; self.gone = set(); self.auth_fails = 0
        self.ack_gone = set(); self.ack_flaky = {}; self.hb_delay = {}; self.acked = set()
        self.limits = {"chunk_bytes": 4 * 1024 * 1024}
        self.sources = {}; self.nonces = {}; self.source_requests = []; self.claim_bytes = {}
        self.source_flaky = {}; self.source_bad = {}
        self.done = threading.Condition()
S = State()
class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *a): pass
    def send(self, code, obj=None):
        body = b"" if obj is None else json.dumps(obj).encode()
        self.send_response(code); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def body(self):
        n = int(self.headers.get("Content-Length") or 0); return self.rfile.read(n)
    def auth(self):
        if self.headers.get("Authorization") != "Bearer " + TOKEN:
            S.auth_fails += 1
            self.body(); self.send(401, {"error": {"code": "UNAUTHORIZED", "message": "bridge token rejected"}}); return False
        return True
    def do_GET(self):
        m = re.fullmatch(P + r"/jobs/([^/]+)/sources/(\d+)", self.path)
        if not m: return self.send(404 if self.path != "/healthz" else 200, {"ok": True})
        if not self.auth(): return
        if self.headers.get("X-Muse-Bridge-Session") != S.session:
            return self.send(400, {"error": {"code": "SESSION_UNKNOWN"}})
        jid, n = m[1], int(m[2])
        if jid not in S.acked or jid in S.results or jid in S.gone or self.headers.get("X-Job-Nonce") != S.nonces.get(jid):
            return self.send(410)
        data = S.sources.get((jid, n))
        if data is None: return self.send(404)
        S.source_requests.append((jid, n, self.headers.get("Range"), jid in S.acked))
        if S.source_flaky.get(jid, 0) > 0:
            S.source_flaky[jid] -= 1; return self.send(503)
        span = re.fullmatch(r"bytes=(\d+)-(\d+)", self.headers.get("Range", ""))
        if not span: return self.send(416)
        start, end = int(span[1]), min(int(span[2]), len(data) - 1)
        if start > end: return self.send(416)
        body = data[start:end + 1]
        bad = S.source_bad.get(jid)
        if bad == "sha": body = b"x" * len(body)
        if bad == "short": body = body[:-1]
        self.send_response(200 if bad == "ignored-range" else 206)
        self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, len(data)))
        self.send_header("Content-Length", str(len(body)))
        self.end_headers(); self.wfile.write(body)
    def do_POST(self):
        if not self.path.startswith(P + "/"):  # like the master: 404 before authentication
            self.body(); return self.send(404, {"error": {"code": "NOT_FOUND", "message": "not found"}})
        if not self.auth(): return
        data = self.body(); path = self.path
        if path == P + "/hello":
            S.hellos += 1; S.session = uuid.uuid4().hex; S.last_hello = json.loads(data)
            return self.send(200, {"session_id": S.session, "poll_hold_sec": 2, "heartbeat_sec": 5, "limits": S.limits})
        if self.headers.get("X-Muse-Bridge-Session") != S.session:
            return self.send(409, {"error": {"code": "SUPERSEDED", "message": "a newer bridge session took over"}})
        if path == P + "/poll":
            try: job = S.jobs.get(timeout=2)
            except queue.Empty: return self.send(204)
            S.nonces[job["id"]] = job["nonce"]
            S.claim_bytes[job["id"]] = len(json.dumps({"job": job}).encode())
            return self.send(200, {"job": job})
        jid = path.split("/")[5]
        if jid in S.gone: return self.send(410)
        if path.endswith("/heartbeat"):
            if jid in S.ack_gone: return self.send(410)
            if S.ack_flaky.get(jid, 0) > 0:
                S.ack_flaky[jid] -= 1; return self.send(503, {"error": "flaky"})
            if jid in S.hb_delay and jid in S.acked:
                import time; time.sleep(S.hb_delay[jid]); return self.send(410)
            S.acked.add(jid)
            S.heartbeats[jid] = S.heartbeats.get(jid, 0) + 1
            return self.send(200, {"cancel": jid in S.cancel})
        if path.endswith("/result"):
            with S.done:
                S.results[jid] = json.loads(data); S.done.notify_all()
            return self.send(200, {"ok": True})
        self.send(404)
    def do_PUT(self):
        if not self.auth(): return
        data = self.body(); parts = self.path.split("/")
        jid, idx, n = parts[5], int(parts[7]), int(parts[9])
        if hashlib.sha256(data).hexdigest() != self.headers.get("X-Chunk-Sha256"):
            return self.send(400, {"error": "sha"})
        S.chunks.setdefault((jid, idx), {})[n] = data
        self.send(200, {"ok": True})
def start(port=0):
    srv = ThreadingHTTPServer(("127.0.0.1", port), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv
def wait_result(jid, timeout):
    with S.done:
        S.done.wait_for(lambda: jid in S.results, timeout)
    return S.results.get(jid)
