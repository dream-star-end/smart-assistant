// 设计系统原语层 —— 全仓 surface 的唯一组件权威源。
// 新增 UI 一律从这里取原语,禁止再手写 button/input 内联样式。
export { Alert, alertVariants, type AlertProps } from "./Alert";
export { Avatar, avatarVariants, type AvatarProps } from "./Avatar";
export { Badge, badgeVariants } from "./Badge";
export { Button, buttonVariants, type ButtonProps } from "./Button";
export { Card } from "./Card";
export { useConfirm, usePrompt } from "./ConfirmDialog";
export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./DropdownMenu";
export { IconButton, iconButtonVariants, type IconButtonProps } from "./IconButton";
export { Input } from "./Input";
export { Modal } from "./Modal";
export { EmptyState, PanelHeader } from "./Panel";
export { Progress } from "./Progress";
export { Sheet } from "./Sheet";
export { Skeleton } from "./Skeleton";
export { Spinner } from "./Spinner";
export { Switch } from "./Switch";
export { Tabs, type TabItem } from "./Tabs";
export { Textarea } from "./Textarea";
export { ToastProvider, useToast, type ToastTone } from "./Toast";
export { Tooltip, TooltipProvider } from "./Tooltip";
