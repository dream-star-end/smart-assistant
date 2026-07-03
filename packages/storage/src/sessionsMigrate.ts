// sessionsMigrate.ts
//
// v3 → v5 master sessions.db 的**per-user 行级迁移**(L2 WebChat 会话历史)。
//
// 为什么是行拷贝而非文件拷贝:master sessions.db 是**多租户单文件**(client_sessions
// 按 user_id 分租,所有用户共存一库),两个 master 网关(v3 :18789 / v5 :18790)各持一份
// (/root/.openclaude vs /root/.openclaude-v5)。迁移一个用户 = 把其在 v3 库的行
// ATTACH + upsert 进 v5 库,绝不整文件拷(会覆盖 v5 其它用户 + 撞其它租户)。
//
// 一致性:不需要 WAL checkpoint —— WAL 模式下 SELECT 天然读一致快照;v3 master 网关仍在
// 并发写【其它】用户的行,不影响本用户行的读取(切换栅栏期本用户已 quiesce,其行稳定)。
// 幂等:ON CONFLICT(id) DO UPDATE ... WHERE excluded.updated_at >= 本地(后写胜),可安全
// 重跑(预热 + 栅栏最后 delta 多次执行都只把 v5 收敛到 v3 当前态);next_seq 取 MAX 只增
// 不退,保护增量游标单调。
//
// schema 前提:v3/v5 的 client_sessions / wechat_bindings 建表字节一致(storage 层已验),
// 两库列全同。含 codex/gpt-5.5 的历史消息是 messages 里不透明 JSON,原样搬运、不解析。

import { existsSync } from 'node:fs'
import Database from 'better-sqlite3'
import { paths } from './paths.js'
import { getSessionsDb } from './sessionsDb.js'

export interface UserSessionsMigrationResult {
  /** upsert 生效的 client_sessions 行数(插入+更新)。 */
  clientSessions: number
  /** upsert 生效的 wechat_bindings 行数(0 或 1)。 */
  wechatBindings: number
  /** 非空表示跳过(v3 库缺失 / 路径自指等),值为原因。 */
  skipped?: string
  /** wechat 迁移的软失败原因(不阻断 client_sessions);正常为 undefined。 */
  wechatWarning?: string
}

const CLIENT_SESSION_COLS =
  'id,user_id,agent_id,title,pinned,created_at,last_at,messages,message_count,updated_at,deleted_at,next_seq,origin_channel'

const WECHAT_BINDING_COLS =
  'user_id,account_id,login_user_id,bot_token,get_updates_buf,context_tokens,whitelist,status,created_at,updated_at,last_event_at'

/**
 * 把 v3 master sessions.db 中某用户的 client_sessions(+ wechat_bindings)迁到 v5 master
 * sessions.db。默认目标 = 当前进程 HOME 的 sessions.db(须为 v5 master,
 * OPENCLAUDE_HOME=/root/.openclaude-v5);测试/特殊编排可用 v5DbPath 显式指定目标库。
 *
 * @param v3DbPath v3 master sessions.db 绝对路径(通常 /root/.openclaude/sessions.db)。
 * @param userId   纯数字 user_id(BIGSERIAL 主键的字符串形式)。
 * @param v5DbPath 目标 v5 库路径覆盖(缺省 = paths.sessionsDb;显式给出时调用方须自建 schema)。
 */
export async function migrateUserClientSessionsFromV3(
  v3DbPath: string,
  userId: string,
  v5DbPath: string = paths.sessionsDb,
): Promise<UserSessionsMigrationResult> {
  if (!/^\d+$/.test(userId)) throw new TypeError(`bad user_id: ${userId}`)
  const usingDefaultTarget = v5DbPath === paths.sessionsDb
  if (v3DbPath === v5DbPath) {
    return { clientSessions: 0, wechatBindings: 0, skipped: 'v3 path == v5 path (自指)' }
  }
  if (!existsSync(v3DbPath)) {
    return { clientSessions: 0, wechatBindings: 0, skipped: `v3 db 不存在: ${v3DbPath}` }
  }

  // 默认目标库:先用 storage 单例确保 v5 库 schema 建好(建表 + 列迁移)。显式 v5DbPath
  // (测试/特殊编排)由调用方保证 schema 存在。随后都开一条专用短连接做迁移,不复用
  // live 网关单例的事务状态。
  if (usingDefaultTarget) await getSessionsDb()

  const db = new Database(v5DbPath)
  try {
    db.pragma('journal_mode = WAL')
    db.pragma('busy_timeout = 10000')
    // ATTACH 不支持参数绑定文件名,单引号转义防注入(路径来自受控 env/config,非用户输入)。
    db.exec(`ATTACH DATABASE '${v3DbPath.replace(/'/g, "''")}' AS v3src`)
    try {
      // client_sessions —— 关键用户可见历史,独立事务(不被 wechat 边缘错误连累)。
      const csRun = db.transaction((uid: string) => {
        return db
          .prepare(
            `INSERT INTO client_sessions (${CLIENT_SESSION_COLS})
             SELECT ${CLIENT_SESSION_COLS} FROM v3src.client_sessions WHERE user_id = @uid
             ON CONFLICT(id) DO UPDATE SET
               agent_id      = excluded.agent_id,
               title         = excluded.title,
               pinned        = excluded.pinned,
               last_at       = excluded.last_at,
               messages      = excluded.messages,
               message_count = excluded.message_count,
               updated_at    = excluded.updated_at,
               deleted_at    = excluded.deleted_at,
               next_seq      = MAX(client_sessions.next_seq, excluded.next_seq),
               origin_channel= excluded.origin_channel
             -- 跨租户防线:session id 若与其它用户的行碰撞,不得覆盖(与 sessionsDb 主写路径同款
             -- user_id guard)。excluded.user_id 恒 = @uid(SELECT 已按 user_id 过滤)。
             WHERE client_sessions.user_id = excluded.user_id
               AND excluded.updated_at >= client_sessions.updated_at`,
          )
          .run({ uid }).changes
      })
      const clientSessions = csRun(userId)

      // wechat_bindings —— best-effort:UNIQUE(account_id) 等边缘冲突不得连累会话迁移。
      let wechatBindings = 0
      let wechatWarning: string | undefined
      try {
        const wbRun = db.transaction((uid: string) => {
          return db
            .prepare(
              `INSERT INTO wechat_bindings (${WECHAT_BINDING_COLS})
               SELECT ${WECHAT_BINDING_COLS} FROM v3src.wechat_bindings WHERE user_id = @uid
               ON CONFLICT(user_id) DO UPDATE SET
                 account_id     = excluded.account_id,
                 login_user_id  = excluded.login_user_id,
                 bot_token      = excluded.bot_token,
                 get_updates_buf= excluded.get_updates_buf,
                 context_tokens = excluded.context_tokens,
                 whitelist      = excluded.whitelist,
                 status         = excluded.status,
                 updated_at     = excluded.updated_at,
                 last_event_at  = excluded.last_event_at
               WHERE excluded.updated_at >= wechat_bindings.updated_at`,
            )
            .run({ uid }).changes
        })
        wechatBindings = wbRun(userId)
      } catch (err) {
        wechatWarning = err instanceof Error ? err.message : String(err)
      }

      return { clientSessions, wechatBindings, wechatWarning }
    } finally {
      db.exec('DETACH DATABASE v3src')
    }
  } finally {
    db.close()
  }
}
