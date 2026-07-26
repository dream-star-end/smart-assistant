// StatCard 已提升为全站共享原语(src/components/ui/StatCard.tsx)——
// 用户侧(管理中心额度 / 市场收益)与 admin 共用同一套 KPI 卡,不再各写一份。
// 本文件保留为路径垫片:admin 页面与既有测试的 `../components/StatCard` 导入保持不变。
export { StatCard, StatCardRow, type StatDelta, type StatTone } from "../../components/ui/StatCard";
