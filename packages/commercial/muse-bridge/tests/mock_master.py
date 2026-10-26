# Minimal mock of the selfhost master side of the muse-bridge protocol.
import hashlib, json, queue, threading, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
TOKEN = "mbr_test_token_not_real"
P = "/api/muse-bridge/v1"
class State:
    def __init__(self):
        self.jobs = queue.Queue(); self.results = {}; self.chunks = {}; self.heartbeats = {}
        self.cancel = set(); self.session = None; self.hellos = 0; self.gone = set(); self.auth_fails = 0
        self.ack_gone = set(); self.ack_flaky = {}; self.hb_delay = {}; self.acked = set()
        self.limits = {"chunk_bytes": 4 * 1024 * 1024, "source_chunk_bytes": 64}
        # 0.5 source references: jid -> [bytes]; GETs that fail (503) or come back corrupted; the
        # order of acks and source GETs, to prove downloads only start after the ack.
        self.sources = {}; self.src_flaky = {}; self.src_corrupt = set(); self.src_short = {}; self.src_bad_cr = set(); self.events = []
        self.max_concurrency = None; self.session_unknown = False; self.poll_errors = 0; self.polls = 0
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
        parts = self.path.split("/")
        if self.path.startswith(P + "/jobs/") and len(parts) == 8 and parts[6] == "sources":
            if not self.auth(): return
            if self.headers.get("X-Muse-Bridge-Session") != S.session:
                return self.send(409, {"error": {"code": "SUPERSEDED", "message": "superseded"}})
            jid, n = parts[5], int(parts[7])
            S.events.append(("src", jid, self.headers.get("Range")))
            if jid not in S.acked or self.headers.get("X-Job-Nonce") != "n-" + jid: return self.send(410)
            if S.src_flaky.get(jid, 0) > 0:
                S.src_flaky[jid] -= 1; return self.send(503, {"error": "flaky"})
            data = S.sources[jid][n]
            a, b = self.headers.get("Range", "bytes=0-").split("=")[1].split("-")
            a = int(a); b = min(int(b) if b else len(data) - 1, len(data) - 1)
            body = data[a:b + 1]
            if jid in S.src_corrupt: body = bytes([body[0] ^ 1]) + body[1:]
            cr_a, cr_b = a, b
            if jid in S.src_bad_cr:
                # Persistent wrong Content-Range (does not match request Range).
                cr_a, cr_b = a + 1, b + 1
            if S.src_short.get(jid, 0) > 0:
                S.src_short[jid] -= 1
                # Correct Content-Range but truncated body → bridge short-read path.
                body = body[: max(1, len(body) // 2)]
            self.send_response(206); self.send_header("Content-Length", str(len(body)))
            self.send_header("Content-Range", "bytes %d-%d/%d" % (cr_a, cr_b, len(data))); self.end_headers()
            return self.wfile.write(body)
        self.send(404 if self.path != "/healthz" else 200, {"ok": True})
    def do_POST(self):
        if not self.path.startswith(P + "/"):  # like the master: 404 before authentication
            self.body(); return self.send(404, {"error": {"code": "NOT_FOUND", "message": "not found"}})
        if not self.auth(): return
        data = self.body(); path = self.path
        if path == P + "/hello":
            S.hellos += 1; S.session = uuid.uuid4().hex; S.last_hello = json.loads(data)
            hello = {"session_id": S.session, "poll_hold_sec": 2, "heartbeat_sec": 5, "limits": S.limits}
            if S.max_concurrency is not None: hello["max_concurrency"] = S.max_concurrency
            return self.send(200, hello)
        if self.headers.get("X-Muse-Bridge-Session") != S.session:
            return self.send(409, {"error": {"code": "SUPERSEDED", "message": "a newer bridge session took over"}})
        if path == P + "/poll":
            S.polls += 1
            if S.session_unknown:
                S.session_unknown = False
                return self.send(400, {"error": {"code": "SESSION_UNKNOWN", "message": "unknown session; send hello again"}})
            if S.poll_errors > 0:
                S.poll_errors -= 1; return self.send(502, {"error": "bad gateway"})
            try: job = S.jobs.get(timeout=2)
            except queue.Empty: return self.send(204)
            return self.send(200, {"job": job})
        jid = path.split("/")[5]
        if jid in S.gone: return self.send(410)
        if path.endswith("/heartbeat"):
            if jid in S.ack_gone: return self.send(410)
            if S.ack_flaky.get(jid, 0) > 0:
                S.ack_flaky[jid] -= 1; return self.send(503, {"error": "flaky"})
            if jid in S.hb_delay and jid in S.acked:
                import time; time.sleep(S.hb_delay[jid]); return self.send(410)
            if jid not in S.acked: S.events.append(("ack", jid))
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
