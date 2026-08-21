-- 0241_raise_last_read_watermark
-- order-dependency: 0240_client_session_last_read_at
--
-- 0240 把 last_read_at 回填成 last_at，意图是「存量已读」。但 last_at 是会话行
-- 最后一次写消息的 epoch ms，turn_dispatches.terminal_at 转 epoch ms 通常比它
-- 晚 数毫秒～数秒（先落 messages/last_at，再标 dispatch 终态）。list 用严格
-- `terminal_ms > last_read_at`，于是几乎所有已完成会话在上线后被判未读。
-- 另一路：POST /unread-migrate 把 localStorage 未读 id 写成 last_read_at=0，
-- COALESCE(...,0) 后任何终态都是未读。
--
-- 本迁移一次性把水位抬到 max(该会话 terminal_at 的 epoch ms)。已高于终态的
-- 水位（用户打开后 bump）保持不变。单位与 CLOCK_MS_SQL / LAST_D_TERMINAL_MS_SQL
-- 相同：epoch milliseconds。不改 0240 文件（已 apply 进生产 ledger）。

UPDATE client_sessions AS cs
   SET last_read_at = GREATEST(
         COALESCE(cs.last_read_at, 0),
         COALESCE((
           SELECT (floor(EXTRACT(EPOCH FROM MAX(td.terminal_at)) * 1000))::bigint
             FROM turn_dispatches td
            WHERE td.session_id = cs.id
              AND td.status = 'terminal'
         ), 0)
       );
