import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 4174,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    manifest: true,
    // 手动分 chunk（rolldown codeSplitting.groups）。目标：首屏 vendor 单独成块走内容哈希
    // 长缓存（vite 默认 assets/[name]-[hash].js），依赖不变时跨发版命中缓存。
    //  - react-vendor / radix-vendor：首屏同步加载。
    //  注意：重渲染库（react-markdown / highlight.js / unified 生态）**不**在此手动归组。
    //  它们只被 components/MarkdownImpl（经 React.lazy 动态 import）引用，自动代码分割
    //  会把它们落进按需异步 chunk；手动归组反而有把「同步图也引用的通用 util（如
    //  is-plain-obj / extend）」一并圈进同一块、从而经该 util 在 entry 建立静态边、把整块
    //  markdown 拽回首屏的风险（已实测复现）。故让动态 import 自然成块，最稳。
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'react-vendor',
              test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/,
              priority: 20,
            },
            {
              name: 'radix-vendor',
              test: /node_modules[\\/](@radix-ui|@floating-ui|aria-hidden|react-remove-scroll[^\\/]*|use-sidecar|use-callback-ref|get-nonce)[\\/]/,
              priority: 10,
            },
          ],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./src/test/setup.ts'],
  },
})
