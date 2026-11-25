import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

const root = import.meta.dirname;

export default defineConfig({
  root: path.resolve(root, 'src/renderer'),
  plugins: [react(), tailwindcss()],
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(root, 'src/renderer'),
      '@shared': path.resolve(root, 'src/shared'),
    },
  },
  build: {
    outDir: path.resolve(root, '.vite/renderer/main_window'),
    emptyOutDir: true,
    // 本地 Electron 单窗口：实测入口 696.58 kB（gzip 217 kB），
    // 首屏解析可接受；不做动态拆包，只把告警阈值调到 750 kB 并留这个理由。
    chunkSizeWarningLimit: 750,
  },
  server: {
    strictPort: true,
  },
});
