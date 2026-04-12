#!/bin/bash
echo -n "platform hint: "; grep -c 'OpenClaude platform capabilities' /opt/openclaude/openclaude/packages/gateway/src/subprocessRunner.ts || echo 0
echo -n "code block protect: "; grep -c 'CODE_BLOCK_' /opt/openclaude/openclaude/packages/web/public/index.html || echo 0
echo -n "renderLocalMedia: "; grep -c '_renderLocalMedia' /opt/openclaude/openclaude/packages/web/public/index.html || echo 0
echo
systemctl restart openclaude
sleep 3
echo -n "status: "; systemctl is-active openclaude
echo
ss -lnt | grep 18789
