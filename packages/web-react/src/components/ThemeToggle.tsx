import { Monitor, Moon, Sun } from "lucide-react";
import type { Theme } from "../hooks/useTheme";
import { IconButton } from "./ui";

/**
 * 主题快捷开关（顶栏/登录页常驻）。受控：主题状态的唯一权威源在 App（useTheme），
 * 经 props 下传，与设置中心的"偏好·外观"分区共享同一份状态，杜绝两套并行镜像。
 */
export function ThemeToggle({
  theme,
  onCycle,
  titleHint,
}: {
  theme: Theme;
  onCycle: () => void;
  /** 追加到 tooltip/aria-label 的场景化提示（如 Landing 上"影响登录后的界面"）。 */
  titleHint?: string;
}) {
  const Icon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor;
  const label = theme === "light" ? "浅色" : theme === "dark" ? "深色" : "跟随系统";
  const title = titleHint ? `主题：${label}（${titleHint}）` : `主题：${label}`;
  const ariaLabel = titleHint
    ? `切换主题（当前${label}，${titleHint}）`
    : `切换主题（当前${label}）`;
  return (
    <IconButton onClick={onCycle} title={title} aria-label={ariaLabel} shape="square">
      <Icon size={18} />
    </IconButton>
  );
}
