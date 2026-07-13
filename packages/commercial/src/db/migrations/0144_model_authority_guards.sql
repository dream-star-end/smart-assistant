-- 0144_model_authority_guards.sql
-- 模型权威批次 · 切片 1 加固(Codex 代码审 R1:BLOCKER-1 + MAJOR-1)。
-- 方案:docs/V5_MODEL_AUTHORITY_PLAN.md §1.1(「状态机与 epoch 由 DB 强制 …… 应用账号仅经
-- 存储过程/受限权限写」)+ §1.2(grant 撤销 = 安全收窄 → bump epoch → 消费侧 fence)。
--
-- 为什么是补丁迁移而不是改 0143:0143 可能已在别处(预发/他人库)apply,改历史迁移会让
-- 「已 applied 的 version」与文件内容漂移(migrate.ts 的完整性校验只查文件存在,不查 hash,
-- 静默漂移更危险)。本文件用 CREATE OR REPLACE FUNCTION + DROP/CREATE TRIGGER 原地收紧,
-- 0143 的对象名/签名全部保持不变。
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 修的两个洞
--
-- ① BLOCKER-1:grant 撤销不 bump epoch → codex 授权 stale window。
--    0143 只给 catalog/alias/pricing 挂了 epoch trigger,`model_visibility_grants` 没有。
--    撤权后:CCB 走 egress 每请求授权 → 兜得住;**codex 不经 /v1/messages egress** →
--    bridge 只有 30s 周期 refresh、且刷新失败永久保留旧 checker → 旧连接继续签票执行。
--    修:grants 表 INSERT/UPDATE/DELETE 全部 bump epoch(+NOTIFY),让 master/egress/bridge
--    的 epoch fence 成为撤权的**同步**传播通道。bridge 侧的联动见 ws/userChatBridge.ts
--    (checker 记加载时 epoch;每 turn fence 后漂移 → 同步重载,重载失败拒帧)。
--
--    为什么 INSERT(授权 = 放宽)也 bump:
--      · epoch 是 **fence**(相等比较)不是变更计数器,多 bump 一次无语义代价;
--      · 「哪些 grant 变更算收窄」需要逐 case 分析(UPDATE 改 user_id/model_id 就是对原
--        用户的收窄)—— 分类逻辑本身就是缺口来源。统一 bump = 一条不需要证明的不变量;
--      · 附带收益:新授权对**已开连接**即时生效(原来要等 ≤30s 周期 refresh)。
--    代价:每次 grant 写会让 master/egress 快照进入一次极短 unknown 窗口。已由
--    ModelCatalogCache.assertFresh() 的「等在飞重建」改造吸收(不再直接拒帧)。
--
-- ② MAJOR-1:DB 状态机不是「不可绕边界」。
--    0143 的 guard 只覆盖 INSERT/UPDATE:直接 `INSERT ... state='active'` 合法、DELETE
--    完全不受约束(删 pricing 行会**物理删除 catalog 全部版本历史**)、TRUNCATE 不设防、
--    epoch 可被任意 UPDATE 回退(= fence 直接失效)。
--    修(两层,内层无条件、外层需割接):
--      内层 = **trigger 层(本迁移即刻生效,对 owner 也生效)**
--        · INSERT:**只能生于 staged**(active/disabled/retired 一律拒)—— 每一行的
--          可执行性都必须由状态机赋予,没有「出生即可执行」的旁路。兼容路径
--          (INSERT INTO model_pricing)改为 staged → activate 两步,语义不变。
--        · UPDATE:execution 字段**只有 staged 行可改**(0143 只冻结 active 行 → disabled
--          行可被原地改写 engine/provider 再 activate,同一 entry_id 的历史被篡改,
--          usage_records 的 execution_revision 无法回溯)。
--        · DELETE:**只允许 staged 行**(从未可执行 → 无审计价值)。active/disabled/retired
--          一律拒 → catalog 历史 append-only。
--        · TRUNCATE:catalog/aliases/epoch 三表一律拒(TRUNCATE 不触发行级 trigger,
--          必须用 statement 级 trigger 补)。
--        · epoch:只能 +1 单调递增(且只经 fn_model_security_epoch_bump),INSERT/DELETE 拒。
--          epoch 回退 = 让所有陈旧快照重新「通过」fence,是 fence 机制的直接旁路。
--      外层 = **角色权限层**(SECURITY DEFINER 存储过程 + 应用角色无表级 DML)
--        · 所有写入方(trigger 函数 + 状态机过程)改 SECURITY DEFINER,应用角色只需
--          SELECT + EXECUTE 即可完成全部合法操作;
--        · `fn_model_authority_grant_app_role(role)` = 「应用角色在本模块的权限策略」的
--          单一权威(SELECT + 受控过程 EXECUTE,零表级 DML)。
--        · **本迁移不自动对现网角色执行**:v5 现网 app 角色 == 迁移角色 == 表 owner
--          (runbook 用 DATABASE_URL 直接 psql apply),对 owner REVOKE 会把 owner 自己的
--          隐式授权撤掉、且 owner 随时可自行 re-GRANT —— 那不是边界,只会把既有迁移/
--          测试 fixture 打断。真正的边界需要一次**割接**:建低权 app 角色 → 调用本函数 →
--          换 DATABASE_URL。见文件尾「割接 runbook」。在此之前,不可绕边界 = 内层 trigger。
-- ─────────────────────────────────────────────────────────────────────────────
--
-- 运维注:v5 AUTO_MIGRATE=0,须在受控窗口人工 apply(同 0104-0143 惯例)。
-- 本迁移不改表数据(只换 trigger/函数 + 一个 FK 的 ON DELETE 动作)。

-- ═══════════════════════════════════════════════════════════════════════════
-- 0. 公共小工具
-- ═══════════════════════════════════════════════════════════════════════════

-- TRUNCATE 守卫(statement 级)。TRUNCATE 绕过全部行级 trigger,不补这一层的话
-- 「历史 append-only」是一句空话。
CREATE OR REPLACE FUNCTION fn_model_authority_no_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'model authority: TRUNCATE on % is forbidden (catalog history is append-only)', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_model_catalog_no_truncate
  BEFORE TRUNCATE ON model_catalog
  FOR EACH STATEMENT EXECUTE FUNCTION fn_model_authority_no_truncate();
