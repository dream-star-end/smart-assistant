-- 0135_model_catalog.sql
-- 模型权威批次 · 切片 1(DB 层)。方案:docs/V5_MODEL_AUTHORITY_PLAN.md §1。
--
-- 建立「模型可执行性(execution authority)」的单一权威:
--   model_catalog        版本化 catalog(engine/provider/upstream/context/capability + 状态机)
--   model_aliases        alias → catalog 行(只可指向 staged/active)
--   model_security_epoch 单行单调递增 epoch(安全敏感写自动 bump,消费侧 fence)
--   usage_records +4 列  计费行留证(execution/projection revision + epoch + authority kind)
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠ 与方案 R3-M9 的**机制**偏差(语义零偏差,已实测定性,见下)
--
-- 方案 R3-M9 写的是「model_pricing.enabled 退役为可更新兼容视图 + INSTEAD OF trigger」,
-- 目的(方案原文)= **覆盖旧 master 回滚后的写路径**,即「既有代码的所有读写 SQL 不改也能跑」
-- —— 这是不可逆兼容地板(§7 步 1「回滚 = master 回滚(读写均经视图兼容)」)。
--
-- 实测结论(PG 16.14):**视图机制无法达成它自己的目标**。PostgreSQL 不支持在视图上使用
-- `INSERT ... ON CONFLICT`(带 INSTEAD OF trigger 也不行):
--     ERROR: there is no unique or exclusion constraint matching the ON CONFLICT specification
-- 而既有代码路径**确实**在 model_pricing 上用 ON CONFLICT:
--     · packages/commercial/src/__tests__/adminPricing.integ.test.ts(INSERT ... ON CONFLICT DO UPDATE)
--     · 历史 seed 迁移 0007/0077/0082/0083/0102/0103(未来同类 seed 亦然)
-- 视图化 = 这些写路径全部 SQL 层报错 = 兼容地板塌陷(且 RULE 方案更糟:带 rule 的表连
-- ON CONFLICT 都直接被 PG 拒)。
--
-- 因此本迁移改用**等价语义、不同机制**:
--   · model_pricing **保持基表**(不改名、不建视图)→ 既有 SQL(ON CONFLICT / FOR UPDATE /
--     RETURNING / FK / TRUNCATE CASCADE)逐字节照跑,兼容地板是"同一张表"这种最强形式;
--   · `model_pricing.enabled` **退役为 DB 维护的派生镜像列**,不再是权威:
--       读:任何时刻恒等于 (存在 state='active' 的 catalog 行) —— 由 catalog AFTER trigger
--           同步维护;v5 运行时(pricing.ts / modelCatalog.ts)**不信任镜像**,直接 JOIN
--           catalog 派生,镜像只服务于旧 master 回滚 + admin 展示 + 外部 SQL;
--       写:BEFORE INSERT/UPDATE trigger **拦截并路由**到 catalog 状态机
--           (fn_model_catalog_apply_enabled),然后把 NEW.enabled 归一为权威后态。
--           → 旧 master 的 `UPDATE model_pricing SET enabled=$1` 语义不变(仍然生效),
--             但真正落地的是 catalog 状态转移,不存在第二权威源。
--   · 唯一失去的是"视图天然不可能不一致"的物理保证;代之以:双向 trigger 全覆盖行级写路径
--     + modelCatalogDb.integ.test.ts 的不变量断言 + 运行时不读镜像。
--
-- 稳态后移除兼容层(方案登记的债)时,本机制的退役动作 = 删两个 trigger + DROP COLUMN enabled,
-- 比"拆视图改回基表"更简单。
-- ─────────────────────────────────────────────────────────────────────────────
--
-- 回填 = protocol 常量的**一致性锚**(方案 §7 步 1)。派生规则逐条镜像:
--   packages/protocol/src/staticKeyProviders.ts(matchesRoute / supportsVision /
--     stripBodyFields / allowedOutputConfigEfforts / maxInputTokens)
--   packages/protocol/src/engineModels.ts(CODEX_ENGINE_MODELS / modelReasoningPolicy)
--   claude-code-best/src/utils/model/staticKeyModels.ts(STATIC_MODEL_CONTEXT_WINDOW)
--   claude-code-best/src/utils/context.ts(MODEL_CONTEXT_WINDOW_DEFAULT = 200_000)
-- 等价性由 modelCatalogDb.integ.test.ts 对**每个 model id 逐一**断言(DB 函数 vs protocol TS)。
-- 派生函数(fn_model_catalog_engine/provider/context_window/capability)是"当前时刻的快照",
-- 不是新的权威源:catalog 行一旦落库,权威就是行本身;派生函数只用于回填 + 旧 INSERT 兼容路径。
--
-- 运维注:v5 AUTO_MIGRATE=0,须在受控窗口人工 apply(同 0104-0134 惯例)。
-- 本迁移全部为新建对象 + 加列 + 加 trigger,不重写既有表数据(仅 backfill 新表)。

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. 表
-- ═══════════════════════════════════════════════════════════════════════════

