#!/bin/bash
systemctl restart openclaude
sleep 3
echo -n "service: "; systemctl is-active openclaude

# Create test media files
echo "test content" > /tmp/test-file.txt
cp /tmp/test-file.txt /tmp/test-file.mp4 2>/dev/null

echo
echo "=== /api/file tests (no auth needed now) ==="
echo -n "200 txt: "; curl -sS -o /dev/null -w "%{http_code}" "http://127.0.0.1:18789/api/file?path=/tmp/test-file.txt"
echo
echo -n "200 mp4: "; curl -sS -o /dev/null -w "%{http_code}" "http://127.0.0.1:18789/api/file?path=/tmp/test-file.mp4"
echo
echo -n "400 traversal: "; curl -sS -o /dev/null -w "%{http_code}" "http://127.0.0.1:18789/api/file?path=../etc/passwd"
echo
echo -n "400 relative: "; curl -sS -o /dev/null -w "%{http_code}" "http://127.0.0.1:18789/api/file?path=etc/passwd"
echo
echo -n "404 missing: "; curl -sS -o /dev/null -w "%{http_code}" "http://127.0.0.1:18789/api/file?path=/tmp/nonexistent.mp4"
echo
echo -n "400 no param: "; curl -sS -o /dev/null -w "%{http_code}" "http://127.0.0.1:18789/api/file"
echo

echo
echo "=== /api/media tests ==="
echo "hello" > /root/.openclaude/uploads/test-verify.txt
echo -n "200 media: "; curl -sS -o /dev/null -w "%{http_code}" "http://127.0.0.1:18789/api/media/test-verify.txt"
echo

echo
echo "=== content-type check ==="
curl -sS -I "http://127.0.0.1:18789/api/file?path=/tmp/test-file.mp4" 2>&1 | grep -i content-type

rm -f /tmp/test-file.txt /tmp/test-file.mp4 /root/.openclaude/uploads/test-verify.txt
echo
echo "=== done ==="