CREATE TRIGGER trg_model_aliases_no_truncate
  BEFORE TRUNCATE ON model_aliases
  FOR EACH STATEMENT EXECUTE FUNCTION fn_model_authority_no_truncate();
CREATE TRIGGER trg_model_security_epoch_no_truncate
  BEFORE TRUNCATE ON model_security_epoch
  FOR EACH STATEMENT EXECUTE FUNCTION fn_model_authority_no_truncate();

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. epoch:单调 +1、单一写入口、不可删
-- ═══════════════════════════════════════════════════════════════════════════

-- epoch 是 fence 的**唯一**依据:任何回退都会让所有陈旧快照(master/egress/容器 LKG)
-- 重新通过 fence。因此 epoch 表只接受 fn_model_security_epoch_bump 的 +1 写。
CREATE OR REPLACE FUNCTION fn_model_security_epoch_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'model_security_epoch is a singleton (INSERT forbidden)'
      USING ERRCODE = 'check_violation';
  ELSIF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'model_security_epoch row is not deletable'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'model_security_epoch: id is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.epoch IS DISTINCT FROM OLD.epoch + 1 THEN
    RAISE EXCEPTION 'model_security_epoch: epoch must advance by exactly 1 (was %, got %); use fn_model_security_epoch_bump()',
      OLD.epoch, NEW.epoch USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_model_security_epoch_guard
  BEFORE INSERT OR UPDATE OR DELETE ON model_security_epoch
  FOR EACH ROW EXECUTE FUNCTION fn_model_security_epoch_guard();

-- bump 自身改 SECURITY DEFINER:它被 model_pricing / model_visibility_grants 上的
-- trigger 调用(那两张表是应用角色的合法写面),而 epoch 表将不对应用角色开放 DML。
-- 函数体与 0143 逐字一致,仅加 SECURITY DEFINER + search_path 钉死。
CREATE OR REPLACE FUNCTION fn_model_security_epoch_bump() RETURNS BIGINT
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
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
  PERFORM pg_notify('model_security_epoch', v_epoch::text);
  PERFORM pg_notify('model_catalog_changed', '');
  PERFORM pg_notify('pricing_changed', '');
  RETURN v_epoch;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. BLOCKER-1:model_visibility_grants → epoch
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION fn_model_grants_security_after() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  -- 事务内幂等(fn_model_security_epoch_bump 的 GUC 守卫):批量授权/撤权只 bump 一次。
  PERFORM fn_model_security_epoch_bump();
  RETURN NULL;
END $$;

CREATE TRIGGER trg_model_grants_security_after
  AFTER INSERT OR UPDATE OR DELETE ON model_visibility_grants
  FOR EACH ROW EXECUTE FUNCTION fn_model_grants_security_after();

COMMENT ON TABLE model_visibility_grants IS
  'per-user 模型授权(0049)。任何写(含 DELETE)= 安全事件 → 同事务 bump model_security_epoch'
  '(0144):master/egress/bridge 的 epoch fence 据此同步失效,撤权无 stale window。';

-- role 同样是模型可见性输入：admin→user 若不 bump，epoch-aware loader 会合法命中
-- 同 epoch 的旧 admin cache，已连 WS 也会继续签 admin-visible 模型。
CREATE OR REPLACE FUNCTION fn_users_model_role_security_after() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    PERFORM fn_model_security_epoch_bump();
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER trg_users_model_role_security_after
  AFTER UPDATE OF role ON users
  FOR EACH ROW
  WHEN (OLD.role IS DISTINCT FROM NEW.role)
  EXECUTE FUNCTION fn_users_model_role_security_after();

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. MAJOR-1:catalog 状态机边界(INSERT 只 staged / DELETE 只 staged / 历史不可改)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION fn_model_catalog_guard() RETURNS trigger AS $$
BEGIN
  -- ── INSERT:只能生于 staged ────────────────────────────────────────────
  -- 0143 允许直插 active/disabled(为回填 + 旧 INSERT 兼容路径开的口子)。回填已在 0143
  -- 完成;兼容路径(fn_model_catalog_ensure_for_pricing)改为 staged → activate 两步。
  -- 于是「出生即可执行」的旁路被彻底关闭:任何行要变成可执行,都必须经过一次
  -- staged→active 的状态转移(→ 必然 bump epoch、必然进 lock_version/审计列)。
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'staged' THEN
      RAISE EXCEPTION 'model_catalog: new entries must be born in staged state (model %, got %); use fn_model_stage_version() then fn_model_activate()',
        NEW.model_id, NEW.state USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- ── DELETE:只允许 staged 行 ───────────────────────────────────────────
  -- staged = 从未可执行、从未计费 → 物理删除无审计损失(放弃一个待激活版本)。
  -- active/disabled/retired 是「曾经/仍然可执行」的历史,与 usage_records 的
  -- execution_revision 对账相关 → append-only,永不物理删除(0143 的
  -- fn_model_pricing_delete_cascade 会把全部版本删光,本迁移改软退役)。
  IF TG_OP = 'DELETE' THEN
    IF OLD.state <> 'staged' THEN
      RAISE EXCEPTION 'model_catalog: entry % (model %, state %) is history and cannot be deleted; disable/retire it instead',
        OLD.entry_id, OLD.model_id, OLD.state USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  -- ── UPDATE ────────────────────────────────────────────────────────────
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

  -- execution 字段:**只有 staged 行可改**(0144 收紧;0143 只冻结 active 行)。
  --   0143 的漏洞:disabled 行可被原地改写 engine/provider/capability 再 disabled→active,
  --   同一 entry_id 的执行语义被静默篡改 —— 历史行不再是历史,usage_records 的
  --   execution_revision / entry 归因失去意义。方案 §1.1 的原意就是「任何 execution
  --   字段变化都必须走版本状态机(→ 新 entry)」,staged 是唯一的编辑面。
  IF OLD.state <> 'staged' AND (
       NEW.model_id                  IS DISTINCT FROM OLD.model_id
    OR NEW.engine                    IS DISTINCT FROM OLD.engine
    OR NEW.provider_id               IS DISTINCT FROM OLD.provider_id
    OR NEW.upstream_model_id         IS DISTINCT FROM OLD.upstream_model_id
    OR NEW.context_window            IS DISTINCT FROM OLD.context_window
    OR NEW.capability_profile        IS DISTINCT FROM OLD.capability_profile
    OR NEW.capability_schema_version IS DISTINCT FROM OLD.capability_schema_version
  ) THEN
    RAISE EXCEPTION 'model_catalog: execution fields of a % entry are immutable (entry %, model %); use fn_model_switch_version()',
      OLD.state, OLD.entry_id, OLD.model_id USING ERRCODE = 'check_violation';
  END IF;

  NEW.lock_version := OLD.lock_version + 1;
  NEW.updated_at   := NOW();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- 0143 的 trigger 不含 DELETE → 重建。
