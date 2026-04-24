-- 0029 — user_remote_hosts 增加 host_keys_text 列
--
-- R7 Codex BLOCK:0028 只存 `fingerprint: TEXT`,但 ssh 的 `StrictHostKeyChecking=yes`
-- 需要的是完整 known_hosts 行("hostname algo base64material"),不是 fingerprint。
--
-- 冷启动路径:
--   - /run/ccb-ssh/u<uid>/h<hid>/known_hosts(tmpfs)在 gateway 重启 / 宿主重启 /
--     systemd 清 RuntimeDirectory 时会丢
--   - 丢了必须从 DB rebuild。只有 fingerprint 无法 rebuild(需要原始 key 字节)
--
-- 方案:
--   - host_keys_text:`ssh-keyscan -t rsa,ecdsa,ed25519 -p <port> <host>` 的**原始多行**
--     输出,直接当 known_hosts 文件内容使用
--   - fingerprint 字段保留,只作为 UI 展示(SHA256:xxx 一行好看)
--
-- 幂等:IF NOT EXISTS。

ALTER TABLE user_remote_hosts
  ADD COLUMN IF NOT EXISTS host_keys_text TEXT;
