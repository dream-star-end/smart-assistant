-- order-dependency: 0314_commercial_muse_spark_go
-- 0315 — commercial: the Z.AI route is unavailable (user 2026-10-20 10:56). The hidden reviewer and the
-- CCB sub-agent default now name deepseek-v4-flash (platformDefaults.ts, platform-seed.yaml,
-- subprocessSpawnConfig.ts), so the 0144 runtime requirement platform_default_and_hidden_reviewer moves
-- from glm-5.3-zai to deepseek-v4-flash. glm-5.3-zai itself is disabled after the release with
-- disableEntry; nothing here disables it.
--
-- BEGIN MANUAL ROLLBACK 0315 (glm-5.3-zai must be active and priced)
-- DELETE FROM model_runtime_requirements
--  WHERE model_id = 'deepseek-v4-flash' AND requirement = 'platform_default_and_hidden_reviewer';
-- INSERT INTO model_runtime_requirements(model_id, requirement)
--   VALUES ('glm-5.3-zai', 'platform_default_and_hidden_reviewer');
-- END MANUAL ROLLBACK 0315

LOCK TABLE model_catalog, model_pricing, model_runtime_requirements IN SHARE ROW EXCLUSIVE MODE;

DO $guard$
BEGIN
  IF (SELECT count(*) FROM model_runtime_requirements
       WHERE model_id = 'glm-5.3-zai' AND requirement = 'platform_default_and_hidden_reviewer') <> 1 THEN
    RAISE EXCEPTION '0315 expects glm-5.3-zai to hold platform_default_and_hidden_reviewer';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM model_catalog c JOIN model_pricing p USING (model_id)
                  WHERE c.model_id = 'deepseek-v4-flash' AND c.state = 'active' AND p.enabled) THEN
    RAISE EXCEPTION '0315 needs deepseek-v4-flash active and priced';
  END IF;
END $guard$;

DELETE FROM model_runtime_requirements
 WHERE model_id = 'glm-5.3-zai' AND requirement = 'platform_default_and_hidden_reviewer';
INSERT INTO model_runtime_requirements(model_id, requirement)
  VALUES ('deepseek-v4-flash', 'platform_default_and_hidden_reviewer');
