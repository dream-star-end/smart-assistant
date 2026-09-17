/**
 * 精选作品 id 白名单（`planet` / `gravity`）——**轻量、零依赖**。
 *
 * 为什么单独一个文件：`useAppRoute`（入口静态闭包）只需要这两个 id 做深链 `&work=` 校验；
 * 若直接 import `tutorialSignatureWorks`，会连带把 `tutorialCaseCatalog`（教程案例数据，~29KB gzip）
 * 拖进首屏闭包，撞 vite.config.ts 的 first-screen-budget 门（集成⑤预演实测 447KB → 475KB）。
 *
 * 与 `tutorialSignatureWorks.ts` 的 `SIGNATURE_WORKS[].id` 必须一致：`SignatureWork.id` 直接用这里的
 * `SignatureWorkId` 类型约束，另有 `tutorialSignatureWorkIds.test.ts` 断言集合相等，双保险防漂移。
 * ⚠ 不要在这里 import 任何教程数据模块。
 */
export const SIGNATURE_WORK_IDS = ['planet', 'gravity'] as const

export type SignatureWorkId = (typeof SIGNATURE_WORK_IDS)[number]

export function isSignatureWorkId(v: string | null | undefined): v is SignatureWorkId {
  return !!v && (SIGNATURE_WORK_IDS as readonly string[]).includes(v)
}
