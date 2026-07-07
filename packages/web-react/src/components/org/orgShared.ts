// 组织中心共享纯函数(唯一权威源)—— 从 OrgCenter.tsx 抽出为叶子模块。
//
// 权威源迁移动机:orgErrText / orgRoleLabel 原住在 OrgCenter.tsx(重组件,静态 import
// 五个分区 + 订阅弹层)。设置·账户页的「创建组织」向导需要 orgErrText,若从 OrgCenter 取,
// 会把整棵 OrgCenter 子树拖进 SettingsCenter 懒加载分块(体积翻倍 → 懒加载变慢 → 深链测试超时)。
// 抽到本叶子模块后,向导 / 各分区只依赖轻量 helper,不再牵连重组件;循环 import 一并消除。
// OrgCenter.tsx 再从这里 re-export,兼容既有 `from "../OrgCenter"` 引用点。

import { ApiError } from "../../lib/api";
import type { OrgRole } from "../../lib/types";

/** org 角色 → 中文标签。 */
export function orgRoleLabel(role: OrgRole): string {
  return role === "owner" ? "拥有者" : role === "admin" ? "管理员" : "成员";
}

/**
 * 错误 → 展示文案:优先后端原文(ApiError.message 已含 501 NOT_IMPLEMENTED / 404 等),
 * 退化到通用 Error.message,最后 fallback。集成期端点未上线时的友好提示由此产出。
 */
export function orgErrText(e: unknown, fallback: string): string {
  if (e instanceof ApiError) return e.message || fallback;
  if (e instanceof Error) return e.message || fallback;
  return fallback;
}
