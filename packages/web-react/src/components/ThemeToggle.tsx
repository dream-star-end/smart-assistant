import { Monitor, Moon, Sun } from "lucide-react";
import type { Theme } from "../hooks/useTheme";
import { IconButton } from "./ui";

/**
 * 主题快捷开关（顶栏/登录页常驻）。受控：主题状态的唯一权威源在 App（useTheme），
 * 经 props 下传，与设置中心的"偏好·外观"分区共享同一份状态，杜绝两套并行镜像。
 */
export function ThemeToggle({ theme, onCycle }: { theme: Theme; onCycle: () => void }) {
  const Icon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor;
  const label = theme === "light" ? "浅色" : theme === "dark" ? "深色" : "跟随系统";
  return (
    <IconButton onClick={onCycle} title={`主题：${label}`} aria-label={`切换主题（当前${label}）`} shape="square">
      <Icon size={18} />
    </IconButton>
  );
}
