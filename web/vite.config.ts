/// <reference types="vitest/config" />
import legacy from '@vitejs/plugin-legacy'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// 浏览器版要支持国产系统自带的老浏览器：麒麟 V10 SP1 的奇安信浏览器是 Chromium 83。
// 降低语法目标，并按用到的 JS 内置对象注入 core-js 补丁；不生成 SystemJS 的旧版包（这些浏览器都支持 ES 模块）。
// DOM 接口的缺失在 src/shared/compat.ts 里补。
const OLDEST_BROWSERS = ['chrome >= 83', 'safari >= 15', 'firefox >= 91']

// 开发时把 /api（含 WebSocket）转发给本机的 dblens-server：
//   dblens-server --allow-origin http://localhost:5173
// 再打开 dblens-server 打印的链接，把其中的 http://127.0.0.1:8742 换成 http://localhost:5173。
export default defineConfig({
  plugins: [
    react(),
    legacy({ renderLegacyChunks: false, modernTargets: OLDEST_BROWSERS, modernPolyfills: true }),
  ],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8742', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 2048,
  },
  // SQL 语言 worker 按方言懒加载解析器：需要 ES 模块格式才能拆块（默认的 iife 会把所有解析器打进一个文件）
  worker: { format: 'es' },
  test: {
    setupFiles: ['./src/test-setup.ts'],
  },
})
