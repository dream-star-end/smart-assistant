import {
  Activity,
  Bell,
  BookOpen,
  Building2,
  Container,
  CreditCard,
  History,
  KeyRound,
  Layers,
  LayoutDashboard,
  Mail,
  MessageSquare,
  Network,
  ScrollText,
  Server,
  Settings,
  ShieldCheck,
  ShoppingCart,
  Store,
  Tag,
  Users,
  type LucideIcon,
} from "lucide-react";
import { type ComponentType, type LazyExoticComponent, lazy } from "react";

/**
 * 管理后台页面注册表 —— 21 页 / 6 分组的**唯一权威**。
 *
 * 分组结构与中文文案抄旧 vanilla admin 的 ADMIN_TAB_META（packages/web/public/modules/
 * admin.js:436-458），保证与运维肌肉记忆、深链一致。每页组件经 React.lazy 动态 import
 * 拆成独立按需 chunk（首屏只下载 Shell + 当前页）。
 *
 * 各页面 agent 只需替换 `pages/<key>/index.tsx` 的默认导出实现；本表的 key/分组/文案/图标
 * 不属于页面 agent 的所有权（改分组/文案回到本文件）。
 */

export type AdminGroup =
  | "经营驾驶舱"
  | "账号与调度"
  | "运行资源"
  | "财务与商业"
  | "用户触达"
  | "系统运营";

/** 侧栏分组渲染顺序（权威）。 */
export const ADMIN_GROUP_ORDER: AdminGroup[] = [
  "经营驾驶舱",
  "账号与调度",
  "运行资源",
  "财务与商业",
  "用户触达",
  "系统运营",
];

export type AdminPage = {
  /** tab key（深链 #tab=<key>，与旧 vanilla 一致；含大写如 accountGroups/modelGrants）。 */
  key: string;
  /** 侧栏 / 页头标题。 */
  title: string;
  group: AdminGroup;
  /** 一句话描述（侧栏 tooltip + 页头副标题）。 */
  desc: string;
  icon: LucideIcon;
  Component: LazyExoticComponent<ComponentType>;
};

// 逐页懒块。注意：pages/<key> 默认导出组件（无命名导出适配）。
const lz = (loader: () => Promise<{ default: ComponentType }>) => lazy(loader);

export const adminPages: AdminPage[] = [
  // ── 经营驾驶舱 ──
  { key: "dashboard", title: "总览", group: "经营驾驶舱", desc: "收入、用量、资源和告警", icon: LayoutDashboard, Component: lz(() => import("./pages/dashboard")) },
  { key: "users", title: "用户", group: "经营驾驶舱", desc: "增长、留存、余额和详情", icon: Users, Component: lz(() => import("./pages/users")) },
  // ── 账号与调度 ──
  { key: "accounts", title: "账号池", group: "账号与调度", desc: "Claude 账号健康", icon: KeyRound, Component: lz(() => import("./pages/accounts")) },
  { key: "accountGroups", title: "账号分组", group: "账号与调度", desc: "容量、权重和调度边界", icon: Layers, Component: lz(() => import("./pages/accountGroups")) },
  { key: "egressProxies", title: "代理池", group: "账号与调度", desc: "出口线路和失败冷却", icon: Network, Component: lz(() => import("./pages/egressProxies")) },
  // ── 运行资源 ──
  { key: "containers", title: "容器", group: "运行资源", desc: "运行态、日志和重启动作", icon: Container, Component: lz(() => import("./pages/containers")) },
  { key: "hosts", title: "虚机池", group: "运行资源", desc: "磁盘、容量和调度状态", icon: Server, Component: lz(() => import("./pages/hosts")) },
  // ── 财务与商业 ──
  { key: "ledger", title: "积分流水", group: "财务与商业", desc: "账务明细和 CSV 导出", icon: ScrollText, Component: lz(() => import("./pages/ledger")) },
  { key: "orders", title: "订单", group: "财务与商业", desc: "支付状态和回调详情", icon: ShoppingCart, Component: lz(() => import("./pages/orders")) },
  { key: "pricing", title: "模型与服务商", group: "财务与商业", desc: "模型定价、可见性与服务商健康", icon: Tag, Component: lz(() => import("./pages/pricing")) },
  { key: "plans", title: "充值套餐", group: "财务与商业", desc: "金额、积分和排序", icon: CreditCard, Component: lz(() => import("./pages/plans")) },
  { key: "org", title: "组织", group: "财务与商业", desc: "组织账户、成员和开票申请", icon: Building2, Component: lz(() => import("./pages/org")) },
  { key: "modelGrants", title: "用户模型授权", group: "财务与商业", desc: "按用户放行特殊模型", icon: ShieldCheck, Component: lz(() => import("./pages/modelGrants")) },
  // ── 用户触达 ──
  { key: "feedback", title: "反馈", group: "用户触达", desc: "用户问题、优先级和确认", icon: MessageSquare, Component: lz(() => import("./pages/feedback")) },
  { key: "inbox", title: "站内信", group: "用户触达", desc: "发送、历史和触达记录", icon: Mail, Component: lz(() => import("./pages/inbox")) },
  { key: "marketplace", title: "技能市场", group: "用户触达", desc: "审核投稿、上架和下架", icon: Store, Component: lz(() => import("./pages/marketplace")) },
  // ── 系统运营 ──
  { key: "literature", title: "文献检索", group: "系统运营", desc: "检索服务连接和配额", icon: BookOpen, Component: lz(() => import("./pages/literature")) },
  { key: "settings", title: "系统设置", group: "系统运营", desc: "开关、阈值和 JSON 配置", icon: Settings, Component: lz(() => import("./pages/settings")) },
  { key: "audit", title: "审计日志", group: "系统运营", desc: "操作者、对象和配置变更", icon: History, Component: lz(() => import("./pages/audit")) },
  { key: "health", title: "健康面板", group: "系统运营", desc: "服务依赖和探针状态", icon: Activity, Component: lz(() => import("./pages/health")) },
  { key: "alerts", title: "告警", group: "系统运营", desc: "风险确认、静默和处理", icon: Bell, Component: lz(() => import("./pages/alerts")) },
];

/** tab key 白名单（路由回落判定）。 */
export const adminTabKeys = new Set(adminPages.map((p) => p.key));

/** 取某 tab 的元数据；非法 key 回落 dashboard（第一页）。 */
export function getAdminPage(tab: string): AdminPage {
  return adminPages.find((p) => p.key === tab) ?? adminPages[0];
}

/** 按 ADMIN_GROUP_ORDER 分组后的页面（侧栏渲染用）。 */
export const adminGroups: { group: AdminGroup; pages: AdminPage[] }[] = ADMIN_GROUP_ORDER.map(
  (group) => ({ group, pages: adminPages.filter((p) => p.group === group) }),
);
