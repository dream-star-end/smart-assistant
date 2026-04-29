-- 0045 — compute_hosts: 主机层 metrics 列(磁盘 / 内存 / load / cpu_count + 采样时间)
--
-- 背景:
--   admin 虚机池表只有 status / active 容器数 / health / cert,缺机器层面
--   "现在到底吃满了没"的直观指标。boss 要求补上磁盘、内存、cpu、请求访问。
--
-- 范围:
--   - 持久化:disk_pct / mem_pct / load1 / cpu_count / metrics_at(每 5min 采集一次)
--   - **不**持久化 5min req:那是 in-memory 滑动窗口的派生量,在 admin API
--     response 时与 DB row merge,无需进库。
--
-- 来源:computeHostsMetricsMonitor 5min tick:
--   - remote host:单条 SSH `df -P / | … ; free -m | … ; cut -d' ' -f1 /proc/loadavg ; nproc`
--   - self host:本地 child_process.exec 同款 4 行
--
-- 边界:
--   - 全部 NULL 起始,采集失败保持原值不动(all-or-nothing 解析)
--   - 不参与调度决策(纯展示性,与 0041 expires_at 同款),不发告警
--     (现有 disk_high alert 沿用 SSH 直采 → DB 列读取双轨 1 个 PR;此处只
--      建表,后续 PR 改 monitor 用 disk_pct 字段 dedupe 与本 PR 解耦)
--   - 不加 index(无按指标排序/扫描场景)
--
-- IF NOT EXISTS:防止开发环境 / 回滚后重跑被 already-exists 拦下。

ALTER TABLE compute_hosts
  ADD COLUMN IF NOT EXISTS disk_pct   SMALLINT     NULL,
  ADD COLUMN IF NOT EXISTS mem_pct    SMALLINT     NULL,
  ADD COLUMN IF NOT EXISTS load1      NUMERIC(6,2) NULL,
  ADD COLUMN IF NOT EXISTS cpu_count  SMALLINT     NULL,
  ADD COLUMN IF NOT EXISTS metrics_at TIMESTAMPTZ  NULL;

COMMENT ON COLUMN compute_hosts.disk_pct IS
  '0045: 根分区 / 使用率(%),0..100。NULL = 从未采集 / 上次采集失败。'
  '由 computeHostsMetricsMonitor 5min tick 写入。';
COMMENT ON COLUMN compute_hosts.mem_pct IS
  '0045: 内存使用率(used/total*100,基于 free -m),0..100。NULL = 从未采集。';
COMMENT ON COLUMN compute_hosts.load1 IS
  '0045: /proc/loadavg 第 1 列(1 分钟平均负载,2 位小数)。NULL = 从未采集。'
  '与 cpu_count 配合判定饱和度(load1 / cpu_count >= 1.0 即单核满载比)。';
COMMENT ON COLUMN compute_hosts.cpu_count IS
  '0045: nproc 输出(逻辑核数)。基本不变,采集 1 次后稳定。';
COMMENT ON COLUMN compute_hosts.metrics_at IS
  '0045: 上次成功采集 metrics 的时间(NOW())。'
  'admin UI:metrics_at > 10min 旧 → 灰显并标注 stale。';
