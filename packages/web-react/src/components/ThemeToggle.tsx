import { Monitor, Moon, Sun } from "lucide-react";
import type { Theme } from "../hooks/useTheme";
import { IconButton, useToast } from "./ui";

const THEME_LABEL: Record<Theme, string> = {
  light: "浅色",
  dark: "深色",
  system: "跟随系统",
};

const THEME_NEXT: Record<Theme, Theme> = {
  light: "dark",
  dark: "system",
  system: "light",
};

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
  const toast = useToast();
  const Icon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor;
  const label = THEME_LABEL[theme];
  const nextLabel = THEME_LABEL[THEME_NEXT[theme]];
  const title = titleHint
    ? `主题：${label}，点击切换到${nextLabel}（${titleHint}）`
    : `主题：${label}，点击切换到${nextLabel}`;
  const ariaLabel = titleHint
    ? `切换主题（当前${label}，点击切换到${nextLabel}，${titleHint}）`
    : `切换主题（当前${label}，点击切换到${nextLabel}）`;
  return (
    <IconButton
      onClick={() => {
        onCycle();
        toast(`主题已切换：${nextLabel}`, "info");
      }}
      title={title}
      aria-label={ariaLabel}
      shape="square"
    >
      <Icon size={18} />
    </IconButton>
  );
}
