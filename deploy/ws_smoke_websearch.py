import os
#!/usr/bin/env python3
"""Verify WebSearch works after flipping to bypassPermissions."""
import asyncio
import json
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
    peer_id = f"smoke-ws-{int(time.time())}"
    async with websockets.connect(full, open_timeout=20, ping_interval=None) as ws:
        await ws.send(
            json.dumps(
                {
                    "type": "inbound.message",
                    "idempotencyKey": f"ws-{int(time.time() * 1000)}",
                    "channel": "webchat",
                    "peer": {"id": peer_id, "kind": "dm"},
                    "agentId": "main",
                    "content": {
                        "text": "使用 WebSearch 工具搜一下开源项目 hermes-agent,告诉我它是什么。一两句话即可。"
                    },
                    "ts": int(time.time() * 1000),
                }
            )
        )
        print(f">> sent peer={peer_id}", flush=True)
        deadline = time.time() + 300
        text = ""
        tools = []
        perm_denied = False
        while time.time() < deadline:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=280)
            except asyncio.TimeoutError:
                print("!! TIMEOUT", flush=True)
                return 1
            m = json.loads(raw)
            if m.get("type") != "outbound.message":
                continue
            for b in m.get("blocks", []):
                k = b.get("kind")
                if k == "text":
                    text += b.get("text", "")
                elif k == "tool_use":
                    tools.append(("use", b.get("toolName"), (b.get("inputPreview") or "")[:80]))
                elif k == "tool_result":
                    p = b.get("preview") or ""
                    tools.append(("res", b.get("toolName"), p[:100], bool(b.get("isError"))))
                    if "haven't granted" in p or "permission" in p.lower():
                        perm_denied = True
            if m.get("isFinal"):
                meta = m.get("meta") or {}
                break
        print(f"\n--- response ({len(text)} chars) ---")
        print(text[:600])
        print(f"\n--- tools ({len(tools)}) ---")
        for t in tools[:20]:
            print(" ", t)
        print(f"\n--- meta ---")
        print(meta)
        print(f"\n[{'✗' if perm_denied else '✓'}] no permission denial")
        websearch_used = any(t[0] == "use" and t[1] == "WebSearch" for t in tools)
        websearch_got_result = any(
            t[0] == "res" and t[1] == "WebSearch" and not t[3] for t in tools
        )
        print(f"[{'✓' if websearch_used else '✗'}] WebSearch was invoked")
        print(f"[{'✓' if websearch_got_result else '✗'}] WebSearch returned a result (not error)")
        return 0 if websearch_got_result else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
