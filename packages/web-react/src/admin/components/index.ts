// 管理后台共享组件工作台 —— 页面 agent 的唯一入口。
// 用法：import { PageHeader, StatCard, ChartCard, DataTable, FilterBar } from "../../components";
export { PageHeader } from "./PageHeader";
export { StatCard, StatCardRow, type StatTone, type StatDelta } from "./StatCard";
export {
  useChart,
  ChartCard,
  lineConfig,
  barConfig,
  donutConfig,
  sparklineConfig,
  withAlpha,
  type ChartTheme,
  type LineSeries,
} from "./charts";
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