-- 版本化 catalog。engine 变更 = 旧行 disable→retired + 新行同 model_id 重新 staged→active
-- (fn_model_switch_version 单事务执行),旧版本保留审计。
CREATE TABLE model_catalog (
  entry_id                  BIGSERIAL PRIMARY KEY,
  model_id                  TEXT    NOT NULL CHECK (char_length(model_id) BETWEEN 1 AND 64),
  engine                    TEXT    NOT NULL CHECK (engine IN ('ccb', 'codex')),
  -- 服务端 provider 机制 id。**故意不加 DB 侧枚举 CHECK**:provider 机制集的单一权威 =
  -- protocol STATIC_KEY_PROVIDERS + 虚拟条目(codex / anthropic OAuth 池),DB 再抄一份枚举
  -- 就会变成第二权威源(新增 provider 要改迁移)。合法性由应用层(modelCatalog.ts 加载校验
  -- + admin 写入校验)fail-closed 把关 —— 与 0105 provider_ops「不建 provider 清单」同口径。
  provider_id               TEXT    CHECK (provider_id IS NULL OR char_length(provider_id) <= 32),
  upstream_model_id         TEXT    CHECK (upstream_model_id IS NULL OR char_length(upstream_model_id) <= 128),
  context_window            INTEGER CHECK (context_window IS NULL OR context_window > 0),
  capability_profile        JSONB   NOT NULL CHECK (jsonb_typeof(capability_profile) = 'object'),
  capability_schema_version INTEGER NOT NULL DEFAULT 1 CHECK (capability_schema_version >= 1),
  state                     TEXT    NOT NULL CHECK (state IN ('staged', 'active', 'disabled', 'retired')),
  lock_version              INTEGER NOT NULL DEFAULT 0,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- 审计列。**故意不挂 users(id) FK**:catalog 是安全权威表,不能被 users 的
  -- DELETE/TRUNCATE CASCADE 级联清空(model_pricing.updated_by 的 FK 就有这个耦合 ——
  -- TRUNCATE users CASCADE 会顺带清空 model_pricing,见 adminPricing.integ)。
  updated_by                BIGINT,
  CONSTRAINT model_catalog_ccb_needs_provider
    CHECK (engine <> 'ccb' OR provider_id IS NOT NULL)
);

-- 同一 model_id 在 (staged ∪ active) 中至多一行 —— "当前有效版本"唯一。
-- disabled/retired 历史行不受限(版本切换保留审计)。
CREATE UNIQUE INDEX uq_model_catalog_live ON model_catalog (model_id)
  WHERE state IN ('staged', 'active');
CREATE INDEX idx_model_catalog_model_id ON model_catalog (model_id);
CREATE INDEX idx_model_catalog_active   ON model_catalog (model_id) WHERE state = 'active';

COMMENT ON TABLE  model_catalog IS
  '模型可执行性(engine/provider/execution descriptor)的单一权威。可用性 = state=active;'
  'model_pricing.enabled 是本表的派生镜像,不是权威(0135)。';
COMMENT ON COLUMN model_catalog.state IS
  '状态机:staged→active→disabled→{active|retired};retired 单向终态。active 行 execution 字段不可变。';

