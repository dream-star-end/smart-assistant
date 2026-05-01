-- 0054_agent_containers_codex_account.sql
-- agent_containers 加 codex_account_id 列,实现 codex 多账号 sticky 绑定。
--
-- 背景(plan v3 决策 J/J2/K/L):
--   v3 codex Phase 2 把 admin 入库的 codex 账号真正接入运行时:
--     1. 容器 provision 时 pickCodexAccountForBinding(sessionId=container_id)
--        rendezvous-hash sticky 选一个 active codex 账号
--     2. 立即把该账号 access_token 写到 per-container
--        `<codexContainerDir>/<container_id>/auth.json`
--        (ro mount 进 /run/oc/codex-auth,容器 entrypoint 把 $CODEX_HOME/auth.json
--         symlink 到这里;CODEX_HOME 自身可写)
--     3. 此 container 后续所有 GPT 请求走该账号(sticky 长生命周期)
--   该列存绑定关系,refresh actor / lazy migrate / per-account 并发槽都依赖此列。
--
-- ON DELETE RESTRICT(plan v3 review v2 BLOCKER 4 修订):
--   admin 误删被 active per-container 容器引用的 codex 账号会让 row 漂成 NULL,
--   下次该容器接 GPT 请求时 bridge 看 NULL 就放行去 legacy 路径 — 但容器 mount
--   是 per-container subdir(不是 legacy 共享 dir),legacy auth 写不到,容器内
--   codex CLI 找不到 auth → 错误。RESTRICT 是数据完整性兜底:
--     - DB 层 admin DELETE codex 账号 RESTRICT 阻止
--     - admin 应用层(http/admin.ts)优先在删除前查 active 容器数 → 返 409 +
--       友好提示"X 个 active 容器仍绑此账号";stopped/vanished 容器也卡 RESTRICT,
--       admin force-cascade 时先 UPDATE codex_account_id=NULL 再 DELETE
--
-- 索引 idx_ac_codex_account_active:
--   refresh actor 60s tick 按 codex_account_id 反查 active 容器列表(为每个
--   容器 持锁写新 auth.json);admin 删账号路径也按此索引快速 count。
--   Partial WHERE state='active' AND codex_account_id IS NOT NULL — 排除
--   stopped/vanished 容器 + legacy NULL 容器,索引最小化。

ALTER TABLE agent_containers
  ADD COLUMN codex_account_id BIGINT
  REFERENCES claude_accounts(id) ON DELETE RESTRICT;

CREATE INDEX idx_ac_codex_account_active
  ON agent_containers(codex_account_id)
  WHERE state = 'active' AND codex_account_id IS NOT NULL;

COMMENT ON COLUMN agent_containers.codex_account_id IS
  'V3 codex multi-account sticky binding. NOT NULL → per-container mount '
  '<codexContainerDir>/<id>/auth.json; NULL → legacy shared mount '
  '<codexContainerDir>/auth.json (config.auth.codexOAuth driven). '
  'Mount path is fixed at docker startup — cannot switch at runtime '
  '(plan v3 K/L invariant). FK ON DELETE RESTRICT prevents orphaned mounts; '
  'admin layer must guard with 409 active-binding check before delete.';