DROP TRIGGER trg_model_catalog_guard ON model_catalog;
CREATE TRIGGER trg_model_catalog_guard
  BEFORE INSERT OR UPDATE OR DELETE ON model_catalog
  FOR EACH ROW EXECUTE FUNCTION fn_model_catalog_guard();

-- AFTER trigger:epoch bump 判定随「INSERT 恒为 staged」收窄 —— staged 行对消费侧
-- 完全不可见(isRoutable/executionProjection/listForUser 只认 active),因此**建 staged
-- 行不是安全事件、不该抬 epoch**(方案 R4-m5 的同一条理由:编辑未激活版本不抖动全局)。
-- 该函数还要写 model_security_epoch / model_pricing → SECURITY DEFINER。
CREATE OR REPLACE FUNCTION fn_model_catalog_after() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_sensitive BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- 现行 guard 下恒为 staged(=false);保留判定形式,未来若放开出生态不至于漏 bump。
    v_sensitive := (NEW.state <> 'staged');
  ELSIF TG_OP = 'DELETE' THEN
    -- 现行 guard 下只可能删 staged 行 → 同样不是安全事件;保留 TRUE 做防御
    -- (删行是不可逆动作,宁可多一次 fence)。
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
    -- staged 行的 execution 编辑不影响任何消费侧投影 → 不 bump(state 变化仍 bump)。
    IF OLD.state = 'staged' AND NEW.state = 'staged' THEN
      v_sensitive := FALSE;
    END IF;
  END IF;

  IF v_sensitive THEN
    PERFORM fn_model_security_epoch_bump();
  END IF;

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
END $$;

-- 镜像同步(写 model_pricing)与 alias after(写 epoch)同样要 DEFINER。
CREATE OR REPLACE FUNCTION fn_model_pricing_sync_enabled(p_model_id TEXT) RETURNS VOID
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_active BOOLEAN;
BEGIN
  v_active := EXISTS (SELECT 1 FROM model_catalog c WHERE c.model_id = p_model_id AND c.state = 'active');
  PERFORM set_config('openclaude.catalog_sync', '1', true);
  UPDATE model_pricing
     SET enabled = v_active
   WHERE model_id = p_model_id
     AND enabled IS DISTINCT FROM v_active;
  PERFORM set_config('openclaude.catalog_sync', '0', true);
END $$;

CREATE OR REPLACE FUNCTION fn_model_aliases_after() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  PERFORM fn_model_security_epoch_bump();
  RETURN NULL;
END $$;

-- alias → catalog 的 FK:CASCADE → RESTRICT。
--   CASCADE 的语义是「catalog 行被物理删除时 alias 静默消失」—— 而物理删除现在只剩
--   staged 一种,且必须显式处理它的 alias(fn_model_drop_staged 会先摘 alias 并 bump epoch)。
--   保留 CASCADE 只会让「alias 悄无声息地没了」成为可能路径,与「alias 变更 = 安全事件」冲突。
ALTER TABLE model_aliases DROP CONSTRAINT model_aliases_entry_id_fkey;
ALTER TABLE model_aliases
  ADD CONSTRAINT model_aliases_entry_id_fkey
  FOREIGN KEY (entry_id) REFERENCES model_catalog(entry_id) ON DELETE RESTRICT;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. enabled 兼容层:INSERT 走 staged → activate;DELETE 改软退役
-- ═══════════════════════════════════════════════════════════════════════════

-- 状态机映射(0143 语义不变),加 DEFINER(应用角色无 catalog DML)。
CREATE OR REPLACE FUNCTION fn_model_catalog_apply_enabled(
  p_model_id   TEXT,
  p_enabled    BOOLEAN,
  p_updated_by BIGINT
) RETURNS VOID
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
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
END $$;

-- 兼容路径(INSERT INTO model_pricing → catalog 行不存在):
--   0143 直插 active/disabled;0144 改为 **staged → (enabled 时) activate**。
--   语义完全等价(enabled=TRUE → 最终 active;enabled=FALSE → 无 active 行 → 镜像 FALSE),
--   但走的是状态机而不是绕过它。enabled=FALSE 时新行停在 **staged**(而非 0143 的 disabled):
--   两者对消费侧完全等价(都不可路由),而 staged 是「从未激活过」的诚实描述。
--
--   注意:执行语义(engine/provider/context/capability)由 protocol 派生函数决定,
--   **不接受调用方传值** —— 兼容路径无法用来伪造 execution descriptor(它只能造出
--   「protocol 常量本来就认的那一份」),这是它可以继续存在的前提。
CREATE OR REPLACE FUNCTION fn_model_catalog_ensure_for_pricing(
  p_model_id   TEXT,
  p_enabled    BOOLEAN,
  p_updated_by BIGINT
) RETURNS VOID
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_entry BIGINT;
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
    'staged',
    p_updated_by
  ) RETURNING entry_id INTO v_entry;

  IF p_enabled THEN
    UPDATE model_catalog SET state = 'active' WHERE entry_id = v_entry;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION fn_model_pricing_enabled_route() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
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

  NEW.enabled := EXISTS (
    SELECT 1 FROM model_catalog c WHERE c.model_id = NEW.model_id AND c.state = 'active'
  );
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION fn_model_pricing_security_after() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF current_setting('openclaude.catalog_sync', true) IS NOT DISTINCT FROM '1' THEN
    RETURN NULL;
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
END $$;

