-- 0081 compute_hosts: 增加终态 'revoked' status(A3 host 吊销 kill-switch)
--
-- 背景:此前 host 授权与证书有效性混为一谈 —— 控制面/RPC/tunnel/file 用 getHostById
-- 解析 host 时不判 status,quarantined/broken host 只要 cert+PSK 有效就照样服务;
-- maybeRenewCert 还会给非 active host 续签,defeat "证书过期" 这个唯一吊销手段。
-- 没有 kill-switch:把 host 标 quarantined 并不能真正切断它。
--
-- 'revoked' = 终态安全状态(被入侵/下线),永不服务、永不被 health 轮询/续签;
-- 与 quarantined(可恢复)区分。admin revoke 时同时把 agent_cert_fingerprint_sha256
-- 置 NULL(立即断,不等证书过期)。superset 扩 CHECK,不影响任何现有行。
--
-- 0030 的 status CHECK 是匿名内联约束,这里用 DO 块按 pg_constraint 发现其名字后
-- DROP,再以稳定名 compute_hosts_status_check 重建(含 'revoked')。
--
-- 发现谓词按"引用 status 列"匹配(compute_hosts 上唯一引用该列的 CHECK 就是状态
-- 枚举约束;aead_nonempty / quarantine_reason / *_port / max_containers 均不含
-- 'status' 子串)。不依赖 IN→= ANY 归一化形态,也不依赖枚举值恰好含某子串,
-- 故对 PG 版本/0030 写法稳定。重跑安全:命名后的 compute_hosts_status_check 仍
-- 引用 status → 再次被发现并 DROP+重建(幂等)。

DO $$
DECLARE
  conname_found TEXT;
BEGIN
  SELECT conname INTO conname_found
  FROM pg_constraint
  WHERE conrelid = 'compute_hosts'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%status%'
  LIMIT 1;

  IF conname_found IS NOT NULL THEN
    EXECUTE format('ALTER TABLE compute_hosts DROP CONSTRAINT %I', conname_found);
  END IF;
END $$;

ALTER TABLE compute_hosts
  ADD CONSTRAINT compute_hosts_status_check
  CHECK (status IN ('bootstrapping','ready','quarantined','draining','broken','revoked'));
