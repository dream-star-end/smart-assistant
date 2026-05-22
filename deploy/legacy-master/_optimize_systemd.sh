#!/bin/bash
echo "=== current ExecStart ==="
grep ExecStart /etc/systemd/system/openclaude.service

echo
echo "=== optimize: use node --import tsx directly ==="
# Change from: npx tsx packages/cli/src/index.ts gateway
# To: node --import tsx packages/cli/src/index.ts gateway
# This eliminates 2 intermediate processes (npx → sh → node → tsx → node)

sed -i 's|ExecStart=.*|ExecStart=/usr/bin/node --require /opt/openclaude/openclaude/node_modules/tsx/dist/preflight.cjs --import file:///opt/openclaude/openclaude/node_modules/tsx/dist/loader.mjs packages/cli/src/index.ts gateway|' /etc/systemd/system/openclaude.service

echo
echo "=== updated ExecStart ==="
grep ExecStart /etc/systemd/system/openclaude.service

echo
echo "=== reload + restart ==="
systemctl daemon-reload
systemctl restart openclaude
sleep 3
echo -n "status: "; systemctl is-active openclaude

echo
echo "=== verify process count ==="
ps -eo pid,ppid,cmd | grep -E 'openclaude|tsx.*gateway' | grep -v grep
