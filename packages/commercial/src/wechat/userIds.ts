/**
 * v3 commercial 微信 broker — 用户 id 命名约定边界常量。
 *
 * 系统并行存在两套 user-id 形式:
 *
 *   - **PG-side**(postgres 表 / JWT sub / agent_containers / container identity):
 *     裸 BIGINT digit,如 `"1"`。
 *
 *   - **Sqlite-side**(master sqlite 所有 commercial-tagged 行:`wechat_bindings.user_id`、
 *     `client_sessions.user_id` 等):`"c:1"`。`c:` 前缀用来与 personal-OC 任意 username
 *     用户隔离 — 同 OS 用户、不同租户语义不能撞 key。
 *
 * 跨越两侧时**显式** prepend / strip。本常量是这道边界翻译的唯一来源:
 *
 *   - `inboundDispatcher.ts` 写 sqlite client_sessions 时 `MASTER_USER_PREFIX + evt.bindingUserId`
 *   - `outboxWorker.ts` drainOne 调 `getBinding(MASTER_USER_PREFIX + row.bindingUserId)` 命中 sqlite
 *
 * 不要在文件内重复硬编码 `"c:"` 字面量 — 这是一个边界约定,duplicate 会让漂移更容易。
 */
export const MASTER_USER_PREFIX = 'c:'
