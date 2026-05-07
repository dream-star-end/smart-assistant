/**
 * GitHub API 调用所需的常量(分离出来便于 lint / 测试导入,不污染主模块循环依赖)。
 */
export const REQUIRED_GITHUB_HEADERS = {
  accept: 'application/vnd.github+json',
  userAgent: 'OpenClaude/v3',
  /** 锁版本号防止 GitHub 在我们看不到的情况下静默改 schema */
  apiVersion: '2022-11-28',
} as const