-- 软退役:model_pricing 行被物理删除时,catalog **不再被物理删除**。
--   0143:`DELETE FROM model_catalog WHERE model_id = OLD.model_id` —— 把该模型的
--         **全部版本历史**(含 retired)一次性抹掉,只需要一条 DELETE FROM model_pricing。
--   0144:摘 alias → 删 staged 行(无审计价值)→ active/disabled 行走状态机退到 retired。
--         历史完整保留;之后重新 INSERT 同名 pricing 行会派生出**新 entry**(retired 行
--         不占 (staged∪active) 部分唯一索引),不与历史冲突。
CREATE OR REPLACE FUNCTION fn_model_catalog_retire_all(
  p_model_id   TEXT,
  p_updated_by BIGINT
) RETURNS VOID
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE r RECORD;
BEGIN
  -- alias 必须先摘:被引用的行禁止 retire(guard),且 FK 现在是 RESTRICT。
  DELETE FROM model_aliases a
   USING model_catalog c
   WHERE a.entry_id = c.entry_id AND c.model_id = p_model_id;

  -- staged 行:从未可执行 → 物理删除(guard 允许的唯一 DELETE)。
  DELETE FROM model_catalog WHERE model_id = p_model_id AND state = 'staged';

  FOR r IN
    SELECT entry_id, state FROM model_catalog
     WHERE model_id = p_model_id AND state IN ('active', 'disabled')
     ORDER BY entry_id
     FOR UPDATE
  LOOP
    IF r.state = 'active' THEN
      UPDATE model_catalog SET state = 'disabled', updated_by = COALESCE(p_updated_by, updated_by)
       WHERE entry_id = r.entry_id;
    END IF;
    UPDATE model_catalog SET state = 'retired', updated_by = COALESCE(p_updated_by, updated_by)
     WHERE entry_id = r.entry_id;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION fn_model_pricing_delete_cascade() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF current_setting('openclaude.catalog_sync', true) IS NOT DISTINCT FROM '1' THEN
    RETURN OLD;
  END IF;
  -- pricing_route=1:catalog AFTER trigger 跳过镜像回写(该 pricing 行正在被删,
  -- 回写会撞 "tuple already modified");epoch 由状态转移 / pricing DELETE 自己 bump。
  PERFORM set_config('openclaude.pricing_route', '1', true);
  PERFORM fn_model_catalog_retire_all(OLD.model_id, OLD.updated_by);
  PERFORM set_config('openclaude.pricing_route', '0', true);
  RETURN OLD;
END $$;

COMMENT ON FUNCTION fn_model_pricing_delete_cascade() IS
  '0144:名字沿用 0143(trigger 已绑),语义已从「级联物理删除 catalog」改为「软退役」。';

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. 受控存储过程(应用角色的**唯一**写入口)
-- ═══════════════════════════════════════════════════════════════════════════

-- 平台运行必需模型：默认/隐藏审查/codex 队长/官方 seed/CCB secondary utility。
-- 用 deferred constraint trigger 校验**事务最终态**，因此版本切换可在同一事务里先下旧行
-- 再上新行，但任何 disable/retire/delete/price 删除若让最终态缺失都会在 COMMIT 被拒。
CREATE TABLE model_runtime_requirements (
  model_id TEXT NOT NULL,
  requirement TEXT NOT NULL,
  PRIMARY KEY (model_id, requirement)
);
INSERT INTO model_runtime_requirements(model_id, requirement) VALUES
  ('glm-5.2', 'platform_default_and_hidden_reviewer'),
  ('gpt-5.6-sol', 'default_codex_engine'),
  ('deepseek-v4-pro', 'official_seed_agent'),
  ('MiniMax-M3', 'official_seed_agent'),
  ('kimi-k2.7-code', 'official_seed_agent'),
  ('deepseek-v4-flash', 'ccb_secondary_utility');

CREATE OR REPLACE FUNCTION fn_model_runtime_requirements_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_missing TEXT;
BEGIN
  SELECT string_agg(r.model_id || ':' || r.requirement, ', ' ORDER BY r.model_id, r.requirement)
    INTO v_missing
    FROM model_runtime_requirements r
   WHERE NOT EXISTS (
           SELECT 1 FROM model_catalog c
            WHERE c.model_id = r.model_id AND c.state = 'active'
         )
      OR NOT EXISTS (
           SELECT 1 FROM model_pricing p
            WHERE p.model_id = r.model_id AND p.enabled = TRUE
         );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'required runtime models must remain active and priced: %', v_missing
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER trg_model_runtime_requirements_catalog
AFTER INSERT OR UPDATE OR DELETE ON model_catalog
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION fn_model_runtime_requirements_guard();

CREATE CONSTRAINT TRIGGER trg_model_runtime_requirements_pricing
AFTER INSERT OR UPDATE OR DELETE ON model_pricing
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION fn_model_runtime_requirements_guard();

-- 全部 SECURITY DEFINER:割接后应用角色对 catalog/aliases/epoch 只有 SELECT,
-- 一切写经这些过程 —— 状态机不再是「约定」,而是**唯一可达的路径**。

