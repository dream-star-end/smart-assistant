import { defineConfig, devices } from '@playwright/test';

// 会话展示 e2e 配置。目标环境经 OC_E2E_BASE_URL 注入(run.sh 建隧道后设置)。
// 串行跑(workers=1):同一 canary/预发账号,并行会话会互相干扰。
// 浏览器复用 ms-playwright 缓存里的 chromium(@playwright/test@1.60 → chromium-1223,已缓存,免下载)。

const TURN_TIMEOUT = Number(process.env.OC_E2E_TURN_TIMEOUT ?? 120_000);
const MATRIX_MODEL = process.env.OC_E2E_MATRIX_MODEL;
if (MATRIX_MODEL !== 'gpt-5.6-luna' && MATRIX_MODEL !== 'deepseek-v4-flash') {
  throw new Error('OC_E2E_MATRIX_MODEL must be the fixed Luna/DeepSeek matrix member');
}
const REPORT_KEY = MATRIX_MODEL.replace(/[^a-zA-Z0-9_-]/g, '_');

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: Number(process.env.OC_E2E_RETRIES ?? 0),
  // 单条上限:含 2 轮真 turn + 重登的用例需要余量(turn 上限 * 2 + UI 操作)。
  timeout: TURN_TIMEOUT * 2 + 60_000,
  expect: { timeout: 15_000 },
  // 报告目录与测试产物目录(outputDir,默认 test-results)分离,避免 HTML reporter 清空产物。
  outputDir: `test-results/${REPORT_KEY}`,
  reporter: [
    ['list'],
    ['json', { outputFile: `reports/${REPORT_KEY}/results.json` }],
    ['junit', { outputFile: `reports/${REPORT_KEY}/junit.xml` }],
    ['html', { outputFolder: `reports/${REPORT_KEY}/html`, open: 'never' }],
  ],
  use: {
    baseURL: process.env.OC_E2E_BASE_URL,
    headless: true,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    launchOptions: {
      // 部署机/CI 常以 root 运行,chromium 需 --no-sandbox。
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
