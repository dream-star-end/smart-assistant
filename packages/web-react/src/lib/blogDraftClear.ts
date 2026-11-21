/**
 * 登出/换号时清掉本机经验分享草稿（含历史未隔离的共用键）。
 * 键前缀与 components/tutorials/blog/blogLib.ts 保持完全一致，
 * 拆成极轻量模块避免 useAuth 静态拉入整份 332 行 blogLib 到首屏闭包。
 */
export function clearAllBlogLocalDrafts(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem("oc:blog-draft");
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key && (key.startsWith("oc:blog-draft:") || key.startsWith("oc:blog-edit:"))) keys.push(key);
    }
    for (const key of keys) window.localStorage.removeItem(key);
  } catch {
    /* private mode */
  }
}