-- 建/编辑 staged 版本。staged 是唯一可编辑态:
--   · 该模型没有任何 live 行 → 建新 staged(新模型上线的正常路径);
--   · 已有 staged 行         → 原地改 execution 字段(尚未激活,改它无消费侧影响);
--   · 已有 active/disabled   → 拒:改执行语义必须产生新版本 → 走 fn_model_switch_version。
CREATE OR REPLACE FUNCTION fn_model_stage_version(
  p_model_id                  TEXT,
  p_engine                    TEXT,
  p_provider_id               TEXT,
  p_upstream_model_id         TEXT,
  p_context_window            INTEGER,
  p_capability_profile        JSONB,
  p_capability_schema_version INTEGER,
  p_updated_by                BIGINT
) RETURNS BIGINT
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_entry BIGINT; v_state TEXT;
BEGIN
  SELECT c.entry_id, c.state INTO v_entry, v_state
    FROM model_catalog c
   WHERE c.model_id = p_model_id
     AND c.state IN ('staged', 'active', 'disabled')
   ORDER BY (c.state = 'active') DESC, (c.state = 'staged') DESC, c.entry_id DESC
   LIMIT 1
     FOR UPDATE;

  IF v_state IN ('active', 'disabled') THEN
    RAISE EXCEPTION 'fn_model_stage_version: model % already has a % version (entry %); use fn_model_switch_version() to create a new one',
      p_model_id, v_state, v_entry USING ERRCODE = 'check_violation';
  END IF;

  IF v_state = 'staged' THEN
    UPDATE model_catalog
       SET engine                    = p_engine,
           provider_id               = p_provider_id,
           upstream_model_id         = p_upstream_model_id,
           context_window            = p_context_window,
           capability_profile        = p_capability_profile,
           capability_schema_version = COALESCE(p_capability_schema_version, 1),
           updated_by                = COALESCE(p_updated_by, updated_by)
     WHERE entry_id = v_entry;
    RETURN v_entry;
  END IF;

  INSERT INTO model_catalog (
    model_id, engine, provider_id, upstream_model_id, context_window,
    capability_profile, capability_schema_version, state, updated_by
  ) VALUES (
    p_model_id, p_engine, p_provider_id, p_upstream_model_id, p_context_window,
    p_capability_profile, COALESCE(p_capability_schema_version, 1), 'staged', p_updated_by
  ) RETURNING entry_id INTO v_entry;
  RETURN v_entry;
END $$;

-- 激活/禁用:复用 0143 的「当前 live 版本」选择规则(单一权威,不另写一份)。
CREATE OR REPLACE FUNCTION fn_model_activate(p_model_id TEXT, p_updated_by BIGINT DEFAULT NULL) RETURNS VOID
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  PERFORM fn_model_catalog_apply_enabled(p_model_id, TRUE, p_updated_by);
END $$;

CREATE OR REPLACE FUNCTION fn_model_disable(p_model_id TEXT, p_updated_by BIGINT DEFAULT NULL) RETURNS VOID
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  PERFORM fn_model_catalog_apply_enabled(p_model_id, FALSE, p_updated_by);
END $$;

-- ── entry + 乐观锁变体(admin catalog API 的形状)──────────────────────────
-- admin/modelCatalogOps.ts 现在是**直写** catalog(INSERT staged / UPDATE state,
-- 带 lock_version 乐观锁)。trigger 层不拦它(写法本身合法),但**割接后**应用角色
-- 没有表级 DML → 必须换成受控过程。这两个变体把「entry_id + 期望 lock_version」的
-- 语义原样搬进来,割接时 admin 侧只需换调用、不需重新设计并发控制。
--   conflict → RAISE(ERRCODE=serialization_failure),应用层映射成既有的 409。
CREATE OR REPLACE FUNCTION fn_model_activate_entry(
  p_entry_id             BIGINT,
  p_expected_lock_version INTEGER,
  p_updated_by           BIGINT DEFAULT NULL
) RETURNS VOID
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_state TEXT; v_lock INTEGER;
BEGIN
  SELECT state, lock_version INTO v_state, v_lock
    FROM model_catalog WHERE entry_id = p_entry_id FOR UPDATE;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'fn_model_activate_entry: entry % does not exist', p_entry_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF p_expected_lock_version IS NOT NULL AND v_lock <> p_expected_lock_version THEN
    RAISE EXCEPTION 'fn_model_activate_entry: lock_version mismatch (expected %, got %)',
      p_expected_lock_version, v_lock USING ERRCODE = 'serialization_failure';
  END IF;
  -- 合法性(staged→active / disabled→active)由 trigger 兜底,这里给出更好的错误面。
  IF v_state NOT IN ('staged', 'disabled') THEN
    RAISE EXCEPTION 'fn_model_activate_entry: entry % is % (only staged/disabled can be activated)',
      p_entry_id, v_state USING ERRCODE = 'check_violation';
  END IF;
  UPDATE model_catalog SET state = 'active', updated_by = COALESCE(p_updated_by, updated_by)
   WHERE entry_id = p_entry_id;
END $$;

CREATE OR REPLACE FUNCTION fn_model_disable_entry(
  p_entry_id             BIGINT,
  p_expected_lock_version INTEGER,
  p_updated_by           BIGINT DEFAULT NULL
) RETURNS VOID
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_state TEXT; v_lock INTEGER;
BEGIN
  SELECT state, lock_version INTO v_state, v_lock
    FROM model_catalog WHERE entry_id = p_entry_id FOR UPDATE;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'fn_model_disable_entry: entry % does not exist', p_entry_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF p_expected_lock_version IS NOT NULL AND v_lock <> p_expected_lock_version THEN
    RAISE EXCEPTION 'fn_model_disable_entry: lock_version mismatch (expected %, got %)',
      p_expected_lock_version, v_lock USING ERRCODE = 'serialization_failure';
  END IF;
  IF v_state <> 'active' THEN
    RAISE EXCEPTION 'fn_model_disable_entry: entry % is % (only active can be disabled)',
      p_entry_id, v_state USING ERRCODE = 'check_violation';
  END IF;
  UPDATE model_catalog SET state = 'disabled', updated_by = COALESCE(p_updated_by, updated_by)
   WHERE entry_id = p_entry_id;
END $$;

-- 退休一个具体版本(disabled → retired)。按 entry_id 而非 model_id:历史管理必须
-- 精确到版本,「退休这个模型」在多版本语境下是有歧义的。
CREATE OR REPLACE FUNCTION fn_model_retire_entry(p_entry_id BIGINT, p_updated_by BIGINT DEFAULT NULL) RETURNS VOID
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  UPDATE model_catalog
     SET state = 'retired', updated_by = COALESCE(p_updated_by, updated_by)
   WHERE entry_id = p_entry_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fn_model_retire_entry: entry % does not exist', p_entry_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
END $$;

