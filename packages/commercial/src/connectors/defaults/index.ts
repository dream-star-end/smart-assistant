/**
 * 默认连接器注册表(seed 源)。boss 默认集:Notion 已就绪(static-token);飞书/企微/钉钉
 * (token-exchange)、GitHub、QQ邮箱(imap-smtp)、WPS(hmac)随各自引擎能力就绪逐个加入。
 *
 * seed 机制(declarativeSeed.ts)遍历本表 → 建 listing+version → reviewer 编译签名成 exec_contract。
 */

import type { DefaultConnector } from './types.js'
import { feishuDefault } from './feishu.js'
import { notionDefault } from './notion.js'

export const DEFAULT_CONNECTORS: readonly DefaultConnector[] = [notionDefault, feishuDefault]

export type { DefaultConnector } from './types.js'
