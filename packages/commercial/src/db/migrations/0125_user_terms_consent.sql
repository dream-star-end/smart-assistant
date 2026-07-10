-- 0125_user_terms_consent.sql
-- 用户协议/隐私政策同意留证。
--
-- 背景:登录/注册页上线《用户协议》《隐私政策》入口(web-react lib/legal.ts 为
-- 条款正文与版本号 TERMS_VERSION 的唯一权威源)。注册时前端把已勾选同意的
-- 版本号随表单上报,后端在建号事务里落这两列,形成"何时同意了哪一版"的留证
-- (个保法/电子证据角度,仅展示不留证的协议效力打折)。
--
-- 语义:
--   terms_version     同意时的协议版本(= 条款生效日期字符串,如 '2026-07-10')
--   terms_accepted_at 同意时刻(仅 terms_version 非空时有值)
-- 存量用户两列保持 NULL —— 表示"注册当时未展示协议",不回填、不伪造;
-- 其后续使用由登录页「登录即代表同意」文案覆盖(展示式同意,不落库)。
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS terms_version TEXT,
  ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ;