-- 放弃一个待激活的 staged 版本。指向它的 alias 一并删除(alias 不能指向 retired 行,
-- 无处可重指)—— 这是**收窄**(alias 不再解析),同事务 bump epoch。
CREATE OR REPLACE FUNCTION fn_model_drop_staged(p_model_id TEXT, p_updated_by BIGINT DEFAULT NULL) RETURNS VOID
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_entry BIGINT;
BEGIN
  SELECT entry_id INTO v_entry FROM model_catalog
   WHERE model_id = p_model_id AND state = 'staged' FOR UPDATE;
  IF v_entry IS NULL THEN
    RAISE EXCEPTION 'fn_model_drop_staged: model % has no staged version', p_model_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  DELETE FROM model_aliases WHERE entry_id = v_entry;
  DELETE FROM model_catalog WHERE entry_id = v_entry;
END $$;

-- alias 写入口。目标 = 该模型的 live 行(active 优先,其次 staged);其余校验由
-- fn_model_aliases_guard 兜底(不可指向 disabled/retired、不可与 canonical id 撞名)。
CREATE OR REPLACE FUNCTION fn_model_alias_set(
  p_alias      TEXT,
  p_model_id   TEXT,
  p_updated_by BIGINT DEFAULT NULL
) RETURNS VOID
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_entry BIGINT;
BEGIN
  SELECT c.entry_id INTO v_entry
    FROM model_catalog c
   WHERE c.model_id = p_model_id AND c.state IN ('staged', 'active')
   ORDER BY (c.state = 'active') DESC, c.entry_id DESC
   LIMIT 1;
  IF v_entry IS NULL THEN
    RAISE EXCEPTION 'fn_model_alias_set: model % has no staged/active version', p_model_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  INSERT INTO model_aliases (alias, entry_id, updated_by)
  VALUES (p_alias, v_entry, p_updated_by)
  ON CONFLICT (alias) DO UPDATE
    SET entry_id = EXCLUDED.entry_id,
        updated_by = COALESCE(EXCLUDED.updated_by, model_aliases.updated_by);
END $$;

CREATE OR REPLACE FUNCTION fn_model_alias_remove(p_alias TEXT) RETURNS VOID
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  DELETE FROM model_aliases WHERE alias = p_alias;
END $$;

