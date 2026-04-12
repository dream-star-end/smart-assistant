#!/bin/bash
echo "=== check if lastActiveChannel is populated ==="
# We can't directly read JS memory, but we can check WS connections
echo "WS clients connected: $(ss -tnp | grep 18789 | grep ESTAB | wc -l)"

echo
echo "=== clientsByPeer keys (from recent log) ==="
grep -i 'peerKey\|clientsByPeer\|webchat:' /var/log/openclaude.log | tail -5

echo
echo "=== recent dispatches ==="
grep -i 'dispatchInbound\|lastActive' /var/log/openclaude.log | tail -5
