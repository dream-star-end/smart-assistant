-- 0192 — 让被正确分类的 turn 错误真的能落库,并补上注册来源归因。
--
-- Additive and rolling-compatible:放宽 CHECK 不会让任何既有行失效,旧 master 写大写码
-- 照常通过;新增列有默认值,旧 master 的 INSERT 不受影响。
--
-- ── 背景一:product_friction_events.code 的大小写 CHECK 吞掉了全部有效分类 ──────
--
-- 0151 建表时把 code 约束成 `^[A-Z0-9_]{1,64}$`(只收大写),而 turn 错误码的**单一权威**
-- 是 protocol 的 `turnErrorTaxonomy`,其键**全是小写**(insufficient_credits / rate_limited /
-- model_capacity / upstream_failed / upstream_timeout / network_error …)。
--
-- 链路(2026-07-26 逐层核实):
--   web-react reducer.ts:2104  传 `normalized`(taxonomy 归一化结果,小写)
--     → http/clientErrors.ts:21 SAFE_CODE = /^[A-Za-z0-9_]{1,64}$/ 放行小写并透传
--       → INSERT 违反本 CHECK → 抛错 → clientErrors.ts:103 的 .catch() 静默吞掉
--
-- 后果:**凡是被正确分类的错误 100% 落不了库**;能落库的只有前端没带 code、回退成
-- CLIENT_UNKNOWN 的那批。线上实测 30 天 431 条 friction 事件中 `code ~ '[a-z]'` = **0 条**,
-- 而同期 usage_records 里 error 有 91 条 —— 告警与归因双双对结构性故障失明。
--
-- 修法取"放宽 DB"而非"前端改大写":protocol 的小写是既定权威,且 `LEGACY_CODE_ALIASES`
-- 正在把历史大写码往小写归一;反向改前端等于跟权威对着走,还会让 taxonomy 与落库口径
-- 长期分叉。surface/stage 两列本来就是小写约束,code 收大写才是那个不对称的例外。
ALTER TABLE product_friction_events
  DROP CONSTRAINT IF EXISTS product_friction_events_code_check;

ALTER TABLE product_friction_events
  ADD CONSTRAINT product_friction_events_code_check
  CHECK (code ~ '^[A-Za-z0-9_]{1,64}$');

-- ── 背景二:注册来源归因缺失 ────────────────────────────────────────────────
--
-- users 表此前没有任何来源字段,导致 2026-05 那波 152 人的增长**至今无法归因**,
-- 也就无法复制;后续任何投放/召回实验同样没有分母。
--
-- 注意:内部/合成账号的区分**不在这里做** —— 0190 已经引入 `signal_traffic_class`
-- (production_user / internal_admin / synthetic_canary / e2e)且线上已正确填充,
-- 那是该维度的单一权威。本列只回答"这个用户从哪来",两者正交,禁止再造第二套。
--
-- 取值刻意不加 CHECK 白名单:来源是运营维度,新增渠道不该需要一次迁移;
-- 长度与字符集收敛即可,脏值在读侧按 NULL 处理。
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS signup_source TEXT
  CHECK (signup_source IS NULL OR signup_source ~ '^[a-z0-9_.:-]{1,64}$');

COMMENT ON COLUMN users.signup_source IS
  '注册来源归因(小写 slug,如 organic / inbox_recall / wechat / seo)。NULL = 未知(0192 之前的存量)。内部/合成账号维度见 signal_traffic_class,勿在此重复。';

-- 存量用户无法回溯真实来源,统一留 NULL —— 刻意不猜:
-- 编造归因比没有归因更糟(会让后续 A/B 的基线失真)。
