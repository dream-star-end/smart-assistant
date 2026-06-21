#!/usr/bin/env python3
"""Chrome-TLS-impersonating egress sidecar for the ChatGPT web proxy.

chatgpt.com is guarded by Cloudflare's *managed challenge*, which fingerprints
the TLS handshake. Node's TLS stack always gets `cf-mitigated: challenge` (403),
so the gateway reverse proxy renders OpenAI's "Unable to load site" page. A
Chrome-JA3 client (curl_cffi) passes the challenge cleanly.

This is a private, loopback-only RPC stand-in for the upstream HTTPS leg. The
gateway forwards an already-resolved upstream request and the sidecar re-issues
it with a browser TLS fingerprint, streaming the response straight back. The
gateway keeps owning URL/cookie rewriting and body rewriting — the sidecar is a
transparent substitute for `https.request`, nothing more.

Protocol (gateway -> sidecar, plain HTTP on 127.0.0.1):
  - any method/path; the real method is reused verbatim
  - X-OC-Sidecar-Token:    shared secret; constant-time compared
  - X-OC-Upstream-URL:     absolute https URL (host whitelisted, port 443/empty)
  - X-OC-Upstream-Headers: base64(JSON{name: value}) headers to send upstream
  - body:                  forwarded verbatim
Response (sidecar -> gateway): the upstream status/headers/body, with
  content-encoding/content-length/hop-by-hop stripped (libcurl already decoded
  the body) and every Set-Cookie preserved as a distinct header line.

Cookie state is intentionally NOT persisted here: the browser <-> gateway rewrite
layer is the single authority for cookies, so each request is stateless.
"""
import base64
import hmac
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from curl_cffi import requests as creq

PORT = int(os.environ.get("OC_CHATGPT_SIDECAR_PORT", "18992"))
TOKEN = os.environ.get("OC_CHATGPT_SIDECAR_TOKEN", "")
PROXY = os.environ.get("OC_CHATGPT_SIDECAR_PROXY", "").strip() or None
IMPERSONATE = os.environ.get("OC_CHATGPT_SIDECAR_IMPERSONATE", "chrome").strip() or "chrome"

# Kept in lockstep with ALLOWED_ROOT_DOMAINS in chatgptWebProxy.ts. The gateway
# only ever resolves whitelisted hosts; the sidecar re-checks as defence in depth
# so this loopback egress can never be coerced into a generic SSRF primitive.
ALLOWED_ROOTS = ("chatgpt.com", "openai.com", "oaistatic.com", "oaiusercontent.com")

# Stripped on the way back: hop-by-hop framing + content coding/length. libcurl
# transparently decoded the body (impersonate sets Accept-Encoding), so the
# original content-encoding/content-length no longer describe what we relay, and
# the gateway only rewrites bodies when no content-encoding is present.
STRIP_RESPONSE_HEADERS = frozenset(
    {
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        "content-encoding",
        "content-length",
    }
)


def host_allowed(host: str) -> bool:
    host = (host or "").lower()
    return any(host == root or host.endswith("." + root) for root in ALLOWED_ROOTS)


def proxies():
    return {"http": PROXY, "https": PROXY} if PROXY else None


def response_header_pairs(headers) -> list[tuple[str, str]]:
    """All response headers as (name, value), preserving duplicate Set-Cookie.

    curl_cffi's Headers mirrors httpx: prefer multi_items(); fall back to
    iterating unique keys + get_list() so multi-valued headers survive.
    """
    multi = getattr(headers, "multi_items", None)
    if callable(multi):
        return list(multi())
    pairs: list[tuple[str, str]] = []
    seen: set[str] = set()
    for key in headers.keys():
        lk = key.lower()
        if lk in seen:
            continue
        seen.add(lk)
        get_list = getattr(headers, "get_list", None)
        values = get_list(key) if callable(get_list) else [headers[key]]
        for value in values:
            pairs.append((key, value))
    return pairs


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    # Never echo request lines: they carry the upstream URL and (indirectly) auth.
    def log_message(self, *_args):
        pass

    def _reject(self, code: int, msg: str) -> None:
        body = msg.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:
            pass
        self.close_connection = True

    def _handle(self) -> None:
        self.close_connection = True

        token = self.headers.get("X-OC-Sidecar-Token", "")
        if not TOKEN or not hmac.compare_digest(token, TOKEN):
            return self._reject(403, "forbidden")

        url = self.headers.get("X-OC-Upstream-URL", "")
        parts = urlsplit(url)
        port_ok = True
        try:
            port_ok = parts.port in (None, 443)
        except ValueError:
            port_ok = False
        if (
            parts.scheme != "https"
            or not port_ok
            or parts.username
            or parts.password
            or not host_allowed(parts.hostname or "")
        ):
            return self._reject(400, "bad upstream target")

        try:
            raw = self.headers.get("X-OC-Upstream-Headers", "") or "e30="  # {}
            upstream_headers = json.loads(base64.b64decode(raw).decode("utf-8"))
            if not isinstance(upstream_headers, dict):
                raise ValueError("headers must be an object")
        except Exception:
            return self._reject(400, "bad upstream headers")

        length = int(self.headers.get("Content-Length", "0") or "0")
        body = self.rfile.read(length) if length > 0 else None

        try:
            resp = creq.request(
                self.command,
                url,
                headers=upstream_headers,
                data=body,
                impersonate=IMPERSONATE,
                proxies=proxies(),
                stream=True,
                allow_redirects=False,
                # (connect, read): the read value is an inactivity gap, not a
                # total cap — it resets on each chunk, so a steadily-streaming
                # SSE response is never cut, only a 5-min-silent one is reaped.
                timeout=(15, 300),
                verify=True,
            )
        except Exception:
            return self._reject(502, "sidecar upstream failed")

        try:
            self.send_response(resp.status_code)
            for name, value in response_header_pairs(resp.headers):
                if name.lower() in STRIP_RESPONSE_HEADERS:
                    continue
                self.send_header(name, value)
            # No content-length/chunked: delimit the body by closing the socket.
            # The gateway reads until EOF, so SSE streams flush incrementally.
            self.send_header("Connection", "close")
            self.end_headers()
            if self.command != "HEAD":
                for chunk in resp.iter_content():
                    if not chunk:
                        continue
                    self.wfile.write(chunk)
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            resp.close()

    do_GET = _handle
    do_POST = _handle
    do_PUT = _handle
    do_PATCH = _handle
    do_DELETE = _handle
    do_HEAD = _handle
    do_OPTIONS = _handle


def main() -> int:
    if not TOKEN:
        print("[chatgpt-tls-sidecar] refusing to start without OC_CHATGPT_SIDECAR_TOKEN", file=sys.stderr)
        return 2
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.daemon_threads = True
    print(
        f"[chatgpt-tls-sidecar] listening on 127.0.0.1:{PORT} "
        f"impersonate={IMPERSONATE} proxy={'on' if PROXY else 'off'}",
        file=sys.stderr,
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
