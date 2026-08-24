// 设计系统原语层 —— 全仓 surface 的唯一组件权威源。
// 新增 UI 一律从这里取原语,禁止再手写 button/input 内联样式。
//
// 2026-07-26 起本层同时服务用户端与管理后台:原先 `admin/components/` 自带一套
// StatCard / KeyValue / TimeAgo / CopyChip / Pagination / SearchInput,而用户侧
// (manage / marketplace)对它们的引用数是 0 —— 底座事实上分裂成了两套,同一个东西
// 两份实现、内距与字号各自漂移。通用件已提升到这里,`admin/components/index.ts`
// 改为从本层再导出,admin 页面的 import 路径保持不变。
//
// 字号一律用 styles.css @theme 的语义档位(text-title / section / body / meta / caption),
// 不要再写 `text-[13px]` 这类任意值;但表单控件字号必须保持 `text-base md:text-sm`
// —— 那是防 iOS Safari 在输入框 <16px 时聚焦放大整页且不回弹的专门设计。
export { Alert, alertVariants, type AlertProps } from "./Alert";
export { Avatar, avatarVariants, type AvatarProps } from "./Avatar";
export { Badge, badgeVariants } from "./Badge";
export { Button, buttonVariants, type ButtonProps } from "./Button";
export { Card, CardRow, cardVariants, type CardProps, type CardRowProps } from "./Card";
export { useConfirm, usePrompt } from "./ConfirmDialog";
export { CopyChip } from "./CopyChip";
export { DescriptionList, DescriptionRow } from "./DescriptionList";
export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./DropdownMenu";
export { Field, type FieldProps } from "./Field";
export { IconButton, iconButtonVariants, type IconButtonProps } from "./IconButton";
export {
  Input,
  controlHeightClass,
  controlSurfaceClass,
  inputVariants,
  type InputProps,
} from "./Input";
export { ListSkeleton } from "./ListSkeleton";
export { Modal } from "./Modal";
export { Pagination } from "./Pagination";
export { EmptyState, Panel, PanelHeader } from "./Panel";
export { Popover, PopoverContent, PopoverTrigger } from "./Popover";
export { Progress, type ProgressProps } from "./Progress";
export { Select, type SelectOption, type SelectProps } from "./Select";
export { ProjectScopeSelect } from "./ProjectScopeSelect";
export { Sheet } from "./Sheet";
export { Skeleton } from "./Skeleton";
export { Spinner } from "./Spinner";
export { StatCard, StatCardRow, type StatDelta, type StatTone } from "./StatCard";
export { Switch } from "./Switch";
export { Tabs, type TabItem, type TabsLayout } from "./Tabs";
export { Textarea } from "./Textarea";
export {
  TimeAgo,
  formatDate,
  toDate,
  type DateFormat,
  type DateInput,
  type TimeAgoProps,
} from "./TimeAgo";
export { ToastProvider, useToast, type ToastTone } from "./Toast";
export { Toolbar, type ToolbarProps } from "./Toolbar";
export { Tooltip, TooltipProvider } from "./Tooltip";
