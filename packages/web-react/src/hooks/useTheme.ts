import { useEffect, useState } from "react";

export type Theme = "light" | "dark" | "system";

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem("oc_theme") as Theme) || "system",
  );

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = theme === "dark" || (theme === "system" && mq.matches);
      document.documentElement.classList.toggle("dark", dark);
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute("content", dark ? "#0c0c11" : "#fafafb");
    };
    apply();
    mq.addEventListener("change", apply);
    localStorage.setItem("oc_theme", theme);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);

  const cycle = () => setTheme((t) => (t === "light" ? "dark" : t === "dark" ? "system" : "light"));
  return { theme, setTheme, cycle };
}
