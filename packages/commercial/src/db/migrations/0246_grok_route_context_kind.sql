-- 0246_grok_route_context_kind.sql
-- grok_route_contexts 行按来源分租约语义:
--   bridge   —— 浏览器 turn。user chat bridge 铸造,终态由计费终结帧显式 expire;
--               7 天滑动 TTL 只是"孤儿密钥清扫"兜底,不是并发生命周期。
--   delegate —— 容器本地 delegate turn(delegate_task / taskboard patrol / review)。
--               没有 bridge 计费终结帧:网关进程崩溃后不会有任何人来 release,
--               7 天滑动 TTL 会把 10 槽账号并发占满一周(2026-08 审查【高】项)。
--               改为短租约(groups.ts GROK_DELEGATE_ROUTE_TTL_MS)+ 网关心跳/中继
--               请求续短租;心跳一停,租约分钟级自然过期,allocate 前的
--               listActiveGrokRouteLeases/expireSettledGrokRouteLeases 不再回填。
--
-- 存量行全部来自 bridge 路径(delegate mint 在本迁移之前不写 kind),DEFAULT 'bridge'
-- 即正确回填;新 delegate 行由代码显式写 kind='delegate'。
ALTER TABLE grok_route_contexts
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'bridge'
    CHECK (kind IN ('bridge', 'delegate'));

-- delegate per-container 并发限额的 count 走 (container_id, kind, status, expires_at);
-- 既有 idx_grok_route_contexts_lookup(container_id, user_id, expires_at) WHERE
-- status='active' 已可服务该查询(container_id 前缀),不再加索引。
