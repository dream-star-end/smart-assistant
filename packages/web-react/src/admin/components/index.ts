// 管理后台共享组件工作台 —— 页面 agent 的唯一入口。
// 用法：import { PageHeader, StatCard, ChartCard, DataTable, FilterBar } from "../../components";
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
export { DataTable, Pagination, type Column } from "./DataTable";
export {
  FilterBar,
  SearchInput,
  SelectFilter,
  RangePreset,
  type SelectOption,
  type RangeOption,
} from "./FilterBar";
export { SectionCard, KeyValue, CopyChip, TimeAgo, LevelBadge } from "./misc";
