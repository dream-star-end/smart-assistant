// 管理后台共享组件工作台 —— 页面 agent 的唯一入口。
// 用法：import { PageHeader, StatCard, ChartCard, DataTable, FilterBar } from "../../components";
//
// 通用件已陆续上提到全站设计系统原语层（src/components/ui）：admin 与付费用户侧
// （manage / marketplace）必须共用同一套底座，否则两边会各自长出一套 KPI 卡、
// 一套日期格式、一套复制芯片 —— 改造前正是这个状态。本 barrel 保留原名再导出，
// 使 admin 页面的 import 路径与用法零改动。
export { PageHeader } from "./PageHeader";
export { StatCard, StatCardRow, type StatTone, type StatDelta } from "./StatCard";
// 图表栈已提升为全站共享单一权威（src/components/charts.tsx）；
// admin 页面仍经本工作台 barrel 消费，路径指向共享位置。
export {
  useChart,
  ChartCard,
  chartNum,
  lineConfig,
  barConfig,
  donutConfig,
  sparklineConfig,
  withAlpha,
  type ChartTheme,
  type LineSeries,
} from "../../components/charts";
export { DataTable, type Column } from "./DataTable";
export {
  FilterBar,
  SearchInput,
  SelectFilter,
  RangePreset,
  type SelectOption,
  type RangeOption,
} from "./FilterBar";
export { SectionCard, LevelBadge } from "./misc";
// ↓ 已提升为全站原语。KeyValue 更名为 DescriptionRow（语义更准），admin 侧保留旧名别名。
export { CopyChip } from "../../components/ui/CopyChip";
export { DescriptionRow as KeyValue } from "../../components/ui/DescriptionList";
export { Pagination } from "../../components/ui/Pagination";
export { TimeAgo, formatDate, type DateFormat, type DateInput } from "../../components/ui/TimeAgo";