-- 版本切换:乐观锁检查必须在持锁的 SECURITY DEFINER 过程内部完成。admin role 没有
-- UPDATE/FOR UPDATE 表权限,TS 预读只能用于语义校验,不能承担线性化。
DROP FUNCTION IF EXISTS fn_model_switch_version(TEXT, TEXT, TEXT, TEXT, INTEGER, JSONB, INTEGER, BIGINT);
CREATE OR REPLACE FUNCTION fn_model_switch_version(
  p_model_id                  TEXT,
  p_engine                    TEXT,
  p_provider_id               TEXT,
  p_upstream_model_id         TEXT,
  p_context_window            INTEGER,
  p_capability_profile        JSONB,
  p_capability_schema_version INTEGER,
  p_updated_by                BIGINT,
  p_expected_lock_version     INTEGER
) RETURNS BIGINT
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
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
  IF (SELECT lock_version FROM model_catalog WHERE entry_id = v_old_entry) <> p_expected_lock_version THEN
    RAISE EXCEPTION 'fn_model_switch_version: lock_version conflict for entry %', v_old_entry
      USING ERRCODE = 'serialization_failure';
  END IF;
  IF v_old_state = 'staged' THEN
    RAISE EXCEPTION 'fn_model_switch_version: model % already has a pending staged version (entry %); activate or drop it first',
      p_model_id, v_old_entry USING ERRCODE = 'check_violation';
  END IF;

  IF v_old_state = 'active' THEN
    UPDATE model_catalog SET state = 'disabled', updated_by = COALESCE(p_updated_by, updated_by)
     WHERE entry_id = v_old_entry;
  END IF;

  INSERT INTO model_catalog (
    model_id, engine, provider_id, upstream_model_id, context_window,
    capability_profile, capability_schema_version, state, updated_by
  ) VALUES (
    p_model_id, p_engine, p_provider_id, p_upstream_model_id, p_context_window,
    p_capability_profile, COALESCE(p_capability_schema_version, 1), 'staged', p_updated_by
  ) RETURNING entry_id INTO v_new_entry;

  UPDATE model_aliases SET entry_id = v_new_entry, updated_by = COALESCE(p_updated_by, updated_by)
   WHERE entry_id = v_old_entry;

  UPDATE model_catalog SET state = 'retired', updated_by = COALESCE(p_updated_by, updated_by)
   WHERE entry_id = v_old_entry;

  IF v_old_state = 'active' THEN
    UPDATE model_catalog SET state = 'active' WHERE entry_id = v_new_entry;
  END IF;

  RETURN v_new_entry;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. 权限策略
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE model_authority_deploy_state (
  key         TEXT PRIMARY KEY CHECK (key IN ('observation', 'cutover')),
  value       JSONB NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE model_authority_deploy_state IS
  'deploy-role-only model authority observation/cutover evidence; app cannot read or forge';

-- 默认 PG 把新函数的 EXECUTE 授予 PUBLIC —— 对 SECURITY DEFINER 函数而言这等于「谁都能
-- 以 owner 身份改 catalog」。逐个 REVOKE。
REVOKE ALL ON FUNCTION fn_model_security_epoch_bump()                                     FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_model_pricing_sync_enabled(TEXT)                                FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_model_catalog_apply_enabled(TEXT, BOOLEAN, BIGINT)              FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_model_catalog_ensure_for_pricing(TEXT, BOOLEAN, BIGINT)         FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_model_catalog_retire_all(TEXT, BIGINT)                          FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_model_stage_version(TEXT, TEXT, TEXT, TEXT, INTEGER, JSONB, INTEGER, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_model_switch_version(TEXT, TEXT, TEXT, TEXT, INTEGER, JSONB, INTEGER, BIGINT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_model_activate(TEXT, BIGINT)                                    FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_model_disable(TEXT, BIGINT)                                     FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_model_activate_entry(BIGINT, INTEGER, BIGINT)                   FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_model_disable_entry(BIGINT, INTEGER, BIGINT)                    FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_model_retire_entry(BIGINT, BIGINT)                              FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_model_drop_staged(TEXT, BIGINT)                                 FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_model_alias_set(TEXT, TEXT, BIGINT)                             FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_model_alias_remove(TEXT)                                        FROM PUBLIC;

-- 表级:PUBLIC 默认本来就没有权限,显式 REVOKE 只是把「意图」写进 schema(防止将来
-- 有人 GRANT ... TO PUBLIC 时忘了这三张表是安全权威表)。
REVOKE ALL ON TABLE model_catalog, model_aliases, model_security_epoch, model_runtime_requirements,
  model_authority_deploy_state FROM PUBLIC;

/**
 * 应用角色的权限策略 —— **单一权威**。
 *
 * 割接后普通 app 角色在本模块只有 SELECT。catalog mutation 只授予独立 admin DB role；
 * 否则任一被攻陷的请求进程都能绕过 TS 语义校验直接调用低层 SECURITY DEFINER 过程。
 *
 * model_pricing / model_visibility_grants **保持 app 角色可直写**(admin PATCH / grants CRUD
 * 是它们的合法业务面);写进去的安全后果由本模块的 trigger 接管(enabled → 状态机路由、
 * 任何写 → epoch bump)。
 *
 * 幂等,可重复执行。用法见文件尾 runbook。
 */
CREATE OR REPLACE FUNCTION fn_model_authority_grant_app_role(p_role TEXT) RETURNS VOID
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = p_role) THEN
    RAISE EXCEPTION 'fn_model_authority_grant_app_role: role % does not exist', p_role
      USING ERRCODE = 'undefined_object';
  END IF;

  EXECUTE format(
    'REVOKE ALL ON TABLE model_catalog, model_aliases, model_security_epoch, model_runtime_requirements, model_authority_deploy_state FROM %I', p_role);
  EXECUTE format(
    'GRANT SELECT ON TABLE model_catalog, model_aliases, model_security_epoch, model_runtime_requirements TO %I', p_role);

  EXECUTE format('REVOKE EXECUTE ON FUNCTION fn_model_stage_version(TEXT, TEXT, TEXT, TEXT, INTEGER, JSONB, INTEGER, BIGINT) FROM %I', p_role);
  EXECUTE format('REVOKE EXECUTE ON FUNCTION fn_model_switch_version(TEXT, TEXT, TEXT, TEXT, INTEGER, JSONB, INTEGER, BIGINT, INTEGER) FROM %I', p_role);
  EXECUTE format('REVOKE EXECUTE ON FUNCTION fn_model_activate(TEXT, BIGINT) FROM %I', p_role);
  EXECUTE format('REVOKE EXECUTE ON FUNCTION fn_model_disable(TEXT, BIGINT) FROM %I', p_role);
  EXECUTE format('REVOKE EXECUTE ON FUNCTION fn_model_activate_entry(BIGINT, INTEGER, BIGINT) FROM %I', p_role);
  EXECUTE format('REVOKE EXECUTE ON FUNCTION fn_model_disable_entry(BIGINT, INTEGER, BIGINT) FROM %I', p_role);
  EXECUTE format('REVOKE EXECUTE ON FUNCTION fn_model_retire_entry(BIGINT, BIGINT) FROM %I', p_role);
  EXECUTE format('REVOKE EXECUTE ON FUNCTION fn_model_drop_staged(TEXT, BIGINT) FROM %I', p_role);
  EXECUTE format('REVOKE EXECUTE ON FUNCTION fn_model_alias_set(TEXT, TEXT, BIGINT) FROM %I', p_role);
  EXECUTE format('REVOKE EXECUTE ON FUNCTION fn_model_alias_remove(TEXT) FROM %I', p_role);

END $$;

REVOKE ALL ON FUNCTION fn_model_authority_grant_app_role(TEXT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION fn_model_authority_grant_admin_role(p_role TEXT) RETURNS VOID
  LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM fn_model_authority_grant_app_role(p_role);
  EXECUTE format('GRANT SELECT ON TABLE model_pricing, model_authority_deploy_state TO %I', p_role);
  EXECUTE format('GRANT INSERT ON TABLE admin_audit TO %I', p_role);
  EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE admin_audit_id_seq TO %I', p_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION fn_model_stage_version(TEXT, TEXT, TEXT, TEXT, INTEGER, JSONB, INTEGER, BIGINT) TO %I', p_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION fn_model_switch_version(TEXT, TEXT, TEXT, TEXT, INTEGER, JSONB, INTEGER, BIGINT, INTEGER) TO %I', p_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION fn_model_activate(TEXT, BIGINT) TO %I', p_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION fn_model_disable(TEXT, BIGINT) TO %I', p_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION fn_model_activate_entry(BIGINT, INTEGER, BIGINT) TO %I', p_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION fn_model_disable_entry(BIGINT, INTEGER, BIGINT) TO %I', p_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION fn_model_retire_entry(BIGINT, BIGINT) TO %I', p_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION fn_model_drop_staged(TEXT, BIGINT) TO %I', p_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION fn_model_alias_set(TEXT, TEXT, BIGINT) TO %I', p_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION fn_model_alias_remove(TEXT) TO %I', p_role);
END $$;

REVOKE ALL ON FUNCTION fn_model_authority_grant_admin_role(TEXT) FROM PUBLIC;

/** deploy role:观察/割接证据与受限 canary 的唯一写方；catalog 仍只能走过程。 */
CREATE OR REPLACE FUNCTION fn_model_authority_grant_deploy_role(p_role TEXT) RETURNS VOID
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = p_role) THEN
    RAISE EXCEPTION 'fn_model_authority_grant_deploy_role: role % does not exist', p_role
      USING ERRCODE = 'undefined_object';
  END IF;
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', p_role);
  EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA public TO %I', p_role);
  EXECUTE format('REVOKE ALL ON TABLE model_catalog, model_aliases, model_security_epoch, model_runtime_requirements, model_authority_deploy_state FROM %I', p_role);
  EXECUTE format('GRANT SELECT ON TABLE model_catalog, model_aliases, model_security_epoch, model_runtime_requirements TO %I', p_role);
  -- cutover 事务用 SELECT ... FOR UPDATE 锁 epoch；guard 仍只允许严格 +1，deploy 不写 catalog。
  EXECUTE format('GRANT UPDATE ON TABLE model_security_epoch TO %I', p_role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE model_authority_deploy_state TO %I', p_role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE model_pricing, model_visibility_grants TO %I', p_role);
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', p_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION fn_model_stage_version(TEXT, TEXT, TEXT, TEXT, INTEGER, JSONB, INTEGER, BIGINT) TO %I', p_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION fn_model_switch_version(TEXT, TEXT, TEXT, TEXT, INTEGER, JSONB, INTEGER, BIGINT, INTEGER) TO %I', p_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION fn_model_activate(TEXT, BIGINT) TO %I', p_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION fn_model_disable(TEXT, BIGINT) TO %I', p_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION fn_model_activate_entry(BIGINT, INTEGER, BIGINT) TO %I', p_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION fn_model_disable_entry(BIGINT, INTEGER, BIGINT) TO %I', p_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION fn_model_retire_entry(BIGINT, BIGINT) TO %I', p_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION fn_model_drop_staged(TEXT, BIGINT) TO %I', p_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION fn_model_alias_set(TEXT, TEXT, BIGINT) TO %I', p_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION fn_model_alias_remove(TEXT) TO %I', p_role);
END $$;

REVOKE ALL ON FUNCTION fn_model_authority_grant_deploy_role(TEXT) FROM PUBLIC;

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. 自检(迁移期断言:不满足即整个迁移事务回滚)
-- ═══════════════════════════════════════════════════════════════════════════
-- 探针全部跑在子事务(BEGIN … EXCEPTION 块)里:命中期望的 RAISE 会连同探针写入一起
-- 回滚,迁移不留任何痕迹;**探针没被拒**才是失败(说明 guard 没装上)→ 整个迁移回滚。
DO $$
DECLARE v_epoch BIGINT; v_err TEXT;
BEGIN
  -- ① 直插 active 必须被拒
  BEGIN
    INSERT INTO model_catalog (model_id, engine, provider_id, capability_profile, state)
    VALUES ('__0144_probe__', 'ccb', 'deepseek',
            '{"supports_vision":false,"reasoning":{"supported":[],"codex_model_default":null},"ccb":{"capability_zero":false,"supports_thinking":true}}'::jsonb,
            'active');
    RAISE EXCEPTION '0144 self-check FAILED: direct INSERT of an active catalog row was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;  -- 期望路径
  END;

  -- ② 历史行不可物理删除(仅在库里确实有 active 行时才有意义)
  IF EXISTS (SELECT 1 FROM model_catalog WHERE state = 'active') THEN
    BEGIN
      DELETE FROM model_catalog
       WHERE entry_id = (SELECT MIN(entry_id) FROM model_catalog WHERE state = 'active');
      RAISE EXCEPTION '0144 self-check FAILED: DELETE of an active catalog row was accepted';
    EXCEPTION WHEN check_violation THEN
      NULL;
    END;
  END IF;

  -- ③ epoch 不可回退 / 不可任意写
  SELECT epoch INTO v_epoch FROM model_security_epoch WHERE id;
  BEGIN
    UPDATE model_security_epoch SET epoch = v_epoch WHERE id;
    RAISE EXCEPTION '0144 self-check FAILED: epoch UPDATE without +1 was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- ④ grants / users.role trigger 已装(行为断言在 modelAuthorityDbGuards.integ.test.ts,
  --    这里只做结构断言 —— 迁移不该往业务表塞探针数据)
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'trg_model_grants_security_after' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION '0144 self-check FAILED: trg_model_grants_security_after missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'trg_users_model_role_security_after' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION '0144 self-check FAILED: trg_users_model_role_security_after missing';
  END IF;
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
  RAISE EXCEPTION '0144 self-check: %', v_err;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 8. 割接 runbook(权限层生效;**不在本迁移内自动执行**)
-- ═══════════════════════════════════════════════════════════════════════════
-- 现状:v5 现网 app 角色 == 迁移角色 == 表 owner。owner 的表权限可以被 REVOKE,但 owner
-- 随时能给自己 re-GRANT,且 REVOKE 会立刻打断既有迁移/测试 fixture 的直写路径 → 本迁移
-- **不动现网角色**。真正的边界靠一次割接(建议与下一次 DB 维护窗口合并):
--
--   -- 1) 以 owner(现 DATABASE_URL 的角色)连库:
--   CREATE ROLE openclaude_app LOGIN PASSWORD '<强随机>';
--   CREATE ROLE openclaude_model_admin LOGIN PASSWORD '<强随机>';
--   CREATE ROLE openclaude_model_deploy LOGIN PASSWORD '<强随机>';
--   -- 2) 业务表按现状授权(app 的合法写面):
--   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO openclaude_app;
--   GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO openclaude_app;
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public
--     GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO openclaude_app;
--   -- 3) 三角色模型权威策略(角色必须互不相同):
--   SELECT fn_model_authority_grant_app_role('openclaude_app');
--   SELECT fn_model_authority_grant_admin_role('openclaude_model_admin');
--   SELECT fn_model_authority_grant_deploy_role('openclaude_model_deploy');
--   -- 4) commercial-v5.env 设置 DATABASE_URL / MODEL_CATALOG_ADMIN_DATABASE_URL /
--   --    MODEL_AUTHORITY_DEPLOY_DATABASE_URL；三个 URL 必须分别使用上述三个角色。
--   --    迁移仍用 owner 角色跑(migrate 需要 DDL)。
--
-- 割接前:trigger 层(§1/§3/§4)已是不可绕边界的**主要**依据 —— 它对 owner 同样生效,
-- 除非显式 ALTER TABLE ... DISABLE TRIGGER 或 superuser 的 session_replication_role=replica
-- (二者都不是应用代码/SQL 注入能顺手做到的动作)。
-- 割接后:再加一层「连表都碰不到」的角色边界。
