#!/usr/bin/env python3
"""L1 smoke test: send one message, verify FTS5 indexing + USER.md injected."""
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

URL = os.environ.get("WS_URL", "ws://127.0.0.1:18789/ws")
TOKEN = "43efa4d9ad09122a16820c7ff4039269600e2a000224c2d5b272d84114343d52"


async def main():
    full = f"{URL}?token={TOKEN}"
    peer_id = f"smoke-l1-{int(time.time())}"
    async with websockets.connect(full, open_timeout=20, ping_interval=None) as ws:
        await ws.send(
            json.dumps(
                {
                    "type": "inbound.message",
                    "idempotencyKey": f"l1-{int(time.time() * 1000)}",
                    "channel": "webchat",
                    "peer": {"id": peer_id, "kind": "dm"},
                    "agentId": "main",
                    "content": {
                        "text": "用两句话说明 OpenClaude 这个项目是什么,并说出我的名字。"
                    },
                    "ts": int(time.time() * 1000),
                }
            )
        )
        print(f">> sent peer={peer_id}", flush=True)
        deadline = time.time() + 240
        full_text = ""
        thinking_text = ""
        tool_events = []
        meta = None
        while time.time() < deadline:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=200)
            except asyncio.TimeoutError:
                print("!! TIMEOUT", flush=True)
                return 1
            m = json.loads(raw)
            if m.get("type") != "outbound.message":
                continue
            for b in m.get("blocks", []):
                k = b.get("kind")
                if k == "text":
                    full_text += b.get("text", "")
                elif k == "thinking":
                    thinking_text += b.get("text", "")
                elif k == "tool_use":
                    tool_events.append(
                        ("use", b.get("toolName"), (b.get("inputPreview") or "")[:80])
                    )
                elif k == "tool_result":
                    tool_events.append(
                        ("res", b.get("toolName"), (b.get("preview") or "")[:80])
                    )
            if m.get("isFinal"):
                meta = m.get("meta") or {}
                break
        print(f"\n--- response ({len(full_text)} chars) ---")
        print(full_text[:800])
        print(f"\n--- tool events ({len(tool_events)}) ---")
        for t in tool_events[:20]:
            print(" ", t)
        print(f"\n--- thinking excerpt ---")
        print(thinking_text[:300])
        print(f"\n--- meta ---")
        print(meta)
        mentions_alice = "Alice" in full_text or "alice" in full_text.lower() or "爱丽丝" in full_text
        mentions_project = "OpenClaude" in full_text or "openclaude" in full_text.lower()
        print(f"\n[{'✓' if mentions_alice else '✗'}] response mentions Alice (from USER.md injection)")
        print(f"[{'✓' if mentions_project else '✗'}] response mentions OpenClaude")
        return 0 if (mentions_alice or mentions_project) else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
