-- 0072_chat_session_account_pin.sql
--
-- v3 commercial 反关联根治:把"(user_id, session_id) → claude_account_id"绑定
-- 从软调度(WRH scheduler 加权随机)升级为硬钉死(persistent pin)。
--
-- 背景(2026-05-25 P0):
--   d1 与 kraussosterland1907 在 27 分钟内连续被 Anthropic ban("unusual activity"),
--   排查发现 3 个 v3 session(尤其 db9a8a57 的 1056 + 139 tool_use)同时落在两个账号。
--   v3 master 转发是 stateless:每个 turn 都把全量 body.messages 重发给上游
--   (core.ts:158-164 spread),scheduler 又是软调度,导致**同一会话同一段对话历史
--   被 fan-out 到多个 Anthropic 账号**。Anthropic 侧看到"两个独立 device_id /
--   account_uuid 持有 byte-identical conversation tail" → content correlation 命中,
--   双账号同时风控。
--
--   软调度对 anti-correlation 是错的:它优化的是 P95 延迟 / 故障 failover,
--   不是"一次会话只接触一个上游身份"。即使加 sticky cookie,只要 cookie 表
--   不是 ON CONFLICT 持久化的就还会漂。
--
-- 修复:
--   引入新表 chat_session_account_pin,以 (user_id, session_id) 为主键,
--   持久化到该用户该 session 绑定哪个 claude_account。Scheduler.pick 先查
--   pin,命中即用,未命中跑 WRH 选号并 INSERT ... ON CONFLICT DO NOTHING
--   尝试占位(race 失败方读 winner 的行)。
--
--   account 被禁用 / banned 时,store.updateAccount 同事务级联 UPDATE 把对应
--   pin 标记为 status='unbound'(逻辑回收,不删行):
--     - 选择 unbound 而非物理删除,是为 ON DELETE RESTRICT 在 claude_accounts 侧
--       提供历史轨迹保留(future audit:某账号在 ban 之前服务过哪些 session)。
--     - 命中 unbound pin 的请求被 master 拒绝并返回 409 SessionPinUnbound,
--       前端引导用户 reset session(CCB 侧 regenerateSessionId)。这是 anti-
--       correlation 的硬保:绝不在同一 session 内换号。
--
-- Schema 设计要点:
--   - user_id BIGINT REFERENCES users(id) ON DELETE CASCADE:
--     用户被删则 pin 自动跟随消失,简化清理逻辑。
--   - account_id BIGINT REFERENCES claude_accounts(id) ON DELETE RESTRICT:
--     **关键**:禁止物理删除 claude_account,强制走 status='banned' 路径。
--     如果允许 cascade delete 会丢失"该 session 历史绑定哪个账号"的审计能力。
--   - status TEXT CHECK ('active','unbound'):
--     - active:有效绑定,scheduler 命中即用。
--     - unbound:绑定的账号已被回收,master 拒绝服务,前端引导 reset。
--   - PRIMARY KEY (user_id, session_id):
--     用户级隔离 — 即使 session_id 在跨用户语义里可能撞(尤其 CCB
--     regenerateSessionId 是进程内 randomUUID,理论上不会但防御性约束),
--     pin 表也仍按用户隔离不互相污染。
--   - CHECK (length(session_id) BETWEEN 1 AND 256):
--     防 abuse:session_id 来自 metadata.user_id JSON 的 session_id 字段,
--     CCB 侧是 randomUUID(36 chars),但 v3 转发只校验来源 trust,不校验长度。
--     这里硬约束兜底。
--   - idx_csap_account:按 account 反查所有 pin,store cascade unbound 走
--     这个索引避免全表扫。也用于"该用户既往足迹账号"反查(scheduler 在 pin
--     miss 时优先选 user 历史 pin 过的账号,这条 SELECT 用 (user_id, status) 走
--     PK 即可,不依赖 account 索引)。
--   - **取消 partial idx_csap_unbound**(Codex Round 4 BLOCKER #2):scheduler.pick
--     永远走 PK (user_id, session_id) 命中行,然后在应用层 if 判断 status,
--     **不会**有 `WHERE status='unbound'` 谓词查询。partial index 在主路径用不上,
--     纯粹增加写放大,故不建。如未来有 ops 扫"全网 unbound pin"需求再单独加。
--
-- Transition / Backfill:
--   该表初始为空。上线后两条路径写入:
--   1) 运行时:scheduler.pick 首次为 (user_id, session_id) 选号时 INSERT。
--   2) 离线:scripts/backfill-session-pins.ts 扫 sessions 表
--      (或 turns/messages 历史,看哪个保留 session_id),对每个 session 统计
--      distinct_accounts:
--        - distinct=1 → INSERT pin status='active' account=唯一那个。
--        - distinct>1 → INSERT pin status='unbound'(已被多账号触碰过,
--          强制 reset 而不是赌选哪个对)。
--      backfill 必须支持 --dry-run 输出报告:
--        total_sessions / active_pins / unbound_pins / affected_users /
--        unbound_active_last_24h(关键 UX 指标:多少活跃用户会被强制 reset)。
--
-- Feature flag(scheduler 侧):
--   enforce.session_pin: 'off' | 'observe' | 'enforce'
--     - off(默认):查 pin 但不写,行为完全等价旧 scheduler。
--     - observe:查 pin、不命中时也 **不** INSERT,只埋点日志
--       (避免在确认机制正确前就固化错误绑定 — Codex Round 2 教训)。
--     - enforce:查 pin、不命中 INSERT、unbound 拒绝服务、跨账号 assert
--       失败抛错。enforce 启用前必须有 dry-run 报告归档,
--       特别是 unbound_active_last_24h。
--
-- 部署验证:
--   1) Migration 干净运行:无依赖缺失(users / claude_accounts 都已存在)。
--   2) 表为空,所有索引建立成功:
--      SELECT count(*) FROM chat_session_account_pin;  -- = 0
--      \d chat_session_account_pin                      -- 看 PK + 2 索引
--   3) 与 0067(pinned_user_id) / 0070(account_uuid)正交:0072 绑定 pair
--      到 account,0067/0070 决定 account 暴露给上游的身份指纹。
--      三者合起来:account 身份固化(0067/0070)+ 会话绑定固化(0072)
--      = 不再有"同一会话切号"和"同一账号多 device_id"的双重指纹漏洞。

CREATE TABLE chat_session_account_pin (
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id  TEXT NOT NULL,
  account_id  BIGINT NOT NULL REFERENCES claude_accounts(id) ON DELETE RESTRICT,
  status      TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'unbound')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, session_id),
  CHECK (length(session_id) BETWEEN 1 AND 256)
);

CREATE INDEX idx_csap_account
  ON chat_session_account_pin(account_id);
