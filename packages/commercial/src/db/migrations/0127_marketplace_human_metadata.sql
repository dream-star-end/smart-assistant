-- 0127_marketplace_human_metadata.sql
-- v5 市场「人向商品层」—— 给条目补 分类/用例/效果示例/富介绍/平台精选 元数据。
--
-- 动机:此前市场条目只有 名称+一句话描述+tags,用户无从判断「哪个好用/适配需求/能达成
-- 什么效果」。SKILL.md 归模型(工件),商品页归人(导购)——本次把「人向导购」维度落成
-- storefront 元数据,与工件解耦:
--   - category / use_cases / outcome_examples / human_md 是**版本级 storefront 元数据**,
--     绝不进 SKILL.md / agent manifest 工件,故**不影响 artifact_hash**(平台 seed 不重发版、
--     存量安装快照不漂移)。use_cases 另参与检索向量(见 storage/skillEmbedding.ts)。
--   - featured_rank 是**listing 级平台精选权重**,只由平台运维脚本写,无用户/admin 写入面。
--
-- 分类枚举权威只在 @openclaude/protocol/marketplaceTaxonomy(校验收口 marketplaceMeta.parseHumanMeta),
-- DB **不建 category CHECK**(不设第二权威;存量 NULL 合法 → 显示「未分类」)。
--
-- 幂等:由 migrate.ts 的 schema_migrations 保证。惯例(additive 才 IF NOT EXISTS):
--   - ADD COLUMN 是对现存表的 additive 变更 → IF NOT EXISTS(同 0102/0113)。
--   - 引用新列 featured_rank 的部分索引放 ALTER 之后(先有列再建索引,0119 事故教训)。
--
-- 运维注:v5 AUTO_MIGRATE=0,须在受控窗口人工 apply(同 0113-0126 惯例)。存量 preset/历史
-- 条目的 category/use_cases 由单独的运维回填脚本处理,本迁移只加列(default 空)。

-- ─── 1) 版本级 storefront 元数据 ─────────────────────────────────────
ALTER TABLE marketplace_skill_versions
  ADD COLUMN IF NOT EXISTS category text,
  ADD COLUMN IF NOT EXISTS use_cases jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS outcome_examples jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS human_md text;

-- ─── 2) listing 级平台精选权重 ───────────────────────────────────────
ALTER TABLE marketplace_skill_listings
  ADD COLUMN IF NOT EXISTS featured_rank integer;

-- ─── 引用新列 featured_rank 的部分索引(放 ALTER 之后)───────────────
-- 目录排序(listApprovedForSearch)以 featured_rank ASC NULLS LAST 领衔;只索引精选行
-- (featured_rank IS NOT NULL,通常极少),非精选行走既有全表扫描路径。
CREATE INDEX IF NOT EXISTS idx_mkt_listings_featured
  ON marketplace_skill_listings (featured_rank) WHERE featured_rank IS NOT NULL;

COMMENT ON COLUMN marketplace_skill_versions.category IS
  'v5 市场人向分类 id(枚举权威在 @openclaude/protocol/marketplaceTaxonomy);NULL=未分类。storefront 元数据,不进工件、不影响 artifact_hash。';
COMMENT ON COLUMN marketplace_skill_versions.use_cases IS
  'v5 市场「适用场景」用例 string[](发布校验 1-4 条、每条 4-120 字符);参与检索向量,不进工件。';
COMMENT ON COLUMN marketplace_skill_versions.outcome_examples IS
  'v5 市场「效果示例」string[](0-4 条、每条 ≤200 字符);仅 detail 透出,不进工件。';
COMMENT ON COLUMN marketplace_skill_versions.human_md IS
  'v5 市场人向富介绍(Markdown,≤16384 字符);仅 detail 透出,不进工件。';
COMMENT ON COLUMN marketplace_skill_listings.featured_rank IS
  'v5 市场平台精选权重(越小越靠前;NULL=非精选)。只由平台运维脚本写,无用户/admin 写入面。';
