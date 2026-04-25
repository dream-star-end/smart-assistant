-- 0038 egress host assignment — 把 OAuth 账号自动分配到一台 compute_host,
-- 让该 host 的 node-agent :9444 mTLS forward proxy 当账号专属出口,稳定 IP。
--
-- 设计:见 plan v4(Codex review PASS)。两条新列 + 一个 FK + 一个部分索引。
--
-- 兼容性:additive only。存量账号 egress_host_uuid 保持 NULL,继续走
-- master 默认出口或 admin 手填的 egress_proxy(优先级高于 host 自动分配)。

ALTER TABLE compute_hosts
  ADD COLUMN egress_proxy_endpoint TEXT;
COMMENT ON COLUMN compute_hosts.egress_proxy_endpoint IS
  'master forward proxy endpoint marker, format "mtls://<host>:9444"; '
  'NULL 表示 :9444 探活未通过(host 仍可调度容器,但不参与 egress 自动分配)。'
  ' 解析端口由 master 端 EgressTarget 构造,不在此列 parse。';

ALTER TABLE claude_accounts
  ADD COLUMN egress_host_uuid UUID
    REFERENCES compute_hosts(id) ON DELETE SET NULL;
COMMENT ON COLUMN claude_accounts.egress_host_uuid IS
  '账号绑定的 egress host。NULL = 走 master 默认出口或 egress_proxy(后者优先)。'
  ' host DELETE 自动 SET NULL,告警提示 admin 手动重分配。';

-- 仅对已分配的账号建索引(分配率低 → partial index 省空间 + 加速 reassign 查询)
CREATE INDEX idx_ca_egress_host ON claude_accounts(egress_host_uuid)
  WHERE egress_host_uuid IS NOT NULL;
