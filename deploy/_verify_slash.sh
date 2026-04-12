#!/bin/bash
echo -n "slashCommands array: "; grep -c 'slashCommands' /opt/openclaude/openclaude/packages/web/public/index.html || echo 0
echo -n "slash-popup CSS: "; grep -c 'slash-popup' /opt/openclaude/openclaude/packages/web/public/index.html || echo 0
echo -n "handleSlashCommand: "; grep -c 'handleSlashCommand' /opt/openclaude/openclaude/packages/web/public/index.html || echo 0
echo
systemctl restart openclaude
sleep 3
echo -n "status: "; systemctl is-active openclaude
