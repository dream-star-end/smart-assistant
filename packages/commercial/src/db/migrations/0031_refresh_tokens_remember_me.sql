-- 0031_refresh_tokens_remember_me.sql
--
-- "记住我" checkbox 语义落到 refresh_token 级别。
--
-- Why a DB column:refresh handler rotate 出新 cookie 时必须知道本会话最初是
-- 以 persistent 模式(Max-Age=30d)还是 session 模式(无 Max-Age,浏览器关闭
-- 即删)登录。浏览器发回的请求 cookie 只有 name=value,没带"源 cookie 是不
-- 是 session"这种元信息,所以服务端必须持久化一份。
--
-- 新增列默认 TRUE —— 向后兼容:旧前端(没发 remember 字段)=> 按"记住我
-- 已勾选"处理,等同于之前一直的 30d 行为。
ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS remember_me BOOLEAN NOT NULL DEFAULT TRUE;
