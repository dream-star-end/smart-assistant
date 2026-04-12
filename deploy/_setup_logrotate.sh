#!/bin/bash
cat > /etc/logrotate.d/openclaude << 'EOF'
/var/log/openclaude.log {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
    size 10M
}
EOF
echo "logrotate config created"
cat /etc/logrotate.d/openclaude
echo
echo "=== test rotation ==="
logrotate -d /etc/logrotate.d/openclaude 2>&1 | head -5
