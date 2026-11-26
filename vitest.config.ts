import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const root = import.meta.dirname;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(root, 'src/renderer'),
      '@shared': path.resolve(root, 'src/shared'),
    },
  },
  test: {
    environment: 'happy-dom',
    include: ['tests/ui/**/*.test.tsx'],
    setupFiles: ['tests/ui/setup.ts'],
    restoreMocks: true,
  },
});
