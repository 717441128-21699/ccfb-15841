import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: false,
    // AudioWorklet 处理器必须作为独立 JS 文件在 worklet 全局加载，禁止内联为 data URI
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        assetFileNames: (assetInfo) => {
          if (assetInfo.names?.some((nm) => nm.includes('worklet'))) {
            // worklet 处理器输出为独立 .js（浏览器按 JS MIME 加载）
            return 'assets/[name].js';
          }
          return 'assets/[name]-[hash][extname]';
        },
      },
    },
  },
});
