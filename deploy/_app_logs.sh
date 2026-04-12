#!/bin/bash
echo "=== last 40 lines of /var/log/openclaude.log ==="
tail -40 /var/log/openclaude.log 2>&1
