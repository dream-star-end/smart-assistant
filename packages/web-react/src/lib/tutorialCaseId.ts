/**
 * 教程案例 id 的最小定义,与 1800+ 行案例数据(tutorialCaseCatalog.ts)拆开。
 *
 * why:useAppRoute(首屏必经)只需要「id 联合类型 + parse」,此前从
 * tutorialCaseCatalog import 这两个符号,把整份案例数据拖进了首屏的
 * modulepreload 静态依赖闭包(useAppRoute chunk 因此背了约 29KB gzip)。
 * 案例数据本体仍留在 tutorialCaseCatalog.ts,并带编译期断言保证与这里的
 * 显式 id 列表一致(见该文件底部 `_allIdsHaveCase`)。
 */
export const TUTORIAL_CASE_IDS = [
  'research-evidence-map',
  'research-bike-demand',
  'research-systematic-screening',
  'research-open-peer-review',
  'research-replication-audit',
  'coding-swe-bench-fix',
  'coding-feature-delivery',
  'coding-regression-rescue',
  'coding-frontend-quality',
  'coding-dependency-upgrade',
  'general-meeting-actions',
  'general-public-data-brief',
] as const

export type TutorialCaseId = (typeof TUTORIAL_CASE_IDS)[number]

const TUTORIAL_CASE_ID_SET: ReadonlySet<string> = new Set<string>(TUTORIAL_CASE_IDS)

export function parseTutorialCaseId(value: string | null | undefined): TutorialCaseId | null {
  return typeof value === 'string' && TUTORIAL_CASE_ID_SET.has(value)
    ? (value as TutorialCaseId)
    : null
}
