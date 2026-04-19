-- 0008 model_pricing 变更通知
-- 目的:admin UI 改价 → 进程内 pricing cache 自动失效重载(T-20)
--
-- 设计:在 model_pricing 上挂一个 AFTER INSERT/UPDATE/DELETE 触发器,
--       触发 `NOTIFY pricing_changed`。payload 为空(PricingCache 触发时
--       重载全表,不关心是哪一行变了),保持迁移简单且向后兼容 —— 如果
--       未来要精细化,可改 payload 为行 JSON。
--
-- 注意:pg 允许同事务内重复 NOTIFY 合并成单次递送(per channel+payload),
--       因此 admin 批量 UPDATE 时只会收到一次通知,cache 也只 reload 一次。

CREATE OR REPLACE FUNCTION notify_pricing_changed() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('pricing_changed', '');
  RETURN NULL; -- AFTER 触发器无需返回 NEW/OLD
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_model_pricing_notify ON model_pricing;
CREATE TRIGGER trg_model_pricing_notify
AFTER INSERT OR UPDATE OR DELETE ON model_pricing
FOR EACH STATEMENT
EXECUTE FUNCTION notify_pricing_changed();
