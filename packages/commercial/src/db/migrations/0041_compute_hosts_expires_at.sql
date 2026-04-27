-- 0041 — compute_hosts.expires_at:服务器租期到期时间
--
-- 背景:
--   admin 在虚机池里看到的 host 需要带上"VPS 租期到期时间",用于 ops 提醒/续费判断。
--   当前没有任何字段记录这个,只能去 VPS 面板上对照。
--
-- 范围:
--   - 纯展示性字段,不参与调度决策、不触发自动 drain、不发告警。
--   - NULL = self host(永久)或未填(自有/永久机)。
--   - 由 admin 在添加 host / 编辑 host 时手填(东八区 input → +08:00 ISO → UTC 入库)。
--
-- 不做:
--   - 不加 index(无按到期排序/扫描场景)
--   - 不 backfill(self / 已存在的 host 留 NULL,允许)

ALTER TABLE compute_hosts ADD COLUMN expires_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN compute_hosts.expires_at IS
  'V3 D.4 ext: 服务器租期到期时间(TIMESTAMPTZ,UTC 入库;admin UI 用 +08:00 显示和编辑)。'
  'NULL = self 或未填(永久/自有)。仅展示用,不触发任何自动化(无自动 drain / 告警)。';
