-- 0107_marketplace_ai_review.sql
-- 市场发布 AI 自动审批(deepseek-v4-pro)。给 marketplace_skill_versions 增列,记录
-- 审批「来源」+ AI 审批「状态机」+ AI「意见」,并驱动 worker 的 claim / 僵尸回收 /
-- admin 可见性。依赖:0087(建表)。
--
-- 三态设计(见 marketplace/aiReview.ts):
--   * APPROVE   → reviewVersion({approve:true , source:'ai'}) 自动上架,review_source='ai'
--   * REJECT    → reviewVersion({approve:false, source:'ai', note}) 拒绝,理由回显发布者
--   * ESCALATE  → 不写 status,保持 pending 进现有人审队列(fail-closed);AI 意见落 ai_note
-- warn 级风险信号存在 / 调用失败 / 超时 / 解析失败 一律 ESCALATE 或 skipped(见 worker)。
--
-- 列语义:
--   review_source   最终决策来源:'human'(admin 人审)/'ai'(自动审批)/'platform'
--                   (approvePlatformVersion seed)。ESCALATE 项 status 未变 → 该列保持
--                   NULL,直到人审接手才写 'human'。
--   ai_review_state worker 生命周期:'queued'(发布时入列)→'running'(claim)→
--                   'done'(LLM 出了 approve/reject/escalate 决策)/'skipped'(缺 key /
--                   网络失败重试耗尽 / 僵尸 attempts 用尽,LLM 从未给出可用决策)。
--   ai_note         AI 意见(reject 理由 + escalate/warn 降级原因),供发布者/人审参考。
--   ai_reviewed_at  AI 处理完成时刻。
--   ai_attempts     被 claim 次数(僵尸回收上限判据)。
--   ai_locked_at    最近一次 claim 时刻(僵尸判据:running 且过期即回收)。
--
-- 共享库影响面:纯加列(全 NULL / DEFAULT 0)+ 三个 partial 索引。marketplace 表 v3/v5
-- 共享,但 v3 跑旧代码(本迁移不在 v3 树)→ v3 的发布路径不写 ai_review_state → 恒 NULL
-- → 永不被 v5 worker claim → v3 保持纯人审、零行为变更。additive 迁移对 v3 只读只写零影响。
--
-- 铁律(07-06 sessionsDb 事故 + 0087 建表顺序):引用新列的 index 一律放在 ALTER 之后。
-- 运维注:v5 AUTO_MIGRATE=0,须在受控窗口人工 apply(同 0096-0106 惯例):
--   psql "$DATABASE_URL" -f 0107_marketplace_ai_review.sql
-- ALTER ADD COLUMN(常量 DEFAULT / 无默认)为元数据级操作不重写表;CREATE INDEX 非
-- CONCURRENTLY(runner 在事务内执行),建索引期间短暂锁写入,该表量级下秒级完成。

ALTER TABLE marketplace_skill_versions
  ADD COLUMN IF NOT EXISTS review_source   TEXT
    CHECK (review_source IN ('human', 'ai', 'platform')),
  ADD COLUMN IF NOT EXISTS ai_review_state TEXT
    CHECK (ai_review_state IN ('queued', 'running', 'done', 'skipped')),
  ADD COLUMN IF NOT EXISTS ai_note         TEXT,
  ADD COLUMN IF NOT EXISTS ai_reviewed_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ai_attempts     INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ai_locked_at    TIMESTAMPTZ;

-- claim 候选:pending 且 queued,FIFO(created_at ASC)。partial 谓词让索引不背已审存量。
CREATE INDEX IF NOT EXISTS idx_mkt_versions_ai_queued
  ON marketplace_skill_versions (created_at)
  WHERE status = 'pending' AND ai_review_state = 'queued';

-- 僵尸回收:running 且 ai_locked_at 老化的行。
CREATE INDEX IF NOT EXISTS idx_mkt_versions_ai_running
  ON marketplace_skill_versions (ai_locked_at)
  WHERE ai_review_state = 'running';

-- admin「AI 审批记录」:review_source='ai' 按 reviewed_at DESC。
CREATE INDEX IF NOT EXISTS idx_mkt_versions_ai_source
  ON marketplace_skill_versions (reviewed_at DESC)
  WHERE review_source = 'ai';
