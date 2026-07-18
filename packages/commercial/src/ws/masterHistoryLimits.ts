// 引擎上下文历史注入的截断上限(RFC §9)。单一权威:sanitizer(userChatBridge
// _sanitizeMasterHistoricalMessagesForFrame)与投影读侧 getEngineContextMessages 共用同一常数,
// 「引擎上下文质量」承诺口径 = 与今日 sanitizer 产物等价(48 行文本 / 18k 字符),二者不可漂移。
// 本模块**零依赖**(叶子),可被 ws/ 与 db/ 双向 import 不成环。
export const MASTER_HISTORY_MAX_MESSAGES = 48;
export const MASTER_HISTORY_MAX_CHARS = 18_000;
