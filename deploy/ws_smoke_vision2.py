#!/usr/bin/env python3
"""E2E vision test v2: ask agent to describe a real photo via understand_image
using an HTTPS URL (no upload path), proving the MCP tool works end-to-end."""
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

URL = "ws://45.32.41.166:18789/ws"
TOKEN = "43efa4d9ad09122a16820c7ff4039269600e2a000224c2d5b272d84114343d52"

# Apollo 11 Aldrin photo — famous, public-domain, unambiguous content
IMG_URL = "https://upload.wikimedia.org/wikipedia/commons/thumb/c/c3/Aldrin_Apollo_11_original.jpg/400px-Aldrin_Apollo_11_original.jpg"


async def main():
    full = f"{URL}?token={TOKEN}"
    peer_id = f"smoke-vision2-{int(time.time())}"
    async with websockets.connect(full, open_timeout=20, ping_interval=None) as ws:
        await ws.send(
            json.dumps(
                {
                    "type": "inbound.message",
                    "idempotencyKey": f"v2-{int(time.time() * 1000)}",
                    "channel": "webchat",
                    "peer": {"id": peer_id, "kind": "dm"},
                    "agentId": "main",
                    "content": {
                        "text": f"用 understand_image MCP 工具分析这张图: {IMG_URL}\n\n用一句话告诉我看到了什么。"
                    },
                    "ts": int(time.time() * 1000),
                }
            )
        )
        print(f">> sent peer={peer_id}", flush=True)

        deadline = time.time() + 360
        text_buf = ""
        tools = []
        while time.time() < deadline:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=300)
            except asyncio.TimeoutError:
                break
            m = json.loads(raw)
            if m.get("type") != "outbound.message":
                continue
            if m.get("permissionRequest"):
                pr = m["permissionRequest"]
                await ws.send(
                    json.dumps(
                        {
                            "type": "inbound.permission_response",
                            "requestId": pr["id"],
                            "decision": "allow",
                        }
                    )
                )
                continue
            for b in m.get("blocks", []):
                k = b.get("kind")
                if k == "text":
                    text_buf += b.get("text", "")
                elif k == "tool_use":
                    tools.append(("use", b.get("toolName"), (b.get("inputPreview") or "")[:200]))
                elif k == "tool_result":
                    tools.append(("res", b.get("toolName"), (b.get("preview") or "")[:250], bool(b.get("isError"))))
            if m.get("isFinal"):
                break

    print("\n--- response ---")
    print(text_buf[:600])
    print("\n--- tools ---")
    for t in tools[:20]:
        print(" ", t)

    print("\n══ summary ══")
    ui_calls = [t for t in tools if t[0] == "use" and "understand_image" in (t[1] or "")]
    ui_res = [t for t in tools if t[0] == "res" and "understand_image" in (t[1] or "") and not t[3]]
    apollo_mentioned = any(kw in text_buf.lower() for kw in ["astronaut", "宇航员", "月球", "moon", "apollo", "宇航", "spacesuit", "宇航服"])
    print(f"[{'✓' if ui_calls else '✗'}] understand_image invoked ({len(ui_calls)} times)")
    print(f"[{'✓' if ui_res else '✗'}] understand_image returned non-error result")
    print(f"[{'✓' if apollo_mentioned else '✗'}] response mentions astronaut/moon/Apollo")
    return 0 if (ui_calls and ui_res and apollo_mentioned) else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
