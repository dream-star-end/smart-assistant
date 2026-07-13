-- 0146 — 连接器 AI 自动审核的诚实功能验证状态。
--
-- `verified` 继续只表示管理员用隔离账号完成真实绑定/探针/动作验收；AI 自动审核
-- 无法持有第三方测试凭据，因此使用独立的 `declarative_verified`：完整 spec、发布者建议
-- SecurityDecision、编译产物和签名已自动验证，但真实凭据有效性仍在用户 bind 时由已签
-- identity probe 强制验证。旧 master 不认识新状态时只会 fail-closed 隐藏该条目，滚动兼容。

ALTER TABLE marketplace_skill_versions
  DROP CONSTRAINT IF EXISTS marketplace_skill_versions_functional_verify_state_check;
ALTER TABLE marketplace_skill_versions
  ADD CONSTRAINT marketplace_skill_versions_functional_verify_state_check
    CHECK (functional_verify_state IN ('unverified','verified','declarative_verified'));

ALTER TABLE marketplace_skill_versions
  DROP CONSTRAINT IF EXISTS marketplace_versions_functional_verify_shape;
ALTER TABLE marketplace_skill_versions
  ADD CONSTRAINT marketplace_versions_functional_verify_shape
    CHECK (
      (functional_verify_state = 'unverified'
        AND functional_verified_by IS NULL AND functional_verified_at IS NULL)
      OR
      (functional_verify_state IN ('verified','declarative_verified')
        AND functional_verified_by IS NOT NULL AND functional_verified_at IS NOT NULL)
    );

COMMENT ON COLUMN marketplace_skill_versions.functional_verify_state IS
  'unverified | verified(human isolated-account live test) | declarative_verified(AI declaration/contract review; identity probe deferred to bind)';
