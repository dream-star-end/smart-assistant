// wechat_bindings CRUD — per-OC-user WeChat iLink bot bindings.
//
// SQLite implementations live in ./sessions/wechatBindingsSqlite.ts (leaf module,
// no reverse edge to sessionsDb.ts). Public functions delegate to the active
// ClientSessionsBackend (SQLite in personal/container mode; PG in master mode).

import { getActiveBackend } from './sessions/backendRegistry.js'
import type { UpsertWechatBindingInput, WechatBinding } from './sessions/wechatBindingsSqlite.js'

export {
  WechatAccountAlreadyBoundError,
  _sqliteDeleteWechatBinding,
  _sqliteGetWechatBindingByAccountId,
  _sqliteGetWechatBindingByUserId,
  _sqliteListActiveWechatBindings,
  _sqliteListAllWechatBindings,
  _sqliteUpdateWechatBindingCursor,
  _sqliteUpdateWechatBindingStatus,
  _sqliteUpsertWechatBinding,
} from './sessions/wechatBindingsSqlite.js'
export type { UpsertWechatBindingInput, WechatBinding } from './sessions/wechatBindingsSqlite.js'

export async function listActiveWechatBindings(): Promise<WechatBinding[]> {
  return getActiveBackend().listActiveWechatBindings()
}

export async function listAllWechatBindings(): Promise<WechatBinding[]> {
  return getActiveBackend().listAllWechatBindings()
}

export async function getWechatBindingByUserId(userId: string): Promise<WechatBinding | null> {
  return getActiveBackend().getWechatBindingByUserId(userId)
}

export async function getWechatBindingByAccountId(
  accountId: string,
): Promise<WechatBinding | null> {
  return getActiveBackend().getWechatBindingByAccountId(accountId)
}

export async function upsertWechatBinding(input: UpsertWechatBindingInput): Promise<void> {
  return getActiveBackend().upsertWechatBinding(input)
}

export async function updateWechatBindingCursor(
  userId: string,
  getUpdatesBuf: string,
  contextTokens?: Record<string, string>,
): Promise<void> {
  return getActiveBackend().updateWechatBindingCursor(userId, getUpdatesBuf, contextTokens)
}

export async function updateWechatBindingStatus(
  userId: string,
  status: WechatBinding['status'],
): Promise<void> {
  return getActiveBackend().updateWechatBindingStatus(userId, status)
}

export async function deleteWechatBinding(userId: string): Promise<void> {
  return getActiveBackend().deleteWechatBinding(userId)
}
