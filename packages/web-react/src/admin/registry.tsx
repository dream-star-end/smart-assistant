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
  Wrench,
  WandSparkles,
  type LucideIcon,
} from "lucide-react";
import { type ComponentType, type LazyExoticComponent, lazy } from "react";

/**
 * 管理后台页面注册表 —— 页面与分组的**唯一权威**。
 *
 * 页面 key 保持旧版深链兼容；分组按运营任务重组，让用户声音、用户触达、内容运营和
 * 运行事故各自成域。每页组件经 React.lazy 动态 import 拆成独立按需 chunk（首屏只下载
 * Shell + 当前页）。
 *
 * 各页面 agent 只需替换 `pages/<key>/index.tsx` 的默认导出实现；本表的 key/分组/文案/图标
 * 不属于页面 agent 的所有权（改分组/文案回到本文件）。
 */

export type AdminGroup =
  | "经营驾驶舱"
  | "账号与调度"
  | "运行资源"
  | "财务与商业"
  | "用户声音与体验"
  | "用户触达"
  | "内容运营"
  | "系统配置"
  | "运行与事故"
  | "审计与安全";

/** 侧栏分组渲染顺序（权威）。 */
export const ADMIN_GROUP_ORDER: AdminGroup[] = [
  "经营驾驶舱",
  "账号与调度",
  "运行资源",
  "财务与商业",
  "用户声音与体验",
  "用户触达",
  "内容运营",
  "系统配置",
  "运行与事故",
  "审计与安全",
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
  // ── 用户声音与体验 ──
  { key: "feedback", title: "反馈与评分", group: "用户声音与体验", desc: "用户反馈、响应评分与处理闭环", icon: MessageSquare, Component: lz(() => import("./pages/feedback")) },
  { key: "autoDreamFindings", title: "平台优化发现", group: "用户声音与体验", desc: "Auto‑Dream 匿名聚合的平台改进建议", icon: WandSparkles, Component: lz(() => import("./pages/autoDreamFindings")) },
  { key: "productFriction", title: "产品摩擦", group: "用户声音与体验", desc: "用户可见失败、恢复与受影响范围", icon: Activity, Component: lz(() => import("./pages/audit/ProductFrictionTab").then((m) => ({ default: m.ProductFrictionTab }))) },
  // ── 用户触达 ──
  { key: "inbox", title: "站内信", group: "用户触达", desc: "发送、历史和触达记录", icon: Mail, Component: lz(() => import("./pages/inbox")) },
  // ── 内容运营 ──
  { key: "marketplace", title: "技能市场", group: "内容运营", desc: "审核投稿、上架和下架", icon: Store, Component: lz(() => import("./pages/marketplace")) },
  { key: "tutorials", title: "教程共建", group: "内容运营", desc: "审核用户教程投稿，通过后立即上线", icon: BookOpen, Component: lz(() => import("./pages/tutorials")) },
  // ── 系统配置 ──
  { key: "literature", title: "文献检索", group: "系统配置", desc: "检索服务连接、配额和运行数据", icon: BookOpen, Component: lz(() => import("./pages/literature")) },
  { key: "settings", title: "系统设置", group: "系统配置", desc: "配置风险、变更预览和审计", icon: Settings, Component: lz(() => import("./pages/settings")) },
  // ── 运行与事故 ──
  { key: "health", title: "健康与 SLO", group: "运行与事故", desc: "业务 SLO、服务依赖和当前行动", icon: Activity, Component: lz(() => import("./pages/health")) },
  { key: "alerts", title: "告警", group: "运行与事故", desc: "当前行动、确认、静默和投递", icon: Bell, Component: lz(() => import("./pages/alerts")) },
  { key: "selfheal", title: "自愈修复", group: "运行与事故", desc: "异常事故、持续时间与自动修复审计", icon: Wrench, Component: lz(() => import("./pages/selfheal")) },
  // ── 审计与安全 ──
  { key: "audit", title: "审计与安全", group: "审计与安全", desc: "管理操作、安全事件与主机审计", icon: History, Component: lz(() => import("./pages/audit")) },
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