-- alias → catalog 行。只可指向 staged/active(写入时 trigger 校验)。
-- ON DELETE CASCADE:catalog 行被物理删除(仅兼容路径 DELETE FROM model_pricing 会触发)时
-- alias 无意义,随之消失;正常退役路径是 retire,而 retire 被 alias 引用时**禁止**(见 guard)。
CREATE TABLE model_aliases (
  alias      TEXT PRIMARY KEY CHECK (char_length(alias) BETWEEN 1 AND 128),
  entry_id   BIGINT NOT NULL REFERENCES model_catalog(entry_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by BIGINT
);
CREATE INDEX idx_model_aliases_entry ON model_aliases (entry_id);

-- 单行表。安全敏感写(state 离开 active / execution 字段 / 价格 / visibility /
-- default_effort / alias 变更)自动 bump;master 与 egress 两进程各自 fence。
CREATE TABLE model_security_epoch (
  id         BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  epoch      BIGINT      NOT NULL DEFAULT 1 CHECK (epoch >= 1),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO model_security_epoch (id) VALUES (TRUE);

-- 计费行留证(方案 §4 / R3-m11)。不适用置 NULL。
ALTER TABLE usage_records
  ADD COLUMN execution_revision  TEXT,
  ADD COLUMN projection_revision TEXT,
  ADD COLUMN security_epoch      BIGINT,
  ADD COLUMN authority_kind      TEXT
    CHECK (authority_kind IS NULL OR authority_kind IN ('bridge_signed', 'local_catalog'));

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. epoch bump(事务内幂等)
-- ═══════════════════════════════════════════════════════════════════════════

-- 一个事务最多 bump 一次(tx-local GUC 守卫):批量 admin 写不会把 epoch 抬高 N 次。
-- epoch 语义是 fence(消费侧只做相等比较),不是变更计数器。
CREATE OR REPLACE FUNCTION fn_model_security_epoch_bump() RETURNS BIGINT AS $$
DECLARE v_epoch BIGINT;
BEGIN
  IF current_setting('openclaude.epoch_bumped', true) IS NOT DISTINCT FROM '1' THEN
    SELECT epoch INTO v_epoch FROM model_security_epoch WHERE id;
    RETURN v_epoch;
  END IF;

  UPDATE model_security_epoch
     SET epoch = epoch + 1, updated_at = NOW()
   WHERE id
  RETURNING epoch INTO v_epoch;

  PERFORM set_config('openclaude.epoch_bumped', '1', true);
  -- egress/master 收到 epoch NOTIFY → 先标 unknown → 重建;重建成功前拒新请求(R3-B1)。
  PERFORM pg_notify('model_security_epoch', v_epoch::text);
  PERFORM pg_notify('model_catalog_changed', '');
  -- 旧 PricingCache(以及回滚后的旧 master)靠 0008 的 pricing_changed 重载 enabled 镜像。
  PERFORM pg_notify('pricing_changed', '');
  RETURN v_epoch;
END $$ LANGUAGE plpgsql;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. protocol 常量派生(回填锚 + 旧 INSERT 兼容路径;非权威源)
-- ═══════════════════════════════════════════════════════════════════════════

-- engine:精确字面量,与 protocol isCodexEngineModel(CODEX_ENGINE_MODEL_IDS)逐字节一致
-- (**不是** gpt- 前缀判定 —— 前缀会把白名单外的 gpt-xxx 误分类,破坏 master/容器判定同构)。
CREATE OR REPLACE FUNCTION fn_model_catalog_engine(p_model_id TEXT) RETURNS TEXT AS $$
  SELECT CASE
    WHEN p_model_id IN ('gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna') THEN 'codex'
    ELSE 'ccb'
  END
$$ LANGUAGE sql IMMUTABLE;

-- provider:镜像 protocol findRouteProviderForModel(matchesRoute 的大小写口径逐条保留)。
--   deepseek: **大小写敏感前缀家族**;minimax/ark/opencodego/kimi: lower() 精确匹配。
-- 虚拟条目:codex(OAuth ChatGPT 池 + 容器 loopback relay,= admin/modelOps CODEX_PROVIDER_ID)、
--          anthropic(OAuth Claude 账号池 —— 无静态 key provider 的 CCB 模型走这条老路,
--          当前全部 disabled:claude-* 已随 d9c47c18 下线;未知 model 亦落此项 = 现状语义)。
CREATE OR REPLACE FUNCTION fn_model_catalog_provider(p_model_id TEXT) RETURNS TEXT AS $$
  SELECT CASE
    WHEN p_model_id IN ('gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna')   THEN 'codex'
    WHEN p_model_id LIKE 'deepseek-%'                                     THEN 'deepseek'
    WHEN lower(p_model_id) = 'minimax-m3'                                 THEN 'minimax'
    WHEN lower(p_model_id) IN ('glm-5.1', 'glm-5.2')                      THEN 'ark'
    WHEN lower(p_model_id) IN ('qwen3.7-max', 'qwen3.7-plus')             THEN 'opencodego'
    WHEN lower(p_model_id) = 'kimi-k2.7-code'                             THEN 'kimi'
    ELSE 'anthropic'
  END
$$ LANGUAGE sql IMMUTABLE;

-- context_window:CCB STATIC_MODEL_CONTEXT_WINDOW 特判表 + MODEL_CONTEXT_WINDOW_DEFAULT(200k)。
-- **不是** protocol 的 maxInputTokens(那是 master proxy 的 input guard,provider 级单值;
-- 这里是 per-model auto-compact 窗口,glm-5.1=200k / glm-5.2=1M 必须分开)。
-- codex:NULL —— codex CLI 自管上下文窗口,平台无该常量,不臆造。
CREATE OR REPLACE FUNCTION fn_model_catalog_context_window(p_model_id TEXT) RETURNS INTEGER AS $$
  SELECT CASE
    WHEN p_model_id IN ('gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna')   THEN NULL
    WHEN lower(btrim(p_model_id)) = 'minimax-m3'                          THEN 512000
    WHEN lower(btrim(p_model_id)) = 'glm-5.2'                             THEN 1000000
    WHEN lower(btrim(p_model_id)) = 'glm-5.1'                             THEN 200000
    WHEN lower(btrim(p_model_id)) IN ('qwen3.7-max', 'qwen3.7-plus')      THEN 1000000
    WHEN lower(btrim(p_model_id)) = 'kimi-k2.7-code'                      THEN 256000
    ELSE 200000
  END
$$ LANGUAGE sql IMMUTABLE;

-- capability_profile:protocol modelReasoningPolicy(p_model_id) + supportsVision 的**当前值**。
--   supports_vision = findRouteProviderForModel(id)?.supportsVision ?? false
--                     (仅 minimax=true;codex/claude 无该 protocol 常量 → false,与现状 strip 口径一致)
--   reasoning.supported:
--     codex            → 平台五档 + codex_model_default(Sol/Terra=xhigh, Luna=medium)
--     ark(glm)         → allowedOutputConfigEfforts ∩ 平台枚举 = ['high','max']
--     minimax/opencodego/kimi → stripBodyFields 含 output_config ⇒ 不支持思考档位 = []
--     deepseek / 其余 CCB     → 平台五档(无 strip、无白名单)
CREATE OR REPLACE FUNCTION fn_model_catalog_capability(p_model_id TEXT) RETURNS JSONB AS $$
  SELECT CASE
    WHEN p_model_id IN ('gpt-5.6-sol', 'gpt-5.6-terra') THEN
      '{"supports_vision": false, "reasoning": {"supported": ["low","medium","high","xhigh","max"], "codex_model_default": "xhigh"}}'::jsonb
    WHEN p_model_id = 'gpt-5.6-luna' THEN
      '{"supports_vision": false, "reasoning": {"supported": ["low","medium","high","xhigh","max"], "codex_model_default": "medium"}}'::jsonb
    WHEN lower(p_model_id) = 'minimax-m3' THEN
      '{"supports_vision": true, "reasoning": {"supported": [], "codex_model_default": null}}'::jsonb
    WHEN lower(p_model_id) IN ('glm-5.1', 'glm-5.2') THEN
      '{"supports_vision": false, "reasoning": {"supported": ["high","max"], "codex_model_default": null}}'::jsonb
    WHEN lower(p_model_id) IN ('qwen3.7-max', 'qwen3.7-plus', 'kimi-k2.7-code') THEN
      '{"supports_vision": false, "reasoning": {"supported": [], "codex_model_default": null}}'::jsonb
    ELSE
      '{"supports_vision": false, "reasoning": {"supported": ["low","medium","high","xhigh","max"], "codex_model_default": null}}'::jsonb
  END
$$ LANGUAGE sql IMMUTABLE;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. 状态机 guard(方案 §1.1 全条款,DB 强制)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION fn_model_catalog_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- 新行不能生于终态。staged(常规)/active(回填 + 旧 INSERT 兼容路径)/disabled 均可。
    IF NEW.state = 'retired' THEN
      RAISE EXCEPTION 'model_catalog: cannot insert entry directly in retired state (model %)', NEW.model_id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF NEW.entry_id IS DISTINCT FROM OLD.entry_id THEN
    RAISE EXCEPTION 'model_catalog: entry_id is immutable' USING ERRCODE = 'check_violation';
  END IF;

  -- retired 单向终态:任何修改都拒(含 updated_by/审计列)。
  IF OLD.state = 'retired' THEN
    RAISE EXCEPTION 'model_catalog: retired entry % (model %) is immutable', OLD.entry_id, OLD.model_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NOT (
         (OLD.state = 'staged'   AND NEW.state = 'active')
      OR (OLD.state = 'active'   AND NEW.state = 'disabled')
      OR (OLD.state = 'disabled' AND NEW.state IN ('active', 'retired'))
    ) THEN
      RAISE EXCEPTION 'model_catalog: illegal state transition %→% (entry %, model %)',
        OLD.state, NEW.state, OLD.entry_id, OLD.model_id USING ERRCODE = 'check_violation';
    END IF;

    -- 被 alias 引用的行禁止退休(R2-m14):先把 alias 重指到新版本(fn_model_switch_version)。
    IF NEW.state = 'retired' AND EXISTS (SELECT 1 FROM model_aliases a WHERE a.entry_id = OLD.entry_id) THEN
      RAISE EXCEPTION 'model_catalog: entry % (model %) is referenced by alias(es); repoint them before retiring',
        OLD.entry_id, OLD.model_id USING ERRCODE = 'foreign_key_violation';
    END IF;
  END IF;

  -- active 行**全部 execution 字段**不可变(R3-B3):任何 execution descriptor 组成字段的
  -- 变化(含放宽)都必须走版本状态机 → 产生新 entry + 新 executionRevision。
  IF OLD.state = 'active' AND (
       NEW.model_id                  IS DISTINCT FROM OLD.model_id
    OR NEW.engine                    IS DISTINCT FROM OLD.engine
    OR NEW.provider_id               IS DISTINCT FROM OLD.provider_id
    OR NEW.upstream_model_id         IS DISTINCT FROM OLD.upstream_model_id
    OR NEW.context_window            IS DISTINCT FROM OLD.context_window
    OR NEW.capability_profile        IS DISTINCT FROM OLD.capability_profile
    OR NEW.capability_schema_version IS DISTINCT FROM OLD.capability_schema_version
  ) THEN
    RAISE EXCEPTION 'model_catalog: execution fields of an ACTIVE entry are immutable (entry %, model %); use fn_model_switch_version()',
      OLD.entry_id, OLD.model_id USING ERRCODE = 'check_violation';
  END IF;

  NEW.lock_version := OLD.lock_version + 1;
  NEW.updated_at   := NOW();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_model_catalog_guard
  BEFORE INSERT OR UPDATE ON model_catalog
  FOR EACH ROW EXECUTE FUNCTION fn_model_catalog_guard();

-- ─── enabled 镜像同步(catalog → model_pricing) ───────────────────────────
-- 权威 → 镜像的唯一写入口。用 tx-local GUC 标记,让 model_pricing 的 BEFORE trigger
-- 认出"这是同步写、不是用户写",直接放行(否则会再路由回 catalog → 无限递归)。
CREATE OR REPLACE FUNCTION fn_model_pricing_sync_enabled(p_model_id TEXT) RETURNS VOID AS $$
DECLARE v_active BOOLEAN;
BEGIN
  v_active := EXISTS (SELECT 1 FROM model_catalog c WHERE c.model_id = p_model_id AND c.state = 'active');
  PERFORM set_config('openclaude.catalog_sync', '1', true);
  UPDATE model_pricing
     SET enabled = v_active
   WHERE model_id = p_model_id
     AND enabled IS DISTINCT FROM v_active;
  PERFORM set_config('openclaude.catalog_sync', '0', true);
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fn_model_catalog_after() RETURNS trigger AS $$
DECLARE v_sensitive BOOLEAN := FALSE;
BEGIN
  IF TG_OP IN ('INSERT', 'DELETE') THEN
    v_sensitive := TRUE;
  ELSE
    v_sensitive :=
         (NEW.state                     IS DISTINCT FROM OLD.state)
      OR (NEW.model_id                  IS DISTINCT FROM OLD.model_id)
      OR (NEW.engine                    IS DISTINCT FROM OLD.engine)
      OR (NEW.provider_id               IS DISTINCT FROM OLD.provider_id)
      OR (NEW.upstream_model_id         IS DISTINCT FROM OLD.upstream_model_id)
      OR (NEW.context_window            IS DISTINCT FROM OLD.context_window)
      OR (NEW.capability_profile        IS DISTINCT FROM OLD.capability_profile)
      OR (NEW.capability_schema_version IS DISTINCT FROM OLD.capability_schema_version);
  END IF;

  IF v_sensitive THEN
    PERFORM fn_model_security_epoch_bump();
  END IF;

  -- 镜像同步。若本次 catalog 写就是由 model_pricing 的 enabled 路由触发的,则跳过 ——
  -- 外层 BEFORE trigger 会自己把 NEW.enabled 归一为权威后态(避免自更新同一行)。
  IF current_setting('openclaude.pricing_route', true) IS DISTINCT FROM '1' THEN
    IF TG_OP = 'DELETE' THEN
      PERFORM fn_model_pricing_sync_enabled(OLD.model_id);
    ELSE
      PERFORM fn_model_pricing_sync_enabled(NEW.model_id);
      IF TG_OP = 'UPDATE' AND NEW.model_id IS DISTINCT FROM OLD.model_id THEN
        PERFORM fn_model_pricing_sync_enabled(OLD.model_id);
      END IF;
    END IF;
  END IF;

  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_model_catalog_after
  AFTER INSERT OR UPDATE OR DELETE ON model_catalog
  FOR EACH ROW EXECUTE FUNCTION fn_model_catalog_after();

-- ─── alias guard ─────────────────────────────────────────────────────────
-- alias 只可**写入**指向 staged/active 行(R2-M8)。注意:active 行被 disable 后,
-- 指向它的 alias 保留(alias 随模型一起不可路由,消费侧 isRoutable=false fail-closed)——
-- 否则"禁用一个有 alias 的模型"就得先删 alias,与 §8 的 disable E2E 冲突。
-- 真正的硬约束是:**被 alias 引用的行不可 retire**(见 fn_model_catalog_guard)。
CREATE OR REPLACE FUNCTION fn_model_aliases_guard() RETURNS trigger AS $$
DECLARE v_state TEXT; v_model TEXT;
BEGIN
  SELECT c.state, c.model_id INTO v_state, v_model FROM model_catalog c WHERE c.entry_id = NEW.entry_id;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'model_aliases: target entry % does not exist', NEW.entry_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF v_state NOT IN ('staged', 'active') THEN
    RAISE EXCEPTION 'model_aliases: alias % may only point at a staged/active entry (entry % is %, model %)',
      NEW.alias, NEW.entry_id, v_state, v_model USING ERRCODE = 'check_violation';
  END IF;
  -- alias 不得与 canonical model_id 撞名(否则归一化有二义)。
  IF EXISTS (SELECT 1 FROM model_catalog c WHERE c.model_id = NEW.alias AND c.state IN ('staged', 'active')) THEN
    RAISE EXCEPTION 'model_aliases: alias % collides with a live canonical model_id', NEW.alias
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_model_aliases_guard
  BEFORE INSERT OR UPDATE ON model_aliases
  FOR EACH ROW EXECUTE FUNCTION fn_model_aliases_guard();

CREATE OR REPLACE FUNCTION fn_model_aliases_after() RETURNS trigger AS $$
BEGIN
  PERFORM fn_model_security_epoch_bump();
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_model_aliases_after
  AFTER INSERT OR UPDATE OR DELETE ON model_aliases
  FOR EACH ROW EXECUTE FUNCTION fn_model_aliases_after();

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. enabled 兼容层:model_pricing 写路由 → catalog 状态机
-- ═══════════════════════════════════════════════════════════════════════════

-- 旧 enabled 写的状态机映射(R3-M9 语义)。
--   "当前版本行" = (staged ∪ active) 中的唯一行(部分唯一索引保证);都没有时取最近的
--   disabled 行(entry_id 最大)。retired 行永不参与。
--   TRUE  : staged→active / disabled→active / active→no-op
--   FALSE : active→disabled / staged·disabled→no-op(本就不可路由)
CREATE OR REPLACE FUNCTION fn_model_catalog_apply_enabled(
  p_model_id   TEXT,
  p_enabled    BOOLEAN,
  p_updated_by BIGINT
) RETURNS VOID AS $$
DECLARE v_entry BIGINT; v_state TEXT;
BEGIN
  SELECT c.entry_id, c.state INTO v_entry, v_state
    FROM model_catalog c
   WHERE c.model_id = p_model_id
     AND c.state IN ('staged', 'active', 'disabled')
   ORDER BY (c.state = 'active') DESC, (c.state = 'staged') DESC, c.entry_id DESC
   LIMIT 1
     FOR UPDATE;

  IF v_entry IS NULL THEN
    RAISE EXCEPTION 'model_catalog: no live entry for model % (stage it first)', p_model_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF p_enabled AND v_state <> 'active' THEN
    UPDATE model_catalog SET state = 'active', updated_by = COALESCE(p_updated_by, updated_by)
     WHERE entry_id = v_entry;
  ELSIF NOT p_enabled AND v_state = 'active' THEN
    UPDATE model_catalog SET state = 'disabled', updated_by = COALESCE(p_updated_by, updated_by)
     WHERE entry_id = v_entry;
  END IF;
END $$ LANGUAGE plpgsql;

-- model_pricing INSERT 兼容路径:catalog 行不存在 → 按 protocol 派生建行(state 由 enabled 决定)。
-- 这是**兼容/回滚地板**,不是新模型的正常上线路径(正常路径 = admin staged 流程,切片 3)。
CREATE OR REPLACE FUNCTION fn_model_catalog_ensure_for_pricing(
  p_model_id   TEXT,
  p_enabled    BOOLEAN,
  p_updated_by BIGINT
) RETURNS VOID AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM model_catalog c
     WHERE c.model_id = p_model_id AND c.state IN ('staged', 'active', 'disabled')
  ) THEN
    PERFORM fn_model_catalog_apply_enabled(p_model_id, p_enabled, p_updated_by);
    RETURN;
  END IF;

  INSERT INTO model_catalog (
    model_id, engine, provider_id, upstream_model_id, context_window,
    capability_profile, capability_schema_version, state, updated_by
  ) VALUES (
    p_model_id,
    fn_model_catalog_engine(p_model_id),
    fn_model_catalog_provider(p_model_id),
    NULL,
    fn_model_catalog_context_window(p_model_id),
    fn_model_catalog_capability(p_model_id),
    1,
    CASE WHEN p_enabled THEN 'active' ELSE 'disabled' END,
    p_updated_by
  );
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fn_model_pricing_enabled_route() RETURNS trigger AS $$
BEGIN
  -- 来自 catalog 镜像同步的写:直接放行(否则递归)。
  IF current_setting('openclaude.catalog_sync', true) IS NOT DISTINCT FROM '1' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.model_id IS DISTINCT FROM OLD.model_id THEN
    RAISE EXCEPTION 'model_pricing: model_id is immutable (catalog is the authority; use fn_model_switch_version)'
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM set_config('openclaude.pricing_route', '1', true);
  IF TG_OP = 'INSERT' THEN
    PERFORM fn_model_catalog_ensure_for_pricing(NEW.model_id, COALESCE(NEW.enabled, TRUE), NEW.updated_by);
  ELSIF NEW.enabled IS DISTINCT FROM OLD.enabled THEN
    PERFORM fn_model_catalog_apply_enabled(NEW.model_id, NEW.enabled, NEW.updated_by);
  END IF;
  PERFORM set_config('openclaude.pricing_route', '0', true);

  -- 镜像列恒等于权威后态(即使调用方写了别的值)。
  NEW.enabled := EXISTS (
    SELECT 1 FROM model_catalog c WHERE c.model_id = NEW.model_id AND c.state = 'active'
  );
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_model_pricing_enabled_route
  BEFORE INSERT OR UPDATE ON model_pricing
  FOR EACH ROW EXECUTE FUNCTION fn_model_pricing_enabled_route();

-- model_pricing 上的**安全/计费敏感**变更 → bump epoch(方案 §1.1)。
--   价格四列 + multiplier(计费)、visibility(授权投影)、default_effort(execution descriptor)。
--   display_name / sort_order / extra_system_prompt 是展示/spawn 面,不 bump(不打断在途 turn)。
--   enabled 的状态机映射由 catalog trigger 自己 bump,这里不重复(同事务只会 bump 一次)。
CREATE OR REPLACE FUNCTION fn_model_pricing_security_after() RETURNS trigger AS $$
BEGIN
  IF current_setting('openclaude.catalog_sync', true) IS NOT DISTINCT FROM '1' THEN
    RETURN NULL;  -- 镜像同步写不是安全事件
  END IF;

  IF TG_OP IN ('INSERT', 'DELETE') THEN
    PERFORM fn_model_security_epoch_bump();
    RETURN NULL;
  END IF;

  IF NEW.input_per_mtok       IS DISTINCT FROM OLD.input_per_mtok
  OR NEW.output_per_mtok      IS DISTINCT FROM OLD.output_per_mtok
  OR NEW.cache_read_per_mtok  IS DISTINCT FROM OLD.cache_read_per_mtok
  OR NEW.cache_write_per_mtok IS DISTINCT FROM OLD.cache_write_per_mtok
  OR NEW.multiplier           IS DISTINCT FROM OLD.multiplier
  OR NEW.visibility           IS DISTINCT FROM OLD.visibility
  OR NEW.default_effort       IS DISTINCT FROM OLD.default_effort THEN
    PERFORM fn_model_security_epoch_bump();
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_model_pricing_security_after
  AFTER INSERT OR UPDATE OR DELETE ON model_pricing
  FOR EACH ROW EXECUTE FUNCTION fn_model_pricing_security_after();

-- model_pricing 行被物理删除 → catalog 行随之删除(保持 DB 自洽,不留"有 catalog 无价"的
-- 孤儿 active 行)。DELETE FROM model_pricing 不是生产路径(admin 无该端点),仅存在于
-- 测试 fixture / 手工运维;epoch 由上面的 security_after bump。
CREATE OR REPLACE FUNCTION fn_model_pricing_delete_cascade() RETURNS trigger AS $$
BEGIN
  IF current_setting('openclaude.catalog_sync', true) IS NOT DISTINCT FROM '1' THEN
    RETURN OLD;
  END IF;
  PERFORM set_config('openclaude.pricing_route', '1', true);
  DELETE FROM model_catalog WHERE model_id = OLD.model_id;
  PERFORM set_config('openclaude.pricing_route', '0', true);
  RETURN OLD;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_model_pricing_delete_cascade
  BEFORE DELETE ON model_pricing
  FOR EACH ROW EXECUTE FUNCTION fn_model_pricing_delete_cascade();

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. 版本切换存储过程(R3-M8):单事务,中间态对外恒 fail-closed
-- ═══════════════════════════════════════════════════════════════════════════
-- 旧 active→disabled → 建新 staged → aliases 重指新行 → 旧→retired → 新→active。
-- 旧行本就 disabled(模型当前不可用)→ 新行停在 staged(不擅自开启可用性),
-- 后续 admin 显式 activate 即 staged→active。
-- 返回新 entry_id。禁止多请求手工拼装(中间态会短暂 fail-closed 拒服务)。
CREATE OR REPLACE FUNCTION fn_model_switch_version(
  p_model_id                  TEXT,
  p_engine                    TEXT,
  p_provider_id               TEXT,
  p_upstream_model_id         TEXT,
  p_context_window            INTEGER,
  p_capability_profile        JSONB,
  p_capability_schema_version INTEGER,
  p_updated_by                BIGINT
) RETURNS BIGINT AS $$
DECLARE
  v_old_entry BIGINT;
  v_old_state TEXT;
  v_new_entry BIGINT;
BEGIN
  SELECT c.entry_id, c.state INTO v_old_entry, v_old_state
    FROM model_catalog c
   WHERE c.model_id = p_model_id
     AND c.state IN ('staged', 'active', 'disabled')
   ORDER BY (c.state = 'active') DESC, (c.state = 'staged') DESC, c.entry_id DESC
   LIMIT 1
     FOR UPDATE;

  IF v_old_entry IS NULL THEN
    RAISE EXCEPTION 'fn_model_switch_version: no live entry for model %', p_model_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF v_old_state = 'staged' THEN
    RAISE EXCEPTION 'fn_model_switch_version: model % already has a pending staged version (entry %); activate or drop it first',
      p_model_id, v_old_entry USING ERRCODE = 'check_violation';
  END IF;

  -- ① 旧 active → disabled(腾出部分唯一索引的位置)
  IF v_old_state = 'active' THEN
    UPDATE model_catalog SET state = 'disabled', updated_by = COALESCE(p_updated_by, updated_by)
     WHERE entry_id = v_old_entry;
  END IF;

  -- ② 新行 staged
  INSERT INTO model_catalog (
    model_id, engine, provider_id, upstream_model_id, context_window,
    capability_profile, capability_schema_version, state, updated_by
  ) VALUES (
    p_model_id, p_engine, p_provider_id, p_upstream_model_id, p_context_window,
    p_capability_profile, COALESCE(p_capability_schema_version, 1), 'staged', p_updated_by
  ) RETURNING entry_id INTO v_new_entry;

  -- ③ aliases 重指新行(staged 目标合法)
  UPDATE model_aliases SET entry_id = v_new_entry, updated_by = COALESCE(p_updated_by, updated_by)
   WHERE entry_id = v_old_entry;

  -- ④ 旧行 → retired(此时已无 alias 引用)
  UPDATE model_catalog SET state = 'retired', updated_by = COALESCE(p_updated_by, updated_by)
   WHERE entry_id = v_old_entry;

  -- ⑤ 新行 → active(仅当旧行原本是 active:版本切换不改变"模型是否可用")
  IF v_old_state = 'active' THEN
    UPDATE model_catalog SET state = 'active' WHERE entry_id = v_new_entry;
  END IF;

  RETURN v_new_entry;
END $$ LANGUAGE plpgsql;

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. 回填(= protocol 常量的一致性锚)
-- ═══════════════════════════════════════════════════════════════════════════
-- state: model_pricing.enabled=TRUE → 'active';否则 'disabled'。
-- 上面的 trigger 已装:回填 INSERT 会被 guard 校验(active 行合法性)、会触发镜像同步
-- (值本就一致 → 0 行更新)、会 bump 一次 epoch(事务内幂等)。
INSERT INTO model_catalog (
  model_id, engine, provider_id, upstream_model_id, context_window,
  capability_profile, capability_schema_version, state, updated_by
)
SELECT
  p.model_id,
  fn_model_catalog_engine(p.model_id),
  fn_model_catalog_provider(p.model_id),
  NULL,
  fn_model_catalog_context_window(p.model_id),
  fn_model_catalog_capability(p.model_id),
  1,
  CASE WHEN p.enabled THEN 'active' ELSE 'disabled' END,
  NULL
FROM model_pricing p;

-- 回填自检:每一条 pricing 行都有且只有一条 live catalog 行,且 enabled 与 state 等价。
DO $$
DECLARE v_missing INT; v_drift INT;
BEGIN
  SELECT COUNT(*) INTO v_missing
    FROM model_pricing p
   WHERE NOT EXISTS (
     SELECT 1 FROM model_catalog c
      WHERE c.model_id = p.model_id AND c.state IN ('staged', 'active', 'disabled')
   );
  IF v_missing <> 0 THEN
    RAISE EXCEPTION '0135: % model_pricing row(s) without a live catalog entry', v_missing;
  END IF;

  SELECT COUNT(*) INTO v_drift
    FROM model_pricing p
   WHERE p.enabled IS DISTINCT FROM EXISTS (
     SELECT 1 FROM model_catalog c WHERE c.model_id = p.model_id AND c.state = 'active'
   );
  IF v_drift <> 0 THEN
    RAISE EXCEPTION '0135: % model_pricing row(s) drift from catalog state', v_drift;
  END IF;
END $$;

-- 回填期间的 epoch bump 归零:全新 catalog 的基线 epoch = 1。
UPDATE model_security_epoch SET epoch = 1, updated_at = NOW() WHERE id;
