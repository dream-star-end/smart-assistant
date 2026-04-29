-- 0046 inbox_messages
--
-- 站内信(in-app messages):仅 admin 写,用户读 + 标记已读。MVP 不做 WS 推送、
-- 不做用户互发、不做邮件 fallback —— 满足"运营广播 + 单发系统通知"两类用例。
--
-- audience='all'  → 全员广播(user_id=NULL)
-- audience='user' → 单发(user_id=收件人)
-- 可见性规则(见 handlers.ts handleListMyInbox):
--   - audience='user' AND user_id=me → 可见
--   - audience='all'  AND m.created_at >= 用户 users.created_at → 可见
--     (限制只看注册之后的广播,避免新用户被几年前的旧广播刷屏)
--   - expires_at IS NULL OR expires_at > NOW() → 未过期才可见
--
-- 已读 = 在 inbox_message_reads 中存在 (user_id, message_id) 行;未读 = 不存在。
-- 不在主表存"已读用户列表"是为了写公告 1 行 → reads 表分散承载 N 行,避免主表行
-- 因 audience='all' 时聚合所有用户已读列表而极速膨胀。
--
-- 删除策略:
--   - inbox_messages.user_id ON DELETE CASCADE — 用户删除,他的单发消息也跟着删
--     (无意义遗留,且 reads 表 CASCADE 链条简洁)
--   - inbox_messages.created_by 不 CASCADE / SET NULL,审计需要保留发件 admin 主体;
--     罕见硬删 admin(实际 status='deleted' 软删)如果发生会 FK 报错,运维处理
--   - inbox_message_reads ON DELETE CASCADE 链:消息删 / 用户删 都跟着清

CREATE TABLE inbox_messages (
  id          BIGSERIAL PRIMARY KEY,
  audience    TEXT NOT NULL CHECK (audience IN ('all','user')),
  user_id     BIGINT REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL CHECK (char_length(title)   BETWEEN 1 AND 200),
  body_md     TEXT NOT NULL CHECK (char_length(body_md) BETWEEN 1 AND 16384),
  level       TEXT NOT NULL DEFAULT 'info'
                CHECK (level IN ('info','notice','promo','warning')),
  created_by  BIGINT NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ,
  CHECK (
    (audience = 'all'  AND user_id IS NULL) OR
    (audience = 'user' AND user_id IS NOT NULL)
  )
);

-- audience='user':按 (收件人, 时间) 走联合索引,LIST 走顺序扫
CREATE INDEX idx_im_user_recent
  ON inbox_messages (user_id, created_at DESC)
  WHERE audience = 'user';

-- audience='all':按时间倒序;窗口过滤 created_at >= users.created_at 用 leading 索引
CREATE INDEX idx_im_all_recent
  ON inbox_messages (created_at DESC)
  WHERE audience = 'all';

-- admin 列表分页用,任意 audience
CREATE INDEX idx_im_admin_recent
  ON inbox_messages (created_at DESC);

CREATE TABLE inbox_message_reads (
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id  BIGINT NOT NULL REFERENCES inbox_messages(id) ON DELETE CASCADE,
  read_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, message_id)
);

-- admin 看消息已读人数: COUNT(*) WHERE message_id=$1
CREATE INDEX idx_imr_message ON inbox_message_reads (message_id);

COMMENT ON TABLE inbox_messages IS
  'V3 站内信(in-app messages)。Admin 单发或全员广播。expires_at 控制过期。';
COMMENT ON TABLE inbox_message_reads IS
  'V3 站内信已读状态。已读 = 存在 (user_id, message_id) 行;未读 = 不存在。';
