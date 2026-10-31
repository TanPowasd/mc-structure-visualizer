import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5174,
    strictPort: true
  },
  resolve: {
    alias: {
      '@mcvis/core': path.resolve(repoRoot, 'packages/core/src/index.ts'),
      '@mcvis/formats': path.resolve(repoRoot, 'packages/formats/src/index.ts'),
      '@mcvis/mod-loader': path.resolve(repoRoot, 'packages/mod-loader/src/index.ts'),
      '@mcvis/importers': path.resolve(repoRoot, 'packages/importers/src/index.ts'),
      '@mcvis/renderer': path.resolve(repoRoot, 'packages/renderer/src/index.ts'),
      '@mcvis/ui': path.resolve(repoRoot, 'packages/ui/src/index.ts')
    }
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500
  }
});
