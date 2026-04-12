#!/usr/bin/env python3
"""E2E verify the permission relay: agent tries a red-line operation, guard
holds it, gateway pushes a permission_request via WS, we respond allow,
guard unblocks and CCB runs the command."""
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


async def main():
    full = f"{URL}?token={TOKEN}"
    peer_id = f"smoke-relay-{int(time.time())}"
    saw_permission_request = False
    saw_bash_allow_result = False
    permission_was_handled = False

    async with websockets.connect(full, open_timeout=20, ping_interval=None) as ws:
        # Send a message asking the agent to run iptables -L
        await ws.send(
            json.dumps(
                {
                    "type": "inbound.message",
                    "idempotencyKey": f"relay-{int(time.time() * 1000)}",
                    "channel": "webchat",
                    "peer": {"id": peer_id, "kind": "dm"},
                    "agentId": "main",
                    "content": {
                        "text": "用 Bash 工具执行 `iptables -L INPUT` 查看当前 INPUT 链的规则,然后给我简要描述。"
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
                print("!! ws timeout", flush=True)
                break
            m = json.loads(raw)
            if m.get("type") != "outbound.message":
                continue

            # Permission request path
            if m.get("permissionRequest"):
                pr = m["permissionRequest"]
                print(f"\n🔒 got permission request: {pr}", flush=True)
                saw_permission_request = True
                # Send allow after a short delay (simulating user tap)
                await asyncio.sleep(0.5)
                await ws.send(
                    json.dumps(
                        {
                            "type": "inbound.permission_response",
                            "requestId": pr["id"],
                            "decision": "allow",
                        }
                    )
                )
                print(f"✓ sent allow response for reqId={pr['id']}", flush=True)
                permission_was_handled = True
                continue

            # Normal outbound
            blocks = m.get("blocks", [])
            for b in blocks:
                k = b.get("kind")
                if k == "text":
                    text_buf += b.get("text", "")
                elif k == "tool_use":
                    tools.append(("use", b.get("toolName"), (b.get("inputPreview") or "")[:120]))
                elif k == "tool_result":
                    prev = b.get("preview") or ""
                    tools.append(("res", b.get("toolName"), prev[:180], bool(b.get("isError"))))
                    if b.get("toolName") == "Bash" and not b.get("isError"):
                        # Successful Bash result means guard let it through
                        if "Chain" in prev or "INPUT" in prev or "ACCEPT" in prev or "REJECT" in prev:
                            saw_bash_allow_result = True

            if m.get("isFinal"):
                break

        print("\n--- response ---")
        print(text_buf[:600])
        print("\n--- tools ---")
        for t in tools[:20]:
            print(" ", t)

    print("\n══ summary ══")
    print(f"[{'✓' if saw_permission_request else '✗'}] permission_request frame received")
    print(f"[{'✓' if permission_was_handled else '✗'}] we sent an allow response back")
    print(f"[{'✓' if saw_bash_allow_result else '✗'}] Bash tool was actually executed after allow")
    ok = saw_permission_request and permission_was_handled and saw_bash_allow_result
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
