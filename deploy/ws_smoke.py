#!/usr/bin/env python3
"""End-to-end WebSocket smoke test against OpenClaude gateway."""
import asyncio
import json
import os
import sys
import time

try:
    import websockets
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", "websockets"])
    import websockets

URL = os.environ.get("WS_URL", os.environ.get("WS_URL", "ws://127.0.0.1:18789/ws"))
TOKEN = os.environ.get("WS_TOKEN", "")
MSG = os.environ.get("WS_MSG", "say hello in one short sentence")


async def main():
    full = f"{URL}?token={TOKEN}"
    print(f"connecting {URL} ...", flush=True)
    async with websockets.connect(full, open_timeout=15, ping_interval=None) as ws:
        print("connected, sending message", flush=True)
        peer_id = f"smoke-{int(time.time())}"
        frame = {
            "type": "inbound.message",
            "idempotencyKey": f"smoke-{int(time.time()*1000)}",
            "channel": "webchat",
            "peer": {"id": peer_id, "kind": "dm"},
            "content": {"text": MSG},
            "ts": int(time.time() * 1000),
        }
        await ws.send(json.dumps(frame))
        print(f"sent: {MSG!r}", flush=True)
        print("waiting for outbound frames...", flush=True)
        start = time.time()
        final_seen = False
        accumulated_text = ""
        try:
            while not final_seen and (time.time() - start) < 180:
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=120)
                except asyncio.TimeoutError:
                    print("TIMEOUT waiting for message", file=sys.stderr)
                    return 1
                try:
                    msg = json.loads(raw)
                except Exception:
                    print(f"non-json: {raw[:200]}", flush=True)
                    continue
                if msg.get("type") != "outbound.message":
                    print(f"other frame: {msg}", flush=True)
                    continue
                blocks = msg.get("blocks", [])
                for b in blocks:
                    if b.get("kind") == "text":
                        accumulated_text += b.get("text", "")
                        print(f"  [text] {b.get('text')!r}", flush=True)
                    elif b.get("kind") == "tool_use":
                        print(f"  [tool] {b.get('toolName')}: {b.get('inputPreview', '')[:80]}", flush=True)
                    elif b.get("kind") == "tool_result":
                        preview = b.get("preview") or ""
                        err = " ERR" if b.get("isError") else ""
                        print(f"  [result{err}] {preview[:80]}", flush=True)
                if msg.get("isFinal"):
                    meta = msg.get("meta") or {}
                    print(f"--- FINAL (cost ${meta.get('cost', 0):.4f}) ---", flush=True)
                    final_seen = True
        except websockets.ConnectionClosed as e:
            print(f"connection closed: {e}", flush=True)
        print(f"\nfull assistant text: {accumulated_text!r}", flush=True)
        return 0 if final_seen else 2


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
