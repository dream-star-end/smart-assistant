-- 0097 — 市场多文件工件 + 发布者自报评测摘要(纯加法,v3 忽略这两列)。
--
-- raw_bundle: SKILL.md 之外的附属文本文件 {relpath: content},路径白名单
--   references/ | assets/ | evals/(scripts/ 预留,暂拒),单文件≤64KB/总≤256KB/≤20个
--   —— 上限在应用层(marketplaceRoutes)校验,DB 只存。
-- benchmark: 发布者自报的评测摘要 {withPassRate, withoutPassRate, cases}
--   —— 展示时必须标注"发布者提供",不做平台背书。
ALTER TABLE marketplace_skill_versions
  ADD COLUMN IF NOT EXISTS raw_bundle JSONB NULL,
  ADD COLUMN IF NOT EXISTS benchmark JSONB NULL;
